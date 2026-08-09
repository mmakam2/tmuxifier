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
- `data/` (gitignored) — `boxes.json`, `fleet-jobs.json` (Fleet Command history),
  `fleet-scripts.json` (Fleet Command's saved scripts — plain text, not encrypted), `proxmox.json`
  (Proxmox host profiles with **encrypted** API tokens, SSH management keys, and an optional root
  password — all AES-256-GCM sealed — plus container presets), `netbox.json` (NetBox integration
  settings with an **encrypted** API token), `provision-jobs.json` (provision history),
  `setup-jobs.json` (server-side box setup job history), `proxmox-lifecycle-jobs.json` (guest
  power/deprovision job history, covering both LXC containers and QEMU VMs), `services.json` (standby-dashboard service tiles; a credentialed tile's
  secret — a Pi-hole app password or a TrueNAS/UniFi/Immich API key — is **encrypted**, so unlike
  the rest of the file it never appears in the clear, and switching a tile between credential
  kinds drops it rather than replaying one product's credential at another), `health-events.json` (in-app health event log),
  `ui-settings.json` (cross-device UI preferences — the theme and working-agent animation
  picks; nothing secret, unlike most of its neighbours),
  `auth-state.json` (the logout session-revocation watermark), `passkeys.json` (enrolled WebAuthn
  credentials, the pinned relying party id, and the passkey-only flag — public keys only, so
  unlike `proxmox.json`/`netbox.json` nothing in it is encrypted, though it's still written
  `0o600`), `devices.json` (Android app device tokens — SHA-256 digests only, the token itself is
  never stored; FCM registration tokens; per-device notification toggles), scraped service
  favicons under `data/icons/`, and SSH ControlMaster sockets under `data/cm/`.
- `vendor/` (gitignored) — the whisper.cpp checkout, its build output, and the downloaded speech
  model, all created by `npm run setup-voice`. Together they take up roughly 1.2 GB;
  `rm -rf vendor/whisper` reclaims it. Also `vendor/icons/`, the service-logo catalog written
  by `npm run fetch-icons` (a few hundred KB); deleting it costs the catalog, not the feature —
  services fall back to their own scraped favicons.

When adding a new config knob or persisted file, keep it under the repo folder by default.
Don't introduce dependencies on `$HOME`-level state other than the user's existing SSH setup.

Any file that must hold real secrets or PII to run locally is **gitignored and ships with a
placeholder counterpart**, so contributors get the shape without the data: `.env` → `.env.example`;
`config.json` → the same keys in `.env.example` (camelCase); `tls/` → generation steps in
`docs/DEPLOY.md`; `data/voice.json` (voice enable flag + model choice), `data/voice-jobs.json` (whisper install job history), `data/boxes.json` → created at runtime (boxes are added via the UI, or imported
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
npm run test:e2e     # playwright (spins up an isolated sshd-backed box; see test/helpers/localBox.js)
npm run setup-voice  # headless equivalent of Settings -> Voice: builds whisper.cpp + downloads a pinned model into vendor/, records the choice in data/voice.json
npm run fetch-icons  # downloads the pinned service-logo catalog into vendor/icons/ (one-time; the running server never contacts the CDN)
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
- `TMUXIFIER_AUTH_MODE` is `password` (default) or `oauth`; **these two remain mutually
  exclusive with each other** — exactly one is active. `google` is still accepted as a legacy
  alias for OAuth mode. A passkey is a separate, additive third login path mounted in **both**
  modes regardless of `TMUXIFIER_AUTH_MODE` — see `webauthn.js` below and the Security notes.
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
- `jsonFile.js` — shared atomic JSON persistence for `data/*` files: writes land in a temp file
  and are rename()d into place (a crash never truncates), an unparseable/wrong-shape file is
  quarantined to `<file>.corrupt-<timestamp>` instead of being silently read as empty, and files
  are written `0o600`. The store modules build on it.
- `debouncedJsonStore.js` — the shared debounced-write store behind the five persisted job
  managers (`fleetStore`/`setupStore`/`provisionStore`/`proxmoxLifecycleStore`/`voiceInstallStore`
  are one-line wrappers); `whenIdle()` is the graceful-shutdown flush seam, and every one of the
  five is wired into it — a store constructed inline could not be, which is how `voiceInstallStore`
  came to be left out and a finished install reloaded as `interrupted` after a SIGTERM.

  The stranded NetBox sentence that used to trail this entry belongs to `netboxApi.js`:
  `GET /api/netbox/summary` (60s in-process cache) feeds the dashboard's NetBox utilization
  readout — every IPv4 prefix NetBox knows (first 100), one row each.
- `jobOrder.js` — `newestFirst`, the shared newest-first job comparator (id tie-break, a valid
  total order) used by the setup/provision/lifecycle managers.
- `pveTask.js` — `pollPveTask`, the shared PVE task poller (log tailing, consecutive-failure
  tolerance, deadline) used by the provision and lifecycle managers.
- `shutdown.js` — `registerShutdownFlush`: SIGTERM/SIGINT handler that flushes the debounced
  job stores before exit, so a deploy restart can't lose a just-finished job's final save.
- `auth.js` — scrypt password hashing, signed-cookie options (`COOKIE_NAME`), and the session
  value helpers (`sessionValue`/`sessionValueValid`): the cookie embeds its issue time and is
  rejected server-side after `SESSION_TTL_SECONDS`, so a captured cookie can't authenticate forever.
- `rateLimit.js` — `createLoginRateLimiter`: per-IP login lockout with a bounded map (overflow
  evicts the oldest window, never clears everyone).
- `googleAuth.js` — dependency-free Google OIDC helper: authorization-code flow, PKCE, id_token
  payload decoding, and exact-email allowlist checks.
- `webauthn.js` — dependency-free WebAuthn verification, in the spirit of `googleAuth.js`: a
  minimal CBOR reader (only ever fed a registration's attestation object, or a previously
  validated stored public key being re-decoded at login — never attacker-supplied bytes at
  login), COSE→`KeyObject` import (ES256/RS256/EdDSA), `makeOriginCheck`, `verifyRegistration`,
  and `verifyAssertion` (login). Attestation `none` only: any other format is refused rather than
  accepted unverified.
- `passkeyChallenges.js` — `createPasskeyChallenges`: bounded, single-use, 120s WebAuthn challenge
  store. Eviction is two-layered, not simple oldest-first: a caller already at its own quota
  (default 3) evicts its own soonest-expiring entry first, and only once the whole store is full
  does it evict from whichever owner currently holds the most entries — so one flooding source
  can only ever evict its own in-flight challenges, never a stranger's, short of presenting enough
  distinct owner identities (e.g. source IPs) to out-crowd them, the same residual limit as
  `rateLimit.js`'s per-IP bucket. The token rides a signed, httpOnly, `SameSite=strict`
  `tmuxifier_pk` cookie.
- `passkeyStore.js` — `data/passkeys.json` CRUD plus the `passkeyOnly` flag and the pinned relying
  party id. Public keys are not secrets, so nothing here is sealed (unlike `proxmox.json`/
  `netbox.json`), but the file is still written `0o600` via `jsonFile.js`. The RP id is pinned by
  the first enrollment and cleared when the last credential is removed; removing the last
  credential also disarms `passkeyOnly`. A corrupt store fails **open** (reads as empty, which
  also disarms `passkeyOnly`) by design — failing closed would brick fleet access on a disk
  glitch, and whoever can corrupt this file can already read the password hash from `.env` on the
  same disk.
- `deviceStore.js` — device-token auth for the Android app: `data/devices.json` CRUD in the
  `passkeyStore.js` mold (withLock mutex, `0o600`, corrupt-fails-open). Stores SHA-256 digests of
  32-byte random tokens — fast digest on purpose: the entropy is the defence, and scrypt would tax
  the app's ~1s pane polling. `verify` compares with `timingSafeEqual`; `touch` throttles lastSeen
  writes to once a minute. Enrollment is password-authenticated through the same `rateLimit.js`
  bucket as login; revocation (Settings → Devices) takes effect on the device's next request.
- `fcmPush.js` — the first subscriber the `healthHistory.onEvent` seam ever had: agent-input/
  agent-done events become FCM HTTP v1 pushes to enrolled devices. Dependency-free in the
  `googleAuth.js` mold (RS256 JWT via `node:crypto`, cached OAuth2 token). `TMUXIFIER_FCM_CREDENTIALS`
  unset = feature off. Failures are logged, never propagated; an UNREGISTERED response clears that
  device's FCM token, never its auth.
- `server.js` — Fastify app: login rate-limiting, REST under `/api/*`, and the `/term` WebSocket.
  Box setup routes: `POST /api/boxes/:id/setup` (start), `GET /api/setup` (list), `GET
  /api/setup/:id` and `GET /api/boxes/:id/setup` (poll one/by-box). `GET /api/ai-auth/status`
  reports host-side AI-auth seed readiness for the provision forms. The `/term?mode=provision`
  WebSocket is now the on-demand **interactive fallback** for sudo-password boxes — it reports its
  exit code via `setupManager.markInteractiveResult` and no longer rolls back/removes a box on
  failure. Passkey routes (`GET/POST/DELETE /api/passkeys*`, `POST
  /api/auth/passkey/login/begin|finish`) mount unconditionally in **both** auth modes — passkey is
  a third, additive login path, not a third value of `TMUXIFIER_AUTH_MODE`.
  The `/term` WebSocket refuses a normal box terminal (close `1008 'setting up'`) while that
  box's setup job is `running`, so a shell can never start with an environment predating the
  seeded credentials and installed tools; `mode=provision` stays ungated so the interactive
  finish still works. `PUT /api/boxes/:id/proxmox` writes the link's `kind` from the guest
  `proxmoxInventory.listNodeGuests` actually found at that host/node/vmid, never from the request
  body — a client cannot be trusted to declare what type a vmid is, and trusting it once was a
  real mid-flight defect: a request that lied about `kind` would have stored a link that then read
  every subsequent poll as a permanent kind `'mismatch'` against the cluster's own truth.
  `requireAuth` is async and accepts either the signed session cookie or an `Authorization: Bearer
  <device token>` header verified via `deviceStore.verify` (`req.deviceId` set on that branch) —
  cookie first, since that keeps the common browser request synchronous, then the device-token
  fallback for the Android app. `POST /api/devices/enroll` deliberately does not go through
  `requireAuth`: it authenticates with the password directly, over the same `rateLimit.js` bucket
  as `/api/login`, so it can't become a password oracle; it 403s under armed passkey-only and 501s
  in OAuth mode (v1 is password-mode only). `GET /api/boxes/:id/pane` is a read-only tmux snapshot
  for the app — `capture-pane` over the ControlMaster with a bounded `-S` scrollback, never
  attaching — merged with the box's latest agent-state sample from `healthHistory`. `POST
  /api/boxes/:id/keys` accepts exactly one of literal text (sent via `send-keys -l` after
  `tmuxInject.js`'s `sanitizeSendText`) or a named key drawn from its closed `NAMED_KEYS`
  allowlist, never both.
- `store.js` — `data/boxes.json` CRUD; normalizes/validates boxes; exports/imports the box list as
  a versioned JSON file (`exportBoxes`/`importBoxes`; import re-mints ids and skips dup/unsafe entries).
  A Proxmox link carries a `kind` (`'lxc'` | `'qemu'`); an absent one defaults to `'lxc'` in
  `readAll()`, the single chokepoint every reader (`listBoxes`/`getBox`/`exportBoxes`, plus every
  mutation's own read half) goes through, so a link written before VM support migrates by asserting
  what is already true rather than by rewriting the file — `boxes.json` itself is never touched, the
  default is just re-derived on every read, same as `normalize()`'s own default on write.
- `sshCommand.js` — builds `ssh` argv for attach/probe; **all box fields are validated by
  `assertBoxSafe` and never shell-interpolated unquoted**. Touch this carefully (command-injection
  surface). Includes ControlMaster multiplexing args. `buildSetupArgv` is the non-interactive
  (`BatchMode`) box-setup argv, delegating to `buildProbeArgv`.
- `sshRun.js` — run one-shot ssh probes; `sshStream` (streaming `spawn('ssh')`, non-buffered
  stdout/stderr) is what the setup manager tails.
- `boxActions.js` — `createBoxActions`: per-box SSH operations over the shared ControlMaster —
  ensure/install tmux, selected shell frameworks, and the curated provision-time tool catalog
  (`TOOL_IDS`/`resolveTools`: system upgrade, curl, git, gh, node/npm, bubblewrap, and the
  Codex/Claude/Antigravity CLIs — ids validated server-side, nothing user-typed reaches the
  script), the non-interactive `execCommand` that Fleet Command runs, and ControlMaster
  liveness/stale-socket reaping (`isMasterAlive`/`reapStaleMaster`).
  `buildFrameworkUpdateClamps` disables every shell framework's self-updater and runs on **every**
  setup, not just when a framework is installed — the box carrying a hand-installed oh-my-* is
  exactly the one that never ticks a checkbox. Each clamp is guarded by evidence the framework is
  present, so a bare setup edits only rc files that actually source one (a deliberate widening of
  "a bare setup mutates nothing"). The oh-my-zsh guard is **anchored** (`^zstyle`) and that anchor
  is load-bearing: every stock install writes a `.zshrc` containing oh-my-zsh's own *commented*
  `# zstyle ':omz:update' mode disabled` template line, and the original unanchored guard matched
  that comment, concluded the clamp was already applied, and never inserted the real setting — so
  the clamp never fired on any box. oh-my-tmux needs it most: it ships
  `tmux_conf_update_plugins_on_launch`/`_on_reload` as `true`, i.e. a `git fetch` per tmux launch
  and per config reload. Inserting before the source line also settles precedence over an
  operator's own `mode auto`. Deliberate updates are documented in README (both shell updaters are
  shell functions, so Fleet Command must call `tools/upgrade.sh` directly).
- `uploads.js` — terminal file uploads (paste/drag-drop): filename allowlist,
  stored-name uniquifier, the remote `cat > ~/.tmuxifier-uploads/…` script builder
  (24h self-prune), and the local-shell file writer. `boxActions.uploadFile` pipes
  the bytes over the ControlMaster via `sshRunStdin` (`sshRun.js`); the route is
  `POST /api/upload` with `TMUXIFIER_UPLOAD_MAX_MB` as `bodyLimit`.
- `tmuxInject.js` — pane-aware upload injection: the primary signal is tmux's
  `#{pane_current_command}` — an idle shell process (`bash`/`zsh`/`sh`/`fish`/…) or a
  `claude`/`claude-*` process — with screen-capture heuristics (Claude TUI markers, a
  trailing prompt-char regex) as fallback when the command name doesn't resolve it. At
  a Claude Code or shell prompt it types the quoted uploaded path via `tmux send-keys
  -l` (busy panes get a `display-message` instead; never auto-Enter, no `/image` — it
  doesn't exist). `boxActions.injectUploadPath` runs it over the ControlMaster;
  `injectLocalUploadPath` covers the `__local__` terminal's local tmux session.
- `voiceStore.js` / `voiceInstall.js` / `voiceInstallStore.js` / `voiceDownload.js` / `voicePaths.js` —
  voice dictation, stage 2. `data/voice.json` is the authoritative record of whether voice is on
  and which model is selected: it is read per request, so a Settings change applies without a
  restart, unlike `.env` which is parsed once at boot. `voiceInstall.js` is the single-flight
  persisted install job (preflight disk check, apt, pinned clone, RAM-capped build, verified
  download, then enable) with a rolling capped log, mirroring `setupManager.js`;
  `voiceInstallStore.js` is its debounced `data/voice-jobs.json` persistence. `voiceDownload.js`
  streams and hashes incrementally, writing to a temp path and renaming only after the pinned
  SHA-256 matches, so an unverified blob never occupies the real path. `voicePaths.js` holds the
  pure precedence rules: `TMUXIFIER_WHISPER_BIN`/`MODEL` are escape hatches that win when set and
  are surfaced in the UI as pinned rather than silently overriding the picker.
- `voiceText.js` / `voiceCatalog.js` / `voiceEngine.js` — voice dictation: pure transcript
  normalization (newline collapse is load-bearing — a newline through `send-keys` is Enter),
  the pinned model allowlist with SHA-256 digests (the chokepoint that keeps no user-supplied
  URL or path from reaching a download), and the lazily-spawned whisper.cpp server with an
  idle timeout. `POST /api/voice` transcribes a browser-recorded WAV and types the result into
  the pane via the same `injectVia` guard uploads use. Audio never leaves the host.
- `uiSettingsStore.js` — `data/ui-settings.json` CRUD for the cross-device UI preferences (the
  theme and the working-agent animation), served by `GET`/`PATCH /api/ui-settings`. Read per
  request like `voiceStore.js`, so a change applies without a restart. Deliberately
  **catalog-agnostic**: the theme and variant catalogs live in the web bundle, so the server
  validates SHAPE only (a `^[a-z0-9-]{1,32}$` slug) and the client normalizes an unknown id to
  its default — renaming a theme in code can never brick the server. A `null` value means
  "never set", which is what lets the client tell a fresh install from an explicit choice (the
  clawd migration). Nothing here is secret, so nothing is sealed; the file is still written
  `0o600` through `jsonFile.js`, and a corrupt one fails **open** to nulls (cosmetic data, and
  `jsonFile.js` has already quarantined the original).
- `localShellActions.js` — `createLocalShellActions`: provisions the optional local shell
  (`localShell` = `none`/`omz`/`omb`) that backs a terminal on the Tmuxifier host itself.
  `installAgentHooks()` puts the same Claude Code agent-state hook a box gets onto this host by
  handing `createAgentHooksPusher` (`claudeAgentHooks.js`) a local `/bin/sh` stdin transport
  (`runLocalScriptStdin`) in place of its ssh one — installer script, hook asset, result shape and
  skip/error mapping all stay the pusher's, so the SSH and local install paths cannot drift. It is
  triggered by the optional `claudeHooks` flag on `PATCH /api/local-shell`, strictly `=== true`:
  absent or `false` touches nothing, unchecking never uninstalls, the install runs only after the
  shell choice has already persisted, and a failed install is reported on the response
  (`{ ok: true, agentHooks }`) rather than failing the request.
- `localAgent.js` — `createLocalAgentSampler`: the Host Shell's stand-in for the SSH status probe.
  Reads this host's own tmux sessions (`tmux ls -F STATUS_FMT` via `execFile`) and its
  `~/.tmuxifier-agent/` markers, shaping them exactly like a box probe result so
  `healthHistory.sampleOf` and everything downstream — sidebar badge, pane chip,
  `agent-input`/`agent-done` events — works unchanged. Both readings go through `status.js`'s own
  allowlisting parsers (`parseTmuxSessions`/`parseAgentMarks`): a marker file is input, and being
  written locally rather than fetched over ssh does not make it trusted. The sample is always
  `reachable` and never carries metrics, so `classifyTransitions` can structurally only ever emit
  the agent edges for it — never down/up/needs-auth/threshold — and `sample()` never rejects, since
  a sampler failure must not disturb the poll loop. `LOCAL_BOX_ID` (`'__local__'`) is declared here
  rather than imported from its equal `LOCAL_GROUP` in `sessions.js`, to keep node-pty out of the
  poller's import chain.
- `localTmuxScope.js` — `createLocalTmuxScope`: restart-survival for the Host Shell's tmux.
  A tmux server auto-started by the attaching pty client stays in tmuxifier.service's cgroup
  (daemonizing reparents to pid 1 but never leaves a cgroup), so systemd's default
  `KillMode=control-group` killed it — and every pane in it — on each service restart.
  `ensure(shell)` runs before `openLocal`'s attach (`server.js` awaits it in the `/term`
  local branch): `tmux has-session -t =local` (exact match — a bare name prefix-matches),
  else the session is created detached under `systemd-run --scope --collect`, landing the
  server in its own transient scope that restarts never touch — the remote-box model, where
  ssh dies and the box's tmux lives on. Best-effort and single-flighted: it never rejects,
  a host without `systemd-run` (ENOENT, remembered) falls back to the old auto-start path,
  costing restart-survival but never the terminal.
- `sessions.js` — PTY lifecycle. A PTY is keyed **per viewer**, not per box (`terminalKey(boxId,
  clientId)` / `localKey(clientId)`), so every browser gets its own ssh and its own `tmux attach`.
  Keying by box id alone made Tmuxifier a *mirror* rather than a multiplexer: one screen drawn at
  one size fanned out to every browser, with whichever client resized last deciding that size, so
  any viewer with a smaller window received cursor moves past its own last row/column and rendered
  smeared, duplicated text. Sizing across clients is tmux's own `window-size` (default `latest` —
  most recently used client wins), which is why `buildAttachArgv` must **not** pass `-D` and why
  Tmuxifier never writes that option into the operator's tmux config.
  The client id comes from the browser (`sessionStorage`, so it survives a reload but not a new
  tab) and is charset/length-checked by `safeClientId`, falling back to one `shared` id — which is
  exactly the old behaviour, so a stale cached bundle keeps working. Because one box now spans
  many keys, callers act on **groups**: `entry.group` is the box id (`LOCAL_GROUP` for the host
  shell) and `closeGroup(group, kind?)` replaces the old per-key closes — `kind: 'terminal'`
  narrows it so editing a box's connection fields can't abort an interactive setup finish on the
  same box. `hasLiveSessionForBox` asks the group, covering every viewer plus the provision PTY.
  `maxViewersPerBox` (default 8) bounds browser-minted ids; an unwatched PTY sitting in its grace
  window yields its slot rather than refusing a real viewer, or a few opened-and-closed tabs would
  lock a box out for the whole `graceSeconds`.
  Listeners are refcounted and a `graceSeconds` window keeps a dropped PTY alive for seamless
  reconnects, then it's killed while the on-box tmux session keeps running. `attach` replays the
  last 64KB of output so a reattaching client isn't looking at a blank screen, and that replay is
  **prefixed with a reset+clear** (`REPLAY_CLEAR`): a reconnecting client's emulator was never
  cleared, so writing the buffer straight onto the screen it already holds re-runs that window's
  scrolls and absolute cursor moves over the cells they produced. The SGR reset leads because
  `CSI 2J` fills with the *current* background colour. Do not rely on the attach size-nudge to
  clean this up: it only makes tmux repaint cells tmux thinks changed, which is why the client's
  own `[disconnected…]` notice could survive a reattach.
- `status.js` — per-box reachability/status probes; coalesces concurrent probes of the same box
  (in-flight de-dup) so multiple pollers don't fan out duplicate SSH connections. Each probe also
  reports every tmux session's active-pane command and last-output time, plus the box's own
  clock, which `healthHistory.js` uses to derive per-session agent idle state without any extra
  SSH round trip. That timestamp is `#{window_activity}` and deliberately **not**
  `#{session_activity}`: tmux bumps the session one on key input and on attach but never on
  output alone, so a claude thinking for minutes without a keystroke read as idle while it was
  busy, and a bare attach fabricated an active reading that later decayed into a false
  agent-input. The `__META__` health line carries the box's distro identity
  (`osId`/`osVer`) alongside the numeric metrics — read out of `/etc/os-release` with `read`/`case`
  shell built-ins rather than awk, because the probe runs under whatever PATH the box's
  non-interactive shell provides, and the file is **read, never sourced**. These are the only
  non-numeric `parseMeta` fields, so they carry their own allowlist (a bare token, ≤32 chars):
  `/etc/os-release` is content from the box and the value reaches the UI. The probe also emits
  one `__AGENT__` line per `~/.tmuxifier-agent/` marker file (written by the Claude Code hook
  `claudeAgentHooks.js` pushes), allowlisted by `parseAgentMarks` with the same input distrust —
  a closed `working`/`waiting` state set and a numeric timestamp, capped at 200 bytes on the box.
- `statusPoller.js` — single server-side poll loop: probes every box on an interval
  (`statusPollMs`) and caches the snapshot `/api/status` serves, so status SSH volume is
  independent of how many dashboard tabs are open. An optional `localAgent` sampler
  (`localAgent.js`) rides the same loop for the host shell: its reading is folded into
  `history.record()` alone as a `__local__` pseudo-box labelled `Host Shell`, carrying the
  `localSession` name as its `sessionName`. The record arguments are local copies built beside the
  snapshot rather than in it, so `/api/status` never contains `__local__`.
- `servicesStore.js` / `serviceCheck.js` / `serviceChecker.js` — the standby dashboard's
  service tiles: validated CRUD over `data/services.json` (each tile carries a `section` —
  services|infrastructure — plus a free-text `group` category within it, a check kind of
  http|tcp|pihole|truenas|unifi|immich|none, and an optional `icon` slug — see `iconResolve.js`), the dependency-free HTTP/TCP
  liveness engine (TLS errors tolerated — reachability probe, not a security boundary),
  and the interval sweep (`TMUXIFIER_SERVICE_POLL_MS`, min 5s) whose cached snapshot
  `GET /api/services/status` serves — check volume is independent of open tabs.
  A `pihole` tile also carries an AES-256-GCM-sealed app password (redacted to `hasPassword`
  on every read; `getServiceSecret` is the sole decrypting path) and renders as a double-width
  stat card rather than a lamp. A Pi-hole that answers but rejects the password resolves to a
  distinct `auth` state on the violet `.dot.auth` lamp, not `down` — a rotated password is not
  an outage.
  A `truenas` tile carries a sealed API key and a plaintext `username` (TrueNAS API keys are
  user-linked from 25.04, and `auth.login_ex` needs the account name), and renders as a
  pool-row card. Its URL must be **https**: TrueNAS permanently revokes any user-linked API key
  presented over plain HTTP, so an `http:` target is refused at validation time rather than
  offered as an opt-out.
- `piholeApi.js` / `piholeRegistry.js` — the `pihole` service check, in the mold of
  `netboxApi.js`: a dependency-free Pi-hole **v6** REST client (`POST /api/auth` trades an app
  password for a session id carried in `X-FTL-SID`) reading `stats/summary`, `info/version`,
  `info/system` and `dns/blocking` in one pass. v6 caps concurrent sessions, so the client holds
  exactly one and reuses it until 80% of its advertised validity — minting one per 30-second
  sweep would exhaust the pool within the hour — single-flighting the authentication,
  re-authenticating exactly once on a mid-flight `401`, and revoking with `DELETE /api/auth` on
  shutdown. `piholeRegistry.js` owns one client per service id, rebuilding it when the API base,
  app password, or TLS mode changes and closing the sessions of services that have gone away.
  Read-only: no write endpoint is ever called.
- `truenasApi.js` / `truenasRegistry.js` — the `truenas` service check. TrueNAS deprecated its
  REST API in 25.04 and removed it in 26, so this is a JSON-RPC 2.0 client over a single
  persistent WebSocket to `wss://<host>/api/current` (the one place the repo uses `ws` outside
  Fastify). It authenticates with `auth.login_ex` / `API_KEY_PLAIN` — never
  `auth.login_with_api_key`, removed in v27 — and never negotiates the mechanism, because the
  server's advertised list is unauthenticated and a downgrade would be strippable. One sweep is
  three concurrent calls on the open socket (`pool.query`, `system.info`, `alert.list`),
  correlated by JSON-RPC id; an expired session re-logs-in exactly once and replays, and a
  stale socket's late `close` cannot tear down its replacement (teardown is guarded by socket
  identity). `close()` calls `auth.logout`. Read-only: no mutating method is ever called.
- `unifiApi.js` / `unifiRegistry.js` / `unifiMetrics.js` — the `unifi` service check: a
  dependency-free client for the UniFi Network **Integration API v1**
  (`/proxy/network/integration/v1`, `X-API-KEY`) over `node:https`, in the mold of
  `netboxApi.js`. **GET only** — no code path issues another verb, so the key's blast radius
  stays at reads even though UniFi's local keys inherit their admin account's role. One refresh
  is ten requests (devices, clients, networks, plus statistics per device), so the client holds
  its own 30s snapshot TTL and serves the cache in between: the cost of a tile is bounded by the
  client rather than by however the operator has tuned `TMUXIFIER_SERVICE_POLL_MS`. TLS is
  three-way (`verify`/`pin`/`insecure`) via the shared `tlsPin.js` helpers, and pin mode verifies
  before the key is written, so a mismatch never puts the credential on the wire.
  `unifiMetrics.js` is the pure shaping half — `classifyDevice` leads with the **model prefix**
  rather than the feature list, because a UCG Max advertises `features: ["switching"]` and is
  otherwise indistinguishable from a switch. The `/networks` endpoint carries no per-client VLAN,
  so the card counts networks rather than breaking clients down by them.
- `iconResolve.js` / `iconCatalog.js` / `iconStore.js` — service tile icons, replacing the
  removed free-form Nerd Font `glyph` field. `iconResolve.js` is the pure half: the ordered
  slug candidates for a service (check kind first — `unifi`/`truenas`/`pihole` are declared
  rather than guessed — then the name, then the URL hostname, with IP literals dropped since an
  address is not a product) and the favicon `<link>` scan. `iconCatalog.js` is the pinned slug
  list and the chokepoint that keeps no user-supplied string from reaching a download, in the
  mold of `voiceCatalog.js` — both halves of the CDN path, slug and extension, are closed
  allowlists. Deliberately **no** pinned digests, unlike `voiceDownload.js`: a logo is redesigned
  by its vendor from time to time, and pinning would turn every upstream refresh into a failed
  run. The catalog carries SVG **and** PNG because a fifth of upstream has no vector.
  `iconStore.js` is the only half that touches disk or the network: it walks the candidates
  against `vendor/icons/` (the catalog) then `data/icons/` (the per-service favicon cache), and
  scrapes a favicon best-effort on save **only when the catalog misses**. Every slug is
  re-checked against `ICON_SLUG` and the resolved path verified to stay inside its directory
  before any read. Served by the authenticated `GET /api/services/:id/icon` and
  `GET /api/icons/:slug` — dynamic routes, not a second static mount, because `wildcard: false`
  registers static assets at boot and a favicon scraped afterwards would be unservable until
  restart. They are also the only `/api/` responses that set their own `Cache-Control`
  (`private, no-cache` + ETag); `server.js`'s blanket `no-store` yields to a route that already
  decided, exactly as the security headers beside it do.
- `immichApi.js` / `immichMetrics.js` / `immichRegistry.js` — the `immich` service check: a
  dependency-free **GET-only** client for the Immich REST API (`/api/server/*`, `x-api-key`)
  over `node:https`, in the mold of `netboxApi.js`. One refresh is six concurrent GETs —
  about, storage, statistics, jobs, version-check and config — behind a 30s snapshot TTL, so
  a tile's cost is bounded by the client rather than by `TMUXIFIER_SERVICE_POLL_MS`. The
  load-bearing rule is that a **`403` is proof the server answered**: it degrades only that
  endpoint's readings (recorded in `metrics.denied` so the card can name the missing
  permission) and never fails the tile, while a `401` is `auth` and only a total transport
  failure is `down`. That is also why there is no `/api/server/ping` call — any HTTP response
  already establishes liveness. This is what makes a least-privilege scoped key a first-class
  configuration rather than a broken one. `immichMetrics.js` is the pure shaping half — it
  rolls fifteen job queues into one verdict, **names** paused queues rather than counting them,
  and keeps `statistics.usage` (the library) distinct from `storage.diskUseRaw` (the volume),
  which are different numbers that a single "size" figure would conflate. `/api/users` is
  deliberately never called: it returns email addresses, and `statistics.usageByUser` already
  carries the names the user row needs.
- `serviceClientRegistry.js` — the shared per-service API-client cache behind
  `piholeRegistry.js`, `truenasRegistry.js`, `unifiRegistry.js` and `immichRegistry.js`: one client per service id, rebuilt when the
  options that define it change (the fingerprint is taken over the whole options object, so a
  new option participates automatically), `retain` closing departed services, and a best-effort
  `closeAll` that a dead service cannot stall.
- `fleet.js` / `fleetStore.js` — `createFleetManager` runs one command across many boxes as a single
  persisted, pollable job (Fleet Command), fanning out at `fleetConcurrency`; `createFleetStore` is
  the debounced `data/fleet-jobs.json` persistence. A job also carries the optional `scriptName` it
  was launched from — a **frozen display label**, never resolved back against `fleetScriptsStore.js`,
  so renaming or deleting a saved script cannot rewrite what a past job says it ran (the same reason
  a target's `label`/`host` are frozen at creation). A blank or oversized value is dropped rather
  than rejected: provenance is a convenience and must never be able to fail a run.
- `fleetScriptsStore.js` — `data/fleet-scripts.json` CRUD for Fleet Command's saved scripts (name,
  optional note, body), in the mold of `servicesStore.js`: validation inside, mutations serialized,
  names unique case-insensitively, written `0o600`. Nothing here is sealed, unlike `proxmox.json`/
  `netbox.json` — a script body holds no credential class Tmuxifier manages, and encrypting it would
  imply a guarantee the feature cannot make, since the same text is persisted again in the job
  history. The body cap is deliberately the same 65536 the `/api/fleet/jobs` route enforces on
  `command`, so a script that can be saved can always be run. `getScript(id)` is the single-record
  read serving `setupManager.js`'s post-setup script phase, which resolves a selection by id at run
  time rather than snapshotting the body; a missing or malformed id reads as `null`, never a throw,
  because the caller turns that into a recorded skip.
- `setupManager.js` / `setupStore.js` — `createSetupManager` runs the on-box setup script (tmux +
  shell frameworks + tool catalog from `buildEnsureTmuxRemote`) as a persisted, pollable, resumable
  server-side job over the shared ControlMaster, streaming into a rolling capped log; statuses
  `running`/`done`/`error`/`needs-interactive`/`interrupted`/`superseded` (a stale
  needs-interactive job replaced by a newer run for the same box) — two stderr signatures flip a job
  to `needs-interactive` for an on-demand interactive finish, recording which credential it stalled
  on in `job.needs`: a sudo-password prompt (`needs: 'sudo'`) and ssh's own auth failure against a
  box whose sshd offers an interactive method, i.e. `Permission denied (publickey,password)`
  (`needs: 'ssh'`). The setup run is `BatchMode`, so it can never answer either prompt, but the
  interactive finish (`buildProvisionArgv`: `-tt`, no BatchMode) can. Matching the server-offered
  method list is deliberate: a key-only `Permission denied (publickey).` has no interactive method to
  fall back on and stays a hard `error`, so key-auth boxes keep their existing path. A password-only
  box is usable but second-class — every background caller (status poller, Fleet, uploads, seeding)
  is `BatchMode`, so it authenticates only while a ControlMaster is alive and reads unreachable
  after `controlPersist` expires. `running` jobs
  reconcile to `interrupted` on restart. Never removes a box on failure (keep-box + retry).
  On reaching `done` — from either the non-interactive run or an interactive finish — a job whose
  options asked for it seeds the box's AI CLI auth (injected `seed`/`getBox`) under a `seeding`
  phase, records the redacted per-target result on `job.seed`, and only then flips to `done`; a
  failed seed is recorded, never promoted to a job failure. The `statusline` and `agent-hooks`
  phases (injected `pushStatusline`/`pushAgentHooks`, see `claudeStatusline.js`/
  `claudeAgentHooks.js`) run next on the same terms — recorded on `job.statusline`/
  `job.agentHooks`, never promoted — both gated by ONE knob: the `claude` tools selection
  (strict consolidation, 2026-08-01; the legacy `claudeStatusline` flag from a stale bundle
  still counts, gaining old clients the hooks too). The box's tmux session is created
  **last**, by the injected `ensureSession` step (`buildEnsureSessionRemote`), strictly after the
  seed — a shell reads its rc files once at startup, so a session created earlier (as the setup
  script used to do) holds an environment with no seeded token in it. The setup script therefore
  runs with `createSession: false`, and attaching would create the session anyway
  (`new-session -A`), so a failed `ensureSession` costs a convenience, not the box.
  A `script` phase follows the Claude stack, gated on the setup options' `scriptId`: it resolves
  that id against `fleetScriptsStore` (injected `getScript`) and streams the saved Fleet Command
  script over the same transport as the install script, recorded on `job.postScript` and — like
  every phase before it — never promoted to a job failure. It runs strictly BEFORE `ensureSession`
  for the same reason the seed does: a shell reads its rc files once, at startup, so a script that
  edits them must land before the session's first shell. `scriptId` is only ever a LOOKUP KEY, the
  chokepoint discipline `iconCatalog.js`/`voiceCatalog.js` apply — nothing user-typed reaches a
  shell through it — while `scriptName` is a frozen display label on `fleet.js`'s own rule, never
  re-resolved, so a rename cannot rewrite what a past job says it ran. `streamRemote` is the shared
  spawn/log-append/coalesced-persist/handle-register/exit-code helper both the install run and the
  script phase call, so the two cannot drift; only the install run passes `onStderr` (it sniffs for
  password prompts — a script hitting sudo under BatchMode is a script failure, not a reason to
  park the job and block the box's terminal).
  `createSetupStore` is the debounced `data/setup-jobs.json` persistence (mirrors `provisionStore.js`).
- `healthHistory.js` / `healthEventsStore.js` — `createHealthHistory` keeps a rolling in-memory
  sample series per box (fed by the status poller after each snapshot swap) and derives an
  edge-triggered events log (down/up/needs-auth/threshold, persisted to `data/health-events.json`
  by `createHealthEventsStore`); served by `GET /api/health/series|events`. Agent state
  (`working`/`waiting`) for the box's configured session is **hook-only**: it comes exclusively
  from the `~/.tmuxifier-agent/` marker the on-box Claude Code hook writes (see
  `claudeAgentHooks.js`) — the old output-idle heuristic, its `'unknown'` state, the
  `agentIdleSec`/`TMUXIFIER_AGENT_IDLE_SEC` knob, and the anti-blip working-streak are all
  removed (2026-08-01), so a claude pane with no marker carries no agent state at all; the
  silent chip is the deliberate cue that the box needs a setup run with the Claude Code tool
  ticked (plus a claude restart). Presence stays pane-based
  as `agentPresent`, whose sole consumer is the agent-done edge — it keeps a one-poll marker gap
  (a claude restarting in place between SessionEnd and SessionStart) from reading as an exit.
  Emits edge-triggered `agent-input`/`agent-done` events — suppressed while that session is
  attached, since watching the terminal is its own notification. `onEvent(cb)` is the server-push
  delivery seam: `fcmPush.js` subscribes when `TMUXIFIER_FCM_CREDENTIALS` is set, turning these
  same events into FCM pushes to enrolled Android devices. Browser notifications still poll
  client-side rather than subscribing here, by `main.ts` polling `GET /api/health/events` and
  filtering by the kinds enabled in Settings → Notifications (`notifyPrefs.ts`).
- `secretBox.js` — AES-256-GCM seal/open for secrets at rest; key derived from `cookieSecret` via
  HKDF. Encrypts the persisted Proxmox secrets: the API token, any added SSH management keys, and
  the optional root password.
- `proxmoxValidate.js` — pure validators/parsers for Proxmox host/key/preset/provision input,
  including the link's `kind`: `assertProxmoxLinkInput` accepts it absent (defaulted downstream in
  `store.js`) or exactly `'lxc'`/`'qemu'`, and rejects anything else.
- `proxmoxStore.js` — `data/proxmox.json` CRUD for hosts, SSH keys, presets, and the optional root
  password; seals secrets on write and redacts them on read (`getHost(id,{withSecret})` is the only
  path that decrypts the token).
- `proxmoxApi.js` — PVE HTTP client over `node:https` with TLS fingerprint pinning, plus
  `inspectEndpoint`. The token never leaves the server. `startGuest`/`shutdownGuest`/`stopGuest`/
  `rebootGuest`/`destroyGuest`/`listGuests` are kind-parameterized — `kind` is their first argument
  and becomes a URL path segment (`/nodes/<node>/<kind>/<vmid>/...`) — so each one re-validates it
  against a closed two-value allowlist immediately before that interpolation, rather than trusting
  that every caller already checked; the same chokepoint discipline `voiceCatalog.js` and
  `iconCatalog.js` apply to their own allowlists. `createLxc` and `lxcInterfaces` stay LXC-only; VM
  provisioning is out of scope.
- `proxmoxParams.js` — pure preset → `pct`/LXC create-param mapping (`net0`, `ssh-public-keys`, …).
- `defaultKey.js` — reads the Tmuxifier host's own SSH public key to inject as the default Proxmox
  management key so provisioned containers trust Tmuxifier (override with `TMUXIFIER_PVE_DEFAULT_PUBKEY`).
- `provisionStore.js` / `proxmoxProvision.js` — debounced `data/provision-jobs.json` persistence and
  the create→poll→start→discover→auto-link-box job manager (with an `allocate-ip` NetBox phase
  first for `auto-static` presets; the Fleet job pattern). On box-link it auto-starts a server-side
  setup job (injected `startSetup`, `waitForSsh: true`) so the container is usable without the
  browser staying open.
- `proxmoxInventory.js` — cluster-wide linked-guest (LXC **and** QEMU VM) inventory and status
  authority (one `/cluster/resources?type=vm` call per host — that query already covered both
  kinds before VM support; what changed is that the response's qemu rows are no longer discarded
  by an LXC-only filter). Every row (`listNodeGuests` and the linked-guest record alike) also
  carries `template: !!item.template`, PVE's own flag for a clone source — a qemu template
  otherwise looks exactly like a shut-down VM, and linking to one only to Deprovision it destroys
  the template every future clone depends on; the flag is re-read on every refresh so a guest
  converted to a template *after* being linked stays recognisable, not just one linked as one.
  Auto-follows node migrations by updating the stored link's node (guarded against active lifecycle
  jobs), and re-homes an orphaned link when a removed host profile is re-added with the same
  endpoint (new id, exact `host:port` match, vmid verified on that cluster, same CAS + job guards).
  A vmid whose observed type on the cluster disagrees with the link's stored `kind` reports
  `state: 'mismatch'` and — load-bearing — writes nothing back, not even the node: this deliberately
  differs from the node auto-follow above. A migrated guest is still the same guest, just on a new
  node, so following it is safe; a vmid that now reports the other type is a *different* guest
  wearing a recycled number, and updating anything about the link would silently repoint the box at
  a stranger's container or VM. The same posture `knownHosts.js` takes toward a changed SSH host
  key: never auto-correct a possible identity change, only report it and let the operator re-link.
  `listClusterNodes` (served by `GET /api/proxmox/nodes`) reports each physical node's health from
  `/cluster/resources?type=node` — one call per distinct endpoint — for the standby dashboard's
  Proxmox readout.
- `proxmoxLifecycle.js` / `proxmoxLifecycleStore.js` — persisted power/deprovision jobs, now
  covering both LXC containers and QEMU VMs, in `data/proxmox-lifecycle-jobs.json`; a job's `kind`
  is dispatched to the matching `proxmoxApi.js` method. Note the asymmetry with `node`: `node` is
  snapshotted from the freshly refreshed inventory record because it drift-follows a migration, but
  `kind` is read from the stored **link**, because it must not — a job whose target turned out to be
  a kind mismatch is refused outright (`createJob`, `runRoutine`, and `runDeprovision` all check for
  `state: 'mismatch'` before doing anything). Deprovision stops the guest via PVE's own `forceStop`
  + `timeout` (`deprovisionGraceSec`, default 120s) rather than a client-side stop-then-poll: one
  task, so there is no window in which Tmuxifier and PVE disagree about what is running, and the
  server-side escalation from graceful to forced shows up in the task log Tmuxifier already tails.
  This changed LXC deprovision too, not only VMs. Deprovision releases the box's NetBox-allocated IP
  and deletes any remaining NetBox records matching the box's current IP, so manually created
  records don't go stale (best-effort).
- `boxRemoval.js` — shared session/tmux/store cleanup for ordinary removal and verified deprovision.
- `knownHosts.js` — `createKnownHosts`: best-effort `ssh-keygen -R` wrapper (argv, no shell).
  A known_hosts entry is removed only on verified deprovision, on provisioning a fresh
  container's IP, or via the explicit `POST /api/boxes/:id/forget-hostkey` user action —
  never automatically on a connection failure (`status.js` classifies changed keys as
  `hostKeyChanged` so the UI can offer the ⚷ button).
- `aiAuthSeed.js` — `createAiAuthSeeder` + pure seed-script builders: opt-in copying of the
  host's AI CLI subscription credentials to a box (Claude via the `.env`
  `TMUXIFIER_CLAUDE_OAUTH_TOKEN` from `claude setup-token`; Codex via the host's live
  `~/.codex/auth.json`, never stored). Secrets travel stdin-only over the ControlMaster
  (`boxActions.execScriptStdin`) — never in script text, argv, logs, or API responses.
  `status()` reports per-CLI host readiness (no secret material) and is served by the
  auth-gated `GET /api/ai-auth/status` for the provision forms' readiness rows.
  The trigger is the setup job itself (see `setupManager.js`), not the browser; `POST
  /api/boxes/:id/seed-ai-auth` remains as the manual re-seed path with no UI caller.
- `claudeStatusline.js` — `buildStatuslineInstallScript` (pure) + `createStatuslinePusher`: the
  push of this host's own Claude Code statusline (`src/server/assets/claude-statusline.sh`,
  read through the injected `readAsset`) to a box. Structural twin of `aiAuthSeed.js`: the script
  text interpolates **nothing** and the statusline file arrives on stdin. The apply-or-skip
  decision is made **on the box** by a `command -v claude` check, so one rule covers both a fresh
  box without Claude Code (skipped) and an edit of a box that already has it (applied) — no
  add-vs-edit branching. The box's `settings.json` is merged in place, never overwritten (jq →
  node → python3 fallback chain, atomic temp+rename; a box with none of the three reports
  `error-no-json-tool`). Run by `setupManager.js` as the post-seed `statusline` phase, gated
  (with the agent-hooks push) by the `claude` tools selection — one knob for the Claude stack.
- `claudeAgentHooks.js` — `buildAgentHooksInstallScript` (pure) + `createAgentHooksPusher`: the
  push of the agent-state hook (`src/server/assets/tmuxifier-agent-hook.sh`) to a box, gated by
  the same `claude` tools selection as the statusline (strict one-knob consolidation; it was
  briefly always-on in v1.24.10–12). Structural twin of `claudeStatusline.js` — script text
  interpolates nothing, the hook file arrives on stdin, the box decides via `command -v
  claude` — with an array-aware settings.json merge: `hooks` entries are arrays, so the merge
  is remove-then-append per event (drop entries mentioning `tmuxifier-agent-hook`, append
  ours), idempotent across reruns and blind to the operator's own hooks. The hook writes
  `<session>:<state>:<epoch>` markers under `~/.tmuxifier-agent/` on
  UserPromptSubmit/Stop/Notification/SessionStart and deletes on SessionEnd; the status probe
  reads them back (`parseAgentMarks` in `status.js`) and they are the SOLE source of
  `sampleOf`'s agent state (hook-only, see `healthHistory.js`). Run by `setupManager.js` as
  the post-statusline `agent-hooks` phase, recorded on `job.agentHooks`, never promoted to a
  job failure.
  Three further events — SubagentStart/SubagentStop/PreToolUse — feed the hook's
  **background-work gate**, and exist because `Stop` does not mean what it reads like: it
  fires whenever the main agent finishes responding, INCLUDING a turn that ended solely to
  await a background subagent or shell, which the harness then resumes on its own. Writing
  `waiting` there sent the operator back to a screen where nothing wanted them. So outstanding
  work is tracked as token files under `.tmuxifier-agent/busy/<session>/` — SubagentStart/Stop
  bracket a subagent exactly (both carry `agent_id`), PreToolUse covers a backgrounded shell
  and is the only entry carrying a `matcher` (`Bash`), since it is the one event that fires per
  tool call — and `stop` writes `working` instead of `waiting` while a token is live. The gate
  covers the `notify` path too, but ONLY for `notification_type: idle_prompt`: that one is a
  timer that fires a fixed interval after any turn ends, so gating `Stop` alone just moved the
  false ping a minute later (observed: a second `waiting` write at exactly Stop+60s). Every
  other notification type — `permission_prompt`, `agent_needs_input`, … — is Claude Code saying
  it genuinely wants the operator, and still lands. Two rules are load-bearing. `prompt` clears
  every token, because the harness re-invoking the agent after background work finishes fires
  UserPromptSubmit exactly like a human turn, and for a backgrounded **shell** that is the only
  completion signal there is (a subagent has SubagentStop; a shell has nothing). And every
  token expires, on two deliberately different clocks, because only one kind is exact. A
  `sub.` token is bracketed — SubagentStop always fires, mid-turn or not — so its 120min TTL
  only ever catches a killed subagent. A `bg.` token is a **heuristic** and gets ~2min: if the
  shell finishes while the turn is still running, NOTHING fires (UserPromptSubmit fires only
  when the harness resumes an *ended* turn), so the token goes stale silently and would
  suppress the next real `Stop`. Live testing is what surfaced that — the token outlived its
  shell and sat there. The short TTL bounds the exposure to turns ending within ~2min of the
  launch, a window in which a just-launched job is far likelier to still be running than not.
  The whole gate fails OPEN by design: a missed notification is worse than a spurious one.
  Residual, accepted: two concurrent background jobs, one finishing, clears both tokens, so
  the second can still produce one false `waiting`.
  The hook therefore READS its stdin event JSON (it used to discard it) — substring-matched
  only, never eval'd, and every value taken from it is re-sanitized before reaching a path.
- `tlsPin.js` — shared TLS fingerprint-pinning helpers (`tlsProbe`/`pinnedSocket`/`normFp`) used
  by both the Proxmox and NetBox API clients. Pin mode verifies the pinned fingerprint on each
  request's own connection (`pinnedSocket` via `createConnection`) instead of OpenSSL chain
  verification — a served chain that never reaches a self-signed cert (e.g. Caddy's local CA
  serving leaf+intermediate) can't satisfy a rebuilt CA store.
- `netboxValidate.js` / `netboxStore.js` / `netboxApi.js` — NetBox integration settings: pure
  input validators, the sealed `data/netbox.json` store (token AES-256-GCM encrypted, redacted to
  `hasToken` on read), and the `/api/status/` connection probe with ca/pin/insecure TLS modes.
  `createNetboxClient` also serves provisioning: `auto-static` presets reserve the next free IP
  from the VLAN's NetBox prefix (released again on failure or deprovision), stamping the
  record's `dns_name` from the hostname plus the optional global DNS suffix setting; `nextIp`
  (same free-IP selection as the allocator, no reservation) powers the provision form's
  non-binding next-IP preview via `GET /api/netbox/next-ip`.

Web client is `src/web/` (TypeScript + xterm.js, bundled by Vite): `main.ts` (also drives the
provision panel, a poll-based setup-job viewer — Retry / Remove / Finish-interactively — now that
setup runs server-side; clicking a box whose setup job is still `running` renders a live
setting-up panel (`blocksTerminal` in `setupStatus.ts`) instead of a terminal, and opens the
terminal itself once the job settles; the login screen also wires the passkey button through the same
`evaluateOrigin` verdict, with a dead-end message when "require a passkey" is armed but this
browser has no usable one; `loadUiSettings()` applies the server's UI prefs — theme, clawd
variant — at boot *and* on the password and passkey login paths, so a fresh sign-in is not left
wearing the default until a manual reload, and it owns the clawd pref's one-time migration:
a `null` server value plus a stored legacy key PATCHes this browser's pick up, while nothing
stored anywhere leaves the pref unset rather than persisting a phantom choice. Google sign-in
needs no wiring — it is a full navigation that returns through `start()` like any page load),
`api.ts`, `http.ts` (the shared fetch helpers — `jsonOf`/`jsonFetch`/
`textFetch`/`httpError`/`statusOf`/`jsonBody` — and the central 401 seam: `onUnauthorized` is
registered by `main.ts` to tear the workspace down to the login screen when the session dies,
and every fetch layer must route non-ok handling through here — `test/webHttp.test.js` forbids
hand-rolled `res.ok` checks outside this file, so a new fetch layer inherits the seam rather
than silently missing it), `terminal.ts` (the pane handle also exposes `input(d)` and
`appCursor()` — what the touch key bar sends through and reads the live DECCKM mode from — plus
a `transformInput` seam on the `term.onData` path, where sticky Ctrl masks. `input(d)` sits
*downstream* of that seam and never passes through it, so a bar key cannot be masked even in
principle — the bar also disarms explicitly, so `ctrl` then an arrow spends the modifier rather
than leaving it armed. `wireTouchGestures` (formerly `wireTouchScroll`) owns all touch on the
glass: drags still become synthetic wheels, and when the pane app has mouse tracking on
(`term.modes.mouseTrackingMode`, read live per gesture) a tap is preventDefault-ed and
explicitly refocused rather than forwarded as a click — a stray touch on a Claude Code option
list was selecting and activating it — while a ~500ms hold dispatches the real
mousedown/mouseup pair so deliberate touch activation survives. The hold decides keep-vs-blur
focus by KEYBOARD evidence, not focus evidence (`holdKeepsFocus` fed by `keyboardOpen`):
xterm's mouse-tracking handler calls focus() on any mousedown, and Android's back gesture
hides the keyboard *without blurring*, so a focused textarea proves nothing — keying on focus
made every hold re-summon the keyboard. The pure tap/hold/drag discriminator is
`touchGesture.ts` (`HOLD_MS`/`SLOP_PX`), and with tracking off it reproduces the old
scroll-only path exactly, so plain prompts see zero drift. Also a one-point font bump
under `(max-width: 720px) and (pointer: coarse)` decided once per `openTerminal` call, so a
mid-session flip leaves open terminals at the size they started with; the bump saturates at 32
BEFORE `clampFontSize` sees it, because that clamp falls back to the default 12 for anything
out of range — an unsaturated bump past the ceiling came back smaller than the desktop it was
meant to enlarge), `index.html`, `style.css`, plus feature modules —
`stageLayout.ts` (the pure split-tree stage model — a node is a box-id leaf or a split
(orientation/children/ratios) in canonical form (splits ≥2 children, no same-orientation
nesting), with stage-edge/pane-edge dock, atomic move, undock-collapse, path-addressed
setRatio/toggleOrientation, and v2 serialize/restore with v1 migration and vanished-box
pruning; the four-pane cap is main.ts's `MAX_PANES`, not the model's. `phonePaneOf` is the pure
one-pane selection phone mode renders through — the focused id if it is still docked, else the
first pane — and it only *reads* the tree, so a phone session renders a one-leaf view of the
desktop split rather than flattening the persisted layout), `stagePanes.ts`
(pure grid/ARIA helpers plus the recursive `.stage-split` DOM renderer with path-addressed
WAI-ARIA splitter dividers, typed drop targets — stage-edge/pane-edge/replace — and
spatial `focusMove`;
every pane renders a header via the `headerFor` hook and wraps its content in `.pane-body`;
`main.ts` drives the stage from this layout + a focused pane, persisted under
`tmuxifier.stageLayout`, and parks undocked terminals in a hidden div so they stay
connected), `paneHeader.ts` (the pane header bar: the pure view-model — identity, status
dot, and one state-chip slot with pane-state > connection > agent precedence, the agent
read coming from the latest `/api/health/series` sample — plus the `buildPaneHeader` DOM
layer whose `update()` rewrites in place, so the voice button (mounted into the bar via
`openTerminal`'s `voiceMount` seam) survives polls. It also exposes a `lifecycleSlot` for
`paneLifecycle.ts` and, via `wantRefresh`, hands back the Reconnect cap rather than owning its
click policy — that action kills the pane's tmux session, so `main.ts` wires arm-then-fire onto
it instead), `paneLifecycle.ts` (the Proxmox lifecycle keys in that slot: `lifecycleKeysFor`
derives which keys a pane's state allows, the caps are **words** (`START`/`SHUTDOWN`/`REBOOT`/
`STOP`) precisely because the old `↺` reboot glyph was indistinguishable from the Reconnect
button's `↻` sitting in the same header, and a destructive key arms before it fires through the
shared `arming.ts` reducer; a job in flight owns the chip slot and its `onSettled` triggers a
fast status poll), `arming.ts` (the shared arm-then-fire policy — first click arms, second
commits, anything else disarms — used by the lifecycle keys and all three Reconnect buttons, so a
third armable control inherits the behaviour rather than re-deriving the disarm cases),
`phoneMode.ts` (the phone shell controller: the `(max-width: 720px)` flag `main.ts` branches
`repaintStage` on, the sidebar-as-drawer wiring (☰ toggle, scrim tap, Escape, delegated
close-on-activation), and the `--vvh` visual-viewport tracker. Two rules are load-bearing. The
drawer closes only on controls that change the stage or open an overlay (`CLOSES_DRAWER`),
never on ones that operate *inside* it — `#fleet-toggle` reveals the fleet bar and the per-box
checkboxes within the aside, so closing on it would slide away exactly what the tap just
revealed; `#fleet-run`, the fleet bar's own *Run on N* button one step later, does close,
because it opens the fleet **confirm** modal, which mounts into `#app` beside `.layout` rather
than inside the aside. The ⤢ `.fleet-expand` that opens the script editor is not in the list
either — same mount, and its backdrop (z-index 60) clears the drawer's 40 regardless, so the
drawer simply stays open behind it. Second,
`--vvh` is `vv.height * vv.scale`, not `vv.height`: `index.html` sets no maximum-scale, so iOS
auto-zooms on focusing any sub-16px field (the drawer's `.search` is 12.5px), and without
multiplying the zoom back out, tapping the search box would collapse `.layout` to about
screenHeight/scale and refit every open terminal for a keyboard that never appeared. It also
strips `sidebar-collapsed` while the query matches — the collapsed rail hides the box list,
fatal inside a drawer — and removes `--vvh` on both flip and `dispose()`, since
`documentElement` outlives `#app` and a keyboard-squeezed height would otherwise still be
styling `.layout` after the next login. `keyboardOpen`/`KB_OPEN_PX` (pure, exported) ride the
same height-gated handler to toggle `kb-open` on `.layout` — CSS hides `.phone-bar` under it,
handing its row to the stage while the soft keyboard is up — and the class is removed on flip
and `dispose()` exactly like `--vvh`), `touchKeys.ts` (the phone touch key bar — gated
additionally on `(pointer: coarse)`, so a narrow desktop window reflows but grows no bar, which
is why `main.ts` asks the DOM (`touchBarShown`) rather than re-declaring that query in JS before
adopting the pane's mic into it. The pure half is `TOUCH_KEYS`/`seqFor` (no arrow caps since
2026-08-04 — they made the strip overflow narrow screens, and caps fire on pointerdown, so a
scroll begun on a cap sent that cap's key; no ctrl cap since the same day's composer round —
its letter-masking is structurally broken under a composing IME, the reason ^C has its own
cap, and the 344px budget fit exactly one more pinned control, which the composer toggle
earned instead; `seqFor` keeps the DECCKM-aware arrow map and the ctrl guard so restoring
any of them is one catalog line each) — and `createStickyCtrl`, the
arm → mask-one-character → disarm modifier whose case fold is a raw ASCII a–z fold and never
`toUpperCase()` (`'ß'.toUpperCase()` is `'SS'`, and masking that `'S'` would send `\x13` XOFF
and freeze the pane); space masks to NUL and anything unmaskable passes through untouched but
still disarms, so an armed modifier can never silently corrupt later input. The DOM half sends
on `pointerdown` + `preventDefault` — a click would move focus off xterm's hidden textarea and
close the soft keyboard on every key press, with a `detail === 0` `click` handler beside it
carrying the keyboard/AT activation path that same `preventDefault` would otherwise leave dead — splits the bar into a cap strip and a
pinned tail — the ✏️ and ⏎ caps (`pinned: true` in `TOUCH_KEYS`) and the mic slot — with the whole row
spacing-budgeted to fit a 344px viewport (Z Fold 6 cover screen) with nothing to scroll,
pinned by the touchBar e2e, never Ctrl-modifies its own keys, and returns
`syncCap`, the repaint seam `transformInput` calls when the soft keyboard's own input spends
the modifier with no pointer event on the bar to notice. The bar's `send` seam is
boolean-returning (a live pane accepted the bytes, or not), and its deps carry
`focusTerminal` (composer close hands the keyboard back to xterm) and `onLayoutChange`
(open terminals refit when the composer changes the bar's height)),
`composer.ts` (the phone composer the bar's pinned ✏️ cap toggles — it took the dropped
ctrl cap's slot in the 344px budget, so it is always thumb-reachable and, unlike the
top-bar opener it briefly was, still on screen while the soft keyboard is up:
pure `sendTextOf` — whitespace runs collapse to single spaces because a raw
newline reaching the pty IS Enter, remaining C0/C1 controls stripped, trimmed — plus the DOM
row (textarea + ➤) that `buildTouchKeyBar` display-toggles in place of the cap strip, so the
draft persists across toggles and pane switches. Send transmits `sendTextOf(draft) + '\r'`
through the bar's `send` seam and clears the field only on `true`, so Send never destroys a
draft a setup/stopped pane couldn't accept; an empty draft sends bare Enter. Opening focuses
the field (the soft keyboard retargets to a real input the IME can safely word-replace in —
the round-2 structural fix) and disarms an armed sticky modifier inside `setComposing` —
the one place every open path funnels through; closing refocuses the
terminal, and flipping to desktop force-closes via `main.ts`'s onFlip. While open, the pane
mic reroutes transcripts into the draft through `VoiceHost.sink` (evaluated at finish-time,
and `voiceUi.ts`'s `finish()` skips its terminal refocus on that path — the field is holding
focus deliberately) and `POST /api/voice?inject=off`, which returns the text without touching
the pane),
`immichCard.ts` (the Immich card: library and volume sizes kept distinct — `statistics.usage` is
the library, `storage.diskUseRaw` the disk, and one "size" figure would conflate them — plus the
job-queue verdict and the named `denied` readings a least-privilege key produces),
`dashboard.ts` (the standby dashboard replacing the empty stage: pure
view-model helpers (grouping, latency/lamp/mode, PVE rollup) plus an in-place-updating DOM
layer; mounted by `main.ts` whenever no pane is docked, with a 10s services poll and 60s
infra poll that run only while mounted; the sidebar nameplate `#home` returns to it,
undocking — not killing — any docked terminals. A fleet card is a two-line **spec sheet** —
`boxSpecLines`: what the box is (`osLabel` distro + core count) over what it has (RAM,
`fmtDiskPair` used-of-total) — deliberately *not* the live cpu/mem/disk percentages, which
the sidebar rows beside it already carry; repeating a gauge told the operator nothing. Spec
figures drop `fmtBytes`'s trailing `.0`, since a capacity is a round number and the cards
have no numeric column to align to, unlike the TrueNAS/Immich ones), `fmt.ts` (the shared display formatters —
`fmtCount`/`fmtCompact`/`fmtUptime`/`fmtLatency`/`fmtBytes` — factored out of `dashboard.ts`,
which re-exports them, so a card module can use them without importing the dashboard back),
`serviceIcon.ts` (the one `<img>` builder shared by the plain tiles, all three cards and the
settings list; it hides itself on `error`, so a service with no resolvable icon degrades silently
to no icon with no pre-flight request — and it is always an `<img>`, never inlined SVG, which is
what makes the content inert regardless of its source),
`truenasCard.ts` (the TrueNAS card: the pure model plus the pure `truenasLamp` severity
function whose 80/90 capacity thresholds are named exported constants, and an
in-place-updating DOM layer; it lives outside `dashboard.ts` rather than growing it further),
`unifiCard.ts` (the UniFi card: the pure model — a six-cell client/WAN census over
per-device-class rollup rows — plus `unifiLamp` and the local `fmtBitrate`, since UniFi reports
bit rates and `fmtBytes` would render them in the wrong unit and base),
`reconnect.ts` (escalating backoff), `statusDot.ts`, `sparkline.ts`/`healthEvents.ts` (health
history: pure SVG-path builder and event-line formatters), `notifyPrefs.ts` (per-kind
browser-notification preferences, localStorage-backed, defaults all-on except `up`/
`threshold-clear`), `themes.ts` (the pure theme catalog — `THEMES`, `DEFAULT_THEME_ID`, and
`normalizeThemeId`, which folds an unknown or stale id back to the default rather than
propagating one nothing can resolve. No DOM and no CSS imports, so a node test can import the
manifest), `theme.ts` (its DOM half: `applyTheme` stamps `data-theme` on `<html>` — the default
carries **no** attribute, since `:root` *is* the Instrument theme — mirrors the id into
`localStorage`, and notifies subscribers so every open terminal re-resolves its colors on a
switch, each subscriber isolated so one stale pane handle can't leave the rest on the old theme.
`resolveScreenTheme` reads `--screen`/`--text`/`--accent`/`--term-sel` through a throwaway probe
element because a raw custom property reads back unresolved; the theme CSS side-effect imports
live here rather than in `themes.ts` precisely so vitest never pulls CSS. The localStorage mirror
is what `public/theme-boot.js` — a blocking classic script in `<head>`, an external same-origin
file because CSP stays `script-src 'self'` and inlining it would need an exception — stamps
pre-paint, so the login screen wears the chosen theme before any session exists. Adding a theme
is `themes/<id>.css` with every rule `[data-theme]`-scoped, one `themes.ts` entry, and its import
here; `test/styleTokens.test.js` pins both halves of the contract),
`clawd.ts` (the indicator beside every **working** agent chip — sidebar badge,
pane chip, dashboard fleet strip: the ordered variant catalog, the preference — authoritative
**server-side** in `data/ui-settings.json` since the themes engine, so one pick covers every
browser, with a synchronous in-module cache the frequent render sites read without awaiting and
`tmuxifier.clawdAnim` in localStorage demoted to a boot mirror that seeds renders before the
first `GET /api/ui-settings` lands; an unknown value normalizes to the default CLI star spinner
rather than rendering nothing — and the variant DOM builder.
`off` means no indicator at all — the builder still returns an element (`.clawd-v-off` is
`display: none` in `style.css`) so the render sites never branch on the variant — and `static` is
the motionless sprite. The one catalog drives the Appearance picker rows, pref normalization, and
the builder, so the picker can never offer a variant the builder lacks; a variant's *motion*,
though, lives in a matching `.clawd-v-*` rule that nothing ties to the catalog — an entry without
one renders silently static. All motion is pure CSS `.clawd-v-*` classes in
`style.css` — no timers, so a fleet of working boxes costs nothing to animate — and
`prefers-reduced-motion` rests every variant on one frame. Waiting chips deliberately carry no
indicator: stillness is what makes that state read as the operator's turn),
`setupOptions.ts` (the shared post-create setup form — Terminal/Tools/AI-auth/Post-setup-script
sections —
used by the Add/Edit Box modal and the hub's Provision tab; fetches `GET /api/ai-auth/status`
to show per-CLI seed readiness with fix-it commands, and disables the seed checkbox only when
both CLIs are unready; the Tools section also carries the opt-in "Push Claude Code statusline"
checkbox — `claudeStatusline` in the payload. The Post-setup script section is a lookup-key
`<select>` over the saved fleet scripts, contributing `scriptId`/`scriptName` via the pure
`scriptSelection` — the server resolves the id, so nothing chosen here reaches a shell as text;
an empty list or a failed fetch degrades to a disabled control with a reason rather than an
unexplained empty dropdown), `provisionTools.ts` (`PROVISION_TOOLS`, the curated
provision-time tool id/label list plus its `toolsCheckboxGroup` builder; the ids mirror `TOOL_IDS`
in `boxActions.js` — the server stays the validation authority and `test/provisionTools.test.js`
locks the two lists together), `presetSummary.ts` (pure one-line preset description builder),
`setupStatus.ts` (pure setup-status
text/actions/badge helpers shared by the provision panel and the Proxmox hub),
`fleetSelection.ts`/`fleetHistory.ts`/`fleetEditor.ts` (Fleet
Command selection, recent-command history, and the CodeMirror bash-script editor),
`fleetPoll.ts` (the generation-guarded fleet job-detail poll loop — a stale response can
neither paint over nor stop the newer selection's polling; note that `show(B)` stops A's watch,
which is why the Fleet Jobs list needs its own poll rather than relying on the detail poller),
`fleetJobs.ts` (the Fleet Jobs drawer's pure view-model: `partitionJobs` splits the server's single
newest-first list into the two things it actually holds — processes you can still cancel, and
records you read — plus `jobLamp`, `jobReadout`, `jobClock` and the `sameJobShape` predicate the
in-place row reconcile keys on. `jobReadout` emits `errorCount`, which the old meta line discarded:
`okCount/targetCount` alone rendered 3 ok + 9 failed identically to 3 ok + 9 still pending. A
running job always reports "changed" from `sameJobShape` because its clock ticks),
`fleetScripts.ts`/`fleetScriptRail.ts`
(saved fleet scripts: the fetch layer plus the pure `sortScripts`/`isDirty`/`validateName` helpers,
and the script modal's left rail — an in-place-updating DOM layer whose delete key arms through the
shared `arming.ts` reducer. The unnamed buffer stays a first-class `Draft` row, so selecting a saved
script can never orphan typed work; switching away from a dirty buffer is the one gated action. The
name/note fields are bound to the selection, so one mechanism covers both naming a new script and
renaming an existing one, and a run carries `scriptName` only while the buffer still equals the
saved body — a dirty buffer runs nameless rather than claiming to be a script it no longer is),
`interactiveLauncher.ts`
(at-most-one live "Finish interactively" setup terminal, shared by the provision panel and the
hub), `modalRegistry.ts` (body-mounted modals register their close() so logout/session-expiry
teardown reaches them), `setupPoller.ts` (the generation-guarded setup-job poll loop shared by
the provision panel and the hub — the injected policy renders and returns the next delay),
`proxmox.ts`/`proxmoxUi.ts` (the Proxmox fetch layer and operations-only hub shell: Guests,
Presets, Provision, and Activity tabs — host/secret setup lives in the settings modal;
`proxmoxUi.ts`'s Provision tab polls the server-side setup job once a box links),
`proxmoxPresets.ts` (the Presets tab's master-detail create/edit/delete form, dependent Proxmox
loaders, stale saved-option fallbacks, and additional-disk modal; the `auto-static` IP mode is
offered only once NetBox is configured),
`proxmoxGuests.ts` (formerly `proxmoxContainers.ts`; the Guests tab's linked-guest list — now both
LXC containers and QEMU VMs — with a CT/VM `kindLabel` badge per row, a live filter that matches
that badge (typing `vm` or `ct` narrows by kind, same field-substring match as everything else it
searches), state-gated lifecycle actions, and the deprovision confirm dialog; a `'mismatch'` row
renders the server's explanation text and offers only "Edit link" — `actionsForState` returns no
lifecycle actions for it, deliberately alongside `'unknown'`, since the guest Tmuxifier can see may
not be the one the box is linked to. A template guest (PVE's `template: 1` flag, carried by
`proxmoxInventory.js`) gets the same no-actions-plus-"Edit link" treatment via `actionsForGuest`,
checked ahead of `actionsForState`, plus a `TEMPLATE` badge in its own grid cell alongside the
CT/VM one — Deprovisioning a template destroys the source every future clone depends on, and PVE
does not otherwise distinguish a template from an ordinary stopped guest), `proxmoxActivity.ts`
(the Activity tab merging provision and lifecycle jobs newest-first), `proxmoxAssociation.ts` (the
Add/Edit Box modals' manual Proxmox link/unlink picker — hidden until a Proxmox host profile
exists, except for already-linked boxes; a template's option is `TEMPLATE`-marked and disabled,
the same shown-but-unselectable treatment a guest already linked to another box gets, rather than
vanishing from the list), `settingsUi.ts` (the ⚙ settings
modal's tabbed shell — the `SECTIONS` object's key order builds the tab strip — with Boxes
(`settingsBoxes.ts`: the leftmost tab — box-list JSON export/import moved out of the sidebar brand
actions, which stay reserved for the routinely used controls, fronted by an export preview that
fetches `GET /api/export` itself so the stat grid and byte size describe the literal backup file,
plus import caveats (ids re-minted, Proxmox links dropped) and a static not-in-this-backup note;
pure `importSummary`/`exportStats`/`exportSizeBytes`/`exportFilename`),
Services (`settingsServices.ts`: the standby dashboard's service-tile CRUD — name/URL/icon/
group/check form whose icon control is Auto (resolve from check kind, then name, then hostname) /
Choose (a filterable grid of the `vendor/icons/` catalog) / None, plus a Refresh icon button that
re-scrapes the service's own favicon; pure `buildServicePayload`),
NetBox (`settingsNetbox.ts`), Proxmox host/secret
(`settingsProxmox.ts`), Passkeys (`settingsPasskeys.ts`: readiness row, enrolled-credential list
with remove — confirm-gated by one modal; removing the last credential while "require a passkey"
is armed adds only an extra explanatory paragraph to that same modal, not a second gate — and the
sign-in policy toggle, where only *arming* is confirm-gated since disarming can only restore
access), Voice (`settingsVoice.ts`: the enable toggle and pinned-model picker, the whisper.cpp
install job started through `POST /api/voice/install` and watched with the shared `setupPoller`
(re-reading the painted tab afterwards rather than trusting one fire-and-forget refresh), the mic
test, and pure `voiceStatusLine`/`micTestMessage`/`installPollDelay` helpers), Notifications
(`settingsNotifications.ts`:
browser-notification permission flow plus per-kind toggles), and Appearance
(`settingsAppearance.ts`: the rightmost tab — the theme picker over `THEMES` and the
working-agent animation picker, the latter's radio rows carrying live previews built by
`clawd.ts`'s own builder with the real `.clawd-v-*` classes, so a preview cannot drift from the
chip it describes; selecting a row applies instantly and `PATCH`es `/api/ui-settings`, so there
is no Save button, and a failed save keeps the local apply and says so rather than yanking back
a theme the operator is already looking at) tabs) with `settingsForm.ts` (pure
payload/result helpers), `netbox.ts` and `voice.ts` (fetch layers), `passkeys.ts` (passkey fetch layer,
base64url↔bytes helpers, the pure WebAuthn option/credential converters, and `evaluateOrigin` —
the ordered readiness check, browser support first, that both the login screen and Settings →
Passkeys render as the same reason/hint text), and `dom.ts` (shared DOM builders plus `openModal`
— the one modal scaffold with backdrop-click guard and Escape-to-close — and `makeRadio`, used
across the settings modal, the hub, and the main.ts dialogs),
`clipboard.ts`, `upload.ts` (pure paste/drop upload helpers: DataTransfer extraction, pasted-image
naming, size check), `termFont.ts` (pure builder for the xterm
font stack — prepends `TMUXIFIER_TERM_FONT` onto the bundled stack (MesloLGMDZ Nerd Font default,
then MesloLGSDZ + JuliaMono fallback); the server
validates the name in `config.js` and serves it via `GET /api/ui-config`, which `main.ts` applies
at boot before any terminal opens), `wavEncode.ts` (pure Float32-to-16kHz-mono-16-bit-PCM WAV
encoder — the reason the project needs no ffmpeg dependency: whisper.cpp wants exactly that
format, and the browser's MediaRecorder would have emitted webm/opus requiring server-side
decoding; the input sample rate is a parameter, not an assumption, since `AudioContext.sampleRate`
is device-dependent — commonly 48000, often 44100), `voiceRecorder.ts` (microphone capture via
`getUserMedia` and an AudioWorklet, producing WAV bytes), `voiceUi.ts` (the readiness verdict
`evaluateVoice` — ordered browser-support then secure-context then server-enablement, the same
shape as `passkeys.ts`'s `evaluateOrigin` — the hotkey predicate and its toggle handler
(`createVoiceHotkeyHandler`: Ctrl+Shift+Space tap-to-start/tap-to-stop, swallowing every event of
the chord — including auto-repeat keydowns and keyups — so a held key can't leak into the pane),
the mic button (click-and-hold, unchanged), and the controller), and `voiceWorklet.js` (the
AudioWorklet processor, shipped as a real Vite-emitted static asset rather than a blob: URL,
specifically so the Content-Security-Policy can stay `script-src 'self'`).

## Conventions

- ESM everywhere (`"type": "module"`); Node 20+.
- TDD: write the failing test first (see `test/`). Tests use **real code, not mocks** — enabled by
  the dependency-injection factories above.
- The integration and e2e suites run against an **isolated** box, not the developer's account:
  `test/helpers/localBox.js` spawns its own `sshd` on an ephemeral port with a temp host key, a temp
  `AuthorizedKeysFile`, and `SetEnv HOME/ZDOTDIR/TMUX_TMPDIR` pointed at a fixture home holding
  minimal rc files. It therefore reads none of the operator's shell config, never touches
  `~/.ssh/authorized_keys`, and gets its own tmux server. Each of those was once false and each
  cost a debugging session — an oh-my-zsh update prompt in the operator's `.zshrc` turned nine
  tests red, and a stray `PATH` let `chsh` repoint the account's login shell at a temp directory
  that no longer existed. `TMUX_TMPDIR` is load-bearing: with a shared socket, `tmux new-session`
  attaches to the operator's running server and inherits its environment (the real `HOME`),
  which looks green while testing the wrong thing. The guarantees are pinned by
  `test/localBox.integration.test.js`; a missing `sshd` fails loudly rather than falling back to
  the system one, since a silent fallback would restore the coupling invisibly.
- Server is plain `.js`; web client is `.ts`.
- Conventional-commit style messages (`fix(pty): …`, `feat(ui): …`).

## Shipping (contributing changes back)

The GitHub repo is **public** — never commit real PII (your domains, public/LAN IPs, hostnames,
emails, box/fleet names). Real values live only in the gitignored files above; committed docs,
examples, and tests use placeholders (`example.com`, RFC1918 IPs like `192.168.1.10`,
`you@example.com`).

Features are validated on the **live app before they merge**: build in the feature worktree,
`rsync -a --delete <worktree>/dist/ ./dist/`, and restart the service. The restart is
mandatory even for client-only changes — asset routes are registered per file at boot, so a
freshly-swapped hashed bundle otherwise falls through to the SPA fallback (`text/html`) and
the app renders blank. Verify by fetching one hashed asset end-to-end (expect its real
content-type), not just `GET /`. Only after validation does the branch merge to main and the
checklist below run (its build converges `dist/` onto the released version); a failed
validation is fixed on the branch and redeployed, and rollback is just `npm run build` from
main. Any restart — candidate or release — waits until no setup/provision/lifecycle/fleet/
voice-install job is `running` (a restart would interrupt them).

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
- Password and OAuth modes are mutually exclusive **with each other**: password mode mounts
  `POST /api/login`; OAuth mode mounts `/api/auth/google/*` instead and removes the password
  login path. A passkey is a third, additive login path that mounts in **both** modes regardless
  of `TMUXIFIER_AUTH_MODE` — it is not a value of that setting.
- Google auth is hand-rolled OIDC in `googleAuth.js`: state cookie + PKCE, token exchange
  server-to-server, then exact-email allowlist. The id_token payload is trusted because it is
  fetched directly from Google's token endpoint over TLS in the authorization-code flow.
- In OAuth mode, a passkey login never consults `TMUXIFIER_ALLOWED_EMAILS` — it authenticates a
  device credential, not a Google identity. Removing an email from the allowlist does **not**
  revoke a passkey already enrolled under that account; the passkey itself must be removed from
  Settings → Passkeys. Enrollment requires an authenticated session (password/Google remains the
  bootstrap and the recovery route), so this is not a privilege-escalation path — just a separate
  revocation step to remember.
- Passkeys' opt-in "require a passkey" toggle (`passkeyStore.js`'s `passkeyOnly` flag) disables
  password and Google sign-in entirely, so arming it is guarded four ways against locking the
  operator out: arming demands a fresh, successful WebAuthn assertion in the arming browser
  (`POST /api/passkeys/only/begin` starts the ceremony and `POST /api/passkeys/only` verifies
  the assertion with the same machinery as login, so arming proves a credential works *now*,
  not merely that one is enrolled); it is refused with a 409 unless at least one credential is enrolled **and** the
  configured relying party id is actually usable against them (refused when the RP id is `null`
  — i.e. derived from an IP address rather than a hostname; the RP id itself is never unset,
  since it defaults to `localhost` — or when the enrolled passkeys are pinned to a different
  hostname than the server is now configured for); removing the last credential auto-disarms
  it; and `TMUXIFIER_PASSKEY_ONLY=off`
  in `.env` overrides the stored flag as the break-glass — the recovery path for when arming
  succeeded legitimately (a real, usable passkey) but that authenticator is later lost. Takes
  effect on restart.
- Passkey login shares the per-IP `rateLimit.js` login-lockout bucket with password login, so it
  is not a way around that lockout. Assertion failures return one generic 401 whether the
  credential is unknown or the signature is bad, so credential ids cannot be enumerated.
  Separately, the WebAuthn challenge issued per login/enroll attempt is bounded per client address
  (`passkeyChallenges.js`), not globally: a single flooding source can no longer evict another
  user's in-flight challenge, but an attacker spread across many source addresses still can — the
  same residual limit as the login rate limiter itself. Under "require a passkey" that would deny
  sign-in outright, with the `.env` break-glass above as the remedy.
- Device tokens (the Android app's credential) join the same story: `POST /api/devices/enroll` is
  password-gated and shares the `rateLimit.js` login bucket, so it cannot be used to brute-force
  the password for free; it also 403s when "require a passkey" is armed, same as the password
  login form, and 501s in OAuth mode (v1 is password-mode only). Only the token's SHA-256 digest
  is stored — the plaintext is returned once, at enrollment, and never again. `requireAuth`
  accepts a device's `Authorization: Bearer <token>` alongside the session cookie, and revoking a
  device (Settings → Devices) takes effect on its very next request, since every request re-reads
  `data/devices.json`. Arming "require a passkey" does **not** revoke devices already enrolled —
  a device token never expires and ignores the logout watermark, so only that Settings → Devices
  revocation cuts one off. `TMUXIFIER_FCM_CREDENTIALS` — the Firebase service-account path that
  turns on push notifications — joins the `.env` secret class alongside the password hash and
  cookie secret.
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
- WebSocket auth: `@fastify/websocket` v11 populates `req.cookies` on the upgrade, so WS auth
  rides the normal cookie path; `isAuthed` in `server.js` keeps a manual cookie-header parse as a
  defensive backstop (it was the required WS path under v10).
- The persisted Proxmox secrets — the API token, any added SSH management keys, and the optional
  root password — are the only credentials Tmuxifier stores. They are AES-256-GCM encrypted at rest
  in `data/proxmox.json` (key from `cookieSecret`), written `0o600`, and never returned to the
  browser (host views are redacted to `hasToken`). PVE TLS is pinned by fingerprint for self-signed certs
  (TOFU, like `ssh accept-new`) or CA-verified; an explicit per-host `insecure` mode is off by
  default. All provision input is validated (`proxmoxValidate.js`) before reaching the API.
- The NetBox API token is sealed the same way in `data/netbox.json` (`0o600`) and never returned
  to the browser (`hasToken` only). NetBox TLS supports CA verification, TOFU fingerprint pinning
  (shared `tlsPin.js` helpers), or an explicit insecure mode — off by default.
- A Pi-hole tile's app password is sealed the same way (AES-256-GCM in `data/services.json`,
  key from `cookieSecret`, file `0o600`) and is never returned to the browser (`hasPassword`
  only). Unlike the `http`/`tcp` liveness checks — which always set `rejectUnauthorized: false`
  because they send no credentials — the Pi-hole check sends a password, so its TLS is
  **verified by default** with an explicit per-service `insecure` opt-in. The session id lives
  in memory only, never on disk, and is revoked on shutdown. Use a Pi-hole **app password**
  (Settings → Web interface / API), not the web login password: an app password is unaffected
  by two-factor authentication and is scoped to the API.
- A TrueNAS tile's API key is sealed the same way (AES-256-GCM in `data/services.json`, key from
  `cookieSecret`, file `0o600`) and is never returned to the browser (`hasPassword` only). TLS is
  verified by default with an explicit per-service `insecure` opt-out, as with Pi-hole — but
  unlike Pi-hole there is **no** plain-HTTP path at all: TrueNAS permanently revokes any
  user-linked API key presented over insecure transport, so `http:` is rejected by both
  `servicesStore.js` validation and the `POST /api/services/truenas/test` route before a client
  is constructed. Use a **user-linked API key** (Credentials → Users → API Keys) with the
  READONLY_ADMIN role; the integration is read-only and calls no mutating method.
- A UniFi tile's API key is sealed the same way (AES-256-GCM in `data/services.json`, key from
  `cookieSecret`, file `0o600`) and is never returned to the browser (`hasPassword` only). Unlike
  Pi-hole and TrueNAS it offers **three** TLS modes rather than a verified/insecure pair —
  CA-verified, TOFU fingerprint pinning via `tlsPin.js`, or explicit insecure — because a
  controller's certificate is self-signed by default and, unlike an app password, **a UniFi local
  API key inherits its admin account's role and can write to the network**. There is no read-only
  key scope on the local API, so create the key under a **View Only** admin; the integration is
  read-only and issues no verb but `GET`. An `http:` target is refused outright. A pinned
  fingerprint that stops matching is a hard failure — Tmuxifier never re-pins automatically, the
  same posture it takes toward a changed SSH host key.
- An Immich tile's API key is sealed the same way (AES-256-GCM in `data/services.json`, key
  from `cookieSecret`, file `0o600`) and is never returned to the browser (`hasPassword`
  only). Unlike TrueNAS and UniFi, plain `http` is **allowed**, with verified TLS on `https`
  and an explicit per-service `insecure` opt-out — Pi-hole's posture. Neither refusal
  rationale transfers: an Immich key survives plaintext use (TrueNAS revokes one outright)
  and can be scoped read-only (a UniFi local key cannot), while the standard self-hosted
  deployment is plain http on a LAN. Create the key under Account Settings → API Keys with
  only `server.about`, `server.storage`, `server.statistics`, `server.versionCheck`,
  `job.read` and `systemConfig.read`; the integration is read-only and issues no verb but
  `GET`. A key lacking the admin-scoped `server.statistics`/`job.read` still produces a
  working tile — those readings are dropped and named, not treated as an auth failure.
- Service icons are served from two directories the operator controls: `vendor/icons/` (written
  only by `npm run fetch-icons` from a pinned slug list) and `data/icons/` (favicons scraped from
  the LAN services the user configured). The slug is a path component, so it is validated against
  `ICON_SLUG` at the store and re-checked before every read, with the resolved path verified to
  stay inside its directory. Icons are always rendered through `<img>` and never inlined: a
  browser loads SVG in an `<img>` with scripting and external references disabled, which makes
  the content inert regardless of its source. The favicon scrape uses `rejectUnauthorized: false`,
  matching the `http`/`tcp` liveness checks and for the same reason — it sends no credential;
  the credentialed integrations keep verified TLS.
- A changed SSH host key is treated as a possible MITM, not a nuisance: Tmuxifier never clears a
  `known_hosts` entry merely because a connection failed. It is removed only when Tmuxifier can
  prove the old identity is gone or new (verified Proxmox deprovision; provisioning a fresh
  container once its IP is known) or the user explicitly consents via the authenticated
  `POST /api/boxes/:id/forget-hostkey` (confirm-gated in the UI). Ordinary box removal does
  **not** forget a key — the machine still exists and `~/.ssh/known_hosts` is shared with your
  regular ssh usage.
- Box setup now runs server-side over the already-authenticated ControlMaster (`BatchMode`),
  decoupled from the browser tab that started it; a failed setup keeps the box — it is removed
  only via the explicit user action.
- `TMUXIFIER_CLAUDE_OAUTH_TOKEN` joins the `.env` secret class (password hash, cookie secret);
  seeding a box with it (and/or the host's `~/.codex/auth.json`) hands that box your Claude/Codex
  subscription identity, so seed only boxes you trust.
- Voice dictation is off unless `data/voice.json` enables it and a whisper binary and model resolve
  (see `voicePaths.js`) — or the legacy `TMUXIFIER_WHISPER_BIN`/`TMUXIFIER_WHISPER_MODEL` are set,
  which pins them. `TMUXIFIER_VOICE=off` hard-disables it regardless. Transcripts are stripped of
  control characters before reaching `send-keys`, so a transcription artefact cannot emit an
  escape sequence into a pane. Audio is transcribed by a local whisper.cpp process and is never
  sent to Anthropic or any third party — unlike Claude Code's built-in `/voice`.

## Docs

- `README.md` — user-facing overview + quickstart: setup, essential config, the architecture
  diagram, and a short section per feature area linking into `docs/`.
- `docs/configuration.md`, `docs/authentication.md`, `docs/boxes-and-setup.md`,
  `docs/terminal.md`, `docs/dashboard.md`, `docs/fleet-and-health.md`, `docs/proxmox.md` —
  the user-facing deep dives the README links to. Living documentation, maintained alongside
  the code (unlike the point-in-time records below); a feature change that used to update a
  README section now updates the matching guide.
- `DESIGN.md` — the visual authority for the **Instrument** theme (the v1.18.0 redesign, i.e.
  the `:root` token defaults) and for the themes engine's token contract — what a theme may
  override, what must stay a plain literal, what is brand-fixed. Read it before changing
  anything the operator looks at; it outranks ad-hoc styling decisions.
- `PRODUCT.md` — what Tmuxifier is for and who it is for, when a scope question needs settling.
- `AGENTS.md` — this file, adapted for general coding agents (kept in sync with CLAUDE.md).
- `docs/DEPLOY.md` + `deploy/tmuxifier.service` — running it as a systemd service (self-contained
  layout, no secrets in the unit; `HOME` set in the unit so ssh children find `~/.ssh`).
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — point-in-time design/plan records;
  don't rewrite history there, add a new dated doc for new work.
