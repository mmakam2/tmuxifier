# Sidebar sparkline setting (issue #12)

Status: approved 2026-11-16 (short design, small change).

## Intent

Each sidebar box row draws a 64x16 CPU/memory/disk line graph under the name and
meta line. At that size it is not very useful and it costs vertical space the box
list could use. Make it optional and **off by default**, so the rows are compact
unless the operator asks for the graph.

## Goals

- A checkbox in **Settings → Appearance** (not Proxmox: the issue named that tab,
  but it manages PVE hosts; Appearance already holds the other display prefs and
  saves to the server). Off by default.
- Off: no graph in any sidebar row, no leftover gap, meta-line percentages unchanged.
- On: today's behavior, including click-to-cycle of the shared metric.
- The choice survives a reload and is the same in every browser.

## Non-goals

- The `/api/health/series` fetch and `latestSeries` stay as they are. The series also
  feeds the agent badges, attention strip, pane header chips, agent switcher and the
  dashboard, so only the sparkline *paint* is skipped.
- No change to the meta-line figures, the metric-cycle storage (`tmuxifier.sparkMetric`)
  or the dashboard.

## Anti-goals

- A hidden graph that still takes a row gap, or a focusable invisible button.
- A tint on a meta-line figure that nothing can change (see Decisions).
- A flash of the graph on load before the setting is read.

## Constraints

- `data/ui-settings.json` (`uiSettingsStore.js`) validates only slug strings in `KEYS`;
  a boolean needs a small, separate extension. Read per request; a corrupt file fails
  open (here: to off).
- Web client is split pure/DOM; vitest has no DOM, so logic worth testing goes in a
  pure half.
- Every web fetch goes through `http.ts`; the new PATCH uses the existing
  `api.patchUiSettings`.
- Phone mode (`phoneMode.ts`) renders the same rows; its `.spark` padding rule must
  not reintroduce a gap.

## Approaches

1. **Server-stored boolean in `ui-settings.json`, Appearance checkbox (chosen).**
   Cross-device, same mechanism as theme and working-agent animation. Costs a small
   store extension and a type change in `api.ts`.
2. **`localStorage`, like `sparkMetric`.** No server change, and phone and desktop
   could differ, but it must be set once per browser and does not follow the
   operator across devices. Rejected: every other Appearance pref is server-side.
3. **CSS-only hide (a class on the list).** Smallest diff, but the paint keeps
   running and the metric tint and button stay live. Rejected: leaves the
   click-to-cycle and highlight question unanswered.

## Decisions

- **Storage:** `sidebarSpark: boolean` in `ui-settings.json`. Normalized to `false`
  unless strictly `true` (so unset, `null`, corrupt and wrong-typed all read as off).
  `PATCH` accepts only a boolean (and `null`, which resets to off); anything else
  is rejected the same way an invalid slug is today. `UiSettings` in `api.ts` gains
  the field.
- **Where the flag lives on the client:** a small module holding the value with a
  change listener, so `settingsAppearance.ts` can set it without importing
  `main.ts`. `main.ts` subscribes and repaints.
- **Boot:** `loadUiSettings()` reads the flag before `renderDashboard()`, on every
  path into the workspace (it already runs on each), so the first paint is right.
- **Off, paint:** `applySparkline` empties the span and returns. The existing
  `.spark:empty { display: none }` collapses it, which also removes it from the
  tab order. Phone mode needs no extra rule because a `display: none` element
  ignores the padding.
- **Off, highlight:** the `spark-cpu|mem|disk` class is not applied to the list.
  The tint exists to name what the anonymous graph shows; with no graph and no way
  to cycle, a permanently lit CPU figure would be noise. The stored metric is left
  alone so turning the graph back on resumes where it was.
- **Toggle:** applies instantly (repaint sparklines, re-sync the tint class), then
  PATCHes. A failed save keeps the local apply and shows the same note the other
  Appearance prefs use.
- **Upgrade:** existing users lose the graph on upgrade. That is what the issue
  asks for ("fresh installs and existing users get the compact rows").

## Tests

- Store: default off, boolean round-trip, non-boolean rejected, corrupt file reads
  off, theme/clawd keys unaffected (extend the existing ui-settings tests).
- Any pure helper that decides "paint or not / which class" gets a unit test.
- Playwright: `test/e2e/health.spec.ts` currently expects the graph, so it must turn
  the setting on first. Add an off-state check: no `.spark-svg`, no `.spark` box
  taking height, percentages still in the meta line, no `spark-*` class on `#boxes`;
  and that the choice survives a reload.

## Docs

Add the knob to the guide that documents Appearance, and fix the sparkline mention
in `docs/fleet-and-health.md` ("each box row shows a small sparkline") to say it is
optional and off by default. Update `CLAUDE.md`/`AGENTS.md` (`uiSettingsStore.js`
entry, which says "validates slug shape only") in the same change.

## Left to the builder

- Name and placement of the client module; exact checkbox label and helper text.
- Whether `PATCH /api/ui-settings` needs a route-level change or the store's throw
  already maps to a 400 (check `test/uiSettingsRoutes.test.js`).
