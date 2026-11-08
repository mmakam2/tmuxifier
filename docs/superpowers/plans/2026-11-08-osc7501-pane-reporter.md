# OSC 7501 Pane Reporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A box-side reporter that turns OSC 7501 "Program Status" sequences in tmux pane output into Tmuxifier's existing agent-state markers, covering Codex, pi and any future agent that emits the protocol unprobed, pushed by setup like the Claude hook.

**Architecture:** One python3 asset (`tmuxifier-osc-reporter.py`) with three roles: `listen %N` is a `pipe-pane` reader that parses OSC 7501 from one pane's raw bytes, folds the records, and writes `~/.tmuxifier-agent/<session>`; `loop` is one resident process per box (a tmux `run-shell -b` child) that attaches/detaches listeners by `pane_current_command` every 2 s; `sweep` is what the status probe calls every poll to do one attach pass and keep a `loop` of the current asset version alive. A per-pane JSON registry entry under `~/.tmuxifier-osc/panes/` carries each listener's records and last marker so upgrades hand over without losing state and several panes of one session fold into one marker. Server-side: a pusher + always-on setup phase, a static sweep fragment in the status probe, `codex`/`pi` added to `agentKindOf` and the labels.

**Tech Stack:** python3 stdlib on the box (no deps), tmux ≥ 2.6 (`pane_pipe`, `pipe-pane -o`), Node ESM server, vitest (tests spawn the real asset with `python3` and a stub `tmux` on PATH).

**Spec:** `docs/superpowers/specs/2026-11-08-osc7501-pane-reporter-design.md` (read it first; §5 holds every decision this plan implements). Recording: `test/fixtures/osc7501-pane-trace.jsonl` + `test/fixtures/README-osc7501-pane-trace.md`.

## Global Constraints

- Marker contract unchanged: file `~/.tmuxifier-agent/<safe-session>` (safe = `re.sub(r'[^A-Za-z0-9._-]', '_', session)`), content `<session>:<state>:<epoch>:<cause>\n`, states `working|blocked|ready`, causes only `prompt|resume|stop|start|permission|question|elicitation|unblock` (`AGENT_MARK_CAUSES` in `src/server/status.js`). Written tmp + `os.replace`, mode `0o644`. Nothing server-side infers state from pane text.
- The asset interpolates nothing from the server; the installer script text interpolates nothing; bytes arrive on stdin; the box decides (`skipped-no-python3`, `skipped-no-tmux`); reruns idempotent.
- The reporter never writes to the pane (no `pipe-pane -I`), never blocks on anything but its own stdin, never raises out of its main loops (fail open), writes nothing to stdout/stderr except under `TMUXIFIER_OSC_DEBUG=1` (then appends to `~/.tmuxifier-osc/log`).
- Spec 0.4 limits: a whole sequence ≤ 4096 bytes; `id` = `/`-separated segments of `[A-Za-z0-9_.+-]{1,32}`, ≤ 8 segments, ≤ 128 bytes; `app` `[A-Za-z0-9_.+-]{1,32}`; states `idle|working|done|blocked|error|clear`; kinds `permission|question|auth`; values `[A-Za-z0-9_.,+/=-]`.
- Allowlist of OSC agents, in the asset as `OSC_AGENTS = {'codex': r'^codex(-|$)', 'pi': r'^pi(-|$)', 'opencode': r'^opencode(-|$)'}`; `opencode` applies only when `${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins/tmuxifier-agent.js` is absent; `claude` never.
- Timings: loop interval 2.0 s; detach after 3 consecutive non-matching passes; loop idle-exit after 3600 s with no agent pane and no session; tmux calls time out after 5 s.
- Every box-side path derives from `$HOME` at runtime; tests set `HOME` to a temp dir and put a stub `tmux` (and where needed `python3` from the real PATH) first on `PATH`.
- Public repo: no real hostnames/IPs anywhere; fixtures already scrubbed.
- Conventional commits; TDD; commit after each task.

## Review Focus

1. **Another writer owns the marker.** The Claude hook rewrites `~/.tmuxifier-agent/web` while a Codex listener in the same session is active; at EOF the listener must not delete a marker whose content is not its own `lastWritten`. Test in Task 3.
2. **Session renamed mid-run.** `tmux rename-session` while the agent works: the next write must land under the new name (session is re-resolved per write), nothing crashes, the old file is left (stale, inert to the probe). Test in Task 3.
3. **Corrupt or foreign registry entry.** `panes/5` holding junk JSON, or an entry whose pid is alive but belongs to an unrelated process after a pid wrap: the listener treats unreadable JSON as "no entry" and starts fresh; the loop treats an entry whose pane has `pane_pipe = 0` as stale regardless of pid. Tests in Tasks 3 and 4.
4. **Session names with spaces, pane commands with trailing dashes.** `list-panes` rows are split on `\t` with the session name LAST (`maxsplit=3`), so `my project` survives; `pi-something` matches `^pi(-|$)` and `pip` does not. Test in Task 4 and Task 6.
5. **No tmux, or tmux without a server, at sweep time.** `sweep` from the probe must exit 0 silently when `tmux` is missing or prints `no server running`; the probe's reachability classifier reads stderr. Test in Task 4 and Task 6 (the fragment is `|| true` and fully redirected).

---

### Task 1: Asset core — OSC 7501 extraction, report parsing, records and the pane fold

**Files:**
- Create: `src/server/assets/tmuxifier-osc-reporter.py`
- Create: `test/helpers/osc7501Replay.py`
- Test: `test/osc7501Reporter.test.js`

**Interfaces:**
- Produces (python, module-level in the asset, importable with no side effects; `main()` only under `if __name__ == '__main__'`):
  - `extract(buf: bytes) -> tuple[list[bytes], bytes]` — returns every complete OSC 7501 body (bytes between `ESC ] 7501 ;` and `BEL` or `ESC \`) in order, and the unconsumed tail to carry to the next read (only a trailing partial `ESC`/`ESC ]7501;…` prefix is kept; a partial longer than `TAIL_CAP = 4096` bytes is dropped and the tail becomes `b''`).
  - `parse_report(body: bytes) -> dict | None` — `None` for the probe (`?`), for a missing/unknown `state`, for an invalid `id`, or for a body with any byte outside the spec's value set after the key; else `{'state': str, 'id': str, 'kind': str|None, 'app': str|None}` with `id = ''` for the root; pairs split on `:`, `key=value`, whitespace stripped, malformed pairs skipped, repeated keys last-wins, unknown kind → `None`, unknown keys ignored.
  - `class Records` — `apply(report: dict) -> None` (replace the record at `id` with `{'state','kind'}`; `state == 'clear'` with `id == ''` empties everything, with an id removes that id and every id starting with `id + '/'`), `fold() -> tuple[str, str|None]` (`('blocked', kind)` for the first blocked record in insertion order, else `('working', None)`, else `('idle', None)`), `to_json() -> dict`, `classmethod from_json(d) -> Records` (ignores malformed input → empty).
  - `KIND_CAUSE = {'permission': 'permission', 'question': 'question', 'auth': 'elicitation', None: 'permission'}`.
  - `next_action(marker: tuple[str, str] | None, new: tuple[str, str|None]) -> tuple | None` — the spec §5.3 table, with the **marker file as the only memory**: `marker` is `(state, cause)` parsed from the session's current marker content (`None` = no file). No listener keeps a "previous fold" of its own, so several panes of one session can never disagree about what came before, and a handed-over or restarted listener needs no seed beyond its records. `CAUSE_KIND = {'permission': 'permission', 'question': 'question', 'elicitation': 'auth'}`. Returns `('write', state, cause)` or `None`:
    - `new[0] == 'working'`: marker `blocked` → `('write','working','unblock')`; marker `working` → `None`; else (`ready` or none) → `('write','working','prompt')`.
    - `new[0] == 'blocked'`: marker `blocked` with `CAUSE_KIND[cause] == kind` (kind `None` reads as `permission`) → `None`; else `('write','blocked', KIND_CAUSE[kind])`.
    - `new[0] == 'idle'`: marker `working`/`blocked` → `('write','ready','stop')`; marker `ready` → `None`; no marker → `('write','ready','start')`.
    Removal (bare `clear`, EOF) is decided by the caller, not here.
  - `session_fold(folds: list[tuple[str, str|None]]) -> tuple[str, str|None]` — blocked (first blocked's kind) > working > idle over the given pane folds.
- Harness `test/helpers/osc7501Replay.py` (imports the asset by path with `importlib`): `python3 osc7501Replay.py fixture <jsonl> [pane=session ...]` prints one JSON line per fixture line on which any marker changed: `{"line": n, "session": s, "marker": "state/cause"}` or `"marker": null` for a removal; one `Records` per `pane`, session = the mapping or the pane name, markers held in a dict (no files), session fold across panes mapped to the same session, the bare `clear`/EOF removal rule as in the spec (remove when no other pane of that session has records and the marker is what this reporter last wrote). Ends with one line `{"lines": <count>}`. `python3 osc7501Replay.py chunks [--marker state/cause]` reads base64 chunk lines from stdin for one pane named `p` in session `s` (optionally with a pre-existing marker) and prints the same stream.

- [ ] **Step 1: Write the failing tests** in `test/osc7501Reporter.test.js` (vitest, `execFileSync('python3', [HELPER, 'chunks'], { input })`, helper = `test/helpers/osc7501Replay.py`): one `it` per case, assertions on the parsed JSON lines:
  - ST and BEL terminators both yield a report: chunks `ESC]7501;state=working:app=x ESC\` → `{line:1, marker:'working/prompt'}`; `ESC]7501;state=idle BEL` → `ready/stop` on line 2.
  - a sequence split across two chunks (`…;state=bloc` | `ked:kind=question ESC\`) → one `blocked/question` on line 2, nothing on line 1.
  - a partial `ESC]7501;` followed by 5000 non-terminated bytes then a valid `state=working` sequence → only `working/prompt`, on the line that carries the valid one.
  - `state=blocked:kind=auth` → `blocked/elicitation`; `state=blocked` without kind → `blocked/permission`; `kind=weird` → `blocked/permission`.
  - `state=working:id=a/b` then `state=blocked:id=a/b/c:kind=permission` then `state=clear:id=a` → trail `working/prompt`, `blocked/permission`, `ready/stop`.
  - bare `state=clear` after `working` → `marker: null`.
  - `state=done` and `state=error` after `working` → `ready/stop`.
  - `state=idle` as the very first report with no marker → `ready/start`; the same with a pre-existing marker given to the harness via `--marker working/prompt` → `ready/stop`; via `--marker ready/stop` → no line; `state=blocked:kind=question` over `--marker blocked/permission` → `blocked/question`; over `--marker blocked/question` → no line.
  - a probe `?`, `state=bogus`, `id=bad id`, `state=working:state=idle` (last wins → idle → ready/start) behave as the interface says.
  - repeated `state=working` reports emit no second line.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/osc7501Reporter.test.js`
Expected: FAIL (helper and asset missing).

- [ ] **Step 3: Write the asset core and the harness**

`src/server/assets/tmuxifier-osc-reporter.py`: header comment in the house style of `tmuxifier-agent-hook.sh` (what it is, the three roles, the spike facts: tmux drops OSC 7501 and answers DA1 itself so probing agents stay silent — Claude is the hook's; the aggregation caveat for OpenCode's root record; fail-open posture), constants from Global Constraints, then `extract`, `parse_report`, `Records`, `KIND_CAUSE`, `next_action`, `session_fold`. Leave `main()` as a stub dispatching on `sys.argv[1]` that returns 0 (Tasks 3 and 4 fill the roles). `test/helpers/osc7501Replay.py` as specified in Interfaces (accept `--marker <state>` for the seeded marker in `chunks` mode).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/osc7501Reporter.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/assets/tmuxifier-osc-reporter.py test/helpers/osc7501Replay.py test/osc7501Reporter.test.js
git commit -m "feat(osc7501): reporter asset core — extraction, records, pane fold"
```

---

### Task 2: Acceptance replay over the recording

**Files:**
- Test: `test/osc7501Replay.test.js`
- Modify (only if the replay disagrees with the spec table): `src/server/assets/tmuxifier-osc-reporter.py`

**Interfaces:**
- Consumes: the harness `fixture` mode from Task 1.

- [ ] **Step 1: Write the acceptance test** `test/osc7501Replay.test.js`: run the harness over `test/fixtures/osc7501-pane-trace.jsonl` (default mapping: each pane its own session) and assert the full trail equals exactly:
  - `opencode`: 41 `ready/start`, 43 `working/prompt`, 64 `blocked/permission`, 806 `null` — and nothing else for that session (pins the aggregation caveat: lines 109–778 change nothing).
  - `pi`: 853 `ready/start` only. `piplain`, `claude`: no lines.
  - `opencode2`: 963 `ready/start`, 980 `working/prompt`, 1013 `ready/stop`, 1037 `working/prompt`, 1108 `ready/stop`, 1135 `working/prompt`, 1448 `ready/stop`, 1477 `null`.
  Second `it`: mapping `opencode=shared opencode2=shared` → trail for `shared`: 41 `ready/start`, 43 `working/prompt`, 64 `blocked/permission`, then **nothing until 806** (opencode2's 963–1477 happen after 806 chronologically in the file order, so: 806 → the other pane `opencode2` has no records yet → `null`), 963 `ready/start`, 980 `working/prompt`, 1013 `ready/stop`, 1037 `working/prompt`, 1108 `ready/stop`, 1135 `working/prompt`, 1448 `ready/stop`, 1477 `null`. Also assert the harness reports the fixture has 1490 lines.

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/osc7501Replay.test.js` (fails on the exact trail until the core is right; if it passes immediately, confirm by temporarily flipping one expected line).

- [ ] **Step 3: Fix the core until the trail matches the spec table** (no test edits except an evident fixture-line miscount, which must be re-derived from the README).

- [ ] **Step 4: Run both reporter tests** — `npx vitest run test/osc7501Reporter.test.js test/osc7501Replay.test.js` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "test(osc7501): replay the recorded pane trace through the reporter core"`.

---

### Task 3: Asset `listen` role — stdin loop, registry entry, session fold, marker I/O, handover

**Files:**
- Modify: `src/server/assets/tmuxifier-osc-reporter.py`
- Test: `test/osc7501Listen.test.js`
- Create: `test/helpers/stubTmux.js` (writes a `tmux` sh script into a dir; behaviour driven by env/files, see below)

**Interfaces:**
- Produces (python): `run_listen(pane_id: str, *, home: str, stdin_fd: int = 0) -> int` and `main()` dispatch `listen %N`. Helpers: `entry_path(home, pane_id)` = `~/.tmuxifier-osc/panes/<N>` (digits after `%`), `read_entry(path) -> dict` (junk → `{}`), `write_entry(path, dict)` (tmp + replace), `resolve_session(pane_id) -> str | None` (`tmux display-message -p -t %N '#{session_name}'`, 5 s timeout, `None` on failure), `marker_path(home, session)`, `read_marker_state(path) -> str | None` (second colon field of the first line, or `None`), `write_marker(path, session, state, cause)`, `live_entries(home, session, exclude_pane) -> list[dict]` (entries whose `session` matches and whose `pid` is alive via `os.kill(pid, 0)`).
- Registry entry JSON: `{"pid": int|None, "sha": str, "session": str|None, "records": dict, "lastWritten": str|None, "handover": bool, "attachedAt": float}`.
- Listen algorithm: on start, read the entry; seed `Records.from_json(entry.records)` and `last_written = entry.lastWritten`; write the entry back with own `pid`, `handover: False`. Loop `os.read(stdin_fd, 65536)`: on data, `extract` with the carried tail, `parse_report` each, `Records.apply`; if the pane fold changed, resolve the session, compute `new = session_fold([own] + [e.records fold for live sibling entries])`, `action = next_action(read_marker(...), new)` where `read_marker` returns `(state, cause)` from the file's second and fourth colon fields or `None`; on `write` → `write_marker` and record `lastWritten`, persist the entry (`records`, `session`, `lastWritten`). On a bare `clear` (own records emptied by a root clear): if no live sibling entry for the session → remove the marker if its content `== lastWritten`, else rewrite the session fold. On EOF: re-read the entry; if `handover` is true → persist records and exit 0 leaving marker and entry; else apply the bare-clear rule, delete the entry, exit 0. Any exception inside the loop is swallowed (debug-logged) and the loop continues; exceptions at EOF handling still exit 0.
- Stub tmux helper (`test/helpers/stubTmux.js`): `makeStubTmux(dir, { sessionOf = {}, panes = [] })` writes `dir/tmux` (sh) that: appends its argv as one line to `$STUB_TMUX_LOG`; for `display-message -p -t %N <fmt>` prints the session mapped in `$STUB_TMUX_SESSIONS` (a file `N=name` per line, re-read each call so a test can rename); for `list-panes -a -F <fmt>` prints the file `$STUB_TMUX_PANES` verbatim (tests write it in the asset's expected `\t` format); for `pipe-pane …` and `run-shell …` prints nothing and exits 0; for `kill-server`/unknown prints `no server running on /tmp/x` to stderr and exits 1 when `$STUB_TMUX_NOSERVER=1`.

- [ ] **Step 1: Write failing tests** `test/osc7501Listen.test.js` — each test: temp HOME, stub tmux, `spawn('python3', [ASSET, 'listen', '%5'], { env: { HOME, PATH: stubDir + ':' + process.env.PATH, STUB_* } })`, write chunks to stdin, poll (≤ 2 s) for the marker file:
  - `working` report → `~/.tmuxifier-agent/web` content matches `/^web:working:\d+:prompt\n$/`, file mode `0644`, and `~/.tmuxifier-osc/panes/5` JSON has `pid` = the child pid, `session: 'web'`, `lastWritten` = the file content.
  - then `idle` → `web:ready:…:stop`; then stdin end (no handover) → marker file gone, entry gone, exit code 0.
  - EOF when the marker was rewritten by someone else (test overwrites the file with `web:working:1:prompt` first) → file **kept**, entry gone.
  - entry pre-seeded with `handover: true` and `records` of a working root, marker file `web:working:1:prompt` (what the predecessor wrote); first report `idle` → `web:ready:…:stop` (not `start`); then set `handover: true` in the entry file and end stdin → marker kept, entry kept with the pid of the exited process.
  - sibling fold: pre-create `panes/7` with `pid` = `process.pid` (alive), `session: 'web'`, `records` = blocked root; our pane reports `working` → marker says `blocked` (`web:blocked:…:permission`); our pane goes `idle` → still blocked, no `ready`.
  - rename: `STUB_TMUX_SESSIONS` maps `5=web`; after the first write, change it to `5=web2`; next fold change writes `~/.tmuxifier-agent/web2` and leaves `web`.
  - junk entry (`panes/5` = `not json`) → first `idle` writes `ready/start`, no crash.
  - a session name with a space `my proj` → marker file `my_proj` whose first field is `my proj`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/osc7501Listen.test.js` → FAIL (listen not implemented).

- [ ] **Step 3: Implement `run_listen` and the helpers** per Interfaces (`fcntl` not needed here; `subprocess.run(['tmux', ...], timeout=5, capture_output=True)` for resolution; debug log only under `TMUXIFIER_OSC_DEBUG`).

- [ ] **Step 4: Run** — `npx vitest run test/osc7501Listen.test.js test/osc7501Reporter.test.js test/osc7501Replay.test.js` → PASS.

- [ ] **Step 5: Commit** — `git add -A test/helpers/stubTmux.js test/osc7501Listen.test.js src/server/assets/tmuxifier-osc-reporter.py && git commit -m "feat(osc7501): listen role — registry entry, session fold, marker I/O, handover"`.

---

### Task 4: Asset `loop` and `sweep` roles — attach/detach, staleness, lock, version replace

**Files:**
- Modify: `src/server/assets/tmuxifier-osc-reporter.py`
- Test: `test/osc7501Sweep.test.js`

**Interfaces:**
- Produces (python): `list_panes() -> list[tuple[pane_id, piped: bool, cmd, session]] | None` (`tmux list-panes -a -F '#{pane_id}\t#{pane_pipe}\t#{pane_current_command}\t#{session_name}'`, split `\t` maxsplit 3; `None` on failure, with `no_server: bool` exposed via a second return or attribute for the exit rule), `agent_kind(cmd, home) -> str | None` (OSC_AGENTS incl. the opencode plugin-file rule), `attach(pane_id, home)` (`tmux pipe-pane -o -t %N "exec python3 '<home>/.tmuxifier-osc/reporter.py' listen %N"` then write a fresh entry `{sha, attachedAt, handover: False}` unless one exists), `detach(pane_id, home, handover: bool)` (set `handover` in the entry, then `tmux pipe-pane -t %N`), `pass_once(home) -> None` (one loop iteration: list panes; for each row: allowlisted and not piped → attach; piped with a live entry and not allowlisted → bump its miss counter, detach without handover at 3; entries whose pane is missing or `pane_pipe = 0` → delete the entry file; reset miss counters for matching panes). An entry is **live** when its pane is piped and either its `pid` is alive or it has no `pid` yet and `attachedAt` is under 30 s old (the listener has not written itself in yet). Miss counters persist in `~/.tmuxifier-osc/miss.json` (one code path for `loop` and `sweep --once`)., `run_loop(home) -> int` (flock `~/.tmuxifier-osc/loop.lock` with `LOCK_EX|LOCK_NB`; write `pid sha` into it; on start, for every live entry whose `sha` differs from the asset's sha → `detach(handover=True)` then `attach`; then `pass_once` every 2.0 s; exit 0 when `list_panes` reports no server, or after 3600 s with no agent pane and no session), `run_sweep(home, once: bool) -> int` (`pass_once` once; if not `once`: try the lock — free → start the loop with `tmux run-shell -b "exec python3 '<home>/.tmuxifier-osc/reporter.py' loop"`; held by a pid whose recorded sha differs from the current asset sha → `os.kill(pid, SIGTERM)` and start the loop; held by a matching sha → nothing; always exit 0, never print).
- `asset_sha()` = sha256 hex of the asset's own file bytes (`__file__`).
- `main()` dispatch: `listen %N`, `loop`, `sweep [--once]`; anything else exits 0.

- [ ] **Step 1: Write failing tests** `test/osc7501Sweep.test.js` (stub tmux from Task 3; `execFileSync('python3', [ASSET, 'sweep', '--once'], { env })`; assertions on `STUB_TMUX_LOG` lines and `panes/`):
  - panes file: `%1\t0\tzsh\tweb`, `%2\t0\tcodex\tweb`, `%3\t0\tpi\tother proj`, `%4\t1\tcodex\tweb`, `%5\t0\tclaude\tweb`, `%6\t0\topencode\tweb`, `%7\t0\tpip\tweb`, `%8\t0\tpi-dev\tweb` → `pipe-pane -o -t %2`, `%3`, `%6`, `%8` attached (log has exactly those `pipe-pane` lines, each with `-o` and a command containing `listen %N`); `%4` untouched (foreign pipe); `%1`, `%5`, `%7` untouched; entries created for 2, 3, 6, 8 with `sha` = sha256 of the asset file.
  - with `~/.config/opencode/plugins/tmuxifier-agent.js` present → `%6` NOT attached.
  - detach after three misses: entry `panes/4` with `pid` = `process.pid`, panes row `%4\t1\tzsh\tweb`; run `sweep --once` three times → the `pipe-pane -t %4` (no `-o`, no command) appears only in the third run's log; entry's `handover` stays `false`. (the counters live in `~/.tmuxifier-osc/miss.json`).
  - stale entry: `panes/9` for a pane absent from the listing → entry file deleted; `panes/2` with a dead pid (`999999`) and row `%2\t0\tcodex\tweb` → entry deleted and `%2` re-attached.
  - no tmux on PATH (stub dir without `tmux`, PATH = stub dir + a dir with only `python3`) → exit 0, empty stdout and stderr; `STUB_TMUX_NOSERVER=1` → the same.
  - `sweep` (without `--once`) with no lock → log has a `run-shell -b` line whose command contains `loop`; with the lock file held by this test process (`flock` via a short python3 child that holds it and sleeps) and content `<pid> <asset sha>` → no `run-shell` line; content `<pid> deadbeef` → the helper pid receives SIGTERM (the test's holder writes a file on SIGTERM) and a `run-shell` line appears.
  - loop upgrade handover: entry `panes/2` with `sha: 'old'`, `pid` alive, row `%2\t1\tcodex\tweb`; `python3 ASSET loop` run with `TMUXIFIER_OSC_LOOP_ONCE=1` (an env the loop honours for tests: one pass then exit) → log order `pipe-pane -t %2` (detach) then `pipe-pane -o -t %2 …listen %2`, and the entry's `handover` was set true before the detach (the stub appends a snapshot of the entry's `handover` field to the log on every `pipe-pane` call: have the stub `cat` `$STUB_TMUX_ENTRY_DIR/<N>` if present).

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/osc7501Sweep.test.js` → FAIL.

- [ ] **Step 3: Implement `loop`/`sweep`** per Interfaces (`fcntl.flock`; `subprocess.run` with `timeout=5`; `TMUXIFIER_OSC_LOOP_ONCE` test hook).

- [ ] **Step 4: Run the four asset tests** → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(osc7501): loop and sweep roles — attach by pane command, staleness, lock, handover"`.

---

### Task 5: Server pusher, setup phase, wiring, setup-job UI line

**Files:**
- Create: `src/server/oscReporter.js`
- Modify: `src/server/setupManager.js` (deps after `pushOpencodePlugin`; toJSON; the phase after `opencode-plugin`), `src/server/index.js:155-187`, `src/web/api.ts:231`, `src/web/main.ts:2553-2559`
- Test: `test/oscReporter.test.js`, `test/setupManager.test.js` (new tests beside line 461's block)

**Interfaces:**
- Produces: `buildOscReporterInstallScript(): string`; `createOscReporterPusher({ runStdin, readAsset }) → { push(box): Promise<{ target: 'osc-reporter', ok: boolean, skipped?: string, error?: string }> }` — results `{ ok: true }`, `{ ok: false, skipped: 'no python3 on the box' }`, `{ ok: false, skipped: 'no tmux on the box' }`, `{ ok: false, error: 'osc reporter asset unavailable' }`, `{ ok: false, error: 'osc reporter push failed' }`; never throws.
- Installer script (static text, `set -eu`): skip `OSCREPORTER: skipped-no-python3` when `command -v python3` fails and `skipped-no-tmux` when `command -v tmux` fails (both after `cat >/dev/null 2>&1 || true` to drain stdin); `DIR="$HOME/.tmuxifier-osc"`; `mkdir -p "$DIR/panes"`; `cat > "$DIR/reporter.py.$$.tmp"`, `chmod 644`, `mv -f` to `reporter.py`; the tagged rc line exactly as `binPathBlock` does it (touch `.profile` if missing; for `.profile` `.bashrc` `.zshrc` present: `sed -i '/# tmuxifier-osc-pi$/d'` then append `export PI_PROGRAM_STATUS=1 # tmuxifier-osc-pi`); `python3 "$DIR/reporter.py" sweep >/dev/null 2>&1 || true`; `echo 'OSCREPORTER: applied'`.
- `setupManager`: new dep `pushOscReporter = null`; job field `j.oscReporter`; toJSON `oscReporter: j.oscReporter ?? null`; phase `j.phase = 'osc-reporter'` after the `opencode-plugin` block, condition `pushOscReporter && box && !j.cancelled` (no option gate), try/catch recording `{ target: 'osc-reporter', ok: false, error: 'osc reporter push failed' }`.
- Web: `api.ts` SetupJob gains `oscReporter?: SeedResult | null;`; `main.ts` adds `const orTxt = formatStatuslineResult(job.oscReporter);` appended like `ocTxt` and included in the auto-close condition.

- [ ] **Step 1: Write failing tests**
  - `test/oscReporter.test.js` (model: `test/claudeVoiceLink.test.js` lines 280–360 build a tools bin and run the script with `/bin/sh` against a temp HOME): script contains `command -v python3`, `command -v tmux`, `tmuxifier-osc-pi`, no `${` beyond `$HOME`/`$DIR`/`$$`/`$rc`; run with python3+tmux stubs present and stdin = `b'print(1)\n'` → `~/.tmuxifier-osc/reporter.py` equals stdin, mode 644, `panes/` exists, `.zshrc` (pre-created) ends with exactly one `export PI_PROGRAM_STATUS=1 # tmuxifier-osc-pi` after two runs, stdout `OSCREPORTER: applied`, the stub `python3` log shows a `sweep` invocation; without `python3` → `skipped-no-python3` and no file; without `tmux` → `skipped-no-tmux`. Pusher: maps each stdout to the result object above; `readAsset` throwing → `asset unavailable`; `runStdin` throwing → `push failed`.
  - `test/setupManager.test.js`: mirror the three `opencode-plugin` tests at 461–500 for `osc-reporter`: runs after `opencode-plugin` and before `script` even when no tools are selected; recorded in `getJob` and `listJobs` (`null` when unwired); a throwing push is recorded, never promoted.

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/oscReporter.test.js test/setupManager.test.js` → FAIL.

- [ ] **Step 3: Implement** `oscReporter.js` (twin of `opencodeAgentPlugin.js`), the setupManager phase, `index.js` wiring (`createOscReporterPusher({ runStdin: (box, script, input) => boxActions.execScriptStdin(box, script, input), readAsset: () => fs.promises.readFile(new URL('./assets/tmuxifier-osc-reporter.py', import.meta.url)) })` and `pushOscReporter: (box) => oscReporterPusher.push(box)`), `api.ts` type, `main.ts` line.

- [ ] **Step 4: Run** — `npx vitest run test/oscReporter.test.js test/setupManager.test.js && npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(setup): osc-reporter phase pushes the OSC 7501 reporter to every box"`.

---

### Task 6: Probe sweep fragment, `agentKindOf` kinds, labels

**Files:**
- Modify: `src/server/status.js:54-78` (new `OSC_SWEEP` const, inserted into `PROBE_REMOTE` after `AGENT_PROBE`), `src/server/healthHistory.js:32-37`, `src/server/fcmPush.js:19`, `src/web/api.ts:52`, `src/web/agentState.ts:10`
- Test: `test/status.test.js`, `test/healthHistory.test.js`, `test/fcmPush.test.js`, `test/agentState.test.js`

**Interfaces:**
- `OSC_SWEEP = 'if [ -f "$HOME/.tmuxifier-osc/reporter.py" ] && command -v python3 >/dev/null 2>&1; then python3 "$HOME/.tmuxifier-osc/reporter.py" sweep >/dev/null 2>&1 || true; fi; '` exported from `status.js`; `PROBE_REMOTE = \`${META_PROBE} ${AGENT_PROBE}${OSC_SWEEP}if command -v tmux …\``.
- `agentKindOf`: `/^codex(-|$)/ → 'codex'`, `/^pi(-|$)/ → 'pi'` (after claude and opencode).
- `AgentKind = 'claude' | 'opencode' | 'codex' | 'pi'`; `AGENT_LABEL` (web and `fcmPush.js`) add `codex: 'Codex'`, `pi: 'pi'`.

- [ ] **Step 1: Write failing tests**
  - `test/status.test.js`: `PROBE_REMOTE` contains `OSC_SWEEP`; the fragment contains `>/dev/null 2>&1 || true` and no `${` interpolation beyond `$HOME`; the existing `PROBE_REMOTE` execution tests (line 244's runner) still pass with a `python3` stub on the PATH dir that fails loudly (`exit 7` and stderr noise) → probe stdout unchanged and stderr empty when `~/.tmuxifier-osc/reporter.py` exists in a temp HOME.
  - `test/healthHistory.test.js`: `agentKindOf('codex') === 'codex'`, `('codex-x')`, `('pi') === 'pi'`, `('pi-dev') === 'pi'`, `('pip') === null`, `('node') === null`; and a pin: `python3 -c "import importlib.util,json,sys; …; print(json.dumps(sorted(m.OSC_AGENTS)))"` over the asset equals `['codex','opencode','pi']` and every one of those is a kind `agentKindOf` returns for the bare command.
  - `test/fcmPush.test.js`: `agent: 'codex'` → title ends `Codex needs you`; `'pi'` → `pi needs you`.
  - `test/agentState.test.js`: `AGENT_LABEL.codex === 'Codex'`, `AGENT_LABEL.pi === 'pi'`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/status.test.js test/healthHistory.test.js test/fcmPush.test.js test/agentState.test.js` → FAIL.

- [ ] **Step 3: Implement** the four edits.

- [ ] **Step 4: Run** the same four + `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(status): probe triggers the OSC reporter sweep; codex and pi are agent kinds"`.

---

### Task 7: Host Shell parity

**Files:**
- Modify: `src/server/localShellActions.js:84-125`, `src/server/server.js:2062-2071`, `src/server/localAgent.js` (`createLocalAgentSampler` gains `runSweep` dep), `src/web/api.ts:406-412`, `src/web/main.ts:2444`
- Test: `test/server.test.js` (beside 741–790), `test/localAgent.test.js`, `test/localShellActions.test.js` (if present; else the route test covers it)

**Interfaces:**
- `createLocalShellActions({ …, readOscAsset = readOscAssetDefault })` → `installOscReporter(): Promise<PushResult>` via `createOscReporterPusher` over the local transport.
- `PATCH /api/local-shell` with `claudeHooks === true` also sets `result.oscReporter = await localShellActions.installOscReporter()` when the method exists (null otherwise).
- `createLocalAgentSampler({ home, runTmux, runSweep = runSweepDefault })`: `sample()` first awaits `runSweep(home)` when `fs.existsSync(path.join(home, '.tmuxifier-osc', 'reporter.py'))`; default = `execFile('python3', [that path, 'sweep'], { timeout: 5000 })` resolving on any outcome; never affects the sample.
- Web: `updateLocalShell` result type adds `oscReporter?: PushResult | null`; `main.ts:2444` `missed` list includes `res.oscReporter`.

- [ ] **Step 1: Write failing tests** — route test: `claudeHooks: true` with a stub `installOscReporter` → body `oscReporter: { target: 'osc-reporter', ok: true }`; without the method → `oscReporter: null`-or-absent (match how `voiceLink` is handled at 756–770). `localAgent.test.js`: with the file present in the temp HOME, `runSweep` is called once with `home` before the tmux listing; absent → never called; a rejecting `runSweep` leaves the sample unchanged.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/server.test.js test/localAgent.test.js && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(local-shell): OSC reporter rides the Host Shell hooks knob"`.

---

### Task 8: Docs and the agent maps

**Files:**
- Modify: `docs/boxes-and-setup.md` (new bullet after the OpenCode plugin step at ~154; the phase-order line at 216–217 gains `→ OSC reporter` after `OpenCode plugin`), `docs/fleet-and-health.md` (~102: the third source — which agents, how it attaches, the OpenCode aggregation caveat, Claude excluded and why, `PI_PROGRAM_STATUS=1`, Codex-as-`node` on old Node), `README.md` (one line in the agent-state feature paragraph), `CLAUDE.md` + `AGENTS.md` (map entries: `oscReporter.js`, the asset under "Setup jobs and the agent stacks", `OSC_SWEEP` under `status.js`, `agentKindOf` kinds under "Status and health", the phase in the setup phase order, `installOscReporter` under `localShellActions.js`), `test/fixtures/README-osc7501-pane-trace.md` (one line pointing at the replay test).

- [ ] **Step 1: Write the docs** (no code). Every statement must be true of the code as built in Tasks 1–7; keep the two agent maps identical where they overlap.
- [ ] **Step 2: Verify** — `npm test` → PASS (the docs tests, if any, and everything else); `git diff --stat` shows only docs.
- [ ] **Step 3: Commit** — `git commit -am "docs: OSC 7501 pane reporter"`.

---

### After the tasks (not subagent work)

- Whole-branch review (subagent-driven-development's final step).
- Live validation per spec §5.7 on the test box; fix on the branch; redeploy.
- Then stop and wait for the user's go before the ship checklist.
