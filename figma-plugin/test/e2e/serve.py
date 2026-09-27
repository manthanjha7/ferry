#!/usr/bin/env python3
"""Static file server for the extractor test harness, plus a capture endpoint.

Serves `test/fixture/` as the static root, so `harness.html`, `bundle.js`,
`screen.html`, and `tokens.css` work exactly as they do today under a plain
`python3 -m http.server`. On top of that it adds one route:

    POST /capture/<name>
        Body: a JSON document (the IRDocument produced by
        window.extractDocument in the harness). Written pretty-printed
        (indent=2) to test/e2e/captured/<name>.json, creating the
        `captured/` directory if it does not exist yet. `<name>` is
        sanitized to [A-Za-z0-9._-]+ only -- anything else is rejected
        with 400. Responds 200 with {"ok": true, "bytes": N} where N is
        the byte length of the file written.

CORS is wide open (Access-Control-Allow-Origin: *) and OPTIONS preflight
is handled, so a `fetch()` from the harness page always succeeds.

Usage:
    python3 test/e2e/serve.py [port]   # default port 8899
"""

import http.server
import json
import os
import sys
from urllib.parse import unquote, urlsplit

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
FIXTURE_DIR = os.path.normpath(os.path.join(THIS_DIR, "..", "fixture"))
PLUGIN_ROOT = os.path.normpath(os.path.join(THIS_DIR, "..", ".."))
CAPTURED_DIR = os.path.join(THIS_DIR, "captured")

DEFAULT_PORT = 8899
CAPTURE_PREFIX = "/capture/"

# Only plain filename-safe characters are allowed in <name>. No slashes, no
# percent-encoded separators once decoded -- this also rules out path
# traversal, since without a path separator "../" cannot form.
_NAME_ALLOWED = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"
)


def _is_valid_name(name: str) -> bool:
    return len(name) > 0 and all(ch in _NAME_ALLOWED for ch in name)


class CaptureHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FIXTURE_DIR, **kwargs)

    # Keep stdout readable; default logging is noisy enough already.
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def translate_path(self, path):
        # The isolation checks mount a document underneath the panel's OWN
        # stylesheet, so the harness has to fetch the real ui.template.html
        # rather than a copy of it that can drift out of date. It sits one level
        # above the static root and SimpleHTTPRequestHandler strips "..", so it
        # needs a route of its own.
        if urlsplit(path).path == "/ui.template.html":
            return os.path.join(PLUGIN_ROOT, "ui.template.html")
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        # Every file served here is a fixture someone is actively editing. A
        # cached bundle.js or .html fixture makes the harness report on code
        # that is no longer on disk, and it reports PASS while doing it.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        path = urlsplit(self.path).path
        if not path.startswith(CAPTURE_PREFIX):
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        name = unquote(path[len(CAPTURE_PREFIX):])
        if not _is_valid_name(name):
            self._send_json(400, {"ok": False, "error": "invalid capture name"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"ok": False, "error": "invalid Content-Length"})
            return

        raw = self.rfile.read(length) if length > 0 else b""

        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            self._send_json(400, {"ok": False, "error": f"invalid json body: {e}"})
            return

        os.makedirs(CAPTURED_DIR, exist_ok=True)
        out_path = os.path.join(CAPTURED_DIR, f"{name}.json")
        data = json.dumps(payload, indent=2).encode("utf-8")
        with open(out_path, "wb") as f:
            f.write(data)

        print(f"captured {name} ({len(data)} bytes)", flush=True)
        self._send_json(200, {"ok": True, "bytes": len(data)})

    def _send_json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    server = http.server.ThreadingHTTPServer(("", port), CaptureHandler)
    print(
        f"serving {FIXTURE_DIR} on http://localhost:{port} "
        f"(POST {CAPTURE_PREFIX}<name> -> {CAPTURED_DIR}/<name>.json)",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
