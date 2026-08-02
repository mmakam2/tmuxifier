# Host-Shell Agent Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Claude Code agent-state hooks into the Tmuxifier host's own shell: opt-in hook install from the Host Shell ✎ dialog, a `__local__` pseudo-box fed into healthHistory each poll, and the agent badge/chip/notifications riding the existing rails.

**Architecture:** A new `localAgent.js` sampler reads the host's own tmux sessions and `~/.tmuxifier-agent/` markers locally (no SSH), producing the same status shape the box probe produces. `statusPoller` appends a synthetic `__local__` pseudo-box to the `history.record()` call only — `/api/status` never sees it. Install reuses `createAgentHooksPusher` verbatim over a local `/bin/sh` stdin transport, triggered by an optional `claudeHooks` flag on `PATCH /api/local-shell`.

**Tech Stack:** Node 20+ ESM server (`.js`), TypeScript web client (`.ts`), vitest (node environment — no DOM tests), Fastify `app.inject()` route tests.

**Spec:** `docs/superpowers/specs/2026-08-02-host-shell-agent-hooks-design.md`

## Global Constraints

- ESM everywhere (`"type": "module"`); Node 20+.
- TDD with **real code, not mocks** — dependency-injection factories; tests inject fakes as arguments, never patch modules.
- Server code is plain `.js`; web client is `.ts`. `npm run typecheck` must pass (vitest strips types unchecked).
- vitest runs `environment: 'node'` — DOM-rendering client code is untested by design; do not write DOM tests.
- Conventional-commit messages (`feat(...)`, `test(...)`, `docs: ...`).
- Public repo: no real hostnames/IPs/emails anywhere — placeholders only (`example.com`, RFC1918).
- Marker/tmux content is untrusted input: it must only ever pass through the existing allowlisting parsers (`parseAgentMarks`, `parseTmuxSessions`) — never a new ad-hoc parser.
- Unchecked opt-in touches nothing: the `claudeHooks` flag absent or `false` must not run any install code (v1.24.13 posture). Unchecking never uninstalls.
- The pseudo-box id is exactly `__local__` (matches `LOCAL_GROUP` in `sessions.js` and the client's pane id); its label is exactly `Host Shell`; its `sessionName` is the `localSession` knob (default `'local'`).

---

### Task 1: Local agent sampler (`localAgent.js`)

**Files:**
- Modify: `src/server/status.js:11` (export `STATUS_FMT` — one-word change)
- Create: `src/server/localAgent.js`
- Test: `test/localAgent.test.js`

**Interfaces:**
- Consumes: `STATUS_FMT`, `parseTmuxSessions(stdout)`, `parseAgentMarks(stdout)` from `./status.js`; `sampleOf` from `./healthHistory.js` (test only, to prove shape compatibility).
- Produces: `export const LOCAL_BOX_ID = '__local__'`; `export async function readAgentMarks(home)` → `{ [session]: { state, ts } } | null`; `export function createLocalAgentSampler({ home?, runTmux? })` → `{ sample(): Promise<{ reachable: true, tmux?: true, sessions: Array<{name, windows, attached, activity, paneCmd}>, agentMarks?: object }> }`. `sample()` **never rejects**.

- [ ] **Step 1: Write the failing test**

Create `test/localAgent.test.js`:

```js
import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalAgentSampler, readAgentMarks, LOCAL_BOX_ID } from '../src/server/localAgent.js';
import { sampleOf } from '../src/server/healthHistory.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-localagent-'));
}

test('LOCAL_BOX_ID matches the client pane id', () => {
  expect(LOCAL_BOX_ID).toBe('__local__');
});

test('readAgentMarks parses a valid marker through the probe allowlist', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'local'), 'local:working:1722600000\n');
  expect(await readAgentMarks(home)).toEqual({ local: { state: 'working', ts: 1722600000 } });
});

test('readAgentMarks returns null for a missing dir, malformed content, and bad state', async () => {
  expect(await readAgentMarks(tmpHome())).toBeNull();

  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'a'), 'not a marker at all');
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'b'), 'local:reticulating:1722600000');
  expect(await readAgentMarks(home)).toBeNull();
});

test('readAgentMarks caps an oversized marker at 200 bytes (same as the on-box probe)', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  // 300 bytes of junk: the 200-byte cap truncates it and the parser drops it.
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'big'), 'x'.repeat(300));
  expect(await readAgentMarks(home)).toBeNull();
});

test('sample() reads tmux sessions via the shared STATUS_FMT parser', async () => {
  const home = tmpHome();
  const calls = [];
  const sampler = createLocalAgentSampler({
    home,
    runTmux: async (args) => {
      calls.push(args);
      return { code: 0, stdout: 'local:1:0:1722600000:claude\n' };
    },
  });
  const s = await sampler.sample();
  expect(calls[0][0]).toBe('ls');
  expect(s.reachable).toBe(true);
  expect(s.tmux).toBe(true);
  expect(s.sessions).toEqual([{ name: 'local', windows: 1, attached: false, activity: 1722600000, paneCmd: 'claude' }]);
});

test('sample() degrades to no sessions when tmux is absent or has no server', async () => {
  const noServer = createLocalAgentSampler({ home: tmpHome(), runTmux: async () => ({ code: 1, stdout: '' }) });
  expect(await noServer.sample()).toMatchObject({ reachable: true, sessions: [] });

  const throwing = createLocalAgentSampler({ home: tmpHome(), runTmux: async () => { throw new Error('ENOENT'); } });
  expect(await throwing.sample()).toMatchObject({ reachable: true, sessions: [] });
});

test('the sample shape drives sampleOf exactly like a box probe result', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'local'), 'local:working:1722600000');
  const sampler = createLocalAgentSampler({
    home,
    runTmux: async () => ({ code: 0, stdout: 'local:1:0:1722600000:claude\n' }),
  });
  const sample = sampleOf(await sampler.sample(), 123, { sessionName: 'local' });
  expect(sample.up).toBe(true);
  expect(sample.agentPresent).toBe(true);
  expect(sample.agent).toBe('working');
  expect(sample.agentAttached).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/localAgent.test.js`
Expected: FAIL — `Cannot find module '../src/server/localAgent.js'`

- [ ] **Step 3: Export STATUS_FMT and write the sampler**

In `src/server/status.js` line 11, change `const STATUS_FMT =` to `export const STATUS_FMT =`.

Create `src/server/localAgent.js`:

```js
// The Host Shell's stand-in for the SSH status probe: reads the host's OWN
// tmux sessions and ~/.tmuxifier-agent/ markers (written by the locally
// installed Claude Code hook — see claudeAgentHooks.js) and shapes them
// exactly like a box probe result, so healthHistory.sampleOf() and everything
// downstream (badge, pane chip, agent-input/agent-done events) work
// unchanged. Fed to healthHistory by statusPoller as the `__local__`
// pseudo-box; never part of the /api/status snapshot.
//
// Marker files and tmux output are input, not trusted: both only ever pass
// through the same allowlisting parsers the SSH probe output goes through.
// The sample is always `reachable` (this host IS the server) and never
// carries metrics, so classifyTransitions can structurally never emit
// down/up/needs-auth/threshold events for it — only the agent edges.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { STATUS_FMT, parseTmuxSessions, parseAgentMarks } from './status.js';

// Matches LOCAL_GROUP in sessions.js and the client's pane id. Defined here
// rather than imported from sessions.js so statusPoller's import chain stays
// free of node-pty.
export const LOCAL_BOX_ID = '__local__';

const MARK_MAX_BYTES = 200; // same cap the on-box probe applies (head -c 200)
const TMUX_TIMEOUT_MS = 5000;

function runTmuxDefault(args) {
  return new Promise((resolve) => {
    execFile('tmux', args, { timeout: TMUX_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || '') });
    });
  });
}

// Mirror of the on-box AGENT_PROBE shell fragment: each marker file becomes
// one `__AGENT__ <content>` line — capped, newline-stripped — then the same
// parser that handles probe stdout applies its closed state set and numeric
// timestamp allowlist.
export async function readAgentMarks(home) {
  const dir = path.join(home, '.tmuxifier-agent');
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return null; }
  const lines = [];
  for (const name of names) {
    try {
      const buf = await fs.promises.readFile(path.join(dir, name));
      lines.push('__AGENT__ ' + buf.subarray(0, MARK_MAX_BYTES).toString('utf8').replace(/\n/g, ''));
    } catch { /* unreadable marker: skip it, keep the rest */ }
  }
  return parseAgentMarks(lines.join('\n'));
}

export function createLocalAgentSampler({ home = os.homedir(), runTmux = runTmuxDefault } = {}) {
  return {
    // Never rejects: a sampler failure must never disturb the poll loop.
    async sample() {
      const out = { reachable: true, sessions: [] };
      try {
        const res = await runTmux(['ls', '-F', STATUS_FMT]);
        // Exit 1 covers both "no server running" and tmux absent — either
        // way there are no sessions; the tmux flag is only asserted when the
        // listing actually succeeded.
        if (res.code === 0) {
          out.tmux = true;
          out.sessions = parseTmuxSessions(res.stdout);
        }
      } catch { /* no tmux: no sessions */ }
      try {
        const marks = await readAgentMarks(home);
        if (marks) out.agentMarks = marks;
      } catch { /* marker dir unreadable: no agent state */ }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/localAgent.test.js`
Expected: PASS (7 tests). Also run `npx vitest run test/status.test.js` — the `STATUS_FMT` export change must not break it.

- [ ] **Step 5: Commit**

```bash
git add src/server/status.js src/server/localAgent.js test/localAgent.test.js
git commit -m "feat(health): local agent sampler for the host shell"
```

---

### Task 2: Poller feeds the `__local__` pseudo-box to healthHistory

**Files:**
- Modify: `src/server/statusPoller.js` (factory options + the `if (history)` block in `pollOnce`, currently lines 57-62)
- Modify: `src/server/index.js` (wire the sampler — the `createStatusPoller({...})` call at line 265)
- Test: `test/statusPoller.test.js` (append tests)

**Interfaces:**
- Consumes: `LOCAL_BOX_ID` from `./localAgent.js`; a sampler with `sample(): Promise<object|null>` (Task 1's shape).
- Produces: `createStatusPoller` accepts two new options — `localAgent = null` (the sampler; `null` preserves current behavior exactly) and `localSession = 'local'`. When present, `history.record()` receives `{ ...snapshot, __local__: <sample> }` and `[...boxes, { id: '__local__', label: 'Host Shell', host: 'localhost', sessionName: localSession }]`. `getSnapshot()` never contains `__local__`.

- [ ] **Step 1: Write the failing tests**

Append to `test/statusPoller.test.js`, reusing the file's existing `fakeStore`/`statusChecker` helpers (read the top of the file first and match how existing tests construct them):

```js
test('pollOnce feeds a __local__ pseudo-box to history when a local sampler is present', async () => {
  const calls = [];
  const localAgent = {
    sample: async () => ({
      reachable: true,
      sessions: [{ name: 'local', windows: 1, attached: false, activity: 1, paneCmd: 'claude' }],
      agentMarks: { local: { state: 'working', ts: 1 } },
    }),
  };
  const boxes = [{ id: 'b1', host: 'h1' }];
  const poller = createStatusPoller({
    store: fakeStore(boxes),
    statusChecker,
    history: { record: (snap, bx) => calls.push([snap, bx]) },
    localAgent,
  });
  await poller.pollOnce();
  const [snap, bx] = calls[0];
  expect(snap.__local__.agentMarks.local.state).toBe('working');
  expect(snap.b1).toBeDefined();
  expect(bx.at(-1)).toEqual({ id: '__local__', label: 'Host Shell', host: 'localhost', sessionName: 'local' });
  // The pseudo-box exists only in the history feed — never in /api/status.
  expect(poller.getSnapshot().__local__).toBeUndefined();
});

test('a throwing local sampler still records the real boxes', async () => {
  const calls = [];
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: 'h1' }]),
    statusChecker,
    history: { record: (snap, bx) => calls.push([snap, bx]) },
    localAgent: { sample: async () => { throw new Error('boom'); } },
  });
  await poller.pollOnce();
  const [snap, bx] = calls[0];
  expect(snap.__local__).toBeUndefined();
  expect(bx.map((b) => b.id)).toEqual(['b1']);
});
```

If the file's helpers differ in name or shape from the above (e.g. `fakeStore` takes different arguments), adapt the test construction to match the file's existing pattern — the assertions stay as written.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/statusPoller.test.js`
Expected: the two new tests FAIL (`snap.__local__` undefined); all pre-existing tests still PASS.

- [ ] **Step 3: Implement the pseudo-box feed**

In `src/server/statusPoller.js`:

Add the import at the top:

```js
import { LOCAL_BOX_ID } from './localAgent.js';
```

Add the two options to the factory signature (after `statusEnricher = null,`):

```js
  history = null, statusEnricher = null,
  localAgent = null, localSession = 'local',
```

Replace the existing `if (history) { ... }` block inside `pollOnce` with:

```js
      if (history) {
        // History must never affect status availability: the snapshot is already
        // swapped, so a bug here can't blank /api/status.
        try {
          let snap = snapshot;
          let recorded = boxes;
          if (localAgent) {
            // The Host Shell rides the history rails as a pseudo-box (badge,
            // pane chip, agent events) but must never leak into /api/status —
            // hence the local copies rather than touching `snapshot`.
            const local = await Promise.resolve().then(() => localAgent.sample()).catch(() => null);
            if (local) {
              snap = { ...snapshot, [LOCAL_BOX_ID]: local };
              recorded = [...boxes, { id: LOCAL_BOX_ID, label: 'Host Shell', host: 'localhost', sessionName: localSession }];
            }
          }
          history.record(snap, recorded);
        } catch { /* swallowed on purpose */ }
      }
```

In `src/server/index.js`: add `import { createLocalAgentSampler } from './localAgent.js';` with the other server imports, and add `localAgent: createLocalAgentSampler(),` to the `createStatusPoller({...})` options at line 265.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/statusPoller.test.js`
Expected: PASS, including all pre-existing tests (the `localAgent = null` default keeps them on the old path).

- [ ] **Step 5: Commit**

```bash
git add src/server/statusPoller.js src/server/index.js test/statusPoller.test.js
git commit -m "feat(health): feed the host shell as a __local__ pseudo-box into health history"
```

---

### Task 3: Local hook install (`localShellActions.installAgentHooks`)

**Files:**
- Modify: `src/server/localShellActions.js`
- Test: `test/localShellActions.test.js` (append tests)

**Interfaces:**
- Consumes: `createAgentHooksPusher({ runStdin, readAsset })` and `buildAgentHooksInstallScript()` from `./claudeAgentHooks.js` (both unchanged); the hook asset `src/server/assets/tmuxifier-agent-hook.sh`.
- Produces: `createLocalShellActions` accepts two new injectables — `runStdin(script, input, opts)` → `Promise<{code, stdout, stderr}>` and `readHookAsset()` → `Promise<Buffer>` — and returns a new method `installAgentHooks(): Promise<{ target: 'agent-hooks', ok: boolean, skipped?: string, error?: string }>` (the pusher's exact result shape).

- [ ] **Step 1: Write the failing tests**

Append to `test/localShellActions.test.js`:

```js
import { buildAgentHooksInstallScript } from '../src/server/claudeAgentHooks.js';

test('installAgentHooks runs the standard install script locally with the hook bytes on stdin', async () => {
  const calls = [];
  const actions = createLocalShellActions({
    runStdin: async (script, input, opts) => {
      calls.push({ script, input, opts });
      return { code: 0, stdout: 'AGENTHOOKS: applied\n', stderr: '' };
    },
    readHookAsset: async () => Buffer.from('#!/bin/sh\nhook-body\n'),
  });

  await expect(actions.installAgentHooks()).resolves.toEqual({ target: 'agent-hooks', ok: true });
  expect(calls).toHaveLength(1);
  // The exact same installer the SSH pusher sends — local transport, zero drift.
  expect(calls[0].script).toBe(buildAgentHooksInstallScript());
  expect(calls[0].input.toString()).toContain('hook-body');
  expect(calls[0].opts.cwd).toBe(os.homedir());
});

test('installAgentHooks maps skipped-no-claude', async () => {
  const actions = createLocalShellActions({
    runStdin: async () => ({ code: 0, stdout: 'AGENTHOOKS: skipped-no-claude\n', stderr: '' }),
    readHookAsset: async () => Buffer.from('x'),
  });
  const res = await actions.installAgentHooks();
  expect(res.ok).toBe(false);
  expect(res.skipped).toBeTruthy();
});

test('installAgentHooks reports a failed run as an error result, never a throw', async () => {
  const actions = createLocalShellActions({
    runStdin: async () => ({ code: 4, stdout: '', stderr: 'jq: not found' }),
    readHookAsset: async () => Buffer.from('x'),
  });
  const res = await actions.installAgentHooks();
  expect(res.ok).toBe(false);
  expect(res.error).toBeTruthy();
});
```

Note the file already imports `os` and `createLocalShellActions`; add the `buildAgentHooksInstallScript` import next to the existing imports at the top of the file, not mid-file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/localShellActions.test.js`
Expected: the three new tests FAIL (`actions.installAgentHooks is not a function`); pre-existing tests PASS.

- [ ] **Step 3: Implement**

In `src/server/localShellActions.js`:

Add imports:

```js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createAgentHooksPusher } from './claudeAgentHooks.js';
```

Add the local stdin runner beside `runLocalShellScript`:

```js
// Like runLocalShellScript, but the script reads bytes from stdin — the
// script + stdin contract createAgentHooksPusher expects, over a local
// transport instead of ssh. execFile can't feed stdin, hence spawn.
function runLocalScriptStdin(script, input, { cwd = os.homedir(), env = process.env, timeout = SETUP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', script], { cwd, env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
    // The skipped-no-claude path drains stdin, but guard anyway: a script that
    // exits before reading must not turn into an unhandled EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const readHookAssetDefault = () => fs.promises.readFile(new URL('./assets/tmuxifier-agent-hook.sh', import.meta.url));
```

Extend the factory:

```js
export function createLocalShellActions({ run = runLocalShellScript, runStdin = runLocalScriptStdin, readHookAsset = readHookAssetDefault, cwd = os.homedir(), env = process.env, localSession = 'local' } = {}) {
  // The SSH pusher's transport signature is (box, script, bytes); the host has
  // no box, so the local transport drops that argument. Everything else —
  // installer script, result parsing, skip/error mapping — is the pusher's,
  // so the two install paths cannot drift.
  const hooksPusher = createAgentHooksPusher({
    runStdin: (_box, script, bytes) => runStdin(script, bytes, { cwd, env }),
    readAsset: readHookAsset,
  });
  return {
    async ensureReady(shell) {
      // ... existing body unchanged ...
    },
    async installAgentHooks() {
      return hooksPusher.push(null);
    },
  };
}
```

(Keep the existing `ensureReady` body exactly as it is — only the factory signature and the added method change.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/localShellActions.test.js`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/server/localShellActions.js test/localShellActions.test.js
git commit -m "feat(setup): local agent-hook install for the host shell"
```

---

### Task 4: `claudeHooks` flag on `PATCH /api/local-shell`

**Files:**
- Modify: `src/server/server.js` (the PATCH handler at lines 1498-1516)
- Test: `test/server.test.js` (append next to the existing local-shell tests at lines 661-700)

**Interfaces:**
- Consumes: `localShellActions.installAgentHooks()` (Task 3's result shape).
- Produces: `PATCH /api/local-shell` accepts optional `claudeHooks: boolean` in the body. Response is `{ ok: true }` unchanged when absent/false; `{ ok: true, agentHooks: { target, ok, skipped?, error? } }` when `claudeHooks === true`. A failed hook install never fails the request — the shell change already persisted.

- [ ] **Step 1: Write the failing tests**

Append to `test/server.test.js` next to the existing `PATCH /api/local-shell` tests (lines 661-700). Read those tests first and construct the app the same way they do (the file's `buildServer({ ... })` helper with `serverOverrides`):

```js
test('PATCH /api/local-shell claudeHooks:true runs the local hook install and reports the result', async () => {
  // Same app construction as the neighboring local-shell tests, overriding:
  // localShellActions: {
  //   ensureReady: async () => ({ ok: true }),
  //   installAgentHooks: async () => ({ target: 'agent-hooks', ok: true }),
  // }
  const res = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: { shell: 'none', claudeHooks: true } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, agentHooks: { target: 'agent-hooks', ok: true } });
});

test('PATCH /api/local-shell without claudeHooks never touches the installer', async () => {
  // installAgentHooks must not be reachable on this path:
  // installAgentHooks: async () => { throw new Error('must not be called'); }
  const res = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: { shell: 'none' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});

test('PATCH /api/local-shell reports a failed hook install without failing the request', async () => {
  // installAgentHooks: async () => ({ target: 'agent-hooks', ok: false, skipped: 'no Claude on the box' })
  const res = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: { shell: 'none', claudeHooks: true } });
  expect(res.statusCode).toBe(200);
  expect(res.json().ok).toBe(true);
  expect(res.json().agentHooks.ok).toBe(false);
});
```

The comment blocks are instructions: expand them into real `localShellActions` overrides using the file's existing app-construction pattern (each test builds its own app instance if that is what the neighbors do).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.test.js -t 'local-shell'`
Expected: the three new tests FAIL (no `agentHooks` in the response; second test passes trivially only if response equals `{ok:true}` — confirm the first and third fail); pre-existing local-shell tests PASS.

- [ ] **Step 3: Implement the flag**

In `src/server/server.js`, the PATCH handler: destructure the flag and run the install after the config persist succeeds:

```js
  app.patch('/api/local-shell', { preHandler: requireAuth }, async (req, reply) => {
    const { shell, claudeHooks } = req.body || {};
    if (!shell || !['none', 'omz', 'omb'].includes(shell)) {
      return reply.code(400).send({ error: 'invalid shell' });
    }
    try {
      if (localShellActions?.ensureReady) await localShellActions.ensureReady(shell);
    } catch (e) {
      const msg = e?.message || 'could not install local shell framework';
      return reply.code(400).send({ error: msg });
    }
    try {
      upsertConfigFile(config.configPath, { localShell: shell });
      config.localShell = shell;
    } catch (e) {
      return reply.code(500).send({ error: 'could not save config' });
    }
    // Opt-in Claude Code hook install on the host itself (spec 2026-08-02).
    // Strictly === true: absent/false touches nothing. A failed install is
    // reported, never promoted — the shell change above already persisted.
    if (claudeHooks === true && localShellActions?.installAgentHooks) {
      const agentHooks = await localShellActions.installAgentHooks();
      return { ok: true, agentHooks };
    }
    return { ok: true };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/server.test.js`
Expected: PASS (whole file — the handler change must not break any other route test).

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/server.test.js
git commit -m "feat(api): claudeHooks opt-in on PATCH /api/local-shell"
```

---

### Task 5: Client — dialog checkbox, sidebar badge, api layer

**Files:**
- Modify: `src/web/api.ts` (`updateLocalShell`, line 307)
- Modify: `src/web/main.ts` (`.local-shell` markup at ~line 916; `repaintAgentBadges()` at ~line 128; the local-shell dialog — find it by searching `localShellFramework`)
- Modify: `src/web/style.css` (only if the badge needs an alignment rule — see Step 3)

No unit tests: this is DOM-layer code, untested by design (vitest node environment). Verification is `npm run typecheck` + the full suite + live-app eyeballing at ship time.

**Interfaces:**
- Consumes: Task 4's response shape; `applyAgentBadge(badges: Element, id: string)` and `latestSeries` already in `main.ts`; series key `__local__` populated by Task 2.
- Produces: user-visible behavior only.

- [ ] **Step 1: api.ts**

Replace `updateLocalShell` (line 307) with:

```ts
  async updateLocalShell(shell: string, claudeHooks = false) {
    return j<{ ok: boolean; agentHooks?: { ok: boolean; skipped?: string; error?: string } }>(
      await fetch('/api/local-shell', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(claudeHooks ? { shell, claudeHooks: true } : { shell }),
      }),
    );
  },
```

(Existing callers pass one argument and keep working — the default preserves the old body shape byte-for-byte.)

- [ ] **Step 2: Sidebar badge span + repaint**

In the sidebar markup (~line 916), add a badges span between the name button and the reconnect button:

```html
<div class="local-shell">
  <span class="local-dot"></span>
  <button class="local-name" type="button">Host Shell</button>
  <span class="box-badges"></span>
  <button class="local-refresh" title="Reconnect" aria-label="Reconnect host shell">↻</button>
  <button class="local-edit" title="Configure shell" aria-label="Configure host shell">✎</button>
</div>
```

Extend `repaintAgentBadges()` (~line 128):

```ts
function repaintAgentBadges() {
  app.querySelectorAll('.box').forEach((li) => {
    const id = (li as HTMLElement).dataset.id;
    const badges = li.querySelector('.box-badges');
    if (id && badges) applyAgentBadge(badges, id);
  });
  // The Host Shell row is not a .box, but its badge reads the same series —
  // the __local__ pseudo-box the poller feeds to health history.
  const localBadges = app.querySelector('.local-shell .box-badges');
  if (localBadges) applyAgentBadge(localBadges, '__local__');
}
```

The pane-header chip needs **no change**: `paneHeaderModelFor` already reads `latestSeries[id]` and `id === '__local__'` for the host pane — confirm by opening the host shell pane during live validation.

- [ ] **Step 3: Style check**

Inspect the existing `.local-shell` and `.box-badges`/`.badge` rules in `src/web/style.css`. The row is a flex line; if the empty span disturbs spacing or the badge misaligns vertically, add the minimal rule (match neighboring spacing values used in the sidebar rather than inventing new ones):

```css
.local-shell .box-badges { display: inline-flex; align-items: center; }
```

If it renders fine without, add nothing. DESIGN.md is the visual authority — the badge itself reuses the existing `.badge` classes, so no new visual language is introduced.

- [ ] **Step 4: Dialog checkbox**

In the local-shell dialog (search `localShellFramework` in `main.ts`), after `shellGroup` is appended and before the `err` element, build the opt-in line:

```ts
  const hooksLine = document.createElement('label');
  hooksLine.className = 'hooks-optin';
  const hooksCheck = document.createElement('input');
  hooksCheck.type = 'checkbox';
  hooksLine.append(hooksCheck, document.createTextNode(' Install Claude Code hooks (agent badge + notifications for this host)'));
```

Before writing this, check how `setupOptions.ts` builds its checkbox lines and reuse that structure/class if one exists — consistency over the snippet above. The checkbox defaults to unchecked on every open (fire-on-save action, not persisted state).

Change `form.append(title, shellGroup, err, actions)` to `form.append(title, shellGroup, hooksLine, err, actions)`.

In the submit handler, replace the `api.updateLocalShell(selected)` call and success path:

```ts
      const res = await api.updateLocalShell(selected, hooksCheck.checked);
      if (res.agentHooks && !res.agentHooks.ok) {
        // The shell change saved; only the hook install needs attention.
        // Keep the dialog open so the message is actually seen.
        err.textContent = res.agentHooks.skipped
          ? `Shell saved; hooks skipped: ${res.agentHooks.skipped}`
          : `Shell saved; hook install failed: ${res.agentHooks.error || 'unknown error'}`;
        hooksCheck.checked = false;
        submit.disabled = false;
        return;
      }
      close();
```

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run typecheck`
Expected: clean.

Run: `npm test`
Expected: PASS — full suite, not just the new files (the boxes-tab lesson: fetch-layer changes need the whole suite).

- [ ] **Step 6: Commit**

```bash
git add src/web/api.ts src/web/main.ts src/web/style.css
git commit -m "feat(ui): host shell agent badge and Claude hooks opt-in in the shell dialog"
```

---

### Task 6: Docs

**Files:**
- Modify: `CLAUDE.md` (Architecture section) and `AGENTS.md` (same entries — the two are kept in sync)
- Modify: `docs/terminal.md` (host shell section), `docs/fleet-and-health.md` (agent notifications section)

**Interfaces:** none — prose only.

- [ ] **Step 1: CLAUDE.md / AGENTS.md**

Add a `localAgent.js` entry to the Architecture module list (alphabetically near `localShellActions.js`), covering: status-shaped local sample (tmux + marker read through `parseAgentMarks`), always-`up`/no-metrics so only agent edges can fire, `LOCAL_BOX_ID`. Extend the `statusPoller.js` entry with one sentence: the optional local sampler feeds a `__local__` pseudo-box (label `Host Shell`) into `history.record()` only — never `/api/status`. Extend the `localShellActions.js` entry: `installAgentHooks()` reuses `createAgentHooksPusher` over a local stdin transport; triggered by the `claudeHooks` flag on `PATCH /api/local-shell` (strict `=== true`, unchecked touches nothing, never uninstalls). Mirror all three edits into `AGENTS.md`.

- [ ] **Step 2: User docs**

`docs/terminal.md` host shell section: the ✎ dialog's "Install Claude Code hooks" checkbox — what it installs (the same agent-state hook boxes get, into this host's `~/.claude/`), that it requires Claude Code on the host and a claude restart to take effect, that only claude sessions inside the host shell's tmux session are tracked, and that the badge appears on the Host Shell button. `docs/fleet-and-health.md`: Host Shell appears in agent events/notifications with the same attach-suppression as boxes.

- [ ] **Step 3: Full suite, then commit**

Run: `npm test`
Expected: PASS.

```bash
git add CLAUDE.md AGENTS.md docs/terminal.md docs/fleet-and-health.md
git commit -m "docs: host shell agent hooks"
```

---

## Ship checklist reminder (not part of this plan's tasks)

Server-side change: live validation needs the **feature branch checked out** on the live app (systemd restart), not the rsync-dist recipe — client bundle AND server code both changed. Restart only when no setup/provision/lifecycle/fleet/voice-install job is running. After user validation on live: merge to main, then the standard release checklist in CLAUDE.md (version bump, build, restart, tag, release). To actually see the badge: tick the checkbox in the ✎ dialog, save, restart any claude running inside the host shell's tmux session, submit a prompt, and watch the Host Shell button and pane chip.
