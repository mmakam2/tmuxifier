# Mobile phone mode — design

Date: 2026-08-02
Status: approved (brainstorm session)

## Problem

Tmuxifier's shell layout is a fixed `320px 1fr` grid with no phone breakpoint: on a ~390px
viewport the sidebar consumes the screen, the multi-pane stage is unusable, and xterm.js offers
no touch path for the keys terminal work needs (Esc, Tab, arrows, Ctrl). `height: 100vh` on
`.layout` hides the bottom strip under mobile browser chrome (the iOS Safari `vh` problem).
Meanwhile the two things the operator actually wants from a phone — monitoring fleet/agent
state and driving Claude Code sessions in terminals — are exactly the flows that break.

Constraint from the user: the desktop experience must not change. Everything here is gated
behind a phone breakpoint; the desktop CSS/JS paths stay byte-identical in behavior.

## Goals

1. A usable phone shell: drawer sidebar, slim top bar, one full-screen pane.
2. Touch-first terminal input good enough to drive Claude Code: a touch key bar
   (Esc/Tab/Shift+Tab/arrows/sticky Ctrl/Enter/mic), soft-keyboard-safe layout.
3. Monitoring polish: touch-target sizing on the dashboard and box rows.
4. Zero desktop impact.

## Non-goals (deferred, in rough priority order)

- Web Push background notifications + PWA manifest/service worker (its own project; iOS
  requires an installed PWA and the server side needs the Web Push protocol + a subscription
  store).
- Multi-pane stage on tablets.
- Gesture-based pane switching (swipe), pinch zoom.

## Design

### Mode detection

One `matchMedia('(max-width: 720px)')` flag — `phoneMode` — matching the breakpoint the
fleet panel, settings modal, and PVE hub already use. All new CSS lives under that query.
The touch key bar is additionally gated on `(pointer: coarse)` so a narrow desktop window
reflows but never grows a key bar. The flag is live: a `change` listener re-renders the
stage on resize/rotation.

### Phone shell

- **Top bar** (phone only, hidden on desktop): ☰ drawer button, focused box name with its
  status dot, and the agent chip. Tapping the box name opens a dropdown of currently docked
  panes for switching.
- **Drawer**: the existing sidebar DOM node restyled by the media query into a left slide-over
  — the `.fleet-panel` pattern exactly (`position: fixed`, `translateX`, `visibility` swap so
  closed contents leave the tab order). No duplicated sidebar markup. Tapping a box row opens
  its pane and closes the drawer.
- `.layout` height moves from `100vh` to `100dvh` (applies on desktop too; `dvh` equals `vh`
  where there is no dynamic chrome, and fixes the hidden bottom strip where there is).

### Stage on phone

The stage renders only the focused pane, full-screen. Every other docked pane's terminal is
moved to the existing parking div (`.stage-parking`), where terminals stay connected — the
same mechanism that already keeps undocked terminals alive — so switching panes causes no
WebSocket churn. The split-tree layout in `tmuxifier.stageLayout` is not modified by phone
mode: returning to desktop restores the arrangement. Divider drag, drop zones, and dock
targets are inert/hidden on phone. Pane switching is the top-bar dropdown or the drawer.

### Terminal input

- **Touch key bar**, rendered between the terminal and the soft keyboard:
  `Esc · Tab · ⇧Tab · ↑ · ↓ · ← · → · Ctrl · Enter · mic`. Keys send their escape sequences
  through the terminal's existing WebSocket input path (the same function xterm's `onData`
  uses). `Ctrl` is a sticky modifier: it arms visually, and the next key — from the bar or the
  soft keyboard — is sent as `char & 0x1f`, then disarms. The mic key mounts the existing
  voice controller (hold-to-talk), giving voice dictation a thumb-reachable home; the pane
  header's `voiceMount` seam stays as-is on desktop.
- **Soft-keyboard geometry**: a `visualViewport` `resize`/`scroll` listener sets the stage
  container height to the visual viewport and refits the terminal, so the prompt line is
  never hidden behind the keyboard. This is the known-fiddly part, especially on iOS Safari,
  and gets explicit e2e attention.
- **Legibility**: terminal font size steps up on phone (target ~14px effective); FitAddon
  recomputes cols/rows.

### Monitoring polish

Touch targets on drawer box rows and dashboard tiles reach ≥40px. The dashboard tile grid
collapses to one column below 720px (largely already true via existing rules). Sparkline
tap targets grow. No structural changes.

## Testing

- Unit (vitest, no DOM by design): the key-bar sequence builder (key → bytes, sticky-Ctrl
  transform) and the phone-mode pane-selection helper (focused pane vs parked set) are pure
  functions with direct tests.
- e2e (playwright): a phone-viewport project (iPhone dimensions, touch enabled) covering:
  drawer opens/closes and traps focus correctly; exactly one pane renders full-screen and
  switching panes keeps both terminals connected; key bar Esc/arrows reach the real pty
  (assert on pty-side effect, not DOM); visualViewport-driven refit leaves the last line
  visible. Browser-verify on a real phone before ship (per the standing
  browser-verify-rendered-features lesson).

## Risks

- **iOS visualViewport quirks**: keyboard height reporting is inconsistent across iOS
  versions; the refit listener must debounce and clamp. Mitigation: e2e + real-device check.
- **xterm.js soft-keyboard input**: mobile IMEs autocorrect/compose; xterm's hidden textarea
  handles composition events but behavior varies. The key bar covers the keys IMEs mangle
  most (Esc/Ctrl/arrows); anything worse is follow-up, not blocking.
- **Live flip**: rotating a tablet across 720px mid-session re-renders the stage; the parking
  mechanism must be idempotent both directions. Covered by the pane-selection helper tests.
