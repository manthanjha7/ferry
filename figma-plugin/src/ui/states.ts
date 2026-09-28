/**
 * Which prop combinations a document imports as, and what each frame is called.
 *
 * A document's `data-props` schema is already its prototype definition: the
 * Portage panel declares `state` (enum, 7 options) and `theme` (enum, 2), and
 * the board its author hand-assembled beside it holds exactly those 14 panels,
 * seven light then seven dark. Nobody wrote that grid down twice on purpose —
 * it is the cross-product of the schema, laid out by hand because there was no
 * way to ask for it.
 *
 * Split out of src/ui/extract.ts for the reason src/ui/screens.ts is split out
 * of main.ts: this half has no DOM in it, so it can be asserted on directly
 * (test/e2e/run.ts scenarios N and O) while the extraction half needs a browser
 * and a live layout engine.
 */

import type { FlowSpec } from "../ir";

/**
 * One prop being enumerated, and the values it takes.
 *
 * Ordered: axis 0 varies FASTEST, so it is the axis that reads left to right
 * across the imported grid.
 */
export type StateAxis = { name: string; values: Array<string | number | boolean> };

/**
 * The most frames one enumeration produces.
 *
 * Every combination is a full `extractDocument`: a fresh mount, a stylesheet
 * race, an asset race, and a whole-tree walk. 24 clears the Portage panel's 14
 * with headroom and keeps the worst case to roughly a minute, and it is small
 * enough that the refusal above it is actionable ("untick a prop") rather than
 * a wall.
 */
export const STATE_COMBINATION_CAP = 24;

/** The separator in a state frame's name, shared with `deckSlideName` (src/ui/extract.ts). */
const NAME_SEPARATOR = "·";

/**
 * The enumerable props that are worth an axis, from `enumerableProps`
 * (src/ui/resolve.ts).
 *
 * Two narrowings on top of what the resolver reports:
 *
 * - Fewer than two values is not an axis. It multiplies the matrix by one and
 *   adds a segment to every frame name that never varies.
 * - Values have to be primitives. The document compares them with `===`
 *   (`this.props.theme === 'dark'` in the Portage panel), so an object option
 *   could never match what the markup tests for, and it has no honest spelling
 *   in a frame name either.
 */
export function stateAxes(props: Array<{ name: string; values: unknown[] }>): StateAxis[] {
  const axes: StateAxis[] = [];
  for (const prop of props) {
    const values = prop.values.filter(
      (value): value is string | number | boolean =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean",
    );
    if (values.length !== prop.values.length || values.length < 2) continue;
    axes.push({ name: prop.name, values });
  }
  return axes;
}

/**
 * What the panel starts with ticked: the single axis with the most values.
 *
 * Deliberately NOT the cross-product. Cost is per combination and real, and the
 * cross-product is frequently meaningless — this very document declares `width`
 * (an int range) and `sfx` (an id suffix), neither of which is a state, and its
 * author paired `state` with `theme` by hand rather than taking everything the
 * schema offered. So the widest axis is the useful guess and the rest is the
 * user's call.
 *
 * Ties go to declaration order, which is the only ordering signal the document
 * gives.
 */
export function defaultStateSelection(axes: StateAxis[]): string[] {
  let best: StateAxis | null = null;
  for (const axis of axes) {
    if (!best || axis.values.length > best.values.length) best = axis;
  }
  return best ? [best.name] : [];
}

/**
 * The axes the caller asked for, in the CALLER's order rather than the
 * schema's.
 *
 * Order is not cosmetic here: axis 0 varies fastest, so it decides both the
 * odometer and the shape of the grid. Ticking theme then state has to produce a
 * different import from ticking state then theme, or the control is lying about
 * what it does.
 */
export function selectAxes(axes: StateAxis[], names: string[]): StateAxis[] {
  const byName = new Map(axes.map((axis) => [axis.name, axis]));
  const chosen: StateAxis[] = [];
  for (const name of names) {
    const axis = byName.get(name);
    if (axis && !chosen.includes(axis)) chosen.push(axis);
  }
  return chosen;
}

/** One frame's worth of prop values, plus the half of its name that varies. */
export type PropCombination = {
  values: Record<string, string | number | boolean>;
  /** "state=empty · theme=light" */
  label: string;
};

export type CombinationPlan = {
  /** Empty when the matrix was refused, see `capped`. */
  combos: PropCombination[];
  total: number;
  cap: number;
  /** `total > cap`. The matrix is REFUSED, not trimmed. */
  capped: boolean;
  /** Frames per row, for `Placement.columns` (src/ir/index.ts). */
  columns: number;
};

/**
 * Every combination of the selected axes, odometer order, axis 0 fastest.
 *
 * Axis 0 fastest is what reproduces the layout the Portage board's author wrote
 * by hand: seven states across, then the whole row again in the other theme. The
 * reverse odometer produces the same 14 frames with the same 14 names and a grid
 * nobody drew.
 *
 * Over the cap the matrix is REFUSED, never trimmed: 24 of 54 frames looks
 * exactly like a complete import, and the states that went missing are the ones
 * nobody thinks to check for.
 */
export function propCombinations(
  selected: StateAxis[],
  cap: number = STATE_COMBINATION_CAP,
): CombinationPlan {
  if (selected.length === 0) {
    return { combos: [], total: 0, cap, capped: false, columns: 1 };
  }

  const total = selected.reduce((count, axis) => count * axis.values.length, 1);
  // Frames per row is axis 0's length, so one row is one full sweep of the
  // fastest axis and the grid reads as the matrix it is. With a single axis
  // there is no matrix to preserve, so it wraps at a width that stays legible.
  const columns = selected.length >= 2 ? selected[0].values.length : Math.min(total, 6);

  if (total > cap) return { combos: [], total, cap, capped: true, columns };

  const combos: PropCombination[] = [];
  for (let index = 0; index < total; index++) {
    const values: Record<string, string | number | boolean> = {};
    const parts: string[] = [];
    let stride = 1;
    for (const axis of selected) {
      const value = axis.values[Math.floor(index / stride) % axis.values.length];
      stride *= axis.values.length;
      values[axis.name] = value;
      parts.push(`${axis.name}=${String(value)}`);
    }
    combos.push({ values, label: parts.join(` ${NAME_SEPARATOR} `) });
  }

  return { combos, total, cap, capped: false, columns };
}

/** "Portage Panel · state=empty · theme=light" */
export function stateFrameName(docName: string, label: string): string {
  return `${docName} ${NAME_SEPARATOR} ${label}`;
}

/**
 * The prototype flow a state matrix implies.
 *
 * One chain per sweep of the FASTEST axis, and sweeps never join. Chaining
 * `state=empty → file → … → error` walks one prop through its values with
 * everything else held still, which is a transition the document describes; a
 * link from the last cell of one sweep to the first of the next would join
 * `state=error, theme=light` to `state=empty, theme=dark`, inventing a
 * transition across two independent axes at once that nothing in the schema
 * says anything about.
 *
 * The stride is axis 0's length rather than `CombinationPlan.columns` because
 * the two disagree for a single axis: seven states wrap at six columns to stay
 * legible, and breaking the chain at the wrap would strand the seventh state
 * for a purely cosmetic reason.
 *
 * Null below two cells. A lone frame has nothing to walk to, and a starting
 * point on it is a flow in name only.
 */
export function stateFlow(
  docName: string,
  selected: StateAxis[],
  plan: CombinationPlan,
): FlowSpec | null {
  if (selected.length === 0 || plan.combos.length < 2) return null;

  const stride = selected[0].values.length;
  const edges: Array<{ from: number; to: number }> = [];
  for (let index = 0; index + 1 < plan.combos.length; index++) {
    if (Math.floor(index / stride) !== Math.floor((index + 1) / stride)) continue;
    edges.push({ from: index, to: index + 1 });
  }
  if (edges.length === 0) return null;

  return {
    name: `${docName} states`,
    // The first cell of the first sweep, which is where a reader starts and
    // where presentation view should open. Deliberately not "the combination
    // where every prop equals its declared default": `enumerableProps`
    // (src/ui/resolve.ts) reports a prop's values and not its default, so that
    // rule cannot be computed from here, and for every enum in this export the
    // declared default is the first option anyway.
    startIndex: 0,
    edges,
    // Off until somebody confirms in a real Figma Design file that a frame
    // inside a SectionNode is still a valid flow starting point. No Figma
    // documentation says either way, and a section that quietly kills the
    // prototype is worse than no grouping. See `groupIntoSection`
    // (src/plugin/build.ts).
    section: null,
  };
}

/**
 * How big the frame for one combination is.
 *
 * `$preview` is the size Claude Design's own canvas previews the document at,
 * and it is what makes a matrix a matrix: a panel whose empty state measures
 * 380px tall and whose error state measures 540px would otherwise import as a
 * ragged grid of differently-sized cells for what is one component.
 *
 * The preview is a FLOOR, never a clamp. Content that outgrows its declared
 * preview is a real authoring signal, and cropping it to the declared size
 * would hide exactly the state the author most needs to see.
 *
 * Scoped to this path on purpose. a real chat-screen export declares
 * `$preview {1240,900}` and captured at 1440 x 1134.25, so applying this on the
 * ordinary single-document path would silently move an already-captured
 * fixture.
 */
export function previewFrameSize(
  measured: { width: number; height: number },
  preview: { width: number; height: number } | null,
): { width: number; height: number; overflows: boolean } {
  if (!preview) return { width: measured.width, height: measured.height, overflows: false };
  return {
    width: Math.max(measured.width, preview.width),
    height: Math.max(measured.height, preview.height),
    // A pixel of slack: measurement is sub-pixel and a 400.0000001 overflow is
    // not something to tell anybody about.
    overflows: measured.width > preview.width + 1 || measured.height > preview.height + 1,
  };
}

/**
 * The line under the picker, said before the click.
 *
 * It carries the arithmetic rather than just the answer, because the fix for a
 * refused matrix is to untick the prop that is multiplying it and the user
 * cannot see which one that is from "54 is too many".
 */
export function stateHint(selected: StateAxis[], plan: CombinationPlan): string {
  if (selected.length === 0) {
    return "Imports one frame, with the props the document declares as defaults.";
  }

  const breakdown = selected
    .map((axis) => `${axis.name} (${axis.values.length})`)
    .join(" × ");

  if (plan.capped) {
    return `${breakdown} is ${plan.total} combinations, past the ${plan.cap}-frame cap. Untick a prop.`;
  }
  return selected.length === 1
    ? `${plan.total} frames: ${breakdown}.`
    : `${plan.total} frames: ${breakdown}. The first varies fastest, one row per sweep.`;
}

/**
 * An animation's scenes as a prototype that plays itself: each frame waits
 * out its scene's duration and Smart Animates into the next, and a looping
 * animation returns to its first scene. Smart Animate matches layers by name,
 * which scene frames share because they are one element tree at different
 * moments.
 */
export function sceneFlow(
  docName: string,
  scenes: Array<{ name: string; dur: number }>,
  loop: boolean,
): FlowSpec | null {
  if (scenes.length < 2) return null;
  const TRANSITION_S = 0.4;
  const edges: FlowSpec["edges"] = [];
  for (let i = 0; i + 1 < scenes.length; i++) {
    edges.push({ from: i, to: i + 1, delay: Math.max(0.1, scenes[i].dur - TRANSITION_S), smart: true });
  }
  if (loop) {
    const last = scenes.length - 1;
    edges.push({ from: last, to: 0, delay: Math.max(0.1, scenes[last].dur - TRANSITION_S), smart: true });
  }
  return { name: `${docName} animation`, startIndex: 0, edges, section: null };
}
