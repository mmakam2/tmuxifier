import { test, expect } from 'vitest';
import { emptyLayout, singleLayout, dockPane, undockPane } from '../src/web/stageLayout.ts';

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
