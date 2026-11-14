# Authentication

How to sign in to Tmuxifier: password mode, OpenID Connect (OIDC) mode with authentik, Google or
any other provider, and passkeys. Part of the [Tmuxifier docs](../README.md).

`TMUXIFIER_AUTH_MODE` selects the primary login method: `password` (default) or `oidc`, which
replaces the password form with sign-in through one or more OIDC providers. `oauth` and `google`
remain accepted aliases of `oidc`. The two modes are mutually exclusive — pick one; OIDC mode has
no password login at all. If the provider is unavailable or misconfigured, edit `.env`, set
`TMUXIFIER_AUTH_MODE=password`, run `npm run set-password`, and restart. A passkey (below) is a
separate, additive way in, available under **either** setting.

Password mode:
```bash
npm run set-password
```
This writes `TMUXIFIER_PASSWORD_HASH` and, if absent, `TMUXIFIER_COOKIE_SECRET` to `.env`.

## Any OIDC provider

OIDC mode works with any standards-compliant provider. Choose an id for each one (lowercase
letters, digits, `-`) and list them in `TMUXIFIER_OIDC_PROVIDERS`; the keys below use `<ID>`, the
id upper-cased with `-` as `_`. The values here use `authentik` only as the example id.

```ini
TMUXIFIER_OIDC_PROVIDERS=authentik
TMUXIFIER_OIDC_AUTHENTIK_ISSUER=https://auth.example.com/application/o/tmuxifier/
TMUXIFIER_OIDC_AUTHENTIK_CLIENT_ID=...
TMUXIFIER_OIDC_AUTHENTIK_CLIENT_SECRET=...
TMUXIFIER_OIDC_AUTHENTIK_ALLOWED_EMAILS=you@example.com
```

- Keys: `_ISSUER` (`https://`), `_CLIENT_ID`, `_CLIENT_SECRET`, and optionally `_LABEL`,
  `_ALLOW_UNVERIFIED_EMAIL` and `_ALLOWED_EMAILS`.
- Redirect URI to register: `<TMUXIFIER_BASE_EXTERNAL_URL>/api/auth/oidc/<id>/callback`.
- Tmuxifier requests the `openid` and `email` scopes and requires `email_verified=true` unless
  the provider sets `_ALLOW_UNVERIFIED_EMAIL=on`.
- **Allowlist.** `_ALLOWED_EMAILS` is a comma-separated list of exact emails (case-insensitive)
  for that provider only. A provider's own list **replaces** `TMUXIFIER_ALLOWED_EMAILS` for it
  (no union); a provider without one falls back to the global list. In `config.json` use
  `allowedEmails` (array or comma string); the env key overrides the file. The legacy Google keys
  always use the global list. Boot fails if any provider ends up with no allowed emails. With more
  than one provider, set a per-provider list, so an address trusted at one provider can't sign in
  through another.

Provider-specific notes follow (authentik, then Google).

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
  clientSecret, allowUnverifiedEmail, allowedEmails }` (`allowUnverifiedEmail` is a boolean; `allowedEmails` an array or comma string). When `TMUXIFIER_OIDC_PROVIDERS` is set it defines the list and order, and
  `TMUXIFIER_OIDC_<ID>_*` values override the matching `config.json` entry field by field; a
  `config.json` provider not in that list is ignored (boot logs it).
- Sign-in requires a verified email (`email_verified`) that is in the provider's allowlist: its
  own `TMUXIFIER_OIDC_<ID>_ALLOWED_EMAILS`, else `TMUXIFIER_ALLOWED_EMAILS` (exact addresses,
  case-insensitive; no domain wildcards).
- The redirect URI to register at the provider is
  `https://tmuxifier.example.com/api/auth/oidc/<id>/callback`. A provider with id `google`,
  explicit or from the legacy keys, always uses `https://tmuxifier.example.com/api/auth/google/callback`.
  The branded "Sign in with Google" button appears only for a provider whose issuer is
  `https://accounts.google.com`; every other provider gets a plain button with its own label.

### What the login page does

- **Exactly one provider, configured explicitly:** opening Tmuxifier signed out redirects straight to that provider.
  Only a fresh page load redirects: an expired session (a 401 while the app is open) shows the
  login page with a "Session expired" message and never redirects, so it cannot loop through the provider.
- **Two or more providers, or Google via the legacy keys:** the login page shows one button per
  provider (plus the passkey button when one is enrolled). No auto-redirect.
- **A failed sign-in** returns to `/?error=<code>`. A page with an `?error=` query shows the login
  page with the error instead of auto-redirecting, so failures do not loop.
- **Sign out** shows a "Signed out" page instead of bouncing you back in. Logout is local only:
  it ends the Tmuxifier session but not your session at the provider (the authentik session
  survives). A "signed out" flag in the browser's `localStorage` makes every tab, including a
  newly opened one, show the signed-out page (with the provider buttons) until you sign in again.
  The signed-out page has no `/?login` link.
- **`/?login`** always shows the full login page without redirecting: every provider and the
  passkey button. There is no password form in OIDC mode, even if `TMUXIFIER_PASSWORD_HASH` is
  still in `.env` — it is ignored.

### authentik

**1. Provider.** In authentik, **Applications → Providers → Create** an **OAuth2/OpenID
Provider**:

- Client type **Confidential**.
- Redirect URIs: **Strict**, `https://tmuxifier.example.com/api/auth/oidc/authentik/callback`.
  It must match `TMUXIFIER_BASE_EXTERNAL_URL` exactly (scheme, host, port).
- Scopes: `openid` and `email` (Tmuxifier reads only `email`).
- Signing key: any. Tmuxifier takes the id_token straight from the token endpoint over TLS and
  doesn't verify its signature.

Note the **Client ID**, **Client Secret** and the **OpenID Configuration Issuer**
(e.g. `https://auth.example.com/application/o/tmuxifier/`, trailing slash included) and put them
in the `TMUXIFIER_OIDC_AUTHENTIK_*` keys above.

**2. Verified email (recommended).** authentik's default `email` mapping reports
`email_verified: false`, which Tmuxifier rejects. Under **Customization → Property Mappings →
Create**, add a **Scope Mapping** with scope name `email` and the expression:

```python
return {"email": request.user.email, "email_verified": True}
```

Then on the provider, under **Advanced protocol settings → Scopes**, replace the default `email`
mapping with this one. The alternative is `TMUXIFIER_OIDC_AUTHENTIK_ALLOW_UNVERIFIED_EMAIL=on`.
With it on, anyone who can set the allowlisted email at that provider can sign in, so give
each provider its own `_ALLOWED_EMAILS` when you run more than one.

**3. Application and bindings.** **Applications → Create** an application using the provider and
add **Policy / Group / User Bindings** for only the user(s) or group allowed in. Without a
binding, every authentik user can obtain a token for it (the allowlist still applies).

> **Warning.** Either way, Tmuxifier trusts the email authentik reports. authentik's default
> user-settings flow lets users edit their own email, so any authentik user could claim an
> allowlisted address. Under **Flows → default-user-settings-flow**, remove the email field
> from its prompt stage (or make it read-only), or make sure you are the only user.

**Testing on a LAN address.** For a throwaway instance you can skip the public hostname: the
redirect is followed by your browser, so authentik never has to reach Tmuxifier. Use the same
address everywhere, e.g. `TMUXIFIER_BIND=192.168.1.10`, `TMUXIFIER_PORT=7440`,
`TMUXIFIER_BASE_EXTERNAL_URL=http://192.168.1.10:7440`, redirect URI
`http://192.168.1.10:7440/api/auth/oidc/authentik/callback`, and open Tmuxifier at that exact
address (the session cookie is per host). Plain `http` works but leaves the session cookie
non-`Secure`; use it for testing only. The issuer still has to be `https` (unless authentik runs
on loopback) and reachable from the Tmuxifier host. Passkeys are unavailable on an IP-address
URL, so don't arm "Require a passkey" there.

**Troubleshooting.**

- Boot fails: the log line names the missing or invalid key (non-`https` issuer, bad provider
  id, a provider with no allowed emails, missing `TMUXIFIER_BASE_EXTERNAL_URL`).
- `?error=provider`: discovery or the token exchange failed — wrong issuer or client secret,
  or the Tmuxifier host can't reach `<issuer>/.well-known/openid-configuration`.
- `?error=forbidden`: the email isn't in that provider's allowlist, `email_verified` is still
  false (step 2), or the provider itself refused (`access_denied`: consent cancelled, or the user
  isn't allowed to use the application there).
- `?error=state`: the sign-in took over 5 minutes or started on a different address than the
  callback; start again from the same URL. Each sign-in has its own state cookie, so several tabs
  signing in at once don't interfere.
- authentik shows "redirect URI mismatch": its redirect URI and `TMUXIFIER_BASE_EXTERNAL_URL`
  differ.

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
OIDC sign-in entirely. Arming it is guarded against locking you out by accident: arming asks
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

- In OIDC mode, a passkey login never checks any OIDC allowlist — it authenticates a
  device credential, not the OIDC identity used to enroll it. Removing an email from the
  allowlist stops that person from signing in through OIDC again, but it does **not** revoke a
  passkey they already enrolled; remove that passkey from Settings → Passkeys to revoke it.
  (Only an already-authenticated user can enroll one, so this isn't a privilege-escalation path —
  just a separate revocation step to remember.)
- Passkey sign-in challenges are bounded per client address, the same way login attempts are
  rate-limited per IP. That stops a single flooding source from evicting another user's in-flight
  sign-in, but an attacker spread across many source addresses could still exhaust the bound and
  deny sign-in — under **Require a passkey** that would deny everyone, and the
  `TMUXIFIER_PASSKEY_ONLY=off` switch above is the remedy.

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
  OIDC-mode servers where the password branch returns 501 ("device enrollment by password is off in OIDC mode; use a pairing code"). Arming passkey-only does **not**
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
