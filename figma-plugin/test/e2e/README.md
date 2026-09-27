# IR capture

Captures the real IRDocument from the browser extractor to disk as JSON,
so a Node test can feed it to the Figma builder later.

1. `python3 test/e2e/serve.py` (from `figma-plugin/`, port 8899 by default).
2. Open `http://localhost:8899/harness.html` in a browser.
3. IR lands in `test/e2e/captured/fixture-screen.json` and
   `test/e2e/captured/orphaned-screen.json`.

IMAGE nodes' `imageBytes` (a `Uint8Array`) is not JSON-safe, so the harness
encodes it as `{"__u8": [...]}` before posting. Node-side consumers must
convert that back to a `Uint8Array` before using the captured IR.
