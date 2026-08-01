# Status, health & Fleet Command

How Tmuxifier probes the fleet without tripping brute-force protection, the per-box health
history and event timeline, and running commands across many boxes at once. Part of the
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

Tmuxifier also watches each box's configured tmux session for Claude Code and raises **claude is
waiting for input** / **claude finished** (the pane is no longer running Claude Code) events into
the same timeline — suppressed while you're actively attached to that session, since watching it
is its own notification. The state shows in three places: the pane header chip, the standby
dashboard's fleet strip, and a small working/waiting badge next to the box label in the
sidebar. This is ground truth, and it is the **only** source: a small Claude
Code hook on the box records working/waiting at the moment it changes, and the status probe
reads that record — so the "waiting" alert fires on the next poll and never false-positives on
a parked session. There is no output-based fallback: a claude on a box whose setup has not been
rerun since the hook was introduced (or a claude started before the hook landed and not yet
restarted) shows **no** working/waiting chip and raises no agent events — that silence means
"tick the Claude Code checkbox in the box's Edit dialog, save, then restart claude in the
session", not "the agent is fine". Browser
notifications for these agent events and for the box-health events above can be toggled per kind
in **Settings → Notifications**: per-browser, and they only fire once you grant the browser's
notification permission (which itself requires an HTTPS dashboard). All events always appear in
the events log regardless of which kinds have notifications enabled.

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
