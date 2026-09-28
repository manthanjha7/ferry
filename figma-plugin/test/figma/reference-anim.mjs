/**
 * The reference for an animation project: Claude Design's own runtime in
 * Chrome, its engine seeked to each second Ferry captured a scene at, the
 * stage screenshotted at its authored size.
 *
 *   node reference-anim.mjs <case.zip> <tree.json> <outDir>
 *
 * Writes reference-<n>.png per scene frame in tree.json (those carrying a
 * sceneTime), numbered like the bench's frame-<n>.png.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { connect, sleep } from "./cdp.mjs";

const [zip, treePath, outDir] = process.argv.slice(2);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const tree = JSON.parse(readFileSync(treePath, "utf8"));
const scenes = tree.frames.map((f, i) => ({ index: i + 1, at: f.sceneTime, name: f.name })).filter((s) => s.at !== undefined);
if (!scenes.length) throw new Error("no scene frames in the tree");

const root = mkdtempSync(join(tmpdir(), "ferry-anim-ref-"));
execFileSync("unzip", ["-q", "-o", zip, "-d", root]);
const pages = [];
const find = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) find(p);
    else if (f.endsWith(".html")) pages.push(relative(root, p));
  }
};
find(root);

const port = 8990 + Math.floor(Math.random() * 9);
const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "ferry-anim-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--hide-scrollbars", "--window-size=1920,1080", "--force-device-scale-factor=1",
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
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/${encodeURI(pages[0])}` }, sessionId);
  const evalIn = async (expression) =>
    (await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;
  // The engine needs React and Babel from a CDN, then compiles the scenes.
  let size = null;
  for (let i = 0; i < 120 && !size; i++) {
    await sleep(250);
    size = await evalIn(`(() => {
      const svg = document.querySelector("svg[data-om-exportable-video-with-duration-secs]");
      const fo = svg && svg.querySelector("foreignObject > div");
      if (!svg || !fo || !svg.hasAttribute("data-om-sync-seek")) return null;
      const r = fo.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
  }
  if (!size) throw new Error("the animation stage never appeared");
  // The player fits the stage to the window (scale 0.75 at 1440x900) and
  // re-applies that on every render. Size the window so its own fit is 1.
  const authored = await evalIn(`(() => { const svg = document.querySelector("svg[data-om-exportable-video-with-duration-secs]"); return { w: +svg.getAttribute("width"), h: +svg.getAttribute("height") }; })()`);
  // The player scales the stage to fit the window (0.75 at 1440x900) and
  // re-applies that inline on every render; a stylesheet rule with
  // !important outranks it. The window is larger than the stage, so nothing
  // around it clips.
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: authored.w + 200, height: authored.h + 200, deviceScaleFactor: 1, mobile: false }, sessionId);
  await evalIn(`(() => { const s = document.createElement("style"); s.textContent = "svg[data-om-exportable-video-with-duration-secs] { transform: none !important; }"; document.head.appendChild(s); return true; })()`);
  await sleep(500);
  await evalIn("document.fonts.ready.then(() => true)");
  await sleep(800);
  for (const scene of scenes) {
    const clip = await evalIn(`(() => {
      const svg = document.querySelector("svg[data-om-exportable-video-with-duration-secs]");
      svg.dispatchEvent(new CustomEvent("data-om-seek-to-time-frame", { detail: { time: ${scene.at}, sync: true, playing: false } }));
      const r = svg.querySelector("foreignObject > div").getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
    })()`);
    await sleep(400);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...clip, scale: 1 } }, sessionId);
    writeFileSync(join(outDir, `reference-${scene.index}.png`), Buffer.from(data, "base64"));
    console.log(JSON.stringify({ scene: scene.name, at: scene.at, ...clip }));
  }
  cdp.close();
} finally {
  chrome.kill();
  server.kill();
}
