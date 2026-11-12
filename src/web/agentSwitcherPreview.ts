// Preview scheduler for the agent switcher. Every preview costs an SSH capture on
// the server, so the client never fetches per tap: it waits for the highlight to
// rest, aborts the request in flight when the highlight moves, and caches
// snapshots briefly. Pure: clock, timers and fetch are injected.

export const PREVIEW_REST_MS = 250;
export const PREVIEW_CACHE_MS = 5000;

export type PreviewView = { t: 'idle' } | { t: 'loading' } | { t: 'text'; text: string } | { t: 'error' };
export interface PreviewTarget { boxId: string; session: string }
export interface PreviewDeps {
  fetch(target: PreviewTarget, signal: AbortSignal): Promise<string>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onChange(): void;
}

const keyOf = (t: PreviewTarget) => `${t.boxId}\n${t.session}`;

export function createPreviewScheduler(deps: PreviewDeps) {
  const cache = new Map<string, { text: string; at: number }>();
  let current: PreviewTarget | null = null;
  let failed = false;
  // The text on screen for the highlighted target. Held as state so view() never
  // depends on the clock; cache age is consulted only when a target is highlighted.
  let shown: string | null = null;
  let timer: unknown = null;
  let hasTimer = false;
  let ctl: AbortController | null = null;

  function fresh(t: PreviewTarget) {
    const hit = cache.get(keyOf(t));
    return hit && deps.now() - hit.at < PREVIEW_CACHE_MS ? hit : null;
  }
  function cancel() {
    if (hasTimer) { deps.clearTimer(timer); hasTimer = false; timer = null; }
    if (ctl) { ctl.abort(); ctl = null; }
  }
  function start(target: PreviewTarget) {
    hasTimer = false; timer = null;
    const mine = new AbortController();
    ctl = mine;
    const k = keyOf(target);
    deps.fetch(target, mine.signal).then(
      (text) => {
        // A resolved result is cached even if the request was aborted meanwhile.
        if (ctl === mine) ctl = null;
        cache.set(k, { text, at: deps.now() });
        if (current && keyOf(current) === k) { shown = text; deps.onChange(); }
      },
      () => {
        if (mine.signal.aborted) return;
        if (ctl === mine) ctl = null;
        if (current && keyOf(current) === k) { failed = true; deps.onChange(); }
      },
    );
  }

  function highlight(target: PreviewTarget | null) {
    if (target && current && keyOf(target) === keyOf(current) && (hasTimer || ctl || shown !== null)) return;
    cancel();
    failed = false;
    current = target;
    shown = target ? (fresh(target)?.text ?? null) : null;
    if (target && shown === null) {
      timer = deps.setTimer(() => start(target), PREVIEW_REST_MS);
      hasTimer = true;
    }
    deps.onChange();
  }

  function view(): PreviewView {
    if (!current) return { t: 'idle' };
    if (shown !== null) return { t: 'text', text: shown };
    return failed ? { t: 'error' } : { t: 'loading' };
  }

  function dispose() {
    cancel();
    current = null;
    shown = null;
    cache.clear();
  }

  return { highlight, view, dispose };
}
