import { createHash, randomBytes } from 'node:crypto';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

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

function decodeIdTokenEmail(idToken) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return { email: payload.email, emailVerified: payload.email_verified === true || payload.email_verified === 'true' };
}

// Hand-rolled Google OpenID Connect (authorization-code + PKCE). The id_token is
// fetched server-to-server from Google's token endpoint over TLS, so its payload
// is trusted without a JWKS signature check for this single-user gate.
export function createGoogleAuth({ clientId, clientSecret, redirectUri, allowedEmails = [], fetchImpl = fetch }) {
  const allow = new Set(allowedEmails.map((e) => String(e).toLowerCase()));
  return {
    authorizationUrl({ state, codeChallenge }) {
      const u = new URL(AUTH_ENDPOINT);
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', 'openid email');
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', codeChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('access_type', 'online');
      u.searchParams.set('prompt', 'select_account');
      return u.toString();
    },
    async exchangeCodeForEmail({ code, codeVerifier }) {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      });
      const res = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        // fetch has no default timeout — without this, a hung token endpoint
        // pins the OAuth callback request forever.
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
      const data = await res.json();
      if (!data.id_token) throw new Error('no id_token in token response');
      return decodeIdTokenEmail(data.id_token);
    },
    isAllowed(email) {
      return typeof email === 'string' && allow.has(email.toLowerCase());
    },
  };
}
