import { test, expect } from 'vitest';
import { toggleBox, setBoxes, groupState } from '../src/web/fleetSelection.ts';

test('toggleBox adds then removes an id without mutating the input', () => {
  const a = new Set();
  const b = toggleBox(a, 'x');
  expect([...b]).toEqual(['x']);
  expect([...a]).toEqual([]);        // original untouched
  expect([...toggleBox(b, 'x')]).toEqual([]);
});

test('setBoxes turns a group of ids on and off', () => {
  const on = setBoxes(new Set(['z']), ['a', 'b'], true);
  expect([...on].sort()).toEqual(['a', 'b', 'z']);
  const off = setBoxes(on, ['a', 'b'], false);
  expect([...off]).toEqual(['z']);
});

test('groupState reflects none / some / all', () => {
  expect(groupState(new Set(), ['a', 'b'])).toBe('none');
  expect(groupState(new Set(['a']), ['a', 'b'])).toBe('some');
  expect(groupState(new Set(['a', 'b']), ['a', 'b'])).toBe('all');
  expect(groupState(new Set(), [])).toBe('none'); // empty group
});
