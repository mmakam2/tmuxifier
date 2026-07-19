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
