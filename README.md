# Helm

A single-user web dashboard for managing headless boxes over SSH. Each box opens a
browser terminal backed by a tmux session that lives **on the box**, so closing the tab,
losing the network, or restarting Helm leaves your work running — reconnecting drops you
back into the same state.

## Requirements
- Node 20+
- The OpenSSH client, with your keys/agent/`~/.ssh/config` already working from the shell
- Each managed box needs `tmux` installed

## Setup
```bash
npm install
npm run build
npm run set-password           # prints HELM_PASSWORD_HASH and HELM_COOKIE_SECRET
```
Put the two printed values in `config.json` or the environment, then:
> In `config.json`, use camelCase keys: `passwordHash`, `cookieSecret`, `bindAddress`, `port`, `graceSeconds`, `hostKeyPolicy`, `dataDir`, `sshConfigFile`.
```bash
HELM_PASSWORD_HASH=... HELM_COOKIE_SECRET=... npm start
```
Open http://127.0.0.1:7437.

## Configuration
| Key | Env | Default |
| --- | --- | --- |
| bind address | `HELM_BIND` | `127.0.0.1` |
| port | `HELM_PORT` | `7437` |
| grace seconds | `HELM_GRACE` | `45` |
| host-key policy | `HELM_HOSTKEY_POLICY` | `accept-new` |
| password hash | `HELM_PASSWORD_HASH` | — (required) |
| cookie secret | `HELM_COOKIE_SECRET` | — (required) |
| data dir | `HELM_DATA_DIR` | `<cwd>/data` |
| extra ssh config | `HELM_SSH_CONFIG` | (none) |

## How persistence works
Each terminal runs `ssh -tt <box> "tmux new-session -A -s web"`. Because tmux runs on the
box, the session and its processes survive disconnects. A 45s server-side grace window makes
brief reconnects seamless; after that the local ssh process is dropped while the on-box
session keeps running.

## Security
Helm can SSH into your whole fleet, so the login gate is the crown jewel. It binds to
`127.0.0.1` by default. **Only expose it behind a TLS reverse proxy** (and set `HELM_BIND`
accordingly). Passwords are scrypt-hashed; the session cookie is signed, httpOnly, and
SameSite. Helm stores no SSH secrets — your keys and agent stay in the OS.

## Development
```bash
npm run dev    # vite + node --watch, proxying /api and /term to the backend
npm test       # unit + integration (Vitest)
npm run test:e2e
```
