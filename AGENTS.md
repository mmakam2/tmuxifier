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
  password — all AES-256-GCM sealed — plus container presets), `netbox.json` (NetBox integration
  settings with an **encrypted** API token), `provision-jobs.json` (provision history),
  `setup-jobs.json` (server-side box setup job history), `proxmox-lifecycle-jobs.json` (LXC
  power/deprovision job history), `health-events.json` (in-app health event log),
  `auth-state.json` (the logout session-revocation watermark), `passkeys.json` (enrolled WebAuthn
  credentials, the pinned relying party id, and the passkey-only flag — public keys only, so
  unlike `proxmox.json`/`netbox.json` nothing in it is encrypted, though it's still written
  `0o600`), and SSH ControlMaster sockets under `data/cm/`.
- `vendor/` (gitignored) — the whisper.cpp checkout, its build output, and the downloaded speech
  model, all created by `npm run setup-voice`. Together they take up roughly 1.2 GB;
  `rm -rf vendor/whisper` reclaims it.

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
npm run setup-voice  # builds whisper.cpp + downloads a pinned model into vendor/; writes .env
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
- `debouncedJsonStore.js` — the shared debounced-write store behind the four persisted job
  managers (`fleetStore`/`setupStore`/`provisionStore`/`proxmoxLifecycleStore` are one-line
  wrappers); `whenIdle()` is the graceful-shutdown flush seam.
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
- `server.js` — Fastify app: login rate-limiting, REST under `/api/*`, and the `/term` WebSocket.
  Box setup routes: `POST /api/boxes/:id/setup` (start), `GET /api/setup` (list), `GET
  /api/setup/:id` and `GET /api/boxes/:id/setup` (poll one/by-box). `GET /api/ai-auth/status`
  reports host-side AI-auth seed readiness for the provision forms. The `/term?mode=provision`
  WebSocket is now the on-demand **interactive fallback** for sudo-password boxes — it reports its
  exit code via `setupManager.markInteractiveResult` and no longer rolls back/removes a box on
  failure. Passkey routes (`GET/POST/DELETE /api/passkeys*`, `POST
  /api/auth/passkey/login/begin|finish`) mount unconditionally in **both** auth modes — passkey is
  a third, additive login path, not a third value of `TMUXIFIER_AUTH_MODE`.
- `store.js` — `data/boxes.json` CRUD; normalizes/validates boxes; exports/imports the box list as
  a versioned JSON file (`exportBoxes`/`importBoxes`; import re-mints ids and skips dup/unsafe entries).
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
- `voiceText.js` / `voiceCatalog.js` / `voiceEngine.js` — voice dictation: pure transcript
  normalization (newline collapse is load-bearing — a newline through `send-keys` is Enter),
  the pinned model allowlist with SHA-256 digests (the chokepoint that keeps no user-supplied
  URL or path from reaching a download), and the lazily-spawned whisper.cpp server with an
  idle timeout. `POST /api/voice` transcribes a browser-recorded WAV and types the result into
  the pane via the same `injectVia` guard uploads use. Audio never leaves the host.
- `localShellActions.js` — `createLocalShellActions`: provisions the optional local shell
  (`localShell` = `none`/`omz`/`omb`) that backs a terminal on the Tmuxifier host itself.
- `sessions.js` — PTY lifecycle: PTYs keyed by `boxId`, listeners refcounted, a `graceSeconds`
  window keeps a dropped PTY alive for seamless reconnects, then it's killed while the on-box tmux
  session keeps running.
- `status.js` — per-box reachability/status probes; coalesces concurrent probes of the same box
  (in-flight de-dup) so multiple pollers don't fan out duplicate SSH connections. Each probe also
  reports every tmux session's active-pane command and last-activity time, plus the box's own
  clock, which `healthHistory.js` uses to derive per-session agent idle state without any extra
  SSH round trip.
- `statusPoller.js` — single server-side poll loop: probes every box on an interval
  (`statusPollMs`) and caches the snapshot `/api/status` serves, so status SSH volume is
  independent of how many dashboard tabs are open.
- `fleet.js` / `fleetStore.js` — `createFleetManager` runs one command across many boxes as a single
  persisted, pollable job (Fleet Command), fanning out at `fleetConcurrency`; `createFleetStore` is
  the debounced `data/fleet-jobs.json` persistence.
- `setupManager.js` / `setupStore.js` — `createSetupManager` runs the on-box setup script (tmux +
  shell frameworks + tool catalog from `buildEnsureTmuxRemote`) as a persisted, pollable, resumable
  server-side job over the shared ControlMaster, streaming into a rolling capped log; statuses
  `running`/`done`/`error`/`needs-interactive`/`interrupted`/`superseded` (a stale
  needs-interactive job replaced by a newer run for the same box) — a sudo-password stderr signature
  flips a job to `needs-interactive` for an on-demand interactive finish, and `running` jobs
  reconcile to `interrupted` on restart. Never removes a box on failure (keep-box + retry).
  `createSetupStore` is the debounced `data/setup-jobs.json` persistence (mirrors `provisionStore.js`).
- `healthHistory.js` / `healthEventsStore.js` — `createHealthHistory` keeps a rolling in-memory
  sample series per box (fed by the status poller after each snapshot swap) and derives an
  edge-triggered events log (down/up/needs-auth/threshold, persisted to `data/health-events.json`
  by `createHealthEventsStore`); served by `GET /api/health/series|events`. It also derives a
  per-box agent state (`working`/`waiting`, or `unknown` when the box clock is unavailable) for
  the box's configured session from the status probe's active-pane command and idle time
  (`agentIdleSec` / `TMUXIFIER_AGENT_IDLE_SEC`, default 45s), and emits edge-triggered
  `agent-input`/`agent-done` events — suppressed while that session is attached, since watching
  the terminal is its own notification. `onEvent(cb)` is the deferred server-push delivery seam —
  nothing subscribes to it; browser notifications are instead delivered client-side, by `main.ts`
  polling `GET /api/health/events` and filtering by the kinds enabled in Settings → Notifications
  (`notifyPrefs.ts`).
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
  the create→poll→start→discover→auto-link-box job manager (with an `allocate-ip` NetBox phase
  first for `auto-static` presets; the Fleet job pattern). On box-link it auto-starts a server-side
  setup job (injected `startSetup`, `waitForSsh: true`) so the container is usable without the
  browser staying open.
- `proxmoxInventory.js` — cluster-wide linked-LXC inventory and status authority (one
  `/cluster/resources` call per host); auto-follows node migrations by updating the stored
  link's node (guarded against active lifecycle jobs), and re-homes an orphaned link when a
  removed host profile is re-added with the same endpoint (new id, exact `host:port` match,
  vmid verified on that cluster, same CAS + job guards).
- `proxmoxLifecycle.js` / `proxmoxLifecycleStore.js` — persisted LXC power/deprovision jobs in
  `data/proxmox-lifecycle-jobs.json`; deprovision releases the box's NetBox-allocated IP and
  deletes any remaining NetBox records matching the box's current IP, so manually created
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
- `tlsPin.js` — shared TLS fingerprint-pinning helpers (`tlsProbe`/`pinnedSocket`/`normFp`) used
  by both the Proxmox and NetBox API clients. Pin mode verifies the pinned fingerprint on each
  request's own connection (`pinnedSocket` via `createConnection`) instead of OpenSSL chain
  verification — a served chain that never reaches a self-signed cert (e.g. Caddy's local CA
  serving leaf+intermediate) can't satisfy a rebuilt CA store.
- `netboxValidate.js` / `netboxStore.js` / `netboxApi.js` — NetBox integration settings: pure
  input validators, the sealed `data/netbox.json` store (token AES-256-GCM encrypted, redacted to
  `hasToken` on read), and the `/api/status/` connection probe with ca/pin/insecure TLS modes.
  `createNetboxClient` also serves provisioning: `auto-static` presets reserve the next free IP
  from the VLAN's NetBox prefix (released again on failure or deprovision).

Web client is `src/web/` (TypeScript + xterm.js, bundled by Vite): `main.ts` (also drives the
provision panel, a poll-based setup-job viewer — Retry / Remove / Finish-interactively — now that
setup runs server-side; the login screen also wires the passkey button through the same
`evaluateOrigin` verdict, with a dead-end message when "require a passkey" is armed but this
browser has no usable one), `api.ts`, `terminal.ts`, `index.html`, `style.css`, plus feature modules —
`reconnect.ts` (escalating backoff), `statusDot.ts`, `sparkline.ts`/`healthEvents.ts` (health
history: pure SVG-path builder and event-line formatters), `notifyPrefs.ts` (per-kind
browser-notification preferences, localStorage-backed, defaults all-on except `up`/
`threshold-clear`), `setupOptions.ts` (the shared post-create setup form — Terminal/Tools/AI-auth sections —
used by the Add/Edit Box modal and the hub's Provision tab; fetches `GET /api/ai-auth/status`
to show per-CLI seed readiness with fix-it commands, and disables the seed checkbox only when
both CLIs are unready), `presetSummary.ts` (pure one-line preset description builder),
`setupStatus.ts` (pure setup-status
text/actions/badge helpers shared by the provision panel and the Proxmox hub),
`fleetSelection.ts`/`fleetHistory.ts`/`fleetEditor.ts` (Fleet
Command selection, recent-command history, and the CodeMirror bash-script editor),
`fleetPoll.ts` (the generation-guarded fleet job-detail poll loop — a stale response can
neither paint over nor stop the newer selection's polling), `interactiveLauncher.ts`
(at-most-one live "Finish interactively" setup terminal, shared by the provision panel and the
hub), `modalRegistry.ts` (body-mounted modals register their close() so logout/session-expiry
teardown reaches them), `setupPoller.ts` (the generation-guarded setup-job poll loop shared by
the provision panel and the hub — the injected policy renders and returns the next delay),
`proxmox.ts`/`proxmoxUi.ts` (the Proxmox fetch layer and operations-only hub shell: Containers,
Presets, Provision, and Activity tabs — host/secret setup lives in the settings modal;
`proxmoxUi.ts`'s Provision tab polls the server-side setup job once a box links),
`proxmoxPresets.ts` (the Presets tab's master-detail create/edit/delete form, dependent Proxmox
loaders, stale saved-option fallbacks, and additional-disk modal; the `auto-static` IP mode is
offered only once NetBox is configured),
`proxmoxContainers.ts` (the Containers tab's linked-LXC list with state-gated lifecycle actions and
the deprovision confirm dialog), `proxmoxActivity.ts` (the Activity tab merging provision and
lifecycle jobs newest-first), `proxmoxAssociation.ts` (the Add/Edit Box modals' manual Proxmox
link/unlink picker — hidden until a Proxmox host profile exists, except for already-linked
boxes), `settingsUi.ts` (the ⚙ settings
modal's tabbed shell, with NetBox (`settingsNetbox.ts`), Proxmox host/secret
(`settingsProxmox.ts`), Passkeys (`settingsPasskeys.ts`: readiness row, enrolled-credential list
with remove — confirm-gated by one modal; removing the last credential while "require a passkey"
is armed adds only an extra explanatory paragraph to that same modal, not a second gate — and the
sign-in policy toggle, where only *arming* is confirm-gated since disarming can only restore
access), and Notifications (`settingsNotifications.ts`:
browser-notification permission flow plus per-kind toggles) tabs) with `settingsForm.ts` (pure
payload/result helpers), `netbox.ts` (fetch layer), `passkeys.ts` (passkey fetch layer,
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
shape as `passkeys.ts`'s `evaluateOrigin` — the hotkey predicates, the mic button, and the
controller), and `voiceWorklet.js` (the AudioWorklet processor, shipped as a real Vite-emitted
static asset rather than a blob: URL, specifically so the Content-Security-Policy can stay
`script-src 'self'`).

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
- Password and OAuth modes are mutually exclusive **with each other**: password mode mounts
  `POST /api/login`; OAuth mode mounts `/api/auth/google/*` instead and removes the password
  login path. A passkey is a third, additive login path that mounts in **both** modes regardless
  of `TMUXIFIER_AUTH_MODE` — it is not a value of that setting.
- OAuth is hand-rolled OIDC in `googleAuth.js`: state cookie + PKCE, token exchange
  server-to-server, then exact-email allowlist. The id_token payload is trusted because it is
  fetched directly from Google's token endpoint over TLS in the authorization-code flow.
- In OAuth mode, a passkey login never consults `TMUXIFIER_ALLOWED_EMAILS` — it authenticates a
  device credential, not a Google identity. Removing an email from the allowlist does **not**
  revoke a passkey already enrolled under that account; the passkey itself must be removed from
  Settings → Passkeys. Enrollment requires an authenticated session (password/Google remains the
  bootstrap and the recovery route), so this is not a privilege-escalation path — just a separate
  revocation step to remember.
- Passkeys' opt-in "require a passkey" toggle (`passkeyStore.js`'s `passkeyOnly` flag) disables
  password and Google sign-in entirely, so arming it is guarded three ways against locking the
  operator out: it is refused with a 409 unless at least one credential is enrolled **and** the
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
- Voice dictation is off unless both `TMUXIFIER_WHISPER_BIN` and `TMUXIFIER_WHISPER_MODEL` are
  set, and `TMUXIFIER_VOICE=off` hard-disables it regardless. Transcripts are stripped of
  control characters before reaching `send-keys`, so a transcription artefact cannot emit an
  escape sequence into a pane. Audio is transcribed by a local whisper.cpp process and is never
  sent to Anthropic or any third party — unlike Claude Code's built-in `/voice`.

## Docs

- `README.md` — user-facing setup/config/security.
- `CLAUDE.md` — canonical project instructions (this file is kept in sync with it).
- `docs/DEPLOY.md` + `deploy/tmuxifier.service` — running it as a systemd service (self-contained
  layout, no secrets in the unit; `HOME` set in the unit so ssh children find `~/.ssh`).
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — point-in-time design/plan records;
  don't rewrite history there, add a new dated doc for new work.
