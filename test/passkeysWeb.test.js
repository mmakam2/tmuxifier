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

test('evaluateOrigin normalizes rpId to lowercase for comparison', () => {
  const v = evaluateOrigin({ rpId: 'Tmux.Example.com', storedRpId: null, hostname: 'tmux.example.com', protocol: 'https:', hasWebAuthn: true });
  expect(v.ok).toBe(true);
});

test('evaluateOrigin normalizes storedRpId to lowercase for comparison', () => {
  const v = evaluateOrigin({ rpId: 'tmux.example.com', storedRpId: 'Tmux.Example.com', hostname: 'tmux.example.com', protocol: 'https:', hasWebAuthn: true });
  expect(v.ok).toBe(true);
});

test('registerFinish sends correctly-shaped body with full serialized credential', async () => {
  let capturedRequest = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/passkeys/register/finish') {
      capturedRequest = JSON.parse(options.body);
    }
    return new Response(JSON.stringify({ credential: { id: 'test', label: 'test', created: 0, lastUsed: null, transports: [] } }), { status: 200 });
  };

  try {
    // Create a mock serialized credential matching serializeRegistration's return shape
    const credential = {
      id: 'test-id',
      type: 'public-key',
      response: {
        clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0',
        attestationObject: 'o2NmbXRmbm9uZWdhdHRTdG10oGhhdXRoRGF0YQ',
        transports: ['internal'],
      },
    };

    // Simulate the pk.registerFinish call
    const label = 'my-passkey';
    await import('../src/web/passkeys.ts').then(({ pk }) =>
      pk.registerFinish(label, credential),
    );

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest.label).toBe('my-passkey');
    expect(capturedRequest.response).toBeDefined();
    expect(capturedRequest.response.clientDataJSON).toBe('eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0');
    expect(capturedRequest.response.attestationObject).toBe('o2NmbXRmbm9uZWdhdHRTdG10oGhhdXRoRGF0YQ');
    expect(capturedRequest.response.transports).toEqual(['internal']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('loginFinish sends correctly-shaped body with full serialized credential', async () => {
  let capturedRequest = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/passkey/login/finish') {
      capturedRequest = JSON.parse(options.body);
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    // Create a mock serialized assertion matching serializeAssertion's return shape
    const assertion = {
      id: 'test-id',
      type: 'public-key',
      response: {
        clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
        authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4',
        signature: 'MEUCIQCz-tLWXV41im-oApP9ltIw2o',
        userHandle: null,
      },
    };

    await import('../src/web/passkeys.ts').then(({ pk }) =>
      pk.loginFinish(assertion),
    );

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest.id).toBe('test-id');
    expect(capturedRequest.response).toBeDefined();
    expect(capturedRequest.response.clientDataJSON).toBe('eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0');
    expect(capturedRequest.response.authenticatorData).toBe('SZYN5YgOjGh0NBcPZHZgW4');
    expect(capturedRequest.response.signature).toBe('MEUCIQCz-tLWXV41im-oApP9ltIw2o');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
