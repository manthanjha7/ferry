/**
 * Every case through real Figma and a real browser, scored.
 *
 *   node suite.mjs <figma-tab-prefix> [case ...]
 *
 * Per case: import in Figma (bench.mjs), render the reference (reference.mjs),
 * then pixel mismatch (compare.py), per-element boxes (boxes.py) and the
 * designer-quality report (quality.py). Writes /tmp/bench/<case>/ and a
 * summary table.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";

const CASES = {
  stress: { mode: "none", expectOff: ["Marquee", "Spinner"] },
  portfolio: { mode: "build", frame: "theme=light", scheme: "light" },
  "portfolio-v1": { mode: "none" },
  motion: { mode: "none" },
  clock: { mode: "none" },
  "theme-root": { mode: "build" },
  awadh: { mode: "none" },
  control: { mode: "none" },
};
const [prefix, ...only] = process.argv.slice(2);
const names = only.length ? only : Object.keys(CASES);
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const rows = [];
for (const name of names) {
  const c = CASES[name];
  const dir = `/tmp/bench/${name}`;
  const zip = `/tmp/bench/cases/${name}.zip`;
  const row = { name };
  try {
    const bench = JSON.parse(sh("node", ["bench.mjs", prefix, zip, c.mode, dir]).trim().split("\n").pop());
    row.took = bench.took;
    row.frames = bench.frames?.length ?? 0;
    const frames = readdirSync(dir).filter((f) => /^frame-\d+\.png$/.test(f)).sort();
    let pick = frames[0];
    if (c.frame) {
      const i = bench.frames.findIndex((f) => f.includes(c.frame));
      if (i >= 0) pick = `frame-${i + 1}.png`;
    }
    copyFileSync(`${dir}/${pick}`, `${dir}/figma.png`);
    sh("node", ["reference.mjs", zip, `${dir}/reference.png`, "1440", c.scheme ?? "light"]);
    const cmp = JSON.parse(sh("python3", ["compare.py", `${dir}/reference.png`, `${dir}/figma.png`, dir]));
    row.mismatch = cmp.mismatch;
    row.size = `${cmp.ref.join("x")} vs ${cmp.figma.join("x")}`;
    const boxes = sh("python3", ["boxes.py", `${dir}/reference.boxes.json`, `${dir}/tree.json`]).trim().split("\n");
    const off = boxes.filter((l) => l.startsWith("OFF") || l.startsWith("MISSING"));
    const unexpected = off.filter((l) => !(c.expectOff ?? []).some((n) => l.includes(` ${n} `) || l.endsWith(` ${n}`)));
    row.elements = boxes.pop();
    row.unexpected = unexpected.length;
    writeFileSync(`${dir}/boxes.txt`, boxes.join("\n"));
    const q = JSON.parse(sh("python3", ["quality.py", `${dir}/tree.json`]));
    writeFileSync(`${dir}/quality.json`, JSON.stringify(q, null, 1));
    row.quality = `layers ${q.layers}, auto-layout ${q.auto_layout_frames}/${q.frames}, generic ${q.generic_names}, bound ${q.bound_fills}/${q.fills}, empty ${q.empty_frames}, invisible ${q.invisible}`;
  } catch (e) {
    row.error = String(e.message).split("\n").slice(0, 3).join(" | ").slice(0, 300);
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync("/tmp/bench/summary.json", JSON.stringify(rows, null, 1));
