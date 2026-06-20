# <img src="src/web/assets/tmuxifier-logo.png" alt="" width="36" height="36" style="vertical-align:middle" /> Tmuxifier

A single-user web dashboard for managing headless boxes over SSH. Each box opens a
browser terminal backed by a tmux session that lives **on the box**, so closing the tab,
losing the network, or restarting Tmuxifier leaves your work running — reconnecting drops you
back into the same state.

## Screenshots

| Login | Dashboard |
|:---:|:---:|
| [![Login screen](docs/screenshots/login.png)](docs/screenshots/login.png) | [![Dashboard with terminal](docs/screenshots/dashboard.png)](docs/screenshots/dashboard.png) |

| Add Box |
|:---:|
| [![Add box dialog](docs/screenshots/add-box.png)](docs/screenshots/add-box.png) |

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
| auth mode | `TMUXIFIER_AUTH_MODE` | `password` |
| password hash | `TMUXIFIER_PASSWORD_HASH` | — (required) |
| cookie secret | `TMUXIFIER_COOKIE_SECRET` | — (required) |
| base external URL | `TMUXIFIER_BASE_EXTERNAL_URL` | (none) |
| OAuth client id | `TMUXIFIER_OAUTH_CLIENT_ID` | (none) |
| OAuth client secret | `TMUXIFIER_OAUTH_CLIENT_SECRET` | (none) |
| allowed Google emails | `TMUXIFIER_ALLOWED_EMAILS` | (none) |
| data dir | `TMUXIFIER_DATA_DIR` | `<repo>/data` |
| control-socket dir | `TMUXIFIER_CONTROL_DIR` | `<dataDir>/cm` |
| extra ssh config | `TMUXIFIER_SSH_CONFIG` | (none) |
| TLS cert (PEM) | `TMUXIFIER_TLS_CERT` | (none → serves HTTP) |
| TLS key (PEM) | `TMUXIFIER_TLS_KEY` | (none → serves HTTP) |

Set **both** `TMUXIFIER_TLS_CERT` and `TMUXIFIER_TLS_KEY` to serve HTTPS directly; when TLS is active
the session cookie is automatically marked `Secure`. An `https://` `TMUXIFIER_BASE_EXTERNAL_URL`
also marks it `Secure` for deployments behind a TLS-terminating proxy or tunnel.

As an alternative to `.env`, a `config.json` in the repo root works too, using camelCase keys
(`passwordHash`, `cookieSecret`, `bindAddress`, `port`, `graceSeconds`, `hostKeyPolicy`,
`authMode`, `publicUrl`, `googleClientId`, `googleClientSecret`, `allowedEmails`,
`dataDir`, `controlDir`, `sshConfigFile`, `tlsCert`, `tlsKey`).

## Authentication
`TMUXIFIER_AUTH_MODE` selects one login method. The default is `password`; set it to
`oauth` to replace the password form with Google sign-in. The modes are exclusive.

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

## How persistence works
Each terminal runs `ssh -tt <box> "tmux new-session -A -D -s web"` (the `-D` detaches any other
client so a stale connection can't freeze the layout). Because tmux runs on the
box, the session and its processes survive disconnects. A 45s server-side grace window makes
brief reconnects seamless; after that the local ssh process is dropped while the on-box
session keeps running.

When a box is added, Tmuxifier first checks for `tmux`, installs it through a known package
manager when possible (`apt-get`, `dnf`, `yum`, `pacman`, `apk`, or `zypper`), and creates
the configured tmux session. Removing a box closes any local terminal process for that box
and best-effort kills the configured remote tmux session before deleting the box from the list.

## Security
Tmuxifier can SSH into your whole fleet, so the login gate is the crown jewel. It binds to
`127.0.0.1` by default. To expose it on a network, **always use TLS** — either set
`TMUXIFIER_TLS_CERT`/`TMUXIFIER_TLS_KEY` to serve HTTPS directly (a self-signed cert works; browsers
show a one-time warning), or front it with a TLS reverse proxy — and set `TMUXIFIER_BIND`
accordingly. Serving the login over plain HTTP on a non-loopback address sends credentials
in cleartext. Passwords are scrypt-hashed; OAuth mode uses an exact-email allowlist; the
session cookie is signed, httpOnly, SameSite=lax, and marked `Secure` for local TLS or an
`https://` base external URL. Tmuxifier stores no SSH secrets — your keys and agent stay in the OS.

Generate a self-signed cert (valid for an IP) with:
```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout key.pem -out cert.pem -subj "/CN=tmuxifier" \
  -addext "subjectAltName=IP:192.168.1.10,IP:127.0.0.1,DNS:localhost"
```

## Deployment
For running Tmuxifier as a long-lived service, see [docs/DEPLOY.md](docs/DEPLOY.md). It covers
a self-contained layout (config in `.env`, certs in `tls/`, state in `data/` — all inside the
repo) and ships a sample systemd unit at [deploy/tmuxifier.service](deploy/tmuxifier.service).

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
