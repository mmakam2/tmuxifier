import { test, expect } from 'vitest';
import {
  panesOf, dockAtStageEdge, dockAtPaneEdge, movePane, undockPane, replacePane,
  setRatio, toggleOrientation, splitAt, serialize, restore, MIN_RATIO, phonePaneOf,
} from '../src/web/stageLayout.ts';

const row = (children, ratios) => ({ orientation: 'row', children, ratios: ratios ?? children.map(() => 1 / children.length) });
const col = (children, ratios) => ({ orientation: 'column', children, ratios: ratios ?? children.map(() => 1 / children.length) });

test('panesOf walks leaves in DFS order', () => {
  expect(panesOf(null)).toEqual([]);
  expect(panesOf('a')).toEqual(['a']);
  expect(panesOf(col([row(['a', 'b']), 'c']))).toEqual(['a', 'b', 'c']);
});

test('stage-edge dock: empty and single grow naturally', () => {
  expect(dockAtStageEdge(null, 'a', 'right')).toBe('a');
  expect(dockAtStageEdge('a', 'b', 'right')).toEqual(row(['a', 'b']));
  expect(dockAtStageEdge('a', 'b', 'left')).toEqual(row(['b', 'a']));
  expect(dockAtStageEdge('a', 'b', 'bottom')).toEqual(col(['a', 'b']));
});

test('stage-edge dock along the root axis inserts a sibling, never nests', () => {
  expect(dockAtStageEdge(row(['a', 'b']), 'c', 'right')).toEqual(row(['a', 'b', 'c']));
  expect(dockAtStageEdge(row(['a', 'b']), 'c', 'left')).toEqual(row(['c', 'a', 'b']));
});

test('stage-edge dock across the root axis wraps: the reported 2-up + full-width case', () => {
  expect(dockAtStageEdge(row(['a', 'b']), 'c', 'bottom')).toEqual(col([row(['a', 'b']), 'c']));
  expect(dockAtStageEdge(row(['a', 'b']), 'c', 'top')).toEqual(col(['c', row(['a', 'b'])]));
});

test('pane-edge dock splits just that pane', () => {
  expect(dockAtPaneEdge(row(['a', 'b']), 'b', 'c', 'bottom')).toEqual(row(['a', col(['b', 'c'])]));
  expect(dockAtPaneEdge(row(['a', 'b']), 'b', 'c', 'top')).toEqual(row(['a', col(['c', 'b'])]));
});

test('pane-edge dock along the parent axis becomes an adjacent sibling', () => {
  expect(panesOf(dockAtPaneEdge(row(['a', 'b']), 'a', 'c', 'right'))).toEqual(['a', 'c', 'b']);
  const t = dockAtPaneEdge(row(['a', 'b']), 'a', 'c', 'right');
  expect(t.orientation).toBe('row');
  expect(t.children).toEqual(['a', 'c', 'b']);
});

test('nesting to depth 3: A | (B over (C | D))', () => {
  let t = dockAtStageEdge('a', 'b', 'right');       // row[a,b]
  t = dockAtPaneEdge(t, 'b', 'c', 'bottom');        // row[a, col[b,c]]
  t = dockAtPaneEdge(t, 'c', 'd', 'right');         // row[a, col[b, row[c,d]]]
  expect(t).toEqual(row(['a', col(['b', row(['c', 'd'])])]));
  expect(panesOf(t)).toEqual(['a', 'b', 'c', 'd']);
});

test('docking an already-docked pane is a move, not a duplicate', () => {
  const t = movePane(row(['a', 'b']), 'a', { kind: 'stage-edge', edge: 'bottom' });
  expect(t).toEqual(col(['b', 'a']));
  const u = movePane(col([row(['a', 'b']), 'c']), 'c', { kind: 'pane-edge', paneId: 'a', edge: 'right' });
  // Sibling-merge scales ratios by the parent slot ([0.25, 0.25, 0.5]) — assert
  // structure, not ratios.
  expect(u.orientation).toBe('row');
  expect(u.children).toEqual(['a', 'c', 'b']);
});

test('undock collapses one-child splits and rescales ratios proportionally', () => {
  expect(undockPane(col([row(['a', 'b']), 'c']), 'c')).toEqual(row(['a', 'b']));
  expect(undockPane(row(['a', 'b']), 'b')).toBe('a');
  expect(undockPane('a', 'a')).toBeNull();
  const t = undockPane(row(['a', 'b', 'c'], [0.5, 0.25, 0.25]), 'a');
  expect(t.ratios).toEqual([0.5, 0.5]);
});

test('replacePane substitutes an undocked id and swaps a docked one', () => {
  expect(replacePane(row(['a', 'b']), 'b', 'c')).toEqual(row(['a', 'c']));
  const swapped = replacePane(col([row(['a', 'b']), 'c']), 'a', 'c');
  expect(swapped).toEqual(col([row(['c', 'b']), 'a']));
  expect(replacePane(row(['a', 'b']), 'zz', 'c')).toEqual(row(['a', 'b']));
});

test('setRatio addresses a split by path and clamps at MIN_RATIO', () => {
  const t = col([row(['a', 'b']), 'c']);
  const inner = setRatio(t, [0], 0, 0.7);
  expect(splitAt(inner, [0]).ratios).toEqual([0.7, 0.3]);
  const outer = setRatio(t, [], 0, 0.05);
  expect(outer.ratios[0]).toBeCloseTo(MIN_RATIO);
  expect(setRatio(t, [5], 0, 0.5)).toEqual(t); // bad path: unchanged
});

test('toggleOrientation flips a split and re-normalizes the tree', () => {
  const t = toggleOrientation(row(['a', 'b']), []);
  expect(t).toEqual(col(['a', 'b']));
  // flipping an inner split to the parent orientation merges it away
  const u = toggleOrientation(row(['a', col(['b', 'c'])]), [1]);
  expect(u.orientation).toBe('row');
  expect(panesOf(u)).toEqual(['a', 'b', 'c']);
  expect(u.children).toEqual(['a', 'b', 'c']);
});

test('serialize/restore round-trips a tree (v2)', () => {
  const t = col([row(['a', 'b'], [0.6, 0.4]), 'c'], [0.7, 0.3]);
  const { root, focusedId } = restore(serialize(t, 'b'), ['a', 'b', 'c']);
  expect(root).toEqual(t);
  expect(focusedId).toBe('b');
});

test('restore migrates a v1 flat layout', () => {
  const v1 = JSON.stringify({ v: 1, layout: { orientation: 'column', panes: ['a', 'b'], ratios: [0.7, 0.3] }, focusedId: 'b' });
  expect(restore(v1, ['a', 'b'])).toEqual({ root: col(['a', 'b'], [0.7, 0.3]), focusedId: 'b' });
  const single = JSON.stringify({ v: 1, layout: { orientation: 'row', panes: ['a'], ratios: [1] }, focusedId: 'a' });
  expect(restore(single, ['a'])).toEqual({ root: 'a', focusedId: 'a' });
});

test('restore prunes vanished boxes through collapse and refocuses', () => {
  const t = col([row(['a', 'gone'], [0.6, 0.4]), 'c'], [0.7, 0.3]);
  const { root, focusedId } = restore(serialize(t, 'gone'), ['a', 'c']);
  expect(root).toEqual(col(['a', 'c'], [0.7, 0.3]));
  expect(focusedId).toBe('a');
});

test('restore rejects garbage and insane ratios', () => {
  expect(restore('not json', ['a'])).toEqual({ root: null, focusedId: null });
  expect(restore(JSON.stringify({ v: 2, root: { orientation: 'row', children: ['a'], ratios: [1] } }), ['a']).root).toBe('a');
  const bad = JSON.stringify({ v: 2, root: { orientation: 'row', children: ['a', 'b'], ratios: [0.9, 0.9] }, focusedId: 'a' });
  expect(restore(bad, ['a', 'b']).root).toEqual(row(['a', 'b']));
});

test('phonePaneOf: empty stage yields null', () => {
  expect(phonePaneOf(null, null)).toBe(null);
  expect(phonePaneOf(null, 'a')).toBe(null);
});
test('phonePaneOf: focused pane wins when docked', () => {
  expect(phonePaneOf(row(['a', 'b']), 'b')).toBe('b');
});
test('phonePaneOf: stale or unset focus falls back to the first pane', () => {
  expect(phonePaneOf(row(['a', 'b']), 'gone')).toBe('a');
  expect(phonePaneOf(row(['a', 'b']), null)).toBe('a');
});
test('phonePaneOf: single-leaf root', () => {
  expect(phonePaneOf('a', null)).toBe('a');
});
