# Phone keyboard & interface, round 2 — design

Date: 2026-08-03
Status: approved (brainstorm with operator; approach C of three presented)

## Context

Phone mode shipped in v1.24.21–23 (drawer shell, single-pane stage, touch key bar below
720px + coarse pointer). Real-device use since then surfaced three concrete frictions,
all confirmed in the brainstorm:

1. **Stray taps activate Claude Code's TUI.** Claude Code (and tmux with `mouse on`)
   enables mouse tracking, so xterm forwards a tap as a real SGR mouse click — a stray
   touch on an option list *selects and activates* it.
2. **⏎ is off-screen.** The Enter cap is the last item of the ~494px `.touch-caps`
   scroller, past the right edge of every real phone viewport (360/390/430). Submitting
   without the soft keyboard means a horizontal swipe nothing advertises.
3. **Too few terminal rows.** Top bar (☰ + pane switch) + key bar + soft keyboard leave
   little visible terminal.

## Decision and scope

Three small, independent changes (approach C). A chat-style composer (type in a native
field, tap Send) was presented as approaches A/B and **deliberately deferred** — the
operator chose the minimal round. If phone prompt-typing friction comes up again, the
composer is the recorded next step, with "Send on empty field = bare Enter" as its
keyboard-less submit.

Non-goals this round: composer, PWA/standalone, Web Push, swipe gestures, tablet
multi-pane, leaner one-row key bar, key auto-repeat.

## 1. Pinned ⏎

The bar keeps its two-zone structure — scrolling `.touch-caps` plus a pinned zone — but
⏎ moves out of the scroller into the pinned zone beside the mic:

```
[ esc  ^C  ⇥  ⇤  ↑  ↓  ←  →  ctrl   …scrolls… ] [ ⏎  🎤  pinned ]
```

- `TOUCH_KEYS` (touchKeys.ts) stays the single source of truth: the entry gains a
  `pinned: true` flag; `buildTouchKeyBar` routes flagged caps into the pinned container
  instead of the scroller. `seqFor` and sticky-Ctrl behavior are untouched (bar keys are
  still never ctrl-modified; a tap still disarms an armed modifier).
- The pinned zone renders `[⏎][mic slot]`; the existing `micSlot` contract with
  `openTerminal`'s `voiceMount` seam is unchanged.
- Side benefit: the scroller shrinks by one cap, so less swiping for the rest.

## 2. Long-press tap guard

**Scope condition:** active only while the app has mouse tracking enabled
(`term.modes.mouseTrackingMode !== 'none'`), read live per gesture — the same pattern as
the DECCKM-aware arrows. When tracking is off, touch behavior is byte-for-byte today's:
tap focuses, selection and defaults are untouched, zero drift for plain shell prompts.

**When tracking is on:**

- **Tap** (release before the hold threshold, movement within slop): `preventDefault()`
  so the browser never synthesizes the compatibility mouse events xterm would report as
  a click, then `term.focus()` is called explicitly — tap still focuses the terminal and
  opens the soft keyboard exactly as today. The TUI never sees the click.
- **Long-press** (~500ms held within slop): dispatches a synthetic `mousedown` at the
  touch cell when the timer fires and the matching `mouseup` on release, so xterm emits
  the real SGR press/release pair — deliberate touch activation survives.
- **Drag** (movement beyond slop): cancels the hold timer and remains the existing
  `wireTouchScroll` synthetic-wheel path, untouched.
- **Multi-touch:** a second concurrent touch cancels the gesture (treated as neither tap
  nor hold).

**Placement:** an extension of `wireTouchScroll` in `terminal.ts`, which already owns
these touch listeners — one owner for all touch-on-terminal behavior. The tap/hold/drag
discriminator is a pure state machine (event-descriptor in, verdict out) so it is
unit-testable without DOM, per project convention (vitest has no DOM).

**Constants:** hold threshold 500ms, slop matching the existing touch-scroll slop.
Timers are cleaned up on gesture end and on pane disposal.

## 3. Auto-hide top bar

The ☰ + `#phone-switch` bar hides **only while the soft keyboard is open** — exactly
when rows are scarcest — and returns automatically when it closes. No new gesture and no
tap-at-top-edge affordance: while typing you don't need ☰, and dismissing the keyboard
restores the bar.

- **Signal:** rides the existing `--vvh` height-change gate in `phoneMode.ts` (`onVv`),
  which the v1.24.22 caret-pan fix already guarantees fires real work only on genuine
  height changes. Keyboard-open predicate:
  `window.innerHeight − round(vv.height · vv.scale) > KB_THRESHOLD` (~150px). iOS never
  shrinks the layout viewport for the keyboard — the premise `--vvh` already stands
  on — and current Android Chrome's default keyboard mode likewise resizes only the
  visual viewport, so the delta isolates the keyboard; rotation re-evaluates naturally
  because both terms are read at event time.
- **Mechanism:** the predicate result toggles a class (e.g. `kb-open`) on `.layout`;
  CSS collapses the top bar and `.stage` gains its ~40px. The predicate itself is a pure
  function (unit-tested); the toggle is one classList call inside the existing debounce.
- **Cleanup:** flipping to desktop and `dispose()` both remove the class, exactly as
  they already remove `--vvh` (same lifetime, same reasons).

## Error handling / edge cases

- Tap guard: gesture state resets on `touchcancel`; a hold timer never outlives its pane
  (cleared on dispose alongside the pane's other listeners). Long-press with tracking
  off is left to the browser default, unchanged from today.
- Auto-hide: the class rides the same lifecycle as `--vvh`, so a keyboard-squeezed state
  can never survive logout/flip (the v1.24.21 lesson about `documentElement` outliving
  `#app` applies to `.layout` state the same way).
- Pinned ⏎: no behavioral change to sequences; a stale cached bundle without the flag
  simply renders the old layout (additive flag, no migration).

## Testing

- **Unit (vitest, no DOM):** the tap/hold/drag discriminator state machine (tap under
  threshold, hold at threshold, drag past slop, multi-touch cancel, touchcancel reset);
  the keyboard-open predicate (below/at/above threshold, zoom ≠ keyboard via the
  `· scale` term); `TOUCH_KEYS` pinned flag shape.
- **e2e (Playwright phone project):** ⏎ cap rect containment inside a 360px viewport
  (geometry, not `toBeVisible()` — the v1.24.21 lesson); tap guard asserted by pty
  effect — enable mouse tracking in the test pty, synthesize a touch tap (CDP touch
  events), assert no SGR report bytes arrive, then a long-press and assert they do;
  tap-keeps-focus asserted on xterm's textarea.
- **Known e2e gap, stated honestly:** `visualViewport` height changes cannot be
  synthesized in Playwright, so auto-hide's end-to-end behavior is covered by the pure
  predicate plus real-device validation before ship (per the standing
  validate-on-live-before-ship workflow). Same for soft-keyboard focus behavior on tap.

## Ship shape

Three independent changes; one branch/worktree, per-change commits, real-phone pass
before merge (the v1.24.21→23 cycle showed device-found bugs are the norm here, not the
exception).
