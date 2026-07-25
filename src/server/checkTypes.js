import { normFp } from './tlsPin.js';

// Pure validation for check definitions. The server stays the validation
// authority: nothing the browser sends reaches an executor unvalidated.
export const CHECK_TYPES = ['http', 'tcp', 'json', 'exec', 'heartbeat'];
// Certificate trust for the TLS-speaking types (http, json). Same three modes,
// with the same meanings, as the NetBox and Proxmox clients: system trust,
// TOFU fingerprint pin (like `ssh accept-new`), explicit opt-out.
export const TLS_MODES = ['ca', 'pin', 'insecure'];
export const SEVERITIES = ['critical', 'warning', 'info'];

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
};

function assertUrl(url) {
  if (typeof url !== 'string' || !url.trim()) throw new Error('target.url is required');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('target.url must be a valid URL'); }
  // http(s)-only, checked and rejected rather than coerced: this is what stops a
  // stored check from ever reaching file:// or a unix socket via the executor.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('target.url must be http or https');
  }
  return parsed.toString();
}

function assertTarget(type, target) {
  const t = target && typeof target === 'object' ? target : {};
  if (type === 'http') return { url: assertUrl(t.url) };
  if (type === 'json') {
    if (typeof t.path !== 'string' || !t.path.trim()) throw new Error('target.path is required');
    return { url: assertUrl(t.url), path: t.path.trim() };
  }
  if (type === 'tcp') {
    if (typeof t.host !== 'string' || !t.host.trim()) throw new Error('target.host is required');
    const port = Number(t.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('target.port must be 1-65535');
    return { host: t.host.trim(), port };
  }
  if (type === 'exec') {
    if (typeof t.boxId !== 'string' || !t.boxId.trim()) throw new Error('target.boxId is required');
    if (typeof t.command !== 'string' || !t.command.trim()) throw new Error('target.command is required');
    return { boxId: t.boxId.trim(), command: t.command.trim() };
  }
  const windowSec = Number(t.windowSec);
  if (!Number.isInteger(windowSec) || windowSec < 1) throw new Error('target.windowSec must be a positive integer');
  return { windowSec, graceSec: clampInt(t.graceSec, 0, 86400, 0) };
}

export function assertCheckInput(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const label = typeof s.label === 'string' ? s.label.trim() : '';
  if (!label) throw new Error('label is required');
  if (!CHECK_TYPES.includes(s.type)) throw new Error(`type must be one of ${CHECK_TYPES.join(', ')}`);
  // Unknown severity throws rather than falling back to 'warning': only an
  // *absent* severity gets a default, because silently defaulting an invalid
  // one would mask a caller's typo as a real (wrong) severity choice.
  const severity = s.severity === undefined ? 'warning' : s.severity;
  if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`);
  // How to trust the certificate, for the types that speak TLS. Rejected rather
  // than defaulted for the same reason as severity: silently reading an
  // unrecognised mode as 'ca' would mask a typo, and reading it as anything
  // looser would quietly disable certificate verification.
  const tlsMode = s.tlsMode === undefined ? 'ca' : s.tlsMode;
  if (!TLS_MODES.includes(tlsMode)) throw new Error(`tlsMode must be one of ${TLS_MODES.join(', ')}`);
  // A pin is only meaningful as a fingerprint. Demanding one here is what stops
  // 'pin' from being stored in a state that cannot connect to anything —
  // tlsRequest.js refuses a blank pin at request time, so without this the
  // check would simply fail forever with no hint as to why.
  const fingerprint256 = normFp(s.fingerprint256);
  if (tlsMode === 'pin' && !fingerprint256) {
    throw new Error('tlsMode "pin" requires fingerprint256 — probe the server to capture it');
  }
  return {
    label,
    type: s.type,
    tlsMode,
    fingerprint256: fingerprint256 || null,
    target: assertTarget(s.type, s.target),
    assert: s.assert && typeof s.assert === 'object' ? { ...s.assert } : {},
    intervalSec: clampInt(s.intervalSec, 10, 86400, 60),
    timeoutMs: clampInt(s.timeoutMs, 1000, 120000, 10000),
    severity,
    failuresBeforeNotify: clampInt(s.failuresBeforeNotify, 1, 1000, 3),
    enabled: s.enabled === undefined ? true : !!s.enabled,
  };
}
