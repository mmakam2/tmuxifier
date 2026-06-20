# Local Shell — Design Spec

Date: 2026-06-20

## Summary

Add a pinned button at the bottom of the sidebar that opens a local tmux-backed
shell on the host machine (no SSH). Users can switch the shell framework
(None / Oh My Zsh / Oh My Bash) via a slim edit modal. The local shell behaves
like a regular box terminal — same attach/detach/resize/grace-period lifecycle —
but bypasses SSH entirely and spawns a local PTY.

## Config

A new top-level key `localShell` (default `"none"`) in the configuration model.
Valid values: `"none"`, `"omz"`, `"omb"`.

- **Default**: `localShell: 'none'` in `DEFAULTS` (config.js).
- **Env override**: `TMUXIFIER_LOCAL_SHELL` (optional, for users who prefer env).
- **config.json**: the edit modal persists changes here via the PATCH endpoint.

The PATCH endpoint mutates the in-memory `config` object so the WebSocket handler
sees the current value on the next connection without re-reading disk.

## API endpoints

All auth-gated (`requireAuth`).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/local-shell` | Return `{ shell: "none" \| "omz" \| "omb" }` from config |
| `PATCH` | `/api/local-shell` | Body `{ shell }`, validate, write `config.json`, mutate in-memory config |
| `POST` | `/api/local-shell/reconnect` | Kill local PTY via `sessions.closeKey('__local__')`, return `{ ok: true }` |

The PATCH handler validates that `shell` is one of the three allowed values and
returns 400 otherwise. It uses `upsertConfigFile` (a new small helper that
reads/modifies/writes `config.json`) and mutates `config.localShell` in place.

## Session manager: `openLocal()`

New method `openLocal({ key, shell, size })` on the session manager returned by
`createSessionManager`. It mirrors `open()` but spawns a local `tmux` command
instead of SSH.

```js
openLocal({ key, shell, size }) {
  // same existing-entry/grace-timer guard as open()
  const args = ['new-session', '-A', '-D', '-s', 'local'];
  if (shell === 'omz')
    args.push("ZDOTDIR='${ZDOTDIR:-$HOME}' [ -f '$HOME/.zshrc' ] && . '$HOME/.zshrc'; exec zsh");
  else if (shell === 'omb')
    args.push("[ -f '$HOME/.bashrc' ] && . '$HOME/.bashrc'; exec bash");

  const pty = spawn('tmux', args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: process.cwd(),
    env: spawnEnv,
  });
  // build entry, fan-out onData, onExit cleanup — identical to open()
}
```

Every other session-manager method (`attach`, `onExit`, `write`, `resize`,
`detach`, `close`, `closeKey`) works unchanged because they only depend on the
entry shape (`pty`, `listeners`, `exitCbs`, `graceTimer`, `exited`), which is
identical.

## WebSocket: `/term` handler

In `server.js`, the `/term` WebSocket handler adds a branch before the box
lookup:

```
if (boxId === '__local__') {
  // read shell from in-memory config (mutated by PATCH)
  const entry = sessions.openLocal({ key: '__local__', shell: config.localShell, size });
  // attach, onExit, message handling — same as interactive mode, no SSH path
  return;
}
// existing box lookup + SSH path continues below
```

The sentinel `__local__` never touches `store.getBox()`, `assertBoxSafe()`, or
`buildAttachArgv()`.

## Frontend

### Sidebar: `.local-shell` bar

A fixed bar at the bottom of the sidebar, after the scrollable `#boxes` list:

```html
<div class="local-shell">
  <span class="local-dot"></span>
  <span class="local-name">local</span>
  <button class="local-refresh" title="Reconnect">↻</button>
  <button class="local-edit" title="Configure shell">✎</button>
</div>
```

- **`.local-name`** — click opens the local terminal (`openTerminal(el, '__local__')`).
  Highlights with `.active` class when the local shell is the active tab,
  mirroring the `.box.active` style.
- **`.local-refresh`** — calls `POST /api/local-shell/reconnect`, closes the
  local tab, reopens if it was active. Same pattern as box reconnect.
- **`.local-dot`** — green when a local PTY is active, gray otherwise. Tracked
  via local tab state rather than SSH probes.

### Edit modal

A slim modal, distinct from the box add/edit modal:

- **Title**: "Local shell"
- **Body**: radio group with three options, pre-selected from `GET /api/local-shell`:
  - None
  - Oh My Zsh
  - Oh My Bash
- **Actions**: Cancel / Save
- **Save**: calls `PATCH /api/local-shell` with the selected value

No host/user/port/proxyJump fields. No Oh My Tmux checkbox (it is assumed
already installed). No provisioning panel — the local host is already set up.

### API client (`api.ts`)

```ts
getLocalShell(): Promise<{ shell: string }>
updateLocalShell(shell: string): Promise<{ ok: boolean }>
reconnectLocalShell(): Promise<{ ok: boolean }>
```

### Terminal (`terminal.ts`)

No changes. The `openTerminal` function already accepts an arbitrary `boxId`
string and connects to `/term?box=<boxId>`. Passing `'__local__'` works as-is.

## Error handling

- **tmux not installed**: `node-pty` spawn will fail. The PTY exit handler fires
  immediately, the WebSocket closes, and xterm.js displays the disconnect
  message with its existing reconnection backoff. No special error surface
  needed — the user will see "disconnected — reconnecting…" which is truthful.
- **Invalid shell value in PATCH**: return 400 with `{ error: 'invalid shell' }`.
- **Config file write failure**: return 500, don't mutate in-memory config (only
  mutate after successful write).

## What stays unchanged

- Session lifecycle: grace period, refcounting, detach/close logic.
- WebSocket protocol: same JSON messages (`t:'i'`, `t:'r'`).
- Box store: `__local__` is never persisted in `data/boxes.json`.
- Status polling: no local-shell entry in the status map. The dot is purely
  client-side state.
