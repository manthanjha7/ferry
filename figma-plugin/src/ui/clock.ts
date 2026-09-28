/**
 * A virtual clock for the document's own script, and the real one for ours.
 *
 * A Claude Design script animates with timers and animation frames: a number
 * that counts up to its value, a headline typed in letter by letter, a chart
 * that draws itself in. Measured on real time, the page was caught at whatever
 * tick the boot wait happened to end on, so a counter imported as "0" and a
 * typewriter as nothing. And those timers kept running after the import was
 * over.
 *
 * While a document is being measured, every timer and frame it asks for is
 * queued on a virtual clock instead of the browser's and run in order, as fast
 * as it can go, so an animation reaches its end in milliseconds. `Date.now()`
 * and `performance.now()` read that clock, so code that animates by elapsed
 * time sees the time pass. Uninstalling drops whatever is left, which is also
 * what stops the document's timers once the import ends.
 *
 * Ferry's own waits (stylesheets, fonts, the boot poll) must not be
 * fast-forwarded, so they use `real`, captured before anything is patched.
 */

export const real = {
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  requestAnimationFrame: window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16),
  now: Date.now.bind(Date),
  perf: performance.now.bind(performance),
};

/** Virtual time the boot phase may run to before the page is in the DOM. */
export const BOOT_HORIZON_MS = 2000;
/** Virtual time the page may run to before it is measured. */
export const SETTLE_HORIZON_MS = 12000;
/**
 * Repeating timers this slow are a slideshow or a clock, not an animation
 * step. Fast-forwarding one lands on an arbitrary slide, so they never run.
 */
const SLOW_INTERVAL_MS = 1000;
/** Callbacks one `advance` may run, so a runaway loop cannot hang the import. */
const MAX_STEPS = 6000;
const FRAME_MS = 1000 / 60;
/**
 * Animation frames in a row that changed nothing before the frame loop counts
 * as idle. A page that polls scroll position every frame forever (the
 * portfolio's reveal loop) ran 720 frames of layout for nothing: 89 of a
 * 91-second import. A counter or typewriter changes something every frame, so
 * it runs to its end.
 */
const IDLE_FRAMES = 30;

/** Bumped by the resolver on every document setState: state changes are activity too. */
let activity = 0;
export function noteActivity(): void {
  activity++;
}

type Entry = {
  id: number;
  seq: number;
  due: number;
  run: () => void;
  period?: number;
  frame?: boolean;
};

export type VirtualClock = {
  /** Run everything due up to `limit` ms of virtual time. */
  advance: (limit: number) => void;
  /** Where later timers may run to on their own, as they are scheduled. */
  setLimit: (limit: number) => void;
  uninstall: () => void;
};

let active: VirtualClock | null = null;

export function installVirtualClock(): VirtualClock {
  active?.uninstall();

  const originals = {
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    dateNow: Date.now,
    perfNow: performance.now,
  };
  const startDate = real.now();
  const startPerf = real.perf();

  let vt = 0;
  let seq = 0;
  let nextId = 1_000_000;
  let limit = BOOT_HORIZON_MS;
  let kicked = false;
  let installed = true;
  const queue = new Map<number, Entry>();
  const mutations = new MutationObserver(() => {});
  mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  let idleFrames = 0;

  const add = (entry: Omit<Entry, "id" | "seq">): number => {
    const id = nextId++;
    queue.set(id, { ...entry, id, seq: seq++ });
    if (!kicked) {
      kicked = true;
      real.setTimeout(() => {
        kicked = false;
        if (installed) advance(limit);
      }, 0);
    }
    return id;
  };

  const advance = (until: number): void => {
    for (let steps = 0; steps < MAX_STEPS && installed; steps++) {
      let next: Entry | undefined;
      for (const entry of queue.values()) {
        if (entry.period !== undefined && entry.period >= SLOW_INTERVAL_MS) continue;
        if (!next || entry.due < next.due || (entry.due === next.due && entry.seq < next.seq)) next = entry;
      }
      if (!next || next.due > until) return;
      queue.delete(next.id);
      vt = Math.max(vt, next.due);
      if (next.period !== undefined) {
        const period = next.period;
        queue.set(next.id, { ...next, due: vt + period, seq: seq++ });
      }
      const before = activity;
      mutations.takeRecords();
      try {
        next.run();
      } catch {
        // The document's own error; its other timers still run.
      }
      const changed = activity !== before || mutations.takeRecords().length > 0;
      if (!next.frame) idleFrames = 0;
      else if (changed) idleFrames = 0;
      else if (++idleFrames >= IDLE_FRAMES) {
        // The frame loop is polling, not animating: stop pumping it.
        for (const [id, entry] of queue) if (entry.frame) queue.delete(id);
        idleFrames = 0;
      }
    }
  };

  const callable = (handler: TimerHandler, args: unknown[]): (() => void) =>
    typeof handler === "function"
      ? () => (handler as (...a: unknown[]) => void)(...args)
      : () => {
          // A string handler is eval'd by the browser; we do not.
        };

  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    add({ due: vt + Math.max(0, Number(delay) || 0), run: callable(handler, args) })) as typeof window.setTimeout;
  window.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const period = Math.max(1, Number(delay) || 0);
    return add({ due: vt + period, run: callable(handler, args), period });
  }) as typeof window.setInterval;
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined && !queue.delete(id)) originals.clearTimeout.call(window, id);
  }) as typeof window.clearTimeout;
  window.clearInterval = window.clearTimeout as unknown as typeof window.clearInterval;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    // The next frame boundary strictly after now. Computed naively, float error
    // at 63 frames (1050ms) put "next" at now, and an animation loop spun in
    // place for the whole step budget.
    let due = (Math.floor((vt + 1e-6) / FRAME_MS) + 1) * FRAME_MS;
    if (due <= vt) due = vt + FRAME_MS;
    return add({ due, run: () => cb(startPerf + vt), frame: true });
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => {
    queue.delete(id);
  }) as typeof window.cancelAnimationFrame;
  Date.now = () => startDate + vt;
  performance.now = () => startPerf + vt;

  const clock: VirtualClock = {
    advance,
    setLimit: (next) => {
      limit = next;
    },
    uninstall: () => {
      if (!installed) return;
      installed = false;
      queue.clear();
      mutations.disconnect();
      window.setTimeout = originals.setTimeout;
      window.clearTimeout = originals.clearTimeout;
      window.setInterval = originals.setInterval;
      window.clearInterval = originals.clearInterval;
      window.requestAnimationFrame = originals.requestAnimationFrame;
      window.cancelAnimationFrame = originals.cancelAnimationFrame;
      Date.now = originals.dateNow;
      performance.now = originals.perfNow;
      if (active === clock) active = null;
    },
  };
  active = clock;
  return clock;
}
