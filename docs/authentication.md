# Authentication

How to sign in to Tmuxifier: password mode, Google OAuth mode, and passkeys. Part of the
[Tmuxifier docs](../README.md).

`TMUXIFIER_AUTH_MODE` selects the primary login method: `password` (default) or `oauth`, which
replaces the password form with Google sign-in. These two remain mutually exclusive with each
other — pick one. A passkey (below) is a separate, additive third way in, available under
**either** setting.

Password mode:
```bash
npm run set-password
```
This writes `TMUXIFIER_PASSWORD_HASH` and, if absent, `TMUXIFIER_COOKIE_SECRET` to `.env`.

OAuth mode:
```bash
npm run gen-secret
```
Then set these `.env` keys:
```ini
TMUXIFIER_AUTH_MODE=oauth
TMUXIFIER_BASE_EXTERNAL_URL=tmuxifier.example.com
TMUXIFIER_OAUTH_CLIENT_ID=...
TMUXIFIER_OAUTH_CLIENT_SECRET=...
TMUXIFIER_ALLOWED_EMAILS=you@example.com,teammate@example.com
```
Tmuxifier treats a scheme-less public URL as HTTPS. In Google Cloud Console, create an OAuth
client ID for a web application and register this
authorized redirect URI:
```text
https://tmuxifier.example.com/api/auth/google/callback
```
The allowlist is exact email addresses only, matched case-insensitively. Domain wildcards are
not supported. The older `TMUXIFIER_PUBLIC_URL`, `TMUXIFIER_GOOGLE_CLIENT_ID`,
`TMUXIFIER_GOOGLE_CLIENT_SECRET`, and `TMUXIFIER_AUTH_MODE=google` names are still accepted.

## Passkeys

A passkey is an additional way in, available in **either** auth mode alongside password or
Google — it does not replace `TMUXIFIER_AUTH_MODE`. Enroll one from **Settings → Passkeys**
while already signed in (enrolling requires an existing session, so password/Google remains the
bootstrap and the recovery route); afterwards the login screen also offers **Sign in with a
passkey**.

Passkeys are bound to one hostname — the WebAuthn "relying party id" — which Tmuxifier takes
from `TMUXIFIER_RP_ID` if set, else the hostname of `TMUXIFIER_BASE_EXTERNAL_URL`, else
`localhost`. Two consequences:

- The browser must reach Tmuxifier at `https://<hostname>` or `http://localhost`. **An IP
  address cannot be a relying party id** — a deployment reached by IP simply shows passkeys as
  unavailable, with password/Google sign-in unaffected. That's only true when the id is
  *derived* this way, though: an explicit `TMUXIFIER_RP_ID` that isn't a valid domain name is
  instead treated as a configuration mistake and **fails startup** with an explanatory message.
- Changing that hostname invalidates every enrolled passkey. Settings → Passkeys detects the
  mismatch and names the hostname the existing passkeys belong to.

Optionally, **Require a passkey** (Settings → Passkeys → sign-in policy) disables password and
Google sign-in entirely. Arming it is guarded against locking you out by accident: arming asks
your browser for a fresh passkey confirmation first (so it only succeeds where a passkey
actually works right now), it's refused (409) unless at least one passkey is enrolled *and*
usable against the server's current relying party id, and removing your last passkey turns it
back off automatically. **If you still lose
your authenticator while it's armed, the only way back in without filesystem access is the
`.env` break-glass:** set

```ini
TMUXIFIER_PASSKEY_ONLY=off
```

and restart Tmuxifier. This is the only recovery path reachable without filesystem access once
passkey-only is armed — there is no admin override reachable from the UI once you're signed
out — so keep it in mind before arming it.

Two more things worth knowing about the security model:

- In OAuth mode, a passkey login never checks `TMUXIFIER_ALLOWED_EMAILS` — it authenticates a
  device credential, not the Google identity used to enroll it. Removing an email from the
  allowlist stops that person from signing in with Google again, but it does **not** revoke a
  passkey they already enrolled; remove that passkey from Settings → Passkeys to revoke it.
  (Only an already-authenticated user can enroll one, so this isn't a privilege-escalation path —
  just a separate revocation step to remember.)
- Passkey sign-in challenges are bounded per client address, the same way login attempts are
  rate-limited per IP. That stops a single flooding source from evicting another user's in-flight
  sign-in, but an attacker spread across many source addresses could still exhaust the bound and
  deny sign-in — under **Require a passkey** that would deny everyone, and the break-glass above
  is the remedy.

## Device tokens (Android app)

The Tmuxifier Android app doesn't carry a browser cookie — it authenticates every request with a
long-lived **device token** instead. A token is 32 random bytes; the server stores only its
SHA-256 digest in `data/devices.json`, never the token itself, so a copy of that file alone is not
a working credential.

**Enrolling a device** starts on the web dashboard: **Settings → Devices → Pair new device**
mints a single-use pairing code (`XXXX-XXXX`, 2-minute expiry, shown with a countdown). In the
app, enter your Tmuxifier URL (e.g. `https://tmuxifier.example.com`), a name for the device, and
that code, then enroll. The app calls `POST /api/devices/enroll`, which spends the code — it can
never be used twice, expired codes are refused, and wrong guesses feed the same per-IP rate
limiter as the login form — and returns the plaintext token exactly once; the app is responsible
for storing it, since the server can never show it again. In password mode the route also still
accepts the password directly in place of a code (the original v1 flow, useful for curl).

A few things worth knowing:

- **Pairing codes work in every auth mode.** Minting one requires an authenticated browser
  session, so the code inherits whatever gate that session passed — password, Google, or a
  passkey. That is why enrollment-by-code is allowed even while "require a passkey" is armed
  (the password branch still 403s there, exactly like the login form), and why it works on
  OAuth-mode servers where the password branch returns 501. Arming passkey-only does **not**
  revoke devices already enrolled — a device token never expires and ignores the logout
  watermark, so an existing token keeps working until it is explicitly revoked from
  Settings → Devices.
- **Revoking a device** is done from the dashboard, at **Settings → Devices**: it lists every
  enrolled device with its last-seen time and a Revoke button (arm-then-fire, like the other
  destructive controls in Settings). Revocation takes effect on the device's very next request —
  just as immediate as logout's watermark revoking a browser session cookie. The real asymmetry is
  that a session cookie also expires on its own after 7 days, while a device token never does — it
  is a standing credential until someone revokes it from Settings → Devices.
- Once enrolled, the device authenticates every request with `Authorization: Bearer <token>`; it
  never needs the password again unless it re-enrolls.

**Push notifications** are optional and separate from enrollment. If `TMUXIFIER_FCM_CREDENTIALS`
in `.env` points at a Firebase service-account JSON file, Tmuxifier pushes agent-input/agent-done
notifications to enrolled devices via FCM as they happen. Leaving it unset means the app receives
no proactive notifications, but enrollment and the device token behave identically either way.
