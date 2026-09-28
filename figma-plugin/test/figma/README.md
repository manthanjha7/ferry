# Real-Figma bench

Drives Ferry inside the Figma desktop app and scores what Figma actually
renders against the same page in a real browser.

1. Build the hook-enabled plugin: `node build.mjs --selftest` (adds sandbox
   hooks to clear the page, export PNGs and dump the layer tree; a normal build
   compiles them out).
2. Launch Figma with debugging, which it only allows under `FIGMA_TEST`:
   `open -a Figma --env FIGMA_TEST=1 --args --remote-debugging-port=9333`
3. Open a scratch design file and note its tab's target id prefix
   (`node -e` against `http://127.0.0.1:9333/json/list`).
4. `node suite.mjs <prefix>` — per case: import through Ferry's real panel
   (`bench.mjs`), render the reference in headless Chrome at 1440 with Figma's
   own Inter (`reference.mjs`, `figma-fonts.css`), then pixel mismatch
   (`compare.py`), per-element boxes (`boxes.py`) and a designer-quality report
   (`quality.py`). Results in `/tmp/bench/<case>/`.

`in-figma.mjs` runs the extractor inside Figma's plugin window directly, for
what only happens there (null origin, Figma's fonts and network policy).
Rebuild with a normal `node build.mjs` before committing `dist/`.
