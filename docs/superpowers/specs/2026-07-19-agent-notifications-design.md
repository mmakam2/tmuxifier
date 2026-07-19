# Agent Idle Detection & Browser Notifications — Design

**Date:** 2026-07-19
**Status:** Approved (brainstormed and accepted in-session)

## Context

Tmuxifier users run AI coding agents (Claude Code) inside box tmux sessions, often several
boxes at once. The dashboard shows box health, but nothing tells the user *the agent on
web-01 is blocked waiting for your input* or *the agent finished while you were away*. The
building blocks already exist: the status poller sweeps every box on an interval,
`healthHistory.js` turns snapshots into edge-triggered persisted events, and the events
panel renders them. This feature adds agent-state awareness to that pipeline plus browser
notifications, with per-kind filtering.

Inspired by reviewing oh-my-openagent's goal/idle tracking; implemented at Tmuxifier's
infrastructure layer instead of inside the agent.

## Goals

- Detect, per box, when Claude Code in the box's **configured tmux session** transitions to
  *waiting for input* or *finished/exited*, and record those as events.
- Fire **browser notifications** for event kinds the user has enabled, from any open
  dashboard tab.
- A **Notifications tab** in the settings modal: per-kind toggles and the permission flow.
- Every event always lands in the existing events log regardless of toggles; toggles govern
  only the events-button counter and browser notifications.

## Non-goals (explicitly deferred)

- No push service, webhook, ntfy, or email delivery — browser notifications only, which
  means no delivery when no dashboard tab is open. Accepted.
- No detection outside the box's configured `sessionName` (scratch/manual sessions ignored).
- No detection of other agent TUIs (codex, etc.) — the pane-command match is
  `claude` / `claude-*` only, mirroring `tmuxInject.js`.
- No screen-content (capture-pane) detection in v1 — see Detection below; the
  `tmuxInject.js` marker regexes remain available as a future refinement if the idle
  heuristic proves noisy.

## Detection (server)

**Approach: idle-activity heuristic.** Claude Code's TUI repaints continuously while
working (spinner/elapsed timer), so tmux `window_activity` keeps advancing. A pane whose
current command is claude and whose window has been static for `agentIdleSec` seconds is
*waiting for input*. No screen scraping, no extra SSH.

- `status.js` `PROBE_REMOTE` is extended (same single ssh probe): alongside the existing
  session listing, it emits for each tmux session the **active pane's current command**
  (`#{pane_current_command}`) and the session's **last-activity epoch**
  (`#{window_activity}` of the active window), plus the **box's own clock** (epoch seconds)
  once per probe. Idle time is computed as `boxNow - activityAt` — both from the box's
  clock, so host/box clock skew cannot distort it.
- `parseTmuxSessions` gains the new fields; `checkBox` results expose them on the existing
  `sessions` array.
- `healthHistory.js` `sampleOf` derives, for the session matching the box's `sessionName`
  only: `agent: 'working' | 'waiting'` (absent when no claude pane). `waiting` requires
  the claude command match AND idle ≥ `agentIdleSec`. The sample also carries the session's
  existing `attached` flag.
- `classifyTransitions` emits two new edge-triggered kinds:
  - **`agent-input`** — previous sample `working`, current `waiting`, and the session is
    **not attached**. Edge-triggered: a persistently waiting agent emits once; it must
    return to `working` before a new `agent-input` can fire.
  - **`agent-done`** — previous sample had an agent (`working` or `waiting`), current
    sample has none, the box is still up, and the session is **not attached**.
  - The attached-suppression applies only to the two agent kinds. Box-level kinds
    (`down`, `up`, `needs-auth`, `key-changed`, `threshold`, `threshold-clear`) are
    unchanged and never suppressed. The existing first-sample seeding rule applies (no
    emission without a previous sample).
- Event records carry the standard fields (`kind`, `boxId`, `label`, `host`, `t`, `seq`) —
  no new payload fields.

**Config:** `agentIdleSec`, env `TMUXIFIER_AGENT_IDLE_SEC`, default 45, clamped 10–3600
via the existing `clampInt` convention.

## Events log (unchanged pipeline)

The new kinds flow through the existing persisted log (`data/health-events.json`, capped),
`GET /api/health/events`, and the events panel. Nothing bypasses the log, and toggles never
filter it.

## Web client

- `api.ts`: `HealthEventKind` gains `'agent-input' | 'agent-done'`.
- `healthEvents.ts` `formatEvent` gains the two cases:
  - `agent-input`: icon `⌨️`, text `<name> — claude is waiting for input`, level `warn`.
  - `agent-done`: icon `🤖`, text `<name> — claude finished`, level `ok`.
  (The default case shipped in v1.7.7 keeps stale bundles safe.)
- **`notifyPrefs.ts` (new, pure):** the kind catalog with human labels, default preferences
  (all enabled except the recovery kinds `up` and `threshold-clear`), localStorage
  load/save (`tmuxifier.notifyPrefs`), and `enabledKinds(prefs): Set`. Per-browser by
  design — the Notification permission itself is per-browser, so the filter is too.
- **Counter semantics change:** the events-button unseen counter counts only events whose
  kind is enabled (new pure helper in `healthEvents.ts` taking the enabled set; the
  existing `unseenCount` behavior is subsumed).
- **Browser notifications (`main.ts`, existing health poll):** track a separate
  `lastNotifiedSeq`, initialized to the latest seq on the first poll (no startup flood).
  For each newer event whose kind is enabled, when `Notification.permission === 'granted'`
  and the dashboard tab is **not focused** (focused tab = the badge suffices), fire
  `new Notification('Tmuxifier — <label>', { body: <formatEvent text>, tag: <kind>:<boxId> })`
  (tag coalesces repeats); clicking focuses the window. Torn down on logout/session-expiry
  like the other pollers (no change needed — it rides the existing poll).

## Settings → Notifications tab

Third tab in the settings modal, same section pattern as NetBox/Proxmox
(`settingsNotifications.ts`, registered in `settingsUi.ts` `SECTIONS`):

- Permission line: current state (`granted` / `denied` / `default`) with an **Enable
  browser notifications** button calling `Notification.requestPermission()` (hidden once
  granted; `denied` shows a "re-enable in browser site settings" note).
- One checkbox per event kind, labeled from the `notifyPrefs.ts` catalog, saved to
  localStorage immediately on change.
- A one-line note that these settings are per-browser and that all events always appear in
  the events log regardless.

## Testing

Pure/unit (vitest, node):
- `parseTmuxSessions` with the extended probe output (pane command, activity, box clock).
- `sampleOf` agent-state derivation: working vs waiting threshold, wrong-session ignored,
  non-claude command ignored.
- `classifyTransitions`: `agent-input` edge, re-arm behavior, `agent-done` edge,
  attached-suppression of both, box-kind emission unaffected.
- `notifyPrefs`: defaults, round-trip, enabled-set.
- Filtered unseen counter.
- `formatEvent` new cases.

Config clamp test for `agentIdleSec`. DOM/Notification wiring (settings tab, notification
firing) has no unit seam in the node test environment — typecheck plus live verification,
per repo convention.

## Risks / notes

- The heuristic assumes claude repaints while working. If a silent long-running state
  produces false `agent-input` events, raise `agentIdleSec` or add the
  `tmuxInject.js`-style screen-marker check as a confirmation step (deferred).
- Suppression uses the tmux `attached` flag, which is true while a Tmuxifier browser
  terminal for that box is open — intended: watching the terminal means no ping.
- Browser notifications require HTTPS (secure context) — already the deployment's shape.
