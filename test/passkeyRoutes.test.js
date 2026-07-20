import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createPasskeyStore } from '../src/server/passkeyStore.js';
import { hashPassword } from '../src/server/auth.js';
import { makeAuthenticator, makeRegistration, makeAssertion, b64u } from './helpers/webauthnFixtures.js';

const RP = 'tmux.example.com';
const ORIGIN = `https://${RP}`;

let app, dir, passkeyStore;

async function build(overrides = {}) {
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', authMode: 'password', secureCookie: false,
    rpId: RP, rpIdError: null, passkeyOnlyKillSwitch: false,
    ...overrides,
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  return buildServer({ config, store: createStore({ dataDir: dir }), sessions, statusChecker, passkeyStore });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pkr-'));
  passkeyStore = createPasskeyStore({ dataDir: dir });
  app = await build();
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}
const pkCookie = (res) => {
  const c = res.cookies.find((x) => x.name === 'tmuxifier_pk');
  return c ? `${c.name}=${c.value}` : '';
};

test('passkey management routes require auth', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/passkeys' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/passkeys/register/begin' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/passkeys/register/finish', payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'DELETE', url: '/api/passkeys/x' })).statusCode).toBe(401);
});

test('GET /api/passkeys reports empty state before enrollment', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/passkeys', headers: await headers() })).json())
    .toEqual({ credentials: [], rpId: RP, storedRpId: null, passkeyOnly: false, killSwitch: false });
});

test('register/begin returns creation options bound to the rp id', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: await headers() });
  const body = res.json();
  expect(body.rp).toEqual({ id: RP, name: 'Tmuxifier' });
  expect(body.attestation).toBe('none');
  expect(body.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
  expect(body.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257, -8]);
  expect(Buffer.from(body.challenge, 'base64url')).toHaveLength(32);
  expect(pkCookie(res)).toMatch(/^tmuxifier_pk=/);
});

test('a full enrollment round-trip stores the credential', async () => {
  const h = await headers();
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: h });
  const auth = makeAuthenticator();
  const reg = makeRegistration({
    authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP,
  });
  const fin = await app.inject({
    method: 'POST', url: '/api/passkeys/register/finish',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(begin)}` },
    payload: { label: 'Laptop', response: reg.response },
  });
  expect(fin.statusCode).toBe(200);
  expect(fin.json().credential).toMatchObject({ label: 'Laptop', transports: ['internal', 'hybrid'] });
  const raw = await passkeyStore.listRaw();
  expect(raw).toHaveLength(1);
  expect(Buffer.from(raw[0].publicKey, 'base64url').equals(auth.cose)).toBe(true);
  expect(await passkeyStore.getRpId()).toBe(RP);
});

test('register/finish rejects a bad label before touching crypto', async () => {
  const h = await headers();
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: h });
  const res = await app.inject({
    method: 'POST', url: '/api/passkeys/register/finish',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(begin)}` },
    payload: { label: 'nope;rm -rf /', response: {} },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/label/);
});

test('register/finish without a challenge cookie is rejected', async () => {
  const h = await headers();
  const res = await app.inject({
    method: 'POST', url: '/api/passkeys/register/finish', headers: h,
    payload: { label: 'Laptop', response: {} },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/challenge expired/);
});

test('a challenge cannot be replayed', async () => {
  const h = await headers();
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: h });
  const challenge = Buffer.from(begin.json().challenge, 'base64url');
  const cookie = `${h.cookie}; ${pkCookie(begin)}`;
  const auth = makeAuthenticator();
  const payload = { label: 'Laptop', response: makeRegistration({ authenticator: auth, challenge, origin: ORIGIN, rpId: RP }).response };
  expect((await app.inject({ method: 'POST', url: '/api/passkeys/register/finish', headers: { ...h, cookie }, payload })).statusCode).toBe(200);
  const again = await app.inject({ method: 'POST', url: '/api/passkeys/register/finish', headers: { ...h, cookie }, payload });
  expect(again.statusCode).toBe(400);
  expect(again.json().error).toMatch(/challenge expired/);
});

test('DELETE removes a credential and 404s on an unknown id', async () => {
  const h = await headers();
  await passkeyStore.add({ id: 'cred-a', publicKey: 'x', alg: -7, signCount: 0, label: 'L', transports: [] }, { rpId: RP });
  expect((await app.inject({ method: 'DELETE', url: '/api/passkeys/nope', headers: h })).statusCode).toBe(404);
  expect((await app.inject({ method: 'DELETE', url: '/api/passkeys/cred-a', headers: h })).json()).toEqual({ ok: true, disarmed: false });
});

// An IP-addressed deployment must still boot and serve everything else.
test('passkey routes report 503 when no rp id is available', async () => {
  app = await build({ rpId: null });
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: await headers() });
  expect(res.statusCode).toBe(503);
  expect(res.json().error).toMatch(/domain name/);
});

test('a pinned rp id that no longer matches the configuration is a 409', async () => {
  await passkeyStore.add({ id: 'cred-a', publicKey: 'x', alg: -7, signCount: 0, label: 'L', transports: [] }, { rpId: 'old.example.com' });
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: await headers() });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/old\.example\.com/);
});

async function enroll(store = passkeyStore) {
  const auth = makeAuthenticator();
  await store.add({
    id: auth.id, publicKey: b64u(auth.cose), alg: -7, signCount: 0, label: 'Laptop', transports: ['internal'],
  }, { rpId: RP });
  return auth;
}

test('auth/info reports passkey state without authentication', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/auth/info' })).json())
    .toEqual({ mode: 'password', passkey: { enrolled: 0, rpId: RP, only: false } });
  await enroll();
  expect((await app.inject({ method: 'GET', url: '/api/auth/info' })).json().passkey.enrolled).toBe(1);
});

test('login/begin refuses before any passkey is enrolled', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  expect(res.statusCode).toBe(503);
  expect(res.json().error).toMatch(/no passkey enrolled/);
});

test('login/begin sends no allowCredentials, so credential ids stay private', async () => {
  await enroll();
  const res = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  expect(res.statusCode).toBe(200);
  expect(res.json().allowCredentials).toEqual([]);
  expect(res.json()).toMatchObject({ rpId: RP, userVerification: 'required' });
});

test('a full passkey login mints a session cookie that authenticates', async () => {
  const auth = await enroll();
  const begin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const assertion = makeAssertion({
    authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount: 5,
  });
  const fin = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish',
    headers: { cookie: pkCookie(begin) }, payload: assertion,
  });
  expect(fin.statusCode).toBe(200);
  const session = fin.cookies.find((c) => c.name === 'tmuxifier_session');
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${session.name}=${session.value}` } });
  expect(me.statusCode).toBe(200);
  expect((await passkeyStore.listRaw())[0].signCount).toBe(5);
});

test('an unknown credential and a bad signature are indistinguishable', async () => {
  const auth = await enroll();
  const begin1 = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const stranger = makeAuthenticator({ credentialId: Buffer.from('cred-zzzz') });
  const unknown = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(begin1) },
    payload: makeAssertion({ authenticator: stranger, challenge: Buffer.from(begin1.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP }),
  });
  const begin2 = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const forged = makeAssertion({ authenticator: auth, challenge: Buffer.from(begin2.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP, tamper: 'signature' });
  const bad = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(begin2) }, payload: forged });
  expect(unknown.statusCode).toBe(401);
  expect(bad.statusCode).toBe(401);
  expect(unknown.json()).toEqual(bad.json());
});

test('an assertion from a foreign origin is rejected', async () => {
  const auth = await enroll();
  const begin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const res = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(begin) },
    payload: makeAssertion({ authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'), origin: 'https://evil.example.net', rpId: RP }),
  });
  expect(res.statusCode).toBe(401);
});

// Passkey login shares the password lockout bucket rather than bypassing it.
test('failed passkey logins count toward the per-ip lockout', async () => {
  const auth = await enroll();
  for (let i = 0; i < 10; i++) {
    const begin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
    await app.inject({
      method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(begin) },
      payload: makeAssertion({ authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP, tamper: 'signature' }),
    });
  }
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(429);
});

test('a flood of anonymous login challenges cannot evict an enrollment challenge', async () => {
  const h = await headers();
  await enroll();
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: h });
  // More than the 64-entry default bound, all unauthenticated.
  for (let i = 0; i < 70; i++) await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const auth = makeAuthenticator({ credentialId: Buffer.from('cred-late') });
  const fin = await app.inject({
    method: 'POST', url: '/api/passkeys/register/finish',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(begin)}` },
    payload: { label: 'Laptop', response: makeRegistration({
      authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP,
    }).response },
  });
  expect(fin.statusCode).toBe(200);
});
