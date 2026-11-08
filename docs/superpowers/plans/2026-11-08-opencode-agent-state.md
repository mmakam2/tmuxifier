# OpenCode Agent-State Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An OpenCode pane on a box or the Host Shell shows working / blocked / done / idle exactly like a Claude Code pane, fed only by an OpenCode plugin that writes the existing `~/.tmuxifier-agent/<tmux-session>` markers.

**Architecture:** A single-file OpenCode V2 plugin (`src/server/assets/tmuxifier-opencode-agent.js`) runs inside the user's one shared `opencode serve --service` process, consumes the event stream (no hooks), keeps per-OpenCode-session state, attributes sessions to tmux sessions by directory against `tmux list-panes -a` (active pane of the active window), and writes/deletes markers on every change plus a 15 s sweep. The server grows an `agentKindOf(paneCmd)` so an `opencode` pane counts as an agent and events carry `agent`; setup gains an `opencode` catalog tool and an `opencode-plugin` phase whose pusher mirrors `claudeAgentHooks.js`; the Host Shell gets an `opencodePlugin: true` flag.

**Tech Stack:** Node 22+ ESM server (`.js`), the asset must also load under OpenCode's embedded Bun (node builtins only, no imports from the repo), TypeScript web client (Vite), vitest (node env, no DOM), Playwright e2e against `test/helpers/localBox.js`.

**Spec:** `docs/superpowers/specs/2026-11-07-opencode-agent-state-design.md` — read it first; §3 lists the recorded facts every task below relies on, §4.4 the acceptance anchors. Evidence: `test/fixtures/opencode-event-trace.jsonl` + `test/fixtures/README-opencode-event-trace.md`.

## Global Constraints

- Marker contract unchanged: file `~/.tmuxifier-agent/<safe-name>`, content `<tmux-session>:<state>:<epoch-seconds>:<cause>\n`, states `working|blocked|ready`, causes `prompt|resume|stop|start|permission|question|elicitation|unblock`; `parseAgentMarks` in `src/server/status.js` is the allowlist. Safe name = session with `[^A-Za-z0-9._-]` → `_`; content keeps the real name.
- Writes are tmp + rename, mode 0644; every write, read, delete and `tmux` call is try/caught; nothing ever throws out of the plugin, and no hook is registered.
- The asset uses only `node:fs`, `node:os`, `node:path`, `node:child_process` and must `import()` cleanly under plain Node (vitest) with no side effects at module load.
- Installer scripts interpolate nothing from the asset: bytes arrive on stdin; the box decides via `command -v opencode || [ -x "$HOME/.opencode/bin/opencode" ]`; reruns idempotent.
- Box output is untrusted: pane listings pass through `parsePanes` with length caps; nothing from tmux reaches a shell.
- Closed allowlists: `TOOL_IDS` is the catalog chokepoint, mirrored verbatim by `PROVISION_TOOLS` and `SETUP_TOOLS`.
- Conventional commits; `npm test` (typecheck + vitest) green after every task; build only in the worktree (`npm run build` in the main checkout blanks the live app).
- Public repo: fixtures and tests use `/home/user/...`, `example.com`, `192.168.1.x`.
- Epoch unit everywhere in the asset: **seconds** (`Math.floor(ms / 1000)`), like `date +%s` in the sh hook.

## Review Focus

Inputs the spec implies but no recorded line exercises; each has a pinned test in the owning task:

1. A tmux session whose active window runs Claude while another window runs OpenCode must be left alone (no write, no delete) — Task 3 `parsePanes` filter test, Task 4 content-equality delete test.
2. A pane path with a tab, a trailing slash or a path that is a *parent* of the session directory (TUI launched from the repo root, OpenCode reporting a subdirectory, or vice-versa) — Task 3 prefix-rule tests.
3. Events for a session never seen (`execution.started` before any directory-carrying event, e.g. a server that was already mid-turn when the plugin hot-loaded) must not write anything and must not crash — Task 2 unknown-session test.
4. A `tmux` binary that is missing, hangs, or prints garbage — Task 4 ENOENT/timeout/garbage tests (inert, no marker).
5. A second `setup` for another directory while the first core has outstanding markers — Task 4 hand-over test (markers inherited, old timer and subscription aborted, old `cleanup` a no-op).

---

### Task 1: Tighten `NO_SERVER_RE` (issue #7)

**Files:**
- Modify: `src/server/localAgent.js:43-52`
- Test: `test/localAgent.test.js`

**Interfaces:**
- Produces: `isNoServer(res)` behaviour only; no exported change.

- [ ] **Step 1: Write the failing test** in `test/localAgent.test.js` beside the existing `sample() degrades…` test:

```js
test('sample(): only tmux\'s own no-server wording is an empty listing; refused/denied sockets are unknown', async () => {
  const make = (stderr) => createLocalAgentSampler({ home: '/nonexistent', runTmux: async () => ({ code: 1, stdout: '', stderr }) });
  expect((await make('no server running on /tmp/tmux-1000/default').sample()).sessions).toEqual([]);
  expect((await make('error connecting to /tmp/tmux-1000/default (No such file or directory)').sample()).sessions).toEqual([]);
  expect((await make('error connecting to /tmp/tmux-1000/default (Connection refused)').sample()).sessions).toBeUndefined();
  expect((await make('error connecting to /tmp/tmux-1000/default (Permission denied)').sample()).sessions).toBeUndefined();
});
```

- [ ] **Step 2: Run it** — `npx vitest run test/localAgent.test.js -t "refused/denied"` → FAIL (refused currently yields `[]`).
- [ ] **Step 3: Change** `NO_SERVER_RE` to `/no server running|error connecting to .*\(No such file or directory\)/i` and extend the comment above it: refused/denied are a wedged or foreign server, not an empty listing.
- [ ] **Step 4: Run** `npx vitest run test/localAgent.test.js` → PASS.
- [ ] **Step 5: Commit** — `fix(local-agent): only a stale tmux socket reads as an empty listing (#7)`.

---

### Task 2: The reporter's pure reducer

**Files:**
- Create: `src/server/assets/tmuxifier-opencode-agent.js` (reducer part; Tasks 3-4 extend the same file)
- Test: `test/opencodeAgentReducer.test.js`

**Interfaces:**
- Produces (named exports of the asset):
  - `createReducer({ now = () => Math.floor(Date.now() / 1000) } = {})` → `{ apply(event): boolean, sessions: Map<string, Session>, derive(sessionID): { state, cause, ts } | null, seenIds: Set<string> }`. `apply` returns `false` for a duplicate `event.id` or an irrelevant type and `true` when any session's derived state/cause changed.
  - `Session = { id, dir: string|null, parent: string|null, executing: boolean, cause: 'prompt'|'resume'|'unblock', blocks: Map<string, 'permission'|'question'|'elicitation'>, shells: Set<string>, lastInbox: 'user'|'synthetic'|null, ts: number }`.
  - `deriveState(session, reducer)` pure helper (exported for tests): rules of spec §4.1 "Derived state of one session", children found by `parent === session.id`.
- Event field paths (verbatim from the fixture): `event.id`, `event.type`, `event.location?.directory`, `event.data.sessionID`, `event.data.parentID`, `event.data.item.type` (`session.inbox.enqueued`), `event.data.id` (`permission.asked`), `event.data.requestID` (`permission.replied`), `event.data.form.{id,sessionID,metadata.kind}` (`form.created`), `event.data.id` (`form.replied`/`form.cancelled`), `event.data.info.{id,metadata.sessionID}` (`shell.created`), `event.data.id` (`shell.exited`).

- [ ] **Step 1: Write the failing tests** in `test/opencodeAgentReducer.test.js`. Load the fixture once (`readFileSync` + `JSON.parse` per line, keep `kind === 'event'` lines and their 1-based line numbers). Helper `applyUntil(r, lines, n)` applies every event line with number ≤ n. Tests (names and assertions):

```js
test('a user prompt starts working/prompt and the turn end is ready/stop', () => {
  // lines 18 and 46 of the fixture, session ses_e47631a19ffeng7cUQkWJqeVg1
  expect(derive at 18).toMatchObject({ state: 'working', cause: 'prompt' });
  expect(derive at 46).toMatchObject({ state: 'ready', cause: 'stop' });
  expect(derive at 46).ts).toBe(Math.floor(1794098652752 / 1000)); // execution.succeeded created
});
test('permission.asked blocks with cause permission; once/always/reject all unblock', () => {
  // 60 blocked/permission, 61 working/unblock, 92 blocked, 93 working/unblock, 187 blocked, 188 working/unblock
});
test('the interrupted path ends the turn ready/stop with no block left', () => {
  // 97, 115, 160, 266 → ready/stop and derive(...).blocks size 0
});
test('a question form blocks with cause question; reply and cancel both unblock', () => {
  // 127 blocked/question, 129 working/unblock, 155 blocked/question, 156 working/unblock
});
test('a backgrounded shell keeps the session working across execution.succeeded, and its completion resumes', () => {
  // 298 working/prompt (shell sh_1b8a1df3e001c9IT7xTMOXc8ST in Session.shells), 303 working/resume, 313 ready/stop
});
test('duplicate event ids are ignored and apply() reports no change', () => {
  // line 337 (dup of 336) → apply returns false; line 344 (dup of 343) → false
});
test('a session whose first event carries no directory stays unattributed and never throws', () => {
  // synthetic: { id:'x1', type:'session.execution.started', data:{ sessionID:'ses_unknown' } } → apply true, sessions.get('ses_unknown').dir === null
});
test('a resumed session learns its directory from inbox.enqueued before execution.started', () => {
  // fresh reducer, lines 415-416 only → dir '/home/user/proj', state working/prompt
});
test('a child session rolls up: its block and its work become the parent\'s', () => {
  // synthetic: session.created { sessionID:'ses_p', location:{directory:'/d'} }, session.created { sessionID:'ses_c', parentID:'ses_p', location:{directory:'/d'} },
  // execution.started ses_p then execution.succeeded ses_p, execution.started ses_c → derive('ses_p') working; permission.asked ses_c id 'per_1' → derive('ses_p') blocked/permission; permission.replied → working; execution.succeeded ses_c → ready/stop
});
test('an elicitation form on a real session blocks with cause elicitation; the "global" sentinel is ignored', () => {
  // form.created { form:{ id:'f1', sessionID:'ses_p', metadata:{} } } → blocked/elicitation; form.created sessionID 'global' → no session created, apply false
});
test('session.deleted drops the session', () => {});
test('ts moves only on a derived transition and is in seconds', () => {
  // a second execution.started on an already-working session keeps ts; ts < 1e11
});
```

Use `event.created` (ms) as the clock: `createReducer({ now })` is only a fallback; `apply` passes `Math.floor(event.created / 1000)` when present.

- [ ] **Step 2: Run** `npx vitest run test/opencodeAgentReducer.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement** the asset's reducer half in `src/server/assets/tmuxifier-opencode-agent.js`: the file header comment states the recorded facts it rests on (spec §3.1-3.7) and that it runs inside the shared server. Export `createReducer`, `deriveState`. Relevant types: `session.created`, `session.deleted`, `session.inbox.enqueued`, `session.execution.started|succeeded|interrupted|failed`, `permission.asked|replied`, `form.created|replied|cancelled`, `shell.created|exited`; any event with `location.directory` and `data.sessionID` sets `dir` when unset. Keep `seenIds` bounded (drop the oldest beyond 5000).
- [ ] **Step 4: Run** the test file → PASS.
- [ ] **Step 5: Commit** — `feat(opencode): event reducer for the OpenCode agent-state reporter`.

---

### Task 3: Pane attribution, fold and the replay acceptance test

**Files:**
- Modify: `src/server/assets/tmuxifier-opencode-agent.js`
- Test: `test/opencodeAgentFold.test.js`, `test/opencodeAgentReplay.test.js`

**Interfaces:**
- Consumes: Task 2's `createReducer`, `deriveState`.
- Produces:
  - `PANE_FORMAT = '#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}'` (exported constant; the `tmux list-panes -a -F` argument).
  - `parsePanes(text)` → `Array<{ session, cmd, path }>` containing only rows with `window_active === '1'` and `pane_active === '1'`, exactly 5 tab-separated fields, session name ≤ 256 chars and matching `/^[A-Za-z0-9._-]+$/`-free-of-controls (strip rows with C0 controls), path ≤ 4096; at most 500 rows.
  - `isOpencodeCmd(cmd)` → `/^opencode(-|$)/.test(cmd)`.
  - `dirMatches(dir, panePath)` → exact equality after stripping one trailing `/` from both, else `panePath.startsWith(dir + '/')`, else `dir.startsWith(panePath + '/')`.
  - `foldForPanes(reducer, panes, since, now)` → `Map<tmuxSession, { state, cause, ts }>`; `since: Map<tmuxSession, number>` and `now: number`, both seconds. For each opencode pane: candidates = sessions with `dir` matching and `deriveState(...).ts >= (since.get(session) ?? 0)` and `parent === null`; pick by precedence `blocked > working > ready`, ties → newest `ts`; none → `{ state: 'ready', cause: 'start', ts: since.get(session) ?? now }`.
  - `markerLine(tmuxSession, fold)` → `` `${tmuxSession}:${fold.state}:${fold.ts}:${fold.cause}\n` ``.

- [ ] **Step 1: Write the failing fold tests** in `test/opencodeAgentFold.test.js`:

```js
test('parsePanes keeps only the active pane of the active window and rejects malformed rows', () => {
  const text = 'web\t1\t1\topencode\t/home/user/proj\n' + 'web\t0\t1\tclaude\t/home/user/other\n' + 'dev\t1\t0\topencode\t/x\n' + 'bad\x01name\t1\t1\topencode\t/x\n' + 'short\t1\t1\n' + 'odd\t1\t1\tzsh\t/a\tb\n';
  expect(parsePanes(text)).toEqual([{ session: 'web', cmd: 'opencode', path: '/home/user/proj' }]);
});
test('a session whose active window runs claude is not an opencode session even if another window is', () => {
  const text = 'web\t1\t1\tclaude\t/home/user/proj\nweb\t0\t1\topencode\t/home/user/proj\n';
  expect(parsePanes(text).filter((p) => isOpencodeCmd(p.cmd))).toEqual([]);
});
test('isOpencodeCmd accepts opencode and opencode-<suffix>, rejects node, bun, opencodex', () => {});
test('dirMatches: exact, trailing slash, pane under dir, dir under pane, unrelated', () => {
  expect(dirMatches('/a/b', '/a/b/')).toBe(true); expect(dirMatches('/a/b', '/a/b/sub')).toBe(true);
  expect(dirMatches('/a/b/sub', '/a/b')).toBe(true); expect(dirMatches('/a/b', '/a/bc')).toBe(false);
});
test('foldForPanes: blocked beats working beats ready; ties go to the newest ts; the cause and ts are the chosen session\'s', () => {});
test('foldForPanes: a session finished before the pane\'s since is excluded and the pane reads ready/start at since', () => {});
test('foldForPanes: two tmux sessions in the same directory get the same fold; a pane in another directory is untouched', () => {});
test('foldForPanes: child sessions are never chosen directly', () => {});
test('markerLine writes session:state:ts:cause with a trailing newline', () => {});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `PANE_FORMAT`, `parsePanes`, `isOpencodeCmd`, `dirMatches`, `foldForPanes`, `markerLine` in the asset.
- [ ] **Step 4: Run** the fold tests → PASS.
- [ ] **Step 5: Write the replay acceptance test** `test/opencodeAgentReplay.test.js`, modelled on `test/agentHooksReplay.test.js` (1-based fixture lines, `REPLAY_TRAIL` env prints the trail). Panes fixed:
  `octest\t1\t1\topencode\t/home/user/proj`, `octest2\t1\t1\topencode\t/home/user/proj`, `octest3\t1\t1\topencode\t/home/user/proj2`; `since = new Map([['octest', 0], ['octest2', 0], ['octest3', 0]])`. Walk every fixture line; on a `kind === 'plugin.setup'` line whose `pid` differs from the previous setup's pid, replace the reducer with a fresh one (new server process). After each line record `fold.get('octest')` as `state/cause` (and `octest2`, `octest3`). Assertions, by line (`at(n)` = octest trail):

```js
expect(at(18)).toBe('working/prompt'); expect(at(46)).toBe('ready/stop');
expect(at(60)).toBe('blocked/permission'); expect(at(61)).toBe('working/unblock'); expect(at(78)).toBe('ready/stop');
expect(at(92)).toBe('blocked/permission'); expect(at(93)).toBe('working/unblock'); expect(at(97)).toBe('ready/stop');
expect(at(127)).toBe('blocked/question'); expect(at(129)).toBe('working/unblock'); expect(at(142)).toBe('ready/stop');
expect(at(155)).toBe('blocked/question'); expect(at(156)).toBe('working/unblock'); expect(at(160)).toBe('ready/stop');
expect(at(173)).toBe('ready/stop');
expect(at(187)).toBe('blocked/permission'); expect(at(188)).toBe('working/unblock'); expect(at(204)).toBe('ready/stop');
expect(at(219)).toBe('blocked/permission'); expect(at(242).startsWith('working')).toBe(true); // shell still running
expect(at(248)).toBe('working/resume'); expect(at(266)).toBe('ready/stop');
expect(at(280)).toBe('blocked/permission'); expect(at(298)).toBe('working/prompt'); // background gate
expect(at(303)).toBe('working/resume'); expect(at(313)).toBe('ready/stop');
expect(trail2(343)).toBe('working/prompt'); expect(at(343)).toBe('working/prompt'); expect(trail3(343)).toBe('ready/start');
expect(at(344)).toBe(at(343)); // duplicate changes nothing
expect(at(416)).toBe('working/prompt'); expect(at(426)).toBe('ready/stop');
// the marker ts at 46 equals the execution.succeeded created time in seconds
// no execution.succeeded|interrupted|failed line ever leaves octest blocked
```

- [ ] **Step 6: Run** `npx vitest run test/opencodeAgentReplay.test.js` → PASS (fix the reducer/fold if the real trace disagrees — the trace wins; update the spec's §4.4 anchors only if the recording proves an anchor wrong, and say so in the commit).
- [ ] **Step 7: Commit** — `feat(opencode): pane attribution and fold; replay the 2.2.6 trace as the acceptance test`.

---

### Task 4: Writer, sweep, singleton and the plugin entry point

**Files:**
- Modify: `src/server/assets/tmuxifier-opencode-agent.js`
- Test: `test/opencodeAgentPlugin.test.js`

**Interfaces:**
- Consumes: Task 2-3 exports.
- Produces:
  - `createCore({ home = os.homedir(), listPanes = defaultListPanes, now, sweepMs = 15000, setInterval, clearInterval })` → `{ reducer, attach(ctx), handle(event), sweep(): Promise<void>, abort(): void, written: Map<name, content>, since: Map<string, number>, owner: symbol }`.
    - `defaultListPanes()` → `Promise<string|null>`: `execFile('tmux', ['list-panes', '-a', '-F', PANE_FORMAT], { timeout: 2000, maxBuffer: 1 << 20 })`, resolves `null` on any error (ENOENT, timeout, non-zero); results cached 1 s.
    - `sweep()`: `panes = parsePanes(await listPanes())`; if `listPanes` returned `null` → return (inert). Update `since`: a tmux session whose active pane is opencode and was not in `since` gets `since = now()`; one no longer opencode is removed from `since`. For each opencode pane write `markerLine(session, fold)` to `path.join(home, '.tmuxifier-agent', safeName(session))` via `writeFileSync(tmp, content, { mode: 0o644 })` + `renameSync` **only if** `written.get(name) !== content`; then `written.set(name, content)`. For every `name` in `written` whose tmux session no longer has an opencode active pane: `readFileSync(file)`; if it equals `written.get(name)` → `unlinkSync`; either way `written.delete(name)`.
    - `handle(event)`: `if (reducer.apply(event)) await sweep()` (coalesce: at most one sweep in flight, a second request re-runs once after).
    - `attach(ctx)`: `AbortController`; `for await (const event of ctx.event.subscribe({ signal }))` → `handle(event)`; starts the interval (`unref()` when available); first `sweep()` immediately.
    - `abort()`: aborts the controller, clears the interval; does **not** delete markers.
  - `safeName(session)` → `session.replace(/[^A-Za-z0-9._-]/g, '_')`.
  - `GLOBAL_KEY = Symbol.for('tmuxifier.opencode-agent')`.
  - `export default { id: 'tmuxifier-agent', async setup(ctx) }`: `prev = globalThis[GLOBAL_KEY]`; if `prev` → `prev.abort()` and `core.written = prev.written`, `core.since = prev.since` (inherit); `globalThis[GLOBAL_KEY] = core`; `core.attach(ctx)` (not awaited; errors swallowed); return `async function cleanup() { if (globalThis[GLOBAL_KEY] !== core) return; core.abort(); for each written name: delete under the content-equality rule; delete globalThis[GLOBAL_KEY]; }`.

- [ ] **Step 1: Write the failing tests** in `test/opencodeAgentPlugin.test.js`. Fixture per test: `mkdtemp` HOME; `listPanes` is an injected async function returning a string; `now` injected; a fake `ctx` whose `event.subscribe()` is an async generator fed from an array/queue.

```js
test('the asset imports under plain Node with no side effects and exports the V2 default shape', async () => {
  const mod = await import('../src/server/assets/tmuxifier-opencode-agent.js');
  expect(mod.default.id).toBe('tmuxifier-agent'); expect(typeof mod.default.setup).toBe('function');
  expect(globalThis[Symbol.for('tmuxifier.opencode-agent')]).toBeUndefined();
});
test('sweep writes ready/start for a fresh opencode pane and nothing for a claude pane', async () => {
  // panes: web opencode /home/user/proj, dev claude /x → ~/.tmuxifier-agent/web === 'web:ready:<now>:start\n', no dev file
});
test('a state change rewrites the marker atomically with the session\'s ts; an unchanged fold does not rewrite', async () => {
  // feed fixture lines 15-18 for /home/user/proj → file 'web:working:1794098652:prompt\n'; mtime unchanged after a second sweep
});
test('a tmux session whose pane stopped being opencode gets its marker deleted only if the content is still ours', async () => {
  // write via sweep, then overwrite the file with 'web:blocked:1:permission\n' (the Claude hook), change panes to zsh → file survives; repeat without the overwrite → file gone
});
test('listPanes failing (null), hanging past the timeout, or returning garbage leaves no marker and no throw', async () => {});
test('since: a session finished before the pane appeared reads ready/start; a new turn after it reads its own state', async () => {});
test('session names are sanitized in the filename but exact in the content', async () => {
  // pane 'my session/x' → file 'my_session_x', content starts 'my session/x:'
});
test('setup twice hands over: the second core inherits written/since, the first subscription and timer are aborted, the first cleanup is a no-op', async () => {
  // call default.setup(ctx1) then default.setup(ctx2); push an event into ctx1's queue → no write; into ctx2's → write; await cleanup1() → marker still there and globalThis still ctx2's core; await cleanup2() → marker gone, global cleared
});
test('cleanup deletes only markers whose content still equals the last write', async () => {});
test('the sweep timer is unref\'d so the plugin never keeps the server alive', async () => {
  // injected setInterval returns an object with unref spy → called
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `createCore`, `safeName`, `defaultListPanes`, `GLOBAL_KEY`, the default export. Everything in try/catch; never `console.*` except one `console.error` guarded by `process.env.TMUXIFIER_OPENCODE_DEBUG`.
- [ ] **Step 4: Run** `npx vitest run test/opencodeAgent*.test.js` → PASS; also `node -e "import('./src/server/assets/tmuxifier-opencode-agent.js').then(m=>console.log(Object.keys(m)))"` lists the exports.
- [ ] **Step 5: Commit** — `feat(opencode): marker writer, sweep and singleton plugin entry point`.

---

### Task 5: Server knows two agents

**Files:**
- Modify: `src/server/healthHistory.js:86,103,182-191`, `src/server/fcmPush.js:18,34-37`, `src/web/healthEvents.ts:64-66`, `src/web/notifyPrefs.ts:10-12`, `src/web/api.ts:52,183-184`, `src/mcp/tools.js:10,38,52,55`
- Test: `test/healthHistory.test.js`, `test/fcmPush.test.js`, `test/healthEvents.test.js`, `test/notifyPrefs.test.js`

**Interfaces:**
- Produces: `export function agentKindOf(paneCmd)` in `healthHistory.js` → `'claude' | 'opencode' | null` (`/^claude(-|$)/`, `/^opencode(-|$)/`). Per-session entry gains `agent: kind` when present; `agent-blocked`/`agent-input`/`agent-done` events gain `agent` (from `now.agent` or, for agent-done, `was.agent`). Web `AgentEntry.agent?: 'claude' | 'opencode'`, `HealthEvent.agent?: 'claude' | 'opencode'`.
- Copy: `AGENT_LABEL = { claude: 'Claude', opencode: 'OpenCode' }` (web: `agentState.ts`, exported; server: inline in `fcmPush.js`). `healthEvents.ts`: `${label} needs you: …`, `${label} finished a turn`, `${label} exited` with `label = AGENT_LABEL[e.agent ?? 'claude']`. `fcmPush.js`: titles `${Label} needs you`, `${Label} is waiting`, `Agent finished`; bodies `A ${Label} session wants your input…` / `A ${Label} session exited.`. `notifyPrefs.ts` labels: `'Agent needs you (permission or question)'`, `'Agent finished a turn'`, `'Agent exited'`. MCP: `AGENT_STATES_DOC` prefix "Agents: Claude Code or OpenCode. "; `list_boxes`/`wait_for_agent` say "agent session" instead of "Claude agent session".

- [ ] **Step 1: Write the failing tests**:

```js
// test/healthHistory.test.js
test('agentKindOf: claude and opencode panes are agents, shells and node are not', () => {
  expect(agentKindOf('claude')).toBe('claude'); expect(agentKindOf('claude-code')).toBe('claude');
  expect(agentKindOf('opencode')).toBe('opencode'); expect(agentKindOf('opencode-x')).toBe('opencode');
  expect(agentKindOf('node')).toBeNull(); expect(agentKindOf('zsh')).toBeNull(); expect(agentKindOf('')).toBeNull();
});
test('sampleOf: an opencode pane with a marker carries state and agent: opencode', () => {
  // sessions [{ name:'web', paneCmd:'opencode', … }], agentMarks { web: { state:'blocked', cause:'permission', ts: 990 } } → agents.web = { present:true, agent:'opencode', state:'blocked', cause:'permission', ts:990, attached:false }; sample.agent === 'blocked'
});
test('agent events carry the agent kind, including agent-done after the pane is gone', () => {
  // classifyTransitions prev→next with opencode working → blocked emits { kind:'agent-blocked', session:'web', cause:'permission', agent:'opencode' }; then next without the session emits { kind:'agent-done', session:'web', agent:'opencode' }
});
// test/fcmPush.test.js
test('buildFcmMessage: titles and bodies name the agent', () => {
  // event { kind:'agent-blocked', session:'web-2', cause:'permission', agent:'opencode' } → title 'workbox — OpenCode needs you'; agent-input without agent → 'Claude is waiting' and body 'A Claude session wants your input in web-2.'
});
// test/healthEvents.test.js
test('agent event lines name the agent and default to claude', () => {});
// test/notifyPrefs.test.js — update lines 18-20 to the agent-neutral labels
```

- [ ] **Step 2: Run** the four files → FAIL.
- [ ] **Step 3: Implement**: `agentKindOf` replacing both `/^claude(-|$)/` tests in `sampleOf` (lines 86 and 103), `entry.agent = kind`; `events.push({ …, agent: now.agent })` / `agent: was.agent` at lines 182-191; `fcmPush.js` `TITLES` becomes a function of the event; web types and copy; `AGENT_LABEL` in `src/web/agentState.ts`; MCP strings. Android needs nothing (`ignoreUnknownKeys = true`).
- [ ] **Step 4: Run** `npm test` → PASS (typecheck included).
- [ ] **Step 5: Commit** — `feat(agents): opencode panes are agents; events and copy name the agent`.

---

### Task 6: The `opencode` catalog tool

**Files:**
- Modify: `src/server/boxActions.js:28,41,243-270,326,495`, `src/web/provisionTools.ts:4-15`, `src/mcp/tools.js:18`
- Test: `test/boxActions.test.js:432-446`, `test/provisionTools.test.js`, `test/mcpTools.test.js`

**Interfaces:**
- Produces: `TOOL_IDS = ['upgrade','curl','git','gh','node','bubblewrap','codex','claude','agy','opencode']`; `TOOL_IMPLIES.opencode = ['curl']`; `TOOLS.opencode()` returns the spec §4.3 install block verbatim (`--no-modify-path`); `OPENCODE_BIN_PATH_BLOCK` = `LOCAL_BIN_PATH_BLOCK` with `$HOME/.opencode/bin` and tag `# tmuxifier-opencode-bin`, appended at line 495 when `tools.includes('opencode')`; `PROVISION_TOOLS` gains `{ id: 'opencode', label: 'OpenCode (CLI + agent-state plugin)' }`; `SETUP_TOOLS` gains `'opencode'`.

- [ ] **Step 1: Update the pin** in `test/boxActions.test.js:445` to the ten-id list and add:

```js
test('the opencode tool downloads the v2 installer, runs it with --no-modify-path only when opencode is missing, and owns the PATH line', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['opencode'] });
  expect(remote).toContain('command -v opencode'); expect(remote).toContain('"$HOME/.opencode/bin/opencode"');
  expect(remote).toContain('https://opencode.ai/v2/install'); expect(remote).toContain('--no-modify-path');
  expect(remote).toContain('# tmuxifier-opencode-bin'); expect(remote).toContain('$HOME/.opencode/bin:$PATH');
  expect(remote).not.toContain('tmuxifier-local-bin'); // claude/agy block not dragged in
  expect(resolveTools(['opencode'])).toEqual(['curl', 'opencode']);
});
```

- [ ] **Step 2: Run** `npx vitest run test/boxActions.test.js test/provisionTools.test.js test/mcpTools.test.js` → FAIL on the pins.
- [ ] **Step 3: Implement** in the three source files.
- [ ] **Step 4: Run** the three files + `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `feat(setup): opencode catalog tool (native v2 installer, own PATH line)`.

---

### Task 7: Pusher, setup phase, status rendering

**Files:**
- Create: `src/server/opencodeAgentPlugin.js`
- Modify: `src/server/setupManager.js:146,251-256`, `src/server/index.js:147-153,179-181`, `src/web/api.ts:213,222,243`, `src/web/setupStatus.ts:8-11`, `src/web/main.ts:2537-2545`
- Test: `test/opencodeAgentPlugin.pusher.test.js`, `test/setupManager.test.js`, `test/setupStatus.test.js`

**Interfaces:**
- Produces: `buildOpencodePluginInstallScript()` → string (sh, `set -eu`; `DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins"`; skip path prints `OPENCODEPLUGIN: skipped-no-opencode` after draining stdin; else `mkdir -p "$DIR"`, `cat > "$DIR/tmuxifier-agent.js.$$.tmp"`, `chmod 644`, `mv -f` to `"$DIR/tmuxifier-agent.js"`, print `OPENCODEPLUGIN: applied`). `createOpencodePluginPusher({ runStdin, readAsset })` → `{ push(box) }` returning `{ target: 'opencode-plugin', ok: true } | { target: 'opencode-plugin', ok: false, skipped: 'no OpenCode on the box' } | { target: 'opencode-plugin', ok: false, error: 'opencode plugin push failed' | 'opencode plugin asset unavailable' }`. Setup manager option `pushOpencodePlugin(box)`; job field `opencodePlugin`; phase `'opencode-plugin'` gated on `(j.options.tools || []).includes('opencode')`, placed after `voice-link`, before `script`. Web: `SetupJob.phase` union gains `'opencode-plugin'`, `SetupJob.opencodePlugin?: SeedResult | null`, `SeedResult.target` union gains `'opencode-plugin'`; `setupStatusText` → `'Installing OpenCode plugin…'`; `main.ts` renders `formatStatuslineResult(job.opencodePlugin)` beside the hooks line.

- [ ] **Step 1: Write the failing pusher tests** (mirror `test/claudeAgentHooks.test.js:455-500`: a script-text test, then a real `/bin/sh` run with `HOME` in a temp dir and a fake `opencode` on PATH):

```js
test('the install script interpolates nothing and reads the plugin from stdin', () => { /* no 'tmuxifier-agent' asset text inside buildOpencodePluginInstallScript(); contains OPENCODE_CONFIG_DIR default and OPENCODEPLUGIN markers */ });
test('without opencode on the box the script drains stdin, prints skipped-no-opencode, writes nothing, exits 0', async () => {});
test('with opencode present the plugin lands at <config>/plugins/tmuxifier-agent.js, mode 0644, byte-identical, and a rerun is idempotent', async () => {});
test('OPENCODE_CONFIG_DIR overrides the target directory', async () => {});
test('createOpencodePluginPusher maps applied, skipped and failures without throwing', async () => {});
```

Setup-manager test (beside line 373): a job with `tools: ['opencode']` records `job.opencodePlugin` `{ target: 'opencode-plugin', ok: true }` and runs the phase after `voice-link` and before `script`; a job without `opencode` never calls it; a throwing pusher records `{ target: 'opencode-plugin', ok: false, error: 'opencode plugin push failed' }` and the job is `done`. `setupStatus.test.js`: phase text.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the pusher module (header comment: why no settings merge and why no restart advice — spec §3.3), wire `pushOpencodePlugin` in `createSetupManager`'s options and loop, `index.js` pusher with `readAsset: () => fs.promises.readFile(new URL('./assets/tmuxifier-opencode-agent.js', import.meta.url))`, `toPublic` (line 146) exposing `opencodePlugin`, web types and rendering.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** — `feat(setup): opencode-plugin phase pushes the agent-state reporter`.

---

### Task 8: Host Shell flag

**Files:**
- Modify: `src/server/localShellActions.js:83-125`, `src/server/server.js:2041-2069`, `src/web/api.ts:401-407`, `src/web/main.ts:2425-2440`
- Test: `test/localShellActions.test.js`, `test/server.local-shell` cases (find the existing `PATCH /api/local-shell` tests with `grep -rn "local-shell" test/*.test.js`)

**Interfaces:**
- Produces: `createLocalShellActions({ …, readOpencodeAsset = readOpencodeAssetDefault })` gains `installOpencodePlugin()` → pusher result. `PATCH /api/local-shell` body accepts `opencodePlugin: true` (strict `=== true`), response gains `opencodePlugin` when requested; independent of `claudeHooks`. `api.updateLocalShell(shell, claudeHooks = false, opencodePlugin = false)`. Settings UI: a second checkbox "Also install the OpenCode agent-state plugin on this host" beside the existing hooks checkbox (`hooksCheck`), result folded into the same `missed` list.

- [ ] **Step 1: Write the failing tests**: `installOpencodePlugin runs the install script locally with the plugin bytes on stdin`, `installOpencodePlugin maps skipped-no-opencode`, route test `PATCH /api/local-shell with opencodePlugin: true returns the pusher result and still saves the shell`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** server, route, api, UI.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** — `feat(local-shell): opencodePlugin flag installs the reporter on the host`.

---

### Task 9: e2e and docs

**Files:**
- Modify: `test/e2e/setup-server-side.spec.ts` (or the spec that asserts `agentHooks` skipped), `docs/boxes-and-setup.md:61-137`, `docs/fleet-and-health.md:65-90`, `docs/mcp.md` (agent wording), `README.md` (tool list), `CLAUDE.md` + `AGENTS.md` (module map: `opencodeAgentPlugin.js`, the asset, `agentKindOf`, the `opencode` tool, the `NO_SERVER_RE` note)

- [ ] **Step 1: e2e** — in the server-side setup spec add: ticking `opencode` on the isolated box ends `done` with `opencodePlugin` `{ target: 'opencode-plugin', ok: false, skipped: 'no OpenCode on the box' }`; the setup viewer shows `opencode-plugin skipped (no OpenCode on the box)`. Run `npm run build && npm run test:e2e -- setup-server-side` in the worktree → PASS.
- [ ] **Step 2: Docs** — boxes-and-setup: an "The OpenCode checkbox" section mirroring the Claude one (installer lands in `~/.opencode/bin`, plugin at `~/.config/opencode/plugins/tmuxifier-agent.js`, hot-loaded, no restart; the shared-server facts in two sentences; the same-directory limitation). fleet-and-health: "Claude Code" → "Claude Code or OpenCode" where the state semantics are described, plus the OpenCode-specific notes (a rejected prompt ends the turn; background shells via ctrl+b keep `working`). CLAUDE.md/AGENTS.md: one entry each, kept in sync.
- [ ] **Step 3: Commit** — `docs: OpenCode agent-state tracking`.

---

### Task 10: Live validation (before merge, per CLAUDE.md)

- [ ] **Step 1:** In the worktree: `npm run build`; from the main checkout `rsync -a --delete <worktree>/dist/ ./dist/` and `rsync -a <worktree>/src/ ./src/`; confirm no job is `running` (`GET /api/setup`, fleet, provision, lifecycle, voice-install, apk-build); `sudo systemctl restart tmuxifier`; fetch one hashed asset and expect its real content-type.
- [ ] **Step 2:** On the test box (box id from `list_boxes`): remove the recorder files first (`rm -f ~/.config/opencode/plugins/tmuxifier-recorder.ts`), keep the mock `opencode.json` so no credentials are needed; run setup with `opencode` ticked; expect `opencodePlugin ✓` and `~/.config/opencode/plugins/tmuxifier-agent.js` present **while the orphaned server keeps running** (hot-load); then `ls ~/.tmuxifier-agent/`.
- [ ] **Step 3:** In the box's `web` session: `cd ~/octest/proj && opencode`; within 15 s the pane chip reads idle; prompt `touch a file` → chip `Needs you: permission` and an `agent-blocked` event naming OpenCode; grant → working → done; ack in the browser → idle; `/exit` → marker deleted within 15 s and `agent-done` "OpenCode exited". Rerun setup once more with the TUI open and prompt again: state still flows (hand-over).
- [ ] **Step 4:** Record the outcome in the memory note; only then merge, version bump, build, restart, tag, release per CLAUDE.md "Shipping"; finally undo the box leftovers listed in the memory note.
