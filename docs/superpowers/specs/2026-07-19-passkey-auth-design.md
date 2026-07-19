# Passkey (WebAuthn) sign-in alongside password/Google — design

Date: 2026-07-19
Status: approved (brainstorming session)

## Problem

Tmuxifier has two mutually exclusive authentication modes: `password` (default) and `google`
(hand-rolled OIDC). `TMUXIFIER_AUTH_MODE` selects one, and `server.js` mounts only that mode's
routes — `POST /api/login` in password mode, `/api/auth/google/*` in OAuth mode.

Both modes are phishable. A password typed into a lookalike page, or a Google credential
harvested by a proxy, hands an attacker the whole fleet: Tmuxifier can SSH into every box it
knows about. There is currently no phishing-resistant way in.

The goal is a third sign-in path — a passkey — that a user can enroll from the UI and then use
instead of typing a password or bouncing through Google, without giving up the existing path as
the bootstrap and recovery route.

A prior WebAuthn implementation by the same author — a directory-management web app that puts a
passkey in front of a directory-service login — was consulted as a reference. Its passkey
handling is reused in spirit; its *auth model* is not (see Decision 1). It is referred to below
as "the reference implementation".

## Decisions (from brainstorming Q&A)

1. **Additive second path, not a third exclusive mode.** `TMUXIFIER_AUTH_MODE` keeps its current
   meaning and values. Passkey is an extra login path available in either mode. Enrollment
   requires an already-authenticated session, which is the bootstrap: you log in the way you
   always have, then enroll. The reference implementation's model (passkey as a mandatory first factor *before* the
   password) was rejected because the request is for "either/or", not two factors. A third
   exclusive `passkey` mode was rejected because there would be nothing to log in with to enroll
   the first credential.

2. **Hand-rolled verification, no new dependency.** A new `src/server/webauthn.js` in the same
   spirit as `googleAuth.js` and `envFile.js`. The scope is bounded because we accept
   `attestation: "none"` only, which removes attestation-statement parsing — the reason
   WebAuthn libraries pull in a stack of ASN.1 parsers. The security-critical path (login
   assertion) involves no CBOR at all. CBOR appears only in registration, which sits behind an
   authenticated session and whose worst failure mode is a bad entry in the store, not an auth
   bypass. The repo stays at five runtime dependencies.

3. **RP ID derived from existing config, with readiness surfaced in the UI.** `TMUXIFIER_RP_ID`
   if set, else the hostname of `TMUXIFIER_BASE_EXTERNAL_URL`, else `localhost`. An existing
   deployment needs no new configuration. The Passkeys settings tab reports the effective RP ID
   and whether the browser currently in use can enroll against it, with a fix-it hint —
   the same pattern as the AI-auth readiness rows in `setupOptions.ts`.

4. **Opt-in "passkey only" toggle.** Once at least one passkey is enrolled, the user may arm a
   toggle that makes the password and Google routes refuse. This raises the actual security
   floor rather than merely adding a convenient alternative. It ships with three anti-lockout
   guards and a documented `.env` break-glass (see §5).

5. **Three focused server modules** — pure verification, persistence, and challenge state kept
   separate, matching the repo's factory + dependency-injection convention so the crypto is
   testable without touching the filesystem.

## Design

### 1. Configuration — `src/server/config.js`

Two new knobs, folded into the existing low→high precedence merge:

| Key | Env | Default |
| --- | --- | --- |
| `rpId` | `TMUXIFIER_RP_ID` | hostname of `baseExternalUrl`, else `localhost` |
| `passkeyOnlyKillSwitch` | `TMUXIFIER_PASSKEY_ONLY` | unset (`off` forces the stored flag off) |

`rpName` is the constant `"Tmuxifier"`, shown in the operating system's passkey picker. It is
not configurable.

`rpId` is normalized to lowercase and validated as a domain label chain. An IP address is not a
legal WebAuthn RP ID, so IP literals are rejected — but *how* they are rejected depends on where
the value came from, and the distinction matters:

- **Explicit `TMUXIFIER_RP_ID` that is invalid** (an IP literal or a malformed domain) is a
  configuration error, reported through the same `configError` path that already reports missing
  OAuth settings. The user asked for a specific RP ID and it cannot work; failing loudly is
  correct.
- **Derived `rpId` that is invalid** — most commonly `TMUXIFIER_BASE_EXTERNAL_URL` pointing at a
  bare IP — sets `rpId` to `null` and is **not** a boot error. Such a deployment works today
  with password or Google sign-in, and refusing to start because an opt-in feature is
  unavailable would be a regression. With `rpId === null`, the passkey routes are still mounted
  but `login/begin` and `register/begin` return `503` with a reason, `GET /api/auth/info`
  reports `passkey.rpId === null`, the login screen omits the passkey button, and the settings
  tab explains that passkeys need a domain name rather than an IP address.

Because the RP ID is derived rather than explicit, changing `TMUXIFIER_BASE_EXTERNAL_URL` would
otherwise silently invalidate every enrolled passkey. §3 records the RP ID at enrollment time so
this is detected and explained instead.

#### Origin acceptance rule

Both verifiers accept an origin if and only if:

- its hostname equals `rpId` exactly (no wildcard or subdomain matching), **and**
- its scheme is `https`, or its scheme is `http` and its hostname is `localhost`.

The port is ignored. This is one rule with no port bookkeeping, and it matches the browser's own
secure-context requirement for WebAuthn.

### 2. Pure verification — `src/server/webauthn.js`

No filesystem, no network, no configuration reading. Exports:

- a minimal CBOR reader covering only the subset authenticators emit (maps, arrays, byte
  strings, text strings, unsigned/negative integers)
- `coseToKeyObject(coseBytes)` — COSE key → `node:crypto` `KeyObject` via JWK import.
  Supported algorithms: ES256 (`-7`), RS256 (`-257`), EdDSA (`-8`). Anything else is refused;
  the import itself is the validity check on the key material.
- `verifyRegistration({ response, expectedChallenge, rpId, originOk })`
- `verifyAssertion({ response, expectedChallenge, rpId, originOk, publicKey, storedSignCount })`

`originOk` is an injected predicate, `(origin: string) => boolean` — the rule from §1, passed in
rather than reimplemented here, so this module reads no configuration.

`verifyAssertion` performs, in order:

1. parse `clientDataJSON`; require `type === "webauthn.get"`
2. compare its `challenge` to the expected challenge with `timingSafeEqual`
3. check its `origin` against the rule in §1
4. parse `authenticatorData`; require `rpIdHash === sha256(rpId)`
5. require the UP (user present) flag and the UV (user verified) flag
6. `verify(signature, authenticatorData || sha256(clientDataJSON))` with the stored public key
7. apply the sign-count rule: reject when `storedSignCount > 0 && newSignCount <= storedSignCount`;
   accept when both are `0`, since many authenticators never increment the counter

`verifyRegistration` performs the same clientData checks with `type === "webauthn.create"`, the
same `rpIdHash`/UP/UV checks, additionally requires the AT (attested credential data) flag, and:

- CBOR-decodes `attestationObject` into `{ fmt, authData, attStmt }`
- **requires `fmt === "none"`.** We request `attestation: "none"`, so any other format is
  rejected rather than accepted without verification.
- parses attested credential data out of `authData` (AAGUID, credential ID, COSE public key) and
  imports the key

### 3. Persistence — `src/server/passkeyStore.js`

`createPasskeyStore({ file, log })` over `jsonFile.js`, so it inherits atomic
write-then-rename, `0o600` permissions, and corrupt-file quarantine. Public keys are not
secrets, so no `secretBox` sealing is used.

`data/passkeys.json`:

```json
{
  "version": 1,
  "passkeyOnly": false,
  "rpId": "tmux.example.com",
  "userHandle": "<base64url, 16 random bytes>",
  "credentials": [
    {
      "id": "<base64url credential id>",
      "publicKey": "<base64url COSE key>",
      "alg": -7,
      "signCount": 12,
      "label": "Laptop Touch ID",
      "created": 1750000000,
      "lastUsed": 1750000900,
      "transports": ["internal", "hybrid"]
    }
  ]
}
```

Two fields deserve explanation:

- **`rpId`** is recorded on the first enrollment. It lets the settings tab report "these
  passkeys were enrolled for `tmux.old.example.com` and will not work here" when the config-derived
  RP ID no longer matches, and it lets login refuse a mismatch explicitly rather than fail
  obscurely.
- **`userHandle`** is generated once and reused for every enrollment. A stable WebAuthn user id
  is what makes re-enrolling the *same* authenticator replace its credential rather than stack
  duplicate entries in the operating system's keychain.

Operations: `list()`, `add(credential, { rpId })` (upsert by credential id), `remove(id)`,
`touch(id, { signCount, lastUsed })`, `getPasskeyOnly()`, `setPasskeyOnly(enabled)`,
`getRpId()`, `getUserHandle()`.

`add` pins the store's `rpId` when it is currently unset — the first enrollment records which
hostname these credentials belong to. It never overwrites an already-pinned value; a mismatch is
surfaced to the user instead (§5, §6), because silently re-pinning would hide the fact that
every existing credential just stopped working.

`getUserHandle()` generates and persists the 16 random bytes on first call.

`remove(id)` auto-disarms `passkeyOnly` when it removes the last credential, and reports that it
did so in its return value. Removing the last credential also clears the pinned `rpId`, so a
deployment that moves hostnames can start clean by deleting its passkeys.

### 4. Challenge state — `src/server/passkeyChallenges.js`

`createPasskeyChallenges({ ttlMs = 120_000, max = 64, now = Date.now })`.

- `issue(kind)` → `{ token, challenge }`. `kind` is `"auth"` or `"reg"`.
- `take(token, kind)` → the challenge, **deleted on read**, so one challenge authenticates
  exactly once. Returns `null` on an unknown token, an expired entry, or a kind mismatch.

Expired entries are reaped on each `issue`. The map is bounded at `max` with oldest-first
eviction, mirroring `rateLimit.js`: the login endpoints are unauthenticated, so an unbounded map
would be a memory-exhaustion lever.

The token travels to the browser in a dedicated `tmuxifier_pk` cookie — `httpOnly`,
`SameSite=strict`, `Secure` per `config.secureCookie`, `maxAge` 120s — following the same
short-lived-cookie pattern already used for the OAuth state cookie.

### 5. Routes — `src/server/server.js`

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/auth/passkey/login/begin` | none, rate-limited | assertion options + challenge cookie |
| `POST /api/auth/passkey/login/finish` | none, rate-limited | verify assertion, mint session cookie |
| `GET /api/passkeys` | authed | enrolled list + settings-tab state |
| `POST /api/passkeys/register/begin` | authed | creation options + challenge cookie |
| `POST /api/passkeys/register/finish` | authed | verify and store |
| `DELETE /api/passkeys/:id` | authed | remove one credential |
| `POST /api/passkeys/only` | authed | arm/disarm passkey-only |

`GET /api/passkeys` returns
`{ credentials: [{ id, label, created, lastUsed, transports }], rpId, storedRpId, passkeyOnly, killSwitch }`
— everything the settings tab needs in one call. Public keys and sign counts are not returned;
the browser has no use for them.

`GET /api/auth/info` gains a `passkey` object: `{ enrolled, rpId, only }`. It stays
unauthenticated — the login screen needs it to decide whether to draw the passkey button, and it
exposes only the hostname the client is already talking to plus a count. The reference implementation's
`/api/auth/pk/status` is unauthenticated for the same reason.

`login/begin` sends **no `allowCredentials`**: discoverable (resident) credentials identify the
user themselves, and an empty list also avoids handing out credential IDs before authentication.

`login/begin` and `register/begin` both return `409` with an explanatory message when the
store's pinned `rpId` differs from the configured one. Without this check the browser would be
handed options it cannot satisfy, and the user would see a generic verification failure instead
of "these passkeys were enrolled for a different hostname".

`register/begin` requests `residentKey: "required"`, `userVerification: "required"`,
`attestation: "none"`, `pubKeyCredParams` of ES256/RS256/EdDSA, and `excludeCredentials` listing
the already-enrolled IDs so the same authenticator is not enrolled twice by accident.

Labels are validated against `[A-Za-z0-9 ._-]{1,32}` (the reference implementation's rule).

#### Rate limiting

Passkey login reuses the existing `loginLimiter`: `fail(ip)` on a rejected assertion,
`succeed(ip)` on an accepted one. Passkey login shares the per-IP lockout bucket with password
login rather than being a way around it.

#### Passkey-only enforcement

The flag is read from the store **per request**, not captured at server start, so toggling it
takes effect immediately. When armed:

- `POST /api/login` → `403 { error: "passkey required" }`, checked *before* the rate limiter so
  a disabled mode does not consume login attempts
- `GET /api/auth/google/login` → redirect to `/?error=passkey-only`
- `GET /api/auth/google/callback` → redirect to `/?error=passkey-only`

Guarding the callback matters: without it, an OAuth flow started before the toggle was armed
would still complete and issue a session.

Three anti-lockout guards, because this toggle can lock the user out of the entire fleet:

1. Arming is refused with `409` when zero credentials are enrolled.
2. Deleting the last credential auto-disarms the flag and says so in the response.
3. `TMUXIFIER_PASSKEY_ONLY=off` in `.env` overrides the stored flag. This is the documented
   break-glass for a lost or wiped authenticator: edit `.env`, restart, sign in with
   password/Google.

Successful passkey login mints exactly the same session cookie as the other two paths —
`sessionValue()` with `cookieOptions(config.secureCookie)` — so the session TTL, the signed
cookie, the logout revocation watermark, and WebSocket authentication all work unchanged. No
change to `auth.js` or `sessions.js` is required.

### 6. Web client

#### Login screen — `src/web/main.ts`

The existing `mode === 'google'` / password branch is kept; the passkey control is added
alongside rather than becoming a third branch.

- If `passkey.enrolled > 0` and `window.PublicKeyCredential` exists, draw a "Sign in with a
  passkey" button, styled from the existing `.gbtn` rules.
- If `passkey.only` is armed, draw *only* the passkey button, with a line explaining that
  password/Google sign-in is disabled.
- Add `passkey-only` to the `?error=` code map.

One dead-end is handled explicitly: `passkey.only` armed while the browser has no WebAuthn
support, or while the current origin does not match the RP ID, would otherwise present a login
screen with nothing that works. That case renders the break-glass instructions inline.

#### Fetch layer and pure helpers — `src/web/passkeys.ts`

The API calls, base64url ↔ `ArrayBuffer` helpers, the pure shape converters
(`toCreationOptions`, `toRequestOptions`, `serializeCredential`), and:

`evaluateOrigin({ rpId, storedRpId, location, hasWebAuthn })` → `{ ok, reason, hint }`, a pure
function covering five states:

1. origin OK
2. hostname mismatch (current hostname ≠ RP ID)
3. insecure context (`http` on a non-`localhost` host)
4. browser does not support WebAuthn
5. store-pinned RP ID ≠ currently configured RP ID

Being pure, all five states are unit-testable with no browser.

#### Settings tab — `src/web/settingsPasskeys.ts`

`SettingsTab` gains `'passkeys'` and `SECTIONS` in `settingsUi.ts` gains one entry. The tab
renders three blocks:

1. **Readiness row** — effective RP ID, the current origin, and the verdict from
   `evaluateOrigin`, each state with its own fix-it hint. When not OK, **Add passkey** is
   disabled with the reason attached, so a doomed enrollment is never attempted.
2. **Enrolled list** — label, created, last used, transports; per-row Remove behind a confirm.
3. **Passkey-only toggle** — disabled with a stated reason when zero credentials are enrolled or
   when the env kill switch is active. Arming goes through a confirm dialog naming the
   break-glass, since it is the one action here that can lock the user out.

Modals use the shared `openModal` from `dom.ts`; the settings modal already registers with
`modalRegistry` for logout teardown.

### 7. Error handling

| Condition | Response |
| --- | --- |
| `rpId` is `null` (derived from an IP address) | `503` with a reason naming the domain-name requirement |
| store-pinned `rpId` ≠ configured `rpId` | `409` naming both hostnames |
| challenge missing, expired, or wrong kind | `400 challenge expired — start again` |
| unknown credential id | `401 passkey verification failed` |
| bad signature, `rpIdHash`, origin, or flags | `401 passkey verification failed` (identical message — no credential enumeration) |
| sign-count regression | `401`, plus a logged warning naming a possible cloned authenticator |
| registration verification failure | `400` with a truncated reason (authenticated endpoint, so specificity is safe and useful) |
| invalid label | `400` |
| user cancels the browser prompt | no request is sent |

Logging follows the existing convention — an injectable `log` defaulting to `console.error`, as
in `shutdown.js` and `proxmoxInventory.js` — rather than introducing a logger.

#### Corrupt store fails open, deliberately

If `data/passkeys.json` cannot be parsed, `jsonFile.js` quarantines it to
`passkeys.json.corrupt-<timestamp>` and returns the empty fallback. `passkeyOnly` then reads
`false` and password/Google sign-in works again. This is the opposite of the reference implementation, which returns
`503` on an unreadable passkey store.

The reasoning: the armed/disarmed state is unrecoverable from a quarantined file, so failing
closed would brick fleet access on a disk glitch, and anyone able to corrupt that file can
already read `TMUXIFIER_PASSWORD_HASH` from `.env` on the same disk — the downgrade buys an
attacker nothing they do not already have. The quarantine is logged loudly.

### 8. Testing

Real code, no mocks, per the repo convention.

- `test/webauthn.test.js` — generate a real P-256 keypair with `node:crypto`, hand-assemble
  `authenticatorData`, `clientDataJSON`, and a real signature, and assert acceptance. Then one
  rejection case per mutation: wrong challenge, wrong origin, wrong `rpIdHash`, UP flag clear,
  UV flag clear, tampered signature, sign-count regression. Plus RS256 and EdDSA key import, and
  CBOR-reader tests against hand-built byte fixtures — including an attestation object with
  `fmt: "packed"`, which must be refused.
- `test/passkeyStore.test.js` — CRUD, upsert-by-id replacing the same authenticator, last-credential
  delete auto-disarming `passkeyOnly`, corrupt-file behavior, `0o600` mode.
- `test/passkeyChallenges.test.js` — single use, TTL expiry, kind mismatch, bounded eviction
  under overflow.
- `test/passkeyRoutes.test.js` — route level with real modules, following `setupRoutes.test.js`
  and `netboxRoutes.test.js`: a full begin→finish producing a cookie that `isAuthed` accepts;
  `passkeyOnly` gating `POST /api/login` and both Google routes; arming refused at zero
  credentials; rate-limiter interaction; `503` when `rpId` is `null`; `409` on a pinned-RP-ID
  mismatch.
- `test/passkeysWeb.test.js` — `evaluateOrigin` across all five states, plus the serializers.
- `test/config.test.js` additions — RP ID precedence; an explicit invalid `TMUXIFIER_RP_ID`
  producing a `configError`; a derived IP-literal producing `rpId === null` **without** a
  `configError`, so an IP-addressed deployment still boots; kill-switch handling.

### 9. Documentation

- `README.md` — authentication section: passkeys as an additive path, the HTTPS/RP-ID
  requirement, the passkey-only toggle and its break-glass.
- `CLAUDE.md` and `AGENTS.md` — the three new server modules, the three new web modules,
  `data/passkeys.json` in the persisted-files list, and the security notes.
- `.env.example` — `TMUXIFIER_RP_ID` and `TMUXIFIER_PASSKEY_ONLY` with comments.
- `docs/DEPLOY.md` — RP ID pinning and the requirement that passkeys need `https://<hostname>`
  or `http://localhost`, never an IP address.

## Out of scope

- Attestation formats other than `none` (no `packed`, `tpm`, `android-key`, `apple`)
- Multi-user accounts — Tmuxifier is single-user; all passkeys belong to the one operator
- Conditional UI / passkey autofill on the login screen
- A Playwright CDP virtual-authenticator end-to-end test. Deferred deliberately: unit and
  route-level coverage carries this feature, and the virtual-authenticator harness is a
  disproportionate lift for the first round.
