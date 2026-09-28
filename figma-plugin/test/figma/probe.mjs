/**
 * Ferry's extractor on one page in headless Chrome, IR out as JSON. For
 * reading exactly what the extractor decided about a node, without Figma.
 *
 *   node probe.mjs <case.zip|page.html> <out.json> [width=1440]
 *
 * Every other file next to the page is passed in as a module source, the way
 * the panel passes the rest of a dropped zip.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { connect, evaluate, sleep } from "./cdp.mjs";

const [input, out, widthArg] = process.argv.slice(2);
const width = Number(widthArg || 1440);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let root = input;
let files = [];
if (input.endsWith(".zip")) {
  root = mkdtempSync(join(tmpdir(), "ferry-probe-"));
  execFileSync("unzip", ["-q", "-o", input, "-d", root]);
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      statSync(p).isDirectory() ? walk(p) : files.push(relative(root, p));
    }
  };
  walk(root);
} else {
  files = [input.split("/").pop()];
  root = input.slice(0, input.length - files[0].length) || ".";
}
const page = files.find((f) => f.endsWith(".html"));
const sources = {};
for (const f of files) {
  if (f === page || !/\.(js|jsx|tsx|ts|css)$/.test(f)) continue;
  const text = readFileSync(join(root, f), "utf8");
  sources[f] = text;
  sources["./" + f] = text;
}
const html = readFileSync(join(root, page), "utf8");
const bundle = readFileSync(new URL("../fixture/bundle.js", import.meta.url), "utf8");

const profile = mkdtempSync(join(tmpdir(), "ferry-probe-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--window-size=400,620", "--force-device-scale-factor=1",
], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve) => {
  chrome.stderr.on("data", (d) => {
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
    if (m) resolve(m[1]);
  });
});
try {
  const cdp = await connect(wsUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await evaluate(cdp, sessionId, `(0, eval)(${JSON.stringify(bundle)}); true`);
  await evaluate(cdp, sessionId, `window.__out = null; window.extractDocument(${JSON.stringify(html)}, ${JSON.stringify(page.replace(/\.(dc\.)?html$/, ""))}, { viewportWidth: ${width}, moduleSources: ${JSON.stringify(sources)} }).then(d => window.__out = d, e => window.__out = { error: String(e && e.stack || e) }); true`);
  let json = "";
  for (let i = 0; i < 600 && !json; i++) {
    json = await evaluate(cdp, sessionId, `window.__out ? JSON.stringify(window.__out) : ""`);
    if (!json) await sleep(200);
  }
  writeFileSync(out, json);
  console.log(out, json.length);
} finally {
  chrome.kill();
}
