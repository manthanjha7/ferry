import { connectBrowser, evaluate, sleep } from "./cdp.mjs";
/** Click a file tab in Figma desktop's tab bar by its exact label. */
const label = process.argv[2];
const cdp = await connectBrowser();
const shell = (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.url.includes("shell.html"));
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: shell.targetId, flatten: true });
const ok = await evaluate(cdp, sessionId, `(() => { const b = Array.from(document.querySelectorAll("button.file_tab--fileTabButton--SoY23, button[class*=fileTabButton]")).find(b => b.getAttribute("aria-label") === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
console.log("clicked", ok);
await sleep(3000);
cdp.close();
