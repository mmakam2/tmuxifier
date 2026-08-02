# Terminal features

Split terminals, pasting images and files, voice dictation, the host shell, and per-box
reconnect. Part of the [Tmuxifier docs](../README.md).

## Split terminals

Up to four boxes can share the stage, and splits nest. Drag a box row onto the stage:
dropping on the stage's outer edge splits the whole stage (a full-width or full-height
pane — two side-by-side terminals with a third across the bottom, say), dropping near an
individual pane's edge splits just that pane, and dropping on a pane's center replaces it.
The row's ◫ **Dock** button (visible while the stage has room) is the keyboard path. Every
divider drags to resize its own split (double-click resets 50/50, arrow keys work when it's
focused, and its small ⤢ control flips that split's direction). Every terminal pane — split
or not — carries a header bar: status dot, box name, and `user@host` on the left; on the
right a state chip (agent **working**/**waiting** from the health poller, or connection
state while the terminal reconnects) beside the voice, reconnect ↻, and — in a split —
undock ✕ buttons, so nothing floats over the terminal itself. The focused pane's bar
carries the cyan beacon, `Ctrl+Shift+Arrow` moves focus to the geometrically adjacent pane,
and plain-clicking another box in the sidebar replaces the **focused** pane while the
others keep running. Undocking keeps the terminal connected in the background, exactly like
switching away, and the neighboring pane absorbs the space. The whole arrangement — shape,
directions, and ratios — survives reloads; docked boxes' sidebar rows show the cyan beacon,
with the focused one at full strength.

## Pasting images & files

Pasting an image (Ctrl/Cmd+V) or dropping any file onto a terminal uploads it to
`~/.tmuxifier-uploads/` on that box over the existing SSH connection (the local
shell terminal writes to the Tmuxifier host instead). Tmuxifier then checks what
the pane is doing before typing anything: at a Claude Code or shell prompt it
types the quoted path into the tmux pane itself — so the path appears in every
attached tmux client, not just the browser tab — and shows a tmux status
message. If the pane is busy (vim, a running build), nothing is typed; the path
is shown in a tmux message and in the browser instead. Text paste is unchanged,
and nothing needs to be installed on your own machine or the boxes.

Uploaded files older than 24 hours are cleaned up automatically on the next
upload to that machine. The size limit is 25 MB by default
(`TMUXIFIER_UPLOAD_MAX_MB`).

**Copying out of a terminal:** selecting text copies it to your clipboard
automatically (plus Cmd+C on macOS, Ctrl+Shift+C elsewhere; both need an HTTPS
dashboard). When a full-screen app owns the mouse — Claude Code, vim, tmux
copy-mode — a plain drag goes to the app instead of selecting: either hold
**Shift** while dragging to select in the browser, or just use the app's own
copy — Tmuxifier understands OSC 52, so in-app copies (a tmux copy-mode yank,
Claude Code's selection copy) land on your system clipboard too.

## Voice dictation

Tap **Ctrl+Shift+Space** in any terminal to start dictating, and tap it again to stop: your
browser records audio from your microphone in between, sends it to Tmuxifier on the second tap,
and the transcribed text is typed into the pane — the same way a pasted file path is typed in
(see [Pasting images & files](#pasting-images--files) above). The mic button next to the terminal
works the other way — click and hold it, then release to transcribe — since a physical button has
an unambiguous release and a key chord doesn't.

This is not the same thing as Claude Code's own `/voice` command, and `/voice` cannot work on a
headless box: it opens an audio device on the machine the CLI process runs on, and a box managed
by Tmuxifier has no microphone of its own — it's a remote machine you're SSHed into, often
running unattended. Tmuxifier's voice dictation instead captures audio in *your* browser, where
the microphone actually is, and only ships the recording to the Tmuxifier host for transcription.

Install it from **Settings → Voice**. The tab installs [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
into a repo-local `vendor/whisper/` directory and downloads a speech model from a small pinned
allowlist (verified by SHA-256 before it's written to disk — no user-supplied URL or path is ever
accepted). The install runs on the server as a background job with a live log, so you can close
the modal or navigate away while it works; it takes roughly two minutes and about 1.2 GB of disk.
The same tab has the on/off switch and the model picker, and both take effect immediately.

After turning voice **on**, reload the page. Browsers apply the microphone permission policy when
a page loads, so a tab that was open while voice was off keeps the old policy until it's
reloaded.

There is an equivalent command-line path for headless setups:
```bash
npm run setup-voice           # or: npm run setup-voice -- <model-id>
```

Settings are stored in `data/voice.json` and read on every request, which is why changes apply
without a restart. `TMUXIFIER_VOICE=off` in `.env` disables voice entirely regardless of what's
installed. `TMUXIFIER_WHISPER_BIN` and `TMUXIFIER_WHISPER_MODEL` are escape hatches for pointing
at a whisper build you manage yourself — setting either one overrides the corresponding control,
which the Settings tab then shows as pinned rather than leaving you with a picker that appears to
do nothing.

Microphone access is a browser security-sensitive permission and requires a secure context:
dictation works automatically when Tmuxifier is reached at `http://127.0.0.1:...` or
`http://localhost:...`, but from any other address you need HTTPS — see `TMUXIFIER_TLS_CERT`/
`TMUXIFIER_TLS_KEY` or a TLS-terminating reverse proxy in the
[configuration reference](configuration.md).

Audio never leaves the host: transcription runs locally via the whisper.cpp process Tmuxifier
spawns, not a cloud API, and nothing is sent to Anthropic or any other third party — unlike
Claude Code's built-in `/voice`.

The installed engine and model together take up roughly 1.2 GB under `vendor/`. Run
`rm -rf vendor/whisper` at any time to remove them and reclaim the disk space; re-run
`npm run setup-voice` — or Settings → Voice — later to reinstall.

## Host Shell & per-box Reconnect

The **Host Shell** entry at the bottom of the sidebar opens a terminal on the Tmuxifier host
itself, backed by a local tmux session (`local`) with the same reattach-on-reconnect behavior as
a box. Its ✎ button picks an optional shell framework — None, Oh My Zsh, or Oh My Bash — which
Tmuxifier installs locally when selected; the choice is persisted as `localShell` in
`config.json` (set by the UI — there is no env key). Its ↻ button kills the local tmux session
and starts a fresh one with the current framework.

On hosts with systemd, the Host Shell's tmux server is started in its own transient scope
(via `systemd-run --scope`), outside the Tmuxifier service's control group. That makes the
`local` session survive a Tmuxifier restart — including the restart in the deploy recipe —
exactly as a box's remote tmux survives its dropped SSH connection; the browser simply
reattaches afterwards. Without `systemd-run` the terminal still works identically, but the
session dies with the service, because a tmux server auto-started from inside the service
inherits its control group and systemd kills the whole group on restart.

The same ✎ dialog carries an **Install Claude Code hooks** checkbox. Ticking it and saving
installs on the Tmuxifier host itself the same agent-state hook a box gets from its setup run:
the hook script lands in the host account's `~/.claude/` (or `$CLAUDE_CONFIG_DIR`) and the
matching entries are merged into that account's `~/.claude/settings.json` alongside any hooks
you already have. It requires Claude Code to be installed on the host — if it isn't, the dialog
stays open and reports the install was skipped, and the shell choice is saved either way — and it
takes effect only after you restart any `claude` that is already running, since Claude Code reads
its settings at startup.

Once a hook-aware claude runs **inside the Host Shell's own tmux session** (`local`), its
working/waiting state shows as a badge next to the **Host Shell** button in the sidebar and as
the usual chip in the pane header, exactly like a box. Only that session is tracked: a claude
started outside tmux, or in a different tmux session on the same host, contributes nothing. The
checkbox is an action rather than a stored setting — it starts unchecked every time the dialog
opens, so reopening it won't silently reinstall, and unchecking it never uninstalls anything.
To remove the hooks, delete the `tmuxifier-agent-hook` entries from `~/.claude/settings.json`
yourself.

Every box row also has a ↻ **Reconnect** action. It tears down the box's SSH plumbing — shuts
the ControlMaster down cleanly (removing its socket), drops the local PTY, best-effort kills the
configured remote tmux session, and clears the status-probe backoff — then reopens the terminal.
Use it when a box's connection state looks wedged (e.g. stuck red after a network change) or to
force a fresh login; on-box work in *other* tmux sessions is untouched.

If a box's SSH host key changes (e.g. it was rebuilt at the same address), ssh's own
man-in-the-middle defense refuses the connection: the dot stays red but its tooltip reads "Host
key changed — verify the box," and the row gains a ⚷ **Forget host key** action. It's
confirm-gated — only use it once you've verified the rebuild yourself — and removes the stale
`~/.ssh/known_hosts` entry, then reopens the terminal for a fresh key exchange. Tmuxifier never
clears a `known_hosts` entry just because a connection failed: the only automatic clearing
happens when Tmuxifier itself proves the old machine is gone (a verified Proxmox deprovision) or
just created the new one (provisioning a container onto a freshly assigned address, e.g. a
NetBox-recycled IP); ordinary box removal leaves `known_hosts` untouched since it's shared with
your regular ssh usage.
