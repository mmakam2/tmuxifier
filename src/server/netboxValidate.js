const FINGERPRINT = /^[0-9A-Fa-f:]+$/;
// NetBox tokens are 40-char hex by default, but plugins/manual tokens vary — accept
// any run of printable non-space ASCII so we never reject a working token.
const TOKEN = /^[\x21-\x7e]{1,512}$/;
const TLS_MODES = ['ca', 'pin', 'insecure'];

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

export function assertSettingsInput(spec, { requireToken = true } = {}) {
  const url = parseNetboxUrl(spec.url);
  if (requireToken && !nonEmpty(spec.token)) throw new Error('an API token is required');
  if (nonEmpty(spec.token) && !TOKEN.test(spec.token.trim())) throw new Error('API token contains invalid characters');
  const https = url.startsWith('https:');
  if (!https) return { url, tlsMode: null, fingerprint256: null };
  const tlsMode = spec.tlsMode || 'ca';
  if (!TLS_MODES.includes(tlsMode)) throw new Error(`invalid tlsMode: ${JSON.stringify(tlsMode)}`);
  if (tlsMode === 'pin' && !FINGERPRINT.test(String(spec.fingerprint256 || ''))) {
    throw new Error('pin mode requires a certificate fingerprint');
  }
  return { url, tlsMode, fingerprint256: tlsMode === 'pin' ? spec.fingerprint256 : null };
}
