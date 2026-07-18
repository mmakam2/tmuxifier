# Server-Side Box Setup Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the on-box setup script (tmux + shell frameworks + tool catalog) as a persisted, pollable, resumable server-side job so a WebSocket drop never aborts it, with an on-demand interactive fallback for boxes whose sudo needs a password.

**Architecture:** A new box-agnostic setup-job manager (`setupManager.js` + `setupStore.js`) mirrors the existing `proxmoxProvision.js`/`fleet.js` job pattern. It runs the generated script over the server's already-authenticated SSH ControlMaster via a new streaming `spawn('ssh')` helper (`sshStream`), streaming into a rolling persisted log. Both entry points (manual Add Box and Proxmox provision) start a job; the Proxmox provision manager auto-starts one on link. When a job hits the sudo-password stderr signature it becomes `needs-interactive`, and the client's existing `mode=provision` WebSocket PTY finishes it on demand.

**Tech Stack:** Node 20+ ESM, Fastify, node-pty (existing, unchanged), Vitest, Playwright, TypeScript + xterm.js client (Vite).

## Global Constraints

- ESM everywhere (`"type": "module"`); Node 20+. Server is plain `.js`; web client is `.ts`.
- Factory functions with dependencies injected as arguments (testable without mocks). Tests use **real code, not mocks**; inject fakes.
- TDD: write the failing test first; run it red; implement minimally; run green; commit.
- Conventional-commit messages (`feat(setup): …`, `test(setup): …`).
- All box fields reaching `ssh` go through `assertBoxSafe` (never shell-interpolated). Tool ids reaching the generated script are only ever the output of `resolveTools` (fail-closed on unknown ids).
- Persisted `data/*` files are written `0o600` via the shared `jsonFile.js` helpers.
- No real PII in committed code/tests — use `example.com`, RFC1918 IPs, `you@example.com`.
- Run `npm test` (typecheck + vitest) before each commit; it must pass.

**Job status values (canonical, used across tasks):** `running` | `done` | `error` | `needs-interactive` | `interrupted`.
**Job `phase` (only meaningful while `running`):** `waiting-ssh` | `running` | `null` otherwise.
**Options shape:** `{ ohMyTmux: boolean, ohMyZsh: boolean, ohMyBash: boolean, tools: string[] }` (tools = resolved ids).

---

## File Structure

**New files:**
- `src/server/sshRun.js` — MODIFY: add `sshStream` (streaming spawn primitive).
- `src/server/sshCommand.js` — MODIFY: add `buildSetupArgv` (non-interactive, BatchMode, no `-tt`).
- `src/server/setupStore.js` — CREATE: debounced `data/setup-jobs.json` persistence (mirror `provisionStore.js`).
- `src/server/setupManager.js` — CREATE: the setup-job manager.
- `src/server/server.js` — MODIFY: `POST/GET` setup routes; WS `mode=provision` handler calls `markInteractiveResult` and drops the rollback; DELETE box cancels a running setup job.
- `src/server/proxmoxProvision.js` — MODIFY: `createProvision` accepts `setupOptions`; `startSetup` hook fired on link.
- `src/server/index.js` — MODIFY: instantiate `setupStore` + `setupManager`; inject into `buildServer` and `createProvisionManager`.
- `src/web/api.ts` — MODIFY: `SetupOptions`/`SetupJob` types + `startSetup`/`getSetup`/`getBoxSetup`/`listSetups`.
- `src/web/setupStatus.ts` — CREATE: pure status-text/action helpers (tested).
- `src/web/main.ts` — MODIFY: rework `openProvisionPanel` into a poll-based setup viewer; box badge.
- `src/web/proxmoxUi.ts` — MODIFY: `showJob` transitions to polling the auto-started setup job.
- Tests: `test/sshRun.test.js`, `test/sshCommand.test.js` (extend), `test/setupStore.test.js`, `test/setupManager.test.js`, `test/setupRoutes.test.js`, `test/proxmoxProvision.test.js` (extend or create), `test/setupStatus.test.js`, `test/e2e/setup-server-side.spec.ts`.

---

## Task 1: `sshStream` streaming primitive

**Files:**
- Modify: `src/server/sshRun.js`
- Test: `test/sshRun.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `sshStream(argv, { env?, timeout?, onData?, cmd? }) → { done: Promise<{ code: number }>, kill(): void }`. `onData(chunk: string, stream: 'stdout'|'stderr')`. Timeout SIGKILLs and resolves `{ code: 124 }`. `cmd` defaults `'ssh'` (test seam).

- [ ] **Step 1: Write the failing tests**

Append to `test/sshRun.test.js` (it already imports `test, expect` and uses the `cmd: '/bin/sh'` seam):

```js
import { sshRun, sshRunStdin, sshStream } from '../src/server/sshRun.js';

test('sshStream streams stdout/stderr chunks and resolves the exit code', async () => {
  const chunks = [];
  const { done } = sshStream(['-c', 'echo hello; echo boom >&2; exit 0'], {
    cmd: '/bin/sh', onData: (c, s) => chunks.push([s, c]),
  });
  const { code } = await done;
  expect(code).toBe(0);
  const out = chunks.filter(([s]) => s === 'stdout').map(([, c]) => c).join('');
  const err = chunks.filter(([s]) => s === 'stderr').map(([, c]) => c).join('');
  expect(out).toContain('hello');
  expect(err).toContain('boom');
});

test('sshStream reports a non-zero exit code', async () => {
  const { done } = sshStream(['-c', 'exit 7'], { cmd: '/bin/sh' });
  expect((await done).code).toBe(7);
});

test('sshStream kills the child and resolves 124 on timeout', async () => {
  const { done } = sshStream(['-c', 'sleep 30'], { cmd: '/bin/sh', timeout: 300 });
  expect((await done).code).toBe(124);
});

test('sshStream kill() terminates the child', async () => {
  const h = sshStream(['-c', 'sleep 30'], { cmd: '/bin/sh' });
  h.kill();
  expect((await h.done).code).not.toBe(0);
});
```

Note: change the existing top `import { sshRunStdin } from ...` line to the combined import above (or add `sshStream` to it). If `sshRun`/`sshRunStdin` were imported separately, keep them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/sshRun.test.js`
Expected: FAIL — `sshStream is not a function` (or import error).

- [ ] **Step 3: Implement `sshStream`**

Append to `src/server/sshRun.js` (module already imports `spawn` from `node:child_process`):

```js
// Streaming ssh: spawn a non-interactive ssh (or `cmd` in tests) and forward
// stdout/stderr chunks to onData as they arrive, instead of buffering to
// completion like sshRun. Used by the setup-job manager to stream a long
// install script into a persisted log. stdin is closed (BatchMode never
// prompts). Returns a handle: `done` resolves { code } on exit; a timeout
// SIGKILLs and resolves 124 (shell timeout convention); `kill()` force-stops.
export function sshStream(argv, { env = process.env, timeout = 600000, onData, cmd = 'ssh' } = {}) {
  const child = spawn(cmd, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let done = false;
  let resolveDone;
  const donePromise = new Promise((r) => { resolveDone = r; });
  const finish = (code) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolveDone({ code });
  };
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(124); }, timeout);
  child.stdout.on('data', (d) => { if (onData) onData(d.toString(), 'stdout'); });
  child.stderr.on('data', (d) => { if (onData) onData(d.toString(), 'stderr'); });
  child.on('error', () => finish(1));
  child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
  return { done: donePromise, kill: () => { try { child.kill('SIGKILL'); } catch {} } };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/sshRun.test.js`
Expected: PASS (all sshStream tests + existing sshRunStdin tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/sshRun.js test/sshRun.test.js
git commit -m "feat(ssh): add sshStream streaming spawn primitive"
```

---

## Task 2: `buildSetupArgv` (non-interactive setup argv)

**Files:**
- Modify: `src/server/sshCommand.js`
- Test: `test/sshCommand.test.js`

**Interfaces:**
- Consumes: existing `buildProbeArgv` (BatchMode, no `-tt`, ControlMaster args, `assertBoxSafe`).
- Produces: `buildSetupArgv(box, script, opts?) → string[]` (script is the final argv element).

- [ ] **Step 1: Write the failing tests**

Append to `test/sshCommand.test.js` (add `buildSetupArgv` to its existing import from `../src/server/sshCommand.js`):

```js
test('buildSetupArgv is non-interactive: BatchMode on, no -tt, script last', () => {
  const argv = buildSetupArgv({ host: 'prod' }, 'echo hi');
  expect(argv).not.toContain('-tt');
  expect(argv).toContain('BatchMode=yes');
  expect(argv[argv.length - 1]).toBe('echo hi');
  expect(argv[argv.length - 2]).toBe('prod');
});

test('buildSetupArgv validates box fields (command-injection guard)', () => {
  expect(() => buildSetupArgv({ host: '-oProxyCommand=evil' }, 'x')).toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/sshCommand.test.js`
Expected: FAIL — `buildSetupArgv is not a function`.

- [ ] **Step 3: Implement `buildSetupArgv`**

Add to `src/server/sshCommand.js`, immediately after `buildProbeArgv`:

```js
// Non-interactive box setup: identical connection profile to a probe
// (BatchMode, no PTY, ControlMaster multiplexing) with the generated setup
// script as the remote command. Kept as its own named export so the setup
// manager's command-injection surface is explicit and independently testable.
export function buildSetupArgv(box, script, opts = {}) {
  return buildProbeArgv(box, script, opts);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/sshCommand.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/sshCommand.js test/sshCommand.test.js
git commit -m "feat(ssh): add buildSetupArgv non-interactive setup argv"
```

---

## Task 3: `setupStore` persistence

**Files:**
- Create: `src/server/setupStore.js`
- Test: `test/setupStore.test.js`

**Interfaces:**
- Consumes: `jsonFile.js` (`readJsonSync`, `writeFileAtomic`).
- Produces: `createSetupStore({ dataDir }) → { load(), save(jobs), whenIdle() }` over `data/setup-jobs.json`.

- [ ] **Step 1: Write the failing tests**

Create `test/setupStore.test.js` (mirrors `test/provisionStore.test.js`):

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSetupStore } from '../src/server/setupStore.js';

let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-setup-')); });

test('load returns [] when the file is absent', () => {
  expect(createSetupStore({ dataDir: dir }).load()).toEqual([]);
});

test('save then load round-trips through the file', async () => {
  const store = createSetupStore({ dataDir: dir });
  store.save([{ id: 'j1', status: 'done' }]);
  await store.whenIdle();
  expect(createSetupStore({ dataDir: dir }).load()).toEqual([{ id: 'j1', status: 'done' }]);
});

test('a corrupt file loads as [] and is quarantined', async () => {
  await fs.writeFile(path.join(dir, 'setup-jobs.json'), 'not json');
  const store = createSetupStore({ dataDir: dir });
  expect(store.load()).toEqual([]);
  store.save([{ id: 'j2' }]);
  await store.whenIdle();
  const q = (await fs.readdir(dir)).filter((n) => n.startsWith('setup-jobs.json.corrupt-'));
  expect(q).toHaveLength(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/setupStore.test.js`
Expected: FAIL — cannot find `../src/server/setupStore.js`.

- [ ] **Step 3: Implement `setupStore`**

Create `src/server/setupStore.js` — a copy of `provisionStore.js` with the filename changed:

```js
import path from 'node:path';
import { readJsonSync, writeFileAtomic } from './jsonFile.js';

export function createSetupStore({ dataDir }) {
  const file = path.join(dataDir, 'setup-jobs.json');
  let pending = null;
  let flushing = false;
  let idleResolvers = [];
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (pending !== null) {
        const data = pending; pending = null;
        await writeFileAtomic(file, data);
      }
    } catch {
      // best effort: persistence must never crash a setup run
    } finally {
      flushing = false;
      const resolvers = idleResolvers; idleResolvers = [];
      for (const r of resolvers) r();
    }
  }
  return {
    load() {
      return readJsonSync(file, { fallback: [], validate: Array.isArray });
    },
    save(jobs) {
      try { pending = JSON.stringify(jobs, null, 2); } catch { return; }
      void flush();
    },
    whenIdle() {
      if (!flushing && pending === null) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/setupStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/setupStore.js test/setupStore.test.js
git commit -m "feat(setup): add setupStore persistence for data/setup-jobs.json"
```

---

## Task 4: `setupManager` job manager

**Files:**
- Create: `src/server/setupManager.js`
- Test: `test/setupManager.test.js`

**Interfaces:**
- Consumes: `sshStream` (Task 1), `buildSetupArgv` (Task 2), `buildEnsureTmuxRemote` (existing, `boxActions.js`), `setupStore.load/save` (Task 3).
- Produces:
  - `createSetupManager({ sshStream, buildSetupArgv, buildScript?, probe?, load, save, hostKeyPolicy?, sshConfigFile?, controlDir?, controlPersist?, now?, makeId?, sleep?, maxJobs?, maxLogBytes?, taskTimeoutMs?, readyAttempts?, readyDelayMs? })`
  - returns `{ start(box, options, { waitForSsh? }) → summary, getJob(id) → job|undefined, listJobs() → summary[], currentForBox(boxId) → job|null, markInteractiveResult(boxId, code) → void, cancelForBox(boxId) → void, _settled(id) → Promise }`
  - **summary** = job without `log`; **job** = `{ id, boxId, boxLabel, status, phase, options, log, error, createdAt, finishedAt }`.

- [ ] **Step 1: Write the failing tests**

Create `test/setupManager.test.js`:

```js
import { test, expect } from 'vitest';
import { createSetupManager } from '../src/server/setupManager.js';

const BOX = { id: 'b1', label: 'web-1', host: '192.168.1.10', user: 'root', sessionName: 'web' };

// Fake sshStream: drives onData with the planned chunks, then resolves the code.
// A pending plan (no code) never resolves — used for dedupe/cancel tests.
function fakeSsh(plan) {
  const calls = [];
  const fn = (argv, { onData } = {}) => {
    calls.push(argv);
    let killed = false;
    const done = plan.pending
      ? new Promise(() => {})
      : (async () => {
          for (const [stream, chunk] of (plan.chunks || [])) onData?.(chunk, stream);
          return { code: killed ? 137 : plan.code };
        })();
    return { done, kill: () => { killed = true; }, _killed: () => killed };
  };
  fn.calls = calls;
  return fn;
}

function make(overrides = {}) {
  let seq = 0;
  const saved = [];
  return createSetupManager({
    sshStream: fakeSsh({ chunks: [['stdout', 'ok\n']], code: 0 }),
    buildSetupArgv: () => ['argv'],
    buildScript: () => 'SCRIPT',
    load: () => [],
    save: (jobs) => saved.push(jobs),
    now: () => '2026-07-18T00:00:00.000Z',
    makeId: () => `job-${++seq}`,
    sleep: async () => {},
    _saved: saved,
    ...overrides,
  });
}

test('happy path: streams to log and finishes done', async () => {
  const m = make();
  const s = m.start(BOX, { ohMyTmux: true, tools: [] });
  expect(s.status).toBe('running');
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(job.log).toContain('ok');
  expect(job.finishedAt).toBeTruthy();
});

test('sudo-password stderr -> needs-interactive', async () => {
  const m = make({ sshStream: (function () {
    const p = { chunks: [['stderr', 'sudo: a terminal is required to read the password; see below\n']], code: 1 };
    return require('../src/server/setupManager.js') && ((argv, { onData }) => {
      onData?.(p.chunks[0][1], 'stderr');
      return { done: Promise.resolve({ code: 1 }), kill() {} };
    });
  })() });
  const s = m.start(BOX, { tools: [] });
  await m._settled(s.id);
  expect(m.getJob(s.id).status).toBe('needs-interactive');
});

test('hard non-zero exit -> error (box never touched by manager)', async () => {
  const m = make({ sshStream: (argv, { onData }) => { onData?.('nope\n', 'stderr'); return { done: Promise.resolve({ code: 2 }), kill() {} }; } });
  const s = m.start(BOX, { tools: [] });
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('error');
  expect(job.error).toContain('2');
});

test('timeout code 124 -> error with timeout note', async () => {
  const m = make({ sshStream: () => ({ done: Promise.resolve({ code: 124 }), kill() {} }) });
  const s = m.start(BOX, { tools: [] });
  await m._settled(s.id);
  expect(m.getJob(s.id).error).toMatch(/tim(e|ed) out/i);
});

test('waitForSsh probes until ready, then runs', async () => {
  let n = 0;
  const probe = async () => (++n >= 3);
  const m = make({ probe });
  const s = m.start(BOX, { tools: [] }, { waitForSsh: true });
  await m._settled(s.id);
  expect(n).toBeGreaterThanOrEqual(3);
  expect(m.getJob(s.id).status).toBe('done');
});

test('one active job per box: second start returns the running job', async () => {
  const m = make({ sshStream: fakeSsh({ pending: true }) });
  const a = m.start(BOX, { tools: [] });
  const b = m.start(BOX, { tools: [] });
  expect(b.id).toBe(a.id);
});

test('markInteractiveResult(0) -> done; non-zero leaves needs-interactive', async () => {
  const m = make({ sshStream: (argv, { onData }) => { onData?.('sudo: a password is required\n', 'stderr'); return { done: Promise.resolve({ code: 1 }), kill() {} }; } });
  const s = m.start(BOX, { tools: [] });
  await m._settled(s.id);
  expect(m.getJob(s.id).status).toBe('needs-interactive');
  m.markInteractiveResult(BOX.id, 1);
  expect(m.getJob(s.id).status).toBe('needs-interactive');
  m.markInteractiveResult(BOX.id, 0);
  expect(m.getJob(s.id).status).toBe('done');
});

test('reconciles a running job to interrupted on load', () => {
  const m = make({ load: () => [{ id: 'old', boxId: 'b9', status: 'running', phase: 'running', createdAt: '2026-01-01T00:00:00.000Z', log: '' }] });
  expect(m.getJob('old').status).toBe('interrupted');
});

test('persists at most maxJobs newest jobs', async () => {
  const saved = [];
  const m = make({ maxJobs: 2, save: (j) => saved.push(j), _saved: saved });
  m.start({ ...BOX, id: 'x1' }, { tools: [] });
  m.start({ ...BOX, id: 'x2' }, { tools: [] });
  m.start({ ...BOX, id: 'x3' }, { tools: [] });
  const last = saved[saved.length - 1];
  expect(last.length).toBeLessThanOrEqual(2);
});
```

> Note: the second test's inline `require` trick is ugly — prefer defining a small local `sudoSsh` factory. Replace it with:
> ```js
> const sudoSsh = (phrase, code) => (argv, { onData }) => { onData?.(phrase, 'stderr'); return { done: Promise.resolve({ code }), kill() {} }; };
> ```
> and use `make({ sshStream: sudoSsh('sudo: a terminal is required to read the password\n', 1) })`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/setupManager.test.js`
Expected: FAIL — cannot find `../src/server/setupManager.js`.

- [ ] **Step 3: Implement `setupManager`**

Create `src/server/setupManager.js`:

```js
import { randomUUID } from 'node:crypto';
import { buildEnsureTmuxRemote } from './boxActions.js';

// Statuses that will not resume on their own. `needs-interactive` is stable
// across restarts (a paused, user-actionable state — no live process), so it is
// NOT reconciled. Only `running` (a live ssh child that died with the process)
// is converted to `interrupted` on load.
const SUDO_PW_RE = /a terminal is required to read the password|sudo:[^\n]*password is required|askpass/i;

export function createSetupManager({
  sshStream,
  buildSetupArgv,
  buildScript = (box, options) => buildEnsureTmuxRemote(box.sessionName, box.startupCommand, {
    installOhMyTmux: !!options.ohMyTmux,
    installOhMyZsh: !!options.ohMyZsh,
    installOhMyBash: !!options.ohMyBash,
    tools: options.tools || [],
  }),
  probe = async () => true,
  load, save,
  hostKeyPolicy = 'accept-new', sshConfigFile, controlDir, controlPersist,
  now = () => new Date().toISOString(),
  makeId = randomUUID,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxJobs = 50, maxLogBytes = 65536, taskTimeoutMs = 600000,
  readyAttempts = 10, readyDelayMs = 3000,
}) {
  const jobs = new Map();
  const runningHandles = new Map(); // jobId -> ssh handle
  const settles = new Map();        // jobId -> run promise (test seam)

  for (const j of load() || []) {
    if (j.status === 'running') { j.status = 'interrupted'; j.phase = null; j.finishedAt = j.finishedAt || now(); }
    jobs.set(j.id, j);
  }
  persist();

  function ordered() { return [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); }
  function persist() { save(ordered().slice(0, maxJobs)); prune(); }
  function prune() {
    const keep = new Set(ordered().slice(0, maxJobs).map((j) => j.id));
    for (const id of [...jobs.keys()]) if (!keep.has(id)) jobs.delete(id);
  }
  function summary(j) {
    return { id: j.id, boxId: j.boxId, boxLabel: j.boxLabel, status: j.status, phase: j.phase, options: j.options, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt };
  }
  function appendLog(j, text) { if (text) j.log = (j.log + text).slice(-maxLogBytes); }
  function normalizeOptions(o = {}) {
    return { ohMyTmux: !!o.ohMyTmux, ohMyZsh: !!o.ohMyZsh, ohMyBash: !!o.ohMyBash, tools: Array.isArray(o.tools) ? o.tools : [] };
  }
  function currentForBox(boxId) { return ordered().find((j) => j.boxId === boxId) || null; }

  function finish(j, status) {
    j.status = status;
    j.phase = null;
    if (status !== 'needs-interactive') j.finishedAt = now();
    persist();
  }

  async function run(j, box, { waitForSsh }) {
    try {
      if (waitForSsh) {
        j.phase = 'waiting-ssh'; persist();
        let ready = false;
        for (let i = 0; i < readyAttempts && !ready; i++) {
          try { ready = await probe(box); } catch { ready = false; }
          if (!ready) await sleep(readyDelayMs);
        }
        // Proceed regardless — the script run is the definitive attempt.
      }
      j.phase = 'running'; persist();

      const script = buildScript(box, j.options);
      const argv = buildSetupArgv(box, script, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
      let sawSudoPw = false;
      const handle = sshStream(argv, {
        timeout: taskTimeoutMs,
        onData: (chunk, stream) => {
          appendLog(j, chunk);
          if (stream === 'stderr' && !sawSudoPw && SUDO_PW_RE.test(j.log)) sawSudoPw = true;
          persist();
        },
      });
      runningHandles.set(j.id, handle);
      const { code } = await handle.done;
      runningHandles.delete(j.id);

      if (code === 0) finish(j, 'done');
      else if (sawSudoPw) finish(j, 'needs-interactive');
      else if (code === 124) { j.error = 'setup timed out'; finish(j, 'error'); }
      else { j.error = `setup exited ${code}`; finish(j, 'error'); }
    } catch (e) {
      runningHandles.delete(j.id);
      j.error = e?.message || 'setup error';
      finish(j, 'error');
    }
  }

  function start(box, options, { waitForSsh = false } = {}) {
    const existing = currentForBox(box.id);
    if (existing && existing.status === 'running') return summary(existing);
    const j = {
      id: makeId(), boxId: box.id, boxLabel: box.label,
      status: 'running', phase: waitForSsh ? 'waiting-ssh' : 'running',
      options: normalizeOptions(options), log: '', error: null,
      createdAt: now(), finishedAt: null,
    };
    jobs.set(j.id, j);
    persist();
    const p = run(j, box, { waitForSsh });
    settles.set(j.id, p);
    return summary(j);
  }

  function markInteractiveResult(boxId, code) {
    const j = currentForBox(boxId);
    if (!j || j.status !== 'needs-interactive') return;
    if (code === 0) { j.status = 'done'; j.finishedAt = now(); persist(); }
    // non-zero: cancelled or still-failing — stays needs-interactive (retryable).
  }

  function cancelForBox(boxId) {
    const j = currentForBox(boxId);
    if (j && runningHandles.has(j.id)) { try { runningHandles.get(j.id).kill(); } catch {} }
  }

  return {
    start, markInteractiveResult, cancelForBox, currentForBox,
    getJob(id) { return jobs.get(id); },
    listJobs() { return ordered().map(summary); },
    _settled(id) { return settles.get(id) || Promise.resolve(); },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/setupManager.test.js`
Expected: PASS (apply the `sudoSsh` cleanup noted in Step 1 before running).

- [ ] **Step 5: Commit**

```bash
git add src/server/setupManager.js test/setupManager.test.js
git commit -m "feat(setup): add setupManager server-side job manager"
```

---

## Task 5: Setup routes + interactive-fallback WS wiring

**Files:**
- Modify: `src/server/server.js` (routes near the provision routes ~`430`; WS `mode=provision` handler ~`745-767`; DELETE box ~`252`; `buildServer` signature ~`61`)
- Test: `test/setupRoutes.test.js`

**Interfaces:**
- Consumes: `setupManager` (Task 4), existing `resolveTools` (already imported in `server.js:10`).
- Produces: routes `POST /api/boxes/:id/setup`, `GET /api/setup/:id`, `GET /api/boxes/:id/setup`, `GET /api/setup`; `buildServer({ …, setupManager })`.

- [ ] **Step 1: Write the failing tests**

Create `test/setupRoutes.test.js`. This mirrors `test/netboxRoutes.test.js` verbatim for auth/config/cookie (the `headers()` helper logs in and reads the `tmuxifier_session` cookie; `buildServer` tolerates omitted deps — only the routes under test need their deps):

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { hashPassword } from '../src/server/auth.js';

const BOX = { id: 'b1', label: 'web', host: '192.168.1.10', user: 'root', sessionName: 'web', source: 'manual', tags: [] };

function fakeSetupManager() {
  const jobs = new Map();
  return {
    _started: [],
    start(box, options) {
      this._started.push({ box, options });
      const j = { id: 'j1', boxId: box.id, boxLabel: box.label, status: 'running', phase: 'running', options, log: '', error: null, createdAt: 'now', finishedAt: null };
      jobs.set(j.id, j);
      const { log, ...s } = j; return s;
    },
    getJob(id) { return jobs.get(id); },
    currentForBox(boxId) { return [...jobs.values()].find((j) => j.boxId === boxId) || null; },
    listJobs() { return [...jobs.values()].map(({ log, ...s }) => s); },
    markInteractiveResult() {}, cancelForBox() {},
  };
}

let app, sm;
beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-setupr-'));
  sm = fakeSetupManager();
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const store = { getBox: async (id) => (id === BOX.id ? BOX : null), removeBox: async () => {} };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }) };
  app = buildServer({ config, store, sessions, statusChecker, setupManager: sm });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('POST /api/boxes/:id/setup starts a job (201) with resolved tools', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/b1/setup', headers: h, payload: { ohMyTmux: true, tools: 'git,curl' } });
  expect(res.statusCode).toBe(201);
  expect(sm._started[0].options.ohMyTmux).toBe(true);
  expect(sm._started[0].options.tools).toEqual(expect.arrayContaining(['git', 'curl']));
});

test('POST rejects unknown tool ids with 400', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/b1/setup', headers: h, payload: { tools: 'not-a-real-tool' } });
  expect(res.statusCode).toBe(400);
});

test('POST 404 for an unknown box', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nope/setup', headers: h, payload: { tools: '' } });
  expect(res.statusCode).toBe(404);
});

test('GET /api/boxes/:id/setup returns 204 when no job, then the job', async () => {
  const h = await headers();
  let res = await app.inject({ method: 'GET', url: '/api/boxes/b1/setup', headers: h });
  expect(res.statusCode).toBe(204);
  await app.inject({ method: 'POST', url: '/api/boxes/b1/setup', headers: h, payload: { tools: '' } });
  res = await app.inject({ method: 'GET', url: '/api/boxes/b1/setup', headers: h });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body).boxId).toBe('b1');
});

test('setup routes require auth', async () => {
  expect((await app.inject({ method: 'GET', url: '/api/setup' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/boxes/b1/setup', payload: {} })).statusCode).toBe(401);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/setupRoutes.test.js`
Expected: FAIL — routes 404 / `setupManager` undefined.

- [ ] **Step 3: Add `setupManager` to the `buildServer` signature**

In `src/server/server.js:61`, add `setupManager` to the destructured params (end of the list, before the closing `}`):

```js
… saveUploadLocally = saveLocalUpload, injectLocalUpload = injectLocalUploadPath, knownHosts, setupManager }) {
```

- [ ] **Step 4: Add the setup routes**

In `src/server/server.js`, next to the provision routes (after the `GET /api/proxmox/provisions/:id` block ~line 437), add:

```js
  // --- Box setup jobs (server-side, resumable) ---
  app.post('/api/boxes/:id/setup', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'unknown box' });
    const b = req.body || {};
    let tools;
    try { tools = resolveTools(Array.isArray(b.tools) ? b.tools.join(',') : (typeof b.tools === 'string' ? b.tools : '')); }
    catch { return reply.code(400).send({ error: 'invalid tools' }); }
    const options = { ohMyTmux: !!b.ohMyTmux, ohMyZsh: !!b.ohMyZsh, ohMyBash: !!b.ohMyBash, tools };
    return reply.code(201).send(setupManager.start(box, options));
  });
  app.get('/api/setup', { preHandler: requireAuth }, async () => setupManager.listJobs());
  app.get('/api/setup/:id', { preHandler: requireAuth }, async (req, reply) => {
    const job = setupManager.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'setup job not found' });
    return job;
  });
  app.get('/api/boxes/:id/setup', { preHandler: requireAuth }, async (req, reply) => {
    const job = setupManager.currentForBox(req.params.id);
    if (!job) return reply.code(204).send();
    return job;
  });
```

- [ ] **Step 5: Update the WS `mode=provision` exit handler (interactive fallback coherence + drop rollback)**

In `src/server/server.js`, in the provision-mode `offExit` handler (~745-758), replace the rollback block:

```js
        const offExit = sessions.onExit(entry, () => {
          const code = entry.exitCode != null ? entry.exitCode : 1;
          try {
            if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'x', code }));
          } catch {}
          if (code !== 0 && box.source !== 'proxmox') {
            store.removeBox(boxId).catch(() => {});
          }
          try { socket.close(1000); } catch {}
        });
```

with:

```js
        const offExit = sessions.onExit(entry, () => {
          const code = entry.exitCode != null ? entry.exitCode : 1;
          try {
            if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'x', code }));
          } catch {}
          // The interactive PTY is the setup job's manual-finish path. Report the
          // outcome to the manager (0 -> done; non-zero leaves needs-interactive).
          // No auto-rollback: a failed setup keeps the box (Retry / Remove in the UI).
          try { setupManager?.markInteractiveResult(boxId, code); } catch {}
          try { socket.close(1000); } catch {}
        });
```

- [ ] **Step 6: Cancel a running setup job when its box is deleted**

In `src/server/server.js` DELETE box route (~252-258), add the cancel before removal:

```js
  app.delete('/api/boxes/:id', { preHandler: requireAuth }, async (req, reply) => {
    try { setupManager?.cancelForBox(req.params.id); } catch {}
    // …existing body unchanged (removeBox or store.removeBox)…
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/setupRoutes.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/server.js test/setupRoutes.test.js
git commit -m "feat(setup): setup job routes + interactive-fallback WS coherence"
```

---

## Task 6: Auto-start setup on Proxmox link + final server wiring

**Files:**
- Modify: `src/server/proxmoxProvision.js` (createProvision ~187; link section ~145)
- Modify: `src/server/index.js` (instantiate setup store/manager; inject into `buildServer` + `createProvisionManager`)
- Test: `test/proxmoxProvision.test.js` (create if absent; otherwise extend)

**Interfaces:**
- Consumes: `setupManager.start` (Task 4).
- Produces: `createProvisionManager({ …, startSetup })` calls `startSetup(box, setupOptions, { waitForSsh: true })` after link; `createProvision({ …, setupOptions })` stores it on the job.

- [ ] **Step 1: Write the failing test**

`test/proxmoxProvision.test.js` already exists with a reusable harness at the top of the file: `base(over)`, `makeStore(preset)`, `fakeBoxStore()`, `okClient()`, and `PRESET_STATIC`. **Append** these two tests (they reuse those helpers verbatim — no new fakes):

```js
test('startSetup is fired on link with the linked box and stored setupOptions', async () => {
  const started = [];
  const boxStore = fakeBoxStore();
  const mgr = createProvisionManager(base({
    proxmoxStore: makeStore(PRESET_STATIC),
    boxStore,
    makeClient: () => okClient(),
    startSetup: (box, options, opts) => started.push({ box, options, opts }),
  }));
  const job = await mgr.createProvision({ presetId: 'p2', hostname: 'dev-01', setupOptions: { ohMyTmux: true, tools: ['git'] } });
  await mgr._settled(job.id);
  expect(started).toHaveLength(1);
  expect(started[0].box).toBe(boxStore.added[0]);         // the just-linked box
  expect(started[0].options).toEqual({ ohMyTmux: true, tools: ['git'] });
  expect(started[0].opts).toEqual({ waitForSsh: true });
});

test('no setupOptions -> startSetup is not called', async () => {
  const started = [];
  const mgr = createProvisionManager(base({
    proxmoxStore: makeStore(PRESET_STATIC), boxStore: fakeBoxStore(),
    makeClient: () => okClient(), startSetup: () => started.push(1),
  }));
  await mgr._settled((await mgr.createProvision({ presetId: 'p2', hostname: 'dev-01' })).id);
  expect(started).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/proxmoxProvision.test.js`
Expected: FAIL — `startSetup` never called (not yet wired).

- [ ] **Step 3: Thread `setupOptions` + `startSetup` through the provision manager**

In `src/server/proxmoxProvision.js`:

a) Add `startSetup = null` to the `createProvisionManager` destructured params (near line 12-16).

b) In `createProvision` (~187), carry the options onto the job. Add `setupOptions` to the input destructure and to the job object:

```js
    createProvision({ presetId, hostname, vmid, ip, tags, setupOptions = null }) {
```
and in the `const j = { … }` literal add:
```js
        setupOptions: setupOptions || null,
```

c) In the `run` function link section (~145), right after `j.boxId = box.id;`, fire the hook:

```js
        j.boxId = box.id;
        if (startSetup && j.setupOptions) {
          // Server-side, durable setup: survives the browser closing during
          // either phase. waitForSsh: the container was just started, so sshd
          // may not accept the injected key yet.
          try { startSetup(box, j.setupOptions, { waitForSsh: true }); } catch {}
        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/proxmoxProvision.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the manager in `index.js`**

In `src/server/index.js`:

a) Add imports near the other store/manager imports (~22-23):

```js
import { createSetupStore } from './setupStore.js';
import { createSetupManager } from './setupManager.js';
import { sshStream } from './sshRun.js';           // add sshStream to the existing sshRun import instead
import { buildSetupArgv } from './sshCommand.js';  // add to existing sshCommand import if present
```
(Prefer extending the existing `import { sshRun, sshRunStdin } from './sshRun.js';` to include `sshStream`, and add `buildSetupArgv` to any existing `sshCommand.js` import.)

b) After `const boxActions = createBoxActions({ … })` (~54), instantiate the manager:

```js
const setupStore = createSetupStore({ dataDir: config.dataDir });
const setupManager = createSetupManager({
  sshStream: (argv, opts) => sshStream(argv, opts),
  buildSetupArgv,
  probe: (box) => boxActions.execCommand(box, 'true', { timeoutMs: 6000 }).then((r) => r.code === 0).catch(() => false),
  load: () => setupStore.load(),
  save: (jobs) => setupStore.save(jobs),
  hostKeyPolicy: config.hostKeyPolicy,
  sshConfigFile: config.sshConfigFile,
  controlDir: config.controlDir,
  controlPersist: config.controlPersist,
});
```

c) Add `startSetup` to the `createProvisionManager({ … })` call (~101):

```js
  startSetup: (box, options, opts) => setupManager.start(box, options, opts),
```

d) Add `setupManager` to the `buildServer({ … })` call (~177):

```js
const app = buildServer({ …, knownHosts, setupManager });
```

- [ ] **Step 6: Verify the whole server suite + typecheck still pass**

Run: `npm test`
Expected: PASS (typecheck + full vitest). This is the smoke check for the `index.js` glue (no unit test — it is wiring).

- [ ] **Step 7: Commit**

```bash
git add src/server/proxmoxProvision.js src/server/index.js test/proxmoxProvision.test.js
git commit -m "feat(setup): auto-start setup job on Proxmox link; wire setupManager"
```

---

## Task 7: Client API layer

**Files:**
- Modify: `src/web/api.ts`

**Interfaces:**
- Produces: `SetupOptions`, `SetupStatus`, `SetupJob`, `SetupSummary` types; `api.startSetup`, `api.getSetup`, `api.getBoxSetup`, `api.listSetups`.

- [ ] **Step 1: Add types + methods**

In `src/web/api.ts`, add the types (near the other job types) and methods (inside the `api` object, next to the proxmox/provision methods). Match the existing `fetch`/`jr` helper style already in the file:

```ts
export type SetupStatus = 'running' | 'done' | 'error' | 'needs-interactive' | 'interrupted';
export interface SetupOptions { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; }
export interface SetupSummary {
  id: string; boxId: string; boxLabel: string; status: SetupStatus;
  phase: 'waiting-ssh' | 'running' | null; options: SetupOptions; error: string | null;
  createdAt: string; finishedAt: string | null;
}
export interface SetupJob extends SetupSummary { log: string; }
```

Add to the `api` object (use the same request helpers already used by neighboring methods — e.g. `post(...)`, `jr(fetch(...))`):

```ts
  startSetup(boxId: string, options: SetupOptions) {
    return jr<SetupSummary>(fetch(`/api/boxes/${boxId}/setup`, post(options)));
  },
  getSetup(id: string) { return jr<SetupJob>(fetch(`/api/setup/${id}?t=${Date.now()}`)); },
  async getBoxSetup(boxId: string): Promise<SetupJob | null> {
    const res = await fetch(`/api/boxes/${boxId}/setup?t=${Date.now()}`);
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`setup lookup failed (${res.status})`);
    return res.json() as Promise<SetupJob>;
  },
  listSetups() { return jr<SetupSummary[]>(fetch('/api/setup')); },
```

> Open `src/web/api.ts` first and match the exact names of its request helpers (`post`, `jr`, etc.) — the snippets above assume the same helpers `provisions()`/`createProvision()` use.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web/api.ts
git commit -m "feat(setup): client api for setup jobs"
```

---

## Task 8: Pure setup-status helpers + poll-based setup viewer

**Files:**
- Create: `src/web/setupStatus.ts`
- Test: `test/setupStatus.test.js`
- Modify: `src/web/main.ts` (`openProvisionPanel` ~956-1016; box card badge)

**Interfaces:**
- Produces: `setupStatusText(job) → string`, `setupActions(status) → Array<'finish-interactive'|'retry'|'remove'|'close'>`, `setupBadge(status) → { text: string; cls: string } | null`.

- [ ] **Step 1: Write the failing test for the pure helpers**

Create `test/setupStatus.test.js`:

```js
import { test, expect } from 'vitest';
import { setupStatusText, setupActions, setupBadge } from '../src/web/setupStatus.ts';

test('status text covers each state', () => {
  expect(setupStatusText({ status: 'running', phase: 'waiting-ssh' })).toMatch(/waiting/i);
  expect(setupStatusText({ status: 'running', phase: 'running' })).toMatch(/running/i);
  expect(setupStatusText({ status: 'done' })).toMatch(/complete|✓/i);
  expect(setupStatusText({ status: 'error', error: 'apt failed' })).toMatch(/apt failed/);
  expect(setupStatusText({ status: 'needs-interactive' })).toMatch(/sudo/i);
  expect(setupStatusText({ status: 'interrupted' })).toMatch(/interrupted/i);
});

test('actions per state', () => {
  expect(setupActions('running')).toEqual(['close']);
  expect(setupActions('done')).toEqual(['close']);
  expect(setupActions('error')).toEqual(['retry', 'remove', 'close']);
  expect(setupActions('needs-interactive')).toEqual(['finish-interactive', 'remove', 'close']);
  expect(setupActions('interrupted')).toEqual(['retry', 'remove', 'close']);
});

test('badge is null for terminal-done and present otherwise', () => {
  expect(setupBadge('done')).toBeNull();
  expect(setupBadge('running')).not.toBeNull();
  expect(setupBadge('needs-interactive')?.cls).toContain('warn');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/setupStatus.test.js`
Expected: FAIL — cannot find `src/web/setupStatus.ts`.

- [ ] **Step 3: Implement the pure helpers**

Create `src/web/setupStatus.ts`:

```ts
import type { SetupJob, SetupStatus } from './api';

export function setupStatusText(job: Pick<SetupJob, 'status' | 'phase' | 'error'>): string {
  switch (job.status) {
    case 'running': return job.phase === 'waiting-ssh' ? 'Waiting for SSH…' : 'Running setup…';
    case 'done': return 'Setup complete ✓';
    case 'error': return `Setup failed${job.error ? ` — ${job.error}` : ''}`;
    case 'needs-interactive': return 'Needs sudo password — finish interactively';
    case 'interrupted': return 'Setup interrupted (server restarted) — retry';
    default: return String(job.status);
  }
}

export type SetupAction = 'finish-interactive' | 'retry' | 'remove' | 'close';
export function setupActions(status: SetupStatus): SetupAction[] {
  switch (status) {
    case 'running':
    case 'done': return ['close'];
    case 'needs-interactive': return ['finish-interactive', 'remove', 'close'];
    case 'error':
    case 'interrupted': return ['retry', 'remove', 'close'];
    default: return ['close'];
  }
}

export function setupBadge(status: SetupStatus): { text: string; cls: string } | null {
  switch (status) {
    case 'running': return { text: 'setting up', cls: 'badge-info' };
    case 'error':
    case 'interrupted': return { text: 'setup failed', cls: 'badge-warn' };
    case 'needs-interactive': return { text: 'needs sudo', cls: 'badge-warn' };
    default: return null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/setupStatus.test.js`
Expected: PASS.

- [ ] **Step 5: Rework `openProvisionPanel` into a poll-based viewer**

In `src/web/main.ts`, replace the body of `openProvisionPanel(box, options)` (~956-1016). Keep the same signature and call sites (Add Box submit already calls it). New behavior: POST the setup job, poll it, render status/log, and wire the action buttons. The interactive fallback reuses the existing `openProvisionTerminal`.

```ts
function openProvisionPanel(box: Box, options: { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools?: string[] }) {
  const panel = document.getElementById('provision-panel')!;
  const title = panel.querySelector('.provision-title')!;
  const status = panel.querySelector('.provision-status')!;
  const container = panel.querySelector('.provision-term') as HTMLElement;
  const closeBtn = panel.querySelector('.provision-close') as HTMLElement;

  closeProvisionPanel();
  title.textContent = `Setup — ${box.label}`;
  status.textContent = '';
  status.className = 'provision-status';
  container.innerHTML = '';
  panel.classList.add('open');

  const opts = { ohMyTmux: options.ohMyTmux, ohMyZsh: options.ohMyZsh, ohMyBash: options.ohMyBash, tools: options.tools || [] };
  const log = document.createElement('pre');
  log.className = 'provision-log';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  container.append(log, actions);

  let stopped = false;
  let pollTimer: number | undefined;
  const stop = () => { stopped = true; if (pollTimer) clearTimeout(pollTimer); };

  function renderActions(job: SetupJob) {
    actions.replaceChildren();
    for (const a of setupActions(job.status)) {
      if (a === 'close') actions.append(btn('Close', () => closeProvisionPanel()));
      else if (a === 'retry') actions.append(btn('Retry', () => { void begin(); }, 'pve-primary'));
      else if (a === 'remove') actions.append(btn('Remove box', async () => { await api.removeBox(box.id); stop(); closeProvisionPanel(); refresh(); }, 'danger'));
      else if (a === 'finish-interactive') actions.append(btn('Finish interactively', () => finishInteractive(), 'pve-primary'));
    }
  }
  function btn(label: string, onclick: () => void, cls = '') {
    const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; b.textContent = label; b.onclick = onclick; return b;
  }

  function finishInteractive() {
    // The existing WS PTY runs the same idempotent script with the user present
    // to type the sudo password. On exit, the server marks the job; resume polling.
    log.style.display = 'none';
    const term = document.createElement('div'); term.style.height = '320px'; container.insertBefore(term, actions);
    openProvisionTerminal(term, box.id, opts, () => { log.style.display = ''; term.remove(); });
  }

  async function poll(id: string) {
    if (stopped) return;
    let job: SetupJob;
    try { job = await api.getSetup(id); } catch { pollTimer = window.setTimeout(() => poll(id), 1500); return; }
    if (stopped) return;
    status.textContent = setupStatusText(job);
    status.className = 'provision-status' + (job.status === 'done' ? ' success' : (job.status === 'error' || job.status === 'interrupted' || job.status === 'needs-interactive') ? ' error' : '');
    log.textContent = job.log || '';
    log.scrollTop = log.scrollHeight;
    renderActions(job);
    if (job.status === 'running') { pollTimer = window.setTimeout(() => poll(id), 1500); return; }
    if (job.status === 'done') { refresh(); pollTimer = window.setTimeout(() => closeProvisionPanel(), 2000); }
    else if (job.status === 'needs-interactive') { pollTimer = window.setTimeout(() => poll(id), 2500); } // reflect completion after interactive finish
  }

  async function begin() {
    try {
      const s = await api.startSetup(box.id, opts);
      void poll(s.id);
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : 'Failed to start setup';
      status.className = 'provision-status error';
      renderActions({ status: 'error' } as SetupJob);
    }
  }

  activeProvisionCleanup = stop; // see closeProvisionPanel change below
  closeBtn.style.display = '';
  (closeBtn as HTMLButtonElement).onclick = () => closeProvisionPanel();
  void begin();
}
```

Update the module-level state + `closeProvisionPanel` (~941-955) to stop polling instead of disposing a terminal:

```ts
let activeProvisionCleanup: (() => void) | null = null;
let provisionAutoClose: number | undefined;

function closeProvisionPanel() {
  const panel = document.getElementById('provision-panel')!;
  if (provisionAutoClose) { clearTimeout(provisionAutoClose); provisionAutoClose = undefined; }
  panel.classList.remove('open');
  const cleanup = activeProvisionCleanup;
  activeProvisionCleanup = null;
  cleanup?.();
}
```

Remove the now-unused `activeProvisionTerm` variable and its `openProvisionTerminal`-based body. Add the imports at the top of `main.ts`:

```ts
import { setupStatusText, setupActions } from './setupStatus';
import type { SetupJob } from './api';
```
(Keep the existing `openProvisionTerminal` import — it's still used by `finishInteractive`.)

- [ ] **Step 6: Add the box-card setup badge**

Where box cards are rendered in `main.ts` (the box list render), after computing the card, overlay a badge from the current setup job. Add a light per-render lookup using `api.listSetups()` cached alongside the status refresh, or fetch `api.getBoxSetup(box.id)` lazily. Minimal approach — fold into the existing `refresh()`:

```ts
// After boxes render in refresh(): annotate any box with an active setup job.
try {
  const setups = await api.listSetups();
  for (const s of setups) {
    const b = setupBadge(s.status);
    if (!b) continue;
    const card = document.querySelector(`[data-box-id="${s.boxId}"] .box-badges`);
    if (card) { const span = document.createElement('span'); span.className = `badge ${b.cls}`; span.textContent = b.text; card.append(span); }
  }
} catch { /* badges are best-effort */ }
```
Add `import { setupBadge } from './setupStatus';`. If box cards lack a `.box-badges` container or `data-box-id`, add them in the card builder (small, follow the existing card DOM). Add matching `.badge`, `.badge-info`, `.badge-warn` rules to `src/web/style.css`.

- [ ] **Step 7: Typecheck + run pure tests**

Run: `npm run typecheck && npx vitest run test/setupStatus.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/setupStatus.ts test/setupStatus.test.js src/web/main.ts src/web/style.css
git commit -m "feat(setup): poll-based setup viewer, status helpers, box badge"
```

---

## Task 9: Proxmox provision UI → poll the auto-started setup job

**Files:**
- Modify: `src/web/proxmoxUi.ts` (`showJob` ~131-193, `runSetup`)

**Interfaces:**
- Consumes: `api.getBoxSetup`, `api.getSetup`, `setupStatusText`, `setupActions`, existing `openProvisionTerminal`.

- [ ] **Step 1: Replace `runSetup` with setup-job polling**

In `src/web/proxmoxUi.ts`, the provision `showJob` currently, on link with a `setup` request, calls `runSetup` which opens a WS terminal. Replace `runSetup` so it discovers and polls the server-side job the provision manager already auto-started:

```ts
async function runSetup(boxId: string, vmid: number | null, _opt: SetupOptions) {
  // The provision manager auto-started a server-side setup job on link. Find it
  // and poll it — no client-owned SSH readiness wait or WS terminal anymore.
  setupArea.style.marginTop = '8px';
  const setupLog = el('pre', { class: 'pve-log' });
  setupArea.replaceChildren(setupLog);

  async function tickSetup() {
    if (myGen !== pollGen) return;
    let job = await api.getBoxSetup(boxId).catch(() => null);
    if (myGen !== pollGen) return;
    if (!job) { pollTimer = window.setTimeout(tickSetup, 1500); return; }
    phase.textContent = `vmid ${vmid ?? ''} · ${setupStatusText(job)}`;
    setupLog.textContent = job.log || '';
    setupLog.scrollTop = setupLog.scrollHeight;
    if (job.status === 'running') { pollTimer = window.setTimeout(tickSetup, 1500); return; }
    opts.onBoxLinked();
    footer.replaceChildren();
    if (job.status === 'needs-interactive') {
      footer.append(el('button', { type: 'button', class: 'pve-primary', onclick: () => {
        const term = el('div', {}); (term as HTMLElement).style.height = '320px'; setupArea.append(term);
        openProvisionTerminal(term as HTMLElement, boxId, job!.options, () => { void tickSetup(); });
      } }, ['Finish interactively']), openTerminalBtn(boxId));
    } else {
      footer.append(openTerminalBtn(boxId));
    }
  }
  void tickSetup();
}
```

Notes:
- `el` is the shared DOM builder already imported in `proxmoxUi.ts`.
- Add imports: `import { setupStatusText } from './setupStatus';` and ensure `SetupOptions` still imported from `./api`.
- The SSH-readiness wait that used to live here now lives server-side (`waitForSsh` in the setup manager), so the `probeSessions` loop is removed. Delete the now-unused readiness code and the `setupTerm = openProvisionTerminal(...)` block.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. Fix any now-unused imports/vars (`setupTerm`, `probeSessions` usage) the compiler flags.

- [ ] **Step 3: Commit**

```bash
git add src/web/proxmoxUi.ts
git commit -m "feat(setup): Proxmox provision UI polls the server-side setup job"
```

---

## Task 10: End-to-end acceptance — setup survives panel close

**Files:**
- Create: `test/e2e/setup-server-side.spec.ts`

**Interfaces:**
- Consumes: the sshd-backed box helper in `test/helpers` / `test/e2e` (reuse the existing provisioning e2e setup).

- [ ] **Step 1: Write the e2e test**

Open the existing e2e specs first (`ls test/e2e`) and reuse their fixture that spins up a local sshd box and logs in. Then add:

```ts
import { test, expect } from '@playwright/test';
// reuse the shared fixtures/helpers the other e2e specs import

test('setup continues server-side after the panel is closed mid-run', async ({ page /*, sshBox, login */ }) => {
  // 1. Log in and add a box pointing at the local sshd fixture with a framework
  //    checkbox selected so a setup job starts. (Reuse the existing add-box helper.)
  // 2. Wait until the setup panel shows a 'Running setup…' status.
  await expect(page.locator('.provision-status')).toContainText(/running/i);

  // 3. Close the panel mid-run (the whole point of this feature).
  await page.locator('.provision-close').click();
  await expect(page.locator('#provision-panel')).not.toHaveClass(/open/);

  // 4. The job keeps running server-side. Poll the API directly and assert it
  //    reaches a terminal state without the panel being open.
  await expect.poll(async () => {
    const res = await page.request.get('/api/setup');
    const jobs = await res.json();
    return jobs[0]?.status;
  }, { timeout: 60_000 }).toMatch(/done|needs-interactive/);
});
```

> Adapt selectors and the add-box flow to the actual helpers. The key assertions: (a) a job is `running`, (b) closing the panel does NOT stop it, (c) `/api/setup` reports a terminal (`done`) status afterward. For a root sshd fixture the expected end state is `done`.

- [ ] **Step 2: Run the e2e test**

Run: `npm run test:e2e -- setup-server-side`
Expected: PASS (job reaches `done` with the panel closed).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/setup-server-side.spec.ts
git commit -m "test(setup): e2e — setup continues after the panel closes"
```

---

## Final verification

- [ ] Run the full suite: `npm test` → PASS (typecheck + all vitest).
- [ ] Run e2e: `npm run test:e2e` → PASS.
- [ ] Manual smoke (optional, per `docs/DEPLOY.md`): `npm run build && npm start`, add a box with a framework, watch setup run, close the panel mid-run, reopen from the box badge, confirm it completed server-side.
- [ ] Update `CLAUDE.md` architecture list with `setupManager.js` / `setupStore.js` / `sshStream` / `buildSetupArgv` and the `data/setup-jobs.json` file (fold into the Task 6 commit or a small docs commit).
