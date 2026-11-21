# CLAUDE.md

Guidance for working in this repo. Keep it current when architecture or conventions change.
This file is a **map**: one entry per module, plus the rules that are easy to break. The
detailed rationale (and the incident that produced it) lives in each module's header comment —
read that before changing the module. History belongs in git and `docs/superpowers/`, not here.

## What this is

Tmuxifier is a single-user web dashboard for managing headless boxes over SSH. Each box opens
a browser terminal (xterm.js) backed by a tmux session that runs **on the box**, so the work
survives tab closes, network drops, and Tmuxifier restarts — reconnecting reattaches the same
session. Tmuxifier stores **no SSH secrets**; it shells out to the OpenSSH client and relies on
your keys/agent/`~/.ssh/config`.

## Self-contained principle

The project runs from the repo folder with nothing required in the surrounding shell.
Configuration, secrets, and runtime state all live **inside the repo** (all gitignored):

- `.env` — all `TMUXIFIER_*` config, written by `npm run set-password`. See `.env.example`.
- `config.json` (optional) — camelCase alternative to `.env`.
- `tls/` — `cert.pem`/`key.pem` for HTTPS; the private key never enters git.
- `vendor/` — `vendor/whisper/` (whisper.cpp checkout, build, model; ~1.2 GB, from
  `npm run setup-voice`) and `vendor/icons/` (service-logo catalog from `npm run fetch-icons`;
  deleting it falls back to scraped favicons).
- `data/` — runtime state, every file written `0o600` via `jsonFile.js`:

  | File | Holds | Secret handling |
  |---|---|---|
  | `boxes.json` | the box list | — |
  | `proxmox.json` | PVE host profiles, presets | API token, SSH mgmt keys, root password **AES-256-GCM sealed** |
  | `netbox.json` | NetBox settings | API token **sealed** |
  | `services.json` | dashboard service tiles | a tile's credential **sealed**; switching credential kind drops it |
  | `passkeys.json` | WebAuthn credentials, pinned RP id, passkey-only flag | public keys only, nothing sealed |
  | `devices.json` | Android device tokens, FCM tokens, notify toggles | SHA-256 digests only |
  | `mcp-token.json` | the MCP server's device token (`npm run mcp-enroll`) | **plaintext** — revoke in Settings → Devices |
  | `auth-state.json` | logout session-revocation watermark | — |
  | `fleet-scripts.json` | Fleet Command saved scripts | plaintext by design |
  | `fleet-jobs.json`, `setup-jobs.json`, `provision-jobs.json`, `proxmox-lifecycle-jobs.json`, `voice-jobs.json`, `apk-build-jobs.json` | job histories | — |
  | `health-events.json` | health event log | — |
  | `agent-seen.json` | per box, per session: marker ts of the newest finished turn the operator has seen | — |
  | `agent-mail-policy.json` | per box: agent-messaging send/receive switches and their box lists | — |
  | `agent-workers.json` | per box: worker projects (name, directory, trust tick), the "messages may start an agent" switch and the cap | nothing sealed |
  | `agent-mail/` | agent messaging: one `t-*.json` per thread, plus `refusals.json` | message bodies **plaintext** by design |
  | `mail/` | the per-box agent-mail listener sockets, `<12 hex>.sock` (directory `0o700`, sockets `0o600`) | — |
  | `ui-settings.json` | theme + working-agent animation + sidebar graph flag | — |
  | `voice.json` | voice enable flag + model choice | — |
  | `icons/`, `app/`, `cm/` | scraped favicons; the published APK (served by `GET /api/devices/apk`, never committed); SSH ControlMaster sockets | — |

When adding a config knob or persisted file, keep it under the repo folder. Don't depend on
`$HOME`-level state other than the user's existing SSH setup. Any file that must hold real
secrets or PII is gitignored **and ships with a placeholder counterpart** in the same change
(`.env` → `.env.example`; `config.json` → camelCase keys in `.env.example`; `tls/` → steps in
`docs/DEPLOY.md`; `data/*` → created at runtime).

## Commands

```bash
npm install
npm run build        # vite build -> dist/ (server serves this statically; build before start)
npm run set-password # writes TMUXIFIER_PASSWORD_HASH + TMUXIFIER_COOKIE_SECRET into ./.env
npm run gen-secret   # writes only TMUXIFIER_COOKIE_SECRET for OIDC mode
npm start            # node src/server/index.js
npm run dev          # vite + node --watch, proxies /api and /term to the backend
npm run typecheck    # tsc --noEmit over src/web only (vite/vitest strip types unchecked)
npm test             # typecheck + vitest run (unit + integration)
npm run test:e2e     # playwright (spins up an isolated sshd-backed box; see test/helpers/localBox.js)
npm run setup-voice  # headless Settings -> Voice: builds whisper.cpp + pinned model into vendor/
npm run fetch-icons  # pinned service-logo catalog into vendor/icons/ (server never contacts the CDN)
npm run fetch-apk    # published Android APK into data/app/ against a pinned digest
npm run mcp          # stdio MCP server (claude mcp add tmuxifier -- node /path/to/tmuxifier/src/mcp/index.js)
npm run mcp-enroll   # one-time: enroll the MCP server as a device -> data/mcp-token.json
```

**`npm run build` in the main checkout blanks the live app until a restart** (the service
serves this repo's `dist/` with asset routes registered at boot). Use `npm run typecheck` as
the safe check there; build in a worktree.

## Configuration model

`loadConfig(overrides, { env, cwd })` in `src/server/config.js` merges, low → high:

```
defaults  →  config.json  →  .env file  →  shell env  →  overrides
```

- `.env` is parsed by `envFile.js` (dependency-free) as `{ ...readEnvFile('.env'), ...process.env }`,
  so an exported shell variable beats the file.
- `loadConfig` is **pure and injectable** — never read `process.env`/`process.cwd()` in it or in
  tests; tests pass explicit `{ env, cwd }`.
- `set-password` rewrites the hash every run but generates a cookie secret only when absent, so
  a password change doesn't log everyone out.
- `TMUXIFIER_AUTH_MODE` is `password` (default) or `oidc` (`oauth`/`google` are legacy aliases) —
  mutually exclusive, and OIDC mode has no password login (a leftover hash is ignored; the way back
  is editing `.env` to `password` mode). Passkeys are an additive third login path mounted in **both** modes.
- OIDC providers are an ordered list (`TMUXIFIER_OIDC_PROVIDERS`, per-id `TMUXIFIER_OIDC_<ID>_*`,
  or `oidcProviders` in `config.json`; each may carry its own `_ALLOWED_EMAILS`, which replaces the global `TMUXIFIER_ALLOWED_EMAILS` for it); the legacy Google keys become an implicit `google`
  provider. Callbacks are `<base>/api/auth/oidc/<id>/callback` (`google`: `/api/auth/google/callback`),
  built from `TMUXIFIER_BASE_EXTERNAL_URL` (legacy alias `TMUXIFIER_PUBLIC_URL`); a scheme-less value becomes HTTPS, and `https://` marks the session
  cookie `Secure` even without local TLS.

## Load-bearing rules

Cross-cutting invariants that tests alone have repeatedly failed to protect:

- **tmux targets are exact.** Always `-t '=name'` (a bare name prefix-matches: `web` hits `web2`).
  Window targets are session-qualified, `-t '=<session>:@<id>'`: window ids name window *objects*,
  which grouped sessions share, so a bare `@7` can move the wrong session. Never fall back to a
  bare id. Window rows in the UI encode the session too (`w:<session>:<@id>`).
- **Validate, never rewrite, explicit names.** `SESSION_NAME_RE`/`WINDOW_ID_RE` reject bad
  input on every route. `sanitizeSession` silently rewrites — fine for best-effort teardown,
  wrong for anything the user asked for explicitly.
- **rc files before sessions.** A shell reads its rc files once, so anything that edits them
  (AI-auth seed, post-setup script) runs before the box's tmux session is created; setup creates
  the session **last**.
- **A running setup job gates the box.** `/term`, the pane sizing viewer, `/voice-link`, session
  create, window select and kill all refuse (`1008 'setting up'` / 409) while that box's setup
  job is `running`, and so does the worker starter (`setup-running`). `mode=provision` and the
  read-only probe stay ungated.
- **One tmux attach per viewer**, keyed `terminalKey(boxId, clientId)`; never pass `-D` and never
  write `window-size` into the operator's tmux config — sizing is tmux's own `latest`.
- **Box output is untrusted input.** Everything parsed from a probe (`__META__`, `__AGENT__`,
  `__WIN__`, window names, `/etc/os-release`) goes through an allowlisting parser with length/row
  caps; files on the box are read, never sourced. Box-side snippets run under the box's login
  shell (often zsh: no word-splitting).
- **Closed allowlists are the chokepoints.** Tool ids, named keys, voice models, icon slugs,
  Proxmox `kind`, script ids are lookup keys — nothing user-typed reaches a shell, URL path, or
  download. Re-validate immediately before interpolation, even if callers already checked.
- **Never auto-correct a possible identity change.** `known_hosts` entries are removed only on
  provable identity change or explicit consent; a Proxmox vmid that now reports a different guest
  is `mismatch` and nothing is written back. The server derives a link's `kind` from the cluster,
  never from the request body.
- **The switcher never acknowledges and never sizes.** Its preview sends no `cols`/`rows`, renders
  `textContent` only, and only `reportSeen` after the jump raises the watermark. While it is open it
  owns Ctrl+Shift+↑/↓ and the pane-focus chord is inert.
- **Seen is a client claim.** Only `POST /api/boxes/:id/agent-seen` from a visible, focused client
  raises the watermark (a `done` becomes `idle` only then); tmux `attached` suppresses a
  notification and never marks seen, and MCP reads never acknowledge.
- **Real-time paths are triggers, never data.** The box watch stream's whole vocabulary is `c`/`h`
  and `/live` sends only `{"box":"<id>"}`: state still arrives through the allowlisting probe and
  the ordinary routes, and the 30 s sweep and client polls remain the backstop. Only the sweep
  decides reachability — a failed light probe changes nothing. The sweep, `probeOne` and
  `refreshAgents` all read a box's agent state and can finish in any order, so one rule orders
  them (`seq`/`applied`/`readBox`/`settle` in `statusPoller.js`): a read is applied only if it
  started after the previously applied one. Breaking that shows up as a duplicate "needs you" push.
- **Never auto-promote best-effort phases.** Setup's seed/statusline/hooks/voice-link/script
  phases record their result and never fail the job; a failed setup never removes the box.
- **Every web fetch goes through `http.ts`** (the 401 → login seam); `test/webHttp.test.js`
  forbids hand-rolled `res.ok` checks elsewhere.
- **Agent mail is never typed into a terminal.** A message reaches an agent session only
  through that session's own waiter: Claude Code's `asyncRewake` hook (`tmx hook-wait`) or
  OpenCode's state plugin (a held wait handed to `ctx.session.synthetic` with `delivery:
  'queue'`, never `steer`), and only while the session's marker reads `ready`; working or
  blocked keeps it `queued`. Hand-off is `handed`, not `delivered`: only the prompt hook's ack
  (`tmx hook-ack`), the plugin's ack on OpenCode's `inbox.delivered` for the item it posted, or
  the agent reading it through `tmx wait`/`read`/`inbox`, delivers it, and an unconfirmed
  hand-off is offered again. The plugin never re-arms a pane's wait until its posted item has
  settled: a new wait of a pane re-queues what was handed, so the ack would 404 and the message
  go out twice. The socket a request arrives on is the box; the session it names is a claim
  checked against the box's markers. Policy changes only through the browser-session routes.
- **One ssh connection, one mail forward.** Mail boxes are grouped by resolved ControlPath; only
  the first enabled box of a group in the box list may forward. A refused box runs no ssh command
  for mail beyond one cancel, by its own spec, of a forward it made before it was refused (never
  the remote `rm`, which would break the holder); an unresolved one runs nothing, and while one
  is unresolved no forward starts. Read `agentMailForward.js`'s header before touching `sync`.
- **tmx under OpenCode never falls back to `$TMUX_PANE`:** without `TMUXIFIER_MAIL_PANE` it refuses.
- **A re-addressed box is another machine for mail.** When a box's host, user, port or jump host
  changes, the first thing the next mail sync does for it, resolved or not, is close its listener
  (every connection made through the old machine dies, every held request ends), and its local
  socket path is named from the box id **and** those fields, so a forward entry an old master
  still holds names a path nothing binds. Never keep a listener across a change of connection
  fields, and never name a box's socket from its id alone.
- **A worker is started by a script that holds nothing a lead sent.** A lead names a box and at
  most a project; the project is a lookup key into the box's record (`PROJECT_NAME_RE`), never a
  path. The directory is the operator's, validated on write and re-validated (`isWorkerDir`)
  immediately before it is single-quoted into the script. The launch word is a constant looked up
  in `WORKER_AGENTS`, and the message is never in the script or typed into a terminal. No worker
  starts while the box's setup job runs. No persisted registry of workers is kept: the box's own
  tmux listing is the list (`worker-<project>-<n>`, counted by name **and** a pane running
  `claude`); the starter's 60 s memory of its own starts is the only addition (read its header).

## Architecture (`src/server/`)

Modules are factory functions (`createStore`, `createSessionManager`, …) with dependencies
injected as arguments — that is what makes them testable without mocks. Follow the pattern.

### Core & persistence

- `index.js` — entrypoint: loads config, fails fast on missing mode-specific auth config, wires
  everything, serves `dist/`, listens.
- `config.js` / `envFile.js` / `configFile.js` — config merge, `.env` parse/upsert (`0o600`),
  `config.json` parsing.
- `jsonFile.js` — atomic JSON persistence (temp + rename), quarantines an unparseable file to
  `<file>.corrupt-<ts>` instead of reading it as empty, writes `0o600`.
- `debouncedJsonStore.js` — the debounced store behind the six job stores (`fleetStore`,
  `setupStore`, `provisionStore`, `proxmoxLifecycleStore`, `voiceInstallStore`, `apkBuildStore`,
  each a one-line wrapper). `whenIdle()` is the shutdown flush seam; every store must be wired
  into `shutdown.js`'s `registerShutdownFlush` (SIGTERM/SIGINT), or a just-finished job reloads as
  `interrupted`.
- `agentSeenStore.js` — `data/agent-seen.json`: per box, per session, the marker timestamp of the
  newest finished turn a client has seen. Debounced, `0o600`, flushed on shutdown. The "`ts` ahead of the
  marker is refused" rule lives in `healthHistory.markSeen`.
- `concurrency.js` — `mapWithConcurrency`, bounded parallelism for status sweeps and Fleet.
- `singleFlight.js` — `createSingleFlight`: concurrent calls for one key share one promise, nothing cached.
  The browser preview's captures run through it per box, session and line count (a browser abort
  doesn't stop the ssh run): `boxActions.paneSnapshot` only with `shared: true`, which the pane route's
  `session` branch passes, and `localShellActions.paneSnapshot` always. A device read (app, MCP) runs
  its own capture, so it can never return a screen from before keys the caller just sent.
- `jobOrder.js` — `newestFirst` job comparator. `pveTask.js` — `pollPveTask`, the shared PVE task
  poller.
- `secretBox.js` — AES-256-GCM seal/open, key HKDF-derived from `cookieSecret`.
- `tlsPin.js` — `tlsProbe`/`pinnedSocket`/`normFp`: pin mode verifies the fingerprint on each
  request's own connection instead of chain verification (used by Proxmox, NetBox, UniFi).

### Auth

- `auth.js` — scrypt hashing, signed-cookie options, session values embedding issue time
  (rejected after `SESSION_TTL_SECONDS`).
- `rateLimit.js` — per-IP login lockout, bounded map (overflow evicts oldest). Shared by
  password, passkey, and device enrollment.
- `oidcAuth.js` — dependency-free multi-provider OIDC: discovery (cached), code flow, PKCE, per-provider exact-email allowlist.
- `webauthn.js` — dependency-free WebAuthn: minimal CBOR reader (fed only registration
  attestation or previously validated stored keys), COSE→`KeyObject` (ES256/RS256/EdDSA),
  `verifyRegistration`/`verifyAssertion`. Attestation `none` only.
- `passkeyChallenges.js` — bounded single-use 120s challenges in a signed `SameSite=strict`
  `tmuxifier_pk` cookie; per-owner quota (3) so one flooding source evicts only its own entries.
- `passkeyStore.js` — `data/passkeys.json` CRUD, `passkeyOnly`, pinned RP id (pinned by first
  enrollment, cleared with the last credential, which also disarms `passkeyOnly`). A corrupt store
  fails **open** by design.
- `deviceHostGuard.js` — refuses a device-token `POST /api/boxes` whose host or jump hop resolves
  to this machine or can't be resolved. A speed bump, not a boundary (see its header).
- `deviceStore.js` — Android/MCP device tokens: SHA-256 digests of 32-byte tokens, `timingSafeEqual`,
  `touch` throttled to once a minute, corrupt fails open.
- `pairingCodes.js` — single-use 120s pairing codes (≤4 outstanding), minted only by a browser
  session; human-typed alphabet without 0/1/I/O.
- `fcmPush.js` — subscribes to `healthHistory.onEvent`; agent-input/agent-done → FCM HTTP v1
  pushes (RS256 JWT via `node:crypto`). `TMUXIFIER_FCM_CREDENTIALS` unset = off. UNREGISTERED
  clears that device's FCM token, never its auth. `fcmAppConfig.js` extracts the Firebase
  *client* config from `TMUXIFIER_FCM_APP_CONFIG`.

### `server.js` — Fastify app

Login rate limiting, REST under `/api/*`, the `/term`, `/voice-link` and `/live` WebSockets. Notable routes
(gates per the load-bearing rules above):

- **Auth.** `requireAuth` is async: signed session cookie first, then `Authorization: Bearer
  <device token>` (sets `req.deviceId` and enforces the default-deny `DEVICE_ALLOWED_ROUTES`
  allowlist — Android + MCP routes only, with `PATCH /api/boxes/:id` restricted to `sessionName`
  and `POST /api/proxmox/lifecycle-jobs` to power actions; `seedAiAuth` is refused on setup and
  provisioning, and `POST /api/boxes` goes through `deviceHostGuard`). Passkey routes mount in both
  auth modes.
  `POST /api/devices/enroll` bypasses `requireAuth` — it authenticates with the password (403
  under armed passkey-only, 501 in OIDC mode) or a pairing code, over the login rate-limit bucket.
  `POST /api/devices/pair` is browser-session only (a device must not mint invites).
- **Setup.** `POST /api/boxes/:id/setup`, `GET /api/setup[/:id]`, `GET /api/boxes/:id/setup`;
  `/term?mode=provision` is the interactive fallback for sudo/password boxes, reporting via
  `setupManager.markInteractiveResult`. `GET /api/ai-auth/status` feeds the readiness rows.
- **tmux.** `POST /api/boxes/:id/sessions` creates a detached session (via
  `buildEnsureSessionRemote` with the box's `startupCommand`). `POST /api/boxes/:id/window`
  `{ session, windowId }` runs `select-window` — no reattach needed, every attached client follows.
  `POST /api/boxes/:id/kill` `{ session, windowId? }` kills a session or one window; killing the
  pane's own session is allowed (it reconnects to a fresh one). Session switching is just
  `PATCH /api/boxes/:id`, which closes the box's terminal PTY group. Window/kill await a
  best-effort `statusPoller.probeOne` so the next `/api/status` is fresh.
  `POST /api/boxes/:id/probe` re-probes one box and returns its entry in `/api/status` shape
  (ungated — read-only; 502 on failure). Nothing about windows is persisted.
- **App/MCP reads.** `GET /api/boxes/:id/pane` — `capture-pane` snapshot merged with agent state;
  on an alt-screen pane only the visible screen ships. Optional `cols`/`rows` keep an invisible
  sizing client attached (`sessions.ensureSizedViewer`, rolling ~30s TTL, only after a successful
  capture). `POST /api/boxes/:id/keys` — exactly one of literal text (`sanitizeSendText`), a
  `NAMED_KEYS` key, or `wheel` (SGR wheel reports; `exit 93` → 409 unless the pane has SGR mouse
  tracking on). `POST /api/boxes/:id/pane-kind` is the mic button's link-vs-dictate verdict.
  An optional `session` (validated with `SESSION_NAME_RE`, 400 otherwise; 403 for a device token)
  captures that session instead, ignores `cols`/`rows` and takes agent state from it.
  `GET /api/local-shell/pane` is the Host Shell's counterpart: browser session only, captures the
  `local` session, never creates it, 502 on a failed capture.
- **Devices.** `GET /api/devices/apk[/info]` (absent = `available: false`),
  `GET /api/devices/fcm-config`, `POST/GET /api/devices/apk/build` (`apkBuild.js`: single-flight
  Gradle build, browser-session only; overwrites `data/app/`, so on a server serving the
  Play-signed build it swaps the signature).
- **Proxmox.** `PUT /api/boxes/:id/proxmox` writes `kind` from what the cluster reports.
  `GET /api/boxes/:id/proxmox/net` reads a linked container's live `net0`.
- **Term close.** A `/term` close with code `4000` (`TERM_RELEASE_CODE`, `sessions.js`) drops the viewer's
  PTY at once via `closeIfUnwatched`; every other close keeps the grace window.
- **Live.** `/live` (WebSocket, browser session + trusted Origin only, one-way) registers the tab
  with `liveHub.js`; logout closes every stream. `GET /api/status?box=` and
  `GET /api/health/series?box=` return one box in `{ [id]: … }` shape, which is what a nudged tab
  fetches. `POST /api/boxes/:id/agent-seen` publishes its box so other tabs drop `done` at once.
- **Agent mail.** `GET /api/mail/threads`, `GET /api/mail/threads/:id`,
  `POST /api/mail/threads/:id/close` (the operator's Stop), `GET /api/mail/refusals`,
  `GET`/`PUT /api/boxes/:id/mail` (policy + pair results + forward status; the PUT carries
  `mirror: { sendTo?, receiveFrom? }` and kicks a forward sync, as does a `PATCH /api/boxes/:id`
  that changed `host`, `user`, `port` or `proxyJump`). The thread list's `status` is
  `hub.threadStatus(t, 'operator')`. Browser session only: absent from
  `DEVICE_ALLOWED_ROUTES` **and** 403 for a device id inside the handler; 404 when messaging is off.
  `GET /api/ui-config` carries `agentMail`. The boxes never reach these: their interface is the
  per-box listener (`agentMailListener.js`), never mounted on the web listener. Test:
  `test/agentMailRoutes.test.js`.
- **Agent workers.** `GET`/`PUT /api/boxes/:id/workers` (the record; `PUT` takes only
  `projects`, `mailStart`, `max`, a rule failure is 400 with the rule's message; `GET` also
  answers `mail`, whether messaging is on) and `POST /api/boxes/:id/workers/start` `{ project? }`
  (the starter, `mailStart` not applied; 409 setup-running/worker-cap, 400 no-project, else 502,
  each `{ error, code }`; a success awaits a best-effort `probeOne`). Browser session only, as
  the mail routes; they work with messaging off, 503 only when the worker store or starter
  could not be built. Test: `test/agentWorkerRoutes.test.js`.
- **Responses.** `/api/` sets `Cache-Control: no-store` unless a route already set its own (the
  icon routes do). Permissions-policy `microphone` is always `self`.

### Boxes, SSH, tmux, terminals

- `store.js` — `data/boxes.json` CRUD, normalization, versioned export/import (import re-mints ids,
  drops unsafe entries). `uniquenessConflict(candidate, ignoreId?)` is the advisory pre-check;
  `addBox` stays the authority. A Proxmox link with no `kind` reads as `'lxc'` in `readAll()`.
  `readdressBox` writes host + NetBox id together.
- `sshCommand.js` — ssh argv builders; **every box field passes `assertBoxSafe` and is never
  shell-interpolated unquoted** (the command-injection surface). ControlMaster args,
  `SESSION_NAME_RE`, `sanitizeSession`. `buildControlForwardArgv`/`buildControlCancelArgv` (agent
  mail's `-O forward|cancel -R <box path>:<local path>`) re-check both paths, the box one built
  from a box-reported `$HOME`, right before they become one argv element.
- `sshRun.js` — one-shot ssh, `sshStream` (streaming; `timeout: 0` = resident, no kill timer),
  `sshRunStdin`, `sshPipe`.
- `boxActions.js` — per-box ops over the ControlMaster: tmux/framework/tool install
  (`TOOL_IDS`/`resolveTools`, mirrored by `provisionTools.ts` and the MCP `SETUP_TOOLS` enum,
  pinned by tests), `execCommand` for Fleet, master liveness/stale-socket reaping, and the
  exact-target remotes (`buildEnsureSessionRemote`, `buildSelectWindowRemote`,
  `buildKillSessionRemote`/`buildKillWindowRemote`). `buildKillTmuxRemote` is the separate
  best-effort teardown for box removal (sanitizes, `|| true`) — don't widen it.
  Every catalog tool is install-if-missing: a copy already on the box is never upgraded, even a
  Node older than the pin (only the `upgrade` tool upgrades). The `node` tool installs NodeSource
  `NODE_MAJOR` (26) on apt/dnf/yum, removing distro `npm`/`libnode-dev` first, then moves npm to
  its newest release (`--engine-strict`, best-effort). The `opencode` tool runs the native v2
  installer with `--no-modify-path` (binary in `~/.opencode/bin`); the PATH line is ours, one
  tagged line per rc file via `binPathBlock` (`# tmuxifier-opencode-bin`, beside claude/agy's
  `# tmuxifier-local-bin`).
  `buildFrameworkUpdateClamps` disables shell-framework self-updaters on **every** setup, each
  guarded by evidence the framework is present (the oh-my-zsh guard's `^` anchor is load-bearing:
  stock `.zshrc` contains the commented template line).
- `sessions.js` — PTY lifecycle. PTYs are keyed per viewer; callers act on **groups**
  (`entry.group` = box id, `closeGroup(group, kind?)`). `safeClientId` falls back to `shared`.
  `maxViewersPerBox` (8) with grace-window slot reclamation. Refcounted listeners + `graceSeconds`
  keep a dropped PTY for reconnects. Reattach replays the last 64KB prefixed with the tracked
  DEC private modes (mouse, DECCKM, alt screen, bracketed paste — in last-set order) and
  `REPLAY_CLEAR` (SGR reset + clear) — don't rely on the size nudge to clean the screen or
  re-announce modes: over ssh it usually collapses to no resize at all.
- `localShellActions.js` — the optional Host Shell (`localShell` = `none`/`omz`/`omb`).
  `installAgentHooks()`/`installVoiceLink()` reuse the box pushers over a local `/bin/sh`
  transport, triggered only by `claudeHooks === true` on `PATCH /api/local-shell`;
  `installOpencodePlugin()` likewise, only on `opencodePlugin === true`. `installOscReporter()`
  (the OSC reporter, below) rides the same `claudeHooks === true` knob.
- `localTmuxScope.js` — creates the `=local` session under `systemd-run --scope` so service
  restarts (`KillMode=control-group`) don't kill the Host Shell's tmux; falls back without
  `systemd-run`.
- `localAgent.js` — Host Shell stand-in for the status probe, shaped like a box probe and parsed
  by `status.js`'s own allowlisting parsers. `LOCAL_BOX_ID` is declared here to keep node-pty
  out of the poller's import chain. `NO_SERVER_RE` reads only "no server running" or a socket
  that does not exist as an empty listing; any other tmux error (refused, permission denied) is
  "listing unknown", never "every session ended".
- `uploads.js` — paste/drag-drop uploads: filename allowlist, remote
  `~/.tmuxifier-uploads/` writer (24h self-prune). Route `POST /api/upload`
  (`TMUXIFIER_UPLOAD_MAX_MB`); it and `POST /api/voice` take `?session=` (the pane's own session —
  duplicate panes attach their own), validated, defaulting to the configured one.
- `tmuxInject.js` — pane-aware path injection: `#{pane_current_command}` first (idle shell or
  `claude*`), screen heuristics as fallback; types via `send-keys -l`, never auto-Enter; busy
  panes get a `display-message`. Exports `NAMED_KEYS`, `sanitizeSendText`, `classifyPaneState`.
- `knownHosts.js` — best-effort `ssh-keygen -R`; called only on verified deprovision, a fresh
  provisioned IP, readdress (new address + released old IP literal), or explicit
  `POST /api/boxes/:id/forget-hostkey`.
- `boxRemoval.js` — shared cleanup for removal and verified deprovision. `onRemoved(box)` (best-effort,
  awaited) drops the box's worker settings (messaging on or off), its agent-mail policy and closes
  its threads.

### Setup jobs and the agent stacks

- `setupManager.js` / `setupStore.js` — persisted, pollable, resumable on-box setup over the
  ControlMaster (`BatchMode`). Statuses `running`/`done`/`error`/`needs-interactive`/`interrupted`/
  `superseded`; `running` reconciles to `interrupted` on restart. `needs-interactive` records
  `job.needs`: `'sudo'` (password prompt) or `'ssh'` (`Permission denied (publickey,password)` —
  a key-only denial stays `error`). Phase order after the install script: `seeding` → `statusline`
  → `agent-hooks` → `agent-mail` → `voice-link` → `opencode-plugin` → `osc-reporter` → `script` → `ensureSession` (last). The
  Claude phases are all gated by the one `claude` tools selection (a stale bundle's
  `claudeStatusline` flag still counts); `agent-mail` (job field `agentMail`) runs for the
  `claude` **or** the `opencode` selection and is left unwired when messaging is off;
  `opencode-plugin` is gated by the `opencode` one (job field `opencodePlugin`). `streamRemote` is
  shared by the install run and the script phase; only the install run sniffs stderr for prompts.
  Password-only boxes work only while a ControlMaster is alive.
- `aiAuthSeed.js` — opt-in copy of the host's Claude (`TMUXIFIER_CLAUDE_OAUTH_TOKEN`) / Codex
  (`~/.codex/auth.json`, never stored) credentials. Secrets travel stdin-only — never in script
  text, argv, logs, or responses. On the box the Claude token lives only in
  `~/.tmuxifier-auth/claude-token` (0600); rc files get a secret-free tagged line that exports it
  from there. `status()` serves `GET /api/ai-auth/status`.
- `claudeStatusline.js` / `claudeAgentHooks.js` — push `src/server/assets/claude-statusline.sh`
  and `tmuxifier-agent-hook.sh`. Script text interpolates **nothing** (files arrive on stdin);
  the box decides via `command -v claude`; `settings.json` is merged in place (jq → node →
  python3), hooks remove-then-append so reruns are idempotent and the operator's hooks survive.
  The hook writes one `<session>:<state>:<epoch>:<cause>:<%pane>` marker per pane (file
  `<session><%pane>`; split panes share a session, and without `$TMUX_PANE` it falls back to a
  four-field session-wide file) under `~/.tmuxifier-agent/`, the
  **sole** source of agent state. States `working|blocked|ready`; causes `prompt|resume|stop|start|
  permission|question|elicitation|unblock`. Old three-field markers still parse (`waiting` reads as
  a finished turn); until setup is rerun and claude restarted, the old hook rewrites `waiting` with a
  fresh ts on every notification (incl. the ~60s idle timer), so an acknowledged `done` re-arms within
  a minute, and session start reads `done`, not `idle`. `PermissionRequest` is the primary `permission` writer (fires the moment Claude asks);
  `Notification` `permission_prompt` is a backstop that never downgrades an existing block; `ask`
  (PreToolUse AskUserQuestion) and the elicitation / `agent_needs_input` notifications also write
  `blocked`; a sibling
  `blocked/<session><%pane>` records which agent (main or a subagent id) raised the block, so only that
  agent's next tool call clears it, and `unblock` (PostToolUse and PostToolUseFailure) exits before reading stdin
  unless the marker is `blocked` (two forks, `sh` and `tmux`, per tool call); on a blocked marker it
  writes `working/unblock` only when the payload's `agent_id` matches the recorded owner. `idle_prompt`/`agent_completed` write `ready/stop` only over a `working`
  marker — timers never clear `blocked` — so a plain "No" to a permission prompt (which fires no hook)
  stays `blocked` until the operator's next prompt or Claude's next tool call, and a granted
  permission stays `blocked` until that tool's PostToolUse. Its background-work gate
  (`busy/<session><%pane>/` tokens: `sub.` bracketed by SubagentStart/Stop with a 120min TTL, `bg.` from
  PreToolUse `Bash` with a ~2min TTL) keeps `Stop`, `idle_prompt` and `agent_completed` from
  reading as a finished turn while background work runs; a `<task-notification>` resume clears only
  `bg.` tokens, the operator's own prompt clears all. A mail wake (a `<task-notification>` that
  also carries `[tmuxifier-mail `) clears no tokens and exits without writing over a `blocked`
  marker; else `working/resume`. Pinned by `test/fixtures/claude-mail-wake-trace.jsonl` (a real
  Claude Code 2.1.325 recording, see its README) + `test/agentMailWakeReplay.test.js`. Fails open. Unit tests have twice been green
  while this was broken live — test against a real event trace;
  `test/fixtures/claude-hook-trace.jsonl` + `test/agentHooksReplay.test.js` is the acceptance test.
- `claudeVoiceLink.js` / `voiceWriter.js` / `voiceLinks.js` — Claude Code `/voice` on a box.
  Setup makes ALSA `default` capture a FIFO via a marker-guarded `~/.asoundrc` (a foreign one is
  never touched); `~/.tmuxifier-voice/mic` is a symlink to `mic.fifo` while fed, `mic.absent`
  after clean shutdown. A resident silence **feeder** always holds the FIFO — a writerless FIFO
  hangs `snd_pcm_open`, and a never-blocking source (`/dev/zero`) once OOMed the host. Two
  recipes (`direct` 48 kHz float / `s16le-rate`), chosen on the box by whether the pipe can be
  grown (pipe pages are per host uid in unprivileged LXCs). The writer is single-instance via
  `flock` with an explicit handover. Requires python3 (`skipped-no-python3`). `voiceLinks.js`
  holds one writer per box (`4001` newest wins, `4002` not set up, `4003` failed, `4004` idle),
  never queues audio. Read the file headers before touching any of this; test by replaying audio
  into a real `claude --debug`.
- `opencodeAgentPlugin.js` + `src/server/assets/tmuxifier-opencode-agent.js` — the OpenCode
  counterpart of the agent hook, and OpenCode's half of agent messaging. The pusher writes the
  asset (stdin, tmp + `mv`) to
  `${OPENCODE_CONFIG_DIR:-~/.config/opencode}/plugins/tmuxifier-agent.js` when the box has
  `opencode` (on PATH or `~/.opencode/bin`), else `skipped`; no settings merge (OpenCode
  auto-loads the directory) and no restart (its server hot-loads it). It also reads
  `opencode --version`, and the ok result carries a `note` below `OPENCODE_MAIL_MIN` (2.3.0; the
  asset exports the same constant, pinned equal by test) and for a version it could not read (the
  plugin checks `ctx.app.version` itself at runtime, so that one may still listen). The asset is a V2 plugin
  (`default { id, setup }`, node builtins only) that runs inside OpenCode's **one shared
  `opencode serve` per user**, which outlives every TUI and gives no per-TUI handle — so its state
  part is an events reducer attributed by directory to the tmux sessions whose active pane
  of the active window runs `opencode` there (two TUIs in one directory fold to one state), writes
  the same `<session>:<state>:<epoch>:<cause>` markers, and sweeps every 15 s (deletes a marker
  only if it still holds what this core wrote). It lists panes with `tmux -u` (as the OSC reporter
  reads every format): a client outside tmux with a non-UTF-8 locale prints a format's tabs as `_`,
  and the server inherits whatever locale started it. A process-wide singleton (`Symbol.for`) hands
  over to the newest `setup` (what it wrote, and its reducer state under `STATE_VERSION` — OpenCode
  re-runs `setup` in the same process for every new project directory), so a setup rerun upgrades
  it live. A reject/dismiss ends the turn in
  OpenCode (nothing stays `blocked`); ctrl+b background shells keep `working`. Acceptance test:
  `test/fixtures/opencode-event-trace.jsonl` (a real 2.2.6 recording) replayed by
  `test/opencodeAgentReplay.test.js`. Design: `docs/superpowers/specs/2026-11-07-opencode-agent-state-design.md`.
  **Mail part** (OpenCode ≥ `OPENCODE_MAIL_MIN` with `ctx.session.synthetic`; else inert, the
  state part unaffected). Mail **targets** are per tmux session: the active pane of its active
  window running `opencode`, mapped to the root OpenCode session with the newest operator
  evidence (`session.viewed` or a `user` inbox item) since that tmux session began hosting
  `opencode`; none on a tie, when another tmux session's `opencode` reaches the same session's
  directory tier, or when the pane listing was incomplete (fail closed). One held
  `GET /v1/wait` per target on `~/.tmuxifier-mail/sock` (one socket-wide backoff, 30 s → 30 min),
  armed only while the target reads `ready`; a wake is `synthetic({ delivery: 'queue', resume:
  true, metadata: { tmuxifierMail } })`, acked on `inbox.delivered`. The in-flight map
  (inbox id → message id, tmux session) lives in `~/.tmuxifier-mail/opencode-inflight.json`
  (0600): a restarted server delivers with no `inbox.enqueued` replay and no metadata, so a new
  core adopts delivery from that file. The reducer reads a synthetic carrying our metadata as
  `working/resume` that never overwrites `blocked`. A **pane tagger**
  (`tool.execute.before` + `shell.create.before`, matched by command text) sets
  `TMUXIFIER_MAIL_PANE` on each shell command to the calling session's target pane (a subagent
  speaks for its root), else `none`, because the shared server's `TMUX_PANE` is the first TUI's.
  A **permission handler** (`permission.evaluate`) sets `allow` only for one plain `tmx` command
  (`isPlainTmx`, an argument allowlist) and never denies; it does nothing when
  `createOperatorRules` finds any shell/bash permission rule (`/etc/opencode`, global and
  project configs up the tree, agent markdown, env), unreadable files counting as rules. OpenCode runs those hooks only
  in the instance owning the session's directory, so the entry point keeps every live `ctx`,
  registers the hooks on each, and arms mail only for hooked directories; taggers and handlers
  are process-wide and survive hand-over. Mail in projects already open when the plugin is
  installed or updated may need an OpenCode restart. Acceptance:
  `test/fixtures/opencode-2.3-event-trace.jsonl` (a real 2.3.0 recording; its README holds the
  measured facts F1–F10), read by `test/opencodeAgentReducer.test.js`,
  `test/opencodeAgentReplay23.test.js`, `test/opencodeAgentMailTargets.test.js`,
  `test/opencodeAgentPaneTag.test.js`, `test/opencodeAgentPermission.test.js` and
  `test/opencodeAgentRegistry.test.js`. Design:
  `docs/superpowers/specs/2026-11-16-opencode-agent-messaging-design.md`.
- `oscReporter.js` + `src/server/assets/tmuxifier-osc-reporter.py` — the OSC 7501 ("Program
  Status") reporter for agents that emit it: Codex (native from 0.163; the 0.167 binary carries the sequences, but no live capture exists yet — the
  test box needs a Codex sign-in; append its stream to the fixture when captured), pi (only with the
  `export PI_PROGRAM_STATUS=1 # tmuxifier-osc-pi` rc line the pusher adds), agy (only with the
  `export AGY_CLI_OSC7501=on # tmuxifier-osc-agy` rc line the pusher adds; recorded live, agy 1.5.3,
  fixture lines 1491-2321; it never sends `clear`, so its marker goes at the loop's detach, and
  `kind=auth`, the sign-in menu, is cause `elicitation`; its start-up prompts, folder trust and
  sign-in, are emitted ~0.15 s after launch, before the 2 s attach, so the pusher also adds the
  `AGY_ATTACH_RC_LINE` `agy` shell function (`# tmuxifier-osc-agy-attach`) that runs
  `attach %N` before the real agy. It is defined only in interactive shells (`case $- in *i*`:
  boxActions' `command -v agy` tool check runs under the login shell, and a Debian bash reads
  `~/.bashrc` even for `bash -c`, so a function there would make setup skip the install) and only
  when no `agy` alias or function exists (the operator's own wins); `alias agy='command agy'`,
  above or below the line, is the opt-out. A launch that bypasses the function — `command agy`,
  a script, a startup command run via the default shell's `-c`, a non-default tmux server —
  still races the 2 s attach and usually reads `ready/start`; a start-up prompt the function
  catches reads `blocked` but raises no `agent-blocked`, the session having no previous agent
  state), and OpenCode only
  when its plugin file is absent (the plugin wins; without it the root record aggregates every
  session of the shared `opencode serve`). **Claude Code is excluded**: it probes with
  `OSC 7501;?` then DA1, tmux answers DA1 itself, so it never reports inside tmux and its hook
  stays the source. `buildOscReporterInstallScript()`/`createOscReporterPusher()` write
  `~/.tmuxifier-osc/reporter.py` (stdin, nothing interpolated), skip `no python3`/`no tmux`, and
  run one sweep; always on (setup phase `osc-reporter`, job field `oscReporter`). The asset is
  stdlib python with roles `listen %N` (a `tmux pipe-pane` reader: tmux feeds pipe-pane the raw
  bytes before its own parser, so the sequence arrives intact; folds records, writes the same
  `<session>:<state>:<epoch>:<cause>` markers), `loop` (one resident per box under a
  `loop.lock` flock, 2 s passes, attaches by `pane_current_command`, detaches after 3
  non-matching passes, registry in `~/.tmuxifier-osc/panes/`, version handover on setup rerun),
  `attach %N` (the function's one-shot: default server only, and only a pane whose `pane_pipe`
  is 0, because `pipe-pane -o` on a piped pane closes the pipe; starts a loop when none holds
  `loop.lock`, so the listener is always detached again; prints nothing, exits 0) and
  `sweep [--once]` (one pass + ensure a current-version loop; what the probe runs). Never
  writes to the pane. The handover protocol is the comment block above `run_listen` — read it
  before touching the entry: only the loop writes `handover`, only the listener writes `pid`,
  `attachedAt` is the listener's generation token, every entry read-modify-write holds
  `entries.lock`, and nothing touches the entry after the successor's `pipe-pane -o`. The loop
  closes a pipe only on a LIVE pid (a dead listener's pipe closes itself on the pane's next
  byte; there is no heal path — it could take over an operator's pipe), exits 0 on SIGTERM, and
  its `run-shell` command self-silences: any output, non-zero exit or signal death would pop a
  view-mode overlay into the operator's pane. A Codex whose Node predates `process.execve` runs
  as `node` and is not detected. Tests: `test/fixtures/osc7501-pane-trace.jsonl` replayed by
  `test/osc7501Replay.test.js` (acceptance), and `test/osc7501Tmux.integration.test.js` against a
  real, private tmux server (the only place a handover's cross-process ordering is observable;
  the stub-tmux suites never spawn a listener; five more tests pin pre-attach catching a report
  sent at agent start, the role-started loop detaching the listener of an agent that never
  starts, an operator's pipe left alone, a foreign-server pane refused, and the installed `agy`
  function end to end). Design:
  `docs/superpowers/specs/2026-11-08-osc7501-pane-reporter-design.md`.

### Status and health

- `status.js` — per-box probes with in-flight coalescing. `OSC_SWEEP` (in `PROBE_REMOTE`) runs
  the OSC reporter's `sweep` each poll when `~/.tmuxifier-osc/reporter.py` exists, fully redirected. Reports sessions, active-pane command,
  `#{window_activity}` (the output clock — **not** `#{session_activity}`, a key-input clock), box
  clock, metrics, distro (`/etc/os-release` read with shell built-ins under the probe's bare PATH),
  agent markers (`parseAgentMarks`), windows (`list-windows -a`, ≤200 rows, name field last) and
  panes (`__PANE__`, ≤400 rows). `parseAgentMarks` folds a session's pane markers (blocked >
  working > finished > just started, newest first within a rank) and drops a pane marker whose
  pane is gone, moved to another session, or back at a shell; an absent or row-capped pane
  listing fails open. A session-wide marker older than the newest live pane marker is ignored.
  `cleanWindowName` strips C0/C1 and bidi controls; `__NO_TMUX__` matches as a whole line.
  Session rows must have the `STATUS_FMT` shape (≤200; a name with controls or over 256 chars
  drops, never rewritten); a failed probe's ssh error keeps its last 1024 chars, controls stripped.
  `checkAgents` runs `AGENT_REMOTE` — the probe minus the metrics block and the OSC sweep — and
  returns sessions, windows and markers or `null`; it never touches the backoff. The marker
  directory is listed (`command ls -1 | while read`), never globbed: under a zsh login shell an
  unmatched glob aborts the whole probe line (pinned under sh, bash and zsh in `test/status.test.js`).
- `statusPoller.js` — the single server-side poll loop (`statusPollMs`) behind `/api/status`, so
  SSH volume is independent of open tabs; `probeOne` for on-demand refresh. Folds the Host Shell
  into history as `__local__` without putting it in the snapshot. `refreshAgents(boxId)` is the
  real-time path: one light probe patched into the snapshot and recorded with
  `history.recordAgents` (the Host Shell re-samples locally). `onCycle(boxes, snapshot)` runs
  after every sweep; `onAgents(boxId)` after every applied `refreshAgents` result (agent mail's
  delivery re-check; never for the Host Shell). `listingSeq(boxId)` counts a box's status reads
  applied under the ordering rule: the worker starter's only evidence that a listing was read
  after one of its starts.
- `agentWatch.js` — real-time agent state, box → server. `createAgentWatch` keeps one resident ssh
  stream per reachable box over the ControlMaster, running `WATCH_REMOTE`: a POSIX `sh` loop
  (inline remote command, nothing installed, no setup rerun) that reads the same marker files
  with the same 200-byte cap as the probe, prints `c` when their content changes and `h` every
  20 s. The beat is what ends an orphan (no PTY, so no hangup — the loop dies on a failed write)
  and what proves the stream is not hung; `[ -f ]` keeps a FIFO from blocking it forever. A `c`
  calls `refreshAgents`, one at a time and at most once a second per box, with a rerun for a
  change that lands mid-probe. Streams start and stop only in `sync()`, called from `onCycle`;
  one that dies young backs off (30 s doubling to 30 min). The stream costs one of sshd's
  `MaxSessions` slots per box; when ssh reports `Session open refused by peer` (on the stream's
  stderr, or from the light probe via `yield`) the stream is dropped and held 5 min rather than
  left on the private connection ssh silently falls back to. `createLocalMarkWatch` is the Host
  Shell's `fs.watch` on `~/.tmuxifier-agent`, serialised, holding a directory fd so a
  removed-and-recreated directory is noticed. `TMUXIFIER_AGENT_WATCH=off` removes both.
- `liveHub.js` — real-time, server → browser: the `/live` clients (≤32), pinged every 25 s,
  closed for renewal after 15 min so a stream is re-authenticated. `publish(boxId)` sends
  `{"box":id}`. A WebSocket, not SSE: an EventSource would hold one of the six HTTP/1.1
  connections per origin for every open tab. `index.js` publishes on `history.onEvent` and
  `history.onChange`, deduped per event-loop turn.
- `healthHistory.js` / `healthEventsStore.js` — rolling samples per box and edge-triggered events
  (down/up/needs-auth/threshold/agent-blocked/agent-input/agent-done) in `data/health-events.json`.
  `recordAgents(box, status)` is the between-sweeps update: it rewrites the box's latest sample
  in place (no new point, metrics and time kept) and runs only `agentEdges`, never the metric
  thresholds (cpu needs two consecutive *sweep* samples). Its edge baseline is bridged across a
  marker gap: an exiting agent removes its marker while still in the foreground, which is what
  triggers the probe, so a session that had a state keeps it in the baseline (not in the sample)
  or the exit would never raise `agent-done`. `onChange(cb)` fires when a box's agent
  map changes, event or not. `markSeen` turns the latest sample `idle` immediately.
  Samples carry per-session `agents` (every listed tmux session; `agentKindOf(paneCmd)` →
  `claude`|`opencode`|`codex`|`pi`|`agy`|`null` sets `present` and the entry's and events' `agent`, which event and
  push copy name; non-agent panes are `present: false`; the Host Shell is the `__local__` box/series id); displayed states are `working`, `blocked`, `done` (finished, not yet seen), `idle`.
  The seen watermark (`POST /api/boxes/:id/agent-seen` → `history.markSeen`, persisted through
  `agentSeenStore.js`) turns `done` into `idle`. `agent-blocked` = "needs you: <cause>", `agent-input` = finished a turn
  (`done`), `agent-done` = the agent exited; events carry the session, are suppressed while that
  session is attached, and a session's first appearance never notifies. Agent state is marker-only
  (the Claude hook, the OpenCode plugin or the OSC reporter);
  the per-session `present` flag guards agent-done. `onEvent(cb)` is the push seam
  (`fcmPush.js`; `agent-blocked` pushes as "Claude needs you" / "OpenCode needs you"); browsers poll
  `GET /api/health/events`.

### Agent messaging

Claude Code and OpenCode sessions on different boxes send each other tasks and replies through
Tmuxifier, gated by a per-box policy (operator guide `docs/agent-messaging.md`; design and build
notes `docs/superpowers/specs/2026-11-14-agent-messaging-design.md`, `2026-11-15-…-build-notes.md`).
`index.js` builds it only when `config.agentMail` (`TMUXIFIER_AGENT_MAIL=off` builds none of it,
leaves the setup phase unwired, and a construction failure runs the server with messaging off;
the worker store and starter below are built either way, and the hub gets them, `sessionsOf` and
`mailInstalled` only when messaging is on); calls `forward.sync` and `hub.boxChanged` from
`onCycle` and `hub.boxChanged` from `onAgents`; runs `hub.prune()` daily (the hub prunes once itself when it is created, which is boot); tells
the forward `markInstalled(box.id)` when the `agent-mail` setup phase reports `ok`; and on
shutdown stops the forward (closing every listener) **before** flushing the mail store, so
nothing is posted after the final write.

- `agentMailPolicy.js` — pure: `EMPTY_POLICY`, `normalizePolicy` (refuses an unknown box id,
  drops the box's own), `isEnabled`, `mayStart(policies, fromId, toId)`. A thread between two boxes
  needs all four of sender's `send` + target in `sendTo` + target's `receive` + sender in
  `receiveFrom`; two sessions of one box need only that box's two switches. Box ids are
  user-controlled keys: `Object.hasOwn`, null-prototype maps. Test: `test/agentMailPolicy.test.js`.
- `agentMailPolicyStore.js` — `data/agent-mail-policy.json`, kept out of `boxes.json` on purpose
  (the box export, `store.js`'s field rebuild and the device-readable `GET /api/boxes` never see
  it). Mutations serialised on one chain, adopted only if they persist. `set(id, raw, { knownIds,
  mirror })`: the counterpart entry is written **per list** (`mirror.sendTo` →
  their `receiveFrom`, `mirror.receiveFrom` → their `sendTo`), never the other box's switches.
  Test: `test/agentMailPolicyStore.test.js`.
- `agentMailStore.js` — `data/agent-mail/`: one file per thread (a thread can grow without bound,
  so one file would be rewritten on every message) + `refusals.json`; coalesced writes, one in
  flight per file. States `queued`/`handed`/`delivered`/`dropped`; a close drops what is
  undelivered; `load()` turns `handed` back to `queued` (no waiter survives a restart). Bounds:
  newest 500 messages per thread (`dropped` counts the rest), 30 days idle, 200 refusals, and
  1000 threads for real (every thread is in memory and read at boot): `prune({ close, room })`
  deletes, above the bound, the longest-idle closed threads and then the longest-idle **open**
  ones, each closed `storage limit` through `close` first, never one active within the last hour
  (`STORAGE_KEEP_MS`); `hasRoom(close)` is what a new thread asks. The store never prunes on its
  own: the hub calls both. Ids `t-`/`m-` + 8 chars of a look-alike-free alphabet (`THREAD_ID_RE`,
  `MSG_ID_RE`). Close reasons: `operator`, `permission withdrawn`, `box removed`, `storage limit`,
  `worker did not start` (`WORKER_FAILED_REASON`). Not a debounced store: flushed through its own
  `whenIdle()`. Test: `test/agentMailStore.test.js`.
- `agentMailText.js` — every word an agent reads, and nothing else writes any: `wakeText` (its
  first line is the `[tmuxifier-mail m-…]` tag the hooks find; body inline up to 4000 chars),
  `statusPhrase` (also what the drawer shows, so short) and `agentStatusPhrase` (the same, plus
  what to do next after the operator's close), `refusalText`,
  `renderThread`/`renderWho`/`renderInbox`/`renderReply`, `cleanBody` (control-strip only, 65536
  UTF-8 bytes). `wakeText` and `renderInbox` word a message **by its kind**. A thread's first
  message (`task`) says the operator allowed the sender and to always answer with `tmx reply`:
  the designed "not from your operator" wording made a real Claude decline to act. Every later
  one (`reply`) says neither: that authorisation is not true toward the thread's starter, and
  "always answer" on a reply makes two agents acknowledge each other without end; it is input for
  the thread's work, answered only when it asks something. Starting an agent keeps its words here
  too: the worker refusals (`workers-off`, `mail-not-set-up`, `no-project`, `worker-cap`,
  `no-dir`, `start-failed`, …), the status kinds `queued-starting`, `queued-startup-prompt` and
  `closed-worker-failed`, and the starter lines of `renderWho(rows, starters)`. Test:
  `test/agentMailText.test.js`.
- `agentMailHub.js` — the delivery engine and the box-side operations (`who`, `send`, `reply`,
  `read`, `inbox`, `waitMail`, `waitReplies`, `ack`, `boxChanged`, `policyChanged`, `boxRemoved`,
  `closeThread`, `prune`, `threadStatus`). "Running an agent" = the box's parsed `agentMarks` hold
  a marker for the session (`marksOf`, from the poller snapshot), **not** the dashboard's
  `present` flag. A queued message
  goes to an open `tmx wait` of that session on its thread, else to **one** waiter, and only while
  the marker is `ready`; the thread's permission is re-checked at every post, read, inbox,
  delivery and policy save, and a thread without it closes `permission withdrawn`. A new waiter of
  a pane ends the older ones of that pane, and re-queues what was handed on that pane or more than
  600 s ago. `pending` is a superset index of where undelivered mail may be, so `boxChanged` after
  every sweep reads only threads with mail for a session that can take it. Every held request
  settles exactly once. `send` checks the caller's own send switch before it looks the target up
  (a box that may not send learns nothing about which boxes exist) and asks the store for room
  last (`store-full` when 1000 threads are all active within the hour); every close, the storage
  one included, goes through `endThread`, so waits on the thread end. `threadStatus(thread,
  viewer)`: for a participant (`tmx wait`'s lines) it is about the newest message **that side**
  sent, `nothing new since the last reply` when the other side's newest message has reached it;
  for `'operator'` (the browser) it is the thread's newest message. **Starting an agent** (read
  the header before changing it): a bare target (`.` or a label alone) goes to a session that can
  take mail (a marker **and** a pane from `sessionsOf` running claude, opencode or unknown; never
  the caller's own; the configured session first, else the only one, else `several-agents`). With
  none, or with `send(…, { fresh })` (`''` the default project, else a project name), it starts a
  worker through the injected starter, only when the box's `mailStart` is on with a project and
  `mailInstalled` is true. Room in the store is asked before the start, and the boxes and policy
  are read again after it (box gone or permission withdrawn: refused, the worker stays up). A
  second bare send joins the box's pending bare start; `fresh` always starts its own. The
  in-memory `starts` list is judged at every `boxChanged`: a marker means up; 30 s without the
  session on `claude`, on two consecutive looks, closes its threads `worker did not start`;
  60 s on `claude` with no marker reads `queued-startup-prompt`. The two looks hold only while
  `boxChanged` runs at most once per applied status read (index.js: after each sweep and each
  applied refresh). Start refusals name the box by its label (the log keeps the typed target);
  a `workerStore.get` that rejects reads as a box that starts none. `who` lists the boxes a send
  can start an agent on. `createAgentMailHub`'s signature must stay on one line:
  `test/opencodeAgentMailClient.test.js` regex-matches it in the source. Tests:
  `test/agentMailHub.test.js`, `test/agentMailHubDelivery.test.js`, `test/agentMailHubWorkers.test.js`.
- `agentMailListener.js` — per-box `node:http` on a unix socket `data/mail/<12 hex>.sock` (the
  forward keeper names it from the box id and its connection fields). **The socket is the
  identity**: `caller.boxId` is the listener's own. `close()` destroys every connection and ends
  every held request. The wire format
  table is its header (GET params in the query, POST params only as form fields, a repeated
  parameter refused); every parameter is allowlisted before any hub call (`POST /v1/threads`'s
  optional `fresh` is empty or a `PROJECT_NAME_RE` name, else 400); 64 open / 32 held
  requests, then 503. Test: `test/agentMailListener.test.js` (real socket, real hub).
- `agentMailForward.js` — puts each enabled box's listener on the box as
  `~/.tmuxifier-mail/sock` with `-O forward -R` on its ControlMaster, from `sync(boxes, snapshot)`
  after each sweep (and a `kick` after a policy save). The ensure is mkdir + `rm` + print `$HOME`,
  then **`-O cancel`**, then forward, then a nonce `curl` through the box socket: a forward counts
  as up only when this listener saw the nonce, because re-issuing a forward a master already holds
  exits 0 and does nothing. Same pid on `-O check` = nothing to do, except a nonce recheck every
  10 min of silence; failures back off 30 s doubling to 30 min. The shared-connection and
  re-address rules are in Load-bearing rules. A box turned off or removed has its listener closed
  first; one gone from the list gets the local `-O cancel` only, never a remote command. The
  box's `$HOME` is box output (`HOME_RE`, ≤ 80 chars). `status(boxId)` feeds the Edit Box line;
  `installed` comes from the tools line the ensure and every verify print, from
  `markInstalled(boxId)` (setup's `agent-mail` phase reported `ok`), and is never reported
  `false` while a session of the box is listening. Tests: `test/agentMailForward.test.js`
  (a scripted model of what OpenSSH was measured to do) and
  `test/agentMailForward.integration.test.js` (real sshd and masters via `localBox.js`: two box
  records on one master, master kill and keeper restart, a re-address to a second master).
- `claudeAgentMail.js` + `src/server/assets/tmuxifier-mail.sh` + `src/server/assets/tmuxifier-mail-skill.md`
  — the `agent-mail` setup phase, structural twin of `claudeAgentHooks.js`: both files on stdin
  (split at `SKILL_SEPARATOR`, each landed by rename), nothing interpolated but the ticked
  selection as two literal lines, `WANT_CLAUDE=1|0` / `WANT_OPENCODE=1|0`
  (`push(box, { claude, opencode })`, from setupManager; the legacy `claudeStatusline` flag counts
  as claude). An unticked agent is never looked for, so never touched; for a ticked one the box
  decides (`claude` on PATH or `~/.local/bin`; `opencode` on PATH or `~/.opencode/bin`): `tmx` and
  its link for either, the Claude parts below only with `claude`, and with `opencode` the same
  skill bytes at `${OPENCODE_CONFIG_DIR:-~/.config/opencode}/skills/tmuxifier-mail/SKILL.md` —
  best-effort beside Claude (`opencode-skill-failed` → a `note`), fatal alone
  (`error-opencode-skill`). It skips with no ticked agent present (`skipped-no-agent`), no `curl`,
  or a `~/.local/bin/tmx` that is not exactly its symlink; an OpenCode-only run prints
  `opencode-only` and the ok result's `note` says OpenCode's half arrives with the plugin. One `settings.json` rewrite (jq → node → python3) merges `MAIL_HOOKS` (`SessionStart` + `Stop`:
  `hook-wait` with `asyncRewake`; `UserPromptSubmit`: `hook-ack`), remove-then-append on the
  string `tmuxifier-mail`, and set-adds `MAIL_PERMISSION_RULE` = `Bash(tmx *)` to
  `permissions.allow`, touching nothing else in `permissions`. The same rewrite merges
  `MAIL_AUTOMODE_ENVIRONMENT`/`MAIL_AUTOMODE_ALLOW` into `autoMode.environment`/`allow` (a list it
  creates is `["$defaults", ours]`; in the operator's own it drops elements containing
  `[tmuxifier-mail]` and appends ours, never adding `$defaults`); an `autoMode` that is not an
  object or a list that is not all strings fails the merge closed. Only for a box `claude --version`
  of at least `AUTOMODE_MIN_CLAUDE` (2.1.228); below it or unreadable, `autoMode` is untouched and
  the ok result carries `note`. Test: `test/claudeAgentMail.test.js`.
  The `tmx` script: POSIX `sh`, curl over the socket, bodies only on curl's stdin, never
  evaluates an answer; the user commands (never `hook-wait`/`hook-ack`) take the calling pane from
  `TMUXIFIER_MAIL_PANE` when set, ahead of `TMUX_PANE`: a pane id replaces it and needs no `$TMUX`,
  `none` or anything malformed exits 2 with no request, and so does an unset or empty one under
  OpenCode (`OPENCODE` or `OPENCODE_TERMINAL` non-empty: `$TMUX_PANE` there is the first TUI's); `send`/`reply` are **never retried** once
  the request may have arrived (exit 3); with no socket file at all a user command says at once
  that messaging is not turned on for the box (exit 3, no retry), while a file that does not answer
  is retried. `hook-wait` follows its Claude Code via `/proc` (not `$PPID`, a dash wrapper that
  survives a `SIGKILL`ed Claude) and holds a per-pane lock whose every read and action goes
  through the decision table above `lock_decide`; `hook-ack` prints nothing and always exits 0.
  `tmx send [--fresh [--project <name>]] <target> ["text"]`: options come before the target, `--project`
  needs `--fresh`, and `--fresh` refuses `box/session`, each exit 2 before any request; spelled
  without `=` so the OpenCode plugin's `TMX_ARGS_RE` allowlist stays as it is (pinned by
  `test/opencodeAgentPermission.test.js`). The skill's "A box with no agent" section says when to
  ask for a fresh worker. Test: `test/agentMailTmx.test.js` (the real script against the real listener).

### Agent workers

An interactive Claude Code that Tmuxifier starts on a box in its own tmux session, when a send
finds no agent on it, when a lead asks (`tmx send --fresh`) or when the operator picks **Start
Claude in <project>** (operator guide: "Starting an agent on a box that has none" in
`docs/agent-messaging.md` and "Agent workers" in `docs/boxes-and-setup.md`; design and build notes
`docs/superpowers/specs/2026-11-19-agent-workers-design.md`, `2026-11-21-agent-workers-build-notes.md`).
`index.js` builds the store and starter whether or not messaging is on (the operator's Start and
the Edit Box section need no messaging); a construction failure runs the server without them and
their routes answer 503. Interactive Claude Code only: no headless mode, no other agent.

- `agentWorkerRules.js` — pure: `PROJECT_NAME_RE`, `isWorkerDir` (the one definition of a safe
  directory, used on write and again by the starter), `normalizeWorkers` (explicit values are
  validated, never rewritten: 0-8 projects, `max` 1-8 default 3, `trust` and `mailStart` on only
  for a literal `true`), `workerSessionName` (the lowest free `worker-<project>-<n>`),
  `runningWorkers` (by name prefix **and** a pane running `claude`, so a leftover shell does not
  use up the cap) and the closed `WORKER_MODES`/`WORKER_AGENTS` tables. Test:
  `test/agentWorkerRules.test.js`.
- `agentWorkerStore.js` — `data/agent-workers.json`, kept out of `boxes.json` on purpose (the box
  export and the device-readable `GET /api/boxes` never see it). The twin of
  `agentMailPolicyStore.js`: null-prototype map, mutations serialised on one chain and adopted
  only if they persist. A stored entry that no longer passes the rules is absent on load (one
  `console.error` line names the box and the rule), never handed to a starter. Test:
  `test/agentWorkerStore.test.js`.
- `agentWorkers.js` — `buildWorkerStartRemote` is the one remote script (`set -eu`; tmux, `[ -d ]`,
  the agent binary, the optional trust write, an exact-target `has-session`, then `new-session -d`
  running `exec "$SHELL" -ic 'exec claude'`: a plain `claude` command fails, tmux runs it with no
  rc files, so no `PATH` and no token); a run prints ONE `WORKER: <code>` result line (the first
  step that does not pass, `exists` or `started`), which `parseWorkerResult` allowlists. The
  trust write (`WORKER-TRUST:`; jq → node → python3) reads first and writes only when the key is
  not already `true`, never through a symlink, and a failed write never fails the start.
  `createAgentWorkers(…).start(box, { project, mode })` refuses in
  order (mode, setup running, no listing, project, the `max` cap), runs the script once and once
  more on `exists`, serialises per box, and never throws; its result is `{ ok, session, project,
  trust }` or `{ ok: false, code }` (`START_CODES`). It remembers its own starts for up to 60 s
  because the listing it reads lags them, and trusts the box's listing for them once two newer
  status reads have been applied (`listingSeq`), so a killed worker stops counting once the list
  shows it gone. Read its header before touching it. Tests: `test/agentWorkers.test.js`,
  `test/agentWorkerScript.integration.test.js`, `test/agentWorkerTrust.integration.test.js`,
  `test/agentWorkers.integration.test.js` (a real private tmux through
  `test/helpers/workerBench.js`, never the default tmux server).

### Fleet Command

- `fleet.js` / `fleetStore.js` — one command across many boxes as a persisted job at
  `fleetConcurrency`. Commands run under the box's **login shell**. `scriptName` is a frozen
  display label, never re-resolved (an invalid one is dropped, never fails the run).
- `fleetScriptsStore.js` — saved scripts CRUD (unique names case-insensitively, 65536-char body
  cap matching the route). Deliberately unsealed. `getScript(id)` returns `null`, never throws.

### Proxmox and NetBox

- `proxmoxValidate.js` — pure validators (incl. link `kind`: absent, `'lxc'`, or `'qemu'`).
- `proxmoxStore.js` — `data/proxmox.json`; seals on write, redacts on read
  (`getHost(id, { withSecret })` is the only decrypting path).
- `proxmoxApi.js` — PVE client with TLS pinning. Guest power/destroy/list/`guestConfig` take
  `kind` and re-validate it before it becomes a path segment. `createLxc`, `lxcInterfaces`,
  `setLxcConfig` are LXC-only (VM provisioning is out of scope).
- `proxmoxParams.js` — preset → LXC create params; `parseNet0`/`describeNet0`/
  `buildNet0Readdress` (rewrites only `tag`/`ip`/`gw`), `macOfNet0`.
- `defaultKey.js` — the host's SSH public key as the default management key
  (`TMUXIFIER_PVE_DEFAULT_PUBKEY` overrides).
- `proxmoxProvision.js` / `provisionStore.js` — create → poll → start → discover → link → auto
  setup (`waitForSsh: true`), with an `allocate-ip` NetBox phase for `auto-static`. Refuses a
  hostname/known IP colliding with an existing box **before** creating anything.
- `proxmoxInventory.js` — linked-guest (LXC + QEMU) status authority, one
  `/cluster/resources?type=vm` per host; rows carry `template`. Follows in-cluster node migrations
  (CAS + active-job guards) and re-homes orphaned links on a re-added profile. A kind mismatch
  reports `mismatch` and writes nothing. **Cross-cluster follow**: links carry `fp: { name, mac }`
  stamped by the inventory; a `missing` link re-homes only on exactly one unlocked, non-template,
  unlinked same-kind guest with matching name and MAC, failing closed on 0/2+ matches, unreadable
  profiles, locks (`locked`), and fingerprint twins (`twins`, which stops alias profiles
  double-linking). `verifyIdentity` reports `mismatch` when a renamed guest's MAC changed.
  `refreshBox(box, { follow: false })` skips re-home and stamping; `findFollowCandidates` is the
  read-only search. `listClusterNodes` feeds the dashboard.
- `proxmoxLifecycle.js` / `proxmoxLifecycleStore.js` — power/deprovision/readdress jobs. `node`
  comes from the refreshed inventory, `kind` from the stored link; `mismatch` is refused at every
  stage. Deprovision uses PVE's `forceStop` + `timeout` (`deprovisionGraceSec`, 120s), releases
  NetBox records, and refuses a fingerprinted `missing` guest that might live elsewhere (checked in
  `createJob` and again in `runDeprovision`). **Readdress** (LXC only): `inspect` → `allocate-ip` →
  `apply` → `relink` → `release` → `verify`; failures before `relink` release the new allocation,
  a `relink` failure releases nothing. `vlan` is the only client value reaching PVE/NetBox and is
  integer-checked before any I/O; refused while a setup job runs.
- `netboxValidate.js` / `netboxStore.js` / `netboxApi.js` — sealed settings, connection probe
  (ca/pin/insecure), `auto-static` allocation/release (stamping `dns_name`), `nextIp` preview
  (`GET /api/netbox/next-ip`), `listVlanPrefixes` (`GET /api/netbox/vlans`), and the 60s-cached
  utilization summary (`GET /api/netbox/summary`).

### Dashboard services

- `servicesStore.js` / `serviceCheck.js` / `serviceChecker.js` — tile CRUD (`section`, `group`,
  check kind `http|tcp|pihole|truenas|unifi|immich|none`, `icon`), the HTTP/TCP liveness engine
  (TLS errors tolerated — no credentials sent), and the sweep (`TMUXIFIER_SERVICE_POLL_MS`, ≥5s)
  behind `GET /api/services/status`. Credentials are redacted to `hasPassword`;
  `getServiceSecret` is the only decrypting path. A rejected credential is `auth`, not `down`.
- `serviceClientRegistry.js` — one API client per service id, rebuilt when its options change,
  `retain`/`closeAll`. The four integrations below each wrap it in a `*Registry.js`.
- `piholeApi.js` — Pi-hole **v6** REST; holds exactly one session (v6 caps them), reused until 80%
  of validity, revoked on shutdown. Read-only.
- `truenasApi.js` — JSON-RPC over one WebSocket to `wss://<host>/api/current` (REST is gone);
  `auth.login_ex` with `API_KEY_PLAIN`, never negotiated. **https only** (TrueNAS revokes keys
  sent over http). Read-only.
- `unifiApi.js` / `unifiMetrics.js` — Integration API v1, **GET only**, 30s snapshot TTL, three TLS
  modes, http refused. `classifyDevice` leads with the model prefix.
- `immichApi.js` / `immichMetrics.js` — **GET only**, 30s TTL. A `403` degrades only that reading
  (named in `metrics.denied`); `401` is `auth`; only transport failure is `down`. Never calls
  `/api/users`. Library size ≠ volume size.
- `iconResolve.js` / `iconCatalog.js` / `iconStore.js` — slug candidates (check kind → name →
  hostname, IPs dropped), the pinned slug/extension allowlist (no digests by design), and
  `vendor/icons/` → `data/icons/` lookup with a favicon scrape only on catalog miss. Slugs are
  re-checked and paths confined before every read. Served by dynamic routes
  (`GET /api/services/:id/icon`, `GET /api/icons/:slug`) because static assets register at boot.

### Voice dictation and UI settings

- `voiceStore.js` / `voiceInstall.js` / `voiceInstallStore.js` / `voiceDownload.js` /
  `voicePaths.js` — `data/voice.json` is authoritative and read per request. Single-flight install
  job; downloads hash incrementally to a temp path and rename only on a pinned SHA-256 match.
  `TMUXIFIER_WHISPER_BIN`/`MODEL` win when set and show as pinned in the UI.
- `voiceText.js` / `voiceCatalog.js` / `voiceEngine.js` — transcript normalization (newline
  collapse is load-bearing: a newline through `send-keys` is Enter), the pinned model allowlist,
  and the lazily spawned whisper.cpp server. `POST /api/voice` transcribes and injects via the
  upload guard (`?inject=off` returns text only). Audio never leaves the host.
- `uiSettingsStore.js` — `data/ui-settings.json` (`GET`/`PATCH /api/ui-settings`). Catalog-agnostic:
  validates slug shape only; the client normalizes unknown ids. `null` = never set. Fails open. The one
  boolean, `sidebarSpark` (sidebar sparkline, off by default), is never `null`: only a literal `true` reads on.
  `update` is serialised on one promise chain (overlapping PATCHes both land) and validates the whole
  patch before its one write, so a patch with any bad value stores nothing.

## Web client (`src/web/`)

TypeScript + xterm.js, bundled by Vite. Vitest runs `environment: 'node'` with no DOM, so modules
are split into a pure half (unit-tested) and a DOM half (Playwright).

- **Shell & plumbing** — `main.ts` (boot, login incl. passkey, workspace, stage, provision panel,
  setup-job viewer; `loadUiSettings()` at boot and after each login path), `api.ts`, `http.ts`
  (shared fetch helpers + the `onUnauthorized` seam), `dom.ts` (builders, `openModal`,
  `makeRadio`), `modalRegistry.ts` (body-mounted modals register `close()` for logout teardown),
  `arming.ts` (shared arm-then-fire reducer), `fmt.ts` (shared formatters).
- **Terminal** — `terminal.ts` (pane handle with `input(d)`/`appCursor()`, the `transformInput`
  seam; `wireTouchGestures` turns drags into wheels and, on mouse-tracking panes, swallows taps and
  makes a ~500ms hold the click; the PTY learns sizes through xterm's own `onResize`, which also
  covers the post-webfont refit — never add a separate `sendResize` beside `fit.fit()`),
  `touchGesture.ts`, `termFont.ts` (font stack; `TMUXIFIER_TERM_FONT` via `GET /api/ui-config`),
  `reconnect.ts`, `clipboard.ts`, `upload.ts`.
- **Stage & panes** — `stageLayout.ts` (pure split tree of instance leaves `${box}#${ordinal}`;
  v3 serialization with per-pane session overrides; v1/v2 migrate by appending `#1`;
  `phonePaneOf`), `stagePanes.ts` (split DOM, ARIA splitters, drop targets, `focusMove`),
  `paneHeader.ts` (view-model: chip precedence pane-state > connection > agent, agent chip is the
  state of the pane's OWN session; session/window targets; `targets: null` in
  phone mode), `sessionPicker.ts` (popup replacing native `<select>` so rows can carry a kill ×;
  never rebuilds while a row is armed; consumers **must** call `destroy()`), `paneLifecycle.ts`
  (Proxmox power caps: word face, one-family Nerd Font mark under 560px, CSS decides),
  `duplicateSession.ts` + `freshProbe.ts` (duplicate panes adopt a free live session, else create
  `<configured>-2`…, after a fresh probe), `statusDot.ts`. Picking a different session in a pane
  is **pane-local** (`paneSessions` override via `/term`'s `session` param), not a box PATCH.
  Pane drag (`text/x-tmuxifier-pane`) moves; sidebar drag of a docked box duplicates; Host Shell
  is move-only and single-instance. `MAX_PANES` is 4.
- **Phone** — `phoneMode.ts` (`(max-width: 720px)` flag, drawer, `--vvh` = `vv.height * vv.scale`,
  `kb-open`; the drawer closes only on controls in `CLOSES_DRAWER`), `touchKeys.ts` (touch bar,
  `(pointer: coarse)` only, fits a 344px viewport; keys fire on `pointerdown` + `preventDefault`;
  `createStickyCtrl` folds raw ASCII only, never `toUpperCase()`), `composer.ts` (✏️ composer:
  `sendTextOf` collapses newlines, clears only when the send was accepted; mic dictates into it via
  `inject=off`).
- **Agent switcher** — `agentSwitcher.ts` (DOM half: overlay, capture-phase document key listeners; the
  overlay never takes focus; its root is a backdrop — a click outside the panel cancels) over pure
  halves `agentSwitcherList.ts` (rows, MRU, highlight), `agentSwitcherChord.ts` (idle/open/drain
  reducer), `agentSwitcherPreview.ts` (250 ms rest, abort, 5 s cache), `agentSwitcherCommit.ts`
  (`planCommit`: focus / switch in place / replace / open) and `ansiStrip.ts`. `hotkeys.ts` is the combo model, validation and per-browser store. `termClose.ts`
  mirrors `TERM_RELEASE_CODE`, sent for the pane a jump replaces. The MRU is fed by `noteFocusedSession`,
  called only from `repaintStage` and `syncPaneFocus`. Inert in phone mode, under a coarse pointer,
  with a modal open or while Settings records a combo. `settingsHotkeys.ts` is the Hotkeys tab.
- **Voice** — `wavEncode.ts` (16 kHz mono WAV, so no ffmpeg), `voiceRecorder.ts`,
  `voiceWorklet.js` (real asset, keeps CSP `script-src 'self'`), `pcmStream.ts`, `voicePress.ts`
  (press reducer: a `claude` verdict links, else dictates), `voiceLink.ts`, `voiceUi.ts`
  (`evaluateVoice`, the voice hotkey — Ctrl+Shift+Space by default, read through a getter at event time — swallowing the whole chord), `voice.ts`.
- **Live** — `liveLink.ts` (pure: `parseLiveMessage`, `createLiveQueue` — nudged ids folded into
  at most one refresh a second, more than four at once becomes a full poll — and `openLiveLink`,
  whose backoff resets only after 10 s of uptime because the server accepts an upgrade before
  refusing it). `main.ts` `liveRefresh` fetches just the nudged boxes (`api.statusOf`,
  `api.healthSeriesOf`) and waits for fleet-wide reads already in flight (`fleetReads`); a
  reconnect polls everything. `pollEvents` is single-flight.
- **Agent state** — `agentState.ts` (pure: `AGENT_PRECEDENCE`, `latestAgents`, `worstAgent`,
  `agentChipText`, `agentCounts`, `agentCards`, `fmtAge`; every agent surface folds through it).
- **Agent messaging** — rendered only when `GET /api/ui-config` says `agentMail: true`
  (`mailEnabledFrom`: anything else is off). `agentMail.ts` (fetch layer), `agentMailView.ts`
  (pure: every word the operator reads — pair lines, status line, thread rows; `operatorStatus`
  turns the agents' `queued` into `waiting`; the per-list mirror marks), `agentMailSection.ts`
  (the Edit Box section, edit mode only; `commit(boxId)` runs after the box save, sends nothing
  until the policy has loaded, and only when it changed). The Messages drawer lives in `main.ts`
  (Threads / Refused, a thread view, 5 s generation-guarded poll that repaints only on change,
  Stop arm-then-fire), its markup in `index.html`, `#messages` in phone mode's `CLOSES_DRAWER`.
  Message bodies come from AI agents on other machines: `textContent` only. Tests:
  `test/agentMailView.test.js`, `test/e2e/agentMail.spec.ts`.
- **Agent workers** — `agentWorkers.ts` (fetch layer), `agentWorkersView.ts` (pure: the server's
  rules copied and pinned equal by test, every message the Edit Box section shows,
  `startTargetsOf`), `agentWorkersSection.ts` (the Edit Box section, edit mode only, same
  `element`/`commit(boxId)` contract as `agentMailSection.ts`; a problem throws `Box saved, but
  the agent worker settings were not: …`). The pane picker's **Start Claude in <project>** rows are
  `SessionTarget`s of kind `start` (`value` `start:<project>`, `session: ''`: every consumer of a
  pick or a kill must handle that kind itself, and `canKillTarget` gives it no ×). `main.ts`
  appends them in `paneHeaderModelFor` from the projects `refreshWorkerProjects` re-reads each time
  a picker is reached for, and `startWorker` starts the worker and switches the pane through
  `switchPaneSession`. No start rows in phone mode or on the Host Shell. Tests:
  `test/agentWorkersView.test.js`, `test/sessionPicker.test.js`, `test/e2e/agentWorkers.spec.ts`.
- **Dashboard** — `dashboard.ts` (standby dashboard when no pane is docked; polls only while
  mounted; AGENTS board `dash-board`, columns in precedence order, a card docks the box on that
  session; fleet cards are a spec sheet, not live gauges), `truenasCard.ts`, `unifiCard.ts`,
  `immichCard.ts`, `serviceIcon.ts` (always `<img>`, hides on error), `sparkline.ts`,
  `sidebarSpark.ts` (the Appearance flag + tint-class helper: off empties each row's graph and drops the
  `spark-*` tint; `main.ts` seeds it in `loadUiSettings` before the first render), `healthEvents.ts`, `notifyPrefs.ts`.
- **Themes** — `themes.ts` (pure catalog; `DEFAULT_THEME_ID` = `vercel`, `ROOT_THEME_ID` =
  `instrument` which wears no `data-theme`; `normalizeThemeId`), `theme.ts` (`applyTheme`,
  `resolveScreenTheme`, CSS imports), `public/theme-boot.js` (pre-paint stamp from the
  localStorage mirror), `clawd.ts` (working-chip indicator variants; motion is pure CSS
  `.clawd-v-*`; `off` still returns an element). Adding a theme = `themes/<id>.css` (all rules
  `[data-theme]`-scoped) + a `themes.ts` entry + its import in `theme.ts`; pinned by
  `test/styleTokens.test.js` and `test/themes.test.js`.
- **Fleet** — `fleetSelection.ts`, `fleetHistory.ts`, `fleetEditor.ts` (CodeMirror), `fleetPoll.ts`
  (generation-guarded), `fleetJobs.ts` (drawer view-model), `fleetScripts.ts`/`fleetScriptRail.ts`
  (a run carries `scriptName` only while the buffer equals the saved body).
- **Setup & Proxmox** — `setupOptions.ts` (shared setup form; post-setup script is an id lookup),
  `provisionTools.ts`, `presetSummary.ts`, `setupStatus.ts`, `setupPoller.ts`,
  `interactiveLauncher.ts` (at most one interactive finish), `proxmox.ts`/`proxmoxUi.ts` (hub:
  Guests, Presets, Provision, Activity), `proxmoxPresets.ts`, `proxmoxGuests.ts` (no lifecycle
  actions for `mismatch`/`unknown`/templates; readdress for running/stopped LXC only),
  `proxmoxReaddress.ts`, `proxmoxActivity.ts`, `proxmoxAssociation.ts`, `lifecyclePoll.ts`,
  `freshBox.ts` (Edit Box opens from a freshly fetched box — the server moves links on its own).
- **Settings** — `settingsUi.ts` (tab order = `SECTIONS` key order: Boxes, Services, NetBox,
  Proxmox, Passkeys, Devices, Voice, Notifications, Appearance, Hotkeys), one `settings*.ts` per tab,
  `settingsForm.ts`, and fetch layers `netbox.ts`, `devices.ts`, `passkeys.ts` (also
  `evaluateOrigin`, shared by login and Settings). The Proxmox tab is split like the rest:
  `settingsProxmox.ts` (DOM) over `settingsProxmoxView.ts` (pure, unit-tested: TLS-mode legend, host
  state, key display, every form's validation). Its rules: a form is a real `<form>` behind a key and
  at most one is open (`EditorSlot`); an endpoint edit drops the Inspect result (a fingerprint belongs
  to one address); every host is tested when the tab opens and the failure is written in the row;
  Remove/Clear arm-then-fire; its modifier is `bad`, never `err` (a bare `.err` is the login line's
  centred rule). Styles are the `pvs-*` block, apart from the hub's `.pve-*`. e2e:
  `test/e2e/settingsProxmox.spec.ts` against `test/helpers/fakePve.js`.

## Android app (`android/`)

Kotlin/Compose agent console — a **renderer of the server APIs**: it never speaks SSH or emulates
a terminal (design: `docs/superpowers/specs/2026-08-09-android-agent-console-design.md`).
`pane/Sgr.kt` parses `capture-pane -e` into spans rendered as inert native text; `keys/`
(`armReduce`, `sendTextOf` mirror the web/server) and `session/` are pure and JVM-tested; `api/`
is OkHttp + a Keystore token store. Build with Gradle (`android/README.md`: toolchain, memory caps,
signing, the **keystore backup obligation**), separate from `npm test`; Compose UI is validated on
a real device only. Firebase is initialized at runtime from `GET /api/devices/fcm-config` — nothing
project-specific in the APK. Release signing needs the gitignored `keystore.properties`. Each app
version is attached to an `android-v<version>` GitHub release, which `npm run fetch-apk` pins.
When writing Kotlin with `\uXXXX` escapes, run `grep -naP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'`
before building — generated escapes repeatedly land as raw bytes.

## MCP server (`src/mcp/`)

Dependency-free stdio MCP server, also a renderer of the server APIs — HTTP only, as an enrolled
device (design: `docs/superpowers/specs/2026-08-19-mcp-server-design.md`). `jsonrpc.js` (framing),
`mcpServer.js` (transport-agnostic lifecycle; handlers run concurrently), `apiClient.js` (its
`ROUTES` table **is** the blast-radius boundary — no deprovision, deletes, forget-hostkey, or
settings/credential CRUD; pinned by `test/mcpApiClient.test.js`), `tools.js` (19 tools;
`guest_power` excludes `deprovision`; `read_pane` never sends `cols`/`rows`; `send_key` enum =
`NAMED_KEYS`), `shape.js` (strips SGR), `config.js` (URL: `TMUXIFIER_MCP_URL` → token file →
`loadConfig()` → default bind; token: `TMUXIFIER_MCP_TOKEN` → token file; trusts the repo's own TLS
cert additively whenever the resolved URL is this repo's endpoint), `index.js` (redirects
`console.log` to stderr first — stdout is the protocol). Tool descriptions mark box output as
untrusted data. Full-stack test: `test/helpers/mcpStdio.js`'s `spawnMcp`.

## Conventions

- ESM everywhere (`"type": "module"`); Node 20+ to run, 22.12+ to build and test (vite 8 / vitest 5). Server is plain `.js`; web client is `.ts`.
- TDD: write the failing test first (see `test/`). Tests use **real code, not mocks** — enabled by
  the factories above. A green test over a fake transport proves nothing about the real one.
- Integration and e2e suites run against an **isolated** box: `test/helpers/localBox.js` spawns
  its own `sshd` (ephemeral port, temp host key, temp `AuthorizedKeysFile`, `SetEnv
  HOME/ZDOTDIR/TMUX_TMPDIR` into a fixture home). It never reads the operator's shell config or
  touches `~/.ssh/authorized_keys`, and `TMUX_TMPDIR` keeps it off the operator's tmux server.
  Pinned by `test/localBox.integration.test.js`; a missing `sshd` fails loudly, never falls back.
- Conventional-commit messages (`fix(pty): …`, `feat(ui): …`).

## Shipping (contributing changes back)

The GitHub repo is **public** — never commit real PII (your domains, public/LAN IPs, hostnames,
emails, box/fleet names). Real values live only in the gitignored files above; committed docs,
examples, and tests use placeholders (`example.com`, RFC1918 IPs like `192.168.1.10`,
`you@example.com`).

Features are validated on the **live app before they merge**: build in the feature worktree,
`rsync -a --delete <worktree>/dist/ ./dist/` (plus any changed server files), and restart the
service. The restart is mandatory even for client-only changes — asset routes are registered per
file at boot, so a freshly swapped hashed bundle otherwise falls through to the SPA fallback
(`text/html`) and the app renders blank. Verify by fetching one hashed asset end-to-end (expect its
real content-type), not just `GET /`. Only after validation does the branch merge to main and the
checklist below run; a failed validation is fixed on the branch and redeployed, and rollback is
`npm run build` from main. Any restart waits until no setup/provision/lifecycle/fleet/
voice-install/apk-build job is `running`.

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

The login gate is the crown jewel — Tmuxifier can SSH into your whole fleet. It binds to
`127.0.0.1` by default; expose it only behind TLS.

**Login paths.** Password mode mounts `POST /api/login`; OIDC mode mounts `/api/auth/oidc/<id>/*`
(and `/api/auth/google/*` for the `google` provider) instead — there is no password login in OIDC
mode and no break-glass (hand-rolled OIDC: a per-flow state cookie `tmuxifier_oauth_<state prefix>` + PKCE,
server-to-server token exchange that refuses redirects,
per-provider exact-email allowlist; the id_token is trusted because it comes straight from the provider's token
endpoint). Only a fresh page load may auto-redirect to a single provider: session expiry (401) and
logout render the login page. Logout is local-only and sets a `tmuxifier.signedOut` flag in
`localStorage` (cleared on any successful sign-in) so every tab shows the signed-out page.
Passkeys mount in both modes.

- Passwords are scrypt-hashed; login is rate-limited per IP. Set `TMUXIFIER_TRUST_PROXY` only
  behind a reverse proxy (otherwise clients can spoof their IP). The session cookie is signed,
  httpOnly, `SameSite=lax`, expires server-side after 7 days, and is `Secure` with local TLS or an
  `https://` `TMUXIFIER_BASE_EXTERNAL_URL`.
- `.env` holds the password hash, cookie secret, `TMUXIFIER_CLAUDE_OAUTH_TOKEN` and
  `TMUXIFIER_FCM_CREDENTIALS`; `upsertEnvFile` writes it `0o600` — keep that.
- WebSocket auth rides the normal cookie path (`@fastify/websocket` v11); `isAuthed` keeps a manual
  cookie-header parse as a backstop.
- **Passkeys** share the login rate-limit bucket and return one generic 401 (no credential-id
  enumeration). In OIDC mode a passkey never consults any OIDC allowlist, so removing an
  email does **not** revoke that user's passkey — remove it in Settings → Passkeys. Enrollment
  requires an authenticated session. Challenge storage is bounded per client address, so a
  many-address attacker can still evict challenges (same residual limit as the rate limiter).
- **"Require a passkey"** (`passkeyOnly`) disables password and OIDC sign-in. Arming requires a
  fresh successful assertion in the arming browser and a usable RP id (409 when it is `null`,
  i.e. IP-derived, or doesn't match the enrolled credentials); removing the last credential
  disarms it; `TMUXIFIER_PASSKEY_ONLY=off` in `.env` is the break-glass (takes effect on restart).
- **Device tokens** (Android app, MCP): the pane route's `session` parameter and `GET /api/local-shell/pane`
  are refused for them; enrollment uses the password (403 under passkey-only, 501
  in OAuth mode) or a single-use 2-minute pairing code (works in every mode; minting needs a
  browser session, so it inherits that session's gate), over the login bucket. Only digests are
  stored; the plaintext is shown once. Revocation applies on the device's next request. A device
  token never expires and ignores the logout watermark — arming passkey-only does not revoke it.

**Stored credentials.** The Proxmox API token, SSH management keys and root password, the NetBox
token, and service-tile credentials are AES-256-GCM sealed at rest (key from `cookieSecret`),
files `0o600`, never returned to the browser (`hasToken`/`hasPassword` only).

- PVE and NetBox TLS: CA-verified or TOFU fingerprint pinning; per-host `insecure` is off by
  default. All provision input is validated before reaching the API.
- Service tiles that send credentials verify TLS by default; plain `http`/`tcp` liveness checks
  and the favicon scrape use `rejectUnauthorized: false` because they send none.
  - **Pi-hole**: use an app password (unaffected by 2FA, API-scoped); `insecure` opt-in; session
    id in memory only, revoked on shutdown.
  - **TrueNAS**: https only (http revokes the key), user-linked API key with READONLY_ADMIN.
  - **UniFi**: http refused; CA/pin/insecure. A local key inherits its admin's role and can write,
    so create it under a **View Only** admin. A changed pin is a hard failure, never re-pinned.
  - **Immich**: http allowed (the key survives plaintext and can be scoped read-only); scope it to
    `server.about`, `server.storage`, `server.statistics`, `server.versionCheck`, `job.read`,
    `systemConfig.read`.
- Service icons come only from `vendor/icons/` (pinned list) and `data/icons/` (scraped from the
  operator's own services); slugs are validated and paths confined; always rendered via `<img>`,
  which makes SVG inert.

**SSH and boxes.**

- Box host/user/port/proxyJump are allowlist-validated before reaching `ssh`; `startupCommand` is
  single-quoted. Keep new ssh-facing fields on that path.
- A changed host key is a possible MITM: `known_hosts` entries are never cleared because a
  connection failed (`status.js` reports `hostKeyChanged` and the UI offers the confirm-gated ⚷
  forget). Ordinary box removal does not forget a key. Readdress removes the new address's entry
  (freshly handed out by NetBox) and the released old IP's.
- Readdress: `vlan` is the only client value reaching an external system; the address and gateway
  come from NetBox and are re-validated (`isCidr`/`isIp`); a PVE hostname becomes a `dns_name` only
  if it passes `DNS_LABEL`.
- Setup runs server-side over the authenticated ControlMaster (`BatchMode`); a failed setup keeps
  the box.
- Seeding a box with `TMUXIFIER_CLAUDE_OAUTH_TOKEN` and/or `~/.codex/auth.json` hands it your
  subscription identity — seed only boxes you trust.

**Voice.** Off unless `data/voice.json` enables it and a whisper binary and model resolve (or the
legacy `TMUXIFIER_WHISPER_BIN`/`MODEL` pin them); `TMUXIFIER_VOICE=off` hard-disables. Transcripts
are control-stripped before `send-keys`. Dictation audio stays on the host. A **linked** Claude
Code pane is the exception: its audio streams to the box and on to Anthropic under that box's
Claude login (`docs/terminal.md#voice-dictation`).

## Docs

- `README.md` — overview, quickstart, architecture diagram, a short section per feature linking
  into `docs/`.
- `docs/configuration.md`, `authentication.md`, `boxes-and-setup.md`, `terminal.md`,
  `dashboard.md`, `fleet-and-health.md`, `agent-messaging.md`, `proxmox.md`, `android-app.md`,
  `mcp.md`, `privacy.md` —
  living user-facing guides; a feature change updates the matching guide.
- `docs/DEPLOY.md` + `deploy/tmuxifier.service` — systemd deployment (no secrets in the unit;
  `HOME` set so ssh children find `~/.ssh`).
- `DESIGN.md` — visual authority for the Instrument (root) theme and the themes engine's token
  contract. Read it before changing anything the operator looks at.
- `PRODUCT.md` — what Tmuxifier is for and who it is for.
- `AGENTS.md` — this file for general coding agents (kept in sync with CLAUDE.md).
- `docs/superpowers/`, dated `docs/*-review-*.md` and `docs/feature-suggestions-*.md` — point-in-time
  records; don't rewrite them, add a new dated doc.
