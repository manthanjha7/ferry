/**
 * Test-harness entry. Exposes the extractor on `window` so a plain browser page
 * can exercise the DOM half without Figma in the loop.
 *
 * The extractor is the half that can actually be wrong in interesting ways —
 * layout inference, token matching, text run splitting — and it is also the
 * half that runs in a normal DOM. So it gets tested here for real rather than
 * eyeballed inside Figma.
 */

import { documentStateAxes, extractDocument, extractStateMatrix } from "../src/ui/extract";
import { readZip } from "../src/ui/zip";
import { enumerableProps, readPropsSchema } from "../src/ui/resolve";

/**
 * The panel module, loaded on demand.
 *
 * `src/ui/main.ts` wires itself to the panel's markup at module scope, so a
 * static import here would throw on any page that is not the panel. A dynamic
 * import is compiled by esbuild into a lazily-initialised module (verified in
 * the emitted bundle: the module body sits inside an `__esm` wrapper), which
 * lets the harness inject the real markup from ui.template.html first and only
 * then boot it. That is what makes the asset-inlining and token-CSS helpers
 * testable against the code that actually ships rather than a copy of it.
 */
(window as unknown as Record<string, unknown>).loadPanel = () => import("../src/ui/main");

(window as unknown as Record<string, unknown>).extractDocument = extractDocument;
(window as unknown as Record<string, unknown>).readZip = readZip;
// The state matrix only exists in a browser: it mounts one document once per
// combination, sequentially, against the real layout engine. The decisions it
// makes BEFORE mounting are asserted in test/e2e/run.ts scenario N; this is how
// the mounting half gets driven against a real export.
(window as unknown as Record<string, unknown>).extractStateMatrix = extractStateMatrix;
(window as unknown as Record<string, unknown>).documentStateAxes = documentStateAxes;
// The prop schema is read from raw markup rather than from an IRDocument, so
// it has no other way into a harness assertion: nothing downstream of
// `extractDocument` carries the declared options or their order.
(window as unknown as Record<string, unknown>).readPropsSchema = readPropsSchema;
(window as unknown as Record<string, unknown>).enumerableProps = enumerableProps;
