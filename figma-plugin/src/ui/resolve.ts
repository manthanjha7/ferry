/**
 * Resolver for Claude Design documents that "build themselves at load time".
 *
 * Some `.dc.html` exports are not static markup: they carry a
 * `<script type="text/x-dc" data-dc-script">` block defining a
 * `class Component extends DCLogic { state = {...}; renderVals() {...} }`,
 * and the surrounding markup is a small template language —
 * `{{ expr }}` placeholders (in text AND in attributes, including `style`),
 * `<sc-for list="{{ arr }}" as="x">` loops, `<sc-if value="{{ cond }}">`
 * conditionals, and `<x-import component-from-global-scope="...">` slots for
 * real design-system components we cannot render.
 *
 * Claude Design's own runtime (`support.js`) resolves all of that by actually
 * mounting a tiny React-like tree. We do not have support.js and will not
 * load it (it is not ours to run inside a Figma plugin). Instead we execute
 * the embedded script ourselves against a minimal stand-in for `DCLogic` and
 * `React`, evaluate the template language directly against the resulting
 * data, and mutate the parsed document in place *before* anything is mounted
 * or measured.
 *
 * Some documents go a step further: their `state` starts as `{ booted:
 * false, ... }`, and `renderVals()` itself gates on that flag
 * (`if (!S.booted || !m) return chrome`) — it only stops returning "just the
 * chrome" once `componentDidMount()` has run a dynamic `import()` of a
 * sibling data module and, some time later, called `setState({ booted: true
 * })`. Calling only `renderVals()` (which is all this file used to do) never
 * flips that flag, so a document like this returns nothing but its
 * sidebar/toolbar — measured against a real one (an ops dashboard export,
 * test/fixture/real/finaops.html): 104/707 placeholders resolved, 4/166 loops
 * expanded, every stat card/chart/table empty. This file now runs that BOOT
 * PHASE for real: instantiate, call `componentDidMount()` if present, let its
 * `import()` resolve against caller-supplied sibling module source
 * (`ExtractOptions.moduleSources`, populated in src/ui/main.ts from whatever
 * else was dropped alongside the `.dc.html`), wait for the `setState` flurry
 * that follows to settle, and only THEN call `renderVals()`. See
 * `bootAndRender` below for the full sequence and its safety net.
 *
 * Safety property this file is built around: if anything about the script or
 * its output does not match what we expect, we bail out and leave `parsed`
 * completely untouched, so the caller degrades to today's behaviour (strip
 * scripts, mount the raw markup, let `detectDynamicContent` warn) rather than
 * shipping a half-mutated document. This is achieved by doing all resolution
 * work on a detached clone of the content root and only swapping it into the
 * real document once every step has succeeded. The boot phase adds its own,
 * narrower safety net on top (see `bootAndRender`): a throw during boot or
 * the post-boot render never reaches this outer net at all — it retries
 * against a fresh, never-booted instance first, so the worst case stays "the
 * chrome-only render this document already shipped with", not a total loss
 * of resolution.
 */

import { real } from "./clock";

/**
 * Renames `<sc-for>`/`<sc-if>` to `<template data-sc-for>`/`<template
 * data-sc-if>` in the RAW markup, before any HTML parsing happens.
 *
 * Verified against the real fixture (a real search-screen export): its
 * filings table wraps a `<tr>` in `<sc-for list="{{ filings }}" as="f">`
 * directly inside `<tbody>`, and gates several `<th>`/`<td>` with `<sc-if
 * value="{{ col.auditor }}">` directly inside `<tr>`. The HTML table
 * insertion modes ("in table", "in table body", "in row") foster-parent any
 * element whose tag name isn't on a small whitelist (tr/td/th/tbody/etc,
 * plus `<template>`) OUT of the table entirely — confirmed with a live
 * `DOMParser` parse of the real file: every such `<sc-if>`/`<sc-for>` ends
 * up hoisted to a sibling positioned immediately before `<table>`, stripped
 * of the very `<th>`/`<td>` children it was supposed to gate (they get
 * reparented directly onto `<tr>`, unconditionally). The conditional intent
 * — and the loop nesting — is destroyed before `resolveDynamicDocument` ever
 * sees the parsed Document, so no amount of DOM surgery afterward can
 * recover it.
 *
 * `<template>` IS on that whitelist (processed like `<head>` content, never
 * foster-parented) — confirmed the same way, with a live parse showing the
 * gated `<th>`s and the looped `<tr>` staying correctly nested once
 * renamed. Its content lives in `.content` (an inert DocumentFragment)
 * rather than as normal children, which `resolveNode` below reads via
 * `templateContent()` for exactly these two tags. Call this on the raw HTML
 * string before `new DOMParser().parseFromString(...)`.
 *
 * It also closes self-closed `<x-import/>` and `<dc-import/>` tags, which is
 * a different problem with the same shape: only the HTML spec's short list of
 * void elements may self-close, and for everything else the trailing slash is
 * a parse error the parser is told to ignore. `<x-import ... />` therefore
 * stays OPEN, and every element written after it is parsed as its CHILD
 * rather than its sibling, at which point `stubXImports` below replaces the
 * whole `<x-import>` subtree with one labelled placeholder box and the
 * siblings are gone from the import entirely, silently. Prophylactic today:
 * of the 32 call sites across test/fixture/real/ and the Portage export
 * (18 `x-import`, 14 `dc-import`), zero are self-closed: every one carries
 * an explicit closing tag, so none of the ten captured fixtures moves by a
 * byte. The cost of being wrong once is a whole section of a board vanishing
 * with no warning, so it is cheaper to hold the invariant than to detect the
 * breach. `test/fixture/boolattr.html` carries the assertion.
 */
export function preprocessTableSafeMarkup(html: string): string {
  return html
    .replace(/<sc-for\b/gi, "<template data-sc-for")
    .replace(/<\/sc-for\s*>/gi, "</template>")
    .replace(/<sc-if\b/gi, "<template data-sc-if")
    .replace(/<\/sc-if\s*>/gi, "</template>")
    // The attribute run is spelled out rather than `[^>]*?` so a `>` inside a
    // quoted value (`hint-placeholder-val="{{ a > b }}"`) cannot end the tag
    // early and leave a mangled element behind.
    .replace(
      /<(x-import|dc-import)\b((?:"[^"]*"|'[^']*'|[^>'"])*?)\/>/gi,
      "<$1$2></$1>",
    );
}

export type ResolveReport = {
  /** Did we find a `data-dc-script` block and successfully execute it? */
  ran: boolean;
  /** Why resolution failed, if it did. Absent when `ran` is true, and also
   * absent (not an error) when there simply was no script to run. */
  error?: string;
  /** Count of `{{ }}` tokens we evaluated (in attributes, text, and the
   * `list`/`value` expressions of `sc-for`/`sc-if`, including their sibling
   * `hint-placeholder-*` attributes, which are discarded along with the
   * element that carries them). */
  placeholdersResolved: number;
  /** Count of `{{` tokens still present, literally, in the resolved output. */
  placeholdersRemaining: number;
  /** Number of `<sc-for>` elements expanded. */
  loopsExpanded: number;
  /** Number of `<sc-if>` elements evaluated (kept or dropped). */
  conditionalsApplied: number;
  /** Number of `<x-import>` elements replaced with a labelled placeholder. */
  componentsStubbed: number;
  /**
   * Number of `<x-import>` elements identified as a page/layout-level
   * WRAPPER (Claude Design's `doc-page`, and any sibling surface built the
   * same way) and unwrapped in place — its children kept, the `<x-import>`
   * itself discarded — rather than stubbed. See `isLayoutWrapper` below for
   * the detection rule and the real-document proof behind it.
   */
  wrappersUnwrapped: number;
  /**
   * Did the component instance define `componentDidMount`, and did we call
   * it? Set as soon as we attempt the call — including when it (or the
   * settle-wait, or the post-boot render) subsequently fails, since
   * `bootAndRender`'s fresh-instance retry means "we tried to boot" and
   * "boot's result was usable" are genuinely different facts worth keeping
   * apart. Always `false` for a document with no `componentDidMount` at all
   * (e.g. a real search-screen export) — the boot phase is a no-op there,
   * UNLESS one of its `<dc-import>` targets has one. Parent and children
   * share one report deliberately, so that `placeholdersResolved` and
   * `modulesMissing` stay whole-tree facts; the price is that this flag now
   * reads "something in this document booted", not "the root did".
   */
  bootRan: boolean;
  /** Total `setState` calls observed across the whole boot + render attempt. */
  setStateCalls: number;
  /**
   * Sibling modules an `import()` call actually resolved, by friendly file
   * name (e.g. `"app-data.js"`, never `"./app-data.js"`).
   */
  modulesLoaded: string[];
  /**
   * Sibling modules an `import()` call asked for that `moduleSources` did
   * not supply — the document imports in its loading state rather than
   * hanging (see `loadModule`), and this is what lets the caller say which
   * file to go get.
   */
  modulesMissing: string[];
  /**
   * Which dynamic-import implementation actually loaded `modulesLoaded`: a
   * real ESM `import()` off a `Blob` URL, or the minimal fallback evaluator
   * used when that's unavailable (e.g. a CSP blocking `blob:` script
   * execution — see `supportsBlobImport`). Absent when no `import()` call
   * was ever made (including every document with no boot phase at all).
   */
  importImpl?: "blob" | "fallback";
  /** `<dc-import>` call sites replaced with the target document's real, resolved content. */
  documentsInlined: number;
  /**
   * `<dc-import>` call sites we could not resolve — no source, no `<x-dc>` in
   * the source, a target script that threw, a cycle, or the depth/expansion
   * caps — and rendered as a labelled `hint-size` placeholder box instead.
   */
  documentsStubbed: number;
  /** Distinct target NAMES with no usable source, e.g. `["Portage Panel"]`. */
  documentsMissing: string[];
  /** Distinct target NAMES compiled and inlined at least once. */
  documentsResolved: string[];
  /** Refused circular chains, e.g. `["A → B → A"]`. */
  documentCycles: string[];
  /** Distinct targets whose `<helmet>` styles/links were lifted into the parent `<head>`. */
  helmetsHoisted: number;
  /**
   * `<script>` elements found inside a hoisted child `<helmet>` and dropped.
   *
   * We never run a document's scripts, so dropping them is correct — but
   * `extract.ts` only adopts `head style, head link`, so without a count this
   * would be a silent difference between what Claude Design renders and what
   * we import.
   */
  helmetScriptsDropped: number;
};

/**
 * One prop a document declares on its own `<script data-dc-script
 * data-props="{…}">`, in declaration order.
 *
 * `editor` is Claude Design's host-editor widget hint and nothing else: it is
 * read at render time by neither support.js nor this file, so `{"editor":
 * "int", "default": 1440}` still arrives as the STRING `"1440"` when a
 * `<dc-import width="1440">` passes it. Only `default` has runtime meaning,
 * and only at the root (see `readPropsSchema`).
 */
export type PropSpec = {
  name: string;
  editor: string | null;
  options: unknown[] | null;
  /** Absent (not `undefined`-valued) when the declaration omits `default`. */
  hasDefault: boolean;
  default: unknown;
};

export type PropsSchema = {
  props: PropSpec[];
  /** `$preview` — the size Claude Design's own canvas previews this document at. */
  preview: { width: number; height: number } | null;
};

/**
 * Parses `data-props` off a document's `<script data-dc-script>` block,
 * mirroring support.js's `parseDataProps` (support.js:56-74): `$`-prefixed
 * keys are metadata (only `$preview` exists today) and everything else is a
 * prop declaration.
 *
 * Declaration ORDER is preserved because it is the only ordering signal a
 * document gives: the state-enumeration path names frames by walking the
 * enumerable props in the order the author wrote them, and JSON object key
 * order is that authored order for every non-numeric key.
 */
export function readPropsSchema(parsed: Document): PropsSchema {
  const raw = parsed.querySelector("script[data-dc-script]")?.getAttribute("data-props");
  const empty: PropsSchema = { props: [], preview: null };
  if (!raw) return empty;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return empty;

  const obj = decoded as Record<string, unknown>;
  const previewRaw = obj.$preview;
  const preview =
    previewRaw && typeof previewRaw === "object" && !Array.isArray(previewRaw)
      ? {
          width: Number((previewRaw as { width?: unknown }).width),
          height: Number((previewRaw as { height?: unknown }).height),
        }
      : null;

  const props: PropSpec[] = [];
  for (const name of Object.keys(obj)) {
    if (name[0] === "$") continue;
    const meta = obj[name];
    const shape = (meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}) as {
      editor?: unknown;
      options?: unknown;
      default?: unknown;
    };
    props.push({
      name,
      editor: typeof shape.editor === "string" ? shape.editor : null,
      options: Array.isArray(shape.options) ? shape.options : null,
      hasDefault: Object.prototype.hasOwnProperty.call(shape, "default"),
      default: shape.default,
    });
  }

  return { props, preview: preview && Number.isFinite(preview.width) && Number.isFinite(preview.height) ? preview : null };
}

/**
 * The props whose value space is finite and known, so a caller can extract the
 * same screen once per combination.
 *
 * Only `enum` (its declared `options`) and `boolean` (`true`/`false`) qualify.
 * `int` is unbounded, and `null`/unknown editors mean "free text" — measured
 * on the Portage panel, whose `data-props` declares `state` (enum, 7),
 * `theme` (enum, 2), `width` (int) and `sfx` (null): the author's own board
 * enumerates exactly the first two and passes the other two as fixed values.
 */
export function enumerableProps(schema: PropsSchema): Array<{ name: string; values: unknown[] }> {
  const out: Array<{ name: string; values: unknown[] }> = [];
  for (const prop of schema.props) {
    if (prop.editor === "enum" && prop.options && prop.options.length > 0) {
      out.push({ name: prop.name, values: [...prop.options] });
    } else if (prop.editor === "boolean") {
      out.push({ name: prop.name, values: [true, false] });
    }
  }
  return out;
}

/** Root prop values: declared defaults, overlaid with whatever the caller asked for. */
function rootProps(
  schema: PropsSchema,
  overrides: Record<string, string | number | boolean> | undefined,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const prop of schema.props) {
    if (prop.hasDefault) props[prop.name] = prop.default;
  }
  if (overrides) Object.assign(props, overrides);
  return props;
}

function emptyReport(): ResolveReport {
  return {
    ran: false,
    placeholdersResolved: 0,
    placeholdersRemaining: 0,
    loopsExpanded: 0,
    conditionalsApplied: 0,
    componentsStubbed: 0,
    wrappersUnwrapped: 0,
    bootRan: false,
    setStateCalls: 0,
    modulesLoaded: [],
    modulesMissing: [],
    documentsInlined: 0,
    documentsStubbed: 0,
    documentsMissing: [],
    documentsResolved: [],
    documentCycles: [],
    helmetsHoisted: 0,
    helmetScriptsDropped: 0,
  };
}

/**
 * Everything `resolveDynamicDocument` needs from the caller, as one bag.
 *
 * A bag rather than trailing positional parameters because all three fields
 * are optional maps and two of them are string-keyed string maps: passed
 * positionally, `documentSources` and `propOverrides` are mutually
 * assignable, so wiring one into the other's slot type-checks and shows up
 * only as an empty board. Every field mirrors the identically named field on
 * `ExtractOptions` (src/ir/index.ts), which is where they come from.
 */
export type ResolveOptions = {
  moduleSources?: Record<string, string>;
  documentSources?: Record<string, string>;
  propOverrides?: Record<string, string | number | boolean>;
};

/**
 * Resolves a Claude Design "builds itself at load time" document in place.
 *
 * Must be called after parsing but before scripts are stripped and before
 * the document is mounted — it needs the `<script data-dc-script>` block
 * still present, and it wants to run before anything reads placeholder text
 * as if it were final content.
 *
 * Async because of the boot phase (see `bootAndRender`): a document with a
 * `componentDidMount` needs its `import()` to resolve and its resulting
 * `setState` flurry to settle — using real timers, per that function's doc
 * comment — before `renderVals()` can be called for real.
 *
 * `options.moduleSources` is the caller's answer to "what can `import()`
 * load" — a relative-path -> JS-source map built in src/ui/main.ts from
 * whatever else was dropped alongside the `.dc.html` (see
 * `collectModuleSources` there). Absent entirely for a plain single-file
 * drop, in which case every `import()` call resolves to `{}` (see
 * `loadModule`) exactly as if the relevant sibling file were simply missing.
 *
 * `options.documentSources` is the same idea one level up: the sibling
 * `.dc.html` documents a `<dc-import name="…">` can inline (see
 * `collectDocumentSources` in src/ui/main.ts). A document that embeds others
 * and has no script of its own still comes through here for exactly that
 * reason — see the entry gate below.
 */
export async function resolveDynamicDocument(
  parsed: Document,
  options: ResolveOptions = {},
): Promise<ResolveReport> {
  const { moduleSources, documentSources, propOverrides } = options;
  const scriptEl = parsed.querySelector("script[data-dc-script]");
  const scriptSource = scriptEl?.textContent?.trim();

  const root = parsed.querySelector("x-dc") ?? parsed.body;
  if (!root) return emptyReport();

  // A canvas board can be pure markup plus `<dc-import>` call sites, with no
  // `data-dc-script` anywhere (measured: Portage.dc.html has a script, but
  // nothing requires one). Bailing out on "no script" would leave those 14
  // call sites as childless unknown elements, which `walk` then drops at
  // extract.ts's zero-size check, collapsing the whole board.
  const hasDcImports = collectDcImportNames(root).length > 0;
  if (!scriptSource && !hasDcImports) return emptyReport();

  const report = emptyReport();

  try {
    const prepared = hasDcImports
      ? await prepareDcImportTargets(parsed, root, documentSources, moduleSources, report)
      : { targets: new Map<string, TargetDoc | null>(), helmetNodes: [] as Node[] };
    const dc: DcImportContext = {
      targets: prepared.targets,
      chain: [],
      budget: { expansions: DC_EXPANSION_BUDGET },
    };

    // Work on a detached clone so a failure anywhere below (including in the
    // bookkeeping after resolution) leaves the real document untouched.
    const clone = root.cloneNode(true) as Element;

    if (scriptSource) {
      // Declared `data-props` defaults apply HERE and nowhere else, matching
      // support.js's `StandaloneRoot` (support.js:185-193). A `<dc-import>`
      // child gets only the props its call site passes: the Portage panel
      // declares `width` with `default: 1440` and still guards it with
      // `this.props.width ?? 1440`, which is dead code if children inherited
      // defaults.
      const props = rootProps(readPropsSchema(parsed), propOverrides);
      const scope = await bootAndRender(scriptSource, moduleSources, report, props);
      resolveNode(clone, scope, report, dc);
      stubXImports(clone, report);
      report.ran = true;
    } else {
      // Script-less: expand the dc-imports and touch NOTHING else. Running the
      // tree-wide `resolveNode` against an empty scope would rewrite every
      // `{{ x }}` to "", `detectDynamicContent` would then count zero
      // placeholders, and main.ts would stop holding back genuinely
      // unresolvable documents. `report.ran` stays false: no script ran.
      expandDcImportsOnly(clone, report, dc);
    }

    const remaining = clone.innerHTML.match(/\{\{/g);
    report.placeholdersRemaining = remaining ? remaining.length : 0;

    while (root.firstChild) root.removeChild(root.firstChild);
    while (clone.firstChild) root.appendChild(clone.firstChild);

    // Held back until the swap succeeded, so the all-or-nothing property this
    // file is built around covers the document head as well as its content:
    // a throw above must not leave a failed resolution's stylesheets behind.
    for (const node of prepared.helmetNodes) parsed.head.appendChild(node);

    return report;
  } catch (err) {
    return {
      ...emptyReport(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Script execution — DCLogic/React stand-ins
// ---------------------------------------------------------------------------

type Scope = Record<string, unknown>;

/**
 * Mutable box `setState` writes into so `waitForBootSettle` can tell "no
 * state change has happened yet" (`lastActivityAt === null`) apart from
 * "quiet since a real change" (`lastActivityAt` is a timestamp) — see that
 * function's doc comment for why the distinction matters.
 */
type BootTracker = { lastActivityAt: number | null };

/**
 * Minimal stand-in for Claude Design's `DCLogic` base class — a factory
 * rather than a fixed class, because `setState` needs to write into THIS
 * resolution attempt's `BootTracker`/`ResolveReport` (a fresh pair per
 * document, and, per `bootAndRender`'s fresh-instance retry, sometimes a
 * second instance of the very same class within one resolution attempt), so
 * the class instances it produces close over them instead of reading
 * module-level state that every document would otherwise share.
 *
 * Verified against the real fixture (a real search-screen export): `React`
 * appears exactly once (`get h() { return React.createElement; }`),
 * `DCLogic` once (the `extends` clause), `this.props` and `window.` never,
 * and `this.state` 9 times, always reading the class-field `state = {...}`
 * the subclass declares itself. `setState` is genuinely called — including
 * synchronously, from a plain event handler, and asynchronously from
 * `componentDidMount` — in a boot-carrying document too (see
 * a real ops-dashboard export:
 * `setTimeout(() => this.setState({ booted: true }), 500)`), which is
 * exactly the case this now has to support for real.
 */
function createDCLogicStub(
  tracker: BootTracker,
  report: ResolveReport,
): new (props?: Record<string, unknown>) => { props: Record<string, unknown>; state: Record<string, unknown> } {
  return class DCLogicStub {
    props: Record<string, unknown>;
    state: Record<string, unknown>;

    constructor(props?: Record<string, unknown>) {
      this.props = props ?? {};
      this.state = {};
    }

    setState(update: unknown): void {
      if (!this.state) this.state = {};
      const partial =
        typeof update === "function"
          ? (update as (s: Record<string, unknown>) => unknown)(this.state)
          : update;
      if (partial && typeof partial === "object") {
        Object.assign(this.state, partial as Record<string, unknown>);
      }
      report.setStateCalls++;
      tracker.lastActivityAt = real.now();
    }
  };
}

type VNode = {
  __vnode: true;
  tag: string;
  props: Record<string, unknown> | null;
  children: unknown[];
};

function createReactStub(): {
  createElement: (tag: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => VNode;
} {
  return {
    createElement(tag, props, ...children) {
      return { __vnode: true, tag: String(tag), props: props ?? null, children };
    },
  };
}

// ---------------------------------------------------------------------------
// Boot phase — componentDidMount, dynamic import(), and waiting for the
// resulting setState flurry to settle before renderVals() is ever called.
// ---------------------------------------------------------------------------

/** How long to wait, after the LAST observed `setState`, before deciding boot has settled. */
const BOOT_QUIET_MS = 300;
/** Absolute ceiling on the whole boot wait, regardless of activity. */
const BOOT_HARD_CAP_MS = 4000;
/**
 * How long to keep waiting for a FIRST `setState` before concluding the boot
 * is not going to produce one.
 *
 * Without this, a `componentDidMount` that never calls `setState` — a document
 * that boots synchronously, or one whose mount only wires up handlers — burns
 * the entire hard cap waiting for an event that will never arrive. Measured at
 * four seconds on a document that needed none of it. The window still
 * comfortably covers the real case we built this for, whose mount imports a
 * module and then calls `setState` behind a 500ms timer.
 */
const BOOT_FIRST_ACTIVITY_MS = 1200;
/** How often `waitForBootSettle` re-checks the clock. */
const BOOT_POLL_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => real.setTimeout(resolve, ms));
}

/**
 * Polls until `BOOT_QUIET_MS` has passed since the last `setState`, or
 * `BOOT_HARD_CAP_MS` has passed in total, whichever comes first. Uses real
 * timers throughout — no fake-clock trickery — because the real fixture
 * schedules a genuine `setTimeout` (500ms) that this has to actually wait
 * out.
 *
 * `tracker.lastActivityAt` starting `null` (rather than "now", i.e. the
 * moment boot began) is load-bearing, not incidental. The real fixture's
 * `componentDidMount` calls `this.setState({ booted: true })` only after its
 * `import().then(...)` resolves AND a 500ms `setTimeout` beyond that —
 * past `BOOT_QUIET_MS` (300ms) on its own. Seeding `lastActivityAt` with the
 * boot-start time instead would make "300ms since boot started, nothing has
 * happened YET" indistinguishable from "300ms since the last real change",
 * and this poll would wrongly declare settled at ~300ms — before the
 * fixture's own `setState` at ~500ms ever fires — reproducing exactly the
 * chrome-only bug this file exists to fix, just one layer deeper. Treating
 * "no activity yet" as "still booting, keep waiting" and only starting the
 * quiet-clock once the first real `setState` lands is what lets the 500ms
 * real-world delay survive this wait intact.
 *
 * The flip side — a `componentDidMount` that never calls `setState` at all
 * (e.g. test/fixture/real/petals.html's, which only registers a `resize`
 * listener) — has no signal to key off, so it legitimately consumes the
 * entire `BOOT_HARD_CAP_MS` before this returns. That is exactly what the
 * hard cap is for: bounding the "no signal, ever" case, not just a slow one.
 */
async function waitForBootSettle(tracker: BootTracker): Promise<void> {
  const start = real.now();
  while (real.now() - start < BOOT_HARD_CAP_MS) {
    // Nothing has happened yet. Give a first `setState` a bounded window to
    // appear rather than holding the full hard cap open for one that never will.
    if (tracker.lastActivityAt === null && real.now() - start >= BOOT_FIRST_ACTIVITY_MS) {
      return;
    }
    if (tracker.lastActivityAt !== null && real.now() - tracker.lastActivityAt >= BOOT_QUIET_MS) {
      return;
    }
    await sleep(BOOT_POLL_INTERVAL_MS);
  }
}

/**
 * Rewrites dynamic `import(...)` CALL EXPRESSIONS to `__cd2fImport(...)` in
 * the raw script text, before it is ever handed to `new Function(...)`.
 *
 * `import` is a reserved word — unlike `DCLogic`/`React` it cannot be
 * shadowed by a parameter name, so the only way to give the executed script
 * a working, sandboxed dynamic import is to rename the call site itself and
 * supply `__cd2fImport` as a real parameter (see `bootAndRender`). The regex
 * requires `(` (allowing whitespace) immediately after `import`, so
 * `import.meta` — never used by any real fixture we have — is left alone,
 * and the leading `\b` keeps this from ever matching inside a longer
 * identifier.
 */
function rewriteDynamicImport(source: string): string {
  return source.replace(/\bimport\s*(?=\()/g, "__cd2fImport");
}

let dynamicImportProbe: Promise<boolean> | null = null;

/**
 * Feature-tests real ESM `import()` off a `Blob` URL exactly once per
 * session — cached in a module-level variable, not re-run per document —
 * and reports which path won via `ResolveReport.importImpl` the first time a
 * module is actually loaded (`loadModule`). A Figma plugin iframe's CSP can
 * plausibly block `blob:` script execution even though a blob URL is not
 * itself a network request (see manifest.json's `networkAccess: none`) —
 * probing beats guessing.
 */
function supportsBlobImport(): Promise<boolean> {
  if (!dynamicImportProbe) {
    dynamicImportProbe = (async () => {
      let url: string | undefined;
      try {
        url = URL.createObjectURL(new Blob(["export const __cd2fProbe = 1;"], { type: "text/javascript" }));
        const mod = (await import(url)) as { __cd2fProbe?: unknown };
        return mod.__cd2fProbe === 1;
      } catch {
        return false;
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    })();
  }
  return dynamicImportProbe;
}

/** Strips a leading `./` or `../` so `"./app-data.js"` and `"app-data.js"` key the same lookup. */
function normalizeModuleKey(specifier: string): string {
  return specifier.replace(/^(\.\.?\/)+/, "");
}

function friendlyModuleName(specifier: string): string {
  const normalized = normalizeModuleKey(specifier);
  return normalized.split("/").pop() || normalized;
}

/**
 * Looks up a specifier against caller-supplied module source, forgiving of
 * the exact spelling: the raw specifier, then with any leading `./`/`../`
 * stripped, then just its basename (in case the script imports a nested path
 * but the file arrived flat — which is how a dropped folder or unzipped
 * export actually lands; see `collectModuleSources` in src/ui/main.ts, which
 * populates both the `./name.js` and bare `name.js` spellings for exactly
 * this reason).
 */
function lookupModuleSource(
  specifier: string,
  moduleSources: Record<string, string> | undefined,
): string | undefined {
  if (!moduleSources) return undefined;
  if (specifier in moduleSources) return moduleSources[specifier];
  const normalized = normalizeModuleKey(specifier);
  if (normalized in moduleSources) return moduleSources[normalized];
  const basename = normalized.split("/").pop() ?? normalized;
  return moduleSources[basename];
}

/**
 * Resolves one `import()` call made from inside the executed script. Never
 * rejects and never hangs: a module we were not given resolves to `{}`
 * (recorded in `report.modulesMissing`) rather than leaving the script's own
 * `.then(...)` chain — and this whole resolution attempt — waiting on a
 * promise that will never settle. The document goes on to import in
 * whatever its own "loading" state looks like, exactly as if that sibling
 * file had 404'd in a real browser.
 */
async function loadModule(
  specifier: string,
  moduleSources: Record<string, string> | undefined,
  report: ResolveReport,
): Promise<Record<string, unknown>> {
  const name = friendlyModuleName(specifier);
  const src = lookupModuleSource(specifier, moduleSources);

  if (src === undefined) {
    if (!report.modulesMissing.includes(name)) report.modulesMissing.push(name);
    return {};
  }

  const record = (impl: "blob" | "fallback", mod: Record<string, unknown>): Record<string, unknown> => {
    report.importImpl = impl;
    if (!report.modulesLoaded.includes(name)) report.modulesLoaded.push(name);
    return mod;
  };

  if (await supportsBlobImport()) {
    let url: string | undefined;
    try {
      url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      const mod = (await import(url)) as Record<string, unknown>;
      return record("blob", mod);
    } catch {
      // Real ESM import failed for THIS module even though the session-wide
      // probe passed — fall through to the manual evaluator rather than
      // lose this module's data entirely.
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  return record("fallback", evaluateEsmModule(src));
}

/**
 * Minimal ESM-to-plain-object rewrite for when real `import()` is
 * unavailable. Handles exactly the export forms the spec calls for —
 * `export const/let/var x = ...`, `export function x(...) {...}` (and
 * `async`/generator variants), `export default ...`, and
 * `export { a, b as c }` — by stripping the `export` keyword (so every
 * declaration still runs, in its original position, with its original
 * side-effect ordering intact) and appending `exports[name] = name`
 * assignments once every declaration has executed. This is never a real
 * parser: nothing here needs to understand arbitrary expressions, only the
 * small, fixed set of top-level `export` shapes ES modules allow.
 */
function evaluateEsmModule(source: string): Record<string, unknown> {
  const localNames: string[] = [];
  let body = source;

  // `export default <expr>` — including `export default function Name(...)`,
  // which stays a valid (named or anonymous) function expression once
  // `export ` is gone.
  body = body.replace(/export\s+default\s+/g, "exports.default = ");

  // `export function name(...)` / `export async function name(...)` /
  // `export function* name(...)`.
  body = body.replace(
    /export\s+(async\s+function\s*\*?|function\s*\*?)\s+([A-Za-z_$][\w$]*)/g,
    (_match, kind: string, name: string) => {
      localNames.push(name);
      return `${kind.trim()} ${name}`;
    },
  );

  // `export const/let/var name = ...`.
  body = body.replace(/export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (_match, kind: string, name: string) => {
    localNames.push(name);
    return `${kind} ${name}`;
  });

  // `export { a, b as c };` — drop the statement itself, remembering the
  // (local, exported) name pairs so the right local binding lands on the
  // right export name.
  const reExports: Array<{ local: string; exported: string }> = [];
  body = body.replace(/export\s*\{([^}]*)\}\s*;?/g, (_match, list: string) => {
    for (const part of list.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const aliased = trimmed.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      reExports.push(aliased ? { local: aliased[1], exported: aliased[2] } : { local: trimmed, exported: trimmed });
    }
    return "";
  });

  const assignments = [
    ...localNames.map((name) => `exports[${JSON.stringify(name)}] = ${name};`),
    ...reExports.map(({ local, exported }) => `exports[${JSON.stringify(exported)}] = ${local};`),
  ].join("\n");

  const factory = new Function("exports", `"use strict";\n${body}\n${assignments}\nreturn exports;`) as (
    exportsObj: Record<string, unknown>,
  ) => Record<string, unknown>;

  return factory({});
}

/**
 * Instantiates `class Component extends DCLogic {...}`, runs its boot phase
 * if it has one, and returns the merged scope template expressions resolve
 * against — `renderVals()`'s return value merged over `this.state`
 * (renderVals wins on overlap, unchanged from before this file ran a boot
 * phase at all; verified against the real fixture that every bare
 * identifier the markup references is already present on what `renderVals()`
 * itself returns).
 *
 * Boot phase: if the instance defines `componentDidMount`, call it, then
 * wait for the `setState` flurry it kicks off to settle (`waitForBootSettle`)
 * before calling `renderVals()` at all — this is what makes a document like
 * test/fixture/real/finaops.html's actually load its data instead of
 * returning only its chrome.
 *
 * Safety net: if `renderVals()` throws AFTER a boot attempt — e.g. the
 * script indexes into a sibling module we could not supply real data for
 * (`loadModule` resolves those to `{}` rather than rejecting, so `renderVals()`
 * may still reach code that expected real data on it) — this retries against
 * a SECOND, freshly constructed, never-booted instance. Its `renderVals()`
 * sees `state.booted` still `false`, which is exactly the condition every
 * real document's own `if (!S.booted || !m) return chrome` branch was
 * written to handle, so this reproduces precisely what shipped before boot
 * support existed rather than losing the whole resolution to one bad module
 * reference. A document with no `componentDidMount` at all never enters any
 * of this — it renders once, on the one instance, exactly as before.
 */
async function bootAndRender(
  source: string,
  moduleSources: Record<string, string> | undefined,
  report: ResolveReport,
  props: Record<string, unknown> = {},
): Promise<Scope> {
  const { Ctor, tracker } = compileComponent(source, moduleSources, report);

  const instance = constructComponent(Ctor, props);
  const componentDidMount = (instance as { componentDidMount?: unknown }).componentDidMount;

  if (typeof componentDidMount !== "function") {
    return renderScope(instance, props);
  }

  report.bootRan = true;
  try {
    await (componentDidMount as () => unknown).call(instance);
  } catch {
    // Swallow — renderScope below still runs against whatever state
    // `componentDidMount` managed to set before failing, and falls through
    // to the fresh-instance retry (same as any other post-boot renderVals()
    // failure) if that isn't safe either.
  }
  await waitForBootSettle(tracker);

  try {
    return renderScope(instance, props);
  } catch {
    return renderScope(constructComponent(Ctor, props), props);
  }
}

/**
 * Executes a `<script data-dc-script>` block and hands back the `Component`
 * class it defines, plus the `BootTracker` its `setState` calls write into.
 *
 * Split out of `bootAndRender` because a `<dc-import>` target needs the same
 * compile step but a different lifecycle: one boot per target NAME, then a
 * cheap fresh instance per call site (see `prepareDcImportTargets`).
 */
type ComponentCtor = new (props?: Record<string, unknown>) => Record<string, unknown>;

function compileComponent(
  source: string,
  moduleSources: Record<string, string> | undefined,
  report: ResolveReport,
): { Ctor: ComponentCtor; tracker: BootTracker } {
  const tracker: BootTracker = { lastActivityAt: null };
  const DCLogicStub = createDCLogicStub(tracker, report);
  const importFn = (specifier: string) => loadModule(specifier, moduleSources, report);

  const factory = new Function(
    "DCLogic",
    "React",
    "__cd2fImport",
    `${rewriteDynamicImport(source)}\nreturn Component;`,
  ) as (dcLogic: unknown, react: unknown, importFn: unknown) => unknown;

  const ComponentClass = factory(DCLogicStub, createReactStub(), importFn);
  if (typeof ComponentClass !== "function") {
    throw new Error("Script did not define a top-level `Component` class");
  }
  return { Ctor: ComponentClass as ComponentCtor, tracker };
}

/**
 * Constructs a component with its props, then assigns them again.
 *
 * The second assignment is not belt-and-braces: `class Component extends
 * DCLogic` is free to declare its own constructor that never forwards
 * arguments to `super`, in which case `DCLogicStub`'s `this.props = props ??
 * {}` sees nothing. support.js has the same problem and solves it the same
 * way, by writing `logic.props` from outside after construction
 * (support.js:1081).
 */
function constructComponent(Ctor: ComponentCtor, props: Record<string, unknown>): Record<string, unknown> {
  const instance = new Ctor(props);
  (instance as { props?: unknown }).props = props;
  return instance;
}

/**
 * The scope template expressions evaluate against, for one instance.
 *
 * Merge order is `state`, then `props`, then `renderVals()`, and it is not
 * arbitrary. support.js merges `{...userProps, ...renderVals()}`
 * (support.js:1085) with no `state` in it at all — `state` is this file's own
 * convenience layer, so it goes underneath. Props must beat state or a
 * `<dc-import theme="dark">` is shadowed by the target's own
 * `state.theme = 'light'` and every dark panel imports light. `renderVals()`
 * wins over both, matching support.js exactly.
 */
function renderScope(instance: Record<string, unknown>, props: Record<string, unknown> = {}): Scope {
  const renderVals = (instance as { renderVals?: unknown }).renderVals;
  if (typeof renderVals !== "function") {
    throw new Error("Component instance has no renderVals() method");
  }

  const rendered = (renderVals as () => unknown).call(instance);
  if (!rendered || typeof rendered !== "object") {
    throw new Error("renderVals() did not return an object");
  }

  const state = (instance as { state?: Record<string, unknown> }).state ?? {};
  return { ...state, ...props, ...(rendered as Record<string, unknown>) };
}

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const NUMBER_LITERAL = /^-?\d+(?:\.\d+)?$/;

function evaluate(expr: string, scope: Scope): unknown {
  const trimmed = expr.trim();
  if (trimmed === "") return undefined;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed === "undefined") return undefined;
  if (NUMBER_LITERAL.test(trimmed)) return Number(trimmed);

  const singleQuoted = trimmed.match(/^'([^']*)'$/);
  if (singleQuoted) return singleQuoted[1];
  const doubleQuoted = trimmed.match(/^"([^"]*)"$/);
  if (doubleQuoted) return doubleQuoted[1];

  if (IDENTIFIER_PATH.test(trimmed)) {
    return trimmed.split(".").reduce<unknown>((acc, key) => {
      if (acc === null || acc === undefined) return undefined;
      return (acc as Record<string, unknown>)[key];
    }, scope);
  }

  // Anything more complex (`a && b`, `!x`, `a + b`, …) — never seen in the
  // real fixture (every expr there is a bare identifier, a dotted path, or a
  // literal), but documents vary. Never let a bad expression throw.
  try {
    const fn = new Function("scope", `with (scope) { return (${trimmed}); }`) as (s: Scope) => unknown;
    return fn(scope);
  } catch {
    return "";
  }
}

/** Strips the `{{ ... }}` wrapper from an attribute value like `list`/`value`. */
function extractExpr(raw: string): string {
  const match = raw.match(/^\{\{\s*([\s\S]*?)\s*\}\}$/);
  return match ? match[1] : raw;
}

// ---------------------------------------------------------------------------
// Tree resolution — sc-for / sc-if / attributes / text, in one recursive pass
// ---------------------------------------------------------------------------

/**
 * Tags we never descend into or substitute inside. `<helmet>` carries the
 * document's stylesheet links (no template content of its own); the rest
 * are non-content tags that could coincidentally contain a literal `{{`
 * (e.g. inside a `<style>` rule) that must not be touched. A bare
 * `<template>` (i.e. one `preprocessTableSafeMarkup` did not create — no
 * `data-sc-for`/`data-sc-if` marker) falls in here too, inert and untouched.
 */
const SKIP_TAGS = new Set(["HELMET", "STYLE", "SCRIPT", "LINK", "TEMPLATE", "X-DC-TOOLBAR", "TITLE", "META", "NOSCRIPT"]);

/**
 * `sc-for`/`sc-if` arrive as `<template data-sc-for>`/`<template
 * data-sc-if>` (renamed by `preprocessTableSafeMarkup` before parsing, to
 * survive HTML table insertion modes — see that function's doc comment). A
 * `<template>`'s real content lives in `.content`, an inert
 * DocumentFragment, not in its `.childNodes` (which is always empty).
 */
function templateChildNodes(el: Element): Node[] {
  const content = (el as HTMLTemplateElement).content as DocumentFragment | undefined;
  return Array.from(content ? content.childNodes : el.childNodes);
}

/**
 * Resolves one node against `scope`, returning the node(s) that should take
 * its place in the parent. A plain node normally maps to itself; `sc-for`
 * maps to N expanded copies; `sc-if` maps to its children or nothing; a text
 * node maps to itself, a stringified copy, built element(s), or nothing.
 *
 * This single recursive walk does what the spec describes as four ordered
 * phases (expand loops, apply conditionals, substitute attributes,
 * substitute text) in one pass instead of four separate tree-wide passes.
 * That is a deliberate simplification: an `sc-if` inside an `sc-for` body
 * (e.g. `t.showCount` inside `sc-for as="t"`) can only be evaluated once the
 * loop variable is bound to a specific item, so "expand all loops, then
 * apply all conditionals" only works if loop-expansion itself recursively
 * finishes each iteration's subtree — which is exactly what this function
 * does, just depth-first rather than as globally flat passes. Attributes and
 * text are substituted for a node only once its position in the final tree
 * (which loop iteration, which conditional branch) is already decided.
 */
function resolveNode(node: Node, scope: Scope, report: ResolveReport, dc: DcImportContext): Node[] {
  if (node.nodeType === Node.TEXT_NODE) {
    return resolveTextNode(node as Text, scope, report);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return [node];
  }

  const el = node as Element;
  const tag = el.tagName;

  // Before SKIP_TAGS and before `resolveAttributes`, in that order and for
  // two different reasons. Before SKIP_TAGS so a future entry there can never
  // silently swallow a whole sub-screen; before `resolveAttributes` because
  // that function stringifies every `{{ }}` it finds and returns "" for an
  // object or array, which would destroy `rows="{{ items }}"` and the
  // `dc-props` spread before `dcImportProps` ever read them.
  if (tag === "DC-IMPORT") return resolveDcImport(el, scope, report, dc);

  const isScFor = tag === "TEMPLATE" && el.hasAttribute("data-sc-for");
  const isScIf = tag === "TEMPLATE" && el.hasAttribute("data-sc-if");

  if (!isScFor && !isScIf && SKIP_TAGS.has(tag)) return [el];

  if (isScFor) {
    report.loopsExpanded++;
    countAttributePlaceholders(el, report);

    const listExpr = extractExpr(el.getAttribute("list") ?? "");
    const asName = el.getAttribute("as") ?? "item";
    const listValue = evaluate(listExpr, scope);
    const items = Array.isArray(listValue) ? listValue : [];
    const templateChildren = templateChildNodes(el);

    const out: Node[] = [];
    for (const item of items) {
      const childScope: Scope = Object.create(scope) as Scope;
      childScope[asName] = item;
      for (const child of templateChildren) {
        out.push(...resolveNode(child.cloneNode(true), childScope, report, dc));
      }
    }
    return out;
  }

  if (isScIf) {
    report.conditionalsApplied++;
    countAttributePlaceholders(el, report);

    const valueExpr = extractExpr(el.getAttribute("value") ?? "");
    const truthy = Boolean(evaluate(valueExpr, scope));
    if (!truthy) return [];

    const out: Node[] = [];
    for (const child of templateChildNodes(el)) {
      out.push(...resolveNode(child, scope, report, dc));
    }
    return out;
  }

  resolveAttributes(el, scope, report);

  const newChildren: Node[] = [];
  for (const child of Array.from(el.childNodes)) {
    newChildren.push(...resolveNode(child, scope, report, dc));
  }
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const child of newChildren) el.appendChild(child);

  return [el];
}

/**
 * Counts (without evaluating) every `{{` in an element's own attributes.
 * Used for `sc-for`/`sc-if`, whose attributes — including the
 * author-provided `hint-placeholder-count`/`hint-placeholder-val` fallback
 * hints for when no script runs — are discarded along with the element
 * itself once it is expanded/applied, rather than individually substituted.
 */
function countAttributePlaceholders(el: Element, report: ResolveReport): void {
  for (const attr of Array.from(el.attributes)) {
    const matches = attr.value.match(/\{\{/g);
    if (matches) report.placeholdersResolved += matches.length;
  }
}

const PLACEHOLDER_PATTERN = () => /\{\{\s*([\s\S]*?)\s*\}\}/g;

/**
 * Attributes HTML defines as BOOLEAN: their presence is the "true" state and
 * their value is ignored entirely, so `disabled="false"` disables and
 * `checked="false"` renders a ticked box. Everything below writes a string,
 * which is right for `class`/`style`/`value` and exactly backwards for these
 * eight. A `{{ }}` bound to `false` produced the state the author asked for
 * the opposite of.
 *
 * Live in the Portage export ("Portage Panel.dc.html", the plugin's own UI
 * built as a Claude Design board): `multiple="{{ true }}"` on the token-file
 * input, `checked="{{ createMissing }}"` and `checked="{{ inferStacks }}"` on
 * the two option checkboxes, and `disabled="{{ importDisabled }}"` on the
 * Import button. Six of that board's seven states have `importDisabled`
 * false, so before this fix every one of them imported with a greyed-out
 * Import button styled by `.cd2f-btn-primary:disabled`, and both checkboxes
 * ticked regardless of state. Nothing errored and no count moved: `disabled`
 * was resolved, counted, and written, just inverted.
 */
const BOOLEAN_ATTRIBUTES = new Set([
  "disabled",
  "checked",
  "multiple",
  "selected",
  "readonly",
  "required",
  "hidden",
  "open",
]);

/**
 * Whether a resolved boolean-attribute value means "absent".
 *
 * `""` is in here because `stringifyForAttribute` collapses `null`,
 * `undefined`, a function and a vnode all to the empty string, and an empty
 * boolean attribute (`disabled=""`) is the canonical way to spell the TRUE
 * state in HTML, so keeping it would reintroduce the same inversion for
 * every falsy value that is not literally `false`.
 */
function meansAttributeAbsent(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || trimmed.toLowerCase() === "false";
}

function resolveAttributes(el: Element, scope: Scope, report: ResolveReport): void {
  for (const attr of Array.from(el.attributes)) {
    if (!attr.value.includes("{{")) continue;
    const isStyleAttr = attr.name === "style";
    const newValue = attr.value.replace(PLACEHOLDER_PATTERN(), (_match, expr: string) => {
      report.placeholdersResolved++;
      const value = evaluate(expr, scope);
      // `style="{{ S.card }}"` (and `style="{{ S.wrap }};text-align:center"`,
      // where the placeholder is only part of the value) is a real,
      // pervasive Claude Design authoring pattern — verified against a real
      // fixture (test/fixture/real/petals.html, "Petals n Blooms.dc.html"):
      // nearly every element there carries its whole style as one such
      // placeholder, and `renderVals()` returns a plain JS style object
      // (`{ display:'flex', gap:12, ... }`) for it, never a string. Routing
      // that through the generic `stringifyForAttribute` below silently
      // produced `style=""` for every one of them — confirmed by inspecting
      // the captured IR (test/e2e/captured/real-petals.json): the header,
      // every button, every card came back with browser UA-default styling
      // (e.g. Button fills #EFEFEF with a 2px black outset border — Chrome's
      // default `<button>` chrome — instead of the authored `#8a6a54`
      // background and pill radius), not the object's actual values. Only
      // literal, hardcoded inline styles survived. Serialising the object as
      // real CSS here is the fix; a non-style attribute (or a style value
      // that isn't a plain object — an icon vnode, say) still falls through
      // to stringifyForAttribute exactly as before.
      if (isStyleAttr && isPlainStyleObject(value)) {
        return styleObjectToCss(value as Record<string, unknown>);
      }
      return stringifyForAttribute(value);
    });
    // Only attributes that actually carried a `{{ }}` reach here (the
    // `includes("{{")` guard above), so a hand-written literal
    // `checked="checked"` is never touched by this branch.
    if (BOOLEAN_ATTRIBUTES.has(attr.name) && meansAttributeAbsent(newValue)) {
      el.removeAttribute(attr.name);
      continue;
    }
    el.setAttribute(attr.name, newValue);
  }
}

function isPlainStyleObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isVNode(value)
  );
}

function stringifyForAttribute(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "function") return "";
  // Reaches here only for a non-style attribute, or a style value that
  // wasn't a plain object (isPlainStyleObject already routed that case to
  // styleObjectToCss above) — i.e. a vnode or array of vnodes (an icon).
  // Neither can be expressed as an attribute string; dropping it is what
  // keeps e.g. an icon placeholder landing in attribute position impossible
  // — icons never legitimately appear there, only in text/style.
  if (typeof value === "object") return "";
  return String(value);
}

/**
 * Resolves a text node, which may contain zero, one, or several `{{ }}`
 * tokens interleaved with literal text. A placeholder that evaluates to a
 * vnode (an icon) or an array of vnodes is built into real DOM node(s) and
 * spliced in, rather than stringified — that is the one case where the
 * output is not "the same text node with new text".
 */
function resolveTextNode(node: Text, scope: Scope, report: ResolveReport): Node[] {
  const raw = node.data;
  if (!raw.includes("{{")) return [node];

  const out: Node[] = [];
  let buffer = "";
  let lastIndex = 0;

  const flush = () => {
    if (buffer) {
      out.push(document.createTextNode(buffer));
      buffer = "";
    }
  };

  const re = PLACEHOLDER_PATTERN();
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    buffer += raw.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;
    report.placeholdersResolved++;

    const built = buildFromValue(evaluate(match[1], scope));
    if (built === null) {
      // Nothing to insert (null icon, undefined value, a function, …).
    } else if (typeof built === "string") {
      buffer += built;
    } else {
      flush();
      for (const n of Array.isArray(built) ? built : [built]) out.push(n);
    }
  }
  buffer += raw.slice(lastIndex);
  flush();

  return out;
}

type BuiltValue = Node | Node[] | string | null;

function buildFromValue(value: unknown): BuiltValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "function") return null;

  if (Array.isArray(value)) {
    const nodes: Node[] = [];
    for (const item of value) {
      const built = buildFromValue(item);
      if (built === null) continue;
      if (typeof built === "string") nodes.push(document.createTextNode(built));
      else if (Array.isArray(built)) nodes.push(...built);
      else nodes.push(built);
    }
    return nodes;
  }

  if (isVNode(value)) return vnodeToDom(value);
  if (typeof value === "object") return null; // Unrecognized shape — drop rather than "[object Object]".

  return String(value);
}

function isVNode(value: unknown): value is VNode {
  return !!value && typeof value === "object" && (value as { __vnode?: unknown }).__vnode === true;
}

// ---------------------------------------------------------------------------
// VNode -> DOM
// ---------------------------------------------------------------------------

const SVG_TAGS = new Set([
  "svg",
  "path",
  "circle",
  "rect",
  "g",
  "line",
  "polyline",
  "polygon",
  "ellipse",
  "defs",
  "use",
]);

const SVG_NS = "http://www.w3.org/2000/svg";

const ATTR_NAME_MAP: Record<string, string> = {
  className: "class",
  strokeWidth: "stroke-width",
  strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin",
  fillRule: "fill-rule",
  clipRule: "clip-rule",
  // viewBox intentionally not mapped — it stays camelCase in SVG.
};

function camelToKebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * CSS properties whose bare numeric values are valid as-is — the same list
 * React's own inline-style handling treats as unitless. Every other property
 * gets "px" appended to a bare number: a JS style object's `gap: 12` is a
 * number, but `gap:12` is not valid CSS (it is silently ignored), only
 * `gap:12px` is. Without this, any numeric style value picked up from a
 * Claude Design `renderVals()` style object would be dropped by the browser.
 */
const UNITLESS_CSS_PROPERTIES = new Set([
  "animation-iteration-count", "aspect-ratio", "border-image-outset",
  "border-image-slice", "border-image-width", "box-flex", "box-flex-group",
  "box-ordinal-group", "column-count", "columns", "flex", "flex-grow",
  "flex-positive", "flex-shrink", "flex-negative", "flex-order",
  "grid-area", "grid-row", "grid-row-end", "grid-row-span", "grid-row-start",
  "grid-column", "grid-column-end", "grid-column-span", "grid-column-start",
  "font-weight", "line-clamp", "line-height", "opacity", "order", "orphans",
  "tab-size", "widows", "z-index", "zoom", "fill-opacity", "flood-opacity",
  "stop-opacity", "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit",
  "stroke-opacity", "stroke-width",
]);

function cssDeclarationValue(property: string, value: unknown): string {
  if (typeof value === "number") {
    return value === 0 || UNITLESS_CSS_PROPERTIES.has(property) ? String(value) : `${value}px`;
  }
  return String(value);
}

/**
 * Serialises a JS style object (camelCase keys, string/number values — the
 * shape `renderVals()` returns for both a whole-attribute `style="{{ S.card
 * }}"` placeholder and a vnode's `style` prop) into a real CSS declaration
 * string. Shared by `resolveAttributes` (whole-attribute style placeholders)
 * and `vnodeToDom` (icon vnode style props) so both agree on units.
 */
function styleObjectToCss(styleObj: Record<string, unknown>): string {
  return Object.keys(styleObj)
    .map((key) => {
      const value = styleObj[key];
      if (value === null || value === undefined || typeof value === "function") return null;
      const property = camelToKebab(key);
      return `${property}:${cssDeclarationValue(property, value)}`;
    })
    .filter((decl): decl is string => decl !== null)
    .join(";");
}

function vnodeToDom(vnode: VNode): Element {
  const el = SVG_TAGS.has(vnode.tag)
    ? document.createElementNS(SVG_NS, vnode.tag)
    : document.createElement(vnode.tag);

  const props = vnode.props ?? {};
  for (const key of Object.keys(props)) {
    if (key === "key" || key === "children") continue;
    const value = props[key];
    if (value === null || value === undefined || typeof value === "function") continue;

    if (key === "style" && typeof value === "object") {
      el.setAttribute("style", styleObjectToCss(value as Record<string, unknown>));
      continue;
    }

    const attrName = ATTR_NAME_MAP[key] ?? key;
    el.setAttribute(attrName, String(value));
  }

  for (const child of flattenVNodeChildren(vnode.children)) {
    if (child === null || child === undefined || typeof child === "function") continue;
    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
      el.appendChild(document.createTextNode(String(child)));
    } else if (isVNode(child)) {
      el.appendChild(vnodeToDom(child));
    }
  }

  return el;
}

/** React.createElement's rest-arg children can themselves be arrays (icon
 * helpers pass a literal array of path elements as the sole child arg) — flatten
 * one or more levels of nesting down to a plain list of children. */
function flattenVNodeChildren(children: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flattenVNodeChildren(child));
    else out.push(child);
  }
  return out;
}

// ---------------------------------------------------------------------------
// x-import -> labelled placeholder
// ---------------------------------------------------------------------------

/**
 * Known interaction with extract.ts's text/frame heuristic: when an
 * `<x-import>` sits inside a plain, unstyled `<span>` that is itself inside
 * an eligible "text container" (e.g. a real search screen's per-row Chat button —
 * `<td><span class="om-chat"><x-import>…</x-import></span></td>`),
 * `isTextContainer`/`extractText` flatten the whole `<td>` into one TEXT
 * node before layer construction ever inspects this stub's own box styling
 * (border/data-name), because they only check the DIRECT child's computed
 * `display` (the `<span>`, "inline") and then recurse indiscriminately.
 * The stub's label text (e.g. "Chat") still comes through correctly — only
 * the dashed-border "this is a placeholder" treatment is lost for that one
 * shape. Top-level `<x-import>`s (not span-wrapped) get the full boxed
 * treatment. Reworking that heuristic is out of scope here — it predates
 * this resolver and touches unrelated, already-covered code paths.
 */
/**
 * Distinguishes a page/layout-level WRAPPER `<x-import>` from a genuine
 * design-system LEAF component, so `stubXImports` can unwrap the former
 * (keep its children, drop only the `<x-import>` itself) instead of
 * collapsing it into a single labelled placeholder box the way it correctly
 * does for the latter.
 *
 * Proven necessary against a real doc-page report
 * (a real one-pager export, a
 * Claude Design "doc-page" export): its entire body is wrapped in
 * `<x-import component-from-global-scope="doc-page" from="./doc-page.js"
 * size="letter" margin="0.6in" hint-size="816px,1056px">`. Forcing this
 * function's old unconditional behaviour to run on it (by adding a trivial
 * `data-dc-script` so `resolveDynamicDocument` reaches `stubXImports` at
 * all — the fetched document itself has no script, so today this specific
 * fixture escapes the bug by accident, not by design) collapsed a 153-node,
 * 68-TEXT-node extraction down to 3 nodes and a single run-on TEXT blob with
 * no tables, no structure, no colour — i.e. the entire report.
 *
 * Two signals, both required, distinguish a wrapper from a leaf:
 *
 * 1. `component-from-global-scope` has no dot. Every real design-system
 *    component reference seen across every real fixture we have
 *    (test/fixture/real/*.html) is a dotted `Namespace.Component` path —
 *    e.g. `AcmeDesignSystem_3f2a9c.Button` — because a project's design
 *    system is what namespaces it; there is no such thing as a bare,
 *    ambiguous global component reference in that vocabulary. `doc-page` is
 *    a bare, undotted global name.
 *
 * 2. It carries a page-box attribute (`size` and/or `margin`). These are
 *    print/page geometry (CSS Paged Media's `@page { size; margin }`
 *    vocabulary), which describes a CONTAINER's own page dimensions — no
 *    design-system leaf component (Button, Badge, Input) is ever configured
 *    with `size="letter"` or `margin="0.6in"`; their own `size` attribute
 *    (e.g. Button's `size="sm"`) is always paired with a dotted name, so
 *    condition 1 already excludes them.
 *
 * Requiring both keeps this conservative: an undotted name alone is not
 * enough (some other bare global helper might genuinely be an unrenderable
 * component we should still stub), and neither is a `size`/`margin`
 * attribute alone.
 */
function isLayoutWrapper(el: Element): boolean {
  const componentPath = el.getAttribute("component-from-global-scope") ?? "";
  if (!componentPath || componentPath.includes(".")) return false;
  return el.hasAttribute("size") || el.hasAttribute("margin");
}

function stubXImports(root: Element, report: ResolveReport): void {
  for (const el of Array.from(root.querySelectorAll("x-import"))) {
    if (isLayoutWrapper(el)) {
      const parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      report.wrappersUnwrapped++;
      continue;
    }
    el.replaceWith(buildComponentStub(el));
    report.componentsStubbed++;
  }
}

function buildComponentStub(el: Element): HTMLDivElement {
  const div = document.createElement("div");

  const componentPath = el.getAttribute("component-from-global-scope") ?? "";
  const componentName = componentPath.split(".").pop() || componentPath || "Component";
  const variant = el.getAttribute("variant");
  const label = variant ? `${componentName} (${variant})` : componentName;
  div.setAttribute("data-name", label);

  const styles = [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "box-sizing:border-box",
    "border:1px dashed rgba(0,0,0,.35)",
    "border-radius:6px",
    "padding:4px 10px",
    "font-size:11px",
    "color:rgba(0,0,0,.5)",
    "white-space:nowrap",
  ];

  const hintSize = el.getAttribute("hint-size");
  if (hintSize) {
    const [w, h] = hintSize.split(",").map((s) => s.trim());
    if (w && w !== "auto") styles.push(`width:${w}`);
    if (h && h !== "auto") styles.push(`height:${h}`);
  }
  div.setAttribute("style", styles.join(";"));

  // By the time we get here, this element's own children have already been
  // through resolveNode — any {{ icon }} placeholder is a built SVG (no
  // textContent) and any literal label text is unchanged, so .textContent
  // naturally yields just the readable label (e.g. "My Searches & Alerts").
  const text = (el.textContent ?? "").trim();
  div.textContent = text || label;

  return div;
}

// ---------------------------------------------------------------------------
// dc-import -> the sibling document, resolved and inlined
// ---------------------------------------------------------------------------

/**
 * `<dc-import name="X">` embeds a whole sibling Claude Design document, which
 * is a different mechanism from `<x-import>` (a JS module export we cannot
 * render and therefore stub). support.js fetches `./<X>.dc.html`, compiles the
 * slice between its first `<x-dc…>` and its last `</x-dc>` as a template, runs
 * that document's own `Component` class against the call site's attributes,
 * and renders the result inside a `<div class="sc-host" data-sc-name="X">`.
 *
 * We do the same, minus the fetch: the sources arrive as
 * `ResolveOptions.documentSources`, collected in src/ui/main.ts from whatever
 * else was dropped or unzipped alongside the parent.
 *
 * Work splits across two positions and both are forced. The async half
 * (parse, compile, one boot per target NAME, helmet hoisting) runs once in
 * `prepareDcImportTargets` before anything is cloned, because `resolveNode` is
 * synchronous and recursive and making it async would serialise the entire
 * depth-first walk. The per-call-site splice runs inside `resolveNode`,
 * because 7 of the Portage board's 14 call sites live inside
 * `<sc-if value="{{ showDark }}">` — a `<template>` whose children sit in an
 * inert `.content` fragment that `querySelectorAll` cannot reach until the
 * conditional has been applied.
 */

/** Ancestor-chain depth at which we stop expanding and draw a placeholder. */
const DC_MAX_DEPTH = 8;
/** Total inlined call sites allowed per document, a backstop against fan-out. */
const DC_EXPANSION_BUDGET = 200;
/** support.js's own default when a `hint-size` is absent (support.js:862-882). */
const DC_DEFAULT_HINT_SIZE = "100%,60px";

/**
 * One target document, parsed and compiled once and reused by every call site
 * that names it.
 */
type TargetDoc = {
  name: string;
  /** The target's template slice, parsed but NOT resolved. Cloned per call site. */
  template: Element;
  /** `null` when the target ships no `<script data-dc-script>`, or its script threw. */
  Ctor: ComponentCtor | null;
  /**
   * State left behind by ONE `componentDidMount` + settle, adopted by every
   * call site's fresh instance.
   *
   * Booting per call site instead would cost `BOOT_HARD_CAP_MS` (4s) each:
   * 14 Portage panels would serialise to nearly a minute for a board that
   * looks hung. The divergence from support.js (which mounts each instance
   * for real) is that a `componentDidMount` reading `this.props` sees `{}`
   * here. No document we have does that; the alternative is unbounded.
   */
  bootedState: Record<string, unknown> | null;
};

type DcImportContext = {
  targets: Map<string, TargetDoc | null>;
  /** Ancestor target names, innermost last. Mirrors support.js's AncestorContext. */
  chain: string[];
  /** Shared across the whole document, so nesting cannot multiply the cap. */
  budget: { expansions: number };
};

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * Every `<dc-import>` under `root`, INCLUDING the ones inside a
 * `<template data-sc-if>`/`data-sc-for` body. `querySelectorAll` stops at a
 * template's boundary because its children live in `.content`, a separate
 * DocumentFragment, and 7 of the Portage board's 14 call sites are exactly
 * there. Preparation has to see them or half the board resolves as
 * "target missing".
 */
function forEachDcImport(root: ParentNode, visit: (el: Element) => void): void {
  for (const el of Array.from(root.querySelectorAll("dc-import"))) visit(el);
  for (const tpl of Array.from(root.querySelectorAll("template"))) {
    const content = (tpl as HTMLTemplateElement).content as DocumentFragment | undefined;
    if (content) forEachDcImport(content, visit);
  }
}

/** Distinct target names under `root`, in document order. */
function collectDcImportNames(root: ParentNode): string[] {
  const names: string[] = [];
  forEachDcImport(root, (el) => {
    const name = el.getAttribute("name") ?? el.getAttribute("component") ?? "";
    if (name) pushUnique(names, name);
  });
  return names;
}

/**
 * Forgiving lookup, the same contract as `lookupModuleSource` above.
 *
 * support.js addresses a target as `"." + "/" + encodeURIComponent(name) +
 * ".dc.html"` relative to the boot page, so the percent-encoded spelling is
 * the parity path. The rest are spellings a drag-and-drop or an unzipped
 * export actually produces (`collectDocumentSources` in src/ui/main.ts
 * populates all of them). The lowercase alias is a deliberate deviation:
 * support.js's lookup is an HTTP fetch and therefore as case-sensitive as the
 * server, while a file dragged off a Mac filesystem is not.
 */
function lookupDocumentSource(
  name: string,
  documentSources: Record<string, string> | undefined,
): string | undefined {
  if (!documentSources || !name) return undefined;
  const candidates = [
    name,
    `${name}.dc.html`,
    `./${name}.dc.html`,
    `${encodeURIComponent(name)}.dc.html`,
    `${name}.html`,
    name.toLowerCase(),
  ];
  for (const key of candidates) {
    if (key in documentSources) return documentSources[key];
  }
  return undefined;
}

/**
 * Splits a `.dc.html` file into its template slice and its script, mirroring
 * support.js's `parseDcText` (support.js:38-55).
 *
 * The slice runs from the FIRST `<x-dc…>` open tag to the LAST `</x-dc>`, so
 * the target's `<helmet>` is part of the template (it is written inside
 * `<x-dc>` in both Portage documents) while the file's real `<head>` — its
 * `<script src="./support.js">`, its viewport meta — is not.
 */
function parseDcSource(src: string): { templateHtml: string; script: string } | null {
  const openMatch = /<x-dc(?:\s[^>]*)?>/i.exec(src);
  if (!openMatch) return null;
  const close = src.lastIndexOf("</x-dc>");
  if (close === -1 || close < openMatch.index) return null;

  const templateHtml = src.slice(openMatch.index + openMatch[0].length, close);
  const doc = new DOMParser().parseFromString(src, "text/html");
  const script = doc.querySelector("script[data-dc-script]")?.textContent?.trim() ?? "";
  return { templateHtml, script };
}

/**
 * P0.5: resolve every target name to a compiled `TargetDoc`, transitively.
 *
 * Returns the hoisted helmet nodes rather than appending them itself, so a
 * throw later in `resolveDynamicDocument` leaves `parsed.head` as untouched as
 * it leaves the content root. The caller appends them only once the swap has
 * succeeded.
 */
async function prepareDcImportTargets(
  parsed: Document,
  root: Element,
  documentSources: Record<string, string> | undefined,
  moduleSources: Record<string, string> | undefined,
  report: ResolveReport,
): Promise<{ targets: Map<string, TargetDoc | null>; helmetNodes: Node[] }> {
  const targets = new Map<string, TargetDoc | null>();
  const helmetNodes: Node[] = [];
  const helmetSeen = seedHelmetKeys(parsed);

  let frontier = collectDcImportNames(root);
  for (let depth = 0; depth < DC_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const name of frontier) {
      if (targets.has(name)) continue;
      const target = await prepareOneTarget(
        name,
        parsed,
        documentSources,
        moduleSources,
        report,
        helmetNodes,
        helmetSeen,
      );
      targets.set(name, target);
      if (target) next.push(...collectDcImportNames(target.template));
    }
    frontier = next;
  }

  return { targets, helmetNodes };
}

async function prepareOneTarget(
  name: string,
  parsed: Document,
  documentSources: Record<string, string> | undefined,
  moduleSources: Record<string, string> | undefined,
  report: ResolveReport,
  helmetNodes: Node[],
  helmetSeen: Set<string>,
): Promise<TargetDoc | null> {
  const source = lookupDocumentSource(name, documentSources);
  if (source === undefined) {
    pushUnique(report.documentsMissing, name);
    return null;
  }

  const parts = parseDcSource(source);
  if (!parts) {
    // A file we were given that has no `<x-dc>` is not a Claude Design
    // document at all. Same outcome as a missing one, and the same warning.
    pushUnique(report.documentsMissing, name);
    return null;
  }

  const doc = new DOMParser().parseFromString(preprocessTableSafeMarkup(parts.templateHtml), "text/html");
  const template = doc.body;
  hoistTargetHelmet(name, template, parsed, helmetNodes, helmetSeen, report);

  let Ctor: ComponentCtor | null = null;
  let bootedState: Record<string, unknown> | null = null;
  if (parts.script) {
    try {
      const compiled = compileComponent(parts.script, moduleSources, report);
      Ctor = compiled.Ctor;
      bootedState = await bootTargetOnce(compiled.Ctor, compiled.tracker, report);
    } catch {
      // A target whose script will not even compile still has markup worth
      // inlining: support.js renders a template with props alone when a
      // document ships no script, and this is the same situation one step
      // later. Better a styled panel reading its defaults than a dashed box.
      Ctor = null;
    }
  }

  return { name, template, Ctor, bootedState };
}

async function bootTargetOnce(
  Ctor: ComponentCtor,
  tracker: BootTracker,
  report: ResolveReport,
): Promise<Record<string, unknown> | null> {
  let instance: Record<string, unknown>;
  try {
    instance = constructComponent(Ctor, {});
  } catch {
    return null;
  }
  const componentDidMount = (instance as { componentDidMount?: unknown }).componentDidMount;
  if (typeof componentDidMount !== "function") return null;

  report.bootRan = true;
  try {
    await (componentDidMount as () => unknown).call(instance);
  } catch {
    // Same contract as bootAndRender's: whatever state landed before the
    // failure is still worth adopting.
  }
  await waitForBootSettle(tracker);

  const state = (instance as { state?: unknown }).state;
  return state && typeof state === "object" ? { ...(state as Record<string, unknown>) } : null;
}

/**
 * Keys for stylesheets the parent document ALREADY carries, so a child helmet
 * linking the same `_ds/<system>/tokens/fonts.css` does not adopt it twice.
 */
function seedHelmetKeys(parsed: Document): Set<string> {
  const seen = new Set<string>();
  const add = (el: Element) => {
    if (el.tagName === "LINK") seen.add(`LINK|${el.getAttribute("href") ?? ""}`);
  };
  for (const helmet of Array.from(parsed.querySelectorAll("helmet"))) {
    for (const child of Array.from(helmet.children)) add(child);
  }
  for (const link of Array.from(parsed.querySelectorAll("head link"))) add(link);
  return seen;
}

/**
 * Lifts a target's `<helmet>` styles and links out to the PARENT's `<head>`,
 * then strips the helmet from the template.
 *
 * Destination matters and `parsed.head` is the only correct one. extract.ts
 * reads `parsed.querySelector("helmet")`, which returns the FIRST helmet in
 * the document — and a canvas board has one of its own (Portage.dc.html:10),
 * so a helmet created inside the inlined content would never be read. It also
 * sweeps `parsed.querySelectorAll("head style, head link")` right afterwards,
 * which is what picks these up.
 *
 * This is the step that decides whether the import is right or merely
 * plausible: the Portage panel defines its `--figma-color-*` light and dark
 * blocks in its own helmet `<style>`, and every colour in its markup is
 * `var(--figma-color-…, #lightLiteral)`. Lose the hoist and all 14 panels
 * still import, still count as inlined, and every dark one silently renders
 * light.
 */
function hoistTargetHelmet(
  name: string,
  template: Element,
  parsed: Document,
  helmetNodes: Node[],
  helmetSeen: Set<string>,
  report: ResolveReport,
): void {
  let hoisted = 0;

  for (const helmet of Array.from(template.querySelectorAll("helmet"))) {
    let index = 0;
    for (const child of Array.from(helmet.children)) {
      const tag = child.tagName;
      const position = index++;

      if (tag === "SCRIPT") {
        // We never execute a document's scripts, and extract.ts adopts only
        // style/link anyway, so this would be dropped either way. Counted so
        // it is a known gap rather than an invisible one.
        report.helmetScriptsDropped++;
        continue;
      }
      if (tag !== "LINK" && tag !== "STYLE") continue;

      // support.js keys a helmet <style> by component name plus child index
      // and a <link> by href (support.js:1439-1489), which is how 14
      // instances of one panel produce exactly one <style> in the head.
      const key =
        tag === "LINK"
          ? `LINK|${child.getAttribute("href") ?? ""}`
          : `STYLE|${name}|${position}`;
      if (helmetSeen.has(key)) continue;
      helmetSeen.add(key);

      helmetNodes.push(parsed.importNode(child, true));
      hoisted++;
    }
    helmet.remove();
  }

  if (hoisted > 0) report.helmetsHoisted++;
}

/**
 * Splices one `<dc-import>` call site. Synchronous by construction: every
 * expensive step already happened in `prepareDcImportTargets`.
 */
function resolveDcImport(el: Element, scope: Scope, report: ResolveReport, dc: DcImportContext): Node[] {
  const name = el.getAttribute("name") ?? el.getAttribute("component") ?? "";
  const { props, hintSize, hostStyle } = dcImportProps(el, scope, report);

  if (dc.chain.includes(name)) {
    const chain = [...dc.chain.slice(dc.chain.indexOf(name)), name].join(" → ");
    pushUnique(report.documentCycles, chain);
    report.documentsStubbed++;
    return [buildDcImportPlaceholder(name, hintSize, `circular import: ${chain}`)];
  }
  if (dc.chain.length >= DC_MAX_DEPTH || dc.budget.expansions <= 0) {
    report.documentsStubbed++;
    return [buildDcImportPlaceholder(name, hintSize, "import nesting limit reached")];
  }

  const target = dc.targets.get(name) ?? null;
  if (!target) {
    // Normally already recorded by the preparation pass; recorded again here
    // because a call site can name a target the pass never saw (a name only
    // an `sc-for` body introduces, say).
    if (name) pushUnique(report.documentsMissing, name);
    report.documentsStubbed++;
    return [buildDcImportPlaceholder(name, hintSize, null)];
  }

  dc.budget.expansions--;

  // Slot children are compiled in the PARENT template and rendered with the
  // PARENT's values (support.js:670, 686), so they resolve against `scope`,
  // not against the target's.
  const slotted: Node[] = [];
  for (const child of Array.from(el.childNodes)) {
    slotted.push(...resolveNode(child, scope, report, dc));
  }
  if (slotted.length > 0) props.children = slotted;

  let childScope: Scope;
  try {
    if (target.Ctor) {
      const instance = constructComponent(target.Ctor, props);
      if (target.bootedState) {
        const state = ((instance as { state?: Record<string, unknown> }).state ?? {}) as Record<string, unknown>;
        (instance as { state?: unknown }).state = { ...state, ...target.bootedState };
      }
      childScope = renderScope(instance, props);
    } else {
      // support.js's "template renders with props only" path.
      childScope = { ...props };
    }
  } catch (err) {
    report.documentsStubbed++;
    return [
      buildDcImportPlaceholder(name, hintSize, err instanceof Error ? err.message : String(err)),
    ];
  }

  const host = buildDcHost(name, hostStyle);
  const childDc: DcImportContext = {
    targets: dc.targets,
    chain: [...dc.chain, name],
    budget: dc.budget,
  };
  const templateClone = target.template.cloneNode(true) as Element;
  for (const child of Array.from(templateClone.childNodes)) {
    for (const node of resolveNode(child, childScope, report, childDc)) host.appendChild(node);
  }

  report.documentsInlined++;
  pushUnique(report.documentsResolved, name);
  return [host];
}

const DC_RESERVED_ATTRIBUTES = new Set(["name", "component", "sc-name", "data-dc-tpl"]);
/** support.js encodes camelCase attribute names behind this prefix before parsing. */
const DC_CAMEL_ATTR_PREFIX = "sc-camel-";

/** CSS properties a host wrapper is allowed to carry (support.js:445-455). */
const HOST_STYLE_PROPS = new Set([
  "position",
  "left",
  "right",
  "top",
  "bottom",
  "inset",
  "width",
  "height",
  "z-index",
  "transform",
]);

function kebabToCamel(value: string): string {
  return value.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
}

/**
 * One call site's attributes as real props, mirroring
 * `collectProps(el, "dc-import", host)` (support.js:415-444).
 *
 * Note what "dc-import" means there: unlike `x-import`, it gets NO
 * `aria-`/`data-` carve-out, so every hyphenated attribute is kebab-to-camel'd
 * and `data-foo` arrives as `dataFoo`.
 *
 * Known divergence: an attribute the author wrote camelCase arrives lowercase,
 * because the HTML parser lowercases attribute names and support.js only
 * dodges that with a document-wide `sc-camel-` encode we cannot apply without
 * breaking real CSS and DOM. The `sc-camel-` prefix is still decoded here for
 * a document that carries it.
 */
function dcImportProps(
  el: Element,
  scope: Scope,
  report: ResolveReport,
): { props: Record<string, unknown>; hintSize: string | null; hostStyle: string | null } {
  const props: Record<string, unknown> = {};
  let hintSize: string | null = null;
  let hostStyle: string | null = null;

  for (const attr of Array.from(el.attributes)) {
    if (DC_RESERVED_ATTRIBUTES.has(attr.name)) continue;

    let key = attr.name;
    if (key.startsWith(DC_CAMEL_ATTR_PREFIX)) key = kebabToCamel(key.slice(DC_CAMEL_ATTR_PREFIX.length));

    if (key === "hint-size") {
      hintSize = attr.value;
      continue;
    }
    if (key.startsWith("style-")) continue; // pseudo-class hook; no equivalent here.
    if (key === "style") {
      hostStyle = hostPositionStyle(compileAttrValue(attr.value, scope, report));
      continue;
    }

    if (key.includes("-")) key = kebabToCamel(key);
    const value = compileAttrValue(attr.value, scope, report);

    // `dc-props="{{ obj }}"` spreads rather than setting a `dcProps` prop.
    if (key === "dcProps") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(props, value as Record<string, unknown>);
      }
      continue;
    }
    props[key] = value;
  }

  return { props, hintSize, hostStyle };
}

/**
 * Attribute value -> prop value, mirroring `compileAttr` (support.js:401-412)
 * and deliberately NOT `resolveAttributes`.
 *
 * A whole-value `{{ expr }}` yields the real typed value — a number, an array,
 * an object — because that is what the target's `renderVals()` will index
 * into. `resolveAttributes` would stringify it, and `stringifyForAttribute`
 * returns "" for anything object-shaped, so `rows="{{ items }}"` would arrive
 * as an empty string.
 */
function compileAttrValue(raw: string, scope: Scope, report: ResolveReport): unknown {
  const whole = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
  if (whole) {
    report.placeholdersResolved++;
    return evaluate(whole[1], scope);
  }
  if (!raw.includes("{{")) return raw;
  return raw.replace(PLACEHOLDER_PATTERN(), (_match, expr: string) => {
    report.placeholdersResolved++;
    return stringifyForAttribute(evaluate(expr, scope));
  });
}

/**
 * The position-only subset of a call site's `style`, per `hostPositionStyle`
 * (support.js:457-466). Everything else the author wrote there is discarded by
 * Claude Design too: a host wrapper positions its instance, it does not
 * restyle it.
 */
function hostPositionStyle(value: unknown): string | null {
  if (isPlainStyleObject(value)) {
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (HOST_STYLE_PROPS.has(camelToKebab(key))) filtered[key] = value[key];
    }
    return styleObjectToCss(filtered) || null;
  }
  if (typeof value !== "string") return null;

  const declarations: string[] = [];
  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    if (!HOST_STYLE_PROPS.has(property)) continue;
    declarations.push(`${property}:${declaration.slice(colon + 1).trim()}`);
  }
  return declarations.length > 0 ? declarations.join(";") : null;
}

/**
 * The `<div class="sc-host">` support.js wraps every instance in
 * (support.js:1031-1040). `data-name` is what extract.ts's `frameName` reads
 * first, so this is what makes each embedded board a findable, correctly
 * named Figma layer.
 *
 * A plain block div, never `display:contents`. A contents wrapper measures
 * 0x0 through `getBoundingClientRect`, survives extract.ts's zero-size drop
 * because it has children, and then every descendant's x/y is computed
 * against that zero rect — an entire panel silently shifted, with nothing to
 * show for it in any counter.
 */
function buildDcHost(name: string, hostStyle: string | null): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "sc-host";
  div.setAttribute("data-sc-name", name);
  div.setAttribute("data-name", name);
  if (hostStyle) div.setAttribute("style", hostStyle);
  return div;
}

/**
 * The visible, correctly sized box a call site becomes when its target cannot
 * be resolved. Mirrors support.js's `Placeholder` (support.js:862-882),
 * deliberately separate from `buildComponentStub`: that one serves
 * `<x-import>`, is on the resolution path of three captured fixtures, and has
 * no default size at all — so reusing it would leave a hint-size-less
 * dc-import collapsing to zero, which is the bug being fixed.
 */
function buildDcImportPlaceholder(
  name: string,
  hintSize: string | null,
  error: string | null,
): HTMLDivElement {
  const div = document.createElement("div");
  const label = name || "Document";
  div.setAttribute("data-name", label);

  const [rawWidth, rawHeight] = (hintSize || DC_DEFAULT_HINT_SIZE).split(",");
  const width = (rawWidth ?? "").trim() || "100%";
  // Deviation from support.js, on purpose: there, `hint-size="400px"` with no
  // comma leaves the height undefined and a live import grows to whatever it
  // streams in. Ours never streams, so an undefined height collapses to zero
  // and `walk` drops the box entirely — the exact failure this placeholder
  // exists to prevent. Substitute the default height instead.
  const height = (rawHeight ?? "").trim() || "60px";

  const styles = [
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "box-sizing:border-box",
    "border:1px dashed rgba(0,0,0,.35)",
    "border-radius:2px",
    "overflow:hidden",
    "font-size:11px",
    "color:rgba(0,0,0,.5)",
  ];
  if (width !== "auto") styles.push(`width:${width}`);
  if (height !== "auto") styles.push(`height:${height}`);
  div.setAttribute("style", styles.join(";"));

  div.textContent = error ? `${label}: ${error}` : label;
  return div;
}

/**
 * The script-less path: inline the dc-imports and leave every other node
 * exactly as authored.
 *
 * Only elements `querySelectorAll` can reach are visited. A `<dc-import>`
 * inside a `<template data-sc-if>` stays put, because with no script there is
 * nothing to evaluate the condition against and the template's content never
 * mounts or gets measured — resolving it would be work nobody can see.
 *
 * `stubXImports` runs per inlined subtree rather than over the whole clone,
 * because the parent's own `<x-import>`s are outside this function's remit:
 * a script-less document has always kept them, and unwrapping a `doc-page`
 * wrapper here would change documents that import correctly today.
 */
function expandDcImportsOnly(root: Element, report: ResolveReport, dc: DcImportContext): void {
  for (const el of Array.from(root.querySelectorAll("dc-import"))) {
    const parent = el.parentNode;
    if (!parent) continue;
    for (const node of resolveDcImport(el, {}, report, dc)) {
      parent.insertBefore(node, el);
      if (node.nodeType === Node.ELEMENT_NODE) stubXImports(node as Element, report);
    }
    parent.removeChild(el);
  }
}
