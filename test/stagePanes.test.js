import { test, expect } from 'vitest';
import { gridTemplate, dividerAria, keyboardRatioStep, dropTargets, focusMove, DIVIDER_PX } from '../src/web/stagePanes.ts';

const split = (ratios = [0.5, 0.5], orientation = 'row') => ({ orientation, panes: ['a', 'b'], ratios });

test('gridTemplate interleaves fr tracks with fixed dividers', () => {
  expect(gridTemplate(split([0.7, 0.3]))).toBe(`0.7fr ${DIVIDER_PX}px 0.3fr`);
  expect(gridTemplate({ orientation: 'row', panes: ['a'], ratios: [1] })).toBe('1fr');
});

test('dividerAria reports splitter orientation and percentage', () => {
  expect(dividerAria(split([0.7, 0.3]), 0)).toEqual({ orientation: 'vertical', valuenow: 70 });
  expect(dividerAria(split([0.5, 0.5], 'column'), 0)).toEqual({ orientation: 'horizontal', valuenow: 50 });
});

test('keyboardRatioStep grows/shrinks by 5% along the split axis only', () => {
  expect(keyboardRatioStep(split(), 0, 'ArrowRight')).toBeCloseTo(0.55);
  expect(keyboardRatioStep(split(), 0, 'ArrowLeft')).toBeCloseTo(0.45);
  expect(keyboardRatioStep(split(), 0, 'ArrowDown')).toBeNull();
  expect(keyboardRatioStep(split([0.5, 0.5], 'column'), 0, 'ArrowDown')).toBeCloseTo(0.55);
  expect(keyboardRatioStep(split(), 0, 'Enter')).toBeNull();
});

test('dropTargets: edges gated by the cap, pane targets exclude the dragged box', () => {
  const single = { orientation: 'row', panes: ['a'], ratios: [1] };
  expect(dropTargets(single, 'b', 2)).toEqual([
    { kind: 'edge', edge: 'left' }, { kind: 'edge', edge: 'right' },
    { kind: 'edge', edge: 'top' }, { kind: 'edge', edge: 'bottom' },
    { kind: 'pane', index: 0 },
  ]);
  // full stage, foreign box: replace-only (no edges)
  expect(dropTargets(split(), 'c', 2)).toEqual([{ kind: 'pane', index: 0 }, { kind: 'pane', index: 1 }]);
  // full stage, docked box: edges (move) + the other pane (swap)
  expect(dropTargets(split(), 'a', 2)).toEqual([
    { kind: 'edge', edge: 'left' }, { kind: 'edge', edge: 'right' },
    { kind: 'edge', edge: 'top' }, { kind: 'edge', edge: 'bottom' },
    { kind: 'pane', index: 1 },
  ]);
});

test('focusMove walks panes along the split axis and returns null at the rim', () => {
  expect(focusMove(split(), 'a', 'ArrowRight')).toBe('b');
  expect(focusMove(split(), 'b', 'ArrowRight')).toBeNull();
  expect(focusMove(split(), 'b', 'ArrowLeft')).toBe('a');
  expect(focusMove(split([0.5, 0.5], 'column'), 'a', 'ArrowDown')).toBe('b');
  expect(focusMove({ orientation: 'row', panes: ['a'], ratios: [1] }, 'a', 'ArrowRight')).toBeNull();
});
