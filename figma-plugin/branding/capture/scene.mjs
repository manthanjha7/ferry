// A small driver for staging Ferry scenes in real Figma.
import { readFileSync, writeFileSync } from "node:fs";
import { connectBrowser, evaluate, sleep } from "../../test/figma/cdp.mjs";
import { press, typeText } from "../../test/figma/keys.mjs";
export { sleep };
export async function open(prefix) {
  const cdp = await connectBrowser();
  const page = (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.targetId.startsWith(prefix));
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  const s = { cdp, sessionId, ui: null };
  s.page = (expr, timeout = 60000) => evaluate(cdp, sessionId, expr, { timeout });
  s.findPanel = async () => {
    const contexts = [];
    const off = cdp.on((m) => { if (m.sessionId === sessionId && m.method === "Runtime.executionContextCreated") contexts.push(m.params.context); });
    await cdp.send("Runtime.disable", {}, sessionId); await cdp.send("Runtime.enable", {}, sessionId); await sleep(400); off();
    for (const ctx of contexts) {
      try { const ok = await evaluate(cdp, sessionId, "!!document.getElementById('cd2f-import')", { contextId: ctx.id, timeout: 2000 }); if (ok) { s.ui = ctx.id; return ctx.id; } } catch {}
    }
    return null;
  };
  s.run = (expr, timeout = 60000) => evaluate(cdp, sessionId, expr, { contextId: s.ui, timeout });
  s.click = async (x, y) => { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sessionId); };
  s.move = async (x, y) => cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, sessionId);
  s.clickText = async (pattern) => {
    const at = await s.page(`(() => { const re = new RegExp(${JSON.stringify(pattern)}); const c = Array.from(document.querySelectorAll("*")).filter(e => e.children.length < 6 && re.test((e.innerText||"").trim().replace(/\\s+/g," "))); const el = c[c.length-1]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height/2 }; })()`);
    if (!at) return false; await s.click(at.x, at.y); return true;
  };
  s.launch = async () => {
    await s.page("Array.from(document.querySelectorAll('button[aria-label=Close], button[aria-label=close]')).filter(b => b.closest('[role=dialog], [class*=popover], [class*=onboarding], [class*=modal]')).forEach(b => b.click()); document.querySelector('canvas')?.focus(); true");
    await press(cdp, sessionId, "Escape"); await press(cdp, sessionId, "Slash", 4); await sleep(900);
    await typeText(cdp, sessionId, "Ferry"); await sleep(1500);
    await s.clickText("^Ferry\\s*Development$"); await sleep(3500);
    return s.findPanel();
  };
  s.listen = () => s.run(`(() => { if (!window.__st) { window.__st = []; window.__imports = []; window.addEventListener("message", (e) => { const m = e.data && e.data.pluginMessage; if (m && m.selftest) window.__st.push(m); if (m && (m.type === "import-complete" || m.type === "import-failed")) window.__imports.push(m.type); }); } return true; })()`);
  s.until = async (expr, ms = 60000) => { const t0 = Date.now(); for (;;) { const v = await s.run(expr, 10000); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timeout " + expr.slice(0, 60)); await sleep(150); } };
  s.ask = async (type, extra = {}) => { const n = await s.run("window.__st.length"); await s.run(`parent.postMessage({ pluginMessage: { type: ${JSON.stringify(type)}, ...${JSON.stringify(extra)} } }, "*"), true`); return s.until(`window.__st.slice(${n})[0] || null`, 60000); };
  s.sandbox = async (code) => { const r = await s.ask("selftest-eval", { code }); return r.value ? JSON.parse(r.value) : r; };
  s.emulate = async (w, h, dpr) => { await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile: false }, sessionId); await sleep(1200); };
  s.shot = async (out, format = "png", dpr = 2) => { await s.emulate(1600, 900, dpr); const { data } = await cdp.send("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 92 } : {}) }, sessionId); writeFileSync(out, Buffer.from(data, "base64")); };
  s.drop = (zipPath, name) => s.run(`(async () => { const bytes = Uint8Array.from(atob(${JSON.stringify(readFileSync(zipPath).toString("base64"))}), (c) => c.charCodeAt(0)); const file = new File([bytes], ${JSON.stringify(name)}, { type: "application/zip" }); const dt = new DataTransfer(); dt.items.add(file); const zone = document.querySelector(".cd2f-dropzone") || document.getElementById("cd2f-dropzone"); zone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
  s.close = () => { cdp.close(); };
  return s;
}
