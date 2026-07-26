import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createServicesStore } from '../src/server/servicesStore.js';
import { createServiceChecker } from '../src/server/serviceChecker.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, servicesStore, serviceChecker;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-svcr-'));
  servicesStore = createServicesStore({ dataDir: dir });
  serviceChecker = createServiceChecker({
    store: servicesStore,
    check: async () => ({ state: 'up', latencyMs: 7 }),
  });
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  app = buildServer({ config, store: createStore({ dataDir: dir }), sessions, statusChecker, servicesStore, serviceChecker });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('service routes require auth', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/services' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/services', payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'PATCH', url: '/api/services/svc-x', payload: {} })).statusCode).toBe(401);
  expect((await app.inject({ method: 'DELETE', url: '/api/services/svc-x' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/api/services/status' })).statusCode).toBe(401);
});

test('CRUD round-trip with validation errors as 400 and unknown id as 404', async () => {
  const h = await headers();
  const bad = await app.inject({ method: 'POST', url: '/api/services', headers: h, payload: { name: 'X', url: 'nonsense' } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toMatch(/URL/);

  const created = await app.inject({ method: 'POST', url: '/api/services', headers: h, payload: { name: 'Grafana', url: 'http://192.168.1.20:3000/', group: 'Mon' } });
  expect(created.statusCode).toBe(200);
  const svc = created.json();

  const listed = await app.inject({ method: 'GET', url: '/api/services', headers: h });
  expect(listed.json()).toEqual([svc]);

  const patched = await app.inject({ method: 'PATCH', url: `/api/services/${svc.id}`, headers: h, payload: { name: 'Grafana 2' } });
  expect(patched.json()).toMatchObject({ id: svc.id, name: 'Grafana 2', url: svc.url });

  expect((await app.inject({ method: 'PATCH', url: '/api/services/svc-missing', headers: h, payload: { name: 'x' } })).statusCode).toBe(404);

  const removed = await app.inject({ method: 'DELETE', url: `/api/services/${svc.id}`, headers: h });
  expect(removed.json()).toEqual({ ok: true });
  expect((await app.inject({ method: 'GET', url: '/api/services', headers: h })).json()).toEqual([]);
});

test('status route serves the cached snapshot without triggering checks', async () => {
  const h = await headers();
  await app.inject({ method: 'POST', url: '/api/services', headers: h, payload: { name: 'A', url: 'http://a.example.com/' } });
  const before = await app.inject({ method: 'GET', url: '/api/services/status', headers: h });
  expect(before.json()).toEqual({ checkedAt: null, results: {} }); // nothing swept yet
  await serviceChecker.pollOnce();
  const after = await app.inject({ method: 'GET', url: '/api/services/status', headers: h });
  expect(Object.values(after.json().results)).toEqual([{ state: 'up', latencyMs: 7 }]);
});
