/**
 * React prototypes: pages that are an empty `<div id="root">` until React
 * renders into them.
 *
 * Claude Design writes many of its designs this way: React and ReactDOM from
 * unpkg, Babel standalone to compile `<script type="text/babel" src="app.jsx">`
 * in the browser, and often Tailwind's CDN build for utility classes. Ferry
 * measures the page without running its scripts, so such a design imported as
 * a blank frame.
 *
 * Here the page runs the way a browser runs it, in Ferry's measuring frame:
 * its plain inline scripts first, in order, then each Babel script, in order,
 * compiled by Ferry's own JSX compiler (Sucrase) instead of Babel. React is
 * Ferry's bundled copy, installed as the same `React`/`ReactDOM` globals the
 * CDN builds define. Tailwind's CDN build is the one script loaded from the
 * network (the manifest allows it). Any other script from the internet is
 * reported, since it cannot run.
 */
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import { transform } from "sucrase";
import { real } from "./clock";

const TAILWIND = /^https:\/\/cdn\.tailwindcss\.com(\/|\?|$)/;
/** CDN builds Ferry supplies itself. */
const PROVIDED = /\/(react|react-dom)@[^/]+\/umd\/|\/@babel\/standalone|\/babel(\.min)?\.js/;

export type PrototypeScript = { kind: "classic" | "babel"; src?: string; code?: string; typescript: boolean };

export type PrototypeSpec = {
  scripts: PrototypeScript[];
  tailwind: boolean;
  /** Scripts from the internet Ferry cannot run. */
  remote: string[];
};

/** A page that renders through Babel scripts, or null. */
export function readPrototypeSpec(html: string): PrototypeSpec | null {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const all = Array.from(parsed.querySelectorAll("script")).filter((s) => !s.hasAttribute("data-omelette-injected"));
  const isBabel = (s: HTMLScriptElement) => /^text\/(babel|jsx)$/i.test(s.getAttribute("type") || "");
  if (!all.some(isBabel)) return null;
  const classic: PrototypeScript[] = [];
  const babel: PrototypeScript[] = [];
  const remote: string[] = [];
  let tailwind = false;
  for (const script of all) {
    const type = (script.getAttribute("type") || "").toLowerCase();
    const src = script.getAttribute("src") || undefined;
    if (src && /^(https?:)?\/\//i.test(src)) {
      if (TAILWIND.test(src)) tailwind = true;
      else if (!PROVIDED.test(src)) remote.push(src);
      continue;
    }
    const typescript = /typescript|tsx/i.test(script.getAttribute("data-presets") || "") || /\.tsx?$/i.test(src || "");
    if (isBabel(script)) babel.push({ kind: "babel", src, code: src ? undefined : script.textContent || "", typescript });
    else if (!type || type === "text/javascript" || type === "application/javascript") {
      classic.push({ kind: "classic", src, code: src ? undefined : script.textContent || "", typescript: false });
    }
  }
  // Babel standalone compiles its scripts after the document has loaded, so
  // every plain script runs first.
  return { scripts: [...classic, ...babel], tailwind, remote };
}

/**
 * The text of a `data:` URL. The panel inlines a drop's files into the page
 * before it is measured, so `src="app.jsx"` arrives as a data URL.
 */
function dataUrlText(src: string): string | undefined {
  const m = /^data:[^,]*?(;base64)?,([\s\S]*)$/.exec(src);
  if (!m) return undefined;
  try {
    if (!m[1]) return decodeURIComponent(m[2]);
    const binary = atob(m[2]);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function lookup(sources: Record<string, string> | undefined, path: string): string | undefined {
  if (!sources) return undefined;
  const clean = path.replace(/^\.\//, "");
  return sources[path] ?? sources[clean] ?? sources[`./${clean}`] ?? sources[clean.split("/").pop() ?? clean];
}

/** A classic script, at the frame's top level, as a `<script>` would run it. */
function runGlobal(code: string): void {
  const script = document.createElement("script");
  script.textContent = code;
  document.head.appendChild(script);
  script.remove();
}

function loadScript(src: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
    void real.after(ms).then(() => resolve(false));
  });
}

/** Until the page stops changing for `quiet` ms, or `limit` ms pass. */
async function settled(root: Node, quiet: number, limit: number): Promise<void> {
  let last = real.perf();
  const observer = new MutationObserver(() => {
    last = real.perf();
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  const start = real.perf();
  while (real.perf() - start < limit && real.perf() - last < quiet) await real.after(50);
  observer.disconnect();
}

/**
 * Run a prototype's scripts in the mounted page. Returns what could not run,
 * in plain words, for the import's warnings.
 */
export async function bootPrototype(
  container: HTMLElement,
  spec: PrototypeSpec,
  sources: Record<string, string> | undefined,
): Promise<{ notes: string[]; added: Element[] }> {
  const notes: string[] = [];
  const before = new Set(Array.from(document.head.children));
  const win = window as unknown as Record<string, unknown>;
  win.React = React;
  win.ReactDOM = { ...ReactDOM, ...ReactDOMClient };

  if (spec.tailwind) {
    const loaded = await loadScript("https://cdn.tailwindcss.com", 8000);
    if (!loaded) notes.push("Tailwind could not be loaded, so its utility classes are unstyled.");
  }
  if (spec.remote.length) {
    notes.push(`This design loads ${spec.remote.length === 1 ? "a script" : `${spec.remote.length} scripts`} from the internet that Ferry cannot run (${spec.remote.slice(0, 3).map((s) => s.split("/").slice(2, 4).join("/")).join(", ")}); what they draw is missing.`);
  }

  for (const script of spec.scripts) {
    const code = script.code ?? (script.src ? (dataUrlText(script.src) ?? lookup(sources, script.src)) : undefined);
    if (code === undefined) {
      notes.push(`${script.src} was not in the drop, so what it draws is missing. Import the whole project .zip.`);
      continue;
    }
    // A runtime error inside an inserted <script> goes to window.onerror, not
    // to a try around the insertion.
    let thrown: string | null = null;
    const onError = (event: ErrorEvent) => {
      thrown = event.message;
    };
    window.addEventListener("error", onError);
    try {
      runGlobal(
        script.kind === "babel"
          ? transform(code, {
              transforms: script.typescript ? ["jsx", "typescript"] : ["jsx"],
              jsxRuntime: "classic",
              production: true,
              filePath: script.src || "inline.jsx",
            }).code
          : code,
      );
    } catch (error) {
      thrown = (error as Error).message.split("\n")[0];
    } finally {
      window.removeEventListener("error", onError);
    }
    if (thrown && script.kind === "babel") notes.push(`${script.src || "An inline script"} failed: ${thrown}`);
  }

  // React renders on its own schedule and a Tailwind build follows the DOM:
  // wait until both have gone quiet.
  await settled(container, 300, 6000);
  if (!container.querySelector("#root > *") && container.querySelector("#root")) {
    notes.push("The design's React app rendered nothing.");
  }
  // What the scripts put in <head> (Tailwind's generated stylesheet, a
  // component's own <style>) is part of the page's CSS from here on.
  const added = Array.from(document.head.children).filter((el) => !before.has(el) && (el.tagName === "STYLE" || el.tagName === "LINK"));
  return { notes, added };
}
