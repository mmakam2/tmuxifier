// test/paneKindRoute.test.js — modeled on test/paneRoutes.test.js: real
// createBoxActions over a fake `run` seam, real routes, fake setupManager.
import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, boxId, calls, captureOut, failNext, setupRunning, localCalls;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pk-'));
  const config = { bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir, sshConfigPath: path.join(dir, 'nope'), localShell: 'none' };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: '192.168.1.10', sessionName: 'web' });
  boxId = saved.id;
  calls = []; captureOut = 'claude\n╭─╮\n'; failNext = false; setupRunning = false; localCalls = [];
  const run = async (argv) => {
    calls.push(argv);
    if (failNext) { failNext = false; return { code: 1, stdout: '', stderr: 'boom' }; }
    return { code: 0, stdout: captureOut, stderr: '' };
  };
  const boxActions = createBoxActions({ run, runStdin: run, hostKeyPolicy: 'accept-new', controlDir: dir });
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const setupManager = { currentForBox: () => (setupRunning ? { status: 'running' } : null) };
  const paneKindLocal = async (session) => { localCalls.push(session); return { ok: true, kind: 'shell' }; };
  app = buildServer({ config, store, sessions, boxActions, setupManager, paneKindLocal, localSession: 'local', statusChecker: { checkBox: async () => ({ reachable: true }) } });
});
afterAll(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}
const post = async (id, payload) => app.inject({ method: 'POST', url: `/api/boxes/${id}/pane-kind`, headers: await headers(), payload });

test('classifies the requested session on the box', async () => {
  calls.length = 0;
  const res = await post(boxId, { session: 'proj2' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ kind: 'claude' });
  expect(calls[0][calls[0].length - 1]).toContain("'=proj2:'");
});

test('defaults to the box session when none is given', async () => {
  calls.length = 0;
  captureOut = 'zsh\n$ ';
  const res = await post(boxId, {});
  expect(res.json()).toEqual({ kind: 'shell' });
  expect(calls[0][calls[0].length - 1]).toContain("'=web:'");
});

test('rejects a session name outside SESSION_NAME_RE', async () => {
  expect((await post(boxId, { session: 'bad name' })).statusCode).toBe(400);
});

test('unknown box is 404; a running setup job is 409 and probes nothing', async () => {
  expect((await post('nope', {})).statusCode).toBe(404);
  calls.length = 0; setupRunning = true;
  expect((await post(boxId, {})).statusCode).toBe(409);
  expect(calls).toHaveLength(0);
  setupRunning = false;
});

test('a failed probe is 502', async () => {
  failNext = true;
  const res = await post(boxId, {});
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toMatch(/boom/);
});

test('__local__ classifies the host session through the injected local runner', async () => {
  const res = await post('__local__', {});
  expect(res.json()).toEqual({ kind: 'shell' });
  expect(localCalls).toEqual(['local']);
});

test('unauthenticated is 401', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/pane-kind`, payload: {} });
  expect(res.statusCode).toBe(401);
});
