import os from 'node:os';
import path from 'node:path';
import { readEnvFile } from './envFile.js';
import { readConfigFile } from './configFile.js';

const DEFAULTS = {
  bindAddress: '127.0.0.1',
  port: 7437,
  graceSeconds: 45,
  hostKeyPolicy: 'accept-new',
  passwordHash: '',
  cookieSecret: '',
  localShell: 'none',
};

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function parseEmails(value) {
  const arr = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

function normalizePublicUrl(value) {
  const s = String(value || '').trim().replace(/\/+$/, '');
  if (!s) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

export function loadConfig(overrides = {}, { env = process.env, cwd = process.cwd() } = {}) {
  const fileCfg = readConfigFile(path.join(cwd, 'config.json'));
  // Keep Tmuxifier self-contained: a repo-local .env supplies TMUXIFIER_* values
  // so nothing needs to live in the shell. Real shell env still wins, so an
  // explicitly exported variable overrides the file (12-factor friendly).
  const e = { ...readEnvFile(path.join(cwd, '.env')), ...env };
  const envCfg = clean({
    bindAddress: e.TMUXIFIER_BIND,
    port: e.TMUXIFIER_PORT ? Number(e.TMUXIFIER_PORT) : undefined,
    graceSeconds: e.TMUXIFIER_GRACE ? Number(e.TMUXIFIER_GRACE) : undefined,
    hostKeyPolicy: e.TMUXIFIER_HOSTKEY_POLICY,
    authMode: e.TMUXIFIER_AUTH_MODE,
    publicUrl: e.TMUXIFIER_BASE_EXTERNAL_URL ?? e.TMUXIFIER_PUBLIC_URL,
    googleClientId: e.TMUXIFIER_OAUTH_CLIENT_ID ?? e.TMUXIFIER_GOOGLE_CLIENT_ID,
    googleClientSecret: e.TMUXIFIER_OAUTH_CLIENT_SECRET ?? e.TMUXIFIER_GOOGLE_CLIENT_SECRET,
    allowedEmails: e.TMUXIFIER_ALLOWED_EMAILS,
    passwordHash: e.TMUXIFIER_PASSWORD_HASH,
    cookieSecret: e.TMUXIFIER_COOKIE_SECRET,
    dataDir: e.TMUXIFIER_DATA_DIR,
    controlDir: e.TMUXIFIER_CONTROL_DIR,
    sshConfigFile: e.TMUXIFIER_SSH_CONFIG,
    tlsCert: e.TMUXIFIER_TLS_CERT,
    tlsKey: e.TMUXIFIER_TLS_KEY,
    localShell: e.TMUXIFIER_LOCAL_SHELL,
  });
  const merged = { ...DEFAULTS, ...clean(fileCfg), ...envCfg, ...clean(overrides) };
  merged.dataDir = merged.dataDir ?? path.join(cwd, 'data');
  // Directory for SSH ControlMaster sockets. Multiplexing every probe and
  // terminal for a box over one persistent connection keeps Tmuxifier from
  // hammering each box's sshd (and tripping MaxStartups / ban tools).
  merged.controlDir = merged.controlDir ?? path.join(merged.dataDir, 'cm');
  merged.sshConfigPath = merged.sshConfigPath ?? path.join(os.homedir(), '.ssh', 'config');
  // Auth mode: password (default) or oauth. "google" is accepted as a legacy alias.
  merged.authMode = ['oauth', 'google'].includes(merged.authMode) ? 'google' : 'password';
  merged.publicUrl = normalizePublicUrl(merged.publicUrl);
  merged.allowedEmails = parseEmails(merged.allowedEmails);
  // Mark the session cookie Secure when we serve HTTPS locally OR sit behind an
  // HTTPS public URL, for example a TLS-terminating Cloudflare tunnel.
  merged.secureCookie = !!(merged.tlsCert && merged.tlsKey) || /^https:/i.test(String(merged.publicUrl || ''));
  return merged;
}

export function requiredConfigError(config) {
  if (!config.cookieSecret) {
    return 'Missing TMUXIFIER_COOKIE_SECRET. Run: npm run set-password (password mode) or npm run gen-secret (oauth mode).';
  }
  if (config.authMode === 'google') {
    const missing = [];
    if (!config.googleClientId) missing.push('TMUXIFIER_OAUTH_CLIENT_ID');
    if (!config.googleClientSecret) missing.push('TMUXIFIER_OAUTH_CLIENT_SECRET');
    if (!config.publicUrl) missing.push('TMUXIFIER_BASE_EXTERNAL_URL');
    if (!config.allowedEmails || config.allowedEmails.length === 0) missing.push('TMUXIFIER_ALLOWED_EMAILS');
    return missing.length ? `Google auth mode requires: ${missing.join(', ')}` : null;
  }
  if (!config.passwordHash) return 'Tmuxifier is not configured. Run: npm run set-password';
  return null;
}
