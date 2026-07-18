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

test('a truncated GCM auth tag is rejected, never decrypted', () => {
  const box = createSecretBox('test-secret');
  const sealed = box.seal('hunter2');
  const parts = sealed.split(':');
  const shortTag = Buffer.from(parts[3], 'base64').subarray(0, 4).toString('base64');
  const tampered = [parts[0], parts[1], parts[2], shortTag].join(':');
  expect(() => box.open(tampered)).toThrow();
});
