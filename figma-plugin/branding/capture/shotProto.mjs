import { open, sleep } from "./scene.mjs";
const s = await open("EFA84508");
await s.emulate(1600, 900, 2);
let ui = await s.findPanel(); for (let i = 0; i < 3 && !ui; i++) ui = await s.launch();
await sleep(1200); await s.findPanel(); await s.listen();
console.log(JSON.stringify(await s.sandbox(`const area = figma.currentPage.children.find(n => /theme=light · components/.test(n.name)); const set = area.children.find(k => k.type === "COMPONENT_SET" && k.name === "Button" && k.width < 400); const def = set.children[0]; figma.currentPage.selection = [def]; const b = set.absoluteBoundingBox; figma.viewport.zoom = 1.45; figma.viewport.center = { x: b.x + b.width/2 + 120, y: b.y + b.height/2 + 175 }; return [set.name, set.children.map(c=>c.name), def.reactions.length];`)));
await s.run("document.getElementById('cd2f-close')?.click(), true").catch(() => {});
await sleep(1500);
const tab = await s.page(`(() => { const el = Array.from(document.querySelectorAll("*")).find(e => e.childElementCount === 0 && (e.textContent||"").trim() === "Prototype" && e.getBoundingClientRect().left > 1300); const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
await s.click(tab.x, tab.y); await sleep(1500);
for (let i = 0; i < 3; i++) { const x = await s.page(`(() => { const hs = Array.from(document.querySelectorAll("*")).filter(e => e.childElementCount === 0 && /^(Removing a connection|Running your prototype)$/.test((e.textContent||"").trim())); if (!hs.length) return null; const row = hs[0].parentElement; const btn = row.querySelector("button") || row.parentElement.querySelector("button"); const r = btn.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`); if (!x) break; await s.click(x.x, x.y); await sleep(600); }
await s.move(160, 700); await sleep(1500);
await s.shot(process.argv[2]);
s.close(); process.exit(0);
