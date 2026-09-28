/**
 * Download a Claude Design project through its preview link.
 *
 * The Claude Design connector reads text files only; its `render_preview`
 * tool returns a short-lived, project-scoped link from which every file of
 * the project resolves, images and fonts included. Claude hands Ferry Link
 * that link and the project's file list; this fetches them into memory.
 *
 * Files the pages reference that the listing does not carry (a linked design
 * system's `_ds/` folder is served from its own project) are followed too,
 * one level of references at a time, so the bundle matches what "Download
 * .zip" gives.
 */
import { posix } from "node:path";

const MAX_FILE = 30 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_FILES = 400;
const CONCURRENCY = 4;
const SKIP = /^\.thumbnail$|(^|\/)\.DS_Store$/;

/** The part of a preview link every file shares, and its token query. */
export function previewBase(serveUrl, testHost) {
  const url = new URL(serveUrl);
  const at = url.pathname.indexOf("/serve/");
  const trusted = url.protocol === "https:" && /\.claudeusercontent\.com$/.test(url.hostname);
  // Tests pass their own local server; the MCP tool never does.
  if (at < 0 || !(trusted || (testHost && url.host === testHost))) {
    throw new Error("That is not a Claude Design preview link.");
  }
  return { origin: url.origin, prefix: url.pathname.slice(0, at + "/serve/".length), query: url.search };
}

function fileUrl(base, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${base.origin}${base.prefix}${encoded}${base.query}`;
}

async function download(base, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(fileUrl(base, path), { signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) return null;
      if (res.status === 401 || res.status === 403) {
        throw Object.assign(new Error("The preview link has expired. Ask Claude for a fresh one (render_preview) and send again."), { fatal: true });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const length = Number(res.headers.get("content-length") || 0);
      if (length > MAX_FILE) return { skipped: `larger than ${MAX_FILE / 1024 / 1024} MB` };
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_FILE) return { skipped: `larger than ${MAX_FILE / 1024 / 1024} MB` };
      return { bytes };
    } catch (error) {
      if (error.fatal) throw error;
      // One file that will not come is one missing file, not a failed send.
      if (attempt === 1) return { failed: String(error?.message || error) };
    }
  }
  return null;
}

/** Relative references in a text file: src, href, url(), import/from. */
/** Words and dots, dashes, slashes, spaces between words, and an extension. */
const LOOKS_LIKE_FILE = /^[^\s|,;()${}'"<>*?\\=]+(?: [^\s|,;()${}'"<>*?\\=]+)*\.[A-Za-z0-9]{1,8}$/;

export function references(path, text) {
  const out = new Set();
  const dir = posix.dirname(path);
  const patterns = [
    /\b(?:src|href|data-src|poster)\s*=\s*["']([^"'#?]+)/gi,
    /url\(\s*["']?([^"')#?]+)/gi,
    /\bfrom\s+["']([^"'#?]+)["']/g,
    /\bimport\s+["']([^"'#?]+)["']/g,
    /@import\s+["']([^"'#?]+)["']/g,
    /\bimport\(\s*["']([^"'#?]+)["']\s*\)/g,
    /<x-import[^>]*\bfrom\s*=\s*["']([^"'#?]+)/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const ref = m[1].trim();
      if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|\{\{|data:)/i.test(ref)) continue;
      // A file name, not code: script source is full of url( and from that
      // are not references ("url(u, document.baseURI)"), and each one fetched
      // is a wasted request.
      if (!LOOKS_LIKE_FILE.test(ref)) continue;
      const resolved = posix.normalize(posix.join(dir === "." ? "" : dir, decodeURIComponent(ref)));
      if (resolved.startsWith("..")) continue;
      out.add(resolved);
    }
  }
  return out;
}

const TEXT = /\.(?:html?|jsx?|tsx?|mjs|css|json|svg|md|txt)$/i;
/** Claude Design's own runtime: bundled code, nothing it names is a project file. */
const RUNTIME = /(^|\/)(support\.js|image-slot\.js|[^/]*_bundle\.js)$/i;

/**
 * A page as Claude Design exports it. The preview server adds its own
 * `data-omelette-injected` style and script to every page it serves (a fetch
 * shim, messages to its parent window); the exported zip has neither.
 */
export function asExported(bytes) {
  const text = Buffer.from(bytes).toString("utf8");
  const clean = text.replace(/<(style|script)\b[^>]*\bdata-omelette-injected\b[^>]*>[\s\S]*?<\/\1>\s*/gi, "");
  return clean === text ? bytes : new Uint8Array(Buffer.from(clean, "utf8"));
}

/** What a design is made of, fetched whether or not anything names it. */
const PART = /\.(?:html?|jsx?|tsx?|mjs|css|json|svg|woff2?|ttf|otf)$/i;

/**
 * @returns {Promise<{ files: Array<{ path: string, bytes: Uint8Array }>, skipped: string[], missing: string[], unused: string[] }>}
 */
export async function fetchProject(serveUrl, paths, { testHost } = {}) {
  const base = previewBase(serveUrl, testHost);
  const listed = [...new Set(paths.filter((p) => p && !SKIP.test(p)))];
  const files = [];
  const skipped = [];
  const missing = [];
  const seen = new Set();
  const texts = [];
  let total = 0;

  const fetchAll = async (queue) => {
    for (const p of queue) seen.add(p);
    const worker = async () => {
      for (;;) {
        const path = queue.shift();
        if (path === undefined) return;
        const got = await download(base, path);
        if (!got || got.failed) {
          missing.push(path);
          continue;
        }
        if (got.skipped) {
          skipped.push(`${path} (${got.skipped})`);
          continue;
        }
        if (total + got.bytes.length > MAX_TOTAL) {
          skipped.push(`${path} (the design is over ${MAX_TOTAL / 1024 / 1024} MB)`);
          continue;
        }
        if (/\.html?$/i.test(path)) got.bytes = asExported(got.bytes);
        total += got.bytes.length;
        files.push({ path, bytes: got.bytes });
        if (TEXT.test(path)) {
          const text = Buffer.from(got.bytes).toString("utf8");
          if (!RUNTIME.test(path)) {
            texts.push(text);
            for (const ref of references(path, text)) {
              if (seen.has(ref) || seen.size >= MAX_FILES) continue;
              seen.add(ref);
              queue.push(ref);
            }
          }
        }
      }
    };
    // A text file can refill the queue after other workers have finished:
    // run rounds until nothing new was queued.
    while (queue.length) await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  };

  // First the design itself: pages, code, styles, fonts, and what they name.
  await fetchAll(listed.filter((p) => PART.test(p)));
  // Then any other file (an uploaded image, a video) the design refers to by
  // name. A project also holds what was pasted into its chat (screenshots,
  // briefs): nothing names those, so they stay behind.
  const everything = texts.join("\n");
  const named = (p) => {
    const base = p.split("/").pop();
    return [p, encodeURI(p), base, encodeURIComponent(base)].some((form) => everything.includes(form));
  };
  const rest = listed.filter((p) => !seen.has(p));
  await fetchAll(rest.filter(named));
  const unused = rest.filter((p) => !seen.has(p));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const wanted = new Set(listed);
  return { files, skipped, missing: missing.filter((p) => wanted.has(p)), unused };
}
