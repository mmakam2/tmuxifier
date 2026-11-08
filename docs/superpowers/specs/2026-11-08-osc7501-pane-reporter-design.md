# OSC 7501 pane reporter — design

Date: 2026-11-08. Status: draft for the builder check. Phase 0 spike recorded in
`test/fixtures/osc7501-pane-trace.jsonl` (+ `README-osc7501-pane-trace.md`, commit 8793ef3).

## 1. Intent

Tmuxifier shows per-session agent state (`working` / `blocked` / `done` / `idle`) from one
source only: marker files `~/.tmuxifier-agent/<session>` holding
`<session>:<state>:<epoch>:<cause>`, written today by the Claude Code hook
(`claudeAgentHooks.js`) and the OpenCode plugin (`opencodeAgentPlugin.js`). Every new agent has
so far cost a recording, a reporter written against that agent's own hook API, and a setup
phase. OSC 7501 ("Program Status", Mitchell Hashimoto's spec, revision 0.4) is a terminal
escape sequence in which a program itself reports `idle|working|blocked|done|error`, and
Codex, OpenCode, pi and others already emit it. This design adds **one box-side reporter**
that reads a pane's raw output through `tmux pipe-pane`, parses only OSC 7501, and writes the
same markers — so any agent that speaks the protocol gets Tmuxifier state with no
agent-specific code.

What the spike settled (all in the fixture README):

- `pipe-pane` receives a pane's raw bytes before tmux's parser, so the sequence arrives intact
  with either terminator. tmux itself drops it and never forwards it.
- tmux answers DA1 (`CSI c`) itself, so programs that use the spec's probe-then-DA1 detection
  (Claude Code 2.1.319, unforced pi) conclude "unsupported" and stay silent inside tmux. An
  in-pane responder cannot win that race. **Claude Code is therefore not coverable by this
  reporter; its hook stays.**
- Programs that report without probing are fully visible: OpenCode 2.2.6, pi with
  `PI_PROGRAM_STATUS=1`, Codex ≥ 0.163 (strings present in 0.167; live capture still owed —
  the test box needs a Codex sign-in).
- Codex (Node 26 `process.execve`) and pi run as the pane's own command: tmux reports
  `pane_current_command` = `codex` / `pi`.

## 2. Goals, non-goals, anti-goals

Goals
- Agent state for **Codex** and **pi** on a box with no code specific to either, and for any
  future agent that emits OSC 7501 unprobed, by adding one pane-command pattern.
- Same marker contract, same probe, same UI: `~/.tmuxifier-agent/<session>` =
  `<session>:<state>:<epoch>:<cause>`, states `working|blocked|ready`, causes from
  `AGENT_MARK_CAUSES` in `src/server/status.js`. The server infers nothing from pane text.
- Attach within seconds of an agent starting in any pane of any session; survive pane churn,
  agent restarts, tmux server restarts and reporter upgrades without operator action.
- Fail open everywhere: a dead reporter, a missing python3, a foreign `pipe-pane` on the
  pane, a tmux without `pane_pipe` — each costs coverage of that pane and nothing else.
- Setup pushes it like the hook: installer text interpolates nothing, bytes arrive on stdin,
  the box decides (`skipped-no-python3`, `skipped-no-tmux`), reruns are idempotent.
- Acceptance test = replay of the real recording through the real reducer.

Non-goals
- Covering Claude Code by OSC (impossible in tmux today), answering probes, patching tmux.
- Changing the marker format, `parseAgentMarks`, `deriveAgentState`, the seen watermark, the
  Android app or the MCP server (they render whatever `agent` kind the server sends).
- OpenCode by OSC on a box that has the OpenCode plugin (see §5.4). pi turns in the live
  validation (the test box has no pi model); Codex live capture before the user re-seeds it.
- Decoding or shipping `msg`/`title`. Only `state`, `id`, `kind`, `app` are read.

Anti-goals (would make this a failure even if it "works")
- Slowing or blocking a pane. `pipe-pane` is one-way into our process; tmux buffers if we
  stall; the reporter never writes to the pane (no `-I`).
- Writing anything into the operator's tmux config, shell config beyond one tagged line, or
  an agent's own settings. A pane that already has a pipe (`#{pane_pipe}` = 1 and not ours) is
  never touched.
- Shipping untrusted bytes to the server. The reporter writes only the closed marker
  vocabulary; the probe's `parseAgentMarks` allowlist stays the chokepoint.
- A second writer fighting the Claude hook or the OpenCode plugin over one session's marker.

## 3. Constraints

- Box-side language: **python3** (already a setup dependency for the voice link; the parser
  needs bytes, not lines, which POSIX sh cannot do). `skipped-no-python3` when absent.
- tmux ≥ 2.6 for `#{pane_pipe}` and `pipe-pane -t %id` (fleet: 3.2a–3.6). Pane ids are
  exact targets by construction; session names are resolved through `tmux display -p -t %id`.
- The status probe (`PROBE_REMOTE`, `status.js`) runs every `statusPollMs` (default 30 s)
  under the box's non-interactive shell with a bare PATH, stderr silenced, stdout parsed by
  allowlisting parsers. Anything added to it must be static text, silent, and `|| true`.
- Marker files are read by the probe as `[ -f ]` entries of `~/.tmuxifier-agent/*`, capped at
  200 bytes; sub-directories are invisible to it (the hook uses `busy/` and `blocked/`).
- `agentKindOf(paneCmd)` in `healthHistory.js` is the one place a pane command becomes an
  agent kind (`present`, `agent` on samples and events); labels live in
  `src/web/agentState.ts` `AGENT_LABEL`, `src/server/fcmPush.js` `AGENT_LABEL`, type
  `AgentKind` in `src/web/api.ts`.
- Box-side snippets run under the box's login shell (zsh); no word-splitting assumptions.
- Public repo: no real hostnames/IPs in the asset, tests or docs.

## 4. Shape

```
status probe (every 30 s)        tmux server (box)                 ~/.tmuxifier-agent/
  └─ python3 reporter.py sweep ──┐                                   <session>  ◄──┐
       one pass + ensure loop    │ list-panes -a                                    │
                                 ▼                                                  │
  reporter.py loop (1/box, 2 s) ── pipe-pane -t %N 'exec python3 reporter.py listen %N'
       attach / detach by pane command        │ raw pane bytes                    │
                                              ▼                                     │
                                   reporter.py listen %N  ── OSC 7501 → fold → marker ┘
```

One asset, `src/server/assets/tmuxifier-osc-reporter.py`, three roles selected by argv:

- `listen <pane-id>` — one per agent pane, the `pipe-pane` command. Parses OSC 7501 from
  stdin, folds records, writes the pane's session marker on fold changes.
- `loop` — one per box, resident, attaches/detaches listeners every 2 s.
- `sweep` — called by the status probe: one attach pass, then makes sure a `loop` of the
  current asset version is running (starts or replaces it).

Installed under `~/.tmuxifier-osc/` (`reporter.py`, `loop.lock`, `panes/`), by a new
always-on setup phase and by the Host Shell's existing hooks knob.

## 5. Decisions

### 5.1 Attach by pane command, from a resident loop (not tmux hooks, not pane creation)

tmux has no hook for "the pane's command changed", and attaching at pane creation would put a
process and an exclusive pipe on every pane the operator opens. So: a per-box `loop` lists
`#{pane_id} #{pane_pipe} #{pane_current_command} #{session_name}` for all panes every 2 s and

- attaches `listen` to a pane with `pane_pipe = 0` whose command matches the **OSC agent
  allowlist** (§5.4);
- detaches (`pipe-pane -t %N` with no command) a pane we attached whose command no longer
  matches — the listener sees EOF and removes its marker if it still holds what it wrote;
- never touches a pane with `pane_pipe = 1` that is not in our registry (the operator's pipe);
- clears a registry entry whose pane is gone or whose pipe is gone (listener died) and
  re-attaches on the next pass if the command still matches.

Attach uses `pipe-pane -o` (open only if no pipe exists) so a race with an operator's or a
sibling's pipe can never clobber it.

**Registry** (`~/.tmuxifier-osc/panes/<N>` for pane `%N`, one small JSON file, tmp + rename):
`{pid, sha, session, records, lastWritten, handover}`. `loop` creates it at attach time
(`pid` absent, `sha` of the asset); `listen` rewrites it with its own pid and, on every
fold change, its current `records` and the marker content it last wrote (`lastWritten`), and
the session name it resolved for that write. `loop` treats an entry as live when its pid is
alive (`kill(pid, 0)`) and the pane exists with `pane_pipe = 1`; anything else is stale and
removed. A tmux server restart kills every listener (they are its children) and reuses pane
ids, so pid liveness — never a blanket wipe — decides staleness. The entry is the shared state
behind §5.2's handover and §5.3's per-session fold.

A "command no longer matches" detach needs **three consecutive passes** (≈ 6 s) seeing a
non-matching command: an agent that hands its tty to `$EDITOR` or `less` for a moment must
not be read as exited (which would also push a false `agent-done`). A bare `clear` from the
program (it exited) is immediate and does not wait for the loop.

Latency: ≤ 2 s after the agent process replaces the shell. An agent's startup `idle` may be
missed (harmless, §5.3). The ≤ 30 s probe interval only bounds how fast a dead loop is
restarted.

### 5.2 Lifecycle of the loop

- Single instance via `flock` on `~/.tmuxifier-osc/loop.lock`; the lock file carries the
  pid and the sha256 of the asset bytes it runs.
- Started by `sweep` with `tmux run-shell -b 'exec python3 ~/.tmuxifier-osc/reporter.py loop'`
  so it is a child of the tmux server: it dies with the server (nothing to watch) and the next
  probe restarts it once tmux is back. `sweep` first tries the lock; if it is held by a loop
  whose recorded sha differs from the file on disk (setup rerun), it SIGTERMs that pid and
  starts a new one. The new loop re-pipes every registered pane so running listeners pick
  up the new code too: it first sets `handover: true` in the pane's registry entry, then
  detaches (the old listener sees EOF, finds the flag, **keeps the marker**, leaves its
  `records`/`lastWritten` in the entry and exits), then attaches the new listener, which
  **seeds its records and `lastWritten` from the entry** and so continues the fold instead of
  treating the next report as a first observation. A mid-turn upgrade therefore loses nothing
  but the bytes in the one `pipe-pane` round-trip gap. The same seeding applies whenever a
  listener starts on a pane whose entry still exists (a listener that died mid-run).
- The loop exits on its own when `tmux list-panes` says the server is gone (the same two
  wordings `localTmuxScope`/`NO_SERVER_RE` accept) or after an hour with no agent pane and no
  tmux session (idle box: the probe revives it when needed).
- Everything is best-effort: a failing `tmux` call is logged nowhere and retried next pass.

### 5.3 From OSC 7501 records to a marker (the fold)

Per pane, `listen` keeps `records: id → {state, kind}` (root = `""`), applying each complete
sequence per spec 0.4: body split on `:`, `key=value` pairs, `state` required and in
`idle|working|done|blocked|error|clear` (else the report is ignored), `id` a `/`-path of
`[A-Za-z0-9_.+-]{1,32}` segments (invalid id → report ignored), `kind` in
`permission|question|auth` (else absent), `app` kept for nothing but a debug line, `msg`/
`title`/`progress`/unknown keys ignored. `clear` with an id removes that record and every
record below it; bare `clear` removes all. A probe body `?` is ignored. Sequences are
recognised across chunk boundaries: the tail of the buffer is kept while it could still be an
incomplete `ESC ] 7501 ;…`, capped at 4096 bytes (the spec's maximum) and dropped past that.
Everything that is not OSC 7501 is discarded as it is read.

Pane fold = `blocked` if any record is blocked (kind of the first blocked record in
insertion order), else `working` if any record is working, else `idle` (covers no records,
`idle`, `done`, `error`).

**Session fold.** One marker per tmux session, but a session may hold several OSC agent panes
(splits, windows). On every pane-fold change the listener resolves its session
(`tmux display -p -t %N '#{session_name}'`, re-resolved each time because panes move),
writes its own records to its registry entry, then folds **across every live registry entry
whose `session` is the same** (blocked > working > idle, same rule) and writes the marker
only when that session fold differs from what the marker file currently says. Pane A
finishing while pane B still works keeps `working`; the last pane to go idle writes
`ready:stop`. Reading a handful of small JSON files per change is the whole cost; two
listeners writing at once both derive from the same entries, and tmp + rename makes the
last write a consistent one. Marker writes happen only when the session fold changes:

| from → to | marker |
|---|---|
| idle/unknown → working | `working:prompt` |
| blocked → working | `working:unblock` |
| any → blocked | `blocked:permission` / `blocked:question` / `blocked:elicitation` (kind `auth`; absent kind → `permission`) |
| working → idle | `ready:stop` |
| blocked → idle | `ready:stop` (a reject ends the turn like a success, per the recording) |
| unknown → idle (first observation) | existing marker `working`/`blocked` → `ready:stop` (the turn ended unobserved); existing `ready` → untouched; no marker → `ready:start` |
| bare `clear` (the program exited) | this pane's records drop; if no other live entry for the session remains, the marker is removed **if its content is what this reporter last wrote**; otherwise the session fold is rewritten |
| EOF on stdin | with `handover` set in the entry: keep marker and entry, exit. Otherwise (pane gone, detached after three non-matching passes): the bare-`clear` rule, then delete the entry and exit |

`ready:start` is what `deriveAgentState` shows as `idle` with no notification; `ready:stop`
is `done` until seen. `done`/`error` get no distinct marker: the vocabulary has none, and
"finished, look at it" is the right reading.

### 5.4 Which panes: the OSC agent allowlist and precedence over hook/plugin

The loop attaches only to panes whose `pane_current_command` matches, exactly like
`agentKindOf`: `^codex(-|$)`, `^pi(-|$)`, and `^opencode(-|$)` **only if the OpenCode plugin
is not installed on the box** (`${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins/
tmuxifier-agent.js` absent — the box decides, every pass). `claude` is never matched: its hook
is the writer and it emits nothing anyway. This is the whole precedence rule: one writer per
agent kind, decided by which reporter is installed, never by racing on the marker file. The
pattern list is a constant at the top of the asset and mirrored by `agentKindOf` (pinned by a
test that both know the same OSC kinds).

Known gap, documented: on a box whose Node predates `process.execve` (Node < 22.15) Codex
runs under its `node` wrapper and tmux reports `node`; neither `agentKindOf` nor the loop
matches it, so that box has no Codex state until its Node is upgraded (the `upgrade` tool;
the catalog never upgrades an existing Node on its own).

Known cost, accepted: OpenCode's root record aggregates every session of the user's shared
`opencode serve`, so on a plugin-less box a pending permission in another TUI reads as
`blocked` in this pane (the TUI itself shows "N sessions need input"). The plugin remains the
better OpenCode reporter; OSC is the fallback.

A session with a Claude pane and a Codex pane has two writers for one file. Today's hook and
plugin already share that limitation (one marker per session); documented, not solved.

### 5.5 Server side

- `agentKindOf`: add `codex` and `pi`. `AgentKind`, `AGENT_LABEL` (web and push): `codex` →
  "Codex", `pi` → "pi". Push text becomes "Codex needs you" / "pi needs you".
- `status.js` `PROBE_REMOTE`: a static fragment before the tmux listing,
  `if [ -f "$HOME/.tmuxifier-osc/reporter.py" ] && command -v python3 >/dev/null 2>&1; then
  python3 "$HOME/.tmuxifier-osc/reporter.py" sweep >/dev/null 2>&1 || true; fi;`. No box
  field reaches it; a box without the asset is unchanged. `sweep` must finish in well under a
  second (one `list-panes`, at most a few `pipe-pane`s, a lock check).
- New `src/server/oscReporter.js`: `buildOscReporterInstallScript()` + `createOscReporterPusher({
  runStdin, readAsset })`, structural twin of `opencodeAgentPlugin.js`. The installer: skip when
  `command -v python3` or `command -v tmux` fails (`OSCREPORTER: skipped-no-python3` /
  `skipped-no-tmux`); `mkdir -p ~/.tmuxifier-osc/panes`; write stdin to `reporter.py.$$.tmp`,
  `mv -f` into place, `chmod 644`; one tagged rc line per rc file, `binPathBlock` style
  (`export PI_PROGRAM_STATUS=1 # tmuxifier-osc-pi`, in `.profile`/`.bashrc`/`.zshrc` when
  present) so pi reports inside tmux; then `python3 reporter.py sweep` once so an already-open
  agent pane is covered before setup finishes (best-effort, ignored failure);
  `OSCREPORTER: applied`.
- `setupManager.js`: phase `osc-reporter` after `opencode-plugin`, before `script`; always on
  when the pusher is wired (no option knob: it is agent-agnostic and touches nothing agent-owned);
  result recorded as `j.oscReporter`, surfaced by `GET /api/setup/:id` like `opencodePlugin`;
  never fails the job. Order matters: the rc line lands before `ensureSession`.
- Host Shell: `localShellActions.installOscReporter()` wraps the pusher over the local
  transport; `PATCH /api/local-shell` runs it when `claudeHooks === true` (it rides that knob
  like the voice link does). `localAgent.js` (the host's probe stand-in) runs the same `sweep`
  command when the file exists, so the host's `=local` session is covered too.
- Web: setup-job viewer shows the phase result row like the OpenCode one; no new options.

### 5.6 Tests (TDD, real code)

- `test/helpers/osc7501Replay.py`: imports the asset as a module and replays either a fixture
  (one reducer per `pane`, marker trail per fixture line as JSONL on stdout) or synthetic
  byte chunks from argv/stdin; `test/osc7501Reporter.test.js` runs it over synthetic cases:
  BEL and ST terminators, a sequence split across two chunks, oversize/malformed/invalid-id
  reports ignored, `kind` mapping incl. `auth` → `elicitation`, hierarchical `clear`, bare
  `clear`, first-observation rules against an existing marker, `done`/`error` → `ready:stop`.
- `test/osc7501Replay.test.js` (**acceptance**): the recording, one reducer per `pane`, each
  pane its own session (as recorded). Expected trail by fixture line: pane `opencode` —
  41 `ready/start`, 43 `working/prompt` (the root record; the child at 44 changes nothing),
  64 `blocked/permission`, unchanged through 805 (the aggregation caveat, pinned: the root
  stays blocked while the own session works at 109-778), 806 removed; `pi` — 853
  `ready/start`; `piplain` and `claude` — never a marker; `opencode2` — 963 `ready/start`,
  980 `working/prompt`, 1013 `ready/stop` (1012's `clear:id` alone changes nothing: the root
  is still `working`), 1037 `working/prompt`, 1108 `ready/stop`, 1135 `working/prompt`,
  1448 `ready/stop`, 1477 removed. Plus a two-panes-one-session replay built from the same
  recording (panes `opencode` and `opencode2` mapped to one session): the session fold is
  `blocked` until 806 regardless of `opencode2`'s turns, then follows `opencode2`.
- `test/osc7501Sweep.test.js`: a stub `tmux` on PATH (records argv, serves canned
  `list-panes` output and `display` answers) in a temp HOME; `sweep --once`: attaches only
  allowlisted no-pipe panes, skips a foreign pipe, skips `opencode` when the plugin file
  exists, detaches a registered pane whose command changed, cleans a stale registry entry.
  `listen`: chunks piped to a real `listen` process produce the marker file (tmp+rename,
  content) and a registry entry; EOF removes both only when the marker is unchanged and no
  other live entry shares the session; EOF with `handover` set keeps both; a second `listen`
  on the same pane id seeds from the entry (no `ready/start` on its first idle). Detach
  needs three non-matching passes (a one-pass `less` flip does not detach).
- `test/oscReporter.test.js`: installer script runs against a fixture HOME with a stub
  `python3`/`tmux` on PATH: skip outputs, file written atomically, exactly one tagged rc line
  per rc file after two runs.
- `test/healthHistory.test.js`: `agentKindOf('codex')`, `('pi')`, `('pi-something')`,
  `('pip')` → null; pins that the asset's pattern list and `agentKindOf` agree on the OSC
  kinds. `test/statusProbe.test.js` (or the existing status tests): the sweep fragment is
  present, static, silenced.
- Setup manager phase test, local-shell route test, fcmPush label test, web `AGENT_LABEL` test.

### 5.7 Live validation (before merge, per CLAUDE.md)

On the test box: setup rerun shows `osc-reporter: applied`; `~/.tmuxifier-osc/reporter.py`
present, loop running under tmux; `PI_PROGRAM_STATUS=1 pi` in a pane → chip `idle` within a
poll; remove the OpenCode plugin file on the box (it is the OSC fallback's trigger), start
`opencode` → idle → prompt → working → bash `ask` → blocked (agent-blocked event, push text
"OpenCode needs you") → allow → working → done → seen → idle; `/exit` → marker gone,
agent-done; restore the plugin by a setup rerun. Codex: once the user has signed Codex in on the
box, the same walk with `app=codex`, and append its stream to the fixture. Verify a hashed
asset end-to-end after the restart.

## 6. Left to the builder

- Exact python structure (one file, ~300 lines, stdlib only; `os.read` on fd 0, `os.replace`
  for markers, `fcntl.flock`); debug logging to `~/.tmuxifier-osc/log` only when
  `TMUXIFIER_OSC_DEBUG=1`.
- How `sweep` decides "loop alive": `flock(LOCK_EX|LOCK_NB)` try on the lock file; a pid and
  sha line inside it for the replace path. The loop always exits 0 with stdout/stderr on
  `/dev/null` (`run-shell -b` would otherwise show output or a non-zero exit in the operator's
  pane).
- Registry JSON shape and size cap (records are bounded by the spec's 256-record maximum).
- Idle-exit timer value and the two no-server wordings (copy from `localAgent.js`).
- Docs: `docs/boxes-and-setup.md` (new step + phase order line), `docs/fleet-and-health.md`
  (third source of truth, which agents, the OpenCode aggregation caveat, Claude excluded and
  why), `README.md` one line, `CLAUDE.md`/`AGENTS.md` map entries (`oscReporter.js`, the asset,
  the probe fragment, `agentKindOf` kinds).
- Memory note after shipping.
