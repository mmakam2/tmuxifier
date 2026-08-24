# Duplicate panes: one box, several sessions on the stage

Date: 2026-08-24. Status: approved design, pre-implementation.

## Summary

Dragging a box that is already docked creates a **second pane of the same box**. The new pane
**adopts the next live session** on the box that no other pane is already showing; only when
every adoptable session is taken does it create a freshly named one. Each pane owns its
session choice: the header dropdown
becomes pane-local, switching only the pane it sits on. The box's stored `sessionName` remains
the default for fresh docks and the target of setup/agent-hook machinery, and is changed only
from the Edit Box modal.

This is Phase 1 of the two-phase exploration recorded in this design's brainstorm: duplicate
panes show different **sessions** of one box. Showing two **windows of one session** is
structurally impossible without tmux grouped-session clones (the current window is session
state), and that Phase 2 is explicitly out of scope.

## Decisions made during brainstorming

1. **Phase 1 only** — per-pane session choice, no grouped-session clones.
2. **Adopt-then-create on drop** — duplicating a docked box first adopts an existing,
   not-yet-shown session; it auto-derives a new session name (`<configured>-2`, `-3`, …) only
   when no session is available to adopt. Never mirrors, never refuses the drop.
3. **Pane-local dropdown everywhere** — including the first pane. The old behavior (PATCH
   `sessionName`, force-reattach every viewer in every browser) no longer has a header path;
   the Edit modal keeps it.
4. **Move gesture relocates to the pane header** — the header's identity area becomes a drag
   source carrying the instance id. Sidebar drag = spawn, header drag = rearrange.

## Model changes (`src/web/stageLayout.ts`)

- A leaf is no longer a bare box-id string. v3 leaf: `{ box: string, pane: number, session?: string }`.
  - `pane` is a small per-box ordinal, unique among that box's docked+parked instances.
  - `session` is the pane's attached-session override; absent means "the box's configured
    session at attach time".
  - The **instance id** is `${box}#${pane}` — the string every id-keyed structure uses:
    `focusedId`, drop specs, ARIA labels, spatial focus, and the four `main.ts` maps
    (`tabs`, `connStates`, `paneHeaders`, `paneLifecycles`).
- Serialization bumps to `v: 3`. `restore()` migrates v2 (string leaf → `{ box, pane: 1 }`)
  and v1 as today, prunes leaves whose box has vanished, and sanitizes: `pane` a positive
  integer, `session` matching `SESSION_NAME_RE` or dropped.
- Tree operations (`movePane`, `undockPane`, `replacePane`, `setRatio`, `toggleOrientation`,
  `phonePaneOf`) address leaves by instance id. Their algorithms are unchanged — uniqueness of
  the leaf key is restored by construction, which is exactly the invariant the current
  string-leaf model silently depends on.
- `MAX_PANES` (4) stays a `main.ts` gesture-layer rule.

> **Implementation refinement (2026-08-24, plan):** the leaf is normalized to an instance-id
> *string* `${box}#${pane}` with session overrides in a v3 `sessions` record keyed by instance
> id — the same persisted information as the object leaf sketched above, chosen so every tree
> algorithm (and its test file) keeps operating on string leaves.

## Gesture changes (`src/web/main.ts`, `src/web/stagePanes.ts`)

- **Sidebar drag / ⊞ dock button, box not docked**: unchanged — docks instance
  `{ box, pane: 1 }`, no session override.
- **Sidebar drag / ⊞ dock button, box already docked**: creates a new instance with the next
  free `pane` ordinal and a `session` chosen by the adopt-then-create rule (below), docked at
  the drop target.
  The ⊞ button is visible whenever `panesOf().length < MAX_PANES` (today it hides once the box
  is docked), so duplication is not drag-only.
- **Pane header drag (new)**: the header's identity area sets `draggable` and a
  `text/x-tmuxifier-pane` payload carrying the instance id; drops reuse the existing
  `dropTargets`/`movePane` machinery as an atomic move. Desktop-only by construction (phone
  mode renders a single pane, no stage drops). The drag region must exclude the header's
  buttons and the session dropdown trigger.
- **Sidebar plain click**: focuses the box's first docked instance if one exists; otherwise
  today's replace-focused-pane behavior, producing instance `{ box, pane: 1 }`.
- **Replace drop target**: replacing a pane with an already-docked box spawns a new instance
  (with derived session) in that slot, same rule as edge drops.
- **Host Shell (`__local__`) is excluded from duplication**: its session name is server-fixed
  (`localSession`), so its sidebar drag keeps pure move semantics and the ⊞ rule above does not
  apply to it.

## Session choice on duplicate: adopt, then create (pure helper, unit-tested)

`chooseDuplicateSession(configured, liveSessions, shown)`:

- **Adopt first.** Candidates are the box's live sessions, in snapshot order (the probe's
  `tmux ls` order, so the choice is deterministic), excluding:
  - sessions already attached by any docked or parked instance of this box (`shown` —
    including the configured session pane 1 sits on);
  - sessions whose names fail `SESSION_NAME_RE` (the `isSwitchableSession` rule — `/term`'s
    strict validation would reject the attach, so an unswitchable name must not be adopted).
  The first survivor is adopted as the new pane's `session`.
- **Create only when dry.** With no adoptable survivor, derive `<configured>-2`,
  `<configured>-3`, … — first name in neither `liveSessions` nor `shown` (the union guards
  two quick drops against a stale snapshot). The base is truncated so the full candidate
  satisfies `SESSION_NAME_RE` (≤ 64 chars); the charset is already closed under this scheme.
- **Freshness.** The session list comes through `freshProbe`'s existing policy (single-flight
  re-probe with a short freshness window and an abandonable wait), falling back to the cached
  status snapshot — the same treatment the header dropdown already gets, because adoption
  reads remote state that the 30s cache may misrepresent.
- **No create API call.** The leaf stores the chosen name (adopted or derived); the pane's
  `/term` attach resolves it lazily via the existing `new-session -A` — attaching the session
  if it lives, creating it (with `startupCommand`, identically to the explicit create route)
  if not. This makes setup-gating free: a drop during a running setup job docks the pane,
  shows the setting-up panel, and the attach happens once permitted. Accepted residuals, both
  stale-snapshot shaped and bounded by the `freshProbe` pass: a derived name that already
  exists gets attached rather than created, and an adopted session that died since the
  snapshot gets recreated empty — each rare, benign, and self-evident in the pane.

## Server changes (`src/server/server.js`, `src/server/sessions.js`)

- `/term` accepts an optional `session` query parameter for normal box terminals:
  validated against `SESSION_NAME_RE` and **rejected** on mismatch (close `1008`, the create
  route's posture — never sanitized/rewritten), defaulting to the box's stored `sessionName`
  when absent. Setup-job gating, auth, and `mode=provision` are untouched.
- No PTY-keying change. The client suffixes its client id per pane (`<clientId>-p<pane>`,
  closed under the `CLIENT_ID` charset), so each instance is an ordinary viewer under the
  per-viewer architecture: its own ssh + tmux client, counted against `maxViewersPerBox` (8),
  grace-window reconnects and group closes unchanged (`entry.group` is still the box id, so
  Edit-modal changes and box removal still reach every instance).

## Pane header changes (`src/web/paneHeader.ts`, `src/web/sessionPicker.ts`, `main.ts`)

- `paneHeaderModel` gains the pane's attached session. It drives:
  - the dropdown's **selected row** (the attached session's active window, not the configured
    session's);
  - the **Reconnect cap's kill target** (kills the pane's attached session, then reattaches);
  - the **agent chip**, which renders only when the pane's attached session equals the box's
    configured session — agent state is hook-only and keyed to the configured session, so on
    any other session the chip would describe something the pane isn't showing.
- **Dropdown semantics, all panes**: a session row reattaches *this pane* to that session —
  no PATCH, no group close, other panes and other browsers untouched. A window row in the
  pane's attached session stays the cheap case (`select-window` only). A window row in a
  *different* session runs window-first then reattaches this pane (`select-window` on the
  target, then reopen `/term` with `session=<name>`), preserving today's land-on-the-chosen-
  window ordering without the PATCH.
- The unswitchable-name rule (`isSwitchableSession`) survives unchanged: a pane-local switch
  no longer PATCHes, but the reattach still puts the name through `/term`'s strict validation,
  so names outside `SESSION_NAME_RE` stay disabled rows rather than being silently rewritten.
- `sessionPicker.ts` needs no structural change; per-row kill, arming, and the armed-row
  invariant are session-name-addressed and pane-agnostic.

## Behavioral notes and accepted limitations

- **Two panes on the same session remain a mirror**: same window (session state), sizing
  fights under `window-size latest` (last-touched pane wins). Inherent tmux; not fought.
  This state is reachable by pointing both dropdowns at one session, and is identical to
  opening the box in two browser tabs today.
- **Header session switches no longer follow across browsers** — the price of decision 3.
  The configured session, changed in the Edit modal, still force-reattaches every viewer.
- **Restore resurrects sessions**: a persisted pane whose session was later killed is
  recreated empty by `-A` on layout restore — the same observable outcome the Reconnect cap
  already produces.
- **Undocked duplicates keep their connection**: parking is per instance, as today per box;
  a parked duplicate still holds a viewer slot until the grace/park lifecycle releases it.
- `healthHistory`'s attach-suppression of `agent-input`/`agent-done` events asks the group
  (`hasLiveSessionForBox`), so duplicates change nothing there.
- Proxmox lifecycle keys render per pane; both instances of a linked box show and drive the
  same guest's jobs — arming state is per instance, job state per box, which is already the
  cross-browser story today.

## Out of scope (recorded so they are deliberate)

- Grouped-session clones (two windows of one session, Phase 2).
- Per-pane sessions for the Host Shell.
- Creating duplicates from phone mode (restored layouts containing duplicates render fine
  through `phonePaneOf`).
- Any change to `boxes.json`'s schema or the setup `ensureSession` phase.

## Testing

- **Unit** (`test/stageLayout.test.js` + new): v3 serialize/restore, v2→v3 and v1→v3
  migration, vanished-box pruning of object leaves, instance-id addressing through the tree
  ops, `chooseDuplicateSession` (adopt-first in snapshot order, shown/unswitchable exclusion,
  create-when-dry with first-free suffix, taken-set union, 64-char truncation), `phonePaneOf`
  over object leaves.
- **Unit** (`test/paneHeader.test.js`): model with attached-session override — selected row,
  agent-chip gating, Reconnect target; the `SESSION_NAME_RE` mirror stays locked.
- **Server** (`test/server.ws.integration.test.js` + route tests): `/term` `session` param —
  valid override attaches the named session, invalid closes `1008`, absent falls back to the
  stored name; per-pane client-id suffix produces distinct viewers in one tab.
- **E2E** (`test/e2e/`): against the isolated `localBox` — with a spare live session present,
  a duplicate drop adopts it (no new session appears on the box); with only the configured
  session live, a duplicate drop lands a second pane attached to `<name>-2` while the first
  pane's session is untouched; header drag moves a pane; dropdown session switch reattaches
  only its own pane.
