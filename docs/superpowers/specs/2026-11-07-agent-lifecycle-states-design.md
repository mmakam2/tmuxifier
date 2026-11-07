# Agent lifecycle states: blocked / done / idle, every session, one attention board

**Date:** 2026-11-07
**Status:** approved design (2026-11-07), awaiting implementation plan
**Prior art:** herdr's agent state model (`working` / `blocked` / `done` / `idle` / `unknown`,
state rollups, shared seen watermark). Claude Code only in this phase; Codex and Antigravity
are tracked as GitHub issues #3 (Codex), #4 (Antigravity) and #6 (OpenCode); the Android app's rendering of
the new states is #5.

## Problem

Tmuxifier already knows, from a hook on the box, whether the Claude Code in a box's
**configured** tmux session is `working` or `waiting`. Three things are missing, and herdr has
all three:

1. **`waiting` is two different situations.** A permission prompt or an `AskUserQuestion`
   dialog is a *blocker*: the agent can do nothing until the operator answers. A finished turn
   is *done*: there is a result to review, and there is no rush. Today both read `waiting`, so
   the badge cannot tell "go answer it now" from "look when you get to it".
2. **Only the configured session counts.** The hook already writes one marker per tmux session
   and the probe already reads every marker, but the health sample, the events, the badge, the
   push and the MCP tools all filter to `box.sessionName`. A second Claude in `web-2` is
   invisible until a pane is switched onto it.
3. **Nothing clears.** A `waiting` badge stays orange until the agent works again, even after
   the operator has read the answer. herdr's `done` decays to `idle` once a person has looked at
   it, on every client at once, so the sidebar is a to-do list rather than a status wall.

## Goals

- Four displayed states per Claude session: `working`, `blocked`, `done`, `idle`. `blocked`
  carries a cause (`permission`, `question`, `elicitation`).
- Every tmux session on every box (and the Host Shell) is tracked, not just the configured one.
- `done` becomes `idle` once the operator has seen that session in any client (web, phone).
  Seen state lives on the server so it is shared.
- Rollups: a per-box badge that shows the worst state across its sessions, per-session state in
  the session picker, a Needs you / Working / Done / Idle board on the standby dashboard, and the
  same counts in phone mode.
- Notifications and FCM push distinguish `blocked` from `done`.
- MCP `wait_for_agent`, `list_boxes`, `box_health` and `read_pane` speak the new vocabulary.
- Existing boxes with the current hook keep working with the old two-state meaning until setup
  is rerun.

## Non-goals

- Screen-shape detection manifests (herdr's `agent explain`), OSC 7501 status reporting, and any
  agent other than Claude Code. See issues #3 (Codex), #4 (Antigravity) and #6 (OpenCode).
- Resume-after-restart. tmux already keeps the process alive; that is the whole point.
- Mark-unread, pinning, or per-client seen state.
- Agent-to-agent orchestration (spawn / prompt / wait across boxes). The MCP server already has
  the primitives; a coordinator design is a separate spec.
- Auto-answering anything. `blocked` is a display and notification state only. Nothing in this
  design sends input based on it.

## Anti-goals (what would make this a failure even if it works)

- A stale `blocked` that pages the operator after they already answered. A blocker must clear
  within one poll of the answer, by a hook event, never by a timer.
- A `done` that re-arms on every server restart, or that flips to `idle` because a screen was
  left on in an empty room.
- Any state inferred from pane text. The hook-only rule stands: a Claude with no marker shows
  nothing, which still means "rerun setup".

## Design

### 1. Marker format (on the box)

Unchanged location (`~/.tmuxifier-agent/<safe-session>`), one line, colon-separated, now four
fields:

```
<session>:<state>:<epoch>:<cause>
```

| Field | Values | Notes |
|---|---|---|
| `state` | `working` · `blocked` · `ready` | `ready` replaces `waiting` on the wire. Whether a `ready` is `done` or `idle` is decided on the server (section 4). |
| `cause` | `prompt` · `resume` · `stop` · `start` · `permission` · `question` · `elicitation` · `unblock` | Why the state was written. Closed allowlist on both ends. |

The server parser (`parseAgentMarks`) accepts three-field lines from the current hook and maps
them: `working` → `working/prompt`, `waiting` → `ready/stop`. Four-field lines with an unknown
state or cause drop, as today. Session names with colons are impossible (tmux forbids them), so
the split stays unambiguous.

### 2. Hook state machine

`tmuxifier-agent-hook.sh` gains three events and one branch; everything about the
background-work gate (`busy/` tokens, `sub.`/`bg.` TTLs, the `<task-notification>` resume rule)
is unchanged.

| Claude Code event | Hook arg | Writes | Notes |
|---|---|---|---|
| `SessionStart` matcher `startup\|resume\|clear\|fork` | `start` | `ready/start` | Today writes `waiting` and is registered unmatched, so a mid-turn auto-compaction also writes it; the matcher excludes `compact`. herdr's rule "startup is not completed work" is why this becomes `idle` on the server, never `done`. |
| `UserPromptSubmit` | `prompt` | `working/prompt` or `working/resume` | `resume` when the payload carries `<task-notification>`; token handling as today. |
| `Stop` | `stop` | `working/prompt` (busy) or `ready/stop` | As today. |
| `PermissionRequest` (no matcher) | `permission` | `blocked/permission` | **Primary writer.** Fires the moment Claude is about to ask, before the dialog. The hook prints nothing and exits 0, which leaves the permission flow unchanged (a decision is only taken from a `decision` object). |
| `Notification` `permission_prompt` | `notify` | `blocked/permission` | Backstop only: Claude Code fires it after the prompt has waited about six seconds, so on its own every `blocked` would lag the dialog and short prompts would never show. Writing the same state twice is harmless. |
| `Notification` `elicitation_dialog`, `elicitation_url_dialog` | `notify` | `blocked/elicitation` | Always lands. |
| `Notification` `agent_needs_input` | `notify` | `blocked/question` | A background agent wants a decision. Documented as agent-view specific, so it will rarely fire in a tmux pane; the mapping is kept because it is correct when it does. |
| `Notification` `idle_prompt`, `agent_completed` | `notify` | `ready/stop` **only when the marker is not already `ready`** | Gated on busy tokens, as today. The extra rule is load-bearing for section 4: `idle_prompt` is a timer that fires about a minute after a turn ends, and a fresh `ready/stop` with a new `ts` would turn a seen `idle` back into `done` with nobody having done anything. A timer never mints a new `ts`. |
| `Notification` any other type | `notify` | nothing | `auth_*`, `quota_*`, `plugin_notification` are not requests for the operator. Today these write `waiting`; that stops. |
| `PreToolUse` matcher `AskUserQuestion` | `ask` | `blocked/question` | New matched registration. |
| `PostToolUse` matcher `AskUserQuestion` | `unblock` | `working/unblock` | New matched registration. `PostToolUse` matches on tool name with the same values as `PreToolUse`, so this fires on a successful answer; the live recording confirms it. |
| `PostToolUse` (no matcher) | `unblock` | `working/unblock` **only if the marker is currently `blocked`** | New. This is the one unmatched per-tool-call hook. The script's top must be restructured so the `unblock` branch runs before stdin is read: `tmux display-message` for the session name, one small file read, exit unless the marker says `blocked`. That is two forks (`sh`, `tmux`) per tool call. The builder measures this on a real box; if it is noticeable, the fallback is a `PostToolUse` matcher built from the `tool_name` the `PermissionRequest` payload carried, which is more code and is not the default. |
| `PostToolUseFailure` (no matcher) | `unblock` | same rule as `PostToolUse` | Fires only when a tool ran and errored. It does **not** fire for a permission denial (a manual denial fires no hook at all), so after a denial the clear comes from the next `PostToolUse`, the operator's `UserPromptSubmit`, or `Stop`. Registered because a failing first tool after a grant is otherwise a stale `blocked`. |
| `PreToolUse` matcher `Bash` | `pretool` | token only | As today. |
| `SubagentStart` / `SubagentStop` / `SessionEnd` | as today | as today | |

Why not clear `blocked` on a timer: a permission dialog can legitimately sit for hours. Why not
rely on `Stop` alone to clear it: a granted permission leads to minutes of work during which
the badge would lie. `PostToolUse` fires on the first tool call after the answer, which is the
moment the blocker is gone.

`claudeAgentHooks.js`'s `HOOK_EVENTS` table must allow more than one entry per event
(`PreToolUse` gets `Bash` and `AskUserQuestion`; `PostToolUse` gets `AskUserQuestion` and the
unmatched entry). The remove-then-append merge filters on the hook path substring, so several
entries per event survive reruns and stay idempotent. The Host Shell installer
(`localShellActions.installAgentHooks`) reuses the same pusher and needs no change of its own.

**Record a real event trace first, then test against it.** Twice before, unit tests over a
synthetic trace were green while the live gate was broken, and the repo holds no recorded
`Notification`, `PermissionRequest` or `PostToolUse` payloads today. The plan's first task is
therefore a recording step: a throwaway hook on a box that appends every event's `$1` and stdin
to a file while the operator walks through a permission prompt (granted, and denied), an
`AskUserQuestion`, a background subagent, an auto-compaction and a normal turn. The hook table
above is frozen only after that recording confirms the event names and payload fields; the
acceptance test in `test/agentHooks.integration.test.js` replays that recording through the
actual script and asserts the marker after each event.

### 3. Probe and sample: every session

`status.js` is already correct: the probe emits every marker and `parseAgentMarks` returns a
map keyed by session. The change is downstream.

`healthHistory.sampleOf` gains `agents`, keyed by session, alongside the legacy `agent`:

```js
sample.agents = {
  'web':   { state: 'done',    cause: 'stop',       ts: 1762500000, attached: false, present: true },
  'web-2': { state: 'blocked', cause: 'permission', ts: 1762500120, attached: true,  present: true },
}
```

- A session appears only when the probe lists it **and** its `paneCmd` matches `^claude(-|$)`
  (the existing presence gate) **and** a marker exists for it **and** its name passes
  `SESSION_NAME_RE`. A marker with no matching live session is ignored, as today. A session
  whose name fails the rule (spaces, `@`) cannot be targeted by any route, including the
  `agent-seen` acknowledgement, so it would be a permanent `done`; it is excluded rather than
  rewritten, the same posture the session picker takes for such names.
- `sample.agent` keeps its old role for the configured session so existing readers do not
  break, but its value is now one of the four displayed states. Writers that still compare it to
  `'waiting'` are listed in section 9 and are all updated in this change.
- `agentPresent` / `agentAttached` stay as they are (they feed the agent-done edge) and are
  additionally recorded per session inside `agents`.

### 4. Seen watermark: `ready` → `done` or `idle`

The server owns one map, `seen[boxId][session] = ts`, where `ts` is the epoch of the newest
`ready/stop` marker the operator has been shown. The derivation, applied in `sampleOf`:

| Marker | Derived state |
|---|---|
| `working/*` | `working` |
| `blocked/*` | `blocked` (with `cause`) |
| `ready/start` | `idle` |
| `ready/stop` with `ts <= seen` | `idle` |
| `ready/stop` with `ts > seen` | `done` |

**How a session becomes seen: a client says so, and nothing else does.**
`POST /api/boxes/:id/agent-seen { session, ts }`. The web client sends it when a pane is docked
on that session, the pane is on screen (phone mode: it is the visible pane),
`document.visibilityState === 'visible'`, the window has focus, and the derived state is
`done`. It sends once per `ts` (the request carries the marker `ts` it is acknowledging, and the
server only ever raises the watermark). The Android app will send it from the session screen
under the same foreground rule (issue #5). The MCP server never sends it: herdr's rule that
reads do not mark seen is the right one, because an automated reader is not the operator.

tmux's `attached` bit deliberately does **not** mark seen. It counts every Tmuxifier PTY: a
docked pane in a hidden browser tab, a closed tab still inside its reconnect grace, and the
Android app's invisible sizing viewer. Letting it clear `done` would be the screen in an empty
room. The one cost is a raw `ssh` + `tmux attach` from outside Tmuxifier: that operator sees
the turn end but the badge stays `done` until they look in a client or the agent works again.
Accepted. `attached` keeps its existing job of **suppressing the notification** (section 5),
which is a weaker claim ("someone may be watching, do not page") than "this was seen".

**When a seen entry is dropped.** Only when a successful probe lists the box's sessions and the
session is not among them. A failed probe (no `sessions`), a Proxmox-stopped box, or a
`paneCmd` that is no longer Claude (the operator switched the tmux window) keeps the entry.
Dropping it in those cases would turn the session back into `done` the moment it reappears,
which is the stale-page anti-goal.

The seen map persists in `data/agent-seen.json` through `jsonFile.js` (0o600, atomic), written
through the existing debounced store pattern and registered with `shutdown.js`. Entries for
sessions that disappear from the probe are dropped on the next `record()`; a seen map that
fails to load starts empty, which makes every finished turn `done` once, never anything worse.

The Host Shell (`__local__`) takes part with the same rules; its "attached" bit comes from the
local probe as today.

### 5. Events and push

`classifyTransitions` runs the agent edges **per session** over the previous and next `agents`
maps, and each emitted event carries `session`. The "previous" map is the last one taken from
a **successful** probe that listed sessions: a sample from a failed probe or a stopped box
carries no `agents` and does not replace it, so a one-poll ssh timeout cannot manufacture a
first appearance. Kinds:

| Kind | Edge | Suppressed when |
|---|---|---|
| `agent-blocked` (new) | `working` or `done`/`idle` → `blocked` | the session is attached in `next` |
| `agent-input` (existing, meaning kept: "turn finished, your input next") | `working` or `blocked` → `done` | the session is attached in `next` |
| `agent-done` (existing: the Claude process is gone) | present → absent, same rules as today | as today |

A session's **first appearance** in the map (new session, hook just installed, box back after
an outage with the session already in some state) emits nothing for either new kind: the
badge, chip and board show it, and paging on first sight is how a probe blip would re-page a
blocker that has been sitting there all along. A `blocked` → `working` → `blocked` sequence
inside one poll interval is one `blocked` sample and one event; a blocker that persists across
polls emits nothing new (edge-triggered, as all health events are). `blocked` → `done` without
a `working` in between (the operator answered and the turn ended in the same interval) still
emits `agent-input`.

The persisted event shape gains `session` and, for `agent-blocked`, `cause`. The events panel
and Android list render them with the session name when the box has more than one. FCM titles
(`fcmPush.js`): `agent-blocked` → "Claude needs you" with the cause in the body
("Permission prompt in web-2 on buildbox"); `agent-input` keeps "Claude is waiting". Settings →
Notifications gets a toggle for the new kind, default on; `notifyPrefs.ts` and the Android
notify toggles list it.

### 6. Rollups in the web client

Precedence everywhere a box is summarised: `blocked` > `done` > `working` > `idle`.

- **Sidebar box row.** The existing single badge becomes the box's worst state. When more than
  one session carries a state, the badge adds a count (`blocked ×2`) and its title lists each
  session and state. `agentBadgeFor(samples)` keeps its signature and does the fold.
- **Attention strip** at the top of the sidebar, above the filter: `2 need you · 3 working ·
  1 done`. Each segment is a filter toggle for the box list (my call: filter, not re-sort; rows
  that jump while you reach for them are worse than a filter you opt into). Hidden when every
  count is zero.
- **Session picker rows** show the session's state as the same chip, so switching a pane to the
  blocked session is one click. The picker already never rebuilds while a row is armed; the chip
  updates in place on the status tick like the sidebar badge does.
- **Pane header chip.** `working` keeps the Clawd sprite. `blocked` is a new chip in the
  theme's danger/attention tier with the cause as text (`permission`, `question`,
  `elicitation`). `done` takes the current orange "waiting" chip's styling with the text
  `done`. `idle` renders a quiet chip so that hooks being present stays visible (silence must
  keep meaning "no hook"). The chip reads the pane's **own** session's entry from `agents`, so a
  duplicate pane on `web-2` shows `web-2`'s state; the configured-session-only rule in
  `paneHeader.ts` goes away.
- **Standby dashboard board.** A new section above the fleet strip, shown only when at least
  one session has a state: four columns, Needs you / Working / Done / Idle, one card per
  session with box label, session name, cause (blocked only), and age since the marker's `ts`.
  Clicking a card docks that box with the pane's session set to that session, exactly as the
  session picker would. Columns are ordered needs-you first and a column with no cards collapses
  to its heading.
- **Phone.** The drawer rows carry the same badge; the attention strip sits at the top of the
  drawer. The board is not shown in phone mode (the drawer is the list).

Colors and chip tokens follow DESIGN.md's tiers; the builder reads it before adding the
`blocked` and `idle` chips and threads them through every theme (`test/styleTokens.test.js`
pins this).

### 7. MCP server

- `AGENT_STATES` becomes `['working', 'blocked', 'done', 'idle', 'gone']`. `waiting` is accepted
  in `until` as an alias for `['done', 'idle']` for one release so existing skills keep working,
  and the tool description says so.
- `wait_for_agent` gains optional `session` (defaults to the configured session) and its default
  `until` becomes `['blocked', 'done', 'idle']`, herdr's "settled" set, with the description
  noting that `done` becomes `idle` only when a person looks.
- `list_boxes` lists every tracked session with its state and cause, not only the configured one.
- `box_health` includes `agents` from the latest sample. `read_pane`'s header line reports the
  state of the session it read, with cause.
- `ROUTES` gains `POST /api/boxes/:id/agent-seen`? **No.** Reads do not mark seen, so the MCP
  client never calls it and the route stays out of its blast radius.

### 8. Routes and device allowlist

- `POST /api/boxes/:id/agent-seen` `{ session, ts }`: browser session or device token. `session`
  must pass `SESSION_NAME_RE`; `ts` must be a finite positive integer. Raises the watermark for
  that session to `max(current, ts)` only if `ts` is not newer than the latest marker the server
  has seen (a client cannot pre-acknowledge a turn that has not happened). 204 on success, 404
  when the box is unknown, 400 otherwise. Added to `DEVICE_ALLOWED_ROUTES`.
- `GET /api/health/series` samples now include `agents`. No new read route.

### 9. Every place that spells `waiting` today

All are updated in this change, with their tests:

| File | What changes |
|---|---|
| `src/server/assets/tmuxifier-agent-hook.sh` | state machine, section 2 |
| `src/server/claudeAgentHooks.js` | multi-entry `HOOK_EVENTS`, new events |
| `src/server/status.js` `parseAgentMarks` | 4-field parse, legacy mapping, cause allowlist |
| `src/server/healthHistory.js` | `agents`, seen derivation, per-session edges, `agent-blocked` |
| `src/server/agentSeenStore.js` (new) | debounced `data/agent-seen.json` |
| `src/server/fcmPush.js` | titles/bodies for the new kind and the session |
| `src/server/server.js` | agent-seen route, device allowlist |
| `src/web/api.ts` | `Sample.agents`, `AgentState`, `HealthEventKind` |
| `src/web/statusDot.ts` `agentBadgeFor` | fold + count |
| `src/web/paneHeader.ts` | pane's own session, new chips |
| `src/web/sessionPicker.ts` | per-row chip |
| `src/web/dashboard.ts` | the board |
| `src/web/main.ts` | attention strip, seen reporting, card click → dock with session |
| `src/web/notifyPrefs.ts`, `healthEvents.ts` | new kind, session in labels |
| `src/mcp/tools.js`, `shape.js` | section 7 |
| `docs/fleet-and-health.md`, `docs/mcp.md`, `docs/android-app.md`, `CLAUDE.md`, `AGENTS.md` | the new states, the seen rule, the new data file in the table; `android-app.md` notes the interim degradation |

**Android is a follow-up, not part of this change** (issue #5). The app is a separate
Gradle build, validated only on a real device, with its own `android-v<version>` release; folding
it in would double the validation effort. The server change is not breaking for the installed
app because `agent` is a free string there (`Models.kt`), but the old app shows no badge for
`blocked`/`done`/`idle` and no `agent-blocked` notifications until updated. FCM pushes for the
new kind arrive once `agent-blocked` is added to `deviceStore.js`'s `NOTIFY_KINDS` allowlist (a
device with no stored toggle for a kind reads as on), which is part of this change.

### 10. Rollout and compatibility

- A box keeps its current hook until setup is rerun (tick Claude Code, save) and `claude` is
  restarted in each session. Until then its markers are three-field and map to
  `working`/`done`-or-`idle` with no `blocked`. The events panel and docs say so.
- No migration of persisted events is needed; old `agent-input` events have no `session` and
  render without one.
- The seen file starts empty: every session currently at `ready/stop` reads `done` once after
  the deploy, and becomes `idle` the first time it is looked at or the next time it works.

### 11. Validation before merge

Per the standing workflow: build in a worktree, rsync `dist/` plus the changed server files,
restart, then on a real box:

1. Rerun setup, restart `claude`, confirm the `idle` chip appears (start is not done).
2. Ask Claude to run a command that needs permission. Within one poll: `blocked · permission`
   chip, sidebar badge, board card under Needs you, browser notification, FCM push on the phone.
3. Answer the prompt. Within one poll of the first tool call: `working`.
4. Let the turn finish with no pane docked: `done`, `agent-input` event. Dock the pane in a
   focused, visible tab: `idle` within one poll, with no new event. Wait past the
   `idle_prompt` timer (about a minute): still `idle`.
5. Repeat step 4 with the pane docked in a **background** tab throughout: no event (attached
   suppresses it), badge stays `done`; focus the tab: `idle`.
5b. Switch the tmux window away from Claude and back, and pull the box's network for one poll:
   the badge returns to the same state with no new event.
6. Trigger an `AskUserQuestion`; answer it; confirm `blocked · question` then `working`.
7. Two sessions on one box in different states: badge shows the worst with `×2`; picker rows
   show each.

## Builder's calls still open

- Exact chip tokens for `blocked` and `idle` per DESIGN.md.
- Whether the attention strip lives inside the existing filter row or above it.
- The `PostToolUse` short-circuit's measured cost (two forks per tool call).
- Debounce interval for `agent-seen.json` (the other job stores' value is fine).

## Builder-check outcome (2026-11-07)

A reviewer read this document as a builder and raised seven questions and two false claims.
All were settled here without a user round: the `idle_prompt` re-arm (timers never mint a
`ts`), seen-entry lifetime and first-appearance edges (section 4 and 5), the attached-marks-seen
contradiction (dropped; clients are the only ack), `PermissionRequest` as the primary blocker
writer, the `SessionStart` compaction matcher, Android as a follow-up (#5), and sessions whose
names fail `SESSION_NAME_RE` (excluded). The two corrected claims are the `PostToolUseFailure`
rationale and the short-circuit cost in section 2.
