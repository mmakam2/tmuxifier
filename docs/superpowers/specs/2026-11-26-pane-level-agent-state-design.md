# Pane-level agent state: design

Date: 2026-11-26. Status: design, awaiting approval. Nothing here is built.

## 1. Intent

Tmuxifier tracks AI-agent state per tmux **session**. An agent actually runs in one tmux
**pane**. The mismatch shows up in three ways today:

- Two agents in two windows (or two split panes) of one session read as one state, the worst of
  them. The sidebar shows `BLOCKED ×3` and only a hover tooltip says which.
- A session shows a state only when the active pane of its current window runs an agent. An
  agent in a background window has no state at all while a shell is in front.
- Notifications, the "seen" acknowledgement and the jump targets all name a session, so they
  cannot say which agent needs the operator.

The operator's decision: **the pane is the unit, for every harness and every consumer, in one
round.** Sessions and windows stay as what they are in tmux (where a pane lives, what you attach
to, what mail is addressed to) and become labels and grouping for agent state. Nothing stores a
folded state.

## 2. Goals, non-goals, anti-goals

**Goals**

- One agent pane = one tracked state, one seen mark, one notification stream, one row.
- All five harnesses report per pane: Claude Code, OpenCode, Codex, pi, agy.
- Every consumer reads panes: sidebar, pane header chip, session/window picker, dashboard board,
  attention strip, agent switcher, health events and browser notifications, FCM push, the
  Android app, the MCP server, agent mail and agent workers.
- The sidebar lists a box's agents as child rows under the box (layout B, section 7).
- Clicking an agent anywhere takes the operator to that pane: its session, its window, the pane
  focused.
- The session-level compatibility fields are deleted, not kept beside the new ones.

**Non-goals**

- Typing into a pane that is not the session's active pane (`POST /keys`, uploads, dictation
  keep targeting the session's active pane).
- Changing what mail is addressed to. A message is still sent to `box/session`.
- Naming panes by their title. Rows are named by position (section 7).
- Removing `paneCmd` from session rows or changing `STATUS_FMT`.
- Per-TUI identity for OpenCode. Two OpenCode panes in one directory still share a state.

**Anti-goals** (would make this a failure even if it works)

- A second source of truth: a stored session state next to the pane states.
- A `done` that the operator is looking at and cannot clear, or one cleared for a pane that was
  never on screen.
- A box that has not had setup rerun going dark for the non-Claude agents.
- Any command against the operator's default tmux server from a test.

## 3. Approaches considered

1. **Add panes under sessions.** Keep `agents[session]` as a computed fold, add a nested list.
   The app, MCP and mail keep working untouched. Rejected by the operator: it leaves a
   compatibility field and two shapes to reason about.
2. **Replace the unit everywhere (chosen).** One map keyed by pane, every consumer moved in the
   same round, the legacy fields deleted. Cost: a lockstep Android release, MCP changes, and the
   mail hub re-pointed. The operator is the only user and accepted that.
3. **Browser-only list.** Compute rows in the browser from a richer probe. Dropped early:
   acknowledgement and notifications would stay per session, so rows would show states that
   cannot be cleared one at a time.

Within approach 2 the unit was first proposed as the window. The operator asked for the pane,
because a window with two split agents has the same gap one level down. The pane is the atom:
below it there is nothing to fold.

## 4. The model

### 4.1 Identity

An agent pane is identified by `(box id, tmux pane id)`. A pane id is `%N`, unique on a box's
tmux server for the life of that server. Validated everywhere with one exported
`PANE_ID_RE = /^%\d{1,9}$/`, defined beside `WINDOW_ID_RE` in `sshCommand.js`.

A pane id survives the pane moving between windows (including Oh My Tmux's maximize, which
moves a pane into a temporary window). The session, window and position of a pane are read
fresh on every probe and are never part of the key.

### 4.2 What the probe reads

`PANE_FMT` grows so one `__PANE__` row places a pane and says whether it is on screen. The
command stays last because it can contain colons:

```
#{session_name}:#{window_id}:#{pane_id}:#{pane_index}:#{pane_active}:#{window_zoomed_flag}:#{pane_current_command}
```

Which window is a session's current one, and each window's index and name, already come from
the `__WIN__` rows. A pane joins its window through `(session, window_id)`.

The status entry gains a parsed, allowlisted `panes` list (it is box output: every field
checked, a bad row drops, the 400-row cap stays, and an absent or capped listing still means
"cannot be trusted to be complete"):

```
panes: [{ session, windowId, pane, index, active, zoomed, cmd }]
```

`agentMarks` is replaced by `paneMarks`, keyed by pane id. The rename is deliberate: a reader
still doing `Object.hasOwn(marks, sessionName)` must fail loudly, not silently read nothing.

```
paneMarks: { '%12': { session, state, cause, ts } }     // null-prototype
```

Rules for `parsePaneMarks` (the successor of `parseAgentMarks`):

- A five-field marker `<session>:<state>:<epoch>:<cause>:%<pane>` counts only while `panes`
  lists that pane in that session with something other than a shell in the foreground. This is
  today's liveness rule, unchanged. If two markers name the same pane (a pane that moved
  sessions leaves its old file behind), the one whose session matches the listing wins; if both
  match (grouped sessions), the newer.
- **Session-wide markers** (four fields, and the legacy three-field form) are written by boxes
  that have not had setup rerun, and by the Claude hook when it has no usable `$TMUX_PANE`. One
  rule covers them: *a session-wide marker applies to every agent pane of that session that has
  no marker of its own.* The old "ignored when older than the newest pane marker" comparison is
  deleted; the new rule makes it unnecessary. This rule is the whole compatibility layer and can
  be deleted once every box has been rerun.
- An absent or capped pane listing fails open as today: no marker is discarded for being absent
  from it. Session-wide markers then apply to nothing (there are no known panes to apply to).
- Closed sets for state and cause, positive finite `ts`, drop-never-rewrite: unchanged.

The per-session fold (`foldMarks`, `markRank`) is deleted from the parser.

### 4.3 The sample

`sample.agents` is re-keyed by pane id and holds **only panes whose foreground command is an
agent** (`agentKindOf(cmd)` is not null). Non-agent sessions no longer get a `present: false`
entry.

```
agents: {
  '%12': {
    session: 'main',
    windowId: '@3', windowIndex: 2, windowName: 'frontend', paneIndex: 1,
    agent: 'claude',                  // kind
    state?: 'working'|'blocked'|'done'|'idle', cause?, ts?,   // only with a marker
    visible: true,    // its window is the session's current one, and it is not hidden by zoom
    focused: true,    // visible, and it is the active pane of that window
    attached: true,   // its session has a tmux client attached
  }
}
```

- "Is an agent running here" is the pane's own command. The bug where an agent behind a shell
  window had no state is gone by construction.
- `state` is `deriveAgentState(mark, seenTs)` exactly as today, with the watermark looked up by
  pane id.
- A pane running an agent with no marker carries no state (still the cue to rerun setup).
- Display fields ride in the entry so every renderer (browser, push, app, MCP) labels a pane
  from the sample alone. `windowName` is already cleaned and capped at 64 characters.
- Deleted from the sample: `agent`, `agentPresent`, `agentAttached` (the last two have no
  runtime reader today).

**On screen** means `visible && attached`. It replaces the session's `attached` flag wherever
that flag suppressed something.

**Grouped sessions.** Tmuxifier never creates grouped sessions, but an operator can
(`new-session -t`), and then one pane is listed once per session of the group. There is still
one entry per pane id. Its `session` is the one its marker names when the listing shows the pane
there, otherwise the first session listing it, and `windowIndex`, `visible`, `focused` and
`attached` all describe that one session. Consequence, accepted as a limit: watching such a pane
through another session of the group neither acknowledges it nor silences its notifications. It
errs toward an extra notification, never a missed one. Full support would mean keying by
session and pane everywhere and is out of scope.

### 4.4 Edges and events

`agentEdges` runs per pane with the same rules as today, with "on screen" in place of
"attached":

- A pane's first appearance never notifies.
- `agent-blocked`: now `blocked`, was `working`/`done`/`idle`, not on screen.
- `agent-input`: now `done`, was `working`/`blocked`, not on screen.
- `agent-done`: the pane had a state and is now gone or no longer runs an agent, and was not on
  screen before and is not now. Because non-agent panes are no longer in `agents`, the detector
  takes "is this pane on screen now" from the status's `panes` list, not from the map.
- A pane still running an agent whose marker vanished is a gap, not an exit. `recordAgents`
  keeps bridging its state in the baseline exactly as it does per session today.

Events carry the pane and enough to name it without a lookup:

```
{ kind, boxId, label, host, t, session, pane: '%12', window: '2:frontend', paneIndex?, cause?, agent? }
```

`paneIndex` is present only when the pane's window held more than one agent at the time. Every
renderer prints `session › window` plus `.paneIndex` when present.

The effect the operator asked for: an agent that blocks in window 2 notifies while the operator
is attached and looking at window 1. Today that is silent.

### 4.5 Seen

- `data/agent-seen.json` becomes `{ [boxId]: { [paneId]: markerTs } }`. Keys that are not pane
  ids are dropped on load. One-time effect of the upgrade: turns that were finished and already
  seen read `done` once more until looked at. No migration is attempted (a session name does not
  say which pane).
- `markSeen(boxId, paneId, ts)` keeps its rules: the pane must have a marker `ts`, a `ts` ahead
  of the marker is refused, an older watermark is never lowered.
- `POST /api/boxes/:id/agent-seen` takes `{ pane, ts }`. `pane` is validated with
  `PANE_ID_RE`. Still allowed for device tokens.
- The browser acknowledges, for each docked pane that is visible in a focused window, every
  agent entry with `session ===` that pane's session, `visible === true` and `state === 'done'`.
  So looking at a window clears every agent visible in it, and never one in a background window
  or behind a zoomed neighbour.
- Stale watermarks from a reused pane id (tmux server restart) are harmless: the watermark is
  compared with the marker's own `ts`, and a new agent's marker is newer.

"Seen is a client claim" holds unchanged: only this route raises the watermark; attachment and
MCP reads never do.

### 4.6 Knowing which window is in front, in time

`visible` changes when the operator switches windows with tmux keys, which writes no marker and
so triggers no real-time probe. Left alone, a `done` agent the operator has just switched to
would stay `done` until the next 30 s sweep.

When a marker changes, the light probe re-reads windows and panes, so notification suppression
and acknowledgement are always judged on a fresh listing. The only stale case is the benign one
above. To close it, the box watch loop (`agentWatch.js`) adds to its change signature one line
per pane of `#{pane_id}#{window_active}#{pane_active}#{window_zoomed_flag}`. Cost: one extra
`tmux` fork per tick per watched box, only when tmux exists. A change still prints only `c`;
the stream's vocabulary does not grow. The Host Shell stays on the sweep for this.

## 5. Routes

- `POST /api/boxes/:id/agent-seen`: `{ pane, ts }` (section 4.5).
- `POST /api/boxes/:id/window`: gains an optional `paneId`. With it, the remote selects the
  window and then focuses the pane with an exact, fully qualified target:

  ```
  select-window -t '=<session>:<@id>'  &&  select-pane -Z -t '=<session>:<@id>.<%N>'
  ```

  Measured on tmux 3.6: this target is accepted, fails with a non-zero exit when the pane is no
  longer in that window or session (so a stale id cannot focus something else), and `-Z` keeps a
  zoomed window zoomed on the newly focused pane. All three ids are validated on the route and
  re-validated in the builder immediately before interpolation. Same gates as today (409 while
  setup runs, 502 on a failed command, a best-effort `probeOne` after).
- `GET /api/boxes/:id/pane`: gains an optional `pane=%N`, browser session only, like `session`
  (403 for a device token). It captures that pane by the same qualified target without changing
  focus, and returns that pane's state as `agent`/`agentCause`. Without `pane`, it captures the
  session's active pane as today and returns the state of that session's `focused` entry.
  `GET /api/local-shell/pane` follows the same rule. Both answers also carry `pane` (the id of
  the pane captured) and `agentTs` (its marker's `ts`, when it has one), so a client that only
  ever sees a capture can acknowledge it.
- **New** `POST /api/local-shell/window` `{ windowId, paneId? }`: the Host Shell's counterpart of
  the window route, so a Host Shell agent row is a real jump target. Browser session only
  (absent from the device allowlist, like `GET /api/local-shell/pane`). It runs the same two
  commands locally against the `local` session and nothing else, with the same validation, and
  never creates the session. To label its rows, the Host Shell sampler (`localAgent.js`) also
  lists windows, parsed by the same `parseTmuxWindows`.
- `GET /api/status`, `/api/health/series`, `/api/health/events`: shapes change as in section 4.

## 6. Box-side writers

Every writer ends up writing `~/.tmuxifier-agent/<safe session><%pane>` holding
`<session>:<state>:<epoch>:<cause>:%<pane>`. Nothing new is installed; the two changed assets
arrive by a setup rerun, like any asset change.

### 6.1 Claude Code hook: no change

It already writes this format. Claude boxes need no setup rerun.

### 6.2 OSC 7501 reporter (Codex, pi, agy, OpenCode fallback)

- Each listener writes and removes only its own pane's marker. `next_action` keeps using the
  marker file as its only memory; the file is now the pane's own.
- Deleted: the sibling fold on the write path (`session_fold`, `_sibling_folds`, `live_entries`
  as a fold input) and the sibling branch of `_bare_clear`, which shrinks to "unlink if the
  content is still what this listener wrote".
- The attach seed rule "a marker that exists is never touched" becomes per pane.
- When a listener notices its pane's session changed, it removes its old-session file under the
  same ownership rule.
- **Migration at handover.** A listener of the new version inherits `lastWritten` from an old
  listener, describing the old session-wide file. It removes that file if its content still
  equals the inherited `lastWritten`, then writes its own per-pane marker from the inherited
  records. For the one pass in which old and new listeners coexist, an old one may rewrite the
  session-wide file; the server's session-wide rule (section 4.2) reads that correctly.
- The handover protocol, the registry, the loop and `attach %N` are otherwise untouched.

### 6.3 OpenCode plugin

- The state part writes one marker for **every** pane running `opencode`, not only the active
  pane of the active window. A pane in a background window now has a state, which is the point.
- A pane's state is the fold of the root OpenCode sessions in that pane's directory tier
  (`tierOf`, unchanged). This fold is attribution, not a unit: OpenCode's one shared server gives
  no per-TUI handle. Two panes in one directory show the same state. This is the known limit,
  stated in the user guide.
- The `since` floor ("since this began hosting opencode") is kept per pane.
- The hand-over between plugin versions must not misread the old session-keyed `since` and
  `written` maps as pane-keyed ones. Old session-wide files this plugin wrote are released by
  its existing "delete only what I wrote" rule on the first sweep after a hot reload.
- **Mail targets are unchanged**: one target per tmux session, by the existing rules. The held
  wait, the ack, the pane tagger and the permission handler are untouched.

## 7. The browser

### 7.1 Sidebar (operator-approved layout B)

A box's agents are child rows under the box row, indented behind a hairline guide. Each row has
its name on the left and its state chip on the right, with its own hover and click. The box row
loses its agent badge. A box with no agent has no child rows.

```
● web01
  cpu 12% · ram 58% · disk 47%
  │ 1:api            [BLOCKED · PERMISSION]
  │ 2:frontend.1     [WORKING]
  │ 2:frontend.2     [DONE]
● lab01
  │ main › 1:opencode            [IDLE]
  │ worker-site-1 › 1:claude     [WORKING]
```

Mockup the operator chose from: https://claude.ai/artifact/UxD7h9AMFx4AKEEWge4e33 (option B).

Rules (proposed by the designer, shown on the mockup, not objected to):

- **Name**: tmux's own `window-index:window-name`. `.pane-index` is added only when that window
  holds more than one agent. `session ›` is added only when the box has agents in more than one
  session.
- **Order**: session name, then window index, then pane index. Rows do not move when a state
  changes.
- **Click**: jump to the pane (section 7.3).
- The chip is the existing agent chip, with the working sprite on `working`.
- The Host Shell row gets child rows the same way, for the `local` session's agents.
- Phone drawer: the same rows; a tap jumps and closes the drawer.
- Rows repaint in place on health data, as the badge does today; a poll that changed nothing
  must not rebuild them (hover and focus survive).

The naming, ordering and row-building logic is one pure function in `agentState.ts`, unit
tested, and used by every surface that lists agents.

### 7.2 Other surfaces

- **Attention strip**: counts panes. The filter keeps a box with any pane in that state.
- **Pane header chip**: the worst state among the agents `visible` in that pane's session, that
  is, what is on screen in that terminal. Agents in the session's other windows are not in the
  chip; they are on their rows in the picker and the sidebar.
- **Session/window picker**: a window row gets a chip, the worst of the agents in that window. A
  session row keeps a chip, the worst of the session. These are display summaries computed on
  the spot from the pane map.
- **Dashboard board**: one card per agent pane, labelled box plus the row name; click jumps. The
  fleet card keeps a single worst-state chip for the box.
- **Agent switcher**: one row per agent pane, keyed by box and pane id (the MRU too; old
  session-keyed MRU entries simply never match). "This pane" marks the `focused` agent of the
  focused docked pane's session. The preview captures that exact pane through the pane route's
  `pane` parameter. The switcher still never acknowledges and never sizes.
- **Events panel and browser notifications**: name the pane. The notification tag becomes
  `kind:box:pane`, so two agents on one box no longer replace each other's notification.

The "worst of" helper stays in `agentState.ts`, used only for these summaries.

### 7.3 Jumping to a pane

A jump target is `{ boxId, session, windowId, pane }`, all taken from the agent entry.

1. Dock the box on that session using today's plan (`planCommit`: focus a docked pane already on
   that session, else switch, replace or open).
2. Unless the entry is already `focused`, call the window route with `paneId`.
3. Acknowledge through the normal `reportSeen` path once fresh data shows the pane visible.

Selecting a window moves every tmux client attached to that session. That is already true of a
window pick today.

## 8. Other consumers

### 8.1 Agent mail and workers

Mail stays addressed to `box/session`. The hub gets `paneMarks` and `panes` in place of
`agentMarks` and `sessionsOf`.

- A session **runs an agent** when any pane mark names it.
- **Delivery**: a queued message goes to a connected waiter whose own pane's marker reads
  `ready`. Waiters already carry their pane. This replaces "the session's marker reads ready":
  an idle agent takes mail even while a sibling pane in the same session is working. Approved by
  the operator as "it goes to a pane in that session that is ready".
- `who`, the queued-status phrases and the bare-target choice keep speaking about sessions. The
  word shown for a session is the summary of its panes.
- "Can take mail" and the worker checks ("is this session on `claude`", `runningWorkers`) use
  the pane list: any pane of the session running that agent, not only the active pane.
- The load-bearing rule in `CLAUDE.md` is reworded to "only while that pane's marker reads
  `ready`". Every other mail rule is unchanged.

### 8.2 FCM push

Text names the pane (`in main › 2:frontend.1`). Data gains `pane` and `windowId` beside `boxId`,
`kind`, `session`.

### 8.3 MCP server

- `list_boxes` and `box_health` print one item per agent pane, named by the same rule.
- `wait_for_agent` gains an optional `pane` (`%N`). Without it, it waits on the `focused` agent
  of `session` (default the configured session), which is the pane `read_pane` shows and
  `send_text` types into; `gone` when that pane runs no agent.
- `read_pane` reports the state of the pane it captured.
- No new route in the `ROUTES` table.

### 8.4 Android app

The app reads the scalar `sample.agent` today, in a two-word vocabulary that predates the four
states, and ignores the session in a push. It moves straight to panes:

- Model: `Sample.agents` as a map of pane entries; `Sample.agent` removed.
- Fleet list: a box's agents as rows under its card, same naming rule, four state colours.
- Session screen chip: the state of the pane on screen (the pane snapshot's `agent`).
- A tap on an agent row, or on a push, opens the box on that agent's session (the existing
  `PATCH sessionName`), then selects its window and pane through the window route.
- Notification id is per box and pane.
- **The app acknowledges.** It shows `done` for the first time, so it must be able to clear it.
  While the session screen is in the foreground and its latest capture carries a `done` state,
  the app posts `agent-seen` with the capture's `pane` and `agentTs`, once per marker `ts`. It
  acknowledges only the pane it rendered, never the others in that window. The route is already
  allowed for device tokens.
- A new version, released the usual way and pinned by `npm run fetch-apk`. An installed older
  app shows no agent state until it updates; the operator accepted this.

## 9. Constraints that still bind

- tmux targets are exact and session-qualified; pane ids are validated on every route and again
  right before interpolation.
- Box output is untrusted: `__PANE__` rows, pane indices and flags go through an allowlisting
  parser with the row cap.
- Real-time paths are triggers, never data. The watch stream still says only `c` and `h`.
- The read-ordering rule in `statusPoller.js` covers `panes` and `paneMarks` together with
  `sessions`.
- Tests use real code and a private tmux server (`TMUX_TMPDIR` or an explicit socket). No test
  may reach the default tmux server.
- No unreleased code is pushed to fleet boxes; the box-side assets are validated on the test
  box.

## 10. Testing and validation

- Unit: the parser (five-field liveness, session-wide rule, grouped and moved panes, capped
  listing), sample building, per-pane edges and the gap bridge, `markSeen`, the naming function,
  every pure web view-model, MCP shaping.
- Recorded traces stay the acceptance tests for the writers: the Claude hook replays must pass
  unchanged; the OSC replay helper is reworked to per-pane trails; the OpenCode reducer replays
  are unchanged and the pane attribution tests are re-keyed.
- Integration against a private tmux: two split agents in one window, an agent in a background
  window, a pane moved between windows, the qualified `select-pane` and its failure on a stale
  id, the OSC handover migrating a session-wide file.
- e2e: sidebar rows, per-pane acknowledgement (never for a pane in a background window), jump,
  switcher, live update.
- Android: JVM tests for the model and naming; the Compose screens on the operator's device.
- Live walk before merge, on the test box: Claude in split panes and in a background window;
  Codex, pi, agy after a setup rerun and before one; two OpenCode panes in different
  directories and in the same one; mail to a session with one working and one idle agent.

## 11. Left to the builder

- File and function names beyond those fixed above, and how the work is split into commits.
- The exact markup and CSS of the child rows, within `DESIGN.md`; what the collapsed sidebar
  shows for them.
- How the Android rows look, within the app's existing style.
- Whether the OpenCode hand-over detects the old maps by a version stamp or by shape.
- The wording of the reworked user guides (`README.md`, `docs/fleet-and-health.md`,
  `docs/terminal.md`, `docs/mcp.md`, `docs/android-app.md`, `docs/agent-messaging.md`,
  `docs/dashboard.md`, `docs/boxes-and-setup.md`) and of `CLAUDE.md`/`AGENTS.md`.
- Build order. Suggested: server model and probe, browser, OSC reporter, OpenCode plugin, mail
  and workers, MCP, Android, docs.

## 12. Designer's calls for the operator to check

1. A session-wide marker applies to every agent pane of its session that has no marker of its
   own (section 4.2).
2. The seen file is not migrated; already-seen finished turns read `done` once after the
   upgrade (4.5).
3. The watch loop gains one `tmux` fork per tick so a window switch is noticed within about a
   second (4.6).
4. The pane header chip shows only what is visible in that terminal (7.2).
5. The dashboard fleet card keeps one worst-state chip per box (7.2).
6. `wait_for_agent` without `pane` waits on the session's focused pane (8.3).
7. The Android scope in 8.4.
8. Row naming, ordering and click behaviour (7.1), shown on the mockup.
9. Grouped sessions are tracked under one session of the group, with the limit stated in 4.3.
10. A new browser-only route selects a window and pane in the Host Shell (section 5).
11. The Android app acknowledges the pane it is showing (8.4).
