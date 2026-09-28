/**
 * The inbox: designs Claude has sent, waiting for the Ferry panel to take
 * them. Kept on disk (~/.ferry) so any running Ferry Link can serve it: Claude
 * Code starts one per session, and only one can own the port.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.FERRY_HOME || join(homedir(), ".ferry");
const INBOX = join(HOME, "inbox");
const PAIRED = join(HOME, "paired.json");
const SEEN = join(HOME, "last-panel.json");
/** A design nobody opened in a day is stale. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function ensure() {
  mkdirSync(INBOX, { recursive: true, mode: 0o700 });
}

export function put(name, bytes, details = {}) {
  ensure();
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  writeFileSync(join(INBOX, `${id}.zip`), bytes, { mode: 0o600 });
  const meta = { id, name, bytes: bytes.length, createdAt: new Date().toISOString(), ...details };
  writeFileSync(join(INBOX, `${id}.json`), JSON.stringify(meta), { mode: 0o600 });
  return meta;
}

export function list() {
  ensure();
  const now = Date.now();
  const out = [];
  for (const f of readdirSync(INBOX)) {
    if (!f.endsWith(".json")) continue;
    const path = join(INBOX, f);
    try {
      const meta = JSON.parse(readFileSync(path, "utf8"));
      if (now - statSync(path).mtimeMs > MAX_AGE_MS) {
        remove(meta.id);
        continue;
      }
      out.push(meta);
    } catch {
      // A half-written entry; the next listing sees it whole.
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const VALID_ID = /^[a-z0-9]+-[a-f0-9]{8}$/;

export function read(id) {
  if (!VALID_ID.test(id)) return null;
  const path = join(INBOX, `${id}.zip`);
  return existsSync(path) ? readFileSync(path) : null;
}

export function remove(id) {
  if (!VALID_ID.test(id)) return false;
  for (const ext of [".zip", ".json"]) rmSync(join(INBOX, `${id}${ext}`), { force: true });
  return true;
}

/** Pairing codes of the Ferry panels allowed to take designs. */
export function pairedCodes() {
  try {
    return new Set(JSON.parse(readFileSync(PAIRED, "utf8")));
  } catch {
    return new Set();
  }
}

export function pair(code) {
  ensure();
  const codes = pairedCodes();
  codes.add(code);
  writeFileSync(PAIRED, JSON.stringify([...codes]), { mode: 0o600 });
}

export function notePanel(state) {
  ensure();
  writeFileSync(SEEN, JSON.stringify({ at: new Date().toISOString(), ...state }), { mode: 0o600 });
}

export function lastPanel() {
  try {
    return JSON.parse(readFileSync(SEEN, "utf8"));
  } catch {
    return null;
  }
}
