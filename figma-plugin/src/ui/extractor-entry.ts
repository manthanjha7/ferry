/**
 * The extractor, as the script that runs inside its own frame (src/ui/realm.ts).
 * Built separately and embedded in the panel as source text.
 */
import { documentStateAxes, extractAnimationScenes, extractDocument, extractStateMatrix } from "./extract";
import { readAnimationSpec } from "./animation";

const api = { extractDocument, extractStateMatrix, documentStateAxes, extractAnimationScenes, readAnimationSpec };
export type ExtractorApi = typeof api;
(window as unknown as { __ferryExtractor: ExtractorApi }).__ferryExtractor = api;
