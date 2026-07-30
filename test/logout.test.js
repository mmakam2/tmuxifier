import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { hashPassword } from '../src/server/auth.js';

async function build(dir) {
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  return buildServer({ config, store: createStore({ dataDir: dir }), sessions, statusChecker });
}

async function login(app) {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return `${c.name}=${c.value}`;
}

test('logout invalidates the session server-side — a captured cookie stops working', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-logout-'));
  const app = await build(dir);
  const cookie = await login(app);
  expect((await app.inject({ method: 'GET', url: '/api/boxes', headers: { cookie } })).statusCode).toBe(200);

  // The watermark compares at the session value's 1-second granularity (so a
  // re-login in the logout's own second still works) — age the cookie past
  // that boundary before logging out.
  await new Promise((r) => setTimeout(r, 1100));
  await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
  // The same (captured) cookie must now be rejected, not merely cleared client-side.
  expect((await app.inject({ method: 'GET', url: '/api/boxes', headers: { cookie } })).statusCode).toBe(401);

  // A fresh login after logout works (the watermark only kills older cookies).
  await new Promise((r) => setTimeout(r, 1100)); // sessionValue has 1s granularity
  const fresh = await login(app);
  expect((await app.inject({ method: 'GET', url: '/api/boxes', headers: { cookie: fresh } })).statusCode).toBe(200);

  // The watermark survives a server restart (persisted under dataDir).
  const app2 = await build(dir);
  expect((await app2.inject({ method: 'GET', url: '/api/boxes', headers: { cookie } })).statusCode).toBe(401);
  await fs.rm(dir, { recursive: true, force: true });
});

// S1 (2026-07-29 review): /api/logout carried no auth, and requireTrustedOrigin
// passes any request with no Origin header (curl). So an anonymous client could
// loop it, advancing the revocation watermark continuously: the operator's
// freshly minted cookie died within a second of every login, locking them out of
// their own fleet for as long as the loop ran, plus one atomic auth-state.json
// write per request. The cookie is still cleared unconditionally — clearing the
// caller's own cookie harms nobody — but only a request that PROVES it holds a
// session may revoke every other one.
test('an unauthenticated logout cannot revoke anyone else\'s session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-logout-anon-'));
  const app = await build(dir);
  const cookie = await login(app);

  // The operator is signed in and working.
  expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);

  // An anonymous client hits logout. It may clear its own (nonexistent) cookie,
  // but it must not touch the watermark.
  const anon = await app.inject({ method: 'POST', url: '/api/logout' });
  expect(anon.statusCode).toBe(200);

  // The operator's session survives.
  expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);

  // ...and no watermark was persisted by that anonymous call.
  let state = null;
  try { state = JSON.parse(await fs.readFile(path.join(dir, 'auth-state.json'), 'utf8')); } catch { /* absent is the pass */ }
  expect(state?.sessionsInvalidBeforeMs ?? 0).toBe(0);
});

test('a garbage cookie cannot revoke sessions either', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-logout-junk-'));
  const app = await build(dir);
  const cookie = await login(app);

  const res = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: 'tmuxifier_session=forged' } });
  expect(res.statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
});

// The real thing must still work, and must still be a FLEET-wide revocation:
// that is the point of the watermark (a captured cookie dies on logout), which
// the existing test above covers for the authenticated path.
test('an authenticated logout still revokes and still clears the cookie', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-logout-ok-'));
  const app = await build(dir);
  const cookie = await login(app);

  const res = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  // The cookie is cleared in this browser...
  expect(res.cookies.some((c) => c.name === 'tmuxifier_session' && c.value === '')).toBe(true);
  // ...and the watermark was persisted.
  const state = JSON.parse(await fs.readFile(path.join(dir, 'auth-state.json'), 'utf8'));
  expect(state.sessionsInvalidBeforeMs).toBeGreaterThan(0);
});
