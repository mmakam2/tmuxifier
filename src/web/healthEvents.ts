import type { HealthEvent } from './api';
import { classifyError } from './statusDot';

// Pure formatting for the in-app Events panel. Levels reuse the meta-line tiers
// (statusDot.ts): 'auth' is the purple needs-login tier, not a severity, so a
// re-login reads as an action to take rather than an outage.
export type EventLevel = 'ok' | 'warn' | 'crit' | 'auth';
export interface EventLine { icon: string; text: string; level: EventLevel; }

const METRIC_LABEL = { cpu: 'CPU', mem: 'memory', disk: 'disk' } as const;
const METRIC_ICON = { cpu: '🔥', mem: '🧠', disk: '💾' } as const;

export function formatEvent(e: HealthEvent): EventLine {
  const name = e.label || e.host;
  switch (e.kind) {
    case 'up': return { icon: '🟢', text: `${name} — recovered`, level: 'ok' };
    case 'needs-auth': return { icon: '🟣', text: `${name} — needs login`, level: 'auth' };
    case 'key-changed': return { icon: '🔑', text: `${name} — host key changed (rebuilt? use ⚷ to forget)`, level: 'crit' };
    case 'down': {
      const reason = classifyError(e.reason);
      const suffix = reason && reason !== 'Unreachable' ? ` (${reason})` : '';
      return { icon: '🔴', text: `${name} — unreachable${suffix}`, level: 'crit' };
    }
    case 'threshold':
      return { icon: METRIC_ICON[e.metric!], text: `${name} — ${METRIC_LABEL[e.metric!]} ${e.value}%`, level: 'warn' };
    case 'threshold-clear':
      return { icon: '✅', text: `${name} — ${METRIC_LABEL[e.metric!]} back to ${e.value}%`, level: 'ok' };
    default:
      // A newer server may ship event kinds this bundle doesn't know yet — one
      // unknown kind must degrade to a generic line, not brick the panel.
      return { icon: 'ℹ️', text: `${name} — ${String((e as HealthEvent).kind)}`, level: 'warn' };
  }
}

export function relTime(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function unseenCount(events: HealthEvent[], lastSeenSeq: number): number {
  return events.reduce((c, e) => (e.seq > lastSeenSeq ? c + 1 : c), 0);
}
