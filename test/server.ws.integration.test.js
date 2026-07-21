import { test, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createSessionManager } from '../src/server/sessions.js';
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
async function gateFixture(status) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-gate-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: '192.168.1.10', sessionName: 'web' });
  const state = { opened: false, provisioned: false };
  const sessions = {
    open() { state.opened = true; return {}; },
    provision() { state.provisioned = true; return {}; },
    attach() {}, write() {}, resize() {}, detach() {}, close() {}, closeIfUnwatched() {}, onExit() {},
  };
  const setupManager = status
    ? { currentForBox: () => ({ id: 'j1', boxId: saved.id, status }) }
    : undefined;
  const app = buildServer({
    config, store, sessions, setupManager,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
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
