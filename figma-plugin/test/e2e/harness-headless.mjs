#!/usr/bin/env node
/**
 * Runs test/fixture/harness.html in headless Chrome and reports every check by
 * name.
 *
 * The harness is a browser page because the half of this plugin that can be
 * wrong in interesting ways (layout inference, token matching, text run
 * splitting) needs a real layout engine. That made it a thing a human had to
 * open in a browser and read, which is why regressions in it went unnoticed
 * for whole sessions. This drives it instead.
 *
 * Zero dependencies on purpose. Puppeteer is not installed here and adding it
 * would put a browser download in the way of running the tests. Node ships a
 * global WebSocket, so this speaks the DevTools protocol directly.
 *
 * The page only logs its tally and its failures, so the per-check names come
 * from evaluating its `results` array once it has finished, not from parsing
 * console output.
 *
 * `file://` cannot work: the harness POSTs captures to /capture/<name>, so
 * test/e2e/serve.py has to be up. This starts and stops it.
 *
 *     node test/e2e/harness-headless.mjs            # the assertion suite
 *     node test/e2e/harness-headless.mjs --real     # also the real-fixture pages
 *
 * Exit code 0 only if every page reached its terminator with no page
 * exception and no failed check.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..", "..");
const SERVE = join(HERE, "serve.py");
const BUNDLE = join(PLUGIN_ROOT, "test", "fixture", "bundle.js");

const CHROME =
  process.env.FERRY_CHROME || process.env.PORTAGE_CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const PORT = Number(process.env.FERRY_PORT || process.env.PORTAGE_PORT || 8899);
const WANT_REAL = process.argv.includes("--real");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}. Set FERRY_CHROME.`);
  process.exit(1);
}
// A run against a stale bundle measures code that is not in the tree, which is
// the one failure mode of this script that looks like a passing test run.
if (!existsSync(BUNDLE)) {
  console.error(
    "test/fixture/bundle.js is missing. It is gitignored and nothing rebuilds\n" +
      "it automatically:\n\n" +
      "  npx esbuild test/entry.ts --bundle --outfile=test/fixture/bundle.js --format=iife\n",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Chrome, over CDP
// ---------------------------------------------------------------------------

let nextId = 1;

function connect(url) {
  return new Promise((resolveConn, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = [];

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { ok, fail } = pending.get(message.id);
        pending.delete(message.id);
        message.error ? fail(new Error(message.error.message)) : ok(message.result);
        return;
      }
      for (const listener of listeners) listener(message);
    });

    socket.addEventListener("error", reject);
    socket.addEventListener("open", () =>
      resolveConn({
        send(method, params = {}, sessionId) {
          const id = nextId++;
          const payload = { id, method, params };
          if (sessionId) payload.sessionId = sessionId;
          socket.send(JSON.stringify(payload));
          return new Promise((ok, fail) => pending.set(id, { ok, fail }));
        },
        on(listener) {
          listeners.push(listener);
        },
        close: () => socket.close(),
      }),
    );
  });
}

/**
 * Load one harness page and wait for the terminator it logs when it is done.
 *
 * Returns the page's own `results` array where it has one. `--real` pages
 * report through the console instead, so those come back as log lines.
 */
async function runPage(cdp, url, terminator) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });

  const logs = [];
  let pageError = null;
  let finished = false;

  cdp.on((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.consoleAPICalled") {
      const text = (message.params.args || [])
        .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || ""))
        .join(" ");
      logs.push(text);
      if (text.includes(terminator)) finished = true;
    }
    if (message.method === "Runtime.exceptionThrown") {
      pageError =
        message.params.exceptionDetails.exception?.description ||
        message.params.exceptionDetails.text;
      finished = true;
    }
  });

  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url }, sessionId);

  // Real-fixture pages mount several large documents and measure each one, so
  // the budget is generous. A page that genuinely hangs still fails, it just
  // takes a while to say so.
  const deadline = Date.now() + 180_000;
  while (!finished && Date.now() < deadline) await sleep(100);

  let results = null;
  if (!pageError) {
    try {
      const evaluated = await cdp.send(
        "Runtime.evaluate",
        {
          expression: "JSON.stringify(typeof results === 'undefined' ? null : results)",
          returnByValue: true,
        },
        sessionId,
      );
      results = JSON.parse(evaluated.result.value ?? "null");
    } catch {
      // A page that never defined `results` is not an error here; the caller
      // decides whether the terminator alone was enough.
      results = null;
    }
  }

  await cdp.send("Target.closeTarget", { targetId });
  return { logs, results, pageError, timedOut: !finished };
}

// ---------------------------------------------------------------------------

const profile = mkdtempSync(join(tmpdir(), "portage-harness-"));

const server = spawn("python3", [SERVE, String(PORT)], {
  cwd: PLUGIN_ROOT,
  stdio: "ignore",
});

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let exitCode = 1;
let cdp = null;

const cleanup = () => {
  try {
    cdp?.close();
  } catch {}
  chrome.kill();
  server.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome is still flushing its profile when we get here, so this raced and
    // threw ENOTEMPTY, which took the process down AFTER every check had
    // passed: a green run reported as a failing one. The directory is a
    // mkdtemp under the OS temp dir and the OS will collect it.
  }
};

try {
  // Chrome writes the port it actually chose into the profile once it is up.
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (!existsSync(portFile) && Date.now() < deadline) await sleep(50);
  if (!existsSync(portFile)) throw new Error("Chrome never reported a debugging port.");

  await sleep(150);
  const [devtoolsPort, wsPath] = readFileSync(portFile, "utf8").trim().split("\n");
  cdp = await connect(`ws://127.0.0.1:${devtoolsPort}${wsPath}`);

  const base = `http://127.0.0.1:${PORT}`;
  let failures = 0;

  const suite = await runPage(cdp, `${base}/harness.html`, "HARNESS DONE");

  if (suite.pageError) {
    console.log(`PAGE EXCEPTION\n${suite.pageError}`);
    failures++;
  } else if (suite.timedOut) {
    console.log("!! TIMED OUT before HARNESS DONE");
    failures++;
  } else if (!suite.results) {
    console.log("!! page finished but exposed no results array");
    failures++;
  } else {
    for (const r of suite.results) {
      console.log(`CHECK ${r.ok ? "PASS" : "FAIL"} — ${r.name}${r.ok ? "" : ` :: ${r.detail}`}`);
      if (!r.ok) failures++;
    }
    const passed = suite.results.filter((r) => r.ok).length;
    console.log(`\nHARNESS ${passed}/${suite.results.length} passed`);
  }

  if (WANT_REAL) {
    // Which real fixtures exist is a property of the machine, not the repo:
    // test/fixture/real/ is gitignored because those documents are not ours to
    // publish. So ask the harness page which ones it found rather than
    // hardcoding a list that would fail on a clean clone.
    for (const name of ["chat", "deck", "search", "homepage", "petals"]) {
      const page = await runPage(cdp, `${base}/harness.html?real=${name}`, "HARNESS REAL DONE");
      if (page.pageError) {
        console.log(`REAL ${name}: PAGE EXCEPTION ${page.pageError}`);
        failures++;
        continue;
      }
      if (page.timedOut) {
        console.log(`REAL ${name}: TIMED OUT`);
        failures++;
        continue;
      }
      for (const line of page.logs.filter((l) => l.startsWith("HARNESS REAL ::"))) {
        console.log(`REAL ${name} ${line.replace("HARNESS REAL ::", "").trim()}`);
      }
    }
  }

  exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  console.error(error.message);
  exitCode = 1;
} finally {
  cleanup();
}

process.exit(exitCode);
