/**
 * Intermediate Representation shared by the UI (extractor) and the plugin
 * sandbox (builder).
 *
 * The UI half runs in a real DOM and can measure; the sandbox half has the
 * Figma API but no DOM. Everything that crosses that boundary is plain JSON,
 * so keep this file free of DOM and Figma types.
 */

// Type-only: ResolveReport (src/ui/resolve.ts) is itself plain
// booleans/strings/numbers, so it fits the "plain JSON" rule above. A
// type-only import is fully erased at compile time, so this does not give
// the plugin-sandbox bundle a runtime dependency on the DOM-only resolver.
import type { ResolveReport } from "../ui/resolve";

export type TokenRef = {
  /** CSS custom property name without the leading dashes, e.g. "acme-green-700". */
  name: string;
  /** Variable path we want in Figma, e.g. "color/acme-green/700". */
  path: string;
  /** How we arrived at this token. Literal matches are lower confidence. */
  via: "var" | "value-match";
  /**
   * The re-theme this match was made INSIDE, when the token's value depends on
   * it.
   *
   * Set only for a match against a token the containing theme re-themes (or
   * that only a theme declares), which makes the binding valid in that theme's
   * mode and in no other. `Portage Panel.dc.html` declares
   * `--figma-color-text-tertiary` as `#b3b3b3` under `.cd2f-theme-light` and
   * `#7e7e7e` under `.cd2f-theme-dark`: both bind to one variable, and it is
   * the frame's mode that decides which colour renders. When the theme reached
   * the file as a real mode the builder binds and sets that mode; when it did
   * not (a Free plan allows one mode per collection) the builder must leave the
   * value literal, because binding it anyway would silently show the other
   * theme's colour on canvas.
   */
  themeScope?: string;
};

export type IRColor = { r: number; g: number; b: number; a: number };

export type IRSolidPaint = {
  type: "SOLID";
  color: IRColor;
  token?: TokenRef;
};

export type IRGradientStop = { position: number; color: IRColor };

export type IRGradientPaint = {
  type: "GRADIENT_LINEAR";
  /** Angle in degrees, CSS convention (0deg = to top, 90deg = to right). */
  angle: number;
  stops: IRGradientStop[];
};

export type IRImagePaint = {
  type: "IMAGE";
  /** Base64 payload without the data-URI prefix. */
  bytesBase64: string;
  scaleMode: "FILL" | "FIT" | "TILE" | "CROP";
};

export type IRPaint = IRSolidPaint | IRGradientPaint | IRImagePaint;

export type IRShadow = {
  type: "DROP_SHADOW" | "INNER_SHADOW";
  color: IRColor;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
};

export type IRBlur = { type: "LAYER_BLUR" | "BACKGROUND_BLUR"; radius: number };

export type IREffect = IRShadow | IRBlur;

export type AxisAlign = "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
export type CrossAlign = "MIN" | "CENTER" | "MAX" | "BASELINE";
export type Sizing = "FIXED" | "HUG" | "FILL";

export type IRLayout = {
  mode: "HORIZONTAL" | "VERTICAL";
  gap: number;
  gapToken?: TokenRef;
  /** Cross-axis gap, only meaningful when wrap is true. */
  crossGap: number;
  wrap: boolean;
  padding: { top: number; right: number; bottom: number; left: number };
  paddingTokens?: Partial<
    Record<"top" | "right" | "bottom" | "left", TokenRef>
  >;
  primaryAlign: AxisAlign;
  crossAlign: CrossAlign;
  /**
   * Why we chose auto-layout. "explicit" = the DOM said flex/grid.
   * "inferred" = we detected a clean stack in normal flow.
   */
  source: "explicit-flex" | "explicit-grid" | "inferred-stack";
  /**
   * Size this frame to its content rather than to the measured box.
   *
   * Used for chips and badges: a pill hugs its label in the source, so pinning
   * it to the measured width means a substituted font has nowhere to go and
   * wraps inside its own border. Hugging keeps the shape correct and lets the
   * pill be a few pixels wider instead.
   */
  hugContent?: boolean;
};

export type IRTextRun = {
  start: number;
  end: number;
  fontFamily: string;
  /**
   * The whole `font-family` stack, in order. Figma is asked for each in turn,
   * so `Geist, "Inter", sans-serif` lands on Inter where Geist is missing
   * rather than on a generic last resort.
   */
  fontStack?: string[];
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  /** Absolute px. Null means "auto" and the builder should use AUTO. */
  lineHeight: number | null;
  letterSpacing: number;
  fill: IRSolidPaint;
  decoration: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
  textCase: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE";
  /** Populated when the run came from an <a href>. */
  href?: string;
};

export type IRText = {
  characters: string;
  runs: IRTextRun[];
  align: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  verticalAlign: "TOP" | "CENTER" | "BOTTOM";
  /**
   * The source rendered this text on one line.
   *
   * Fonts get substituted on import — Figma ships neither DM Sans nor Red Hat
   * Display for everyone — and a substituted face is rarely the same width. A
   * label measured at 47px that renders 3px wider in Figma wraps onto a second
   * line and collides with whatever sits below it. Knowing it was one line
   * lets the builder keep it one line.
   */
  singleLine: boolean;
  /**
   * Lines shown before the rest is cut off with an ellipsis: 1 for
   * `text-overflow: ellipsis` on one line, N for `-webkit-line-clamp: N`.
   * Absent means the whole text shows. Built as Figma's own truncation.
   */
  maxLines?: number;
  /**
   * A paint for the glyphs themselves, from `background-clip: text` (gradient
   * text). Replaces the per-run fills, which are transparent in that idiom.
   */
  glyphFill?: IRPaint;
  /** Typography token matched on the dominant run, if any. */
  styleToken?: TokenRef;
};

export type IRBorder = {
  /** Uniform when all four sides agree; otherwise per-side weights are set. */
  weights: { top: number; right: number; bottom: number; left: number };
  paint: IRSolidPaint;
  dashed: boolean;
};

export type IRNodeKind = "FRAME" | "TEXT" | "IMAGE" | "VECTOR";

export type IRNode = {
  kind: IRNodeKind;
  name: string;
  /** Position relative to the parent node's border box. */
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  rotation: number;
  clips: boolean;

  layout?: IRLayout;
  /** Sizing along [horizontal, vertical] once placed in a parent auto-layout. */
  sizing?: { horizontal: Sizing; vertical: Sizing };
  /** Set when the element is flex-grow > 0 inside its parent. */
  grow?: boolean;
  /**
   * Pinned to its own x/y inside the parent auto-layout instead of flowing in
   * it (Figma's `layoutPositioning = "ABSOLUTE"`). The one caller is the
   * synthesised select chevron, which overlays the field's arrow band while the
   * option text keeps flowing and centring on the same axis.
   */
  absolute?: boolean;

  fills: IRPaint[];
  border?: IRBorder;
  cornerRadius: { tl: number; tr: number; br: number; bl: number };
  cornerToken?: TokenRef;
  effects: IREffect[];

  text?: IRText;
  /**
   * For IMAGE nodes: the raw encoded bytes. Kept as a typed array rather than
   * base64 because postMessage uses structured clone, which carries a
   * Uint8Array directly — base64 would cost an encode, a decode and a third
   * more bytes across the boundary for nothing.
   */
  imageBytes?: Uint8Array;
  /** How an IMAGE node's picture fits its box, from `object-fit`. Absent = stretch to fill. */
  imageScale?: "FILL" | "FIT" | "CROP";
  /** `mix-blend-mode`, as Figma's blend mode name. Absent = normal. */
  blendMode?: string;
  /** For VECTOR nodes: raw SVG markup. */
  svg?: string;

  /**
   * The re-theme class this element introduced, e.g. `.cd2f-theme-dark`.
   *
   * Set on the OUTERMOST node of each themed subtree only, because that is the
   * node the mode goes on: Figma resolves a variable mode down the tree, so one
   * `setExplicitVariableModeForCollection` on the panel frame covers every
   * layer inside it. Present only for a theme that is part of a detected mode
   * axis (`detectThemeAxis`, src/ui/tokens.ts), never for a design system's
   * manifest surfaces, which no node in a product screen legally sits under.
   */
  themeScope?: string;

  children: IRNode[];
};

/**
 * What a token is *for*, which is not the same question as what Figma type it
 * resolves to: `--radius-md` and `--space-4` are both FLOAT and must never bind
 * to each other.
 */
export type TokenCategory =
  | "color"
  | "spacing"
  | "radius"
  | "font"
  | "shadow"
  | "other";

/** A themed surface from `_ds_manifest.json`'s `themes[]`, e.g. `.acme-deck`. */
export type IRSurface = {
  /** CSS selector the theme is scoped under. */
  selector: string;
  /** Human label, which becomes the Figma mode name. */
  label: string;
};

/** One token's value inside one surface. Mirrors the base fields on IRTokenDefinition. */
export type IRSurfaceValue = {
  resolved: string;
  color?: IRColor;
  float?: number;
  /** `var(--other)` as written *inside this surface*, which can differ from the base. */
  aliasOf?: string;
};

export type IRTokenDefinition = {
  /** Custom property name without leading dashes. */
  name: string;
  /**
   * Figma variable path, e.g. "color/acme-green/700".
   *
   * This is the token's matching identity for mode (a): `resolveToken`
   * (src/plugin/mapping.ts) looks a designer's existing variables up by it, and
   * it is also the key `VariableRegistry.byPath` is built on, which is what
   * `bindPaint`/`bindField` read when binding a built node. Regrouping it
   * breaks name-matching against every real design system silently, with
   * `boundByName` simply dropping to zero. Build-mode grouping goes in
   * `buildPath` instead.
   */
  path: string;
  kind: "COLOR" | "FLOAT" | "STRING";
  /** Fully resolved value. */
  resolved: string;
  /** Set when the raw value was `var(--other)` — becomes a Figma alias. */
  aliasOf?: string;
  color?: IRColor;
  float?: number;

  // Everything below is populated only when the export shipped a
  // `_ds_manifest.json` (or, for `buildPath`/`category`, whenever the token
  // pipeline ran at all). All optional, so mode (a) behaves identically when
  // they are absent.

  /** Grouped/typed name for the build path. Absent means fall back to `path`. */
  buildPath?: string;
  category?: TokenCategory;
  /**
   * Scopes this name is declared in, `""` being the base (`:root`) layer.
   *
   * Absent means "base layer, no manifest was read" — mode (a) treats absent
   * and `[""]` the same way, and both are bindable. A token WITHOUT `""` in
   * this list exists only inside a themed surface and is deliberately kept out
   * of mode (a): a product-surface element can never legally use it.
   */
  declaredIn?: string[];
  /** Per-surface values keyed by `IRSurface.selector`. The base value stays in `resolved`/`color`/`float`. */
  bySurface?: Record<string, IRSurfaceValue>;
};

/**
 * A shadow token, which cannot be a Figma variable at all.
 *
 * `--shadow-md` is a *list* of drop shadows and Figma has no shadow-typed
 * variable, so the build path emits an EffectStyle instead. Kept off
 * `IRDesignSystem.tokens` because everything in there is a variable candidate.
 */
export type IRShadowToken = {
  /** Custom property name without leading dashes, e.g. "shadow-md". */
  name: string;
  /** Effect style name, e.g. "shadow/md" or "deck/shadow/md". */
  buildPath: string;
  /** Surface selector this definition came from, or `""` for the base layer. */
  scope: string;
  layers: IRShadow[];
};

export type IRDesignSystem = {
  name: string;
  tokens: IRTokenDefinition[];
  /** From `_ds_manifest.json`'s `themes[]`, in manifest order. Absent means no modes. */
  surfaces?: IRSurface[];
  /**
   * Selectors of the mode axis the DOCUMENT declares for itself, a subset of
   * `surfaces` (`detectThemeAxis`, src/ui/tokens.ts).
   *
   * The difference between these and a manifest surface is not cosmetic: an
   * axis selector is one a node in THIS document actually sits under, and
   * `IRNode.themeScope` is only ever one of them. A design system's other
   * product surfaces (`.acme-deck`, `.acme-email`) re-theme the same names
   * and no layer imported here is inside one.
   *
   * Carried across the boundary because the sandbox cannot recover it. Deriving
   * it from `declaredIn` gets the real export wrong: nine of its tokens are
   * declared under `.acme-deck` AND `.acme-email` and under no `:root`,
   * which is the same shape as the fifteen the light/dark axis declares.
   */
  axis?: string[];
  /**
   * Name for the base mode when the base layer is itself a named theme:
   * `:root` beside `:root[data-theme="dark"]` is "Light". Absent means the
   * builder's generic name.
   */
  baseModeLabel?: string;
  /**
   * Stable identity for an idempotent re-import: `_ds_manifest.json`'s
   * `namespace`. Stamped onto the built collection as plugin data so a second
   * import finds it again even after a designer renames it.
   */
  key?: string;
  /** Shadow tokens, which become EffectStyles rather than variables. */
  shadows?: IRShadowToken[];
};

/**
 * One token a document declares at a value the batch it is part of does not
 * hold.
 *
 * Both halves are kept rather than a yes/no, because whether the binding would
 * actually render wrong depends on the MODE the node sits in and that is only
 * known while building. `Portage Panel v1.dc.html` declares
 * `--figma-color-text-secondary` as `#757575` where `Portage.dc.html` declares
 * `#767676`, and it declares `--figma-color-bg-selected` differently only
 * inside `.cd2f-theme-dark`, agreeing with it everywhere else. A single flag
 * would have to unbind the second token in the light theme too, which is a
 * correct binding thrown away.
 */
export type DivergentToken = {
  /** What THIS document declares, which is what the browser rendered. */
  declared: IRTokenDefinition;
  /** What the merged system carries, which is what the file's variable holds. */
  bound: IRTokenDefinition;
};

/**
 * The tokens ONE document of a batch must not bind, keyed by token path.
 *
 * Per document rather than global on purpose: the same path binds perfectly
 * well for the screen that declared it first, and that screen is the one the
 * variable's value came from. Produced by `mergeDesignSystems` and honoured by
 * `bindableToken` (both src/plugin/build.ts).
 *
 * A Map rather than the plain JSON the rest of this file is made of, because
 * this one never crosses the postMessage boundary: the merge is a batch fact
 * and the batch only exists inside the sandbox.
 */
export type TokenDivergence = ReadonlyMap<string, DivergentToken>;

export type IRDocument = {
  /** Source label, used to name the top-level Figma frame. */
  name: string;
  /**
   * The prop values this document was rendered with, when it is one cell of an
   * enumerated state matrix (`extractStateMatrix`, src/ui/extract.ts).
   *
   * Written onto the built frame as plugin data (src/plugin/build.ts), because
   * the frame's NAME is otherwise the only record of which combination it is
   * and a designer renaming layers is not a mistake. Without it a re-import
   * cannot match a frame to the state it came from, and appends a second
   * matrix beside the first.
   */
  props?: Record<string, string | number | boolean>;
  designSystem?: IRDesignSystem;
  root: IRNode;
  /** Non-fatal notes surfaced to the user after import. */
  warnings: string[];
  /**
   * Stylesheets the document asked for that were not present.
   *
   * Claude Design has no project export — files download one at a time — so the
   * overwhelmingly common case is a user dropping a lone `.dc.html` that still
   * links `_ds/<system>/tokens/*.css`. Without those the design system cannot be
   * recovered, and silently importing hex literals would look like the plugin
   * simply does not do what it claims. Naming the missing files lets the UI hand
   * back a specific fix instead.
   */
  missingStylesheets: string[];
  /**
   * Markup that Claude Design's own runtime (`support.js`) would otherwise be
   * needed to resolve. `resolveDynamicDocument` (src/ui/resolve.ts) now runs
   * before scripts are stripped and executes the embedded
   * `<script data-dc-script>` block itself, so `placeholders`/`loops`/
   * `components` below are what's left AFTER that attempt — not the raw
   * counts from the original markup. `resolved` carries the full report on
   * what that resolution attempt did (or why it didn't run).
   */
  dynamicContent: {
    placeholders: number;
    loops: number;
    components: number;
    /**
     * `<dc-import>` call sites still standing after resolution: one Claude
     * Design document embedded inside another. Counted separately from
     * `components` because an unresolved one is a whole missing sub-screen,
     * not a missing leaf.
     */
    documents: number;
    resolved: ResolveReport;
  };
};

// ---------------------------------------------------------------------------
// Variable targeting
// ---------------------------------------------------------------------------

/** Where imported tokens should land. */
export type VariableTarget =
  | { kind: "none" }
  /**
   * A flat, single-mode collection with aliases only among the variables this
   * import created. Kept because e2e scenarios A and D construct it directly
   * and D asserts the "no collection created at all" short-circuit; the UI
   * reaches `"build"` instead. Do not delete it and do not repurpose it.
   */
  | { kind: "create"; name: string }
  | { kind: "local"; collectionId: string; createMissing: boolean }
  | { kind: "library"; collectionKey: string; createMissing: boolean }
  /**
   * Mode (b): build the export's own design system as a real Figma library —
   * the primitive ramp, the semantic layer as genuine aliases onto it, and one
   * mode per themed surface. See `buildDesignSystem` in src/plugin/mapping.ts.
   */
  | {
      kind: "build";
      name: string;
      /** One mode per `IRDesignSystem.surfaces` entry. Ignored when there are none. */
      modes: boolean;
      /**
       * Emit STRING variables for font families and the other non-numeric
       * tokens. Off by default: a STRING variable is inert everywhere except
       * a text node's font family, so most files gain nothing but noise.
       */
      strings?: boolean;
    };

export type LocalCollectionInfo = {
  id: string;
  name: string;
  variableCount: number;
};

export type LibraryCollectionInfo = {
  key: string;
  name: string;
  libraryName: string;
};

export type TargetSummary = {
  local: LocalCollectionInfo[];
  libraries: LibraryCollectionInfo[];
  /** Set when team-library APIs are unavailable on this plan or file. */
  libraryError?: string;
};

export type MappingReport = {
  boundByName: number;
  boundByValue: number;
  created: number;
  unmatched: number;
  /** Human-readable lines, e.g. "primary → Brand/Primary (by name)". */
  samples: string[];

  // Build mode only (`VariableTarget.kind === "build"`), except `modes`. Absent
  // elsewhere so the summary in src/ui/main.ts can tell "zero" from "not
  // applicable".

  /** Semantic variables successfully pointed at a primitive, counted per mode. */
  aliased?: number;
  /**
   * Mode names present after reconciliation. One entry means modes were not built.
   *
   * Also set in Map mode when the document's own theme axis put modes on the
   * overflow collection (`installThemeModes`, src/plugin/mapping.ts). Absent
   * there means no axis, or nowhere of ours to put one, which is a real
   * difference and not a zero.
   */
  modes?: string[];
  /** EffectStyles created or updated for the shadow tokens. */
  effectStyles?: number;
  /** Existing variables updated in place rather than created. Zero on a first import. */
  reused?: number;
};

export type ExtractOptions = {
  viewportWidth: number;
  /** Bind matched values to Figma Variables instead of baking literals. */
  bindTokens: boolean;
  /** Infer auto-layout for normal-flow stacks, not just explicit flex/grid. */
  inferStacks: boolean;
  /** Rasterise elements we cannot faithfully convert instead of dropping them. */
  rasterizeUnsupported: boolean;
  /**
   * Extra CSS to inject before measuring.
   *
   * A Claude Design document only links the `_ds` files it happens to need, and
   * exported decks routinely link nothing but `tokens/fonts.css`. The design
   * system still exists, the document just never references it, so without a way
   * to supply it separately the token table comes back empty and every colour
   * imports as a literal.
   */
  extraCss?: string;
  /**
   * Sibling JavaScript files available to a document's boot phase, keyed by
   * relative path — forgivingly, so `"./app-data.js"` and `"app-data.js"`
   * both point at the same source text (see `lookupModuleSource` in
   * src/ui/resolve.ts). Populated in src/ui/main.ts (`collectModuleSources`)
   * from whatever else was dropped/unzipped alongside the `.dc.html`, minus
   * Claude Design's own runtime files (`support.js`, `image-slot.js`,
   * `deck-stage.js`, `doc-page.js`, anything under `_ds/`) — those are
   * never executed, only the user's own data modules.
   *
   * Some documents' `componentDidMount` does a dynamic `import()` of a data
   * module before `renderVals()` will return anything but chrome (see
   * `resolveDynamicDocument`/`bootAndRender` in src/ui/resolve.ts); without
   * this, that `import()` resolves to `{}` and the document imports in its
   * loading state.
   */
  moduleSources?: Record<string, string>;
  /**
   * Sibling Claude Design documents a `<dc-import name="…">` can pull in,
   * keyed as forgivingly as `moduleSources` above so `"Panel"`,
   * `"panel.dc.html"` and `"./Panel.dc.html"` all reach the same source text.
   *
   * Read by `resolveDynamicDocument` (src/ui/resolve.ts), which compiles each
   * target once and inlines it at every call site. Absent for a lone-file drop
   * or pasted markup, in which case every `<dc-import>` becomes a labelled,
   * `hint-size`d placeholder box and its name lands in
   * `dynamicContent.resolved.documentsMissing`.
   */
  documentSources?: Record<string, string>;
  /**
   * Values for the props a document declares on its own
   * `<script data-dc-script data-props="{…}">`, overriding the declared
   * defaults for one extraction. This is how the same screen is measured once
   * per state (`state=empty`, `state=error`, …) instead of once.
   *
   * Applied at the ROOT only, over the defaults the document itself declares
   * (`readPropsSchema` -> `bootAndRender`, src/ui/resolve.ts). A `<dc-import>`
   * child is never reached by either: support.js applies declared defaults at
   * its `StandaloneRoot` and nowhere else, and a child's props come entirely
   * from its own call site's attributes.
   */
  propOverrides?: Record<string, string | number | boolean>;
  /**
   * The export's `_ds_manifest.json`, verbatim, as text.
   *
   * Raw JSON rather than a parsed object on purpose: `collectDesignSystemManifest`
   * (src/ui/main.ts) already holds it as a string, a manifest we cannot parse
   * must not be able to fail a drop, and this way the shape lives in exactly
   * one place (`parseDsManifest`, src/ui/tokens.ts).
   *
   * It is the ONLY place a token's per-surface values and its `@kind other`
   * annotation are written down: the surface CSS is deliberately not loaded
   * (it would change measurement without contributing a single token), and
   * CSSOM strips the comments the annotation lives in. Supply it alongside the
   * same drop's `extraCss` — the manifest annotates the base layer that CSS
   * produces and adds the surfaces around it, so a manifest without it has
   * nothing to annotate.
   */
  dsManifest?: string;
};

export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = {
  viewportWidth: 1440,
  bindTokens: true,
  inferStacks: true,
  rasterizeUnsupported: false,
};

/**
 * A user's design-system token CSS, persisted across imports.
 *
 * Claude Design exports one file at a time and a deck export links only
 * `tokens/fonts.css`, so without this the user re-supplies the same `_ds`
 * CSS on every single import. `fileCount` is carried alongside the
 * concatenated text purely so the UI can say "N files saved" after a reload,
 * when it only has the merged string back from storage.
 */
export type StoredDesignSystem = { css: string; fileCount: number };

// ---------------------------------------------------------------------------
// Batch import
// ---------------------------------------------------------------------------

/**
 * How a batch of documents is arranged on the page.
 *
 * There is exactly one multi-frame mechanism in this plugin: a batch of
 * `IRDocument`s laid out by `layoutBatch` (src/plugin/build.ts). Anything that
 * wants several frames — a project's screens, one screen enumerated across its
 * states — produces N documents and rides this, rather than growing a second
 * grid of its own.
 */
export type Placement = {
  /** Gap on both axes. Defaults to `IMPORT_GAP` (src/plugin/build.ts). */
  gap?: number;
  /** Frames per row. Defaults to `ceil(sqrt(n))`, so 14 screens wrap at 4. */
  columns?: number;
};

/**
 * A prototype flow over a batch, by position in `docs[]`.
 *
 * Indices rather than names because two screens in one batch can legitimately
 * share a name (the same document enumerated across its states), and a name
 * lookup would silently wire the arrow to the wrong frame.
 */
export type FlowSpec = {
  /** Name for the flow starting point, e.g. "Portage Panel states". */
  name: string;
  startIndex: number;
  /**
   * `delay` (seconds) makes an edge fire on its own, AFTER_TIMEOUT, instead of
   * on click; `smart` animates between the two frames with Smart Animate.
   * An animation's scenes use both, so the prototype plays itself.
   */
  edges: Array<{ from: number; to: number; delay?: number; smart?: boolean }>;
  /** SectionNode to group the frames into, or null to parent to the page. */
  section: string | null;
};

/** Per-document outcome of a batch. A failed document does not fail the batch. */
export type PerDocumentResult =
  | { name: string; ok: true; nodes: number }
  | { name: string; ok: false; message: string };

/** Messages UI -> sandbox. */
export type UIMessage =
  | { type: "scan-targets" }
  | {
      type: "import";
      /** Always at least one. One document is the batch of size one, not a special case. */
      docs: IRDocument[];
      target: VariableTarget;
      placement?: Placement;
      /**
       * Prototype wiring over `docs`. Absent means no reactions and no flow,
       * which is what a plain multi-screen import sends. Applied by
       * `buildDocuments` (src/plugin/build.ts) once every frame is on the page.
       */
      flow?: FlowSpec;
    }
  | { type: "cancel" }
  | { type: "resize"; width: number; height: number }
  | { type: "notify"; message: string; error?: boolean }
  | { type: "save-design-system"; css: string; fileCount: number }
  | { type: "clear-design-system" };

/** Messages sandbox -> UI. */
export type PluginMessage =
  | { type: "targets"; summary: TargetSummary }
  | {
      type: "import-progress";
      /** Position in the batch. `done`/`total` stay scoped to this one document. */
      docIndex: number;
      docCount: number;
      docName: string;
      done: number;
      total: number;
      label: string;
    }
  | {
      type: "import-complete";
      /** Summed across documents. */
      nodes: number;
      /** Top-level frames created, i.e. documents that built successfully. */
      frames: number;
      /**
       * The batch registry's report, read once. A batch shares one
       * `VariableRegistry`, so every document's `BuildResult.mapping` is the
       * same object (src/plugin/build.ts) and summing them would report
       * "125 new variables created" N times for the same 125 variables.
       */
      mapping: MappingReport;
      substitutions: string[];
      warnings: string[];
      /**
       * Prototype reactions written, and flow starting points this import owns
       * afterwards. Always present, and 0 for an import that carried no
       * `FlowSpec`, which is a real count and not "not applicable".
       */
      reactions: number;
      flows: number;
      perDocument: PerDocumentResult[];
    }
  | { type: "import-failed"; message: string }
  /** Sent once at startup only when a design system was previously saved. */
  | { type: "design-system-loaded"; stored: StoredDesignSystem }
  /**
   * Ack for "save-design-system". `ok: false` means clientStorage declined
   * it (over size, or a genuine storage error) — the UI still has the CSS in
   * memory for this session, it just won't survive a reload.
   */
  | { type: "design-system-saved"; ok: boolean; reason?: string };
