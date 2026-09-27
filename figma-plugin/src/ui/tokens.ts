/**
 * Design-token extraction and reverse matching.
 *
 * Claude Design ships its design system as CSS custom properties under
 * `_ds/<system>/tokens/*.css`, with a semantic layer aliasing a primitive
 * ramp:
 *
 *     --acme-green-700: #1B6F58;      // primitive
 *     --primary: var(--acme-green-700); // semantic alias
 *
 * Generic HTML->Figma importers bake `#1B6F58` onto a rectangle, which is
 * exactly the thing a designer then has to undo by hand. We instead keep the
 * token identity so the builder can bind a real Figma Variable.
 *
 * Two matching paths, in confidence order:
 *   1. `var` — the element's own declaration literally referenced the token.
 *   2. `value-match` — the computed literal equals a token's resolved value.
 *
 * Path 2 matters more than it looks: Claude Design frequently emits resolved
 * hex in inline styles even when a system token exists for that value.
 */

import type {
  IRColor,
  IRShadow,
  IRShadowToken,
  IRSurface,
  IRSurfaceValue,
  IRTokenDefinition,
  TokenCategory,
  TokenRef,
} from "../ir";

const VAR_REF = /var\(\s*(--[A-Za-z0-9-_]+)\s*(?:,([^)]*))?\)/g;

export type TokenIndex = {
  definitions: IRTokenDefinition[];
  /**
   * Custom property name (no dashes) -> definition.
   *
   * BASE LAYER ONLY, and it has to stay that way. `matchTokenByVar` below
   * rejects a name match whose colour disagrees with what actually rendered
   * precisely because a scoped surface can hold a different value under the
   * same name. Writing `.acme-deck`'s `--background` in here inverts that
   * guard and binds deck's value onto product-surface elements. Surface values
   * live on `IRTokenDefinition.bySurface` and are read only by the builder.
   */
  byName: Map<string, IRTokenDefinition>;
  /** Normalised colour key ("r,g,b,a") -> definitions, best candidate first. Base layer only. */
  byColor: Map<string, IRTokenDefinition[]>;
  /** Numeric px value -> definitions. Base layer only. */
  byFloat: Map<number, IRTokenDefinition[]>;
  systemName: string;
  /**
   * Themed surfaces, in mode order: the ones this document declares itself
   * first, then the manifest's. Absent when there are neither.
   */
  surfaces?: IRSurface[];
  /** The manifest's `namespace`, the stable identity for an idempotent re-import. */
  key?: string;
  /** Shadow tokens, which become EffectStyles rather than variables. */
  shadows?: IRShadowToken[];

  // Everything below exists only when the document declares a re-theme axis of
  // its own (`detectThemeAxis`). The three maps above stay base-layer only, and
  // these are the parallel, scope-keyed set the extractor reaches for when, and
  // only when, the node it is measuring sits inside one of `themeScopes`.

  /** Selectors of the detected mode axis, in document order. `[".cd2f-theme-light", ".cd2f-theme-dark"]`. */
  themeScopes?: string[];
  /**
   * Per-theme name index: selector -> name -> definition.
   *
   * Deliberately not merged into `byName`: `matchTokenByVar`'s guard rejects a
   * name match whose colour disagrees with what rendered, and that guard holds
   * only while `byName` is the base layer alone. A caller reaches this map only
   * by passing a scope, which is a promise that it is comparing against that
   * scope's value rather than the base one.
   */
  byNameInScope?: Map<string, Map<string, IRTokenDefinition>>;
  /**
   * Per-theme colour index: selector -> colour key -> definitions.
   *
   * Holds every definition at its EFFECTIVE value inside that theme
   * (`bySurface[selector]` when the theme re-themes it, the base value
   * otherwise), so a lookup inside a theme is complete on its own and must not
   * fall back to `byColor`. `#7e7e7e` is `--figma-color-text-tertiary` in dark
   * and nothing at all in light, and a fallback would answer the light question
   * with the dark token.
   */
  byColorInScope?: Map<string, Map<string, IRTokenDefinition[]>>;
  /** The same idea for numeric tokens, so a re-themed radius cannot bind to the base ramp. */
  byFloatInScope?: Map<string, Map<number, IRTokenDefinition[]>>;

  /**
   * How to tell which of the axis selectors is switched on for the WHOLE page,
   * when the axis is a root re-theme (`detectRootAxis`) rather than a pair of
   * classes a subtree carries. Present only for that kind of axis.
   */
  rootThemes?: Array<{ selector: string; activation: RootActivation }>;
  /**
   * What to call the base mode when the base layer is itself a theme the
   * document names by implication: `:root` beside `:root[data-theme="dark"]`
   * is the light theme, so the base mode is "Light" rather than a generic name.
   */
  baseModeLabel?: string;
};

/**
 * What switches a root re-theme on. Claude Design documents flip the whole page
 * three ways: an attribute on `<html>` (`:root[data-theme="dark"]`, set by the
 * document's own script from a `theme` prop), a class on `<html>`
 * (`:root.dark`), or the OS colour scheme (`@media (prefers-color-scheme:
 * dark) { :root { … } }`).
 */
export type RootActivation =
  | { kind: "attr"; name: string; value?: string }
  | { kind: "class"; name: string }
  | { kind: "media"; scheme: "dark" | "light" };

/** One single-class block of custom properties, e.g. `.cd2f-theme-dark { … }`. */
type ScopedBlock = {
  selector: string;
  declarations: Map<string, string>;
  /** Set only on a root re-theme block, which no element's class list can reveal. */
  activation?: RootActivation;
};

type CollectedProperties = {
  /** The base layer: `:root`, `html`, `*, :root`. */
  root: Map<string, string>;
  /** Single-class blocks in document order, several blocks on one selector merged. */
  scoped: ScopedBlock[];
  /** Root re-themes (`:root[data-theme="dark"]`, `@media (prefers-color-scheme)`), same shape. */
  rootVariants: ScopedBlock[];
};

/**
 * Read the custom properties the imported document declares, base layer and
 * class-scoped blocks alike.
 *
 * Scoped to the stylesheets the document actually brought with it, NOT
 * `document.styleSheets`. The imported markup is mounted into the plugin's own
 * page, and Figma injects its entire UI theme there as `--figma-color-*`
 * custom properties on :root when `themeColors` is on. Reading the whole
 * document swept roughly 170 of Figma's own variables into the user's design
 * system: a real import created 299 variables for a document with 131 tokens.
 */
function collectCustomProperties(
  sheets: CSSStyleSheet[],
): CollectedProperties {
  const out: CollectedProperties = { root: new Map(), scoped: [], rootVariants: [] };
  const byScope = new Map<string, ScopedBlock>();

  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // Cross-origin stylesheet; skip rather than fail the whole import.
      continue;
    }
    if (!rules) continue;
    collectFromRules(rules, out, byScope);
  }

  return out;
}

/**
 * A selector we are willing to read as a theme: exactly one class, nothing else.
 *
 * `.cd2f-theme-dark` yes, `.card .title` no, `.a, .b` no. A compound or
 * descendant selector describes a place in one tree rather than a theme applied
 * to a whole subtree, and a mode has to be something a single frame can carry.
 */
const SINGLE_CLASS = /^\.[A-Za-z_][A-Za-z0-9_-]*$/;

function collectFromRules(
  rules: CSSRuleList,
  out: CollectedProperties,
  byScope: Map<string, ScopedBlock>,
  scheme?: "dark" | "light",
): void {
  for (const rule of Array.from(rules)) {
    const styleRule = rule as CSSStyleRule;

    if (styleRule.selectorText && styleRule.style) {
      const selector = styleRule.selectorText.trim();
      const isRoot =
        selector === ":root" || selector === "html" || selector === "*, :root";
      // A class-scoped block is read but kept apart from the base layer. Two
      // such blocks declaring the same names with different values are a mode
      // axis (`detectThemeAxis`); anything else still resolves as a literal,
      // which is what it did before this existed.
      const scoped = !isRoot && !scheme && SINGLE_CLASS.test(selector);
      // A root re-theme is kept apart for the same reason, and it matters more:
      // read into the base layer, `@media (prefers-color-scheme: dark) :root`
      // silently overwrites every light value with its dark one.
      const variant = scheme
        ? isRoot
          ? {
              key: `@media (prefers-color-scheme: ${scheme})`,
              activation: { kind: "media", scheme } as RootActivation,
            }
          : null
        : isRoot
          ? null
          : parseRootVariant(selector);

      if (isRoot || scoped || variant) {
        let block: ScopedBlock | undefined;
        if (variant) {
          block = byScope.get(variant.key);
          if (!block) {
            block = { selector: variant.key, declarations: new Map(), activation: variant.activation };
            byScope.set(variant.key, block);
            out.rootVariants.push(block);
          }
        } else if (scoped) {
          block = byScope.get(selector);
          if (!block) {
            block = { selector, declarations: new Map() };
            byScope.set(selector, block);
            out.scoped.push(block);
          }
        }

        for (let i = 0; i < styleRule.style.length; i++) {
          const prop = styleRule.style[i];
          if (!prop.startsWith("--")) continue;
          const value = styleRule.style.getPropertyValue(prop).trim();
          if (block) block.declarations.set(prop.slice(2), value);
          else out.root.set(prop.slice(2), value);
        }
      }
    }

    // Recurse into @media / @supports / @layer *and* into CSS-nesting children.
    // Since Chrome 112 a plain CSSStyleRule also exposes `cssRules`, so this
    // cannot be an `else` — testing for `cssRules` first would skip every
    // ordinary rule in the sheet and find no tokens at all.
    const nested = (rule as CSSGroupingRule).cssRules;
    if (nested && nested.length > 0) {
      const condition = (rule as CSSMediaRule).conditionText ?? "";
      const match = /prefers-color-scheme\s*:\s*(dark|light)/i.exec(condition);
      const inner = match ? (match[1].toLowerCase() as "dark" | "light") : scheme;
      collectFromRules(nested, out, byScope, inner);
    }
  }
}

/**
 * `:root[data-theme="dark"]`, `html[data-theme=dark]`, `[data-theme="dark"]`,
 * `:root.dark`: a theme switched on for the whole page. A comma list counts
 * when every part switches the same thing (`:root[data-theme="dark"],
 * [data-theme="dark"]`). Keyed canonically so two spellings of one theme
 * collect into one block.
 */
const ROOT_ATTR =
  /^(?::root|html)?\[\s*([A-Za-z_][\w-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s"']+)))?\s*\]$/;
const ROOT_CLASS = /^(?::root|html)\.([A-Za-z_][\w-]*)$/;

function parseRootVariant(
  selector: string,
): { key: string; activation: RootActivation } | null {
  let found: { key: string; activation: RootActivation } | null = null;
  for (const part of selector.split(",").map((p) => p.trim())) {
    let next: { key: string; activation: RootActivation } | null = null;
    const attr = ROOT_ATTR.exec(part);
    if (attr) {
      const value = attr[2] ?? attr[3] ?? attr[4];
      next = {
        key: value === undefined ? `:root[${attr[1]}]` : `:root[${attr[1]}="${value}"]`,
        activation: { kind: "attr", name: attr[1], value },
      };
    } else {
      const cls = ROOT_CLASS.exec(part);
      if (cls) next = { key: `:root.${cls[1]}`, activation: { kind: "class", name: cls[1] } };
    }
    if (!next || (found && found.key !== next.key)) return null;
    found = next;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Document-declared re-themes
// ---------------------------------------------------------------------------

/**
 * How alike two blocks' name sets must be to count as the same mode axis.
 *
 * Jaccard, |A ∩ B| / |A ∪ B|. `Portage Panel.dc.html`'s light and dark blocks
 * declare exactly the same fifteen names and score 1.0; 0.8 is slack for the
 * ordinary case of one theme leaving a property at its inherited value, and
 * still refuses two blocks that merely happen to share a colour or two.
 */
const AXIS_NAME_OVERLAP = 0.8;

/**
 * Names a group has to share before it is a theme rather than a component.
 *
 * `.btn-primary { --bg: blue }` beside `.btn-danger { --bg: red }` is a variant,
 * not a theme, and turning it into Figma modes would put "Primary" and "Danger"
 * on a collection that has nothing to do with either. A theme re-declares a set:
 * this export's is fifteen names wide. Three is the floor, low enough for a
 * small hand-written light/dark pair and high enough to leave one-property
 * variants alone.
 */
const AXIS_MIN_SHARED_NAMES = 3;

type ThemeAxis = {
  surfaces: IRSurface[];
  /** Declarations per selector, index-aligned with `surfaces`. */
  declarations: Map<string, Map<string, string>>;
};

/**
 * Find the mode axis a document declares in its own stylesheet, if any.
 *
 * Claude Design documents routinely ship their whole theme as two class-scoped
 * blocks and no `:root` at all: `Portage Panel.dc.html` declares fifteen
 * `--figma-color-*` properties under `.cd2f-theme-light` and the same fifteen,
 * with different values, under `.cd2f-theme-dark`. Read as literals that is
 * every themed fill in the document arriving as raw hex, which is what a user
 * reported after a build reported 182 new variables and bound none of them to
 * the panel's text.
 *
 * Two blocks declaring the SAME names with DIFFERENT values is the exact shape a
 * Figma variable mode exists to express, so they are routed through the surface
 * machinery S7 already built for `_ds_manifest.json`'s themes.
 *
 * ONE axis, never several. Figma modes are a single axis per collection, so a
 * document with two independent ones cannot have both expressed correctly and
 * guessing which pairs with which would be worse than picking the widest.
 */
function detectThemeAxis(blocks: ScopedBlock[]): ThemeAxis | undefined {
  const candidates = blocks.filter(
    (block) => block.declarations.size >= AXIS_MIN_SHARED_NAMES,
  );
  if (candidates.length < 2) return undefined;

  let best: ScopedBlock[] = [];
  let bestShared = 0;

  for (let i = 0; i < candidates.length; i++) {
    const seed = candidates[i];
    const seedNames = new Set(seed.declarations.keys());
    const group = [seed];
    let shared = seedNames.size;

    for (let j = i + 1; j < candidates.length; j++) {
      const other = candidates[j];
      const otherNames = new Set(other.declarations.keys());
      let intersection = 0;
      for (const name of otherNames) if (seedNames.has(name)) intersection++;
      const union = seedNames.size + otherNames.size - intersection;
      if (intersection < AXIS_MIN_SHARED_NAMES) continue;
      if (union === 0 || intersection / union < AXIS_NAME_OVERLAP) continue;
      group.push(other);
      shared = Math.min(shared, intersection);
    }

    // Tested per candidate rather than once on the winner. A group that cannot
    // differ is not a worse axis, it is not an axis, and letting it into the
    // running lets a wide alias pair outrank the real theme and take detection
    // down with it when it is rejected at the end.
    if (groupDiffers(group) && shared > bestShared) {
      best = group;
      bestShared = shared;
    }
  }

  if (best.length === 0) return undefined;

  const labels = axisLabels(best.map((block) => block.selector));
  return {
    surfaces: best.map((block, i) => ({ selector: block.selector, label: labels[i] })),
    declarations: new Map(best.map((block) => [block.selector, block.declarations])),
  };
}

/**
 * Two or more blocks, at least one shared name held at two different values.
 *
 * Both halves are the definition of an axis rather than checks on top of one. A
 * single block has no second value for a mode to hold. Several blocks agreeing
 * on every value are aliases for one look, and a mode built from them could
 * never differ from the mode beside it.
 */
function groupDiffers(group: ScopedBlock[]): boolean {
  if (group.length < 2) return false;
  return group.some((block, i) =>
    i > 0 &&
    [...block.declarations].some(([name, value]) => {
      const first = group[0].declarations.get(name);
      return first !== undefined && first !== value;
    }),
  );
}

/**
 * Find the theme a document switches on for its whole page, if any.
 *
 * The shape Claude Design now writes by default, and the one `detectThemeAxis`
 * cannot see because nothing in it is a class a subtree carries:
 *
 *     :root                    { --ink: rgb(35,37,35);   … }
 *     :root[data-theme="dark"] { --ink: rgb(240,240,233); … }
 *
 * with the document's own script setting `data-theme` from a `theme` prop that
 * defaults to "system". Read as before, the base layer held the light values,
 * the page rendered dark whenever the OS was dark, and a real export bound 0 of
 * its 84 layers.
 *
 * Two shapes count. Variants that re-declare the base layer's names (the one
 * above: the base mode is the default theme). And, with no base layer to speak
 * of, two or more variants that re-declare each other's names
 * (`[data-theme="light"]` / `[data-theme="dark"]`): the base mode then holds the
 * first one's values, exactly as a class pair with no `:root` does.
 *
 * One axis: variants are grouped by what switches them (the attribute's name,
 * a class, the colour scheme) and the widest group wins.
 */
type RootAxis = {
  blocks: ScopedBlock[];
  baseModeLabel?: string;
};

function detectRootAxis(
  root: Map<string, string>,
  variants: ScopedBlock[],
): RootAxis | undefined {
  const families = new Map<string, ScopedBlock[]>();
  for (const block of variants) {
    if (block.declarations.size < AXIS_MIN_SHARED_NAMES) continue;
    const a = block.activation!;
    const family = a.kind === "attr" ? `attr:${a.name}` : a.kind;
    families.set(family, [...(families.get(family) ?? []), block]);
  }

  let best: RootAxis | undefined;
  let bestShared = 0;

  for (const blocks of families.values()) {
    // Over the base layer: a variant has to re-declare what `:root` declares,
    // at a value that actually differs somewhere.
    const overBase = blocks.filter((block) => {
      let shared = 0;
      let differs = false;
      for (const [name, value] of block.declarations) {
        const base = root.get(name);
        if (base === undefined) continue;
        shared++;
        if (base !== value) differs = true;
      }
      return (
        differs &&
        shared >= AXIS_MIN_SHARED_NAMES &&
        shared / block.declarations.size >= AXIS_NAME_OVERLAP
      );
    });

    if (overBase.length > 0) {
      const shared = Math.min(...overBase.map((b) => b.declarations.size));
      if (shared > bestShared) {
        best = { blocks: overBase, baseModeLabel: impliedBaseLabel(rootLabels(overBase)) };
        bestShared = shared;
      }
      continue;
    }

    // No base layer to re-theme: the variants are the whole theme, and they
    // have to agree on names with each other instead.
    if (blocks.length < 2) continue;
    const seed = new Set(blocks[0].declarations.keys());
    const group = blocks.filter((block) => {
      let intersection = 0;
      for (const name of block.declarations.keys()) if (seed.has(name)) intersection++;
      const union = seed.size + block.declarations.size - intersection;
      return intersection >= AXIS_MIN_SHARED_NAMES && intersection / union >= AXIS_NAME_OVERLAP;
    });
    if (group.length >= 2 && groupDiffers(group)) {
      const shared = Math.min(...group.map((b) => b.declarations.size));
      if (shared > bestShared) {
        best = { blocks: group };
        bestShared = shared;
      }
    }
  }

  return best;
}

/** "Dark" for `:root[data-theme="dark"]`, `:root.theme-dark`, the dark colour scheme. */
function rootLabels(blocks: ScopedBlock[]): string[] {
  const labels = blocks.map((block) => {
    const a = block.activation!;
    const raw =
      a.kind === "media"
        ? a.scheme
        : a.kind === "class"
          ? a.name
          : (a.value ?? a.name.replace(/^data-/, ""));
    const parts = raw
      .split(/[-_\s]+/)
      .filter((p) => p && !/^(theme|mode|scheme|color)$/i.test(p));
    return titleCase(parts.length > 0 ? parts : [raw]);
  });
  return new Set(labels).size === labels.length ? labels : blocks.map((b) => b.selector);
}

/** The base layer beside a lone "Dark" is the light theme, and the reverse. */
function impliedBaseLabel(labels: string[]): string | undefined {
  const has = (l: string) => labels.some((label) => label.toLowerCase() === l);
  if (has("dark") && !has("light")) return "Light";
  if (has("light") && !has("dark")) return "Dark";
  return undefined;
}

/**
 * Mode names a designer recognises, from the selectors themselves.
 *
 * `.cd2f-theme-light` and `.cd2f-theme-dark` share the segments "cd2f" and
 * "theme", which say nothing about either mode and everything about the export
 * that emitted them, so they come off and what is left is titled: "Light" and
 * "Dark". Common trailing segments go the same way, since `.light-theme` /
 * `.dark-theme` is the other half of the same convention.
 *
 * When stripping leaves nothing, or leaves two modes with one name, the full
 * slug is titled instead: a mode called "Theme" twice is worse than one called
 * "Cd2f Theme Light", which is at least unambiguous and renameable.
 */
function axisLabels(selectors: string[]): string[] {
  const slugs = selectors.map((selector) => selector.slice(1));
  const parts = slugs.map((slug) => slug.split(/[-_]+/).filter(Boolean));

  let lead = 0;
  while (parts.every((p) => p.length > lead + 1 && p[lead] === parts[0][lead])) lead++;

  let tail = 0;
  while (
    parts.every(
      (p) =>
        p.length > lead + tail + 1 &&
        p[p.length - 1 - tail] === parts[0][parts[0].length - 1 - tail],
    )
  ) {
    tail++;
  }

  const stripped = parts.map((p) => p.slice(lead, p.length - tail));
  const labels = stripped.map((p) => titleCase(p));
  const usable =
    labels.every((label) => label.length > 0) &&
    new Set(labels).size === labels.length;

  return usable ? labels : parts.map((p) => titleCase(p));
}

function titleCase(segments: string[]): string {
  return segments
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

/**
 * Resolve `var(--a)` chains to concrete values.
 *
 * `lookup` rather than a plain map because a themed surface resolves its own
 * names first and only then reaches through to the base layer: `.acme-deck`'s
 * `--color-bg: var(--ink-25)` must find deck's `--ink-25`, while its
 * `--font-sans: var(--font-deck-body)` has to fall through to `:root`.
 *
 * Cycles are broken by depth-limiting rather than by cycle detection: a cyclic
 * token is unusable either way, and the limit keeps this total.
 */
function resolveValue(
  raw: string,
  lookup: (name: string) => string | undefined,
  depth = 0,
): string {
  if (depth > 12) return raw;
  if (!raw.includes("var(")) return raw;

  return resolveValue(
    raw.replace(VAR_REF, (_match, ref: string, fallback?: string) => {
      const next = lookup(ref.slice(2));
      if (next !== undefined) return next;
      return fallback !== undefined ? fallback.trim() : "";
    }),
    lookup,
    depth + 1,
  );
}

/** `--acme-green-700` -> `color/acme-green/700`. */
function tokenPath(name: string, kind: IRTokenDefinition["kind"]): string {
  const group =
    kind === "COLOR" ? "color" : kind === "FLOAT" ? "number" : "string";

  // Split a trailing numeric step ("green-700" -> "green" / "700") so ramps
  // become proper Figma variable groups instead of one flat list.
  const rampMatch = name.match(/^(.*?)-(\d{2,4})$/);
  if (rampMatch) return `${group}/${rampMatch[1]}/${rampMatch[2]}`;

  return `${group}/${name}`;
}

/**
 * Turn one custom property into a token definition, or drop it.
 *
 * `aliasOf` is read from the RAW value, not the resolved one: `var(--neutral-0)`
 * is the semantic layer pointing at a primitive, and that arrow is the whole
 * structure a design system has.
 */
function classify(
  name: string,
  raw: string,
  lookup: (ref: string) => string | undefined,
): IRTokenDefinition | null {
  const resolved = resolveValue(raw, lookup).trim();
  if (!resolved) return null;

  const directAlias = raw.trim().match(/^var\(\s*--([A-Za-z0-9-_]+)\s*\)$/);
  const aliasOf = directAlias ? directAlias[1] : undefined;
  const color = parseColor(resolved);

  if (color) {
    return { name, path: tokenPath(name, "COLOR"), kind: "COLOR", resolved, aliasOf, color };
  }

  const float = parsePx(resolved);
  if (float !== null) {
    return { name, path: tokenPath(name, "FLOAT"), kind: "FLOAT", resolved, aliasOf, float };
  }

  // A font stack is the one comma-separated value with a real Figma equivalent:
  // `fontFamily` takes a single family, and the build path takes the first one
  // (`firstFontFamily`, src/plugin/mapping.ts). `resolved` deliberately keeps
  // the whole stack, because the IR should say what the CSS says. Parens are
  // still disqualifying, which is what keeps gradients, shadow lists and
  // cubic-beziers out.
  if (!resolved.includes("(") && FONT_FAMILY_NAME.test(name)) {
    return { name, path: tokenPath(name, "STRING"), kind: "STRING", resolved, aliasOf };
  }

  // Anything left that is not a bare keyword — gradients, shadow lists,
  // transitions — has no Figma variable equivalent. Claude Design marks these
  // `@kind other` in the source, but CSSOM strips comments before we ever see
  // the declaration, so they are identified by shape instead (or, when the
  // export shipped `_ds_manifest.json`, recovered exactly — see
  // `annotatedOtherNames`).
  if (resolved.includes("(") || resolved.includes(",")) return null;

  return { name, path: tokenPath(name, "STRING"), kind: "STRING", resolved, aliasOf };
}

export function buildTokenIndex(
  sheets: CSSStyleSheet[],
  systemName: string,
  manifestJson?: string,
): TokenIndex {
  const collected = collectCustomProperties(sheets);
  const raws = collected.root;
  const manifest = parseDsManifest(manifestJson);
  const baseLookup = (ref: string) => raws.get(ref);

  // `@kind other` is an author's explicit "this is not a token". Sixteen of
  // this export's twenty-eight survive the shape heuristic above and would
  // become bogus variables — `--dur-fast: 150ms`, `--fw-bold: 700` — so when
  // the manifest is there, it wins over the heuristic.
  const suppressed = manifest ? annotatedOtherNames(manifest, "") : undefined;

  const definitions: IRTokenDefinition[] = [];
  for (const [name, raw] of raws) {
    if (suppressed?.has(name)) continue;
    const def = classify(name, raw, baseLookup);
    if (!def) continue;
    def.category = categoryOf(name, def, manifest);
    def.buildPath = buildPathFor(name, def.category);
    definitions.push(def);
  }

  // Built BEFORE the surface pass appends anything, which is what keeps these
  // three maps base-layer only. See the TokenIndex.byName comment.
  const byName = new Map(definitions.map((d) => [d.name, d]));
  const byColor = new Map<string, IRTokenDefinition[]>();
  const byFloat = new Map<number, IRTokenDefinition[]>();

  for (const def of definitions) {
    if (def.kind === "COLOR" && def.color) {
      const key = colorKey(def.color);
      const list = byColor.get(key) ?? [];
      list.push(def);
      byColor.set(key, list);
    } else if (def.kind === "FLOAT" && def.float !== undefined) {
      const list = byFloat.get(def.float) ?? [];
      list.push(def);
      byFloat.set(def.float, list);
    }
  }

  // When several tokens share a value, prefer the primitive (the one nothing
  // aliases through) so Figma gets `acme-green/700` rather than whichever
  // semantic name happened to sort first. Semantic tokens still reach the file
  // as aliases pointing at that primitive.
  for (const list of byColor.values()) list.sort(preferPrimitive);
  for (const list of byFloat.values()) list.sort(preferPrimitive);

  // Themes this document declares itself come FIRST in mode order. A partial
  // mode budget is spent from the front, and the themes a node in THIS document
  // can actually sit under are worth more than the design system's other
  // product surfaces, which nothing here is rendered inside.
  //
  // A class pair wins over a root re-theme when a document somehow has both:
  // one axis per collection, and the class pair is what S7's modes were built
  // and tested against.
  const classAxis = detectThemeAxis(collected.scoped);
  const rootAxis = classAxis ? undefined : detectRootAxis(raws, collected.rootVariants);
  const rootLabelList = rootAxis ? rootLabels(rootAxis.blocks) : [];
  const axis: ThemeAxis | undefined =
    classAxis ??
    (rootAxis
      ? {
          surfaces: rootAxis.blocks.map((block, i) => ({
            selector: block.selector,
            label: rootLabelList[i],
          })),
          declarations: new Map(rootAxis.blocks.map((block) => [block.selector, block.declarations])),
        }
      : undefined);
  const scopes: ScopedDeclarations[] = [];
  for (const surface of axis?.surfaces ?? []) {
    const declarations = axis!.declarations.get(surface.selector)!;
    scopes.push({
      surface,
      tokens: [...declarations].map(([name, value]) => ({ name, value })),
    });
  }
  for (const surface of manifest?.themes ?? []) {
    scopes.push({ surface, tokens: manifest!.byScope.get(surface.selector) ?? [] });
  }

  const index: TokenIndex = {
    definitions,
    byName,
    byColor,
    byFloat,
    systemName,
    shadows: collectShadowTokens(raws, scopes, manifest),
  };

  if (manifest) index.key = manifest.namespace;
  if (scopes.length > 0) {
    index.surfaces = scopes.map((scope) => scope.surface);
    applySurfaces(definitions, scopes, raws, manifest);
  }
  if (axis) indexByScope(index, axis.surfaces.map((surface) => surface.selector));
  if (rootAxis) {
    index.rootThemes = rootAxis.blocks.map((block) => ({
      selector: block.selector,
      activation: block.activation!,
    }));
    if (rootAxis.baseModeLabel) index.baseModeLabel = rootAxis.baseModeLabel;
  }

  return index;
}

/**
 * Build the per-theme lookups the extractor uses inside a themed subtree.
 *
 * Only for a DETECTED axis. A manifest surface never gets one, and that is the
 * difference that keeps `test/fixture/scoped.html` behaving as S7 shipped it:
 * a lone `.acme-deck` block is not an axis, so a node under it still falls
 * through `matchTokenByVar`'s colour guard to a value match rather than binding
 * the `:root` token it names.
 */
function indexByScope(index: TokenIndex, selectors: string[]): void {
  index.themeScopes = selectors;
  index.byNameInScope = new Map();
  index.byColorInScope = new Map();
  index.byFloatInScope = new Map();

  for (const selector of selectors) {
    const byName = new Map<string, IRTokenDefinition>();
    const byColor = new Map<string, IRTokenDefinition[]>();
    const byFloat = new Map<number, IRTokenDefinition[]>();

    for (const def of index.definitions) {
      // A token private to a DIFFERENT surface is not reachable from here. The
      // deck's `--ink-0` lives under `.acme-deck` and an element in a light or
      // dark panel is not inside one, so offering it as a candidate binds a
      // panel's white text to a deck variable that holds white in every mode:
      // right on the canvas today, wrong the moment the mode is switched. Same
      // rule as `isBaseLayer` on the mode (a) path.
      const declaredIn = def.declaredIn;
      if (declaredIn && !declaredIn.includes("") && !declaredIn.includes(selector)) continue;

      // The value this token actually resolves to for an element inside this
      // theme: the theme's own where it re-themes the name, the base value
      // where it does not. That IS the CSS cascade, and it is what makes a
      // lookup here complete enough to need no fallback.
      const value = def.bySurface?.[selector];
      const color = value ? value.color : def.color;
      const float = value ? value.float : def.float;

      byName.set(def.name, def);

      if (color) {
        const key = colorKey(color);
        const list = byColor.get(key) ?? [];
        list.push(def);
        byColor.set(key, list);
      } else if (float !== undefined) {
        const list = byFloat.get(float) ?? [];
        list.push(def);
        byFloat.set(float, list);
      }
    }

    for (const list of byColor.values()) list.sort(preferPrimitive);
    for (const list of byFloat.values()) list.sort(preferPrimitive);

    index.byNameInScope.set(selector, byName);
    index.byColorInScope.set(selector, byColor);
    index.byFloatInScope.set(selector, byFloat);
  }
}

function preferPrimitive(a: IRTokenDefinition, b: IRTokenDefinition): number {
  const aAlias = a.aliasOf ? 1 : 0;
  const bAlias = b.aliasOf ? 1 : 0;
  if (aAlias !== bAlias) return aAlias - bAlias;
  // Shorter names read as more primitive within the same tier.
  return a.name.length - b.name.length;
}

export function colorKey(c: IRColor): string {
  return `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(
    c.b * 255,
  )},${c.a.toFixed(3)}`;
}

// ---------------------------------------------------------------------------
// _ds_manifest.json — surfaces, annotations, categories
// ---------------------------------------------------------------------------

type DsManifestToken = {
  /** Custom property name, leading dashes already stripped. */
  name: string;
  value: string;
  kind?: string;
  /** Theme selector this declaration sits under. `""` is the base (:root) layer. */
  scope: string;
  annotation?: string;
};

type DsManifest = {
  namespace?: string;
  themes: IRSurface[];
  byScope: Map<string, DsManifestToken[]>;
  /** Manifest `kind` per name, first declaration winning. A hint only, see `categoryOf`. */
  kindByName: Map<string, string>;
};

/**
 * Read the export's `_ds_manifest.json`.
 *
 * Defensive throughout: this arrives as a file from someone's disk, and a
 * manifest we cannot make sense of has to degrade to "no manifest" rather than
 * fail the import. Everything the caller reads is validated here so nothing
 * downstream has to re-check it.
 */
function parseDsManifest(json: string | undefined): DsManifest | undefined {
  if (!json) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;

  const source = raw as {
    namespace?: unknown;
    themes?: unknown;
    tokens?: unknown;
  };
  if (!Array.isArray(source.tokens)) return undefined;

  const themes: IRSurface[] = [];
  if (Array.isArray(source.themes)) {
    for (const entry of source.themes) {
      const theme = entry as { selector?: unknown; label?: unknown };
      if (typeof theme.selector !== "string" || !theme.selector) continue;
      themes.push({
        selector: theme.selector,
        label: typeof theme.label === "string" && theme.label ? theme.label : theme.selector,
      });
    }
  }

  const byScope = new Map<string, DsManifestToken[]>();
  const kindByName = new Map<string, string>();

  for (const entry of source.tokens) {
    const token = entry as {
      name?: unknown;
      value?: unknown;
      kind?: unknown;
      scope?: unknown;
      annotation?: unknown;
    };
    if (typeof token.name !== "string" || typeof token.value !== "string") continue;

    const name = token.name.replace(/^--/, "");
    const scope = typeof token.scope === "string" ? token.scope : "";
    const parsed: DsManifestToken = {
      name,
      value: token.value,
      kind: typeof token.kind === "string" ? token.kind : undefined,
      scope,
      annotation: typeof token.annotation === "string" ? token.annotation : undefined,
    };

    const list = byScope.get(scope);
    if (list) list.push(parsed);
    else byScope.set(scope, [parsed]);

    if (parsed.kind && !kindByName.has(name)) kindByName.set(name, parsed.kind);
  }

  if (byScope.size === 0) return undefined;

  return {
    namespace: typeof source.namespace === "string" ? source.namespace : undefined,
    themes,
    byScope,
    kindByName,
  };
}

/** Names the author marked `@kind other` in one scope — never a variable, whatever their shape. */
function annotatedOtherNames(manifest: DsManifest, scope: string): Set<string> {
  const out = new Set<string>();
  for (const token of manifest.byScope.get(scope) ?? []) {
    if (token.annotation === "other") out.add(token.name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Categories and build paths
// ---------------------------------------------------------------------------

/** `--font-sans`, `--font-deck-body`. A comma in one of these is a font stack, not a list value. */
const FONT_FAMILY_NAME = /^font(-|$)/;

/**
 * Category by name, in priority order.
 *
 * Name before manifest `kind`, because the manifest's is measurably a hint and
 * not a classification: in this export `--fs-h1` is `spacing`, `--r-md` is
 * `spacing`, `--fw-bold` is `other`, and `--lh-body` is `other` under
 * `.acme-deck` while being `spacing` under `.acme-email`. Feeding that into
 * a radius-versus-spacing decision would file font sizes under `space/`.
 */
const CATEGORY_BY_NAME: Array<[RegExp, TokenCategory]> = [
  [/^shadow(-|$)/, "shadow"],
  [/^(radius|r)(-|$)|^rounded/, "radius"],
  [/^(space|s)(-|$)|^gap(-|$)|padding|width|gutter|inset/, "spacing"],
  [/^(text|fs)(-|$)|^(leading|lh)(-|$)|^(tracking|ls)(-|$)|^(font|fw)(-|$)/, "font"],
];

const MANIFEST_CATEGORIES: Record<string, TokenCategory> = {
  color: "color",
  spacing: "spacing",
  radius: "radius",
  font: "font",
  shadow: "shadow",
};

function categoryOf(
  name: string,
  def: IRTokenDefinition,
  manifest: DsManifest | undefined,
): TokenCategory {
  // Shape wins on colour: `--sky-600` and `--tag-jade` match no name pattern,
  // and a value that parses as a colour cannot be anything else.
  if (def.kind === "COLOR") return "color";

  for (const [pattern, category] of CATEGORY_BY_NAME) {
    if (pattern.test(name)) return category;
  }

  const declared = manifest?.kindByName.get(name);
  return (declared && MANIFEST_CATEGORIES[declared]) || "other";
}

/** Font tokens split further, because Figma binds sizes, leading and tracking to different fields. */
const FONT_SUBKINDS: Array<[RegExp, string]> = [
  [/^(text|fs)(-|$)/, "size"],
  [/^(leading|lh)(-|$)/, "leading"],
  [/^(tracking|ls)(-|$)/, "tracking"],
  [/^fw(-|$)/, "weight"],
  [/^font(-|$)/, "family"],
];

/** Strip a leading name prefix; a name that is nothing but its prefix becomes "default". */
function stripPrefix(name: string, prefix: RegExp): string {
  const stripped = name.replace(prefix, "");
  return stripped || "default";
}

/** `acme-green-700` -> `acme-green/700`. Any trailing run of digits, not just 2-4 of them. */
function rampSplit(leaf: string): string {
  const match = leaf.match(/^(.*[^-])-(\d+)$/);
  return match ? `${match[1]}/${match[2]}` : leaf;
}

/**
 * The build path's grouping, which is free to be better than `path`.
 *
 * `path` is a matching identity and must not move (see IRTokenDefinition).
 * This one groups by what the token is for rather than by its Figma type, and
 * splits a ramp step at any length, which is what stops `--neutral-0` and
 * `--chart-1` being stranded outside their own ramps by `tokenPath`'s
 * two-to-four-digit floor.
 */
export function buildPathFor(name: string, category: TokenCategory): string {
  switch (category) {
    case "color":
      return `color/${rampSplit(name)}`;
    case "radius":
      return `radius/${rampSplit(stripPrefix(name, /^(radius|r)(-|$)/))}`;
    case "spacing": {
      const leaf = stripPrefix(name, /^(space|s)(-|$)/);
      // `--space-0-5` is a half step, not a ramp: `space/0.5` reads as the
      // scale it is, `space/0/5` reads as two groups.
      const half = leaf.match(/^(\d+)-(\d+)$/);
      return `space/${half ? `${half[1]}.${half[2]}` : rampSplit(leaf)}`;
    }
    case "font": {
      for (const [pattern, subkind] of FONT_SUBKINDS) {
        if (pattern.test(name)) return `type/${subkind}/${stripPrefix(name, pattern)}`;
      }
      return `type/size/${name}`;
    }
    case "shadow":
      return `shadow/${stripPrefix(name, /^shadow(-|$)/)}`;
    default:
      return `other/${name}`;
  }
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * One theme's declarations, whatever wrote them down.
 *
 * `_ds_manifest.json` and a document's own class-scoped blocks describe the same
 * thing in two formats, and everything downstream of this type is indifferent
 * to which one it came from. That is the whole point: modes, per-mode aliases
 * and per-mode effect styles already existed for manifest surfaces, so a
 * document-declared re-theme joins that path rather than growing a second one.
 */
type ScopedDeclarations = {
  surface: IRSurface;
  tokens: Array<{ name: string; value: string; annotation?: string }>;
};

/**
 * Group prefix for a surface-private token: `.acme-deck` -> `deck/`.
 *
 * The label's last word, not the whole slug, because every label in a real
 * system is prefixed with the system's own name ("Acme Deck") and that name
 * is already the collection's — repeating it in 133 variable paths is noise.
 * Two surfaces whose last words collide fall back to the full slug rather than
 * silently merging into one group.
 */
function surfaceGroups(surfaces: IRSurface[]): Map<string, string> {
  const full = surfaces.map((surface) =>
    surface.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  );
  const short = full.map((slug) => slug.split("-").pop() || slug);
  const collides = new Set(short.filter((s, i) => short.indexOf(s) !== i));

  const out = new Map<string, string>();
  surfaces.forEach((surface, i) => {
    out.set(surface.selector, collides.has(short[i]) ? full[i] : short[i]);
  });
  return out;
}

/**
 * Fold themed declarations onto the base definitions.
 *
 * For a manifest surface this is the only route its values have into the IR at
 * all: the surface CSS is never loaded, because it contributes zero tokens to
 * the CSSOM while changing measurement for any element carrying a surface
 * class. For a document-declared re-theme the CSS *is* loaded, but
 * `collectFromRules` keeps class-scoped blocks out of the base layer, so this
 * is still the only route.
 *
 * Three outcomes per name, which is exactly `IRTokenDefinition.declaredIn`:
 * declared in the base layer (system-wide, one value per mode); declared in one
 * surface only (private, group-prefixed, same value in every mode because a
 * product-surface element can never legally use it); declared in several
 * surfaces but not the base (shared, ungrouped, each surface's own value). A
 * light/dark pair with no `:root` at all is the third case throughout, which is
 * why the base mode ends up holding the first theme's values.
 */
function applySurfaces(
  definitions: IRTokenDefinition[],
  scopes: ScopedDeclarations[],
  raws: Map<string, string>,
  manifest: DsManifest | undefined,
): void {
  const byName = new Map(definitions.map((d) => [d.name, d]));
  for (const def of definitions) def.declaredIn = [""];

  for (const { surface, tokens: scoped } of scopes) {
    if (scoped.length === 0) continue;

    const scopedRaw = new Map(scoped.map((token) => [token.name, token.value]));
    const lookup = (ref: string) => scopedRaw.get(ref) ?? raws.get(ref);

    for (const token of scoped) {
      // `@kind other` is the author saying "not a token" for this scope. Only a
      // manifest carries it; a class-scoped block has no room for annotations,
      // so the shape heuristic in `classify` is all there is.
      if (token.annotation === "other") continue;

      const resolvedHere = classify(token.name, token.value, lookup);
      if (!resolvedHere) continue;

      const value: IRSurfaceValue = {
        resolved: resolvedHere.resolved,
        color: resolvedHere.color,
        float: resolvedHere.float,
        aliasOf: resolvedHere.aliasOf,
      };

      let def = byName.get(token.name);
      if (!def) {
        // Nothing in `:root` declares this name, so this surface's value is
        // also the definition's own: a variable has to hold something in the
        // modes that do not define it, and the declaring surface's value is
        // the only honest answer.
        def = { ...resolvedHere, declaredIn: [] };
        def.category = categoryOf(token.name, def, manifest);
        def.buildPath = buildPathFor(token.name, def.category);
        definitions.push(def);
        byName.set(token.name, def);
      }

      def.declaredIn = [...(def.declaredIn ?? []), surface.selector];
      def.bySurface = { ...(def.bySurface ?? {}), [surface.selector]: value };
    }
  }

  const groups = surfaceGroups(scopes.map((scope) => scope.surface));
  for (const def of definitions) {
    const declaredIn = def.declaredIn ?? [];
    if (declaredIn.includes("") || declaredIn.length !== 1) continue;
    const group = groups.get(declaredIn[0]);
    if (group) def.buildPath = `${group}/${def.buildPath}`;
  }
}

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

/**
 * Shadow tokens, which are not variables in any Figma sense.
 *
 * `--shadow-md` is a list of two drop shadows and Figma has no shadow-typed
 * variable, so these become EffectStyles (`upsertEffectStyles`,
 * src/plugin/mapping.ts). Without this pass all fifteen of them are dropped by
 * `classify` for containing a paren and nobody is told.
 *
 * A surface's redefinition gets its own style rather than a mode, because
 * styles have no modes: `.acme-deck`'s softer `--shadow-md` can only survive
 * as `deck/shadow/md` beside the base `shadow/md`.
 */
function collectShadowTokens(
  raws: Map<string, string>,
  scopes: ScopedDeclarations[],
  manifest: DsManifest | undefined,
): IRShadowToken[] | undefined {
  const out: IRShadowToken[] = [];
  const suppressed = manifest ? annotatedOtherNames(manifest, "") : new Set<string>();
  const baseLookup = (ref: string) => raws.get(ref);

  for (const [name, raw] of raws) {
    if (!/^shadow(-|$)/.test(name) || suppressed.has(name)) continue;
    const layers = parseShadowLayers(resolveValue(raw, baseLookup));
    if (layers.length > 0) {
      out.push({ name, buildPath: buildPathFor(name, "shadow"), scope: "", layers });
    }
  }

  const groups = surfaceGroups(scopes.map((scope) => scope.surface));
  for (const { surface, tokens: scoped } of scopes) {
    const scopedRaw = new Map(scoped.map((token) => [token.name, token.value]));
    const lookup = (ref: string) => scopedRaw.get(ref) ?? raws.get(ref);
    const group = groups.get(surface.selector) ?? "";

    for (const token of scoped) {
      if (!/^shadow(-|$)/.test(token.name) || token.annotation === "other") continue;
      const layers = parseShadowLayers(resolveValue(token.value, lookup));
      if (layers.length === 0) continue;
      out.push({
        name: token.name,
        buildPath: `${group}/${buildPathFor(token.name, "shadow")}`,
        scope: surface.selector,
        layers,
      });
    }
  }

  return out.length > 0 ? out : undefined;
}

/**
 * Parse an authored `box-shadow` value into Figma effect layers.
 *
 * Deliberately not `parseShadow` from src/ui/extract.ts: that one only ever
 * sees `getComputedStyle` output, which normalises to "colour first, then the
 * lengths". A hand-written token is the other way round —
 * `--shadow-xs: 0 1px 2px 0 rgba(0,0,0,0.05)` — so it needs a grammar that
 * takes the colour from wherever it sits.
 */
function parseShadowLayers(value: string): IRShadow[] {
  const out: IRShadow[] = [];

  for (const part of splitTopLevel(value)) {
    const layer = part.trim();
    if (!layer) continue;

    const inset = /\binset\b/.test(layer);
    const withoutInset = layer.replace(/\binset\b/g, " ");

    const colorMatch = withoutInset.match(
      /(rgba?\([^)]*\)|hsla?\([^)]*\)|color\([^)]*\)|#[0-9a-fA-F]{3,8}\b|\b(?:transparent|white|black|red)\b)/,
    );
    const color = colorMatch ? parseColor(colorMatch[1]) : null;
    if (!color) continue;

    const numbers = withoutInset
      .replace(colorMatch![0], " ")
      .trim()
      .split(/\s+/)
      .map((n) => parsePx(n))
      .filter((n): n is number => n !== null);
    if (numbers.length < 2) continue;

    out.push({
      type: inset ? "INNER_SHADOW" : "DROP_SHADOW",
      color,
      offsetX: numbers[0],
      offsetY: numbers[1],
      blur: numbers[2] ?? 0,
      spread: numbers[3] ?? 0,
    });
  }

  return out;
}

/**
 * Split on top-level commas only, so `rgba(0,0,0,0.05)` stays one piece.
 *
 * A twin of the same helper in src/ui/extract.ts. Kept separate rather than
 * exported across because extract.ts already imports this module, and the
 * reverse import would be a cycle.
 */
function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}


/**
 * Turn a matched definition into a reference, marking it when the theme it was
 * matched inside is what decides its value.
 *
 * The marker is what stops a dark fill binding to a variable whose only mode
 * holds the light value. It is set only when the theme's value actually DIFFERS
 * from the base one: a theme that re-declares a name with the value the base
 * mode already holds is correct in any mode, and marking it would refuse a
 * binding that was never in danger. That is not a corner case here. A document
 * with no `:root` gives the base layer its first theme's values wholesale
 * (`applySurfaces`), so the whole light half of `Portage Panel.dc.html` comes
 * out unmarked and binds even on a plan that allows one mode.
 */
function tokenRef(
  def: IRTokenDefinition,
  via: TokenRef["via"],
  scope: string | undefined,
): TokenRef {
  const ref: TokenRef = { name: def.name, path: def.path, via };
  const value = scope ? def.bySurface?.[scope] : undefined;
  if (scope && value && !sameAsBase(value, def)) ref.themeScope = scope;
  return ref;
}

function sameAsBase(value: IRSurfaceValue, def: IRTokenDefinition): boolean {
  if (value.aliasOf !== def.aliasOf) return false;
  if (value.color || def.color) {
    return !!value.color && !!def.color && colorKey(value.color) === colorKey(def.color);
  }
  if (value.float !== undefined || def.float !== undefined) return value.float === def.float;
  return value.resolved === def.resolved;
}

/**
 * Find the token a declaration referred to by name.
 *
 * `declared` is the *specified* value straight off the inline style or CSS
 * rule (still containing `var(...)`), not the computed value.
 *
 * `scope` is the re-theme the element sits inside, when the document declares a
 * mode axis at all. Passing it switches every lookup here to that theme's
 * values, which is the only way `var(--figma-color-text-tertiary)` on a dark
 * panel resolves to `#7e7e7e` rather than being rejected against light's
 * `#b3b3b3`.
 */
export function matchTokenByVar(
  declared: string | undefined,
  index: TokenIndex,
  expected?: IRColor,
  scope?: string,
): TokenRef | undefined {
  if (!declared) return undefined;
  VAR_REF.lastIndex = 0;
  const match = VAR_REF.exec(declared);
  if (!match) return undefined;

  const name = match[1].slice(2);
  // Inside a theme, a name the base layer never declared is still a real token:
  // this export declares all fifteen of its theme colours in `.cd2f-theme-*`
  // and none in `:root`, so `byName` alone answers "not a token" fifteen times.
  const def =
    (scope ? index.byNameInScope?.get(scope)?.get(name) : undefined) ?? index.byName.get(name);
  if (!def) return undefined;

  // The name alone is not proof. Claude Design design systems re-theme whole
  // token sets under a scoped selector (`.acme-deck`, `.acme-email`), so
  // the same name can hold a different value in the scope that actually
  // applied. Outside a detected axis we only index the global layer, so when the
  // rendered value disagrees with the token we looked up, the token is the wrong
  // one and a value match is the honest fallback.
  const effective = scope ? (def.bySurface?.[scope]?.color ?? def.color) : def.color;
  if (expected && effective && colorKey(effective) !== colorKey(expected)) {
    return matchColorToken(expected, index, scope);
  }

  return tokenRef(def, "var", scope);
}

export function matchColorToken(
  color: IRColor,
  index: TokenIndex,
  scope?: string,
): TokenRef | undefined {
  // A scope's index already carries every definition at its effective value in
  // that theme, so a miss there is a real miss. Falling back to `byColor` would
  // answer a dark question with a light token.
  const scoped = scope ? index.byColorInScope?.get(scope) : undefined;
  const candidates = (scoped ?? index.byColor).get(colorKey(color));
  if (!candidates || candidates.length === 0) return undefined;
  return tokenRef(candidates[0], "value-match", scope);
}

/** Which family of numeric token a measurement is allowed to bind to. */
export type FloatCategory = "radius" | "space";

const CATEGORY_PATTERNS: Record<FloatCategory, RegExp> = {
  radius: /(radius|rounded|corner)/i,
  space: /(space|spacing|gap|size|inset|gutter|pad)/i,
};

/**
 * Reverse-match a measurement to a numeric token *within its own category*.
 *
 * Numeric collisions across categories are the norm, not the exception — a
 * design system with `--space-4: 16px` and `--radius-lg: 16px` is completely
 * ordinary. Matching on value alone would bind a corner radius to a spacing
 * variable, which looks right until someone retunes their spacing scale and
 * every card silently changes shape. When nothing in the right category
 * matches, returning undefined leaves an honest literal behind.
 */
export function matchFloatToken(
  value: number,
  index: TokenIndex,
  category: FloatCategory,
  scope?: string,
): TokenRef | undefined {
  if (value === 0) return undefined; // 0 is never worth a variable binding.
  // Same rule as `matchColorToken`: inside a theme, that theme's index is the
  // whole answer. A re-themed radius must not value-match the base ramp.
  const scoped = scope ? index.byFloatInScope?.get(scope) : undefined;
  const candidates = (scoped ?? index.byFloat).get(value);
  if (!candidates || candidates.length === 0) return undefined;

  const pattern = CATEGORY_PATTERNS[category];
  const def = candidates.find((candidate) => pattern.test(candidate.name));
  if (!def) return undefined;

  return tokenRef(def, "value-match", scope);
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

const NAMED_COLORS: Record<string, string> = {
  transparent: "rgba(0,0,0,0)",
  white: "#FFFFFF",
  black: "#000000",
  red: "#FF0000",
  currentcolor: "",
};

/**
 * Parse any CSS colour we are likely to meet into normalised 0..1 channels.
 * Returns null for values that are not colours at all, which is how callers
 * distinguish "colour token" from "length token".
 */
export function parseColor(input: string): IRColor | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;

  const named = NAMED_COLORS[value];
  if (named !== undefined) return named ? parseColor(named) : null;

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const expand = (h: string) => parseInt(h.length === 1 ? h + h : h, 16) / 255;
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: expand(hex[0]),
        g: expand(hex[1]),
        b: expand(hex[2]),
        a: hex.length === 4 ? expand(hex[3]) : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: expand(hex.slice(0, 2)),
        g: expand(hex.slice(2, 4)),
        b: expand(hex.slice(4, 6)),
        a: hex.length === 8 ? expand(hex.slice(6, 8)) : 1,
      };
    }
    return null;
  }

  const fn = value.match(/^(rgba?|hsla?)\(([^)]+)\)$/);
  if (fn) {
    // Both comma and space syntaxes, with an optional `/ alpha`.
    const parts = fn[2]
      .replace(/\//g, " ")
      .split(/[,\s]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;

    const alpha = parts.length >= 4 ? parseAlpha(parts[3]) : 1;

    if (fn[1].startsWith("rgb")) {
      return {
        r: parseChannel(parts[0]),
        g: parseChannel(parts[1]),
        b: parseChannel(parts[2]),
        a: alpha,
      };
    }

    const h = parseFloat(parts[0]);
    const s = parseFloat(parts[1]) / 100;
    const l = parseFloat(parts[2]) / 100;
    return { ...hslToRgb(h, s, l), a: alpha };
  }

  // color(srgb r g b / a) — emitted by newer Chromium in getComputedStyle.
  const srgb = value.match(/^color\(\s*srgb\s+([^)]+)\)$/);
  if (srgb) {
    const parts = srgb[1].replace(/\//g, " ").split(/\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    return {
      r: clamp01(parseFloat(parts[0])),
      g: clamp01(parseFloat(parts[1])),
      b: clamp01(parseFloat(parts[2])),
      a: parts.length >= 4 ? parseAlpha(parts[3]) : 1,
    };
  }

  return null;
}

function parseChannel(raw: string): number {
  if (raw.endsWith("%")) return clamp01(parseFloat(raw) / 100);
  return clamp01(parseFloat(raw) / 255);
}

function parseAlpha(raw: string): number {
  if (raw.endsWith("%")) return clamp01(parseFloat(raw) / 100);
  return clamp01(parseFloat(raw));
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function hslToRgb(h: number, s: number, l: number) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return { r: clamp01(r1 + m), g: clamp01(g1 + m), b: clamp01(b1 + m) };
}

/** Parse a length we can treat as a Figma FLOAT variable. */
export function parsePx(input: string): number | null {
  const value = input.trim();
  const match = value.match(/^(-?\d*\.?\d+)(px|rem)?$/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (Number.isNaN(n)) return null;
  return match[2] === "rem" ? n * 16 : n;
}
