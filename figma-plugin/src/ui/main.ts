/**
 * UI entry point. Runs in the plugin iframe, which is the only half of a Figma
 * plugin with a layout engine — so this side does all the measuring and hands
 * the sandbox a finished IR tree.
 *
 * Everything here is local. The plugin declares no network access at all, which
 * is both a review-friendly position and an honest promise: the design never
 * leaves the machine.
 */

import { real } from "./clock";
import type {
  ExtractOptions,
  FlowSpec,
  IRDocument,
  PluginMessage,
  TargetSummary,
  VariableTarget,
} from "../ir";
import { adopt, extractor, resetExtractor } from "./realm";
import { describeError, messageOf } from "../errors";
import {
  BATCH_LIMIT,
  batchColumns,
  buildScreens,
  defaultSelection,
  htmlCandidates,
  screenHint,
  selectedScreens,
  type Screen,
  type ScreenSelection,
} from "./screens";
import {
  defaultStateSelection,
  propCombinations,
  selectAxes,
  sceneFlow,
  stateFlow,
  stateHint,
  type CombinationPlan,
  type StateAxis,
} from "./states";
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
} from "./token-mode";
import { readZip } from "./zip";

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const dropzone = el<HTMLDivElement>("cd2f-dropzone");
const fileInput = el<HTMLInputElement>("cd2f-file");
const folderInput = el<HTMLInputElement>("cd2f-folder");
const dsInput = el<HTMLInputElement>("cd2f-ds");
const dsStatus = el<HTMLSpanElement>("cd2f-ds-status");
const pageRow = el<HTMLDivElement>("cd2f-page-row");
const pageSelect = el<HTMLSelectElement>("cd2f-page");
const pageHint = el<HTMLDivElement>("cd2f-page-hint");
const statesRow = el<HTMLDivElement>("cd2f-states-row");
const statesSelect = el<HTMLSelectElement>("cd2f-states");
const statesHint = el<HTMLDivElement>("cd2f-states-hint");
const dsPickLabel = el<HTMLSpanElement>("cd2f-pick-ds");
const dsForgetWrap = el<HTMLSpanElement>("cd2f-ds-forget-wrap");
const dsForgetLink = el<HTMLSpanElement>("cd2f-ds-forget");
const pasteArea = el<HTMLTextAreaElement>("cd2f-paste");
const importButton = el<HTMLButtonElement>("cd2f-import");
const statusText = el<HTMLDivElement>("cd2f-status");
const summary = el<HTMLDivElement>("cd2f-summary");
const inferStacks = el<HTMLInputElement>("cd2f-infer-stacks");
const widthInput = el<HTMLInputElement>("cd2f-width");
const targetSelect = el<HTMLSelectElement>("cd2f-target");
const createMissing = el<HTMLInputElement>("cd2f-create-missing");
const tokenModeGroup = el<HTMLDivElement>("cd2f-token-mode");
const tokenModeRadios: Record<TokenMode, HTMLInputElement> = {
  map: el<HTMLInputElement>("cd2f-token-mode-map"),
  build: el<HTMLInputElement>("cd2f-token-mode-build"),
  none: el<HTMLInputElement>("cd2f-token-mode-none"),
};
const targetRow = el<HTMLDivElement>("cd2f-target-row");
const buildRow = el<HTMLDivElement>("cd2f-build-row");
const buildStatusText = el<HTMLSpanElement>("cd2f-build-status");
/**
 * Where "no variable collections in this file" goes, next to the radio it
 * disables. Queried rather than given ids of their own because they are two
 * halves of one control, and reading them here means the panel dies loudly at
 * startup if the markup drifts, exactly as `el()` above does.
 */
const modeReasons: Record<"map" | "build", HTMLSpanElement> = {
  map: tokenModeGroup.querySelector(
    '[data-cd2f-reason="map"]',
  ) as HTMLSpanElement,
  build: tokenModeGroup.querySelector(
    '[data-cd2f-reason="build"]',
  ) as HTMLSpanElement,
};
const tokenWarning = el<HTMLDivElement>("cd2f-token-warning");
const tokenWarningText = el<HTMLDivElement>("cd2f-token-warning-text");
const copyPromptButton = el<HTMLButtonElement>("cd2f-copy-prompt");
const progressWrap = el<HTMLDivElement>("cd2f-progress");
const progressBar = el<HTMLDivElement>("cd2f-progress-bar");

/**
 * Claude Design downloads files one at a time and has no project export, so a
 * user who grabs just the `.dc.html` loses the `_ds` token CSS and with it the
 * whole point of this plugin. They are already in a conversation with Claude
 * though, so the fix is a prompt they can paste there.
 */
const EXPORT_PROMPT = `Make a self-contained copy of this page for export.

Inline every stylesheet the page links from _ds/ directly into a <style> block in the document, and inline any images it references from assets/ as base64 data URIs. Keep all class names, inline styles and CSS custom property names exactly as they are — do not resolve var() references to literal values. Save it as a new .html file.`;

/**
 * For documents whose content is produced by Claude Design's runtime rather
 * than present in the markup. Stripping scripts leaves `{{ }}` placeholders and
 * unexpanded `sc-for` blocks, so the import would be structurally real but
 * visually meaningless.
 */
const STATIC_PROMPT = `Make a fully static copy of this page for export.

Resolve every {{ }} placeholder to its final literal value, expand every sc-for and sc-if into the actual repeated or included markup, and inline the resulting styles directly on the elements. The result must render identically with no scripts running at all. Save it as a new .html file.`;

/**
 * Every screen the last drop offered, in picker order.
 *
 * A Claude Design export is a project, not a file: the zip a user hands us
 * holds the board and every panel on it. Holding one `pendingHtml` meant the
 * other screens were enumerated for the picker and then thrown away, so a zip
 * of three screens imported one. `Screen.html` is filled in lazily by
 * `prepareScreen`, so accepting a forty-screen folder still reads nothing.
 */
let pendingScreens: Screen[] = [];
/** Which of them Import covers. See `selectedScreens` (src/ui/screens.ts). */
let selection: ScreenSelection = "all";
/**
 * Sibling JS modules from the last accepted drop, keyed for
 * `ExtractOptions.moduleSources` (src/ir/index.ts) — how a document's boot
 * phase (`componentDidMount` -> `import()`, see src/ui/resolve.ts) gets at
 * real data instead of importing in its loading state. `undefined` for a
 * lone-file drop or pasted markup, where there are no sibling files at all.
 *
 * Per drop rather than per screen: the set of `.js` files is the same whichever
 * document is being measured, and reading them once per screen would be N
 * copies of the same text.
 */
let pendingModuleSources: Record<string, string> | undefined;
/**
 * Token CSS discovered in the drop's own `_ds` folder, and the design system
 * manifest beside it. Session-scoped and kept separate from `designSystemCss`,
 * which is what the user chose by hand via "add token files" and must not be
 * silently replaced by whatever a dropped export happened to ship.
 */
let pendingDsTokenCss: { css: string; fileCount: number } = { css: "", fileCount: 0 };
let pendingDsManifest: string | undefined;

/**
 * Forget everything gathered from the last drop's sibling files.
 *
 * One function rather than three assignments repeated at each reset, because
 * the failure mode of missing one is silent: the next import quietly boots a
 * document against data modules from the export before it, or binds tokens
 * from a design system that is no longer on screen. (The `<dc-import>` sources
 * are not here: they hang off each `Screen`, which is replaced wholesale.)
 */
function clearPendingSources(): void {
  pendingModuleSources = undefined;
  pendingDsTokenCss = { css: "", fileCount: 0 };
  pendingDsManifest = undefined;
}
let targets: TargetSummary = { local: [], libraries: [] };
let designSystemCss = "";
/** Every file from the last drop, so any screen can be read from it on demand. */
let pendingFiles: File[] = [];
/**
 * The "N screens, M assets" line from the last zip expansion, if the last
 * drop included one. Re-applied on every subsequent status line (e.g.
 * switching screens in the picker) so it doesn't disappear the moment
 * "Unpacking…" is overwritten right after it's shown.
 */
let pendingZipNote: string | null = null;
let dsFileCount = 0;
/**
 * Extracted documents held back for confirmation.
 *
 * When a document needs Claude Design's runtime, importing it produces
 * hundreds of placeholder layers. Warning about that only after writing them
 * into the file is not a warning, it is an apology — so the import stops and
 * waits for a second, deliberate click.
 *
 * The whole batch is held when any one screen would import as placeholders,
 * never the offending screen alone: importing the clean subset is a partial
 * import nobody asked for, and the second click is the gesture that accepts
 * what the warning above it just described.
 */
let heldDocs: IRDocument[] | null = null;
/**
 * The grid width the held batch was laid out for.
 *
 * Kept beside `heldDocs` rather than recomputed on the second click: a state
 * matrix wraps at its fastest axis (7 for the Portage panel), and
 * `batchColumns` would put those fourteen frames in a row of four. Accepting a
 * warning must not change the layout the hint described.
 */
let heldColumns: number | null = null;
/**
 * The prototype wiring the held batch was measured for, kept for the same
 * reason as `heldColumns`: accepting a warning must not change what gets built.
 */
let heldFlow: FlowSpec | null = null;
/**
 * Screens the last Import click could not read at all, kept until the summary
 * can show them. A skipped screen leaves nothing on the canvas to notice, so
 * the summary is the only place it can be reported.
 */
let lastSkipped: Array<{ name: string; message: string }> = [];
/**
 * What the last Import actually asked the sandbox to do with the tokens.
 *
 * The summary is written when `import-complete` lands, by which point the
 * controls can have moved. Reporting "you created 140 variables, try Build
 * mode" against a mode the user has since switched away from would be advice
 * about something that did not happen.
 */
let lastSentTarget: VariableTarget | null = null;
/**
 * Which of the three token operations this import performs.
 *
 * Starts at "none" and is corrected by `applyTokenModeDefault` the moment
 * either half of the picture arrives, which is why the initial value is the one
 * that cannot be wrong: writing nothing.
 */
let tokenMode: TokenMode = "none";
/**
 * Set by the radios. The default tracks reality (`applyTokenModeDefault` runs
 * on every event that changes it), and without this latch a `targets` message
 * landing a second after a deliberate click would quietly overrule it.
 *
 * Released in exactly one place, `renderTokenMode`, and only when the chosen
 * mode has stopped being possible at all.
 */
let tokenModeUserSet = false;
/**
 * The enumerable props the selected screen declares, and which of them the next
 * Import will turn into one frame each.
 *
 * Empty for everything except a single-screen selection: the cap is per
 * document, and enumerating states across a batch multiplies one number nobody
 * chose by another.
 */
let pendingStateAxes: StateAxis[] = [];
let stateSelection: string[] = [];
/**
 * Which `refreshStates` call is still the current one.
 *
 * Reading a screen's schema is asynchronous and switching screens is not, so
 * two quick changes can resolve out of order and paint the older screen's props
 * over the newer screen's. The count is compared rather than the screen itself
 * because the same screen can legitimately be re-read.
 */
let stateRequest = 0;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

// Clicking the zone opens the single-file picker, which is what most people
// have. The folder picker is a separate control because `webkitdirectory` puts
// the OS dialog into folder-only mode and would otherwise make picking one
// self-contained .html impossible.
dropzone.addEventListener("click", () => fileInput.click());

el<HTMLSpanElement>("cd2f-pick-file").addEventListener("click", (event) => {
  event.stopPropagation();
  fileInput.click();
});

dsPickLabel.addEventListener("click", (event) => {
  event.stopPropagation();
  dsInput.click();
});

dsInput.addEventListener("change", async () => {
  const files = Array.from(dsInput.files ?? []).filter((file) =>
    file.name.toLowerCase().endsWith(".css"),
  );
  if (files.length === 0) return;

  let parts: string[];
  try {
    parts = await Promise.all(files.map((file) => file.text()));
  } catch (error) {
    setStatus("error", messageOf(error, "Those CSS files could not be read."));
    return;
  }
  designSystemCss = parts.join("\n");
  dsFileCount = files.length;

  // Optimistic: "saved" only flips to true/false once the sandbox acks
  // save-design-system below (design-system-saved), since clientStorage's
  // size guard lives there.
  renderDesignSystemStatus({ fileCount: dsFileCount, persisted: undefined });
  parent.postMessage(
    { pluginMessage: { type: "save-design-system", css: designSystemCss, fileCount: dsFileCount } },
    "*",
  );
  // Call site 3 of 7. Adding token files by hand is how a file with no
  // collections gets something to build from.
  applyTokenModeDefault();
});

dsForgetLink.addEventListener("click", (event) => {
  event.stopPropagation();
  designSystemCss = "";
  dsFileCount = 0;
  renderDesignSystemStatus(null);
  parent.postMessage({ pluginMessage: { type: "clear-design-system" } }, "*");
  // Call site 4 of 7. Forgetting the saved CSS can take Build's only reason to
  // be the default with it.
  applyTokenModeDefault();
});

/**
 * Renders the "Design system CSS: …" status line and toggles the
 * add/replace/forget controls to match. `persisted` is `undefined` while a
 * save is in flight, `true`/`false` once the sandbox has acked it (see the
 * "design-system-saved" case in window.onmessage below) — `false` means
 * clientStorage declined it (over the size guard, or a genuine storage
 * error), so the CSS still applies but only for this session.
 */
function renderDesignSystemStatus(
  state: { fileCount: number; persisted?: boolean } | null,
): void {
  if (!state || state.fileCount === 0) {
    dsStatus.textContent = "none";
    dsPickLabel.textContent = "add token files";
    dsForgetWrap.style.display = "none";
    return;
  }

  const label = `${state.fileCount} file${state.fileCount === 1 ? "" : "s"}`;
  dsStatus.textContent =
    state.persisted === false
      ? `${label} loaded (too large to save — this session only)`
      : state.persisted === undefined
        ? `${label} loaded…`
        : `${label} saved`;
  dsPickLabel.textContent = "replace";
  dsForgetWrap.style.display = "";
}

el<HTMLSpanElement>("cd2f-pick-folder").addEventListener("click", (event) => {
  event.stopPropagation();
  folderInput.click();
});

folderInput.addEventListener("change", async () => {
  await acceptFileSet(Array.from(folderInput.files ?? []));
});

/**
 * A Claude Design project folder contains every screen in the project, and all
 * of them are the answer: importing one and discarding the rest is what this
 * panel used to do, and it is the bug a user reported as "my zip has 3 screens
 * and 1 came across".
 *
 * Reads no document. Only the design system's own files are opened here, which
 * is what lets a forty-screen folder land instantly and be described honestly
 * before a single screen is measured (`prepareScreen` does that, per screen,
 * inside the import loop).
 */
async function acceptFileSet(files: File[]): Promise<void> {
  const zipFiles = files.filter((file) => file.name.toLowerCase().endsWith(".zip"));

  if (zipFiles.length > 0) {
    const expanded = await expandZipFiles(zipFiles);
    if (!expanded) return; // Failure already reported by expandZipFiles.

    const others = files.filter((file) => !file.name.toLowerCase().endsWith(".zip"));
    files = [...expanded.files, ...others];
    pendingZipNote = expanded.note;
  } else {
    pendingZipNote = null;
  }

  const screens = buildScreens(files);
  if (screens.length === 0) {
    setStatus("error", "No .html file found there.");
    return;
  }

  pendingFiles = files;
  pendingScreens = screens;
  selection = defaultSelection(screens.length);

  const assets = files.filter((file) => !screens.some((screen) => screen.file === file));
  pendingModuleSources = await collectModuleSources(assets);
  pendingDsTokenCss = await collectDsTokenCss(files);
  pendingDsManifest = await collectDesignSystemManifest(files);

  renderScreenPicker();
  previewSelection();
  // States call site 1 of 3, one per place the selection can change.
  void refreshStates();
  hideTokenWarning();
  clearHold();
  updateButton();
  // Call site 2 of 7. This is the moment "does this export ship a design
  // system?" stops being unknown.
  applyTokenModeDefault();
}

/**
 * The picker, plus the hint that says what choosing "All screens" will do.
 *
 * The "all" option is first and is a string sentinel rather than an index, so
 * the change handler has to branch before `parseInt`, or the sentinel becomes an
 * index of `NaN` that silently selects nothing.
 */
function renderScreenPicker(): void {
  if (pendingScreens.length < 2) {
    pageRow.style.display = "none";
    return;
  }

  const options = [
    `<option value="all">All screens (${pendingScreens.length})</option>`,
    ...pendingScreens.map(
      (screen, index) =>
        `<option value="${index}">${escapeHtml(screen.label)}</option>`,
    ),
  ];
  pageSelect.innerHTML = options.join("");
  pageSelect.value = selection === "all" ? "all" : String(selection);
  pageHint.textContent = screenHint(pendingScreens.length);
  pageRow.style.display = "block";
}

/**
 * What is about to be imported, said before the click rather than after it.
 *
 * Switching screens reads nothing now, so this is a status line and nothing
 * else. It carries the batch cap out loud: truncating forty screens to twelve
 * is only defensible if the user is told which twelve before choosing.
 */
function previewSelection(): void {
  const chosen = selectedScreens(pendingScreens, selection);
  const companions = pendingFiles.length - pendingScreens.length;

  let line: string;
  if (selection === "all" && pendingScreens.length > 1) {
    line =
      pendingScreens.length > BATCH_LIMIT
        ? `${pendingScreens.length} screens selected. The first ${BATCH_LIMIT} import in one go; the rest need a second pass.`
        : `${chosen.length} screens ready. Each becomes its own top-level frame.`;
  } else {
    const one = chosen[0];
    // The file name rather than the label: this line is about what was
    // dropped, and the label is what the frame will be called.
    const name = one?.file?.name ?? one?.label;
    line = one
      ? companions > 0
        ? `${name} + ${companions} companion file${companions === 1 ? "" : "s"}.`
        : `${name} ready.`
      : "Nothing selected.";
  }

  setStatus(
    "idle",
    [pendingZipNote, line, describeDiscoveredDesignSystem()].filter(Boolean).join(" "),
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * Offer the selected screen's declared props as importable states.
 *
 * Called from every place `pendingScreens` or `selection` changes and nowhere
 * else: the drop, the picker, and the paste box. Miss one and the control keeps
 * offering the props of a document that is no longer selected, which is the
 * worst version of this feature: a matrix built from the wrong schema still
 * imports, with plausible names.
 *
 * Reads the document's raw text and parses it, which is cheap and deliberate:
 * `data-props` is an attribute on the `<script data-dc-script>` tag, so none of
 * the asset inlining `prepareScreen` does is needed to answer the question. A
 * forty-screen folder still reads exactly one file, and only the one the user
 * is looking at.
 */
async function refreshStates(): Promise<void> {
  const token = ++stateRequest;
  const chosen = selectedScreens(pendingScreens, selection);
  // Single screen only. A batch of twelve screens with three states each is a
  // number nobody asked for, and the cap is a per-document promise.
  const only = chosen.length === 1 ? chosen[0] : undefined;

  let axes: StateAxis[] = [];
  try {
    const markup = only ? (only.html ?? (only.file ? await screenText(only.file) : "")) : "";
    if (markup) axes = adopt(extractor().documentStateAxes(markup));
  } catch {
    // An unreadable file is the import loop's problem to report, with a name
    // and a place to put it. Here it is simply a screen with no states.
    axes = [];
  }
  if (token !== stateRequest) return;

  pendingStateAxes = axes;
  stateSelection = defaultStateSelection(axes);
  renderStates();
  // A document declaring a 30-option enum is refused by the default selection
  // alone, before anything is ticked, so the button has to be re-checked here
  // and not only in the change handler.
  updateButton();
}

/**
 * One document's raw markup, read once per drop.
 *
 * Separate from `inlinedDocuments` below on purpose: that one resolves every
 * asset the document links into base64, which is the expensive half and is not
 * needed to read a schema.
 */
const screenTexts = new WeakMap<File, Promise<string>>();

function screenText(file: File): Promise<string> {
  let pending = screenTexts.get(file);
  if (!pending) {
    pending = file.text();
    screenTexts.set(file, pending);
  }
  return pending;
}

/** What the next Import will enumerate, and what it costs. */
function statePlan(): { selected: StateAxis[]; plan: CombinationPlan } {
  const selected = selectAxes(pendingStateAxes, stateSelection);
  return { selected, plan: propCombinations(selected) };
}

function renderStates(): void {
  if (pendingStateAxes.length === 0) {
    statesRow.style.display = "none";
    statesSelect.innerHTML = "";
    return;
  }

  statesSelect.innerHTML = pendingStateAxes
    .map(
      (axis) =>
        `<option value="${escapeHtml(axis.name)}"${
          stateSelection.includes(axis.name) ? " selected" : ""
        }>${escapeHtml(axis.name)} (${axis.values.length})</option>`,
    )
    .join("");
  // Show every prop without a scrollbar up to a point, so a two-prop document
  // does not hide its second prop behind one.
  statesSelect.size = Math.min(Math.max(pendingStateAxes.length, 2), 5);

  const { selected, plan } = statePlan();
  statesHint.textContent = stateHint(selected, plan);
  statesRow.style.display = "block";
}

statesSelect.addEventListener("change", () => {
  // Selected-option order is DOM order, which is the order the document
  // declares its props in. That is the axis order: prop 0 varies fastest, so
  // one row of the imported grid is one full sweep of it.
  stateSelection = Array.from(statesSelect.selectedOptions).map((option) => option.value);
  renderStates();
  clearHold();
  updateButton();
});

/**
 * Claude Design exports a whole project as a single .zip rather than one file
 * at a time, so the very first thing a dropped .zip needs is unpacking into
 * the same File[] shape a folder pick or drag-and-drop already produces —
 * everything downstream (screen picker, bundle detection, inlineAssets) reads
 * `file.name`/`webkitRelativePath` and has no idea a zip was ever involved.
 *
 * It gets its own status message because it is now the only part of accepting
 * a drop that takes any time at all: no document is read until Import asks for
 * one, so a multi-MB export unpacking is the whole of the wait.
 */
async function expandZipFiles(
  zipFiles: File[],
): Promise<{ files: File[]; note: string } | null> {
  const label = zipFiles.length === 1 ? zipFiles[0].name : `${zipFiles.length} zip files`;
  setStatus("working", `Unpacking ${label}…`);

  const expanded: File[] = [];
  try {
    for (const zip of zipFiles) {
      expanded.push(...(await readZip(zip)));
    }
  } catch (error) {
    pageRow.style.display = "none";
    pendingScreens = [];
    clearPendingSources();
    setStatus("error", messageOf(error, "This .zip could not be unpacked."));
    updateButton();
    // Call site 7 of 7, and the one that was missing. This path empties
    // `pendingScreens` AND throws away the last drop's `_ds` tokens, which is
    // both halves of what the mode control reads, so skipping it left a zip
    // that failed to unpack showing "Build a design system from this export"
    // enabled and still selected, under a line naming the six token files of
    // an export that is no longer loaded and whose CSS `clearPendingSources`
    // has already discarded, "save this as my design system" included: a link
    // that then silently does nothing.
    applyTokenModeDefault();
    return null;
  }

  const screens = htmlCandidates(expanded).length;
  const assetCount = expanded.length - screens;
  const note = `${label} — ${screens} screen${screens === 1 ? "" : "s"}, ${assetCount} asset${assetCount === 1 ? "" : "s"}.`;

  return { files: expanded, note };
}

pageSelect.addEventListener("change", () => {
  // "all" before parseInt, or the sentinel becomes NaN and indexes nothing.
  selection = pageSelect.value === "all" ? "all" : parseInt(pageSelect.value, 10);
  // Changing screens no longer re-reads or re-inlines anything: whatever was
  // prepared for a previous click is memoised on its own Screen and the rest
  // is read when Import asks for it.
  previewSelection();
  // States call site 2 of 3. A different screen declares different props, so
  // the ticked set cannot survive the change.
  void refreshStates();
  hideTokenWarning();
  clearHold();
  updateButton();
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("cd2f-dropzone--active");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("cd2f-dropzone--active");
});

dropzone.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropzone.classList.remove("cd2f-dropzone--active");

  await acceptFiles(Array.from(event.dataTransfer?.files ?? []));
});

fileInput.addEventListener("change", async () => {
  await acceptFiles(Array.from(fileInput.files ?? []));
});

/** The drop and the picker, with nowhere for a failure to go unreported. */
async function acceptFiles(files: File[]): Promise<void> {
  try {
    await acceptFileSet(files);
  } catch (error) {
    setStatus("error", describeError(error));
    updateButton();
  }
}

pasteArea.addEventListener("input", () => {
  const value = pasteArea.value.trim();
  // Paste beats a dropped file set, and emptying the box goes back to nothing
  // loaded rather than quietly reviving the drop before it.
  pendingScreens = value ? [{ label: "Pasted markup", html: value }] : [];
  selection = "all";
  pendingFiles = [];
  pendingZipNote = null;
  // Pasted markup has no sibling files, so anything kept around from a
  // previous drop no longer applies to what's about to be imported.
  clearPendingSources();
  pageRow.style.display = "none";
  setStatus("idle", value ? "Ready to import pasted markup." : "");
  // States call site 3 of 3. Pasted markup carries a `data-props` schema as
  // readily as a dropped file does, and emptying the box has to take the
  // previous document's props away with it.
  void refreshStates();
  hideTokenWarning();
  clearHold();
  updateButton();
  // Call site 6 of 7, and one the plan did not list. Pasting throws away the
  // last drop's `_ds` tokens (clearPendingSources above), so leaving the mode
  // on Build here would offer to build a design system out of an export that
  // is no longer loaded.
  applyTokenModeDefault();
});

/**
 * Claude Design's own runtime files — never executed even though they sit
 * right next to the document (the resolver in src/ui/resolve.ts runs the
 * document's OWN `<script data-dc-script>` against stubs; these are a
 * separate concern, the framework code that mounts everything for real, and
 * running it here would be running someone else's app inside the plugin).
 * `_ds/` covers the whole design-system bundle folder (e.g. `_ds_bundle.js`),
 * not just a literal top-level file by that name.
 */
const RUNTIME_JS_FILENAMES = new Set(["support.js", "image-slot.js", "deck-stage.js", "doc-page.js"]);

function isClaudeDesignRuntimeFile(file: File): boolean {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
  if (relative.split("/").some((segment) => segment === "_ds")) return true;
  return RUNTIME_JS_FILENAMES.has(file.name.toLowerCase());
}

/**
 * Reads every sibling `.js` file from the last drop — excluding Claude
 * Design's own runtime (see `isClaudeDesignRuntimeFile`) — into the
 * `moduleSources` map a document's boot phase needs (`ExtractOptions.moduleSources`,
 * src/ir/index.ts; consumed by `resolveDynamicDocument`/`loadModule` in
 * src/ui/resolve.ts). Both the bare filename and the `./` spelling are
 * indexed for the same source text, since a script's own `import('./x.js')`
 * and a lookup keyed just `"x.js"` need to agree — see that file's
 * `lookupModuleSource` for the forgiving-lookup side of this same contract.
 * Returns `undefined` (not `{}`) when there are no user data modules at all,
 * so `ExtractOptions.moduleSources` stays genuinely absent rather than an
 * empty object that looks like "we checked and there's nothing".
 */
export async function collectModuleSources(assets: File[]): Promise<Record<string, string> | undefined> {
  // .jsx/.tsx too: an animation project's component lives in them. And the
  // design system's own bundle, which its components are built from.
  const jsFiles = assets.filter((file) => {
    const lower = file.name.toLowerCase();
    if (/\.(jsx|tsx)$/.test(lower)) return true;
    if (!lower.endsWith(".js")) return false;
    return !isClaudeDesignRuntimeFile(file) || lower === "_ds_bundle.js";
  });
  if (jsFiles.length === 0) return undefined;

  const sources: Record<string, string> = {};
  for (const file of jsFiles) {
    const text = await file.text();
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const name = relative ? relative.split("/").pop() || file.name : file.name;

    sources[name] = text;
    sources[`./${name}`] = text;
    if (relative) {
      sources[relative] = text;
      const withoutRoot = relative.split("/").slice(1).join("/");
      if (withoutRoot) sources[withoutRoot] = text;
    }
  }
  return sources;
}

/**
 * Every OTHER Claude Design document in the drop, keyed every way a
 * `<dc-import name="…">` might spell it.
 *
 * A canvas board embeds its screens by name (`<dc-import name="Portage Panel">`
 * resolves to `Portage Panel.dc.html` in the same directory, per Claude
 * Design's own support.js), so importing the board without its siblings gives
 * a page of empty boxes. The resolver cannot fetch them - a plugin iframe has
 * an opaque origin and no filesystem - so they have to be carried in as text.
 *
 * Keyed as forgivingly as `collectModuleSources` above and for the same
 * reason: drag-and-drop, the folder picker and zip expansion disagree about
 * whether a relative path survives, and the author writes whichever spelling
 * reads well.
 */
async function collectDocumentSources(
  htmlFile: File,
  all: File[],
): Promise<Record<string, string> | undefined> {
  const siblings = all.filter(
    (file) => file !== htmlFile && file.name.toLowerCase().endsWith(".html"),
  );
  if (siblings.length === 0) return undefined;

  const sources: Record<string, string> = {};
  for (const file of siblings) {
    const html = await inlinedDocument(file, all);

    // "Portage Panel.dc.html" -> "Portage Panel", which is the name attribute
    // an author actually writes.
    const name = file.name.replace(/\.(dc\.)?html$/i, "");
    const relative = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath;

    for (const key of [
      name,
      name.toLowerCase(),
      file.name,
      `./${file.name}`,
      // support.js builds the URL as encodeURIComponent(name) + ".dc.html",
      // so a name with a space arrives percent-encoded.
      `${encodeURIComponent(name)}.dc.html`,
      relative,
      relative ? relative.split("/").slice(1).join("/") : undefined,
    ]) {
      if (key) sources[key] = html;
    }
  }
  return sources;
}

/**
 * The design system's own token CSS, from the export's `_ds` folder.
 *
 * A document links only the token files it needs, and a canvas board usually
 * links just `tokens/fonts.css` - so a project that ships a complete design
 * system still extracts zero colour tokens, and the panel says "no
 * design-system tokens were found" while they sit unread in the same drop.
 *
 * `tokens/*.css` ONLY, deliberately:
 *
 * `styles.css` is nothing but `@import` lines, and `collectFromRules`
 * (src/ui/tokens.ts) does not follow a `CSSImportRule`, so it contributes
 * exactly zero tokens.
 *
 * `surfaces/*.css` re-theme the same token names under a scoped class
 * (`.acme-deck`). `collectFromRules` skips non-`:root` selectors, so they
 * also contribute zero tokens - but unlike styles.css they DO change
 * measurement for any element carrying a surface class, which would silently
 * move the layout. Surface values reach the builder from the manifest instead.
 *
 * That last argument applies to `tokens/*.css` as well, which is what
 * `customPropertyDeclarations` below is for: excluding the surface files
 * assumed a file under `tokens/` declares nothing but tokens, and that is
 * false. `tokens/typography.css` in the real export carries a full type scale,
 * `body { line-height: 1.5 }` included, and injecting it measured the Portage
 * board at 3000x1608 against a ground truth of 3000x1589, with all fourteen
 * embedded panels sitting 11px low.
 */
export async function collectDsTokenCss(
  files: File[],
): Promise<{ css: string; fileCount: number }> {
  const tokenFiles = files.filter((file) => {
    const path = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath;
    if (!path) return false;
    const segments = path.split("/");
    return (
      segments.includes("_ds") &&
      segments[segments.length - 2] === "tokens" &&
      file.name.toLowerCase().endsWith(".css")
    );
  });
  if (tokenFiles.length === 0) return { css: "", fileCount: 0 };

  const parts = await Promise.all(tokenFiles.map((file) => file.text()));
  const css = customPropertyDeclarations(parts.join("\n"));
  // A token folder that declares no custom property at all has given us no
  // design system, whatever it holds, and the count is only ever used to say
  // one was found ("Design system X found (6 token files)").
  return css ? { css, fileCount: tokenFiles.length } : { css: "", fileCount: 0 };
}

/**
 * A stylesheet reduced to its custom-property declarations.
 *
 * This CSS is injected into the page the document is measured in
 * (`ExtractOptions.extraCss` -> `mountDocument`, src/ui/extract.ts), where its
 * only job is to define the `--x: value` layer the document was authored
 * against so `var()` resolves to real colours instead of falling back. Every
 * ordinary rule it also carries is a rule the document's author never asked
 * for on this render, and it changes the measurement: one `body` rule in
 * `tokens/typography.css` was worth 19px of board height.
 *
 * Selectors and at-rule nesting are kept exactly as written, never flattened
 * into `:root`. A design system routinely re-declares the same token under a
 * theme class, and `detectThemeAxis` (src/ui/tokens.ts) reads those blocks to
 * work out the document's light/dark axis; collapsing them would hand it one
 * value where there are two.
 *
 * Parsed by the browser rather than by hand, in a document with no browsing
 * context: `createHTMLDocument` gives a real CSSOM without the <style> ever
 * applying to this page or fetching anything, which matters because
 * `tokens/fonts.css` opens with an `@import` of a font service and this plugin
 * declares no network access.
 */
function customPropertyDeclarations(css: string): string {
  if (!css.trim()) return "";

  const scratch = document.implementation.createHTMLDocument("cd2f-token-parse");
  const style = scratch.createElement("style");
  style.textContent = css;
  scratch.head.appendChild(style);

  const sheet = style.sheet;
  // Nothing parsed at all. Dropping the lot costs colour binding, which the
  // summary reports out loud ("No design tokens bound"); passing it through
  // unfiltered would move the layout silently, and silent is the failure mode
  // this whole function exists to end.
  if (!sheet) return "";

  const emit = (rules: CSSRuleList): string => {
    const parts: string[] = [];

    for (const rule of Array.from(rules)) {
      const styleRule = rule as CSSStyleRule;
      // Since Chrome 112 an ordinary style rule also exposes `cssRules` (CSS
      // nesting), so this is a property of the rule rather than a rule type.
      const nested = (rule as unknown as CSSGroupingRule).cssRules;

      if (typeof styleRule.selectorText === "string" && styleRule.style) {
        const declarations: string[] = [];
        for (let i = 0; i < styleRule.style.length; i++) {
          const name = styleRule.style.item(i);
          if (!name.startsWith("--")) continue;
          const priority = styleRule.style.getPropertyPriority(name);
          declarations.push(
            `${name}:${styleRule.style.getPropertyValue(name)}${priority ? ` !${priority}` : ""}`,
          );
        }
        // Nested rules stay nested, inside their parent's braces, because that
        // is the only spelling in which a `&` selector still means anything.
        const inner = nested && nested.length > 0 ? emit(nested) : "";
        if (declarations.length > 0 || inner) {
          parts.push(`${styleRule.selectorText}{${declarations.join(";")}${inner}}`);
        }
        continue;
      }

      // @media / @supports / @layer: keep the condition, keep whatever custom
      // properties survive inside it, drop the block entirely if none do.
      // Everything else falls through and is dropped, which is the point:
      // @font-face, @keyframes and @import have no custom properties to
      // contribute and every one of them changes what gets rendered.
      if (nested && nested.length > 0) {
        const inner = emit(nested);
        if (inner) {
          const prelude = rule.cssText.slice(0, rule.cssText.indexOf("{")).trim();
          parts.push(`${prelude}{${inner}}`);
        }
      }
    }

    return parts.join("");
  };

  return emit(sheet.cssRules);
}

/**
 * The export's `_ds_manifest.json`, which is the only place a token's
 * surface-specific values are written down (the surface CSS itself is
 * deliberately not loaded, see `collectDsTokenCss`).
 *
 * Reaches us untouched: `isClaudeDesignRuntimeFile` gates `collectModuleSources`
 * alone, and `inlineAssets` only rewrites what the document links.
 */
async function collectDesignSystemManifest(
  files: File[],
): Promise<string | undefined> {
  const manifest = files.find((file) =>
    ((file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "")
      .toLowerCase()
      .endsWith("_ds_manifest.json"),
  );
  return manifest ? manifest.text() : undefined;
}

/**
 * The design system's own name, best spelling first.
 *
 * The manifest's own `name` if it declares one, then the `_ds` folder with its
 * UUID trimmed off (`dsSystemName`, src/ui/token-mode.ts), and only then
 * `namespace`. Order matters because this name goes on a Figma collection in
 * Build mode: the real export declares no `name` at all and a `namespace` of
 * "AcmeDesignSystem_3f2a9c", which is a stable key rather than something a
 * designer wants to read in the variables panel. The folder says "Acme
 * Design System".
 */
function discoveredDesignSystemName(): string | undefined {
  return designSystemName(pendingFiles, pendingDsManifest);
}

export function designSystemName(
  files: File[],
  manifestJson: string | undefined,
): string | undefined {
  const declared = manifestField("name", manifestJson);
  if (declared) return declared;
  return dsSystemName(files) ?? manifestField("namespace", manifestJson);
}

/**
 * Give every document in a batch the design system's own name.
 *
 * `extractDocument` (src/ui/extract.ts) names the system `inferSystemName(html)
 * ?? name`, and `inferSystemName` reads the `_ds/<system>-<uuid>/` folder out of
 * a stylesheet href. By the time it runs there are no hrefs left: `inlineAssets`
 * below has rewritten every one of them into a `data:` URI, so the path is gone
 * and the fallback wins. The fallback is the SCREEN's name, so the real Portage
 * export produced three systems called "Portage", "Portage Panel" and "Portage
 * Panel v1", and Map mode made a variable collection for each, holding the same
 * 125 variables three times over.
 *
 * The export-level name is knowable here and nowhere else: `pendingFiles` still
 * carries the untouched `_ds` paths, and `_ds_manifest.json` was read whole.
 * Applying it here is also what stops Build mode and Map mode disagreeing, since
 * Build already took its collection name from `discoveredDesignSystemName`.
 *
 * An export that yields no name at all is left alone: the screen's name is a
 * poor label but it is better than an empty one.
 */
export function nameDesignSystems(
  docs: IRDocument[],
  files: File[],
  manifestJson: string | undefined,
): void {
  const name = designSystemName(files, manifestJson);
  if (!name) return;
  for (const doc of docs) {
    if (doc.designSystem) doc.designSystem.name = name;
  }
}

function manifestField(
  field: "name" | "namespace",
  manifestJson: string | undefined,
): string | undefined {
  if (!manifestJson) return undefined;
  try {
    const parsed = JSON.parse(manifestJson) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    // A manifest we cannot parse is not worth failing a drop over. The token
    // CSS beside it is read separately and does not depend on this.
    return undefined;
  }
}

/**
 * "Design system acme-design-system found (6 token files)."
 *
 * Said out loud at drop time because the alternative is what a user actually
 * hit: an export carrying a complete design system, and a panel reporting that
 * no design-system tokens were found, because the document itself linked only
 * `tokens/fonts.css` and nothing looked in the folder beside it.
 */
function describeDiscoveredDesignSystem(): string {
  if (!pendingDsTokenCss.css) return "";
  const count = pendingDsTokenCss.fileCount;
  const name = discoveredDesignSystemName();
  const files = `${count} token file${count === 1 ? "" : "s"}`;
  return name
    ? `Design system “${name}” found (${files}).`
    : `Design system found (${files}).`;
}

/**
 * Read one screen and everything it needs to be measured.
 *
 * Was `acceptFiles`, and the difference is where it runs: at drop time it had
 * to pick one document out of the export, which is how the other screens got
 * lost. Now the import loop calls it per screen, and the result is memoised
 * onto the `Screen` so a second click costs nothing.
 *
 * A document it cannot use sets `skipReason` and returns. Nothing here aborts:
 * one bundled export in a zip of fourteen must not take the other thirteen
 * with it.
 */
async function prepareScreen(screen: Screen): Promise<Screen> {
  if (screen.html !== undefined || screen.skipReason) return screen;
  if (!screen.file) {
    screen.skipReason = "No markup to read.";
    return screen;
  }

  const html = await inlinedDocument(screen.file, pendingFiles);

  // Claude Design can also export a single self-contained "Bundled Page": a
  // 2MB JavaScript payload that unpacks the real document at runtime. There is
  // no markup in it to read, so importing produces one layer reading "This
  // page requires JavaScript to display." Catch it and say what to do instead.
  if (/__bundler_thumbnail|<title>Bundled Page<\/title>/.test(html)) {
    screen.skipReason =
      "That is Claude Design's bundled single-page export, which unpacks itself with JavaScript and has no markup to read. Export the whole project instead and use \u201cchoose a folder\u201d.";
    return screen;
  }

  screen.html = html;
  screen.documentSources = await collectDocumentSources(screen.file, pendingFiles);
  return screen;
}

/**
 * One document's markup gets read and inlined once per drop, however many
 * times it is asked for.
 *
 * Every screen in a project collects every OTHER screen as a possible
 * `<dc-import>` target, so a three-screen export asks for the same inlined
 * markup six times over and a twelve-screen one asks 132 times. That work is
 * not free: `inlineAssets` walks the whole document and hands out base64 of
 * everything it links.
 *
 * Keyed on the `File` object, like `assetDataUris` below and for the same
 * reason: two files in different folders of one export legitimately share a
 * name, and a new drop produces new `File`s, so there is nothing to reset.
 */
const inlinedDocuments = new WeakMap<File, Promise<string>>();

export function inlinedDocument(file: File, all: File[]): Promise<string> {
  let pending = inlinedDocuments.get(file);
  if (!pending) {
    pending = file.text().then((html) => {
      const assets = all.filter((other) => other !== file);
      return assets.length > 0 ? inlineAssets(html, assets) : html;
    });
    inlinedDocuments.set(file, pending);
  }
  return pending;
}

/**
 * Replace relative `href`/`src` references with data URIs, and the `url()`
 * references inside every stylesheet that goes with them.
 *
 * A plugin iframe has an opaque origin and no filesystem, so anything the
 * document references has to travel inline or it will not resolve at all.
 *
 * Rewriting the attributes alone was not enough, and the gap was invisible
 * because nothing fails out loud: the real export reaches its typefaces through
 * `@font-face { src: url("../fonts/Inter-Regular.otf") }` inside
 * `tokens/fonts.css`, and once that file became a data URI the relative path
 * inside it had nothing left to resolve against. Every face went to `error`,
 * `document.fonts.check("16px Inter")` answered false, and the whole document
 * was measured in Times: canvas measurement of a sample line came out
 * byte-identical to a family that does not exist, 7.6% narrower than the real
 * render. Every text box in the IR was wrong by that much.
 */
async function inlineAssets(html: string, assets: File[]): Promise<string> {
  const byName = new Map<string, File>();
  for (const file of assets) {
    // Drag-and-drop and the folder picker disagree about whether a relative
    // path survives, so index both spellings.
    byName.set(file.name, file);
    const relative = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath;
    if (relative) {
      byName.set(relative, file);
      byName.set(relative.split("/").slice(1).join("/"), file);
    }
  }

  /**
   * `baseDir` is what a relative reference is relative TO, and getting it wrong
   * inlines the wrong file or none: a `url(../fonts/Inter.otf)` written in
   * `_ds/<system>/tokens/fonts.css` means `_ds/<system>/fonts/Inter.otf`, not
   * `../fonts/Inter.otf` from the document. The document's own attributes pass
   * "" and resolve exactly as they always have.
   */
  const findAsset = (ref: string, baseDir: string): File | undefined => {
    const clean = ref.trim().replace(/^\.\//, "").split(/[?#]/)[0];
    if (!clean) return undefined;

    const candidates = clean.startsWith("/")
      ? [clean.slice(1)]
      : baseDir
        ? [joinPath(baseDir, clean), clean]
        : [clean];

    for (const candidate of candidates) {
      // Both spellings again: an export's paths may or may not carry the
      // wrapping folder the picker put in front of them.
      const withoutRoot = candidate.split("/").slice(1).join("/");
      const hit = byName.get(candidate) ?? (withoutRoot ? byName.get(withoutRoot) : undefined);
      if (hit) return hit;
    }
    // Last resort, and the one that carries a flat drag-and-drop drop where no
    // path survived at all.
    return byName.get(clean.split("/").pop() ?? "");
  };

  const refs = new Set<string>();
  const pattern = /(?:href|src)\s*=\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (!/^(https?:|data:|#)/.test(match[1])) refs.add(match[1]);
  }

  let output = html;
  for (const ref of refs) {
    const file = findAsset(ref, "");
    if (!file) continue;
    const dataUri = isStylesheet(file)
      ? // A stylesheet's own directory, from the path the picker gave us if it
        // gave us one, and otherwise from the reference the document used to
        // reach it.
        await inlinedStylesheet(
          file,
          directoryOf(
            (file as File & { webkitRelativePath?: string }).webkitRelativePath || ref,
          ),
          findAsset,
        )
      : await assetDataUri(file);
    output = output.split(`"${ref}"`).join(`"${dataUri}"`);
    output = output.split(`'${ref}'`).join(`'${dataUri}'`);
  }
  return output;
}

function isStylesheet(file: File): boolean {
  return file.name.toLowerCase().endsWith(".css");
}

/** `a/b/c.css` -> `a/b`. */
function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** `a/b` + `../c/d.otf` -> `a/c/d.otf`, with `.` and `..` resolved. */
function joinPath(baseDir: string, relative: string): string {
  const segments = baseDir ? baseDir.split("/") : [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

/**
 * One stylesheet, as a data URI, with its own `url()` references resolved
 * against ITS location and inlined in turn.
 *
 * Memoised per `File` like the assets below: a project's screens all link the
 * same design system, so this would otherwise re-encode the fonts once per
 * screen. `findAsset` comes from the first caller, which is safe because the
 * only thing that varies between callers is which document is excluded from
 * the asset list, and a stylesheet never has a `.dc.html` as a `url()` target.
 */
const inlinedStylesheets = new WeakMap<File, Promise<string>>();

function inlinedStylesheet(
  file: File,
  baseDir: string,
  findAsset: (ref: string, baseDir: string) => File | undefined,
): Promise<string> {
  let pending = inlinedStylesheets.get(file);
  if (!pending) {
    pending = file
      .text()
      .then((css) => rewriteCssUrls(css, baseDir, findAsset))
      .then((css) => {
        const bytes = new TextEncoder().encode(css);
        return `data:text/css;base64,${base64(bytes.buffer as ArrayBuffer)}`;
      });
    inlinedStylesheets.set(file, pending);
  }
  return pending;
}

/**
 * Every `url()` in a stylesheet, pointed at a data URI.
 *
 * Every face of every family the sheet declares is inlined, not just the ones
 * this document looks like it uses. The real export ships 2.6 MB of fonts
 * across three families, so the temptation to filter is real, but the only way
 * to know which faces a document uses is to render it, and this runs before it
 * is mounted: a family can arrive through a custom property in a file we never
 * see, and dropping a face that turns out to be used is exactly the silent
 * mis-measurement being fixed here. `assetDataUri`'s memo means each font is
 * still base64'd once per drop however many sheets and screens reference it.
 *
 * `@import`ed stylesheets are not followed. The export's own `styles.css` is
 * nothing but imports and is never linked directly by a document, and
 * `tokens/fonts.css` imports a font service that a plugin with no network
 * access could not fetch anyway.
 */
async function rewriteCssUrls(
  css: string,
  baseDir: string,
  findAsset: (ref: string, baseDir: string) => File | undefined,
): Promise<string> {
  // Quoted or bare, with the whitespace CSS allows inside the parentheses.
  const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/g;
  const refOf = (double?: string, single?: string, bare?: string): string =>
    double ?? single ?? bare ?? "";

  const wanted = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(css)) !== null) {
    const ref = refOf(match[1], match[2], match[3]);
    if (ref && !/^(https?:|data:|about:|#)/i.test(ref)) wanted.add(ref);
  }
  if (wanted.size === 0) return css;

  const resolved = new Map<string, string>();
  for (const ref of wanted) {
    const file = findAsset(ref, baseDir);
    if (file) resolved.set(ref, await assetDataUri(file));
  }
  if (resolved.size === 0) return css;

  urlPattern.lastIndex = 0;
  return css.replace(urlPattern, (whole, double, single, bare) => {
    const uri = resolved.get(refOf(double, single, bare));
    // Always double-quoted. A data URI carries `;`, `+`, `/` and `=`, none of
    // which are legal in an unquoted url() token, and base64 cannot contain a
    // double quote, so nothing needs escaping inside one.
    return uri ? `url("${uri}")` : whole;
  });
}

/**
 * One document's assets get inlined once, however many documents reference
 * them.
 *
 * A project's screens all link the same design system, so collecting sibling
 * documents means calling `inlineAssets` once per screen over the same
 * `File[]`. Without this the fonts and `support.js` would be read and base64'd
 * once per screen, and base64 of a 2 MB font is ~2.7 MB of string built and
 * thrown away each time.
 *
 * Keyed on the `File` object rather than its name because two files in
 * different folders of one export legitimately share a name.
 */
const assetDataUris = new WeakMap<File, Promise<string>>();

/**
 * By extension first, `file.type` second.
 *
 * A `File` from the folder picker carries whatever type the OS guessed, which
 * for a `.otf` is routinely nothing at all, and `application/octet-stream` in a
 * data URI is not a font: the face never loads and the document gets measured
 * in a fallback family. The zip reader already does this (`mimeTypeFor`,
 * src/ui/zip.ts), so this is the same answer for the picker and drag-and-drop.
 */
const ASSET_MIME_TYPES: Record<string, string> = {
  css: "text/css",
  js: "text/javascript",
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function assetDataUri(file: File): Promise<string> {
  let pending = assetDataUris.get(file);
  if (!pending) {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mime =
      ASSET_MIME_TYPES[extension] ?? (file.type || "application/octet-stream");
    pending = file
      .arrayBuffer()
      .then((buffer) => `data:${mime};base64,${base64(buffer)}`);
    assetDataUris.set(file, pending);
  }
  return pending;
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

importButton.addEventListener("click", async () => {
  // A second click on a held batch is the user accepting the warning.
  if (heldDocs) {
    sendImport(heldDocs, heldColumns ?? batchColumns(heldDocs.length), heldFlow);
    return;
  }

  const screens = selectedScreens(pendingScreens, selection);
  if (screens.length === 0) return;

  importButton.disabled = true;
  summary.style.display = "none";
  lastSkipped = [];
  // A fresh measuring frame per import: nothing the last design's script left
  // behind reaches this one.
  resetExtractor();

  const docs: IRDocument[] = [];
  // Only ever non-empty for a single-screen selection (see `refreshStates`), so
  // this is the whole import rather than one screen of a batch. Read once,
  // before the loop, so what gets imported is what the hint described even if a
  // control is touched while measuring.
  const states = statePlan();
  let columns: number | null = null;
  let flow: FlowSpec | null = null;

  // Strictly sequential, and it must stay that way. `mountDocument`
  // (src/ui/extract.ts) adopts the document's own stylesheets into this page's
  // single shared `<head>` and only removes them on dispose, and the token
  // index is read back off that same head. Two extractions in flight measure
  // each other's CSS.
  for (let index = 0; index < screens.length; index++) {
    const screen = screens[index];
    setStatus(
      "working",
      screens.length === 1
        ? "Measuring layout…"
        : `Measuring ${index + 1} of ${screens.length}: ${screen.label}…`,
    );
    showBatchProgress(index, screens.length, 0);

    try {
      const prepared = await prepareScreen(screen);
      if (prepared.skipReason) {
        lastSkipped.push({ name: prepared.label, message: prepared.skipReason });
        continue;
      }
      const measure = extractor(extractOptions(prepared).viewportWidth);
      if (measure.readAnimationSpec(prepared.html!)) {
        // A Claude Design animation: one frame per scene, wired to play itself.
        const out = adopt(await measure.extractAnimationScenes(
          prepared.html!,
          prepared.label,
          extractOptions(prepared),
          (done, total, label) => {
            setStatus("working", `Capturing scene ${done + 1} of ${total}: ${label}…`);
            showBatchProgress(done, total, 0);
          },
        ));
        const firstScene = docs.length;
        docs.push(...out.docs);
        if (screens.length === 1) {
          columns = out.docs.length;
          const sceneEdges = sceneFlow(prepared.label, out.scenes, out.loop);
          flow = sceneEdges && firstScene === 0 ? sceneEdges : flow;
        }
      } else if (states.selected.length > 0 && screens.length === 1) {
        // One document, N times over: each combination of the props the user
        // ticked becomes its own top-level frame, and they ride the same batch
        // path a multi-screen import already uses.
        docs.push(
          ...adopt(await measure.extractStateMatrix(
            prepared.html!,
            prepared.label,
            {
              ...extractOptions(prepared),
              states: { props: states.selected.map((axis) => axis.name) },
            },
            (done, total, label) => {
              setStatus("working", `Measuring ${Math.min(done + 1, total)} of ${total}: ${label}…`);
              showBatchProgress(done, total, 0);
            },
          )),
        );
        // The matrix's own grid width, not `batchColumns`: one row is one sweep
        // of the fastest axis, which is what makes fourteen frames read as
        // seven states in two themes rather than as fourteen screens.
        columns = states.plan.columns;
        // The same sweep, as a walkable prototype. A matrix of states is a
        // sequence somebody wants to click through, and the schema already says
        // in what order.
        flow = stateFlow(prepared.label, states.selected, states.plan);
      } else {
        docs.push(
          adopt(await measure.extractDocument(prepared.html!, prepared.label, extractOptions(prepared))),
        );
      }
    } catch (error) {
      // One screen that will not measure is one screen, not the batch. The
      // sandbox already survives a document that fails to build the same way
      // (`buildDocuments`, src/plugin/build.ts), and both report what was lost.
      lastSkipped.push({ name: screen.label, message: describeError(error) });
    }
  }

  if (docs.length === 0) {
    hideProgress();
    importButton.disabled = false;
    if (lastSkipped.length === 1) {
      setStatus("error", lastSkipped[0].message);
    } else {
      renderSummary(lastSkipped.map(describeSkip));
      setStatus("error", `None of the ${screens.length} screens could be imported.`);
    }
    return;
  }

  // Before anything downstream reads `designSystem.name`: the sandbox derives
  // the variable collection from it, and both the held-back path and the
  // straight-through one below post the same array.
  nameDesignSystems(docs, pendingFiles, pendingDsManifest);

  const held = triageDocs(docs);
  if (held) {
    heldDocs = docs;
    heldColumns = columns;
    heldFlow = flow;
    importButton.textContent = "Import anyway";
    importButton.disabled = false;
    hideProgress();
    setStatus("error", held);
    return;
  }

  sendImport(docs, columns ?? batchColumns(docs.length), flow);
});

function extractOptions(screen: Screen): Partial<ExtractOptions> {
  return {
    bindTokens: true,
    inferStacks: inferStacks.checked,
    viewportWidth: Math.max(320, parseInt(widthInput.value, 10) || 1440),
    // What the user added by hand, then the export's own `_ds` tokens on top.
    // This is measurement, not variable creation, so it is the same in all
    // three token modes (see `extraCssFor`, src/ui/token-mode.ts): a document
    // measured without the colours it was authored against imports the wrong
    // literals whether or not any variables get written.
    extraCss: extraCssFor(designSystemCss, pendingDsTokenCss.css),
    // The only place a token's per-surface values and its `@kind other`
    // annotation are written down, and what turns Build mode from a flat dump
    // into a library with modes. It also earns its keep in Map mode, where it
    // suppresses the sixteen `@kind other` values that survive the shape
    // heuristic and keeps surface-private tokens out of the match (see
    // `isBaseLayer`, src/plugin/mapping.ts).
    dsManifest: pendingDsManifest,
    moduleSources: pendingModuleSources,
    // Every other .html from the same drop, so a `<dc-import name="…">`
    // resolves to the real sibling document instead of a placeholder box
    // (collectDocumentSources above -> resolveDcImport, src/ui/resolve.ts).
    // Undefined for pasted markup and for a lone .dc.html, which is exactly
    // when the missing-documents warning below has something to say.
    documentSources: screen.documentSources,
  };
}

/**
 * Decide what to warn about across a whole batch, and whether to hold it.
 * Returns the status line for a held batch, or `null` to go ahead.
 *
 * The ladder is the single-document one it replaces, in the same order and for
 * the same reasons, read over the aggregate. Unresolved placeholder markup is
 * the serious problem: a missing stylesheet costs colour fidelity, but
 * unresolved placeholders mean the content itself never rendered. Stubbed
 * design-system components are a known, deliberate gap (we cannot render real
 * React components), so they get an informational note rather than holding the
 * import back.
 *
 * `documents` counts `<dc-import>` call sites STILL standing after resolution,
 * which is zero for any pass that ran at all: the resolver replaces every one
 * with either the target's real content or a sized placeholder box. Non-zero
 * means resolution bailed out altogether, and an unresolved `<dc-import>` is a
 * childless zero-size element that walk() drops (src/ui/extract.ts), so the
 * board imports with its embedded panels simply absent. That belongs with the
 * hold, not below it.
 *
 * Holds the WHOLE batch, never the offending screens alone. Importing the
 * clean ones and quietly dropping the rest is a partial import nobody asked
 * for, and the user cannot tell from the canvas which they got.
 */
function triageDocs(docs: IRDocument[]): string | null {
  const sum = (pick: (doc: IRDocument) => number) =>
    docs.reduce((total, doc) => total + pick(doc), 0);
  const gather = (pick: (doc: IRDocument) => string[]) =>
    Array.from(new Set(docs.reduce<string[]>((all, doc) => all.concat(pick(doc)), [])));

  const dynamic = docs.filter(
    (doc) =>
      doc.dynamicContent.placeholders > 0 ||
      doc.dynamicContent.loops > 0 ||
      doc.dynamicContent.documents > 0,
  );
  const documentsStubbed = sum((doc) => doc.dynamicContent.resolved.documentsStubbed);
  const documentsInlined = sum((doc) => doc.dynamicContent.resolved.documentsInlined);
  const componentsStubbed = sum((doc) => doc.dynamicContent.resolved.componentsStubbed);
  const missingStylesheets = gather((doc) => doc.missingStylesheets);
  const noTokensFound = docs.every(
    (doc) => (doc.designSystem?.tokens.length ?? 0) === 0,
  );
  // A board where not one embedded document resolved is a grid of empty
  // rectangles and nothing else: the exact shape of the bug dc-import support
  // exists to fix, and not something to write into someone's file without a
  // second, deliberate click. One document inlined and it drops back to
  // informational, because a partly real board is still worth having.
  const onlyPlaceholderDocuments = documentsStubbed > 0 && documentsInlined === 0;

  if (dynamic.length > 0) {
    showDynamicWarning(
      {
        placeholders: sum((doc) => doc.dynamicContent.placeholders),
        loops: sum((doc) => doc.dynamicContent.loops),
        components: sum((doc) => doc.dynamicContent.components),
        documents: sum((doc) => doc.dynamicContent.documents),
        resolved: {
          ran: dynamic.every((doc) => doc.dynamicContent.resolved.ran),
          error: dynamic
            .map((doc) => doc.dynamicContent.resolved.error)
            .find(Boolean),
        },
      },
      { affected: dynamic.length, total: docs.length },
    );
  } else if (documentsStubbed > 0) {
    // Ranked above componentsStubbed deliberately: a document that never
    // arrived is a whole missing sub-screen, a stubbed <x-import> is a
    // missing leaf inside one.
    showMissingDocumentsWarning(
      {
        documentsStubbed,
        documentsMissing: gather(
          (doc) => doc.dynamicContent.resolved.documentsMissing,
        ),
      },
      onlyPlaceholderDocuments,
    );
  } else if (componentsStubbed > 0) {
    showComponentsStubbedWarning(componentsStubbed);
  } else if (missingStylesheets.length > 0) {
    showTokenWarning(missingStylesheets);
  } else if (noTokensFound && !extraCssFor(designSystemCss, pendingDsTokenCss.css)) {
    // Exported decks are the common case here: they link only
    // tokens/fonts.css, so missingStylesheets is empty (nothing was
    // broken) yet the token table still comes back empty. Distinct from
    // showTokenWarning above, which fires when the document itself linked
    // _ds/ files that failed to load.
    //
    // Gated on everything that was supplied, not just the saved CSS. A project
    // export that ships its own `_ds` folder used to be told no design-system
    // tokens were found while they sat unread in the same drop; they are read
    // now (`collectDsTokenCss`), so the only honest way to still say it is if
    // there was genuinely nothing to read.
    showNoDesignSystemWarning();
  } else {
    hideTokenWarning();
  }

  if (dynamic.length > 0) {
    return docs.length === 1
      ? "Held back: this import would be mostly placeholders. See above."
      : `Held back: ${dynamic.length} of ${docs.length} screens would import as mostly placeholders. See above.`;
  }
  if (onlyPlaceholderDocuments) {
    return "Held back: every embedded document is missing, so this import would be empty boxes. See above.";
  }
  return null;
}

/**
 * Hand the sandbox a batch. One document is a batch of size one — the sandbox
 * has a single import path (`buildDocuments`, src/plugin/build.ts) and this
 * side never has to know whether it is importing one screen or fourteen.
 */
function sendImport(docs: IRDocument[], columns: number, flow: FlowSpec | null): void {
  heldDocs = null;
  heldColumns = null;
  heldFlow = null;
  importButton.textContent = "Import";
  importButton.disabled = true;
  setStatus("working", "Building in Figma…");
  showProgress(0, 1);
  lastSentTarget = currentTarget();
  parent.postMessage(
    {
      pluginMessage: {
        type: "import",
        docs,
        target: lastSentTarget,
        placement: { columns },
        // Omitted rather than sent as null when there is nothing to wire: the
        // field is optional on the message and `buildDocuments` branches on its
        // presence.
        ...(flow ? { flow } : {}),
      },
    },
    "*",
  );
}

function currentTarget(): VariableTarget {
  return tokenTarget(tokenMode, {
    collection: targetSelect.value,
    createMissing: createMissing.checked,
    systemName: discoveredDesignSystemName(),
  });
}

el<HTMLButtonElement>("cd2f-close").addEventListener("click", () => {
  parent.postMessage({ pluginMessage: { type: "cancel" } }, "*");
});

let activePrompt = EXPORT_PROMPT;

copyPromptButton.addEventListener("click", () => {
  copyToClipboard(activePrompt);
  copyPromptButton.textContent = "Copied";
  real.setTimeout(() => {
    copyPromptButton.textContent = "Copy prompt";
  }, 1600);
});

/**
 * `navigator.clipboard` needs a secure context and permission that a null-origin
 * plugin iframe does not reliably get, so the legacy path is the real one here.
 */
function copyToClipboard(text: string): void {
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(scratch);
  scratch.select();
  try {
    document.execCommand("copy");
  } catch {
    // Nothing further to try; the text stays visible for manual selection.
  }
  scratch.remove();
}

// ---------------------------------------------------------------------------
// Messages from the sandbox
// ---------------------------------------------------------------------------

window.onmessage = (event: MessageEvent) => {
  const message = event.data?.pluginMessage as PluginMessage | undefined;
  if (!message) return;

  switch (message.type) {
    case "targets":
      targets = message.summary;
      renderTargets();
      // Call site 1 of 7, and the reason the latch exists: this lands one async
      // round trip after first paint, well after someone could have clicked.
      applyTokenModeDefault();
      return;

    case "import-progress":
      showBatchProgress(
        message.docIndex,
        message.docCount,
        message.done / Math.max(1, message.total),
      );
      // The bar alone cannot say which of fourteen screens is being built, and
      // a status line that just reads "Building header…" for two minutes looks
      // stuck.
      setStatus(
        "working",
        message.docCount > 1
          ? `${message.docIndex + 1}/${message.docCount} ${message.docName}: ${message.label}`
          : message.label,
      );
      return;

    case "import-complete": {
      hideProgress();
      importButton.disabled = false;
      setStatus("done", "Imported.");

      const { mapping } = message;
      const lines = [`${message.nodes} layers created`];
      if (message.frames > 1) lines.unshift(`${message.frames} frames created`);

      const bound = mapping.boundByName + mapping.boundByValue;
      if (bound > 0) {
        lines.push(
          `${bound} tokens mapped to existing variables (${mapping.boundByName} by name, ${mapping.boundByValue} by value)`,
        );
      }
      if (mapping.created > 0) lines.push(`${mapping.created} new variables created`);
      const overflow = createOverflowNote(lastSentTarget, mapping.created);
      if (overflow) lines.push(overflow);
      if (mapping.unmatched > 0) {
        lines.push(`${mapping.unmatched} tokens left as literals (no match)`);
      }
      if (bound === 0 && mapping.created === 0) {
        lines.push("No design tokens bound — values imported as literals");
      }
      lines.push(...mapping.samples);

      // Prototype connections are invisible in the Design tab by default, so an
      // import that wired fourteen frames together looks exactly like one that
      // wired nothing. Naming the shortcut is the whole difference between the
      // feature existing and the feature being found.
      if (message.reactions > 0) {
        lines.push(
          `${message.reactions} prototype links created. Press ⇧E or open the Prototype tab to see them`,
        );
      }

      if (message.substitutions.length > 0) {
        lines.push(`Fonts substituted: ${message.substitutions.join(", ")}`);
      }
      for (const warning of message.warnings.slice(0, 6)) lines.push(warning);
      if (message.warnings.length > 6) {
        lines.push(`…and ${message.warnings.length - 6} more notes`);
      }

      // A screen that could not be read here, or built there, is missing from
      // the canvas with nothing to click on, so the summary is the only place
      // it can be reported at all. Both halves of the trip say it the same way.
      for (const skipped of lastSkipped) lines.push(describeSkip(skipped));
      for (const entry of message.perDocument) {
        if (!entry.ok) lines.push(`Could not import ${entry.name}: ${entry.message}`);
      }

      renderSummary(lines);
      return;
    }

    case "import-failed":
      hideProgress();
      importButton.disabled = false;
      setStatus("error", message.message);
      return;

    // Sent once at startup, only when a design system was saved on a
    // previous import — hydrates `designSystemCss` so it applies to this
    // import automatically, with no re-pick required.
    case "design-system-loaded":
      designSystemCss = message.stored.css;
      dsFileCount = message.stored.fileCount;
      renderDesignSystemStatus({ fileCount: dsFileCount, persisted: true });
      // Call site 5 of 7. A design system restored from a previous session is
      // something to build from, and it arrives on its own schedule.
      applyTokenModeDefault();
      return;

    case "design-system-saved":
      renderDesignSystemStatus({ fileCount: dsFileCount, persisted: message.ok });
      return;
  }
};

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/**
 * Real collections only.
 *
 * "Create a new collection" and "Don't create variables" used to sit in this
 * list beside the user's own libraries, which made three different operations
 * look like three flavours of the same one. They are the Build and None radios
 * now; this select answers one question, which collection to map onto, and is
 * only shown when Map is the answer.
 */
function renderTargets(): void {
  const options: string[] = [];

  for (const collection of targets.local) {
    options.push(
      `<option value="local:${collection.id}">${escapeHtml(collection.name)} (${collection.variableCount} variables)</option>`,
    );
  }
  for (const collection of targets.libraries) {
    options.push(
      `<option value="library:${collection.key}">${escapeHtml(collection.libraryName)} / ${escapeHtml(collection.name)}</option>`,
    );
  }

  targetSelect.innerHTML = options.join("");

  // Default to the user's own system when they have one: mapping onto an
  // existing library is almost always what they want over a parallel copy.
  if (targets.libraries.length > 0) {
    targetSelect.value = `library:${targets.libraries[0].key}`;
  } else if (targets.local.length > 0) {
    targetSelect.value = `local:${targets.local[0].id}`;
  }
}

/**
 * What the mode control knows right now. Read fresh every time rather than
 * cached: both halves of it arrive asynchronously and at different moments
 * (see `TokenModeFacts`, src/ui/token-mode.ts).
 */
function tokenModeFacts(): TokenModeFacts {
  return {
    collections: targets.local.length + targets.libraries.length,
    exportTokenFiles: pendingDsTokenCss.fileCount,
    savedTokenFiles: dsFileCount,
    exportAlreadySaved:
      pendingDsTokenCss.css.length > 0 && designSystemCss === pendingDsTokenCss.css,
    loaded: pendingScreens.length > 0,
  };
}

/**
 * Re-derive the default mode, unless the user has made the choice themselves.
 *
 * Called from every event that moves either fact: the `targets` message, an
 * accepted drop, a drop that failed to unpack, pasted markup, and all three
 * ways the saved design system changes. Miss one and the default stops tracking
 * reality without any symptom on screen, which is the whole failure mode of a
 * default computed once. It is also what happened to the failed-unpack path,
 * which is why the `pendingScreens` half of that rule is now asserted against
 * this file's own source in scenario M (test/e2e/run.ts) rather than trusted to
 * the numbered comments alone.
 */
function applyTokenModeDefault(): void {
  if (!tokenModeUserSet) tokenMode = defaultTokenMode(tokenModeFacts());
  renderTokenMode();
}

function renderTokenMode(): void {
  const facts = tokenModeFacts();
  const availability = tokenModeAvailability(facts);

  // A deliberate choice can be overtaken by the facts: Build picked while an
  // export was loaded, and then the paste box emptied. Falling back to the
  // default is the only option that does not leave a disabled radio selected,
  // and the latch is released with it. Keeping it would pin the fallback WE
  // picked as though the user had chosen it, and the mode would then sit on
  // that for the rest of the session while the panel pretended to be tracking.
  if (availability[tokenMode] !== null) {
    tokenMode = defaultTokenMode(facts);
    tokenModeUserSet = false;
  }

  for (const mode of ["map", "build", "none"] as const) {
    tokenModeRadios[mode].checked = tokenMode === mode;
    tokenModeRadios[mode].disabled = availability[mode] !== null;
  }
  modeReasons.map.textContent = availability.map ?? "";
  modeReasons.build.textContent = availability.build ?? "";

  targetRow.style.display = tokenMode === "map" ? "flex" : "none";
  buildRow.style.display = tokenMode === "build" ? "flex" : "none";
  createMissing.disabled = tokenMode !== "map";

  const status = buildStatusLine(facts, discoveredDesignSystemName());
  buildStatusText.innerHTML =
    escapeHtml(status.text) +
    (status.offerSave
      ? ` <span class="cd2f-link" data-cd2f-save-ds>save this as my design system</span>`
      : "");
}

for (const mode of ["map", "build", "none"] as const) {
  tokenModeRadios[mode].addEventListener("change", () => {
    if (!tokenModeRadios[mode].checked) return;
    tokenMode = mode;
    tokenModeUserSet = true;
    renderTokenMode();
  });
}

// Delegated because the link only exists while an export's own tokens are on
// offer, and `renderTokenMode` rewrites this span every time anything moves.
buildStatusText.addEventListener("click", (event) => {
  const clicked = event.target as HTMLElement | null;
  if (!clicked?.hasAttribute("data-cd2f-save-ds")) return;
  saveDiscoveredDesignSystem();
});

/**
 * Keep the export's own token CSS as the saved design system, on purpose.
 *
 * What a drop ships is session-scoped everywhere else in this file: persisting
 * it automatically would replace whatever the user assembled by hand via "add
 * token files" with whatever zip they happened to open, and the size guard in
 * src/plugin/main.ts is a single budget for the lot. So it is a link, in the
 * one place the discovered system is already being named.
 */
function saveDiscoveredDesignSystem(): void {
  if (pendingDsTokenCss.css.length === 0) return;
  designSystemCss = pendingDsTokenCss.css;
  dsFileCount = pendingDsTokenCss.fileCount;
  renderDesignSystemStatus({ fileCount: dsFileCount, persisted: undefined });
  parent.postMessage(
    {
      pluginMessage: {
        type: "save-design-system",
        css: designSystemCss,
        fileCount: dsFileCount,
      },
    },
    "*",
  );
  renderTokenMode();
}

/**
 * `scope` names how much of the batch this is about. A warning that says "this
 * document" over a twelve-screen import leaves the user with no idea whether
 * one screen or all twelve is the problem, and the counts are summed across
 * only the affected ones.
 */
function showDynamicWarning(
  info: {
    placeholders: number;
    loops: number;
    components: number;
    documents: number;
    resolved: { ran: boolean; error?: string };
  },
  scope: { affected: number; total: number },
): void {
  const bits: string[] = [];
  if (info.placeholders > 0) bits.push(`${info.placeholders} {{ }} placeholders`);
  if (info.loops > 0) bits.push(`${info.loops} sc-for/sc-if blocks`);
  if (info.components > 0) bits.push(`${info.components} x-import components`);
  // Only reachable when resolution bailed out before it could splice these:
  // a pass that ran leaves none standing, whether or not the target was found.
  if (info.documents > 0) bits.push(`${info.documents} dc-import documents`);

  // resolveDynamicDocument (src/ui/resolve.ts) already tried to execute this
  // document's own embedded script before we ever got here — this only fires
  // when that attempt left something behind, so say what happened when we
  // know why (script failed outright vs. simply not present).
  const reason = !info.resolved.ran && info.resolved.error
    ? ` We tried running its embedded script, but it failed: ${info.resolved.error}.`
    : "";

  const subject =
    scope.total > 1
      ? `${scope.affected} of ${scope.total} screens build themselves`
      : "This document builds itself";

  activePrompt = STATIC_PROMPT;
  tokenWarningText.textContent = `${subject} at load time (${bits.join(", ")}).${reason} Those need Claude Design's scripts, which cannot run here, so parts of this import will be placeholders rather than the real design. Paste this prompt in Claude Design to get a fully static copy.`;
  tokenWarning.style.display = "block";
  copyPromptButton.style.display = "block";
}

/**
 * `<dc-import>` call sites that fell back to a labelled, `hint-size`d
 * placeholder box instead of the sibling document's real content.
 *
 * Informational by default. The box is on the canvas at the size the author
 * declared for it, so the rest of the board is genuinely real and worth having,
 * and the fix is usually one drag away (drop the folder, not the one file),
 * which is what the copy has to say. Naming the documents matters more than
 * counting the call sites: one board embeds the same panel fourteen times.
 *
 * `held` is the one case that is not worth importing quietly: every embedded
 * document stubbed and not one inlined, which is a board of empty rectangles.
 * That is the shape of the original bug, so it gets the same second-click
 * gesture as a document that never resolved at all.
 *
 * `documentsMissing` can be empty while `documentsStubbed` is not, because a
 * cycle, the nesting cap, or a target whose own script threw all produce a box
 * with no file to go and fetch. The two get different copy.
 */
function showMissingDocumentsWarning(
  resolved: {
    documentsMissing: string[];
    documentsStubbed: number;
  },
  held: boolean,
): void {
  activePrompt = EXPORT_PROMPT;
  const missing = resolved.documentsMissing;
  const boxes = `${resolved.documentsStubbed} embedded document${resolved.documentsStubbed === 1 ? "" : "s"}`;
  const cause =
    missing.length > 0
      ? `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in this drop, so ${boxes} imported as labelled placeholder boxes. Drop the whole project folder or .zip and they come across with it.`
      : `${boxes} could not be rendered and imported as labelled placeholder boxes.`;
  tokenWarningText.textContent = held
    ? `${cause} Nothing embedded resolved, so this board would import as placeholder boxes and nothing else.`
    : cause;
  tokenWarning.style.display = "block";
  // The remedy is a different drop, not a different export. Copying the "make a
  // self-contained copy" prompt would send someone back to Claude Design for a
  // file they already have on disk.
  copyPromptButton.style.display = "none";
}

/**
 * `<x-import>` slots for real design-system React components (e.g. a
 * acme-design-system Button) that we cannot render — resolveDynamicDocument
 * still resolves everything else and stubs these individually as labelled
 * placeholder boxes, so this is informational, not a reason to hold the
 * import back the way genuinely unresolved placeholders are.
 */
function showComponentsStubbedWarning(count: number): void {
  activePrompt = EXPORT_PROMPT;
  tokenWarningText.textContent = `${count} design-system component${count === 1 ? "" : "s"} could not be rendered and ${count === 1 ? "was" : "were"} imported as labelled placeholder${count === 1 ? "" : "s"}.`;
  tokenWarning.style.display = "block";
  copyPromptButton.style.display = "none";
}

function showTokenWarning(missing: string[]): void {
  activePrompt = EXPORT_PROMPT;
  const looksLikeDesignSystem = missing.some((href) => href.includes("_ds/"));
  tokenWarningText.textContent = looksLikeDesignSystem
    ? `This file links ${missing.length} design-system stylesheet${missing.length === 1 ? "" : "s"} that aren't here, so colours came in as literals. Claude Design downloads files one at a time — paste this prompt there to get a single self-contained file, then drop that in.`
    : `${missing.length} stylesheet${missing.length === 1 ? "" : "s"} could not be loaded, so some styling may be missing.`;
  tokenWarning.style.display = "block";
  copyPromptButton.style.display = looksLikeDesignSystem ? "block" : "none";
}

/**
 * The document has no `_ds` link at all to fail — an exported deck's markup
 * simply never mentions the design system, so `missingStylesheets` is empty
 * and `showTokenWarning` above never fires. Zero tokens with nothing saved
 * yet is the actual first-run state this whole feature exists to fix, so it
 * gets its own message pointing at the "add token files" control below
 * rather than the copy-prompt remedy (which fixes a different problem: a
 * lone .dc.html that dropped its own linked _ds files).
 */
function showNoDesignSystemWarning(): void {
  tokenWarningText.textContent =
    "No design-system tokens were found, so colours will import as literal values. Add your design system's token CSS once below (\"add token files\") and it will be reused automatically on every future import.";
  tokenWarning.style.display = "block";
  copyPromptButton.style.display = "none";
}

function hideTokenWarning(): void {
  tokenWarning.style.display = "none";
}

/** One skipped screen, phrased exactly like a document the sandbox could not build. */
function describeSkip(skipped: { name: string; message: string }): string {
  return `Could not import ${skipped.name}: ${skipped.message}`;
}

function renderSummary(lines: string[]): void {
  summary.innerHTML = lines
    .map((line) => `<div class="cd2f-summary-line">${escapeHtml(line)}</div>`)
    .join("");
  summary.style.display = "block";
}

function showProgress(done: number, total: number): void {
  progressWrap.style.display = "block";
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  progressBar.style.width = `${pct}%`;
}

/**
 * One bar across a whole batch: `index` documents finished plus `inner` (0-1)
 * of the one in flight.
 *
 * Deliberately not blended with extraction into a single 0-100%. Measuring a
 * screen and building it cost wildly different amounts of time and neither is
 * knowable in advance, so the bar sweeps twice — once while measuring, once
 * while building — and the status line says which sweep this is.
 */
function showBatchProgress(index: number, count: number, inner: number): void {
  showProgress(index + Math.min(1, Math.max(0, inner)), Math.max(1, count));
}

function hideProgress(): void {
  progressWrap.style.display = "none";
  progressBar.style.width = "0%";
}

function setStatus(
  stage: "idle" | "working" | "done" | "error",
  message: string,
): void {
  statusText.textContent = message;
  statusText.className = `cd2f-status cd2f-status--${stage}`;
}

function clearHold(): void {
  heldDocs = null;
  heldColumns = null;
  heldFlow = null;
  importButton.textContent = "Import";
}

function updateButton(): void {
  if (heldDocs) {
    importButton.disabled = false;
    return;
  }
  // A refused matrix disables Import rather than failing on the click. The
  // number and the way out are both already on screen (`stateHint`), and a
  // button that can only produce an error is a worse way to say the same thing.
  importButton.disabled = pendingScreens.length === 0 || statePlan().plan.capped;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

updateButton();
renderTargets();
// Paints the mode control against what is known before the sandbox answers:
// no collections, nothing loaded, so None. The `targets` message corrects it.
applyTokenModeDefault();
parent.postMessage({ pluginMessage: { type: "scan-targets" } }, "*");
