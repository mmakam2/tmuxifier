import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createDeviceStore } from '../src/server/deviceStore.js';
import { createPasskeyStore } from '../src/server/passkeyStore.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, deviceStore;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-devr-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  deviceStore = createDeviceStore({ dataDir: dir });
  app = buildServer({
    config, store: createStore({ dataDir: dir }), sessions, statusChecker,
    passkeyStore: createPasskeyStore({ dataDir: dir }), deviceStore,
  });
});

async function cookieHeaders() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('enroll needs the correct password and feeds the login limiter', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'wrong', name: 'Fold' } });
  expect(bad.statusCode).toBe(401);
  const ok = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(ok.json().name).toBe('Fold');
  // 10 bad attempts lock the ip (shared bucket with /api/login)
  for (let i = 0; i < 10; i++) {
    await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'wrong', name: 'x' } });
  }
  const limited = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'x' } });
  expect(limited.statusCode).toBe(429);
});

test('a Bearer token authenticates API routes; a bogus one does not', async () => {
  const { token } = (await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } })).json();
  const authed = await app.inject({ method: 'GET', url: '/api/boxes', headers: { authorization: `Bearer ${token}` } });
  expect(authed.statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/api/boxes', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/api/boxes' })).statusCode).toBe(401);
});

test('revocation locks the token out on its next request', async () => {
  const { id, token } = (await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } })).json();
  const h = await cookieHeaders();
  const listed = (await app.inject({ method: 'GET', url: '/api/devices', headers: h })).json();
  expect(listed.devices.map((d) => d.id)).toContain(id);
  expect((await app.inject({ method: 'DELETE', url: `/api/devices/${id}`, headers: h })).json()).toEqual({ removed: true });
  expect((await app.inject({ method: 'GET', url: '/api/boxes', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
});

test('PATCH /api/devices/self is Bearer-only and merges', async () => {
  const { token } = (await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold', fcmToken: 'fcm-1' } })).json();
  const viaCookie = await app.inject({ method: 'PATCH', url: '/api/devices/self', headers: await cookieHeaders(), payload: {} });
  expect(viaCookie.statusCode).toBe(403); // a browser session is not a device
  const upd = await app.inject({
    method: 'PATCH', url: '/api/devices/self',
    headers: { authorization: `Bearer ${token}` },
    payload: { notify: { 'agent-done': false } },
  });
  expect(upd.statusCode).toBe(200);
  expect(upd.json().notify).toEqual({ 'agent-input': true, 'agent-done': false });
});

test('device list is never served to an unauthenticated caller', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/devices' })).statusCode).toBe(401);
});

test('enroll refuses when passkey-only is armed', async () => {
  // Arm via the store directly (the HTTP arming path needs a WebAuthn ceremony).
  const pk = createPasskeyStore({ dataDir: dir });
  await pk.add({ id: 'cred1', publicKey: 'pk', signCount: 0 }, { rpId: 'localhost' });
  await pk.setPasskeyOnly(true);
  const res = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } });
  expect(res.statusCode).toBe(403);
});
