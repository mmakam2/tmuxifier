import type { HealthEvent, HealthEventKind } from './api';
import { classifyError } from './statusDot';

// Pure formatting for the in-app Events panel. Levels reuse the meta-line tiers
// (statusDot.ts): 'auth' is the purple needs-login tier, not a severity, so a
// re-login reads as an action to take rather than an outage.
export type EventLevel = 'ok' | 'warn' | 'crit' | 'auth';
export interface EventLine { icon: string; text: string; level: EventLevel; }

const METRIC_LABEL = { cpu: 'CPU', mem: 'memory', disk: 'disk' } as const;
const METRIC_ICON = { cpu: '🔥', mem: '🧠', disk: '💾' } as const;

// Decide which events should raise a browser notification this poll, and where
// the notification cursor should advance to. Pure so the delivery semantics are
// unit-tested without a DOM.
//
// The rule: browser notifications fire only from an unfocused tab with
// permission — a focused tab already shows the badge. But a focused poll must
// NOT consume an event the user has not actually viewed: doing so (the v1.9.0
// bug) meant a "waiting for input" transition that happened in the ~30s before
// you tabbed away was burned, and switching away never notified you. So while
// focused (or without permission) the cursor advances only past what the user
// has SEEN (lastSeenSeq — the events panel marks events seen), leaving
// arrived-while-focused-but-unviewed events pending to fire the moment the tab
// loses focus.
export function notificationsToFire(opts: {
  events: HealthEvent[];
  latestSeq: number;
  lastNotifiedSeq: number;
  lastSeenSeq: number;
  focused: boolean;
  permissionGranted: boolean;
  enabled: Set<HealthEventKind>;
}): { fire: HealthEvent[]; nextCursor: number } {
  const { events, latestSeq, lastNotifiedSeq, lastSeenSeq, focused, permissionGranted, enabled } = opts;
  if (permissionGranted && !focused) {
    const fire = events.filter((e) => e.seq > lastNotifiedSeq && enabled.has(e.kind));
    return { fire, nextCursor: latestSeq };
  }
  return { fire: [], nextCursor: Math.max(lastNotifiedSeq, lastSeenSeq) };
}

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
    case 'agent-input': return { icon: '⌨️', text: `${name} — claude is waiting for input`, level: 'warn' };
    case 'agent-done': return { icon: '🤖', text: `${name} — claude finished`, level: 'ok' };
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

export function unseenCountFiltered(events: HealthEvent[], lastSeenSeq: number, enabled: Set<HealthEventKind>): number {
  return events.reduce((c, e) => (e.seq > lastSeenSeq && enabled.has(e.kind) ? c + 1 : c), 0);
}
