import { test, expect } from 'vitest';
import { registerModal, closeAllModals } from '../src/web/modalRegistry.ts';

test('closeAllModals closes every registered modal once and clears the registry', () => {
  const closed = [];
  registerModal(() => closed.push('a'));
  registerModal(() => closed.push('b'));
  closeAllModals();
  expect(closed.sort()).toEqual(['a', 'b']);
  closeAllModals(); // registry is cleared — nothing closes twice
  expect(closed).toHaveLength(2);
});

test('an unregistered modal is not closed', () => {
  const closed = [];
  const unregister = registerModal(() => closed.push('a'));
  registerModal(() => closed.push('b'));
  unregister();
  closeAllModals();
  expect(closed).toEqual(['b']);
});

test('one throwing closer must not strand the others', () => {
  const closed = [];
  registerModal(() => { throw new Error('boom'); });
  registerModal(() => closed.push('ok'));
  expect(() => closeAllModals()).not.toThrow();
  expect(closed).toEqual(['ok']);
});
