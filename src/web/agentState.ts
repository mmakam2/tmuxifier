// Pure helpers for the four-state agent model (working / blocked / done /
// idle). The server ships `agents: { [paneId]: AgentEntry }` on every health
// sample: the unit of agent state is the tmux PANE, not the session. Every
// client surface (sidebar rows, pane chip, picker rows, standby board, agent
// switcher) folds that map through here so they cannot disagree about
// precedence or about what a row is called. No DOM access: this half is
// unit-tested in node.
//
// Naming rule (one definition per runtime, pinned equal by test/agentNaming.test.js
// and the MCP server's copy): a row is named for its window,
// `<windowIndex>:<windowName>` (`window` when the name is empty); `.<paneIndex>` is
// appended only when the box has more than one agent ENTRY, with or without a
// state, in that session and window; `<session> › ` is prefixed only when the
// box's agent entries, with or without a state, span more than one session.
// Rows are ordered by session (plain string compare), window index, pane index.
// Counting stateless entries keeps a name from changing when a neighbouring
// pane's marker appears or goes. An event's place is `<session> › <window>`,
// plus `.<paneIndex>` when the server sent one.
import type { AgentState, AgentCause, AgentEntry, AgentKind, Sample } from './api';

// The single precedence list, worst (most attention-demanding) first. A box
// with one blocked and one working session reads blocked.
export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', opencode: 'OpenCode', codex: 'Codex', pi: 'pi', agy: 'Antigravity' };
export const AGENT_PRECEDENCE: AgentState[] = ['blocked', 'done', 'working', 'idle'];

const rank = (s: AgentState): number => AGENT_PRECEDENCE.indexOf(s);

// Only the NEWEST sample counts: an older sample's agents are history.
export function latestAgents(samples: Sample[] | undefined): Record<string, AgentEntry> {
  const last = samples && samples.length ? samples[samples.length - 1] : undefined;
  return last?.agents ?? {};
}

export function agentChipText(state: AgentState, cause?: AgentCause): string {
  return state === 'blocked' && cause ? `blocked · ${cause}` : state;
}

// Agent panes per state across every series (boxes and the Host Shell).
export function agentCounts(series: Record<string, Sample[]>): Record<AgentState, number> {
  const out: Record<AgentState, number> = { blocked: 0, done: 0, working: 0, idle: 0 };
  for (const samples of Object.values(series)) {
    for (const e of Object.values(latestAgents(samples))) if (e?.state) out[e.state]++;
  }
  return out;
}

export interface AgentCard { boxId: string; label: string; pane: string; session: string; windowId: string; name: string; state: AgentState; cause?: AgentCause; ts: number }

const LOCAL_SERIES_KEY = '__local__';

// One card per stateful agent pane, grouped by state, newest first in a column.
// `name` is the pane's row name, so the board and the sidebar agree.
// Series for boxes that no longer exist are skipped.
export function agentCards(boxes: { id: string; label: string }[], series: Record<string, Sample[]>): Record<AgentState, AgentCard[]> {
  const out: Record<AgentState, AgentCard[]> = { blocked: [], done: [], working: [], idle: [] };
  const labels = new Map(boxes.map((b) => [b.id, b.label]));
  for (const [boxId, samples] of Object.entries(series)) {
    const label = boxId === LOCAL_SERIES_KEY ? 'Host Shell' : labels.get(boxId);
    if (label === undefined) continue;
    for (const r of agentRows(latestAgents(samples))) {
      const card: AgentCard = { boxId, label, pane: r.pane, session: r.session, windowId: r.windowId, name: r.name, state: r.state, ts: r.ts };
      if (r.cause) card.cause = r.cause;
      out[r.state].push(card);
    }
  }
  for (const col of Object.values(out)) col.sort((a, b) => b.ts - a.ts);
  return out;
}

// One row of a box's agent list: a pane with a state, named by the rule in this
// file's header.
export interface AgentRow {
  pane: string; session: string; windowId: string; name: string;
  state: AgentState; cause?: AgentCause; agent: AgentKind; ts: number;
  visible: boolean; focused: boolean;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The box's agent rows: named, ordered, stateful only. The naming counts every
// entry (a pane that has no marker yet still shares its window and its session),
// the rows are only the ones that have a state. null and non-object entries drop.
export function agentRows(agents: Record<string, AgentEntry> | undefined): AgentRow[] {
  const entries: [string, AgentEntry][] = [];
  const perWindow = new Map<string, Map<string, number>>();
  for (const [pane, e] of Object.entries(agents ?? {})) {
    if (!e || typeof e !== 'object') continue;
    entries.push([pane, e]);
    const windows = perWindow.get(e.session) ?? new Map<string, number>();
    windows.set(e.windowId, (windows.get(e.windowId) ?? 0) + 1);
    perWindow.set(e.session, windows);
  }
  const acrossSessions = perWindow.size > 1;
  const rows: { row: AgentRow; windowIndex: number; paneIndex: number }[] = [];
  for (const [pane, e] of entries) {
    if (!e.state) continue;
    let name = `${e.windowIndex}:${e.windowName || 'window'}`;
    if ((perWindow.get(e.session)?.get(e.windowId) ?? 0) > 1) name += `.${e.paneIndex}`;
    if (acrossSessions) name = `${e.session} › ${name}`;
    const row: AgentRow = { pane, session: e.session, windowId: e.windowId, name, state: e.state, agent: e.agent, ts: e.ts ?? 0, visible: e.visible, focused: e.focused };
    if (e.cause) row.cause = e.cause;
    rows.push({ row, windowIndex: e.windowIndex, paneIndex: e.paneIndex });
  }
  rows.sort((a, b) => cmp(a.row.session, b.row.session) || a.windowIndex - b.windowIndex || a.paneIndex - b.paneIndex);
  return rows.map((r) => r.row);
}

// The worst state among `entries` (precedence above), the cause that goes with
// it, and how many of them have a state at all; null when none has one. Takes any
// iterable, so `Object.values(agents)` and `sessionAgents(...)` both fit.
export function worstOf(entries: Iterable<{ state?: AgentState; cause?: AgentCause }>): { state: AgentState; cause?: AgentCause; count: number } | null {
  let worst: { state: AgentState; cause?: AgentCause } | null = null;
  let count = 0;
  for (const e of entries) {
    if (!e?.state) continue;
    count++;
    if (!worst || rank(e.state) < rank(worst.state)) worst = e.cause ? { state: e.state, cause: e.cause } : { state: e.state };
  }
  return worst ? { ...worst, count } : null;
}

// Entries of one session (stateless ones too: the caller decides what counts),
// in window and pane order.
export function sessionAgents(agents: Record<string, AgentEntry> | undefined, session: string): AgentEntry[] {
  return Object.values(agents ?? {})
    .filter((e) => e?.session === session)
    .sort((a, b) => a.windowIndex - b.windowIndex || a.paneIndex - b.paneIndex);
}

// Entries of one window of one session; the window id alone is not enough, a
// grouped session shares its windows.
export function windowAgents(agents: Record<string, AgentEntry> | undefined, session: string, windowId: string): AgentEntry[] {
  return sessionAgents(agents, session).filter((e) => e.windowId === windowId);
}

// The done panes of `session` that are on its screen: the ones whose acknowledgement
// a focused client may post. Whether a client is looking is the caller's rule.
export function visibleDone(agents: Record<string, AgentEntry> | undefined, session: string): { pane: string; ts: number }[] {
  const out: { pane: string; ts: number }[] = [];
  for (const [pane, e] of Object.entries(agents ?? {})) {
    if (e?.session === session && e.state === 'done' && e.visible) out.push({ pane, ts: e.ts ?? 0 });
  }
  return out;
}

// Where an agent event happened, in the words of a row: `main › 2:frontend.1`.
// Whatever the server did not send is left out.
export function eventPlace(e: { session?: string; window?: string; paneIndex?: number }): string {
  const win = e.window ? (typeof e.paneIndex === 'number' ? `${e.window}.${e.paneIndex}` : e.window) : '';
  return [e.session, win].filter(Boolean).join(' › ');
}

// Compact age: '<1m', '4m', '2h', '3d'.
export function fmtAge(fromEpochSec: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor(nowMs / 1000 - fromEpochSec));
  if (sec < 60) return '<1m';
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
