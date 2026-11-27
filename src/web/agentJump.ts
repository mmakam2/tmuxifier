// Pure half of the jump to an agent pane (spec 2026-11-26 §7.3): a sidebar
// row names a box and a pane id; everything else the jump needs comes from that
// pane's own entry in the latest health sample, never from the row's text. The
// DOM half (main.ts jumpToAgent) docks the box on `session` and, unless the
// pane is already the focused one, selects its window and pane on the box.
// No DOM access: unit-tested in node.
import type { AgentEntry, Sample } from './api';
import { LOCAL_BOX, LOCAL_SESSION } from './agentSwitcherList';

export interface JumpTarget { boxId: string; pane: string; session: string; windowId: string; focused: boolean }

// The jump target for `pane`, or null when the box's map has no such pane. The
// map is keyed by box output (pane ids), so the lookup is own-property only: an
// inherited name such as `constructor` is not a pane.
export function jumpTargetOf(boxId: string, agents: Record<string, AgentEntry> | undefined, pane: string): JumpTarget | null {
  if (!agents || !Object.hasOwn(agents, pane)) return null;
  const e = agents[pane];
  if (!e || typeof e !== 'object' || typeof e.session !== 'string' || typeof e.windowId !== 'string') return null;
  return { boxId, pane, session: e.session, windowId: e.windowId, focused: e.focused === true };
}

// Only a pane that is already focused needs no select. A pane in the window in
// front still does: the select also moves tmux's pane focus onto it.
export function needsSelect(t: JumpTarget): boolean {
  return !t.focused;
}

// What the sidebar may list for a box. The Host Shell is one tmux session,
// `local`: its row, its window route and its acknowledgement all name that
// session alone, so an entry of any other host session would be a row that can
// neither be jumped to nor cleared. The server already narrows the __local__
// series this way; this is the client's own guard (the agent switcher keeps the
// same rule). A box keeps every entry. The result is null-prototype.
export function sidebarAgents(boxId: string, agents: Record<string, AgentEntry> | undefined): Record<string, AgentEntry> {
  if (boxId !== LOCAL_BOX) return agents ?? {};
  const out: Record<string, AgentEntry> = Object.create(null);
  for (const [pane, e] of Object.entries(agents ?? {})) if (e?.session === LOCAL_SESSION) out[pane] = e;
  return out;
}

// The series as the sidebar counts it: the Host Shell's latest sample carries
// only sidebarAgents(), so the attention strip never counts an agent no row
// shows. Only the latest sample is replaced (it is the only one counted); the
// input is never mutated.
export function sidebarSeries(series: Record<string, Sample[]>): Record<string, Sample[]> {
  const local = Object.hasOwn(series, LOCAL_BOX) ? series[LOCAL_BOX] : undefined;
  if (!local?.length) return series;
  const last = local[local.length - 1];
  return { ...series, [LOCAL_BOX]: [...local.slice(0, -1), { ...last, agents: sidebarAgents(LOCAL_BOX, last.agents) }] };
}

// The acknowledgement hold of a jump (spec 2026-11-26 §7.3 step 3: acknowledge
// "once fresh data shows the pane visible"). Docking a box repaints the stage,
// and a repaint acknowledges what the series in hand says is visible: during a
// jump that is the window being LEFT. So from before the dock nothing of the
// box is acknowledged, until the jump is covered by a series fetched after its
// select settled:
//  - a refused select moved nothing: the first such series covers it;
//  - a select that went through: the first such series in which the target
//    pane is visible, or no longer listed at all. A series fetched right after
//    the select can still describe the old window (the server records the new
//    one on its next probe), which is why "fetched after" alone is not enough;
//  - and never later than HOLD_MAX_MS after the select settled, so a pane the
//    operator has since moved away from cannot hold the box for good.
// Each jump is its own entry, so a second jump to the same box never releases
// the first one's hold early, and the box is held while any entry remains.
//
// fetchStarted() is called as a series fetch starts and returns its tick;
// applied(boxId, tick, agentsOf, nowMs) as its answer is applied (boxId null:
// a fleet-wide fetch). Pane maps are read with Object.hasOwn.
export const HOLD_MAX_MS = 60_000;

export interface SeenHold {
  begin(boxId: string, pane: string): number;
  settle(boxId: string, jump: number, ok: boolean, nowMs: number): void;
  fetchStarted(): number;
  applied(boxId: string | null, tick: number, agentsOf: (boxId: string) => Record<string, AgentEntry> | undefined, nowMs: number): void;
  held(boxId: string): boolean;
}

interface HeldJump { pane: string; settled: null | { clock: number; ok: boolean; at: number } }

export function createSeenHold(): SeenHold {
  let clock = 0;
  let nextJump = 0;
  const jumps = new Map<string, Map<number, HeldJump>>();
  const covered = (j: HeldJump, tick: number, agents: Record<string, AgentEntry> | undefined, nowMs: number): boolean => {
    if (!j.settled || tick <= j.settled.clock) return false;
    if (!j.settled.ok || nowMs - j.settled.at >= HOLD_MAX_MS) return true;
    if (!agents || !Object.hasOwn(agents, j.pane)) return true;
    return agents[j.pane]?.visible === true;
  };
  const release = (boxId: string, tick: number, agents: Record<string, AgentEntry> | undefined, nowMs: number) => {
    const mine = jumps.get(boxId);
    if (!mine) return;
    for (const [id, j] of mine) if (covered(j, tick, agents, nowMs)) mine.delete(id);
    if (!mine.size) jumps.delete(boxId);
  };
  return {
    begin(boxId, pane) {
      const id = ++nextJump;
      const mine = jumps.get(boxId) ?? new Map<number, HeldJump>();
      mine.set(id, { pane, settled: null });
      jumps.set(boxId, mine);
      return id;
    },
    settle(boxId, jump, ok, nowMs) {
      const j = jumps.get(boxId)?.get(jump);
      if (j && !j.settled) j.settled = { clock, ok, at: nowMs };
    },
    fetchStarted: () => ++clock,
    applied(boxId, tick, agentsOf, nowMs) {
      for (const id of boxId === null ? [...jumps.keys()] : [boxId]) release(id, tick, agentsOf(id), nowMs);
    },
    held: (boxId) => jumps.has(boxId),
  };
}
