import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { hashPassword } from '../src/server/auth.js';

const BOX = { id: 'b1', label: 'web', host: '192.168.1.10', user: 'root', sessionName: 'web', source: 'manual', tags: [] };

function fakeSetupManager() {
  const jobs = new Map();
  return {
    _started: [],
    start(box, options) {
      this._started.push({ box, options });
      const j = { id: 'j1', boxId: box.id, boxLabel: box.label, status: 'running', phase: 'running', options, log: '', error: null, createdAt: 'now', finishedAt: null };
      jobs.set(j.id, j);
      const { log, ...s } = j; return s;
    },
    getJob(id) { return jobs.get(id); },
    currentForBox(boxId) { return [...jobs.values()].find((j) => j.boxId === boxId) || null; },
    listJobs() { return [...jobs.values()].map(({ log, ...s }) => s); },
    markInteractiveResult() {}, cancelForBox() {},
  };
}

let app, sm;
beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-setupr-'));
  sm = fakeSetupManager();
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const store = { getBox: async (id) => (id === BOX.id ? BOX : null), removeBox: async () => {} };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }) };
  app = buildServer({ config, store, sessions, statusChecker, setupManager: sm });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('POST /api/boxes/:id/setup starts a job (201) with resolved tools', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/b1/setup', headers: h, payload: { ohMyTmux: true, tools: 'git,curl' } });
  expect(res.statusCode).toBe(201);
  expect(sm._started[0].options.ohMyTmux).toBe(true);
  expect(sm._started[0].options.tools).toEqual(expect.arrayContaining(['git', 'curl']));
});

test('POST rejects unknown tool ids with 400', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/b1/setup', headers: h, payload: { tools: 'not-a-real-tool' } });
  expect(res.statusCode).toBe(400);
});

test('POST 404 for an unknown box', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nope/setup', headers: h, payload: { tools: '' } });
  expect(res.statusCode).toBe(404);
});

test('GET /api/boxes/:id/setup returns 204 when no job, then the job', async () => {
  const h = await headers();
  let res = await app.inject({ method: 'GET', url: '/api/boxes/b1/setup', headers: h });
  expect(res.statusCode).toBe(204);
  await app.inject({ method: 'POST', url: '/api/boxes/b1/setup', headers: h, payload: { tools: '' } });
  res = await app.inject({ method: 'GET', url: '/api/boxes/b1/setup', headers: h });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).boxId).toBe('b1');
});

test('setup routes require auth', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/setup' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/boxes/b1/setup', payload: {} })).statusCode).toBe(401);
});

test('setup route forwards seedAiAuth', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${BOX.id}/setup`, headers: h, payload: { seedAiAuth: true } });
  expect(res.statusCode).toBe(201);
  expect(sm._started[0].options.seedAiAuth).toBe(true);
});

test('setup route defaults seedAiAuth to false', async () => {
  const h = await headers();
  await app.inject({ method: 'POST', url: `/api/boxes/${BOX.id}/setup`, headers: h, payload: { ohMyTmux: true } });
  expect(sm._started[0].options.seedAiAuth).toBe(false);
});
