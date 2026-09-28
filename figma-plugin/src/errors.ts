/**
 * What a user reads when something throws.
 *
 * Shared by both halves because both can fail on someone else's markup. A raw
 * exception string ("Cannot read properties of undefined") tells a designer
 * nothing and reads as a broken plugin; no detail at all leaves nothing to put
 * in a bug report. So: one plain sentence, with the underlying message kept,
 * trimmed, in brackets. Non-Error throws (a document's script can throw
 * anything) no longer come out as "undefined".
 */
export function describeError(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const detail = raw.replace(/\s+/g, " ").trim().slice(0, 160);
  const suffix = detail ? ` (${detail})` : "";
  if (/establish connection|internet connection|network|timed out/i.test(detail)) {
    return "Figma could not reach its servers in time (it loads fonts from them). Check your connection and import again.";
  }
  if (/font/i.test(detail)) {
    return `A font this document uses could not be loaded in Figma${suffix}.`;
  }
  return `Something in this document stopped the import${suffix}. Try re-exporting it from Claude Design.`;
}

/** An error's own message when it has one written for people, else the fallback. */
export function messageOf(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return raw.trim() || fallback;
}
