# Configuration reference

Every option Tmuxifier reads, in one place. Part of the [Tmuxifier docs](../README.md) —
the [README's Configuration section](../README.md#configuration) covers the essentials.

All options are read from `.env` in the repo root (see `.env.example`). Each key can also be
set as a real shell environment variable, which **overrides** the file. Precedence, low to
high: built-in defaults → `config.json` → `.env` → shell environment.

## Full option table

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

## TLS and reverse proxies

Set **both** `TMUXIFIER_TLS_CERT` and `TMUXIFIER_TLS_KEY` to serve HTTPS directly; when TLS is active
the session cookie is automatically marked `Secure`. An `https://` `TMUXIFIER_BASE_EXTERNAL_URL`
also marks it `Secure` for deployments behind a TLS-terminating proxy or tunnel.

When Tmuxifier sits behind a reverse proxy or tunnel, also set `TMUXIFIER_TRUST_PROXY` (`true`, a
hop count, or a comma-separated address/CIDR list) so login rate limiting sees each client's real
IP from `X-Forwarded-For` instead of bucketing everyone under the proxy's address. Leave it unset
when clients connect directly — trusting forwarded headers from a non-proxy lets them spoof
their IP.

## config.json

As an alternative to `.env`, a `config.json` in the repo root works too, using camelCase keys
(`passwordHash`, `cookieSecret`, `bindAddress`, `port`, `graceSeconds`, `hostKeyPolicy`, `trustProxy`,
`statusConcurrency`, `statusPollMs`, `servicePollMs`, `controlPersist`, `termFont`, `termFontSize`, `fleetConcurrency`, `fleetTimeoutMs`,
`fleetMaxJobs`, `fleetMaxOutputBytes`, `healthHistoryMax`, `healthEventsMax`, `healthCpuWarnPct`,
`healthMemWarnPct`, `healthDiskWarnPct`, `healthThresholdHysteresisPct`, `pvePollMs`, `pveTimeoutMs`, `pveProvisionTimeoutMs`,
`pveLeaseTimeoutMs`, `pveMaxJobs`, `pveDefaultPubKeyPath`, `authMode`, `publicUrl`, `rpId`,
`passkeyOnlyKillSwitch`, `googleClientId`, `googleClientSecret`, `allowedEmails`, `dataDir`,
`controlDir`, `sshConfigFile`, `tlsCert`, `tlsKey`, `uploadMaxMb`, `claudeOauthToken`,
`whisperBin`, `whisperModel`, `voiceIdleMs`, `voiceMaxMb`, `voiceMaxSeconds`, `voiceOff`).
`config.json` is merged wholesale rather than filtered through an allowlist, so any documented
setting works there under its camelCase name. The UI also persists `localShell` in
`config.json`; it does not have an env key.
`TMUXIFIER_SSH_CONFIG`/`sshConfigFile` is passed to `ssh` as `-F`, so it is an alternate config
file for Tmuxifier's SSH commands, not an extra file merged with `~/.ssh/config`.
Unlike the `.env` string form (`TMUXIFIER_PASSKEY_ONLY`, which additionally accepts `0`, `no` or
`false` alongside `off`), the `config.json` key `passkeyOnlyKillSwitch` is a plain boolean —
`true` engages the break-glass kill switch, `false` or an absent key does not.

## Terminal font

`TMUXIFIER_TERM_FONT` sets the font for the browser **terminal sessions** (not the dashboard
chrome). It is a single family name, prepended to the bundled font stack, so it must be installed
on the device viewing the dashboard — otherwise that device transparently falls back to the bundled
**MesloLGMDZ Nerd Font** (Line Gap Medium, dotted zero, the default terminal font). An unsafe or
empty value is ignored. The bundled fonts (MesloLGMDZ, then MesloLGSDZ and JuliaMono) always remain
as the fallback, so symbol glyphs (e.g. Claude Code's UI) keep rendering regardless of the choice.

## The settings modal

**Settings → Boxes** has **export** and **import** buttons that download and upload the full box
list as a JSON file — a portable backup you can move between Tmuxifier instances. Import adds boxes
from the file, re-minting each id and skipping any whose host/label already exists (so re-importing
is safe).
It carries no SSH secrets; boxes still rely on your keys/agent/`~/.ssh/config` at connect time.
The sidebar itself and each tag group can be collapsed (‹ next to the brand, click a group
header); both states persist across reloads.

A ⚙ **settings** modal (top of the sidebar) has seven tabs: **Boxes** (box-list export/import,
above), **Services** (the standby dashboard's service tiles — name, URL, icon, group, and the
liveness check, including the credentialed Pi-hole/TrueNAS/UniFi/Immich kinds), **NetBox** (an http/https selector +
host and token — the TLS options, including fingerprint pinning for self-signed certs, appear
only for https — plus a connection test; also powers `auto-static` IP allocation during
provisioning), **Proxmox** (host profiles and LXC secrets), **Passkeys** (enroll, remove, and the
optional "require a passkey" sign-in policy), **Voice** (whisper.cpp install, model choice, and a
mic test), and **Notifications** (browser
notification permission and per-event-kind toggles); see
[Proxmox](proxmox.md) for NetBox and Proxmox details,
[Authentication](authentication.md#passkeys) for the sign-in policy, and
[Terminal features](terminal.md#voice-dictation) for the voice install flow.
