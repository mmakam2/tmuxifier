import { test, expect } from 'vitest';
import path from 'node:path';
import { loadConfig, requiredConfigError } from '../src/server/config.js';

test('applies defaults', () => {
  const c = loadConfig({}, { env: {}, cwd: '/app' });
  expect(c.bindAddress).toBe('127.0.0.1');
  expect(c.port).toBe(7437);
  expect(c.graceSeconds).toBe(45);
  expect(c.hostKeyPolicy).toBe('accept-new');
  expect(c.dataDir).toBe(path.join('/app', 'data'));
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

test('statusPollMs has a default and is overridable via env (server-side poll cadence)', () => {
  expect(loadConfig({}, { env: {}, cwd: '/app' }).statusPollMs).toBe(30000);
  expect(loadConfig({}, { env: { TMUXIFIER_STATUS_POLL_MS: '15000' }, cwd: '/app' }).statusPollMs).toBe(15000);
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

test('fleet command knobs have defaults and are overridable via env', () => {
  const d = loadConfig({}, { env: {}, cwd: '/app' });
  expect(d.fleetConcurrency).toBe(4);
  expect(d.fleetTimeoutMs).toBe(15000);
  expect(d.fleetMaxJobs).toBe(50);
  expect(d.fleetMaxOutputBytes).toBe(65536);
  const e = loadConfig({}, {
    env: {
      TMUXIFIER_FLEET_CONCURRENCY: '8',
      TMUXIFIER_FLEET_TIMEOUT_MS: '30000',
      TMUXIFIER_FLEET_MAX_JOBS: '10',
      TMUXIFIER_FLEET_MAX_OUTPUT_BYTES: '1024',
    },
    cwd: '/app',
  });
  expect(e.fleetConcurrency).toBe(8);
  expect(e.fleetTimeoutMs).toBe(30000);
  expect(e.fleetMaxJobs).toBe(10);
  expect(e.fleetMaxOutputBytes).toBe(1024);
});

test('terminal font knobs: default size 12 and no custom family; env sets both', () => {
  const d = loadConfig({}, { env: {}, cwd: '/app' });
  expect(d.termFont).toBeUndefined();
  expect(d.termFontSize).toBe(12);
  const e = loadConfig({}, { env: { TMUXIFIER_TERM_FONT: 'JetBrains Mono', TMUXIFIER_TERM_FONT_SIZE: '14' }, cwd: '/app' });
  expect(e.termFont).toBe('JetBrains Mono');
  expect(e.termFontSize).toBe(14);
});

test('terminal font family rejects unsafe/empty values (falls back to bundled default)', () => {
  const font = (v) => loadConfig({}, { env: { TMUXIFIER_TERM_FONT: v }, cwd: '/app' }).termFont;
  expect(font("Foo'; }")).toBeUndefined();      // CSS-injection chars
  expect(font('Foo, Bar')).toBeUndefined();      // comma = multiple families
  expect(font('Foo"<script>')).toBeUndefined();
  expect(font('   ')).toBeUndefined();           // whitespace only
  expect(font('')).toBeUndefined();
  expect(font('  Fira Code  ')).toBe('Fira Code'); // trims a valid name
});

test('terminal font size out-of-range or non-numeric falls back to 12', () => {
  const sz = (v) => loadConfig({}, { env: { TMUXIFIER_TERM_FONT_SIZE: v }, cwd: '/app' }).termFontSize;
  expect(sz('4')).toBe(12);    // below min
  expect(sz('99')).toBe(12);   // above max
  expect(sz('abc')).toBe(12);  // non-numeric
  expect(sz('6')).toBe(6);     // min ok
  expect(sz('32')).toBe(32);   // max ok
});

test('health history knobs have defaults, override via env, and clamp', () => {
  const d = loadConfig({}, { env: {}, cwd: '/app' });
  expect(d.healthHistoryMax).toBe(120);
  expect(d.healthEventsMax).toBe(200);
  expect(d.healthCpuWarnPct).toBe(90);
  expect(d.healthMemWarnPct).toBe(90);
  expect(d.healthDiskWarnPct).toBe(90);
  expect(d.healthThresholdHysteresisPct).toBe(5);
  const e = loadConfig({}, {
    env: {
      TMUXIFIER_HEALTH_HISTORY_MAX: '60',
      TMUXIFIER_HEALTH_EVENTS_MAX: '50',
      TMUXIFIER_HEALTH_CPU_WARN_PCT: '80',
      TMUXIFIER_HEALTH_MEM_WARN_PCT: '85',
      TMUXIFIER_HEALTH_DISK_WARN_PCT: '95',
      TMUXIFIER_HEALTH_HYSTERESIS_PCT: '3',
    },
    cwd: '/app',
  });
  expect(e.healthHistoryMax).toBe(60);
  expect(e.healthEventsMax).toBe(50);
  expect(e.healthCpuWarnPct).toBe(80);
  expect(e.healthMemWarnPct).toBe(85);
  expect(e.healthDiskWarnPct).toBe(95);
  expect(e.healthThresholdHysteresisPct).toBe(3);
  // out-of-range values fall back to the default (clamped), not passed through
  const c = loadConfig({}, { env: { TMUXIFIER_HEALTH_HISTORY_MAX: '5', TMUXIFIER_HEALTH_CPU_WARN_PCT: '999' }, cwd: '/app' });
  expect(c.healthHistoryMax).toBe(120); // below the sane floor → default
  expect(c.healthCpuWarnPct).toBe(90);  // above 100 → default
});

test('proxmox knobs have defaults and are overridable via env', () => {
  const d = loadConfig({}, { env: {}, cwd: '/app' });
  expect(d.pvePollMs).toBe(1500);
  expect(d.pveTimeoutMs).toBe(15000);
  expect(d.pveProvisionTimeoutMs).toBe(600000);
  expect(d.pveLeaseTimeoutMs).toBe(60000);
  expect(d.pveMaxJobs).toBe(50);
  const e = loadConfig({}, { env: {
    TMUXIFIER_PVE_POLL_MS: '500', TMUXIFIER_PVE_TIMEOUT_MS: '9000',
    TMUXIFIER_PVE_PROVISION_TIMEOUT_MS: '120000', TMUXIFIER_PVE_LEASE_TIMEOUT_MS: '30000',
    TMUXIFIER_PVE_MAX_JOBS: '10', TMUXIFIER_PVE_DEFAULT_PUBKEY: '/keys/host.pub',
  }, cwd: '/app' });
  expect(e.pveDefaultPubKeyPath).toBe('/keys/host.pub');
  expect(e.pvePollMs).toBe(500);
  expect(e.pveTimeoutMs).toBe(9000);
  expect(e.pveProvisionTimeoutMs).toBe(120000);
  expect(e.pveLeaseTimeoutMs).toBe(30000);
  expect(e.pveMaxJobs).toBe(10);
});
