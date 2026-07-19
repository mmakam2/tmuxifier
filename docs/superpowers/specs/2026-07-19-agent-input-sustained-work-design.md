# Agent-Input Sustained-Work Filter (Option B) — Design

**Date:** 2026-07-19
**Status:** Approved in principle; implementation deferred (user pivoted). Resume with
subagent-driven-development or a direct TDD pass.
**Follows:** `2026-07-19-agent-notifications-design.md` (the shipped feature, v1.9.0–v1.9.1).

## Problem

The shipped `agent-input` event fires on any `working → waiting` edge for the box's
configured claude session (idle ≥ `agentIdleSec`, detached). This false-fires when claude was
only *briefly* active before going idle — e.g. a fresh launch's welcome-banner repaint, a
slash command, or a quick <30s query. Observed in the field: `mcmcreativedev01` pinged after
an 11-second interaction (`✻ Baked for 11s`) the user had walked away from, while
`mcmcreative01`'s real 60s+ tasks (`✻ Sautéed for 1m 7s`) are the ones worth a ping.

Option A (screen-marker confirmation via `capture-pane`) was **rejected after evidence**: a
"finished your task, awaiting reply" screen and a "quick poke then idle" screen are visually
identical — transcript above an empty `❯` prompt with the same auto-mode footer. No screen
marker distinguishes intent. See the captures in the session log.

## Discriminator

**Task duration**, proxied by how many consecutive polls claude was `working` before it went
`waiting`. A task worth walking away from streams output across multiple ~30s polls; a launch
blip or quick command is a single `working` sample. This needs no `capture-pane` — just a
per-box working-streak counter, the same shape as the existing `cpuStreak` in
`classifyTransitions` (`healthHistory.js`).

## Design

- Track `agentWorkingStreak` per box in the threshold-state object
  (`initThresholdState`/the `state` threaded through `classifyTransitions`): increment on each
  `working` sample, reset to 0 on any non-`working` agent state (`waiting`/`unknown`/absent).
- Gate the `agent-input` edge: fire only when `prev.agent === 'working' && next.agent ===
  'waiting' && !next.agentAttached && agentWorkingStreak >= agentWorkMinPolls`. The streak is
  read from the pre-update `state` (the run of `working` samples that preceded this `waiting`).
- `agent-done` is **unchanged** — a finished/exited agent is a real transition regardless of
  how long it worked.
- Threshold `agentWorkMinPolls` default **2** (task spanned ≳2 poll intervals ≈ ≳30–60s at the
  default `statusPollMs` 30000). Config knob `TMUXIFIER_AGENT_WORK_MIN_POLLS`, clamped e.g.
  1–20; `1` restores current behavior.

## Why this is safe (verified by reasoning against the mechanics)

- **Auto mode chaining tasks with no user pause:** continuous output keeps `session_activity`
  fresh → never idle → never reaches the `working→waiting` edge. Fires nothing mid-chain
  (already true today; B doesn't change it). The ping lands only when claude genuinely stops
  ≥45s — run finished or blocked on the user — which is desired.
- **Long silent tool call (no repaint ≥45s):** a pre-existing idle-heuristic limitation
  (raise `agentIdleSec`); B does not worsen it, and the sustained-work gate makes a mid-task
  misread *less* likely, not more.

## Accepted trade-off

A genuinely short task (<~1 poll of `working`) that then waits for the user is silenced. A
sub-30s task is not one you leave the room for, so this is the intended behavior, not a
regression.

## Testing (TDD, pure)

Extend `test/healthHistory.test.js` against `classifyTransitions`/`sampleOf`:
- A single `working` sample → `waiting`: **no** `agent-input` (streak 1 < 2).
- `working`×2+ → `waiting` (detached): `agent-input` fires.
- Streak resets across a non-working sample (e.g. `working`, `unknown`, `working`, `waiting`
  → streak 1 → no fire) — a clock gap must not accumulate a false streak.
- `agent-done` still fires irrespective of streak.
- Attach-suppression and the existing edges unchanged.
- Config clamp test for `agentWorkMinPolls`.

## Files

- `src/server/healthHistory.js` — `initThresholdState` (add `agentWorkingStreak`),
  `classifyTransitions` (maintain streak + gate the edge), `createHealthHistory`/`record`
  (thread `agentWorkMinPolls`).
- `src/server/config.js` — `agentWorkMinPolls` default 2 + env + clamp.
- `src/server/index.js` — pass `agentWorkMinPolls: config.agentWorkMinPolls`.
- Docs: `CLAUDE.md`/`AGENTS.md` healthHistory note, README + `.env.example` knob row.
