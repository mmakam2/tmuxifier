import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createPasskeyStore } from '../src/server/passkeyStore.js';
import { createPasskeyChallenges } from '../src/server/passkeyChallenges.js';
import { hashPassword } from '../src/server/auth.js';
import { makeAuthenticator, makeRegistration, makeAssertion, b64u } from './helpers/webauthnFixtures.js';

const RP = 'tmux.example.com';
const ORIGIN = `https://${RP}`;

let app, dir, passkeyStore;

async function build(overrides = {}, serverOverrides = {}) {
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', authMode: 'password', secureCookie: false,
    rpId: RP, rpIdError: null, passkeyOnlyKillSwitch: false,
    ...overrides,
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  return buildServer({ config, store: createStore({ dataDir: dir }), sessions, statusChecker, passkeyStore, ...serverOverrides });
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

// Full arm ceremony: begin, sign the challenge with the fixture
// authenticator, finish. Returns the finish response.
async function armWithAssertion(h, auth, { signCount = 5 } = {}) {
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: h });
  expect(begin.statusCode).toBe(200);
  const assertion = makeAssertion({
    authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount,
  });
  return app.inject({
    method: 'POST', url: '/api/passkeys/only',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(begin)}` },
    payload: { enabled: true, id: assertion.id, response: assertion.response },
  });
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
  // More than the 64-entry default bound, all unauthenticated. Asserted
  // inline: if begin ever started refusing, the loop would issue zero
  // challenges and the guard below would pass for the wrong reason.
  for (let i = 0; i < 70; i++) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
    expect(res.statusCode).toBe(200);
  }
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

// Mirror of the test above, but for the login ceremony itself rather than
// enrollment: a flood of login/begin calls from OTHER source IPs must not
// evict a legitimate caller's own in-flight login challenge.
test('a flood of login challenges from another IP cannot evict a victim\'s login challenge', async () => {
  const auth = await enroll();
  const begin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin', remoteAddress: '203.0.113.9' });
  expect(begin.statusCode).toBe(200);
  // More than the 64-entry default bound, all from a single different IP.
  for (let i = 0; i < 70; i++) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin', remoteAddress: '203.0.113.66' });
    expect(res.statusCode).toBe(200);
  }
  const assertion = makeAssertion({
    authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount: 5,
  });
  const fin = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish',
    headers: { cookie: pkCookie(begin) }, payload: assertion,
  });
  expect(fin.statusCode).toBe(200);
});

// The 409 below names the previously-pinned rp id. That's fine on the
// authenticated enroll routes (already covered by the register/begin 409
// test above) but must not leak to an anonymous caller on the login routes.
test('a pinned rp id mismatch on the login routes does not leak the stored hostname', async () => {
  await passkeyStore.add({ id: 'cred-a', publicKey: 'x', alg: -7, signCount: 0, label: 'L', transports: [] }, { rpId: 'old.example.com' });
  const begin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  expect(begin.statusCode).toBe(409);
  expect(begin.json().error).not.toMatch(/old\.example\.com/);
  const finish = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/finish', payload: {} });
  expect(finish.statusCode).toBe(409);
  expect(finish.json().error).not.toMatch(/old\.example\.com/);
});

// buildServer's passkeyChallenges DI seam must apply uniformly: an injected
// store silently controlling only enrollment (while login always gets a
// fresh, uninjected store) would be a seam a test author could easily miss.
test('an injected passkeyChallenges store backs both the enrollment and login ceremonies', async () => {
  const shared = createPasskeyChallenges({ ttlMs: 120000 });
  app = await build({}, { passkeyChallenges: shared });
  await enroll();
  const h = await headers();
  const reg = await app.inject({ method: 'POST', url: '/api/passkeys/register/begin', headers: h });
  const login = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  expect(reg.statusCode).toBe(200);
  expect(login.statusCode).toBe(200);
  expect(shared._size()).toBe(2);
});

test('arming passkey-only is refused with nothing enrolled', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: await headers(), payload: { enabled: true } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/enroll a passkey/);
});

test('arming passkey-only makes password login 403', async () => {
  const auth = await enroll();
  const h = await headers();
  expect((await armWithAssertion(h, auth)).json()).toEqual({ passkeyOnly: true });
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  expect(res.statusCode).toBe(403);
  expect(res.json().error).toMatch(/passkey required/);
  expect((await app.inject({ method: 'GET', url: '/api/auth/info' })).json().passkey.only).toBe(true);
});

test('disarming passkey-only restores password login', async () => {
  const auth = await enroll();
  const h = await headers();
  await armWithAssertion(h, auth);
  await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: false } });
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(200);
});

// Without this, a flow started before the toggle was armed still issues a session.
test('arming passkey-only blocks both Google routes, callback included', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pkg-'));
  passkeyStore = createPasskeyStore({ dataDir: dir });
  const google = { authorizationUrl: () => 'https://accounts.google.com/x', exchangeCodeForEmail: async () => ({ email: 'you@example.com', emailVerified: true }), isAllowed: () => true };
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    cookieSecret: 'test-secret', dataDir: dir, localShell: 'none', authMode: 'google',
    secureCookie: false, publicUrl: 'https://tmux.example.com',
    rpId: RP, rpIdError: null, passkeyOnlyKillSwitch: false,
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  const gapp = buildServer({ config, store: createStore({ dataDir: dir }), sessions, statusChecker, passkeyStore, googleAuth: google });
  await enroll(passkeyStore);
  await passkeyStore.setPasskeyOnly(true);
  const login = await gapp.inject({ method: 'GET', url: '/api/auth/google/login' });
  const callback = await gapp.inject({ method: 'GET', url: '/api/auth/google/callback?code=c&state=s' });
  expect(login.headers.location).toBe('/?error=passkey-only');
  expect(callback.headers.location).toBe('/?error=passkey-only');
});

// The .env break-glass for a lost authenticator.
test('the kill switch overrides the stored flag', async () => {
  await enroll();
  await passkeyStore.setPasskeyOnly(true);
  app = await build({ passkeyOnlyKillSwitch: true });
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(200);
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: await headers(), payload: { enabled: true } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/TMUXIFIER_PASSKEY_ONLY/);
});

test('removing the last passkey disarms passkey-only', async () => {
  const auth = await enroll();
  const h = await headers();
  await armWithAssertion(h, auth);
  expect((await app.inject({ method: 'DELETE', url: `/api/passkeys/${encodeURIComponent(auth.id)}`, headers: h })).json())
    .toEqual({ ok: true, disarmed: true });
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(200);
});

// Prior-review gap: passkeyOnlyArmed's fail-open behavior when the store
// can't be read had zero coverage. A disk hiccup must fail OPEN (login still
// works) rather than fail closed (a silent, unrecoverable lockout no toggle
// ever asked for).
test('a passkey store read failure fails open on the login gate rather than locking out password login', async () => {
  const brokenStore = { snapshot: async () => { throw new Error('disk error'); } };
  app = await build({}, { passkeyStore: brokenStore });
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  expect(res.statusCode).toBe(200);
});

// Prior-review gap: the cloned-authenticator log branch in login/finish
// (distinguishing a replayed sign count from a merely-corrupt stored count)
// was untested. A first login establishes signCount=5, then a second
// assertion from the same authenticator replays a lower count (3) with a
// otherwise-valid signature — exactly what a cloned authenticator looks like.
test('a replayed sign count is logged as a possible cloned authenticator', async () => {
  const logs = [];
  app = await build({}, { log: (msg) => logs.push(msg) });
  const auth = await enroll();
  const begin1 = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const first = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(begin1) },
    payload: makeAssertion({ authenticator: auth, challenge: Buffer.from(begin1.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP, signCount: 5 }),
  });
  expect(first.statusCode).toBe(200);
  const begin2 = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const replay = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(begin2) },
    payload: makeAssertion({ authenticator: auth, challenge: Buffer.from(begin2.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP, signCount: 3 }),
  });
  expect(replay.statusCode).toBe(401);
  expect(replay.json()).toEqual({ error: 'passkey verification failed' });
  expect(logs.some((m) => /passkey "Laptop" sign count did not increase — possible cloned authenticator/.test(m))).toBe(true);
});

// The other half of the same distinction: an out-of-range stored sign count
// (store corruption, not a clone) must be rejected WITHOUT the cloned-
// authenticator label, so an operator never mis-triages a disk problem as a
// stolen/cloned credential.
test('an out-of-range stored sign count is rejected without the cloned-authenticator label', async () => {
  const logs = [];
  app = await build({}, { log: (msg) => logs.push(msg) });
  const auth = makeAuthenticator();
  await passkeyStore.add({
    id: auth.id, publicKey: b64u(auth.cose), alg: -7, signCount: 0x100000000, label: 'Laptop', transports: ['internal'],
  }, { rpId: RP });
  const begin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const res = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(begin) },
    payload: makeAssertion({ authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP, signCount: 5 }),
  });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: 'passkey verification failed' });
  expect(logs.some((m) => /cloned authenticator/.test(m))).toBe(false);
});

// --- Fix pass: review findings on POST /api/passkeys/only ---

// Finding 1: arming checked credential *count* only, never whether the
// enrolled credentials are actually *usable* (rpId configured, and matching
// what's pinned in the store) — the exact conditions pkReady() already
// checks for the login/enroll routes. Both of the scenarios below were
// confirmed to arm successfully (200) and lock the dashboard out on the spot
// before this fix; login/begin already answers 409/503 one request earlier,
// proving the server has everything it needs to refuse the arm instead.
test('arming is refused when the pinned rpId no longer matches the configured one (would otherwise lock out immediately)', async () => {
  await enroll(); // pins the store to RP
  const h = await headers(); // session cookie minted while still unarmed
  app = await build({ rpId: 'changed.example.com' });
  // Passkey login is already unusable at this configuration — same 409 the
  // enroll routes report — so arming here would strand the operator.
  const loginBegin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  expect(loginBegin.statusCode).toBe(409);

  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: true } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/enrolled for/);
  expect(await passkeyStore.getPasskeyOnly()).toBe(false);

  // Password login must still work — arming was refused, not merely mis-reported.
  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(200);
});

test('arming is refused when rpId is unset (an IP-addressed deployment, would otherwise lock out immediately)', async () => {
  await enroll();
  const h = await headers();
  app = await build({ rpId: null });
  const loginBegin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  expect(loginBegin.statusCode).toBe(503);

  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: true } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/domain name/);
  expect(await passkeyStore.getPasskeyOnly()).toBe(false);

  expect((await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } })).statusCode).toBe(200);
});

// Disarming is the recovery path and must keep working in exactly the broken
// states above — the new guard only runs when enabled === true. Simulates
// "was armed while rpId was fine, then the configuration/DNS changed
// underneath it" by arming directly on the store (bypassing the route),
// which is the only way to reach an armed+mismatched state now that arming
// itself refuses to create one.
test('disarming still works when the pinned rpId no longer matches the configured one', async () => {
  await enroll();
  const h = await headers(); // minted while still unarmed
  await passkeyStore.setPasskeyOnly(true);
  app = await build({ rpId: 'changed.example.com' });
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: false } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ passkeyOnly: false });
});

// Finding 2: a bodyless or malformed request must not be treated as an
// implicit disarm — require an explicit boolean.
test('POST /api/passkeys/only rejects a missing or non-boolean enabled with 400, and never disarms', async () => {
  const auth = await enroll();
  const h = await headers();
  expect((await armWithAssertion(h, auth)).json()).toEqual({ passkeyOnly: true });
  const badBodies = [undefined, {}, [], { enabled: 'true' }, { enabled: 1 }, { enabled: null }];
  for (const payload of badBodies) {
    const res = payload === undefined
      ? await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h })
      : await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload });
    expect(res.statusCode).toBe(400);
  }
  // None of the malformed attempts above disarmed the flag.
  expect(await passkeyStore.getPasskeyOnly()).toBe(true);
});

// Finding 3: /api/auth/info now calls the shared passkeySnapshot() helper
// instead of hand-rolling its own copy — must behave identically, including
// on a broken store (fail open to "no passkeys", never a 500).
test('auth/info still fails open when the passkey store cannot be read', async () => {
  const brokenStore = { snapshot: async () => { throw new Error('disk error'); } };
  app = await build({}, { passkeyStore: brokenStore });
  const res = await app.inject({ method: 'GET', url: '/api/auth/info' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ mode: 'password', passkey: { enrolled: 0, rpId: RP, only: false } });
});

// Finding 4: arming/disarming is the fleet's most consequential auth
// setting and must leave an audit trail.
test('arming and disarming passkey-only each write one audit log line', async () => {
  const logs = [];
  app = await build({}, { log: (msg) => logs.push(msg) });
  const auth = await enroll();
  const h = await headers();
  await armWithAssertion(h, auth);
  await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: false } });
  expect(logs).toContain('[tmuxifier] passkey-only mode armed');
  expect(logs).toContain('[tmuxifier] passkey-only mode disarmed');
});

// --- fresh-assertion arming (spec: 2026-07-23-passkey-fresh-assertion-arming-design.md) ---

test('only/begin requires auth', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/passkeys/only/begin' })).statusCode).toBe(401);
});

test('only/begin issues an arm challenge with the login-begin shape', async () => {
  await enroll();
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: await headers() });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ rpId: RP, userVerification: 'required', allowCredentials: [] });
  expect(Buffer.from(res.json().challenge, 'base64url')).toHaveLength(32);
  expect(pkCookie(res)).toMatch(/^tmuxifier_pk=/);
});

test('only/begin refuses when the kill switch is set', async () => {
  await enroll();
  app = await build({ passkeyOnlyKillSwitch: true });
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: await headers() });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/TMUXIFIER_PASSKEY_ONLY/);
});

test('only/begin refuses with nothing enrolled', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: await headers() });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/enroll a passkey/);
});

test('only/begin reports the same rp-id failures as the other authenticated ceremonies', async () => {
  await enroll(); // pins the store to RP
  app = await build({ rpId: null });
  const noRp = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: await headers() });
  expect(noRp.statusCode).toBe(503);
  expect(noRp.json().error).toMatch(/domain name/);
  app = await build({ rpId: 'changed.example.com' });
  const mismatch = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: await headers() });
  expect(mismatch.statusCode).toBe(409);
  expect(mismatch.json().error).toMatch(/enrolled for/);
});

// The regression this feature exists for: an arm request with no fresh
// assertion must be refused, even with a credential enrolled.
test('arming without a fresh assertion is refused', async () => {
  await enroll();
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: await headers(), payload: { enabled: true } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/fresh passkey assertion/);
  expect(await passkeyStore.getPasskeyOnly()).toBe(false);
});

test('a full arm ceremony arms the flag and persists the sign count', async () => {
  const auth = await enroll();
  const res = await armWithAssertion(await headers(), auth);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ passkeyOnly: true });
  expect((await passkeyStore.listRaw())[0].signCount).toBe(5);
});

test('a login challenge cannot finish an arm ceremony, nor an arm challenge a login', async () => {
  const auth = await enroll();
  const h = await headers();
  // login-issued challenge presented to the arm finish
  const loginBegin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const loginAssertion = makeAssertion({
    authenticator: auth, challenge: Buffer.from(loginBegin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount: 5,
  });
  const crossArm = await app.inject({
    method: 'POST', url: '/api/passkeys/only',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(loginBegin)}` },
    payload: { enabled: true, id: loginAssertion.id, response: loginAssertion.response },
  });
  expect(crossArm.statusCode).toBe(400);
  expect(crossArm.json().error).toMatch(/fresh passkey assertion/);
  expect(await passkeyStore.getPasskeyOnly()).toBe(false);
  // arm-issued challenge presented to login/finish
  const armBegin = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: h });
  const armAssertion = makeAssertion({
    authenticator: auth, challenge: Buffer.from(armBegin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount: 6,
  });
  const crossLogin = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish',
    headers: { cookie: pkCookie(armBegin) }, payload: armAssertion,
  });
  expect(crossLogin.statusCode).toBe(400);
  expect(crossLogin.json().error).toMatch(/challenge expired/);
});

test('an arm assertion with a bad signature is refused and the flag stays off', async () => {
  const auth = await enroll();
  const h = await headers();
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: h });
  const forged = makeAssertion({
    authenticator: auth, challenge: Buffer.from(begin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount: 5, tamper: 'signature',
  });
  const res = await app.inject({
    method: 'POST', url: '/api/passkeys/only',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(begin)}` },
    payload: { enabled: true, id: forged.id, response: forged.response },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/arming failed/);
  expect(await passkeyStore.getPasskeyOnly()).toBe(false);
});

test('an unknown credential id on the arm finish is refused', async () => {
  await enroll();
  const h = await headers();
  const begin = await app.inject({ method: 'POST', url: '/api/passkeys/only/begin', headers: h });
  const stranger = makeAuthenticator({ credentialId: Buffer.from('cred-zzzz') });
  const assertion = makeAssertion({
    authenticator: stranger, challenge: Buffer.from(begin.json().challenge, 'base64url'),
    origin: ORIGIN, rpId: RP, signCount: 5,
  });
  const res = await app.inject({
    method: 'POST', url: '/api/passkeys/only',
    headers: { ...h, cookie: `${h.cookie}; ${pkCookie(begin)}` },
    payload: { enabled: true, id: assertion.id, response: assertion.response },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/arming failed/);
  expect(await passkeyStore.getPasskeyOnly()).toBe(false);
});

test('a stalled sign count on the arm finish is refused and logged like login', async () => {
  const logs = [];
  app = await build({}, { log: (msg) => logs.push(msg) });
  const auth = await enroll();
  const h = await headers();
  // Establish stored signCount=5 via a real login first.
  const loginBegin = await app.inject({ method: 'POST', url: '/api/auth/passkey/login/begin' });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/passkey/login/finish', headers: { cookie: pkCookie(loginBegin) },
    payload: makeAssertion({ authenticator: auth, challenge: Buffer.from(loginBegin.json().challenge, 'base64url'), origin: ORIGIN, rpId: RP, signCount: 5 }),
  });
  expect(login.statusCode).toBe(200);
  const res = await armWithAssertion(h, auth, { signCount: 3 });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/arming failed/);
  expect(await passkeyStore.getPasskeyOnly()).toBe(false);
  expect(logs.some((m) => /passkey "Laptop" sign count did not increase — possible cloned authenticator/.test(m))).toBe(true);
});

// The rpId guards fire BEFORE the assertion requirement, so a misconfigured
// deployment still gets the specific 409 rather than a misleading
// "assertion missing" — this pins the guard order.
test('the rpId-usable 409 still precedes the assertion requirement', async () => {
  await enroll();
  const h = await headers();
  app = await build({ rpId: 'changed.example.com' });
  const res = await app.inject({ method: 'POST', url: '/api/passkeys/only', headers: h, payload: { enabled: true } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatch(/enrolled for/);
});
