/**
 * End-to-end test runner: captured IR -> the REAL src/plugin/build.ts ->
 * mock Figma API -> assertions on the resulting node tree.
 *
 * This is deliberately not a unit test. It imports `buildDocument` exactly
 * as `src/plugin/main.ts` does, points the ambient `figma` global at
 * `createFigmaMock()` (test/e2e/figma-mock.ts), and feeds it IR that was
 * actually produced by the browser extractor (test/e2e/captured/*.json,
 * see test/e2e/README.md). Nothing in src/ is touched or stubbed.
 *
 * Run with (from figma-plugin/):
 *   npx esbuild test/e2e/run.ts --bundle --outfile=test/e2e/run.mjs --format=esm --platform=node --target=node18
 *   node test/e2e/run.mjs
 *
 * `figma.currentPage`/`figma.variables`/etc. are read by build.ts/mapping.ts/
 * fonts.ts at *call* time, not at module-import time (they're bare
 * references to the ambient global inside function bodies), so re-pointing
 * `globalThis.figma` at a fresh mock between scenarios is enough to isolate
 * them — no need to re-import the module per scenario.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  IRColor,
  IRDesignSystem,
  IRDocument,
  IRNode,
  IRTokenDefinition,
  VariableTarget,
} from "../../src/ir";
import {
  addFlowStartingPoint,
  buildDocument,
  buildDocuments,
  IMPORT_GAP,
  layoutBatch,
} from "../../src/plugin/build";
// The UI's own ingest rules, which decide what a drop contains and what each
// screen is called (scenario L). Pure functions, no DOM, so they run here.
import {
  BATCH_LIMIT,
  batchColumns,
  buildScreens,
  defaultSelection,
  screenHint,
  selectedScreens,
} from "../../src/ui/screens";
// The other half of the same story: what the panel decides to do with the
// export's design tokens (scenario M).
import {
  buildStatusLine,
  createOverflowNote,
  defaultTokenMode,
  dsSystemName,
  extraCssFor,
  tokenModeAvailability,
  tokenTarget,
  type TokenMode,
  type TokenModeFacts,
} from "../../src/ui/token-mode";
// And the third: which prop combinations one document imports as (scenario N).
import {
  defaultStateSelection,
  previewFrameSize,
  propCombinations,
  selectAxes,
  stateAxes,
  stateFlow,
  stateFrameName,
  stateHint,
  type PropCombination,
} from "../../src/ui/states";
import { createFigmaMock, type MockOptions } from "./figma-mock";
import { markComponents } from "../../src/ui/components";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURED_DIR = join(HERE, "captured");
const FIXTURE_PATH = join(CAPTURED_DIR, "fixture-screen.json");
const ORPHAN_PATH = join(CAPTURED_DIR, "orphaned-screen.json");
const WAIT_BUDGET_MS = 120_000;

// ---------------------------------------------------------------------------
// Reporting (mirrors test/fixture/harness.html's PASS/FAIL format)
// ---------------------------------------------------------------------------

type ResultStatus = "PASS" | "FAIL" | "SKIP";
const results: Array<{ name: string; status: ResultStatus }> = [];

function check(name: string, cond: boolean, detail?: string): void {
  const ok = !!cond;
  results.push({ name, status: ok ? "PASS" : "FAIL" });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

function skip(name: string, reason?: string): void {
  results.push({ name, status: "SKIP" });
  console.log(`SKIP — ${name}${reason ? ` (${reason})` : ""}`);
}

function report(): void {
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  const total = passed + failed;

  console.log("");
  if (skipped > 0) {
    console.log(`(${skipped} assertion(s) skipped — captured IR was not available for them)`);
  }
  console.log(`E2E ${passed}/${total} passed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until every path exists or the budget runs out. Returns the ones still missing. */
async function waitForFiles(paths: string[], maxMs: number): Promise<Set<string>> {
  const start = Date.now();
  const missing = new Set(paths);
  for (const p of paths) if (existsSync(p)) missing.delete(p);

  while (missing.size > 0 && Date.now() - start < maxMs) {
    await sleep(1000);
    for (const p of [...missing]) if (existsSync(p)) missing.delete(p);
  }
  return missing;
}

/**
 * Loads a captured IRDocument from disk, reviving `{"__u8":[...]}` (the
 * JSON-safe encoding harness.html uses for IMAGE nodes' Uint8Array bytes,
 * see test/e2e/README.md) back into real Uint8Arrays.
 */
function loadCaptured(path: string): IRDocument {
  const raw = readFileSync(path, "utf-8");
  const revived = JSON.parse(raw, (_key, value) => {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray((value as { __u8?: unknown }).__u8) &&
      Object.keys(value).length === 1
    ) {
      return new Uint8Array((value as { __u8: number[] }).__u8);
    }
    return value;
  });
  return revived as IRDocument;
}

/** Fresh mock, installed as the ambient `figma` global. One per scenario. */
function freshMock(opts?: MockOptions) {
  const mock = createFigmaMock(opts);
  (globalThis as { figma?: unknown }).figma = mock.figma;
  return mock;
}

let pluginOnMessage: ((message: any) => Promise<void>) | null = null;

/**
 * `src/plugin/main.ts`'s own message handler, so `runImport` is exercised
 * rather than a copy of it.
 *
 * Cached because the module registers `figma.ui.onmessage` at import time and an
 * ES module is only ever evaluated once per process: a second scenario calling
 * `import()` gets the cached module back and its own mock's `onmessage` stays
 * undefined. The handler reads the ambient `figma` inside its body, so pointing
 * the global at a fresh mock before each call is what isolates scenarios.
 */
async function pluginMessageHandler(): Promise<(message: any) => Promise<void>> {
  if (pluginOnMessage) return pluginOnMessage;
  // The module calls figma.showUI() at top level, so it needs both a mock and
  // the __html__ global that esbuild would normally inject.
  (globalThis as { __html__?: string }).__html__ = "<!-- e2e -->";
  const bootMock = freshMock();
  await import("../../src/plugin/main");
  pluginOnMessage = bootMock.figma.ui.onmessage as (message: any) => Promise<void>;
  return pluginOnMessage;
}

// ---------------------------------------------------------------------------
// Tree-walking helpers (operate on mock.serializeTree() output, i.e. plain
// JSON, not on live node instances)
// ---------------------------------------------------------------------------

/** FRAME nodes whose fills carry a `boundVariables.color` entry. */
function collectFrameColorBindings(node: any, out: any[] = []): any[] {
  if (node.type === "FRAME") {
    for (const fill of node.fills ?? []) {
      if (fill?.boundVariables?.color) out.push(node);
    }
  }
  for (const child of node.children ?? []) collectFrameColorBindings(child, out);
  return out;
}

/** Every bound-variable reference anywhere in the tree (node-level or paint-level). */
function collectAllBoundVariables(node: any, out: Array<{ node: string; kind: string }> = []): typeof out {
  if (node.boundVariables && Object.keys(node.boundVariables).length > 0) {
    out.push({ node: node.name, kind: "node" });
  }
  for (const fill of node.fills ?? []) {
    if (fill?.boundVariables && Object.keys(fill.boundVariables).length > 0) {
      out.push({ node: node.name, kind: "fill" });
    }
  }
  for (const stroke of node.strokes ?? []) {
    if (stroke?.boundVariables && Object.keys(stroke.boundVariables).length > 0) {
      out.push({ node: node.name, kind: "stroke" });
    }
  }
  for (const child of node.children ?? []) collectAllBoundVariables(child, out);
  return out;
}

/** {name, fontName} for every TEXT node in a serialized tree. */
function collectTextFontNames(node: any, out: Array<{ name: string; fontName: any }> = []): typeof out {
  if (node.type === "TEXT") out.push({ name: node.name, fontName: node.fontName });
  for (const child of node.children ?? []) collectTextFontNames(child, out);
  return out;
}

/**
 * `characters` for every TEXT node in a serialized (built) tree, in the same
 * traversal order build.ts itself uses: only FRAME nodes recurse into their
 * children (buildText/buildImage/buildVector never touch `node.children`,
 * mirroring `buildNode`'s switch in src/plugin/build.ts).
 */
function walkBuiltTextCharacters(node: any, out: string[] = []): string[] {
  if (node.type === "TEXT") {
    out.push(node.characters ?? "");
    return out;
  }
  for (const child of node.children ?? []) walkBuiltTextCharacters(child, out);
  return out;
}

/** Same traversal, but over the raw IR tree (pre-build), collecting requested characters. */
function walkIRTextCharacters(node: IRNode, out: string[] = []): string[] {
  if (node.kind === "TEXT") {
    if (node.text) out.push(node.text.characters);
    return out;
  }
  for (const child of node.children) walkIRTextCharacters(child, out);
  return out;
}

/** Mirrors build.ts's own collectFontRequests (not exported, so reimplemented identically). */
function collectFontRequests(node: IRNode, out: string[] = []): string[] {
  if (node.text) {
    for (const run of node.text.runs) out.push(run.fontFamily);
  }
  for (const child of node.children) collectFontRequests(child, out);
  return out;
}

/** IR TEXT nodes (with their runs), in the same traversal order build.ts visits them (mirrors walkIRTextCharacters). */
function walkIRTextNodes(node: IRNode, out: IRNode[] = []): IRNode[] {
  if (node.kind === "TEXT") {
    if (node.text) out.push(node);
    return out;
  }
  for (const child of node.children) walkIRTextNodes(child, out);
  return out;
}

/**
 * {name, characters, fontName, charFonts} for every TEXT node in a serialized
 * (built) tree, in the same traversal order as walkBuiltTextCharacters.
 * `charFonts` is the per-character resolved font added to figma-mock.ts's
 * serializeTree() — `fontName` alone only ever reflects the first run.
 */
function collectBuiltTextDetails(
  node: any,
  out: Array<{ name: string; characters: string; fontName: any; charFonts: any[] }> = [],
): typeof out {
  if (node.type === "TEXT") {
    out.push({
      name: node.name,
      characters: node.characters ?? "",
      fontName: node.fontName,
      charFonts: node.charFonts ?? [],
    });
    return out;
  }
  for (const child of node.children ?? []) collectBuiltTextDetails(child, out);
  return out;
}

/**
 * Mirrors src/plugin/fonts.ts's WEIGHT_NAMES table (not exported, so
 * reimplemented for assertion purposes — see collectFontRequests above for
 * the same pattern). Maps a Figma style name like "Semi Bold Italic" back to
 * the numeric weight it implies, so a test can tell "the substitution
 * collapsed everything to Regular" from "the substitution correctly picked
 * the nearest available weight."
 */
const STYLE_WEIGHT_TIERS: Array<{ weight: number; names: string[] }> = [
  { weight: 100, names: ["thin", "hairline"] },
  { weight: 200, names: ["extralight", "extra light", "ultralight"] },
  { weight: 300, names: ["light"] },
  { weight: 400, names: ["regular", "normal", "book"] },
  { weight: 500, names: ["medium"] },
  { weight: 600, names: ["semibold", "semi bold", "demibold"] },
  { weight: 700, names: ["bold"] },
  { weight: 800, names: ["extrabold", "extra bold", "ultrabold"] },
  { weight: 900, names: ["black", "heavy"] },
];

function impliedWeight(style: string): number {
  // Figma names an italic style either "<Weight> Italic" or, for Regular,
  // sometimes just "Italic" (see figma-mock.ts's DEFAULT_AVAILABLE_FONTS
  // comment) — strip the suffix either way before matching the weight word.
  const base = style
    .replace(/\bitalic\b/i, "")
    .trim()
    .toLowerCase();
  if (base === "") return 400;
  for (const tier of STYLE_WEIGHT_TIERS) {
    if (tier.names.includes(base)) return tier.weight;
  }
  return 400; // unrecognized style name; treat conservatively as Regular
}

function boundVariablesSummary(node: any): string {
  const parts: string[] = [];
  const nodeKeys = Object.keys(node.boundVariables ?? {});
  if (nodeKeys.length) parts.push(`node:${nodeKeys.join(",")}`);
  for (const fill of node.fills ?? []) {
    const keys = Object.keys(fill?.boundVariables ?? {});
    if (keys.length) parts.push(`fill:${keys.join(",")}`);
  }
  for (const stroke of node.strokes ?? []) {
    const keys = Object.keys(stroke?.boundVariables ?? {});
    if (keys.length) parts.push(`stroke:${keys.join(",")}`);
  }
  return parts.length ? ` {${parts.join("; ")}}` : "";
}

function printOutline(node: any, depth = 0): void {
  const indent = "  ".repeat(depth);
  const wh = `${Math.round(node.width)}x${Math.round(node.height)}`;
  const layout =
    node.type === "FRAME"
      ? ` layout=${node.layoutMode}${node.layoutMode !== "NONE" ? ` itemSpacing=${node.itemSpacing}` : ""}`
      : "";
  console.log(`${indent}${node.type} "${node.name}" ${wh}${layout}${boundVariablesSummary(node)}`);
  for (const child of node.children ?? []) printOutline(child, depth + 1);
}

// ---------------------------------------------------------------------------
// Scenario A — create new collection
// ---------------------------------------------------------------------------

async function scenarioA(ready: boolean): Promise<{ tree: any } | null> {
  const p = "A (create new collection):";
  const names = [
    `${p} buildDocument resolves without throwing`,
    `${p} a root FrameNode exists on the page`,
    `${p} node count > 15`,
    `${p} variables were created`,
    `${p} at least one frame has a fill with boundVariables.color`,
    `${p} root got appended to currentPage`,
    `${p} undoCommits is 0 (build itself must not commit)`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return null;
  }

  const mock = freshMock();
  const doc = loadCaptured(FIXTURE_PATH);
  const target: VariableTarget = { kind: "create", name: "Test tokens" };

  let result;
  try {
    result = await buildDocument(doc, target, () => {});
    check(names[0], true);
  } catch (err) {
    check(names[0], false, String((err as Error)?.message ?? err));
    for (let i = 1; i < names.length; i++) check(names[i], false, "build threw, cannot evaluate");
    return null;
  }

  const roots = mock.getRootNodes();
  check(names[1], roots.length >= 1 && roots[0].type === "FRAME", `roots=${roots.length} type=${roots[0]?.type}`);
  check(names[2], result.nodeCount > 15, `nodeCount=${result.nodeCount}`);
  check(
    names[3],
    result.mapping.created > 0 && mock.getVariables().length > 0,
    `mapping.created=${result.mapping.created} totalVariables=${mock.getVariables().length}`,
  );

  const tree = mock.serializeTree(result.root);
  const boundFrames = collectFrameColorBindings(tree);
  check(names[4], boundFrames.length > 0, `frames-with-bound-color-fill=${boundFrames.length}`);

  check(names[5], roots.includes(result.root), `getRootNodes() includes result.root: ${roots.includes(result.root)}`);
  check(names[6], mock.undoCommits === 0, `undoCommits=${mock.undoCommits}`);

  return { tree };
}

// ---------------------------------------------------------------------------
// Scenario B — map onto existing local collection
// ---------------------------------------------------------------------------

async function scenarioB(ready: boolean): Promise<void> {
  const p = "B (map onto existing local collection):";
  const names = [
    `${p} buildDocument resolves without throwing`,
    `${p} at least one token bound by name (boundByName > 0)`,
    `${p} the value-collision path is exercised (boundByValue > 0)`,
    `${p} no new variable created for an already-existing name`,
    `${p} the targeted collection is never written into`,
    `${p} unmatched tokens land in their own collection`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  const mock = freshMock();

  // Pre-create a local "House System" collection the way a real designer's
  // file would already have one, seeded with variables chosen to collide
  // with the incoming design-system tokens two different ways.
  const houseSystem = mock.figma.variables.createVariableCollection("House System");
  const modeId = houseSystem.defaultModeId;

  // 1) Collides BY NAME with the "acme-green-700" token (fixture path
  //    "color/acme-green/700"). Given a deliberately WRONG value (black)
  //    to prove name-match wins regardless of stored value.
  const byNameVar = mock.figma.variables.createVariable("color/acme-green/700", houseSystem, "COLOR");
  byNameVar.setValueForMode(modeId, { r: 0, g: 0, b: 0, a: 1 });

  // 2) Collides only BY VALUE: named so it can never name-match anything,
  //    holding exactly #1B6F58 — the fixture's "acme-green-700"/"primary"
  //    color (0x1B/255, 0x6F/255, 0x58/255).
  const byValueVar = mock.figma.variables.createVariable("brand/base", houseSystem, "COLOR");
  byValueVar.setValueForMode(modeId, {
    r: 0.10588235294117647,
    g: 0.43529411764705883,
    b: 0.34509803921568627,
    a: 1,
  });

  // NOTE: intentionally NOT also pre-creating a "color/primary" name
  // collider. In this fixture "primary" is `var(--acme-green-700)`, i.e.
  // identical value to acme-green-700 — resolveToken() in mapping.ts
  // always tries a name match before a value match, so if BOTH tokens that
  // carry #1B6F58 were claimed by name, brand/base's value match would be
  // unreachable and boundByValue would stay 0 no matter what. Leaving
  // "primary" unclaimed by name is what makes it fall through to the
  // value-match branch against brand/base — that's the path this
  // sub-scenario exists to prove works.

  const collectionsBefore = mock.getCollections().filter((c) => !c.remote).length;
  const targetVarsBefore = mock
    .getVariables()
    .filter((v) => v.variableCollectionId === houseSystem.id).length;

  const doc = loadCaptured(FIXTURE_PATH);
  const target: VariableTarget = { kind: "local", collectionId: houseSystem.id, createMissing: true };

  let result;
  try {
    result = await buildDocument(doc, target, () => {});
    check(names[0], true);
  } catch (err) {
    check(names[0], false, String((err as Error)?.message ?? err));
    for (let i = 1; i < names.length; i++) check(names[i], false, "build threw, cannot evaluate");
    return;
  }

  check(names[1], result.mapping.boundByName > 0, `boundByName=${result.mapping.boundByName}`);
  check(names[2], result.mapping.boundByValue > 0, `boundByValue=${result.mapping.boundByValue}`);

  const finalVars = mock.getVariables();
  const nameCounts = new Map<string, number>();
  for (const v of finalVars) nameCounts.set(v.name, (nameCounts.get(v.name) ?? 0) + 1);
  const dupes = [...nameCounts.entries()].filter(([, n]) => n > 1);
  check(names[3], dupes.length === 0, `duplicate names=${JSON.stringify(dupes)}`);

  // The user picked this collection as a SOURCE to match against. Adding to it
  // would be editing their design system, not importing into the file. A real
  // Figma run put 299 variables into the user's own collection before this was
  // fixed, so the count staying put is the assertion that matters most here.
  const targetVarsAfter = mock
    .getVariables()
    .filter((v) => v.variableCollectionId === houseSystem.id).length;
  check(
    names[4],
    targetVarsAfter === targetVarsBefore,
    `target collection had ${targetVarsBefore} variables, now ${targetVarsAfter}`,
  );

  const collectionsAfter = mock.getCollections().filter((c) => !c.remote).length;
  check(
    names[5],
    result.mapping.created > 0 && collectionsAfter === collectionsBefore + 1,
    `created=${result.mapping.created}, collections ${collectionsBefore} -> ${collectionsAfter}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario B2 — single-line text must not be given a wrapping box
// ---------------------------------------------------------------------------

async function scenarioB2(ready: boolean): Promise<void> {
  const p = "B2 (single-line text):";
  const names = [
    `${p} every single-line text node is built WIDTH_AND_HEIGHT`,
    `${p} multi-line text keeps its measured width (HEIGHT)`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  const mock = freshMock();
  const doc = loadCaptured(FIXTURE_PATH);
  await buildDocument(doc, { kind: "none" }, () => {});

  // Walk the IR and the built tree together by name, since the fixture has
  // both single-line labels and a genuinely wrapped paragraph.
  const built: any[] = [];
  const collect = (n: any) => {
    built.push(n);
    for (const c of n.children ?? []) collect(c);
  };
  for (const root of mock.getRootNodes()) collect(mock.serializeTree(root));

  const irText: any[] = [];
  const walkIr = (n: any) => {
    if (n.kind === "TEXT") irText.push(n);
    for (const c of n.children ?? []) walkIr(c);
  };
  walkIr(doc.root);

  const byName = new Map<string, any>();
  for (const n of built) if (n.type === "TEXT") byName.set(n.name, n);

  const singles = irText.filter((t) => t.text?.singleLine);
  const wrapped = irText.filter((t) => t.text && !t.text.singleLine);

  const badSingle = singles
    .map((t) => byName.get(t.name))
    .filter((n) => n && n.textAutoResize !== "WIDTH_AND_HEIGHT");
  check(
    names[0],
    singles.length > 0 && badSingle.length === 0,
    `${singles.length} single-line nodes, ${badSingle.length} wrong`,
  );

  const badWrapped = wrapped
    .map((t) => byName.get(t.name))
    .filter((n) => n && n.textAutoResize !== "HEIGHT");
  check(
    names[1],
    badWrapped.length === 0,
    `${wrapped.length} wrapped nodes, ${badWrapped.length} wrong`,
  );
}

// ---------------------------------------------------------------------------
// Scenario C — no variables
// ---------------------------------------------------------------------------

async function scenarioC(ready: boolean): Promise<void> {
  const p = "C (no variables):";
  const names = [
    `${p} buildDocument resolves without throwing`,
    `${p} no variables created`,
    `${p} no node carries a bound variable (frame/rect fills, strokes, layout bindings)`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  const mock = freshMock();
  const doc = loadCaptured(FIXTURE_PATH);
  const target: VariableTarget = { kind: "none" };

  let result;
  try {
    result = await buildDocument(doc, target, () => {});
    check(names[0], true);
  } catch (err) {
    check(names[0], false, String((err as Error)?.message ?? err));
    for (let i = 1; i < names.length; i++) check(names[i], false, "build threw, cannot evaluate");
    return;
  }

  check(
    names[1],
    result.mapping.created === 0 && mock.getVariables().length === 0,
    `mapping.created=${result.mapping.created} totalVariables=${mock.getVariables().length}`,
  );

  const tree = mock.serializeTree(result.root);
  const bound = collectAllBoundVariables(tree);
  check(names[2], bound.length === 0, `bound-refs=${JSON.stringify(bound.slice(0, 5))}`);
}

// ---------------------------------------------------------------------------
// Scenario D — missing design system
// ---------------------------------------------------------------------------

async function scenarioD(ready: boolean): Promise<void> {
  const p = "D (missing design system):";
  const names = [
    `${p} buildDocument resolves without throwing`,
    `${p} produces a real tree (node count > 5)`,
    `${p} root appended to currentPage`,
    `${p} no design-system tokens were bound (nothing to bind)`,
    `${p} no variable collection created despite target kind:create`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/orphaned-screen.json not found");
    return;
  }

  const mock = freshMock();
  const doc = loadCaptured(ORPHAN_PATH);
  const target: VariableTarget = { kind: "create", name: "X" };

  let result;
  try {
    result = await buildDocument(doc, target, () => {});
    check(names[0], true);
  } catch (err) {
    check(names[0], false, String((err as Error)?.message ?? err));
    for (let i = 1; i < names.length; i++) check(names[i], false, "build threw, cannot evaluate");
    return;
  }

  check(names[1], result.nodeCount > 5, `nodeCount=${result.nodeCount}`);

  const roots = mock.getRootNodes();
  check(names[2], roots.includes(result.root), `getRootNodes() includes result.root: ${roots.includes(result.root)}`);

  check(
    names[3],
    result.mapping.boundByName === 0 && result.mapping.boundByValue === 0,
    `mapping=${JSON.stringify(result.mapping)}`,
  );

  // resolveVariables() short-circuits to emptyRegistry() before prepareCreation()
  // ever runs when doc.designSystem is missing, even for target.kind === "create" —
  // so no collection should exist at all, not even an empty "X".
  check(
    names[4],
    mock.getCollections().length === 0,
    `collections=${JSON.stringify(mock.getCollections().map((c) => c.name))}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario E — font substitution
// ---------------------------------------------------------------------------

async function scenarioE(ready: boolean): Promise<void> {
  const p = "E (font substitution):";
  const names = [
    `${p} buildDocument resolves without throwing`,
    `${p} substitutions reported and mention every unavailable requested family`,
    `${p} every TEXT node's (first-run) fontName family is available in the mock`,
    `${p} every run's per-character resolved font family is available in the mock`,
    `${p} weight fidelity preserved (500/600/700 requests do not collapse to Regular)`,
    `${p} italic requests resolve to an italic style where the resolved family offers one`,
    `${p} TEXT node count matches between IR and built tree`,
    `${p} no TEXT node lost its characters`,
    `${p} a ui-* generic keyword lands where its plain generic lands`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  // Default mock fonts deliberately exclude DM Sans / Red Hat Display / Geist
  // Mono (see figma-mock.ts's DEFAULT_AVAILABLE_FONTS comment). The fixture
  // requests all three — Red Hat Display for the heading, DM Sans for body
  // copy and the button, Geist Mono for the uppercase "Reading key" label —
  // so this scenario is the one place src/plugin/fonts.ts's substitution path
  // actually runs end to end, not vacuously against an all-Inter fixture.
  const mock = freshMock();
  const doc = loadCaptured(FIXTURE_PATH);
  const target: VariableTarget = { kind: "none" };

  let result;
  try {
    result = await buildDocument(doc, target, () => {});
    check(names[0], true);
  } catch (err) {
    check(names[0], false, String((err as Error)?.message ?? err));
    for (let i = 1; i < names.length; i++) check(names[i], false, "build threw, cannot evaluate");
    return;
  }

  const available = await mock.figma.listAvailableFontsAsync();
  const availableFamilies = new Set(available.map((f: any) => String(f.fontName.family).toLowerCase()));
  const familyStyles = new Map<string, Set<string>>();
  for (const f of available) {
    const key = String(f.fontName.family).toLowerCase();
    if (!familyStyles.has(key)) familyStyles.set(key, new Set());
    familyStyles.get(key)!.add(String(f.fontName.style));
  }

  // --- substitutions reported for every family the mock doesn't have -------
  const requestedFamilies = new Set(collectFontRequests(doc.root).map((f) => f.toLowerCase()));
  const unavailableFamilies = [...requestedFamilies].filter((f) => !availableFamilies.has(f));
  check(
    names[1],
    unavailableFamilies.length > 0 &&
      unavailableFamilies.every((fam) => result.substitutions.some((s) => s.toLowerCase().includes(fam))),
    `unavailable=${JSON.stringify(unavailableFamilies)} substitutions=${JSON.stringify(result.substitutions)}`,
  );

  // --- node-level (first-run) fontName sanity check -------------------------
  const tree = mock.serializeTree(result.root);
  const textFonts = collectTextFontNames(tree);
  const notAvailable = textFonts.filter((t) => !availableFamilies.has(String(t.fontName?.family).toLowerCase()));
  check(names[2], textFonts.length > 0 && notAvailable.length === 0, `unavailable=${JSON.stringify(notAvailable)}`);

  // --- per-run fidelity: family availability, weight, italic ---------------
  const irTextNodes = walkIRTextNodes(doc.root);
  const builtTextDetails = collectBuiltTextDetails(tree);

  const familyIssues: string[] = [];
  const weightIssues: string[] = [];
  const italicIssues: string[] = [];

  for (let i = 0; i < irTextNodes.length; i++) {
    const irNode = irTextNodes[i];
    const built = builtTextDetails[i];
    if (!irNode.text || !built) continue;

    for (const run of irNode.text.runs) {
      const start = Math.max(0, Math.min(run.start, irNode.text.characters.length));
      const end = Math.max(start, Math.min(run.end, irNode.text.characters.length));
      if (end <= start) continue;

      // setRangeFontName() (build.ts's applyRun) writes the same resolved
      // font uniformly across [start, end), so the first character in range
      // reflects the whole run.
      const charFont = built.charFonts[start];
      const label = `"${built.name}" run[${start},${end}) requested ${run.fontFamily}/${run.fontWeight}${run.italic ? "/italic" : ""}`;

      if (!charFont) {
        familyIssues.push(`${label}: no per-character font recorded at index ${start}`);
        continue;
      }
      if (!availableFamilies.has(String(charFont.family).toLowerCase())) {
        familyIssues.push(`${label}: resolved to unavailable family "${charFont.family}"`);
      }
      if (run.fontWeight >= 500 && impliedWeight(charFont.style) === 400) {
        weightIssues.push(`${label}: collapsed to Regular-tier style "${charFont.style}"`);
      }
      if (run.italic) {
        const resolvedFamilyStyles = familyStyles.get(String(charFont.family).toLowerCase()) ?? new Set<string>();
        const familyHasItalic = [...resolvedFamilyStyles].some((s) => s.toLowerCase().includes("italic"));
        if (familyHasItalic && !String(charFont.style).toLowerCase().includes("italic")) {
          italicIssues.push(`${label}: family "${charFont.family}" has an italic style but resolved to "${charFont.style}"`);
        }
      }
    }
  }

  check(names[3], familyIssues.length === 0, JSON.stringify(familyIssues.slice(0, 5)));
  check(names[4], weightIssues.length === 0, JSON.stringify(weightIssues.slice(0, 5)));
  check(names[5], italicIssues.length === 0, JSON.stringify(italicIssues.slice(0, 5)));

  // --- characters survive the round-trip ------------------------------------
  const irChars = walkIRTextCharacters(doc.root);
  const builtChars = walkBuiltTextCharacters(tree);
  check(names[6], irChars.length === builtChars.length, `ir=${irChars.length} built=${builtChars.length}`);

  const mismatchIdx = irChars.findIndex((c, i) => c.length > 0 && builtChars[i] !== c);
  check(
    names[7],
    mismatchIdx === -1,
    mismatchIdx >= 0
      ? `index ${mismatchIdx}: ir="${irChars[mismatchIdx].slice(0, 40)}" built="${(builtChars[mismatchIdx] ?? "").slice(0, 40)}"`
      : "",
  );

  // --- the ui-* keywords ----------------------------------------------------
  // `primaryFamily` (src/ui/extract.ts) keeps the first entry of a font stack
  // and drops the rest, so the trailing generic never reaches the resolver: the
  // real Portage export asks for
  // `ui-monospace, 'Geist Mono', SFMono-Regular, Menlo, monospace` and only
  // "ui-monospace" arrives. No Figma file has a face by that name, so all 30 of
  // those runs were substituted with Inter, a proportional face, while
  // "monospace" beside it in the same declaration resolves to Roboto Mono.
  //
  // Asserted as a pair rather than against a hardcoded family, so the two
  // cannot drift apart when the fallback lists change. The font list is spelled
  // out here because the default mock has no serif at all, and a file where
  // serif and sans both land on Inter cannot tell a working `ui-serif` from a
  // missing one.
  const keywordMock = freshMock({
    availableFonts: [
      { family: "Inter", style: "Regular" },
      { family: "Roboto Mono", style: "Regular" },
      { family: "Georgia", style: "Regular" },
    ],
  });
  const keywordDoc = loadCaptured(FIXTURE_PATH);
  const KEYWORD_PAIRS: Array<[string, string]> = [
    ["ui-monospace", "monospace"],
    ["ui-sans-serif", "sans-serif"],
    ["ui-serif", "serif"],
    ["ui-rounded", "sans-serif"],
    ["system-ui", "sans-serif"],
  ];
  // De-duplicated: three of the keywords pair with "sans-serif", and the node
  // name is the lookup key.
  const keywordFamilies = [...new Set(KEYWORD_PAIRS.flat())];
  keywordDoc.root = {
    ...keywordDoc.root,
    children: keywordFamilies.map((family, index) => keywordTextNode(family, index)),
  };
  await buildDocument(keywordDoc, { kind: "none" }, () => {});
  const keywordTree = keywordMock.serializeTree(keywordMock.getRootNodes()[0]);
  const resolvedFor = new Map(
    collectTextFontNames(keywordTree).map((t) => [t.name, String(t.fontName?.family)]),
  );
  const keywordMismatches = KEYWORD_PAIRS.filter(
    ([keyword, generic]) => resolvedFor.get(keyword) !== resolvedFor.get(generic),
  ).map(([keyword, generic]) =>
    `${keyword} -> ${resolvedFor.get(keyword)} but ${generic} -> ${resolvedFor.get(generic)}`,
  );
  check(
    names[8],
    resolvedFor.size === keywordFamilies.length &&
      keywordMismatches.length === 0 &&
      // Proves the pairing is not vacuous: three distinct faces are reachable,
      // so "everything landed on Inter" cannot pass this.
      new Set([
        resolvedFor.get("ui-monospace"),
        resolvedFor.get("ui-serif"),
        resolvedFor.get("ui-sans-serif"),
      ]).size === 3,
    keywordMismatches.length > 0
      ? JSON.stringify(keywordMismatches)
      : JSON.stringify([...resolvedFor.entries()]),
  );
}

/** One TEXT node asking for exactly one font family, named after that family. */
function keywordTextNode(family: string, index: number): IRNode {
  return {
    kind: "TEXT",
    name: family,
    x: 0,
    y: index * 24,
    width: 300,
    height: 20,
    opacity: 1,
    rotation: 0,
    clips: false,
    fills: [],
    cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    effects: [],
    children: [],
    text: {
      characters: "0123456789",
      align: "LEFT",
      verticalAlign: "TOP",
      autoResize: "NONE",
      runs: [
        {
          start: 0,
          end: 10,
          fontFamily: family,
          fontWeight: 400,
          italic: false,
          fontSize: 16,
          lineHeight: null,
          letterSpacing: 0,
          fill: { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } },
          decoration: "NONE",
          textCase: "ORIGINAL",
        },
      ],
    },
  } as unknown as IRNode;
}

// ---------------------------------------------------------------------------
// Scenario F — progress + yielding
// ---------------------------------------------------------------------------

async function scenarioF(ready: boolean): Promise<void> {
  const p = "F (progress + yielding):";
  const names = [
    `${p} buildDocument resolves without throwing`,
    `${p} onProgress called at least once`,
    `${p} final progress total > 0`,
    `${p} final progress done <= total`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  freshMock();
  const doc = loadCaptured(FIXTURE_PATH);
  const target: VariableTarget = { kind: "none" };

  const progress: Array<{ done: number; total: number; label: string }> = [];
  try {
    await buildDocument(doc, target, (done, total, label) => progress.push({ done, total, label }));
    check(names[0], true);
  } catch (err) {
    check(names[0], false, String((err as Error)?.message ?? err));
    for (let i = 1; i < names.length; i++) check(names[i], false, "build threw, cannot evaluate");
    return;
  }

  check(names[1], progress.length >= 1, `calls=${progress.length}`);
  const last = progress[progress.length - 1];
  check(names[2], !!last && last.total > 0, JSON.stringify(last));
  check(names[3], !!last && last.done <= last.total, JSON.stringify(last));
}

// ---------------------------------------------------------------------------
// Scenario G — batch build path
// ---------------------------------------------------------------------------

/**
 * A fresh, independently mutable copy of the fixture, renamed.
 *
 * Seeded with an extraction warning because the fixture itself produces none,
 * and a batch attributes warnings to the document they came from while a
 * one-document import must not. Without a warning to carry, both halves of that
 * rule are unobservable.
 */
function batchDoc(name: string): IRDocument {
  const doc = loadCaptured(FIXTURE_PATH);
  doc.name = name;
  doc.warnings = [...doc.warnings, "seeded extraction warning"];
  return doc;
}

/**
 * The fixture with one nested frame's width replaced by NaN.
 *
 * `buildFrame` guards zero with `Math.max(node.width, 0.01)`, which passes NaN
 * straight through to `resize()`, and Figma rejects a non-positive size. This
 * is the shape a document mangled in transit actually takes, and it throws deep
 * enough in the walk that a real partial tree exists at the moment it fails.
 */
function unbuildableDoc(name: string): IRDocument {
  const doc = batchDoc(name);
  const victim = doc.root.children.find((child) => child.kind === "FRAME" || child.children.length > 0);
  if (victim) (victim as { width: number }).width = Number.NaN;
  else (doc.root as { width: number }).width = Number.NaN;
  return doc;
}

/** An 800x400 frame at the origin, standing in for content already in the file. */
function seedExistingFrame(mock: ReturnType<typeof freshMock>): void {
  const existing = mock.figma.createFrame();
  existing.name = "Already here";
  existing.resize(800, 400);
  mock.figma.currentPage.appendChild(existing);
  existing.x = 0;
  existing.y = 0;
}

/**
 * The batch is the plugin's only multi-frame mechanism (see `Placement` in
 * src/ir/index.ts), so the assertions that earn their keep are the ones that
 * would still fail if the batch quietly stopped behaving like the
 * single-document import it replaced: identical geometry at N=1, one origin for
 * the whole batch rather than one per document, and one registry report rather
 * than N of them summed.
 */
async function scenarioG(ready: boolean): Promise<void> {
  const p = "G (batch build path):";
  const names = [
    `${p} a one-document batch lands exactly where buildDocument put it`,
    `${p} a one-document batch reports the same counts as buildDocument`,
    `${p} buildDocument still appends to the page when place is false`,
    `${p} two documents produce two frames, with warnings attributed by name`,
    `${p} columns:2 puts the second frame one gap to the right of the first`,
    `${p} five documents wrap at ceil(sqrt(5)) = 3 columns`,
    `${p} a wrapped row clears the tallest frame of the row above it`,
    `${p} the batch origin is computed once, not per document`,
    `${p} a batch resolves its design system once and reports it once`,
    `${p} one unbuildable document does not take the batch down with it`,
    `${p} runImport commits exactly one undo for a three-document batch`,
    `${p} runImport reports import-failed when every document fails`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  const target: VariableTarget = { kind: "create", name: "Batch tokens" };

  // --- N=1 must be byte-for-byte the old single-document import -------------
  // The batch path replaced `placeBesideExistingContent` with
  // `batchOrigin` + `layoutBatch`. Both seed the page identically so the two
  // paths are compared on the one thing that could silently drift: where the
  // frame ends up, and what the caller is told about it.
  const singleMock = freshMock();
  seedExistingFrame(singleMock);
  const singleResult = await buildDocument(batchDoc("Solo"), target, () => {});
  const singleVars = singleMock.getVariables().length;

  const batchOfOneMock = freshMock();
  seedExistingFrame(batchOfOneMock);
  const batchOfOne = await buildDocuments([batchDoc("Solo")], target, {}, () => {});

  const soloFrame = batchOfOne.roots[0];
  check(
    names[0],
    !!soloFrame && soloFrame.x === singleResult.root.x && soloFrame.y === singleResult.root.y,
    `buildDocument (${singleResult.root.x}, ${singleResult.root.y}) vs buildDocuments (${soloFrame?.x}, ${soloFrame?.y})`,
  );
  check(
    names[1],
    batchOfOne.nodeCount === singleResult.nodeCount &&
      batchOfOne.mapping.created === singleResult.mapping.created &&
      JSON.stringify(batchOfOne.warnings) === JSON.stringify(singleResult.warnings) &&
      JSON.stringify(batchOfOne.substitutions) === JSON.stringify(singleResult.substitutions) &&
      batchOfOne.perDocument.length === 1 &&
      batchOfOneMock.undoCommits === 0,
    `nodes ${singleResult.nodeCount}/${batchOfOne.nodeCount}, created ` +
      `${singleResult.mapping.created}/${batchOfOne.mapping.created}, warnings ` +
      `${singleResult.warnings.length}/${batchOfOne.warnings.length}, undoCommits=${batchOfOneMock.undoCommits}`,
  );

  // --- appendChild is unconditional, only the position is optional ----------
  // Scenario A asserts a root reaches the page on the default path. This is the
  // same assertion for the path the batch actually uses: a frame that never
  // gets appended is not an import, however well it is laid out afterwards.
  const placeMock = freshMock();
  const unplaced = await buildDocument(batchDoc("Unplaced"), { kind: "none" }, () => {}, { place: false });
  check(
    names[2],
    placeMock.getRootNodes().includes(unplaced.root) && unplaced.root.x === 0,
    `onPage=${placeMock.getRootNodes().includes(unplaced.root)} x=${unplaced.root.x}`,
  );

  // --- two documents, two frames -------------------------------------------
  const pairMock = freshMock();
  const pair = await buildDocuments([batchDoc("First"), batchDoc("Second")], target, { columns: 2 }, () => {});
  const pageFrames = pairMock.getRootNodes();
  check(
    names[3],
    pair.roots.length === 2 &&
      pageFrames.length === 2 &&
      pair.roots.every((frame) => frame.parent === pairMock.figma.currentPage) &&
      pair.roots.map((frame) => frame.name).join("|") === "First|Second" &&
      JSON.stringify(pair.warnings) ===
        JSON.stringify(["First: seeded extraction warning", "Second: seeded extraction warning"]),
    `roots=${pair.roots.length} onPage=${pageFrames.length} names=${pair.roots.map((f) => f.name).join("|")} ` +
      `warnings=${JSON.stringify(pair.warnings)}`,
  );
  check(
    names[4],
    pair.roots[1].x === pair.roots[0].x + pair.roots[0].width + IMPORT_GAP &&
      pair.roots[1].y === pair.roots[0].y,
    `first=(${pair.roots[0].x}, ${pair.roots[0].y}) w=${pair.roots[0].width} second=(${pair.roots[1].x}, ${pair.roots[1].y})`,
  );

  // --- default column count wraps ------------------------------------------
  freshMock();
  const five = await buildDocuments(
    [batchDoc("S1"), batchDoc("S2"), batchDoc("S3"), batchDoc("S4"), batchDoc("S5")],
    { kind: "none" },
    {},
    () => {},
  );
  const rowOneHeight = Math.max(...five.roots.slice(0, 3).map((frame) => frame.height));
  check(
    names[5],
    five.roots.length === 5 &&
      five.roots[3].x === five.roots[0].x &&
      five.roots[3].y === five.roots[0].y + rowOneHeight + IMPORT_GAP &&
      five.roots[2].y === five.roots[0].y,
    `x: ${five.roots.map((f) => f.x).join(",")} y: ${five.roots.map((f) => f.y).join(",")}`,
  );

  // --- ragged rows ----------------------------------------------------------
  // Screens differ in height, so a row has to advance by its own tallest frame.
  // Advancing by a constant, or by the first frame of the row, overlaps rows on
  // a real import and looks like nothing at all on a fixture where every
  // document is the same shape.
  const raggedFrames = [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 0, y: 0, width: 100, height: 500 },
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 0, y: 0, width: 100, height: 100 },
  ];
  layoutBatch(raggedFrames as any, { x: 40, y: 10 }, { columns: 2 });
  check(
    names[6],
    raggedFrames[2].y === 10 + 500 + IMPORT_GAP &&
      raggedFrames[2].x === 40 &&
      raggedFrames[1].y === 10,
    `row 2 at (${raggedFrames[2].x}, ${raggedFrames[2].y}), expected (40, ${10 + 500 + IMPORT_GAP})`,
  );

  // --- one origin for the whole batch ---------------------------------------
  // With a single column every frame shares the origin's x. If the origin were
  // recomputed per document, each frame would see the previous one as
  // pre-existing content and step to the right of it — which is invisible in a
  // multi-column layout because the grid steps right anyway.
  const originMock = freshMock();
  seedExistingFrame(originMock);
  const stacked = await buildDocuments(
    [batchDoc("Stack 1"), batchDoc("Stack 2"), batchDoc("Stack 3")],
    { kind: "none" },
    { columns: 1 },
    () => {},
  );
  check(
    names[7],
    stacked.roots.every((frame) => frame.x === 800 + IMPORT_GAP),
    `x positions=${stacked.roots.map((f) => f.x).join(",")}, expected all ${800 + IMPORT_GAP}`,
  );

  // --- one registry, one report --------------------------------------------
  // A shared registry hands every document the same MappingReport object, so
  // summing per-document mappings would report the same variables as new once
  // per document. Nothing throws when that happens; the summary just lies.
  // Counting the resolutions, not just their result. A second resolve against a
  // `kind:"create"` target reuses the collection by name and hands back the
  // variables that are already in it, so the file ends up looking exactly right
  // whether the registry was shared or not — only the count of resolutions
  // separates them. `prepareCreation` (src/plugin/mapping.ts) scans the local
  // collections exactly once per `resolveVariables`, and `buildCandidateIndex`
  // returns early for a create target without scanning, so this call count IS
  // the resolution count.
  const sharedMock = freshMock();
  let resolveCalls = 0;
  const realGetCollections = sharedMock.figma.variables.getLocalVariableCollectionsAsync;
  sharedMock.figma.variables.getLocalVariableCollectionsAsync = (...args: unknown[]) => {
    resolveCalls++;
    return realGetCollections.apply(sharedMock.figma.variables, args);
  };
  const shared = await buildDocuments([batchDoc("Twin A"), batchDoc("Twin B")], target, {}, () => {});
  check(
    names[8],
    singleResult.mapping.created > 0 &&
      resolveCalls === 1 &&
      shared.mapping.created === singleResult.mapping.created &&
      sharedMock.getVariables().length === singleVars &&
      sharedMock.getCollections().filter((collection) => !collection.remote).length === 1,
    `resolutions=${resolveCalls} (expected 1), created ${singleResult.mapping.created} (single) vs ` +
      `${shared.mapping.created} (batch of 2), variables ${singleVars} vs ` +
      `${sharedMock.getVariables().length}, collections=${sharedMock.getCollections().length}`,
  );

  // --- a document that cannot be built --------------------------------------
  const partialMock = freshMock();
  const partial = await buildDocuments(
    [unbuildableDoc("Broken"), batchDoc("Fine")],
    { kind: "none" },
    {},
    () => {},
  );
  const brokenEntry = partial.perDocument[0];
  check(
    names[9],
    partial.roots.length === 1 &&
      partialMock.getRootNodes().length === 1 &&
      partial.perDocument.length === 2 &&
      brokenEntry.ok === false &&
      brokenEntry.name === "Broken" &&
      partial.perDocument[1].ok === true,
    `roots=${partial.roots.length} onPage=${partialMock.getRootNodes().length} ` +
      `perDocument=${JSON.stringify(partial.perDocument.map((entry) => [entry.name, entry.ok]))}`,
  );

  // --- runImport: one undo for the whole batch ------------------------------
  // Through src/plugin/main.ts's own message handler rather than a copy of it,
  // because the thing being asserted (one commitUndo, one selection, one
  // import-complete) lives in runImport and nowhere else.
  const onMessage = await pluginMessageHandler();

  const importMock = freshMock();
  await onMessage({
    type: "import",
    docs: [batchDoc("Batch 1"), batchDoc("Batch 2"), batchDoc("Batch 3")],
    target,
  });
  const complete = importMock.figma.ui.postedMessages.find((m: any) => m.type === "import-complete");
  check(
    names[10],
    importMock.undoCommits === 1 &&
      importMock.getRootNodes().length === 3 &&
      importMock.figma.currentPage.selection.length === 3 &&
      !!complete &&
      complete.frames === 3 &&
      complete.perDocument.length === 3 &&
      complete.reactions === 0 &&
      complete.flows === 0,
    `undoCommits=${importMock.undoCommits} frames=${complete?.frames} ` +
      `selection=${importMock.figma.currentPage.selection.length} perDocument=${complete?.perDocument?.length}`,
  );

  const allFailMock = freshMock();
  await onMessage({
    type: "import",
    docs: [unbuildableDoc("Bad 1"), unbuildableDoc("Bad 2")],
    target,
  });
  const failed = allFailMock.figma.ui.postedMessages.find((m: any) => m.type === "import-failed");
  check(
    names[11],
    !!failed &&
      !allFailMock.figma.ui.postedMessages.some((m: any) => m.type === "import-complete") &&
      allFailMock.getRootNodes().length === 0 &&
      allFailMock.undoCommits === 0,
    `posted=${JSON.stringify(allFailMock.figma.ui.postedMessages.map((m: any) => m.type))} ` +
      `onPage=${allFailMock.getRootNodes().length} undoCommits=${allFailMock.undoCommits}`,
  );
}

// ---------------------------------------------------------------------------
// Scenarios H-K — build a design system from the export (VariableTarget "build")
// ---------------------------------------------------------------------------

function hex(value: string): IRColor {
  const n = (i: number) => parseInt(value.slice(i, i + 2), 16) / 255;
  return { r: n(1), g: n(3), b: n(5), a: 1 };
}

/**
 * A design system shaped like a real Claude Design export's, small enough that
 * every expected number below is countable by hand.
 *
 * Written here rather than captured from the Portage export on disk: that
 * export carries a real company's design system and `test/fixture/real/` is
 * gitignored, so an assertion depending on it cannot run on a clean clone.
 * What it reproduces is the structure that makes mode (b) hard —
 *
 *   - a primitive ramp with a semantic layer aliasing onto it,
 *   - a semantic token that aliases a DIFFERENT primitive under one surface,
 *   - a base token one surface re-themes and the other does not,
 *   - a token declared only inside one surface (private, group-prefixed),
 *   - a token shared by two surfaces but absent from :root,
 *   - `path` and `buildPath` deliberately disagreeing on one token,
 *   - an `em` value that is a STRING to the classifier and a FLOAT to Figma,
 *   - a font stack, which is only emitted when asked for,
 *   - a shadow, which cannot be a variable at all.
 */
const DECK = ".deck";
const EMAIL = ".email";

function buildFixtureSystem(): IRDesignSystem {
  const token = (t: IRTokenDefinition): IRTokenDefinition => t;

  return {
    name: "Acme System",
    key: "AcmeSystem_3f2a9c",
    surfaces: [
      { selector: DECK, label: "Acme Deck" },
      { selector: EMAIL, label: "Acme Email" },
    ],
    tokens: [
      // Primitive re-themed by email only.
      token({
        name: "acme-green-500",
        path: "color/acme-green/500",
        buildPath: "color/acme-green/500",
        category: "color",
        kind: "COLOR",
        resolved: "#29AB87",
        color: hex("#29AB87"),
        declaredIn: ["", EMAIL],
        bySurface: { [EMAIL]: { resolved: "#1B6F58", color: hex("#1B6F58") } },
      }),
      token({
        name: "acme-green-700",
        path: "color/acme-green/700",
        buildPath: "color/acme-green/700",
        category: "color",
        kind: "COLOR",
        resolved: "#1B6F58",
        color: hex("#1B6F58"),
        declaredIn: [""],
      }),
      // `tokenPath`'s two-to-four-digit ramp floor strands a one-digit step, so
      // this is the token where `path` and `buildPath` must disagree.
      token({
        name: "neutral-0",
        path: "color/neutral-0",
        buildPath: "color/neutral/0",
        category: "color",
        kind: "COLOR",
        resolved: "#FFFFFF",
        color: hex("#FFFFFF"),
        declaredIn: [""],
      }),
      // Semantic, and it points somewhere else under the deck surface.
      token({
        name: "primary",
        path: "color/primary",
        buildPath: "color/primary",
        category: "color",
        kind: "COLOR",
        resolved: "#29AB87",
        color: hex("#29AB87"),
        aliasOf: "acme-green-500",
        declaredIn: ["", DECK],
        bySurface: {
          [DECK]: { resolved: "#1B6F58", color: hex("#1B6F58"), aliasOf: "acme-green-700" },
        },
      }),
      token({
        name: "space-4",
        path: "number/space-4",
        buildPath: "space/4",
        category: "spacing",
        kind: "FLOAT",
        resolved: "16px",
        float: 16,
        declaredIn: [""],
      }),
      token({
        name: "radius-md",
        path: "number/radius-md",
        buildPath: "radius/md",
        category: "radius",
        kind: "FLOAT",
        resolved: "12px",
        float: 12,
        declaredIn: ["", EMAIL],
        bySurface: { [EMAIL]: { resolved: "16px", float: 16 } },
      }),
      token({
        name: "tracking-tight",
        path: "string/tracking-tight",
        buildPath: "type/tracking/tight",
        category: "font",
        kind: "STRING",
        resolved: "-0.0125em",
        declaredIn: [""],
      }),
      token({
        name: "font-sans",
        path: "string/font-sans",
        buildPath: "type/family/sans",
        category: "font",
        kind: "STRING",
        resolved: '"Inter", "Inter Variable", ui-sans-serif',
        declaredIn: [""],
      }),
      // Deck-private: nothing in :root declares it, so it is group-prefixed and
      // holds the same value in every mode.
      token({
        name: "ink-500",
        path: "color/ink/500",
        buildPath: "deck/color/ink/500",
        category: "color",
        kind: "COLOR",
        resolved: "#333333",
        color: hex("#333333"),
        declaredIn: [DECK],
        bySurface: { [DECK]: { resolved: "#333333", color: hex("#333333") } },
      }),
      // Surface-shared: in both surfaces, in neither :root. Ungrouped, and the
      // base mode gets the first declaring surface's value.
      token({
        name: "paper",
        path: "color/paper",
        buildPath: "color/paper",
        category: "color",
        kind: "COLOR",
        resolved: "#FFFFFF",
        color: hex("#FFFFFF"),
        declaredIn: [DECK, EMAIL],
        bySurface: {
          [DECK]: { resolved: "#FFFFFF", color: hex("#FFFFFF") },
          [EMAIL]: { resolved: "#FAFAFA", color: hex("#FAFAFA") },
        },
      }),
    ],
    shadows: [
      {
        name: "shadow-md",
        buildPath: "shadow/md",
        scope: "",
        layers: [
          { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.1 }, offsetX: 0, offsetY: 10, blur: 15, spread: -3 },
          { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.06 }, offsetX: 0, offsetY: 4, blur: 6, spread: -4 },
        ],
      },
      {
        name: "shadow-md",
        buildPath: "deck/shadow/md",
        scope: DECK,
        layers: [
          { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.04 }, offsetX: 0, offsetY: 6, blur: 16, spread: -6 },
        ],
      },
    ],
  };
}

/** The fixture document, carrying the synthetic system instead of its own. */
function systemDoc(system: IRDesignSystem): IRDocument {
  const doc = loadCaptured(FIXTURE_PATH);
  doc.designSystem = system;
  return doc;
}

/** Variables in the one collection the build created, by name. */
function builtVariables(mock: ReturnType<typeof freshMock>) {
  const collection = mock.getCollections().find((c) => !c.remote);
  const variables = mock
    .getVariables()
    .filter((v) => v.variableCollectionId === collection?.id);
  return { collection, variables, byName: new Map(variables.map((v) => [v.name, v])) };
}

/** Distinct values a variable holds across its modes, aliases compared by target id. */
function distinctModeValues(variable: { valuesByMode: Record<string, any> }): number {
  return new Set(Object.values(variable.valuesByMode).map((v) => JSON.stringify(v))).size;
}

const BUILD_TARGET: VariableTarget = { kind: "build", name: "Acme System", modes: true };

async function scenarioH(ready: boolean): Promise<void> {
  const p = "H (build, single mode):";
  const names = [
    `${p} one collection, one mode, one variable per bindable token`,
    `${p} the collection is stamped with the system key`,
    `${p} buildPath groups the variable, path still binds it onto the canvas`,
    `${p} the semantic layer is a real alias onto the primitive, not a copy`,
    `${p} numeric variables are scoped to their own category`,
    `${p} an em tracking value becomes a FLOAT percentage, not a dropped STRING`,
    `${p} font stacks are emitted only when asked for, first family only`,
    `${p} shadow tokens become effect styles rather than being dropped`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  const system = buildFixtureSystem();
  const mock = freshMock();
  const result = await buildDocument(
    systemDoc(system),
    { kind: "build", name: "Acme System", modes: false },
    () => {},
  );

  const { collection, variables, byName } = builtVariables(mock);
  check(
    names[0],
    mock.getCollections().filter((c) => !c.remote).length === 1 &&
      collection?.modes.length === 1 &&
      variables.length === 9 &&
      result.mapping.created === 9 &&
      result.mapping.reused === 0,
    `collections=${mock.getCollections().length} modes=${collection?.modes.length} ` +
      `variables=${variables.length} created=${result.mapping.created} reused=${result.mapping.reused}`,
  );
  check(
    names[1],
    collection?.pluginData["ferry.systemKey"] === "AcmeSystem_3f2a9c",
    JSON.stringify(collection?.pluginData),
  );

  // The whole reason `buildPath` exists as a second field: the variable is
  // grouped under `color/neutral/0`, while everything that binds it on the
  // canvas still says `color/neutral-0`. Collapsing the two breaks one end or
  // the other, and neither end raises an error.
  const neutral = byName.get("color/neutral/0");
  const boundToNeutral = collectAllBoundVariables(mock.serializeTree(result.root));
  check(
    names[2],
    !!neutral &&
      !byName.has("color/neutral-0") &&
      system.tokens.find((t) => t.name === "neutral-0")?.path === "color/neutral-0" &&
      boundToNeutral.length > 0,
    `named=${[...byName.keys()].filter((n) => n.includes("neutral")).join(",")} bindings=${boundToNeutral.length}`,
  );

  const primary = byName.get("color/primary");
  const green500 = byName.get("color/acme-green/500");
  const primaryValue = primary ? Object.values(primary.valuesByMode)[0] : undefined;
  check(
    names[3],
    !!primaryValue &&
      typeof primaryValue === "object" &&
      (primaryValue as any).type === "VARIABLE_ALIAS" &&
      (primaryValue as any).id === green500?.id &&
      result.mapping.aliased === 1,
    `primary=${JSON.stringify(primaryValue)} green500=${green500?.id} aliased=${result.mapping.aliased}`,
  );

  // A radius and a spacing step are both FLOAT and routinely hold the same
  // number. Unscoped, Figma offers `space/4` in the corner-radius picker.
  check(
    names[4],
    JSON.stringify(byName.get("radius/md")?.scopes) === JSON.stringify(["CORNER_RADIUS"]) &&
      JSON.stringify(byName.get("space/4")?.scopes) === JSON.stringify(["GAP", "WIDTH_HEIGHT"]),
    `radius=${JSON.stringify(byName.get("radius/md")?.scopes)} space=${JSON.stringify(byName.get("space/4")?.scopes)}`,
  );

  const tracking = byName.get("type/tracking/tight");
  check(
    names[5],
    tracking?.resolvedType === "FLOAT" &&
      Object.values(tracking.valuesByMode)[0] === -1.25 &&
      JSON.stringify(tracking.scopes) === JSON.stringify(["LETTER_SPACING"]),
    `${tracking?.resolvedType} ${JSON.stringify(Object.values(tracking?.valuesByMode ?? {}))}`,
  );

  const stringsMock = freshMock();
  const withStrings = await buildDocument(
    systemDoc(buildFixtureSystem()),
    { kind: "build", name: "Acme System", modes: false, strings: true },
    () => {},
  );
  const stringVars = builtVariables(stringsMock).byName;
  const family = stringVars.get("type/family/sans");
  check(
    names[6],
    !byName.has("type/family/sans") &&
      family?.resolvedType === "STRING" &&
      Object.values(family.valuesByMode)[0] === "Inter" &&
      withStrings.mapping.created === 10,
    `default=${byName.has("type/family/sans")} strings=${JSON.stringify(Object.values(family?.valuesByMode ?? {}))} ` +
      `created=${withStrings.mapping.created}`,
  );

  const styles = mock.getEffectStyles();
  const base = styles.find((s) => s.name === "shadow/md");
  check(
    names[7],
    styles.length === 2 &&
      !!base &&
      base.effects.length === 2 &&
      base.effects[0].radius === 15 &&
      base.effects[0].spread === -3 &&
      base.effects[0].showShadowBehindNode === false &&
      styles.some((s) => s.name === "deck/shadow/md") &&
      result.mapping.effectStyles === 2,
    `styles=${JSON.stringify(styles.map((s) => s.name))} effects=${JSON.stringify(base?.effects[0])}`,
  );
}

async function scenarioI(ready: boolean): Promise<void> {
  const p = "I (build, one mode per surface):";
  const names = [
    `${p} three modes, named from the manifest, base renamed to Product`,
    `${p} every variable has a value in every mode`,
    `${p} exactly the re-themed tokens differ across modes`,
    `${p} a surface-private token is group-prefixed and constant across modes`,
    `${p} a surface-shared token takes each surface's own value`,
    `${p} the semantic layer aliases in every mode, not just the default`,
    `${p} no alias points outside the collection it was built in`,
    `${p} a base layer that is itself a named theme names the base mode after it`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  const mock = freshMock();
  const result = await buildDocument(systemDoc(buildFixtureSystem()), BUILD_TARGET, () => {});
  const { collection, variables, byName } = builtVariables(mock);

  const modeNames = collection?.modes.map((m) => m.name) ?? [];
  const modeIds = collection?.modes.map((m) => m.modeId) ?? [];
  const baseId = collection?.defaultModeId ?? "";
  const deckId = modeIds[1];
  const emailId = modeIds[2];

  check(
    names[0],
    JSON.stringify(modeNames) === JSON.stringify(["Product", "Acme Deck", "Acme Email"]) &&
      JSON.stringify(result.mapping.modes) === JSON.stringify(modeNames),
    `${JSON.stringify(modeNames)} report=${JSON.stringify(result.mapping.modes)}`,
  );

  // `addMode` is not documented to seed existing variables' values, and the
  // mock definitively does not. A variable defined in one mode and empty in the
  // other two looks completely normal until someone switches the mode.
  const holes = variables.filter((v) =>
    modeIds.some((id) => v.valuesByMode[id] === undefined),
  );
  check(
    names[1],
    variables.length === 9 && holes.length === 0,
    `variables=${variables.length} holes=${JSON.stringify(holes.map((v) => v.name))}`,
  );

  // The measured re-theme surface. Four of nine, and every one of them is a
  // token the fixture deliberately re-themes; if this number moves, the
  // per-mode value merge changed.
  const multi = variables.filter((v) => distinctModeValues(v) > 1).map((v) => v.name).sort();
  check(
    names[2],
    JSON.stringify(multi) ===
      JSON.stringify(["color/acme-green/500", "color/paper", "color/primary", "radius/md"]),
    JSON.stringify(multi),
  );

  const ink = byName.get("deck/color/ink/500");
  check(
    names[3],
    !!ink && !byName.has("color/ink/500") && distinctModeValues(ink) === 1,
    `named=${!!ink} distinct=${ink ? distinctModeValues(ink) : "n/a"}`,
  );

  const paper = byName.get("color/paper");
  const white = JSON.stringify({ r: 1, g: 1, b: 1, a: 1 });
  check(
    names[4],
    !!paper &&
      JSON.stringify(paper.valuesByMode[baseId]) === white &&
      JSON.stringify(paper.valuesByMode[deckId]) === white &&
      JSON.stringify(paper.valuesByMode[emailId]) !== white,
    `base=${JSON.stringify(paper?.valuesByMode[baseId])} deck=${JSON.stringify(paper?.valuesByMode[deckId])} ` +
      `email=${JSON.stringify(paper?.valuesByMode[emailId])}`,
  );

  // Today's alias pass sets exactly one mode. In a three-mode collection that
  // leaves Deck and Email sitting on the literal written a pass earlier —
  // visually plausible, structurally wrong, invisible without opening
  // valuesByMode. The deck value pointing at a DIFFERENT primitive is what
  // separates "aliased per mode" from "aliased once and copied".
  const primary = byName.get("color/primary");
  const alias = (modeId: string) => (primary?.valuesByMode[modeId] as any)?.id;
  check(
    names[5],
    alias(baseId) === byName.get("color/acme-green/500")?.id &&
      alias(deckId) === byName.get("color/acme-green/700")?.id &&
      alias(emailId) === byName.get("color/acme-green/500")?.id &&
      result.mapping.aliased === 3,
    `base=${alias(baseId)} deck=${alias(deckId)} email=${alias(emailId)} aliased=${result.mapping.aliased}`,
  );

  const byId = new Map(mock.getVariables().map((v) => [v.id, v]));
  const strays: string[] = [];
  for (const variable of variables) {
    for (const value of Object.values(variable.valuesByMode)) {
      if (!value || typeof value !== "object" || (value as any).type !== "VARIABLE_ALIAS") continue;
      const targetVariable = byId.get((value as any).id);
      if (!targetVariable || targetVariable.variableCollectionId !== variable.variableCollectionId) {
        strays.push(`${variable.name} -> ${(value as any).id}`);
      }
    }
  }
  check(names[6], strays.length === 0, JSON.stringify(strays));
  // `:root` beside `:root[data-theme="dark"]` is the light theme, and the
  // extractor says so in `baseModeLabel`. The generic name would put
  // "Product" and "Dark" side by side on a collection that has no product.
  const labelledMock = freshMock();
  const labelledSystem = { ...buildFixtureSystem(), baseModeLabel: "Light" };
  await buildDocument(systemDoc(labelledSystem), BUILD_TARGET, () => {});
  const labelledNames = builtVariables(labelledMock).collection?.modes.map((m) => m.name) ?? [];
  check(
    names[7],
    labelledNames[0] === "Light" && labelledNames.length === 3,
    JSON.stringify(labelledNames),
  );
}

async function scenarioJ(ready: boolean): Promise<void> {
  const p = "J (build, re-import):";
  const names = [
    `${p} a second import reuses every variable instead of creating one`,
    `${p} a renamed collection is still matched by its stamp`,
    `${p} a changed value is written in place, reported, and keeps the variable id`,
    `${p} an orphaned variable with no matching token is left alone`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  const mock = freshMock();
  await buildDocument(systemDoc(buildFixtureSystem()), BUILD_TARGET, () => {});
  const first = builtVariables(mock);

  // An orphan, i.e. a variable the designer added or one this export no longer
  // ships. Deleting it is destructive and the export may legitimately be a
  // subset of the system.
  const live = (await mock.figma.variables.getLocalVariableCollectionsAsync())[0];
  mock.figma.variables.createVariable("color/legacy", live, "COLOR");

  // Renaming is the normal outcome of mode (b): the collection becomes theirs.
  // Matching on name alone would then build a second copy of the same system.
  live.name = "Our tokens, renamed";

  const second = await buildDocument(systemDoc(buildFixtureSystem()), BUILD_TARGET, () => {});
  const after = builtVariables(mock);

  check(
    names[0],
    second.mapping.created === 0 && second.mapping.reused === 9,
    `created=${second.mapping.created} reused=${second.mapping.reused}`,
  );
  check(
    names[1],
    mock.getCollections().filter((c) => !c.remote).length === 1 &&
      after.collection?.id === first.collection?.id &&
      after.collection?.name === "Our tokens, renamed" &&
      after.variables.length === 10,
    `collections=${JSON.stringify(mock.getCollections().map((c) => c.name))} variables=${after.variables.length}`,
  );

  const edited = buildFixtureSystem();
  const green = edited.tokens.find((t) => t.name === "acme-green-700")!;
  green.resolved = "#0D4A3B";
  green.color = hex("#0D4A3B");

  const idBefore = after.byName.get("color/acme-green/700")?.id;
  const third = await buildDocument(systemDoc(edited), BUILD_TARGET, () => {});
  const final = builtVariables(mock);
  const changed = final.byName.get("color/acme-green/700");
  const baseId = final.collection?.defaultModeId ?? "";

  // The one changed token is named once, and nothing else is. A semantic
  // token's stored value is an alias, so comparing it against the literal
  // written a pass earlier reports every semantic token as changed on every
  // import — a change list that is always full is one nobody reads.
  check(
    names[2],
    changed?.id === idBefore &&
      JSON.stringify(changed?.valuesByMode[baseId]) === JSON.stringify(hex("#0D4A3B")) &&
      JSON.stringify(third.mapping.samples) ===
        JSON.stringify(["color/acme-green/700 changed in Product"]) &&
      JSON.stringify(second.mapping.samples) === "[]",
    `id ${idBefore} -> ${changed?.id} value=${JSON.stringify(changed?.valuesByMode[baseId])} ` +
      `third=${JSON.stringify(third.mapping.samples)} second=${JSON.stringify(second.mapping.samples)}`,
  );
  check(
    names[3],
    final.byName.has("color/legacy") && final.variables.length === 10,
    `variables=${JSON.stringify(final.variables.map((v) => v.name))}`,
  );
}

async function scenarioK(ready: boolean): Promise<void> {
  const p = "K (build, hostile file):";
  const names = [
    `${p} a one-mode plan degrades to the base mode and says so`,
    `${p} a type conflict skips the token instead of removing the variable`,
    `${p} a batch carries the surfaces, the stamp and the shadows across`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  // Starter files allow exactly one mode. An unguarded addMode throws out of
  // resolveVariables, buildDocument removes its half-built tree and rethrows,
  // and the user gets "Import failed" with no layers at all rather than a
  // perfectly good single-mode import.
  //
  // Neither surface's values survive this one: both re-theme tokens `:root`
  // pins, so the base mode holds neither and the note must not claim a theme it
  // did not keep. The other half of the cap, a theme the base mode DOES hold,
  // is scenario P.
  const limited = freshMock({ modeLimit: 1 });
  const result = await buildDocument(systemDoc(buildFixtureSystem()), BUILD_TARGET, () => {});
  const { collection, variables } = builtVariables(limited);
  const baseId = collection?.defaultModeId ?? "";
  const capNote = result.mapping.samples.find((line) => line.includes("plan allows")) ?? "";
  check(
    names[0],
    JSON.stringify(result.mapping.modes) === JSON.stringify(["Product"]) &&
      collection?.modes.length === 1 &&
      variables.length === 9 &&
      variables.every((v) => v.valuesByMode[baseId] !== undefined) &&
      capNote.includes("only 1 variable mode per collection") &&
      capNote.includes("the import built Product.") &&
      // Four, not five. `ink-500` is deck-private and holds `#333333` in every
      // mode, so no ref against it is ever theme-scoped and no layer under the
      // deck goes literal for it. Counting a re-DECLARATION rather than a
      // re-theme inflated the one number in this sentence that says how much of
      // the document is affected.
      capNote.includes("Acme Deck and Acme Email re-theme 4 of those tokens") &&
      // The exception text itself never reaches a user-facing summary.
      !result.mapping.samples.some((line) => line.includes("in addMode")),
    `modes=${JSON.stringify(result.mapping.modes)} variables=${variables.length} ` +
      `samples=${JSON.stringify(result.mapping.samples)}`,
  );

  // Removing and recreating on a type conflict detaches every binding the
  // designer already made against that variable.
  const conflictMock = freshMock();
  const houseCollection = conflictMock.figma.variables.createVariableCollection("Acme System");
  const clash = conflictMock.figma.variables.createVariable("color/primary", houseCollection, "FLOAT");
  clash.setValueForMode(houseCollection.defaultModeId, 4);

  const conflict = await buildDocument(systemDoc(buildFixtureSystem()), BUILD_TARGET, () => {});
  const survivor = conflictMock.getVariables().find((v) => v.id === clash.id);
  check(
    names[1],
    !!survivor &&
      survivor.resolvedType === "FLOAT" &&
      JSON.stringify(survivor.valuesByMode[houseCollection.defaultModeId]) === "4" &&
      conflict.mapping.unmatched === 1 &&
      conflict.mapping.samples.some((line) => line.includes("color/primary is FLOAT")),
    `survivor=${JSON.stringify(survivor)} unmatched=${conflict.mapping.unmatched} ` +
      `samples=${JSON.stringify(conflict.mapping.samples)}`,
  );

  // `mergeDesignSystems` (src/plugin/build.ts) unions a batch's design systems
  // by token path. Unioning the tokens alone demotes a fourteen-screen build to
  // a flat single-mode collection with no stamp and no effect styles, while
  // every count in the summary stays correct — the exact shape of regression
  // this suite exists to catch.
  const batchMock = freshMock();
  const batch = await buildDocuments(
    [systemDoc(buildFixtureSystem()), systemDoc(buildFixtureSystem())],
    BUILD_TARGET,
    {},
    () => {},
  );
  const batchBuilt = builtVariables(batchMock);
  check(
    names[2],
    batchBuilt.collection?.modes.length === 3 &&
      batchBuilt.collection.pluginData["ferry.systemKey"] === "AcmeSystem_3f2a9c" &&
      batchMock.getEffectStyles().length === 2 &&
      batch.mapping.created === 9,
    `modes=${batchBuilt.collection?.modes.length} stamp=${JSON.stringify(batchBuilt.collection?.pluginData)} ` +
      `styles=${batchMock.getEffectStyles().length} created=${batch.mapping.created}`,
  );
}

/**
 * The drop, before anything is measured.
 *
 * src/ui/screens.ts is the only part of ingest with no DOM in it, and this is
 * the only suite that runs outside a browser, so it is the one place these
 * rules can be asserted at all: src/ui/main.ts binds every element at module
 * top level and cannot be imported here.
 *
 * They earn the space because each one fails quietly. A picker offering the
 * same word twice, a board losing the default to a component, three screens
 * landing in a 2x2 grid instead of a row: nothing on the canvas says which of
 * those happened.
 */
async function scenarioL(ready: boolean): Promise<void> {
  const p = "L (screen enumeration):";
  const names = [
    `${p} a project export offers every screen, board first`,
    `${p} two screens with one name are told apart by their folder`,
    `${p} same name and no folder still produces distinct labels`,
    `${p} All screens is the default up to the batch limit and not past it`,
    `${p} a selection is capped at the batch limit, an index picks exactly one`,
    `${p} three screens land in a row, one gap apart, level with each other`,
  ];

  // A File in name only: `htmlCandidates`/`labelScreens` read `name` and
  // `webkitRelativePath` and nothing else, and constructing real Files here
  // would need a DOM.
  const file = (path: string): File =>
    ({
      name: path.split("/").pop() ?? path,
      webkitRelativePath: path.indexOf("/") >= 0 ? path : "",
    }) as unknown as File;

  // Exactly what the real Portage export unpacks to, in an order that is not
  // the answer: alphabetically "Portage Panel v1" sorts first, and it is a
  // component nobody asked to see on its own.
  const portage = buildScreens([
    file("Portage Panel v1.dc.html"),
    file("Portage Panel.dc.html"),
    file("Portage.dc.html"),
    file("support.js"),
    file("_ds/acme-design-system/tokens/colors.css"),
    file("uploads/pasted-1785251414209-0.png"),
  ]);
  check(
    names[0],
    JSON.stringify(portage.map((screen) => screen.label)) ===
      JSON.stringify(["Portage", "Portage Panel", "Portage Panel v1"]),
    JSON.stringify(portage.map((screen) => screen.label)),
  );

  const collided = buildScreens([
    file("ui/Panel.dc.html"),
    file("email/Panel.dc.html"),
    file("ui/Settings.dc.html"),
  ]);
  check(
    names[1],
    JSON.stringify(collided.map((screen) => screen.label).sort()) ===
      JSON.stringify(["Panel (email)", "Panel (ui)", "Settings"]),
    JSON.stringify(collided.map((screen) => screen.label)),
  );

  // A multi-select drag carries no path at all, so "Panel ()" twice is the
  // failure to avoid: two identically named top-level frames.
  const pathless = buildScreens([file("Panel.dc.html"), file("Panel.dc.html")]);
  check(
    names[2],
    JSON.stringify(pathless.map((screen) => screen.label)) ===
      JSON.stringify(["Panel", "Panel 2"]),
    JSON.stringify(pathless.map((screen) => screen.label)),
  );

  check(
    names[3],
    defaultSelection(3) === "all" &&
      defaultSelection(BATCH_LIMIT) === "all" &&
      defaultSelection(BATCH_LIMIT + 1) === 0 &&
      screenHint(40).indexOf("40 screens found") === 0 &&
      screenHint(3) === "Each screen becomes its own top-level frame.",
    `${String(defaultSelection(BATCH_LIMIT))}/${String(defaultSelection(BATCH_LIMIT + 1))} hint=${screenHint(40)}`,
  );

  const many = buildScreens(
    Array.from({ length: 40 }, (_unused, index) => file(`Screen ${index}.dc.html`)),
  );
  const capped = selectedScreens(many, "all");
  const one = selectedScreens(many, 5);
  check(
    names[4],
    capped.length === BATCH_LIMIT &&
      capped[0] === many[0] &&
      one.length === 1 &&
      one[0] === many[5],
    `capped=${capped.length} one=${one.map((screen) => screen.label).join()}`,
  );

  if (!ready) {
    skip(names[5], "captured/fixture-screen.json not found");
    return;
  }

  // The user-visible half of the same decision, through the real build path: a
  // zip of three screens must come across as three frames side by side, not
  // stacked. The sandbox's own default is `ceil(sqrt(3))` = 2 columns, which
  // wraps the third onto a second row, so this also proves the UI's choice is
  // load-bearing rather than incidentally the same.
  freshMock();
  const row = await buildDocuments(
    [batchDoc("One"), batchDoc("Two"), batchDoc("Three")],
    { kind: "none" },
    { columns: batchColumns(3) },
    () => {},
  );
  const xs = row.roots.map((frame) => frame.x);
  const ys = row.roots.map((frame) => frame.y);
  const widths = row.roots.map((frame) => frame.width);

  freshMock();
  const wrapped = await buildDocuments(
    [batchDoc("One"), batchDoc("Two"), batchDoc("Three")],
    { kind: "none" },
    {},
    () => {},
  );

  check(
    names[5],
    batchColumns(3) === 3 &&
      row.roots.length === 3 &&
      ys[0] === ys[1] &&
      ys[1] === ys[2] &&
      xs[1] === xs[0] + widths[0] + IMPORT_GAP &&
      xs[2] === xs[1] + widths[1] + IMPORT_GAP &&
      wrapped.roots[2].y !== wrapped.roots[0].y,
    `x=${JSON.stringify(xs)} y=${JSON.stringify(ys)} widths=${JSON.stringify(widths)} ` +
      `default-wrapped-y=${JSON.stringify(wrapped.roots.map((frame) => frame.y))}`,
  );
}

/**
 * `source` with its comments, string literals and regular expressions blanked
 * out, newlines kept.
 *
 * `unrefreshedLoadedWrites` below decides two things by reading text: where a
 * block ends, which is counted in braces, and whether a call appears inside it.
 * Both are answerable wrongly by something that is not code: a comment
 * mentioning `applyTokenModeDefault()` would satisfy the rule while the panel
 * never called it, and a brace inside a string would move the end of the block.
 * Newlines survive so a reported line number still points at the right line.
 *
 * Regular expressions are blanked for that same reason, and were not. It held
 * only by luck: main.ts's attribute pattern already carried a `"` and a `'`
 * inside it and happened to leave the quote count even, so the scanner's
 * mistake cancelled out. The url() pattern added beside it does not, the
 * scanner began reading code as a string, and the brace count went with it.
 * `balanced` is reported precisely so that surfaces as a failure rather than as
 * a rule that quietly stopped being enforced.
 */
function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  /**
   * The last character of real code emitted. A `/` opens a regular expression
   * only where a value may begin; everywhere else it follows one and is
   * division. Operators and openers are the places a value may begin.
   */
  let previous = "";
  const opensValue = () =>
    previous === "" || "(,=:[!&|?+-*%^~;{}".includes(previous);

  while (i < source.length) {
    const pair = source.slice(i, i + 2);

    if (source[i] === "/" && pair !== "//" && pair !== "/*" && opensValue()) {
      out += " ";
      i++;
      let inClass = false;
      while (i < source.length && source[i] !== "\n") {
        const char = source[i];
        if (char === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += " ";
        i++;
        if (char === "[") inClass = true;
        else if (char === "]") inClass = false;
        // The closing slash, unless it is inside a character class, where a
        // literal `/` needs no escape.
        else if (char === "/" && !inClass) break;
      }
      while (i < source.length && /[a-z]/.test(source[i])) {
        out += " ";
        i++;
      }
      // The expression is a value now, so a `/` after it would be division.
      previous = "x";
      continue;
    }

    if (pair === "//") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (pair === "/*") {
      while (i < source.length && source.slice(i, i + 2) !== "*/") {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      out += " ";
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += " ";
      i++;
      previous = "x";
      continue;
    }
    out += quote;
    if (!/\s/.test(quote)) previous = quote;
    i++;
  }
  return out;
}

/**
 * Every place src/ui/main.ts changes `pendingScreens` re-derives the token mode
 * before its handler returns.
 *
 * `pendingScreens.length > 0` IS the `loaded` fact `tokenModeAvailability`
 * gates Build on, so an assignment that does not reach `applyTokenModeDefault`
 * leaves the radio group describing a drop that is no longer there. Not
 * hypothetical: `expandZipFiles`'s failure path emptied `pendingScreens` and
 * did not, so a zip that failed to unpack left "Build a design system from this
 * export" enabled and still selected, under a line naming the six token files
 * of an export the same handler had just discarded.
 *
 * Read off the source text because there is nowhere else to read it: main.ts
 * binds every element at module top level and cannot be imported outside a
 * browser, which is the same reason token-mode.ts exists at all. The pure rules
 * live there and are checked above. This is the wiring, and the wiring is the
 * half that was wrong.
 *
 * The enclosing block is found by counting forward to the first `}` that closes
 * something this assignment did not open. `balanced` is reported alongside so a
 * `codeOnly` that mangled the file fails loudly rather than passing an
 * assertion it can no longer see.
 */
function unrefreshedLoadedWrites(): { sites: number; gaps: string[]; balanced: boolean } {
  const source = codeOnly(
    readFileSync(join(HERE, "..", "..", "src", "ui", "main.ts"), "utf-8"),
  );

  let depth = 0;
  let balanced = true;
  for (const char of source) {
    if (char === "{") depth++;
    else if (char === "}" && --depth < 0) balanced = false;
  }
  if (depth !== 0) balanced = false;

  const gaps: string[] = [];
  let sites = 0;
  const assignment = /(?:^|[^.\w])pendingScreens\s*=(?!=)/g;
  for (let match = assignment.exec(source); match; match = assignment.exec(source)) {
    // `let pendingScreens: Screen[] = []` is the declaration, not a state
    // change: nothing has been rendered yet for it to contradict.
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    if (/^\s*let\b/.test(source.slice(lineStart, match.index + match[0].length))) continue;
    sites++;

    let open = 0;
    let end = source.length;
    for (let i = assignment.lastIndex; i < source.length; i++) {
      if (source[i] === "{") open++;
      else if (source[i] === "}") {
        if (open === 0) {
          end = i;
          break;
        }
        open--;
      }
    }
    if (!source.slice(match.index, end).includes("applyTokenModeDefault(")) {
      gaps.push(`line ${source.slice(0, match.index).split("\n").length}`);
    }
  }

  return { sites, gaps, balanced };
}

/**
 * What the panel decides to do with the export's design tokens.
 *
 * Scenarios H-K prove `buildDesignSystem` builds a real library when it is
 * asked to. Nothing proves the panel asks. That gap is the one plan §0 item 5
 * names: `{kind:"create"}` and `{kind:"build"}` both import successfully and
 * both leave a plausible collection behind, so a Build radio wired to the wrong
 * one produces a flat single-mode dump under a label promising modes and
 * aliases, with every existing assertion green.
 *
 * Same reasoning as scenario L for why these live in src/ui/token-mode.ts at
 * all: src/ui/main.ts binds every element at module top level and cannot be
 * imported outside a browser.
 */
async function scenarioM(ready: boolean): Promise<void> {
  const p = "M (token mode):";
  const names = [
    `${p} the default follows what the file and the export actually have`,
    `${p} a mode that cannot work is never the default and always says why`,
    `${p} the export's own tokens reach the measurement, and win the cascade`,
    `${p} the discovered system is named from the export's own _ds folder`,
    `${p} the overflow hint fires only where mode (a) actually overflowed`,
    `${p} every place that changes what is loaded re-derives the mode`,
    `${p} Build asks for a real library, not a flat collection`,
  ];

  const facts = (over: Partial<TokenModeFacts>): TokenModeFacts => ({
    collections: 0,
    exportTokenFiles: 0,
    savedTokenFiles: 0,
    exportAlreadySaved: false,
    loaded: false,
    ...over,
  });

  // The user's own sentence, in the three states it describes: I have a design
  // system, I do not but the export does, I have neither.
  check(
    names[0],
    defaultTokenMode(facts({ collections: 2, exportTokenFiles: 6, loaded: true })) === "map" &&
      defaultTokenMode(facts({ exportTokenFiles: 6, loaded: true })) === "build" &&
      defaultTokenMode(facts({ savedTokenFiles: 7, loaded: true })) === "build" &&
      defaultTokenMode(facts({ loaded: true })) === "none" &&
      // A design system restored from a previous session before anything is
      // dropped: Build has nothing to build from yet, so it waits.
      defaultTokenMode(facts({ savedTokenFiles: 7 })) === "none",
    `${defaultTokenMode(facts({ collections: 2, exportTokenFiles: 6, loaded: true }))}/` +
      `${defaultTokenMode(facts({ exportTokenFiles: 6, loaded: true }))}/` +
      `${defaultTokenMode(facts({ loaded: true }))}/${defaultTokenMode(facts({ savedTokenFiles: 7 }))}`,
  );

  // Preselecting a disabled radio is a panel that looks configured and imports
  // nothing, so the two rules have to agree over every combination, not just
  // the ones anyone thought to write down.
  let everyDefaultAvailable = true;
  let everyReasonSpoken = true;
  for (const collections of [0, 3]) {
    for (const exportTokenFiles of [0, 6]) {
      for (const savedTokenFiles of [0, 7]) {
        for (const loaded of [false, true]) {
          const f = facts({ collections, exportTokenFiles, savedTokenFiles, loaded });
          const available = tokenModeAvailability(f);
          if (available[defaultTokenMode(f)] !== null) everyDefaultAvailable = false;
          if (
            (collections === 0) !== (typeof available.map === "string") ||
            loaded === (typeof available.build === "string") ||
            available.none !== null
          ) {
            everyReasonSpoken = false;
          }
        }
      }
    }
  }
  check(
    names[1],
    everyDefaultAvailable && everyReasonSpoken,
    `defaults-available=${everyDefaultAvailable} reasons=${everyReasonSpoken}`,
  );

  // `extraCss` is what the offscreen render measures. Dropping the export's own
  // tokens here is the bug this step exists to fix: a board that links only
  // tokens/fonts.css measured every `var(--color-…)` at its fallback while the
  // real values sat unread in the same zip. Order is load-bearing too: the
  // export is what this document was authored against, so it goes last and wins.
  check(
    names[2],
    extraCssFor("", "") === undefined &&
      extraCssFor(":root{--a:1}", "") === ":root{--a:1}" &&
      extraCssFor("", ":root{--a:2}") === ":root{--a:2}" &&
      extraCssFor(":root{--a:1}", ":root{--a:2}") === ":root{--a:1}\n:root{--a:2}",
    JSON.stringify(extraCssFor(":root{--a:1}", ":root{--a:2}")),
  );

  // Exactly the paths the real Portage export unpacks to. The folder is the
  // only readable name anywhere in it: the manifest declares no `name` and a
  // `namespace` of "AcmeDesignSystem_3f2a9c", and that name goes on a Figma
  // collection in Build mode.
  const dsPaths = [
    { name: "Portage.dc.html", webkitRelativePath: "" },
    {
      name: "colors.css",
      webkitRelativePath:
        "_ds/acme-design-system-3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c/tokens/colors.css",
    },
  ] as unknown as File[];
  const named = buildStatusLine(facts({ exportTokenFiles: 6, loaded: true }), dsSystemName(dsPaths));
  const alreadySaved = buildStatusLine(
    facts({ exportTokenFiles: 6, loaded: true, exportAlreadySaved: true }),
    dsSystemName(dsPaths),
  );
  const nothingFound = buildStatusLine(facts({ loaded: true }), undefined);
  check(
    names[3],
    dsSystemName(dsPaths) === "Acme Design System" &&
      dsSystemName([{ name: "a.html", webkitRelativePath: "" } as unknown as File]) === undefined &&
      named.text === "Acme Design System, 6 token files in this export." &&
      // Session-scoped by default, offered explicitly, and not offered twice.
      named.offerSave &&
      !alreadySaved.offerSave &&
      !nothingFound.offerSave &&
      nothingFound.text.indexOf("No _ds folder") === 0,
    `${dsSystemName(dsPaths)} | ${named.text} | save=${named.offerSave}/${alreadySaved.offerSave}`,
  );

  const mapTarget = tokenTarget("map", { collection: "local:abc", createMissing: true });
  check(
    names[4],
    createOverflowNote(mapTarget, 21) !== null &&
      createOverflowNote(mapTarget, 20) === null &&
      createOverflowNote(tokenTarget("map", { collection: "local:abc", createMissing: false }), 400) ===
        null &&
      createOverflowNote(tokenTarget("build", { collection: "", createMissing: true }), 400) === null &&
      createOverflowNote(tokenTarget("none", { collection: "", createMissing: true }), 400) === null &&
      createOverflowNote(null, 400) === null,
    `21=${createOverflowNote(mapTarget, 21) !== null} 20=${createOverflowNote(mapTarget, 20) === null}`,
  );

  // Availability is recomputed from `pendingScreens`, and `renderTokenMode`
  // only ever runs because something called it. The panel probe that found the
  // hole drives the built ui.html in a browser and is not something this runner
  // can do, so the rule it exposed is kept here instead.
  const wiring = unrefreshedLoadedWrites();
  check(
    names[5],
    wiring.balanced && wiring.sites >= 3 && wiring.gaps.length === 0,
    `${wiring.sites} writes, balanced=${wiring.balanced}` +
      (wiring.gaps.length > 0 ? `, no re-derive after ${wiring.gaps.join(", ")}` : ""),
  );

  if (!ready) {
    skip(names[6], "captured/fixture-screen.json not found");
    return;
  }

  // The assertion that matters. Not "build mode works", which scenarios H-K
  // own, but "the Build radio is wired to the thing that works". It drives
  // the REAL build path with the target `currentTarget()` produces, and asserts
  // the two properties `{kind:"create"}` cannot deliver: a mode per themed
  // surface, and a semantic token aliasing a DIFFERENT primitive per mode. The
  // same system through `{kind:"create"}` is built alongside to prove those are
  // a genuine difference and not something every path happens to produce.
  //
  // The stamp was a third such property and is now asserted on BOTH paths.
  // Mode (a) creates a collection per import and matched it back by name, so
  // three screens of one export produced three collections; identity had to
  // stop being a build-mode privilege. See `prepareCreation` in
  // src/plugin/mapping.ts and scenario Q.
  const uiTarget = tokenTarget("build", {
    collection: "local:should-be-ignored",
    createMissing: true,
    systemName: "Acme System",
  });

  const buildMock = freshMock();
  await buildDocument(systemDoc(buildFixtureSystem()), uiTarget, () => {});
  const built = builtVariables(buildMock);
  const builtModes = built.collection?.modes.map((mode) => mode.modeId) ?? [];
  const primary = built.byName.get("color/primary");
  const aliasIn = (modeId: string) => (primary?.valuesByMode[modeId] as any)?.id;

  const createMock = freshMock();
  await buildDocument(
    systemDoc(buildFixtureSystem()),
    { kind: "create", name: "Acme System" },
    () => {},
  );
  const flat = builtVariables(createMock);

  check(
    names[6],
    uiTarget.kind === "build" &&
      (uiTarget as { modes: boolean }).modes === true &&
      builtModes.length === 3 &&
      built.collection?.pluginData["ferry.systemKey"] === "AcmeSystem_3f2a9c" &&
      builtModes.every((modeId) => typeof aliasIn(modeId) === "string") &&
      aliasIn(builtModes[1]) !== aliasIn(builtModes[0]) &&
      // What the radio would have promised if it were wired to "create".
      flat.collection?.modes.length === 1 &&
      flat.collection?.pluginData["ferry.systemKey"] === "AcmeSystem_3f2a9c",
    `kind=${uiTarget.kind} modes=${builtModes.length} stamp=${built.collection?.pluginData["ferry.systemKey"]} ` +
      `aliases=${JSON.stringify(builtModes.map(aliasIn))} create-modes=${flat.collection?.modes.length} ` +
      `create-stamp=${flat.collection?.pluginData["ferry.systemKey"]}`,
  );
}

/**
 * One frame per prop combination.
 *
 * The premise under test is an equivalence: `Portage Panel.dc.html` declares
 * `state` (enum, 7) and `theme` (enum, 2), and `Portage.dc.html`, which this
 * scenario never reads, hand-assembles exactly those 14 panels: seven light
 * then seven dark. Enumerating the schema has to produce that same grid, in
 * that same order, or the feature is inventing a matrix rather than recovering
 * the one the author already drew.
 *
 * The half that needs a browser (mounting one document 14 times) is verified by
 * hand against the real export; everything decided BEFORE the mount is here,
 * because every one of those decisions fails green: a swapped odometer gives 14
 * frames with 14 correct names in an order nobody drew, a trimmed matrix gives
 * 24 perfectly good frames out of 54, and a lost `$preview` gives a ragged grid
 * that still counts to 14.
 */
async function scenarioN(ready: boolean): Promise<void> {
  const p = "N (state enumeration):";
  const names = [
    `${p} only finite primitive props become axes, and the widest is the default`,
    `${p} 14 combinations in the order the board was hand-assembled in`,
    `${p} ticking props in a different order enumerates a different axis fastest`,
    `${p} past the cap the matrix is refused, not trimmed`,
    `${p} $preview is a floor on the frame, never a crop`,
    `${p} the matrix builds as a grid one sweep of the fastest axis wide`,
    `${p} every frame carries the combination it was built from`,
  ];

  // What `enumerableProps` (src/ui/resolve.ts) reports for the real panel,
  // plus the two shapes `stateAxes` is the one to reject. `width` (int) and
  // `sfx` (null editor) never reach here at all. The resolver drops them, and
  // test/fixture/harness.html asserts that it does.
  const panel = stateAxes([
    { name: "state", values: ["empty", "file", "folder", "warning", "importing", "done", "error"] },
    { name: "theme", values: ["light", "dark"] },
    { name: "only", values: ["single"] },
    { name: "shapes", values: [{ a: 1 }, { a: 2 }] },
  ]);

  check(
    names[0],
    panel.length === 2 &&
      panel[0].name === "state" &&
      panel[0].values.length === 7 &&
      panel[1].name === "theme" &&
      panel[1].values.length === 2 &&
      // Widest, not first-declared and not all of them: a blind cross-product
      // is the expensive answer, and this document's author did not want it.
      // Asserted with the axes REVERSED as well, because in this schema the
      // widest prop is also the first one and "the first" would otherwise look
      // like the right rule.
      JSON.stringify(defaultStateSelection(panel)) === JSON.stringify(["state"]) &&
      JSON.stringify(defaultStateSelection(selectAxes(panel, ["theme", "state"]))) ===
        JSON.stringify(["state"]) &&
      // A tie is the only case declaration order decides.
      JSON.stringify(
        defaultStateSelection([
          { name: "first", values: ["a", "b"] },
          { name: "second", values: ["c", "d"] },
        ]),
      ) === JSON.stringify(["first"]),
    `axes=${JSON.stringify(panel.map((axis) => `${axis.name}(${axis.values.length})`))} ` +
      `default=${JSON.stringify(defaultStateSelection(panel))} ` +
      `reversed=${JSON.stringify(defaultStateSelection(selectAxes(panel, ["theme", "state"])))}`,
  );

  // Transcribed from Portage.dc.html's 14 <dc-import> call sites, in document
  // order: seven `theme="light"`, then seven `theme="dark"`, `state` cycling
  // through its declared options each time.
  const board = [
    "state=empty · theme=light",
    "state=file · theme=light",
    "state=folder · theme=light",
    "state=warning · theme=light",
    "state=importing · theme=light",
    "state=done · theme=light",
    "state=error · theme=light",
    "state=empty · theme=dark",
    "state=file · theme=dark",
    "state=folder · theme=dark",
    "state=warning · theme=dark",
    "state=importing · theme=dark",
    "state=done · theme=dark",
    "state=error · theme=dark",
  ];

  const plan = propCombinations(panel);
  check(
    names[1],
    plan.total === 14 &&
      plan.capped === false &&
      plan.columns === 7 &&
      JSON.stringify(plan.combos.map((combo) => combo.label)) === JSON.stringify(board) &&
      plan.combos[0].values.state === "empty" &&
      plan.combos[0].values.theme === "light" &&
      plan.combos[13].values.state === "error" &&
      plan.combos[13].values.theme === "dark" &&
      stateFrameName("Portage Panel", plan.combos[0].label) ===
        "Portage Panel · state=empty · theme=light",
    `columns=${plan.columns} first=${plan.combos[0]?.label} second=${plan.combos[1]?.label} last=${plan.combos[13]?.label}`,
  );

  // The same 14 combinations with the same 14 labels and a grid nobody drew.
  // This is the assertion that a reversed odometer cannot pass.
  const swapped = propCombinations(selectAxes(panel, ["theme", "state"]));
  // Same fourteen cells either way. Only the sweep differs, which is what makes
  // this a test of ordering rather than of one selection dropping an axis.
  const sameCells =
    JSON.stringify(
      swapped.combos.map((combo) => `${combo.values.state}/${combo.values.theme}`).sort(),
    ) ===
    JSON.stringify(
      plan.combos.map((combo) => `${combo.values.state}/${combo.values.theme}`).sort(),
    );
  check(
    names[2],
    swapped.total === 14 &&
      swapped.columns === 2 &&
      swapped.combos[1].label === "theme=dark · state=empty" &&
      plan.combos[1].label === "state=file · theme=light" &&
      sameCells,
    `swapped=${swapped.combos[1]?.label} columns=${swapped.columns} same-cells=${sameCells}`,
  );

  const axis = (name: string, count: number) => ({
    name,
    values: Array.from({ length: count }, (_unused, i) => `v${i}`),
  });
  const atCap = propCombinations(stateAxes([axis("a", 4), axis("b", 6)]));
  const overCap = propCombinations(stateAxes([axis("a", 5), axis("b", 5)]));
  const refusal = stateHint(stateAxes([axis("a", 5), axis("b", 5)]), overCap);
  check(
    names[3],
    atCap.total === 24 &&
      atCap.capped === false &&
      atCap.combos.length === 24 &&
      overCap.total === 25 &&
      overCap.capped === true &&
      // Refused, not trimmed. 24 of 25 frames looks exactly like 25 frames.
      overCap.combos.length === 0 &&
      refusal.indexOf("25 combinations") >= 0 &&
      refusal.indexOf("24-frame cap") >= 0 &&
      refusal.indexOf("Untick") >= 0,
    `atCap=${atCap.combos.length}/${atCap.total} overCap=${overCap.combos.length}/${overCap.total} hint=${refusal}`,
  );

  const preview = { width: 400, height: 620 };
  const small = previewFrameSize({ width: 380, height: 610 }, preview);
  const tall = previewFrameSize({ width: 400, height: 720 }, preview);
  const none = previewFrameSize({ width: 380, height: 610 }, null);
  check(
    names[4],
    small.width === 400 &&
      small.height === 620 &&
      small.overflows === false &&
      // Grown to fit rather than cropped: the state that outgrew its preview is
      // the one worth looking at.
      tall.height === 720 &&
      tall.overflows === true &&
      none.width === 380 &&
      none.height === 610,
    `small=${small.width}x${small.height} tall=${tall.height} overflow=${tall.overflows}`,
  );

  if (!ready) {
    skip(names[5], "captured/fixture-screen.json not found");
    skip(names[6], "captured/fixture-screen.json not found");
    return;
  }

  // Through the real build path, laid out by the real `layoutBatch` with the
  // columns the real `propCombinations` chose.
  freshMock();
  const matrix = await buildDocuments(
    plan.combos.map((combo) => stateDoc("Portage Panel", combo, preview)),
    { kind: "none" },
    { columns: plan.columns },
    () => {},
  );
  const frames = matrix.roots;
  const origin = { x: frames[0]?.x ?? 0, y: frames[0]?.y ?? 0 };
  const cell = { w: preview.width + IMPORT_GAP, h: preview.height + IMPORT_GAP };
  const placed = frames.every(
    (frame, i) =>
      frame.parent === (globalThis as any).figma.currentPage &&
      frame.width === preview.width &&
      frame.height === preview.height &&
      frame.x === origin.x + (i % 7) * cell.w &&
      frame.y === origin.y + Math.floor(i / 7) * cell.h,
  );
  check(
    names[5],
    frames.length === 14 &&
      placed &&
      // Two rows of seven, not four of four: `ceil(sqrt(14))` is what the
      // sandbox falls back to when the UI forgets to send the matrix's own
      // width, and it turns a legible state table into a wall.
      frames[7].y > frames[0].y &&
      frames[6].y === frames[0].y &&
      frames[0].name === "Portage Panel · state=empty · theme=light" &&
      frames[7].name === "Portage Panel · state=empty · theme=dark",
    `frames=${frames.length} placed=${placed} row0y=${frames[0]?.y} row1y=${frames[7]?.y}`,
  );

  const stamps = frames.map((frame) => frame.getPluginData("ferry.props"));
  const parsed = stamps.map((raw) => (raw ? JSON.parse(raw) : null));
  check(
    names[6],
    stamps.every((raw) => raw.length > 0) &&
      new Set(stamps).size === 14 &&
      parsed[7].state === "empty" &&
      parsed[7].theme === "dark" &&
      parsed.every(
        (props, i) =>
          props &&
          frames[i].name.indexOf(`state=${props.state}`) >= 0 &&
          frames[i].name.indexOf(`theme=${props.theme}`) >= 0,
      ),
    `stamped=${stamps.filter(Boolean).length}/14 distinct=${new Set(stamps).size} eighth=${stamps[7]}`,
  );
}

/**
 * One extracted combination, as a bare `$preview`-sized frame.
 *
 * Deliberately empty rather than the captured fixture's tree: what is under
 * test is placement, naming and the plugin-data stamp, and fourteen copies of a
 * real screen would measure the same thing fourteen times more slowly. The
 * envelope comes from the capture so every field build.ts might read is a real
 * one.
 */
function stateDoc(
  name: string,
  combo: PropCombination,
  preview: { width: number; height: number },
): IRDocument {
  const frameName = stateFrameName(name, combo.label);
  const base = loadCaptured(FIXTURE_PATH);
  return {
    ...base,
    name: frameName,
    props: combo.values,
    designSystem: undefined,
    warnings: [],
    root: {
      ...base.root,
      name: frameName,
      x: 0,
      y: 0,
      width: preview.width,
      height: preview.height,
      layout: undefined,
      children: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario O: prototype flows
// ---------------------------------------------------------------------------

/** One cell of a matrix: a bare `$preview`-sized frame, cheap to build 14 of. */
function flowDoc(name: string, broken = false): IRDocument {
  const base = loadCaptured(FIXTURE_PATH);
  return {
    ...base,
    name,
    designSystem: undefined,
    warnings: [],
    root: {
      ...base.root,
      name,
      x: 0,
      y: 0,
      // NaN survives `Math.max(node.width, 0.01)` in buildFrame and is refused
      // by resize(), which is how a document fails deep enough in the walk to
      // be a real per-document failure rather than a rejected argument.
      width: broken ? Number.NaN : 400,
      height: 620,
      layout: undefined,
      children: [],
    },
  };
}

const CLICK_TO_NEXT = (frames: any[], index: number) => ({
  trigger: { type: "ON_CLICK" },
  actions: [
    {
      type: "NODE",
      destinationId: frames[index].id,
      navigation: "NAVIGATE",
      transition: null,
      resetScrollPosition: false,
    },
  ],
});

/**
 * A flow here is real prototype wiring, not a drawing: `figma.createConnector`
 * is FigJam-only and manifest.json declares `"editorType": ["figma"]`, so the
 * arrows a diagram would be made of cannot be created at all.
 *
 * Which makes every assertion below one about something INVISIBLE in the Design
 * tab. A matrix whose reactions all point at the wrong frame, or whose edges
 * were written one call at a time so only the last survives, or that deleted
 * every flow the designer already had on the page, looks pixel-identical on
 * canvas to one that is correct. None of it shows up until somebody presses
 * play, which is usually not the person who ran the import.
 */
async function scenarioO(ready: boolean): Promise<void> {
  const p = "O (prototype flows):";
  const names = [
    `${p} the flow chains along the fastest axis and never across two sweeps`,
    `${p} the matrix imports as one ON_CLICK link per step, each to the next frame`,
    `${p} every outgoing edge of a frame survives, not just the last one written`,
    `${p} the page's existing flows survive, and a repeat does not duplicate ours`,
    `${p} a document that failed to build breaks its own links, not the others`,
    `${p} a NAVIGATE destination nested in a wrapper frame is refused`,
    `${p} reactions cannot be assigned, only set through setReactionsAsync`,
    `${p} a section groups the matrix without taking its frames out of top level`,
    `${p} there is no createConnector to draw arrows with`,
    `${p} runImport reports what it wired and still commits one undo`,
  ];

  // --- the derivation, before anything is built -----------------------------
  const panel = stateAxes([
    { name: "state", values: ["empty", "file", "folder", "warning", "importing", "done", "error"] },
    { name: "theme", values: ["light", "dark"] },
  ]);
  const plan = propCombinations(panel);
  const flow = stateFlow("Portage Panel", panel, plan);

  // A single axis wraps at six columns to stay legible while remaining ONE
  // sweep, so the chain has to run across that wrap. Reading the stride off
  // `plan.columns` instead of axis 0 strands the seventh state with nothing
  // pointing at it and nothing to point at.
  const soloAxis = stateAxes([panel[0]]);
  const soloPlan = propCombinations(soloAxis);
  const solo = stateFlow("Portage Panel", soloAxis, soloPlan);

  const crossesSweeps = (flow?.edges ?? []).some(
    (edge) => Math.floor(edge.from / 7) !== Math.floor(edge.to / 7),
  );
  check(
    names[0],
    !!flow &&
      flow.edges.length === 12 &&
      !crossesSweeps &&
      flow.edges.every((edge) => edge.to === edge.from + 1) &&
      flow.startIndex === 0 &&
      flow.section === null &&
      flow.name === "Portage Panel states" &&
      // One axis, one chain, wrap and all.
      !!solo &&
      soloPlan.columns === 6 &&
      solo.edges.length === 6 &&
      solo.edges[5].to === 6 &&
      // Nothing to walk to is not a flow.
      stateFlow("Portage Panel", panel, propCombinations(stateAxes([]))) === null,
    `edges=${flow?.edges.length} crossesSweeps=${crossesSweeps} solo=${solo?.edges.length} ` +
      `soloColumns=${soloPlan.columns} soloLast=${JSON.stringify(solo?.edges[5])}`,
  );

  if (!ready) {
    for (const n of names.slice(1)) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  const preview = { width: 400, height: 620 };
  const matrixDocs = plan.combos.map((combo) => stateDoc("Portage Panel", combo, preview));

  // --- the matrix, wired ----------------------------------------------------
  const matrixMock = freshMock();
  const matrix = await buildDocuments(
    matrixDocs,
    { kind: "none" },
    { columns: plan.columns },
    () => {},
    { flow: flow! },
  );
  const frames = matrix.roots;
  const trees = frames.map((frame) => matrixMock.serializeTree(frame));
  const wiredCorrectly = trees.every((tree, index) => {
    // The last cell of each sweep is the end of its chain and carries nothing.
    const expected = index % 7 === 6 ? 0 : 1;
    if (tree.reactions.length !== expected) return false;
    if (expected === 0) return true;
    const reaction = tree.reactions[0];
    return (
      reaction.trigger.type === "ON_CLICK" &&
      reaction.actions.length === 1 &&
      reaction.actions[0].type === "NODE" &&
      reaction.actions[0].navigation === "NAVIGATE" &&
      // The assertion that a swapped or off-by-one destination cannot pass.
      // Counting reactions alone would be green for a matrix where every arrow
      // points at the same frame.
      reaction.actions[0].destinationId === trees[index + 1].id
    );
  });
  check(
    names[1],
    matrix.reactions === 12 &&
      matrix.flows === 1 &&
      wiredCorrectly &&
      matrixMock.getFlowStartingPoints().length === 1 &&
      matrixMock.getFlowStartingPoints()[0].nodeId === frames[0].id &&
      matrixMock.getFlowStartingPoints()[0].name === "Portage Panel states" &&
      matrix.warnings.length === 0,
    `reactions=${matrix.reactions} flows=${matrix.flows} wired=${wiredCorrectly} ` +
      `starts=${JSON.stringify(matrixMock.getFlowStartingPoints())} warnings=${JSON.stringify(matrix.warnings)}`,
  );

  // --- fan-out --------------------------------------------------------------
  // setReactionsAsync REPLACES a node's whole reaction list, so a builder that
  // calls it once per edge keeps only the last outgoing edge of any frame that
  // has several, on a canvas that looks completely wired.
  const fanMock = freshMock();
  const fan = await buildDocuments(
    [flowDoc("Hub"), flowDoc("Left"), flowDoc("Right"), flowDoc("Down")],
    { kind: "none" },
    {},
    () => {},
    {
      flow: {
        name: "Hub",
        startIndex: 0,
        edges: [
          { from: 0, to: 1 },
          { from: 0, to: 2 },
          { from: 0, to: 3 },
        ],
        section: null,
      },
    },
  );
  const hub = fanMock.serializeTree(fan.roots[0]);
  const destinations = hub.reactions.map((reaction: any) => reaction.actions[0].destinationId);
  check(
    names[2],
    fan.reactions === 3 &&
      hub.reactions.length === 3 &&
      JSON.stringify(destinations) ===
        JSON.stringify([fan.roots[1].id, fan.roots[2].id, fan.roots[3].id]),
    `reactions=${fan.reactions} onHub=${hub.reactions.length} destinations=${JSON.stringify(destinations)}`,
  );

  // --- append, never replace ------------------------------------------------
  // Every flow on the page lives in one array. Assigning it wholesale deletes
  // the designer's own flows silently, with nothing on canvas to notice and no
  // recovery but undo.
  const appendMock = freshMock();
  const theirs = appendMock.figma.createFrame();
  theirs.name = "Their own flow";
  theirs.resize(400, 400);
  appendMock.figma.currentPage.appendChild(theirs);
  appendMock.figma.currentPage.flowStartingPoints = [{ nodeId: theirs.id, name: "Checkout" }];

  const appended = await buildDocuments(
    matrixDocs,
    { kind: "none" },
    { columns: plan.columns },
    () => {},
    { flow: flow! },
  );
  const startingPoints = appendMock.getFlowStartingPoints();
  // Called a second time for the same frame: if Figma turns out to auto-create
  // a starting point on the first setReactionsAsync, this is the path that
  // stops the import adding a duplicate beside it.
  const repeat = addFlowStartingPoint(appended.roots[0], "Portage Panel states");
  check(
    names[3],
    startingPoints.length === 2 &&
      startingPoints[0].nodeId === theirs.id &&
      startingPoints[0].name === "Checkout" &&
      startingPoints[1].nodeId === appended.roots[0].id &&
      repeat === 1 &&
      appendMock.getFlowStartingPoints().length === 2,
    `after import=${JSON.stringify(startingPoints)} repeat=${repeat} ` +
      `afterRepeat=${appendMock.getFlowStartingPoints().length}`,
  );

  // --- a hole in the batch --------------------------------------------------
  // A FlowSpec indexes into docs[], and `roots` skips a document that failed to
  // build. Reading the flow off `roots` shifts every later edge one place left,
  // which produces a link that renders perfectly and goes somewhere the author
  // never described.
  const holeMock = freshMock();
  const hole = await buildDocuments(
    [flowDoc("Cell 0"), flowDoc("Cell 1"), flowDoc("Cell 2", true), flowDoc("Cell 3")],
    { kind: "none" },
    {},
    () => {},
    {
      flow: {
        name: "Holed",
        startIndex: 0,
        edges: [
          { from: 0, to: 1 },
          { from: 1, to: 2 },
          { from: 2, to: 3 },
        ],
        section: null,
      },
    },
  );
  const survivor = holeMock.serializeTree(hole.roots[0]);
  check(
    names[4],
    hole.roots.length === 3 &&
      hole.reactions === 1 &&
      survivor.reactions.length === 1 &&
      // "Cell 1", not the frame that moved into index 2's place.
      survivor.reactions[0].actions[0].destinationId === hole.roots[1].id &&
      hole.roots[1].name === "Cell 1" &&
      holeMock.serializeTree(hole.roots[1]).reactions.length === 0 &&
      hole.flows === 1,
    `roots=${hole.roots.map((f) => f.name).join(",")} reactions=${hole.reactions} ` +
      `destination=${survivor.reactions[0]?.actions[0]?.destinationId} cell1=${hole.roots[1]?.id}`,
  );

  // --- the destination has to be top-level ----------------------------------
  // Figma Help, "Connect your prototype": a NAVIGATE destination must be "a
  // frame that is added directly to the canvas" and not an object within a
  // frame. Nest the matrix inside one wrapper and the canvas looks perfect
  // while the prototype is dead, which is why this refusal is in the simulator
  // at all.
  const nestedMock = freshMock();
  const source = nestedMock.figma.createFrame();
  source.resize(400, 620);
  nestedMock.figma.currentPage.appendChild(source);
  const destination = nestedMock.figma.createFrame();
  destination.name = "Nested destination";
  destination.resize(400, 620);
  const wrapper = nestedMock.figma.createFrame();
  wrapper.resize(1200, 1200);
  nestedMock.figma.currentPage.appendChild(wrapper);
  wrapper.appendChild(destination);

  let nestedError = "";
  try {
    await source.setReactionsAsync([CLICK_TO_NEXT([destination], 0)]);
  } catch (error) {
    nestedError = (error as Error).message;
  }
  let startError = "";
  try {
    nestedMock.figma.currentPage.flowStartingPoints = [
      { nodeId: destination.id, name: "Dead flow" },
    ];
  } catch (error) {
    startError = (error as Error).message;
  }
  check(
    names[5],
    nestedError.indexOf("top-level frame") >= 0 &&
      startError.indexOf("top-level frame") >= 0 &&
      nestedMock.serializeTree(source).reactions.length === 0 &&
      nestedMock.getFlowStartingPoints().length === 0,
    `reaction=${nestedError || "(did not throw)"} start=${startError || "(did not throw)"}`,
  );

  // --- documentAccess: dynamic-page -----------------------------------------
  let assignError = "";
  try {
    (source as any).reactions = [];
  } catch (error) {
    assignError = (error as Error).message;
  }
  check(
    names[6],
    assignError.indexOf("read-only") >= 0 && assignError.indexOf("setReactionsAsync") >= 0,
    assignError || "(assigning reactions did not throw)",
  );

  // --- sections -------------------------------------------------------------
  // Off by default and unverified against a real Design file (see
  // `groupIntoSection` in src/plugin/build.ts), so what is asserted here is the
  // arithmetic and the parenting, both of which are ours. A section re-bases
  // its children, so the grid is built in the section's own space and the
  // SECTION carries the batch origin: positioning the frames first and moving
  // them after would offset the whole matrix twice.
  const sectionMock = freshMock();
  seedExistingFrame(sectionMock);
  const grouped = await buildDocuments(
    matrixDocs,
    { kind: "none" },
    { columns: plan.columns },
    () => {},
    { flow: { ...flow!, section: "Portage Panel states" } },
  );
  const section = grouped.section;
  let sectionInFrame = "";
  try {
    (sectionMock.figma.currentPage.children[0] as any).appendChild(section);
  } catch (error) {
    sectionInFrame = (error as Error).message;
  }
  check(
    names[7],
    !!section &&
      section.type === "SECTION" &&
      section.parent === sectionMock.figma.currentPage &&
      grouped.roots.every((frame) => frame.parent === section) &&
      // Still top-level as far as prototyping is concerned, which is the only
      // reason a section is usable for this at all.
      grouped.reactions === 12 &&
      grouped.flows === 1 &&
      grouped.roots[0].x === 0 &&
      grouped.roots[0].y === 0 &&
      grouped.roots[1].x === preview.width + IMPORT_GAP &&
      section.x === 800 + IMPORT_GAP &&
      section.width === 6 * (preview.width + IMPORT_GAP) + preview.width + IMPORT_GAP &&
      sectionInFrame.indexOf("cannot be contained within frames") >= 0,
    `section=${section?.name} at (${section?.x}, ${section?.y}) ${section?.width}x${section?.height} ` +
      `firstFrame=(${grouped.roots[0]?.x}, ${grouped.roots[0]?.y}) reactions=${grouped.reactions} ` +
      `frameRefusal=${sectionInFrame || "(did not throw)"}`,
  );

  check(
    names[8],
    typeof sectionMock.figma.createConnector === "undefined" &&
      sectionMock.figma.editorType === "figma",
    `createConnector=${typeof sectionMock.figma.createConnector} editorType=${sectionMock.figma.editorType}`,
  );

  // --- through the real message handler -------------------------------------
  const onMessage = await pluginMessageHandler();
  const runMock = freshMock();
  await onMessage({
    type: "import",
    docs: matrixDocs,
    target: { kind: "none" },
    placement: { columns: plan.columns },
    flow,
  });
  const complete = runMock.figma.ui.postedMessages.find((m: any) => m.type === "import-complete");
  check(
    names[9],
    !!complete &&
      complete.reactions === 12 &&
      complete.flows === 1 &&
      complete.frames === 14 &&
      // Wiring a prototype must not become its own undo step: one import is one
      // ctrl-Z, matrix and noodles together.
      runMock.undoCommits === 1 &&
      runMock.getFlowStartingPoints().length === 1 &&
      // No section was asked for, so the frames stay selected individually and
      // nothing but frames is on the page.
      runMock.figma.currentPage.selection.length === 14 &&
      runMock.getRootNodes().every((node: any) => node.type === "FRAME"),
    `reactions=${complete?.reactions} flows=${complete?.flows} frames=${complete?.frames} ` +
      `undoCommits=${runMock.undoCommits} selection=${runMock.figma.currentPage.selection.length}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario P: a theme the DOCUMENT declares, and the free-plan mode cap
// ---------------------------------------------------------------------------

const LIGHT = ".dv-theme-light";
const DARK = ".dv-theme-dark";

/**
 * The system a document's own light/dark blocks produce.
 *
 * Shaped exactly as `buildTokenIndex` leaves `Portage Panel.dc.html`: no `:root`
 * anywhere, so `declaredIn` never contains `""` and the base value of every
 * token is the FIRST theme's. That last detail decides how the free-plan cap
 * degrades, so it is modelled rather than assumed. Synthetic for the same
 * reason as `buildFixtureSystem`: the real export references an internal design
 * system and is not committed. The extractor half of the same story runs
 * against test/fixture/theme-axis.html in the browser harness.
 */
function themeAxisSystem(): IRDesignSystem {
  return {
    name: "Panel Theme",
    surfaces: [
      { selector: LIGHT, label: "Light" },
      { selector: DARK, label: "Dark" },
    ],
    // Both surfaces are the document's own axis here, which is what
    // `detectThemeAxis` produces for a pair of class-scoped blocks and what
    // `extractDocument` now carries across (`IRDesignSystem.axis`). Modelled
    // rather than assumed: Map mode reads it to tell an axis a layer can sit
    // under from a manifest surface nothing here is inside.
    axis: [LIGHT, DARK],
    tokens: [
      {
        name: "dv-surface",
        path: "color/dv-surface",
        buildPath: "color/dv-surface",
        category: "color",
        kind: "COLOR",
        resolved: "#ffffff",
        color: hex("#FFFFFF"),
        declaredIn: [LIGHT, DARK],
        bySurface: {
          [LIGHT]: { resolved: "#ffffff", color: hex("#FFFFFF") },
          [DARK]: { resolved: "#2c2c2c", color: hex("#2C2C2C") },
        },
      },
      {
        name: "dv-muted",
        path: "color/dv-muted",
        buildPath: "color/dv-muted",
        category: "color",
        kind: "COLOR",
        resolved: "#b3b3b3",
        color: hex("#B3B3B3"),
        declaredIn: [LIGHT, DARK],
        bySurface: {
          [LIGHT]: { resolved: "#b3b3b3", color: hex("#B3B3B3") },
          [DARK]: { resolved: "#7e7e7e", color: hex("#7E7E7E") },
        },
      },
    ],
  };
}

/**
 * One panel of the matrix, as the extractor produces it.
 *
 * `themeScope` sits on the panel frame rather than the document root, which is
 * where it really lands: the class is on the document's own outermost `<div>`
 * and the root frame above it is the extractor's synthetic wrapper.
 *
 * The token refs mirror `tokenRef` (src/ui/tokens.ts) exactly: a match against
 * the theme whose values the base layer already holds is unmarked, and one
 * against the theme that differs carries the selector. Hand-writing them keeps
 * this scenario about what the BUILDER does with each kind.
 */
function themedPanel(theme: "light" | "dark"): IRDocument {
  const selector = theme === "light" ? LIGHT : DARK;
  const surface = theme === "light" ? "#FFFFFF" : "#2C2C2C";
  const muted = theme === "light" ? "#B3B3B3" : "#7E7E7E";
  const marked = theme === "dark" ? { themeScope: selector } : {};
  const characters = `${theme} muted`;

  const label: IRNode = {
    kind: "TEXT",
    name: `${theme} label`,
    x: 12,
    y: 12,
    width: 120,
    height: 20,
    opacity: 1,
    rotation: 0,
    clips: false,
    fills: [],
    cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    effects: [],
    text: {
      characters,
      runs: [
        {
          start: 0,
          end: characters.length,
          fontFamily: "Inter",
          fontWeight: 400,
          italic: false,
          fontSize: 12,
          lineHeight: null,
          letterSpacing: 0,
          fill: {
            type: "SOLID",
            color: hex(muted),
            token: { name: "dv-muted", path: "color/dv-muted", via: "var", ...marked },
          },
          decoration: "NONE",
          textCase: "ORIGINAL",
        },
      ],
      align: "LEFT",
      verticalAlign: "TOP",
      singleLine: true,
    },
    children: [],
  };

  const panel: IRNode = {
    kind: "FRAME",
    name: `${theme} panel`,
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    opacity: 1,
    rotation: 0,
    clips: false,
    themeScope: selector,
    fills: [
      {
        type: "SOLID",
        color: hex(surface),
        token: { name: "dv-surface", path: "color/dv-surface", via: "var", ...marked },
      },
    ],
    cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    effects: [],
    children: [label],
  };

  const base = loadCaptured(FIXTURE_PATH);
  return {
    ...base,
    name: `Panel ${theme}`,
    designSystem: themeAxisSystem(),
    warnings: [],
    root: {
      ...base.root,
      name: `Panel ${theme}`,
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      layout: undefined,
      fills: [],
      children: [panel],
    },
  };
}

/** The paint on a serialized node's first fill, plus whatever it is bound to. */
function fillOf(tree: any): { hex: string; variableId?: string } {
  const paint = tree.fills?.[0];
  const to255 = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0");
  return {
    hex: paint
      ? `#${to255(paint.color.r)}${to255(paint.color.g)}${to255(paint.color.b)}`.toUpperCase()
      : "(none)",
    variableId: paint?.boundVariables?.color?.id,
  };
}

const THEME_TARGET: VariableTarget = { kind: "build", name: "Panel Theme", modes: true };

async function scenarioP(ready: boolean): Promise<void> {
  const p = "P (document-declared theme):";
  const names = [
    `${p} a light node and a dark node bind to ONE variable, per-mode values apart`,
    `${p} each panel carries its own theme's mode, and only the outermost frame does`,
    `${p} a one-mode plan says which theme it kept, in a sentence rather than an exception`,
    `${p} under the cap the base theme still binds and the other stays literal`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  // --- both modes available -------------------------------------------------
  const mock = freshMock();
  const built = await buildDocuments(
    [themedPanel("light"), themedPanel("dark")],
    THEME_TARGET,
    {},
    () => {},
  );
  const { collection, byName } = builtVariables(mock);
  const modeIds = new Map((collection?.modes ?? []).map((m) => [m.name, m.modeId]));
  const surface = byName.get("color/dv-surface");
  const lightRoot = mock.serializeTree(built.roots[0]);
  const darkRoot = mock.serializeTree(built.roots[1]);
  const lightPanel = lightRoot.children[0];
  const darkPanel = darkRoot.children[0];
  const lightFill = fillOf(lightPanel);
  const darkFill = fillOf(darkPanel);

  const value = (mode: string) =>
    JSON.stringify(surface?.valuesByMode[modeIds.get(mode) ?? ""]);

  check(
    names[0],
    // One variable, two literals inside it. Two variables, or one variable
    // holding one colour, is the shape of the bug this scenario exists for.
    !!surface &&
      lightFill.variableId === surface.id &&
      darkFill.variableId === surface.id &&
      lightFill.hex === "#FFFFFF" &&
      darkFill.hex === "#2C2C2C" &&
      JSON.stringify(built.mapping.modes) === JSON.stringify(["Product", "Light", "Dark"]) &&
      value("Product") === JSON.stringify(hex("#FFFFFF")) &&
      value("Light") === JSON.stringify(hex("#FFFFFF")) &&
      value("Dark") === JSON.stringify(hex("#2C2C2C")),
    `light=${lightFill.variableId}@${lightFill.hex} dark=${darkFill.variableId}@${darkFill.hex} ` +
      `modes=${JSON.stringify(built.mapping.modes)} product=${value("Product")} darkMode=${value("Dark")}`,
  );

  const collectionId = collection?.id ?? "";
  check(
    names[1],
    darkPanel.explicitVariableModes[collectionId] === modeIds.get("Dark") &&
      lightPanel.explicitVariableModes[collectionId] === modeIds.get("Light") &&
      // A mode resolves down the tree, so the label inside inherits it and must
      // not be stamped again.
      Object.keys(darkPanel.children[0].explicitVariableModes).length === 0 &&
      Object.keys(darkRoot.explicitVariableModes).length === 0,
    `dark=${JSON.stringify(darkPanel.explicitVariableModes)} ` +
      `light=${JSON.stringify(lightPanel.explicitVariableModes)} ` +
      `label=${JSON.stringify(darkPanel.children[0].explicitVariableModes)}`,
  );

  // --- the same import on a Free team ---------------------------------------
  // Figma allows one mode per collection below a paid plan and there is no
  // capability query to ask first, so the refusal is what the plugin finds out
  // from. What it then TOLD the user was "in addMode: Limited to 1 modes only",
  // followed by "built Mode 1 only": a raw exception in a summary, reported by
  // a user as the plugin being broken.
  const capped = freshMock({ modeLimit: 1 });
  const degraded = await buildDocuments(
    [themedPanel("light"), themedPanel("dark")],
    THEME_TARGET,
    {},
    () => {},
  );
  const note = degraded.mapping.samples.find((line) => line.includes("plan allows"));
  check(
    names[2],
    !!note &&
      note.includes("only 1 variable mode per collection") &&
      // Which theme survived, and what became of the other. Both are the whole
      // content of the message, and neither was in the old one.
      note.includes("Product (holding Light's values)") &&
      note.includes("Dark re-themes 2 of those tokens") &&
      note.includes("imported as literals") &&
      // No exception text anywhere in the summary.
      !degraded.mapping.samples.some((line) => line.includes("in addMode")) &&
      !degraded.mapping.samples.some((line) => line.includes("Limited to")) &&
      JSON.stringify(degraded.mapping.modes) === JSON.stringify(["Product"]),
    `note=${JSON.stringify(note)} samples=${JSON.stringify(degraded.mapping.samples)}`,
  );

  const cappedVars = builtVariables(capped);
  const cappedSurface = cappedVars.byName.get("color/dv-surface");
  const cappedLight = fillOf(capped.serializeTree(degraded.roots[0]).children[0]);
  const cappedDarkNode = capped.serializeTree(degraded.roots[1]).children[0];
  const cappedDark = fillOf(cappedDarkNode);
  check(
    names[3],
    // The base mode holds Light, so the light half binds and is correct.
    cappedLight.variableId === cappedSurface?.id &&
      cappedLight.hex === "#FFFFFF" &&
      // The dark half has nowhere correct to bind. A binding here would render
      // #FFFFFF on a dark panel while reading as bound in the layer panel,
      // which is the failure this whole path exists to avoid.
      cappedDark.variableId === undefined &&
      cappedDark.hex === "#2C2C2C" &&
      Object.keys(cappedDarkNode.explicitVariableModes).length === 0 &&
      cappedVars.collection?.modes.length === 1,
    `light=${cappedLight.variableId}@${cappedLight.hex} dark=${cappedDark.variableId}@${cappedDark.hex} ` +
      `darkModes=${JSON.stringify(cappedDarkNode.explicitVariableModes)}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario Q: one export, one collection
// ---------------------------------------------------------------------------

/** A base-layer colour token, the only shape this scenario needs. */
function plainColor(name: string, path: string, value: string): IRTokenDefinition {
  return {
    name,
    path,
    buildPath: path,
    category: "color",
    kind: "COLOR",
    resolved: value,
    color: hex(value),
    declaredIn: [""],
  };
}

/** Tokens every screen of the export declares, because they all link the same `_ds`. */
const SHARED_TOKENS = [
  plainColor("acme-green-500", "color/acme-green/500", "#1B6F58"),
  plainColor("acme-green-700", "color/acme-green/700", "#0A2920"),
  plainColor("acme-grey-100", "color/acme-grey/100", "#ECEDED"),
];

/**
 * The screens of ONE export, each carrying the whole system plus one token of
 * its own, so "the union" is a thing a count can tell apart from "the first
 * one that got there".
 *
 * `names` is per screen on purpose: this is the shape the panel used to send,
 * and the shape it still sends whenever `nameDesignSystems` (src/ui/main.ts)
 * has no name to apply. The collection has to come out singular either way.
 */
function exportScreens(names: string[], key: string | undefined): IRDocument[] {
  return names.map((name, index) =>
    systemDoc({
      name,
      ...(key ? { key } : {}),
      tokens: [
        ...SHARED_TOKENS,
        plainColor(`only-${index}`, `color/only/${index}`, `#11223${index}`),
      ],
    }),
  );
}

/** Local collections the import is responsible for, i.e. not the one it matched against. */
function importedCollections(
  mock: ReturnType<typeof freshMock>,
  sourceId: string | null,
) {
  return mock.getCollections().filter((c) => !c.remote && c.id !== sourceId);
}

function variablesIn(mock: ReturnType<typeof freshMock>, collectionId: string) {
  return mock
    .getVariables()
    .filter((v) => v.variableCollectionId === collectionId)
    .map((v) => v.name)
    .sort();
}

/**
 * A design system the designer already owns, which mode (a) matches against and
 * must never write into.
 */
function seedSourceCollection(): string {
  const collection = figma.variables.createVariableCollection("Designer's library");
  const variable = figma.variables.createVariable("brand/green", collection, "COLOR");
  variable.setValueForMode(collection.defaultModeId, { r: 0.1, g: 0.44, b: 0.35, a: 1 });
  return collection.id;
}

/**
 * Where the design system's name comes from, read off src/ui/main.ts's source.
 *
 * The panel binds every element at module top level and cannot be imported
 * outside a browser, which is why scenarios L and M assert on src/ui/token-mode.ts
 * instead. The two naming functions themselves ARE driven for real, in
 * test/fixture/harness.html, which boots the panel against ui.template.html.
 * What is left over is the wiring: whether the batch is named before anything
 * downstream reads the name. That is what this reads.
 */
function batchNamedBeforeSent(): { ok: boolean; detail: string } {
  const raw = readFileSync(join(HERE, "..", "..", "src", "ui", "main.ts"), "utf-8");
  const source = codeOnly(raw);

  const named = source.indexOf("nameDesignSystems(docs, pendingFiles, pendingDsManifest)");
  const held = source.indexOf("heldDocs = docs");
  const sent = source.indexOf("sendImport(docs");
  const exported = /export function nameDesignSystems\b/.test(raw);

  const ok =
    exported &&
    named >= 0 &&
    held > named &&
    sent > named &&
    // `pendingFiles` is the dropped File list with its `_ds/` paths intact.
    // Taking the name from the markup instead is the bug: `inlineAssets` has
    // rewritten every href into a data: URI by then.
    !/nameDesignSystems\((?:docs)?[^)]*\bhtml\b/.test(source);

  return {
    ok,
    detail: `exported=${exported} named@${named} held@${held} sent@${sent}`,
  };
}

/**
 * One export, one variable collection.
 *
 * The demonstrated failure: the three screens of the real Portage export
 * imported one at a time in Map mode produced three collections, each holding
 * the same 125 variables. `system.name` reached the sandbox as the SCREEN's
 * name, and mode (a) matched its collection by that name alone.
 *
 * Everything here uses three DIFFERENT system names deliberately. The panel now
 * makes them agree (`nameDesignSystems`, src/ui/main.ts, asserted in the browser
 * harness), and the sandbox must not be relying on that: identity comes from the
 * manifest's namespace, which is one value for the whole export.
 */
async function scenarioQ(ready: boolean): Promise<void> {
  const p = "Q (one export, one collection):";
  const names = [
    `${p} three screens imported one at a time share one collection holding the union`,
    `${p} the same three imported as one batch land in the same single collection`,
    `${p} Build mode holds the invariant, one at a time and as a batch`,
    `${p} two different systems under one label stay two collections`,
    `${p} a renamed collection is still found by the next screen of the same export`,
    `${p} the panel names the batch before it sends it`,
  ];

  // Source-only, so it stands whether or not the captured IR is on disk.
  const wiring = batchNamedBeforeSent();
  check(names[5], wiring.ok, wiring.detail);

  if (!ready) {
    for (let i = 0; i < 5; i++) skip(names[i], "captured/fixture-screen.json not found");
    return;
  }

  const SCREENS = ["Portage", "Portage Panel", "Portage Panel v1"];
  const KEY = "AcmeDesignSystem_3f2a9c";
  const UNION = [
    "color/acme-green/500",
    "color/acme-green/700",
    "color/acme-grey/100",
    "color/only/0",
    "color/only/1",
    "color/only/2",
  ];

  // --- Map mode, one screen at a time --------------------------------------
  const separate = freshMock();
  const separateSource = seedSourceCollection();
  const mapTarget: VariableTarget = {
    kind: "local",
    collectionId: separateSource,
    createMissing: true,
  };
  for (const doc of exportScreens(SCREENS, KEY)) {
    await buildDocument(doc, mapTarget, () => {});
  }
  const separateOut = importedCollections(separate, separateSource);
  check(
    names[0],
    separateOut.length === 1 &&
      JSON.stringify(variablesIn(separate, separateOut[0].id)) === JSON.stringify(UNION),
    `${separateOut.length} collection(s): ${JSON.stringify(
      separateOut.map((c) => `${c.name}(${variablesIn(separate, c.id).length})`),
    )}`,
  );

  // --- Map mode, the whole export in one import ----------------------------
  const batch = freshMock();
  const batchSource = seedSourceCollection();
  await buildDocuments(
    exportScreens(SCREENS, KEY),
    { kind: "local", collectionId: batchSource, createMissing: true },
    {},
    () => {},
  );
  const batchOut = importedCollections(batch, batchSource);
  check(
    names[1],
    batchOut.length === 1 &&
      JSON.stringify(variablesIn(batch, batchOut[0].id)) === JSON.stringify(UNION),
    `${batchOut.length} collection(s): ${JSON.stringify(
      batchOut.map((c) => `${c.name}(${variablesIn(batch, c.id).length})`),
    )}`,
  );

  // --- Mode (b), both ways -------------------------------------------------
  // `target.name` is the export-level name the panel already passed here, so
  // this half was never the broken one. It is asserted so the two paths cannot
  // drift apart again now that they share `stampedCollection`.
  const buildSeparate = freshMock();
  const buildTarget: VariableTarget = { kind: "build", name: "Acme Design System", modes: true };
  for (const doc of exportScreens(SCREENS, KEY)) {
    await buildDocument(doc, buildTarget, () => {});
  }
  const buildBatch = freshMock();
  await buildDocuments(exportScreens(SCREENS, KEY), buildTarget, {}, () => {});
  const buildSeparateOut = importedCollections(buildSeparate, null);
  const buildBatchOut = importedCollections(buildBatch, null);
  check(
    names[2],
    buildSeparateOut.length === 1 &&
      buildBatchOut.length === 1 &&
      buildSeparateOut[0].name === "Acme Design System" &&
      variablesIn(buildSeparate, buildSeparateOut[0].id).length === UNION.length,
    `separate=${buildSeparateOut.length} batch=${buildBatchOut.length} ` +
      `vars=${variablesIn(buildSeparate, buildSeparateOut[0]?.id ?? "").length}`,
  );

  // --- The reverse: two systems that are genuinely different ---------------
  // Both fall back to the same label, which is what an export with no readable
  // `_ds` folder does. Merging them would hand one design system the other's
  // values under its own names.
  const twoSystems = freshMock();
  await buildDocument(
    systemDoc({
      name: "Design tokens",
      key: "SystemOne_aaaa",
      tokens: [plainColor("one-only", "color/one/only", "#111111")],
    }),
    { kind: "create", name: "" },
    () => {},
  );
  await buildDocument(
    systemDoc({
      name: "Design tokens",
      key: "SystemTwo_bbbb",
      tokens: [plainColor("two-only", "color/two/only", "#222222")],
    }),
    { kind: "create", name: "" },
    () => {},
  );
  const twoOut = importedCollections(twoSystems, null);
  const twoNames = twoOut.map((c) => variablesIn(twoSystems, c.id));
  check(
    names[3],
    twoOut.length === 2 &&
      twoNames.every((list) => list.length === 1) &&
      JSON.stringify(twoNames.flat().sort()) ===
        JSON.stringify(["color/one/only", "color/two/only"]),
    `${twoOut.length} collection(s): ${JSON.stringify(
      twoOut.map((c, i) => `${c.name}=${JSON.stringify(twoNames[i])}`),
    )}`,
  );

  // --- The stamp is what survives a designer's rename ----------------------
  // Renaming the collection is the first thing a designer does with it, and the
  // name match cannot find it afterwards. Without the stamp on the mode (a)
  // path, screen two would create a second collection here.
  const renamed = freshMock();
  const renamedSource = seedSourceCollection();
  const renameTarget: VariableTarget = {
    kind: "local",
    collectionId: renamedSource,
    createMissing: true,
  };
  const renameDocs = exportScreens(SCREENS, KEY);
  await buildDocument(renameDocs[0], renameTarget, () => {});
  const first = importedCollections(renamed, renamedSource)[0];
  const liveCollection = (
    await figma.variables.getLocalVariableCollectionsAsync()
  ).find((c) => c.id === first?.id);
  if (liveCollection) liveCollection.name = "My tokens, tidied";
  await buildDocument(renameDocs[1], renameTarget, () => {});
  const renamedOut = importedCollections(renamed, renamedSource);
  check(
    names[4],
    renamedOut.length === 1 &&
      renamedOut[0].name === "My tokens, tidied" &&
      variablesIn(renamed, renamedOut[0].id).includes("color/only/1"),
    `${renamedOut.length} collection(s): ${JSON.stringify(
      renamedOut.map((c) => `${c.name}(${variablesIn(renamed, c.id).length})`),
    )}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario R: the same document-declared theme, in MAP mode
// ---------------------------------------------------------------------------

/**
 * Scenario P's system plus one token the themes declare and do NOT re-theme.
 *
 * That third token is the control for the routing decision: `dv-surface` and
 * `dv-muted` hold two values and must go where modes are, `dv-accent` holds one
 * and is free to map onto the design system the user already has. Without it,
 * "themed tokens skipped matching" and "matching stopped working" look the same.
 */
function mapThemeSystem(): IRDesignSystem {
  const base = themeAxisSystem();
  return {
    ...base,
    tokens: [
      ...base.tokens,
      {
        name: "dv-accent",
        path: "color/dv-accent",
        buildPath: "color/dv-accent",
        category: "color",
        kind: "COLOR",
        resolved: "#007be5",
        color: hex("#007BE5"),
        declaredIn: [LIGHT, DARK],
        bySurface: {
          [LIGHT]: { resolved: "#007be5", color: hex("#007BE5") },
          [DARK]: { resolved: "#007be5", color: hex("#007BE5") },
        },
      },
    ],
  };
}

/**
 * One themed panel carrying an accent chip alongside its label.
 *
 * The chip's ref is unmarked in both themes, exactly as `tokenRef`
 * (src/ui/tokens.ts) leaves a match against a name the theme holds at the base
 * value. That is the same rule that leaves the whole LIGHT half of a document
 * with no `:root` unmarked, which is why the light panel binds here without
 * being routed anywhere.
 */
function mapThemedPanel(theme: "light" | "dark"): IRDocument {
  const doc = themedPanel(theme);
  const panel = doc.root.children[0];
  const chip: IRNode = {
    kind: "FRAME",
    name: `${theme} chip`,
    x: 12,
    y: 40,
    width: 40,
    height: 16,
    opacity: 1,
    rotation: 0,
    clips: false,
    fills: [
      {
        type: "SOLID",
        color: hex("#007BE5"),
        token: { name: "dv-accent", path: "color/dv-accent", via: "var" },
      },
    ],
    cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    effects: [],
    children: [],
  };
  return {
    ...doc,
    designSystem: mapThemeSystem(),
    root: {
      ...doc.root,
      children: [{ ...panel, children: [...panel.children, chip] }],
    },
  };
}

/**
 * "Acme tokens" as the user has it, with both traps in it.
 *
 * `dv-surface` matches a re-themed token by NAME and `neutral/300` matches
 * another by VALUE (`#B3B3B3` is what light holds). Either match would put a
 * two-valued token in a one-mode collection, which renders Light's colour on
 * the Dark panel and reads as correctly bound in the layer panel. `dv-accent`
 * is the one that SHOULD match: the themes agree on it.
 */
function seedThemeSource(): string {
  const collection = figma.variables.createVariableCollection("Acme tokens");
  const put = (name: string, value: string) => {
    const variable = figma.variables.createVariable(name, collection, "COLOR");
    variable.setValueForMode(collection.defaultModeId, hex(value));
  };
  put("dv-surface", "#FFFFFF");
  put("neutral/300", "#B3B3B3");
  put("dv-accent", "#007BE5");
  return collection.id;
}

/** A collection's modes and every value in it, as one comparable string. */
function collectionSnapshot(
  mock: ReturnType<typeof freshMock>,
  collectionId: string,
): string {
  const collection = mock.getCollections().find((c: any) => c.id === collectionId);
  const variables = mock
    .getVariables()
    .filter((v: any) => v.variableCollectionId === collectionId)
    .map((v: any) => [v.name, v.valuesByMode])
    .sort((a: any, b: any) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({
    modes: (collection?.modes ?? []).map((m: any) => m.name),
    variables,
  });
}

/** The mode ids of one collection by mode name. */
function modeIdsOf(collection: any): Map<string, string> {
  return new Map((collection?.modes ?? []).map((m: any) => [m.name, m.modeId]));
}

/**
 * Map mode with a theme axis, which is where this whole mechanism was missing.
 *
 * `VariableRegistry.themeModes` used to be assigned in exactly one place,
 * inside `buildDesignSystem`, so in Map mode it stayed undefined and
 * `bindableToken` (src/plugin/build.ts) refused every ref carrying a
 * `themeScope`. A user who imported the three-screen Portage export with "map
 * onto my design system" selected got 51 tokens mapped, 74 variables created,
 * and raw `#B3B3B3` / `#1E1E1E` / `#007BE5` fills on the dark panels: the LIGHT
 * values of three `--figma-color-*` names. The refusal was right. The bug was
 * that Map mode never gave those tokens a home where modes exist.
 *
 * Driven through `src/plugin/main.ts`'s own message handler, not through
 * `buildDocuments` directly, because the panel's import path is the one the
 * user was on. The extractor half of the same story (which refs get marked at
 * all) runs in the browser harness against test/fixture/theme-axis.html.
 */
async function scenarioR(ready: boolean): Promise<void> {
  const p = "R (map mode, document-declared theme):";
  const names = [
    `${p} light and dark bind to ONE variable in a collection of ours, mode each`,
    `${p} the collection the user picked is not written to`,
    `${p} a token the themes agree on still maps onto the user's own system`,
    `${p} with "create variables" off the theme stays literal and the summary says why`,
    `${p} a one-mode plan degrades with Build mode's sentence, word for word`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  const docs = () => [mapThemedPanel("light"), mapThemedPanel("dark")];
  const onMessage = await pluginMessageHandler();

  // --- the user's exact configuration ---------------------------------------
  const mock = freshMock();
  const sourceId = seedThemeSource();
  const before = collectionSnapshot(mock, sourceId);
  await onMessage({
    type: "import",
    docs: docs(),
    target: { kind: "local", collectionId: sourceId, createMissing: true },
  });
  const after = collectionSnapshot(mock, sourceId);

  const overflow = mock.getCollections().filter((c: any) => !c.remote && c.id !== sourceId);
  const overflowId = overflow[0]?.id ?? "";
  const modeIds = modeIdsOf(overflow[0]);
  const inOverflow = new Map(
    mock
      .getVariables()
      .filter((v: any) => v.variableCollectionId === overflowId)
      .map((v: any) => [v.name, v]),
  );
  const surface: any = inOverflow.get("color/dv-surface");
  const roots = mock.getRootNodes();
  const lightPanel = mock.serializeTree(roots[0]).children[0];
  const darkPanel = mock.serializeTree(roots[1]).children[0];
  const lightFill = fillOf(lightPanel);
  const darkFill = fillOf(darkPanel);
  const modeValue = (mode: string) =>
    JSON.stringify(surface?.valuesByMode[modeIds.get(mode) ?? ""]);

  check(
    names[0],
    overflow.length === 1 &&
      !!surface &&
      // One variable, two literals inside it. Two variables, or one variable
      // holding one colour, is the shape of the bug.
      lightFill.variableId === surface.id &&
      darkFill.variableId === surface.id &&
      lightFill.hex === "#FFFFFF" &&
      darkFill.hex === "#2C2C2C" &&
      modeValue("Light") === JSON.stringify(hex("#FFFFFF")) &&
      modeValue("Dark") === JSON.stringify(hex("#2C2C2C")) &&
      // Values alone are not enough: without the mode on the frame the dark
      // panel renders the Product column, which holds Light.
      darkPanel.explicitVariableModes[overflowId] === modeIds.get("Dark") &&
      lightPanel.explicitVariableModes[overflowId] === modeIds.get("Light"),
    `overflow=${overflow.length} light=${lightFill.variableId}@${lightFill.hex} ` +
      `dark=${darkFill.variableId}@${darkFill.hex} modes=${JSON.stringify([...modeIds.keys()])} ` +
      `Light=${modeValue("Light")} Dark=${modeValue("Dark")} ` +
      `darkOn=${JSON.stringify(darkPanel.explicitVariableModes)}`,
  );

  check(
    names[1],
    // Byte-for-byte: same modes, same variables, same values per mode. A
    // routed token is one the user's collection has a name or a value for, so
    // "nothing matched" is not what is keeping this green.
    after === before &&
      !mock.getVariables().some((v: any) => v.variableCollectionId === sourceId && v.name.startsWith("color/")),
    `before=${before}\n     after=${after}`,
  );

  const userAccent = mock
    .getVariables()
    .find((v: any) => v.variableCollectionId === sourceId && v.name === "dv-accent");
  const lightChip = fillOf(lightPanel.children[1]);
  const darkChip = fillOf(darkPanel.children[1]);
  const complete = mock.figma.ui.postedMessages.find((m: any) => m.type === "import-complete");
  check(
    names[2],
    !!userAccent &&
      lightChip.variableId === userAccent.id &&
      darkChip.variableId === userAccent.id &&
      // And it was reported as a match, not as one more thing created.
      complete?.mapping.boundByName === 1 &&
      !inOverflow.has("color/dv-accent"),
    `accent=${userAccent?.id} lightChip=${lightChip.variableId} darkChip=${darkChip.variableId} ` +
      `boundByName=${complete?.mapping.boundByName} created=${complete?.mapping.created}`,
  );

  // --- the same import with "create variables" off --------------------------
  const flat = freshMock();
  const flatSource = seedThemeSource();
  const flatBefore = collectionSnapshot(flat, flatSource);
  await onMessage({
    type: "import",
    docs: docs(),
    target: { kind: "local", collectionId: flatSource, createMissing: false },
  });
  const flatRoots = flat.getRootNodes();
  const flatLight = fillOf(flat.serializeTree(flatRoots[0]).children[0]);
  const flatDark = fillOf(flat.serializeTree(flatRoots[1]).children[0]);
  const flatComplete = flat.figma.ui.postedMessages.find(
    (m: any) => m.type === "import-complete",
  );
  const flatNote = (flatComplete?.mapping.samples ?? []).find((line: string) =>
    line.includes("create variables for what it does not cover"),
  );
  check(
    names[3],
    // Nothing created, nothing written to theirs, and the themed fills are the
    // colours the browser rendered rather than a plausible-looking binding.
    flat.getCollections().filter((c: any) => !c.remote).length === 1 &&
      collectionSnapshot(flat, flatSource) === flatBefore &&
      flatLight.variableId === undefined &&
      flatDark.variableId === undefined &&
      flatLight.hex === "#FFFFFF" &&
      flatDark.hex === "#2C2C2C" &&
      // And the user is told, rather than left to click a dark layer and read
      // the inspector, which is how this was reported.
      !!flatNote &&
      flatNote.includes("Dark re-themes 2") &&
      flatNote.includes("imported as literals"),
    `collections=${flat.getCollections().length} light=${flatLight.variableId}@${flatLight.hex} ` +
      `dark=${flatDark.variableId}@${flatDark.hex} note=${JSON.stringify(flatNote)}`,
  );

  // --- a Free team, both modes ----------------------------------------------
  // Figma gates modes per collection on the file's plan and there is no
  // capability query to ask first. Map mode reaches that refusal through the
  // same `reconcileModes` call Build mode does, so the user gets one sentence
  // about it and not two wordings of the same fact.
  const cappedMap = freshMock({ modeLimit: 1 });
  const cappedSource = seedThemeSource();
  await onMessage({
    type: "import",
    docs: docs(),
    target: { kind: "local", collectionId: cappedSource, createMissing: true },
  });
  const cappedMapComplete = cappedMap.figma.ui.postedMessages.find(
    (m: any) => m.type === "import-complete",
  );
  const mapNote = (cappedMapComplete?.mapping.samples ?? []).find((line: string) =>
    line.includes("plan allows"),
  );
  const cappedOverflow = cappedMap
    .getCollections()
    .filter((c: any) => !c.remote && c.id !== cappedSource)[0];
  // Their own `dv-surface`. With no second mode available nothing is routed
  // away from their design system, which is the whole point of Map mode and is
  // safe: the light half is not theme-scoped, and the dark half is refused
  // whether it would have bound here or in an overflow collection.
  const cappedSurface: any = cappedMap
    .getVariables()
    .find((v: any) => v.variableCollectionId === cappedSource && v.name === "dv-surface");
  const cappedRoots = cappedMap.getRootNodes();
  const cappedLightPanel = cappedMap.serializeTree(cappedRoots[0]).children[0];
  const cappedDarkPanel = cappedMap.serializeTree(cappedRoots[1]).children[0];
  const cappedLight = fillOf(cappedLightPanel);
  const cappedDark = fillOf(cappedDarkPanel);

  const cappedBuild = freshMock({ modeLimit: 1 });
  await onMessage({
    type: "import",
    docs: docs(),
    target: { kind: "build", name: "Panel Theme", modes: true },
  });
  const buildNote = (
    cappedBuild.figma.ui.postedMessages.find((m: any) => m.type === "import-complete")
      ?.mapping.samples ?? []
  ).find((line: string) => line.includes("plan allows"));

  check(
    names[4],
    !!mapNote &&
      // Word for word, because two wordings of one fact is how a user ends up
      // believing the two modes fail differently.
      mapNote === buildNote &&
      cappedOverflow?.modes.length === 1 &&
      // The base mode holds Light, so the light half still binds and is right.
      cappedLight.variableId === cappedSurface?.id &&
      cappedLight.hex === "#FFFFFF" &&
      // Dark has nowhere correct to bind, so it stays the literal the browser
      // rendered and carries no mode.
      cappedDark.variableId === undefined &&
      cappedDark.hex === "#2C2C2C" &&
      Object.keys(cappedDarkPanel.explicitVariableModes).length === 0,
    `mapNote=${JSON.stringify(mapNote)}\n     buildNote=${JSON.stringify(buildNote)}\n     ` +
      `modes=${cappedOverflow?.modes.length} light=${cappedLight.variableId}@${cappedLight.hex} ` +
      `dark=${cappedDark.variableId}@${cappedDark.hex}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario S: two screens of one export declaring one token at two values
// ---------------------------------------------------------------------------

const DX_LIGHT = ".dx-theme-light";
const DX_DARK = ".dx-theme-dark";

/**
 * One token declared in both themes and in no `:root`.
 *
 * The base value is the LIGHT one, because that is what `applySurfaces`
 * (src/ui/tokens.ts) gives a document with no `:root` and it decides which half
 * of each screen is theme-scoped at all.
 */
function dxToken(name: string, light: string, dark: string): IRTokenDefinition {
  return {
    name,
    path: `color/${name}`,
    buildPath: `color/${name}`,
    category: "color",
    kind: "COLOR",
    resolved: light.toLowerCase(),
    color: hex(light),
    declaredIn: [DX_LIGHT, DX_DARK],
    bySurface: {
      [DX_LIGHT]: { resolved: light.toLowerCase(), color: hex(light) },
      [DX_DARK]: { resolved: dark.toLowerCase(), color: hex(dark) },
    },
  };
}

/**
 * The design system one screen of a two-screen export carries.
 *
 * Modelled on test/fixture/divergent-a.html and divergent-b.html, which the
 * browser harness runs through the real extractor to prove this shape is one it
 * actually produces. Four names, and the two screens disagree about two of
 * them in two different ways:
 *
 *   dx-surface  identical in both themes      binds in both screens
 *   dx-text     identical in both themes      binds in both screens
 *   dx-muted    differs in BOTH themes        binds in neither theme of screen B
 *   dx-line     differs in the DARK theme     binds in screen B's light half only
 *
 * The last row is what a per-token answer gets wrong, and it is not invented:
 * the real export's `--figma-color-text-secondary` differs everywhere while its
 * `--figma-color-bg-selected` differs only inside `.cd2f-theme-dark`. Values
 * are the export's own; the export itself is not committed, it references an
 * internal design system and this repo is headed for public.
 */
/**
 * A base-layer ramp both screens agree on, which the designer's own library
 * also has by name.
 *
 * Here to spend the summary's sample budget, which is the only reason its size
 * matters: `pushSample` (src/plugin/mapping.ts) stops at eight lines, Map mode
 * writes one line per matched token, and the export this was reported against
 * matched fifty-one. A note about layers rendering the wrong colour that lands
 * at position nine is a note nobody reads, so leading with it is part of the
 * fix and has to be a thing a test can fail.
 */
const DX_RAMP = [
  "#101010",
  "#202020",
  "#303030",
  "#404040",
  "#505050",
  "#606060",
  "#707070",
  "#808080",
];

function dxRamp(): IRTokenDefinition[] {
  return DX_RAMP.map((value, index) => ({
    name: `dx-ramp-${index}`,
    path: `color/dx-ramp/${index}`,
    buildPath: `color/dx-ramp/${index}`,
    category: "color" as const,
    kind: "COLOR" as const,
    resolved: value.toLowerCase(),
    color: hex(value),
    declaredIn: [""],
  }));
}

/** The same ramp as the user already has it, so Map mode matches all eight by name. */
function seedDxSource(): string {
  const collection = figma.variables.createVariableCollection("The designer's own library");
  for (let index = 0; index < DX_RAMP.length; index++) {
    const variable = figma.variables.createVariable(`dx-ramp-${index}`, collection, "COLOR");
    variable.setValueForMode(collection.defaultModeId, hex(DX_RAMP[index]));
  }
  return collection.id;
}

function dxSystem(screen: "A" | "B"): IRDesignSystem {
  return {
    name: "Divergent System",
    // One key, because these are two screens of ONE export and they land in one
    // collection (scenario Q). Two collections would hide the conflict rather
    // than fix it, which is the option commit 64c7736 closed off.
    key: "DivergentSystem_3f2a9c",
    surfaces: [
      { selector: DX_LIGHT, label: "Light" },
      { selector: DX_DARK, label: "Dark" },
    ],
    axis: [DX_LIGHT, DX_DARK],
    tokens: [
      dxToken("dx-surface", "#FFFFFF", "#2C2C2C"),
      dxToken("dx-text", "#1E1E1E", "#FFFFFF"),
      dxToken("dx-muted", screen === "A" ? "#767676" : "#757575", screen === "A" ? "#7E7E7E" : "#7A7A7A"),
      dxToken("dx-line", "#E6E6E6", screen === "A" ? "#444444" : "#333333"),
      ...dxRamp(),
    ],
  };
}

/**
 * One screen, both themed panels, three fills apiece.
 *
 * The refs mirror `tokenRef` (src/ui/tokens.ts) exactly: the dark half carries
 * the selector because every one of these tokens differs from the base there,
 * and the light half is unmarked because the base layer IS light. Hand-written
 * for the same reason scenarios P and R hand-write theirs, so this scenario is
 * about what the BUILDER does with each kind.
 */
function dxDoc(screen: "A" | "B"): IRDocument {
  const system = dxSystem(screen);
  const byName = new Map(system.tokens.map((token) => [token.name, token]));

  const swatch = (name: string, theme: "light" | "dark", index: number): IRNode => {
    const token = byName.get(name)!;
    const value = theme === "light" ? token.color! : token.bySurface![DX_DARK].color!;
    return {
      kind: "FRAME",
      name: `${screen} ${theme} ${name}`,
      x: 12 + index * 28,
      y: 20,
      width: 20,
      height: 20,
      opacity: 1,
      rotation: 0,
      clips: false,
      fills: [
        {
          type: "SOLID",
          color: value,
          token: {
            name: token.name,
            path: token.path,
            via: "var",
            ...(theme === "dark" ? { themeScope: DX_DARK } : {}),
          },
        },
      ],
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      effects: [],
      children: [],
    };
  };

  const panel = (theme: "light" | "dark"): IRNode => {
    const surface = byName.get("dx-surface")!;
    return {
      kind: "FRAME",
      name: `${screen} ${theme} panel`,
      x: 0,
      y: theme === "light" ? 0 : 80,
      width: 200,
      height: 60,
      opacity: 1,
      rotation: 0,
      clips: false,
      themeScope: theme === "light" ? DX_LIGHT : DX_DARK,
      fills: [
        {
          type: "SOLID",
          color: theme === "light" ? surface.color! : surface.bySurface![DX_DARK].color!,
          token: {
            name: surface.name,
            path: surface.path,
            via: "var",
            ...(theme === "dark" ? { themeScope: DX_DARK } : {}),
          },
        },
      ],
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      effects: [],
      children: [swatch("dx-line", theme, 0), swatch("dx-muted", theme, 1)],
    };
  };

  const base = loadCaptured(FIXTURE_PATH);
  return {
    ...base,
    name: `Screen ${screen}`,
    designSystem: system,
    warnings: [],
    root: {
      ...base.root,
      name: `Screen ${screen}`,
      x: 0,
      y: 0,
      width: 200,
      height: 140,
      layout: undefined,
      fills: [],
      children: [panel("light"), panel("dark")],
    },
  };
}

/** Every fill of one built screen, in a fixed order, bound or not. */
function dxFills(mock: ReturnType<typeof freshMock>, root: any) {
  const tree = mock.serializeTree(root);
  const light = tree.children[0];
  const dark = tree.children[1];
  return {
    lightSurface: fillOf(light),
    lightLine: fillOf(light.children[0]),
    lightMuted: fillOf(light.children[1]),
    darkSurface: fillOf(dark),
    darkLine: fillOf(dark.children[0]),
    darkMuted: fillOf(dark.children[1]),
  };
}

/**
 * The six fills as one comparable string: bound or literal, and at what colour.
 *
 * Colour included deliberately. "Literal" alone would pass for a screen that
 * imported the wrong hex as a literal, which is the same wrong pixel with the
 * binding removed.
 */
function dxSignature(fills: ReturnType<typeof dxFills>): string {
  return Object.entries(fills)
    .map(([key, fill]) => `${key}=${fill.variableId ? "bound" : "literal"}@${fill.hex}`)
    .join(" ");
}

/**
 * Two screens of one export whose design systems disagree.
 *
 * The demonstrated failure: `mergeDesignSystems` (src/plugin/build.ts) keys the
 * batch's tokens by path and keeps the first value, and every screen then binds
 * to it. On the real three-screen Portage export that put seven text runs in
 * `Portage Panel v1` on a variable holding `#767676` while the browser had
 * rendered `#757575`, in Build mode and in Map mode alike, with every counter
 * in the summary reading correct.
 *
 * The rule now is: first declaration owns the variable, and a screen whose
 * value genuinely differs does not bind it. Every screen then renders what it
 * rendered in the browser, which is the same thing `bindableToken` already does
 * for a theme with no mode.
 *
 * Driven through `src/plugin/main.ts`'s own message handler rather than
 * `buildDocuments` directly, because a batch import is only ever reached that
 * way. The extractor half (that two documents really do produce one path with
 * two values) runs in the browser harness against test/fixture/divergent-a.html
 * and divergent-b.html.
 */
async function scenarioS(ready: boolean): Promise<void> {
  const p = "S (two screens, one token, two values):";
  const names = [
    `${p} one variable holds the first screen's value, and that screen binds to it`,
    `${p} the second screen's diverging layers stay literal, at its own colour`,
    `${p} a token the two screens agree on still binds in the second screen`,
    `${p} one they agree on in light and differ on in dark binds in light only`,
    `${p} Map mode refuses exactly the layers Build mode refuses`,
    `${p} the summary names the tokens, the screens and what happened on canvas`,
    `${p} the second screen imported alone binds everything, refusals included`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  const docs = () => [dxDoc("A"), dxDoc("B")];
  const onMessage = await pluginMessageHandler();
  const BUILD: VariableTarget = { kind: "build", name: "Divergent System", modes: true };

  // --- Build mode -----------------------------------------------------------
  const mock = freshMock();
  await onMessage({ type: "import", docs: docs(), target: BUILD });
  const roots = mock.getRootNodes();
  const buildA = dxFills(mock, roots[0]);
  const buildB = dxFills(mock, roots[1]);
  const { collection, byName } = builtVariables(mock);
  const modeIds = modeIdsOf(collection);
  const muted: any = byName.get("color/dx-muted");
  const line: any = byName.get("color/dx-line");
  const surface: any = byName.get("color/dx-surface");
  const value = (variable: any, mode: string) =>
    JSON.stringify(variable?.valuesByMode[modeIds.get(mode) ?? ""]);

  check(
    names[0],
    !!muted &&
      // One variable for the name, not one per screen: two collections or two
      // variables would be the alternative fix commit 64c7736 ruled out.
      mock.getVariables().filter((v: any) => v.name === "color/dx-muted").length === 1 &&
      value(muted, "Light") === JSON.stringify(hex("#767676")) &&
      value(muted, "Dark") === JSON.stringify(hex("#7E7E7E")) &&
      buildA.lightMuted.variableId === muted.id &&
      buildA.lightMuted.hex === "#767676" &&
      buildA.darkMuted.variableId === muted.id &&
      buildA.darkMuted.hex === "#7E7E7E",
    `light=${value(muted, "Light")} dark=${value(muted, "Dark")} ` +
      `A=${buildA.lightMuted.variableId}@${buildA.lightMuted.hex}/${buildA.darkMuted.hex}`,
  );

  check(
    names[1],
    // Unbound, and carrying the colour the browser rendered for THIS screen.
    // Unbound at #767676 would be the same wrong pixel with the binding taken
    // off, so the hex is half the assertion.
    buildB.lightMuted.variableId === undefined &&
      buildB.lightMuted.hex === "#757575" &&
      buildB.darkMuted.variableId === undefined &&
      buildB.darkMuted.hex === "#7A7A7A",
    `light=${buildB.lightMuted.variableId}@${buildB.lightMuted.hex} ` +
      `dark=${buildB.darkMuted.variableId}@${buildB.darkMuted.hex}`,
  );

  check(
    names[2],
    // The clause that separates a fix from unbinding the whole second screen.
    buildB.lightSurface.variableId === surface?.id &&
      buildB.lightSurface.hex === "#FFFFFF" &&
      buildB.darkSurface.variableId === surface?.id &&
      buildB.darkSurface.hex === "#2C2C2C",
    `light=${buildB.lightSurface.variableId}@${buildB.lightSurface.hex} ` +
      `dark=${buildB.darkSurface.variableId}@${buildB.darkSurface.hex}`,
  );

  check(
    names[3],
    // Per token per MODE. The two screens hold dx-line at one value in light
    // and two in dark, so B's light swatch is a correct binding and refusing it
    // would be throwing one away.
    buildB.lightLine.variableId === line?.id &&
      buildB.lightLine.hex === "#E6E6E6" &&
      buildB.darkLine.variableId === undefined &&
      buildB.darkLine.hex === "#333333" &&
      // And the owner's dark swatch is untouched by any of it.
      buildA.darkLine.variableId === line?.id &&
      buildA.darkLine.hex === "#444444",
    `B light=${buildB.lightLine.variableId}@${buildB.lightLine.hex} ` +
      `B dark=${buildB.darkLine.variableId}@${buildB.darkLine.hex} ` +
      `A dark=${buildA.darkLine.variableId}@${buildA.darkLine.hex}`,
  );

  // --- Map mode, same batch -------------------------------------------------
  const mapped = freshMock();
  const mapSource = seedDxSource();
  await onMessage({
    type: "import",
    docs: docs(),
    target: { kind: "local", collectionId: mapSource, createMissing: true },
  });
  const mapRoots = mapped.getRootNodes();
  const mapA = dxFills(mapped, mapRoots[0]);
  const mapB = dxFills(mapped, mapRoots[1]);
  check(
    names[4],
    // Which variable each layer landed on differs between the modes, so the
    // signature compares the decision and the rendered colour rather than ids.
    dxSignature(mapA) === dxSignature(buildA) &&
      dxSignature(mapB) === dxSignature(buildB) &&
      dxSignature(mapB).includes("lightMuted=literal@#757575") &&
      dxSignature(mapB).includes("darkLine=literal@#333333"),
    `map A=${dxSignature(mapA)}\n     build A=${dxSignature(buildA)}\n     ` +
      `map B=${dxSignature(mapB)}\n     build B=${dxSignature(buildB)}`,
  );

  const buildSamples =
    mock.figma.ui.postedMessages.find((m: any) => m.type === "import-complete")?.mapping
      .samples ?? [];
  const mapSamples =
    mapped.figma.ui.postedMessages.find((m: any) => m.type === "import-complete")?.mapping
      .samples ?? [];
  const buildNote = buildSamples.find((line: string) => line.includes("declares"));
  const mapNote = mapSamples.find((line: string) => line.includes("declares"));
  check(
    names[5],
    !!buildNote &&
      // Word for word between the two modes, for the same reason `modeCapNote`
      // is: two wordings of one fact is how a user ends up believing the two
      // modes fail differently.
      buildNote === mapNote &&
      buildNote ===
        "Screen B declares dx-line and dx-muted at different values from Screen A, which " +
          "declared them first. One name is one variable, so Screen A's values are what the " +
          "file holds and the affected layers in Screen B imported as literals rather than " +
          "binding to a colour they do not render." &&
      // First line of both summaries, with the budget genuinely full: the eight
      // ramp tokens match by name and each one writes a sample, so an appended
      // note is a note that never reaches the panel. That is what makes this
      // clause bite rather than describe.
      mapSamples.length === 8 &&
      mapSamples.filter((line: string) => line.includes("→")).length === 7 &&
      mapSamples[0] === mapNote &&
      buildSamples[0] === buildNote,
    `build=${JSON.stringify(buildNote)}\n     map=${JSON.stringify(mapNote)}\n     ` +
      `mapSamples=${JSON.stringify(mapSamples)}`,
  );

  // --- Screen B on its own --------------------------------------------------
  // The control for all of the above. Nothing is wrong with screen B: it is
  // wrong only next to a screen that got to the name first, and imported alone
  // it binds every one of the layers the batch refused.
  const alone = freshMock();
  await onMessage({ type: "import", docs: [dxDoc("B")], target: BUILD });
  const aloneB = dxFills(alone, alone.getRootNodes()[0]);
  const aloneVars = builtVariables(alone);
  const aloneMuted: any = aloneVars.byName.get("color/dx-muted");
  const aloneModes = modeIdsOf(aloneVars.collection);
  const aloneSamples =
    alone.figma.ui.postedMessages.find((m: any) => m.type === "import-complete")?.mapping
      .samples ?? [];
  check(
    names[6],
    aloneB.lightMuted.variableId === aloneMuted?.id &&
      aloneB.lightMuted.hex === "#757575" &&
      aloneB.darkMuted.variableId === aloneMuted?.id &&
      aloneB.darkMuted.hex === "#7A7A7A" &&
      aloneB.darkLine.variableId !== undefined &&
      aloneB.darkLine.hex === "#333333" &&
      JSON.stringify(aloneMuted?.valuesByMode[aloneModes.get("Dark") ?? ""]) ===
        JSON.stringify(hex("#7A7A7A")) &&
      // And nothing to report, because nothing disagreed.
      !aloneSamples.some((line: string) => line.includes("declares")),
    `${dxSignature(aloneB)} samples=${JSON.stringify(aloneSamples)}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario T: a select's synthesised chevron is pinned, not stacked
// ---------------------------------------------------------------------------

/**
 * A native <select>'s frame the way formControlNode builds it: an auto-layout
 * field with the option text flowing and centred, plus the chevron the walk
 * can't see marked `absolute` so it overlays the trailing arrow band. Standing
 * in for the real capture, which is gitignored, so the builder side of the fix
 * is exercised on every run rather than only when a real export is on disk.
 */
async function scenarioX(ready: boolean): Promise<void> {
  const p = "X (layout fixes from real-Figma runs):";
  const names = [
    `${p} a baseline-aligned row is BASELINE in Figma, not CENTER`,
    `${p} a fixed-width text keeps its width instead of hugging its words`,
    `${p} a spacer child fills the row`,
    `${p} one line ending in a space keeps its measured width (Figma's auto width drops the space)`,
    `${p} a bordered auto-layout frame includes its strokes in layout, as CSS border-box does`,
  ];
  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }
  const mock = freshMock();
  const doc = selectFieldDoc();
  const run = { ...doc.root.children[0].children[0].text!.runs[0] };
  const plain = { opacity: 1, rotation: 0, clips: false, cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 }, effects: [], fills: [] };
  const glyph: IRNode = { ...plain, kind: "TEXT", name: "\u25E7", x: 0, y: 0, width: 16, height: 20,
    sizing: { horizontal: "FIXED", vertical: "FIXED" },
    text: { characters: "\u25E7", runs: [{ ...run, end: 1 }], align: "CENTER", verticalAlign: "TOP", singleLine: true, fixedWidth: true },
    children: [] } as IRNode;
  const spacer: IRNode = { ...plain, kind: "FRAME", name: "Spacer", x: 26, y: 0, width: 100, height: 1,
    sizing: { horizontal: "FILL", vertical: "FIXED" }, grow: true, children: [] } as IRNode;
  const row: IRNode = { ...plain, kind: "FRAME", name: "Row", x: 0, y: 0, width: 300, height: 20,
    border: { weights: { top: 1, right: 1, bottom: 1, left: 1 }, paint: { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }, dashed: false },
    layout: { mode: "HORIZONTAL", gap: 10, crossGap: 0, wrap: false, padding: { top: 0, right: 0, bottom: 0, left: 0 },
      primaryAlign: "MIN", crossAlign: "BASELINE", source: "explicit-flex" },
    children: [glyph, spacer] } as IRNode;
  const lead: IRNode = { ...plain, kind: "TEXT", name: "More about me", x: 0, y: 40, width: 100, height: 20,
    text: { characters: "More about me ", runs: [{ ...run, end: 14 }], align: "LEFT", verticalAlign: "TOP", singleLine: true },
    children: [] } as IRNode;
  doc.root.children = [row, lead];
  const result = await buildDocument(doc, { kind: "none" }, () => {});
  const raw = mock.getRootNodes()[0];
  const find = (node: any, name: string): any => node.name === name ? node : (node.children ?? []).map((c: any) => find(c, name)).find(Boolean) ?? null;
  const builtRow = find(raw, "Row");
  const builtGlyph = find(raw, "\u25E7");
  const builtSpacer = find(raw, "Spacer");
  check(names[0], builtRow?.counterAxisAlignItems === "BASELINE", String(builtRow?.counterAxisAlignItems));
  check(names[1], builtGlyph?.textAutoResize === "HEIGHT" && builtGlyph?.width === 16, `${builtGlyph?.textAutoResize} w=${builtGlyph?.width}`);
  check(names[2], builtSpacer?.layoutGrow === 1 || builtSpacer?.layoutSizingHorizontal === "FILL", `${builtSpacer?.layoutGrow} ${builtSpacer?.layoutSizingHorizontal}`);
  const builtLead = find(raw, "More about me");
  check(names[3], builtLead?.textAutoResize === "HEIGHT" && builtLead?.width >= 100, `${builtLead?.textAutoResize} w=${builtLead?.width}`);
  check(names[4], builtRow?.strokesIncludedInLayout === true, String(builtRow?.strokesIncludedInLayout));
  void result;
}

async function scenarioY(ready: boolean): Promise<void> {
  const p = "Y (components):";
  const names = [
    `${p} the first of three identical cards is the main component, in place`,
    `${p} the other two are its instances, where their copies were`,
    `${p} each instance keeps its own words`,
    `${p} a card that differs in shape stays a plain frame`,
    `${p} a component whose only copy could not be an instance goes back to a plain frame`,
  ];
  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }
  const mock = freshMock();
  const doc = selectFieldDoc();
  const run = { ...doc.root.children[0].children[0].text!.runs[0] };
  const plain = { opacity: 1, rotation: 0, clips: false, cornerRadius: { tl: 8, tr: 8, br: 8, bl: 8 }, effects: [] };
  const card = (title: string, x: number, width = 200): IRNode => ({
    ...plain, kind: "FRAME", name: "Stat card", x, y: 0, width, height: 80,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
    children: [{ ...plain, cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 }, kind: "TEXT", name: title, x: 16, y: 16, width: 120, height: 20, fills: [],
      text: { characters: title, runs: [{ ...run, end: title.length }], align: "LEFT", verticalAlign: "TOP", singleLine: true, fixedWidth: true },
      children: [] }],
  } as IRNode);
  doc.root.children = [card("Sunday", 0), card("Leads", 220), card("Spend", 440), card("Odd one", 660, 240)];
  markComponents(doc.root);
  await buildDocument(doc, { kind: "none" }, () => {});
  const raw = mock.getRootNodes()[0];
  const tree = mock.serializeTree(raw);
  const kids = tree.children;
  check(names[0], kids[0]?.type === "COMPONENT" && kids[0].x === 0, `${kids[0]?.type} x=${kids[0]?.x}`);
  check(names[1], kids[1]?.type === "INSTANCE" && kids[2]?.type === "INSTANCE" && kids[1].mainComponentId === kids[0].id && kids[2].mainComponentId === kids[0].id && kids[1].x === 220 && kids[2].x === 440,
    JSON.stringify(kids.slice(1, 3).map((k: any) => [k.type, k.mainComponentId, k.x])));
  check(names[2], kids[0]?.children?.[0]?.characters === "Sunday" && kids[1]?.children?.[0]?.characters === "Leads" && kids[2]?.children?.[0]?.characters === "Spend",
    JSON.stringify(kids.map((k: any) => k.children?.[0]?.characters)));
  check(names[3], kids[3]?.type === "FRAME" && kids.length === 4, `${kids[3]?.type} n=${kids.length}`);

  // Two hugging labels whose words differ in width: the instance's text would
  // keep the main's width here, so the copy stays, and the main is undone.
  const mock2 = freshMock();
  const doc2 = selectFieldDoc();
  const pill = (label: string, x: number, w: number): IRNode => ({
    ...plain, kind: "FRAME", name: "Pill", x, y: 0, width: 100, height: 30,
    fills: [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9, a: 1 } }],
    children: [{ ...plain, cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 }, kind: "TEXT", name: label, x: 8, y: 6, width: w, height: 18, fills: [],
      text: { characters: label, runs: [{ ...run, end: label.length }], align: "LEFT", verticalAlign: "TOP", singleLine: true },
      children: [] }],
  } as IRNode);
  doc2.root.children = [pill("Go", 0, 20), pill("Longer", 120, 60)];
  markComponents(doc2.root);
  await buildDocument(doc2, { kind: "none" }, () => {});
  const kids2 = mock2.serializeTree(mock2.getRootNodes()[0]).children;
  check(names[4], kids2.length === 2 && kids2.every((k: any) => k.type === "FRAME") && kids2[0].name === "Pill",
    JSON.stringify(kids2.map((k: any) => [k.type, k.name, k.x])));
}

async function scenarioW(ready: boolean): Promise<void> {
  const p = "W (animation scenes play themselves):";
  const names = [
    `${p} each scene waits out its duration, then Smart Animates to the next`,
    `${p} a looping animation returns from its last scene to its first`,
  ];
  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }
  const mock = freshMock();
  const result = await buildDocuments(
    [batchDoc("Scene 1"), batchDoc("Scene 2"), batchDoc("Scene 3")],
    { kind: "none" },
    { columns: 3 },
    () => {},
    {
      flow: {
        name: "Mini animation",
        startIndex: 0,
        edges: [
          { from: 0, to: 1, delay: 1.5, smart: true },
          { from: 1, to: 2, delay: 2.2, smart: true },
          { from: 2, to: 0, delay: 1.8, smart: true },
        ],
        section: null,
      },
    },
  );
  const trees = result.roots.map((root: any) => mock.serializeTree(root));
  const first = trees[0].reactions?.[0];
  const second = trees[1].reactions?.[0];
  check(
    names[0],
    first?.trigger?.type === "AFTER_TIMEOUT" &&
      first?.trigger?.timeout === 1.5 &&
      first?.actions?.[0]?.transition?.type === "SMART_ANIMATE" &&
      first?.actions?.[0]?.destinationId === result.roots[1].id &&
      second?.trigger?.timeout === 2.2,
    JSON.stringify(first),
  );
  const back = trees[2].reactions?.[0];
  check(names[1], back?.actions?.[0]?.destinationId === result.roots[0].id && back?.trigger?.timeout === 1.8, JSON.stringify(back));
}

async function scenarioV(ready: boolean): Promise<void> {
  const p = "V (fidelity fields reach Figma):";
  const names = [
    `${p} a rotated layer is turned by the negated angle about its centre`,
    `${p} a truncated text keeps its width and cuts at maxLines`,
    `${p} gradient text is a gradient fill on the text node`,
    `${p} the font stack lands on the first family Figma has`,
    `${p} blend mode and a CSS background image reach the frame`,
  ];
  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  const mock = freshMock();
  const doc = selectFieldDoc();
  const PNG_8 =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4/58BK2IYlRgsEgC1jz/BtRaXFQAAAABJRU5ErkJggg==";
  const plain = { opacity: 1, clips: false, cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 }, effects: [], children: [] };
  const run = { ...(doc.root.children[0].children[0].text!.runs[0]), fontFamily: "No Such Font", fontStack: ["No Such Font", "Roboto", "sans-serif"] };
  doc.root.children = [
    { ...plain, kind: "FRAME", name: "Rotated", x: 100, y: 50, width: 100, height: 40, rotation: 12,
      fills: [{ type: "SOLID", color: { r: 1, g: 0.8, b: 0, a: 1 } }] } as IRNode,
    { ...plain, kind: "TEXT", name: "Truncated", x: 0, y: 120, width: 120, height: 18, rotation: 0, fills: [],
      text: { characters: "A long line cut off at the end", runs: [{ ...run, end: 30 }], align: "LEFT", verticalAlign: "TOP",
        singleLine: true, maxLines: 1,
        glyphFill: { type: "GRADIENT_LINEAR", angle: 90, stops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] } } } as IRNode,
    { ...plain, kind: "FRAME", name: "Blended", x: 0, y: 160, width: 64, height: 64, rotation: 0, blendMode: "multiply",
      fills: [{ type: "IMAGE", bytesBase64: PNG_8, scaleMode: "FILL" }] } as IRNode,
  ];

  const result = await buildDocument(doc, { kind: "none" }, () => {});
  const tree = mock.serializeTree(result.root);
  const find = (name: string) => tree.children.find((c: any) => c.name === name);
  const rotated = find("Rotated");
  check(
    names[0],
    rotated?.rotation === -12 && Math.abs(rotated.x - 105.25) < 0.1 && Math.abs(rotated.y - 40.04) < 0.1,
    `rot=${rotated?.rotation} x=${rotated?.x} y=${rotated?.y}`,
  );
  const raw = mock.getRootNodes()[0];
  const findRaw = (node: any, name: string): any =>
    node.name === name ? node : (node.children ?? []).map((c: any) => findRaw(c, name)).find(Boolean) ?? null;
  const cut = findRaw(raw, "Truncated");
  check(
    names[1],
    cut?.textTruncation === "ENDING" && cut?.maxLines === 1 && cut?.textAutoResize === "HEIGHT" && cut?.width === 120,
    `trunc=${cut?.textTruncation} lines=${cut?.maxLines} resize=${cut?.textAutoResize} w=${cut?.width}`,
  );
  check(names[2], cut?.fills?.[0]?.type === "GRADIENT_LINEAR", JSON.stringify(cut?.fills?.[0]?.type));
  check(
    names[3],
    cut?.fontName?.family === "Roboto" && result.substitutions.some((s: string) => s.includes("No Such Font → Roboto")),
    `font=${JSON.stringify(cut?.fontName)} subs=${JSON.stringify(result.substitutions)}`,
  );
  const blended = findRaw(raw, "Blended");
  check(
    names[4],
    blended?.blendMode === "MULTIPLY" && blended?.fills?.[0]?.type === "IMAGE" && !!blended?.fills?.[0]?.imageHash,
    `blend=${blended?.blendMode} fill=${JSON.stringify(blended?.fills?.[0])}`,
  );
}

async function scenarioU(ready: boolean): Promise<void> {
  const p = "U (a listed font that refuses to load):";
  const names = [
    `${p} the screen still builds instead of failing on the first label`,
    `${p} the text lands in Inter Regular and the substitution is reported`,
  ];
  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  // Roboto Regular is in the file's font list, so it is resolved to, and then
  // it will not load. Before, that font went straight onto `fontName` and
  // Figma threw outside any handler.
  const mock = freshMock({ unloadableFonts: [{ family: "Roboto", style: "Regular" }] });
  const doc = selectFieldDoc();
  const retarget = (node: IRNode): void => {
    for (const run of node.text?.runs ?? []) run.fontFamily = "Roboto";
    for (const child of node.children ?? []) retarget(child);
  };
  retarget(doc.root);

  let result;
  try {
    result = await buildDocument(doc, { kind: "none" }, () => {});
    check(names[0], true);
  } catch (err) {
    check(names[0], false, String((err as Error)?.message ?? err));
    check(names[1], false, "build threw, cannot evaluate");
    return;
  }

  const texts: any[] = [];
  (function collect(node: any) {
    if (node.type === "TEXT") texts.push(node);
    for (const child of node.children ?? []) collect(child);
  })(mock.serializeTree(result.root));
  check(
    names[1],
    texts.length > 0 &&
      texts.every((t) => t.fontName?.family === "Inter" && t.fontName?.style === "Regular") &&
      result.substitutions.some((s: string) => s.includes("Roboto Regular") && s.includes("could not load")),
    `fonts=${JSON.stringify(texts.map((t) => t.fontName))} subs=${JSON.stringify(result.substitutions)}`,
  );
}

function selectFieldDoc(): IRDocument {
  const base = loadCaptured(FIXTURE_PATH);
  const run = {
    start: 0,
    end: 15,
    fontFamily: "Inter",
    fontWeight: 400,
    italic: false,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0,
    fill: { type: "SOLID" as const, color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
    decoration: "NONE" as const,
    textCase: "ORIGINAL" as const,
  };
  const text: IRNode = {
    kind: "TEXT",
    name: "Semantic tokens",
    x: 11,
    y: 5,
    width: 100,
    height: 14,
    opacity: 1,
    rotation: 0,
    clips: false,
    sizing: { horizontal: "HUG", vertical: "FIXED" },
    fills: [],
    cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    effects: [],
    text: {
      characters: "Semantic tokens",
      runs: [run],
      align: "LEFT",
      verticalAlign: "CENTER",
      singleLine: true,
    },
    children: [],
  };
  const arrow: IRNode = {
    kind: "VECTOR",
    name: "Dropdown arrow",
    x: 340,
    y: 9,
    width: 10,
    height: 6,
    opacity: 1,
    rotation: 0,
    clips: false,
    absolute: true,
    fills: [],
    cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    effects: [],
    svg:
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="6" viewBox="0 0 10 6" ' +
      'fill="none"><path d="M1 1.25 5 4.75 9 1.25" stroke="rgb(26, 26, 26)" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    children: [],
  };
  const field: IRNode = {
    kind: "FRAME",
    name: "Collection picker",
    x: 0,
    y: 0,
    width: 360,
    height: 24,
    opacity: 1,
    rotation: 0,
    clips: false,
    layout: {
      mode: "VERTICAL",
      gap: 0,
      crossGap: 0,
      wrap: false,
      padding: { top: 0, right: 20, bottom: 0, left: 11 },
      primaryAlign: "CENTER",
      crossAlign: "MIN",
      source: "inferred-stack",
      hugContent: false,
    },
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
    cornerRadius: { tl: 4, tr: 4, br: 4, bl: 4 },
    effects: [],
    children: [text, arrow],
  };
  return {
    ...base,
    name: "Select chevron",
    designSystem: undefined,
    warnings: [],
    root: {
      ...base.root,
      name: "Select chevron root",
      x: 0,
      y: 0,
      width: 400,
      height: 100,
      layout: undefined,
      children: [field],
    },
  };
}

async function scenarioT(ready: boolean): Promise<void> {
  const p = "T (select chevron pinned in its arrow band):";
  const names = [
    `${p} buildDocument resolves without throwing`,
    `${p} the chevron is pinned ABSOLUTE at the arrow band's x/y`,
    `${p} the option text still flows (stays AUTO), so the two do not stack`,
  ];

  if (!ready) {
    for (const n of names) skip(n, "captured/fixture-screen.json not found");
    return;
  }

  const mock = freshMock();
  let result;
  try {
    result = await buildDocument(selectFieldDoc(), { kind: "none" }, () => {});
    check(names[0], true);
  } catch (err) {
    check(names[0], false, String((err as Error)?.message ?? err));
    for (let i = 1; i < names.length; i++) check(names[i], false, "build threw, cannot evaluate");
    return;
  }

  const tree = mock.serializeTree(result.root);
  const field = tree.children.find((c: any) => c.name === "Collection picker");
  const arrow = field?.children?.find((c: any) => c.name === "Dropdown arrow");
  const label = field?.children?.find((c: any) => c.name === "Semantic tokens");

  check(
    names[1],
    arrow &&
      arrow.layoutPositioning === "ABSOLUTE" &&
      arrow.x === 340 &&
      arrow.y === 9,
    arrow
      ? `pos=${arrow.layoutPositioning} x=${arrow.x} y=${arrow.y}`
      : "no chevron in built field",
  );
  check(
    names[2],
    label && label.layoutPositioning === "AUTO",
    label ? `pos=${label.layoutPositioning}` : "no option text in built field",
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function failScenario(label: string, err: unknown): void {
  check(`Scenario ${label}: did not crash the runner`, false, String((err as Error)?.message ?? err));
}

async function main(): Promise<void> {
  console.log(`Looking for captured IR in ${CAPTURED_DIR} (waiting up to ${WAIT_BUDGET_MS / 1000}s if not there yet)...`);
  const missing = await waitForFiles([FIXTURE_PATH, ORPHAN_PATH], WAIT_BUDGET_MS);
  const fixtureReady = !missing.has(FIXTURE_PATH);
  const orphanReady = !missing.has(ORPHAN_PATH);

  if (missing.size > 0) {
    console.log(
      `NOTE: still missing after waiting: ${[...missing].join(", ")}. Affected scenarios are reported as SKIP, ` +
        `not FAIL — re-run once the IR-capture harness has produced them (see test/e2e/README.md).`,
    );
  } else {
    console.log("Captured IR found. Running scenarios against the real src/plugin/build.ts.\n");
  }

  let scenarioAOut: { tree: any } | null = null;
  try {
    scenarioAOut = await scenarioA(fixtureReady);
  } catch (err) {
    failScenario("A", err);
  }
  try {
    await scenarioB(fixtureReady);
  await scenarioB2(fixtureReady);
  } catch (err) {
    failScenario("B", err);
  }
  try {
    await scenarioC(fixtureReady);
  } catch (err) {
    failScenario("C", err);
  }
  try {
    await scenarioD(orphanReady);
  } catch (err) {
    failScenario("D", err);
  }
  try {
    await scenarioE(fixtureReady);
  } catch (err) {
    failScenario("E", err);
  }
  try {
    await scenarioF(fixtureReady);
  } catch (err) {
    failScenario("F", err);
  }
  try {
    await scenarioG(fixtureReady);
  } catch (err) {
    failScenario("G", err);
  }
  try {
    await scenarioH(fixtureReady);
  } catch (err) {
    failScenario("H", err);
  }
  try {
    await scenarioI(fixtureReady);
  } catch (err) {
    failScenario("I", err);
  }
  try {
    await scenarioJ(fixtureReady);
  } catch (err) {
    failScenario("J", err);
  }
  try {
    await scenarioK(fixtureReady);
  } catch (err) {
    failScenario("K", err);
  }
  try {
    await scenarioL(fixtureReady);
  } catch (err) {
    failScenario("L", err);
  }
  try {
    await scenarioM(fixtureReady);
  } catch (err) {
    failScenario("M", err);
  }
  try {
    await scenarioN(fixtureReady);
  } catch (err) {
    failScenario("N", err);
  }
  try {
    await scenarioO(fixtureReady);
  } catch (err) {
    failScenario("O", err);
  }
  try {
    await scenarioP(fixtureReady);
  } catch (err) {
    failScenario("P", err);
  }
  try {
    await scenarioQ(fixtureReady);
  } catch (err) {
    failScenario("Q", err);
  }
  try {
    await scenarioR(fixtureReady);
  } catch (err) {
    failScenario("R", err);
  }
  try {
    await scenarioS(fixtureReady);
  } catch (err) {
    failScenario("S", err);
  }

  try {
    await scenarioT(fixtureReady);
  } catch (err) {
    failScenario("T", err);
  }
  try {
    await scenarioU(fixtureReady);
  } catch (err) {
    failScenario("U", err);
  }
  try {
    await scenarioV(fixtureReady);
  } catch (err) {
    failScenario("V", err);
  }
  try {
    await scenarioW(fixtureReady);
  } catch (err) {
    failScenario("W", err);
  }
  try {
    await scenarioX(fixtureReady);
  } catch (err) {
    failScenario("X", err);
  }
  try {
    await scenarioY(fixtureReady);
  } catch (err) {
    failScenario("Y", err);
  }

  if (scenarioAOut) {
    console.log("\n=== Node tree outline (Scenario A: create new collection) ===");
    printOutline(scenarioAOut.tree);
  } else {
    console.log("\n=== Node tree outline (Scenario A) ===\n(unavailable — scenario A did not produce a tree)");
  }

  report();
}

main().catch((err) => {
  console.error("E2E runner crashed:", err);
  process.exitCode = 1;
});
