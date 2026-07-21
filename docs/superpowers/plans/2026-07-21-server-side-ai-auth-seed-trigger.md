# Server-side AI-auth seed trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the AI-auth seed trigger out of the browser poll loop into `setupManager`, so a setup job seeds itself before reaching `done` and records the per-target outcome on the job.

**Architecture:** `createSetupManager` gains two injected dependencies, `seed` and `getBox`, both defaulting to `null` so an unwired manager behaves exactly as today. A single internal `completeDone(j, box)` becomes the only place a job becomes `done`; it runs the seed under a new `seeding` phase, stores the result on `j.seed`, then finishes. Both routes to `done` — the non-interactive ssh exit and `markInteractiveResult` — go through it. The two browser call sites stop calling `POST /api/boxes/:id/seed-ai-auth` and render `job.seed` from the poll instead.

**Tech Stack:** Node 20+, ESM, plain `.js` on the server, TypeScript on the web client, Fastify, vitest, `tsc --noEmit`, Vite.

**Spec:** `docs/superpowers/specs/2026-07-21-server-side-ai-auth-seed-trigger-design.md`

## Global Constraints

- ESM everywhere (`"type": "module"`); Node 20+.
- Server is plain `.js`; web client is `.ts`.
- TDD: write the failing test first, run it, watch it fail, then implement.
- Tests use **real code, not mocks** — the dependency-injection factories are what make this possible. Injected fakes (plain functions) are fine; mocking libraries are not.
- Web-side unit tests target **pure helpers**, not DOM rendering. Do not add jsdom or a DOM-rendering test harness.
- `npm test` runs `npm run typecheck && vitest run`. Both must pass before each commit.
- Conventional-commit style messages (`feat(setup): …`, `refactor(ui): …`).
- Secrets rule: `j.seed` may contain only the seeder's fixed strings (target names, booleans, the three hardcoded skip reasons, the literal `'seed failed'`). Never store ssh stderr, tokens, or file contents on the job.
- A seed failure must never change the job's status away from `done`, and must never populate `j.error`.

## File Structure

| File | Responsibility |
|---|---|
| `src/server/setupManager.js` (modify) | The whole server-side change: `seed`/`getBox` injections, `completeDone()`, `normalizeOptions` keeping `seedAiAuth`, `summary()` carrying `seed`, async `markInteractiveResult` with a synchronous re-entrancy flip. |
| `src/server/index.js` (modify) | Composition root: wire `seed` and `getBox` into `createSetupManager`. |
| `src/server/server.js` (modify) | `POST /api/boxes/:id/setup` accepts `seedAiAuth`. |
| `src/web/api.ts` (modify) | Types: `SetupOptions.seedAiAuth`, `SetupSummary.seed`, the `seeding` phase, `SeedResult.target` widened to include `'all'`. |
| `src/web/setupStatus.ts` (modify) | New pure `formatSeedResults()`; `setupStatusText` learns the `seeding` phase. |
| `src/web/main.ts` (modify) | Provision panel: send `seedAiAuth`, render `job.seed`, drop the seed request and its guards. |
| `src/web/proxmoxUi.ts` (modify) | Hub Provision tab: same render change. |
| `test/setupManager.test.js` (modify) | Server behavior: cases 1-10 of the spec. |
| `test/setupRoutes.test.js` (modify) | Route forwards the flag. |
| `test/setupStatus.test.js` (modify) | `formatSeedResults()` and the `seeding` phase text. |
| `CLAUDE.md`, `AGENTS.md` (modify) | Keep the architecture notes accurate. |

---

### Task 1: Seed on the non-interactive path

**Files:**
- Modify: `src/server/setupManager.js:16-33` (factory signature), `:75-77` (`normalizeOptions`), `:73` (`summary`), `:138` (`finish(j, 'done')` on success)
- Test: `test/setupManager.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `createSetupManager({ …, seed = null, getBox = null })` where `seed: (box) => Promise<Array<{target: string, ok: boolean, skipped?: string, error?: string}>>` and `getBox: (boxId) => Promise<box|null>`.
  - `completeDone(j, box): Promise<void>` — internal, used by Task 2.
  - Job field `j.seed` — the seeder's array, or absent when no seed ran.
  - `summary(j).seed` — `j.seed ?? null`.
  - `normalizeOptions` output gains `seedAiAuth: boolean`.

- [ ] **Step 1: Add the shared wait helper to the test file**

At the top of `test/setupManager.test.js`, directly under the existing `sudoSsh` definition, add:

```js
// Polls a predicate instead of counting microtasks: the seed step introduces a
// real await chain, and "await Promise.resolve() three times" would be a guess.
async function waitFor(fn, ms = 1000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
```

- [ ] **Step 2: Write the failing tests**

Append to `test/setupManager.test.js`:

```js
test('seeds before done, records the result, and exposes it on the summary', async () => {
  const seen = [];
  const m = make({ seed: async (box) => { seen.push(box.id); return [{ target: 'claude', ok: true }]; } });
  const s = m.start(BOX, { tools: [], seedAiAuth: true });
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(seen).toEqual(['b1']);
  expect(job.seed).toEqual([{ target: 'claude', ok: true }]);
  expect(job.status).toBe('done');
  expect(m.listJobs()[0].seed).toEqual([{ target: 'claude', ok: true }]);
});

test('phase is seeding while the seed is in flight; done only after it settles', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = make({ seed: async () => { await gate; return [{ target: 'codex', ok: true }]; } });
  const s = m.start(BOX, { tools: [], seedAiAuth: true });
  await waitFor(() => m.getJob(s.id).phase === 'seeding');
  expect(m.getJob(s.id).status).toBe('running');
  release();
  await m._settled(s.id);
  expect(m.getJob(s.id).status).toBe('done');
  expect(m.getJob(s.id).phase).toBe(null);
});

test('seedAiAuth off: the seed never runs', async () => {
  let calls = 0;
  const m = make({ seed: async () => { calls += 1; return []; } });
  const s = m.start(BOX, { tools: [] });
  await m._settled(s.id);
  expect(calls).toBe(0);
  expect(m.getJob(s.id).seed).toBeUndefined();
  expect(m.getJob(s.id).status).toBe('done');
});

test('no seeder wired: seedAiAuth is skipped rather than failing', async () => {
  const m = make();
  const s = m.start(BOX, { tools: [], seedAiAuth: true });
  await m._settled(s.id);
  expect(m.getJob(s.id).status).toBe('done');
  expect(m.getJob(s.id).seed).toBeUndefined();
});

test('a rejecting seed is recorded but never fails the job', async () => {
  const m = make({ seed: async () => { throw new Error('boom'); } });
  const s = m.start(BOX, { tools: [], seedAiAuth: true });
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(job.seed).toEqual([{ target: 'all', ok: false, error: 'seed failed' }]);
  expect(job.error).toBe(null);
  expect(JSON.stringify(job)).not.toContain('boom');
});

test('seed survives save -> load into a fresh manager', async () => {
  const rows = [];
  const m = make({
    save: (jobs) => { rows.length = 0; rows.push(...jobs); },
    seed: async () => [{ target: 'claude', ok: true }],
  });
  const s = m.start(BOX, { tools: [], seedAiAuth: true });
  await m._settled(s.id);
  const m2 = make({ load: () => JSON.parse(JSON.stringify(rows)) });
  expect(m2.getJob(s.id).seed).toEqual([{ target: 'claude', ok: true }]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/setupManager.test.js`
Expected: FAIL. The first test fails on `expect(seen).toEqual(['b1'])` receiving `[]` — nothing calls `seed` yet.

- [ ] **Step 4: Accept the injections**

In `src/server/setupManager.js`, add two parameters to the `createSetupManager` destructured argument, immediately after `probe = async () => true,`:

```js
  probe = async () => true,
  // Post-setup AI-auth seeding. Both default to null: an unwired manager skips
  // the step entirely, which is also what every existing test constructs.
  seed = null,
  getBox = null,
```

- [ ] **Step 5: Keep the flag through normalizeOptions and expose it on the summary**

Replace `normalizeOptions` (setupManager.js:75-77):

```js
  function normalizeOptions(o = {}) {
    return {
      ohMyTmux: !!o.ohMyTmux, ohMyZsh: !!o.ohMyZsh, ohMyBash: !!o.ohMyBash,
      tools: Array.isArray(o.tools) ? o.tools : [],
      seedAiAuth: !!o.seedAiAuth,
    };
  }
```

Replace `summary` (setupManager.js:73) so the list endpoint carries the outcome:

```js
  function summary(j) {
    return { id: j.id, boxId: j.boxId, boxLabel: j.boxLabel, status: j.status, phase: j.phase, options: j.options, error: j.error, seed: j.seed ?? null, createdAt: j.createdAt, finishedAt: j.finishedAt };
  }
```

- [ ] **Step 6: Add completeDone and route the success path through it**

Insert `completeDone` immediately after the existing `finish` function (setupManager.js:80-86):

```js
  // The one place a job becomes 'done'. Seeding runs here rather than in the
  // browser so closing the tab can't silently skip it (the whole point of this
  // change), and it runs BEFORE the status flip because setupPoller stops
  // polling the moment it reads a terminal status.
  //
  // A seed failure is recorded, never promoted: setup itself succeeded, and a
  // missing host credential must not turn a good box red. j.cancelled means the
  // box is on its way out (usually removal), so seeding it is pointless.
  async function completeDone(j, box) {
    if (seed && j.options.seedAiAuth && box && !j.cancelled) {
      j.phase = 'seeding';
      persist();
      try {
        j.seed = await seed(box);
      } catch {
        // Never echo the rejection: it could carry secret-adjacent material,
        // and 'all' means the step died before per-target results existed.
        j.seed = [{ target: 'all', ok: false, error: 'seed failed' }];
      }
    }
    finish(j, 'done');
  }
```

Then, in `run()`, replace line 138:

```js
      if (code === 0) finish(j, 'done');
```

with:

```js
      if (code === 0) await completeDone(j, box);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/setupManager.test.js`
Expected: PASS — all pre-existing cases plus the six new ones.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS. Nothing else constructs a manager with `seed`, so every other suite exercises the skip path.

- [ ] **Step 9: Commit**

```bash
git add src/server/setupManager.js test/setupManager.test.js
git commit -m "feat(setup): seed AI auth inside the setup job before it reaches done"
```

---

### Task 2: Seed on the interactive path

**Files:**
- Modify: `src/server/setupManager.js:176-181` (`markInteractiveResult`)
- Test: `test/setupManager.test.js`

**Interfaces:**
- Consumes: `completeDone(j, box)` and the `seed`/`getBox` injections from Task 1.
- Produces: `markInteractiveResult(boxId, code)` — still returns `undefined` synchronously (server.js:1288 calls it from a PTY exit handler that cannot await), but now registers its continuation in `settles` so `_settled(id)` covers it.

- [ ] **Step 1: Write the failing tests**

Append to `test/setupManager.test.js`:

```js
const SUDO = 'sudo: a terminal is required to read the password; see below\n';

test('interactive finish seeds via getBox, then reaches done', async () => {
  let asked = null;
  const m = make({
    sshStream: sudoSsh(SUDO, 1),
    getBox: async (id) => { asked = id; return BOX; },
    seed: async () => [{ target: 'codex', ok: true }],
  });
  const s = m.start(BOX, { tools: [], seedAiAuth: true });
  await m._settled(s.id);
  expect(m.getJob(s.id).status).toBe('needs-interactive');

  m.markInteractiveResult(BOX.id, 0);
  await m._settled(s.id);
  expect(asked).toBe('b1');
  expect(m.getJob(s.id).seed).toEqual([{ target: 'codex', ok: true }]);
  expect(m.getJob(s.id).status).toBe('done');
});

test('a second interactive result during the seed does not seed twice', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = make({
    sshStream: sudoSsh(SUDO, 1),
    getBox: async () => BOX,
    seed: async () => { calls += 1; await gate; return [{ target: 'claude', ok: true }]; },
  });
  const s = m.start(BOX, { tools: [], seedAiAuth: true });
  await m._settled(s.id);

  m.markInteractiveResult(BOX.id, 0);
  m.markInteractiveResult(BOX.id, 0);
  release();
  await m._settled(s.id);
  expect(calls).toBe(1);
  expect(m.getJob(s.id).status).toBe('done');
});

test('box deleted before the interactive finish: done without seeding', async () => {
  let calls = 0;
  const m = make({
    sshStream: sudoSsh(SUDO, 1),
    getBox: async () => null,
    seed: async () => { calls += 1; return []; },
  });
  const s = m.start(BOX, { tools: [], seedAiAuth: true });
  await m._settled(s.id);
  m.markInteractiveResult(BOX.id, 0);
  await m._settled(s.id);
  expect(calls).toBe(0);
  expect(m.getJob(s.id).status).toBe('done');
});

test('a getBox that throws still lets the job finish', async () => {
  let calls = 0;
  const m = make({
    sshStream: sudoSsh(SUDO, 1),
    getBox: async () => { throw new Error('store offline'); },
    seed: async () => { calls += 1; return []; },
  });
  const s = m.start(BOX, { tools: [], seedAiAuth: true });
  await m._settled(s.id);
  m.markInteractiveResult(BOX.id, 0);
  await m._settled(s.id);
  expect(calls).toBe(0);
  expect(m.getJob(s.id).status).toBe('done');
});

test('cancel arriving after the script exits skips the seed', async () => {
  let calls = 0;
  let finishSsh;
  const ssh = () => ({ done: new Promise((r) => { finishSsh = () => r({ code: 0 }); }), kill() {} });
  const m = make({ sshStream: ssh, seed: async () => { calls += 1; return []; } });
  const s = m.start(BOX, { tools: [], seedAiAuth: true });
  m.cancelForBox(BOX.id);
  finishSsh();
  await m._settled(s.id);
  expect(calls).toBe(0);
  expect(m.getJob(s.id).status).toBe('done');
});

test('a non-zero interactive result still leaves the job needs-interactive', async () => {
  let calls = 0;
  const m = make({
    sshStream: sudoSsh(SUDO, 1),
    getBox: async () => BOX,
    seed: async () => { calls += 1; return []; },
  });
  const s = m.start(BOX, { tools: [], seedAiAuth: true });
  await m._settled(s.id);
  m.markInteractiveResult(BOX.id, 1);
  await m._settled(s.id);
  expect(calls).toBe(0);
  expect(m.getJob(s.id).status).toBe('needs-interactive');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/setupManager.test.js`
Expected: FAIL. `interactive finish seeds via getBox` fails on `expect(asked).toBe('b1')` receiving `null` — the current `markInteractiveResult` flips straight to `done` without consulting anything.

- [ ] **Step 3: Rewrite markInteractiveResult**

Replace `markInteractiveResult` (setupManager.js:176-181) entirely:

```js
  function markInteractiveResult(boxId, code) {
    const j = currentForBox(boxId);
    if (!j || j.status !== 'needs-interactive') return;
    // non-zero: cancelled or still-failing — stays needs-interactive (retryable).
    if (code !== 0) return;
    // Flip SYNCHRONOUSLY, before the first await below. The guard above is the
    // only thing stopping a second PTY exit event from re-entering, and without
    // this the status would stay 'needs-interactive' for the whole seed round
    // trip — long enough to seed the same box twice.
    j.status = 'running';
    j.phase = 'running';
    persist();
    const p = (async () => {
      let box = null;
      // A deleted box (or a store that errors) must not strand the job: seeding
      // is skipped, the job still reaches done.
      try { box = getBox ? await getBox(boxId) : null; } catch { box = null; }
      await completeDone(j, box);
    })();
    settles.set(j.id, p);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/setupManager.test.js`
Expected: PASS, including the pre-existing `markInteractiveResult(0) -> done; non-zero leaves needs-interactive` case.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/setupManager.js test/setupManager.test.js
git commit -m "feat(setup): seed after an interactive finish, guarded against re-entry"
```

---

### Task 3: Accept the flag at the route and wire the seeder

**Files:**
- Modify: `src/server/server.js:851` (setup route options), `src/server/index.js:101-111` (manager construction)
- Test: `test/setupRoutes.test.js`

**Interfaces:**
- Consumes: `createSetupManager({ seed, getBox })` from Task 1.
- Produces: `POST /api/boxes/:id/setup` forwards `seedAiAuth` into `setupManager.start`. No new exports.

- [ ] **Step 1: Write the failing tests**

Append to `test/setupRoutes.test.js`:

```js
test('setup route forwards seedAiAuth', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${BOX.id}/setup`, headers: h, payload: { seedAiAuth: true } });
  expect(res.statusCode).toBe(201);
  expect(sm._started[0].options.seedAiAuth).toBe(true);
});

test('setup route defaults seedAiAuth to false', async () => {
  const h = await headers();
  await app.inject({ method: 'POST', url: `/api/boxes/${BOX.id}/setup`, headers: h, payload: { ohMyTmux: true } });
  expect(sm._started[0].options.seedAiAuth).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/setupRoutes.test.js`
Expected: FAIL with `expected undefined to be true` — the route builds its options object without the flag.

- [ ] **Step 3: Add the flag to the route**

In `src/server/server.js`, replace line 851:

```js
    const options = { ohMyTmux: !!b.ohMyTmux, ohMyZsh: !!b.ohMyZsh, ohMyBash: !!b.ohMyBash, tools };
```

with:

```js
    const options = { ohMyTmux: !!b.ohMyTmux, ohMyZsh: !!b.ohMyZsh, ohMyBash: !!b.ohMyBash, tools, seedAiAuth: !!b.seedAiAuth };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/setupRoutes.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the seeder into the manager**

In `src/server/index.js`, the `createSetupManager({…})` call at line 101 currently ends with `controlPersist: config.controlPersist,`. Add two entries before the closing `});`:

```js
  controlPersist: config.controlPersist,
  // Post-setup AI-auth seeding: the job seeds itself on reaching done, so a
  // closed browser tab can no longer skip it. getBox is only needed for the
  // interactive finish path, which knows a boxId and nothing else.
  seed: (box) => aiAuthSeeder.seed(box),
  getBox: (id) => store.getBox(id),
});
```

Both bindings already exist above this call — `store` is created at index.js:53 and `aiAuthSeeder` at index.js:96, so no reordering is needed.

- [ ] **Step 6: Verify the server still boots**

Run: `node -e "import('./src/server/index.js').catch((e) => { console.error(e); process.exit(1); })" & sleep 3; kill %1`

Expected: no import/reference error printed. (This starts the real server briefly; if the port is already taken by the running service it will exit with an EADDRINUSE message, which still proves the module graph and the new bindings resolve.)

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/server.js src/server/index.js test/setupRoutes.test.js
git commit -m "feat(setup): accept seedAiAuth at the setup route and wire the seeder"
```

---

### Task 4: Client types and the pure formatter

**Files:**
- Modify: `src/web/api.ts:58-66`, `src/web/setupStatus.ts:1-12`
- Test: `test/setupStatus.test.js`

**Interfaces:**
- Consumes: the server's `seed` field shape from Task 1.
- Produces:
  - `SetupOptions` gains `seedAiAuth?: boolean`.
  - `SetupSummary` gains `seed?: SeedResult[] | null` and the `'seeding'` phase.
  - `SeedResult.target` becomes `'claude' | 'codex' | 'all'`.
  - `formatSeedResults(seed: SeedResult[] | null | undefined): string` exported from `setupStatus.ts` — Task 5 consumes it.

- [ ] **Step 1: Write the failing tests**

In `test/setupStatus.test.js`, change the import line to include the new helper:

```js
import { setupStatusText, setupActions, setupBadge, formatSeedResults } from '../src/web/setupStatus.ts';
```

Then append:

```js
test('seed results render one segment per target', () => {
  expect(formatSeedResults([
    { target: 'claude', ok: true },
    { target: 'codex', ok: false, skipped: 'no codex auth on the Tmuxifier host' },
  ])).toBe('claude ✓ · codex skipped (no codex auth on the Tmuxifier host)');
});

test('seed results render failures, including the whole-step marker', () => {
  expect(formatSeedResults([{ target: 'all', ok: false, error: 'seed failed' }])).toBe('all failed (seed failed)');
  expect(formatSeedResults([{ target: 'claude', ok: false }])).toBe('claude failed (failed)');
});

test('seed results are empty for jobs that never seeded', () => {
  expect(formatSeedResults([])).toBe('');
  expect(formatSeedResults(undefined)).toBe('');
  expect(formatSeedResults(null)).toBe('');
});

test('the seeding phase has its own status text', () => {
  expect(setupStatusText({ status: 'running', phase: 'seeding' })).toMatch(/seeding/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/setupStatus.test.js`
Expected: FAIL — `formatSeedResults is not a function`.

- [ ] **Step 3: Widen the types**

In `src/web/api.ts`, replace lines 59-66 with:

```ts
export interface SetupOptions { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; seedAiAuth?: boolean }
export interface SetupSummary {
  id: string; boxId: string; boxLabel: string; status: SetupStatus;
  phase: 'waiting-ssh' | 'running' | 'seeding' | null; options: SetupOptions; error: string | null;
  // Present once a job that asked for seeding has attempted it. Absent (or
  // null) on jobs that predate server-side seeding, and on jobs that never
  // asked for it.
  seed?: SeedResult[] | null;
  createdAt: string; finishedAt: string | null;
}
export interface SetupJob extends SetupSummary { log: string; }
export interface SeedResult { target: 'claude' | 'codex' | 'all'; ok: boolean; skipped?: string; error?: string }
```

- [ ] **Step 4: Add the formatter and the seeding phase text**

In `src/web/setupStatus.ts`, replace the import line and the `running` case:

```ts
import type { SeedResult, SetupJob, SetupStatus } from './api';

export function setupStatusText(job: Pick<SetupJob, 'status' | 'phase' | 'error'>): string {
  switch (job.status) {
    case 'running':
      return job.phase === 'waiting-ssh' ? 'Waiting for SSH…'
        : job.phase === 'seeding' ? 'Seeding AI credentials…'
        : 'Running setup…';
```

(Leave the remaining `case` arms of that switch exactly as they are.)

Then append to the end of the file:

```ts
// One line summarising a job's seed outcome, e.g.
// "claude ✓ · codex skipped (no codex auth on the Tmuxifier host)".
// Empty string when nothing was seeded, so callers can test it for truthiness
// rather than special-casing old jobs that have no seed field at all.
export function formatSeedResults(seed: SeedResult[] | null | undefined): string {
  if (!seed || !seed.length) return '';
  return seed
    .map((r) => `${r.target} ${r.ok ? '✓' : r.skipped ? `skipped (${r.skipped})` : `failed (${r.error ?? 'failed'})`}`)
    .join(' · ');
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/setupStatus.test.js`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean. If it reports errors in `main.ts`/`proxmoxUi.ts` about `SeedResult`, that's Task 5's job — but nothing here should break them, because both fields are optional.

- [ ] **Step 7: Commit**

```bash
git add src/web/api.ts src/web/setupStatus.ts test/setupStatus.test.js
git commit -m "feat(ui): seed-result types and a shared formatter"
```

---

### Task 5: Render the recorded outcome instead of firing the request

**Files:**
- Modify: `src/web/main.ts:1080` and `:1105-1135`, `src/web/proxmoxUi.ts:150-175`

**Interfaces:**
- Consumes: `formatSeedResults` from Task 4; `job.seed` from Task 1.
- Produces: nothing new. `api.seedAiAuth` remains exported and defined; it simply has no caller.

- [ ] **Step 1: Send the flag from the provision panel**

In `src/web/main.ts`, replace line 1080:

```ts
  const opts = { ohMyTmux: options.ohMyTmux, ohMyZsh: options.ohMyZsh, ohMyBash: options.ohMyBash, tools: options.tools || [] };
```

with:

```ts
  const opts = { ohMyTmux: options.ohMyTmux, ohMyZsh: options.ohMyZsh, ohMyBash: options.ohMyBash, tools: options.tools || [], seedAiAuth: !!options.seedAiAuth };
```

This is load-bearing: `opts` is what `api.startSetup(box.id, opts)` posts at line 1189, and the server now reads `seedAiAuth` from that body.

- [ ] **Step 2: Delete the fire-once latch**

Still in `src/web/main.ts`, remove these three lines (they sit just above the `interactive` declaration, around line 1091):

```ts
  // Fire-once guard: onJob observes 'done' once per normal run, but the
  // needs-interactive fallback re-enters polling, so this must survive restarts.
  let seeded = false;
```

Also remove the now-unused `const seedAiAuth = !!options.seedAiAuth;` line (around line 1081) — the flag now travels in `opts` and comes back on the job.

- [ ] **Step 3: Replace the done branch**

Replace the whole `if (job.status === 'done') { … }` block inside the poller's `onJob` with:

```ts
      if (job.status === 'done') {
        refresh();
        // The seed already ran server-side, before this status flip — so the
        // outcome is here on the first (and only) 'done' this poller sees.
        // Nothing to request, nothing to race, nothing to guard.
        const seedTxt = formatSeedResults(job.seed);
        if (seedTxt) status.textContent = `${status.textContent} · auth: ${seedTxt}`;
        // A seed outcome deserves longer on screen than a bare success.
        autoCloseTimer = window.setTimeout(() => closeProvisionPanel(), seedTxt ? 5000 : 2000);
        return null;
      }
```

- [ ] **Step 4: Import the formatter**

In `src/web/main.ts`, replace the import at line 3:

```ts
import { setupStatusText, setupActions, setupBadge } from './setupStatus';
```

with:

```ts
import { setupStatusText, setupActions, setupBadge, formatSeedResults } from './setupStatus';
```

- [ ] **Step 5: Do the same in the Proxmox hub**

In `src/web/proxmoxUi.ts`, remove the latch at line 150-153:

```ts
      // Fire-once guard for this runSetup call: the needs-interactive fallback
      // re-enters polling (poller.start() below), so 'done' can be observed
      // more than once per call without this.
      let seeded = false;
```

and replace the seed block at lines 167-173:

```ts
          if (job.status === 'done' && setup?.seedAiAuth && !seeded) {
            seeded = true;
            void api.seedAiAuth(boxId).then(({ results }) => {
              const txt = results.map((r) => `${r.target} ${r.ok ? '✓' : r.skipped ? `skipped (${r.skipped})` : `failed (${r.error ?? 'failed'})`}`).join(' · ');
              phase.textContent = `${phase.textContent} · auth: ${txt}`;
            }).catch(() => { phase.textContent = `${phase.textContent} · auth: request failed`; });
          }
```

with:

```ts
          // Seeding happened inside the job, before this status flip — read it
          // off the job rather than firing a request from the tab.
          const seedTxt = formatSeedResults(job.seed);
          if (seedTxt) phase.textContent = `${phase.textContent} · auth: ${seedTxt}`;
```

Then replace the import at `src/web/proxmoxUi.ts:9`:

```ts
import { setupStatusText } from './setupStatus';
```

with:

```ts
import { setupStatusText, formatSeedResults } from './setupStatus';
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both clean. A leftover reference to `seeded` or `seedAiAuth` shows up here as an unused-variable or undefined-name error.

- [ ] **Step 7: Confirm the UI no longer calls the route**

Run: `grep -rn "api.seedAiAuth" src/web/`
Expected: exactly one hit — the definition in `src/web/api.ts:108`. No call sites.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, including the four untouched `seed-ai-auth` route tests in `test/server.test.js`.

- [ ] **Step 9: Commit**

```bash
git add src/web/main.ts src/web/proxmoxUi.ts
git commit -m "refactor(ui): render the job's recorded seed outcome instead of requesting it"
```

---

### Task 6: Update the architecture docs

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`

**Interfaces:**
- Consumes: everything above. Produces: no code.

- [ ] **Step 1: Update the setupManager description**

In `CLAUDE.md`, find the `setupManager.js` / `setupStore.js` bullet under "Architecture (`src/server/`)". Append to that bullet, before the `createSetupStore` sentence:

```
  On reaching `done` — from either the non-interactive run or an interactive finish — a job whose
  options asked for it seeds the box's AI CLI auth (injected `seed`/`getBox`) under a `seeding`
  phase, records the redacted per-target result on `job.seed`, and only then flips to `done`; a
  failed seed is recorded, never promoted to a job failure.
```

- [ ] **Step 2: Update the aiAuthSeed description**

In `CLAUDE.md`, find the `aiAuthSeed.js` bullet. It describes the seeder. Add a sentence noting the trigger:

```
  The trigger is the setup job itself (see `setupManager.js`), not the browser; `POST
  /api/boxes/:id/seed-ai-auth` remains as the manual re-seed path with no UI caller.
```

- [ ] **Step 3: Mirror both edits into AGENTS.md**

`AGENTS.md` is the same content adapted for general coding agents and is kept in sync. Apply the same two edits to the corresponding bullets there.

Run: `diff <(grep -c setupManager CLAUDE.md) <(grep -c setupManager AGENTS.md)`
Expected: no output (equal counts), confirming both files describe the module the same number of times.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: server-side seed trigger in the architecture notes"
```

---

## Final verification

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS — typecheck clean, all vitest files green.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean Vite build into `dist/`.

- [ ] **Step 3: End-to-end suite**

Run: `npm run test:e2e`
Expected: PASS. This exercises the provision panel against a real sshd-backed box.

- [ ] **Step 4: Manual check before any release**

Provision one real container with the "Seed AI CLI auth" checkbox ticked, then **close the browser tab while setup is still running**. When it finishes, confirm from another tab that `GET /api/setup` reports that job with a populated `seed` array, and that the box's `claude`/`codex` CLIs are authenticated. That closed tab is the exact scenario this change exists to fix, and the suite cannot prove it.

The last two real seeding bugs (the `~/.claude.json` onboarding-flag merge, and the pre-existing-shell token gap) were both found in the field rather than by tests — budget for one manual pass.
