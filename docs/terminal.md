# Terminal features

Split terminals, pasting images and files, voice dictation, the host shell, per-box
reconnect, and the phone layout. Part of the [Tmuxifier docs](../README.md).

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

## Phone mode

At 720px wide or narrower — a phone held upright — Tmuxifier reflows into a single-pane layout
built for a thumb. It's a width test, not a device test: rotate a large phone into landscape and
it's usually wider than 720px (a Pixel 5 is 851, an iPhone 14 is 844), so the desktop layout
comes back. The switch is live either way — the stage re-renders on rotation, no reload needed.
Nearly all of it lives inside that breakpoint, so a wider window is laid out exactly as it
always was. Three pieces are deliberately width-independent, and all three are no-ops on a
desktop browser: the page is measured in dynamic viewport units (identical to the old fixed
ones anywhere without a retracting browser chrome) and padded clear of a device's safe-area
insets (zero where there is no notch — which is also what keeps the sidebar out of the cutout
on a phone held in *landscape*, wide enough to get the desktop layout), and the mic button
suppresses the browser's own touch handling of a press-and-hold, which a mouse never triggered.

**The shell.** The sidebar becomes a left slide-over drawer and a slim top bar takes its place:
a ☰ button that opens the drawer, and a dropdown that switches which pane the stage is showing.
An open drawer is dismissed by tapping the dimmed area beside it (or Escape, if you have a
hardware keyboard), and by anything in it that changes the screen — opening a box or the Host
Shell, the nameplate, Settings, Log out, Add box, Fleet Jobs, Proxmox, Events, and the fleet
bar's **Run on N** button. Controls that act *inside* the drawer deliberately leave it open:
the search field, the group headers, and the **Fleet Command** toggle, whose whole job is to
reveal the fleet bar and the per-box checkboxes within the drawer itself. Modals and the
Fleet/Events panels stack above the drawer, since on a phone the drawer is the only route to
them.

**One pane at a time.** The stage renders a single full-screen terminal: the focused pane if
it's docked, otherwise the first one. The others aren't closed — they sit in the same
background parking the desktop uses for undocked terminals, still connected and still running
their tmux sessions — and the top-bar dropdown switches between them instantly (it's disabled
while there's only one pane to show). Rendering one pane doesn't flatten the split you built:
the saved arrangement is still there when you return to a wide screen. Divider drags, the drop
zones and the ◫ **Dock** button are all hidden, so a phone can move between panes but never
create a split; tapping a box that isn't docked replaces the focused pane, the same thing a
plain sidebar click does on the desktop.

**The touch key bar.** On a touch device a key bar sits along the bottom of the screen carrying
what a soft keyboard either lacks or types unreliably: `esc`, ^C (a dedicated Ctrl+C — the
interrupt, sitting beside `esc` because those two are how you interrupt Claude Code), ⇥ (Tab),
and ⇤ (Shift+Tab), with ✏️ (the composer, below), ⏎ (Enter) and the **mic** pinned at the
bar's right edge — you can submit a line (answer a prompt, send a message to a running agent)
without opening the soft keyboard at all. Everything fits on one row with nothing to scroll, sized for screens as
narrow as a foldable's cover display. On a phone the
voice button moves out of the pane header and into this bar, and moves back to the header when
the layout returns to desktop width. Press and hold it to dictate and release to transcribe,
exactly as on the desktop (see [Voice dictation](#voice-dictation)) — a hold that drifts under
your finger stays a hold rather than turning into a scroll. A narrow *desktop* window gets the
phone layout but no key bar, and keeps its mic in the pane header: the bar is for pointing
devices that are actually coarse.

Keys are sent the moment you press them and never steal focus from the terminal, so the soft
keyboard doesn't drop away under you each time you tap a cap. Firing on press is also why the
bar deliberately holds few enough caps to never scroll: a sideways swipe begun on a cap of a
scrolling strip would send that cap's key before the strip moved. The arrow caps were dropped
for exactly that reason — they were what made the strip overflow narrow screens. You rarely
miss them: dragging on the terminal already sends arrow keys at a prompt (the scroll fallback,
which follows the terminal's cursor-key mode), and in Claude Code's interface a long-press
picks options directly.

There is deliberately no `ctrl` cap. The bar once carried a **sticky** Ctrl (tap to arm, the
next character masked into its control code), but a soft keyboard running autocorrect
**composes** — it buffers letters into a word and hands the terminal the whole word at once,
which the mask must pass through untouched — so on such a keyboard `ctrl` then `c` typed a
plain `c`. That is why ^C has its own cap: it sends the interrupt itself and owes the keyboard
nothing. When the composer arrived, the width budget of the narrowest phones fit exactly one
more always-on control, and the ✏️ earned the slot the mostly-inert `ctrl` held. For the rare
other combination (Ctrl+D, Ctrl+R, Ctrl+Z), a hardware keyboard is the reliable route — and
the sticky-Ctrl machinery remains in the code, so the cap can return as quickly as the arrows
could.

**The composer.** Composing goes further: the terminal can't be *edited into* — every byte the
soft keyboard commits is already sent, so an autocorrect that rewrites a word mid-sentence
garbles the line at the prompt. The pinned ✏️ cap swaps the key bar's cap strip for a native
text field and a ➤ **Send** button (the same ✏️, lit amber, closes it again).
Type — or dictate: while the composer is open the mic appends the transcript into the field —
with the full soft keyboard: autocorrect, word suggestions and cursor edits all work normally
here, because the terminal sees nothing until you tap Send. Send transmits the message plus
Enter in one tap; newlines in the draft are collapsed to spaces (a raw newline would submit
mid-text). The field then clears and stays focused for the next message, and Send on an
*empty* field is a bare Enter — answering "press Enter to continue" without leaving the
composer. Your draft survives closing the composer and switching panes; Send delivers to the
focused pane, and keeps the draft if that pane has no live terminal behind it (a box still
setting up, a stopped container). Tap the in-bar ✏️ to return to the caps and direct terminal
input.

**Touch and mouse-aware apps.** When the app in the pane takes mouse input (Claude Code's
fullscreen interface, tmux with `mouse on`), a stray tap would otherwise *click* it —
selecting and activating whatever option it happened to land on. So while mouse tracking is
active, a tap only focuses the terminal; to deliberately tap a button or an option in such an
app, press and hold for about half a second. A long-press never summons the soft keyboard:
if the keyboard was up it stays up, and if it was hidden it stays hidden — picking an option
is not a typing intent. Drag-to-scroll is unchanged, and apps that don't take mouse input
(a plain shell prompt) see no difference at all.

**The soft keyboard.** The layout is measured against the browser's visual viewport rather than
the window, so the prompt and the key bar stay above the on-screen keyboard instead of being
buried under it — iOS Safari in particular doesn't shrink the page when the keyboard opens. The
open drawer is measured the same way, so the end of the box list and the Host Shell row stay
reachable while you're typing in its search field. Page zoom is factored out of that
measurement, so a browser zooming in by itself (which iOS does when you focus any small field)
doesn't resize your terminals. While the keyboard is open, the top bar (☰ and the pane
switcher) hides to give its row to the terminal — rows are scarcest exactly then, and neither
control is useful mid-typing; closing the keyboard brings it back. Terminal text is set one
point larger on a touch phone for legibility, decided when each terminal opens — flipping
across the breakpoint mid-session leaves already-open terminals at the size they started with.

**Not yet.** Notifications still come from the dashboard tab itself, so a phone with the screen
locked won't tell you Claude is waiting; doing that properly needs Web Push and an installed
PWA, which is its own project. A multi-pane stage on tablets, and swipe gestures for switching
panes, are deferred as well. The design record is
`docs/superpowers/specs/2026-08-02-mobile-phone-mode-design.md`.
