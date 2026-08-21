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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-win-'));
  calls = [];
  failNext = false;
  probed = [];
  probeThrows = false;
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
  // Shaped like the real poller's probeOne (statusPoller.js): probes one box and
  // swaps that box's entry into the cached snapshot /api/status serves.
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

const winUrl = () => '/api/boxes/' + boxId + '/window';

async function headers(target = app) {
  const res = await target.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('POST window selects the window by a SESSION-QUALIFIED, exact-match target', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { session: 'web', windowId: '@7' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, windowId: '@7' });
  const remote = calls.map((argv) => argv[argv.length - 1]).find((r) => r.includes('select-window'));
  // Both halves are load-bearing. The session, because a grouped session shares
  // its window objects and a bare `-t '@7'` then steers whichever of them tmux
  // resolves first (verified on tmux 3.5a: it moved the clone and exited 0).
  // The '=', because a bare session target prefix-matches when no exact match
  // exists, so a vanished 'web' would silently steer 'web2'.
  expect(remote).toContain("select-window -t '=web:@7'");
});

test('POST window rejects anything that is not a tmux window id, without touching ssh', async () => {
  const h = await headers();
  // The id becomes a tmux target, so it is re-validated here rather than
  // trusted from the client that read it out of a status snapshot.
  for (const windowId of ['', '7', 'web:1', '@1;rm -rf /', "@1'", '@' + '9'.repeat(10), 42, null, undefined]) {
    const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { session: 'web', windowId } });
    expect(res.statusCode).toBe(400);
  }
  expect(calls.length).toBe(0);
});

test('POST window is refused while the box\'s setup job is running', async () => {
  const h = await headers();
  setupRunning = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { session: 'web', windowId: '@1' } });
  expect(res.statusCode).toBe(409);
  expect(calls.length).toBe(0);
});

test('POST window 404s on an unknown box', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nope/window', headers: h, payload: { session: 'web', windowId: '@1' } });
  expect(res.statusCode).toBe(404);
});

test('POST window maps a vanished window to 502', async () => {
  const h = await headers();
  failNext = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { session: 'web', windowId: '@1' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toContain('no such window');
});

test('POST window requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, payload: { session: 'web', windowId: '@1' } });
  expect(res.statusCode).toBe(401);
});
// An apostrophe is the shell-quoting hazard worth pinning; spelled by code point
// so the list below stays on one readable line.
const QUOTE = String.fromCharCode(39);

test('POST window requires a session name, and validates it, without touching ssh', async () => {
  const h = await headers();
  // An absent session is a 400 and deliberately NOT a fallback to the bare-id
  // target: that target is ambiguous under grouped sessions, and acting on a
  // target we cannot pin is what this codebase refuses to do elsewhere.
  for (const session of [undefined, '', 'my session', 'web' + QUOTE, 'web:1', 'web.1', 'a'.repeat(65), 42, null]) {
    const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session, windowId: '@1' } });
    expect(res.statusCode).toBe(400);
  }
  expect(calls.length).toBe(0);
});

test('POST window re-probes the box so the next /api/status is authoritative', async () => {
  const h = await headers();
  // /api/status serves the poller's cache, which only moves on the poll interval
  // (30s by default). Without this re-probe the client repaints from a snapshot
  // whose `active` flag still names the PREVIOUS window, so the dropdown snaps
  // back within a second and stays wrong until the next sweep.
  const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'web', windowId: '@2' } });
  expect(res.statusCode).toBe(200);
  expect(probed).toEqual([boxId]);
});

test('POST window still succeeds when the re-probe throws', async () => {
  const h = await headers();
  probeThrows = true;
  // The switch already happened on the box; a failing refresh of our own cache
  // must never turn that into an error the UI would revert.
  const res = await app.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'web', windowId: '@2' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, windowId: '@2' });
});

test('POST window works on a deployment with no status poller wired', async () => {
  // statusPoller is optional on buildServer (several suites construct a server
  // without one), so the re-probe is best-effort in that direction too.
  const noPoller = buildServer({ ...serverArgs, statusPoller: undefined });
  const h = await headers(noPoller);
  const res = await noPoller.inject({ method: 'POST', url: winUrl(), headers: h, payload: { session: 'web', windowId: '@3' } });
  expect(res.statusCode).toBe(200);
  expect(probed).toEqual([]);
});
