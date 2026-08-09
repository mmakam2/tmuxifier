import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, calls, boxId, failNext;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pane-'));
  calls = [];
  // Tests flip this to exercise the routes' 502 mapping — consumed by the very
  // next call so a test can fail exactly one ssh round trip.
  failNext = false;
  // Real createBoxActions over a fake ssh transport (the run seam) — the argv
  // building, quoting, and parsing under test are the real code.
  const run = async (argv) => {
    calls.push(argv);
    if (failNext) { failNext = false; return { code: 1, stdout: '', stderr: 'boom' }; }
    const remote = argv[argv.length - 1];
    if (remote.includes('capture-pane')) return { code: 0, stdout: '80 24 3 10\nhello\nworld\n', stderr: '' };
    if (remote.includes('send-keys')) return { code: 0, stdout: '', stderr: '' };
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
  const history = { getSeries: () => [{ t: 1, up: true, agent: 'waiting' }], getEvents: () => ({ events: [], latestSeq: 0 }), record() {}, onEvent() {} };
  app = buildServer({ config, store, sessions, statusChecker, boxActions, history });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('GET pane returns parsed snapshot plus agent state', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane`, headers: h });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    ok: true, width: 80, height: 24, cursorX: 3, cursorY: 10,
    content: 'hello\nworld', agent: 'waiting', sessionName: 'main',
  });
});

test('POST keys: named key goes unquoted from the allowlist, text goes literal and sanitized', async () => {
  const h = await headers();
  expect((await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { key: 'Enter' } })).statusCode).toBe(200);
  // sess() produces a sanitized, colon-suffixed target ('=main:', not '=main').
  expect(calls.some((argv) => argv[argv.length - 1] === "tmux send-keys -t '=main:' Enter")).toBe(true);
  expect((await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: 'hi\nthere' } })).statusCode).toBe(200);
  expect(calls.some((argv) => argv[argv.length - 1] === "tmux send-keys -t '=main:' -l -- 'hi there'")).toBe(true);
});

test('POST keys validates: exactly one of text/key, allowlisted key, bounded text', async () => {
  const h = await headers();
  const both = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: 'x', key: 'Enter' } });
  expect(both.statusCode).toBe(400);
  const neither = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: {} });
  expect(neither.statusCode).toBe(400);
  const badKey = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { key: 'C-d' } });
  expect(badKey.statusCode).toBe(400);
  const huge = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: 'x'.repeat(65537) } });
  expect(huge.statusCode).toBe(400);
});

test('both routes 404 an unknown box and 401 without auth', async () => {
  const h = await headers();
  expect((await app.inject({ method: 'GET', url: '/api/boxes/nope/pane', headers: h })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane` })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, payload: { key: 'Enter' } })).statusCode).toBe(401);
});

test('POST keys 404s an unknown box too, not just GET pane', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nope/keys', headers: h, payload: { key: 'Enter' } });
  expect(res.statusCode).toBe(404);
});

test('GET pane maps a transport failure to 502 with an error body', async () => {
  const h = await headers();
  failNext = true;
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane`, headers: h });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toBe('boom');
});

test('POST keys maps a transport failure to 502 with an error body', async () => {
  const h = await headers();
  failNext = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: 'x' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toBe('boom');
});

test('POST keys with whitespace-only text is a no-op: 200 skipped, no send-keys reaches the box', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/keys`, headers: h, payload: { text: '   \r\n  ' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, skipped: 'empty' });
  // The guard that prevents a bare `send-keys -l --` from reaching the box:
  // sanitizeSendText ate the whole payload, so no ssh round trip should have
  // been made at all.
  expect(calls.some((argv) => argv[argv.length - 1].includes('send-keys'))).toBe(false);
  expect(calls.length).toBe(0);
});
