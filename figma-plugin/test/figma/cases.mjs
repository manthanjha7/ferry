/**
 * Put the suite's case zips where suite.mjs reads them (/tmp/bench/cases).
 *
 *   node cases.mjs
 *
 * The zips live in test/fixture/real/bench-cases/, which is gitignored: most
 * are real Claude Design exports, and each carries Claude Design's own
 * support.js runtime. Copy the folder across machines by hand.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";

const from = new URL("../fixture/real/bench-cases/", import.meta.url);
const to = "/tmp/bench/cases";
if (!existsSync(from)) {
  console.error(`No ${from.pathname}: the case zips are local only.`);
  process.exit(1);
}
mkdirSync(to, { recursive: true });
const zips = readdirSync(from).filter((f) => f.endsWith(".zip"));
for (const zip of zips) copyFileSync(new URL(zip, from), `${to}/${zip}`);
console.log(`${zips.length} cases in ${to}`);
