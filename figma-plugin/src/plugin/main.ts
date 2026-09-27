/**
 * Plugin sandbox entry point. Owns the Figma document; has no DOM.
 * All measurement happens in the UI half and arrives here as IR.
 */

import type { PluginMessage, StoredDesignSystem, UIMessage } from "../ir";
import { buildDocuments } from "./build";
import { scanTargets } from "./mapping";
import { describeError } from "../errors";

figma.showUI(__html__, { width: 400, height: 620, themeColors: true });

/**
 * Design-system CSS persists here, keyed once per plugin. There is only ever
 * one "current" design system for this plugin — swapping in a new one is a
 * deliberate replace, not something we need to namespace per file/user.
 */
const DESIGN_SYSTEM_STORAGE_KEY = "designSystemCss";

/**
 * clientStorage's real ceiling is ~1MB/key, ~5MB total, but nothing else in
 * this plugin uses clientStorage, so the practical risk is a single
 * enormous paste rather than quota shared with other data. 500KB is a wide
 * margin under that ceiling — a real design system's token CSS is ~25KB.
 */
const MAX_STORED_DESIGN_SYSTEM_BYTES = 500_000;

loadStoredDesignSystem();

async function loadStoredDesignSystem(): Promise<void> {
  try {
    const stored = (await figma.clientStorage.getAsync(
      DESIGN_SYSTEM_STORAGE_KEY,
    )) as StoredDesignSystem | undefined;
    if (stored && typeof stored.css === "string" && stored.css.length > 0) {
      post({ type: "design-system-loaded", stored });
    }
  } catch {
    // No stored design system, or clientStorage unavailable — the user just
    // sees the normal "none saved" state and can add one as usual.
  }
}

async function saveDesignSystem(css: string, fileCount: number): Promise<void> {
  const bytes = new TextEncoder().encode(css).length;
  if (bytes > MAX_STORED_DESIGN_SYSTEM_BYTES) {
    post({ type: "design-system-saved", ok: false, reason: "too-large" });
    return;
  }
  try {
    const stored: StoredDesignSystem = { css, fileCount };
    await figma.clientStorage.setAsync(DESIGN_SYSTEM_STORAGE_KEY, stored);
    post({ type: "design-system-saved", ok: true });
  } catch (error) {
    post({
      type: "design-system-saved",
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

figma.ui.onmessage = async (message: UIMessage) => {
  switch (message.type) {
    case "cancel":
      figma.closePlugin();
      return;

    case "resize":
      figma.ui.resize(message.width, message.height);
      return;

    case "notify":
      figma.notify(message.message, { error: message.error });
      return;

    case "scan-targets":
      // Unanswered, the panel waits on this forever. An empty summary with the
      // reason still lets "build a new collection" work.
      try {
        post({ type: "targets", summary: await scanTargets() });
      } catch (error) {
        post({
          type: "targets",
          summary: { local: [], libraries: [], libraryError: describeError(error) },
        });
      }
      return;

    case "import":
      await runImport(message);
      return;

    case "save-design-system":
      await saveDesignSystem(message.css, message.fileCount);
      return;

    case "clear-design-system":
      await figma.clientStorage.deleteAsync(DESIGN_SYSTEM_STORAGE_KEY).catch(() => {});
      return;
  }
};

async function runImport(
  message: Extract<UIMessage, { type: "import" }>,
): Promise<void> {
  try {
    const result = await buildDocuments(
      message.docs,
      message.target,
      message.placement ?? {},
      (docIndex, docCount, done, total, label) =>
        post({
          type: "import-progress",
          docIndex,
          docCount,
          docName: message.docs[docIndex]?.name ?? "",
          done,
          total,
          label,
        }),
      { flow: message.flow },
    );

    // Every document failing is the one case that reads as an outright failed
    // import. A batch that lost one screen out of fourteen still put thirteen
    // on the canvas and reports the loss in the summary.
    if (result.roots.length === 0) {
      const failure = result.perDocument.find((entry) => !entry.ok);
      post({
        type: "import-failed",
        message:
          failure && !failure.ok ? failure.message : "Nothing was imported.",
      });
      figma.notify("Import failed", { error: true });
      return;
    }

    // The section when there is one: selecting its fourteen children instead
    // hands the designer a multi-select they have to escape before they can
    // move the thing as a unit.
    const focus: SceneNode[] = result.section ? [result.section] : result.roots;
    figma.currentPage.selection = focus;
    figma.viewport.scrollAndZoomIntoView(focus);

    // The build yields to keep the editor responsive, and each yield would
    // otherwise become its own undo step. One import should be one undo —
    // a batch included, or undoing a 14-screen import means 14 ctrl-Zs.
    figma.commitUndo();

    post({
      type: "import-complete",
      nodes: result.nodeCount,
      frames: result.roots.length,
      mapping: result.mapping,
      substitutions: result.substitutions,
      warnings: result.warnings,
      reactions: result.reactions,
      flows: result.flows,
      perDocument: result.perDocument,
    });

    const bound = result.mapping.boundByName + result.mapping.boundByValue;
    const bits = [`${result.nodeCount} layers`];
    if (result.roots.length > 1) bits.unshift(`${result.roots.length} frames`);
    if (bound > 0) bits.push(`${bound} tokens mapped`);
    if (result.mapping.created > 0) bits.push(`${result.mapping.created} created`);

    const failed = result.perDocument.filter((entry) => !entry.ok).length;
    if (failed > 0) bits.push(`${failed} skipped`);

    figma.notify(`Imported ${bits.join(", ")}`);
  } catch (error) {
    post({ type: "import-failed", message: describeError(error) });
    figma.notify("Import failed. See the panel for details.", { error: true });
  }
}

function post(message: PluginMessage): void {
  figma.ui.postMessage(message);
}
