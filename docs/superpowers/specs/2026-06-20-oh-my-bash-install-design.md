# Oh My Bash Install Option Design

## Goal

When adding or editing a box, Tmuxifier should offer an option to install Oh My Bash on the remote host if it is not already installed. The shell options (Oh My Zsh / Oh My Bash) are mutually exclusive — the user picks at most one. Oh My Tmux remains an independent option.

## Current Behavior

The Add/Edit box modals include an "Install Oh My Zsh if missing" checkbox (checked by default when adding) and an "Install Oh My Tmux" checkbox. These are independent checkboxes. There is no Oh My Bash option.

## User Experience

The shell options in the Add/Edit box modals will change from a single OMZ checkbox to a radio-style group:

- **( ) None** — no shell framework installed
- **( ) Oh My Zsh** — install Oh My Zsh if missing
- **( ) Oh My Bash** — install Oh My Bash if missing

"Oh My Tmux" remains a separate independent checkbox above the shell group.

The radio group defaults to "None" in both Add and Edit dialogs (no pre-selected shell framework).

If "Oh My Bash" is selected, the server will:

1. Detect the bash binary (`command -v bash`)
2. Fetch and run the upstream Oh My Bash install script non-interactively:
   - `sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh)" </dev/null`
   - Fall back to `wget -O-` if `curl` is unavailable
   - `</dev/null` prevents the installer from reading stdin
3. Set tmux `default-shell` to bash and respawn the first window with bash (mirrors OMZ behavior)

The install is idempotent. If `~/.oh-my-bash` already exists, Tmuxifier treats Oh My Bash as installed and skips the install steps. If installation is requested and fails, the provision flow removes the newly persisted box (existing rollback behavior).

Unlike OMZ, there is no need to install bash itself (it is present on virtually all systems). The `chsh` step is still included for consistency — it ensures the user's default shell is explicitly set to bash, matching the OMZ behavior.

## Architecture

`installOhMyBash` is a transient request option — same pattern as `installOhMyZsh` and `installOhMyTmux`. It is sent with `POST /api/boxes` (or `PATCH /api/boxes/:id`) and the provision WebSocket, but is never persisted in `boxes.json`.

### Data flow

```
Add/Edit Box Dialog (main.ts)
  ├─ [x] Install Oh My Tmux           (independent checkbox)
  ├─ ( ) None / ( ) OMZ / (•) OMB     (shell radio group)
  └─ Submits via api.addBox({ installOhMyBash: true, ... })
     └─ Opens provision panel with { ohMyBash: true }

POST /api/boxes  (or PATCH /api/boxes/:id)
  └─ Destructures installOhMyBash out, persists only Box fields

WebSocket /term?mode=provision&ohMyBash=1
  └─ buildEnsureTmuxRemote() generates bash script with OMB steps
     └─ sessions.provision() executes, rollback on failure
```

### Files changed

| File | Change |
|------|--------|
| `src/web/main.ts` | Replace OMZ checkbox with shell radio group (None/OMZ/OMB); add OMB to submit handlers & provision panel |
| `src/web/api.ts` | Add `installOhMyBash?: boolean` to `AddBoxSpec` and `updateBox` signature |
| `src/web/terminal.ts` | Add `ohMyBash` to `ProvisionOptions` interface and WebSocket query string |
| `src/server/server.js` | Destructure `installOhMyBash` from req.body (POST + PATCH); pass `ohMyBash` from WS query to `buildEnsureTmuxRemote` |
| `src/server/boxActions.js` | Add OMB install steps (detect bash, download install.sh, idempotent install, set tmux default-shell + respawn) |

### Provisioning script (OMB section)

```bash
# Detect bash binary
BASH_BIN="$(command -v bash || true)"

# Idempotent Oh My Bash install
if [ ! -d .oh-my-bash ]; then
  if command -v curl >/dev/null 2>&1; then
    OMB="$(curl -fsSL https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh)" || { echo "Failed to download Oh My Bash" >&2; exit 1; }
    sh -c "$OMB" </dev/null
  elif command -v wget >/dev/null 2>&1; then
    OMB="$(wget -O- https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh)" || { echo "Failed to download Oh My Bash" >&2; exit 1; }
    sh -c "$OMB" </dev/null
  else
    echo 'Oh My Bash install requires curl or wget' >&2
    exit 127
  fi
fi

# Re-detect bash and set as default shell (mirrors OMZ chsh pattern)
BASH_BIN="$(command -v bash || true)"
if [ -n "$BASH_BIN" ]; then
  if [ "$(id -u)" = '0' ]; then
    chsh -s "$BASH_BIN" root || true
  else
    sudo -n chsh -s "$BASH_BIN" "$(whoami)" 2>/dev/null || chsh -s "$BASH_BIN" "$(whoami)" || true
  fi
fi

# Set tmux default-shell to bash and respawn
[ -n "${BASH_BIN-}" ] && { "$TMUX_BIN" set-option -g default-shell "$BASH_BIN" 2>/dev/null || true; W=$("$TMUX_BIN" list-windows -t <session> -F '#{window_index}' 2>/dev/null | head -1); [ -n "$W" ] && "$TMUX_BIN" respawn-window -t <session>:<window> -k "$BASH_BIN" 2>/dev/null || true; } || true
```

Key differences from OMZ: no package-manager install step (bash is ubiquitous). The `chsh` call and tmux default-shell/respawn are included for consistency with the OMZ pattern.

## Error Handling

The existing provision rollback path handles all failures: if the OMB install script exits non-zero, the WebSocket handler sends the error to the client and removes the box via `store.removeBox()`. Specific failure modes:

- `curl`/`wget` unavailable → exit 127
- Download succeeds but content is empty → caught by `|| { echo ...; exit 1; }`
- `~/.oh-my-bash` already exists → idempotent skip (no-op)
- SSH/network failures → surfaced as provision errors
- Filesystem permission problems → surfaced as provision errors

## Testing

Tests will be written first, mirroring the OMZ test pattern:

- `test/boxActions.test.js` — verify the remote script includes OMB install steps when requested, omits them when not, and skips the clone when `~/.oh-my-bash` already exists
- `test/server.test.js` — verify `POST /api/boxes` and `PATCH /api/boxes/:id` strip `installOhMyBash` from the stored box
- `test/server.ws.integration.test.js` — update existing provision tests to cover the new option shape
- TypeScript compilation verifies the web-client changes
