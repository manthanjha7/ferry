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
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";

const CASES = {
  stress: { mode: "none", expectOff: ["Marquee", "Spinner"] },
  portfolio: { mode: "build", frame: "theme=light", scheme: "light" },
  "portfolio-v1": { mode: "none" },
  motion: { mode: "none" },
  clock: { mode: "none" },
  "theme-root": { mode: "build" },
  awadh: { mode: "none" },
  control: { mode: "none" },
  icons: { mode: "none" },
  "anim-mini": { mode: "none", anim: true },
  "anim-real": { mode: "none", anim: true, local: true },
};
const [prefix, ...only] = process.argv.slice(2);
// `local` cases are private exports kept out of the repo; run them by name,
// or all of them when their zip is on this machine.
const names = only.length ? only : Object.keys(CASES).filter((n) => !CASES[n].local || existsSync(`/tmp/bench/cases/${n}.zip`));
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
    if (c.anim) {
      // One frame per scene, each against the engine seeked to its second.
      const tree = `${dir}/tree.json`;
      sh("node", ["reference-anim.mjs", zip, tree, dir]);
      const per = [];
      for (let i = 1; existsSync(`${dir}/reference-${i}.png`); i++) {
        mkdirSync(`${dir}/scene-${i}`, { recursive: true });
        const cmp = JSON.parse(sh("python3", ["compare.py", `${dir}/reference-${i}.png`, `${dir}/frame-${i}.png`, `${dir}/scene-${i}`]));
        per.push(cmp.mismatch);
      }
      row.mismatch = Math.max(...per);
      row.elements = `${per.length} scenes, mismatch ${per.map((m) => (m * 100).toFixed(1) + "%").join(" / ")}`;
      rows.push(row);
      console.log(JSON.stringify(row));
      continue;
    }
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
    row.quality = `layers ${q.layers}, auto-layout ${q.auto_layout_frames}/${q.frames}, generic ${q.generic_names}, bound ${q.bound_fills}/${q.fills}, empty ${q.empty_frames}, invisible ${q.invisible}, components ${q.components}/${q.instances}`;
  } catch (e) {
    row.error = String(e.message).split("\n").slice(0, 3).join(" | ").slice(0, 300);
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync("/tmp/bench/summary.json", JSON.stringify(rows, null, 1));
