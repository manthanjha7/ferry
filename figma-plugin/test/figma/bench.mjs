/**
 * Drive Ferry inside the real Figma desktop app, one case at a time.
 *
 *   node bench.mjs <tab-target-prefix> <case.zip> <mode: none|build|map> <out-dir>
 *
 * Clears the page, drops the zip on Ferry's real panel, picks the token mode,
 * clicks Import, waits for the result, then writes what Figma actually
 * rendered (PNG per top-level frame, via the --selftest build's export hook),
 * the layer tree, the panel's summary and a screenshot of the panel.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { connectBrowser, evaluate, sleep } from "./cdp.mjs";

const [prefix, zipPath, mode = "none", outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const cdp = await connectBrowser();
const page = (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.targetId.startsWith(prefix));
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
await cdp.send("Runtime.enable", {}, sessionId);

// The build the panel must be running: Figma caches plugin code between runs,
// so a rebuilt dist is only live once the plugin is closed and run again.
const distStamp = /build ([0-9-]+ [0-9:]+(?: selftest)?)/.exec(readFileSync(new URL("../../dist/ui.html", import.meta.url), "utf8"))[1];

async function findPanel() {
  const contexts = [];
  const off = cdp.on((msg) => {
    if (msg.sessionId === sessionId && msg.method === "Runtime.executionContextCreated") contexts.push(msg.params.context);
  });
  await cdp.send("Runtime.disable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await sleep(400);
  off();
  for (const ctx of contexts) {
    try {
      const stamp = await evaluate(cdp, sessionId, "document.getElementById('cd2f-import') ? (document.body.innerText.match(/build ([0-9-]+ [0-9:]+(?: selftest)?)/) || [])[1] || 'unknown' : ''", { contextId: ctx.id, timeout: 2000 });
      if (stamp) return { id: ctx.id, stamp };
    } catch {}
  }
  return null;
}

async function clickText(pattern) {
  const at = await evaluate(cdp, sessionId, `(() => {
    const re = new RegExp(${JSON.stringify(pattern)});
    const c = Array.from(document.querySelectorAll("*")).filter(e => e.children.length < 6 && re.test((e.innerText||"").trim().replace(/\\s+/g," ")));
    const el = c[c.length - 1]; if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 };
  })()`);
  if (!at) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, sessionId);
  }
  return true;
}

async function launchFerry() {
  const { press, typeText } = await import("./keys.mjs");
  await evaluate(cdp, sessionId, "document.querySelector('canvas')?.focus(); true");
  await press(cdp, sessionId, "Slash", 4);
  await sleep(900);
  await typeText(cdp, sessionId, "Ferry");
  await sleep(1500);
  await clickText("^Ferry\\s*Development$");
  await sleep(3500);
}

let panel = await findPanel();
// Every case starts in a freshly opened panel. A panel that already holds a
// drop keeps Import enabled, so a click could land before the new drop is
// read and import the previous document.
if (panel) {
  await evaluate(cdp, sessionId, "document.getElementById('cd2f-close')?.click(); true", { contextId: panel.id }).catch(() => {});
  await sleep(1500);
  panel = null;
}
if (panel && panel.stamp !== distStamp) {
  await evaluate(cdp, sessionId, "true");
  // Close the stale panel through its own Close button.
  await evaluate(cdp, sessionId, "document.getElementById('cd2f-cancel')?.click() || Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'Close')?.click(); true", { contextId: panel.id }).catch(() => {});
  await sleep(1500);
  panel = null;
}
if (!panel) {
  await launchFerry();
  panel = await findPanel();
}
if (!panel) throw new Error("could not open Ferry");
if (panel.stamp !== distStamp) throw new Error(`Ferry is running ${panel.stamp}, dist is ${distStamp}`);

const ui = panel.id;
const run = (expr, timeout = 120000) => evaluate(cdp, sessionId, expr, { contextId: ui, timeout });
/** Poll an expression from Node until it returns something truthy. Long awaited promises get collected. */
async function until(expr, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const value = await run(expr, 10000);
    if (value) return value;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

// A reply channel: every sandbox message tagged `selftest` lands in window.__st.
await run(`(() => {
  if (!window.__imports) {
    window.__st = window.__st || [];
    window.__imports = [];
    window.addEventListener("message", (e) => {
      const m = e.data && e.data.pluginMessage;
      if (m && m.selftest) window.__st.push(m);
      if (m && (m.type === "import-complete" || m.type === "import-failed")) window.__imports.push({ type: m.type, message: m.message, frames: m.frames, nodes: m.nodes });
    });
  }
  return true;
})()`);
async function ask(type, extra = {}) {
  const before = await run(`window.__st.length`);
  await run(`parent.postMessage({ pluginMessage: { type: ${JSON.stringify(type)}, ...${JSON.stringify(extra)} } }, "*"), true`);
  return until(`window.__st.slice(${before})[0] || null`, 120000, `reply to ${type}`);
}

await ask("selftest-clear");

// Drop the zip on the real dropzone.
const b64 = readFileSync(zipPath).toString("base64");
await run(`(async () => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
  const file = new File([bytes], ${JSON.stringify(basename(zipPath))}, { type: "application/zip" });
  const dt = new DataTransfer();
  dt.items.add(file);
  const zone = document.querySelector(".cd2f-dropzone") || document.getElementById("cd2f-dropzone");
  zone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  return true;
})()`);

// Wait until the panel is ready, then pick the mode and import.
await until(`(() => { const b = document.getElementById("cd2f-import"); return !!b && !b.disabled; })()`, 60000, "the Import button");
await run(`(() => {
  const radios = Array.from(document.querySelectorAll("#cd2f-token-mode input[type=radio]"));
  const want = ${JSON.stringify(mode)};
  const pick = radios.find((r) => (r.value || "").toLowerCase().startsWith(want)) ||
    radios.find((r) => (r.closest("label")?.innerText || "").toLowerCase().startsWith(want === "build" ? "build" : want === "map" ? "map" : "none"));
  if (pick && !pick.disabled) { pick.click(); pick.dispatchEvent(new Event("change", { bubbles: true })); }
  return pick ? pick.value : "none-found";
})()`);
const t0 = Date.now();
const importsBefore = await run(`window.__imports.length`);
await run(`document.getElementById("cd2f-import").click(), true`);
// Done is the sandbox saying so, after THIS click: panel text can be a
// previous case's "Imported." still on screen.
const outcome = await until(
  `(() => {
    const got = window.__imports.slice(${importsBefore})[0];
    if (got) return got;
    const t = document.body.innerText;
    if (/stopped the import|could not be imported|None of the/i.test(t) && !document.getElementById("cd2f-import").disabled) return { type: "extract-failed", message: t.slice(0, 600) };
    return null;
  })()`,
  300000,
  "the import to finish",
);
await sleep(500);
const status = await run(`document.body.innerText`);
const took = Date.now() - t0;

const summary = status.split("\n").filter((l) => l.trim()).slice(0, 80).join("\n");
writeFileSync(join(outDir, "panel.txt"), `took ${took}ms\noutcome ${JSON.stringify(outcome)}\n${summary}`);
if (outcome.type !== "import-complete") {
  console.log(JSON.stringify({ took, failed: outcome }));
  process.exit(2);
}

const tree = await ask("selftest-tree");
writeFileSync(join(outDir, "tree.json"), JSON.stringify(tree, null, 1));
const png = await ask("selftest-export", { scale: 1 });
if (png.type === "selftest-png") {
  png.frames.forEach((f, i) => writeFileSync(join(outDir, `frame-${i + 1}.png`), Buffer.from(f.png, "base64")));
}
const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
writeFileSync(join(outDir, "figma-window.png"), Buffer.from(data, "base64"));
console.log(JSON.stringify({ took, frames: png.frames?.map((f) => `${f.name} ${Math.round(f.width)}x${Math.round(f.height)}`), error: png.message }));
cdp.close();
