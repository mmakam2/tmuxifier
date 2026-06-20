import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvFile } from './envFile.js';

const DEFAULTS = {
  bindAddress: '127.0.0.1',
  port: 7437,
  graceSeconds: 45,
  hostKeyPolicy: 'accept-new',
  passwordHash: '',
  cookieSecret: '',
};

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function loadConfig(overrides = {}, { env = process.env, cwd = process.cwd() } = {}) {
  const fileCfg = readJsonIfExists(path.join(cwd, 'config.json'));
  // Keep Tmuxifier self-contained: a repo-local .env supplies TMUXIFIER_* values
  // so nothing needs to live in the shell. Real shell env still wins, so an
  // explicitly exported variable overrides the file (12-factor friendly).
  const e = { ...readEnvFile(path.join(cwd, '.env')), ...env };
  const envCfg = clean({
    bindAddress: e.TMUXIFIER_BIND,
    port: e.TMUXIFIER_PORT ? Number(e.TMUXIFIER_PORT) : undefined,
    graceSeconds: e.TMUXIFIER_GRACE ? Number(e.TMUXIFIER_GRACE) : undefined,
    hostKeyPolicy: e.TMUXIFIER_HOSTKEY_POLICY,
    passwordHash: e.TMUXIFIER_PASSWORD_HASH,
    cookieSecret: e.TMUXIFIER_COOKIE_SECRET,
    dataDir: e.TMUXIFIER_DATA_DIR,
    controlDir: e.TMUXIFIER_CONTROL_DIR,
    sshConfigFile: e.TMUXIFIER_SSH_CONFIG,
    tlsCert: e.TMUXIFIER_TLS_CERT,
    tlsKey: e.TMUXIFIER_TLS_KEY,
  });
  const merged = { ...DEFAULTS, ...clean(fileCfg), ...envCfg, ...clean(overrides) };
  merged.dataDir = merged.dataDir ?? path.join(cwd, 'data');
  // Directory for SSH ControlMaster sockets. Multiplexing every probe and
  // terminal for a box over one persistent connection keeps Tmuxifier from
  // hammering each box's sshd (and tripping MaxStartups / ban tools).
  merged.controlDir = merged.controlDir ?? path.join(merged.dataDir, 'cm');
  merged.sshConfigPath = merged.sshConfigPath ?? path.join(os.homedir(), '.ssh', 'config');
  // Serve over HTTPS (and mark the session cookie Secure) only when a TLS
  // cert+key are configured. Decoupled from bindAddress so a non-loopback
  // HTTP bind still works (a Secure cookie over plain HTTP is dropped by browsers).
  merged.secureCookie = !!(merged.tlsCert && merged.tlsKey);
  return merged;
}
