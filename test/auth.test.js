import { test, expect } from 'vitest';
import { hashPassword, verifyPassword, COOKIE_NAME, cookieOptions, sessionValue, sessionValueValid, SESSION_TTL_SECONDS } from '../src/server/auth.js';

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

// The session cookie used to be the constant string 'ok' — identical for every
// login, forever. A cookie captured once (HAR file, backup, shoulder-surfed
// devtools) authenticated until the cookie secret was manually rotated. The
// value now embeds its issue time and is rejected once older than the TTL.
test('session value embeds an issue time and round-trips while fresh', () => {
  const v = sessionValue();
  expect(v).toMatch(/^ok\.\d+$/);
  expect(sessionValueValid(v)).toBe(true);
});

test('an expired session value is rejected', () => {
  const issued = Date.now() - (SESSION_TTL_SECONDS + 60) * 1000;
  expect(sessionValueValid(sessionValue(issued))).toBe(false);
});

test('a session value from just inside the TTL is still accepted', () => {
  const issued = Date.now() - (SESSION_TTL_SECONDS - 60) * 1000;
  expect(sessionValueValid(sessionValue(issued))).toBe(true);
});

test('the legacy constant "ok" and malformed values are rejected', () => {
  expect(sessionValueValid('ok')).toBe(false);        // pre-TTL cookie format
  expect(sessionValueValid('')).toBe(false);
  expect(sessionValueValid(undefined)).toBe(false);
  expect(sessionValueValid('ok.')).toBe(false);
  expect(sessionValueValid('ok.notanumber')).toBe(false);
  expect(sessionValueValid('nope.12345')).toBe(false);
  expect(sessionValueValid(`ok.${'9'.repeat(30)}`)).toBe(false); // absurd future stamp
});

test('a far-future session value is rejected (beyond clock-skew allowance)', () => {
  expect(sessionValueValid(sessionValue(Date.now() + 3600 * 1000))).toBe(false);
});

test('cookie maxAge matches the server-side session TTL', () => {
  expect(cookieOptions(true).maxAge).toBe(SESSION_TTL_SECONDS);
});

test('a cookie issued before the invalidation watermark is rejected (logout revocation)', () => {
  const v = sessionValue(1_000_000_000_000);
  expect(sessionValueValid(v, 1_000_000_100_000)).toBe(true);
  expect(sessionValueValid(v, 1_000_000_100_000, { notBeforeMs: 1_000_000_050_000 })).toBe(false);
  const fresh = sessionValue(1_000_000_060_000);
  expect(sessionValueValid(fresh, 1_000_000_100_000, { notBeforeMs: 1_000_000_050_000 })).toBe(true);
});
