/**
 * Two bundles, two very different environments:
 *
 *   src/plugin/main.ts -> dist/code.js  (Figma sandbox: has `figma`, no DOM)
 *   src/ui/main.ts     -> dist/ui.html  (iframe: has DOM, no `figma`)
 *
 * The UI bundle has to be *inlined* into the HTML. Figma reads `ui.html` as a
 * single blob and serves it from an opaque origin, so a `<script src>` would
 * have nothing to resolve against.
 */

import * as esbuild from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// `--selftest` compiles in the sandbox hooks the real-Figma test driver uses
// (clear the page, export what was built as PNG, dump the layer tree). A normal
// build defines the flag false and esbuild drops that code entirely.
const selftest = process.argv.includes("--selftest");

const shared = {
  bundle: true,
  target: "es2017",
  format: "iife",
  logLevel: "info",
  define: { __SELFTEST__: String(selftest) },
};

await mkdir(resolve(root, "dist"), { recursive: true });

/** Inline the UI bundle into the HTML shell. */
const inlineUiPlugin = {
  name: "inline-ui",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;

      const js = result.outputFiles?.find((f) => f.path.endsWith(".js"));
      if (!js) return;

      const template = await readFile(resolve(root, "ui.template.html"), "utf8");
      // A literal `</script>` inside the bundle would close the tag early.
      const safe = js.text.replace(/<\/script>/gi, "<\\/script>");

      // Stamp the build so the running panel can be told apart from a cached
      // one. Figma reuses plugin code between runs and gives no indication.
      const stamp = new Date()
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d+Z$/, "") + (selftest ? " selftest" : "");

      await writeFile(
        resolve(root, "dist/ui.html"),
        template
          // A function, not a string: a replacement string expands `$&` and
          // `$'`, which the embedded extractor source contains.
          .replace("/* __BUNDLE__ */", () => safe)
          .replace("__BUILD__", stamp),
        "utf8",
      );
      console.log(`  dist/ui.html (build ${stamp})`);
    });
  },
};

const pluginCtx = await esbuild.context({
  ...shared,
  entryPoints: [resolve(root, "src/plugin/main.ts")],
  outfile: resolve(root, "dist/code.js"),
});

// The extractor runs in a standards-mode frame the panel writes itself
// (src/ui/realm.ts), so it is its own bundle, embedded in the panel as text.
const extractorBuild = await esbuild.build({
  ...shared,
  logLevel: "warning",
  entryPoints: [resolve(root, "src/ui/extractor-entry.ts")],
  write: false,
  outfile: resolve(root, "dist/extractor.js"),
  define: { "process.env.NODE_ENV": '"production"', __SELFTEST__: String(selftest) },
  minify: true,
  keepNames: true,
});
const extractorSource = extractorBuild.outputFiles[0].text;

const uiCtx = await esbuild.context({
  ...shared,
  entryPoints: [resolve(root, "src/ui/main.ts")],
  outfile: resolve(root, "dist/ui.js"),
  write: false,
  plugins: [inlineUiPlugin],
  // React ships a development build unless told otherwise, at four times the
  // size. Minified because the panel is one inlined HTML file; names kept so
  // a stack trace in a bug report still says where it came from.
  define: {
    "process.env.NODE_ENV": '"production"',
    __SELFTEST__: String(selftest),
    __EXTRACTOR_SOURCE__: JSON.stringify(extractorSource),
  },
  minify: true,
  keepNames: true,
});

if (watch) {
  await Promise.all([pluginCtx.watch(), uiCtx.watch()]);
  console.log("watching…");
} else {
  await Promise.all([pluginCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([pluginCtx.dispose(), uiCtx.dispose()]);
}
