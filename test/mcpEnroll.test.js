import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createDeviceStore } from '../src/server/deviceStore.js';
import { createPasskeyStore } from '../src/server/passkeyStore.js';
import { createPairingCodes } from '../src/server/pairingCodes.js';
import { hashPassword } from '../src/server/auth.js';
import { enroll, writeTokenFile, parseArgs } from '../scripts/mcp-enroll.js';

let app, dir, baseUrl;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-mcpenroll-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  app = buildServer({
    config, store: createStore({ dataDir: dir }), sessions,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    passkeyStore: createPasskeyStore({ dataDir: dir }), deviceStore: createDeviceStore({ dataDir: dir }),
    pairingCodes: createPairingCodes(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});
afterEach(async () => { await app.close(); });

async function cookie() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('enrolls with the password over real HTTP and the token authenticates', async () => {
  const r = await enroll({ baseUrl, password: 'pw' });
  expect(r.name).toBe('MCP orchestrator');
  expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const authed = await app.inject({ method: 'GET', url: '/api/boxes', headers: { authorization: `Bearer ${r.token}` } });
  expect(authed.statusCode).toBe(200);
});

test('enrolls with a pairing code minted by a browser session; the code is single-use', async () => {
  const { code } = (await app.inject({ method: 'POST', url: '/api/devices/pair', headers: await cookie() })).json();
  const r = await enroll({ baseUrl, code, name: 'orchestrator-2' });
  expect(r.name).toBe('orchestrator-2');
  await expect(enroll({ baseUrl, code })).rejects.toThrow(/enrollment refused: invalid or expired code/);
});

test('a wrong password is a readable refusal', async () => {
  await expect(enroll({ baseUrl, password: 'nope' })).rejects.toThrow(/enrollment refused: invalid/);
});

test('writeTokenFile lands an 0600 JSON file atomically', async () => {
  const file = path.join(dir, 'data', 'mcp-token.json');
  writeTokenFile(file, { id: 'd1', name: 'MCP orchestrator', token: 't', url: baseUrl });
  const stat = await fs.stat(file);
  expect(stat.mode & 0o777).toBe(0o600);
  const rec = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(rec).toMatchObject({ id: 'd1', token: 't', url: baseUrl });
  expect(typeof rec.enrolledAt).toBe('string');
  expect(await fs.readdir(path.dirname(file))).toEqual(['mcp-token.json']);
});

test('writeTokenFile cleans up its tmp file when the rename fails', async () => {
  const target = path.join(dir, 'data', 'mcp-token.json');
  await fs.mkdir(target, { recursive: true }); // a directory sits at the final path, so rename(tmp, target) fails
  expect(() => writeTokenFile(target, { id: 'd1', name: 'MCP orchestrator', token: 't', url: baseUrl })).toThrow();
  expect(await fs.readdir(path.dirname(target))).toEqual(['mcp-token.json']);
});

test('parseArgs reads code/name/url/insecure in both spellings', () => {
  expect(parseArgs(['--code', 'ABCD-EFGH', '--name=orch', '--url', 'https://t.example.com', '--insecure']))
    .toEqual({ code: 'ABCD-EFGH', name: 'orch', url: 'https://t.example.com', insecure: true, help: false });
  expect(parseArgs([])).toEqual({ insecure: false, help: false });
  expect(parseArgs(['-h']).help).toBe(true);
});

test('parseArgs rejects a flag with no value', () => {
  expect(() => parseArgs(['--code'])).toThrow(/--code needs a value/);
  expect(() => parseArgs(['--name', '--insecure'])).toThrow(/--name needs a value/);
});
