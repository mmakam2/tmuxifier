import { test, expect } from 'vitest';
import {
  b64uToBytes, bytesToB64u, evaluateOrigin, toRequestOptions,
  toCreationOptions, serializeRegistration, serializeAssertion, pk,
} from '../src/web/passkeys.ts';

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

test('reports a hostname mismatch and names both remedies in the hint', () => {
  const v = evaluateOrigin({ ...base, hostname: 'localhost' });
  expect(v.ok).toBe(false);
  expect(v.reason).toMatch(/bound to tmux\.example\.com/);
  // The default-upgrade-path remedy (set TMUXIFIER_RP_ID to the hostname
  // actually being used) must be named alongside the "open at the bound
  // hostname" one — a deployment behind a reverse proxy where rpId derived
  // to localhost otherwise has no visible fix.
  expect(v.hint).toMatch(/https:\/\/tmux\.example\.com/);
  expect(v.hint).toMatch(/TMUXIFIER_RP_ID/);
  expect(v.hint).toMatch(/localhost/);
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

test('evaluateOrigin normalizes rpId to lowercase for comparison', () => {
  const v = evaluateOrigin({ rpId: 'Tmux.Example.com', storedRpId: null, hostname: 'tmux.example.com', protocol: 'https:', hasWebAuthn: true });
  expect(v.ok).toBe(true);
});

test('evaluateOrigin normalizes storedRpId to lowercase for comparison', () => {
  const v = evaluateOrigin({ rpId: 'tmux.example.com', storedRpId: 'Tmux.Example.com', hostname: 'tmux.example.com', protocol: 'https:', hasWebAuthn: true });
  expect(v.ok).toBe(true);
});

// These three tests call the REAL serializeRegistration/serializeAssertion/
// toCreationOptions rather than hand-writing the wire shape, which is the
// exact blind spot that already hid one browser-only defect on this branch
// (commit f1f76b8: registerFinish sent a top-level id/type the server never
// read while dropping fields it did — invisible here because the old tests
// asserted a shape THEY wrote, not what the real serializer produces). As
// written before this change, these tests would still have passed if
// serializeRegistration moved `transports` out of `response`, or if
// toCreationOptions stopped decoding `user.id` — both are asserted below.

test('registerFinish sends the real serializeRegistration() output as the wire body', async () => {
  const clientDataJSON = bytesToB64u(new Uint8Array([1, 2, 3, 4]).buffer);
  const attestationObject = bytesToB64u(new Uint8Array([9, 8, 7, 6, 5]).buffer);
  // A plain object literal shaped like a PublicKeyCredential/
  // AuthenticatorAttestationResponse, with real ArrayBuffers and a
  // getTransports() stub — not a hand-written "matches the return shape" copy.
  const credential = {
    id: 'test-id',
    type: 'public-key',
    response: {
      clientDataJSON: b64uToBytes(clientDataJSON).buffer,
      attestationObject: b64uToBytes(attestationObject).buffer,
      getTransports: () => ['internal', 'hybrid'],
    },
  };

  const serialized = serializeRegistration(credential);

  let capturedRequest = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/passkeys/register/finish') capturedRequest = JSON.parse(options.body);
    return new Response(JSON.stringify({ credential: { id: 'test', label: 'test', created: 0, lastUsed: null, transports: [] } }), { status: 200 });
  };
  try {
    await pk.registerFinish('my-passkey', serialized);

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest.label).toBe('my-passkey');
    // registerFinish sends only {label, response} — the server derives the
    // credential id from the attestation object itself, never req.body.id.
    expect(Object.keys(capturedRequest).sort()).toEqual(['label', 'response']);
    expect(capturedRequest.response.clientDataJSON).toBe(clientDataJSON);
    expect(capturedRequest.response.attestationObject).toBe(attestationObject);
    // Must stay inside `response` — a real browser's server route reads
    // req.body.response.transports; if this moved up a level the server
    // would silently store an empty transports list forever.
    expect(capturedRequest.response.transports).toEqual(['internal', 'hybrid']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('loginFinish sends the real serializeAssertion() output as the wire body', async () => {
  const clientDataJSON = bytesToB64u(new Uint8Array([1, 1, 2, 3, 5]).buffer);
  const authenticatorData = bytesToB64u(new Uint8Array([9, 9, 8, 7]).buffer);
  const signature = bytesToB64u(new Uint8Array([4, 2]).buffer);
  const userHandle = bytesToB64u(new Uint8Array([6, 6, 6]).buffer);
  const credential = {
    id: 'test-id',
    type: 'public-key',
    response: {
      clientDataJSON: b64uToBytes(clientDataJSON).buffer,
      authenticatorData: b64uToBytes(authenticatorData).buffer,
      signature: b64uToBytes(signature).buffer,
      userHandle: b64uToBytes(userHandle).buffer,
    },
  };

  const serialized = serializeAssertion(credential);

  let capturedRequest = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/passkey/login/finish') capturedRequest = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await pk.loginFinish(serialized);

    expect(capturedRequest).not.toBeNull();
    // loginFinish sends the whole assertion at the top level — the server
    // looks up the credential by req.body.id.
    expect(capturedRequest.id).toBe('test-id');
    expect(capturedRequest.type).toBe('public-key');
    expect(capturedRequest.response.clientDataJSON).toBe(clientDataJSON);
    expect(capturedRequest.response.authenticatorData).toBe(authenticatorData);
    expect(capturedRequest.response.signature).toBe(signature);
    expect(capturedRequest.response.userHandle).toBe(userHandle);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('serializeAssertion sends a null userHandle through as null, not an encoded empty buffer', () => {
  const credential = {
    id: 'test-id',
    type: 'public-key',
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      authenticatorData: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer,
      userHandle: null,
    },
  };
  expect(serializeAssertion(credential).response.userHandle).toBeNull();
});

test('toCreationOptions decodes challenge, user.id and excludeCredentials ids to bytes', () => {
  const challengeBytes = new Uint8Array([10, 20, 30, 40]);
  const userIdBytes = new Uint8Array([1, 2, 3, 4, 5]);
  const excludeIdBytes = new Uint8Array([9, 9, 9]);
  const json = {
    challenge: bytesToB64u(challengeBytes.buffer),
    rp: { id: 'tmux.example.com', name: 'Tmuxifier' },
    user: { id: bytesToB64u(userIdBytes.buffer), name: 'tmuxifier@tmux.example.com', displayName: 'Tmuxifier' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    timeout: 120000,
    excludeCredentials: [{ id: bytesToB64u(excludeIdBytes.buffer), transports: ['internal'] }],
  };

  const opts = toCreationOptions(json);

  expect(new Uint8Array(opts.challenge)).toEqual(challengeBytes);
  expect(new Uint8Array(opts.user.id)).toEqual(userIdBytes);
  expect(opts.user.name).toBe('tmuxifier@tmux.example.com');
  expect(opts.user.displayName).toBe('Tmuxifier');
  expect(opts.rp).toEqual({ id: 'tmux.example.com', name: 'Tmuxifier' });
  expect(opts.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
  expect(opts.attestation).toBe('none');
  expect(opts.timeout).toBe(120000);
  expect(opts.excludeCredentials).toHaveLength(1);
  expect(opts.excludeCredentials[0].type).toBe('public-key');
  expect(new Uint8Array(opts.excludeCredentials[0].id)).toEqual(excludeIdBytes);
  expect(opts.excludeCredentials[0].transports).toEqual(['internal']);
});

test('toCreationOptions defaults excludeCredentials to empty when omitted', () => {
  const json = {
    challenge: bytesToB64u(new Uint8Array([1]).buffer),
    rp: { id: 'tmux.example.com', name: 'Tmuxifier' },
    user: { id: bytesToB64u(new Uint8Array([2]).buffer), name: 'a', displayName: 'b' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    timeout: 120000,
    excludeCredentials: undefined,
  };
  expect(toCreationOptions(json).excludeCredentials).toEqual([]);
});
