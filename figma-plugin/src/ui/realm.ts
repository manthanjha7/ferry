/**
 * Where a document is measured: a frame of its own, in standards mode.
 *
 * Figma writes its own `<script>` in front of a plugin's HTML, so the panel's
 * `<!DOCTYPE html>` is no longer the first thing parsed and the panel runs in
 * quirks mode. Measured there, a design renders the way no browser shows it:
 * quirks mode drops the line-height strut from lines that hold only inline
 * elements, so every row of a lead list came in 2px short and a 3,272px board
 * lost 4px by the bottom, and it also changes image gaps, table fonts and
 * percentage heights. Chrome, and Claude Design, render the page in standards
 * mode.
 *
 * A blank frame the panel writes into itself is same-origin with it, and
 * writing a doctype first puts it in standards mode. The extractor's own code
 * is loaded INTO that frame, so `document`, `getComputedStyle` and the timers
 * it patches are the frame's, and the design's CSS and scripts never touch the
 * panel. The frame is also as wide as the design, so `vw`, media queries and
 * `innerWidth` answer for the design, natively.
 */
import type { ExtractorApi } from "./extractor-entry";

declare const __EXTRACTOR_SOURCE__: string;

/** The design viewport is 16:10, the same ratio the extractor assumes. */
const heightFor = (width: number) => Math.round(width * 0.625);

let frame: HTMLIFrameElement | null = null;
let api: ExtractorApi | null = null;

function source(): string | null {
  if (typeof __EXTRACTOR_SOURCE__ === "string") return __EXTRACTOR_SOURCE__;
  // The harness hands the test bundle in here to drive the frame path.
  const injected = (window as unknown as { __FERRY_EXTRACTOR_SOURCE__?: string }).__FERRY_EXTRACTOR_SOURCE__;
  return typeof injected === "string" ? injected : null;
}

/**
 * The extractor, running in a standards-mode frame sized to `width`. Where
 * the source was not embedded (the test harness, which bundles the panel with
 * the extractor alongside), the same-realm copy the harness registered.
 */
export function extractor(width = 1440): ExtractorApi {
  const text = source();
  const host = window as unknown as { __ferryExtractor?: ExtractorApi };
  if (!text) {
    if (!host.__ferryExtractor) throw new Error("The extractor is not loaded.");
    return host.__ferryExtractor;
  }
  if (!frame || !api || !frame.isConnected) {
    frame?.remove();
    frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    // On screen, behind the panel, and invisible: a frame parked off screen
    // can have its frames and timers throttled.
    frame.style.cssText =
      "position:fixed;left:0;top:0;border:0;opacity:0;pointer-events:none;z-index:-2147483647";
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    if (!doc) throw new Error("Could not open a frame to measure the design in.");
    doc.open();
    doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>');
    doc.close();
    // Figma gives the panel its own Inter (@font-face rules from
    // static.figma.com). A design that names Inter without shipping it was
    // measured in that face; the frame gets the same faces, or it measures in
    // a fallback and every Inter line comes in 2px short.
    const faces = doc.createElement("style");
    faces.textContent = hostFontFaces();
    doc.head.appendChild(faces);
    const script = doc.createElement("script");
    script.textContent = text;
    doc.head.appendChild(script);
    api = (frame.contentWindow as unknown as { __ferryExtractor?: ExtractorApi }).__ferryExtractor ?? null;
    if (!api) throw new Error("The extractor did not start.");
    const debug = (window as unknown as { __CD2F_DEBUG?: boolean }).__CD2F_DEBUG;
    if (debug) (frame.contentWindow as unknown as { __CD2F_DEBUG?: boolean }).__CD2F_DEBUG = true;
  }
  frame.style.width = `${width}px`;
  frame.style.height = `${heightFor(width)}px`;
  return api;
}

/** The @font-face rules the host put in the panel, less Ferry's own. */
function hostFontFaces(): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(list)) {
      if (rule.type === CSSRule.FONT_FACE_RULE && !/font-family:\s*"?cd2f-/.test(rule.cssText)) rules.push(rule.cssText);
    }
  }
  return rules.join("\n");
}

/**
 * A fresh frame for the next import, so nothing one design's script left on
 * its window (a global, a listener, a theme attribute) reaches the next.
 */
export function resetExtractor(): void {
  frame?.remove();
  frame = null;
  api = null;
}

/**
 * The frame's result as the panel's own objects. What comes back was built in
 * the frame's realm; a copy keeps it usable after the frame is replaced.
 */
export function adopt<T>(value: T): T {
  return source() && typeof structuredClone === "function" ? structuredClone(value) : value;
}

if (typeof __SELFTEST__ !== "undefined" && __SELFTEST__) {
  // The real-Figma bench reaches the measuring frame through this.
  (window as unknown as Record<string, unknown>).__ferryRealm = { extractor, resetExtractor };
}
