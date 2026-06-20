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
