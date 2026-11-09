import { test, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createLiveHub } from '../src/server/liveHub.js';
import { createHealthHistory } from '../src/server/healthHistory.js';
import { hashPassword, COOKIE_NAME } from '../src/server/auth.js';

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

async function fixture({ liveHub = createLiveHub(), snapshot = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-live-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'), localShell: 'none',
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: '192.168.1.10', sessionName: 'web' });
  const other = await store.addBox({ host: '192.168.1.11', sessionName: 'web' });
  const sessions = { open() { return {}; }, openLocal() { return {}; }, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const history = createHealthHistory({ now: () => 1 });
  const snap = snapshot || { [saved.id]: { reachable: true, n: 1 }, [other.id]: { reachable: true, n: 2 } };
  const statusPoller = { getSnapshot: () => snap };
  const app = buildServer({ config, store, sessions, history, statusPoller, liveHub, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  teardown = async () => { liveHub?.closeAll(); await app.close(); await fs.rm(dir, { recursive: true, force: true }); };
  return { app, port, boxId: saved.id, otherId: other.id, box: saved, cookie: `${c.name}=${c.value}`, liveHub, history };
}

function closeOf(ws) {
  return new Promise((resolve, reject) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on('error', reject);
  });
}
const opened = (ws) => new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
const nextMessage = (ws) => new Promise((resolve) => ws.once('message', (d) => resolve(d.toString())));
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 10)); }
  return true;
};

test('an unauthenticated upgrade is refused 1008 and never joins the hub', async () => {
  const { port, liveHub } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
  expect(await closeOf(ws)).toEqual({ code: 1008, reason: 'unauthorized' });
  expect(liveHub.size()).toBe(0);
});

test('a cross-origin upgrade is refused before the cookie is consulted', async () => {
  const { port, cookie, liveHub } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { cookie, origin: 'http://evil.example.com' } });
  expect(await closeOf(ws)).toEqual({ code: 1008, reason: 'forbidden origin' });
  expect(liveHub.size()).toBe(0);
});

test('an authenticated tab receives a nudge naming the box, and nothing else', async () => {
  const { port, cookie, liveHub } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { cookie } });
  await opened(ws);
  expect(await until(() => liveHub.size() === 1)).toBe(true);
  const got = nextMessage(ws);
  liveHub.publish('box-7');
  expect(await got).toBe('{"box":"box-7"}');
  ws.close();
  expect(await until(() => liveHub.size() === 0)).toBe(true);
});

test('whatever a tab sends is ignored', async () => {
  const { port, cookie, liveHub } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { cookie } });
  await opened(ws);
  ws.send('{"box":"forged"}');
  ws.send(Buffer.alloc(2048, 1));
  const got = nextMessage(ws);
  liveHub.publish('real');
  expect(await got).toBe('{"box":"real"}'); // still connected, nothing echoed
});

test('with no hub wired the upgrade closes 1011', async () => {
  const { port, cookie } = await fixture({ liveHub: null });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { cookie } });
  expect(await closeOf(ws)).toEqual({ code: 1011, reason: 'live unavailable' });
});

test('a tab past the hub cap is told to try later', async () => {
  const { port, cookie } = await fixture({ liveHub: createLiveHub({ maxClients: 1 }) });
  const first = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { cookie } });
  await opened(first);
  const second = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { cookie } });
  expect(await closeOf(second)).toEqual({ code: 1013, reason: 'too many live clients' });
  first.close();
});

test('logout closes every live stream, and the revoked cookie cannot reconnect', async () => {
  const { app, port, cookie, liveHub } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { cookie } });
  await opened(ws);
  const closed = closeOf(ws);
  // Session values carry whole-second issue times; step past the login second
  // so the watermark is strictly after it.
  await new Promise((r) => setTimeout(r, 1100));
  const res = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  expect(await closed).toEqual({ code: 1008, reason: 'logged out' });
  expect(liveHub.size()).toBe(0);
  const again = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { cookie } });
  expect(await closeOf(again)).toEqual({ code: 1008, reason: 'unauthorized' });
});

test('an unauthenticated logout does not close anybody else\'s stream', async () => {
  const { app, port, cookie, liveHub } = await fixture();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { cookie } });
  await opened(ws);
  await app.inject({ method: 'POST', url: '/api/logout' });
  expect(liveHub.size()).toBe(1);
  ws.close();
});

test('acknowledging a finished turn nudges every tab about that box', async () => {
  const { app, port, cookie, boxId, box, history } = await fixture();
  history.record({ [boxId]: { reachable: true, tmux: true, sessions: [{ name: 'web', windows: 1, attached: false, paneCmd: 'claude' }], agentMarks: { web: { state: 'ready', cause: 'stop', ts: 100 } } } }, [box]);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers: { cookie } });
  await opened(ws);
  const got = nextMessage(ws);
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/agent-seen`, headers: { cookie }, payload: { session: 'web', ts: 100 } });
  expect(res.statusCode).toBe(200);
  expect(await got).toBe(JSON.stringify({ box: boxId }));
  // And the series the tab then fetches already says idle.
  const series = await app.inject({ method: 'GET', url: `/api/health/series?box=${boxId}`, headers: { cookie } });
  expect(series.json()[boxId].at(-1).agents.web.state).toBe('idle');
  ws.close();
});

test('GET /api/status?box= returns just that box, and nothing for an unknown id', async () => {
  const { app, cookie, boxId, otherId } = await fixture();
  const all = await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } });
  expect(Object.keys(all.json()).sort()).toEqual([boxId, otherId].sort());
  const one = await app.inject({ method: 'GET', url: `/api/status?box=${boxId}`, headers: { cookie } });
  expect(one.json()).toEqual({ [boxId]: { reachable: true, n: 1 } });
  const none = await app.inject({ method: 'GET', url: '/api/status?box=__proto__', headers: { cookie } });
  expect(none.json()).toEqual({});
  const missing = await app.inject({ method: 'GET', url: '/api/status?box=nope', headers: { cookie } });
  expect(missing.json()).toEqual({});
});
