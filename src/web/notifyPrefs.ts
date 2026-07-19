import type { HealthEventKind } from './api';

// Per-kind browser-notification preferences. Per-browser by design: the
// Notification permission is per-browser, so the filter that rides on it is
// too. Every event still enters the events log regardless of these — prefs
// govern only the events-button counter and browser notifications.
const KEY = 'tmuxifier.notifyPrefs';

export const NOTIFY_KINDS: { kind: HealthEventKind; label: string }[] = [
  { kind: 'agent-input', label: 'Claude waiting for input' },
  { kind: 'agent-done', label: 'Claude finished' },
  { kind: 'down', label: 'Box unreachable' },
  { kind: 'up', label: 'Box recovered' },
  { kind: 'needs-auth', label: 'Box needs login' },
  { kind: 'key-changed', label: 'Host key changed' },
  { kind: 'threshold', label: 'Resource threshold crossed' },
  { kind: 'threshold-clear', label: 'Resource threshold cleared' },
];

// Recovery kinds are noise by default; everything actionable is on.
const OFF_BY_DEFAULT: HealthEventKind[] = ['up', 'threshold-clear'];

export function defaultNotifyPrefs(): Record<HealthEventKind, boolean> {
  const out = {} as Record<HealthEventKind, boolean>;
  for (const { kind } of NOTIFY_KINDS) out[kind] = !OFF_BY_DEFAULT.includes(kind);
  return out;
}

export function loadNotifyPrefs(): Record<HealthEventKind, boolean> {
  const base = defaultNotifyPrefs();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== 'object') return base;
    // Merge over defaults so a kind added in a later version defaults on.
    for (const { kind } of NOTIFY_KINDS) if (typeof stored[kind] === 'boolean') base[kind] = stored[kind];
    return base;
  } catch {
    return base;
  }
}

export function saveNotifyPrefs(prefs: Record<HealthEventKind, boolean>): void {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode / quota — in-memory only */ }
}

export function enabledKinds(prefs: Record<HealthEventKind, boolean>): Set<HealthEventKind> {
  return new Set(NOTIFY_KINDS.map((k) => k.kind).filter((k) => prefs[k]));
}
