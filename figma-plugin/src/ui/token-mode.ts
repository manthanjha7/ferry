/**
 * What the plugin does with the export's design tokens, as a choice the user
 * makes rather than a dropdown that quietly means three different things.
 *
 * There are three operations here, not one:
 *
 *   map:   the user has a design system in this Figma file, and the import
 *          should bind onto it.
 *   build: the user has a design system in the EXPORT, and the import should
 *          write it into the file as a real library: a mode per themed surface,
 *          the semantic layer as genuine aliases (src/plugin/mapping.ts,
 *          `buildDesignSystem`).
 *   none:  no variables at all, colours land as literals.
 *
 * Split out of src/ui/main.ts for the same reason src/ui/screens.ts was: main.ts
 * binds every element at module top level and cannot be imported outside a
 * browser, so a decision left in it is a decision nothing can assert on. Every
 * rule below fails quietly if it is wrong: a radio silently missing, a mode
 * defaulting to something the file cannot do, "build a design system" wired to
 * a flat single-mode dump. So they live here and are asserted in
 * test/e2e/run.ts scenario M.
 */

import type { VariableTarget } from "../ir";

export type TokenMode = "map" | "build" | "none";

/**
 * Everything the panel knows at the moment it has to choose a mode.
 *
 * The two halves arrive at different times and neither can be waited for: the
 * collection count comes back from the sandbox one round trip after first paint
 * (`scan-targets` -> `targets`, src/plugin/mapping.ts), and what the export
 * ships is only known once a drop is accepted. So this is recomputed at every
 * event that moves either number, not read once at startup.
 */
export type TokenModeFacts = {
  /** Variable collections in this Figma file: local plus library. */
  collections: number;
  /** `_ds/**\/tokens/*.css` files found in the drop. */
  exportTokenFiles: number;
  /** Token CSS the user added by hand, persisted across sessions. */
  savedTokenFiles: number;
  /**
   * Custom properties the dropped pages declare themselves. Claude Design
   * usually inlines its tokens rather than shipping a _ds folder, so this is
   * the common way an export carries a design system.
   */
  documentTokens: number;
  /** The export's token CSS is already what is saved, so there is nothing to offer. */
  exportAlreadySaved: boolean;
  /** Anything at all to import: a drop, or pasted markup. */
  loaded: boolean;
};

/**
 * Why a mode cannot be chosen, or `null` when it can.
 *
 * A reason rather than a boolean, and rendered next to the radio rather than
 * hiding it: a control that vanishes when its precondition is absent teaches
 * nobody why, and "map onto my design system" missing from a file with no
 * collections reads as the plugin not having the feature.
 *
 * The two preconditions are about different places, which is why they are
 * checked at different moments. Map needs a design system in the FILE, and
 * that is known from the `targets` message onward whether or not anything has
 * been dropped. Build needs a design system in the EXPORT, so it has nothing
 * to build until something is loaded.
 *
 * Build deliberately is NOT gated on having spotted `_ds` token CSS. Claude
 * Design's own recommended export (see `EXPORT_PROMPT`, src/ui/main.ts) inlines
 * every `_ds` stylesheet into a `<style>` block, which leaves no `_ds` folder
 * to find and a perfectly good design system in the markup. Refusing Build
 * there would refuse the workflow this plugin tells people to use. What was
 * found is reported by `buildStatusLine` instead.
 */
export type TokenModeAvailability = Record<TokenMode, string | null>;

export function tokenModeAvailability(facts: TokenModeFacts): TokenModeAvailability {
  return {
    map: facts.collections > 0 ? null : "no variable collections in this file",
    build: facts.loaded ? null : "nothing loaded yet",
    none: null,
  };
}

/**
 * The mode to start on, given what is actually there.
 *
 * The ladder is the user's own sentence: if I have a design system, map onto
 * it; if I do not, make one from the export; otherwise leave the colours alone.
 *
 * It never returns a mode `tokenModeAvailability` would disable. A saved design
 * system with nothing dropped yet is the case that catches this out: it wants
 * Build and Build has nothing to build from, so it stays on None and flips the
 * moment an export lands.
 */
export function defaultTokenMode(facts: TokenModeFacts): TokenMode {
  const available = tokenModeAvailability(facts);
  if (available.map === null) return "map";
  if (
    available.build === null &&
    (facts.exportTokenFiles > 0 || facts.savedTokenFiles > 0 || facts.documentTokens > 0)
  ) {
    return "build";
  }
  return "none";
}

/** The line under the Build radio, and whether to offer to keep what was found. */
export type BuildStatus = {
  text: string;
  /**
   * Export-discovered token CSS is session-scoped: persisting it silently
   * replaces whatever the user chose by hand via "add token files", and
   * clientStorage's guard (src/plugin/main.ts) is one budget for the whole
   * saved design system. So keeping it is an explicit link, never a side
   * effect of dropping a zip.
   */
  offerSave: boolean;
};

export function buildStatusLine(
  facts: TokenModeFacts,
  systemName: string | undefined,
): BuildStatus {
  if (facts.exportTokenFiles > 0) {
    const files = `${facts.exportTokenFiles} token file${facts.exportTokenFiles === 1 ? "" : "s"}`;
    const named = systemName ? `${systemName}, ` : "";
    return { text: `${named}${files} in this export.`, offerSave: !facts.exportAlreadySaved };
  }
  if (facts.savedTokenFiles > 0) {
    const files = `${facts.savedTokenFiles} token file${facts.savedTokenFiles === 1 ? "" : "s"}`;
    return {
      text: `No _ds folder in this export. Building from the ${files} you added.`,
      offerSave: false,
    };
  }
  return {
    text: "No _ds folder in this export. Building from whatever tokens the document declares itself.",
    offerSave: false,
  };
}

/**
 * The design system's name, from the `_ds` folder the export ships.
 *
 * `_ds/acme-design-system-3f2a9c1e-7b4d-4e8a-…/tokens/colors.css` is named
 * after the system with a UUID stapled on, so the folder is the one place a
 * readable name exists: `_ds_manifest.json` carries `namespace`
 * ("AcmeDesignSystem_3f2a9c"), which is a stable key and not a label anybody
 * wants on a Figma collection. Same shape as `inferSystemName`
 * (src/ui/extract.ts), read off the file paths rather than the markup because
 * `inlineAssets` has already rewritten every `_ds/` href into a data URI by the
 * time the markup is measured.
 */
const DS_FOLDER = /(?:^|\/)_ds\/([a-z0-9-]+?)-[0-9a-f]{8}-[0-9a-f]{4}-/i;

export function dsSystemName(files: File[]): string | undefined {
  for (const file of files) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    const match = DS_FOLDER.exec(path);
    if (match) {
      return match[1].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  return undefined;
}

/**
 * The mode, as the thing the sandbox actually acts on.
 *
 * Build maps to `{kind:"build"}` and must never be wired to `{kind:"create"}`,
 * which produces a flat single-mode collection whose aliases only point within
 * itself: no mode per surface, no STRING variables, no effect styles for the
 * shadow tokens. Both variants exist and both build something, so the wrong one
 * imports successfully and looks plausible on canvas. The radio promises "build
 * a design system from this export" and `{kind:"create"}` does not deliver one.
 *
 * `modes` is on because a mode per themed surface is the whole difference
 * between a library and a dump. `strings` is left off: a STRING variable is
 * inert everywhere except a text node's font family.
 */
export function tokenTarget(
  mode: TokenMode,
  choice: {
    /** The `cd2f-target` select's value, `"local:<id>"` or `"library:<key>"`. */
    collection: string;
    createMissing: boolean;
    systemName?: string;
  },
): VariableTarget {
  if (mode === "none") return { kind: "none" };
  if (mode === "build") {
    // "" falls back to the extracted system's own name in
    // `resolveSystemCollection` (src/plugin/mapping.ts), which is the right
    // answer when the export ships no readable folder name.
    return { kind: "build", name: choice.systemName ?? "", modes: true };
  }

  const separator = choice.collection.indexOf(":");
  const kind = separator >= 0 ? choice.collection.slice(0, separator) : "";
  const id = separator >= 0 ? choice.collection.slice(separator + 1) : "";
  if (kind === "local") {
    return { kind: "local", collectionId: id, createMissing: choice.createMissing };
  }
  if (kind === "library") {
    return { kind: "library", collectionKey: id, createMissing: choice.createMissing };
  }
  // Map with an empty picker. The radio is disabled in that state, so this is
  // only reachable if the collection list emptied underneath a deliberate
  // choice, and creating a parallel system nobody asked for is worse than
  // importing literals.
  return { kind: "none" };
}

/**
 * The CSS injected before the document is measured.
 *
 * Not mode-dependent, deliberately. `extraCss` decides what the offscreen
 * render MEASURES; `VariableTarget` decides what gets WRITTEN into the file.
 * Withholding the export's own tokens in None mode would measure a document
 * against colours it was never authored with and then import those wrong
 * literals, which is the worst of both.
 *
 * The export's own `_ds` tokens go last so they win the cascade: they are what
 * this document was authored against, while the saved CSS is a standing
 * fallback for documents that link nothing.
 */
export function extraCssFor(saved: string, discovered: string): string | undefined {
  const parts = [saved, discovered].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Past this many new variables, mode (a) has stopped mapping and started
 * copying.
 */
export const CREATE_OVERFLOW_LIMIT = 20;

/**
 * Said after the import, not before it: the count is only knowable once the
 * mapping has run.
 *
 * Mode (a)'s overflow collection is by definition the part the user's own
 * system does not cover, and structuring THAT into modes and aliases would be
 * presumptuous. But a hundred of them means the export's tokens are a design
 * system in their own right and Build is the honest answer, so say so once and
 * leave the choice alone.
 */
export function createOverflowNote(
  target: VariableTarget | null,
  created: number,
): string | null {
  if (!target || (target.kind !== "local" && target.kind !== "library")) return null;
  if (!target.createMissing) return null;
  if (created <= CREATE_OVERFLOW_LIMIT) return null;
  return `${created} of those are new, so most of this export is not covered by the collection you picked. “Build a design system from this export” would make them a real library with modes and aliases instead of a flat overflow collection.`;
}
