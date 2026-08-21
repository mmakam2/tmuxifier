import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { hashPassword } from '../src/server/auth.js';

// POST /api/boxes/:id/probe — the on-demand refresh behind the pane header's
// session/window dropdown. /api/status serves statusPoller's cached snapshot
// (30s by default) and the tab re-reads it on its own 30s interval, so a window
// created on the box with `prefix-c` took up to a full minute to appear in a
// dropdown the user was already looking at. This route re-probes ONE box and
// hands back that box's fresh entry.

let app, dir, boxId, probed, probeResult, probeThrows, withPoller;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-probe-'));
  probed = [];
  probeThrows = false;
  withPoller = true;
  probeResult = {
    reachable: true,
    tmux: true,
    sessions: [{ name: 'main', windows: 2, windowList: [{ id: '@1', index: 1, name: 'bash', active: false }, { id: '@4', index: 2, name: 'test window', active: true }] }],
  };
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
  // Shaped like the real poller's probeOne (statusPoller.js).
  const statusPoller = {
    getSnapshot: () => ({}),
    probeOne: async (id) => {
      probed.push(id);
      if (probeThrows) throw new Error('probe blew up');
      return probeResult;
    },
  };
  app = buildServer({ config, store, sessions, statusChecker, ...(withPoller ? { statusPoller } : {}), setupManager: { currentForBox: () => null } });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('POST probe re-probes that box and answers in /api/status shape', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/probe`, headers: h });
  expect(res.statusCode).toBe(200);
  expect(probed).toEqual([boxId]);
  // Keyed by box id like GET /api/status, so the client merges the answer into
  // its snapshot with one spread rather than learning a second shape.
  expect(res.json()).toEqual({ [boxId]: probeResult });
});

test('POST probe requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/probe` });
  expect(res.statusCode).toBe(401);
  expect(probed).toEqual([]);
});

test('POST probe 404s an unknown box without probing', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nope/probe', headers: h });
  expect(res.statusCode).toBe(404);
  expect(probed).toEqual([]);
});

// A probe that throws is a stale dropdown, never a broken one: the client keeps
// the snapshot it already has, so the failure must be reported plainly rather
// than answered with a half-empty snapshot the client would paint.
test('POST probe reports a failed probe as 502 rather than an empty snapshot', async () => {
  const h = await headers();
  probeThrows = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/probe`, headers: h });
  expect(res.statusCode).toBe(502);
});

// probeOne re-reads the store, so a box removed between the 404 check and the
// probe comes back null. Same posture as a throw.
test('POST probe reports a null probe as 502', async () => {
  const h = await headers();
  probeResult = null;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/probe`, headers: h });
  expect(res.statusCode).toBe(502);
});

test('POST probe 503s where no status poller is wired', async () => {
  const store = createStore({ dataDir: dir });
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  const bare = buildServer({ config, store, sessions, statusChecker, setupManager: { currentForBox: () => null } });
  const res0 = await bare.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res0.cookies.find((x) => x.name === 'tmuxifier_session');
  const res = await bare.inject({ method: 'POST', url: `/api/boxes/${boxId}/probe`, headers: { cookie: `${c.name}=${c.value}` } });
  expect(res.statusCode).toBe(503);
});

// Read-only, so unlike /term, the session-create route and the window-select
// route it is NOT gated while a setup job runs: the poller probes that box on
// every sweep anyway, and a header that goes blind mid-setup is the state this
// change exists to remove.
test('POST probe is not gated by a running setup job', async () => {
  const store = createStore({ dataDir: dir });
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  const statusPoller = { getSnapshot: () => ({}), probeOne: async (id) => { probed.push(id); return probeResult; } };
  const busy = buildServer({
    config, store, sessions, statusChecker, statusPoller,
    setupManager: { currentForBox: () => ({ status: 'running' }) },
  });
  const res0 = await busy.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res0.cookies.find((x) => x.name === 'tmuxifier_session');
  const res = await busy.inject({ method: 'POST', url: `/api/boxes/${boxId}/probe`, headers: { cookie: `${c.name}=${c.value}` } });
  expect(res.statusCode).toBe(200);
  expect(probed).toEqual([boxId]);
});
