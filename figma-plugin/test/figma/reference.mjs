/**
 * The reference: the same document in a real Chrome at the design width, the
 * way a designer sees it in Claude Design once they have scrolled through it
 * and every animation has played. Full-page PNG.
 *
 *   node reference.mjs <case.zip|page.html> <out.png> [width=1440]
 *
 * Zips are unpacked and served over http so relative assets and Claude
 * Design's own support.js (which loads React from a CDN) work as they do in
 * Claude Design.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { connect, sleep } from "./cdp.mjs";

const [input, out, widthArg, scheme = "light"] = process.argv.slice(2);
const width = Number(widthArg || 1440);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let root = dirname(input);
let page = basename(input);
if (input.endsWith(".zip")) {
  root = mkdtempSync(join(tmpdir(), "ferry-ref-"));
  execFileSync("unzip", ["-q", "-o", input, "-d", root]);
  const html = [];
  const find = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) find(p);
      else if (f.endsWith(".html")) html.push(relative(root, p));
    }
  };
  find(root);
  page = html[0];
}

const port = 8950 + Math.floor(Math.random() * 40);
const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: root, stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "ferry-ref-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--hide-scrollbars", `--window-size=${width},900`, "--force-device-scale-factor=1",
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, sessionId);
  await sleep(600);
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/${encodeURI(page)}` }, sessionId);
  await sleep(4000);
  const evalIn = async (expression) =>
    (await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;
  // Figma ships Inter and Roboto, and so does the page Ferry measures in, so the
  // reference gets them too. A document's own font links load as they would.
  // Inter is Figma's own copy, the exact @font-face rules Ferry's panel has
  // (captured into figma-fonts.css), not Google's: the two differ in glyph
  // coverage, and a ★ that falls back in one moved every line below it by 4px.
  const figmaFonts = readFileSync(new URL("./figma-fonts.css", import.meta.url), "utf8");
  await evalIn(`(async () => {
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(figmaFonts)};
    document.head.appendChild(style);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,100..900;1,100..900&display=block";
    document.head.appendChild(link);
    await new Promise((r) => { link.onload = r; link.onerror = r; setTimeout(r, 5000); });
    await Promise.all([400, 500, 600, 700].map((w) => document.fonts.load(w + " 16px Inter")));
    await document.fonts.ready;
    return true;
  })()`);
  await sleep(500);
  // Scroll through so every reveal-on-scroll fires, then back to the top.
  const height = await evalIn("document.documentElement.scrollHeight");
  for (let y = 0; y < height; y += 400) {
    await evalIn(`window.scrollTo(0, ${y})`);
    await sleep(120);
  }
  await evalIn("window.scrollTo(0, 0)");
  await sleep(2500);
  // The page's content, not the viewport: a short page is not 900px of white.
  const full = await evalIn(`Math.ceil(Math.max(1, ...Array.from(document.body.querySelectorAll("*")).map((el) => el.getBoundingClientRect().bottom + scrollY)))`);
  // Every named element's box, for a per-element diff against Figma's tree.
  const boxes = await evalIn(`JSON.stringify(Array.from(document.querySelectorAll("body *")).filter((el) => el.hasAttribute("data-name") || (/^(H[1-6]|P|LI)$/.test(el.tagName) && el.innerText.trim()) || (el.children.length === 0 && el.innerText && el.innerText.trim() && el.getClientRects().length)).slice(0, 800).map((el) => {
    const cs = getComputedStyle(el);
    const hasPseudo = ["::before", "::after"].some((p) => { const c = getComputedStyle(el, p).content; return c && c !== "none" && c !== "normal"; });
    const truncates = cs.textOverflow === "ellipsis" || (cs.webkitLineClamp && cs.webkitLineClamp !== "none");
    const clipsText = /text/.test(cs.backgroundClip || cs.webkitBackgroundClip || "");
    // A plain text leaf becomes a Figma text layer that hugs its words, so its
    // glyph box is what to compare; anything decorated or cut off keeps its box.
    const block = /^(H[1-6]|P|LI)$/.test(el.tagName) && !el.hasAttribute("data-name");
    const leafText = !block && el.children.length === 0 && el.innerText.trim() && cs.backgroundColor === "rgba(0, 0, 0, 0)" &&
      cs.backgroundImage === "none" && !hasPseudo && !truncates && !clipsText && cs.borderTopWidth === "0px" && cs.paddingLeft === "0px";
    let r = el.getBoundingClientRect();
    if (leafText) { const range = document.createRange(); range.selectNodeContents(el); r = range.getBoundingClientRect(); }
    return { name: el.getAttribute("data-name") || "", kind: block ? "block" : leafText ? "glyph" : "box", text: el.children.length === 0 || block ? el.innerText.trim().replace(/\\s+/g, " ") : null, x: Math.round(r.left * 10) / 10, y: Math.round((r.top + scrollY) * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  }))`);
  writeFileSync(out.replace(/\.png$/, ".boxes.json"), boxes);
  // Keep the 900px viewport (so 100vh stays one screen) and capture past it.
  const { data } = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(full, 16000), scale: 1 } },
    sessionId,
  );
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(JSON.stringify({ page, width, height: full }));
  cdp.close();
} finally {
  chrome.kill();
  server.kill();
}
