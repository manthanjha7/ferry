import { open, sleep } from "./scene.mjs";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
execFileSync("open", ["-a", "Figma"]);
const OUT = "/tmp/fig/rec"; rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const s = await open("EFA84508");
const W = 1600, H = 900, DPR = 1.2;
await s.emulate(W, H, DPR);
// fresh state
if (await s.findPanel()) { await s.run("document.getElementById('cd2f-close')?.click(), true").catch(() => {}); await sleep(1500); }
let ui = null; for (let i = 0; i < 3 && !ui; i++) ui = await s.launch();
await sleep(1500); await s.findPanel(); await s.listen();
// the dev build stamp ("build … selftest") is not part of the product
await s.run(`(() => { for (const el of document.querySelectorAll("*")) if (el.childElementCount === 0 && /^build \d{4}-/.test((el.textContent||"").trim())) el.style.display = "none"; return 1; })()`);
await s.sandbox(`for (const n of [...figma.currentPage.children]) n.remove(); for (const c of await figma.variables.getLocalVariableCollectionsAsync()) c.remove(); figma.currentPage.selection = []; figma.viewport.zoom = 0.33; figma.viewport.center = { x: 1500, y: 450 }; return 1;`);
await s.run("document.getElementById('cd2f-close')?.click(), true").catch(() => {}); await sleep(1500);
ui = null; for (let i = 0; i < 3 && !ui; i++) ui = await s.launch();
await sleep(1500); await s.findPanel(); await s.listen();
await s.run(`(() => { for (const el of document.querySelectorAll("*")) if (el.childElementCount === 0 && /^build \d{4}-/.test((el.textContent||"").trim())) el.style.display = "none"; return 1; })()`);
await sleep(800);
// where things are, in page coordinates
const frameOffset = await s.page(`(() => { const f = Array.from(document.querySelectorAll("iframe")).map(f => f.getBoundingClientRect()).filter(r => r.width > 300 && r.width < 500 && r.height > 300)[0]; return f ? { x: f.left, y: f.top } : null; })()`);
const at = async (sel) => { const r = await s.run(`(() => { const el = ${sel}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`); return r && { x: r.x + frameOffset.x, y: r.y + frameOffset.y }; };
// a visible cursor, drawn into the page above everything
await s.page(`(() => { const c = document.createElement("div"); c.id = "rec-cursor"; c.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(820px,620px);transition:none"; c.innerHTML = '<svg width="22" height="30" viewBox="0 0 22 30"><path d="M2 2 L2 24 L8 18.5 L12.5 28 L16 26.4 L11.6 17.2 L19.5 17.2 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><div id="rec-chip" style="display:none;margin:-4px 0 0 18px;padding:6px 10px;border-radius:8px;background:#fff;color:#111;font:500 12px Inter,system-ui;box-shadow:0 4px 14px rgba(0,0,0,.35);white-space:nowrap">Tidepool Landing.zip</div>'; document.body.appendChild(c); return 1; })()`);
let cur = { x: 820, y: 620 };
const moveTo = async (p, ms = 700) => { const steps = Math.max(8, Math.round(ms / 16)); const from = { ...cur }; for (let i = 1; i <= steps; i++) { const t = i / steps; const e = t < .5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2; const x = from.x + (p.x - from.x) * e, y = from.y + (p.y - from.y) * e; await s.page(`document.getElementById("rec-cursor").style.transform = "translate(${x}px,${y}px)"`); await sleep(ms / steps); } cur = { ...p }; };
const press = async () => { await s.page(`(() => { const c = document.getElementById("rec-cursor"); c.animate([{ transform: c.style.transform + " scale(1)" }, { transform: c.style.transform + " scale(.82)" }, { transform: c.style.transform + " scale(1)" }], { duration: 220 }); return 1; })()`); await sleep(160); };
// record
const frames = [];
s.cdp.on((m) => { if (m.sessionId === s.sessionId && m.method === "Page.screencastFrame") { frames.push({ t: m.params.metadata.timestamp, data: m.params.data }); s.cdp.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, s.sessionId); } });
await s.cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }, s.sessionId);
const keepAlive = setInterval(() => s.page(`document.getElementById("rec-cursor").style.opacity = document.getElementById("rec-cursor").style.opacity === "0.999" ? "1" : "0.999"`).catch(() => {}), 50);
await sleep(1200);
// 1. drag the export onto the panel
await s.page(`document.getElementById("rec-chip").style.display = "block"`);
const zone = await at(`document.querySelector(".cd2f-dropzone") || document.getElementById("cd2f-dropzone")`);
await moveTo(zone, 1300);
await press();
await s.page(`document.getElementById("rec-chip").style.display = "none"`);
await s.drop("/tmp/ferry-capture/tidepool.zip", "Tidepool Landing.zip");
await s.until(`(() => { const b = document.getElementById("cd2f-import"); return !!b && !b.disabled; })()`, 30000);
await sleep(1200);
// 3. Import
const imp = await at(`document.getElementById("cd2f-import")`);
await moveTo(imp, 800); await press();
await s.run(`document.getElementById("cd2f-import").click(), true`);
await s.until(`window.__imports.length > 0`, 120000);
await sleep(1800);
// 4. close the panel and look at the result
const close = await at(`Array.from(document.querySelectorAll("button")).find(b => b.innerText.trim() === "Close")`);
await moveTo(close, 700); await press();
await s.run(`Array.from(document.querySelectorAll("button")).find(b => b.innerText.trim() === "Close").click(), true`).catch(() => {});
await sleep(900);
await moveTo({ x: 700, y: 840 }, 500);
s.ui = null;
await s.page("document.querySelector('canvas')?.focus(); true");
await s.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "@", code: "Digit2", windowsVirtualKeyCode: 50, modifiers: 8 }, s.sessionId);
await s.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "@", code: "Digit2", windowsVirtualKeyCode: 50, modifiers: 8 }, s.sessionId);
await sleep(1800);
// the two frames now fill the canvas: 3080 wide, the dark one starting 1640 in
const canvas = await s.page(`(() => { const c = Array.from(document.querySelectorAll("canvas")).sort((a,b) => b.width*b.height - a.width*a.height)[0]; const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
console.log("canvas", JSON.stringify(canvas));
await s.page("document.querySelector('canvas')?.focus(); true");
await s.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "¬", code: "KeyL", windowsVirtualKeyCode: 76, modifiers: 1 }, s.sessionId);
await s.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "¬", code: "KeyL", windowsVirtualKeyCode: 76, modifiers: 1 }, s.sessionId);
await sleep(900);
const row = await s.page(`(() => { const el = Array.from(document.querySelectorAll("*")).find(e => e.childElementCount === 0 && (e.textContent||"").trim() === "Tidepool Landing · theme=dark" && e.getBoundingClientRect().left < 300 && e.getBoundingClientRect().width > 0); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height/2 }; })()`);
console.log("row", JSON.stringify(row));
if (row) { await moveTo(row, 1000); await press(); await s.click(row.x, row.y); }
await sleep(3000);
clearInterval(keepAlive);
await s.cdp.send("Page.stopScreencast", {}, s.sessionId);
await s.page(`document.getElementById("rec-cursor")?.remove(); true`);
frames.forEach((f, i) => writeFileSync(`${OUT}/f${String(i).padStart(5, "0")}.jpg`, Buffer.from(f.data, "base64")));
const list = frames.map((f, i) => `file '${OUT}/f${String(i).padStart(5, "0")}.jpg'\nduration ${(i + 1 < frames.length ? frames[i + 1].t - f.t : 0.5).toFixed(4)}`).join("\n") + `\nfile '${OUT}/f${String(frames.length - 1).padStart(5, "0")}.jpg'\n`;
writeFileSync(`${OUT}/list.txt`, list);
console.log("frames", frames.length, "seconds", (frames.at(-1).t - frames[0].t).toFixed(1));
s.close(); process.exit(0);
