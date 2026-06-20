# Google OAuth Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `.env`-selected Google OAuth login mode (alternative to the password) gated by an exact-email allowlist.

**Architecture:** A single `TMUXIFIER_AUTH_MODE` switch (`password` | `google`) selects which login routes mount. Google mode uses a hand-rolled OpenID Connect authorization-code flow (Node 20 `fetch` + `crypto`, no new dependencies): `/api/auth/google/login` redirects to Google with a PKCE challenge and a signed state cookie; `/api/auth/google/callback` verifies state, exchanges the code server-to-server, reads the email from the returned `id_token`, checks the allowlist, and sets the existing `'ok'` session cookie. Everything downstream of the session cookie is unchanged — still single-user, shared boxes.

**Tech Stack:** Node 20 (ESM), Fastify 4.29, `@fastify/cookie` (signed cookies), Vitest, TypeScript + xterm.js client.

## Global Constraints

- Node 20+, ESM everywhere (`"type": "module"`). No new runtime dependencies — use built-in `fetch` and `node:crypto`.
- `loadConfig` stays pure and injectable: never read `process.env`/`process.cwd()` inside it; tests pass explicit `{ env, cwd }`.
- Server modules are factory functions with dependencies injected (testable with real code, not mocks). The only faked boundary in tests is the outbound HTTP `fetchImpl` to Google's token endpoint.
- Session cookie value stays the literal `'ok'`; cookie name `tmuxifier_session` (`COOKIE_NAME`). Signed, httpOnly, `SameSite=lax`.
- All ssh-facing fields keep their existing validation path — this feature does not touch `sshCommand.js`.
- Conventional-commit messages. Every commit ends with the trailer (per CLAUDE.md):
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Run tests with `npx vitest run <file>`; full suite with `npm test`.

---

### Task 1: Config — auth mode, email allowlist, secure-cookie-from-public-URL, startup validation

**Files:**
- Modify: `src/server/config.js`
- Modify: `src/server/index.js` (use the new validation helper)
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: existing `loadConfig(overrides, { env, cwd })`.
- Produces:
  - Config additions: `authMode: 'password' | 'google'` (default `'password'`), `publicUrl?: string`, `googleClientId?: string`, `googleClientSecret?: string`, `allowedEmails: string[]` (trimmed, lowercased), and `secureCookie: boolean` (now also true behind an `https://` `publicUrl`).
  - `requiredConfigError(config): string | null` — startup validation message, or `null` if OK.

- [ ] **Step 1: Write the failing tests** — in `test/config.test.js`, first update the existing top import to also pull in the new helper (do **not** add a second import line — re-importing `loadConfig` is a duplicate-binding error):

```js
import { loadConfig, requiredConfigError } from '../src/server/config.js';
```

Then append the new test cases:

```js
test('auth mode defaults to password; google is selectable; unknown falls back', () => {
  expect(loadConfig({}, { env: {}, cwd: '/app' }).authMode).toBe('password');
  expect(loadConfig({}, { env: { TMUXIFIER_AUTH_MODE: 'google' }, cwd: '/app' }).authMode).toBe('google');
  expect(loadConfig({}, { env: { TMUXIFIER_AUTH_MODE: 'banana' }, cwd: '/app' }).authMode).toBe('password');
});

test('allowed emails parse to a trimmed, lowercased array', () => {
  const c = loadConfig({}, { env: { TMUXIFIER_ALLOWED_EMAILS: ' Alice@Example.com , bob@foo.com ,' }, cwd: '/app' });
  expect(c.allowedEmails).toEqual(['alice@example.com', 'bob@foo.com']);
  expect(loadConfig({}, { env: {}, cwd: '/app' }).allowedEmails).toEqual([]);
});

test('https public URL marks the cookie Secure even without local TLS', () => {
  const c = loadConfig({}, { env: { TMUXIFIER_PUBLIC_URL: 'https://tmuxifier.babendums.com' }, cwd: '/app' });
  expect(c.publicUrl).toBe('https://tmuxifier.babendums.com');
  expect(c.secureCookie).toBe(true);
  const http = loadConfig({}, { env: { TMUXIFIER_PUBLIC_URL: 'http://insecure.example' }, cwd: '/app' });
  expect(http.secureCookie).toBe(false);
});

test('requiredConfigError: password mode needs a hash', () => {
  expect(requiredConfigError({ authMode: 'password', cookieSecret: 's', passwordHash: 'h' })).toBeNull();
  expect(requiredConfigError({ authMode: 'password', cookieSecret: 's', passwordHash: '' }))
    .toMatch(/set-password/);
  expect(requiredConfigError({ authMode: 'password', cookieSecret: '' })).toMatch(/COOKIE_SECRET/);
});

test('requiredConfigError: google mode lists every missing field', () => {
  const msg = requiredConfigError({ authMode: 'google', cookieSecret: 's', allowedEmails: [] });
  expect(msg).toMatch(/TMUXIFIER_GOOGLE_CLIENT_ID/);
  expect(msg).toMatch(/TMUXIFIER_GOOGLE_CLIENT_SECRET/);
  expect(msg).toMatch(/TMUXIFIER_PUBLIC_URL/);
  expect(msg).toMatch(/TMUXIFIER_ALLOWED_EMAILS/);
  expect(requiredConfigError({
    authMode: 'google', cookieSecret: 's',
    googleClientId: 'a', googleClientSecret: 'b', publicUrl: 'https://x', allowedEmails: ['a@b.com'],
  })).toBeNull();
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run test/config.test.js`
Expected: FAIL — `requiredConfigError` is not exported; `authMode`/`allowedEmails` undefined.

- [ ] **Step 3: Implement in `src/server/config.js`**

Add a helper near the top (after `clean`):

```js
function parseEmails(v) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}
```

Add these keys inside the `envCfg = clean({ ... })` object:

```js
    authMode: e.TMUXIFIER_AUTH_MODE,
    publicUrl: e.TMUXIFIER_PUBLIC_URL,
    googleClientId: e.TMUXIFIER_GOOGLE_CLIENT_ID,
    googleClientSecret: e.TMUXIFIER_GOOGLE_CLIENT_SECRET,
    allowedEmails: e.TMUXIFIER_ALLOWED_EMAILS,
```

Replace the existing `merged.secureCookie = ...` line and the `return merged;` tail with:

```js
  // Auth mode: password (default) or google. Anything else falls back to password.
  merged.authMode = merged.authMode === 'google' ? 'google' : 'password';
  merged.allowedEmails = parseEmails(merged.allowedEmails);
  // Mark the session cookie Secure when we serve HTTPS locally OR sit behind an
  // HTTPS public URL (e.g. a Cloudflare tunnel that terminates TLS at the edge).
  merged.secureCookie = !!(merged.tlsCert && merged.tlsKey) || /^https:/i.test(String(merged.publicUrl || ''));
  return merged;
}

export function requiredConfigError(config) {
  if (!config.cookieSecret) {
    return 'Missing TMUXIFIER_COOKIE_SECRET. Run: npm run set-password (password mode) or npm run gen-secret (google mode).';
  }
  if (config.authMode === 'google') {
    const missing = [];
    if (!config.googleClientId) missing.push('TMUXIFIER_GOOGLE_CLIENT_ID');
    if (!config.googleClientSecret) missing.push('TMUXIFIER_GOOGLE_CLIENT_SECRET');
    if (!config.publicUrl) missing.push('TMUXIFIER_PUBLIC_URL');
    if (!config.allowedEmails || config.allowedEmails.length === 0) missing.push('TMUXIFIER_ALLOWED_EMAILS');
    return missing.length ? `Google auth mode requires: ${missing.join(', ')}` : null;
  }
  if (!config.passwordHash) return 'Tmuxifier is not configured. Run: npm run set-password';
  return null;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run test/config.test.js`
Expected: PASS (including the pre-existing config tests).

- [ ] **Step 5: Wire the validation into `src/server/index.js`**

Change the import and the fail-fast block:

```js
import { loadConfig, requiredConfigError } from './config.js';
```

Replace:

```js
const config = loadConfig();
if (!config.passwordHash || !config.cookieSecret) {
  console.error('Tmuxifier is not configured. Run: npm run set-password');
  process.exit(1);
}
```

with:

```js
const config = loadConfig();
const cfgError = requiredConfigError(config);
if (cfgError) {
  console.error(cfgError);
  process.exit(1);
}
```

- [ ] **Step 6: Confirm the full suite still passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/config.js src/server/index.js test/config.test.js
git commit -m "feat(config): auth-mode switch, email allowlist, public-URL secure cookie"
```

---

### Task 2: `googleAuth.js` — OIDC helper module

**Files:**
- Create: `src/server/googleAuth.js`
- Test: `test/googleAuth.test.js`

**Interfaces:**
- Produces:
  - `base64url(buf): string`
  - `pkcePair(): { verifier: string, challenge: string }` — `challenge = base64url(sha256(verifier))`
  - `randomState(): string`
  - `createGoogleAuth({ clientId, clientSecret, redirectUri, allowedEmails, fetchImpl }) => { authorizationUrl({ state, codeChallenge }): string, exchangeCodeForEmail({ code, codeVerifier }): Promise<{ email, emailVerified }>, isAllowed(email): boolean }`
- Consumes (later tasks): `server.js` constructs `createGoogleAuth` and calls all three methods plus `pkcePair`/`randomState`.

- [ ] **Step 1: Write the failing tests** — create `test/googleAuth.test.js`:

```js
import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createGoogleAuth, pkcePair, randomState, base64url } from '../src/server/googleAuth.js';

function makeIdToken(payload) {
  const h = base64url(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })));
  const p = base64url(Buffer.from(JSON.stringify(payload)));
  return `${h}.${p}.sig`;
}

test('pkcePair challenge is the S256 hash of the verifier', () => {
  const { verifier, challenge } = pkcePair();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  const expected = base64url(createHash('sha256').update(verifier).digest());
  expect(challenge).toBe(expected);
  expect(randomState()).not.toBe(randomState());
});

test('authorizationUrl carries the OIDC + PKCE params', () => {
  const g = createGoogleAuth({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb', allowedEmails: [] });
  const u = new URL(g.authorizationUrl({ state: 'ST', codeChallenge: 'CH' }));
  expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(u.searchParams.get('client_id')).toBe('cid');
  expect(u.searchParams.get('redirect_uri')).toBe('https://x/cb');
  expect(u.searchParams.get('response_type')).toBe('code');
  expect(u.searchParams.get('scope')).toBe('openid email');
  expect(u.searchParams.get('state')).toBe('ST');
  expect(u.searchParams.get('code_challenge')).toBe('CH');
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
});

test('exchangeCodeForEmail posts the code+verifier and decodes the id_token', async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, json: async () => ({ id_token: makeIdToken({ email: 'Alice@Example.com', email_verified: true }) }) };
  };
  const g = createGoogleAuth({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/cb', allowedEmails: [], fetchImpl });
  const r = await g.exchangeCodeForEmail({ code: 'abc', codeVerifier: 'ver' });
  expect(r).toEqual({ email: 'Alice@Example.com', emailVerified: true });
  expect(captured.url).toBe('https://oauth2.googleapis.com/token');
  const body = new URLSearchParams(captured.opts.body);
  expect(body.get('code')).toBe('abc');
  expect(body.get('code_verifier')).toBe('ver');
  expect(body.get('grant_type')).toBe('authorization_code');
  expect(body.get('client_secret')).toBe('sec');
});

test('exchangeCodeForEmail throws on a non-OK token response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({}) });
  const g = createGoogleAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', allowedEmails: [], fetchImpl });
  await expect(g.exchangeCodeForEmail({ code: 'x', codeVerifier: 'y' })).rejects.toThrow();
});

test('isAllowed is case-insensitive and rejects unlisted addresses', () => {
  const g = createGoogleAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb', allowedEmails: ['alice@example.com'] });
  expect(g.isAllowed('ALICE@Example.com')).toBe(true);
  expect(g.isAllowed('bob@example.com')).toBe(false);
  expect(g.isAllowed(undefined)).toBe(false);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run test/googleAuth.test.js`
Expected: FAIL — module `src/server/googleAuth.js` does not exist.

- [ ] **Step 3: Implement `src/server/googleAuth.js`**

```js
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
// is trusted without a JWKS signature check (the accepted practice for code flow).
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
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run test/googleAuth.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/googleAuth.js test/googleAuth.test.js
git commit -m "feat(auth): hand-rolled Google OIDC helper (PKCE, allowlist)"
```

---

### Task 3: Server — `/api/auth/info` and password-mode gating

**Files:**
- Modify: `src/server/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: existing `buildServer({ config, store, sessions, statusChecker })`; `config.authMode`.
- Produces: `GET /api/auth/info` → `{ mode: 'password' | 'google' }` (public). `POST /api/login` mounts only when `config.authMode !== 'google'`.

- [ ] **Step 1: Write the failing test** — append to `test/server.test.js`:

```js
test('/api/auth/info reports password mode', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/info' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ mode: 'password' });
});
```

(The existing `makeApp` builds a config with no `authMode`, which must behave as password mode.)

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run test/server.test.js`
Expected: FAIL — `/api/auth/info` 404 (route not defined).

- [ ] **Step 3: Implement in `src/server/server.js`**

Add the public info route (place it just above the existing `app.post('/api/login', ...)`):

```js
  app.get('/api/auth/info', async () => ({ mode: config.authMode === 'google' ? 'google' : 'password' }));
```

Wrap the existing `app.post('/api/login', ...)` handler so it only mounts outside google mode:

```js
  if (config.authMode !== 'google') {
    app.post('/api/login', async (req, reply) => {
      // ...existing body unchanged...
    });
  }
```

- [ ] **Step 4: Run the suite to confirm it passes**

Run: `npx vitest run test/server.test.js`
Expected: PASS (existing login/CRUD tests still green; new info test passes).

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/server.test.js
git commit -m "feat(server): public /api/auth/info and password-mode gating"
```

---

### Task 4: Server — Google login + callback routes

**Files:**
- Modify: `src/server/server.js`
- Test: `test/server.google.test.js`

**Interfaces:**
- Consumes: `createGoogleAuth`, `pkcePair`, `randomState` from `googleAuth.js`; `COOKIE_NAME`, `cookieOptions` from `auth.js`.
- Produces:
  - `buildServer({ config, store, sessions, statusChecker, googleAuth })` — new optional `googleAuth` param (tests inject a real `createGoogleAuth` with a fake `fetchImpl`; production builds it from `config`).
  - `GET /api/auth/google/login` → 302 to Google, sets signed `tmuxifier_oauth` cookie (`state.verifier`, `SameSite=lax`, `maxAge` 300).
  - `GET /api/auth/google/callback` → on success sets the `'ok'` session cookie and 302 to `/`; on failure 302 to `/?error=state|google|forbidden`.

- [ ] **Step 1: Write the failing tests** — create `test/server.google.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createGoogleAuth, base64url } from '../src/server/googleAuth.js';

function makeIdToken(payload) {
  const h = base64url(Buffer.from(JSON.stringify({ alg: 'none' })));
  const p = base64url(Buffer.from(JSON.stringify(payload)));
  return `${h}.${p}.sig`;
}

async function makeApp({ email = 'alice@example.com', emailVerified = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-goog-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    authMode: 'google', cookieSecret: 'test-secret', secureCookie: false,
    publicUrl: 'https://tmux.example.com',
    googleClientId: 'cid', googleClientSecret: 'csecret', allowedEmails: ['alice@example.com'],
    dataDir: dir, sshConfigPath: path.join(dir, 'nope'),
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ id_token: makeIdToken({ email, email_verified: emailVerified }) }) });
  const googleAuth = createGoogleAuth({
    clientId: config.googleClientId, clientSecret: config.googleClientSecret,
    redirectUri: 'https://tmux.example.com/api/auth/google/callback',
    allowedEmails: config.allowedEmails, fetchImpl,
  });
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const statusChecker = { checkBox: async () => ({ reachable: true }) };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  return buildServer({ config, store, sessions, statusChecker, googleAuth });
}

// Drive /login, then call /callback with the captured cookie + state.
async function flow(app, { state, tamperState = false } = {}) {
  const login = await app.inject({ method: 'GET', url: '/api/auth/google/login' });
  const oauth = login.cookies.find((c) => c.name === 'tmuxifier_oauth');
  const sentState = state ?? new URL(login.headers.location).searchParams.get('state');
  const useState = tamperState ? 'WRONG' : sentState;
  const cb = await app.inject({
    method: 'GET',
    url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(useState)}`,
    headers: { cookie: `tmuxifier_oauth=${oauth.value}` },
  });
  return { login, oauth, cb };
}

let app;
beforeEach(async () => { app = await makeApp(); });

test('/api/auth/info reports google mode and /api/login is gone', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/auth/info' })).json()).toEqual({ mode: 'google' });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'x' } });
  expect(login.statusCode).toBe(404);
});

test('login redirects to Google and sets the signed oauth cookie', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/google/login' });
  expect(res.statusCode).toBe(302);
  expect(res.headers.location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
  expect(res.cookies.find((c) => c.name === 'tmuxifier_oauth')).toBeTruthy();
});

test('callback with valid state + allowed email sets the session cookie', async () => {
  const { cb } = await flow(app);
  expect(cb.statusCode).toBe(302);
  expect(cb.headers.location).toBe('/');
  expect(cb.cookies.find((c) => c.name === 'tmuxifier_session')).toBeTruthy();
});

test('callback with a mismatched state is rejected', async () => {
  const { cb } = await flow(app, { tamperState: true });
  expect(cb.headers.location).toBe('/?error=state');
  expect(cb.cookies.find((c) => c.name === 'tmuxifier_session')).toBeFalsy();
});

test('callback with a disallowed email is forbidden', async () => {
  app = await makeApp({ email: 'mallory@evil.com' });
  const { cb } = await flow(app);
  expect(cb.headers.location).toBe('/?error=forbidden');
  expect(cb.cookies.find((c) => c.name === 'tmuxifier_session')).toBeFalsy();
});

test('callback with an unverified email is forbidden', async () => {
  app = await makeApp({ emailVerified: false });
  const { cb } = await flow(app);
  expect(cb.headers.location).toBe('/?error=forbidden');
});

test('callback with no oauth cookie is rejected as state error', async () => {
  const cb = await app.inject({ method: 'GET', url: '/api/auth/google/callback?code=abc&state=ST' });
  expect(cb.headers.location).toBe('/?error=state');
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run test/server.google.test.js`
Expected: FAIL — google routes not defined; `buildServer` ignores `googleAuth`.

- [ ] **Step 3: Implement in `src/server/server.js`**

Update the import line to add the helpers:

```js
import { verifyPassword, COOKIE_NAME, cookieOptions } from './auth.js';
import { createGoogleAuth, pkcePair, randomState } from './googleAuth.js';
```

Add `googleAuth` to the signature:

```js
export function buildServer({ config, store, sessions, statusChecker, googleAuth }) {
```

Just after `app.register(websocket);`, build the Google client for production (tests inject one):

```js
  const OAUTH_COOKIE = 'tmuxifier_oauth';
  let google = googleAuth;
  if (config.authMode === 'google' && !google) {
    google = createGoogleAuth({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      redirectUri: `${String(config.publicUrl).replace(/\/+$/, '')}/api/auth/google/callback`,
      allowedEmails: config.allowedEmails,
    });
  }
```

Add the two routes (place them right after the `if (config.authMode !== 'google') { app.post('/api/login', ...) }` block from Task 3):

```js
  if (config.authMode === 'google') {
    app.get('/api/auth/google/login', async (req, reply) => {
      const state = randomState();
      const { verifier, challenge } = pkcePair();
      // state + PKCE verifier ride in one short-lived signed cookie. SameSite=lax
      // (not strict) so it survives the top-level redirect back from Google.
      reply.setCookie(OAUTH_COOKIE, `${state}.${verifier}`, {
        httpOnly: true, sameSite: 'lax', secure: config.secureCookie, path: '/', signed: true, maxAge: 300,
      });
      return reply.redirect(google.authorizationUrl({ state, codeChallenge: challenge }));
    });

    app.get('/api/auth/google/callback', async (req, reply) => {
      const raw = req.cookies?.[OAUTH_COOKIE];
      reply.clearCookie(OAUTH_COOKIE, { path: '/' });
      if (!raw) return reply.redirect('/?error=state');
      const unsigned = app.unsignCookie(raw);
      if (!unsigned.valid || !unsigned.value) return reply.redirect('/?error=state');
      const [savedState, verifier] = unsigned.value.split('.');
      const { code, state } = req.query;
      if (!code || !state || state !== savedState) return reply.redirect('/?error=state');
      let result;
      try {
        result = await google.exchangeCodeForEmail({ code, codeVerifier: verifier });
      } catch {
        return reply.redirect('/?error=google');
      }
      if (!result.emailVerified || !google.isAllowed(result.email)) return reply.redirect('/?error=forbidden');
      reply.setCookie(COOKIE_NAME, 'ok', cookieOptions(config.secureCookie));
      return reply.redirect('/');
    });
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run test/server.google.test.js`
Expected: PASS.

- [ ] **Step 5: Confirm the full suite still passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js test/server.google.test.js
git commit -m "feat(server): Google OAuth login + callback routes"
```

---

### Task 5: `gen-secret` script — cookie secret without a password

**Files:**
- Create: `scripts/gen-secret.js`
- Modify: `package.json` (scripts)
- Test: `test/gen-secret.test.js`

**Interfaces:**
- Produces: `ensureCookieSecret(file, { makeSecret }): { wrote: boolean }` — writes `TMUXIFIER_COOKIE_SECRET` only if absent. `npm run gen-secret`.

- [ ] **Step 1: Write the failing tests** — create `test/gen-secret.test.js`:

```js
import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCookieSecret } from '../scripts/gen-secret.js';
import { readEnvFile } from '../src/server/envFile.js';

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-secret-'));
  return path.join(dir, '.env');
}

test('writes a cookie secret on a fresh .env', () => {
  const file = tmpEnv();
  const r = ensureCookieSecret(file, { makeSecret: () => 'SECRET1' });
  expect(r.wrote).toBe(true);
  expect(readEnvFile(file).TMUXIFIER_COOKIE_SECRET).toBe('SECRET1');
});

test('leaves an existing cookie secret untouched and preserves other keys', () => {
  const file = tmpEnv();
  fs.writeFileSync(file, 'TMUXIFIER_COOKIE_SECRET=KEEP\nTMUXIFIER_PORT=9000\n');
  const r = ensureCookieSecret(file, { makeSecret: () => 'NOPE' });
  expect(r.wrote).toBe(false);
  const env = readEnvFile(file);
  expect(env.TMUXIFIER_COOKIE_SECRET).toBe('KEEP');
  expect(env.TMUXIFIER_PORT).toBe('9000');
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx vitest run test/gen-secret.test.js`
Expected: FAIL — `scripts/gen-secret.js` does not exist.

- [ ] **Step 3: Implement `scripts/gen-secret.js`**

```js
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEnvFile, upsertEnvFile } from '../src/server/envFile.js';

// Google auth mode still needs TMUXIFIER_COOKIE_SECRET to sign the session and
// oauth cookies, but set-password only generates it alongside a password. This
// writes the secret on its own, only when one is not already present.
export function ensureCookieSecret(file, { makeSecret = () => randomBytes(32).toString('hex') } = {}) {
  if (readEnvFile(file).TMUXIFIER_COOKIE_SECRET) return { wrote: false };
  upsertEnvFile(file, { TMUXIFIER_COOKIE_SECRET: makeSecret() });
  return { wrote: true };
}

async function main() {
  const file = path.join(process.cwd(), '.env');
  const { wrote } = ensureCookieSecret(file);
  console.log(wrote ? 'Wrote a new cookie secret to .env.' : '.env already has a cookie secret; left it unchanged.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
```

- [ ] **Step 4: Add the npm script** in `package.json`, after the `"set-password"` line:

```json
    "set-password": "node scripts/hash-password.js",
    "gen-secret": "node scripts/gen-secret.js"
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run test/gen-secret.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-secret.js package.json test/gen-secret.test.js
git commit -m "feat(scripts): gen-secret to seed the cookie secret for google mode"
```

---

### Task 6: Web client — branch the login screen on auth mode

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/main.ts`
- Modify: `src/web/style.css` (Google button styling)

**Interfaces:**
- Consumes: `GET /api/auth/info` → `{ mode }`; `GET /api/auth/google/login` (navigated to, not fetched).
- Produces: `api.authInfo(): Promise<{ mode: 'password' | 'google' }>`; an async `renderLogin()` that shows the password form (password mode) or a "Sign in with Google" link (google mode), and surfaces `?error=` messages.

- [ ] **Step 1: Add the API call** in `src/web/api.ts`, inside the `api` object (after `me`):

```ts
  async authInfo() { return j<{ mode: 'password' | 'google' }>(await fetch('/api/auth/info')); },
```

- [ ] **Step 2: Rewrite `renderLogin` in `src/web/main.ts`** to be async and mode-aware. Replace the entire existing `renderLogin` function with:

```ts
function readLoginError(): string {
  const code = new URLSearchParams(location.search).get('error');
  if (!code) return '';
  history.replaceState(null, '', location.pathname);
  return code === 'forbidden' ? 'This Google account is not allowed.'
    : code === 'google' ? 'Google sign-in failed. Please try again.'
    : code === 'state' ? 'Login session expired. Please try again.'
    : 'Sign-in failed. Please try again.';
}

async function renderLogin() {
  let mode: 'password' | 'google' = 'password';
  try { mode = (await api.authInfo()).mode; } catch {}
  const err = readLoginError();
  if (mode === 'google') {
    app.innerHTML = `<div class="login">
        <h1>Tmuxifier</h1>
        <a id="gsignin" class="gbtn" href="/api/auth/google/login">Sign in with Google</a>
        <p id="err" class="err">${err}</p>
      </div>`;
    return;
  }
  app.innerHTML = `<form id="login" class="login">
      <h1>Tmuxifier</h1>
      <input id="pw" type="password" placeholder="Password" autofocus />
      <button>Unlock</button>
      <p id="err" class="err">${err}</p>
    </form>`;
  app.querySelector('#login')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api.login((app.querySelector('#pw') as HTMLInputElement).value); renderDashboard(); }
    catch { (app.querySelector('#err') as HTMLElement).textContent = 'Invalid password'; }
  });
}
```

- [ ] **Step 3: Await `renderLogin` at the call sites** in `src/web/main.ts`:
  - In `start()`: change `else renderLogin();` to `else await renderLogin();`
  - In the `#logout` click handler: change `await api.logout(); renderLogin();` to `await api.logout(); await renderLogin();`

- [ ] **Step 4: Style the Google button** — append to `src/web/style.css`:

```css
.gbtn {
  display: inline-block;
  padding: 0.6rem 1rem;
  border-radius: 6px;
  background: #fff;
  color: #1f1f1f;
  font-weight: 600;
  text-decoration: none;
  border: 1px solid #dadce0;
}
.gbtn:hover { background: #f7f8f8; }
```

- [ ] **Step 5: Build to confirm it compiles**

Run: `npm run build`
Expected: build succeeds, `dist/` regenerated, no errors.

- [ ] **Step 6: Manual verification** — start a throwaway google-mode server and check the login screen:

```bash
TMUXIFIER_AUTH_MODE=google TMUXIFIER_PUBLIC_URL=https://example.com \
TMUXIFIER_GOOGLE_CLIENT_ID=dummy TMUXIFIER_GOOGLE_CLIENT_SECRET=dummy \
TMUXIFIER_ALLOWED_EMAILS=you@example.com \
TMUXIFIER_COOKIE_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
TMUXIFIER_BIND=127.0.0.1 TMUXIFIER_PORT=7500 node src/server/index.js &
sleep 1
curl -s http://127.0.0.1:7500/api/auth/info            # expect {"mode":"google"}
curl -si http://127.0.0.1:7500/api/auth/google/login | grep -i -E 'location|set-cookie'  # 302 to accounts.google.com + tmuxifier_oauth cookie
kill %1
```

Then open `http://127.0.0.1:7500/` in a browser and confirm the "Sign in with Google" button renders (it's drawn by JS after `/api/auth/info`). Expected: button visible, no password field.

- [ ] **Step 7: Commit**

```bash
git add src/web/api.ts src/web/main.ts src/web/style.css
git commit -m "feat(ui): mode-aware login screen with Google sign-in button"
```

---

### Task 7: Documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/DEPLOY.md`
- Modify: `CLAUDE.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the auth keys to `.env.example`** — insert after the `# --- Required ...` block (before `# --- Network ---`):

```bash
# --- Auth mode ---------------------------------------------------------------
# 'password' (default) or 'google'. In google mode the password login is gone.
#TMUXIFIER_AUTH_MODE=password

# --- Google OAuth (required when TMUXIFIER_AUTH_MODE=google) ------------------
# Public HTTPS URL users reach (also builds the OAuth redirect URI and marks the
# session cookie Secure behind a TLS-terminating proxy like a Cloudflare tunnel).
#TMUXIFIER_PUBLIC_URL=https://tmuxifier.babendums.com
# OAuth client from Google Cloud Console (see docs/DEPLOY.md).
#TMUXIFIER_GOOGLE_CLIENT_ID=
#TMUXIFIER_GOOGLE_CLIENT_SECRET=
# Comma-separated exact emails allowed to sign in (case-insensitive).
#TMUXIFIER_ALLOWED_EMAILS=you@example.com,teammate@example.com
```

- [ ] **Step 2: Document auth modes in `README.md`** — add a "Authentication" section covering: the `TMUXIFIER_AUTH_MODE` switch; password setup via `npm run set-password`; google setup (run `npm run gen-secret` for the cookie secret, set the five `TMUXIFIER_*` google keys, register the redirect URI `https://tmuxifier.babendums.com/api/auth/google/callback` in Google Cloud Console); and that the allowlist is exact emails, case-insensitive.

- [ ] **Step 3: Add a Google + Cloudflare note to `docs/DEPLOY.md`** — a subsection explaining:
  - In Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID** (type *Web application*), authorized redirect URI `https://tmuxifier.babendums.com/api/auth/google/callback`; copy the client id/secret into `.env`.
  - Set `TMUXIFIER_PUBLIC_URL=https://tmuxifier.babendums.com`; this marks the session cookie `Secure` even though TLS terminates at Cloudflare and the origin may speak plain HTTP.
  - Run `npm run gen-secret` to generate the cookie secret without setting a password.

- [ ] **Step 4: Update `CLAUDE.md` security notes** — extend the auth/security bullets: the `TMUXIFIER_AUTH_MODE` switch (`password` | `google`, mutually exclusive); the hand-rolled OIDC flow in `googleAuth.js` (PKCE + state cookie, id_token trusted because fetched server-to-server); the exact-email allowlist; and that `secureCookie` is now derived from local TLS **or** an `https://` `TMUXIFIER_PUBLIC_URL`.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md docs/DEPLOY.md CLAUDE.md
git commit -m "docs(auth): document google mode, allowlist, and Cloudflare setup"
```

---

## Notes for the implementer

- **Why the oauth cookie is `state.verifier` (not JSON):** both values are base64url (no `.`, `,`, or `;`), so the signed cookie round-trips through browsers and `app.inject` without URL-encoding surprises. Split on `.` after `unsignCookie`.
- **Why no JWKS verification:** the `id_token` is fetched server-to-server from Google's token endpoint over TLS, never via the browser — its payload is trusted for the authorization-code flow. (Documented in `googleAuth.js` and the spec's §2 / out-of-scope.)
- **`npm run build` does not typecheck** (Vite/esbuild strips types). Task 6 relies on a successful build plus the manual browser check — there is no DOM unit-test harness in this repo.
- Spec: `docs/superpowers/specs/2026-06-20-google-oauth-design.md`.
