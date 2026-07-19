import { test, expect } from 'vitest';
import { formatEvent, relTime, unseenCount, unseenCountFiltered } from '../src/web/healthEvents.ts';

const base = { seq: 1, boxId: 'b1', label: 'web-01', host: 'h1', t: 0 };

test('formatEvent phrases each kind with the right level', () => {
  expect(formatEvent({ ...base, kind: 'up' })).toMatchObject({ level: 'ok', text: 'web-01 — recovered' });
  expect(formatEvent({ ...base, kind: 'needs-auth' })).toMatchObject({ level: 'auth' });
  expect(formatEvent({ ...base, kind: 'down', reason: 'kex_exchange_identification' }))
    .toMatchObject({ level: 'crit', text: 'web-01 — unreachable (Port-22 rate-limited or banned (fail2ban?))' });
  expect(formatEvent({ ...base, kind: 'threshold', metric: 'disk', value: 92 }))
    .toMatchObject({ level: 'warn', text: 'web-01 — disk 92%' });
  expect(formatEvent({ ...base, kind: 'threshold-clear', metric: 'cpu', value: 40 }))
    .toMatchObject({ level: 'ok' });
});

test('relTime renders coarse buckets from an injected now', () => {
  expect(relTime(10_000, 12_000)).toBe('2s ago');
  expect(relTime(0, 120_000)).toBe('2m ago');
  expect(relTime(0, 3 * 3600_000)).toBe('3h ago');
});

test('unseenCount counts events past the last-seen seq', () => {
  const evs = [{ ...base, seq: 3 }, { ...base, seq: 2 }, { ...base, seq: 1 }];
  expect(unseenCount(evs, 1)).toBe(2);
  expect(unseenCount(evs, 3)).toBe(0);
});

test('formatEvent renders the agent kinds', () => {
  const input = formatEvent({ ...base, kind: 'agent-input' });
  expect(input.text).toContain('waiting for input');
  expect(input.level).toBe('warn');
  const done = formatEvent({ ...base, kind: 'agent-done' });
  expect(done.text).toContain('finished');
  expect(done.level).toBe('ok');
});

test('an unknown event kind from a newer server renders a generic line instead of breaking the panel', () => {
  const line = formatEvent({ ...base, kind: 'future-kind' });
  expect(line).toBeTruthy();
  expect(line.text).toContain('web-01');
  expect(['ok', 'warn', 'crit', 'auth']).toContain(line.level);
});

test('unseenCountFiltered counts only enabled kinds newer than the cursor', () => {
  const evs = [
    { ...base, seq: 5, kind: 'down' },
    { ...base, seq: 6, kind: 'up' },
    { ...base, seq: 7, kind: 'agent-input' },
  ];
  const enabled = new Set(['down', 'agent-input']);
  expect(unseenCountFiltered(evs, 4, enabled)).toBe(2); // down + agent-input, up excluded
  expect(unseenCountFiltered(evs, 6, enabled)).toBe(1); // only seq 7
});

// notificationsToFire: the pure decision behind browser-notification delivery.
// Regression for the v1.9.0 focused-consumption bug — an event that first
// arrived while the dashboard tab was focused was consumed by that poll's
// cursor advance and could never fire once the user tabbed away.
test('an event seen only while focused-but-unviewed stays pending and fires after tabbing away', async () => {
  const { notificationsToFire } = await import('../src/web/healthEvents.ts');
  const enabled = new Set(['agent-input']);
  const ev = [{ ...base, seq: 10, kind: 'agent-input' }];
  // focused poll: no fire, and the unseen event is NOT consumed (cursor stays at 9)
  const focused = notificationsToFire({ events: ev, latestSeq: 10, lastNotifiedSeq: 9, lastSeenSeq: 9, focused: true, permissionGranted: true, enabled });
  expect(focused.fire).toEqual([]);
  expect(focused.nextCursor).toBe(9);
  // next poll, tab now unfocused: the still-pending event fires
  const away = notificationsToFire({ events: ev, latestSeq: 10, lastNotifiedSeq: focused.nextCursor, lastSeenSeq: 9, focused: false, permissionGranted: true, enabled });
  expect(away.fire.map((e) => e.seq)).toEqual([10]);
  expect(away.nextCursor).toBe(10);
});

test('a focused event the user has already viewed (opened the panel) is consumed and never re-notifies', async () => {
  const { notificationsToFire } = await import('../src/web/healthEvents.ts');
  const enabled = new Set(['agent-input']);
  const ev = [{ ...base, seq: 10, kind: 'agent-input' }];
  const seen = notificationsToFire({ events: ev, latestSeq: 10, lastNotifiedSeq: 9, lastSeenSeq: 10, focused: true, permissionGranted: true, enabled });
  expect(seen.nextCursor).toBe(10); // seen → consumed
  const away = notificationsToFire({ events: ev, latestSeq: 10, lastNotifiedSeq: 10, lastSeenSeq: 10, focused: false, permissionGranted: true, enabled });
  expect(away.fire).toEqual([]);
});

test('unfocused + granted fires new ENABLED events only and advances to latest', async () => {
  const { notificationsToFire } = await import('../src/web/healthEvents.ts');
  const enabled = new Set(['agent-input', 'down']);
  const ev = [{ ...base, seq: 12, kind: 'down' }, { ...base, seq: 11, kind: 'up' }, { ...base, seq: 10, kind: 'agent-input' }];
  const r = notificationsToFire({ events: ev, latestSeq: 12, lastNotifiedSeq: 9, lastSeenSeq: 9, focused: false, permissionGranted: true, enabled });
  expect(r.fire.map((e) => e.seq).sort((a, b) => a - b)).toEqual([10, 12]); // 'up' (11) not enabled
  expect(r.nextCursor).toBe(12);
});

test('no permission never fires but tracks seen so a later grant does not replay viewed events', async () => {
  const { notificationsToFire } = await import('../src/web/healthEvents.ts');
  const enabled = new Set(['agent-input']);
  const ev = [{ ...base, seq: 10, kind: 'agent-input' }];
  const denied = notificationsToFire({ events: ev, latestSeq: 10, lastNotifiedSeq: 9, lastSeenSeq: 10, focused: false, permissionGranted: false, enabled });
  expect(denied.fire).toEqual([]);
  expect(denied.nextCursor).toBe(10);
});
