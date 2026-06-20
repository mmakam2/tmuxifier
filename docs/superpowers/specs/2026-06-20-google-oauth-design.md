# Google OAuth Login — Design

**Date:** 2026-06-20
**Status:** Approved

## Goal

Add Google sign-in as an alternative to the password login. A single `.env`
switch selects the active mode; in Google mode, only accounts whose email is on
an allowlist in `.env` may log in. The deployment is fronted by a Cloudflare
tunnel at `https://tmuxifier.babendums.com` (TLS terminates at Cloudflare; the
local server speaks plain HTTP).

## Current state

- `auth.js` — scrypt password hashing + `cookieOptions(secure)` for the signed,
  httpOnly, `SameSite=lax` session cookie (`COOKIE_NAME`).
- `server.js` — `POST /api/login` verifies the password and sets the session
  cookie to the literal value `'ok'`; `isAuthed` checks that cookie. All box
  routes and the `/term` WebSocket gate on it.
- `config.js` — `secureCookie = !!(tlsCert && tlsKey)`; cookie is `Secure` only
  when local TLS is configured.
- `index.js` — fails fast unless `passwordHash` **and** `cookieSecret` are set.
- Web (`main.ts`) — renders a password form, posts to `/api/login`.

Single-user model throughout: once the `'ok'` cookie is set, every box is
shared. OAuth does not change that — the allowlist is just the entry gate.

## Decisions (settled in brainstorming)

- **Mode is exclusive.** `password` (default) **or** `google`, never both. In
  Google mode the password path does not exist (no break-glass).
- **Allowlist is exact emails only**, case-insensitive. No domain wildcards.
- **Hand-rolled OIDC**, no new dependencies — Node 20 `fetch` + `crypto`. Matches
  the project's dependency-light ethos.
- Cloudflare Access (offloading auth to the edge) was considered and rejected: it
  moves auth config out of `.env`, contradicting the self-contained principle and
  the stated requirement.

## Design

### 1. Configuration (`config.js`, `.env.example`)

New `TMUXIFIER_*` knobs, folded into `loadConfig` on the existing pure/injectable
path:

| Key | Meaning |
|-----|---------|
| `TMUXIFIER_AUTH_MODE` | `password` (default) \| `google` |
| `TMUXIFIER_PUBLIC_URL` | e.g. `https://tmuxifier.babendums.com` — builds the OAuth `redirect_uri` and marks the cookie `Secure` when its scheme is https |
| `TMUXIFIER_GOOGLE_CLIENT_ID` | OAuth client id |
| `TMUXIFIER_GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `TMUXIFIER_ALLOWED_EMAILS` | comma-separated; parsed to a trimmed, lowercased array |

Derived in `loadConfig`:
- `authMode` (validated to `password`|`google`; unknown → `password`).
- `allowedEmails` — array.
- `secureCookie = !!(tlsCert && tlsKey) || /^https:/i.test(publicUrl)`. **This is
  the key tunnel fix:** the browser↔Cloudflare leg is HTTPS even though the local
  server has no TLS, so the cookie must be `Secure` without `tlsCert`/`tlsKey`.

`loadConfig` stays pure (no `process.env`/`cwd` reads); tests pass `{ env, cwd }`.

### 2. `googleAuth.js` (new module)

Factory `createGoogleAuth({ clientId, clientSecret, redirectUri, allowedEmails,
fetchImpl = fetch })` — `fetchImpl` injected so tests run real code against a fake
token endpoint (no network, no mocks of our own code).

- `authorizationUrl({ state, codeChallenge })` → Google authorize URL.
  Scopes `openid email`; `response_type=code`; PKCE `code_challenge` +
  `code_challenge_method=S256`; `redirect_uri`.
- `exchangeCodeForEmail({ code, codeVerifier })` → POST `application/x-www-form-
  urlencoded` to `https://oauth2.googleapis.com/token`, decode the returned
  `id_token` JWT **payload** (base64url, no signature check — trusted because it
  is fetched server-to-server over TLS directly from Google, the accepted
  practice for the authorization-code flow), return `{ email, emailVerified }`.
- `isAllowed(email)` → `allowedEmails.includes(email.toLowerCase())`.

PKCE included (cheap, best practice): `code_verifier` = random base64url,
`code_challenge` = base64url(sha256(verifier)).

### 3. Routes (`server.js`)

Mounted **only when `authMode === 'google'`**:

- `GET /api/auth/google/login` — generate `state` + `codeVerifier`; store both in
  a short-lived (≈300s) signed, httpOnly, `SameSite=lax` cookie
  (`tmuxifier_oauth`); 302 to `authorizationUrl`. (`lax`, not `strict`, so the
  cookie survives the top-level redirect back from Google.)
- `GET /api/auth/google/callback` — read `state`+`codeVerifier` from the cookie,
  require it matches the returned `state`; `exchangeCodeForEmail`; require
  `emailVerified === true` **and** `isAllowed(email)`; on success clear the oauth
  cookie, set the `'ok'` session cookie via `cookieOptions(secureCookie)`, 302 to
  `/`. On any failure 302 to `/?error=state|google|forbidden`.

Mounted **only when `authMode === 'password'`**: existing `POST /api/login`
(returns 404 in google mode).

Always mounted: `GET /api/auth/info` (public) → `{ mode }`, so the login screen
knows what to render. `/api/me`, `/api/logout`, `/api/boxes*`, `/api/status`,
`/api/import`, `/term` unchanged.

### 4. Fail-fast (`index.js`)

Mode-aware startup validation, each with a clear message:
- Always require `cookieSecret`.
- `password` mode: require `passwordHash`.
- `google` mode: require `googleClientId`, `googleClientSecret`, `publicUrl`, and
  a non-empty `allowedEmails`.

`buildServer` receives `authMode` and the google config and wires routes
accordingly; it constructs `createGoogleAuth` (with `redirectUri` =
`${publicUrl}/api/auth/google/callback`) in google mode.

### 5. Cookie secret without a password (`scripts/`, `package.json`)

Google mode still needs `TMUXIFIER_COOKIE_SECRET` to sign the session + oauth
cookies, but `set-password` only generates it alongside a password. Add
`npm run gen-secret` (`scripts/gen-secret.js`) that writes
`TMUXIFIER_COOKIE_SECRET` via `upsertEnvFile` only if absent — so google-mode
setup needs no throwaway password. Factor the secret-write so it is shared with
`hash-password.js`.

### 6. Web client (`main.ts`, `api.ts`)

- `api.authInfo()` → `GET /api/auth/info`.
- `renderLogin()` calls it: `password` mode → current form; `google` mode → a
  "Sign in with Google" button that navigates to `/api/auth/google/login`.
- On load, read `?error=` and show a message (`forbidden` → "This Google account
  isn't allowed", etc.), then strip the query param.

### 7. Documentation

- `.env.example` — new keys with comments, grouped under an auth section.
- `README.md` — auth-mode section (password vs google), allowlist, the redirect
  URI to register, `gen-secret`.
- `docs/DEPLOY.md` — Cloudflare-tunnel + Google Cloud Console setup note:
  authorized redirect URI `https://tmuxifier.babendums.com/api/auth/google/
  callback`, `TMUXIFIER_PUBLIC_URL`, and why the cookie is `Secure` without local
  TLS.
- `CLAUDE.md` — extend the auth/security notes with the mode switch and the
  publicUrl→secureCookie derivation.

### 8. Tests (TDD, real code + injected `fetch`)

- **config**: default mode `password`; `secureCookie` true for https `publicUrl`
  without TLS; `allowedEmails` parsed/trimmed/lowercased; unknown mode → password.
- **googleAuth**: `authorizationUrl` carries client id, redirect, scopes, PKCE
  challenge, state; `exchangeCodeForEmail` posts the right body and returns the
  decoded email; `isAllowed` case-insensitive; rejects unverified email.
- **server routes** (`fastify.inject`, fake `fetchImpl`): login 302s to Google and
  sets the oauth cookie; callback with valid state+code sets the session cookie;
  bad/missing state → `/?error=state`; disallowed or unverified email →
  `/?error=forbidden`; `/api/login` 404 in google mode; `/api/auth/info` returns
  the mode.

## Out of scope

- Per-user data or multi-user separation — still single-user, shared boxes.
- Refresh tokens / long-lived Google sessions — we only read the email once at
  login; session lifetime is the existing 7-day signed cookie.
- id_token JWKS signature verification — unnecessary for code obtained
  server-to-server over TLS (see §2).
- Proxy-IP trust for rate-limiting. Behind the tunnel all requests appear from
  `127.0.0.1`, so the password rate-limiter keys one global bucket — but google
  mode removes the password login entirely, so there is nothing to brute-force.
  Not added unless requested later.

## Decisions log

- Mode exclusive, no break-glass password in google mode — confirmed with user.
- Exact-email allowlist, no domain wildcards — confirmed with user.
- Hand-rolled OIDC over a library — recommended and approved (Approach A).
