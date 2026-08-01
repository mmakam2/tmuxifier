# Sidebar agent-state badge — design

Date: 2026-08-01
Status: approved in session

## What

Show the hook-sourced agent state (working/waiting) as a badge next to the box label in the
sidebar box rows — the third surface after the pane header chip and the standby dashboard's
fleet strip. A box with no agent state (no marker: un-hooked box, no claude running, or
non-configured session) shows nothing, consistent with the hook-only rule from
`2026-08-01-hook-only-agent-state-design.md`.

## How

- **Pure helper** `agentBadgeFor(samples)` in `src/web/statusDot.ts` (the sidebar's
  classification module): reads the newest sample; returns
  `{ text: 'working', cls: 'badge-agent-working' }`,
  `{ text: 'waiting', cls: 'badge-agent-waiting' }`, or `null` when the series is empty or
  the latest sample carries no `agent`. Unit-tested; the DOM layer is not (vitest runs with
  no DOM by design).
- **Row render**: `createBoxRow` (`src/web/main.ts`) appends the badge into the existing
  `.box-badges` slot, after the setup badge when both exist — rendered as part of every row
  build from `latestSeries`, for the same reason the setup badge is (a rebuild must never
  wipe a post-hoc patch).
- **Repaint pass**: `repaintAgentBadges()`, the `repaintSparklines()` twin, updates the badge
  in place from the same two call sites (initial paint and `pollHealth`), because health data
  arrives on its own cadence between row rebuilds. The badge element carries a
  `data-agent-badge` marker so the pass can find and replace it without touching the setup
  badge beside it.
- **Styles**: two classes extending the `.badge` base (10px uppercase legend type):
  `badge-agent-working` on the `badge-info` amber recipe, `badge-agent-waiting` on the
  `badge-warn` orange recipe — matching the pane chip's colors and DESIGN.md's LED rule
  (amber = working agent, orange = operator action needed).

## Not doing

No server changes, no new fetches (rides `latestSeries` that sparklines already poll), no
notification changes, no glyph variant (words, the paneLifecycle precedent), no badge on the
standby dashboard's box cards (its fleet strip already carries the agent chip).
