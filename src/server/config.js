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
  // claude setup-token output for seeding boxes — see docs/superpowers/specs/2026-07-18-ai-auth-seeding-design.md
  claudeOauthToken: null,
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
  // Box health history + in-app events. The status poll already collects
  // CPU/mem/disk every statusPollMs; keep a rolling per-box series (maxSamples)
  // and an edge-triggered events log (maxEvents, persisted). Thresholds drive
  // the "metric crossed a limit" events with a hysteresis clear margin.
  healthHistoryMax: 120,   // samples retained per box (~1h at 30s)
  healthEventsMax: 200,    // events retained in data/health-events.json
  healthCpuWarnPct: 90,
  healthMemWarnPct: 90,
  healthDiskWarnPct: 90,
  healthThresholdHysteresisPct: 5,
  // Seconds a claude pane's tmux session must be idle (no output) before it is
  // read as "waiting for input" — see docs/superpowers/specs/2026-07-19-agent-notifications-design.md
  agentIdleSec: 45,
  // Proxmox LXC provisioning (Phase 1). Poll cadence for PVE task progress, per-request
  // and overall-provision timeouts, DHCP-lease discovery window, and retained job history.
  pvePollMs: 1500,
  pveTimeoutMs: 15000,
  pveProvisionTimeoutMs: 600000,
  pveLeaseTimeoutMs: 60000,
  pveMaxJobs: 50,
  // Terminal file upload (paste/drag-drop): max accepted body size in MB.
  uploadMaxMb: 25,
  // WebAuthn passkeys. rpId is resolved below (see resolveRpId); the kill switch
  // is the .env break-glass that forces the stored passkey-only flag off.
  rpId: undefined,
  passkeyOnlyKillSwitch: undefined,
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

// A WebAuthn Relying Party id must be a domain name — never an IP literal. Each
// label is 1-63 chars of letters/digits/hyphen and cannot start or end with a
// hyphen; the whole name is at most 253 chars.
const RP_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function isValidRpId(host) {
  if (!host || host.length > 253) return false;
  if (!RP_ID_RE.test(host)) return false;
  // An all-numeric label chain is an IPv4 literal. IPv6 arrives from
  // URL.hostname wrapped in brackets and already fails RP_ID_RE.
  if (/^\d+(\.\d+)*$/.test(host)) return false;
  return true;
}

// The hostname passkeys are bound to. A passkey enrolled under one RP id is
// unusable under another, so this is derived from the URL the browser already
// uses rather than invented. An explicit value that cannot work is a hard
// error; a derived one that cannot work just disables the feature.
export function resolveRpId({ explicit, publicUrl }) {
  const stated = String(explicit ?? '').trim().toLowerCase();
  if (stated) {
    return isValidRpId(stated)
      ? { rpId: stated, error: null }
      : { rpId: null, error: `TMUXIFIER_RP_ID must be a domain name, not an IP address or URL: ${stated}` };
  }
  let host = '';
  try { host = publicUrl ? new URL(publicUrl).hostname.toLowerCase() : ''; } catch { host = ''; }
  if (!host) return { rpId: 'localhost', error: null };
  return { rpId: isValidRpId(host) ? host : null, error: null };
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
    healthHistoryMax: e.TMUXIFIER_HEALTH_HISTORY_MAX ? Number(e.TMUXIFIER_HEALTH_HISTORY_MAX) : undefined,
    healthEventsMax: e.TMUXIFIER_HEALTH_EVENTS_MAX ? Number(e.TMUXIFIER_HEALTH_EVENTS_MAX) : undefined,
    healthCpuWarnPct: e.TMUXIFIER_HEALTH_CPU_WARN_PCT ? Number(e.TMUXIFIER_HEALTH_CPU_WARN_PCT) : undefined,
    healthMemWarnPct: e.TMUXIFIER_HEALTH_MEM_WARN_PCT ? Number(e.TMUXIFIER_HEALTH_MEM_WARN_PCT) : undefined,
    healthDiskWarnPct: e.TMUXIFIER_HEALTH_DISK_WARN_PCT ? Number(e.TMUXIFIER_HEALTH_DISK_WARN_PCT) : undefined,
    healthThresholdHysteresisPct: e.TMUXIFIER_HEALTH_HYSTERESIS_PCT ? Number(e.TMUXIFIER_HEALTH_HYSTERESIS_PCT) : undefined,
    agentIdleSec: e.TMUXIFIER_AGENT_IDLE_SEC ? Number(e.TMUXIFIER_AGENT_IDLE_SEC) : undefined,
    pvePollMs: e.TMUXIFIER_PVE_POLL_MS ? Number(e.TMUXIFIER_PVE_POLL_MS) : undefined,
    pveTimeoutMs: e.TMUXIFIER_PVE_TIMEOUT_MS ? Number(e.TMUXIFIER_PVE_TIMEOUT_MS) : undefined,
    pveProvisionTimeoutMs: e.TMUXIFIER_PVE_PROVISION_TIMEOUT_MS ? Number(e.TMUXIFIER_PVE_PROVISION_TIMEOUT_MS) : undefined,
    pveLeaseTimeoutMs: e.TMUXIFIER_PVE_LEASE_TIMEOUT_MS ? Number(e.TMUXIFIER_PVE_LEASE_TIMEOUT_MS) : undefined,
    pveMaxJobs: e.TMUXIFIER_PVE_MAX_JOBS ? Number(e.TMUXIFIER_PVE_MAX_JOBS) : undefined,
    pveDefaultPubKeyPath: e.TMUXIFIER_PVE_DEFAULT_PUBKEY, // undefined → auto-detect ~/.ssh/*.pub
    hostKeyPolicy: e.TMUXIFIER_HOSTKEY_POLICY,
    trustProxy: e.TMUXIFIER_TRUST_PROXY,
    authMode: e.TMUXIFIER_AUTH_MODE,
    rpId: e.TMUXIFIER_RP_ID,
    passkeyOnlyKillSwitch: e.TMUXIFIER_PASSKEY_ONLY,
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
    claudeOauthToken: e.TMUXIFIER_CLAUDE_OAUTH_TOKEN && e.TMUXIFIER_CLAUDE_OAUTH_TOKEN.trim() ? e.TMUXIFIER_CLAUDE_OAUTH_TOKEN.trim() : undefined,
    uploadMaxMb: e.TMUXIFIER_UPLOAD_MAX_MB ? Number(e.TMUXIFIER_UPLOAD_MAX_MB) : undefined,
  });
  const merged = { ...DEFAULTS, ...clean(fileCfg), ...envCfg, ...clean(overrides) };
  // Every numeric knob is clamped to a sane range; a non-numeric or
  // out-of-range value falls back to the default rather than passing through
  // (TMUXIFIER_PORT=7437x would listen on NaN; TMUXIFIER_STATUS_POLL_MS=0
  // would hot-loop SSH probes against the whole fleet). Ranges are generous —
  // the goal is catching typos and pathological zeros, not policing tuning.
  const clampInt = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : dflt;
  };
  merged.port = clampInt(merged.port, 1, 65535, DEFAULTS.port);
  merged.graceSeconds = clampInt(merged.graceSeconds, 0, 86400, DEFAULTS.graceSeconds);
  merged.statusConcurrency = clampInt(merged.statusConcurrency, 1, 100, DEFAULTS.statusConcurrency);
  merged.statusPollMs = clampInt(merged.statusPollMs, 1000, 86400000, DEFAULTS.statusPollMs);
  merged.controlPersist = clampInt(merged.controlPersist, 0, 604800, DEFAULTS.controlPersist); // 0 = ssh "keep forever"
  merged.fleetConcurrency = clampInt(merged.fleetConcurrency, 1, 100, DEFAULTS.fleetConcurrency);
  merged.fleetTimeoutMs = clampInt(merged.fleetTimeoutMs, 100, 86400000, DEFAULTS.fleetTimeoutMs);
  merged.fleetMaxJobs = clampInt(merged.fleetMaxJobs, 1, 10000, DEFAULTS.fleetMaxJobs);
  merged.fleetMaxOutputBytes = clampInt(merged.fleetMaxOutputBytes, 256, 134217728, DEFAULTS.fleetMaxOutputBytes);
  merged.pvePollMs = clampInt(merged.pvePollMs, 100, 600000, DEFAULTS.pvePollMs);
  merged.pveTimeoutMs = clampInt(merged.pveTimeoutMs, 500, 600000, DEFAULTS.pveTimeoutMs);
  merged.pveProvisionTimeoutMs = clampInt(merged.pveProvisionTimeoutMs, 1000, 86400000, DEFAULTS.pveProvisionTimeoutMs);
  merged.pveLeaseTimeoutMs = clampInt(merged.pveLeaseTimeoutMs, 0, 3600000, DEFAULTS.pveLeaseTimeoutMs); // 0 = don't wait for DHCP
  merged.pveMaxJobs = clampInt(merged.pveMaxJobs, 1, 10000, DEFAULTS.pveMaxJobs);
  merged.uploadMaxMb = clampInt(merged.uploadMaxMb, 1, 1024, DEFAULTS.uploadMaxMb);
  merged.uploadMaxBytes = merged.uploadMaxMb * 1024 * 1024;
  merged.dataDir = merged.dataDir ?? path.join(cwd, 'data');
  // Directory for SSH ControlMaster sockets. Multiplexing every probe and
  // terminal for a box over one persistent connection keeps Tmuxifier from
  // hammering each box's sshd (and tripping MaxStartups / ban tools).
  merged.controlDir = merged.controlDir ?? path.join(merged.dataDir, 'cm');
  // Reverse-proxy support (Fastify trustProxy). Behind the TLS proxy/tunnel the
  // docs recommend, req.ip is the proxy's address for EVERY client unless the
  // X-Forwarded-For chain is trusted — per-IP login rate limiting would bucket
  // everyone together and any remote client could lock the real user out.
  // Accepts true, a hop count, or a comma-separated address/CIDR list; off by
  // default because trusting forwarded headers without a proxy lets clients
  // spoof their ip. undefined = disabled (Fastify default).
  merged.trustProxy = (() => {
    const v = merged.trustProxy;
    if (v === undefined || v === null || v === false) return undefined;
    if (v === true || typeof v === 'number') return v;
    const s = String(v).trim();
    if (!s || /^(false|no|off)$/i.test(s)) return undefined;
    if (/^(true|yes|on)$/i.test(s)) return true;
    if (/^\d+$/.test(s)) return Number(s);
    return s; // address/CIDR list, passed through to Fastify
  })();
  // Auth mode: password (default) or oauth. "google" is accepted as a legacy alias.
  merged.authMode = ['oauth', 'google'].includes(merged.authMode) ? 'google' : 'password';
  merged.publicUrl = normalizePublicUrl(merged.publicUrl);
  // rpId === null means passkeys are unavailable at this deployment (an
  // IP-addressed one). rpIdError is set only for an explicit unusable value.
  const rp = resolveRpId({ explicit: merged.rpId, publicUrl: merged.publicUrl });
  merged.rpId = rp.rpId;
  merged.rpIdError = rp.error;
  merged.passkeyOnlyKillSwitch = /^(off|0|no|false)$/i.test(String(merged.passkeyOnlyKillSwitch ?? '').trim());
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
  // Health knobs share the clampInt fallback-to-default behavior above.
  merged.healthHistoryMax = clampInt(merged.healthHistoryMax, 10, 5000, DEFAULTS.healthHistoryMax);
  merged.healthEventsMax = clampInt(merged.healthEventsMax, 10, 5000, DEFAULTS.healthEventsMax);
  merged.healthCpuWarnPct = clampInt(merged.healthCpuWarnPct, 1, 100, DEFAULTS.healthCpuWarnPct);
  merged.healthMemWarnPct = clampInt(merged.healthMemWarnPct, 1, 100, DEFAULTS.healthMemWarnPct);
  merged.healthDiskWarnPct = clampInt(merged.healthDiskWarnPct, 1, 100, DEFAULTS.healthDiskWarnPct);
  merged.healthThresholdHysteresisPct = clampInt(merged.healthThresholdHysteresisPct, 0, 50, DEFAULTS.healthThresholdHysteresisPct);
  merged.agentIdleSec = clampInt(merged.agentIdleSec, 10, 3600, DEFAULTS.agentIdleSec);
  return merged;
}

export function requiredConfigError(config) {
  if (!config.cookieSecret) {
    return 'Missing TMUXIFIER_COOKIE_SECRET. Run: npm run set-password (password mode) or npm run gen-secret (oauth mode).';
  }
  if (config.rpIdError) return config.rpIdError;
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
