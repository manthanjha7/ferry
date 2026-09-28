/**
 * Components: the same thing drawn more than once, made one thing.
 *
 * A design repeats itself: three stat cards, a row of grade badges, the same
 * nav in every artboard of a board. Imported as copies, a designer who changes
 * one has to find and change the rest; html.to.design turns them into a main
 * component and instances, and that is what a designer would have built.
 *
 * Two layers are the same component when everything about them is the same
 * except their words and their images: kind, size, layout, paints, borders,
 * corners, effects, text styles, vector artwork, and the same for every layer
 * inside, at the same positions. Only what an instance can override is allowed
 * to differ. That is stricter than it needs to be for text that hugs its
 * words (two pills with different labels differ in width, and so are not
 * grouped), and it is what makes every instance come out exactly where the
 * copy it replaces was.
 *
 * The approach follows claude-to-figma's `detect/hash.ts` (MIT): a structural
 * hash of each subtree, groups of equal hashes, the largest subtrees first so
 * a card is one component rather than a card of components.
 */
import type { IRNode } from "../ir";

const r1 = (n: number) => Math.round(n);

/** Kept in step with `hugsItsWords` (src/ui/extract.ts), which sizes such text HUG. */
function hugs(node: IRNode): boolean {
  const t = node.text;
  return node.kind === "TEXT" && !!t && t.singleLine && !t.fixedWidth && !t.maxLines && !t.glyphFill && !/\s$/.test(t.characters);
}

/** Everything about a layer an instance cannot override. */
function ownSignature(node: IRNode, root: boolean): string {
  const parts: unknown[] = [node.kind, node.opacity, node.rotation, node.clips, node.absolute ?? false, node.blendMode ?? "", node.themeScope ?? ""];
  // A text layer that hugs its words may differ in width: its instance sizes
  // itself to its own words. Any other layer's size is part of its shape.
  if (!hugs(node)) parts.push(`${r1(node.width)}x${r1(node.height)}`);
  else parts.push(`h${r1(node.height)}`);
  if (!root) parts.push(`@${r1(node.x)},${r1(node.y)}`);
  if (node.sizing) parts.push(`${node.sizing.horizontal}/${node.sizing.vertical}/${node.grow ?? false}`);
  if (node.layout) {
    const l = node.layout;
    parts.push([l.mode, l.gap, l.crossGap, l.wrap, l.padding, l.primaryAlign, l.crossAlign, l.hugContent ?? false]);
  }
  parts.push(node.kind === "IMAGE" ? ["image", node.imageScale ?? ""] : node.fills);
  parts.push(node.border ?? null, node.cornerRadius, node.effects);
  if (node.kind === "VECTOR") parts.push(node.svg ?? "");
  if (node.text) {
    const t = node.text;
    const style = (run: (typeof t.runs)[number]) => [run.fontFamily, run.fontWeight, run.italic, run.fontSize, run.lineHeight, run.letterSpacing, run.fill, run.decoration, run.textCase, run.underline ?? null];
    parts.push([t.align, t.verticalAlign, t.singleLine, t.fixedWidth ?? false, t.maxLines ?? 0, t.glyphFill ?? null]);
    // One style: the words can be overridden. Several: an override would
    // lose which words carry which style, so the words are part of the shape.
    parts.push(t.runs.length === 1 ? style(t.runs[0]) : [t.characters, t.runs.map((run) => [run.start, run.end, ...style(run)])]);
  }
  return JSON.stringify(parts);
}

function sizeOf(node: IRNode): number {
  return 1 + node.children.reduce((n, c) => n + sizeOf(c), 0);
}

function firstText(node: IRNode): string {
  if (node.kind === "TEXT") return node.text?.characters.trim() ?? "";
  for (const child of node.children) {
    const t = firstText(child);
    if (t) return t;
  }
  return "";
}

const GENERIC = /^(Frame|Group|Row|Column|Stack|Box|Container|Wrapper|Section|Item)( \d+)?$/i;

/**
 * Mark the repeated subtrees under `root` as a main component and instances.
 * Returns how many components were made.
 */
export function markComponents(root: IRNode): number {
  const signatures = new Map<IRNode, string>();
  const parents = new Map<IRNode, IRNode>();
  const order: IRNode[] = [];
  const sign = (node: IRNode, isRoot: boolean): string => {
    const own = ownSignature(node, isRoot);
    const kids = node.children.map((c) => {
      parents.set(c, node);
      return sign(c, false);
    });
    const full = `${own}[${kids.join(",")}]`;
    if (isRoot) signatures.set(node, full);
    return full;
  };
  // Every frame is signed as the root of its own subtree (positions relative
  // to it), so the same card anywhere in the page hashes the same.
  const visit = (node: IRNode) => {
    order.push(node);
    for (const child of node.children) {
      parents.set(child, node);
      visit(child);
    }
  };
  visit(root);
  for (const node of order) if (node !== root && node.kind === "FRAME") sign(node, true);

  const groups = new Map<string, IRNode[]>();
  for (const node of order) {
    const sig = signatures.get(node);
    if (!sig) continue;
    const list = groups.get(sig) ?? [];
    list.push(node);
    groups.set(sig, list);
  }

  const worth = (node: IRNode) =>
    node.children.length > 0 &&
    node.name !== "Spacer" &&
    (node.fills.length > 0 || !!node.border || node.effects.length > 0 || sizeOf(node) >= 3);

  const taken = new Set<IRNode>();
  const insideTaken = (node: IRNode) => {
    for (let p = parents.get(node); p; p = parents.get(p)) if (taken.has(p)) return true;
    return false;
  };
  const candidates = Array.from(groups.values())
    .filter((list) => list.length >= 2 && worth(list[0]))
    .sort((a, b) => sizeOf(b[0]) - sizeOf(a[0]) || b.length - a.length);

  const names = new Map<string, number>();
  let made = 0;
  for (const list of candidates) {
    const members = list.filter((n) => !taken.has(n) && !insideTaken(n));
    if (members.length < 2) continue;
    const head = members[0];
    let name = head.name && !GENERIC.test(head.name) ? head.name : firstText(head) || "Component";
    name = name.length > 32 ? `${name.slice(0, 31)}…` : name;
    const seen = names.get(name) ?? 0;
    names.set(name, seen + 1);
    if (seen > 0) name = `${name} ${seen + 1}`;
    const key = `c${made}`;
    members.forEach((n, i) => {
      n.component = { key, name, main: i === 0 };
      taken.add(n);
    });
    made++;
  }
  return made;
}
