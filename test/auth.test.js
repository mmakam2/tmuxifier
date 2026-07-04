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

// Buffer.from(hex) silently stops at the first invalid character, so a corrupted
// digest used to become a zero-length buffer — and scrypt would happily derive a
// zero-length key, making timingSafeEqual(empty, empty) accept ANY password.
// The login gate must fail closed on a corrupt hash, never open.
test('a corrupted stored hash fails closed, never open', async () => {
  expect(await verifyPassword('anything', 'scrypt$abcd$zz')).toBe(false);   // non-hex digest
  expect(await verifyPassword('anything', 'scrypt$abcd$abcd')).toBe(false); // hex but far too short
  expect(await verifyPassword('anything', `scrypt$zz$${'ab'.repeat(32)}`)).toBe(false); // non-hex salt
  const stored = await hashPassword('right');
  expect(await verifyPassword('right', stored.slice(0, -1))).toBe(false);   // truncated to odd length
  expect(await verifyPassword('right', stored.slice(0, -2))).toBe(false);   // truncated digest
});
