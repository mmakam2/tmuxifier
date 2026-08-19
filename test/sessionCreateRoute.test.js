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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-sess-'));
  calls = [];
  failNext = false;
  // Real createBoxActions over a fake ssh transport (the run seam) — the argv
  // building and quoting under test are the real code.
  const run = async (argv) => {
    calls.push(argv);
    if (failNext) { failNext = false; return { code: 1, stdout: '', stderr: 'boom' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  const boxActions = createBoxActions({ run, runStdin: run, hostKeyPolicy: 'accept-new', controlDir: dir });
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ label: 'b1', host: '192.168.1.10', user: 'u', sessionName: 'main', startupCommand: 'htop' });
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

test('POST sessions creates a detached session with the box startupCommand', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/sessions`, headers: h, payload: { name: 'proj2' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, name: 'proj2' });
  const remote = calls.map((argv) => argv[argv.length - 1]).find((r) => r.includes('new-session'));
  // Identical to what an attach would have created: the ensure-session remote,
  // idempotent (exact-match has-session guard) and carrying the box's startup
  // command.
  expect(remote).toContain("has-session -t '=proj2'");
  expect(remote).toContain("new-session -d -s 'proj2' 'htop'");
});

test('POST sessions is refused while the box\'s setup job is running', async () => {
  // Same gate as /term and the pane sizing viewer: a session created mid-setup
  // holds an environment predating the seeded credentials — and if it matched
  // the configured name it would turn setup's own ensureSession into a no-op.
  const h = await headers();
  setupRunning = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/sessions`, headers: h, payload: { name: 'proj2' } });
  expect(res.statusCode).toBe(409);
  expect(calls.length).toBe(0);
});

test('POST sessions rejects invalid names without touching ssh', async () => {
  const h = await headers();
  for (const name of ['', 'a:b', 'a.b', 'a b', 'a'.repeat(65), 42, null, undefined]) {
    const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/sessions`, headers: h, payload: { name } });
    expect(res.statusCode).toBe(400);
  }
  expect(calls.length).toBe(0);
});

test('POST sessions 404s on an unknown box', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nope/sessions', headers: h, payload: { name: 'x' } });
  expect(res.statusCode).toBe(404);
});

test('POST sessions maps an ssh failure to 502', async () => {
  const h = await headers();
  failNext = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/sessions`, headers: h, payload: { name: 'x' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toContain('boom');
});

test('POST sessions requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/sessions`, payload: { name: 'x' } });
  expect(res.statusCode).toBe(401);
});
