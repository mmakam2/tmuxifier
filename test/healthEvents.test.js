import { test, expect } from 'vitest';
import { formatEvent, relTime, unseenCount } from '../src/web/healthEvents.ts';

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
