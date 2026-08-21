import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, calls, boxId, failNext, setupRunning, probed, probeThrows, serverArgs;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-kill-'));
  calls = [];
  failNext = false;
  probed = [];
  probeThrows = false;
  const run = async (argv) => {
    calls.push(argv);
    if (failNext) { failNext = false; return { code: 1, stdout: '', stderr: "can't find session: web" }; }
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
  const statusPoller = {
    getSnapshot: () => ({}),
    probeOne: async (id) => {
      probed.push(id);
      if (probeThrows) throw new Error('probe blew up');
      return { reachable: true };
    },
  };
  serverArgs = { config, store, sessions, statusChecker, statusPoller, boxActions, setupManager };
  app = buildServer(serverArgs);
});

const killUrl = () => '/api/boxes/' + boxId + '/kill';
const remoteOf = (needle) => calls.map((argv) => argv[argv.length - 1]).find((r) => r.includes(needle));

async function headers(target = app) {
  const res = await target.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

// An apostrophe is the shell-quoting hazard worth pinning; spelled by code point
// so the lists below stay on one readable line.
const QUOTE = String.fromCharCode(39);

test('POST kill without a windowId kills the whole session, exact-matched', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(remoteOf('kill-session')).toContain("kill-session -t '=web'");
});

test('POST kill with a windowId kills only that window, session-qualified', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web', windowId: '@7' } });
  expect(res.statusCode).toBe(200);
  expect(remoteOf('kill-window')).toContain("kill-window -t '=web:@7'");
  // The session form must not also have run.
  expect(remoteOf('kill-session')).toBeUndefined();
});

// The route's own gate is `windowId !== undefined && windowId !== null`, so an
// explicit `null` must take the same session-kill branch as an altogether
// absent key — not merely the OMITTED-key case the first test above already
// exercises. This is the exact branch api.ts's own `windowId !== undefined`
// fix rides on: a client that sends `{ session, windowId: null }` (rather than
// omitting the key) must still kill the whole session, not 400 or no-op.
test('POST kill with windowId: null kills the whole session, same as omitting it', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web', windowId: null } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(remoteOf('kill-session')).toContain("kill-session -t '=web'");
  expect(remoteOf('kill-window')).toBeUndefined();
});

test('POST kill requires a session name even when killing a window', async () => {
  const h = await headers();
  // No fallback to a bare-id target: it is ambiguous under grouped sessions,
  // and this route destroys things.
  for (const session of [undefined, '', 'my session', 'web' + QUOTE, 'web:1', 'web.1', 'a'.repeat(65), 42, null]) {
    const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session, windowId: '@1' } });
    expect(res.statusCode).toBe(400);
  }
  expect(calls.length).toBe(0);
});

test('POST kill rejects anything that is not a tmux window id, without touching ssh', async () => {
  const h = await headers();
  for (const windowId of ['', '7', 'web:1', '@1;rm -rf /', '@1' + QUOTE, '@' + '9'.repeat(10), 42]) {
    const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web', windowId } });
    expect(res.statusCode).toBe(400);
  }
  expect(calls.length).toBe(0);
});

test('POST kill is refused while the box setup job is running', async () => {
  const h = await headers();
  setupRunning = true;
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(409);
  expect(calls.length).toBe(0);
});

test('POST kill 404s on an unknown box', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nope/kill', headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(404);
});

test('POST kill maps a vanished session to 502 carrying the reason', async () => {
  const h = await headers();
  failNext = true;
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toContain("can't find session");
});

test('POST kill requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: killUrl(), payload: { session: 'web' } });
  expect(res.statusCode).toBe(401);
});

test('POST kill re-probes the box so the next /api/status is authoritative', async () => {
  const h = await headers();
  // /api/status serves the poller's 30s cache and the tab re-reads it on its own
  // 30s interval, so without this a killed session lingers in the list for up to
  // a minute — exactly when the operator is looking at it.
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(200);
  expect(probed).toEqual([boxId]);
});

test('POST kill still succeeds when the re-probe throws', async () => {
  const h = await headers();
  probeThrows = true;
  // It is already dead on the box. A failing refresh of our own cache must not
  // be reported as a kill that did not happen.
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});

test('POST kill works on a deployment with no status poller wired', async () => {
  const noPoller = buildServer({ ...serverArgs, statusPoller: undefined });
  const h = await headers(noPoller);
  const res = await noPoller.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(200);
  expect(probed).toEqual([]);
});
