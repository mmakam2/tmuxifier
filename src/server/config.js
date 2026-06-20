import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const envCfg = clean({
    bindAddress: env.TMUXIFIER_BIND,
    port: env.TMUXIFIER_PORT ? Number(env.TMUXIFIER_PORT) : undefined,
    graceSeconds: env.TMUXIFIER_GRACE ? Number(env.TMUXIFIER_GRACE) : undefined,
    hostKeyPolicy: env.TMUXIFIER_HOSTKEY_POLICY,
    passwordHash: env.TMUXIFIER_PASSWORD_HASH,
    cookieSecret: env.TMUXIFIER_COOKIE_SECRET,
    dataDir: env.TMUXIFIER_DATA_DIR,
    controlDir: env.TMUXIFIER_CONTROL_DIR,
    sshConfigFile: env.TMUXIFIER_SSH_CONFIG,
    tlsCert: env.TMUXIFIER_TLS_CERT,
    tlsKey: env.TMUXIFIER_TLS_KEY,
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
