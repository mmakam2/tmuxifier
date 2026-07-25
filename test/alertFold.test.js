// test/alertFold.test.js
import { test, expect } from 'vitest';
import { foldEvents } from '../src/server/alertFold.js';

const ev = (over) => ({
  id: `${over.ts}-0`, via: 'check', source: 'check:a', key: 'check:a', norm: null,
  severity: 'warning', state: 'firing', title: 't', body: '', ...over,
});

test('repeated occurrences of one key collapse into a single alert with a count', () => {
  const [alert] = foldEvents([ev({ ts: 100 }), ev({ ts: 200 }), ev({ ts: 300 })], { nowMs: 300, windowMs: 1000 });
  expect(alert.count).toBe(3);
  expect(alert.firstTs).toBe(100);
  expect(alert.lastTs).toBe(300);
  expect(alert.state).toBe('firing');
});

test('the newest occurrence supplies the alert title and severity', () => {
  const [alert] = foldEvents(
    [ev({ ts: 100, title: 'old', severity: 'warning' }), ev({ ts: 200, title: 'new', severity: 'critical' })],
    { nowMs: 200, windowMs: 1000 },
  );
  expect(alert.title).toBe('new');
  expect(alert.severity).toBe('critical');
});

test('a resolved event closes the alert and restarts the count', () => {
  const [alert] = foldEvents(
    [ev({ ts: 100 }), ev({ ts: 200, state: 'resolved' }), ev({ ts: 300 })],
    { nowMs: 300, windowMs: 1000 },
  );
  expect(alert.state).toBe('firing');
  expect(alert.count).toBe(1);      // the pre-resolution occurrences do not carry over
  expect(alert.firstTs).toBe(300);
});

test('an alert whose last event is a resolution reports state resolved', () => {
  const [alert] = foldEvents([ev({ ts: 100 }), ev({ ts: 200, state: 'resolved' })], { nowMs: 200, windowMs: 1000 });
  expect(alert.state).toBe('resolved');
  expect(alert.count).toBe(0);
});

test('recentCount counts only occurrences inside the window', () => {
  const [alert] = foldEvents([ev({ ts: 100 }), ev({ ts: 9000 }), ev({ ts: 9500 })], { nowMs: 10000, windowMs: 2000 });
  expect(alert.count).toBe(3);
  expect(alert.recentCount).toBe(2);
});

test('distinct keys stay distinct and sort newest-activity first', () => {
  const got = foldEvents(
    [ev({ ts: 100, key: 'check:a' }), ev({ ts: 500, key: 'check:b' })],
    { nowMs: 500, windowMs: 1000 },
  );
  expect(got.map((a) => a.key)).toEqual(['check:b', 'check:a']);
});
