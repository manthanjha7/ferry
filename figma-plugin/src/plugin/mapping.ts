/**
 * Resolve incoming design tokens onto Figma Variables.
 *
 * The naive version of this feature creates a fresh collection every import.
 * That is fine for an empty file and wrong for almost every working designer,
 * who already has a library and does not want a second, parallel set of
 * colour variables to reconcile by hand. So a token is resolved in this order:
 *
 *   1. an existing variable whose name matches (normalised),
 *   2. an existing *local* variable holding the identical value,
 *   3. a newly created variable, if the user allowed that.
 *
 * Value matching is deliberately local-only. Team-library listings expose a
 * variable's key, name and type but not its value, so matching a library by
 * value would mean importing every variable in it just to look — expensive, and
 * it pollutes the file with imports that may not get used.
 */

import type {
  IRColor,
  IRDesignSystem,
  IRShadow,
  IRSurface,
  IRSurfaceValue,
  IRTokenDefinition,
  MappingReport,
  TargetSummary,
  TokenRef,
  VariableTarget,
} from "../ir";

export type VariableRegistry = {
  /** Token path -> the Figma variable it resolved to. */
  byPath: Map<string, Variable>;
  report: MappingReport;
  /**
   * Themes that reached the file as a mode a node can be switched into.
   *
   * Set by `installThemeModes`, from mode (b) and from Map mode's overflow
   * collection alike. Absent when this import has no collection of its own to
   * put modes on: None mode, and Map mode with "create variables for what it
   * does not cover" off, where the only collection in play is the user's, which
   * is read from and never written to.
   *
   * A selector missing from `bySelector` is a theme this file could not hold,
   * and every `TokenRef` carrying it must be left unbound: a Free team allows
   * one mode per collection, and binding a dark layer to the single
   * light-valued variable would render the wrong colour while looking perfectly
   * bound in the layer panel.
   */
  themeModes?: {
    collection: VariableCollection;
    /** Theme selector -> mode id. Points at the default mode for a theme the base mode already holds. */
    bySelector: Map<string, string>;
  };
};

const EMPTY_REPORT: MappingReport = {
  boundByName: 0,
  boundByValue: 0,
  created: 0,
  unmatched: 0,
  samples: [],
};

export function emptyRegistry(): VariableRegistry {
  return { byPath: new Map(), report: { ...EMPTY_REPORT, samples: [] } };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export async function scanTargets(): Promise<TargetSummary> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const local = collections.map((collection) => ({
    id: collection.id,
    name: collection.name,
    variableCount: collection.variableIds.length,
  }));

  let libraries: TargetSummary["libraries"] = [];
  let libraryError: string | undefined;

  try {
    const available =
      await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    libraries = available.map((collection) => ({
      key: collection.key,
      name: collection.name,
      libraryName: collection.libraryName,
    }));
  } catch (error) {
    // Library variables need a plan that supports published libraries. Not
    // having them is a normal state, not a failure.
    libraryError =
      error instanceof Error ? error.message : "Team libraries unavailable";
  }

  return { local, libraries, libraryError };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a design system onto variables, and lead the summary with anything
 * that was already known about it.
 *
 * `notes` are sentences settled BEFORE resolution ran, which today means the
 * batch merge (`mergeDesignSystems`, src/plugin/build.ts). They are prepended
 * rather than pushed because `pushSample`'s eight-line budget is spent one line
 * per matched token, and on the export this was reported against it is full
 * before the tenth token: a sentence about layers that will render the wrong
 * colour outranks "primary → Brand/Primary (name)". Same reasoning as
 * `noOverflowNote`'s call site below, which is placed ahead of the resolution
 * loop for exactly this reason.
 */
export async function resolveVariables(
  system: IRDesignSystem | undefined,
  target: VariableTarget,
  notes: readonly string[] = [],
): Promise<VariableRegistry> {
  const registry = await resolveSystem(system, target);
  // Nothing binds in None mode, so nothing can render a bound colour it does
  // not have, and a warning about it would be a warning about nothing.
  if (notes.length > 0 && target.kind !== "none") {
    registry.report.samples = [...notes, ...registry.report.samples].slice(0, SAMPLE_LIMIT);
  }
  return registry;
}

async function resolveSystem(
  system: IRDesignSystem | undefined,
  target: VariableTarget,
): Promise<VariableRegistry> {
  if (!system || system.tokens.length === 0 || target.kind === "none") {
    return emptyRegistry();
  }

  // Mode (b) is a different job from everything below it: nothing is matched
  // against anything, the export's own system is written out whole.
  if (target.kind === "build") return buildDesignSystem(system, target);

  // The themes this DOCUMENT declares for itself and re-themes something
  // across. Everything conditional below is conditional on this, so an export
  // without an axis of its own behaves exactly as it did before.
  const axis = axisThemeSurfaces(system);
  // The collection the user picked is a source and is never written to, so the
  // only place in this file a second value can live is the overflow collection,
  // and that exists only when they ticked "create variables for what it does
  // not cover".
  const canHoldModes = axis.length > 0 && wantsOverflow(target);

  // A token declared only inside a themed surface (`.acme-deck`) is not part
  // of the base layer and must not be hunted for in the user's design system:
  // a product-surface element can never legally use it. `declaredIn` is absent
  // whenever no manifest was read, which is the base layer by definition.
  //
  // A document's OWN axis is the exception, and skipping it is why Map mode had
  // nothing to map on the export this was reported against. `Portage
  // Panel.dc.html` declares no `:root` at all: its fifteen `--figma-color-*`
  // names exist only as thirty declarations across `.cd2f-theme-light` and
  // `.cd2f-theme-dark`, so `declaredIn` never contains `""` and this filter
  // dropped every token the document's own layers reference. Which surfaces are
  // that axis comes from `IRDesignSystem.axis` rather than from the shape of
  // `declaredIn`, because the same export also declares nine names under
  // `.acme-deck` and `.acme-email` and under no `:root`, and no layer here
  // sits inside either. Admitted only when there is somewhere with modes to put
  // them, because a single-mode home for a two-valued token IS the wrong-colour
  // failure.
  const axisSelectors = new Set(system.axis ?? []);
  const bindable = system.tokens.filter(
    (token) =>
      token.kind !== "STRING" &&
      (isBaseLayer(token) || (canHoldModes && isAxisDeclared(token, axisSelectors))),
  );

  const registry = emptyRegistry();

  // Nowhere for a second value to live, so refs carrying a theme stay literal
  // exactly as they did before. Said out loud, because unsaid it is raw hex in
  // the inspector on layers the user just watched a summary call "mapped".
  //
  // Ahead of the "nothing to do" return below, and deliberately: a document
  // that declares its whole palette under its themes has NO base-layer token at
  // all, so with the tickbox off `bindable` is empty, and the import with
  // nothing to say here is exactly the import that mapped nothing.
  const picked = target.kind === "local" || target.kind === "library";
  if (picked && !wantsOverflow(target) && axis.length > 0) {
    pushSample(registry.report, noOverflowNote(system, axis));
  }

  if (bindable.length === 0) return registry;

  const candidates = await buildCandidateIndex(target);
  const creation = await prepareCreation(system, target);

  // Modes go on the overflow collection BEFORE any value is written: every
  // variable in a collection needs a literal per mode (`createVariable` below)
  // and there is nothing to write into until the modes exist.
  // `buildDesignSystem` orders it the same way, through this same call.
  const themeModes =
    creation && canHoldModes
      ? installThemeModes(
          creation.collection,
          system,
          creation.created,
          registry,
          // Every surface of the axis, not only the re-themed ones. Light and
          // Dark are one axis and a collection holding Dark but not Light reads
          // as half a job, and it is also the shape a later Build import of the
          // same export would find and reconcile against.
          axisSurfaces(system),
        )
      : null;

  // Pass 1: resolve each token to an existing variable or a new one.
  for (const token of bindable) {
    // A token a theme re-themes holds one value per mode; the collection the
    // user picked holds one value full stop. Binding there would render Light's
    // colour on a Dark layer while reading as correctly bound in the layer
    // panel, which is the exact failure `bindableToken` (src/plugin/build.ts)
    // refuses. So a re-themed token skips matching altogether and goes to the
    // collection that has the modes, even when the user's own system has a
    // variable of the same name or the same value.
    //
    // Keeping the match was considered and is not available: one token is ONE
    // entry in `byPath`, so there is no version of this where the light
    // instance maps onto their design system and the dark instance stays
    // correct. Splitting the token in two would be worse than either, because
    // the two halves of one colour would then sit in two collections and a mode
    // switch would move one of them and leave the other behind.
    const themed = !!themeModes && isRethemed(token, themeModes);
    if (!themed && (await resolveToken(token, candidates, registry))) continue;

    if (!creation) {
      registry.report.unmatched++;
      continue;
    }

    const variable = createVariable(token, creation, themeModes);
    if (variable) {
      registry.byPath.set(token.path, variable);
      registry.report.created++;
    } else {
      registry.report.unmatched++;
    }
  }

  // Pass 2: rewire aliases, but only between variables we created ourselves.
  // Repointing someone's existing library variable at another one would be a
  // destructive edit to their design system, not an import.
  //
  // Still the default mode only, even when the collection now has several. An
  // alias is resolved per mode, so writing one into the default mode leaves
  // every other mode holding the literal `createVariable` wrote for it, which
  // is the right colour in that mode. `buildDesignSystem` aliases per mode
  // because it is producing a design system someone will edit; the overflow
  // collection is the part their system does not cover, and turning it into a
  // second aliased library is the presumption `createOverflowNote`
  // (src/ui/token-mode.ts) already declines to make.
  if (creation) {
    const pathByName = new Map(system.tokens.map((t) => [t.name, t.path]));
    for (const token of bindable) {
      if (!token.aliasOf) continue;
      const source = registry.byPath.get(token.path);
      const targetPath = pathByName.get(token.aliasOf);
      const aliasTarget = targetPath ? registry.byPath.get(targetPath) : undefined;

      if (!source || !aliasTarget) continue;
      if (source.id === aliasTarget.id) continue;
      if (source.resolvedType !== aliasTarget.resolvedType) continue;
      if (!creation.createdIds.has(source.id)) continue;

      try {
        source.setValueForMode(
          creation.modeId,
          figma.variables.createVariableAlias(aliasTarget),
        );
      } catch {
        // Alias cycles and cross-collection references are rejected by Figma;
        // the literal value already set stands in.
      }
    }
  }

  return registry;
}

/**
 * Whether this target has a collection of OURS to write into.
 *
 * `local` and `library` with `createMissing` are the overflow collection, which
 * is ours and may therefore carry modes. `create` is deliberately excluded: its
 * contract in src/ir/index.ts is "a flat, single-mode collection", it is not
 * reachable from the panel, and quietly growing modes on it would change what
 * the two scenarios that construct it are testing.
 */
function wantsOverflow(target: VariableTarget): boolean {
  return (target.kind === "local" || target.kind === "library") && target.createMissing;
}

/**
 * A name the document's own theme axis declares, rather than the base layer.
 *
 * Read off `IRDesignSystem.axis` rather than inferred from the shape of
 * `declaredIn`, because the shapes are identical: the real export declares
 * fifteen names under `.cd2f-theme-light` and `.cd2f-theme-dark` with no
 * `:root`, and nine more under `.acme-deck` and `.acme-email` with no
 * `:root`. The first fifteen are what every layer in the document references.
 * The nine belong to product surfaces nothing imported here sits inside, and
 * admitting them would create variables for a document that cannot use them.
 */
function isAxisDeclared(token: IRTokenDefinition, axis: Set<string>): boolean {
  const scopes = token.declaredIn;
  if (!scopes || scopes.includes("")) return false;
  return scopes.some((selector) => axis.has(selector));
}

/**
 * A token one of the modes we actually built holds at a different value.
 *
 * Asked against the BUILT modes rather than against every surface in the
 * system, and that is what keeps the routing as narrow as the problem. Two
 * things fall out of it:
 *
 * A base-layer token that only `.acme-deck` re-themes is not routed. No layer
 * in this import sits under the deck, so no ref against it is ever
 * theme-scoped, and pulling it out of the user's design system would cost them
 * a real match for a mode nothing can be switched into. Measured on the real
 * export: two tokens matched their collection and stopped when this asked the
 * whole surface list instead.
 *
 * On a Free team, where the plan allowed no mode past the base one, nothing is
 * routed at all. There is no second value for this file to hold, so the honest
 * outcome is the one Map mode has always given: match what matches, and let
 * `bindableToken` (src/plugin/build.ts) keep the theme-scoped refs literal.
 *
 * The comparison itself is the one `tokenRef` (src/ui/tokens.ts) makes when it
 * decides whether to stamp a `themeScope` at all, so this set and the set of
 * refusals cannot drift apart. A theme re-declaring a name at the value the
 * base mode already holds is not a re-theme, which is why the light half of a
 * document with no `:root` is not routed: `applySurfaces` gives the base mode
 * the FIRST theme's values, so Light equals base and only Dark differs.
 */
function isRethemed(token: IRTokenDefinition, modes: BuiltMode[]): boolean {
  for (const mode of modes) {
    if (!mode.selector) continue;
    const value = token.bySurface?.[mode.selector];
    if (value && !sameSurfaceValue(value, token)) return true;
  }
  return false;
}

/**
 * The document's own mode axis, when it has one that needs modes to be right.
 *
 * Manifest surfaces are excluded deliberately. `IRNode.themeScope` is set for a
 * detected axis and nothing else (src/ui/extract.ts), so no layer in this
 * import can ever be switched into `.acme-deck`, and giving the overflow
 * collection a Acme Deck column would be two modes of values nothing in the
 * file can reach. A surface the base mode already holds in full is excluded for
 * the same reason it is on the build path: its refs are not theme-scoped, so
 * nothing about it is at risk.
 */
function axisThemeSurfaces(system: IRDesignSystem): IRSurface[] {
  const axis = new Set(system.axis ?? []);
  if (axis.size === 0) return [];
  return (system.surfaces ?? []).filter(
    (surface) => axis.has(surface.selector) && !ridesBaseMode(system, surface.selector),
  );
}

/** Every surface of the document's own axis, re-themed or not. The modes to build. */
function axisSurfaces(system: IRDesignSystem): IRSurface[] {
  const axis = new Set(system.axis ?? []);
  return (system.surfaces ?? []).filter((surface) => axis.has(surface.selector));
}

/**
 * One plain sentence for an axis with nowhere to live.
 *
 * "Create variables for what it does not cover" left off is a legitimate
 * choice, and it is also the choice that leaves half a themed document as raw
 * hex, because the collection the user picked is a source this import will not
 * write to and there is nothing else in the file with a second mode. Saying
 * nothing leaves them to find it by clicking a dark layer and reading the
 * inspector, which is how this was reported in the first place.
 */
function noOverflowNote(system: IRDesignSystem, axis: IRSurface[]): string {
  const affected = rethemedTokenCount(system, axis);
  return (
    `${joinLabels(axis)} re-theme${axis.length === 1 ? "s" : ""} ${affected} of this ` +
    `document's tokens, and the collection you picked is only read from, never ` +
    `written to. With "create variables for what it does not cover" off there is ` +
    `nowhere in this file to hold a second value, so layers under ` +
    `${axis.length === 1 ? "it" : "them"} imported as literals rather than binding ` +
    `to the wrong theme's colours.`
  );
}

type CandidateIndex = {
  byName: Map<string, Variable | LibraryVariableRef>;
  byColor: Map<string, Variable>;
  byFloat: Map<number, Variable>;
};

type LibraryVariableRef = { __libraryKey: string; resolvedType: string };

function isLibraryRef(
  value: Variable | LibraryVariableRef,
): value is LibraryVariableRef {
  return (value as LibraryVariableRef).__libraryKey !== undefined;
}

async function buildCandidateIndex(
  target: VariableTarget,
): Promise<CandidateIndex> {
  const index: CandidateIndex = {
    byName: new Map(),
    byColor: new Map(),
    byFloat: new Map(),
  };

  if (target.kind === "library") {
    try {
      const variables =
        await figma.teamLibrary.getVariablesInLibraryCollectionAsync(
          target.collectionKey,
        );
      for (const variable of variables) {
        for (const key of nameKeys(variable.name)) {
          if (!index.byName.has(key)) {
            index.byName.set(key, {
              __libraryKey: variable.key,
              resolvedType: variable.resolvedType,
            });
          }
        }
      }
    } catch {
      // Fall through with an empty index; everything becomes "create" or
      // "unmatched" depending on the user's choice.
    }
    return index;
  }

  if (target.kind !== "local") return index;

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collection = collections.find((c) => c.id === target.collectionId);
  if (!collection) return index;

  const modeId = collection.defaultModeId;

  for (const id of collection.variableIds) {
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (!variable) continue;

    for (const key of nameKeys(variable.name)) {
      if (!index.byName.has(key)) index.byName.set(key, variable);
    }

    const value = variable.valuesByMode[modeId];
    if (value === undefined || value === null) continue;
    // Aliases point elsewhere; resolving them would need a second lookup and
    // the alias target is itself in this index under its own name.
    if (typeof value === "object" && "type" in value) continue;

    if (variable.resolvedType === "COLOR" && typeof value === "object") {
      const rgba = value as RGBA;
      const key = colorKey({
        r: rgba.r,
        g: rgba.g,
        b: rgba.b,
        a: rgba.a ?? 1,
      });
      if (!index.byColor.has(key)) index.byColor.set(key, variable);
    } else if (variable.resolvedType === "FLOAT" && typeof value === "number") {
      if (!index.byFloat.has(value)) index.byFloat.set(value, variable);
    }
  }

  return index;
}

async function resolveToken(
  token: IRTokenDefinition,
  candidates: CandidateIndex,
  registry: VariableRegistry,
): Promise<boolean> {
  const wanted = token.kind === "COLOR" ? "COLOR" : "FLOAT";

  for (const key of nameKeys(token.path).concat(nameKeys(token.name))) {
    const hit = candidates.byName.get(key);
    if (!hit) continue;

    const variable = isLibraryRef(hit)
      ? hit.resolvedType === wanted
        ? await importLibraryVariable(hit.__libraryKey)
        : null
      : hit.resolvedType === wanted
        ? hit
        : null;

    if (!variable) continue;

    registry.byPath.set(token.path, variable);
    registry.report.boundByName++;
    pushSample(registry.report, `${token.name} → ${variable.name} (name)`);
    return true;
  }

  if (token.kind === "COLOR" && token.color) {
    const variable = candidates.byColor.get(colorKey(token.color));
    if (variable) {
      registry.byPath.set(token.path, variable);
      registry.report.boundByValue++;
      pushSample(registry.report, `${token.name} → ${variable.name} (value)`);
      return true;
    }
  }

  if (token.kind === "FLOAT" && token.float !== undefined) {
    const variable = candidates.byFloat.get(token.float);
    if (variable) {
      registry.byPath.set(token.path, variable);
      registry.report.boundByValue++;
      pushSample(registry.report, `${token.name} → ${variable.name} (value)`);
      return true;
    }
  }

  return false;
}

async function importLibraryVariable(key: string): Promise<Variable | null> {
  try {
    return await figma.variables.importVariableByKeyAsync(key);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Collection identity, shared by both write paths
// ---------------------------------------------------------------------------

/**
 * Plugin-data key stamping a collection as one we built.
 *
 * The whole point of mode (b) is that the collection becomes the designer's:
 * they will rename it, regroup it, and hand-tune values in it. Matching on the
 * name alone would then create a second copy of the same system on the next
 * import, so identity lives in plugin data instead and the name is only the
 * fallback for a collection made before this stamp existed.
 */
const SYSTEM_KEY = "ferry.systemKey";

/**
 * The collection this export's design system already owns, by stamp.
 *
 * The stamp is `_ds_manifest.json`'s `namespace`, and it is one value for the
 * whole export: all three screens of the real Portage export carry
 * "AcmeDesignSystem_3f2a9c". The system's NAME is per document and used to be
 * the SCREEN's name, so mode (a) matched "Portage", then "Portage Panel", then
 * "Portage Panel v1" and made a collection each, holding the same 125
 * variables three times over. Identity first, label second, in both write
 * paths.
 */
function stampedCollection(
  collections: VariableCollection[],
  system: IRDesignSystem,
  excludedId: string | undefined,
): VariableCollection | undefined {
  if (!system.key) return undefined;
  return collections.find(
    (collection) =>
      collection.id !== excludedId &&
      readPluginData(collection, SYSTEM_KEY) === system.key,
  );
}

/**
 * Whether a collection may be claimed by NAME.
 *
 * Two genuinely different design systems can arrive under one label: an export
 * with no manifest and no readable `_ds` folder falls back to "Design tokens",
 * and so does the next one. A collection already stamped with a DIFFERENT
 * namespace is that other system, so the name match has to step over it or one
 * import quietly absorbs another system's variables.
 *
 * Refused only when both sides have a key and the keys disagree. A system with
 * no key carries no evidence of being a different one, and refusing there would
 * split the same design system re-exported without its manifest into a second
 * collection under the same name.
 */
function claimableByName(
  collection: VariableCollection,
  system: IRDesignSystem,
): boolean {
  if (!system.key) return true;
  const stamp = readPluginData(collection, SYSTEM_KEY);
  return stamp === "" || stamp === system.key;
}

/** Create a collection already carrying its identity, so import 2 finds it. */
function createStampedCollection(
  name: string,
  system: IRDesignSystem,
): VariableCollection {
  const collection = figma.variables.createVariableCollection(name);
  if (system.key) writePluginData(collection, SYSTEM_KEY, system.key);
  return collection;
}

type CreationContext = {
  collection: VariableCollection;
  modeId: string;
  existing: Map<string, Variable>;
  createdIds: Set<string>;
  /**
   * This import made the collection, rather than finding it.
   *
   * Read by `reconcileModes`, which renames the default mode to "Product" on a
   * collection it owns from new and never on one a designer has already had in
   * front of them.
   */
  created: boolean;
};

async function prepareCreation(
  system: IRDesignSystem,
  target: VariableTarget,
): Promise<CreationContext | null> {
  const wantsCreation =
    target.kind === "create" ||
    ((target.kind === "local" || target.kind === "library") &&
      target.createMissing);
  if (!wantsCreation) return null;

  const collections = await figma.variables.getLocalVariableCollectionsAsync();

  // Never write into the collection the user pointed us at. They chose it as a
  // source to match against, and adding to it edits their design system rather
  // than importing into the file.
  //
  // Name it after the design system rather than something like "(unmatched)":
  // when the user has no matching library — the common case — this collection
  // holds the whole system, and it should read that way. It also makes repeat
  // imports work properly, since the second import can target this collection
  // and match everything by name instead of duplicating it.
  const targetId = sourceCollectionId(target);
  const preferred =
    target.kind === "create"
      ? target.name || system.name || "Design tokens"
      : system.name || "Design tokens";

  // The stamp before the label, exactly as `resolveSystemCollection` does it.
  // Without this, a user importing an export's screens one at a time gets a
  // collection per screen, because `system.name` differs per document while the
  // system behind it does not.
  const reusable =
    stampedCollection(collections, system, targetId) ??
    collections.find(
      (c) => c.name === preferred && c.id !== targetId && claimableByName(c, system),
    );

  // Only fall back to a suffix when the preferred name is taken by the very
  // collection we must not write into, or by a different design system that
  // happens to share the label.
  const name =
    reusable || !collections.some((c) => c.name === preferred)
      ? preferred
      : `${preferred} (imported)`;

  const found =
    reusable ??
    collections.find(
      (c) => c.name === name && c.id !== targetId && claimableByName(c, system),
    );
  const collection = found ?? createStampedCollection(name, system);

  const existing = new Map<string, Variable>();
  for (const id of collection.variableIds) {
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (variable) existing.set(variable.name, variable);
  }

  return {
    collection,
    modeId: collection.defaultModeId,
    existing,
    createdIds: new Set(),
    created: !found,
  };
}

/**
 * One variable in the overflow collection, holding a value in every mode it has.
 *
 * `modes` is null for the flat collection this has always produced, and is the
 * whole mode list when the document's theme axis reached the collection. Every
 * mode is written, not just the re-themed ones, and that is not tidiness: an
 * unwritten mode holds Figma's type default, so a layer inside the Dark frame
 * bound to a token Dark does NOT re-theme would resolve to transparent black.
 * Adding modes without filling them turns "a few layers show the wrong colour"
 * into "most layers show no colour", which is why `writeEveryMode` on the build
 * path fills them all too.
 */
function createVariable(
  token: IRTokenDefinition,
  ctx: CreationContext,
  modes: BuiltMode[] | null,
): Variable | null {
  const type: VariableResolvedDataType =
    token.kind === "COLOR" ? "COLOR" : "FLOAT";

  let variable = ctx.existing.get(token.path);
  if (variable && variable.resolvedType !== type) return null;

  if (!variable) {
    try {
      variable = figma.variables.createVariable(token.path, ctx.collection, type);
    } catch {
      return null;
    }
    ctx.existing.set(token.path, variable);
  }
  ctx.createdIds.add(variable.id);

  // The base value under the collection's own default mode, which is what a
  // flat collection has always been and stays when there is no axis.
  const cells: Array<{ modeId: string; selector: string | null }> = modes
    ? modes.map((mode) => ({ modeId: mode.modeId, selector: mode.selector }))
    : [{ modeId: ctx.modeId, selector: null }];

  let attempted = false;
  let wrote = false;
  for (const cell of cells) {
    // `literalFor` is the build path's own per-mode lookup: this theme's value
    // where the theme re-themes the name, the base value where it does not,
    // which IS the CSS cascade. Sharing it is what keeps the two write paths
    // from disagreeing about what Dark holds.
    const value = literalFor(token, cell.selector, type);
    if (value === null) continue;
    attempted = true;
    try {
      variable.setValueForMode(cell.modeId, value);
      wrote = true;
    } catch {
      // A mode that refuses the write leaves the others standing. Only a token
      // Figma refused everywhere is a failure, which is the same outcome the
      // single-mode version of this reported before there were modes here.
    }
  }

  return attempted && !wrote ? null : variable;
}

// ---------------------------------------------------------------------------
// Mode (b) — build the export's own design system
// ---------------------------------------------------------------------------

/**
 * Name for the collection's default mode, applied at creation only.
 *
 * "Default" says nothing next to two named themes, and the system's own
 * `tokens/colors.css` calls `:root` "the web app" — the base layer is a
 * surface like the others, it just has no selector. Never renamed on a
 * re-import: a designer who renamed it meant to.
 */
const BASE_MODE_NAME = "Product";

/** One Figma mode, and the surface whose values it carries. `null` is the base layer. */
type BuiltMode = { modeId: string; selector: string | null; label: string };

type BuildTarget = Extract<VariableTarget, { kind: "build" }>;

/**
 * Write the export's design system into the file as a real Figma library.
 *
 * Three passes over one collection, and the order is load-bearing:
 *
 * 1. Primitives, every mode, literal values. Nothing aliases yet.
 * 2. Semantics, every mode, still literal. A semantic that fails to alias in
 *    step 3 is then left holding the right colour rather than an empty cell.
 * 3. Aliases, per mode independently. `--color-bg` can point at a different
 *    primitive in Deck than in Product, and an alias is a *value*, so there is
 *    no collection-level version of this: doing it once for the default mode
 *    leaves the other modes sitting on stale literals, which looks plausible on
 *    canvas and is structurally wrong.
 *
 * Every mode of every variable is written explicitly. The typings do not say
 * whether `addMode` seeds existing variables' values, so assuming it does would
 * leave the deck and email modes empty.
 */
export async function buildDesignSystem(
  system: IRDesignSystem,
  target: BuildTarget,
): Promise<VariableRegistry> {
  const registry = emptyRegistry();
  const report = registry.report;
  report.reused = 0;
  report.aliased = 0;
  report.effectStyles = 0;

  const resolved = await resolveSystemCollection(system, target);
  const collection = resolved.collection;
  const modes = installThemeModes(
    collection,
    system,
    resolved.created,
    registry,
    system.surfaces ?? [],
    target.modes,
  );

  const existing = new Map<string, Variable>();
  for (const id of collection.variableIds) {
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (variable) existing.set(variable.name, variable);
  }

  const buildable = system.tokens
    .filter((token) => buildTypeFor(token, target) !== null)
    .sort((a, b) => buildPathOf(a).localeCompare(buildPathOf(b)));

  const byName = new Map<string, Variable>();
  const ordered = [
    ...buildable.filter((token) => !token.aliasOf),
    ...buildable.filter((token) => !!token.aliasOf),
  ];

  for (const token of ordered) {
    const type = buildTypeFor(token, target)!;
    const fresh = !existing.has(buildPathOf(token));
    const variable = upsertVariable(buildPathOf(token), type, collection, existing, report);
    if (!variable) continue;

    variable.scopes = scopesFor(token, type) as VariableScope[];
    if (!writeEveryMode(variable, token, type, modes, report, fresh)) continue;

    registry.byPath.set(token.path, variable);
    byName.set(token.name, variable);
  }

  aliasEveryMode(ordered, modes, byName, registry);
  await upsertEffectStyles(system, report);

  return registry;
}

/**
 * §5.3: stamp match, then name match, then create.
 *
 * A collection the user pointed the (a) picker at is disqualified at every
 * step, exactly as in `prepareCreation` — see `sourceCollectionId`, which both
 * paths share so the invariant cannot drift apart.
 */
async function resolveSystemCollection(
  system: IRDesignSystem,
  target: BuildTarget,
): Promise<{ collection: VariableCollection; created: boolean }> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const excludedId = sourceCollectionId(target);
  const usable = collections.filter((collection) => collection.id !== excludedId);
  const name = target.name || system.name || "Design tokens";

  const stamped = stampedCollection(usable, system, undefined);
  if (stamped) return { collection: stamped, created: false };

  const named = usable.find(
    (collection) => collection.name === name && claimableByName(collection, system),
  );
  if (named) return { collection: named, created: false };

  return { collection: createStampedCollection(name, system), created: true };
}

/**
 * Give one collection the export's modes, and tell the builder where they are.
 *
 * The single place `VariableRegistry.themeModes` is assigned, and both write
 * paths reach it. That is the whole shape of the bug this exists to close:
 * `themeModes` used to be set inside `buildDesignSystem` alone, so in Map mode
 * it stayed undefined, `bindableToken` (src/plugin/build.ts) refused every ref
 * carrying a `themeScope`, and a user who picked "map onto my design system"
 * got `#B3B3B3`, `#1E1E1E` and `#007BE5` as raw fills: the LIGHT values of
 * `--figma-color-text-tertiary`, `--figma-color-text` and
 * `--figma-color-text-brand`, on the dark panels too. The refusal is correct
 * and stays. What was missing was a home with modes in the mode that has one.
 *
 * `surfaces` is what separates the two callers. Build mode writes the export's
 * whole system, so every themed surface earns a mode. Map mode is filling in
 * what the user's own library does not cover, so it passes the document's axis
 * alone: a Acme Deck column on their overflow collection would hold values no
 * layer in the import can be switched into.
 *
 * `wantModes` is Build mode's "flat collection please" switch, which Map mode
 * has no use for: it only gets here when the axis needs modes.
 */
function installThemeModes(
  collection: VariableCollection,
  system: IRDesignSystem,
  created: boolean,
  registry: VariableRegistry,
  surfaces: IRSurface[],
  wantModes = true,
): BuiltMode[] {
  const reconciled = reconcileModes(
    collection,
    system,
    surfaces,
    wantModes,
    created,
    registry.report,
  );
  registry.report.modes = reconciled.modes.map((mode) => mode.label);
  registry.themeModes = {
    collection,
    bySelector: bindableModes(
      system,
      reconciled.modes,
      reconciled.unbuilt,
      collection.defaultModeId,
    ),
  };
  return reconciled.modes;
}

/**
 * Match modes by name and add the missing ones.
 *
 * By name rather than by index because the designer owns this collection after
 * the first import and may have reordered it. `addMode` is plan-gated — a
 * starter file allows exactly one mode and it throws — so a failure here has to
 * degrade to "everything in the base mode" and say so, not take the import down
 * with it.
 */
function reconcileModes(
  collection: VariableCollection,
  system: IRDesignSystem,
  surfaces: IRSurface[],
  wantModes: boolean,
  created: boolean,
  report: MappingReport,
): { modes: BuiltMode[]; unbuilt: IRSurface[] } {
  const baseId = collection.defaultModeId;
  if (created) {
    try {
      collection.renameMode(baseId, system.baseModeLabel ?? BASE_MODE_NAME);
    } catch {
      // Not worth a word to the user: the mode still works, it is just called
      // whatever Figma called it.
    }
  }
  const baseLabel =
    collection.modes.find((mode) => mode.modeId === baseId)?.name ?? BASE_MODE_NAME;

  const built: BuiltMode[] = [{ modeId: baseId, selector: null, label: baseLabel }];
  // `modes: false` is the user asking for a flat collection, not a refusal, so
  // the surfaces are unbuilt but nothing is capped and nothing is reported.
  if (!wantModes || !surfaces || surfaces.length === 0) {
    return { modes: built, unbuilt: surfaces ?? [] };
  }

  const capped: IRSurface[] = [];

  for (let i = 0; i < surfaces.length; i++) {
    const surface = surfaces[i];
    const match = collection.modes.find((mode) => mode.name === surface.label);
    if (match && !built.some((mode) => mode.modeId === match.modeId)) {
      built.push({ modeId: match.modeId, selector: surface.selector, label: surface.label });
      continue;
    }
    if (match) continue;

    try {
      built.push({
        modeId: collection.addMode(surface.label),
        selector: surface.selector,
        label: surface.label,
      });
    } catch {
      // Plan-gated, and the plan differs per file with no capability query to
      // ask first, so attempting the call and handling the refusal is the only
      // way to find out. Everything from here on is one mode short.
      capped.push(...surfaces.slice(i));
      break;
    }
  }

  if (capped.length > 0) {
    pushSample(report, modeCapNote(system, collection, built, capped));
  }

  return { modes: built, unbuilt: capped };
}

/**
 * One plain sentence about a mode budget that ran out.
 *
 * Figma gates modes per collection on the file's plan, and a Free team allows
 * exactly one, so this is reached by real users on an ordinary first import.
 * What was here before pushed the raw exception into the summary, where it read
 * "in addMode: Limited to 1 modes only", followed by "built Mode 1 only": no
 * theme named, no consequence stated, nothing to do about it. A user reported
 * that line as the plugin being broken, which was the correct reading of it.
 */
function modeCapNote(
  system: IRDesignSystem,
  collection: VariableCollection,
  built: BuiltMode[],
  capped: IRSurface[],
): string {
  const limit = collection.modes.length;
  // A theme the base mode already holds in full is still usable: its layers
  // bind and render correctly, it just has no mode of its own. Saying it was
  // "dropped" would be false, and the value it carries is the one thing a
  // reader needs to know about the mode that WAS built.
  const folded = capped.filter((surface) => ridesBaseMode(system, surface.selector));
  const literal = capped.filter((surface) => !folded.includes(surface));

  const labels = built.map((mode) =>
    mode.selector === null && folded.length > 0
      ? `${mode.label} (holding ${joinLabels(folded)}'s values)`
      : mode.label,
  );

  let note =
    `This file's plan allows only ${limit} variable mode${limit === 1 ? "" : "s"} per ` +
    `collection, so the import built ${labels.join(", ")}.`;

  if (literal.length > 0) {
    const affected = rethemedTokenCount(system, literal);
    note +=
      ` ${joinLabels(literal)} re-theme${literal.length === 1 ? "s" : ""} ${affected} of ` +
      `those tokens, so layers under ${literal.length === 1 ? "it" : "them"} imported as ` +
      `literals rather than binding to the wrong theme's colours.`;
  }

  return note;
}

function joinLabels(surfaces: IRSurface[]): string {
  return joinNames(surfaces.map((surface) => surface.label));
}

/**
 * `["a", "b", "c"]` -> `"a, b and c"`.
 *
 * Exported because `mergeDesignSystems` (src/plugin/build.ts) writes a sentence
 * of the same kind about document names, and two notes in one summary
 * punctuating their lists differently reads as two different features.
 */
export function joinNames(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Distinct tokens at least one of these themes re-themes.
 *
 * A theme re-DECLARING a name at the value the base mode already holds has not
 * re-themed it, and counting it would inflate the number in a sentence whose
 * whole job is to say how much of the document is affected. Same comparison
 * `tokenRef` (src/ui/tokens.ts) makes when it decides whether a ref is
 * theme-scoped at all, so the count and the refusals agree.
 */
function rethemedTokenCount(system: IRDesignSystem, surfaces: IRSurface[]): number {
  let count = 0;
  for (const token of system.tokens) {
    const rethemed = surfaces.some((surface) => {
      const value = token.bySurface?.[surface.selector];
      return !!value && !sameSurfaceValue(value, token);
    });
    if (rethemed) count++;
  }
  return count;
}

/**
 * True when the base mode already holds everything this theme would render.
 *
 * The base mode carries `:root`, and for a name `:root` never declares it
 * carries the first declaring theme's value (`applySurfaces`, src/ui/tokens.ts).
 * A document that declares its whole theme as `.cd2f-theme-light` and
 * `.cd2f-theme-dark` with no `:root` therefore leaves the base mode holding
 * Light exactly, which is what makes seven of fourteen panels still bind on a
 * plan that allows one mode. A theme that overrides even one value `:root` pins
 * fails this and its layers stay literal, which is the honest outcome: there is
 * nowhere in the file for its value to live.
 */
function ridesBaseMode(system: IRDesignSystem, selector: string): boolean {
  for (const token of system.tokens) {
    const value = token.bySurface?.[selector];
    if (!value) continue; // Not re-themed here, so it renders the base value.
    if (!sameSurfaceValue(value, token)) return false;
  }
  return true;
}

/**
 * Two values that would put the same thing in a mode's cell.
 *
 * Exact, not perceptual, and `colorKey` already fixes what "exact" means: it
 * rounds to 8 bits per channel, which is the resolution Figma renders at. Two
 * colours this calls different are two different pixels on screen. A tolerance
 * on top of that would be a threshold nobody can predict, and it would be
 * deciding that a binding may render a colour the document does not have.
 *
 * Exported so `mergeDesignSystems` (src/plugin/build.ts) asks the question
 * about two documents' values with the code that answers it about one
 * document's modes. The comparison and the write have to agree or a batch
 * refuses bindings it should keep, and keeps ones it should refuse.
 */
export function sameSurfaceValue(
  a: IRSurfaceValue,
  b: { resolved: string; color?: IRColor; float?: number; aliasOf?: string },
): boolean {
  if (a.aliasOf !== b.aliasOf) return false;
  if (a.color || b.color) {
    return !!a.color && !!b.color && colorKey(a.color) === colorKey(b.color);
  }
  if (a.float !== undefined || b.float !== undefined) return a.float === b.float;
  return a.resolved === b.resolved;
}

/**
 * Which theme selectors a node may be switched into, and to which mode.
 *
 * A theme with its own mode maps to it. A theme the cap dropped maps to the
 * default mode when, and only when, the default mode already holds its values.
 * Everything else is absent, and absent is what tells the builder to leave the
 * literal alone.
 */
function bindableModes(
  system: IRDesignSystem,
  built: BuiltMode[],
  unbuilt: IRSurface[],
  defaultModeId: string,
): Map<string, string> {
  const bySelector = new Map<string, string>();
  for (const mode of built) {
    if (mode.selector) bySelector.set(mode.selector, mode.modeId);
  }
  for (const surface of unbuilt) {
    if (bySelector.has(surface.selector)) continue;
    if (ridesBaseMode(system, surface.selector)) {
      bySelector.set(surface.selector, defaultModeId);
    }
  }
  return bySelector;
}

/**
 * Create by name, or reuse what is already there.
 *
 * Never `createVariable` for a name already in the collection: both real Figma
 * and the e2e mock throw on a duplicate. Never `remove()` and recreate on a
 * type conflict either — that detaches every binding in the designer's file, so
 * a token whose type has changed is skipped and reported instead.
 */
function upsertVariable(
  buildPath: string,
  type: VariableResolvedDataType,
  collection: VariableCollection,
  existing: Map<string, Variable>,
  report: MappingReport,
): Variable | null {
  const found = existing.get(buildPath);
  if (found) {
    if (found.resolvedType !== type) {
      report.unmatched++;
      pushSample(
        report,
        `${buildPath} is ${found.resolvedType} in this file but ${type} in the export — left alone`,
      );
      return null;
    }
    report.reused = (report.reused ?? 0) + 1;
    return found;
  }

  try {
    const variable = figma.variables.createVariable(buildPath, collection, type);
    existing.set(buildPath, variable);
    report.created++;
    return variable;
  } catch {
    report.unmatched++;
    return null;
  }
}

/**
 * Write one literal per mode, reporting any value this import changed.
 *
 * Overwriting is what makes mode (b) useful as a sync — edit the CSS, import
 * again, the file follows — but it is still an edit to a file someone may have
 * hand-tuned, so a changed value is named rather than silently applied.
 * Returns false when the token has no representable value at all, so the caller
 * can keep it out of the alias pass. `fresh` marks a variable created by this
 * import, which is never reported.
 */
function writeEveryMode(
  variable: Variable,
  token: IRTokenDefinition,
  type: VariableResolvedDataType,
  modes: BuiltMode[],
  report: MappingReport,
  fresh: boolean,
): boolean {
  let wrote = false;
  // A variable this import just created has nothing of the designer's to
  // change. Figma still gives it a placeholder value in the default mode, so
  // comparing against that would report every new variable as changed.
  let reported = fresh;

  for (const mode of modes) {
    const value = literalFor(token, mode.selector, type);
    if (value === null) continue;

    const before = variable.valuesByMode[mode.modeId];
    try {
      variable.setValueForMode(mode.modeId, value);
      wrote = true;
    } catch {
      report.unmatched++;
      continue;
    }

    if (reported || before === undefined || sameValue(before, value)) continue;

    // A semantic token's literal is scaffolding: the alias pass is about to
    // overwrite it, and on a re-import the previous value is the alias, which
    // differs from the literal every single time. Reporting that would put
    // every semantic token in the "changed" list on every import forever, and a
    // change list that is always full is a change list nobody reads.
    if (aliasNameFor(token, mode.selector)) continue;

    pushSample(report, `${variable.name} changed in ${mode.label}`);
    reported = true;
  }

  return wrote;
}

/**
 * Point every semantic variable at its primitive, once per mode.
 *
 * The alias target is looked up through the token's NAME, not its path: a
 * surface-private target carries a group prefix (`deck/color/ink/500`) that the
 * `var(--ink-500)` in the CSS knows nothing about.
 */
function aliasEveryMode(
  tokens: IRTokenDefinition[],
  modes: BuiltMode[],
  byName: Map<string, Variable>,
  registry: VariableRegistry,
): void {
  for (const token of tokens) {
    const source = registry.byPath.get(token.path);
    if (!source) continue;

    for (const mode of modes) {
      const aliasName = aliasNameFor(token, mode.selector);
      if (!aliasName) continue;

      const aliasTarget = byName.get(aliasName);
      if (!aliasTarget) continue;
      if (aliasTarget.id === source.id) continue;
      if (aliasTarget.resolvedType !== source.resolvedType) continue;
      // An alias reaching outside this collection would point at a design
      // system we do not own, which is not what "build me this export's system"
      // asked for.
      if (aliasTarget.variableCollectionId !== source.variableCollectionId) continue;

      try {
        source.setValueForMode(
          mode.modeId,
          figma.variables.createVariableAlias(aliasTarget),
        );
        registry.report.aliased = (registry.report.aliased ?? 0) + 1;
      } catch {
        // Figma rejects alias cycles. The literal written in pass 2 stands.
      }
    }
  }
}

/**
 * What this token aliases *inside one mode*.
 *
 * A surface that declares the name at all decides the answer for its own mode,
 * including deciding that it is a plain literal there: falling through to the
 * base layer's alias in that case would re-point a value the surface
 * deliberately pinned.
 */
function aliasNameFor(
  token: IRTokenDefinition,
  selector: string | null,
): string | undefined {
  if (selector) {
    const surfaceValue = token.bySurface?.[selector];
    if (surfaceValue) return surfaceValue.aliasOf;
  }
  return token.aliasOf;
}

/**
 * The value this token holds in one mode, still in the IR's own vocabulary.
 *
 * One lookup covers all three placements from the placement rule. A token
 * declared in `:root` falls back to its base value in a surface that does not
 * re-theme it, which IS the CSS cascade rather than padding. A surface-private
 * token has its own value at the top level, so every mode gets it. A token
 * shared between surfaces but absent from `:root` gets each surface's own value
 * and, in the base mode, the first declaring surface's.
 *
 * `null` is the base layer. Exported alongside `sameSurfaceValue` so the batch
 * merge compares mode cells the way the two write paths fill them.
 */
export function surfaceValueOf(
  token: IRTokenDefinition,
  selector: string | null,
): IRSurfaceValue {
  return (
    (selector ? token.bySurface?.[selector] : undefined) ?? {
      resolved: token.resolved,
      color: token.color,
      float: token.float,
      aliasOf: token.aliasOf,
    }
  );
}

/** The literal this token holds in one mode, as Figma wants it. */
function literalFor(
  token: IRTokenDefinition,
  selector: string | null,
  type: VariableResolvedDataType,
): VariableValue | null {
  const source = surfaceValueOf(token, selector);

  if (type === "COLOR") {
    if (!source.color) return null;
    return {
      r: source.color.r,
      g: source.color.g,
      b: source.color.b,
      a: source.color.a,
    };
  }

  if (type === "FLOAT") {
    if (source.float !== undefined) return source.float;
    return emToPercent(source.resolved);
  }

  return firstFontFamily(source.resolved);
}

/**
 * Figma type for a token on the build path, or null to skip it.
 *
 * Two deliberate divergences from `IRTokenDefinition.kind`, both build-path
 * only so mode (a) keeps dropping STRING wholesale:
 *
 * - `--tracking-tight: -0.0125em` is a STRING to the classifier (no unit it
 *   recognises) but Figma's letterSpacing is a percentage, so it becomes the
 *   FLOAT -1.25 here and is bindable.
 * - Everything else STRING-typed, font families included, is off unless asked
 *   for. A STRING variable binds to nothing but a font family, so emitting the
 *   durations and keywords by default is noise in someone's variable panel.
 */
function buildTypeFor(
  token: IRTokenDefinition,
  target: BuildTarget,
): VariableResolvedDataType | null {
  if (token.kind === "COLOR") return "COLOR";
  if (token.kind === "FLOAT") return "FLOAT";
  if (token.category === "font" && emToPercent(token.resolved) !== null) return "FLOAT";
  return target.strings ? "STRING" : null;
}

/**
 * Which controls Figma offers this variable in.
 *
 * The point is not tidiness. A radius and a spacing step are both FLOAT and
 * routinely hold the same number, so an unscoped variable panel offers
 * `space/4` for a corner radius and someone takes it.
 */
function scopesFor(
  token: IRTokenDefinition,
  type: VariableResolvedDataType,
): string[] {
  switch (token.category) {
    case "color":
      return ["ALL_FILLS", "STROKE_COLOR", "EFFECT_COLOR"];
    case "radius":
      return ["CORNER_RADIUS"];
    case "spacing":
      return ["GAP", "WIDTH_HEIGHT"];
    case "font": {
      const path = token.buildPath ?? "";
      if (path.includes("/size/")) return ["FONT_SIZE"];
      if (path.includes("/tracking/")) return ["LETTER_SPACING"];
      if (path.includes("/family/")) return ["FONT_FAMILY"];
      if (path.includes("/weight/")) return ["FONT_WEIGHT"];
      // A unitless `--leading-tight: 1.2` is a ratio, and Figma would read it
      // as 1.2 pixels. Offering it nowhere is better than offering a line
      // height that collapses every paragraph; multiplying it by a font size we
      // would have to guess is worse than both.
      if (path.includes("/leading/")) {
        return /^-?\d*\.?\d+(px|rem)$/.test(token.resolved.trim()) ? ["LINE_HEIGHT"] : [];
      }
      return [];
    }
    default:
      return type === "COLOR" ? ["ALL_FILLS"] : [];
  }
}

/**
 * Shadow tokens become EffectStyles, because Figma has no shadow-typed
 * variable and `--shadow-md` is a list of two drop shadows besides.
 *
 * Without this they are dropped by the classifier for containing a paren and
 * the user is told nothing, which for a system whose elevation scale is
 * fifteen tokens deep is most of its visual identity going missing.
 */
async function upsertEffectStyles(
  system: IRDesignSystem,
  report: MappingReport,
): Promise<void> {
  const shadows = system.shadows ?? [];
  if (shadows.length === 0) return;

  let styles: EffectStyle[];
  try {
    styles = await figma.getLocalEffectStylesAsync();
  } catch {
    // Older API surface or a file that refuses the read; the variables are
    // already in and are the larger half of the system.
    return;
  }

  const byName = new Map(styles.map((style) => [style.name, style]));

  for (const shadow of shadows) {
    try {
      let style = byName.get(shadow.buildPath);
      if (!style) {
        style = figma.createEffectStyle();
        style.name = shadow.buildPath;
        byName.set(shadow.buildPath, style);
      }
      style.effects = shadow.layers.map(toShadowEffect);
      report.effectStyles = (report.effectStyles ?? 0) + 1;
    } catch {
      pushSample(report, `${shadow.buildPath} could not be created as an effect style`);
    }
  }
}

/**
 * A twin of `toFigmaEffect` in src/plugin/build.ts, which cannot be imported
 * from here: build.ts already imports this module.
 *
 * `showShadowBehindNode` is off because CSS has no equivalent and Figma's
 * default is on, so leaving it alone makes every imported shadow render wider
 * than the one in the browser.
 */
function toShadowEffect(shadow: IRShadow): Effect {
  return {
    type: shadow.type,
    color: {
      r: shadow.color.r,
      g: shadow.color.g,
      b: shadow.color.b,
      a: shadow.color.a,
    },
    offset: { x: shadow.offsetX, y: shadow.offsetY },
    radius: shadow.blur,
    spread: shadow.spread,
    visible: true,
    blendMode: "NORMAL",
    showShadowBehindNode: false,
  } as Effect;
}

/** `"Inter", "Inter Variable", ui-sans-serif` -> `Inter`. Figma's fontFamily takes one family. */
function firstFontFamily(value: string): string {
  const first = value.split(",")[0].trim();
  return first.replace(/^["']|["']$/g, "") || value.trim();
}

/** `-0.0125em` -> `-1.25`, the percentage Figma's letterSpacing wants. */
function emToPercent(value: string): number | null {
  const match = value.trim().match(/^(-?\d*\.?\d+)em$/);
  if (!match) return null;
  const parsed = parseFloat(match[1]);
  return Number.isNaN(parsed) ? null : parsed * 100;
}

function buildPathOf(token: IRTokenDefinition): string {
  return token.buildPath ?? token.path;
}

/**
 * True for a token the base (`:root`) layer declares.
 *
 * Absent `declaredIn` means no manifest was read, in which case everything in
 * the index came off `:root` by construction (`collectFromRules`,
 * src/ui/tokens.ts, lifts nothing else).
 */
function isBaseLayer(token: IRTokenDefinition): boolean {
  return !token.declaredIn || token.declaredIn.includes("");
}

/**
 * The collection the user picked as a source to match against, which no path
 * may ever write into. They chose it to compare with; adding to it edits their
 * design system instead of importing into the file.
 */
function sourceCollectionId(target: VariableTarget): string | undefined {
  return target.kind === "local" ? target.collectionId : undefined;
}

function readPluginData(collection: VariableCollection, key: string): string {
  try {
    return collection.getPluginData(key);
  } catch {
    return "";
  }
}

function writePluginData(
  collection: VariableCollection,
  key: string,
  value: string,
): void {
  try {
    collection.setPluginData(key, value);
  } catch {
    // Without the stamp a re-import falls back to matching by name, which is
    // the pre-stamp behaviour rather than a duplicate collection.
  }
}

/**
 * Whether a stored value is the one about to be written. Figma keeps numbers
 * and colour channels as 32-bit floats, so 250/255 reads back as
 * 0.9803921580314636: compared exactly, every colour "changed" on every
 * re-import. Colours match within half a step of 8-bit colour.
 */
function sameValue(a: VariableValue, b: VariableValue): boolean {
  const close = (x: number, y: number, eps: number) => Math.abs(x - y) <= eps;
  if (typeof a === "number" && typeof b === "number") return close(a, b, 1e-5 * Math.max(1, Math.abs(b)));
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return a === b;
  }
  if ("r" in a && "r" in b) {
    const ca = a as RGBA;
    const cb = b as RGBA;
    const eps = 0.5 / 255;
    return close(ca.r, cb.r, eps) && close(ca.g, cb.g, eps) && close(ca.b, cb.b, eps) && close(ca.a ?? 1, cb.a ?? 1, 1e-3);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

export function bindPaint(
  paint: SolidPaint,
  token: TokenRef | undefined,
  registry: VariableRegistry,
): Paint {
  if (!token) return paint;
  const variable = registry.byPath.get(token.path);
  if (!variable || variable.resolvedType !== "COLOR") return paint;

  try {
    return figma.variables.setBoundVariableForPaint(paint, "color", variable);
  } catch {
    return paint;
  }
}

export function bindField(
  node: SceneNode,
  field: VariableBindableNodeField,
  token: TokenRef | undefined,
  registry: VariableRegistry,
): void {
  if (!token) return;
  const variable = registry.byPath.get(token.path);
  if (!variable || variable.resolvedType !== "FLOAT") return;

  try {
    (node as unknown as {
      setBoundVariable: (f: string, v: Variable) => void;
    }).setBoundVariable(field, variable);
  } catch {
    // Not bindable on this node type; the literal already set stands in.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Name keys a token can be recognised by.
 *
 * Design systems disagree about separators and grouping — `acme-green-700`,
 * `color/acme-green/700` and `Acme Green/700` are the same token to a human.
 * Comparing on alphanumerics only, both with the group prefix and on the leaf
 * alone, matches those without matching things that merely look similar.
 */
function nameKeys(name: string): string[] {
  const flat = normalize(name);
  const leaf = normalize(name.split("/").pop() ?? name);
  if (flat === leaf) return [flat];

  // A leaf is only an identity if it is distinctive. Ramp steps are not:
  // `color/acme-green/700` and `Neutral/700` share the leaf "700", and
  // matching on it would bind a brand green to a neutral grey — silently, and
  // in the user's own design system. Short leaves ("bg", "fg") collide the
  // same way, so only leaves with some substance are worth a key.
  if (/^\d+$/.test(leaf) || leaf.length < 4) return [flat];

  return [flat, leaf];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function colorKey(c: IRColor): string {
  return `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(
    c.b * 255,
  )},${c.a.toFixed(3)}`;
}

/** How many lines the summary will carry before it stops being read. */
const SAMPLE_LIMIT = 8;

function pushSample(report: MappingReport, line: string): void {
  if (report.samples.length < SAMPLE_LIMIT) report.samples.push(line);
}
