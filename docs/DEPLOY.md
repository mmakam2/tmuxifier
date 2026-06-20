# Deploying Tmuxifier

Tmuxifier is self-contained: the app, its configuration, secrets, TLS material, and
runtime state all live **inside the repo folder**. A deployment is a checkout of the repo
plus a small systemd unit that runs `node src/server/index.js` from it.

Everything below assumes the repo lives at `/root/tmuxifier` (the path used by the sample
unit); adjust paths if you install elsewhere.

## What lives where

| Path | Tracked in git? | Contents |
| --- | --- | --- |
| `.env` | no (gitignored) | All `TMUXIFIER_*` config, incl. password hash + cookie secret (mode `0600`) |
| `tls/` | no (gitignored) | `cert.pem` / `key.pem` for HTTPS (private key stays out of git) |
| `data/` | no (gitignored) | `boxes.json` and SSH ControlMaster sockets (`data/cm/`) |
| `deploy/tmuxifier.service` | yes | Sample systemd unit (no secrets) |
| `.env.example` | yes | Template for `.env` |

## First-time setup

```bash
git clone https://github.com/mmakam2/tmuxifier.git /root/tmuxifier
cd /root/tmuxifier
npm install
npm run build

# 1. Credentials -> writes ./.env (mode 0600) with the password hash + cookie secret
npm run set-password

# 2. (optional) other settings: copy the template and edit
cp .env.example .env   # only if you didn't run set-password first; otherwise edit ./.env
```

### TLS (recommended whenever you bind off loopback)

Generate a self-signed cert into the repo's `tls/` dir (valid for your IP):

```bash
mkdir -p tls && chmod 700 tls
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout tls/key.pem -out tls/cert.pem -subj "/CN=tmuxifier" \
  -addext "subjectAltName=IP:10.0.0.94,IP:127.0.0.1,DNS:localhost"
chmod 600 tls/key.pem
```

Then point `.env` at them and bind to the network interface:

```ini
TMUXIFIER_BIND=10.0.0.94
TMUXIFIER_PORT=7437
TMUXIFIER_TLS_CERT=tls/cert.pem
TMUXIFIER_TLS_KEY=tls/key.pem
```

Paths are resolved relative to the service's working directory (the repo root). Setting both
TLS keys makes Tmuxifier serve HTTPS directly and marks the session cookie `Secure`. Without
TLS, keep `TMUXIFIER_BIND` on `127.0.0.1` — serving the login over plain HTTP on a routable
address sends the password in cleartext.

## Install the service

```bash
sudo cp deploy/tmuxifier.service /etc/systemd/system/tmuxifier.service
# edit User=/WorkingDirectory=/HOME= if you are not running from /root/tmuxifier as root
sudo systemctl daemon-reload
sudo systemctl enable --now tmuxifier
systemctl status tmuxifier
```

`HOME` is set in the unit (not via `.env`) so the `ssh` child processes can find `~/.ssh`.
The app reads `.env` itself; secrets are deliberately **not** placed in the process
environment, so they are not inherited by the `ssh`/`tmux` children.

Verify it is up:

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://10.0.0.94:7437/        # 200
curl -sk -o /dev/null -w '%{http_code}\n' https://10.0.0.94:7437/api/me  # 401 until you log in
```

## Updating an existing deployment

```bash
cd /root/tmuxifier
git pull
npm install          # only needed if dependencies changed
npm run build        # rebuild the web bundle
sudo systemctl restart tmuxifier
```

`.env`, `tls/`, and `data/` are gitignored, so `git pull` never touches your secrets or state.

## Changing the password later

```bash
npm run set-password        # rewrites the hash in ./.env, keeps the existing cookie secret
sudo systemctl restart tmuxifier
```

Keeping the cookie secret stable means existing logins survive a password change. See
[../README.md](../README.md) for the full configuration reference and security model.
