// Pure list model for the agent switcher: one row per tmux session that has an
// agent state, a most-recently-used order, and highlight stepping. No DOM; the
// switcher UI consumes it.
import type { AgentCause, AgentKind, AgentState, Sample } from './api';
import { AGENT_PRECEDENCE, latestAgents } from './agentState';

export const LOCAL_BOX = '__local__';
export const LOCAL_SESSION = 'local';
export const MRU_STORAGE_KEY = 'tmuxifier.agentMru';
export const MRU_CAP = 100;

// A newline cannot occur in a box id or a session name, so keys never collide.
export const rowKey = (boxId: string, session: string): string => `${boxId}\n${session}`;

export interface SwitcherRow {
  key: string;
  boxId: string;
  label: string;
  session: string;
  state: AgentState;
  cause?: AgentCause;
  agent?: AgentKind;
  ts: number;
  here: boolean;
  gone: boolean;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const rank = (s: AgentState): number => AGENT_PRECEDENCE.indexOf(s);

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
    for (const [session, e] of Object.entries(latestAgents(samples))) {
      if (!e?.state) continue;
      if (boxId === LOCAL_BOX && session !== LOCAL_SESSION) continue;
      const row: SwitcherRow = {
        key: rowKey(boxId, session), boxId, label, session, state: e.state, ts: e.ts ?? 0,
        here: !!i.focused && i.focused.boxId === boxId && i.focused.session === session,
        gone: false,
      };
      if (e.cause) row.cause = e.cause;
      if (e.agent) row.agent = e.agent;
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
    return rank(a.state) - rank(b.state) || b.ts - a.ts || cmp(a.label, b.label) || cmp(a.session, b.session);
  });
  return rows;
}

// Same order and length as `frozen`; values refresh from the newest samples.
export function liveRows(frozen: SwitcherRow[], series: Record<string, Sample[]>): SwitcherRow[] {
  return frozen.map((r) => {
    const e = latestAgents(series[r.boxId])[r.session];
    if (!e?.state) return { ...r, gone: true };
    const next: SwitcherRow = { ...r, state: e.state, ts: e.ts ?? 0, gone: false };
    delete next.cause;
    delete next.agent;
    if (e.cause) next.cause = e.cause;
    if (e.agent) next.agent = e.agent;
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
