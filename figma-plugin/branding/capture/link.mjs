import { spawn, execFileSync } from "node:child_process";
execFileSync("open", ["-a", "Figma"]);
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { open, sleep } from "./scene.mjs";
const HOME = mkdtempSync(join(tmpdir(), "ferry-shot-"));
process.env.FERRY_HOME = HOME;
const LINK = new URL("../../../ferry-link/", import.meta.url).pathname;
const inbox = await import(`${LINK}lib/inbox.mjs`);
const { zip } = await import(`${LINK}lib/zip.mjs`);
const server = spawn("node", ["-e", `import(${JSON.stringify(`${LINK}server.mjs`)}).then((m) => { m.startHttp(); setInterval(() => {}, 1 << 30); })`], { env: process.env, stdio: "ignore" });
process.on("exit", () => { try { server.kill(); } catch {} });
process.on("uncaughtException", (e) => { console.error(e); try { server.kill(); } catch {} process.exit(1); });
await new Promise((r) => setTimeout(r, 1200));
const s = await open("EFA84508");
await s.emulate(1600, 900, 2);
let ui = await s.findPanel(); if (ui) { await s.run("document.getElementById('cd2f-close')?.click(), true").catch(() => {}); await sleep(1500); }
ui = null; for (let i = 0; i < 3 && !ui; i++) ui = await s.launch();
for (let i = 0; i < 20; i++) { await sleep(700); await s.findPanel(); try { if (await s.run(`!!document.getElementById("cd2f-claude")`)) break; } catch {} }
await s.run(`(() => { for (const el of document.querySelectorAll("*")) if (el.childElementCount === 0 && /^build \\d{4}-/.test((el.textContent||"").trim())) el.style.display = "none"; return 1; })()`);
let text = "";
for (let i = 0; i < 40; i++) { try { text = await s.run(`document.getElementById("cd2f-claude")?.innerText || ""`); } catch { await s.findPanel(); } if (/pair Ferry \d{4}-\d{4}/.test(text)) break; if (i % 6 === 5) await s.findPanel(); await sleep(500); }
const code = /pair Ferry (\d{4}-\d{4})/.exec(text)?.[1];
console.log("code", code);
await s.shot("/tmp/fig/L-pair.png");
inbox.pair(code);
const files = []; const root = new URL("./demo/Tidepool", import.meta.url).pathname;
for (const f of readdirSync(root)) files.push({ path: f, bytes: readFileSync(join(root, f)) });
inbox.put("Tidepool", zip(files), { page: "Tidepool Landing.dc.html" });
for (let i = 0; i < 90; i++) { text = await s.run(`document.getElementById("cd2f-claude").innerText`); if (/Tidepool/.test(text)) break; await sleep(500); }
console.log(text);
await s.move(160, 700); await sleep(1500);
await s.shot("/tmp/fig/L-item.png");
s.close(); server.kill(); process.exit(0);
