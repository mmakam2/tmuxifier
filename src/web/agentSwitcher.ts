// The agent switcher's DOM half: a Cmd-Tab-style overlay over every agent session in the
// fleet. Hold Ctrl+Shift and tap the combo key to step; release a modifier to commit.
// The pure pieces it runs are unit-tested: the held chord (agentSwitcherChord.ts), the
// rows and their order (agentSwitcherList.ts), and what a commit does to the stage
// (agentSwitcherCommit.ts, executed by main.ts through deps.commit).
//
// Rules this module keeps:
//  - One capture-phase keydown/keyup listener pair on document, registered once for the
//    page's lifetime. Every event the reducer claims is preventDefault()ed AND
//    stopPropagation()ed, so neither xterm nor the browser acts on it.
//  - `blur` is fed only for a WINDOW blur and for the document going hidden. An in-page
//    focus move (a commit focusing another terminal) is not a blur: fed during the
//    reducer's drain phase it would reset to idle and let held-key repeats type into the
//    new pane.
//  - The overlay never takes DOM focus. The terminal keeps it, so keys keep arriving and
//    the seen acknowledgement (which needs document.hasFocus()) is unaffected; the root
//    preventDefaults every mousedown for the same reason.
//  - Once painted, the full-screen root is a backdrop: it takes the pointer, refuses the
//    native context menu everywhere, and a click or secondary click on the backdrop itself
//    cancels (fed as a click on no row: the commit effect commits nothing and the reducer
//    keeps swallowing the held keys). A click-through would open Settings under the
//    overlay, and on macOS a missed Ctrl+click would raise the native menu, which eats
//    the modifiers' keyups and leaves the overlay stuck open.
//  - The row order is frozen when it opens; refresh() repaints values in place only.
//  - Every string goes in through textContent. The preview is untrusted box output
//    (agentSwitcherPreview.ts schedules it, ansiStrip.ts flattens it): plain text only.
//  - One preview scheduler per open, disposed on unmount (commit, cancel, teardown), so
//    no timer or request outlives the overlay. Nothing here acknowledges a session:
//    highlighting or previewing a `done` row never marks it seen. Stepping and
//    committing never wait on a preview.
import { CHORD_IDLE, chordReduce, type ChordEffect, type ChordInput, type ChordState } from './agentSwitcherChord';
import { initialIndex, stepIndex, type SwitcherRow } from './agentSwitcherList';
import { createPreviewScheduler, type PreviewTarget } from './agentSwitcherPreview';
import { AGENT_LABEL, agentChipText, fmtAge } from './agentState';
import type { Combo } from './hotkeys';

export interface AgentSwitcherDeps {
  enabled(): boolean;
  combo(): Combo;
  rows(): SwitcherRow[]; // built at open; the order is frozen from then on
  live(frozen: SwitcherRow[]): SwitcherRow[];
  onOpen(): void;
  commit(row: SwitcherRow): void;
  fetchPreview(target: PreviewTarget, signal: AbortSignal): Promise<string>; // the shaped text
  now(): number;
}

// The overlay paints only once the chord has been held this long, so a quick
// tap-and-release flips without flashing it (CSS: `.pending` is visibility: hidden).
const PAINT_DELAY_MS = 150;

export function createAgentSwitcher(deps: AgentSwitcherDeps): { isOpen(): boolean; refresh(): void; cancel(): void; destroy(): void } {
  let state: ChordState = CHORD_IDLE;
  let frozen: SwitcherRow[] = [];
  let index = -1;
  // Nothing to go to (initialIndex was -1 at open): the chord cannot step onto
  // the pinned "this pane" row, so the release commits nothing.
  let stuck = false;
  let root: HTMLElement | null = null;
  let rowEls: HTMLElement[] = [];
  let paintTimer: ReturnType<typeof setTimeout> | null = null;
  // The rows' latest values (frozen order): refresh() replaces it, so a row that
  // ended while the overlay is open stops being previewed.
  let latest: SwitcherRow[] = [];
  let preview: ReturnType<typeof createPreviewScheduler> | null = null;
  let previewKey: string | null = null; // the target last handed to the scheduler
  let previewHead: HTMLElement | null = null;
  let previewBody: HTMLElement | null = null;

  function feed(input: ChordInput, ev?: Event) {
    // `enabled` is a getter: main.ts's check queries the DOM and matchMedia, and this
    // runs for every key in the app, while the reducer reads it only on a keydown
    // that could open the overlay (or swallow a stale repeat).
    const r = chordReduce(state, input, { combo: deps.combo(), get enabled() { return deps.enabled(); } });
    state = r.state;
    if (r.swallow && ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    for (const e of r.effects) run(e);
  }

  function run(e: ChordEffect) {
    if (e.t === 'open') {
      deps.onOpen();
      frozen = deps.rows();
      index = initialIndex(frozen);
      stuck = index === -1;
      mount();
    } else if (e.t === 'step') {
      if (stuck || !frozen.length) return;
      index = stepIndex(index, e.delta, frozen.length);
      paintSelection();
      syncPreview();
      rowEls[index]?.scrollIntoView({ block: 'nearest' });
    } else if (e.t === 'commit') {
      const i = e.index ?? index;
      const row = i >= 0 ? deps.live(frozen)[i] : undefined;
      unmount();
      if (row && !row.gone) deps.commit(row);
    } else {
      unmount();
    }
  }

  function span(cls: string, text = ''): HTMLElement {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function paintRow(el: HTMLElement, r: SwitcherRow) {
    el.classList.toggle('gone', r.gone);
    const chip = el.querySelector('.agent-switcher-chip') as HTMLElement;
    chip.className = `agent-switcher-chip chip-agent-${r.state}`;
    chip.textContent = agentChipText(r.state, r.cause);
    (el.querySelector('.agent-switcher-kind') as HTMLElement).textContent = r.agent ? AGENT_LABEL[r.agent] : '';
    (el.querySelector('.agent-switcher-age') as HTMLElement).textContent = fmtAge(r.ts, deps.now());
  }

  function buildRow(r: SwitcherRow, i: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'agent-switcher-row';
    el.setAttribute('role', 'option');
    el.dataset.box = r.boxId;
    el.dataset.session = r.session;
    el.append(
      span('agent-switcher-chip'),
      span('agent-switcher-box', r.label),
      span('agent-switcher-session', r.session),
      span('agent-switcher-kind'),
      span('agent-switcher-age'),
    );
    if (r.here) el.append(span('agent-switcher-here', 'this pane'));
    paintRow(el, r);
    el.addEventListener('click', () => feed({ t: 'click', index: i }));
    // Every row click happens with Ctrl+Shift held, and on macOS a Ctrl+click is
    // the secondary action: `contextmenu`, no `click`. It commits the same way
    // (the root refuses the native menu); a platform that fires both cannot
    // double-commit, as the reducer ignores a click once it has left `open`.
    el.addEventListener('contextmenu', () => feed({ t: 'click', index: i }));
    return el;
  }

  // The highlighted row, unless there is none or its session ended.
  function previewRow(): SwitcherRow | null {
    const r = index >= 0 ? latest[index] : undefined;
    return r && !r.gone ? r : null;
  }

  // Hands the scheduler a target only when it changes: a repaint of the same row
  // must not restart a rest, nor retry a failed capture on every health poll.
  function syncPreview() {
    if (!preview) return;
    const r = previewRow();
    const key = r ? `${r.boxId}\n${r.session}` : null;
    if (key === previewKey) { paintPreview(); return; }
    previewKey = key;
    preview.highlight(r ? { boxId: r.boxId, session: r.session } : null);
  }

  function paintPreview() {
    if (!preview || !previewHead || !previewBody) return;
    const r = previewRow();
    previewHead.hidden = !r;
    if (r) {
      (previewHead.querySelector('.agent-switcher-preview-box') as HTMLElement).textContent = r.label;
      (previewHead.querySelector('.agent-switcher-preview-session') as HTMLElement).textContent = r.session;
      const chip = previewHead.querySelector('.agent-switcher-chip') as HTMLElement;
      chip.className = `agent-switcher-chip chip-agent-${r.state}`;
      chip.textContent = agentChipText(r.state, r.cause);
    }
    const v = preview.view();
    previewBody.dataset.view = v.t;
    const text = v.t === 'text' ? v.text : v.t === 'error' ? 'Preview unavailable' : '';
    if (previewBody.textContent !== text) {
      previewBody.textContent = text;
      previewBody.scrollTop = previewBody.scrollHeight; // the last lines are the ones that matter
    }
  }

  function paintSelection() {
    rowEls.forEach((el, i) => el.setAttribute('aria-selected', i === index ? 'true' : 'false'));
  }

  function mount() {
    unmount();
    root = document.createElement('div');
    root.id = 'agent-switcher';
    root.className = 'agent-switcher pending';
    const backdrop = root;
    // The terminal keeps focus through a click anywhere on the overlay.
    backdrop.addEventListener('mousedown', (ev) => ev.preventDefault());
    // A click on the backdrop itself (outside the panel) cancels: index -1 is a
    // commit to no row. A click inside the panel but not on a row does nothing.
    const onBackdrop = (ev: MouseEvent) => { if (ev.target === backdrop) feed({ t: 'click', index: -1 }); };
    backdrop.addEventListener('click', onBackdrop);
    // No native context menu anywhere over the overlay (rows commit on it).
    backdrop.addEventListener('contextmenu', (ev) => { ev.preventDefault(); onBackdrop(ev); });
    const panel = document.createElement('div');
    panel.className = 'agent-switcher-panel';
    const list = document.createElement('div');
    list.className = 'agent-switcher-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Agent sessions');
    rowEls = frozen.map(buildRow);
    list.append(...rowEls);
    if (index === -1) list.append(span('agent-switcher-empty', 'No other agent sessions'));
    const pane = document.createElement('div');
    pane.className = 'agent-switcher-preview';
    previewHead = document.createElement('div');
    previewHead.className = 'agent-switcher-preview-head';
    previewHead.append(span('agent-switcher-preview-box'), span('agent-switcher-preview-session'), span('agent-switcher-chip'));
    previewBody = document.createElement('pre');
    previewBody.className = 'agent-switcher-preview-body';
    pane.append(previewHead, previewBody);
    panel.append(list, pane);
    root.append(panel);
    document.body.append(root);
    paintSelection();
    latest = frozen;
    preview = createPreviewScheduler({
      fetch: deps.fetchPreview,
      now: deps.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onChange: paintPreview,
    });
    previewKey = null; // a fresh scheduler is idle: no row means no highlight call
    syncPreview();
    rowEls[index]?.scrollIntoView({ block: 'nearest' });
    paintTimer = setTimeout(() => {
      paintTimer = null;
      root?.classList.remove('pending');
    }, PAINT_DELAY_MS);
  }

  function unmount() {
    if (paintTimer) clearTimeout(paintTimer);
    paintTimer = null;
    preview?.dispose();
    preview = null;
    previewKey = null;
    previewHead = previewBody = null;
    latest = [];
    root?.remove();
    root = null;
    rowEls = [];
  }

  const onKey = (ev: KeyboardEvent) => feed({ t: 'key', ev }, ev);
  // Only the window's own blur means focus left the page. Element blurs do not
  // bubble here, and the target check keeps it that way should this ever become
  // a capture listener (which would see every in-page focus move).
  const onBlur = (ev: Event) => { if (ev.target === window) feed({ t: 'blur' }); };
  const onVisibility = () => { if (document.visibilityState === 'hidden') feed({ t: 'blur' }); };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    isOpen: () => state.phase === 'open',
    refresh: () => {
      if (!root) return;
      const live = deps.live(frozen);
      live.forEach((r, i) => { if (rowEls[i]) paintRow(rowEls[i], r); });
      latest = live;
      syncPreview();
    },
    // Teardown (logout, session expiry): unmount without committing. The keys
    // may still be held, so their repeats and keyups keep being swallowed.
    cancel: () => {
      if (state.phase === 'open') state = { ...state, phase: 'drain' };
      unmount();
    },
    destroy: () => {
      state = CHORD_IDLE;
      unmount();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
