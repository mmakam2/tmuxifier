import { test, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createOidcClient, OidcError, pkcePair, randomState, base64url } from '../src/server/oidcAuth.js';
import { startOidcStub } from './helpers/oidcStub.js';

let stub;
beforeEach(async () => { stub = await startOidcStub(); });
afterEach(async () => { await stub.close(); });

const mk = (over = {}, prov = {}) => createOidcClient({
  provider: { id: 'p', label: 'P', issuer: stub.issuer, clientId: 'cid', clientSecret: 'sec', allowUnverifiedEmail: false, ...prov },
  redirectUri: 'https://x/cb',
  allowedEmails: ['you@example.com'],
  ...over,
});
const exchange = (c, nonce = 'N') => { stub.set({ nonce: 'N' }); return c.exchangeCode({ code: 'abc', codeVerifier: 'ver', nonce }); };
const code = async (p) => { try { await p; } catch (e) { return e.code; } return null; };

test('pkcePair challenge is the S256 hash of the verifier', () => {
  const { verifier, challenge } = pkcePair();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(challenge).toBe(base64url(createHash('sha256').update(verifier).digest()));
  expect(randomState()).not.toBe(randomState());
});

test('authorizationUrl uses the discovered endpoint with OIDC + PKCE params', async () => {
  const c = mk();
  const u = new URL(await c.authorizationUrl({ state: 'ST', nonce: 'NO', codeChallenge: 'CH' }));
  expect(u.origin + u.pathname).toBe(`${stub.issuer}/authorize`);
  const g = (k) => u.searchParams.get(k);
  expect(g('client_id')).toBe('cid');
  expect(g('redirect_uri')).toBe('https://x/cb');
  expect(g('response_type')).toBe('code');
  expect(g('scope')).toBe('openid email');
  expect(g('state')).toBe('ST');
  expect(g('nonce')).toBe('NO');
  expect(g('code_challenge')).toBe('CH');
  expect(g('code_challenge_method')).toBe('S256');
  expect(u.searchParams.has('prompt')).toBe(false);
  expect(c.id).toBe('p');
  expect(c.label).toBe('P');
});

test('happy path returns the email and posts the grant params', async () => {
  expect(await exchange(mk())).toEqual({ email: 'you@example.com' });
  const b = stub.lastTokenRequest;
  expect(b.get('grant_type')).toBe('authorization_code');
  expect(b.get('client_secret')).toBe('sec');
  expect(b.get('code_verifier')).toBe('ver');
  expect(b.get('code')).toBe('abc');
});

test.each([
  ['wrong iss', { iss: 'https://evil.example.com' }],
  ['wrong aud', { aud: 'other' }],
  ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
  ['wrong nonce', { nonce: 'other' }],
  ['unverified email', { email_verified: false }],
  ['missing email', { email: undefined }],
])('%s is forbidden', async (_n, claims) => {
  stub.set({ claims });
  expect(await code(exchange(mk()))).toBe('forbidden');
});

test('aud array containing the client id is accepted', async () => {
  stub.set({ claims: { aud: ['x', 'cid'] } });
  expect(await exchange(mk())).toEqual({ email: 'you@example.com' });
});

test('unverified email accepted with allowUnverifiedEmail', async () => {
  stub.set({ claims: { email_verified: false } });
  expect(await exchange(mk({}, { allowUnverifiedEmail: true }))).toEqual({ email: 'you@example.com' });
});

test('discovery issuer mismatch is a provider error; trailing slash is normalized', async () => {
  stub.set({ discovery: { issuer: 'https://other.example.com' } });
  expect(await code(mk().authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }))).toBe('provider');
  stub.set({ discovery: { issuer: stub.issuer + '/' } });
  await expect(mk().authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })).resolves.toContain('/authorize');
});

test('non-https discovered endpoint is a provider error', async () => {
  stub.set({ discovery: { token_endpoint: 'http://auth.example.com/token' } });
  expect(await code(exchange(mk()))).toBe('provider');
  stub.set({ discovery: { authorization_endpoint: 'http://auth.example.com/a' } });
  expect(await code(mk().authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }))).toBe('provider');
});

test('token endpoint 500 is a provider error', async () => {
  stub.set({ tokenStatus: 500 });
  const e = await exchange(mk()).catch((x) => x);
  expect(e).toBeInstanceOf(OidcError);
  expect(e.code).toBe('provider');
});

test('a discovery failure is not cached', async () => {
  let n = 0;
  const fetchImpl = (u, o) => (n++ === 0 ? Promise.reject(new Error('down')) : fetch(u, o));
  const c = mk({ fetchImpl });
  expect(await code(c.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }))).toBe('provider');
  await expect(c.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' })).resolves.toContain('/authorize');
});

test('missing id_token is a provider error', async () => {
  const fetchImpl = async (u) => (String(u).endsWith('/token')
    ? { ok: true, json: async () => ({}) }
    : fetch(u));
  expect(await code(exchange(mk({ fetchImpl })))).toBe('provider');
});

function googleFetch(claims) {
  const idp = 'https://accounts.google.com';
  return async (url, opts) => {
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return { ok: true, json: async () => ({ issuer: idp, authorization_endpoint: `${idp}/o/oauth2/v2/auth`, token_endpoint: 'https://oauth2.googleapis.com/token' }) };
    }
    const p = Buffer.from(JSON.stringify({ aud: 'cid', exp: Math.floor(Date.now() / 1000) + 300, email: 'you@example.com', email_verified: true, nonce: 'N', ...claims })).toString('base64url');
    return { ok: true, json: async () => ({ id_token: `a.${p}.b` }) };
  };
}
const gprov = { id: 'google', label: 'Google', issuer: 'https://accounts.google.com', clientId: 'cid', clientSecret: 'sec' };

test('google issuer: extra auth params and bare iss accepted', async () => {
  const c = createOidcClient({ provider: gprov, redirectUri: 'https://x/cb', allowedEmails: [], fetchImpl: googleFetch({ iss: 'accounts.google.com' }) });
  const u = new URL(await c.authorizationUrl({ state: 's', nonce: 'N', codeChallenge: 'c' }));
  expect(u.searchParams.get('access_type')).toBe('online');
  expect(u.searchParams.get('prompt')).toBe('select_account');
  expect(await c.exchangeCode({ code: 'x', codeVerifier: 'y', nonce: 'N' })).toEqual({ email: 'you@example.com' });
});

test('bare iss without scheme is forbidden for a non-google provider', async () => {
  stub.set({ claims: { iss: 'accounts.google.com' } });
  expect(await code(exchange(mk()))).toBe('forbidden');
});

test('the token exchange carries an abort signal', async () => {
  let captured;
  const base = googleFetch({ iss: 'https://accounts.google.com' });
  const fetchImpl = async (u, o) => { if (String(u).includes('token')) captured = o; return base(u, o); };
  const c = createOidcClient({ provider: gprov, redirectUri: 'https://x/cb', fetchImpl });
  await c.exchangeCode({ code: 'x', codeVerifier: 'y', nonce: 'N' });
  expect(captured.signal).toBeInstanceOf(AbortSignal);
});

test('isAllowed is case-insensitive and rejects unlisted addresses', () => {
  const c = mk({ allowedEmails: ['alice@example.com'] });
  expect(c.isAllowed('ALICE@Example.com')).toBe(true);
  expect(c.isAllowed('bob@example.com')).toBe(false);
  expect(c.isAllowed(undefined)).toBe(false);
});
