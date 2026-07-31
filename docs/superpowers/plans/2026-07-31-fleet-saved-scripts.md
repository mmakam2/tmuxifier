# Fleet Command Saved Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Fleet Command named, server-persisted bash scripts, managed from a rail inside the existing script-editor modal, with the script's name recorded on the fleet job it produces.

**Architecture:** A new `data/fleet-scripts.json` store (`fleetScriptsStore.js`) built on the shared `jsonFile.js` atomic-write helpers, exposed through four auth-gated `/api/fleet/scripts` routes. `fleet.js` gains an optional `scriptName` label on a job. On the client, a fetch layer plus pure helpers (`fleetScripts.ts`) and a DOM rail (`fleetScriptRail.ts`) are wired into `main.ts`'s existing `openFleetScriptEditor`.

**Tech Stack:** Node 20+, ESM, Fastify, vanilla TypeScript + CodeMirror 6 on the client, Vitest for unit/integration, Playwright for e2e. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-31-fleet-saved-scripts-design.md`

## Global Constraints

- ESM everywhere (`"type": "module"`), Node 20+. Server is plain `.js`; web client is `.ts`.
- **No new npm dependencies.** Everything here uses what the repo already has.
- TDD: write the failing test first, watch it fail, then implement. Tests use **real code, not mocks** — the factories take their dependencies as arguments.
- Vitest runs `environment: 'node'` with **no jsdom**. Do not plan or write DOM-rendering unit tests; DOM layers are covered by Playwright only.
- Modules are factory functions with injected dependencies (`createFleetScriptsStore({ dataDir })`), following `servicesStore.js`.
- The repo is public: no real domains, IPs, hostnames or emails in code, tests, or docs. Use `example.com`, RFC1918 addresses like `192.168.1.10`, `you@example.com`.
- Conventional-commit messages (`feat(fleet): …`, `test(fleet): …`, `docs: …`).
- Size limits, used verbatim everywhere they appear: name ≤ **80** chars, description ≤ **200** chars, script body ≤ **65536** chars, at most **200** saved scripts.
- `data/fleet-scripts.json` is written mode `0o600` and is **not** encrypted.
- `DESIGN.md` is the visual authority. Read it before writing CSS.

---

### Task 1: The saved-scripts store

**Files:**
- Create: `src/server/fleetScriptsStore.js`
- Test: `test/fleetScriptsStore.test.js`

**Interfaces:**
- Consumes: `readJson`, `writeJson` from `src/server/jsonFile.js`.
- Produces: `createFleetScriptsStore({ dataDir })` returning `{ listScripts(), addScript(spec), updateScript(id, patch), removeScript(id) }`, all async. A record is `{ id, name, script, createdAt, updatedAt, description? }` where `id` is `fs-<uuid>`. Also exports the constants `MAX_NAME = 80`, `MAX_DESCRIPTION = 200`, `MAX_SCRIPT = 65536`, `MAX_SCRIPTS = 200`. `updateScript` throws `Error('script not found')` for an unknown id — the route layer in Task 2 matches on that exact message to pick 404 over 400.

- [ ] **Step 1: Write the failing test**

Create `test/fleetScriptsStore.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFleetScriptsStore } from '../src/server/fleetScriptsStore.js';

let dir, store;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-fscripts-'));
  store = createFleetScriptsStore({ dataDir: dir });
});

const spec = { name: 'apt upgrade', script: 'sudo apt-get update && sudo apt-get -y upgrade\n' };

test('an absent file reads as an empty list', async () => {
  expect(await store.listScripts()).toEqual([]);
});

test('addScript normalizes, stamps timestamps, and round-trips through the file', async () => {
  const rec = await store.addScript(spec);
  expect(rec.id).toMatch(/^fs-/);
  expect(rec.name).toBe('apt upgrade');
  expect(rec.script).toBe(spec.script);
  expect(rec.createdAt).toBeTruthy();
  expect(rec.updatedAt).toBeTruthy();
  expect(await store.listScripts()).toEqual([rec]);
  // A fresh store over the same directory sees it: the write really landed.
  const reopened = createFleetScriptsStore({ dataDir: dir });
  expect(await reopened.listScripts()).toEqual([rec]);
});

test('the data file is written 0o600', async () => {
  await store.addScript(spec);
  const st = await fs.stat(path.join(dir, 'fleet-scripts.json'));
  expect(st.mode & 0o777).toBe(0o600);
});

test('name is required, trimmed, and capped at 80 chars', async () => {
  await expect(store.addScript({ ...spec, name: '   ' })).rejects.toThrow(/name/);
  await expect(store.addScript({ ...spec, name: 'x'.repeat(81) })).rejects.toThrow(/name/);
  const rec = await store.addScript({ ...spec, name: '  apt upgrade  ' });
  expect(rec.name).toBe('apt upgrade');
});

test('script body is required and capped at 65536 chars', async () => {
  await expect(store.addScript({ ...spec, script: '   \n ' })).rejects.toThrow(/script/);
  await expect(store.addScript({ ...spec, script: 'x'.repeat(65537) })).rejects.toThrow(/65536/);
  // Exactly at the cap is fine: it is the same limit POST /api/fleet/jobs allows.
  const rec = await store.addScript({ ...spec, script: 'x'.repeat(65536) });
  expect(rec.script.length).toBe(65536);
});

test('description is optional, trimmed, capped at 200, and clearable with an empty string', async () => {
  await expect(store.addScript({ ...spec, description: 'd'.repeat(201) })).rejects.toThrow(/description/);
  const rec = await store.addScript({ ...spec, description: '  updates every box  ' });
  expect(rec.description).toBe('updates every box');
  const cleared = await store.updateScript(rec.id, { description: '' });
  expect(cleared.description).toBeUndefined();
  // An omitted key keeps the stored value — the patch-merge rule.
  const kept = await store.updateScript(rec.id, { name: 'apt upgrade v2' });
  expect(kept.description).toBeUndefined();
  expect(kept.name).toBe('apt upgrade v2');
});

test('names are unique case-insensitively, on both add and rename', async () => {
  const first = await store.addScript(spec);
  await expect(store.addScript({ ...spec, name: 'APT Upgrade' })).rejects.toThrow(/already exists/);
  const second = await store.addScript({ ...spec, name: 'docker prune' });
  await expect(store.updateScript(second.id, { name: 'apt upgrade' })).rejects.toThrow(/already exists/);
  // Re-saving a record under its own name is not a conflict.
  const same = await store.updateScript(first.id, { name: 'apt upgrade', script: 'echo hi' });
  expect(same.name).toBe('apt upgrade');
  expect(same.script).toBe('echo hi');
});

test('updateScript merges onto the stored record and keeps id and createdAt', async () => {
  const rec = await store.addScript(spec);
  const upd = await store.updateScript(rec.id, { script: 'echo changed' });
  expect(upd).toMatchObject({ id: rec.id, name: rec.name, createdAt: rec.createdAt, script: 'echo changed' });
  await expect(store.updateScript('fs-nope', { script: 'x' })).rejects.toThrow('script not found');
});

test('removeScript drops the record and is a no-op for an unknown id', async () => {
  const rec = await store.addScript(spec);
  await store.removeScript('fs-nope');
  expect(await store.listScripts()).toHaveLength(1);
  await store.removeScript(rec.id);
  expect(await store.listScripts()).toEqual([]);
});

test('listScripts returns newest-updated first, with a stable id tie-break', async () => {
  const a = await store.addScript({ name: 'a', script: 'echo a' });
  const b = await store.addScript({ name: 'b', script: 'echo b' });
  const ids = (await store.listScripts()).map((s) => s.id);
  expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
  // Touching `a` must float it to the front regardless of insertion order.
  await new Promise((r) => setTimeout(r, 2));
  await store.updateScript(a.id, { script: 'echo a2' });
  expect((await store.listScripts())[0].id).toBe(a.id);
});

test('the store caps at 200 scripts', async () => {
  const full = createFleetScriptsStore({ dataDir: dir });
  for (let i = 0; i < 200; i++) await full.addScript({ name: `s${i}`, script: 'echo x' });
  await expect(full.addScript({ name: 'one-too-many', script: 'echo x' })).rejects.toThrow(/200/);
});

test('concurrent adds are serialized — no write is lost', async () => {
  await Promise.all([
    store.addScript({ name: 'one', script: 'echo 1' }),
    store.addScript({ name: 'two', script: 'echo 2' }),
    store.addScript({ name: 'three', script: 'echo 3' }),
  ]);
  expect(await store.listScripts()).toHaveLength(3);
});

test('a corrupt file is quarantined and read as empty rather than destroying it', async () => {
  const file = path.join(dir, 'fleet-scripts.json');
  await fs.writeFile(file, '{ not json');
  expect(await store.listScripts()).toEqual([]);
  const left = await fs.readdir(dir);
  expect(left.some((f) => f.startsWith('fleet-scripts.json.corrupt-'))).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/fleetScriptsStore.test.js`
Expected: FAIL — `Failed to resolve import "../src/server/fleetScriptsStore.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/server/fleetScriptsStore.js`:

```js
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './jsonFile.js';

// CRUD for Fleet Command's saved scripts (data/fleet-scripts.json), in the mold
// of servicesStore.js: normalize+validate inside the store, mutations serialized
// so two concurrent read-modify-write cycles can't drop each other's change.

// The body cap is deliberately the same limit POST /api/fleet/jobs enforces on
// `command`: a script that can be saved must always be runnable.
export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 200;
export const MAX_SCRIPT = 65536;
export const MAX_SCRIPTS = 200;

export function createFleetScriptsStore({ dataDir }) {
  const file = path.join(dataDir, 'fleet-scripts.json');
  const valid = (v) => !!v && typeof v === 'object' && Array.isArray(v.scripts);

  async function readAll() {
    return (await readJson(file, { fallback: { version: 1, scripts: [] }, validate: valid })).scripts;
  }
  async function writeAll(scripts) {
    // 0o600 like every other data/ file. Nothing here is sealed — a script body
    // is free text and holds no credential class Tmuxifier manages — but the
    // operator may well have pasted one in, so the file stays owner-only.
    await writeJson(file, { version: 1, scripts }, { mode: 0o600 });
  }

  function normalize(spec, base = {}) {
    const name = String(spec.name ?? base.name ?? '').trim();
    if (!name) throw new Error('script name is required');
    if (name.length > MAX_NAME) throw new Error(`script name must be at most ${MAX_NAME} characters`);
    const script = String(spec.script ?? base.script ?? '');
    if (!script.trim()) throw new Error('script body is required');
    if (script.length > MAX_SCRIPT) throw new Error(`script body must be at most ${MAX_SCRIPT} characters`);
    // An omitted key keeps the stored value; an explicit '' clears it. Stating
    // both readings here is the point — a spread-merge that treats absent and
    // empty alike can never turn a field off.
    const description = String(spec.description ?? base.description ?? '').trim();
    if (description.length > MAX_DESCRIPTION) throw new Error(`description must be at most ${MAX_DESCRIPTION} characters`);
    const now = new Date().toISOString();
    const out = {
      id: base.id || `fs-${randomUUID()}`,
      name,
      script,
      createdAt: base.createdAt || now,
      updatedAt: now,
    };
    if (description) out.description = description;
    return out;
  }

  // Case-insensitive: two names differing only in case are the same script to
  // the operator reading the rail, and the rail is the only place they appear.
  function assertNameFree(scripts, name, exceptId) {
    const key = name.toLowerCase();
    if (scripts.some((s) => s.id !== exceptId && String(s.name).toLowerCase() === key)) {
      throw new Error(`a script named ${JSON.stringify(name)} already exists`);
    }
  }

  // Same serialization seam as store.js/servicesStore.js: mutations queue, reads
  // stay free.
  let queue = Promise.resolve();
  function serialize(op) {
    const run = queue.then(op, op);
    queue = run.then(() => {}, () => {});
    return run;
  }

  // Newest-updated first, id as tie-break so two records written in the same
  // millisecond still have a total order (jobOrder.js's rule).
  const newestFirst = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
    || String(a.id).localeCompare(String(b.id));

  return {
    async listScripts() {
      return [...(await readAll())].sort(newestFirst);
    },
    async addScript(spec) {
      return serialize(async () => {
        const scripts = await readAll();
        if (scripts.length >= MAX_SCRIPTS) throw new Error(`at most ${MAX_SCRIPTS} saved scripts`);
        const rec = normalize(spec || {});
        assertNameFree(scripts, rec.name, rec.id);
        scripts.push(rec);
        await writeAll(scripts);
        return rec;
      });
    },
    async updateScript(id, patch) {
      return serialize(async () => {
        const scripts = await readAll();
        const index = scripts.findIndex((s) => s.id === id);
        if (index === -1) throw new Error('script not found');
        const rec = normalize(patch || {}, scripts[index]);
        assertNameFree(scripts, rec.name, id);
        scripts[index] = rec;
        await writeAll(scripts);
        return rec;
      });
    },
    async removeScript(id) {
      return serialize(async () => {
        const scripts = await readAll();
        await writeAll(scripts.filter((s) => s.id !== id));
      });
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/fleetScriptsStore.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/server/fleetScriptsStore.js test/fleetScriptsStore.test.js
git commit -m "feat(fleet): saved-script store over data/fleet-scripts.json"
```

---

### Task 2: The `/api/fleet/scripts` routes

**Files:**
- Modify: `src/server/server.js` (add `fleetScriptsStore` to `buildServer`'s options and register four routes right after the `/api/fleet/jobs` block, currently ending at line 1010)
- Modify: `src/server/index.js` (construct the store near the other `data/` stores and pass it to `buildServer`)
- Test: `test/fleetScriptRoutes.test.js`

**Interfaces:**
- Consumes: `createFleetScriptsStore` from Task 1.
- Produces: `GET /api/fleet/scripts` (200, array), `POST /api/fleet/scripts` (201, record), `PATCH /api/fleet/scripts/:id` (200, record; 404 when unknown), `DELETE /api/fleet/scripts/:id` (200, `{ ok: true }`). All require auth. `buildServer` accepts `fleetScriptsStore`, defaulting to an inert `NO_FLEET_SCRIPTS` object so existing tests that omit it keep working.

- [ ] **Step 1: Write the failing test**

Create `test/fleetScriptRoutes.test.js`:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createFleetScriptsStore } from '../src/server/fleetScriptsStore.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-fsr-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  app = buildServer({
    config, store: createStore({ dataDir: dir }), sessions, statusChecker,
    fleetScriptsStore: createFleetScriptsStore({ dataDir: dir }),
  });
});

async function login() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  return res.headers['set-cookie'];
}

test('every saved-script route requires auth', async () => {
  for (const [method, url] of [['GET', '/api/fleet/scripts'], ['POST', '/api/fleet/scripts'],
    ['PATCH', '/api/fleet/scripts/fs-1'], ['DELETE', '/api/fleet/scripts/fs-1']]) {
    const res = await app.inject({ method, url, payload: {} });
    expect(res.statusCode, `${method} ${url}`).toBe(401);
  }
});

test('create, list, update and delete a saved script', async () => {
  const cookie = await login();
  expect((await app.inject({ method: 'GET', url: '/api/fleet/scripts', headers: { cookie } })).json()).toEqual([]);

  const created = await app.inject({
    method: 'POST', url: '/api/fleet/scripts', headers: { cookie },
    payload: { name: 'apt upgrade', description: 'updates every box', script: 'sudo apt-get -y upgrade' },
  });
  expect(created.statusCode).toBe(201);
  const rec = created.json();
  expect(rec).toMatchObject({ name: 'apt upgrade', description: 'updates every box', script: 'sudo apt-get -y upgrade' });

  const listed = await app.inject({ method: 'GET', url: '/api/fleet/scripts', headers: { cookie } });
  expect(listed.json()).toEqual([rec]);

  const patched = await app.inject({
    method: 'PATCH', url: `/api/fleet/scripts/${rec.id}`, headers: { cookie },
    payload: { script: 'echo patched' },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json()).toMatchObject({ id: rec.id, name: 'apt upgrade', script: 'echo patched' });

  const removed = await app.inject({ method: 'DELETE', url: `/api/fleet/scripts/${rec.id}`, headers: { cookie } });
  expect(removed.json()).toEqual({ ok: true });
  expect((await app.inject({ method: 'GET', url: '/api/fleet/scripts', headers: { cookie } })).json()).toEqual([]);
});

test('an invalid body is 400 and an unknown id is 404', async () => {
  const cookie = await login();
  const bad = await app.inject({ method: 'POST', url: '/api/fleet/scripts', headers: { cookie }, payload: { name: '', script: 'x' } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toMatch(/name/);

  const missing = await app.inject({ method: 'PATCH', url: '/api/fleet/scripts/fs-nope', headers: { cookie }, payload: { script: 'x' } });
  expect(missing.statusCode).toBe(404);

  const created = await app.inject({ method: 'POST', url: '/api/fleet/scripts', headers: { cookie }, payload: { name: 'dup', script: 'x' } });
  const dup = await app.inject({ method: 'POST', url: '/api/fleet/scripts', headers: { cookie }, payload: { name: 'DUP', script: 'y' } });
  expect(dup.statusCode).toBe(400);
  expect(dup.json().error).toMatch(/already exists/);
  expect(created.statusCode).toBe(201);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/fleetScriptRoutes.test.js`
Expected: FAIL — the routes 404 (Fastify returns 404 for unregistered paths), so the auth-gate assertion fails first with `expected 404 to be 401`.

- [ ] **Step 3: Add the routes to `src/server/server.js`**

Near the top of the file, beside the existing `NO_ICONS` constant, add the inert default:

```js
// An inert stand-in so buildServer keeps working for the many tests that do not
// wire a saved-script store (same pattern as NO_ICONS).
const NO_FLEET_SCRIPTS = {
  listScripts: async () => [],
  addScript: async () => { throw new Error('saved scripts are unavailable'); },
  updateScript: async () => { throw new Error('saved scripts are unavailable'); },
  removeScript: async () => {},
};
```

In the `buildServer({ … })` destructured options list (line 107), add `fleetScriptsStore = NO_FLEET_SCRIPTS,` next to `fleetManager,`.

Immediately after the `POST /api/fleet/jobs/:id/cancel` route (ends line 1010), add:

```js
  // --- Fleet Command saved scripts ---
  app.get('/api/fleet/scripts', { preHandler: requireAuth }, async () => fleetScriptsStore.listScripts());
  app.post('/api/fleet/scripts', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return reply.code(201).send(await fleetScriptsStore.addScript(req.body || {}));
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });
  app.patch('/api/fleet/scripts/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return await fleetScriptsStore.updateScript(req.params.id, req.body || {});
    } catch (e) {
      // The store is the validation authority; only "gone" becomes a 404.
      return reply.code(e.message === 'script not found' ? 404 : 400).send({ error: e.message });
    }
  });
  app.delete('/api/fleet/scripts/:id', { preHandler: requireAuth }, async (req) => {
    await fleetScriptsStore.removeScript(req.params.id);
    return { ok: true };
  });
```

- [ ] **Step 4: Wire the store in `src/server/index.js`**

Add the import beside the other store imports (near line 22):

```js
import { createFleetScriptsStore } from './fleetScriptsStore.js';
```

After the `createFleetManager({ … })` block (starts line 163), add:

```js
const fleetScriptsStore = createFleetScriptsStore({ dataDir: config.dataDir });
```

Add `fleetScriptsStore,` to the `buildServer({ … })` argument list (line 296), next to `fleetManager,`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/fleetScriptRoutes.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full server test file for regressions**

Run: `npx vitest run test/server.test.js test/serviceRoutes.test.js`
Expected: PASS — the new `buildServer` option defaults, so nothing else changes.

- [ ] **Step 7: Commit**

```bash
git add src/server/server.js src/server/index.js test/fleetScriptRoutes.test.js
git commit -m "feat(fleet): auth-gated CRUD routes for saved scripts"
```

---

### Task 3: Script-name provenance on a fleet job

**Files:**
- Modify: `src/server/fleet.js` (`createJob`, `summarize`)
- Modify: `src/server/server.js` (`POST /api/fleet/jobs`, line 988)
- Modify: `src/web/api.ts` (`FleetJob` / `FleetJobSummary` types, `createFleetJob`)
- Modify: `src/web/main.ts` (`renderFleetHistory`, the `cmdSpan` at line 2430)
- Test: `test/fleet.test.js` (append), `test/fleetScriptRoutes.test.js` (append one route test)

**Interfaces:**
- Consumes: nothing from Tasks 1–2 at runtime — the name is a label, never resolved against the store.
- Produces: `fleetManager.createJob({ boxIds, command, scriptName })`; `job.scriptName` is a `string` when accepted and absent otherwise; `summarize` emits `scriptName: job.scriptName ?? null`. Client-side, `api.createFleetJob(boxIds, command, scriptName?)` and `FleetJobSummary.scriptName?: string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/fleet.test.js`:

```js
test('a job records the saved-script name it was launched from', async () => {
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    execCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  const job = await mgr.createJob({ boxIds: ['b1'], command: 'uptime', scriptName: 'apt upgrade' });
  expect(job.scriptName).toBe('apt upgrade');
  await mgr._settled(job.id);
  expect(mgr.listJobs()[0].scriptName).toBe('apt upgrade');
});

test('a blank, oversized or non-string script name is ignored, never an error', async () => {
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    execCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  for (const scriptName of ['   ', 'x'.repeat(81), 42, null, undefined]) {
    const job = await mgr.createJob({ boxIds: ['b1'], command: 'uptime', scriptName });
    expect(job.scriptName, String(scriptName)).toBeUndefined();
    expect(mgr.listJobs()[0].scriptName).toBeNull();
    await mgr._settled(job.id);
  }
});
```

Append to `test/fleetScriptRoutes.test.js`:

```js
test('POST /api/fleet/jobs carries scriptName through to the job summary', async () => {
  const cookie = await login();
  const box = await app.inject({
    method: 'POST', url: '/api/boxes', headers: { cookie },
    payload: { label: 'web-01', host: '192.168.1.10', user: 'deploy' },
  });
  expect(box.statusCode).toBe(201);
  const created = await app.inject({
    method: 'POST', url: '/api/fleet/jobs', headers: { cookie },
    payload: { boxIds: [box.json().id], command: 'uptime', scriptName: 'apt upgrade' },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().scriptName).toBe('apt upgrade');
});
```

This last test needs a fleet manager in the `beforeEach`. Extend the `buildServer` call in `test/fleetScriptRoutes.test.js` to include one:

```js
import { createFleetManager } from '../src/server/fleet.js';
// …inside beforeEach, before buildServer:
const boxStore = createStore({ dataDir: dir });
const fleetManager = createFleetManager({
  store: boxStore,
  execCommand: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
});
// …and pass `store: boxStore, fleetManager,` to buildServer.
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/fleet.test.js test/fleetScriptRoutes.test.js`
Expected: FAIL — `expected undefined to be 'apt upgrade'`.

- [ ] **Step 3: Implement on the server**

In `src/server/fleet.js`, change the `createJob` signature and body. Replace:

```js
    async createJob({ boxIds, command }) {
```

with:

```js
    async createJob({ boxIds, command, scriptName }) {
```

Inside, after the `command`/`boxIds` guards, add:

```js
      // The saved-script name this run came from, kept as a display label only:
      // never resolved back against the script store, so renaming or deleting a
      // script cannot change what a past job says it ran (the same reason a
      // target's label and host are frozen at creation). A blank or oversized
      // value is dropped rather than rejected — provenance is a convenience and
      // must never be able to fail a run.
      const label = typeof scriptName === 'string' ? scriptName.trim() : '';
```

and, after the `job` object literal is built:

```js
      if (label && label.length <= 80) job.scriptName = label;
```

In `summarize`, add `scriptName: job.scriptName ?? null,` to the returned object (next to `command`).

In `src/server/server.js`'s `POST /api/fleet/jobs` handler, change the destructure and the call:

```js
    const { boxIds, command, scriptName } = req.body || {};
    …
      const job = await fleetManager.createJob({ boxIds, command, scriptName });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/fleet.test.js test/fleetScriptRoutes.test.js`
Expected: PASS.

- [ ] **Step 5: Plumb the label through the client**

In `src/web/api.ts`, add the field to both interfaces (lines 165–174):

```ts
export interface FleetJob {
  id: string; command: string; status: FleetJobStatus;
  createdAt: string; startedAt: string; finishedAt: string | null;
  concurrency: number; timeoutMs: number; targets: FleetTarget[];
  /** The saved-script name this run came from, when it came from one. */
  scriptName?: string | null;
}
export interface FleetJobSummary {
  id: string; command: string; status: FleetJobStatus;
  createdAt: string; startedAt: string; finishedAt: string | null;
  targetCount: number; okCount: number; errorCount: number;
  scriptName?: string | null;
}
```

and widen the call (line 282):

```ts
  async createFleetJob(boxIds: string[], command: string, scriptName?: string) {
    return j<FleetJob>(await fetch('/api/fleet/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boxIds, command, scriptName }) }));
  },
```

In `src/web/main.ts`'s `renderFleetHistory`, replace the `cmdSpan` assignment (line 2432):

```ts
    // A named script reads better than its first line; the raw command stays
    // available on hover.
    cmdSpan.textContent = s.scriptName || s.command;
    if (s.scriptName) cmdSpan.title = s.command;
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/fleet.js src/server/server.js src/web/api.ts src/web/main.ts test/fleet.test.js test/fleetScriptRoutes.test.js
git commit -m "feat(fleet): record the saved-script name on a fleet job"
```

---

### Task 4: Client fetch layer and pure helpers

**Files:**
- Create: `src/web/fleetScripts.ts`
- Test: `test/fleetScripts.test.js`

**Interfaces:**
- Consumes: `jsonFetch`, `jsonBody` from `src/web/http.ts` (the central 401 seam — never hand-roll `fetch` + `res.ok`).
- Produces:
  - `interface FleetScript { id: string; name: string; description?: string; script: string; createdAt: string; updatedAt: string }`
  - `fleetScripts = { list(), create(spec), update(id, patch), remove(id) }`
  - `sortScripts(list: FleetScript[]): FleetScript[]`
  - `isDirty(selected: FleetScript | null, script: string, name: string, description: string): boolean`
  - `validateName(name: string, existing: FleetScript[], exceptId?: string | null): string | null` — returns an error message, or `null` when the name is acceptable.

- [ ] **Step 1: Write the failing test**

Create `test/fleetScripts.test.js`:

```js
import { test, expect } from 'vitest';
import { sortScripts, isDirty, validateName } from '../src/web/fleetScripts';

const rec = (over = {}) => ({
  id: 'fs-1', name: 'apt upgrade', script: 'echo hi',
  createdAt: '2026-07-31T10:00:00.000Z', updatedAt: '2026-07-31T10:00:00.000Z', ...over,
});

test('sortScripts orders newest-updated first with an id tie-break', () => {
  const a = rec({ id: 'fs-a', name: 'a', updatedAt: '2026-07-31T10:00:00.000Z' });
  const b = rec({ id: 'fs-b', name: 'b', updatedAt: '2026-07-31T12:00:00.000Z' });
  const c = rec({ id: 'fs-c', name: 'c', updatedAt: '2026-07-31T10:00:00.000Z' });
  expect(sortScripts([a, b, c]).map((s) => s.id)).toEqual(['fs-b', 'fs-a', 'fs-c']);
  // Pure: the input array is not reordered in place.
  expect([a, b, c].map((s) => s.id)).toEqual(['fs-a', 'fs-b', 'fs-c']);
});

test('isDirty on the unnamed draft is "there is text in the buffer"', () => {
  expect(isDirty(null, '', '', '')).toBe(false);
  expect(isDirty(null, '   \n ', '', '')).toBe(false);
  expect(isDirty(null, 'echo hi', '', '')).toBe(true);
});

test('isDirty on a selected script compares body, name and description', () => {
  const s = rec({ description: 'note' });
  expect(isDirty(s, 'echo hi', 'apt upgrade', 'note')).toBe(false);
  expect(isDirty(s, 'echo changed', 'apt upgrade', 'note')).toBe(true);
  expect(isDirty(s, 'echo hi', 'renamed', 'note')).toBe(true);
  expect(isDirty(s, 'echo hi', 'apt upgrade', 'other note')).toBe(true);
  // Surrounding whitespace on name/description is not a change — the store
  // trims both, so a stray space must not light the dirty marker forever.
  expect(isDirty(s, 'echo hi', '  apt upgrade  ', ' note ')).toBe(false);
  // A script with no description compares against ''.
  expect(isDirty(rec(), 'echo hi', 'apt upgrade', '')).toBe(false);
  expect(isDirty(rec(), 'echo hi', 'apt upgrade', 'added')).toBe(true);
});

test('validateName rejects blank, over-long and duplicate names', () => {
  const existing = [rec({ id: 'fs-1', name: 'apt upgrade' }), rec({ id: 'fs-2', name: 'docker prune' })];
  expect(validateName('deploy', existing)).toBeNull();
  expect(validateName('   ', existing)).toMatch(/name/i);
  expect(validateName('x'.repeat(81), existing)).toMatch(/80/);
  expect(validateName('APT Upgrade', existing)).toMatch(/already exists/);
  // Re-saving a record under its own name is fine.
  expect(validateName('apt upgrade', existing, 'fs-1')).toBeNull();
  expect(validateName('docker prune', existing, 'fs-1')).toMatch(/already exists/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/fleetScripts.test.js`
Expected: FAIL — cannot resolve `../src/web/fleetScripts`.

- [ ] **Step 3: Write the implementation**

Create `src/web/fleetScripts.ts`:

```ts
// Fetch layer + pure helpers for Fleet Command's saved scripts, in the mold of
// netbox.ts/voice.ts. Everything goes through http.ts so an expired session
// reaches the central 401 seam instead of failing silently.
import { jsonFetch, jsonBody } from './http';

export interface FleetScript {
  id: string;
  name: string;
  description?: string;
  script: string;
  createdAt: string;
  updatedAt: string;
}

export interface FleetScriptInput {
  name: string;
  description?: string;
  script: string;
}

// Mirrors the server's caps (fleetScriptsStore.js). Duplicated rather than
// imported because the server is the validation authority and this side only
// needs to spare the operator a round trip.
export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 200;

export const fleetScripts = {
  list() { return jsonFetch<FleetScript[]>(`/api/fleet/scripts?t=${Date.now()}`); },
  create(spec: FleetScriptInput) { return jsonFetch<FleetScript>('/api/fleet/scripts', jsonBody('POST', spec)); },
  update(id: string, patch: Partial<FleetScriptInput>) { return jsonFetch<FleetScript>(`/api/fleet/scripts/${id}`, jsonBody('PATCH', patch)); },
  remove(id: string) { return jsonFetch<{ ok: boolean }>(`/api/fleet/scripts/${id}`, { method: 'DELETE' }); },
};

/** Newest-updated first, id as tie-break. Pure: returns a new array. */
export function sortScripts(list: FleetScript[]): FleetScript[] {
  return [...list].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
    || String(a.id).localeCompare(String(b.id)));
}

/**
 * Whether the editor holds unsaved work. For the unnamed draft that is simply
 * "the buffer has text"; for a selected script it is a comparison against every
 * field the Save button would write, so renaming alone still counts as dirty.
 */
export function isDirty(selected: FleetScript | null, script: string, name: string, description: string): boolean {
  if (!selected) return script.trim().length > 0;
  return script !== selected.script
    || name.trim() !== selected.name
    || description.trim() !== (selected.description || '');
}

/** An error message for an unusable name, or null when it is fine. */
export function validateName(name: string, existing: FleetScript[], exceptId: string | null = null): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'A name is required to save this script';
  if (trimmed.length > MAX_NAME) return `The name must be at most ${MAX_NAME} characters`;
  const key = trimmed.toLowerCase();
  if (existing.some((s) => s.id !== exceptId && s.name.toLowerCase() === key)) {
    return `A script named "${trimmed}" already exists`;
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/fleetScripts.test.js`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/web/fleetScripts.ts test/fleetScripts.test.js
git commit -m "feat(fleet): saved-script fetch layer and pure helpers"
```

---

### Task 5: The rail, the modal wiring, and the styles

**Files:**
- Create: `src/web/fleetScriptRail.ts`
- Modify: `src/web/fleetEditor.ts` (add an `onSave` hook bound to `Mod-s`)
- Modify: `src/web/main.ts` (`openFleetScriptEditor`, lines 2219–2310)
- Modify: `src/web/style.css` (after the existing `.fleet-script*` block, lines 1198–1215)

**Interfaces:**
- Consumes: `FleetScript`, `fleetScripts`, `isDirty`, `validateName`, `sortScripts` (Task 4); `armReduce`, `IDLE`, `ARM_MS`, `ArmState` from `src/web/arming.ts`; `el` from `src/web/dom.ts`; `createFleetScriptEditor` from `src/web/fleetEditor.ts`; `api.createFleetJob(boxIds, command, scriptName?)` (Task 3).
- Produces: `buildFleetScriptRail(hooks: RailHooks): FleetScriptRail` where `RailHooks = { onSelect(script: FleetScript | null): void; onDelete(script: FleetScript): void }` and `FleetScriptRail = { dom: HTMLElement; update(state: RailState): void; destroy(): void }`, `RailState = { scripts: FleetScript[]; selectedId: string | null; dirty: boolean }`. `createFleetScriptEditor` gains `onSave?: () => void`.

- [ ] **Step 1: Write the rail module**

Create `src/web/fleetScriptRail.ts`:

```ts
// The saved-script rail inside the Fleet script modal. DOM layer only — the
// pure half lives in fleetScripts.ts. update() rewrites in place (paneHeader.ts's
// shape) so a refresh never steals focus from the editor beside it.
import { el } from './dom';
import { armReduce, IDLE, ARM_MS, type ArmState } from './arming';
import type { FleetScript } from './fleetScripts';

export interface RailState {
  scripts: FleetScript[];
  /** null selects the unnamed draft row. */
  selectedId: string | null;
  dirty: boolean;
}

export interface RailHooks {
  onSelect(script: FleetScript | null): void;
  onDelete(script: FleetScript): void;
}

export interface FleetScriptRail {
  readonly dom: HTMLElement;
  update(state: RailState): void;
  destroy(): void;
}

export function buildFleetScriptRail(hooks: RailHooks): FleetScriptRail {
  const list = el('ul', { class: 'fs-list' });
  const draftRow = el('li', { class: 'fs-row fs-draft' });
  const newBtn = el('button', { type: 'button', class: 'fs-new' }, ['+ New']);
  const dom = el('div', { class: 'fleet-script-rail' }, [
    el('div', { class: 'fs-eyebrow' }, ['Saved']),
    list,
    newBtn,
  ]);

  // Delete is destructive, so it arms before it fires — the same reducer the
  // Proxmox lifecycle keys and the Reconnect buttons use.
  let arm: ArmState = IDLE;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let last: RailState = { scripts: [], selectedId: null, dirty: false };

  function disarm() {
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    arm = IDLE;
  }

  newBtn.addEventListener('click', () => { disarm(); hooks.onSelect(null); });

  function render(state: RailState) {
    last = state;
    list.innerHTML = '';

    // The unnamed draft is a real row so it can be returned to after clicking a
    // saved script — the buffer is never orphaned by a selection.
    draftRow.className = `fs-row fs-draft${state.selectedId === null ? ' selected' : ''}`;
    draftRow.innerHTML = '';
    const draftOpen = el('button', { type: 'button', class: 'fs-open' }, ['Draft']);
    draftOpen.addEventListener('click', () => { disarm(); hooks.onSelect(null); });
    if (state.selectedId === null && state.dirty) draftOpen.append(el('span', { class: 'fs-dot', title: 'Unsaved' }, ['•']));
    draftRow.appendChild(draftOpen);
    list.appendChild(draftRow);

    if (!state.scripts.length) {
      list.appendChild(el('li', { class: 'fs-empty' }, ['No saved scripts yet — name one and hit Save.']));
      return;
    }

    for (const script of state.scripts) {
      const selected = script.id === state.selectedId;
      const row = el('li', { class: `fs-row${selected ? ' selected' : ''}` });
      const open = el('button', { type: 'button', class: 'fs-open', title: script.description || script.name }, [script.name]);
      open.addEventListener('click', () => { disarm(); hooks.onSelect(script); });
      if (selected && state.dirty) open.append(el('span', { class: 'fs-dot', title: 'Unsaved changes' }, ['•']));

      const armed = arm.armed === script.id;
      const del = el('button', {
        type: 'button',
        class: `fs-del${armed ? ' armed' : ''}`,
        title: armed ? `Click again to delete "${script.name}"` : `Delete "${script.name}"`,
        'aria-label': armed ? `Confirm delete ${script.name}` : `Delete ${script.name}`,
      }, [armed ? 'Delete?' : '✕']);
      del.addEventListener('click', () => {
        const out = armReduce(arm, { type: 'click', id: script.id, armable: true });
        arm = out.state;
        if (armTimer) { clearTimeout(armTimer); armTimer = null; }
        if (arm.armed) armTimer = setTimeout(() => { arm = IDLE; render(last); }, ARM_MS);
        render(last);
        if (out.fire) hooks.onDelete(script);
      });

      row.append(open, del);
      list.appendChild(row);
    }
  }

  render(last);
  return {
    dom,
    update(state) { render(state); },
    destroy() { disarm(); },
  };
}
```

- [ ] **Step 2: Add the `Mod-s` save binding to the editor**

In `src/web/fleetEditor.ts`, add to `FleetScriptEditorOptions`:

```ts
  onSave?: () => void;    // ⌘/Ctrl+S while the editor is focused
```

and extend `runKeymap` (line 129) so both commits live at high precedence:

```ts
  const runKeymap = Prec.high(keymap.of([
    { key: 'Mod-Enter', preventDefault: true, run: () => { opts.onRun?.(); return true; } },
    // preventDefault matters: without it the browser's own save dialog opens
    // over the modal.
    { key: 'Mod-s', preventDefault: true, run: () => { opts.onSave?.(); return true; } },
  ]));
```

- [ ] **Step 3: Rewrite `openFleetScriptEditor` in `src/web/main.ts`**

Add the imports beside the existing fleet ones (lines 8–11):

```ts
import { fleetScripts, isDirty, sortScripts, validateName, type FleetScript } from './fleetScripts';
import { buildFleetScriptRail } from './fleetScriptRail';
```

Replace the whole function (lines 2219–2310) with:

```ts
// Full bash-script editor for a fleet run. The script text is sent verbatim and
// executed by each box's login shell, so newlines run exactly like a local
// script. Doubles as the confirm step — its Run button creates the job directly.
// The rail on the left is the saved-script store (data/fleet-scripts.json); the
// unnamed buffer stays a first-class row so selecting a saved script never
// orphans typed work.
function openFleetScriptEditor(initial: string, targets: { id: string; label: string }[]) {
  const form = document.createElement('form');
  form.className = 'modal fleet-script-modal';

  const title = document.createElement('h2');
  title.textContent = 'Fleet script';

  const hint = document.createElement('p');
  hint.className = 'fleet-script-hint';
  hint.textContent = 'Runs on each selected box via its login shell. Newlines are honored — write a full bash script. ⌘/Ctrl+Enter to run, ⌘/Ctrl+S to save.';

  const nameInput = document.createElement('input');
  nameInput.className = 'fs-name';
  nameInput.type = 'text';
  nameInput.maxLength = 80;
  nameInput.placeholder = 'name (save to keep this script)';
  nameInput.setAttribute('aria-label', 'Script name');
  nameInput.autocomplete = 'off';

  const noteInput = document.createElement('input');
  noteInput.className = 'fs-note';
  noteInput.type = 'text';
  noteInput.maxLength = 200;
  noteInput.placeholder = 'note (optional)';
  noteInput.setAttribute('aria-label', 'Script note');
  noteInput.autocomplete = 'off';

  const metaRow = document.createElement('div');
  metaRow.className = 'fs-meta-row';
  metaRow.append(nameInput, noteInput);

  const editorHost = document.createElement('div');
  editorHost.className = 'fleet-script';

  const main = document.createElement('div');
  main.className = 'fleet-script-main';
  main.append(metaRow, editorHost);

  const body = document.createElement('div');
  body.className = 'fleet-script-body';

  const targetList = document.createElement('div');
  targetList.className = 'fleet-confirm-targets';
  targetList.textContent = targets.length
    ? targets.map((t) => t.label).join('  •  ')
    : 'No boxes selected — select boxes before running.';

  const err = document.createElement('p');
  err.className = 'err';
  err.setAttribute('role', 'alert');

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'fs-save';
  saveBtn.textContent = 'Save';
  const runBtn = document.createElement('button');
  runBtn.type = 'submit';
  runBtn.className = 'fleet-script-run';
  runBtn.textContent = `Run on ${targets.length} box${targets.length === 1 ? '' : 'es'}`;
  runBtn.disabled = targets.length === 0;
  actions.append(cancel, saveBtn, runBtn);

  // --- saved-script state -------------------------------------------------
  let scripts: FleetScript[] = [];
  let selected: FleetScript | null = null;

  const dirty = () => isDirty(selected, cm.getValue(), nameInput.value, noteInput.value);

  function refreshRail() {
    rail.update({ scripts, selectedId: selected?.id ?? null, dirty: dirty() });
  }

  // Load into the editor. Called only once the dirty gate below has cleared.
  function load(script: FleetScript | null) {
    selected = script;
    nameInput.value = script?.name || '';
    noteInput.value = script?.description || '';
    cm.setValue(script ? script.script : fleetScriptDraft);
    err.textContent = '';
    refreshRail();
    cm.focus();
  }

  const rail = buildFleetScriptRail({
    onSelect: (script) => {
      if (script?.id === (selected?.id ?? null)) return;
      if (!dirty()) { load(script); return; }
      confirmDiscard(() => load(script));
    },
    onDelete: async (script) => {
      try {
        await fleetScripts.remove(script.id);
        scripts = scripts.filter((s) => s.id !== script.id);
        if (selected?.id === script.id) { selected = null; refreshRail(); }
        else refreshRail();
      } catch (ex: any) {
        err.textContent = ex?.message || 'Could not delete the script';
      }
    },
  });

  body.append(rail.dom, main);
  form.append(title, hint, body, targetList, err, actions);

  // closeOnEscape off: while the editor has focus its own keymap owns Escape
  // (so an open completion popup's Escape doesn't also tear down the modal);
  // the fallback handler below covers Escape/Mod-Enter when focus is elsewhere.
  const { close } = openModal({
    modal: form, mount: app, closeOnEscape: false,
    onClose: () => { document.removeEventListener('keydown', onKey); rail.destroy(); cm.destroy(); },
  });

  // CodeMirror handles its own Mod-Enter (run) / Mod-S (save) / Escape (close)
  // while focused; onChange persists the in-progress script so reopening
  // restores it — but only while the unnamed draft is the buffer, since a
  // selected script's edits belong to that script, not to the draft.
  const cm = createFleetScriptEditor({
    initial: fleetScriptDraft || initial || '',
    recent: readFleetRecent(),
    placeholder: '#!/usr/bin/env bash\nset -euo pipefail\n…',
    onChange: (v) => { if (!selected) fleetScriptDraft = v; refreshRail(); },
    onRun: () => form.requestSubmit(),
    onSave: () => void save(),
    onEscape: () => close(),
  });
  editorHost.appendChild(cm.dom);
  cm.focus();
  nameInput.addEventListener('input', refreshRail);
  noteInput.addEventListener('input', refreshRail);

  // Load the saved list; a failure leaves the editor fully usable.
  fleetScripts.list()
    .then((list) => { scripts = sortScripts(list); refreshRail(); })
    .catch(() => { err.textContent = 'Could not load saved scripts'; });

  // A second, nested modal: the only gate in this flow, and only on a real
  // conflict (switching away from unsaved work).
  function confirmDiscard(proceed: () => void) {
    const dlg = document.createElement('div');
    dlg.className = 'modal fs-discard';
    const h = document.createElement('h2');
    h.textContent = 'Discard unsaved changes?';
    const p = document.createElement('p');
    p.textContent = 'The edits in the editor have not been saved to a script.';
    const row = document.createElement('div');
    row.className = 'modal-actions';
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.textContent = 'Cancel';
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'danger';
    discard.textContent = 'Discard';
    row.append(keep, discard);
    dlg.append(h, p, row);
    const { close: closeDlg } = openModal({ modal: dlg, mount: app });
    keep.addEventListener('click', closeDlg);
    discard.addEventListener('click', () => { closeDlg(); proceed(); });
  }

  async function save() {
    const script = cm.getValue();
    if (!script.trim()) { err.textContent = 'Script is empty'; return; }
    const nameError = validateName(nameInput.value, scripts, selected?.id ?? null);
    if (nameError) { err.textContent = nameError; nameInput.focus(); return; }
    saveBtn.disabled = true;
    try {
      const spec = { name: nameInput.value.trim(), description: noteInput.value.trim(), script };
      const saved = selected
        ? await fleetScripts.update(selected.id, spec)
        : await fleetScripts.create(spec);
      scripts = sortScripts([...scripts.filter((s) => s.id !== saved.id), saved]);
      selected = saved;
      // The buffer now belongs to a saved script, so the unnamed draft is spent.
      fleetScriptDraft = '';
      err.textContent = '';
      refreshRail();
    } catch (ex: any) {
      // Someone else deleted it: demote to the unnamed draft rather than
      // discarding the operator's text.
      if (statusOf(ex) === 404) {
        selected = null;
        err.textContent = 'That script no longer exists — saving will create a new one.';
        refreshRail();
      } else {
        err.textContent = ex?.message || 'Could not save the script';
      }
    } finally {
      saveBtn.disabled = false;
    }
  }
  saveBtn.addEventListener('click', () => void save());

  // Fallback for keys pressed while focus is on a button or the name fields
  // (the editor's own keymap owns these while it is focused — defer to it so an
  // open completion popup's Escape doesn't also tear down the modal).
  function onKey(e: KeyboardEvent) {
    if (cm.dom.contains(document.activeElement)) return;
    if (e.key === 'Escape') close();
    else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); void save(); }
  }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const command = cm.getValue().trim();
    if (!command) { err.textContent = 'Script is empty'; return; }
    if (targets.length === 0) { err.textContent = 'Select at least one box'; return; }
    runBtn.disabled = true;
    try {
      // Name the run only when the buffer IS the saved script. A dirty buffer
      // runs nameless rather than claiming to be a script it no longer is.
      const scriptName = selected && !dirty() ? selected.name : undefined;
      const job = await api.createFleetJob(targets.map((t) => t.id), command, scriptName);
      // Only single-line commands belong in the one-liner autocomplete/datalist.
      if (!command.includes('\n')) pushFleetRecent(command);
      fleetScriptDraft = '';
      close();
      openFleetJobsPanel(job.id);
    } catch (ex: any) {
      err.textContent = ex?.message || 'Could not start fleet job';
      runBtn.disabled = false;
    }
  });
}
```

Two supporting changes this rewrite needs:

1. `main.ts` does not import from `./http` today (only `api.ts`, `proxmoxUi.ts` and the other fetch layers do), so add the import beside the ones above:

```ts
import { statusOf } from './http';
```
2. `createFleetScriptEditor` has no `setValue`. Add it to `src/web/fleetEditor.ts` — to the `FleetScriptEditor` interface:

```ts
  setValue(text: string): void;
```

and to the returned object:

```ts
    setValue: (text: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
```

- [ ] **Step 4: Add the styles**

Read `DESIGN.md` first, then append to `src/web/style.css` after the existing `.fleet-script-run` rules (line 1215). Use the existing custom properties (`--panel`, `--border`, `--muted`, `--dim`, `--text`, `--amber`, `--key-face`, `--key-border`, `--key-edge`) — do not introduce new colors:

```css
/* Saved-script rail + editor share the modal body. */
.fleet-script-modal { width: 820px; max-width: 94vw; }
.fleet-script-body { display: flex; gap: 12px; align-items: stretch; }
.fleet-script-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.fleet-script-rail { flex: 0 0 180px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.fs-eyebrow { font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
.fs-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; max-height: 46vh; display: flex; flex-direction: column; gap: 2px; }
.fs-row { display: flex; align-items: stretch; gap: 4px; border-radius: 6px; }
.fs-row.selected { background: rgba(255, 176, 0, 0.1); }
.fs-open { flex: 1; min-width: 0; text-align: left; background: none; border: none; color: var(--dim); cursor: pointer; padding: 6px 8px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fs-row.selected .fs-open { color: var(--text); }
.fs-open:hover { color: var(--text); }
.fs-dot { color: var(--amber); margin-left: 6px; }
.fs-del { flex: 0 0 auto; background: none; border: none; color: var(--muted); cursor: pointer; padding: 0 6px; font-size: 11px; }
.fs-del:hover { color: var(--text); }
.fs-del.armed { color: #ff8a4d; font-weight: 700; }
.fs-empty { color: var(--muted); font-size: 11px; padding: 6px 8px; }
.fs-new { align-self: flex-start; background: var(--key-face); border: 1px solid var(--key-border); box-shadow: var(--key-edge); border-radius: 6px; color: var(--dim); cursor: pointer; font-size: 11px; padding: 4px 8px; }
.fs-new:hover { color: var(--text); }
.fs-meta-row { display: flex; gap: 6px; }
.fs-meta-row .fs-name { flex: 0 0 40%; min-width: 0; }
.fs-meta-row .fs-note { flex: 1; min-width: 0; }
/* `.danger` is only ever scoped in this file, so the discard dialog needs its
   own rule rather than inheriting a global one that does not exist. */
.fs-discard .danger { color: var(--crit); }
@media (max-width: 720px) {
  .fleet-script-body { flex-direction: column; }
  .fleet-script-rail { flex: 1 1 auto; }
  .fs-list { max-height: 22vh; }
}
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: no type errors; the Vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/web/fleetScriptRail.ts src/web/fleetEditor.ts src/web/main.ts src/web/style.css
git commit -m "feat(ui): saved-script rail in the fleet script editor"
```

---

### Task 6: Browser coverage

**Files:**
- Modify: `test/e2e/fleet.spec.ts` (append two tests)

**Interfaces:**
- Consumes: everything from Tasks 1–5, through the real app.
- Produces: nothing other tasks depend on.

Server-side green is not evidence a UI works — a previous feature shipped with the whole suite passing and an element that never rendered. These two tests assert the rendered rail and the end-to-end provenance label.

- [ ] **Step 1: Write the failing tests**

Append to `test/e2e/fleet.spec.ts`:

```ts
test('a saved script survives a reload and loads back into the editor', async ({ page }) => {
  await loginAndWait(page);
  await page.getByRole('button', { name: 'Fleet Command', exact: true }).click();
  await page.locator('.box', { hasText: 'localhost' }).locator('input.box-check').check();

  await page.locator('.fleet-expand').click();
  await expect(page.locator('.fleet-script-modal .cm-content')).toBeVisible();
  await page.keyboard.type('echo SAVED_SCRIPT_MARKER');
  await page.locator('.fleet-script-modal .fs-name').fill('marker script');
  await page.locator('.fleet-script-modal .fs-save').click();

  // The row is really painted, not merely present in the DOM.
  const row = page.locator('.fleet-script-rail .fs-row', { hasText: 'marker script' });
  await expect(row).toBeVisible();

  await page.reload();
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Fleet Command', exact: true }).click();
  await page.locator('.fleet-expand').click();
  await page.locator('.fleet-script-rail .fs-row', { hasText: 'marker script' }).locator('.fs-open').click();
  await expect(page.locator('.fleet-script-modal .cm-content')).toContainText('echo SAVED_SCRIPT_MARKER');
});

test('running a saved script labels the job with the script name', async ({ page }) => {
  await loginAndWait(page);
  await page.getByRole('button', { name: 'Fleet Command', exact: true }).click();
  await page.locator('.box', { hasText: 'localhost' }).locator('input.box-check').check();

  await page.locator('.fleet-expand').click();
  await page.keyboard.type('echo NAMED_RUN_MARKER');
  await page.locator('.fleet-script-modal .fs-name').fill('named run');
  await page.locator('.fleet-script-modal .fs-save').click();
  await expect(page.locator('.fleet-script-rail .fs-row.selected', { hasText: 'named run' })).toBeVisible();

  await page.locator('.fleet-script-modal .fleet-script-run').click();
  await expect(page.locator('#fleet-panel .fleet-detail')).toContainText('NAMED_RUN_MARKER', { timeout: 20000 });
  // The history row shows the script's name rather than the raw command.
  await expect(page.locator('#fleet-panel .fleet-history')).toContainText('named run');
});
```

- [ ] **Step 2: Run them to verify they fail against the pre-Task-5 build**

If Task 5 is already committed this passes immediately — that is fine, note it and move on. Otherwise:

Run: `npm run test:e2e -- fleet.spec.ts`
Expected: FAIL on the missing `.fs-name` locator.

- [ ] **Step 3: Run the e2e suite**

Run: `npm run test:e2e -- fleet.spec.ts`
Expected: PASS, all six tests in the file.

If the rail row is present but not visible, that is the real bug this task exists to catch — fix the CSS in `style.css`, do not relax the assertion.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/fleet.spec.ts
git commit -m "test(e2e): saved fleet scripts persist and label their jobs"
```

---

### Task 7: Docs and full verification

**Files:**
- Modify: `README.md` (Fleet Command section)
- Modify: `CLAUDE.md` (the `data/` list under "Self-contained principle"; the `src/server/` architecture list; the `src/web/` module list)
- Modify: `AGENTS.md` (the same three places — it is the same content adapted for general agents)

**Interfaces:**
- Consumes: the finished feature.
- Produces: nothing.

- [ ] **Step 1: Update `README.md`**

In the Fleet Command section, after the script-editor description, add:

```markdown
Scripts you expect to run again can be **saved**: give the script a name (and an optional
note) in the editor and hit Save, and it joins the rail on the left of the modal. Saved
scripts live in `data/fleet-scripts.json` on the Tmuxifier host, so they survive a browser
change and a restart, and the job history labels each run with the script's name.

A script body is stored as plain text (the file is owner-only, `0o600`, but not encrypted),
and it is also persisted verbatim in the fleet job history — so don't paste credentials into
one.
```

- [ ] **Step 2: Update `CLAUDE.md`**

In the `data/` bullet under "Self-contained principle", add `fleet-scripts.json` to the parenthetical list of files, described as "Fleet Command's saved scripts (plain text, not encrypted)".

In the `src/server/` architecture list, after the `fleet.js` / `fleetStore.js` bullet, add:

```markdown
- `fleetScriptsStore.js` — `data/fleet-scripts.json` CRUD for Fleet Command's saved scripts
  (name, optional note, body), in the mold of `servicesStore.js`: validation inside, mutations
  serialized, `0o600`. Nothing here is sealed — a script body holds no credential class
  Tmuxifier manages. The body cap is deliberately the same 65536 the `/api/fleet/jobs` route
  enforces on `command`, so a script that can be saved can always be run. The name a run was
  launched from rides along as `job.scriptName`, a **frozen display label** the server never
  resolves back against this store — renaming or deleting a script cannot rewrite what a past
  job says it ran.
```

In the `src/web/` module list, after `fleetPoll.ts`, add:

```markdown
`fleetScripts.ts`/`fleetScriptRail.ts` (saved fleet scripts: the fetch layer plus the pure
`isDirty`/`validateName`/`sortScripts` helpers, and the modal's left rail — an in-place-updating
DOM layer whose delete key arms through the shared `arming.ts` reducer. The unnamed buffer stays
a first-class `Draft` row, so selecting a saved script can never orphan typed work; switching
away from a dirty buffer is the one gated action)
```

- [ ] **Step 3: Mirror the same three edits into `AGENTS.md`**

Run `diff <(grep -n "fleetStore" CLAUDE.md) <(grep -n "fleetStore" AGENTS.md)` to locate the matching spots, and apply the same additions.

- [ ] **Step 4: Run the full suite**

```bash
npm test
npm run test:e2e
```

Expected: both green. `npm test` runs typecheck + vitest.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md AGENTS.md
git commit -m "docs: saved fleet scripts"
```

---

### Task 8: Live validation and release

**Files:**
- Modify: `package.json`, `package-lock.json` (version bump)

**Interfaces:**
- Consumes: the merged, tested feature branch.
- Produces: a deployed, tagged release.

Features are validated on the **live app before they merge**. Do not skip to the ship checklist.

- [ ] **Step 1: Confirm no job is running**

Ask the operator to confirm no setup, provision, lifecycle, fleet, or voice-install job is `running` — a restart would interrupt it.

- [ ] **Step 2: Deploy the candidate**

```bash
npm run build
rsync -a --delete "$PWD/dist/" /root/tmuxifier/dist/    # from the feature worktree; skip if working in-place
sudo systemctl restart tmuxifier
systemctl status tmuxifier
```

The restart is mandatory even for client-only changes: asset routes are registered per file at boot, so a freshly-swapped hashed bundle otherwise falls through to the SPA fallback and the app renders blank.

- [ ] **Step 3: Verify the deploy end-to-end**

```bash
BASE="$(node -e "import('./src/server/config.js').then(({loadConfig})=>{const c=loadConfig();process.stdout.write(((c.tlsCert&&c.tlsKey)?'https':'http')+'://'+c.bindAddress+':'+c.port)})")"
curl -sk -o /dev/null -w '%{http_code}\n' "$BASE/"   # 200
```

Then fetch one hashed asset from `dist/` and confirm its real content-type (not `text/html`).

- [ ] **Step 4: Operator validation**

Ask the operator to confirm in the browser: save a script, reload, load it back, rename it, delete it (two clicks), run one and see its name in the Fleet Jobs history.

- [ ] **Step 5: Merge and ship**

Only after the operator confirms. Follow the checklist in `CLAUDE.md` verbatim: `npm version patch --no-git-tag-version`, `npm run build`, restart, health check, lockfile version assertions, `git diff --cached` PII scrub, commit, annotated tag, push, `gh release create`, and the two post-release assertions.

---

## Notes for the implementer

- **Do not** add DOM tests to Vitest. There is no jsdom; `test/e2e/` is where rendered behaviour is proven.
- **Do not** hand-roll `fetch` + `res.ok` on the client. Everything goes through `src/web/http.ts` so an expired session reaches the central 401 seam.
- The store is the validation authority. The client's `validateName` exists to spare a round trip, not to replace the server check — never loosen the server because the client already checks.
- `job.scriptName` is a label. If you find yourself looking a script up by name anywhere on the server, stop: that reintroduces exactly the coupling the design froze out.
