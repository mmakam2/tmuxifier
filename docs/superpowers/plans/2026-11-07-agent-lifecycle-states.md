# Agent Lifecycle States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code sessions on every box show `working` / `blocked` / `done` / `idle` (with a cause for `blocked`), `done` clears to `idle` once a person has looked, and the states roll up into the sidebar, session picker, pane chips, a dashboard board, notifications, push and the MCP tools.

**Architecture:** The on-box hook writes a four-field marker (`session:state:epoch:cause`) that the existing probe already ships; the server derives the four displayed states per session (a shared seen watermark in `data/agent-seen.json` decides `done` vs `idle`), emits per-session edge events, and the web client folds the per-session map into badges, chips, a strip and a board. Claude Code only; nothing is inferred from pane text.

**Tech Stack:** Node 22 ESM server (Fastify), POSIX `sh` hook, TypeScript + Vite web client, vitest (node env, no DOM), Playwright e2e against `test/helpers/localBox.js`.

**Spec:** `docs/superpowers/specs/2026-11-07-agent-lifecycle-states-design.md`

## Global Constraints

- Hook-only: no state is ever inferred from pane text; a Claude with no marker carries no state (spec Anti-goals).
- Marker allowlists are closed: states `working | blocked | ready`, causes `prompt | resume | stop | start | permission | question | elicitation | unblock` (spec §1). Anything else drops.
- Displayed states are exactly `working | blocked | done | idle`; precedence for any rollup is `blocked > done > working > idle` (spec §6).
- Only a client acknowledgement marks a turn seen; tmux `attached` suppresses notifications and never marks seen (spec §4).
- Timers (`idle_prompt`, `agent_completed`) never mint a new marker `ts` (spec §2).
- A session's first appearance emits no event; a failed probe never replaces the previous agents map (spec §5).
- Sessions whose names fail `SESSION_NAME_RE` (`/^[A-Za-z0-9_-]{1,64}$/`) are excluded from tracking (spec §3).
- Three-field markers from the current hook keep working: `working` → `working/prompt`, `waiting` → `ready/stop` (spec §1).
- The web client is `.ts`, vitest has no DOM: pure halves are unit-tested, DOM halves by Playwright (CLAUDE.md).
- Public repo: no real hostnames, IPs or emails in fixtures or docs; recorded hook payloads are scrubbed (CLAUDE.md Shipping).
- Android is out of scope (issue #5); Codex, Antigravity and OpenCode are issues #3, #4, #6.
- Conventional-commit messages; `npm run typecheck` is the safe check in the main checkout, builds happen in the worktree (CLAUDE.md).

## Review Focus

1. **A granted permission whose first tool call is `Read`/`Edit`.** The unmatched `PostToolUse` hook must still clear `blocked`; a matcher-only implementation would leave the badge red for the whole turn. Pinned in Task 3's unit test and Task 4's replay.
2. **The operator denies a permission with a typed message.** `UserPromptSubmit` must take the session from `blocked` to `working`; a denial without a message leaves it `blocked` until the next tool call or `Stop`, which is accepted. Pinned in Task 3.
3. **A session that is `done` on the configured session while a second pane shows `web-2` as `blocked`.** The box badge must read `blocked ×2` with both sessions in its title, and each pane chip must describe its own session. Pinned in Tasks 9 and 10.
4. **A client acknowledging a `ts` the server has never seen** (a replayed or forged request). The route must refuse it, or a future turn could be pre-acknowledged. Pinned in Task 8.
5. **A marker gap during a Claude restart** (SessionEnd deleted it, SessionStart not yet written) must not read as `agent-done`, per session. Pinned in Task 7b.

---

### Task 1: Record a real Claude Code hook trace

The repo has no recorded `Notification`, `PermissionRequest`, `PostToolUse` or `SessionStart` payloads. Every later hook task is tested against this recording, so it comes first. This task also commits the approved spec, which is still untracked.

**Files:**
- Create: `test/fixtures/claude-hook-trace.jsonl`
- Create: `test/fixtures/README-claude-hook-trace.md`
- Commit: `docs/superpowers/specs/2026-11-07-agent-lifecycle-states-design.md`

**Interfaces:**
- Produces: one JSON object per line, each the exact stdin payload Claude Code handed a hook, with the hook's event name available as `hook_event_name` inside the payload. Scrubbed fields: `session_id` → `"sess"`, `transcript_path` → `"/scrubbed"`, `cwd` → `"/tmp/rec"`, `prompt_id` → `"p"`, `tool_use_id` → `"t"`, `scratchpad_dir` → `"/scrubbed"`.

- [ ] **Step 1: Set up the recorder project on this host**

Create `/tmp/rec/.claude/settings.json` registering one unmatched command hook on every event in this list: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`. The command is `sh /tmp/rec/record.sh`, and `record.sh` is:

```sh
#!/bin/sh
IN=$(cat)
printf '%s\n' "$IN" >> /tmp/rec/trace.jsonl
exit 0
```

Project-level settings merge with the user's, so the host's logged-in Claude is used unchanged. Start it detached: `tmux new-session -d -s rec -c /tmp/rec claude`.

- [ ] **Step 2: Drive the scenarios through tmux**

Drive with `tmux send-keys -t '=rec' '<text>' Enter`, reading the screen with `tmux capture-pane -p -t '=rec'` between steps. Walk, in order, pausing until each prompt is visible: (a) a prompt that needs a Bash permission ("run `date` with Bash and tell me the output"), **grant** it; (b) the same, **deny** it by selecting No with no message; (c) the same, deny by typing a message ("don't, just answer"); (d) "ask me a yes/no question with the AskUserQuestion tool", answer it; (e) "start a background subagent that lists the files here, then tell me when it is done"; (f) `/compact`; (g) one plain turn ("say ok"); (h) `/exit`.

- [ ] **Step 3: Scrub and save the fixture**

Run a short Node one-liner over `/tmp/rec/trace.jsonl` replacing the fields listed in Interfaces, write to `test/fixtures/claude-hook-trace.jsonl`. Write `test/fixtures/README-claude-hook-trace.md` listing the scenario letters above with the line ranges they produced and the Claude Code version (`claude --version`).

- [ ] **Step 4: Verify the scrub**

Run: `grep -nE 'babendums|192\.168|/root/|@' test/fixtures/claude-hook-trace.jsonl`
Expected: no output.

Run: `node -e "require('fs').readFileSync('test/fixtures/claude-hook-trace.jsonl','utf8').trim().split('\n').forEach(l=>JSON.parse(l))"`
Expected: no error.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-11-07-agent-lifecycle-states-design.md test/fixtures/claude-hook-trace.jsonl test/fixtures/README-claude-hook-trace.md
git commit -m "test(agent-hooks): record a real Claude Code hook trace; add lifecycle-states spec"
```

---

### Task 2: Hook registration table with multiple entries per event

**Files:**
- Modify: `src/server/claudeAgentHooks.js:27-45`
- Test: `test/claudeAgentHooks.test.js:308-347`

**Interfaces:**
- Produces: `HOOK_EVENTS` (exported) as `[event, arg, matcher?][]` with these rows, in this order:
  `['SessionStart','start','startup|resume|clear|fork']`, `['UserPromptSubmit','prompt']`, `['Stop','stop']`, `['PermissionRequest','permission']`, `['Notification','notify']`, `['SessionEnd','end']`, `['SubagentStart','subagent-start']`, `['SubagentStop','subagent-stop']`, `['PreToolUse','pretool','Bash']`, `['PreToolUse','ask','AskUserQuestion']`, `['PostToolUse','unblock','AskUserQuestion']`, `['PostToolUse','unblock']`, `['PostToolUseFailure','unblock']`.
- Produces: `hookArgsFor(payload: object): string[]` (exported, pure): the hook args Claude Code would invoke for one recorded payload. Matching: `PreToolUse`/`PostToolUse`/`PostToolUseFailure` match `matcher` as a regex against `payload.tool_name`; `SessionStart` matches against `payload.source`; an entry with no matcher always matches; unknown events return `[]`. Order follows `HOOK_EVENTS`.
- `HOOKS_JSON` groups rows by event so `settings.hooks.PreToolUse` is an array of two entries.

- [ ] **Step 1: Write the failing tests**

Replace the single-matcher assertions at `test/claudeAgentHooks.test.js:308-347` and add:

```js
test('builder wires every lifecycle event, with matchers only where a hook would otherwise fork per tool call', () => {
  const s = buildAgentHooksInstallScript();
  const json = JSON.parse(s.match(/TMUXIFIER_HOOKS_EOF\n([\s\S]*?)\nTMUXIFIER_HOOKS_EOF/)[1]);
  expect(Object.keys(json).sort()).toEqual(['Notification', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
  expect(json.PreToolUse.map((e) => e.matcher)).toEqual(['Bash', 'AskUserQuestion']);
  expect(json.PostToolUse.map((e) => e.matcher)).toEqual(['AskUserQuestion', undefined]);
  expect(json.SessionStart[0].matcher).toBe('startup|resume|clear|fork');
  expect(json.Stop[0]).not.toHaveProperty('matcher');
  expect(json.PermissionRequest[0].hooks[0].command).toMatch(/tmuxifier-agent-hook\.sh" permission$/);
});

test('hookArgsFor dispatches a payload the way Claude Code would', () => {
  expect(hookArgsFor({ hook_event_name: 'PreToolUse', tool_name: 'Read' })).toEqual([]);
  expect(hookArgsFor({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toEqual(['pretool']);
  expect(hookArgsFor({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' })).toEqual(['ask']);
  expect(hookArgsFor({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' })).toEqual(['unblock', 'unblock']);
  expect(hookArgsFor({ hook_event_name: 'PostToolUse', tool_name: 'Edit' })).toEqual(['unblock']);
  expect(hookArgsFor({ hook_event_name: 'SessionStart', source: 'compact' })).toEqual([]);
  expect(hookArgsFor({ hook_event_name: 'SessionStart', source: 'startup' })).toEqual(['start']);
  expect(hookArgsFor({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })).toEqual(['notify']);
  expect(hookArgsFor({ hook_event_name: 'Elicitation' })).toEqual([]);
});
```

Also update the installer test at line 328-347 so `settings.hooks.PreToolUse[0].matcher` is `'Bash'` and `settings.hooks.PreToolUse[1].matcher` is `'AskUserQuestion'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/claudeAgentHooks.test.js -t "builder wires|hookArgsFor"`
Expected: FAIL (`hookArgsFor` is not exported; matcher arrays differ).

- [ ] **Step 3: Implement**

In `claudeAgentHooks.js`: export `HOOK_EVENTS` with the rows above; build `HOOKS_JSON` by grouping rows per event (`Map<event, entry[]>`); export `hookArgsFor(payload)`. Update the header comment's rationale for the two new unmatched events (spec §2, `PostToolUse` short-circuit).

- [ ] **Step 4: Run the whole file**

Run: `npx vitest run test/claudeAgentHooks.test.js`
Expected: the two new tests PASS; hook-script tests that assert `waiting` still fail (they are rewritten in Task 3) — confirm only those fail.

- [ ] **Step 5: Commit**

```bash
git add src/server/claudeAgentHooks.js test/claudeAgentHooks.test.js
git commit -m "feat(agent-hooks): register PermissionRequest, AskUserQuestion and PostToolUse hooks"
```

---

### Task 3: Hook script state machine

**Files:**
- Modify: `src/server/assets/tmuxifier-agent-hook.sh`
- Test: `test/claudeAgentHooks.test.js:34-300`

**Interfaces:**
- Produces: marker line `<session>:<state>:<epoch>:<cause>\n` with the allowlists from Global Constraints. Dispatch per spec §2 table. The `unblock` branch runs **before** `IN=$(cat)`: it resolves the session via `tmux display-message -p '#S'`, reads the marker, and exits 0 unless the marker's state field is `blocked`; only then does it drain stdin and write `working/unblock`.
- `notify` with `idle_prompt` / `agent_completed`: after the existing busy gate, exit 0 without writing when the current marker's state is already `ready`.
- `start` writes `ready/start`; `stop` writes `ready/stop` (or `working/prompt` when busy, as today); `prompt` writes `working/prompt`, or `working/resume` when stdin contains `<task-notification>`; `permission` writes `blocked/permission`; `ask` writes `blocked/question`; `notify` maps `permission_prompt` → `blocked/permission`, `elicitation_dialog` / `elicitation_url_dialog` → `blocked/elicitation`, `agent_needs_input` → `blocked/question`, `idle_prompt` / `agent_completed` → `ready/stop`, anything else → exit 0 unwritten.

- [ ] **Step 1: Rewrite the state tests**

In `test/claudeAgentHooks.test.js`, change every `/^web:waiting:\d+\n$/` and `/^web:working:\d+\n$/` expectation to the four-field form (`/^web:working:\d+:prompt\n$/`, `/^web:ready:\d+:stop\n$/`, etc.), and add:

```js
test('start is idle-not-done: ready/start', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('start', env, '{"hook_event_name":"SessionStart","source":"startup"}');
  expect(await marker(dir)).toMatch(/^web:ready:\d+:start\n$/);
});

test('permission and ask write blocked with their cause; the notify backstop agrees', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('permission', env, '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}');
  expect(await marker(dir)).toMatch(/^web:blocked:\d+:permission\n$/);
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"permission_prompt"}');
  expect(await marker(dir)).toMatch(/^web:blocked:\d+:permission\n$/);
  await runHook('ask', env, '{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}');
  expect(await marker(dir)).toMatch(/^web:blocked:\d+:question\n$/);
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"elicitation_dialog"}');
  expect(await marker(dir)).toMatch(/^web:blocked:\d+:elicitation\n$/);
});

test('unblock clears only a blocked marker, and leaves every other state alone', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('prompt', env);
  const before = await marker(dir);
  await runHook('unblock', env, '{"hook_event_name":"PostToolUse","tool_name":"Read"}');
  expect(await marker(dir)).toBe(before);                      // working stays, same ts
  await runHook('permission', env);
  await runHook('unblock', env, '{"hook_event_name":"PostToolUse","tool_name":"Read"}');
  expect(await marker(dir)).toMatch(/^web:working:\d+:unblock\n$/);
});

test('unblock with no marker at all writes nothing', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('unblock', env);
  await expect(marker(dir)).rejects.toBeTruthy();
});

test('a typed denial takes blocked to working through prompt', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('permission', env);
  await runHook('prompt', env, '{"hook_event_name":"UserPromptSubmit","prompt":"no, stop"}');
  expect(await marker(dir)).toMatch(/^web:working:\d+:prompt\n$/);
});

test('timers never mint a new ts: idle_prompt over a ready marker is a no-op', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('stop', env);
  const before = await marker(dir);
  await new Promise((r) => setTimeout(r, 1100));
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"idle_prompt"}');
  expect(await marker(dir)).toBe(before);
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"agent_completed"}');
  expect(await marker(dir)).toBe(before);
});

test('idle_prompt still lands over a working marker once nothing is busy', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('prompt', env);
  await runHook('notify', env, '{"hook_event_name":"Notification","notification_type":"idle_prompt"}');
  expect(await marker(dir)).toMatch(/^web:ready:\d+:stop\n$/);
});

test('auth and quota notifications write nothing', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('prompt', env);
  const before = await marker(dir);
  for (const nt of ['auth_success', 'quota_auto_resume_fired', 'plugin_notification']) {
    await runHook('notify', env, `{"hook_event_name":"Notification","notification_type":"${nt}"}`);
    expect(await marker(dir)).toBe(before);
  }
});

test('resume writes working/resume', async () => {
  const { dir, env } = await hookEnv('web');
  await runHook('prompt', env, '{"hook_event_name":"UserPromptSubmit","prompt":"<task-notification>done</task-notification>"}');
  expect(await marker(dir)).toMatch(/^web:working:\d+:resume\n$/);
});
```

Keep every existing busy-gate test; only its expected marker text changes.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/claudeAgentHooks.test.js`
Expected: the new tests FAIL on the three-field marker.

- [ ] **Step 3: Implement the script**

Restructure the top of `tmuxifier-agent-hook.sh`: resolve `$TMUX`, `SESSION`, `FILE` first; then an `unblock` early branch (`case "${1:-}" in unblock) ... esac`) that reads `$FILE` with `IFS=: read -r _ CUR _ _ < "$FILE"`, exits 0 unless `$CUR = blocked`, else drains stdin and falls through to write `working/unblock`; then `IN=$(cat ...)` and the existing dispatch. Add a `cur_state()` helper for the `ready` no-op rule in `notify`. Write `printf '%s:%s:%s:%s\n' "$SESSION" "$STATE" "$(date +%s)" "$CAUSE"`. Update the header comment to describe the new vocabulary and the `unblock` cost (two forks).

- [ ] **Step 4: Run the file**

Run: `npx vitest run test/claudeAgentHooks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/assets/tmuxifier-agent-hook.sh test/claudeAgentHooks.test.js
git commit -m "feat(agent-hooks): four-field marker with blocked/ready states and causes"
```

---

### Task 4: Replay the recorded trace through the real script

**Files:**
- Test: `test/agentHooksReplay.test.js` (new)
- Modify: `test/agentHooks.integration.test.js:35-38`

**Interfaces:**
- Consumes: `hookArgsFor` (Task 2), the fixture (Task 1), the script (Task 3).

- [ ] **Step 1: Write the replay test**

```js
import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookArgsFor } from '../src/server/claudeAgentHooks.js';

const HOOK = fileURLToPath(new URL('../src/server/assets/tmuxifier-agent-hook.sh', import.meta.url));
const TRACE = fileURLToPath(new URL('./fixtures/claude-hook-trace.jsonl', import.meta.url));

async function env() { /* same fake-tmux harness as claudeAgentHooks.test.js, session 'rec' */ }
function run(arg, e, stdin) { /* execFile /bin/sh HOOK arg, write stdin */ }

test('the recorded trace drives the marker through blocked → working → ready with no stale blocked', async () => {
  const { dir, e } = await env();
  const lines = (await fs.readFile(TRACE, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const states = [];
  for (const payload of lines) {
    for (const arg of hookArgsFor(payload)) await run(arg, e, JSON.stringify(payload));
    const m = await fs.readFile(path.join(dir, '.tmuxifier-agent', 'rec'), 'utf8').catch(() => '');
    states.push({ event: payload.hook_event_name, type: payload.notification_type ?? payload.tool_name ?? payload.source ?? '', marker: m.trim().split(':').slice(1).filter((_, i) => i !== 1).join('/') });
  }
  // Scenario (a): the PermissionRequest line is followed by blocked/permission,
  // and the first PostToolUse after it by working/unblock.
  const perm = states.findIndex((s) => s.event === 'PermissionRequest');
  expect(perm).toBeGreaterThan(-1);
  expect(states[perm].marker).toBe('blocked/permission');
  const after = states.slice(perm + 1).find((s) => s.event === 'PostToolUse');
  expect(after.marker).toBe('working/unblock');
  // Scenario (d): AskUserQuestion blocks with cause question and unblocks on its PostToolUse.
  const ask = states.findIndex((s) => s.event === 'PreToolUse' && s.type === 'AskUserQuestion');
  expect(states[ask].marker).toBe('blocked/question');
  // Scenario (f): compaction never writes ready/start.
  const compact = states.find((s) => s.event === 'SessionStart' && s.type === 'compact');
  if (compact) expect(compact.marker).not.toBe('ready/start');
  // Final state after /exit: marker deleted.
  expect(states.at(-1).marker).toBe('');
  // At no point does a Stop leave the marker blocked.
  for (const s of states) if (s.event === 'Stop') expect(s.marker.startsWith('blocked')).toBe(false);
});
```

Fill the two helpers from `test/claudeAgentHooks.test.js`. Add further assertions for scenarios (b), (c), (e), (g) from the fixture README's line ranges.

- [ ] **Step 2: Run it**

Run: `npx vitest run test/agentHooksReplay.test.js`
Expected: PASS. If an assertion fails because the recording shows an event order the spec table did not anticipate, fix the hook (Task 3) or the table (Task 2), not the test, and note the finding in the fixture README.

- [ ] **Step 3: Update the integration test**

In `test/agentHooks.integration.test.js`, the marker regex becomes `/^agenthooks:ready:\d+:stop\n$/` and the parsed expectation `{ state: 'ready', cause: 'stop' }` (the parser change lands in Task 5; this test goes red until then, which is expected).

- [ ] **Step 4: Commit**

```bash
git add test/agentHooksReplay.test.js test/agentHooks.integration.test.js
git commit -m "test(agent-hooks): replay the recorded Claude Code trace through the real hook"
```

---

### Task 5: Parse four-field markers

**Files:**
- Modify: `src/server/status.js:117-134`
- Test: `test/status.test.js:658-672`, `test/agentHooks.integration.test.js`, `test/localAgent.test.js`

**Interfaces:**
- Produces: `export const AGENT_MARK_STATES = ['working', 'blocked', 'ready']`, `export const AGENT_MARK_CAUSES = ['prompt', 'resume', 'stop', 'start', 'permission', 'question', 'elicitation', 'unblock']`.
- `parseAgentMarks(stdout) → { [session]: { state, cause, ts } } | null`. Three-field legacy: `working` → `{ state: 'working', cause: 'prompt' }`, `waiting` → `{ state: 'ready', cause: 'stop' }`. Four fields: both must be in the allowlists. Five or more fields, or two fields, drop.

- [ ] **Step 1: Write the failing tests**

```js
test('parseAgentMarks reads four-field markers and maps three-field legacy ones', () => {
  const out = '__AGENT__ web:blocked:1718000000:permission\n__AGENT__ dev:ready:1718000001:start\n__AGENT__ old:waiting:1718000002\n__AGENT__ old2:working:1718000003\n';
  expect(parseAgentMarks(out)).toEqual({
    web: { state: 'blocked', cause: 'permission', ts: 1718000000 },
    dev: { state: 'ready', cause: 'start', ts: 1718000001 },
    old: { state: 'ready', cause: 'stop', ts: 1718000002 },
    old2: { state: 'working', cause: 'prompt', ts: 1718000003 },
  });
});

test('parseAgentMarks drops unknown states and causes, and over-long lines', () => {
  expect(parseAgentMarks('__AGENT__ web:waiting:1718000000:stop\n')).toBeNull();   // legacy word with a cause
  expect(parseAgentMarks('__AGENT__ web:blocked:1718000000:sleepy\n')).toBeNull();
  expect(parseAgentMarks('__AGENT__ web:blocked:1718000000:permission:extra\n')).toBeNull();
  expect(parseAgentMarks('__AGENT__ web:done:1718000000:stop\n')).toBeNull();      // displayed states are not marker states
});
```

Update the existing test at `test/status.test.js:658` to expect `cause` fields.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/status.test.js -t parseAgentMarks`
Expected: FAIL.

- [ ] **Step 3: Implement** in `status.js` per Interfaces; refresh the comment above the function.

- [ ] **Step 4: Run the affected suites**

Run: `npx vitest run test/status.test.js test/localAgent.test.js test/agentHooks.integration.test.js`
Expected: PASS (the integration test needs `sshd`; it fails loudly if absent, never skips).

- [ ] **Step 5: Commit**

```bash
git add src/server/status.js test/status.test.js test/localAgent.test.js
git commit -m "feat(status): parse four-field agent markers with cause, keep legacy two-state markers"
```

---

### Task 6: Seen-watermark store

**Files:**
- Modify: `src/server/debouncedJsonStore.js`
- Create: `src/server/agentSeenStore.js`
- Test: `test/agentSeenStore.test.js` (new), `test/fleetStore.test.js`

**Interfaces:**
- `createDebouncedJsonStore({ dataDir, filename, fallback = [], validate = Array.isArray })`: the two new options flow to `readJsonSync`. Existing callers unchanged.
- `createAgentSeenStore({ dataDir })` → `{ load(): Record<string, Record<string, number>>, save(map), whenIdle() }` over `data/agent-seen.json`, `fallback: {}`, `validate: (v) => v && typeof v === 'object' && !Array.isArray(v)`.

- [ ] **Step 1: Write the failing test**

```js
import { test, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentSeenStore } from '../src/server/agentSeenStore.js';

test('agent-seen store round-trips an object map, starts empty, and is written 0o600', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seen-'));
  const s = createAgentSeenStore({ dataDir });
  expect(s.load()).toEqual({});
  s.save({ b1: { web: 1718000000 } });
  await s.whenIdle();
  expect(createAgentSeenStore({ dataDir }).load()).toEqual({ b1: { web: 1718000000 } });
  expect((await fs.stat(path.join(dataDir, 'agent-seen.json'))).mode & 0o777).toBe(0o600);
});

test('a non-object file is quarantined and reads as empty', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seen-'));
  await fs.writeFile(path.join(dataDir, 'agent-seen.json'), '[1,2]');
  expect(createAgentSeenStore({ dataDir }).load()).toEqual({});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/agentSeenStore.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** both files. Header comment on `agentSeenStore.js`: what the map means (marker `ts` of the newest `ready/stop` acknowledged, per box per session) and why it is a separate file from `health-events.json` (different write cadence, different shape).

- [ ] **Step 4: Run**

Run: `npx vitest run test/agentSeenStore.test.js test/fleetStore.test.js test/jsonFile.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/debouncedJsonStore.js src/server/agentSeenStore.js test/agentSeenStore.test.js
git commit -m "feat(store): debounced agent-seen watermark store"
```

---

### Task 7a: Per-session agents in the sample, with derived states

**Files:**
- Modify: `src/server/healthHistory.js:11-63` (`sampleOf`)
- Test: `test/healthHistory.test.js:185-220, 350-376`

**Interfaces:**
- Produces: `export const AGENT_STATES = ['working', 'blocked', 'done', 'idle']`.
- `export function deriveAgentState(mark, seenTs)`: `mark` is `{ state, cause, ts }` from `parseAgentMarks`; returns `'working'` for state `working`, `'blocked'` for `blocked`, `'idle'` for `ready/start`, `'idle'` for `ready/*` when `seenTs != null && mark.ts <= seenTs`, else `'done'`.
- `sampleOf(status, at, { sessionName, seenOf } = {})`: `seenOf(session) → number | undefined`. When `Array.isArray(status.sessions)`, `sample.agents` is set (possibly `{}`), keyed by session name, one entry per listed session whose `paneCmd` matches `/^claude(-|$)/` **and** whose name passes `SESSION_NAME_RE`: `{ present: true, attached: boolean, state?, cause?, ts? }` (the last three only when a marker exists). `sample.agent` is `agents[sessionName]?.state` (legacy field, four-state now); `agentPresent` / `agentAttached` keep their current meaning.
- Import `SESSION_NAME_RE` from `./sshCommand.js`.

- [ ] **Step 1: Write the failing tests**

```js
test('deriveAgentState: start is idle, stop is done until seen, blocked and working pass through', () => {
  expect(deriveAgentState({ state: 'working', cause: 'prompt', ts: 10 })).toBe('working');
  expect(deriveAgentState({ state: 'blocked', cause: 'permission', ts: 10 })).toBe('blocked');
  expect(deriveAgentState({ state: 'ready', cause: 'start', ts: 10 })).toBe('idle');
  expect(deriveAgentState({ state: 'ready', cause: 'stop', ts: 10 })).toBe('done');
  expect(deriveAgentState({ state: 'ready', cause: 'stop', ts: 10 }, 9)).toBe('done');
  expect(deriveAgentState({ state: 'ready', cause: 'stop', ts: 10 }, 10)).toBe('idle');
});

test('sampleOf builds a per-session agents map and keeps the legacy agent field for the configured session', () => {
  const status = { reachable: true, tmux: true,
    sessions: [
      { name: 'web', windows: 1, attached: false, paneCmd: 'claude' },
      { name: 'web-2', windows: 1, attached: true, paneCmd: 'claude' },
      { name: 'build', windows: 1, attached: false, paneCmd: 'zsh' },
      { name: 'bad name', windows: 1, attached: false, paneCmd: 'claude' },
      { name: 'nomark', windows: 1, attached: false, paneCmd: 'claude' },
    ],
    agentMarks: { web: { state: 'ready', cause: 'stop', ts: 50 }, 'web-2': { state: 'blocked', cause: 'permission', ts: 60 }, 'bad name': { state: 'working', cause: 'prompt', ts: 1 }, stale: { state: 'working', cause: 'prompt', ts: 1 } } };
  const s = sampleOf(status, 1, { sessionName: 'web', seenOf: (name) => (name === 'web' ? 50 : undefined) });
  expect(s.agents).toEqual({
    web: { present: true, attached: false, state: 'idle', cause: 'stop', ts: 50 },
    'web-2': { present: true, attached: true, state: 'blocked', cause: 'permission', ts: 60 },
    nomark: { present: true, attached: false },
  });
  expect(s.agent).toBe('idle');
  expect(s.agentPresent).toBe(true);
});

test('sampleOf: a failed probe carries no agents map at all; an empty session list carries an empty one', () => {
  expect('agents' in sampleOf({ reachable: false }, 1)).toBe(false);
  expect(sampleOf({ reachable: true, sessions: [] }, 1).agents).toEqual({});
});
```

Update tests at lines 185-220 and 350-376 for the four-field marks (`{ state: 'ready', cause: 'stop', ts }`) and the new `agent` values (`'done'` where `'waiting'` was expected and nothing is seen).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/healthHistory.test.js -t "deriveAgentState|agents map|failed probe"`
Expected: FAIL.

- [ ] **Step 3: Implement** in `healthHistory.js`; rewrite the `sampleOf` agent comment block to describe the per-session map and the seen derivation.

- [ ] **Step 4: Run**

Run: `npx vitest run test/healthHistory.test.js`
Expected: the `sampleOf` tests PASS; `classifyTransitions` agent tests may still fail (Task 7b).

- [ ] **Step 5: Commit**

```bash
git add src/server/healthHistory.js test/healthHistory.test.js
git commit -m "feat(health): per-session agents map with derived working/blocked/done/idle"
```

---

### Task 7b: Per-session agent edges

**Files:**
- Modify: `src/server/healthHistory.js:95-134` (`classifyTransitions`)
- Test: `test/healthHistory.test.js:221-349`

**Interfaces:**
- `classifyTransitions(prev, next, thresholds, state)` keeps its signature. `state.agents` holds the last **successful** agents map (`next.agents` when present, else the previous value). Agent edges compare `state.agents` (previous) with `next.agents` (only when `next.agents` is present):
  - `agent-blocked`: previous entry exists with `state` in `working|done|idle`, next entry `state === 'blocked'`, and `!next.agents[s].attached`. Event `{ kind: 'agent-blocked', session, cause }`.
  - `agent-input`: previous entry `state` in `working|blocked`, next `state === 'done'`, and `!next.agents[s].attached`. Event `{ kind: 'agent-input', session }`.
  - `agent-done`: previous entry had a `state`, the session is absent from `next.agents`, `next.up && !next.stopped`, and neither previous nor next entry was attached. Event `{ kind: 'agent-done', session }`. A next entry with `present: true` and no `state` (marker gap) emits nothing.
  - No previous entry → no event (first appearance).
- `initThresholdState()` gains `agents: undefined`.

- [ ] **Step 1: Write the failing tests**

```js
const A = (agents) => ({ up: true, agents });
const E = (state, extra = {}) => ({ present: true, attached: false, state, ts: 1, ...extra });

test('agent edges run per session and carry the session name', () => {
  let st = initThresholdState();
  let r = classifyTransitions(A({ web: E('working'), 'web-2': E('working') }), A({ web: E('working'), 'web-2': E('working') }), TH, st); st = r.state;
  r = classifyTransitions(A({}), A({ web: E('blocked', { cause: 'permission' }), 'web-2': E('done') }), TH, st);
  expect(r.events).toEqual([{ kind: 'agent-blocked', session: 'web', cause: 'permission' }, { kind: 'agent-input', session: 'web-2' }]);
});

test('first appearance of a session emits nothing, even when it appears blocked', () => {
  const r = classifyTransitions(A({}), A({ web: E('blocked', { cause: 'permission' }) }), TH, initThresholdState());
  expect(r.events).toEqual([]);
});

test('a failed probe does not replace the previous map, so the box coming back is not a first appearance', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ web: E('working') }), TH, st).state;
  st = classifyTransitions(A({ web: E('working') }), { up: false }, TH, st).state;   // no agents key
  const r = classifyTransitions({ up: false }, A({ web: E('done') }), TH, st);
  expect(r.events).toEqual([{ kind: 'up' }, { kind: 'agent-input', session: 'web' }]); // reachability edge first, as today
});

test('blocked → done without a working in between still fires agent-input', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ web: E('blocked') }), TH, st).state;
  expect(classifyTransitions(A({}), A({ web: E('done') }), TH, st).events).toEqual([{ kind: 'agent-input', session: 'web' }]);
});

test('attached suppresses agent-blocked and agent-input but is not a seen mark (the state stays done)', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ web: E('working') }), TH, st).state;
  expect(classifyTransitions(A({}), A({ web: E('done', { attached: true }) }), TH, st).events).toEqual([]);
});

test('a marker gap with the claude pane still present fires no agent-done; an exited claude does', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ web: E('done') }), TH, st).state;
  expect(classifyTransitions(A({}), A({ web: { present: true, attached: false } }), TH, st).events).toEqual([]);
  expect(classifyTransitions(A({}), A({}), TH, st).events).toEqual([{ kind: 'agent-done', session: 'web' }]);
});

test('a persisting blocker emits once', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ web: E('working') }), TH, st).state;
  let r = classifyTransitions(A({}), A({ web: E('blocked', { cause: 'question' }) }), TH, st); st = r.state;
  expect(r.events).toHaveLength(1);
  expect(classifyTransitions(A({}), A({ web: E('blocked', { cause: 'question' }) }), TH, st).events).toEqual([]);
});
```

Rewrite the existing agent-edge tests (lines 221-349) onto the `agents` map; keep their intent (suppression while attached, multi-viewer, stopped box no false agent-done, single-poll edge, long task fires once).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/healthHistory.test.js -t "per session|first appearance|failed probe|blocked → done|suppresses|marker gap|persisting"`
Expected: FAIL.

- [ ] **Step 3: Implement**; move the agent-edge comment block to describe the per-session rules and the "previous = last successful map" invariant.

- [ ] **Step 4: Run**

Run: `npx vitest run test/healthHistory.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/healthHistory.js test/healthHistory.test.js
git commit -m "feat(health): per-session agent-blocked/agent-input/agent-done edges"
```

---

### Task 7c: History owns the seen map

**Files:**
- Modify: `src/server/healthHistory.js:168-260` (`createHealthHistory`)
- Test: `test/healthHistory.test.js`

**Interfaces:**
- `createHealthHistory({ ..., seenStore = null })`: loads `seenStore.load()` into `seen: Map<boxId, Map<session, ts>>`.
- `record(snapshot, boxes)`: passes `seenOf: (s) => seen.get(box.id)?.get(s)` into `sampleOf`; after sampling, when `status.sessions` is an array, deletes seen entries for sessions not named in it; emitted events copy `ev.session` and `ev.cause` onto the persisted record; saves the seen store only when it changed.
- `markSeen(boxId, session, ts) → boolean`: false unless the last sample for that box has `agents[session]` with a `ts` and `ts <= agents[session].ts`; otherwise sets `max(current, ts)`, saves, returns true.
- `getSeries` unchanged. `whenIdle()` → `seenStore?.whenIdle() ?? Promise.resolve()`.

- [ ] **Step 1: Write the failing tests**

```js
function memSeenStore(init = {}) { let data = init; return { load: () => data, save: (m) => { data = m; }, whenIdle: async () => {}, get data() { return data; } }; }
const claudeStatus = (marks, sessions = ['web']) => ({ reachable: true, tmux: true, sessions: sessions.map((n) => ({ name: n, windows: 1, attached: false, paneCmd: 'claude' })), agentMarks: marks });

test('markSeen turns done into idle on the next record and persists; a ts ahead of the marker is refused', () => {
  const store = memSeenStore();
  const h = createHealthHistory({ seenStore: store, now: () => 1 });
  const box = { id: 'b1', host: 'h', sessionName: 'web' };
  h.record({ b1: claudeStatus({ web: { state: 'ready', cause: 'stop', ts: 100 } }) }, [box]);
  expect(h.getSeries('b1').at(-1).agents.web.state).toBe('done');
  expect(h.markSeen('b1', 'web', 101)).toBe(false);
  expect(h.markSeen('b1', 'nope', 100)).toBe(false);
  expect(h.markSeen('b1', 'web', 100)).toBe(true);
  expect(store.data).toEqual({ b1: { web: 100 } });
  h.record({ b1: claudeStatus({ web: { state: 'ready', cause: 'stop', ts: 100 } }) }, [box]);
  expect(h.getSeries('b1').at(-1).agents.web.state).toBe('idle');
});

test('seen survives a failed probe and a non-claude pane, and is dropped only when the session is gone from a successful listing', () => {
  const store = memSeenStore({ b1: { web: 100 } });
  const h = createHealthHistory({ seenStore: store });
  const box = { id: 'b1', host: 'h', sessionName: 'web' };
  h.record({ b1: { reachable: false } }, [box]);
  expect(store.data).toEqual({ b1: { web: 100 } });
  h.record({ b1: { reachable: true, sessions: [{ name: 'web', windows: 1, attached: false, paneCmd: 'zsh' }] } }, [box]);
  expect(store.data).toEqual({ b1: { web: 100 } });
  h.record({ b1: { reachable: true, sessions: [] } }, [box]);
  expect(store.data).toEqual({ b1: {} });
});

test('a seen session that finishes a new turn is done again, and the event carries the session', () => {
  const store = memSeenStore({ b1: { web: 100 } });
  const seen = [];
  const h = createHealthHistory({ seenStore: store, onEvent: (e) => seen.push(e) });
  const box = { id: 'b1', host: 'h', sessionName: 'web' };
  h.record({ b1: claudeStatus({ web: { state: 'working', cause: 'prompt', ts: 150 } }) }, [box]);
  h.record({ b1: claudeStatus({ web: { state: 'ready', cause: 'stop', ts: 200 } }) }, [box]);
  expect(h.getSeries('b1').at(-1).agents.web.state).toBe('done');
  expect(seen.map((e) => [e.kind, e.session])).toEqual([['agent-input', 'web']]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/healthHistory.test.js -t "markSeen|seen survives|done again"`
Expected: FAIL.

- [ ] **Step 3: Implement** per Interfaces.

- [ ] **Step 4: Run**

Run: `npx vitest run test/healthHistory.test.js test/statusPoller.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/healthHistory.js test/healthHistory.test.js
git commit -m "feat(health): seen watermark owned by history; markSeen and pruning"
```

---

### Task 8: Route, wiring, push titles

**Files:**
- Modify: `src/server/server.js:608-640` (allowlist), add route after `/api/health/events` (`:1817`)
- Modify: `src/server/index.js:305-325, 387-392`
- Modify: `src/server/deviceStore.js:6`
- Modify: `src/server/fcmPush.js:18, 33-42`
- Test: `test/server.test.js`, `test/deviceRoutes.test.js`, `test/fcmPush.test.js:24-33`, `test/deviceStore.test.js`

**Interfaces:**
- `POST /api/boxes/:id/agent-seen` body `{ session: string, ts: number }`. `:id` is a stored box id or `'__local__'` (import `LOCAL_BOX_ID` from `./localAgent.js`). Validation: `session` matches `SESSION_NAME_RE`, `ts` is a positive safe integer; else 400 `{ error: 'invalid session or ts' }`. Unknown box → 404. `history.markSeen(id, session, ts)` false → 400 `{ error: 'nothing to acknowledge' }`. Success → 200 `{ ok: true }` (not 204: the client wraps every call in `jsonOf`, which needs a body — the same shape `reconnectBox` returns). Added to `DEVICE_ALLOWED_ROUTES`.
- `NOTIFY_KINDS = ['agent-blocked', 'agent-input', 'agent-done']` in `deviceStore.js`.
- `fcmPush.js`: `TITLES['agent-blocked'] = 'Claude needs you'`; body for `agent-blocked` is `` `${cause} prompt${session ? ` in ${session}` : ''}` `` with `cause` capitalised (`Permission prompt in web-2`); `agent-input` body gains `` ` in ${session}` `` when present; `data` gains `session` when present.
- `index.js`: `createAgentSeenStore({ dataDir: config.dataDir })` passed as `seenStore`; `() => history.whenIdle()` added to `registerShutdownFlush`.
- `GET /api/boxes/:id/pane` (`server.js:1205`) additionally returns `agentCause: last?.agents?.[box.sessionName]?.cause ?? null`.

- [ ] **Step 1: Write the failing tests**

In `test/server.test.js`, with `makeApp({ history: { ...historyStub(), markSeen: (id, s, ts) => s === 'web' && ts <= 100 } })` (the route's validation runs before `markSeen`, so the stub only has to answer the two accept/refuse cases):

```js
test('POST /api/boxes/:id/agent-seen validates, acknowledges, and refuses a ts ahead of the marker', async () => {
  expect((await post(`/api/boxes/${box.id}/agent-seen`, { session: 'web', ts: 100 })).statusCode).toBe(200);
  expect((await post(`/api/boxes/${box.id}/agent-seen`, { session: 'web', ts: 101 })).statusCode).toBe(400);
  expect((await post(`/api/boxes/${box.id}/agent-seen`, { session: 'bad name', ts: 100 })).statusCode).toBe(400);
  expect((await post(`/api/boxes/${box.id}/agent-seen`, { session: 'web', ts: -1 })).statusCode).toBe(400);
  expect((await post(`/api/boxes/nope/agent-seen`, { session: 'web', ts: 100 })).statusCode).toBe(404);
});
```

In `test/deviceRoutes.test.js`: the allowlist test gains `'POST /api/boxes/:id/agent-seen'`. In `test/fcmPush.test.js`:

```js
test('buildFcmMessage: agent-blocked carries the cause and session', () => {
  const { body } = buildFcmMessage({ projectId: 'p', fcmToken: 'tok', event: { boxId: 'b1', label: 'workbox', kind: 'agent-blocked', session: 'web-2', cause: 'permission', t: 5 } });
  expect(body.message.notification).toEqual({ title: 'workbox — Claude needs you', body: 'Permission prompt in web-2' });
  expect(body.message.data).toEqual({ boxId: 'b1', kind: 'agent-blocked', session: 'web-2' });
});
```

In `test/deviceStore.test.js`: `NOTIFY_KINDS` includes `'agent-blocked'` and a device with no stored toggle reads it as on.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server.test.js test/deviceRoutes.test.js test/fcmPush.test.js test/deviceStore.test.js`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement** the four files per Interfaces.

- [ ] **Step 4: Run**

Run: `npx vitest run test/server.test.js test/deviceRoutes.test.js test/fcmPush.test.js test/deviceStore.test.js test/mcp.integration.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js src/server/index.js src/server/deviceStore.js src/server/fcmPush.js test/server.test.js test/deviceRoutes.test.js test/fcmPush.test.js test/deviceStore.test.js
git commit -m "feat(api): agent-seen acknowledgement route; agent-blocked push kind"
```

---

### Task 9: Web pure half: types, rollup helpers, badge, pane header

**Files:**
- Modify: `src/web/api.ts:46-59, 175-178, 294-297`
- Create: `src/web/agentState.ts`
- Modify: `src/web/statusDot.ts:78-87`
- Modify: `src/web/paneHeader.ts:12-31, 50-66, 71-86, 124-160`
- Test: `test/agentState.test.js` (new), `test/statusDot.test.js:224-237`, `test/paneHeader.test.js:32-55, 212-228`

**Interfaces:**
- `api.ts`: `export type AgentState = 'working' | 'blocked' | 'done' | 'idle'`; `export type AgentCause = 'prompt' | 'resume' | 'stop' | 'start' | 'permission' | 'question' | 'elicitation' | 'unblock'`; `export interface AgentEntry { present: boolean; attached: boolean; state?: AgentState; cause?: AgentCause; ts?: number }`; `Sample.agent?: AgentState`, `Sample.agents?: Record<string, AgentEntry>`; `HealthEventKind` gains `'agent-blocked'`; `HealthEvent` gains `session?: string; cause?: AgentCause`; `api.agentSeen(id: string, session: string, ts: number): Promise<void>` → `POST /api/boxes/${id}/agent-seen`, wrapped in `j()` (`jsonOf` from `http.ts`) like `selectWindow` at `api.ts:294`, so the `test/webHttp.test.js` rule holds.
- `agentState.ts`:
  - `export const AGENT_PRECEDENCE: AgentState[] = ['blocked', 'done', 'working', 'idle']`
  - `export function latestAgents(samples: Sample[] | undefined): Record<string, AgentEntry>` — last sample's `agents` or `{}`.
  - `export function worstAgent(agents): { state: AgentState; count: number; sessions: { session: string; state: AgentState; cause?: AgentCause }[] } | null` — `count` is the number of sessions with any state; `sessions` sorted by precedence then name.
  - `export function agentChipText(state: AgentState, cause?: AgentCause): string` — `'working' | 'done' | 'idle'`, and `` `blocked · ${cause}` `` (or `'blocked'` without a cause).
  - `export function agentCounts(series: Record<string, Sample[]>): Record<AgentState, number>`.
  - `export interface AgentCard { boxId: string; label: string; session: string; state: AgentState; cause?: AgentCause; ts: number }`
  - `export function agentCards(boxes: { id: string; label: string }[], series: Record<string, Sample[]>): Record<AgentState, AgentCard[]>` — the `__local__` series key is labelled `'Host Shell'`; within a column newest `ts` first.
  - `export function fmtAge(fromEpochSec: number, nowMs: number): string` — `'<1m'`, `'4m'`, `'2h'`, `'3d'`.
- `statusDot.ts`: `AgentBadge` becomes `{ text: AgentState; cls: 'badge-agent-<state>'; sprite?: boolean; count: number; title: string }`; `title` is the sessions joined as `` `${session}: ${agentChipText(state, cause)}` `` with `' · '`.
- `paneHeader.ts`: `PaneHeaderInput.agent` and `configuredSession` are **removed**; `PaneHeaderInput.agents?: Record<string, AgentEntry>` added. `paneHeaderChip` reads `agents[sessionName || 'web']?.state`; chips: `cls: 'chip-agent-<state>'`, `text: agentChipText(state, cause)`, `sprite` only for `working`. `sessionTargets(status, sessionName, agents?)` sets `SessionTarget.agent?: AgentState` and `SessionTarget.agentCause?: AgentCause` on session rows; `sessionTargetList` takes the same third argument.

- [ ] **Step 1: Write the failing tests**

`test/agentState.test.js`:

```js
import { test, expect } from 'vitest';
import { worstAgent, agentChipText, agentCounts, agentCards, fmtAge, latestAgents } from '../src/web/agentState.ts';

const S = (agents) => [{ t: 1, up: true, agents }];
test('worstAgent folds by precedence and counts stateful sessions', () => {
  const w = worstAgent({ web: { present: true, attached: false, state: 'done', ts: 1 }, 'web-2': { present: true, attached: false, state: 'blocked', cause: 'permission', ts: 2 }, nomark: { present: true, attached: false } });
  expect(w).toEqual({ state: 'blocked', count: 2, sessions: [{ session: 'web-2', state: 'blocked', cause: 'permission' }, { session: 'web', state: 'done' }] });
  expect(worstAgent({ nomark: { present: true, attached: false } })).toBeNull();
  expect(worstAgent(undefined)).toBeNull();
});
test('agentChipText spells blocked with its cause', () => {
  expect(agentChipText('blocked', 'permission')).toBe('blocked · permission');
  expect(agentChipText('blocked')).toBe('blocked');
  expect(agentChipText('idle')).toBe('idle');
});
test('agentCounts and agentCards cover every box and label the Host Shell', () => {
  const series = { b1: S({ web: { present: true, attached: false, state: 'working', ts: 5 } }), __local__: S({ local: { present: true, attached: false, state: 'done', ts: 9 } }) };
  expect(agentCounts(series)).toEqual({ blocked: 0, done: 1, working: 1, idle: 0 });
  const cards = agentCards([{ id: 'b1', label: 'buildbox' }], series);
  expect(cards.done).toEqual([{ boxId: '__local__', label: 'Host Shell', session: 'local', state: 'done', ts: 9 }]);
  expect(cards.working[0].label).toBe('buildbox');
});
test('fmtAge', () => {
  expect(fmtAge(1000, 1000 * 1000 + 30_000)).toBe('<1m');
  expect(fmtAge(1000, 1000 * 1000 + 4 * 60_000)).toBe('4m');
  expect(fmtAge(1000, 1000 * 1000 + 2 * 3600_000)).toBe('2h');
  expect(fmtAge(1000, 1000 * 1000 + 3 * 86400_000)).toBe('3d');
});
```

`test/statusDot.test.js` (replace the test at line 224):

```js
test('agentBadgeFor: worst state wins, count and title list the sessions, absence is null', () => {
  const agents = { web: { present: true, attached: false, state: 'done', ts: 1 }, 'web-2': { present: true, attached: false, state: 'blocked', cause: 'question', ts: 2 } };
  expect(agentBadgeFor([{ t: 1, up: true, agents }])).toEqual({ text: 'blocked', cls: 'badge-agent-blocked', count: 2, title: 'web-2: blocked · question · web: done' });
  expect(agentBadgeFor([{ t: 1, up: true, agents: { web: { present: true, attached: false, state: 'working', ts: 1 } } }])).toMatchObject({ text: 'working', sprite: true, count: 1 });
  expect(agentBadgeFor([{ t: 1, up: true, agents: {} }])).toBeNull();
  expect(agentBadgeFor(undefined)).toBeNull();
});
```

`test/paneHeader.test.js`: rewrite lines 32-55 and 212-228 so the input carries `agents` and `sessionName`; assert a pane on `web-2` shows `web-2`'s chip (`{ kind: 'agent', text: 'blocked · permission', cls: 'chip-agent-blocked' }`) while the same `agents` on `web` shows `{ text: 'done', cls: 'chip-agent-done' }`, `idle` renders `{ text: 'idle', cls: 'chip-agent-idle' }`, and a session with no entry renders no chip. Add: `sessionTargets(status, 'web', agents)` session rows carry `agent`/`agentCause`, window rows do not.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/agentState.test.js test/statusDot.test.js test/paneHeader.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** the four web files per Interfaces.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/agentState.test.js test/statusDot.test.js test/paneHeader.test.js test/sessionPicker.test.js && npm run typecheck`
Expected: tests PASS; typecheck reports errors only in `main.ts`, `dashboard.ts`, `sessionPicker.ts` (fixed in Task 10). If typecheck reports nothing else, proceed.

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/agentState.ts src/web/statusDot.ts src/web/paneHeader.ts test/agentState.test.js test/statusDot.test.js test/paneHeader.test.js
git commit -m "feat(ui): four-state agent model, per-box rollup, own-session pane chip"
```

---

### Task 10: Web DOM half: badges, strip, picker chips, board, seen reporting, styles

**Files:**
- Modify: `src/web/main.ts:104-160, 363-371, 662-700, 905-931, 1313-1316, 1959-1990, 2170-2200`
- Modify: `src/web/sessionPicker.ts:159-210`
- Modify: `src/web/dashboard.ts:21-36, 300-306, 390-415`
- Modify: `src/web/notifyPrefs.ts:9-18`, `src/web/healthEvents.ts:47-68`
- Modify: `src/web/style.css:556-561, 912-923, 1090-1093` plus new rules
- Test: `test/notifyPrefs.test.js`, `test/healthEvents.test.js`, `test/dashboard.test.js`, `test/styleTokens.test.js`

**Interfaces:**
- `main.ts`:
  - `paneHeaderModelFor(id)` passes `agents: latestAgents(latestSeries[boxId])` and no `agent`/`configuredSession`.
  - `applyAgentBadge` renders `badge.text` plus `` ` ×${count}` `` when `count > 1`, sets `el.title = badge.title`.
  - Attention strip: a `<div id="agent-strip" class="agent-strip" hidden>` inserted in the sidebar template directly above `<ul id="boxes">`; `repaintAgentStrip()` (called from `pollHealth` after `repaintAgentBadges`) renders one `<button class="agent-strip-seg" data-state="<state>">` per non-zero count in precedence order, text `` `${n} need${n === 1 ? 's' : ''} you` `` for blocked, `` `${n} working` ``, `` `${n} done` ``, `` `${n} idle` ``; a click toggles module state `agentFilter: AgentState | null`, marks the segment `.active`, and calls `filterAndPaint()`. `filterAndPaint` keeps a box when `agentFilter` is null or `worstAgent(latestAgents(latestSeries[b.id]))?.state === agentFilter`. Hidden when every count is zero (and then `agentFilter` resets to null).
  - Seen reporting: `reportSeen()` called at the end of `pollHealth`'s series branch and on `document` `visibilitychange` and `window` `focus`. For each `tabs` entry whose instance is rendered (desktop: all docked; phone: `focusedPaneId` only), when `document.visibilityState === 'visible' && document.hasFocus()`: `box = boxOfInstance(iid)`, `session = attachedSession(iid)`, `entry = latestAgents(latestSeries[box])[session]`; if `entry?.state === 'done' && entry.ts && ackedSeen.get(`${box}:${session}`) !== entry.ts`, set the map and `void api.agentSeen(box, session, entry.ts).catch(() => {})`. `ackedSeen` is a module-level `Map<string, number>`. The Host Shell pane uses `'__local__'` as its box id in this call.
  - `openPaneOnSession(boxId: string, session: string)`: `openPane(boxId)` (which is all `openLocalShell()` does for `'__local__'`), then, for a real box, `switchPaneSession(<the instance id openPane docked or focused>, session)`. Passed to the dashboard as `onOpenSession`.
- `sessionPicker.ts` `render()`: when `t.agent` is set, append `<span class="session-picker-chip chip-agent-${t.agent}">${agentChipText(t.agent, t.agentCause)}</span>` inside the pick button after the label.
- `dashboard.ts`: `DashboardHooks.onOpenSession(boxId: string, session: string): void`; a `section.dash-board` inserted before `fleet` with `legend('AGENTS')` and four `div.dash-board-col[data-state]` in precedence order, each with a `div.dash-board-head` (`Needs you` / `Working` / `Done` / `Idle`) and a `div.dash-board-cards`; `paintBoard()` runs on every `update` with `series`, builds one `button.dash-card[data-box-id][data-session]` per `AgentCard` containing `.dash-card-box` (label), `.dash-card-session` (session), `.dash-card-cause` (blocked only, the cause), `.dash-card-age` (`fmtAge(card.ts, Date.now())`); click → `hooks.onOpenSession(card.boxId, card.session)`. The section is `hidden` when every column is empty; an empty column gets class `empty`. The fleet strip chip at `:401-408` uses `worstAgent` and `agentChipText` with classes `dash-chip-<state>`.
- `notifyPrefs.ts`: first entry `{ kind: 'agent-blocked', label: 'Claude needs you (permission or question)' }`; `agent-input` label becomes `'Claude finished a turn'`. `healthEvents.ts` `formatEvent`: `agent-blocked` → `` `${name}${sess} — claude needs you: ${e.cause ?? 'blocked'}` `` level `'crit'`; `agent-input` → `` `${name}${sess} — claude finished a turn` ``; `agent-done` → `` `${name}${sess} — claude exited` ``, where `sess` is `` ` · ${e.session}` `` when present.
- `style.css` (tokens only, no literals): `.badge-agent-blocked`, `.pane-chip.chip-agent-blocked`, `.dash-chip-blocked`, `.session-picker-chip.chip-agent-blocked` on `--crit`; `*-done` takes the current `*-waiting` recipe (`--commit`) and the `*-waiting` rules are removed; `*-idle` on `--dim` with a transparent background; `.agent-strip`, `.agent-strip-seg`, `.agent-strip-seg.active`; `.dash-board`, `.dash-board-col`, `.dash-board-head`, `.dash-card*`; `.session-picker-chip` (inline, `margin-left: 6px`, same recipe as `.pane-chip`). Themes in `src/web/themes/*.css` need a change only if they override a removed `*-waiting` selector (grep first).

- [ ] **Step 1: Write the failing pure tests**

`test/notifyPrefs.test.js`: `NOTIFY_KINDS[0].kind === 'agent-blocked'` and `defaultNotifyPrefs()['agent-blocked'] === true`. `test/healthEvents.test.js`: the three agent lines above with and without `session`. `test/dashboard.test.js`: nothing new is pure here beyond `agentState.ts`; leave it.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/notifyPrefs.test.js test/healthEvents.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** everything in Files per Interfaces.

- [ ] **Step 4: Typecheck, unit tests, style pins**

Run: `npm run typecheck && npx vitest run test/notifyPrefs.test.js test/healthEvents.test.js test/styleTokens.test.js test/themes.test.js test/dashboard.test.js test/sessionPicker.test.js`
Expected: PASS, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add src/web/main.ts src/web/sessionPicker.ts src/web/dashboard.ts src/web/notifyPrefs.ts src/web/healthEvents.ts src/web/style.css test/notifyPrefs.test.js test/healthEvents.test.js
git commit -m "feat(ui): attention strip, agents board, picker chips, seen acknowledgement"
```

---

### Task 11: Browser verification (e2e)

**Files:**
- Modify: `test/e2e/global-setup.js` (export fixture handles)
- Create: `test/e2e/agentStates.spec.ts`

**Interfaces:**
- `global-setup.js` sets `process.env.E2E_SSH_CONFIG = lb.sshConfigFile`, `process.env.E2E_BOX_HOST = lb.box.host`, `process.env.E2E_BOX_HOME = lb.home`, `process.env.E2E_BOX_SESSION = lb.session` (Playwright propagates globalSetup env to workers).

- [ ] **Step 1: Write the spec**

Login as `health.spec.ts` does. Then, with `execFileSync('ssh', ['-F', cfg, host, ...])`:
1. `tmux send-keys -t '=<session>' 'exec -a claude sleep 600' Enter` — tmux's `pane_current_command` reads `argv[0]`, so the pane now reports `claude`.
2. Write `${E2E_BOX_HOME}/.tmuxifier-agent/<session>` with `<session>:blocked:<now>:permission\n` (node `fs`, mode 0o600).
3. `await expect(page.locator('.box .badge-agent-blocked')).toHaveText(/blocked/, { timeout: 15000 })`; `expect(page.locator('#agent-strip .agent-strip-seg[data-state="blocked"]')).toHaveText('1 needs you')`.
4. With no pane docked the dashboard shows: `await expect(page.locator('.dash-board .dash-card[data-session="<session>"] .dash-card-cause')).toHaveText('permission')`.
5. Click the card: `await expect(page.locator('.pane-header .chip-agent-blocked')).toHaveText('blocked · permission')`.
6. Rewrite the marker as `<session>:ready:<now+1>:stop`; expect the pane chip to read `done` then, because the pane is docked, visible and focused, `idle` within two polls (`toHaveText('idle', { timeout: 15000 })`).
7. Cleanup in `finally`: remove the marker file, `tmux respawn-pane -k -t '=<session>'` to restore the shell.

- [ ] **Step 2: Build and run**

Run: `npm run build && npx playwright test test/e2e/agentStates.spec.ts`
Expected: PASS. (In a worktree, `npm run build` is required before every e2e run; a failed global-setup orphans port 7438 and poisons the next run — see the memory note in `docs/` history if it happens.)

- [ ] **Step 3: Commit**

```bash
git add test/e2e/global-setup.js test/e2e/agentStates.spec.ts
git commit -m "test(e2e): agent lifecycle states reach badge, strip, board and chip"
```

---

### Task 12: MCP tools speak the new vocabulary

**Files:**
- Modify: `src/mcp/tools.js:7, 35, 37, 52, 180-183`
- Modify: `src/mcp/shape.js:36, 72, 83-93`
- Test: `test/mcpTools.test.js:35, 78-115, 208-230`, `test/mcpShape.test.js:30-40, 86-90`
- Modify: `docs/mcp.md:103`

**Interfaces:**
- `AGENT_STATES = ['working', 'blocked', 'done', 'idle', 'waiting', 'gone']` — the schema enum; `'waiting'` is documented as a deprecated alias expanding to `['done', 'idle']`.
- `wait_for_agent` input gains `session` (string, pattern `^[A-Za-z0-9_-]{1,64}$`, "defaults to the box's configured session"); default `until` is `['blocked', 'done', 'idle']`; output `state: <state>` adds `session: <name>` and, for `blocked`, `cause: <cause>`.
- `shape.js`: `agentOf(sample, session?)` → with `session`, `sample?.agents?.[session]?.state ?? 'gone'`; without, `sample?.agent ?? 'gone'`. `boxLine` replaces `agent: X` with `` `agents: ${entries}` `` where entries are `` `${session}=${state}${cause ? `(${cause})` : ''}` `` joined by `', '`, from `sample.agents`, sessions with no state omitted; falls back to the legacy `agent: X` when `agents` is absent. `healthText` does the same. `paneText`'s header becomes `` `agent:${agentOf({ agent: snap.agent })}${snap.agentCause ? `(${snap.agentCause})` : ''}` `` (the pane route's new `agentCause` from Task 8).
- Tool descriptions for `list_boxes`, `box_health`, `wait_for_agent` describe the four states and that `done` becomes `idle` only when a person looks in the web app.

- [ ] **Step 1: Write the failing tests**

Update `test/mcpTools.test.js:35` to the new `AGENT_STATES`; line 106 expected text to `· agents: web=working` (the stub's sample gains `agents: { web: { present: true, attached: false, state: 'working', ts: 1 } }`); line 115 stays `agent:gone` (no `agentCause` in the stub); the `wait_for_agent` tests: default returns on `done`, `until: ['waiting']` returns on `idle`, `session: 'web-2'` reads that session from `agents`, output includes `session:`. `test/mcpShape.test.js`: `agentOf({ agents: { web: { state: 'blocked' } } }, 'web') === 'blocked'`; `boxLine` with `agents` renders `agents: web=done, web-2=blocked(permission)`; `paneText` with `agent: 'blocked', agentCause: 'permission'` renders `agent:blocked(permission)`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/mcpTools.test.js test/mcpShape.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**, and update the `wait_for_agent` row in `docs/mcp.md`.

- [ ] **Step 4: Run**

Run: `npx vitest run test/mcpTools.test.js test/mcpShape.test.js test/mcpApiClient.test.js test/mcp.integration.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.js src/mcp/shape.js test/mcpTools.test.js test/mcpShape.test.js docs/mcp.md
git commit -m "feat(mcp): four agent states, per-session wait_for_agent"
```

---

### Task 13: Docs and architecture map

**Files:**
- Modify: `docs/fleet-and-health.md:65-100`
- Modify: `docs/android-app.md:45-46, 81, 91`
- Modify: `CLAUDE.md:41-42, 318-330` and the same lines in `AGENTS.md`

- [ ] **Step 1: Rewrite the agent paragraph in `docs/fleet-and-health.md`**

Cover: the four states and what each means; `blocked` causes; every session is tracked; the box badge shows the worst state with a count; the attention strip and board; `done` → `idle` only when you look at the pane in a focused, visible tab (phone: the shown pane), never from a raw ssh attach; the three event kinds and their notification toggles; boxes with the old hook show `done`/`idle` but never `blocked` until setup is rerun and Claude restarted.

- [ ] **Step 2: Note the interim in `docs/android-app.md`**

One sentence at each of the three lines: the app currently shows a chip only for states it knows; the new states arrive with issue #5.

- [ ] **Step 3: Update the map**

`CLAUDE.md` data table: add `| agent-seen.json | per box, per session: marker ts of the newest finished turn the operator has seen | — |`. Status-and-health section: `healthHistory.js` bullet gains per-session `agents`, the seen watermark, `agent-blocked`; the hook bullet in "Setup jobs and the Claude stack" describes `<session>:<state>:<epoch>:<cause>` and the `unblock` short-circuit. Load-bearing rules: add "**Seen is a client claim.** Only `POST /api/boxes/:id/agent-seen` from a visible, focused client raises the watermark; tmux `attached` suppresses a notification and never marks seen." Mirror every change into `AGENTS.md`.

- [ ] **Step 4: Verify the two maps agree**

Run: `diff <(sed -n '1,999p' CLAUDE.md) <(sed -n '1,999p' AGENTS.md) | head`
Expected: only the pre-existing differences (if any); none introduced by this task.

- [ ] **Step 5: Commit**

```bash
git add docs/fleet-and-health.md docs/android-app.md CLAUDE.md AGENTS.md
git commit -m "docs: agent lifecycle states, seen rule, agent-seen.json"
```

---

### Task 14: Full suite and live validation

**Files:** none new.

- [ ] **Step 1: Full test run in the worktree**

Run: `npm test`
Expected: PASS (typecheck + unit + integration).

- [ ] **Step 2: Deploy the candidate to the live app**

Per CLAUDE.md Shipping: `npm run build` in the worktree, `rsync -a --delete <worktree>/dist/ /root/tmuxifier/dist/`, copy the changed `src/server/*.js`, `src/server/assets/*.sh` and `src/mcp/*.js` files, wait until no setup/provision/lifecycle/fleet/voice-install/apk-build job is `running`, then `systemctl restart tmuxifier` as root. Verify one hashed asset returns its real content type.

- [ ] **Step 3: Walk spec §11 on a real box**

Rerun setup on one box (tick Claude Code, save), restart `claude` there, and walk steps 1 through 7 of spec §11, recording each observed state and poll delay in the PR description. Step 2's push lands on the phone only after the Android app is updated (issue #5); the browser notification and events panel are the check here.

- [ ] **Step 4: Fix forward**

Any failure is fixed on the branch with a test that would have caught it, redeployed, and re-walked. Only then does the branch go to `superpowers:finishing-a-development-branch`.
