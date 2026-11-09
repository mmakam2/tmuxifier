import { reconnectDelay } from './reconnect';

// Real-time agent state, browser side. The server's /live WebSocket
// (src/server/liveHub.js) says `{"box":"<id>"}` when a box changed; the tab
// answers by fetching that box through the ordinary routes (http.ts), so the
// socket itself never carries anything to render. The 30 s polls in main.ts
// stay as the backstop — a tab with no live link is simply as fresh as before.
//
// Three pure pieces, wired together in main.ts: the message parser, the queue
// that turns a burst of nudges into at most one refresh a second, and the link
// that keeps a socket open.

// Box ids are store UUIDs or `__local__`; the same shape the server publishes.
const BOX_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// The box a nudge names, or null for anything that is not exactly a nudge.
export function parseLiveMessage(data: unknown): string | null {
  if (typeof data !== 'string' || data.length > 256) return null;
  let msg: unknown;
  try { msg = JSON.parse(data); } catch { return null; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const box = (msg as { box?: unknown }).box;
  return typeof box === 'string' && BOX_ID_RE.test(box) ? box : null;
}

export interface LiveQueueOpts {
  // Refresh these boxes — or everything, when `ids` is null.
  run: (ids: string[] | null) => Promise<void> | void;
  minGapMs?: number;
  // More boxes than this in one batch (an outage, a restart) is cheaper as one
  // whole-fleet poll than as that many pairs of requests.
  maxIds?: number;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (h: unknown) => void;
}

// Collects nudged box ids and runs one refresh at a time, starts at least
// `minGapMs` apart. Ids that arrive while a refresh runs wait for the next one
// (it may have fetched before their change), so no nudge is dropped and none
// costs more than its share of one request pair per second.
export function createLiveQueue(opts: LiveQueueOpts) {
  const minGapMs = opts.minGapMs ?? 1000;
  const maxIds = opts.maxIds ?? 4;
  const now = opts.now ?? (() => Date.now());
  const setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pending = new Set<string>();
  let all = false;
  let running = false;
  let timer: unknown = null;
  let lastStart = -Infinity;
  let stopped = false;

  function start() {
    const ids = all || pending.size > maxIds ? null : [...pending];
    pending.clear();
    all = false;
    running = true;
    lastStart = now();
    Promise.resolve()
      .then(() => opts.run(ids))
      .catch(() => { /* the next poll repairs a failed refresh */ })
      .finally(() => {
        running = false;
        if (!stopped && (all || pending.size)) schedule();
      });
  }
  function schedule() {
    if (stopped || running || timer !== null) return;
    const wait = lastStart + minGapMs - now();
    if (wait <= 0) { start(); return; }
    timer = setT(() => { timer = null; if (!stopped) start(); }, wait);
  }
  return {
    push(id: string) {
      if (stopped) return;
      pending.add(id);
      schedule();
    },
    // Refresh everything at the next opportunity (a reconnect: whatever
    // changed while the link was down was never announced).
    pushAll() {
      if (stopped) return;
      all = true;
      schedule();
    },
    stop() {
      stopped = true;
      pending.clear();
      all = false;
      if (timer !== null) { clearT(timer); timer = null; }
    },
  };
}

// The subset of WebSocket the link uses; the browser's and `ws`'s both fit.
export interface LiveSocket {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export interface LiveLinkOpts {
  makeSocket: () => LiveSocket;
  onBox: (id: string) => void;
  // Fired on every open after the first: the link was down, so anything that
  // changed meanwhile was never announced.
  onReconnect?: () => void;
  // A connection counts as healthy once it has stayed open this long.
  stableMs?: number;
  baseMs?: number;
  capMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (h: unknown) => void;
}

// Keeps one /live socket open, reconnecting with exponential backoff. The
// failure count resets only after a connection has stayed up for `stableMs`:
// the server ACCEPTS an upgrade before it refuses it (1008 unauthorized, 1013
// full), so "it opened" proves nothing and resetting there would retry a
// refused session every second forever. A long-lived stream that the server
// closes on purpose (4000 renew, 1001 restarting) has reset by then and comes
// straight back.
export function openLiveLink(opts: LiveLinkOpts) {
  const stableMs = opts.stableMs ?? 10000;
  const baseMs = opts.baseMs ?? 1000;
  const capMs = opts.capMs ?? 60000;
  const setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let socket: LiveSocket | null = null;
  let closed = false;
  let failures = 0;
  let opens = 0;
  let retryTimer: unknown = null;
  let stableTimer: unknown = null;

  function retry() {
    if (closed || retryTimer !== null) return;
    failures += 1;
    retryTimer = setT(() => { retryTimer = null; connect(); }, reconnectDelay(failures, { baseMs, capMs }));
  }
  function connect() {
    if (closed) return;
    let s: LiveSocket;
    try { s = opts.makeSocket(); } catch { retry(); return; }
    socket = s;
    s.onopen = () => {
      if (closed || socket !== s) return;
      opens += 1;
      if (stableTimer !== null) clearT(stableTimer);
      stableTimer = setT(() => { stableTimer = null; failures = 0; }, stableMs);
      if (opens > 1) { try { opts.onReconnect?.(); } catch { /* never break the link */ } }
    };
    s.onmessage = (ev) => {
      if (closed || socket !== s) return;
      const id = parseLiveMessage(ev?.data);
      if (id !== null) { try { opts.onBox(id); } catch { /* never break the link */ } }
    };
    s.onerror = () => { /* a close always follows; the retry lives there */ };
    s.onclose = () => {
      if (socket !== s) return;
      socket = null;
      if (stableTimer !== null) { clearT(stableTimer); stableTimer = null; }
      retry();
    };
  }
  connect();
  return {
    close() {
      closed = true;
      if (retryTimer !== null) { clearT(retryTimer); retryTimer = null; }
      if (stableTimer !== null) { clearT(stableTimer); stableTimer = null; }
      const s = socket;
      socket = null;
      if (s) { try { s.close(); } catch { /* already closed */ } }
    },
  };
}
