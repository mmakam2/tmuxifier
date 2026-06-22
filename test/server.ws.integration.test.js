import { test, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createSessionManager } from '../src/server/sessions.js';
import { hashPassword, COOKIE_NAME } from '../src/server/auth.js';
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
    `ws://127.0.0.1:${port}/term?box=${saved.id}&cid=t1&cols=80&rows=24`,
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
    `ws://127.0.0.1:${port}/term?box=${saved.id}&cid=t1&cols=80&rows=24`,
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

test('provision WS rolls back box on non-zero exit', async () => {
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

  // Box should have been rolled back
  const boxes = await store.listBoxes();
  expect(boxes.find((b) => b.id === saved.id)).toBeFalsy();
}, 10000);
