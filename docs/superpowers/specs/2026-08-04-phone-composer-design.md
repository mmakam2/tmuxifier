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

1. **Placement — toggle swap, opened from the top bar.** A ✏️ button in the phone top
   bar (beside the pane switch, which has slack) opens composer mode: the scrolling cap
   strip hides; a native textarea + ➤ Send button take its row; the pinned zone shows
   [➤][✏️][🎤] (the ⏎ cap hides — Send-on-empty covers it, and the field needs the width
   on a 344px cover screen). The ✏️ in the *key bar* exists only while composing and is
   the closer. No extra row is ever spent; the idle key bar is byte-identical to today —
   which is the point: a pinned ✏️ cap needs ~45px and the 344px bar has ~10px of slack
   (trimming recovers ~22px at best), and the round-2 no-scroll invariant is load-bearing
   because caps fire on pointerdown. (Amended from the originally approved
   pinned-✏️-cap placement for exactly that arithmetic; operator approved the top-bar
   opener.) Caveat, accepted: `kb-open` hides the top bar, so reaching the opener
   mid-direct-typing means dismissing the soft keyboard first — the natural
   start-of-compose state anyway.

   **Amended again during on-device validation (2026-08-04):** the operator found the
   top-of-screen reach wrong for the feature's most frequent action, and the kb-open
   caveat bit immediately. The ✏️ moved into the key bar's pinned zone by **dropping the
   `ctrl` cap** — the alternative originally declined — whose letter-masking is
   structurally broken under the operator's composing IME anyway (the reason the ^C cap
   exists). One ✏️ now toggles open/close from one place, reachable with the keyboard up;
   the top-bar `#phone-compose` button was removed. `createStickyCtrl`, the
   `transformInput` seam and `seqFor`'s guard remain, so restoring `ctrl` is one catalog
   line (the arrows pattern).
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
- Focus: the top-bar opener is an ordinary click button — open ends with explicit
  `field.focus()`, so the soft keyboard retargets to the field either way; close
  refocuses the terminal. The in-bar ✏️ closer and ➤ keep the bar convention
  (`pointerdown` + `preventDefault`, with the `detail === 0` click path for
  keyboard/AT activation, per the round-2 fix).
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
- The top-bar opener is display-gated on `(pointer: coarse)` like the key bar itself: a
  narrow desktop window shows the phone top bar but has no key bar, and an opener there
  would toggle an invisible composer.
- A stale cached bundle renders no ✏️ anywhere (additive, no migration).
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
