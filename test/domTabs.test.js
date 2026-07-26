import { test, expect } from 'vitest';
import { nextTabKey } from '../src/web/dom.ts';

test('ArrowRight moves to the next tab and wraps at the end', () => {
  expect(nextTabKey(['boxes', 'netbox', 'voice'], 'boxes', 'ArrowRight')).toBe('netbox');
  expect(nextTabKey(['boxes', 'netbox', 'voice'], 'voice', 'ArrowRight')).toBe('boxes');
});

test('ArrowLeft moves to the previous tab and wraps at the start', () => {
  expect(nextTabKey(['boxes', 'netbox', 'voice'], 'netbox', 'ArrowLeft')).toBe('boxes');
  expect(nextTabKey(['boxes', 'netbox', 'voice'], 'boxes', 'ArrowLeft')).toBe('voice');
});

test('Home and End jump to the edges', () => {
  expect(nextTabKey(['a', 'b', 'c'], 'b', 'Home')).toBe('a');
  expect(nextTabKey(['a', 'b', 'c'], 'b', 'End')).toBe('c');
});

test('non-navigation keys return null so the strip never swallows them', () => {
  expect(nextTabKey(['a', 'b'], 'a', 'Tab')).toBe(null);
  expect(nextTabKey(['a', 'b'], 'a', 'Enter')).toBe(null);
  expect(nextTabKey(['a', 'b'], 'a', 'ArrowDown')).toBe(null);
});

test('an unknown current tab lands on the first tab, and empty strips return null', () => {
  expect(nextTabKey(['a', 'b'], 'zz', 'ArrowRight')).toBe('a');
  expect(nextTabKey([], 'a', 'ArrowRight')).toBe(null);
});
