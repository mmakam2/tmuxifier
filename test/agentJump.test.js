import { test, expect } from 'vitest';
import { jumpTargetOf, needsSelect, sidebarAgents, sidebarSeries, createSeenHold, HOLD_MAX_MS } from '../src/web/agentJump.ts';

const entry = (over = {}) => ({
  session: 'main', windowId: '@3', windowIndex: 2, windowName: 'frontend', paneIndex: 1,
  agent: 'claude', state: 'done', ts: 100, visible: false, focused: false, attached: true, ...over,
});

test('jumpTargetOf takes the session and window from the pane entry', () => {
  const agents = { '%12': entry(), '%13': entry({ session: 'other', windowId: '@7', focused: true, visible: true }) };
  expect(jumpTargetOf('b1', agents, '%12')).toEqual({ boxId: 'b1', pane: '%12', session: 'main', windowId: '@3', focused: false });
  expect(jumpTargetOf('b1', agents, '%13')).toEqual({ boxId: 'b1', pane: '%13', session: 'other', windowId: '@7', focused: true });
});

test('jumpTargetOf is null for an unknown pane, an inherited key and no map', () => {
  const agents = { '%12': entry() };
  expect(jumpTargetOf('b1', agents, '%99')).toBeNull();
  expect(jumpTargetOf('b1', agents, 'constructor')).toBeNull();
  expect(jumpTargetOf('b1', agents, 'toString')).toBeNull();
  expect(jumpTargetOf('b1', undefined, '%12')).toBeNull();
  expect(jumpTargetOf('b1', { '%12': null }, '%12')).toBeNull();
});

test('needsSelect is false only for an entry already focused', () => {
  const agents = {
    '%1': entry({ visible: true, focused: true }),
    '%2': entry({ visible: true, focused: false }), // in the window in front, another pane focused
    '%3': entry({ visible: false, focused: false }), // a background window
  };
  expect(needsSelect(jumpTargetOf('b1', agents, '%1'))).toBe(false);
  expect(needsSelect(jumpTargetOf('b1', agents, '%2'))).toBe(true);
  expect(needsSelect(jumpTargetOf('b1', agents, '%3'))).toBe(true);
});

// ── Host Shell rows are its own session's (spec 2026-11-26 §7.1) ─────────────
test('sidebarAgents keeps only the local session on the Host Shell and every entry on a box', () => {
  const agents = { '%1': entry({ session: 'local' }), '%2': entry({ session: 'main' }), '%3': entry({ session: 'local', state: 'blocked' }) };
  expect(Object.keys(sidebarAgents('__local__', agents)).sort()).toEqual(['%1', '%3']);
  expect(sidebarAgents('b1', agents)).toEqual(agents);
  expect(sidebarAgents('__local__', undefined)).toEqual({});
  // An inherited key is never an entry.
  expect(Object.hasOwn(sidebarAgents('__local__', agents), 'constructor')).toBe(false);
});

test('sidebarSeries narrows the Host Shell latest sample, leaves boxes and history alone', () => {
  const older = { t: 1, up: true, agents: { '%9': entry({ session: 'main' }) } };
  const latest = { t: 2, up: true, agents: { '%1': entry({ session: 'local' }), '%2': entry({ session: 'main', state: 'blocked' }) } };
  const box = [{ t: 2, up: true, agents: { '%5': entry({ session: 'main' }) } }];
  const series = { __local__: [older, latest], b1: box };
  const out = sidebarSeries(series);
  expect(out.b1).toBe(box);
  expect(out.__local__.at(-1).agents).toEqual({ '%1': latest.agents['%1'] });
  expect(out.__local__.at(-1).t).toBe(2);
  expect(series.__local__[1].agents['%2']).toBeDefined(); // input untouched
  expect(sidebarSeries({ b1: box })).toEqual({ b1: box });
});

// ── A jump holds the box's acknowledgements (spec 2026-11-26 §7.3 step 3) ───
const at = (map) => (id) => map[id];
const shows = (pane, visible) => ({ [pane]: entry({ visible, focused: visible }) });

test('a hold lasts until a series fetched after the select settled shows the pane visible', () => {
  const h = createSeenHold();
  expect(h.held('b1')).toBe(false);
  const before = h.fetchStarted(); // a poll already in flight when the jump starts
  const j = h.begin('b1', '%5');
  expect(h.held('b1')).toBe(true);
  expect(h.held('b2')).toBe(false);
  const during = h.fetchStarted(); // started while the select is outstanding
  h.applied(null, before, at({ b1: shows('%5', true) }), 1000);
  h.applied('b1', during, at({ b1: shows('%5', true) }), 1000);
  expect(h.held('b1')).toBe(true); // the select has not even settled
  h.settle('b1', j, true, 1000);
  h.applied(null, during, at({ b1: shows('%5', true) }), 1000); // started before the settle
  expect(h.held('b1')).toBe(true);
  // Fetched after, but still the old view: the server has not re-read the box.
  h.applied('b1', h.fetchStarted(), at({ b1: shows('%5', false) }), 2000);
  expect(h.held('b1')).toBe(true);
  h.applied('b2', h.fetchStarted(), at({ b2: shows('%5', true) }), 2000); // another box says nothing of b1
  expect(h.held('b1')).toBe(true);
  h.applied('b1', h.fetchStarted(), at({ b1: shows('%5', true) }), 3000);
  expect(h.held('b1')).toBe(false);
});

test('a refused select is covered by the first series fetched after it', () => {
  const h = createSeenHold();
  const j = h.begin('b1', '%5');
  h.settle('b1', j, false, 1000);
  h.applied('b1', h.fetchStarted(), at({ b1: shows('%5', false) }), 1000);
  expect(h.held('b1')).toBe(false);
});

test('a pane gone from the series, or HOLD_MAX_MS after the settle, ends the hold', () => {
  const gone = createSeenHold();
  gone.settle('b1', gone.begin('b1', '%5'), true, 1000);
  gone.applied('b1', gone.fetchStarted(), at({ b1: shows('%6', false) }), 1000);
  expect(gone.held('b1')).toBe(false);

  const stale = createSeenHold();
  stale.settle('b1', stale.begin('b1', '%5'), true, 1000);
  stale.applied('b1', stale.fetchStarted(), at({ b1: shows('%5', false) }), 1000 + HOLD_MAX_MS - 1);
  expect(stale.held('b1')).toBe(true);
  stale.applied('b1', stale.fetchStarted(), at({ b1: shows('%5', false) }), 1000 + HOLD_MAX_MS);
  expect(stale.held('b1')).toBe(false);
});

test('a fleet-wide series releases every box whose jump it covers, and no other', () => {
  const h = createSeenHold();
  const a = h.begin('b1', '%1');
  const b = h.begin('b2', '%2');
  h.settle('b1', a, true, 0);
  h.settle('b2', b, true, 0);
  h.applied(null, h.fetchStarted(), at({ b1: shows('%1', true), b2: shows('%2', false) }), 10);
  expect(h.held('b1')).toBe(false);
  expect(h.held('b2')).toBe(true);
});

test('a second jump to the same box keeps the hold until both are covered', () => {
  const h = createSeenHold();
  const first = h.begin('b1', '%1');
  const second = h.begin('b1', '%2');
  h.settle('b1', first, true, 0);
  const both = { b1: { ...shows('%1', true), ...shows('%2', true) } };
  h.applied('b1', h.fetchStarted(), at(both), 10);
  expect(h.held('b1')).toBe(true); // the second select is still out
  h.settle('b1', second, true, 20);
  expect(h.held('b1')).toBe(true);
  h.applied('b1', h.fetchStarted(), at(both), 30);
  expect(h.held('b1')).toBe(false);
});

test('settling an unknown or already released jump is harmless, and an inherited key is no pane', () => {
  const h = createSeenHold();
  h.settle('b1', 42, true, 0);
  expect(h.held('b1')).toBe(false);
  const j = h.begin('b1', 'constructor');
  h.settle('b1', j, true, 0);
  h.applied('b1', h.fetchStarted(), at({ b1: {} }), 10); // not listed: gone
  expect(h.held('b1')).toBe(false);
  h.settle('b1', j, true, 0);
  expect(h.held('b1')).toBe(false);
});
