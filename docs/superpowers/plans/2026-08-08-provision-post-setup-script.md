# Post-setup saved script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator pick a saved Fleet Command script when provisioning a Proxmox container (or setting up any box) and have it run on the box after everything else Tmuxifier installs.

**Architecture:** One new phase in `setupManager.completeDone`, between `agent-hooks` and `ensureSession`, fed by an injected `getScript` closure over `fleetScriptsStore`. The script body streams over the same `sshStream` + `buildSetupArgv` transport the main install script already uses, so its output lands live in the job's rolling log. The result is recorded on `job.postScript` and never promoted to a job failure. `proxmoxProvision.js` is untouched — it already carries `setupOptions` through opaquely.

**Tech Stack:** Node 20+ ESM (server, plain `.js`), TypeScript + Vite (web client), Vitest (node environment, no DOM), Fastify, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-08-08-provision-post-setup-script-design.md`

## Global Constraints

- ESM everywhere (`"type": "module"`); Node 20+.
- Server is plain `.js`; web client is `.ts`.
- TDD: write the failing test first. Tests use **real code, not mocks** — enabled by the dependency-injection factories.
- Vitest runs in `environment: 'node'` — **there is no DOM**. New UI is covered through pure exported seams (`values()`, `setupStartPayload`), never by rendering.
- Modules are factory functions with dependencies injected as arguments. New dependencies default to `null` so an unwired construction skips the feature rather than throwing.
- `scriptId` is only ever a **lookup key** against `fleetScriptsStore`. Nothing user-typed may reach a shell through it.
- The script phase must **never** promote a failure to a job failure — the job still reaches `done`. Same rule as `seed` / `statusline` / `agentHooks`.
- The script must run **before** `ensureSession`. A shell reads its rc files once at startup.
- Conventional-commit style messages (`fix(pty): …`, `feat(ui): …`).
- Repo is public: no real domains, IPs, hostnames, or emails in code, tests, or docs. Use `example.com`, RFC1918 (`192.168.1.10`), `you@example.com`.
- Run `npm test` (typecheck + vitest) before each commit.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/server/fleetScriptsStore.js` | Modify | Add `getScript(id)` — the single-record read the store lacks |
| `src/server/setupManager.js` | Modify | `streamRemote` extraction; `getScript` dep; `script` phase; options + summary fields |
| `src/server/server.js` | Modify | Forward `scriptId`/`scriptName` on `POST /api/boxes/:id/setup`; `NO_FLEET_SCRIPTS.getScript` |
| `src/server/index.js` | Modify | Late-bound `getScript` closure into `createSetupManager` |
| `src/web/api.ts` | Modify | `PushResult` supertype; `postScript`; `script` phase; `SetupOptions` fields |
| `src/web/setupStatus.ts` | Modify | `script` phase text; widen `formatStatuslineResult` to `PushResult` |
| `src/web/setupOptions.ts` | Modify | The "Post-setup script" picker section |
| `src/web/main.ts` | Modify | Render `postScript` in the provision panel's done line |
| `src/web/proxmoxUi.ts` | Modify | Render `postScript` in the hub's job panel |
| `test/fleetScriptsStore.test.js` | Modify | `getScript` coverage |
| `test/setupManager.test.js` | Modify | The phase: ordering, skips, failures, log, cancel |
| `test/setupRoutes.test.js` | Modify | Route forwards the selection |
| `test/setupStatus.test.js` | Modify | Phase text + result formatting |
| `test/setupOptions.test.js` | Modify | Payload carries the selection |
| `docs/boxes-and-setup.md`, `docs/proxmox.md`, `docs/fleet-and-health.md`, `README.md`, `CLAUDE.md`, `AGENTS.md` | Modify | Living documentation |

---

### Task 1: `getScript` on the fleet scripts store

**Files:**
- Modify: `src/server/fleetScriptsStore.js:78-80` (immediately after `listScripts`)
- Test: `test/fleetScriptsStore.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getScript(id: string): Promise<FleetScriptRecord | null>` where a record is `{ id, name, script, createdAt, updatedAt, description? }`. Task 3 injects it into `setupManager`; Task 4 wires it in `index.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/fleetScriptsStore.test.js`:

```js
// The setup manager resolves a saved script by id at run time (it stores only
// the id plus a frozen display name), so a single-record read is the one thing
// this store lacked. A bad id must read as "not found", never throw — the
// caller records it as a skip.
test('getScript returns the record by id, and null for anything else', async () => {
  const rec = await store.addScript(spec);
  expect(await store.getScript(rec.id)).toEqual(rec);
  expect(await store.getScript('fs-nope')).toBeNull();
  expect(await store.getScript('')).toBeNull();
  expect(await store.getScript(undefined)).toBeNull();
  expect(await store.getScript(null)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fleetScriptsStore.test.js -t 'getScript'`
Expected: FAIL with `store.getScript is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/server/fleetScriptsStore.js`, insert directly after the `listScripts` method in the returned object:

```js
    // Single-record read for the setup manager's post-setup script phase, which
    // resolves by id at run time rather than snapshotting the body. Not
    // serialized: reads stay free here, the same rule listScripts follows. A
    // missing or malformed id is `null`, never a throw — the caller turns that
    // into a recorded skip, not a failure.
    async getScript(id) {
      if (typeof id !== 'string' || !id) return null;
      return (await readAll()).find((s) => s.id === id) || null;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/fleetScriptsStore.test.js`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Full suite + commit**

```bash
npm test
git add src/server/fleetScriptsStore.js test/fleetScriptsStore.test.js
git commit -m "feat(fleet-scripts): add getScript, the single-record read by id"
```

---

### Task 2: Extract `streamRemote` from `run()` (pure refactor)

This task changes **no behaviour**. The existing `setupManager.test.js` suite is the gate: it must stay green without edits. The extraction exists so Task 3's script phase reuses the identical spawn / log-append / coalesced-persist / handle-register / exit-code sequence rather than growing a second, drifting copy of it.

**Files:**
- Modify: `src/server/setupManager.js:181-247` (the body of `run`)
- Test: `test/setupManager.test.js` (unchanged — regression gate only)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `async function streamRemote(j, box, script, { onStderr = null, timeoutMs = taskTimeoutMs } = {}): Promise<number>` — returns the ssh exit code. Registers its handle in `runningHandles` under `j.id` for the duration, so `cancelForBox` can kill it. Task 3 calls it.

- [ ] **Step 1: Run the existing suite to record the green baseline**

Run: `npx vitest run test/setupManager.test.js`
Expected: PASS. Note the test count — it must be identical after the refactor.

- [ ] **Step 2: Add the `streamRemote` helper**

In `src/server/setupManager.js`, insert this function immediately **before** `async function run(j, box, { waitForSsh })`:

```js
  // Spawn one remote script over the setup transport and stream it into the
  // job log. Shared by the setup run and the post-setup saved-script phase:
  // both need the same spawn / append / coalesced-persist / handle-register /
  // exit-code sequence, and only the setup run cares about stderr (it sniffs
  // for password prompts). Registering the handle under the job id is what
  // makes cancelForBox able to kill whichever of the two is in flight.
  async function streamRemote(j, box, script, { onStderr = null, timeoutMs = taskTimeoutMs } = {}) {
    const argv = buildSetupArgv(box, script, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
    // Coalesced log persistence: a chatty install emits thousands of chunks,
    // and a full-history save per chunk is a multi-MB stringify each time.
    // Status/phase transitions still persist immediately; finish() flushes
    // the tail.
    let lastLogPersist = nowMs();
    let pendingLogBytes = 0;
    const handle = sshStream(argv, {
      timeout: timeoutMs,
      onData: (chunk, stream) => {
        appendLog(j, chunk);
        if (stream === 'stderr' && onStderr) onStderr(chunk);
        pendingLogBytes += chunk.length;
        const t = nowMs();
        if (t - lastLogPersist >= logPersistMs || pendingLogBytes >= logPersistBytes) {
          lastLogPersist = t;
          pendingLogBytes = 0;
          persist();
        }
      },
    });
    runningHandles.set(j.id, handle);
    try {
      const { code } = await handle.done;
      return code;
    } finally {
      runningHandles.delete(j.id);
    }
  }
```

- [ ] **Step 3: Rewrite `run()` to call it**

Replace everything in `run()` from `j.phase = 'running'; persist();` down to and including `runningHandles.delete(j.id);` (currently `setupManager.js:196-231`) with:

```js
      j.phase = 'running'; persist();

      const script = buildScript(box, j.options);
      let sawSudoPw = false;
      let sawSshPw = false;
      let stderrTail = '';
      const code = await streamRemote(j, box, script, {
        onStderr: (chunk) => {
          // Bounded stderr-only accumulator so a phrase split across chunks is
          // still detected, without matching sudo text that appeared on stdout.
          stderrTail = (stderrTail + chunk).slice(-4096);
          if (!sawSudoPw && SUDO_PW_RE.test(stderrTail)) sawSudoPw = true;
          if (!sawSshPw && SSH_PW_RE.test(stderrTail)) sawSshPw = true;
        },
      });
```

Then in the `catch (e)` block at the end of `run()`, delete the now-redundant line `runningHandles.delete(j.id);` — `streamRemote`'s `finally` covers it.

Leave the `if (code === 0) await completeDone(j, box);` block and everything below it exactly as it is.

- [ ] **Step 4: Run the suite to verify nothing changed**

Run: `npx vitest run test/setupManager.test.js`
Expected: PASS, the same test count as Step 1. If the sudo/ssh `needs-interactive` tests fail, `onStderr` is not being called — check that the `stream === 'stderr'` guard is inside `onData`.

- [ ] **Step 5: Full suite + commit**

```bash
npm test
git add src/server/setupManager.js
git commit -m "refactor(setup): extract streamRemote from run()"
```

---

### Task 3: The `script` phase in the setup manager

**Files:**
- Modify: `src/server/setupManager.js` — factory signature (~line 58), `normalizeOptions` (~108), `summary` (~105), `completeDone` (~165, after the `pushAgentHooks` block)
- Test: `test/setupManager.test.js`

**Interfaces:**
- Consumes: `getScript(id)` from Task 1; `streamRemote(j, box, script, opts)` from Task 2.
- Produces:
  - Factory option `getScript = null`.
  - Normalized options gain `scriptId: string | null` and `scriptName: string | null`.
  - `job.postScript` and `summary().postScript`, shaped `{ target: string, ok: boolean, skipped?: string, error?: string }`.
  - Phase string `'script'`.
  Task 4 wires `getScript`; Task 5 types `postScript` and the phase on the client.

- [ ] **Step 1: Write the failing tests**

Append to the **end** of `test/setupManager.test.js` (after every existing test, so the module-level `SUDO` const is already in scope):

```js
// --- post-setup saved script -------------------------------------------------

const SCRIPT_REC = { id: 'fs-1', name: 'bootstrap', script: 'echo hi\n', createdAt: 'now', updatedAt: 'now' };

// The whole point of the phase's position: a script that edits .zshrc/.bashrc/
// .tmux.conf must land before the box's tmux session is created, because a
// shell reads its rc files once, at startup.
test('a selected saved script runs after agent-hooks and strictly before ensureSession', async () => {
  const order = [];
  const m = make({
    pushStatusline: async () => { order.push('statusline'); return { target: 'statusline', ok: true }; },
    pushAgentHooks: async () => { order.push('agent-hooks'); return { target: 'agent-hooks', ok: true }; },
    getScript: async (id) => { order.push(`script:${id}`); return SCRIPT_REC; },
    ensureSession: async () => { order.push('session'); },
  });
  const s = m.start(BOX, { tools: ['claude'], scriptId: 'fs-1', scriptName: 'bootstrap' });
  await m._settled(s.id);
  expect(order).toEqual(['statusline', 'agent-hooks', 'script:fs-1', 'session']);
  expect(m.getJob(s.id).postScript).toEqual({ target: 'bootstrap', ok: true });
  expect(m.listJobs()[0].postScript).toEqual({ target: 'bootstrap', ok: true });
});

test('no scriptId: getScript is never called and the summary reports null', async () => {
  let calls = 0;
  const m = make({ getScript: async () => { calls += 1; return SCRIPT_REC; } });
  const s = m.start(BOX, { tools: [] });
  await m._settled(s.id);
  expect(calls).toBe(0);
  expect(m.getJob(s.id).postScript).toBeUndefined();
  expect(m.listJobs()[0].postScript).toBeNull();
});

// An unwired manager skips the phase, which is what every construction above
// this line does — the default is what keeps them all passing untouched.
test('getScript unwired: a scriptId is skipped rather than failing', async () => {
  const m = make();
  const s = m.start(BOX, { tools: [], scriptId: 'fs-1' });
  await m._settled(s.id);
  expect(m.getJob(s.id).status).toBe('done');
  expect(m.getJob(s.id).postScript).toBeUndefined();
});

test('a script deleted between selection and run records a skip and opens no ssh for it', async () => {
  const ssh = fakeSsh({ chunks: [['stdout', 'ok\n']], code: 0 });
  const m = make({ sshStream: ssh, getScript: async () => null });
  const s = m.start(BOX, { tools: [], scriptId: 'fs-gone', scriptName: 'bootstrap' });
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(job.postScript).toEqual({ target: 'bootstrap', ok: false, skipped: 'saved script no longer exists' });
  expect(ssh.calls.length).toBe(1); // the setup run only
});

// Setup itself succeeded — tmux and the tools installed and the box is usable.
// Marking it broken over the operator's own script would be wrong, and Retry
// would re-run the ENTIRE setup just to retry one script.
test('a non-zero script exit is recorded, the job still reaches done, and the session is still created', async () => {
  const order = [];
  let call = 0;
  const ssh = (argv, { onData } = {}) => {
    call += 1;
    const code = call === 1 ? 0 : 2; // setup ok, saved script fails
    onData?.(call === 1 ? 'installing\n' : 'boom\n', 'stdout');
    return { done: Promise.resolve({ code }), kill() {} };
  };
  const m = make({ sshStream: ssh, getScript: async () => SCRIPT_REC, ensureSession: async () => { order.push('session'); } });
  const s = m.start(BOX, { tools: [], scriptId: 'fs-1' });
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(job.error).toBe(null);
  expect(job.postScript).toEqual({ target: 'bootstrap', ok: false, error: 'exited 2' });
  expect(job.log).toContain('boom'); // output lands in the shared job log
  expect(order).toEqual(['session']);
});

test('a script that times out says so rather than reporting a bare exit code', async () => {
  let call = 0;
  const ssh = () => { call += 1; return { done: Promise.resolve({ code: call === 1 ? 0 : 124 }), kill() {} }; };
  const m = make({ sshStream: ssh, getScript: async () => SCRIPT_REC });
  const s = m.start(BOX, { tools: [], scriptId: 'fs-1' });
  await m._settled(s.id);
  expect(m.getJob(s.id).postScript).toEqual({ target: 'bootstrap', ok: false, error: 'script timed out' });
});

test('a getScript that throws is recorded, never promoted', async () => {
  const m = make({ getScript: async () => { throw new Error('disk'); } });
  const s = m.start(BOX, { tools: [], scriptId: 'fs-1', scriptName: 'bootstrap' });
  await m._settled(s.id);
  const job = m.getJob(s.id);
  expect(job.status).toBe('done');
  expect(job.postScript).toEqual({ target: 'bootstrap', ok: false, error: 'saved script could not be read' });
});

// The resolved record's own name wins over the frozen label: the label exists
// for the window before resolution (and for a script that has since vanished).
test('the result is labelled with the resolved name, not the frozen one', async () => {
  const m = make({ getScript: async () => ({ ...SCRIPT_REC, name: 'renamed' }) });
  const s = m.start(BOX, { tools: [], scriptId: 'fs-1', scriptName: 'bootstrap' });
  await m._settled(s.id);
  expect(m.getJob(s.id).postScript).toEqual({ target: 'renamed', ok: true });
});

test('the interactive finish also runs the saved script, before the session', async () => {
  const order = [];
  const m = make({
    sshStream: sudoSsh(SUDO, 1),
    getBox: async () => BOX,
    getScript: async () => { order.push('script'); return SCRIPT_REC; },
    ensureSession: async () => { order.push('session'); },
  });
  const s = m.start(BOX, { tools: [], scriptId: 'fs-1' });
  await m._settled(s.id);
  m.markInteractiveResult(BOX.id, 0);
  await m._settled(s.id);
  expect(order).toEqual(['script', 'session']);
});

test('cancelling during the script phase kills its ssh handle', async () => {
  let killed = false;
  let call = 0;
  const ssh = () => {
    call += 1;
    if (call === 1) return { done: Promise.resolve({ code: 0 }), kill() {} };
    return { done: new Promise(() => {}), kill: () => { killed = true; } };
  };
  const m = make({ sshStream: ssh, getScript: async () => SCRIPT_REC });
  const s = m.start(BOX, { tools: [], scriptId: 'fs-1' });
  await waitFor(() => m.getJob(s.id).phase === 'script');
  m.cancelForBox(BOX.id);
  expect(killed).toBe(true);
});

// The id is what selects; the name only labels. A name with no id would be a
// label for nothing, and is dropped rather than persisted as a half-selection.
test('options normalize the selection: id trimmed, blank or orphan name dropped', async () => {
  const m = make({ getScript: async () => SCRIPT_REC });
  const a = m.start(BOX, { tools: [], scriptId: '  fs-1  ', scriptName: '   ' });
  expect(a.options.scriptId).toBe('fs-1');
  expect(a.options.scriptName).toBe(null);
  await m._settled(a.id);

  const m2 = make();
  const b = m2.start(BOX, { tools: [], scriptName: 'bootstrap' });
  expect(b.options.scriptId).toBe(null);
  expect(b.options.scriptName).toBe(null);
  await m2._settled(b.id);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/setupManager.test.js -t 'script'`
Expected: FAIL — the ordering test reports `['statusline', 'agent-hooks', 'session']` (no `script:fs-1`), and `postScript` is `undefined`.

- [ ] **Step 3: Add the `getScript` dependency**

In the `createSetupManager({...})` parameter list, immediately after the `pushAgentHooks = null,` entry (~`setupManager.js:58`):

```js
  // Post-setup saved Fleet Command script (fleetScriptsStore.getScript). Default
  // null: an unwired manager skips the phase entirely, which is what every
  // existing test constructs — same pattern as seed/pushStatusline/pushAgentHooks.
  getScript = null,
```

- [ ] **Step 4: Normalize the two new options**

Replace `normalizeOptions` (~`setupManager.js:108-115`) with:

```js
  function normalizeOptions(o = {}) {
    // A saved Fleet Command script to run as the last step of setup. `scriptId`
    // is only ever a LOOKUP KEY against fleetScriptsStore — nothing user-typed
    // reaches a shell through it, the same chokepoint discipline
    // iconCatalog.js/voiceCatalog.js apply to their allowlists. The 128-char cap
    // is defensive only (an id is `fs-<uuid>`, 39 chars).
    const scriptId = typeof o.scriptId === 'string' && o.scriptId.trim()
      ? o.scriptId.trim().slice(0, 128)
      : null;
    // A frozen display label, fleet.js's own rule: dropped when blank or
    // oversized, and NEVER resolved back against the store, so renaming or
    // deleting a script cannot rewrite what a past job says it ran. An orphan
    // name (no id) is a label for nothing, so it goes too.
    const rawName = typeof o.scriptName === 'string' ? o.scriptName.trim() : '';
    return {
      ohMyTmux: !!o.ohMyTmux, ohMyZsh: !!o.ohMyZsh, ohMyBash: !!o.ohMyBash,
      tools: Array.isArray(o.tools) ? o.tools : [],
      seedAiAuth: !!o.seedAiAuth,
      claudeStatusline: !!o.claudeStatusline,
      scriptId,
      scriptName: scriptId && rawName && rawName.length <= 80 ? rawName : null,
    };
  }
```

- [ ] **Step 5: Add `postScript` to the summary**

In `summary(j)` (~`setupManager.js:105`), add `postScript: j.postScript ?? null,` immediately after the `agentHooks:` entry.

- [ ] **Step 6: Add the runner**

Insert this function immediately **before** `async function completeDone(j, box)`:

```js
  // The post-setup saved-script phase. Never throws and never fails the job:
  // setup itself succeeded, the box is usable, and marking it broken over the
  // operator's own script would be wrong (the rule seed/statusline/agent-hooks
  // already follow). The script's OUTPUT goes into the shared job log via
  // streamRemote — there is deliberately no second copy of it on the result.
  async function runSavedScript(j, box) {
    const label = j.options.scriptName || 'script';
    let rec;
    try { rec = await getScript(j.options.scriptId); }
    catch { return { target: label, ok: false, error: 'saved script could not be read' }; }
    // Resolved by id at run time rather than snapshotted, so a script deleted
    // in the minutes between clicking Provision and this phase is a skip.
    if (!rec || !rec.script) return { target: label, ok: false, skipped: 'saved script no longer exists' };
    const target = rec.name || label;
    let code;
    try { code = await streamRemote(j, box, rec.script); }
    catch (e) { return { target, ok: false, error: e?.message || 'script failed' }; }
    if (code === 0) return { target, ok: true };
    // 124 is the transport's timeout code, the same reading run() gives it.
    if (code === 124) return { target, ok: false, error: 'script timed out' };
    return { target, ok: false, error: `exited ${code}` };
  }
```

- [ ] **Step 7: Add the phase to `completeDone`**

In `completeDone`, insert this between the `pushAgentHooks` block and the `ensureSession` block:

```js
    // The operator's own bootstrap: last of the installs, and strictly BEFORE
    // ensureSession. A shell reads its rc files once at startup, so a script
    // that edits .zshrc/.bashrc/.tmux.conf has to land before the box's tmux
    // session is created — the same ordering rule the seed already imposes.
    // Recorded, never promoted; see runSavedScript.
    if (getScript && j.options.scriptId && box && !j.cancelled) {
      j.phase = 'script';
      persist();
      try { j.postScript = await runSavedScript(j, box); }
      catch { j.postScript = { target: j.options.scriptName || 'script', ok: false, error: 'script failed' }; }
    }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/setupManager.test.js`
Expected: PASS, including every pre-existing test.

- [ ] **Step 9: Full suite + commit**

```bash
npm test
git add src/server/setupManager.js test/setupManager.test.js
git commit -m "feat(setup): run a selected saved script after the installs, before the session"
```

---

### Task 4: Route forwarding and server wiring

**Files:**
- Modify: `src/server/server.js:110-115` (`NO_FLEET_SCRIPTS`) and `src/server/server.js:1142-1150` (`POST /api/boxes/:id/setup`)
- Modify: `src/server/index.js:131` (the `createSetupManager({...})` call)
- Test: `test/setupRoutes.test.js`

**Interfaces:**
- Consumes: `getScript` from Task 1; the normalized `scriptId`/`scriptName` options from Task 3.
- Produces: `POST /api/boxes/:id/setup` accepting `scriptId` and `scriptName` in its body; a live `getScript` on the real server's setup manager. Task 6's form posts these fields.

- [ ] **Step 1: Write the failing test**

Append to `test/setupRoutes.test.js`:

```js
// The route builds its options object by hand, field by field — the same shape
// of omission that once let the Add/Edit Box modal's statusline checkbox run a
// job that never pushed anything (see the setupStartPayload comment). This test
// is the guard for the two newest fields on that list.
test('a selected saved script rides the setup body through to the manager', async () => {
  const h = await headers();
  const res = await app.inject({
    method: 'POST', url: `/api/boxes/${BOX.id}/setup`, headers: h,
    payload: { tools: [], scriptId: 'fs-1', scriptName: 'bootstrap' },
  });
  expect(res.statusCode).toBe(201);
  expect(sm._started[0].options.scriptId).toBe('fs-1');
  expect(sm._started[0].options.scriptName).toBe('bootstrap');
});

test('a setup body with no script selection forwards undefined, not a stray value', async () => {
  const h = await headers();
  const res = await app.inject({
    method: 'POST', url: `/api/boxes/${BOX.id}/setup`, headers: h,
    payload: { tools: [] },
  });
  expect(res.statusCode).toBe(201);
  expect(sm._started[0].options.scriptId).toBeUndefined();
  expect(sm._started[0].options.scriptName).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/setupRoutes.test.js -t 'saved script'`
Expected: FAIL — `options.scriptId` is `undefined` because the route drops it.

- [ ] **Step 3: Forward the fields in the route**

In `src/server/server.js`, replace the `const options = ...` line inside `POST /api/boxes/:id/setup` with:

```js
    // Hand-written field list: anything not named here is silently dropped, and
    // that is exactly how the statusline checkbox once ran jobs that pushed
    // nothing. scriptId/scriptName are passed through raw — setupManager's
    // normalizeOptions is the validation authority for both, and scriptId is
    // only ever a lookup key against the saved-scripts store.
    const options = {
      ohMyTmux: !!b.ohMyTmux, ohMyZsh: !!b.ohMyZsh, ohMyBash: !!b.ohMyBash, tools,
      seedAiAuth: !!b.seedAiAuth, claudeStatusline: !!b.claudeStatusline,
      scriptId: b.scriptId, scriptName: b.scriptName,
    };
```

- [ ] **Step 4: Extend the `NO_FLEET_SCRIPTS` stub**

In `src/server/server.js`, add to the `NO_FLEET_SCRIPTS` object, after `listScripts`:

```js
  getScript: async () => null,
```

- [ ] **Step 5: Wire the late-bound closure in `index.js`**

In `src/server/index.js`, inside the `createSetupManager({ ... })` call (~line 131), add:

```js
  // Late-bound on purpose: fleetScriptsStore is constructed further down this
  // file, so this cannot be a direct reference. The arrow body only runs when a
  // job reaches the script phase, long after both exist — the same trick the
  // provisionManager's startSetup thunk already uses below.
  getScript: (id) => fleetScriptsStore.getScript(id),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/setupRoutes.test.js`
Expected: PASS.

- [ ] **Step 7: Verify the real server boots with the wiring**

Run: `node -e "import('./src/server/index.js').then(() => { console.log('booted'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); })"`
Expected: prints `booted`. A `ReferenceError: Cannot access 'fleetScriptsStore' before initialization` here means the closure was written as a direct reference instead of an arrow.

- [ ] **Step 8: Full suite + commit**

```bash
npm test
git add src/server/server.js src/server/index.js test/setupRoutes.test.js
git commit -m "feat(setup): forward the saved-script selection and wire getScript"
```

---

### Task 5: Client types, phase text, and the panel result lines

**Files:**
- Modify: `src/web/api.ts:193-214`
- Modify: `src/web/setupStatus.ts:5-11` and `:80-84`
- Modify: `src/web/main.ts:1987-1994`
- Modify: `src/web/proxmoxUi.ts:12` and `:198-199`
- Test: `test/setupStatus.test.js`

**Interfaces:**
- Consumes: `job.postScript` and the `'script'` phase from Task 3.
- Produces:
  - `export interface PushResult { target: string; ok: boolean; skipped?: string; error?: string }` in `api.ts`.
  - `SeedResult extends PushResult` with its narrowed `target`.
  - `SetupSummary.postScript?: PushResult | null`, `SetupOptions.scriptId?: string | null`, `SetupOptions.scriptName?: string | null`.
  - `formatStatuslineResult(r: PushResult | null | undefined): string`.
  Task 6 sets `scriptId`/`scriptName` on `SetupOptionsValues`, which flows into `SetupOptions`.

- [ ] **Step 1: Write the failing tests**

Append to `test/setupStatus.test.js`:

```js
test('the saved-script phase names itself', () => {
  expect(setupStatusText({ status: 'running', phase: 'script' })).toMatch(/saved script/i);
});

// formatStatuslineResult is documented as target-generic; the saved-script phase
// is the first caller whose target is a free-form name rather than a fixed one.
test('formatStatuslineResult renders a saved-script result under the script own name', () => {
  expect(formatStatuslineResult({ target: 'bootstrap', ok: true })).toBe('bootstrap ✓');
  expect(formatStatuslineResult({ target: 'bootstrap', ok: false, error: 'exited 2' })).toBe('bootstrap failed (exited 2)');
  expect(formatStatuslineResult({ target: 'bootstrap', ok: false, skipped: 'saved script no longer exists' }))
    .toBe('bootstrap skipped (saved script no longer exists)');
  expect(formatStatuslineResult(null)).toBe('');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/setupStatus.test.js -t 'saved-script'`
Expected: FAIL — `setupStatusText({status:'running', phase:'script'})` returns `'Running setup…'`, which does not match `/saved script/i`.

- [ ] **Step 3: Update the types in `api.ts`**

Replace the `SeedResult` interface (`api.ts:214`) with:

```ts
// The shape every post-setup step's result shares. `target` is free-form here
// because the saved-script phase reports the SCRIPT'S OWN NAME; SeedResult
// narrows it to the fixed set the seed/statusline/hooks steps use, so those
// keep their exhaustiveness while the script phase stays expressible.
export interface PushResult { target: string; ok: boolean; skipped?: string; error?: string }
export interface SeedResult extends PushResult { target: 'claude' | 'codex' | 'all' | 'statusline' | 'agent-hooks' }
```

In `SetupOptions` (`api.ts:193`), add the two fields:

```ts
export interface SetupOptions { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; seedAiAuth?: boolean; claudeStatusline?: boolean; scriptId?: string | null; scriptName?: string | null }
```

In `SetupSummary` (`api.ts:196`), extend the phase union and add the field after `agentHooks`:

```ts
  phase: 'waiting-ssh' | 'running' | 'seeding' | 'statusline' | 'agent-hooks' | 'script' | null; options: SetupOptions; error: string | null;
```

```ts
  // Present once a job that selected a saved Fleet Command script has attempted
  // it. Absent (or null) on jobs that predate the phase or never selected one.
  postScript?: PushResult | null;
```

- [ ] **Step 4: Update `setupStatus.ts`**

Change the import line to add `PushResult`:

```ts
import type { PushResult, SeedResult, SetupJob, SetupStatus } from './api';
```

In `setupStatusText`, add the new phase before the fallback:

```ts
        : job.phase === 'agent-hooks' ? 'Installing agent hooks…'
        : job.phase === 'script' ? 'Running saved script…'
        : 'Running setup…';
```

Widen `formatStatuslineResult`'s parameter and update its comment:

```ts
// One-line summary of a single post-setup step's outcome — statusline,
// agent-hooks, or the saved script, the shape is target-generic — e.g.
// "statusline ✓" / "agent-hooks skipped (no Claude on the box)" /
// "bootstrap failed (exited 2)". Empty string when the step never ran, so
// callers test it for truthiness and old jobs without the field render nothing.
export function formatStatuslineResult(statusline: PushResult | null | undefined): string {
```

- [ ] **Step 5: Render it in the provision panel**

In `src/web/main.ts`, replace the `agentHooks` line and the auto-close line (`main.ts:1991-1994`) with:

```ts
        const ahTxt = formatStatuslineResult(job.agentHooks);
        if (ahTxt) status.textContent = `${status.textContent} · ${ahTxt}`;
        const psTxt = formatStatuslineResult(job.postScript);
        if (psTxt) status.textContent = `${status.textContent} · ${psTxt}`;
        // An outcome deserves longer on screen than a bare success.
        autoCloseTimer = window.setTimeout(() => closeProvisionPanel(), (seedTxt || slTxt || ahTxt || psTxt) ? 5000 : 2000);
```

- [ ] **Step 6: Render it in the Proxmox hub's job panel**

In `src/web/proxmoxUi.ts`, change the import on line 12 to:

```ts
import { setupStatusText, formatSeedResults, formatStatuslineResult } from './setupStatus';
```

and add after the `seedTxt` lines (`proxmoxUi.ts:198-199`):

```ts
          const psTxt = formatStatuslineResult(job.postScript);
          if (psTxt) phase.textContent = `${phase.textContent} · ${psTxt}`;
```

- [ ] **Step 7: Run typecheck and tests**

Run: `npm run typecheck && npx vitest run test/setupStatus.test.js`
Expected: typecheck clean, tests PASS. A `Type 'string' is not assignable to type '"claude" | ...'` error means a `SeedResult` annotation somewhere still needs to be `PushResult`.

- [ ] **Step 8: Full suite + commit**

```bash
npm test
git add src/web/api.ts src/web/setupStatus.ts src/web/main.ts src/web/proxmoxUi.ts test/setupStatus.test.js
git commit -m "feat(ui): surface the post-setup script result in the setup panels"
```

---

### Task 6: The picker in the shared setup options form

**Files:**
- Modify: `src/web/setupOptions.ts`
- Test: `test/setupOptions.test.js`

**Interfaces:**
- Consumes: `fleetScripts.list()` and `sortScripts` from `src/web/fleetScripts.ts`; `field` from `src/web/dom.ts`; the `SetupOptions` fields from Task 5.
- Produces:
  - `export function scriptSelection(list: FleetScript[], selectedId: string): { scriptId: string | null; scriptName: string | null }` — the picker's one piece of logic, pure and exported so it is testable in a DOM-free suite.
  - `SetupOptionsValues` gains `scriptId: string | null` and `scriptName: string | null`. Both flow to the server unchanged — `setupStartPayload` spreads, so `main.ts`'s `openProvisionPanel` and `proxmoxUi.ts`'s `renderProvision` need no call-site change.

> **Why a pure `scriptSelection` rather than testing `values()`:** vitest is node-env with no DOM, so `values()` cannot be exercised, and `tsc` covers only `src/web` — a test asserting on `setupStartPayload` with the new fields would pass before the feature exists and prove nothing. `scriptSelection` is the repo's usual answer to this (`seedStatusParts`, `voiceStatusLine`): push the logic into a pure export and leave the DOM layer thin enough not to need coverage.

- [ ] **Step 1: Write the failing test**

Add `scriptSelection` to the import at the top of `test/setupOptions.test.js`:

```js
import { seedStatusParts, setupStartPayload, scriptSelection } from '../src/web/setupOptions.ts';
```

and append:

```js
const SCRIPTS = [
  { id: 'fs-1', name: 'bootstrap', script: 'echo hi\n', createdAt: 'a', updatedAt: 'a' },
  { id: 'fs-2', name: 'harden', script: 'echo ho\n', createdAt: 'a', updatedAt: 'a' },
];

test('scriptSelection maps the picked id onto the two payload fields', () => {
  expect(scriptSelection(SCRIPTS, '')).toEqual({ scriptId: null, scriptName: null });
  expect(scriptSelection(SCRIPTS, 'fs-2')).toEqual({ scriptId: 'fs-2', scriptName: 'harden' });
});

// A stale id — the script was deleted elsewhere while this form sat open —
// still selects, because the server resolves by id and records a skip. What it
// must not do is invent a label for a record it cannot see.
test('scriptSelection contributes no label for an id it cannot resolve', () => {
  expect(scriptSelection(SCRIPTS, 'fs-gone')).toEqual({ scriptId: 'fs-gone', scriptName: null });
  expect(scriptSelection([], 'fs-1')).toEqual({ scriptId: 'fs-1', scriptName: null });
});

// setupStartPayload spreads rather than naming fields, precisely so a new
// option reaches the server without a second edit at the call site. This is
// that guarantee, exercised by the first option added since it was written.
test('setupStartPayload carries the saved-script selection through untouched', () => {
  const v = {
    ohMyTmux: true, ohMyZsh: false, ohMyBash: false, tools: ['claude'],
    seedAiAuth: false, scriptId: 'fs-1', scriptName: 'bootstrap',
  };
  expect(setupStartPayload(v)).toEqual(v);
  expect(setupStartPayload(v).tools).not.toBe(v.tools);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/setupOptions.test.js -t 'scriptSelection'`
Expected: FAIL with `scriptSelection is not a function`.

- [ ] **Step 3: Extend the value type and imports**

In `src/web/setupOptions.ts`, change the imports:

```ts
import { el, field, makeRadio } from './dom';
import { toolsCheckboxGroup } from './provisionTools';
import { fleetScripts, sortScripts, type FleetScript } from './fleetScripts';
import { api, type AiAuthStatus, type AiAuthCliStatus } from './api';
```

and the interface:

```ts
export interface SetupOptionsValues {
  ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean; tools: string[]; seedAiAuth: boolean;
  // The saved Fleet Command script to run last. `scriptId` is what selects;
  // `scriptName` rides along only as a display label the server freezes onto
  // the job, so a later rename cannot rewrite what that job says it ran.
  scriptId: string | null; scriptName: string | null;
}
```

- [ ] **Step 4: Add the pure `scriptSelection` helper**

In `src/web/setupOptions.ts`, add above `createSetupOptionsForm` (beside `seedStatusParts`, the file's other pure export):

```ts
/**
 * The two fields a script selection contributes to the setup payload. Pure, so
 * the picker's one piece of logic is testable in a DOM-free suite.
 *
 * `scriptId` is what selects — the server resolves it against
 * data/fleet-scripts.json — and `scriptName` rides along only as a display
 * label the server freezes onto the job. An id with no matching record still
 * selects (the server records a skip for it) but contributes no label: an
 * invented one would be a label for a script nobody can see.
 */
export function scriptSelection(list: FleetScript[], selectedId: string): { scriptId: string | null; scriptName: string | null } {
  if (!selectedId) return { scriptId: null, scriptName: null };
  return { scriptId: selectedId, scriptName: list.find((s) => s.id === selectedId)?.name ?? null };
}
```

- [ ] **Step 5: Build the picker section**

In `createSetupOptionsForm`, insert this block after the `seedInput`/`codexRow` declarations and before `renderSeedRow`:

```ts
  // Post-setup saved script. The select is a LOOKUP KEY picker — its values are
  // script ids and the server resolves them against data/fleet-scripts.json, so
  // nothing chosen here can reach a shell as text. Populated once on creation;
  // both empty-list and failed-fetch degrade in place to a disabled control with
  // a reason, the same posture the seed rows take, rather than presenting an
  // empty dropdown the operator cannot explain.
  const scriptSel = el('select', {}, [el('option', { value: '' }, ['None'])]) as HTMLSelectElement;
  const scriptWhen = el('div', { class: 'seed-status' }, [
    'Runs on the box after the tools, shell framework and AI-auth seeding, and before its tmux session is created.',
  ]);
  const scriptDesc = el('div', { class: 'seed-status' });
  let scriptList: FleetScript[] = [];

  function syncScriptDesc() {
    scriptDesc.textContent = scriptList.find((s) => s.id === scriptSel.value)?.description || '';
  }
  scriptSel.addEventListener('change', syncScriptDesc);

  function applyScripts(list: FleetScript[] | null) {
    if (!list) {
      scriptSel.disabled = true;
      scriptDesc.textContent = 'Saved scripts are unavailable.';
      return;
    }
    scriptList = sortScripts(list);
    if (!scriptList.length) {
      scriptSel.disabled = true;
      scriptDesc.textContent = 'No saved scripts — create one in Fleet Command.';
      return;
    }
    scriptSel.disabled = false;
    scriptSel.replaceChildren(
      el('option', { value: '' }, ['None']),
      ...scriptList.map((s) => el('option', { value: s.id }, [s.name])),
    );
    syncScriptDesc();
  }
  void fleetScripts.list().then(applyScripts).catch(() => applyScripts(null));
```

- [ ] **Step 6: Mount the section and return the values**

Add the section last in the `element`:

```ts
  const element = el('div', { class: 'setup-options' }, [
    section('Terminal', omtField, shellGroup),
    tools.element,
    section('AI auth seeding', seedField, claudeRow, codexRow),
    section('Post-setup script', field('Saved script', scriptSel), scriptWhen, scriptDesc),
  ]);
```

and extend `values()`:

```ts
    values: () => ({
      ohMyTmux: omt.checked,
      ohMyZsh: shZsh.input.checked,
      ohMyBash: shBash.input.checked,
      tools: tools.selected(),
      seedAiAuth: seedInput.checked,
      ...scriptSelection(scriptList, scriptSel.value),
    }),
```

- [ ] **Step 7: Run typecheck and tests**

Run: `npm run typecheck && npx vitest run test/setupOptions.test.js`
Expected: typecheck clean, tests PASS. If `proxmoxUi.ts` errors on `SetupOptions`, confirm Task 5 made `scriptId`/`scriptName` **optional** (`?:`) on `SetupOptions` — `SetupOptionsValues` requires them, `SetupOptions` does not.

- [ ] **Step 8: Full suite + build + commit**

```bash
npm test
npm run build
git add src/web/setupOptions.ts test/setupOptions.test.js
git commit -m "feat(ui): pick a saved fleet script to run at the end of setup"
```

---

### Task 7: Documentation

**Files:**
- Modify: `docs/boxes-and-setup.md` (new section after `## Seeding AI CLI auth`)
- Modify: `docs/proxmox.md` (a paragraph in `## Proxmox LXC provisioning`)
- Modify: `docs/fleet-and-health.md` (a paragraph in `## Fleet Command`)
- Modify: `README.md`, `CLAUDE.md`, `AGENTS.md`

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the user-facing section to `docs/boxes-and-setup.md`**

Append after the `## Seeding AI CLI auth` section:

```markdown
## Post-setup script

The setup form's last section picks one of Fleet Command's **saved scripts** to run
on the box once everything else is installed. The order is deliberate:

```
tools & shell framework → AI-auth seeding → Claude statusline → agent hooks
  → your saved script → tmux session created
```

Your script runs *before* the box's tmux session exists, so anything it writes to
`.zshrc`, `.bashrc` or `.tmux.conf` is picked up by that session's first shell. It
runs non-interactively over the same SSH connection as the rest of setup, so it
cannot answer a sudo password prompt — use a box that sudoes without one, or run
the script from Fleet Command afterwards.

The picker appears in both the Add/Edit Box modal and the Proxmox hub's Provision
tab. Selecting **None** (the default) runs nothing.

**A failing script never fails the setup job.** Everything Tmuxifier installed
succeeded and the box is usable, so the job still reaches `done` and the result is
reported on its own line — `bootstrap failed (exited 2)` — with the script's full
output in the job log above it. Re-run it from Fleet Command once you have fixed it;
retrying the setup would reinstall everything just to retry the script.

The script is resolved by id when it runs, not snapshotted when you pick it, so
editing it between clicking Provision and the phase starting means the edited
version runs. One deleted in that window is reported as
`bootstrap skipped (saved script no longer exists)`. The *name* recorded on the job
is frozen, so renaming a script later never rewrites what a past job says it ran.
```

- [ ] **Step 2: Cross-reference it from `docs/proxmox.md`**

Add at the end of the `## Proxmox LXC provisioning` section (before `### Shell-framework update clamps`):

```markdown
The Provision tab's setup options include a **post-setup script** picker: one of
Fleet Command's saved scripts, run on the container after every other install and
before its tmux session is created. See
[Post-setup script](boxes-and-setup.md#post-setup-script).
```

- [ ] **Step 3: Cross-reference it from `docs/fleet-and-health.md`**

Add at the end of the `## Fleet Command` section:

```markdown
A saved script is not limited to fleet runs: the box setup form and the Proxmox
Provision tab can select one to run as the last step of setting a box up. See
[Post-setup script](boxes-and-setup.md#post-setup-script).
```

- [ ] **Step 4: Mention it in `README.md`**

Find the short section that links to `docs/boxes-and-setup.md` and add one sentence
to it: `A saved Fleet Command script can be selected to run as the last step of
setup — after the tools and credentials, before the tmux session.`

- [ ] **Step 5: Update `CLAUDE.md` and `AGENTS.md`**

These two are kept in sync. Make the same four edits in both:

1. `fleetScriptsStore.js` bullet — append: `Also serves the setup manager's post-setup script phase via getScript(id), the single-record read.`
2. `setupManager.js` bullet — after the sentence about the `statusline` and `agent-hooks` phases, add: `A `script` phase follows them, gated on the setup options' `scriptId`: it resolves that id against `fleetScriptsStore` (injected `getScript`) and streams the saved script over the same transport as the install script, recorded on `job.postScript` and — like every phase before it — never promoted to a job failure. It runs strictly BEFORE `ensureSession` for the same reason the seed does: a shell reads its rc files once, at startup, so a script that edits them must land before the session's first shell.`
3. `setupManager.js` bullet — add: ``streamRemote` is the shared spawn/log/coalesced-persist/handle-register/exit-code helper both the install run and the script phase use, so the two cannot drift.`
4. `setupOptions.ts` entry in the web-client paragraph — append: `plus the Post-setup script picker, a lookup-key select over the saved fleet scripts (`scriptId`/`scriptName` in the payload).`

- [ ] **Step 6: Verify no PII and commit**

```bash
git add -A
git diff --cached   # review: no real domains, IPs, hostnames, or emails
git commit -m "docs: post-setup saved script"
```

---

### Task 8: Live validation

This repo validates features **on the live app before they merge** (`CLAUDE.md`, "Shipping"). Do not merge without it.

**Files:** none — this is a deployment and manual verification task.

**Interfaces:**
- Consumes: everything from Tasks 1-7.

- [ ] **Step 1: Confirm no job is running**

Run: `curl -sk "$BASE/api/setup" -b "$COOKIE" | head -c 400` (and the same for `/api/proxmox/provisions`, `/api/proxmox/lifecycle-jobs`, `/api/fleet/jobs`, `/api/voice/install`), or check the UI. A restart interrupts in-flight jobs.

- [ ] **Step 2: Deploy the candidate build**

```bash
npm run build
rsync -a --delete "$PWD/dist/" /root/tmuxifier/dist/
sudo systemctl restart tmuxifier
systemctl status tmuxifier
```

The restart is mandatory even though this change also touches the server — asset routes are registered per file at boot.

- [ ] **Step 3: Verify the bundle really swapped**

Fetch one hashed asset end-to-end and confirm its content-type is JavaScript, not `text/html`:

```bash
BASE="$(node -e "import('./src/server/config.js').then(({loadConfig})=>{const c=loadConfig();process.stdout.write(((c.tlsCert&&c.tlsKey)?'https':'http')+'://'+c.bindAddress+':'+c.port)})")"
ASSET="$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' dist/index.html | head -1)"
curl -sk -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE$ASSET"
```

Expected: `200 text/javascript` (or `application/javascript`). `text/html` means the SPA fallback served it and the restart did not take.

- [ ] **Step 4: Manual verification**

1. Save a script in Fleet Command that leaves both a file and an rc edit, e.g.
   `echo "export TMUXIFIER_SCRIPT_RAN=yes" >> ~/.bashrc && date > ~/.provision-marker`
2. Proxmox hub → Provision → pick a preset, set a hostname, select that script in
   **Post-setup script**, Provision.
3. Watch the panel: the phase line must read **Running saved script…** *after* the
   installs, and the script's output must appear in the log live.
4. On `done`, the status line must carry the script's own name and a `✓`.
5. Open the box's terminal and confirm `~/.provision-marker` exists **and**
   `echo $TMUXIFIER_SCRIPT_RAN` prints `yes` — the second is the ordering proof: the
   session's first shell read the rc file the script wrote.
6. Repeat with a script whose last line is `exit 3`. The job must still reach
   **Setup complete ✓** with `… failed (exited 3)` appended, and the terminal must
   still open.

- [ ] **Step 5: Report the results**

Report what was observed at each step, including anything that did not match. Do not
merge on a partial pass — fix on the branch and redeploy.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: `getScript` → Task 1; the `streamRemote` extraction → Task 2; options, the `script` phase, the `SeedResult`-shaped result, `summary()` → Task 3; the route field list, `NO_FLEET_SCRIPTS`, the `index.js` closure → Task 4; the client types, phase text and panel lines → Task 5; the picker and its degradation modes → Task 6; the living docs → Task 7; the live-validation requirement → Task 8. The spec's "no change to `proxmoxProvision.js`" is honoured — that file appears in no task. Every row of the spec's error-handling table has a test in Task 3 except the two cancel rows, of which the "during the phase" row is covered by the kill test and the "before the phase" row is pre-existing behaviour the spec explicitly marks as unchanged.

**Type consistency.** `getScript(id)` returns a record or `null` in Task 1, and Task 3 consumes exactly that (`!rec || !rec.script` → skip). `streamRemote(j, box, script, opts)` returns a number in Task 2 and Task 3 treats it as one. `PushResult` is defined in Task 5 and is the parameter type of `formatStatuslineResult`, which Tasks 5's `main.ts`/`proxmoxUi.ts` call sites pass `job.postScript` to. `scriptId`/`scriptName` are **required** on `SetupOptionsValues` (Task 6) and **optional** on `SetupOptions` (Task 5) — deliberate, and called out in Task 6 Step 6's troubleshooting note.

`scriptSelection(list, selectedId)` is defined in Task 6 Step 4 and consumed by `values()` in Step 6 and by the tests in Step 1 — one name, one signature.

**Red-green integrity.** Each task's Step-1 test genuinely fails before its implementation: Task 1 on a missing method, Task 2 is a no-behaviour-change refactor gated by the existing suite instead (stated explicitly), Task 3 on a missing phase in the recorded call order, Task 4 on a dropped route field, Task 5 on the phase-text string, Task 6 on a missing export. The one trap avoided: a Task 6 test asserting only on `setupStartPayload` would have passed before the feature existed, because that function spreads and `tsc` covers only `src/web`, not `test/` — hence the pure `scriptSelection` seam.

**Placeholder scan.** No TBD/TODO, no "add error handling", no "similar to Task N". Every code step carries the literal code.
