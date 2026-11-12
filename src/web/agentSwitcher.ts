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
//    the seen acknowledgement (which needs document.hasFocus()) is unaffected; rows
//    preventDefault their mousedown for the same reason.
//  - The row order is frozen when it opens; refresh() repaints values in place only.
//  - Every string goes in through textContent.
import { CHORD_IDLE, chordReduce, type ChordEffect, type ChordInput, type ChordState } from './agentSwitcherChord';
import { initialIndex, stepIndex, type SwitcherRow } from './agentSwitcherList';
import { AGENT_LABEL, agentChipText, fmtAge } from './agentState';
import type { Combo } from './hotkeys';

export interface AgentSwitcherDeps {
  enabled(): boolean;
  combo(): Combo;
  rows(): SwitcherRow[]; // built at open; the order is frozen from then on
  live(frozen: SwitcherRow[]): SwitcherRow[];
  onOpen(): void;
  commit(row: SwitcherRow): void;
  fetchPreview(target: { boxId: string; session: string }, signal: AbortSignal): Promise<string>; // wired in Task 13
  now(): number;
}

// The overlay paints only once the chord has been held this long, so a quick
// tap-and-release flips without flashing it (CSS: `.pending` is visibility: hidden).
const PAINT_DELAY_MS = 150;

export function createAgentSwitcher(deps: AgentSwitcherDeps): { isOpen(): boolean; refresh(): void; cancel(): void; destroy(): void } {
  let state: ChordState = CHORD_IDLE;
  let frozen: SwitcherRow[] = [];
  let index = -1;
  let root: HTMLElement | null = null;
  let rowEls: HTMLElement[] = [];
  let paintTimer: ReturnType<typeof setTimeout> | null = null;

  function feed(input: ChordInput, ev?: Event) {
    const r = chordReduce(state, input, { combo: deps.combo(), enabled: deps.enabled() });
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
      mount();
    } else if (e.t === 'step') {
      if (!frozen.length) return;
      index = stepIndex(index, e.delta, frozen.length);
      paintSelection();
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
    // The terminal keeps focus through a click on the overlay.
    el.addEventListener('mousedown', (ev) => ev.preventDefault());
    el.addEventListener('click', () => feed({ t: 'click', index: i }));
    return el;
  }

  function paintSelection() {
    rowEls.forEach((el, i) => el.setAttribute('aria-selected', i === index ? 'true' : 'false'));
  }

  function mount() {
    unmount();
    root = document.createElement('div');
    root.id = 'agent-switcher';
    root.className = 'agent-switcher pending';
    const panel = document.createElement('div');
    panel.className = 'agent-switcher-panel';
    const list = document.createElement('div');
    list.className = 'agent-switcher-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Agent sessions');
    rowEls = frozen.map(buildRow);
    list.append(...rowEls);
    if (index === -1) list.append(span('agent-switcher-empty', 'No other agent sessions'));
    const preview = document.createElement('div');
    preview.className = 'agent-switcher-preview';
    panel.append(list, preview);
    root.append(panel);
    document.body.append(root);
    paintSelection();
    rowEls[index]?.scrollIntoView({ block: 'nearest' });
    paintTimer = setTimeout(() => {
      paintTimer = null;
      root?.classList.remove('pending');
    }, PAINT_DELAY_MS);
  }

  function unmount() {
    if (paintTimer) clearTimeout(paintTimer);
    paintTimer = null;
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
