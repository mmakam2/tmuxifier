import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createNetboxStore } from '../src/server/netboxStore.js';
import { createSecretBox } from '../src/server/secretBox.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, netboxStore, testCalls;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-nbxr-'));
  netboxStore = createNetboxStore({ dataDir: dir, secretBox: createSecretBox('test-secret') });
  testCalls = [];
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  app = buildServer({
    config, store: createStore({ dataDir: dir }), sessions, statusChecker, netboxStore,
    netboxTest: async (candidate) => { testCalls.push(candidate); return { ok: true, version: '4.3.2' }; },
  });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('netbox routes require auth', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/netbox/settings' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'PUT', url: '/api/netbox/settings', payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'DELETE', url: '/api/netbox/settings' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/netbox/test', payload: {} })).statusCode).toBe(401);
});

test('GET returns null settings before configuration', async () => {
  const h = await headers();
  expect((await app.inject({ method: 'GET', url: '/api/netbox/settings', headers: h })).json()).toEqual({ settings: null });
});

test('PUT round-trip: saved redacted, token never in any response body', async () => {
  const h = await headers();
  const put = await app.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://netbox.example.com/', token: 'nb-secret-token' } });
  expect(put.statusCode).toBe(200);
  expect(put.json().settings).toMatchObject({ url: 'https://netbox.example.com', tlsMode: 'ca', hasToken: true });
  expect(put.body).not.toContain('nb-secret-token');
  const get = await app.inject({ method: 'GET', url: '/api/netbox/settings', headers: h });
  expect(get.json().settings.hasToken).toBe(true);
  expect(get.body).not.toContain('nb-secret-token');
});

test('PUT rejects a bad URL with 400', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'nope', token: 't' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/URL/);
});

test('PUT with blank token keeps the stored token', async () => {
  const h = await headers();
  await app.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://netbox.example.com', token: 'nb-secret-token' } });
  const res = await app.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://nb2.example.com', token: '' } });
  expect(res.statusCode).toBe(200);
  expect((await netboxStore.getSettings({ withSecret: true })).token).toBe('nb-secret-token');
});

test('DELETE clears settings', async () => {
  const h = await headers();
  await app.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://netbox.example.com', token: 't0k' } });
  expect((await app.inject({ method: 'DELETE', url: '/api/netbox/settings', headers: h })).json()).toEqual({ ok: true });
  expect((await app.inject({ method: 'GET', url: '/api/netbox/settings', headers: h })).json()).toEqual({ settings: null });
});

test('POST test merges body over stored settings and falls back to the stored token', async () => {
  const h = await headers();
  await app.inject({ method: 'PUT', url: '/api/netbox/settings', headers: h, payload: { url: 'https://netbox.example.com', token: 'stored-tok' } });
  const res = await app.inject({ method: 'POST', url: '/api/netbox/test', headers: h, payload: { url: 'https://nb2.example.com', token: '' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, version: '4.3.2' });
  expect(testCalls[0]).toMatchObject({ url: 'https://nb2.example.com', token: 'stored-tok' });
  expect(res.body).not.toContain('stored-tok');
});

test('POST test with no token anywhere is a 400', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/netbox/test', headers: h, payload: { url: 'https://netbox.example.com' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/token/);
});

test('POST test with a body token needs no stored settings', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/netbox/test', headers: h, payload: { url: 'http://192.168.1.10:8000', token: 'fresh-tok' } });
  expect(res.statusCode).toBe(200);
  expect(testCalls[0]).toMatchObject({ url: 'http://192.168.1.10:8000', token: 'fresh-tok', tlsMode: null });
});
