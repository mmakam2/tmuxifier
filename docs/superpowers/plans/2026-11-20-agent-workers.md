# Agent Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A send to a box with no agent starts an interactive Claude Code there in its own tmux session and delivers the message to it; a lead can ask for a fresh one; the operator can start one from the dashboard.

**Architecture:** A per-box settings store (`data/agent-workers.json`) and a starter that runs one remote script over the ControlMaster to create a detached tmux session whose command is `exec "$SHELL" -ic 'exec claude'`. The mail hub's `send` calls the starter where it refuses `no-agent` today; the message is queued for the new session and reaches it through the existing waiter path, unchanged. The hub watches each start it made, in memory, on every `boxChanged`.

**Tech Stack:** Node ESM plain `.js` server (factories with injected dependencies), POSIX `sh` box-side scripts, TypeScript web client (pure half + DOM half), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-agent-workers-design.md`. Read it and the "Agent messaging" and "Load-bearing rules" parts of `CLAUDE.md` before any task.

## Global Constraints

- Work in a worktree made with `git worktree add <path> -b feat/agent-workers HEAD` from the main checkout (not a tool that branches from `origin`). Never commit a `node_modules` symlink. Never run `npm run build` in the main checkout.
- The spec and this plan are untracked in the main checkout. Move both into the worktree and commit them there as the first commit (`docs(agent-workers): design and plan`).
- **Never run a tmux command against the default server.** Any tmux a test or a manual check runs goes through `env -u TMUX -u TMUX_PANE tmux -S <scratch socket>` or a `-L <unique>` wrapper under a private `TMUX_TMPDIR` and `HOME`, as `test/osc7501Tmux.integration.test.js` does. Put this rule verbatim in every subagent brief.
- tmux targets are exact: `-t '=<name>'`. Explicit names are validated, never rewritten.
- Project name: `^[a-z0-9][a-z0-9-]{0,23}$`. Directory: `^/[A-Za-z0-9._/-]{1,199}$`, no `..` segment, no `//`, no trailing `/`. Projects per box: 0..8. `max`: 1..8, default 3. Session name: `worker-<project>-<n>`.
- The directory is re-validated immediately before it is single-quoted into a remote script. Nothing a lead sent is ever in a script; a project name is a lookup key only.
- A worker is never started while the box's setup job is `running`.
- Launch line, exactly: `new-session -d -s '<session>' -c '<dir>' 'exec "$SHELL" -ic '\''exec claude'\'''`. A plain `'claude'` command does not work (spec section 4).
- Thresholds: a start is judged failed at 30 s, stuck at 60 s.
- Every sentence an agent reads lives in `src/server/agentMailText.js`.
- Web: every fetch goes through `http.ts`; a form-line modifier is `bad`, never `err`; text from boxes or agents is `textContent` only.
- Tests use real code. Vitest has no DOM. A bare RegExp inside `toMatchObject` matches anything: use `expect.stringMatching`.
- Box-side script runs under the box's login shell (often zsh, bare `PATH`): no word-splitting assumptions, no unmatched globs.
- Public repo: placeholders only (`/opt/billing-api`, `example.com`, `192.168.1.10`).
- Commits: conventional messages, ending with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Checks: `npx vitest run <file>` per task; `npm test` (typecheck + vitest) before each commit that touches `src/web`.

## Review Focus

1. **A listing older than the start.** The hub's first `boxChanged` after a start may read a snapshot taken before the session existed. Expected: the thread stays open until 30 s have passed. Test in Task 9.
2. **Two bare-name sends arriving together at a box with no agent.** Expected: one worker, two threads on it. Two `--fresh` sends together: two workers with different names. Tests in Tasks 5 and 8.
3. **Tmuxifier restarts while a worker is starting.** Expected: the queued message is delivered when the marker appears, with no in-memory entry. Test in Task 9.
4. **`~/.claude.json` that is malformed, or whose `projects` is not an object.** Expected: the file is left byte-identical, the launch still happens. Test in Task 4.
5. **A `fresh` value on the wire that is not a project name** (`API`, 25 characters, `../x`, given twice). Expected: 400 before any hub call. Test in Task 11.

---

### Task 1: Worker rules (pure)

**Files:**
- Create: `src/server/agentWorkerRules.js`
- Test: `test/agentWorkerRules.test.js`

**Interfaces:**
- Consumes: `agentKindOf(paneCmd)` from `src/server/healthHistory.js`.
- Produces:
  - `PROJECT_NAME_RE`, `WORKER_DIR_RE` (the two regexes above), `MAX_PROJECTS = 8`, `WORKERS_MAX_LIMIT = 8`, `WORKERS_MAX_DEFAULT = 3`, `WORKER_PREFIX = 'worker-'`
  - `WORKER_MODES = Object.freeze(['interactive'])`
  - `WORKER_AGENTS = Object.freeze({ claude: Object.freeze({ launch: 'claude', kind: 'claude' }) })`
  - `EMPTY_WORKERS = Object.freeze({ projects: Object.freeze([]), mailStart: false, max: 3 })`
  - `isWorkerDir(dir: unknown): boolean`
  - `normalizeWorkers(raw: unknown): { projects: { name, dir, trust }[], mailStart: boolean, max: number }` — throws `Error`
  - `workerSessionName(project: string, sessionNames: string[]): string`
  - `runningWorkers(sessions: { name: string, paneCmd: string }[]): number`

- [ ] **Step 1: Write the failing tests**

```js
test('isWorkerDir accepts absolute paths in the allowlist only', () => {
  for (const ok of ['/opt/billing-api', '/root/dir', '/srv/a.b_c-d/e']) expect(isWorkerDir(ok)).toBe(true);
  for (const bad of ['', '/', 'opt/x', '/opt/x/', '/opt//x', '/opt/../etc', '/opt/x y', "/opt/x'", '/opt/$HOME', '/opt/x;ls', `/${'a'.repeat(200)}`, 7, null])
    expect(isWorkerDir(bad)).toBe(false);
});
test('normalizeWorkers fills defaults and keeps order', () => {
  expect(normalizeWorkers({ projects: [{ name: 'api', dir: '/opt/billing-api' }, { name: 'web', dir: '/opt/web', trust: true }] }))
    .toEqual({ projects: [{ name: 'api', dir: '/opt/billing-api', trust: false }, { name: 'web', dir: '/opt/web', trust: true }], mailStart: false, max: 3 });
});
test('normalizeWorkers refuses bad input, naming the field', () => {
  const p = (name, dir) => ({ name, dir });
  expect(() => normalizeWorkers(null)).toThrow('workers must be an object');
  expect(() => normalizeWorkers({ projects: 'x' })).toThrow('projects must be an array');
  expect(() => normalizeWorkers({ projects: Array.from({ length: 9 }, (_, i) => p(`p${i}`, '/opt/x')) })).toThrow('too many projects');
  expect(() => normalizeWorkers({ projects: [p('API', '/opt/x')] })).toThrow('bad project name');
  expect(() => normalizeWorkers({ projects: [p('api', '/opt/../x')] })).toThrow('bad directory');
  expect(() => normalizeWorkers({ projects: [p('api', '/opt/x'), p('api', '/opt/y')] })).toThrow('duplicate project name');
  for (const max of [0, 9, 1.5, '3']) expect(() => normalizeWorkers({ projects: [], max })).toThrow('max must be 1 to 8');
});
test('trust and mailStart are on only for a literal true', () => {
  const w = normalizeWorkers({ projects: [{ name: 'api', dir: '/opt/x', trust: 'yes' }], mailStart: 1 });
  expect(w.projects[0].trust).toBe(false);
  expect(w.mailStart).toBe(false);
});
test('workerSessionName takes the lowest free number, skipping leftovers', () => {
  expect(workerSessionName('api', [])).toBe('worker-api-1');
  expect(workerSessionName('api', ['main', 'worker-api-1', 'worker-api-3', 'worker-web-2'])).toBe('worker-api-2');
});
test('runningWorkers counts worker sessions whose pane runs claude', () => {
  expect(runningWorkers([
    { name: 'worker-api-1', paneCmd: 'claude' }, { name: 'worker-api-2', paneCmd: 'zsh' },
    { name: 'worker-x', paneCmd: 'claude' }, { name: 'main', paneCmd: 'claude' }, { name: 'worker-web-1', paneCmd: 'codex' },
  ])).toBe(2);
});
```

- [ ] **Step 2: Run** `npx vitest run test/agentWorkerRules.test.js` — FAIL, module not found.
- [ ] **Step 3: Implement the exports above in `src/server/agentWorkerRules.js`.** Header comment: the record shape and why the directory is checked twice (spec 5.1).
- [ ] **Step 4: Run the test** — PASS.
- [ ] **Step 5: Commit** `feat(workers): worker settings rules`.

### Task 2: Worker settings store

**Files:**
- Create: `src/server/agentWorkerStore.js`
- Test: `test/agentWorkerStore.test.js`

**Interfaces:**
- Consumes: Task 1's `normalizeWorkers`, `EMPTY_WORKERS`; `readJson`/`writeJson` from `jsonFile.js`.
- Produces: `createAgentWorkerStore({ dataDir })` → `{ all(): Promise<map>, get(id): Promise<record>, set(id, raw): Promise<record>, removeBox(id): Promise<void> }`. File `agent-workers.json`: `{ version: 1, boxes: { <id>: record } }`. `get` of an unknown id returns `EMPTY_WORKERS`. Returned records are copies.

Follow `src/server/agentMailPolicyStore.js` line for line in structure: lazy load, null-prototype map, one promise chain, adopt only if persisted.

- [ ] **Step 1: Write the failing tests** (temp dir per test):
  - `set` then `get` round-trips the normalized record; a new store over the same directory reads it back.
  - The file's mode is `0o600`.
  - `set` with a bad record rejects with the rule's message and leaves `get` and the file as they were.
  - Two overlapping `set` calls for different boxes both land.
  - An id named `__proto__` is an ordinary key: `set('__proto__', …)` then `get('constructor')` is `EMPTY_WORKERS`.
  - A stored entry that no longer passes `normalizeWorkers` (hand-edited file: `dir: '/x/../y'`) loads as absent.
  - `removeBox` drops the entry.
- [ ] **Step 2: Run** `npx vitest run test/agentWorkerStore.test.js` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(workers): worker settings store`.

### Task 3: The start script

**Files:**
- Create: `src/server/agentWorkers.js` (script builder and result parser only in this task)
- Create: `test/helpers/workerBench.js`
- Test: `test/agentWorkerScript.integration.test.js`

**Interfaces:**
- Consumes: `SESSION_NAME_RE` from `sshCommand.js`; Task 1's `isWorkerDir`, `WORKER_AGENTS`.
- Produces:
  - `WORKER_CODES = Object.freeze(['started', 'exists', 'no-tmux', 'no-dir', 'no-agent-binary'])`
  - `buildWorkerStartRemote({ session, dir, agent = 'claude', trust = false }): string` — throws `Error` on a session that fails `SESSION_NAME_RE`, a dir that fails `isWorkerDir`, or an agent id that is not an own key of `WORKER_AGENTS`.
  - `parseWorkerResult(stdout): string | null` — the code of the **last** line that is exactly `WORKER: <code>` with `<code>` in `WORKER_CODES`; anything else is `null`.
  - `test/helpers/workerBench.js`: `createWorkerBench({ defaultShell })` → `{ home, env, tmux(...args): string, run(shell, remote): { code, stdout }, standInLog(session): string | null, cleanup() }`. It makes a temp dir with: a `bin/tmux` wrapper (`exec <real tmux> -L <unique socket> "$@"`) first on `PATH`; a private `TMUX_TMPDIR`; `HOME` with `.profile`, `.bashrc`, `.zshrc` each holding the two tagged rc lines (`CLAUDE_TOKEN_RC_LINE` from `aiAuthSeed.js`, and `export PATH="$HOME/.local/bin:$PATH" # tmuxifier-local-bin`); a fake token file; and a stand-in `~/.local/bin/claude` that writes `token=<set|unset> cwd=<pwd> tty=<yes|no>` to `<home>/standin/<session name>` and then `exec`s `sleep 600`. `env` has no `TMUX` or `TMUX_PANE`. `run` executes `<shell> -c <remote>` with `PATH=<bench bin>:/usr/bin:/bin` (so the stand-in is **not** on the script's `PATH`, as on a box). `cleanup` runs `kill-server` on the private server only.

The script's steps, in order, each ending the run with exit 0 after printing its line: resolve tmux with the same `command -v` plus fallback sweep as `buildEnsureSessionRemote` (`no-tmux`); `[ -d '<dir>' ]` (`no-dir`); `command -v claude` or `[ -x "$HOME/.local/bin/claude" ]` (`no-agent-binary`); `has-session -t '=<session>'` (`exists`); the launch line from Global Constraints (`started`). `set -eu` at the top; a tmux failure on the launch exits non-zero with no `WORKER:` line.

- [ ] **Step 1: Write the failing tests.** Matrix: script shell ∈ `sh`, `bash`, `zsh` × tmux `default-shell` ∈ `bash`, `zsh` (a shell missing on the machine fails the suite loudly, as a missing `sshd` does in `localBox.js`).
  - For each cell: `run` prints `WORKER: started`; within 5 s `standInLog('worker-api-1')` is `token=set cwd=<dir> tty=yes`; `tmux list-sessions` shows `worker-api-1`.
  - A second run with the same session prints `WORKER: exists` and creates nothing.
  - A dir that does not exist: `WORKER: no-dir`, no session.
  - A home with no stand-in: `WORKER: no-agent-binary`, no session.
  - `buildWorkerStartRemote` throws for sessions `a b`, `=x`, `''` and dirs `/opt/x'`, `/opt/x y`, `/opt/../x`, and for `agent: 'codex'`.
  - `parseWorkerResult`: `'noise\nWORKER: started\n'` → `'started'`; `'WORKER: started extra'`, `'WORKER: rm -rf'`, `''` → `null`; two lines → the last.
  - The built script contains the session only as `'=worker-api-1'` or `'worker-api-1'` (no bare `-t worker-api-1`).
- [ ] **Step 2: Run** `npx vitest run test/agentWorkerScript.integration.test.js` — FAIL.
- [ ] **Step 3: Implement `buildWorkerStartRemote`, `parseWorkerResult`, `WORKER_CODES` and the bench helper.** Module header comment: the launch table from spec section 4 and why the plain command fails.
- [ ] **Step 4: Run** — PASS, every cell.
- [ ] **Step 5: Commit** `feat(workers): start script for a detached agent session`.

### Task 4: The trust write

**Files:**
- Modify: `src/server/agentWorkers.js` (`buildWorkerStartRemote` when `trust` is true)
- Test: `test/agentWorkerTrust.integration.test.js`

**Interfaces:**
- Consumes: Task 3's builder and bench.
- Produces: with `trust: true` the script prints, before its `WORKER:` line, exactly one of `WORKER-TRUST: written | already | failed | no-json-tool`; `parseWorkerTrust(stdout): 'written' | 'already' | 'failed' | 'no-json-tool' | null` (same last-exact-line rule).

Behaviour (spec 5.5): the block runs after the `no-agent-binary` check and before `has-session`. It reads `$HOME/.claude.json`; when `.projects["<dir>"].hasTrustDialogAccepted` is already `true` it writes nothing (`already`). Otherwise it sets that one key, preserving everything else, through a temp file in the same directory and a rename, keeping the file's mode; a file that does not exist is created `0600` holding only that key. Tool order jq → node → python3. Any failure (unparseable JSON, a top level or `projects` that is not an object, a tool error) prints `failed`, leaves the file untouched, and the script goes on to launch. The directory reaches the JSON tool as a single-quoted argument, never inside program text.

- [ ] **Step 1: Write the failing tests.** Run each case three times, once per tool, by giving `run` a `PATH` farm holding only that tool (copy the PATH-farm approach of `test/claudeAgentMail.test.js`), plus one case with none of the three (`no-json-tool`, launch still happens).
  - No file → `written`; file is `{"projects":{"<dir>":{"hasTrustDialogAccepted":true}}}` semantically; mode `0600`.
  - Existing file with other top-level keys, another project and other keys under this project → `written`; all of them preserved; mode unchanged (`0644` stays `0644`).
  - Key already `true` → `already`; the file's bytes and inode are unchanged.
  - Malformed JSON → `failed`; bytes unchanged; `WORKER: started` still printed.
  - `"projects": []` and top-level `[]` → `failed`; bytes unchanged.
  - `trust: false` → no `WORKER-TRUST:` line and no file created.
- [ ] **Step 2: Run** `npx vitest run test/agentWorkerTrust.integration.test.js` — FAIL.
- [ ] **Step 3: Implement the block and `parseWorkerTrust`.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(workers): optional folder-trust write before launch`.

### Task 5: The starter

**Files:**
- Modify: `src/server/agentWorkers.js`
- Test: `test/agentWorkers.test.js`, `test/agentWorkers.integration.test.js`

**Interfaces:**
- Consumes: Tasks 1–4; `boxActions.execCommand(box, remote, { timeoutMs })` → `{ code, stdout, stderr }`.
- Produces: `createAgentWorkers({ execCommand, workerStore, setupRunning, sessionsOf, now = () => Date.now() })` → `{ start(box, { project, mode = 'interactive' } = {}) }`.
  - `setupRunning(boxId): boolean`; `sessionsOf(boxId): { name, paneCmd }[] | null` (`null` = box not reachable).
  - `start` resolves `{ ok: true, session, project, trust }` (`trust` = `parseWorkerTrust` result or `null`) or `{ ok: false, code }` with `code` one of `bad-mode`, `setup-running`, `unreachable`, `no-project`, `worker-cap`, `no-tmux`, `no-dir`, `no-agent-binary`, `start-failed`. It never throws.

Rules (spec 5.2): order of checks is mode, setup, reachable, project (no name = first; no projects = `no-project`), cap, then the script with `timeoutMs: 20000`. Calls for one box run one after another on a per-box promise chain. Names the starter itself started in the last 60 s count as taken and as running even when `sessionsOf` does not list them yet. On `exists`, retry once with the next number; a second `exists`, a non-zero exit, or an unparseable result is `start-failed`.

- [ ] **Step 1: Write the failing unit tests** (`test/agentWorkers.test.js`): real store in a temp dir; `execCommand` runs the remote through Task 3's bench (`bench.run('sh', remote)`), so the script is real.
  - Default project: `start(box)` → `{ ok: true, session: 'worker-api-1', project: 'api' }`; named project `web` → `worker-web-1`.
  - Unknown project → `no-project`; a box with no record → `no-project`; nothing was executed (count `execCommand` calls).
  - `setupRunning` true → `setup-running`, nothing executed. `sessionsOf` null → `unreachable`, nothing executed. `mode: 'headless'` → `bad-mode`.
  - Cap: `max: 2`, `sessionsOf` lists two `worker-*` sessions running `claude` → `worker-cap`. The same two with `paneCmd: 'zsh'` → starts `worker-api-3`.
  - **Review Focus 2:** two `start` calls made together with a `sessionsOf` that returns `[]` both times → sessions `worker-api-1` and `worker-api-2`.
  - `max: 1`, one `start` succeeded, `sessionsOf` still `[]` → the next `start` is `worker-cap`.
  - A project whose dir is missing on the bench → `no-dir`.
- [ ] **Step 2: Write the failing integration test** (`test/agentWorkers.integration.test.js`): `setupLocalBox()` and a real `createBoxActions` as in `test/sessionCreate.integration.test.js`; put the stand-in `claude` and the rc lines into `lb.home` (reuse the bench's file writers). `start` over real ssh → `tmux has-session -t '=worker-api-1'` on the box succeeds and the stand-in log shows `token=set`.
- [ ] **Step 3: Run both files** — FAIL.
- [ ] **Step 4: Implement `createAgentWorkers`.**
- [ ] **Step 5: Run both files** — PASS.
- [ ] **Step 6: Commit** `feat(workers): starter with cap, naming and setup gate`.

### Task 6: Words

**Files:**
- Modify: `src/server/agentMailText.js`, `src/server/agentMailStore.js`, `src/web/agentMail.ts` (`MailCloseReason`)
- Test: `test/agentMailText.test.js`, `test/agentMailStore.test.js`

**Interfaces:**
- Produces:
  - `agentMailStore.js`: `export const WORKER_FAILED_REASON = 'worker did not start'`, added to `CLOSE_REASONS`.
  - `statusPhrase` kinds: `queued-starting` → `queued: ${who} is starting`; `queued-startup-prompt` → `queued: ${who} is waiting for its operator at a start-up prompt`; `closed-worker-failed` → `closed: the new agent did not start; tell your operator`.
  - `refusalText` codes, `ctx` `{ target, project }`:
    - `workers-off` → `refused: ${target} does not start agents on request`
    - `mail-not-set-up` → `refused: agent messaging is not set up on ${target}; tell your operator`
    - `setup-running` → `${target} is being set up right now; try again shortly`
    - `no-project` → `refused: ${target} has no project named "${project}"; run "tmx who"`
    - `worker-cap` → `refused: ${target} already runs as many started agents as its operator allows`
    - `no-dir` → `refused: the project directory is missing on ${target}; tell your operator`
    - `no-agent-binary` → `refused: Claude Code is not installed on ${target}; tell your operator`
    - `no-tmux` → `refused: tmux is not installed on ${target}; tell your operator`
    - `start-failed` → `starting an agent on ${target} failed; try again shortly, then tell your operator`
    - `several-agents` → `refused: ${target} runs more than one agent; name one (run "tmx who")`
    - `fresh-needs-box` → `refused: --fresh takes a box name, not a session`
  - `renderWho(rows, starters = [])`: `starters` is `[{ box, projects: string[] }]`; each adds a line `${box}  can start an agent (projects: ${projects.join(', ')})` after the session rows. With no rows and at least one starter, only the starter lines are printed (no `nobody:` line).

- [ ] **Step 1: Write the failing tests:** one exact-string assertion per new kind and code; `renderWho` with rows + starters, starters only, neither (unchanged `nobody:` text); `closeThread(id, WORKER_FAILED_REASON)` closes and drops undelivered messages; an unknown reason still throws.
- [ ] **Step 2: Run** `npx vitest run test/agentMailText.test.js test/agentMailStore.test.js` — FAIL.
- [ ] **Step 3: Implement.** Add `'worker did not start'` to the web `MailCloseReason` union.
- [ ] **Step 4: Run, plus `npm run typecheck`** — PASS.
- [ ] **Step 5: Commit** `feat(mail): wording for started agents`.

### Task 7: Bare names resolve to an agent that can take mail

**Files:**
- Modify: `src/server/agentMailHub.js`, `test/helpers/agentMailHarness.js`
- Test: `test/agentMailHubWorkers.test.js` (new)

**Interfaces:**
- Consumes: `agentKindOf` from `healthHistory.js`; Task 6's `several-agents`.
- Produces:
  - `createAgentMailHub` gains `sessionsOf = () => null` (`(boxId) => { name, paneCmd }[] | null`).
  - `resolveTarget` results gain `bare: boolean` (true for `.` and for a whole-label match).
  - `createMailHarness(hubOptions, world)` accepts `world.sessions` (`{ <box id>: { name, paneCmd }[] }`) and wires `sessionsOf` from it; absent means `null`.

Behaviour (spec 5.3 table and the paragraph above it), for a `bare` target only, after the existing checks up to and including `reachable`:
1. Sessions that can take mail = those with a marker whose pane kind is `claude`, `opencode` or `null`; when `sessionsOf` is `null`, every session with a marker. The caller's own session is removed.
2. The configured session is in that set → it. Else exactly one in the set → it. Else two or more → refuse `several-agents`. Else none → for now, refuse `no-agent` exactly as today (Task 8 replaces this branch).

An explicit `box/session` target is untouched.

- [ ] **Step 1: Write the failing tests:**
  - Configured session has an agent → thread to it (unchanged).
  - No agent in the configured session, one Claude in `side` → thread peer is `side`.
  - Two elsewhere → `several-agents`, logged as a refusal.
  - Configured session's pane runs `codex` (marker present), one Claude in `side` → peer is `side`.
  - Only a `codex` session → `no-agent`.
  - `sessionsOf` null, marker only in `side` → peer is `side`.
  - Caller in `side` of its own box sends to `.` with no other agent → `no-agent` (not `own-session`); with one other agent → that one.
  - `b/side` explicit, no agent there → `no-agent`, as today.
- [ ] **Step 2: Run** `npx vitest run test/agentMailHubWorkers.test.js` — FAIL.
- [ ] **Step 3: Implement.** Run `npx vitest run test/agentMailHub.test.js test/agentMailHubDelivery.test.js` too: every existing test must pass unchanged.
- [ ] **Step 4: Commit** `feat(mail): a bare box name finds the agent that can take mail`.

### Task 8: A send starts a worker

**Files:**
- Modify: `src/server/agentMailHub.js`, `test/helpers/agentMailHarness.js`
- Test: `test/agentMailHubWorkers.test.js`

**Interfaces:**
- Consumes: Task 5's `start`; Task 2's store `get`; Task 6's codes.
- Produces:
  - `createAgentMailHub` gains `workers = null` (`{ start }`), `workerStore = null` (`{ get }`), `mailInstalled = () => false` (`(boxId) => boolean`).
  - `send(caller, target, rawBody, { fresh } = {})`: `fresh` is `undefined` (not asked), `''` (default project) or a project name.
  - Internal `starts`: a list of `{ boxId, session, threadIds: string[], at, bare, stuck: false }` (Task 9 reads it).
  - Harness: `world.workers` (`{ <box id>: raw record }`) builds a real worker store and a real `createAgentWorkers` whose `execCommand` runs through Task 3's bench; `world.installed` (box ids) feeds `mailInstalled`.

Behaviour (spec 5.3), placed where Task 7 left the "none" branch, and for `fresh !== undefined`:
- `fresh` given with a target that is not `bare` → refuse `fresh-needs-box`.
- Not `fresh`, and a `starts` entry with `bare: true` exists for the box whose session has no marker yet → the peer is that session; add the new thread id to the entry; no start.
- Otherwise, in this order: `workers` or `workerStore` null, or the box's `mailStart` not `true` → `workers-off` when `fresh` was given, `no-agent` (today's wording) when not; `mailInstalled(boxId)` false → `mail-not-set-up`; `store.hasRoom(closeForStorage)` false → `store-full`; `await workers.start(box, { project: fresh || undefined })`; not ok → refuse with its code (`unreachable` uses the existing wording; `bad-mode` maps to `start-failed`).
- On `started`: create the thread with peer `{ boxId, session }`, add the message, push the `starts` entry, call `queued(...)`. The answer is the usual `sentText`.

Refusal `ctx`: `target` is what the caller typed (cleaned), `project` is the cleaned `fresh`.

- [ ] **Step 1: Write the failing tests** (bench-backed starter; settle markers by writing them into the harness's marks, as the existing hub tests do):
  - Box with no agent, `mailStart` on, installed → `ok`; thread peer `b/worker-api-1`; the bench's tmux lists the session; the message is `queued`.
  - Then the marker for `worker-api-1` turns `ready` and a waiter connects → the message is handed (existing delivery).
  - `mailStart` off: bare → `no-agent`; `fresh: ''` → `workers-off`. Nothing started.
  - Not installed → `mail-not-set-up`. Nothing started.
  - `fresh: 'web'` → `worker-web-1`. `fresh: 'nope'` → `no-project` naming `nope`.
  - `fresh: ''` while an agent runs in the configured session → still starts a worker.
  - `fresh: ''` with target `b/side` → `fresh-needs-box`.
  - Cap reached → `worker-cap`.
  - Sender's `send` switch off → `send-off` and the starter was never asked (existing order holds).
  - **Review Focus 2:** two bare sends awaited together → one session on the bench, two threads with the same peer.
  - Two `fresh: ''` sends together → `worker-api-1` and `worker-api-2`.
  - `workers: null` (messaging without the starter) → `no-agent`.
- [ ] **Step 2: Run** `npx vitest run test/agentMailHubWorkers.test.js` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the three hub suites** — PASS.
- [ ] **Step 5: Commit** `feat(mail): a send starts an agent on a box that has none`.

### Task 9: A worker that does not come up

**Files:**
- Modify: `src/server/agentMailHub.js`
- Test: `test/agentMailHubWorkers.test.js`

**Interfaces:**
- Consumes: Task 8's `starts`; `WORKER_FAILED_REASON`; Task 6's status kinds.
- Produces: `CLOSED_KIND['worker did not start'] = 'closed-worker-failed'`; exported `WORKER_FAIL_MS = 30000`, `WORKER_STUCK_MS = 60000`.

Behaviour (spec 5.6). `boxChanged(boxId)` first checks every `starts` entry of that box, before its existing early return:

| Observation | Action |
|---|---|
| a marker exists for the session | drop the entry |
| `sessionsOf(boxId)` is `null` | leave it |
| age ≥ 30 s and (session not listed, or listed with a pane kind other than `claude`) | `endThread(id, WORKER_FAILED_REASON)` for each thread of the entry; one `store.addRefusal({ from: <thread starter>, target: <box label>, reason: statusPhrase('closed-worker-failed') })` per thread; drop the entry |
| age ≥ 60 s, listed, pane kind `claude`, no marker | set `stuck: true` |

`queuedStatus(boxes, recipient)`: when a `starts` entry matches the recipient, return `queued-startup-prompt` if `stuck`, else `queued-starting`, before the existing `!running` branch.

- [ ] **Step 1: Write the failing tests** (harness clock):
  - **Review Focus 1:** `boxChanged` at +5 s with the session not listed → thread still open, status `queued: b/worker-api-1 is starting`.
  - At +31 s not listed → thread closed, reason `worker did not start`; a held `waitReplies` on it settles with `closed: the new agent did not start; tell your operator`; one refusal logged.
  - At +31 s listed with `paneCmd: 'zsh'` → same close. Listed with `paneCmd: 'claude'` → still open.
  - At +61 s listed, `claude`, no marker → open, status `queued: b/worker-api-1 is waiting for its operator at a start-up prompt`; then the marker appears and a waiter connects → delivered.
  - Marker present at +2 s → entry dropped; a later listing without the session closes nothing.
  - `sessionsOf` null at +90 s → nothing changes.
  - An entry holding two threads (the joined bare sends) → both close.
  - **Review Focus 3:** build a second hub over the same store after the send (no entry); status reads `queued: b/worker-api-1 is not running an agent`; the marker appears, a waiter connects → delivered.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Extend the header comment of `agentMailHub.js` with the table.
- [ ] **Step 4: Run the three hub suites** — PASS.
- [ ] **Step 5: Commit** `feat(mail): report an agent that did not start`.

### Task 10: `who` shows boxes that can start an agent

**Files:**
- Modify: `src/server/agentMailHub.js`
- Test: `test/agentMailHubWorkers.test.js`

**Interfaces:** Consumes Task 6's `renderWho(rows, starters)`.

Behaviour: in `who`, for each box that passes `mayStart` and is reachable, add `{ box: <label>, projects: <names in order> }` when `workers` and `workerStore` are set, the record's `mailStart` is `true`, it has at least one project, and `mailInstalled(box.id)`.

- [ ] **Step 1: Write the failing tests:** a box with no sessions and `mailStart` on appears as `b  can start an agent (projects: api, web)`; with `mailStart` off, not installed, no projects, unreachable, or not permitted by `mayStart` it does not; session rows and a starter line appear together.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(mail): tmx who lists boxes that can start an agent`.

### Task 11: `--fresh` on the wire, in `tmx` and in the skill

**Files:**
- Modify: `src/server/agentMailListener.js`, `src/server/assets/tmuxifier-mail.sh`, `src/server/assets/tmuxifier-mail-skill.md`
- Test: `test/agentMailListener.test.js`, `test/agentMailTmx.test.js`, `test/opencodeAgentPermission.test.js`

**Interfaces:**
- Consumes: `PROJECT_NAME_RE`; Task 8's `send(…, { fresh })`.
- Produces:
  - `POST /v1/threads` accepts an optional form field `fresh`: absent, empty, or a project name. Anything else is `400 bad request: fresh is not a project name`. The listener calls `hub.send(me, to, body, { fresh })`, `fresh` being `undefined` when absent. Add the field to the wire table in the header.
  - `tmx send [--fresh [--project <name>]] <target> ["text"]`. Options come before the target. `--project` without `--fresh`, `--project` with no name or a name outside `[a-z0-9-]`, and `--fresh` with a target containing `/` are usage errors (exit 2, no request). With `--fresh` the request adds `--data-urlencode "fresh=<name or empty>"`. The usage text's `send` line becomes `tmx send [--fresh [--project <name>]] <target> ["text"]` followed by a line `                                   --fresh starts a new agent on the box`.
  - No change to `src/server/assets/tmuxifier-opencode-agent.js`.

Skill text to add (spec 5.3): a box with no agent may start one when its operator allows it (`tmx who` shows `can start an agent`); `--fresh` asks for a new agent for unrelated work or a clean context; `--project <name>` picks where it starts; a new agent knows nothing the message does not say.

- [ ] **Step 1: Write the failing tests:**
  - Listener (real socket, real hub with a bench starter): `fresh=` → a worker starts; `fresh=web` → `worker-web-1`; no `fresh` → today's behaviour. **Review Focus 5:** `fresh=API`, a 25-character value, `fresh=../x`, and `fresh` given twice each answer 400 and the hub's `send` was not called (spy by wrapping the hub object the listener is given).
  - `tmx` (real script, real listener): `tmx send --fresh b "x"` sends `fresh=` and prints the thread id; `tmx send --fresh --project web b "x"` sends `fresh=web`; `tmx send --project web b "x"`, `tmx send --fresh --project b "x"` with no name left, `tmx send --fresh --project WEB b`, and `tmx send --fresh b/side "x"` exit 2 and the listener saw no request; `tmx send b "x"` is unchanged; a body on stdin still works with `--fresh`.
  - OpenCode permission: `isPlainTmx('tmx send --fresh --project api billing "do x"')` is true and `isPlainTmx('tmx send --fresh=api billing "do x"')` is false (use the same accessor the file's other tests use).
  - The skill asset contains `--fresh`, `--project` and `can start an agent`.
- [ ] **Step 2: Run the three files** — FAIL.
- [ ] **Step 3: Implement.** Check `test/claudeAgentMail.test.js` still passes (it pins the skill's bytes on the box).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(mail): tmx send --fresh`.

### Task 12: Routes and wiring

**Files:**
- Modify: `src/server/server.js`, `src/server/index.js`
- Test: `test/agentWorkerRoutes.test.js` (new; model it on `test/agentMailRoutes.test.js`)

**Interfaces:**
- Consumes: Tasks 2 and 5; the hub options of Tasks 7 and 8.
- Produces:
  - `buildServer({ …, agentWorkers = null })` where `agentWorkers` is `{ store, starter }`.
  - `GET /api/boxes/:id/workers` → `{ workers: <record>, mail: <boolean, messaging on> }`.
  - `PUT /api/boxes/:id/workers` body `{ projects, mailStart, max }` → `{ workers }`; a rule failure is `400 { error: <the rule's message> }`.
  - `POST /api/boxes/:id/workers/start` body `{ project? }` → `{ ok: true, session }`. `project` must be absent or match `PROJECT_NAME_RE` (else 400). Failures: `{ error, code }` with status 409 for `setup-running` and `worker-cap`, 400 for `no-project`, 502 otherwise. Operator wording: `setup-running` `box setup is still running`; `no-project` `no such project`; `worker-cap` `this box already runs as many started agents as its limit allows`; `no-dir` `the project directory does not exist on the box`; `no-agent-binary` `Claude Code is not installed on the box`; `no-tmux` `tmux is not installed on the box`; `unreachable` `box is unreachable`; `start-failed` `starting the agent failed`. After a success, `await` a best-effort `statusPoller.probeOne(box.id)` as the window and kill routes do.
  - All three: 404 for an unknown box, 403 `browser session required` when `req.deviceId` is set, 503 when `agentWorkers` is null, and none of them in `DEVICE_ALLOWED_ROUTES`.
  - `index.js`: build the store and the starter whether or not messaging is on (`setupRunning` from `setupManager.currentForBox(id)?.status === 'running'`; `sessionsOf` from `statusPoller.getSnapshot()[id]`, `null` unless `reachable`, else its `sessions`); pass `workers`, `workerStore`, `sessionsOf` and `mailInstalled` (`(id) => mailForward.status(id).installed === true`, bound late because the forward is created after the hub) to `createAgentMailHub`; pass `agentWorkers` to `buildServer`; in `onRemoved`, call `workerStore.removeBox(box.id)` whether or not messaging is on.

- [ ] **Step 1: Write the failing tests:** GET default record and `mail` flag both ways; PUT round trip; PUT with `dir: '/opt/../x'` → 400 `bad directory` and nothing stored; start success returns the session (bench-backed starter); each failure code's status and wording; a device token gets 403 on all three (and the allowlist set does not contain them); unknown box 404; removing a box drops its record.
- [ ] **Step 2: Run** `npx vitest run test/agentWorkerRoutes.test.js` — FAIL.
- [ ] **Step 3: Implement.** Add the three routes to the "Notable routes" comment block conventions used in `server.js`.
- [ ] **Step 4: Run, then `npm test`** — PASS.
- [ ] **Step 5: Commit** `feat(workers): routes and wiring`.

### Task 13: Edit Box section

**Files:**
- Create: `src/web/agentWorkers.ts` (fetch layer), `src/web/agentWorkersView.ts` (pure), `src/web/agentWorkersSection.ts` (DOM)
- Modify: `src/web/main.ts` (mount in the Edit Box modal, edit mode only, after the mail section; commit after the box save), the stylesheet that holds `.box-mail`
- Test: `test/agentWorkersView.test.js`

**Interfaces:**
- Consumes: Task 12's routes; `http.ts` helpers; `el` from `dom.ts`.
- Produces:
  - `agentWorkers.ts`: `interface WorkerProject { name: string; dir: string; trust: boolean }`, `interface WorkerSettings { projects: WorkerProject[]; mailStart: boolean; max: number }`, `workersApi = { get(boxId): Promise<{ workers: WorkerSettings; mail: boolean }>, save(boxId, w: WorkerSettings): Promise<{ workers: WorkerSettings }>, start(boxId, project?: string): Promise<{ ok: true; session: string }> }`.
  - `agentWorkersView.ts`: `PROJECT_NAME_RE`, `WORKER_DIR_RE`, `MAX_PROJECTS`, `WORKERS_MAX_LIMIT`; `projectProblem(p: WorkerProject, others: WorkerProject[]): string | null` (messages: `Name: lowercase letters, digits and dashes, up to 24`, `Directory: an absolute path with no spaces`, `That name is already used`); `maxProblem(n: number): string | null`; `workersChanged(a, b): boolean`; `startLabel(project: string): string` → `Start Claude in ${project}`.
  - `agentWorkersSection.ts`: `createAgentWorkersSection(box: Box)` → `{ element: HTMLElement, commit(boxId: string): Promise<void> }`, the same contract as `createAgentMailSection`: nothing is sent until the record has loaded, and only when it changed; a failed save throws `Box saved, but the agent worker settings were not: <why>`.

Section content (spec 5.4 sketch): eyebrow `Agent workers`; one row per project (name, directory, a tick `Skip Claude's folder-trust question`, a remove ×); `Add project` (disabled at 8); a tick `Let agent messages start an agent here`, shown only when the GET said `mail: true`; `At most [n] worker sessions`. A row with a problem shows its message with the `bad` modifier and blocks the commit (commit throws the message). Class prefix `wk-`.

- [ ] **Step 1: Write the failing tests** (`test/agentWorkersView.test.js`): `projectProblem` for each message and for a valid row; `workersChanged` for order, trust, mailStart and max changes and for equal records; `startLabel`; and a pin that the web regexes equal the server's: `expect(webView.PROJECT_NAME_RE.source).toBe(serverRules.PROJECT_NAME_RE.source)`, same for the directory regex and the two limits.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement the three files and the `main.ts` mount.** Run `npx vitest run test/webHttp.test.js` (it forbids hand-rolled `res.ok` checks).
- [ ] **Step 4: Run `npm test`** — PASS.
- [ ] **Step 5: Commit** `feat(ui): agent workers section in Edit Box`.

### Task 14: Start rows in the pane's session picker

**Files:**
- Modify: `src/web/paneHeader.ts` (`SessionTarget`), `src/web/sessionPicker.ts`, `src/web/agentWorkersView.ts`, `src/web/main.ts` (the pane header's picker only, not the Edit Box modal's)
- Test: `test/sessionPicker.test.js`, `test/paneHeader.test.js`, `test/agentWorkersView.test.js`

**Interfaces:**
- Consumes: Task 13's `workersApi`, `startLabel`.
- Produces:
  - `SessionTarget.kind` gains `'start'`; a start row is `{ kind: 'start', value: 'start:<project>', label: startLabel(project), session: '', project }` (`project?: string` added to the interface).
  - `startTargetsOf(projects: { name: string }[]): SessionTarget[]` in `agentWorkersView.ts`.
  - `canKillTarget(t: SessionTarget): boolean` in `sessionPicker.ts`: false for a start row, true otherwise. The pane header's picker passes it as `canKill`.
  - `isSoleWindow` and `rowKey` in `sessionPicker.ts` treat a start row as neither a session nor a window: it never counts toward "sole window", and its key is its `value`.

Behaviour (spec 5.4): when the pane's picker opens, `main.ts` fetches `workersApi.get(box.id)` and appends `startTargetsOf(projects)` after the session and window rows. Not in phone mode, not for the Host Shell, and nothing is appended when the fetch fails or there are no projects. `canKill` is false for a start row. Selecting one calls `workersApi.start(box.id, project)`; on success the pane switches to the returned session through the same pane-local override a picked session uses; on failure the error text is shown where the picker's kill failure is shown today.

- [ ] **Step 1: Write the failing tests:** `startTargetsOf([{ name: 'api' }, { name: 'web' }])` gives the two rows above in order; `isSoleWindow` gives the same answer for a list with and without start rows appended; `rowKey` of a start row is `start:api`; `canKillTarget` is false for a start row and true for a session row and a window row.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: `npm test`** — PASS.
- [ ] **Step 5: Commit** `feat(ui): start an agent from the session picker`.

### Task 15: End to end

**Files:**
- Create: `test/e2e/agentWorkers.spec.ts`
- Modify: the e2e global setup only if the fixture home needs the stand-in (prefer writing it from the spec's `beforeAll` into `E2E_BOX_HOME`)

Stand-in for the fixture box: `~/.local/bin/claude` is a script that `exec`s `"$HOME/.local/libexec/claude" 600`, where that path is a symlink to `sleep`, so the pane's command reads `claude`. The fixture home's rc files get the `tmuxifier-local-bin` PATH line. Every test ends by killing the `worker-*` sessions it made on the fixture's tmux (over ssh with `E2E_SSH_CONFIG`, exact targets) and by saving an empty record.

- [ ] **Step 1: Write the spec:**
  - Edit Box: add project `api` → `/opt/…` under the fixture home, save, reopen: the row is there. A directory with a space shows the `bad` line and the modal does not save the section.
  - The messaging tick is absent when `GET /api/ui-config` says messaging is off and present when on (use whichever the e2e server runs with; assert against the config it reports).
  - Picker: open a pane on the box, open its session picker, choose `Start Claude in api` → the pane header shows `worker-api-1`; over ssh, `tmux has-session -t '=worker-api-1'` succeeds; `GET /api/status` lists the session with pane command `claude`.
  - With `max: 1`, a second Start shows `this box already runs as many started agents as its limit allows`.
- [ ] **Step 2: Run** `npm run build && npx playwright test test/e2e/agentWorkers.spec.ts` in the worktree — PASS. Compare any other e2e failure against the main branch before treating it as new (`phone.spec` touch-drag and `duplicatePanes:156` have failed on main before).
- [ ] **Step 3: Commit** `test(e2e): agent workers`.

### Task 16: Documentation

**Files:**
- Modify: `docs/agent-messaging.md`, `docs/boxes-and-setup.md`, `CLAUDE.md`, `AGENTS.md`, `README.md` (the agent-messaging feature paragraph, one sentence)

- [ ] **Step 1: Write.** `docs/agent-messaging.md`: a "Starting an agent on a box that has none" section (the settings, what a bare name does now, `--fresh` and `--project`, the trust tick and what it writes, a stuck or failed start and where it shows, that a worker's name can be left as a plain shell when a pane is on it, what is not in this version). `docs/boxes-and-setup.md`: the Edit Box section and the picker row. `CLAUDE.md` and `AGENTS.md`, kept identical in substance: a `data/agent-workers.json` row in the state table; module entries for `agentWorkerRules.js`, `agentWorkerStore.js`, `agentWorkers.js`; the three routes; the hub, listener, text and `tmx` changes in their existing entries; web entries for the three new files and the picker change; one load-bearing rule: **A worker is started by a script that holds nothing a lead sent** (project is a lookup key, the directory is the operator's and re-validated before quoting, the launch word is a constant, and no worker starts during setup).
- [ ] **Step 2: Check** `npx vitest run` for any test that pins documentation or the module list — PASS.
- [ ] **Step 3: Commit** `docs(agent-workers): operator guide and module map`.

### Task 17: Live validation with the operator

No merge and no release in this task. It follows "Shipping" in `CLAUDE.md`: candidate on the live app first.

- [ ] **Step 1: Pre-flight.** `npm test` and the e2e spec green in the worktree. No setup, provision, lifecycle, fleet, voice-install or apk-build job is `running`. Check `ListAgents` for a peer session sharing the live `dist/` and coordinate before touching it.
- [ ] **Step 2: Deploy the candidate.** `npm run build` in the worktree; `rsync -a --delete <worktree>/dist/ ./dist/`; copy the changed server files; `systemctl restart tmuxifier` (no `sudo`); fetch one hashed asset and check its content type.
- [ ] **Step 3: Rerun setup on the two boxes used for the walk** (new `tmx` and skill).
- [ ] **Step 4: Verify against the real Claude Code, and record the result in a new dated note under `docs/superpowers/specs/`:**
  - the real `tmx hook-wait` takes a message queued before the worker's `SessionStart`;
  - the trust key still skips the dialog on the installed Claude Code version (record the version), and whether `~/.claude.json` moves with `CLAUDE_CONFIG_DIR`;
  - a worker under the box's actual default shell.
- [ ] **Step 5: Walk with the operator, in auto mode** (spec section 7): bare-name start on a box with no agent; `--fresh` beside a running agent; a second project with `--project`; the cap; the trust tick off in a never-seen directory (stuck status, then answer the dialog and see delivery) and on; a failed start (rename the project directory, send, see the close and the refusal entry); the operator's Start from the picker; `/exit` in a worker with and without a pane on it.
- [ ] **Step 6: Report** what passed, what failed and what was not walked. Fixes go on the branch and are redeployed. Merge and release only when the operator says so.

---

## Notes for whoever executes this

- Tasks 1–5 have no dependency on agent messaging and can be reviewed on their own. Tasks 7–10 all change `agentMailHub.js`; do them in order, one at a time.
- `test/helpers/workerBench.js` (Task 3) is used by Tasks 4, 5, 8, 9, 11 and 12. Do not replace it with a scripted fake: the hub suites are where the real script, the real starter and the real hub meet.
- The spec's section 8 lists the calls the operator has seen. Do not reopen them; a problem with one goes back to the operator.
