/**
 * "From Claude": designs sent from Claude through Ferry Link.
 *
 * Ferry Link (ferry-link/ in this repo) is a helper Claude starts on the
 * user's computer. Claude reads a Claude Design project through its connector
 * and hands it to Ferry Link, which keeps it in a local inbox on
 * localhost:47841. This panel polls that inbox and opens what arrives the same
 * way as a dropped zip.
 *
 * Pairing keeps anything else on the machine out: the panel shows a code, the
 * user tells Claude "pair Ferry <code>", and Ferry Link only answers a panel
 * whose code it was given.
 */

const BASE = "http://localhost:47841";
const POLL_MS = 2000;

export type LinkItem = { id: string; name: string; createdAt: string; bytes: number; page?: string };

type State =
  | { kind: "unknown" }
  | { kind: "absent" }
  | { kind: "unpaired" }
  | { kind: "ready"; items: LinkItem[] };

export type LinkOptions = {
  box: HTMLElement;
  hint: HTMLElement;
  list: HTMLElement;
  /** Open a design as if its zip had been dropped. */
  open: (file: File, item: LinkItem) => Promise<void>;
  /** Say, in the panel's status line, why a design would not open. */
  fail: (message: string) => void;
};

let code: string | null = null;
let state: State = { kind: "unknown" };
let timer: number | null = null;
let opening = false;
let visibilityHooked = false;

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const abort = new AbortController();
  const t = window.setTimeout(() => abort.abort(), 1500);
  try {
    return await fetch(`${BASE}${path}`, { ...init, signal: abort.signal, headers: { "x-ferry-code": code ?? "" } });
  } finally {
    window.clearTimeout(t);
  }
}

function render(o: LinkOptions): void {
  const { box, hint, list } = o;
  list.textContent = "";
  if (!code || state.kind === "unknown") {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (state.kind === "absent") {
    hint.innerHTML =
      'Send designs straight from Claude: in Claude Code, run <span class="cd2f-code">/plugin marketplace add manthanjha7/ferry</span> then <span class="cd2f-code">/plugin install ferry-link@ferry</span>.';
    return;
  }
  if (state.kind === "unpaired") {
    hint.innerHTML = `Ferry Link is running. To pair this panel, tell Claude: <span class="cd2f-code">pair Ferry ${code}</span>`;
    return;
  }
  if (state.items.length === 0) {
    hint.textContent = "Waiting for a design. In Claude, say “send my <project> to Figma”.";
    return;
  }
  hint.textContent = state.items.length === 1 ? "Click to open it here:" : "Click one to open it here:";
  for (const item of state.items) {
    const row = document.createElement("div");
    row.className = "cd2f-claude-item";
    row.setAttribute("data-link-id", item.id);
    const name = document.createElement("span");
    name.textContent = item.name;
    const when = document.createElement("span");
    when.className = "cd2f-muted";
    when.textContent = ago(item.createdAt);
    row.append(name, when);
    row.addEventListener("click", () => void openItem(o, item));
    list.appendChild(row);
  }
}

async function openItem(o: LinkOptions, item: LinkItem): Promise<void> {
  if (opening) return;
  opening = true;
  try {
    const res = await request(`/v1/inbox/${item.id}`);
    if (!res.ok) throw new Error(res.status === 404 ? "It is no longer in Ferry Link's inbox. Send it again from Claude." : `Ferry Link answered ${res.status}.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const file = new File([bytes], `${item.name.replace(/[\\/:*?"<>|]/g, " ")}.zip`, { type: "application/zip" });
    await o.open(file, item);
    // Opened: it leaves the inbox, so it is not offered twice.
    await request(`/v1/inbox/${item.id}`, { method: "DELETE" }).catch(() => undefined);
    if (state.kind === "ready") state = { kind: "ready", items: state.items.filter((i) => i.id !== item.id) };
    render(o);
  } catch (error) {
    o.fail(error instanceof Error && !/fetch|network|abort/i.test(error.message) ? error.message : "Could not reach Ferry Link. Is Claude still open?");
    void poll(o);
  } finally {
    opening = false;
  }
}

async function poll(o: LinkOptions): Promise<void> {
  if (!code) return;
  let next: State;
  try {
    const res = await request("/v1/inbox");
    if (res.status === 403) next = { kind: "unpaired" };
    else if (res.ok) next = { kind: "ready", items: ((await res.json()) as { items: LinkItem[] }).items ?? [] };
    else next = { kind: "absent" };
  } catch {
    next = { kind: "absent" };
  }
  const changed = JSON.stringify(next) !== JSON.stringify(state);
  state = next;
  if (changed) render(o);
}

export function startLink(o: LinkOptions, pairingCode: string): void {
  code = pairingCode;
  if (timer !== null) window.clearInterval(timer);
  void poll(o);
  let lastPoll = 0;
  timer = window.setInterval(() => {
    if (opening) return;
    // Behind another window, a slow heartbeat: enough for Ferry Link to know
    // the panel is open, without polling a page nobody is looking at.
    const hidden = document.visibilityState === "hidden";
    if (hidden && Date.now() - lastPoll < 15_000) return;
    lastPoll = Date.now();
    void poll(o);
  }, POLL_MS);
  // A hidden page's timers are throttled to once a minute; coming back to
  // Figma is when a design sent meanwhile has to show, so look right away.
  if (!visibilityHooked) {
    visibilityHooked = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !opening) {
        lastPoll = Date.now();
        void poll(o);
      }
    });
  }
}
