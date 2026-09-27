/**
 * IR -> Figma nodes.
 *
 * Ordering matters more than anything else in this file. Figma's auto-layout
 * takes control of child geometry the moment `layoutMode` is set, and
 * `layoutSizingHorizontal`/`Vertical` only accept FILL/HUG once the node is
 * already parented to an auto-layout frame. So every frame follows the same
 * sequence: create -> paint -> append children -> enable layout -> apply child
 * sizing. Deviating from that produces either thrown errors or silently
 * collapsed frames.
 */

import type {
  DivergentToken,
  FlowSpec,
  IRColor,
  IRDesignSystem,
  IRDocument,
  IREffect,
  IRNode,
  IRPaint,
  IRShadowToken,
  IRSurface,
  IRTextRun,
  IRTokenDefinition,
  MappingReport,
  PerDocumentResult,
  Placement,
  TokenDivergence,
  TokenRef,
  VariableTarget,
} from "../ir";
import { createFontResolver, type FontResolver } from "./fonts";
import { describeError } from "../errors";
import {
  bindField,
  bindPaint,
  joinNames,
  resolveVariables,
  sameSurfaceValue,
  surfaceValueOf,
  type VariableRegistry,
} from "./mapping";

export type BuildResult = {
  root: FrameNode;
  nodeCount: number;
  mapping: MappingReport;
  substitutions: string[];
  warnings: string[];
};

export type ProgressFn = (done: number, total: number, label: string) => void;

export type BuildOptions = {
  /**
   * Share one registry across a batch. Absent means resolve per call, which is
   * what a lone `buildDocument` does and what the e2e scenarios exercise.
   */
  registry?: VariableRegistry;
  /** false = the caller positions the frame. Default true. */
  place?: boolean;
  /**
   * Tokens THIS document declares at values the shared registry does not hold,
   * from `mergeDesignSystems`. Absent for a lone import, which has nothing to
   * disagree with.
   */
  divergence?: TokenDivergence;
};

/** A document that is its own batch conflicts with nothing. */
const NO_DIVERGENCE: TokenDivergence = new Map();

/**
 * Space between imported frames, on both axes.
 *
 * Same 200 as `DECK_SLIDE_GAP` in src/ui/extract.ts, deliberately: a deck's
 * slides and a batch's screens sit side by side in the same file and reading
 * as one visual language matters more than the two numbers being independent.
 */
export const IMPORT_GAP = 200;

type BuildCtx = {
  fonts: FontResolver;
  registry: VariableRegistry;
  divergence: TokenDivergence;
  /**
   * The theme the node being built right now sits inside, or null for none.
   *
   * Maintained down the walk the way `walkThemed` (src/ui/extract.ts) maintains
   * its own: a node's paints say nothing about which variable mode they will
   * resolve in, and `bindableToken` has to compare the value the file will show
   * against the value THIS document renders in THIS theme.
   */
  themeScope: string | null;
  warnings: string[];
  count: number;
  total: number;
  onProgress: ProgressFn;
  lastYield: number;
};

export async function buildDocument(
  doc: IRDocument,
  target: VariableTarget,
  onProgress: ProgressFn,
  options: BuildOptions = {},
): Promise<BuildResult> {
  onProgress(0, 1, "Resolving design tokens…");
  const registry =
    options.registry ?? (await resolveVariables(doc.designSystem, target));

  onProgress(0, 1, "Loading fonts…");
  const fonts = await createFontResolver(collectFontRequests(doc.root));

  const ctx: BuildCtx = {
    fonts,
    registry,
    divergence: options.divergence ?? NO_DIVERGENCE,
    themeScope: null,
    warnings: [...doc.warnings],
    count: 0,
    total: countNodes(doc.root),
    onProgress,
    lastYield: Date.now(),
  };

  let root: FrameNode | null = null;
  try {
    root = (await buildNode(doc.root, ctx)) as FrameNode;
    root.name = doc.name;

    // Which combination of props this frame is, in a form that survives being
    // renamed. The name carries it too, right up until a designer tidies the
    // layer panel, and then the association is gone for good: there is no way
    // to work out afterwards which of fourteen frames was `state=warning`.
    // Cheap on the first build, impossible to backfill on any later one.
    if (doc.props) root.setPluginData("ferry.props", JSON.stringify(doc.props));

    // Appending is unconditional: a frame that never reaches the page is not
    // an import, and `BuildResult.root` is read by callers that expect it to
    // be on the canvas. Only the *position* is the batch's business.
    figma.currentPage.appendChild(root);
    if (options.place !== false) placeBesideExistingContent(root);
  } catch (error) {
    // A partially built tree is worse than none: it looks like a successful
    // import until the user scrolls into the missing half.
    if (root && !root.removed) root.remove();
    throw error;
  }

  return {
    root,
    nodeCount: ctx.count,
    mapping: registry.report,
    substitutions: fonts.substitutions,
    warnings: ctx.warnings,
  };
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

export type BatchResult = {
  /** One per document that built. A failed document contributes no root. */
  roots: FrameNode[];
  /**
   * The section the frames were grouped into, or null when they went straight
   * onto the page. Null unless `FlowSpec.section` named one.
   */
  section: SectionNode | null;
  nodeCount: number;
  mapping: MappingReport;
  substitutions: string[];
  warnings: string[];
  perDocument: PerDocumentResult[];
  /** Prototype reactions written across the batch. */
  reactions: number;
  /** Flow starting points this import owns afterwards. 0 or 1. */
  flows: number;
};

export type BatchProgressFn = (
  docIndex: number,
  docCount: number,
  done: number,
  total: number,
  label: string,
) => void;

/**
 * The trigger every flow edge gets unless the caller overrides it.
 *
 * ON_CLICK is the only trigger that advances a prototype in presentation view
 * without a hotspot the designer has to draw first, which is the whole point of
 * wiring the matrix at all. The cost is that a whole-frame ON_CLICK means
 * clicking a screen's own fake buttons also advances, so this is an option
 * rather than a literal: changing it is a caller's decision, not an edit here.
 */
export const DEFAULT_FLOW_TRIGGER: Trigger = { type: "ON_CLICK" };

export type BatchOptions = {
  /** Prototype wiring over the batch. Absent means no reactions and no flow. */
  flow?: FlowSpec;
  /** Trigger for every edge. Defaults to `DEFAULT_FLOW_TRIGGER`. */
  trigger?: Trigger;
};

/**
 * Build several documents as one import.
 *
 * One registry, one origin, one layout pass. The ordering below is the whole
 * point of the function and each step is load-bearing:
 *
 * 1. Merge the design systems and resolve variables ONCE. Resolving per
 *    document reuses the collection by name from document 2 onward, and
 *    `resolveVariables` counts a reused variable as created (see
 *    `report.created++` in src/plugin/mapping.ts), so the same 125 variables
 *    get reported as new once per document.
 * 2. Take the origin BEFORE anything is appended, or each document's placement
 *    counts this batch's own earlier frames as pre-existing content and the
 *    whole batch chains into one endless row.
 * 3. Build sequentially, surviving a document that throws.
 * 4. Lay out AFTER the last frame is built: auto-layout resizes a frame while
 *    its children's sizing is applied (`applyChildSizing` below), so a grid
 *    computed mid-build reads widths that are about to change.
 * 5. Wire the prototype LAST, once every frame exists and is parented. Figma
 *    validates a NAVIGATE destination at the moment the reaction is set, so an
 *    edge written before its destination is on the page is refused outright.
 */
export async function buildDocuments(
  docs: IRDocument[],
  target: VariableTarget,
  placement: Placement,
  onProgress: BatchProgressFn,
  options: BatchOptions = {},
): Promise<BatchResult> {
  const merged = mergeDesignSystems(docs);
  const registry = await resolveVariables(merged.system, target, merged.notes);
  const origin = batchOrigin();

  const roots: FrameNode[] = [];
  /**
   * Index-aligned with `docs`, unlike `roots`, which skips a document that
   * failed to build. A `FlowSpec` indexes into `docs`, so reading the flow off
   * `roots` would silently shift every edge one place left the moment a single
   * screen in the batch could not be built.
   */
  const rootByDoc: Array<FrameNode | null> = [];
  const perDocument: PerDocumentResult[] = [];
  const substitutions: string[] = [];
  const warnings: string[] = [];
  let nodeCount = 0;

  for (let index = 0; index < docs.length; index++) {
    const doc = docs[index];
    try {
      const result = await buildDocument(
        doc,
        target,
        (done, total, label) => onProgress(index, docs.length, done, total, label),
        { registry, place: false, divergence: merged.divergence[index] },
      );

      roots.push(result.root);
      rootByDoc.push(result.root);
      nodeCount += result.nodeCount;
      perDocument.push({ name: doc.name, ok: true, nodes: result.nodeCount });

      // Font substitution is a property of the file, not of one screen: the
      // same "DM Sans → Inter" line from every screen in a 14-screen batch is
      // one fact reported fourteen times.
      for (const substitution of result.substitutions) {
        if (!substitutions.includes(substitution)) substitutions.push(substitution);
      }
      // Warnings are per-node and stay per-document, so name the document
      // they came from — but only in a real batch, where "Could not set
      // horizontal sizing on X" is otherwise unattributable.
      for (const warning of result.warnings) {
        warnings.push(docs.length > 1 ? `${doc.name}: ${warning}` : warning);
      }
    } catch (error) {
      // `buildDocument` already removed its own partial tree. One unbuildable
      // screen out of fourteen is a line in the summary, not a dead import.
      rootByDoc.push(null);
      perDocument.push({
        name: doc.name,
        ok: false,
        message: describeError(error),
      });
    }
  }

  const section = options.flow?.section
    ? groupIntoSection(roots, options.flow.section, warnings)
    : null;

  // A section re-bases its children's coordinates, so the grid is computed in
  // the section's own space and the section itself is then dropped at the batch
  // origin. Laying out first and reparenting after would move every frame by
  // the origin a second time.
  layoutBatch(roots, section ? { x: 0, y: 0 } : origin, placement);
  if (section) fitSection(section, roots, origin, placement);

  const wiring = options.flow
    ? await wireFlow(rootByDoc, options.flow, options.trigger ?? DEFAULT_FLOW_TRIGGER, warnings)
    : { reactions: 0, flows: 0 };

  return {
    roots,
    section,
    nodeCount,
    // Read once. A shared registry hands every BuildResult the same report
    // object, so summing the per-document mappings multiplies the batch
    // totals by the number of documents and nothing fails.
    mapping: registry.report,
    substitutions,
    warnings,
    perDocument,
    reactions: wiring.reactions,
    flows: wiring.flows,
  };
}

// ---------------------------------------------------------------------------
// Prototype flows
//
// A "flow diagram" here is real prototype wiring, not drawn geometry.
// `figma.createConnector` carries "Note: This API is only available in FigJam"
// in @figma/plugin-typings 1.131.0 and manifest.json declares
// `"editorType": ["figma"]`, so the arrows a diagram would be made of cannot be
// created at all from a Design file. Drawing them as vectors instead would buy
// a picture and cost a prototype: dead geometry that does not follow a frame
// the designer moves, cannot be clicked, and has to be deleted before handoff.
//
// Reactions are the live version of the same thing. They render as noodles the
// moment the Prototype tab is open (or on ⇧E, per Figma Help "View prototype
// connections"), they survive a frame being moved or renamed, and they walk in
// presentation view.
// ---------------------------------------------------------------------------

/**
 * Group the batch's frames into a SectionNode.
 *
 * OFF by default, and the caller has to name a section to get one. Figma Help
 * confirms a section "cannot be contained within frames or groups" and that
 * sections "help connect flows across different portions of your design", but
 * nothing documents whether a frame INSIDE a section is still a valid flow
 * starting point or NAVIGATE destination, and a section that quietly breaks
 * the prototype is worse than no grouping at all. Until that is checked in a
 * real Design file, `FlowSpec.section` stays null everywhere it is produced.
 *
 * A section that cannot be populated is undone rather than left half-built, for
 * the same reason `buildDocument` removes its own partial tree.
 */
function groupIntoSection(
  frames: FrameNode[],
  name: string,
  warnings: string[],
): SectionNode | null {
  if (frames.length === 0) return null;

  let section: SectionNode | null = null;
  try {
    section = figma.createSection();
    section.name = name;
    figma.currentPage.appendChild(section);
    for (const frame of frames) section.appendChild(frame);
    return section;
  } catch (error) {
    for (const frame of frames) {
      if (!frame.removed && frame.parent !== figma.currentPage) {
        figma.currentPage.appendChild(frame);
      }
    }
    if (section && !section.removed) section.remove();
    warnings.push(
      `Could not group the import into a section: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** Size the section to the grid it now holds, then drop it clear of existing content. */
function fitSection(
  section: SectionNode,
  frames: FrameNode[],
  origin: { x: number; y: number },
  placement: Placement,
): void {
  const gap = placement.gap ?? IMPORT_GAP;
  let width = 0;
  let height = 0;
  for (const frame of frames) {
    width = Math.max(width, frame.x + frame.width);
    height = Math.max(height, frame.y + frame.height);
  }
  // One gap of slack past the last frame. Sized to the exact bounding box, a
  // section clips the outermost frames' strokes and shadows against its own
  // edge, and the grid already puts a gap between every other pair.
  section.resizeWithoutConstraints(
    Math.max(width + gap, 0.01),
    Math.max(height + gap, 0.01),
  );
  section.x = origin.x;
  section.y = origin.y;
}

/**
 * Turn a `FlowSpec` into reactions on the built frames, plus one flow starting
 * point on the page.
 *
 * Never fatal. Every frame is already on the canvas and correct by the time
 * this runs; a refused reaction costs the walk-through, not the import.
 */
async function wireFlow(
  rootByDoc: Array<FrameNode | null>,
  flow: FlowSpec,
  trigger: Trigger,
  warnings: string[],
): Promise<{ reactions: number; flows: number }> {
  // Grouped by source frame because `setReactionsAsync` REPLACES a node's whole
  // reaction list. One call per edge would leave only the last outgoing edge of
  // any frame that has more than one, on a canvas that looks fully wired.
  const bySource = new Map<FrameNode, Reaction[]>();

  for (const edge of flow.edges) {
    const from = rootByDoc[edge.from];
    const to = rootByDoc[edge.to];
    // A document that failed to build has no frame to point at or from. Both
    // ends are checked because the FlowSpec was written against the batch the
    // UI sent, not against the batch that survived.
    if (!from || !to || from === to) continue;

    const list = bySource.get(from) ?? [];
    list.push({
      trigger,
      // `actions` (plural). The singular `action` field is deprecated in
      // @figma/plugin-typings 1.131.0.
      actions: [
        {
          type: "NODE",
          destinationId: to.id,
          navigation: "NAVIGATE",
          transition: null,
          resetScrollPosition: false,
        },
      ],
    });
    bySource.set(from, list);
  }

  let reactions = 0;
  for (const [frame, list] of bySource) {
    try {
      // The only write path: manifest.json declares
      // `"documentAccess": "dynamic-page"`, under which plugin-api.d.ts makes
      // `reactions` read-only. Assigning it throws in the editor.
      await frame.setReactionsAsync(list);
      reactions += list.length;
    } catch (error) {
      warnings.push(
        `Could not wire the prototype from "${frame.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { reactions, flows: addFlowStartingPoint(rootByDoc[flow.startIndex], flow.name, warnings) };
}

/**
 * Append one flow starting point, never replace the list.
 *
 * `figma.currentPage.flowStartingPoints` holds EVERY flow on the page in one
 * array, so assigning it wholesale deletes every flow the designer already drew
 * silently, with nothing on the canvas to notice and no recovery but undo.
 *
 * Set explicitly rather than relying on Figma to create one: whether the editor
 * auto-creates a starting point when a plugin sets the first reaction is not
 * documented either way, and the shipping plugins that do this set it by hand.
 * The nodeId de-dupe below covers being wrong about that; the only cost is the
 * flow keeping Figma's own "Flow 1" name instead of ours.
 *
 * Exported for the same reason `layoutBatch` and `batchOrigin` are: the
 * de-dupe is only reachable through an editor behaviour nothing can simulate,
 * so test/e2e/run.ts asserts it here directly.
 */
export function addFlowStartingPoint(
  start: FrameNode | null | undefined,
  name: string,
  warnings: string[] = [],
): number {
  if (!start) return 0;

  try {
    const existing = figma.currentPage.flowStartingPoints;
    if (existing.some((point) => point.nodeId === start.id)) return 1;
    figma.currentPage.flowStartingPoints = [...existing, { nodeId: start.id, name }];
    return 1;
  } catch (error) {
    warnings.push(
      `Could not start a prototype flow at "${start.name}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
}

export type MergedSystems = {
  /** The union, or undefined when no document in the batch carried a system. */
  system: IRDesignSystem | undefined;
  /**
   * Index-aligned with `docs`, unlike anything derived from `systems` below: a
   * document with no design system is still a document and still gets an entry,
   * or every screen after the first unsystemed one is handed the wrong map.
   */
  divergence: TokenDivergence[];
  /** One sentence per document that disagreed. Empty when they all agree. */
  notes: string[];
};

/**
 * Union of the batch's design systems, keyed by token path, first occurrence
 * winning.
 *
 * Screens from one Claude Design project link the same `_ds` files, so the
 * union is almost always identical to any single member's — but "almost
 * always" is not "always", and a batch built from one merged system binds every
 * screen against the same variables rather than racing to create them.
 *
 * "Almost always" is measurable on the real export: six of its 281 token paths
 * hold different values in `Portage Panel v1.dc.html` than in `Portage.dc.html`
 * and `Portage Panel.dc.html`, which agree.
 * `--figma-color-text-secondary` is `#757575` in one and `#767676` in the
 * others, and `--figma-color-text-danger` is `#d32f0f` against `#c8331a`, which
 * is eleven steps of red apart. First-occurrence-wins is right for the
 * VARIABLE: one name is one variable and something has to hold it. What is not
 * right is then binding the losing screen's layers to it, which is what
 * `divergence` exists to stop.
 */
export function mergeDesignSystems(docs: IRDocument[]): MergedSystems {
  const divergence: TokenDivergence[] = docs.map(() => NO_DIVERGENCE);
  const systems = docs
    .map((doc) => doc.designSystem)
    .filter((system): system is IRDesignSystem => !!system);

  if (systems.length === 0) return { system: undefined, divergence, notes: [] };
  // The union of one set is that set. Returning it untouched is what keeps a
  // single-document import identical to what `buildDocument` did before this
  // batch path existed, however the merge below grows. One system is also one
  // opinion about every token's value, so there is nothing to diverge from.
  if (systems.length === 1) return { system: systems[0], divergence, notes: [] };

  const byPath = new Map<string, IRTokenDefinition>();
  // Which document got there first, for the sentence the user reads. Tracked
  // here rather than recovered afterwards: `systems` has already dropped the
  // documents that carried no system, so its indices are not `docs`'.
  const ownerByPath = new Map<string, string>();
  for (const doc of docs) {
    for (const token of doc.designSystem?.tokens ?? []) {
      if (byPath.has(token.path)) continue;
      byPath.set(token.path, token);
      ownerByPath.set(token.path, doc.name);
    }
  }

  // Surfaces, the system key and the shadow tokens have to come across too.
  // Dropping them costs nothing in mode (a) and silently demotes a build to a
  // flat, single-mode, unstamped collection with no effect styles — the moment
  // a user imports fourteen screens at once instead of one, with every counter
  // still reading correct.
  const shadowsByPath = new Map<string, IRShadowToken>();
  for (const system of systems) {
    for (const shadow of system.shadows ?? []) {
      if (!shadowsByPath.has(shadow.buildPath)) shadowsByPath.set(shadow.buildPath, shadow);
    }
  }

  const surfaces = systems.find((system) => system.surfaces?.length)?.surfaces;

  // Which of those surfaces is the document-declared axis, carried for the same
  // reason `surfaces` is: without it Map mode cannot tell an axis a layer
  // really sits under from a design system's other product surfaces, and a
  // batch imports its themed halves as literals while every counter still reads
  // correct. Every screen of one export declares the same axis, but a batch can
  // mix a screen that declares one with a screen that does not, so this is the
  // union filtered back down to the surfaces in play. Filtered rather than
  // merged, so the invariant that `axis` names only selectors `surfaces` has
  // cannot be broken by two systems disagreeing.
  const declared = new Set<string>();
  for (const system of systems) {
    for (const selector of system.axis ?? []) declared.add(selector);
  }
  const axis = (surfaces ?? [])
    .filter((surface) => declared.has(surface.selector))
    .map((surface) => surface.selector);

  const system: IRDesignSystem = {
    name: systems.find((system) => system.name)?.name ?? "",
    tokens: [...byPath.values()],
    surfaces,
    axis: axis.length > 0 ? axis : undefined,
    baseModeLabel: systems.find((system) => system.baseModeLabel)?.baseModeLabel,
    key: systems.find((system) => system.key)?.key,
    shadows: shadowsByPath.size > 0 ? [...shadowsByPath.values()] : undefined,
  };

  const notes = findDivergence(docs, byPath, ownerByPath, surfaces, divergence);
  return { system, divergence, notes };
}

/**
 * Which of each document's tokens the merged system does not agree with.
 *
 * Every mode the collection can grow is compared, not just the base one,
 * because a token can agree in one theme and differ in another: the real
 * export's `--figma-color-bg-selected` is identical in `.cd2f-theme-light` and
 * differs only inside `.cd2f-theme-dark`. Refusing that token outright would
 * cost the light half of a screen a binding that was never wrong, so the two
 * values are kept and the mode is decided per node in `bindableToken`.
 *
 * Surfaces the merged system knows about, base layer included, and no more.
 * Build mode gives every surface a mode and Map mode gives the document's axis
 * one, so this list is the union of what either write path can produce.
 */
function findDivergence(
  docs: IRDocument[],
  byPath: Map<string, IRTokenDefinition>,
  ownerByPath: Map<string, string>,
  surfaces: IRSurface[] | undefined,
  out: TokenDivergence[],
): string[] {
  const selectors: Array<string | null> = [
    null,
    ...(surfaces ?? []).map((surface) => surface.selector),
  ];
  const notes: string[] = [];

  for (let index = 0; index < docs.length; index++) {
    const found = new Map<string, DivergentToken>();
    for (const token of docs[index].designSystem?.tokens ?? []) {
      const bound = byPath.get(token.path);
      // Identity, not equality: `byPath` holds the very object the first
      // document declared, so this is "did I declare it first", and the first
      // declarer is the one whose value the variable carries.
      if (!bound || bound === token) continue;
      const differs = selectors.some(
        (selector) =>
          !sameSurfaceValue(surfaceValueOf(token, selector), surfaceValueOf(bound, selector)),
      );
      if (differs) found.set(token.path, { declared: token, bound });
    }

    if (found.size === 0) continue;
    out[index] = found;
    notes.push(divergenceNote(docs[index].name, found, ownerByPath));
  }

  return notes;
}

/**
 * One plain sentence about a name two screens of the same export disagree on.
 *
 * Written to the pattern `modeCapNote` and `noOverflowNote` (both
 * src/plugin/mapping.ts) set: name the thing, name what it affects, say what
 * happened to it on canvas. A bare count would be the failure those two exist
 * to correct, because "6 tokens diverged" tells a user neither which layers to
 * look at nor that anything is even wrong.
 *
 * Three names then a count, because the real export produces six on one screen
 * and a summary line that lists all of them is a summary line nobody finishes.
 */
function divergenceNote(
  name: string,
  divergent: TokenDivergence,
  ownerByPath: Map<string, string>,
): string {
  const tokens = [...divergent.values()].map((entry) => entry.declared.name).sort();
  const shown = tokens.slice(0, 3);
  const rest = tokens.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")} and ${rest} others` : joinNames(shown);

  const owners = joinNames([
    ...new Set([...divergent.keys()].map((path) => ownerByPath.get(path) ?? "")),
  ]);
  const one = tokens.length === 1;

  return (
    `${name} declares ${list} at ${one ? "a different value" : "different values"} from ` +
    `${owners}, which declared ${one ? "it" : "them"} first. One name is one variable, so ` +
    `${owners}'s value${one ? "" : "s"} ${one ? "is" : "are"} what the file holds and the ` +
    `affected layers in ${name} imported as literals rather than binding to a colour they ` +
    `do not render.`
  );
}

/**
 * Top-left corner clear of everything already on the page.
 *
 * Call once, BEFORE appending any frame of the batch. Because the batch starts
 * to the right of every existing node, y = 0 cannot collide with anything.
 */
export function batchOrigin(): { x: number; y: number } {
  let maxX = -Infinity;
  for (const node of figma.currentPage.children) {
    maxX = Math.max(maxX, node.x + node.width);
  }
  return { x: maxX === -Infinity ? 0 : maxX + IMPORT_GAP, y: 0 };
}

/**
 * Arrange built frames in a wrapping grid from `origin`.
 *
 * `ceil(sqrt(n))` columns rather than one row: 14 screens in a row is 20,000px
 * wide and unreadable at any zoom that shows more than one of them. Rows are
 * ragged because screen heights differ, so each row advances by its own
 * tallest frame and rows cannot overlap.
 */
export function layoutBatch(
  frames: FrameNode[],
  origin: { x: number; y: number },
  placement: Placement = {},
): void {
  const gap = placement.gap ?? IMPORT_GAP;
  const columns = Math.max(1, placement.columns ?? Math.ceil(Math.sqrt(frames.length)));

  let x = origin.x;
  let y = origin.y;
  let rowHeight = 0;

  frames.forEach((frame, index) => {
    if (index > 0 && index % columns === 0) {
      x = origin.x;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    frame.x = x;
    frame.y = y;
    x += frame.width + gap;
    rowHeight = Math.max(rowHeight, frame.height);
  });
}

function countNodes(node: IRNode): number {
  let total = 1;
  for (const child of node.children) total += countNodes(child);
  return total;
}

/**
 * Hand control back to Figma periodically.
 *
 * Node creation is synchronous, so a few thousand of them in one run freezes
 * the editor with no progress and no way out. Yielding on a time budget rather
 * than a node count keeps the UI responsive whether the document is a hundred
 * simple frames or a handful of very expensive text nodes.
 */
async function maybeYield(ctx: BuildCtx, label: string): Promise<void> {
  const now = Date.now();
  if (now - ctx.lastYield < 120) return;
  ctx.lastYield = now;
  ctx.onProgress(ctx.count, ctx.total, label);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function collectFontRequests(
  node: IRNode,
  out: Array<{ family: string; weight: number; italic: boolean }> = [],
): Array<{ family: string; weight: number; italic: boolean }> {
  if (node.text) {
    for (const run of node.text.runs) {
      out.push({
        family: run.fontFamily,
        weight: run.fontWeight,
        italic: run.italic,
      });
    }
  }
  for (const child of node.children) collectFontRequests(child, out);
  return out;
}

/**
 * Drop the import to the right of whatever is already on the page.
 *
 * Not `batchOrigin()`: this runs after the root is already a child of the
 * page, so it has to skip the node it is placing or it would measure itself
 * and walk off to the right forever.
 */
function placeBesideExistingContent(root: FrameNode): void {
  let maxX = -Infinity;
  for (const node of figma.currentPage.children) {
    if (node === root) continue;
    maxX = Math.max(maxX, node.x + node.width);
  }
  root.x = maxX === -Infinity ? 0 : maxX + IMPORT_GAP;
  root.y = 0;
}

// ---------------------------------------------------------------------------
// Node dispatch
// ---------------------------------------------------------------------------

async function buildNode(node: IRNode, ctx: BuildCtx): Promise<SceneNode | null> {
  ctx.count++;
  await maybeYield(ctx, `Building ${node.name || node.kind.toLowerCase()}…`);

  // Save and restore around the subtree, so a sibling outside the theme is not
  // measured against it. Nothing is restored on a throw, and nothing needs to
  // be: `buildDocument` removes its own partial tree and this context dies with
  // the document rather than carrying on into the next one.
  const outerScope = ctx.themeScope;
  if (node.themeScope) ctx.themeScope = node.themeScope;

  let built: SceneNode | null;
  switch (node.kind) {
    case "TEXT":
      built = await buildText(node, ctx);
      break;
    case "IMAGE":
      built = await buildImage(node, ctx);
      break;
    case "VECTOR":
      built = await buildVector(node, ctx);
      break;
    default:
      built = await buildFrame(node, ctx);
  }

  ctx.themeScope = outerScope;

  if (built && node.themeScope) applyThemeMode(built, node.themeScope, ctx);
  return built;
}

/**
 * Switch a themed subtree into its own variable mode.
 *
 * The one call that makes two themes share one set of variables: the light and
 * dark panels bind the same `--figma-color-text-tertiary`, and this is what
 * decides that the dark one renders `#7e7e7e`. Figma resolves modes down the
 * tree, so setting it on the outermost frame covers everything inside it.
 *
 * Silent when the theme has no mode. The bindings under it were already refused
 * by `bindableToken`, so there is nothing to switch and nothing to say twice:
 * the summary already carries `modeCapNote`'s sentence about it.
 */
function applyThemeMode(node: SceneNode, selector: string, ctx: BuildCtx): void {
  const modes = ctx.registry.themeModes;
  const modeId = modes?.bySelector.get(selector);
  if (!modes || !modeId) return;

  try {
    node.setExplicitVariableModeForCollection(modes.collection, modeId);
  } catch {
    // Older API surface, or a node type that refuses it. The values are already
    // on the canvas; only the mode switch is lost.
  }
}

/**
 * A token reference the file can actually honour.
 *
 * A `TokenRef` carrying a `themeScope` is only correct inside that theme's
 * mode. When the theme has no mode, binding it anyway would show the other
 * theme's colour: on a Free plan the collection holds Light, so a bound dark
 * label renders `#b3b3b3` while reading as correctly bound in the layer panel.
 * That is this project's signature failure, so the literal wins instead.
 *
 * The second refusal is the same rule between SCREENS rather than between
 * themes. One name is one variable and the first screen to declare it owns the
 * value, so a screen that declares it differently would bind to a colour it
 * does not render. `Portage Panel v1.dc.html` puts
 * `--figma-color-text-secondary` at `#757575` where `Portage.dc.html` puts
 * `#767676`, and seven of its text runs bound to the wrong one. This is the
 * third application of one idea: never bind something to a value that renders
 * wrong just so it reads as bound. The other two are the theme check directly
 * above, and `resolveVariables` (src/plugin/mapping.ts) keeping re-themed
 * tokens out of the user's own single-mode collection, because one token cannot
 * be two colours.
 *
 * Refusing the losing screen rather than the owning one is what makes every
 * screen right: the owner binds to its own colour, the other keeps its own
 * literal, and nobody gets a colour that belongs to a different screen.
 */
function bindableToken(
  token: TokenRef | undefined,
  ctx: BuildCtx,
): TokenRef | undefined {
  if (!token) return undefined;
  if (token.themeScope && !ctx.registry.themeModes?.bySelector.has(token.themeScope)) {
    return undefined;
  }
  return rendersWhatItWouldBind(token, ctx) ? token : undefined;
}

/**
 * Whether the variable behind this ref holds, in the mode this node sits in,
 * the value this document renders there.
 *
 * Asked per node rather than per token because a document can disagree with the
 * batch in one theme and agree in another, and a token that agrees where the
 * node actually resolves is a binding worth keeping.
 */
function rendersWhatItWouldBind(token: TokenRef, ctx: BuildCtx): boolean {
  const divergent = ctx.divergence.get(token.path);
  if (!divergent) return true;
  return sameSurfaceValue(
    surfaceValueOf(divergent.declared, ctx.themeScope),
    surfaceValueOf(divergent.bound, boundSelector(ctx)),
  );
}

/**
 * Which of the variable's mode cells this node will read.
 *
 * A theme with a mode of its own reads that mode. A theme with no mode reads
 * the collection's default, which carries the base layer, and that is `null`
 * here. The third case is a theme `bindableModes` (src/plugin/mapping.ts)
 * pointed AT the default mode: `bySelector` has it, so this answers with the
 * selector, and that is not a discrepancy: it maps a theme onto the default
 * mode only when `ridesBaseMode` says the base layer already holds that theme's
 * values in full, so the two cells are the same values by construction.
 */
function boundSelector(ctx: BuildCtx): string | null {
  const scope = ctx.themeScope;
  if (!scope) return null;
  return ctx.registry.themeModes?.bySelector.has(scope) ? scope : null;
}

async function buildFrame(node: IRNode, ctx: BuildCtx): Promise<FrameNode> {
  const frame = figma.createFrame();
  frame.name = node.name;
  frame.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
  frame.clipsContent = node.clips;
  frame.opacity = node.opacity;

  applyFills(frame, node, ctx);
  applyStroke(frame, node, ctx);
  applyCorners(frame, node, ctx);
  applyEffects(frame, node);

  const built: SceneNode[] = [];
  // The IR children that actually produced a node, in the same order as
  // `built`. A child can build to null (a bad image, an empty vector), which
  // would otherwise slide every later child's sizing and position onto the
  // wrong node.
  const builtIr: IRNode[] = [];
  for (const child of node.children) {
    const childNode = await buildNode(child, ctx);
    if (!childNode) continue;
    frame.appendChild(childNode);
    built.push(childNode);
    builtIr.push(child);
  }

  if (node.layout) {
    const layout = node.layout;
    frame.layoutMode = layout.mode;
    frame.layoutWrap = layout.wrap ? "WRAP" : "NO_WRAP";
    frame.itemSpacing = layout.gap;
    if (layout.wrap) frame.counterAxisSpacing = layout.crossGap;

    frame.paddingTop = layout.padding.top;
    frame.paddingRight = layout.padding.right;
    frame.paddingBottom = layout.padding.bottom;
    frame.paddingLeft = layout.padding.left;

    frame.primaryAxisAlignItems = layout.primaryAlign;
    // Figma has no BASELINE on the counter axis; CENTER is the closest read.
    frame.counterAxisAlignItems =
      layout.crossAlign === "BASELINE" ? "CENTER" : layout.crossAlign;

    // Keep the frame at its measured size by default: hugging everywhere would
    // let font substitution or a rounding difference resize the whole screen.
    // The exception is a chip or badge wrapping one line of text, which hugs in
    // the source too and otherwise traps its label at the measured width.
    if (layout.hugContent) {
      frame.primaryAxisSizingMode = "AUTO";
      frame.counterAxisSizingMode = "AUTO";
    } else {
      frame.primaryAxisSizingMode = "FIXED";
      frame.counterAxisSizingMode = "FIXED";
      frame.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
    }

    bindField(frame, "itemSpacing" as VariableBindableNodeField, bindableToken(layout.gapToken, ctx), ctx.registry);
    if (layout.paddingTokens) {
      bindField(frame, "paddingTop" as VariableBindableNodeField, bindableToken(layout.paddingTokens.top, ctx), ctx.registry);
      bindField(frame, "paddingRight" as VariableBindableNodeField, bindableToken(layout.paddingTokens.right, ctx), ctx.registry);
      bindField(frame, "paddingBottom" as VariableBindableNodeField, bindableToken(layout.paddingTokens.bottom, ctx), ctx.registry);
      bindField(frame, "paddingLeft" as VariableBindableNodeField, bindableToken(layout.paddingTokens.left, ctx), ctx.registry);
    }

    applyChildSizing(builtIr, built, ctx);
    pinAbsoluteChildren(builtIr, built, ctx);
  } else {
    for (let i = 0; i < built.length; i++) {
      built[i].x = builtIr[i].x;
      built[i].y = builtIr[i].y;
    }
  }

  return frame;
}

/**
 * Take a child out of the parent's auto-layout flow and pin it at its own x/y,
 * the way Figma's `layoutPositioning = "ABSOLUTE"` does. The one caller is the
 * synthesised select chevron: it overlays the field's arrow band while the
 * option text keeps flowing and centring, so the two cannot share a stacking
 * axis. Absolute children are also excluded from a hugging frame's size, which
 * is exactly what the arrow band wants — it must not widen the field.
 */
function pinAbsoluteChildren(
  irChildren: IRNode[],
  built: SceneNode[],
  ctx: BuildCtx,
): void {
  for (let i = 0; i < built.length; i++) {
    if (!irChildren[i]?.absolute) continue;
    const child = built[i] as SceneNode & {
      layoutPositioning?: "AUTO" | "ABSOLUTE";
    };
    try {
      child.layoutPositioning = "ABSOLUTE";
      child.x = irChildren[i].x;
      child.y = irChildren[i].y;
    } catch {
      ctx.warnings.push(`Could not pin "${child.name}" absolutely`);
    }
  }
}

function applyChildSizing(
  irChildren: IRNode[],
  built: SceneNode[],
  ctx: BuildCtx,
): void {
  for (let i = 0; i < built.length; i++) {
    const spec = irChildren[i]?.sizing;
    if (!spec) continue;

    const child = built[i] as SceneNode & {
      layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
      layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
    };

    // HUG is only legal on auto-layout frames and text; asking for it
    // elsewhere throws, so fall back to the measured size.
    const canHug =
      child.type === "TEXT" ||
      (child.type === "FRAME" && (child as FrameNode).layoutMode !== "NONE");

    try {
      child.layoutSizingHorizontal =
        spec.horizontal === "HUG" && !canHug ? "FIXED" : spec.horizontal;
    } catch {
      ctx.warnings.push(`Could not set horizontal sizing on "${child.name}"`);
    }

    try {
      child.layoutSizingVertical =
        spec.vertical === "HUG" && !canHug ? "FIXED" : spec.vertical;
    } catch {
      ctx.warnings.push(`Could not set vertical sizing on "${child.name}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

async function buildText(node: IRNode, ctx: BuildCtx): Promise<TextNode | null> {
  const spec = node.text;
  if (!spec) return null;

  const text = figma.createText();
  const first = spec.runs[0];

  // The default font has to be loaded and assigned before `characters`,
  // otherwise Figma throws on unloaded-font mutation.
  const baseFont = first
    ? ctx.fonts.resolve(first.fontFamily, first.fontWeight, first.italic)
    : { family: "Inter", style: "Regular" };
  try {
    text.fontName = baseFont;
  } catch {
    try {
      text.fontName = { family: "Inter", style: "Regular" };
    } catch {
      // Not even the fallback loaded. One missing label beats a missing screen.
      text.remove();
      ctx.warnings.push(`Skipped the text "${spec.characters.slice(0, 40)}": no font could be loaded for it.`);
      return null;
    }
  }
  text.characters = spec.characters;

  text.name = node.name;
  text.opacity = node.opacity;
  text.textAlignHorizontal = spec.align;
  text.textAlignVertical = spec.verticalAlign;

  for (const run of spec.runs) {
    const start = Math.max(0, Math.min(run.start, spec.characters.length));
    const end = Math.max(start, Math.min(run.end, spec.characters.length));
    if (end <= start) continue;
    applyRun(text, start, end, run, ctx);
  }

  text.resize(Math.max(node.width, 1), Math.max(node.height, 1));

  // Text that was one line in the source must stay one line. A substituted
  // font is rarely the same width, and a fixed-width box re-wraps the moment
  // the replacement runs a few pixels wider — which lands as labels collapsing
  // onto two lines and overlapping their neighbours. Letting the box grow is
  // the lesser distortion. Genuinely wrapped text keeps its measured width so
  // its line breaks survive.
  text.textAutoResize = spec.singleLine ? "WIDTH_AND_HEIGHT" : "HEIGHT";

  applyEffects(text, node);
  return text;
}

function applyRun(
  text: TextNode,
  start: number,
  end: number,
  run: IRTextRun,
  ctx: BuildCtx,
): void {
  const font = ctx.fonts.resolve(run.fontFamily, run.fontWeight, run.italic);

  try {
    text.setRangeFontName(start, end, font);
    text.setRangeFontSize(start, end, Math.max(1, run.fontSize));
    text.setRangeFills(start, end, [
      bindPaint(
        { type: "SOLID", color: toRGB(run.fill.color), opacity: run.fill.color.a },
        bindableToken(run.fill.token, ctx),
        ctx.registry,
      ) as SolidPaint,
    ]);
    text.setRangeLineHeight(
      start,
      end,
      run.lineHeight === null
        ? { unit: "AUTO" }
        : { value: run.lineHeight, unit: "PIXELS" },
    );
    text.setRangeLetterSpacing(start, end, {
      value: run.letterSpacing,
      unit: "PIXELS",
    });
    text.setRangeTextDecoration(start, end, run.decoration);
    text.setRangeTextCase(start, end, run.textCase);

    if (run.href) {
      text.setRangeHyperlink(start, end, { type: "URL", value: run.href });
    }
  } catch (error) {
    ctx.warnings.push(
      `Text styling failed on "${text.name}": ${(error as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Images and vectors
// ---------------------------------------------------------------------------

async function buildImage(node: IRNode, ctx: BuildCtx): Promise<SceneNode | null> {
  if (!node.imageBytes) return null;

  try {
    const image = figma.createImage(node.imageBytes);
    const rect = figma.createRectangle();
    rect.name = node.name;
    rect.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
    rect.opacity = node.opacity;
    rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
    applyCorners(rect, node, ctx);
    applyEffects(rect, node);
    return rect;
  } catch (error) {
    ctx.warnings.push(`Image "${node.name}" failed: ${(error as Error).message}`);
    return null;
  }
}

async function buildVector(node: IRNode, ctx: BuildCtx): Promise<SceneNode | null> {
  if (!node.svg) return null;

  try {
    const wrapper = figma.createNodeFromSvg(node.svg);
    wrapper.name = node.name;
    wrapper.resize(Math.max(node.width, 0.01), Math.max(node.height, 0.01));
    wrapper.opacity = node.opacity;

    // `createNodeFromSvg` always returns a frame around the geometry. For a
    // single-path icon that is a wasted layer, and a screen with two dozen
    // icons ends up with two dozen "Vector > Vector" pairs to click through.
    // Collapse it only when the child genuinely fills the wrapper, so nothing
    // moves; anything with real internal structure keeps its frame.
    if (wrapper.children.length === 1) {
      const child = wrapper.children[0];
      if (
        Math.abs(child.width - wrapper.width) < 0.5 &&
        Math.abs(child.height - wrapper.height) < 0.5
      ) {
        // Reparent before removing, or the child goes with its parent.
        figma.currentPage.appendChild(child);
        wrapper.remove();
        child.name = node.name;
        // SliceNode has no opacity, and SVG import can in principle yield one.
        if ("opacity" in child) child.opacity = node.opacity;
        return child;
      }
    }

    return wrapper;
  } catch (error) {
    ctx.warnings.push(`SVG "${node.name}" failed: ${(error as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Paint / stroke / corners / effects
// ---------------------------------------------------------------------------

function applyFills(node: FrameNode, ir: IRNode, ctx: BuildCtx): void {
  if (ir.fills.length === 0) {
    node.fills = [];
    return;
  }
  node.fills = ir.fills
    .map((paint) => toFigmaPaint(paint, ctx))
    .filter((p): p is Paint => p !== null);
}

function toFigmaPaint(paint: IRPaint, ctx: BuildCtx): Paint | null {
  if (paint.type === "SOLID") {
    const solid: SolidPaint = {
      type: "SOLID",
      color: toRGB(paint.color),
      opacity: paint.color.a,
    };
    return bindPaint(solid, bindableToken(paint.token, ctx), ctx.registry);
  }

  if (paint.type === "GRADIENT_LINEAR") {
    return {
      type: "GRADIENT_LINEAR",
      gradientTransform: gradientTransform(paint.angle),
      gradientStops: paint.stops.map((stop) => ({
        position: Math.min(1, Math.max(0, stop.position)),
        color: { ...toRGB(stop.color), a: stop.color.a },
      })),
    };
  }

  return null;
}

/**
 * CSS gradient angle -> Figma gradient transform.
 *
 * CSS measures from "to top" clockwise; Figma's gradient space runs along +x
 * in a unit square, so we rotate by (angle - 90deg) about the centre.
 */
function gradientTransform(angleDeg: number): Transform {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [cos, sin, 0.5 - 0.5 * cos - 0.5 * sin],
    [-sin, cos, 0.5 + 0.5 * sin - 0.5 * cos],
  ];
}

function applyStroke(node: FrameNode, ir: IRNode, ctx: BuildCtx): void {
  if (!ir.border) {
    node.strokes = [];
    return;
  }

  const { weights, paint, dashed } = ir.border;
  node.strokes = [
    bindPaint(
      { type: "SOLID", color: toRGB(paint.color), opacity: paint.color.a },
      bindableToken(paint.token, ctx),
      ctx.registry,
    ),
  ];
  // CSS borders sit inside the border box, so INSIDE keeps geometry identical.
  node.strokeAlign = "INSIDE";

  const uniform =
    weights.top === weights.right &&
    weights.top === weights.bottom &&
    weights.top === weights.left;

  if (uniform) {
    node.strokeWeight = weights.top;
  } else {
    node.strokeTopWeight = weights.top;
    node.strokeRightWeight = weights.right;
    node.strokeBottomWeight = weights.bottom;
    node.strokeLeftWeight = weights.left;
  }

  if (dashed) node.dashPattern = [4, 4];
}

function applyCorners(
  node: FrameNode | RectangleNode,
  ir: IRNode,
  ctx: BuildCtx,
): void {
  const { tl, tr, br, bl } = ir.cornerRadius;
  node.topLeftRadius = tl;
  node.topRightRadius = tr;
  node.bottomRightRadius = br;
  node.bottomLeftRadius = bl;

  if (tl === tr && tl === br && tl === bl) {
    const corner = bindableToken(ir.cornerToken, ctx);
    bindField(node, "topLeftRadius" as VariableBindableNodeField, corner, ctx.registry);
    bindField(node, "topRightRadius" as VariableBindableNodeField, corner, ctx.registry);
    bindField(node, "bottomRightRadius" as VariableBindableNodeField, corner, ctx.registry);
    bindField(node, "bottomLeftRadius" as VariableBindableNodeField, corner, ctx.registry);
  }
}

function applyEffects(node: SceneNode & { effects: readonly Effect[] }, ir: IRNode): void {
  if (ir.effects.length === 0) return;

  const effects: Effect[] = [];
  for (const effect of ir.effects) {
    effects.push(toFigmaEffect(effect));
  }
  node.effects = effects;
}

function toFigmaEffect(effect: IREffect): Effect {
  switch (effect.type) {
    case "LAYER_BLUR":
    case "BACKGROUND_BLUR":
      return {
        type: effect.type,
        radius: effect.radius,
        visible: true,
      } as Effect;
    default:
      return {
        type: effect.type,
        color: { ...toRGB(effect.color), a: effect.color.a },
        offset: { x: effect.offsetX, y: effect.offsetY },
        radius: effect.blur,
        spread: effect.spread,
        visible: true,
        blendMode: "NORMAL",
      } as Effect;
  }
}

function toRGB(color: IRColor): RGB {
  return { r: color.r, g: color.g, b: color.b };
}
