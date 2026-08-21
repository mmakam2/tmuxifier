# Session/Window Kill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator kill any tmux session or window on a box directly from the session picker, via a per-row `×`.

**Architecture:** One new server route (`POST /api/boxes/:id/kill`) backed by two new exact-target remote builders. On the client, the native `<select>` that both surfaces use today is replaced by a new `sessionPicker.ts` widget — a trigger button plus an anchored popup whose rows each carry a kill `×` armed through the existing `arming.ts` reducer. The pure row model (`sessionTargets`/`sessionTargetList`) is not touched; only its rendering changes.

**Tech Stack:** Node 20+ ESM, Fastify, vanilla TypeScript + Vite (no framework), vitest (`environment: 'node'`, **no jsdom**), Playwright for anything with a DOM.

**Spec:** `docs/superpowers/specs/2026-08-21-session-window-kill-design.md`

## Global Constraints

- **ESM everywhere** (`"type": "module"`). Server is plain `.js`; web client is `.ts`.
- **TDD, real code not mocks.** Factories take injected dependencies; do not introduce mocking libraries.
- **vitest has no DOM.** `environment: 'node'`, no jsdom. Never plan a unit test that constructs an element. DOM layers are covered by Playwright only.
- **Every tmux target is exact-matched with `=`.** A bare `-t` target PREFIX-matches when no exact name exists. `SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/`, `WINDOW_ID_RE = /^@\d{1,9}$/`, both exported from `src/server/sshCommand.js`.
- **A window target is always session-qualified** (`'=<session>:@<id>'`). A grouped session shares window objects, so a bare `@7` names two windows at once.
- **No real PII in commits.** The repo is public. Use `example.com`, RFC1918 addresses like `192.168.1.10`, session names like `web`/`web2`.
- **Conventional commits**: `feat(ui): …`, `fix(pty): …`, `test(server): …`.
- Run `npm test` (typecheck + vitest) before each commit. `npm run test:e2e` for Playwright tasks.
- **Do NOT run `npm run build` in the repo working tree.** The live service serves this repo's own `dist/` and registers asset routes at boot, so a build renders the running app blank until a restart. Use `npm run typecheck` to check client edits.

---

### Task 1: Kill remote builders

**Files:**
- Modify: `src/server/boxActions.js` (beside `buildSelectWindowRemote`, ~line 492-505)
- Test: `test/boxActions.test.js`

**Interfaces:**
- Consumes: `SESSION_NAME_RE`, `WINDOW_ID_RE`, `shSingleQuote` from `./sshCommand.js` (already imported by this file).
- Produces:
  - `buildKillSessionRemote(session: string): string` — throws `Error('invalid session name')` on a bad name.
  - `buildKillWindowRemote(session: string, windowId: string): string` — throws `Error('invalid session name')` or `Error('invalid window id')`.
  - `tmuxBinPreamble(): string[]` — the shared tmux-resolution lines, internal to the module (not exported).

- [ ] **Step 1: Write the failing tests**

Append to `test/boxActions.test.js`:

```js
import { buildKillSessionRemote, buildKillWindowRemote } from '../src/server/boxActions.js';

test('kill-session targets the exact session name, never a prefix match', () => {
  // A bare `-t web` prefix-matches when no exact 'web' exists, so on a box
  // holding only 'web2' this would kill a stranger's session. Unrecoverable,
  // unlike the same mistake in has-session.
  expect(buildKillSessionRemote('web')).toContain("kill-session -t '=web'");
});

test('kill-window targets a SESSION-QUALIFIED exact window', () => {
  // A window id is unique per window OBJECT, not per session: a grouped session
  // (`new-session -t web -s webclone`) shares those objects, so a bare `@7`
  // names two windows and tmux resolves whichever it finds first.
  expect(buildKillWindowRemote('web', '@7')).toContain("kill-window -t '=web:@7'");
});

test('the kill builders reject bad names and ids rather than rewriting them', () => {
  // buildKillTmuxRemote sanitizes (silently rewrites); these must throw. An
  // explicit user kill that quietly retargets is worse than one that fails.
  for (const bad of ['', 'my session', "web'", 'web:1', 'a'.repeat(65), 42, null, undefined]) {
    expect(() => buildKillSessionRemote(bad)).toThrow();
    expect(() => buildKillWindowRemote(bad, '@1')).toThrow();
  }
  for (const bad of ['', '7', '@1;rm -rf /', "@1'", '@' + '9'.repeat(10), 42, null, undefined]) {
    expect(() => buildKillWindowRemote('web', bad)).toThrow();
  }
});

test('the kill builders do not swallow a failure the way the teardown builder does', () => {
  // buildKillTmuxRemote ends in `|| true` because box removal must not be
  // blocked by an unreachable host. These report, so the route can 502.
  expect(buildKillSessionRemote('web')).not.toContain('|| true');
  expect(buildKillWindowRemote('web', '@1')).not.toContain('|| true');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/boxActions.test.js`
Expected: FAIL — `buildKillSessionRemote is not a function`.

- [ ] **Step 3: Extract the shared preamble**

`buildSelectWindowRemote` already opens with a tmux-resolution block that both new builders need verbatim. Extract it first, with the existing green tests as the safety net. In `src/server/boxActions.js`, above `buildSelectWindowRemote`:

```js
// The tmux-resolution preamble every session/window remote opens with. These
// run under the box's LOGIN shell with whatever PATH it provides, which is not
// the PATH an interactive shell shows — hence the explicit fallback sweep.
function tmuxBinPreamble() {
  return [
    'set -eu',
    'TMUX_BIN="$(command -v tmux || true)"',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for p in /usr/bin/tmux /usr/local/bin/tmux /bin/tmux; do if [ -x "$p" ]; then TMUX_BIN="$p"; break; fi; done',
    'fi',
    '[ -n "$TMUX_BIN" ]',
  ];
}
```

Then rewrite `buildSelectWindowRemote`'s body to use it:

```js
export function buildSelectWindowRemote(session, windowId) {
  if (!SESSION_NAME_RE.test(String(session))) throw new Error('invalid session name');
  if (!WINDOW_ID_RE.test(String(windowId))) throw new Error('invalid window id');
  const target = shSingleQuote(`=${session}:${windowId}`);
  return [...tmuxBinPreamble(), `"$TMUX_BIN" select-window -t ${target}`].join('\n');
}
```

- [ ] **Step 4: Run the existing suite to prove the extraction changed nothing**

Run: `npx vitest run test/boxActions.test.js test/windowSelectRoute.test.js`
Expected: the pre-existing `select-window` tests still PASS; the four new tests still FAIL.

- [ ] **Step 5: Implement the two builders**

Add below `buildSelectWindowRemote`:

```js
// Kill one tmux session on the box. Deliberately NOT a widening of
// buildKillTmuxRemote below: that one runs sanitizeSession (silently REWRITES a
// name rather than rejecting it) and ends in `|| true` (reports success
// whatever happened). Both are correct for its caller — best-effort teardown
// when a box is being removed, which must not be blocked by an unreachable host
// — and both are wrong for an explicit user action whose whole job is to say
// what it did.
export function buildKillSessionRemote(session) {
  if (!SESSION_NAME_RE.test(String(session))) throw new Error('invalid session name');
  const target = shSingleQuote(`=${session}`);
  return [...tmuxBinPreamble(), `"$TMUX_BIN" kill-session -t ${target}`].join('\n');
}

// Kill ONE window. Session-qualified for the same reason select-window is: a
// grouped session shares its window objects, so a bare `@7` names two windows
// at once and tmux picks whichever it resolves first — verified on tmux 3.5a.
// Killing the last window of a session destroys the session; that is tmux's own
// rule and is not special-cased here.
export function buildKillWindowRemote(session, windowId) {
  if (!SESSION_NAME_RE.test(String(session))) throw new Error('invalid session name');
  if (!WINDOW_ID_RE.test(String(windowId))) throw new Error('invalid window id');
  const target = shSingleQuote(`=${session}:${windowId}`);
  return [...tmuxBinPreamble(), `"$TMUX_BIN" kill-window -t ${target}`].join('\n');
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite green.

- [ ] **Step 7: Commit**

```bash
git add src/server/boxActions.js test/boxActions.test.js
git commit -m "feat(server): exact-target tmux kill-session and kill-window remotes"
```

---

### Task 2: The kill route

**Files:**
- Modify: `src/server/server.js` (import at line 11; route beside `POST /api/boxes/:id/window`, ~line 927-970)
- Test: `test/killRoute.test.js` (create)

**Interfaces:**
- Consumes: `buildKillSessionRemote`, `buildKillWindowRemote` from Task 1.
- Produces: `POST /api/boxes/:id/kill`, body `{ session: string, windowId?: string }` → `{ ok: true }`.

- [ ] **Step 1: Write the failing tests**

Create `test/killRoute.test.js`. The harness is lifted from `test/windowSelectRoute.test.js` — same shape, so the two read as siblings:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, calls, boxId, failNext, setupRunning, probed, probeThrows, serverArgs;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-kill-'));
  calls = [];
  failNext = false;
  probed = [];
  probeThrows = false;
  const run = async (argv) => {
    calls.push(argv);
    if (failNext) { failNext = false; return { code: 1, stdout: '', stderr: "can't find session: web" }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  const boxActions = createBoxActions({ run, runStdin: run, hostKeyPolicy: 'accept-new', controlDir: dir });
  const store = createStore({ dataDir: dir });
  const box = await store.addBox({ label: 'b1', host: '192.168.1.10', user: 'u', sessionName: 'main' });
  boxId = box.id;
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    localShell: 'none', configPath: path.join(dir, 'config.json'),
  };
  const sessions = { open() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const statusChecker = { checkBox: async () => ({ reachable: true }), listSessions: async () => ({ reachable: true, sessions: [] }) };
  setupRunning = false;
  const setupManager = { currentForBox: () => (setupRunning ? { status: 'running' } : null) };
  const statusPoller = {
    getSnapshot: () => ({}),
    probeOne: async (id) => {
      probed.push(id);
      if (probeThrows) throw new Error('probe blew up');
      return { reachable: true };
    },
  };
  serverArgs = { config, store, sessions, statusChecker, statusPoller, boxActions, setupManager };
  app = buildServer(serverArgs);
});

const killUrl = () => '/api/boxes/' + boxId + '/kill';
const remoteOf = (needle) => calls.map((argv) => argv[argv.length - 1]).find((r) => r.includes(needle));

async function headers(target = app) {
  const res = await target.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

// An apostrophe is the shell-quoting hazard worth pinning; spelled by code point
// so the lists below stay on one readable line.
const QUOTE = String.fromCharCode(39);

test('POST kill without a windowId kills the whole session, exact-matched', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(remoteOf('kill-session')).toContain("kill-session -t '=web'");
});

test('POST kill with a windowId kills only that window, session-qualified', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web', windowId: '@7' } });
  expect(res.statusCode).toBe(200);
  expect(remoteOf('kill-window')).toContain("kill-window -t '=web:@7'");
  // The session form must not also have run.
  expect(remoteOf('kill-session')).toBeUndefined();
});

test('POST kill requires a session name even when killing a window', async () => {
  const h = await headers();
  // No fallback to a bare-id target: it is ambiguous under grouped sessions,
  // and this route destroys things.
  for (const session of [undefined, '', 'my session', 'web' + QUOTE, 'web:1', 'web.1', 'a'.repeat(65), 42, null]) {
    const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session, windowId: '@1' } });
    expect(res.statusCode).toBe(400);
  }
  expect(calls.length).toBe(0);
});

test('POST kill rejects anything that is not a tmux window id, without touching ssh', async () => {
  const h = await headers();
  for (const windowId of ['', '7', 'web:1', '@1;rm -rf /', '@1' + QUOTE, '@' + '9'.repeat(10), 42]) {
    const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web', windowId } });
    expect(res.statusCode).toBe(400);
  }
  expect(calls.length).toBe(0);
});

test('POST kill is refused while the box setup job is running', async () => {
  const h = await headers();
  setupRunning = true;
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(409);
  expect(calls.length).toBe(0);
});

test('POST kill 404s on an unknown box', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nope/kill', headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(404);
});

test('POST kill maps a vanished session to 502 carrying the reason', async () => {
  const h = await headers();
  failNext = true;
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toContain("can't find session");
});

test('POST kill requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: killUrl(), payload: { session: 'web' } });
  expect(res.statusCode).toBe(401);
});

test('POST kill re-probes the box so the next /api/status is authoritative', async () => {
  const h = await headers();
  // /api/status serves the poller's 30s cache and the tab re-reads it on its own
  // 30s interval, so without this a killed session lingers in the list for up to
  // a minute — exactly when the operator is looking at it.
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(200);
  expect(probed).toEqual([boxId]);
});

test('POST kill still succeeds when the re-probe throws', async () => {
  const h = await headers();
  probeThrows = true;
  // It is already dead on the box. A failing refresh of our own cache must not
  // be reported as a kill that did not happen.
  const res = await app.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});

test('POST kill works on a deployment with no status poller wired', async () => {
  const noPoller = buildServer({ ...serverArgs, statusPoller: undefined });
  const h = await headers(noPoller);
  const res = await noPoller.inject({ method: 'POST', url: killUrl(), headers: h, payload: { session: 'web' } });
  expect(res.statusCode).toBe(200);
  expect(probed).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/killRoute.test.js`
Expected: FAIL — 404 on every request (route not registered).

- [ ] **Step 3: Implement the route**

In `src/server/server.js`, extend the line-11 import:

```js
import { buildEnsureTmuxRemote, buildEnsureSessionRemote, buildSelectWindowRemote, buildKillSessionRemote, buildKillWindowRemote, resolveTools } from './boxActions.js';
```

Add directly after the `POST /api/boxes/:id/window` route:

```js
  // Kill a tmux SESSION, or one WINDOW inside it, on the box. One route rather
  // than two so the "always session-qualified" rule lives at a single
  // chokepoint: `session` is required in both forms, because a window id is
  // unique per window OBJECT and a grouped session shares those objects, so a
  // bare '@7' names two windows and tmux resolves whichever it finds first.
  //
  // Killing the session the pane is attached to is allowed, deliberately and
  // under one uniform rule: the PTY drops and the attach path's `new-session -A`
  // recreates it empty on reconnect — the same observable outcome as the header's
  // Reconnect cap, which does exactly this to the pane's own session already.
  app.post('/api/boxes/:id/kill', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'box not found' });
    // Same gate as /term, the sizing viewer, and the session-create and
    // window-select routes: a box mid-setup has no environment worth steering,
    // and killing the session setup's own ensureSession-last phase is about to
    // create leaves the box in a state nothing recovers.
    if (setupManager?.currentForBox(box.id)?.status === 'running') {
      return reply.code(409).send({ error: 'box setup is still running' });
    }
    const { session, windowId } = req.body || {};
    if (typeof session !== 'string' || !SESSION_NAME_RE.test(session)) {
      return reply.code(400).send({ error: 'session name is required and must be letters, digits, _ or -' });
    }
    const killWindow = windowId !== undefined && windowId !== null;
    if (killWindow && (typeof windowId !== 'string' || !WINDOW_ID_RE.test(windowId))) {
      return reply.code(400).send({ error: 'window id must look like @7' });
    }
    if (!boxActions?.execCommand) return reply.code(503).send({ error: 'kill unavailable' });
    const remote = killWindow ? buildKillWindowRemote(session, windowId) : buildKillSessionRemote(session);
    const res = await boxActions.execCommand(box, remote, { timeoutMs: 15000 });
    // A session or window that vanished between the poll and the click lands
    // here, as does a session/window pair that does not go together.
    if (!res || res.code !== 0) {
      return reply.code(502).send({ error: String(res?.stderr || '').trim() || 'failed to kill' });
    }
    // Re-probe so the client's next /api/status no longer lists what was just
    // killed. Best-effort in both directions — see the window route above.
    try { await statusPoller?.probeOne?.(box.id); } catch { /* the next sweep will catch up */ }
    return { ok: true };
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/killRoute.test.js
git commit -m "feat(server): POST /api/boxes/:id/kill for tmux sessions and windows"
```

---

### Task 3: Real-tmux integration proof

**Files:**
- Test: `test/sessionKill.integration.test.js` (create)

**Interfaces:**
- Consumes: `buildKillSessionRemote`, `buildKillWindowRemote` (Task 1); `setupLocalBox` from `./helpers/localBox.js`.
- Produces: nothing consumed downstream.

This task exists because the `=` exact-match rule is precisely the kind of claim a fake `sshStream` certifies while it is broken. This repo has been burned by that twice. The remote also runs under the box's **login shell** (zsh on the fixture), not the `sh` the unit tests imply.

- [ ] **Step 1: Write the failing test**

Create `test/sessionKill.integration.test.js`:

```js
import { test, expect, afterEach } from 'vitest';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun } from '../src/server/sshRun.js';
import {
  createBoxActions,
  buildEnsureSessionRemote,
  buildKillSessionRemote,
  buildKillWindowRemote,
} from '../src/server/boxActions.js';

// The kill remotes run over real ssh against the isolated sshd/tmux fixture,
// under the box's login shell. The '=' exact-match rule is the whole point of
// this file: a fake transport would report these green while a bare -t target
// silently killed the wrong session.

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

async function harness() {
  const lb = await setupLocalBox();
  teardown = lb.cleanup;
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: lb.session };
  const boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    sshConfigFile: lb.sshConfigFile,
  });
  return { box, boxActions };
}

const listSessions = (boxActions, box) =>
  boxActions.execCommand(box, "tmux list-sessions -F '#{session_name}'", { timeoutMs: 12000 });

test('killing a session leaves a longer-named neighbour alone (exact-match guard)', async () => {
  // THE test. A bare `kill-session -t web` prefix-matches when no exact 'web'
  // exists — and even when it does exist, this asserts the neighbour survives.
  // Getting this wrong destroys a stranger's session with no way back.
  const { box, boxActions } = await harness();
  expect((await boxActions.execCommand(box, buildEnsureSessionRemote('web', null), { timeoutMs: 20000 })).code).toBe(0);
  expect((await boxActions.execCommand(box, buildEnsureSessionRemote('web2', null), { timeoutMs: 20000 })).code).toBe(0);

  const killed = await boxActions.execCommand(box, buildKillSessionRemote('web'), { timeoutMs: 15000 });
  expect(killed.code).toBe(0);

  const ls = await listSessions(boxActions, box);
  expect(ls.stdout).toContain('web2');
  expect(ls.stdout.split(/\r?\n/).map((s) => s.trim())).not.toContain('web');
});

test('killing a window removes only that window and leaves the session running', async () => {
  const { box, boxActions } = await harness();
  expect((await boxActions.execCommand(box, buildEnsureSessionRemote('multi', null), { timeoutMs: 20000 })).code).toBe(0);
  await boxActions.execCommand(box, "tmux new-window -t '=multi' -n second", { timeoutMs: 12000 });

  const before = await boxActions.execCommand(box, "tmux list-windows -t '=multi' -F '#{window_id} #{window_name}'", { timeoutMs: 12000 });
  const secondId = before.stdout.split(/\r?\n/).find((l) => l.includes('second'))?.split(' ')[0];
  expect(secondId).toMatch(/^@\d+$/);

  const killed = await boxActions.execCommand(box, buildKillWindowRemote('multi', secondId), { timeoutMs: 15000 });
  expect(killed.code).toBe(0);

  const after = await boxActions.execCommand(box, "tmux list-windows -t '=multi' -F '#{window_name}'", { timeoutMs: 12000 });
  expect(after.stdout).not.toContain('second');
  expect((await listSessions(boxActions, box)).stdout).toContain('multi');
});

test('killing a session that does not exist reports failure rather than silent success', async () => {
  // buildKillTmuxRemote ends in `|| true` and would pass this while doing
  // nothing. The route turns this non-zero exit into a 502.
  const { box, boxActions } = await harness();
  const res = await boxActions.execCommand(box, buildKillSessionRemote('never-existed'), { timeoutMs: 15000 });
  expect(res.code).not.toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails for the right reason**

Run: `npx vitest run test/sessionKill.integration.test.js`
Expected: PASS if Tasks 1-2 are done correctly. If `sshd` is missing the helper fails loudly — that is deliberate, not a reason to skip. If the exact-match test fails, the builder is wrong, not the test.

- [ ] **Step 3: Commit**

```bash
git add test/sessionKill.integration.test.js
git commit -m "test(server): real-tmux proof that kill targets exact sessions and windows"
```

---

### Task 4: `phone` flag drops the header's session control

**Files:**
- Modify: `src/web/paneHeader.ts` (`PaneHeaderInput` ~line 12-22, `paneHeaderModel` ~line 62-77)
- Modify: `src/web/main.ts` (`paneHeaderModelFor`, line 847-863)
- Test: `test/paneHeader.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PaneHeaderInput.phone?: boolean`. When true, `paneHeaderModel(...).targets === null`.

- [ ] **Step 1: Write the failing test**

Append to `test/paneHeader.test.js`:

```js
test('phone mode renders no session control at all', () => {
  // The header row is the most contested real estate in the app, and the
  // operator's phone use is the Android app rather than the browser under
  // 720px. Dropping it also means the picker popup never has to open into a
  // 344px viewport (the Z Fold 6 cover screen).
  const withTargets = paneHeaderModel(box({ sessionName: 'web' }));
  expect(withTargets.targets).not.toBeNull();
  expect(paneHeaderModel(box({ sessionName: 'web', phone: true })).targets).toBeNull();
});

test('phone mode changes nothing else about the header', () => {
  const desktop = paneHeaderModel(box({ sessionName: 'web', conn: { kind: 'open' } }));
  const phone = paneHeaderModel(box({ sessionName: 'web', conn: { kind: 'open' }, phone: true }));
  expect(phone.title).toBe(desktop.title);
  expect(phone.target).toBe(desktop.target);
  expect(phone.dotClass).toBe(desktop.dotClass);
  expect(phone.chip).toEqual(desktop.chip);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/paneHeader.test.js`
Expected: FAIL — `expected {…} to be null`.

- [ ] **Step 3: Implement the flag**

In `src/web/paneHeader.ts`, add to `PaneHeaderInput`:

```ts
  sessionName?: string;
  // Phone mode (≤720px). The session picker is dropped entirely there: the
  // header row is the most contested space in the app, and sessions are
  // managed from the Edit Box modal off the box list instead.
  phone?: boolean;
```

And in `paneHeaderModel`, change the `targets` line:

```ts
    targets: !i.local && !i.phone && i.state === 'terminal' ? sessionTargetList(i.status, i.sessionName) : null,
```

In `src/web/main.ts`, `paneHeaderModelFor` (line 847), add to the object passed to `paneHeaderModel`:

```ts
    sessionName: box?.sessionName,
    // phoneCtl is created in start(); before that there is no stage to paint,
    // so the `?? false` is a boot-order guard, not a default policy.
    phone: phoneCtl?.matches() ?? false,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/paneHeader.ts src/web/main.ts test/paneHeader.test.js
git commit -m "feat(ui): drop the pane header's session control in phone mode"
```

---

### Task 5: `sessionPicker.ts` — the pure half

**Files:**
- Create: `src/web/sessionPicker.ts`
- Test: `test/sessionPicker.test.js` (create)

**Interfaces:**
- Consumes: `SessionTarget` from `./paneHeader`.
- Produces:
  - `isSoleWindow(targets: SessionTarget[], t: SessionTarget): boolean`
  - `killLegend(t: SessionTarget, sole: boolean): string`
  - `rowKey(t: SessionTarget): string`

vitest has no DOM, so this task builds and tests only the pure half. The DOM layer is Task 6, covered by Playwright.

- [ ] **Step 1: Write the failing tests**

Create `test/sessionPicker.test.js`:

```js
import { test, expect } from 'vitest';
import { isSoleWindow, killLegend, rowKey } from '../src/web/sessionPicker.ts';

const s = (name) => ({ kind: 'session', value: `s:${name}`, label: name, session: name });
const w = (name, id, label) => ({ kind: 'window', value: `w:${name}:${id}`, label, session: name, windowId: id });

test('a session with one window: that window is the sole one', () => {
  const rows = [s('web'), w('web', '@1', '1: zsh'), s('other'), w('other', '@2', '1: bash'), w('other', '@3', '2: vim')];
  expect(isSoleWindow(rows, rows[1])).toBe(true);
  expect(isSoleWindow(rows, rows[3])).toBe(false);
  expect(isSoleWindow(rows, rows[4])).toBe(false);
});

test('a session row is never a sole window', () => {
  const rows = [s('web'), w('web', '@1', '1: zsh')];
  expect(isSoleWindow(rows, rows[0])).toBe(false);
});

test('the legend for a sole window says the session goes with it', () => {
  // tmux destroys a session when its last window goes. Not special-cased — but
  // not allowed to be a surprise either.
  const sole = w('web', '@1', '1: zsh');
  expect(killLegend(sole, true)).toMatch(/session/i);
  expect(killLegend(sole, false)).not.toMatch(/session/i);
});

test('the legend names what is about to die', () => {
  expect(killLegend(s('web'), false)).toContain('web');
  expect(killLegend(w('web', '@2', '2: claude'), false)).toContain('2: claude');
});

test('rowKey carries the session, so an armed row cannot migrate to another', () => {
  // A grouped session shares window objects, so '@7' alone appears under two
  // session names. Keying an arm by id alone would let a poll move the arm onto
  // a different session's row — and then fire on it.
  expect(rowKey(w('web', '@7', '1: zsh'))).not.toBe(rowKey(w('webclone', '@7', '1: zsh')));
  expect(rowKey(s('web'))).not.toBe(rowKey(w('web', '@7', '1: zsh')));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/sessionPicker.test.js`
Expected: FAIL — cannot resolve `../src/web/sessionPicker.ts`.

- [ ] **Step 3: Write the pure half**

Create `src/web/sessionPicker.ts`:

```ts
// The session/window picker: a trigger button plus an anchored popup whose rows
// each carry a kill ×. Replaces the native <select> both surfaces used, which
// could not host a per-row control — an <option> takes no markup, no click
// handler and no styling.
//
// Split like paneHeader.ts and stagePanes.ts: the pure half below is
// unit-tested, the DOM half is covered by Playwright (vitest runs
// environment: 'node' with no jsdom).
import type { SessionTarget, SessionTargetList } from './paneHeader';

// tmux destroys a session when its last window is killed. This does not
// special-case that — it just refuses to let it be a surprise, by letting the
// arm legend say so.
export function isSoleWindow(targets: SessionTarget[], t: SessionTarget): boolean {
  if (t.kind !== 'window') return false;
  return targets.filter((x) => x.kind === 'window' && x.session === t.session).length === 1;
}

// What the armed × states before the second click commits. The row's own label
// carries the indent used to draw the tree; strip it so the sentence reads.
export function killLegend(t: SessionTarget, sole: boolean): string {
  const name = t.label.replace(/^[\s ]*→[\s ]*/, '').trim();
  if (t.kind === 'session') return `kill session ${name}?`;
  return sole ? `kill ${name}? last window — the session goes too` : `kill ${name}?`;
}

// The identity an arm is held against. SessionTarget.value already carries the
// session for exactly this class of reason: a grouped session shares its window
// objects, so '@7' alone names two rows, and an arm keyed by id could migrate
// onto a different session between the arming click and the firing one.
export function rowKey(t: SessionTarget): string {
  return t.value;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/sessionPicker.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/sessionPicker.ts test/sessionPicker.test.js
git commit -m "feat(ui): pure half of the session picker (sole-window, legend, row key)"
```

---

### Task 6: `sessionPicker.ts` — the DOM half

**Files:**
- Modify: `src/web/sessionPicker.ts`
- Modify: `src/web/style.css` (beside `.pane-header .pane-session`, line 1031-1041)

**Interfaces:**
- Consumes: `isSoleWindow`, `killLegend`, `rowKey` (Task 5); `armReduce`, `IDLE`, `ARM_MS`, `type ArmState` from `./arming`; `SessionTargetList`, `SessionTarget` from `./paneHeader`.
- Produces:

```ts
export interface SessionPickerDeps {
  onSelect: (t: SessionTarget) => void;
  onKill: (t: SessionTarget) => Promise<void>;
  onWillOpen?: (opts?: { waitMs?: number }) => Promise<void>;
  canKill?: (t: SessionTarget) => boolean;
  className?: string;
}
export interface SessionPicker {
  el: HTMLElement;
  update(list: SessionTargetList | null): void;
  close(): void;
}
export function buildSessionPicker(deps: SessionPickerDeps): SessionPicker;
export const OPEN_REFRESH_WAIT_MS = 700;
```

- [ ] **Step 1: Append the DOM layer**

Add to `src/web/sessionPicker.ts`:

```ts
// Add to the imports already at the top of the file (SessionTargetList is
// already imported alongside SessionTarget from Task 5):
import { armReduce, IDLE, ARM_MS, type ArmState } from './arming';

// How long the open path waits for a fresh probe before showing the list it
// already has. Long enough for a healthy box over the ControlMaster, short
// enough that a box that has gone away is a slightly-late list, not a dead click.
export const OPEN_REFRESH_WAIT_MS = 700;

export interface SessionPickerDeps {
  onSelect: (t: SessionTarget) => void;
  // Rejects on failure. The row is NOT removed optimistically: the list is a
  // report of what is on the box, not a wish.
  onKill: (t: SessionTarget) => Promise<void>;
  onWillOpen?: (opts?: { waitMs?: number }) => Promise<void>;
  // Whether a row may be killed at all. Defaults to true. The Edit Box modal
  // uses it to exempt its synthetic Create New Session… row, which names no
  // session on the box and so has nothing to kill.
  canKill?: (t: SessionTarget) => boolean;
  className?: string;
}

export interface SessionPicker {
  el: HTMLElement;
  update(list: SessionTargetList | null): void;
  close(): void;
}

export function buildSessionPicker(deps: SessionPickerDeps): SessionPicker {
  const el = document.createElement('div');
  el.className = `session-picker${deps.className ? ' ' + deps.className : ''}`;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'session-picker-trigger';
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.title = 'Active tmux session and window';
  trigger.setAttribute('aria-label', 'Active tmux session and window');

  const pop = document.createElement('div');
  pop.className = 'session-picker-pop';
  pop.hidden = true;
  const list = document.createElement('ul');
  list.className = 'session-picker-list';
  pop.append(list);

  el.append(trigger, pop);

  let rows: SessionTarget[] = [];
  let current: SessionTargetList | null = null;
  let open = false;
  let arm: ArmState = IDLE;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingList: SessionTargetList | null | undefined;

  // Rows are never rebuilt while a row is armed. A status poll landing between
  // the arming click and the committing one could otherwise reorder or re-key
  // the list and migrate the arm onto a different session — the arm-then-fire
  // equivalent of the stale-index bug that made this codebase address windows
  // by @id instead of index. A refresh that arrives meanwhile is held here and
  // applied when the arm clears.
  function disarm() {
    clearTimeout(armTimer);
    arm = IDLE;
    if (pendingList !== undefined) { const held = pendingList; pendingList = undefined; update(held); return; }
    render();
  }

  function fire(t: SessionTarget) {
    disarm();
    void deps.onKill(t).catch(() => { /* the surface reports; the row stays */ });
  }

  function clickKill(t: SessionTarget) {
    const { state, fire: id } = armReduce(arm, { type: 'click', id: rowKey(t), armable: true });
    clearTimeout(armTimer);
    arm = state;
    if (id) { fire(t); return; }
    armTimer = setTimeout(disarm, ARM_MS);
    render();
  }

  function render() {
    const opts = current?.options ?? [];
    rows = opts;
    trigger.textContent = (opts.find((t) => t.value === current?.value)?.label ?? '').replace(/^[\s ]*→[\s ]*/, '').trim() || '—';
    list.replaceChildren(...opts.map((t) => {
      const li = document.createElement('li');
      li.className = 'session-picker-row';
      li.dataset.key = rowKey(t);

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'session-picker-pick';
      pick.textContent = t.label;
      pick.tabIndex = -1;
      if (t.value === current?.value) { pick.setAttribute('aria-current', 'true'); li.classList.add('current'); }
      // A live session name outside SESSION_NAME_RE cannot round-trip a switch
      // (store.js's sanitizeSession would rewrite the PATCHed name). Offered
      // disabled rather than hidden — the session is real, only unswitchable.
      if (t.disabled) { pick.disabled = true; if (t.title) pick.title = t.title; }
      pick.addEventListener('click', () => { closePop(); deps.onSelect(t); });

      // A row the caller exempts renders with no × at all, rather than a
      // disabled one: there is nothing on the box for it to name.
      if (deps.canKill && !deps.canKill(t)) { li.append(pick); return li; }

      const kill = document.createElement('button');
      kill.type = 'button';
      kill.className = 'session-picker-kill';
      kill.tabIndex = -1;
      const armed = arm.armed === rowKey(t);
      // The × stays enabled on a disabled row: an unswitchable NAME is about
      // PATCH round-tripping, which the kill path does not do at all.
      if (armed) {
        kill.classList.add('armed');
        kill.textContent = killLegend(t, isSoleWindow(opts, t));
      } else {
        kill.textContent = '×';
        kill.title = killLegend(t, isSoleWindow(opts, t));
      }
      kill.setAttribute('aria-label', killLegend(t, isSoleWindow(opts, t)));
      kill.addEventListener('click', (e) => { e.stopPropagation(); clickKill(t); });

      li.append(pick, kill);
      return li;
    }));
  }

  function focusables(): HTMLButtonElement[] {
    return Array.from(list.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
  }

  function openPop() {
    if (open) return;
    open = true;
    pop.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    // Unlike the native <select> this replaces, the popup can be repopulated
    // while it is open — so it opens IMMEDIATELY and the probe lands
    // underneath. That retires the showPicker()/preventDefault dance and the
    // focused-select guard the old control needed.
    void deps.onWillOpen?.({ waitMs: OPEN_REFRESH_WAIT_MS });
    const first = list.querySelector<HTMLButtonElement>('.current .session-picker-pick') ?? focusables()[0];
    first?.focus();
  }

  function closePop(focusTrigger = true) {
    if (!open) return;
    open = false;
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    disarm();
    if (focusTrigger) trigger.focus();
  }

  trigger.addEventListener('click', (e) => { e.stopPropagation(); if (open) closePop(); else openPop(); });
  // Mouse-only prefetch: by the time the click lands the list is already
  // current. A finger never sends this, which is why openPop() probes too.
  trigger.addEventListener('pointerenter', (e) => {
    if ((e as PointerEvent).pointerType === 'mouse') void deps.onWillOpen?.();
  });

  pop.addEventListener('keydown', (e) => {
    const keys = focusables();
    const at = keys.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.stopPropagation(); closePop(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rowPicks = Array.from(list.querySelectorAll<HTMLButtonElement>('.session-picker-pick:not([disabled])'));
      const here = rowPicks.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = here < 0 ? 0 : (here + step + rowPicks.length) % rowPicks.length;
      rowPicks[next]?.focus();
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const rowPicks = Array.from(list.querySelectorAll<HTMLButtonElement>('.session-picker-pick:not([disabled])'));
      (e.key === 'Home' ? rowPicks[0] : rowPicks[rowPicks.length - 1])?.focus();
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      keys[Math.min(Math.max(at + step, 0), keys.length - 1)]?.focus();
    }
  });

  // Any click outside closes, which also disarms — the arm-then-fire contract
  // says everything that is not the second click disarms.
  const onDoc = (e: MouseEvent) => { if (open && !el.contains(e.target as Node)) closePop(false); };
  document.addEventListener('click', onDoc);

  const update = (l: SessionTargetList | null) => {
    if (arm.armed) { pendingList = l; return; }
    current = l;
    el.hidden = !l || l.options.length === 0;
    render();
  };

  update(null);
  return { el, update, close: () => closePop(false) };
}
```

- [ ] **Step 2: Add the styles**

In `src/web/style.css`, after the `.pane-header .pane-session` block (line ~1041), add. Colours are existing tokens only — per `DESIGN.md`, a theme may override tokens and nothing here may be a literal:

```css
/* Session picker: replaces the native <select>, which could not host a per-row
   kill. The trigger keeps the old control's exact metrics so the header row
   does not reflow. */
.session-picker { position: relative; display: inline-flex; min-width: 0; }
.session-picker[hidden] { display: none; }
.pane-header .session-picker-trigger {
  flex: 0 1 auto; min-width: 0; max-width: 18ch;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--face); font-size: 11px; padding: 1px 4px;
  text-transform: none; letter-spacing: normal;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--panel-2); color: var(--muted);
  cursor: pointer; opacity: 0.75;
}
.pane-header .session-picker-trigger:hover,
.pane-header .session-picker-trigger:focus-visible { opacity: 1; color: var(--text); }
.session-picker-pop {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 40;
  min-width: 200px; max-width: 340px; max-height: 60vh; overflow-y: auto;
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  box-shadow: var(--raise, 0 6px 18px rgb(0 0 0 / 0.35));
}
.session-picker-list { list-style: none; margin: 0; padding: 4px; }
.session-picker-row { display: flex; align-items: center; gap: 4px; }
.session-picker-pick {
  flex: 1 1 auto; min-width: 0; text-align: left;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--face); font-size: 12px; padding: 5px 6px;
  background: none; border: 0; border-radius: 4px; color: var(--text); cursor: pointer;
}
.session-picker-pick:hover, .session-picker-pick:focus-visible { background: var(--panel-2); }
.session-picker-pick[disabled] { color: var(--dim); cursor: not-allowed; }
.session-picker-row.current .session-picker-pick { color: var(--accent); }
.session-picker-kill {
  flex: 0 0 auto; font-family: var(--face); font-size: 12px; line-height: 1;
  padding: 4px 6px; background: none; border: 0; border-radius: 4px;
  color: var(--dim); cursor: pointer;
}
.session-picker-kill:hover, .session-picker-kill:focus-visible { color: var(--bad); background: var(--panel-2); }
.session-picker-kill.armed {
  color: var(--bad); border: 1px solid var(--bad);
  font-size: 10px; padding: 3px 5px; white-space: nowrap;
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS. If `--raise` or `--bad` do not exist as tokens, substitute the nearest token that does — check `:root` in `style.css`; do NOT introduce a colour literal.

- [ ] **Step 4: Commit**

```bash
git add src/web/sessionPicker.ts src/web/style.css
git commit -m "feat(ui): session picker popup with per-row kill"
```

---

### Task 7: Adopt the picker in the pane header

**Files:**
- Modify: `src/web/paneHeader.ts` (`PaneHeaderActions` ~line 152-180, `buildPaneHeader` ~line 190-270)
- Modify: `src/web/api.ts` (beside `selectWindow`, ~line 286-288)
- Modify: `src/web/main.ts` (`selectTarget` ~line 894, `paneHooks().headerFor` ~line 940-950)

**Interfaces:**
- Consumes: `buildSessionPicker` (Task 6); `phone` flag (Task 4); `POST /api/boxes/:id/kill` (Task 2).
- Produces:
  - `api.killTarget(id: string, session: string, windowId?: string): Promise<{ ok: boolean }>`
  - `PaneHeaderActions.onKillTarget?: (t: SessionTarget) => Promise<void>`

- [ ] **Step 1: Add the API method**

In `src/web/api.ts`, directly after `selectWindow`:

```ts
  // Kill a tmux session, or one window inside it, on the box. The session is
  // required in both forms — a grouped session shares its window objects, so an
  // id alone does not name one session (see buildKillWindowRemote). Nothing is
  // removed client-side on the strength of this: the caller re-probes, because
  // the list is a report of the box rather than a wish.
  async killTarget(id: string, session: string, windowId?: string) {
    const body: { session: string; windowId?: string } = { session };
    if (windowId) body.windowId = windowId;
    return j<{ ok: boolean }>(await fetch(`/api/boxes/${id}/kill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  },
```

- [ ] **Step 2: Swap the `<select>` for the picker in `buildPaneHeader`**

In `src/web/paneHeader.ts`: add the import, add the action, and replace the whole `if (actions.onSelectTarget) { … }` block (which builds `sessionSel` and its five listeners) plus the `if (sessionSel) { … }` block inside `update()`.

Add at the top:

```ts
import { buildSessionPicker, type SessionPicker } from './sessionPicker';
```

Add to `PaneHeaderActions`:

```ts
  // Kill the row's session or window on the box. Destructive, so the widget
  // arms it — unlike onSelectTarget, which is a plain callback because a switch
  // costs nothing. Rejecting leaves the row in place.
  onKillTarget?: (t: SessionTarget) => Promise<void>;
```

Replace the `sessionSel` construction with:

```ts
  // The picker sits with the identity: which session this pane shows is part of
  // what the pane IS, not an action on it. Built only when the caller can act on
  // a pick. It replaced a native <select>, whose <option> could not host the
  // per-row kill — and with it went the showPicker()/preventDefault dance and
  // the focused-select repopulation guard, both of which existed only because a
  // native picker can be refreshed solely BEFORE it opens.
  let picker: SessionPicker | null = null;
  if (actions.onSelectTarget) {
    picker = buildSessionPicker({
      onSelect: (t) => actions.onSelectTarget!(t),
      onKill: async (t) => { await actions.onKillTarget?.(t); },
      onWillOpen: (opts) => actions.onWillOpenTarget?.(opts) ?? Promise.resolve(),
      className: 'pane-session',
    });
    picker.el.addEventListener('click', (e) => e.stopPropagation());
  }
```

Change the `identity.append(...)` line to use `picker`:

```ts
  identity.append(dot, title, target, ...(picker ? [picker.el] : []), lifecycleSlot);
```

And replace the `if (sessionSel) { … }` block inside `update()` with:

```ts
    // The widget holds its own armed-row invariant, so this can be called on
    // every poll without a focus guard of any kind.
    picker?.update(m.targets);
```

Delete `OPEN_REFRESH_WAIT_MS` from `paneHeader.ts` (it now lives in `sessionPicker.ts`) and the now-unused `rendered` variable.

- [ ] **Step 3: Wire the kill in `main.ts`**

In `src/web/main.ts`, add above `selectTarget` (line ~894):

```ts
// Kill a session or window from the pane header's picker. Nothing is removed
// locally on the strength of the call — the route re-probes the box before it
// answers, so ONE poll afterwards is authoritative. Killing the session this
// pane is attached to is allowed under the same uniform rule as every other
// row: the PTY drops and the attach path's `new-session -A` recreates it empty,
// which is what the Reconnect cap already does to this very session.
async function killTarget(id: string, t: SessionTarget) {
  await api.killTarget(id, t.session, t.kind === 'window' ? t.windowId : undefined);
  await pollStatus();
}
```

In `paneHooks().headerFor`, add to the `model.targets` spread block, beside `onSelectTarget`:

```ts
          onKillTarget: (t: SessionTarget) => killTarget(id, t),
```

- [ ] **Step 4: Verify it compiles and the suite is green**

Run: `npm test && npm run typecheck`
Expected: PASS. `test/paneHeader.test.js` exercises the pure model only, so it is unaffected; if a test references `OPEN_REFRESH_WAIT_MS` from `paneHeader.ts`, re-point the import at `sessionPicker.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/web/paneHeader.ts src/web/api.ts src/web/main.ts
git commit -m "feat(ui): pane header adopts the session picker with per-row kill"
```

---

### Task 8: Adopt the picker in the Edit Box modal

**Files:**
- Modify: `src/web/main.ts` (`openBoxDialog`, lines ~2253-2480)

**Interfaces:**
- Consumes: `buildSessionPicker` (Task 6), `api.killTarget` (Task 7).
- Produces: nothing consumed downstream.

The modal's existing state machine is preserved and re-pointed, not rewritten. Keep `lastPick`, `windowPending`, `sessionFieldValue()` and `probeAndApply()` exactly as they are — they encode why a window pick commits only after the server confirms it.

- [ ] **Step 1: Replace the select with the picker**

In `openBoxDialog`, replace the `sessionSelect` element construction with:

```ts
  // The same widget the pane header uses, so a session behaves identically
  // wherever it is met. Create New Session… stays a row in the list — and
  // `customRow`, the text field it reveals, stays OUTSIDE the picker exactly
  // where it sits today. Putting that field inside the popup would hide it the
  // moment picking the row closed the popup, which is the one thing it must not
  // do while the operator is typing into it.
  const CUSTOM = '__custom__';
  let targets: SessionTarget[] = [];
  let lastPick = '';
  let windowPending = false;
  let picked = '';
  const picker = buildSessionPicker({
    className: 'session-select',
    // The Create row names no session on the box, so it gets no ×.
    canKill: (t) => t.value !== CUSTOM,
    onSelect: (t) => { picked = t.value; onPick(t); },
    onKill: async (t) => {
      if (!isEdit) return;
      sessionHint.className = 'session-hint';
      sessionHint.textContent = `killing ${t.label.trim()}…`;
      try {
        await api.killTarget(box!.id, t.session, t.kind === 'window' ? t.windowId : undefined);
        // Clear a selection that just stopped existing, so Save cannot persist
        // a session name the box no longer has.
        if (picked === t.value) { picked = ''; lastPick = ''; }
        await probeAndApply();
      } catch (e: any) {
        sessionHint.textContent = e?.message || 'kill failed';
        sessionHint.className = 'session-hint err';
      }
    },
  });
```

`customRow` keeps its current declaration site and its current position in `sessionWrap` — nothing about it moves.

- [ ] **Step 2: Re-point the change handler**

The existing `sessionSelect.addEventListener('change', …)` body becomes a named function the picker calls. Replace the listener with:

```ts
  function onPick(t: SessionTarget) {
    syncCustom();
    // A window pick acts immediately, exactly as it does in the pane header —
    // it is a live tmux action, not form state, and nothing about it is saved.
    // The session half still rides Save like every other field.
    if (isEdit && t.kind === 'window' && t.windowId) {
      const label = t.label.startsWith(WINDOW_INDENT) ? t.label.slice(WINDOW_INDENT.length) : t.label.trim();
      const elsewhere = (box!.sessionName || 'web') !== t.session;
      sessionHint.className = 'session-hint';
      sessionHint.textContent = `switching to ${label}…`;
      windowPending = true;
      api.selectWindow(box!.id, t.session, t.windowId)
        .then(() => {
          windowPending = false;
          lastPick = t.value;
          sessionHint.textContent = elsewhere ? `will show ${label} — Save to switch session` : `showing ${label}`;
        })
        .catch((e: any) => {
          windowPending = false;
          // Snap back to the last selection Save is allowed to see: a failed
          // live switch must not leave Save showing a change that never happened.
          picked = lastPick;
          applySessions(latestStatus[box!.id]);
          syncCustom();
          sessionHint.textContent = e?.message || 'window switch failed';
          sessionHint.className = 'session-hint err';
        });
    } else {
      lastPick = t.value;
    }
  }
```

- [ ] **Step 3: Re-point `applySessions`, `sessionFieldValue` and `syncCustom`**

```ts
  function applySessions(status: Status | undefined) {
    // The old focused-select guard is gone: the widget holds its own
    // armed-row invariant, and a popup we own can be repopulated while open.
    targets = sessionTargets(status, sessionInput.value.trim() || (isEdit ? box!.sessionName : '') || 'web');
    // The synthetic Create row, carried in the list exactly as the <option>
    // was, so `picked === CUSTOM` still drives syncCustom() unchanged. It is
    // exempted from the kill by canKill above.
    const rows: SessionTarget[] = [
      ...targets,
      { kind: 'session', value: CUSTOM, label: 'Create New Session…', session: '' },
    ];
    if (!picked) picked = targets.find((t) => t.session === (isEdit ? box!.sessionName : ''))?.value ?? targets[0]?.value ?? '';
    picker.update({ options: rows, value: picked });
  }

  function syncCustom() {
    customRow.hidden = picked !== CUSTOM;
  }

  function sessionFieldValue(): string {
    if (picked === CUSTOM) return sessionInput.value.trim() || 'web';
    return targets.find((t) => t.value === picked)?.session || 'web';
  }
```

Replace `sessionRow.append(sessionSelect, sessionRefresh)` with `sessionRow.append(picker.el, sessionRefresh)`. The `sessionWrap.append(sessionSpan, sessionRow, customRow, sessionHint)` line is unchanged — `customRow` stays below the control, where it can keep its field visible while the popup is shut.

In `createSessionNow()`, replace the post-create selection lines:

```ts
        await probeAndApply();
        if (targets.some((t) => t.value === `s:${name}`)) { picked = `s:${name}`; lastPick = picked; applySessions(latestStatus[boxId]); syncCustom(); }
```

Register the picker with the modal teardown so a logout closes its popup: add `picker.close()` wherever the dialog's existing close path runs (`modalRegistry.ts` already receives this modal's `close()`).

- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck`
Expected: PASS. Any test referencing `.session-select` as a `<select>` must be re-pointed — the class now sits on the picker wrapper.

- [ ] **Step 5: Commit**

```bash
git add src/web/main.ts
git commit -m "feat(ui): Edit Box modal adopts the session picker with per-row kill"
```

---

### Task 9: End-to-end coverage

**Files:**
- Modify: `test/e2e/sessionDropdown.spec.ts`
- Modify: `test/e2e/phone.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed downstream.

This is the only level at which the widget can be tested: vitest has no DOM.

- [ ] **Step 1: Re-point the existing dropdown spec at the new control**

In `test/e2e/sessionDropdown.spec.ts`, the existing test drives a native `<select>`. Replace its control interactions:

```ts
  const picker = pane.locator('.session-picker');
  const trigger = picker.locator('.session-picker-trigger');
  await expect(trigger).toBeVisible();

  // …create the window as before, then:
  const probed = page.waitForRequest(
    (r) => /\/api\/boxes\/[^/]+\/probe$/.test(r.url()) && r.method() === 'POST',
    { timeout: 10000 },
  );
  await trigger.hover();
  await probed;
  await trigger.click();

  await expect(picker.locator('.session-picker-pick', { hasText: 'e2ewin' })).toHaveCount(1, { timeout: 5000 });
  // The header still answers "which window am I looking at": tmux makes a new
  // window active, so the current row must have followed it there.
  await expect(picker.locator('.session-picker-row.current .session-picker-pick')).toContainText('e2ewin');
```

- [ ] **Step 2: Add the kill tests**

Append to `test/e2e/sessionDropdown.spec.ts`:

```ts
test('one click on × does not kill — arm-then-fire holds', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  // A throwaway session, so the fixture's shared one survives for later specs
  // (the suite runs workers: 1 against a single tmux server).
  await pane.click();
  await page.keyboard.type('tmux new-session -d -s e2ekill');
  await page.keyboard.press('Enter');

  const picker = pane.locator('.session-picker');
  await picker.locator('.session-picker-trigger').click();
  const row = picker.locator('.session-picker-row', { hasText: 'e2ekill' });
  await expect(row).toHaveCount(1, { timeout: 10000 });

  // First click ARMS. The row must still be there, and the cap must now state
  // its consequence rather than showing a bare ×.
  await row.locator('.session-picker-kill').click();
  await expect(row.locator('.session-picker-kill.armed')).toHaveText(/kill/i);
  await expect(row).toHaveCount(1);

  // Second click commits.
  await row.locator('.session-picker-kill').click();
  await expect(picker.locator('.session-picker-row', { hasText: 'e2ekill' })).toHaveCount(0, { timeout: 15000 });
});

test('killing a window removes it and leaves the session', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  await pane.click();
  await page.keyboard.type('tmux new-window -n e2ekillwin');
  await page.keyboard.press('Enter');
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  const picker = pane.locator('.session-picker');
  await picker.locator('.session-picker-trigger').click();
  const row = picker.locator('.session-picker-row', { hasText: 'e2ekillwin' });
  await expect(row).toHaveCount(1, { timeout: 10000 });
  await row.locator('.session-picker-kill').click();
  await row.locator('.session-picker-kill').click();

  await expect(picker.locator('.session-picker-row', { hasText: 'e2ekillwin' })).toHaveCount(0, { timeout: 15000 });
  // The session itself survived — only the window went.
  await expect(picker.locator('.session-picker-row')).not.toHaveCount(0);
});
```

- [ ] **Step 3: Add the phone assertion**

Append to `test/e2e/phone.spec.ts`:

```ts
test('phone mode gives the pane header no session control', async ({ page }) => {
  await login(page);
  await openLocalhost(page);
  // The header row is the most contested space on a phone, and sessions are
  // managed from the Edit Box modal off the box list instead.
  await expect(page.locator('.stage-pane .session-picker')).toHaveCount(0);
});
```

- [ ] **Step 4: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS. Playwright serves a built bundle, so if the spec harness requires it, build inside the test's own working copy — **never** `npm run build` in a repo whose `dist/` the live service is serving.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/sessionDropdown.spec.ts test/e2e/phone.spec.ts
git commit -m "test(e2e): session picker kill, arm-then-fire, and no phone control"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md` (the `server.js`, `boxActions.js` and `src/web/` entries)
- Modify: `AGENTS.md` (kept in sync with CLAUDE.md)
- Modify: `docs/terminal.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

These files are living documentation, maintained alongside the code — a feature change updates them in the same series, unlike the point-in-time spec.

- [ ] **Step 1: Document the route and builders**

In `CLAUDE.md`'s `server.js` entry, after the `POST /api/boxes/:id/probe` paragraph, add a paragraph covering: `POST /api/boxes/:id/kill` with `{ session, windowId? }`; that the session is required in both forms because a grouped session shares window objects; the 409-while-setup gate it shares with `/term`, the create route and the window route; the best-effort `probeOne`; and that killing the attached session is deliberately allowed under one uniform rule because `new-session -A` recreates it, which is what Reconnect already does.

In the `boxActions.js` entry, note `buildKillSessionRemote`/`buildKillWindowRemote` and — the part worth writing down — that they are **not** a widening of `buildKillTmuxRemote`, which sanitizes and `|| true`s because best-effort teardown on box removal must not be blocked by an unreachable host.

- [ ] **Step 2: Document the widget**

In `CLAUDE.md`'s `src/web/` paragraph, add `sessionPicker.ts` beside `paneHeader.ts`, covering: it replaced a native `<select>` that could not host a per-row control; the pure half (`isSoleWindow`/`killLegend`/`rowKey`) versus the DOM half; the armed-row invariant that replaced the focused-select guard, and why an arm is keyed by `SessionTarget.value` rather than window id; that `showPicker()`/`preventDefault` are gone because a popup we own can be repopulated while open; and that the picker is absent entirely in phone mode.

Amend the `paneHeader.ts` paragraph: the `<select>`-specific machinery it describes (the focused-select guard, the `pointerdown`/`showPicker` path, `OPEN_REFRESH_WAIT_MS`) has moved or been retired — leaving that text in place would send the next reader looking for code that is gone.

- [ ] **Step 3: Mirror into AGENTS.md and the user guide**

Apply the same edits to `AGENTS.md`. In `docs/terminal.md`, add a short user-facing section: how to reach the picker, that `×` needs two clicks, that killing a session's last window ends the session, and that killing the session you are attached to reconnects you to a fresh one.

- [ ] **Step 4: Verify no PII and commit**

```bash
git diff --stat
git diff | grep -nEi "[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|@[a-z0-9.-]+\.(com|net|org)" || echo "no PII patterns"
git add CLAUDE.md AGENTS.md docs/terminal.md
git commit -m "docs: session/window kill in the picker"
```

---

## Before merging

Per the project's standing rule, and because three of this feature's risks are invisible to every suite above — the keyboard contract of a hand-rolled popup, what killing the attached session looks like from a browser watching that pane, and whether the popup's colours hold in every theme:

1. Build in the feature worktree, `rsync -a --delete <worktree>/dist/ ./dist/`, restart the service.
2. Restart only when no setup/provision/lifecycle/fleet/voice-install/apk-build job is `running`.
3. Verify one hashed asset end-to-end (expect its real content-type, not `text/html`).
4. Exercise by hand: keyboard-only operation of the popup (↑↓, →, Esc, Enter); kill a spare session while attached to it; kill a session's last window; confirm the arm times out after 3s; confirm phone mode shows no control.
5. Only then merge and run the release checklist in `CLAUDE.md`.
