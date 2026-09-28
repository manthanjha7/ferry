/**
 * Ferry Link's own checks: node test/test.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-home-"));
process.env.FERRY_LINK_PORT = String(48000 + Math.floor(Math.random() * 1000));
const { zip } = await import("../lib/zip.mjs");
const { references, previewBase } = await import("../lib/fetch-project.mjs");
const inbox = await import("../lib/inbox.mjs");
const { startHttp, callTool, PORT } = await import("../server.mjs");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` :: ${detail}`}`);
};

// Zip: a real zip tool reads it back, byte for byte.
{
  const dir = mkdtempSync(join(tmpdir(), "ferry-zip-"));
  const png = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) % 256);
  const bytes = zip([{ path: "Page.dc.html", bytes: Buffer.from("<html>é</html>") }, { path: "uploads/a b.png", bytes: png }]);
  writeFileSync(join(dir, "t.zip"), bytes);
  let ok = false;
  try {
    ok = /No errors/.test(execFileSync("unzip", ["-t", join(dir, "t.zip")], { encoding: "utf8" }));
    execFileSync("unzip", ["-q", join(dir, "t.zip"), "-d", join(dir, "x")]);
    ok = ok && Buffer.compare(execFileSync("cat", [join(dir, "x", "uploads", "a b.png")]), Buffer.from(png)) === 0;
  } catch (e) {
    ok = false;
  }
  check("the zip is valid and every file comes back byte for byte", ok);
}

// References: relative paths followed, absolute and templated ones not.
{
  const refs = references("pages/Home.dc.html", `<link href="../_ds/x/styles.css"><img src="uploads/a.png"><script src="https://cdn/x.js"></script><div style="background:url('bg.jpg')"></div><img src="{{ hero }}"><x-import from="./comp.jsx"></x-import><a href="#top">`);
  const want = ["_ds/x/styles.css", "pages/uploads/a.png", "pages/bg.jpg", "pages/comp.jsx"];
  check("references are the page's relative files, resolved from its folder", want.every((r) => refs.has(r)) && refs.size === want.length, JSON.stringify([...refs]));
}

// A preview link is only ever a Claude Design one.
{
  let refused = false;
  try {
    previewBase("https://evil.example.com/v1/design/projects/x/serve/a.html?t=1");
  } catch {
    refused = true;
  }
  const base = previewBase("https://p.claudeusercontent.com/v1/design/projects/p/serve/Page%20v2.dc.html?t=abc&direct=1");
  check("a preview link from anywhere else is refused", refused && base.prefix === "/v1/design/projects/p/serve/" && base.query === "?t=abc&direct=1", JSON.stringify(base));
}

// HTTP, as the Ferry panel and as everything that is not the panel.
const server = startHttp();
await new Promise((r) => setTimeout(r, 200));
const call = (method, path, headers = {}) =>
  new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: PORT, method, path, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.end();
  });
{
  const panel = { origin: "null", "x-ferry-code": "1234-5678" };
  const website = await call("GET", "/v1/inbox", { origin: "https://evil.example.com", "x-ferry-code": "1234-5678" });
  check("a website's page is refused", website.status === 403, website.status);
  const rebound = await call("GET", "/v1/inbox", { ...panel, host: "evil.example.com" });
  check("a request for another host name (DNS rebinding) is refused", rebound.status === 403, rebound.status);
  const pre = await call("OPTIONS", "/v1/inbox", { origin: "null", "access-control-request-private-network": "true" });
  check("the panel's preflight is allowed, private-network included", pre.status === 204 && pre.headers["access-control-allow-private-network"] === "true" && pre.headers["access-control-allow-origin"] === "null", JSON.stringify(pre.headers));
  const unpaired = await call("GET", "/v1/inbox", panel);
  check("an unpaired panel is asked to pair and sees nothing", unpaired.status === 403 && JSON.parse(unpaired.body).pairing === true, unpaired.status);
  const paired = await callTool("pair_figma", { code: "1234-5678" });
  const meta = inbox.put("Portfolio", zip([{ path: "Portfolio.html", bytes: Buffer.from("<html></html>") }]));
  const listed = await call("GET", "/v1/inbox", panel);
  const items = JSON.parse(listed.body).items || [];
  check("once paired, the panel sees what Claude sent", !paired.isError && listed.status === 200 && items[0]?.name === "Portfolio", listed.body.toString());
  const got = await call("GET", `/v1/inbox/${meta.id}`, panel);
  check("and downloads it as a zip", got.status === 200 && got.headers["content-type"] === "application/zip" && got.body.readUInt32LE(0) === 0x04034b50, got.status);
  const del = await call("DELETE", `/v1/inbox/${meta.id}`, panel);
  const after = JSON.parse((await call("GET", "/v1/inbox", panel)).body).items;
  check("an imported design leaves the inbox", del.status === 200 && after.length === 0, JSON.stringify(after));
  const traversal = await call("GET", "/v1/inbox/..%2F..%2Fpaired", panel);
  check("an inbox id cannot reach outside the inbox", traversal.status === 404, traversal.status);
  const badPair = await callTool("pair_figma", { code: "hello" });
  check("a malformed pairing code is refused", badPair.isError === true);
}
server.close();

// MCP over stdio, the way Claude Code starts it.
{
  const child = spawn("node", [new URL("../server.mjs", import.meta.url).pathname], {
    env: { ...process.env, FERRY_LINK_PORT: String(PORT + 1) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies = [];
  let buffer = "";
  child.stdout.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      replies.push(JSON.parse(buffer.slice(0, i)));
      buffer = buffer.slice(i + 1);
    }
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ferry_status", arguments: {} } });
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "send_to_figma", arguments: { name: "x", serve_url: "https://evil.example.com/serve/a.html", files: ["a.html"] } } });
  await new Promise((r) => setTimeout(r, 800));
  child.kill();
  const by = (id) => replies.find((r) => r.id === id);
  check("MCP: initialize answers with the server's name and tools capability", by(1)?.result?.serverInfo?.name === "ferry-link" && !!by(1)?.result?.capabilities?.tools, JSON.stringify(by(1)));
  check("MCP: three tools are listed", (by(2)?.result?.tools || []).map((t) => t.name).join(",") === "send_to_figma,pair_figma,ferry_status", JSON.stringify(by(2)));
  check("MCP: ferry_status reports the port and the inbox", /port \d+/.test(by(3)?.result?.content?.[0]?.text || ""), JSON.stringify(by(3)));
  check("MCP: a link that is not Claude Design's is refused with a plain message", by(4)?.result?.isError === true && /not a Claude Design preview link/.test(by(4)?.result?.content?.[0]?.text || ""), JSON.stringify(by(4)));
}

console.log(`\nFERRY LINK ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
