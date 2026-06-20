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
    bindAddress: env.HELM_BIND,
    port: env.HELM_PORT ? Number(env.HELM_PORT) : undefined,
    graceSeconds: env.HELM_GRACE ? Number(env.HELM_GRACE) : undefined,
    hostKeyPolicy: env.HELM_HOSTKEY_POLICY,
    passwordHash: env.HELM_PASSWORD_HASH,
    cookieSecret: env.HELM_COOKIE_SECRET,
    dataDir: env.HELM_DATA_DIR,
    sshConfigFile: env.HELM_SSH_CONFIG,
  });
  const merged = { ...DEFAULTS, ...clean(fileCfg), ...envCfg, ...clean(overrides) };
  merged.dataDir = merged.dataDir ?? path.join(cwd, 'data');
  merged.sshConfigPath = merged.sshConfigPath ?? path.join(os.homedir(), '.ssh', 'config');
  return merged;
}
