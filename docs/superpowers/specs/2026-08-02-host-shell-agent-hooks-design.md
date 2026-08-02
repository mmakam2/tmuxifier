# Host-shell agent hooks — design

**Date:** 2026-08-02
**Status:** approved

## Problem

The Claude Code agent-state hooks (`claudeAgentHooks.js`) are pushed to remote boxes during
setup, so a claude running in a box's tmux session reports `working`/`waiting` state that
Tmuxifier surfaces as a sidebar badge, a pane-header chip, and `agent-input`/`agent-done`
browser notifications. The Host Shell — the terminal on the Tmuxifier host itself — has none
of this: it is not a box, no status probe runs against it, and nothing installs the hook
locally. A claude session running in the host shell is invisible to the agent-state pipeline.

This feature wires the host shell into the same pipeline: hook install on the host (opt-in),
marker sampling each poll, and full parity on the client — badge on the Host Shell sidebar
button, pane-header chip, and agent notifications.

## Decisions made during brainstorming

- **Install opt-in lives in the Host Shell ✎ "Configure shell" dialog** as a checkbox,
  mirroring the boxes' one-knob Claude opt-in. Fire-on-save, not persisted state: ticking the
  box and saving runs the install once; an unchecked box touches nothing (the v1.24.13
  strict posture). Unchecking never uninstalls. Reinstalling after a hook-script update means
  re-opening the dialog, ticking, and saving.
- **Full parity, not badge-only:** events and browser notifications ride along, because
  "claude is waiting for input while the tab is closed" is the point of the hooks.
- **Marker sampling is always on** (not gated by the checkbox): reading the marker directory
  and one local tmux query per poll costs microseconds. With no marker present the chip stays
  silent — the same "needs hooks installed" cue boxes give.

## Approach (chosen: ride the existing healthHistory rails)

A synthetic `__local__` pseudo-box is fed into `healthHistory.record()` alongside the real
boxes. Everything downstream — `/api/health/series`, badge painting, the pane-header chip,
edge-triggered events, attach-suppression, browser notifications — works unchanged.

Rejected alternatives:

- **Separate `/api/local/agent` endpoint + custom client poll** — duplicates badge logic and
  needs a second notification delivery path.
- **Register the host as a real box over `ssh localhost`** — violates the self-contained
  principle (SSH-to-self, host-key churn, probe overhead for a machine the server *is*).

## Design

### 1. Server sampler — new `src/server/localAgent.js`

Factory `createLocalAgentSampler({ localSession = 'local', homedir, run })` following the
repo's DI pattern (injectable `run` and `homedir` so tests use real code, no mocks). One
`sample()` call per poll returns a status-shaped object:

```
{ reachable: true, sessions: [{ name, attached, paneCmd }], agentMarks }
```

- **tmux query:** `tmux list-sessions` / active-pane command with `-F` format strings, run
  locally via `execFile` (argv, never a shell-interpolated string). tmux not installed, no
  server running, or no sessions → `{ reachable: true, sessions: [] }`; the sampler never
  throws into the poll loop.
- **Marker read:** `fs.readdir` on `~/.tmuxifier-agent/`, each file's content capped at 200
  bytes (the same cap the on-box probe applies), prefixed with `__AGENT__ ` and fed through
  the existing `parseAgentMarks` from `status.js` — reusing its closed state set and numeric
  timestamp allowlist rather than writing a second parser. Marker content is treated as
  untrusted input exactly as box-probe output is.
- The sample is always `up` (it is the server's own host) and carries no metrics, so
  `classifyTransitions` can structurally never emit `down`/`up`/`needs-auth`/`threshold`
  events for it — only the agent edges. No suppression code needed.

### 2. Poller feed — `statusPoller.js`

The poller accepts an optional injected sampler (default `null`, preserving current behavior
and existing tests). After each snapshot swap, where it already calls
`history.record(snapshot, boxes)`, it instead calls:

```
history.record(
  { ...snapshot, __local__: localStatus },
  [...boxes, { id: '__local__', label: 'Host Shell', host: 'localhost', sessionName: localSession }]
)
```

- `/api/status` is untouched — the pseudo-box exists only in the arguments to `record()`.
- `healthHistory`'s prune keeps the `__local__` series alive because the pseudo-box is in
  the `boxes` argument every pass.
- Events carry `label: 'Host Shell'`, `host: 'localhost'`. `agent-input`/`agent-done` edges
  and the attached-session suppression work unchanged: viewing the host shell attaches the
  `local` tmux session, which mutes events exactly as watching a box terminal does.
- The `sessionName` threaded to the pseudo-box is the same `localSession` value the session
  manager attaches (`sessions.openLocal`), keeping the two from diverging if the knob is
  ever non-default.

### 3. Install path — `localShellActions.js` + route

- `localShellActions` gains `installAgentHooks()`: runs the **unchanged**
  `buildAgentHooksInstallScript()` via `execFile('/bin/sh', ['-c', script])` with the hook
  asset bytes (`src/server/assets/tmuxifier-agent-hook.sh`) written to stdin — the same
  script + stdin contract the SSH pusher uses, over a local transport. Returns the pusher's
  result shape (`{ ok }` / `{ ok: false, skipped }` / `{ ok: false, error }`).
- The script's own `command -v claude` gate makes the no-claude host a clean
  `skipped-no-claude`, not an error. The settings.json merge (jq → node → python3, atomic
  temp+rename, remove-then-append per event) is reused as-is.
- The existing local-shell save route (`PATCH /api/local-shell`) gains an optional boolean
  `claudeHooks` field. When
  `true`, the route runs `installAgentHooks()` after `ensureReady()` and includes the result
  in the response. Absent or `false` touches nothing.

### 4. Client — `src/web/main.ts` (+ dialog)

- **✎ dialog:** a "Claude Code hooks" checkbox (label mentions agent state + notifications),
  default unchecked on every open, sent as `claudeHooks` on save. The dialog shows the
  result line: applied / no Claude on this host / error text.
- **Sidebar badge:** the `.local-shell` row gains a badges span; `repaintAgentBadges()` also
  paints it from `latestSeries['__local__']` through the same `applyAgentBadge` helper.
- **Pane header chip:** the header's agent read comes from the latest `/api/health/series`
  sample keyed by pane id; with `__local__` now present in the series this is expected to
  work without changes — verify during implementation.
- **Dashboard / fleet cards:** iterate the box list, so the extra `__local__` series key is
  ignored. The events panel shows "Host Shell" lines via the existing formatters.

### 5. Edge semantics

- **Configured-session-only, same as boxes:** only a claude inside the tmux session named
  `local` counts. The hook itself exits unless `$TMUX` is set, and `sampleOf` reads only the
  pseudo-box's `sessionName`, so a claude running elsewhere on the host (a plain SSH login
  session, a different tmux session) either writes no marker or writes one that is ignored.
- **Hook and markers live in the service user's HOME** (set in the systemd unit), which is
  the same user the host shell's tmux session runs as — writer and reader agree on the path.
  The install script honors `CLAUDE_CONFIG_DIR` for settings.json; the marker path is
  `$HOME/.tmuxifier-agent` regardless, matching what the sampler reads.
- **Marker staleness:** the hook self-prunes markers older than 7 days; a stale marker for
  an exited claude stays inert behind the `paneCmd` gate in `sampleOf`, exactly as on boxes.
- **Restart-gap protection:** `agentPresent` (pane runs claude, marker or not) keeps a
  one-poll marker gap during an in-place claude restart from reading as `agent-done` — the
  logic is in `sampleOf`/`classifyTransitions` and applies to the pseudo-box unchanged.

### 6. Testing

Unit tests with real code via DI (repo convention, no mocks):

- `localAgent.test.js` — marker parsing through `parseAgentMarks` (valid, oversized,
  malformed), tmux-absent and no-server paths, output shape matching what `sampleOf` expects.
- `statusPoller` tests — with a sampler injected, `record()` receives the pseudo-box and the
  merged snapshot; without one, behavior is unchanged.
- `localShellActions` tests — `installAgentHooks()` with a fake runner: script text is the
  unchanged `buildAgentHooksInstallScript()` output, hook bytes arrive on stdin, result
  mapping for applied / skipped-no-claude / failure.
- Route test — `claudeHooks: true` triggers the install and reports its result;
  absent/false does not.
- No DOM tests for the badge/chip painting (vitest runs `environment: 'node'`; DOM layers
  are untested by design). Client verification happens on the live app per the standing
  validate-before-ship workflow, including eyeballing the badge on the Host Shell button.

### 7. Docs

- `CLAUDE.md` / `AGENTS.md` — `localAgent.js` module entry; note the `__local__` pseudo-box
  in the `statusPoller.js`/`healthHistory.js` entries and the `claudeHooks` flag in the
  `localShellActions.js` entry.
- `docs/terminal.md` — host shell section: the checkbox, what it installs, the badge.
- `docs/fleet-and-health.md` — Host Shell appears in agent notifications/events.
