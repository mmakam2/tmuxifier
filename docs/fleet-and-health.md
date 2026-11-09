# Status, health & Fleet Command

How Tmuxifier probes the fleet without tripping brute-force protection, the per-box health
history and event timeline, running commands across many boxes at once, and the appearance
settings (themes and the working-agent animation). Part of the
[Tmuxifier docs](../README.md).

## Status, multiplexing & rate-limit safety

Tmuxifier talks to each box over SSH continuously — a background **status probe** keeps the
sidebar dots current, and each open terminal is another SSH connection. Left naive, that churn
(a fresh handshake, plus a failed auth on password boxes, every few seconds) is exactly what
trips a box's brute-force protection — `fail2ban`, `sshguard`, or a connection-rate firewall
rule — and gets the Tmuxifier host's IP **banned**, which then makes the box look dead. Several
mechanisms keep the connection rate low and reuse one warm connection:

- **One shared poll, not one per tab.** Status is probed by a single **server-side** loop (every
  `TMUXIFIER_STATUS_POLL_MS`, default 30s); every open dashboard tab reads the same cached snapshot
  instead of driving its own probe cycle, so the SSH connection rate does **not** multiply with the
  number of tabs you leave open. Concurrent probes of the same box are also coalesced into one
  connection. (Before this, several open tabs could fan out enough simultaneous handshakes to arm a
  box's rate limiter.)
- **Connection multiplexing (keep one warm).** Every probe and terminal for a box shares a
  single persistent SSH **ControlMaster** socket under `data/cm/`, authenticated once and kept
  alive for `TMUXIFIER_CONTROL_PERSIST` seconds (default 600) after its last use. Repeated
  status checks and reconnects ride that one connection instead of re-authenticating — no
  per-probe handshake, no per-probe auth attempt.
- **Adaptive status backoff.** Probing starts at the ~30s poll cadence, but each consecutive
  failure *escalates* the interval (30s → 60s → … up to a **5-minute floor**), and a box that
  needs a password jumps straight to the 5-minute floor — fast probing there can never succeed
  and only feeds `fail2ban`. It never fully stops, so a box that recovers turns green on its own
  within ≤5 minutes. A successful check, or opening/reconnecting the box, resets it to the fast
  cadence.
- **Don't probe a box you're using.** While a terminal session is open for a box, the status
  probe is skipped entirely — the dot is read from the live ControlMaster instead (master up ⇒
  connected; absent ⇒ needs auth) — so a probe can't collide with your interactive login on the
  shared socket.
- **Fail fast, then back off.** Both probes and interactive connects set an SSH `ConnectTimeout`
  (≈6s / 10s) so an unreachable box fails quickly instead of hanging. The browser terminal then
  reconnects on its own escalating backoff to a **5-minute floor** — a box left open while it's
  down settles to roughly one attempt every five minutes (gentle enough not to arm a limiter)
  and auto-reconnects within ≤5 minutes of coming back. A connection that proves stable resets
  the backoff to fast.
- **Bounded fan-out.** A full status sweep probes boxes in small batches
  (`TMUXIFIER_STATUS_CONCURRENCY`, default 4), so the dashboard never opens a fleet-wide burst of
  simultaneous handshakes.

If a box still bans the Tmuxifier host (a red dot that pings but times out on port 22), the bans
are time-limited — the low, backed-off connection rate lets them expire instead of continually
re-arming them. To clear one immediately, unban the Tmuxifier host's IP on that box
(e.g. `fail2ban-client unbanip <ip>`) and consider allowlisting it (`ignoreip`).

## Box health history & events

The dashboard keeps a rolling per-box health trend from the samples the 30-second status poll
already collects — **no extra SSH**. Each box row shows a small sparkline of the last ~hour
(click it to cycle CPU → memory → disk), and the sidebar's **Events** button opens an in-app
timeline of transitions: box went down / recovered / needs login / host key changed, plus
CPU/mem/disk crossing a warn threshold (default 90%, with hysteresis so a hovering value doesn't
flap). Unseen events show as a count badge on the button and are marked seen when the panel is
opened. Events survive restarts in `data/health-events.json`; the sample series is in-memory
only. Tune with `TMUXIFIER_HEALTH_HISTORY_MAX`, `TMUXIFIER_HEALTH_EVENTS_MAX`,
`TMUXIFIER_HEALTH_{CPU,MEM,DISK}_WARN_PCT`, and `TMUXIFIER_HEALTH_HYSTERESIS_PCT`.

Tmuxifier also tracks the coding agent — Claude Code or OpenCode — on **every tmux session** of a
box that has an agent pane (not just the configured one), and on the Host Shell. A session counts
when the active pane of its current window runs `claude` or `opencode`. Both agents report the same
four states:

- **working** — the agent is on a turn.
- **blocked** — the agent needs you. The cause is shown: `permission` (a permission prompt,
  reported the moment the agent asks), `question` (Claude's AskUserQuestion or OpenCode's question
  tool, or a background agent asking), or `elicitation` (an MCP elicitation dialog).
- **done** — a turn finished and you haven't looked at it yet.
- **idle** — the session just started, or a finished turn you have looked at.

A `done` becomes `idle` only when a Tmuxifier client shows that pane in a visible, focused tab
(phone: the pane being shown). A raw `ssh` + `tmux attach` never clears it, and the agent's idle
timers never re-arm it. Claude Code's idle timers only ever end a `working` turn: they never clear
`blocked`, so a permission dialog left open stays `blocked` however long nobody answers. A plain
"No" to a permission prompt fires no hook in Claude Code, so the session reads `blocked` until you
type a prompt or Claude makes its next tool call. A granted permission stays `blocked` until that
tool finishes; a long build reads Needs you for its duration.

OpenCode differs in two places, both because of how OpenCode itself behaves. Rejecting a
permission or dismissing a question **ends the turn** in OpenCode, so the session moves on to
`done` right away; nothing stays `blocked` after a "No". A shell moved to the background with ctrl+b keeps the
session `working` until that shell exits, even though OpenCode has already ended the turn, and its
completion starts a new turn. Every OpenCode TUI on a box talks to one shared OpenCode server, so
the state is matched to tmux sessions by directory: two TUIs in the same directory in different
tmux sessions show the same combined state (see
[The OpenCode checkbox](boxes-and-setup.md#the-opencode-checkbox)). When a TUI exits, its state is
cleared within about 15 seconds.

The state shows in several places. The sidebar badge beside each box shows its worst state
(`blocked > done > working > idle`), with ` ×N` when several sessions carry a state and a tooltip
listing them. The **attention strip** above the box list shows counts (`2 need you · 3 working ·
1 done`); each segment filters the list to boxes with any session in that state (click again to
clear; it expands collapsed groups). The standby dashboard has an **Agents** board with Needs you /
Done / Working / Idle columns, and a card opens that box on that session. The session picker shows
each session's state, and the pane header chip reads `working`, `blocked · <cause>`, `done` or
`idle`. This is ground truth and the **only** source: a small Claude Code hook (or, for OpenCode,
a plugin; for Codex, pi and Antigravity, a reporter that reads their OSC 7501 status reports, see
[The OSC reporter](boxes-and-setup.md#the-osc-reporter-codex-pi-antigravity)) on the box records the state at the moment it changes, and the status probe reads that
record. There is no output-based fallback. A box whose setup hasn't been rerun since the hook was upgraded (or a
claude started before and not yet restarted) shows `done`/`idle` but **never** `blocked` — that
silence means "tick the Claude Code checkbox in the box's Edit dialog, save, then restart claude in
each session". Until then the old hook also rewrites its marker with a fresh timestamp on every Claude Code
notification, including the ~60-second idle timer, so a `done` you have already looked at can come
back within a minute; and a session that just started reads `done`, not `idle`.

The OSC reporter is the third source. It attaches by the pane's command (`codex`, `pi`, `agy`, and
`opencode` only when the OpenCode plugin file is absent). Claude Code is excluded because it
never reports inside tmux (the hook stays its source); pi needs `PI_PROGRAM_STATUS=1` and agy needs `AGY_CLI_OSC7501=on`, which
setup adds to the rc files; a Codex on a Node without `process.execve` runs as `node` and is not
detected. Without the plugin, OpenCode's state aggregates every session of the user's shared
server, so another TUI's pending permission shows as `blocked`. Pane headers, chips and events
name these agents "Codex", "pi" and "Antigravity".

Three event kinds go into the same timeline, each carrying its session and naming the agent:
**Claude needs you: <cause>** (blocked), **Claude finished a turn** (done), and **Claude exited**
(**OpenCode needs you: <cause>** and so on for an OpenCode pane). All three are suppressed while you're attached to
that session, since watching it is its own notification, and a session's first appearance never
notifies. All three are pushed to the Android app (the blocked one as "Claude needs you" or
"OpenCode needs you"). Seen state is saved on the host in `data/agent-seen.json`.

The working chip carries a small animated indicator — Clawd, the Claude Code mascot, or the CLI's
own star spinner. **Settings → Appearance** picks between six modes: Off (no indicator at all),
Static Clawd, CLI star (the default), Wiggle, Pace, and Big hop. The choice is saved on the
Tmuxifier host, so every browser you sign in from follows it (see [Appearance](#appearance)), and
the sidebar badge, pane chips, and dashboard fleet strip all pick it up on their next status
refresh. Blocked chips
stay still on purpose — stillness plus red is what makes it read as your turn — and a browser
asking for reduced motion holds every mode on a single frame.

The **Host Shell** takes part in this too, once you tick **Install Claude Code hooks** (for
OpenCode, **Also install the OpenCode agent-state plugin**) in its ✎ dialog (see
[Terminal features](terminal.md)). An agent running inside the host shell's tmux session raises
the same events, labelled "Host Shell", and they are suppressed the same way
while you're attached to that terminal; the state shows as a badge beside the **Host Shell**
button and as the usual pane header chip. Agent events are the *only* kind it can raise — the
host shell isn't probed over SSH, so it never reports down/recovered or CPU/memory/disk
thresholds and has no card on the standby dashboard's fleet strip.

Browser notifications for these agent events (a separate toggle for each kind, including the new blocked one, on by default) and for the box-health events above can be toggled
per kind in **Settings → Notifications**: per-browser, and they only fire once you grant the browser's
notification permission (which itself requires an HTTPS dashboard). All events always appear in
the events log regardless of which kinds have notifications enabled.

## Appearance

**Settings → Appearance** holds the two looks-only preferences: the **theme**, and the
working-agent animation described above. Both are saved on the Tmuxifier host
(`data/ui-settings.json`) rather than in the browser, so one pick follows you to every browser
and device you sign in from — the browser you change it in switches instantly, the others follow
on their next load. There is no Save button; if the save can't reach the server the choice still
applies in that browser for the session, and the tab says so.

Three themes ship built in:

- **Vercel** (the default) — pure black field, hairline gray seams, deployment blue, and the
  one commit button per view as a white inverted key.
- **Bench Instrument** — the machined charcoal chassis with amber phosphor readouts, the look
  described in [DESIGN.md](../DESIGN.md). It is also the engine's baseline: the theme the
  stylesheet's own tokens paint before any theme file applies.
- **Original** — the first tmuxifier look: deep navy field, cyan glow.

A theme re-skins the whole app, not just the chrome: sidebar and modals, the standby dashboard
and its cards, the terminal glass — open terminals re-color live, no reattach — and the Fleet
script editor. Status lamps stay green/red/amber/violet: a lamp's color is what it means, not
decoration, so a theme inherits them unless it has a deliberate reason not to. The login screen
paints in the chosen theme too, and that's the one piece of it kept in the browser — a copy of
the theme id in `localStorage`, purely so the pre-login page doesn't flash another theme before
there's a session to ask the server about.

Adding a theme is a code change rather than a setting, and it is three edits: a CSS file under
`src/web/themes/` that overrides the token block in `src/web/style.css`, one entry in the
`src/web/themes.ts` manifest, and its import in `src/web/theme.ts` — the edit that actually loads
the stylesheet. The token contract and the rules a theme has to respect are in
[DESIGN.md](../DESIGN.md#themes).

## Fleet Command

Click **Fleet** in the sidebar to enter selection mode, tick any number of boxes (or whole tag
groups), type a command, and **Run**. The command runs once on each selected box over the same
non-interactive SSH path used for status probes, and each box's exit code and output are captured
centrally. Each run is a **job** held on the server: close the tab and the run keeps going —
reopen the dashboard and the **Jobs** button lists recent jobs with their per-box results. Jobs
are persisted to `data/fleet-jobs.json` (last `TMUXIFIER_FLEET_MAX_JOBS`, default 50). The fan-out
is capped at `TMUXIFIER_FLEET_CONCURRENCY` (default 4) so a fleet-wide run never bursts SSH
connections. Password-only boxes with no live connection come back as a per-box error (the
non-interactive path can't answer a password prompt) — open that box's terminal once to establish
the connection, then re-run.

The **⤢** button beside the command box opens a full bash-script editor: newlines are honored, so
you can write a real script rather than a one-liner (⌘/Ctrl+Enter runs it).

Scripts you expect to run again can be **saved**. Give the script a name — and an optional note —
in the editor and press **Save** (⌘/Ctrl+S), and it joins the rail on the left of the modal, ready
to load, edit, rename or delete. Saved scripts live in `data/fleet-scripts.json` on the Tmuxifier
host, so they survive a browser change, a different device, and a restart; the job history labels
each run with the name of the script it came from.

A saved script's body is stored as plain text — the file is owner-only (`0o600`) but not
encrypted, and the same text is persisted again in the fleet job history along with its output.
Don't paste credentials into one.

A saved script is not limited to fleet runs: the box setup form and the Proxmox
Provision tab can select one to run as the last step of setting a box up. See
[Post-setup script](boxes-and-setup.md#post-setup-script).
