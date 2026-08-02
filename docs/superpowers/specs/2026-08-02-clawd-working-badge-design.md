# Clawd working-badge animation — design

Date: 2026-08-02
Status: approved (brainstormed in-session)

## What

Replace the static amber `working` agent chip with the same chip plus a tiny animated
"Clawd" sprite — the Claude Code mascot rendered from Unicode block glyphs — bouncing
beside the WORKING text. The `waiting` chip is deliberately unchanged: Clawd's presence
alone means "agent busy", and a plain orange `waiting` chip keeps its "your turn" read.

Surfaces:

- Sidebar box-row agent badge (`badge-agent-working`, built by `applyAgentBadge` in
  `main.ts` from `agentBadgeFor` in `statusDot.ts`).
- Pane-header agent chip (`chip-agent-working`, built by `buildPaneHeader` in
  `paneHeader.ts` from `chipFor`).
- The standby dashboard's fleet-strip agent chips reuse the badge class, so they inherit
  the sprite with no dashboard change.

## Sprite

New module `src/web/clawd.ts`:

- Exported frame constants (pure strings, testable): body row `▐▛███▜▌`, feet row
  `▘▘ ▝▝` — a simplified two-row take on the Claude Code splash art. The bundled
  MesloLGMDZ Nerd Font carries these block elements, so the sprite stays inside the
  one-face mono discipline (DESIGN.md).
- `buildClawd()` DOM builder returning
  `<span class="clawd" aria-hidden="true"><span class="clawd-body">…</span><span class="clawd-feet">…</span></span>`.
  `aria-hidden` because the adjacent "working" text already carries the meaning for
  assistive tech.
- The sprite is colored `currentColor` only, so it inherits the chip's amber. No new
  hue enters the chrome; amber keeps meaning "working" (DESIGN.md: LED colors are never
  decorative, and this one is semantic).

## Animation

Pure CSS — no JS timers, so a fleet of N working boxes costs nothing extra and the
in-place badge repaint (`repaintAgentBadges`) never has to manage timer lifecycles.

- One `@keyframes clawd-hop`, ~1.2s loop, `steps(2)` cadence:
  - Frame A (rest): body at `translateY(0)`, feet visible.
  - Frame B (hop): body at `translateY(-1px)`, feet `opacity: 0` (tucked).
- Body transform and feet opacity animate with the same duration and timing so the two
  layers stay in sync.
- `@media (prefers-reduced-motion: reduce)`: animation removed entirely; the sprite
  rests on frame A (body down, feet out) — the meaningful resting state DESIGN.md
  requires.

## Wiring

- `statusDot.ts` — `agentBadgeFor` gains `sprite?: boolean`, set `true` only for the
  `working` state. `AgentBadge` type extended accordingly.
- `main.ts` — `applyAgentBadge` renders sprite + text when `b.sprite` is set, plain
  `textContent` otherwise. The in-place update path today only rewrites `textContent`
  and `className`; it must rebuild the badge's children when the class changes so a
  working→waiting flip drops the sprite and the reverse adds it.
- `paneHeader.ts` — `chipFor` gains the same `sprite` flag for `chip-agent-working`;
  `buildPaneHeader`'s `update()` renders sprite + text the same way, preserving the
  existing in-place update discipline (the voice button and lifecycle slot must
  survive, as today).
- `style.css` — `.clawd` sizing (font-size ≈ 6px, line-height ≈ 0.9, inline-block, two
  stacked rows) chosen to fit the current chip height without growing it; the keyframes;
  the reduced-motion override.

## Testing

- Pure parts only, per convention (vitest runs `environment: 'node'`, no DOM — DOM
  builders are untested by design):
  - `agentBadgeFor` returns `sprite: true` for working, no sprite for waiting/absent.
  - `chipFor` likewise.
  - Frame constants exported and asserted non-empty/expected.
- Browser verification on the live app before ship, per the standing
  validate-on-live workflow: sprite renders (not tofu), hops, holds still under
  reduced motion, waiting chip unchanged, dashboard fleet strip inherits.

## Rejected approaches

- CSS discrete `content` animation on a single span — patchy browser support.
- JS interval frame swap — per-badge timers across the fleet plus poll-repaint
  lifecycle interplay, all to avoid two spans of markup.
