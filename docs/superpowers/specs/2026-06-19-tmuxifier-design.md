# Tmuxifier — Design Spec

- **Date:** 2026-06-19
- **Status:** Design approved; pending implementation plan
- **Working name:** Tmuxifier (on-disk folder: `tmuxifier/`; trivially renamable)

## 1. Summary

Tmuxifier is a **single-user web app** that turns a browser into a dashboard for a fleet of
headless boxes. Each box is reached over SSH; opening a box gives a full interactive
terminal backed by a tmux session that lives **on the box**. Because the session is
server-side on the box, closing the tab, losing the network, or restarting the Tmuxifier
server leaves the work running — reconnecting drops you back into the exact same state.

## 2. Goals / non-goals

**Goals**
- Manage any number of headless boxes from one web UI.
- One click → live, persistent terminal to a box.
- Survive disconnects: reconnect to the identical tmux state (windows, panes, running
  processes, scrollback).
- Reuse the operator's existing SSH setup; store no secrets.

**Non-goals (v1)** — see the deferred list in §12.
- Multi-user / teams / RBAC.
- In-browser pane-splitting UI, SFTP/file browser, metrics dashboards, broadcast-to-many.

## 3. Context (environment)

- Target install dir `/root/tmuxifier` (empty greenfield, now a fresh git repo).
- Available: tmux 3.5a, OpenSSH client, Node v20.18.1 / npm 9.2.0, Python 3.13.3, full
  C/C++ toolchain (`gcc`/`g++`/`make`/`node-gyp`, so native modules build). No Go, no Docker.
- `~/.ssh/` currently has `authorized_keys` only (no `config` yet). `ssh localhost` is
  reachable but key-gated → usable as a self-contained **test box** after adding a loopback key.

## 4. Key decisions (locked)

| #  | Decision        | Choice                                                  | Why |
|----|-----------------|---------------------------------------------------------|-----|
| D1 | Audience        | Single user (personal)                                  | Removes multi-tenancy; one auth gate. |
| D2 | Persistence     | tmux **on each box**                                    | True server-side durability; survives app restart / network drop / reboot. |
| D3 | SSH auth        | Reuse system SSH (keys / agent / `~/.ssh/config`)       | Most secure + simplest; no secret storage; ProxyJump and aliases come free. |
| D4 | Stack           | Node + xterm.js (`node-pty` + `ws` + Fastify)           | Canonical, proven browser-terminal stack; one language; full control over reconnect UX. |
| D5 | Inventory store | JSON file (`data/boxes.json`)                           | Inventory is tiny; SQLite is overkill (YAGNI). |
| D6 | Frontend        | Vanilla TS + Vite (v1)                                  | Minimal deps; can adopt Svelte/Preact later if reactivity gets painful. |

## 5. Architecture

```
Browser SPA (xterm.js)
   │  HTTPS + WebSocket
   ▼
Node server (Fastify) — binds 127.0.0.1 by default
   ├─ Auth gate ......... one password → signed httpOnly cookie
   ├─ REST API .......... boxes CRUD, ssh-config import, status
   ├─ WS /term?box=… .... one node-pty per terminal
   │      └─ spawns:  ssh -tt <alias> "tmux new-session -A -s web"
   └─ Inventory ......... data/boxes.json
```

The server holds no durable terminal state. All durability lives in the per-box tmux
session; the server is a stateless pipe plus an inventory file.

## 6. Components

Each module has one purpose, a small interface, and is testable in isolation.

### `sshConfig.js` — SSH config parser (pure)
Parse `~/.ssh/config` Host blocks into candidate boxes (HostName, User, Port, ProxyJump).
- `parseSshConfig(text) -> BoxCandidate[]`

### `store.js` — inventory store
CRUD over `data/boxes.json`, plus import from the parser.
- `listBoxes()`, `getBox(id)`, `addBox(spec)`, `updateBox(id, patch)`, `removeBox(id)`,
  `importFromSshConfig()`

### `sshCommand.js` — command builder (pure; most carefully tested)
Given a box + session name + terminal size, produce the exact `ssh` argv. Centralizes all
flags so policy lives in one place.
- `buildAttachArgv(box, session, {cols, rows}) -> string[]`
  → `ssh -tt [-J jump] [-p port] [user@]host "tmux new-session -A -s <session>"`
  plus `-o ServerAliveInterval=15 -o ServerAliveCountMax=3` and the host-key policy.
- `buildProbeArgv(box, remoteCmd) -> string[]`
  → one-shot, `-o BatchMode=yes`, no PTY, used by status checks.

### `sessions.js` — live PTY manager
Owns the `node-pty` processes. Maps (boxId, windowKey, client) → PTY.
- `open(box, session, size) -> PtyHandle`  (spawns the attach argv)
- `attach(ws, handle)` / `write(handle, data)` / `resize(handle, size)` / `close(handle)`
- **Grace timer:** on WS close, keep the PTY for ~45s (configurable); reconnect within the
  window reuses the *same* PTY for a seamless re-attach, otherwise the PTY is killed. The
  tmux session on the box is unaffected either way.

### `status.js` — status poller
Periodic + on-demand probes via `buildProbeArgv(box, "tmux ls -F …")` and a `command -v tmux`
check. Reports reachable? / tmux installed? / session + window counts / last activity.
Bounded concurrency and short-lived caching.

### `auth.js` — single-password gate
Hashed password (scrypt) from config/env → on login issue a signed httpOnly + SameSite
cookie. Middleware guards both REST routes and the WS upgrade. Login is rate-limited.

### `server.js` — Fastify host
Serves the built SPA, the REST API, and the `/term` WS upgrade; wires the modules together.

### `web/` — frontend SPA (vanilla TS + Vite)
- **BoxList** sidebar: status badges, add / import / edit / remove.
- **TerminalView:** xterm.js + fit addon + a reconnecting WS client (backoff).
- **Tabs:** open multiple boxes/windows as browser tabs (layout splitting is deferred).
- **Login** screen.

## 7. Data model

Box record (in `data/boxes.json`):
```jsonc
{
  "id": "uuid",
  "label": "prod-db",
  "host": "alias-or-hostname",
  "user": "optional",
  "port": "optional",
  "proxyJump": "optional",
  "sessionName": "web",
  "startupCommand": "optional",
  "tags": [],
  "source": "manual | ssh-config"
}
```
App config (in `config.json` / env): bind address (default `127.0.0.1`), port, hashed
password, host-key policy, grace-timer seconds, optional TLS cert/key paths.

## 8. Core flow — persistence & reconnect (the whole point)

1. Click a box → browser opens `WS /term?box=<id>`.
2. Server auth-checks the WS, looks up the box, calls `sessions.open()`.
3. `node-pty` spawns `ssh -tt <alias> "tmux new-session -A -s web"` at the current cols/rows.
   - `new-session -A` = **attach if it exists, else create** → one idempotent command serves
     both first run and every reattach.
4. PTY ⇄ WS ⇄ xterm.js. On attach, tmux redraws the current screen. Browser resize →
   `pty.resize(cols, rows)` → SIGWINCH → ssh → tmux adopts the new client size.
5. Tab closed / Wi-Fi drops → WS closes → server starts the **grace timer**. Reconnect within
   the window → re-attach the *same* PTY (seamless). Grace expires → kill the local ssh PTY.
   **The tmux session on the box keeps running regardless.**
6. Reopen hours later → the same `new-session -A` re-attaches the still-alive `web` session →
   same windows, panes, running processes, and scrollback (within tmux's history limit).
   *Same state.*

The persistence guarantee comes from tmux living on the box, not from keeping anything alive
on the server.

## 9. Error handling

- **Unreachable / DNS / timeout** → probe fails; red "unreachable" badge; opening a terminal
  shows ssh's stderr inline plus a friendly banner + retry.
- **Auth failure (publickey)** → surface ssh's own error; hint "does this box work from your
  shell?" (no stored secrets to mismanage).
- **New host key** → default `StrictHostKeyChecking=accept-new`; a *changed* key (possible
  MITM) → ssh refuses and we surface the warning prominently, never auto-override.
- **tmux missing on box** → probe detects it → badge + one-click best-effort install
  (`apt`/`yum`/`apk`) or copy-paste instructions. Never silently fail.
- **PTY / WS death** → frontend auto-reconnects with backoff; server re-attach is idempotent.
- **ProxyJump / multi-hop** → handled transparently by reusing ssh config; no special code.

## 10. Security

This app is effectively *root-over-SSH to the whole fleet*, so the auth gate is the crown jewel.
- Default bind **127.0.0.1**. Exposing it is opt-in and pairs with a TLS reverse proxy
  (documented in the README); an optional built-in self-signed TLS toggle is available.
- Password hashed with scrypt, never stored plaintext; signed httpOnly + SameSite cookie;
  mutations are same-site/CSRF-safe; login is rate-limited.
- No key/secret storage — agent and keys stay in the OS.

## 11. Testing

- **Unit (Vitest):** ssh-config parser; command-builder argv (exact flags + tmux string);
  store CRUD + import; `tmux ls -F` status parser.
- **Integration / E2E:** the test harness generates a loopback keypair and appends it to
  `~/.ssh/authorized_keys`, making **localhost a real box**. Then: open a terminal, start
  `sleep 999` inside the tmux session, drop the WS, re-attach, and assert the same session and
  that the process is still running — proving "same state" end-to-end.
- **Playwright (available):** login → add localhost → open terminal → reload page → assert
  re-attach to the same state; verify resize propagation.

## 12. v1 scope vs deferred

**v1 (ship):** auth gate; box CRUD + ssh-config import; dashboard with status badges; open box
→ persistent xterm.js terminal; seamless reconnect with grace timer; resize; multiple boxes as
tabs; error surfacing; localhost self-test.

**Deferred (YAGNI):** in-browser pane/window splitting UI (tmux's own splits already work via
prefix keys — Oh My Tmux is configured); SFTP/file browser; multi-user/sharing;
broadcast-to-many / command palette; metrics graphs; mobile-optimized layout; theming.

## 13. Project layout

```
tmuxifier/
  package.json
  src/server/{server,auth,store,sshConfig,sshCommand,sessions,status,config}.js
  src/web/{index.html,main.ts,components/}     # built via Vite
  data/boxes.json                              # runtime, gitignored
  config.json | .env
  test/                                        # unit + e2e
  README.md
```

## 14. Chosen defaults (knobs, not blockers)

- Grace-timer duration: **45s**, configurable.
- Host-key policy: **`accept-new`** by default, configurable to `yes`.
- TLS for v1: reverse-proxy documented + optional built-in self-signed flag (not required when
  bound to loopback).
