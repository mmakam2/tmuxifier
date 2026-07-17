# Additional tools at provision time — design

Date: 2026-07-13
Status: approved

## Problem

The provision form and the Add/Edit Box modal let the user opt into shell frameworks
(oh-my-tmux / oh-my-zsh / oh-my-bash) that the one-shot provision-terminal script installs on
first open. There is no way to install common tooling (curl, git, gh, node/npm, AI coding CLIs,
bubblewrap) or run a system upgrade at the same moment, so every fresh LXC needs manual apt work
before it's useful.

## Decisions (settled during brainstorming)

- **Curated checklist only** — no free-form package input. Every installable tool is a known id
  with a known install recipe; nothing user-typed ever reaches the remote script.
- **Ephemeral selection** — like omz/omb today: checkboxes in the provision form and the
  Add/Edit Box modal, carried as a WebSocket query param, never persisted on boxes or presets.
- **Installs run in the provision-terminal script** — the selection extends
  `buildEnsureTmuxRemote` (`src/server/boxActions.js`) and runs live in the visible provision
  terminal, with failures surfaced by the existing `set -eu` + exit-code path.

## Tool catalog

Defined server-side in `boxActions.js` as a `TOOLS` catalog (id → script-block builder), ids
exported for validation and for the client to render labels.

| id | Install recipe |
|---|---|
| `upgrade` | Full system update + upgrade via detected package manager: `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade`, `dnf -y upgrade`, `yum -y update`, `pacman -Syu --noconfirm`, `apk upgrade --update-cache`, `zypper --non-interactive update`. Always runs first when selected (other installs then see fresh indexes). |
| `curl` | Distro package `curl` (all managers). |
| `git` | Distro package `git` (the script already auto-installs git when a framework needs it; the checkbox makes it explicit/unconditional). |
| `gh` | Distro package where available — `gh` (dnf/yum/zypper), `github-cli` (pacman/apk). On apt systems the distro archive lacks it, so first install GitHub's official keyring + apt source (per cli.github.com docs), `apt-get update` on that source, then install `gh`. |
| `node` | Distro packages `nodejs` + `npm` (all managers; apk/pacman name them `nodejs npm` too). |
| `codex` | `npm install -g @openai/codex`. Implies `node`. |
| `claude` | `curl -fsSL https://claude.ai/install.sh \| bash`. Implies `curl`. Installs to `~/.local/bin`. |
| `agy` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`. Implies `curl`. Installs to `~/.local/bin` (Google Antigravity CLI). |
| `bubblewrap` | Distro package `bubblewrap` (all managers). |

Rules that apply to every block:

- **Idempotent**: guarded by `command -v <binary>` (for `upgrade` there is no guard — selecting
  it always runs it).
- **Same conventions as the existing git/tmux blocks**: `SUDO` detection by `id -u`, the same
  six package managers in the same order (apt-get, dnf, yum, pacman, apk, zypper),
  `DEBIAN_FRONTEND=noninteractive` on apt, `exit 127` with a stderr message when no supported
  manager exists.
- **Dependency implication is resolved server-side** before script generation: `gh` adds
  `curl` (it fetches GitHub's apt keyring); `codex` adds `node`; `claude`/`agy` add `curl`.
  The client doesn't need to know.
- **Install order**: `upgrade` → distro packages (curl, git, gh, node, bubblewrap) → npm
  globals (codex) → curl installers (claude, agy) → then the existing framework blocks.
- **PATH**: when `claude` or `agy` is selected, idempotently ensure
  `export PATH="$HOME/.local/bin:$PATH"` in `~/.profile`, `~/.bashrc`, and `~/.zshrc` (only
  files that exist, plus `~/.profile` created if absent) using the delete-then-append sed
  pattern already used for the tmux default-shell line, so repeat runs never duplicate it.

## Server changes

- `src/server/boxActions.js`
  - `buildEnsureTmuxRemote(session, startupCommand, options)` gains `options.tools: string[]`.
  - `TOOLS` catalog + exported `TOOL_IDS` (ordered array).
  - A pure exported `resolveTools(ids)` that validates, dedupes, applies implications, and
    returns ids in install order — reused by the WS handler and tested directly.
- `src/server/server.js` (provision WS, `mode=provision`)
  - Parse a `tools` query param (comma-separated ids) via `resolveTools`. Unknown ids reject
    the setup request (script never runs) rather than being silently dropped — the catalog ids
    are the only strings that ever reach the generated script, keeping the existing
    no-user-input-in-shell invariant.

## Client changes

- `src/web/proxmoxUi.ts` (provision form) and `src/web/main.ts` (Add/Edit Box modal):
  an "Additional tools" checkbox group rendered from a shared client-side list of
  `{ id, label }` (ids mirror `TOOL_IDS`; server remains the validation authority).
  `SetupOptions` gains `tools: string[]`.
- `src/web/terminal.ts` `openProvisionTerminal`: append `tools=<csv>` to the WS query when any
  are selected.

## Error handling

Unchanged from the frameworks: the script runs under `set -eu`, a failing install aborts with
its stderr visible in the provision terminal and the exit code surfaced via the WS `{t:'x'}`
frame. Network-dependent installers (`claude`, `agy`, npm, GitHub's apt repo) fail loudly, not
silently.

## Testing (TDD, real code, no mocks)

- `test/boxActions.test.js`:
  - each tool id includes its block; unselected ids emit nothing;
  - implication (`codex` → node block present; `claude` → curl block present);
  - `resolveTools` rejects unknown ids, dedupes, orders correctly;
  - PATH delete-then-append is idempotent, verified with real `sed` (existing pattern at
    `test/boxActions.test.js:310`).
- WS param parsing: `resolveTools` unit tests cover the validation seam (the WS handler is a
  thin passthrough, consistent with how `ohMyZsh=1` params are handled today).
- UI: checkbox group state → `SetupOptions.tools` covered following the existing web-module
  test patterns.

## Out of scope

- Preset-persisted default tool sets.
- Free-form package names.
- A post-provision job phase / Activity-tab install reporting.
- Version pinning or non-distro node (nvm/nodesource).
