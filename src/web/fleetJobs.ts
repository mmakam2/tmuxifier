import type { FleetJobSummary } from './api';
import { relTime } from './healthEvents';

// Pure view-model for the Fleet Jobs drawer.
//
// The drawer used to render every job — running and archived alike — as one
// flat list of `${okCount}/${targetCount} ok · ${status}` rows, where a job in
// flight was byte-identical to one that finished last week. The state an
// operator actually needs was present in the summary the whole time and simply
// wasn't shaped: `errorCount` was discarded, the three timestamps were never
// rendered, and `status` arrived as prose in the row's dimmest text.
//
// Everything here is pure so the shaping is unit-tested without a DOM (vitest
// runs `environment: 'node'`), in the mold of `healthEvents.ts` and the card
// modules' model halves.

/** LED for the row's lamp. Mirrors the `.dot` variants in style.css. */
export type FleetLamp = 'running' | 'ok' | 'error' | 'idle';

/** One figure in a row's readout line, tinted by what it reports. */
export type ReadoutTone = 'ok' | 'err' | 'run' | 'dim';
export interface ReadoutSegment { text: string; tone: ReadoutTone }

/**
 * Split the server's single newest-first list into the two things it actually
 * holds: processes you can still cancel, and records you read. They afford
 * nothing in common, and interleaving them by recency is what made a live job
 * indistinguishable from an archived one.
 *
 * Order within each section is preserved — the server's newest-first contract
 * is still the only ordering either section has.
 */
export function partitionJobs(jobs: FleetJobSummary[]): { active: FleetJobSummary[]; history: FleetJobSummary[] } {
  const active: FleetJobSummary[] = [];
  const history: FleetJobSummary[] = [];
  for (const j of jobs) (j.status === 'running' ? active : history).push(j);
  return { active, history };
}

export function runningCount(jobs: FleetJobSummary[]): number {
  let n = 0;
  for (const j of jobs) if (j.status === 'running') n += 1;
  return n;
}

/**
 * The row's primary state signal. `running` outranks a nonzero error count: a
 * job still going is a live process first and a partial failure second — the
 * errors are already named in the readout beside it.
 */
export function jobLamp(j: FleetJobSummary): FleetLamp {
  if (j.status === 'running') return 'running';
  if (j.errorCount > 0) return 'error';
  if (j.status === 'done') return 'ok';
  return 'idle'; // cancelled | interrupted — stopped without a verdict
}

/**
 * The readout line, in figures rather than prose.
 *
 * `okCount/targetCount` alone could not distinguish 3 ok + 9 failed from 3 ok
 * + 9 still pending; both rendered "3/12 ok". Naming the outstanding targets
 * separately from the failed ones is the whole point.
 */
export function jobReadout(j: FleetJobSummary): ReadoutSegment[] {
  const segs: ReadoutSegment[] = [{ text: `${j.okCount} OK`, tone: 'ok' }];
  if (j.errorCount > 0) segs.push({ text: `${j.errorCount} ERR`, tone: 'err' });
  if (j.status === 'running') {
    // Clamped: a summary that momentarily over-reports (a target counted in
    // two buckets mid-write) must not render "-1 RUN".
    const outstanding = Math.max(0, j.targetCount - j.okCount - j.errorCount);
    if (outstanding > 0) segs.push({ text: `${outstanding} RUN`, tone: 'run' });
  } else if (j.status !== 'done') {
    // No count can convey "stopped early" — cancelled and interrupted have to
    // say so themselves.
    segs.push({ text: j.status.toUpperCase(), tone: 'dim' });
  }
  return segs;
}

function stamp(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const ss = String(s % 60).padStart(2, '0');
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${ss}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${ss}`;
}

/**
 * A running job counts up; a settled one says how long ago it landed.
 *
 * The counting clock is load-bearing, not decoration: a number that visibly
 * moves is the cheapest possible proof the row is alive, and its absence is
 * exactly what made a frozen list read as finished.
 *
 * Returns '' rather than 'NaN' when the timestamp is missing or unparseable —
 * jobs persisted before a field existed must degrade to no clock, not garbage.
 */
export function jobClock(j: FleetJobSummary, now: number): string {
  if (j.status === 'running') {
    const started = stamp(j.startedAt) ?? stamp(j.createdAt);
    return started == null ? '' : elapsed(now - started);
  }
  const ended = stamp(j.finishedAt) ?? stamp(j.createdAt);
  return ended == null ? '' : relTime(ended, now);
}

/**
 * Whether a row can be left alone on this poll. The list updates in place so a
 * keyboard user's focus and the hovered row survive a refresh — rebuilding the
 * `<ul>` dropped focus to `<body>` every time a job settled.
 *
 * A running job always reports changed, because its clock ticks even when no
 * count has moved.
 */
export function sameJobShape(a: FleetJobSummary, b: FleetJobSummary): boolean {
  if (a.status === 'running' || b.status === 'running') return false;
  return a.id === b.id
    && a.status === b.status
    && a.okCount === b.okCount
    && a.errorCount === b.errorCount
    && a.targetCount === b.targetCount
    && (a.scriptName || '') === (b.scriptName || '')
    && a.command === b.command
    && a.finishedAt === b.finishedAt;
}
