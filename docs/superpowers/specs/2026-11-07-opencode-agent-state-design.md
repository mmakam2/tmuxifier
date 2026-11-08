# OpenCode agent-state tracking — design

Issue: mmakam2/tmuxifier#6. Predecessor: `2026-11-07-agent-lifecycle-states-design.md` (Claude Code).
Evidence: `test/fixtures/opencode-event-trace.jsonl` + `README-opencode-event-trace.md`, a real
OpenCode **2.2.6** recording made 2026-11-08 on a Debian 13 box (commit c1e1fe3). Statements marked
**[source]** were read from the OpenCode `dev` branch on 2026-11-07 and are not exercised by the
trace; everything else was observed.

## 1. Intent

An OpenCode pane on a box or the Host Shell shows the same four states as a Claude Code pane —
`working`, `blocked`, `done`, `idle` — in the pane chip, sidebar badge, AGENTS board, health
events, FCM push and the MCP tools, with identical semantics. State comes only from OpenCode's own
plugin events; nothing reads the screen.

## 2. The contract that does not change

- Marker file `~/.tmuxifier-agent/<tmux-session>` holding `<session>:<state>:<epoch>:<cause>`;
  states `working|blocked|ready`, causes `prompt|resume|stop|start|permission|question|elicitation|unblock`
  (`parseAgentMarks` in `src/server/status.js` is the allowlist; `ready/start` reads as idle,
  `ready/stop` as done-until-seen).
- Atomic write (tmp + rename), fail open, no error ever surfaces into the agent.
- The probe ships markers only; a marker counts only for a session whose pane command matches an
  agent (`healthHistory.sampleOf`).
- Setup pushes the reporter the way `claudeAgentHooks.js` pushes the Claude hook: installer text
  interpolates nothing, the plugin bytes arrive on stdin, the box decides via `command -v opencode`,
  reruns are idempotent.

## 3. What the recording established

These facts drive the design; several contradict the issue text and the first draft.

1. **One server per user, shared by every TUI.** A plain `opencode` TUI spawns
   `opencode serve --service` as a child; a second TUI (any tmux session, same or other directory)
   connects to that process and spawns nothing. The server is reparented to pid 1 when its TUI
   exits and **keeps running after the last TUI exits** (alive 10+ min later). Plugins run in the
   server. So `process.env.TMUX`/`TMUX_PANE` in the plugin are the *first* TUI's, forever, and a
   TUI exit produces **no event at all** (trace: nothing between lines 397 and 398).
2. **One plugin instance per project directory, in that one process.** A TUI in a new directory
   triggers another `setup` of the same plugin file (same pid, lines 316-317). Every instance's
   `ctx.event.subscribe()` receives **every** event of the process (events are doubled from line
   336 on, same `event.id`); hooks fire once, in the instance owning the directory.
3. **The plugin directory is watched.** A file written to `~/.config/opencode/plugins/` was loaded
   by the running server within 3 s, before any TUI started (hot-load probe, not in the fixture).
   `OPENCODE_CONFIG_DIR` overrides the config dir; default discovery from `~/.config/opencode/plugins/`
   confirmed (lines 403-413).
4. **Turn boundary** = `session.execution.started` → `session.execution.succeeded | interrupted`.
   `session.status` and `session.idle` never fired. `session.prompt` hook fires for operator prompts
   only; synthetic resumes (background work finished) arrive as `session.inbox.enqueued` with
   `item.type: "synthetic"` and no prompt hook (lines 246-248, 300-303).
5. **Blocking** = `permission.asked` (`action`, `resources`, `source.{messageID,id}`) cleared by
   `permission.replied` (`reply: once|always|reject`); `form.created` with
   `form.metadata.kind === "question"` cleared by `form.replied`/`form.cancelled`. Escape and the
   Reject button both reply `reject`, immediately followed by `session.tool.failed` and
   `session.execution.interrupted` (`reason: shutdown`). 2.2.6 has no typed-message stage.
6. **Background work**: a shell moved with ctrl+b is bracketed exactly by `shell.created`
   (`info.metadata.sessionID`, `info.id`) and `shell.exited` (`id`); the turn ends with
   `execution.succeeded` while it runs (line 298), and its completion re-enters as a synthetic
   prompt. The `session.experimental.idle` hook reports the same list (`background[]`, line 290).
7. **Directory attribution**: `session.created`, every `session.inbox.enqueued` (except the two
   synthetic background notices), `permission.asked/replied`, `form.*`, `shell.*` and all step/text/
   tool events carry `event.location.directory`; `session.execution.*`, `session.usage.updated`
   and `session.viewed` do not. A resumed session (`opencode -c`) fires no `session.created`, but
   its first `inbox.enqueued` carries the directory before `execution.started` (lines 415-416).
8. **Pane command**: `#{pane_current_command}` is `opencode` for the npm package too — `@opencode/cli`
   ships a native ELF binary (`bin/opencode.exe`, symlinked as `opencode`), no Node shim. The
   `#{pane_current_path}` is the TUI's working directory.
9. **Install**: `curl -fsSL https://opencode.ai/v2/install | bash` lands the binary in
   `$HOME/.opencode/bin/opencode` and appends a PATH line to rc files unless `--no-modify-path`.
10. **[source]** V2 loader accepts only a default export `{ id, setup }` / `{ id, effect }`; node
    builtins are available (embedded Bun 1.4.4); child (subagent) sessions carry an optional
    `parentID` (`session-event.ts:47`); MCP elicitation forms use `sessionID: "global"`.

## 4. Design

### 4.1 The reporter: `src/server/assets/tmuxifier-opencode-agent.js`

One ESM file, OpenCode V2 shape, **node builtins only**, authored as `.js` so vitest (Node) and the
box (Bun) load the same bytes. Exports `default { id: 'tmuxifier-agent', setup(ctx) }` and the pure
pieces the tests drive: `createReducer()`, `foldForPanes(sessions, panes)`, `parsePanes(text)`.

**Process-wide singleton with unconditional hand-over.** `setup` looks up
`globalThis[Symbol.for('tmuxifier.opencode-agent')]`. If a core exists it is **aborted** (event
subscription and sweep timer stopped; its marker memory — what it wrote where — is inherited) and
the new `setup` installs itself as the owner; so a setup rerun that overwrites the plugin file
(OpenCode reloads on digest change, fact 3.3) always ends with exactly one live core running the
new bytes, whether or not OpenCode calls the old instance's cleanup. A further `setup` for another
directory in the same process does the same hand-over (cheap, idempotent). `cleanup` clears the
global and deletes the markers only if the cleaning instance still owns the core. Events are
additionally deduped by `event.id` (belt and braces for fact 3.2). **No hooks are registered**:
everything needed is in the event stream (fact 3.4-3.7), and a throwing session hook fails the
operator's execution while an event consumer cannot. Live upgrade without an OpenCode restart is a
requirement and is validated on a test box by rerunning setup over a running server.

**Inert conditions.** `tmux` not on PATH (`execFile` ENOENT) → the core never writes and never
sweeps. No matching pane → no write for that session. Every write and every tmux call is wrapped;
nothing propagates.

**Per-OpenCode-session state** (`Map<sessionID, S>`), `S = { dir, parent, executing, cause,
blocks: Map<id, cause>, shells: Set<shellID>, lastInbox: 'user'|'synthetic', ts }` where `ts` is
the epoch **in seconds** (the sh hook's unit) of the session's last derived-state transition:

| event | effect |
|---|---|
| any event with `location.directory` + `data.sessionID` | `S.dir = directory` (first wins) |
| `session.created` | create `S`; `parent = data.parentID` if present **[source]** |
| `session.inbox.enqueued` | `lastInbox = item.type` |
| `session.execution.started` | `executing = true`; `cause = lastInbox === 'synthetic' ? 'resume' : 'prompt'` |
| `permission.asked` | `blocks.set(id, 'permission')` |
| `form.created` | `kind === 'question'` → `blocks.set(form.id, 'question')`; other kind with a real `sessionID` → `'elicitation'`; `sessionID === 'global'` → ignored (my call: it cannot be attributed to a directory) |
| `permission.replied` / `form.replied` / `form.cancelled` | delete the block; if any block was deleted and `executing` → `cause = 'unblock'` |
| `shell.created` | `shells.add(info.id)` on `S[info.metadata.sessionID]` |
| `shell.exited` | remove from whichever `S` holds it |
| `session.execution.succeeded` / `interrupted` / `failed` | `executing = false`, `blocks.clear()` (a reject interrupts; nothing survives a turn end in 2.2.6 — and the Claude rule "timers never clear blocked" does not apply because this is the agent's own end-of-turn, not a timer) |
| `session.deleted` | drop `S` |

**Derived state of one session**: `blocked` (its cause) if `blocks` non-empty **or any child
session (`parent === id`) is blocked** (the child's cause — a subagent's permission prompt is the
session's block, as in the Claude hook's owner record); else `working` (`cause`) if `executing`, or
if any shell is running, or if any child is working; else `ready/stop`. Child sessions never write
on their own — they roll up into the parent. `ts` moves whenever the derived state or cause changes.

**Attribution and writing** (`foldForPanes`): panes come from
`tmux list-panes -a -F '#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}'`
(2 s timeout, 1 s cache), filtered to the **active pane of the active window** of each tmux
session — exactly the pane the probe's `STATUS_FMT` reports, so the reporter and the server agree
on which agent owns the session right now, and a tmux session whose current window runs Claude is
never touched by this reporter. For each tmux session whose active pane command matches
`/^opencode(-|$)/`: candidates = sessions whose `dir` equals the pane path, else whose `dir` is a
prefix of the pane path or vice-versa (TUI started in a subdirectory of the project it reports — my
call, not exercised by the trace), **and whose `ts` is not older than `since[tmux-session]`**, the
moment the sweep first saw this tmux session's active pane become opencode (reset whenever it
stops being opencode). This is what keeps finished sessions of a previous TUI, which live on in the
server for its whole life, from making every relaunch read `done`. Fold: `blocked` > `working` >
`ready`, ties to the newest `ts`; the cause and **the written epoch are the chosen session's `ts`**
(not the fold time), so a marker deleted and recreated for an already-acknowledged turn carries
the same `ts` and stays `idle` under the seen watermark. No candidates → `ready/start` with
`ts = since`. Write `<tmux-session>:<state>:<ts>:<cause>` to `~/.tmuxifier-agent/<safe-name>`
(`[^A-Za-z0-9._-]` → `_`, like the sh hook) via `writeFileSync(tmp) + renameSync`, mode 0644, only
when the content differs from the last content this core wrote for that name. Two TUIs in the
same directory in different tmux sessions therefore show the same folded state — documented
limitation (fact 3.1 leaves no per-TUI handle).

**Sweep** (every 15 s with the timer `unref`'d, and after every state change): re-list panes;
every tmux session with an active opencode pane gets its fold written (a fresh TUI with no
candidates gets `ready/start` — the cue the hook's SessionStart write gave, and the write that
replaces the hook's SessionEnd delete is below); for a tmux session this core wrote before whose
active pane no longer runs opencode, **read the marker and delete it only if its content equals
the last content this core wrote** — a marker the Claude hook has since rewritten is never
deleted. On `cleanup` (server shutdown, line 398) delete this core's markers under the same
content-equality rule.

Gaps accepted: a TUI that exits and another that starts in the same tmux session within one sweep
interval keeps the previous TUI's marker until the next sweep (≤15 s); a TUI killed mid-permission
leaves the OpenCode request pending, which is truthfully `blocked` until the server is restarted
or the session resumed.

### 4.2 Server

- `healthHistory.sampleOf`: `agentKindOf(paneCmd)` → `'claude' | 'opencode' | null`
  (`/^claude(-|$)/`, `/^opencode(-|$)/`); `present = kind !== null`; `entry.agent = kind` rides on
  the per-session entry and on the `agent-blocked`/`agent-input`/`agent-done` events.
- Copy names the agent instead of "claude": `healthEvents.ts` lines 64-66 (`e.agent ?? 'claude'`),
  `fcmPush.js` `TITLES`/body (`Claude needs you` → `<Agent> needs you`), `notifyPrefs.ts` labels
  become agent-neutral ("Agent needs you (permission or question)"), MCP tool descriptions say
  "agent (Claude Code or OpenCode)". `BOARD_HEADS` is already neutral.
- `localAgent.js`: nothing structural (reads the same dir). Issue #7 item: `NO_SERVER_RE` becomes
  `/no server running|error connecting to .*\(No such file or directory\)/i`, so a
  `Connection refused`/`Permission denied` socket error is "listing unknown", not an empty listing.

### 4.3 Setup

- New catalog tool **`opencode`** in `TOOL_IDS` (after `agy`), `TOOL_IMPLIES.opencode = ['curl']`,
  mirrored in `provisionTools.ts` (label "OpenCode"), MCP `SETUP_TOOLS`, and the pinning tests.
  Installer (install-if-missing like every catalog tool):
  ```sh
  if ! command -v opencode >/dev/null 2>&1 && [ ! -x "$HOME/.opencode/bin/opencode" ]; then
    t="$(mktemp)"; curl -fsSL https://opencode.ai/v2/install -o "$t"; bash "$t" --no-modify-path; rm -f "$t"
  fi
  ```
  plus an `OPENCODE_BIN_PATH_BLOCK` (tag `# tmuxifier-opencode-bin`, same delete-then-append shape
  as `LOCAL_BIN_PATH_BLOCK`) so PATH handling stays ours and idempotent.
- New setup phase **`opencode-plugin`** after `voice-link`, gated on `tools.includes('opencode')`
  (one knob, like the Claude stack), pusher `src/server/opencodeAgentPlugin.js` mirroring
  `createAgentHooksPusher`: the installer text checks
  `command -v opencode || [ -x "$HOME/.opencode/bin/opencode" ]`, writes stdin to
  `"${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins/tmuxifier-agent.js"` (tmp + mv, 0644),
  prints `OPENCODEPLUGIN: applied|skipped-no-opencode`. No settings merge (auto-discovery), no
  restart advice: the running server hot-loads it (fact 3.3). Job field `opencodePlugin`
  (`{ ok, target, skipped? | error? }`), rendered by `setupStatus.ts`; never fails the job.
- Host Shell: `PATCH /api/local-shell` accepts `opencodePlugin: true` beside `claudeHooks`;
  `localShellActions.installOpencodePlugin()` reuses the pusher over the local `/bin/sh` transport
  (my call: included; it is one route flag and one call).

### 4.4 Tests

- `test/opencodeAgentReplay.test.js` — the acceptance test: feeds every `kind: "event"` line of the
  fixture through the real asset's reducer with a fixed pane listing (`octest`→`/home/user/proj`,
  `octest2`→`/home/user/proj`, `octest3`→`/home/user/proj2`), a new reducer at each `plugin.setup`
  with a new pid, and asserts the `octest` marker trail by fixture line:
  18 `working/prompt`; 46 `ready/stop`; 60 `blocked/permission`; 61 `working/unblock`; 78 `ready/stop`;
  92 `blocked/permission`; 93 `working/unblock`; 97 `ready/stop`; 127 `blocked/question`;
  129 `working/unblock`; 142 `ready/stop`; 155 `blocked/question`; 156 `working/unblock`;
  160 `ready/stop`; 173 `ready/stop`; 187 `blocked/permission`; 188 `working/unblock`; 204 `ready/stop`;
  219 `blocked/permission`; 242 still `working` (shell `sh_…03f51` runs until 247); 248 `working/resume`;
  266 `ready/stop`; 280 `blocked/permission`; 298 `working/prompt` (the background gate); 303
  `working/resume`; 313 `ready/stop`; 343 `working/prompt` on both `octest` and `octest2`, `octest3`
  untouched (`ready/start` from the sweep); duplicates from 336 on change nothing; 416 `working/prompt`
  with no `session.created` (directory learned at 415); 426 `ready/stop`. No `execution.*` end ever
  leaves a marker `blocked`.
- Unit: `parsePanes` (tabs, odd names, non-opencode panes, the active-window/active-pane filter:
  a session with Claude in the active window and OpenCode in another is **not** an opencode
  session), `foldForPanes` precedence, the prefix rule, the `since` filter (a finished session
  older than the pane's `since` yields `ready/start`, a newer one its own state), the written
  epoch being the session's `ts` in seconds, child `blocked` rolling up above a working parent,
  sweep write/delete semantics with a fake `tmux` on PATH and a temp `HOME` including the
  content-equality guard (a marker rewritten by "the Claude hook" survives the delete), the
  singleton hand-over (second `setup` aborts the first core's subscription and timer, inherits
  marker memory; the first instance's late `cleanup` is a no-op), the asset loading under plain
  Node with a stub `ctx`.
- Unit: pusher script (no interpolation of the asset, skip path, idempotent rerun), `agentKindOf`,
  `sampleOf` with an `opencode` pane carrying `agent`, catalog pins (`TOOL_IDS`/`provisionTools`/
  `SETUP_TOOLS`), `NO_SERVER_RE` (stale socket = empty, refused/denied = unknown), FCM title by agent.
- e2e: setup with `opencode` ticked on the isolated box records `opencodePlugin.skipped` (no OpenCode
  there) and the job stays `done`; `PATCH /api/local-shell { opencodePlugin: true }` returns the
  pusher result.
- Live (before merge, per CLAUDE.md): rerun setup on a test box with OpenCode ticked, open an
  `opencode` TUI in its `web` session, drive a permission prompt and watch the chip/board/events.

## 5. Non-goals

- OSC 7501 status reports; Desktop/`service`-mode servers started outside tmux (nothing to
  attribute to — inert); project-level `.opencode/plugins`; npm-published plugin; MCP elicitation
  forms with the `"global"` sentinel; Codex/Antigravity (#3, #4); Android copy changes beyond what
  the `agent` field makes trivially possible (#5).

## 6. Calls made without you (check these)

1. Attribution by **directory → tmux pane path**, folding every OpenCode session in that directory
   onto every tmux session showing an opencode pane there (forced by the shared server).
2. **Events only, no hooks** in the reporter; background work from `shell.*` and child sessions.
3. `"global"` elicitation forms **ignored**.
4. **Host Shell included** (`opencodePlugin: true`).
5. The pane-command question from the first draft is moot: the npm package is a native binary and
   reports `opencode`.
6. `ready/start` is written by the **sweep** for a fresh TUI; markers are deleted by the sweep when
   the pane stops being opencode, and all at server shutdown.
7. The `opencode` catalog tool runs the official installer with `--no-modify-path` and owns the PATH
   line itself.

From the builder check (a reviewer read the document before you did):

8. The reporter looks only at the **active pane of the active window** per tmux session (what the
   probe reports), and deletes a marker only when its content equals what it last wrote — so a
   session shared between Claude and OpenCode windows is never clobbered.
9. The written epoch is the chosen OpenCode session's **last transition time in seconds**, and
   sessions finished before the pane's current TUI appeared (`since`) are excluded — so a relaunch
   reads `idle`, not `done`, and a recreated marker keeps an acknowledged turn acknowledged.
10. **Live upgrade is a requirement**: a setup rerun hands the singleton over to the new code
    without an OpenCode restart; validated live.
11. A **child session's block rolls up** to the parent with its cause.
