# Security Review — Tmuxifier Full Codebase

**Date:** 2026-06-21 (originally misdated 2025 — year typo, filename fixed 2026-07-04)
**Scope:** All source files under `src/server/`, `src/web/`, and supporting modules
**Result:** No HIGH or MEDIUM confidence exploitable vulnerabilities found

**Status note, 2026-06-22:** the resize bound and ControlMaster directory permission
defense-in-depth observations below have since been addressed in source (`sessions.js`
clamps PTY resize dimensions and `index.js` creates the control directory with `0o700`).

---

## Executive Summary

A full-codebase security review was performed on Tmuxifier, focusing on four public-facing surfaces:

1. **SSH command construction** — the highest-stakes surface: user-defined box configurations
   are turned into `ssh` command lines
2. **Authentication & session management** — password (scrypt) and Google OAuth (PKCE) login
   paths with signed cookies
3. **WebSocket / PTY lifecycle** — browser terminals backed by live `ssh` subprocesses
4. **REST API & web client** — box CRUD, status probes, origin checking, CSP headers

After exhaustive analysis and adversarial filtering against the OWASP-based false-positive
exclusion criteria, **zero HIGH or MEDIUM confidence exploitable vulnerabilities were
identified.** The codebase demonstrates disciplined security engineering across all four
surfaces.

---

## What Was Analyzed

| Surface | Files | Key Defenses |
|---------|-------|-------------|
| SSH injection | `sshCommand.js`, `sshRun.js`, `boxActions.js`, `sessions.js`, `store.js` | Allowlist regexes, flag-injection rejection, `execFile` (non-shell), `shSingleQuote` |
| Authentication | `auth.js`, `googleAuth.js`, `server.js` | scrypt + timing-safe compare, PKCE+S256, signed httpOnly SameSite cookies, rate limiting |
| WebSocket/PTY | `server.js` (WS handler), `sessions.js` | Independent origin + auth re-check on upgrade, provision mode gated on explicit flags |
| Web security | `server.js` (hooks), `main.ts`, `api.ts` | CSP, CORP, XFO, origin validation, SameSite cookies, textContent rendering |
| Configuration | `config.js`, `envFile.js`, `configFile.js` | 0o600 file permissions, merge precedence, fast-fail at startup |

---

## Attack Surface Walkthrough

### 1. SSH Command Injection (CRITICAL surface — NO findings)

Every SSH invocation goes through `assertBoxSafe()` (`sshCommand.js:44-54`) which validates:

- `host` against `/^[A-Za-z0-9_.-]+$/`
- `user` against `/^[A-Za-z0-9_.-]+$/`
- `proxyJump` against `/^[A-Za-z0-9_.@:,-]+$/`
- `port` as integer 1–65535
- Rejects any value starting with `-` (flag injection prevention)

All SSH invocations use `execFile('ssh', argv, ...)` — arguments are passed as an array, so
**no shell interpolation occurs on the Tmuxifier host.** The remote command (`tmux
new-session …`) is built with `sanitizeSession()` + `shSingleQuote()` which correctly escapes
the startup command for POSIX shells.

`store.js` calls `assertBoxSafe()` on every create and update path. SSH config imports
silently skip entries that fail validation. This is a thorough, defense-in-depth approach.

### 2. Authentication (NO findings)

- **Password mode:** scrypt with 16-byte random salt, 32-byte derived key, `timingSafeEqual`
  comparison. Rate limited: 10 attempts/60s/IP with a 1000-entry memory cap.
- **OAuth mode:** Google OIDC with authorization-code flow + PKCE (SHA-256 challenge,
  32-byte random verifier). State cookie signed, 5-minute TTL. Token exchange happens
  server-to-server over TLS — the id_token payload is trusted from Google's token endpoint
  without a separate JWKS verification step, which is a well-reasoned simplification for
  a single-user tool.
- **Session cookie:** `httpOnly`, `SameSite=lax`, `Secure` when TLS is configured (local or
  via HTTPS public URL), 7-day maxAge, signed via `@fastify/cookie`.
- Auth modes are mutually exclusive — no mode confusion possible.

### 3. WebSocket Handler (NO findings)

The `/term` WebSocket handler (`server.js:273-396`) performs three checks before creating
any PTY:

1. Origin validation via `hasTrustedOrigin()`
2. Authentication via `isAuthed()` (with manual cookie-header parsing fallback for
   `@fastify/websocket` v10)
3. Box lookup via `store.getBox(boxId)`

Provision mode (`mode=provision`) is gated: `ohMyTmux`/`ohMyZsh`/`ohMyBash` are strictly
compared against `'1'`. The provision script is built server-side from fixed templates.
The `__local__` special boxId rejects provision mode.

### 4. Origin & CORS Security (NO findings)

- `requireTrustedOrigin` hook runs on every request (`server.js:88`)
- Allowed origins include the request's own `Host` header (both `http://` and `https://`
  variants) and the configured `publicUrl` origin
- GET/HEAD/OPTIONS are exempt (safe methods; OPTIONS handles CORS preflight)
- Non-GET requests with a disallowed `Origin` header receive 403
- The `Host` header is attacker-controlled in theory, but in practice: (a) the default bind
  is `127.0.0.1`, unreachable externally; (b) SameSite=lax cookies are not sent on
  cross-origin POST/PATCH/DELETE; (c) `Content-Type: application/json` triggers a CORS
  preflight for cross-origin requests. Operators exposing the service behind a reverse proxy
  should ensure the proxy normalizes the Host header.

### 5. Web Client (NO findings)

- No use of `eval()`, no inline event handlers, no inline `<script>` tags
- All user data rendered via `textContent` (not `innerHTML`): box labels, tag names, group
  headers
- `CSS.escape()` used for selector construction with box IDs
- `crypto.randomUUID()` for WebSocket client IDs
- Login error display maps error codes to hardcoded strings — no raw query-parameter
  reflection
- Client-side input validation for port (1–65535) and host (non-empty) before API calls

### 6. File Permissions (INFORMATIONAL)

- `.env`: written `0o600` with explicit `chmodSync` defense-in-depth (`envFile.js:67-68`)
- `config.json`: written `0o600` (`configFile.js:30-31`)
- `boxes.json`: no explicit `mode` on `writeFile` (`store.js:29`) — inherits process umask.
  Contains fleet topology (hostnames, usernames, proxy hosts) but no secrets. Operators
  hardening deployments should set a restrictive umask or adjust file permissions.

---

## Defense-in-Depth Observations

These are areas where additional hardening could reduce risk, though no exploitable
vulnerability path was found:

1. **PTY resize bounds** (`sessions.js:113`) — `cols` and `rows` from WebSocket messages
   are not bounded. An attacker with a valid session could send extreme values to
   `pty.resize()`. Recommend clamping to reasonable limits (e.g., 1000×1000).

2. **ControlMaster socket directory permissions** (`index.js:25`) — `fs.mkdirSync` with no
   explicit mode. The SSH ControlMaster sockets stored under `data/cm/` are Unix domain
   sockets only usable by the same user, but explicit directory permissions would be
   defense-in-depth.

3. **Provision scripts** (`boxActions.js:11-159`) — Downloaded Oh My Zsh / Oh My Bash / Oh
   My Tmux installers are fetched over HTTPS but not integrity-checked (no hash
   verification). This is a user-initiated action (checkbox opt-in) and GitHub compromise is
   a supply-chain concern beyond Tmuxifier's scope, but SHA-256 pinning would add
   defense-in-depth.

---

## Methodology

The review followed a three-phase process:

1. **Reconnaissance** — Every server file read in full; data flow from network input to
   sensitive operations traced; attack surface boundaries mapped.
2. **Vulnerability assessment** — Each potential finding evaluated against the OWASP Top 10
   categories: injection, broken authentication, sensitive data exposure, XXE, broken access
   control, security misconfiguration, XSS, insecure deserialization, vulnerable components,
   insufficient logging.
3. **Adversarial filtering** — Every candidate finding tested against the false-positive
   exclusion criteria. Findings below confidence 8/10 or severity MEDIUM were dropped.

---

## Conclusion

Tmuxifier's security posture is strong for its threat model (single-user local tool). The
SSH command injection surface — the most critical — is defended with multiple overlapping
layers: strict allowlist regex validation, flag injection prevention, `execFile` (non-shell)
invocation, and proper POSIX shell quoting. Authentication uses sound cryptographic
primitives. The web security stack (CSP, CORP, XFO, origin validation, SameSite cookies) is
coherent and well-configured. The codebase follows dependency injection patterns that make it
testable without mocks, and every auth/authz check is independently verified at each
boundary (HTTP hooks, WebSocket upgrade, PTY creation).

**No HIGH or MEDIUM severity exploitable vulnerabilities with confidence ≥ 8 were found.**
