// test/alertPolicy.test.js
import { test, expect } from 'vitest';
import { decideAlert, DEFAULT_THRESHOLDS } from '../src/server/alertPolicy.js';

const alert = (over) => ({
  key: 'check:a', source: 'check:a', severity: 'warning', state: 'firing',
  count: 1, recentCount: 1, firstTs: 0, lastTs: 0, title: 't', body: '', ...over,
});
const decide = (over, extra = {}) =>
  decideAlert({ alert: alert(over), rules: { mutes: [], overrides: {} }, nowMs: 0, lastNotifiedAt: null, ...extra });

test('critical notifies on the first occurrence', () => {
  expect(decide({ severity: 'critical' })).toEqual({ notify: true, reason: 'notified' });
});

test('info never notifies', () => {
  expect(decide({ severity: 'info' })).toEqual({ notify: false, reason: 'skipped:info' });
});

test('a resolved alert never notifies', () => {
  expect(decide({ severity: 'critical', state: 'resolved' })).toEqual({ notify: false, reason: 'skipped:resolved' });
});

test('a muted key is silent even at critical severity', () => {
  const got = decideAlert({
    alert: alert({ severity: 'critical' }), rules: { mutes: ['check:a'], overrides: {} },
    nowMs: 0, lastNotifiedAt: null,
  });
  expect(got).toEqual({ notify: false, reason: 'suppressed:muted' });
});

test('a muted source silences every key from it', () => {
  const got = decideAlert({
    alert: alert({ severity: 'critical', key: 'check:a', source: 'udm' }),
    rules: { mutes: ['udm'], overrides: {} }, nowMs: 0, lastNotifiedAt: null,
  });
  expect(got.reason).toBe('suppressed:muted');
});

test('a warning below both gates is held, not dropped', () => {
  expect(decide({ count: 1, recentCount: 1, firstTs: 0 }, { nowMs: 60000 }))
    .toEqual({ notify: false, reason: 'held:below-persistence' });
});

test('a warning firing longer than the persistence gate notifies', () => {
  expect(decide({ firstTs: 0 }, { nowMs: DEFAULT_THRESHOLDS.warnPersistMs }))
    .toEqual({ notify: true, reason: 'notified' });
});

test('a warning repeating enough times inside the window notifies before the time gate', () => {
  expect(decide({ recentCount: 3, firstTs: 0 }, { nowMs: 1000 }))
    .toEqual({ notify: true, reason: 'notified' });
});

test('a per-key failuresBeforeNotify override replaces the repeat threshold', () => {
  const got = decideAlert({
    alert: alert({ recentCount: 2, firstTs: 0 }),
    rules: { mutes: [], overrides: { 'check:a': { failuresBeforeNotify: 2 } } },
    nowMs: 1000, lastNotifiedAt: null,
  });
  expect(got).toEqual({ notify: true, reason: 'notified' });
});

test('re-notify suppression holds a still-firing alert inside the cooldown', () => {
  expect(decide({ severity: 'critical' }, { nowMs: 3600000, lastNotifiedAt: 0 }))
    .toEqual({ notify: false, reason: 'suppressed:cooldown' });
});

test('once the cooldown elapses a still-firing alert notifies again', () => {
  expect(decide({ severity: 'critical' }, { nowMs: DEFAULT_THRESHOLDS.cooldownMs, lastNotifiedAt: 0 }))
    .toEqual({ notify: true, reason: 'notified' });
});

test('mute outranks cooldown so the reason reported is the operator decision', () => {
  const got = decideAlert({
    alert: alert({ severity: 'critical' }), rules: { mutes: ['check:a'], overrides: {} },
    nowMs: 10, lastNotifiedAt: 0,
  });
  expect(got.reason).toBe('suppressed:muted');
});

// --- Additional tests closing gaps left by the brief's 12: every remaining
// branch and precedence rule below is reachable by silently reordering or
// deleting a line without any of the above tests noticing.

test('resolved outranks mute so a resolved-but-muted alert is still reported as resolved', () => {
  // Pins that the resolved short-circuit runs before the mute check. If mute
  // were checked first, this (matching) mute would report suppressed:muted
  // instead, even though the alert can never notify either way.
  const got = decideAlert({
    alert: alert({ severity: 'critical', state: 'resolved' }),
    rules: { mutes: ['check:a'], overrides: {} },
    nowMs: 0, lastNotifiedAt: null,
  });
  expect(got).toEqual({ notify: false, reason: 'skipped:resolved' });
});

test('mute outranks the info skip so a muted info alert is reported as muted', () => {
  // Pins that the mute check runs before the severity/info check. If info
  // were checked first, this would report skipped:info instead.
  const got = decideAlert({
    alert: alert({ severity: 'info' }),
    rules: { mutes: ['check:a'], overrides: {} },
    nowMs: 0, lastNotifiedAt: null,
  });
  expect(got.reason).toBe('suppressed:muted');
});

test('an info alert never notifies even inside what would be an active cooldown window', () => {
  // Pins that the info skip runs before the cooldown check. If cooldown were
  // checked first, this would report suppressed:cooldown instead — a
  // misleading reason for an alert that was never going to notify.
  const got = decideAlert({
    alert: alert({ severity: 'info' }),
    rules: { mutes: [], overrides: {} },
    nowMs: 10, lastNotifiedAt: 0,
  });
  expect(got).toEqual({ notify: false, reason: 'skipped:info' });
});

test('a per-key severity override upgrading to critical bypasses the persistence and repeat gates', () => {
  // Pins that the override's severity, not the raw alert severity, feeds the
  // critical fast path. Without the override lookup this stays below both
  // warn gates (count 1, elapsed 1000ms) and would be held instead.
  const got = decideAlert({
    alert: alert({ severity: 'warning', count: 1, recentCount: 1, firstTs: 0 }),
    rules: { mutes: [], overrides: { 'check:a': { severity: 'critical' } } },
    nowMs: 1000, lastNotifiedAt: null,
  });
  expect(got).toEqual({ notify: true, reason: 'notified' });
});

test('a per-key severity override downgrading to info silences a critical alert', () => {
  // Pins that the override's severity also feeds the info skip, not just the
  // critical fast path. Without the override lookup this would notify as
  // critical on first occurrence.
  const got = decideAlert({
    alert: alert({ severity: 'critical' }),
    rules: { mutes: [], overrides: { 'check:a': { severity: 'info' } } },
    nowMs: 0, lastNotifiedAt: null,
  });
  expect(got).toEqual({ notify: false, reason: 'skipped:info' });
});

test('a per-key cooldownMs override shortens the cooldown for that key', () => {
  // Pins the override.cooldownMs lookup, and its boundary: at exactly the
  // overridden cooldown elapsed, suppression lifts. With the default cooldown
  // (6h) this same 1000ms gap would still be suppressed:cooldown.
  const got = decideAlert({
    alert: alert({ severity: 'critical' }),
    rules: { mutes: [], overrides: { 'check:a': { cooldownMs: 1000 } } },
    nowMs: 1000, lastNotifiedAt: 0,
  });
  expect(got).toEqual({ notify: true, reason: 'notified' });
});
