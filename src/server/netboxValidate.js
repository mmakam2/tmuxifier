const FINGERPRINT = /^[0-9A-Fa-f:]+$/;
// NetBox tokens are 40-char hex by default, but plugins/manual tokens vary — accept
// any run of printable non-space ASCII so we never reject a working token.
const TOKEN = /^[\x21-\x7e]{1,512}$/;
const TLS_MODES = ['ca', 'pin', 'insecure'];
// RFC-1035-shaped label: alnum, optional inner hyphens, 1-63 chars.
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Optional global suffix appended to the provision hostname to form the
// NetBox record's dns_name. Settings-save is the validation chokepoint:
// the allocation path trusts the stored value.
function normalizeDnsSuffix(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.length > 253) throw new Error('DNS suffix is too long (max 253 characters)');
  if (s.split('.').some((label) => !DNS_LABEL.test(label))) {
    throw new Error('DNS suffix must be dot-separated DNS labels like lan.example.com');
  }
  return s;
}

export function parseNetboxUrl(value) {
  const s = String(value ?? '').trim();
  if (!s) throw new Error('NetBox URL is required');
  let u;
  try { u = new URL(s); } catch { throw new Error('NetBox URL must be a full URL like https://netbox.example.com'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('NetBox URL must use http:// or https://');
  if (u.username || u.password) throw new Error('NetBox URL must not embed credentials');
  if (u.search || u.hash) throw new Error('NetBox URL must not contain a query or fragment');
  // Strip a trailing /api — the client appends API paths itself, and pasting the
  // API root from a browser tab is the most common form of the URL.
  const path = u.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

function nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }

export function assertSettingsInput(spec, { requireToken = true, requirePinFingerprint = true } = {}) {
  const url = parseNetboxUrl(spec.url);
  if (requireToken && !nonEmpty(spec.token)) throw new Error('an API token is required');
  if (nonEmpty(spec.token) && !TOKEN.test(spec.token.trim())) throw new Error('API token contains invalid characters');
  const dnsSuffix = normalizeDnsSuffix(spec.dnsSuffix);
  const https = url.startsWith('https:');
  if (!https) return { url, tlsMode: null, fingerprint256: null, dnsSuffix };
  const tlsMode = spec.tlsMode || 'ca';
  if (!TLS_MODES.includes(tlsMode)) throw new Error(`invalid tlsMode: ${JSON.stringify(tlsMode)}`);
  const hasValidFingerprint = FINGERPRINT.test(String(spec.fingerprint256 || ''));
  if (tlsMode === 'pin' && !hasValidFingerprint) {
    // Test Connection needs to reach the probe with no fingerprint yet pinned (that's
    // how a fingerprint gets discovered in the first place); the PUT/save path stays
    // strict via the default.
    if (!requirePinFingerprint) return { url, tlsMode, fingerprint256: null, dnsSuffix };
    throw new Error('pin mode requires a certificate fingerprint');
  }
  return { url, tlsMode, fingerprint256: tlsMode === 'pin' ? spec.fingerprint256 : null, dnsSuffix };
}
