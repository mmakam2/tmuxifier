import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createDeviceStore } from '../src/server/deviceStore.js';
import { createPasskeyStore } from '../src/server/passkeyStore.js';
import { hashPassword, sessionValue } from '../src/server/auth.js';
import { Signer } from '@fastify/cookie';

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

test('pair mints only for a browser session; a device token gets 403', async () => {
  expect((await app.inject({ method: 'POST', url: '/api/devices/pair' })).statusCode).toBe(401);
  const h = await cookieHeaders();
  const minted = (await app.inject({ method: 'POST', url: '/api/devices/pair', headers: h })).json();
  expect(minted.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  expect(minted.expiresAt).toBeGreaterThan(Date.now());
  const { token } = (await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } })).json();
  const viaDevice = await app.inject({ method: 'POST', url: '/api/devices/pair', headers: { authorization: `Bearer ${token}` } });
  expect(viaDevice.statusCode).toBe(403);
});

test('a minted code enrolls a device exactly once', async () => {
  const h = await cookieHeaders();
  const { code } = (await app.inject({ method: 'POST', url: '/api/devices/pair', headers: h })).json();
  const ok = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { code, name: 'Fold' } });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const authed = await app.inject({ method: 'GET', url: '/api/boxes', headers: { authorization: `Bearer ${ok.json().token}` } });
  expect(authed.statusCode).toBe(200);
  const replay = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { code, name: 'Again' } });
  expect(replay.statusCode).toBe(401);
});

test('bad codes feed the login limiter', async () => {
  for (let i = 0; i < 10; i++) {
    await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { code: 'AAAA-AAAA', name: 'x' } });
  }
  const limited = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { code: 'AAAA-AAAA', name: 'x' } });
  expect(limited.statusCode).toBe(429);
});

test('the Android APK downloads authenticated once published into data/app', async () => {
  const h = await cookieHeaders();
  // Nothing published yet: info says so, download 404s.
  expect((await app.inject({ method: 'GET', url: '/api/devices/apk/info', headers: h })).json()).toEqual({ available: false });
  expect((await app.inject({ method: 'GET', url: '/api/devices/apk', headers: h })).statusCode).toBe(404);
  // Publish: the release checklist copies the signed APK here.
  await fs.mkdir(path.join(dir, 'app'), { recursive: true });
  await fs.writeFile(path.join(dir, 'app', 'tmuxifier-console.apk'), 'not-a-real-apk');
  const info = (await app.inject({ method: 'GET', url: '/api/devices/apk/info', headers: h })).json();
  expect(info.available).toBe(true);
  expect(info.size).toBe(14);
  const dl = await app.inject({ method: 'GET', url: '/api/devices/apk', headers: h });
  expect(dl.statusCode).toBe(200);
  expect(dl.headers['content-type']).toBe('application/vnd.android.package-archive');
  expect(dl.headers['content-disposition']).toContain('tmuxifier-console.apk');
  expect(dl.body).toBe('not-a-real-apk');
  // Unauthenticated: neither route answers.
  expect((await app.inject({ method: 'GET', url: '/api/devices/apk' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/api/devices/apk/info' })).statusCode).toBe(401);
});

test('apk build routes: browser-only start, 409 when busy, pollable status', async () => {
  // Not wired in the beforeEach app: soft 503/null.
  const h = await cookieHeaders();
  expect((await app.inject({ method: 'POST', url: '/api/devices/apk/build', headers: h })).statusCode).toBe(503);
  expect((await app.inject({ method: 'GET', url: '/api/devices/apk/build', headers: h })).json()).toEqual({ job: null });

  let busy = false;
  const fakeManager = {
    start: async () => {
      if (busy) throw new Error('a build is already running');
      busy = true;
      return { id: 'ab-1', status: 'running', variant: null };
    },
    current: () => ({ id: 'ab-1', status: busy ? 'running' : null }),
  };
  const app2 = buildServer({
    config: {
      bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
      passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
      localShell: 'none', configPath: path.join(dir, 'config.json'),
    },
    store: createStore({ dataDir: dir }),
    sessions: { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} },
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    passkeyStore: createPasskeyStore({ dataDir: dir }), deviceStore, apkBuildManager: fakeManager,
  });
  const login = await app2.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === 'tmuxifier_session');
  const h2 = { cookie: `${c.name}=${c.value}` };
  expect((await app2.inject({ method: 'POST', url: '/api/devices/apk/build' })).statusCode).toBe(401);
  const { token } = (await app2.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold2' } })).json();
  expect((await app2.inject({ method: 'POST', url: '/api/devices/apk/build', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
  expect((await app2.inject({ method: 'POST', url: '/api/devices/apk/build', headers: h2 })).json().job.status).toBe('running');
  expect((await app2.inject({ method: 'POST', url: '/api/devices/apk/build', headers: h2 })).statusCode).toBe(409);
  expect((await app2.inject({ method: 'GET', url: '/api/devices/apk/build', headers: h2 })).json().job.id).toBe('ab-1');
});

test('fcm-config serves the operator client config, auth-gated, absent-fails-soft', async () => {
  const h = await cookieHeaders();
  // No TMUXIFIER_FCM_APP_CONFIG in the beforeEach app: soft absence.
  expect((await app.inject({ method: 'GET', url: '/api/devices/fcm-config', headers: h })).json()).toEqual({ available: false });
  expect((await app.inject({ method: 'GET', url: '/api/devices/fcm-config' })).statusCode).toBe(401);
  // Configured app serves the extracted values.
  const file = path.join(dir, 'gs.json');
  await fs.writeFile(file, JSON.stringify({
    project_info: { project_id: 'their-project', project_number: '42' },
    client: [{
      client_info: { mobilesdk_app_id: '1:42:android:beef', android_client_info: { package_name: 'com.tmuxifier.console' } },
      api_key: [{ current_key: 'AIzaTest' }],
    }],
  }));
  const config2 = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'), fcmAppConfig: file,
  };
  const app2 = buildServer({
    config: config2, store: createStore({ dataDir: dir }),
    sessions: { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} },
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    passkeyStore: createPasskeyStore({ dataDir: dir }), deviceStore,
  });
  const login = await app2.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === 'tmuxifier_session');
  const res = (await app2.inject({ method: 'GET', url: '/api/devices/fcm-config', headers: { cookie: `${c.name}=${c.value}` } })).json();
  expect(res).toEqual({ available: true, projectId: 'their-project', senderId: '42', applicationId: '1:42:android:beef', apiKey: 'AIzaTest' });
});

test('OAuth mode: password enroll still 501s but a pairing code enrolls', async () => {
  // Google-mode app has no /api/login; forge the session cookie the way the
  // server would sign it (same secret) — the only test in the file needing it.
  const config2 = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    cookieSecret: 'test-secret', dataDir: dir, localShell: 'none',
    configPath: path.join(dir, 'config.json'), authMode: 'google',
    googleClientId: 'id', googleClientSecret: 'secret', allowedEmails: ['a@example.com'],
    baseExternalUrl: 'https://tmuxifier.example.com',
  };
  const sessions2 = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const app2 = buildServer({
    config: config2, store: createStore({ dataDir: dir }), sessions: sessions2,
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    passkeyStore: createPasskeyStore({ dataDir: dir }), deviceStore,
  });
  const signed = new Signer(['test-secret']).sign(sessionValue());
  const h = { cookie: `tmuxifier_session=${encodeURIComponent(signed)}` };
  expect((await app2.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'x' } })).statusCode).toBe(501);
  const { code } = (await app2.inject({ method: 'POST', url: '/api/devices/pair', headers: h })).json();
  const ok = await app2.inject({ method: 'POST', url: '/api/devices/enroll', payload: { code, name: 'Fold' } });
  expect(ok.statusCode).toBe(200);
});
