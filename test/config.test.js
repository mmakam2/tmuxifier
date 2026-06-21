import { test, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, requiredConfigError } from '../src/server/config.js';

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

test('status concurrency and controlPersist have defaults and are overridable via env', () => {
  const d = loadConfig({}, { env: {}, cwd: '/app' });
  expect(d.statusConcurrency).toBe(4);   // probe a few boxes at a time, never the whole fleet at once
  expect(d.controlPersist).toBe(600);    // keep SSH masters warm so cold-connect bursts are rare
  const e = loadConfig({}, { env: { TMUXIFIER_STATUS_CONCURRENCY: '8', TMUXIFIER_CONTROL_PERSIST: '120' }, cwd: '/app' });
  expect(e.statusConcurrency).toBe(8);
  expect(e.controlPersist).toBe(120);
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

test('.env file in cwd configures the app and sits below shell env', async () => {
  const fs = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fs.mkdtempSync(pathMod.join(osMod.tmpdir(), 'tmuxifier-dotenv-'));
  fs.writeFileSync(pathMod.join(dir, '.env'), 'TMUXIFIER_PORT=8123\nTMUXIFIER_PASSWORD_HASH=fromdotenv\n');

  const fromFile = loadConfig({}, { env: {}, cwd: dir });
  expect(fromFile.port).toBe(8123);               // .env used with no shell env
  expect(fromFile.passwordHash).toBe('fromdotenv');

  const envWins = loadConfig({}, { env: { TMUXIFIER_PORT: '9999' }, cwd: dir });
  expect(envWins.port).toBe(9999);                // shell env beats .env
  expect(envWins.passwordHash).toBe('fromdotenv'); // unset shell key falls back to .env

  fs.rmSync(dir, { recursive: true, force: true });
});

test('.env overrides config.json (file precedence: config.json < .env < shell env)', async () => {
  const fs = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fs.mkdtempSync(pathMod.join(osMod.tmpdir(), 'tmuxifier-both-'));
  fs.writeFileSync(pathMod.join(dir, 'config.json'), JSON.stringify({ port: 5555 }));
  fs.writeFileSync(pathMod.join(dir, '.env'), 'TMUXIFIER_PORT=7777\n');
  const c = loadConfig({}, { env: {}, cwd: dir });
  expect(c.port).toBe(7777);                       // .env beat config.json
  fs.rmSync(dir, { recursive: true, force: true });
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

test('auth mode defaults to password; oauth/google are selectable; unknown falls back', () => {
  expect(loadConfig({}, { env: {}, cwd: '/app' }).authMode).toBe('password');
  expect(loadConfig({}, { env: { TMUXIFIER_AUTH_MODE: 'oauth' }, cwd: '/app' }).authMode).toBe('google');
  expect(loadConfig({}, { env: { TMUXIFIER_AUTH_MODE: 'google' }, cwd: '/app' }).authMode).toBe('google');
  expect(loadConfig({}, { env: { TMUXIFIER_AUTH_MODE: 'banana' }, cwd: '/app' }).authMode).toBe('password');
});

test('allowed emails parse to a trimmed, lowercased array', () => {
  const c = loadConfig({}, { env: { TMUXIFIER_ALLOWED_EMAILS: ' Alice@Example.com , bob@foo.com ,' }, cwd: '/app' });
  expect(c.allowedEmails).toEqual(['alice@example.com', 'bob@foo.com']);
  expect(loadConfig({}, { env: {}, cwd: '/app' }).allowedEmails).toEqual([]);
});

test('https public URL marks the cookie Secure even without local TLS', () => {
  const c = loadConfig({}, { env: { TMUXIFIER_BASE_EXTERNAL_URL: 'https://tmuxifier.example.com' }, cwd: '/app' });
  expect(c.publicUrl).toBe('https://tmuxifier.example.com');
  expect(c.secureCookie).toBe(true);
  const http = loadConfig({}, { env: { TMUXIFIER_PUBLIC_URL: 'http://insecure.example' }, cwd: '/app' });
  expect(http.secureCookie).toBe(false);
});

test('public URL without a scheme defaults to https', () => {
  const c = loadConfig({}, { env: { TMUXIFIER_BASE_EXTERNAL_URL: 'tmuxifier.example.com/' }, cwd: '/app' });
  expect(c.publicUrl).toBe('https://tmuxifier.example.com');
  expect(c.secureCookie).toBe(true);
});

test('legacy google oauth env names are still accepted', () => {
  const c = loadConfig({}, {
    env: {
      TMUXIFIER_PUBLIC_URL: 'legacy.example.com',
      TMUXIFIER_GOOGLE_CLIENT_ID: 'gid',
      TMUXIFIER_GOOGLE_CLIENT_SECRET: 'gsecret',
    },
    cwd: '/app',
  });
  expect(c.publicUrl).toBe('https://legacy.example.com');
  expect(c.googleClientId).toBe('gid');
  expect(c.googleClientSecret).toBe('gsecret');
});

test('generic oauth env names win over legacy google names', () => {
  const c = loadConfig({}, {
    env: {
      TMUXIFIER_BASE_EXTERNAL_URL: 'tmuxifier.example.com',
      TMUXIFIER_PUBLIC_URL: 'legacy.example.com',
      TMUXIFIER_OAUTH_CLIENT_ID: 'oid',
      TMUXIFIER_GOOGLE_CLIENT_ID: 'gid',
      TMUXIFIER_OAUTH_CLIENT_SECRET: 'osecret',
      TMUXIFIER_GOOGLE_CLIENT_SECRET: 'gsecret',
    },
    cwd: '/app',
  });
  expect(c.publicUrl).toBe('https://tmuxifier.example.com');
  expect(c.googleClientId).toBe('oid');
  expect(c.googleClientSecret).toBe('osecret');
});

test('requiredConfigError: password mode needs a hash', () => {
  expect(requiredConfigError({ authMode: 'password', cookieSecret: 's', passwordHash: 'h' })).toBeNull();
  expect(requiredConfigError({ authMode: 'password', cookieSecret: 's', passwordHash: '' }))
    .toMatch(/set-password/);
  expect(requiredConfigError({ authMode: 'password', cookieSecret: '' })).toMatch(/COOKIE_SECRET/);
});

test('localShell defaults to none and is configurable via config.json or overrides, not env', async () => {
  const c = loadConfig({}, { env: {}, cwd: '/app' });
  expect(c.localShell).toBe('none');
  expect(loadConfig({}, { env: { TMUXIFIER_LOCAL_SHELL: 'omz' }, cwd: '/app' }).localShell).toBe('none');

  const fs = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fs.mkdtempSync(pathMod.join(osMod.tmpdir(), 'tmuxifier-local-shell-'));
  fs.writeFileSync(pathMod.join(dir, 'config.json'), JSON.stringify({ localShell: 'omz' }));
  expect(loadConfig({}, { env: {}, cwd: dir }).localShell).toBe('omz');
  expect(loadConfig({ localShell: 'omb' }, { env: {}, cwd: dir }).localShell).toBe('omb');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('localShell invalid values are normalized to none', () => {
  expect(loadConfig({ localShell: 'zsh' }, { env: {}, cwd: '/app' }).localShell).toBe('none');
  expect(loadConfig({ localShell: 'bash' }, { env: {}, cwd: '/app' }).localShell).toBe('none');
  expect(loadConfig({ localShell: '' }, { env: {}, cwd: '/app' }).localShell).toBe('none');
  expect(loadConfig({ localShell: 'OMZ' }, { env: {}, cwd: '/app' }).localShell).toBe('none');
  // overrides arg should also be normalized
  expect(loadConfig({ localShell: 'invalid' }, { env: {}, cwd: '/app' }).localShell).toBe('none');
});

test('requiredConfigError: oauth mode lists every missing field', () => {
  const msg = requiredConfigError({ authMode: 'google', cookieSecret: 's', allowedEmails: [] });
  expect(msg).toMatch(/TMUXIFIER_OAUTH_CLIENT_ID/);
  expect(msg).toMatch(/TMUXIFIER_OAUTH_CLIENT_SECRET/);
  expect(msg).toMatch(/TMUXIFIER_BASE_EXTERNAL_URL/);
  expect(msg).toMatch(/TMUXIFIER_ALLOWED_EMAILS/);
  expect(requiredConfigError({
    authMode: 'google', cookieSecret: 's',
    googleClientId: 'a', googleClientSecret: 'b', publicUrl: 'https://x', allowedEmails: ['a@b.com'],
  })).toBeNull();
});
