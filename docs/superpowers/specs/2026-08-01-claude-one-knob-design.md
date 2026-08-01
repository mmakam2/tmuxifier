# One-knob Claude stack (checkbox consolidation) — design

Date: 2026-08-01
Status: approved in session

## Decision

The "Claude Code" tool checkbox becomes the single switch for the whole Claude stack: CLI
install (already idempotent — the installer skips when `claude` resolves or
`~/.local/bin/claude` exists), the statusline push, and the agent-state hooks push. The
separate "Push Claude Code statusline" checkbox is removed. The seed-AI-auth checkbox stays
separate — copying subscription credentials is a trust decision, not a setup step.

Unchecked means **touch nothing claude-related** (user's explicit choice of strict
consolidation over a hybrid): no install, no statusline, no hooks refresh — even on a box
that already has Claude. This deliberately reverts v1.24.10's always-on hooks push. The
v1.24.12 rule that a plain Edit → Save always starts a setup job stays (clamps and tmux
ensure still run); only the claude phases are now gated.

On a box with a pre-existing Claude install, ticking the box adds whatever is missing and
breaks nothing: the CLI step skips, the statusline merge writes only the `statusLine` key,
and the hooks merge removes-then-appends only `tmuxifier-agent-hook` entries. All three
behaviors already exist and are tested; this change is purely re-gating.

## Server (`setupManager.js`)

`completeDone` gates BOTH `pushStatusline` and `pushAgentHooks` on one predicate:

```js
const wantsClaudeStack = j.options.tools.includes('claude') || !!j.options.claudeStatusline;
```

The legacy `claudeStatusline` flag stays accepted (`normalizeOptions` keeps it) so a stale
browser bundle that still sends it keeps getting the statusline — and now also the hooks,
which is the consolidation applied to old clients rather than a compat hole. Phase names,
`job.statusline`/`job.agentHooks` recording, and never-promote semantics are unchanged.

## Client

- `setupOptions.ts`: the statusline checkbox and its hint are removed; `SetupOptionsValues`
  drops `claudeStatusline`; `setupStartPayload` stops sending it.
- `provisionTools.ts`: the tool label becomes "Claude Code (CLI + statusline + agent hooks)"
  so the checkbox says what it now does.
- `api.ts`: `SetupOptions.claudeStatusline` becomes optional-legacy (old persisted jobs still
  carry it in history views).

## Docs

`docs/boxes-and-setup.md`: the "Push Claude Code statusline" and "Agent-state hooks" sections
merge into one section under the tools checklist describing the consolidated checkbox, the
add-what's-missing guarantee, and the removal path; the "plain Edit → Save installs the hook"
claim is corrected to "tick Claude Code and save". `docs/fleet-and-health.md`: the
missing-chip remedy becomes "tick the Claude Code checkbox and save, then restart claude".
CLAUDE.md/AGENTS.md: `claudeStatusline.js` and `claudeAgentHooks.js` entries change from
opt-in-checkbox / always-on to "both gated by the Claude tool selection"; the `setupManager.js`
entry's phase description follows.

## Tests

`setupManager.test.js`: empty options run NEITHER push; `tools: ['claude']` runs both (order:
statusline → agent-hooks → ensureSession); legacy `claudeStatusline: true` alone still runs
both; failure recording unchanged. `setupOptions.test.js`: values/payload no longer carry
`claudeStatusline`. `provisionTools.test.js`: label assertion updated if it pins labels.
