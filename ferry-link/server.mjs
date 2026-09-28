#!/usr/bin/env node
/**
 * Ferry Link: hands a Claude Design project from Claude to the Ferry panel in
 * Figma, on this computer.
 *
 * Two faces:
 *   - An MCP server on stdio, for Claude (Claude Code, Claude Desktop). Its
 *     `send_to_figma` tool takes a Claude Design preview link and the
 *     project's file list, downloads the project into a zip, and puts it in
 *     the inbox (~/.ferry/inbox).
 *   - An HTTP server on 127.0.0.1:47841 for the Ferry panel, which polls it
 *     and imports what arrives. A panel must be paired first: it shows a
 *     code, and the user tells Claude "pair Ferry <code>".
 *
 * No dependencies beyond Node 18. Nothing leaves the machine: the design comes
 * from Claude Design's own preview server and goes to the local panel.
 */
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { fetchProject } from "./lib/fetch-project.mjs";
import * as inbox from "./lib/inbox.mjs";
import { zip } from "./lib/zip.mjs";

export const PORT = Number(process.env.FERRY_LINK_PORT || 47841);
const VERSION = "0.1.0";
const CODE = /^\d{4}-\d{4}$/;

// ---------------------------------------------------------------------------
// HTTP, for the Ferry panel
// ---------------------------------------------------------------------------

/** The panel runs in Figma's plugin iframe, whose origin is "null". */
function corsHeaders() {
  return {
    "access-control-allow-origin": "null",
    "access-control-allow-methods": "GET, DELETE, OPTIONS",
    "access-control-allow-headers": "x-ferry-code",
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

export function handle(req, res) {
  const headers = corsHeaders();
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { ...headers, "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  // Only this machine, by name: a page served from elsewhere that rebinds its
  // own domain to 127.0.0.1 still sends its own Host.
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return send(403, { error: "host" });
  // A website's page has an origin; Figma's plugin iframe is "null". Anything
  // else is refused outright, before pairing is even checked.
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== "null") return send(403, { error: "origin" });
  if (req.method === "OPTIONS") return send(204, "");

  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/v1/hello") return send(200, { ferryLink: VERSION });

  const code = req.headers["x-ferry-code"];
  if (typeof code !== "string" || !CODE.test(code)) return send(400, { error: "code" });
  if (!inbox.pairedCodes().has(code)) {
    inbox.notePanel({ paired: false });
    return send(403, { error: "unpaired", pairing: true });
  }
  inbox.notePanel({ paired: true });

  if (url.pathname === "/v1/inbox" && req.method === "GET") return send(200, { items: inbox.list() });
  const m = /^\/v1\/inbox\/([a-z0-9-]+)$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const bytes = inbox.read(m[1]);
    return bytes ? send(200, bytes, "application/zip") : send(404, { error: "gone" });
  }
  if (m && req.method === "DELETE") return send(inbox.remove(m[1]) ? 200 : 404, { ok: true });
  return send(404, { error: "path" });
}

let httpState = "starting";
export function startHttp() {
  const server = createServer(handle);
  server.on("error", (error) => {
    // Another Ferry Link (another Claude session) owns the port. It serves
    // the same inbox, so this one only has to write to it.
    httpState = error.code === "EADDRINUSE" ? "shared" : `failed: ${error.message}`;
  });
  server.listen(PORT, "127.0.0.1", () => {
    httpState = "listening";
  });
  return server;
}

// ---------------------------------------------------------------------------
// MCP, for Claude
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "send_to_figma",
    description:
      "Send a Claude Design project to Figma, through the Ferry plugin running in the user's Figma. " +
      "First get the project's files with the Claude Design connector (list_files with depth -1) and a " +
      "preview link for its main page (render_preview); pass the preview link's serve_url and every file path. " +
      "Never show the serve_url to the user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The project's name, as the user sees it in Ferry." },
        serve_url: { type: "string", description: "serve_url from the Claude Design connector's render_preview." },
        files: { type: "array", items: { type: "string" }, description: "Every file path from list_files (depth -1)." },
        page: { type: "string", description: "The page the user means, if they named one (e.g. 'Portfolio v2.dc.html')." },
      },
      required: ["name", "serve_url", "files"],
    },
  },
  {
    name: "pair_figma",
    description:
      "Pair a Ferry panel in Figma so it can receive designs. The panel shows a code like 1234-5678; " +
      "the user says 'pair Ferry 1234-5678'.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "The code the Ferry panel shows, NNNN-NNNN." } },
      required: ["code"],
    },
  },
  {
    name: "ferry_status",
    description: "Whether Ferry Link can reach a Ferry panel, and what is waiting in its inbox.",
    inputSchema: { type: "object", properties: {} },
  },
];

function text(message, isError = false) {
  return { content: [{ type: "text", text: message }], ...(isError ? { isError: true } : {}) };
}

function panelLine() {
  const seen = inbox.lastPanel();
  // A panel in front checks every 2s; behind another window, a browser can
  // slow it to once a minute. Past a few minutes, assume it is closed.
  const open = seen && Date.now() - Date.parse(seen.at) < 3 * 60_000;
  if (open && !seen.paired) return "A Ferry panel is open but not paired: it shows a code; tell me 'pair Ferry <code>'.";
  if (open) return "Switch to Figma: it is waiting in the Ferry panel under “From Claude”. Click it, then Import.";
  return "Open Ferry in Figma (Plugins → Ferry): it is waiting there under “From Claude” for a day.";
}

export async function callTool(name, args = {}) {
  if (name === "pair_figma") {
    // "1234-5678", "1234 5678" or "12345678": the digits are what matter.
    const digits = String(args.code || "").replace(/\D/g, "");
    const code = digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4)}` : "";
    if (!CODE.test(code)) return text("That doesn't look like a Ferry code. The panel shows it as four digits, a dash, four digits.", true);
    inbox.pair(code);
    return text(`Paired. Designs sent to Figma now appear in that Ferry panel.`);
  }
  if (name === "ferry_status") {
    const items = inbox.list();
    return text(
      [
        `Ferry Link ${VERSION}, port ${PORT}: ${httpState}.`,
        panelLine(),
        items.length ? `Waiting: ${items.map((i) => i.name).join(", ")}.` : "Nothing waiting.",
      ].join("\n"),
    );
  }
  if (name === "send_to_figma") {
    const files = Array.isArray(args.files) ? args.files.map(String) : [];
    if (!args.serve_url || !files.length) return text("I need the project's serve_url (render_preview) and its file list (list_files, depth -1).", true);
    let fetched;
    try {
      fetched = await fetchProject(String(args.serve_url), files);
    } catch (error) {
      return text(`Could not download the design: ${error.message}`, true);
    }
    const missing = fetched.missing;
    if (!fetched.files.some((f) => /\.html?$/i.test(f.path))) return text("The project has no page (.html) to import.", true);
    const bytes = zip(fetched.files);
    const meta = inbox.put(String(args.name || "Claude Design"), bytes, {
      page: args.page ? String(args.page) : undefined,
      files: fetched.files.length,
    });
    const notes = [
      ...(missing.length ? [`${missing.length} file(s) could not be downloaded: ${missing.slice(0, 5).join(", ")}.`] : []),
      ...(fetched.skipped.length ? [`Skipped: ${fetched.skipped.slice(0, 5).join(", ")}.`] : []),
      ...(fetched.unused.length ? [`Left out ${fetched.unused.length} file(s) the design does not use (things pasted into the Claude Design chat, for example).`] : []),
    ];
    return text(
      [`Sent “${meta.name}” to Figma (${fetched.files.length} files, ${(bytes.length / 1024 / 1024).toFixed(1)} MB).`, panelLine(), ...notes].join("\n"),
    );
  }
  return text(`Unknown tool ${name}.`, true);
}

function serveMcp() {
  const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const { id, method, params } = msg;
    if (id === undefined) return; // A notification: nothing to answer.
    try {
      if (method === "initialize") {
        return out({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion || "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "ferry-link", version: VERSION },
            instructions:
              "Ferry Link sends Claude Design projects into Figma through the Ferry plugin. When the user asks to send, export or import a Claude Design design into Figma, read the project with the Claude Design connector (list_projects to find it, list_files depth -1, render_preview for the main page) and call send_to_figma.",
          },
        });
      }
      if (method === "ping") return out({ jsonrpc: "2.0", id, result: {} });
      if (method === "tools/list") return out({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      if (method === "tools/call") return out({ jsonrpc: "2.0", id, result: await callTool(params?.name, params?.arguments) });
      return out({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (error) {
      return out({ jsonrpc: "2.0", id, error: { code: -32603, message: String(error?.message || error) } });
    }
  });
  rl.on("close", () => process.exit(0));
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry === realpathSync(fileURLToPath(import.meta.url))) {
  startHttp();
  serveMcp();
}
