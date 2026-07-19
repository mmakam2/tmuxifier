import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { hashPassword } from '../src/server/auth.js';

function fleetStub(calls = []) {
  return {
    createJob: async ({ boxIds, command }) => {
      calls.push(['createJob', boxIds, command]);
      if (boxIds.includes('bad')) throw new Error('unknown box: bad');
      return { id: 'job1', command, status: 'running', createdAt: 't', startedAt: 't', finishedAt: null, concurrency: 4, timeoutMs: 15000, targets: boxIds.map((id) => ({ boxId: id, label: id, host: id, status: 'pending', code: null, stdout: '', stderr: '', truncated: false, error: null, startedAt: null, finishedAt: null })) };
    },
    listJobs: () => { calls.push(['listJobs']); return [{ id: 'job1', command: 'uptime', status: 'done', createdAt: 't', startedAt: 't', finishedAt: 't', targetCount: 1, okCount: 1, errorCount: 0 }]; },
    getJob: (id) => { calls.push(['getJob', id]); return id === 'job1' ? { id: 'job1', command: 'uptime', status: 'done', targets: [] } : undefined; },
    cancelJob: (id) => { calls.push(['cancelJob', id]); return id === 'job1' ? { id: 'job1', status: 'cancelled', targets: [] } : undefined; },
  };
}

function historyStub() {
  return {
    // Same shapes as createHealthHistory: one box -> Sample[], no arg -> full map.
    getSeries: (boxId) => (boxId ? [{ t: 1, up: true, cpuPct: 10 }]
      : { b1: [{ t: 1, up: true, cpuPct: 10 }], b2: [{ t: 1, up: false }] }),
    getEvents: ({ since = 0 } = {}) => ({ events: [{ seq: 2, boxId: 'b1', label: 'web-01', host: 'h1', t: 9, kind: 'down' }].filter((e) => e.seq > since), latestSeq: 2 }),
  };
}

function proxmoxStubs(calls = []) {
  const host = { id: 'H1', name: 'lab', endpoint: 'pve.example.com:8006', tokenId: 'user@pam!t', hasToken: true, verifyMode: 'pin', fingerprint256: 'AB' };
  let rootPw = null;
  const proxmoxStore = {
    listHosts: async () => [host],
    getHost: async (id, opts) => (id === 'H1' ? (opts?.withSecret ? { ...host, tokenSecret: 'sek' } : host) : undefined),
    addHost: async (spec) => { calls.push(['addHost', spec.name]); return { ...host, name: spec.name }; },
    removeHost: async () => {},
    listKeys: async () => [{ id: 'K1', name: 'mgmt', publicKey: 'ssh-ed25519 AAA you@example.com' }],
    addKey: async (spec) => { if (!String(spec.publicKey).startsWith('ssh-')) throw new Error('not a valid public key'); return { id: 'K2', ...spec }; },
    removeKey: async () => {},
    listPresets: async () => [{ id: 'P1', name: 'dev' }],
    getPreset: async (id) => (id === 'P1' ? { id: 'P1', name: 'dev' } : undefined),
    addPreset: async (spec) => ({ id: 'P2', ...spec }),
    updatePreset: async (id, spec) => {
      calls.push(['updatePreset', id, spec.name]);
      if (id === 'NOPE') return undefined;
      if (!spec.name) throw new Error('preset name is required');
      return { id, ...spec, createdAt: 't' };
    },
    removePreset: async () => {},
    hasRootPassword: async () => !!rootPw,
    setRootPassword: async (pw) => { if (!pw || pw.length < 5) throw new Error('root password must be at least 5 characters'); rootPw = pw; },
    clearRootPassword: async () => { rootPw = null; },
  };
  const provisionManager = {
    createProvision: async (body) => { calls.push(['createProvision', body.hostname]); if (!body.hostname) throw new Error('hostname required'); return { id: 'J1', status: 'running', hostname: body.hostname }; },
    listProvisions: () => [{ id: 'J1', status: 'done' }],
    getProvision: (id) => (id === 'J1' ? { id: 'J1', status: 'done', log: '' } : undefined),
  };
  const makeProxmoxClient = () => ({
    version: async () => ({ version: '8.2' }),
    nodes: async () => [{ node: 'pve' }],
    storages: async () => [{ storage: 'local', content: 'vztmpl,iso' }, { storage: 'local-lvm', content: 'rootdir,images' }],
    templates: async () => [{ volid: 'local:vztmpl/debian-12.tar.zst' }],
    bridges: async () => [{ iface: 'vmbr0' }],
    nextId: async () => '131',
  });
  const inspectEndpoint = async () => ({ reachable: true, fingerprint256: 'AB:CD', subject: 'pve', issuer: 'pve', validTo: 'x', caValid: false });
  const defaultPublicKey = () => 'ssh-ed25519 HOSTKEY tmuxifier@host';
  const proxmoxInventory = {
    getLinkedContainers: async () => [{ boxId: 'B1', boxLabel: 'dev-01', hostId: 'H1', hostName: 'lab', node: 'pve', vmid: 131, state: 'stopped' }],
    listNodeContainers: async () => [{ hostId: 'H1', node: 'pve', vmid: 131, name: 'dev-01', state: 'stopped', linkedBoxId: null }],
  };
  const lifecycleManager = {
    createJob: async (body) => { calls.push(['createLifecycleJob', body]); return { id: 'L1', ...body, status: 'running' }; },
    listJobs: () => [{ id: 'L1', boxId: 'B1', action: 'start', status: 'running', phase: 'request' }],
    getJob: (id) => id === 'L1' ? { id: 'L1', action: 'start', status: 'done', log: '' } : undefined,
    hasActiveJob: () => false,
    hasActiveTarget: () => false,
  };
  return { proxmoxStore, provisionManager, makeProxmoxClient, inspectEndpoint, defaultPublicKey, proxmoxInventory, lifecycleManager };
}

let app;
let dir;

async function makeApp(overrides = {}) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-srv-'));
  const { config: configOverrides, ...serverOverrides } = overrides;
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none',
    configPath: path.join(dir, 'config.json'),
    ...configOverrides,
  };
  const store = createStore({ dataDir: dir });
  const statusChecker = {
    checkBox: async () => ({ reachable: true, tmux: true, sessions: [] }),
    listSessions: async () => ({ reachable: true, tmux: true, sessions: [{ name: 'web', windows: 1 }] }),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  return buildServer({ config, store, sessions, statusChecker, ...serverOverrides });
}

beforeEach(async () => { app = await makeApp(); });

async function login() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  return res.cookies.find((c) => c.name === 'tmuxifier_session');
}

test('rejects unauthenticated box listing', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/boxes' });
  expect(res.statusCode).toBe(401);
});

test('/api/auth/info reports password mode', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/info' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ mode: 'password' });
});

test('public responses include browser hardening headers', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/info' });
  expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(res.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'");
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  expect(res.headers['cache-control']).toBe('no-store');
});

test('/api/ui-config requires auth and returns terminal font defaults', async () => {
  const unauth = await app.inject({ method: 'GET', url: '/api/ui-config' });
  expect(unauth.statusCode).toBe(401);

  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'GET', url: '/api/ui-config', headers });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ termFont: null, termFontSize: 12, uploadMaxBytes: 25 * 1024 * 1024 });
});

test('/api/ui-config reflects the configured terminal font', async () => {
  app = await makeApp({ config: { termFont: 'Fira Code', termFontSize: 13 } });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'GET', url: '/api/ui-config', headers });
  expect(res.json()).toEqual({ termFont: 'Fira Code', termFontSize: 13, uploadMaxBytes: 25 * 1024 * 1024 });
});

test('login then CRUD a box', async () => {
  const cookie = await login();
  expect(cookie).toBeTruthy();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });
  expect(created.statusCode).toBe(201);
  const box = created.json();
  expect(box.host).toBe('h1');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()).toHaveLength(1);

  const del = await app.inject({ method: 'DELETE', url: `/api/boxes/${box.id}`, headers });
  expect(del.statusCode).toBe(200);
});

test('GET /api/export downloads a box snapshot, POST /api/import restores it', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1', user: 'deploy' } });

  const exported = await app.inject({ method: 'GET', url: '/api/export', headers });
  expect(exported.statusCode).toBe(200);
  expect(exported.headers['content-disposition']).toMatch(/attachment; filename="tmuxifier-boxes-.*\.json"/);
  const payload = exported.json();
  expect(payload.type).toBe('tmuxifier-boxes');
  expect(payload.boxes.map((b) => b.host)).toEqual(['h1']);

  // re-importing the same payload skips the existing host, adds the new one
  payload.boxes.push({ host: 'h2' });
  const imported = await app.inject({ method: 'POST', url: '/api/import', headers, payload });
  expect(imported.statusCode).toBe(200);
  expect(imported.json()).toEqual({ added: expect.any(Array), skipped: 1 });
  expect(imported.json().added.map((b) => b.host)).toEqual(['h2']);

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json().map((b) => b.host).sort()).toEqual(['h1', 'h2']);
});

test('POST /api/import rejects a payload without boxes with a 400 error', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/import', headers, payload: { nope: true } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/boxes array/);
});

test('rejects unauthenticated export', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/export' });
  expect(res.statusCode).toBe(401);
});

test('POST /api/boxes rejects duplicate host with a 400 error', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'Prod-DB' } });
  const duplicate = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'prod-db' } });

  expect(duplicate.statusCode).toBe(400);
  expect(duplicate.json()).toEqual({ error: 'box host already exists' });
});

test('POST /api/boxes persists only box fields from request bodies', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: {
      host: 'h1',
      label: 'Box One',
      installOhMyTmux: true,
      installOhMyZsh: true,
      installOhMyBash: true,
    },
  });

  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ host: 'h1', label: 'Box One' });
  expect(created.json()).not.toHaveProperty('installOhMyTmux');
  expect(created.json()).not.toHaveProperty('installOhMyZsh');
  expect(created.json()).not.toHaveProperty('installOhMyBash');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()[0]).not.toHaveProperty('installOhMyTmux');
  expect(list.json()[0]).not.toHaveProperty('installOhMyZsh');
  expect(list.json()[0]).not.toHaveProperty('installOhMyBash');
});

test('rejects cross-origin state-changing requests', async () => {
  app = await makeApp({ config: { publicUrl: 'https://tmux.example.com' } });
  const cookie = await login();
  const headers = {
    cookie: `${cookie.name}=${cookie.value}`,
    origin: 'https://evil.example',
  };

  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });

  expect(created.statusCode).toBe(403);
  expect(created.json()).toEqual({ error: 'forbidden origin' });
  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers: { cookie: headers.cookie } });
  expect(list.json()).toHaveLength(0);
});

test('allows same-origin state-changing requests', async () => {
  app = await makeApp({ config: { publicUrl: 'https://tmux.example.com' } });
  const cookie = await login();
  const headers = {
    cookie: `${cookie.name}=${cookie.value}`,
    origin: 'https://tmux.example.com',
  };

  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });

  expect(created.statusCode).toBe(201);
  expect(created.json().host).toBe('h1');
});

test('DELETE /api/boxes/:id delegates cleanup to the injected removeBox and returns its result', async () => {
  const calls = [];
  const removeBox = async (id) => { calls.push(id); return { ok: true }; };
  app = await makeApp({ removeBox });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', sessionName: 'work' },
  });
  const box = created.json();

  const del = await app.inject({ method: 'DELETE', url: `/api/boxes/${box.id}`, headers });

  expect(del.statusCode).toBe(200);
  expect(del.json()).toEqual({ ok: true });
  expect(calls).toEqual([box.id]);
});

test('DELETE /api/boxes/:id falls back to store.removeBox when no removeBox is injected', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', sessionName: 'work' },
  });
  const box = created.json();

  const del = await app.inject({ method: 'DELETE', url: `/api/boxes/${box.id}`, headers });

  expect(del.statusCode).toBe(200);
  expect(del.json()).toEqual({ ok: true });
  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()).toHaveLength(0);
});

test('wrong password is rejected', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'bad' } });
  expect(res.statusCode).toBe(401);
});

// The on-demand probing fallback was removed with the review's D1: the route
// only serves the poller snapshot (covered below), and the bounded-concurrency
// property lives in statusPoller — see test/statusPoller.test.js ("pollOnce
// probes with bounded concurrency").
test('status endpoint without a poller answers 503, never probes on demand', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'GET', url: '/api/status', headers });
  expect(res.statusCode).toBe(503);
});

test('status endpoint serves the poller snapshot without probing on each GET (no per-tab SSH amplification)', async () => {
  let snapshotReads = 0;
  const statusPoller = { getSnapshot: () => { snapshotReads++; return { box1: { reachable: true } }; } };
  // checkBox must never run on a GET when a poller is wired — that is the whole point.
  const statusChecker = { checkBox: async () => { throw new Error('GET /api/status must not probe'); } };
  app = await makeApp({ statusPoller, statusChecker });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  for (let i = 0; i < 7; i++) {                       // seven dashboard tabs fetching
    const res = await app.inject({ method: 'GET', url: '/api/status', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ box1: { reachable: true } });
  }
  expect(snapshotReads).toBe(7);                      // all served from the shared cache
});

test('GET /api/health/series requires auth', async () => {
  app = await makeApp({ history: historyStub() });
  expect((await app.inject({ method: 'GET', url: '/api/health/series' })).statusCode).toBe(401);
});

test('GET /api/health/series returns the full map or one box', async () => {
  app = await makeApp({ history: historyStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const all = await app.inject({ method: 'GET', url: '/api/health/series', headers });
  expect(all.statusCode).toBe(200);
  expect(Object.keys(all.json())).toEqual(['b1', 'b2']);
  const one = await app.inject({ method: 'GET', url: '/api/health/series?box=b1', headers });
  expect(one.json()).toEqual({ b1: [{ t: 1, up: true, cpuPct: 10 }] });
});

test('GET /api/health/events returns events + latestSeq, filtered by since', async () => {
  app = await makeApp({ history: historyStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const all = await app.inject({ method: 'GET', url: '/api/health/events', headers });
  expect(all.json()).toMatchObject({ latestSeq: 2 });
  expect(all.json().events).toHaveLength(1);
  const since = await app.inject({ method: 'GET', url: '/api/health/events?since=2', headers });
  expect(since.json().events).toHaveLength(0);
});

test('rejects a forged unsigned tmuxifier_session cookie', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/boxes', headers: { cookie: 'tmuxifier_session=ok' } });
  expect(res.statusCode).toBe(401);
});

test('rejects a tampered signed tmuxifier_session cookie', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/boxes',
    headers: { cookie: 'tmuxifier_session=s%3Aok.deadbeefbadsignature0000000000000000000000' },
  });
  expect(res.statusCode).toBe(401);
});

test('reconnect closes local sessions and best-effort kills remote session', async () => {
  const calls = [];
  const sessions = {
    open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {},
    closeKey(id) { calls.push(['closeKey', id]); },
  };
  const boxActions = {
    async killSession(box) { calls.push(['killSession', box.host, box.sessionName]); },
  };
  app = await makeApp({ sessions, boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', sessionName: 'work' },
  });
  const box = created.json();

  const res = await app.inject({ method: 'POST', url: `/api/boxes/${box.id}/reconnect`, headers });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(calls).toEqual([
    ['closeKey', box.id],
    ['closeKey', `provision:${box.id}`],
    ['killSession', 'h1', 'work'],
  ]);
  // Box should still exist (not removed)
  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()).toHaveLength(1);
});

test('reconnect shuts the ssh ControlMaster down before killing the PTY', async () => {
  const calls = [];
  const sessions = {
    open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {},
    closeKey(id) { calls.push(['closeKey', id]); },
  };
  const boxActions = {
    async exitMaster(box) { calls.push(['exitMaster', box.host]); },
    async killSession(box) { calls.push(['killSession', box.host]); },
  };
  app = await makeApp({ sessions, boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({
    method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1', sessionName: 'work' },
  });
  const box = created.json();

  const res = await app.inject({ method: 'POST', url: `/api/boxes/${box.id}/reconnect`, headers });

  expect(res.statusCode).toBe(200);
  // exitMaster must run first: -O exit can only remove the socket while the
  // master is still alive. Killing the PTY first would leave a stale socket.
  expect(calls[0]).toEqual(['exitMaster', 'h1']);
  expect(calls).toContainEqual(['closeKey', box.id]);
});

test('reconnect returns 404 for unknown box', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nonexistent/reconnect', headers });
  expect(res.statusCode).toBe(404);
});

test('reconnect does not wait for remote session cleanup', async () => {
  let killCalled = false;
  const boxActions = {
    killSession() {
      killCalled = true;
      return new Promise(() => {});
    },
  };
  app = await makeApp({ boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', sessionName: 'work' },
  });
  const box = created.json();

  const res = await app.inject({ method: 'POST', url: `/api/boxes/${box.id}/reconnect`, headers });

  expect(res.statusCode).toBe(200);
  expect(killCalled).toBe(true);
});

test('forget-hostkey removes the key, drops the master, and resets backoff', async () => {
  const calls = [];
  const boxActions = { async exitMaster(box) { calls.push(['exitMaster', box.host]); } };
  const knownHosts = { async forget(host, port) { calls.push(['forget', host, port]); return []; } };
  const statusChecker = { async checkBox() { return { reachable: false }; }, resetBackoff(id) { calls.push(['resetBackoff', id]); } };
  app = await makeApp({ boxActions, knownHosts, statusChecker });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1', port: 2222, sessionName: 'work' } });
  const box = created.json();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${box.id}/forget-hostkey`, headers });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(calls).toEqual([['forget', 'h1', 2222], ['exitMaster', 'h1'], ['resetBackoff', box.id]]);
});

test('forget-hostkey returns 404 for unknown box and requires auth', async () => {
  app = await makeApp({ knownHosts: { forget: async () => [] } });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const missing = await app.inject({ method: 'POST', url: '/api/boxes/nonexistent/forget-hostkey', headers });
  expect(missing.statusCode).toBe(404);
  const unauthed = await app.inject({ method: 'POST', url: '/api/boxes/nonexistent/forget-hostkey' });
  expect(unauthed.statusCode).toBe(401);
});

test('seed-ai-auth runs the seeder and returns redacted results only', async () => {
  const seeded = [];
  const aiAuthSeeder = { async seed(box) { seeded.push(box.host); return [
    { target: 'claude', ok: true },
    { target: 'codex', ok: false, skipped: 'no codex auth on the Tmuxifier host' },
  ]; } };
  app = await makeApp({ aiAuthSeeder });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1', sessionName: 'work' } });
  const box = created.json();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${box.id}/seed-ai-auth`, headers });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ results: [
    { target: 'claude', ok: true },
    { target: 'codex', ok: false, skipped: 'no codex auth on the Tmuxifier host' },
  ] });
  expect(seeded).toEqual(['h1']);
  expect(res.body).not.toContain('sk-ant');
});

test('seed-ai-auth 404s unknown box and requires auth', async () => {
  app = await makeApp({ aiAuthSeeder: { seed: async () => [] } });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  expect((await app.inject({ method: 'POST', url: '/api/boxes/nonexistent/seed-ai-auth', headers })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: '/api/boxes/nonexistent/seed-ai-auth' })).statusCode).toBe(401);
});

test('seed-ai-auth returns 503 when no seeder is wired', async () => {
  app = await makeApp();
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1', sessionName: 'work' } });
  const box = created.json();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${box.id}/seed-ai-auth`, headers });
  expect(res.statusCode).toBe(503);
});

test('seed-ai-auth never echoes a thrown error into the response body', async () => {
  app = await makeApp({ aiAuthSeeder: { seed: async () => { throw new Error('sk-ant-oat-LEAKED token material'); } } });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1', sessionName: 'work' } });
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${created.json().id}/seed-ai-auth`, headers });
  expect(res.statusCode).toBe(500);
  expect(res.body).not.toContain('LEAKED');
  expect(res.json()).toEqual({ error: 'seeding failed' });
});

test('GET /api/local-shell returns default shell', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'GET', url: '/api/local-shell', headers });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ shell: 'none' });
});

test('GET /api/local-shell requires auth', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/local-shell' });
  expect(res.statusCode).toBe(401);
});

test('PATCH /api/local-shell updates shell and persists to config.json', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  // Update to omz
  const patch = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: { shell: 'omz' } });
  expect(patch.statusCode).toBe(200);
  expect(patch.json()).toEqual({ ok: true });

  // Verify GET reflects change
  const get = await app.inject({ method: 'GET', url: '/api/local-shell', headers });
  expect(get.json()).toEqual({ shell: 'omz' });
});

test('PATCH /api/local-shell runs local setup before persisting shell framework', async () => {
  const calls = [];
  const localShellActions = {
    async ensureReady(shell) {
      calls.push(shell);
    },
  };
  app = await makeApp({ localShellActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const patch = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: { shell: 'omb' } });

  expect(patch.statusCode).toBe(200);
  expect(calls).toEqual(['omb']);
  await expect(fs.readFile(path.join(dir, 'config.json'), 'utf8')).resolves.toContain('"localShell": "omb"');
});

test('PATCH /api/local-shell does not persist shell framework when local setup fails', async () => {
  const localShellActions = {
    async ensureReady() {
      throw new Error('Oh My Bash install requires curl or wget');
    },
  };
  app = await makeApp({ localShellActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const patch = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: { shell: 'omb' } });

  expect(patch.statusCode).toBe(400);
  expect(patch.json()).toEqual({ error: 'Oh My Bash install requires curl or wget' });

  const get = await app.inject({ method: 'GET', url: '/api/local-shell', headers });
  expect(get.json()).toEqual({ shell: 'none' });
  await expect(fs.stat(path.join(dir, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('PATCH /api/local-shell rejects invalid shell values', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const res = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: { shell: 'zsh' } });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'invalid shell' });

  const res2 = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: {} });
  expect(res2.statusCode).toBe(400);

  const res3 = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: { shell: '' } });
  expect(res3.statusCode).toBe(400);
});

test('POST /api/local-shell/reconnect closes local PTY and kills configured tmux session', async () => {
  const calls = [];
  const sessions = {
    openLocal() {}, open() {}, provision() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {},
    closeKey(id) { calls.push(['closeKey', id]); },
  };
  app = await makeApp({
    sessions,
    localSession: 'local-test-reconnect',
    killLocalSession(sessionName) { calls.push(['killLocalSession', sessionName]); },
  });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const res = await app.inject({ method: 'POST', url: '/api/local-shell/reconnect', headers });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(calls).toEqual([['closeKey', '__local__'], ['killLocalSession', 'local-test-reconnect']]);
});

test('POST /api/local-shell/reconnect requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/local-shell/reconnect' });
  expect(res.statusCode).toBe(401);
});

test('reconnect clears the box backoff so it will be re-probed at full cadence', async () => {
  const reset = [];
  const statusChecker = {
    checkBox: async () => ({ reachable: true }),
    resetBackoff: (id) => reset.push(id),
  };
  app = await makeApp({ statusChecker });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });
  const id = created.json().id;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${id}/reconnect`, headers });
  expect(res.statusCode).toBe(200);
  expect(reset).toContain(id);
});

test('probe-sessions requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/boxes/probe-sessions', payload: { host: 'h' } });
  expect(res.statusCode).toBe(401);
});

test('probe-sessions returns the live session list for an authed request', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/boxes/probe-sessions', headers, payload: { host: 'h' } });
  expect(res.statusCode).toBe(200);
  expect(res.json().sessions).toEqual([{ name: 'web', windows: 1 }]);
});

test('probe-sessions rejects an unsafe host with 400', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/boxes/probe-sessions', headers, payload: { host: '-bad' } });
  expect(res.statusCode).toBe(400);
});

test('editing sessionName persists through PATCH', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h2' } });
  const box = created.json();
  expect(box.sessionName).toBe('web');
  const patched = await app.inject({ method: 'PATCH', url: `/api/boxes/${box.id}`, headers, payload: { sessionName: 'mine' } });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().sessionName).toBe('mine');
  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json().find((b) => b.id === box.id).sessionName).toBe('mine');
});

test('changing sessionName drops the live PTY so the terminal reattaches to the new session', async () => {
  const closed = [];
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {}, closeKey: (k) => closed.push(k) };
  const localApp = await makeApp({ sessions });
  const loginRes = await localApp.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const cookie = loginRes.cookies.find((c) => c.name === 'tmuxifier_session');
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await localApp.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h9', sessionName: 'web' } });
  const box = created.json();

  // A real session change drops the PTY (once) so the next attach uses the new name.
  await localApp.inject({ method: 'PATCH', url: `/api/boxes/${box.id}`, headers, payload: { sessionName: 'mine' } });
  expect(closed).toEqual([box.id]);

  // A patch that does not change the session (here: only the label) does NOT drop it again.
  await localApp.inject({ method: 'PATCH', url: `/api/boxes/${box.id}`, headers, payload: { sessionName: 'mine', label: 'renamed' } });
  expect(closed).toEqual([box.id]);
});

test('POST /api/fleet/jobs requires auth', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const res = await app.inject({ method: 'POST', url: '/api/fleet/jobs', payload: { boxIds: ['b1'], command: 'x' } });
  expect(res.statusCode).toBe(401);
});

test('POST /api/fleet/jobs rejects a cross-origin request', async () => {
  app = await makeApp({ fleetManager: fleetStub(), config: { publicUrl: 'https://tmux.example.com' } });
  const cookie = await login();
  const res = await app.inject({
    method: 'POST', url: '/api/fleet/jobs',
    headers: { cookie: `${cookie.name}=${cookie.value}`, origin: 'https://evil.example' },
    payload: { boxIds: ['b1'], command: 'x' },
  });
  expect(res.statusCode).toBe(403);
});

test('POST /api/fleet/jobs validates command and boxIds with 400', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const empty = await app.inject({ method: 'POST', url: '/api/fleet/jobs', headers, payload: { boxIds: ['b1'], command: '   ' } });
  expect(empty.statusCode).toBe(400);
  const noBoxes = await app.inject({ method: 'POST', url: '/api/fleet/jobs', headers, payload: { boxIds: [], command: 'x' } });
  expect(noBoxes.statusCode).toBe(400);
});

test('POST /api/fleet/jobs maps a createJob error to 400', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/fleet/jobs', headers, payload: { boxIds: ['bad'], command: 'x' } });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'unknown box: bad' });
});

test('POST /api/fleet/jobs creates a job and forwards boxIds + command', async () => {
  const calls = [];
  app = await makeApp({ fleetManager: fleetStub(calls) });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/fleet/jobs', headers, payload: { boxIds: ['b1', 'b2'], command: 'uptime' } });
  expect(res.statusCode).toBe(201);
  expect(res.json().id).toBe('job1');
  expect(calls).toContainEqual(['createJob', ['b1', 'b2'], 'uptime']);
});

test('GET /api/fleet/jobs lists job summaries', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const cookie = await login();
  const res = await app.inject({ method: 'GET', url: '/api/fleet/jobs', headers: { cookie: `${cookie.name}=${cookie.value}` } });
  expect(res.statusCode).toBe(200);
  expect(res.json()[0]).toMatchObject({ id: 'job1', okCount: 1 });
});

test('GET /api/fleet/jobs/:id returns the job or 404', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const ok = await app.inject({ method: 'GET', url: '/api/fleet/jobs/job1', headers });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().id).toBe('job1');
  const missing = await app.inject({ method: 'GET', url: '/api/fleet/jobs/nope', headers });
  expect(missing.statusCode).toBe(404);
});

test('POST /api/fleet/jobs/:id/cancel cancels or 404s', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const ok = await app.inject({ method: 'POST', url: '/api/fleet/jobs/job1/cancel', headers });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().status).toBe('cancelled');
  const missing = await app.inject({ method: 'POST', url: '/api/fleet/jobs/nope/cancel', headers });
  expect(missing.statusCode).toBe(404);
});

test('POST /api/fleet/jobs rejects a command exceeding 65536 bytes with 400', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/fleet/jobs', headers, payload: { boxIds: ['b1'], command: 'x'.repeat(65537) } });
  expect(res.statusCode).toBe(400);
});

test('POST /api/fleet/jobs accepts a multi-line script up to 65536 bytes', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const script = '#!/usr/bin/env bash\nset -euo pipefail\n' + 'echo hi\n'.repeat(100);
  const res = await app.inject({ method: 'POST', url: '/api/fleet/jobs', headers, payload: { boxIds: ['b1'], command: script } });
  expect(res.statusCode).toBe(201);
  expect(res.json().command).toBe(script);
});

test('POST /api/fleet/jobs/:id/cancel rejects a cross-origin request with 403', async () => {
  app = await makeApp({ fleetManager: fleetStub(), config: { publicUrl: 'https://tmux.example.com' } });
  const cookie = await login();
  const res = await app.inject({
    method: 'POST', url: '/api/fleet/jobs/job1/cancel',
    headers: { cookie: `${cookie.name}=${cookie.value}`, origin: 'https://evil.example' },
  });
  expect(res.statusCode).toBe(403);
});

test('GET /api/fleet/jobs and GET /api/fleet/jobs/:id require auth', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const list = await app.inject({ method: 'GET', url: '/api/fleet/jobs' });
  expect(list.statusCode).toBe(401);
  const detail = await app.inject({ method: 'GET', url: '/api/fleet/jobs/job1' });
  expect(detail.statusCode).toBe(401);
});

test('proxmox routes require auth', async () => {
  app = await makeApp(proxmoxStubs());
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/hosts' })).statusCode).toBe(401);
});

test('hosts: list is redacted, add verifies the token, browse works, token never leaks', async () => {
  const calls = [];
  app = await makeApp(proxmoxStubs(calls));
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const list = await app.inject({ method: 'GET', url: '/api/proxmox/hosts', headers });
  expect(list.statusCode).toBe(200);
  expect(list.payload).not.toContain('tokenSecret');
  expect(list.json()[0].hasToken).toBe(true);

  const inspect = await app.inject({ method: 'POST', url: '/api/proxmox/inspect', headers, payload: { endpoint: 'pve.example.com:8006' } });
  expect(inspect.json().fingerprint256).toBe('AB:CD');

  const add = await app.inject({ method: 'POST', url: '/api/proxmox/hosts', headers, payload: { name: 'lab', endpoint: 'pve.example.com:8006', tokenId: 'user@pam!t', tokenSecret: 'sek', verifyMode: 'pin', fingerprint256: 'AB' } });
  expect(add.statusCode).toBe(201);
  expect(add.payload).not.toContain('sek');

  const storage = await app.inject({ method: 'GET', url: '/api/proxmox/hosts/H1/nodes/pve/storage', headers });
  expect(storage.json()).toEqual({ rootdir: [{ storage: 'local-lvm', content: 'rootdir,images' }], vztmpl: [{ storage: 'local', content: 'vztmpl,iso' }] });
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/hosts/NOPE/nodes', headers })).statusCode).toBe(404);
});

test('keys reject an invalid public key (400)', async () => {
  app = await makeApp(proxmoxStubs());
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  expect((await app.inject({ method: 'POST', url: '/api/proxmox/keys', headers, payload: { name: 'k', publicKey: 'nope' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/proxmox/keys', headers, payload: { name: 'k', publicKey: 'ssh-ed25519 AAA you@example.com' } })).statusCode).toBe(201);
});

test('default-key route and root-password set/status/clear (with 400 on a short password)', async () => {
  app = await makeApp(proxmoxStubs());
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/default-key' })).statusCode).toBe(401); // auth-gated
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/default-key', headers })).json().publicKey).toBe('ssh-ed25519 HOSTKEY tmuxifier@host');
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/root-password', headers })).json().set).toBe(false);
  expect((await app.inject({ method: 'PUT', url: '/api/proxmox/root-password', headers, payload: { password: '1234' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'PUT', url: '/api/proxmox/root-password', headers, payload: { password: 'hunter2!' } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/root-password', headers })).json().set).toBe(true);
  expect((await app.inject({ method: 'DELETE', url: '/api/proxmox/root-password', headers })).statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/root-password', headers })).json().set).toBe(false);
});

test('PUT /api/proxmox/presets/:id requires auth, updates, validates, and 404s', async () => {
  const calls = [];
  app = await makeApp(proxmoxStubs(calls));
  const payload = {
    name: 'production', hostId: 'H1', node: 'pve', template: 'local:vztmpl/debian-12.tar.zst',
    storage: 'local-lvm', diskGiB: 16, cores: 4, memoryMiB: 4096, swapMiB: 512,
    unprivileged: true, features: { nesting: true },
    net: { bridge: 'vmbr0', vlan: null, ipMode: 'dhcp', cidr: null, gateway: null },
    dns: { nameserver: null, searchdomain: null }, mounts: [], onboot: false,
    startAfterCreate: true, boxDefaults: { user: 'root', sessionName: 'web', tags: [] },
  };

  expect((await app.inject({
    method: 'PUT', url: '/api/proxmox/presets/P1', payload,
  })).statusCode).toBe(401);

  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const ok = await app.inject({
    method: 'PUT', url: '/api/proxmox/presets/P1', headers, payload,
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toMatchObject({ id: 'P1', name: 'production', cores: 4, createdAt: 't' });
  expect(calls).toContainEqual(['updatePreset', 'P1', 'production']);

  const invalid = await app.inject({
    method: 'PUT', url: '/api/proxmox/presets/P1', headers, payload: { ...payload, name: '' },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toEqual({ error: 'preset name is required' });

  const missing = await app.inject({
    method: 'PUT', url: '/api/proxmox/presets/NOPE', headers, payload,
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toEqual({ error: 'preset not found' });
});

test('provisions: validation, create, poll, 404', async () => {
  const calls = [];
  app = await makeApp(proxmoxStubs(calls));
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  expect((await app.inject({ method: 'POST', url: '/api/proxmox/provisions', headers, payload: { presetId: 'P1' } })).statusCode).toBe(400);
  const ok = await app.inject({ method: 'POST', url: '/api/proxmox/provisions', headers, payload: { presetId: 'P1', hostname: 'dev-01' } });
  expect(ok.statusCode).toBe(201);
  expect(ok.json().status).toBe('running');
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/provisions', headers })).json()).toHaveLength(1);
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/provisions/J1', headers })).json().status).toBe('done');
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/provisions/NOPE', headers })).statusCode).toBe(404);
});

test('provisions: forwards setupOptions from the request body to the provision manager', async () => {
  // Guards the client -> server contract for setup options: the route must forward
  // req.body as-is (including setupOptions) to provisionManager.createProvision, since
  // that's what makes server-side setup auto-start on box link.
  const received = [];
  const provisionManager = {
    createProvision: async (body) => { received.push(body); return { id: 'J1', status: 'running', hostname: body.hostname }; },
    listProvisions: () => [],
    getProvision: () => undefined,
  };
  app = await makeApp({ ...proxmoxStubs([]), provisionManager });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const setupOptions = { ohMyTmux: true, ohMyZsh: false, ohMyBash: false, tools: ['git', 'curl'] };
  const res = await app.inject({
    method: 'POST', url: '/api/proxmox/provisions', headers,
    payload: { presetId: 'P1', hostname: 'dev-01', setupOptions },
  });
  expect(res.statusCode).toBe(201);
  expect(received[0].setupOptions).toEqual(setupOptions);
});

test('add-host: token verify failure returns 400 and never persists the host', async () => {
  const calls = [];
  const stubs = proxmoxStubs(calls);
  const failClient = () => ({ ...stubs.makeProxmoxClient(), version: async () => { throw new Error('token rejected'); } });
  app = await makeApp({ ...stubs, makeProxmoxClient: failClient });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/proxmox/hosts', headers, payload: { name: 'lab', endpoint: 'pve.example.com:8006', tokenId: 'user@pam!t', tokenSecret: 'sek', verifyMode: 'pin', fingerprint256: 'AB' } });
  expect(res.statusCode).toBe(400);
  expect(calls.some(([op]) => op === 'addHost')).toBe(false);
});

test('linked-container browse and lifecycle routes are auth-gated and redacted', async () => {
  const calls = [];
  app = await makeApp(proxmoxStubs(calls));
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/containers' })).statusCode).toBe(401);
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const linked = await app.inject({ method: 'GET', url: '/api/proxmox/containers', headers });
  expect(linked.statusCode).toBe(200);
  expect(linked.payload).not.toContain('tokenSecret');
  expect(linked.json()[0]).toMatchObject({ boxId: 'B1', vmid: 131, state: 'stopped', activeJob: { id: 'L1', action: 'start' } });
  const browse = await app.inject({ method: 'GET', url: '/api/proxmox/hosts/H1/nodes/pve/containers', headers });
  expect(browse.json()[0]).toMatchObject({ vmid: 131, linkedBoxId: null });
  const created = await app.inject({ method: 'POST', url: '/api/proxmox/lifecycle-jobs', headers, payload: { boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' } });
  expect(created.statusCode).toBe(201);
  expect(calls).toContainEqual(['createLifecycleJob', { boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' }]);
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/lifecycle-jobs', headers })).json()).toHaveLength(1);
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/lifecycle-jobs/L1', headers })).json().id).toBe('L1');
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/lifecycle-jobs/NOPE', headers })).statusCode).toBe(404);
});

test('manual association verifies the live target, prevents duplicates, and unlinks without PVE mutation', async () => {
  const stubs = proxmoxStubs();
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: '192.168.1.10', label: 'dev-01' });
  app = await makeApp({ ...stubs, store });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const linked = await app.inject({ method: 'PUT', url: `/api/boxes/${box.id}/proxmox`, headers, payload: { hostId: 'H1', node: 'pve', vmid: 131 } });
  expect(linked.statusCode).toBe(200);
  expect(linked.json().proxmox).toEqual({ hostId: 'H1', node: 'pve', vmid: 131, endpoint: 'pve.example.com:8006' });
  const unlinked = await app.inject({ method: 'DELETE', url: `/api/boxes/${box.id}/proxmox`, headers });
  expect(unlinked.statusCode).toBe(200);
  expect(unlinked.json().proxmox).toBeUndefined();
});

test.each([400, 404, 409, 502])('lifecycle service statusCode %s is preserved', async (statusCode) => {
  const stubs = proxmoxStubs();
  app = await makeApp({ ...stubs, lifecycleManager: {
    ...stubs.lifecycleManager,
    createJob: async () => { throw Object.assign(new Error(`failure-${statusCode}`), { statusCode }); },
  } });
  const cookie = await login();
  const response = await app.inject({
    method: 'POST', url: '/api/proxmox/lifecycle-jobs',
    headers: { cookie: `${cookie.name}=${cookie.value}` },
    payload: { boxId: 'B1', action: 'start' },
  });
  expect(response.statusCode).toBe(statusCode);
  expect(response.json()).toEqual({ error: `failure-${statusCode}` });
});

test('generic box PATCH cannot write lifecycle authority and active jobs block removal', async () => {
  const stubs = proxmoxStubs();
  stubs.lifecycleManager.hasActiveJob = () => true;
  app = await makeApp(stubs);
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  expect((await app.inject({ method: 'PATCH', url: '/api/boxes/B1', headers, payload: { proxmox: { hostId: 'H1', node: 'pve', vmid: 131 } } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'DELETE', url: '/api/boxes/B1', headers })).statusCode).toBe(409);
});

test('lifecycle and association mutations reject an untrusted Origin', async () => {
  app = await makeApp(proxmoxStubs());
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}`, origin: 'https://evil.example.com' };
  expect((await app.inject({ method: 'POST', url: '/api/proxmox/lifecycle-jobs', headers, payload: { boxId: 'B1', action: 'start' } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'PUT', url: '/api/boxes/B1/proxmox', headers, payload: { hostId: 'H1', node: 'pve', vmid: 131 } })).statusCode).toBe(403);
});

test('target coordinates, browse failures, and malformed links map to safe errors', async () => {
  const calls = [];
  const stubs = proxmoxStubs(calls);
  stubs.proxmoxInventory.listNodeContainers = async () => { throw new Error('PVE unavailable'); };
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ host: '192.168.1.10' });
  app = await makeApp({ ...stubs, store });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const coordinates = await app.inject({ method: 'POST', url: '/api/proxmox/lifecycle-jobs', headers, payload: { boxId: box.id, action: 'start', vmid: 999 } });
  expect(coordinates.statusCode).toBe(400);
  expect(calls.some(([name]) => name === 'createLifecycleJob')).toBe(false);
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/hosts/NOPE/nodes/pve/containers', headers })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/hosts/H1/nodes/pve/containers', headers })).statusCode).toBe(502);
  expect((await app.inject({ method: 'PUT', url: `/api/boxes/${box.id}/proxmox`, headers, payload: { hostId: 'H1', node: '../pve', vmid: 99 } })).statusCode).toBe(400);
});

// --- Session expiry (the cookie is no longer a forever-valid constant) -------

test('an expired session cookie is rejected with 401', async () => {
  await app.ready();
  const staleEpoch = Math.floor(Date.now() / 1000) - (60 * 60 * 24 * 7) - 3600; // TTL + 1h ago
  const signed = app.signCookie(`ok.${staleEpoch}`);
  const res = await app.inject({
    method: 'GET', url: '/api/boxes',
    headers: { cookie: `tmuxifier_session=${encodeURIComponent(signed)}` },
  });
  expect(res.statusCode).toBe(401);
});

test('a legacy constant "ok" session cookie (no issue time) is rejected with 401', async () => {
  await app.ready();
  const signed = app.signCookie('ok');
  const res = await app.inject({
    method: 'GET', url: '/api/boxes',
    headers: { cookie: `tmuxifier_session=${encodeURIComponent(signed)}` },
  });
  expect(res.statusCode).toBe(401);
});

test('a freshly signed ok.<now> cookie is accepted (sanity check for the two rejections above)', async () => {
  await app.ready();
  const signed = app.signCookie(`ok.${Math.floor(Date.now() / 1000)}`);
  const res = await app.inject({
    method: 'GET', url: '/api/boxes',
    headers: { cookie: `tmuxifier_session=${encodeURIComponent(signed)}` },
  });
  expect(res.statusCode).toBe(200);
});

// --- Login rate limiting ------------------------------------------------------

test('login locks an ip out after 10 failures — even the right password gets 429 until the window passes', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'bad' } });
    expect(r.statusCode).toBe(401);
  }
  const locked = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  expect(locked.statusCode).toBe(429);
  expect(locked.json().error).toMatch(/too many/i);
});

test('a successful login clears the ip failure count', async () => {
  for (let i = 0; i < 9; i++) {
    await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'bad' } });
  }
  const ok = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  expect(ok.statusCode).toBe(200);
  // The counter restarted: one more failure is nowhere near the lockout.
  const after = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'bad' } });
  expect(after.statusCode).toBe(401);
  const again = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  expect(again.statusCode).toBe(200);
});

test('behind a trusted proxy, rate limiting buckets by the forwarded client ip, not the proxy', async () => {
  app = await makeApp({ config: { trustProxy: true } });
  const attacker = { 'x-forwarded-for': '203.0.113.7' };
  for (let i = 0; i < 10; i++) {
    await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'bad' }, headers: attacker });
  }
  const locked = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' }, headers: attacker });
  expect(locked.statusCode).toBe(429);
  // A different client through the same proxy is NOT locked out.
  const victim = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' }, headers: { 'x-forwarded-for': '203.0.113.99' } });
  expect(victim.statusCode).toBe(200);
});

// --- PATCH connection-field changes drop the live PTY --------------------------

test('changing a connection field (user/port/proxyJump) drops the live PTY like a session change', async () => {
  const closed = [];
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {}, closeKey: (k) => closed.push(k) };
  const localApp = await makeApp({ sessions });
  const loginRes = await localApp.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const cookie = loginRes.cookies.find((c) => c.name === 'tmuxifier_session');
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await localApp.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h9', user: 'root', sessionName: 'web' } });
  const box = created.json();

  // The terminal would otherwise silently stay attached to the OLD host/user
  // while the status dot probes the NEW one.
  await localApp.inject({ method: 'PATCH', url: `/api/boxes/${box.id}`, headers, payload: { user: 'deploy' } });
  expect(closed).toEqual([box.id]);

  await localApp.inject({ method: 'PATCH', url: `/api/boxes/${box.id}`, headers, payload: { port: 2222 } });
  expect(closed).toEqual([box.id, box.id]);

  await localApp.inject({ method: 'PATCH', url: `/api/boxes/${box.id}`, headers, payload: { proxyJump: 'jump1' } });
  expect(closed).toEqual([box.id, box.id, box.id]);

  // A cosmetic change (label/tags) must NOT churn the PTY.
  await localApp.inject({ method: 'PATCH', url: `/api/boxes/${box.id}`, headers, payload: { label: 'renamed', tags: ['prod'] } });
  expect(closed).toHaveLength(3);
});

// --- POST /api/upload --------------------------------------------------------

test('POST /api/upload requires auth', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/upload?box=__local__&name=x.png',
    headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x'),
  });
  expect(res.statusCode).toBe(401);
});

test('POST /api/upload saves a local-shell upload and returns its absolute path', async () => {
  const saved = [];
  app = await makeApp({
    saveUploadLocally: async (stored, buf) => { saved.push([stored, buf]); return `/home/u/.tmuxifier-uploads/${stored}`; },
    injectLocalUpload: async (session, p) => ({ injected: true, mode: 'shell' }),
  });
  const cookie = await login();
  const res = await app.inject({
    method: 'POST', url: '/api/upload?box=__local__&name=shot.png',
    headers: { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/octet-stream' },
    payload: Buffer.from('img-bytes'),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().path).toMatch(/^\/home\/u\/\.tmuxifier-uploads\/\d+-[0-9a-f]{8}-shot\.png$/);
  expect(res.json().injected).toBe(true);
  expect(res.json().mode).toBe('shell');
  expect(saved).toHaveLength(1);
  expect(saved[0][1].toString()).toBe('img-bytes');
});

test('POST /api/upload routes a box upload through boxActions.uploadFile', async () => {
  const calls = [];
  app = await makeApp({
    boxActions: {
      uploadFile: async (box, name, buf) => { calls.push([box.id, name, buf.toString()]); return { ok: true, path: '/root/.tmuxifier-uploads/1-aa-shot.png' }; },
      injectUploadPath: async (box, session, p) => { calls.push(['inject', session, p]); return { injected: true, mode: 'claude' }; },
    },
  });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/octet-stream' };
  const add = await app.inject({ method: 'POST', url: '/api/boxes', headers: { cookie: headers.cookie, 'content-type': 'application/json' }, payload: { label: 'b', host: 'h1' } });
  const boxId = add.json().id;
  const sessionName = add.json().sessionName;
  const res = await app.inject({ method: 'POST', url: `/api/upload?box=${boxId}&name=shot.png`, headers, payload: Buffer.from('bytes') });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ path: '/root/.tmuxifier-uploads/1-aa-shot.png', injected: true, mode: 'claude' });
  expect(calls).toContainEqual([boxId, 'shot.png', 'bytes']);
  expect(calls).toContainEqual(['inject', sessionName, '/root/.tmuxifier-uploads/1-aa-shot.png']);
});

test('POST /api/upload succeeds even when injection is unavailable or fails', async () => {
  app = await makeApp({
    boxActions: {
      uploadFile: async () => ({ ok: true, path: '/root/.tmuxifier-uploads/1-aa-x.png' }),
      // no injectUploadPath at all — route must degrade, not 500
    },
  });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/octet-stream' };
  const add = await app.inject({ method: 'POST', url: '/api/boxes', headers: { cookie: headers.cookie, 'content-type': 'application/json' }, payload: { label: 'b', host: 'h1' } });
  const res = await app.inject({ method: 'POST', url: `/api/upload?box=${add.json().id}&name=x.png`, headers, payload: Buffer.from('x') });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ path: '/root/.tmuxifier-uploads/1-aa-x.png', injected: false, mode: 'error' });
});

test('POST /api/upload rejects bad filenames and unknown boxes', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/octet-stream' };
  const bad = await app.inject({ method: 'POST', url: `/api/upload?box=__local__&name=${encodeURIComponent('../etc/passwd')}`, headers, payload: Buffer.from('x') });
  expect(bad.statusCode).toBe(400);
  const nobox = await app.inject({ method: 'POST', url: '/api/upload?box=nope&name=x.png', headers, payload: Buffer.from('x') });
  expect(nobox.statusCode).toBe(400);
  expect(nobox.json().error).toContain('unknown box');
});

test('POST /api/upload returns 413 over the configured limit and 502 on ssh failure', async () => {
  app = await makeApp({
    config: { uploadMaxBytes: 16 },
    boxActions: { uploadFile: async () => ({ ok: false, error: 'Connection closed' }) },
  });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/octet-stream' };
  const big = await app.inject({ method: 'POST', url: '/api/upload?box=__local__&name=x.png', headers, payload: Buffer.alloc(64, 0x41) });
  expect(big.statusCode).toBe(413);
  const add = await app.inject({ method: 'POST', url: '/api/boxes', headers: { cookie: headers.cookie, 'content-type': 'application/json' }, payload: { label: 'b', host: 'h1' } });
  const res = await app.inject({ method: 'POST', url: `/api/upload?box=${add.json().id}&name=x.png`, headers, payload: Buffer.from('x') });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toContain('upload failed');
});
