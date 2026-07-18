# Graceful Stale Host Key Handling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop recycled IPs from wedging boxes on `REMOTE HOST IDENTIFICATION HAS CHANGED` — auto-clear known_hosts entries only on Tmuxifier-owned lifecycle events (verified deprovision, fresh provision), and give manual boxes a server-classified "host key changed" status with a user-consent "Forget host key" action.

**Architecture:** A new `knownHosts.js` module wraps `execFile('ssh-keygen', ['-R', target])` behind a DI factory (`createKnownHosts`). It is injected into `proxmoxLifecycle` (forget on verified deprovision), `proxmoxProvision` (forget when a new container's IP is known), and `server.js` (a `POST /api/boxes/:id/forget-hostkey` route gated on explicit user click). `status.js` gains a `hostKeyChanged` classification so the UI shows the button only on real signal; `healthHistory` emits a `'key-changed'` event kind.

**Tech Stack:** Node 20 ESM server (`.js`), TypeScript web client, vitest, DI fakes (no mocks).

**Spec:** `docs/superpowers/specs/2026-07-18-stale-hostkey-handling-design.md`

## Global Constraints

- A known_hosts entry is removed in exactly three situations: verified deprovision (container provably destroyed), provision (Tmuxifier just created the guest at that IP), and explicit user click. **Never** on connection failure alone, and **never** in ordinary `boxRemoval.removeBox` (the machine still exists; `~/.ssh/known_hosts` is shared with the user's regular ssh usage).
- `ssh-keygen` is always invoked with an argv array via `execFile` — never a shell string.
- All forget calls are best-effort: `forget()` never throws; callers never let a forget failure fail the surrounding job.
- Classification precedence in `status.js`: host-key test runs before the auth test (key verification aborts before auth; they never legitimately co-occur).
- Tests use real code with DI fakes, TDD (failing test first, show RED, then GREEN). Vitest node environment — web tests cover pure exports only.
- Conventional-commit messages.

---

### Task 1: `knownHosts.js` module

**Files:**
- Create: `src/server/knownHosts.js`
- Test: `test/knownHosts.test.js` (new)

**Interfaces:**
- Produces: `createKnownHosts({ run } = {})` → `{ forget(host, port): Promise<Array<{code,stdout,stderr}>> }`. `run(args, opts?)` defaults to an `execFile('ssh-keygen', args, …)` wrapper resolving `{ code, stdout, stderr }` (never rejecting). `forget` never throws.

- [ ] **Step 1: Write the failing tests**

Create `test/knownHosts.test.js`:

```js
import { test, expect } from 'vitest';
import { createKnownHosts } from '../src/server/knownHosts.js';

function capture() {
  const calls = [];
  return { calls, run: async (args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; } };
}

test('forget removes the plain host entry', async () => {
  const { calls, run } = capture();
  await createKnownHosts({ run }).forget('192.168.1.50', 22);
  expect(calls).toEqual([['-R', '192.168.1.50']]);
});

test('forget also removes the bracketed form for a nonstandard port', async () => {
  const { calls, run } = capture();
  await createKnownHosts({ run }).forget('box.example.com', 2222);
  expect(calls).toEqual([['-R', 'box.example.com'], ['-R', '[box.example.com]:2222']]);
});

test('forget treats a missing port like 22 (plain form only)', async () => {
  const { calls, run } = capture();
  await createKnownHosts({ run }).forget('box.example.com', undefined);
  expect(calls).toEqual([['-R', 'box.example.com']]);
});

test('forget never throws when run fails or rejects', async () => {
  const boom = createKnownHosts({ run: async () => { throw new Error('no ssh-keygen'); } });
  const results = await boom.forget('h', 2222);
  expect(results).toHaveLength(2);
  expect(results[0].code).toBe(1);
  const failCode = createKnownHosts({ run: async () => ({ code: 255, stdout: '', stderr: 'nope' }) });
  await expect(failCode.forget('h', 22)).resolves.toEqual([{ code: 255, stdout: '', stderr: 'nope' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/knownHosts.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server/knownHosts.js`**

```js
import { execFile } from 'node:child_process';

// Local `ssh-keygen -R` runner. argv array, never a shell string — hosts are
// already allowlist-validated (assertBoxSafe), but no shell means no
// interpolation surface at all. Resolves {code,stdout,stderr}, never rejects
// (same contract as runLocalShellScript in localShellActions.js).
function runSshKeygen(args, { timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile('ssh-keygen', args, { timeout, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}

export function createKnownHosts({ run = runSshKeygen } = {}) {
  return {
    // Remove known_hosts entries for host (and its [host]:port form when a
    // nonstandard port is used — known_hosts stores nonstandard-port entries
    // bracketed). Best-effort by contract: a key may legitimately be removed
    // only when Tmuxifier destroyed the machine, just created it at this
    // address, or the user explicitly asked — callers treat failure like the
    // entry not existing. Operates on the service user's default
    // ~/.ssh/known_hosts (ssh-keygen -R handles hashed entries); a custom
    // UserKnownHostsFile in TMUXIFIER_SSH_CONFIG is out of scope (see spec).
    async forget(host, port) {
      const targets = [String(host)];
      const p = Number(port);
      if (p && p !== 22) targets.push(`[${host}]:${p}`);
      const results = [];
      for (const target of targets) {
        try {
          results.push(await run(['-R', target]));
        } catch (e) {
          results.push({ code: 1, stdout: '', stderr: String((e && e.message) || e) });
        }
      }
      return results;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/knownHosts.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/server/knownHosts.js test/knownHosts.test.js
git commit -m "feat(hostkey): knownHosts module wrapping ssh-keygen -R

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `hostKeyChanged` status classification

**Files:**
- Modify: `src/server/status.js` (regex consts ~line 66-72; probe classification block ~line 130-136)
- Test: `test/status.test.js` (next to the needsAuth test at ~line 54)

**Interfaces:**
- Produces: probe/`checkBox` may now return `{ reachable: false, hostKeyChanged: true, error }`. Tasks 5-7 rely on the `hostKeyChanged` field name.

- [ ] **Step 1: Write the failing tests**

Add to `test/status.test.js` after the `'checkBox: auth failure is reported as needsAuth …'` test (~line 60):

```js
test('checkBox: changed host key is reported as hostKeyChanged', async () => {
  const stderr = '@@@@@@@@@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n@@@@@@@@@@@@\nHost key verification failed.';
  const run = async () => ({ code: 255, stdout: '', stderr });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.reachable).toBe(false);
  expect(status.hostKeyChanged).toBe(true);
  expect(status.needsAuth).toBeFalsy();
});

test('checkBox: auth failure stays needsAuth, not hostKeyChanged', async () => {
  const run = async () => ({ code: 255, stdout: '', stderr: 'me@h: Permission denied (publickey,password).' });
  const status = await createStatusChecker({ run }).checkBox({ host: 'h' });
  expect(status.needsAuth).toBe(true);
  expect(status.hostKeyChanged).toBeFalsy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/status.test.js`
Expected: FAIL — `hostKeyChanged` undefined on the first new test.

- [ ] **Step 3: Implement**

In `src/server/status.js`, after `AUTH_FAIL_RE` (~line 66), add:

```js
// ssh under StrictHostKeyChecking=accept-new hard-rejects a CHANGED key (it
// only auto-accepts unknown hosts). Typical after a NetBox-recycled IP lands
// on a rebuilt container. Distinguished so the UI can offer an explicit
// "Forget host key" action instead of a generic red dot.
const HOSTKEY_CHANGE_RE = /remote host identification has changed|host key verification failed/i;
```

In `probe()`'s failure block (~line 130), insert the host-key check BEFORE the auth check:

```js
      if (res.code !== 0 && !String(res.stdout).trim()) {
        const err = String(res.stderr || '').trim();
        if (HOSTKEY_CHANGE_RE.test(err)) {
          return { reachable: false, hostKeyChanged: true, error: err || 'host key changed' };
        }
        if (AUTH_FAIL_RE.test(err)) {
          return { reachable: false, needsAuth: true, error: err || 'authentication required' };
        }
        return { reachable: false, error: err || 'unreachable' };
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/status.test.js`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/server/status.js test/status.test.js
git commit -m "feat(status): classify changed host keys as hostKeyChanged

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Forget on verified deprovision

**Files:**
- Modify: `src/server/proxmoxLifecycle.js` (factory params ~line 11-17; `runDeprovision` ~line 150-177)
- Modify: `src/server/index.js` (create `knownHosts`, pass to `createProxmoxLifecycleManager` at ~line 126)
- Test: `test/proxmoxLifecycle.test.js` (deprovision tests, ~line 172+)
- Test: `test/boxRemoval.test.js` (negative assertion)

**Interfaces:**
- Consumes: `createKnownHosts` (Task 1).
- Produces: `createProxmoxLifecycleManager` accepts optional `knownHosts` (`{ forget(host, port) }`, default `null` → no-op). Existing callers without it are unaffected.

- [ ] **Step 1: Write the failing test**

Add to `test/proxmoxLifecycle.test.js` near the deprovision NetBox-release tests (after ~line 224; reuse the existing `fixture(initialState, overrides)` helper and its `BOX` const — `BOX.host` is `'192.168.1.10'`, no port field):

```js
test('verified deprovision forgets the box host key (destroy path and missing-at-entry path)', async () => {
  for (const initial of ['stopped', 'missing']) {
    const forgets = [];
    const { manager } = fixture(initial, {
      knownHosts: { forget: async (host, port) => { forgets.push([host, port]); return []; } },
    });
    const summary = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmLabel: 'dev-01' });
    await manager._settled(summary.id);
    expect(manager.getJob(summary.id).status).toBe('done');
    expect(forgets).toEqual([['192.168.1.10', undefined]]);
  }
});

test('deprovision succeeds even when forgetting the host key rejects', async () => {
  const { manager } = fixture('stopped', {
    knownHosts: { forget: async () => { throw new Error('ssh-keygen missing'); } },
  });
  const summary = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmLabel: 'dev-01' });
  await manager._settled(summary.id);
  expect(manager.getJob(summary.id).status).toBe('done');
});
```

Note for the implementer: check how the existing deprovision tests at ~line 172+ construct `createJob` for deprovision (confirm-label field name and any state prerequisites) and mirror them exactly — if the existing tests use a different confirmation field or need `initialState: 'stopped'` semantics, copy their shape rather than the sketch above.

Add to `test/boxRemoval.test.js` (mirroring the existing fake-`boxActions` call-order pattern at ~line 22-24):

```js
test('ordinary box removal never touches known_hosts', async () => {
  const calls = [];
  const removal = createBoxRemoval({
    store: { getBox: async () => ({ id: 'b1', host: 'h', sessionName: 's' }), removeBox: async () => {} },
    sessions: { closeKey: () => {} },
    boxActions: {
      killSession: async () => { calls.push('killSession'); },
      exitMaster: async () => { calls.push('exitMaster'); },
      forgetHostKey: async () => { calls.push('forgetHostKey'); },
    },
  });
  await removal.removeBox('b1');
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).not.toContain('forgetHostKey');
});
```

(Adapt the `createBoxRemoval` argument shape to match the file's existing tests exactly — the point is the negative assertion.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/proxmoxLifecycle.test.js test/boxRemoval.test.js`
Expected: the new lifecycle test FAILS (`forgets` stays empty — `knownHosts` is an unknown option today). The boxRemoval negative test passes immediately (nothing calls forgetHostKey); that is fine — it is a regression lock, note it in the report.

- [ ] **Step 3: Implement**

In `src/server/proxmoxLifecycle.js` factory params (~line 12), add `knownHosts = null,` after `removeLinkedBox,`:

```js
export function createProxmoxLifecycleManager({
  boxStore, proxmoxStore, inventory, makeClient, removeLinkedBox, knownHosts = null,
```

In `runDeprovision`, add a helper call in BOTH unlink phases. Insert immediately after each `job.phase = 'unlink'; persist();` line (missing-at-entry path ~line 155 and destroy path ~line 174), before `releaseNetboxIp`:

```js
      // The container is verifiably gone — its host key is dead by definition.
      // Best-effort: a failure here must never fail the deprovision.
      if (knownHosts) { try { await knownHosts.forget(box.host, box.port); } catch {} }
```

In `src/server/index.js`: import and create the module near the other factory creations, and pass it to the lifecycle manager (~line 126):

```js
import { createKnownHosts } from './knownHosts.js';
// …
const knownHosts = createKnownHosts();
// …
const lifecycleManager = createProxmoxLifecycleManager({
  // …existing args unchanged…
  knownHosts,
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/proxmoxLifecycle.test.js test/boxRemoval.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxLifecycle.js src/server/index.js test/proxmoxLifecycle.test.js test/boxRemoval.test.js
git commit -m "feat(hostkey): forget known_hosts entry on verified deprovision

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Forget on provision (fresh container IP)

**Files:**
- Modify: `src/server/proxmoxProvision.js` (factory params ~line 10-16; `link` phase ~line 124-127)
- Modify: `src/server/index.js` (pass `knownHosts` to `createProvisionManager` at ~line 99)
- Test: `test/proxmoxProvision.test.js`

**Interfaces:**
- Consumes: `createKnownHosts` (Task 1; already created in `index.js` by Task 3).
- Produces: `createProvisionManager` accepts optional `knownHosts` (default `null` → no-op).

- [ ] **Step 1: Write the failing test**

Add to `test/proxmoxProvision.test.js` (reuse the file's existing `PRESET_AUTO`/`fakeNetbox`/`fakeBoxStore`/`okClient`/`makeStore`/`nbStore` helpers, mirroring the auto-static test at ~line 241):

```js
test('provision forgets any stale host key for the new IP before linking the box', async () => {
  const { client: netbox } = fakeNetbox();
  const boxStore = fakeBoxStore();
  const events = [];
  const trackedStore = { ...boxStore, addBox: async (b, o) => { events.push(['addBox', b.host]); return boxStore.addBox(b, o); } };
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: trackedStore, makeClient: () => okClient(),
    netboxStore: nbStore, makeNetboxClient: () => netbox,
    knownHosts: { forget: async (host, port) => { events.push(['forget', host, port]); return []; } },
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  expect(m.getProvision(j.id).status).toBe('done');
  expect(events).toEqual([['forget', '192.168.30.50', 22], ['addBox', '192.168.30.50']]);
});

test('provision succeeds even when forgetting the host key rejects', async () => {
  const { client: netbox } = fakeNetbox();
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: fakeBoxStore(), makeClient: () => okClient(),
    netboxStore: nbStore, makeNetboxClient: () => netbox,
    knownHosts: { forget: async () => { throw new Error('boom'); } },
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  expect(m.getProvision(j.id).status).toBe('done');
});
```

(If `fakeBoxStore()`'s shape makes the spread-wrapper awkward, capture call order however the file's existing tests track calls — the assertion that matters is forget-before-addBox with `('192.168.30.50', 22)`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/proxmoxProvision.test.js`
Expected: FAIL — no `forget` event recorded.

- [ ] **Step 3: Implement**

In `src/server/proxmoxProvision.js` factory params (~line 11), add `knownHosts = null,` after `defaultPublicKey = () => null,`.

In the `link` phase (~line 124), immediately after `if (boxHost) {` and `j.phase = 'link'; persist();`, before the `boxStore.addBox` call:

```js
      if (boxHost) {
        j.phase = 'link'; persist();
        // Tmuxifier just created this guest at boxHost — any known_hosts entry
        // for that address is by definition stale (NetBox-recycled IP).
        // Best-effort; provisioned boxes use the default port 22.
        if (knownHosts) { try { await knownHosts.forget(boxHost, 22); } catch {} }
        const bd = preset.boxDefaults || {};
```

In `src/server/index.js`, add `knownHosts,` to the `createProvisionManager({ … })` args (~line 99).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/proxmoxProvision.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/proxmoxProvision.js src/server/index.js test/proxmoxProvision.test.js
git commit -m "feat(hostkey): clear stale known_hosts entry when provisioning a new IP

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `POST /api/boxes/:id/forget-hostkey` route

**Files:**
- Modify: `src/server/server.js` (route next to the reconnect route at ~line 275; `buildServer` destructured params)
- Modify: `src/server/index.js` (pass `knownHosts` into `buildServer` at ~line 174)
- Test: `test/server.test.js` (next to the reconnect route tests at ~line 412-478)

**Interfaces:**
- Consumes: `createKnownHosts` (Task 1), `statusChecker.resetBackoff`, `boxActions.exitMaster` (existing).
- Produces: `POST /api/boxes/:id/forget-hostkey` → `{ ok: true }` | 404. `buildServer` accepts optional `knownHosts`.

- [ ] **Step 1: Write the failing tests**

Add to `test/server.test.js` after the reconnect tests (~line 478), reusing the file's `makeApp`/`login` helpers exactly as the reconnect tests do:

```js
test('forget-hostkey removes the key, drops the master, and resets backoff', async () => {
  const calls = [];
  const boxActions = { async exitMaster(box) { calls.push(['exitMaster', box.host]); } };
  const knownHosts = { async forget(host, port) { calls.push(['forget', host, port]); return []; } };
  const statusChecker = { async checkBox() { return { reachable: false }; }, resetBackoff(id) { calls.push(['resetBackoff', id]); } };
  app = await makeApp({ boxActions, knownHosts, statusChecker });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1', port: 2222, sessionName: 'work' } });
  const box = created.json();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${box.id}/forget-hostkey`, headers });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(calls).toEqual([['forget', 'h1', 2222], ['exitMaster', 'h1'], ['resetBackoff', box.id]]);
});

test('forget-hostkey returns 404 for unknown box and requires auth', async () => {
  app = await makeApp({ knownHosts: { forget: async () => [] } });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const missing = await app.inject({ method: 'POST', url: '/api/boxes/nonexistent/forget-hostkey', headers });
  expect(missing.statusCode).toBe(404);
  const unauthed = await app.inject({ method: 'POST', url: '/api/boxes/nonexistent/forget-hostkey' });
  expect(unauthed.statusCode).toBe(401);
});
```

(Adapt `makeApp`'s option shape and the statusChecker fake to whatever the surrounding tests pass — copy the reconnect tests' structure. If `makeApp` builds its own statusChecker, extend the fake the same way the reconnect tests obtain theirs.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.test.js`
Expected: FAIL — 404 route not found on the new URL.

- [ ] **Step 3: Implement**

In `src/server/server.js`: add `knownHosts` to `buildServer`'s destructured options (same list that has `boxActions`, `statusChecker`). Add the route directly after the reconnect route (~line 294):

```js
  // Explicit user consent replaces lifecycle proof: this is the only path that
  // removes a known_hosts entry for a machine Tmuxifier didn't create or
  // destroy. See docs/superpowers/specs/2026-07-18-stale-hostkey-handling-design.md.
  app.post('/api/boxes/:id/forget-hostkey', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'box not found' });
    if (knownHosts?.forget) {
      try { await knownHosts.forget(box.host, box.port); } catch {}
    }
    // Drop the ControlMaster so the next connect performs a fresh key exchange,
    // and clear probe backoff so the dot recovers promptly.
    if (boxActions?.exitMaster) {
      try { await boxActions.exitMaster(box); } catch {}
    }
    if (statusChecker?.resetBackoff) statusChecker.resetBackoff(box.id);
    return { ok: true };
  });
```

In `src/server/index.js`, add `knownHosts,` to the `buildServer({ … })` call (~line 174).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/server.test.js`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js src/server/index.js test/server.test.js
git commit -m "feat(hostkey): user-consent forget-hostkey route

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: UI — conditional "Forget host key" action

**Files:**
- Modify: `src/web/api.ts` (`Status` interface ~line 16; new `forgetHostKey` next to `reconnectBox` ~line 84)
- Modify: `src/web/main.ts` (`createBoxRow` actions ~line 590-630; `applyRowStatus` ~line 106)

**Interfaces:**
- Consumes: `POST /api/boxes/:id/forget-hostkey` (Task 5), `Status.hostKeyChanged` (Task 2).
- Produces: no exports — end-user flow only.

- [ ] **Step 1: Extend the Status type and API client**

`src/web/api.ts` — add `hostKeyChanged?: boolean;` to the `Status` interface's first line group:

```ts
export interface Status {
  reachable: boolean; tmux?: boolean; needsAuth?: boolean; inUse?: boolean; paused?: boolean;
  hostKeyChanged?: boolean;
  // …rest unchanged…
```

Next to `reconnectBox` (~line 84):

```ts
  async forgetHostKey(id: string) { return j<{ ok: boolean }>(await fetch(`/api/boxes/${id}/forget-hostkey`, { method: 'POST' })); },
```

- [ ] **Step 2: Add the button to `createBoxRow`**

In `src/web/main.ts`, in `createBoxRow` before `const actions = document.createElement('span');` (~line 626), add (mirroring the ↻ handler's reconnect dance):

```ts
  const forgetKeyBtn = document.createElement('button');
  forgetKeyBtn.className = 'forget-key';
  forgetKeyBtn.title = 'Forget old host key — only if this box was legitimately rebuilt (removes its known_hosts entry, then reconnects)';
  forgetKeyBtn.textContent = '⚷';
  forgetKeyBtn.style.display = 'none';
  forgetKeyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Forget the stored host key for ${b.label}? Only do this if the box was legitimately rebuilt.`)) return;
    await api.forgetHostKey(b.id);
    const wasActive = activeBoxId === b.id;
    closeTab(b.id);
    if (wasActive) openBox(b);
  });
```

and include it in the actions span:

```ts
  actions.append(forgetKeyBtn, refreshBtn, edit, rm);
```

- [ ] **Step 3: Toggle visibility from status**

In `applyRowStatus` (~line 106), after the dot update lines:

```ts
  const forgetEl = li.querySelector('.forget-key') as HTMLElement | null;
  if (forgetEl) forgetEl.style.display = st?.hostKeyChanged ? '' : 'none';
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. (No new unit tests — DOM wiring; repo has no jsdom. The pure signal, `hostKeyChanged`, is covered server-side in Task 2.)

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/main.ts
git commit -m "feat(ui): forget-host-key action on key-changed boxes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Health events — `key-changed` kind

**Files:**
- Modify: `src/server/healthHistory.js` (`sampleOf` ~line 16-24; `classifyTransitions` reachability edges ~line 70-73)
- Modify: `src/web/api.ts` (`Sample` + `HealthEventKind` types, ~line 28-31)
- Modify: `src/web/healthEvents.ts` (`formatEvent` switch, ~line 15)
- Test: `test/healthHistory.test.js`

**Interfaces:**
- Consumes: `Status.hostKeyChanged` (Task 2).
- Produces: sample field `keyChanged?: true`; event kind `'key-changed'`.

- [ ] **Step 1: Write the failing tests**

Add to `test/healthHistory.test.js` (mirror the file's existing `classifyTransitions`/`sampleOf` test style — import names already at top):

```js
test('sampleOf carries keyChanged through', () => {
  const s = sampleOf({ reachable: false, hostKeyChanged: true }, 1000);
  expect(s.up).toBe(false);
  expect(s.keyChanged).toBe(true);
});

test('classifyTransitions emits key-changed on the falling edge and within-down transition', () => {
  const thresholds = { cpu: 90, mem: 90, disk: 90, hysteresis: 5 };
  // up -> down with keyChanged
  let r = classifyTransitions({ t: 0, up: true }, { t: 1, up: false, keyChanged: true }, thresholds, initThresholdState());
  expect(r.events).toEqual([{ kind: 'key-changed' }]);
  // down (plain) -> down (keyChanged)
  r = classifyTransitions({ t: 0, up: false }, { t: 1, up: false, keyChanged: true }, thresholds, initThresholdState());
  expect(r.events).toEqual([{ kind: 'key-changed' }]);
  // keyChanged -> plain down
  r = classifyTransitions({ t: 0, up: false, keyChanged: true }, { t: 1, up: false }, thresholds, initThresholdState());
  expect(r.events).toEqual([{ kind: 'down' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/healthHistory.test.js`
Expected: FAIL — `keyChanged` undefined / wrong events.

- [ ] **Step 3: Implement**

`src/server/healthHistory.js` — in `sampleOf` (~line 22, next to the `needsAuth` line):

```js
  if (s.needsAuth) sample.needsAuth = true;
  if (s.hostKeyChanged) sample.keyChanged = true;
```

In `classifyTransitions`, replace the reachability/auth edge block (~line 70-73) with:

```js
  // reachability / auth / host-key edges. keyChanged wins over needsAuth (they
  // never co-occur: key verification aborts before auth).
  if (prev.up && !next.up) {
    events.push(next.keyChanged ? { kind: 'key-changed' } : next.needsAuth ? { kind: 'needs-auth' } : { kind: 'down' });
  } else if (!prev.up && next.up) {
    events.push({ kind: 'up' });
  } else if (!prev.up && !next.up && !prev.keyChanged && next.keyChanged) {
    events.push({ kind: 'key-changed' });
  } else if (!prev.up && !next.up && !prev.needsAuth && next.needsAuth && !next.keyChanged) {
    events.push({ kind: 'needs-auth' });
  } else if (!prev.up && !next.up && (prev.needsAuth || prev.keyChanged) && !next.needsAuth && !next.keyChanged) {
    events.push({ kind: 'down' });
  }
```

`src/web/api.ts` — extend the two types (~line 28-31):

```ts
export interface Sample { t: number; up: boolean; stopped?: boolean; tmux?: boolean; needsAuth?: boolean; keyChanged?: boolean; cpuPct?: number; memPct?: number; diskPct?: number; }
export type HealthEventKind = 'down' | 'up' | 'needs-auth' | 'key-changed' | 'threshold' | 'threshold-clear';
```

`src/web/healthEvents.ts` — add a case to `formatEvent`'s switch (after `'needs-auth'`, ~line 17):

```ts
    case 'key-changed': return { icon: '🔑', text: `${name} — host key changed (rebuilt? use ⚷ to forget)`, level: 'crit' };
```

- [ ] **Step 4: Verify**

Run: `npx vitest run test/healthHistory.test.js && npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/healthHistory.js src/web/api.ts src/web/healthEvents.ts test/healthHistory.test.js
git commit -m "feat(health): key-changed event kind for changed host keys

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Docs true-up + full verification

**Files:**
- Modify: `CLAUDE.md` + `AGENTS.md` (Architecture module list + Security notes)
- Modify: `README.md` (troubleshooting/security-adjacent prose near the status/provisioning docs)

- [ ] **Step 1: CLAUDE.md / AGENTS.md**

Add a module bullet after the `boxRemoval.js` bullet (identical wording in both files):

```markdown
- `knownHosts.js` — `createKnownHosts`: best-effort `ssh-keygen -R` wrapper (argv, no shell).
  A known_hosts entry is removed only on verified deprovision, on provisioning a fresh
  container's IP, or via the explicit `POST /api/boxes/:id/forget-hostkey` user action —
  never automatically on a connection failure (`status.js` classifies changed keys as
  `hostKeyChanged` so the UI can offer the ⚷ button).
```

- [ ] **Step 2: README**

Ground the wording in the shipped behavior and add a short passage where box status/reconnection is described (locate with `grep -n "known_hosts\|host key\|Reconnect" README.md`): a box whose dot reports a changed host key shows a ⚷ action; NetBox-recycled IPs are cleared automatically at deprovision/provision time. Placeholders only, no real hosts.

- [ ] **Step 3: Full verification**

Run: `npm test && npm run build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: document graceful stale host key handling

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
