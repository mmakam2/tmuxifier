import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createPasskeyStore } from '../src/server/passkeyStore.js';
import { createDeviceStore } from '../src/server/deviceStore.js';
import { hashPassword } from '../src/server/auth.js';
import { loadConfig } from '../src/server/config.js';
import { createOidcClient } from '../src/server/oidcAuth.js';
import { startOidcStub } from './helpers/oidcStub.js';

const PUBLIC = 'https://tmux.example.com';
let stub, stub2, dir;

beforeEach(async () => {
  stub = await startOidcStub();
  stub2 = await startOidcStub();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-oidc-'));
});
afterEach(async () => { await stub.close(); await stub2.close(); });

const prov = (id, issuer, extra = {}) => ({ id, label: id, issuer, clientId: 'cid', clientSecret: 's3cr3t-oidc', allowUnverifiedEmail: false, legacyGoogle: false, allowedEmails: ['you@example.com'], ...extra });

async function makeApp({ providers, config: extra = {}, ...overrides } = {}) {
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    authMode: 'oidc', cookieSecret: 'test-secret', secureCookie: false, publicUrl: PUBLIC,
    oidcProviders: providers ?? [prov('authentik', stub.issuer)], allowedEmails: ['you@example.com'],
    dataDir: dir, sshConfigPath: path.join(dir, 'nope'), ...extra,
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const statusChecker = { checkBox: async () => ({ reachable: true }) };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  return buildServer({ config, store, sessions, statusChecker, ...overrides });
}

async function flow(app, loginUrl, callbackUrl, { tamperState = false, setNonce = true, stubObj = stub } = {}) {
  const login = await app.inject({ method: 'GET', url: loginUrl });
  const cookie = login.cookies.find((c) => c.name === 'tmuxifier_oauth');
  const loc = new URL(login.headers.location);
  if (setNonce) stubObj.set({ nonce: loc.searchParams.get('nonce') });
  const state = tamperState ? 'WRONG' : loc.searchParams.get('state');
  const cb = await app.inject({
    method: 'GET', url: `${callbackUrl}?code=abc&state=${encodeURIComponent(state)}`,
    headers: cookie ? { cookie: `tmuxifier_oauth=${cookie.value}` } : {},
  });
  return { login, loc, cookie, cb };
}
const session = (res) => res.cookies.find((c) => c.name === 'tmuxifier_session');

test('authentik round trip sets session and redirects /', async () => {
  const app = await makeApp();
  const { loc, cb } = await flow(app, '/api/auth/oidc/authentik/login', '/api/auth/oidc/authentik/callback');
  expect(loc.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/api/auth/oidc/authentik/callback`);
  expect(cb.statusCode).toBe(302);
  expect(cb.headers.location).toBe('/');
  expect(session(cb)).toBeTruthy();
});

test('legacy google provider uses /api/auth/google callback on both URLs', async () => {
  const app = await makeApp({ providers: [prov('google', stub.issuer, { legacyGoogle: true, label: 'Google' })] });
  const a = await flow(app, '/api/auth/google/login', '/api/auth/google/callback');
  expect(a.loc.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/api/auth/google/callback`);
  expect(session(a.cb)).toBeTruthy();
  const b = await app.inject({ method: 'GET', url: '/api/auth/oidc/google/login' });
  expect(new URL(b.headers.location).searchParams.get('redirect_uri')).toBe(`${PUBLIC}/api/auth/google/callback`);
});

test('unknown provider id is 404', async () => {
  const app = await makeApp();
  expect((await app.inject({ method: 'GET', url: '/api/auth/oidc/nope/login' })).statusCode).toBe(404);
});

test('cookie from provider a is rejected at provider b callback', async () => {
  const app = await makeApp({ providers: [prov('a', stub.issuer), prov('b', stub2.issuer)] });
  const { cb } = await flow(app, '/api/auth/oidc/a/login', '/api/auth/oidc/b/callback');
  expect(cb.headers.location).toBe('/?error=state');
  expect(session(cb)).toBeFalsy();
});

test('tampered state, disallowed email, token failure map to error codes', async () => {
  const app = await makeApp();
  const L = '/api/auth/oidc/authentik/login', C = '/api/auth/oidc/authentik/callback';
  expect((await flow(app, L, C, { tamperState: true })).cb.headers.location).toBe('/?error=state');
  stub.set({ claims: { email: 'mallory@example.com' } });
  expect((await flow(app, L, C)).cb.headers.location).toBe('/?error=forbidden');
  stub.set({ claims: {}, tokenStatus: 500 });
  const r = await flow(app, L, C);
  expect(r.cb.headers.location).toBe('/?error=provider');
  expect(session(r.cb)).toBeFalsy();
});

test('allowlist is per provider', async () => {
  const app = await makeApp({ providers: [prov('a', stub.issuer, { allowedEmails: ['a@example.com'] }), prov('b', stub2.issuer, { allowedEmails: ['g@example.com'] })] });
  const run = async (id, email, stubObj) => {
    stubObj.set({ claims: { email } });
    return flow(app, `/api/auth/oidc/${id}/login`, `/api/auth/oidc/${id}/callback`, { stubObj });
  };
  const ok = await run('a', 'a@example.com', stub);
  expect(ok.cb.headers.location).toBe('/');
  expect(session(ok.cb)).toBeTruthy();
  expect((await run('b', 'a@example.com', stub2)).cb.headers.location).toBe('/?error=forbidden');
  expect((await run('a', 'g@example.com', stub)).cb.headers.location).toBe('/?error=forbidden');
  expect(session((await run('b', 'g@example.com', stub2)).cb)).toBeTruthy();
});

test('unverified email and nonce mismatch are forbidden', async () => {
  const app = await makeApp();
  const L = '/api/auth/oidc/authentik/login', C = '/api/auth/oidc/authentik/callback';
  stub.set({ claims: { email_verified: false } });
  expect((await flow(app, L, C)).cb.headers.location).toBe('/?error=forbidden');
  stub.set({ claims: {} });
  stub.set({ nonce: 'other' });
  const r2 = await flow(app, L, C, { setNonce: false });
  expect(r2.cb.headers.location).toBe('/?error=forbidden');
  expect(session(r2.cb)).toBeFalsy();
});

test('unreachable discovery builds and redirects to provider error', async () => {
  const app = await makeApp({ providers: [prov('x', 'http://127.0.0.1:1')] });
  const res = await app.inject({ method: 'GET', url: '/api/auth/oidc/x/login' });
  expect(res.headers.location).toBe('/?error=provider');
});

test('passkey-only armed blocks login and callback', async () => {
  const passkeyStore = createPasskeyStore({ dataDir: dir });
  await passkeyStore.add({ id: 'cred', publicKey: 'AA', alg: -7, signCount: 0, label: 'k', transports: [] }, { rpId: 'tmux.example.com' });
  const app = await makeApp({ passkeyStore, config: { rpId: 'tmux.example.com', rpIdError: null, passkeyOnlyKillSwitch: false } });
  await passkeyStore.setPasskeyOnly(true);
  const info = (await app.inject({ method: 'GET', url: '/api/auth/info' })).json();
  expect(info.passkey.only).toBe(true);
  const login = await app.inject({ method: 'GET', url: '/api/auth/oidc/authentik/login' });
  const cb = await app.inject({ method: 'GET', url: '/api/auth/oidc/authentik/callback?code=c&state=s' });
  expect(login.headers.location).toBe('/?error=passkey-only');
  expect(cb.headers.location).toBe('/?error=passkey-only');
});

test('oidc mode has no password login route, with or without a hash or the passkey kill switch', async () => {
  const passwordHash = await hashPassword('pw');
  for (const config of [{}, { passwordHash }, { passwordHash, passkeyOnlyKillSwitch: true }]) {
    const app = await makeApp({ config });
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
    expect(res.statusCode).toBe(404);
    expect(session(res)).toBeFalsy();
  }
});

test('password mode login is unchanged', async () => {
  const passwordHash = await hashPassword('pw');
  const pwMode = await makeApp({ config: { authMode: 'password', passwordHash, oidcProviders: [] } });
  expect((await pwMode.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(200);
  expect((await pwMode.inject({ method: 'POST', url: '/api/login', payload: { password: 'bad' } })).statusCode).toBe(401);
  expect((await pwMode.inject({ method: 'GET', url: '/api/auth/info' })).json()).toMatchObject({ mode: 'password', providers: [] });
  expect((await pwMode.inject({ method: 'GET', url: '/api/auth/info' })).json()).not.toHaveProperty('password');
  const oidc = await makeApp({ config: { passwordHash } });
  expect((await oidc.inject({ method: 'GET', url: '/api/auth/info' })).json()).not.toHaveProperty('password');
});

test('auth info lists providers without issuer or secret', async () => {
  const app = await makeApp({ providers: [prov('authentik', stub.issuer, { label: 'Authentik' }), prov('google', stub2.issuer, { label: 'Google', legacyGoogle: true })] });
  const res = await app.inject({ method: 'GET', url: '/api/auth/info' });
  const body = res.json();
  expect(body.mode).toBe('oidc');
  expect(body.providers).toEqual([{ id: 'authentik', label: 'Authentik', legacy: false, google: false }, { id: 'google', label: 'Google', legacy: true, google: false }]);
  expect(res.body).not.toContain('127.0.0.1:');
  expect(res.body).not.toContain('s3cr3t-oidc');
});

test('device password enroll is 501 in oidc mode', async () => {
  const passwordHash = await hashPassword('pw');
  const app = await makeApp({ config: { passwordHash }, deviceStore: createDeviceStore({ dataDir: dir }) });
  const res = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'x' } });
  expect(res.statusCode).toBe(501);
  expect(res.json().error).toBe('device enrollment by password is off in OIDC mode; use a pairing code');
});

test('legacy google env config boots and keeps the old redirect URI', async () => {
  const config = loadConfig({}, { env: {
    TMUXIFIER_AUTH_MODE: 'google', TMUXIFIER_GOOGLE_CLIENT_ID: 'cid', TMUXIFIER_GOOGLE_CLIENT_SECRET: 's',
    TMUXIFIER_PUBLIC_URL: 'tmux.example.com', TMUXIFIER_ALLOWED_EMAILS: 'you@example.com', TMUXIFIER_COOKIE_SECRET: 'x',
  }, cwd: dir });
  const fetchImpl = async () => ({ ok: true, json: async () => ({
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
  }) });
  const client = createOidcClient({ provider: config.oidcProviders[0], redirectUri: `${PUBLIC}/api/auth/google/callback`, allowedEmails: config.allowedEmails, fetchImpl });
  const store = createStore({ dataDir: dir, sshConfigPath: path.join(dir, 'nope') });
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const app = buildServer({ config: { ...config, dataDir: dir }, store, sessions, statusChecker: { checkBox: async () => ({ reachable: true }) }, oidcClients: new Map([['google', client]]) });
  expect((await app.inject({ method: 'GET', url: '/api/auth/info' })).json().providers).toEqual([{ id: 'google', label: 'Google', legacy: true, google: true }]);
  const res = await app.inject({ method: 'GET', url: '/api/auth/google/login' });
  expect(new URL(res.headers.location).searchParams.get('redirect_uri')).toBe(`${PUBLIC}/api/auth/google/callback`);
});

test('legacy oauth env with a password hash has no /api/login', async () => {
  const config = loadConfig({}, { env: {
    TMUXIFIER_AUTH_MODE: 'oauth', TMUXIFIER_GOOGLE_CLIENT_ID: 'cid', TMUXIFIER_GOOGLE_CLIENT_SECRET: 's',
    TMUXIFIER_PUBLIC_URL: 'tmux.example.com', TMUXIFIER_ALLOWED_EMAILS: 'you@example.com', TMUXIFIER_COOKIE_SECRET: 'x',
    TMUXIFIER_PASSWORD_HASH: await hashPassword('pw'),
  }, cwd: dir });
  const app = await makeApp({ config });
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(404);
});

test('an un-normalized auth mode fails closed: no /api/login', async () => {
  const app = await makeApp({ config: { authMode: 'oauth', passwordHash: await hashPassword('pw') } });
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(404);
});
