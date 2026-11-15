import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createDeviceStore } from '../src/server/deviceStore.js';
import { hashPassword } from '../src/server/auth.js';
import { createMailHarness } from './helpers/agentMailHarness.js';

// The browser routes over the real mail store, policy store and hub (the harness) and a real
// box store; only `forward` and `kick` are stubs, as they belong to the ssh layer.

let dir, h, store, app, kicks;
const route = (m, url, extra = {}) => app.inject({ method: m, url, headers: browser, ...extra });
let browser, bearer;

async function boot({ withMail = true } = {}) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-mailr-'));
  h = await createMailHarness({}, { boxes: [], policies: {} });
  store = createStore({ dataDir: dir });
  // The harness hub reads h.boxes; keep it in step with the real box store.
  const mk = async (host, label) => {
    const b = await store.addBox({ host, label });
    h.boxes.push({ id: b.id, label: b.label, sessionName: b.sessionName ?? 'main' });
    return b;
  };
  const orders = await mk('192.168.1.10', 'orders');
  const billing = await mk('192.168.1.11', 'billing');
  const search = await mk('192.168.1.12', 'search');
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const deviceStore = createDeviceStore({ dataDir: dir });
  kicks = 0;
  const forward = { status: () => ({ state: 'up', installed: true, listening: 1 }) };
  app = buildServer({
    config, store, deviceStore,
    sessions: { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} },
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    agentMail: withMail ? { hub: h.hub, store: h.store, policyStore: h.policyStore, forward, kick: async () => { kicks++; } } : null,
  });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === 'tmuxifier_session');
  browser = { cookie: `${c.name}=${c.value}` };
  const { token } = (await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'Fold' } })).json();
  bearer = { authorization: `Bearer ${token}` };
  return { orders, billing, search };
}

afterEach(async () => {
  await app?.close();
  await h?.cleanup();
  await fs.rm(dir, { recursive: true, force: true });
});

const ROUTES = (id, tid) => [
  ['GET', '/api/mail/threads'],
  ['GET', `/api/mail/threads/${tid}`],
  ['POST', `/api/mail/threads/${tid}/close`],
  ['GET', '/api/mail/refusals'],
  ['GET', `/api/boxes/${id}/mail`],
  ['PUT', `/api/boxes/${id}/mail`],
];

test('every mail route is 401 without a session, 403 for a device token, 404 when agentMail is null', async () => {
  const { orders } = await boot();
  const t = h.store.createThread({ starter: { boxId: orders.id, session: 'main' }, peer: { boxId: orders.id, session: 'other' } });
  for (const [m, url] of ROUTES(orders.id, t.id)) {
    expect((await app.inject({ method: m, url, payload: m === 'PUT' ? {} : undefined })).statusCode, `${m} ${url} anon`).toBe(401);
    const dev = await app.inject({ method: m, url, headers: bearer, payload: m === 'PUT' ? {} : undefined });
    expect(dev.statusCode, `${m} ${url} device`).toBe(403);
    expect(dev.json()).toEqual({ error: 'browser session required' });
  }
  // the device PUT wrote nothing
  expect(await h.policyStore.all()).toEqual({});
  await app.close(); await h.cleanup();
  const { orders: o2 } = await boot({ withMail: false });
  for (const [m, url] of ROUTES(o2.id, 't-abcdefgh')) {
    expect((await route(m, url, m === 'PUT' ? { payload: {} } : {})).statusCode, `${m} ${url} off`).toBe(404);
  }
});

test('PUT then GET round-trips the policy and returns pairs with the missing half named', async () => {
  const { orders, billing } = await boot();
  const put = await route('PUT', `/api/boxes/${orders.id}/mail`, { payload: { send: true, sendTo: [billing.id], receive: false, receiveFrom: [] } });
  expect(put.statusCode).toBe(200);
  const expected = {
    policy: { send: true, sendTo: [billing.id], receive: false, receiveFrom: [] },
    pairs: [{ boxId: billing.id, send: { ok: false, code: 'receive-off' }, receive: null }],
    status: { state: 'up', installed: true, listening: 1 },
  };
  expect(put.json()).toEqual(expected);
  expect((await route('GET', `/api/boxes/${orders.id}/mail`)).json()).toEqual(expected);
  expect(kicks).toBe(1);
  // an untouched box reads as the empty policy
  expect((await route('GET', `/api/boxes/${billing.id}/mail`)).json().policy).toEqual({ send: false, sendTo: [], receive: false, receiveFrom: [] });
  expect((await route('GET', '/api/boxes/nope/mail')).statusCode).toBe(404);
  expect((await route('PUT', '/api/boxes/nope/mail', { payload: {} })).statusCode).toBe(404);
});

test('PUT with mirror writes the counterpart on the other box in the same request', async () => {
  const { orders, billing } = await boot();
  const res = await route('PUT', `/api/boxes/${orders.id}/mail`, { payload: { send: true, sendTo: [billing.id], mirror: [billing.id] } });
  expect(res.statusCode).toBe(200);
  expect((await h.policyStore.get(billing.id)).receiveFrom).toEqual([orders.id]);
  expect((await h.policyStore.get(billing.id)).receive).toBe(false);
});

test('PUT with an unknown box id in a list is 400 and writes nothing; a bad mirror is 400', async () => {
  const { orders, billing } = await boot();
  const bad = await route('PUT', `/api/boxes/${orders.id}/mail`, { payload: { send: true, sendTo: ['ghost'] } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toMatch(/unknown box: ghost/);
  expect(await h.policyStore.all()).toEqual({});
  for (const mirror of ['x', [1], { a: 1 }]) {
    expect((await route('PUT', `/api/boxes/${orders.id}/mail`, { payload: { send: true, sendTo: [billing.id], mirror } })).statusCode).toBe(400);
  }
  expect((await route('PUT', `/api/boxes/${orders.id}/mail`, { payload: { send: 'yes', sendTo: 'x' } })).statusCode).toBe(400);
  expect(await h.policyStore.all()).toEqual({});
  expect(kicks).toBe(0);
});

test('PUT that removes a permission closes the thread it allowed', async () => {
  const { orders, billing } = await boot();
  await route('PUT', `/api/boxes/${orders.id}/mail`, { payload: { send: true, sendTo: [billing.id], mirror: [billing.id] } });
  await route('PUT', `/api/boxes/${billing.id}/mail`, { payload: { receive: true, receiveFrom: [orders.id] } });
  const t = h.store.createThread({ starter: { boxId: orders.id, session: 'main' }, peer: { boxId: billing.id, session: 'main' } });
  h.store.addMessage(t.id, { from: 'starter', body: 'hi' });
  await route('PUT', `/api/boxes/${orders.id}/mail`, { payload: { send: true, sendTo: [], receive: false, receiveFrom: [] } });
  const after = h.store.thread(t.id);
  expect(after.state).toBe('closed');
  expect(after.reason).toBe('permission withdrawn');
});

test('threads list is newest first and carries no bodies; one thread carries them', async () => {
  const { orders, billing } = await boot();
  const mk = () => h.store.createThread({ starter: { boxId: orders.id, session: 'main' }, peer: { boxId: billing.id, session: 'main' } });
  const a = mk();
  h.clock += 10;
  const b = mk();
  h.store.addMessage(a.id, { from: 'starter', body: 'SECRET-BODY' });
  h.clock += 10;
  h.store.addMessage(b.id, { from: 'starter', body: 'other' });
  h.clock += 10;
  h.store.addMessage(a.id, { from: 'peer', body: '<b>x</b>' });
  const list = (await route('GET', '/api/mail/threads')).json();
  expect(list.threads.map((x) => x.id)).toEqual([a.id, b.id]);
  expect(JSON.stringify(list)).not.toMatch(/SECRET-BODY/);
  expect(list.threads[0]).toEqual({
    id: a.id,
    starter: { boxId: orders.id, session: 'main' }, peer: { boxId: billing.id, session: 'main' },
    state: 'open', reason: null, createdAt: a.createdAt, activeAt: expect.any(Number), count: 2, dropped: 0,
    status: expect.any(String),
  });
  const one = (await route('GET', `/api/mail/threads/${a.id}`)).json().thread;
  expect(one.messages.map((m) => m.body)).toEqual(['SECRET-BODY', '<b>x</b>']);
  expect(one.messages[0]).toMatchObject({ id: expect.stringMatching(/^m-/), kind: 'task', from: 'starter', state: 'queued' });
  expect((await route('GET', '/api/mail/threads/t-aaaaaaaa')).statusCode).toBe(404);
});

test('close is 200 once and 404 the second time; a malformed id is 404 without a lookup', async () => {
  const { orders, billing } = await boot();
  const t = h.store.createThread({ starter: { boxId: orders.id, session: 'main' }, peer: { boxId: billing.id, session: 'main' } });
  const first = await route('POST', `/api/mail/threads/${t.id}/close`);
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual({ ok: true });
  expect(h.store.thread(t.id)).toMatchObject({ state: 'closed', reason: 'operator' });
  expect((await route('POST', `/api/mail/threads/${t.id}/close`)).statusCode).toBe(404);
  for (const bad of ['..%2Fx', '__proto__', 'T-ABCDEFGH', 't-short']) {
    expect((await route('POST', `/api/mail/threads/${bad}/close`)).statusCode, bad).toBe(404);
    expect((await route('GET', `/api/mail/threads/${bad}`)).statusCode, bad).toBe(404);
  }
});

test('refusals are listed newest first', async () => {
  const { orders } = await boot();
  const from = { boxId: orders.id, session: 'main' };
  h.store.addRefusal({ from, target: 'one', reason: 'send-off' });
  h.clock += 5;
  h.store.addRefusal({ from, target: 'two', reason: 'receive-off' });
  const { refusals } = (await route('GET', '/api/mail/refusals')).json();
  expect(refusals.map((r) => r.target)).toEqual(['two', 'one']);
  expect(refusals[0]).toEqual({ at: expect.any(Number), from, target: 'two', reason: 'receive-off' });
});

test('ui-config reports agentMail true when wired and false when not', async () => {
  await boot();
  expect((await route('GET', '/api/ui-config')).json().agentMail).toBe(true);
  await app.close(); await h.cleanup();
  await boot({ withMail: false });
  expect((await route('GET', '/api/ui-config')).json().agentMail).toBe(false);
});

test('GET /api/boxes carries no mail policy', async () => {
  const { orders, billing } = await boot();
  await route('PUT', `/api/boxes/${orders.id}/mail`, { payload: { send: true, sendTo: [billing.id] } });
  const body = (await route('GET', '/api/boxes')).body;
  expect(body).not.toMatch(/sendTo|receiveFrom|"send"|mail/i);
});
