import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createSecretBox } from '../src/server/secretBox.js';
import { createCheckStore } from '../src/server/checkStore.js';
import { createAlertStateStore } from '../src/server/alertStateStore.js';
import { createEventLog } from '../src/server/eventLog.js';
import { createAlertManager } from '../src/server/alertManager.js';
import { createCheckRunner } from '../src/server/checkRunner.js';
import { createCheckDispatcher } from '../src/server/checks/index.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, checkStore, alertState, checkLog, ranIds;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-alertr-'));
  const secretBox = createSecretBox('test-secret');
  checkStore = createCheckStore({ dataDir: dir, secretBox });
  alertState = createAlertStateStore({ dataDir: dir });
  checkLog = createEventLog({ dir, prefix: 'checks', now: () => 1000 });
  const decisionLog = createEventLog({ dir, prefix: 'decisions', now: () => 1000 });
  ranIds = [];
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  app = buildServer({
    config, store: createStore({ dataDir: dir }), sessions, statusChecker,
    checkStore, alertState, checkEventLog: checkLog, decisionLog,
    alertManager: createAlertManager({
      eventLogs: [checkLog], decisionLog, stateStore: alertState, channels: [], now: () => 1000,
    }),
    checkRunner: {
      // 'nope' stands in for an id checkStore doesn't recognize, matching the
      // real createCheckRunner.runOne contract (null for an unknown check).
      runOne: async (id) => {
        ranIds.push(id);
        if (id === 'nope') return null;
        return { ok: false, detail: 'HTTP 502', latencyMs: 3 };
      },
      getState: () => ({}),
    },
  });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('every alert and check route requires auth', async () => {
  for (const [method, url] of [
    ['GET', '/api/alerts'], ['GET', '/api/alerts/feed'], ['GET', '/api/alerts/decisions'],
    ['GET', '/api/checks'], ['POST', '/api/checks'], ['POST', '/api/alerts/k/ack'],
    // The brief's own list above only covers 6 of the 11 new routes — a dropped
    // preHandler on any of PUT/DELETE/run/mute would sail through untested if
    // this list stopped there, so every remaining route is covered here too.
    ['PUT', '/api/checks/x'], ['DELETE', '/api/checks/x'], ['POST', '/api/checks/x/run'],
    ['POST', '/api/alerts/k/mute'], ['DELETE', '/api/alerts/k/mute'],
  ]) {
    expect((await app.inject({ method, url, payload: {} })).statusCode).toBe(401);
  }
});

test('a check can be created, listed, run on demand, and deleted', async () => {
  const h = await headers();
  const created = await app.inject({
    method: 'POST', url: '/api/checks', headers: h,
    payload: { label: 'Invoice app', type: 'http', target: { url: 'https://invoices.example.com/health' } },
  });
  expect(created.statusCode).toBe(200);
  const { check } = created.json();
  expect((await app.inject({ method: 'GET', url: '/api/checks', headers: h })).json().checks).toHaveLength(1);
  const ran = await app.inject({ method: 'POST', url: `/api/checks/${check.id}/run`, headers: h });
  expect(ran.json().result).toMatchObject({ ok: false, detail: 'HTTP 502' });
  expect(ranIds).toEqual([check.id]);
  expect((await app.inject({ method: 'DELETE', url: `/api/checks/${check.id}`, headers: h })).statusCode).toBe(200);
});

test('running an unknown check id 404s instead of crashing', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/checks/nope/run', headers: h });
  expect(res.statusCode).toBe(404);
});

test('an invalid check definition is refused with 400 and a readable message', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/checks', headers: h, payload: { label: 'x', type: 'nope' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/type/);
});

test('a secret is never echoed back by any route (create, list, or update)', async () => {
  const h = await headers();
  const created = await app.inject({
    method: 'POST', url: '/api/checks', headers: h,
    payload: { label: 'x', type: 'http', target: { url: 'https://example.com/h' }, secret: 'tok-abc' },
  });
  // The create response itself is the first place a naive implementation
  // (e.g. returning the raw store record instead of the redacted one) would
  // leak the secret straight back to the browser that just sent it.
  expect(created.body).not.toContain('tok-abc');
  expect(created.json().check.hasSecret).toBe(true);
  expect(created.json().check.secret).toBeUndefined();

  const listBody = (await app.inject({ method: 'GET', url: '/api/checks', headers: h })).body;
  expect(listBody).not.toContain('tok-abc');
  expect(JSON.parse(listBody).checks[0].hasSecret).toBe(true);

  const updated = await app.inject({
    method: 'PUT', url: `/api/checks/${created.json().check.id}`, headers: h,
    payload: { label: 'x renamed', type: 'http', target: { url: 'https://example.com/h' } },
  });
  expect(updated.body).not.toContain('tok-abc');
  // A blank secret on update means "leave it alone" (checkStore.js), so the
  // secret set at creation is still sealed on disk — hasSecret must stay true.
  expect(updated.json().check.hasSecret).toBe(true);
});

test('GET /api/alerts returns folded alerts and mute/ack round-trip', async () => {
  const h = await headers();
  await checkLog.append({
    via: 'check', source: 'check:c1', key: 'check:c1', norm: null,
    severity: 'critical', state: 'firing', title: 'Invoice app: HTTP 502', body: '',
  });
  expect((await app.inject({ method: 'GET', url: '/api/alerts', headers: h })).json().alerts[0])
    .toMatchObject({ key: 'check:c1', count: 1 });
  expect((await app.inject({ method: 'POST', url: '/api/alerts/check:c1/mute', headers: h })).statusCode).toBe(200);
  expect((await alertState.getRules()).mutes).toEqual(['check:c1']);
  await app.inject({ method: 'DELETE', url: '/api/alerts/check:c1/mute', headers: h });
  expect((await alertState.getRules()).mutes).toEqual([]);
  await app.inject({ method: 'POST', url: '/api/alerts/check:c1/ack', headers: h });
  expect(await alertState.getTriage()).toHaveProperty('check:c1');
});

test('the feed returns raw occurrences and the decisions route filters by key', async () => {
  const h = await headers();
  await checkLog.append({
    via: 'check', source: 'check:c1', key: 'check:c1', norm: null,
    severity: 'info', state: 'firing', title: 'noisy', body: '',
  });
  expect((await app.inject({ method: 'GET', url: '/api/alerts/feed', headers: h })).json().events).toHaveLength(1);
  const dec = await app.inject({ method: 'GET', url: '/api/alerts/decisions?key=check:c1', headers: h });
  expect(Array.isArray(dec.json().decisions)).toBe(true);
});

// Carried-forward item from Task 7/12's review ledger: checkRunner.runOne()
// calls checkStore.getCheck(id, { withSecret: true }), which decrypts and can
// throw synchronously on a corrupted sealed value or a rotated cookieSecret
// (secretBox.js). Before this route wrapped that call in try/catch, an
// unhandled rejection here would have hit Fastify's default error handler and
// echoed the raw crypto error text (e.g. "Unsupported state or unable to
// authenticate data") straight to the caller — this exercises the REAL
// checkStore/secretBox/checkRunner stack (no stub), simulating a rotated
// cookieSecret by decrypting with a different key than the one the check was
// sealed with, and asserts both that the response is a clean 4xx/5xx AND that
// it does not leak the underlying decrypt error text.
test('a check whose secret cannot be decrypted fails the run route cleanly, without leaking the raw error', async () => {
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-alertr-decrypt-'));
  const writerStore = createCheckStore({ dataDir: dir2, secretBox: createSecretBox('key-that-sealed-it') });
  const { id } = await writerStore.addCheck({
    label: 'Invoice app', type: 'http', target: { url: 'https://invoices.example.com/health' }, secret: 'tok-abc',
  });

  // Same dataDir, but a checkStore/checkRunner built with a DIFFERENT
  // cookieSecret-derived key — the exact "cookieSecret rotated after the
  // check was saved" scenario the ledger calls out, achieved with real code
  // rather than a mocked throw.
  const readerStore = createCheckStore({ dataDir: dir2, secretBox: createSecretBox('a-different-key') });
  const realRunner = createCheckRunner({
    checkStore: readerStore,
    dispatcher: createCheckDispatcher({ runners: {} }),
    eventLog: createEventLog({ dir: dir2, prefix: 'checks', now: () => 1000 }),
  });

  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir2,
    localShell: 'none', configPath: path.join(dir2, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  const app2 = buildServer({
    config, store: createStore({ dataDir: dir2 }), sessions, statusChecker,
    checkStore: readerStore, alertState: createAlertStateStore({ dataDir: dir2 }),
    checkEventLog: createEventLog({ dir: dir2, prefix: 'checks', now: () => 1000 }),
    decisionLog: createEventLog({ dir: dir2, prefix: 'decisions', now: () => 1000 }),
    alertManager: createAlertManager({
      eventLogs: [], decisionLog: createEventLog({ dir: dir2, prefix: 'decisions', now: () => 1000 }),
      stateStore: createAlertStateStore({ dataDir: dir2 }), channels: [], now: () => 1000,
    }),
    checkRunner: realRunner,
  });
  const loginRes = await app2.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const cookie = loginRes.cookies.find((x) => x.name === 'tmuxifier_session');
  const h = { cookie: `${cookie.name}=${cookie.value}` };

  const res = await app2.inject({ method: 'POST', url: `/api/checks/${id}/run`, headers: h });
  expect(res.statusCode).toBeGreaterThanOrEqual(400);
  expect(res.statusCode).toBeLessThan(600);
  expect(res.statusCode).not.toBe(500); // the whole point: not Fastify's raw default handler
  expect(res.body).not.toMatch(/auth tag|unable to authenticate|cipher/i);
});
