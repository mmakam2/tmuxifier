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
| `config.json` | no (gitignored) | Optional camelCase alternative to `.env`; also where the UI persists `localShell` |
| `tls/` | no (gitignored) | `cert.pem` / `key.pem` for HTTPS (private key stays out of git) |
| `data/` | no (gitignored) | `boxes.json`, `fleet-jobs.json` (Fleet Command history), `proxmox.json` (encrypted Proxmox host/key/preset profiles), `provision-jobs.json` (provision history), `proxmox-lifecycle-jobs.json` (LXC power/deprovision job history), `health-events.json` (in-app health event log), and SSH ControlMaster sockets (`data/cm/`) |
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
  -addext "subjectAltName=IP:192.168.1.10,IP:127.0.0.1,DNS:localhost"
chmod 600 tls/key.pem
```

Then point `.env` at them and bind to the network interface:

```ini
TMUXIFIER_BIND=192.168.1.10
TMUXIFIER_PORT=7437
TMUXIFIER_TLS_CERT=tls/cert.pem
TMUXIFIER_TLS_KEY=tls/key.pem
```

Paths are resolved relative to the service's working directory (the repo root). Setting both
TLS keys makes Tmuxifier serve HTTPS directly and marks the session cookie `Secure`. Without
TLS, keep `TMUXIFIER_BIND` on `127.0.0.1` — serving the login over plain HTTP on a routable
address sends the password in cleartext.

### Google OAuth behind a Cloudflare tunnel

For a Cloudflare tunnel such as `https://tmuxifier.example.com`, TLS terminates at
Cloudflare and the local Tmuxifier process can still speak plain HTTP. Set the public URL so
OAuth redirect URIs are correct and the browser receives a `Secure` session cookie:

```ini
TMUXIFIER_AUTH_MODE=oauth
TMUXIFIER_BASE_EXTERNAL_URL=tmuxifier.example.com
TMUXIFIER_OAUTH_CLIENT_ID=...
TMUXIFIER_OAUTH_CLIENT_SECRET=...
TMUXIFIER_ALLOWED_EMAILS=you@example.com
```

Generate the cookie secret without creating a password login:

```bash
npm run gen-secret
```

In Google Cloud Console, go to **APIs & Services → Credentials**, create an **OAuth client
ID** with application type **Web application**, and add this authorized redirect URI:

```text
https://tmuxifier.example.com/api/auth/google/callback
```

Copy the client id and secret into `.env`, restart the service, and the login page will show
Google sign-in instead of the password form. `TMUXIFIER_ALLOWED_EMAILS` is a comma-separated
exact-email allowlist, matched case-insensitively.

## SSH access to your boxes (passwordless)

Tmuxifier stores no SSH keys — it runs the system `ssh` client as the **service user** (`root`
in the sample unit, with `HOME=/root`) and uses that account's `~/.ssh`. For connections to stay
passwordless, that account needs a private key the boxes trust. Use a **dedicated management key
with no passphrase** so the unattended service can authenticate without an agent — this key can
reach every box in your fleet, so treat it as a high-value secret.

**1. Put the key in the service user's `~/.ssh` on the Tmuxifier host.** Either generate a fresh
dedicated key on the host, or upload an existing one from your workstation:

```bash
install -d -m 700 ~/.ssh

# Option A — generate a fresh dedicated key on the host (no passphrase):
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C tmuxifier

# Option B — upload an existing management key from your workstation instead:
#   scp ~/.ssh/id_ed25519 root@<tmuxifier-host>:~/.ssh/id_ed25519
chmod 600 ~/.ssh/id_ed25519
```

If you uploaded only the private key, recreate its public half:
`ssh-keygen -y -f ~/.ssh/id_ed25519 > ~/.ssh/id_ed25519.pub`.

**2. Authorize the public key on each box** (repeat per box):

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@box
```

**3. Confirm a passwordless connection** from the service user's shell — Tmuxifier runs the exact
same `ssh`, so if this works, adding the box in the UI will too:

```bash
ssh user@box 'tmux -V'   # connects with no password prompt
```

Optional but handy: define hosts in `~/.ssh/config` (per-host `User`, `IdentityFile`,
`ProxyJump`). Tmuxifier itself never reads or imports that file — but the `ssh` binary it shells
out to does, so you can add a box using its short `Host` alias as the hostname and ssh resolves
the rest. (The only import Tmuxifier has is the box-list JSON produced by the export button.)

> **Passphrases & agents:** a systemd service can't type a passphrase interactively. Prefer the
> passphrase-free key above, or run an `ssh-agent` the service can reach (set `SSH_AUTH_SOCK` in
> the unit and load the key on boot). Harden the key on the boxes where you can (`from=`
> restrictions, a dedicated account) and keep `~/.ssh` at `700`, the private key at `600`.

## Proxmox API token (optional)

Tmuxifier can provision **and manage the lifecycle of** Proxmox LXC containers over the PVE HTTP API.
Create a **privilege-separated** API token (full walkthrough in
[../README.md](../README.md#proxmox-lxc-provisioning)) and grant it enough to cover both:

- **Provisioning:** `Datastore.AllocateSpace` / `Datastore.Audit` (container create) plus `Sys.Audit`
  so the node/storage/bridge pickers populate.
- **Lifecycle:** `VM.Audit` / `Sys.Audit` for the linked-container inventory and state,
  `VM.PowerMgmt` for Start / Shutdown / Stop / Reboot, and `VM.Allocate` for LXC deletion
  (deprovision).

In a lab the built-in **`PVEVMAdmin` + `PVEAuditor`** roles cover all of the above; for production,
define a custom role granting only those privileges on only the paths the token needs. Lifecycle
control applies **only to verified linked LXC containers** — provisioned boxes link automatically,
any other box is linked by hand in **Edit box → Proxmox association**, and importing boxes never
restores that link. A linked box's state comes from a **live PVE confirmation**: a container PVE
reports stopped shows a grey **Stopped** panel instead of a dead terminal, while a PVE lookup failure
never masks an SSH outage (reachability still comes from SSH). **Deprovision** gracefully shuts the
container down, destroys it and its attached volumes, keeps independent backup archives, then removes
the local box; lifecycle and provision jobs are recorded in the hub's **Activity** tab and in
`data/proxmox-lifecycle-jobs.json`. The token, any SSH management keys, and the optional root password
are encrypted at rest in `data/proxmox.json` and never sent to the browser.

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

Verify it is up. Derive the URL the server actually binds to from your own
config (scheme from TLS, host/port from `.env`) so the check always hits the
deployed bind address — not loopback, which won't answer when `TMUXIFIER_BIND`
is a routable address:

```bash
BASE="$(node -e "import('./src/server/config.js').then(({loadConfig})=>{const c=loadConfig();process.stdout.write(((c.tlsCert&&c.tlsKey)?'https':'http')+'://'+c.bindAddress+':'+c.port)})")"
curl -sk -o /dev/null -w '%{http_code}\n' "$BASE/"        # 200
curl -sk -o /dev/null -w '%{http_code}\n' "$BASE/api/me"  # 401 until you log in
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

## Shipping changes (for developers)

When making changes to push back to the repo:

```bash
npm version patch --no-git-tag-version # bump package.json + package-lock.json by 0.0.1
npm run build                        # rebuild the web bundle
sudo systemctl restart tmuxifier     # restart to pick up the new bundle
systemctl status tmuxifier           # confirm the service is healthy
# Health check against the deployed bind address (derived from your config):
BASE="$(node -e "import('./src/server/config.js').then(({loadConfig})=>{const c=loadConfig();process.stdout.write(((c.tlsCert&&c.tlsKey)?'https':'http')+'://'+c.bindAddress+':'+c.port)})")"
curl -sk -o /dev/null -w '%{http_code}\n' "$BASE/"  # 200
```

If everything checks out, commit and push:

```bash
git add -A
VERSION="v$(node -p "require('./package.json').version")"
test "$(node -p "require('./package-lock.json').version")" = "${VERSION#v}"
test "$(node -p "require('./package-lock.json').packages[''].version")" = "${VERSION#v}"
git commit -m "feat(…): description" # conventional-commit style
git tag -a "$VERSION" -m "$VERSION"  # tag must match the package/lockfile version
git push origin main "$VERSION"
gh release create "$VERSION" --title "$VERSION" --notes "See commit history for changes."
test -n "$(git ls-remote --tags origin "$VERSION")"
test "$(gh release view "$VERSION" --json tagName --jq .tagName)" = "$VERSION"
```

## Changing the password later

```bash
npm run set-password        # rewrites the hash in ./.env, keeps the existing cookie secret
sudo systemctl restart tmuxifier
```

Keeping the cookie secret stable means existing logins survive a password change. See
[../README.md](../README.md) for the full configuration reference and security model.
