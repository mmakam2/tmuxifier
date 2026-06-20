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
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const statusChecker = { checkBox: async () => ({ reachable: true, tmux: true, sessions: [] }) };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  return buildServer({ config, store, sessions, statusChecker, ...overrides });
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

test('login then CRUD a box', async () => {
  const cookie = await login();
  expect(cookie).toBeTruthy();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });
  expect(created.statusCode).toBe(200);
  const box = created.json();
  expect(box.host).toBe('h1');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()).toHaveLength(1);

  const del = await app.inject({ method: 'DELETE', url: `/api/boxes/${box.id}`, headers });
  expect(del.statusCode).toBe(200);
});

test('adding a box provisions tmux and rolls back if provisioning fails', async () => {
  const boxActions = { ensureReady: async () => { throw new Error('install failed'); } };
  app = await makeApp({ boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });
  expect(created.statusCode).toBe(400);
  expect(created.json().error).toBe('install failed');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()).toHaveLength(0);
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
