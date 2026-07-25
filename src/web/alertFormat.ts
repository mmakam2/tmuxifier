export type Severity = 'critical' | 'warning' | 'info';

export interface Alert {
  key: string; source: string; severity: Severity; state: 'firing' | 'resolved';
  count: number; recentCount: number; firstTs: number | null; lastTs: number | null;
  title: string; body: string; reason: string | null;
}

const RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 };

export function severityRank(sev: string): number {
  return RANK[sev] ?? 0;
}

export function laneFor(alert: Alert): Severity | null {
  return alert.state === 'resolved' ? null : alert.severity;
}

// The reason a thing did or did not reach you is the trust surface: rendered on
// every row so "working quietly" is never mistaken for "broken".
const REASONS: Record<string, string> = {
  notified: 'sent',
  'held:below-persistence': 'waiting — not yet persistent or repeated enough',
  'suppressed:cooldown': 'already sent recently',
  'suppressed:muted': 'muted by you',
  'skipped:info': 'info only — never notifies',
  'skipped:resolved': 'resolved',
  'notify:failed': 'delivery failed',
};

export function reasonLabel(reason: string | null): string {
  if (reason === null || reason === undefined) return 'not yet evaluated';
  return REASONS[reason] ?? reason;
}

export function occurrenceSummary(alert: Alert): string {
  return alert.count === 1 ? 'seen once' : `seen ${alert.count} times`;
}

export function relativeAge(ms: number, nowMs: number): string {
  const d = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
