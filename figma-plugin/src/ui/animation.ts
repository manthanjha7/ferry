/**
 * Claude Design animation projects: rendered for real, measured scene by scene.
 *
 * An animation project is a small `.dc.html` that declares its scenes in an
 * inline script (`window.OM_SCENES = '[{"name":"Title","dur":1.9,...}]'`) and
 * mounts ONE React component from sibling `.jsx` files through
 * `<x-import component-from-global-scope="LibraryPiece" from="./a.jsx ./b.jsx">`.
 * Claude Design's engine renders the whole animation as a pure function of one
 * time value, inside `<svg data-om-exportable-video-with-duration-secs>`, and
 * seeks when that svg receives a `data-om-seek-to-time-frame` event.
 *
 * Claude Design's own runtime downloads React and Babel from a CDN, which a
 * plugin with no network access cannot do, so these imported as an empty box.
 * Ferry ships React 18.3.1 (the version that runtime pins) and compiles the
 * JSX with Sucrase, renders the component, and then drives the engine's own
 * seek event: one frame per scene, taken at the moment in the scene where the
 * most content is fully on screen.
 */

import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import { flushSync } from "react-dom";
import { transform } from "sucrase";

import { real } from "./clock";

export type Scene = { name: string; dur: number; desc?: string; start: number };

export type AnimationSpec = {
  scenes: Scene[];
  loop: boolean;
  component: string;
  modules: string[];
  inlineScripts: string[];
  scriptSources: string[];
};

export type LiveAnimation = {
  /** The composition surface: the element every scene is measured from. */
  surface: HTMLElement;
  scenes: Scene[];
  loop: boolean;
  seek: (seconds: number) => void;
  unmount: () => void;
};

/** The animation this document declares, or null when it is not one. */
export function readAnimationSpec(html: string): AnimationSpec | null {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const inlineScripts: string[] = [];
  const scriptSources: string[] = [];
  for (const script of Array.from(parsed.querySelectorAll("script"))) {
    const type = (script.getAttribute("type") || "").toLowerCase();
    if (type && type !== "text/javascript" && type !== "module") continue;
    const src = script.getAttribute("src");
    if (src) {
      if (!/(^|\/)support\.js$|image-slot\.js$/i.test(src)) scriptSources.push(src);
    } else if (script.textContent?.trim()) {
      inlineScripts.push(script.textContent);
    }
  }

  const scenesRaw = inlineScripts
    .map((code) => /OM_SCENES\s*=\s*(['"`])([\s\S]*?)\1/.exec(code)?.[2])
    .find(Boolean);
  if (!scenesRaw) return null;

  const xImport = Array.from(parsed.querySelectorAll("x-import[component-from-global-scope]")).find(
    (el) => /\.(jsx|tsx|js)\b/.test(el.getAttribute("from") || ""),
  );
  if (!xImport) return null;

  let list: Array<{ name: string; dur: number; desc?: string }>;
  try {
    list = JSON.parse(scenesRaw.replace(/\\'/g, "'"));
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length === 0) return null;

  let start = 0;
  const scenes: Scene[] = list.map((scene) => {
    const dur = Math.max(0.1, Number(scene.dur) || 1);
    const out = { name: String(scene.name ?? "Scene"), dur, desc: scene.desc, start };
    start += dur;
    return out;
  });

  const playback = inlineScripts
    .map((code) => /OM_PLAYBACK\s*=\s*(['"`])([\s\S]*?)\1/.exec(code)?.[2])
    .find(Boolean);
  let loop = true;
  try {
    if (playback) loop = JSON.parse(playback).mode !== "times";
  } catch {
    // Unreadable playback setting: Claude Design's default is loop.
  }

  return {
    scenes,
    loop,
    component: xImport.getAttribute("component-from-global-scope")!,
    modules: (xImport.getAttribute("from") || "").split(/\s+/).filter(Boolean),
    inlineScripts,
    scriptSources,
  };
}

function lookup(sources: Record<string, string> | undefined, path: string): string | undefined {
  if (!sources) return undefined;
  const clean = path.replace(/^\.\//, "");
  return sources[path] ?? sources[clean] ?? sources[`./${clean}`] ?? sources[clean.split("/").pop() ?? clean];
}

/** Scripts that need window-level globals run as real scripts; a CSP that refuses falls back to eval. */
function runGlobal(code: string): void {
  try {
    const script = document.createElement("script");
    script.textContent = code;
    document.head.appendChild(script);
    script.remove();
  } catch {
    (0, eval)(code);
  }
}

/**
 * Render the animation into the mounted page and hand back its controls.
 *
 * Throws with a plain message when a module the component needs was not in
 * the drop, since without it there is nothing to render.
 */
export async function bootAnimation(
  container: HTMLElement,
  spec: AnimationSpec,
  sources: Record<string, string> | undefined,
): Promise<LiveAnimation> {
  const win = window as unknown as Record<string, unknown>;
  win.React = React;
  win.ReactDOM = { ...ReactDOM, ...ReactDOMClient };

  for (const code of spec.inlineScripts) {
    try {
      runGlobal(code);
    } catch {
      // A settings script that throws leaves its defaults unset, nothing more.
    }
  }
  for (const src of spec.scriptSources) {
    const code = lookup(sources, src);
    if (code) {
      try {
        runGlobal(code);
      } catch {
        // A design-system bundle that fails leaves its components missing.
      }
    }
  }

  const missing: string[] = [];
  for (const path of spec.modules) {
    const source = lookup(sources, path);
    if (source === undefined) {
      missing.push(path.replace(/^\.\//, ""));
      continue;
    }
    const code = /\.(jsx|tsx)$/i.test(path)
      ? transform(source, {
          transforms: /\.tsx$/i.test(path) ? ["jsx", "typescript"] : ["jsx", "typescript"],
          jsxRuntime: "classic",
          production: true,
          filePath: path,
        }).code
      : source;
    const module = { exports: {} as Record<string, unknown> };
    // The same contract as Claude Design's runtime: React in scope, CommonJS
    // shape, and whatever the file assigns onto window is its export.
    new Function("React", "module", "exports", "require", code)(React, module, module.exports, () => ({}));
    Object.assign(win, module.exports);
  }
  if (missing.length > 0) {
    throw new Error(
      `This animation needs ${missing.join(", ")}, which ${missing.length === 1 ? "was" : "were"} not in the drop. Import the whole project .zip.`,
    );
  }

  const Component = win[spec.component] as React.ComponentType | undefined;
  const host = container.querySelector(`x-import[component-from-global-scope="${spec.component}"]`) as HTMLElement | null;
  if (!Component || !host) {
    throw new Error(`The animation's component "${spec.component}" did not load.`);
  }
  host.style.display = "block";

  const root = ReactDOMClient.createRoot(host);
  flushSync(() => root.render(React.createElement(Component)));

  // The seek listener is attached in an effect, after the first commit.
  let svg: SVGSVGElement | null = null;
  for (let i = 0; i < 100; i++) {
    svg = host.querySelector("svg[data-om-exportable-video-with-duration-secs]");
    if (svg && svg.hasAttribute("data-om-sync-seek")) break;
    await new Promise((resolve) => real.setTimeout(resolve, 20));
  }
  const surface = svg?.querySelector("foreignObject > div") as HTMLElement | null;
  if (!svg || !surface) {
    root.unmount();
    throw new Error("The animation rendered, but its stage did not appear.");
  }

  const unscale = () => svg!.style.setProperty("transform", "none", "important");
  unscale();

  return {
    surface,
    scenes: spec.scenes,
    loop: spec.loop,
    seek: (seconds: number) => {
      const event = new CustomEvent("data-om-seek-to-time-frame", {
        detail: { time: seconds, sync: true, playing: false },
      });
      flushSync(() => {
        svg!.dispatchEvent(event);
      });
      unscale();
    },
    unmount: () => {
      try {
        root.unmount();
      } catch {
        // Already gone with the stage.
      }
    },
  };
}

/**
 * How much of the composition is fully on screen right now: the characters of
 * text whose every ancestor up to the surface is opaque and unshrunk. A scene
 * that builds in and then fades out peaks in the middle, which is the frame a
 * designer means by "the Title scene".
 */
export function visibleContent(surface: HTMLElement): number {
  const bounds = surface.getBoundingClientRect();
  let score = 0;
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    if (!text) continue;
    let el: Element | null = node.parentElement;
    let opacity = 1;
    let hidden = false;
    while (el && el !== surface.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") {
        hidden = true;
        break;
      }
      opacity *= parseFloat(cs.opacity) || 0;
      el = el.parentElement;
    }
    if (hidden || opacity < 0.95) continue;
    const rect = (node.parentElement as Element).getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    if (rect.right < bounds.left || rect.left > bounds.right || rect.bottom < bounds.top || rect.top > bounds.bottom) continue;
    score += text.length;
  }
  return score;
}

/** The moment inside a scene to capture: most content visible, the later of ties. */
export function settledMoment(live: LiveAnimation, scene: Scene, samples = 12): number {
  const from = scene.start + scene.dur * 0.15;
  const to = scene.start + scene.dur - Math.min(0.05, scene.dur * 0.02);
  let best = to;
  let bestScore = -1;
  for (let i = 0; i < samples; i++) {
    const t = from + ((to - from) * i) / (samples - 1);
    live.seek(t);
    const score = visibleContent(live.surface);
    if (score >= bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}
