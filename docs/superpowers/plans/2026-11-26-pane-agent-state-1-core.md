# Pane-Level Agent State, Part 1 (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tmux pane the unit of agent state in the server, the browser, agent mail, agent workers, push and the MCP server, and delete the session-keyed model.

**Architecture:** The probe lists every pane with its window and on-screen flags; markers are parsed into a map keyed by pane id; each health sample carries one entry per agent pane with everything a renderer needs to name it and jump to it. Edges, the seen watermark, events and every surface key on the pane id. Sessions and windows remain labels, attach targets and mail addresses; summaries ("worst of") are computed on the spot and never stored.

**Tech Stack:** Node 22 ESM (`src/server`, plain `.js`), TypeScript + xterm.js (`src/web`), vitest, Playwright, POSIX `sh` and tmux on the boxes.

**Spec:** `docs/superpowers/specs/2026-11-26-pane-level-agent-state-design.md`. Read it first; this plan argues from it.

**Sibling plans (same branch, same release):** `2026-11-26-pane-agent-state-2-box-writers.md` (OSC reporter, OpenCode plugin) and `2026-11-26-pane-agent-state-3-android.md`. They depend only on the contracts in "Shared contract" below.

**Order across the three plans:** this plan's Tasks 1-18, then plan 2, then plan 3, then this plan's Task 19 (docs) and Task 20 (live walk). Plan 2 touches only the two box-side assets and their tests, so it may also run before or alongside Tasks 1-18. Plan 2's last task already rewrites the two writers' entries in `CLAUDE.md`, `AGENTS.md` and the guides; Task 19 here leaves those entries as plan 2 wrote them.

## Global Constraints

- Work in the worktree `/root/tmuxifier/.claude/worktrees/pane-agent-state` (branch `pane-agent-state`). First step of the first task: `npm ci` there. Never commit `node_modules` (stage explicit paths, never `git add -A`).
- **Never run a tmux command against the default tmux server.** Tests and spikes use a private server: `test/helpers/workerBench.js`, `test/helpers/localBox.js`, or an explicit `-S <socket>`. Never `kill-server` without an explicit private socket.
- Never run `npm run build` in `/root/tmuxifier` (the live app serves its `dist/`). Building in the worktree is fine.
- TDD: failing test first. Tests use real code, not mocks; modules are factories with injected dependencies.
- tmux targets are exact and session-qualified. Every id is validated on the route and re-validated in the builder immediately before interpolation: `SESSION_NAME_RE`, `WINDOW_ID_RE`, and the new `PANE_ID_RE = /^%\d{1,9}$/`.
- Box output is untrusted: every parsed field is allowlisted, bad rows drop (never rewritten), row caps stay (`PANE_ROWS_MAX = 400`, 200 window rows).
- Maps keyed by box-controlled strings are null-prototype and read with `Object.hasOwn`.
- The watch stream's vocabulary stays `c`/`h`; `/live` still sends only `{"box":"<id>"}`.
- Every web fetch goes through `http.ts`. Text from a box is rendered with `textContent` only.
- Public repo: no real hostnames, IPs or emails in code, tests or docs. Use `web01`, `192.168.1.10`, `example.com`.
- Commit messages are conventional commits and end with the attribution line the session provides.
- Commands: one file `npx vitest run test/<file>`; everything `npm test` (typecheck + vitest); browser `npm run test:e2e -- <spec>`.

## Shared contract

Fixed names and shapes. Later tasks and the sibling plans rely on them verbatim.

```js
// sshCommand.js
export const PANE_ID_RE = /^%\d{1,9}$/;

// status.js
export const PANE_FMT = '#{session_name}:#{window_id}:#{pane_id}:#{pane_index}:#{pane_active}:#{window_zoomed_flag}:#{pane_current_command}';
// PaneRow = { session, windowId, pane, index, active, zoomed, cmd }
export function parseTmuxPanes(stdout)   // -> { panes: PaneRow[], complete: boolean }
export function parsePaneMarks(stdout)   // -> null-prototype { [paneId]: { session, state, cause, ts } } | null
// probe()/checkAgents() results carry: sessions, panes? (PaneRow[], only when the listing is complete), paneMarks?

// healthHistory.js
export function onScreenPanes(status)    // -> Set<paneId>: visible && attached
export function sampleOf(status, at, { seenOf } = {})   // seenOf(paneId) -> ts | undefined
export function agentEdges(before, next, onScreen = new Set())
// history.markSeen(boxId, paneId, ts)
```

Sample entry, `sample.agents['%12']`:

```js
{ session: 'main', windowId: '@3', windowIndex: 2, windowName: 'frontend', paneIndex: 1,
  agent: 'claude', state?: 'working'|'blocked'|'done'|'idle', cause?, ts?,
  visible: true, focused: true, attached: true }
```

- `visible` = the pane's window is its session's active window and (the window is not zoomed or the pane is the window's active pane). `focused` = active window and active pane. `attached` = the session row's `attached`.
- Only panes whose `cmd` has an agent kind get an entry. `sample.agent`, `agentPresent`, `agentAttached` no longer exist.

Event (agent kinds): `{ kind, boxId, label, host, t, seq, session, pane, windowId, window: '2:frontend', paneIndex?, cause?, agent? }`. `paneIndex` only when that window held more than one agent entry.

**Naming rule** (one definition per runtime, pinned equal by test): name = `` `${windowIndex}:${windowName || 'window'}` ``; append `` `.${paneIndex}` `` only when the box has more than one agent entry with the same `session` and `windowId`; prefix `` `${session} › ` `` only when the box's agent entries span more than one session. Order: session (plain string compare), `windowIndex`, `paneIndex`. An event's place is `` `${session} › ${window}` `` plus `` `.${paneIndex}` `` when present.

Routes:

- `POST /api/boxes/:id/agent-seen` `{ pane, ts }`
- `POST /api/boxes/:id/window` `{ session, windowId, paneId? }` -> `{ ok, windowId, paneId? }`
- `GET /api/boxes/:id/pane[?pane=%N]` -> existing fields + `agent`, `agentCause`, `agentTs`, `pane`, `sessionName`. The `session` query parameter is removed.
- `POST /api/local-shell/window` `{ windowId, paneId? }`; `GET /api/local-shell/pane[?pane=%N]`

Marker files (written by the box-side writers, plan 2): `~/.tmuxifier-agent/<safe session><%pane>` holding `<session>:<state>:<epoch>:<cause>:%<pane>`.

## Review Focus

1. **A pane listing that is absent or at the 400-row cap.** Expected: no `agents` key on that sample, so no `agent-done` storm and the baseline survives. Pinned in Task 3.
2. **A pane id reused after the box's tmux server restarted, with an old watermark on file.** Expected: the new agent's finished turn reads `done`, not `idle`. Pinned in Task 4.
3. **Jumping to a pane that closed or moved between the poll and the click.** Expected: 502, nothing else gets focused, the UI says so. Pinned in Task 5 against a real tmux.
4. **A box that has not had setup rerun, with two agent panes in one session and one session-wide marker.** Expected: both panes show that state, and acknowledging one never clears the other. Pinned in Tasks 2 and 4.
5. **An `agent-seen.json` from before the upgrade (session-name keys).** Expected: loads without error, the old keys are dropped, nothing reads `idle` because of them. Pinned in Task 4.

---

### Task 1: The probe lists panes

**Files:**
- Modify: `src/server/sshCommand.js` (beside `WINDOW_ID_RE`), `src/server/status.js` (`PANE_FMT`, `parseLivePanes`, `probe`, `checkAgents`)
- Create: `src/server/agentKind.js`
- Modify: `src/server/healthHistory.js` (re-export `agentKindOf` from `agentKind.js`)
- Test: `test/status.test.js`, `test/sshCommand.test.js`

**Interfaces:**
- Produces: `PANE_ID_RE`; `PANE_FMT`; `parseTmuxPanes(stdout) -> { panes, complete }`; `status.panes`; `agentKindOf(cmd)` importable from `./agentKind.js` (and still from `./healthHistory.js`).

- [ ] **Step 1: `npm ci` in the worktree, then write the failing tests**

```js
// test/status.test.js
const OUT = [
  'main:2:1:1700000000:zsh',
  '__WIN__ main:1:@0:0:api',
  '__WIN__ main:2:@1:1:we:ird',
  '__PANE__ main:@0:%0:1:1:0:claude',
  '__PANE__ main:@1:%1:1:0:1:node:with:colons',
  '__PANE__ main:@1:%2:2:1:1:zsh',
].join('\n');

it('parseTmuxPanes reads one row per pane, command last', () => {
  expect(parseTmuxPanes(OUT)).toEqual({ complete: true, panes: [
    { session: 'main', windowId: '@0', pane: '%0', index: 1, active: true, zoomed: false, cmd: 'claude' },
    { session: 'main', windowId: '@1', pane: '%1', index: 1, active: false, zoomed: true, cmd: 'node:with:colons' },
    { session: 'main', windowId: '@1', pane: '%2', index: 2, active: true, zoomed: true, cmd: 'zsh' },
  ] });
});
it('drops a row with a bad id, index or flag instead of the listing', () => {
  const bad = ['__PANE__ main:@x:%0:1:1:0:claude', '__PANE__ main:@0:%0:1:2:0:claude', '__PANE__ main:@0:0:1:1:0:claude', '__PANE__ main:@0:%3:1:1:0:claude'].join('\n');
  expect(parseTmuxPanes(bad).panes.map((p) => p.pane)).toEqual(['%3']);
});
it('is not complete with no rows or at the row cap', () => {
  expect(parseTmuxPanes('main:1:0::zsh').complete).toBe(false);
  const capped = Array.from({ length: PANE_ROWS_MAX }, (_, i) => `__PANE__ main:@0:%${i}:${i}:0:0:zsh`).join('\n');
  expect(parseTmuxPanes(capped).complete).toBe(false);
});
```

Add to the existing probe test in the same file: a probe whose stdout is `OUT` resolves with `panes` equal to the three rows above; a probe whose stdout is `__NO_TMUX__` resolves with `panes: []`; a probe with session rows but no `__PANE__` rows has no `panes` key. Same three assertions for `checkAgents`. Assert `PROBE_REMOTE` contains `list-panes -a -F '__PANE__ ${PANE_FMT}'`.

`test/sshCommand.test.js`: `PANE_ID_RE` accepts `%0`, `%123456789`; rejects `%`, `%1234567890`, `12`, `%1a`, `@1`, `%1\n`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/status.test.js test/sshCommand.test.js`
Expected: FAIL (`parseTmuxPanes` is not exported).

- [ ] **Step 3: Implement**

`PANE_FMT` as in the shared contract. `parseTmuxPanes`: `session` passes the session-row name rules (non-empty, at most `SESSION_NAME_MAX`, no `UNSAFE_NAME_RE` match); `windowId` passes `WINDOW_ID_RE`; `pane` passes `PANE_ID_RE`; `index` is a non-negative integer; both flags are exactly `0` or `1`; `cmd` is `cleanWindowName` of everything after the sixth colon. `complete` is `rows > 0 && rows < PANE_ROWS_MAX`, counting `__PANE__` lines before validation. `probe` and `checkAgents` set `panes` when `complete`, and `panes: []` when the session list is empty. Keep `parseLivePanes` working on the new row layout (it is deleted in Task 10). Move `agentKindOf` to `agentKind.js`.

- [ ] **Step 4: Run and see them pass**

Run: `npx vitest run test/status.test.js test/sshCommand.test.js test/agentPaneMarks.test.js test/localAgent.test.js`
Expected: PASS. Fix the `__PANE__` fixture rows in `agentPaneMarks.test.js` and `localAgent.test.js` to the new seven-field layout; their assertions do not change.

- [ ] **Step 5: Commit** `feat(status): list every pane with its window and focus flags`

### Task 2: Markers parsed per pane

**Files:**
- Modify: `src/server/status.js`, `src/server/statusPoller.js` (`settle`, `refreshAgents`), `src/server/localAgent.js` (`readAgentMarks`, `sample`)
- Test: `test/agentPaneMarks.test.js` (new `describe('parsePaneMarks')`), `test/statusPoller.test.js`, `test/localAgent.test.js`

**Interfaces:**
- Consumes: `parseTmuxPanes`, `agentKindOf`.
- Produces: `parsePaneMarks(stdout)`; `status.paneMarks` on `probe`, `checkAgents` and the Host Shell sample. `agentMarks` and `parseAgentMarks` stay until Task 10.

- [ ] **Step 1: Write the failing tests**

```js
const P = (rows) => rows.map((r) => `__PANE__ ${r}`).join('\n');
const A = (rows) => rows.map((r) => `__AGENT__ ${r}`).join('\n');

it('keys a five-field marker by its pane', () => {
  const out = [A(['main:blocked:1700000100:permission:%1', 'main:working:1700000200:prompt:%2']), P(['main:@0:%1:1:1:0:claude', 'main:@0:%2:2:0:0:claude'])].join('\n');
  expect({ ...parsePaneMarks(out) }).toEqual({
    '%1': { session: 'main', state: 'blocked', cause: 'permission', ts: 1700000100 },
    '%2': { session: 'main', state: 'working', cause: 'prompt', ts: 1700000200 },
  });
});
it('drops a pane marker whose pane is gone, at a shell, or listed in another session', () => {
  const out = [A(['main:ready:1700000100:stop:%1', 'main:ready:1700000100:stop:%2', 'main:ready:1700000100:stop:%3']), P(['main:@0:%2:1:1:0:zsh', 'other:@1:%3:1:1:0:claude'])].join('\n');
  expect(parsePaneMarks(out)).toBeNull();
});
it('applies a session-wide marker to every agent pane of the session with no marker of its own', () => {
  const out = [A(['main:working:1700000300:prompt', 'main:blocked:1700000100:permission:%1']),
    P(['main:@0:%1:1:1:0:claude', 'main:@0:%2:2:0:0:codex', 'main:@1:%3:1:1:0:pi', 'main:@1:%4:2:0:0:zsh', 'other:@2:%5:1:1:0:codex'])].join('\n');
  const m = parsePaneMarks(out);
  expect(Object.keys(m).sort()).toEqual(['%1', '%2', '%3']);
  expect(m['%1'].state).toBe('blocked');
  expect(m['%2']).toEqual({ session: 'main', state: 'working', cause: 'prompt', ts: 1700000300 });
  expect(m['%3']).toEqual(m['%2']);
});
it('reads the legacy three-field marker as session-wide', () => {
  const out = [A(['main:waiting:1700000100']), P(['main:@0:%1:1:1:0:claude'])].join('\n');
  expect(parsePaneMarks(out)['%1']).toEqual({ session: 'main', state: 'ready', cause: 'stop', ts: 1700000100 });
});
it('with no trustworthy listing keeps pane markers and applies session-wide ones to nothing', () => {
  const out = A(['main:working:1700000300:prompt', 'main:blocked:1700000100:permission:%1']);
  expect(Object.keys(parsePaneMarks(out))).toEqual(['%1']);
});
it('takes the newest when two markers name one pane and both sessions list it', () => {
  const out = [A(['a:ready:1700000100:stop:%1', 'b:working:1700000200:prompt:%1']), P(['a:@0:%1:1:1:0:claude', 'b:@0:%1:1:1:0:claude'])].join('\n');
  expect(parsePaneMarks(out)['%1']).toMatchObject({ session: 'b', state: 'working' });
});
it('refuses unknown states, causes, a non-positive ts and a session named __proto__ as an inherited key', () => {
  const out = [A(['main:bogus:1700000100:stop:%1', 'main:ready:0:stop:%1', 'main:ready:1700000100:nope:%1', '__proto__:ready:1700000100:stop:%2']), P(['main:@0:%1:1:1:0:claude', '__proto__:@1:%2:1:1:0:claude'])].join('\n');
  const m = parsePaneMarks(out);
  expect(Object.keys(m)).toEqual(['%2']);
  expect(Object.getPrototypeOf(m)).toBeNull();
});
```

`test/statusPoller.test.js`: extend the existing ordering test so an unordered full probe keeps the snapshot's `panes` and `paneMarks` along with `sessions`; and `refreshAgents` patches both in. `test/localAgent.test.js`: `sample()` returns `paneMarks` and `panes` for a fixture home with a `local%4` marker.

- [ ] **Step 2: Run, expect FAIL** (`parsePaneMarks` is not exported)

Run: `npx vitest run test/agentPaneMarks.test.js test/statusPoller.test.js test/localAgent.test.js`

- [ ] **Step 3: Implement `parsePaneMarks`** by the rules in spec section 4.2 and wire `paneMarks` into `probe`, `checkAgents`, `settle`, `refreshAgents` and the Host Shell sample, exactly where `agentMarks` is handled today. No per-session fold. "Agent pane" in the session-wide rule is `agentKindOf(row.cmd) !== null`.

- [ ] **Step 4: Run, expect PASS** (same command, plus `test/status.test.js`)

- [ ] **Step 5: Commit** `feat(status): parse agent markers into a per-pane map`

### Task 3: Samples, edges and events per pane

**Files:**
- Modify: `src/server/healthHistory.js` (`sampleOf`, `AGENT_SAMPLE_KEYS`, `agentEdges`, `classifyTransitions`, `record`, `recordAgents`)
- Test: `test/healthHistory.test.js`

**Interfaces:**
- Consumes: `status.sessions[].{name, attached, windowList}`, `status.panes`, `status.paneMarks`.
- Produces: `onScreenPanes(status)`, `sampleOf(status, at, { seenOf })`, `agentEdges(before, next, onScreen)`, the sample entry and the event shape of the shared contract. `classifyTransitions(prev, next, thresholds, state, onScreen)` gains the fifth argument.

- [ ] **Step 1: Write the failing tests**

```js
const status = (over = {}) => ({
  reachable: true, tmux: true,
  sessions: [{ name: 'main', windows: 2, attached: true, activity: 0, paneCmd: 'zsh',
    windowList: [{ id: '@0', index: 1, name: 'api', active: false }, { id: '@1', index: 2, name: 'frontend', active: true }] }],
  panes: [
    { session: 'main', windowId: '@0', pane: '%0', index: 1, active: true, zoomed: false, cmd: 'claude' },
    { session: 'main', windowId: '@1', pane: '%1', index: 1, active: true, zoomed: false, cmd: 'claude' },
    { session: 'main', windowId: '@1', pane: '%2', index: 2, active: false, zoomed: false, cmd: 'codex' },
    { session: 'main', windowId: '@1', pane: '%3', index: 3, active: false, zoomed: false, cmd: 'zsh' },
  ],
  paneMarks: Object.assign(Object.create(null), {
    '%0': { session: 'main', state: 'blocked', cause: 'permission', ts: 100 },
    '%1': { session: 'main', state: 'ready', cause: 'stop', ts: 200 },
  }),
  ...over,
});

it('builds one entry per agent pane', () => {
  const s = sampleOf(status(), 1, { seenOf: (p) => (p === '%1' ? 200 : undefined) });
  expect(Object.keys(s.agents)).toEqual(['%0', '%1', '%2']);
  expect(s.agents['%0']).toEqual({ session: 'main', windowId: '@0', windowIndex: 1, windowName: 'api', paneIndex: 1,
    agent: 'claude', state: 'blocked', cause: 'permission', ts: 100, visible: false, focused: false, attached: true });
  expect(s.agents['%1']).toMatchObject({ state: 'idle', visible: true, focused: true });
  expect(s.agents['%2']).toMatchObject({ agent: 'codex', visible: true, focused: false });
  expect('state' in s.agents['%2']).toBe(false);
  expect('agent' in s).toBe(false);
});
it('hides a pane behind a zoomed neighbour', () => {
  const z = status();
  z.panes = z.panes.map((p) => (p.windowId === '@1' ? { ...p, zoomed: true } : p));
  const s = sampleOf(z, 1);
  expect(s.agents['%1'].visible).toBe(true);
  expect(s.agents['%2'].visible).toBe(false);
  expect([...onScreenPanes(z)].sort()).toEqual(['%1']);
});
it('carries no agents key when sessions are listed but panes are not', () => {
  const st = status(); delete st.panes;
  expect('agents' in sampleOf(st, 1)).toBe(false);
});
it('an empty session list is an empty map', () => {
  expect(sampleOf({ reachable: true, tmux: false, sessions: [], panes: [] }, 1).agents).toEqual({});
});
it('omits a pane whose window row is missing', () => {
  const st = status(); st.sessions[0].windowList = st.sessions[0].windowList.slice(1);
  expect(Object.keys(sampleOf(st, 1).agents)).toEqual(['%1', '%2']);
});
it('a pane listed under two grouped sessions is one entry, under the session its marker names', () => {
  const st = status();
  st.sessions.push({ name: 'twin', windows: 2, attached: false, activity: 0, paneCmd: 'zsh', windowList: [{ id: '@0', index: 1, name: 'api', active: true }] });
  st.panes.unshift({ session: 'twin', windowId: '@0', pane: '%0', index: 1, active: true, zoomed: false, cmd: 'claude' });
  const a = sampleOf(st, 1).agents['%0'];
  expect(a).toMatchObject({ session: 'main', visible: false, attached: true });   // main's flags, not twin's
});
```

Edges (build `before`/`next` with `sampleOf`, changing only `paneMarks` and flags):

```js
it('a pane blocking in a background window notifies even while the session is attached', () => {
  const before = sampleOf(status({ paneMarks: marks({ '%0': ['working', 'prompt', 90] }) }), 1).agents;
  const next = sampleOf(status(), 2);
  expect(agentEdges(before, next, onScreenPanes(status()))).toEqual([
    { kind: 'agent-blocked', pane: '%0', session: 'main', windowId: '@0', window: '1:api', cause: 'permission', agent: 'claude' },
  ]);
});
it('the same edge for a pane on screen is silent', () => { /* %1 working -> blocked, visible and attached: [] */ });
it('a finished turn off screen is agent-input and names the pane index when the window holds two agents', () => {
  /* %2 (codex) working -> ready/stop with window @1 not the active one: event has window: '2:frontend', paneIndex: 2 */
});
it('a pane that had a state and left the listing is agent-done; one now at a shell on screen is not', () => { /* two cases */ });
it('a pane still running its agent with no marker is a gap, not an exit', () => { /* [] */ });
it('first appearance emits nothing', () => { expect(agentEdges(undefined, sampleOf(status(), 1), new Set())).toEqual([]); });
```

`record`/`recordAgents` through `createHealthHistory` (follow the file's existing harness): an emitted event carries `boxId`, `label`, `pane`, `session`, `windowId`, `window`; `recordAgents` keeps bridging a gap in the baseline (existing test re-keyed by pane); a snapshot entry with sessions but no `panes` neither emits nor replaces the baseline (**Review Focus 1**): record a sample with `%0` working, then one without `panes`, then one where `%0` is gone, and assert exactly one `agent-done` only on the third.

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/healthHistory.test.js`

- [ ] **Step 3: Implement.** `sampleOf`: `agents` exists when `sessions` is an array and (`panes` is an array or `sessions` is empty). For each pane row, in order, whose `agentKindOf(cmd)` is not null and whose session row and window row exist: build the entry; a pane id already present (grouped sessions) is replaced only when the row's session equals its mark's `session`. `AGENT_SAMPLE_KEYS = ['tmux', 'agents']`. `agentEdges`: per pane id; "on screen" for an entry is `visible && attached`; for `agent-done` the `now` side is `onScreen.has(pane)`. Event fields come from the current entry, or from the previous one for `agent-done`. `record` and `recordAgents` pass `onScreenPanes(status)` and copy `pane`, `windowId`, `window`, `paneIndex` onto the emitted event beside `session`. Delete the `sessionName` option and the `configured` map.

- [ ] **Step 4: Run, expect PASS.** Then `npx vitest run test/statusPoller.test.js test/localAgent.test.js test/agentWatch.integration.test.js test/agentHooks.integration.test.js` and update their assertions to the pane-keyed sample (the hook integration test asserts one entry per split pane, each with its own state).

- [ ] **Step 5: Commit** `feat(health): agent samples, edges and events keyed by pane`

### Task 4: Seen, per pane

**Files:**
- Modify: `src/server/healthHistory.js` (seen load, prune, `markSeen`), `src/server/agentSeenStore.js` (header comment), `src/server/server.js` (`POST /api/boxes/:id/agent-seen`)
- Test: `test/healthHistory.test.js`, `test/server.test.js`, `test/deviceRoutes.test.js`

**Interfaces:**
- Produces: `history.markSeen(boxId, paneId, ts) -> boolean`; route body `{ pane, ts }`; file shape `{ [boxId]: { [paneId]: ts } }`.

- [ ] **Step 1: Write the failing tests**

```js
it('markSeen turns that pane idle and leaves its neighbour done', () => {
  // history with %1 and %2 both ready/stop ts 200 (one session-wide marker, two agent panes: Review Focus 4)
  expect(h.markSeen('b1', '%1', 200)).toBe(true);
  const a = h.getSeries('b1').at(-1).agents;
  expect(a['%1'].state).toBe('idle');
  expect(a['%2'].state).toBe('done');
});
it('refuses a ts ahead of the marker and a pane with no marker', () => {
  expect(h.markSeen('b1', '%1', 201)).toBe(false);
  expect(h.markSeen('b1', '%9', 200)).toBe(false);
});
it('drops watermark keys that are not pane ids on load', () => {
  // seenStore.load() -> { b1: { main: 999999, '%1': 150 } } (Review Focus 5)
  // record %1 ready/stop ts 200 -> state 'done' (150 < 200); then the next persisted object is { b1: { '%1': 150 } }
});
it('a reused pane id with an old watermark still reads done', () => {
  // seen { b1: { '%1': 500 } }; record %1 ready/stop ts 900 -> 'done' (Review Focus 2)
});
it('prunes watermarks of panes no longer listed', () => { /* %1 leaves status.panes -> persisted without it */ });
```

Route (`test/server.test.js`, re-key the existing agent-seen tests): `{ pane: '%1', ts: 200 }` -> 200 `{ ok: true }` and one `liveHub.publish`; `{ session: 'main', ts: 200 }` -> 400 `{ error: 'invalid pane or ts' }`; `{ pane: '%1;rm', ts: 200 }` -> 400; ts ahead -> 400 `nothing to acknowledge`; unknown box -> 404; `__local__` accepted. `test/deviceRoutes.test.js`: a device token may post `{ pane, ts }`.

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/healthHistory.test.js test/server.test.js test/deviceRoutes.test.js`

- [ ] **Step 3: Implement.** Load keeps only keys passing `PANE_ID_RE` with a finite ts. Prune against the ids in `status.panes` (when `panes` is an array). `markSeen` is today's logic keyed by pane, without the `configured` branch.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit** `feat(health): the seen watermark is per pane`

### Task 5: Focus a pane

**Files:**
- Modify: `src/server/boxActions.js` (beside `buildSelectWindowRemote`), `src/server/server.js` (`POST /api/boxes/:id/window`)
- Test: `test/boxActions.test.js`, `test/windowSelectRoute.test.js`, `test/paneFocus.integration.test.js` (create)

**Interfaces:**
- Produces: `buildSelectPaneRemote(session, windowId, paneId) -> string`; route accepts `paneId`.

- [ ] **Step 1: Write the failing tests**

```js
// test/boxActions.test.js
it('selects the window, then the pane, by exact qualified targets', () => {
  const s = buildSelectPaneRemote('main', '@3', '%12');
  expect(s).toContain(`"$TMUX_BIN" select-window -t '=main:@3'`);
  expect(s).toContain(`"$TMUX_BIN" select-pane -Z -t '=main:@3.%12'`);
  expect(s.indexOf('select-window')).toBeLessThan(s.indexOf('select-pane'));
});
it('throws on a bad id', () => {
  expect(() => buildSelectPaneRemote('main', '@3', '%12; id')).toThrow('invalid pane id');
  expect(() => buildSelectPaneRemote('ma in', '@3', '%12')).toThrow('invalid session name');
  expect(() => buildSelectPaneRemote('main', '3', '%12')).toThrow('invalid window id');
});
```

Route: `{ session: 'main', windowId: '@3', paneId: '%12' }` runs the pane script and answers `{ ok: true, windowId: '@3', paneId: '%12' }`; `paneId: '12'` -> 400 `{ error: 'pane id must look like %12' }`; without `paneId` the existing behaviour and tests are unchanged; 409 while setup runs.

Integration (`test/paneFocus.integration.test.js`, private tmux exactly as `test/helpers/workerBench.js` provides it; run the built script with `sh` and `TMUX_BIN`/`TMUX_TMPDIR` pointing at the private server): session `main` with windows `@a`, `@b`, two panes each. (1) the script for `@a`'s first pane exits 0 and `list-panes` then shows that window active and that pane active; (2) with `@a` zoomed on pane 1, the script for pane 2 exits 0 and `#{window_zoomed_flag}` is still `1` with pane 2 active; (3) the script naming pane 1 under window `@b` exits non-zero and the active window and pane are unchanged (**Review Focus 3**); (4) the script for a session that does not exist exits non-zero.

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/boxActions.test.js test/windowSelectRoute.test.js test/paneFocus.integration.test.js`

- [ ] **Step 3: Implement.** The two commands are joined so a failed `select-window` skips `select-pane` and the script's exit status is the first failure's. The route validates `paneId` with `PANE_ID_RE` when present.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit** `feat(tmux): the window route can focus a pane`

### Task 6: Capture a named pane; the capture names its pane

**Files:**
- Modify: `src/server/tmuxInject.js` (`buildPaneSnapshotRemote`, `parsePaneSnapshot`), `src/server/boxActions.js` (`paneSnapshot`), `src/server/server.js` (`GET /api/boxes/:id/pane`)
- Test: `test/tmuxInject.test.js`, `test/paneRoutes.test.js`

**Interfaces:**
- Produces: `buildPaneSnapshotRemote(session, { lines, windowId, paneId })`; `parsePaneSnapshot` result gains `pane?`; `boxActions.paneSnapshot(box, session, { lines, timeoutMs, shared, windowId, paneId })`; route response fields `pane`, `agentTs`.

- [ ] **Step 1: Write the failing tests**

```js
it('targets the session\'s active pane by default and reports its id', () => {
  const s = buildPaneSnapshotRemote('main', { lines: 40 });
  expect(s).toContain(`-t '=main:' '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{alternate_on} #{mouse_any_flag} #{mouse_sgr_flag} #{pane_id}'`);
});
it('targets one pane exactly when given a window and a pane', () => {
  expect(buildPaneSnapshotRemote('main', { lines: 40, windowId: '@3', paneId: '%12' })).toContain(`capture-pane -e -p -t '=main:@3.%12' -S -40`);
  expect(() => buildPaneSnapshotRemote('main', { paneId: '%12' })).toThrow();   // a pane needs its window
});
it('parses the pane id, and still parses a line without it or without the flags', () => {
  expect(parsePaneSnapshot('80 24 0 0 0 0 0 %12\nhi').pane).toBe('%12');
  expect(parsePaneSnapshot('80 24 0 0 0 0 0\nhi').pane).toBeUndefined();
  expect(parsePaneSnapshot('80 24 0 0\nhi')).toMatchObject({ width: 80, height: 24 });
  expect(parsePaneSnapshot('80 24 0 0 0 0 0 %1x\nhi')).toBeNull();
});
```

Route (`test/paneRoutes.test.js`; latest sample holds `%12` = `{ session: 'work', windowId: '@3', state: 'done', cause: 'stop', ts: 200, ... }`):
- `GET /pane?pane=%2512` (browser) captures with `('work', { windowId: '@3', paneId: '%12', shared: true })` and answers `agent: 'done'`, `agentCause: 'stop'`, `agentTs: 200`, `pane: '%12'`, `sessionName: 'work'`.
- `?pane=%2599` (no such entry) -> 404 `{ error: 'no such agent pane' }`; `?pane=12` -> 400; with a device token -> 403 `{ error: 'browser session required' }`.
- No `pane`: the capture reports `pane: '%12'`, so the answer carries that entry's `agent`/`agentCause`/`agentTs`; when the captured pane has no entry, `agent: null`, `agentCause: null`, no `agentTs`.
- `?session=work` is no longer special: it is ignored (the configured session is captured).
- `cols`/`rows` still size a viewer only on the default branch.

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/tmuxInject.test.js test/paneRoutes.test.js`

- [ ] **Step 3: Implement.** The session and window for `?pane=` come from the server's own latest sample (own-key read), then pass the builders' validation again. The shared-capture key becomes box, session, pane, lines.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit** `feat(pane): capture any agent pane and report which pane was captured`

### Task 7: Host Shell

**Files:**
- Modify: `src/server/localAgent.js` (`sample`), `src/server/statusPoller.js` (`ownOnly`), `src/server/localShellActions.js` (`paneSnapshot`, new `selectWindow`), `src/server/server.js` (`GET /api/local-shell/pane`, new `POST /api/local-shell/window`)
- Test: `test/localAgent.test.js`, `test/statusPoller.test.js`, `test/localShellPane.test.js`, `test/localShellActions.test.js`

**Interfaces:**
- Produces: Host Shell sample with `sessions[].windowList`, `panes`, `paneMarks`; `localShellActions.selectWindow({ windowId, paneId }) -> { ok } | { ok: false, error }`; `localShellActions.paneSnapshot({ lines, windowId, paneId })`.

- [ ] **Step 1: Write the failing tests**
  - `localAgent.sample()` runs `list-windows -a -F '__WIN__ ${WINDOW_FMT}'` and returns sessions with `windowList` (parsed by `parseTmuxWindows` + `attachWindows`).
  - `ownOnly` keeps only `panes` and `paneMarks` whose `session` is the local session: a sample with panes in `local` and `other` records agents for `local` only.
  - `selectWindow({ windowId: '@1', paneId: '%4' })` runs a script containing `select-window -t '=local:@1'` then `select-pane -Z -t '=local:@1.%4'`; `selectWindow({ windowId: '@1' })` runs only the first; a bad id rejects without running anything; it never contains `new-session`.
  - `POST /api/local-shell/window` `{ windowId: '@1', paneId: '%4' }` -> `{ ok: true, windowId: '@1', paneId: '%4' }`; bad ids -> 400; a device token -> 403 (assert the route is absent from `DEVICE_ALLOWED_ROUTES`); a failed command -> 502; unavailable actions -> 503.
  - `GET /api/local-shell/pane?pane=%254` behaves as Task 6's `?pane=` against the `__local__` series; without it the answer carries `pane`, `agentTs` like the box route.

- [ ] **Step 2: Run, expect FAIL** (`npx vitest run` on the four files)

- [ ] **Step 3: Implement**, reusing `buildSelectPaneRemote`/`buildSelectWindowRemote` and `buildPaneSnapshotRemote` over the local `/bin/sh` transport the module already has.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit** `feat(local-shell): Host Shell agents are per pane and can be jumped to`

### Task 8: The watch loop notices a window switch

**Files:**
- Modify: `src/server/agentWatch.js` (`buildWatchScript`)
- Test: `test/agentWatch.test.js`, `test/agentWatch.integration.test.js`

**Interfaces:**
- Produces: nothing new; the stream still prints only `c` and `h`.

- [ ] **Step 1: Write the failing tests**
  - Unit: the script contains `tmux list-panes -a -F "#{pane_id}#{window_active}#{pane_active}#{window_zoomed_flag}"`, still contains no single quote, and still prints nothing but `c` and `h`.
  - Unit (run the script under `sh` with a stub `tmux` on `PATH` from `test/helpers/stubTmux.js` whose output changes between ticks, `tickSec` 1): a change in the stub's output with unchanged marker files prints one more `c`; with no `tmux` on `PATH` the loop behaves exactly as before.
  - Integration (private tmux, existing file's harness): `select-window` to another window, with no marker touched, reaches `statusPoller.refreshAgents` and flips the two panes' `visible` in the latest sample without a sweep.

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement.** One `tmux` call per tick, guarded by `command -v tmux`, its output appended to the compared signature. All errors silenced.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit** `feat(watch): a window or pane switch triggers the light probe`

### Task 9: Push text and payload

**Files:**
- Modify: `src/server/fcmPush.js` (`pushBody`, `buildFcmMessage`)
- Test: `test/fcmPush.test.js`

- [ ] **Step 1: Write the failing test**

```js
const ev = { boxId: 'b1', label: 'web01', kind: 'agent-blocked', cause: 'permission', agent: 'claude',
  session: 'main', pane: '%12', windowId: '@3', window: '2:frontend', paneIndex: 1 };
const m = buildFcmMessage({ projectId: 'p', fcmToken: 't', event: ev }).body.message;
expect(m.notification.body).toBe('Permission prompt in main › 2:frontend.1');
expect(m.data).toEqual({ boxId: 'b1', kind: 'agent-blocked', session: 'main', pane: '%12', windowId: '@3' });
// Android posts a background notification itself, so the per-pane replacement key must come from here:
expect(m.android).toEqual({ priority: 'HIGH', notification: { tag: 'b1:%12' } });
// an event with no pane (older log entry, non-agent kinds): android stays { priority: 'HIGH' }
// without paneIndex: '... in main › 2:frontend'; an event with no window (older log entry): '... in main'
// agent-input: 'Claude wants your input in main › 2:frontend.1.'; agent-done: 'Claude exited in main › 2:frontend.1.'
```

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS** (`npx vitest run test/fcmPush.test.js`)

- [ ] **Step 5: Commit** `feat(push): notifications name the pane`

### Task 10: Mail and workers read panes; the session map is deleted

**Files:**
- Modify: `src/server/agentMailHub.js` (header, `readMark`, `mailSessions`, `bareJob`, `queuedStatus`, `firstWaiter`/`canTake`/`deliverTo`, `who`, `checkStarts`), `src/server/agentWorkerRules.js` (`runningWorkers`), `src/server/agentWorkers.js` (`startNow`), `src/server/index.js` (wiring), `src/server/status.js` (delete `parseAgentMarks`, `parseLivePanes`, `foldMarks`, `markRank`, `agentMarks`), `src/server/statusPoller.js`, `src/server/localAgent.js` (delete `agentMarks`)
- Test: `test/agentMailHub.test.js`, `test/agentMailHubDelivery.test.js`, `test/agentMailHubWorkers.test.js`, `test/helpers/agentMailHarness.js`, `test/agentWorkerRules.test.js`, `test/agentWorkers.test.js`, `test/agentPaneMarks.test.js` (delete the old `describe`), `test/opencodeAgentMailClient.test.js` (only if its signature regex names a renamed parameter)

**Interfaces:**
- Consumes: `status.paneMarks`, `status.panes`.
- Produces: `createAgentMailHub({ ..., paneMarksOf, panesOf, sessionsOf, ... })` (signature still on one line): `paneMarksOf(boxId) -> { [paneId]: { session, state, cause, ts } } | null` (null = unreachable, `{}` = reachable with none); `panesOf(boxId) -> PaneRow[] | null`. `runningWorkers(panes) -> number`.

- [ ] **Step 1: Write the failing tests**

```js
// test/agentMailHubDelivery.test.js — harness marks are now pane-keyed
it('hands mail to the waiter whose own pane is ready while a sibling pane works', async () => {
  // box b2, session 'main': %1 working, %2 ready; waiters on %1 and %2
  // send to b2/main -> the %2 waiter receives the wake text; the %1 waiter stays held; message state 'handed', handedPane '%2'
});
it('keeps mail queued when the only waiter\'s pane is working or blocked', async () => { /* status phrase: queued-working / queued-blocked */ });
it('a waiter on a pane with no marker is never handed mail', async () => {});
// test/agentMailHub.test.js
it('a session runs an agent when any pane mark names it', async () => { /* who lists it once; state word = worst of its panes: blocked, then working, then idle */ });
it('a bare target still means sessions: configured first, else the only one, else several-agents', async () => {});
it('mail kinds are judged by any pane of the session, not only the active one', async () => {
  // session 'main': active pane zsh, background pane claude with a mark -> main can take mail
});
// test/agentWorkerRules.test.js
it('counts a worker session once when any of its panes runs claude', () => {
  expect(runningWorkers([
    { session: 'worker-site-1', pane: '%1', cmd: 'zsh' }, { session: 'worker-site-1', pane: '%2', cmd: 'claude' },
    { session: 'worker-site-2', pane: '%3', cmd: 'zsh' }, { session: 'main', pane: '%4', cmd: 'claude' },
  ])).toBe(1);
});
```

`test/agentMailHubWorkers.test.js`: the `starts` judging re-keyed (a pane mark naming the worker session means up; "on claude" is any pane of that session running `claude`), all existing timing assertions unchanged.

- [ ] **Step 2: Run, expect FAIL** (`npx vitest run test/agentMailHub*.test.js test/agentWorker*.test.js`)

- [ ] **Step 3: Implement.** Keep every hub behaviour not named above. Rewrite the hub header's "running an agent" and delivery paragraphs to the pane wording. `index.js`: `paneMarksOf = (id) => e?.reachable ? (e.paneMarks ?? {}) : null`, `panesOf = (id) => e?.reachable && Array.isArray(e.panes) ? e.panes : null`; the worker starter gets `panesOf` for the running count and keeps `sessionsOf` for taken names. Then delete the session-keyed parser, fold and `agentMarks` everywhere; `grep -rn "agentMarks\|parseAgentMarks\|agentPresent\|agentAttached" src/` must print nothing.

- [ ] **Step 4: Run `npm test`, expect PASS** (web and MCP unit tests still build their own samples and are untouched so far).

- [ ] **Step 5: Commit** `feat(mail): delivery and worker checks read panes; remove the session marker map`

### Task 11: Browser model: types, naming, rows

**Files:**
- Modify: `src/web/api.ts` (types, `agentSeen`, `selectWindow`, `panePreview`, `localPanePreview`, new `localSelectWindow`), `src/web/agentState.ts`
- Test: `test/agentState.test.js`, `test/agentNaming.test.js` (create)

**Interfaces:**
- Produces (TypeScript):

```ts
export interface AgentEntry { session: string; windowId: string; windowIndex: number; windowName: string; paneIndex: number;
  agent: AgentKind; state?: AgentState; cause?: AgentCause; ts?: number; visible: boolean; focused: boolean; attached: boolean }
// Sample.agents?: Record<string /* pane id */, AgentEntry>; Sample.agent/agentPresent/agentAttached removed
// HealthEvent gains pane?, windowId?, window?, paneIndex?
export interface AgentRow { pane: string; session: string; windowId: string; name: string; state: AgentState; cause?: AgentCause; agent: AgentKind; ts: number; visible: boolean; focused: boolean }
export function agentRows(agents: Record<string, AgentEntry> | undefined): AgentRow[]      // named, ordered, stateful only
export function worstOf(entries: Iterable<{ state?: AgentState; cause?: AgentCause }>): { state: AgentState; cause?: AgentCause; count: number } | null
export function sessionAgents(agents, session: string): AgentEntry[]
export function windowAgents(agents, session: string, windowId: string): AgentEntry[]
export function visibleDone(agents, session: string): { pane: string; ts: number }[]
export function eventPlace(e: { session?: string; window?: string; paneIndex?: number }): string
// AgentCard: { boxId, label, pane, session, windowId, name, state, cause?, ts }
// api.agentSeen(id, pane, ts); api.selectWindow(id, session, windowId, paneId?); api.localSelectWindow(windowId, paneId?)
// api.panePreview(boxId, pane, signal); api.localPanePreview(pane, signal)
```

`worstAgent` is deleted (callers move in Tasks 12-15; keep it exported until Task 15 removes the last one).

- [ ] **Step 1: Write the failing tests**

```js
const e = (over) => ({ session: 'main', windowId: '@1', windowIndex: 2, windowName: 'frontend', paneIndex: 1, agent: 'claude', state: 'working', ts: 10, visible: true, focused: false, attached: true, ...over });
it('names by window, adds the pane only for a shared window and the session only across sessions', () => {
  expect(agentRows({ '%1': e({}) }).map((r) => r.name)).toEqual(['2:frontend']);
  expect(agentRows({ '%1': e({}), '%2': e({ paneIndex: 2 }) }).map((r) => r.name)).toEqual(['2:frontend.1', '2:frontend.2']);
  expect(agentRows({ '%1': e({}), '%5': e({ session: 'worker-site-1', windowId: '@4', windowIndex: 1, windowName: 'claude' }) }).map((r) => r.name))
    .toEqual(['main › 2:frontend', 'worker-site-1 › 1:claude']);
  expect(agentRows({ '%1': e({ windowName: '' }) })[0].name).toBe('2:window');
});
it('orders by session, window, pane and skips entries with no state', () => {
  const rows = agentRows({ '%9': e({ windowIndex: 3, windowId: '@2' }), '%2': e({ paneIndex: 2 }), '%1': e({}), '%7': e({ windowIndex: 1, windowId: '@0', state: undefined }) });
  expect(rows.map((r) => r.pane)).toEqual(['%1', '%2', '%9']);
});
it('the pane suffix counts stateless agents in the window too', () => {
  expect(agentRows({ '%1': e({}), '%2': e({ paneIndex: 2, state: undefined }) })[0].name).toBe('2:frontend.1');
});
it('worstOf follows blocked, done, working, idle', () => {
  expect(worstOf([e({}), e({ state: 'blocked', cause: 'permission' }), e({ state: undefined })])).toEqual({ state: 'blocked', cause: 'permission', count: 2 });
  expect(worstOf([e({ state: undefined })])).toBeNull();
});
it('visibleDone lists only done panes visible in that session', () => {
  expect(visibleDone({ '%1': e({ state: 'done', ts: 5 }), '%2': e({ state: 'done', ts: 6, visible: false }), '%3': e({ state: 'done', ts: 7, session: 'x' }) }, 'main')).toEqual([{ pane: '%1', ts: 5 }]);
});
it('eventPlace', () => {
  expect(eventPlace({ session: 'main', window: '2:frontend', paneIndex: 1 })).toBe('main › 2:frontend.1');
  expect(eventPlace({ session: 'main', window: '2:frontend' })).toBe('main › 2:frontend');
  expect(eventPlace({ session: 'main' })).toBe('main');
  expect(eventPlace({})).toBe('');
});
```

`agentCounts` and `agentCards` tests: re-key the fixtures; a card carries `pane`, `name` (from `agentRows`), `windowId`.

`test/agentNaming.test.js` holds one table `NAMING_CASES` (`[{ agents, names: [...] }]`, the cases above) and asserts `agentRows` against it. Task 18 adds the MCP implementation to the same table.

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement** (naming rule exactly as in the shared contract). **Step 4:** `npx vitest run test/agentState.test.js test/agentNaming.test.js` PASS; `npm run typecheck` will fail in the callers until Task 15: run it and confirm every error is in a file a later task owns.

- [ ] **Step 5: Commit** `feat(web): pane-keyed agent model and the row naming rule`

### Task 12: Sidebar rows, the jump, and acknowledging what is visible

**Files:**
- Modify: `src/web/main.ts` (`applyAgentBadge`, `repaintAgentBadges`, `agentFilterMatches`, `reportSeen`, `createBoxRow`, the Host Shell row, `openPaneOnSession`), `src/web/statusDot.ts` (delete `agentBadgeFor`), `src/web/style.css`, `src/web/phoneMode.ts` (`CLOSES_DRAWER`)
- Create: `src/web/agentJump.ts` (pure)
- Test: `test/agentJump.test.js` (create), `test/statusDot.test.js` (delete the badge tests)

**Interfaces:**
- Consumes: `agentRows`, `visibleDone`, `api.selectWindow`, `api.localSelectWindow`, `api.agentSeen`.
- Produces:

```ts
// agentJump.ts
export interface JumpTarget { boxId: string; pane: string; session: string; windowId: string; focused: boolean }
export function jumpTargetOf(boxId: string, agents: Record<string, AgentEntry> | undefined, pane: string): JumpTarget | null
export function needsSelect(t: JumpTarget): boolean          // !t.focused
// main.ts
async function jumpToAgent(boxId: string, pane: string): Promise<void>
```

DOM contract (tests and e2e rely on it): directly after a box's `li.box` sits `li.box-agents[data-agents-for="<boxId>"]` holding one `button.box-agent[data-pane="%N"][data-state="<state>"]` per row, each with `span.box-agent-name` and the state chip `span.badge.badge-agent-<state>` (the working sprite inside it). No rows: the `li.box-agents` is absent. The Host Shell row gets the same element with `data-agents-for="__local__"`. `.box-badges` no longer holds an agent badge.

- [ ] **Step 1: Write the failing tests** (`test/agentJump.test.js`): `jumpTargetOf` returns the entry's session and window; `null` for an unknown pane and for an inherited key (`'constructor'`); `needsSelect` is false only for a focused entry.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.**
  - Rows repaint in place on health data, keyed by pane: build nothing when the rendered key (pane, name, state, cause) list is unchanged, so hover and focus survive a poll.
  - A row click stops propagation and calls `jumpToAgent`: dock the box on the target's session through the existing `openPaneOnSession` path; then, when `needsSelect`, call `api.selectWindow(boxId, session, windowId, pane)` (`api.localSelectWindow` for `__local__`); on a rejected call show the error where a failed window pick shows it today; then run the status and health refresh a window pick runs.
  - `reportSeen`: for each docked pane that passes today's visibility rules, post `api.agentSeen(boxId, pane, ts)` for every `visibleDone(latestAgents(series[boxId]), paneAgentSession(iid))`; the dedupe key becomes `` `${boxId}:${pane}` ``.
  - The strip filter keeps a box with any entry in that state (entries are panes now; the predicate text does not change).
  - CSS: layout B of the spec (section 7.1): indented under the box behind a 1px `var(--border)` guide, name left, chip right, own hover; hidden when the sidebar is collapsed; follows `DESIGN.md`. Add `.box-agent` to phone mode's drawer-closing controls.

- [ ] **Step 4: Run** `npx vitest run test/agentJump.test.js test/statusDot.test.js`, expect PASS.

- [ ] **Step 5: Commit** `feat(ui): one sidebar row per agent pane, with jump and per-pane seen`

### Task 13: Pane header chip and picker chips

**Files:**
- Modify: `src/web/paneHeader.ts` (`paneHeaderChip`, `sessionTargets`), `src/web/sessionPicker.ts` (only if the row cache key needs the new fields)
- Test: `test/paneHeader.test.js`, `test/sessionPicker.test.js`

- [ ] **Step 1: Write the failing tests**

```js
it('the chip is the worst state among the agents visible in the pane\'s session', () => {
  const agents = { '%1': e({ state: 'working' }), '%2': e({ paneIndex: 2, state: 'blocked', cause: 'permission', visible: false }), '%3': e({ session: 'other', state: 'blocked' }) };
  expect(paneHeaderChip({ ...base, agents, sessionName: 'main' })).toMatchObject({ kind: 'agent', text: 'working', cls: 'chip-agent-working', sprite: true });
});
it('no visible agent with a state means no agent chip', () => {});
it('a window row carries the worst of its panes and a session row the worst of the session', () => {
  // rows: s:main -> agent 'blocked'; w:main:@0 -> 'blocked' (agentCause 'permission'); w:main:@1 -> 'working'; a window with no agent -> no agent field
});
```

Pane-state and connection precedence tests stay as they are.

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement** with `worstOf`, `sessionAgents`, `windowAgents`. **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** `feat(ui): header chip shows what is on screen; window rows show their agents`

### Task 14: Dashboard board

**Files:**
- Modify: `src/web/dashboard.ts` (`makeBoardCard`, `paintBoard`, the fleet row chip, the `onOpenSession` hook), `src/web/main.ts` (hook wiring)
- Test: `test/agentState.test.js` (cards, done in Task 11), `test/dashboard.test.js` (only if a pure helper changes)

**Interfaces:**
- Produces: dashboard hook `onOpenAgent(boxId: string, pane: string)`, wired to `jumpToAgent`. Card DOM: `button.dash-card[data-box-id][data-pane]`, cache key `` `${boxId}\0${pane}` ``; `.dash-card-session` shows the row `name`.

- [ ] **Step 1:** No new unit test (the board has none today; e2e in Task 17 pins it). Write the e2e assertions now in Task 17's list.
- [ ] **Step 2: Implement.** The fleet row chip uses `worstOf(Object.values(latestAgents(series[box.id])))`.
- [ ] **Step 3:** `npm run typecheck` shows no error in `dashboard.ts`.
- [ ] **Step 4: Commit** `feat(dashboard): one board card per agent pane`

### Task 15: Agent switcher

**Files:**
- Modify: `src/web/agentSwitcherList.ts` (`rowKey`, `SwitcherRow`, `switcherRows`, `liveRows`), `src/web/agentSwitcherPreview.ts` (`PreviewTarget`), `src/web/agentSwitcher.ts`, `src/web/main.ts` (`commitSwitcherRow`, `noteFocusedSession`, switcher wiring), `src/web/agentState.ts` (delete `worstAgent`)
- Test: `test/agentSwitcherList.test.js`, `test/agentSwitcherPreview.test.js`, `test/agentSwitcherCommit.test.js`

**Interfaces:**
- Produces: `rowKey(boxId, pane)`; `SwitcherRow { key, boxId, label, pane, session, windowId, name, state, cause?, agent?, ts, here, gone }`; `PreviewTarget { boxId, pane }`; `switcherRows({ boxes, series, mru, focused: { boxId, session } })` where `here` is the entry with that box, that session and `focused: true`.

- [ ] **Step 1: Write the failing tests:** one row per stateful agent pane (two panes of one session give two rows with names `2:frontend.1`, `2:frontend.2`); the Host Shell keeps only entries whose session is `local`; `here` marks only the focused pane of the focused session; MRU order by the new key, and an old-style key (`'b1\nmain'`) in the stored MRU is ignored; `liveRows` marks a row `gone` when its pane id left the map; the preview cache and fetch key on box and pane.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `planCommit` is unchanged (it still plans by session); `commitSwitcherRow` runs the plan, then the same select-and-refresh `jumpToAgent` performs. The MRU is bumped with the key of the focused session's `focused` agent pane, when there is one. Previews call `api.panePreview(boxId, pane)` / `api.localPanePreview(pane)`.
- [ ] **Step 4:** `npx vitest run test/agentSwitcher*.test.js` PASS and `npm run typecheck` clean for the whole client.
- [ ] **Step 5: Commit** `feat(switcher): rows, previews and the MRU are per agent pane`

### Task 16: Event text and notification tags

**Files:**
- Modify: `src/web/healthEvents.ts` (`formatEvent`), `src/web/main.ts` (the `Notification` tag in `pollEventsOnce`)
- Test: `test/healthEvents.test.js`

- [ ] **Step 1: Write the failing test**

```js
expect(formatEvent({ kind: 'agent-blocked', label: 'web01', session: 'main', window: '2:frontend', paneIndex: 1, cause: 'permission', agent: 'claude' }).text)
  .toBe('web01 · main › 2:frontend.1 — Claude needs you: permission');
expect(formatEvent({ kind: 'agent-input', label: 'web01', session: 'main', agent: 'codex' }).text).toBe('web01 · main — Codex finished a turn');
expect(notificationTag({ kind: 'agent-blocked', boxId: 'b1', pane: '%12' })).toBe('agent-blocked:b1:%12');
expect(notificationTag({ kind: 'down', boxId: 'b1' })).toBe('down:b1');
```

- [ ] **Step 2-4:** FAIL, implement (`eventPlace`; export `notificationTag` from `healthEvents.ts`), PASS.
- [ ] **Step 5: Commit** `feat(ui): events and notifications name the pane`

### Task 17: Browser end to end

**Files:**
- Modify: `test/e2e/agentStates.spec.ts`, `test/e2e/agentSwitcher.spec.ts`, `test/e2e/liveAgentState.spec.ts`, `test/e2e/phone.spec.ts` (and any spec asserting `.badge-agent-*` inside `.box-badges`)

**Interfaces:**
- Consumes: the DOM contract of Tasks 12 and 14; marker files in the fixture box written in the five-field form.

- [ ] **Step 1: Rewrite the specs.** On the isolated box (`test/helpers/localBox.js`), session `web` with window 1 (one pane) and window 2 (two panes), each running the fixture agent command the specs already use, with markers `web%<id>`:
  1. The sidebar shows three `.box-agent` rows named `1:<name>`, `2:<name>.1`, `2:<name>.2`, in that order, and no agent badge in `.box-badges`.
  2. The strip counts three; a segment filter keeps the box.
  3. With window 1 in front and the pane docked: a `done` marker in window 1 is acknowledged once (`POST agent-seen` body `{ pane, ts }`) and turns `idle`; a `done` marker in window 2 is **never** acknowledged and stays `done`.
  4. Clicking the `2:<name>.2` row posts `/window` with that `session`, `windowId` and `paneId`, the terminal shows window 2, and its `done` is then acknowledged.
  5. The pane header chip shows only the visible window's worst state; the picker's window rows carry chips.
  6. The board has one `.dash-card[data-pane]` per agent; a card click docks and selects.
  7. The switcher lists three rows; committing one jumps to its pane; the preview shows that pane's screen.
  8. `/live`: a marker change in a background window updates its row without a full poll.
  9. Phone: the drawer shows the rows; a tap jumps and closes the drawer.
- [ ] **Step 2:** `npm run build` (in the worktree) then `npm run test:e2e`, expect every rewritten spec to PASS. `test/e2e/phone.spec.ts:213` (touch drag) is a known failure on main; do not chase it.
- [ ] **Step 3: Commit** `test(e2e): agent state per pane`

### Task 18: MCP server

**Files:**
- Modify: `src/mcp/shape.js` (`agentOf`, `agentsSeg`, `paneText`), `src/mcp/tools.js` (`wait_for_agent` schema and loop, tool descriptions)
- Test: `test/mcpShape.test.js`, `test/mcpTools.test.js`, `test/agentNaming.test.js`

**Interfaces:**
- Produces: `agentNames(agents) -> [{ pane, name, state?, cause? }]` in `shape.js` (same naming rule; `src/mcp` must not import `src/web`); `agentOf(sample, { session, pane }) -> string` (`'gone'` when there is no such entry or it has no state).

- [ ] **Step 1: Write the failing tests**
  - `test/agentNaming.test.js`: `agentNames` yields the same names as `agentRows` for every case in `NAMING_CASES`.
  - `agentsSeg` prints `2:frontend.1=blocked(permission) 2:frontend.2=working`.
  - `agentOf(sample, { session: 'main' })` is the state of the entry with `session: 'main'` and `focused: true`; `agentOf(sample, { session: 'main', pane: '%2' })` is that pane's; an unknown pane, a pane of another session, or no focused agent -> `'gone'`.
  - `wait_for_agent` accepts `pane` (pattern `^%\d{1,9}$`), refuses `12`, and its result lines include `pane: %2` when given.
  - `paneText` prints the snapshot's `pane` when present.
- [ ] **Step 2-4:** FAIL, implement, `npx vitest run test/mcp*.test.js test/agentNaming.test.js` PASS. `test/mcpApiClient.test.js` (the `ROUTES` table) must pass unchanged.
- [ ] **Step 5: Commit** `feat(mcp): agents listed and awaited per pane`

### Task 19: Guides and the codebase map

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/fleet-and-health.md`, `docs/terminal.md`, `docs/dashboard.md`, `docs/mcp.md`, `docs/agent-messaging.md`, `docs/boxes-and-setup.md`

- [ ] **Step 1:** Rewrite every passage that describes agent state per session (the spec's section 1 lists what changed; `grep -n "per session\|per tmux session\|agentMarks\|parseAgentMarks\|session's marker" CLAUDE.md docs/*.md README.md` finds them). In `CLAUDE.md`: the `status.js`, `healthHistory.js`, `agentSeenStore.js`, `statusPoller.js`, `agentWatch.js`, `agentMailHub.js`, `agentWorkerRules.js`, `localAgent.js`, route and web-client entries; the load-bearing rules "Seen is a client claim" (per pane, only what is visible), "Agent mail is never typed into a terminal" (only while **that pane's** marker reads `ready`), "tmux targets are exact" (add the pane target form `-t '=<session>:<@id>.<%N>'`); the `data/agent-seen.json` table row; the security note about the pane route (`pane`, not `session`, is refused for device tokens). State the OpenCode same-directory limit and the grouped-session limit in `docs/fleet-and-health.md`. Keep `AGENTS.md` in sync with `CLAUDE.md`.
- [ ] **Step 2:** `npx vitest run test/styleTokens.test.js test/themes.test.js` and `npm test` PASS (some tests pin doc text; fix what they name).
- [ ] **Step 3: Commit** `docs: agent state is per pane`

### Task 20: Live walk (operator-gated)

Not for an unattended agent. It needs the operator's go-ahead, the test box, and a restart of the live service (only while no setup, provision, lifecycle, fleet, voice-install or apk-build job is `running`).

- [ ] **Step 1:** After plans 2 and 3 are also complete: `npm test`, `npm run build` in the worktree, then deploy the candidate as `CLAUDE.md` "Shipping" describes (`rsync -a --delete dist/` plus changed server files, restart, fetch one hashed asset and check its content type).
- [ ] **Step 2:** Walk the spec's section 10 list on the test box and record the result in a new dated `docs/superpowers/specs/2026-11-2x-pane-agent-state-live-walk.md`: Claude in split panes and in a background window; Codex, pi and agy before and after a setup rerun; two OpenCode panes in different directories and in the same one; mail to a session with one working and one idle agent; a jump from the sidebar, the board, the switcher and a push; acknowledging by looking, and not acknowledging a background window.
- [ ] **Step 3:** Fix what fails on the branch and redeploy. Merge, version bump, tag and release only on the operator's word, by the "Shipping" checklist.
