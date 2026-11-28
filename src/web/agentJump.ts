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
// A pane-header pick of a window in ANOTHER session holds the same way, with
// no target pane (beginWindow): it is covered by such a series in which no
// entry of that session outside the picked window is visible (the picked
// window is in front, or nothing of the session that could be acknowledged
// wrongly is), or that no longer lists the box. A select that is refused or
// fails before anything is docked moved nothing at all and is cancelled at
// once (cancel).
// Each jump is its own entry, so a second jump to the same box never releases
// the first one's hold early, and the box is held while any entry remains.
// But a later jump supersedes the earlier ones (their targets are behind it
// now and may never be visible again): once every select of the box has
// settled, a series fetched after the last settle that covers the LATEST begun
// jump whose select went through releases every hold of the box. "Latest" is
// begin order, which is the order the selects were sent and so the order the
// box ran them; answers can arrive in any order. A refused select supersedes
// nothing, and nothing is superseded while a select is still out, since it may
// yet move the window. Until then an earlier jump is still released on its own
// cover, and the latest begun one is kept, since it is what speaks for them all
// (a box that ran two selects out of their send order waits for the cap).
//
// fetchStarted() is called as a series fetch starts and returns its tick;
// applied(boxId, tick, agentsOf, nowMs) as its answer is applied (boxId null:
// a fleet-wide fetch). Pane maps are read with Object.hasOwn.
export const HOLD_MAX_MS = 60_000;

export interface SeenHold {
  begin(boxId: string, pane: string): number;
  beginWindow(boxId: string, session: string, windowId: string): number;
  settle(boxId: string, jump: number, ok: boolean, nowMs: number): void;
  cancel(boxId: string, jump: number): void;
  fetchStarted(): number;
  applied(boxId: string | null, tick: number, agentsOf: (boxId: string) => Record<string, AgentEntry> | undefined, nowMs: number): void;
  held(boxId: string): boolean;
}

type Cover = { pane: string } | { session: string; windowId: string };
interface HeldJump { cover: Cover; settled: null | { clock: number; ok: boolean; at: number } }

export function createSeenHold(): SeenHold {
  let clock = 0;
  let nextJump = 0;
  // box -> jump id -> jump; ids grow, and a Map keeps insertion order, so the
  // last entry is the latest begun.
  const jumps = new Map<string, Map<number, HeldJump>>();
  // What the jump waits to see in front, once its select went through.
  const inFront = (c: Cover, agents: Record<string, AgentEntry>): boolean => {
    if ('pane' in c) return !Object.hasOwn(agents, c.pane) || agents[c.pane]?.visible === true;
    for (const pane of Object.keys(agents)) {
      const e = agents[pane];
      if (e && e.session === c.session && e.windowId !== c.windowId && e.visible === true) return false;
    }
    return true;
  };
  const covered = (j: HeldJump, tick: number, agents: Record<string, AgentEntry> | undefined, nowMs: number): boolean => {
    if (!j.settled || tick <= j.settled.clock) return false;
    if (!j.settled.ok || nowMs - j.settled.at >= HOLD_MAX_MS) return true;
    if (!agents) return true;
    return inFront(j.cover, agents);
  };
  const release = (boxId: string, tick: number, agents: Record<string, AgentEntry> | undefined, nowMs: number) => {
    const mine = jumps.get(boxId);
    if (!mine) return;
    // The supersede rule: every select settled, this series fetched after the
    // last settle, and the latest begun jump that went through covered (none
    // went through: nothing moved, and the series covers them all).
    let allSettled = true;
    let lastClock = 0;
    let latestOk: HeldJump | null = null;
    let latestId = 0;
    for (const [id, j] of mine) {
      latestId = id;
      if (!j.settled) { allSettled = false; continue; }
      lastClock = Math.max(lastClock, j.settled.clock);
      if (j.settled.ok) latestOk = j;
    }
    if (allSettled && tick > lastClock && (!latestOk || covered(latestOk, tick, agents, nowMs))) {
      jumps.delete(boxId);
      return;
    }
    // Otherwise each earlier jump on its own cover.
    for (const [id, j] of mine) if (id !== latestId && covered(j, tick, agents, nowMs)) mine.delete(id);
  };
  const add = (boxId: string, cover: Cover): number => {
    const id = ++nextJump;
    const mine = jumps.get(boxId) ?? new Map<number, HeldJump>();
    mine.set(id, { cover, settled: null });
    jumps.set(boxId, mine);
    return id;
  };
  return {
    begin: (boxId, pane) => add(boxId, { pane }),
    beginWindow: (boxId, session, windowId) => add(boxId, { session, windowId }),
    settle(boxId, jump, ok, nowMs) {
      const j = jumps.get(boxId)?.get(jump);
      if (j && !j.settled) j.settled = { clock, ok, at: nowMs };
    },
    cancel(boxId, jump) {
      const mine = jumps.get(boxId);
      if (!mine) return;
      mine.delete(jump);
      if (!mine.size) jumps.delete(boxId);
    },
    fetchStarted: () => ++clock,
    applied(boxId, tick, agentsOf, nowMs) {
      for (const id of boxId === null ? [...jumps.keys()] : [boxId]) release(id, tick, agentsOf(id), nowMs);
    },
    held: (boxId) => jumps.has(boxId),
  };
}
