import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, calls, boxId, failNext, setupRunning;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-win-'));
  calls = [];
  failNext = false;
  const run = async (argv) => {
    calls.push(argv);
    if (failNext) { failNext = false; return { code: 1, stdout: '', stderr: 'no such window' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  const boxActions = createBoxActions({ run, runStdin: run, hostKeyPolicy: 'accept-new', controlDir: dir });
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ label: 'b1', host: '192.168.1.10', user: 'u', sessionName: 'main' });
  boxId = box.id;
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  setupRunning = false;
  const setupManager = { currentForBox: () => (setupRunning ? { status: 'running' } : null) };
  app = buildServer({ config, store, sessions, statusChecker, boxActions, setupManager });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('POST window selects the window by its tmux id', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { windowId: '@7' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, windowId: '@7' });
  const remote = calls.map((argv) => argv[argv.length - 1]).find((r) => r.includes('select-window'));
  expect(remote).toContain("select-window -t '@7'");
});

test('POST window rejects anything that is not a tmux window id, without touching ssh', async () => {
  const h = await headers();
  // The id becomes a tmux target, so it is re-validated here rather than
  // trusted from the client that read it out of a status snapshot.
  for (const windowId of ['', '7', 'web:1', '@1;rm -rf /', "@1'", '@' + '9'.repeat(10), 42, null, undefined]) {
    const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { windowId } });
    expect(res.statusCode).toBe(400);
  }
  expect(calls.length).toBe(0);
});

test('POST window is refused while the box\'s setup job is running', async () => {
  const h = await headers();
  setupRunning = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { windowId: '@1' } });
  expect(res.statusCode).toBe(409);
  expect(calls.length).toBe(0);
});

test('POST window 404s on an unknown box', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nope/window', headers: h, payload: { windowId: '@1' } });
  expect(res.statusCode).toBe(404);
});

test('POST window maps a vanished window to 502', async () => {
  const h = await headers();
  failNext = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { windowId: '@1' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toContain('no such window');
});

test('POST window requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, payload: { windowId: '@1' } });
  expect(res.statusCode).toBe(401);
});
