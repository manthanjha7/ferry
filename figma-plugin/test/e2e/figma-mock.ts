/**
 * In-memory simulator of the Figma plugin API.
 *
 * Real plugin code (src/plugin/*.ts) talks to a single ambient `figma`
 * global with no way to construct or reset it outside the Figma desktop
 * app. This file rebuilds enough of that surface — as plain objects backed
 * by a Proxy that enforces the same invariants Figma enforces at runtime —
 * so the actual plugin code can run against it under Node, unmodified.
 *
 * The point is not full fidelity everywhere; it is throwing on the same
 * things real Figma throws on (unloaded fonts, invalid ranges, illegal
 * layout-sizing combinations, duplicate variable names, mistyped variable
 * bindings, writes to removed nodes, non-positive resizes). Getting those
 * wrong silently is exactly the class of bug this mock exists to catch.
 *
 * Usage:
 *   const mock = createFigmaMock();
 *   (globalThis as any).figma = mock.figma;
 *   await import("../../src/plugin/main");
 *   ...
 *   mock.serializeTree(mock.getRootNodes()[0]);
 */

// This package has no @types/node, and this file is intentionally excluded
// from tsconfig.json's `include` (it is test infrastructure, not plugin
// code), so the ambient Node globals it uses get a minimal local shape
// instead of a real devDependency.
declare const Buffer: {
  from(data: string | Uint8Array, encoding?: string): { toString(encoding: string): string } & Uint8Array;
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MockFontSpec = { family: string; style: string };

export type MockLibraryVariableSpec = {
  key: string;
  name: string;
  resolvedType: string;
};

export type MockLibraryCollectionSpec = {
  key: string;
  name: string;
  libraryName: string;
  variables: MockLibraryVariableSpec[];
};

export type MockOptions = {
  availableFonts?: MockFontSpec[];
  teamLibraryAvailable?: boolean;
  libraryCollections?: MockLibraryCollectionSpec[];
  /**
   * Highest number of modes a collection may hold before `addMode` throws.
   *
   * Real Figma gates modes on the file's plan and throws
   * "in addMode: Limited to N modes only" (plugin-api.d.ts). A starter file
   * allows exactly one, so a plugin that builds a themed collection has to
   * degrade rather than abort, and that path is unreachable without this.
   */
  modeLimit?: number;
  /**
   * Fonts that are listed as available but refuse to load, which real Figma
   * does for a shared file whose owner's fonts this machine does not have.
   */
  unloadableFonts?: MockFontSpec[];
};

export type MockNotification = { message: string; error: boolean };

export type FigmaMock = {
  /** Assign to globalThis.figma before importing plugin code. */
  figma: any;
  /** Every node directly appended to figma.currentPage. */
  getRootNodes: () => any[];
  /** Deep, plain-JSON snapshot of a node and its descendants. */
  serializeTree: (node: any) => any;
  /** All variable collections created during the run (local + synthetic library). */
  getCollections: () => VariableCollectionSummary[];
  /** All variables created/imported during the run (local + synthetic library). */
  getVariables: () => VariableSummary[];
  /** Every EffectStyle in the file, in creation order. */
  getEffectStyles: () => EffectStyleSummary[];
  /**
   * The page's prototype flow starting points, in order.
   *
   * Exposed rather than read off `figma.currentPage` so an assertion about the
   * one destructive failure here, an import replacing the designer's existing
   * flows instead of appending to its own, reads the same list the setter
   * validated.
   */
  getFlowStartingPoints: () => Array<{ nodeId: string; name: string }>;
  /** Every call to figma.notify(), in order. */
  notifications: MockNotification[];
  /** Number of figma.commitUndo() calls. */
  readonly undoCommits: number;
};

export type VariableCollectionSummary = {
  id: string;
  key: string;
  name: string;
  remote: boolean;
  defaultModeId: string;
  modes: Array<{ modeId: string; name: string }>;
  variableIds: string[];
  pluginData: Record<string, string>;
};

export type EffectStyleSummary = {
  id: string;
  name: string;
  effects: Effect[];
};

export type VariableSummary = {
  id: string;
  key: string;
  name: string;
  resolvedType: VariableResolvedDataType;
  remote: boolean;
  variableCollectionId: string;
  valuesByMode: Record<string, VariableValue>;
  scopes: string[];
};

// ---------------------------------------------------------------------------
// Local type aliases (mirrors of the bits of @figma/plugin-typings we touch)
// ---------------------------------------------------------------------------

type RGB = { r: number; g: number; b: number };
type RGBA = RGB & { a: number };
type FontName = { family: string; style: string };
type VariableAlias = { type: "VARIABLE_ALIAS"; id: string };
type VariableResolvedDataType = "BOOLEAN" | "COLOR" | "FLOAT" | "STRING";
type VariableValue = boolean | string | number | RGB | RGBA | VariableAlias;

type SolidPaint = {
  type: "SOLID";
  color: RGB;
  opacity?: number;
  visible?: boolean;
  boundVariables?: Record<string, VariableAlias>;
};
type Paint = SolidPaint | Record<string, any>;
type Effect = Record<string, any>;

type LineHeight = { value: number; unit: "PIXELS" | "PERCENT" } | { unit: "AUTO" };
type LetterSpacing = { value: number; unit: "PIXELS" | "PERCENT" };
type TextCase = "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED";
type TextDecoration = "NONE" | "UNDERLINE" | "STRIKETHROUGH";
type HyperlinkTarget = { type: "URL" | "NODE"; value: string };

type LayoutSizing = "FIXED" | "HUG" | "FILL";

type Trigger = { type: string; [key: string]: unknown };
type Action = { type: string; [key: string]: unknown };
type Reaction = { trigger?: Trigger | null; action?: Action; actions?: Action[] };

// ---------------------------------------------------------------------------
// Default fonts
//
// Deliberately excludes "DM Sans", "Red Hat Display" and "Geist Mono" so
// font substitution in src/plugin/fonts.ts actually gets exercised. Inter's
// regular-weight italic is named plain "Italic" (not "Regular Italic"),
// matching how Figma really ships it and matching the fallback branch
// fonts.ts's pickStyle() takes for exactly that case.
// ---------------------------------------------------------------------------

const INTER_WEIGHTS = ["Thin", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Black"];

const DEFAULT_AVAILABLE_FONTS: MockFontSpec[] = [];
for (const style of INTER_WEIGHTS) {
  DEFAULT_AVAILABLE_FONTS.push({ family: "Inter", style });
  DEFAULT_AVAILABLE_FONTS.push({
    family: "Inter",
    style: style === "Regular" ? "Italic" : `${style} Italic`,
  });
}
DEFAULT_AVAILABLE_FONTS.push(
  { family: "Roboto", style: "Regular" },
  { family: "Roboto", style: "Medium" },
  { family: "Roboto", style: "Bold" },
  { family: "Roboto", style: "Italic" },
  { family: "Roboto Mono", style: "Regular" },
  { family: "Roboto Mono", style: "Medium" },
  { family: "Roboto Mono", style: "Bold" },
);

// ---------------------------------------------------------------------------
// Generic helpers (no per-mock state)
// ---------------------------------------------------------------------------

function fontKey(font: FontName): string {
  return `${font.family}::${font.style}`;
}

function deepClone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function assertAlive(node: { removed: boolean; name: string }): void {
  if (node.removed) {
    throw new Error(`Cannot modify node "${node.name}": it has been removed from the document.`);
  }
}

function validateSizing(node: { type: string; name: string; parent: any; layoutMode?: string }, value: LayoutSizing): void {
  if (value === "FILL") {
    const parent = node.parent;
    const parentLayoutMode = parent ? parent.layoutMode : undefined;
    if (!parent || (parentLayoutMode !== "HORIZONTAL" && parentLayoutMode !== "VERTICAL")) {
      throw new Error(
        `Cannot set layoutSizing to "FILL" on "${node.name}": its parent must be an auto-layout frame ` +
          `(layoutMode HORIZONTAL or VERTICAL), got ${parent ? `layoutMode "${parentLayoutMode}"` : "no parent"}.`,
      );
    }
    return;
  }

  if (value === "HUG") {
    const isTextHug = node.type === "TEXT";
    const isFrameHug = node.type === "FRAME" && node.layoutMode !== "NONE";
    if (!isTextHug && !isFrameHug) {
      throw new Error(
        `Cannot set layoutSizing to "HUG" on "${node.name}" (${node.type}): only TEXT nodes or ` +
          `auto-layout FRAMEs (layoutMode !== "NONE") support HUG.`,
      );
    }
    return;
  }

  if (value !== "FIXED") {
    throw new Error(`Invalid layout sizing value: "${value}"`);
  }
}

/**
 * Figma Help, "Organize your canvas with sections": a section "can contain all
 * layer types, including other sections, but cannot be contained within frames
 * or groups". That constraint is the whole reason a section is usable for
 * grouping a prototype at all, because every frame inside one stays top-level,
 * so violating it has to fail here rather than produce a plausible-looking tree.
 */
function assertNotSection(parent: { name: string; type: string }, child: { type: string }): void {
  if (child.type === "SECTION") {
    throw new Error(
      `Cannot append a SECTION to "${parent.name}" (${parent.type}): sections cannot be contained within ` +
        `frames or groups.`,
    );
  }
}

function defaultWhiteFill(): SolidPaint {
  return { type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1 };
}

function defaultBlackFill(): SolidPaint {
  return { type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 };
}

function defaultGrayFill(): SolidPaint {
  return { type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 }, opacity: 1 };
}

function validateValueForType(type: VariableResolvedDataType, value: VariableValue, varName: string): void {
  if (value !== null && typeof value === "object" && (value as any).type === "VARIABLE_ALIAS") {
    if (typeof (value as any).id !== "string") {
      throw new Error(`setValueForMode: invalid VARIABLE_ALIAS value for variable "${varName}"`);
    }
    return;
  }

  if (type === "COLOR") {
    const ok =
      value !== null &&
      typeof value === "object" &&
      typeof (value as any).r === "number" &&
      typeof (value as any).g === "number" &&
      typeof (value as any).b === "number";
    if (!ok) {
      throw new Error(
        `setValueForMode: variable "${varName}" is COLOR but the value is not an {r, g, b, a} object.`,
      );
    }
  } else if (type === "FLOAT") {
    if (typeof value !== "number") {
      throw new Error(`setValueForMode: variable "${varName}" is FLOAT but the value is not a number.`);
    }
  } else if (type === "STRING") {
    if (typeof value !== "string") {
      throw new Error(`setValueForMode: variable "${varName}" is STRING but the value is not a string.`);
    }
  } else if (type === "BOOLEAN") {
    if (typeof value !== "boolean") {
      throw new Error(`setValueForMode: variable "${varName}" is BOOLEAN but the value is not a boolean.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFigmaMock(options: MockOptions = {}): FigmaMock {
  const availableFontsList = options.availableFonts ?? DEFAULT_AVAILABLE_FONTS;
  const teamLibraryAvailable = options.teamLibraryAvailable ?? false;
  const libraryCollectionsInput = options.libraryCollections ?? [];
  const modeLimit = options.modeLimit;
  const unloadableFonts = options.unloadableFonts ?? [];

  let idCounter = 0;
  const genId = (prefix: string): string => `${prefix}-${++idCounter}`;

  const loadedFonts = new Set<string>();
  const notifications: MockNotification[] = [];
  let undoCommitsCount = 0;

  const isFontLoaded = (font: FontName): boolean => loadedFonts.has(fontKey(font));

  function assertFontLoadedForCharacters(node: TextNodeImpl): void {
    if (!isFontLoaded(node._fontName)) {
      throw new Error(
        `Cannot set characters on "${node.name}": font "${node._fontName.family} ${node._fontName.style}" ` +
          `has not been loaded. Call figma.loadFontAsync() first.`,
      );
    }
  }

  function validateRange(node: TextNodeImpl, start: number, end: number): void {
    if (start < 0) {
      throw new Error(`Invalid range on "${node.name}": start (${start}) must be >= 0.`);
    }
    if (end > node._characters.length) {
      throw new Error(
        `Invalid range on "${node.name}": end (${end}) exceeds characters.length (${node._characters.length}).`,
      );
    }
    if (start >= end) {
      throw new Error(`Invalid range on "${node.name}": start (${start}) must be less than end (${end}).`);
    }
  }

  function assertRangeFontsLoaded(node: TextNodeImpl, start: number, end: number): void {
    for (let i = start; i < end; i++) {
      const font = node._charFonts[i];
      if (!font || !isFontLoaded(font)) {
        throw new Error(
          `Cannot style range [${start}, ${end}) on "${node.name}": character ${i} uses font ` +
            `"${font ? `${font.family} ${font.style}` : "unknown"}" which is not loaded.`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Node classes
  // -------------------------------------------------------------------------

  /**
   * Every live node, by id.
   *
   * A prototype reaction names its destination by id string, and Figma
   * validates that id when the reaction is set: an unresolvable or illegally
   * parented destination is refused there, not at present time. Without a
   * registry the mock would accept any string at all, and the one failure that
   * matters (a NAVIGATE destination that is not a top-level frame) would look
   * exactly like a working prototype right up until a designer pressed play.
   */
  const nodesById = new Map<string, any>();

  /**
   * Wraps a node instance so any property write after `.remove()` throws,
   * mirroring Figma's behaviour for detached nodes. Method calls guard
   * themselves explicitly via assertAlive(); this catches plain field writes
   * (`node.x = 10`) that would otherwise silently succeed on a dead node.
   *
   * Lives inside the factory because it re-registers the proxy under the
   * instance's id: `getNodeByIdAsync` has to hand back the object the caller is
   * actually holding, or an identity comparison against a node from
   * `createFrame` fails for a reason that has nothing to do with the document.
   */
  function guard<T extends { removed: boolean; name: string; id: string }>(instance: T): T {
    const proxy = new Proxy(instance, {
      set(target, prop, value) {
        if (target.removed) {
          throw new Error(
            `Cannot set property "${String(prop)}" on "${target.name}": node has been removed from the document.`,
          );
        }
        return Reflect.set(target, prop, value);
      },
    });
    nodesById.set(instance.id, proxy);
    return proxy;
  }

  /**
   * A live node parented straight to the page, or into a section on it.
   *
   * Figma refuses a NAVIGATE destination that is not a top-level frame: the
   * destination has to be "a frame that is added directly to the canvas" and
   * not an object within a frame (Figma Help, "Connect your prototype"), which
   * is what forces a state matrix to be fourteen siblings rather than fourteen
   * children of one wrapper.
   *
   * The SECTION half is the one rule here NOT verified against a real Design
   * file. Figma Help says sections "help connect flows across different
   * portions of your design" and that they cannot live inside frames, but no
   * documentation states that a frame inside a section is still a valid flow
   * starting point or NAVIGATE destination. That gap is why the section path in
   * src/plugin/build.ts ships off by default; see the manual check written up
   * alongside this step before turning it on.
   */
  function isTopLevel(node: any): boolean {
    if (!node || node.removed) return false;
    if (node.parent === currentPage) return true;
    return node.parent?.type === "SECTION" && node.parent.parent === currentPage;
  }

  /**
   * PluginDataMixin, which Figma puts on nodes, collections and variables
   * alike. Returns "" for a key that was never set, per the typings.
   *
   * Declared here rather than beside the variable classes because `class A
   * extends B` evaluates B at A's definition, and NodeBase is defined first.
   */
  class PluginDataStore {
    readonly _pluginData = new Map<string, string>();

    getPluginData(key: string): string {
      return this._pluginData.get(key) ?? "";
    }

    setPluginData(key: string, value: string): void {
      if (value === "") this._pluginData.delete(key);
      else this._pluginData.set(key, value);
    }

    getPluginDataKeys(): string[] {
      return [...this._pluginData.keys()];
    }
  }

  abstract class NodeBase extends PluginDataStore {
    readonly id: string;
    readonly type: string;
    name: string;
    x = 0;
    y = 0;
    // AutoLayoutChildrenMixin. ABSOLUTE takes a child out of its parent's flow
    // and back onto its own x/y — how the synthesised select chevron overlays
    // the field's arrow band without stacking under the option text.
    layoutPositioning: "AUTO" | "ABSOLUTE" = "AUTO";
    protected _width = 100;
    protected _height = 100;
    rotation = 0;
    opacity = 1;
    visible = true;
    locked = false;
    effects: Effect[] = [];
    parent: any = null;
    removed = false;
    boundVariables: Record<string, VariableAlias> = {};
    private _layoutSizingHorizontal: LayoutSizing = "FIXED";
    private _layoutSizingVertical: LayoutSizing = "FIXED";

    constructor(type: string, name: string) {
      super();
      this.type = type;
      this.name = name;
      this.id = genId(type);
      // `guard()` overwrites this with the proxy for anything created through
      // the figma.* factories. Registering here as well means a node built
      // directly by a test is still resolvable by id.
      nodesById.set(this.id, this);
    }

    get width(): number {
      return this._width;
    }

    get height(): number {
      return this._height;
    }

    resize(w: number, h: number): void {
      assertAlive(this);
      if (!(w > 0) || !(h > 0)) {
        throw new Error(`Cannot resize "${this.name}" to (${w}, ${h}): width and height must both be positive.`);
      }
      this._width = w;
      this._height = h;
    }

    get layoutSizingHorizontal(): LayoutSizing {
      return this._layoutSizingHorizontal;
    }

    set layoutSizingHorizontal(value: LayoutSizing) {
      assertAlive(this);
      validateSizing(this as any, value);
      this._layoutSizingHorizontal = value;
    }

    get layoutSizingVertical(): LayoutSizing {
      return this._layoutSizingVertical;
    }

    set layoutSizingVertical(value: LayoutSizing) {
      assertAlive(this);
      validateSizing(this as any, value);
      this._layoutSizingVertical = value;
    }

    /**
     * The mode this node resolves its variables in, per collection.
     *
     * `SceneNodeMixin extends ExplicitVariableModesMixin` in
     * @figma/plugin-typings, so every scene node has this and a plugin can
     * switch a whole subtree into a theme. Without it here, a build that binds
     * a dark panel and a light panel to one variable is indistinguishable from
     * one that binds them both to the light value: the layer trees are
     * identical, and only the mode decides which colour renders.
     */
    explicitVariableModes: Record<string, string> = {};

    setExplicitVariableModeForCollection(collection: any, modeId: string): void {
      assertAlive(this);
      if (typeof collection === "string") {
        // The id overload is deprecated and throws under
        // `"documentAccess": "dynamic-page"`, which manifest.json declares.
        throw new Error(
          "setExplicitVariableModeForCollection: passing a collection id is not " +
            'supported with documentAccess: "dynamic-page". Pass the collection.',
        );
      }
      if (!collection || !Array.isArray(collection.modes)) {
        throw new Error("setExplicitVariableModeForCollection: expected a VariableCollection.");
      }
      if (!collection.modes.some((mode: any) => mode.modeId === modeId)) {
        throw new Error(
          `setExplicitVariableModeForCollection: "${modeId}" is not a mode of "${collection.name}".`,
        );
      }
      this.explicitVariableModes = {
        ...this.explicitVariableModes,
        [collection.id]: modeId,
      };
    }

    clearExplicitVariableModeForCollection(collection: any): void {
      assertAlive(this);
      const next = { ...this.explicitVariableModes };
      delete next[collection.id];
      this.explicitVariableModes = next;
    }

    remove(): void {
      assertAlive(this);
      if (this.parent) {
        this.parent.removeChildInternal(this);
        this.parent = null;
      }
      this.removed = true;
      nodesById.delete(this.id);
    }
  }

  class FrameNodeImpl extends NodeBase {
    children: any[] = [];
    clipsContent = false;
    fills: Paint[] = [defaultWhiteFill()];
    strokes: Paint[] = [];
    strokeWeight = 1;
    strokeTopWeight = 1;
    strokeRightWeight = 1;
    strokeBottomWeight = 1;
    strokeLeftWeight = 1;
    strokeAlign: "INSIDE" | "OUTSIDE" | "CENTER" = "INSIDE";
    dashPattern: number[] = [];
    topLeftRadius = 0;
    topRightRadius = 0;
    bottomRightRadius = 0;
    bottomLeftRadius = 0;
    layoutMode: "NONE" | "HORIZONTAL" | "VERTICAL" = "NONE";
    layoutWrap: "NO_WRAP" | "WRAP" = "NO_WRAP";
    itemSpacing = 0;
    counterAxisSpacing = 0;
    paddingTop = 0;
    paddingRight = 0;
    paddingBottom = 0;
    paddingLeft = 0;
    primaryAxisAlignItems: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" = "MIN";
    counterAxisAlignItems: "MIN" | "CENTER" | "MAX" | "BASELINE" = "MIN";
    primaryAxisSizingMode: "FIXED" | "AUTO" = "AUTO";
    counterAxisSizingMode: "FIXED" | "AUTO" = "AUTO";

    private _reactions: Reaction[] = [];

    constructor(name = "Frame") {
      super("FRAME", name);
    }

    appendChild(child: any): void {
      assertAlive(this);
      assertNotSection(this, child);
      if (child.parent) child.parent.removeChildInternal(child);
      child.parent = this;
      this.children.push(child);
    }

    insertChild(index: number, child: any): void {
      assertAlive(this);
      assertNotSection(this, child);
      if (child.parent) child.parent.removeChildInternal(child);
      child.parent = this;
      this.children.splice(index, 0, child);
    }

    removeChildInternal(child: any): void {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
    }

    get reactions(): ReadonlyArray<Reaction> {
      return Object.freeze(deepClone(this._reactions));
    }

    set reactions(_value: ReadonlyArray<Reaction>) {
      // manifest.json declares "documentAccess": "dynamic-page", under which
      // plugin-api.d.ts states `reactions` is read-only. A plugin that assigns
      // it fails in the editor and nowhere else, so it fails here too.
      throw new Error(
        `Cannot assign reactions on "${this.name}": the manifest declares documentAccess "dynamic-page", ` +
          `which makes reactions read-only. Use setReactionsAsync().`,
      );
    }

    /**
     * The only write path for prototype wiring, and the only place the
     * destination rules are enforced.
     *
     * REPLACES the node's whole reaction list, exactly as Figma does. That is
     * why a caller with several outgoing edges from one frame has to batch them
     * into a single call: one call per edge leaves only the last one, on a
     * canvas that looks fully wired.
     */
    async setReactionsAsync(reactions: Reaction[]): Promise<void> {
      assertAlive(this);
      if (!Array.isArray(reactions)) {
        throw new Error(`setReactionsAsync on "${this.name}": expected an array of reactions.`);
      }

      for (const reaction of reactions) {
        if (!reaction || typeof reaction !== "object") {
          throw new Error(`setReactionsAsync on "${this.name}": every reaction must be an object.`);
        }
        if (!reaction.trigger || typeof reaction.trigger.type !== "string") {
          throw new Error(
            `setReactionsAsync on "${this.name}": every reaction needs a trigger with a string type.`,
          );
        }
        // `action` singular is deprecated in @figma/plugin-typings 1.131.0.
        // Refusing it here stops a plugin shipping the form that is on its way
        // out while both still happen to work.
        if (reaction.action !== undefined) {
          throw new Error(
            `setReactionsAsync on "${this.name}": the singular "action" field is deprecated, use "actions".`,
          );
        }
        if (!Array.isArray(reaction.actions)) {
          throw new Error(`setReactionsAsync on "${this.name}": "actions" must be an array.`);
        }
        for (const action of reaction.actions) {
          if (!action || typeof action.type !== "string") {
            throw new Error(`setReactionsAsync on "${this.name}": every action needs a string type.`);
          }
          if (action.type !== "NODE") continue;
          const destinationId = action.destinationId;
          if (destinationId === null) continue;
          if (typeof destinationId !== "string") {
            throw new Error(
              `setReactionsAsync on "${this.name}": a NODE action's destinationId must be a string or null.`,
            );
          }
          const destination = nodesById.get(destinationId);
          if (!destination || destination.removed) {
            throw new Error(
              `setReactionsAsync on "${this.name}": destination "${destinationId}" is not a node in this document.`,
            );
          }
          if (!isTopLevel(destination)) {
            throw new Error(
              `setReactionsAsync on "${this.name}": NAVIGATE destination must be a top-level frame, but ` +
                `"${destination.name}" is parented to ${destination.parent ? `a ${destination.parent.type}` : "nothing"}.`,
            );
          }
        }
      }

      this._reactions = deepClone(reactions);
    }

    setBoundVariable(field: string, variable: VariableImpl): void {
      assertAlive(this);
      const allowed = new Set([
        "itemSpacing",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "topLeftRadius",
        "topRightRadius",
        "bottomRightRadius",
        "bottomLeftRadius",
      ]);
      if (!allowed.has(field)) {
        throw new Error(`setBoundVariable: "${field}" is not a bindable field on a FRAME node.`);
      }
      if (variable.resolvedType !== "FLOAT") {
        throw new Error(
          `setBoundVariable: variable "${variable.name}" must have resolvedType FLOAT (got ${variable.resolvedType}).`,
        );
      }
      this.boundVariables = { ...this.boundVariables, [field]: { type: "VARIABLE_ALIAS", id: variable.id } };
    }
  }

  class RectangleNodeImpl extends NodeBase {
    fills: Paint[] = [defaultGrayFill()];
    strokes: Paint[] = [];
    strokeWeight = 1;
    strokeTopWeight = 1;
    strokeRightWeight = 1;
    strokeBottomWeight = 1;
    strokeLeftWeight = 1;
    strokeAlign: "INSIDE" | "OUTSIDE" | "CENTER" = "INSIDE";
    dashPattern: number[] = [];
    topLeftRadius = 0;
    topRightRadius = 0;
    bottomRightRadius = 0;
    bottomLeftRadius = 0;

    constructor(name = "Rectangle") {
      super("RECTANGLE", name);
    }

    setBoundVariable(field: string, variable: VariableImpl): void {
      assertAlive(this);
      const allowed = new Set(["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"]);
      if (!allowed.has(field)) {
        throw new Error(`setBoundVariable: "${field}" is not a bindable field on a RECTANGLE node.`);
      }
      if (variable.resolvedType !== "FLOAT") {
        throw new Error(
          `setBoundVariable: variable "${variable.name}" must have resolvedType FLOAT (got ${variable.resolvedType}).`,
        );
      }
      this.boundVariables = { ...this.boundVariables, [field]: { type: "VARIABLE_ALIAS", id: variable.id } };
    }
  }

  class VectorNodeImpl extends NodeBase {
    fills: Paint[] = [];
    strokes: Paint[] = [];
    vectorPaths: any[] = [];

    constructor(name = "Vector") {
      super("VECTOR", name);
    }
  }

  /**
   * A section, which is the only container a prototyped frame may sit in.
   *
   * Deliberately NOT a FrameNodeImpl subclass: a section has no auto-layout, no
   * reactions of its own (SectionNode carries no ReactionMixin in
   * plugin-api.d.ts) and different parenting rules, and inheriting the frame's
   * behaviour would let a test pass on a shape Figma refuses.
   */
  class SectionNodeImpl extends NodeBase {
    children: any[] = [];
    fills: Paint[] = [defaultGrayFill()];
    sectionContentsHidden = false;

    constructor(name = "Section") {
      super("SECTION", name);
    }

    appendChild(child: any): void {
      assertAlive(this);
      if (child.parent) child.parent.removeChildInternal(child);
      child.parent = this;
      this.children.push(child);
    }

    insertChild(index: number, child: any): void {
      assertAlive(this);
      if (child.parent) child.parent.removeChildInternal(child);
      child.parent = this;
      this.children.splice(index, 0, child);
    }

    removeChildInternal(child: any): void {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
    }

    resizeWithoutConstraints(w: number, h: number): void {
      this.resize(w, h);
    }
  }

  class TextNodeImpl extends NodeBase {
    _characters = "";
    _fontName: FontName = { family: "Inter", style: "Regular" };
    _charFonts: FontName[] = [];
    _fontSize = 12;
    _charFontSizes: number[] = [];
    _fills: Paint[] = [defaultBlackFill()];
    _charFills: Paint[][] = [];
    _lineHeight: LineHeight = { unit: "AUTO" };
    _charLineHeights: LineHeight[] = [];
    _letterSpacing: LetterSpacing = { value: 0, unit: "PERCENT" };
    _charLetterSpacings: LetterSpacing[] = [];
    _textDecoration: TextDecoration = "NONE";
    _charDecorations: TextDecoration[] = [];
    _textCase: TextCase = "ORIGINAL";
    _charCases: TextCase[] = [];
    _charHyperlinks: Array<HyperlinkTarget | null> = [];
    textAutoResize: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE" = "NONE";
    textAlignHorizontal: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED" = "LEFT";
    textAlignVertical: "TOP" | "CENTER" | "BOTTOM" = "TOP";

    constructor(name = "Text") {
      super("TEXT", name);
    }

    get characters(): string {
      return this._characters;
    }

    set characters(value: string) {
      assertAlive(this);
      assertFontLoadedForCharacters(this);
      this._characters = value;
      const n = value.length;
      this._charFonts = new Array(n).fill(this._fontName);
      this._charFontSizes = new Array(n).fill(this._fontSize);
      this._charFills = new Array(n).fill(this._fills[0] ?? defaultBlackFill());
      this._charLineHeights = new Array(n).fill(this._lineHeight);
      this._charLetterSpacings = new Array(n).fill(this._letterSpacing);
      this._charDecorations = new Array(n).fill(this._textDecoration);
      this._charCases = new Array(n).fill(this._textCase);
      this._charHyperlinks = new Array(n).fill(null);
    }

    get fontName(): FontName {
      return this._fontName;
    }

    set fontName(value: FontName) {
      assertAlive(this);
      if (!isFontLoaded(value)) {
        throw new Error(
          `Cannot set fontName on "${this.name}" to "${value.family} ${value.style}": font has not been ` +
            `loaded. Call figma.loadFontAsync() first.`,
        );
      }
      this._fontName = value;
      if (this._charFonts.length) this._charFonts = new Array(this._charFonts.length).fill(value);
    }

    get fills(): Paint[] {
      return this._fills;
    }

    set fills(value: Paint[]) {
      assertAlive(this);
      this._fills = value;
      if (this._charFills.length) {
        this._charFills = new Array(this._charFills.length).fill(value[0] ?? defaultBlackFill());
      }
    }

    get fontSize(): number {
      return this._fontSize;
    }

    set fontSize(value: number) {
      assertAlive(this);
      this._fontSize = value;
      if (this._charFontSizes.length) this._charFontSizes = new Array(this._charFontSizes.length).fill(value);
    }

    setRangeFontName(start: number, end: number, value: FontName): void {
      assertAlive(this);
      validateRange(this, start, end);
      if (!isFontLoaded(value)) {
        throw new Error(
          `setRangeFontName: font "${value.family} ${value.style}" has not been loaded on "${this.name}". ` +
            `Call figma.loadFontAsync() first.`,
        );
      }
      assertRangeFontsLoaded(this, start, end);
      for (let i = start; i < end; i++) this._charFonts[i] = value;
    }

    setRangeFontSize(start: number, end: number, value: number): void {
      assertAlive(this);
      validateRange(this, start, end);
      assertRangeFontsLoaded(this, start, end);
      for (let i = start; i < end; i++) this._charFontSizes[i] = value;
    }

    setRangeFills(start: number, end: number, value: Paint[]): void {
      assertAlive(this);
      validateRange(this, start, end);
      assertRangeFontsLoaded(this, start, end);
      for (let i = start; i < end; i++) this._charFills[i] = value;
    }

    setRangeLineHeight(start: number, end: number, value: LineHeight): void {
      assertAlive(this);
      validateRange(this, start, end);
      assertRangeFontsLoaded(this, start, end);
      for (let i = start; i < end; i++) this._charLineHeights[i] = value;
    }

    setRangeLetterSpacing(start: number, end: number, value: LetterSpacing): void {
      assertAlive(this);
      validateRange(this, start, end);
      assertRangeFontsLoaded(this, start, end);
      for (let i = start; i < end; i++) this._charLetterSpacings[i] = value;
    }

    setRangeTextDecoration(start: number, end: number, value: TextDecoration): void {
      assertAlive(this);
      validateRange(this, start, end);
      assertRangeFontsLoaded(this, start, end);
      for (let i = start; i < end; i++) this._charDecorations[i] = value;
    }

    setRangeTextCase(start: number, end: number, value: TextCase): void {
      assertAlive(this);
      validateRange(this, start, end);
      assertRangeFontsLoaded(this, start, end);
      for (let i = start; i < end; i++) this._charCases[i] = value;
    }

    setRangeHyperlink(start: number, end: number, value: HyperlinkTarget | null): void {
      assertAlive(this);
      validateRange(this, start, end);
      assertRangeFontsLoaded(this, start, end);
      for (let i = start; i < end; i++) this._charHyperlinks[i] = value;
    }
  }

  // -------------------------------------------------------------------------
  // Variables
  // -------------------------------------------------------------------------

  class VariableCollectionImpl extends PluginDataStore {
    readonly id: string;
    name: string;
    hiddenFromPublishing = false;
    readonly remote: boolean;
    isExtension = false;
    modes: Array<{ modeId: string; name: string }>;
    variableIds: string[] = [];
    defaultModeId: string;
    key: string;

    constructor(name: string, remote = false, keyOverride?: string) {
      super();
      this.id = genId("VariableCollectionId");
      this.name = name;
      this.remote = remote;
      const modeId = genId("mode");
      this.modes = [{ modeId, name: "Mode 1" }];
      this.defaultModeId = modeId;
      this.key = keyOverride ?? genId("collectionKey");
    }

    addMode(name: string): string {
      // Figma gates modes on the file's plan and throws with this exact
      // wording, which some plugins surface verbatim. Deliberately does NOT
      // seed the new mode's values on existing variables: the typings never
      // promise it does, and a plugin that assumes it produces variables that
      // are empty in every mode but the default.
      if (modeLimit !== undefined && this.modes.length >= modeLimit) {
        throw new Error(`in addMode: Limited to ${modeLimit} modes only`);
      }
      const modeId = genId("mode");
      this.modes.push({ modeId, name });
      return modeId;
    }

    removeMode(modeId: string): void {
      this.modes = this.modes.filter((m) => m.modeId !== modeId);
    }

    renameMode(modeId: string, name: string): void {
      const mode = this.modes.find((m) => m.modeId === modeId);
      if (mode) mode.name = name;
    }

    remove(): void {
      collectionsById.delete(this.id);
    }
  }

  class VariableImpl extends PluginDataStore {
    readonly id: string;
    name: string;
    description = "";
    hiddenFromPublishing = false;
    readonly remote: boolean;
    readonly variableCollectionId: string;
    readonly resolvedType: VariableResolvedDataType;
    key: string;
    valuesByMode: Record<string, VariableValue> = {};
    scopes: string[] = [];
    codeSyntax: Record<string, string> = {};

    constructor(
      name: string,
      collection: VariableCollectionImpl,
      resolvedType: VariableResolvedDataType,
      remote = false,
      keyOverride?: string,
    ) {
      super();
      this.id = genId("VariableID");
      this.name = name;
      this.variableCollectionId = collection.id;
      this.resolvedType = resolvedType;
      this.remote = remote;
      this.key = keyOverride ?? genId("variableKey");
    }

    setValueForMode(modeId: string, value: VariableValue): void {
      const collection = collectionsById.get(this.variableCollectionId);
      const modeKnown = collection?.modes.some((m) => m.modeId === modeId) ?? false;
      if (!modeKnown) {
        throw new Error(`setValueForMode: unknown modeId "${modeId}" for variable "${this.name}".`);
      }
      validateValueForType(this.resolvedType, value, this.name);

      // An alias is a value, so this is also where Figma rejects an alias that
      // cannot resolve. Both checks are real refusals: a dangling id leaves the
      // variable unreadable, and a self-reference is the shortest possible
      // cycle.
      if (value !== null && typeof value === "object" && (value as any).type === "VARIABLE_ALIAS") {
        const aliasId = (value as VariableAlias).id;
        if (aliasId === this.id) {
          throw new Error(`setValueForMode: variable "${this.name}" cannot alias itself.`);
        }
        if (!variablesById.has(aliasId)) {
          throw new Error(
            `setValueForMode: VARIABLE_ALIAS on "${this.name}" points at unknown variable "${aliasId}".`,
          );
        }
      }

      this.valuesByMode[modeId] = value;
    }

    remove(): void {
      variablesById.delete(this.id);
    }
  }

  const collectionsById = new Map<string, VariableCollectionImpl>();
  const variablesById = new Map<string, VariableImpl>();
  const libraryCollectionsByKey = new Map<
    string,
    { key: string; name: string; libraryName: string; variables: MockLibraryVariableSpec[] }
  >();
  const libraryVariableSpecsByKey = new Map<
    string,
    { name: string; resolvedType: VariableResolvedDataType; collection: VariableCollectionImpl }
  >();
  const importedByKey = new Map<string, VariableImpl>();

  for (const lc of libraryCollectionsInput) {
    const collectionImpl = new VariableCollectionImpl(lc.name, true, lc.key);
    collectionsById.set(collectionImpl.id, collectionImpl);
    libraryCollectionsByKey.set(lc.key, {
      key: lc.key,
      name: lc.name,
      libraryName: lc.libraryName,
      variables: lc.variables,
    });
    for (const v of lc.variables) {
      libraryVariableSpecsByKey.set(v.key, {
        name: v.name,
        resolvedType: v.resolvedType as VariableResolvedDataType,
        collection: collectionImpl,
      });
    }
  }

  const variablesAPI = {
    async getVariableByIdAsync(id: string) {
      return variablesById.get(id) ?? null;
    },
    async getVariableCollectionByIdAsync(id: string) {
      return collectionsById.get(id) ?? null;
    },
    async getLocalVariablesAsync(type?: VariableResolvedDataType) {
      const all = [...variablesById.values()].filter((v) => !v.remote);
      return type ? all.filter((v) => v.resolvedType === type) : all;
    },
    async getLocalVariableCollectionsAsync() {
      return [...collectionsById.values()].filter((c) => !c.remote);
    },
    createVariable(name: string, collectionOrId: VariableCollectionImpl | string, resolvedType: VariableResolvedDataType) {
      const collection =
        typeof collectionOrId === "string" ? collectionsById.get(collectionOrId) : collectionOrId;
      if (!collection) {
        throw new Error(`createVariable: unknown collection.`);
      }
      const duplicate = collection.variableIds
        .map((id) => variablesById.get(id))
        .some((v) => v?.name === name);
      if (duplicate) {
        throw new Error(`createVariable: a variable named "${name}" already exists in collection "${collection.name}".`);
      }
      const variable = new VariableImpl(name, collection, resolvedType, false);
      variablesById.set(variable.id, variable);
      collection.variableIds.push(variable.id);
      return variable;
    },
    createVariableCollection(name: string) {
      const collection = new VariableCollectionImpl(name, false);
      collectionsById.set(collection.id, collection);
      return collection;
    },
    async extendLibraryCollectionByKeyAsync() {
      throw new Error("extendLibraryCollectionByKeyAsync is not supported by this mock.");
    },
    createVariableAlias(variable: VariableImpl): VariableAlias {
      if (!variable || typeof variable.id !== "string") {
        throw new Error("createVariableAlias: invalid variable.");
      }
      return { type: "VARIABLE_ALIAS", id: variable.id };
    },
    async createVariableAliasByIdAsync(variableId: string): Promise<VariableAlias> {
      return { type: "VARIABLE_ALIAS", id: variableId };
    },
    setBoundVariableForPaint(paint: SolidPaint, field: string, variable: VariableImpl | null): SolidPaint {
      if (variable === null) {
        const { boundVariables, ...rest } = paint;
        return rest as SolidPaint;
      }
      if (variable.resolvedType !== "COLOR") {
        throw new Error(
          `setBoundVariableForPaint: variable "${variable.name}" must have resolvedType COLOR (got ${variable.resolvedType}).`,
        );
      }
      return {
        ...paint,
        boundVariables: { ...(paint.boundVariables ?? {}), [field]: { type: "VARIABLE_ALIAS", id: variable.id } },
      };
    },
    setBoundVariableForEffect(effect: Effect, field: string, variable: VariableImpl | null): Effect {
      if (variable === null) {
        const { boundVariables, ...rest } = effect;
        return rest;
      }
      return {
        ...effect,
        boundVariables: { ...(effect.boundVariables ?? {}), [field]: { type: "VARIABLE_ALIAS", id: variable.id } },
      };
    },
    setBoundVariableForLayoutGrid(layoutGrid: Record<string, any>): Record<string, any> {
      return { ...layoutGrid };
    },
    async importVariableByKeyAsync(key: string) {
      const cached = importedByKey.get(key);
      if (cached) return cached;

      const spec = libraryVariableSpecsByKey.get(key);
      if (!spec) {
        throw new Error(`importVariableByKeyAsync: no published variable found for key "${key}".`);
      }
      const variable = new VariableImpl(spec.name, spec.collection, spec.resolvedType, true, key);
      variablesById.set(variable.id, variable);
      spec.collection.variableIds.push(variable.id);
      importedByKey.set(key, variable);
      return variable;
    },
  };

  const teamLibraryAPI = {
    async getAvailableLibraryVariableCollectionsAsync() {
      if (!teamLibraryAvailable) {
        throw new Error(
          "Team library variables are not available in this file (no published libraries, or plan does not support them).",
        );
      }
      return [...libraryCollectionsByKey.values()].map((c) => ({ key: c.key, name: c.name, libraryName: c.libraryName }));
    },
    async getVariablesInLibraryCollectionAsync(collectionKey: string) {
      const collection = libraryCollectionsByKey.get(collectionKey);
      if (!collection) {
        throw new Error(`getVariablesInLibraryCollectionAsync: unknown library collection key "${collectionKey}".`);
      }
      return collection.variables.map((v) => ({ name: v.name, key: v.key, resolvedType: v.resolvedType }));
    },
  };

  // -------------------------------------------------------------------------
  // Effect styles
  // -------------------------------------------------------------------------

  class EffectStyleImpl {
    readonly id: string;
    readonly type = "EFFECT";
    name = "";
    description = "";
    key: string;
    remote = false;
    private _effects: Effect[] = [];

    constructor() {
      this.id = genId("EffectStyleId");
      this.key = genId("effectStyleKey");
    }

    get effects(): Effect[] {
      return this._effects;
    }

    set effects(value: Effect[]) {
      // Figma rejects an effect it cannot interpret rather than storing it and
      // rendering nothing, so a shadow parsed into NaN offsets fails loudly
      // here instead of importing as an invisible style.
      for (const effect of value) {
        for (const field of ["radius", "spread"] as const) {
          const n = (effect as Record<string, unknown>)[field];
          if (n !== undefined && (typeof n !== "number" || Number.isNaN(n))) {
            throw new Error(`EffectStyle "${this.name}": ${field} must be a number, got ${String(n)}.`);
          }
        }
        const offset = (effect as { offset?: { x: unknown; y: unknown } }).offset;
        if (offset && (typeof offset.x !== "number" || Number.isNaN(offset.x) || typeof offset.y !== "number" || Number.isNaN(offset.y))) {
          throw new Error(`EffectStyle "${this.name}": offset must be {x, y} numbers.`);
        }
      }
      this._effects = deepClone(value);
    }

    remove(): void {
      const idx = effectStyles.indexOf(this);
      if (idx >= 0) effectStyles.splice(idx, 1);
    }
  }

  const effectStyles: EffectStyleImpl[] = [];

  // -------------------------------------------------------------------------
  // Page / selection / viewport / ui
  // -------------------------------------------------------------------------

  let selection: any[] = [];
  let flowStartingPoints: Array<{ nodeId: string; name: string }> = [];

  const currentPage = {
    id: genId("page"),
    type: "PAGE",
    name: "Page 1",
    children: [] as any[],
    get selection() {
      return selection;
    },
    set selection(nodes: any[]) {
      selection = [...nodes];
    },
    /**
     * The page's prototype flows.
     *
     * Writable: `flowStartingPoints` carries no `readonly` modifier in
     * plugin-api.d.ts, in contrast to `prototypeStartNode` two properties
     * below it. Assigned wholesale, which is what makes it dangerous:
     * every flow the designer already drew on this page lives in this one
     * array, and an import that assigns rather than appends deletes all of them
     * with nothing on the canvas to notice.
     */
    get flowStartingPoints(): ReadonlyArray<{ nodeId: string; name: string }> {
      return Object.freeze(flowStartingPoints.map((point) => ({ ...point })));
    },
    set flowStartingPoints(points: ReadonlyArray<{ nodeId: string; name: string }>) {
      if (!Array.isArray(points)) {
        throw new Error("flowStartingPoints: expected an array of {nodeId, name}.");
      }
      for (const point of points) {
        if (!point || typeof point.name !== "string" || typeof point.nodeId !== "string") {
          throw new Error("flowStartingPoints: every entry needs a string nodeId and a string name.");
        }
        const node = nodesById.get(point.nodeId);
        if (!node || node.removed) {
          throw new Error(`flowStartingPoints: "${point.nodeId}" is not a node in this document.`);
        }
        // Figma Help, "Create and manage prototype flows": "Flow starting
        // points are set on top-level frames."
        if (!isTopLevel(node)) {
          throw new Error(
            `flowStartingPoints: "${node.name}" is not a top-level frame, so it cannot start a flow.`,
          );
        }
      }
      flowStartingPoints = points.map((point) => ({ ...point }));
    },
    appendChild(node: any) {
      if (node.parent) node.parent.removeChildInternal(node);
      node.parent = currentPage;
      currentPage.children.push(node);
    },
    removeChildInternal(node: any) {
      const idx = currentPage.children.indexOf(node);
      if (idx >= 0) currentPage.children.splice(idx, 1);
    },
  };

  const viewportAPI = {
    center: { x: 0, y: 0 },
    zoom: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    /** Nodes passed to the most recent scrollAndZoomIntoView() call. */
    lastScrollAndZoomTargets: [] as any[],
    scrollAndZoomIntoView(nodes: any[]) {
      viewportAPI.lastScrollAndZoomTargets = nodes;
    },
  };

  let uiOnMessageHandler: ((message: any) => void) | undefined;
  const uiAPI = {
    get onmessage() {
      return uiOnMessageHandler;
    },
    set onmessage(handler: ((message: any) => void) | undefined) {
      uiOnMessageHandler = handler;
    },
    /** Every message posted via figma.ui.postMessage(), in order. */
    postedMessages: [] as any[],
    postMessage(message: any) {
      uiAPI.postedMessages.push(message);
    },
    size: { width: 400, height: 620 },
    resize(width: number, height: number) {
      uiAPI.size = { width, height };
    },
    close() {
      // no-op in the mock
    },
  };

  // -------------------------------------------------------------------------
  // figma global
  // -------------------------------------------------------------------------

  // NOTE: there is deliberately no `createConnector` here, and its absence is
  // itself an assertion. plugin-api.d.ts carries "Note: This API is only
  // available in FigJam" immediately above it, and manifest.json declares
  // `"editorType": ["figma"]`, so a call that type-checks perfectly reports
  // "not implemented" in a Design file. Anything that reaches for a drawn
  // connector arrow has to fail in the simulator exactly as it fails in the
  // editor, which it cannot do if the mock is more generous than Figma.
  const figmaObj: any = {
    currentPage,
    viewport: viewportAPI,
    variables: variablesAPI,
    teamLibrary: teamLibraryAPI,
    ui: uiAPI,
    mixed: Symbol("figma.mixed"),
    closed: false,
    /** Matches manifest.json's `"editorType": ["figma"]`. */
    editorType: "figma",
    shownUI: undefined as { html: string; options?: any } | undefined,

    async getNodeByIdAsync(id: string) {
      const node = nodesById.get(id);
      return node && !node.removed ? node : null;
    },

    showUI(html: string, uiOptions?: any) {
      figmaObj.shownUI = { html, options: uiOptions };
    },

    notify(message: string, notifyOptions?: { error?: boolean; timeout?: number }) {
      notifications.push({ message, error: !!notifyOptions?.error });
      return { cancel() {} };
    },

    commitUndo() {
      undoCommitsCount++;
    },

    closePlugin(_message?: string) {
      figmaObj.closed = true;
    },

    createFrame(): FrameNodeImpl {
      return guard(new FrameNodeImpl());
    },

    createText(): TextNodeImpl {
      return guard(new TextNodeImpl());
    },

    createRectangle(): RectangleNodeImpl {
      return guard(new RectangleNodeImpl());
    },

    /**
     * Available in Figma Design, unlike every other node type near it in
     * plugin-api.d.ts: `createSection` carries no FigJam-only note where
     * `createConnector`, `createShapeWithText`, `createCodeBlock` and
     * `createTable` all do.
     */
    createSection(): SectionNodeImpl {
      return guard(new SectionNodeImpl());
    },

    createImage(data: Uint8Array) {
      const hash = genId("imagehash");
      return {
        hash,
        async getBytesAsync() {
          return data;
        },
        async getSizeAsync() {
          return { width: 100, height: 100 };
        },
      };
    },

    createEffectStyle(): EffectStyleImpl {
      const style = new EffectStyleImpl();
      effectStyles.push(style);
      return style;
    },

    async getLocalEffectStylesAsync(): Promise<EffectStyleImpl[]> {
      return [...effectStyles];
    },

    createNodeFromSvg(_svg: string): FrameNodeImpl {
      const frame = guard(new FrameNodeImpl("svg"));
      const vector = guard(new VectorNodeImpl());
      frame.appendChild(vector);
      return frame;
    },

    async listAvailableFontsAsync() {
      return availableFontsList.map((f) => ({ fontName: { family: f.family, style: f.style } }));
    },

    async loadFontAsync(font: FontName) {
      const exists = availableFontsList.some((f) => f.family === font.family && f.style === font.style);
      if (!exists) {
        throw new Error(
          `Font not available: "${font.family} ${font.style}". Add it to MockOptions.availableFonts if this ` +
            `font should be installed in the mock file.`,
        );
      }
      if (unloadableFonts.some((f) => f.family === font.family && f.style === font.style)) {
        throw new Error(`Could not load font "${font.family} ${font.style}".`);
      }
      loadedFonts.add(fontKey(font));
    },

    base64Decode(data: string): Uint8Array {
      return new Uint8Array(Buffer.from(data, "base64"));
    },

    base64Encode(data: Uint8Array): string {
      return Buffer.from(data).toString("base64");
    },
  };

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  function serializeTree(node: any): any {
    const base: any = {
      type: node.type,
      // A reaction names its destination by id and nothing else, so without
      // this an assertion can count reactions but cannot tell whether any of
      // them points at the frame it was supposed to.
      id: node.id,
      name: node.name,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      opacity: node.opacity,
      rotation: node.rotation,
      effects: deepClone(node.effects ?? []),
      layoutSizingHorizontal: node.layoutSizingHorizontal,
      layoutSizingVertical: node.layoutSizingVertical,
      layoutPositioning: node.layoutPositioning,
      boundVariables: deepClone(node.boundVariables ?? {}),
      // Which theme the subtree renders in. Invisible in a layer tree and the
      // only thing that separates a correctly themed import from one showing
      // the light colours on every dark panel.
      explicitVariableModes: deepClone(node.explicitVariableModes ?? {}),
      // What a re-import would have to match this frame on after somebody
      // renames it, so an assertion can prove it was written at all.
      pluginData: node._pluginData ? Object.fromEntries(node._pluginData) : {},
    };

    if ("fills" in node) base.fills = deepClone(node.fills);
    if ("strokes" in node) {
      base.strokes = deepClone(node.strokes);
      base.strokeWeight = node.strokeWeight;
      base.strokeTopWeight = node.strokeTopWeight;
      base.strokeRightWeight = node.strokeRightWeight;
      base.strokeBottomWeight = node.strokeBottomWeight;
      base.strokeLeftWeight = node.strokeLeftWeight;
      base.strokeAlign = node.strokeAlign;
      base.dashPattern = deepClone(node.dashPattern ?? []);
    }
    if ("topLeftRadius" in node) {
      base.topLeftRadius = node.topLeftRadius;
      base.topRightRadius = node.topRightRadius;
      base.bottomRightRadius = node.bottomRightRadius;
      base.bottomLeftRadius = node.bottomLeftRadius;
    }

    if (node.type === "FRAME") {
      base.reactions = deepClone([...node.reactions]);
      base.clipsContent = node.clipsContent;
      base.layoutMode = node.layoutMode;
      base.layoutWrap = node.layoutWrap;
      base.itemSpacing = node.itemSpacing;
      base.counterAxisSpacing = node.counterAxisSpacing;
      base.paddingTop = node.paddingTop;
      base.paddingRight = node.paddingRight;
      base.paddingBottom = node.paddingBottom;
      base.paddingLeft = node.paddingLeft;
      base.primaryAxisAlignItems = node.primaryAxisAlignItems;
      base.counterAxisAlignItems = node.counterAxisAlignItems;
      base.primaryAxisSizingMode = node.primaryAxisSizingMode;
      base.counterAxisSizingMode = node.counterAxisSizingMode;
      base.children = node.children.map(serializeTree);
    } else if (node.type === "TEXT") {
      base.characters = node.characters;
      base.fontName = deepClone(node.fontName);
      // Per-character resolved font, mirroring what setRangeFontName() actually
      // wrote (node.fontName only ever reflects the first run — see its own
      // getter/setter above — so weight/italic fidelity for the 2nd..nth run
      // in a multi-run text node is otherwise unobservable from serializeTree()).
      base.charFonts = deepClone(node._charFonts ?? []);
      base.textAutoResize = node.textAutoResize;
      base.textAlignHorizontal = node.textAlignHorizontal;
      base.textAlignVertical = node.textAlignVertical;
      base.children = [];
    } else {
      base.children = (node.children ?? []).map(serializeTree);
    }

    return base;
  }

  function collectionSummary(c: VariableCollectionImpl): VariableCollectionSummary {
    return {
      id: c.id,
      key: c.key,
      name: c.name,
      remote: c.remote,
      defaultModeId: c.defaultModeId,
      modes: c.modes.map((m) => ({ ...m })),
      variableIds: [...c.variableIds],
      pluginData: Object.fromEntries(c._pluginData),
    };
  }

  function variableSummary(v: VariableImpl): VariableSummary {
    return {
      id: v.id,
      key: v.key,
      name: v.name,
      resolvedType: v.resolvedType,
      remote: v.remote,
      variableCollectionId: v.variableCollectionId,
      valuesByMode: deepClone(v.valuesByMode),
      scopes: [...v.scopes],
    };
  }

  return {
    figma: figmaObj,
    getRootNodes: () => [...currentPage.children],
    serializeTree,
    getCollections: () => [...collectionsById.values()].map(collectionSummary),
    getVariables: () => [...variablesById.values()].map(variableSummary),
    getEffectStyles: () =>
      effectStyles.map((style) => ({
        id: style.id,
        name: style.name,
        effects: deepClone(style.effects),
      })),
    getFlowStartingPoints: () => flowStartingPoints.map((point) => ({ ...point })),
    notifications,
    get undoCommits() {
      return undoCommitsCount;
    },
  };
}
