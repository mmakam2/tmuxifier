import { test, expect } from 'vitest';
import { hashPassword, verifyPassword, COOKIE_NAME } from '../src/server/auth.js';

test('hash then verify round-trips', async () => {
  const stored = await hashPassword('s3cret');
  expect(stored.startsWith('scrypt$')).toBe(true);
  expect(await verifyPassword('s3cret', stored)).toBe(true);
});

test('wrong password fails', async () => {
  const stored = await hashPassword('s3cret');
  expect(await verifyPassword('nope', stored)).toBe(false);
});

test('malformed stored value fails safely', async () => {
  expect(await verifyPassword('x', 'garbage')).toBe(false);
  expect(COOKIE_NAME).toBe('tmuxifier_session');
});
