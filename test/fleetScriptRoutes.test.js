import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createFleetScriptsStore } from '../src/server/fleetScriptsStore.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-fsr-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  app = buildServer({
    config, store: createStore({ dataDir: dir }), sessions, statusChecker,
    fleetScriptsStore: createFleetScriptsStore({ dataDir: dir }),
  });
});

async function login() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  return res.headers['set-cookie'];
}

test('every saved-script route requires auth', async () => {
  for (const [method, url] of [['GET', '/api/fleet/scripts'], ['POST', '/api/fleet/scripts'],
    ['PATCH', '/api/fleet/scripts/fs-1'], ['DELETE', '/api/fleet/scripts/fs-1']]) {
    const res = await app.inject({ method, url, payload: {} });
    expect(res.statusCode, `${method} ${url}`).toBe(401);
  }
});

test('create, list, update and delete a saved script', async () => {
  const cookie = await login();
  expect((await app.inject({ method: 'GET', url: '/api/fleet/scripts', headers: { cookie } })).json()).toEqual([]);

  const created = await app.inject({
    method: 'POST', url: '/api/fleet/scripts', headers: { cookie },
    payload: { name: 'apt upgrade', description: 'updates every box', script: 'sudo apt-get -y upgrade' },
  });
  expect(created.statusCode).toBe(201);
  const rec = created.json();
  expect(rec).toMatchObject({ name: 'apt upgrade', description: 'updates every box', script: 'sudo apt-get -y upgrade' });

  const listed = await app.inject({ method: 'GET', url: '/api/fleet/scripts', headers: { cookie } });
  expect(listed.json()).toEqual([rec]);

  const patched = await app.inject({
    method: 'PATCH', url: `/api/fleet/scripts/${rec.id}`, headers: { cookie },
    payload: { script: 'echo patched' },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json()).toMatchObject({ id: rec.id, name: 'apt upgrade', script: 'echo patched' });

  const removed = await app.inject({ method: 'DELETE', url: `/api/fleet/scripts/${rec.id}`, headers: { cookie } });
  expect(removed.json()).toEqual({ ok: true });
  expect((await app.inject({ method: 'GET', url: '/api/fleet/scripts', headers: { cookie } })).json()).toEqual([]);
});

test('an invalid body is 400 and an unknown id is 404', async () => {
  const cookie = await login();
  const bad = await app.inject({ method: 'POST', url: '/api/fleet/scripts', headers: { cookie }, payload: { name: '', script: 'x' } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toMatch(/name/);

  const missing = await app.inject({ method: 'PATCH', url: '/api/fleet/scripts/fs-nope', headers: { cookie }, payload: { script: 'x' } });
  expect(missing.statusCode).toBe(404);

  const created = await app.inject({ method: 'POST', url: '/api/fleet/scripts', headers: { cookie }, payload: { name: 'dup', script: 'x' } });
  const dup = await app.inject({ method: 'POST', url: '/api/fleet/scripts', headers: { cookie }, payload: { name: 'DUP', script: 'y' } });
  expect(dup.statusCode).toBe(400);
  expect(dup.json().error).toMatch(/already exists/);
  expect(created.statusCode).toBe(201);
});
