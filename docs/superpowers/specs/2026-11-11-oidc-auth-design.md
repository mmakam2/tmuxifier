# Generic OIDC sign-in (authentik, Google, …) with auto-redirect and break-glass

**Date:** 2026-11-11
**Status:** draft design, builder-checked 2026-11-11, pending operator approval
**Supersedes:** the earlier OIDC branch (scrapped — too far behind main; nothing is carried over)

## Problem

The operator wants authentik (an OpenID Connect provider) to be the gate in front of
Tmuxifier instead of the local password. Today the only external sign-in is
`TMUXIFIER_AUTH_MODE=oauth` (legacy alias `google`), which is Google-only: endpoints are
hard-coded in `src/server/googleAuth.js`. Other deployments already use that Google sign-in and
must keep working unchanged.

## Goals

- Sign in through any standards-compliant OIDC provider, configured by issuer URL + client
  id/secret (authentik is the driving case).
- One or more providers on one instance; providers are a configured list.
- Existing Google deployments keep working with **no config edits** and no change to the
  redirect URI registered in Google Cloud Console.
- With exactly one provider configured, opening the app signed out sends the browser straight
  to that provider.
- A break-glass path that never depends on the provider: `/?login` shows the full login page
  (provider buttons, passkeys, and — when a password hash is set — the password form).

## Non-goals

- Logging out of the provider (RP-initiated logout). Logout is local-only (see §6).
- Group/role-claim authorization. Access is the email allowlist; groups can come later.
- A Settings UI for providers. Config lives in `.env` / `config.json` only.
- Forward-auth / proxy-header auth (authentik outpost in front). This is an OIDC client.
- Changing device-token (Android/MCP) enrollment beyond what §7 states.

## Anti-goals (what would make this a failure even if it works)

- An existing Google deployment breaks, or its users must re-register a redirect URI.
- A misconfigured provider (e.g. authentik app not restricted to the operator) lets a stranger
  in. The email allowlist stays mandatory for every provider.
- Auto-redirect that traps the operator: a redirect loop after logout or a failed callback, or
  no way in when authentik is down.
- The break-glass password silently becomes the normal login path or widens device enrollment.

## Design

### 1. Modes and config

`TMUXIFIER_AUTH_MODE` accepts `password` (default) or `oidc`; `oauth` and `google` remain
accepted aliases of `oidc`. Internally `config.authMode` becomes `'oidc'` (today it is
normalized to `'google'`; every `=== 'google'` check in `server.js`, `config.js`,
`/api/auth/info` and the web client moves to `'oidc'`).

`config.oidcProviders` is a normalized array of
`{ id, label, issuer, clientId, clientSecret, scopes, extraAuthParams, allowUnverifiedEmail }`:

- **`config.json`:** `oidcProviders: [{ id, label, issuer, clientId, clientSecret }]`.
- **`.env`:** `TMUXIFIER_OIDC_PROVIDERS=authentik,google` (ordered id list), then per id
  `TMUXIFIER_OIDC_<ID>_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, optional `_LABEL` and
  `_ALLOW_UNVERIFIED_EMAIL=on` (`<ID>` = id upper-cased, `-` → `_`).
- **Merging (designer's call):** if `TMUXIFIER_OIDC_PROVIDERS` is set it defines the list and
  its order; otherwise the `config.json` array does. For each listed id, fields come from the
  `config.json` entry with that id, overridden per field by `TMUXIFIER_OIDC_<ID>_*`. A provider
  only in `config.json` and not in a set env list is dropped (logged at boot).
- **Legacy Google (implicit provider):** when the mode is `oidc` and
  `TMUXIFIER_OAUTH_CLIENT_ID`/`_SECRET` (or `TMUXIFIER_GOOGLE_CLIENT_ID`/`_SECRET`) are set and
  no provider with id `google` is otherwise configured, append
  `{ id: 'google', label: 'Google', issuer: 'https://accounts.google.com', … }`. If an explicit
  `google` provider exists too, it wins and boot logs a warning that the legacy keys are
  ignored. `config.json`'s legacy `googleClientId`/`googleClientSecret` keys feed the implicit
  provider exactly like the env keys.
- **Validation (extend `requiredConfigError` in `config.js`, after its existing
  `cookieSecret`/`rpIdError` checks; fail fast at boot):** ≥1 provider; ids match
  `^[a-z0-9][a-z0-9-]{0,31}$` and are unique; issuer is an absolute `https://` URL
  (`http://` allowed only for a loopback host, for tests); client id/secret non-empty;
  `TMUXIFIER_ALLOWED_EMAILS` non-empty; `TMUXIFIER_BASE_EXTERNAL_URL` set (as today).
- Provider ids are the closed allowlist for routes: a request naming an unknown id is 404,
  nothing user-typed reaches a URL beyond that lookup.

### 2. OIDC client (`src/server/oidcAuth.js`, replaces `googleAuth.js`)

Dependency-free, same shape as today's Google client, one instance per provider:

- **Discovery:** fetch `<issuer>/.well-known/openid-configuration` lazily on first use, cache
  in memory (re-fetch after failure, 10 s timeout, size-capped body). Require `issuer` in the
  document to equal the configured issuer exactly (trailing slash normalized), and
  `authorization_endpoint`/`token_endpoint` to be `https://` (loopback exception as above).
  A provider whose discovery fails makes only that provider's login fail
  (`/?error=provider`); boot does not depend on the provider being up.
- **Authorization:** code flow, `scope=openid email` (plus configured extras), PKCE S256,
  random `state`, plus a random `nonce`. Google keeps its current extra params
  (`access_type=online`, `prompt=select_account`) via `extraAuthParams` on the implicit
  provider.
- **Token exchange:** server-to-server POST to the discovered token endpoint with
  `client_secret_post` (what Google uses today; authentik supports it), 10 s timeout.
- **id_token checks:** decoded without a JWKS signature check — it comes straight from the
  token endpoint over TLS, as today. Required: `iss` equals the discovered issuer, `aud`
  equals (or, if an array, contains) the client id, `exp` in the future (small skew), `nonce`
  equals the one sent, `email` present, and `email_verified` true unless the provider sets
  `allowUnverifiedEmail` (oauth2-proxy's model; default off).
- **Google issuer quirk:** Google may send `iss` as `accounts.google.com` or
  `https://accounts.google.com`. A provider whose issuer is `https://accounts.google.com`
  accepts both; every other provider requires an exact match.
- `isAllowed(email)`: shared exact, lower-cased allowlist (`TMUXIFIER_ALLOWED_EMAILS`) across
  all providers.

`pkcePair`/`randomState`/`base64url` move with it; `googleAuth.js` and its tests are deleted
or folded in.

### 3. Routes

- `GET /api/auth/oidc/:id/login` and `GET /api/auth/oidc/:id/callback` for every provider.
- **Legacy paths kept for Google:** `GET /api/auth/google/login` and
  `/api/auth/google/callback` serve the provider with id `google` (whatever its config source),
  and that provider's `redirect_uri` always stays `<base>/api/auth/google/callback`, so existing Google Console
  registrations keep working. All other providers use `<base>/api/auth/oidc/<id>/callback`
  (this is the URI the operator registers in authentik).
- State cookie: the existing signed, httpOnly, `SameSite=lax`, 5-minute `tmuxifier_oauth`
  cookie now carries `<providerId>.<state>.<nonce>.<verifier>`; the callback rejects a cookie
  whose provider id differs from the route's. Cleared on every callback outcome.
- Callback outcomes redirect to `/?error=<code>` with codes `provider` (discovery/exchange
  failure), `state` (missing/mismatched state), `forbidden` (not verified or not
  allowlisted), `passkey-only`. Today's `?error=google` becomes `provider`; the web client
  keeps mapping `google` too for a stale tab. Success sets the normal session cookie and redirects `/`.
- `GET /api/auth/info` returns `mode: 'oidc'|'password'`, `providers: [{ id, label }]`
  (no issuer or secrets), `password: boolean` (whether `/api/login` is mounted), plus the
  existing `passkey` block.
- Login rate limiting: unchanged — the OIDC routes do not charge `loginLimiter` (the Google
  callback doesn't today; the provider does its own rate limiting).

### 4. Break-glass password in OIDC mode

`POST /api/login` mounts when the mode is `password`, **or** when the mode is `oidc` and
`TMUXIFIER_PASSWORD_HASH` is set. Same handler: passkey-only refusal (403), rate limiter,
scrypt. In OIDC mode the web client shows the password form only on `/?login`.

**Operator decision:** the hash alone enables it, no opt-in flag. Upgrade note for the PR: a
Google deployment that still has an old `TMUXIFIER_PASSWORD_HASH` in `.env` regains a working
password login at `/?login`; remove the hash to prevent that.

### 5. Web client login flow (`main.ts` `renderLogin`)

Inputs: `/api/auth/info`, the URL (`?login`, `?error=`), and a one-shot "signed out" flag.

- **Auto-redirect** (`location.assign('/api/auth/oidc/<id>/login')`) happens only when all
  hold: mode `oidc`, exactly one provider, that provider is not the implicit legacy Google one
  (an existing Google deployment keeps today's login page), passkey-only not armed, no `?login`, no `?error`,
  and not just signed out.
- Otherwise render the login page: one button per provider (label from info), the passkey
  button when credentials are enrolled, the password form only when `password` is true **and**
  (mode is `password` or `?login` is present), and an error line for `?error=`.
- **Signed out:** the logout button sets the flag (in `sessionStorage`) and renders a
  "Signed out" page with a "Sign in" button (goes to the provider, or shows the page if 2+
  providers) and a link to `/?login`. A 401-driven session expiry does **not** set the flag,
  so it auto-redirects (silent re-login when the authentik session is still alive).
- Split the decision into a pure helper (e.g. `src/web/loginRoute.ts`:
  `decideLogin(info, url, signedOut) → { kind: 'redirect', href } | { kind: 'page', … }`)
  with unit tests; DOM stays in `main.ts`.

### 6. Logout

Unchanged server side (`POST /api/logout` clears the cookie and advances the revocation
watermark). No call to the provider's `end_session_endpoint`; the authentik session survives
and the signed-out page (§5) prevents the instant bounce back in.

### 7. Interactions

- **Passkeys:** mounted in both modes, as today. **Passkey-only armed** refuses every OIDC
  login route (`/?error=passkey-only`) and the break-glass password (403), as it refuses
  Google today; `TMUXIFIER_PASSKEY_ONLY=off` remains the break-glass for that.
- **Device enrollment:** `POST /api/devices/enroll` with a password stays refused (501) in
  OIDC mode even when a hash is set; pairing codes keep working. The break-glass is for browser
  login only.
- **Cookies / Secure:** unchanged; an `https://` base external URL still marks the session
  cookie `Secure`.

### 8. Docs and examples

`.env.example` (new `TMUXIFIER_OIDC_*` keys with placeholder values, legacy Google keys
documented as still working), `docs/authentication.md` (authentik setup walkthrough: create an
OAuth2/OpenID provider, confidential client, redirect URI
`https://tmuxifier.example.com/api/auth/oidc/authentik/callback`, scopes `openid email`, bind
the application to the operator; recommended: a custom scope mapping returning
`email_verified: true` instead of `_ALLOW_UNVERIFIED_EMAIL=on`; **warning**, either way, that
authentik's default user-settings flow lets users edit their own email, so disable that (or be
the only user) or any authentik user can claim the allowlisted address; the `?login`
break-glass), `docs/configuration.md`,
`README.md` auth section, AGENTS.md + CLAUDE.md (Auth module list, config model, Security
notes). Placeholders only — no real domains.

### 9. Tests

Also migrate what references the old shape: `src/web/api.ts` (`mode` typed
`'password' | 'google'`), `test/server.google.test.js`, `test/googleAuth.test.js`, and
`buildServer`'s injected `googleAuth` option (becomes an injectable provider map / factory).

- `config.test.js`: env-list parsing, `config.json` array, legacy Google → implicit provider,
  `oauth`/`google` aliases → `oidc`, every validation failure.
- `oidcAuth.test.js`: against a real local HTTP(S) OIDC stub (discovery + token endpoint), not
  mocks of the client: issuer mismatch, non-https endpoints, `aud` string/array, expired,
  nonce mismatch, unverified email, allowlist case-folding.
- Server tests: login→callback round trip per provider, legacy Google paths and redirect URI,
  provider-id/cookie mismatch, unknown id 404, break-glass mount matrix (mode × hash ×
  passkey-only), `/api/auth/info` shape, device enroll still 501.
- Web: `decideLogin` unit tests; one Playwright test for auto-redirect vs `?login` vs
  signed-out.

### 10. Compatibility (additive only — operator requirement)

Every existing config keeps working with no edits and no change in behavior, except the
accepted break-glass note in §4:

- Kept keys: `TMUXIFIER_AUTH_MODE=oauth|google`, `TMUXIFIER_OAUTH_CLIENT_ID/_SECRET`,
  `TMUXIFIER_GOOGLE_CLIENT_ID/_SECRET`, `TMUXIFIER_PUBLIC_URL`, `TMUXIFIER_BASE_EXTERNAL_URL`,
  `TMUXIFIER_ALLOWED_EMAILS`, `config.json` `googleClientId`/`googleClientSecret`.
- Kept routes/URIs: `/api/auth/google/login`, `/api/auth/google/callback`.
- Kept UX: legacy Google shows the login page (no auto-redirect); `?error=google` still renders.
- New id_token checks (`iss`, `aud`, `exp`, `nonce`) are ones Google already satisfies.
- A test boots each legacy config shape (env-only, `config.json`-only) and asserts the
  same routes, redirect URI, and `/api/auth/info` provider list.

### 11. Validation before merge

Per AGENTS.md shipping flow: deploy the worktree build to the live app configured with the
operator's authentik provider; verify auto-redirect sign-in, logout → signed-out page (no
bounce), `/?login` passkey and password break-glass, a non-allowlisted authentik user rejected,
and (on a Google config) unchanged Google sign-in.

## Calls made by the designer (operator to check)

- Mode renamed `oidc` with `oauth`/`google` aliases; legacy Google env keys become an implicit
  `google` provider keeping its old callback path.
- Providers configured via `.env` id list + per-id keys, or a `config.json` array; no UI.
- No JWKS signature verification (same trust argument as today); `iss`/`aud`/`exp`/`nonce`
  checked.
- `client_secret_post` only.
- `.env`/`config.json` provider merge rules (§1); explicit `google` beats legacy keys.
- OIDC routes not rate-limited (unchanged).
- Device enrollment by password stays off in OIDC mode.
- Session expiry auto-redirects; explicit logout does not.

## Builder-check outcome (2026-11-11)

- `email_verified` vs authentik (sends `false` by default): operator chose required by default
  with a per-provider `ALLOW_UNVERIFIED_EMAIL` opt-out, plus the email-edit warning in docs.
- Break-glass trigger: operator chose hash alone; documented as an upgrade note in the PR.
- Settled by the designer: Google dual `iss` forms, provider merge rules, explicit `google` wins
  and always keeps the legacy callback, `?error=google` aliasing, no rate limiting on OIDC
  routes (corrected — the doc wrongly claimed today's callback charges it), validator name
  `requiredConfigError`, extra files to migrate.
