# Agent switcher (Ctrl+Shift+K) and Settings → Hotkeys

Status: design, awaiting approval · 2026-11-12 (v2, after two reviews against the code)

## Why

The operator runs agents in many tmux sessions across many boxes. Getting to a particular
one today means one of two routes:

- finding its box in the sidebar, docking it, and picking the session from the pane's
  session picker;
- going back to the standby dashboard's AGENTS board, which is visible only when no pane
  is docked.

The idea comes from herdr's "Go To" list. The interaction model is macOS Cmd-Tab: hold the
modifiers, tap a key to step through the candidates, release to jump. A single quick tap
flips back to the previous session.

Success: from anywhere in the app, the operator reaches any agent session in the fleet with
one held chord and a few taps. A quick tap-and-release toggles between the two most recent
agent sessions.

## Goals

- A keyboard switcher over **every agent session** in the fleet, in any state (blocked,
  working, done, idle). One row per session, not per box: a box with two agent sessions
  shows twice.
- **Most recently used** order, Cmd-Tab style.
- A **preview** of the highlighted session's screen (the last lines of its pane), so the
  operator can see what an agent is asking before jumping.
- On release: **focus** the pane already showing that session, or else **replace** the
  focused pane's content with it.
- **Settings → Hotkeys**: a new tab where the operator remaps the switcher's chord and the
  existing voice hotkey.
- Works on macOS and Windows browsers. The operator uses Helium (Chromium) on macOS, where
  Ctrl+Shift+K was confirmed to reach the page.

## Non-goals

- Phone mode. There is no hardware keyboard, so the switcher is off there: under
  `phoneMode.ts`'s 720 px flag, and with `(pointer: coarse)`.
- Sessions with no agent, plain shells and windows.
- Search or type-to-filter. This is a cycler, not a palette.
- Remapping copy/paste, which stays fixed in `clipboard.ts`, or anything other than the
  switcher and voice.
- Any change to agent state, the seen watermark or notifications.
- Any new capability for device tokens (the Android app, MCP). Everything this design adds
  on the server is browser-session only.

## Anti-goals (failure even if it "works")

- **Stealing a terminal key.** Plain Ctrl+K, kill-to-end-of-line in bash, zsh and Claude
  Code, must still reach the pane, and so must Alt/Meta-letter readline keys. That is why
  every hotkey must include Ctrl+Shift (see validation).
- **Leaking keystrokes.** No event belonging to a chord may reach the PTY or trigger the
  browser's own shortcut: not the taps, the auto-repeat, the arrow keys used while open, or
  the modifier keyups.
- **Muting agents the operator left.** A session the switcher moves away from must stop
  counting as attached, or its `agent-blocked`/`agent-input` notifications stay suppressed
  (`healthHistory.js` suppresses them while a session is attached).
- **Marking things seen from the switcher.** Highlighting a row or showing its preview
  never raises the seen watermark ("Seen is a client claim", CLAUDE.md). The existing path
  does that after the jump: `reportSeen` acknowledges every docked pane while the window is
  visible and focused.
- **Rendering box output as markup.** The preview is untrusted box output. It is rendered
  as text only (`textContent`), with escapes stripped.
- **Resizing a session from the switcher.** The preview fetch never sends `cols`/`rows`.
- **A fetch per tap.** Tapping quickly through ten rows must not fire ten SSH captures.
- **Widening device-token reach,** above all to the Tmuxifier host's own terminal
  (`deviceHostGuard.js` exists to keep devices off this machine).

## Decided by the operator

1. Default chord: **Ctrl+Shift+K**, with Ctrl (not Cmd) on both macOS and Windows.
2. **Settings → Hotkeys** lets the operator remap it.
3. Each step lands on an **agent session**, not a box.
4. Order is **most recently used**.
5. Layout is **option C** from the mockups, a list with a live preview beside it:
   https://claude.ai/artifact/JBbBnsAEhroxr6pTKeH2x1
6. On release, if the session is already open in a pane, that pane gets focus. Otherwise
   the session **replaces** the focused pane's content.
7. Items marked *(confirmed)* were proposed by Claude and accepted by the operator as a set.
8. Hotkey mappings are **remembered per browser**. A combo remapped to suit Edge on Windows
   must not change the Mac's Helium mapping.

## Behavior

### Opening, stepping, committing

- The chord's first keydown opens the switcher, highlighting the **first row that isn't the
  focused pane's own session** (see Order).
- While the chord's modifiers stay held, the following keys move the highlight; both
  directions wrap:

  | Keys | Moves |
  |---|---|
  | the chord key (K) | down |
  | ↓ | down |
  | ↑ | up |

  Holding a key auto-repeats, so holding K scrolls the list as Cmd-Tab does.
- There is **no separate back hotkey**. *(Claude's call. The first draft's Ctrl+Shift+J
  opens the DevTools console in Chrome and Edge on Windows. Arrow keys while the chord is
  held clash with nothing, and with one remappable key per action the "next and back must
  share modifiers" problem goes away.)*
- **Releasing** either chord modifier commits. Concretely: a keyup of Ctrl or Shift, or any
  key event arriving with `ctrlKey` or `shiftKey` false while the switcher is open, commits
  the highlighted row.
- **Losing focus cancels.** `blur` or `visibilitychange` cancels without committing; this
  covers Cmd-Tab, Ctrl+Shift+Esc and a DevTools focus grab mid-chord.
- **Esc** cancels. **Clicking a row** commits to that row. *(confirmed)*
- The overlay paints only after the chord has been held about 150 ms, so a quick
  tap-and-release flips without flashing it. *(Claude's call, matching Cmd-Tab.)*
- With no other agent session to go to, the switcher shows one line, "No other agent
  sessions", and the release does nothing.
- **Where the hotkey is inert:** while any `openModal` backdrop is open (Settings, Edit
  Box, and the rest), and while Settings → Hotkeys is recording a combo. *(Claude's call.)*
  `dom.ts` keeps its open backdrops private today; expose a predicate.
  - Non-modal popups (the session picker, the Fleet Jobs drawer) do not block it. The
    switcher closes an open session picker when it opens.
- The switcher overlay is not an `openModal` modal and does not count as "a modal is open".
  It tears down on logout like other body-mounted UI.

### Key interception

- A **document-level capture-phase** `keydown`/`keyup` listener owns the chord. That is the
  only option that works with focus anywhere on the page, terminal or not.
- For every event that belongs to the chord, it calls both `preventDefault()` and
  `stopPropagation()`, so neither xterm nor the browser acts on it. The events that belong
  to it:
  - the opening keydown;
  - repeats;
  - the stepping keys and arrows while open;
  - Esc while open;
  - the keyups of all of these and of the modifiers.

  Returning `false` from xterm's handler alone does not call `preventDefault`. Events
  outside an active switcher chord pass untouched, apart from the opening chord itself.
- This leaves xterm's one custom key handler (`terminal.ts` `wireClipboard`) alone. The
  voice handler stays there.
- The two chords are disjoint by validation, so neither can swallow the other's keys. The
  voice chord's key set, `isVoiceHotkeyChordKey`, is derived from the voice combo's own
  modifiers and key, not from the switcher's.

### Which sessions are listed

- One row for every session that has an agent state, on every reachable box, built from
  the same per-session data as `agentState.ts`'s `agentCards()`. *(confirmed)*
- Not listed:
  - sessions with no agent, or with an agent but no marker yet (as on the board);
  - unreachable boxes. *(confirmed)*
- **Host Shell:** only its `local` session is listed, as "Host Shell".
  - The `__local__` series also carries every other tmux session on this host's default
    server (`localAgent.js` uses `list-panes -a`), but the Host Shell pane can attach only
    `local`, so those rows could be neither previewed nor opened.
  - *(Claude's call. The AGENTS board keeps showing them, so the two differ on exactly
    this, deliberately.)*
- Boxes with a running setup job or a stopped Proxmox guest are listed normally. Committing
  to one docks it the way the sidebar would, so it shows its "setting up" or "stopped"
  panel. *(Claude's call.)*
- While the switcher is open, the **order is frozen** at the moment it opened. Each row's
  state chip and age update live. A row whose session disappears mid-cycle stays in place,
  shown as gone, and committing to it does nothing.

### Order (MRU)

- **What counts as "use":** a session becomes most recent whenever the pair (focused pane,
  that pane's attached session) changes, by any path:
  - focus moves;
  - the session picker switches the pane;
  - the AGENTS board opens a session;
  - the sidebar docks a box;
  - the stage is restored at boot;
  - a switcher commit.

  `focusedPaneId` is assigned in many places, so compute this in **one** place: after
  `repaintStage`/`syncPaneFocus`, compare the current pair with the last one recorded and
  bump on change. *(Claude's call.)*
- **Row order:**
  1. If the focused pane's session is an agent session, it is pinned as row 1.
  2. Then the sessions the operator has used, newest first.
  3. Then sessions never used in this browser, in the board's precedence (blocked, done,
     working, idle), newest state change first within a state. *(confirmed)*

  The initial highlight is the first row that isn't the focused pane's session. So a quick
  tap always lands on the most recent *other* session, even when the focused pane is a
  plain shell, a stopped panel or the dashboard.
- **Storage:** MRU is remembered per browser in `localStorage`, keyed by `boxId` + session
  and capped at about 100 entries. Every access is wrapped in try/catch. *(confirmed. MRU
  is a per-viewer convenience, which CLAUDE.md allows browser storage for.)*

### Each row

The row shows:

- the state chip (with the blocked cause, via `agentChipText`);
- the box label;
- the session name;
- the agent kind (`AGENT_LABEL`);
- the age of the last state change (`fmtAge`);
- a "this pane" marker on the pinned row.

Styles use the existing `chip-agent-*` state classes and DESIGN.md tokens. The mockup's
literal values are not authoritative.

### Preview

- **What it shows:** the right side shows the last lines of the highlighted session's
  screen as plain text. The header repeats the box, session and state.
- **What the client requests and how it renders it:**
  - It asks for a small `lines` value (about 40).
  - It strips escapes with a small pure stripper, unit-tested (none exists in the web
    client yet; `src/mcp/shape.js` has the server-side one to mirror).
  - It trims trailing blank rows, so an inline (non-alt-screen) agent doesn't preview as
    empty space.
  - It wraps long lines.
- **When it fetches:**
  - Only after the highlight has **rested about 250 ms**. A newer highlight aborts the
    older request in the client.
  - At most **one capture in flight per box** from this browser.
  - Snapshots are cached per session for a few seconds. *(confirmed / Claude's call)*
- **Server load:** a client abort does not stop the server's ssh, which can run up to 8 s.
  So the server **coalesces** concurrent captures of the same box and session (single
  flight), to stay well inside sshd's `MaxSessions` alongside the resident watch stream.
  *(Claude's call.)*
- **Placeholder and failure:** a quiet placeholder shows until the preview arrives. On
  failure it shows one line saying the preview is unavailable. The switcher never blocks on
  a preview.
- **Setup jobs:** preview capture is read-only and stays **ungated** while the box's setup
  job runs, consistent with the read-only probe.
- **Server change: the pane route's `session` parameter.** `GET /api/boxes/:id/pane` gains
  an optional `session` query parameter:
  - Validated with `SESSION_NAME_RE`; a bad value is a 400 and is never rewritten.
  - **Browser-session only.** A request carrying `session` from a device token
    (`req.deviceId` set) is refused with 403.
    - The allowlist is keyed by route URL, so this check lives in the handler.
    - It needs a test.
    - The Android app and MCP don't need it, and the first draft's justification ("a device
      can attach any session via `/term`") was wrong, because `/term` is cookie-only.
  - When `session` is present, `cols`/`rows` are **ignored**, because the sizing viewer is
    wired to the configured session and the switcher must never size anything.
  - The response's `agent`, `agentCause` and `sessionName` come from that session,
    `agent` from `last.agents[session].state`, not from the legacy configured-session
    field.
  - Absent `session` behaves exactly as today.
- **Server change: Host Shell capture.** A **new browser-session-only route**, for example
  `GET /api/local-shell/pane`.
  - It is **not** on `DEVICE_ALLOWED_ROUTES`.
  - A test shows a device token is refused.
  - It runs the same capture over the local `/bin/sh` transport that `localShellActions.js`
    uses, for the `local` session only.
  - It is not a `__local__` branch of the box pane route, which is device-allowlisted.

### Committing to a session

Given the highlighted `(boxId, session)`:

1. **Already open in a docked pane** (that box, attached to that session; for the Host
   Shell, simply docked): that pane gets focus, and nothing else moves.
2. **Not open.** The commit target is the focused pane, or `panes[0]` when `focusedPaneId`
   is null; a stopped or setup panel is replaceable like any pane. The target's content is
   replaced:
   - **Same box, different session:** switch session the pane-local way
     (`switchPaneSession`).
   - **Different box:**
     - Pick the instance for the slot. Prefer a **parked tab of the target box already
       attached to that session** if one exists; otherwise reuse the lowest free ordinal.
     - If the reused instance holds a terminal on a *different* session, it gets
       `closeTab(id, { keepPane: true })` before its session override changes. Otherwise
       `ensureTab` returns early and the pane shows the old session under the new header.
     - It takes the slot via `replacePane`.
   - **The occupant it replaces is closed**, with a full `closeTab` that drops its PTY. The
     session left behind stops counting as attached, so its notifications fire again, and
     repeated hops can't pile up parked instances (`instancesOfBox` counts them) until the
     server's per-box viewer cap of 8 refuses an attach. *(Claude's call. The trade-off:
     flipping back reconnects, about a second with the 64 KB replay, instead of being
     instant from a parked tab.)*
   - **Host Shell** (single-instance, move-only): when it isn't docked, it takes the slot
     the same way.
3. **Nothing docked** (standby dashboard): the session opens as the first pane.
   *(confirmed)*

`openPaneOnSession` in `main.ts` is close to this, but it re-points the box's existing
pane, where this spec replaces the **focused** pane, and it leaves parked tabs alive. The
switcher gets its own commit function. The AGENTS board and the sidebar keep their current
behavior; this design does not change their parking.

After the commit, the existing paths take over: focus, the header update, `reportSeen`, and
the MRU bump described above.

## Settings → Hotkeys

A new tab, **Hotkeys**, placed after Appearance (`SECTIONS` key order in `settingsUi.ts`).

| Action | Default |
|---|---|
| Agent switcher | Ctrl+Shift+K |
| Voice dictation (toggle) | Ctrl+Shift+Space |

### Recording a combo

- Each row shows its current combo, a **Record** control and **Reset to default**.
- Record listens in the capture phase and swallows what it reads, so the modal's own
  document Esc handler (`dom.ts`) never sees it. Esc cancels recording without closing
  Settings.
- While recording, the live switcher and voice hotkeys are suppressed.

### Validation

A combo is the modifier set plus one `KeyboardEvent.code`. Validation is a closed rule set:

- **Modifiers** must be exactly Ctrl+Shift or Ctrl+Shift+Alt. *(Claude's call.)*
  - Shift with Ctrl is what keeps terminal keys free.
  - Alt-only and Ctrl+Alt combos are refused: Alt-letter is a readline/Claude Code key,
    Option-letter types characters on macOS, and Ctrl+Alt is AltGr on Windows.
  - **Meta/Cmd is never allowed.** In Chromium on macOS a key's keyup isn't delivered while
    Cmd is held, which breaks chord tracking.
- **The key** must be a letter, digit, Space, or one of a small allowlist of punctuation
  codes. Not Tab, Esc, Enter, or the arrows (the arrows step the switcher).
- **Rejected combos:**
  - the clipboard combos of **every** platform (Ctrl+Shift+C/V; Cmd is already
    excluded), so one rule set holds on every platform;
  - the other action's combo;
  - combos browsers keep for themselves, as a union over Chrome, Edge and Firefox on macOS
    and Windows: Ctrl+Shift+T/N/W/Q/J/I/B/Delete, plus Ctrl+Shift+K/J's DevTools siblings
    where known.
- **A note under the list** explains that some browsers keep certain combos. Edge and
  Firefox on Windows use Ctrl+Shift+K for "duplicate tab" and the web console. If the
  switcher doesn't respond in one of those, pick another combo.
- Each rejection says why in plain words.

### Matching and live updates

- Matching uses `KeyboardEvent.code` (the physical key), like today's voice handler.
- Both handlers read the combo through a **getter at event time**. The voice handler is
  created once per terminal, so a Settings change must reach live terminals without
  remounting them.
- The voice handler becomes data-driven:
  - `isVoiceHotkey` checks the configured modifiers exactly (today it hardcodes
    `ctrl && shift && !meta && !alt`);
  - `isVoiceHotkeyChordKey` covers the configured modifiers' left and right codes plus the
    configured key.

  Its toggle and swallow behavior is otherwise unchanged.

### Storage

- **Per browser, in `localStorage`** (operator decision 8).
- A browser with nothing stored uses the defaults.
- Every read and write is wrapped in try/catch, so a private window or blocked storage
  simply runs on the defaults.
- A stored value is parsed through the same validation as Record, and anything invalid or
  unknown falls back to the default.
- Nothing about hotkeys goes to the server. `uiSettingsStore.js` and `/api/ui-settings` are
  unchanged.
- This is a per-viewer convenience, which CLAUDE.md allows browser storage for. The
  Settings tab says the mapping applies to this browser only.

## Constraints

- `Vitest` runs in node with no DOM. Split the work into a pure half and a DOM half.
  - **Pure modules, unit-tested:**
    - list building, including the Host Shell rule;
    - parsing a stored mapping, invalid values falling back to the defaults;
    - MRU merge and pinning;
    - the initial highlight;
    - step, wrap and auto-repeat;
    - the chord reducer: open, step, commit on release, cancel on Esc or blur;
    - combo matching, validation and normalization;
    - the escape stripper and blank-row trim.
  - **DOM half, covered by Playwright e2e:**
    - the chord opens, steps, releases and lands on the right pane;
    - a quick tap flips to the previous session;
    - Esc cancels;
    - the preview appears after resting, with no capture fetched while tapping;
    - no chord key reaches the PTY;
    - a replaced pane's PTY is closed;
    - a remapped combo works;
    - Record's Esc doesn't close Settings.
  - **Manual check during live validation:** the defaults on Windows Chrome and Edge.
- **Server tests:**
  - the pane route's `session`: valid, invalid (400), absent (configured session), from a
    device token (403), and `cols`/`rows` ignored with `session`;
  - the Host Shell capture route: works for a browser session, refused for a device token,
    and absent from `DEVICE_ALLOWED_ROUTES`;
  - single-flight capture.
- Every web fetch goes through `http.ts` (`test/webHttp.test.js`).
- **Living docs to update:**
  - `docs/terminal.md`: a switcher and hotkeys section;
  - `README.md`: a one-line feature mention;
  - `CLAUDE.md` + `AGENTS.md`: the new modules, the pane route's browser-only `session`
    parameter, and the Host Shell capture route.

## Left to the builder

- Module split and names.
- Exact timings and line counts within the ranges above.
- The overlay's dimensions.
- The Host Shell capture route's exact path.
- How `dom.ts` exposes its "modal open" predicate.
