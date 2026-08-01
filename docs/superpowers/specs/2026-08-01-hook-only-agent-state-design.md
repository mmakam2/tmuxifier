# Hook-only agent state (heuristic removal) — design

Date: 2026-08-01
Status: approved (user directive after v1.24.10 shipped; option chosen in session)

## Decision

Remove all non-hook Claude statusing. The v1.24.10 design kept the output-idle heuristic as
the fallback for sessions without a marker; the first live report (a box showing `working`
while its claude sat idle, produced by the heuristic because that box's setup had not been
rerun) prompted the operator to drop the fallback entirely: **a Claude Code hook marker is the only
source of working/waiting**. A claude pane with no marker carries **no agent state at all**
(explicitly chosen over `unknown`): no chip, no agent-input events, until the box's setup is
rerun and its claude restarted.

## What is removed

- `sampleOf`'s idle-math branch (`activity` vs `boxNowSec` vs `agentIdleSec`) and the
  `'unknown'` state it produced. Samples carry `agent` only from a marker.
- The `agentSrc` tag — every statused sample is hook-sourced, so nothing needs distinguishing.
- `AGENT_WORK_MIN_SAMPLES` and the whole `agentWorkStreak` machinery in `classifyTransitions`
  — the anti-blip guard existed because pane *output* could fabricate a `working` sample;
  output can no longer produce agent state, so a working→waiting edge is always a real turn.
- The `agentIdleSec` config knob (`TMUXIFIER_AGENT_IDLE_SEC`): `config.js` default/env/clamp,
  `index.js` wiring, `.env.example`, `docs/configuration.md`.
- Client types narrow: `HealthSample.agent` is `'working' | 'waiting'`; paneHeader's
  `'unknown'` tolerance goes (it already rendered nothing).

## What is kept, and the one addition

Presence stays pane-based. The sample gains `agentPresent: true` whenever the configured
session's active pane runs claude — regardless of marker. It drives **nothing visible**; its
sole consumer is the agent-done edge, which now requires `!next.agentPresent`. Without it, a
hooked claude restarting in place (SessionEnd deletes the marker before the new claude's
SessionStart rewrites it) would read as "agent disappeared" for one poll and fire a false
agent-done. A stale marker for a SIGKILL'd claude stays inert for the same reason as before:
no claude pane, no `agent`, and now explicitly `!agentPresent`, so agent-done fires correctly.

Never-hooked claudes produce no agent-done on exit — accepted consequence of the operator's
"no agent state at all" choice.

## Consequences

Boxes that have not rerun setup since v1.24.10 (and claudes not restarted since the hook
landed) show no agent chip and emit no agent notifications. That silence is the deliberate
signal to rerun setup, not a defect.
