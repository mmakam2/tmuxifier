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

test('a second jump to the same box keeps the hold while its select is out, and a later jump\'s cover releases both', () => {
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

// Two jumps of one box to different windows: the earlier target is never visible again once the
// later select has moved the window, so it must not hold the box until HOLD_MAX_MS.
test('a later jump supersedes an earlier one: its cover releases every hold of the box', () => {
  const h = createSeenHold();
  const first = h.begin('b1', '%1');
  h.settle('b1', first, true, 0);
  const second = h.begin('b1', '%2');
  h.settle('b1', second, true, 10);
  // Fetched after both settles: %2 in front, %1 in a background window.
  h.applied('b1', h.fetchStarted(), at({ b1: { ...shows('%1', false), ...shows('%2', true) } }), 20);
  expect(h.held('b1')).toBe(false);
});

test('a later jump supersedes nothing while an earlier select is still out, nor before its own cover', () => {
  const h = createSeenHold();
  const first = h.begin('b1', '%1');
  const second = h.begin('b1', '%2');
  h.settle('b1', second, true, 10); // the later select answered first
  h.applied('b1', h.fetchStarted(), at({ b1: { ...shows('%1', false), ...shows('%2', true) } }), 20);
  expect(h.held('b1')).toBe(true); // the first select may still move the window
  h.settle('b1', first, true, 30); // its answer arrives last; the box ran it first
  h.applied('b1', h.fetchStarted(), at({ b1: { ...shows('%1', false), ...shows('%2', true) } }), 40);
  expect(h.held('b1')).toBe(false); // the latest BEGUN jump is covered: begin order, not answer order
  // A series that shows only the earlier target in front releases the earlier jump alone.
  const back = createSeenHold();
  const a = back.begin('b1', '%1');
  const b = back.begin('b1', '%2');
  back.settle('b1', a, true, 0);
  back.settle('b1', b, true, 10);
  back.applied('b1', back.fetchStarted(), at({ b1: { ...shows('%1', true), ...shows('%2', false) } }), 20);
  expect(back.held('b1')).toBe(true);
  back.applied('b1', back.fetchStarted(), at({ b1: { ...shows('%1', false), ...shows('%2', true) } }), 30);
  expect(back.held('b1')).toBe(false);

  const stale = createSeenHold();
  stale.settle('b1', stale.begin('b1', '%1'), true, 0);
  stale.settle('b1', stale.begin('b1', '%2'), true, 10);
  stale.applied('b1', stale.fetchStarted(), at({ b1: { ...shows('%1', true), ...shows('%2', false) } }), 20);
  expect(stale.held('b1')).toBe(true); // the series still shows the earlier jump's window: not the later's cover
});

test('a refused later jump supersedes nothing: the earlier one still waits for its own cover', () => {
  const h = createSeenHold();
  const first = h.begin('b1', '%1');
  h.settle('b1', first, true, 0);
  const second = h.begin('b1', '%2');
  h.settle('b1', second, false, 10);
  h.applied('b1', h.fetchStarted(), at({ b1: { ...shows('%1', false), ...shows('%2', false) } }), 20);
  expect(h.held('b1')).toBe(true);
  h.applied('b1', h.fetchStarted(), at({ b1: { ...shows('%1', true), ...shows('%2', false) } }), 30);
  expect(h.held('b1')).toBe(false);
});

// ── A picker pick of a window in another session (no target pane) ──────────
const inSession = (session, windowId, visible) => entry({ session, windowId, visible, focused: visible });

test('a window hold is covered by a series fetched after the settle in which nothing of the session outside the window is visible', () => {
  const h = createSeenHold();
  const j = h.beginWindow('b1', 'main', '@2');
  expect(h.held('b1')).toBe(true);
  const oldView = { '%1': inSession('main', '@1', true), '%2': inSession('main', '@2', false), '%9': inSession('web', '@5', true) };
  const newView = { '%1': inSession('main', '@1', false), '%2': inSession('main', '@2', true), '%9': inSession('web', '@5', true) };
  h.applied('b1', h.fetchStarted(), at({ b1: newView }), 0); // before the settle
  expect(h.held('b1')).toBe(true);
  h.settle('b1', j, true, 10);
  h.applied('b1', h.fetchStarted(), at({ b1: oldView }), 20); // after, but the old window still in front
  expect(h.held('b1')).toBe(true);
  h.applied('b1', h.fetchStarted(), at({ b1: newView }), 30); // another session's visible pane says nothing
  expect(h.held('b1')).toBe(false);
  // A session with no agent visible outside the window is covered at once, as is a box gone.
  const quiet = createSeenHold();
  quiet.settle('b1', quiet.beginWindow('b1', 'main', '@2'), true, 0);
  quiet.applied('b1', quiet.fetchStarted(), at({ b1: { '%1': inSession('main', '@1', false) } }), 10);
  expect(quiet.held('b1')).toBe(false);
  const gone = createSeenHold();
  gone.settle('b1', gone.beginWindow('b1', 'main', '@2'), true, 0);
  gone.applied('b1', gone.fetchStarted(), at({}), 10);
  expect(gone.held('b1')).toBe(false);
  // HOLD_MAX_MS is still the last resort.
  const capped = createSeenHold();
  capped.settle('b1', capped.beginWindow('b1', 'main', '@2'), true, 0);
  capped.applied('b1', capped.fetchStarted(), at({ b1: oldView }), HOLD_MAX_MS);
  expect(capped.held('b1')).toBe(false);
});

test('cancel releases a hold at once (a refused or failed select moved nothing), and only that one', () => {
  const h = createSeenHold();
  const j = h.beginWindow('b1', 'main', '@2');
  h.cancel('b1', j);
  expect(h.held('b1')).toBe(false);
  const jump = h.begin('b1', '%1');
  const pick = h.beginWindow('b1', 'main', '@2');
  h.cancel('b1', pick);
  expect(h.held('b1')).toBe(true); // the jump's hold stays
  h.cancel('b1', 999); // unknown: harmless
  h.cancel('b2', jump); // another box: harmless
  expect(h.held('b1')).toBe(true);
  h.settle('b1', jump, true, 0);
  h.applied('b1', h.fetchStarted(), at({ b1: shows('%1', true) }), 10);
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
