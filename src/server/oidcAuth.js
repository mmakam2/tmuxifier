import { createHash, randomBytes } from 'node:crypto';

// Hand-rolled, dependency-free generic OpenID Connect client (authorization
// code + PKCE + nonce). Endpoints come from `<issuer>/.well-known/openid-configuration`,
// fetched lazily and cached for 1 hour on success and 30 seconds on failure.
//
// Trust argument: the id_token is fetched server-to-server from the token
// endpoint over TLS, so its payload is trusted without a JWKS signature check
// for this single-user gate. Claims are still checked (iss, aud, exp, nonce,
// email, email_verified). Discovered endpoints must be https (loopback http is
// allowed for tests) and the discovered `issuer` must equal the configured one.
// The token request refuses redirects, so the secret and the id_token never
// travel through a hop that check did not cover.
//
// Google quirk: its id_tokens may carry `iss: accounts.google.com` (no scheme),
// accepted only when the configured issuer is https://accounts.google.com.

const GOOGLE_ISSUER = 'https://accounts.google.com';
const SKEW_SECONDS = 60;
const TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 65536;

async function readJsonBounded(res) {
  if (!res.body || typeof res.body.getReader !== 'function') return res.json();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error('response body too large');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class OidcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OidcError';
    this.code = code;
  }
}

export function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function pkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function randomState() {
  return base64url(randomBytes(16));
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const DISCOVERY_FAIL_TTL_MS = 30 * 1000;

const trimSlash = (s) => String(s).replace(/\/+$/, '');

export function isSecureUrl(value) {
  let u;
  try { u = new URL(value); } catch { return false; }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
}

function decodePayload(idToken) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new OidcError('provider', 'malformed id_token');
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') throw new Error('not an object');
    return payload;
  } catch {
    throw new OidcError('provider', 'malformed id_token');
  }
}

export function createOidcClient({ provider, redirectUri, allowedEmails = [], fetchImpl = fetch, now = Date.now }) {
  const { id, label, issuer, clientId, clientSecret, allowUnverifiedEmail = false } = provider;
  const allow = new Set(allowedEmails.map((e) => String(e).toLowerCase()));
  const isGoogle = trimSlash(issuer) === GOOGLE_ISSUER;
  let discovered = null;
  let discoveredAt = 0;
  let discoveredOk = false;
  let discoveredSettled = false;

  async function fetchDiscovery() {
    let doc;
    try {
      const res = await fetchImpl(`${trimSlash(issuer)}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      doc = await readJsonBounded(res);
    } catch (e) {
      throw new OidcError('provider', `discovery failed: ${e.message}`);
    }
    if (!doc || trimSlash(doc.issuer) !== trimSlash(issuer)) throw new OidcError('provider', 'discovery issuer mismatch');
    if (!isSecureUrl(doc.authorization_endpoint) || !isSecureUrl(doc.token_endpoint)) {
      throw new OidcError('provider', 'discovered endpoint is not https');
    }
    return { authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint };
  }

  async function discover() {
    const age = now() - discoveredAt;
    if (discovered && discoveredSettled && age >= (discoveredOk ? DISCOVERY_TTL_MS : DISCOVERY_FAIL_TTL_MS)) {
      discovered = null;
    }
    if (!discovered) {
      const p = fetchDiscovery();
      discovered = p;
      discoveredSettled = false;
      discoveredOk = false;
      const settle = (ok) => { if (discovered === p) { discoveredOk = ok; discoveredSettled = true; discoveredAt = now(); } };
      p.then(() => settle(true), () => settle(false));
    }
    return discovered;
  }

  const forbid = (msg) => new OidcError('forbidden', msg);

  return {
    id,
    label,
    async authorizationUrl({ state, nonce, codeChallenge }) {
      const { authorizationEndpoint } = await discover();
      const u = new URL(authorizationEndpoint);
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', 'openid email');
      u.searchParams.set('state', state);
      u.searchParams.set('nonce', nonce);
      u.searchParams.set('code_challenge', codeChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
      if (isGoogle) {
        u.searchParams.set('access_type', 'online');
        u.searchParams.set('prompt', 'select_account');
      }
      return u.toString();
    },
    async exchangeCode({ code, codeVerifier, nonce }) {
      if (typeof nonce !== 'string' || !nonce) throw forbid('missing expected nonce');
      const { tokenEndpoint } = await discover();
      let data;
      try {
        const res = await fetchImpl(tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            code_verifier: codeVerifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          }).toString(),
          // fetch has no default timeout — without this, a hung token endpoint
          // pins the callback request forever.
          signal: AbortSignal.timeout(TIMEOUT_MS),
          // A 307/308 would re-send client_secret, code and code_verifier to a
          // URL isSecureUrl never checked (possibly plain http), and the
          // id_token would come back from a hop outside the trust argument.
          redirect: 'error',
        });
        if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
        data = await readJsonBounded(res);
      } catch (e) {
        throw new OidcError('provider', e.message);
      }
      if (!data || !data.id_token) throw new OidcError('provider', 'no id_token in token response');
      const c = decodePayload(data.id_token);

      const issOk = c.iss === issuer || trimSlash(c.iss ?? '') === trimSlash(issuer) || (isGoogle && c.iss === 'accounts.google.com');
      if (!issOk) throw forbid('iss mismatch');
      const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
      if (!aud.includes(clientId)) throw forbid('aud mismatch');
      if (typeof c.exp !== 'number' || c.exp + SKEW_SECONDS < now() / 1000) throw forbid('id_token expired');
      if (c.nonce !== nonce) throw forbid('nonce mismatch');
      if (typeof c.email !== 'string' || !c.email) throw forbid('no email claim');
      const verified = c.email_verified === true || c.email_verified === 'true';
      if (!verified && !allowUnverifiedEmail) throw forbid('email not verified');
      return { email: c.email };
    },
    isAllowed(email) {
      return typeof email === 'string' && allow.has(email.toLowerCase());
    },
  };
}
