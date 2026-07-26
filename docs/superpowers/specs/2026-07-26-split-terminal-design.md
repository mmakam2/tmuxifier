# Split terminals (stage panes) — design

Date: 2026-07-26
Status: approved (brainstorm with operator; approach and all decisions confirmed)

## Problem

The stage shows exactly one terminal at a time. Supervising two boxes — an agent running in
one while working in another, watching two agents at once, or referencing/copy-pasting
between two shells — requires switching back and forth. The operator wants to dock two box
terminals on screen simultaneously.

## Confirmed decisions

| Decision | Choice |
| --- | --- |
| Use cases | All three: watch agent + work, watch two agents, reference/copy between panes. Panes are symmetric equals — no primary/secondary. |
| Layout | Side-by-side **or** stacked, operator-toggleable, with a draggable divider. Ratio remembered. |
| Entry gesture | Drag a box row onto the stage (drop zones), with a keyboard-accessible dock button as fallback. |
| Plain click on box C during a split | C replaces the **focused** pane; the other pane is untouched. |
| Persistence | Split (panes, orientation, ratios, focus) survives reload via localStorage. |
| Pane count | Model designed for N panes; UI enforces a cap of 2 for now (`MAX_PANES` at the gesture layer only). |

## Approach (chosen: A)

A lightweight pane-layout model over the existing tab infrastructure. Key discovery
grounding the design: all open terminal tabs already stay mounted and connected
concurrently (`tabs` Map in `main.ts`; switching only toggles `display`), and each tab
exposes `refit()`. Docking is therefore a client-side layout/focus feature; the server's
per-box PTYs need no changes.

Rejected alternatives:

- **Docking library (dockview/golden-layout):** heavyweight dependency in a deliberately
  dependency-light client; foreign chrome to restyle; unknown accessibility; overkill for a
  two-pane UI.
- **tmux-native split:** the two sessions live on different boxes and tmux cannot span
  hosts; faking it would need box-to-box SSH trust that Tmuxifier deliberately does not
  hold (it borrows the operator's trust from the Tmuxifier host only). Rejected on product
  principles.

## Architecture

Three units; no server changes.

- **`src/web/stageLayout.ts` (new, pure).** The layout model and every transition. No DOM.
- **`src/web/stagePanes.ts` (new, DOM).** Renders a layout into the stage: grid template,
  pane wrappers, dividers, nameplates, drop-zone overlay. Takes callbacks; owns no state.
- **`src/web/main.ts` (modified).** Replaces the single `activeBoxId` stage model with the
  layout model, wires drag sources on box rows, delegates stage painting to `stagePanes`.
  The `tabs` Map, `terminal.ts`, and reconnect/backoff logic are unchanged.

## Layout model

```ts
type StageLayout = {
  orientation: 'row' | 'column';   // side-by-side | stacked
  panes: string[];                 // boxIds in visual order ('__local__' allowed)
  ratios: number[];                // parallel to panes, sums to 1, each >= 0.2
};
```

- N-capable by construction; nothing in the model knows about "two".
- Unifies today's three stage states: empty stage = `panes: []`; single terminal =
  `panes: [id]`; split = `panes: [a, b]`.
- Pure transitions: `dockPane(layout, boxId, edge)` (edge implies position and
  orientation), `undockPane`, `replacePane`, `swapPanes`, `setRatio` (clamped, min 20%
  per pane), `toggleOrientation`, `serialize`, `restore(persisted, knownBoxIds)` (drops
  vanished boxes, renormalizes ratios).

## Gestures

- **Drag-to-dock (primary).** Box rows are drag sources (HTML5 DnD). While dragging over
  the stage, a drop-zone overlay appears: left/right/top/bottom edge zones (the edge picks
  both position and orientation) plus, when a split exists, a center zone per pane meaning
  "replace this pane". Dragging an already-docked box onto the other pane swaps them.
  Escape cancels (native DnD). Zones use the design system's cyan wash ladder (0.05
  resting, 0.12 hovered).
- **Dock button (keyboard fallback).** A ◫ icon joins the box row's action cluster
  (↻ ✎ ✕), `aria-label="Dock beside current terminal"`, visible only when the stage shows
  a different terminal and the pane cap allows docking. Docks on the current orientation's
  trailing edge. Keeps the feature keyboard-operable (v1.14.2 accessibility bar).
- **Divider.** Draggable via pointer events; terminal refits throttled to animation frames
  during drag; minimum 20% per pane; double-click resets 50/50. Follows the WAI-ARIA
  window-splitter pattern: `role="separator"`, focusable, arrow keys resize in 5% steps,
  `aria-valuenow` = percentage. A small rotate control on the divider (visible on
  hover/focus) toggles side-by-side ↔ stacked.
- **Undock.** A small ✕ in each pane's top-right (beside the voice button), visible on
  hover/focus. The surviving pane fills the stage. Undock ≠ close: the tab stays connected
  in the background exactly as hidden tabs do today.

## Focus and sidebar semantics

- `focusedBoxId` = the pane last touched (mousedown or xterm focus within it). Typing goes
  there naturally; a plain sidebar click on another box replaces that pane (tmux-like:
  "here" is where new things open).
- Focused pane border: `rgba(36, 211, 232, 0.45)` (the wash-ladder border step); unfocused
  panes keep the plain hairline border.
- Sidebar: every docked box shows the Inset Beacon; the focused one at full strength, the
  other at a reduced wash — both read "on stage", one reads "here".
- `Ctrl+Shift+ArrowLeft/Right` (Up/Down when stacked) moves focus between panes. Plain
  `Ctrl+Arrow` belongs to the shell (word-jump) and must reach the pane, so the chord is
  captured at the document level and swallowed whole, the same pattern as the voice hotkey
  (`Ctrl+Shift+Space` in `voiceUi.ts`).

## Pane chrome and content states

- One piece of chrome per pane: a **nameplate** — the box label in the HUD register
  (10.5px, 600, uppercase, tracked, Dimmed Readout), floating top-left, dimmed to ~40%
  opacity when the pane is unfocused. Chrome never outdresses the terminal.
- The stopped-box and setting-up panels become **pane content states**: the panel builders
  take a mount parameter and render inside the pane wrapper, so a docked box entering
  setup shows its live setup log in its pane while the other pane keeps running.
- The Host Shell (`__local__`) is dockable like any box.

## Persistence and edge cases

- The whole `StageLayout` plus `focusedBoxId` persists to localStorage (key alongside the
  existing sidebar-collapsed key). Boot restores after the box list loads; `restore()`
  silently drops boxes that no longer exist (0 panes left → empty-stage prompt, 1 →
  single view). If the focused box was pruned, focus falls to the first remaining pane.
- Box removed while docked → `undockPane` via the existing `closeTab` path; the remaining
  pane fills the stage.
- Both docked sessions are attached, so the server's agent-notification suppression
  applies to both — correct, the operator is watching them.
- Drawers (Fleet Jobs, Events, provision panel) overlay the stage unchanged.
- Narrow viewports: no special casing in this feature; the responsive layout work is a
  separate effort.

## Testing

TDD, house style (real code, no mocks):

1. `test/stageLayout.test.js` — model transitions first: dock/undock/replace/swap,
   edge-implied orientation, ratio clamping and renormalization, serialize → restore
   round-trips including vanished-box pruning.
2. DOM-level tests for `stagePanes.ts` — grid template strings, divider ARIA attributes —
   with the same minimal-stub approach as `test/domTabs.test.js`.
3. One Playwright e2e — dock two sshd-backed boxes, type in each, assert both stream, and
   resize via the divider.

## Out of scope

- More than two panes in the UI (the model supports N; no UI for it yet).
- Server-side changes of any kind.
- Narrow-viewport/responsive behavior of the split (separate adapt effort).
- Cross-pane broadcast typing (Fleet Command already owns run-on-many).
