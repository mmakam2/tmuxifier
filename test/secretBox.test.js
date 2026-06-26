import { test, expect } from 'vitest';
import { createSecretBox } from '../src/server/secretBox.js';

test('round-trips a secret', () => {
  const box = createSecretBox('cookie-secret');
  const sealed = box.seal('PVEAPIToken=user@pam!t=uuid');
  expect(box.isSealed(sealed)).toBe(true);
  expect(sealed.startsWith('pvebox.v1:')).toBe(true);
  expect(box.open(sealed)).toBe('PVEAPIToken=user@pam!t=uuid');
});

test('produces a different ciphertext each time (random IV)', () => {
  const box = createSecretBox('cookie-secret');
  expect(box.seal('x')).not.toBe(box.seal('x'));
});

test('a tampered ciphertext fails authentication', () => {
  const box = createSecretBox('cookie-secret');
  const sealed = box.seal('secret');
  const parts = sealed.split(':');
  parts[2] = Buffer.from('different-bytes').toString('base64'); // swap ct
  expect(() => box.open(parts.join(':'))).toThrow();
});

test('a different cookie secret cannot open the sealed value', () => {
  const sealed = createSecretBox('secret-a').seal('hi');
  expect(() => createSecretBox('secret-b').open(sealed)).toThrow();
});

test('isSealed rejects plaintext and requires a cookie secret', () => {
  const box = createSecretBox('s');
  expect(box.isSealed('plain')).toBe(false);
  expect(() => createSecretBox('')).toThrow(/cookieSecret/);
});
