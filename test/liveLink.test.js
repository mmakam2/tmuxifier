import { test, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseLiveMessage, createLiveQueue, openLiveLink } from '../src/web/liveLink.ts';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createLiveHub } from '../src/server/liveHub.js';
import { hashPassword, COOKIE_NAME } from '../src/server/auth.js';

test('parseLiveMessage accepts exactly a nudge and nothing else', () => {
  expect(parseLiveMessage('{"box":"3f2b9c1e-0a4d-4f6e-9b7a-2c1d5e8f0a3b"}')).toBe('3f2b9c1e-0a4d-4f6e-9b7a-2c1d5e8f0a3b');
  expect(parseLiveMessage('{"box":"__local__"}')).toBe('__local__');
  for (const bad of [
    undefined, null, 42, {}, '', 'not json', '[]', 'null', '"x"', '{"box":7}', '{"box":""}', '{"box":"a b"}',
    '{"box":"../x"}', '{"box":"<img>"}', `{"box":"${'x'.repeat(65)}"}`, `{"box":"a","pad":"${'x'.repeat(300)}"}`,
    new Uint8Array([1, 2, 3]),
  ]) expect(parseLiveMessage(bad)).toBeNull();
});

function queueHarness(opts = {}) {
  let t = 0;
  const timers = [];
  const runs = [];
  let gate = null;
  const q = createLiveQueue({
    run: async (ids) => { runs.push(ids); if (gate) await gate; },
    now: () => t,
    setTimeoutFn: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimeoutFn: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    ...opts,
  });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const advance = async (ms) => {
    t += ms;
    for (const h of [...timers]) if (h.at <= t) { timers.splice(timers.indexOf(h), 1); h.fn(); }
    await flush();
  };
  return { q, runs, advance, flush, timers, setGate: (g) => { gate = g; } };
}

test('the first nudge refreshes at once; a burst after it is folded into one refresh a second later', async () => {
  const h = queueHarness();
  h.q.push('a');
  await h.flush();
  expect(h.runs).toEqual([['a']]);
  h.q.push('a'); h.q.push('b'); h.q.push('a');
  await h.advance(999);
  expect(h.runs).toHaveLength(1);
  await h.advance(1);
  expect(h.runs).toEqual([['a'], ['a', 'b']]);
  await h.advance(5000);
  expect(h.runs).toHaveLength(2);          // nothing left over
});

test('a nudge that arrives while a refresh runs is kept for the next one', async () => {
  const h = queueHarness();
  let release;
  h.setGate(new Promise((r) => { release = r; }));
  h.q.push('a');
  await h.flush();
  h.q.push('a');                           // the running refresh may have fetched too early
  h.setGate(null);
  release();
  await h.advance(1000);
  expect(h.runs).toEqual([['a'], ['a']]);
});

test('too many boxes at once becomes one whole-fleet refresh', async () => {
  const h = queueHarness({ maxIds: 2 });
  h.q.push('seed');
  await h.flush();
  for (const id of ['a', 'b', 'c']) h.q.push(id);
  await h.advance(1000);
  expect(h.runs).toEqual([['seed'], null]);
});

test('pushAll asks for everything and swallows the ids queued with it', async () => {
  const h = queueHarness();
  h.q.push('a');
  await h.flush();
  h.q.push('b');
  h.q.pushAll();
  await h.advance(1000);
  expect(h.runs).toEqual([['a'], null]);
});

test('a refresh that throws does not stop the queue', async () => {
  const h = queueHarness({ run: () => { throw new Error('offline'); } });
  h.q.push('a');
  await h.flush();
  const ran = [];
  const h2 = queueHarness({ run: async (ids) => { ran.push(ids); if (ran.length === 1) throw new Error('x'); } });
  h2.q.push('a');
  await h2.flush();
  h2.q.push('b');
  await h2.advance(1000);
  expect(ran).toEqual([['a'], ['b']]);
});

test('stop cancels what is queued', async () => {
  const h = queueHarness();
  h.q.push('a');
  await h.flush();
  h.q.push('b');
  h.q.stop();
  expect(h.timers).toEqual([]);
  await h.advance(5000);
  h.q.push('c');
  await h.advance(5000);
  expect(h.runs).toEqual([['a']]);
});

// --- the link, against the real /live route ------------------------------

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

async function server(hubOpts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-livelink-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'), localShell: 'none',
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const sessions = { open() { return {}; }, openLocal() { return {}; }, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const liveHub = createLiveHub(hubOpts);
  const app = buildServer({ config, store, sessions, liveHub, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  const links = [];
  teardown = async () => { for (const l of links) l.close(); liveHub.closeAll(); await app.close(); await fs.rm(dir, { recursive: true, force: true }); };
  const link = (cookie, opts) => {
    const l = openLiveLink({ makeSocket: () => new WebSocket(`ws://127.0.0.1:${port}/live`, cookie ? { headers: { cookie } } : {}), ...opts });
    links.push(l);
    return l;
  };
  return { liveHub, cookie: `${c.name}=${c.value}`, link, port };
}
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 10)); }
  return true;
};

test('the link delivers box ids from the real route', async () => {
  const { liveHub, cookie, link } = await server();
  const got = [];
  link(cookie, { onBox: (id) => got.push(id) });
  expect(await until(() => liveHub.size() === 1)).toBe(true);
  liveHub.publish('box-1');
  liveHub.publish('__local__');
  expect(await until(() => got.length === 2)).toBe(true);
  expect(got).toEqual(['box-1', '__local__']);
});

test('a stream the server closes for renewal comes back and asks for a catch-up', async () => {
  const { liveHub, cookie, link } = await server();
  const got = [];
  let reconnects = 0;
  link(cookie, { onBox: (id) => got.push(id), onReconnect: () => { reconnects += 1; }, baseMs: 20, stableMs: 5 });
  expect(await until(() => liveHub.size() === 1)).toBe(true);
  expect(reconnects).toBe(0);              // the first open is not a reconnect
  await new Promise((r) => setTimeout(r, 30));
  liveHub.closeAll(4000, 'renew');
  expect(await until(() => liveHub.size() === 1 && reconnects === 1)).toBe(true);
  liveHub.publish('after');
  expect(await until(() => got.includes('after'))).toBe(true);
});

test('a refused session backs off instead of hammering the upgrade', async () => {
  const { link, port } = await server();
  // No cookie: the server ACCEPTS the upgrade, then closes 1008. If opening
  // reset the backoff this would retry every 40 ms forever (~11 in 450 ms);
  // doubling gives attempts at 0, 40, 120 and 280 ms.
  let made = 0;
  link(null, {
    makeSocket: () => { made += 1; return new WebSocket(`ws://127.0.0.1:${port}/live`); },
    onBox: () => {}, baseMs: 40, capMs: 100000, stableMs: 60000,
  });
  await new Promise((r) => setTimeout(r, 450));
  expect(made).toBeGreaterThanOrEqual(3);
  expect(made).toBeLessThanOrEqual(5);
});

test('close() stops the link for good', async () => {
  const { liveHub, cookie, link } = await server();
  const got = [];
  const l = link(cookie, { onBox: (id) => got.push(id), baseMs: 10 });
  expect(await until(() => liveHub.size() === 1)).toBe(true);
  l.close();
  expect(await until(() => liveHub.size() === 0)).toBe(true);
  await new Promise((r) => setTimeout(r, 120));
  expect(liveHub.size()).toBe(0);          // and it does not reconnect
  liveHub.publish('late');
  expect(got).toEqual([]);
});
