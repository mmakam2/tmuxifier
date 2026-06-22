# Adaptive Status-Probe Backoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the dashboard from re-probing a failing box every 30s — which trips host-side fail2ban/rate-limits and wedges the box red — by backing each failing box off to a 5-minute floor, while keeping it auto-recovering and instantly retryable on user engagement.

**Architecture:** All backoff state lives server-side in `createStatusChecker` (`src/server/status.js`) as an in-memory `Map` keyed by box id/host. `checkBox` returns the last-known status without an SSH probe while a box is inside its backoff window; consecutive failures escalate the interval 30s→…→300s (a `needsAuth` result jumps straight to 300s), capping at a 5-minute floor that never fully stops. State clears on a successful probe or on a new `resetBackoff(box)` call, which the reconnect route and the interactive `/term` attach invoke when the user engages a box.

**Tech Stack:** Node 20+ ESM, Fastify, Vitest (unit + integration, real code via dependency-injection factories — no mocks), TypeScript + xterm.js web client built by Vite.

## Global Constraints

- ESM everywhere (`"type": "module"`); Node 20+.
- Server is plain `.js`; web client is `.ts`.
- TDD: failing test first; tests use real code with injected dependencies, never mocks.
- `createStatusChecker` stays pure/injectable — never read `Date.now()`/`process.env` directly; time comes from an injected `now()` so tests are deterministic.
- Backoff parameters are constructor options with defaults `stepSec = 30`, `capSec = 300`; not env-exposed.
- Conventional-commit messages (`fix(...)`, `feat(...)`, `test(...)`). End each commit message with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- No real PII in committed code/tests — use placeholder hosts like `h`, `h1`.
- Failure = any `reachable === false` result (includes `needsAuth`). Success = `reachable === true`.
- Return-shape rule: only decorate a returned status with `paused: true` + `nextProbeAt` when the box is at the 5-minute floor or when returning a cached (skipped) paused result. Fresh, below-cap failures return the plain result object — this keeps the existing exact-equality tests green.

---

### Task 1: Per-box backoff core in `createStatusChecker`

**Files:**
- Modify: `src/server/status.js` (replace the `createStatusChecker` function, currently lines 31-59)
- Test: `test/status.test.js` (append new tests)

**Interfaces:**
- Consumes: existing module-level `PROBE_REMOTE`, `AUTH_FAIL_RE`, `MUX_STALE_RE`, `parseTmuxSessions`, and `buildProbeArgv` (imported at top of file).
- Produces:
  - `createStatusChecker({ run, hostKeyPolicy?, sshConfigFile?, controlDir?, controlPersist?, reapStaleMaster?, now?, stepSec?, capSec? }) => { checkBox(box) => Promise<Status>, resetBackoff(boxOrId) => void }`
  - `Status` is the existing object plus optional `paused?: boolean` and `nextProbeAt?: number`.
  - `resetBackoff` accepts either a box object (keyed by `box.id || box.host`) or a string id.

- [ ] **Step 1: Write the failing tests** — append to `test/status.test.js`:

```js
test('checkBox: skips the SSH probe while inside the backoff window (failing box not re-probed every poll)', async () => {
  let calls = 0;
  let clock = 0;
  const run = async () => { calls++; return { code: 255, stdout: '', stderr: 'timeout' }; };
  const sc = createStatusChecker({ run, now: () => clock });
  await sc.checkBox({ host: 'h' });           // 1st probe: fail #1 -> next allowed in 30s
  expect(calls).toBe(1);
  clock = 10_000;                             // 10s later, still inside the 30s window
  await sc.checkBox({ host: 'h' });
  expect(calls).toBe(1);                      // skipped, returned last-known
  clock = 31_000;                            // past the window
  await sc.checkBox({ host: 'h' });
  expect(calls).toBe(2);                      // probed again
});

test('checkBox: the second failure waits 60s, not 30s (interval escalates by 30s)', async () => {
  let calls = 0;
  let clock = 0;
  const run = async () => { calls++; return { code: 255, stdout: '', stderr: 'timeout' }; };
  const sc = createStatusChecker({ run, now: () => clock });
  await sc.checkBox({ host: 'h' });           // fail #1 -> due at 30s
  clock = 31_000; await sc.checkBox({ host: 'h' }); // fail #2 -> due at 31s + 60s = 91s
  expect(calls).toBe(2);
  clock = 61_000; await sc.checkBox({ host: 'h' }); // 30s after #2: still inside the 60s window
  expect(calls).toBe(2);                      // skipped -> interval really grew to 60s
  clock = 92_000; await sc.checkBox({ host: 'h' });
  expect(calls).toBe(3);
});

test('checkBox: interval caps at the 5m floor and marks the box paused, never fully stopping', async () => {
  let clock = 0;
  const run = async () => ({ code: 255, stdout: '', stderr: 'timeout' });
  const sc = createStatusChecker({ run, now: () => clock });
  let due = 0;
  let last;
  for (let n = 1; n <= 10; n++) {             // 30*10 = 300 reaches the cap
    clock = due;
    last = await sc.checkBox({ host: 'h' });
    due = clock + Math.min(30 * n, 300) * 1000;
  }
  expect(last.paused).toBe(true);             // at the 5m floor
  expect(last.nextProbeAt).toBe(clock + 300_000);
  clock = due;                                // one more window later
  const next = await sc.checkBox({ host: 'h' });
  expect(next.paused).toBe(true);             // stays at the floor, still probing
});

test('checkBox: needsAuth jumps straight to the 5m floor (paused immediately, no escalation)', async () => {
  let calls = 0;
  let clock = 0;
  const run = async () => { calls++; return { code: 255, stdout: '', stderr: 'me@h: Permission denied (publickey,password).' }; };
  const sc = createStatusChecker({ run, now: () => clock });
  const st = await sc.checkBox({ host: 'h' });
  expect(st.needsAuth).toBe(true);
  expect(st.paused).toBe(true);               // paused on the very first needsAuth
  clock = 299_000; await sc.checkBox({ host: 'h' }); // just under 5m
  expect(calls).toBe(1);                       // not re-probed inside the 5m window
  clock = 301_000; await sc.checkBox({ host: 'h' });
  expect(calls).toBe(2);                       // re-probed at the 5m cadence
});

test('checkBox: a successful probe clears backoff (next probe happens immediately)', async () => {
  let clock = 0;
  let mode = 'fail';
  let calls = 0;
  const run = async () => {
    calls++;
    return mode === 'fail'
      ? { code: 255, stdout: '', stderr: 'timeout' }
      : { code: 0, stdout: 'web:1:0:1', stderr: '' };
  };
  const sc = createStatusChecker({ run, now: () => clock });
  await sc.checkBox({ host: 'h' });           // fail #1 -> 30s window
  mode = 'ok';
  clock = 31_000;
  const ok = await sc.checkBox({ host: 'h' });
  expect(ok.reachable).toBe(true);
  expect(ok.paused).toBeUndefined();          // success returns the plain result
  mode = 'fail';
  clock = 31_500;                            // immediately after, no leftover window
  await sc.checkBox({ host: 'h' });
  expect(calls).toBe(3);                       // probed every call: backoff was cleared by success
});

test('resetBackoff: clears a box so the next checkBox probes immediately despite an open window', async () => {
  let calls = 0;
  let clock = 0;
  const run = async () => { calls++; return { code: 255, stdout: '', stderr: 'timeout' }; };
  const sc = createStatusChecker({ run, now: () => clock });
  await sc.checkBox({ host: 'h' });           // fail -> 30s window
  clock = 5_000; await sc.checkBox({ host: 'h' });
  expect(calls).toBe(1);                       // throttled
  sc.resetBackoff({ host: 'h' });             // user engaged the box
  await sc.checkBox({ host: 'h' });
  expect(calls).toBe(2);                       // probed immediately
  sc.resetBackoff('h');                        // string-id form is also accepted (no throw)
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- status`
Expected: the six new tests FAIL (e.g. `calls` is 2 instead of 1 because there is no throttle yet; `st.paused` is `undefined`). The pre-existing `status.test.js` tests still PASS.

- [ ] **Step 3: Replace `createStatusChecker` with the backoff version**

In `src/server/status.js`, replace the entire existing `createStatusChecker` function (currently lines 31-59) with:

```js
export function createStatusChecker({
  run, hostKeyPolicy = 'accept-new', sshConfigFile, controlDir, controlPersist, reapStaleMaster,
  now = () => Date.now(), stepSec = 30, capSec = 300,
}) {
  const remote = PROBE_REMOTE;
  const capCount = Math.ceil(capSec / stepSec);
  const backoff = new Map(); // key -> { fails, nextProbeAt, paused, last }
  const keyFor = (box) => box.id || box.host;

  // One real SSH probe (the former checkBox body). Always resolves to a status
  // object and never throws — an unsafe box or thrown error becomes unreachable.
  async function probe(box) {
    try {
      const argv = buildProbeArgv(box, remote, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
      const res = await run(argv);
      // A leftover socket disables multiplexing; reap it so the next connect
      // re-establishes a clean master (regardless of this probe's outcome).
      if (reapStaleMaster && MUX_STALE_RE.test(String(res.stderr || ''))) {
        try { await reapStaleMaster(box); } catch {}
      }
      if (res.code !== 0 && !String(res.stdout).trim()) {
        const err = String(res.stderr || '').trim();
        if (AUTH_FAIL_RE.test(err)) {
          return { reachable: false, needsAuth: true, error: err || 'authentication required' };
        }
        return { reachable: false, error: err || 'unreachable' };
      }
      if (String(res.stdout).includes('__NO_TMUX__')) {
        return { reachable: true, tmux: false, sessions: [] };
      }
      return { reachable: true, tmux: true, sessions: parseTmuxSessions(res.stdout) };
    } catch (e) {
      return { reachable: false, error: String((e && e.message) || e) };
    }
  }

  return {
    async checkBox(box) {
      const key = keyFor(box);
      const s = backoff.get(key);
      const t = now();
      // Inside the current backoff window: return the last-known status without
      // touching SSH, so a failing box is not re-probed on every poll.
      if (s && t < s.nextProbeAt) {
        return s.paused ? { ...s.last, paused: true, nextProbeAt: s.nextProbeAt } : { ...s.last };
      }
      const result = await probe(box);
      if (result.reachable) {
        backoff.delete(key); // recovered: back to the normal poll cadence
        return result;
      }
      // Failure. A needs-login box can never succeed under BatchMode and fast
      // probing only feeds host-side fail2ban, so jump straight to the 5m floor.
      const fails = result.needsAuth ? capCount : ((s?.fails ?? 0) + 1);
      const intervalSec = Math.min(stepSec * fails, capSec);
      const paused = intervalSec >= capSec;
      const nextProbeAt = t + intervalSec * 1000;
      backoff.set(key, { fails, nextProbeAt, paused, last: result });
      return paused ? { ...result, paused: true, nextProbeAt } : result;
    },
    resetBackoff(box) {
      backoff.delete(typeof box === 'string' ? box : keyFor(box));
    },
  };
}
```

- [ ] **Step 4: Run the full status test file to verify pass**

Run: `npm test -- status`
Expected: PASS — all new tests plus every pre-existing `status.test.js` test (the success/exact-equality tests are unaffected because below-cap fresh failures return the plain result).

- [ ] **Step 5: Commit**

```bash
git add src/server/status.js test/status.test.js
git commit -m "$(cat <<'EOF'
feat(status): back off probes for failing boxes down to a 5m floor

Per-box backoff in createStatusChecker: consecutive failures escalate the
probe interval 30s->...->300s; a needsAuth result jumps straight to the 5m
floor; the floor never fully stops. Success or resetBackoff() clears it.
Stops 30s re-probing from tripping host-side fail2ban/rate-limits.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Reset backoff on user engagement (reconnect route + interactive attach)

**Files:**
- Modify: `src/server/server.js` (reconnect route ~lines 215-232; interactive `/term` attach ~lines 377-388)
- Test: `test/server.test.js` (append one test)

**Interfaces:**
- Consumes: `statusChecker.resetBackoff(idOrBox)` from Task 1; `statusChecker` is already destructured in `buildServer(...)`.
- Produces: no new exports; `POST /api/boxes/:id/reconnect` and a successful interactive box attach now call `statusChecker.resetBackoff(box.id)`.

- [ ] **Step 1: Write the failing test** — append to `test/server.test.js`:

```js
test('reconnect clears the box backoff so it will be re-probed at full cadence', async () => {
  const reset = [];
  const statusChecker = {
    checkBox: async () => ({ reachable: true }),
    resetBackoff: (id) => reset.push(id),
  };
  app = await makeApp({ statusChecker });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h1' } });
  const id = created.json().id;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${id}/reconnect`, headers });
  expect(res.statusCode).toBe(200);
  expect(reset).toContain(id);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- server.test`
Expected: FAIL — `reset` is empty (`expect(reset).toContain(id)`), because the route does not call `resetBackoff` yet.

- [ ] **Step 3: Add the reset call to the reconnect route**

In `src/server/server.js`, in the `app.post('/api/boxes/:id/reconnect', ...)` handler, add the reset just before `return { ok: true };` (after the `killSession` block):

```js
    if (boxActions?.killSession) {
      try { void Promise.resolve(boxActions.killSession(box)).catch(() => {}); } catch {}
    }
    if (statusChecker?.resetBackoff) statusChecker.resetBackoff(box.id);
    return { ok: true };
```

- [ ] **Step 4: Add the reset call to the interactive attach path**

In the same file, in the `/term` handler's interactive mode, right after the box session opens successfully (after the `entry = sessions.open({ key: boxId, box, session: box.sessionName, size });` try/catch block, before `const off = sessions.attach(...)`), add:

```js
      // Opening a box is explicit engagement — clear any probe backoff so the
      // dot re-checks promptly instead of waiting out the 5m floor.
      if (statusChecker?.resetBackoff) statusChecker.resetBackoff(boxId);
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npm test -- server`
Expected: PASS — the new reconnect test passes and the existing `server.test.js` / `server.ws.integration.test.js` tests still pass (the WS attach guard is a no-op when `resetBackoff` is absent in fakes).

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js test/server.test.js
git commit -m "$(cat <<'EOF'
feat(status): clear probe backoff when the user engages a box

POST /api/boxes/:id/reconnect and a successful interactive /term attach now
call statusChecker.resetBackoff(box.id), so opening a box (or hitting the
reconnect button) retries it immediately instead of waiting out the 5m floor.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Surface the paused state in the web client

**Files:**
- Modify: `src/web/api.ts` (the `Status` interface, line 6)
- Modify: `src/web/statusDot.ts` (`dotTitleFor`)
- Modify: `src/web/main.ts` (reconnect button handler ~lines 309-315; `openBox` ~lines 433-440)
- Test: `test/statusDot.test.js` (append tests)

**Interfaces:**
- Consumes: `Status.paused` (optional boolean) from Task 1's server return shape; `pollStatus()` (module-level in `main.ts`, defined ~line 196).
- Produces: `dotTitleFor` returns a slow-retry hint when `paused`; `dotClassFor` is unchanged.

- [ ] **Step 1: Write the failing tests** — append to `test/statusDot.test.js`:

```js
test('dotTitleFor: paused unreachable explains the 5m retry and how to force one', () => {
  const title = dotTitleFor({ reachable: false, paused: true });
  expect(title).toMatch(/5m/);
  expect(title).toMatch(/retry/i);
});

test('dotTitleFor: plain (non-paused) unreachable stays terse', () => {
  expect(dotTitleFor({ reachable: false })).toBe('Unreachable');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- statusDot`
Expected: FAIL — the paused title currently returns `'Unreachable'`, so the `/5m/` match fails.

- [ ] **Step 3: Extend the `Status` type**

In `src/web/api.ts`, replace line 6 with:

```ts
export interface Status { reachable: boolean; tmux?: boolean; needsAuth?: boolean; paused?: boolean; nextProbeAt?: number; sessions?: { name: string; windows: number }[]; error?: string; }
```

- [ ] **Step 4: Update `dotTitleFor`**

In `src/web/statusDot.ts`, replace the `dotTitleFor` function with:

```ts
export function dotTitleFor(st: Status | undefined): string {
  if (!st) return 'Status unknown';
  if (st.needsAuth) return 'Needs login — click the box (or ↻) to reconnect and enter your password';
  if (!st.reachable) return st.paused
    ? 'Unreachable — retrying every 5m; click the box or ↻ to retry now'
    : 'Unreachable';
  return st.tmux === false ? 'Reachable (tmux not running)' : 'Connected';
}
```

(`dotClassFor` is unchanged — a paused box keeps its `red`/`auth` color.)

- [ ] **Step 5: Run statusDot tests to verify pass**

Run: `npm test -- statusDot`
Expected: PASS — including the existing `needsAuth` title test (the new copy still contains "reconnect", matching `/reconnect/i`).

- [ ] **Step 6: Refresh dots immediately on engagement in `main.ts`**

In `src/web/main.ts`, in the per-box reconnect button handler, add an immediate refresh at the end:

```js
  refreshBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await api.reconnectBox(b.id);
    const wasActive = activeBoxId === b.id;
    closeTab(b.id);
    if (wasActive) openBox(b);
    void pollStatus();
  });
```

And in `openBox`, after the new terminal is opened (the final `term.focus();` at the end of the function), add an immediate refresh:

```js
  const term = openTerminal(el, b.id);
  tabs.set(b.id, { el, term });
  term.focus();
  void pollStatus();
```

- [ ] **Step 7: Type-check / build to verify the client compiles**

Run: `npm run build`
Expected: build succeeds (Vite + tsc), no type errors from the new `Status` fields or `pollStatus` calls.

- [ ] **Step 8: Commit**

```bash
git add src/web/api.ts src/web/statusDot.ts src/web/main.ts test/statusDot.test.js
git commit -m "$(cat <<'EOF'
feat(ui): show paused-probe state and refresh dots on engagement

Status gains optional paused/nextProbeAt; the status-dot tooltip explains the
5m slow-retry and how to force a retry. Opening a box or hitting reconnect
triggers an immediate status poll so the dot updates without waiting 30s.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: all unit + integration tests PASS.

- [ ] **Step 2: Build the web bundle**

Run: `npm run build`
Expected: clean build into `dist/`.

- [ ] **Step 3: Report results**

Summarize the passing test count and confirm the build succeeded. Do **not** bump the version, restart the service, push, or tag — leave shipping (the CLAUDE.md "Shipping" checklist) to the user.

---

## Notes for the implementer

- The interactive-attach `resetBackoff` call (Task 2, Step 4) is exercised in real use but not unit-tested here (WebSocket attach is integration-level); it is guarded with `statusChecker?.resetBackoff` so existing WS integration fakes are unaffected. Confirm `npm test` keeps `server.ws.integration.test.js` green.
- Keying: `checkBox` uses `box.id || box.host`. The server always passes boxes with an `id`, and `resetBackoff` is called with the `box.id` string from routes — both resolve to the same key. The status-checker unit tests pass bare `{ host: 'h' }` (no id), which keys on `host`.
- Backoff state is in-memory and per-process; a server restart clears it, after which every box is probed once on the next poll — intended.
