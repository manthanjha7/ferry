import { writeFileSync } from "node:fs";
import { connectBrowser } from "./cdp.mjs";
const [prefix, out] = process.argv.slice(2);
const cdp = await connectBrowser();
const page = (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.targetId.startsWith(prefix));
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
writeFileSync(out, Buffer.from(data, "base64"));
cdp.close();
