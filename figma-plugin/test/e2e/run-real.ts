/**
 * Builder scale test: a captured real-* IR (test/e2e/captured/<name>.json,
 * produced by test/fixture/harness.html?real=<fixture> against a real
 * Claude Design document under test/fixture/real/ — NOT the 22-node
 * synthetic fixture) -> the REAL src/plugin/build.ts -> mock Figma API.
 *
 * This is a companion to run.ts, not a replacement: run.ts asserts specific
 * IR shapes against the small hand-built fixture; this file instead answers
 * "does the builder survive and perform reasonably at real-document scale",
 * since we have never exercised build.ts against anything bigger than 22
 * nodes before. Nothing in src/ is touched or stubbed.
 *
 * Run with (from figma-plugin/):
 *   npx esbuild test/e2e/run-real.ts --bundle --outfile=test/e2e/run-real.mjs --format=esm --platform=node --target=node18
 *   node test/e2e/run-real.mjs [captureName]
 *
 * captureName defaults to "real-homepage" and selects
 * test/e2e/captured/<captureName>.json — e.g. `node test/e2e/run-real.mjs
 * real-deck` builds against the captured slide-deck IR instead.
 *
 * test/fixture/real/ is gitignored (third-party material, never
 * committed — see test/fixture/real/ and .gitignore), so this script SKIPs
 * cleanly with a clear message if the capture hasn't been produced yet
 * rather than failing the way a missing fixture normally would.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { IRDocument, VariableTarget } from "../../src/ir";
import { buildDocument } from "../../src/plugin/build";
import { createFigmaMock } from "./figma-mock";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURED_DIR = join(HERE, "captured");
const CAPTURE_NAME = process.argv[2] ?? "real-homepage";
const REAL_PATH = join(CAPTURED_DIR, `${CAPTURE_NAME}.json`);

// ---------------------------------------------------------------------------
// Helpers (same shapes as run.ts, reimplemented locally so this file stays
// runnable standalone)
// ---------------------------------------------------------------------------

function loadCaptured(path: string): IRDocument {
  const raw = readFileSync(path, "utf-8");
  const revived = JSON.parse(raw, (_key, value) => {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray((value as { __u8?: unknown }).__u8) &&
      Object.keys(value).length === 1
    ) {
      return new Uint8Array((value as { __u8: number[] }).__u8);
    }
    return value;
  });
  return revived as IRDocument;
}

function freshMock() {
  const mock = createFigmaMock();
  (globalThis as { figma?: unknown }).figma = mock.figma;
  return mock;
}

async function main(): Promise<void> {
  console.log(`Looking for captured IR at ${REAL_PATH}...`);
  if (!existsSync(REAL_PATH)) {
    console.log(
      `SKIP — captured/${CAPTURE_NAME}.json not found. Run test/fixture/harness.html?real=<fixture> ` +
        "against the local server first (see test/fixture/real/README / the confidentiality " +
        "gate in .gitignore — this capture is never committed).",
    );
    process.exitCode = 0;
    return;
  }

  const mock = freshMock();
  const doc = loadCaptured(REAL_PATH);
  const target: VariableTarget = { kind: "create", name: "Acme" };

  const progress: Array<{ done: number; total: number; label: string }> = [];
  const onProgress = (done: number, total: number, label: string) => {
    progress.push({ done, total, label });
  };

  console.log(`Building "${doc.name}" — ${doc.designSystem?.tokens.length ?? 0} design-system tokens on file.`);

  const t0 = Date.now();
  let threw: { message: string; stack?: string } | null = null;
  let nodeCount = 0;
  let variablesCreated = 0;
  let substitutions: string[] = [];

  try {
    const result = await buildDocument(doc, target, onProgress);
    nodeCount = result.nodeCount;
    variablesCreated = result.mapping.created;
    substitutions = result.substitutions;
  } catch (err) {
    threw = {
      message: String((err as Error)?.message ?? err),
      stack: (err as Error)?.stack,
    };
  }
  const elapsedMs = Date.now() - t0;

  const totalVariables = mock.getVariables().length;

  console.log("");
  console.log(`=== Builder scale-test report (captured/${CAPTURE_NAME}.json) ===`);
  console.log(`completed without throwing: ${threw === null}`);
  console.log(`node count built: ${nodeCount}`);
  console.log(`variables created: ${variablesCreated} (total in mock: ${totalVariables})`);
  console.log(`fonts substituted: ${substitutions.length}`);
  if (substitutions.length > 0) {
    for (const s of substitutions) console.log(`  - ${s}`);
  }
  console.log(`wall-clock time: ${elapsedMs} ms`);
  console.log(`progress callbacks: ${progress.length}`);
  if (progress.length > 0) {
    const last = progress[progress.length - 1];
    console.log(`  last progress: done=${last.done} total=${last.total} label="${last.label}"`);
  }
  if (threw) {
    console.log("");
    console.log("THROWN ERROR:");
    console.log(`  message: ${threw.message}`);
    console.log(`  stack:\n${threw.stack ?? "(no stack)"}`);
  }

  process.exitCode = threw ? 1 : 0;
}

main().catch((err) => {
  console.error("run-real crashed outside the measured build call:", err);
  process.exitCode = 1;
});
