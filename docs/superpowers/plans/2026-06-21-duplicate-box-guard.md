# Duplicate Box Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate box hosts or labels when boxes are added or edited.

**Architecture:** Put duplicate validation in `src/server/store.js` so API calls, UI flows, imports, and direct store usage share the same guard. Reuse the current store error pattern and existing API `400 { error }` conversion.

**Tech Stack:** Node 20 ESM, Fastify, Vitest.

---

## File Structure

- Modify `test/store.test.js`: add behavior tests for duplicate host and label validation.
- Modify `test/server.test.js`: add one API-level assertion that duplicate store errors return `400`.
- Modify `src/server/store.js`: add canonical comparison and duplicate validation helper, then call it from `addBox` and `updateBox`.

### Task 1: Store Duplicate Validation Tests

**Files:**
- Modify: `test/store.test.js`
- Test: `test/store.test.js`

- [ ] **Step 1: Write failing store tests**

Add these tests after the existing unsafe host tests:

```js
test('addBox rejects duplicate host ignoring case', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });
  await store.addBox({ host: 'Prod-DB' });

  await expect(store.addBox({ host: 'prod-db' })).rejects.toThrow(/host already exists/);
});

test('addBox rejects duplicate label ignoring case', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });
  await store.addBox({ host: 'prod-db-1', label: 'Primary DB' });

  await expect(store.addBox({ host: 'prod-db-2', label: 'primary db' })).rejects.toThrow(/label already exists/);
});

test('updateBox rejects duplicate host and label from another box', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });
  const first = await store.addBox({ host: 'prod-db-1', label: 'Primary DB' });
  const second = await store.addBox({ host: 'prod-db-2', label: 'Replica DB' });

  await expect(store.updateBox(second.id, { host: 'PROD-DB-1' })).rejects.toThrow(/host already exists/);
  await expect(store.updateBox(second.id, { label: 'primary db' })).rejects.toThrow(/label already exists/);
  await expect(store.updateBox(first.id, { label: 'PRIMARY DB' })).resolves.toMatchObject({ label: 'PRIMARY DB' });
});
```

- [ ] **Step 2: Run store tests and verify RED**

Run: `npm test -- test/store.test.js`

Expected: the new duplicate tests fail because duplicates are currently accepted.

### Task 2: API Duplicate Error Test

**Files:**
- Modify: `test/server.test.js`
- Test: `test/server.test.js`

- [ ] **Step 1: Write failing API test**

Add this test near `login then CRUD a box`:

```js
test('POST /api/boxes rejects duplicate host with a 400 error', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'Prod-DB' } });
  const duplicate = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'prod-db' } });

  expect(duplicate.statusCode).toBe(400);
  expect(duplicate.json()).toEqual({ error: 'box host already exists' });
});
```

- [ ] **Step 2: Run API test and verify RED**

Run: `npm test -- test/server.test.js -t "POST /api/boxes rejects duplicate host"`

Expected: the test fails because the duplicate add currently returns `201`.

### Task 3: Store Implementation

**Files:**
- Modify: `src/server/store.js`
- Test: `test/store.test.js`, `test/server.test.js`

- [ ] **Step 1: Add canonical comparison helpers**

Add helpers above `createStore`:

```js
function canonicalUniqueValue(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function assertUniqueBox(boxes, candidate, ignoreId) {
  const host = canonicalUniqueValue(candidate.host);
  const label = canonicalUniqueValue(candidate.label);
  for (const box of boxes) {
    if (ignoreId && box.id === ignoreId) continue;
    if (host && canonicalUniqueValue(box.host) === host) throw new Error('box host already exists');
    if (label && canonicalUniqueValue(box.label) === label) throw new Error('box label already exists');
  }
}
```

- [ ] **Step 2: Call helper from add and update**

Change `addBox` and `updateBox` to validate before writing:

```js
async addBox(spec) {
  const boxes = await readAll();
  const box = normalize(spec);
  assertBoxSafe(box);
  assertUniqueBox(boxes, box);
  boxes.push(box);
  await writeAll(boxes);
  return box;
},
async updateBox(id, patch) {
  const boxes = await readAll();
  const i = boxes.findIndex((b) => b.id === id);
  if (i === -1) throw new Error('box not found');
  boxes[i] = normalize({ ...boxes[i], ...patch, host: patch.host ?? boxes[i].host }, boxes[i]);
  for (const key of ['user', 'port', 'proxyJump']) {
    if (key in patch && patch[key] === null) boxes[i][key] = undefined;
  }
  assertBoxSafe(boxes[i]);
  assertUniqueBox(boxes, boxes[i], id);
  await writeAll(boxes);
  return boxes[i];
},
```

- [ ] **Step 3: Run focused tests and verify GREEN**

Run: `npm test -- test/store.test.js test/server.test.js -t "duplicate|POST /api/boxes rejects duplicate host"`

Expected: all duplicate-focused tests pass.

### Task 4: Full Verification

**Files:**
- Test: full project

- [ ] **Step 1: Run full test suite**

Run: `npm test`

Expected: all Vitest tests pass.

- [ ] **Step 2: Review changed files**

Run: `git diff -- test/store.test.js test/server.test.js src/server/store.js docs/superpowers/specs/2026-06-21-duplicate-box-guard-design.md docs/superpowers/plans/2026-06-21-duplicate-box-guard.md`

Expected: diff contains only duplicate guard tests, store validation, and the two planning documents.
