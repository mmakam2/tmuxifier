import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, templatesCalls;

async function build(configExtra = {}) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-pvr-'));
  templatesCalls = [];
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'), ...configExtra,
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  const proxmoxStore = {
    getHost: async () => ({ id: 'h1', endpoint: 'pve.example.com:8006', tokenId: 't@pam!x', tokenSecret: 's', verifyMode: 'insecure' }),
  };
  return buildServer({
    config, store: createStore({ dataDir: dir }), sessions, statusChecker, proxmoxStore,
    makeProxmoxClient: () => ({ templates: async (node, storage) => { templatesCalls.push([node, storage]); return []; } }),
  });
}

async function authed(a) {
  const res = await a.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

beforeEach(async () => { app = await build(); });

test('templates without ?storage is a 400, not a confusing upstream 502', async () => {
  const h = await authed(app);
  const res = await app.inject({ method: 'GET', url: '/api/proxmox/hosts/h1/nodes/n1/templates', headers: h });
  expect(res.statusCode).toBe(400);
  expect(templatesCalls).toHaveLength(0); // never reaches PVE with /storage/undefined/content
  const ok = await app.inject({ method: 'GET', url: '/api/proxmox/hosts/h1/nodes/n1/templates?storage=local', headers: h });
  expect(ok.statusCode).toBe(200);
  expect(templatesCalls).toEqual([['n1', 'local']]);
});

test('HSTS is sent whenever the session cookie is Secure (local TLS counts), not only for an https publicUrl', async () => {
  const secure = await build({ secureCookie: true });
  const res = await secure.inject({ method: 'GET', url: '/api/status' });
  expect(res.headers['strict-transport-security']).toContain('max-age');

  const plain = await build({ secureCookie: false });
  const res2 = await plain.inject({ method: 'GET', url: '/api/status' });
  expect(res2.headers['strict-transport-security']).toBeUndefined();
});
