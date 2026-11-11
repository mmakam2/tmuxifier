# Authentication

How to sign in to Tmuxifier: password mode, OpenID Connect (OIDC) mode with authentik, Google or
any other provider, and passkeys. Part of the [Tmuxifier docs](../README.md).

`TMUXIFIER_AUTH_MODE` selects the primary login method: `password` (default) or `oidc`, which
replaces the password form with sign-in through one or more OIDC providers. `oauth` and `google`
remain accepted aliases of `oidc`. The two modes are mutually exclusive — pick one. A passkey
(below) is a separate, additive way in, available under **either** setting.

Password mode:
```bash
npm run set-password
```
This writes `TMUXIFIER_PASSWORD_HASH` and, if absent, `TMUXIFIER_COOKIE_SECRET` to `.env`.

## OIDC mode

```bash
npm run gen-secret
```
Then set these `.env` keys (or the `config.json` equivalents below):
```ini
TMUXIFIER_AUTH_MODE=oidc
TMUXIFIER_BASE_EXTERNAL_URL=tmuxifier.example.com
TMUXIFIER_ALLOWED_EMAILS=you@example.com,teammate@example.com
TMUXIFIER_OIDC_PROVIDERS=authentik
TMUXIFIER_OIDC_AUTHENTIK_ISSUER=https://auth.example.com/application/o/tmuxifier/
TMUXIFIER_OIDC_AUTHENTIK_CLIENT_ID=...
TMUXIFIER_OIDC_AUTHENTIK_CLIENT_SECRET=...
```
Tmuxifier treats a scheme-less public URL as HTTPS.

- `TMUXIFIER_OIDC_PROVIDERS` is an ordered, comma-separated list of provider ids (lowercase
  letters, digits and `-`, up to 32 characters). Each id takes `TMUXIFIER_OIDC_<ID>_ISSUER`,
  `_CLIENT_ID`, `_CLIENT_SECRET`, and optionally `_LABEL` (button text) and
  `_ALLOW_UNVERIFIED_EMAIL=on`; `<ID>` is the id upper-cased with `-` as `_`. The issuer must be
  an `https://` URL (`http://` is accepted only for a loopback host: `127.0.0.1`, `localhost`,
  `[::1]`).
- `config.json` can instead carry an `oidcProviders` array of `{ id, label, issuer, clientId,
  clientSecret, allowUnverifiedEmail }` (`allowUnverifiedEmail` is a boolean). When `TMUXIFIER_OIDC_PROVIDERS` is set it defines the list and order, and
  `TMUXIFIER_OIDC_<ID>_*` values override the matching `config.json` entry field by field; a
  `config.json` provider not in that list is ignored (boot logs it).
- Sign-in requires a verified email (`email_verified`) that is in `TMUXIFIER_ALLOWED_EMAILS`
  (exact addresses, case-insensitive; no domain wildcards).
- The redirect URI to register at the provider is
  `https://tmuxifier.example.com/api/auth/oidc/<id>/callback`. A provider with id `google`,
  explicit or from the legacy keys, always uses `https://tmuxifier.example.com/api/auth/google/callback`.

### What the login page does

- **Exactly one provider, configured explicitly:** opening Tmuxifier signed out redirects straight to that provider.
  An expired session does the same, so a still-live provider session signs you back in silently.
- **Two or more providers, or Google via the legacy keys:** the login page shows one button per
  provider (plus the passkey button when one is enrolled). No auto-redirect.
- **A failed sign-in** returns to `/?error=<code>`. A page with an `?error=` query shows the login
  page with the error instead of auto-redirecting, so failures do not loop.
- **Sign out** shows a "Signed out" page instead of bouncing you back in. Logout is local only:
  it ends the Tmuxifier session but not your session at the provider (the authentik session
  survives). The page has a Sign in button and a link to `/?login`.
- **`/?login`** always shows the full login page: every provider, the passkey button, and — if
  `TMUXIFIER_PASSWORD_HASH` is set — the password form, which acts as a break-glass login in OIDC
  mode (same rate limit; refused while "Require a passkey" is armed). Remove the hash to disable
  it. A Google deployment that still has an old hash in `.env` gets this password login too.

### authentik

1. In authentik, **Applications → Providers → Create** an **OAuth2/OpenID Provider**. Client
   type **Confidential**.
2. Set the redirect URI (strict) to
   `https://tmuxifier.example.com/api/auth/oidc/authentik/callback`.
3. Scopes: `openid` and `email`.
4. Create an **Application** using that provider and bind it to the user(s) allowed in
   (policy/group bindings). The issuer is the provider's OpenID Configuration Issuer, like
   `https://auth.example.com/application/o/tmuxifier/`.
5. Copy the client id and secret into the `TMUXIFIER_OIDC_AUTHENTIK_*` keys above.

authentik's default `email` claim reports `email_verified: false`. Recommended: add a custom
scope mapping that returns `email_verified: true` and attach it to the provider. The alternative
is `TMUXIFIER_OIDC_AUTHENTIK_ALLOW_UNVERIFIED_EMAIL=on`. With it on, anyone who can set the
allowlisted email at that provider can sign in, because `TMUXIFIER_ALLOWED_EMAILS` is shared
across all providers.

> **Warning.** Either way, Tmuxifier trusts the email authentik reports. authentik's default
> user-settings flow lets users edit their own email, so any authentik user could claim an
> allowlisted address. Disable email editing in the user-settings flow, or make sure you are
> the only user.

### Google

Google is now one provider of many. In Google Cloud Console, create an OAuth client ID for a web
application and register `https://tmuxifier.example.com/api/auth/google/callback`. The older
keys keep working unchanged and create an implicit `google` provider in OIDC mode:
```ini
TMUXIFIER_AUTH_MODE=oidc
TMUXIFIER_BASE_EXTERNAL_URL=tmuxifier.example.com
TMUXIFIER_OAUTH_CLIENT_ID=...
TMUXIFIER_OAUTH_CLIENT_SECRET=...
TMUXIFIER_ALLOWED_EMAILS=you@example.com
```
(`TMUXIFIER_GOOGLE_CLIENT_ID`/`_SECRET`, `TMUXIFIER_PUBLIC_URL`, and `config.json`
`googleClientId`/`googleClientSecret` are accepted too.) If a provider with id `google` is also
listed explicitly, it wins and boot logs a warning that the legacy keys are ignored.

## Passkeys

A passkey is an additional way in, available in **either** auth mode alongside password or
OIDC — it does not replace `TMUXIFIER_AUTH_MODE`. Enroll one from **Settings → Passkeys**
while already signed in (enrolling requires an existing session, so password/OIDC remains the
bootstrap and the recovery route); afterwards the login screen also offers **Sign in with a
passkey**.

Passkeys are bound to one hostname — the WebAuthn "relying party id" — which Tmuxifier takes
from `TMUXIFIER_RP_ID` if set, else the hostname of `TMUXIFIER_BASE_EXTERNAL_URL`, else
`localhost`. Two consequences:

- The browser must reach Tmuxifier at `https://<hostname>` or `http://localhost`. **An IP
  address cannot be a relying party id** — a deployment reached by IP simply shows passkeys as
  unavailable, with password/OIDC sign-in unaffected. That's only true when the id is
  *derived* this way, though: an explicit `TMUXIFIER_RP_ID` that isn't a valid domain name is
  instead treated as a configuration mistake and **fails startup** with an explanatory message.
- Changing that hostname invalidates every enrolled passkey. Settings → Passkeys detects the
  mismatch and names the hostname the existing passkeys belong to.

Optionally, **Require a passkey** (Settings → Passkeys → sign-in policy) disables password and
OIDC sign-in and the break-glass password entirely. Arming it is guarded against locking you out by accident: arming asks
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

- In OIDC mode, a passkey login never checks `TMUXIFIER_ALLOWED_EMAILS` — it authenticates a
  device credential, not the OIDC identity used to enroll it. Removing an email from the
  allowlist stops that person from signing in through OIDC again, but it does **not** revoke a
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

**Getting the app** is also a Settings → Devices affair: once a signed APK has been published on
the server, the tab shows a **Download the Android app** link. Open the dashboard in the phone's
browser (signed in — the same session cookie authenticates the download), download, install, then
pair. No link means no APK has been published yet.

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
  session, so the code inherits whatever gate that session passed — password, OIDC, or a
  passkey. That is why enrollment-by-code is allowed even while "require a passkey" is armed
  (the password branch still 403s there, exactly like the login form), and why it works on
  OIDC-mode servers where the password branch returns 501 (a break-glass password hash does not change that). Arming passkey-only does **not**
  revoke devices already enrolled — a device token never expires and ignores the logout
  watermark, so an existing token keeps working until it is explicitly revoked from
  Settings → Devices.
- **Revoking a device** is done from the dashboard, at **Settings → Devices**: it lists every
  enrolled device with its last-seen time and a Revoke button (arm-then-fire, like the other
  destructive controls in Settings). Revocation takes effect on the device's very next request —
  just as immediate as logout's watermark revoking a browser session cookie. The real asymmetry is
  that a session cookie also expires on its own after 7 days, while a device token never does — it
  is a standing credential until someone revokes it from Settings → Devices.
- **Device tokens are scoped to a default-deny route allowlist.** The server permits only the
  Android Console and MCP routes on a Bearer device token (with `PATCH /api/boxes/:id` limited to
  `sessionName` and `POST /api/proxmox/lifecycle-jobs` to non-destructive power actions). Every
  other route — Host Shell, upload/voice, deletions, export/import, credential/settings
  administration, pairing codes, APK builds, device revocation, and passkey management — refuses a
  device token with `403 browser session required`. So does AI-auth seeding, on both setup and
  provisioning. The allowlist limits a stolen token but doesn't make it harmless: it can still run
  commands on every box and add new ones. See
  [what a stolen token can still do](mcp.md#what-a-stolen-token-can-still-do).
- Once enrolled, the device authenticates every request with `Authorization: Bearer <token>`; it
  never needs the password again unless it re-enrolls.

**Push notifications** are optional, separate from enrollment, and fully per-instance: the
app carries no Firebase project of its own — it registers at runtime against whatever project
your server's `TMUXIFIER_FCM_APP_CONFIG` declares (served to enrolled devices as public
client identifiers via `GET /api/devices/fcm-config`). If `TMUXIFIER_FCM_CREDENTIALS`
in `.env` points at a Firebase service-account JSON file, Tmuxifier pushes agent-input/agent-done
notifications to enrolled devices via FCM as they happen. Leaving it unset means the app receives
no proactive notifications, but enrollment and the device token behave identically either way.
