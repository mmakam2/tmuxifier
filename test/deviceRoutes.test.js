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

// Same check-then-await race as /api/login: the password branch must charge
// the attempt before awaiting scrypt, or a parallel burst outruns the cap.
test('a concurrent burst of wrong enroll passwords from one ip cannot exceed the lockout cap', async () => {
  const burst = await Promise.all(Array.from({ length: 25 }, () =>
    app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'wrong', name: 'x' } })));
  const codes = burst.map((r) => r.statusCode);
  expect(codes.filter((c) => c === 401)).toHaveLength(10);
  expect(codes.filter((c) => c === 429)).toHaveLength(15);
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
  expect(upd.json().notify).toEqual({ 'agent-blocked': true, 'agent-input': true, 'agent-done': false });
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

test('revoking a device needs a browser session; a device token gets 403', async () => {
  const a = (await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } })).json();
  const b = (await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'MCP' } })).json();
  const viaDevice = await app.inject({ method: 'DELETE', url: `/api/devices/${b.id}`, headers: { authorization: `Bearer ${a.token}` } });
  expect(viaDevice.statusCode).toBe(403);
  expect(viaDevice.json()).toEqual({ error: 'browser session required' });
  // b was not revoked
  expect((await app.inject({ method: 'GET', url: '/api/boxes', headers: { authorization: `Bearer ${b.token}` } })).statusCode).toBe(200);
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

test('Bearer device tokens are restricted to the Android + MCP allowlist; host, destructive, and admin routes return 403', async () => {
  const lifecycleCalls = [];
  const appScoped = buildServer({
    config: {
      bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
      passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
      localShell: 'none', configPath: path.join(dir, 'config.json'),
    },
    store: createStore({ dataDir: dir }),
    sessions: { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, closeGroup() {}, onExit() {} },
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    passkeyStore: createPasskeyStore({ dataDir: dir }),
    deviceStore,
    lifecycleManager: {
      createJob: async (body) => { lifecycleCalls.push(body); return { id: 'lc-1', ...body, status: 'running' }; },
      listJobs: () => [],
      getJob: () => null,
      hasActiveJob: () => false,
    },
  });
  const { token } = (await appScoped.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'MCP' } })).json();
  const bearer = { authorization: `Bearer ${token}` };

  // Allowed device/MCP routes pass auth:
  expect((await appScoped.inject({ method: 'GET', url: '/api/me', headers: bearer })).statusCode).toBe(200);
  const created = await appScoped.inject({ method: 'POST', url: '/api/boxes', headers: bearer, payload: { host: '192.168.1.50', sessionName: 'web' } });
  expect(created.statusCode).toBe(201);
  const boxId = created.json().id;
  // Android setSession (sessionName-only PATCH) is allowed:
  const setSess = await appScoped.inject({ method: 'PATCH', url: `/api/boxes/${boxId}`, headers: bearer, payload: { sessionName: 'ops' } });
  expect(setSess.statusCode).toBe(200);
  expect(setSess.json().sessionName).toBe('ops');
  // MCP guest_power actions (start/shutdown/reboot/stop) reach lifecycleManager:
  for (const action of ['start', 'shutdown', 'reboot', 'stop']) {
    const lc = await appScoped.inject({ method: 'POST', url: '/api/proxmox/lifecycle-jobs', headers: bearer, payload: { boxId, action } });
    expect(lc.statusCode).toBe(201);
  }
  expect(lifecycleCalls.map((c) => c.action)).toEqual(['start', 'shutdown', 'reboot', 'stop']);

  // Forbidden routes (Host Shell, onRequest upload/voice, box deletion/SSH rewrite,
  // deprovision/readdress, import/export, device list, script/credential CRUD) must 403:
  const forbidden = [
    { method: 'GET', url: '/api/local-shell' },
    { method: 'PATCH', url: '/api/local-shell', payload: { shell: 'omz', claudeHooks: true } },
    { method: 'POST', url: '/api/local-shell/reconnect' },
    { method: 'POST', url: '/api/upload?box=__local__&filename=a.txt', headers: { ...bearer, 'content-type': 'application/octet-stream' }, payload: Buffer.from('hi') },
    { method: 'POST', url: `/api/voice?box=${boxId}`, headers: { ...bearer, 'content-type': 'audio/webm' }, payload: Buffer.from('hi') },
    { method: 'POST', url: '/api/voice/install', payload: { model: 'base.en' } },
    { method: 'PATCH', url: '/api/voice/settings', payload: { enabled: true } },
    { method: 'DELETE', url: `/api/boxes/${boxId}` },
    { method: 'PATCH', url: `/api/boxes/${boxId}`, payload: { host: '10.0.0.99' } },
    { method: 'PATCH', url: `/api/boxes/${boxId}`, payload: { sessionName: 'ops', startupCommand: 'id' } },
    { method: 'POST', url: `/api/boxes/${boxId}/forget-hostkey` },
    { method: 'POST', url: `/api/boxes/${boxId}/seed-ai-auth`, payload: {} },
    { method: 'POST', url: `/api/boxes/${boxId}/reconnect` },
    { method: 'POST', url: '/api/proxmox/lifecycle-jobs', payload: { boxId, action: 'deprovision' } },
    { method: 'POST', url: '/api/proxmox/lifecycle-jobs', payload: { boxId, action: 'readdress', vlan: 10 } },
    { method: 'GET', url: '/api/export' },
    { method: 'POST', url: '/api/import', payload: { boxes: [] } },
    { method: 'GET', url: '/api/devices' },
    { method: 'GET', url: '/api/devices/apk/build' },
    { method: 'POST', url: '/api/fleet/scripts', payload: { name: 's', command: 'uptime' } },
    { method: 'PATCH', url: '/api/fleet/scripts/fs-1', payload: { command: 'id' } },
    { method: 'DELETE', url: '/api/fleet/scripts/fs-1' },
    { method: 'POST', url: '/api/proxmox/hosts', payload: {} },
    { method: 'PUT', url: '/api/proxmox/root-password', payload: { password: 'secret' } },
    { method: 'PUT', url: `/api/boxes/${boxId}/proxmox`, payload: {} },
    { method: 'DELETE', url: `/api/boxes/${boxId}/proxmox` },
    { method: 'PUT', url: '/api/netbox/settings', payload: {} },
    { method: 'DELETE', url: '/api/netbox/settings' },
    { method: 'POST', url: '/api/netbox/test', payload: {} },
    { method: 'POST', url: '/api/services', payload: {} },
    { method: 'PATCH', url: '/api/services/s1', payload: {} },
    { method: 'DELETE', url: '/api/services/s1' },
  ];
  for (const spec of forbidden) {
    const res = await appScoped.inject({ headers: bearer, ...spec });
    expect(res.statusCode, `${spec.method} ${spec.url}`).toBe(403);
    expect(res.json(), `${spec.method} ${spec.url}`).toEqual({ error: 'browser session required' });
  }
  // Box survived DELETE and SSH host rewrite attempts:
  const boxesAfter = (await appScoped.inject({ method: 'GET', url: '/api/boxes', headers: bearer })).json();
  expect(boxesAfter).toHaveLength(1);
  expect(boxesAfter[0].host).toBe('192.168.1.50');
  expect(lifecycleCalls).toHaveLength(4);
});

// S1 follow-up: a stolen device token must not be able to point the host's SSH
// identity at this machine, or have the host's AI credentials sent anywhere.
async function buildGuardedApp() {
  const setupCalls = [];
  const provisionCalls = [];
  const store = createStore({ dataDir: dir });
  const guarded = buildServer({
    config: {
      bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
      passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
      localShell: 'none', configPath: path.join(dir, 'config.json'),
    },
    store,
    sessions: { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, closeGroup() {}, onExit() {} },
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    passkeyStore: createPasskeyStore({ dataDir: dir }),
    deviceStore,
    setupManager: {
      start: (box, options) => { setupCalls.push(options); return { id: 's1', status: 'running' }; },
      listJobs: () => [], getJob: () => null, currentForBox: () => null,
    },
    provisionManager: {
      createProvision: async (body) => { provisionCalls.push(body); return { id: 'p1', status: 'running' }; },
      listProvisions: () => [], getProvision: () => null,
    },
  });
  const { token } = (await guarded.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'MCP' } })).json();
  const login = await guarded.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === 'tmuxifier_session');
  return {
    app: guarded, store, setupCalls, provisionCalls,
    bearer: { authorization: `Bearer ${token}` },
    browser: { cookie: `${c.name}=${c.value}` },
  };
}

test.each([
  ['loopback host', { host: '127.0.0.1' }],
  ['short loopback spelling', { host: '127.1' }],
  ['loopback jump hop', { host: '192.168.1.50', proxyJump: 'root@localhost' }],
])('a device token cannot add a box with a %s, and nothing is stored', async (_name, payload) => {
  const t = await buildGuardedApp();
  const res = await t.app.inject({ method: 'POST', url: '/api/boxes', headers: t.bearer, payload });
  expect(res.statusCode).toBe(403);
  expect(res.json().error).toMatch(/this machine/);
  expect(await t.store.listBoxes()).toEqual([]);
});

// String(['127.0.0.1']) passes assertBoxSafe's regex, so a non-string host must
// never reach the store or the resolver.
test.each([
  ['array host', { host: ['127.0.0.1'] }],
  ['missing host', {}],
  ['array proxyJump', { host: '192.168.1.50', proxyJump: ['localhost'] }],
  ['host outside the ssh allowlist', { host: '-oProxyCommand=id' }],
])('a device token gets a 400 for a %s, and nothing is stored', async (_name, payload) => {
  const t = await buildGuardedApp();
  const res = await t.app.inject({ method: 'POST', url: '/api/boxes', headers: t.bearer, payload });
  expect(res.statusCode).toBe(400);
  expect(await t.store.listBoxes()).toEqual([]);
});

test('a device token can still add a box on another machine', async () => {
  const t = await buildGuardedApp();
  const res = await t.app.inject({ method: 'POST', url: '/api/boxes', headers: t.bearer, payload: { host: '192.168.1.50' } });
  expect(res.statusCode).toBe(201);
  expect((await t.store.listBoxes()).map((b) => b.host)).toEqual(['192.168.1.50']);
});

test('a browser session can still add a loopback box', async () => {
  const t = await buildGuardedApp();
  const res = await t.app.inject({ method: 'POST', url: '/api/boxes', headers: t.browser, payload: { host: '127.0.0.1' } });
  expect(res.statusCode).toBe(201);
});

// Truthy non-booleans count: the setup route coerces with !!, so 1 would seed.
test.each([[true], [1], ['yes']])('a device token cannot start a setup with seedAiAuth=%j', async (seedAiAuth) => {
  const t = await buildGuardedApp();
  const box = await t.store.addBox({ host: '192.168.1.50' });
  const res = await t.app.inject({ method: 'POST', url: `/api/boxes/${box.id}/setup`, headers: t.bearer, payload: { seedAiAuth } });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'browser session required' });
  expect(t.setupCalls).toEqual([]);
});

test('a device token can start a setup without seeding', async () => {
  const t = await buildGuardedApp();
  const box = await t.store.addBox({ host: '192.168.1.50' });
  const res = await t.app.inject({ method: 'POST', url: `/api/boxes/${box.id}/setup`, headers: t.bearer, payload: { seedAiAuth: false, ohMyTmux: true } });
  expect(res.statusCode).toBe(201);
  expect(t.setupCalls[0]).toMatchObject({ seedAiAuth: false, ohMyTmux: true });
});

test('a browser session can still seed from setup', async () => {
  const t = await buildGuardedApp();
  const box = await t.store.addBox({ host: '192.168.1.50' });
  const res = await t.app.inject({ method: 'POST', url: `/api/boxes/${box.id}/setup`, headers: t.browser, payload: { seedAiAuth: true } });
  expect(res.statusCode).toBe(201);
  expect(t.setupCalls[0].seedAiAuth).toBe(true);
});

// Provisioning hands setupOptions straight to the setup job, so seeding here
// would land the credentials on a guest the same token can then run commands on.
test.each([[true], [1], ['yes']])('a device token cannot provision with setupOptions.seedAiAuth=%j', async (seedAiAuth) => {
  const t = await buildGuardedApp();
  const res = await t.app.inject({ method: 'POST', url: '/api/proxmox/provisions', headers: t.bearer, payload: { presetId: 'pr1', hostname: 'ct9', setupOptions: { seedAiAuth } } });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'browser session required' });
  expect(t.provisionCalls).toEqual([]);
});

test('a device token can provision without seeding', async () => {
  const t = await buildGuardedApp();
  const res = await t.app.inject({ method: 'POST', url: '/api/proxmox/provisions', headers: t.bearer, payload: { presetId: 'pr1', hostname: 'ct9', setupOptions: { ohMyTmux: true } } });
  expect(res.statusCode).toBe(201);
  expect(t.provisionCalls).toHaveLength(1);
});

test('a browser session can still seed from provisioning', async () => {
  const t = await buildGuardedApp();
  const res = await t.app.inject({ method: 'POST', url: '/api/proxmox/provisions', headers: t.browser, payload: { presetId: 'pr1', hostname: 'ct9', setupOptions: { seedAiAuth: true } } });
  expect(res.statusCode).toBe(201);
  expect(t.provisionCalls[0].setupOptions.seedAiAuth).toBe(true);
});

test('a device token may POST /api/boxes/:id/agent-seen', async () => {
  const seen = [];
  const appSeen = buildServer({
    config: {
      bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
      passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
      localShell: 'none', configPath: path.join(dir, 'config.json'),
    },
    store: createStore({ dataDir: dir }),
    sessions: { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} },
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    passkeyStore: createPasskeyStore({ dataDir: dir }),
    deviceStore,
    history: { getSeries: () => [], getEvents: () => ({ events: [], latestSeq: 0 }), record() {}, onEvent() {}, markSeen: (...a) => { seen.push(a); return true; } },
  });
  const { token } = (await appSeen.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } })).json();
  const res = await appSeen.inject({ method: 'POST', url: '/api/boxes/__local__/agent-seen', headers: { authorization: `Bearer ${token}` }, payload: { session: 'web', ts: 5 } });
  expect(res.statusCode).toBe(200);
  expect(seen).toEqual([['__local__', 'web', 5]]);
});
