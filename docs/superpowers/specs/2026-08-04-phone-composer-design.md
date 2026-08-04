# Phone composer — design

Date: 2026-08-04
Status: approved (brainstorm with operator)

## Context

Phone keyboard round 2 (v1.24.24) established that IME suggestion-word mangling is
structural: the Samsung keyboard replace-edits committed words, a pty cannot un-send
bytes, and xterm has no `deleteContentBackward` handling. The round-2 spec recorded the
chat-style composer as the next step, with "Send on empty field = bare Enter" as its
keyboard-less submit. Continued real-device pain has promoted it to this round.

The composer moves phone typing into a real native text field: the IME can word-replace,
autocorrect, and cursor-edit freely, and the pty sees nothing until Send. Review happens
in the field; Send is the confirmation, so Send transmits the text **plus Enter** in one
tap — the deliberate inverse of the upload/voice injection paths, which never auto-Enter
because there the user has not authored the injected text.

## Decisions (brainstormed with operator, all four confirmed)

1. **Placement — toggle swap.** A ✏️ cap in the bar's pinned zone toggles composer mode.
   Open: the scrolling cap strip hides; a native textarea + ➤ Send button take its row;
   the pinned zone shows [➤][✏️][🎤] (the ⏎ cap hides — Send-on-empty covers it, and the
   field needs the width on a 344px cover screen). No extra row is ever spent; terminal
   typing is untouched while the composer is closed.
2. **Multi-line — collapse on Send.** Autogrowing textarea (~4 rows max). The keyboard's
   Enter inserts a newline while composing; on Send, newline runs collapse to single
   spaces — the `voiceText.js` rule, because a raw newline reaching the pty IS Enter and
   would submit mid-text. Backslash-mapping to Claude Code's multi-line sequence was
   considered and deferred (behavior would vary by pane app).
3. **After Send — stay open, clear.** The field clears and keeps keyboard focus (the
   chat loop). Send on an empty field transmits bare Enter, so confirming follow-up
   prompts needs no mode switch. ✏️ again closes and refocuses the terminal.
4. **Mic — dictates into the composer while open.** The transcript appends to the draft
   instead of typing into the pane; the operator fixes it with the native keyboard and
   taps Send. Normal-bar dictation is unchanged.

## Design

### `composer.ts` (new, mirrors touchKeys.ts: pure half + DOM half)

- Pure: `sendTextOf(draft)` — collapse newline runs (`\r\n`/`\n`/`\r`) to a single
  space, strip remaining C0 controls, trim. Unit-tested.
- Send transmits `sendTextOf(draft) + '\r'`; empty result → bare `'\r'`.
- DOM: the composer row builder (textarea + ➤), invoked by `buildTouchKeyBar` — one
  owner for the bar, as with the pinned zone. The field element persists
  display-toggled, so the draft survives open/close toggles and pane switches.

### Wiring (touchKeys.ts / main.ts)

- Send routes through the bar's existing `send()` → `term.input()` — downstream of
  `transformInput`, so like all bar keys it can never be sticky-Ctrl-masked. Opening
  the composer disarms an armed sticky Ctrl (the existing bar-tap rule).
- Focus: ✏️ open focuses the field (`pointerdown` + `preventDefault` + explicit
  `field.focus()` — the bar convention, but here the focus move is the point); close
  refocuses the terminal. The `detail === 0` click path covers keyboard/AT activation
  on ✏️ and ➤, per the round-2 fix.
- Autogrow via scrollHeight on input, capped ~4 rows (CSS `field-sizing: content` is
  not universal). A taller bar reflows `.layout` and must refit open terminals —
  verify during implementation; wire to the existing refit path if not automatic.
- Desktop needs nothing: the composer lives inside `#touch-keys`, already gated by the
  ≤720px + coarse-pointer media query. `kb-open` needs nothing: the predicate is
  field-agnostic viewport math.

### Voice route (`server.js`)

`POST /api/voice` gains an `inject=off` query flag: transcribe and return `{ text }`
without touching the pane (the route already returns the text; the flag only skips the
injection block). The voice control gains a transcript-sink seam; `main.ts` points it at
the composer's `appendToDraft` while the composer is open.

## Edge cases

- **Send never destroys a draft it couldn't deliver.** If the focused pane has no live
  terminal (setup/stopped panel), Send no-ops and the field keeps its text — the bar's
  send is already a silent no-op there; clearing on top of that would eat the prompt.
- Logout/teardown rebuilds `#app`; the draft dies with it (accepted — same lifetime as
  the rest of the bar).
- A stale cached bundle renders no ✏️ cap (additive, no migration).
- 344px budget (Z Fold cover screen): field flex-1 beside ➤/✏️/🎤; pinned by geometry
  e2e like the round-2 bar.

## Testing

- **Unit (vitest, no DOM):** `sendTextOf` (collapse, strip, trim, empty → ''); the
  Send-payload rule (text+`\r` vs bare `\r`); `inject=off` branch in
  `voiceRoutes.test.js` (skips injection, still returns text).
- **e2e (Playwright phone project):** open → type → Send → pty received one collapsed
  line + CR; empty Send → bare CR; draft survives toggle and pane switch; 344px
  geometry via rects (field, ➤, ✏️, 🎤 inside the viewport — not `toBeVisible()`);
  focus handoffs (✏️ → field focused, close → xterm textarea focused).

## Non-goals

Desktop composer, per-pane drafts, sent-message history, backslash multi-line mapping
(deferred, above), PWA/standalone, Web Push.
