import { test, expect } from 'vitest';
import { LOCAL_BOX, LOCAL_SESSION, MRU_CAP, rowKey, switcherRows, liveRows, focusedAgentKey, initialIndex, stepIndex, bumpMru, parseMru } from '../src/web/agentSwitcherList.ts';

const s = (agents, up = true) => [{ t: 1, up, agents }];
// One agent pane entry, as healthHistory.js sampleOf writes it (pane-keyed map).
// Each pane gets its own window unless the test says otherwise, so names stay plain.
let nextWin = 0;
const e = (session, state, ts = 0, extra = {}) => {
  const w = ++nextWin;
  const entry = { session, windowId: `@${w}`, windowIndex: w, windowName: `w${w}`, paneIndex: 0, agent: 'claude', ts, visible: false, focused: false, attached: false, ...extra };
  if (state !== undefined) entry.state = state;
  return entry;
};
const boxes = [{ id: 'b1', label: 'alpha' }, { id: 'b2', label: 'beta' }];
const input = (series, extra = {}) => ({ boxes, series, mru: [], focused: null, ...extra });
const panes = (rows) => rows.map((r) => r.pane);

test('one row per stateful agent pane: two panes of one window are two rows, named per pane', () => {
  const rows = switcherRows(input({ b1: s({
    '%3': e('main', 'working', 1, { windowId: '@2', windowIndex: 2, windowName: 'frontend', paneIndex: 1 }),
    '%4': e('main', 'working', 1, { windowId: '@2', windowIndex: 2, windowName: 'frontend', paneIndex: 2 }),
  }) }));
  expect(rows.map((r) => [r.pane, r.name])).toEqual([['%3', '2:frontend.1'], ['%4', '2:frontend.2']]);
  expect(rows[0]).toEqual({
    key: rowKey('b1', '%3'), boxId: 'b1', label: 'alpha', pane: '%3', session: 'main', windowId: '@2',
    name: '2:frontend.1', suffix: '.1', state: 'working', agent: 'claude', ts: 1, here: false, gone: false,
  });
});
test('entries without a state are not rows, but still count for the names', () => {
  const rows = switcherRows(input({ b1: s({
    '%1': e('main', undefined, 0, { windowId: '@2', windowIndex: 2, windowName: 'frontend', paneIndex: 1 }),
    '%2': e('main', 'done', 3, { windowId: '@2', windowIndex: 2, windowName: 'frontend', paneIndex: 2 }),
  }) }));
  expect(rows.map((r) => [r.pane, r.name])).toEqual([['%2', '2:frontend.2']]);
});
test('a box whose newest sample is down is not listed', () => {
  expect(switcherRows(input({ b1: s({ '%1': e('a', 'done') }, false) }))).toEqual([]);
});
test('a series for a box that no longer exists is skipped', () => {
  expect(switcherRows(input({ gone: s({ '%1': e('a', 'done') }) }))).toEqual([]);
});
test('Host Shell: only entries of the local session are rows, labelled Host Shell and named as that session alone', () => {
  const rows = switcherRows({ boxes: [], mru: [], focused: null,
    series: { __local__: s({
      '%5': e('local', 'working', 5, { windowIndex: 0, windowName: 'zsh' }),
      '%9': e('other', 'blocked', 9),
    }) } });
  expect(rows.map((r) => [r.label, r.pane, r.session, r.name])).toEqual([['Host Shell', '%5', 'local', '0:zsh']]);
  expect(LOCAL_BOX).toBe('__local__');
  expect(LOCAL_SESSION).toBe('local');
});
test('a pane-keyed map is read own-property only', () => {
  const agents = Object.create({ '%7': e('main', 'blocked', 1) });
  expect(switcherRows(input({ b1: s(agents) }))).toEqual([]);
});
test('cause, agent and ts carry over only when present', () => {
  const [r] = switcherRows(input({ b1: s({ '%1': e('a', 'blocked', 7, { cause: 'permission', agent: 'codex' }) }) }));
  expect(r).toMatchObject({ state: 'blocked', cause: 'permission', agent: 'codex', ts: 7 });
  const noTs = e('a', 'idle');
  delete noTs.ts;
  const [p] = switcherRows(input({ b1: s({ '%1': noTs }) }));
  expect(p.ts).toBe(0);
  expect('cause' in p).toBe(false);
});
test('here marks only the focused pane of the focused session, pinned first', () => {
  const rows = switcherRows(input({ b1: s({
    '%1': e('a', 'blocked', 9, { focused: true }),
    '%2': e('b', 'idle', 1, { windowId: '@9', windowIndex: 9, paneIndex: 1, visible: true }),
    '%3': e('b', 'idle', 2, { windowId: '@9', windowIndex: 9, paneIndex: 2, visible: true, focused: true }),
  }) }, { focused: { boxId: 'b1', session: 'b' } }));
  expect(rows.map((r) => [r.pane, r.here])).toEqual([['%3', true], ['%1', false], ['%2', false]]);
  // The same pane on another box is not here.
  const two = switcherRows(input({ b1: s({ '%3': e('b', 'idle', 2, { focused: true }) }), b2: s({ '%3': e('b', 'idle', 2, { focused: true }) }) },
    { focused: { boxId: 'b2', session: 'b' } }));
  expect(two.map((r) => [r.boxId, r.here])).toEqual([['b2', true], ['b1', false]]);
});
test('a focused session with no focused agent pane pins nothing', () => {
  const rows = switcherRows(input({ b1: s({ '%1': e('a', 'idle', 1), '%2': e('plain', 'idle', 2) }) }, { focused: { boxId: 'b1', session: 'plain' } }));
  expect(rows.some((r) => r.here)).toBe(false);
  expect(rows).toHaveLength(2);
});
test('used panes come next, newest use first, then never-used by precedence and recency', () => {
  const series = { b1: s({
    '%1': e('m', 'blocked', 1), '%2': e('m', 'done', 9, { focused: true }), '%3': e('m', 'working', 5), '%4': e('m', 'idle', 3), '%5': e('m', 'blocked', 7),
  }) };
  const k = (x) => rowKey('b1', x);
  const rows = switcherRows(input(series, { mru: [k('%3'), k('%4')], focused: { boxId: 'b1', session: 'm' } }));
  expect(panes(rows)).toEqual(['%2', '%3', '%4', '%5', '%1']);
});
test('an old session-keyed MRU entry never matches a row', () => {
  const series = { b1: s({ '%1': e('main', 'idle', 1, { windowIndex: 1 }), '%2': e('main', 'done', 2, { windowIndex: 2 }) }) };
  // Without an MRU, done sorts ahead of idle; an old `box\nsession` key changes nothing.
  const plain = switcherRows(input(series));
  expect(panes(plain)).toEqual(['%2', '%1']);
  const rows = switcherRows(input(series, { mru: ['b1\nmain', rowKey('b1', 'nope')] }));
  expect(panes(rows)).toEqual(['%2', '%1']);
  expect(panes(switcherRows(input(series, { mru: ['b1\nmain', rowKey('b1', '%1')] })))).toEqual(['%1', '%2']);
});
test('ties break by label then name', () => {
  const rows = switcherRows(input({
    b2: s({ '%1': e('z', 'idle', 1, { windowIndex: 1, windowName: 'a' }) }),
    b1: s({ '%2': e('y', 'idle', 1, { windowIndex: 3, windowName: 'c' }), '%3': e('y', 'idle', 1, { windowIndex: 2, windowName: 'b' }) }),
  }));
  expect(rows.map((r) => [r.label, r.name])).toEqual([['alpha', '2:b'], ['alpha', '3:c'], ['beta', '1:a']]);
});
test('initialIndex is the first row that is not the focused pane', () => {
  const series = { b1: s({ '%1': e('a', 'idle', 1, { focused: true }), '%2': e('b', 'idle', 2, { focused: true }) }) };
  expect(initialIndex(switcherRows(input(series, { focused: { boxId: 'b1', session: 'a' } })))).toBe(1);
  expect(initialIndex(switcherRows(input(series)))).toBe(0);
  expect(initialIndex(switcherRows(input({ b1: s({ '%1': e('a', 'idle', 1, { focused: true }) }) }, { focused: { boxId: 'b1', session: 'a' } })))).toBe(-1);
  expect(initialIndex([])).toBe(-1);
});
test('stepIndex wraps down and up', () => {
  expect(stepIndex(2, 1, 3)).toBe(0);
  expect(stepIndex(0, -1, 3)).toBe(2);
  expect(stepIndex(0, 1, 1)).toBe(0);
  expect(stepIndex(-1, 1, 0)).toBe(-1);
});
test('liveRows keeps the frozen order while state, age and place move', () => {
  const a = e('m', 'done', 5);
  const b = e('m', 'idle', 1);
  const frozen = switcherRows(input({ b1: s({ '%1': a, '%2': b }) }));
  expect(panes(frozen)).toEqual(['%1', '%2']);
  const copy = JSON.parse(JSON.stringify(frozen));
  // %2 turns blocked (which would sort first) and moved to another window.
  const live = liveRows(frozen, { b1: s({ '%1': a, '%2': { ...b, state: 'blocked', cause: 'question', ts: 20, windowId: '@77', windowIndex: 77, windowName: 'moved' } }) });
  expect(panes(live)).toEqual(['%1', '%2']);
  expect(live[1]).toMatchObject({ state: 'blocked', cause: 'question', ts: 20, windowId: '@77', name: '77:moved', gone: false });
  expect(frozen).toEqual(copy);
  expect(live[1]).not.toBe(frozen[1]);
  const calm = liveRows(live, { b1: s({ '%1': a, '%2': b }) });
  expect('cause' in calm[1]).toBe(false);
});
test('liveRows marks a row gone when its pane id left the map, and keeps its last state', () => {
  const frozen = switcherRows(input({ b1: s({ '%1': e('a', 'working', 5, { focused: true }), '%2': e('b', 'idle', 1) }) }, { focused: { boxId: 'b1', session: 'a' } }));
  const left = liveRows(frozen, { b1: s({ '%2': e('b', 'idle', 1) }) });
  expect(left[0]).toMatchObject({ pane: '%1', state: 'working', ts: 5, gone: true, here: true });
  expect(left[1].gone).toBe(false);
  // A pane that is still listed but lost its state is gone too.
  expect(liveRows(frozen, { b1: s({ '%1': e('a', undefined), '%2': e('b', 'idle', 1) }) })[0].gone).toBe(true);
  expect(liveRows(frozen, {}).every((r) => r.gone)).toBe(true);
  const back = liveRows(left, { b1: s({ '%1': e('a', 'done', 8), '%2': e('b', 'idle', 1) }) });
  expect(back[0]).toMatchObject({ state: 'done', gone: false });
});
test('liveRows: a Host Shell pane that moved out of the local session is gone', () => {
  const frozen = switcherRows({ boxes: [], mru: [], focused: null, series: { __local__: s({ '%5': e('local', 'working', 5) }) } });
  expect(liveRows(frozen, { __local__: s({ '%5': e('other', 'working', 5) }) })[0].gone).toBe(true);
});
test('focusedAgentKey names the focused agent pane of a session, or null', () => {
  const agents = {
    '%1': e('main', 'idle', 1, { focused: false }),
    '%2': e('main', undefined, 0, { focused: true }),
    '%3': e('other', 'done', 1, { focused: true }),
  };
  expect(focusedAgentKey('b1', agents, 'main')).toBe(rowKey('b1', '%2'));
  expect(focusedAgentKey('b1', agents, 'other')).toBe(rowKey('b1', '%3'));
  expect(focusedAgentKey('b1', agents, 'none')).toBeNull();
  expect(focusedAgentKey('b1', undefined, 'main')).toBeNull();
  expect(focusedAgentKey('b1', Object.create({ '%9': e('main', 'idle', 1, { focused: true }) }), 'main')).toBeNull();
  // The Host Shell has one session: an entry of any other is not its pane.
  expect(focusedAgentKey(LOCAL_BOX, { '%4': e('main', 'idle', 1, { focused: true }) }, 'main')).toBeNull();
  expect(focusedAgentKey(LOCAL_BOX, { '%4': e('local', 'idle', 1, { focused: true }) }, 'local')).toBe(rowKey(LOCAL_BOX, '%4'));
});
test('bumpMru moves a key to the front without duplicates and caps the list', () => {
  const input0 = Array.from({ length: 101 }, (_, i) => `k${i}`);
  const snapshot = [...input0];
  const out = bumpMru(input0, 'new');
  expect(out).toHaveLength(MRU_CAP);
  expect(out[0]).toBe('new');
  expect(input0).toEqual(snapshot);
  expect(bumpMru(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  expect(bumpMru(['a', 'b', 'c'], 'x', 2)).toEqual(['x', 'a']);
});
test('parseMru tolerates null, garbage and wrong types', () => {
  expect(parseMru(null)).toEqual([]);
  expect(parseMru('x')).toEqual([]);
  expect(parseMru('{}')).toEqual([]);
  expect(parseMru('[1,"a",null]')).toEqual(['a']);
  expect(parseMru(JSON.stringify(Array.from({ length: 150 }, (_, i) => `k${i}`)))).toHaveLength(MRU_CAP);
});
test('row keys name the box and the pane and cannot collide across boxes', () => {
  expect(rowKey('b1', '%3')).toBe('b1\n%3');
  expect(rowKey('a', '%1')).not.toBe(rowKey('b', '%1'));
});
