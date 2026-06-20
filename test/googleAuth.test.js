import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createGoogleAuth, pkcePair, randomState, base64url } from '../src/server/googleAuth.js';

function makeIdToken(payload) {
  const h = base64url(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })));
  const p = base64url(Buffer.from(JSON.stringify(payload)));
  return `${h}.${p}.sig`;
}

test('pkcePair challenge is the S256 hash of the verifier', () => {
  const { verifier, challenge } = pkcePair();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  const expected = base64url(createHash('sha256').update(verifier).digest());
  expect(challenge).toBe(expected);
  expect(randomState()).not.toBe(randomState());
});

test('authorizationUrl carries the OIDC + PKCE params', () => {
  const g = createGoogleAuth({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb', allowedEmails: [] });
  const u = new URL(g.authorizationUrl({ state: 'ST', codeChallenge: 'CH' }));
  expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(u.searchParams.get('client_id')).toBe('cid');
  expect(u.searchParams.get('redirect_uri')).toBe('https://x/cb');
  expect(u.searchParams.get('response_type')).toBe('code');
  expect(u.searchParams.get('scope')).toBe('openid email');
  expect(u.searchParams.get('state')).toBe('ST');
  expect(u.searchParams.get('code_challenge')).toBe('CH');
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
});

test('exchangeCodeForEmail posts the code+verifier and decodes the id_token', async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ id_token: makeIdToken({ email: 'Alice@Example.com', email_verified: true }) }) };
  };
  const g = createGoogleAuth({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb', allowedEmails: [], fetchImpl });
  const r = await g.exchangeCodeForEmail({ code: 'abc', codeVerifier: 'ver' });
  expect(r).toEqual({ email: 'Alice@Example.com', emailVerified: true });
  expect(captured.url).toBe('https://oauth2.googleapis.com/token');
  const body = new URLSearchParams(captured.opts.body);
  expect(body.get('code')).toBe('abc');
  expect(body.get('code_verifier')).toBe('ver');
  expect(body.get('grant_type')).toBe('authorization_code');
  expect(body.get('client_secret')).toBe('sec');
});

test('exchangeCodeForEmail throws on a non-OK token response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({}) });
  const g = createGoogleAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', allowedEmails: [], fetchImpl });
  await expect(g.exchangeCodeForEmail({ code: 'x', codeVerifier: 'y' })).rejects.toThrow();
});

test('isAllowed is case-insensitive and rejects unlisted addresses', () => {
  const g = createGoogleAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', allowedEmails: ['alice@example.com'] });
  expect(g.isAllowed('ALICE@Example.com')).toBe(true);
  expect(g.isAllowed('bob@example.com')).toBe(false);
  expect(g.isAllowed(undefined)).toBe(false);
});
