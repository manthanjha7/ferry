/**
 * Run Ferry's extractor inside Figma's own plugin window, to reproduce what
 * only happens there (null origin, Figma's fonts, Figma's CSP).
 *
 *   node in-figma.mjs <tab-prefix> <page.html> [moduleSource.js ...]
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { connectBrowser, evaluate, sleep } from "./cdp.mjs";
const [prefix, htmlPath, ...mods] = process.argv.slice(2);
const cdp = await connectBrowser();
const page = (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.targetId.startsWith(prefix));
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const contexts = [];
const logs = [];
cdp.on((m) => {
  if (m.sessionId !== sessionId) return;
  if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
  if (m.method === "Runtime.consoleAPICalled") logs.push(`${Math.round(m.params.timestamp)} ` + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  if (m.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
});
await cdp.send("Runtime.enable", {}, sessionId);
await sleep(500);
let ui;
for (const c of contexts) {
  try { if (await evaluate(cdp, sessionId, "!!document.getElementById('cd2f-import')", { contextId: c.id, timeout: 2000 })) ui = c.id; } catch {}
}
const bundle = readFileSync(new URL("../fixture/bundle.js", import.meta.url), "utf8");
// The panel's own measuring frame when the self-test build exposes it, so this
// measures exactly where an import does; otherwise the test bundle, in the
// panel's own (quirks-mode) page.
const realm = await evaluate(cdp, sessionId, `!!window.__ferryRealm`, { contextId: ui });
if (realm) await evaluate(cdp, sessionId, `window.__ferryRealm.resetExtractor(); window.extractDocument = (...a) => window.__ferryRealm.extractor(1440).extractDocument(...a); true`, { contextId: ui });
else await evaluate(cdp, sessionId, `window.extractDocument ? true : (${JSON.stringify(bundle)}, (0, eval)(${JSON.stringify(bundle)}), true)`, { contextId: ui, timeout: 60000 });
const sources = {};
for (const m of mods) { const t = readFileSync(m, "utf8"); sources[basename(m)] = t; sources["./" + basename(m)] = t; }
const html = readFileSync(htmlPath, "utf8");
await evaluate(cdp, sessionId, `window.__CD2F_DEBUG = true; true`, { contextId: ui });
const t0 = Date.now();
await evaluate(cdp, sessionId, `window.__run = window.extractDocument(${JSON.stringify(html)}, "probe", { viewportWidth: 1440, moduleSources: ${JSON.stringify(sources)} }).then(d => window.__out = d, e => window.__out = { error: String(e && e.stack || e) }); true`, { contextId: ui });
let out;
for (let i = 0; i < 1000; i++) {
  out = await evaluate(cdp, sessionId, `window.__out ? JSON.stringify({ missing: window.__out.missingStylesheets, head: (function f(n){ if (n && n.kind === 'TEXT' && n.text.characters.startsWith('Manthan Jha.')) return [n.width, n.height, n.text.singleLine]; for (const c of (n && n.children) || []) { const r = f(c); if (r) return r; } return null; })(window.__out.root), fonts: Array.from(document.fonts).filter(f => /Instrument|Schibsted/.test(f.family)).map(f => f.family + ':' + f.status).slice(0, 6), stats: window.__clockStats, error: window.__out.error, dyn: window.__out.dynamicContent, warnings: window.__out.warnings, nodes: (function c(n){ return n ? 1 + (n.children||[]).reduce((a,x)=>a+c(x),0) : 0; })(window.__out.root) }) : ""`, { contextId: ui });
  if (out) break;
  await sleep(200);
}
if (process.env.IR_OUT) {
  const full = await evaluate(cdp, sessionId, "JSON.stringify(window.__out)", { contextId: ui });
  (await import("node:fs")).writeFileSync(process.env.IR_OUT, full);
}
await evaluate(cdp, sessionId, "window.__out = null; true", { contextId: ui });
console.log(`took ${Date.now() - t0}ms`, (out || "(no result)").slice(0, 300));
const i = logs.map((l) => /\[cd2f\] mounting/.test(l)).lastIndexOf(true);
console.log(logs.slice(Math.max(0, i)).filter((l) => /cd2f|EXCEPTION|error/i.test(l) && !/walking </.test(l)).filter((l) => !process.env.GREP || l.includes(process.env.GREP)).slice(0, 80).join("\n"));
cdp.close();
