/**
 * What a drop contains, and what each document in it is called.
 *
 * Split out of src/ui/main.ts because it is the one half of ingest with no DOM
 * in it: a `File[]` goes in, a `Screen[]` comes out. That is also what makes it
 * testable at all: main.ts binds every element at module top level, so nothing
 * in it can be imported outside a browser, while these rules can be asserted on
 * directly (test/e2e/run.ts scenario L).
 *
 * The rules here are the ones that fail quietly rather than loudly: a picker
 * with two entries reading "Panel", or a canvas board losing the default to a
 * component that happens to sort first.
 */

export type Screen = {
  /** Absent for pasted markup, which has no file behind it. */
  file?: File;
  /**
   * Picker label and the name of the top-level Figma frame this becomes.
   * Unique within a drop, see `labelScreens`.
   */
  label: string;
  /**
   * Inlined, asset-resolved markup. Filled in lazily by `prepareScreen`
   * (src/ui/main.ts) so accepting a 40-screen folder reads nothing; preset for
   * pasted markup.
   */
  html?: string;
  /** The other documents in the drop, for `<dc-import>`. Filled in with `html`. */
  documentSources?: Record<string, string>;
  /**
   * Why this document cannot be imported, when that is knowable.
   *
   * Per screen rather than a global abort: one unreadable file in a zip of
   * fourteen is a line in the summary, not a reason to refuse the other
   * thirteen.
   */
  skipReason?: string;
};

/** Which screens of the drop the user asked for. `"all"` is the whole picker. */
export type ScreenSelection = "all" | number;

/**
 * The most documents one import handles.
 *
 * Two limits with one number, because they are the same question asked twice.
 * A batch is structured-cloned to the sandbox in a single `postMessage` and
 * each document can carry rasterised image bytes; the practical ceiling for
 * that payload is unmeasured, so the batch stops here. And above this many
 * screens "All screens" stops being a default anybody meant to choose: forty
 * frames appearing on the canvas from one click is not a convenience.
 */
export const BATCH_LIMIT = 12;

/** "Chat Explorations.dc.html" -> "Chat Explorations" */
export function screenLabel(file: File): string {
  return file.name.replace(/\.(dc\.)?html$/i, "");
}

/**
 * Choose which documents in a drop are importable screens.
 *
 * Prefers Claude Design pages (`<name>.dc.html`), then the shallowest path, so
 * dropping a whole project folder picks the screens rather than nested export
 * artefacts that happen to sort first.
 */
export function htmlCandidates(files: File[]): File[] {
  const depth = (file: File) =>
    ((file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "")
      .split("/")
      .length;

  // At equal depth, a document whose name is a prefix of its siblings' is the
  // one that embeds them: a project called "Portage" holds "Portage.dc.html"
  // beside "Portage Panel.dc.html", and the board is what someone opening the
  // export means by the project. Alphabetical order picks "Portage Panel v1"
  // instead, which is a component nobody asked to see on its own.
  //
  // Ranked by HOW MANY siblings a name covers, not merely whether it covers
  // any. "Portage Panel" covers "Portage Panel v1", so a flag ties it with
  // "Portage" and the winner comes down to the order the zip happened to be
  // written in.
  const stems = files
    .filter((file) => file.name.toLowerCase().endsWith(".html"))
    .map((file) => file.name.replace(/\.(dc\.)?html$/i, ""));
  const embedsOthers = (file: File): number => {
    const stem = file.name.replace(/\.(dc\.)?html$/i, "");
    return -stems.filter((other) => other !== stem && other.startsWith(stem))
      .length;
  };

  const candidates = files
    .filter((file) => file.name.toLowerCase().endsWith(".html"))
    .sort((a, b) => depth(a) - depth(b) || embedsOthers(a) - embedsOthers(b));

  // A `.dc.html` is a real Claude Design page; anything else in a project
  // folder is more likely to be an export artefact.
  const authored = candidates.filter((file) =>
    file.name.toLowerCase().endsWith(".dc.html"),
  );
  return authored.length > 0 ? authored : candidates;
}

/** The folder a file sits in, or `""` when the drop carried no paths. */
function parentDirectory(file: File): string {
  const segments = (
    (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? ""
  ).split("/");
  return segments.length >= 2 ? segments[segments.length - 2] : "";
}

/**
 * Give every screen in the drop a distinct name.
 *
 * Two projects in one export can both hold a `Panel.dc.html`, and two
 * top-level frames both called "Panel" is a file nobody can navigate, and the
 * picker offering the same word twice is the same failure one step earlier.
 * The folder is what the author used to tell them apart, so that is what goes
 * in the label.
 *
 * A multi-select drag carries no `webkitRelativePath` at all, so there is
 * nothing to name the copies after and a counter is the honest fallback:
 * "Panel ()" twice would be worse than what it replaced.
 */
function labelScreens(files: File[]): string[] {
  const bases = files.map(screenLabel);
  const shared = new Set(bases.filter((base, i) => bases.indexOf(base) !== i));
  const used = new Set<string>();

  return bases.map((base, index) => {
    const parent = shared.has(base) ? parentDirectory(files[index]) : "";
    let label = parent ? `${base} (${parent})` : base;
    if (used.has(label)) {
      let ordinal = 2;
      while (used.has(`${label} ${ordinal}`)) ordinal++;
      label = `${label} ${ordinal}`;
    }
    used.add(label);
    return label;
  });
}

/** Every importable screen in a drop, in picker order. */
export function buildScreens(files: File[]): Screen[] {
  const candidates = htmlCandidates(files);
  const labels = labelScreens(candidates);
  return candidates.map((file, index) => ({ file, label: labels[index] }));
}

/**
 * What the picker starts on.
 *
 * "All screens" is the answer to what someone dropping a project export wants,
 * right up until the number stops being a batch and starts being a library.
 * Past `BATCH_LIMIT` the first screen is the safer default and the hint says
 * how many there were, so the choice is informed rather than absent.
 */
export function defaultSelection(count: number): ScreenSelection {
  return count > BATCH_LIMIT ? 0 : "all";
}

/**
 * The screens one Import click covers, capped at `BATCH_LIMIT`.
 *
 * Truncating is only defensible because it is said out loud before the click
 * (see `describeSelection` in src/ui/main.ts). Refusing outright would leave a
 * 40-screen export with no way in at all short of forty separate drops.
 */
export function selectedScreens(
  screens: Screen[],
  selection: ScreenSelection,
): Screen[] {
  if (selection === "all") return screens.slice(0, BATCH_LIMIT);
  const one = screens[selection];
  return one ? [one] : [];
}

/**
 * How many frames per row the batch is laid out in.
 *
 * A project's screens read side by side: that is how Claude Design's own
 * canvas shows them, and how a deck's slides already land here
 * (`walkDeckSlides`, src/ui/extract.ts). So a small batch is one row, which is
 * what makes three screens from a zip look like three screens from a zip.
 *
 * They wrap past four because a row of twelve 1440px screens is 19,000px wide,
 * and at a zoom that shows all of it none of it is legible. Without this the
 * sandbox's own `ceil(sqrt(n))` default (src/plugin/build.ts) puts three
 * screens in a 2x2 grid with a hole in it.
 */
export function batchColumns(count: number): number {
  return Math.max(1, Math.min(count, 4));
}

/** The line under the picker. Says what "All screens" will do, or why it is not the default. */
export function screenHint(count: number): string {
  return count > BATCH_LIMIT
    ? `${count} screens found. Pick one, or choose All screens to import the first ${BATCH_LIMIT}.`
    : "Each screen becomes its own top-level frame.";
}
