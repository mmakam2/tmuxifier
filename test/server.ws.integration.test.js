import { test, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createSessionManager, terminalKey, localKey } from '../src/server/sessions.js';
import { hashPassword, COOKIE_NAME } from '../src/server/auth.js';
import { resolveTools, buildEnsureTmuxRemote } from '../src/server/boxActions.js';
import { setupLocalBox } from './helpers/localBox.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

test('WS pipes input to the box and streams output back', async () => {
  const { box, session, env, sshConfigFile, cleanup } = await setupLocalBox();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-ws-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: box.host, sessionName: session });
  const sessions = createSessionManager({ graceSeconds: 5, spawnEnv: env, sshConfigFile });
  const app = buildServer({ config, store, sessions, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  teardown = async () => { await app.close(); await cleanup(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&cols=80&rows=24`,
    { headers: { cookie: `${c.name}=${c.value}` } },
  );
  const chunks = [];
  ws.on('message', (d) => chunks.push(d.toString()));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await delay(1200);
  ws.send(JSON.stringify({ t: 'i', d: 'echo TMUXIFIER_OK_123\n' }));
  await delay(1500);
  expect(chunks.join('')).toContain('TMUXIFIER_OK_123');
  ws.close();
}, 20000);

test('WS rejects authenticated cross-origin connections before opening a session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-ws-origin-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'), publicUrl: 'https://tmux.example.com',
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });
  let opened = false;
  const sessions = {
    open() { opened = true; throw new Error('should not open'); },
    attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {},
  };
  const app = buildServer({ config, store, sessions, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&cols=80&rows=24`,
    { headers: { cookie: `${c.name}=${c.value}`, origin: 'https://evil.example' } },
  );
  const code = await new Promise((resolve, reject) => {
    ws.on('close', resolve);
    ws.on('error', reject);
  });

  expect(code).toBe(1008);
  expect(opened).toBe(false);
}, 10000);

test('POST /api/boxes returns immediately without provisioning', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-post-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new',
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const app = buildServer({ config, store, sessions: null, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);

  const res = await app.inject({
    method: 'POST', url: '/api/boxes',
    headers: { cookie: `${c.name}=${c.value}` },
    payload: { host: 'example.com' },
  });
  expect(res.statusCode).toBe(201);
  const body = JSON.parse(res.body);
  expect(body.id).toBeTruthy();
  expect(body.host).toBe('example.com');
  // Box should exist in store immediately
  const boxes = await store.listBoxes();
  expect(boxes.find((b) => b.id === body.id)).toBeTruthy();
});

test('provision WS streams script output and sends exit frame on success', async () => {
  const { box, session, env, sshConfigFile, cleanup } = await setupLocalBox();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-prov-ws-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: box.host, sessionName: session });
  const sessions = createSessionManager({ graceSeconds: 5, spawnEnv: env, sshConfigFile });

  const app = buildServer({
    config, store, sessions,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    boxActions: {
      killSession: async () => ({ ok: true }),
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  teardown = async () => { await app.close(); await cleanup(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&mode=provision&cols=120&rows=40&ohMyTmux=0&ohMyZsh=0&ohMyBash=0`,
    { headers: { cookie: `${c.name}=${c.value}` } },
  );
  const chunks = [];
  let exitFrame = null;
  ws.on('message', (d) => {
    const raw = d.toString();
    try {
      const msg = JSON.parse(raw);
      if (msg.t === 'x') { exitFrame = msg; return; }
    } catch {}
    chunks.push(raw);
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  // Wait for completion
  await new Promise((resolve) => {
    const check = () => { if (exitFrame) resolve(undefined); else setTimeout(check, 100); };
    setTimeout(check, 100);
    setTimeout(() => resolve(undefined), 30000);
  });

  expect(exitFrame).toBeTruthy();
  expect(exitFrame.t).toBe('x');
  expect(exitFrame.code).toBe(0);
  // Script may produce terminal output (e.g., motd, script echo) or be silent
  // if tmux is already present — either is valid behavior
}, 45000);

test('provision WS keeps the box on non-zero exit (no auto-rollback)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-prov-rollback-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });

  // Mock sessions that simulates a failing provision
  const sessions = {
    provision({ key }) {
      const listeners = new Set();
      const exitCbs = new Set();
      const entry = {
        key, listeners, exitCbs, exited: false, exitCode: null,
        pty: { onData() {}, onExit() {}, kill() {}, resize() {} },
      };
      // Simulate failure: emit a bit of output then exit 1
      setTimeout(() => {
        for (const fn of listeners) {
          try { fn('Installing tmux...\n'); } catch {}
        }
      }, 10);
      setTimeout(() => {
        entry.exited = true;
        entry.exitCode = 1;
        for (const cb of exitCbs) cb();
      }, 20);
      return entry;
    },
    attach(entry, fn) { entry.listeners.add(fn); return () => entry.listeners.delete(fn); },
    onExit(entry, cb) { entry.exitCbs.add(cb); return () => entry.exitCbs.delete(cb); },
    write() {}, resize() {}, detach() {}, close() {},
  };

  const app = buildServer({
    config, store, sessions,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    boxActions: { killSession: async () => ({ ok: true }) },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&mode=provision&cols=80&rows=24&ohMyTmux=0&ohMyZsh=0&ohMyBash=0`,
    { headers: { cookie: `${c.name}=${c.value}` } },
  );
  let exitFrame = null;
  ws.on('message', (d) => {
    try { const msg = JSON.parse(d.toString()); if (msg.t === 'x') exitFrame = msg; } catch {}
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await new Promise((resolve) => {
    const check = () => { if (exitFrame) resolve(undefined); else setTimeout(check, 50); };
    setTimeout(check, 50);
  });

  expect(exitFrame).toBeTruthy();
  expect(exitFrame.code).toBe(1);

  // Box is kept even though setup failed: the interactive PTY is the setup
  // job's manual-finish path, and a failed setup must not delete the box
  // (the user retries or removes it explicitly from the UI).
  const boxes = await store.listBoxes();
  expect(boxes.find((b) => b.id === saved.id)).toBeTruthy();
}, 10000);

// Task 3: the provision WS accepts a `tools=` CSV query param and validates it
// against the curated catalog (resolveTools in boxActions.js) *before* ever
// building a script or opening a session — an unknown id must never reach the
// generated shell script.
test('provision WS closes 1008 "invalid tools" for an unknown tool id, before touching sessions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-prov-badtools-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });

  // If resolveTools ever let 'evil' through, this would blow up loudly instead
  // of silently opening an SSH/provision session.
  let provisionCalled = false;
  const sessions = {
    provision() { provisionCalled = true; throw new Error('sessions.provision must not be called for invalid tools'); },
    attach() {}, onExit() {}, write() {}, resize() {}, detach() {}, close() {},
  };

  const app = buildServer({
    config, store, sessions,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    boxActions: { killSession: async () => ({ ok: true }) },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&mode=provision&cols=80&rows=24&ohMyTmux=0&ohMyZsh=0&ohMyBash=0&tools=evil`,
    { headers: { cookie: `${c.name}=${c.value}` } },
  );
  let closeCode = null;
  let closeReason = '';
  await new Promise((resolve, reject) => {
    ws.on('close', (code, reason) => { closeCode = code; closeReason = reason?.toString() ?? ''; resolve(undefined); });
    ws.on('error', reject);
  });

  expect(closeCode).toBe(1008);
  expect(closeReason).toBe('invalid tools');
  expect(provisionCalled).toBe(false);

  // Box should be untouched — validation failed before anything else ran.
  const boxes = await store.listBoxes();
  expect(boxes.find((b) => b.id === saved.id)).toBeTruthy();
}, 10000);

// Minor #3: a repeated `tools=` query param parses to an ARRAY, not a string.
// The old handler coerced a non-string to '' (silently provisioning with no
// tools); it must instead fail closed the same way an unknown id does.
test('provision WS closes 1008 "invalid tools" for an array-typed tools param (repeated query), before touching sessions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-prov-arrtools-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });

  let provisionCalled = false;
  const sessions = {
    provision() { provisionCalled = true; throw new Error('sessions.provision must not be called for invalid tools'); },
    attach() {}, onExit() {}, write() {}, resize() {}, detach() {}, close() {},
  };

  const app = buildServer({
    config, store, sessions,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    boxActions: { killSession: async () => ({ ok: true }) },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);

  // tools=curl&tools=git => Fastify parses this to ['curl','git'] (an array).
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&mode=provision&cols=80&rows=24&ohMyTmux=0&ohMyZsh=0&ohMyBash=0&tools=curl&tools=git`,
    { headers: { cookie: `${c.name}=${c.value}` } },
  );
  let closeCode = null;
  let closeReason = '';
  await new Promise((resolve, reject) => {
    ws.on('close', (code, reason) => { closeCode = code; closeReason = reason?.toString() ?? ''; resolve(undefined); });
    ws.on('error', reject);
  });

  expect(closeCode).toBe(1008);
  expect(closeReason).toBe('invalid tools');
  expect(provisionCalled).toBe(false);

  // Box untouched — validation failed before anything else ran.
  const boxes = await store.listBoxes();
  expect(boxes.find((b) => b.id === saved.id)).toBeTruthy();
}, 10000);

test('provision WS accepts tools=curl: passes validation and builds the script with it resolved', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-prov-goodtools-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });

  // A stub sessions.provision — like the rollback test's — so this never needs
  // a live SSH box; it just needs to observe what the route hands it.
  let provisionArgs = null;
  const sessions = {
    provision(args) {
      provisionArgs = args;
      return {
        key: args.key, listeners: new Set(), exitCbs: new Set(), exited: false, exitCode: null,
        pty: { onData() {}, onExit() {}, kill() {}, resize() {} },
      };
    },
    attach(entry, fn) { entry.listeners.add(fn); return () => entry.listeners.delete(fn); },
    onExit(entry, cb) { entry.exitCbs.add(cb); return () => entry.exitCbs.delete(cb); },
    write() {}, resize() {}, detach() {}, close() {},
  };

  const app = buildServer({
    config, store, sessions,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    boxActions: { killSession: async () => ({ ok: true }) },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&mode=provision&cols=80&rows=24&ohMyTmux=0&ohMyZsh=0&ohMyBash=0&tools=curl`,
    { headers: { cookie: `${c.name}=${c.value}` } },
  );
  let closeCode = null;
  ws.on('close', (code) => { closeCode = code; });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await delay(300); // let the async route handler run past validation and call sessions.provision

  expect(closeCode).not.toBe(1008); // did not hit the "invalid tools" close path
  expect(provisionArgs).toBeTruthy(); // sessions.provision was reached — validation passed
  expect(provisionArgs.script).toBe(
    buildEnsureTmuxRemote(saved.sessionName, saved.startupCommand, {
      installOhMyTmux: false, installOhMyZsh: false, installOhMyBash: false,
      tools: resolveTools('curl'),
      // The interactive finish no longer creates the session: setupManager's
      // ensureSession step does, after any seeding, so the session's first
      // shell reads rc files that already carry the token.
      createSession: false,
    }),
  );
  expect(provisionArgs.script).not.toContain('new-session');

  ws.close();
}, 10000);

// L8: the manual cookie-header parse in isAuthed (needed for WS upgrades,
// where @fastify/websocket v10 leaves req.cookies empty) used to call
// decodeURIComponent unguarded — a malformed percent-encoding like %zz threw
// URIError, so the client got a connection reset (and an error log) instead of
// a clean unauthorized close.
test('WS with a malformed percent-encoded cookie gets a clean 1008, not a crash/reset', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-ws-badcookie-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });
  let opened = false;
  const sessions = {
    open() { opened = true; throw new Error('should not open'); },
    attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {},
  };
  const app = buildServer({ config, store, sessions, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&cols=80&rows=24`,
    { headers: { cookie: `${COOKIE_NAME}=%zz-not-valid-encoding` } },
  );
  const code = await new Promise((resolve, reject) => {
    ws.on('close', resolve);
    ws.on('error', reject); // a reset would land here and fail the test
  });
  expect(code).toBe(1008);
  expect(opened).toBe(false);
}, 10000);

// L9: a non-string input frame ({t:'i',d:123}) used to reach pty.write(123)
// and throw all the way to the global uncaughtException handler — a bare
// buildServer embed would have crashed. Bad frames are dropped; the session
// keeps working.
test('WS drops non-string input frames instead of throwing; session keeps working', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-ws-badframe-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });
  const writes = [];
  const entryStub = { key: saved.id, listeners: new Set(), exited: false };
  const sessions = {
    open: () => entryStub,
    attach: () => () => {},
    onExit: () => () => {},
    write: (entry, d) => {
      // The real pty.write throws on non-strings — mirror that so a leaked bad
      // frame fails this test the way it would crash production.
      if (typeof d !== 'string') throw new TypeError('pty.write: not a string');
      writes.push(d);
    },
    resize() {}, detach() {}, close() {},
  };
  const app = buildServer({ config, store, sessions, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&cols=80&rows=24`,
    { headers: { cookie: `${c.name}=${c.value}` } },
  );
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await delay(300); // let the async route handler attach its message listener
  ws.send(JSON.stringify({ t: 'i', d: 123 }));            // number payload
  ws.send(JSON.stringify({ t: 'i', d: { nested: true } })); // object payload
  ws.send(JSON.stringify({ t: 'r', c: 'wide', r: null })); // junk resize
  ws.send(JSON.stringify({ t: 'i', d: 'still alive\n' })); // then a real frame
  await delay(300);
  expect(ws.readyState).toBe(WebSocket.OPEN); // the socket survived the junk
  expect(writes).toEqual(['still alive\n']);
  ws.close();
}, 10000);

// Builds a server whose box has a setup job in the given status.
async function gateFixture(status, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-gate-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'), localShell: 'omz',
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: '192.168.1.10', sessionName: 'web' });
  const state = { opened: false, provisioned: false, openKeys: [], localKeys: [] };
  const sessions = {
    open({ key }) { state.opened = true; state.openKeys.push(key); return {}; },
    openLocal({ key }) { state.localKeys.push(key); return {}; },
    provision() { state.provisioned = true; return {}; },
    attach() {}, write() {}, resize() {}, detach() {}, close() {}, closeIfUnwatched() {}, onExit() {},
  };
  const setupManager = status
    ? { currentForBox: () => ({ id: 'j1', boxId: saved.id, status }) }
    : undefined;
  const app = buildServer({
    config, store, sessions, setupManager,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    ...extra,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };
  return { port, boxId: saved.id, cookie: `${c.name}=${c.value}`, state };
}

// Resolves { closed: code } or { open: true } — whichever happens first.
function raceOpenClose(url, cookie, ms = 500) {
  const ws = new WebSocket(url, { headers: { cookie } });
  return new Promise((resolve, reject) => {
    ws.on('close', (code) => resolve({ closed: code }));
    ws.on('open', () => setTimeout(() => { ws.close(); resolve({ open: true }); }, ms));
    ws.on('error', reject);
  });
}

test('/term refuses a box whose setup job is running', async () => {
  const { port, boxId, cookie, state } = await gateFixture('running');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/term?box=${boxId}&cols=80&rows=24`, { headers: { cookie } });
  const { code, reason } = await new Promise((resolve, reject) => {
    ws.on('close', (c, r) => resolve({ code: c, reason: r.toString() }));
    ws.on('error', reject);
  });
  expect(code).toBe(1008);
  expect(reason).toBe('setting up');
  expect(state.opened).toBe(false);
}, 10000);

test('/term connects once the setup job is done', async () => {
  const { port, boxId, cookie, state } = await gateFixture('done');
  const res = await raceOpenClose(`ws://127.0.0.1:${port}/term?box=${boxId}&cols=80&rows=24`, cookie);
  expect(res.open).toBe(true);
  expect(state.opened).toBe(true);
}, 10000);

test('/term provision mode is never gated, even while running', async () => {
  // The interactive finish is how a needs-interactive box gets unstuck. If the
  // gate is ever placed above the provision branch, this deadlocks.
  const { port, boxId, cookie, state } = await gateFixture('running');
  const res = await raceOpenClose(
    `ws://127.0.0.1:${port}/term?box=${boxId}&mode=provision&cols=80&rows=24&ohMyTmux=0&ohMyZsh=0&ohMyBash=0`,
    cookie,
  );
  expect(res.open).toBe(true);
  expect(state.provisioned).toBe(true);
}, 10000);

test('/term is ungated when no setupManager is wired', async () => {
  const { port, boxId, cookie, state } = await gateFixture(null);
  const res = await raceOpenClose(`ws://127.0.0.1:${port}/term?box=${boxId}&cols=80&rows=24`, cookie);
  expect(res.open).toBe(true);
  expect(state.opened).toBe(true);
}, 10000);

// One attach per viewer: the `client` param is what stops two machines from
// sharing a single screen at a single size, where whoever resized last won and
// every smaller viewer rendered cursor moves past its own last row/column.
test('/term opens a separate session per viewer id', async () => {
  const { port, boxId, cookie, state } = await gateFixture(null);
  await raceOpenClose(`ws://127.0.0.1:${port}/term?box=${boxId}&cols=80&rows=24&client=laptop`, cookie, 50);
  await raceOpenClose(`ws://127.0.0.1:${port}/term?box=${boxId}&cols=200&rows=50&client=desktop`, cookie, 50);

  expect(state.openKeys).toEqual([terminalKey(boxId, 'laptop'), terminalKey(boxId, 'desktop')]);
  expect(state.openKeys[0]).not.toBe(state.openKeys[1]);
}, 10000);

// One viewer reconnecting must land on its OWN key so the grace window hands
// back the same PTY rather than spawning a second ssh for the same browser.
test('/term reuses one viewer id across reconnects', async () => {
  const { port, boxId, cookie, state } = await gateFixture(null);
  await raceOpenClose(`ws://127.0.0.1:${port}/term?box=${boxId}&cols=80&rows=24&client=laptop`, cookie, 50);
  await raceOpenClose(`ws://127.0.0.1:${port}/term?box=${boxId}&cols=80&rows=24&client=laptop`, cookie, 50);

  expect(state.openKeys).toEqual([terminalKey(boxId, 'laptop'), terminalKey(boxId, 'laptop')]);
}, 10000);

// A cached bundle predating this sends no id. It must keep working, sharing one
// PTY exactly as it did before, rather than minting a fresh ssh per reconnect.
test('/term without a viewer id falls back to one shared session', async () => {
  const { port, boxId, cookie, state } = await gateFixture(null);
  await raceOpenClose(`ws://127.0.0.1:${port}/term?box=${boxId}&cols=80&rows=24`, cookie, 50);
  await raceOpenClose(`ws://127.0.0.1:${port}/term?box=${boxId}&cols=80&rows=24&client=has%20spaces`, cookie, 50);

  expect(state.openKeys).toEqual([terminalKey(boxId, 'shared'), terminalKey(boxId, 'shared')]);
}, 10000);

test('/term gives the host shell a session per viewer too', async () => {
  const { port, cookie, state } = await gateFixture(null);
  await raceOpenClose(`ws://127.0.0.1:${port}/term?box=__local__&cols=80&rows=24&client=laptop`, cookie, 50);
  await raceOpenClose(`ws://127.0.0.1:${port}/term?box=__local__&cols=80&rows=24&client=desktop`, cookie, 50);

  expect(state.localKeys).toEqual([localKey('laptop'), localKey('desktop')]);
}, 10000);

// The host shell's tmux server must be ensured into its own transient scope
// BEFORE the pty attaches — if the pty's new-session -A wins the race, the
// auto-started server lands in tmuxifier.service's cgroup and dies with the
// next restart (the very failure this seam exists to prevent).
test('/term host shell awaits the scoped-server ensure before opening the pty', async () => {
  const seq = [];
  const ctx = {};
  const localTmuxScope = {
    ensure: async (shell) => { seq.push(['ensure', shell, ctx.state.localKeys.length]); return { created: true }; },
  };
  const fixture = await gateFixture(null, { localTmuxScope });
  ctx.state = fixture.state;
  await raceOpenClose(`ws://127.0.0.1:${fixture.port}/term?box=__local__&cols=80&rows=24&client=laptop`, fixture.cookie, 50);

  // ensure ran once, saw the configured shell, and ran while no pty was open.
  expect(seq).toEqual([['ensure', 'omz', 0]]);
  expect(fixture.state.localKeys).toEqual([localKey('laptop')]);
}, 10000);

test('/term forwards a valid session override to sessions.open, default unchanged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-ws-sess-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });
  const opened = [];
  const sessions = {
    open(o) { opened.push(o); return {}; },
    attach() { return () => {}; }, onExit() { return () => {}; },
    write() {}, resize() {}, detach() {}, close() {},
  };
  const app = buildServer({ config, store, sessions, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  // A mirror of the file's own raceOpenClose helper (:541): the client's
  // 'open' event fires as soon as the WS upgrade completes, which races
  // ahead of the still-async server route handler reaching sessions.open().
  // A short pause after 'open' before closing lets that handler finish.
  const connect = (qs) => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term?box=${saved.id}&cols=80&rows=24&${qs}`,
      { headers: { cookie: `${c.name}=${c.value}` } });
    ws.on('open', () => setTimeout(() => { ws.close(); res(); }, 50));
    ws.on('error', rej);
  });

  await connect('client=dupA&session=altsess');
  await connect('client=dupB');
  expect(opened).toHaveLength(2);
  expect(opened[0].session).toBe('altsess');
  expect(opened[0].key).toBe(terminalKey(saved.id, 'dupA'));
  expect(opened[1].session).toBe('web');
}, 10000);

// CRITICAL regression guard: a pane-local session switch closes its WS with
// keepPane semantics — the server just sees an ordinary socket close — which
// arms sessions.js's grace window with the PTY still attached to the OLD
// session. The repaint then reopens a WS with the SAME viewer id and the NEW
// session. Before the fix, sessions.open() reused that live/grace-window
// entry unconditionally and the requested session was silently discarded, so
// the pane re-attached to the session it was trying to leave. This drives the
// REAL sessions.js (createSessionManager), not the fake `sessions` stub the
// neighboring tests use, with a fake node-pty `spawn` (mirrors
// test/sessions.test.js's fakePty) so the grace-window/reuse logic runs
// end-to-end through the WS route without needing a real sshd.
test('/term reopening the same viewer id with a different session spawns a fresh PTY targeting it, not the grace-window reuse', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-ws-sess-switch-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });

  const spawned = [];
  const fakeSpawn = (cmd, argv) => {
    let exitCb;
    spawned.push({ cmd, argv });
    return {
      cols: 80, rows: 24,
      onData: () => {},
      onExit: (cb) => { exitCb = cb; },
      write: () => {},
      resize: () => {},
      kill: () => { exitCb && exitCb({ exitCode: 0 }); },
    };
  };
  const sessions = createSessionManager({ graceSeconds: 5, spawn: fakeSpawn });
  const app = buildServer({ config, store, sessions, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  const cookie = `${c.name}=${c.value}`;

  // Same 50ms-after-open pattern as this file's own connect()/raceOpenClose
  // helpers: the client 'open' event races ahead of the still-async server
  // route handler reaching sessions.open().
  const connect = (qs) => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term?box=${saved.id}&cols=80&rows=24&${qs}`, { headers: { cookie } });
    ws.on('open', () => setTimeout(() => { ws.close(); res(); }, 50));
    ws.on('error', rej);
  });

  // Open key K with session "web", then close (server-side: detach -> grace).
  await connect('client=paneK&session=web');
  expect(spawned).toHaveLength(1);

  // Reopen the SAME key with a DIFFERENT session. Must NOT reuse the
  // grace-window entry: a fresh spawn must occur and its argv must target
  // the new session — the regression this fix closes.
  await connect('client=paneK&session=altsess');
  expect(spawned).toHaveLength(2);
  const lastArgv = spawned[1].argv;
  expect(lastArgv[lastArgv.length - 1]).toContain('-s altsess');

  // Reopening the same key with that SAME session again reuses — no further
  // spawn — preserving the existing grace-window reattach story.
  await connect('client=paneK&session=altsess');
  expect(spawned).toHaveLength(2);
}, 10000);

test('/term closes 1008 "invalid session" before opening a session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-ws-badsess-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });
  let openCalled = false;
  const sessions = {
    open() { openCalled = true; return {}; },
    attach() { return () => {}; }, onExit() { return () => {}; },
    write() {}, resize() {}, detach() {}, close() {},
  };
  const app = buildServer({ config, store, sessions, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&cols=80&rows=24&client=dupC&session=${encodeURIComponent('bad name')}`,
    { headers: { cookie: `${c.name}=${c.value}` } },
  );
  const code = await new Promise((resolve, reject) => { ws.on('close', resolve); ws.on('error', reject); });
  expect(code).toBe(1008);
  expect(openCalled).toBe(false);
}, 10000);

test('/term does not spawn or leak attached PTYs if the client disconnects during pre-open await (box, provision, and __local__)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-ws-race-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 60,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'), localShell: 'none',
  };
  const realStore = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await realStore.addBox({ host: '192.168.1.10', sessionName: 'web' });

  const pending = [];
  const pause = () => {
    let release;
    const wait = new Promise((r) => { release = r; });
    let resolveEntered;
    const entered = new Promise((r) => { resolveEntered = r; });
    const slot = { entered, release: () => release(), signalAndWait: async () => { resolveEntered(); await wait; } };
    pending.push(slot);
    return slot;
  };
  const gatedStore = {
    ...realStore,
    async getBox(id) {
      await pending[pending.length - 1].signalAndWait();
      return realStore.getBox(id);
    },
  };
  const localTmuxScope = {
    ensure: async () => {
      await pending[pending.length - 1].signalAndWait();
      return { created: false };
    },
  };

  const spawned = [];
  const sessions = createSessionManager({
    graceSeconds: 60,
    spawn: (cmd, argv) => {
      const pty = { cmd, argv, killed: false, onData() {}, onExit() {}, write() {}, resize() {}, kill() { pty.killed = true; } };
      spawned.push(pty);
      return pty;
    },
  });

  const app = buildServer({
    config, store: gatedStore, sessions, localTmuxScope,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  const cookie = `${c.name}=${c.value}`;

  for (const query of [
    `box=${saved.id}&cols=80&rows=24&client=raceTerm`,
    `box=${saved.id}&mode=provision&cols=80&rows=24&ohMyTmux=0&ohMyZsh=0&ohMyBash=0`,
    'box=__local__&cols=80&rows=24&client=raceLocal',
  ]) {
    const slot = pause();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term?${query}`, { headers: { cookie } });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    await slot.entered;
    ws.close();
    await new Promise((r) => ws.on('close', r));
    await delay(30);
    slot.release();
    await delay(30);
  }

  expect(spawned).toEqual([]);
  expect(sessions.hasLiveSessionForBox(saved.id)).toBe(false);
}, 10000);

// --- Release close (code 4000) -------------------------------------------------
// A pane the operator replaces on purpose closes its socket with the release
// code: that viewer's PTY goes at once instead of holding a tmux client (and so
// suppressing the session's agent notifications) for the grace window. Every
// other close keeps the grace window a reload or network drop relies on.

// Polls fn every 50 ms until it returns truthy; a throw counts as "not yet".
async function until(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let ok = false;
    try { ok = await fn(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`until: condition not met within ${ms} ms`);
    await delay(50);
  }
}

// Opens an authenticated /term socket and resolves once it is open (and, when
// `ready` is given, once that also holds — the server's handler is async, so a
// socket can be open before the handler has attached it).
function termOpener(port, cookie, ready) {
  return async (query) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term?${query}&cols=80&rows=24`, { headers: { cookie } });
    ws.chunks = [];
    ws.on('message', (d) => ws.chunks.push(d.toString()));
    const before = ready ? ready.count() : 0;
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    if (ready) await until(() => ready.count() > before);
    return ws;
  };
}

// Fake session manager that records how each socket's close was handled.
async function releaseFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-release-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'), localShell: 'omz',
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: '192.168.1.10', sessionName: 'web' });
  const entries = { open: { kind: 'terminal' }, local: { kind: 'local' }, provision: { kind: 'provision' } };
  const log = [];
  let attaches = 0;
  const sessions = {
    open() { return entries.open; },
    openLocal() { return entries.local; },
    provision() { return entries.provision; },
    attach() { attaches += 1; return () => {}; },
    onExit() { return () => {}; },
    write() {}, resize() {},
    detach(e) { log.push(['detach', e]); },
    closeIfUnwatched(e) { log.push(['release', e]); return true; },
    close(e) { log.push(['close', e]); },
  };
  const app = buildServer({ config, store, sessions, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };
  const openTerm = termOpener(port, `${c.name}=${c.value}`, { count: () => attaches });
  return { saved, log, entries, openTerm };
}

test('/term closed with the release code drops the PTY instead of starting the grace window', async () => {
  const { saved, log, entries, openTerm } = await releaseFixture();
  const ws = await openTerm(`box=${saved.id}&client=v1`);
  ws.close(4000, 'release');
  await until(() => log.length === 1);
  expect(log[0][0]).toBe('release');
  expect(log).toEqual([['release', entries.open]]);
}, 10000);

test('/term closed normally still detaches into the grace window', async () => {
  const { saved, log, entries, openTerm } = await releaseFixture();
  const ws = await openTerm(`box=${saved.id}&client=v1`);
  ws.close();
  await until(() => log.length === 1);
  await delay(100);
  expect(log).toEqual([['detach', entries.open]]);
}, 10000);

test('/term closed with a different application code still detaches', async () => {
  const { saved, log, entries, openTerm } = await releaseFixture();
  const ws = await openTerm(`box=${saved.id}&client=v1`);
  ws.close(4001, 'not release');
  await until(() => log.length === 1);
  expect(log).toEqual([['detach', entries.open]]);
}, 10000);

test('/term host shell honours the release code too', async () => {
  const { log, entries, openTerm } = await releaseFixture();
  const released = await openTerm('box=__local__&client=v1');
  released.close(4000, 'release');
  await until(() => log.length === 1);
  const plain = await openTerm('box=__local__&client=v1');
  plain.close();
  await until(() => log.length === 2);
  expect(log).toEqual([['release', entries.local], ['detach', entries.local]]);
}, 10000);

test('/term provision mode is untouched by the release code', async () => {
  const { saved, log, entries, openTerm } = await releaseFixture();
  const q = `box=${saved.id}&mode=provision&ohMyTmux=0&ohMyZsh=0&ohMyBash=0`;
  const released = await openTerm(q);
  released.close(4000, 'release');
  await until(() => log.length === 1);
  const plain = await openTerm(q);
  plain.close();
  await until(() => log.length === 2);
  await delay(100);
  // Provision already closes an unwatched entry on every close; the code changes nothing.
  expect(log).toEqual([['release', entries.provision], ['release', entries.provision]]);
}, 10000);

// Real session manager over the isolated sshd fixture, with the production grace window.
async function realReleaseFixture() {
  const { box, session, env, sshConfigFile, cleanup } = await setupLocalBox();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-release-real-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: box.host, sessionName: session });
  const sessions = createSessionManager({ graceSeconds: 45, spawnEnv: env, sshConfigFile });
  const app = buildServer({ config, store, sessions, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  teardown = async () => {
    sessions.closeGroup(saved.id);
    await app.close(); await cleanup(); await fs.rm(dir, { recursive: true, force: true });
  };
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  const listClients = () => execFileSync(
    'ssh', ['-F', sshConfigFile, box.host, `tmux list-clients -t '=${session}' -F x`],
    // stderr dropped: before the first attach the fixture's tmux server does not
    // exist yet, which until() treats as "not yet".
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
  return { saved, listClients, openTerm: termOpener(port, `${c.name}=${c.value}`) };
}

test('a release close detaches the tmux client at once; a plain close keeps it for the grace window', async () => {
  const { saved, listClients, openTerm } = await realReleaseFixture();
  const a = await openTerm(`box=${saved.id}&client=keep`);
  await until(() => listClients() === 'x', 8000);
  a.close();
  await delay(1500);
  expect(listClients()).toBe('x'); // still attached: grace window
  const b = await openTerm(`box=${saved.id}&client=keep`);
  await delay(500);
  b.close(4000, 'release');
  await until(() => listClients() === '', 5000); // gone well inside 45 s
}, 30000);

test('a release close leaves the PTY alone while a second socket on the same viewer key is attached', async () => {
  const { saved, listClients, openTerm } = await realReleaseFixture();
  const a = await openTerm(`box=${saved.id}&client=pair`);
  await until(() => listClients() === 'x', 8000);
  const b = await openTerm(`box=${saved.id}&client=pair`);
  await until(() => b.chunks.length > 0, 5000); // attached: the replay arrived
  a.close(4000, 'release');
  await new Promise((r) => a.on('close', r));
  await delay(500);
  expect(b.readyState).toBe(WebSocket.OPEN);
  b.chunks.length = 0;
  b.send(JSON.stringify({ t: 'i', d: 'echo STILL_HERE_$((40+2))\n' }));
  await until(() => b.chunks.join('').includes('STILL_HERE_42'), 5000);
  expect(listClients()).toBe('x');
  b.close();
}, 30000);
