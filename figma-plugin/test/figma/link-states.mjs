/**
 * The Ferry panel's "From Claude" area in real Figma, state by state.
 *
 *   node link-states.mjs <figma-tab-prefix>
 *
 * Runs its own Ferry Link against a throwaway home (FERRY_HOME), so the
 * user's real pairing and inbox are not touched.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectBrowser, evaluate, sleep } from "./cdp.mjs";

const [prefix] = process.argv.slice(2);
const HOME = mkdtempSync(join(tmpdir(), "ferry-states-"));
process.env.FERRY_HOME = HOME;
const LINK = new URL("../../../ferry-link/", import.meta.url).pathname;
const inbox = await import(`${LINK}lib/inbox.mjs`);
const { zip } = await import(`${LINK}lib/zip.mjs`);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` :: ${detail}`}`);
};

const page = async () => {
  const cdp = await connectBrowser();
  const target = (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.targetId.startsWith(prefix));
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const contexts = [];
  cdp.on((m) => {
    if (m.sessionId === sessionId && m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
  });
  await cdp.send("Runtime.enable", {}, sessionId);
  await sleep(500);
  let ui = null;
  for (const c of contexts.reverse()) {
    try {
      if (await evaluate(cdp, sessionId, "!!document.getElementById('cd2f-import')", { contextId: c.id, timeout: 2000 })) {
        ui = c.id;
        break;
      }
    } catch {}
  }
  return { cdp, run: (expr) => evaluate(cdp, sessionId, expr, { contextId: ui, timeout: 20000 }) };
};
const openPanel = () => execFileSync("node", [new URL("./run-plugin.mjs", import.meta.url).pathname, prefix, "Ferry"], { stdio: "ignore" });
const box = (p) => p.run(`document.getElementById("cd2f-claude").hidden ? "(hidden)" : document.getElementById("cd2f-claude").innerText`);
async function until(p, test, ms, what) {
  // Figma in front, as it is when a user is looking at the panel.
  execFileSync("open", ["-a", "Figma"]);
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    last = await box(p);
    if (test(last)) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}; panel says: ${last}`);
}
const html = (title) => Buffer.from(`<!DOCTYPE html><html><body style="margin:0"><h1 style="font:600 40px sans-serif">${title}</h1></body></html>`);

// No Ferry Link running on the port.
try {
  execFileSync("pkill", ["-f", "ferry-link/server.mjs|import\\(\"./server.mjs\"\\)"]);
} catch {}
await sleep(500);
execFileSync("open", ["-a", "Figma"]);
openPanel();
let p = await page();
let text = await until(p, (t) => t !== "(hidden)", 20000, "the From Claude area");
check("with no Ferry Link, the panel says how to install it", /plugin marketplace add manthanjha7\/ferry/.test(text), text);

// Ferry Link starts: the panel asks to be paired.
const server = spawn("node", ["-e", `import(${JSON.stringify(`${LINK}server.mjs`)}).then((m) => { m.startHttp(); setInterval(() => {}, 1 << 30); })`], { env: process.env, stdio: "ignore" });
try {
  text = await until(p, (t) => /pair Ferry \d{4}-\d{4}/.test(t), 20000, "the pairing code");
  const code = /pair Ferry (\d{4}-\d{4})/.exec(text)[1];
  check("when Ferry Link starts, the panel shows its pairing code", !!code, text);

  // The code survives closing and reopening the panel.
  p.cdp.close();
  openPanel();
  p = await page();
  text = await until(p, (t) => /pair Ferry \d{4}-\d{4}/.test(t), 20000, "the pairing code after reopening");
  check("the pairing code is the same after reopening Ferry", text.includes(code), text);

  inbox.pair(code);
  text = await until(p, (t) => /Waiting for a design/.test(t), 20000, "the waiting state");
  check("once paired, the panel waits for a design", true);

  // Two designs: newest first, both clickable.
  const older = inbox.put("Older design", zip([{ path: "Older.html", bytes: html("Older") }]));
  await sleep(1100);
  const newer = inbox.put("Newer design", zip([{ path: "A.html", bytes: html("Page A") }, { path: "B.html", bytes: html("Page B") }]), { page: "does-not-exist.html" });
  text = await until(p, (t) => /Newer design/.test(t) && /Older design/.test(t), 20000, "both designs");
  check("two designs are listed, newest first", text.indexOf("Newer design") < text.indexOf("Older design"), text);

  // Another panel took the older one a moment ago.
  inbox.remove(older.id);
  await p.run(`document.querySelector('[data-link-id="${older.id}"]')?.click(), true`);
  await sleep(1500);
  const status = await p.run(`document.getElementById("cd2f-status").innerText`);
  check("a design that already left the inbox says so, instead of failing silently", /no longer in Ferry Link's inbox/.test(status) || !(await box(p)).includes("Older design"), status);

  // A page hint that names no page: the whole project is offered.
  await p.run(`document.querySelector('[data-link-id="${newer.id}"]').click(), true`);
  await sleep(2500);
  const picked = await p.run(`JSON.stringify({ value: document.getElementById("cd2f-page").value, options: document.getElementById("cd2f-page").options.length, enabled: !document.getElementById("cd2f-import").disabled })`);
  const pick = JSON.parse(picked);
  check("a page hint that matches nothing leaves every page selected, and Import ready", pick.value === "all" && pick.enabled, picked);
  check("an opened design leaves the inbox", inbox.list().every((i) => i.id !== newer.id));

  // A page hint that matches: only that page.
  const hinted = inbox.put("Hinted design", zip([{ path: "A.html", bytes: html("Page A") }, { path: "B.html", bytes: html("Page B") }]), { page: "B.html" });
  await until(p, (t) => /Hinted design/.test(t), 20000, "the hinted design");
  await p.run(`document.querySelector('[data-link-id="${hinted.id}"]').click(), true`);
  await sleep(2500);
  const one = await p.run(`(() => { const s = document.getElementById("cd2f-page"); return s.options[s.selectedIndex]?.text || s.value; })()`);
  check("a page hint that matches selects that page", /B/.test(one), one);

  // Sent while Figma is behind another app: it shows as soon as Figma is back.
  execFileSync("open", ["-a", "Finder"]);
  await sleep(4000);
  const behind = inbox.put("Sent while away", zip([{ path: "Away.html", bytes: html("Away") }]));
  await sleep(4000);
  execFileSync("open", ["-a", "Figma"]);
  const t0 = Date.now();
  let seen = false;
  while (Date.now() - t0 < 6000 && !seen) {
    seen = /Sent while away/.test(await p.run(`document.getElementById("cd2f-claude").innerText`));
    if (!seen) await sleep(250);
  }
  check("a design sent while Figma was in the background shows within seconds of switching back", seen, `${Date.now() - t0}ms`);
  inbox.remove(behind.id);
} catch (error) {
  check("the run completed", false, error.message);
} finally {
  server.kill();
}

// Ferry Link goes away while the panel is open.
try {
  text = await until(p, (t) => /plugin marketplace add/.test(t), 25000, "the not-installed state");
  check("when Ferry Link stops, the panel goes back to the install hint", true);
} catch (error) {
  check("when Ferry Link stops, the panel goes back to the install hint", false, error.message);
}
p.cdp.close();
console.log(`\nLINK STATES ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
