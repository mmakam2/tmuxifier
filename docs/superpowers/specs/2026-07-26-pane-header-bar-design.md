# Pane header bar — design

Date: 2026-07-26
Status: approved

## Summary

Every stage pane — single or split, SSH box or local shell — gets a persistent 28px header
bar above its terminal: box identity on the left, live state and actions on the right. The
bar replaces the two pieces of floating chrome that exist today: the voice button that
floats over the xterm canvas's top-right corner, and the hover nameplate (+ undock ✕) that
only exists in split view. After this change nothing floats over the terminal canvas.

## Decisions (from brainstorming)

- Contents: box name, status dot + connection state, agent state (working/waiting),
  `user@host`, voice button, refresh, undock (split only). All four proposed info items
  were selected.
- Scope: the local shell pane gets the same bar (`local · this host` as its target text).
  One rendering path, no special case.
- Approach: the bar is pane chrome, rendered by the pane layer (`stagePanes.ts`), not by
  `terminal.ts` and not an overlay. Chosen over a terminal-owned bar (which would skip
  stopped/setting-up panes and need parallel local-shell wiring) and over a fading overlay
  HUD (which would cover the terminal's top row and contradict the persistent-info intent).

## Bar anatomy

A 28px bar styled as a black panel wash, laid out as a left identity cluster and a right
action cluster:

- **Left (identity):** status dot (same `statusDot.ts` classes as the sidebar row), box
  label in the HUD register style the split nameplate already uses (10.5px / 600 /
  uppercase / 0.09em), then the SSH target `user@host` in dimmed text. The local shell
  shows `local · this host`.
- **Right (state + actions):** agent chip, then voice button, refresh button, and — in
  split view only — the undock ✕.
- **One state slot:** while the pane's terminal is reconnecting, the agent chip's slot
  shows connection text instead (e.g. `reconnecting ×3`). Agent chip and connection text
  never render together; connection state wins because a disconnected pane has no live
  agent to report on.
- **Focus:** the focused pane's bar carries the Inset Beacon (3px inset cyan bar on its
  left edge, per DESIGN.md); unfocused bars render dimmer. Clicking anywhere in the pane —
  including the bar — focuses it (the existing capture-phase mousedown on the pane).

Removed by this change: the floating `.voice-btn` mount over the canvas, and the
`.pane-nameplate` / hover-revealed `.pane-undock` pair.

## Modules and data flow

- **`src/web/paneHeader.ts` (new)** — house pattern: a pure view-model builder plus a thin
  DOM layer.
  - Pure: `paneHeaderModel(input)` → `{ title, target, dotClass, chip }` where `chip` is
    `{ kind: 'agent' | 'conn', text, cls } | null`. Input carries the box (or local-shell
    marker), the latest status snapshot entry, the latest agent state, and the terminal
    connection state. Unit-tested directly.
  - DOM: `buildPaneHeader(model, actions)` → `{ el, update(model) }`. `actions` supplies
    the optional callbacks (`onRefresh`, `onUndock`) and a mount element for the voice
    button. `update` rewrites text/classes in place — it never rebuilds the element, so
    the voice button and its recording state survive status repaints.
- **`stagePanes.ts`** — `buildPane` renders the header (via a new `headerFor(id)` hook on
  `PaneHooks`) in place of the current split-only nameplate block. The undock button moves
  into the header's action cluster; `dropTargets`/divider logic is untouched.
- **`main.ts`** — implements `headerFor` from its existing data: the boxes list
  (label, user, host), the cached status snapshot, and the agent state (below). Keeps a
  `paneId → update` registry of mounted headers; `pollStatus` — whose payload now also
  carries agent state — calls `update` in place. `repaintStage()` rebuilds panes wholesale as today —
  the registry is rebuilt with it.
- **`terminal.ts`** — two seams:
  - `openTerminal` accepts a connection-state callback reporting
    `'connecting' | 'open' | 'retrying'` (+ attempt count) from its existing
    `reconnect.ts` wiring, so the bar can show reconnect state.
  - The voice button mounts into the bar's action cluster instead of the terminal's
    parent: `openTerminal` accepts a voice-mount element and passes it to `wireVoice`
    (whose `parent` parameter already makes this a one-line repoint). Behavior — hold to
    record, hotkey toggle, blur safety — is unchanged.

## Agent state source

`healthHistory.js` already derives a per-box agent state (`working` / `waiting` /
`unknown`) from each status probe; it is only consumed for edge-triggered notification
events today. Smallest exposure: add an accessor (e.g. `agentState(boxId)`) and include
`agent` per box in the `/api/status` snapshot payload. The client's existing status poll
then feeds the chip — no new endpoint, no additional polling, no change to event
semantics or attach-suppression (which applies to *events*; the bar shows current state
and is naturally visible only when attached).

## Pane content states

- **Terminal panes** (box or local): full bar.
- **Stopped / setting-up panes:** identity half only — dot, name, target, and the state as
  the chip text (`stopped`, `setting up`). No voice or refresh buttons: those panels
  already own their actions. Undock is the one exception — it still shows in split view,
  because a non-terminal pane must remain removable from the split.
- The bar is derived UI throughout; nothing new is persisted.

## Testing

- **Unit:** `paneHeader` model permutations (box vs local, statuses, agent states,
  reconnecting overriding the agent chip, stopped/setting-up chips); `stagePanes` tests
  updated from nameplate assertions to header assertions; server test that `/api/status`
  carries per-box `agent` state.
- **E2E:** split spec selectors move from `.pane-nameplate`/`.pane-undock` to the header;
  new assertions that the bar shows name + `user@host` and that undock-from-bar works.
  The voice spec keeps passing — the button keeps its class and behavior; only its mount
  moves.
- **Typecheck** via the usual `npm test`.

## Out of scope

- No server-side changes beyond the `/api/status` agent field.
- No new persistence or settings; the bar is not configurable or collapsible in v1.
- No change to notification semantics, the sidebar rows, or the health events panel.
- The pane cap stays `MAX_PANES = 2` (`main.ts`); the bar renders per-pane and is
  N-capable by construction.
