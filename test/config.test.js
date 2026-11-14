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
  expect(loadConfig({}, { env: { TMUXIFIER_AUTH_MODE: 'oauth' }, cwd: '/app' }).authMode).toBe('oidc');
  expect(loadConfig({}, { env: { TMUXIFIER_AUTH_MODE: 'google' }, cwd: '/app' }).authMode).toBe('oidc');
  expect(loadConfig({}, { env: { TMUXIFIER_AUTH_MODE: 'oidc' }, cwd: '/app' }).authMode).toBe('oidc');
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

const GOOGLE_PROVIDER = { id: 'google', label: 'Google', issuer: 'https://accounts.google.com', clientId: 'cid', clientSecret: 'sec', allowUnverifiedEmail: false, legacyGoogle: true, allowedEmails: [] };

async function oidcCfg(env, fileCfg) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-oidc-'));
  try {
    if (fileCfg) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(fileCfg));
    return loadConfig({}, { env: { TMUXIFIER_AUTH_MODE: 'oidc', ...env }, cwd: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('legacy Google keys build the implicit provider (env oauth, env google, config.json)', async () => {
  const a = await oidcCfg({ TMUXIFIER_AUTH_MODE: 'oauth', TMUXIFIER_OAUTH_CLIENT_ID: 'cid', TMUXIFIER_OAUTH_CLIENT_SECRET: 'sec' });
  expect(a.oidcProviders).toEqual([GOOGLE_PROVIDER]);
  const b = await oidcCfg({ TMUXIFIER_GOOGLE_CLIENT_ID: 'cid', TMUXIFIER_GOOGLE_CLIENT_SECRET: 'sec' });
  expect(b.oidcProviders).toEqual([GOOGLE_PROVIDER]);
  const c = await oidcCfg({}, { googleClientId: 'cid', googleClientSecret: 'sec' });
  expect(c.oidcProviders).toEqual([GOOGLE_PROVIDER]);
});

test('password mode has no OIDC providers', async () => {
  const c = await oidcCfg({ TMUXIFIER_AUTH_MODE: 'password', TMUXIFIER_OAUTH_CLIENT_ID: 'cid', TMUXIFIER_OAUTH_CLIENT_SECRET: 'sec' });
  expect(c.oidcProviders).toEqual([]);
  expect(c.oidcConfigWarnings).toEqual([]);
});

test('env provider list builds providers from TMUXIFIER_OIDC_<ID>_* keys', async () => {
  const issuer = 'https://auth.example.com/application/o/tmuxifier/';
  const c = await oidcCfg({
    TMUXIFIER_OIDC_PROVIDERS: 'authentik',
    TMUXIFIER_OIDC_AUTHENTIK_ISSUER: issuer,
    TMUXIFIER_OIDC_AUTHENTIK_CLIENT_ID: 'a',
    TMUXIFIER_OIDC_AUTHENTIK_CLIENT_SECRET: 'b',
    TMUXIFIER_OIDC_AUTHENTIK_LABEL: 'authentik',
    TMUXIFIER_OIDC_AUTHENTIK_ALLOW_UNVERIFIED_EMAIL: 'on',
  });
  expect(c.oidcProviders).toEqual([{ id: 'authentik', label: 'authentik', issuer, clientId: 'a', clientSecret: 'b', allowUnverifiedEmail: true, legacyGoogle: false, allowedEmails: [] }]);
});

test('config.json providers merge with per-field env overrides; label defaults to id', async () => {
  const issuer = 'https://auth.example.com/application/o/tmuxifier/';
  const c = await oidcCfg(
    { TMUXIFIER_OIDC_AUTHENTIK_CLIENT_SECRET: 'override' },
    { oidcProviders: [{ id: 'authentik', issuer, clientId: 'a', clientSecret: 'file' }] },
  );
  expect(c.oidcProviders).toEqual([{ id: 'authentik', label: 'authentik', issuer, clientId: 'a', clientSecret: 'override', allowUnverifiedEmail: false, legacyGoogle: false, allowedEmails: [] }]);
});

test('a set env list defines the providers; file-only entries are dropped with a warning', async () => {
  const issuer = 'https://auth.example.com/';
  const c = await oidcCfg(
    { TMUXIFIER_OIDC_PROVIDERS: 'a,b', TMUXIFIER_OIDC_A_ISSUER: issuer, TMUXIFIER_OIDC_A_CLIENT_ID: 'x', TMUXIFIER_OIDC_A_CLIENT_SECRET: 'y' },
    { oidcProviders: [{ id: 'b', issuer, clientId: 'bx', clientSecret: 'by' }, { id: 'c', issuer, clientId: 'cx', clientSecret: 'cy' }] },
  );
  expect(c.oidcProviders.map((p) => p.id)).toEqual(['a', 'b']);
  expect(c.oidcProviders[1].clientId).toBe('bx');
  expect(c.oidcConfigWarnings.join('\n')).toMatch(/"c"/);
});

test('explicit google provider wins over legacy keys, with a warning', async () => {
  const c = await oidcCfg({
    TMUXIFIER_OIDC_PROVIDERS: 'google',
    TMUXIFIER_OIDC_GOOGLE_ISSUER: 'https://accounts.google.com',
    TMUXIFIER_OIDC_GOOGLE_CLIENT_ID: 'new',
    TMUXIFIER_OIDC_GOOGLE_CLIENT_SECRET: 'newsec',
    TMUXIFIER_OAUTH_CLIENT_ID: 'cid',
    TMUXIFIER_OAUTH_CLIENT_SECRET: 'sec',
  });
  expect(c.oidcProviders).toHaveLength(1);
  expect(c.oidcProviders[0]).toMatchObject({ id: 'google', clientId: 'new', legacyGoogle: false });
  expect(c.oidcConfigWarnings.join('\n')).toMatch(/legacy/i);
});

test('requiredConfigError validates OIDC mode', () => {
  const ok = { id: 'authentik', label: 'authentik', issuer: 'https://auth.example.com/', clientId: 'a', clientSecret: 'b', allowUnverifiedEmail: false, legacyGoogle: false, allowedEmails: ['you@example.com'] };
  const base = { authMode: 'oidc', cookieSecret: 's', publicUrl: 'https://x.example.com', oidcProviders: [ok] };
  expect(requiredConfigError(base)).toBeNull();
  expect(requiredConfigError({ ...base, oidcProviders: [] })).toMatch(/provider/);
  expect(requiredConfigError({ ...base, oidcProviders: [{ ...ok, id: 'Auth!' }] })).toMatch(/Auth!/);
  expect(requiredConfigError({ ...base, oidcProviders: [ok, ok] })).toMatch(/more than once/);
  expect(requiredConfigError({ ...base, oidcProviders: [{ ...ok, issuer: 'http://auth.example.com' }] })).toMatch(/https/);
  expect(requiredConfigError({ ...base, oidcProviders: [{ ...ok, issuer: 'http://127.0.0.1:9999/' }] })).toBeNull();
  expect(requiredConfigError({ ...base, oidcProviders: [{ ...ok, clientSecret: '' }] })).toMatch(/secret/);
  expect(requiredConfigError({ ...base, oidcProviders: [{ ...ok, allowedEmails: [] }] })).toBe('OIDC provider "authentik" has no allowed emails: set TMUXIFIER_OIDC_AUTHENTIK_ALLOWED_EMAILS or TMUXIFIER_ALLOWED_EMAILS');
  const two = [ok, { ...ok, id: 'other', allowedEmails: [] }];
  expect(requiredConfigError({ ...base, oidcProviders: two })).toMatch(/"other" has no allowed emails/);
  expect(requiredConfigError({ ...base, publicUrl: '' })).toMatch(/TMUXIFIER_BASE_EXTERNAL_URL/);
  expect(requiredConfigError({ ...base, cookieSecret: '' })).toMatch(/COOKIE_SECRET/);
  expect(requiredConfigError({ authMode: 'password', cookieSecret: 's', passwordHash: 'h' })).toBeNull();
});

const P = (id) => `TMUXIFIER_OIDC_${id}_`;
const provEnv = (id, extra = {}) => ({
  [`${P(id)}ISSUER`]: 'https://auth.example.com/', [`${P(id)}CLIENT_ID`]: 'x', [`${P(id)}CLIENT_SECRET`]: 'y', ...extra,
});

test('per-provider allowed emails: own list from env replaces the global list', async () => {
  const c = await oidcCfg({ TMUXIFIER_OIDC_PROVIDERS: 'my-idp', TMUXIFIER_ALLOWED_EMAILS: 'g@example.com', ...provEnv('MY_IDP', { TMUXIFIER_OIDC_MY_IDP_ALLOWED_EMAILS: ' A@Example.com, b@example.com,' }) });
  expect(c.oidcProviders[0].allowedEmails).toEqual(['a@example.com', 'b@example.com']);
});

test('per-provider allowed emails: config.json array and string; env overrides file', async () => {
  const issuer = 'https://auth.example.com/';
  const file = { oidcProviders: [
    { id: 'a', issuer, clientId: 'x', clientSecret: 'y', allowedEmails: ['A@example.com', 'a2@example.com'] },
    { id: 'b', issuer, clientId: 'x', clientSecret: 'y', allowedEmails: 'B@example.com, b2@example.com' },
  ] };
  const c = await oidcCfg({}, file);
  expect(c.oidcProviders[0].allowedEmails).toEqual(['a@example.com', 'a2@example.com']);
  expect(c.oidcProviders[1].allowedEmails).toEqual(['b@example.com', 'b2@example.com']);
  const o = await oidcCfg({ TMUXIFIER_OIDC_A_ALLOWED_EMAILS: 'env@example.com' }, file);
  expect(o.oidcProviders[0].allowedEmails).toEqual(['env@example.com']);
});

test('per-provider allowed emails: falls back to the global list', async () => {
  const c = await oidcCfg({ TMUXIFIER_OIDC_PROVIDERS: 'a', TMUXIFIER_ALLOWED_EMAILS: 'G@example.com', ...provEnv('A') });
  expect(c.oidcProviders[0].allowedEmails).toEqual(['g@example.com']);
});

test('legacy Google provider always uses the global list; an explicit google provider reads its own key', async () => {
  const legacy = await oidcCfg({ TMUXIFIER_OAUTH_CLIENT_ID: 'cid', TMUXIFIER_OAUTH_CLIENT_SECRET: 'sec', TMUXIFIER_ALLOWED_EMAILS: 'g@example.com', TMUXIFIER_OIDC_GOOGLE_ALLOWED_EMAILS: 'own@example.com' });
  expect(legacy.oidcProviders[0]).toMatchObject({ legacyGoogle: true, allowedEmails: ['g@example.com'] });
  const explicit = await oidcCfg({ TMUXIFIER_OIDC_PROVIDERS: 'google', TMUXIFIER_ALLOWED_EMAILS: 'g@example.com', ...provEnv('GOOGLE', { TMUXIFIER_OIDC_GOOGLE_ALLOWED_EMAILS: 'own@example.com' }) });
  expect(explicit.oidcProviders[0]).toMatchObject({ legacyGoogle: false, allowedEmails: ['own@example.com'] });
});

test('empty global list is fine when every provider has its own; otherwise names the provider', async () => {
  const ok = await oidcCfg({ TMUXIFIER_OIDC_PROVIDERS: 'a,b', TMUXIFIER_BASE_EXTERNAL_URL: 'https://x.example.com', TMUXIFIER_COOKIE_SECRET: 's', ...provEnv('A', { TMUXIFIER_OIDC_A_ALLOWED_EMAILS: 'a@example.com' }), ...provEnv('B', { TMUXIFIER_OIDC_B_ALLOWED_EMAILS: 'b@example.com' }) });
  expect(requiredConfigError(ok)).toBeNull();
  const bad = await oidcCfg({ TMUXIFIER_OIDC_PROVIDERS: 'a,b', TMUXIFIER_BASE_EXTERNAL_URL: 'https://x.example.com', TMUXIFIER_COOKIE_SECRET: 's', ...provEnv('A', { TMUXIFIER_OIDC_A_ALLOWED_EMAILS: 'a@example.com' }), ...provEnv('B') });
  expect(requiredConfigError(bad)).toMatch(/provider "b" has no allowed emails.*TMUXIFIER_OIDC_B_ALLOWED_EMAILS/);
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

// trustProxy: off unless explicitly configured (trusting X-Forwarded-For from a
// non-proxy would let clients spoof the ip that login rate limiting buckets by).
test('trustProxy defaults off and normalizes env values', () => {
  expect(loadConfig({}, { env: {}, cwd: '/app' }).trustProxy).toBeUndefined();
  expect(loadConfig({}, { env: { TMUXIFIER_TRUST_PROXY: 'true' }, cwd: '/app' }).trustProxy).toBe(true);
  expect(loadConfig({}, { env: { TMUXIFIER_TRUST_PROXY: 'false' }, cwd: '/app' }).trustProxy).toBeUndefined();
  expect(loadConfig({}, { env: { TMUXIFIER_TRUST_PROXY: '' }, cwd: '/app' }).trustProxy).toBeUndefined();
  expect(loadConfig({}, { env: { TMUXIFIER_TRUST_PROXY: '1' }, cwd: '/app' }).trustProxy).toBe(1); // hop count
  expect(loadConfig({}, { env: { TMUXIFIER_TRUST_PROXY: '127.0.0.1,10.0.0.0/8' }, cwd: '/app' }).trustProxy).toBe('127.0.0.1,10.0.0.0/8');
});

test('trustProxy accepts a boolean from config.json / overrides', () => {
  expect(loadConfig({ trustProxy: true }, { env: {}, cwd: '/app' }).trustProxy).toBe(true);
  expect(loadConfig({ trustProxy: false }, { env: {}, cwd: '/app' }).trustProxy).toBeUndefined();
});

// Every numeric knob is clamped: a typo'd value (TMUXIFIER_PORT=7437x -> NaN)
// or a pathological zero (TMUXIFIER_STATUS_POLL_MS=0 -> hot probe loop) falls
// back to the default instead of passing through.
test('invalid numeric env values fall back to defaults (no NaN port, no 0ms hot loop)', () => {
  const c = loadConfig({}, {
    env: {
      TMUXIFIER_PORT: '7437x',
      TMUXIFIER_STATUS_POLL_MS: '0',
      TMUXIFIER_GRACE: 'soon',
      TMUXIFIER_STATUS_CONCURRENCY: '-3',
      TMUXIFIER_FLEET_TIMEOUT_MS: 'NaN',
      TMUXIFIER_PVE_POLL_MS: '0',
    },
    cwd: '/app',
  });
  expect(c.port).toBe(7437);
  expect(c.statusPollMs).toBe(30000);
  expect(c.graceSeconds).toBe(45);
  expect(c.statusConcurrency).toBe(4);
  expect(c.fleetTimeoutMs).toBe(15000);
  expect(c.pvePollMs).toBe(1500);
});

test('out-of-range numeric env values fall back to defaults', () => {
  const c = loadConfig({}, {
    env: { TMUXIFIER_PORT: '99999', TMUXIFIER_FLEET_CONCURRENCY: '0', TMUXIFIER_FLEET_MAX_JOBS: '-1' },
    cwd: '/app',
  });
  expect(c.port).toBe(7437);
  expect(c.fleetConcurrency).toBe(4);
  expect(c.fleetMaxJobs).toBe(50);
});

test('valid numeric env values still pass through the clamps', () => {
  const c = loadConfig({}, {
    env: {
      TMUXIFIER_PORT: '7438',
      TMUXIFIER_STATUS_POLL_MS: '2000',   // the e2e suite runs at this cadence
      TMUXIFIER_GRACE: '0',               // 0 grace is a legitimate choice
      TMUXIFIER_CONTROL_PERSIST: '0',     // ssh ControlPersist=0 is valid (keep forever)
      TMUXIFIER_FLEET_MAX_OUTPUT_BYTES: '4096',
    },
    cwd: '/app',
  });
  expect(c.port).toBe(7438);
  expect(c.statusPollMs).toBe(2000);
  expect(c.graceSeconds).toBe(0);
  expect(c.controlPersist).toBe(0);
  expect(c.fleetMaxOutputBytes).toBe(4096);
});

test('uploadMaxMb defaults to 25 and derives uploadMaxBytes', () => {
  const c = loadConfig({}, { env: {}, cwd: '/app' });
  expect(c.uploadMaxMb).toBe(25);
  expect(c.uploadMaxBytes).toBe(25 * 1024 * 1024);
});

test('TMUXIFIER_UPLOAD_MAX_MB overrides and clamps the upload limit', () => {
  const mb = (v) => loadConfig({}, { env: { TMUXIFIER_UPLOAD_MAX_MB: v }, cwd: '/app' }).uploadMaxMb;
  expect(mb('100')).toBe(100);
  expect(loadConfig({}, { env: { TMUXIFIER_UPLOAD_MAX_MB: '100' }, cwd: '/app' }).uploadMaxBytes).toBe(100 * 1024 * 1024);
  expect(mb('0')).toBe(25);      // pathological zero -> default
  expect(mb('9999')).toBe(25);   // out of range -> default
  expect(mb('abc')).toBe(25);    // non-numeric -> default
});

test('claudeOauthToken comes from TMUXIFIER_CLAUDE_OAUTH_TOKEN, trimmed', () => {
  const cfg = loadConfig({}, { env: { TMUXIFIER_CLAUDE_OAUTH_TOKEN: '  sk-ant-oat-EXAMPLE  ' }, cwd: '/nonexistent' });
  expect(cfg.claudeOauthToken).toBe('sk-ant-oat-EXAMPLE');
});

test('claudeOauthToken defaults to null and empty string stays null', () => {
  expect(loadConfig({}, { env: {}, cwd: '/nonexistent' }).claudeOauthToken).toBe(null);
  expect(loadConfig({}, { env: { TMUXIFIER_CLAUDE_OAUTH_TOKEN: '   ' }, cwd: '/nonexistent' }).claudeOauthToken).toBe(null);
});

test('the removed agentIdleSec knob is gone: env var is ignored, no key in the config', () => {
  // Hook-only agent state (2026-08-01): the output-idle heuristic and its
  // threshold are removed; a leftover TMUXIFIER_AGENT_IDLE_SEC in an operator's
  // .env must be silently inert, not an error and not a resurrected key.
  expect(loadConfig({}, { env: {}, cwd: '/nonexistent' }).agentIdleSec).toBeUndefined();
  expect(loadConfig({}, { env: { TMUXIFIER_AGENT_IDLE_SEC: '90' }, cwd: '/nonexistent' }).agentIdleSec).toBeUndefined();
});

test('rpId derives from the base external URL hostname', () => {
  const c = loadConfig({}, { env: { TMUXIFIER_BASE_EXTERNAL_URL: 'https://tmux.example.com' }, cwd: '/app' });
  expect(c.rpId).toBe('tmux.example.com');
  expect(c.rpIdError).toBeNull();
});

test('an explicit TMUXIFIER_RP_ID wins over the derived hostname', () => {
  const c = loadConfig({}, { env: { TMUXIFIER_BASE_EXTERNAL_URL: 'https://tmux.example.com', TMUXIFIER_RP_ID: 'Example.COM' }, cwd: '/app' });
  expect(c.rpId).toBe('example.com');
});

test('rpId falls back to localhost with no external URL', () => {
  expect(loadConfig({}, { env: {}, cwd: '/app' }).rpId).toBe('localhost');
});

// An IP-addressed deployment works today with password/Google sign-in. Passkeys
// are simply unavailable there; refusing to boot would be a regression.
test('an IP-derived rpId disables passkeys without failing configuration', () => {
  const c = loadConfig({}, { env: {
    TMUXIFIER_BASE_EXTERNAL_URL: 'https://192.168.1.10:7437',
    TMUXIFIER_COOKIE_SECRET: 's', TMUXIFIER_PASSWORD_HASH: 'h',
  }, cwd: '/app' });
  expect(c.rpId).toBeNull();
  expect(c.rpIdError).toBeNull();
  expect(requiredConfigError(c)).toBeNull();
});

// An explicit value is a stated intent that cannot work — fail loudly.
test('an explicit IP TMUXIFIER_RP_ID is a configuration error', () => {
  const c = loadConfig({}, { env: {
    TMUXIFIER_RP_ID: '192.168.1.10',
    TMUXIFIER_COOKIE_SECRET: 's', TMUXIFIER_PASSWORD_HASH: 'h',
  }, cwd: '/app' });
  expect(c.rpId).toBeNull();
  expect(c.rpIdError).toMatch(/domain name/);
  expect(requiredConfigError(c)).toMatch(/domain name/);
});

test('TMUXIFIER_PASSKEY_ONLY=off arms the break-glass kill switch', () => {
  expect(loadConfig({}, { env: {}, cwd: '/app' }).passkeyOnlyKillSwitch).toBe(false);
  expect(loadConfig({}, { env: { TMUXIFIER_PASSKEY_ONLY: 'off' }, cwd: '/app' }).passkeyOnlyKillSwitch).toBe(true);
});

// config.json is a documented camelCase alternative to .env (see README.md) and passes
// values through raw, so passkeyOnlyKillSwitch can arrive as a real boolean rather than a
// string. A naive `/^(off|0|no|false)$/.test(String(v))` inverts both booleans: String(true)
// doesn't match -> false (kill switch silently refuses to arm), and String(false) matches
// "false" -> true (kill switch silently engages when the operator explicitly wrote false).
// Same shape as the trustProxy boolean test above; overrides sit at the same merge point a
// real config.json value would.
test('passkeyOnlyKillSwitch accepts a real boolean from config.json / overrides without inverting it', () => {
  expect(loadConfig({ passkeyOnlyKillSwitch: true }, { env: {}, cwd: '/app' }).passkeyOnlyKillSwitch).toBe(true);
  expect(loadConfig({ passkeyOnlyKillSwitch: false }, { env: {}, cwd: '/app' }).passkeyOnlyKillSwitch).toBe(false);
});

test('voice is off by default', () => {
  const c = loadConfig({}, { env: {}, cwd: '/repo' });
  expect(c.voiceEnabled).toBe(false);
  expect(c.voiceIdleMs).toBe(600000);
  expect(c.voiceMaxSeconds).toBe(120);
  expect(c.voiceMaxBytes).toBe(8 * 1024 * 1024);
});

test('voice turns on when a binary and model are configured', () => {
  const c = loadConfig({}, {
    env: { TMUXIFIER_WHISPER_BIN: '/repo/vendor/whisper/build/bin/whisper-server',
           TMUXIFIER_WHISPER_MODEL: '/repo/vendor/whisper/models/ggml-small.en.bin' },
    cwd: '/repo',
  });
  expect(c.voiceEnabled).toBe(true);
  expect(c.whisperBin).toBe('/repo/vendor/whisper/build/bin/whisper-server');
});

test('TMUXIFIER_VOICE=off is a hard kill switch', () => {
  const c = loadConfig({}, {
    env: { TMUXIFIER_VOICE: 'off',
           TMUXIFIER_WHISPER_BIN: '/repo/vendor/whisper/build/bin/whisper-server',
           TMUXIFIER_WHISPER_MODEL: '/repo/vendor/whisper/models/ggml-small.en.bin' },
    cwd: '/repo',
  });
  expect(c.voiceEnabled).toBe(false);
});

test('voice stays off when only one of binary and model is set', () => {
  const only = (env) => loadConfig({}, { env, cwd: '/repo' }).voiceEnabled;
  expect(only({ TMUXIFIER_WHISPER_BIN: '/x/whisper-server' })).toBe(false);
  expect(only({ TMUXIFIER_WHISPER_MODEL: '/x/model.bin' })).toBe(false);
});

// clampInt in this file rejects an out-of-range value and falls back to the
// DEFAULT — it does not clamp to the nearest bound (see uploadMaxMb's own
// test above: out-of-range 9999 -> default 25, not clamped to 1024). All
// three inputs here are out of range, so all three land on their defaults.
test('voice limits are clamped to sane ranges', () => {
  const c = loadConfig({}, {
    env: { TMUXIFIER_VOICE_MAX_MB: '9999', TMUXIFIER_VOICE_MAX_SECONDS: '0',
           TMUXIFIER_VOICE_IDLE_MS: '10' },
    cwd: '/repo',
  });
  expect(c.voiceMaxBytes).toBe(8 * 1024 * 1024); // 9999 is above the 64 MB ceiling -> default (8 MB)
  expect(c.voiceMaxSeconds).toBe(120);           // 0 is below the 5s floor -> default (120)
  expect(c.voiceIdleMs).toBe(600000);            // 10 is below the 30s floor -> default (600000ms)
});

// voiceOff is the TMUXIFIER_VOICE=off hard kill switch. Its string->boolean
// normalization (/^(off|0|false|no)$/i) previously lived only in the envCfg
// mapping above, so a value arriving as a string through config.json or the
// overrides argument (both of which bypass that mapping entirely) skipped
// normalization: merged.voiceOff stayed the string "off", and the final check
// `merged.voiceOff !== true` saw "off" !== true and never engaged. Same shape
// as the passkeyOnlyKillSwitch boolean-vs-string test above; overrides sit at
// the same merge point a real config.json value would.
test('voiceOff as the string "off" via overrides disables voice even with bin+model set', () => {
  const c = loadConfig({
    voiceOff: 'off',
    whisperBin: '/repo/vendor/whisper/build/bin/whisper-server',
    whisperModel: '/repo/vendor/whisper/models/ggml-small.en.bin',
  }, { env: {}, cwd: '/repo' });
  expect(c.voiceEnabled).toBe(false);
});

test('voiceOff as the string "off" via config.json disables voice even with bin+model set', async () => {
  const fs = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fs.mkdtempSync(pathMod.join(osMod.tmpdir(), 'tmuxifier-voiceoff-'));
  fs.writeFileSync(pathMod.join(dir, 'config.json'), JSON.stringify({
    voiceOff: 'off',
    whisperBin: '/repo/vendor/whisper/build/bin/whisper-server',
    whisperModel: '/repo/vendor/whisper/models/ggml-small.en.bin',
  }));
  const c = loadConfig({}, { env: {}, cwd: dir });
  expect(c.voiceEnabled).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('voiceOff as a real boolean true via overrides disables voice', () => {
  const c = loadConfig({
    voiceOff: true,
    whisperBin: '/repo/vendor/whisper/build/bin/whisper-server',
    whisperModel: '/repo/vendor/whisper/models/ggml-small.en.bin',
  }, { env: {}, cwd: '/repo' });
  expect(c.voiceEnabled).toBe(false);
});

test('voiceOff as a real boolean false via overrides does not disable voice', () => {
  const c = loadConfig({
    voiceOff: false,
    whisperBin: '/repo/vendor/whisper/build/bin/whisper-server',
    whisperModel: '/repo/vendor/whisper/models/ggml-small.en.bin',
  }, { env: {}, cwd: '/repo' });
  expect(c.voiceEnabled).toBe(true);
});

// whisperBin/whisperModel are not trimmed today, so a whitespace-only value is
// truthy and voiceEnabled reports true with an unusable path. claudeOauthToken
// already does trim-and-treat-empty-as-unset (see above) — voiceEnabled should
// mean "actually usable" the same way.
test('whitespace-only whisperBin/whisperModel is treated as unset', () => {
  const withBlankBin = loadConfig({}, {
    env: { TMUXIFIER_WHISPER_BIN: '   ', TMUXIFIER_WHISPER_MODEL: '/repo/vendor/whisper/models/ggml-small.en.bin' },
    cwd: '/repo',
  });
  expect(withBlankBin.voiceEnabled).toBe(false);

  const withBlankModel = loadConfig({}, {
    env: { TMUXIFIER_WHISPER_BIN: '/repo/vendor/whisper/build/bin/whisper-server', TMUXIFIER_WHISPER_MODEL: '   ' },
    cwd: '/repo',
  });
  expect(withBlankModel.voiceEnabled).toBe(false);
});

// TMUXIFIER_VOICE env values with padding (e.g. export TMUXIFIER_VOICE=" off ")
// should be trimmed before the kill-switch regex; the env mapping was previously
// doing its own regex conversion without trim, so padded values silently failed.
test('TMUXIFIER_VOICE=" off " (padded) disables voice when bin+model are set', () => {
  const c = loadConfig({}, {
    env: { TMUXIFIER_VOICE: ' off ',
           TMUXIFIER_WHISPER_BIN: '/repo/vendor/whisper/build/bin/whisper-server',
           TMUXIFIER_WHISPER_MODEL: '/repo/vendor/whisper/models/ggml-small.en.bin' },
    cwd: '/repo',
  });
  expect(c.voiceEnabled).toBe(false);
});

test('TMUXIFIER_VOICE="off" (unpadded) still disables voice (regression guard)', () => {
  const c = loadConfig({}, {
    env: { TMUXIFIER_VOICE: 'off',
           TMUXIFIER_WHISPER_BIN: '/repo/vendor/whisper/build/bin/whisper-server',
           TMUXIFIER_WHISPER_MODEL: '/repo/vendor/whisper/models/ggml-small.en.bin' },
    cwd: '/repo',
  });
  expect(c.voiceEnabled).toBe(false);
});

test('TMUXIFIER_VOICE absent leaves voice enabled when bin+model are set', () => {
  const c = loadConfig({}, {
    env: { TMUXIFIER_WHISPER_BIN: '/repo/vendor/whisper/build/bin/whisper-server',
           TMUXIFIER_WHISPER_MODEL: '/repo/vendor/whisper/models/ggml-small.en.bin' },
    cwd: '/repo',
  });
  expect(c.voiceEnabled).toBe(true);
});

test('servicePollMs defaults to 30000, reads TMUXIFIER_SERVICE_POLL_MS, and rejects out-of-range values', () => {
  expect(loadConfig({}, { env: {}, cwd: '/nonexistent' }).servicePollMs).toBe(30000);
  expect(loadConfig({}, { env: { TMUXIFIER_SERVICE_POLL_MS: '12000' }, cwd: '/nonexistent' }).servicePollMs).toBe(12000);
  // clampInt semantics: out-of-range falls back to the default (like statusPollMs),
  // so a sub-5s sweep can never be configured. serviceChecker.js clamps again for
  // direct construction.
  expect(loadConfig({}, { env: { TMUXIFIER_SERVICE_POLL_MS: '10' }, cwd: '/nonexistent' }).servicePollMs).toBe(30000);
});

// Real-time agent state (agentWatch.js): on unless explicitly switched off.
test('agentWatch defaults on and TMUXIFIER_AGENT_WATCH=off disables it', () => {
  const at = (env, over = {}) => loadConfig(over, { env, cwd: '/app' }).agentWatch;
  expect(at({})).toBe(true);
  for (const v of ['off', 'OFF', ' off ', 'false', '0', 'no']) expect(at({ TMUXIFIER_AGENT_WATCH: v })).toBe(false);
  for (const v of ['on', 'true', '1', '', 'banana']) expect(at({ TMUXIFIER_AGENT_WATCH: v })).toBe(true);
  // config.json / overrides hand it through raw: a real boolean, or the same words.
  expect(at({}, { agentWatch: false })).toBe(false);
  expect(at({}, { agentWatch: 'off' })).toBe(false);
  expect(at({}, { agentWatch: true })).toBe(true);
  expect(at({ TMUXIFIER_AGENT_WATCH: 'off' }, { agentWatch: true })).toBe(true); // overrides win
});
