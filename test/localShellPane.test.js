import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { createLocalShellActions } from '../src/server/localShellActions.js';
import { hashPassword } from '../src/server/auth.js';
import { createDeviceStore } from '../src/server/deviceStore.js';
import { createPasskeyStore } from '../src/server/passkeyStore.js';

let app, dir, scripts, runResult, gate;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-lsp-route-'));
  scripts = [];
  gate = null;
  runResult = { code: 0, stdout: '80 24 0 0 0 0 0\nhost\nshell\n', stderr: '' };
  // The REAL createLocalShellActions over a fake `run` seam that records scripts.
  const run = async (script) => {
    scripts.push(script);
    if (gate) await gate;
    return runResult;
  };
  const localShellActions = createLocalShellActions({ run, cwd: dir, env: {} });
  const boxActions = createBoxActions({ run: async () => ({ code: 0, stdout: '', stderr: '' }), hostKeyPolicy: 'accept-new', controlDir: dir });
  const store = createStore({ dataDir: dir });
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  const history = {
    getSeries: (id) => (id === '__local__'
      ? [{ t: 1, up: true, agents: { local: { state: 'done', cause: 'stop' }, other: { state: 'blocked' } } }]
      : []),
    getEvents: () => ({ events: [], latestSeq: 0 }), record() {}, onEvent() {},
  };
  app = buildServer({
    config, store, sessions, statusChecker, boxActions, history, localShellActions,
    deviceStore: createDeviceStore({ dataDir: dir }), passkeyStore: createPasskeyStore({ dataDir: dir }),
  });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

async function bearer() {
  const res = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload: { password: 'pw', name: 'MCP' } });
  return { authorization: `Bearer ${res.json().token}` };
}

test('a browser session gets the Host Shell snapshot with the local session agent state', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane?lines=40', headers: await headers() });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, width: 80, height: 24, cursorX: 0, cursorY: 0, alt: false, mouse: false,
    content: 'host\nshell', agent: 'done', agentCause: 'stop', sessionName: 'local' });
  expect(scripts.at(-1)).toContain("capture-pane -e -p -t '=local:' -S -40");
});

test('a session query parameter is ignored: only the local session is ever captured', async () => {
  await app.inject({ method: 'GET', url: '/api/local-shell/pane?session=other', headers: await headers() });
  expect(scripts.at(-1)).toContain("-t '=local:'");
  expect(scripts.at(-1)).not.toContain('other');
});

test('a device token is refused and nothing runs', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane', headers: await bearer() });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'browser session required' });
  expect(scripts.length).toBe(0);
});

test('no credentials is 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane' });
  expect(res.statusCode).toBe(401);
  expect(scripts.length).toBe(0);
});

test('a failed capture is 502 and creates nothing', async () => {
  runResult = { code: 1, stdout: '', stderr: "can't find session: local" };
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane', headers: await headers() });
  expect(res.statusCode).toBe(502);
  expect(res.json()).toEqual({ error: "can't find session: local" });
  expect(scripts.every((s) => !/new-session|has-session/.test(s))).toBe(true);
});

test('concurrent captures share one run', async () => {
  let release;
  gate = new Promise((r) => { release = r; });
  const h = await headers();
  const a = app.inject({ method: 'GET', url: '/api/local-shell/pane?lines=40', headers: h });
  const b = app.inject({ method: 'GET', url: '/api/local-shell/pane?lines=40', headers: h });
  await expect.poll(() => scripts.length).toBe(1);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  expect(ra.statusCode).toBe(200);
  expect(rb.statusCode).toBe(200);
  expect(scripts.length).toBe(1);
});

test('503 when the capture action is not wired', async () => {
  const bare = buildServer({
    config: { bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
      passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir, localShell: 'none', configPath: path.join(dir, 'config.json') },
    store: createStore({ dataDir: dir }),
    sessions: { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} },
    statusChecker: { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) },
    boxActions: {}, history: { getSeries: () => [], getEvents: () => ({ events: [], latestSeq: 0 }), record() {}, onEvent() {} },
  });
  const login = await bare.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === 'tmuxifier_session');
  const res = await bare.inject({ method: 'GET', url: '/api/local-shell/pane', headers: { cookie: `${c.name}=${c.value}` } });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toEqual({ error: 'capture unavailable' });
});
