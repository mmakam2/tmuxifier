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
  | `ui-settings.json` | theme + working-agent animation | — |
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
npm run gen-secret   # writes only TMUXIFIER_COOKIE_SECRET for OAuth mode
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
- `TMUXIFIER_AUTH_MODE` is `password` (default) or `oauth` (`google` is a legacy alias) —
  mutually exclusive. Passkeys are an additive third login path mounted in **both** modes.
- OAuth mode builds its callback from `TMUXIFIER_BASE_EXTERNAL_URL` (legacy alias
  `TMUXIFIER_PUBLIC_URL`); a scheme-less value becomes HTTPS, and `https://` marks the session
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
  job is `running`. `mode=provision` and the read-only probe stay ungated.
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
- **Never auto-promote best-effort phases.** Setup's seed/statusline/hooks/voice-link/script
  phases record their result and never fail the job; a failed setup never removes the box.
- **Every web fetch goes through `http.ts`** (the 401 → login seam); `test/webHttp.test.js`
  forbids hand-rolled `res.ok` checks elsewhere.

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
- `concurrency.js` — `mapWithConcurrency`, bounded parallelism for status sweeps and Fleet.
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
- `googleAuth.js` — dependency-free OIDC: code flow, PKCE, exact-email allowlist.
- `webauthn.js` — dependency-free WebAuthn: minimal CBOR reader (fed only registration
  attestation or previously validated stored keys), COSE→`KeyObject` (ES256/RS256/EdDSA),
  `verifyRegistration`/`verifyAssertion`. Attestation `none` only.
- `passkeyChallenges.js` — bounded single-use 120s challenges in a signed `SameSite=strict`
  `tmuxifier_pk` cookie; per-owner quota (3) so one flooding source evicts only its own entries.
- `passkeyStore.js` — `data/passkeys.json` CRUD, `passkeyOnly`, pinned RP id (pinned by first
  enrollment, cleared with the last credential, which also disarms `passkeyOnly`). A corrupt store
  fails **open** by design.
- `deviceStore.js` — Android/MCP device tokens: SHA-256 digests of 32-byte tokens, `timingSafeEqual`,
  `touch` throttled to once a minute, corrupt fails open.
- `pairingCodes.js` — single-use 120s pairing codes (≤4 outstanding), minted only by a browser
  session; human-typed alphabet without 0/1/I/O.
- `fcmPush.js` — subscribes to `healthHistory.onEvent`; agent-input/agent-done → FCM HTTP v1
  pushes (RS256 JWT via `node:crypto`). `TMUXIFIER_FCM_CREDENTIALS` unset = off. UNREGISTERED
  clears that device's FCM token, never its auth. `fcmAppConfig.js` extracts the Firebase
  *client* config from `TMUXIFIER_FCM_APP_CONFIG`.

### `server.js` — Fastify app

Login rate limiting, REST under `/api/*`, the `/term` and `/voice-link` WebSockets. Notable routes
(gates per the load-bearing rules above):

- **Auth.** `requireAuth` is async: signed session cookie first, then `Authorization: Bearer
  <device token>` (sets `req.deviceId`). Passkey routes mount in both auth modes.
  `POST /api/devices/enroll` bypasses `requireAuth` — it authenticates with the password (403
  under armed passkey-only, 501 in OAuth mode) or a pairing code, over the login rate-limit bucket.
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
- **Devices.** `GET /api/devices/apk[/info]` (absent = `available: false`),
  `GET /api/devices/fcm-config`, `POST/GET /api/devices/apk/build` (`apkBuild.js`: single-flight
  Gradle build, browser-session only; overwrites `data/app/`, so on a server serving the
  Play-signed build it swaps the signature).
- **Proxmox.** `PUT /api/boxes/:id/proxmox` writes `kind` from what the cluster reports.
  `GET /api/boxes/:id/proxmox/net` reads a linked container's live `net0`.
- **Responses.** `/api/` sets `Cache-Control: no-store` unless a route already set its own (the
  icon routes do). Permissions-policy `microphone` is always `self`.

### Boxes, SSH, tmux, terminals

- `store.js` — `data/boxes.json` CRUD, normalization, versioned export/import (import re-mints ids,
  drops unsafe entries). `uniquenessConflict(candidate, ignoreId?)` is the advisory pre-check;
  `addBox` stays the authority. A Proxmox link with no `kind` reads as `'lxc'` in `readAll()`.
  `readdressBox` writes host + NetBox id together.
- `sshCommand.js` — ssh argv builders; **every box field passes `assertBoxSafe` and is never
  shell-interpolated unquoted** (the command-injection surface). ControlMaster args,
  `SESSION_NAME_RE`, `sanitizeSession`.
- `sshRun.js` — one-shot ssh, `sshStream` (streaming), `sshRunStdin`, `sshPipe`.
- `boxActions.js` — per-box ops over the ControlMaster: tmux/framework/tool install
  (`TOOL_IDS`/`resolveTools`, mirrored by `provisionTools.ts` and the MCP `SETUP_TOOLS` enum,
  pinned by tests), `execCommand` for Fleet, master liveness/stale-socket reaping, and the
  exact-target remotes (`buildEnsureSessionRemote`, `buildSelectWindowRemote`,
  `buildKillSessionRemote`/`buildKillWindowRemote`). `buildKillTmuxRemote` is the separate
  best-effort teardown for box removal (sanitizes, `|| true`) — don't widen it.
  The `node` tool installs NodeSource `NODE_MAJOR` (24) on apt/dnf/yum with a version-aware
  guard (upgrades an older Node, removing distro `npm`/`libnode-dev` first).
  `buildFrameworkUpdateClamps` disables shell-framework self-updaters on **every** setup, each
  guarded by evidence the framework is present (the oh-my-zsh guard's `^` anchor is load-bearing:
  stock `.zshrc` contains the commented template line).
- `sessions.js` — PTY lifecycle. PTYs are keyed per viewer; callers act on **groups**
  (`entry.group` = box id, `closeGroup(group, kind?)`). `safeClientId` falls back to `shared`.
  `maxViewersPerBox` (8) with grace-window slot reclamation. Refcounted listeners + `graceSeconds`
  keep a dropped PTY for reconnects. Reattach replays the last 64KB prefixed with `REPLAY_CLEAR`
  (SGR reset + clear) — don't rely on the size nudge to clean the screen.
- `localShellActions.js` — the optional Host Shell (`localShell` = `none`/`omz`/`omb`).
  `installAgentHooks()`/`installVoiceLink()` reuse the box pushers over a local `/bin/sh`
  transport, triggered only by `claudeHooks === true` on `PATCH /api/local-shell`.
- `localTmuxScope.js` — creates the `=local` session under `systemd-run --scope` so service
  restarts (`KillMode=control-group`) don't kill the Host Shell's tmux; falls back without
  `systemd-run`.
- `localAgent.js` — Host Shell stand-in for the status probe, shaped like a box probe and parsed
  by `status.js`'s own allowlisting parsers. `LOCAL_BOX_ID` is declared here to keep node-pty
  out of the poller's import chain.
- `uploads.js` — paste/drag-drop uploads: filename allowlist, remote
  `~/.tmuxifier-uploads/` writer (24h self-prune). Route `POST /api/upload`
  (`TMUXIFIER_UPLOAD_MAX_MB`).
- `tmuxInject.js` — pane-aware path injection: `#{pane_current_command}` first (idle shell or
  `claude*`), screen heuristics as fallback; types via `send-keys -l`, never auto-Enter; busy
  panes get a `display-message`. Exports `NAMED_KEYS`, `sanitizeSendText`, `classifyPaneState`.
- `knownHosts.js` — best-effort `ssh-keygen -R`; called only on verified deprovision, a fresh
  provisioned IP, readdress (new address + released old IP literal), or explicit
  `POST /api/boxes/:id/forget-hostkey`.
- `boxRemoval.js` — shared cleanup for removal and verified deprovision.

### Setup jobs and the Claude stack

- `setupManager.js` / `setupStore.js` — persisted, pollable, resumable on-box setup over the
  ControlMaster (`BatchMode`). Statuses `running`/`done`/`error`/`needs-interactive`/`interrupted`/
  `superseded`; `running` reconciles to `interrupted` on restart. `needs-interactive` records
  `job.needs`: `'sudo'` (password prompt) or `'ssh'` (`Permission denied (publickey,password)` —
  a key-only denial stays `error`). Phase order after the install script: `seeding` → `statusline`
  → `agent-hooks` → `voice-link` → `script` → `ensureSession` (last). The Claude phases are all
  gated by the one `claude` tools selection (a stale bundle's `claudeStatusline` flag still
  counts). `streamRemote` is shared by the install run and the script phase; only the install
  run sniffs stderr for prompts. Password-only boxes work only while a ControlMaster is alive.
- `aiAuthSeed.js` — opt-in copy of the host's Claude (`TMUXIFIER_CLAUDE_OAUTH_TOKEN`) / Codex
  (`~/.codex/auth.json`, never stored) credentials. Secrets travel stdin-only — never in script
  text, argv, logs, or responses. `status()` serves `GET /api/ai-auth/status`.
- `claudeStatusline.js` / `claudeAgentHooks.js` — push `src/server/assets/claude-statusline.sh`
  and `tmuxifier-agent-hook.sh`. Script text interpolates **nothing** (files arrive on stdin);
  the box decides via `command -v claude`; `settings.json` is merged in place (jq → node →
  python3), hooks remove-then-append so reruns are idempotent and the operator's hooks survive.
  The hook writes `<session>:<state>:<epoch>` markers under `~/.tmuxifier-agent/`, the **sole**
  source of agent state. Its background-work gate (`busy/<session>/` tokens: `sub.` bracketed by
  SubagentStart/Stop with a 120min TTL, `bg.` from PreToolUse `Bash` with a ~2min TTL) keeps
  `Stop`, `idle_prompt` and `agent_completed` from reading `waiting` while background work runs; a
  `<task-notification>` resume clears only `bg.` tokens, the operator's own prompt clears all.
  Fails open. Unit tests have twice been green while this was broken live — test against a real
  event trace.
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

### Status and health

- `status.js` — per-box probes with in-flight coalescing. Reports sessions, active-pane command,
  `#{window_activity}` (the output clock — **not** `#{session_activity}`, a key-input clock), box
  clock, metrics, distro (`/etc/os-release` read with shell built-ins under the probe's bare PATH),
  agent markers (`parseAgentMarks`), and windows (`list-windows -a`, ≤200 rows, name field last).
  `cleanWindowName` strips C0/C1 and bidi controls; `__NO_TMUX__` matches as a whole line.
- `statusPoller.js` — the single server-side poll loop (`statusPollMs`) behind `/api/status`, so
  SSH volume is independent of open tabs; `probeOne` for on-demand refresh. Folds the Host Shell
  into history as `__local__` without putting it in the snapshot.
- `healthHistory.js` / `healthEventsStore.js` — rolling samples per box and edge-triggered events
  (down/up/needs-auth/threshold/agent-input/agent-done) in `data/health-events.json`; agent events
  are suppressed while the session is attached. Agent state is hook-only; `agentPresent` (pane
  based) only guards agent-done. `onEvent(cb)` is the push seam (`fcmPush.js`); browsers poll
  `GET /api/health/events`.

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
  validates slug shape only; the client normalizes unknown ids. `null` = never set. Fails open.

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
  `paneHeader.ts` (view-model: chip precedence pane-state > connection > agent, agent chip only
  when the pane is on the box's configured session; session/window targets; `targets: null` in
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
- **Voice** — `wavEncode.ts` (16 kHz mono WAV, so no ffmpeg), `voiceRecorder.ts`,
  `voiceWorklet.js` (real asset, keeps CSP `script-src 'self'`), `pcmStream.ts`, `voicePress.ts`
  (press reducer: a `claude` verdict links, else dictates), `voiceLink.ts`, `voiceUi.ts`
  (`evaluateVoice`, Ctrl+Shift+Space hotkey swallowing the whole chord), `voice.ts`.
- **Dashboard** — `dashboard.ts` (standby dashboard when no pane is docked; polls only while
  mounted; fleet cards are a spec sheet, not live gauges), `truenasCard.ts`, `unifiCard.ts`,
  `immichCard.ts`, `serviceIcon.ts` (always `<img>`, hides on error), `sparkline.ts`,
  `healthEvents.ts`, `notifyPrefs.ts`.
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
  Proxmox, Passkeys, Devices, Voice, Notifications, Appearance), one `settings*.ts` per tab,
  `settingsForm.ts`, and fetch layers `netbox.ts`, `devices.ts`, `passkeys.ts` (also
  `evaluateOrigin`, shared by login and Settings).

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

- ESM everywhere (`"type": "module"`); Node 20+. Server is plain `.js`; web client is `.ts`.
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

**Login paths.** Password mode mounts `POST /api/login`; OAuth mode mounts `/api/auth/google/*`
instead (hand-rolled OIDC: state cookie + PKCE, server-to-server token exchange, exact-email
allowlist; the id_token is trusted because it comes straight from Google's token endpoint).
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
  enumeration). In OAuth mode a passkey never consults `TMUXIFIER_ALLOWED_EMAILS`, so removing an
  email does **not** revoke that user's passkey — remove it in Settings → Passkeys. Enrollment
  requires an authenticated session. Challenge storage is bounded per client address, so a
  many-address attacker can still evict challenges (same residual limit as the rate limiter).
- **"Require a passkey"** (`passkeyOnly`) disables password and Google sign-in. Arming requires a
  fresh successful assertion in the arming browser and a usable RP id (409 when it is `null`,
  i.e. IP-derived, or doesn't match the enrolled credentials); removing the last credential
  disarms it; `TMUXIFIER_PASSKEY_ONLY=off` in `.env` is the break-glass (takes effect on restart).
- **Device tokens** (Android app, MCP): enrollment uses the password (403 under passkey-only, 501
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
  `dashboard.md`, `fleet-and-health.md`, `proxmox.md`, `android-app.md`, `mcp.md`, `privacy.md` —
  living user-facing guides; a feature change updates the matching guide.
- `docs/DEPLOY.md` + `deploy/tmuxifier.service` — systemd deployment (no secrets in the unit;
  `HOME` set so ssh children find `~/.ssh`).
- `DESIGN.md` — visual authority for the Instrument (root) theme and the themes engine's token
  contract. Read it before changing anything the operator looks at.
- `PRODUCT.md` — what Tmuxifier is for and who it is for.
- `AGENTS.md` — this file for general coding agents (kept in sync with CLAUDE.md).
- `docs/superpowers/`, dated `docs/*-review-*.md` and `docs/feature-suggestions-*.md` — point-in-time
  records; don't rewrite them, add a new dated doc.
