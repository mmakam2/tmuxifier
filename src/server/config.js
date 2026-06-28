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
  // Terminal (xterm) font. termFont is undefined by default → the browser uses
  // the bundled font stack; a configured name is prepended to it client-side.
  // Validated/normalized below so an unsafe or out-of-range value falls back.
  termFont: undefined,
  termFontSize: 12,
  // Probe at most this many boxes at once on /api/status. A small batch keeps
  // Tmuxifier from opening the whole fleet's SSH connections simultaneously,
  // which rate-limiters/IPS on the path read as a brute-force burst.
  statusConcurrency: 4,
  // How often (ms) the single server-side loop re-probes every box. Status is
  // polled here once per interval regardless of how many dashboard tabs are open,
  // so the SSH connection rate no longer scales with tab count. See statusPoller.js.
  statusPollMs: 30000,
  // ssh ControlPersist (seconds): how long a multiplexed master lingers after
  // its last use. Longer means cold-connect bursts (which trigger the blocks
  // above) happen far less often.
  controlPersist: 600,
  // Fleet Command: run one command across many boxes as a single pollable job.
  // Concurrency shares the status rationale — never open the whole fleet's SSH
  // connections at once.
  fleetConcurrency: 4,
  fleetTimeoutMs: 15000,       // per-box ssh exec timeout (ms)
  fleetMaxJobs: 50,            // retained job history; older jobs are pruned
  fleetMaxOutputBytes: 65536,  // per-stream capture cap per box (64 KiB)
  // Proxmox LXC provisioning (Phase 1). Poll cadence for PVE task progress, per-request
  // and overall-provision timeouts, DHCP-lease discovery window, and retained job history.
  pvePollMs: 1500,
  pveTimeoutMs: 15000,
  pveProvisionTimeoutMs: 600000,
  pveLeaseTimeoutMs: 60000,
  pveMaxJobs: 50,
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
    statusConcurrency: e.TMUXIFIER_STATUS_CONCURRENCY ? Number(e.TMUXIFIER_STATUS_CONCURRENCY) : undefined,
    statusPollMs: e.TMUXIFIER_STATUS_POLL_MS ? Number(e.TMUXIFIER_STATUS_POLL_MS) : undefined,
    controlPersist: e.TMUXIFIER_CONTROL_PERSIST ? Number(e.TMUXIFIER_CONTROL_PERSIST) : undefined,
    fleetConcurrency: e.TMUXIFIER_FLEET_CONCURRENCY ? Number(e.TMUXIFIER_FLEET_CONCURRENCY) : undefined,
    fleetTimeoutMs: e.TMUXIFIER_FLEET_TIMEOUT_MS ? Number(e.TMUXIFIER_FLEET_TIMEOUT_MS) : undefined,
    fleetMaxJobs: e.TMUXIFIER_FLEET_MAX_JOBS ? Number(e.TMUXIFIER_FLEET_MAX_JOBS) : undefined,
    fleetMaxOutputBytes: e.TMUXIFIER_FLEET_MAX_OUTPUT_BYTES ? Number(e.TMUXIFIER_FLEET_MAX_OUTPUT_BYTES) : undefined,
    pvePollMs: e.TMUXIFIER_PVE_POLL_MS ? Number(e.TMUXIFIER_PVE_POLL_MS) : undefined,
    pveTimeoutMs: e.TMUXIFIER_PVE_TIMEOUT_MS ? Number(e.TMUXIFIER_PVE_TIMEOUT_MS) : undefined,
    pveProvisionTimeoutMs: e.TMUXIFIER_PVE_PROVISION_TIMEOUT_MS ? Number(e.TMUXIFIER_PVE_PROVISION_TIMEOUT_MS) : undefined,
    pveLeaseTimeoutMs: e.TMUXIFIER_PVE_LEASE_TIMEOUT_MS ? Number(e.TMUXIFIER_PVE_LEASE_TIMEOUT_MS) : undefined,
    pveMaxJobs: e.TMUXIFIER_PVE_MAX_JOBS ? Number(e.TMUXIFIER_PVE_MAX_JOBS) : undefined,
    pveDefaultPubKeyPath: e.TMUXIFIER_PVE_DEFAULT_PUBKEY, // undefined → auto-detect ~/.ssh/*.pub
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
    termFont: e.TMUXIFIER_TERM_FONT,
    termFontSize: e.TMUXIFIER_TERM_FONT_SIZE ? Number(e.TMUXIFIER_TERM_FONT_SIZE) : undefined,
  });
  const merged = { ...DEFAULTS, ...clean(fileCfg), ...envCfg, ...clean(overrides) };
  merged.dataDir = merged.dataDir ?? path.join(cwd, 'data');
  // Directory for SSH ControlMaster sockets. Multiplexing every probe and
  // terminal for a box over one persistent connection keeps Tmuxifier from
  // hammering each box's sshd (and tripping MaxStartups / ban tools).
  merged.controlDir = merged.controlDir ?? path.join(merged.dataDir, 'cm');
  // Auth mode: password (default) or oauth. "google" is accepted as a legacy alias.
  merged.authMode = ['oauth', 'google'].includes(merged.authMode) ? 'google' : 'password';
  merged.publicUrl = normalizePublicUrl(merged.publicUrl);
  merged.allowedEmails = parseEmails(merged.allowedEmails);
  // Mark the session cookie Secure when we serve HTTPS locally OR sit behind an
  // HTTPS public URL, for example a TLS-terminating Cloudflare tunnel.
  merged.secureCookie = !!(merged.tlsCert && merged.tlsKey) || /^https:/i.test(String(merged.publicUrl || ''));
  // Normalize localShell so invalid env/file values are coerced to 'none'
  // rather than being passed through unvalidated to the WebSocket handler.
  merged.localShell = ['none', 'omz', 'omb'].includes(merged.localShell) ? merged.localShell : 'none';
  // Terminal font: a single family name on a CSS-injection-safe allowlist (no
  // quotes/commas/semicolons/braces). Anything else → undefined so the browser
  // keeps the bundled font. Size is clamped to a sane px range, default 12.
  const fontName = String(merged.termFont ?? '').trim();
  merged.termFont = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(fontName) ? fontName : undefined;
  const fontSize = Number(merged.termFontSize);
  merged.termFontSize = Number.isFinite(fontSize) && fontSize >= 6 && fontSize <= 32 ? fontSize : 12;
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
