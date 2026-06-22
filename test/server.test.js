import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { hashPassword } from '../src/server/auth.js';

let app;
let dir;

async function makeApp(overrides = {}) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-srv-'));
  const { config: configOverrides, ...serverOverrides } = overrides;
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
    localShell: 'none',
    configPath: path.join(dir, 'config.json'),
    ...configOverrides,
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const statusChecker = { checkBox: async () => ({ reachable: true, tmux: true, sessions: [] }) };
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
