import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createServicesStore } from '../src/server/servicesStore.js';
import { createServiceChecker } from '../src/server/serviceChecker.js';
import { hashPassword } from '../src/server/auth.js';
import { createSecretBox } from '../src/server/secretBox.js';
import { startFakePihole } from './helpers/fakePihole.js';

let app, dir, servicesStore, serviceChecker;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-svcr-'));
  servicesStore = createServicesStore({ dataDir: dir, secretBox: createSecretBox('test-secret') });
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
  app = buildServer({
    config, store: createStore({ dataDir: dir }), sessions, statusChecker, servicesStore, serviceChecker,
    // The truenas test route refuses http:, so a fake server on loopback cannot
    // be probed through it — the client seam is the injection point instead.
    makeTruenasClient: ({ apiKey }) => ({
      async fetchVersion() {
        return apiKey === '1-secretkey'
          ? { ok: true, version: '25.10.5', hostname: 'nas' }
          : { ok: false, kind: 'auth', error: 'API key rejected' };
      },
      async close() {},
    }),
  });
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

test('GET /api/services never leaks the sealed password', async () => {
  const h = await headers();
  const pi = await startFakePihole();
  await app.inject({
    method: 'POST', url: '/api/services', headers: h,
    payload: { name: 'pihole', url: pi.baseUrl, check: { kind: 'pihole' }, password: 'app-pw' },
  });
  const res = await app.inject({ method: 'GET', url: '/api/services', headers: h });
  await pi.stop();
  expect(res.statusCode).toBe(200);
  expect(res.body).not.toContain('app-pw');
  expect(res.body).not.toContain('pvebox.v1');
  expect(res.json()[0].hasPassword).toBe(true);
});

test('POST /api/services/pihole/test reports a good password with the version', async () => {
  const h = await headers();
  const pi = await startFakePihole();
  const res = await app.inject({
    method: 'POST', url: '/api/services/pihole/test', headers: h,
    payload: { url: pi.baseUrl, password: 'app-pw' },
  });
  await pi.stop();
  expect(res.json()).toEqual({ ok: true, version: 'v6.2.1' });
  expect(pi.counts.delete).toBe(1); // the probe revokes its own session
});

test('POST /api/services/pihole/test reports a bad password without echoing it', async () => {
  const h = await headers();
  const pi = await startFakePihole({ password: 'right' });
  const res = await app.inject({
    method: 'POST', url: '/api/services/pihole/test', headers: h,
    payload: { url: pi.baseUrl, password: 'wrong' },
  });
  await pi.stop();
  const body = res.json();
  expect(body.ok).toBe(false);
  expect(body.error).toMatch(/app password/i);
  expect(res.body).not.toContain('wrong');
});

test('POST /api/services/pihole/test falls back to the stored password when none is typed', async () => {
  const h = await headers();
  const pi = await startFakePihole();
  const created = await app.inject({
    method: 'POST', url: '/api/services', headers: h,
    payload: { name: 'pihole', url: pi.baseUrl, check: { kind: 'pihole' }, password: 'app-pw' },
  });
  const res = await app.inject({
    method: 'POST', url: '/api/services/pihole/test', headers: h,
    payload: { id: created.json().id, url: pi.baseUrl, password: '' },
  });
  await pi.stop();
  expect(res.json().ok).toBe(true);
});

test('POST /api/services/pihole/test requires authentication and a url', async () => {
  const h = await headers();
  expect((await app.inject({ method: 'POST', url: '/api/services/pihole/test', payload: { url: 'http://127.0.0.1/' } })).statusCode).toBe(401);
  const bad = await app.inject({ method: 'POST', url: '/api/services/pihole/test', headers: h, payload: { url: 'nonsense' } });
  expect(bad.json().ok).toBe(false);
});

test('POST /api/services/truenas/test refuses a plain-http url before building a client', async () => {
  const h = await headers();
  const res = await app.inject({
    method: 'POST', url: '/api/services/truenas/test', headers: h,
    payload: { url: 'http://192.168.1.20', username: 'truenas_admin', apiKey: '1-k' },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().ok).toBe(false);
  expect(res.json().error).toMatch(/revokes/i);
});

test('POST /api/services/truenas/test requires a username', async () => {
  const h = await headers();
  const res = await app.inject({
    method: 'POST', url: '/api/services/truenas/test', headers: h,
    payload: { url: 'https://nas.example.com', apiKey: '1-k' },
  });
  expect(res.json().ok).toBe(false);
  expect(res.json().error).toMatch(/username/i);
});

test('POST /api/services/truenas/test reports the version and never echoes the key', async () => {
  const h = await headers();
  const res = await app.inject({
    method: 'POST', url: '/api/services/truenas/test', headers: h,
    payload: { url: 'https://nas.example.com', username: 'truenas_admin', apiKey: '1-secretkey' },
  });
  expect(res.json()).toMatchObject({ ok: true, version: '25.10.5' });
  expect(res.payload).not.toContain('1-secretkey');
});

test('POST /api/services/truenas/test reports a rejected key without echoing it', async () => {
  const h = await headers();
  const res = await app.inject({
    method: 'POST', url: '/api/services/truenas/test', headers: h,
    payload: { url: 'https://nas.example.com', username: 'truenas_admin', apiKey: '1-wrongkey' },
  });
  expect(res.json()).toMatchObject({ ok: false });
  expect(res.json().error).toMatch(/rejected/i);
  expect(res.payload).not.toContain('1-wrongkey');
});

test('POST /api/services/truenas/test requires authentication', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/services/truenas/test',
    payload: { url: 'https://nas.example.com', username: 'u', apiKey: '1-k' },
  });
  expect(res.statusCode).toBe(401);
});
