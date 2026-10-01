import { open, sleep } from "./scene.mjs";
const s = await open("EFA84508");
await s.emulate(1600, 900, 2);
if (await s.findPanel()) { await s.run("document.getElementById('cd2f-close')?.click(), true").catch(() => {}); await sleep(1500); }
let ui = null; for (let i = 0; i < 3 && !ui; i++) ui = await s.launch();
await sleep(1500); await s.findPanel(); await s.listen();
await s.sandbox(`for (const n of [...figma.currentPage.children]) n.remove(); for (const c of await figma.variables.getLocalVariableCollectionsAsync()) c.remove(); return 1;`);
await sleep(800);
await s.drop("/tmp/ferry-capture/tidepool.zip", "Tidepool Landing.zip");
await s.until(`(() => { const b = document.getElementById("cd2f-import"); return !!b && !b.disabled; })()`, 30000);
await s.run(`(() => { const radios = Array.from(document.querySelectorAll("#cd2f-token-mode input[type=radio]")); const r = radios.find(r => (r.closest("label")?.innerText||"").toLowerCase().startsWith("build")); r.click(); r.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
await sleep(400);
await s.run(`document.getElementById("cd2f-import").click(), true`);
await s.until(`window.__imports.length > 0`, 120000);
await sleep(1200);
console.log(await s.sandbox(`const fr = figma.currentPage.children.filter(n => n.type==="FRAME" && !n.getPluginData("ferry.role")); const L = fr.find(f=>/light/.test(f.name)), D = fr.find(f=>/dark/.test(f.name)); L.x=0; L.y=0; D.x=0; D.y=1001; const comps = figma.currentPage.children.filter(n => n.getPluginData("ferry.role")==="components"); comps.forEach((c,i)=>{ c.x = 1640; c.y = i*1001; }); figma.currentPage.selection=[L]; figma.viewport.zoom=0.4; figma.viewport.center={x: 720+(825-600)/0.4, y: 950}; return [(await figma.variables.getLocalVariableCollectionsAsync()).map(c=>c.name), comps.map(c=>c.name+" "+c.width+"x"+c.height)];`));
await s.move(160, 640); await sleep(2500);
await s.shot("/tmp/fig/A-hero.png");
s.close(); process.exit(0);
