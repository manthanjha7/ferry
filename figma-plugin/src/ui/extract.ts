/**
 * DOM -> IR extraction. Runs inside the plugin's UI iframe, which is the only
 * half of a Figma plugin with a real layout engine.
 *
 * The job is not "read the CSS" — it is "read what the browser *did* with the
 * CSS, then recover the designer's intent". Those differ in one important way:
 * computed style tells you an element is `display:flex; gap:12px`, which maps
 * cleanly onto Figma auto-layout, but it tells you nothing about the far more
 * common case of a plain block stack that a designer would also expect to be
 * auto-layout. Recovering that second case is `inferStack` below, and it is
 * the difference between a file you can edit and a pile of absolute frames.
 */

import { bootAnimation, readAnimationSpec, settledMoment, type LiveAnimation } from "./animation";
import { installVirtualClock, real, SETTLE_HORIZON_MS, type VirtualClock } from "./clock";
import {
  DEFAULT_EXTRACT_OPTIONS,
  type AxisAlign,
  type CrossAlign,
  type ExtractOptions,
  type IRColor,
  type IRDocument,
  type IREffect,
  type IRLayout,
  type IRNode,
  type IRPaint,
  type IRSolidPaint,
  type IRText,
  type IRTextRun,
  type Sizing,
} from "../ir";
import {
  buildTokenIndex,
  matchColorToken,
  matchFloatToken,
  matchTokenByVar,
  parseColor,
  type TokenIndex,
} from "./tokens";
import {
  enumerableProps,
  preprocessTableSafeMarkup,
  readPropsSchema,
  resolveDynamicDocument,
  type ResolveReport,
} from "./resolve";
import {
  previewFrameSize,
  propCombinations,
  selectAxes,
  stateAxes,
  stateFrameName,
  STATE_COMBINATION_CAP,
  type StateAxis,
} from "./states";

/**
 * Opt-in tracing. Extraction is a long synchronous walk over someone else's
 * markup, so when it stalls there is otherwise nothing to look at: no error, no
 * output, just a blocked main thread. Set `window.__CD2F_DEBUG = true`.
 */
function debug(message: string): void {
  const flag = (globalThis as unknown as { __CD2F_DEBUG?: boolean }).__CD2F_DEBUG;
  if (flag) console.log(`[cd2f] ${message}`);
}

/** Marks the <style> holding a separately supplied design system's CSS. */
const EXTRA_CSS_MARKER = "data-cd2f-extra-css";

const SKIPPED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "LINK",
  "META",
  "TITLE",
  "HEAD",
  "HELMET",
  "NOSCRIPT",
  "TEMPLATE",
  "X-DC-TOOLBAR",
]);

type Ctx = {
  tokens: TokenIndex;
  options: ExtractOptions;
  warnings: string[];
  imageCache: Map<string, Uint8Array | null>;
  /**
   * The re-theme class in effect at this point in the walk, innermost wins.
   *
   * Every token match below reads it, because inside `.cd2f-theme-dark` the
   * custom property `--figma-color-text-tertiary` is `#7e7e7e` and outside it is
   * `#b3b3b3`, and binding the wrong one produces a layer that looks right in
   * the layer panel and wrong on canvas.
   */
  themeScope: string | null;
  /**
   * Runs whose `line-height` was `normal`, to have their real leading measured
   * in one batch AFTER the walk (`resolvePendingLineHeights`). Measuring inline
   * meant appending a probe to the document mid-walk, and a DOM write between
   * the walk's own getBoundingClientRect reads forces a reflow on every one of
   * them — the same trap `resolveDeclaredColor` avoids by running after the
   * walk. Each run keeps a fallback until the batch overwrites it.
   */
  pendingLineHeights: PendingLineHeight[];
};

/** A run awaiting its `line-height: normal` measurement, with its face. */
type PendingLineHeight = {
  run: IRTextRun;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type RenderHandle = {
  container: HTMLElement;
  root: HTMLElement;
  /** Style/link elements we lifted out of the document into our <head>. */
  adopted: Element[];
  /** How many <image-slot> placeholders we turned into visible boxes. */
  imageSlots: number;
  /** Stylesheet hrefs the document asked for that did not resolve. */
  missingStylesheets: string[];
  dynamicContent: IRDocument["dynamicContent"];
  /** Present when the document is a Claude Design animation, rendered live. */
  animation?: LiveAnimation;
  /** The stand-in for the page's <body>, whose children are the top-level layers. */
  body?: HTMLElement;
  dispose: () => void;
};

/**
 * Mount the HTML offscreen so the browser lays it out for real.
 *
 * We render into the plugin's own document rather than a nested iframe on
 * purpose: a `srcdoc` iframe inside a Figma plugin inherits an opaque origin,
 * and two opaque origins are not same-origin, so `contentDocument` would be
 * unreadable and we could not measure anything. The cost is that the imported
 * document's global CSS also applies to our UI, which is why every class in
 * `ui.html` is namespaced `cd2f-`.
 */
export async function mountDocument(
  html: string,
  options: ExtractOptions,
): Promise<RenderHandle> {
  const container = document.createElement("div");
  container.id = "cd2f-stage";
  container.setAttribute("aria-hidden", "true");
  container.style.cssText = [
    "position:absolute",
    "left:-100000px",
    "top:0",
    `width:${options.viewportWidth}px`,
    "pointer-events:none",
    "contain:layout style",
  ].join(";");

  // Strip the parts of the document that would fight the host page, keeping
  // stylesheets and inline <style> because tokens live there.
  //
  // `preprocessTableSafeMarkup` renames <sc-for>/<sc-if> to <template
  // data-sc-for>/<template data-sc-if> in the raw text BEFORE the browser's
  // HTML parser ever sees them: verified against the real fixture that the
  // table insertion modes otherwise foster-parent these custom elements OUT
  // of a <table>/<tbody>/<tr> entirely, destroying the very conditional/loop
  // structure resolveDynamicDocument depends on (see that function's doc
  // comment in src/ui/resolve.ts for the full empirical write-up).
  const parsed = new DOMParser().parseFromString(preprocessTableSafeMarkup(html), "text/html");

  // Some Claude Design exports "build themselves at load time": a
  // <script data-dc-script> block computes the real content, and the markup
  // is left as {{ }} placeholders / sc-for / sc-if / x-import until that runs.
  // Resolve it — WITHOUT loading Claude Design's own support.js — before the
  // script is stripped below and before anything reads this markup as final.
  // Async because some of those scripts have a real BOOT PHASE
  // (componentDidMount -> import() -> setState) that has to actually
  // complete before the markup means anything — see resolve.ts.
  // The document's script runs against the plugin's REAL page, and a theme
  // switch like `document.documentElement.setAttribute("data-theme", "dark")`
  // lands on the plugin's own <html>. Left there, it outlives this import and
  // re-themes the next document dropped in. Snapshotted here, restored on
  // dispose; what it set is still in place while this document is measured,
  // because that is the theme it chose to render in.
  const host = snapshotHost();
  const reveal = revealEverything();
  const viewport = { width: options.viewportWidth, height: designViewportHeight(options.viewportWidth) };
  const restoreWindowSize = reportDesignViewport(viewport);
  const clock = installVirtualClock();
  const resolveReport = await resolveDynamicDocument(parsed, {
    moduleSources: options.moduleSources,
    documentSources: options.documentSources,
    propOverrides: options.propOverrides,
  });

  debug("resolved");
  for (const el of Array.from(parsed.querySelectorAll("script"))) el.remove();

  // Claude Design wraps content in <x-dc> with a <helmet> of asset links.
  const adopted: Element[] = [];
  const adopt = (node: Element) => {
    const clone = node.cloneNode(true) as Element;
    document.head.appendChild(clone);
    adopted.push(clone);
  };

  // A design system supplied separately goes in first, so anything the document
  // links itself still wins on later cascade position. It is marked, because
  // once it is a <style> in the same head nothing else can tell it apart from
  // the document's own CSS, and rootBackground has to (see documentStylesheets).
  if (options.extraCss) {
    const style = document.createElement("style");
    style.setAttribute(EXTRA_CSS_MARKER, "");
    style.textContent = options.extraCss;
    document.head.appendChild(style);
    adopted.push(style);
  }

  const helmet = parsed.querySelector("helmet");
  if (helmet) {
    for (const node of Array.from(helmet.children)) {
      if (node.tagName === "LINK" || node.tagName === "STYLE") adopt(node);
    }
  }
  for (const styleEl of Array.from(parsed.querySelectorAll("head style, head link"))) {
    adopt(styleEl);
  }

  const imageSlots = stubImageSlots(parsed);
  fixJsxSvgAttributes(parsed);
  // An offscreen lazy image may never be judged near the viewport, so never loads.
  for (const img of Array.from(parsed.querySelectorAll("img[loading='lazy'], iframe[loading='lazy']"))) {
    img.setAttribute("loading", "eager");
  }

  const source = parsed.querySelector("x-dc") ?? parsed.body;
  // The page's own <body>: a wrapper that takes the body's margin and padding
  // once the CSS is in (applyBodyBox), so content sits where the browser puts
  // it. Without it every element on a page with the default 8px body margin
  // imported 8px up and to the left.
  const body = document.createElement("div");
  body.setAttribute("data-cd2f-body", "");
  body.innerHTML = source.innerHTML;
  container.appendChild(body);
  document.body.appendChild(container);

  // Token extraction reads `document.styleSheets`, so the design system's CSS
  // has to have finished loading before anything is measured — otherwise every
  // colour resolves as a bare literal and the whole binding feature no-ops.
  await waitForStylesheets(adopted);
  debug("stylesheets loaded");
  emulateViewport(container, adopted, viewport);
  // Claude Design's runtime (support.js) resets `html, body { margin: 0 }`,
  // so its documents start at 0; plain HTML gets the browser's 8px.
  const claudeDesign = !!parsed.querySelector("x-dc") || /<x-dc\b|src=["'][^"']*support\.js/i.test(html);
  applyBodyBox(body, adopted, parsed.body, claudeDesign ? "0px" : "8px");

  // An animation project renders from its own .jsx modules, live. Its
  // composition surface, not the page, is what gets measured.
  const animationSpec = readAnimationSpec(html);
  let animation: LiveAnimation | undefined;
  if (animationSpec) {
    try {
      animation = await bootAnimation(container, animationSpec, options.moduleSources);
    } catch (error) {
      container.remove();
      for (const node of adopted) node.remove();
      restoreHost(host);
      reveal.restore();
      restoreWindowSize();
      clock.uninstall();
      throw error;
    }
  }
  await waitForAssets(container);
  debug("assets loaded");
  await settleMotion(container, adopted, reveal.flush, clock);
  debug("motion settled");
  materializePseudoElements(container);
  anchorFixedToViewport(container, viewport);

  return {
    container,
    // For an animation, the foreignObject holding the composition surface, so
    // the walk's one child is the composition frame at its authored size.
    root: animation ? (animation.surface.parentElement as unknown as HTMLElement) : container,
    body: animation ? undefined : body,
    animation,
    adopted,
    imageSlots,
    dynamicContent: detectDynamicContent(parsed, resolveReport),
    missingStylesheets: findMissingStylesheets(adopted),
    dispose: () => {
      animation?.unmount();
      container.remove();
      for (const node of adopted) node.remove();
      restoreHost(host);
      reveal.restore();
      restoreWindowSize();
      clock.uninstall();
    },
  };
}

/**
 * Report every observed element as on screen while a document is measured.
 *
 * Scroll-reveal is everywhere in Claude Design output: content sits at
 * `opacity: 0` until an IntersectionObserver sees it and adds a class. The
 * stage is parked offscreen, so nothing is ever seen, and a real portfolio
 * imported with 28 of its 48 text layers invisible. What a designer wants in
 * Figma is the page as it looks once you have scrolled through it.
 */
function revealEverything(): { flush: () => void; restore: () => void } {
  const original = window.IntersectionObserver;
  if (!original) return { flush: () => {}, restore: () => {} };

  const observers = new Set<RevealAll>();

  class RevealAll {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    /** Observed and not yet told. A timer alone lost the lower half of a page. */
    pending = new Set<Element>();
    constructor(private callback: IntersectionObserverCallback) {
      observers.add(this);
    }
    observe(target: Element): void {
      this.pending.add(target);
      real.setTimeout(() => this.deliver(), 0);
    }
    unobserve(target: Element): void {
      this.pending.delete(target);
    }
    disconnect(): void {
      this.pending.clear();
      observers.delete(this);
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    deliver(): void {
      if (this.pending.size === 0) return;
      const entries = Array.from(this.pending).map((target) => {
        const rect = target.getBoundingClientRect();
        return {
          target,
          isIntersecting: true,
          intersectionRatio: 1,
          boundingClientRect: rect,
          intersectionRect: rect,
          rootBounds: null,
          time: real.perf(),
        } as unknown as IntersectionObserverEntry;
      });
      this.pending.clear();
      try {
        this.callback(entries, this as unknown as IntersectionObserver);
      } catch {
        // The document's own reveal code failing is its problem, not the import's.
      }
    }
  }

  (window as { IntersectionObserver: unknown }).IntersectionObserver = RevealAll;
  return {
    // Deliver until quiet: a reveal callback can observe more elements.
    flush: () => {
      for (let round = 0; round < 5; round++) {
        const busy = Array.from(observers).filter((o) => o.pending.size > 0);
        if (busy.length === 0) return;
        for (const observer of busy) observer.deliver();
      }
    },
    restore: () => {
      window.IntersectionObserver = original;
    },
  };
}

/**
 * Measure the page at rest, not mid-entrance.
 *
 * `<main style="animation: riseIn .5s both">` is measured on its first frame,
 * at opacity 0, and so is anything a reveal class starts transitioning in. So:
 * let the reveal callbacks run, take the document's own reduced-motion rules
 * (which is exactly "this page without its motion", written by its author),
 * then jump every finite animation and transition to its end state. Looping
 * ones are cancelled back to their resting style.
 */
async function settleMotion(
  container: HTMLElement,
  adopted: Element[],
  flushReveals: () => void,
  clock: VirtualClock,
): Promise<void> {
  const tick = () => new Promise<void>((resolve) => real.setTimeout(resolve, 0));
  await tick();
  // The page is in the DOM now, so let the document's own timers and frames
  // run to their end: counters reach their value, typewriters finish typing.
  // Promise continuations get a turn between passes.
  clock.setLimit(SETTLE_HORIZON_MS);
  for (let pass = 0; pass < 4; pass++) {
    clock.advance(SETTLE_HORIZON_MS);
    await tick();
  }
  flushReveals();
  clock.advance(SETTLE_HORIZON_MS);
  await tick();

  for (const node of adopted) {
    const sheet = (node as HTMLStyleElement | HTMLLinkElement).sheet;
    if (!sheet) continue;
    // `cssRules` itself throws on a cross-origin sheet (Google Fonts, in every
    // real export), so the read has to be inside the guard, not after it.
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    preferReducedMotion(rules);
  }

  for (const animation of document.getAnimations()) {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    if (!target || !container.contains(target)) continue;
    // Scroll-driven (`animation-timeline: view()`): progress is a scroll
    // position the offscreen stage never has, and "finish" has no meaning.
    // Cancelled, the element shows its resting style, which is the look the
    // animation was revealing.
    if (animation.timeline && animation.timeline !== document.timeline) {
      try {
        animation.cancel();
      } catch {
        // Left as it was.
      }
      continue;
    }
    try {
      const end = animation.effect?.getComputedTiming().endTime;
      if (typeof end === "number" && Number.isFinite(end)) animation.finish();
      else animation.cancel();
    } catch {
      // A finish() the browser refuses leaves that one element mid-motion.
    }
  }
}

function preferReducedMotion(rules: CSSRuleList | null | undefined): void {
  let list: CSSRule[];
  try {
    list = Array.from(rules ?? []);
  } catch {
    return; // Cross-origin stylesheet.
  }
  for (const rule of list) {
    try {
      const media = (rule as CSSMediaRule).media;
      if (media) {
        const text = media.mediaText;
        if (/prefers-reduced-motion\s*:\s*reduce/i.test(text)) media.mediaText = "all";
        else if (/prefers-reduced-motion\s*:\s*no-preference/i.test(text)) media.mediaText = "not all";
      }
      preferReducedMotion((rule as CSSGroupingRule).cssRules);
    } catch {
      // An @import of a cross-origin sheet throws the same way; skip that branch.
    }
  }
}


// ---------------------------------------------------------------------------
// Transforms, stacking, truncation, media
// ---------------------------------------------------------------------------

/** The rotation in a computed transform, in degrees clockwise. 0 when there is none worth carrying. */
function rotationOf(style: CSSStyleDeclaration): number {
  let degrees = 0;
  const t = style.transform;
  if (t && t !== "none") {
    const m = /^matrix\(([^)]+)\)$/.exec(t);
    // matrix3d: a 3D turn has no Figma equivalent; measured flat.
    if (m) {
      const [a, b] = m[1].split(",").map((v) => parseFloat(v));
      degrees += (Math.atan2(b, a) * 180) / Math.PI;
    }
  }
  // The standalone `rotate` property (`rotate: 1.4deg`) turns the box too and
  // is not part of `transform`: a tilted photo card came in upright.
  const r = (style as CSSStyleDeclaration & { rotate?: string }).rotate;
  if (r && r !== "none") {
    const m = /(-?[\d.]+)(deg|rad|turn|grad)\s*$/.exec(r);
    const axis = r.trim().split(/\s+/);
    const zOnly = axis.length === 1 || /^z$/i.test(axis[0]) || (axis.length === 4 && parseFloat(axis[0]) === 0 && parseFloat(axis[1]) === 0);
    if (m && zOnly) {
      const n = parseFloat(m[1]);
      degrees += m[2] === "rad" ? (n * 180) / Math.PI : m[2] === "turn" ? n * 360 : m[2] === "grad" ? n * 0.9 : n;
    }
  }
  degrees = ((degrees + 540) % 360) - 180;
  return Math.abs(degrees) < 0.05 ? 0 : Math.round(degrees * 100) / 100;
}

/** Turn an element's transform off for measuring, and hand back how to turn it on. */
function suspendTransform(el: HTMLElement): () => void {
  const saved = ["transform", "rotate"].map((prop) => ({
    prop,
    value: el.style.getPropertyValue(prop),
    priority: el.style.getPropertyPriority(prop),
  }));
  for (const { prop } of saved) el.style.setProperty(prop, "none", "important");
  return () => {
    for (const { prop, value, priority } of saved) {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
  };
}

/**
 * Put absolutely-stacked children in paint order.
 *
 * Figma paints later children on top, and so does the DOM, until `z-index`
 * says otherwise: a card whose badge is written first with `z-index: 2`
 * imported with the badge underneath. Only positioned (or flex/grid) children
 * take a z-index, `auto` counts as 0, and the sort is stable so equal layers
 * keep DOM order. Only for absolute parents: reordering an auto-layout frame
 * would reorder its flow.
 */
function orderByStacking(children: IRNode[], sources: Array<Element | null>): void {
  const z = sources.map((source) => {
    if (!source) return 0;
    const cs = getComputedStyle(source);
    const value = parseInt(cs.zIndex, 10);
    return Number.isFinite(value) ? value : 0;
  });
  if (z.every((value) => value === 0)) return;
  const order = children.map((_, i) => i).sort((a, b) => z[a] - z[b] || a - b);
  const sorted = order.map((i) => children[i]);
  children.splice(0, children.length, ...sorted);
}

/**
 * A text box that is wider than its words on purpose keeps its width.
 *
 * Figma text hugs by default, which is right for a label in a column. It is
 * wrong for an icon glyph in a 16px column (every sidebar label moved 3-8px
 * left) and for centred or right-aligned copy, where a hugging box puts the
 * words at the left edge. So: a flex-row item or inline-block with room to
 * spare, or any text not aligned to the start, keeps its measured width.
 */
function keepsItsWidth(el: HTMLElement, style: CSSStyleDeclaration, rect: DOMRect, text: IRText): boolean {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  const content = range.getBoundingClientRect().width;
  if (!(rect.width - content > 2)) return false;
  if (text.align === "CENTER" || text.align === "RIGHT" || text.align === "JUSTIFIED") return true;
  const parent = el.parentElement ? getComputedStyle(el.parentElement) : null;
  const rowItem = !!parent && /flex/.test(parent.display) && !parent.flexDirection.startsWith("column");
  // A grid item's width is its track: an "01" in an 80px column that hugged
  // its two characters slid every project card 63px left.
  const gridItem = !!parent && /grid/.test(parent.display);
  return rowItem || gridItem || /^inline-(block|flex|grid)$/.test(style.display);
}

/**
 * Keep a text block the height it rendered at.
 *
 * Mixing faces on one line (Geist with an italic Newsreader word, the
 * portfolio's headline) makes the browser's line boxes taller than
 * `line-height`: that h1 rendered 160px for two 78px lines. Figma lays text
 * out at exactly lines x line-height, so the block came in 4px short and
 * everything after it in an auto-layout column moved up. When the measured
 * box is taller than that by more than a pixel, the line height is raised to
 * share the difference, which is what the lines actually did.
 */
function fitLineHeightToBox(text: IRText, height: number, style: CSSStyleDeclaration): void {
  if (text.maxLines || truncationOf(style)) return;
  const padding = px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth);
  const box = height - padding;
  const lineHeight = Math.max(...text.runs.map((run) => run.lineHeight ?? run.fontSize * 1.2));
  if (!(lineHeight > 0) || !(box > 0)) return;
  const lines = Math.max(1, Math.round(box / lineHeight));
  const fitted = box / lines;
  if (box - lines * lineHeight <= 1 || fitted - lineHeight > lineHeight * 0.25) return;
  for (const run of text.runs) run.lineHeight = Math.round(fitted * 100) / 100;
}

/** How many lines show before an ellipsis, when the CSS cuts text off. */
function truncationOf(style: CSSStyleDeclaration): number | undefined {
  const clamp = parseInt(style.getPropertyValue("-webkit-line-clamp") || style.getPropertyValue("line-clamp"), 10);
  if (Number.isFinite(clamp) && clamp > 0) return clamp;
  const clipsX = style.overflowX === "hidden" || style.overflowX === "clip";
  if (style.textOverflow === "ellipsis" && clipsX && /nowrap|pre/.test(style.whiteSpace)) return 1;
  return undefined;
}

/** A canvas's pixels, or a video's poster or current frame, as PNG bytes. */
async function snapshotMedia(
  el: HTMLCanvasElement | HTMLVideoElement,
  ctx: Ctx,
): Promise<Uint8Array | null> {
  try {
    if (el instanceof HTMLVideoElement) {
      if (el.poster) {
        const poster = await loadImage(el.poster, ctx);
        if (poster) return poster;
      }
      if (el.readyState < 2 || !el.videoWidth) return null;
      const canvas = document.createElement("canvas");
      canvas.width = el.videoWidth;
      canvas.height = el.videoHeight;
      canvas.getContext("2d")?.drawImage(el, 0, 0);
      return dataUrlBytes(canvas.toDataURL("image/png"));
    }
    if (!el.width || !el.height) return null;
    return dataUrlBytes(el.toDataURL("image/png"));
  } catch {
    return null; // Tainted by a cross-origin image, or not decodable.
  }
}

function dataUrlBytes(url: string): Uint8Array | null {
  const comma = url.indexOf(",");
  if (comma < 0 || !url.startsWith("data:image/png;base64")) return null;
  const binary = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.length > 100 ? bytes : null;
}

/**
 * An SVG used as an image, as PNG bytes Figma can take.
 *
 * Figma's image fills accept PNG, JPEG, GIF and WebP only, so `<img
 * src="logo.svg">` was "Could not read image". Drawn at 2x so it stays crisp.
 */
async function rasteriseSvg(src: string, width: number, height: number): Promise<Uint8Array | null> {
  try {
    const image = new Image();
    image.decoding = "sync";
    image.src = src;
    await image.decode();
    const w = Math.max(1, Math.round((width || image.naturalWidth || 64) * 2));
    const h = Math.max(1, Math.round((height || image.naturalHeight || 64) * 2));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(image, 0, 0, w, h);
    return dataUrlBytes(canvas.toDataURL("image/png"));
  } catch {
    return null;
  }
}

/**
 * Turn `::before` / `::after` into real elements, so they are measured and
 * imported like anything else.
 *
 * They carry a lot in AI-generated pages: icons and bullets (`content: "★"`),
 * dividers and underlines (`content: ""` with a height and a background),
 * badges, quote marks. None of them are in the DOM, so all of them were
 * dropped. Each becomes a `<span>` with the pseudo-element's computed styles
 * copied inline, and the original is switched off so it does not paint twice.
 */
const PSEUDO_PROPERTIES = [
  "display", "position", "top", "right", "bottom", "left", "width", "height",
  "min-width", "min-height", "max-width", "max-height", "box-sizing",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "background-color", "background-image", "background-size", "background-position",
  "background-repeat", "background-clip",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
  "color", "font-family", "font-size", "font-weight", "font-style", "line-height",
  "letter-spacing", "text-transform", "text-decoration-line", "text-align", "white-space",
  "opacity", "transform", "transform-origin", "box-shadow", "z-index",
  "flex-grow", "flex-shrink", "flex-basis", "align-self", "vertical-align", "order",
];
const SKIP_PSEUDO = new Set(["IMG", "INPUT", "TEXTAREA", "SELECT", "BR", "HR", "IFRAME", "VIDEO", "CANVAS", "OPTION", "svg"]);

function materializePseudoElements(container: HTMLElement): void {
  const hosts = Array.from(container.querySelectorAll<HTMLElement>("*"));
  let marked = false;
  for (const el of hosts) {
    if (SKIP_PSEUDO.has(el.tagName) || el instanceof SVGElement) continue;
    for (const which of ["before", "after"] as const) {
      let cs: CSSStyleDeclaration;
      try {
        cs = getComputedStyle(el, `::${which}`);
      } catch {
        continue;
      }
      const content = cs.content;
      if (!content || content === "none" || content === "normal") continue;
      if (cs.display === "none") continue;
      const text = pseudoText(content, el);
      if (text === null) continue;

      const span = document.createElement("span");
      span.setAttribute("data-cd2f-pseudo", which);
      span.setAttribute("data-name", `::${which}`);
      const declarations: string[] = [];
      for (const prop of PSEUDO_PROPERTIES) {
        const value = cs.getPropertyValue(prop);
        if (value) declarations.push(`${prop}:${value}`);
      }
      span.setAttribute("style", declarations.join(";"));
      span.textContent = text;
      if (which === "before") el.insertBefore(span, el.firstChild);
      else el.appendChild(span);
      el.setAttribute(`data-cd2f-no-${which}`, "");
      marked = true;
    }
  }
  if (marked) {
    const off = document.createElement("style");
    off.setAttribute("data-cd2f-pseudo-off", "");
    off.textContent =
      "[data-cd2f-no-before]::before{content:none!important}[data-cd2f-no-after]::after{content:none!important}";
    container.appendChild(off);
  }
}

/**
 * An inline SVG as markup Figma will draw the way the page did.
 *
 * `outerHTML` alone lost two things every icon set relies on: `currentColor`,
 * which Figma reads as black (so every `stroke="currentColor"` icon imported
 * black), and fills or strokes set by CSS classes, which do not travel with the
 * markup. `<use href="#icon">` sprites pointed at symbols outside the snippet.
 */
function serializeSvg(el: SVGSVGElement): string {
  const clone = el.cloneNode(true) as SVGSVGElement;
  const originals = [el, ...Array.from(el.querySelectorAll("*"))];
  const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];
  for (let i = 0; i < originals.length && i < copies.length; i++) {
    const cs = getComputedStyle(originals[i]);
    const copy = copies[i];
    for (const attr of ["fill", "stroke"] as const) {
      const declared = copy.getAttribute(attr);
      const computed = cs.getPropertyValue(attr);
      if (declared && /currentcolor/i.test(declared)) copy.setAttribute(attr, cs.color);
      else if (!declared && computed && computed !== "none" && i > 0 && /^(path|circle|rect|ellipse|line|polyline|polygon|text|g)$/i.test(copy.tagName)) {
        copy.setAttribute(attr, computed);
      }
    }
    const inline = copy.getAttribute("style");
    if (inline && /currentcolor/i.test(inline)) copy.setAttribute("style", inline.replace(/currentcolor/gi, cs.color));
  }
  for (const use of Array.from(clone.querySelectorAll("use"))) {
    const ref = (use.getAttribute("href") || use.getAttribute("xlink:href") || "").replace(/^#/, "");
    const target = ref ? el.ownerDocument.getElementById(ref) : null;
    if (!target) continue;
    const g = el.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
    for (const child of Array.from(target.childNodes)) g.appendChild(child.cloneNode(true));
    use.replaceWith(g);
  }
  if (!clone.getAttribute("width")) clone.setAttribute("width", String(el.getBoundingClientRect().width));
  if (!clone.getAttribute("height")) clone.setAttribute("height", String(el.getBoundingClientRect().height));
  return clone.outerHTML.replace(/currentColor/g, getComputedStyle(el).color);
}

/** The text a `content` value paints, or null for what we cannot reproduce (images, counters). */
function pseudoText(content: string, el: Element): string | null {
  if (/url\(|counter|image-set|gradient/.test(content)) return null;
  let out = "";
  const token = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([\w-]+)\s*\)|(open-quote|close-quote|no-open-quote|no-close-quote)/g;
  let match: RegExpExecArray | null;
  let any = false;
  while ((match = token.exec(content))) {
    any = true;
    if (match[1] !== undefined || match[2] !== undefined) {
      out += (match[1] ?? match[2]).replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/\\(.)/g, "$1");
    } else if (match[3]) {
      out += el.getAttribute(match[3]) ?? "";
    } else if (match[4] === "open-quote") out += "\u201C";
    else if (match[4] === "close-quote") out += "\u201D";
  }
  return any ? out : null;
}

// ---------------------------------------------------------------------------
// Viewport emulation
// ---------------------------------------------------------------------------

/**
 * The design's viewport height, for `vh` and height media queries.
 *
 * A Claude Design canvas has a width and no height, and `100vh` means "one
 * screen" to its author. 16:10 is the laptop screen the width implies: 1440
 * gives 900.
 */
function designViewportHeight(width: number): number {
  return Math.round(width * 0.625);
}

type Viewport = { width: number; height: number };

const VIEWPORT_UNIT = /(-?(?:\d+\.?\d*|\.\d+))(dvw|svw|lvw|vw|dvh|svh|lvh|vh|dvmin|svmin|lvmin|vmin|dvmax|svmax|lvmax|vmax)\b/g;

/**
 * Render the page at the design's size, not the plugin window's.
 *
 * The page is measured inside the plugin's own window: about 400x620 in Figma.
 * Everything relative to the viewport resolved against that. `font-size: 5vw`
 * came out 37.8px instead of 72, a `100vh` hero was squashed to the window, and
 * `@media (max-width: 800px)` matched, so the MOBILE layout was measured
 * inside a 1440px frame. The window cannot be resized to 1440x900, so the CSS
 * is: viewport units become px for the design size, and every media query
 * that asks about size is answered for the design size and pinned to `all` or
 * `not all`. Queries about anything else (colour scheme, hover, motion) are
 * left to the browser.
 */
function emulateViewport(container: HTMLElement, adopted: Element[], viewport: Viewport): void {
  const sheets: CSSStyleSheet[] = [];
  const owners = [...adopted, ...Array.from(container.querySelectorAll("style, link[rel~='stylesheet']"))];
  for (const node of owners) {
    const sheet = (node as HTMLStyleElement | HTMLLinkElement).sheet;
    if (sheet) sheets.push(sheet);
  }
  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // Cross-origin: nothing to rewrite, and nothing we could.
    }
    rewriteRules(rules, viewport);
  }

  for (const el of Array.from(container.querySelectorAll<HTMLElement>("[style]"))) {
    const text = el.getAttribute("style") ?? "";
    if (/v(w|h|min|max)\b/.test(text)) el.setAttribute("style", toPx(text, viewport));
  }
}

/**
 * `position: fixed` means "on the screen", and the screen is the design's first
 * viewport, as it is in a browser scrolled to the top.
 *
 * The stage has `contain: layout`, which makes it the containing block for
 * fixed descendants, so `bottom: 0` meant the bottom of the whole page: a
 * floating button or cookie bar landed below the footer. Bottom-anchored boxes
 * are re-anchored from the top of the first screen, and a box pinned on both
 * edges (a full-screen overlay) gets one screen's height.
 */
function anchorFixedToViewport(container: HTMLElement, viewport: Viewport): void {
  for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed") continue;
    // getComputedStyle resolves an `auto` offset of a positioned box to px, so
    // it cannot say which edge the author pinned. Typed OM keeps `auto`.
    const map = (el as HTMLElement & { computedStyleMap?: () => StylePropertyMapReadOnly }).computedStyleMap?.();
    const specified = (prop: "top" | "bottom") => {
      const value = map?.get(prop)?.toString();
      return value === undefined ? cs[prop] : value;
    };
    const top = specified("top");
    const bottom = specified("bottom");
    if (bottom === "auto" || bottom === "") continue;
    const height = el.getBoundingClientRect().height;
    if (top !== "auto" && top !== "") {
      el.style.setProperty("height", `${Math.max(0, viewport.height - parseFloat(top) - parseFloat(bottom))}px`, "important");
    } else {
      el.style.setProperty("top", `${viewport.height - parseFloat(bottom) - height}px`, "important");
    }
    el.style.setProperty("bottom", "auto", "important");
  }
}

/**
 * Give the body stand-in the page's own body margin and padding.
 *
 * Read from the page's CSS (rules on `body`, then its inline style), with the
 * browser's default 8px margin when nothing sets one. The rules cannot be read
 * off the plugin's real <body>, which carries Ferry's own panel styles.
 */
function applyBodyBox(
  body: HTMLElement,
  adopted: Element[],
  parsedBody: HTMLElement | null,
  defaultMargin: string,
): void {
  const box: Record<string, string> = {
    "margin-top": defaultMargin, "margin-right": defaultMargin, "margin-bottom": defaultMargin, "margin-left": defaultMargin,
  };
  const PROPS = [
    "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding-top", "padding-right", "padding-bottom", "padding-left",
  ];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const media = (rule as CSSMediaRule).media;
      if (media && media.mediaText === "not all") continue;
      const style = (rule as CSSStyleRule).style;
      const selector = (rule as CSSStyleRule).selectorText;
      if (style && selector && selector.split(",").some((part) => /^(html\s+)?body$/i.test(part.trim()))) {
        for (const prop of PROPS) {
          const value = style.getPropertyValue(prop);
          if (value) box[prop] = value;
        }
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested && nested.length > 0) visit(nested);
    }
  };
  for (const node of adopted) {
    const sheet = (node as HTMLStyleElement | HTMLLinkElement).sheet;
    if (!sheet) continue;
    try {
      visit(sheet.cssRules);
    } catch {
      // Cross-origin: a font sheet, no body box in it.
    }
  }
  const inline = parsedBody?.style;
  if (inline) {
    for (const prop of PROPS) {
      const value = inline.getPropertyValue(prop);
      if (value) box[prop] = value;
    }
  }
  for (const [prop, value] of Object.entries(box)) body.style.setProperty(prop, value);
}

function rewriteRules(rules: CSSRuleList, viewport: Viewport): void {
  for (const rule of Array.from(rules)) {
    try {
      const media = (rule as CSSMediaRule).media;
      if (media && rule.constructor.name !== "CSSImportRule") {
        const verdict = evaluateMediaList(media.mediaText, viewport);
        if (verdict !== null) media.mediaText = verdict ? "all" : "not all";
      }
      const style = (rule as CSSStyleRule).style;
      if (style) {
        for (let i = 0; i < style.length; i++) {
          const prop = style[i];
          const value = style.getPropertyValue(prop);
          if (!VIEWPORT_UNIT.test(value)) continue;
          VIEWPORT_UNIT.lastIndex = 0;
          style.setProperty(prop, toPx(value, viewport), style.getPropertyPriority(prop));
        }
        VIEWPORT_UNIT.lastIndex = 0;
      }
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested && nested.length > 0) rewriteRules(nested, viewport);
    } catch {
      // One rule the browser will not let us touch is one rule left as it was.
    }
  }
}

function toPx(value: string, viewport: Viewport): string {
  return value.replace(VIEWPORT_UNIT, (_, n: string, unit: string) => {
    const base = unit.replace(/^(d|s|l)/, "");
    const size =
      base === "vw"
        ? viewport.width
        : base === "vh"
          ? viewport.height
          : base === "vmin"
            ? Math.min(viewport.width, viewport.height)
            : Math.max(viewport.width, viewport.height);
    return `${+((parseFloat(n) * size) / 100).toFixed(3)}px`;
  });
}

/**
 * true / false for a media query list that asks only about size (and media
 * type), or null when it asks about anything else, which the browser keeps.
 */
function evaluateMediaList(text: string, viewport: Viewport): boolean | null {
  const list = text.split(",").map((q) => q.trim()).filter(Boolean);
  if (list.length === 0) return null;
  let any = false;
  for (const query of list) {
    const verdict = evaluateMediaQuery(query, viewport);
    if (verdict === null) return null;
    if (verdict) any = true;
  }
  return any;
}

const SIZE_FEATURE = /^(min-|max-)?(width|height|aspect-ratio|orientation|device-width|device-height)$/;

function evaluateMediaQuery(query: string, viewport: Viewport): boolean | null {
  let q = query.toLowerCase().replace(/\s+/g, " ").trim();
  let negate = false;
  if (q.startsWith("not ")) {
    negate = true;
    q = q.slice(4);
  }
  q = q.replace(/^only /, "");

  const parts = q.split(/ and /).map((p) => p.trim());
  let result = true;
  let sawSize = false;
  for (const part of parts) {
    if (part === "all" || part === "screen") continue;
    if (part === "print" || part === "speech") {
      result = false;
      continue;
    }
    const inner = /^\((.*)\)$/.exec(part)?.[1];
    if (inner === undefined) return null;
    const verdict = evaluateSizeFeature(inner.trim(), viewport);
    if (verdict === null) return null;
    sawSize = true;
    result = result && verdict;
  }
  if (!sawSize && result) return null; // `screen` alone: nothing to decide.
  return negate ? !result : result;
}

function evaluateSizeFeature(feature: string, viewport: Viewport): boolean | null {
  const value = (name: string): number | null => {
    const base = name.replace(/^device-/, "");
    if (base === "width") return viewport.width;
    if (base === "height") return viewport.height;
    if (base === "aspect-ratio") return viewport.width / viewport.height;
    return null;
  };
  const length = (raw: string): number | null => {
    const r = raw.trim();
    const ratio = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(r);
    if (ratio) return parseFloat(ratio[1]) / parseFloat(ratio[2]);
    const m = /^(-?\d*\.?\d+)(px|em|rem)?$/.exec(r);
    if (!m) return null;
    return parseFloat(m[1]) * (m[2] === "em" || m[2] === "rem" ? 16 : 1);
  };

  // Level 3: (min-width: 800px), (orientation: landscape)
  const colon = /^([a-z-]+)\s*:\s*(.+)$/.exec(feature);
  if (colon) {
    const [, name, raw] = colon;
    if (!SIZE_FEATURE.test(name)) return null;
    if (name === "orientation") return (viewport.width >= viewport.height ? "landscape" : "portrait") === raw.trim();
    const prefix = /^(min|max)-/.exec(name)?.[1];
    const actual = value(name.replace(/^(min|max)-/, ""));
    const target = length(raw);
    if (actual === null || target === null) return null;
    return prefix === "min" ? actual >= target : prefix === "max" ? actual <= target : actual === target;
  }

  // Level 4 ranges: (width >= 800px), (400px < width <= 800px)
  const ops = feature.split(/\s*(<=|>=|<|>|=)\s*/);
  if (ops.length === 3 || ops.length === 5) {
    const compare = (a: number, op: string, b: number) =>
      op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : a === b;
    const resolve = (token: string): number | null =>
      SIZE_FEATURE.test(token) ? value(token) : length(token);
    const names = ops.filter((_, i) => i % 2 === 0);
    if (!names.some((t) => /^(width|height|aspect-ratio|device-width|device-height)$/.test(t))) return null;
    for (let i = 0; i + 2 < ops.length; i += 2) {
      const a = resolve(ops[i]);
      const b = resolve(ops[i + 2]);
      if (a === null || b === null) return null;
      if (!compare(a, ops[i + 1], b)) return false;
    }
    return true;
  }
  return null;
}

/**
 * What a document's script sees when it asks how big the window is.
 *
 * A Claude Design script that picks a layout from `innerWidth` or
 * `matchMedia("(max-width: …)")` would otherwise pick the plugin window's.
 * Queries about anything but size go to the real matchMedia.
 */
function reportDesignViewport(viewport: Viewport): () => void {
  const originalMatchMedia = window.matchMedia.bind(window);
  const widthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
  const heightDescriptor = Object.getOwnPropertyDescriptor(window, "innerHeight");
  try {
    Object.defineProperty(window, "innerWidth", { configurable: true, get: () => viewport.width });
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => viewport.height });
  } catch {
    // Not redefinable here; scripts see the real window.
  }
  window.matchMedia = ((query: string) => {
    const verdict = evaluateMediaList(query, viewport);
    if (verdict === null) return originalMatchMedia(query);
    const real = originalMatchMedia(query);
    return Object.assign(Object.create(Object.getPrototypeOf(real)), {
      matches: verdict,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  }) as typeof window.matchMedia;

  return () => {
    window.matchMedia = originalMatchMedia;
    try {
      if (widthDescriptor) Object.defineProperty(window, "innerWidth", widthDescriptor);
      else delete (window as { innerWidth?: number }).innerWidth;
      if (heightDescriptor) Object.defineProperty(window, "innerHeight", heightDescriptor);
      else delete (window as { innerHeight?: number }).innerHeight;
    } catch {
      // Left as the design size; harmless once the stage is gone.
    }
  };
}

type HostSnapshot = Array<{ el: Element; attrs: Map<string, string> }>;

function snapshotHost(): HostSnapshot {
  return [document.documentElement, document.body].map((el) => ({
    el,
    attrs: new Map(Array.from(el.attributes).map((a) => [a.name, a.value])),
  }));
}

function restoreHost(snapshot: HostSnapshot): void {
  for (const { el, attrs } of snapshot) {
    for (const attr of Array.from(el.attributes)) {
      if (!attrs.has(attr.name)) el.removeAttribute(attr.name);
    }
    for (const [name, value] of attrs) {
      if (el.getAttribute(name) !== value) el.setAttribute(name, value);
    }
  }
}

/**
 * Which root re-theme the page is rendering in right now, if any.
 *
 * Last match wins, because that is the cascade: two variants of equal
 * specificity both switched on resolve to the later one.
 */
function activeRootTheme(tokens: TokenIndex): string | undefined {
  let active: string | undefined;
  for (const { selector, activation } of tokens.rootThemes ?? []) {
    const root = document.documentElement;
    const on =
      activation.kind === "attr"
        ? activation.value === undefined
          ? root.hasAttribute(activation.name)
          : root.getAttribute(activation.name) === activation.value
        : activation.kind === "class"
          ? root.classList.contains(activation.name)
          : window.matchMedia(`(prefers-color-scheme: ${activation.scheme})`).matches;
    if (on) active = selector;
  }
  return active;
}

/**
 * Identify stylesheets that were linked but never resolved.
 *
 * Claude Design downloads one file at a time, so a lone `.dc.html` still links
 * `_ds/<system>/tokens/*.css` that the user does not have. Those links simply
 * fail, every colour falls back to a literal, and the import looks like the
 * plugin ignored the design system. Detecting it lets the UI say what happened
 * and how to fix it.
 */
/**
 * Count the markup that STILL needs Claude Design's runtime to become real,
 * after `resolveDynamicDocument` has already had a chance to run the
 * embedded script and resolve everything it could.
 *
 * `support.js` resolves `{{ expr }}` placeholders and expands `sc-for`/`sc-if`,
 * and in some documents an entire `style="{{ S.card }}"` attribute is a
 * placeholder, so stripping scripts leaves not just missing text but missing
 * styling. `x-import` mounts JS-defined components that simply are not there
 * without their bundle. None of this fails loudly, so it has to be counted.
 *
 * Counted from `parsed` itself (post-resolution, post-script-strip) rather
 * than the original raw `html` string, so a document that resolved
 * successfully reports zero here even though the source text was full of
 * `{{ }}` — only what's genuinely left unresolved should trigger a warning.
 */
/**
 * Turn Claude Design's <image-slot> into something visible.
 *
 * It is a custom element defined by `image-slot.js`, which we strip along with
 * every other script. Unupgraded it renders as an unknown inline element, so
 * its authored width and height never apply and the whole thing measures as
 * nothing — it disappears from the import with no node and no warning.
 *
 * Everything needed to place it properly is on the tag already, so it becomes
 * a correctly-sized, correctly-shaped, labelled box to drop a real image into.
 */
function stubImageSlots(parsed: Document): number {
  const slots = Array.from(parsed.querySelectorAll("image-slot"));

  for (const slot of slots) {
    const shape = slot.getAttribute("shape") ?? "rect";
    const radius =
      shape === "circle"
        ? "50%"
        : shape === "pill"
          ? "999px"
          : shape === "rounded"
            ? (slot.getAttribute("radius") ?? "8px")
            : "0";

    // Drawn the way Claude Design's own image-slot.js draws an empty slot: a
    // block that fills its container (3:2 unless sized), a faint grey fill, a
    // dashed ring in the text colour at 35%, and a centred image icon over
    // the placeholder caption at 75%. An empty dashed box told a designer
    // nothing about what goes there.
    const caption = slot.getAttribute("placeholder") ?? "Drop an image";
    const box = parsed.createElement("div");
    box.setAttribute("data-name", caption);
    box.setAttribute(
      "style",
      [
        "display:flex",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "gap:6px",
        "position:relative",
        "width:100%",
        "height:100%",
        "aspect-ratio:3/2",
        "box-sizing:border-box",
        "font:13px/1.3 system-ui,-apple-system,sans-serif",
        "background:rgba(127,127,127,.08)",
        "border:1.5px dashed color-mix(in srgb, currentColor 35%, transparent)",
        `border-radius:${radius}`,
        slot.getAttribute("style") ?? "",
      ].join(";"),
    );
    box.innerHTML =
      '<svg data-name="Image icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="opacity:.75"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>' +
      `<span data-name="Caption" style="opacity:.75">${caption.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</span>`;
    slot.replaceWith(box);
  }

  return slots.length;
}

function detectDynamicContent(
  parsed: Document,
  resolved: ResolveReport,
): IRDocument["dynamicContent"] {
  const source = parsed.querySelector("x-dc") ?? parsed.body;
  const html = source ? source.innerHTML : "";
  const placeholders = (html.match(/\{\{/g) ?? []).length;
  // sc-for/sc-if always arrive renamed to template[data-sc-for]/
  // template[data-sc-if] (preprocessTableSafeMarkup runs on every document,
  // before parsing) — a resolution failure leaves those markers in place
  // rather than the original tag names, so match on the markers.
  const loops = parsed.querySelectorAll("template[data-sc-for], template[data-sc-if]").length;
  const components = parsed.querySelectorAll("x-import").length;
  // Call sites STILL standing after resolution, which for a successful pass is
  // zero: `resolveDcImport` (src/ui/resolve.ts) replaces every one with either
  // the target's real content or a correctly sized placeholder. Non-zero here
  // means the resolver bailed out altogether — a target that was simply
  // missing shows up in `resolved.documentsMissing` instead, with a visible
  // box on the canvas to match.
  const documents = parsed.querySelectorAll("dc-import").length;
  return { placeholders, loops, components, documents, resolved };
}

function findMissingStylesheets(nodes: Element[]): string[] {
  const missing: string[] = [];

  for (const node of nodes) {
    if (node.tagName !== "LINK") continue;
    const link = node as HTMLLinkElement;

    const href = link.getAttribute("href");
    if (!href || href.startsWith("data:")) continue;

    let resolved = false;
    try {
      resolved = link.sheet !== null && link.sheet.cssRules.length > 0;
    } catch {
      // A sheet that exists but refuses inspection is loaded, just opaque.
      resolved = link.sheet !== null;
    }

    if (!resolved) missing.push(href);
  }

  return missing;
}

async function waitForStylesheets(nodes: Element[]): Promise<void> {
  const links = nodes
    .filter((node): node is HTMLLinkElement => node.tagName === "LINK")
    // An absolute http(s) stylesheet — a font service, typically — can never
    // load: the plugin declares no network access at all. Waiting on one costs
    // the full timeout and buys nothing, which is why a document linking Google
    // Fonts took 11 seconds to extract while a larger one took 0.8. It still
    // gets reported as a missing stylesheet, which is the honest outcome.
    .filter((link) => !/^https?:/i.test(link.getAttribute("href") ?? ""));

  if (links.length === 0) return;

  await Promise.race([
    Promise.all(
      links.map(
        (link) =>
          new Promise<void>((resolve) => {
            // `sheet` is already populated for a cached stylesheet.
            if (link.sheet) return resolve();
            link.addEventListener("load", () => resolve(), { once: true });
            link.addEventListener("error", () => resolve(), { once: true });
          }),
      ),
    ),
    new Promise((resolve) => real.setTimeout(resolve, 5000)),
  ]);
}

/**
 * React spells SVG presentation attributes in camelCase (`strokeWidth`,
 * `strokeDasharray`, `textAnchor`) and converts them when it renders. Claude
 * Design writes them that way in its markup too, and without React the HTML
 * parser lowercases them to names SVG ignores: a thick dashed "pace" line
 * imported as a thin solid one. They are renamed to the real attributes here.
 */
const JSX_SVG_ATTRIBUTES: Record<string, string> = {
  strokewidth: "stroke-width", strokedasharray: "stroke-dasharray", strokedashoffset: "stroke-dashoffset",
  strokelinecap: "stroke-linecap", strokelinejoin: "stroke-linejoin", strokemiterlimit: "stroke-miterlimit",
  strokeopacity: "stroke-opacity", fillopacity: "fill-opacity", fillrule: "fill-rule", cliprule: "clip-rule",
  clippath: "clip-path", textanchor: "text-anchor", dominantbaseline: "dominant-baseline",
  alignmentbaseline: "alignment-baseline", baselineshift: "baseline-shift", fontsize: "font-size",
  fontfamily: "font-family", fontweight: "font-weight", fontstyle: "font-style", letterspacing: "letter-spacing",
  wordspacing: "word-spacing", stopcolor: "stop-color", stopopacity: "stop-opacity", floodcolor: "flood-color",
  floodopacity: "flood-opacity", lightingcolor: "lighting-color", markerstart: "marker-start",
  markermid: "marker-mid", markerend: "marker-end", vectoreffect: "vector-effect", shaperendering: "shape-rendering",
  textrendering: "text-rendering", imagerendering: "image-rendering", pointerevents: "pointer-events",
  writingmode: "writing-mode", colorinterpolationfilters: "color-interpolation-filters", xlinkhref: "href",
};

function fixJsxSvgAttributes(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll("svg, svg *"))) {
    for (const attr of Array.from(el.attributes)) {
      const real = JSX_SVG_ATTRIBUTES[attr.name];
      if (!real) continue;
      if (!el.hasAttribute(real)) el.setAttribute(real, attr.value);
      el.removeAttribute(attr.name);
    }
  }
}

/** Request every font face the mounted text uses, so its download is under way. */
async function loadUsedFaces(container: HTMLElement): Promise<void> {
  if (!document.fonts?.load) return;
  const faces = new Set<string>();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && faces.size < 60; node = walker.nextNode()) {
    if (!node.textContent?.trim() || !node.parentElement) continue;
    const cs = getComputedStyle(node.parentElement);
    faces.add(`${cs.fontStyle} ${cs.fontWeight} 16px ${cs.fontFamily}`);
  }
  await Promise.all(Array.from(faces).map((font) => document.fonts.load(font).catch(() => [])));
}

async function waitForAssets(scope: HTMLElement): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  const pending = images
    .filter((img) => !img.complete)
    .map(
      (img) =>
        new Promise<void>((resolve) => {
          const done = () => resolve();
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
        }),
    );

  // Fonts get their own, much shorter budget. A document linking a font
  // service has webfonts that can never arrive under `networkAccess: none`, so
  // `fonts.ready` simply stays pending and the full asset timeout elapses for
  // nothing — six seconds of it, on a document with no images at all. Local and
  // inlined faces resolve almost immediately, so a short wait costs them
  // nothing and an unreachable one stops being able to stall the import.
  //
  // `fonts.ready` alone is not enough: it resolves at once when no download has
  // STARTED, and a web font's download only starts once text using it is laid
  // out. A 148px Instrument Serif name was measured in the fallback serif and
  // wrapped onto two lines. So every face the page's text uses is requested
  // explicitly first, and the wait covers those requests (network is allowed
  // for Google Fonts, so they do arrive, within the budget).
  const fonts = Promise.race([
    loadUsedFaces(scope).then(() => document.fonts?.ready),
    new Promise((resolve) => real.setTimeout(resolve, 4000)),
  ]);

  // Never let a hung asset block the whole import.
  await Promise.race([
    Promise.all([...pending, fonts]),
    new Promise((resolve) => real.setTimeout(resolve, 6000)),
  ]);

  // One more frame so layout settles after fonts swap in — but rAF only fires
  // while the surface is actually being painted, and a plugin iframe in a
  // backgrounded window is not. Racing a timer keeps this from deadlocking.
  await Promise.race([
    new Promise((resolve) => real.requestAnimationFrame(() => resolve(null))),
    new Promise((resolve) => real.setTimeout(resolve, 300)),
  ]);

  // Force a synchronous layout so measurements below are against settled boxes
  // even when the frame callback never ran.
  void scope.getBoundingClientRect();
}

export async function extractDocument(
  html: string,
  name: string,
  options: Partial<ExtractOptions> = {},
): Promise<IRDocument> {
  const opts = { ...DEFAULT_EXTRACT_OPTIONS, ...options };
  debug("mounting");
  const handle = await mountDocument(html, opts);
  debug("mounted");

  try {
    return await measureMounted(handle, html, name, opts);
  } finally {
    handle.dispose();
  }
}

/**
 * Every scene of a Claude Design animation as its own document, measured from
 * ONE mount: the engine seeks between scenes, so its React tree, compiled
 * modules and fonts are paid for once.
 */
export async function extractAnimationScenes(
  html: string,
  name: string,
  options: Partial<ExtractOptions> = {},
  onScene?: (done: number, total: number, label: string) => void,
): Promise<{ docs: IRDocument[]; scenes: Array<{ name: string; dur: number }>; loop: boolean }> {
  const opts = { ...DEFAULT_EXTRACT_OPTIONS, ...options };
  const handle = await mountDocument(html, opts);
  try {
    const live = handle.animation;
    if (!live) return { docs: [await measureMounted(handle, html, name, opts)], scenes: [], loop: false };
    const docs: IRDocument[] = [];
    for (let i = 0; i < live.scenes.length; i++) {
      const scene = live.scenes[i];
      onScene?.(i, live.scenes.length, scene.name);
      live.seek(settledMoment(live, scene));
      docs.push(await measureMounted(handle, html, `${name} · ${i + 1} ${scene.name}`, opts));
    }
    return { docs, scenes: live.scenes.map((s) => ({ name: s.name, dur: s.dur })), loop: live.loop };
  } finally {
    handle.dispose();
  }
}

async function measureMounted(
  handle: RenderHandle,
  html: string,
  name: string,
  opts: ExtractOptions,
): Promise<IRDocument> {
  {
    const tokens = buildTokenIndex(
      ownedStylesheets(handle),
      inferSystemName(html) ?? name,
      opts.dsManifest,
    );
    debug(`tokens indexed: ${tokens.definitions.length}`);
    // A root re-theme covers the whole page, so every node is inside it and
    // matches against its values. Recorded once, on the root frame, the same
    // way a themed subtree records its scope on its outermost node.
    const rootScope = activeRootTheme(tokens);
    const ctx: Ctx = {
      tokens,
      options: opts,
      warnings: [],
      imageCache: new Map(),
      themeScope: rootScope ?? null,
      pendingLineHeights: [],
    };

    await prefetchBackgroundImages(handle.root, ctx);

    const children: IRNode[] = [];
    const deckSlides = detectDeckSlides(handle.root);
    if (deckSlides) {
      debug(`deck detected: ${deckSlides.length} slides`);
      await walkDeckSlides(deckSlides, handle.root, ctx, children);
    } else {
      for (const child of Array.from((handle.body ?? handle.root).children)) {
        debug(`walking <${child.tagName.toLowerCase()}>`);
        const node = await walk(child as HTMLElement, handle.root, ctx);
        if (node) children.push(node);
      }
    }
    debug("walk complete");

    // Now that the walk has stopped reading layout, measure every `normal`
    // line-height in one pass. Safe here for the same reason `rootBackground`
    // is: no measurement is left for the probe to disturb.
    resolvePendingLineHeights(handle, ctx);

    if (handle.imageSlots > 0) {
      ctx.warnings.push(
        handle.imageSlots === 1
          ? "1 image slot imported as an empty placeholder — drop your own image into it."
          : `${handle.imageSlots} image slots imported as empty placeholders — drop your own images into them.`,
      );
    }

    // A document whose boot phase (componentDidMount -> import(), see
    // resolve.ts) asked for a sibling module we were never given resolves
    // that import to {} rather than hanging — which means the document
    // renders whatever ITS OWN "loading" state looks like, not a crash. Name
    // the missing file so the fix is a specific, actionable one rather than
    // "some placeholders didn't resolve, good luck".
    const modulesMissing = handle.dynamicContent.resolved.modulesMissing;
    if (modulesMissing.length > 0) {
      ctx.warnings.push(
        modulesMissing.length === 1
          ? `${modulesMissing[0]} was not provided, so this document imported in its loading state — include the whole project folder or .zip.`
          : `${modulesMissing.join(", ")} were not provided, so this document imported in its loading state — include the whole project folder or .zip.`,
      );
    }

    // The same problem one level up: a `<dc-import name="Portage Panel">` whose
    // sibling .dc.html was never dropped. `resolveDcImport` (src/ui/resolve.ts)
    // already left a labelled, hint-sized box on the canvas, so unlike a
    // missing module this one is visible. The warning's only job is to name the
    // file to go and fetch, per document rather than per call site: one board
    // embeds the same panel fourteen times.
    const documentsMissing = handle.dynamicContent.resolved.documentsMissing;
    if (documentsMissing.length > 0) {
      ctx.warnings.push(
        documentsMissing.length === 1
          ? `${documentsMissing[0]} was not provided, so it imported as an empty placeholder box. Include the whole project folder or .zip.`
          : `${documentsMissing.join(", ")} were not provided, so they imported as empty placeholder boxes. Include the whole project folder or .zip.`,
      );
    }

    // `mountDocument` above adopts `head style, head link` and nothing else, so
    // a `<script>` inside an embedded document's `<helmet>` never reaches the
    // live DOM. Dropping it is right (we never run a document's scripts), but a
    // helmet script is usually a font loader or a polyfill that changes how the
    // page looks, so the difference between Claude Design's render and ours has
    // to be stated rather than left for someone to notice on the canvas.
    const helmetScriptsDropped = handle.dynamicContent.resolved.helmetScriptsDropped;
    if (helmetScriptsDropped > 0) {
      ctx.warnings.push(
        helmetScriptsDropped === 1
          ? "1 script inside an embedded document's <helmet> was not run, so anything it would have styled or loaded is missing."
          : `${helmetScriptsDropped} scripts inside embedded documents' <helmet> blocks were not run, so anything they would have styled or loaded is missing.`,
      );
    }

    // Canvas-mode documents place absolutely-positioned boards at large
    // offsets, so the root has to be sized from content, not the viewport.
    // A page, by contrast, is a screen at the design width: a small component
    // on it came in as a 352px frame, which is not what the browser showed.
    // So a page keeps its origin and is at least the viewport wide; canvases,
    // decks and animation stages still size to what they hold.
    const sizedToContent =
      !!deckSlides || !!handle.animation || /design_doc_mode["']?\s+content=["']canvas/i.test(html);
    const measured = contentBounds(children);
    const bounds = sizedToContent
      ? measured
      : {
          x: 0,
          y: 0,
          width: Math.max(opts.viewportWidth, measured.x + measured.width),
          // A page shorter than the screen still fills the screen in the
          // browser (Claude Design's runtime sets html, body to 100% height),
          // so its frame is at least one viewport tall. A $preview component
          // renders at its declared height instead (opts.previewHeight).
          height: Math.max(opts.previewHeight ?? designViewportHeight(opts.viewportWidth), measured.y + measured.height),
        };
    for (const child of children) {
      child.x -= bounds.x;
      child.y -= bounds.y;
    }

    const root: IRNode = {
      kind: "FRAME",
      name,
      x: 0,
      y: 0,
      width: Math.max(bounds.width, 1),
      height: Math.max(bounds.height, 1),
      opacity: 1,
      rotation: 0,
      // The page is a screen: what overflows it is off-screen in the browser too.
      clips: true,
      fills: rootBackground(handle, ctx),
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      effects: [],
      children,
    };
    if (rootScope) root.themeScope = rootScope;

    return {
      name,
      // `surfaces`/`key`/`shadows` are populated only when the export shipped
      // `_ds_manifest.json`, and they are what turns mode (b) from a flat dump
      // into a real library: modes, an idempotent re-import, and the fifteen
      // shadow tokens that are otherwise dropped without a word. Gated on
      // tokens existing, because a design system with no variables in it is
      // not a design system.
      designSystem:
        tokens.definitions.length > 0
          ? {
              name: tokens.systemName,
              tokens: tokens.definitions,
              surfaces: tokens.surfaces,
              // Which of those surfaces the document declares for ITSELF, so
              // the sandbox can tell an axis a layer here really sits under
              // from a design system's other product surfaces. Absent when
              // there is no axis, exactly as `TokenIndex.themeScopes` is.
              axis: tokens.themeScopes,
              baseModeLabel: tokens.baseModeLabel,
              key: tokens.key,
              shadows: tokens.shadows,
            }
          : undefined,
      root,
      warnings: ctx.warnings,
      missingStylesheets: handle.missingStylesheets,
      dynamicContent: handle.dynamicContent,
    };
  }
}

// ---------------------------------------------------------------------------
// State enumeration: one frame per prop combination
// ---------------------------------------------------------------------------

/**
 * The props of a document that can be enumerated, read without mounting it.
 *
 * Parse only: `data-props` lives on the `<script data-dc-script>` tag itself,
 * so answering "what states does this screen have" costs one `DOMParser` pass
 * over text already in memory. That is what lets the panel offer the choice at
 * pick time rather than after an import has already happened.
 */
export function documentStateAxes(html: string): StateAxis[] {
  return stateAxes(enumerableProps(readPropsSchema(parseForSchema(html))));
}

function parseForSchema(html: string): Document {
  return new DOMParser().parseFromString(preprocessTableSafeMarkup(html), "text/html");
}

export type StateEnumerationOptions = {
  /** Prop names to enumerate, in axis order. `[0]` varies fastest. */
  props: string[];
  cap?: number;
};

/**
 * Extract one document once per prop combination: N documents, not one document
 * with N somethings inside it.
 *
 * N `IRDocument`s is the whole design. They ride the batch path every other
 * multi-frame import already uses (`buildDocuments`, src/plugin/build.ts), so
 * there is one placement mechanism, one failure-cleanup path and one selection
 * path in the codebase rather than two that have to agree.
 *
 * STRICTLY sequential, and it has to stay that way. `mountDocument` above
 * appends its stage to the live `document.body` and adopts the document's own
 * `<style>`/`<link>` into the one shared `document.head`; only `dispose()`
 * undoes that. Two combinations in flight measure each other's cascade, and
 * this document declares literal element ids (`#cd2f-*` in the Portage panel),
 * so they would also duplicate every id in the page.
 *
 * Throws rather than degrading in both refusal cases: nothing to enumerate, and
 * a matrix past the cap. A caller that quietly imported the defaults instead, or
 * the first 24 of 54 states, would look exactly like a matrix that worked.
 */
export async function extractStateMatrix(
  html: string,
  name: string,
  options: Partial<ExtractOptions> & { states: StateEnumerationOptions },
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<IRDocument[]> {
  const schema = readPropsSchema(parseForSchema(html));
  const selected = selectAxes(stateAxes(enumerableProps(schema)), options.states.props);
  if (selected.length === 0) {
    throw new Error(`${name} declares no enumerable props, so there are no states to import.`);
  }

  const cap = options.states.cap ?? STATE_COMBINATION_CAP;
  const plan = propCombinations(selected, cap);
  if (plan.capped) {
    throw new Error(
      `${name} would import as ${plan.total} frames, past the ${cap}-frame cap. Enumerate fewer props.`,
    );
  }

  const preview = schema.preview;
  const docs: IRDocument[] = [];

  for (let index = 0; index < plan.combos.length; index++) {
    const combo = plan.combos[index];
    const frameName = stateFrameName(name, combo.label);
    onProgress?.(index, plan.combos.length, combo.label);

    const doc = await extractDocument(html, frameName, {
      ...options,
      propOverrides: combo.values,
      // Claude Design previews this document at `$preview`, so that is the
      // width its states were authored against. Measuring at the panel's
      // 1440 default would stretch a 400px-wide panel to the viewport and
      // report a matrix of the wrong shape.
      viewportWidth: preview?.width ?? options.viewportWidth,
      previewHeight: preview?.height ?? 1,
    });

    const sized = previewFrameSize(doc.root, preview);
    if (sized.overflows) {
      doc.warnings.push(
        `${combo.label} rendered ${Math.round(doc.root.width)}x${Math.round(doc.root.height)}, larger than the declared preview of ${preview?.width}x${preview?.height}. The frame was grown to fit rather than cropping it.`,
      );
    }
    doc.root.width = sized.width;
    doc.root.height = sized.height;
    doc.props = combo.values;

    docs.push(doc);
  }

  onProgress?.(plan.combos.length, plan.combos.length, "");
  return docs;
}

// ---------------------------------------------------------------------------
// Deck detection — one Figma frame per slide instead of one tall stack
// ---------------------------------------------------------------------------

/** Left-to-right spacing between slide frames on the canvas. */
const DECK_SLIDE_GAP = 200;

/** Speaker notes longer than this are dropped from the frame name (see deckSlideName). */
const DECK_NOTES_MAX_CHARS = 60;

/**
 * A Claude Design deck export wraps its slides in `<deck-stage>`, with each
 * `<section data-label="…">` sized to the deck's fixed pixel dimensions.
 * Editable deck templates drop the `<deck-stage>` wrapper and use sibling
 * `<section data-screen-label="…">` elements directly. Either shape means
 * "normal flow" would stack the slides into one tall frame — the DOM has no
 * idea they are meant to read as a deck — so this looks for both shapes
 * before the ordinary walk ever runs.
 */
function detectDeckSlides(container: HTMLElement): HTMLElement[] | null {
  const stage = container.querySelector("deck-stage");
  if (stage) {
    const slides = Array.from(stage.children).filter(
      (el): el is HTMLElement => el.nodeType === Node.ELEMENT_NODE,
    );
    if (slides.length > 0) return slides;
  }

  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>("section[data-label], section[data-screen-label]"),
  );
  if (candidates.length < 2) return null;

  // Group by parent so an unrelated pair of labelled sections elsewhere in the
  // document can't be mistaken for a deck — a deck's slides are always
  // siblings of each other.
  const groups = new Map<HTMLElement | null, HTMLElement[]>();
  for (const el of candidates) {
    const parent = el.parentElement;
    const group = groups.get(parent);
    if (group) group.push(el);
    else groups.set(parent, [el]);
  }

  for (const group of groups.values()) {
    if (group.length >= 2 && slidesShareFixedSize(group)) return group;
  }
  return null;
}

/** Every element in the group renders at the same non-zero pixel size. */
function slidesShareFixedSize(elements: HTMLElement[]): boolean {
  const rects = elements.map((el) => el.getBoundingClientRect());
  const { width, height } = rects[0];
  if (width <= 0 || height <= 0) return false;
  return rects.every(
    (rect) => Math.abs(rect.width - width) < 1 && Math.abs(rect.height - height) < 1,
  );
}

/**
 * Walk each detected slide as its own top-level frame and lay them out
 * left-to-right with a gap, instead of leaving them in normal-flow position.
 *
 * Each slide is walked with its own DOM parent so nested children still
 * measure correctly (their coordinates stay relative to the slide element's
 * own box, which `walk` computes from real layout regardless of where we
 * place the slide afterward) — only the slide frame's own x/y gets
 * overwritten here.
 */
async function walkDeckSlides(
  slides: HTMLElement[],
  fallbackParent: HTMLElement,
  ctx: Ctx,
  out: IRNode[],
): Promise<void> {
  let cursorX = 0;
  for (let i = 0; i < slides.length; i++) {
    const slideEl = slides[i];
    const node = await walk(slideEl, slideEl.parentElement ?? fallbackParent, ctx);
    if (!node) continue;

    node.x = cursorX;
    node.y = 0;
    node.name = deckSlideName(slideEl, i, ctx);

    out.push(node);
    cursorX += node.width + DECK_SLIDE_GAP;
  }
}

/**
 * Name a slide frame from `data-label`/`data-screen-label`, falling back to
 * "Slide N" when neither is present (or is blank). `data-speaker-notes` rides
 * along as a name suffix when short enough to be useful in a layer panel;
 * anything longer gets dropped with a warning instead of inventing a Figma
 * notes API that does not exist.
 */
function deckSlideName(el: HTMLElement, index: number, ctx: Ctx): string {
  const label = el.getAttribute("data-label") ?? el.getAttribute("data-screen-label");
  const base = label && label.trim() ? label.trim() : `Slide ${index + 1}`;

  const notes = el.getAttribute("data-speaker-notes")?.trim();
  if (!notes) return base;

  if (notes.length <= DECK_NOTES_MAX_CHARS) return `${base} · ${notes}`;

  ctx.warnings.push(
    `Speaker notes for slide "${base}" were too long to fit in the layer name (${notes.length} characters) and were dropped.`,
  );
  return base;
}

/**
 * The stylesheets the imported document brought with it: the ones we adopted
 * from its <helmet>/<head>, plus any <style> living inside the content itself.
 * Deliberately excludes the plugin's own CSS and Figma's injected theme.
 */
function ownedStylesheets(handle: RenderHandle): CSSStyleSheet[] {
  const owned: CSSStyleSheet[] = [];

  const add = (node: Element) => {
    const sheet = (node as HTMLStyleElement | HTMLLinkElement).sheet;
    if (sheet) owned.push(sheet);
  };

  for (const node of handle.adopted) add(node);
  for (const node of Array.from(handle.container.querySelectorAll("style, link"))) {
    add(node);
  }

  return owned;
}

/**
 * The stylesheets the DOCUMENT brought, without the one the user supplied.
 *
 * `extraCss` is a design system picked separately in the panel, and its rules
 * are indistinguishable from the document's own once both are `<style>` tags in
 * the same head. For anything asking "what did this document say about itself",
 * that difference matters: `_ds/*_/tokens/typography.css` ships a `body { }`
 * rule, and a token file the user handed to a file input is not the screen
 * declaring its own background.
 */
function documentStylesheets(handle: RenderHandle): CSSStyleSheet[] {
  const owned: CSSStyleSheet[] = [];

  const add = (node: Element) => {
    if (node.hasAttribute(EXTRA_CSS_MARKER)) return;
    const sheet = (node as HTMLStyleElement | HTMLLinkElement).sheet;
    if (sheet) owned.push(sheet);
  };

  for (const node of handle.adopted) add(node);
  for (const node of Array.from(handle.container.querySelectorAll("style, link"))) {
    add(node);
  }

  return owned;
}

function inferSystemName(html: string): string | undefined {
  // `_ds/acme-design-system-<uuid>/tokens/colors.css` -> "acme design system"
  const match = html.match(/_ds\/([a-z0-9-]+?)-[0-9a-f]{8}-[0-9a-f]{4}/i);
  if (!match) return undefined;
  return match[1].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The colour the imported document paints behind everything.
 *
 * This used to read `getComputedStyle(document.body).backgroundColor` — the
 * PLUGIN's body, because `mountDocument` renders the document into the plugin's
 * own page rather than an iframe (see its doc comment for why it has to). The
 * plugin paints that body `var(--figma-color-bg) !important`, so the same
 * import produced #FFFFFF for a designer on Figma's light theme and #2C2C2C on
 * dark, while `Portage.dc.html` authors `body{background:#eceded}` in its own
 * <helmet> and got neither. The host page's chrome is not the design.
 *
 * "The document's body" and "the plugin's body" are the same element, so the
 * colour is recovered from the document's own STYLESHEETS instead: the last
 * `html`/`body`/`:root` rule any sheet the document brought with it declares a
 * background in. Sheets supplied separately as `extraCss` are excluded, because
 * a design system the user handed to the picker is not this document saying
 * what colour it is.
 *
 * A document that authors nothing gets white, which is what a browser paints
 * behind a page that says nothing: deterministic, and the same for every user.
 */
function rootBackground(handle: RenderHandle, ctx: Ctx): IRPaint[] {
  const declared = canvasBackgroundDeclaration(handle);
  const color = declared ? resolveDeclaredColor(declared, handle) : null;
  if (!color || color.a === 0) {
    return [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }];
  }
  // The declaration goes through so `background:var(--background)` can bind to
  // the variable it names, exactly as an element's own background does.
  return [solid(color, ctx, declared)];
}

/** Selectors that describe the page's canvas rather than a box inside it. */
const CANVAS_SELECTORS = new Set(["html", "body", ":root"]);

function canvasBackgroundDeclaration(handle: RenderHandle): string | undefined {
  let found: string | undefined;

  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      const styleRule = rule as CSSStyleRule;
      if (styleRule.selectorText && styleRule.style) {
        const matches = styleRule.selectorText
          .split(",")
          .some((part) => CANVAS_SELECTORS.has(part.trim().toLowerCase()));
        if (matches) {
          // `background-color` first: a `background` shorthand carries image and
          // position parts that are not a colour, and the longhand is what the
          // shorthand resolved to anyway.
          const value =
            styleRule.style.getPropertyValue("background-color").trim() ||
            styleRule.style.getPropertyValue("background").trim();
          // Last one wins, which is the cascade for two rules of equal weight.
          if (value) found = value;
        }
      }

      // Same reason as tokens.ts's collectFromRules: since Chrome 112 an
      // ordinary style rule also exposes `cssRules`, so this cannot be an else.
      const nested = (rule as CSSGroupingRule).cssRules;
      if (nested && nested.length > 0) visit(nested);
    }
  };

  for (const node of documentStylesheets(handle)) {
    let rules: CSSRuleList;
    try {
      rules = node.cssRules;
    } catch {
      // Cross-origin stylesheet; skip rather than fail the whole import.
      continue;
    }
    if (rules) visit(rules);
  }

  return found;
}

/**
 * Resolve a declared background value to a colour.
 *
 * A literal parses on its own. `var(--background)` does not, and rebuilding the
 * variable cascade by hand would get a chain wrong sooner or later, so the
 * engine that already resolved it for the document resolves it again: a
 * zero-sized hidden probe inside the mounted stage, which inherits the
 * document's custom properties exactly as its body would have. Safe to add and
 * remove here because `rootBackground` runs after the walk, so there is no
 * measurement left for it to disturb.
 */
function resolveDeclaredColor(declared: string, handle: RenderHandle): IRColor | null {
  const direct = parseColor(declared);
  if (direct) return direct;

  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden";
  probe.style.background = declared;
  handle.container.appendChild(probe);
  const computed = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return parseColor(computed);
}

function contentBounds(nodes: IRNode[]) {
  if (nodes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

/**
 * The re-theme class this element carries, if the document declared a mode axis.
 *
 * Only selectors from the DETECTED axis (`detectThemeAxis`, src/ui/tokens.ts).
 * A design system's manifest surfaces are deliberately not matched here: a
 * lone `.acme-deck` block is not an axis, so a node under it keeps resolving
 * through `matchTokenByVar`'s colour guard exactly as it did before modes
 * existed.
 */
function themeScopeOf(el: HTMLElement, ctx: Ctx): string | undefined {
  const selectors = ctx.tokens.themeScopes;
  if (!selectors || ctx.tokens.rootThemes) return undefined;
  for (const selector of selectors) {
    if (el.classList.contains(selector.slice(1))) return selector;
  }
  return undefined;
}

/**
 * Walk one element, tracking which theme its subtree is inside.
 *
 * The scope is recorded on the OUTERMOST node that introduces it and nowhere
 * else: a Figma variable mode resolves down the tree, so one call on the panel
 * frame covers every layer in it, and stamping every descendant would be
 * hundreds of redundant mode assignments saying the same thing.
 */
async function walk(
  el: HTMLElement,
  parent: HTMLElement,
  ctx: Ctx,
): Promise<IRNode | null> {
  if (SKIPPED_TAGS.has(el.tagName)) return null;

  const scope = themeScopeOf(el, ctx);
  if (!scope || scope === ctx.themeScope) return walkElement(el, parent, ctx);

  const outer = ctx.themeScope;
  ctx.themeScope = scope;
  try {
    const node = await walkElement(el, parent, ctx);
    if (node) node.themeScope = scope;
    return node;
  } finally {
    ctx.themeScope = outer;
  }
}

async function walkElement(
  el: HTMLElement,
  parent: HTMLElement,
  ctx: Ctx,
): Promise<IRNode | null> {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return null;

  // A rotated box measures as its rotated bounding box, which is bigger than
  // the box and has no angle. Measure it with the transform off, so the layer
  // and everything inside it are laid out upright, and carry the angle instead.
  const turn = rotationOf(style);
  const rotatedRect = turn !== 0 ? el.getBoundingClientRect() : null;
  const restoreTransform = turn !== 0 ? suspendTransform(el) : null;
  try {
    const node = await walkMeasured(el, parent, ctx, style, turn, rotatedRect);
    if (node && style.mixBlendMode && style.mixBlendMode !== "normal") node.blendMode = style.mixBlendMode;
    return node;
  } finally {
    restoreTransform?.();
  }
}

async function walkMeasured(
  el: HTMLElement,
  parent: HTMLElement,
  ctx: Ctx,
  style: CSSStyleDeclaration,
  turn: number,
  rotatedRect: DOMRect | null,
): Promise<IRNode | null> {
  const rect = el.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  const hasChildren = el.children.length > 0;
  if (rect.width <= 0 && rect.height <= 0 && !hasChildren) return null;

  // Upright size, placed so its centre is where the rotated box's centre was.
  const centre = rotatedRect
    ? { x: rotatedRect.left + rotatedRect.width / 2, y: rotatedRect.top + rotatedRect.height / 2 }
    : null;
  const base: BoxBase = {
    x: round(centre ? centre.x - rect.width / 2 - parentRect.left : rect.left - parentRect.left),
    y: round(centre ? centre.y - rect.height / 2 - parentRect.top : rect.top - parentRect.top),
    width: round(rect.width),
    height: round(rect.height),
    opacity: clampOpacity(style.opacity),
    rotation: turn,
    clips: clipsContent(style),
  };

  // Before the text walk, because a form control's visible text is never a DOM
  // text node it could find: see formControlNode.
  const control = formControlNode(el, style, base, ctx);
  if (control) return control;

  // A chart drawn on a <canvas> is pixels, not DOM: without this it imported
  // as an empty frame. A tainted canvas (cross-origin image drawn in) refuses.
  if (el.tagName === "CANVAS" || el.tagName === "VIDEO") {
    const bytes = await snapshotMedia(el as HTMLCanvasElement | HTMLVideoElement, ctx);
    if (bytes) {
      return {
        kind: "IMAGE",
        name: el.getAttribute("data-name") || el.getAttribute("aria-label") || (el.tagName === "CANVAS" ? "Canvas" : "Video"),
        ...base,
        fills: [],
        cornerRadius: cornerRadii(style),
        effects: effects(style, ctx),
        imageBytes: bytes,
        children: [],
      };
    }
    ctx.warnings.push(
      el.tagName === "CANVAS"
        ? "A <canvas> could not be read, so it imported as an empty box."
        : "A video had no poster or loaded frame, so it imported as an empty box.",
    );
  }

  if (el.tagName === "IMG") {
    const imgSrc = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
    const bytes =
      (await loadImage(imgSrc, ctx)) ?? (await rasteriseSvg(imgSrc, rect.width, rect.height));
    if (!bytes) {
      ctx.warnings.push(`Could not read image: ${(el as HTMLImageElement).alt || (el as HTMLImageElement).src}`);
      return null;
    }
    const fit = style.objectFit;
    return {
      kind: "IMAGE",
      name: imageName(el as HTMLImageElement),
      imageScale: fit === "cover" ? "FILL" : fit === "contain" || fit === "scale-down" || fit === "none" ? "FIT" : "CROP",
      ...base,
      fills: [],
      cornerRadius: cornerRadii(style),
      effects: effects(style, ctx),
      imageBytes: bytes,
      children: [],
    };
  }

  if (el.tagName === "svg" || el.tagName === "SVG") {
    return {
      kind: "VECTOR",
      name: vectorName(el, base),
      ...base,
      fills: [],
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      effects: effects(style, ctx),
      svg: serializeSvg(el as unknown as SVGSVGElement),
      children: [],
    };
  }

  if (isTextContainer(el)) {
    const text = extractText(el, style, ctx);
    if (text && text.characters.trim().length > 0) {
      fitLineHeightToBox(text, rect.height, style);
      const maxLines = truncationOf(style);
      if (maxLines) text.maxLines = maxLines;
      // `background-clip: text` clips every background to the glyphs. Painted
      // as a fill it came in as a gradient block with invisible text on top.
      const clipsToText = /text/.test(
        style.backgroundClip || style.getPropertyValue("-webkit-background-clip"),
      );
      if (clipsToText) {
        const glyphFill = parseLinearGradient(style.backgroundImage);
        if (glyphFill) text.glyphFill = glyphFill;
      }
      const fills = clipsToText ? [] : backgroundPaints(el, style, ctx);
      const border = borders(el, style, ctx);
      const shadows = effects(style, ctx);
      const padding = {
        top: px(style.paddingTop),
        right: px(style.paddingRight),
        bottom: px(style.paddingBottom),
        left: px(style.paddingLeft),
      };

      // A Figma TEXT node carries no background, border or padding. When the
      // element has any of those — a badge, a pill, a bordered callout — the
      // decoration would be silently dropped, so it becomes a padded frame with
      // the text inside, which is also how a designer would have built it.
      const decorated =
        fills.length > 0 ||
        border !== undefined ||
        shadows.length > 0 ||
        padding.top > 0 ||
        padding.right > 0 ||
        padding.bottom > 0 ||
        padding.left > 0;

      if (!decorated) {
        if (keepsItsWidth(el, style, rect, text)) text.fixedWidth = true;
        return {
          kind: "TEXT",
          // Figma's own convention: a text layer is named by its words, and
          // stays in step when the copy is edited. An authored name would go
          // stale the first time it was.
          name: truncate(text.characters, 40),
          ...base,
          fills: [],
          cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
          effects: [...shadows, ...textShadows(style)],
          text,
          children: [],
        };
      }

      const borderBox = {
        left: px(style.borderLeftWidth),
        right: px(style.borderRightWidth),
        top: px(style.borderTopWidth),
        bottom: px(style.borderBottomWidth),
      };

      const child: IRNode = {
        kind: "TEXT",
        name: truncate(text.characters, 40),
        x: padding.left + borderBox.left,
        y: padding.top + borderBox.top,
        width: round(
          rect.width - padding.left - padding.right - borderBox.left - borderBox.right,
        ),
        height: round(
          rect.height - padding.top - padding.bottom - borderBox.top - borderBox.bottom,
        ),
        opacity: 1,
        rotation: 0,
        clips: false,
        // A single-line label must not be pinned to the measured width, or a
        // wider substituted font wraps it inside its own chip.
        sizing: {
          horizontal: text.singleLine ? "HUG" : "FILL",
          vertical: "FIXED",
        },
        fills: [],
        cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
        effects: textShadows(style),
        text,
        children: [],
      };

      // A fixed-size box wraps its text without hugging it: an icon square or
      // an avatar declares a width larger than the glyphs it centres. Hugging one
      // collapses the box onto the text, which is how a 16px logo square imports
      // as an 8px bar. Measure the text's own rendered box and only hug when the
      // element sits tight against it horizontally. A real pill (width == label
      // plus padding) has no horizontal slack and still hugs; a sized box does.
      //
      // Only the horizontal axis is a reliable signal. A line of text always
      // leaves vertical room between its ink box and its line box, so the box is
      // a few px taller than the glyphs measure even when it hugs, and reading
      // that as slack would stop every pill and badge from hugging.
      const contentRange = el.ownerDocument.createRange();
      contentRange.selectNodeContents(el);
      const contentRect = contentRange.getBoundingClientRect();
      const innerWidth =
        rect.width - padding.left - padding.right - borderBox.left - borderBox.right;
      const HUG_SLACK = 2;
      const boxHugsItsText =
        contentRect.width > 0 && innerWidth - contentRect.width <= HUG_SLACK;

      // Where the text actually sits in the box, on each axis: a 40px round
      // icon button (`display: grid; place-items: center`) put its arrow
      // top-left because only text-align was read. Measured, the way the
      // browser placed it, whatever CSS did the placing.
      const inner = {
        left: rect.left + borderBox.left + padding.left,
        right: rect.right - borderBox.right - padding.right,
        top: rect.top + borderBox.top + padding.top,
        bottom: rect.bottom - borderBox.bottom - padding.bottom,
      };
      const placed = (start: number, end: number): "MIN" | "CENTER" | "MAX" | null => {
        if (contentRect.width <= 0) return null;
        if (start > 1 && Math.abs(start - end) <= 1.5) return "CENTER";
        if (start > 1 && end <= 1) return "MAX";
        return null;
      };
      const across = placed(contentRect.left - inner.left, inner.right - contentRect.right);
      const down = placed(contentRect.top - inner.top, inner.bottom - contentRect.bottom);

      return {
        kind: "FRAME",
        name: frameName(el, undefined, style, base),
        ...base,
        layout: {
          mode: "VERTICAL",
          gap: 0,
          crossGap: 0,
          wrap: false,
          padding,
          paddingTokens: paddingTokens(el, ctx, padding),
          primaryAlign: down ?? "MIN",
          // Centre-aligned copy in the source must stay centred once the box
          // hugs, otherwise every chip label drifts left.
          crossAlign:
            across ??
            (text.align === "CENTER"
              ? "CENTER"
              : text.align === "RIGHT"
                ? "MAX"
                : "MIN"),
          source: "inferred-stack",
          hugContent: text.singleLine && boxHugsItsText,
        },
        fills,
        border,
        cornerRadius: cornerRadii(style),
        cornerToken: cornerToken(el, style, ctx),
        effects: shadows,
        children: [child],
      };
    }
  }

  // Walk childNodes rather than children, so text sitting directly on a
  // container alongside element children becomes a real layer.
  //
  // `<div>Filing type <span>23</span></div>` is ordinary markup, and it used to
  // import as a frame containing only "23" — the label was reported as a
  // warning and then dropped. Anonymous inline boxes have no element to
  // measure, so a Range stands in for one.
  const children: IRNode[] = [];
  const sources: Array<Element | null> = [];
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const fragment = looseTextNode(child as Text, el, rect, ctx);
      if (fragment) {
        children.push(fragment);
        sources.push(null);
      }
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const node = await walk(child as HTMLElement, el, ctx);
    if (node) {
      // Out of flow in the source, out of flow in Figma: an auto-layout parent
      // would otherwise lay a badge or overlay out as the next item in the row.
      const position = getComputedStyle(child as Element).position;
      if (position === "absolute" || position === "fixed") node.absolute = true;
      children.push(node);
      sources.push(child as Element);
    }
  }

  const layout = deriveLayout(el, style, children, ctx);
  applyChildSizing(children, el, layout);
  if (!layout) orderByStacking(children, sources);

  return {
    kind: "FRAME",
    name: frameName(el, layout, style, base),
    ...base,
    layout,
    fills: backgroundPaints(el, style, ctx),
    border: borders(el, style, ctx),
    cornerRadius: cornerRadii(style),
    cornerToken: cornerToken(el, style, ctx),
    effects: effects(style, ctx),
    children,
  };
}

/**
 * Does this box clip what overflows it?
 *
 * Read from the `overflow-x`/`overflow-y` longhands, never the shorthand. A
 * scroll region is almost always written `overflow-y:auto; overflow-x:hidden`,
 * and `style.overflow` then computes to the single string "hidden auto", which
 * equals neither "hidden" nor "clip" and so tested false. Sixteen regions in
 * the Portage export came through unclipped that way, spilling 45 to 214px of
 * content over a pinned footer, which is the exact property that design's own
 * description advertises: "Header and footer are pinned; only the middle
 * scrolls, so Import can never be pushed out of reach."
 *
 * `auto` and `scroll` clip too. The browser gives them a scrollbar and hides
 * the overflow; Figma has no scrollbar, so the honest equivalent of "you cannot
 * see past this edge" is a clipped frame.
 *
 * Figma's `clipsContent` is one boolean for both axes, so a region that clips
 * only one has to pick. It clips: the axis that clips is the one the layout
 * depends on, and the free axis in a real scroll region has nothing overflowing
 * it anyway. The failure modes are not symmetric either. Clipping an axis that
 * did not need it hides content that was already inside the box; not clipping
 * an axis that did paints a column of content straight over its neighbours.
 */
function clipsContent(style: CSSStyleDeclaration): boolean {
  const clipping = (value: string) =>
    value === "hidden" || value === "clip" || value === "auto" || value === "scroll";
  return clipping(style.overflowX) || clipping(style.overflowY);
}

/**
 * Turn a bare text node into a measured TEXT layer.
 *
 * There is no element to call getBoundingClientRect on — the browser lays this
 * out as an anonymous inline box — so a Range over the text node gives the
 * geometry instead. Styling comes from the containing element, which is where
 * the cascade put it.
 */
function looseTextNode(
  text: Text,
  parent: HTMLElement,
  parentRect: DOMRect,
  ctx: Ctx,
): IRNode | null {
  const raw = text.textContent ?? "";
  if (!raw.trim()) return null;

  const range = document.createRange();
  range.selectNodeContents(text);
  const rect = range.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const style = getComputedStyle(parent);
  // The space between this text and an inline neighbour is a real rendered
  // space, and trimming it glued "Explore my work" to its arrow ("work↓").
  // A flex or grid parent drops it, as the browser does: each run there is
  // its own item and edge spaces collapse away.
  const flowing = !/flex|grid/.test(style.display);
  const inlineNeighbour = (el: Element | null) =>
    !!el && /^inline/.test(getComputedStyle(el).display);
  const lead = flowing && /^\s/.test(raw) && inlineNeighbour(text.previousElementSibling) ? " " : "";
  const tail = flowing && /\s$/.test(raw) && inlineNeighbour(text.nextElementSibling) ? " " : "";
  const characters = lead + raw.replace(/\s+/g, " ").trim() + tail;
  const run = makeRun(0, characters.length, parent, ctx);

  const lineHeight = run.lineHeight ?? run.fontSize * 1.25;

  return {
    kind: "TEXT",
    name: truncate(characters, 40),
    x: round(rect.left - parentRect.left),
    y: round(rect.top - parentRect.top),
    width: round(rect.width),
    height: round(rect.height),
    opacity: clampOpacity(style.opacity),
    rotation: 0,
    clips: false,
    fills: [],
    cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    effects: [],
    text: {
      characters,
      runs: [run],
      align: mapTextAlign(style.textAlign),
      verticalAlign: "TOP",
      singleLine: rect.height <= lineHeight * 1.5,
    },
    children: [],
  };
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

/**
 * Chrome's own affordances on a native <select>, in px, measured off the real
 * render rather than assumed.
 *
 * A 240px select with `border:1px; padding:0 6px` and one red option was
 * screenshotted and its text ink read back: the glyphs start at x=11 and the
 * text area ends at x=217, so the text sits 4px further in than the content box
 * on the leading edge and stops 16px short of it on the trailing edge, where
 * the browser paints the dropdown arrow. Both numbers hold across padding 0, 6
 * and 20px, and both disappear under `appearance:none` (text then starts at the
 * content edge, like an <input>). Two shrink-to-fit selects confirm the same
 * arithmetic: 1+6+4+textWidth+16+6+1 predicts their intrinsic widths exactly.
 */
const SELECT_TEXT_INSET = 4;
const SELECT_ARROW_WIDTH = 16;

/**
 * The chevron Chrome paints inside that 16px band. It is UA chrome with no DOM
 * node to copy, so the reserved space imported empty — a select that read as a
 * plain bordered field with no affordance that it opens. Synthesised as a small
 * downward chevron, ~10x6, centred in the band, in the control's own text
 * colour, matching the styled-select arrow Chrome draws once a border or radius
 * takes it off the native macOS control. Drawn only for a native select; an
 * `appearance:none` select threw the arrow away and drew its own, which the
 * ordinary walk already reads.
 */
const SELECT_ARROW_GLYPH_WIDTH = 10;
const SELECT_ARROW_GLYPH_HEIGHT = 6;

/**
 * What Chrome paints for a native checkbox / radio, again measured: a 20px
 * control screenshotted and read pixel by pixel.
 *
 * Checked, the whole box is `accent-color` (rgb(0,117,255) when that computes
 * to `auto`), corners rounded by ~2px. Unchecked, the interior is white and the
 * outline is rgb(118,118,118) — #767676 — one pixel wide. None of this is
 * visible through `getComputedStyle`, which reports `background-color:
 * rgba(0,0,0,0)` and `border: 0px` for both states, so it has to be written
 * down here or the control imports as an invisible empty box.
 */
const CHECKBOX_RADIUS = 2;
const CHROME_DEFAULT_ACCENT: IRColor = { r: 0, g: 117 / 255, b: 1, a: 1 };
const CHROME_CONTROL_STROKE: IRColor = { r: 118 / 255, g: 118 / 255, b: 118 / 255, a: 1 };
const CHROME_CONTROL_INTERIOR: IRColor = { r: 1, g: 1, b: 1, a: 1 };

/** Input types the browser paints with no text of their own. */
const NON_TEXTUAL_INPUT_TYPES = new Set(["file", "image", "range", "color", "hidden"]);

type BoxBase = {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  rotation: number;
  clips: boolean;
};

type ControlLabel = {
  characters: string;
  /** The control is empty and this is its placeholder, drawn in ::placeholder. */
  placeholder: boolean;
};

/**
 * Turn a form control into the layers a designer would have drawn.
 *
 * A `<select>`'s chosen option, an `<input>`'s value or placeholder and a
 * `<textarea>`'s placeholder are all real, visible, on-screen text, and none of
 * them is a DOM text node: the option is not a rendered child box of the
 * select, and a value/placeholder lives in shadow content nothing here can
 * walk. So `isTextContainer` says "not text", `extractText` finds nothing, and
 * the control lands as a correctly-sized frame with nothing in it. Measured on
 * the Portage export that is 50 visible strings gone with no warning, including
 * "Create a new local collection" fourteen times over.
 *
 * Returns null for anything this does not own, so the ordinary walk continues:
 * a `<button>`'s label and a `<textarea>`'s initial value ARE child text nodes
 * and already import correctly, and re-doing them here would only add a second
 * layer saying the same thing.
 */
function formControlNode(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  base: BoxBase,
  ctx: Ctx,
): IRNode | null {
  const tag = el.tagName;
  if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") return null;

  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    if (type === "checkbox" || type === "radio") return toggleNode(el, style, base, ctx);
  }

  const label = controlLabel(el);
  if (!label) return null;

  const border = {
    top: px(style.borderTopWidth),
    right: px(style.borderRightWidth),
    bottom: px(style.borderBottomWidth),
    left: px(style.borderLeftWidth),
  };
  const authored = {
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };
  const padding = { ...authored };

  // The arrow is not a DOM node and never becomes a layer, but the space it
  // occupies is real: without it a centred or right-aligned option sits too far
  // over, because it would be centred in a box 20px wider than the one the
  // browser used.
  if (tag === "SELECT" && style.appearance !== "none") {
    const trailingFirst = style.direction === "rtl";
    padding.left += trailingFirst ? SELECT_ARROW_WIDTH : SELECT_TEXT_INSET;
    padding.right += trailingFirst ? SELECT_TEXT_INSET : SELECT_ARROW_WIDTH;
  }

  const contentWidth = round(
    base.width - border.left - border.right - padding.left - padding.right,
  );
  const contentHeight = round(
    base.height - border.top - border.bottom - padding.top - padding.bottom,
  );

  // Only a <textarea> wraps and top-aligns. Every other control paints one line
  // centred in its content box: an input measured at height 24 and at height 40,
  // same font, put its ink at y=8 and y=16 — the extra 16px split evenly.
  const multiline = tag === "TEXTAREA";

  const run = makeRun(0, label.characters.length, el, ctx, false);
  if (label.placeholder) {
    // ::placeholder is a real cascade the author can style — the Portage export
    // sets it to --figma-color-text-tertiary — and it defaults to a grey Chrome
    // does not expose on the element itself.
    const placeholderColor = parseColor(getComputedStyle(el, "::placeholder").color);
    if (placeholderColor) run.fill = solid(placeholderColor, ctx);
  }

  const lineHeight = run.lineHeight ?? run.fontSize * 1.25;
  const text: IRText = {
    characters: label.characters,
    runs: [run],
    align: mapTextAlign(style.textAlign),
    verticalAlign: multiline ? "TOP" : "CENTER",
    singleLine: multiline
      ? !label.characters.includes("\n") && contentHeight <= lineHeight * 1.5
      : true,
  };

  const child: IRNode = {
    kind: "TEXT",
    name: truncate(label.characters, 40),
    x: round(border.left + padding.left),
    y: multiline
      ? round(border.top + padding.top)
      : round(border.top + padding.top + (contentHeight - lineHeight) / 2),
    width: Math.max(contentWidth, 1),
    height: multiline ? Math.max(contentHeight, 1) : round(lineHeight),
    opacity: 1,
    rotation: 0,
    clips: false,
    // Same bargain the decorated-text branch strikes above: a one-line label
    // must hug, or a wider substituted font wraps it inside its own field.
    sizing: { horizontal: text.singleLine ? "HUG" : "FILL", vertical: "FIXED" },
    fills: [],
    cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    effects: [],
    text,
    children: [],
  };

  // The native arrow is UA chrome the walk never saw; draw one into the band
  // its own padding already reserved, so the field reads as a dropdown. It
  // overlays the text on the trailing edge, so it is pinned absolutely rather
  // than stacked with it.
  const children: IRNode[] = [child];
  if (tag === "SELECT" && style.appearance !== "none") {
    const arrow = selectArrowNode(base, border, authored, style);
    if (arrow) children.push(arrow);
  }

  return {
    kind: "FRAME",
    name: frameName(el, undefined, style, base),
    ...base,
    // Auto-layout rather than an absolute child, because that is what survives
    // font substitution: `primaryAlign` re-centres the line the way the browser
    // does and `crossAlign` reproduces text-align, whatever width the
    // replacement face turns out to be.
    layout: {
      mode: "VERTICAL",
      gap: 0,
      crossGap: 0,
      wrap: false,
      padding,
      // Bound from the AUTHORED padding: the select's arrow allowance is
      // Chrome's, not the designer's, and must not bind a spacing variable.
      paddingTokens: paddingTokens(el, ctx, authored),
      primaryAlign: multiline ? "MIN" : "CENTER",
      crossAlign:
        text.align === "CENTER" ? "CENTER" : text.align === "RIGHT" ? "MAX" : "MIN",
      source: "inferred-stack",
      hugContent: false,
    },
    fills: backgroundPaints(el, style, ctx),
    border: borders(el, style, ctx),
    cornerRadius: cornerRadii(style),
    cornerToken: cornerToken(el, style, ctx),
    effects: effects(style, ctx),
    children,
  };
}

/**
 * The downward chevron a native <select> paints in its arrow band, synthesised
 * as an SVG because there is no DOM node to copy. Returns null when the band is
 * narrower than the glyph — a pathological control drops the arrow rather than
 * hanging it off an edge.
 */
function selectArrowNode(
  base: BoxBase,
  border: { top: number; right: number; bottom: number; left: number },
  authored: { top: number; right: number; bottom: number; left: number },
  style: CSSStyleDeclaration,
): IRNode | null {
  // The band sits at the trailing edge — right for LTR, left for RTL — inside
  // the border and the AUTHORED padding, mirroring where formControlNode pushed
  // the text out of.
  const trailingFirst = style.direction === "rtl";
  const bandLeft = trailingFirst
    ? border.left + authored.left
    : base.width - border.right - authored.right - SELECT_ARROW_WIDTH;
  if (bandLeft < 0 || bandLeft + SELECT_ARROW_WIDTH > base.width) return null;

  const x = round(bandLeft + (SELECT_ARROW_WIDTH - SELECT_ARROW_GLYPH_WIDTH) / 2);
  const y = round((base.height - SELECT_ARROW_GLYPH_HEIGHT) / 2);
  const color = parseColor(style.color) ?? { r: 0.2, g: 0.2, b: 0.2, a: 1 };

  return {
    kind: "VECTOR",
    name: "Dropdown arrow",
    x,
    y,
    width: SELECT_ARROW_GLYPH_WIDTH,
    height: SELECT_ARROW_GLYPH_HEIGHT,
    opacity: 1,
    rotation: 0,
    clips: false,
    absolute: true,
    fills: [],
    cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    effects: [],
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${SELECT_ARROW_GLYPH_WIDTH}" ` +
      `height="${SELECT_ARROW_GLYPH_HEIGHT}" viewBox="0 0 10 6" fill="none">` +
      `<path d="M1 1.25 5 4.75 9 1.25" stroke="${cssColor(color)}" ` +
      `stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    children: [],
  };
}

/**
 * A checked checkbox has no text, but it is not nothing: it is a 13x13 box
 * filled with the accent colour and a tick. Thirty-two of them import as empty
 * frames from the Portage export today.
 *
 * It becomes a frame carrying that fill, because a frame is the one thing in
 * the IR that can hold a colour and a corner radius, and a designer who wants a
 * different tick can drop one in. The tick itself is not reproduced — it is a
 * UA-drawn glyph with no source to copy — and neither is the checked radio's
 * inner dot; both read as a solid accent swatch, which is what the control
 * looks like at 13px.
 *
 * The UA's own paints (the unchecked interior and outline) deliberately skip
 * token binding: the design never authored them, so binding them to a variable
 * would claim a design decision that was Chrome's.
 */
function toggleNode(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  base: BoxBase,
  ctx: Ctx,
): IRNode | null {
  // `appearance:none` means the author threw the native control away and drew
  // their own with background/border, which the ordinary walk reads correctly.
  if (style.appearance === "none") return null;

  const input = el as HTMLInputElement;
  const radius =
    input.type === "radio"
      ? round(Math.min(base.width, base.height) / 2)
      : CHECKBOX_RADIUS;
  const accent = parseColor(style.accentColor) ?? CHROME_DEFAULT_ACCENT;

  return {
    kind: "FRAME",
    name: frameName(el, undefined, style, base),
    ...base,
    fills: input.checked
      ? [solid(accent, ctx, inlineDeclaration(el, "accent-color"))]
      : [{ type: "SOLID", color: CHROME_CONTROL_INTERIOR }],
    border: input.checked
      ? undefined
      : {
          weights: { top: 1, right: 1, bottom: 1, left: 1 },
          paint: { type: "SOLID", color: CHROME_CONTROL_STROKE },
          dashed: false,
        },
    cornerRadius: { tl: radius, tr: radius, br: radius, bl: radius },
    effects: effects(style, ctx),
    children: [],
  };
}

/** The string a control paints, and whether it is a placeholder. */
function controlLabel(el: HTMLElement): ControlLabel | null {
  if (el.tagName === "SELECT") {
    const select = el as HTMLSelectElement;
    // A list box (`multiple`, or `size` above one) lays its options out as real
    // boxes with real rects, so the ordinary walk already turns every one of
    // them into a TEXT layer. Only the collapsed dropdown hides its text.
    if (select.multiple || select.size > 1) return null;
    const option = select.selectedOptions[0] ?? select.options[0];
    const characters = collapse(option?.text ?? "");
    return characters ? { characters, placeholder: false } : null;
  }

  if (el.tagName === "TEXTAREA") {
    const area = el as HTMLTextAreaElement;
    // Its initial value is a child text node, which already imports.
    if ((area.textContent ?? "").trim()) return null;
    if (area.value.trim()) return { characters: area.value, placeholder: false };
    return area.placeholder ? { characters: area.placeholder, placeholder: true } : null;
  }

  const input = el as HTMLInputElement;
  const type = input.type;

  if (type === "submit" || type === "reset" || type === "button") {
    // The label of a button-shaped input is its `value` attribute, and the UA
    // supplies a default when there is none.
    const characters =
      collapse(input.value) || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
    return characters ? { characters, placeholder: false } : null;
  }

  // A file input's "Choose File" and a range's thumb are UA chrome, not
  // anything the document wrote; inventing text for them would be inventing
  // content.
  if (NON_TEXTUAL_INPUT_TYPES.has(type)) return null;

  if (input.value) {
    // A password field shows bullets, not the value, and the import should show
    // what the screen showed.
    const characters =
      type === "password" ? "•".repeat(input.value.length) : collapse(input.value);
    return characters ? { characters, placeholder: false } : null;
  }

  const placeholder = collapse(input.placeholder);
  return placeholder ? { characters: placeholder, placeholder: true } : null;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function deriveLayout(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  children: IRNode[],
  ctx: Ctx,
): IRLayout | undefined {
  if (children.length === 0) return undefined;

  const padding = {
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };

  if (style.display === "flex" || style.display === "inline-flex") {
    const vertical = style.flexDirection.startsWith("column");
    const reversed = style.flexDirection.endsWith("reverse");

    // Figma has no reversed auto-layout; reorder to match what was rendered.
    if (reversed) children.reverse();

    const flex: IRLayout = {
      mode: vertical ? "VERTICAL" : "HORIZONTAL",
      gap: px(vertical ? style.rowGap : style.columnGap),
      gapToken: gapToken(el, style, vertical, ctx),
      crossGap: px(vertical ? style.columnGap : style.rowGap),
      wrap: style.flexWrap === "wrap" || style.flexWrap === "wrap-reverse",
      padding,
      paddingTokens: paddingTokens(el, ctx, padding),
      primaryAlign: mapJustify(style.justifyContent),
      crossAlign: mapAlign(style.alignItems),
      source: "explicit-flex",
    };
    return verifyFlexRow(flex, children, el.getBoundingClientRect());
  }

  if (style.display === "grid" || style.display === "inline-grid") {
    const columns = style.gridTemplateColumns.split(/\s+/).filter(Boolean).length;

    // A single-track grid is just a stack; a real 2D grid has no Figma
    // equivalent, so we approximate it as a wrapping row and say so.
    if (columns <= 1) {
      return {
        mode: "VERTICAL",
        gap: px(style.rowGap),
        crossGap: 0,
        wrap: false,
        padding,
        primaryAlign: "MIN",
        crossAlign: mapAlign(style.alignItems),
        source: "explicit-grid",
      };
    }

    return {
      mode: "HORIZONTAL",
      gap: px(style.columnGap),
      crossGap: px(style.rowGap),
      wrap: true,
      padding,
      primaryAlign: "MIN",
      crossAlign: mapAlign(style.alignItems),
      source: "explicit-grid",
    };
  }

  if (!ctx.options.inferStacks) return undefined;
  return inferStack(children, padding);
}

/**
 * Keep a flex row's auto-layout only if Figma would put its children where the
 * browser did.
 *
 * Trusted blindly, `margin-left: auto` (the date pushed to the right end of a
 * tab bar) came in 330px out of place, and space-around/evenly fell to MIN.
 * The check simulates Figma's placement from alignment, gap and padding along
 * the main axis. When that misses by more than 1.5px the row is rebuilt from
 * what was measured, in the order a designer would reach for:
 *   - one common gap: MIN alignment with that gap and the measured start;
 *   - one gap much wider than the rest: a FILL spacer there (how a designer
 *     builds margin-auto in Figma, and it stays responsive);
 *   - anything else: no auto-layout, exact positions, rather than a wrong one.
 * Wrapping rows are left alone. The approach is Figit's (MIT) layout check.
 */
function verifyFlexRow(layout: IRLayout, children: IRNode[], box: DOMRect): IRLayout | undefined {
  if (layout.wrap) {
    // A wrapping row that rendered as ONE line is a row: left wrapping, Figma's
    // slightly wider items broke it in two (a header's "+ Add lead" dropped
    // under the search box). Verified as a row instead, pushes and all.
    const flowing = children.filter((c) => !c.absolute);
    const cross = (n: IRNode) => (layout.mode === "HORIZONTAL" ? n.y : n.x);
    const size = (n: IRNode) => (layout.mode === "HORIZONTAL" ? n.height : n.width);
    const oneLine = flowing.every((n) => cross(n) < cross(flowing[0]) + size(flowing[0]) - 1 && cross(flowing[0]) < cross(n) + size(n) - 1);
    if (!oneLine) return layout;
    layout = { ...layout, wrap: false };
  }
  const flow = children.filter((c) => !c.absolute);
  if (flow.length < 2) return layout;
  const horizontal = layout.mode === "HORIZONTAL";
  const pos = (n: IRNode) => (horizontal ? n.x : n.y);
  const size = (n: IRNode) => (horizontal ? n.width : n.height);
  const frame = horizontal ? box.width : box.height;
  const padStart = horizontal ? layout.padding.left : layout.padding.top;
  const padEnd = horizontal ? layout.padding.right : layout.padding.bottom;
  const inner = frame - padStart - padEnd;
  const sum = flow.reduce((t, n) => t + size(n), 0);
  const TOL = 1.5;

  const predicted: number[] = [];
  let gap = layout.gap;
  let at = padStart;
  if (layout.primaryAlign === "CENTER") at = padStart + (inner - sum - gap * (flow.length - 1)) / 2;
  if (layout.primaryAlign === "MAX") at = padStart + inner - sum - gap * (flow.length - 1);
  if (layout.primaryAlign === "SPACE_BETWEEN") gap = (inner - sum) / (flow.length - 1);
  for (const n of flow) {
    predicted.push(at);
    at += size(n) + gap;
  }
  if (flow.every((n, i) => Math.abs(pos(n) - predicted[i]) <= TOL)) return layout;

  const gaps = flow.slice(1).map((n, i) => pos(n) - (pos(flow[i]) + size(flow[i])));
  if (gaps.some((g) => g < -TOL)) return undefined; // Overlap: not a row Figma can draw.
  const sorted = [...gaps].sort((a, b) => a - b);
  // Lower middle: with two gaps the upper one is the wide gap itself.
  const common = sorted[Math.floor((sorted.length - 1) / 2)];
  const start = pos(flow[0]);
  const withPadding = (startPad: number, endPad?: number): IRLayout["padding"] =>
    horizontal
      ? { ...layout.padding, left: startPad, ...(endPad !== undefined ? { right: endPad } : {}) }
      : { ...layout.padding, top: startPad, ...(endPad !== undefined ? { bottom: endPad } : {}) };

  if (gaps.every((g) => Math.abs(g - common) <= 1)) {
    return { ...layout, gap: Math.round(common * 100) / 100, primaryAlign: "MIN", padding: withPadding(start), gapToken: undefined };
  }

  const wide = gaps.map((g, i) => (g > common + 2 ? i : -1)).filter((i) => i >= 0);
  if (wide.length === 1 && gaps.every((g, i) => i === wide[0] || Math.abs(g - common) <= 1)) {
    const k = wide[0];
    const last = flow[flow.length - 1];
    const endPad = frame - (pos(last) + size(last));
    const spacer: IRNode = {
      kind: "FRAME",
      name: "Spacer",
      x: horizontal ? pos(flow[k]) + size(flow[k]) + common : flow[k].x,
      y: horizontal ? flow[k].y : pos(flow[k]) + size(flow[k]) + common,
      width: horizontal ? Math.max(0, gaps[k] - 2 * common) : 1,
      height: horizontal ? 1 : Math.max(0, gaps[k] - 2 * common),
      opacity: 1,
      rotation: 0,
      clips: false,
      fills: [],
      cornerRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
      effects: [],
      children: [],
      sizing: horizontal ? { horizontal: "FILL", vertical: "FIXED" } : { horizontal: "FIXED", vertical: "FILL" },
    };
    children.splice(children.indexOf(flow[k]) + 1, 0, spacer);
    return {
      ...layout,
      gap: Math.round(common * 100) / 100,
      primaryAlign: "MIN",
      padding: withPadding(start, Math.max(0, endPad)),
      gapToken: undefined,
    };
  }
  return undefined;
}

/**
 * Recover auto-layout from a normal-flow block stack.
 *
 * Requires the children to be non-overlapping along one axis *and* evenly
 * spaced, because an even gap is the signal that the spacing was intentional
 * rather than incidental. When gaps vary we leave the frame absolute: a wrong
 * auto-layout is worse to work with than an honest absolute one, since it
 * silently moves things the moment the designer edits any child.
 */
function inferStack(
  children: IRNode[],
  padding: IRLayout["padding"],
): IRLayout | undefined {
  if (children.length < 2) return undefined;

  const vertical = tryAxis(children, "y", "height");
  if (vertical) {
    return {
      mode: "VERTICAL",
      gap: vertical.gap,
      crossGap: 0,
      wrap: false,
      padding,
      primaryAlign: "MIN",
      crossAlign: vertical.align,
      source: "inferred-stack",
    };
  }

  const horizontal = tryAxis(children, "x", "width");
  if (horizontal) {
    return {
      mode: "HORIZONTAL",
      gap: horizontal.gap,
      crossGap: 0,
      wrap: false,
      padding,
      primaryAlign: "MIN",
      crossAlign: horizontal.align,
      source: "inferred-stack",
    };
  }

  return undefined;
}

function tryAxis(
  children: IRNode[],
  pos: "x" | "y",
  size: "width" | "height",
): { gap: number; align: CrossAlign } | undefined {
  const sorted = [...children].sort((a, b) => a[pos] - b[pos]);
  const gaps: number[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const previousEnd = sorted[i - 1][pos] + sorted[i - 1][size];
    const gap = sorted[i][pos] - previousEnd;
    if (gap < -1) return undefined; // Overlapping: not a stack.
    gaps.push(Math.max(0, gap));
  }

  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  if (max - min > 1.5) return undefined; // Uneven: intent is unclear.

  // Preserve the rendered order for the builder.
  children.splice(0, children.length, ...sorted);

  const crossPos = pos === "y" ? "x" : "y";
  const crossSize = size === "height" ? "width" : "height";
  const starts = children.map((c) => c[crossPos]);
  const ends = children.map((c) => c[crossPos] + c[crossSize]);
  const align: CrossAlign =
    spread(starts) <= 1 ? "MIN" : spread(ends) <= 1 ? "MAX" : "CENTER";

  return { gap: round((min + max) / 2), align };
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

/**
 * Decide how each child should resize inside its parent's auto-layout.
 *
 * The bias is deliberately conservative: FILL only where the DOM explicitly
 * said "grow" or "stretch". Everything else stays FIXED, which keeps the
 * import pixel-faithful while still giving the designer a real auto-layout to
 * edit. Guessing HUG here is how importers end up reflowing a screen the
 * moment it lands.
 */
function applyChildSizing(
  children: IRNode[],
  parentEl: HTMLElement,
  layout: IRLayout | undefined,
): void {
  if (!layout) return;

  const elements = Array.from(parentEl.children).filter(
    (c) => !SKIPPED_TAGS.has(c.tagName),
  ) as HTMLElement[];

  for (const child of children) {
    // A spacer verifyFlexRow inserted has no element; it fills the main axis.
    if (child.name === "Spacer" && child.sizing && child.children.length === 0 && child.fills.length === 0) {
      child.grow = true;
      continue;
    }
    const el = elements.find(
      (candidate) => matchesNode(candidate, child),
    );

    let main: Sizing = "FIXED";
    let cross: Sizing = "FIXED";

    if (el) {
      const style = getComputedStyle(el);
      if (parseFloat(style.flexGrow) > 0) main = "FILL";

      const selfAlign =
        style.alignSelf === "auto"
          ? getComputedStyle(parentEl).alignItems
          : style.alignSelf;
      if (selfAlign === "stretch") cross = "FILL";
    }

    child.sizing =
      layout.mode === "HORIZONTAL"
        ? { horizontal: main, vertical: cross }
        : { horizontal: cross, vertical: main };
    child.grow = main === "FILL";
  }
}

function matchesNode(el: HTMLElement, node: IRNode): boolean {
  const rect = el.getBoundingClientRect();
  return (
    Math.abs(rect.width - node.width) < 1.5 &&
    Math.abs(rect.height - node.height) < 1.5
  );
}

function mapJustify(value: string): AxisAlign {
  if (value.includes("space-between")) return "SPACE_BETWEEN";
  if (value.includes("center")) return "CENTER";
  if (value.includes("end")) return "MAX";
  return "MIN";
}

function mapAlign(value: string): CrossAlign {
  if (value.includes("baseline")) return "BASELINE";
  if (value.includes("center")) return "CENTER";
  if (value.includes("end")) return "MAX";
  return "MIN";
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * An element is a text container when everything inside it is inline. The
 * check has to be on *computed display*, not tag name: Claude Design styles
 * plain <div>s as inline constantly, and a <span> can just as easily be a
 * flex row.
 */
function isTextContainer(el: HTMLElement): boolean {
  let sawText = false;

  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent && node.textContent.trim()) sawText = true;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const child = node as HTMLElement;
    if (child.tagName === "BR") continue;
    if (SKIPPED_TAGS.has(child.tagName)) continue;
    if (child.tagName === "IMG" || child.tagName === "svg") return false;

    const display = getComputedStyle(child).display;
    if (display !== "inline") return false;
    if (child.textContent && child.textContent.trim()) sawText = true;
  }

  return sawText;
}

function extractText(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  ctx: Ctx,
): IRText | null {
  const runs: IRTextRun[] = [];
  let characters = "";

  const visit = (node: Node, owner: HTMLElement) => {
    if (node.nodeType === Node.TEXT_NODE) {
      // Approximate CSS whitespace collapsing. `white-space: pre*` keeps it.
      const preserve = getComputedStyle(owner).whiteSpace.startsWith("pre");
      let value = node.textContent ?? "";
      if (!preserve) {
        value = value.replace(/\s+/g, " ");
        if (characters === "" || /\s$/.test(characters)) {
          value = value.replace(/^\s+/, "");
        }
      }
      if (!value) return;

      const start = characters.length;
      characters += value;
      runs.push(makeRun(start, characters.length, owner, ctx));
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as HTMLElement;

    if (child.tagName === "BR") {
      characters += "\n";
      return;
    }
    if (SKIPPED_TAGS.has(child.tagName)) return;

    for (const grandchild of Array.from(child.childNodes)) {
      visit(grandchild, child);
    }
  };

  for (const node of Array.from(el.childNodes)) visit(node, el);

  characters = characters.replace(/\s+$/, "");
  if (!characters) return null;

  // Drop runs the trailing trim invalidated. Clamp `end` in place rather than
  // spreading into a copy: `resolvePendingLineHeights` holds references to these
  // exact run objects and overwrites their leading after the walk, which a copy
  // here would leave pointing at a discarded original.
  const trimmed = runs
    .filter((run) => run.start < characters.length)
    .map((run) => {
      run.end = Math.min(run.end, characters.length);
      return run;
    });

  // One line if the rendered box is no taller than a single line box. Compared
  // against the largest run so a mixed-size line is not misread as wrapped.
  const lineHeight =
    style.lineHeight === "normal"
      ? px(style.fontSize) * 1.25
      : px(style.lineHeight);
  const tallestRun = trimmed.reduce(
    (max, run) => Math.max(max, run.lineHeight ?? run.fontSize * 1.25),
    lineHeight,
  );
  // Measure the TEXT, not the element. An element's box includes its padding,
  // so a padded tab is taller than its own line height and gets misread as
  // wrapped — which then hands it a wrapping box and really does break it in
  // two ("Today" importing as "Toda" / "y"). A Range over the contents
  // measures the line boxes alone.
  const contents = document.createRange();
  contents.selectNodeContents(el);
  const box = contents.getBoundingClientRect();
  const presented = asTextPresentation(characters, trimmed);

  return {
    characters: presented.characters,
    runs: presented.runs,
    align: mapTextAlign(style.textAlign),
    verticalAlign: "TOP",
    // Lines counted, not guessed from height: a display face set tight
    // (148px at line-height 0.86) has glyph boxes taller than 1.5 lines of its
    // own line height, and read as wrapped it was given a wrapping box.
    singleLine: !characters.includes("\n") && (countLines(contents) === 1 || box.height <= tallestRun * 1.5),
  };
}

/**
 * Symbols whose default presentation is text, but which Figma's font fallback
 * draws with Apple Color Emoji: "✳" came in as a green emoji tile where Chrome
 * drew a text glyph in the accent colour. A text-presentation selector
 * (U+FE0E) after each keeps them text. Symbols that are emoji by default
 * everywhere (⭐ ✅) are left alone, since Chrome draws those as emoji too.
 */
const EMOJI_CAPABLE = /[\u00A9\u00AE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u27BF\u2934\u2935\u2B05-\u2B07\u2B1B\u2B1C\u2B50\u2B55\u3030\u303D\u3297\u3299]/;
const EMOJI_BY_DEFAULT = new Set(
  "⌚⌛⏩⏪⏫⏬⏰⏳◽◾☔☕♈♉♊♋♌♍♎♏♐♑♒♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓❔❕❗➕➖➗➰➿⬛⬜⭐⭕",
);

function asTextPresentation(characters: string, runs: IRTextRun[]): { characters: string; runs: IRTextRun[] } {
  if (!EMOJI_CAPABLE.test(characters)) return { characters, runs };
  let out = "";
  const shift: number[] = [];
  for (let i = 0; i < characters.length; i++) {
    shift.push(out.length);
    const ch = characters[i];
    out += ch;
    const next = characters[i + 1];
    if (EMOJI_CAPABLE.test(ch) && !EMOJI_BY_DEFAULT.has(ch) && next !== "\uFE0F" && next !== "\uFE0E") out += "\uFE0E";
  }
  shift.push(out.length);
  return {
    characters: out,
    runs: runs.map((run) => ({ ...run, start: shift[run.start] ?? out.length, end: shift[run.end] ?? out.length })),
  };
}

/**
 * Distinct line boxes a range's text occupies: glyph boxes that overlap
 * vertically share a line. By top edge alone, a 26px "/10" set on the
 * baseline of a 46px "3" starts lower and read as a second line, and the
 * text was given a wrapping box that broke it in two.
 */
function countLines(range: Range): number {
  const bands: Array<{ top: number; bottom: number }> = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width < 0.5 || rect.height < 0.5) continue;
    const band = bands.find((b) => rect.top < b.bottom - 1 && b.top < rect.bottom - 1);
    if (band) {
      band.top = Math.min(band.top, rect.top);
      band.bottom = Math.max(band.bottom, rect.bottom);
    } else {
      bands.push({ top: rect.top, bottom: rect.bottom });
    }
  }
  return Math.max(1, bands.length);
}

function makeRun(
  start: number,
  end: number,
  owner: HTMLElement,
  ctx: Ctx,
  // A form control has already placed its label from the fallback leading, so
  // re-measuring the run would leave the glyphs and the box they sit in
  // disagreeing by a pixel or two. Everything else wants the real measurement.
  register = true,
): IRTextRun {
  const style = getComputedStyle(owner);
  const color = parseColor(style.color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const anchor = owner.closest("a");
  const normalLeading = style.lineHeight === "normal";

  const run: IRTextRun = {
    start,
    end,
    fontFamily: primaryFamily(style.fontFamily),
    fontStack: fontStackOf(style.fontFamily),
    fontWeight: parseWeight(style.fontWeight),
    italic: style.fontStyle === "italic" || style.fontStyle === "oblique",
    fontSize: px(style.fontSize),
    // A pixel value even when the author wrote `normal`, because Figma's own
    // AUTO leading is the substituted face's, not the design's. A 1.25 stand-in
    // for now; `resolvePendingLineHeights` measures the real strut after the
    // walk and overwrites it, so a paragraph keeps its on-screen height in
    // Figma instead of quietly compressing line by line.
    lineHeight: normalLeading ? round(px(style.fontSize) * 1.25) : px(style.lineHeight),
    letterSpacing: style.letterSpacing === "normal" ? 0 : px(style.letterSpacing),
    fill: solid(color, ctx, inlineDeclaration(owner, "color")),
    decoration: mapDecoration(style.textDecorationLine),
    textCase: mapTextCase(style.textTransform),
    href: anchor?.getAttribute("href") ?? undefined,
  };

  if (normalLeading && register) {
    ctx.pendingLineHeights.push({
      run,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
    });
  }

  return run;
}

/** A picture's layer name: what the author called it, never a data: URL's tail. */
function imageName(img: HTMLImageElement): string {
  const named = img.getAttribute("data-name") || img.alt || img.getAttribute("aria-label") || img.title;
  if (named) return named;
  if (!img.src.startsWith("data:")) return fileName(img.src) || "Image";
  return "Image";
}

function fontStackOf(stack: string): string[] {
  return stack
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function primaryFamily(stack: string): string {
  const first = stack.split(",")[0] ?? "";
  return first.trim().replace(/^['"]|['"]$/g, "") || "Inter";
}

/**
 * Measure the `line-height: normal` leading for every run that asked for it, in
 * one pass after the walk.
 *
 * `normal` is the font's own leading, which the browser reads off its metrics
 * and Figma reads off a possibly different face; the two disagree by a couple
 * of pixels even for the same nominal family, and down a column of text that
 * reads as the whole block sitting shorter than it did on screen. A hidden
 * single-line strut in the mounted document — where the export's `@font-face`
 * rules are still live — gives the exact number to pin.
 *
 * One probe per distinct face, all appended together and read together, so the
 * whole batch costs a single reflow. Doing it inline during the walk instead
 * put a DOM write between the walk's own layout reads and forced a reflow on
 * each of them, which turned a small screen's extraction into a many-second
 * stall. A measurement can only make the leading more faithful, so anything
 * that throws here leaves the 1.25 fallback the runs already carry.
 */
function resolvePendingLineHeights(handle: RenderHandle, ctx: Ctx): void {
  const pending = ctx.pendingLineHeights;
  if (pending.length === 0) return;

  try {
    const doc = handle.container.ownerDocument;
    if (!doc.body) return;

    const holder = doc.createElement("div");
    holder.setAttribute("aria-hidden", "true");
    holder.style.cssText =
      "position:absolute;left:-9999px;top:-9999px;visibility:hidden";

    const byFace = new Map<string, { probe: HTMLElement; runs: IRTextRun[] }>();
    for (const item of pending) {
      const key = `${item.fontFamily}|${item.fontSize}|${item.fontWeight}|${item.fontStyle}`;
      let entry = byFace.get(key);
      if (!entry) {
        const probe = doc.createElement("span");
        probe.textContent = "Mg";
        probe.style.cssText =
          "display:inline-block;white-space:nowrap;line-height:normal;margin:0;padding:0;border:0";
        probe.style.fontFamily = item.fontFamily;
        probe.style.fontSize = item.fontSize;
        probe.style.fontWeight = item.fontWeight;
        probe.style.fontStyle = item.fontStyle;
        holder.appendChild(probe);
        entry = { probe, runs: [] };
        byFace.set(key, entry);
      }
      entry.runs.push(item.run);
    }

    doc.body.appendChild(holder);
    for (const entry of byFace.values()) {
      const measured = entry.probe.getBoundingClientRect().height;
      if (measured > 0) {
        const value = round(measured);
        for (const run of entry.runs) run.lineHeight = value;
      }
    }
    holder.remove();
  } catch {
    // Runs keep their fallback leading; nothing else depends on this.
  } finally {
    pending.length = 0;
  }
}

function parseWeight(value: string): number {
  if (value === "normal") return 400;
  if (value === "bold") return 700;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? 400 : n;
}

function mapTextAlign(value: string): IRText["align"] {
  if (value === "center") return "CENTER";
  if (value === "right" || value === "end") return "RIGHT";
  if (value === "justify") return "JUSTIFIED";
  return "LEFT";
}

function mapDecoration(value: string): IRTextRun["decoration"] {
  if (value.includes("underline")) return "UNDERLINE";
  if (value.includes("line-through")) return "STRIKETHROUGH";
  return "NONE";
}

function mapTextCase(value: string): IRTextRun["textCase"] {
  if (value === "uppercase") return "UPPER";
  if (value === "lowercase") return "LOWER";
  if (value === "capitalize") return "TITLE";
  return "ORIGINAL";
}


// ---------------------------------------------------------------------------
// Paint / effects
// ---------------------------------------------------------------------------

function solid(color: IRColor, ctx: Ctx, declared?: string): IRSolidPaint {
  const paint: IRSolidPaint = { type: "SOLID", color };
  if (!ctx.options.bindTokens) return paint;

  // Pass the rendered colour so a name match can be rejected when the value
  // disagrees, which happens whenever a scoped surface re-themes the token.
  const scope = ctx.themeScope ?? undefined;
  paint.token =
    matchTokenByVar(declared, ctx.tokens, color, scope) ??
    matchColorToken(color, ctx.tokens, scope);
  return paint;
}

function backgroundPaints(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  ctx: Ctx,
): IRPaint[] {
  const paints: IRPaint[] = [];

  const color = parseColor(style.backgroundColor);
  if (color && color.a > 0) {
    paints.push(solid(color, ctx, inlineDeclaration(el, "background-color") ?? inlineDeclaration(el, "background")));
  }

  const image = style.backgroundImage;
  if (image && image !== "none") {
    const gradient = parseLinearGradient(image);
    const coverage = gradient ? backgroundCoverage(el, style) : "full";
    if (gradient && coverage === "full") {
      paints.push(gradient);
    } else if (gradient && coverage === "partial") {
      // A Figma fill always covers the whole layer, so a gradient sized to part
      // of the box (the `100% 1px` underline idiom) would paint all of it.
      const note =
        "A background gradient drawn on only part of an element (an underline, for example) was left out.";
      if (!ctx.warnings.includes(note)) ctx.warnings.push(note);
    } else if (gradient) {
      // Zero-sized: the animated-underline idiom at rest, `background-size: 0
      // 1px` grown on hover. Painting it filled every nav link with a solid
      // block of its text colour.
    } else if (image.startsWith("url(")) {
      const src = cssUrl(image);
      const bytes = src ? ctx.imageCache.get(src) : null;
      if (bytes) {
        const size = (splitTopLevel(style.backgroundSize || "auto")[0] ?? "auto").trim();
        const repeat = (splitTopLevel(style.backgroundRepeat || "repeat")[0] ?? "repeat").trim();
        paints.push({
          type: "IMAGE",
          bytesBase64: toBase64(bytes),
          scaleMode: size === "contain" ? "FIT" : size === "cover" || /no-repeat/.test(repeat) ? "FILL" : "TILE",
        });
        return paints;
      }
      ctx.warnings.push(
        `CSS background image on <${el.tagName.toLowerCase()}> was not imported (use an <img> for it to come across).`,
      );
    }
  }

  return paints;
}

/** The first `url(...)` in a background-image value. */
function cssUrl(value: string): string | null {
  const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(value);
  return m ? m[2] : null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Load every CSS background image before the walk, which reads them
 * synchronously. SVG backgrounds are rasterised, same as `<img>`.
 */
async function prefetchBackgroundImages(root: HTMLElement, ctx: Ctx): Promise<void> {
  const seen = new Set<string>();
  for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
    const value = getComputedStyle(el).backgroundImage;
    if (!value || !value.includes("url(")) continue;
    const src = cssUrl(value);
    if (!src || seen.has(src)) continue;
    seen.add(src);
    const rect = el.getBoundingClientRect();
    const bytes = (await loadImage(src, ctx)) ?? (await rasteriseSvg(src, rect.width, rect.height));
    ctx.imageCache.set(src, bytes);
  }
}

function parseLinearGradient(value: string): IRPaint | null {
  const match = value.match(/^linear-gradient\(([^]*)\)$/);
  if (!match) return null;

  const parts = splitTopLevel(match[1]);
  if (parts.length < 2) return null;

  let angle = 180;
  let stopParts = parts;

  const angleMatch = parts[0].trim().match(/^(-?[\d.]+)deg$/);
  if (angleMatch) {
    angle = parseFloat(angleMatch[1]);
    stopParts = parts.slice(1);
  } else if (parts[0].trim().startsWith("to ")) {
    const dir = parts[0].trim().slice(3);
    angle = { top: 0, right: 90, bottom: 180, left: 270 }[dir] ?? 180;
    stopParts = parts.slice(1);
  }

  const stops = stopParts
    .map((part, i) => {
      const tokens = part.trim().split(/\s+/);
      const color = parseColor(tokens.slice(0, tokens.length > 1 && tokens[tokens.length - 1].endsWith("%") ? -1 : undefined).join(" "));
      if (!color) return null;
      const pctToken = tokens[tokens.length - 1];
      const position = pctToken.endsWith("%")
        ? parseFloat(pctToken) / 100
        : i / Math.max(1, stopParts.length - 1);
      return { position, color };
    })
    .filter((s): s is { position: number; color: IRColor } => s !== null);

  if (stops.length < 2) return null;
  return { type: "GRADIENT_LINEAR", angle, stops };
}

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

function borders(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  ctx: Ctx,
): IRNode["border"] {
  const weights = {
    top: borderWeight(el, style, "Top", "top"),
    right: borderWeight(el, style, "Right", "right"),
    bottom: borderWeight(el, style, "Bottom", "bottom"),
    left: borderWeight(el, style, "Left", "left"),
  };
  // A side painted transparent draws nothing, so it has no width in Figma.
  // The loading-spinner idiom (`border: 3px solid; border-top-color:
  // transparent`) took its colour from the transparent top and lost the ring.
  const sideColor = (side: string) =>
    parseColor((style as unknown as Record<string, string>)[`border${side}Color`]);
  for (const [key, side] of [["top", "Top"], ["right", "Right"], ["bottom", "Bottom"], ["left", "Left"]] as const) {
    if (weights[key] > 0 && (sideColor(side)?.a ?? 1) === 0) weights[key] = 0;
  }
  if (Object.values(weights).every((w) => w === 0)) return undefined;

  // Pick the colour from whichever side actually has a border.
  const side =
    weights.top > 0 ? "Top" : weights.right > 0 ? "Right" : weights.bottom > 0 ? "Bottom" : "Left";
  const color = sideColor(side) ?? { r: 0, g: 0, b: 0, a: 1 };
  if (color.a === 0) return undefined;

  const styleName = (style as unknown as Record<string, string>)[`border${side}Style`];

  return {
    weights,
    paint: solid(color, ctx, inlineDeclaration(el, "border") ?? inlineDeclaration(el, "border-color")),
    dashed: styleName === "dashed" || styleName === "dotted",
  };
}

/**
 * Border width, preferring what the author declared over what the browser
 * resolved.
 *
 * Device-pixel snapping hits borders hardest: a 3px border can compute to
 * 2.727px, which is far enough from an integer that generic rounding will not
 * recover it. The declared value is right there in the inline style, so use it
 * whenever the computed style agrees a border exists at all.
 */
function borderWeight(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  side: "Top" | "Right" | "Bottom" | "Left",
  lower: "top" | "right" | "bottom" | "left",
): number {
  const computed = px(
    (style as unknown as Record<string, string>)[`border${side}Width`],
  );
  if (computed === 0) return 0;

  for (const property of [
    `border-${lower}-width`,
    `border-${lower}`,
    "border-width",
    "border",
  ]) {
    const declared = inlineDeclaration(el, property);
    if (!declared) continue;
    const match = declared.trim().match(/^(-?\d*\.?\d+)px\b/);
    if (match) return parseFloat(match[1]);
  }

  return computed;
}

function cornerRadii(style: CSSStyleDeclaration) {
  // A percentage radius stays a percentage in computed style, and `px("50%")`
  // read it as 50: an avatar over 100px came in as a rounded square instead of
  // a circle. CSS takes the horizontal percentage of the width and the
  // vertical of the height; a Figma corner is circular, so the smaller side.
  const box = Math.min(
    parseFloat(style.width) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth),
    parseFloat(style.height) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth),
  );
  const radius = (value: string): number => {
    const first = value.trim().split(/\s+/)[0] ?? "0";
    if (first.endsWith("%")) {
      const r = (parseFloat(first) / 100) * (Number.isFinite(box) ? box : 0);
      return Math.min(r, (Number.isFinite(box) ? box : r) / 2);
    }
    return px(first);
  };
  return {
    tl: radius(style.borderTopLeftRadius),
    tr: radius(style.borderTopRightRadius),
    br: radius(style.borderBottomRightRadius),
    bl: radius(style.borderBottomLeftRadius),
  };
}

function cornerToken(el: HTMLElement, style: CSSStyleDeclaration, ctx: Ctx) {
  if (!ctx.options.bindTokens) return undefined;
  const radii = cornerRadii(style);
  if (radii.tl !== radii.tr || radii.tl !== radii.br || radii.tl !== radii.bl) {
    return undefined;
  }
  return (
    matchTokenByVar(inlineDeclaration(el, "border-radius"), ctx.tokens, undefined, ctx.themeScope ?? undefined) ??
    matchFloatToken(radii.tl, ctx.tokens, "radius", ctx.themeScope ?? undefined)
  );
}

function gapToken(
  el: HTMLElement,
  style: CSSStyleDeclaration,
  vertical: boolean,
  ctx: Ctx,
) {
  if (!ctx.options.bindTokens) return undefined;
  const value = px(vertical ? style.rowGap : style.columnGap);
  return (
    matchTokenByVar(inlineDeclaration(el, "gap"), ctx.tokens, undefined, ctx.themeScope ?? undefined) ??
    matchFloatToken(value, ctx.tokens, "space", ctx.themeScope ?? undefined)
  );
}

function paddingTokens(el: HTMLElement, ctx: Ctx, padding: IRLayout["padding"]) {
  if (!ctx.options.bindTokens) return undefined;
  const out: NonNullable<IRLayout["paddingTokens"]> = {};
  let any = false;
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const token = matchFloatToken(padding[side], ctx.tokens, "space", ctx.themeScope ?? undefined);
    if (token) {
      out[side] = token;
      any = true;
    }
  }
  return any ? out : undefined;
}

function effects(style: CSSStyleDeclaration, ctx: Ctx): IREffect[] {
  const out: IREffect[] = [];

  if (style.boxShadow && style.boxShadow !== "none") {
    for (const part of splitTopLevel(style.boxShadow)) {
      const shadow = parseShadow(part.trim());
      if (shadow) out.push(shadow);
    }
  }

  const backdrop = style.backdropFilter || (style as unknown as Record<string, string>).webkitBackdropFilter;
  if (backdrop && backdrop !== "none") {
    const blur = backdrop.match(/blur\(([\d.]+)px\)/);
    // CSS blur() is a Gaussian's standard deviation; Figma's blur radius is
    // about twice that, so the CSS number came in half as soft.
    if (blur) out.push({ type: "BACKGROUND_BLUR", radius: parseFloat(blur[1]) * 2 });
  }

  if (style.filter && style.filter !== "none") {
    const blur = style.filter.match(/blur\(([\d.]+)px\)/);
    if (blur) out.push({ type: "LAYER_BLUR", radius: parseFloat(blur[1]) * 2 });
  }

  void ctx;
  return out;
}

/** `text-shadow`, as drop shadows on the text layer (no spread in CSS). */
function textShadows(style: CSSStyleDeclaration): IREffect[] {
  const value = style.textShadow;
  if (!value || value === "none") return [];
  const out: IREffect[] = [];
  for (const part of splitTopLevel(value)) {
    const shadow = parseShadow(part.trim());
    if (shadow && shadow.type === "DROP_SHADOW") out.push({ ...shadow, spread: 0 });
  }
  return out;
}

function parseShadow(value: string): IREffect | null {
  const inset = value.includes("inset");
  const cleaned = value.replace("inset", "").trim();

  // getComputedStyle normalises to "rgb(...) x y blur spread".
  const colorMatch = cleaned.match(/^(rgba?\([^)]+\)|#[0-9a-f]+)/i);
  if (!colorMatch) return null;

  const color = parseColor(colorMatch[1]);
  if (!color) return null;

  const numbers = cleaned
    .slice(colorMatch[0].length)
    .trim()
    .split(/\s+/)
    .map((n) => parseFloat(n))
    .filter((n) => !Number.isNaN(n));
  if (numbers.length < 2) return null;

  return {
    type: inset ? "INNER_SHADOW" : "DROP_SHADOW",
    color,
    offsetX: numbers[0],
    offsetY: numbers[1],
    blur: numbers[2] ?? 0,
    spread: numbers[3] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

async function loadImage(src: string, ctx: Ctx): Promise<Uint8Array | null> {
  if (!src) return null;
  const cached = ctx.imageCache.get(src);
  if (cached !== undefined) return cached;

  let result: Uint8Array | null = null;
  try {
    // Assets arrive as data: URIs, which fetch resolves without any network.
    const response = await fetch(src);

    // A failed request still has a body. Without these checks an error page
    // gets wrapped up as image bytes, and the only sign of it is a confusing
    // failure much later when Figma refuses to decode the result.
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (looksLikeImage(bytes)) result = bytes;
    }
  } catch {
    result = null;
  }

  ctx.imageCache.set(src, result);
  return result;
}

/** Magic-number check for the formats Figma will accept. */
function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;

  const starts = (...signature: number[]) =>
    signature.every((byte, i) => bytes[i] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47)) return true; // PNG
  if (starts(0xff, 0xd8, 0xff)) return true; // JPEG
  if (starts(0x47, 0x49, 0x46, 0x38)) return true; // GIF
  // WEBP is "RIFF" .... "WEBP"
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Naming and small helpers
// ---------------------------------------------------------------------------

/**
 * Layer names decide whether the file is navigable. Prefer authored intent
 * (aria-label, data-name, class) over generic tag names, and fall back to
 * describing the layout so the panel reads as structure.
 */
function frameName(
  el: HTMLElement,
  layout: IRLayout | undefined,
  style: CSSStyleDeclaration,
  box: { width: number; height: number },
): string {
  const explicit =
    el.getAttribute("data-name") ??
    el.getAttribute("data-label") ??
    el.getAttribute("data-screen-label") ??
    el.getAttribute("aria-label") ??
    el.getAttribute("title") ??
    el.getAttribute("id");
  if (explicit && explicit.trim()) return explicit.trim();

  const semantic: Record<string, string> = {
    HEADER: "Header",
    FOOTER: "Footer",
    NAV: "Nav",
    MAIN: "Main",
    SECTION: "Section",
    ARTICLE: "Article",
    ASIDE: "Aside",
    BUTTON: "Button",
    UL: "List",
    OL: "List",
    LI: "List item",
    TABLE: "Table",
    THEAD: "Table header",
    TBODY: "Table body",
    TR: "Table row",
    FORM: "Form",
  };
  if (semantic[el.tagName]) return semantic[el.tagName];

  // Claude Design emits internal class prefixes (`om-nav`, `sc-row`) from its
  // own runtime. They carry no meaning for someone reading a layer panel, and
  // leaving them in produces layers called "Om Trig".
  const raw = (el.getAttribute("class") ?? "").split(/\s+/)[0] ?? "";
  const className = raw.replace(/^(om|dc|sc|x)-/, "");
  if (className.length > 1 && !/^[a-z]{1,2}-?\d/.test(className)) {
    return className.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // `role` is authored intent too, spelled differently from aria-label. It sits
  // below the class because a class is usually the more specific of the two,
  // and above everything else because a name the author wrote beats one this
  // file invents.
  const role = (el.getAttribute("role") ?? "").trim();
  if (role) return titleCase(role);

  // A form control nobody named still has a name every designer knows, and
  // since the control's own value becomes the child TEXT layer's name, the
  // frame saying what KIND of control it is adds to the panel rather than
  // repeating it.
  const control = controlTypeName(el);
  if (control) return control;

  // Nothing named it. Two hundred layers called "Frame" is not a navigable
  // file, so borrow the copy inside.
  //
  // Only for elements wrapping a single thing, though: a row of two buttons
  // would otherwise be named by gluing their labels together
  // ("My Searches & Alerts Set Alert"), which is worse than "Row". And long
  // text is a paragraph, not a name.
  const elementChildren = Array.from(el.children).filter(
    (child) => !SKIPPED_TAGS.has(child.tagName),
  ).length;
  if (elementChildren <= 1) {
    const text = visibleText(el);
    if (text && text.length <= 40) return truncate(text, 32);
  }

  if (layout) return layout.mode === "HORIZONTAL" ? "Row" : "Column";

  // Everything from here down would have been "Frame": no authored name, no
  // semantic tag, no usable class, no short caption, no auto-layout to
  // describe. That was 100 of the Portage export's 589 frames, 24 of them
  // holding real text, and a layer panel with a hundred identical entries in
  // it cannot be navigated. Each rule below has to earn its name from
  // something the element genuinely is.

  // The copy inside, for a box that renders as one run of text. Either it wraps
  // a single thing (the rule above, minus its length cap, since `truncate`
  // already keeps a name short and "Only needed when the document…" beats
  // "Frame") or every element child is inline, so the text reads as one phrase.
  // "none · add token files" is a sentence; the two glued buttons the rule
  // above worries about are inline-BLOCK or flex, and stay excluded.
  if (elementChildren <= 1 || allChildrenInline(el)) {
    const text = visibleText(el);
    if (text) return truncate(text, 32);
  }

  if (elementChildren === 0 && !(el.textContent ?? "").trim()) {
    // A painted hairline is a rule. 32 of the Portage Frames are
    // `<div style="flex:1 1 auto;height:1px;background:…">`, which is the
    // separator in every one of that panel's section headers.
    if (isPainted(style) && isHairline(box)) return "Divider";

    // An empty box that paints nothing is holding space open, which is the
    // other 32: a bare `<div></div>` occupying a 13px grid column so the label
    // beneath a checkbox lines up with the label beside it.
    if (!isPainted(style) && !hasVisibleBorder(style) && style.boxShadow === "none") {
      return "Spacer";
    }

    // The rest of the unnamed empty boxes are shapes, and a shape has a name
    // a designer would give it.
    const round = parseFloat(style.borderTopLeftRadius) >= Math.min(box.width, box.height) / 2 - 0.5;
    if (style.position === "absolute" && box.width > 0 && box.height > 0) {
      const parent = el.parentElement?.getBoundingClientRect();
      if (parent && box.width >= parent.width - 1 && box.height >= parent.height - 1) return "Overlay";
    }
    if (round && Math.max(box.width, box.height) <= 16) return "Dot";
    if (box.height <= 12 && box.width >= box.height * 3) return "Bar";
    if (Math.max(box.width, box.height) <= 24 && isPainted(style)) return "Swatch";
    if (!isPainted(style) && hasVisibleBorder(style)) return "Outline";
    if (style.backgroundImage.includes("url(")) return "Image";
    return round ? "Circle" : "Rectangle";
  }

  // A box of absolutely placed children: a painted one is a card, the rest a
  // group, which is Figma's own word for children with no layout.
  if (isPainted(style) || hasVisibleBorder(style) || style.boxShadow !== "none") return "Card";
  return "Group";
}

/**
 * An inline SVG's layer name. "Vector" 27 times over is what a dashboard
 * imported with; a designer names these by what they are.
 */
function vectorName(el: Element, box: { width: number; height: number }): string {
  const named =
    el.getAttribute("data-name") || el.getAttribute("aria-label") || el.querySelector("title")?.textContent?.trim();
  if (named) return named;
  const labelled = el.closest("button, a, [role=button]");
  const label = labelled ? (labelled as HTMLElement).innerText?.trim() : "";
  if (Math.max(box.width, box.height) <= 32) return label && label.length <= 24 ? `${label} icon` : "Icon";
  if (el.querySelector("text, line, polyline, polygon")) return "Chart";
  return "Illustration";
}

/** The kind of control this is, for an <input>/<select>/<textarea>. */
function controlTypeName(el: HTMLElement): string | undefined {
  if (el.tagName === "SELECT") return "Select";
  if (el.tagName === "TEXTAREA") return "Text area";
  if (el.tagName !== "INPUT") return undefined;

  const byType: Record<string, string> = {
    checkbox: "Checkbox",
    radio: "Radio",
    range: "Slider",
    color: "Colour picker",
    file: "File field",
    submit: "Button",
    reset: "Button",
    button: "Button",
  };
  return byType[(el as HTMLInputElement).type] ?? "Field";
}

/**
 * The text this element actually shows, whitespace collapsed.
 *
 * Not `textContent`, which happily hands back the contents of a `display:none`
 * subtree. The Portage panel keeps its "forget" link in a
 * `<span style="display:{{ forgetDisplay }}">` that is usually none, so a name
 * borrowed from textContent reads "none · add token files · forget" for a row
 * that says "none · add token files". A layer name has to describe what is on
 * the canvas.
 */
function visibleText(el: HTMLElement): string {
  // No elements inside means nothing can be hidden, and this is the common
  // case: no computed style needed.
  if (el.children.length === 0) {
    return (el.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  let out = "";
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as HTMLElement;
    if (SKIPPED_TAGS.has(child.tagName)) return;
    const display = getComputedStyle(child);
    if (display.display === "none" || display.visibility === "hidden") return;
    for (const grandchild of Array.from(child.childNodes)) visit(grandchild);
  };
  for (const node of Array.from(el.childNodes)) visit(node);
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Does this element render as a single run of text?
 *
 * Strictly `display: inline`, the same test `isTextContainer` uses, because
 * that is the difference between pieces of one sentence and separate
 * components sitting next to each other. `display: none` children are ignored:
 * they paint nothing, so they cannot make the visible text read as anything
 * other than one phrase.
 */
function allChildrenInline(el: HTMLElement): boolean {
  let sawInline = false;
  for (const child of Array.from(el.children)) {
    if (SKIPPED_TAGS.has(child.tagName)) continue;
    const display = getComputedStyle(child as HTMLElement).display;
    if (display === "none") continue;
    if (display !== "inline") return false;
    sawInline = true;
  }
  return sawInline;
}

function isPainted(style: CSSStyleDeclaration): boolean {
  const color = parseColor(style.backgroundColor);
  if (color && color.a > 0) return true;
  if (!style.backgroundImage || style.backgroundImage === "none") return false;
  return !zeroSized(style.backgroundSize);
}

/** `0px 1px`, `0% 100%`: a background layer that paints nothing. First layer only. */
function zeroSized(size: string): boolean {
  const first = splitTopLevel(size || "auto")[0]?.trim() ?? "auto";
  return first.split(/\s+/).some((part) => /^0(?:px|%)?$/.test(part));
}

/**
 * How much of the box the first background layer actually paints.
 *
 * `auto`, `cover`, `contain` and anything at least the box's size count as the
 * whole box, as does a layer that repeats on both axes. A zero on either axis
 * paints nothing. Everything else is a strip or a patch, which a Figma fill
 * cannot express.
 */
function backgroundCoverage(
  el: HTMLElement,
  style: CSSStyleDeclaration,
): "full" | "partial" | "none" {
  if (zeroSized(style.backgroundSize)) return "none";
  const first = splitTopLevel(style.backgroundSize || "auto")[0]?.trim() ?? "auto";
  if (/^(auto|cover|contain)$/.test(first) || first === "auto auto") return "full";

  const repeat = (splitTopLevel(style.backgroundRepeat || "repeat")[0] ?? "repeat").trim();
  if (repeat === "repeat" || repeat === "repeat repeat" || repeat === "round" || repeat === "space") {
    return "full";
  }

  const rect = el.getBoundingClientRect();
  const [w, h = "auto"] = first.split(/\s+/);
  const resolve = (part: string, box: number): number =>
    part === "auto" ? box : part.endsWith("%") ? (parseFloat(part) / 100) * box : parseFloat(part);
  const width = resolve(w, rect.width);
  const height = resolve(h, rect.height);
  if (!(width > 0) || !(height > 0)) return "none";
  return width >= rect.width - 0.5 && height >= rect.height - 0.5 ? "full" : "partial";
}

function hasVisibleBorder(style: CSSStyleDeclaration): boolean {
  return (
    px(style.borderTopWidth) > 0 ||
    px(style.borderRightWidth) > 0 ||
    px(style.borderBottomWidth) > 0 ||
    px(style.borderLeftWidth) > 0
  );
}

/** One axis collapsed to a line, the other long enough to be drawn along. */
function isHairline(box: { width: number; height: number }): boolean {
  return Math.min(box.width, box.height) <= 1 && Math.max(box.width, box.height) >= 4;
}

function titleCase(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}


function inlineDeclaration(el: HTMLElement, property: string): string | undefined {
  const inline = el.getAttribute("style");
  if (!inline) return undefined;
  for (const decl of inline.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    if (decl.slice(0, idx).trim() === property) return decl.slice(idx + 1).trim();
  }
  return undefined;
}

/**
 * Read a computed length, collapsing sub-pixel layout noise.
 *
 * The browser resolves lengths against the device pixel grid, so a declared
 * 12px gap can measure 11.99 and a 3px border 2.73 depending on zoom and
 * devicePixelRatio. Carried through verbatim that noise becomes 11.99 gaps and
 * 2.73 strokes in a designer's file, which reads as sloppiness. Values genuinely
 * meant to be fractional (12.5px, a 1.2px letter-spacing) sit far enough from an
 * integer to survive the snap.
 */
function px(value: string): number {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return 0;
  const nearest = Math.round(n);
  return Math.abs(n - nearest) < 0.15 ? nearest : round(n);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** An IRColor as a CSS string, for embedding in a synthesised SVG. */
function cssColor(c: IRColor): string {
  const ch = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  const [r, g, b] = [ch(c.r), ch(c.g), ch(c.b)];
  return c.a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${round(c.a)})`;
}

function clampOpacity(value: string): number {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

function truncate(value: string, max: number): string {
  // Layer names are read, not rendered: no invisible presentation selectors.
  const clean = value.replace(/[\uFE0E\uFE0F]/g, "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function fileName(src: string): string {
  try {
    return decodeURIComponent(src.split("/").pop() ?? "").split(".")[0];
  } catch {
    return "";
  }
}
