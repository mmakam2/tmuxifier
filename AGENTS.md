# AGENTS.md

Guidance for coding agents working in this repo. Keep it current when architecture or conventions change.

## What this is

Tmuxifier is a single-user web dashboard for managing headless boxes over SSH. Each box opens
a browser terminal (xterm.js) backed by a tmux session that runs **on the box**, so the work
survives tab closes, network drops, and Tmuxifier restarts — reconnecting reattaches the same
session. Tmuxifier stores **no SSH secrets**; it shells out to the OpenSSH client and relies on
your keys/agent/`~/.ssh/config`.

## Self-contained principle

This project runs from the repo folder with nothing required in the surrounding shell.
Configuration, secrets, and runtime state all live **inside the repo**:

- `.env` (gitignored) — all `TMUXIFIER_*` config, written by `npm run set-password`. See
  `.env.example`.
- `config.json` (gitignored, optional) — camelCase alternative to `.env`.
- `tls/` (gitignored) — `cert.pem`/`key.pem` for HTTPS; the private key never enters git.
- `data/` (gitignored) — `boxes.json`, `fleet-jobs.json` (Fleet Command history), `proxmox.json`
  (Proxmox host profiles with **encrypted** API tokens, SSH management keys, and an optional root
  password — all AES-256-GCM sealed — plus container presets), `provision-jobs.json` (provision
  history), `health-events.json` (in-app health event log), and SSH ControlMaster sockets under
  `data/cm/`.

When adding a new config knob or persisted file, keep it under the repo folder by default.
Don't introduce dependencies on `$HOME`-level state other than the user's existing SSH setup.

Any file that must hold real secrets or PII to run locally is **gitignored and ships with a
placeholder counterpart**, so contributors get the shape without the data: `.env` → `.env.example`;
`config.json` → the same keys in `.env.example` (camelCase); `tls/` → generation steps in
`docs/DEPLOY.md`; `data/boxes.json` → created at runtime (boxes are added via the UI, or imported
from a JSON file previously produced by the export button). Add the placeholder/instructions in the
same change that introduces the file.

## Commands

```bash
npm install
npm run build        # vite build -> dist/ (server serves this statically; build before start)
npm run set-password # writes TMUXIFIER_PASSWORD_HASH + TMUXIFIER_COOKIE_SECRET into ./.env
npm run gen-secret   # writes only TMUXIFIER_COOKIE_SECRET for OAuth mode
npm start            # node src/server/index.js
npm run dev          # vite + node --watch, proxies /api and /term to the backend
npm run typecheck    # tsc --noEmit over src/web (the TS client; vite/vitest strip types unchecked)
npm test             # typecheck + vitest run (unit + integration)
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
- `config.js` / `envFile.js` / `configFile.js` — configuration: the low→high precedence merge,
  `.env` parsing/upsert (`envFile.js`), and `config.json` (camelCase) parsing (`configFile.js`).
- `concurrency.js` — `mapWithConcurrency`, the bounded-parallelism helper status sweeps and Fleet
  runs use so a sweep never opens the whole fleet's SSH connections at once.
- `auth.js` — scrypt password hashing, signed-cookie options (`COOKIE_NAME`), and the session
  value helpers (`sessionValue`/`sessionValueValid`): the cookie embeds its issue time and is
  rejected server-side after `SESSION_TTL_SECONDS`, so a captured cookie can't authenticate forever.
- `rateLimit.js` — `createLoginRateLimiter`: per-IP login lockout with a bounded map (overflow
  evicts the oldest window, never clears everyone).
- `googleAuth.js` — dependency-free Google OIDC helper: authorization-code flow, PKCE, id_token
  payload decoding, and exact-email allowlist checks.
- `server.js` — Fastify app: login rate-limiting, REST under `/api/*`, and the `/term` WebSocket.
- `store.js` — `data/boxes.json` CRUD; normalizes/validates boxes; exports/imports the box list as
  a versioned JSON file (`exportBoxes`/`importBoxes`; import re-mints ids and skips dup/unsafe entries).
- `sshCommand.js` — builds `ssh` argv for attach/probe; **all box fields are validated by
  `assertBoxSafe` and never shell-interpolated unquoted**. Touch this carefully (command-injection
  surface). Includes ControlMaster multiplexing args.
- `sshRun.js` — run one-shot ssh probes.
- `boxActions.js` — `createBoxActions`: per-box SSH operations over the shared ControlMaster —
  ensure/install tmux and selected shell frameworks, the non-interactive `execCommand` that Fleet
  Command runs, and ControlMaster liveness/stale-socket reaping (`isMasterAlive`/`reapStaleMaster`).
- `localShellActions.js` — `createLocalShellActions`: provisions the optional local shell
  (`localShell` = `none`/`omz`/`omb`) that backs a terminal on the Tmuxifier host itself.
- `sessions.js` — PTY lifecycle: PTYs keyed by `boxId`, listeners refcounted, a `graceSeconds`
  window keeps a dropped PTY alive for seamless reconnects, then it's killed while the on-box tmux
  session keeps running.
- `status.js` — per-box reachability/status probes; coalesces concurrent probes of the same box
  (in-flight de-dup) so multiple pollers don't fan out duplicate SSH connections.
- `statusPoller.js` — single server-side poll loop: probes every box on an interval
  (`statusPollMs`) and caches the snapshot `/api/status` serves, so status SSH volume is
  independent of how many dashboard tabs are open.
- `fleet.js` / `fleetStore.js` — `createFleetManager` runs one command across many boxes as a single
  persisted, pollable job (Fleet Command), fanning out at `fleetConcurrency`; `createFleetStore` is
  the debounced `data/fleet-jobs.json` persistence.
- `healthHistory.js` / `healthEventsStore.js` — `createHealthHistory` keeps a rolling in-memory
  sample series per box (fed by the status poller after each snapshot swap) and derives an
  edge-triggered events log (down/up/needs-auth/threshold, persisted to `data/health-events.json`
  by `createHealthEventsStore`); served by `GET /api/health/series|events`. `onEvent(cb)` is the
  deferred Phase-2 delivery seam — nothing subscribes in Phase 1 (in-app display only, no
  notifications).
- `secretBox.js` — AES-256-GCM seal/open for secrets at rest; key derived from `cookieSecret` via
  HKDF. Encrypts the persisted Proxmox secrets: the API token, any added SSH management keys, and
  the optional root password.
- `proxmoxValidate.js` — pure validators/parsers for Proxmox host/key/preset/provision input.
- `proxmoxStore.js` — `data/proxmox.json` CRUD for hosts, SSH keys, presets, and the optional root
  password; seals secrets on write and redacts them on read (`getHost(id,{withSecret})` is the only
  path that decrypts the token).
- `proxmoxApi.js` — PVE HTTP client over `node:https` with TLS fingerprint pinning, plus
  `inspectEndpoint`. The token never leaves the server.
- `proxmoxParams.js` — pure preset → `pct`/LXC create-param mapping (`net0`, `ssh-public-keys`, …).
- `defaultKey.js` — reads the Tmuxifier host's own SSH public key to inject as the default Proxmox
  management key so provisioned containers trust Tmuxifier (override with `TMUXIFIER_PVE_DEFAULT_PUBKEY`).
- `provisionStore.js` / `proxmoxProvision.js` — debounced `data/provision-jobs.json` persistence and
  the create→poll→start→discover→auto-link-box job manager (the Fleet job pattern).

Web client is `src/web/` (TypeScript + xterm.js, bundled by Vite): `main.ts`, `api.ts`,
`terminal.ts`, `index.html`, `style.css`, plus feature modules — `reconnect.ts` (escalating
backoff), `statusDot.ts`, `sparkline.ts`/`healthEvents.ts` (health history: pure SVG-path builder
and event-line formatters), `fleetSelection.ts`/`fleetHistory.ts`/`fleetEditor.ts` (Fleet
Command selection, recent-command history, and the CodeMirror bash-script editor),
`proxmox.ts`/`proxmoxUi.ts`, `clipboard.ts`, and `termFont.ts` (pure builder for the xterm
font stack — prepends `TMUXIFIER_TERM_FONT` onto the bundled stack (MesloLGMDZ Nerd Font default,
then MesloLGSDZ + JuliaMono fallback); the server
validates the name in `config.js` and serves it via `GET /api/ui-config`, which `main.ts` applies
at boot before any terminal opens).

## Conventions

- ESM everywhere (`"type": "module"`); Node 20+.
- TDD: write the failing test first (see `test/`). Tests use **real code, not mocks** — enabled by
  the dependency-injection factories above.
- Server is plain `.js`; web client is `.ts`.
- Conventional-commit style messages (`fix(pty): …`, `feat(ui): …`).

## Shipping (contributing changes back)

The GitHub repo is **public** — never commit real PII (your domains, public/LAN IPs, hostnames,
emails, box/fleet names). Real values live only in the gitignored files above; committed docs,
examples, and tests use placeholders (`example.com`, RFC1918 IPs like `192.168.1.10`,
`you@example.com`).

```bash
npm version patch --no-git-tag-version # bump package.json + package-lock.json by 0.0.1
npm run build                          # rebuild the web bundle with the new version
sudo systemctl restart tmuxifier       # restart the service to serve the new bundle
systemctl status tmuxifier
# Health check the deployed bind address — derive scheme/host/port from config so
# this never hardcodes your real bind address (the service may bind a routable
# address, not 127.0.0.1, in which case a loopback curl returns 000):
BASE="$(node -e "import('./src/server/config.js').then(({loadConfig})=>{const c=loadConfig();process.stdout.write(((c.tlsCert&&c.tlsKey)?'https':'http')+'://'+c.bindAddress+':'+c.port)})")"
curl -sk -o /dev/null -w '%{http_code}\n' "$BASE/"  # 200
VERSION="v$(node -p "require('./package.json').version")"
test "$(node -p "require('./package-lock.json').version")" = "${VERSION#v}"
test "$(node -p "require('./package-lock.json').packages[''].version")" = "${VERSION#v}"
git add -A
git diff --cached                      # PII scrub: review staged diff — no real domains/IPs/emails/hostnames
git commit -m "feat(…): description"   # conventional-commit style
git tag -a "$VERSION" -m "$VERSION"    # tag must match the package/lockfile version
git push origin main "$VERSION"
gh release create "$VERSION" --title "$VERSION" --notes "See commit history for changes."
test -n "$(git ls-remote --tags origin "$VERSION")"
test "$(gh release view "$VERSION" --json tagName --jq .tagName)" = "$VERSION"
```

## Security notes

- The login gate is the crown jewel (Tmuxifier can SSH into your whole fleet). Binds to
  `127.0.0.1` by default; expose only behind TLS.
- Auth modes are mutually exclusive: password mode mounts `POST /api/login`; OAuth mode mounts
  `/api/auth/google/*` and removes the password login path.
- OAuth is hand-rolled OIDC in `googleAuth.js`: state cookie + PKCE, token exchange
  server-to-server, then exact-email allowlist. The id_token payload is trusted because it is
  fetched directly from Google's token endpoint over TLS in the authorization-code flow.
- Passwords are scrypt-hashed; login attempts are rate-limited per IP (`rateLimit.js` — set
  `TMUXIFIER_TRUST_PROXY` behind a reverse proxy so the limiter sees real client IPs, and only
  then, since trusting forwarded headers from direct clients lets them spoof their IP). The
  session cookie is signed, httpOnly, SameSite=lax, and expires server-side after 7 days (the
  signed value embeds its issue time — see `auth.js`). It is marked
  `Secure` when local TLS is configured (`tlsCert` + `tlsKey`) or `TMUXIFIER_BASE_EXTERNAL_URL`
  starts with `https://`.
- `.env` holds the password hash and cookie secret, so `upsertEnvFile` writes it `0o600`
  (owner-only). Keep that mode if you change the write path.
- Box host/user/port/proxyJump are validated against allowlist regexes before reaching `ssh`;
  the remote tmux command single-quotes any `startupCommand`. Keep new ssh-facing fields on the
  same validation path.
- WebSocket auth re-parses the cookie header manually (`@fastify/websocket` v10 doesn't populate
  `req.cookies` for the upgrade) — see `isAuthed` in `server.js`.
- The persisted Proxmox secrets — the API token, any added SSH management keys, and the optional
  root password — are the only credentials Tmuxifier stores. They are AES-256-GCM encrypted at rest
  in `data/proxmox.json` (key from `cookieSecret`), written `0o600`, and never returned to the
  browser (host views are redacted to `hasToken`). PVE TLS is pinned by fingerprint for self-signed certs
  (TOFU, like `ssh accept-new`) or CA-verified; an explicit per-host `insecure` mode is off by
  default. All provision input is validated (`proxmoxValidate.js`) before reaching the API.

## Docs

- `README.md` — user-facing setup/config/security.
- `CLAUDE.md` — canonical project instructions (this file is kept in sync with it).
- `docs/DEPLOY.md` + `deploy/tmuxifier.service` — running it as a systemd service (self-contained
  layout, no secrets in the unit; `HOME` set in the unit so ssh children find `~/.ssh`).
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — point-in-time design/plan records;
  don't rewrite history there, add a new dated doc for new work.
