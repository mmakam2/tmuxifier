# <img src="src/web/assets/tmuxifier-logo.png" alt="" width="36" height="36" style="vertical-align:middle" /> tmuxifier

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A single-user web dashboard for managing headless boxes over SSH. Each box opens a
browser terminal backed by a tmux session that lives **on the box**, so closing the tab,
losing the network, or restarting Tmuxifier leaves your work running — reconnecting drops you
back into the same state.

## Screenshots

| Persistent remote terminals | Fleet standby dashboard |
|:---:|:---:|
| [![A browser terminal docked in Tmuxifier, attached to a tmux session running on the box, showing a test suite run to completion with the tmux status bar along the bottom](docs/screenshots/terminal-v1.19.png)](docs/screenshots/terminal-v1.19.png) | [![Tmuxifier's standby dashboard: a fleet grid showing each box's reachability and session count, beside a sidebar of boxes grouped by tag with CPU, memory, and disk readouts](docs/screenshots/dashboard-v1.19.png)](docs/screenshots/dashboard-v1.19.png) |
| The tmux session runs on the box, not in the browser — close the tab or lose the network and the work carries on. Reconnecting reattaches it. | The standby dashboard fills the stage whenever no terminal is docked — click any box to reattach to its on-box tmux session. |

| Fleet Command | Proxmox LXC provisioning |
|:---:|:---:|
| [![Fleet Command job history with an apt update run across 17 boxes, showing per-box exit status and captured output](docs/screenshots/fleet-command-v1.19.png)](docs/screenshots/fleet-command-v1.19.png) | [![Tmuxifier Proxmox LXC provisioning workflow](docs/screenshots/proxmox-provision-v1.19.png)](docs/screenshots/proxmox-provision-v1.19.png) |
| Select boxes by group, run a command or bash script with bounded concurrency, and inspect each result. | Provision from reusable presets, inject management keys, discover the container, and link it back as a Tmuxifier box. |

## Requirements
- Node 20+
- The OpenSSH client, with your keys/agent/`~/.ssh/config` already working from the shell
- Tmuxifier installs `tmux` when a box is added if the remote user is root or has passwordless
  `sudo` for the system package manager

## Setup
```bash
npm install
npm run build
npm run set-password   # writes the password hash + cookie secret into ./.env
npm start
```
Open http://127.0.0.1:7437.

Configuration lives in a gitignored **`.env` file in the repo root**, so Tmuxifier is
self-contained — nothing needs to be set in your shell. `npm run set-password` creates (or
updates) `.env` with `TMUXIFIER_PASSWORD_HASH` and `TMUXIFIER_COOKIE_SECRET`; re-running it
changes the password while keeping the existing cookie secret (so you stay logged in). Copy
`.env.example` to `.env` first if you want to set other options up front.

## Configuration
All options are read from `.env` in the repo root (see `.env.example`). Each key can also be
set as a real shell environment variable, which **overrides** the file. Precedence, low to
high: built-in defaults → `config.json` → `.env` → shell environment.

| Key | Env / `.env` key | Default |
| --- | --- | --- |
| bind address | `TMUXIFIER_BIND` | `127.0.0.1` |
| port | `TMUXIFIER_PORT` | `7437` |
| grace seconds | `TMUXIFIER_GRACE` | `45` |
| host-key policy | `TMUXIFIER_HOSTKEY_POLICY` | `accept-new` |
| status probe concurrency | `TMUXIFIER_STATUS_CONCURRENCY` | `4` |
| status poll interval (ms) | `TMUXIFIER_STATUS_POLL_MS` | `30000` |
| service check sweep interval (ms, min 5000) | `TMUXIFIER_SERVICE_POLL_MS` | `30000` |
| SSH ControlPersist seconds | `TMUXIFIER_CONTROL_PERSIST` | `600` |
| terminal font family | `TMUXIFIER_TERM_FONT` | (bundled font) |
| terminal font size (px) | `TMUXIFIER_TERM_FONT_SIZE` | `12` |
| fleet command concurrency | `TMUXIFIER_FLEET_CONCURRENCY` | `4` |
| fleet per-box timeout (ms) | `TMUXIFIER_FLEET_TIMEOUT_MS` | `15000` |
| fleet job history kept | `TMUXIFIER_FLEET_MAX_JOBS` | `50` |
| fleet per-box output cap (bytes) | `TMUXIFIER_FLEET_MAX_OUTPUT_BYTES` | `65536` |
| health history samples/box | `TMUXIFIER_HEALTH_HISTORY_MAX` | `120` |
| health events retained | `TMUXIFIER_HEALTH_EVENTS_MAX` | `200` |
| health cpu/mem/disk warn % | `TMUXIFIER_HEALTH_{CPU,MEM,DISK}_WARN_PCT` | `90` |
| health threshold hysteresis % | `TMUXIFIER_HEALTH_HYSTERESIS_PCT` | `5` |
| agent idle threshold (s) | `TMUXIFIER_AGENT_IDLE_SEC` | `20` |
| Proxmox task poll interval (ms) | `TMUXIFIER_PVE_POLL_MS` | `1500` |
| Proxmox per-request timeout (ms) | `TMUXIFIER_PVE_TIMEOUT_MS` | `15000` |
| Proxmox provision timeout (ms) | `TMUXIFIER_PVE_PROVISION_TIMEOUT_MS` | `600000` |
| Proxmox DHCP-lease wait (ms) | `TMUXIFIER_PVE_LEASE_TIMEOUT_MS` | `60000` |
| Proxmox provision job history kept | `TMUXIFIER_PVE_MAX_JOBS` | `50` |
| Proxmox default management pubkey | `TMUXIFIER_PVE_DEFAULT_PUBKEY` | auto-detect `~/.ssh/*.pub` |
| trust reverse-proxy X-Forwarded-For | `TMUXIFIER_TRUST_PROXY` | off |
| auth mode | `TMUXIFIER_AUTH_MODE` | `password` |
| password hash | `TMUXIFIER_PASSWORD_HASH` | — (required) |
| cookie secret | `TMUXIFIER_COOKIE_SECRET` | — (required) |
| base external URL | `TMUXIFIER_BASE_EXTERNAL_URL` | (none) |
| OAuth client id | `TMUXIFIER_OAUTH_CLIENT_ID` | (none) |
| OAuth client secret | `TMUXIFIER_OAUTH_CLIENT_SECRET` | (none) |
| allowed Google emails | `TMUXIFIER_ALLOWED_EMAILS` | (none) |
| passkey relying party id | `TMUXIFIER_RP_ID` | derived from base external URL, else `localhost` |
| passkey-only break-glass | `TMUXIFIER_PASSKEY_ONLY` | (unset) |
| data dir | `TMUXIFIER_DATA_DIR` | `<repo>/data` |
| control-socket dir | `TMUXIFIER_CONTROL_DIR` | `<dataDir>/cm` |
| ssh config for Tmuxifier SSH calls | `TMUXIFIER_SSH_CONFIG` | (none) |
| path to TLS cert (PEM file) | `TMUXIFIER_TLS_CERT` | (none → serves HTTP) |
| path to TLS key (PEM file) | `TMUXIFIER_TLS_KEY` | (none → serves HTTP) |
| terminal upload size limit (MB) | `TMUXIFIER_UPLOAD_MAX_MB` | `25` |
| whisper.cpp server binary path (escape hatch; pins the control in Settings → Voice) | `TMUXIFIER_WHISPER_BIN` | (none → use the vendored build) |
| whisper speech model path (escape hatch; pins the model picker in Settings → Voice) | `TMUXIFIER_WHISPER_MODEL` | (none → use the model chosen in Settings) |
| voice dictation kill switch | `TMUXIFIER_VOICE` | (unset) |
| whisper idle shutdown (ms) | `TMUXIFIER_VOICE_IDLE_MS` | `600000` |
| voice upload size limit (MB) | `TMUXIFIER_VOICE_MAX_MB` | `8` |
| voice dictation max length (s) | `TMUXIFIER_VOICE_MAX_SECONDS` | `120` |

Set **both** `TMUXIFIER_TLS_CERT` and `TMUXIFIER_TLS_KEY` to serve HTTPS directly; when TLS is active
the session cookie is automatically marked `Secure`. An `https://` `TMUXIFIER_BASE_EXTERNAL_URL`
also marks it `Secure` for deployments behind a TLS-terminating proxy or tunnel.

When Tmuxifier sits behind a reverse proxy or tunnel, also set `TMUXIFIER_TRUST_PROXY` (`true`, a
hop count, or a comma-separated address/CIDR list) so login rate limiting sees each client's real
IP from `X-Forwarded-For` instead of bucketing everyone under the proxy's address. Leave it unset
when clients connect directly — trusting forwarded headers from a non-proxy lets clients spoof
their IP.

As an alternative to `.env`, a `config.json` in the repo root works too, using camelCase keys
(`passwordHash`, `cookieSecret`, `bindAddress`, `port`, `graceSeconds`, `hostKeyPolicy`, `trustProxy`,
`statusConcurrency`, `statusPollMs`, `servicePollMs`, `controlPersist`, `termFont`, `termFontSize`, `fleetConcurrency`, `fleetTimeoutMs`,
`fleetMaxJobs`, `fleetMaxOutputBytes`, `healthHistoryMax`, `healthEventsMax`, `healthCpuWarnPct`,
`healthMemWarnPct`, `healthDiskWarnPct`, `healthThresholdHysteresisPct`, `agentIdleSec`, `pvePollMs`, `pveTimeoutMs`, `pveProvisionTimeoutMs`,
`pveLeaseTimeoutMs`, `pveMaxJobs`, `pveDefaultPubKeyPath`, `authMode`, `publicUrl`, `rpId`,
`passkeyOnlyKillSwitch`, `googleClientId`, `googleClientSecret`, `allowedEmails`, `dataDir`,
`controlDir`, `sshConfigFile`, `tlsCert`, `tlsKey`). The UI also persists `localShell` in
`config.json`; it does not have an env key.
`TMUXIFIER_SSH_CONFIG`/`sshConfigFile` is passed to `ssh` as `-F`, so it is an alternate config
file for Tmuxifier's SSH commands, not an extra file merged with `~/.ssh/config`.
Unlike the `.env` string form (`TMUXIFIER_PASSKEY_ONLY`, which additionally accepts `0`, `no` or
`false` alongside `off`), the `config.json` key `passkeyOnlyKillSwitch` is a plain boolean —
`true` engages the break-glass kill switch, `false` or an absent key does not.

`TMUXIFIER_TERM_FONT` sets the font for the browser **terminal sessions** (not the dashboard
chrome). It is a single family name, prepended to the bundled font stack, so it must be installed
on the device viewing the dashboard — otherwise that device transparently falls back to the bundled
**MesloLGMDZ Nerd Font** (Line Gap Medium, dotted zero, the default terminal font). An unsafe or
empty value is ignored. The bundled fonts (MesloLGMDZ, then MesloLGSDZ and JuliaMono) always remain
as the fallback, so symbol glyphs (e.g. Claude Code's UI) keep rendering regardless of the choice.

**Settings → Boxes** has **export** and **import** buttons that download and upload the full box
list as a JSON file — a portable backup you can move between Tmuxifier instances. Import adds boxes
from the file, re-minting each id and skipping any whose host/label already exists (so re-importing
is safe).
It carries no SSH secrets; boxes still rely on your keys/agent/`~/.ssh/config` at connect time.
The sidebar itself and each tag group can be collapsed (‹ next to the brand, click a group
header); both states persist across reloads.

A ⚙ **settings** modal (top of the sidebar) has six tabs: **Boxes** (box-list export/import,
above), **NetBox** (an http/https selector +
host and token — the TLS options, including fingerprint pinning for self-signed certs, appear
only for https — plus a connection test; also powers `auto-static` IP allocation during
provisioning), **Proxmox** (host profiles and LXC secrets), **Passkeys** (enroll, remove, and the
optional "require a passkey" sign-in policy), **Voice** (whisper.cpp install, model choice, and a
mic test), and **Notifications** (browser
notification permission and per-event-kind toggles); see
[Proxmox LXC provisioning](#proxmox-lxc-provisioning) below for NetBox and Proxmox details,
[Passkeys](#passkeys) for the sign-in policy, and [Voice dictation](#voice-dictation) for the
install flow.

## Authentication
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

### Passkeys

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

## How persistence works
Each terminal runs `ssh -tt <box> "tmux -u new-session -A -D -s <session>"` (`-u` forces UTF-8
output so glyphs survive a C/POSIX locale; `-D` detaches any
other client so a stale connection can't freeze the layout). `<session>` is the box's tmux session
name — set per box in the Add/Edit dialog (a type-or-pick field whose ⟳ button fetches the host's
live sessions), defaulting to `web`. Because tmux runs on the box, the session and its processes
survive disconnects. A 45s server-side grace window makes brief reconnects seamless; after that
the local ssh process is dropped while the on-box session keeps running.

When a box is added, Tmuxifier persists the box immediately and opens a live provisioning
panel. That provisioning flow checks for `tmux`, installs it through a known package manager
when possible (`apt-get`, `dnf`, `yum`, `pacman`, `apk`, or `zypper`), applies any selected
shell/theme options, and creates the configured tmux session. If provisioning exits non-zero,
the new box is rolled back from the list. Removing a box closes any local terminal process for
that box and best-effort kills the configured remote tmux session before deleting the box.

The Add/Edit Box modal (and the Proxmox Provision form below) also offer an **"Additional
tools"** checklist that runs in the same provisioning step — a full system update/upgrade,
curl, git, the GitHub CLI, Node.js + npm, Bubblewrap, and the Codex, Claude Code, and
Antigravity CLIs — using the same idempotent multi-distro install script, so re-running
provisioning skips anything already installed.

Below that checklist sits **"Push Claude Code statusline"** (unchecked by default). Ticking it
copies *this host's own* Claude Code statusline script to the box and merges a `statusLine` block
into the box's `~/.claude/settings.json`, preserving every other key in that file. The box decides
whether it applies: with no Claude Code installed there the push is a recorded no-op, so ticking it
for a box that gets Claude Code later takes effect the next time setup runs. It runs after the
setup job's other work, and a skip or failure is recorded on the job without failing it.

Both surfaces also offer a **"Seed AI CLI auth (claude/codex) from this host"** checkbox
(unchecked by default). Ticking it copies the *Tmuxifier host's own* AI CLI subscription
credentials onto the box once its setup job reports done: a Claude Code OAuth token and/or the
host's live Codex login. This needs one-time setup on the Tmuxifier host itself, per CLI you want
seeded — skip either one and that target is silently skipped per box:
- **Claude**: run `claude setup-token` on the Tmuxifier host and put its output in `.env` as
  `TMUXIFIER_CLAUDE_OAUTH_TOKEN=sk-ant-oat-EXAMPLE`.
- **Codex**: run `codex login` on the Tmuxifier host so `~/.codex/auth.json` exists there —
  Tmuxifier reads it live at seed time and never stores a copy of its own.

The form shows per-CLI readiness next to the checkbox — a CLI that isn't set up on the
Tmuxifier host shows the exact command to run (`claude setup-token` / `codex login`), and the
checkbox is disabled when there is nothing to seed yet.

Either secret travels to the box over stdin on the same SSH connection used for provisioning —
never in a command line, a script file, a log, or an API response. **Seeding hands that box your
Claude and/or Codex subscription identity, exactly as if you'd logged in on it yourself — seed
only boxes you trust the way you'd trust anyone holding your own login.**

## Standby dashboard

When no terminal is docked, the stage shows a standby dashboard instead of a blank screen:

- **Service tiles** — your homelab's web services (Grafana, a NAS UI, anything with a URL),
  managed under Settings (⚙) → Services. Each tile is a name, an automatically resolved logo, a
  parent section (Services or Infrastructure) with an optional category within it (e.g.
  Services → DNS Filtering; under Infrastructure, the categories "Proxmox" and "IPAM" merge
  the tile into those built-in groups), a link that opens in a new tab, and an optional
  liveness check — an HTTP(S) GET
  (2xx/3xx = up) or a bare TCP connect for non-web services (DNS, MQTT, …). Checks run
  **server-side** on one shared sweep (`TMUXIFIER_SERVICE_POLL_MS`, default 30s, min 5s) and
  the dashboard reads a cached snapshot, so check volume doesn't scale with open tabs. HTTPS
  checks tolerate self-signed certificates — they answer "is it up", not "is it authentic".
  Tiles persist in `data/services.json`; the secrets it can hold — a Pi-hole app password, a
  TrueNAS API key, a UniFi API key, an Immich API key — are all encrypted (see below).

### Tile icons

Tiles find their own logos. A tile's icon is resolved from its check kind first (a UniFi,
TrueNAS, Pi-hole or Immich check identifies the software outright), then from the service name, then
from the first label of its URL — so a service called "Grafana", or one living at
`https://grafana.example.com/`, gets the Grafana logo without being told.

```bash
npm run fetch-icons   # one-time; downloads the logo catalog into vendor/icons/
```

The catalog is a pinned list of common self-hosted apps, fetched once. **The running server
never contacts the internet for icons** — it reads the directory this leaves behind. Skipping
the command costs the catalog, not the feature: anything unmatched falls back to a favicon
scraped from the service's own URL, which is LAN traffic to a host you already configured.

Settings → Services can override the guess per tile — **Auto**, **Choose** (a filterable grid
of the catalog), or **None** to suppress the icon — and **Refresh icon** re-scrapes the
service's favicon on demand.
- **Fleet overview** — one cell per box: status lamp, agent working/waiting chip, session
  count, and the CPU sparkline. Clicking a cell opens that box's terminal.
- **Infrastructure readout** — a Proxmox group showing each physical cluster node's health
  (online lamp, cpu/mem/disk, linked-container tally) and, when NetBox is configured, an
  IPAM group with utilization for each IPv4 prefix NetBox knows (first 100).

On a fresh install (no boxes, no services) the dashboard collapses to the original standby
prompt with the `+ Add box` hint.

The tmuxifier nameplate in the sidebar's top-left is the home key: clicking it returns to the
dashboard. Docked terminals undock but keep running — clicking a box re-docks it.

### Pi-hole tiles

A service tile whose check is **Pi-hole** reads the Pi-hole v6 API and renders a double-width
card with blocking status, queries today, blocked share, active/total clients, gravity domain
count, version, and uptime instead of a plain up/down lamp.

1. On the Pi-hole, go to **Settings → Web interface / API → Configure app password** and create
   an app password. (The web login password also authenticates, but an app password is scoped to
   the API and keeps working when two-factor authentication is enabled.)
2. In Tmuxifier, open **Settings (⚙) → Services**, add or edit the tile, choose the **Pi-hole**
   check, and paste the app password. Leave the API base URL blank unless the API lives somewhere
   other than the tile's link URL.
3. Press **Test connection** to confirm the credential before saving.

The password is encrypted at rest (AES-256-GCM, key derived from the cookie secret) and is never
sent back to the browser. Unlike the plain HTTP/TCP checks, TLS is **verified** — tick "Allow a
self-signed certificate" if your Pi-hole serves one. The integration is read-only: it never
enables or disables blocking. Pi-hole v5 (`admin/api.php`) is not supported.

### TrueNAS tiles

A service tile whose check is **TrueNAS** reads your NAS over its JSON-RPC WebSocket API and
renders a double-width card with one row per ZFS pool — name, used percentage, free space —
under a chip showing the worst pool health and the active alerts by severity (`healthy ·
1 critical, 2 warnings`), with the TrueNAS version and host uptime beneath. The chip names the
severity rather than giving a bare total, so it explains the lamp colour rather than leaving you
to guess which reading caused it.

The lamp is a glance signal, not just a reachability light:

| Lamp | Meaning |
|---|---|
| green | every pool online and healthy, no active alert, every pool under 80% used |
| amber | a pool is degraded, a warning-level alert is outstanding, or a pool has passed 80% |
| red | unreachable, a pool is faulted, an error-level alert is outstanding, or a pool has passed 90% |
| violet | the API key was rejected, has expired, or the account requires a one-time password |

Onboarding needs three things — the NAS URL, the username the API key belongs to, and the key:

1. On the TrueNAS, go to **Credentials → Users → API Keys** and create a user-linked key with the
   **READONLY_ADMIN** role. Note which account it belongs to; the login call needs the username
   alongside the key.
2. In Tmuxifier, open **Settings (⚙) → Services**, add or edit the tile, choose the **TrueNAS**
   check, and fill in the username and key. Leave the API base URL blank unless the API lives
   somewhere other than the tile's link URL.
3. Press **Test connection** to confirm the credential before saving.

The URL must be `https://`. TrueNAS **permanently revokes** any user-linked API key presented
over plain HTTP, so Tmuxifier refuses an `http://` TrueNAS URL outright rather than risk your
credential — this is not something you can opt out of. A self-signed certificate is fine: tick
"Allow a self-signed certificate". The key is encrypted at rest (AES-256-GCM, key derived from
the cookie secret) and is never sent back to the browser.

Requires TrueNAS 25.04 or later, which is where the JSON-RPC WebSocket API replaced the REST API
(removed outright in TrueNAS 26). The integration is read-only and never changes anything on the
NAS — not even dismissing an alert.

### UniFi tiles

A service tile whose check is **UniFi** reads your controller's Network Integration API and
renders a double-width card: a six-cell census (clients, wired, wireless, networks, WAN
throughput, gateway uptime) over one row per device class — the gateway named with its own CPU
and memory, switches and access points tallied. The chip summarises WAN state and how many
adopted devices are online; a device that goes offline is **named** on its own line rather than
being reduced to a smaller count.

1. In the UniFi Network application, go to **Control Plane → Integrations** and create an API
   key. A UniFi local API key inherits the role of the admin account that created it, and the
   local API has **no read-only key scope**, so create it under a **View Only** admin. Tmuxifier's
   client only ever issues `GET` — it can adopt nothing, restart nothing, and change no rule —
   but the key itself is only as limited as the account behind it.
2. In Tmuxifier, open **Settings (⚙) → Services**, add or edit the tile, choose the **UniFi**
   check, and paste the key. Leave **Site** blank unless your controller hosts more than one.
3. Press **Test connection**. It confirms the key, lists the sites it can see, and — in pin mode
   — captures the certificate fingerprint for you.

The URL must be `https://`; an `http://` controller URL is refused, because the key can write to
your network. Because a controller serves a self-signed certificate by default, this tile offers
three TLS choices rather than the single "allow a self-signed certificate" checkbox the other
tiles use:

- **Verify certificate** — the default. Right if your controller presents a CA-trusted cert.
- **Pin this certificate** — trust on first use, like `ssh accept-new`. Test connection captures
  the fingerprint, you save it, and every later request checks it on its own connection. This is
  the recommended setting for a default self-signed controller: it works without ever trusting an
  unverified connection, and a swapped certificate fails loudly instead of silently. Tmuxifier
  never re-pins by itself — if the fingerprint changes you must Test and accept the new one.
- **Accept any certificate** — no verification at all. Available, explicit, and off by default.

The key is encrypted at rest (AES-256-GCM, key derived from the cookie secret) and is never sent
back to the browser. Requires UniFi Network 9.0 or later, where the Integration API landed.

### Immich tiles

A service tile whose check is **Immich** reads your photo server's REST API and renders a
double-width card: photos, videos, library size, disk used, disk free and server version across
six cells, with rows for the job queues, the user census, and an available update when there is
one. The chip reports library size and job state.

1. In Immich, go to **Account Settings → API Keys** and create a key. Immich supports granular
   permissions, so grant only what the card reads: `server.about`, `server.storage`,
   `server.statistics`, `server.versionCheck`, `job.read` and `systemConfig.read`.
2. In Tmuxifier, open **Settings (⚙) → Services**, add or edit the tile, choose the **Immich**
   check, and paste the key. Leave the probe URL blank to reuse the tile's own link.
3. Press **Test connection**. It confirms the key and names any permission it could not use.

`server.statistics` and `job.read` are admin-scoped. A key without them still produces a working
tile — the library and job readings are dropped and the card says which permission is missing,
rather than the tile going red. A wrong or revoked key is different: that shows the violet
"needs auth" lamp, the same as the other credentialed tiles.

Plain `http://` is allowed here, unlike the TrueNAS and UniFi tiles. Neither of their reasons for
refusing it applies: an Immich key is not revoked by being sent in the clear, and it can be scoped
read-only, while the usual self-hosted Immich sits on a LAN at `http://host:2283`. Over `https://`
the certificate is verified by default, with the same "allow a self-signed certificate" checkbox
the Pi-hole tile uses.

The key is encrypted at rest (AES-256-GCM, key derived from the cookie secret) and is never sent
back to the browser. The integration is read-only and issues no HTTP verb but `GET`. Requires
Immich v1.118 or later, where the API moved to `/api/server/*`.

## Split terminals

Up to four boxes can share the stage, and splits nest. Drag a box row onto the stage:
dropping on the stage's outer edge splits the whole stage (a full-width or full-height
pane — two side-by-side terminals with a third across the bottom, say), dropping near an
individual pane's edge splits just that pane, and dropping on a pane's center replaces it.
The row's ◫ **Dock** button (visible while the stage has room) is the keyboard path. Every
divider drags to resize its own split (double-click resets 50/50, arrow keys work when it's
focused, and its small ⤢ control flips that split's direction). Every terminal pane — split
or not — carries a header bar: status dot, box name, and `user@host` on the left; on the
right a state chip (agent **working**/**waiting** from the health poller, or connection
state while the terminal reconnects) beside the voice, reconnect ↻, and — in a split —
undock ✕ buttons, so nothing floats over the terminal itself. The focused pane's bar
carries the cyan beacon, `Ctrl+Shift+Arrow` moves focus to the geometrically adjacent pane,
and plain-clicking another box in the sidebar replaces the **focused** pane while the
others keep running. Undocking keeps the terminal connected in the background, exactly like
switching away, and the neighboring pane absorbs the space. The whole arrangement — shape,
directions, and ratios — survives reloads; docked boxes' sidebar rows show the cyan beacon,
with the focused one at full strength.

## Pasting images & files

Pasting an image (Ctrl/Cmd+V) or dropping any file onto a terminal uploads it to
`~/.tmuxifier-uploads/` on that box over the existing SSH connection (the local
shell terminal writes to the Tmuxifier host instead). Tmuxifier then checks what
the pane is doing before typing anything: at a Claude Code or shell prompt it
types the quoted path into the tmux pane itself — so the path appears in every
attached tmux client, not just the browser tab — and shows a tmux status
message. If the pane is busy (vim, a running build), nothing is typed; the path
is shown in a tmux message and in the browser instead. Text paste is unchanged,
and nothing needs to be installed on your own machine or the boxes.

Uploaded files older than 24 hours are cleaned up automatically on the next
upload to that machine. The size limit is 25 MB by default
(`TMUXIFIER_UPLOAD_MAX_MB`).

**Copying out of a terminal:** selecting text copies it to your clipboard
automatically (plus Cmd+C on macOS, Ctrl+Shift+C elsewhere; both need an HTTPS
dashboard). When a full-screen app owns the mouse — Claude Code, vim, tmux
copy-mode — a plain drag goes to the app instead of selecting: either hold
**Shift** while dragging to select in the browser, or just use the app's own
copy — Tmuxifier understands OSC 52, so in-app copies (a tmux copy-mode yank,
Claude Code's selection copy) land on your system clipboard too.

## Voice dictation

Tap **Ctrl+Shift+Space** in any terminal to start dictating, and tap it again to stop: your
browser records audio from your microphone in between, sends it to Tmuxifier on the second tap,
and the transcribed text is typed into the pane — the same way a pasted file path is typed in
(see [Pasting images & files](#pasting-images--files) above). The mic button next to the terminal
works the other way — click and hold it, then release to transcribe — since a physical button has
an unambiguous release and a key chord doesn't.

This is not the same thing as Claude Code's own `/voice` command, and `/voice` cannot work on a
headless box: it opens an audio device on the machine the CLI process runs on, and a box managed
by Tmuxifier has no microphone of its own — it's a remote machine you're SSHed into, often
running unattended. Tmuxifier's voice dictation instead captures audio in *your* browser, where
the microphone actually is, and only ships the recording to the Tmuxifier host for transcription.

Install it from **Settings → Voice**. The tab installs [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
into a repo-local `vendor/whisper/` directory and downloads a speech model from a small pinned
allowlist (verified by SHA-256 before it's written to disk — no user-supplied URL or path is ever
accepted). The install runs on the server as a background job with a live log, so you can close
the modal or navigate away while it works; it takes roughly two minutes and about 1.2 GB of disk.
The same tab has the on/off switch and the model picker, and both take effect immediately.

After turning voice **on**, reload the page. Browsers apply the microphone permission policy when
a page loads, so a tab that was open while voice was off keeps the old policy until it's
reloaded.

There is an equivalent command-line path for headless setups:
```bash
npm run setup-voice           # or: npm run setup-voice -- <model-id>
```

Settings are stored in `data/voice.json` and read on every request, which is why changes apply
without a restart. `TMUXIFIER_VOICE=off` in `.env` disables voice entirely regardless of what's
installed. `TMUXIFIER_WHISPER_BIN` and `TMUXIFIER_WHISPER_MODEL` are escape hatches for pointing
at a whisper build you manage yourself — setting either one overrides the corresponding control,
which the Settings tab then shows as pinned rather than leaving you with a picker that appears to
do nothing.

Microphone access is a browser security-sensitive permission and requires a secure context:
dictation works automatically when Tmuxifier is reached at `http://127.0.0.1:...` or
`http://localhost:...`, but from any other address you need HTTPS — see `TMUXIFIER_TLS_CERT`/
`TMUXIFIER_TLS_KEY` or a TLS-terminating reverse proxy in [Configuration](#configuration).

Audio never leaves the host: transcription runs locally via the whisper.cpp process Tmuxifier
spawns, not a cloud API, and nothing is sent to Anthropic or any other third party — unlike
Claude Code's built-in `/voice`.

The installed engine and model together take up roughly 1.2 GB under `vendor/`. Run
`rm -rf vendor/whisper` at any time to remove them and reclaim the disk space; re-run
`npm run setup-voice` — or Settings → Voice — later to reinstall.

## Host Shell & per-box Reconnect
The **Host Shell** entry at the bottom of the sidebar opens a terminal on the Tmuxifier host
itself, backed by a local tmux session (`local`) with the same reattach-on-reconnect behavior as
a box. Its ✎ button picks an optional shell framework — None, Oh My Zsh, or Oh My Bash — which
Tmuxifier installs locally when selected; the choice is persisted as `localShell` in
`config.json` (set by the UI — there is no env key). Its ↻ button kills the local tmux session
and starts a fresh one with the current framework.

Every box row also has a ↻ **Reconnect** action. It tears down the box's SSH plumbing — shuts
the ControlMaster down cleanly (removing its socket), drops the local PTY, best-effort kills the
configured remote tmux session, and clears the status-probe backoff — then reopens the terminal.
Use it when a box's connection state looks wedged (e.g. stuck red after a network change) or to
force a fresh login; on-box work in *other* tmux sessions is untouched.

If a box's SSH host key changes (e.g. it was rebuilt at the same address), ssh's own
man-in-the-middle defense refuses the connection: the dot stays red but its tooltip reads "Host
key changed — verify the box," and the row gains a ⚷ **Forget host key** action. It's
confirm-gated — only use it once you've verified the rebuild yourself — and removes the stale
`~/.ssh/known_hosts` entry, then reopens the terminal for a fresh key exchange. Tmuxifier never
clears a `known_hosts` entry just because a connection failed: the only automatic clearing
happens when Tmuxifier itself proves the old machine is gone (a verified Proxmox deprovision) or
just created the new one (provisioning a container onto a freshly assigned address, e.g. a
NetBox-recycled IP); ordinary box removal leaves `known_hosts` untouched since it's shared with
your regular ssh usage.

## Status, multiplexing & rate-limit safety
Tmuxifier talks to each box over SSH continuously — a background **status probe** keeps the
sidebar dots current, and each open terminal is another SSH connection. Left naive, that churn
(a fresh handshake, plus a failed auth on password boxes, every few seconds) is exactly what
trips a box's brute-force protection — `fail2ban`, `sshguard`, or a connection-rate firewall
rule — and gets the Tmuxifier host's IP **banned**, which then makes the box look dead. Several
mechanisms keep the connection rate low and reuse one warm connection:

- **One shared poll, not one per tab.** Status is probed by a single **server-side** loop (every
  `TMUXIFIER_STATUS_POLL_MS`, default 30s); every open dashboard tab reads the same cached snapshot
  instead of driving its own probe cycle, so the SSH connection rate does **not** multiply with the
  number of tabs you leave open. Concurrent probes of the same box are also coalesced into one
  connection. (Before this, several open tabs could fan out enough simultaneous handshakes to arm a
  box's rate limiter.)
- **Connection multiplexing (keep one warm).** Every probe and terminal for a box shares a
  single persistent SSH **ControlMaster** socket under `data/cm/`, authenticated once and kept
  alive for `TMUXIFIER_CONTROL_PERSIST` seconds (default 600) after its last use. Repeated
  status checks and reconnects ride that one connection instead of re-authenticating — no
  per-probe handshake, no per-probe auth attempt.
- **Adaptive status backoff.** Probing starts at the ~30s poll cadence, but each consecutive
  failure *escalates* the interval (30s → 60s → … up to a **5-minute floor**), and a box that
  needs a password jumps straight to the 5-minute floor — fast probing there can never succeed
  and only feeds `fail2ban`. It never fully stops, so a box that recovers turns green on its own
  within ≤5 minutes. A successful check, or opening/reconnecting the box, resets it to the fast
  cadence.
- **Don't probe a box you're using.** While a terminal session is open for a box, the status
  probe is skipped entirely — the dot is read from the live ControlMaster instead (master up ⇒
  connected; absent ⇒ needs auth) — so a probe can't collide with your interactive login on the
  shared socket.
- **Fail fast, then back off.** Both probes and interactive connects set an SSH `ConnectTimeout`
  (≈6s / 10s) so an unreachable box fails quickly instead of hanging. The browser terminal then
  reconnects on its own escalating backoff to a **5-minute floor** — a box left open while it's
  down settles to roughly one attempt every five minutes (gentle enough not to arm a limiter)
  and auto-reconnects within ≤5 minutes of coming back. A connection that proves stable resets
  the backoff to fast.
- **Bounded fan-out.** A full status sweep probes boxes in small batches
  (`TMUXIFIER_STATUS_CONCURRENCY`, default 4), so the dashboard never opens a fleet-wide burst of
  simultaneous handshakes.

If a box still bans the Tmuxifier host (a red dot that pings but times out on port 22), the bans
are time-limited — the low, backed-off connection rate lets them expire instead of continually
re-arming them. To clear one immediately, unban the Tmuxifier host's IP on that box
(e.g. `fail2ban-client unbanip <ip>`) and consider allowlisting it (`ignoreip`).

### Box health history & events

The dashboard keeps a rolling per-box health trend from the samples the 30-second status poll
already collects — **no extra SSH**. Each box row shows a small sparkline of the last ~hour
(click it to cycle CPU → memory → disk), and the sidebar's **Events** button opens an in-app
timeline of transitions: box went down / recovered / needs login / host key changed, plus
CPU/mem/disk crossing a warn threshold (default 90%, with hysteresis so a hovering value doesn't
flap). Unseen events show as a count badge on the button and are marked seen when the panel is
opened. Events survive restarts in `data/health-events.json`; the sample series is in-memory
only. Tune with `TMUXIFIER_HEALTH_HISTORY_MAX`, `TMUXIFIER_HEALTH_EVENTS_MAX`,
`TMUXIFIER_HEALTH_{CPU,MEM,DISK}_WARN_PCT`, and `TMUXIFIER_HEALTH_HYSTERESIS_PCT`.

Tmuxifier also watches each box's configured tmux session for Claude Code and raises **claude is
waiting for input** (the pane has produced no output for longer than
`TMUXIFIER_AGENT_IDLE_SEC`, default 20s — Claude Code repaints its spinner about once a second
while it works, and stops repainting once it is sitting at a prompt) / **claude finished**
(the pane is no longer running Claude Code) events into the same timeline — suppressed while
you're actively attached to that session, since watching it is its own notification. Browser
notifications for these agent events and for the box-health events above can be toggled per kind
in **Settings → Notifications**: per-browser, and they only fire once you grant the browser's
notification permission (which itself requires an HTTPS dashboard). All events always appear in
the events log regardless of which kinds have notifications enabled.

### Fleet Command

Click **Fleet** in the sidebar to enter selection mode, tick any number of boxes (or whole tag
groups), type a command, and **Run**. The command runs once on each selected box over the same
non-interactive SSH path used for status probes, and each box's exit code and output are captured
centrally. Each run is a **job** held on the server: close the tab and the run keeps going —
reopen the dashboard and the **Jobs** button lists recent jobs with their per-box results. Jobs
are persisted to `data/fleet-jobs.json` (last `TMUXIFIER_FLEET_MAX_JOBS`, default 50). The fan-out
is capped at `TMUXIFIER_FLEET_CONCURRENCY` (default 4) so a fleet-wide run never bursts SSH
connections. Password-only boxes with no live connection come back as a per-box error (the
non-interactive path can't answer a password prompt) — open that box's terminal once to establish
the connection, then re-run.

## Proxmox LXC provisioning

Tmuxifier can provision a "canned" LXC container on a Proxmox VE host over the PVE HTTP API and
auto-add a box pointed at it, so a freshly created container opens straight into a browser terminal.

**1. Create an API token in Proxmox.** *Datacenter → Permissions → API Tokens → Add*. Pick a
user/realm (e.g. `user@pam`), a token id (e.g. `tmuxifier`), and copy the secret (shown once).
**Grant the token its own permissions** — tokens default to "Privilege Separation", so the token has
no rights even when the user does. In a lab, add the token (*Datacenter → Permissions → Add → API
Token Permission*, path `/`, propagate) the built-in **`PVEVMAdmin`** role (container create/start
plus `Datastore.AllocateSpace`/`Datastore.Audit`) **and `PVEAuditor`** (the `Sys.Audit` that lets
the node/storage/bridge dropdowns populate). Together these two roles also cover container
**lifecycle**: `VM.Audit`/`Sys.Audit` for the linked-container inventory and state, `VM.PowerMgmt`
for Start/Shutdown/Stop/Reboot, and `VM.Allocate` for LXC deletion (deprovision) — all already
included in `PVEVMAdmin` + `PVEAuditor`, alongside the provisioning datastore privileges above. For
a production token, define a **custom role** granting only those privileges on only the paths it
needs rather than the broad lab roles. Use a privilege-separated token, not full `Administrator`.

**2. Add the host.** **Settings (⚙) → Proxmox → Add a Proxmox host**: enter the endpoint
(`host:8006`), the token id (`user@pam!tmuxifier`) and the secret. Click **Inspect** to fetch and
**pin** the host's TLS certificate (Proxmox ships a self-signed cert; pinning is
trust-on-first-use, like `ssh accept-new`). Save — Tmuxifier verifies the token before storing it.
Removing a host profile and re-adding it later (any name) with the **same endpoint** re-homes any
boxes still linked through the old profile automatically on the next status poll.

**3. Review LXC secrets.** Same **Settings (⚙) → Proxmox** tab, below the host list. Tmuxifier's
own host key is auto-detected and shown as the **default management key** — injected into every
container so Tmuxifier can SSH in (set `TMUXIFIER_PVE_DEFAULT_PUBKEY` if your key isn't at
`~/.ssh/id_*`). Optionally add more **public keys** (e.g. your laptop's) and/or an **optional root
password**. Added keys and the password are encrypted at rest and shown masked after saving; the
private half of any key stays in your own SSH setup — Tmuxifier never stores private keys.

**4. Define a preset and provision.** Back in the dashboard's **Proxmox** hub (the sidebar
button appears once at least one host is configured in Settings): **Presets → Add** a
blueprint (template, CPU/mem/disk, storage, network). Network IP mode is `dhcp`, `static` (a
fixed CIDR + gateway), or `auto-static` — pick just a VLAN on the preset and Tmuxifier
reserves the next free address from the NetBox prefix for that VLAN at provision time (the
gateway is inferred as the prefix's first usable IP and is never handed out), stamps it into the
container, and releases it if provisioning fails or when the container is deprovisioned
(requires the NetBox integration in Settings (⚙) — the `auto-static` option appears once
NetBox is configured (and stays visible on a preset already set to it), and provisioning an
existing `auto-static` preset without NetBox is rejected immediately instead of starting a job). Deprovisioning also deletes any NetBox
IP record matching the box's current IP — including records created by hand — so manually
linked containers don't leave stale IPAM entries behind. An optional **DNS suffix** (e.g.
`lan.example.com`) is appended to the hostname and written to the allocated record's
`dns_name`; the provision form also previews the next available IP for auto-static presets
(non-binding). Then **Provision → pick a preset → enter a
hostname** (optionally a tag, oh-my-tmux/zsh/bash, and the same "Additional tools" checklist as the
Add/Edit Box modal). Watch the live task log; once the container is up Tmuxifier installs tmux
(and any selected frameworks/tools) over SSH, then an **Open terminal** button drops you into it.
Shell-framework auto-updaters are disabled on every box setup — not only when Tmuxifier
installs the framework, so a hand-installed one is covered too. Unattended boxes shouldn't
self-update at a random shell start: that puts a network round trip in front of your session,
bumps versions nobody asked for, and oh-my-zsh's reminder mode blocks the shell outright waiting
for a `Y/n`. Each clamp is applied only where the framework is actually present, so an rc file
that doesn't use one is left alone:

| Framework | What is set | Where |
|---|---|---|
| Oh My Zsh | `zstyle ':omz:update' mode disabled` | `~/.zshrc`, immediately before the `oh-my-zsh.sh` source line |
| Oh My Bash | `DISABLE_AUTO_UPDATE="true"` | `~/.bashrc`, before the `oh-my-bash.sh` source line |
| Oh My Tmux | `tmux_conf_update_plugins_on_launch=false` and `..._on_reload=false` | `~/.tmux.conf.local` |

That last one matters more than it looks: oh-my-tmux ships both flags as `true`, so an unclamped
box runs `git fetch` for tpm and every plugin on **each** tmux server launch and **each** config
reload.

The same clamps are applied to the Tmuxifier host's own shell whenever its local-shell
framework is provisioned (the ✎ host-shell choice, persisted as `localShell` in
`config.json`) — so the host stops prompting too.

**Update deliberately, when you choose to.** Both shell-framework updaters are shell *functions*,
so a non-interactive Fleet Command run has to call the underlying scripts:

```sh
sh ~/.oh-my-zsh/tools/upgrade.sh     # Oh My Zsh  (interactively: omz update)
bash ~/.oh-my-bash/tools/upgrade.sh  # Oh My Bash (interactively: upgrade_oh_my_bash)
git -C ~/.tmux pull                  # Oh My Tmux (plugins: tpm's prefix + U)
```

**Boxes added before this shipped** need one sweep, since the clamps are applied at setup time.
Select every box in Fleet Command and run:

```sh
[ -f ~/.zshrc ] && ! grep -q "^zstyle ':omz:update' mode disabled" ~/.zshrc \
  && sed -i "/oh-my-zsh\.sh/i zstyle ':omz:update' mode disabled" ~/.zshrc
[ -f ~/.bashrc ] && ! grep -q '^DISABLE_AUTO_UPDATE=' ~/.bashrc \
  && sed -i '/oh-my-bash\.sh/i DISABLE_AUTO_UPDATE="true"' ~/.bashrc
[ -f ~/.tmux.conf.local ] \
  && sed -i 's/^tmux_conf_update_plugins_on_launch=true/tmux_conf_update_plugins_on_launch=false/' ~/.tmux.conf.local \
  && sed -i 's/^tmux_conf_update_plugins_on_reload=true/tmux_conf_update_plugins_on_reload=false/' ~/.tmux.conf.local
true
```

The trailing `true` keeps the exit status zero on a box that simply has no oh-my-tmux, so Fleet
Command doesn't report a failure. Re-running is harmless.

**Security.** The API token, any added SSH keys, and the optional root password are **encrypted at
rest** (AES-256-GCM; key derived from your cookie secret) in the gitignored `data/proxmox.json`
(`0600`), and are never sent to the browser. TLS is pinned for self-signed certs and CA-verified
when the host presents a valid certificate. If you rotate `TMUXIFIER_COOKIE_SECRET`, previously-saved
secrets become undecryptable — re-add each Proxmox host (and re-enter keys/password) afterward.

## Proxmox container lifecycle

Once a box is **linked** to a Proxmox LXC container, Tmuxifier can manage that container's power
state and retire it. Lifecycle control applies **only to verified linked LXC containers** — a box
with no confirmed Proxmox link stays an ordinary SSH box and exposes none of these actions.

**Linking is explicit.** A provisioned container is linked automatically; any other box is linked by
hand in **Edit box → Proxmox association** (pick host → node → container; already-linked targets are
disabled). Unlinking there never stops or destroys the container — it only drops Tmuxifier's record.
**Importing boxes never restores lifecycle authority:** an imported box starts unlinked and must be
re-linked deliberately before any power or deprovision action is offered.

**State comes from a live PVE confirmation.** A container PVE reports stopped shows a grey **Stopped**
state with its node/VMID instead of a dead terminal; clicking it opens the Proxmox **Containers** tab
focused on that box. A PVE lookup failure never hides an SSH outage — reachability still comes from
SSH, so a genuinely down box still shows red. Containers migrated between nodes are followed
automatically — Tmuxifier updates the stored node on its next status poll — and the same `PVEAuditor`
grant also powers this cluster-wide inventory lookup.

**Actions** live in the Proxmox hub's **Containers** tab, gated by state: a stopped container offers
**Start** and **Deprovision**; a running one offers **Shutdown**, **Stop** (a forceful immediate
stop), **Reboot**, and **Deprovision**; a container PVE can't find offers **Deprovision** as a
local-only link cleanup. Each action runs as a pollable job.

**Deprovision** is the destructive path and stays disabled until you type the box's exact label to
confirm. It gracefully shuts the container down, destroys it **and its attached volumes**, **keeps**
any independent backup archives, then removes the local box. The hub's **Activity** tab merges
lifecycle and provision jobs newest-first (history persists to `data/proxmox-lifecycle-jobs.json`).

## Security
Tmuxifier can SSH into your whole fleet, so the login gate is the crown jewel. It binds to
`127.0.0.1` by default. To expose it on a network, **always use TLS** — either set
`TMUXIFIER_TLS_CERT`/`TMUXIFIER_TLS_KEY` to serve HTTPS directly (a self-signed cert works; browsers
show a one-time warning), or front it with a TLS reverse proxy — and set `TMUXIFIER_BIND`
accordingly. Serving the login over plain HTTP on a non-loopback address sends credentials
in cleartext. Passwords are scrypt-hashed and login attempts are rate-limited per IP (set
`TMUXIFIER_TRUST_PROXY` behind a proxy so the limiter sees real client IPs); OAuth mode uses an
exact-email allowlist; the session cookie is signed, httpOnly, SameSite=lax, expires after 7 days
(server-enforced), and is marked `Secure` for local TLS or an `https://` base external URL.
Tmuxifier stores no SSH secrets — your keys and agent stay in the OS. The Proxmox API token, any
added SSH management keys, the optional Proxmox root password, and the NetBox API token are the
only credentials Tmuxifier persists; all are AES-256-GCM encrypted at rest (`data/proxmox.json`,
`data/netbox.json`, both `0600`) and never sent to the browser.

A passkey (see [Authentication](#authentication) above) is phishing-resistant — it only works on
the exact hostname it was enrolled against — and its sign-in path shares the same per-IP rate
limiter as password login, so it's an added way in without being an added way around the
lockout. Enrolled passkeys are public keys, not secrets, so `data/passkeys.json` is **not**
encrypted like the files above; it is still written `0600`.

Generate a self-signed cert (valid for an IP) with:
```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout key.pem -out cert.pem -subj "/CN=tmuxifier" \
  -addext "subjectAltName=IP:192.168.1.10,IP:127.0.0.1,DNS:localhost"
```

## Deployment
Run Tmuxifier as a long-lived **systemd** service. A deployment is just a checkout of the repo
plus a small unit that runs `node src/server/index.js` from it — config (`.env`), certs
(`tls/`), and state (`data/`) all stay inside the repo folder.

The repo ships a ready-to-use unit at [deploy/tmuxifier.service](deploy/tmuxifier.service),
which assumes the repo is at `/root/tmuxifier` running as `root`:

```ini
[Unit]
Description=Tmuxifier - web dashboard for managing SSH/tmux boxes
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/tmuxifier
# HOME must be set so the ssh children find ~/.ssh (keys, config, known_hosts)
Environment=HOME=/root
ExecStart=/usr/bin/node /root/tmuxifier/src/server/index.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Install and start it (after `npm install && npm run build && npm run set-password`):

```bash
sudo cp deploy/tmuxifier.service /etc/systemd/system/tmuxifier.service
# Not running from /root/tmuxifier as root? Edit User=, WorkingDirectory=,
# Environment=HOME=, and the node path in ExecStart= to match your install.
sudo systemctl daemon-reload
sudo systemctl enable --now tmuxifier   # start now + on boot
systemctl status tmuxifier              # confirm it is active
```

Two things to know: the app reads `.env` itself, so secrets are deliberately **not** placed in
the unit (it holds no credentials); and `HOME` is set in the unit — not `.env` — so the `ssh`
child processes can find `~/.ssh`. To update a running deployment: `git pull`, `npm install`
(only if dependencies changed), `npm run build`, then `sudo systemctl restart tmuxifier`.

See [docs/DEPLOY.md](docs/DEPLOY.md) for the full guide — passwordless SSH key setup, TLS certs,
Google OAuth behind a Cloudflare tunnel, the file-layout table, and password rotation.

## Attributions

Tmuxifier can optionally install and configure these excellent projects on your boxes during
provisioning:

| Project | Repository | What it does |
| --- | --- | --- |
| **Oh My Zsh** | [ohmyzsh/ohmyzsh](https://github.com/ohmyzsh/ohmyzsh) | Zsh framework with plugins, themes, and helpers |
| **Oh My Bash** | [ohmybash/oh-my-bash](https://github.com/ohmybash/oh-my-bash) | Bash framework with themes and completions |
| **Oh My Tmux** | [gpakosz/.tmux](https://github.com/gpakosz/.tmux) | Tmux configuration by Gregory Pakosz |

Each installs via its upstream bootstrap script and is skipped if already present on the box.

## Development
```bash
npm run dev    # vite + node --watch, proxying /api and /term to the backend
npm test       # unit + integration (Vitest)
npm run test:e2e
```
