import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createUiSettingsStore } from '../src/server/uiSettingsStore.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-uisr-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  app = buildServer({
    config, store: createStore({ dataDir: dir }), sessions, statusChecker,
    uiSettingsStore: createUiSettingsStore({ dataDir: dir }),
  });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('both routes require auth', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/ui-settings' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'PATCH', url: '/api/ui-settings', payload: {} })).statusCode).toBe(401);
});

test('GET returns nulls when unset; PATCH persists and merges', async () => {
  const h = await headers();
  expect((await app.inject({ method: 'GET', url: '/api/ui-settings', headers: h })).json())
    .toEqual({ theme: null, clawdAnim: null });
  const patched = await app.inject({ method: 'PATCH', url: '/api/ui-settings', headers: h, payload: { theme: 'original' } });
  expect(patched.statusCode).toBe(200);
  expect(patched.json()).toEqual({ theme: 'original', clawdAnim: null });
  await app.inject({ method: 'PATCH', url: '/api/ui-settings', headers: h, payload: { clawdAnim: 'star' } });
  expect((await app.inject({ method: 'GET', url: '/api/ui-settings', headers: h })).json())
    .toEqual({ theme: 'original', clawdAnim: 'star' });
});

test('PATCH rejects invalid slugs with 400 and stores nothing', async () => {
  const h = await headers();
  const bad = await app.inject({ method: 'PATCH', url: '/api/ui-settings', headers: h, payload: { theme: 'No Spaces' } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toMatch(/invalid theme/);
  expect((await app.inject({ method: 'GET', url: '/api/ui-settings', headers: h })).json().theme).toBe(null);
});

test('PATCH null clears', async () => {
  const h = await headers();
  await app.inject({ method: 'PATCH', url: '/api/ui-settings', headers: h, payload: { theme: 'original' } });
  const cleared = await app.inject({ method: 'PATCH', url: '/api/ui-settings', headers: h, payload: { theme: null } });
  expect(cleared.json()).toEqual({ theme: null, clawdAnim: null });
});
