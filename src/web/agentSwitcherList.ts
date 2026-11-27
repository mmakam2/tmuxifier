// Pure list model for the agent switcher: one row per tmux PANE that has an
// agent state (spec 2026-11-26 §7.2), named as the sidebar names it
// (agentState.ts agentRows), a most-recently-used order, and highlight stepping.
// No DOM; the switcher UI consumes it.
//
// Rows and the MRU are keyed by box and pane id. A stored MRU from before holds
// `box\nsession` keys: they never match a row and are left to age out, never
// migrated. The Host Shell lists only the entries of its own session, `local`,
// the rule agentJump.ts sidebarAgents keeps for the sidebar (restated here, not
// imported: agentJump.ts imports this module). Pane maps are keyed by box
// output, so they are read own-property only.
import type { AgentCause, AgentEntry, AgentKind, AgentState, Sample } from './api';
import { AGENT_PRECEDENCE, agentRows, latestAgents } from './agentState';

export const LOCAL_BOX = '__local__';
export const LOCAL_SESSION = 'local';
export const MRU_STORAGE_KEY = 'tmuxifier.agentMru';
export const MRU_CAP = 100;

// A newline cannot occur in a box id or a pane id, so keys never collide.
export const rowKey = (boxId: string, pane: string): string => `${boxId}\n${pane}`;

export interface SwitcherRow {
  key: string;
  boxId: string;
  label: string;
  pane: string;
  session: string;
  windowId: string;
  name: string;
  state: AgentState;
  cause?: AgentCause;
  agent?: AgentKind;
  ts: number;
  here: boolean;
  gone: boolean;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const rank = (s: AgentState): number => AGENT_PRECEDENCE.indexOf(s);

// The box's pane map as the switcher may list it: own entries only, and for the
// Host Shell only those of the `local` session. Null-prototype.
function listable(boxId: string, agents: Record<string, AgentEntry> | undefined): Record<string, AgentEntry> {
  const out: Record<string, AgentEntry> = Object.create(null);
  for (const [pane, e] of Object.entries(agents ?? {})) {
    if (boxId === LOCAL_BOX && e?.session !== LOCAL_SESSION) continue;
    out[pane] = e;
  }
  return out;
}

// The MRU key of the agent pane tmux has focused in `session` (the pane the
// operator is looking at in a terminal on that session), or null when none of
// the session's agent panes is focused.
export function focusedAgentKey(boxId: string, agents: Record<string, AgentEntry> | undefined, session: string): string | null {
  for (const [pane, e] of Object.entries(listable(boxId, agents))) {
    if (e?.session === session && e.focused === true) return rowKey(boxId, pane);
  }
  return null;
}

export function switcherRows(i: {
  boxes: { id: string; label: string }[];
  series: Record<string, Sample[]>;
  mru: string[];
  focused: { boxId: string; session: string } | null;
}): SwitcherRow[] {
  const labels = new Map(i.boxes.map((b) => [b.id, b.label]));
  const rows: SwitcherRow[] = [];
  for (const [boxId, samples] of Object.entries(i.series)) {
    const label = boxId === LOCAL_BOX ? 'Host Shell' : labels.get(boxId);
    if (label === undefined) continue;
    if (!samples.length || samples[samples.length - 1].up !== true) continue;
    for (const a of agentRows(listable(boxId, latestAgents(samples)))) {
      const row: SwitcherRow = {
        key: rowKey(boxId, a.pane), boxId, label, pane: a.pane, session: a.session, windowId: a.windowId,
        name: a.name, state: a.state, agent: a.agent, ts: a.ts,
        here: !!i.focused && i.focused.boxId === boxId && i.focused.session === a.session && a.focused,
        gone: false,
      };
      if (a.cause) row.cause = a.cause;
      rows.push(row);
    }
  }
  const mruIndex = new Map<string, number>();
  i.mru.forEach((k, n) => { if (!mruIndex.has(k)) mruIndex.set(k, n); });
  const group = (r: SwitcherRow): number => (r.here ? 0 : mruIndex.has(r.key) ? 1 : 2);
  rows.sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga === 1) return mruIndex.get(a.key)! - mruIndex.get(b.key)!;
    return rank(a.state) - rank(b.state) || b.ts - a.ts || cmp(a.label, b.label) || cmp(a.name, b.name) || cmp(a.pane, b.pane);
  });
  return rows;
}

// Same order and length as `frozen`; values refresh from the newest samples,
// the pane's place (session, window, name) included: a pane id outlives a move.
// A row whose pane left the map, or has no state any more, is `gone` and keeps
// its last values.
export function liveRows(frozen: SwitcherRow[], series: Record<string, Sample[]>): SwitcherRow[] {
  const byBox = new Map<string, Map<string, ReturnType<typeof agentRows>[number]>>();
  const rowsOf = (boxId: string) => {
    let m = byBox.get(boxId);
    if (!m) {
      const samples = Object.hasOwn(series, boxId) ? series[boxId] : undefined;
      m = new Map(agentRows(listable(boxId, latestAgents(samples))).map((a) => [a.pane, a]));
      byBox.set(boxId, m);
    }
    return m;
  };
  return frozen.map((r) => {
    const a = rowsOf(r.boxId).get(r.pane);
    if (!a) return { ...r, gone: true };
    const next: SwitcherRow = { ...r, session: a.session, windowId: a.windowId, name: a.name, state: a.state, agent: a.agent, ts: a.ts, gone: false };
    delete next.cause;
    if (a.cause) next.cause = a.cause;
    return next;
  });
}

export function initialIndex(rows: SwitcherRow[]): number {
  return rows.findIndex((r) => !r.here);
}

export function stepIndex(index: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  return (((index + delta) % count) + count) % count;
}

export function bumpMru(mru: string[], key: string, cap: number = MRU_CAP): string[] {
  return [key, ...mru.filter((k) => k !== key)].slice(0, cap);
}

export function parseMru(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((k): k is string => typeof k === 'string').slice(0, MRU_CAP);
  } catch {
    return [];
  }
}
