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
