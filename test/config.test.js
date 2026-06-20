import { test, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/server/config.js';

test('applies defaults', () => {
  const c = loadConfig({}, { env: {}, cwd: '/app' });
  expect(c.bindAddress).toBe('127.0.0.1');
  expect(c.port).toBe(7437);
  expect(c.graceSeconds).toBe(45);
  expect(c.hostKeyPolicy).toBe('accept-new');
  expect(c.dataDir).toBe(path.join('/app', 'data'));
  expect(c.sshConfigPath).toBe(path.join(os.homedir(), '.ssh', 'config'));
  expect(c.controlDir).toBe(path.join('/app', 'data', 'cm'));
});

test('controlDir follows dataDir and is overridable via env', () => {
  const c = loadConfig({}, { env: { TMUXIFIER_DATA_DIR: '/tmp/d' }, cwd: '/app' });
  expect(c.controlDir).toBe(path.join('/tmp/d', 'cm'));
  const o = loadConfig({}, { env: { TMUXIFIER_CONTROL_DIR: '/tmp/sockets' }, cwd: '/app' });
  expect(o.controlDir).toBe('/tmp/sockets');
});

test('env overrides defaults; overrides arg wins over env', () => {
  const env = { TMUXIFIER_PORT: '9000', TMUXIFIER_HOSTKEY_POLICY: 'yes' };
  const c = loadConfig({ port: 1234 }, { env, cwd: '/app' });
  expect(c.port).toBe(1234);          // explicit override wins
  expect(c.hostKeyPolicy).toBe('yes'); // from env
});

test('maps TMUXIFIER_DATA_DIR and TMUXIFIER_SSH_CONFIG from env', () => {
  const c = loadConfig({}, { env: { TMUXIFIER_DATA_DIR: '/tmp/tmuxifierdata', TMUXIFIER_SSH_CONFIG: '/tmp/sshcfg' }, cwd: '/app' });
  expect(c.dataDir).toBe('/tmp/tmuxifierdata');
  expect(c.sshConfigFile).toBe('/tmp/sshcfg');
});

test('TLS cert+key enable https and a Secure cookie', () => {
  const c = loadConfig({}, { env: { TMUXIFIER_TLS_CERT: '/c/cert.pem', TMUXIFIER_TLS_KEY: '/c/key.pem' }, cwd: '/app' });
  expect(c.tlsCert).toBe('/c/cert.pem');
  expect(c.tlsKey).toBe('/c/key.pem');
  expect(c.secureCookie).toBe(true);
});

test('no TLS configured -> secureCookie is false', () => {
  const c = loadConfig({}, { env: {}, cwd: '/app' });
  expect(c.secureCookie).toBe(false);
});

test('config.json overrides defaults and sits below env', async () => {
  const fs = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fs.mkdtempSync(pathMod.join(osMod.tmpdir(), 'tmuxifier-cfg-'));
  fs.writeFileSync(pathMod.join(dir, 'config.json'), JSON.stringify({ port: 5555, hostKeyPolicy: 'yes' }));
  const fromFile = loadConfig({}, { env: {}, cwd: dir });
  expect(fromFile.port).toBe(5555);                 // file overrode default
  const envWins = loadConfig({}, { env: { TMUXIFIER_PORT: '6666' }, cwd: dir });
  expect(envWins.port).toBe(6666);                  // env beats file
  fs.rmSync(dir, { recursive: true, force: true });
});
