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
