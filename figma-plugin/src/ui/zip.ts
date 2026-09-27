/**
 * Minimal ZIP reader for the plugin UI iframe.
 *
 * Claude Design's project export is a .zip, but `networkAccess: none` (see
 * manifest.json) rules out any library that reaches for the network behind
 * the scenes, and there is no npm-dependency budget here at all. The format
 * itself is simple and well documented though, so this parses the container
 * by hand: read the end-of-central-directory record to find the entry list,
 * walk the central directory for each entry's metadata, then seek that
 * entry's own local header for the actual compressed bytes (the two headers
 * can disagree about filename/extra-field length, so the local header's own
 * lengths are what decide where the data starts). Decompression itself is
 * the browser's own `DecompressionStream` — no bundled inflate required.
 *
 * Only "deflate" (method 8) and "stored" (method 0) are handled, which is
 * everything a normal zip/Finder/Claude Design export produces. Anything else
 * (rare, legacy methods) is skipped rather than guessed at.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

/** Fixed-size portion of the end-of-central-directory record. */
const EOCD_FIXED_SIZE = 22;
/** The trailing comment length field is a uint16, capping how far back it can push the record. */
const MAX_COMMENT_SIZE = 0xffff;

const MIME_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

type CentralDirectoryEntry = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
};

export async function readZip(file: File): Promise<File[]> {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(buffer);

  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset === -1) {
    throw new Error(
      `"${file.name}" doesn't look like a zip file (no end-of-central-directory record found).`,
    );
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  const entries = readCentralDirectory(view, centralDirectoryOffset, entryCount);

  const extracted: { path: string; data: Uint8Array<ArrayBuffer> }[] = [];

  for (const entry of entries) {
    if (isSkippable(entry.name)) continue;

    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      console.warn(
        `[cd2f] zip entry "${entry.name}" uses unsupported compression method ${entry.compressionMethod} and was skipped.`,
      );
      continue;
    }

    const compressed = readLocalEntryData(view, bytes, entry);
    const data = entry.compressionMethod === 0 ? compressed : await inflateRaw(compressed);
    extracted.push({ path: entry.name, data });
  }

  const relativePaths = stripCommonRoot(extracted.map((e) => e.path));

  return extracted.map(({ data }, i) => {
    const relativePath = relativePaths[i];
    const basename = relativePath.split("/").pop() || relativePath;

    const out = new File([data], basename, { type: mimeTypeFor(basename) });
    // `webkitRelativePath` is a read-only getter on File.prototype, so a plain
    // assignment silently no-ops. Defining it directly on the instance shadows
    // the prototype accessor, which is exactly how the real folder picker's
    // Files carry theirs — see inlineAssets/htmlCandidates in main.ts, both of
    // which key off this same property.
    Object.defineProperty(out, "webkitRelativePath", { value: relativePath });
    return out;
  });
}

// ---------------------------------------------------------------------------
// Skipping
// ---------------------------------------------------------------------------

/** Directory entries, macOS's resource-fork sidecar folder, and Finder's .DS_Store noise. */
function isSkippable(name: string): boolean {
  if (name.endsWith("/")) return true;
  const parts = name.split("/");
  if (parts.includes("__MACOSX")) return true;
  if (parts[parts.length - 1] === ".DS_Store") return true;
  return false;
}

// ---------------------------------------------------------------------------
// End of central directory
// ---------------------------------------------------------------------------

/**
 * The EOCD record sits at the very end of the file UNLESS the archive carries
 * a trailing comment, which pushes it back by up to 64KB (the comment-length
 * field is a uint16). So this scans backwards for the signature rather than
 * assuming the record is the final 22 bytes.
 */
function findEndOfCentralDirectory(view: DataView): number {
  const length = view.byteLength;
  if (length < EOCD_FIXED_SIZE) return -1;

  const scanStart = Math.max(0, length - EOCD_FIXED_SIZE - MAX_COMMENT_SIZE);
  for (let offset = length - EOCD_FIXED_SIZE; offset >= scanStart; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Central directory
// ---------------------------------------------------------------------------

function readCentralDirectory(
  view: DataView,
  offset: number,
  count: number,
): CentralDirectoryEntry[] {
  const decoder = new TextDecoder("utf-8");
  const entries: CentralDirectoryEntry[] = [];
  let cursor = offset;

  for (let i = 0; i < count; i++) {
    const signature = view.getUint32(cursor, true);
    if (signature !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(
        `Malformed zip: expected a central directory entry at byte ${cursor}, found something else.`,
      );
    }

    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const nameStart = cursor + 46;
    const nameBytes = new Uint8Array(view.buffer, view.byteOffset + nameStart, nameLength);
    const name = decoder.decode(nameBytes);

    entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });

    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Local header + data
// ---------------------------------------------------------------------------

/**
 * The central directory told us where this entry's local header lives and
 * how big its compressed data is, but NOT where that data starts — the local
 * header has its own filename-length and extra-field-length fields, and they
 * are free to differ from the central directory's copies. So those lengths
 * have to be re-read here, from the local header itself, rather than reused
 * from the central directory entry.
 */
function readLocalEntryData(
  view: DataView,
  bytes: Uint8Array<ArrayBuffer>,
  entry: CentralDirectoryEntry,
): Uint8Array<ArrayBuffer> {
  const offset = entry.localHeaderOffset;
  const signature = view.getUint32(offset, true);
  if (signature !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(
      `Malformed zip: local file header for "${entry.name}" was not found at its recorded offset.`,
    );
  }

  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;

  return bytes.slice(dataStart, dataStart + entry.compressedSize);
}

// ---------------------------------------------------------------------------
// Decompression
// ---------------------------------------------------------------------------

async function inflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This browser doesn't support DecompressionStream, which is required to unzip DEFLATE-compressed entries. Update to a recent Chrome/Edge, or export the project as a folder instead of a zip.",
    );
  }

  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

/**
 * Many exports wrap every entry in one top-level folder (e.g. a Finder
 * "Compress" of a project directory produces `My Project/index.html`,
 * `My Project/_ds/...`). Relative references inside the document (`_ds/...`)
 * are written as if that wrapper did not exist, so leaving it in place would
 * break every asset lookup in inlineAssets. Stripping it only when EVERY
 * entry shares the same first path segment keeps a flat export (no wrapper)
 * untouched.
 */
function stripCommonRoot(paths: string[]): string[] {
  if (paths.length === 0) return paths;

  const segments = paths.map((p) => p.split("/"));
  if (segments.some((s) => s.length < 2 || s[0] === "")) return paths;

  const first = segments[0][0];
  if (!segments.every((s) => s[0] === first)) return paths;

  return segments.map((s) => s.slice(1).join("/"));
}

function mimeTypeFor(basename: string): string {
  const ext = basename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}
