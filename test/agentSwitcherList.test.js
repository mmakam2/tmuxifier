import { test, expect } from 'vitest';
import { LOCAL_BOX, LOCAL_SESSION, MRU_CAP, rowKey, switcherRows, liveRows, initialIndex, stepIndex, bumpMru, parseMru } from '../src/web/agentSwitcherList.ts';

const s = (agents, up = true) => [{ t: 1, up, agents }];
const e = (state, ts = 0, extra = {}) => ({ present: true, attached: false, state, ts, ...extra });
const boxes = [{ id: 'b1', label: 'alpha' }, { id: 'b2', label: 'beta' }];
const input = (series, extra = {}) => ({ boxes, series, mru: [], focused: null, ...extra });

test('one row per stateful session, per session not per box', () => {
  const rows = switcherRows(input({ b1: s({ web: e('working', 1), api: e('idle', 2) }) }));
  expect(rows.map((r) => r.session).sort()).toEqual(['api', 'web']);
  expect(rows[0]).toMatchObject({ boxId: 'b1', label: 'alpha', gone: false, here: false });
});
test('sessions without a state, and non-agent sessions, are not rows', () => {
  const rows = switcherRows(input({ b1: s({ a: { present: true, attached: false }, b: { present: false, attached: false }, c: e('done', 3) }) }));
  expect(rows.map((r) => r.session)).toEqual(['c']);
});
test('a box whose newest sample is down is not listed', () => {
  expect(switcherRows(input({ b1: s({ a: e('done') }, false) }))).toEqual([]);
});
test('a series for a box that no longer exists is skipped', () => {
  expect(switcherRows(input({ gone: s({ a: e('done') }) }))).toEqual([]);
});
test('Host Shell: only the local session is a row, labelled Host Shell', () => {
  const rows = switcherRows({ boxes: [], mru: [], focused: null,
    series: { __local__: s({ local: { present: true, attached: false, state: 'working', ts: 5 }, other: { present: true, attached: false, state: 'blocked', ts: 9 } }) } });
  expect(rows.map((r) => [r.label, r.session])).toEqual([['Host Shell', 'local']]);
  expect(LOCAL_BOX).toBe('__local__');
  expect(LOCAL_SESSION).toBe('local');
});
test('cause, agent and ts carry over only when present', () => {
  const [r] = switcherRows(input({ b1: s({ a: e('blocked', 7, { cause: 'permission', agent: 'claude' }) }) }));
  expect(r).toMatchObject({ state: 'blocked', cause: 'permission', agent: 'claude', ts: 7 });
  const [p] = switcherRows(input({ b1: s({ a: { present: true, attached: false, state: 'idle' } }) }));
  expect(p.ts).toBe(0);
  expect('cause' in p).toBe(false);
  expect('agent' in p).toBe(false);
});
test('the focused pane\'s agent session is pinned first and marked here', () => {
  const rows = switcherRows(input({ b1: s({ a: e('blocked', 9), b: e('idle', 1) }) }, { focused: { boxId: 'b1', session: 'b' } }));
  expect(rows.map((r) => [r.session, r.here])).toEqual([['b', true], ['a', false]]);
});
test('a focused non-agent session pins nothing', () => {
  const rows = switcherRows(input({ b1: s({ a: e('idle', 1), plain: { present: true, attached: true } }) }, { focused: { boxId: 'b1', session: 'plain' } }));
  expect(rows.some((r) => r.here)).toBe(false);
  expect(rows.map((r) => r.session)).toEqual(['a']);
});
test('used sessions come next, newest use first, then never-used by precedence and recency', () => {
  const series = { b1: s({ a: e('blocked', 1), b: e('done', 9), c: e('working', 5), d: e('idle', 3), e: e('blocked', 7) }) };
  const k = (x) => rowKey('b1', x);
  const rows = switcherRows(input(series, { mru: [k('c'), k('d')], focused: { boxId: 'b1', session: 'b' } }));
  expect(rows.map((r) => r.session)).toEqual(['b', 'c', 'd', 'e', 'a']);
});
test('ties break by label then session', () => {
  const rows = switcherRows(input({ b2: s({ z: e('idle', 1) }), b1: s({ y: e('idle', 1), x: e('idle', 1) }) }));
  expect(rows.map((r) => [r.label, r.session])).toEqual([['alpha', 'x'], ['alpha', 'y'], ['beta', 'z']]);
});
test('an mru key with no live row is ignored', () => {
  const rows = switcherRows(input({ b1: s({ a: e('idle', 1), b: e('done', 2) }) }, { mru: [rowKey('b1', 'nope'), rowKey('b1', 'a')] }));
  expect(rows.map((r) => r.session)).toEqual(['a', 'b']);
});
test('initialIndex is the first row that is not the focused session', () => {
  const series = { b1: s({ a: e('idle', 1), b: e('idle', 2) }) };
  expect(initialIndex(switcherRows(input(series, { focused: { boxId: 'b1', session: 'a' } })))).toBe(1);
  expect(initialIndex(switcherRows(input(series)))).toBe(0);
  expect(initialIndex(switcherRows(input({ b1: s({ a: e('idle', 1) }) }, { focused: { boxId: 'b1', session: 'a' } })))).toBe(-1);
  expect(initialIndex([])).toBe(-1);
});
test('stepIndex wraps down and up', () => {
  expect(stepIndex(2, 1, 3)).toBe(0);
  expect(stepIndex(0, -1, 3)).toBe(2);
  expect(stepIndex(0, 1, 1)).toBe(0);
  expect(stepIndex(-1, 1, 0)).toBe(-1);
});
test('liveRows keeps the frozen order while state and age move', () => {
  const frozen = switcherRows(input({ b1: s({ a: e('done', 5), b: e('idle', 1) }) }));
  const copy = JSON.parse(JSON.stringify(frozen));
  const live = liveRows(frozen, { b1: s({ a: e('done', 5), b: e('blocked', 20, { cause: 'question' }) }) });
  expect(live.map((r) => r.session)).toEqual(['a', 'b']);
  expect(live[1]).toMatchObject({ state: 'blocked', cause: 'question', ts: 20, gone: false });
  expect(frozen).toEqual(copy);
  expect(live[1]).not.toBe(frozen[1]);
});
test('liveRows marks a vanished session gone and keeps its last state', () => {
  const frozen = switcherRows(input({ b1: s({ a: e('working', 5), b: e('idle', 1) }) }, { focused: { boxId: 'b1', session: 'a' } }));
  const gone = liveRows(frozen, { b1: s({ b: e('idle', 1) }) });
  expect(gone[0]).toMatchObject({ session: 'a', state: 'working', ts: 5, gone: true, here: true });
  expect(gone[1].gone).toBe(false);
  const noSeries = liveRows(frozen, {});
  expect(noSeries.every((r) => r.gone)).toBe(true);
  const back = liveRows(gone, { b1: s({ a: e('done', 8), b: e('idle', 1) }) });
  expect(back[0]).toMatchObject({ state: 'done', gone: false });
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
test('row keys cannot collide across boxes', () => {
  expect(rowKey('a', 'b-c')).not.toBe(rowKey('a-b', 'c'));
});
