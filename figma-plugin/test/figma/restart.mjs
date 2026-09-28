/** Close Ferry's panel (if open) and run it again, fresh. */
import { connectBrowser, evaluate, sleep } from "./cdp.mjs";
import { press, typeText } from "./keys.mjs";
const [prefix] = process.argv.slice(2);
const cdp = await connectBrowser();
const page = (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.targetId.startsWith(prefix));
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const contexts = [];
cdp.on((m) => { if (m.sessionId === sessionId && m.method === "Runtime.executionContextCreated") contexts.push(m.params.context); });
await cdp.send("Runtime.enable", {}, sessionId);
await sleep(500);
for (const c of contexts) {
  try { await evaluate(cdp, sessionId, "document.getElementById('cd2f-close') ? (document.getElementById('cd2f-close').click(), true) : false", { contextId: c.id, timeout: 2000 }); } catch {}
}
await sleep(1500);
// Figma's own popups ("New tools, woven right in") steal the keyboard.
  await evaluate(cdp, sessionId, "Array.from(document.querySelectorAll('button[aria-label=Close], button[aria-label=close]')).filter(b => b.closest('[role=dialog], [class*=popover], [class*=onboarding], [class*=modal]')).forEach(b => b.click()); document.querySelector('canvas')?.focus(); true");
  await press(cdp, sessionId, "Escape");
await press(cdp, sessionId, "Slash", 4);
await sleep(900);
await typeText(cdp, sessionId, "Ferry");
await sleep(1500);
const at = await evaluate(cdp, sessionId, `(() => { const c = Array.from(document.querySelectorAll("*")).filter(e => e.children.length < 6 && /^Ferry\\s*Development$/.test((e.innerText||"").trim().replace(/\\s+/g," "))); const el = c[c.length-1]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height/2 }; })()`);
for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }, sessionId);
await sleep(4000);
console.log("restarted");
cdp.close();
