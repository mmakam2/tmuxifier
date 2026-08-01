# Ground-truth agent state via Claude Code hooks — design

Date: 2026-08-01
Status: approved (brainstormed and section-approved in session)

## Problem

`healthHistory.js` derives a box's agent state (`working`/`waiting`) from a heuristic:
the configured session's active pane must be a `claude`/`claude-*` process, and the time
since the pane last produced output (`#{window_activity}` vs the box clock) decides
working vs waiting, with a 20-second idle threshold (`agentIdleSec`) and a two-sample
"working" streak (`AGENT_WORK_MIN_SAMPLES`) papering over the known false positives:

- A Claude thinking for minutes while repainting its spinner reads correctly, but a
  parked Claude pane emits a brief output blip roughly every 30 minutes that looks
  exactly like a task starting and finishing — the streak guard exists solely to
  suppress the resulting false "waiting for your input" notifications.
- A genuinely waiting Claude is only detected after the idle threshold elapses plus up
  to one poll interval, so the agent-input notification always trails reality.
- Missing clock data (a failed `__META__` line) forces `'unknown'` rather than a guess.

Claude Code has lifecycle hooks that fire at exactly the moments this heuristic tries to
reconstruct. Using them upgrades the signal from inference to ground truth.

## Decisions (settled during brainstorming)

1. **Scope: Claude Code only.** Codex's `notify` mechanism differs enough (config.toml,
   no needs-input event) to be its own later feature. Codex sessions keep the heuristic.
2. **Always pushed when Claude is present.** No new setup checkbox or option flag. The
   setup job always runs the hooks push; the box decides via a `command -v claude` check
   (the `buildFrameworkUpdateClamps` precedent: runs on every setup, guarded by evidence
   on the box). Removal is documented for operators who opt out.
3. **Transport: marker file + existing SSH probe.** Hooks write a tiny state file on the
   box; the per-poll probe reads it alongside `__META__`. No inbound network surface, no
   credentials on boxes, latency bounded by one poll interval — the same delivery
   characteristics as every other status signal. A hook-POSTs-to-server design was
   rejected because it would add a per-box auth token (a stored-credential class the
   product deliberately does not have) and an inbound HTTP surface from the fleet.

## On-box half

### New module: `src/server/claudeAgentHooks.js`

Structural twin of `claudeStatusline.js`: a pure `buildAgentHooksInstallScript()` plus a
DI `createAgentHooksPusher({ runStdin, readAsset })`. The installer script text goes into
ssh argv and interpolates no input; the hook script bytes arrive on stdin
(`boxActions.execScriptStdin`).

### Hook script asset: `src/server/assets/tmuxifier-agent-hook.sh`

Installed to `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/tmuxifier-agent-hook.sh`, mode 755.
Claude Code invokes it with the event name as `$1`. Behavior:

- Exits 0 immediately when `$TMUX` is unset — headless `claude -p` runs and non-tmux
  usage never write state.
- Resolves the tmux session name via `tmux display-message -p '#S'`; exits 0 if that
  fails or returns empty.
- Writes one line — `<session>:<state>:<epoch seconds>` — atomically (temp file + `mv`)
  to `~/.tmuxifier-agent/<sanitized-session>`, where the filename is the session name
  with every character outside `[A-Za-z0-9._-]` replaced by `_`. Colon separators are
  safe because tmux forbids `:` in session names (the same invariant `STATUS_FMT`
  already relies on). A filename collision between two session names that sanitize
  identically is accepted; the line content carries the exact name and the server matches
  on it.
- Event mapping:
  - `UserPromptSubmit` → `working`
  - `Stop` → `waiting`
  - `Notification` (permission prompt or the 60s-idle nudge) → `waiting`
  - `SessionStart` → `waiting` (a fresh or resumed Claude sits at its prompt)
  - `SessionEnd` → delete the marker file
  - any other argument → exit 0
- Self-prunes marker files older than 7 days on each invocation (the uploads-dir
  posture), so dead sessions' markers cannot accumulate forever.

### settings.json merge

Same shape as the statusline installer: skip when Claude is absent (`command -v claude`
plus the `~/.local/bin/claude` check, draining stdin before exiting), write the hook
script from stdin, then merge into `settings.json` via the jq → node → python3 fallback
chain with atomic temp+rename, reporting `error-no-json-tool` when all three are absent
and a fresh-file quoted-heredoc path when no settings.json exists yet.

The one real difference from the statusline merge: `hooks` entries are arrays of matcher
objects, not a single key, so the merge is **remove-then-append** per event — for each of
the five events, drop any existing entry whose command string contains
`tmuxifier-agent-hook`, then append ours. Reruns are idempotent and the operator's own
hooks are never touched. The hook command value is written literally with
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}` left for the runtime shell to expand, exactly like
`CMD_LITERAL` in `claudeStatusline.js`. The exact hooks JSON schema (matcher field
presence for non-tool events) is verified against current Claude Code docs during
implementation.

### Setup phase

`createSetupManager` gains an injected `pushAgentHooks` (default null, unwired managers
skip it — the `seed`/`pushStatusline` pattern). It runs as a new `agent-hooks` phase
after `statusline` and strictly before `ensureSession`, unconditionally (no option gate).
The redacted result is recorded on `j.agentHooks` and surfaced by `summarize()`; a failed
push is recorded, never promoted to a job failure. `index.js` wires the pusher with
`readAsset` pointing at the new asset file.

## Server half

### Probe extension (`status.js`)

`PROBE_REMOTE` gains one static, non-interpolated block (the `META_PROBE` posture: no box
field reaches it, wrapped so stderr never leaks into the reachability classifier): if
`~/.tmuxifier-agent/` exists, emit one line per marker file, prefixed `__AGENT__ `,
newline-stripped and capped with `head -c 200` so a corrupted marker cannot flood probe
stdout.

New parser `parseAgentMarks(stdout)`, mirroring `parseMeta`'s discipline — marker content
is input from the box, so it is allowlisted, not trusted:

- lines starting `__AGENT__ ` only;
- split on `:` into session / state / ts;
- state must be exactly `working` or `waiting`;
- ts must be a finite positive number;
- anything else is dropped.

Result attached to the probe status as `agentMarks: { [sessionName]: { state, ts } }`.
`parseTmuxSessions` additionally filters out `__AGENT__` lines (it currently excludes
only `__META__` and `__NO_TMUX__`).

### Sample derivation (`sampleOf` in `healthHistory.js`)

Presence is unchanged: `sample.agent` exists only when the configured session's
`paneCmd` matches `^claude(-|$)`, so a crashed or exited Claude still produces agent-done
via absence, and a stale marker for a dead Claude is inert.

Within that gate:

- Marker present for the configured session → `sample.agent = marker.state`,
  `sample.agentSrc = 'hook'`. No clock math is involved, so the hook path never yields
  `'unknown'`.
- No marker → today's idle heuristic unchanged, tagged `agentSrc: 'est'`.

No staleness cutoff on marker age: a long-thinking Claude legitimately holds an old
`working` marker (`UserPromptSubmit` fired once at turn start). The one stale scenario —
an operator hand-removes the hooks from settings.json but leaves a marker behind — is
self-inflicted and has a documented remedy (`rm -rf ~/.tmuxifier-agent`).

### Edge detection (`classifyTransitions`)

The `AGENT_WORK_MIN_SAMPLES` streak guard exists solely because heuristic output-blips
fake a working→waiting edge. Hook-sourced samples are not blip-prone, so the agent-input
condition becomes: streak satisfied **or** `prev.agentSrc === 'hook'`. Everything else —
attach suppression, agent-done rules, the `!next.stopped` guard, event kinds — is
unchanged.

Net behavior on hooked boxes:

- agent-input fires on the first poll after `Stop`/`Notification` — no 20-second idle
  wait, no two-poll confirmation;
- the parked-pane 30-minute blip false positive becomes impossible (output alone never
  changes the marker);
- `'unknown'` disappears for hooked sessions (no dependency on `boxNowSec`).

### Known gap (accepted)

Claude Code deliberately skips the `Stop` hook when the user interrupts with Escape. The
marker then stays `working` until the 60s-idle `Notification` fires or the next prompt is
submitted. Interrupting requires an attached terminal, and attachment already suppresses
agent events, so the cost is a briefly wrong state chip, never a false notification.

## Not in scope (noted follow-ups)

- Distinguishing "needs permission" (`Notification`) from "turn done" (`Stop`) as
  separate states/event kinds — touches `notifyPrefs` and the persisted event schema;
  v1 maps both to `waiting`.
- Codex ground truth via its `notify` mechanism.
- Any server-push notification delivery (separate feature; this design only sharpens the
  signal those notifications consume).

## Testing

Following the `claudeStatusline.test.js` pattern (real shell via `runShell`, temp HOME,
fake `claude` on PATH — real code, no mocks):

- **Installer script**: merge preserves foreign hooks; rerun is idempotent (no duplicate
  entries); skip-no-claude drains stdin and reports the skip sentinel; fresh-file path
  writes valid JSON; `error-no-json-tool` when jq/node/python3 are all absent.
- **Hook script**: writes the expected `session:state:ts` line per event; `SessionEnd`
  deletes; no-ops outside tmux; sanitizes filenames; prunes old markers.
- **`parseAgentMarks`**: valid lines parse; bad state/ts/garbage/oversized lines drop;
  `parseTmuxSessions` ignores `__AGENT__` lines.
- **`sampleOf`**: marker wins over heuristic; falls back when absent; hook path needs no
  clock; `paneCmd` gate still controls presence.
- **`classifyTransitions`**: hook-sourced single-sample working→waiting fires
  agent-input; heuristic-sourced still requires the streak; suppression and agent-done
  behavior unchanged.
- **Integration (localBox)**: spin up the isolated sshd + tmux, install and invoke the
  hook script over SSH, then assert the full `PROBE_REMOTE` round trip surfaces the mark
  in the parsed status.

## Rollout and docs

Existing boxes pick up hooks on their next setup run (box edit/retry, or a fleet-driven
rerun). Documentation updates: `docs/boxes-and-setup.md` (what setup pushes, the
always-on semantics, the removal path), `docs/fleet-and-health.md` (agent state is
ground truth on hooked boxes, heuristic elsewhere), and the CLAUDE.md/AGENTS.md module
entries for `claudeAgentHooks.js` and the touched modules.
