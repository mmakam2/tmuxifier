import { test, expect } from 'vitest';
import { gridTemplate, dividerAria, keyboardRatioStep, dropTargets, focusMove, DIVIDER_PX } from '../src/web/stagePanes.ts';

const row = (children, ratios) => ({ orientation: 'row', children, ratios: ratios ?? children.map(() => 1 / children.length) });
const col = (children, ratios) => ({ orientation: 'column', children, ratios: ratios ?? children.map(() => 1 / children.length) });

test('gridTemplate interleaves fr tracks with fixed dividers', () => {
  expect(gridTemplate(row(['a', 'b'], [0.7, 0.3]))).toBe(`0.7fr ${DIVIDER_PX}px 0.3fr`);
  expect(gridTemplate(row(['a', 'b', 'c']))).toBe(`${1 / 3}fr ${DIVIDER_PX}px ${1 / 3}fr ${DIVIDER_PX}px ${1 / 3}fr`);
});

test('dividerAria reports splitter orientation and percentage per split', () => {
  expect(dividerAria(row(['a', 'b'], [0.7, 0.3]), 0)).toEqual({ orientation: 'vertical', valuenow: 70 });
  expect(dividerAria(col(['a', 'b']), 0)).toEqual({ orientation: 'horizontal', valuenow: 50 });
});

test('keyboardRatioStep steps 5% along the split axis only', () => {
  expect(keyboardRatioStep(row(['a', 'b']), 0, 'ArrowRight')).toBeCloseTo(0.55);
  expect(keyboardRatioStep(col(['a', 'b']), 0, 'ArrowDown')).toBeCloseTo(0.55);
  expect(keyboardRatioStep(row(['a', 'b']), 0, 'ArrowDown')).toBeNull();
});

test('dropTargets: stage edges, pane edges, and replace, gated by the cap', () => {
  const targets = dropTargets(row(['a', 'b']), 'c', 4);
  expect(targets.filter((t) => t.kind === 'stage-edge')).toHaveLength(4);
  expect(targets.filter((t) => t.kind === 'pane-edge')).toHaveLength(8);
  expect(targets.filter((t) => t.kind === 'replace').map((t) => t.paneId)).toEqual(['a', 'b']);
});

test('dropTargets at the cap: replace only for a foreign box, edges stay for a docked one', () => {
  const four = col([row(['a', 'b']), row(['c', 'd'])]);
  expect(dropTargets(four, 'e', 4).every((t) => t.kind === 'replace')).toBe(true);
  expect(dropTargets(four, 'a', 4).some((t) => t.kind === 'stage-edge')).toBe(true);
  // dragged pane offers no zones on itself
  expect(dropTargets(four, 'a', 4).some((t) => t.kind !== 'stage-edge' && t.paneId === 'a')).toBe(false);
});

test('focusMove is spatial: 2-up + full-width bottom', () => {
  // a,b side by side on top; c full-width below
  const rects = [
    { id: 'a', x: 0, y: 0, w: 50, h: 50 },
    { id: 'b', x: 50, y: 0, w: 50, h: 50 },
    { id: 'c', x: 0, y: 50, w: 100, h: 50 },
  ];
  expect(focusMove(rects, 'a', 'ArrowRight')).toBe('b');
  expect(focusMove(rects, 'b', 'ArrowLeft')).toBe('a');
  expect(focusMove(rects, 'a', 'ArrowDown')).toBe('c');
  expect(focusMove(rects, 'b', 'ArrowDown')).toBe('c');
  expect(focusMove(rects, 'c', 'ArrowUp')).toBe('a'); // nearest center in that direction
  expect(focusMove(rects, 'a', 'ArrowUp')).toBeNull();
  expect(focusMove(rects, null, 'ArrowRight')).toBeNull();
});
