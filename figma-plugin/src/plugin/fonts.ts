/**
 * Font resolution and loading.
 *
 * Figma addresses fonts as (family, style) pairs drawn from what is actually
 * installed or enabled in the file, while CSS addresses them as (family,
 * numeric weight, italic). Mapping between the two is where most HTML imports
 * quietly go wrong: an unavailable family throws on `setRangeFontName`, and a
 * plugin that does not pre-load every pair it will use fails partway through
 * with half a screen on the canvas.
 *
 * So: resolve everything up front, substitute deliberately, and report the
 * substitutions rather than pretending the import was exact.
 */

const WEIGHT_NAMES: Array<{ weight: number; names: string[] }> = [
  { weight: 100, names: ["Thin", "Hairline"] },
  { weight: 200, names: ["ExtraLight", "Extra Light", "UltraLight"] },
  { weight: 300, names: ["Light"] },
  { weight: 400, names: ["Regular", "Normal", "Book"] },
  { weight: 500, names: ["Medium"] },
  { weight: 600, names: ["SemiBold", "Semi Bold", "DemiBold"] },
  { weight: 700, names: ["Bold"] },
  { weight: 800, names: ["ExtraBold", "Extra Bold", "UltraBold"] },
  { weight: 900, names: ["Black", "Heavy"] },
];

/**
 * Where each CSS generic family lands, named once so the keyword spellings
 * below cannot drift apart from the generic they are a synonym for.
 */
const SANS = ["Inter", "Roboto"];
const SERIF = ["Georgia", "Times New Roman", "Inter"];
const MONO = ["Roboto Mono", "Source Code Pro", "Inter"];

/**
 * Families we substitute for when the original is not in the file.
 *
 * The key here is ONE family name, never a stack: `primaryFamily`
 * (src/ui/extract.ts) keeps the first entry of `font-family` and drops the
 * rest before the IR is built, so a stack's own trailing generic never reaches
 * this resolver. That is why the `ui-*` keywords need entries of their own.
 * The real Portage export sets its code runs to
 * `ui-monospace, 'Geist Mono', SFMono-Regular, Menlo, monospace`; only
 * `ui-monospace` arrives, no Figma file has a face by that name, and all 30 of
 * those runs fell through to Inter, a proportional face, while `monospace`
 * beside it in the same declaration would have found Roboto Mono.
 *
 * `ui-sans-serif`, `ui-serif`, `ui-rounded` and `system-ui` are the same kind
 * of name: a request for whatever the platform uses, not for an installed
 * family. They route where their plain generic routes.
 */
const FAMILY_FALLBACKS: Record<string, string[]> = {
  "dm sans": ["DM Sans", "Inter", "Roboto"],
  "red hat display": ["Red Hat Display", "Inter", "Roboto"],
  "geist mono": ["Geist Mono", "Roboto Mono", "JetBrains Mono", "Source Code Pro"],
  inter: ["Inter", "Roboto"],
  "system-ui": SANS,
  "-apple-system": SANS,
  "ui-sans-serif": SANS,
  "ui-serif": SERIF,
  "ui-monospace": MONO,
  // Rounded is a shape, not a family: nothing in Figma answers for it, and the
  // platform's rounded UI face is a sans. Falling back to the sans keeps the
  // text proportional, which is the property that matters.
  "ui-rounded": SANS,
  ui: ["Inter"],
  sans: SANS,
  "sans-serif": SANS,
  serif: SERIF,
  monospace: MONO,
  cursive: ["Inter"],
};

const LAST_RESORT = ["Inter", "Roboto", "Arial", "Helvetica"];

export type FontResolver = {
  resolve: (family: string, weight: number, italic: boolean) => FontName;
  substitutions: string[];
};

export async function createFontResolver(
  requests: Array<{ family: string; weight: number; italic: boolean }>,
): Promise<FontResolver> {
  const available = await figma.listAvailableFontsAsync();

  const families = new Map<string, Set<string>>();
  for (const font of available) {
    const key = font.fontName.family.toLowerCase();
    const styles = families.get(key) ?? new Set<string>();
    styles.add(font.fontName.style);
    families.set(key, styles);
  }

  const cache = new Map<string, FontName>();
  const substitutions = new Set<string>();

  const resolve = (family: string, weight: number, italic: boolean): FontName => {
    const key = `${family}|${weight}|${italic}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const candidates = [
      family,
      ...(FAMILY_FALLBACKS[family.toLowerCase()] ?? []),
      ...LAST_RESORT,
    ];

    for (const candidate of candidates) {
      const styles = families.get(candidate.toLowerCase());
      if (!styles) continue;

      const style = pickStyle(styles, weight, italic);
      if (!style) continue;

      const resolved: FontName = {
        family: matchCase(available, candidate),
        style,
      };
      if (resolved.family.toLowerCase() !== family.toLowerCase()) {
        substitutions.add(`${family} → ${resolved.family}`);
      }
      cache.set(key, resolved);
      return resolved;
    }

    const fallback: FontName = { family: "Inter", style: "Regular" };
    substitutions.add(`${family} → Inter (not available)`);
    cache.set(key, fallback);
    return fallback;
  };

  // Pre-load every pair the document will need. A missing preload surfaces as
  // an exception deep inside text building, so paying for it here is cheaper.
  const needed = new Map<string, FontName>();
  for (const request of requests) {
    const font = resolve(request.family, request.weight, request.italic);
    needed.set(`${font.family}|${font.style}`, font);
  }

  const failed = new Set<string>();
  await Promise.all(
    Array.from(needed.values()).map(async (font) => {
      try {
        await figma.loadFontAsync(font);
      } catch {
        failed.add(`${font.family}|${font.style}`);
        substitutions.add(`${font.family} ${font.style} → Inter (could not load)`);
      }
    }),
  );

  // Inter Regular is the universal fallback for anything that still fails.
  try {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  } catch {
    // Nothing further we can do; buildText drops the layer and says so.
  }

  // A font listed as available can still refuse to load (a shared file whose
  // owner's fonts this machine lacks). Handing it back anyway made Figma throw
  // on the first `fontName =`, outside any handler, and took the whole screen
  // down over one label.
  const safeResolve: FontResolver["resolve"] = (family, weight, italic) => {
    const font = resolve(family, weight, italic);
    return failed.has(`${font.family}|${font.style}`) ? { family: "Inter", style: "Regular" } : font;
  };

  return { resolve: safeResolve, substitutions: Array.from(substitutions) };
}

/**
 * Choose the closest available style for a numeric weight.
 *
 * Walks outward from the requested weight rather than snapping to Regular, so
 * a 600 in a family that only ships 500/700 lands on one of those instead of
 * flattening the whole type scale to 400.
 */
function pickStyle(
  styles: Set<string>,
  weight: number,
  italic: boolean,
): string | null {
  const order = [...WEIGHT_NAMES].sort(
    (a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight),
  );

  for (const entry of order) {
    for (const name of entry.names) {
      const candidate = italic ? `${name} Italic` : name;
      const found = findStyle(styles, candidate);
      if (found) return found;

      // Some families name the italic of Regular just "Italic".
      if (italic && entry.weight === 400) {
        const plainItalic = findStyle(styles, "Italic");
        if (plainItalic) return plainItalic;
      }
    }
  }

  // Italic requested but the family has none: fall back to upright.
  if (italic) return pickStyle(styles, weight, false);
  return styles.values().next().value ?? null;
}

function findStyle(styles: Set<string>, target: string): string | null {
  const lower = target.toLowerCase();
  for (const style of styles) {
    if (style.toLowerCase() === lower) return style;
  }
  return null;
}

function matchCase(available: Font[], family: string): string {
  const lower = family.toLowerCase();
  for (const font of available) {
    if (font.fontName.family.toLowerCase() === lower) return font.fontName.family;
  }
  return family;
}
