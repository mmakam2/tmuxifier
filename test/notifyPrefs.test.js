import { test, expect, beforeEach } from 'vitest';
import { NOTIFY_KINDS, defaultNotifyPrefs, loadNotifyPrefs, saveNotifyPrefs, enabledKinds } from '../src/web/notifyPrefs.ts';

beforeEach(() => {
  globalThis.localStorage = (() => {
    let store = {};
    return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }, clear: () => { store = {}; } };
  })();
});

test('the catalog covers every event kind exactly once', () => {
  const kinds = NOTIFY_KINDS.map((k) => k.kind).sort();
  expect(kinds).toEqual(['agent-blocked', 'agent-done', 'agent-input', 'down', 'key-changed', 'needs-auth', 'threshold', 'threshold-clear', 'up']);
});

test('agent-blocked leads the catalog and defaults on', () => {
  expect(NOTIFY_KINDS[0].kind).toBe('agent-blocked');
  expect(NOTIFY_KINDS[0].label).toBe('Claude needs you (permission or question)');
  expect(NOTIFY_KINDS.find((k) => k.kind === 'agent-input').label).toBe('Claude finished a turn');
  expect(defaultNotifyPrefs()['agent-blocked']).toBe(true);
});

test('defaults enable everything except up and threshold-clear', () => {
  const d = defaultNotifyPrefs();
  expect(d['down']).toBe(true);
  expect(d['agent-input']).toBe(true);
  expect(d['up']).toBe(false);
  expect(d['threshold-clear']).toBe(false);
});

test('load merges stored prefs over defaults; save round-trips', () => {
  saveNotifyPrefs({ ...defaultNotifyPrefs(), down: false });
  const loaded = loadNotifyPrefs();
  expect(loaded['down']).toBe(false);
  expect(loaded['needs-auth']).toBe(true); // untouched default
});

test('a corrupt/empty store falls back to defaults', () => {
  localStorage.setItem('tmuxifier.notifyPrefs', 'not json');
  expect(loadNotifyPrefs()['down']).toBe(true);
});

test('enabledKinds returns the set of enabled kinds', () => {
  const set = enabledKinds({ ...defaultNotifyPrefs(), down: false });
  expect(set.has('agent-input')).toBe(true);
  expect(set.has('down')).toBe(false);
  expect(set.has('up')).toBe(false);
});
