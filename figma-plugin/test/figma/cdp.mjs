/**
 * Minimal Chrome DevTools Protocol client for driving the Figma desktop app,
 * launched with `FIGMA_TEST=1` and `--remote-debugging-port` (Figma strips the
 * switch otherwise). No dependencies: Node's own WebSocket.
 */
export const PORT = Number(process.env.FIGMA_CDP_PORT || 9333);

export async function connectBrowser() {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  return connect(version.webSocketDebuggerUrl);
}

export function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = new Set();
    let nextId = 1;
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? fail(new Error(`${msg.error.message} ${msg.error.data ?? ""}`)) : ok(msg.result);
      } else {
        for (const fn of listeners) fn(msg);
      }
    });
    socket.addEventListener("error", reject);
    socket.addEventListener("open", () =>
      resolve({
        send(method, params = {}, sessionId) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          return new Promise((ok, fail) => pending.set(id, { ok, fail }));
        },
        on(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        close() {
          socket.close();
        },
      }),
    );
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Attach to a target and evaluate an expression in it (awaiting promises). */
export async function evaluate(cdp, sessionId, expression, { contextId, timeout = 60000 } = {}) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, timeout, ...(contextId ? { contextId } : {}) },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}
