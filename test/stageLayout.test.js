import { test, expect } from 'vitest';
import { emptyLayout, singleLayout, dockPane, undockPane, replacePane, swapPanes, setRatio, toggleOrientation, serialize, restore, MIN_RATIO } from '../src/web/stageLayout.ts';

const split = () => ({ orientation: 'row', panes: ['a', 'b'], ratios: [0.5, 0.5] });

test('emptyLayout and singleLayout are the degenerate cases', () => {
  expect(emptyLayout()).toEqual({ orientation: 'row', panes: [], ratios: [] });
  expect(singleLayout('a')).toEqual({ orientation: 'row', panes: ['a'], ratios: [1] });
});

test('docking on a horizontal edge makes a row split; the edge picks the position', () => {
  const l = singleLayout('a');
  expect(dockPane(l, 'b', 'right')).toEqual({ orientation: 'row', panes: ['a', 'b'], ratios: [0.5, 0.5] });
  expect(dockPane(l, 'b', 'left')).toEqual({ orientation: 'row', panes: ['b', 'a'], ratios: [0.5, 0.5] });
});

test('docking on a vertical edge makes a column split', () => {
  const l = singleLayout('a');
  expect(dockPane(l, 'b', 'bottom')).toEqual({ orientation: 'column', panes: ['a', 'b'], ratios: [0.5, 0.5] });
  expect(dockPane(l, 'b', 'top')).toEqual({ orientation: 'column', panes: ['b', 'a'], ratios: [0.5, 0.5] });
});

test('docking an already-docked box moves it instead of duplicating', () => {
  const l = { orientation: 'row', panes: ['a', 'b'], ratios: [0.5, 0.5] };
  expect(dockPane(l, 'a', 'right')).toEqual({ orientation: 'row', panes: ['b', 'a'], ratios: [0.5, 0.5] });
});

test('docking onto the empty stage yields a single pane', () => {
  expect(dockPane(emptyLayout(), 'a', 'left')).toEqual({ orientation: 'row', panes: ['a'], ratios: [1] });
});

test('undocking removes the pane and re-evens the rest; unknown id is a no-op', () => {
  const l = { orientation: 'row', panes: ['a', 'b'], ratios: [0.7, 0.3] };
  expect(undockPane(l, 'a')).toEqual({ orientation: 'row', panes: ['b'], ratios: [1] });
  expect(undockPane(l, 'zz')).toEqual(l);
});

test('replacePane substitutes in place; replacing with a docked box swaps instead', () => {
  expect(replacePane(split(), 'a', 'c').panes).toEqual(['c', 'b']);
  expect(replacePane(split(), 'a', 'b').panes).toEqual(['b', 'a']);
  expect(replacePane(split(), 'zz', 'c')).toEqual(split());
});

test('swapPanes exchanges positions and keeps ratios by position', () => {
  const l = { orientation: 'row', panes: ['a', 'b'], ratios: [0.7, 0.3] };
  expect(swapPanes(l, 'a', 'b')).toEqual({ orientation: 'row', panes: ['b', 'a'], ratios: [0.7, 0.3] });
  expect(swapPanes(l, 'a', 'zz')).toEqual(l);
});

test('setRatio moves the divider and clamps both sides at MIN_RATIO', () => {
  expect(setRatio(split(), 0, 0.7).ratios).toEqual([0.7, 0.3]);
  expect(setRatio(split(), 0, 0.05).ratios).toEqual([MIN_RATIO, 1 - MIN_RATIO]);
  expect(setRatio(split(), 0, 0.99).ratios).toEqual([1 - MIN_RATIO, MIN_RATIO]);
  expect(setRatio(split(), 5, 0.7)).toEqual(split()); // no such divider: no-op
});

test('toggleOrientation flips row/column and nothing else', () => {
  expect(toggleOrientation(split()).orientation).toBe('column');
  expect(toggleOrientation(toggleOrientation(split()))).toEqual(split());
});

test('serialize/restore round-trips a split, ratios and focus included', () => {
  const l = { orientation: 'column', panes: ['a', 'b'], ratios: [0.7, 0.3] };
  expect(restore(serialize(l, 'b'), ['a', 'b', 'c'])).toEqual({ layout: l, focusedId: 'b' });
});

test('restore prunes vanished boxes, re-evens ratios, and moves focus to the first survivor', () => {
  const l = { orientation: 'row', panes: ['a', 'gone'], ratios: [0.7, 0.3] };
  expect(restore(serialize(l, 'gone'), ['a'])).toEqual({
    layout: { orientation: 'row', panes: ['a'], ratios: [1] },
    focusedId: 'a',
  });
});

test('restore falls back to the empty layout on null, garbage, or wrong shape', () => {
  const fallback = { layout: emptyLayout(), focusedId: null };
  expect(restore(null, ['a'])).toEqual(fallback);
  expect(restore('not json', ['a'])).toEqual(fallback);
  expect(restore(JSON.stringify({ v: 99 }), ['a'])).toEqual(fallback);
  expect(restore(JSON.stringify({ v: 1, layout: { panes: 'nope' } }), ['a'])).toEqual(fallback);
});

test('restore rejects corrupt ratios by re-evening them', () => {
  const raw = JSON.stringify({ v: 1, layout: { orientation: 'row', panes: ['a', 'b'], ratios: [2, -1] }, focusedId: 'a' });
  expect(restore(raw, ['a', 'b']).layout.ratios).toEqual([0.5, 0.5]);
});
