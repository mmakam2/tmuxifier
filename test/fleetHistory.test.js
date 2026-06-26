import { test, expect } from 'vitest';
import { addRecent, parseRecent } from '../src/web/fleetHistory.ts';

test('addRecent moves a repeated command to the front (deduped) and caps length', () => {
  let list = [];
  list = addRecent(list, 'a');
  list = addRecent(list, 'b');
  list = addRecent(list, 'a');           // dedup -> front
  expect(list).toEqual(['a', 'b']);
  const capped = addRecent(['1', '2', '3'], '4', 3);
  expect(capped).toEqual(['4', '1', '2']);
});

test('addRecent ignores blank commands but still caps the existing list', () => {
  expect(addRecent(['a', 'b'], '   ')).toEqual(['a', 'b']);
  expect(addRecent(['a', 'b', 'c'], '', 2)).toEqual(['a', 'b']);
});

test('parseRecent reads a JSON array and tolerates garbage', () => {
  expect(parseRecent(JSON.stringify(['a', 'b']))).toEqual(['a', 'b']);
  expect(parseRecent(null)).toEqual([]);
  expect(parseRecent('not json')).toEqual([]);
  expect(parseRecent(JSON.stringify(['a', 1, null, 'b']))).toEqual(['a', 'b']);
  expect(parseRecent(JSON.stringify(['a', 'b', 'c']), 2)).toEqual(['a', 'b']);
});
