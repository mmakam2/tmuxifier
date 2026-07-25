import { test, expect } from 'vitest';
import { severityRank, laneFor, reasonLabel, occurrenceSummary, relativeAge } from '../src/web/alertFormat.ts';

const alert = (over = {}) => ({
  key: 'check:c1', source: 'check:c1', severity: 'warning', state: 'firing',
  count: 1, recentCount: 1, firstTs: 0, lastTs: 0, title: 't', body: '', reason: null, ...over,
});

test('severity ranks so critical sorts above warning above info', () => {
  expect(severityRank('critical')).toBeGreaterThan(severityRank('warning'));
  expect(severityRank('warning')).toBeGreaterThan(severityRank('info'));
});

test('an unknown severity ranks lowest rather than throwing', () => {
  expect(severityRank('made-up')).toBe(0);
});

test('a resolved alert lands in no lane so it leaves the open list', () => {
  expect(laneFor(alert({ state: 'resolved' }))).toBeNull();
});

test('a firing alert lands in the lane matching its severity', () => {
  expect(laneFor(alert({ severity: 'critical' }))).toBe('critical');
});

test('every reason code has operator-facing text, including the failure case', () => {
  for (const code of ['notified', 'held:below-persistence', 'suppressed:cooldown',
    'suppressed:muted', 'skipped:info', 'skipped:resolved', 'notify:failed']) {
    expect(reasonLabel(code)).toBeTruthy();
    expect(reasonLabel(code)).not.toBe(code);
  }
});

test('an unrecognised reason falls back to the raw code rather than blank', () => {
  expect(reasonLabel('something:new')).toBe('something:new');
});

test('a null reason reads as not yet evaluated', () => {
  expect(reasonLabel(null)).toBe('not yet evaluated');
});

test('the occurrence summary collapses repeats into one readable line', () => {
  const s = occurrenceSummary(alert({ count: 47, firstTs: 1000, lastTs: 9000 }));
  expect(s).toContain('47');
});

test('a single occurrence does not say "1 occurrences"', () => {
  expect(occurrenceSummary(alert({ count: 1 }))).toContain('once');
});

test('sourceRows aggregates volume per source, busiest first', async () => {
  const { sourceRows } = await import('../src/web/alertFormat.ts');
  const rows = sourceRows([
    { source: 'check:a', ts: 10 }, { source: 'check:b', ts: 20 }, { source: 'check:a', ts: 30 },
  ]);
  expect(rows).toEqual([
    { source: 'check:a', count: 2, lastTs: 30 },
    { source: 'check:b', count: 1, lastTs: 20 },
  ]);
});

test('relative age renders seconds, minutes, hours, and days', () => {
  expect(relativeAge(0, 5000)).toBe('5s ago');
  expect(relativeAge(0, 120000)).toBe('2m ago');
  expect(relativeAge(0, 7200000)).toBe('2h ago');
  expect(relativeAge(0, 172800000)).toBe('2d ago');
});
