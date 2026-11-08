// Pure helpers for the four-state agent model (working / blocked / done /
// idle). The server ships `agents: { [session]: AgentEntry }` on every health
// sample; every client surface (pane chip, session rows, sidebar badge, the
// standby strip) folds that map through here so they cannot disagree about
// precedence. No DOM access: this half is unit-tested in node.
import type { AgentState, AgentCause, AgentEntry, AgentKind, Sample } from './api';

// The single precedence list, worst (most attention-demanding) first. A box
// with one blocked and one working session reads blocked.
export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', opencode: 'OpenCode', codex: 'Codex', pi: 'pi' };
export const AGENT_PRECEDENCE: AgentState[] = ['blocked', 'done', 'working', 'idle'];

const rank = (s: AgentState): number => AGENT_PRECEDENCE.indexOf(s);

// Only the NEWEST sample counts: an older sample's agents are history.
export function latestAgents(samples: Sample[] | undefined): Record<string, AgentEntry> {
  const last = samples && samples.length ? samples[samples.length - 1] : undefined;
  return last?.agents ?? {};
}

export interface WorstAgent {
  state: AgentState;
  count: number;
  sessions: { session: string; state: AgentState; cause?: AgentCause }[];
}

// Fold a box's sessions to its worst state. Sessions without a state (a claude
// pane with no hook marker) do not count; null when none has one.
export function worstAgent(agents: Record<string, AgentEntry> | undefined): WorstAgent | null {
  const sessions: WorstAgent['sessions'] = [];
  for (const [session, e] of Object.entries(agents ?? {})) {
    if (!e?.state) continue;
    sessions.push(e.cause ? { session, state: e.state, cause: e.cause } : { session, state: e.state });
  }
  if (!sessions.length) return null;
  sessions.sort((a, b) => rank(a.state) - rank(b.state) || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
  return { state: sessions[0].state, count: sessions.length, sessions };
}

export function agentChipText(state: AgentState, cause?: AgentCause): string {
  return state === 'blocked' && cause ? `blocked · ${cause}` : state;
}

// Sessions per state across every series (boxes and the Host Shell).
export function agentCounts(series: Record<string, Sample[]>): Record<AgentState, number> {
  const out: Record<AgentState, number> = { blocked: 0, done: 0, working: 0, idle: 0 };
  for (const samples of Object.values(series)) {
    for (const e of Object.values(latestAgents(samples))) if (e?.state) out[e.state]++;
  }
  return out;
}

export interface AgentCard { boxId: string; label: string; session: string; state: AgentState; cause?: AgentCause; ts: number }

const LOCAL_SERIES_KEY = '__local__';

// One card per stateful session, grouped by state, newest first in a column.
// Series for boxes that no longer exist are skipped.
export function agentCards(boxes: { id: string; label: string }[], series: Record<string, Sample[]>): Record<AgentState, AgentCard[]> {
  const out: Record<AgentState, AgentCard[]> = { blocked: [], done: [], working: [], idle: [] };
  const labels = new Map(boxes.map((b) => [b.id, b.label]));
  for (const [boxId, samples] of Object.entries(series)) {
    const label = boxId === LOCAL_SERIES_KEY ? 'Host Shell' : labels.get(boxId);
    if (label === undefined) continue;
    for (const [session, e] of Object.entries(latestAgents(samples))) {
      if (!e?.state) continue;
      const card: AgentCard = { boxId, label, session, state: e.state, ts: e.ts ?? 0 };
      if (e.cause) card.cause = e.cause;
      out[e.state].push(card);
    }
  }
  for (const col of Object.values(out)) col.sort((a, b) => b.ts - a.ts);
  return out;
}

// Compact age: '<1m', '4m', '2h', '3d'.
export function fmtAge(fromEpochSec: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor(nowMs / 1000 - fromEpochSec));
  if (sec < 60) return '<1m';
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
