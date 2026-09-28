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
  if (typeof __SELFTEST__ !== "undefined" && __SELFTEST__ && (message as { type: string }).type.startsWith("selftest-")) {
    await selftest(message as unknown as { type: string; scale?: number; components?: boolean });
    return;
  }
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
    // The whole error, stack included, for whoever reads the console.
    console.error("[ferry] import failed", error instanceof Error ? error.stack || error.message : error);
    post({ type: "import-failed", message: describeError(error) });
    figma.notify("Import failed. See the panel for details.", { error: true });
  }
}

/**
 * Test-driver hooks, compiled only into the `--selftest` build. The driver
 * clears the page, runs an import through the real panel, then asks for what
 * Figma actually rendered, as PNG, and for the layer tree.
 */
async function selftest(message: { type: string; scale?: number; components?: boolean }): Promise<void> {
  const reply = (payload: Record<string, unknown>) => figma.ui.postMessage({ selftest: true, ...payload });
  try {
    if (message.type === "selftest-fonts") {
      const t0 = Date.now();
      const list = await figma.listAvailableFontsAsync();
      const t1 = Date.now();
      const loads: Record<string, string> = {};
      for (const fam of ["Inter", "Roboto", "Geist", "Newsreader", "Hind"]) {
        const s0 = Date.now();
        try { await figma.loadFontAsync({ family: fam, style: "Regular" }); loads[fam] = `${Date.now() - s0}ms`; }
        catch (e) { loads[fam] = `${Date.now() - s0}ms ${String((e as Error).message).slice(0, 80)}`; }
      }
      reply({ type: "selftest-fonts", list: list.length, listMs: t1 - t0, loads });
      return;
    }
    if (message.type === "selftest-clear") {
      for (const node of [...figma.currentPage.children]) node.remove();
      reply({ type: "selftest-cleared" });
      return;
    }
    // The imported screens; a document's components frame is not one.
    const tops = figma.currentPage.children.filter(
      (n) => (n.type === "FRAME" || n.type === "SECTION") && n.getPluginData("ferry.role") !== "components",
    ) as SceneNode[];
    const frames: FrameNode[] = [];
    for (const top of tops) {
      if (top.type === "SECTION") frames.push(...(top.children.filter((c) => c.type === "FRAME") as FrameNode[]));
      else frames.push(top as FrameNode);
    }
    if (message.type === "selftest-export") {
      const out = [];
      const pick = message.components
        ? (figma.currentPage.children.filter((n) => n.getPluginData("ferry.role") === "components") as FrameNode[])
        : frames;
      for (const frame of pick) {
        const bytes = await frame.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: message.scale ?? 1 } });
        out.push({ name: frame.name, width: frame.width, height: frame.height, png: figma.base64Encode(bytes) });
      }
      reply({ type: "selftest-png", frames: out });
      return;
    }
    if (message.type === "selftest-tree") {
      const dump = (node: SceneNode): Record<string, unknown> => {
        const n = node as SceneNode & Record<string, unknown>;
        const base: Record<string, unknown> = {
          type: node.type, name: node.name, x: Math.round(node.x * 10) / 10, y: Math.round(node.y * 10) / 10,
          w: Math.round(node.width * 10) / 10, h: Math.round(node.height * 10) / 10,
        };
        if ("rotation" in n && n.rotation) base.rotation = n.rotation;
        const sceneTime = node.getPluginData("ferry.sceneTime");
        if (sceneTime) base.sceneTime = Number(sceneTime);
        if ("opacity" in n && n.opacity !== 1) base.opacity = n.opacity;
        if (node.type === "TEXT") {
          base.characters = node.characters;
          base.font = node.fontName === figma.mixed ? "mixed" : `${(node.fontName as FontName).family} ${(node.fontName as FontName).style}`;
          base.size = node.fontSize === figma.mixed ? "mixed" : node.fontSize;
          base.align = node.textAlignHorizontal;
          base.resize = node.textAutoResize;
          if (node.textTruncation !== "DISABLED") base.truncation = `${node.textTruncation}/${node.maxLines}`;
        }
        if ("fills" in n && Array.isArray(n.fills) && (n.fills as Paint[]).length) {
          base.fills = (n.fills as Paint[]).map((p) => p.type + ((p as SolidPaint).boundVariables?.color ? "*" : ""));
        }
        if ("layoutMode" in n && n.layoutMode !== "NONE") base.layout = n.layoutMode;
        if ("children" in node) base.children = (node as FrameNode).children.map(dump);
        return base;
      };
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const areas = figma.currentPage.children.filter((n) => n.getPluginData("ferry.role") === "components") as SceneNode[];
      reply({
        type: "selftest-tree",
        frames: frames.map(dump),
        components: areas.map(dump),
        collections: collections.map((c) => ({ name: c.name, modes: c.modes.map((m) => m.name), count: c.variableIds.length })),
        reactions: frames.map((f) => ({ name: f.name, reactions: f.reactions.map((r) => ({ trigger: r.trigger?.type, timeout: (r.trigger as { timeout?: number })?.timeout, transition: r.actions?.[0] && (r.actions[0] as { transition?: { type: string } | null }).transition?.type })) })),
      });
      return;
    }
  } catch (error) {
    reply({ type: "selftest-error", message: String((error as Error)?.message ?? error) });
  }
}

function post(message: PluginMessage): void {
  figma.ui.postMessage(message);
}
