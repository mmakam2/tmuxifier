# CLAUDE.md

Guidance for working in this repo. Keep it current when architecture or conventions change.

## What this is

Tmuxifier is a single-user web dashboard for managing headless boxes over SSH. Each box opens
a browser terminal (xterm.js) backed by a tmux session that runs **on the box**, so the work
survives tab closes, network drops, and Tmuxifier restarts — reconnecting reattaches the same
session. Tmuxifier stores **no SSH secrets**; it shells out to the OpenSSH client and relies on
your keys/agent/`~/.ssh/config`.

## Self-contained principle

This project is meant to run from the repo folder with nothing required in the surrounding
shell. Configuration, secrets, and runtime state all live **inside the repo**:

- `.env` (gitignored) — all `TMUXIFIER_*` config, written by `npm run set-password`. See
  `.env.example`.
- `config.json` (gitignored, optional) — camelCase alternative to `.env`.
- `tls/` (gitignored) — `cert.pem`/`key.pem` for HTTPS; the private key never enters git.
- `data/` (gitignored) — `boxes.json` and SSH ControlMaster sockets under `data/cm/`.

When adding a new config knob or persisted file, keep it under the repo folder by default.
Don't introduce dependencies on `$HOME`-level state other than the user's existing SSH setup.

## Commands

```bash
npm install
npm run build        # vite build -> dist/ (server serves this statically; build before start)
npm run set-password # writes TMUXIFIER_PASSWORD_HASH + TMUXIFIER_COOKIE_SECRET into ./.env
npm run gen-secret   # writes only TMUXIFIER_COOKIE_SECRET for Google auth mode
npm start            # node src/server/index.js
npm run dev          # vite + node --watch, proxies /api and /term to the backend
npm test             # vitest run (unit + integration)
npm run test:e2e     # playwright (spins up a local sshd-backed box; see test/helpers)
```

## Configuration model

`loadConfig(overrides, { env, cwd })` in `src/server/config.js` merges, low → high precedence:

```
defaults  →  config.json  →  .env file  →  shell env  →  overrides
```

- `.env` is parsed by `src/server/envFile.js` (dependency-free) and folded into the env map as
  `{ ...readEnvFile('.env'), ...process.env }`, so a real exported shell variable overrides the
  file.
- `loadConfig` is **pure and injectable** — never read `process.env`/`process.cwd()` directly in
  it or in tests. Tests pass explicit `{ env, cwd }`. Preserve this.
- `set-password` writes the hash every run but only generates a cookie secret when one is absent,
  so password changes don't rotate the secret / log everyone out.
- `TMUXIFIER_AUTH_MODE` is `password` (default) or `oauth`; modes are mutually exclusive.
  `google` is still accepted as a legacy alias for OAuth mode.
- In OAuth mode, `TMUXIFIER_BASE_EXTERNAL_URL` builds the OAuth callback URL. A scheme-less value is
  normalized to HTTPS, and an `https://` value marks the session cookie `Secure` even when local
  TLS is not configured. `TMUXIFIER_PUBLIC_URL` is accepted as a legacy alias.

## Architecture (`src/server/`)

Modules are factory functions (`createStore`, `createSessionManager`, `createStatusChecker`) with
dependencies injected as arguments — this is what makes them testable without mocks. Follow that
pattern for new modules.

- `index.js` — entrypoint: loads config, fails fast if mode-specific auth config is missing, wires everything,
  serves `dist/` and listens.
- `config.js` / `envFile.js` — configuration + `.env` parsing/upsert.
- `auth.js` — scrypt password hashing, signed-cookie options (`COOKIE_NAME`).
- `googleAuth.js` — dependency-free Google OIDC helper: authorization-code flow, PKCE, id_token
  payload decoding, and exact-email allowlist checks.
- `server.js` — Fastify app: login rate-limiting, REST under `/api/*`, and the `/term` WebSocket.
- `store.js` — `data/boxes.json` CRUD; normalizes/validates boxes; imports from `~/.ssh/config`.
- `sshCommand.js` — builds `ssh` argv for attach/probe; **all box fields are validated by
  `assertBoxSafe` and never shell-interpolated unquoted**. Touch this carefully (command-injection
  surface). Includes ControlMaster multiplexing args.
- `sshConfig.js` / `sshRun.js` — parse `~/.ssh/config`; run one-shot ssh probes.
- `sessions.js` — PTY lifecycle: PTYs keyed by `boxId`, listeners refcounted, a `graceSeconds`
  window keeps a dropped PTY alive for seamless reconnects, then it's killed while the on-box tmux
  session keeps running.
- `status.js` — per-box reachability/status probes.

Web client is `src/web/` (TypeScript + xterm.js, bundled by Vite): `main.ts`, `api.ts`,
`terminal.ts`, `index.html`, `style.css`.

## Conventions

- ESM everywhere (`"type": "module"`); Node 20+.
- TDD: write the failing test first (see `test/`). Tests use **real code, not mocks** — enabled by
  the dependency-injection factories above.
- Server is plain `.js`; web client is `.ts`.
- Conventional-commit style messages (`fix(pty): …`, `feat(ui): …`).

## Security notes

- The login gate is the crown jewel (Tmuxifier can SSH into your whole fleet). Binds to
  `127.0.0.1` by default; expose only behind TLS.
- Auth modes are mutually exclusive: password mode mounts `POST /api/login`; OAuth mode mounts
  `/api/auth/google/*` and removes the password login path.
- Google auth is hand-rolled OIDC in `googleAuth.js`: state cookie + PKCE, token exchange
  server-to-server, then exact-email allowlist. The id_token payload is trusted because it is
  fetched directly from Google's token endpoint over TLS in the authorization-code flow.
- Passwords are scrypt-hashed; the session cookie is signed, httpOnly, SameSite=lax. It is marked
  `Secure` when local TLS is configured (`tlsCert` + `tlsKey`) or `TMUXIFIER_BASE_EXTERNAL_URL`
  starts with `https://`.
- `.env` holds the password hash and cookie secret, so `upsertEnvFile` writes it `0o600`
  (owner-only). Keep that mode if you change the write path.
- Box host/user/port/proxyJump are validated against allowlist regexes before reaching `ssh`;
  the remote tmux command single-quotes any `startupCommand`. Keep new ssh-facing fields on the
  same validation path.
- WebSocket auth re-parses the cookie header manually (`@fastify/websocket` v10 doesn't populate
  `req.cookies` for the upgrade) — see `isAuthed` in `server.js`.

## Docs

- `README.md` — user-facing setup/config/security.
- `docs/DEPLOY.md` + `deploy/tmuxifier.service` — running it as a systemd service (self-contained
  layout, no secrets in the unit; `HOME` set in the unit so ssh children find `~/.ssh`).
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — point-in-time design/plan records;
  don't rewrite history there, add a new dated doc for new work.
