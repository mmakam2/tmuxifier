# Tmuxifier

A single-user web dashboard for managing headless boxes over SSH. Each box opens a
browser terminal backed by a tmux session that lives **on the box**, so closing the tab,
losing the network, or restarting Tmuxifier leaves your work running — reconnecting drops you
back into the same state.

## Requirements
- Node 20+
- The OpenSSH client, with your keys/agent/`~/.ssh/config` already working from the shell
- Each managed box needs `tmux` installed

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
| password hash | `TMUXIFIER_PASSWORD_HASH` | — (required) |
| cookie secret | `TMUXIFIER_COOKIE_SECRET` | — (required) |
| data dir | `TMUXIFIER_DATA_DIR` | `<repo>/data` |
| control-socket dir | `TMUXIFIER_CONTROL_DIR` | `<dataDir>/cm` |
| extra ssh config | `TMUXIFIER_SSH_CONFIG` | (none) |
| TLS cert (PEM) | `TMUXIFIER_TLS_CERT` | (none → serves HTTP) |
| TLS key (PEM) | `TMUXIFIER_TLS_KEY` | (none → serves HTTP) |

Set **both** `TMUXIFIER_TLS_CERT` and `TMUXIFIER_TLS_KEY` to serve HTTPS directly; when TLS is active
the session cookie is automatically marked `Secure`.

As an alternative to `.env`, a `config.json` in the repo root works too, using camelCase keys
(`passwordHash`, `cookieSecret`, `bindAddress`, `port`, `graceSeconds`, `hostKeyPolicy`,
`dataDir`, `controlDir`, `sshConfigFile`, `tlsCert`, `tlsKey`).

## How persistence works
Each terminal runs `ssh -tt <box> "tmux new-session -A -D -s web"` (the `-D` detaches any other
client so a stale connection can't freeze the layout). Because tmux runs on the
box, the session and its processes survive disconnects. A 45s server-side grace window makes
brief reconnects seamless; after that the local ssh process is dropped while the on-box
session keeps running.

## Security
Tmuxifier can SSH into your whole fleet, so the login gate is the crown jewel. It binds to
`127.0.0.1` by default. To expose it on a network, **always use TLS** — either set
`TMUXIFIER_TLS_CERT`/`TMUXIFIER_TLS_KEY` to serve HTTPS directly (a self-signed cert works; browsers
show a one-time warning), or front it with a TLS reverse proxy — and set `TMUXIFIER_BIND`
accordingly. Serving the login over plain HTTP on a non-loopback address sends your password
in cleartext, so the `Secure` cookie is only enabled when TLS is configured. Passwords are
scrypt-hashed; the session cookie is signed, httpOnly, and SameSite. Tmuxifier stores no SSH
secrets — your keys and agent stay in the OS.

Generate a self-signed cert (valid for an IP) with:
```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout key.pem -out cert.pem -subj "/CN=tmuxifier" \
  -addext "subjectAltName=IP:10.0.0.94,IP:127.0.0.1,DNS:localhost"
```

## Development
```bash
npm run dev    # vite + node --watch, proxying /api and /term to the backend
npm test       # unit + integration (Vitest)
npm run test:e2e
```
