import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { hashPassword } from '../src/server/auth.js';

let app;
let dir;

async function makeApp(overrides = {}) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-srv-'));
  const { config: configOverrides, ...serverOverrides } = overrides;
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
    ...configOverrides,
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const statusChecker = { checkBox: async () => ({ reachable: true, tmux: true, sessions: [] }) };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  return buildServer({ config, store, sessions, statusChecker, ...serverOverrides });
}

beforeEach(async () => { app = await makeApp(); });

async function login() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  return res.cookies.find((c) => c.name === 'tmuxifier_session');
}

test('rejects unauthenticated box listing', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/boxes' });
  expect(res.statusCode).toBe(401);
});

test('/api/auth/info reports password mode', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/info' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ mode: 'password' });
});

test('public responses include browser hardening headers', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/info' });
  expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(res.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'");
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  expect(res.headers['cache-control']).toBe('no-store');
});

test('login then CRUD a box', async () => {
  const cookie = await login();
  expect(cookie).toBeTruthy();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });
  expect(created.statusCode).toBe(201);
  const box = created.json();
  expect(box.host).toBe('h1');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()).toHaveLength(1);

  const del = await app.inject({ method: 'DELETE', url: `/api/boxes/${box.id}`, headers });
  expect(del.statusCode).toBe(200);
});

test('POST /api/boxes returns immediately without provisioning, even if boxActions would fail', async () => {
  const boxActions = { ensureReady: async () => { throw new Error('install failed'); } };
  app = await makeApp({ boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });
  expect(created.statusCode).toBe(201);
  expect(created.json().host).toBe('h1');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()).toHaveLength(1);
});

test('POST /api/boxes does not persist installOhMyTmux on the stored box', async () => {
  const calls = [];
  const boxActions = {
    async ensureReady(box, options) { calls.push({ box, options }); },
  };
  app = await makeApp({ boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', installOhMyTmux: true },
  });

  expect(created.statusCode).toBe(201);
  // ensureReady is no longer called from POST
  expect(calls).toHaveLength(0);
  expect(created.json()).not.toHaveProperty('installOhMyTmux');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()[0]).not.toHaveProperty('installOhMyTmux');
});

test('POST /api/boxes does not persist installOhMyZsh on the stored box', async () => {
  const calls = [];
  const boxActions = {
    async ensureReady(box, options) { calls.push({ box, options }); },
  };
  app = await makeApp({ boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', installOhMyZsh: true },
  });

  expect(created.statusCode).toBe(201);
  expect(calls).toHaveLength(0);
  expect(created.json()).not.toHaveProperty('installOhMyZsh');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()[0]).not.toHaveProperty('installOhMyZsh');
});

test('POST /api/boxes strips both installOhMyTmux and installOhMyZsh from stored box', async () => {
  const calls = [];
  const boxActions = {
    async ensureReady(box, options) { calls.push({ box, options }); },
  };
  app = await makeApp({ boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', installOhMyTmux: true, installOhMyZsh: true },
  });

  expect(created.statusCode).toBe(201);
  expect(calls).toHaveLength(0);
  expect(created.json()).not.toHaveProperty('installOhMyTmux');
  expect(created.json()).not.toHaveProperty('installOhMyZsh');
});

test('POST /api/boxes does not persist installOhMyBash on the stored box', async () => {
  const calls = [];
  const boxActions = {
    async ensureReady(box, options) { calls.push({ box, options }); },
  };
  app = await makeApp({ boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', installOhMyBash: true },
  });

  expect(created.statusCode).toBe(201);
  // ensureReady is no longer called from POST
  expect(calls).toHaveLength(0);
  expect(created.json()).not.toHaveProperty('installOhMyBash');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()[0]).not.toHaveProperty('installOhMyBash');
});

test('POST /api/boxes strips all three transient options from stored box', async () => {
  const calls = [];
  const boxActions = {
    async ensureReady(box, options) { calls.push({ box, options }); },
  };
  app = await makeApp({ boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', installOhMyTmux: true, installOhMyZsh: true, installOhMyBash: true },
  });

  expect(created.statusCode).toBe(201);
  expect(calls).toHaveLength(0);
  expect(created.json()).not.toHaveProperty('installOhMyTmux');
  expect(created.json()).not.toHaveProperty('installOhMyZsh');
  expect(created.json()).not.toHaveProperty('installOhMyBash');
});

test('PATCH /api/boxes/:id does not persist installOhMyBash on the stored box', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1' },
  });
  const box = created.json();

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/boxes/${box.id}`,
    headers,
    payload: { label: 'updated', installOhMyBash: true },
  });

  expect(patched.statusCode).toBe(200);
  expect(patched.json()).not.toHaveProperty('installOhMyBash');
  expect(patched.json().label).toBe('updated');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()[0]).not.toHaveProperty('installOhMyBash');
});

test('rejects cross-origin state-changing requests', async () => {
  app = await makeApp({ config: { publicUrl: 'https://tmux.example.com' } });
  const cookie = await login();
  const headers = {
    cookie: `${cookie.name}=${cookie.value}`,
    origin: 'https://evil.example',
  };

  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });

  expect(created.statusCode).toBe(403);
  expect(created.json()).toEqual({ error: 'forbidden origin' });
  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers: { cookie: headers.cookie } });
  expect(list.json()).toHaveLength(0);
});

test('allows same-origin state-changing requests', async () => {
  app = await makeApp({ config: { publicUrl: 'https://tmux.example.com' } });
  const cookie = await login();
  const headers = {
    cookie: `${cookie.name}=${cookie.value}`,
    origin: 'https://tmux.example.com',
  };

  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });

  expect(created.statusCode).toBe(201);
  expect(created.json().host).toBe('h1');
});

test('removing a box closes local terminal and best-effort kills remote session before deletion', async () => {
  const calls = [];
  const sessions = {
    open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {},
    closeKey(id) { calls.push(['closeKey', id]); },
  };
  const boxActions = {
    async killSession(box) { calls.push(['killSession', box.host, box.sessionName]); },
  };
  app = await makeApp({ sessions, boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', sessionName: 'work' },
  });
  const box = created.json();

  const del = await app.inject({ method: 'DELETE', url: `/api/boxes/${box.id}`, headers });

  expect(del.statusCode).toBe(200);
  expect(calls).toEqual([
    ['closeKey', box.id],
    ['killSession', 'h1', 'work'],
  ]);
  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()).toHaveLength(0);
});

test('removing a box does not wait for remote session cleanup', async () => {
  let killCalled = false;
  const boxActions = {
    killSession() {
      killCalled = true;
      return new Promise(() => {});
    },
  };
  app = await makeApp({ boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', sessionName: 'work' },
  });
  const box = created.json();

  const del = await app.inject({ method: 'DELETE', url: `/api/boxes/${box.id}`, headers });

  expect(del.statusCode).toBe(200);
  expect(killCalled).toBe(true);
  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()).toHaveLength(0);
});

test('wrong password is rejected', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'bad' } });
  expect(res.statusCode).toBe(401);
});

test('status endpoint returns a map keyed by box id', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });
  const id = created.json().id;
  const res = await app.inject({ method: 'GET', url: '/api/status', headers });
  expect(res.json()[id]).toMatchObject({ reachable: true });
});

test('rejects a forged unsigned tmuxifier_session cookie', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/boxes', headers: { cookie: 'tmuxifier_session=ok' } });
  expect(res.statusCode).toBe(401);
});

test('rejects a tampered signed tmuxifier_session cookie', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/boxes',
    headers: { cookie: 'tmuxifier_session=s%3Aok.deadbeefbadsignature0000000000000000000000' },
  });
  expect(res.statusCode).toBe(401);
});

test('reconnect closes local sessions and best-effort kills remote session', async () => {
  const calls = [];
  const sessions = {
    open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {},
    closeKey(id) { calls.push(['closeKey', id]); },
  };
  const boxActions = {
    async killSession(box) { calls.push(['killSession', box.host, box.sessionName]); },
  };
  app = await makeApp({ sessions, boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', sessionName: 'work' },
  });
  const box = created.json();

  const res = await app.inject({ method: 'POST', url: `/api/boxes/${box.id}/reconnect`, headers });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(calls).toEqual([
    ['closeKey', box.id],
    ['closeKey', `provision:${box.id}`],
    ['killSession', 'h1', 'work'],
  ]);
  // Box should still exist (not removed)
  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()).toHaveLength(1);
});

test('reconnect returns 404 for unknown box', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nonexistent/reconnect', headers });
  expect(res.statusCode).toBe(404);
});

test('reconnect does not wait for remote session cleanup', async () => {
  let killCalled = false;
  const boxActions = {
    killSession() {
      killCalled = true;
      return new Promise(() => {});
    },
  };
  app = await makeApp({ boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', sessionName: 'work' },
  });
  const box = created.json();

  const res = await app.inject({ method: 'POST', url: `/api/boxes/${box.id}/reconnect`, headers });

  expect(res.statusCode).toBe(200);
  expect(killCalled).toBe(true);
});
