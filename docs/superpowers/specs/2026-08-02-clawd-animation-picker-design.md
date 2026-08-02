# Clawd animation picker — design

Date: 2026-08-02
Status: approved (brainstormed with visual companion; user selected variants and picker layout
from live animated mockups)

## Context

v1.24.17 shipped Clawd — the Claude Code mascot as a two-row Unicode block-element sprite —
hopping beside every working agent chip (sidebar badge, pane-header chip, dashboard fleet
chip), animated by a single pure-CSS `steps(2)` hop. The user finds the hop underwhelming and
wants a choice of animations, switchable from the UI, including the animated star spinner from
the Claude Code CLI.

## Decisions made during brainstorming

Candidates were shown live (big preview plus actual chip size) in the visual companion. The
user multi-selected the set to build and rejected the rest:

- **Selected:** CLI star, Wiggle, Pace, Big hop.
- **Rejected:** the current hop (dropped entirely — not kept as an option) and Breathe.
- **Default for a fresh browser:** CLI star.
- **Picker location:** a new **Appearance** tab in the settings modal (option A over embedding
  in the Notifications tab or a sidebar control).
- **Picker layout:** radio rows with a live animated preview per row (option A over a tile
  grid), matching the existing settings `makeRadio` idiom.

## Behavior

The working-agent indicator has five modes:

| id        | Label              | Motion                                                        |
|-----------|--------------------|---------------------------------------------------------------|
| `off`     | Off — static Clawd | Block-glyph Clawd, no animation                               |
| `star`    | CLI star           | Claude Code spinner: glyphs bloom `·` `✢` `✳` `✶` `✻` `✽` and back |
| `wiggle`  | Wiggle             | Whole Clawd leans left/right on a hard beat, pivoting at the feet |
| `pace`    | Pace               | Clawd shuffles side to side; feet alternate                   |
| `big-hop` | Big hop            | Cartoon squash-and-stretch jump with a landing                |

- Default is `star`. The old hop animation is removed.
- One global choice applies to all three render sites: sidebar badge, pane-header chip, and
  dashboard fleet chip. Waiting chips remain plain (stillness plus orange keeps meaning "your
  turn") — unchanged.
- The `star` variant replaces the two-row sprite with a single spinner glyph sized to the
  chip; the other variants keep the block-glyph Clawd. Everything stays `currentColor`, so the
  indicator inherits the chip's amber and introduces no new hue and no new font.
- A changed setting takes effect on the next status repaint (the poll loops rebuild these
  chips every few seconds) — no reload, no immediate-repaint plumbing.
- `prefers-reduced-motion: reduce` forces the static rest frame regardless of the selected
  mode, as the hop does today.

## Picker (Appearance tab)

- New `src/web/settingsAppearance.ts` section, registered in `settingsUi.ts`'s `SECTIONS`
  object **last** (after Notifications) — the `SECTIONS` key order builds the tab strip.
- Content: one "Working-agent animation" group of five radio rows (`makeRadio` idiom). Each
  row shows a live animated preview of its variant at near-chip scale plus a short
  description. Selecting a row persists immediately; no Save button.

## Persistence

- Per-browser, in `localStorage` under `tmuxifier.clawdAnim` — the `notifyPrefs.ts` pattern.
  This is a pure client-side display preference: no server API, no `data/` file.
- Reads go through a normalizer: any stored value that is not one of the five ids falls back
  to `star`. Storage access is injected for testability, as in `notifyPrefs.ts`.

## Architecture

- `clawd.ts` grows into the variant module:
  - `CLAWD_VARIANTS`: ordered catalog of `{ id, label, description }` driving both the picker
    rows and the build switch.
  - Pref read/write helpers with injected storage plus the fallback normalizer.
  - `buildClawd()` keeps its zero-argument signature (no call-site churn in `main.ts`,
    `paneHeader.ts`, `dashboard.ts`); it reads the pref and returns that variant's DOM.
    Sprite variants keep the existing body/feet two-row structure with a per-variant class;
    the star variant builds ten stacked glyph spans (`· ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢`).
- `style.css`: the `.clawd-*` hop keyframes are replaced by per-variant animations. The star
  cycle is pure CSS — each stacked span gets a staggered `animation-delay` over a 1s loop, so
  a fleet of working boxes still costs no timers. All variants rest on their static frame
  under `prefers-reduced-motion`.
- The picker previews reuse the same classes as the real chips, so a preview cannot drift
  from what ships.

## Testing

- Vitest runs in node (no DOM), so DOM builders stay untested by design; live browser
  verification before ship covers rendering, per the standing validate-on-live workflow.
- Unit tests cover the pure parts: the variant catalog shape (five entries, unique ids,
  `star` present), and pref normalization (round-trip, unknown value falls back to `star`,
  missing storage falls back to `star`).

## Out of scope

- Server-side persistence or per-box animation choices.
- A "no sprite at all" mode (Off keeps the static Clawd).
- Animating waiting chips.
- Further Appearance-tab knobs (e.g. surfacing `TMUXIFIER_TERM_FONT`) — the tab is created
  with this one group only.
