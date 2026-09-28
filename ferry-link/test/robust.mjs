/**
 * Ferry Link under everything that can go wrong: node test/robust.mjs
 *
 * A fake Claude Design preview server stands in for claudeusercontent.com:
 * tokens that expire, files that 404, fail, stall or are huge, names with
 * spaces and accents, a design system served from outside the listing, and
 * files that reference each other in a loop.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-robust-"));
process.env.FERRY_LINK_PORT = String(49000 + Math.floor(Math.random() * 900));
const { fetchProject } = await import("../lib/fetch-project.mjs");
const inbox = await import("../lib/inbox.mjs");
const { startHttp, callTool, PORT } = await import("../server.mjs");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` :: ${detail}`}`);
};

// --- the fake preview server ------------------------------------------------
const TOKEN = "good-token";
const png = Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 13) % 256));
const FILES = {
  "Page v2.dc.html": `<link href="_ds/sys/styles.css"><img src="uploads/h%C3%A9ro%20%231.png"><x-import from="./comp.jsx"></x-import><img src="nowhere.png"><a href="flaky.txt"></a><video src="big.bin"></video><img src="gone.png"><img src="always-fails.txt">`,
  "uploads/héro #1.png": png,
  "comp.jsx": `import x from "./loop-a.js"; export default 1;`,
  "loop-a.js": `import "./loop-b.js";`,
  "loop-b.js": `import "./loop-a.js";`,
  "_ds/sys/styles.css": `@font-face { src: url(fonts/a.woff2) } body { color: red }`,
  "_ds/sys/fonts/a.woff2": Buffer.from("wOF2fake"),
  "flaky.txt": "ok after one failure",
  "big.bin": Buffer.alloc(31 * 1024 * 1024, 1),
  "uploads/chat-screenshot.png": png,
  "notes/brief.md": "# what the user pasted into chat",
};
let flakyHits = 0;
const fake = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.searchParams.get("t") !== TOKEN) {
    res.writeHead(401);
    return res.end("unauthorized");
  }
  const path = decodeURIComponent(url.pathname.replace("/v1/design/projects/p/serve/", ""));
  if (path === "always-fails.txt") {
    res.writeHead(500);
    return res.end("boom");
  }
  if (path === "flaky.txt" && flakyHits++ === 0) {
    res.writeHead(502);
    return res.end("bad gateway");
  }
  const body = FILES[path];
  if (body === undefined) {
    res.writeHead(404);
    return res.end("not found");
  }
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(200, { "content-length": bytes.length });
  res.end(bytes);
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const host = `127.0.0.1:${fake.address().port}`;
const link = (file, token = TOKEN) => `http://${host}/v1/design/projects/p/serve/${encodeURIComponent(file)}?t=${token}&direct=1`;
const listed = ["Page v2.dc.html", "uploads/héro #1.png", "comp.jsx", "flaky.txt", "big.bin", "gone.png", "always-fails.txt", ".thumbnail", "uploads/chat-screenshot.png", "notes/brief.md"];

// --- downloading ----------------------------------------------------------------
{
  const got = await fetchProject(link("Page v2.dc.html"), listed, { testHost: host });
  const paths = got.files.map((f) => f.path);
  const has = (p) => paths.includes(p);
  check("every listed file that exists is fetched", ["Page v2.dc.html", "uploads/héro #1.png", "comp.jsx", "flaky.txt"].every(has), JSON.stringify(paths));
  check("a file with spaces, an accent and a # in its name comes back byte for byte", Buffer.compare(Buffer.from(got.files.find((f) => f.path === "uploads/héro #1.png").bytes), png) === 0);
  check("a design system served from outside the listing is followed, fonts included", has("_ds/sys/styles.css") && has("_ds/sys/fonts/a.woff2"), JSON.stringify(paths));
  check("files that import each other in a loop are fetched once each, and the walk ends", paths.filter((p) => p.startsWith("loop-")).length === 2);
  check("a failure that clears on retry does not lose the file", has("flaky.txt"));
  check("a file over 30 MB is skipped and said so", !has("big.bin") && got.skipped.some((s) => s.startsWith("big.bin")), JSON.stringify(got.skipped));
  check("listed files that 404 or keep failing are reported, not fatal", got.missing.includes("gone.png") && got.missing.includes("always-fails.txt"), JSON.stringify(got.missing));
  check("the thumbnail is left out", !has(".thumbnail"));
  check("files nothing in the design names (chat screenshots, briefs) stay behind", !has("uploads/chat-screenshot.png") && !has("notes/brief.md") && got.unused.includes("uploads/chat-screenshot.png"), JSON.stringify(got.unused));
}
{
  let message = "";
  try {
    await fetchProject(link("Page v2.dc.html", "expired"), listed, { testHost: host });
  } catch (error) {
    message = error.message;
  }
  check("an expired preview link stops the send with a plain fix", /expired.*fresh one/i.test(message), message);
}
{
  let refused = 0;
  for (const bad of [`http://p.claudeusercontent.com/v1/design/projects/p/serve/a.html?t=1`, `https://claudeusercontent.com.evil.io/v1/design/projects/p/serve/a.html?t=1`, `https://p.claudeusercontent.com/somewhere/else`]) {
    try {
      await fetchProject(bad, ["a.html"]);
    } catch {
      refused++;
    }
  }
  check("plain http, look-alike domains and non-preview paths are refused", refused === 3, refused);
}

// --- the tool, as Claude calls it ------------------------------------------------
{
  const empty = await callTool("send_to_figma", { name: "x", serve_url: "", files: [] });
  check("send_to_figma without a link or files explains what it needs", empty.isError && /serve_url/.test(empty.content[0].text));
  const unknown = await callTool("no_such_tool", {});
  check("an unknown tool is an error, not a crash", unknown.isError === true);
  for (const code of ["1234 5678", " 1234-5678 ", "12345678"]) {
    const r = await callTool("pair_figma", { code });
    check(`a pairing code typed as "${code}" is understood`, !r.isError && inbox.pairedCodes().has("1234-5678"), r.content[0].text);
  }
  const short = await callTool("pair_figma", { code: "1234-567" });
  check("a code with a digit missing is refused", short.isError === true);
}

// --- the inbox ---------------------------------------------------------------------
{
  const meta = inbox.put("Old one", Buffer.from("PK"));
  const old = (Date.now() - 25 * 3600 * 1000) / 1000;
  utimesSync(join(process.env.FERRY_HOME, "inbox", `${meta.id}.json`), old, old);
  const fresh = inbox.put("Fresh one", Buffer.from("PK"));
  const names = inbox.list().map((i) => i.name);
  check("a design older than a day is dropped; a new one stays", !names.includes("Old one") && names.includes("Fresh one"), JSON.stringify(names));
  const mode = statSync(join(process.env.FERRY_HOME, "inbox", `${fresh.id}.zip`)).mode & 0o777;
  const dirMode = statSync(join(process.env.FERRY_HOME, "inbox")).mode & 0o777;
  check("the inbox is private to this user (700 folder, 600 files)", mode === 0o600 && dirMode === 0o700, `${mode.toString(8)} ${dirMode.toString(8)}`);
  writeFileSync(join(process.env.FERRY_HOME, "paired.json"), "{not json");
  check("a damaged pairing file means no pairing, not a crash", inbox.pairedCodes().size === 0);
  writeFileSync(join(process.env.FERRY_HOME, "inbox", "half.json"), "{");
  check("a half-written inbox entry is skipped", inbox.list().every((i) => i.name));
}

// --- two Ferry Links (two Claude sessions) share one port ------------------------------
{
  const first = startHttp();
  await new Promise((r) => setTimeout(r, 200));
  const child = spawn("node", [new URL("../server.mjs", import.meta.url).pathname], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  child.stdin.write("this is not json\n");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ferry_status", arguments: {} } })}\n`);
  await new Promise((r) => setTimeout(r, 700));
  child.stdin.end();
  const code = await new Promise((r) => child.on("exit", r));
  const lines = out.trim().split("\n");
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  });
  check("the second Ferry Link starts beside the first and says it shares the port", /port \d+: shared/.test(parsed.find((m) => m?.id === 3)?.result?.content?.[0]?.text || ""), out);
  check("MCP: nothing but JSON-RPC ever reaches stdout", parsed.every(Boolean), out);
  check("MCP: a line that is not JSON gets a parse error, and the server carries on", parsed.some((m) => m?.error?.code === -32700) && parsed.some((m) => m?.id === 3));
  check("MCP: a method it does not have gets 'method not found'", parsed.find((m) => m?.id === 2)?.error?.code === -32601);
  check("MCP: initialize with no protocol version still answers", !!parsed.find((m) => m?.id === 1)?.result?.protocolVersion);
  check("MCP: closing stdin ends the server cleanly", code === 0, `${code} ${err}`);
  first.close();
}

// --- a port held by something that is not Ferry Link ----------------------------------------
{
  const squatter = createServer((req, res) => res.end("<html>someone else</html>"));
  await new Promise((r) => squatter.listen(PORT + 7, "127.0.0.1", r));
  const res = await new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: PORT + 7, path: "/v1/inbox" }, (r) => {
      let b = "";
      r.on("data", (d) => (b += d));
      r.on("end", () => resolve({ status: r.statusCode, body: b }));
    });
    req.end();
  });
  let parsedOk = true;
  try {
    JSON.parse(res.body);
  } catch {
    parsedOk = false;
  }
  check("another app on the port answers with something the panel cannot read, so it shows 'not installed'", res.status === 200 && !parsedOk);
  squatter.close();
}

fake.close();
console.log(`\nFERRY LINK ROBUSTNESS ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
