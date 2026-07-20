import { test, expect } from 'vitest';
import { b64uToBytes, bytesToB64u, evaluateOrigin, toRequestOptions } from '../src/web/passkeys.ts';

const base = { rpId: 'tmux.example.com', storedRpId: null, hostname: 'tmux.example.com', protocol: 'https:', hasWebAuthn: true };

test('base64url round-trips, including unpadded input', () => {
  const bytes = new Uint8Array([0, 1, 250, 255, 66]);
  expect(b64uToBytes(bytesToB64u(bytes.buffer))).toEqual(bytes);
  expect(b64uToBytes('AQID')).toEqual(new Uint8Array([1, 2, 3]));
});

test('accepts a matching secure origin', () => {
  const v = evaluateOrigin(base);
  expect(v.ok).toBe(true);
  expect(v.reason).toMatch(/tmux\.example\.com/);
});

test('reports an unsupported browser first', () => {
  const v = evaluateOrigin({ ...base, hasWebAuthn: false });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/does not support/);
});

test('reports an IP-addressed deployment with the fix', () => {
  const v = evaluateOrigin({ ...base, rpId: null });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/domain name/);
  expect(v.hint).toMatch(/TMUXIFIER_RP_ID/);
});

test('reports a store pinned to a different hostname', () => {
  const v = evaluateOrigin({ ...base, storedRpId: 'old.example.com' });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/old\.example\.com/);
  expect(v.hint).toMatch(/old\.example\.com/);
});

test('reports a hostname mismatch', () => {
  const v = evaluateOrigin({ ...base, hostname: 'localhost' });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/bound to tmux\.example\.com/);
});

test('reports an insecure context, but allows plain http on localhost', () => {
  const insecure = evaluateOrigin({ ...base, protocol: 'http:' });
  expect(insecure.ok).toBe(false);
  expect(insecure.reason).toMatch(/secure connection/);
  const local = evaluateOrigin({ rpId: 'localhost', storedRpId: null, hostname: 'localhost', protocol: 'http:', hasWebAuthn: true });
  expect(local.ok).toBe(true);
});

test('converts request options into the browser shape', () => {
  const opts = toRequestOptions({ challenge: 'AQID', rpId: 'tmux.example.com', timeout: 120000, userVerification: 'required' });
  expect(new Uint8Array(opts.challenge)).toEqual(new Uint8Array([1, 2, 3]));
  expect(opts.rpId).toBe('tmux.example.com');
  expect(opts.allowCredentials).toEqual([]);
});
