# Passkey fresh-assertion arming — design

Date: 2026-07-23
Status: approved

## Problem

Arming "require a passkey" (`passkeyOnly`) disables password and Google sign-in. Today the
guard checks that at least one credential is *enrolled* and that the relying party id is
*usable* — but not that any enrolled passkey still *works*. A passkey enrolled months ago on a
since-lost or since-reset device passes both checks, and arming then locks the operator out of
every login path except the `TMUXIFIER_PASSKEY_ONLY=off` break-glass in `.env`.

This was triaged as the most valuable deferred follow-up from the v1.11.0 passkey release
(`docs/superpowers/specs/2026-07-19-passkey-auth-design.md`).

## Goal

Arming requires a fresh, successful WebAuthn assertion — proof that a credential is usable
*now, in the arming browser* — verified with the same machinery the login path uses. Disarming
remains unconditional: it is the recovery path.

A deliberate consequence: a browser that cannot complete a passkey assertion cannot arm
passkey-only mode. That is the exact browser that would be locked out afterwards, so refusing
is the feature working, not a limitation.

## Server changes (`src/server/server.js`, passkey section)

### New route: `POST /api/passkeys/only/begin` (authenticated)

Fail-fast guards, reusing existing messages and status codes:

1. Kill switch set (`config.passkeyOnlyKillSwitch`) → 409, same message as the arm route uses
   today ("TMUXIFIER_PASSKEY_ONLY=off is set in .env — remove it and restart before arming
   this").
2. `pkReady(reply)` — no store → 503; no rpId → 503; pinned-rpId mismatch → 409. The
   authenticated default (`exposeStoredRpId: true`) applies.
3. Zero enrolled credentials (`listRaw().length === 0`) → 409 `{ error: 'no passkey enrolled' }`.

Then issue a challenge with the new kind `'arm'` via the existing `issueChallenge(req, reply,
'arm')` — the token rides the same signed, httpOnly, `SameSite=strict` `tmuxifier_pk` cookie.
`challengeStoreFor('arm')` resolves to the authenticated store (`pkChallenges`, shared with
`'reg'`), so a flood of anonymous `login/begin` calls cannot evict an in-flight arm challenge.
The challenge store's kind check in `take()` guarantees a `'auth'` (login) challenge cannot be
replayed to finish an arm ceremony, and vice versa.

Response body is identical in shape to `login/begin`:

```json
{ "challenge": "<base64url>", "rpId": "...", "timeout": 120000,
  "userVerification": "required", "allowCredentials": [] }
```

### Changed route: `POST /api/passkeys/only`

The `enabled: false` (disarm) branch is byte-for-byte untouched.

The `enabled: true` branch keeps its existing guards in order (kill switch → explicit-boolean
validation → rpId-usable 409), then adds the assertion requirement:

1. `takeChallenge(req, 'arm')` and clear the `tmuxifier_pk` cookie. No/expired/wrong-kind
   challenge → 400 `{ error: 'arming requires a fresh passkey assertion — start again' }`.
2. Look up the credential by `req.body.id` in `passkeyStore.listRaw()`.
3. `verifyAssertion({ response: req.body.response, expectedChallenge, rpId, originOk:
   passkeyOriginOk, publicKey, storedSignCount })` — the same call and the same
   sign-count-stall semantics as `login/finish`, including the "sign count did not increase"
   audit log line (matched on "did not increase", not `/sign count/`, for the same
   corrupt-store-mislabel reason documented there).
4. Verification failure → 400 with a specific reason (`arming failed: <message>`, truncated
   like `register/finish` does). This endpoint is authenticated, so the login route's
   deliberately generic 401 does not apply; the register/finish disclosure policy does.
5. Success → `passkeyStore.touch(credential.id, { signCount: result.signCount })`, then
   `setPasskeyOnly(true)` and the existing audit log line.

No rate-limiter involvement: the route is authenticated, and failures here must not feed the
per-IP login lockout the operator would then hit on a real login.

### Store

No changes. `setPasskeyOnly` already refuses arming with zero credentials; `touch` already
persists sign counts.

## Client changes

### `src/web/passkeys.ts`

- `pk.onlyBegin()` — POST to `/api/passkeys/only/begin`, returns the login-begin-shaped
  options object (reuses the existing type).
- `pk.setOnly(enabled, assertion?)` — when arming, the body becomes
  `{ enabled: true, id, response }` (the `serializeAssertion` output spread the same way
  `login/finish` sends it). Disarm keeps `{ enabled: false }`.

### `src/web/settingsPasskeys.ts`

- The `confirmArm` modal stays (informed consent before the ceremony). Its text gains one
  sentence: the browser will ask you to confirm with your fingerprint, face, PIN or security
  key. Its Arm button handler becomes async:
  `pk.onlyBegin()` → `getPasskey(toRequestOptions(options))` (browser prompt) →
  `pk.setOnly(true, serializeAssertion(credential))` → `reload()`.
- Any failure — user cancels the prompt (`NotAllowedError`), challenge expiry, verification
  rejection — reverts the checkbox and surfaces the error through the existing `fail`
  handler. No partial state: the flag only flips server-side after a verified assertion.
- The arming checkbox is additionally disabled (with the verdict's reason as the title/hint)
  when `evaluateOrigin` reports the browser cannot perform WebAuthn here — surfacing the
  dead end up front instead of at a failed prompt. Disarming is never disabled by this.

## Error handling summary

| Failure | Where | Result |
| --- | --- | --- |
| Kill switch set | begin + finish | 409, existing message |
| rpId unusable / pin mismatch | begin (`pkReady`) + finish (existing guard) | 503/409, existing messages |
| No credentials | begin + `setPasskeyOnly` | 409 |
| No/expired/wrong-kind challenge | finish | 400 "arming requires a fresh passkey assertion — start again" |
| Unknown credential id / bad signature / stalled sign count | finish | 400 "arming failed: …", flag untouched |
| User cancels browser prompt | client | checkbox reverts, error shown, no request sent |

## Tests (extend `test/passkeyRoutes.test.js`, real fixtures from `test/helpers/webauthnFixtures.js`)

1. **Regression the feature exists for:** `POST /api/passkeys/only {enabled:true}` with no
   assertion → 400, `passkeyOnly` stays false.
2. Happy path: `only/begin` → `makeAssertion` against the issued challenge → arm succeeds,
   flag set, credential signCount persisted.
3. Kind isolation: challenge issued by `login/begin` replayed to the arm finish → 400
   ("arming requires a fresh passkey assertion"); an `'arm'` challenge replayed to
   `login/finish` → 400 ("challenge expired"). Both directions fail whether the ceremonies
   use their separate default stores (token unknown to the other store) or a test-injected
   shared store (`take()`'s kind check refuses).
4. Bad signature → 400, flag stays false.
5. Stalled sign count → 400, flag stays false.
6. Disarm without assertion still succeeds (recovery path unchanged).
7. `only/begin` with kill switch set → 409; with zero credentials → 409.
8. `npm run typecheck` covers the TS client changes.

## Out of scope

- The other v1.11.0 deferrals (session revocation on arm, `passkeyOnlyArmed` extraction,
  the listed webauthn test gaps).
- Any change to the login ceremony, challenge store, or break-glass semantics.
- API backward compatibility for the arming call: single-user app, the UI ships in the same
  commit.
