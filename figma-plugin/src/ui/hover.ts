/**
 * Hover states: what an element looks like with the pointer on it.
 *
 * A Claude Design page changes on hover in two ways: its CSS (`a:hover`,
 * `.card:hover .title`, `a:hover [data-arrow]`) and Claude Design's own
 * `style-hover` attribute, which its runtime applies while the pointer is over
 * the element. Neither can be triggered from script, so the hover state is
 * reproduced instead: every `:hover` rule is copied with `:hover` replaced by
 * an attribute Ferry can set, and `style-hover` declarations are applied
 * inline. The element is then measured a second time, and that measurement
 * becomes the component's Hover variant (html.to.design builds the same
 * default/hover pair).
 *
 * Transitions are off while the hover state is measured, or the second
 * measurement catches the first frame of the fade.
 */

const HOVER_ATTR = "data-cd2f-hover";
const HOVERING_ATTR = "data-cd2f-hovering";
/** Hover candidates checked per document. Past this, a page is all links. */
const MAX_CANDIDATES = 120;
/** Descendants compared per candidate. */
const MAX_DESCENDANTS = 60;

const WATCHED = [
  "color", "background-color", "background-image", "border-top-color", "border-right-color",
  "border-bottom-color", "border-left-color", "opacity", "transform", "translate", "scale", "rotate",
  "box-shadow", "text-decoration-line", "text-decoration-color", "filter", "outline-color", "outline-style",
];

export type HoverPass = {
  /** Elements whose hover state looks different from their resting state. */
  targets: Set<Element>;
  /** The copied rules; removed on dispose. */
  sheet: HTMLStyleElement;
  enter(el: Element): void;
  leave(el: Element): void;
  dispose(): void;
};

/** The part of each `:hover` selector naming the hovered element: `.nav a` in `.nav a:hover span`. */
function hoverSubjects(selectorText: string): string[] {
  const out: string[] = [];
  for (const part of splitSelectorList(selectorText)) {
    const at = part.indexOf(":hover");
    if (at < 0) continue;
    const subject = part.slice(0, at).trim();
    if (!subject || /[>+~]$/.test(subject)) continue;
    out.push(subject.replace(/:hover\b/g, ""));
  }
  return out;
}

/** Top-level commas only: `:is(a, b):hover` is one selector. */
function splitSelectorList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function collectHoverRules(rules: CSSRuleList, css: string[], subjects: Set<string>): void {
  for (const rule of Array.from(rules)) {
    const style = rule as CSSStyleRule;
    if (style.selectorText && style.selectorText.includes(":hover")) {
      const selector = style.selectorText.replace(/:hover\b/g, `[${HOVER_ATTR}]`);
      css.push(`${selector} { ${style.style.cssText} }`);
      for (const s of hoverSubjects(style.selectorText)) subjects.add(s);
      continue;
    }
    const group = rule as CSSMediaRule;
    if (group.cssRules && group.cssRules.length > 0) {
      const inner: string[] = [];
      collectHoverRules(group.cssRules, inner, subjects);
      if (inner.length === 0) continue;
      const media = group.media?.mediaText;
      css.push(media ? `@media ${media} { ${inner.join("\n")} }` : inner.join("\n"));
    }
  }
}

function snapshot(el: Element): string {
  const nodes = [el, ...Array.from(el.querySelectorAll("*")).slice(0, MAX_DESCENDANTS)];
  return nodes
    .map((n) => {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return WATCHED.map((p) => cs.getPropertyValue(p)).join("|") + `@${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    })
    .join("\n");
}

/**
 * Find the elements under `root` that look different when hovered, and the
 * means to put one in its hover state. `sheets` are the document's own.
 */
export function prepareHover(root: HTMLElement, sheets: CSSStyleSheet[]): HoverPass {
  const css: string[] = [];
  const subjects = new Set<string>();
  for (const sheet of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // A cross-origin sheet: no hover rules Ferry can read.
    }
    collectHoverRules(rules, css, subjects);
  }

  const doc = root.ownerDocument;
  const style = doc.createElement("style");
  style.setAttribute("data-cd2f-hover-sheet", "");
  style.textContent = `[${HOVERING_ATTR}] *, [${HOVERING_ATTR}] { transition: none !important; }\n${css.join("\n")}`;
  doc.head.appendChild(style);

  const saved = new Map<Element, string | null>();
  const enter = (el: Element) => {
    root.setAttribute(HOVERING_ATTR, "");
    el.setAttribute(HOVER_ATTR, "");
    const extra = el.getAttribute("style-hover");
    if (extra) {
      saved.set(el, el.getAttribute("style"));
      el.setAttribute("style", `${el.getAttribute("style") ?? ""};${extra}`);
    }
  };
  const leave = (el: Element) => {
    el.removeAttribute(HOVER_ATTR);
    if (saved.has(el)) {
      const before = saved.get(el);
      if (before === null || before === undefined) el.removeAttribute("style");
      else el.setAttribute("style", before);
      saved.delete(el);
    }
    // Settle the resting styles while transitions are still off; re-enabled
    // in the same style pass, a transition back from hover would start and
    // the next measurement would catch it mid-fade.
    void getComputedStyle(el).opacity;
    root.removeAttribute(HOVERING_ATTR);
  };

  const candidates = new Set<Element>();
  for (const subject of subjects) {
    try {
      for (const el of Array.from(root.querySelectorAll(subject))) candidates.add(el);
    } catch {
      // A selector this engine will not take on its own; its rule still applies.
    }
  }
  for (const el of Array.from(root.querySelectorAll("[style-hover]"))) candidates.add(el);

  const targets = new Set<Element>();
  for (const el of Array.from(candidates).slice(0, MAX_CANDIDATES)) {
    root.setAttribute(HOVERING_ATTR, "");
    const before = snapshot(el);
    enter(el);
    const after = snapshot(el);
    leave(el);
    if (before !== after) targets.add(el);
  }

  return {
    targets,
    sheet: style,
    enter,
    leave,
    dispose: () => style.remove(),
  };
}
