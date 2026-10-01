import { open, sleep } from "./scene.mjs";
const s = await open("EFA84508");
await s.emulate(1600, 900, 2);
let ui = await s.findPanel(); for (let i = 0; i < 3 && !ui; i++) ui = await s.launch();
for (let i = 0; i < 20; i++) { await sleep(500); await s.findPanel(); try { if (await s.run(`!!document.getElementById("cd2f-claude")`)) break; } catch {} }
await s.listen();
console.log(JSON.stringify(await s.sandbox(`const L = figma.currentPage.children.find(n => /theme=light$/.test(n.name)); const card = L.findOne(n => n.name === "Booking card"); figma.currentPage.selection = [card]; const b = card.absoluteBoundingBox; figma.viewport.zoom = 1.0; figma.viewport.center = { x: b.x + b.width/2 - 60, y: b.y + b.height/2 }; return [card.type, card.layoutMode, card.itemSpacing, card.paddingTop, card.width, card.height, JSON.stringify(card.boundVariables).slice(0,200)];`)));
await s.run("document.getElementById('cd2f-close')?.click(), true").catch(() => {});
await sleep(1200);
await s.click(1394, 60); await sleep(1500);
await s.move(160, 860); await sleep(4500);
await s.shot(process.argv[2]);
s.close(); process.exit(0);
