# Pane-Level Agent State, Plan 2 of 3: Box-Side Writers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The OSC 7501 reporter and the OpenCode plugin each write one agent-state marker per tmux pane, `~/.tmuxifier-agent/<safe session><%pane>`, and clean up the session-wide files their previous versions wrote.

**Architecture:** Both writers stop folding panes into a session. The OSC listener already runs once per pane, so it writes its own pane's file and nothing else; the file a listener owns is named by the `lastWritten` line it keeps, which is also how a new listener recognises and removes an older listener's session-wide file at handover. The OpenCode plugin's sweep folds root OpenCode sessions per pane (same directory tier as today) for every pane running `opencode`, keeps a new per-pane `paneSince` floor beside the session-keyed `since` that mail keeps using, and inherits an older core's maps by shape.

**Tech Stack:** stdlib Python 3 (`src/server/assets/tmuxifier-osc-reporter.py`), plain ESM JavaScript with node builtins only (`src/server/assets/tmuxifier-opencode-agent.js`), vitest, real tmux on a private socket for the integration suite.

**Spec:** `docs/superpowers/specs/2026-11-26-pane-level-agent-state-design.md`. This plan implements sections 6.2 and 6.3, bound by 4.2, 9 and 10. Read those, the comment block above `run_listen` in the OSC asset, and the `oscReporter.js` and `opencodeAgentPlugin.js` entries of `CLAUDE.md` before any task.

**Relation to the other plans:** Plan 1 (server, browser, mail, MCP) and plan 3 (Android) are separate documents. This plan needs nothing from them and they need nothing from it: today's server already parses five-field markers (the Claude hook writes them), and the design's server tolerates a session-wide leftover. The only files shared with plan 1 are the doc sentences in Task 5.

## Global Constraints

- Work only in the worktree `/root/tmuxifier/.claude/worktrees/pane-agent-state` (branch `pane-agent-state`). Never commit a `node_modules` symlink. Never run `npm run build` in the main checkout.
- **Never run a tmux command against the default server.** Any tmux a test or a manual check runs goes through a `-L <unique>` wrapper under a private `TMUX_TMPDIR` and `HOME`, as `test/osc7501Tmux.integration.test.js` does. No step runs `kill-server` except through that wrapper's explicit private socket. Put this rule verbatim in every subagent brief.
- The marker contract, exactly: file `~/.tmuxifier-agent/<safe session><%pane>`, one line `<session>:<state>:<epoch>:<cause>:%<pane>\n`. `<safe session>` is the session name with every **byte** outside `A-Za-z0-9._-` replaced by `_` (the Claude hook's `tr -c 'A-Za-z0-9._-' '_'`). `%<pane>` is the tmux pane id, for example `%12`. The line keeps the exact session name.
- States `working|blocked|ready`. Causes are unchanged: `prompt|resume|stop|start|permission|question|elicitation|unblock`.
- A writer writes and removes only its own pane's file, and removes a file only while its content is still exactly what that writer last wrote.
- A session-wide file (`~/.tmuxifier-agent/<safe session>`, four fields) is removed only by the writer that can prove it wrote it: the OSC listener by an inherited `lastWritten`, the OpenCode core by an inherited `written` entry. Never by name alone.
- `src/server/assets/tmuxifier-agent-hook.sh` is not changed. Its replays (`test/agentHooksReplay.test.js`, `test/agentHooksNestedReplay.test.js`, `test/agentMailWakeReplay.test.js`) pass unchanged.
- OpenCode mail is not changed: `mailTargets`, the held wait, the ack, the pane tagger and the permission handler stay byte for byte, one target per tmux session. `core.since` stays keyed by tmux session because `mailTargets` reads it.
- `STATE_VERSION` stays `4` (the reducer state's shape does not change).
- Nothing is interpolated into pushed script text: both assets arrive on the box byte for byte on stdin. Add no placeholder to either asset and do not touch `src/server/oscReporter.js` or `src/server/opencodeAgentPlugin.js`.
- Box output is untrusted: a pane id becomes part of a file name only after `^%[0-9]+$` (Python `main`) or `PANE_ID_RE = /^%\d{1,9}$/` (JavaScript); tmux listings keep going through `list_panes` and `parsePanesChecked`.
- The OSC asset stays stdlib-only, never writes to the pane, never raises out of its loops, prints nothing. The OpenCode asset stays node-builtins-only, does nothing at module load, and never throws into OpenCode.
- Tests use real code, no mocks. The recorded traces under `test/fixtures/` are the acceptance tests: a fixture file is never edited, and a line-number to state/cause expectation is never changed, only the key used to read it.
- A bare RegExp inside `toMatchObject` matches anything: use `toMatch` on the string, or `expect.stringMatching`.
- Public repo: placeholders only (`/home/user/proj`, `example.com`, `192.168.1.10`). No real hostname, IP or email in any committed text.
- No unreleased code is pushed to a fleet box. This plan ends at a green `npm test`; the live walk of design section 10 happens later, on the test box only, and is not a task here.
- TDD: the failing test first. Commits: conventional messages, ending with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Checks: `npx vitest run test/<file>` for one file; `npm test` (typecheck + everything) before the last commit.

## Review Focus

1. **An OpenCode pane moved to another tmux session mid-turn** (`move-pane`, `break-pane`). Expected: the marker follows to `<new session><%pane>`, the old file is released, and the pane keeps its `since` so its finished turn still reads `ready/stop`. Test in Task 3.
2. **Grouped tmux sessions list one pane once per session.** Expected: the OpenCode plugin writes one marker for the pane, under the first session listed, and does not flap between names. Test in Task 3.
3. **A second hot reload before the first sweep of the upgraded core.** OpenCode re-runs `setup` for every new project directory, so this is ordinary. Expected: the per-pane floor is still seeded from the older core's session map, so a blocked pane does not read `ready/start` after the upgrade. Test in Task 4.
4. **tmux cannot name the pane's session when a migrating OSC listener starts** (the server is busy or the pane is going away). Expected: it falls back to the session in the inherited entry, never raises, and never deletes a file it does not own. Test in Task 2.
5. **A session name with non-ASCII characters or spaces.** Expected: both writers and the Claude hook name the same file byte for byte, so a pane never ends up with two files. Tests in Task 1 (OSC) and the existing `safeName` test (OpenCode).

---

## File Structure

| File | Change |
|---|---|
| `src/server/assets/tmuxifier-osc-reporter.py` | Per-pane marker path and line, ownership by `lastWritten`, sibling fold deleted, migration at listener start. |
| `test/helpers/osc7501Replay.py` | One trail per pane; no session fold. |
| `test/osc7501Reporter.test.js`, `test/osc7501Replay.test.js`, `test/osc7501Listen.test.js`, `test/osc7501Tmux.integration.test.js` | Re-keyed to the pane file; new tests. `test/osc7501Sweep.test.js` is not touched (it reads no marker) and must stay green. |
| `src/server/assets/tmuxifier-opencode-agent.js` | `foldForPanes` and `markerLine` per pane, sweep writes one file per `opencode` pane, `paneSince`, hand-over from an older core. |
| `test/opencodeAgentFold.test.js`, `test/opencodeAgentReplay.test.js`, `test/opencodeAgentReplay23.test.js`, `test/opencodeAgentPlugin.test.js`, `test/opencodeAgentRegistry.test.js` (one line) | Re-keyed; new tests. |
| `CLAUDE.md`, `AGENTS.md`, `docs/boxes-and-setup.md`, `docs/fleet-and-health.md` | The sentences that describe these two writers (Task 5). |

Line numbers below are those of commit `b78a4aa`.

---

### Task 1: OSC reporter writes one marker per pane

**Files:**
- Modify: `src/server/assets/tmuxifier-osc-reporter.py:1-27` (header), `:200-231` (`session_fold`, `next_action` docstring), `:301-326` (`marker_path`, `write_marker`), `:350-391` (`live_entries`, `_sibling_folds`, `_bare_clear`), `:468-484` (attach-seed paragraph of the protocol block), `:528-627` (`run_listen`), `:839-844` (`entry_live`)
- Modify: `test/helpers/osc7501Replay.py`
- Test: `test/osc7501Reporter.test.js`, `test/osc7501Replay.test.js`, `test/osc7501Listen.test.js`, `test/osc7501Tmux.integration.test.js`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Python, all in the asset):
  - `marker_path(home: str, session: str, pane_id: str) -> str`: `<home>/.tmuxifier-agent/<safe session><pane_id>`, sanitising the session's UTF-8 **bytes**.
  - `legacy_marker_path(home: str, session: str) -> str`: `<home>/.tmuxifier-agent/<safe session>`, same sanitising. Used only to find an older listener's file.
  - `own_marker_path(home: str, pane_id: str, last_written) -> str | None`: the file a `lastWritten` line was written to. A five-field line whose fifth field equals `pane_id` gives `marker_path(home, <field 1>, pane_id)`; a four-field line gives `legacy_marker_path(home, <field 1>)`; anything else (another pane's line, another field count, not a `str`) gives `None`.
  - `write_marker(path: str, session: str, state: str, cause: str, pane_id: str, ts: int | None = None) -> str`: writes `'%s:%s:%d:%s:%s\n' % (session, state, ts or int(time.time()), cause, pane_id)`, mode `0o644`, returns the content.
  - `_bare_clear(home: str, pane_id: str, last_written) -> str | None`: unlinks `own_marker_path(home, pane_id, last_written)` when that file's content equals `last_written` and returns `None`; otherwise touches nothing and returns `last_written`.
  - Deleted: `session_fold`, `live_entries`, `_sibling_folds`, `entry_live`. `next_action`, `Records`, `PaneReader`, `read_marker` keep their signatures.
  - Replay helper output rows: `{"line": n, "pane": <pane>, "session": <session>, "marker": "state/cause" | null}`.

- [ ] **Step 1: Write the failing naming test** in `test/osc7501Reporter.test.js` (add the `ASSET` constant and the `py` helper next to `HELPER`):

```js
const ASSET = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'assets', 'tmuxifier-osc-reporter.py');
// Evaluates one Python expression against the real asset (imported as `m`); returns its JSON.
function py(expr) {
  const script = 'import importlib.util,json,sys\nsys.dont_write_bytecode=True\n'
    + 'spec=importlib.util.spec_from_file_location("r",sys.argv[1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n'
    + `print(json.dumps(${expr}))`;
  return JSON.parse(execFileSync('python3', ['-c', script, ASSET], { encoding: 'utf8' }));
}

it('names a marker <safe session><%pane>, byte-wise like the hook, and finds its own file from lastWritten', () => {
  expect(py("m.marker_path('/h', 'web', '%3')")).toBe('/h/.tmuxifier-agent/web%3');
  expect(py("m.marker_path('/h', 'my proj/x', '%12')")).toBe('/h/.tmuxifier-agent/my_proj_x%12');
  expect(py("m.marker_path('/h', 'caf\\u00e9', '%3')")).toBe('/h/.tmuxifier-agent/caf__%3'); // é is two bytes
  expect(py("m.legacy_marker_path('/h', 'my proj')")).toBe('/h/.tmuxifier-agent/my_proj');
  expect(py("m.own_marker_path('/h', '%3', 'web:working:1:prompt:%3\\n')")).toBe('/h/.tmuxifier-agent/web%3');
  expect(py("m.own_marker_path('/h', '%3', 'web:working:1:prompt\\n')")).toBe('/h/.tmuxifier-agent/web');
  expect(py("[m.own_marker_path('/h', '%3', v) for v in ['web:working:1:prompt:%4\\n', 'junk', '', None, 5]]"))
    .toEqual([null, null, null, null, null]);
  expect(py("[hasattr(m, n) for n in ['session_fold', 'live_entries', '_sibling_folds', 'entry_live']]"))
    .toEqual([false, false, false, false]);
});
```

- [ ] **Step 2: Re-key the helper-driven tests.**
  In `test/osc7501Reporter.test.js`: every `toEqual` on a whole row gains `pane: 'p'` (for example `{ line: 1, pane: 'p', session: 's', marker: 'working/prompt' }`); in the last test add `expect(src).not.toMatch(/session_fold/);`.
  In `test/osc7501Replay.test.js`: `trailOf` filters by pane (`rows.filter((r) => r.pane === pane)`); the first test's constants and assertions stay exactly as they are (each recorded pane is its own session, so the trails do not change); replace the second test with:

```js
it('two panes of one session keep their own trails', () => {
  const { rows, lines } = replay(['opencode=shared', 'opencode2=shared']);
  expect(lines).toBe(LINES);
  expect(trailOf(rows, 'opencode')).toEqual(OPENCODE);
  expect(trailOf(rows, 'opencode2')).toEqual(OPENCODE2);
  expect(rows.filter((r) => r.pane === 'opencode' || r.pane === 'opencode2').every((r) => r.session === 'shared')).toBe(true);
});
```

- [ ] **Step 3: Re-key `test/osc7501Listen.test.js` and add the per-pane tests.**
  Harness: build `markerOf`, `legacyOf` and `entryFile` before the spawn, and accept a `before` callback that runs before the listener starts:

```js
function setup({ sessions = { 5: 'web' }, before } = {}) {
  // ... home, stubDir, stub as today ...
  const markerOf = (s, pane = '%5') => path.join(home, '.tmuxifier-agent', `${s}${pane}`);
  const legacyOf = (s) => path.join(home, '.tmuxifier-agent', s);
  const entryFile = path.join(home, '.tmuxifier-osc', 'panes', '5');
  if (before) before({ home, markerOf, legacyOf, entryFile });
  // ... spawn, kids.push, exited as today; return adds legacyOf ...
}
```

  Mechanical rule for every existing test: a marker regex or literal gains the pane as its fifth field (`/^web:working:\d+:prompt\n$/` becomes `/^web:working:\d+:prompt:%5\n$/`; `'web:working:1:prompt\n'` becomes `'web:working:1:prompt:%5\n'`, in file contents and in entry `lastWritten` values alike). Loose regexes such as `/:working:/` stay. `'a session name with a space is sanitized in the filename only'` waits on `markerOf('my_proj')` for `/^my proj:working:\d+:prompt:%5\n$/`.

  Replace `'sibling pane keeps the session blocked'` and `'a renamed session gets its own marker'` with:

```js
test('a sibling pane is not folded in: each pane has its own marker', async () => {
  const SIB = 'web:blocked:1:permission:%7\n';
  const t = setup({ before: (p) => {
    mkdirSync(path.dirname(p.entryFile), { recursive: true });
    mkdirSync(path.dirname(p.markerOf('web')), { recursive: true });
    writeFileSync(path.join(path.dirname(p.entryFile), '7'), JSON.stringify({
      pid: process.pid, sha: 'x', session: 'web', records: { '': { state: 'blocked', kind: 'permission' } },
      lastWritten: SIB, handover: false, attachedAt: 1,
    }));
    writeFileSync(p.markerOf('web', '%7'), SIB);
  } });
  t.send(osc('state=working'));
  await waitMarker(t, 'web', /^web:working:\d+:prompt:%5\n$/);
  t.send(osc('state=clear'));
  await waitFor(() => !existsSync(t.markerOf('web')));
  expect(readFileSync(t.markerOf('web', '%7'), 'utf8')).toBe(SIB);
  expect(existsSync(t.legacyOf('web'))).toBe(false);
  t.child.stdin.end();
  await t.exited;
});

test('a pane whose session changed: the marker moves to the new name and the old file is removed', async () => {
  const t = setup();
  t.send(osc('state=working'));
  await waitMarker(t, 'web', /:working:/);
  t.stub.setSessions({ 5: 'web2' });
  t.send(osc('state=idle'));
  const c = await waitMarker(t, 'web2', /^web2:ready:\d+:start:%5\n$/);
  expect(existsSync(t.markerOf('web'))).toBe(false);
  await waitFor(() => JSON.parse(readFileSync(t.entryFile, 'utf8')).lastWritten === c);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('web2'))).toBe(false); // EOF removes the file lastWritten names
});

test('a pane whose session changed leaves an old file someone else rewrote', async () => {
  const t = setup();
  t.send(osc('state=working'));
  await waitMarker(t, 'web', /:working:/);
  writeFileSync(t.markerOf('web'), 'web:blocked:1:permission:%5\n');
  t.stub.setSessions({ 5: 'web2' });
  t.send(osc('state=idle'));
  await waitMarker(t, 'web2', /^web2:ready:\d+:start:%5\n$/);
  expect(readFileSync(t.markerOf('web'), 'utf8')).toBe('web:blocked:1:permission:%5\n');
  t.child.stdin.end();
  await t.exited;
});

test('attach seed is per pane: a session-wide file and a sibling pane\'s file do not stop it and are not touched', async () => {
  const t = setup({ before: (p) => {
    mkdirSync(path.dirname(p.markerOf('web')), { recursive: true });
    writeFileSync(p.legacyOf('web'), 'web:working:1:prompt\n');
    writeFileSync(p.markerOf('web', '%7'), 'web:blocked:1:permission:%7\n');
  } });
  await waitMarker(t, 'web', /^web:ready:\d+:start:%5\n$/);
  expect(readFileSync(t.legacyOf('web'), 'utf8')).toBe('web:working:1:prompt\n');
  expect(readFileSync(t.markerOf('web', '%7'), 'utf8')).toBe('web:blocked:1:permission:%7\n');
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('web'))).toBe(false);
  expect(readFileSync(t.legacyOf('web'), 'utf8')).toBe('web:working:1:prompt\n');
});

test('a non-ASCII session name is sanitised byte for byte, like the hook', async () => {
  const t = setup({ sessions: { 5: 'café' } });
  t.send(osc('state=working'));
  await waitMarker(t, 'caf__', /^café:working:\d+:prompt:%5\n$/);
  t.child.stdin.end();
  await t.exited;
});
```

- [ ] **Step 4: Re-key `test/osc7501Tmux.integration.test.js` and add the split-pane test.**
  In `harness()`: `marker: path.join(home, '.tmuxifier-agent', 'web%0')`, add `legacy: path.join(home, '.tmuxifier-agent', 'web')` and

```js
    // Typed into one pane by id; printf turns the octal escapes into ESC/BEL.
    reportTo(paneId, body) {
      tmux('send-keys', '-t', paneId, '-l', `printf '\\033]7501;${body}\\007'`);
      tmux('send-keys', '-t', paneId, 'Enter');
    },
```

  Every marker regex and literal in the file gains `:%0` as the fifth field by the Step 3 rule. Add:

```js
test('three codex panes of one session, one split and one in a background window, each keep their own marker', async () => {
  const h = await harness();
  const codex = path.join(h.bin, 'codex');
  // The private server holds only the session `web`, so the bare name is exact here.
  const split = h.tmux('split-window', '-d', '-t', '%0', '-P', '-F', '#{pane_id}', `exec '${codex}'`).trim();
  const bg = h.tmux('new-window', '-d', '-t', 'web:', '-P', '-F', '#{pane_id}', `exec '${codex}'`).trim();
  expect([split, bg]).toEqual(['%1', '%2']);
  const cmdOf = (id) => h.tmux('display-message', '-p', '-t', id, '#{pane_current_command}').trim();
  await waitFor(() => cmdOf(split) === 'codex' && cmdOf(bg) === 'codex', { what: 'three codex panes' });
  const markerOf = (id) => path.join(h.home, '.tmuxifier-agent', `web${id}`);
  const reads = (id, re) => re.test(readIf(markerOf(id)) || '');

  h.sweep();
  await waitFor(() => ['%0', '%1', '%2'].every((id) => reads(id, new RegExp(`^web:ready:\\d+:start:${id}\\n$`))), { what: 'one seeded marker per pane' });
  h.reportTo('%0', 'state=working:app=codex');
  h.reportTo(split, 'state=blocked:kind=question:app=codex');
  await waitFor(() => reads('%0', /^web:working:\d+:prompt:%0\n$/) && reads('%1', /^web:blocked:\d+:question:%1\n$/), { what: 'two independent states' });
  expect(reads('%2', /^web:ready:\d+:start:%2\n$/)).toBe(true); // the background window's pane is untouched

  h.reportTo(split, 'state=clear');
  await waitFor(() => !existsSync(markerOf('%1')), { what: 'the cleared pane\'s marker removal' });
  expect(reads('%0', /^web:working:\d+:prompt:%0\n$/)).toBe(true);
  expect(reads('%2', /^web:ready:\d+:start:%2\n$/)).toBe(true);
  expect(existsSync(h.legacy)).toBe(false); // nothing writes a session-wide file any more
});
```

- [ ] **Step 5: Run the four files and see them fail**

Run: `npx vitest run test/osc7501Reporter.test.js test/osc7501Replay.test.js test/osc7501Listen.test.js test/osc7501Tmux.integration.test.js`
Expected: FAIL. The naming test fails with `Command failed: python3 -c ...` whose stderr ends `TypeError: marker_path() takes 2 positional arguments but 3 were given`; the row assertions fail on the missing `pane`; the listener and integration tests time out waiting for `web%5` / `web%0`.

- [ ] **Step 6: Rework `test/helpers/osc7501Replay.py` to one trail per pane.**
  `Replay` keeps `markers` and `written` keyed by **pane** and one `PaneReader` per pane. `feed(line, pane, data)`: a `None` from the reader yields nothing; `('clear', _)` removes the pane's marker and emits `marker: null` only when `markers[pane] == written.get(pane)`; `('fold', fold)` runs `rep.next_action(markers.get(pane), fold)` and emits on a write. No call to `rep.session_fold`, no `_session_fold`, no `active` flag. Every row carries `pane` and `session` (`session_of(pane)`). In `chunks` mode the pane is `'p'`, the session `'s'`, and `--marker` seeds `markers['p']`. Update the header comment's usage lines to say "whenever a pane's marker changes".

- [ ] **Step 7: Implement the per-pane write path in the asset.**
  1. Add `marker_path`, `legacy_marker_path`, `own_marker_path`, the new `write_marker` and the new `_bare_clear` exactly as in **Interfaces**. Sanitise with `re.sub(rb'[^A-Za-z0-9._-]', b'_', session.encode('utf-8', 'surrogateescape')).decode('ascii')`.
  2. Delete `session_fold`, `live_entries`, `_sibling_folds` and `entry_live` (nothing else calls them; `pid_alive` and `_in_grace` stay, `pass_once` uses them).
  3. `run_listen`, attach seed (`:563-577`): for a fresh attach whose session resolves, the path is `marker_path(home, s, pane_id)`; when that file does not exist, write `next_action(None, ('idle', None))` to it (always `ready/start`). A session-wide file or another pane's file is never looked at.
  4. `run_listen`, bare clear (`:594-599`): `last_written = _bare_clear(home, pane_id, last_written)`, then `persist()`. No tmux call.
  5. `run_listen`, fold change (`:600-610`):

```python
            s = resolve_session(pane_id)
            if s is None:
                persist()
                continue
            session = s
            mpath = marker_path(home, s, pane_id)
            if last_written is not None and own_marker_path(home, pane_id, last_written) != mpath:
                # The pane is in another session now (or the line is an older
                # version's): release the old file if it is still ours.
                _bare_clear(home, pane_id, last_written)
                last_written = None
            act = next_action(read_marker(mpath), fold)
            if act:
                last_written = write_marker(mpath, s, act[1], act[2], pane_id)
            persist()
```

  6. `run_listen`, EOF (`:614-626`): the decision line (`cur and (cur.get('handover') is True or cur.get('pid') != os.getpid() or superseded(cur))`) and the lock stay byte for byte; the real-end branch becomes `_bare_clear(home, pane_id, last_written)` then `_unlink(epath)`. Drop the `resolve_session` call before the lock: the file is named by `lastWritten`.
  7. Comments: the header (`:1-27`) says `~/.tmuxifier-agent/<session><%pane>`, one line `<session>:<state>:<epoch>:<cause>:%<pane>`, "writes the pane's marker", and drops `session_fold` from the pure-core list; `next_action`'s docstring says "the pane's current marker file"; the attach-seed paragraph (`:468-484`) says the seed is per pane, always `ready/start`, and that a marker file of the **pane** that exists is never touched. Nothing else in the protocol block changes.

- [ ] **Step 8: Run the OSC files and see them pass**

Run: `npx vitest run test/osc7501Reporter.test.js test/osc7501Replay.test.js test/osc7501Listen.test.js test/osc7501Tmux.integration.test.js test/osc7501Sweep.test.js test/healthHistory.test.js`
Expected: PASS, all files. `test/osc7501Sweep.test.js` and `test/healthHistory.test.js` are unmodified (`git diff --exit-code HEAD -- test/osc7501Sweep.test.js test/healthHistory.test.js test/fixtures` prints nothing).

- [ ] **Step 9: Commit**

```bash
git add src/server/assets/tmuxifier-osc-reporter.py test/helpers/osc7501Replay.py test/osc7501Reporter.test.js test/osc7501Replay.test.js test/osc7501Listen.test.js test/osc7501Tmux.integration.test.js
git commit -m "feat(osc): the reporter writes one marker per pane"
```

---

### Task 2: OSC reporter migrates an older listener's session-wide marker at handover

**Files:**
- Modify: `src/server/assets/tmuxifier-osc-reporter.py` (`run_listen` start-up, between reading the entry and the attach seed; the protocol block gains one paragraph)
- Test: `test/osc7501Listen.test.js`, `test/osc7501Tmux.integration.test.js`

**Interfaces:**
- Consumes: `marker_path`, `own_marker_path`, `write_marker(..., ts=)`, `_bare_clear`, `next_action`, `CAUSE_KIND` from Task 1.
- Produces: `_legacy_fields(last_written) -> tuple[str, str, int, str] | None`: `(session, state, ts, cause)` of a four-field line whose state is one of `working`, `blocked`, `ready`, whose ts is 1 to 12 digits and whose cause matches `^[a-z]{1,16}$`; `None` for anything else.

- [ ] **Step 1: Write the failing listener tests** in `test/osc7501Listen.test.js`:

```js
const LEGACY = 'web:working:1700000000:prompt\n';
// The entry a listener of the previous asset version leaves for its successor.
const legacyEntry = (over = {}) => JSON.stringify({
  sha: 'old', session: 'web', records: { '': { state: 'working', kind: null } },
  lastWritten: LEGACY, handover: true, attachedAt: 1, ...over,
});
// `files(p)` returns { <absolute path>: <content> } to write before the listener starts.
const plant = (entry, files = () => ({})) => (p) => {
  mkdirSync(path.dirname(p.entryFile), { recursive: true });
  mkdirSync(path.dirname(p.legacyOf('web')), { recursive: true });
  writeFileSync(p.entryFile, entry);
  for (const [file, content] of Object.entries(files(p))) writeFileSync(file, content);
};
const entryOf = (t) => JSON.parse(readFileSync(t.entryFile, 'utf8'));

test('migration: a session-wide marker still ours is removed and carried to the pane file with its state, cause and ts', async () => {
  const t = setup({ before: plant(legacyEntry(), (p) => ({ [p.legacyOf('web')]: LEGACY })) });
  const NEW = 'web:working:1700000000:prompt:%5\n';
  await waitFor(() => readIf(t.markerOf('web')) === NEW);
  expect(existsSync(t.legacyOf('web'))).toBe(false);
  await waitFor(() => entryOf(t).pid === t.child.pid && entryOf(t).lastWritten === NEW);
  t.send(osc('state=idle'));
  await waitMarker(t, 'web', /^web:ready:\d+:stop:%5\n$/); // the fold continues: a finished turn, not a first observation
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(existsSync(t.markerOf('web'))).toBe(false);
});

test('migration: a session-wide file someone else rewrote is kept; the pane file comes from the inherited records', async () => {
  const OTHER = 'web:blocked:5:permission\n'; // an older sibling listener's fold, or the hook's
  const t = setup({ before: plant(legacyEntry(), (p) => ({ [p.legacyOf('web')]: OTHER })) });
  const c = await waitMarker(t, 'web', /^web:working:\d+:prompt:%5\n$/);
  expect(c).not.toBe('web:working:1700000000:prompt:%5\n'); // not ours: nothing of the old line is carried
  expect(readFileSync(t.legacyOf('web'), 'utf8')).toBe(OTHER);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(readFileSync(t.legacyOf('web'), 'utf8')).toBe(OTHER);
});

test('migration: a legacy line that was a sibling\'s fold is removed, and the pane file says what this pane\'s own records say', async () => {
  const FOLD = 'web:blocked:1700000000:permission\n';
  const entry = legacyEntry({ records: { '': { state: 'idle', kind: null } }, lastWritten: FOLD });
  const t = setup({ before: plant(entry, (p) => ({ [p.legacyOf('web')]: FOLD })) });
  await waitMarker(t, 'web', /^web:ready:\d+:start:%5\n$/);
  expect(existsSync(t.legacyOf('web'))).toBe(false);
  t.child.stdin.end();
  await t.exited;
});

test('migration: a pane file that already exists is not touched', async () => {
  const HOOK = 'web:blocked:9:question:%5\n';
  const t = setup({ before: plant(legacyEntry(), (p) => ({ [p.legacyOf('web')]: LEGACY, [p.markerOf('web')]: HOOK })) });
  await waitFor(() => entryOf(t).pid === t.child.pid);
  await waitFor(() => !existsSync(t.legacyOf('web')));
  await new Promise((r) => setTimeout(r, 300));
  expect(readFileSync(t.markerOf('web'), 'utf8')).toBe(HOOK);
  expect(entryOf(t).lastWritten).toBe(null);
  t.child.stdin.end();
  expect(await t.exited).toBe(0);
  expect(readFileSync(t.markerOf('web'), 'utf8')).toBe(HOOK);
});

test('migration when tmux cannot name the pane\'s session: the inherited session is used; with none, only the owned file goes', async () => {
  const a = setup({ sessions: {}, before: plant(legacyEntry(), (p) => ({ [p.legacyOf('web')]: LEGACY })) });
  await waitFor(() => readIf(a.markerOf('web')) === 'web:working:1700000000:prompt:%5\n');
  expect(existsSync(a.legacyOf('web'))).toBe(false);
  a.child.stdin.end();
  expect(await a.exited).toBe(0);

  const b = setup({ sessions: {}, before: plant(legacyEntry({ session: undefined }), (p) => ({ [p.legacyOf('web')]: LEGACY })) });
  await waitFor(() => entryOf(b).pid === b.child.pid);
  await waitFor(() => !existsSync(b.legacyOf('web')));
  expect(existsSync(b.markerOf('web'))).toBe(false);
  expect(entryOf(b).lastWritten).toBe(null);
  b.child.stdin.end();
  expect(await b.exited).toBe(0);
});
```

- [ ] **Step 2: Write the failing integration test** in `test/osc7501Tmux.integration.test.js` (add `renameSync` to the `node:fs` import):

```js
test('a handover whose entry carries an older listener\'s session-wide marker migrates it to the pane file', async () => {
  const h = await harness();
  h.sweep();
  const first = await waitFor(() => { const e = h.readEntry(); return e && typeof e.pid === 'number' ? e : null; }, { what: 'listener claim' });
  h.report('state=working:app=codex');
  await waitFor(() => /^web:working:\d+:prompt:%0\n$/.test(readIf(h.marker) || ''), { what: 'working marker' });

  // Leave the box as the previous asset version would have: a session-wide
  // file, the same line as the entry's lastWritten, and no pane file. The
  // entry is replaced by rename so the loop's unlocked read never sees half a file.
  const LEGACY = 'web:working:1700000000:prompt\n';
  writeFileSync(h.legacy, LEGACY);
  writeFileSync(`${h.entry}.t`, JSON.stringify({ ...h.readEntry(), lastWritten: LEGACY }));
  renameSync(`${h.entry}.t`, h.entry);
  rmSync(h.marker);

  appendFileSync(h.installed, '\n# rerun\n'); // a setup rerun: the next sweep replaces the loop, the new loop hands over
  const sha2 = shaOf(h.installed);
  h.sweep();
  const second = await waitFor(() => {
    const e = h.readEntry();
    return e && e.sha === sha2 && typeof e.pid === 'number' && e.pid !== first.pid ? e : null;
  }, { what: 'successor claim' });
  const NEW = 'web:working:1700000000:prompt:%0\n';
  await waitFor(() => readIf(h.marker) === NEW, { what: 'migrated pane marker' });
  expect(existsSync(h.legacy)).toBe(false);
  await waitFor(() => h.readEntry().lastWritten === NEW, { what: 'entry lastWritten' });
  expect(h.procs('listen %0')).toEqual([second.pid]);

  h.report('state=idle:app=codex');
  await waitFor(() => /^web:ready:\d+:stop:%0\n$/.test(readIf(h.marker) || ''), { what: 'ready:stop marker' });
});
```

- [ ] **Step 3: Run and see them fail**

Run: `npx vitest run test/osc7501Listen.test.js test/osc7501Tmux.integration.test.js`
Expected: FAIL. The six new tests time out waiting for `web%5` / `web%0` (Task 1 releases a legacy file only at the first fold change and carries nothing).

- [ ] **Step 4: Implement the start-up migration in `run_listen`.**
  Add `_legacy_fields` as in **Interfaces**. In `run_listen`, compute `fresh = not entry.get('records') and last_written is None` before anything else and gate the attach seed on `fresh` (so a listener that just migrated never also seeds). Between the `state = {...}`/`persist` definitions and the attach seed, add:

```python
    # Migration (protocol block): the entry was last written by a listener
    # that kept ONE marker per session. Remove that file if it is still ours,
    # then give this pane its own marker from the inherited records.
    legacy = _legacy_fields(last_written)
    if legacy is not None:
        try:
            ours = _bare_clear(home, pane_id, last_written) is None
            last_written = None
            s = resolve_session(pane_id) or session
            if s is not None:
                session = s
                mpath = marker_path(home, s, pane_id)
                if not os.path.exists(mpath):
                    own = reader.recs.fold()
                    want = 'ready' if own[0] == 'idle' else own[0]
                    same = (ours and legacy[1] == want
                            and (want != 'blocked' or CAUSE_KIND.get(legacy[3]) == (own[1] or 'permission')))
                    if same:
                        # The old line described this pane: carry it, ts included.
                        last_written = write_marker(mpath, s, legacy[1], legacy[3], pane_id, ts=legacy[2])
                    else:
                        act = next_action(None, own)
                        last_written = write_marker(mpath, s, act[1], act[2], pane_id)
        except Exception as e:
            debug(home, 'migrate: %r' % (e,))
```

  The existing `persist()` after the seed block stores the result. Add one paragraph to the protocol block, after "Attach seed", titled "Session-wide markers (migration)": what an inherited four-field `lastWritten` means, that the file goes only while its content equals that line, that the pane file is written from the pane's own records (the old line was a fold of sibling panes), that a pane file which exists is left alone, and that an old listener may rewrite the session-wide file during the one pass both versions run, which the server's session-wide rule reads correctly.

- [ ] **Step 5: Run and see them pass**

Run: `npx vitest run test/osc7501Listen.test.js test/osc7501Tmux.integration.test.js test/osc7501Sweep.test.js test/osc7501Reporter.test.js test/osc7501Replay.test.js`
Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add src/server/assets/tmuxifier-osc-reporter.py test/osc7501Listen.test.js test/osc7501Tmux.integration.test.js
git commit -m "feat(osc): a new listener migrates the session-wide marker it inherits"
```

---

### Task 3: OpenCode plugin folds and writes per pane

**Files:**
- Modify: `src/server/assets/tmuxifier-opencode-agent.js:1-4` (header), `:473-489` (attribution comment), `:578-612` (`foldForPanes`), `:680-683` (`markerLine`), `:2125-2138` and `:2190-2214` (`createCore` comment and core object), `:2329-2368` (`sweepOnce`), `:2485-2511` (`takeOver`)
- Test: `test/opencodeAgentFold.test.js`, `test/opencodeAgentReplay.test.js`, `test/opencodeAgentReplay23.test.js`, `test/opencodeAgentPlugin.test.js`, `test/opencodeAgentRegistry.test.js:510`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces:
  - `foldForPanes(reducer, panes, since = new Map(), now) : Map<string, { session: string, state: string, cause: string, ts: number }>`, keyed by **pane id**, one entry for every row that runs `opencode` and has a `pane` matching `PANE_ID_RE`; a pane id listed twice (grouped sessions) keeps the first row. `since` is keyed by pane id. `pane.active` is no longer read. The candidate rules (root sessions, `tierOf`, the floor, `rankOf`, ties, `ready/start` at the floor or `now`) do not change.
  - `markerLine(tmuxSession: string, fold, pane: string) : string` returns `` `${tmuxSession}:${fold.state}:${fold.ts}:${fold.cause}:${pane}\n` ``.
  - `core.paneSince : Map<paneId, epochSeconds>`: when each pane started running `opencode`. A plain property, like `written`.
  - `core.since : Map<tmuxSession, epochSeconds>`: unchanged in meaning and maintenance; from now on only `mailTargets` reads it.
  - `core.written : Map<name, content>` with `name = safeName(session) + pane` (for example `web%3`).
  - `takeOver` passes `prev.paneSince` on when it is a `Map`.

- [ ] **Step 1: Record the mail code's fingerprints** (they must be identical at the end of Tasks 3 and 4):

Run:
```bash
sed -n '/^export function mailTargets/,/^}/p' src/server/assets/tmuxifier-opencode-agent.js | sha256sum
sed -n '/^export const MAX_SOCKET_PATH_BYTES/,/^export const GLOBAL_KEY/p' src/server/assets/tmuxifier-opencode-agent.js | sha256sum
```
Expected: `c53d0eba8f3c438afe852e6975b55618cf92dab0ca48e0eb92b3e2266c760810` (`mailTargets`) and `980987733b219149aa74ad0c378269127561f3c3bccf5227e55d37c29bcd60fb` (the socket client, the mail part, the pane tagger, the permission handler).

- [ ] **Step 2: Re-key `test/opencodeAgentFold.test.js` and add the per-pane tests.**
  The helper becomes `const pane = (id, session, path, cmd = 'opencode', active = true) => ({ session, cmd, path, active, pane: id });`. Mechanical rule for every existing `foldForPanes` test: give each pane an id (`%1`, `%2`, ... in the order the test builds them); key every `since` map by that id; `.get('<session>')` becomes `.get('<its pane id>')`; every expected object gains `session: '<session>'`; `.has('shell')` becomes `.has('<the zsh pane's id>')`. No state, cause or ts value changes. In `'two tmux sessions in the same directory get the same fold'` compare the two panes with `const st = ({ state, cause, ts }) => ({ state, cause, ts });` and flip the background-pane assertion to `expect(foldForPanes(w.r, [pane('%9', 'bg', '/proj', 'opencode', false)], new Map(), 999).get('%9')).toEqual({ session: 'bg', state: 'working', cause: 'prompt', ts: 110 });`.

  Replace `'a session whose active window runs claude is not folded...'` and `'markerLine writes session:state:ts:cause...'`, and add three tests:

```js
test('every opencode pane is folded, in a background window too; a claude pane never is', () => {
  const panes = parsePanes('web\t1\t1\tclaude\t/home/user/proj\t%1\nweb\t0\t1\topencode\t/home/user/proj\t%2\n');
  const fold = foldForPanes(createReducer(), panes, new Map(), 1);
  expect([...fold.keys()]).toEqual(['%2']);
  expect(fold.get('%2')).toEqual({ session: 'web', state: 'ready', cause: 'start', ts: 1 });
});

test('two panes of one tmux session in different directories each read their own directory', () => {
  const w = world();
  w.created('ses_a', 100, '/proj'); w.start('ses_a', 110); // working @110
  w.created('ses_b', 100, '/other'); w.start('ses_b', 120); w.ask('ses_b', 130, 'per_b'); // blocked @130
  const panes = [pane('%1', 'web', '/proj'), pane('%2', 'web', '/other', 'opencode', false)];
  const fold = foldForPanes(w.r, panes, new Map(), 999);
  expect(fold.get('%1')).toEqual({ session: 'web', state: 'working', cause: 'prompt', ts: 110 });
  expect(fold.get('%2')).toEqual({ session: 'web', state: 'blocked', cause: 'permission', ts: 130 });
});

test('since is per pane: a floor keyed by the tmux session name is not a floor', () => {
  const w = world();
  w.created('ses_a', 100, '/proj'); w.start('ses_a', 110); w.end('ses_a', 120); // ready/stop @120
  const panes = [pane('%1', 'web', '/proj'), pane('%2', 'web', '/proj')];
  const fold = foldForPanes(w.r, panes, new Map([['%2', 500], ['web', 900]]), 999);
  expect(fold.get('%1')).toEqual({ session: 'web', state: 'ready', cause: 'stop', ts: 120 });
  expect(fold.get('%2')).toEqual({ session: 'web', state: 'ready', cause: 'start', ts: 500 });
});

test('a pane listed under two grouped sessions is folded once, under the first listed; a row without a pane id never is', () => {
  const w = world();
  w.created('ses_a', 100, '/proj'); w.start('ses_a', 110);
  const panes = [pane('%3', 'alpha', '/proj'), pane('%3', 'beta', '/proj'), pane(undefined, 'gamma', '/proj'), pane('%x', 'delta', '/proj')];
  const fold = foldForPanes(w.r, panes, new Map(), 999);
  expect([...fold.keys()]).toEqual(['%3']);
  expect(fold.get('%3')).toEqual({ session: 'alpha', state: 'working', cause: 'prompt', ts: 110 });
});

test('markerLine writes session:state:ts:cause:%pane with a trailing newline', () => {
  expect(markerLine('web', { state: 'blocked', cause: 'permission', ts: 1794098652 }, '%12')).toBe('web:blocked:1794098652:permission:%12\n');
  expect(markerLine('octest', { state: 'ready', cause: 'start', ts: 0 }, '%0')).toBe('octest:ready:0:start:%0\n');
});
```

- [ ] **Step 3: Re-key the two replays. Their line-number expectations do not change.**
  `test/opencodeAgentReplay.test.js`: `SINCE = new Map([['%1', 0], ['%2', 0], ['%3', 0]])`; `trailOf('%1')`, `trailOf('%2')`, `trailOf('%3')`; every `fold.get('octest')` is `fold.get('%1')` (and `octest2` is `%2`, `octest3` is `%3`), the `REPLAY_TRAIL` print included; line 100 compares `st(t.fold.get('%2'))` with `st(t.fold.get('%1'))` (`st` as in Step 2); line 101 expects `{ session: 'octest3', state: 'ready', cause: 'start', ts: 0 }`; line 110 is ``expect(markerLine('octest', trail[45].fold.get('%1'), '%1')).toBe(`octest:ready:${Math.floor(trail[45].created / 1000)}:stop:%1\n`)``.
  `test/opencodeAgentReplay23.test.js`: `SINCE = new Map([['%1', 0], ['%2', 0]])`; `at` reads `'%1'`, `at2` reads `'%2'`, `tsOf = (n, pane = '%1')`, the call `tsOf(eEnd, 'octest2')` becomes `tsOf(eEnd, '%2')`, the `REPLAY_TRAIL` print reads `'%1'` and `'%2'`; line 169 is ``expect(markerLine('octest', trail[aEnd - 1].fold.get('%1'), '%1')).toBe(`octest:ready:${secOf(aEnd)}:stop:%1\n`)``.

- [ ] **Step 4: Re-key `test/opencodeAgentPlugin.test.js` and add the per-pane sweep tests.**
  Mechanical rule: the marker file of a single-row listing is `<session>%1` (the `row` helper's default id), so `read(home, 'web')`, `marker(home, 'web')`, `core.written.get('web')`, `core.written.has('web')` and `readdirSync(...)` expectations use `'web%1'`, and every expected content or regex gains `:%1` before the newline (`'web:ready:998:start:%1\n'`, `/^web:working:\d+:prompt:%1\n$/`). A foreign content a test writes into that file gains `:%1` too. Keep every `core.since` assertion as it is and add the same value for `core.paneSince.get('%1')` beside it (`core.since.has('web')` false goes with `core.paneSince.has('%1')` false). In `'setup twice hands over'` and `'an event stream that ends without an abort'` add `expect(core2.paneSince).toBe(core1.paneSince);` beside the `since` line.
  The six two-row listings get one pane id per row:
  - line 108: `row('dev', 'claude', '/x', '1', '1', '%2')`; the absent file is `marker(home, 'dev%2')`.
  - lines 370 and 377: the zsh row is `'%2'`. Rename the test to `'a window switch keeps the marker: an opencode pane in a background window still has its state'`; after the switch at line 371 expect `read(home, 'web%1')` to be `'web:blocked:1200:permission:%1\n'` (not deleted), `core.since.get('web')` and `core.paneSince.get('%1')` both `1000`; the rest of the test follows the rule.
  - line 408: `row('..', 'opencode', '/p', '1', '1', '%2')`; expect `readFileSync(marker(home, 'my_session_x%1'), 'utf8')` to be `'my session/x:ready:998:start:%1\n'` and the directory to hold `['my_session_x%1']`.
  - lines 761 and 825: `row('dev', 'opencode', '/other', '1', '1', '%2')`, files `web%1` and `dev%2`, the hook's content `'dev:blocked:1:permission:%2\n'` / `'dev:working:1:prompt:%2\n'`.
  In `test/opencodeAgentRegistry.test.js:510` the file is `'web%1'` and the regex `/^web:ready:\d+:start:%1\n$/`.

  Add:

```js
test('two opencode panes of one tmux session get one marker each; the one that goes back to a shell loses only its own', async () => {
  const { core, home, state } = await rig();
  await core.handle(ev('session.created', 900, { sessionID: 'ses_a' }, '/proj'));
  await core.handle(ev('session.created', 900, { sessionID: 'ses_b' }, '/other'));
  state.t = 1000;
  state.panes = row('web', 'opencode', '/proj', '1', '1', '%1') + row('web', 'opencode', '/other', '0', '1', '%2');
  await core.sweep();
  await core.handle(ev('session.execution.started', 1100, { sessionID: 'ses_a' }));
  await core.handle(ev('session.execution.started', 1150, { sessionID: 'ses_b' }));
  await core.handle(ev('permission.asked', 1200, { id: 'per_1', sessionID: 'ses_b' }, '/other'));
  expect(read(home, 'web%1')).toBe('web:working:1100:prompt:%1\n');
  expect(read(home, 'web%2')).toBe('web:blocked:1200:permission:%2\n');
  expect(readdirSync(markerDir(home)).sort()).toEqual(['web%1', 'web%2']);
  expect([...core.paneSince]).toEqual([['%1', 1000], ['%2', 1000]]);
  expect([...core.since]).toEqual([['web', 1000]]);

  state.t = 1300;
  state.panes = row('web', 'opencode', '/proj', '1', '1', '%1') + row('web', 'zsh', '/other', '0', '1', '%2');
  await core.sweep();
  expect(existsSync(marker(home, 'web%2'))).toBe(false);
  expect(read(home, 'web%1')).toBe('web:working:1100:prompt:%1\n');
  expect(core.paneSince.has('%2')).toBe(false);
  expect(core.since.get('web')).toBe(1000); // the session still hosts opencode: mail's floor does not move
});

test('a pane moved to another tmux session keeps its since; the marker follows and the old file is released', async () => {
  const { core, home, state } = await rig();
  await core.handle(ev('session.created', 900, { sessionID: 'ses_a' }, '/proj'));
  state.t = 1000;
  state.panes = row('web', 'opencode', '/proj', '1', '1', '%4');
  await core.sweep();
  await core.handle(ev('session.execution.started', 1100, { sessionID: 'ses_a' }));
  await core.handle(ev('session.execution.succeeded', 1200, { sessionID: 'ses_a' }));
  expect(read(home, 'web%4')).toBe('web:ready:1200:stop:%4\n');

  state.t = 5000;
  state.panes = row('dev', 'opencode', '/proj', '1', '1', '%4');
  await core.sweep();
  expect(existsSync(marker(home, 'web%4'))).toBe(false);
  expect(read(home, 'dev%4')).toBe('dev:ready:1200:stop:%4\n'); // the finished turn is not lost to a new floor
  expect(core.paneSince.get('%4')).toBe(1000);
  expect([...core.written.keys()]).toEqual(['dev%4']);
});

test('one pane listed under two grouped sessions gets one marker, under the first listed, and it does not flap', async () => {
  const { core, home, state } = await rig();
  state.panes = row('alpha', 'opencode', '/proj', '1', '1', '%3') + row('beta', 'opencode', '/proj', '1', '1', '%3');
  await core.sweep();
  expect(readdirSync(markerDir(home))).toEqual(['alpha%3']);
  const first = statSync(marker(home, 'alpha%3'));
  state.t += 60;
  await core.sweep();
  expect(statSync(marker(home, 'alpha%3')).ino).toBe(first.ino);
});
```

- [ ] **Step 5: Run and see them fail**

Run: `npx vitest run test/opencodeAgentFold.test.js test/opencodeAgentReplay.test.js test/opencodeAgentReplay23.test.js test/opencodeAgentPlugin.test.js test/opencodeAgentRegistry.test.js`
Expected: FAIL. `fold.get('%1')` is `undefined` (the map is keyed by session), `markerLine` returns four fields, the files are named `web`.

- [ ] **Step 6: Implement in the asset.**
  1. `foldForPanes` and `markerLine` as in **Interfaces**. The loop skips a row that is not `opencode`, whose `pane` fails `PANE_ID_RE`, or whose pane id is already in `out`; the floor is `since.get(pane.pane)`.
  2. Core object: add `paneSince: new Map()` beside `since`.
  3. `sweepOnce` (`:2347-2362`), inside the existing `try`, replacing the fold/write loop. The session-keyed block (`hosting`, `core.since`) stays exactly as it is, then:

```js
      const hostingPanes = new Set();
      for (const p of panes) if (isOpencodeCmd(p.cmd)) hostingPanes.add(p.pane);
      for (const id of hostingPanes) if (!core.paneSince.has(id)) core.paneSince.set(id, sinceFloor);
      for (const id of [...core.paneSince.keys()]) if (!hostingPanes.has(id)) core.paneSince.delete(id);

      const live = new Set();
      for (const [pane, fold] of foldForPanes(reducer, panes, core.paneSince, t)) {
        const safe = safeName(fold.session);
        // `.`/`..` cannot be tmux session names, but the listing is untrusted.
        if (!safe || safe === '.' || safe === '..') continue;
        const name = safe + pane;
        const content = markerLine(fold.session, fold, pane);
        live.add(name);
        if (core.written.get(name) !== content && write(name, content)) core.written.set(name, content);
      }
      for (const name of [...core.written.keys()]) if (!live.has(name)) release(name);
```

     `syncMail(complete ? panes : null)` and its call to `mailTargets(reducer, panes, core.since)` are not touched.
  4. `takeOver`: read `prev.paneSince` when it is a `Map` and assign it to the new core, the way `since` is handled.
  5. Comments: the header (`:1-4`) says `~/.tmuxifier-agent/<session><%pane>`; the attribution block (`:473-489`) says a marker is written for every pane running `opencode`, that two panes in one directory show the same state (the limit, since the one shared server gives no per-TUI handle), that `paneSince` follows the pane and `since` follows the tmux session for mail only; `foldForPanes`'s comment says "pane id -> { session, state, cause, ts } for every opencode pane"; the `createCore` comment names `paneSince`.

- [ ] **Step 7: Run and see them pass**

Run: `npx vitest run test/opencodeAgentFold.test.js test/opencodeAgentReplay.test.js test/opencodeAgentReplay23.test.js test/opencodeAgentPlugin.test.js test/opencodeAgentRegistry.test.js test/opencodeAgentReducer.test.js test/opencodeAgentPlugin.pusher.test.js`
Expected: PASS, all files.

- [ ] **Step 8: Prove mail is untouched**

Run:
```bash
git diff --exit-code HEAD -- test/opencodeAgentMailTargets.test.js test/opencodeAgentMail.test.js test/opencodeAgentMailClient.test.js test/opencodeAgentPaneTag.test.js test/opencodeAgentPermission.test.js test/fixtures
npx vitest run test/opencodeAgentMailTargets.test.js test/opencodeAgentMail.test.js test/opencodeAgentMailClient.test.js test/opencodeAgentPaneTag.test.js test/opencodeAgentPermission.test.js
```
Expected: the `git diff` prints nothing and exits 0; vitest PASSES all five files. Then rerun the two `sha256sum` commands of Step 1: both digests are unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/server/assets/tmuxifier-opencode-agent.js test/opencodeAgentFold.test.js test/opencodeAgentReplay.test.js test/opencodeAgentReplay23.test.js test/opencodeAgentPlugin.test.js test/opencodeAgentRegistry.test.js
git commit -m "feat(opencode): one agent marker for every pane running opencode"
```

---

### Task 4: OpenCode plugin takes over from a core of the previous version

The design leaves open how the hand-over tells the old maps from the new (section 11). **Decision: by shape.** The per-pane floor lives under a new property, `paneSince`; `since` keeps its old meaning. A previous core that has a `since` Map and no `paneSince` Map is an older one. `written` needs no detection: an old name (`web`) can never equal a new one (`web%3`) because `safeName` never yields `%`, so the old entries are simply "not live" on the first sweep and `release` deletes each file only while its content is still what the old core wrote.

What does need care is the floor. A new core's first sweep gives a pane it has no floor for `listAt - 2`; right after an upgrade that would hide every turn that started before the reload, a blocked one included. So the first sweep after taking over from an older core seeds each pane's floor from its tmux session's inherited `since`.

**Files:**
- Modify: `src/server/assets/tmuxifier-opencode-agent.js` (`createCore` core object, `sweepOnce`, `takeOver` and its comment)
- Test: `test/opencodeAgentPlugin.test.js`

**Interfaces:**
- Consumes: `core.paneSince`, `core.since`, `core.written`, `markerLine`, `foldForPanes` from Task 3.
- Produces: `core.seedPaneSince : boolean`, `false` on a new core. `takeOver` sets it `true` when `prev.since` is a `Map` and `prev.paneSince` is not, or when `prev.seedPaneSince === true` (a hand-over before the seed was used). The first sweep that parses a listing consumes it.

- [ ] **Step 1: Write the failing tests** in `test/opencodeAgentPlugin.test.js`:

```js
// What a core of the previous asset version leaves on the global: `written`
// and `since` keyed by tmux session, no `paneSince`, and a session blocked
// since 1200 in /proj.
async function olderCore(home, { file = 'web:blocked:1200:permission\n' } = {}) {
  const { createReducer } = await import(ASSET);
  const r = createReducer({ now: () => 1 });
  r.apply(ev('session.created', 900, { sessionID: 'ses_a' }, '/proj'));
  r.apply(ev('session.execution.started', 1100, { sessionID: 'ses_a' }));
  r.apply(ev('permission.asked', 1200, { id: 'per_1', sessionID: 'ses_a' }, '/proj'));
  mkdirSync(markerDir(home), { recursive: true });
  writeFileSync(marker(home, 'web'), file);
  return { abort() {}, state: r.state, written: new Map([['web', 'web:blocked:1200:permission\n']]), since: new Map([['web', 1000]]) };
}
const takeOverOpts = (home, state) => ({
  home, listPanes: async () => state.panes, now: () => state.t, paneCacheMs: 0,
  setInterval: () => ({ unref() {} }), clearInterval: () => {},
});

test('hand-over from an older core: its session-wide marker is released, the pane marker is written, and a block raised before the reload still shows', async () => {
  const { takeOver } = await import(ASSET);
  const home = tmp();
  const state = { t: 5000, panes: row('web', 'opencode', '/proj', '1', '1', '%3') };
  const core = takeOver(await olderCore(home), takeOverOpts(home, state));
  expect(core.seedPaneSince).toBe(true);
  await core.sweep();
  expect(existsSync(marker(home, 'web'))).toBe(false);
  expect(read(home, 'web%3')).toBe('web:blocked:1200:permission:%3\n');
  expect([...core.written.keys()]).toEqual(['web%3']);
  expect(core.paneSince.get('%3')).toBe(1000); // its session's floor, not 4998
  expect(core.since.get('web')).toBe(1000);
  expect(core.seedPaneSince).toBe(false);

  // After the seed, a pane that starts hosting gets the previous listing's time, not its session's floor.
  state.t = 6000;
  state.panes += row('web', 'opencode', '/other', '0', '1', '%4');
  await core.sweep();
  expect(core.paneSince.get('%4')).toBe(5000);
  core.abort();
});

test('hand-over from an older core: a session-wide file the hook rewrote is kept', async () => {
  const { takeOver } = await import(ASSET);
  const home = tmp();
  const state = { t: 5000, panes: row('web', 'opencode', '/proj', '1', '1', '%3') };
  const core = takeOver(await olderCore(home, { file: 'web:working:9:prompt\n' }), takeOverOpts(home, state));
  await core.sweep();
  expect(read(home, 'web')).toBe('web:working:9:prompt\n');
  expect(core.written.has('web')).toBe(false);
  expect(read(home, 'web%3')).toBe('web:blocked:1200:permission:%3\n');
  core.abort();
});

test('a second hand-over before the first sweep still seeds the pane floors from the older core', async () => {
  const { takeOver } = await import(ASSET);
  const home = tmp();
  const state = { t: 5000, panes: row('web', 'opencode', '/proj', '1', '1', '%3') };
  const first = takeOver(await olderCore(home), takeOverOpts(home, state));
  const second = takeOver(first, takeOverOpts(home, state)); // OpenCode set the plugin up for another directory
  expect(second.seedPaneSince).toBe(true);
  await second.sweep();
  expect(read(home, 'web%3')).toBe('web:blocked:1200:permission:%3\n');
  expect(second.paneSince.get('%3')).toBe(1000);
  second.abort();
});

test('a hand-over between two cores of this version seeds nothing', async () => {
  const { takeOver } = await import(ASSET);
  const home = tmp();
  const state = { t: 5000, panes: '' };
  const first = takeOver(null, takeOverOpts(home, state));
  await first.sweep();
  const second = takeOver(first, takeOverOpts(home, state));
  expect(second.seedPaneSince).toBe(false);
  expect(second.paneSince).toBe(first.paneSince);
  second.abort();
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run test/opencodeAgentPlugin.test.js`
Expected: FAIL. `core.seedPaneSince` is `undefined`, and the first test reads `web:ready:4998:start:%3` (the block at 1200 is below the `listAt - 2` floor). The second test's `web` assertions already pass: Task 3's `release` does that part.

- [ ] **Step 3: Implement.**
  1. Core object: `seedPaneSince: false`.
  2. `takeOver`: inside the existing `try`, `const seed = (prev.since instanceof Map && !(prev.paneSince instanceof Map)) || prev.seedPaneSince === true;` and, after the core is built, `if (seed) core.seedPaneSince = true;`.
  3. `sweepOnce`: read and clear the flag right before the pane floors are set, and use it for the panes this sweep adds:

```js
      const fromSession = core.seedPaneSince === true;
      core.seedPaneSince = false;
      for (const p of panes) {
        if (!isOpencodeCmd(p.cmd) || core.paneSince.has(p.pane)) continue;
        const inherited = fromSession ? core.since.get(p.session) : undefined;
        core.paneSince.set(p.pane, Number.isFinite(inherited) ? inherited : sinceFloor);
      }
```

     This runs after the session-keyed `core.since` update of the same sweep, so a session that only just started hosting reads `sinceFloor` either way. It replaces the plain `core.paneSince.set(id, sinceFloor)` line of Task 3; the delete loop stays.
  4. Rewrite `takeOver`'s comment (`:2469-2484`) to say what is inherited now: `written` as is (old session-wide names are released by the first sweep under the content rule), `paneSince` when the previous core has one, otherwise the seed from `since`, and `since` itself for mail.

- [ ] **Step 4: Run and see them pass, and prove mail is untouched again**

Run:
```bash
npx vitest run test/opencodeAgentPlugin.test.js test/opencodeAgentRegistry.test.js test/opencodeAgentFold.test.js test/opencodeAgentReplay.test.js test/opencodeAgentReplay23.test.js
git diff --exit-code b78a4aa -- test/opencodeAgentMailTargets.test.js test/opencodeAgentMail.test.js test/opencodeAgentMailClient.test.js test/opencodeAgentPaneTag.test.js test/opencodeAgentPermission.test.js test/fixtures
npx vitest run test/opencodeAgentMailTargets.test.js test/opencodeAgentMail.test.js test/opencodeAgentMailClient.test.js test/opencodeAgentPaneTag.test.js test/opencodeAgentPermission.test.js
```
Expected: PASS everywhere; the `git diff` prints nothing; the two `sha256sum` commands of Task 3 Step 1 still print the same digests.

- [ ] **Step 5: Commit**

```bash
git add src/server/assets/tmuxifier-opencode-agent.js test/opencodeAgentPlugin.test.js
git commit -m "feat(opencode): take over from a session-keyed core without losing a pane's state"
```

---

### Task 5: Describe the two writers as they are now, and run everything

Plan 1 owns the rest of these four files. Touch only the sentences quoted here; if plan 1 has already reworded one, keep its wording and make sure it still states the same facts.

**Files:**
- Modify: `CLAUDE.md` and `AGENTS.md` (the `opencodeAgentPlugin.js` and `oscReporter.js` entries; the two files carry the same text), `docs/boxes-and-setup.md` (the paragraph beginning "That shared server is also why"), `docs/fleet-and-health.md` (the sentence beginning "Every OpenCode TUI on a box talks to one shared OpenCode server")

**Interfaces:**
- Consumes: the behaviour of Tasks 1-4.
- Produces: nothing other tasks use.

- [ ] **Step 1: `CLAUDE.md` and `AGENTS.md`, the `opencodeAgentPlugin.js` entry.** Replace "attributed by directory to the tmux sessions whose active pane of the active window runs `opencode` there (two TUIs in one directory fold to one state), writes the same `<session>:<state>:<epoch>:<cause>` markers" with:

  > attributed by directory to every tmux pane running `opencode` there (two panes in one directory show the same state), writes one `<session>:<state>:<epoch>:<cause>:<%pane>` marker per pane (file `<session><%pane>`, as the hook)

  and, in the sentence about the singleton, replace "(what it wrote, and its reducer state under `STATE_VERSION`" with:

  > (what it wrote, each pane's `paneSince` floor, and its reducer state under `STATE_VERSION`; a core taking over from one that has `since` but no `paneSince`, the session-keyed version, seeds each pane's floor from its tmux session's on its first sweep, and that sweep releases the old session-wide files under the content rule; `since` stays per tmux session because it is mail's floor

- [ ] **Step 2: `CLAUDE.md` and `AGENTS.md`, the `oscReporter.js` entry.** Replace "folds records, writes the same `<session>:<state>:<epoch>:<cause>` markers)" with:

  > folds its own pane's records and writes that pane's `<session>:<state>:<epoch>:<cause>:<%pane>` marker, file `<session><%pane>`; it never reads a sibling pane, the file it owns is the one its `lastWritten` line names, and it removes that file only while the content is still that line. A listener that inherits a four-field `lastWritten` from an older version removes that session-wide file under the same rule and writes its pane's marker from the inherited records)

  and extend the test inventory sentence ("five more tests pin ...") with: "a split pane and a background-window pane each keeping their own marker, and a handover migrating an older listener's session-wide marker".

- [ ] **Step 3: `docs/boxes-and-setup.md`.** Replace the paragraph's first three sentences (through "the combined state of everything OpenCode is doing there.") with:

  > That shared server is also why the plugin can't tell two TUIs in the same directory apart: it matches each OpenCode session to **every tmux pane that runs `opencode` in the same directory**. Each such pane has its own state, in a background window too, but two TUIs started in one directory both show the combined state of everything OpenCode is doing there.

- [ ] **Step 4: `docs/fleet-and-health.md`.** Replace "the state is matched to tmux sessions by directory: two TUIs in the same directory in different tmux sessions show the same combined state" with:

  > the state is matched to tmux panes by directory: two TUIs in the same directory show the same combined state

- [ ] **Step 5: Check the Claude hook was never touched, then run everything**

Run:
```bash
git diff --exit-code b78a4aa -- src/server/assets/tmuxifier-agent-hook.sh src/server/oscReporter.js src/server/opencodeAgentPlugin.js test/fixtures test/agentHooksReplay.test.js test/agentHooksNestedReplay.test.js test/agentMailWakeReplay.test.js
diff <(sed 1d CLAUDE.md | grep -n 'paneSince\|lastWritten') <(sed 1d AGENTS.md | grep -n 'paneSince\|lastWritten')
npm test
```
Expected: both diffs print nothing; `npm test` ends with the typecheck clean and every vitest file passing.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md AGENTS.md docs/boxes-and-setup.md docs/fleet-and-health.md
git commit -m "docs(agents): the OSC reporter and the OpenCode plugin write one marker per pane"
```
