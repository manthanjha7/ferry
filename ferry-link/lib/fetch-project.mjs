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
export function previewBase(serveUrl) {
  const url = new URL(serveUrl);
  const at = url.pathname.indexOf("/serve/");
  if (at < 0 || !/\.claudeusercontent\.com$/.test(url.hostname)) {
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
      if (error.fatal || attempt === 1) throw error;
    }
  }
  return null;
}

/** Relative references in a text file: src, href, url(), import/from. */
export function references(path, text) {
  const out = new Set();
  const dir = posix.dirname(path);
  const patterns = [
    /\b(?:src|href|data-src|poster)\s*=\s*["']([^"'#?]+)/gi,
    /url\(\s*["']?([^"')#?]+)/gi,
    /\bfrom\s+["']([^"'#?]+)["']/g,
    /\bimport\(\s*["']([^"'#?]+)["']\s*\)/g,
    /<x-import[^>]*\bfrom\s*=\s*["']([^"'#?]+)/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const ref = m[1].trim();
      if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|\{\{|data:)/i.test(ref)) continue;
      const resolved = posix.normalize(posix.join(dir === "." ? "" : dir, decodeURIComponent(ref)));
      if (resolved.startsWith("..")) continue;
      out.add(resolved);
    }
  }
  return out;
}

const TEXT = /\.(?:html?|jsx?|tsx?|mjs|css|json|svg|md|txt)$/i;

/**
 * @returns {Promise<{ files: Array<{ path: string, bytes: Uint8Array }>, skipped: string[], missing: string[] }>}
 */
export async function fetchProject(serveUrl, paths) {
  const base = previewBase(serveUrl);
  const queue = [...new Set(paths.filter((p) => p && !SKIP.test(p)))];
  const seen = new Set(queue);
  const files = [];
  const skipped = [];
  const missing = [];
  let total = 0;

  const worker = async () => {
    for (;;) {
      const path = queue.shift();
      if (path === undefined) return;
      const got = await download(base, path);
      if (!got) {
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
      total += got.bytes.length;
      files.push({ path, bytes: got.bytes });
      if (TEXT.test(path)) {
        for (const ref of references(path, Buffer.from(got.bytes).toString("utf8"))) {
          if (seen.has(ref) || seen.size >= MAX_FILES) continue;
          seen.add(ref);
          queue.push(ref);
        }
      }
    }
  };
  // Workers finish when the queue is empty, but a text file can refill it:
  // run rounds until nothing new was queued.
  while (queue.length) await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped, missing };
}
