# Fleet Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a single command across any number of selected boxes as a server-side, persisted, pollable job, with per-box captured output surfaced centrally.

**Architecture:** A new `createFleetManager` (server-side, factory + DI) owns a job registry: `createJob` snapshots targets and fires an async runner that fans out over the existing non-interactive SSH exec path (`boxActions.execCommand` → `buildProbeArgv` + `sshRun`) through the bounded-concurrency limiter, capturing `{code, stdout, stderr}` per box. Jobs persist to `data/fleet-jobs.json` and are exposed via `POST/GET /api/fleet/jobs[...]`. The web client adds a Fleet selection mode and a polling jobs panel.

**Tech Stack:** Node 20+ ESM, Fastify, `@fastify/websocket` (unused here), vitest (unit + integration, real code + DI, no mocks), Playwright (e2e), TypeScript + xterm.js web client bundled by Vite.

## Global Constraints

- ESM everywhere (`"type": "module"`), Node 20+. Server is plain `.js`; web client is `.ts`.
- TDD: write the failing test first; tests use **real code + dependency injection**, never a mocking library. Inject collaborators; spy with tiny hand-written stubs that push into a `calls[]` array.
- `loadConfig` is **pure and injectable** — never read `process.env`/`process.cwd()` inside it or its tests; pass explicit `{ env, cwd }`.
- All ssh-facing box fields go through `assertBoxSafe` (already enforced inside `buildProbeArgv`). The fleet **command string is passed verbatim as the final ssh argv element and is NEVER `shSingleQuote`d** — it is meant to be interpreted by the remote login shell, and `sshRun` uses `execFile` (no local shell), so there is no local-injection surface.
- Fan-out **must** go through `mapWithConcurrency` at `config.fleetConcurrency` (default 4) — a fleet-wide SSH burst trips host-side port-22 rate bans (documented production failure mode).
- Conventional-commit messages (`feat(fleet): …`, `test(fleet): …`). Commit after each task.
- Public repo: no real PII in committed code/tests/docs — use `example.com`, RFC1918 IPs, `you@example.com`.
- Vitest discovers `test/**/*.test.js`; `fileParallelism: false`. Web `.ts` helpers are imported directly from `.test.js` (see `test/statusDot.test.js`). Test timeout 20000.
- New config defaults (copied verbatim into Task 1): `fleetConcurrency=4`, `fleetTimeoutMs=15000`, `fleetMaxJobs=50`, `fleetMaxOutputBytes=65536`.
- Job data model (every task that touches a job uses exactly these field names):
  - Job: `{ id, command, status: 'running'|'done'|'cancelled'|'interrupted', createdAt, startedAt, finishedAt|null, concurrency, timeoutMs, targets[] }`
  - Target: `{ boxId, label, host, status: 'pending'|'running'|'ok'|'error'|'cancelled'|'interrupted', code|null, stdout, stderr, truncated, error|null, startedAt|null, finishedAt|null }`
  - Cancellation is tracked in an in-memory `Set<jobId>` in the manager — it is **never** a field on the persisted job object.

---

### Task 1: Config knobs for Fleet Command

**Files:**
- Modify: `src/server/config.js` (DEFAULTS ~line 6-26; envCfg ~line 49-69)
- Modify: `.env.example` (append to the `--- SSH / sessions ---` section)
- Modify: `README.md` (config table ~line 54, after the ControlPersist row)
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `config.fleetConcurrency: number`, `config.fleetTimeoutMs: number`, `config.fleetMaxJobs: number`, `config.fleetMaxOutputBytes: number` on the object returned by `loadConfig`.

- [ ] **Step 1: Write the failing test**

Add to `test/config.test.js`:

```js
test('fleet command knobs have defaults and are overridable via env', () => {
  const d = loadConfig({}, { env: {}, cwd: '/app' });
  expect(d.fleetConcurrency).toBe(4);
  expect(d.fleetTimeoutMs).toBe(15000);
  expect(d.fleetMaxJobs).toBe(50);
  expect(d.fleetMaxOutputBytes).toBe(65536);
  const e = loadConfig({}, {
    env: {
      TMUXIFIER_FLEET_CONCURRENCY: '8',
      TMUXIFIER_FLEET_TIMEOUT_MS: '30000',
      TMUXIFIER_FLEET_MAX_JOBS: '10',
      TMUXIFIER_FLEET_MAX_OUTPUT_BYTES: '1024',
    },
    cwd: '/app',
  });
  expect(e.fleetConcurrency).toBe(8);
  expect(e.fleetTimeoutMs).toBe(30000);
  expect(e.fleetMaxJobs).toBe(10);
  expect(e.fleetMaxOutputBytes).toBe(1024);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.js -t "fleet command knobs"`
Expected: FAIL (`expected undefined to be 4`).

- [ ] **Step 3: Add the defaults**

In `src/server/config.js`, inside the `DEFAULTS` object (after the `controlPersist: 600,` line, before the closing `}`):

```js
  // Fleet Command: run one command across many boxes as a single pollable job.
  // Concurrency shares the status rationale — never open the whole fleet's SSH
  // connections at once.
  fleetConcurrency: 4,
  fleetTimeoutMs: 15000,       // per-box ssh exec timeout (ms)
  fleetMaxJobs: 50,            // retained job history; older jobs are pruned
  fleetMaxOutputBytes: 65536,  // per-stream capture cap per box (64 KiB)
```

- [ ] **Step 4: Map the env vars**

In `src/server/config.js`, inside the `clean({ ... })` env object (after the `controlPersist:` line):

```js
    fleetConcurrency: e.TMUXIFIER_FLEET_CONCURRENCY ? Number(e.TMUXIFIER_FLEET_CONCURRENCY) : undefined,
    fleetTimeoutMs: e.TMUXIFIER_FLEET_TIMEOUT_MS ? Number(e.TMUXIFIER_FLEET_TIMEOUT_MS) : undefined,
    fleetMaxJobs: e.TMUXIFIER_FLEET_MAX_JOBS ? Number(e.TMUXIFIER_FLEET_MAX_JOBS) : undefined,
    fleetMaxOutputBytes: e.TMUXIFIER_FLEET_MAX_OUTPUT_BYTES ? Number(e.TMUXIFIER_FLEET_MAX_OUTPUT_BYTES) : undefined,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/config.test.js -t "fleet command knobs"`
Expected: PASS.

- [ ] **Step 6: Document the knobs**

In `.env.example`, at the end of the `# --- SSH / sessions ---` block, append:

```
# --- Fleet Command -----------------------------------------------------------
# Run one command across many selected boxes as a pollable job. Concurrency keeps
# the fan-out small for the same reason as status probing (avoid SSH bursts).
#TMUXIFIER_FLEET_CONCURRENCY=4
# Per-box ssh exec timeout (ms).
#TMUXIFIER_FLEET_TIMEOUT_MS=15000
# How many past fleet jobs to keep in data/fleet-jobs.json (older are pruned).
#TMUXIFIER_FLEET_MAX_JOBS=50
# Per-stream (stdout/stderr) capture cap per box, in bytes.
#TMUXIFIER_FLEET_MAX_OUTPUT_BYTES=65536
```

In `README.md`, add these rows to the config table right after the `| SSH ControlPersist seconds | ... |` row:

```
| fleet command concurrency | `TMUXIFIER_FLEET_CONCURRENCY` | `4` |
| fleet per-box timeout (ms) | `TMUXIFIER_FLEET_TIMEOUT_MS` | `15000` |
| fleet job history kept | `TMUXIFIER_FLEET_MAX_JOBS` | `50` |
| fleet per-box output cap (bytes) | `TMUXIFIER_FLEET_MAX_OUTPUT_BYTES` | `65536` |
```

- [ ] **Step 7: Commit**

```bash
git add src/server/config.js test/config.test.js .env.example README.md
git commit -m "feat(fleet): add fleet command config knobs"
```

---

### Task 2: `boxActions.execCommand` — one-shot remote exec primitive

**Files:**
- Modify: `src/server/boxActions.js` (the object returned by `createBoxActions`, ~line 199)
- Test: `test/boxActions.test.js`

**Interfaces:**
- Consumes: existing internal `runRemote(box, remote, timeout)` (boxActions.js:171) and `buildProbeArgv`.
- Produces: `boxActions.execCommand(box, command, { timeoutMs }) -> Promise<{ code, stdout, stderr }>`. Rejects (throws) when `assertBoxSafe` fails inside `buildProbeArgv` before any ssh runs.

- [ ] **Step 1: Write the failing tests**

Add to `test/boxActions.test.js`:

```js
test('execCommand runs the command verbatim as the final ssh arg, capturing output', async () => {
  let argv;
  const actions = createBoxActions({
    run: async (a) => { argv = a; return { code: 0, stdout: 'hi\n', stderr: '' }; },
    controlDir: '/run/cm',
  });
  const res = await actions.execCommand({ host: 'h', user: 'me' }, 'df -h /', { timeoutMs: 1000 });
  expect(res).toEqual({ code: 0, stdout: 'hi\n', stderr: '' });
  expect(argv[argv.length - 1]).toBe('df -h /'); // command is the last argv element, verbatim (NOT quoted)
  expect(argv).toContain('me@h');
  expect(argv).toContain('BatchMode=yes');
});

test('execCommand rejects an unsafe box before running ssh', async () => {
  let called = false;
  const actions = createBoxActions({ run: async () => { called = true; return { code: 0 }; } });
  await expect(actions.execCommand({ host: '-bad' }, 'echo hi', {})).rejects.toThrow(/unsafe/);
  expect(called).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/boxActions.test.js -t execCommand`
Expected: FAIL (`actions.execCommand is not a function`).

- [ ] **Step 3: Implement `execCommand`**

In `src/server/boxActions.js`, add this method to the returned object (after `killSession`, before `exitMaster`):

```js
    // Run a one-shot, non-interactive command on the box over the existing
    // BatchMode ssh path and capture {code, stdout, stderr}. `command` is the
    // remote shell command and is passed verbatim (runRemote -> buildProbeArgv
    // appends it as the final argv element). assertBoxSafe (inside buildProbeArgv)
    // still validates the connection fields.
    async execCommand(box, command, { timeoutMs = 15000 } = {}) {
      return runRemote(box, command, timeoutMs);
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/boxActions.test.js -t execCommand`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/server/boxActions.js test/boxActions.test.js
git commit -m "feat(fleet): add boxActions.execCommand one-shot remote exec"
```

---

### Task 3: `fleetStore` — persist jobs to `data/fleet-jobs.json`

**Files:**
- Create: `src/server/fleetStore.js`
- Modify: `CLAUDE.md` (self-contained `data/` inventory line) and `AGENTS.md` (same line, kept in sync)
- Test: `test/fleetStore.test.js`

**Interfaces:**
- Produces: `createFleetStore({ dataDir }) -> { load(): Job[], save(jobs: Job[]): void }`. Both are **synchronous** (the manager calls `save` fire-and-forget from its async runner). `load` returns `[]` on missing/corrupt file; `save` is best-effort and never throws.

- [ ] **Step 1: Write the failing tests**

Create `test/fleetStore.test.js`:

```js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFleetStore } from '../src/server/fleetStore.js';

test('load returns [] when the file does not exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-fleetstore-'));
  const store = createFleetStore({ dataDir: dir });
  expect(store.load()).toEqual([]);
});

test('save then load round-trips the jobs array and creates the data dir', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-fleetstore-'));
  const dir = path.join(base, 'data'); // does not exist yet
  const store = createFleetStore({ dataDir: dir });
  const jobs = [{ id: 'j1', command: 'uptime', status: 'done', targets: [] }];
  store.save(jobs);
  expect(store.load()).toEqual(jobs);
  await expect(fs.stat(path.join(dir, 'fleet-jobs.json'))).resolves.toBeTruthy();
});

test('load returns [] on a corrupt file instead of throwing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-fleetstore-'));
  await fs.writeFile(path.join(dir, 'fleet-jobs.json'), 'not json');
  const store = createFleetStore({ dataDir: dir });
  expect(store.load()).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/fleetStore.test.js`
Expected: FAIL (`Cannot find module '.../fleetStore.js'`).

- [ ] **Step 3: Implement `fleetStore.js`**

Create `src/server/fleetStore.js`:

```js
import fs from 'node:fs';
import path from 'node:path';

// Persist fleet jobs to data/fleet-jobs.json. Synchronous on purpose: the fleet
// runner calls save() fire-and-forget at each checkpoint without awaiting, and
// the file is small (capped to fleetMaxJobs). The whole data/ dir is already
// gitignored, so this file needs no .gitignore entry.
export function createFleetStore({ dataDir }) {
  const file = path.join(dataDir, 'fleet-jobs.json');
  return {
    load() {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    },
    save(jobs) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(jobs, null, 2));
      } catch {
        // Best effort: persistence must never crash a fleet run.
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/fleetStore.test.js`
Expected: PASS (all three).

- [ ] **Step 5: Update the self-contained data/ inventory docs**

In `CLAUDE.md`, in the "Self-contained principle" bullet list, change the `data/` line to mention the new file:

Find:
```
- `data/` (gitignored) — `boxes.json` and SSH ControlMaster sockets under `data/cm/`.
```
Replace with:
```
- `data/` (gitignored) — `boxes.json`, `fleet-jobs.json` (Fleet Command history), and SSH
  ControlMaster sockets under `data/cm/`.
```

Make the identical change in `AGENTS.md` (it mirrors CLAUDE.md).

- [ ] **Step 6: Commit**

```bash
git add src/server/fleetStore.js test/fleetStore.test.js CLAUDE.md AGENTS.md
git commit -m "feat(fleet): persist fleet jobs to data/fleet-jobs.json"
```

---

### Task 4: `createFleetManager` — create, run, capture, list, prune

**Files:**
- Create: `src/server/fleet.js`
- Test: `test/fleet.test.js`

**Interfaces:**
- Consumes: `store.getBox(id)` (async), `execCommand(box, command, { timeoutMs })` (async → `{code, stdout, stderr}`), injected `load`/`save`/`now`/`newId`, and `mapWithConcurrency`.
- Produces:
  - `createFleetManager(deps) -> { createJob, getJob, listJobs, _settled }` (cancel + reconcile added in Tasks 5-6).
  - `createJob({ boxIds, command }) -> Promise<Job>` — resolves boxes via `store.getBox`; **throws** on empty command or any unknown boxId; returns the live job object (targets `pending`) and starts the async runner.
  - `getJob(id) -> Job | undefined` (live reference).
  - `listJobs() -> Summary[]` newest-first, where `Summary = { id, command, status, createdAt, startedAt, finishedAt, targetCount, okCount, errorCount }`.
  - `_settled(id) -> Promise<void>` (test affordance: resolves when the run finishes).
  - deps default: `concurrency=4, timeoutMs=15000, maxJobs=50, maxOutputBytes=65536, now=()=>new Date().toISOString(), newId=()=>randomUUID(), load=()=>[], save=()=>{}`.

- [ ] **Step 1: Write the failing tests**

Create `test/fleet.test.js`:

```js
import { test, expect } from 'vitest';
import { createFleetManager } from '../src/server/fleet.js';

function makeStore(boxes) {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  return { getBox: async (id) => byId.get(id) };
}
const BOXES = [
  { id: 'b1', label: 'web-01', host: 'h1', user: 'me' },
  { id: 'b2', label: 'web-02', host: 'h2', user: 'me' },
];

test('runs the command on every target and captures output + exit code', async () => {
  const seen = [];
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    execCommand: async (box, command) => { seen.push([box.id, command]); return { code: 0, stdout: `out-${box.id}`, stderr: '' }; },
  });
  const job = await mgr.createJob({ boxIds: ['b1', 'b2'], command: 'uptime' });
  expect(job.status).toBe('running');
  expect(job.targets.map((t) => t.status)).toEqual(['pending', 'pending']);
  await mgr._settled(job.id);
  expect(job.status).toBe('done');
  expect(seen).toEqual([['b1', 'uptime'], ['b2', 'uptime']]);
  expect(job.targets[0]).toMatchObject({ boxId: 'b1', label: 'web-01', host: 'h1', status: 'ok', code: 0, stdout: 'out-b1' });
  expect(job.targets[1]).toMatchObject({ status: 'ok', code: 0, stdout: 'out-b2' });
});

test('a non-zero exit and a thrown exec both become error targets; job still completes', async () => {
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    execCommand: async (box) => {
      if (box.id === 'b1') return { code: 7, stdout: '', stderr: 'boom' };
      throw new Error('ssh exploded');
    },
  });
  const job = await mgr.createJob({ boxIds: ['b1', 'b2'], command: 'x' });
  await mgr._settled(job.id);
  expect(job.status).toBe('done');
  expect(job.targets[0]).toMatchObject({ status: 'error', code: 7, stderr: 'boom' });
  expect(job.targets[1]).toMatchObject({ status: 'error', code: null, error: 'ssh exploded' });
});

test('output beyond maxOutputBytes is clipped and flagged truncated', async () => {
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    maxOutputBytes: 4,
    execCommand: async () => ({ code: 0, stdout: 'abcdefgh', stderr: '' }),
  });
  const job = await mgr.createJob({ boxIds: ['b1'], command: 'x' });
  await mgr._settled(job.id);
  expect(job.targets[0].stdout).toBe('abcd');
  expect(job.targets[0].truncated).toBe(true);
});

test('fan-out respects the concurrency limit', async () => {
  let inFlight = 0; let peak = 0;
  const mgr = createFleetManager({
    store: makeStore([...Array(6)].map((_, i) => ({ id: `b${i}`, label: `n${i}`, host: `h${i}` }))),
    concurrency: 2,
    execCommand: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--; return { code: 0, stdout: '', stderr: '' };
    },
  });
  const job = await mgr.createJob({ boxIds: ['b0','b1','b2','b3','b4','b5'], command: 'x' });
  await mgr._settled(job.id);
  expect(peak).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(2);
});

test('createJob rejects an empty command and an unknown boxId', async () => {
  const mgr = createFleetManager({ store: makeStore(BOXES), execCommand: async () => ({ code: 0 }) });
  await expect(mgr.createJob({ boxIds: ['b1'], command: '   ' })).rejects.toThrow(/command/i);
  await expect(mgr.createJob({ boxIds: ['nope'], command: 'x' })).rejects.toThrow(/unknown box/i);
});

test('save is called at create and again after the run finishes; jobs persist', async () => {
  const saves = [];
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    save: (jobs) => saves.push(jobs.map((j) => j.status)),
    execCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  const job = await mgr.createJob({ boxIds: ['b1'], command: 'x' });
  await mgr._settled(job.id);
  expect(saves[0]).toEqual(['running']);      // persisted on create
  expect(saves[saves.length - 1]).toEqual(['done']); // persisted on finish
});

test('listJobs returns newest-first summaries with counts; prunes to maxJobs', async () => {
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    maxJobs: 2,
    execCommand: async (box) => (box.id === 'b1' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
  });
  const j1 = await mgr.createJob({ boxIds: ['b1', 'b2'], command: 'a' }); await mgr._settled(j1.id);
  const j2 = await mgr.createJob({ boxIds: ['b2'], command: 'b' }); await mgr._settled(j2.id);
  const j3 = await mgr.createJob({ boxIds: ['b2'], command: 'c' }); await mgr._settled(j3.id);
  const list = mgr.listJobs();
  expect(list.map((s) => s.command)).toEqual(['c', 'b']); // newest-first, oldest (a) pruned
  expect(mgr.getJob(j1.id)).toBeUndefined();
  const summaryA = list.find((s) => s.command === 'b');
  expect(summaryA).toMatchObject({ targetCount: 1, okCount: 1, errorCount: 0 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/fleet.test.js`
Expected: FAIL (`Cannot find module '.../fleet.js'`).

- [ ] **Step 3: Implement `fleet.js`**

Create `src/server/fleet.js`:

```js
import { randomUUID } from 'node:crypto';
import { mapWithConcurrency } from './concurrency.js';

function clip(value, max) {
  const s = value == null ? '' : String(value);
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
}

export function createFleetManager({
  store,
  execCommand,
  load = () => [],
  save = () => {},
  now = () => new Date().toISOString(),
  newId = () => randomUUID(),
  concurrency = 4,
  timeoutMs = 15000,
  maxJobs = 50,
  maxOutputBytes = 65536,
}) {
  const loaded = load();
  const jobs = Array.isArray(loaded) ? loaded : []; // oldest first; newest pushed to the end
  const runs = new Map();                            // jobId -> in-flight run promise (test affordance)

  function prune() {
    while (jobs.length > maxJobs) jobs.shift();
  }

  function summarize(job) {
    let okCount = 0; let errorCount = 0;
    for (const t of job.targets) {
      if (t.status === 'ok') okCount++;
      else if (t.status === 'error' || t.status === 'interrupted') errorCount++;
    }
    return {
      id: job.id, command: job.command, status: job.status,
      createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      targetCount: job.targets.length, okCount, errorCount,
    };
  }

  function finalize(job) {
    for (const t of job.targets) {
      if (t.status === 'pending' || t.status === 'running') {
        t.status = 'error';
        t.error = t.error || 'did not run';
        t.finishedAt = now();
      }
    }
    job.status = 'done';
    job.finishedAt = now();
    save(jobs);
  }

  async function runJob(job, boxById) {
    try {
      await mapWithConcurrency(job.targets, concurrency, async (t) => {
        t.status = 'running';
        t.startedAt = now();
        save(jobs);
        try {
          const res = await execCommand(boxById.get(t.boxId), job.command, { timeoutMs });
          const out = clip(res && res.stdout, maxOutputBytes);
          const err = clip(res && res.stderr, maxOutputBytes);
          t.stdout = out.text;
          t.stderr = err.text;
          t.truncated = out.truncated || err.truncated;
          t.code = res && typeof res.code === 'number' ? res.code : null;
          t.status = t.code === 0 ? 'ok' : 'error';
          if (t.status === 'error' && !t.error) t.error = `exited ${t.code}`;
        } catch (e) {
          t.status = 'error';
          t.code = null;
          t.error = (e && e.message) || 'exec failed';
        }
        t.finishedAt = now();
        save(jobs);
      });
    } catch {
      // Unexpected runner failure — finalize below so a job never dangles 'running'.
    }
    finalize(job);
  }

  return {
    async createJob({ boxIds, command }) {
      if (typeof command !== 'string' || !command.trim()) throw new Error('command is required');
      if (!Array.isArray(boxIds) || boxIds.length === 0) throw new Error('select at least one box');
      const boxById = new Map();
      for (const id of boxIds) {
        const box = await store.getBox(id);
        if (!box) throw new Error(`unknown box: ${id}`);
        boxById.set(id, box);
      }
      const ts = now();
      const job = {
        id: newId(),
        command,
        status: 'running',
        createdAt: ts,
        startedAt: ts,
        finishedAt: null,
        concurrency,
        timeoutMs,
        targets: boxIds.map((id) => {
          const b = boxById.get(id);
          return {
            boxId: id, label: b.label || b.host, host: b.host,
            status: 'pending', code: null, stdout: '', stderr: '', truncated: false,
            error: null, startedAt: null, finishedAt: null,
          };
        }),
      };
      jobs.push(job);
      prune();
      save(jobs);
      const p = runJob(job, boxById).catch(() => {});
      runs.set(job.id, p);
      return job;
    },
    getJob(id) {
      return jobs.find((j) => j.id === id);
    },
    listJobs() {
      return [...jobs].reverse().map(summarize);
    },
    async _settled(id) {
      await runs.get(id);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/fleet.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/server/fleet.js test/fleet.test.js
git commit -m "feat(fleet): add fleet manager (create, run, capture, list, prune)"
```

---

### Task 5: Fleet job cancellation

**Files:**
- Modify: `src/server/fleet.js` (add cancel state, cancel check in `runJob`, cancel-aware `finalize`, new `cancelJob`, expose it)
- Test: `test/fleet.test.js` (add cases)

**Interfaces:**
- Produces: `cancelJob(id) -> Job | undefined`. Returns the live job (still `running`) when cancellation is accepted, the job unchanged when already finished, `undefined` when not found. Cancellation flips not-yet-started targets to `cancelled` and the finished job's status to `cancelled`.

- [ ] **Step 1: Write the failing tests**

Add to `test/fleet.test.js`:

```js
test('cancelJob stops queued targets; in-flight finishes; job ends cancelled', async () => {
  let release0;
  const block0 = new Promise((r) => { release0 = r; });
  let calls = 0;
  const mgr = createFleetManager({
    store: makeStore([
      { id: 'b1', label: 'n1', host: 'h1' },
      { id: 'b2', label: 'n2', host: 'h2' },
      { id: 'b3', label: 'n3', host: 'h3' },
    ]),
    concurrency: 1, // strictly sequential so b2/b3 are still queued when we cancel
    execCommand: async () => { calls++; if (calls === 1) await block0; return { code: 0, stdout: '', stderr: '' }; },
  });
  const job = await mgr.createJob({ boxIds: ['b1', 'b2', 'b3'], command: 'x' }); // b1 in-flight, blocked
  mgr.cancelJob(job.id);  // request cancel while b1 is still running
  release0();             // let b1 complete; b2/b3 see the flag and are skipped
  await mgr._settled(job.id);
  expect(job.status).toBe('cancelled');
  expect(job.targets[0].status).toBe('ok');
  expect(job.targets[1].status).toBe('cancelled');
  expect(job.targets[2].status).toBe('cancelled');
  expect(calls).toBe(1); // b2/b3 never invoked execCommand
});

test('cancelJob returns undefined for an unknown id and is a no-op on a finished job', async () => {
  const mgr = createFleetManager({ store: makeStore(BOXES), execCommand: async () => ({ code: 0, stdout: '', stderr: '' }) });
  expect(mgr.cancelJob('nope')).toBeUndefined();
  const job = await mgr.createJob({ boxIds: ['b1'], command: 'x' });
  await mgr._settled(job.id);
  expect(mgr.cancelJob(job.id).status).toBe('done'); // already finished — unchanged
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/fleet.test.js -t cancel`
Expected: FAIL (`mgr.cancelJob is not a function`).

- [ ] **Step 3: Add cancel state and check**

In `src/server/fleet.js`, after the `const runs = new Map();` line, add:

```js
  const cancelled = new Set(); // jobIds with a pending cancel request (in-memory only)
```

In `runJob`, replace the body of the `mapWithConcurrency` callback's start (the `t.status = 'running';` lead-in) so the first thing it does is honor cancellation. Change:

```js
      await mapWithConcurrency(job.targets, concurrency, async (t) => {
        t.status = 'running';
```

to:

```js
      await mapWithConcurrency(job.targets, concurrency, async (t) => {
        if (cancelled.has(job.id)) {
          t.status = 'cancelled';
          t.finishedAt = now();
          save(jobs);
          return;
        }
        t.status = 'running';
```

In `finalize`, make the terminal status cancel-aware. Change:

```js
    job.status = 'done';
    job.finishedAt = now();
    save(jobs);
```

to:

```js
    job.status = cancelled.has(job.id) ? 'cancelled' : 'done';
    job.finishedAt = now();
    save(jobs);
```

- [ ] **Step 4: Add the `cancelJob` method**

In the returned object in `src/server/fleet.js`, add after `getJob`:

```js
    cancelJob(id) {
      const job = jobs.find((j) => j.id === id);
      if (!job) return undefined;
      if (job.status === 'running') cancelled.add(id);
      return job;
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/fleet.test.js`
Expected: PASS (all, including the two new cancel tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/fleet.js test/fleet.test.js
git commit -m "feat(fleet): support cancelling a running fleet job"
```

---

### Task 6: Startup reconciliation of interrupted jobs

**Files:**
- Modify: `src/server/fleet.js` (reconcile loaded jobs in the constructor)
- Test: `test/fleet.test.js` (add a case)

**Interfaces:**
- Produces: on construction, any loaded job with `status === 'running'` becomes `interrupted`, and its `pending`/`running` targets become `interrupted` (with `finishedAt`); the reconciled set is persisted once via `save`.

- [ ] **Step 1: Write the failing test**

Add to `test/fleet.test.js`:

```js
test('reconciles jobs left running by a previous process into interrupted on startup', async () => {
  const persisted = [{
    id: 'j1', command: 'x', status: 'running',
    createdAt: 't', startedAt: 't', finishedAt: null, concurrency: 4, timeoutMs: 1,
    targets: [
      { boxId: 'b1', label: 'n1', host: 'h1', status: 'running', code: null, stdout: '', stderr: '', truncated: false, error: null, startedAt: 't', finishedAt: null },
      { boxId: 'b2', label: 'n2', host: 'h2', status: 'ok', code: 0, stdout: 'done', stderr: '', truncated: false, error: null, startedAt: 't', finishedAt: 't' },
    ],
  }];
  let saved = 0;
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    execCommand: async () => ({ code: 0 }),
    load: () => persisted,
    save: () => { saved++; },
  });
  const job = mgr.getJob('j1');
  expect(job.status).toBe('interrupted');
  expect(job.targets[0].status).toBe('interrupted'); // was running
  expect(job.targets[0].finishedAt).toBeTruthy();
  expect(job.targets[1].status).toBe('ok');          // already finished — untouched
  expect(saved).toBeGreaterThan(0);                   // reconciliation was persisted
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fleet.test.js -t reconcile`
Expected: FAIL (`expected 'running' to be 'interrupted'`).

- [ ] **Step 3: Implement reconciliation**

In `src/server/fleet.js`, immediately after the `const jobs = Array.isArray(loaded) ? loaded : [];` line, add:

```js
  // A job persisted as 'running' means a previous process died mid-run; its ssh
  // children are gone, so mark it (and its unfinished targets) interrupted.
  let reconciled = false;
  for (const job of jobs) {
    if (job.status !== 'running') continue;
    reconciled = true;
    for (const t of job.targets) {
      if (t.status === 'pending' || t.status === 'running') {
        t.status = 'interrupted';
        t.error = t.error || 'interrupted by restart';
        t.finishedAt = now();
      }
    }
    job.status = 'interrupted';
    job.finishedAt = now();
  }
  if (reconciled) save(jobs);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/fleet.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/server/fleet.js test/fleet.test.js
git commit -m "feat(fleet): reconcile interrupted jobs on startup"
```

---

### Task 7: REST routes for fleet jobs

**Files:**
- Modify: `src/server/server.js` (add `fleetManager` to `buildServer` params ~line 50; add 4 routes after the `/api/import` route ~line 260)
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `fleetManager.{createJob, listJobs, getJob, cancelJob}`.
- Produces routes (all `preHandler: requireAuth`; POST/cancel also covered by the global `requireTrustedOrigin` hook):
  - `POST /api/fleet/jobs` body `{ boxIds, command }` → 201 job | 400 | 401 | 403
  - `GET /api/fleet/jobs` → 200 summaries
  - `GET /api/fleet/jobs/:id` → 200 job | 404
  - `POST /api/fleet/jobs/:id/cancel` → 200 job | 404

- [ ] **Step 1: Write the failing tests**

Add to `test/server.test.js`. First a shared stub factory near the top (after the imports, before `beforeEach`):

```js
function fleetStub(calls = []) {
  return {
    createJob: async ({ boxIds, command }) => {
      calls.push(['createJob', boxIds, command]);
      if (boxIds.includes('bad')) throw new Error('unknown box: bad');
      return { id: 'job1', command, status: 'running', createdAt: 't', startedAt: 't', finishedAt: null, concurrency: 4, timeoutMs: 15000, targets: boxIds.map((id) => ({ boxId: id, label: id, host: id, status: 'pending', code: null, stdout: '', stderr: '', truncated: false, error: null, startedAt: null, finishedAt: null })) };
    },
    listJobs: () => { calls.push(['listJobs']); return [{ id: 'job1', command: 'uptime', status: 'done', createdAt: 't', startedAt: 't', finishedAt: 't', targetCount: 1, okCount: 1, errorCount: 0 }]; },
    getJob: (id) => { calls.push(['getJob', id]); return id === 'job1' ? { id: 'job1', command: 'uptime', status: 'done', targets: [] } : undefined; },
    cancelJob: (id) => { calls.push(['cancelJob', id]); return id === 'job1' ? { id: 'job1', status: 'cancelled', targets: [] } : undefined; },
  };
}
```

Then the cases:

```js
test('POST /api/fleet/jobs requires auth', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const res = await app.inject({ method: 'POST', url: '/api/fleet/jobs', payload: { boxIds: ['b1'], command: 'x' } });
  expect(res.statusCode).toBe(401);
});

test('POST /api/fleet/jobs rejects a cross-origin request', async () => {
  app = await makeApp({ fleetManager: fleetStub(), config: { publicUrl: 'https://tmux.example.com' } });
  const cookie = await login();
  const res = await app.inject({
    method: 'POST', url: '/api/fleet/jobs',
    headers: { cookie: `${cookie.name}=${cookie.value}`, origin: 'https://evil.example' },
    payload: { boxIds: ['b1'], command: 'x' },
  });
  expect(res.statusCode).toBe(403);
});

test('POST /api/fleet/jobs validates command and boxIds with 400', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const empty = await app.inject({ method: 'POST', url: '/api/fleet/jobs', headers, payload: { boxIds: ['b1'], command: '   ' } });
  expect(empty.statusCode).toBe(400);
  const noBoxes = await app.inject({ method: 'POST', url: '/api/fleet/jobs', headers, payload: { boxIds: [], command: 'x' } });
  expect(noBoxes.statusCode).toBe(400);
});

test('POST /api/fleet/jobs maps a createJob error to 400', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/fleet/jobs', headers, payload: { boxIds: ['bad'], command: 'x' } });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'unknown box: bad' });
});

test('POST /api/fleet/jobs creates a job and forwards boxIds + command', async () => {
  const calls = [];
  app = await makeApp({ fleetManager: fleetStub(calls) });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/fleet/jobs', headers, payload: { boxIds: ['b1', 'b2'], command: 'uptime' } });
  expect(res.statusCode).toBe(201);
  expect(res.json().id).toBe('job1');
  expect(calls).toContainEqual(['createJob', ['b1', 'b2'], 'uptime']);
});

test('GET /api/fleet/jobs lists job summaries', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const cookie = await login();
  const res = await app.inject({ method: 'GET', url: '/api/fleet/jobs', headers: { cookie: `${cookie.name}=${cookie.value}` } });
  expect(res.statusCode).toBe(200);
  expect(res.json()[0]).toMatchObject({ id: 'job1', okCount: 1 });
});

test('GET /api/fleet/jobs/:id returns the job or 404', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const ok = await app.inject({ method: 'GET', url: '/api/fleet/jobs/job1', headers });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().id).toBe('job1');
  const missing = await app.inject({ method: 'GET', url: '/api/fleet/jobs/nope', headers });
  expect(missing.statusCode).toBe(404);
});

test('POST /api/fleet/jobs/:id/cancel cancels or 404s', async () => {
  app = await makeApp({ fleetManager: fleetStub() });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const ok = await app.inject({ method: 'POST', url: '/api/fleet/jobs/job1/cancel', headers });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().status).toBe('cancelled');
  const missing = await app.inject({ method: 'POST', url: '/api/fleet/jobs/nope/cancel', headers });
  expect(missing.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.test.js -t fleet`
Expected: FAIL (routes 404 / not registered).

- [ ] **Step 3: Add `fleetManager` to `buildServer` params**

In `src/server/server.js`, change the destructured params of `buildServer` (line 50) to include `fleetManager`:

```js
export function buildServer({ config, store, sessions, statusChecker, statusPoller, boxActions, localShellActions, fleetManager, googleAuth, localSession = 'local', killLocalSession = killTmuxSession }) {
```

- [ ] **Step 4: Add the routes**

In `src/server/server.js`, immediately after the `app.post('/api/import', ...)` route (line 260) add:

```js
  app.post('/api/fleet/jobs', { preHandler: requireAuth }, async (req, reply) => {
    const { boxIds, command } = req.body || {};
    if (typeof command !== 'string' || !command.trim()) return reply.code(400).send({ error: 'command is required' });
    if (command.length > 4096) return reply.code(400).send({ error: 'command too long' });
    if (!Array.isArray(boxIds) || boxIds.length === 0) return reply.code(400).send({ error: 'select at least one box' });
    try {
      const job = await fleetManager.createJob({ boxIds, command });
      return reply.code(201).send(job);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });
  app.get('/api/fleet/jobs', { preHandler: requireAuth }, async () => fleetManager.listJobs());
  app.get('/api/fleet/jobs/:id', { preHandler: requireAuth }, async (req, reply) => {
    const job = fleetManager.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return job;
  });
  app.post('/api/fleet/jobs/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const job = fleetManager.cancelJob(req.params.id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return job;
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/server.test.js -t fleet`
Expected: PASS (all eight).

- [ ] **Step 6: Run the whole server suite (no regressions)**

Run: `npx vitest run test/server.test.js`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add src/server/server.js test/server.test.js
git commit -m "feat(fleet): add REST routes for fleet jobs"
```

---

### Task 8: Wire the fleet manager into the server entrypoint

**Files:**
- Modify: `src/server/index.js` (imports; construct `fleetStore` + `fleetManager`; pass to `buildServer`)

**Interfaces:**
- Consumes: `createFleetStore` (Task 3), `createFleetManager` (Tasks 4-6), `boxActions.execCommand` (Task 2), `config.fleet*` (Task 1).
- Produces: a wired `fleetManager` passed into `buildServer`.

- [ ] **Step 1: Add imports**

In `src/server/index.js`, after the `import { createBoxActions } from './boxActions.js';` line, add:

```js
import { createFleetStore } from './fleetStore.js';
import { createFleetManager } from './fleet.js';
```

- [ ] **Step 2: Construct the manager**

In `src/server/index.js`, after the `const localShellActions = createLocalShellActions();` line, add:

```js
const fleetStore = createFleetStore({ dataDir: config.dataDir });
const fleetManager = createFleetManager({
  store,
  execCommand: (box, command, opts) => boxActions.execCommand(box, command, opts),
  load: () => fleetStore.load(),
  save: (jobs) => fleetStore.save(jobs),
  concurrency: config.fleetConcurrency,
  timeoutMs: config.fleetTimeoutMs,
  maxJobs: config.fleetMaxJobs,
  maxOutputBytes: config.fleetMaxOutputBytes,
});
```

- [ ] **Step 3: Pass it to `buildServer`**

In `src/server/index.js`, change the `buildServer({ ... })` call to include `fleetManager`:

```js
const app = buildServer({ config, store, sessions, statusChecker, statusPoller, boxActions, localShellActions, fleetManager });
```

- [ ] **Step 4: Verify it boots and the full suite still passes**

Run: `node --check src/server/index.js`
Expected: no output (syntax OK).

Run: `npx vitest run`
Expected: PASS (entire suite — proves nothing else broke; the real exec path is covered by Task 9, the live UI by Task 16).

- [ ] **Step 5: Commit**

```bash
git add src/server/index.js
git commit -m "feat(fleet): wire fleet manager into the server entrypoint"
```

---

### Task 9: Integration test — real ssh, real capture

**Files:**
- Create: `test/fleet.integration.test.js`

**Interfaces:**
- Consumes: `setupLocalBox()` (test/helpers/localBox.js), real `sshRun`, real `createBoxActions`, real `createFleetManager`.

- [ ] **Step 1: Write the integration test**

Create `test/fleet.integration.test.js`:

```js
import { test, expect, afterEach } from 'vitest';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun } from '../src/server/sshRun.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { createFleetManager } from '../src/server/fleet.js';

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

async function harness() {
  const lb = await setupLocalBox();
  teardown = lb.cleanup;
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: lb.session };
  const store = { getBox: async (id) => (id === 'b1' ? box : undefined) };
  const boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    sshConfigFile: lb.sshConfigFile,
  });
  const mgr = createFleetManager({
    store,
    execCommand: (b, c, o) => boxActions.execCommand(b, c, o),
    timeoutMs: 12000,
  });
  return mgr;
}

test('runs a real command on a box and captures stdout + exit 0', async () => {
  const mgr = await harness();
  const job = await mgr.createJob({ boxIds: ['b1'], command: 'echo fleet-ok' });
  await mgr._settled(job.id);
  expect(job.status).toBe('done');
  expect(job.targets[0]).toMatchObject({ status: 'ok', code: 0 });
  expect(job.targets[0].stdout).toContain('fleet-ok');
});

test('captures a non-zero exit as an error target', async () => {
  const mgr = await harness();
  const job = await mgr.createJob({ boxIds: ['b1'], command: 'exit 3' });
  await mgr._settled(job.id);
  expect(job.targets[0]).toMatchObject({ status: 'error', code: 3 });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run test/fleet.integration.test.js`
Expected: PASS (requires a local sshd + key auth to localhost, same prerequisite as the other `*.integration.test.js`). If the environment has no sshd, note it and run in CI/an sshd-capable box — do **not** weaken the assertions.

- [ ] **Step 3: Commit**

```bash
git add test/fleet.integration.test.js
git commit -m "test(fleet): integration test for real ssh exec + capture"
```

---

### Task 10: Web API client methods + types

**Files:**
- Modify: `src/web/api.ts` (add types + 4 methods to the `api` object)

**Interfaces:**
- Produces (consumed by Tasks 13-15):
  - `FleetTargetStatus`, `FleetJobStatus`, `FleetTarget`, `FleetJob`, `FleetJobSummary` types.
  - `api.createFleetJob(boxIds: string[], command: string): Promise<FleetJob>`
  - `api.listFleetJobs(): Promise<FleetJobSummary[]>`
  - `api.getFleetJob(id: string): Promise<FleetJob>`
  - `api.cancelFleetJob(id: string): Promise<FleetJob>`

- [ ] **Step 1: Add the types**

In `src/web/api.ts`, after the `Status` interface (line 6), add:

```ts
export type FleetTargetStatus = 'pending' | 'running' | 'ok' | 'error' | 'cancelled' | 'interrupted';
export type FleetJobStatus = 'running' | 'done' | 'cancelled' | 'interrupted';
export interface FleetTarget {
  boxId: string; label: string; host: string; status: FleetTargetStatus;
  code: number | null; stdout: string; stderr: string; truncated: boolean;
  error: string | null; startedAt: string | null; finishedAt: string | null;
}
export interface FleetJob {
  id: string; command: string; status: FleetJobStatus;
  createdAt: string; startedAt: string; finishedAt: string | null;
  concurrency: number; timeoutMs: number; targets: FleetTarget[];
}
export interface FleetJobSummary {
  id: string; command: string; status: FleetJobStatus;
  createdAt: string; startedAt: string; finishedAt: string | null;
  targetCount: number; okCount: number; errorCount: number;
}
```

- [ ] **Step 2: Add the methods**

In `src/web/api.ts`, inside the `api` object, after the `reconnectLocalShell` method, add:

```ts
  async createFleetJob(boxIds: string[], command: string) {
    return j<FleetJob>(await fetch('/api/fleet/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boxIds, command }) }));
  },
  async listFleetJobs() { return j<FleetJobSummary[]>(await fetch('/api/fleet/jobs')); },
  async getFleetJob(id: string) { return j<FleetJob>(await fetch(`/api/fleet/jobs/${id}?t=${Date.now()}`)); },
  async cancelFleetJob(id: string) { return j<FleetJob>(await fetch(`/api/fleet/jobs/${id}/cancel`, { method: 'POST' })); },
```

- [ ] **Step 3: Verify the bundle still type-builds**

Run: `npm run build`
Expected: build succeeds (Vite/esbuild bundles `api.ts` with no errors).

- [ ] **Step 4: Commit**

```bash
git add src/web/api.ts
git commit -m "feat(fleet): add web api client methods for fleet jobs"
```

---

### Task 11: Pure selection helpers (`fleetSelection.ts`)

**Files:**
- Create: `src/web/fleetSelection.ts`
- Test: `test/fleetSelection.test.js`

**Interfaces:**
- Produces:
  - `toggleBox(selected: Set<string>, id: string): Set<string>` (returns a new set)
  - `setBoxes(selected: Set<string>, ids: string[], on: boolean): Set<string>` (returns a new set)
  - `groupState(selected: Set<string>, ids: string[]): 'none' | 'some' | 'all'`

- [ ] **Step 1: Write the failing tests**

Create `test/fleetSelection.test.js`:

```js
import { test, expect } from 'vitest';
import { toggleBox, setBoxes, groupState } from '../src/web/fleetSelection.ts';

test('toggleBox adds then removes an id without mutating the input', () => {
  const a = new Set();
  const b = toggleBox(a, 'x');
  expect([...b]).toEqual(['x']);
  expect([...a]).toEqual([]);        // original untouched
  expect([...toggleBox(b, 'x')]).toEqual([]);
});

test('setBoxes turns a group of ids on and off', () => {
  const on = setBoxes(new Set(['z']), ['a', 'b'], true);
  expect([...on].sort()).toEqual(['a', 'b', 'z']);
  const off = setBoxes(on, ['a', 'b'], false);
  expect([...off]).toEqual(['z']);
});

test('groupState reflects none / some / all', () => {
  expect(groupState(new Set(), ['a', 'b'])).toBe('none');
  expect(groupState(new Set(['a']), ['a', 'b'])).toBe('some');
  expect(groupState(new Set(['a', 'b']), ['a', 'b'])).toBe('all');
  expect(groupState(new Set(), [])).toBe('none'); // empty group
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/fleetSelection.test.js`
Expected: FAIL (`Cannot find module '.../fleetSelection.ts'`).

- [ ] **Step 3: Implement `fleetSelection.ts`**

Create `src/web/fleetSelection.ts`:

```ts
export function toggleBox(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function setBoxes(selected: Set<string>, ids: string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

export type GroupState = 'none' | 'some' | 'all';

export function groupState(selected: Set<string>, ids: string[]): GroupState {
  if (ids.length === 0) return 'none';
  let n = 0;
  for (const id of ids) if (selected.has(id)) n++;
  if (n === 0) return 'none';
  return n === ids.length ? 'all' : 'some';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/fleetSelection.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/web/fleetSelection.ts test/fleetSelection.test.js
git commit -m "feat(fleet): pure box-selection helpers for fleet mode"
```

---

### Task 12: Pure recent-command history helpers (`fleetHistory.ts`)

**Files:**
- Create: `src/web/fleetHistory.ts`
- Test: `test/fleetHistory.test.js`

**Interfaces:**
- Produces:
  - `addRecent(list: string[], cmd: string, max?: number): string[]` — trims `cmd`; if blank, returns `list` capped to `max`; else returns a new list with `cmd` deduped to the front, capped to `max` (default 10).
  - `parseRecent(raw: string | null, max?: number): string[]` — parses a JSON string array defensively, filtering non-strings, capped to `max`.

- [ ] **Step 1: Write the failing tests**

Create `test/fleetHistory.test.js`:

```js
import { test, expect } from 'vitest';
import { addRecent, parseRecent } from '../src/web/fleetHistory.ts';

test('addRecent moves a repeated command to the front (deduped) and caps length', () => {
  let list = [];
  list = addRecent(list, 'a');
  list = addRecent(list, 'b');
  list = addRecent(list, 'a');           // dedup -> front
  expect(list).toEqual(['a', 'b']);
  const capped = addRecent(['1', '2', '3'], '4', 3);
  expect(capped).toEqual(['4', '1', '2']);
});

test('addRecent ignores blank commands but still caps the existing list', () => {
  expect(addRecent(['a', 'b'], '   ')).toEqual(['a', 'b']);
  expect(addRecent(['a', 'b', 'c'], '', 2)).toEqual(['a', 'b']);
});

test('parseRecent reads a JSON array and tolerates garbage', () => {
  expect(parseRecent(JSON.stringify(['a', 'b']))).toEqual(['a', 'b']);
  expect(parseRecent(null)).toEqual([]);
  expect(parseRecent('not json')).toEqual([]);
  expect(parseRecent(JSON.stringify(['a', 1, null, 'b']))).toEqual(['a', 'b']);
  expect(parseRecent(JSON.stringify(['a', 'b', 'c']), 2)).toEqual(['a', 'b']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/fleetHistory.test.js`
Expected: FAIL (`Cannot find module '.../fleetHistory.ts'`).

- [ ] **Step 3: Implement `fleetHistory.ts`**

Create `src/web/fleetHistory.ts`:

```ts
const DEFAULT_MAX = 10;

export function addRecent(list: string[], cmd: string, max = DEFAULT_MAX): string[] {
  const c = cmd.trim();
  if (!c) return list.slice(0, max);
  return [c, ...list.filter((x) => x !== c)].slice(0, max);
}

export function parseRecent(raw: string | null, max = DEFAULT_MAX): string[] {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/fleetHistory.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/web/fleetHistory.ts test/fleetHistory.test.js
git commit -m "feat(fleet): pure recent-command history helpers"
```

---

### Task 13: Fleet mode toggle + selection UI

**Files:**
- Modify: `src/web/main.ts` (imports; module state; `renderDashboard` markup + handlers; `createBoxRow`; `paint` group header)
- Modify: `src/web/style.css` (append fleet selection styles)

**Interfaces:**
- Consumes: `toggleBox`, `setBoxes`, `groupState` (Task 11).
- Produces: module-level `fleetMode: boolean` and `fleetSelected: Set<string>`; a `#fleet-toggle` button; per-box `input.box-check` checkboxes and per-group `input.group-check` checkboxes shown only in fleet mode; a `renderFleetBar()` stub (filled in Task 14) and a `syncFleetUI()` that updates checkbox/indeterminate state + the run-button count.

This task wires selection; the command bar's Run behavior is stubbed here and completed in Task 14.

- [ ] **Step 1: Add imports and state**

In `src/web/main.ts`, after `import { dotClassFor, dotTitleFor } from './statusDot';` add:

```ts
import { toggleBox, setBoxes, groupState } from './fleetSelection';
```

After the `let latestStatus: Record<string, Status> = {};` line (line 14), add:

```ts
let fleetMode = false;
let fleetSelected = new Set<string>();
```

- [ ] **Step 2: Add the Fleet toggle button to the sidebar**

In `renderDashboard`, change the `.actions` div in the `app.innerHTML` template:

Find:
```ts
        <div class="actions"><button id="import">Import ~/.ssh/config</button><button id="add">+ Add box</button></div>
```
Replace with:
```ts
        <div class="actions"><button id="import">Import ~/.ssh/config</button><button id="add">+ Add box</button></div>
        <div class="fleet-actions"><button id="fleet-toggle" type="button" class="fleet-toggle">Fleet</button><button id="fleet-jobs" type="button" class="fleet-jobs-btn" title="Fleet job history">Jobs</button></div>
        <div id="fleet-bar" class="fleet-bar" hidden></div>
```

- [ ] **Step 3: Wire the toggle + jobs button handlers**

In `renderDashboard`, after the `app.querySelector('#search')!.addEventListener('input', () => filterAndPaint());` line, add:

```ts
  app.querySelector('#fleet-toggle')!.addEventListener('click', () => {
    fleetMode = !fleetMode;
    if (!fleetMode) fleetSelected = new Set();
    const layout = app.querySelector('.layout');
    if (layout) layout.classList.toggle('fleet-mode', fleetMode);
    (app.querySelector('#fleet-toggle') as HTMLElement).classList.toggle('active', fleetMode);
    const bar = app.querySelector('#fleet-bar') as HTMLElement;
    if (bar) bar.hidden = !fleetMode;
    renderFleetBar();
    filterAndPaint();
  });
  app.querySelector('#fleet-jobs')!.addEventListener('click', () => openFleetJobsPanel());
```

- [ ] **Step 4: Add `renderFleetBar` and `syncFleetUI` stubs**

In `src/web/main.ts`, add these functions (above `start()` at the end of the file). `renderFleetBar` is finished in Task 14; here it renders a minimal bar so selection is usable:

```ts
function selectedTargetLabels(): { id: string; label: string }[] {
  return allBoxes.filter((b) => fleetSelected.has(b.id)).map((b) => ({ id: b.id, label: b.label }));
}

function renderFleetBar() {
  const bar = app.querySelector('#fleet-bar') as HTMLElement | null;
  if (!bar) return;
  if (!fleetMode) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  // Replaced with the full command bar in Task 14. For now just the run button.
  bar.innerHTML = `<button id="fleet-run" type="button" class="fleet-run" disabled>Run on 0</button>`;
  syncFleetUI();
}

function syncFleetUI() {
  const count = fleetSelected.size;
  const run = app.querySelector('#fleet-run') as HTMLButtonElement | null;
  if (run) {
    run.textContent = `Run on ${count}`;
    run.disabled = count === 0;
  }
  // Reflect per-box + per-group checkbox state without a full repaint.
  app.querySelectorAll('input.box-check').forEach((el) => {
    const cb = el as HTMLInputElement;
    cb.checked = fleetSelected.has(cb.dataset.id || '');
  });
  app.querySelectorAll('.box-group').forEach((groupEl) => {
    const ids = Array.from(groupEl.querySelectorAll('input.box-check')).map((el) => (el as HTMLInputElement).dataset.id || '');
    const state = groupState(fleetSelected, ids);
    const gc = groupEl.querySelector('input.group-check') as HTMLInputElement | null;
    if (gc) { gc.checked = state === 'all'; gc.indeterminate = state === 'some'; }
  });
}
```

- [ ] **Step 5: Render a checkbox in each box row**

In `createBoxRow`, after `li.dataset.id = b.id;` add:

```ts
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'box-check';
  check.dataset.id = b.id;
  check.checked = fleetSelected.has(b.id);
  check.addEventListener('click', (e) => e.stopPropagation());
  check.addEventListener('change', () => {
    fleetSelected = toggleBox(fleetSelected, b.id);
    syncFleetUI();
  });
```

Change the final append in `createBoxRow` from:

```ts
  li.append(dotEl, nameEl, refreshBtn, edit, rm);
```
to:
```ts
  li.append(check, dotEl, nameEl, refreshBtn, edit, rm);
```

- [ ] **Step 6: Render a checkbox in each group header**

In `paint`, after the `const chevron = document.createElement('span'); ... header` block — specifically after `const chevron = ...; chevron.textContent = ...;` and before `const name = document.createElement('span');` — add:

```ts
    const groupCheck = document.createElement('input');
    groupCheck.type = 'checkbox';
    groupCheck.className = 'group-check';
    const groupIds = group.boxes.map((b) => b.id);
    const gState = groupState(fleetSelected, groupIds);
    groupCheck.checked = gState === 'all';
    groupCheck.indeterminate = gState === 'some';
    groupCheck.addEventListener('click', (e) => e.stopPropagation());
    groupCheck.addEventListener('change', () => {
      fleetSelected = setBoxes(fleetSelected, groupIds, groupCheck.checked);
      syncFleetUI();
    });
```

Change the header append from:
```ts
    header.append(chevron, name, count);
```
to:
```ts
    header.append(chevron, groupCheck, name, count);
```

- [ ] **Step 7: Keep the bar in sync after every repaint**

At the very end of `paint` (after the `for (const group of groupBoxes(boxes)) { ... }` loop closes, before the function ends), add:

```ts
  if (fleetMode) syncFleetUI();
```

- [ ] **Step 8: Add CSS**

Append to `src/web/style.css`:

```css
/* --- Fleet Command --- */
.fleet-actions { display: flex; gap: 6px; padding: 0 12px 8px; }
.fleet-actions button { flex: 1; }
.fleet-toggle.active { background: #2b6cb0; color: #fff; }
.box-check, .group-check { display: none; margin-right: 6px; flex: 0 0 auto; cursor: pointer; }
.layout.fleet-mode .box-check, .layout.fleet-mode .group-check { display: inline-block; }
.fleet-bar { padding: 8px 12px; border-top: 1px solid #2a2f3a; display: flex; flex-direction: column; gap: 6px; }
.fleet-run { width: 100%; padding: 8px; background: #2b6cb0; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
.fleet-run:disabled { opacity: 0.5; cursor: default; }
```

(Adjust colors to match the existing palette in `style.css` if they differ.)

- [ ] **Step 9: Add a temporary `openFleetJobsPanel` no-op so the build compiles**

`#fleet-jobs` references `openFleetJobsPanel`, completed in Task 15. Add this stub above `start()` for now:

```ts
function openFleetJobsPanel() { /* implemented in Task 15 */ }
```

- [ ] **Step 10: Build and manually verify selection**

Run: `npm run build`
Expected: build succeeds.

Manual check (optional but recommended): `npm start`, log in, click **Fleet**, confirm checkboxes appear, selecting boxes/groups updates the "Run on N" count and the group checkbox goes indeterminate/checked correctly.

- [ ] **Step 11: Commit**

```bash
git add src/web/main.ts src/web/style.css
git commit -m "feat(fleet): fleet-mode toggle and box/group selection UI"
```

---

### Task 14: Command bar, recent history, confirm dialog, create job

**Files:**
- Modify: `src/web/main.ts` (imports; flesh out `renderFleetBar`; add `openFleetConfirm`; add recent-history glue)
- Modify: `src/web/style.css` (append confirm + input styles)

**Interfaces:**
- Consumes: `addRecent`, `parseRecent` (Task 12); `api.createFleetJob` (Task 10); `openFleetJobsPanel`/`showFleetJob` (Task 15 — call sites added here, implementation lands in Task 15).
- Produces: a working fleet command bar (input + recent dropdown + Run button) that opens a confirm dialog and creates a job.

- [ ] **Step 1: Add imports + history glue**

In `src/web/main.ts`, after the `import { toggleBox, setBoxes, groupState } from './fleetSelection';` line add:

```ts
import { addRecent, parseRecent } from './fleetHistory';
```

After the `let fleetSelected = new Set<string>();` line add:

```ts
const FLEET_RECENT_KEY = 'tmuxifier.fleetRecent';
function readFleetRecent(): string[] { return parseRecent(localStorage.getItem(FLEET_RECENT_KEY)); }
function pushFleetRecent(cmd: string) {
  localStorage.setItem(FLEET_RECENT_KEY, JSON.stringify(addRecent(readFleetRecent(), cmd)));
}
```

- [ ] **Step 2: Replace `renderFleetBar` with the full bar**

In `src/web/main.ts`, replace the entire `renderFleetBar` function from Task 13 with:

```ts
function renderFleetBar() {
  const bar = app.querySelector('#fleet-bar') as HTMLElement | null;
  if (!bar) return;
  if (!fleetMode) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = '';

  const recent = readFleetRecent();
  const listId = 'fleet-recent';
  const datalist = document.createElement('datalist');
  datalist.id = listId;
  for (const cmd of recent) {
    const opt = document.createElement('option');
    opt.value = cmd;
    datalist.appendChild(opt);
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'fleet-input';
  input.placeholder = 'command to run on selected boxes…';
  input.setAttribute('list', listId);
  input.autocomplete = 'off';

  const run = document.createElement('button');
  run.type = 'button';
  run.id = 'fleet-run';
  run.className = 'fleet-run';
  run.textContent = `Run on ${fleetSelected.size}`;
  run.disabled = fleetSelected.size === 0;

  function submit() {
    const command = input.value.trim();
    if (!command || fleetSelected.size === 0) return;
    openFleetConfirm(command, selectedTargetLabels());
  }
  run.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

  bar.append(datalist, input, run);
  syncFleetUI();
}
```

- [ ] **Step 3: Add the confirm dialog + job creation**

In `src/web/main.ts`, add this function above `start()`:

```ts
function openFleetConfirm(command: string, targets: { id: string; label: string }[]) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const form = document.createElement('form');
  form.className = 'modal fleet-confirm';

  const title = document.createElement('h2');
  title.textContent = `Run on ${targets.length} box${targets.length === 1 ? '' : 'es'}?`;

  const cmd = document.createElement('pre');
  cmd.className = 'fleet-confirm-cmd';
  cmd.textContent = `$ ${command}`;

  const targetList = document.createElement('div');
  targetList.className = 'fleet-confirm-targets';
  targetList.textContent = targets.map((t) => t.label).join('  •  ');

  const err = document.createElement('p');
  err.className = 'err';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const confirm = document.createElement('button');
  confirm.type = 'submit';
  confirm.textContent = `Run on ${targets.length} box${targets.length === 1 ? '' : 'es'}`;
  actions.append(cancel, confirm);

  form.append(title, cmd, targetList, err, actions);
  backdrop.appendChild(form);
  app.appendChild(backdrop);

  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && pressedOnBackdrop) close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    confirm.disabled = true;
    try {
      const job = await api.createFleetJob(targets.map((t) => t.id), command);
      pushFleetRecent(command);
      close();
      openFleetJobsPanel(job.id); // jumps straight to the live job (Task 15)
    } catch (ex: any) {
      err.textContent = ex?.message || 'Could not start fleet job';
      confirm.disabled = false;
    }
  });
}
```

- [ ] **Step 4: Allow `openFleetJobsPanel` to accept an optional job id**

Update the Task 13 stub signature so this task compiles (Task 15 implements the body):

```ts
function openFleetJobsPanel(_jobId?: string) { /* implemented in Task 15 */ }
```

- [ ] **Step 5: Add CSS**

Append to `src/web/style.css`:

```css
.fleet-input { width: 100%; padding: 7px 9px; border-radius: 6px; border: 1px solid #2a2f3a; background: #11151c; color: inherit; }
.fleet-confirm-cmd { background: #11151c; border: 1px solid #2a2f3a; border-radius: 6px; padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
.fleet-confirm-targets { color: #9aa4b2; font-size: 0.9em; margin: 8px 0; }
```

- [ ] **Step 6: Build and manual smoke**

Run: `npm run build`
Expected: build succeeds.

Manual (optional): `npm start`, Fleet mode, select a box, type `uptime`, Run → confirm dialog shows the command + target list; Cancel closes; re-opening the input shows `uptime` in the recent datalist after a real run.

- [ ] **Step 7: Commit**

```bash
git add src/web/main.ts src/web/style.css
git commit -m "feat(fleet): command bar, recent history, and confirm dialog"
```

---

### Task 15: Jobs panel — live polling, results, cancel, history

**Files:**
- Modify: `src/web/index.html` (add a static `#fleet-panel`)
- Modify: `src/web/main.ts` (implement `openFleetJobsPanel`, plus `showFleetJob`, `pollFleetJob`, `renderFleetJob`, `renderFleetHistory`)
- Modify: `src/web/style.css` (append panel/result styles)

**Interfaces:**
- Consumes: `api.getFleetJob`, `api.listFleetJobs`, `api.cancelFleetJob` (Task 10); `FleetJob`, `FleetJobSummary` types.
- Produces: a slide-in jobs panel that lists recent jobs and shows a selected job's per-box results, polling every 1.5 s while the job is `running`, with a Cancel button.

- [ ] **Step 1: Add the static panel to the HTML shell**

In `src/web/index.html`, after the `#provision-panel` block (before the `<script ...>` tag), add:

```html
    <div id="fleet-panel" class="fleet-panel">
      <div class="fleet-panel-header">
        <span class="fleet-panel-title">Fleet jobs</span>
        <button class="fleet-panel-close" title="Close">&#x2715;</button>
      </div>
      <div class="fleet-panel-body">
        <ul class="fleet-history"></ul>
        <div class="fleet-detail"></div>
      </div>
    </div>
```

- [ ] **Step 2: Implement the panel logic**

In `src/web/main.ts`, **remove** the Task 13/14 `openFleetJobsPanel` stub and add these functions above `start()`:

```ts
let fleetPollTimer: any = null;

function stopFleetPoll() { if (fleetPollTimer) { clearTimeout(fleetPollTimer); fleetPollTimer = null; } }

function openFleetJobsPanel(jobId?: string) {
  const panel = document.getElementById('fleet-panel')!;
  panel.classList.add('open');
  const closeBtn = panel.querySelector('.fleet-panel-close') as HTMLElement;
  closeBtn.onclick = () => { stopFleetPoll(); panel.classList.remove('open'); };
  renderFleetHistory();
  if (jobId) showFleetJob(jobId);
  else (panel.querySelector('.fleet-detail') as HTMLElement).innerHTML = '<p class="fleet-empty">Select a job to see results.</p>';
}

async function renderFleetHistory() {
  const list = document.querySelector('#fleet-panel .fleet-history') as HTMLElement | null;
  if (!list) return;
  let jobs: import('./api').FleetJobSummary[] = [];
  try { jobs = await api.listFleetJobs(); } catch {}
  list.innerHTML = '';
  for (const s of jobs) {
    const li = document.createElement('li');
    li.className = 'fleet-history-item';
    li.dataset.id = s.id;
    li.innerHTML = `<span class="fh-cmd"></span><span class="fh-meta">${s.okCount}/${s.targetCount} ok · ${s.status}</span>`;
    (li.querySelector('.fh-cmd') as HTMLElement).textContent = s.command;
    li.addEventListener('click', () => showFleetJob(s.id));
    list.appendChild(li);
  }
}

async function showFleetJob(id: string) {
  stopFleetPoll();
  const detail = document.querySelector('#fleet-panel .fleet-detail') as HTMLElement | null;
  if (!detail) return;
  let job: import('./api').FleetJob;
  try { job = await api.getFleetJob(id); } catch { detail.innerHTML = '<p class="err">Could not load job.</p>'; return; }
  renderFleetJob(detail, job);
  if (job.status === 'running') fleetPollTimer = setTimeout(() => pollFleetJob(id), 1500);
}

async function pollFleetJob(id: string) {
  const detail = document.querySelector('#fleet-panel .fleet-detail') as HTMLElement | null;
  if (!detail) { stopFleetPoll(); return; }
  let job: import('./api').FleetJob;
  try { job = await api.getFleetJob(id); } catch { fleetPollTimer = setTimeout(() => pollFleetJob(id), 1500); return; }
  renderFleetJob(detail, job);
  if (job.status === 'running') fleetPollTimer = setTimeout(() => pollFleetJob(id), 1500);
  else { stopFleetPoll(); renderFleetHistory(); }
}

function renderFleetJob(detail: HTMLElement, job: import('./api').FleetJob) {
  detail.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'fleet-detail-head';
  const cmd = document.createElement('pre');
  cmd.className = 'fleet-confirm-cmd';
  cmd.textContent = `$ ${job.command}`;
  const status = document.createElement('span');
  status.className = `fleet-job-status ${job.status}`;
  status.textContent = job.status;
  head.append(cmd, status);
  detail.appendChild(head);

  if (job.status === 'running') {
    const cancel = document.createElement('button');
    cancel.className = 'fleet-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', async () => { cancel.disabled = true; try { await api.cancelFleetJob(job.id); } catch {} });
    detail.appendChild(cancel);
  }

  for (const t of job.targets) {
    const row = document.createElement('div');
    row.className = `fleet-result ${t.status}`;
    const top = document.createElement('div');
    top.className = 'fleet-result-top';
    const name = document.createElement('span');
    name.className = 'fr-label';
    name.textContent = t.label;
    const badge = document.createElement('span');
    badge.className = 'fr-badge';
    badge.textContent = t.status === 'ok' ? 'exit 0'
      : t.status === 'error' ? (t.code != null ? `exit ${t.code}` : (t.error || 'error'))
      : t.status; // running | pending | cancelled | interrupted
    top.append(name, badge);
    row.appendChild(top);

    const body = (t.stdout || '') + (t.stderr ? `\n${t.stderr}` : '');
    if (body.trim()) {
      const out = document.createElement('pre');
      out.className = 'fr-output';
      out.textContent = body + (t.truncated ? '\n… (truncated)' : '');
      row.appendChild(out);
    }
    detail.appendChild(row);
  }
}
```

- [ ] **Step 3: Stop polling when leaving the dashboard**

In `renderDashboard`, in the `#logout` click handler, add `stopFleetPoll();` next to the existing `clearInterval(pollInterval)`:

```ts
  app.querySelector('#logout')!.addEventListener('click', async () => {
    if (pollInterval) clearInterval(pollInterval);
    stopFleetPoll();
    await api.logout(); await renderLogin();
  });
```

- [ ] **Step 4: Add CSS**

Append to `src/web/style.css`:

```css
.fleet-panel { position: fixed; top: 0; right: 0; width: min(560px, 92vw); height: 100vh; background: #0d1117; border-left: 1px solid #2a2f3a; transform: translateX(100%); transition: transform 0.2s ease; z-index: 50; display: flex; flex-direction: column; }
.fleet-panel.open { transform: translateX(0); }
.fleet-panel-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-bottom: 1px solid #2a2f3a; }
.fleet-panel-body { flex: 1; overflow-y: auto; padding: 12px 14px; }
.fleet-history { list-style: none; margin: 0 0 14px; padding: 0; }
.fleet-history-item { display: flex; justify-content: space-between; gap: 10px; padding: 7px 9px; border-radius: 6px; cursor: pointer; }
.fleet-history-item:hover { background: #161b22; }
.fh-cmd { font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fh-meta { color: #9aa4b2; font-size: 0.85em; flex: 0 0 auto; }
.fleet-detail-head { display: flex; align-items: center; gap: 10px; }
.fleet-job-status { text-transform: uppercase; font-size: 0.75em; padding: 2px 6px; border-radius: 4px; background: #21262d; }
.fleet-cancel { margin: 8px 0; padding: 5px 10px; }
.fleet-result { border: 1px solid #2a2f3a; border-radius: 6px; margin: 8px 0; padding: 8px; }
.fleet-result-top { display: flex; justify-content: space-between; align-items: center; }
.fr-badge { font-size: 0.8em; padding: 1px 6px; border-radius: 4px; background: #21262d; }
.fleet-result.ok .fr-badge { background: #1a4731; color: #7ee2a8; }
.fleet-result.error .fr-badge { background: #4a1f24; color: #f1a0a8; }
.fr-output { margin: 6px 0 0; max-height: 240px; overflow: auto; background: #11151c; border-radius: 4px; padding: 8px; white-space: pre-wrap; word-break: break-all; }
.fleet-empty, .fleet-detail .err { color: #9aa4b2; }
```

- [ ] **Step 5: Build and manual verify the full loop**

Run: `npm run build`
Expected: build succeeds.

Manual (recommended): `npm start`, Fleet mode → select a box → `uptime` → Run → confirm → panel opens, row shows `running` then flips to `exit 0` with output; the **Jobs** button reopens the panel and lists the job; reloading the page mid-run and clicking **Jobs** still finds the job.

- [ ] **Step 6: Commit**

```bash
git add src/web/index.html src/web/main.ts src/web/style.css
git commit -m "feat(fleet): live jobs panel with results, cancel, and history"
```

---

### Task 16: End-to-end Playwright test

**Files:**
- Create: `test/e2e/fleet.spec.ts`

**Interfaces:**
- Consumes: the seeded boxes from `test/e2e/global-setup.js` (`localhost`/`db-primary` under tag `Prod`, key-auth to localhost) and the running server it spawns.

- [ ] **Step 1: Write the e2e spec**

Create `test/e2e/fleet.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

async function loginAndWait(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test('fleet command runs on a selected box and shows captured output', async ({ page }) => {
  await loginAndWait(page);

  await page.getByRole('button', { name: 'Fleet', exact: true }).click();

  // Select the localhost box (key-auth works for one-shot exec)
  await page.locator('.box', { hasText: 'localhost' }).locator('input.box-check').check();

  await page.locator('.fleet-input').fill('echo FLEET_E2E_MARKER');
  await page.locator('#fleet-run').click();

  // Confirm dialog
  await expect(page.getByRole('heading', { name: /Run on 1 box/ })).toBeVisible();
  await page.getByRole('button', { name: /^Run on 1 box$/ }).click();

  // Jobs panel shows the captured output and a zero exit
  const detail = page.locator('#fleet-panel .fleet-detail');
  await expect(detail).toContainText('FLEET_E2E_MARKER', { timeout: 20000 });
  await expect(detail.locator('.fleet-result.ok .fr-badge')).toHaveText('exit 0');
});

test('a finished fleet job is findable from the Jobs button after a reload', async ({ page }) => {
  await loginAndWait(page);
  await page.getByRole('button', { name: 'Fleet', exact: true }).click();
  await page.locator('.box', { hasText: 'localhost' }).locator('input.box-check').check();
  await page.locator('.fleet-input').fill('echo SECOND_RUN_MARKER');
  await page.locator('#fleet-run').click();
  await page.getByRole('button', { name: /^Run on 1 box$/ }).click();
  await expect(page.locator('#fleet-panel .fleet-detail')).toContainText('SECOND_RUN_MARKER', { timeout: 20000 });

  // Reload — the server kept the job; the Jobs button must list it
  await page.reload();
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  const history = page.locator('#fleet-panel .fleet-history');
  await expect(history).toContainText('echo SECOND_RUN_MARKER', { timeout: 10000 });
  await history.locator('.fleet-history-item', { hasText: 'SECOND_RUN_MARKER' }).first().click();
  await expect(page.locator('#fleet-panel .fleet-detail')).toContainText('SECOND_RUN_MARKER');
});
```

- [ ] **Step 2: Build the bundle (e2e serves dist/)**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Run the e2e**

Run: `npm run test:e2e -- fleet.spec.ts`
Expected: PASS (both). Requires the sshd-backed local box the global setup provisions. If sshd is unavailable in this environment, note it and run on an sshd-capable box/CI — do not weaken assertions.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/fleet.spec.ts
git commit -m "test(fleet): e2e for run, results, and history after reload"
```

---

### Task 17: README feature section + full verification

**Files:**
- Modify: `README.md` (add a short "Fleet Command" feature paragraph near the other feature/security notes)

- [ ] **Step 1: Document the feature**

In `README.md`, add a short subsection (place it near the existing feature/usage prose; keep PII-free):

```markdown
### Fleet Command

Click **Fleet** in the sidebar to enter selection mode, tick any number of boxes (or whole tag
groups), type a command, and **Run**. The command runs once on each selected box over the same
non-interactive SSH path used for status probes, and each box's exit code and output are captured
centrally. Each run is a **job** held on the server: close the tab and the run keeps going —
reopen the dashboard and the **Jobs** button lists recent jobs with their per-box results. Jobs
are persisted to `data/fleet-jobs.json` (last `TMUXIFIER_FLEET_MAX_JOBS`, default 50). The fan-out
is capped at `TMUXIFIER_FLEET_CONCURRENCY` (default 4) so a fleet-wide run never bursts SSH
connections. Password-only boxes with no live connection come back as a per-box error (the
non-interactive path can't answer a password prompt) — open that box's terminal once to establish
the connection, then re-run.
```

- [ ] **Step 2: Run the full unit + integration suite**

Run: `npx vitest run`
Expected: PASS (entire suite).

- [ ] **Step 3: Build the production bundle**

Run: `npm run build`
Expected: build succeeds, `dist/` regenerated.

- [ ] **Step 4: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS (existing specs + the new fleet spec).

- [ ] **Step 5: PII scrub + commit**

```bash
git add README.md
git diff --cached   # review: no real domains/IPs/emails/hostnames
git commit -m "docs(fleet): document the Fleet Command feature"
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- One-shot exec + captured output → Task 2 (`execCommand`), Task 4 (capture), Task 9 (real ssh).
- Verbatim (un-quoted) command, `assertBoxSafe` enforced → Task 2 (tests assert both).
- Job + poll architecture, server-side registry → Tasks 4-7, Task 15 (1.5 s poll).
- Persistence to `data/fleet-jobs.json`, prune to 50, `running→interrupted` reconciliation → Task 3, Task 4 (prune), Task 6 (reconcile).
- Cancel → Task 5 (manager), Task 7 (route), Task 15 (UI button).
- Bounded concurrency → Task 4 (test), Task 8 (wired from config).
- Config knobs → Task 1.
- REST API (4 routes, auth/CSRF, 400/404) → Task 7.
- Fleet-mode toggle + per-box + tri-state group selection → Task 11 (pure), Task 13 (UI).
- Command bar + recent history (localStorage) → Task 12 (pure), Task 14 (UI).
- Confirm-with-preview, always → Task 14.
- Jobs panel (live results, cancel) + history for browser-death recovery → Task 15, Task 16 (reload e2e).
- Output capping/truncation → Task 4.
- Per-box error rows for password/unreachable boxes → Task 4 (thrown/non-zero → error), Task 17 (documented).
- Tests in the right places → Tasks include unit (fleet/fleetStore/config/boxActions/fleetSelection/fleetHistory), server route, integration, e2e.
- Docs (`.env.example`, README table + feature blurb, CLAUDE.md/AGENTS.md `data/` note) → Tasks 1, 3, 17.

**Placeholder scan:** No "TBD/TODO/handle edge cases" — every code step has complete code. (Tasks 13-14 intentionally introduce `openFleetJobsPanel`/`renderFleetBar` stubs that are *replaced with full code* in later steps/tasks; each stub is shown in full so the bundle always compiles.)

**Type consistency:** `execCommand(box, command, { timeoutMs })` is identical in Tasks 2, 8, 9. Job/target field names match the Global Constraints model across Tasks 3-7, 10, 15. `createJob/getJob/listJobs/cancelJob/_settled` names match across Tasks 4-9. Web helper names (`toggleBox/setBoxes/groupState`, `addRecent/parseRecent`) match across Tasks 11-14. API method names (`createFleetJob/listFleetJobs/getFleetJob/cancelFleetJob`) match across Tasks 10, 14, 15, 16. CSS/DOM class names (`.box-check`, `.group-check`, `.fleet-input`, `#fleet-run`, `.fleet-result`, `.fleet-history`, `#fleet-panel`) match between Tasks 13-15 and the e2e selectors in Task 16.
