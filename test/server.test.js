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
    updateHost: async (id, patch) => ({ ...host, ...patch, hasToken: true }),
    removeHost: async () => {},
    listKeys: async () => [{ id: 'K1', name: 'mgmt', publicKey: 'ssh-ed25519 AAA you@example.com' }],
    addKey: async (spec) => { if (!String(spec.publicKey).startsWith('ssh-')) throw new Error('not a valid public key'); return { id: 'K2', ...spec }; },
    removeKey: async () => {},
    listPresets: async () => [{ id: 'P1', name: 'dev' }],
    getPreset: async (id) => (id === 'P1' ? { id: 'P1', name: 'dev' } : undefined),
    addPreset: async (spec) => ({ id: 'P2', ...spec }),
    updatePreset: async (id, patch) => ({ id, ...patch }),
    removePreset: async () => {},
    hasRootPassword: async () => !!rootPw,
    setRootPassword: async (pw) => { if (!pw || pw.length < 5) throw new Error('root password must be at least 5 characters'); rootPw = pw; },
    clearRootPassword: async () => { rootPw = null; },
  };
  const provisionManager = {
    createProvision: async (body) => { calls.push(['createProvision', body.hostname]); if (!body.hostname) throw new Error('hostname required'); return { id: 'J1', status: 'running', hostname: body.hostname }; },
    listProvisions: () => [{ id: 'J1', status: 'done' }],
    getProvision: (id) => (id === 'J1' ? { id: 'J1', status: 'done', log: '' } : undefined),
    cancelProvision: (id) => (id === 'J1' ? { id: 'J1', status: 'cancelled' } : undefined),
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
  return { proxmoxStore, provisionManager, makeProxmoxClient, inspectEndpoint, defaultPublicKey };
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
  expect(res.json()).toEqual({ termFont: null, termFontSize: 12 });
});

test('/api/ui-config reflects the configured terminal font', async () => {
  app = await makeApp({ config: { termFont: 'Fira Code', termFontSize: 13 } });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'GET', url: '/api/ui-config', headers });
  expect(res.json()).toEqual({ termFont: 'Fira Code', termFontSize: 13 });
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

test('removing a box closes local terminal and best-effort kills remote session before deletion', async () => {
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

  const del = await app.inject({ method: 'DELETE', url: `/api/boxes/${box.id}`, headers });

  expect(del.statusCode).toBe(200);
  expect(calls).toEqual([
    ['closeKey', box.id],
    ['killSession', 'h1', 'work'],
  ]);
  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()).toHaveLength(0);
});

test('removing a box does not wait for remote session cleanup', async () => {
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

  const del = await app.inject({ method: 'DELETE', url: `/api/boxes/${box.id}`, headers });

  expect(del.statusCode).toBe(200);
  expect(killCalled).toBe(true);
  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()).toHaveLength(0);
});

test('wrong password is rejected', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'bad' } });
  expect(res.statusCode).toBe(401);
});

test('status endpoint returns a map keyed by box id', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });
  const id = created.json().id;
  const res = await app.inject({ method: 'GET', url: '/api/status', headers });
  expect(res.json()[id]).toMatchObject({ reachable: true });
});

test('status endpoint probes boxes with bounded concurrency (no fleet-wide SSH burst)', async () => {
  let inFlight = 0;
  let peak = 0;
  const statusChecker = {
    checkBox: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { reachable: true };
    },
  };
  app = await makeApp({ statusChecker, config: { statusConcurrency: 2 } });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  for (let i = 0; i < 6; i++) {
    await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: `h${i}` } });
  }
  const res = await app.inject({ method: 'GET', url: '/api/status', headers });
  expect(Object.keys(res.json())).toHaveLength(6); // every box still probed
  expect(peak).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(2);             // never more than the limit at once
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
  expect((await app.inject({ method: 'GET', url: '/api/proxmox/hosts/H1/nextid', headers })).json()).toEqual({ vmid: '131' });
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

test('provisions: validation, create, poll, cancel, 404', async () => {
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
  expect((await app.inject({ method: 'POST', url: '/api/proxmox/provisions/J1/cancel', headers })).json().status).toBe('cancelled');
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
