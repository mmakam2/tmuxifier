# Agent Switcher (Ctrl+Shift+K) and Settings → Hotkeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A held-chord, Cmd-Tab-style switcher over every agent session in the fleet, with a text preview of the highlighted session, plus a Settings → Hotkeys tab that remaps the switcher and voice chords per browser.

**Architecture:** The server gains three browser-session-only capabilities, proven first: a `session` parameter on the pane capture route, a Host Shell capture route, and a "release" close on `/term` that drops a viewer's PTY at once. The client is split the way Vitest forces: pure modules (hotkey combos, list/MRU, chord reducer, preview scheduler, commit planner, escape stripper) unit-tested in node, and a thin DOM half (overlay, document key listener, `main.ts` executor, Settings tab) covered by Playwright.

**Tech Stack:** Node 22 ESM, Fastify + `@fastify/websocket` (`ws`), tmux, TypeScript + xterm.js, Vite 8, Vitest 5 (node environment, no DOM), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-agent-switcher-design.md` (commit `54a76c2`). Read it before any task; this plan argues from it and does not repeat its rationale.

## Decisions made after the spec

Two places where the code contradicted a claim the spec relies on. Both were put to the operator on 2026-11-12 and are settled:

1. **Arrow keys.** The spec says arrows held with the chord "clash with nothing". `main.ts` already binds Ctrl+Shift+Arrow (document, capture phase) to move pane focus when 2+ panes are docked. **Decision: the switcher owns ↑/↓ while it is open; the pane-focus chord is inert until it closes.** Closed, Ctrl+Shift+Arrow behaves as today.
2. **"Drops its PTY".** The spec says a full `closeTab` drops the occupant's PTY so the session stops counting as attached. In the code `closeTab` only closes the WebSocket; `/term` then calls `sessions.detach`, which keeps the PTY and its tmux attach for `graceSeconds` (45 s). A notification edge inside that window is suppressed and lost. **Decision: add a release close.** When the switcher closes the occupant, the client closes that `/term` socket with close code `4000` and the server kills that viewer's PTY at once, only if no other socket watches it. Scoped to the switcher: undock, the sidebar and the AGENTS board keep the grace window.

## Global Constraints

- Work only in the worktree `/root/tmuxifier/.claude/worktrees/agent-switcher` on branch `feat/agent-switcher`. **Never run `npm run build` in `/root/tmuxifier`** before Task 17; the one build there is the ship checklist's own, followed at once by the restart.
- TDD: the failing test first, run it red, then implement. Tests use real code over injected seams, never mocks of the module under test.
- Vitest has no DOM. Anything touching `document`/`window` is covered by Playwright only.
- Default combos: switcher **Ctrl+Shift+K** (`KeyK`), voice **Ctrl+Shift+Space** (`Space`). Ctrl, never Cmd, on every platform.
- Every hotkey's modifiers are exactly Ctrl+Shift or Ctrl+Shift+Alt. Meta is never allowed. Matching is on `KeyboardEvent.code`.
- Timings: overlay paint delay **150 ms**; preview rest **250 ms**; preview cache **5000 ms**; preview `lines` **40**; MRU cap **100**.
- The preview fetch never sends `cols` or `rows`, and its text is rendered with `textContent` only.
- Nothing here may raise the seen watermark; only the existing `reportSeen` does, after the jump.
- Every new server capability is browser-session only. `DEVICE_ALLOWED_ROUTES` gains nothing.
- tmux targets stay exact (`'=name:'`); explicit session names are validated with `SESSION_NAME_RE` and rejected, never rewritten.
- Every web fetch goes through `http.ts` (`j`/`jsonOf`); `test/webHttp.test.js` scans for hand-rolled `res.ok`.
- All colors in `style.css` come from tokens (`test/styleTokens.test.js`); read `DESIGN.md` before styling.
- The repo is public: tests and docs use `192.168.1.x`, `example.com`, never real hosts.
- Hotkeys and MRU live in `localStorage` only, every access in try/catch. `uiSettingsStore.js` and `/api/ui-settings` are untouched.
- Conventional-commit messages, ending with the session's attribution trailer.
- Never `git add -A` in the worktree (a stray `node_modules` symlink once destroyed the real directory on merge); add the files each task names.

## Review Focus

Conditions the spec implies but does not list as tests, most likely first. Each has a test in the task named.

1. **Ctrl released while the chord key is still held.** The commit fires, but the key keeps auto-repeating with only Shift down; those repeats must not type `K` into the newly focused pane. → Task 9 (`drain` tests), Task 12 (e2e frame capture).
2. **A parked tab on a different session takes the slot.** `ensureTab` returns early for an existing tab, so the pane would show the old session under the new header. → Task 11 (`resetTab`), Task 12 (e2e "parked tab").
3. **Stored hotkeys that collide or are stale.** A stored switcher combo equal to the voice combo, a combo that a later rule set rejects, or non-JSON must fall back to defaults without throwing. → Task 5.
4. **Two tabs of one browser share nothing but `localStorage`.** A release close must not kill a PTY another socket is still watching, and a reload (no close code) must still reattach inside the grace window. → Task 4.
5. **The Host Shell row on a host with other tmux sessions.** The `__local__` series lists every session on the host's default server; only `local` may become a row, and the capture route must never create the session. → Task 3, Task 8.

---

## Workspace

Run once before Task 1. `git worktree add` from `HEAD`, not `EnterWorktree` (which branches from `origin` and drops unpushed commits).

```bash
cd /root/tmuxifier
# The worktree is cut from HEAD, so the plan has to be on it first (as the spec is).
git add docs/superpowers/plans/2026-11-12-agent-switcher.md
git commit -m "docs(plan): agent switcher implementation plan"
git worktree add .claude/worktrees/agent-switcher -b feat/agent-switcher HEAD
cd .claude/worktrees/agent-switcher
npm ci
npm test            # baseline: must be green before any change
```

For the e2e tasks (12-14): the e2e server serves the worktree's `dist/`, so run `npm run build` **in the worktree** before each `npm run test:e2e` run. Two failures exist on baseline `main` and are not this branch's: `phone.spec.ts:213` (touch drag) always, `duplicatePanes.spec.ts:156` intermittently. Confirm against baseline before chasing either.

## File Structure

| File | Responsibility |
|---|---|
| `src/server/singleFlight.js` (new) | `createSingleFlight()`: coalesce concurrent calls by key |
| `src/server/boxActions.js` | `paneSnapshot` runs through a single flight |
| `src/server/localShellActions.js` | `paneSnapshot({ lines })` over the local `/bin/sh` transport |
| `src/server/sessions.js` | `TERM_RELEASE_CODE` |
| `src/server/server.js` | pane route `session`; `GET /api/local-shell/pane`; `/term` release close |
| `src/web/termClose.ts` (new) | client mirror of `TERM_RELEASE_CODE` |
| `src/web/hotkeys.ts` (new) | combo model, validation, stored-mapping parse, live store |
| `src/web/voiceUi.ts` | voice hotkey becomes data-driven |
| `src/web/ansiStrip.ts` (new) | escape stripper, preview text shaping |
| `src/web/agentSwitcherList.ts` (new) | rows, MRU, initial highlight, step |
| `src/web/agentSwitcherChord.ts` (new) | chord reducer |
| `src/web/agentSwitcherPreview.ts` (new) | preview scheduler |
| `src/web/agentSwitcherCommit.ts` (new) | commit planner |
| `src/web/agentSwitcher.ts` (new) | DOM half: overlay, document listeners |
| `src/web/settingsHotkeys.ts` (new) | Settings → Hotkeys tab |
| `src/web/api.ts`, `dom.ts`, `paneHeader.ts`, `terminal.ts`, `settingsUi.ts`, `main.ts`, `style.css` | seams and wiring named in each task |

---

### Task 1: Pane route `session` parameter, browser-session only

**Files:**
- Modify: `src/server/server.js` (the `GET /api/boxes/:id/pane` handler, ~line 1189)
- Test: `test/paneRoutes.test.js`

**Interfaces:**
- Produces: `GET /api/boxes/:id/pane?session=<name>&lines=<n>` → the existing snapshot shape, with `agent`, `agentCause`, `sessionName` taken from `<name>`.

- [ ] **Step 1: Extend the test harness.** In `beforeEach`, wire `deviceStore: createDeviceStore({ dataDir: dir })` and `passkeyStore: createPasskeyStore({ dataDir: dir })` into `buildServer` (imports as in `test/deviceRoutes.test.js`), and make the fake `history.getSeries` return `[{ t: 1, up: true, agent: 'waiting', agents: { main: { cause: 'permission' }, side: { state: 'blocked', cause: 'question' } } }]`. Add a helper `bearer()` that enrolls with `{ password: 'pw', name: 'MCP' }` and returns `{ authorization: 'Bearer <token>' }`.

- [ ] **Step 2: Write the failing tests**

```js
test('GET pane with session captures that session and reports its agent state', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=side&lines=40`, headers: await headers() });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ content: 'hello\nworld', agent: 'blocked', agentCause: 'question', sessionName: 'side' });
  const remote = calls.at(-1).at(-1);
  expect(remote).toContain("capture-pane -e -p -t '=side:' -S -40");
});

test('GET pane with session: a session with no agent entry reports null state', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=other`, headers: await headers() });
  expect(res.json()).toMatchObject({ agent: null, agentCause: null, sessionName: 'other' });
});

test('GET pane with an invalid session is 400 and never reaches ssh', async () => {
  const h = await headers();
  for (const s of ['bad name', 'a;b', '', 'x'.repeat(65)]) {
    const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=${encodeURIComponent(s)}`, headers: h });
    expect(res.statusCode, s).toBe(400);
  }
  const twice = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=a&session=b`, headers: h });
  expect(twice.statusCode).toBe(400);
  expect(calls.length).toBe(0);
});

test('GET pane with session from a device token is 403; without session it still works', async () => {
  const b = await bearer();
  const refused = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=main`, headers: b });
  expect(refused.statusCode).toBe(403);
  expect(refused.json()).toEqual({ error: 'browser session required' });
  expect(calls.length).toBe(0);
  expect((await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane`, headers: b })).statusCode).toBe(200);
});

test('GET pane with session ignores cols/rows: the switcher never sizes anything', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=side&cols=48&rows=90&client=c`, headers: await headers() });
  expect(res.statusCode).toBe(200);
  expect(sizedCalls.length).toBe(0);
});

test('GET pane with session stays ungated while the box setup job runs', async () => {
  setupRunning = true;
  const res = await app.inject({ method: 'GET', url: `/api/boxes/${boxId}/pane?session=side`, headers: await headers() });
  expect(res.statusCode).toBe(200);
});
```

- [ ] **Step 3: Run red.** `npx vitest run test/paneRoutes.test.js` → the six new tests fail (today `session` is ignored: wrong target, `sessionName: 'main'`, 200 for the device token).

- [ ] **Step 4: Implement in the handler.** Order matters: 404 for the box, then when `req.query.session !== undefined`: 403 `{ error: 'browser session required' }` if `req.deviceId`; 400 `{ error: 'session name must be letters, digits, _ or -' }` unless it is a string passing `SESSION_NAME_RE`; then capture that session, skip the whole sizing-viewer block, and answer with `agent: last?.agents?.[session]?.state ?? null`, `agentCause: last?.agents?.[session]?.cause ?? null`, `sessionName: session`. Read `agents[session]` with `Object.hasOwn` (the map is box-controlled and null-prototype). With `session` absent the handler's existing lines run unchanged.

- [ ] **Step 5: Run green.** `npx vitest run test/paneRoutes.test.js test/deviceRoutes.test.js` → all pass, including the pre-existing pane tests untouched.

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js test/paneRoutes.test.js
git commit -m "feat(server): browser-only session parameter on the pane capture route"
```

---

### Task 2: Single-flight capture

**Files:**
- Create: `src/server/singleFlight.js`
- Modify: `src/server/boxActions.js` (`paneSnapshot`, ~line 765)
- Test: `test/singleFlight.test.js` (new), `test/paneRoutes.test.js`

**Interfaces:**
- Produces: `createSingleFlight(): (key: string, fn: () => Promise<T>) => Promise<T>` — while a call for `key` is pending, later calls for the same key get the same promise and `fn` is not invoked again; the key is freed when the promise settles, fulfilled or rejected.

- [ ] **Step 1: Write the failing tests**

```js
// test/singleFlight.test.js
test('concurrent calls for one key share one run; the key frees on settle', async () => {
  const flight = createSingleFlight();
  let runs = 0; let release;
  const fn = () => { runs += 1; return new Promise((r) => { release = r; }); };
  const a = flight('k', fn); const b = flight('k', fn);
  expect(runs).toBe(1);
  release('v');
  expect(await a).toBe('v'); expect(await b).toBe('v');
  void flight('k', fn); expect(runs).toBe(2);
});
test('different keys run independently', ...);                 // two keys → runs === 2
test('a rejection reaches every waiter and frees the key', ...); // both reject; next call runs again
```

```js
// test/paneRoutes.test.js — make `run` awaitable: add `let gate = null;` and, in the
// capture-pane branch, `if (gate) await gate;` before returning.
test('concurrent captures of one box and session share one ssh', async () => {
  const h = await headers();
  let open; gate = new Promise((r) => { open = r; });
  const url = `/api/boxes/${boxId}/pane?session=side&lines=40`;
  const both = Promise.all([app.inject({ method: 'GET', url, headers: h }), app.inject({ method: 'GET', url, headers: h })]);
  await new Promise((r) => setTimeout(r, 50));
  expect(calls.filter((a) => a.at(-1).includes('capture-pane')).length).toBe(1);
  open();
  expect((await both).map((r) => r.statusCode)).toEqual([200, 200]);
});
test('captures of two sessions on one box are not coalesced', ...); // session=side and session=main → 2 capture runs
```

- [ ] **Step 2: Run red.** `npx vitest run test/singleFlight.test.js test/paneRoutes.test.js` → module missing; coalescing test counts 2.

- [ ] **Step 3: Implement** `createSingleFlight` (a `Map` of pending promises, deleted in `finally`), and in `createBoxActions` create one flight and wrap `paneSnapshot`'s body with key `` `${box.id}\n${session}\n${lines}` ``.

- [ ] **Step 4: Run green.** Same command → pass. Then `npx vitest run test/boxActions.test.js test/mcpTools.test.js` → still pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/singleFlight.js src/server/boxActions.js test/singleFlight.test.js test/paneRoutes.test.js
git commit -m "feat(server): coalesce concurrent pane captures of one box and session"
```

---

### Task 3: Host Shell capture route

**Files:**
- Modify: `src/server/localShellActions.js`, `src/server/server.js` (beside the other `/api/local-shell` routes, ~line 2051)
- Test: `test/localShellPane.test.js` (new), `test/localShellActions.test.js`, `test/deviceRoutes.test.js`

**Interfaces:**
- Consumes: `buildPaneSnapshotRemote`, `parsePaneSnapshot` from `tmuxInject.js`; `createSingleFlight` (Task 2).
- Produces:
  - `localShellActions.paneSnapshot({ lines = 200, timeoutMs = 8000 } = {})` → `{ ok: true, width, height, cursorX, cursorY, alt, mouse, content } | { ok: false, error }`. Always the `localSession`; never creates it.
  - `GET /api/local-shell/pane?lines=<n>` → `{ ...snap, agent, agentCause, sessionName: 'local' }`, 502 `{ error }` on a failed capture, 503 `{ error: 'capture unavailable' }` when `localShellActions.paneSnapshot` is not wired.

- [ ] **Step 1: Write the failing tests**

```js
// test/localShellPane.test.js — buildServer with the REAL createLocalShellActions over a
// fake `run` seam (records scripts, returns { code: 0, stdout: '80 24 0 0 0 0 0\nhost\nshell\n', stderr: '' }),
// a deviceStore, and history.getSeries(id) returning, for '__local__' only,
// [{ t: 1, up: true, agents: { local: { state: 'done', cause: 'stop' }, other: { state: 'blocked' } } }].
test('a browser session gets the Host Shell snapshot with the local session agent state', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane?lines=40', headers: await headers() });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, width: 80, height: 24, cursorX: 0, cursorY: 0, alt: false, mouse: false,
    content: 'host\nshell', agent: 'done', agentCause: 'stop', sessionName: 'local' });
  expect(scripts.at(-1)).toContain("capture-pane -e -p -t '=local:' -S -40");
});
test('a session query parameter is ignored: only the local session is ever captured', async () => {
  await app.inject({ method: 'GET', url: '/api/local-shell/pane?session=other', headers: await headers() });
  expect(scripts.at(-1)).toContain("-t '=local:'");
  expect(scripts.at(-1)).not.toContain('other');
});
test('a device token is refused and nothing runs', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/local-shell/pane', headers: await bearer() });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ error: 'browser session required' });
  expect(scripts.length).toBe(0);
});
test('no credentials is 401', ...);
test('a failed capture is 502 and creates nothing', async () => {   // run → { code: 1, stderr: "can't find session: local" }
  expect(res.statusCode).toBe(502);
  expect(scripts.every((s) => !/new-session|has-session/.test(s))).toBe(true);
});
test('concurrent captures share one run', ...);                      // gate the fake run; 2 requests → 1 script
```

```js
// test/localShellActions.test.js — real transport, real tmux, private server.
test('paneSnapshot reads the local session of the tmux server its env points at', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-lsp-'));
  const env = { ...process.env, TMUX_TMPDIR: tmp }; delete env.TMUX;
  execFileSync('tmux', ['new-session', '-d', '-s', 'local', '-x', '80', '-y', '24', "printf 'SWITCHER_PREVIEW_OK\\n'; sleep 30"], { env });
  try {
    let snap;                                   // the pane's printf races the first capture: poll up to 2 s
    await expect.poll(async () => { snap = await createLocalShellActions({ env }).paneSnapshot({ lines: 40 }); return snap.content; }, { timeout: 2000 }).toContain('SWITCHER_PREVIEW_OK');
    expect(snap.ok).toBe(true);
    expect(snap.width).toBe(80);
  } finally { execFileSync('tmux', ['kill-server'], { env }); await fs.rm(tmp, { recursive: true, force: true }); }
});
test('paneSnapshot with no local session fails cleanly and does not create one', ...); // empty private server → { ok: false }, then `tmux ls` under that env still lists nothing
```

In `test/deviceRoutes.test.js`, add `{ method: 'GET', url: '/api/local-shell/pane' }` to the `forbidden` array of the allowlist test. That test is the proof the route is absent from `DEVICE_ALLOWED_ROUTES` (the set is private to `buildServer`).

- [ ] **Step 2: Run red.** `npx vitest run test/localShellPane.test.js test/localShellActions.test.js test/deviceRoutes.test.js` → 404s and a missing method.

- [ ] **Step 3: Implement.** `paneSnapshot` in `createLocalShellActions`: `run(buildPaneSnapshotRemote(localSession, { lines }), { cwd, env, timeout: timeoutMs })` inside a single flight keyed by `lines`, then the same `code !== 0` / `parsePaneSnapshot` mapping as `boxActions.paneSnapshot`. The route: `{ preHandler: requireAuth }`, `lines` parsed as in the box route, state from `history.getSeries(LOCAL_BOX_ID).at(-1)?.agents` read with `Object.hasOwn(agents, localSession)`. Do **not** add it to `DEVICE_ALLOWED_ROUTES`, do not call `localTmuxScope.ensure`.

- [ ] **Step 4: Run green.** Same command → pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/localShellActions.js src/server/server.js test/localShellPane.test.js test/localShellActions.test.js test/deviceRoutes.test.js
git commit -m "feat(server): browser-only Host Shell pane capture route"
```

---

### Task 4: `/term` release close

**Files:**
- Modify: `src/server/sessions.js` (export beside `terminalKey`), `src/server/server.js` (`/term`: `markClosed`, the Host Shell branch and the interactive box branch; **not** provision mode)
- Create: `src/web/termClose.ts`
- Test: `test/server.ws.integration.test.js`, `test/termClose.test.js` (new)

**Interfaces:**
- Produces: `export const TERM_RELEASE_CODE = 4000` in both `sessions.js` and `src/web/termClose.ts`. A `/term` socket closed by the client with that code makes the handler call `sessions.closeIfUnwatched(entry)` instead of `sessions.detach(entry)`. Any other close (reload, network drop, code absent) is unchanged.

- [ ] **Step 1: Write the failing tests**

```js
// test/termClose.test.js
test('client and server agree on the release close code', async () => {
  const { TERM_RELEASE_CODE: server } = await import('../src/server/sessions.js');
  const { TERM_RELEASE_CODE: web } = await import('../src/web/termClose.ts');
  expect(web).toBe(server); expect(server).toBe(4000);
});
```

```js
// test/server.ws.integration.test.js — fake sessions recording calls, as the neighbouring
// '/term reuses one viewer id' tests do: open/openLocal/provision return an entry object;
// detach(e) pushes ['detach', e]; closeIfUnwatched(e) pushes ['release', e].
// In-file helpers: openTerm(query) opens an authenticated ws and resolves once it is open;
// until(fn, ms = 3000) polls fn every 50 ms and rejects on timeout.
test('/term closed with the release code drops the PTY instead of starting the grace window', async () => {
  const ws = await openTerm(`box=${saved.id}&client=v1`);
  ws.close(4000, 'release');
  await until(() => log.length === 1);
  expect(log[0][0]).toBe('release');
});
test('/term closed normally still detaches into the grace window', ...);   // ws.close() → [['detach', entry]]
test('/term host shell honours the release code too', ...);                // box=__local__ → 'release'
test('/term provision mode is untouched by the release code', ...);        // mode=provision: ws.close(4000) and ws.close() log the same single call

// Real session manager, real sshd fixture (setupLocalBox), graceSeconds: 45.
test('a release close detaches the tmux client at once; a plain close keeps it for the grace window', async () => {
  const listClients = () => execFileSync('ssh', ['-F', sshConfigFile, box.host, `tmux list-clients -t '=${session}' -F x`], { encoding: 'utf8' }).trim();
  const a = await openTerm(`box=${saved.id}&client=keep`); await until(() => listClients() === 'x', 8000);
  a.close();                        await delay(1500); expect(listClients()).toBe('x');   // still attached: grace
  const b = await openTerm(`box=${saved.id}&client=keep`); await delay(500);
  b.close(4000, 'release');         await until(() => listClients() === '', 5000);          // gone well inside 45 s
}, 30000);
test('a release close leaves the PTY alone while a second socket on the same viewer key is attached', ...);
// two sockets, same client id; close one with 4000; the other still receives output for an `echo` typed afterwards
```

- [ ] **Step 2: Run red.** `npx vitest run test/termClose.test.js test/server.ws.integration.test.js` → release tests see `detach`; the real-box test times out on the second `until`.

- [ ] **Step 3: Implement.** `socket.once('close', ...)` passes `(code)`; `'error'` passes an `Error`. Make `markClosed` forward `code === TERM_RELEASE_CODE` (strict number compare) to `onSocketClose(release)`. In the two terminal branches: after `off()`/`offExit()`, `release && sessions.closeIfUnwatched ? sessions.closeIfUnwatched(entry) : sessions.detach(entry)`. The early `markClosed()` calls (socket already closed before attach) pass nothing and so detach.

- [ ] **Step 4: Run green.** Same command → pass. Then `npx vitest run test/sessions.test.js` → pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions.js src/server/server.js src/web/termClose.ts test/termClose.test.js test/server.ws.integration.test.js
git commit -m "feat(term): release close drops a viewer's PTY without the grace window"
```

---

### Task 5: `hotkeys.ts` — combo model, validation, stored mapping

**Files:**
- Create: `src/web/hotkeys.ts`
- Test: `test/hotkeys.test.js` (new)

**Interfaces:**
- Produces:

```ts
export type HotkeyAction = 'switcher' | 'voice';
export interface Combo { alt: boolean; code: string }        // Ctrl+Shift always implied
export interface KeyLike { type: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; repeat?: boolean }
export const DEFAULT_HOTKEYS: Record<HotkeyAction, Combo>;  // switcher { alt: false, code: 'KeyK' }, voice { alt: false, code: 'Space' }
export const HOTKEY_LABEL: Record<HotkeyAction, string>;    // 'Agent switcher', 'Voice dictation (toggle)'
export const HOTKEYS_STORAGE_KEY = 'tmuxifier.hotkeys';
export const MODIFIER_CODES: ReadonlySet<string>;           // Control/Shift/Alt/Meta Left+Right
export type ComboVerdict = { ok: true; combo: Combo } | { ok: false; reason: string };
export function validateCombo(c: Combo, other?: { action: HotkeyAction; combo: Combo }): ComboVerdict;  // `other` omitted skips the last rule
export function validateRecorded(ev: KeyLike, other: { action: HotkeyAction; combo: Combo }): ComboVerdict | null; // null: a bare modifier press, keep listening
export function matchesCombo(ev: KeyLike, c: Combo): boolean;   // ctrl && shift && !meta && alt === c.alt && code === c.code
export function chordCodes(c: Combo): Set<string>;              // c.code + Control L/R + Shift L/R, + Alt L/R when c.alt
export function comboLabel(c: Combo): string;                   // 'Ctrl+Shift+K', 'Ctrl+Shift+Alt+1', 'Ctrl+Shift+Space', 'Ctrl+Shift+,'
export function parseStoredHotkeys(raw: string | null): Record<HotkeyAction, Combo>;
export function serializeHotkeys(m: Record<HotkeyAction, Combo>): string;  // {"v":1,"switcher":{...},"voice":{...}}
export interface HotkeyStore {
  get(a: HotkeyAction): Combo;
  set(a: HotkeyAction, c: Combo): ComboVerdict;   // validates against the other action's current combo, persists
  reset(a: HotkeyAction): ComboVerdict;           // back to the default; refused (with the reason) if the other action now holds it
  recording(): boolean; setRecording(on: boolean): void;
}
export function createHotkeyStore(storage?: Pick<Storage, 'getItem' | 'setItem'> | null): HotkeyStore;
export const hotkeys: HotkeyStore;   // singleton over localStorage, resolved inside try/catch; null storage when unavailable
```

- Closed rule set, checked in this order, with this copy (the spec fixes "says why in plain words"; this is the wording):

| Rule | `reason` |
|---|---|
| `metaKey` held (recorded only) | `Cmd/Win can't be part of a hotkey: browsers don't report key releases while it is held.` |
| Ctrl or Shift missing (recorded only) | `Hotkeys must include Ctrl+Shift, so terminal keys like Ctrl+K and Alt+letter stay free.` |
| `code` not `Key[A-Z]`, `Digit[0-9]`, `Space`, or one of `Comma Period Slash Semicolon Quote BracketLeft BracketRight Backslash Minus Equal Backquote` | `Use a letter, a digit, Space, or a punctuation key. Tab, Esc, Enter and the arrows are taken.` |
| `code` is `KeyC` or `KeyV` (any `alt`: `clipboard.ts` does not check Alt) | `Ctrl+Shift+C and Ctrl+Shift+V are copy and paste in the terminal.` |
| `!alt` and `code` in `KeyT KeyN KeyW KeyQ KeyJ KeyI KeyB KeyM KeyE KeyZ Delete` | `Browsers keep ${comboLabel(c)} for themselves.` |
| equals `other.combo` | `That combo is already used by ${HOTKEY_LABEL[other.action]}.` |

  `KeyM`, `KeyE`, `KeyZ` are the DevTools siblings (device/responsive mode, Firefox network monitor and debugger). `KeyK` is deliberately not reserved: it is the default, and the Settings note covers Edge and Firefox.

- `parseStoredHotkeys`: non-JSON, non-object, or `v !== 1` → defaults. Each action is resolved on its own through `validateCombo` with `other` omitted (wrong types, unknown codes, reserved combos → that action's default). If the two resolved combos are then equal → **both** defaults. Never throws.

- [ ] **Step 1: Write the failing tests** (`test/hotkeys.test.js`), one `test` per row below; `ev(o)` builds a keydown `KeyLike` with `ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: 'KeyK'` overridden by `o`.

```js
test('the defaults validate against each other', ...);       // validateCombo(DEFAULT.switcher, {voice}) ok; and the reverse
test('modifiers: exactly Ctrl+Shift or Ctrl+Shift+Alt', () => {
  expect(validateRecorded(ev({}), voice)).toEqual({ ok: true, combo: { alt: false, code: 'KeyK' } });
  expect(validateRecorded(ev({ altKey: true }), voice)).toEqual({ ok: true, combo: { alt: true, code: 'KeyK' } });
  for (const o of [{ shiftKey: false }, { ctrlKey: false }, { ctrlKey: false, shiftKey: false, altKey: true }, { shiftKey: false, altKey: true }])
    expect(validateRecorded(ev(o), voice)).toMatchObject({ ok: false, reason: expect.stringMatching(/must include Ctrl\+Shift/) });
  expect(validateRecorded(ev({ metaKey: true }), voice)).toMatchObject({ ok: false, reason: expect.stringMatching(/^Cmd\/Win/) });
});
test('a bare modifier press is not a verdict', ...);          // code 'ShiftLeft' / 'ControlRight' / 'AltLeft' → null
test('keys: letters, digits, Space and the punctuation allowlist only', ...);
// ok: KeyA, Digit7, Space, Comma, Backquote. refused with /punctuation key/: Tab, Escape, Enter, ArrowUp, ArrowDown, F5, Delete, NumpadEnter
test('clipboard combos are refused with or without Alt', ...); // KeyC, KeyV × alt false/true → /copy and paste/
test('browser-kept combos are refused, naming the combo', ...);
// each of T N W Q J I B M E Z → reason === `Browsers keep Ctrl+Shift+${letter} for themselves.`; with alt: true the same codes are ok
test('the other action\'s combo is refused, naming it', ...);  // recording switcher = Ctrl+Shift+Space → 'That combo is already used by Voice dictation (toggle).'
test('matchesCombo checks modifiers exactly', ...);            // alt mismatch both ways false; meta true false; wrong code false; keyup type irrelevant here (caller checks type)
test('chordCodes covers the key and both sides of each modifier', ...); // size 5 without alt, 7 with
test('comboLabel', ...);                                       // the four examples in the interface comment, plus Digit0 → '0', Backquote → '`'
test('parseStoredHotkeys: defaults for null, garbage, wrong version, wrong shapes', ...);
// null, '', 'not json', '[]', '{"v":2,...}', '{"v":1,"switcher":"KeyK"}', '{"v":1,"switcher":{"alt":"no","code":7}}'
test('parseStoredHotkeys keeps a valid remap of one action and defaults the other', ...);
test('parseStoredHotkeys: a stored combo the rules now refuse falls back for that action only', ...); // switcher KeyT → KeyK, voice KeyD kept
test('parseStoredHotkeys: two stored combos that collide both fall back', ...); // switcher Space + voice absent → K and Space; switcher KeyD + voice KeyD → K and Space
test('serialize → parse round-trips', ...);
test('store: set validates, persists, and get reads it back at once', ...);   // fake storage object; set('switcher', {alt:false,code:'KeyY'}) ok; storage holds serializeHotkeys(...)
test('store: set refuses the other action\'s current combo, not just its default', ...); // voice → KeyD, then switcher → KeyD refused; switcher → Space now ok
test('store: reset restores the default, and is refused while the other action holds it', ...);
test('store: storage that throws on getItem and setItem still works in memory', ...);
test('store: null storage runs on the defaults', ...);
test('store: recording flag', ...);
```

- [ ] **Step 2: Run red.** `npx vitest run test/hotkeys.test.js` → cannot resolve `../src/web/hotkeys.ts`.
- [ ] **Step 3: Implement `src/web/hotkeys.ts`** to the interface above. No DOM access except the singleton's guarded `localStorage` lookup (`typeof localStorage` inside try/catch).
- [ ] **Step 4: Run green.** `npx vitest run test/hotkeys.test.js && npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/web/hotkeys.ts test/hotkeys.test.js
git commit -m "feat(web): hotkey combo model, validation and per-browser store"
```

---

### Task 6: Voice hotkey becomes data-driven

**Files:**
- Modify: `src/web/voiceUi.ts` (`isVoiceHotkey`, `isVoiceHotkeyChordKey`, `createVoiceHotkeyHandler`, `idleTitle`, the `recording` tooltip in `paint`), comment-only touch in `src/web/terminal.ts` (the two "Ctrl+Shift+Space" comments become "the voice hotkey")
- Test: `test/voiceUi.test.js`

**Interfaces:**
- Consumes: `Combo`, `matchesCombo`, `chordCodes`, `comboLabel`, `hotkeys` (Task 5).
- Produces:
  - `isVoiceHotkey(ev: KeyboardEvent, combo: Combo = hotkeys.get('voice')): boolean` — non-repeat keydown that `matchesCombo`.
  - `createVoiceHotkeyHandler(voice: VoiceHotkeyTarget, opts?: { combo?: () => Combo; suppressed?: () => boolean }): (ev: KeyboardEvent) => boolean` — defaults `() => hotkeys.get('voice')` and `() => hotkeys.recording()`. The combo is read at event time; the combo that started a chord is held for that chord, whose swallow set is `chordCodes(thatCombo)` and which ends on the keyup of `thatCombo.code`. While `suppressed()` it returns `false` for a fresh chord (an in-progress chord still drains).
  - `idleTitle(hint, dictationEnabled, label: string = comboLabel(hotkeys.get('voice')))` — the two tooltips name `label` instead of the literal `Ctrl+Shift+Space`.

- [ ] **Step 1: Write the failing tests** (added to `test/voiceUi.test.js`; the existing tests stay and must keep passing with no arguments).

```js
test('the voice hotkey follows the configured combo, checked exactly', () => {
  const combo = { alt: true, code: 'KeyD' };
  expect(isVoiceHotkey(ev({ code: 'KeyD', altKey: true }), combo)).toBe(true);
  expect(isVoiceHotkey(ev({ code: 'KeyD' }), combo)).toBe(false);          // Alt missing
  expect(isVoiceHotkey(ev({ code: 'Space', altKey: true }), combo)).toBe(false);
  expect(isVoiceHotkey(ev({ code: 'Space', altKey: true }))).toBe(false);  // default combo has no Alt
});
test('a handler created once sees a combo changed afterwards', () => {
  let combo = { alt: false, code: 'Space' };
  const handle = createVoiceHotkeyHandler(voice, { combo: () => combo, suppressed: () => false });
  combo = { alt: false, code: 'KeyD' };
  expect(handle(down({ code: 'Space' }))).toBe(false);   // old combo passes through
  expect(handle(down({ code: 'KeyD' }))).toBe(true);
  expect(voice.begun).toBe(1);
});
test('the chord swallows its own key and modifiers, and ends on its own keyup', ...);
// combo KeyD: repeats of KeyD → true; keyup ShiftLeft → true; a Space keydown mid-chord → false (not in the set);
// keyup KeyD → true and the chord is over: the next keyup ShiftLeft → false
test('a combo changed mid-chord does not strand the chord in flight', ...);
// start with KeyD, switch the getter to KeyY, keyup KeyD → true and over
test('an Alt combo swallows Alt keyups too', ...);
test('suppressed: a fresh chord passes through untouched', ...); // suppressed: () => true → false, voice.begun === 0
test('tooltips name the configured combo', () => {
  expect(idleTitle(null, true, 'Ctrl+Shift+D')).toBe('Hold to dictate (or tap Ctrl+Shift+D to start/stop)');
});
```

- [ ] **Step 2: Run red.** `npx vitest run test/voiceUi.test.js`.
- [ ] **Step 3: Implement.** Toggle and swallow behaviour otherwise unchanged; `wireClipboard` in `terminal.ts` keeps calling `createVoiceHotkeyHandler(voice)` with no options.
- [ ] **Step 4: Run green.** `npx vitest run test/voiceUi.test.js test/clipboard.test.js && npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/web/voiceUi.ts src/web/terminal.ts test/voiceUi.test.js
git commit -m "refactor(voice): hotkey reads its combo through a getter at event time"
```

---

### Task 7: `ansiStrip.ts` — escape stripper and preview shaping

**Files:**
- Create: `src/web/ansiStrip.ts`
- Test: `test/ansiStrip.test.js` (new)

**Interfaces:**
- Produces:
  - `stripAnsi(text: string): string` — removes OSC, CSI and two-character ESC sequences with the same three expressions as `src/mcp/shape.js`, then every remaining C0 control except `\n` and `\t`, DEL, and C1 (`\x80-\x9f`).
  - `previewText(content: string, maxLines = 40): string` — `stripAnsi`, split on `\n`, `trimEnd()` each row (not a `/\s+$/` regex: it backtracks quadratically), drop trailing blank rows, keep the last `maxLines`, join.

- [ ] **Step 1: Write the failing tests**

```js
test('SGR, cursor moves, OSC titles and OSC 8 links are removed', () => {
  expect(stripAnsi('\x1b[1;31mred\x1b[0m \x1b[2K\x1b]0;title\x07ok \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\')).toBe('red ok link');
});
test('stray controls are dropped but newlines and tabs survive', ...);  // 'a\x00b\x07c\rd\te\nf\x7f\x9b' → 'abcd\te\nf'
test('an unterminated escape at the end leaves no ESC byte', ...);      // 'x\x1b[' → no '\x1b' in the result
test('matches the MCP stripper on a captured pane', async () => {
  const { stripSgr } = await import('../src/mcp/shape.js');
  const sample = '\x1b[38;5;208m● \x1b[0mWorking\x1b[K\n\x1b[2m  esc to interrupt\x1b[0m   \n\n\n';
  expect(previewText(sample, 40)).toBe(stripSgr(sample));
});
test('trailing blank rows are trimmed so an inline agent does not preview as empty space', ...); // 'a\nb\n\n   \n\n' → 'a\nb'
test('only the last maxLines rows are kept, counted after the trim', ...); // 50 rows + 10 blank, maxLines 40 → rows 11..50
test('empty and all-blank content is the empty string', ...);
test('markup survives as text', ...);                                   // '<b>x</b>' unchanged
```

- [ ] **Step 2: Run red.** `npx vitest run test/ansiStrip.test.js`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit**

```bash
git add src/web/ansiStrip.ts test/ansiStrip.test.js
git commit -m "feat(web): escape stripper and preview text shaping"
```

---

### Task 8: `agentSwitcherList.ts` — rows, MRU, highlight

**Files:**
- Create: `src/web/agentSwitcherList.ts`
- Test: `test/agentSwitcherList.test.js` (new)

**Interfaces:**
- Consumes: `latestAgents`, `AGENT_PRECEDENCE` (`agentState.ts`); `Sample`, `AgentState`, `AgentCause`, `AgentKind` (`api.ts`).
- Produces:

```ts
export const LOCAL_BOX = '__local__';
export const LOCAL_SESSION = 'local';
export const MRU_STORAGE_KEY = 'tmuxifier.agentMru';
export const MRU_CAP = 100;
export const rowKey = (boxId: string, session: string): string => `${boxId}\n${session}`;
export interface SwitcherRow { key: string; boxId: string; label: string; session: string; state: AgentState; cause?: AgentCause; agent?: AgentKind; ts: number; here: boolean; gone: boolean }
export function switcherRows(i: { boxes: { id: string; label: string }[]; series: Record<string, Sample[]>; mru: string[]; focused: { boxId: string; session: string } | null }): SwitcherRow[];
export function liveRows(frozen: SwitcherRow[], series: Record<string, Sample[]>): SwitcherRow[];  // same order and length; state/cause/agent/ts refreshed; gone = true when the session no longer has a state
export function initialIndex(rows: SwitcherRow[]): number;                 // first row with !here; -1 when there is none
export function stepIndex(index: number, delta: 1 | -1, count: number): number;  // wraps both ways; count 0 → -1
export function bumpMru(mru: string[], key: string, cap?: number): string[];     // key to the front, deduped, capped; returns a new array
export function parseMru(raw: string | null): string[];                           // JSON string[]; anything else → []; non-strings dropped; capped
```

- `main.ts` drops its own `LOCAL_SESSION` constant in Task 12 and imports this one.
- Rules: a row for every session with a `state` in the newest sample of each series whose box is in `boxes` and whose newest sample has `up === true`. For `LOCAL_BOX`: label `Host Shell`, and only the `LOCAL_SESSION` entry. Order: the `focused` row first when it is a row (`here: true`); then rows whose key is in `mru`, in `mru` order (index 0 newest); then the rest by `AGENT_PRECEDENCE`, newest `ts` first within a state, ties by `label` then `session`.

- [ ] **Step 1: Write the failing tests.** `s(agents, up = true)` builds a one-sample series.

```js
test('one row per stateful session, per session not per box', ...);        // a box with two agent sessions → two rows
test('sessions without a state, and non-agent sessions, are not rows', ...); // { present: true } and { present: false }
test('a box whose newest sample is down is not listed', ...);
test('a series for a box that no longer exists is skipped', ...);
test('Host Shell: only the local session is a row, labelled Host Shell', () => {
  const rows = switcherRows({ boxes: [], mru: [], focused: null,
    series: { __local__: s({ local: { present: true, attached: false, state: 'working', ts: 5 }, other: { present: true, attached: false, state: 'blocked', ts: 9 } }) } });
  expect(rows.map((r) => [r.label, r.session])).toEqual([['Host Shell', 'local']]);
});
test('the focused pane\'s agent session is pinned first and marked here', ...);
test('a focused non-agent session pins nothing', ...);                      // focused names a session with no state → no here row
test('used sessions come next, newest use first, then never-used by precedence and recency', () => {
  // rows a(blocked, ts 1) b(done, 9) c(working, 5) d(idle, 3) e(blocked, 7); mru [key(c), key(d)]; focused b
  expect(order).toEqual(['b', 'c', 'd', 'e', 'a']);
});
test('an mru key with no live row is ignored', ...);
test('initialIndex is the first row that is not the focused session', ...); // pinned → 1; nothing pinned → 0; only the pinned row → -1; no rows → -1
test('stepIndex wraps down and up', ...);                                    // (2, 1, 3) → 0; (0, -1, 3) → 2; (0, 1, 1) → 0; (-1, 1, 0) → -1
test('liveRows keeps the frozen order while state and age move', ...);       // reorder-worthy change (idle → blocked) does not move the row
test('liveRows marks a vanished session gone and keeps its last state', ...);
test('bumpMru moves a key to the front without duplicates and caps the list', ...); // 101 keys → 100, newest first, input array not mutated
test('parseMru tolerates null, garbage and wrong types', ...);               // null, 'x', '{}', '[1,"a",null]' → [], [], [], ['a']
test('row keys cannot collide across boxes', ...);                           // ('a', 'b-c') vs ('a-b', 'c') differ
```

- [ ] **Step 2: Run red.** `npx vitest run test/agentSwitcherList.test.js`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green.** Plus `npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/web/agentSwitcherList.ts test/agentSwitcherList.test.js
git commit -m "feat(web): agent switcher rows, MRU order and highlight stepping"
```

---

### Task 9: `agentSwitcherChord.ts` — the chord reducer

**Files:**
- Create: `src/web/agentSwitcherChord.ts`
- Test: `test/agentSwitcherChord.test.js` (new)

**Interfaces:**
- Consumes: `Combo`, `KeyLike`, `matchesCombo`, `MODIFIER_CODES` (Task 5).
- Produces:

```ts
export type ChordPhase = 'idle' | 'open' | 'drain';
export interface ChordState { phase: ChordPhase; combo: Combo | null; held: string[] }   // held: non-modifier codes whose keydown was swallowed and whose keyup is still owed
export const CHORD_IDLE: ChordState;
export type ChordInput = { t: 'key'; ev: KeyLike } | { t: 'blur' } | { t: 'click'; index: number };
export type ChordEffect = { t: 'open' } | { t: 'step'; delta: 1 | -1 } | { t: 'commit'; index?: number } | { t: 'cancel' };
export interface ChordResult { state: ChordState; swallow: boolean; effects: ChordEffect[] }
export function chordReduce(state: ChordState, input: ChordInput, ctx: { combo: Combo; enabled: boolean }): ChordResult;
```

- The transition table (this is the algorithm; the tests pin each row). "Mods down" means `ev.ctrlKey && ev.shiftKey`.

| Phase | Input | Result |
|---|---|---|
| idle | non-repeat keydown, `ctx.enabled`, `matchesCombo(ev, ctx.combo)` | → open, `combo = ctx.combo`, `held = [code]`, swallow, `[open]` |
| idle | repeat keydown that `matchesCombo` | swallow, no effect (a key held across a blur must not type) |
| idle | anything else, `blur`, `click` | pass |
| open | key event with mods **not** down (covers Ctrl/Shift keyup) | → drain, swallow, `[commit]`; a keyup also leaves `held` |
| open | keydown `Escape` | → drain, `held += Escape`, swallow, `[cancel]` |
| open | keydown `combo.code` (repeat or not), or `ArrowDown` | `held +=`, swallow, `[step +1]` |
| open | keydown `ArrowUp` | `held +=`, swallow, `[step -1]` |
| open | any other keydown | `held +=` (unless a modifier code), swallow, no effect |
| open | any keyup with mods down | `held -=`, swallow |
| open | `click(index)` | → drain, `[commit index]` |
| open | `blur` | → idle (`held` cleared), `[cancel]` |
| drain | non-repeat keydown, `ctx.enabled`, `matchesCombo`, code not in `held` | → open as from idle |
| drain | key event whose code is in `held` | swallow; a keyup leaves `held` |
| drain | keyup of a modifier code | swallow |
| drain | anything else | pass |
| drain | after any of the above: `held` empty and mods not down | → idle |
| drain | `blur` | → idle |

  `Alt` plays no part after opening: releasing it does nothing, and stepping matches on `code` with Ctrl+Shift down.

- [ ] **Step 1: Write the failing tests.** `k(type, code, o)` builds a `KeyLike` with Ctrl+Shift down unless overridden; `run(inputs)` folds `chordReduce` from `CHORD_IDLE` and returns `{ state, effects, swallowed }` (flat effect list, per-input swallow flags).

```js
test('the chord opens on its first keydown and swallows it', ...);            // effects [open], swallow true, phase open
test('a disabled chord passes its keydown through untouched', ...);           // enabled false → phase idle, swallow false
test('plain Ctrl+K and Alt+K never open it', ...);                            // shift false; ctrl false alt true → pass
test('an exact-modifier mismatch does not open it', ...);                     // combo alt:false, event altKey true → pass
test('the chord key, ArrowDown and ArrowUp step; repeats step too', ...);     // down K, repeat K, repeat K, ArrowDown, ArrowUp → steps +1 +1 +1 -1, all swallowed
test('releasing Ctrl commits; releasing Shift commits', ...);                 // keyup ControlLeft {ctrlKey:false} → [commit]; same for ShiftRight
test('any key event arriving without Ctrl or Shift commits', ...);            // keydown KeyX {ctrlKey:false} while open → [commit], swallowed
test('Esc cancels and its keyup is swallowed', ...);
test('blur cancels without committing and returns to idle', ...);
test('clicking a row commits to that row', ...);                              // [commit index: 3]
test('every key while open is swallowed, with its keyup', ...);              // Ctrl+Shift+C while open: keydown and keyup swallowed, no effect
test('Ctrl released first while the chord key is held: its repeats and keyup are still swallowed', () => {
  const r = run([key('keydown', 'KeyK'), key('keyup', 'ControlLeft', { ctrlKey: false }),
    key('keydown', 'KeyK', { ctrlKey: false, repeat: true }), key('keydown', 'KeyK', { ctrlKey: false, repeat: true }),
    key('keyup', 'KeyK', { ctrlKey: false }), key('keyup', 'ShiftLeft', { ctrlKey: false, shiftKey: false })]);
  expect(r.swallowed).toEqual([true, true, true, true, true, true]);
  expect(r.effects.map((e) => e.t)).toEqual(['open', 'commit']);
  expect(r.state.phase).toBe('idle');
});
test('after the drain, the next ordinary key passes', ...);                   // ...then keydown KeyA {no mods} → swallow false
test('after Esc, with the modifiers still down, the chord key reopens', ...); // down K, down Esc, up Esc, up K, down K → second [open]
test('a tap: down, up, release → open then commit, nothing leaks', ...);      // down K, up K, up Control, up Shift → all swallowed, idle
test('an Alt combo opens only with Alt, and Alt may be released while stepping', ...);
test('a repeat of the chord key arriving while idle is swallowed without opening', ...);
test('a blur during the drain returns to idle', ...);
```

- [ ] **Step 2: Run red.** `npx vitest run test/agentSwitcherChord.test.js`.
- [ ] **Step 3: Implement** the table.
- [ ] **Step 4: Run green.** Plus `npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/web/agentSwitcherChord.ts test/agentSwitcherChord.test.js
git commit -m "feat(web): agent switcher chord reducer"
```

---

### Task 10: `agentSwitcherPreview.ts` — the preview scheduler, and the fetch layer

**Files:**
- Create: `src/web/agentSwitcherPreview.ts`
- Modify: `src/web/api.ts`
- Test: `test/agentSwitcherPreview.test.js` (new), `test/apiPanePreview.test.js` (new)

**Interfaces:**
- Produces:

```ts
// api.ts
export interface PaneSnapshot { ok: true; width: number; height: number; cursorX: number; cursorY: number; alt: boolean; mouse: boolean; content: string; agent: AgentState | null; agentCause: AgentCause | null; sessionName: string }
api.panePreview(boxId: string, session: string, signal?: AbortSignal): Promise<PaneSnapshot>   // GET /api/boxes/<id>/pane?session=<s>&lines=40
api.localPanePreview(signal?: AbortSignal): Promise<PaneSnapshot>                              // GET /api/local-shell/pane?lines=40

// agentSwitcherPreview.ts
export const PREVIEW_REST_MS = 250;
export const PREVIEW_CACHE_MS = 5000;
export type PreviewView = { t: 'idle' } | { t: 'loading' } | { t: 'text'; text: string } | { t: 'error' };
export interface PreviewDeps {
  fetch(target: { boxId: string; session: string }, signal: AbortSignal): Promise<string>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onChange(): void;                       // the view changed; the DOM half repaints
}
export function createPreviewScheduler(deps: PreviewDeps): {
  highlight(target: { boxId: string; session: string } | null): void;
  view(): PreviewView;
  dispose(): void;                        // clears the timer, aborts the request, drops the cache
};
```

- Behaviour: `highlight(target)` clears the pending rest timer and aborts the request in flight. `null` → `idle`. A cached text younger than `PREVIEW_CACHE_MS` shows at once with no fetch. Otherwise the view is `loading` and a `PREVIEW_REST_MS` timer starts; when it fires, one fetch starts with a fresh `AbortController`. A result for a target that is no longer highlighted is cached but not shown. A rejection that is not an abort shows `error` (only if still highlighted) and is not cached. At most one request is ever unsettled-and-unaborted.

- [ ] **Step 1: Write the failing tests.** A manual clock: `timers` array with `setTimer` pushing `{ fn, at }` and an `advance(ms)` helper; `fetch` records `{ target, signal }` and returns a promise the test resolves or rejects.

```js
test('no fetch while tapping: five highlights 100 ms apart fire nothing', ...);     // fetches.length === 0, view loading
test('resting 250 ms fires exactly one fetch for the last highlight', ...);
test('the text shows when it arrives', ...);                                         // view → { t: 'text', text }, onChange called
test('a newer highlight aborts the request in flight', ...);                         // fetches[0].signal.aborted === true
test('a result that arrives after the highlight moved is cached, not shown', ...);   // back within 5 s → text at once, still one fetch for that target
test('the cache expires after 5 s', ...);                                            // advance 5001 → loading, then a second fetch after the rest
test('a failure shows error and is retried on the next rest', ...);
test('an abort rejection is not an error', ...);                                     // reject with a DOMException named AbortError after moving on → view never 'error'
test('highlight(null) goes idle and aborts', ...);
test('dispose cancels the timer and the request', ...);                              // advance past the rest → no fetch; signal aborted
test('never two live requests at once', ...);                                        // across a scripted sequence, count of unsettled && !aborted ≤ 1
```

```js
// api: stub globalThis.fetch as test/webHttp.test.js does
test('panePreview asks for the session and 40 lines, and never for cols or rows', async () => {
  const calls = stubFetch(okJson({ ok: true, content: '' }));
  await api.panePreview('b1', 'side');
  expect(calls[0].url).toBe('/api/boxes/b1/pane?session=side&lines=40');
});
test('localPanePreview targets the Host Shell route', ...);       // '/api/local-shell/pane?lines=40'
test('both pass the abort signal through and route a 401 to the seam', ...);
```

- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement.** In `api.ts` use `j<PaneSnapshot>(await fetch(url, { signal }))`; encode both path and query values with `encodeURIComponent`.
- [ ] **Step 4: Run green.** `npx vitest run test/agentSwitcherPreview.test.js test/apiPanePreview.test.js test/webHttp.test.js && npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/web/agentSwitcherPreview.ts src/web/api.ts test/agentSwitcherPreview.test.js test/apiPanePreview.test.js
git commit -m "feat(web): agent switcher preview scheduler and capture fetches"
```

---

### Task 11: `agentSwitcherCommit.ts` — the commit planner

**Files:**
- Create: `src/web/agentSwitcherCommit.ts`
- Test: `test/agentSwitcherCommit.test.js` (new)

**Interfaces:**
- Consumes: `boxOfInstance`, `instanceId`, `nextOrdinal` (`stageLayout.ts`); `LOCAL_BOX` (Task 8).
- Produces:

```ts
export interface CommitInput {
  target: { boxId: string; session: string };
  panes: string[];                    // docked instance ids, layout order
  focused: string | null;
  parked: string[];                   // instances holding a terminal that are not docked
  sessionOf(iid: string): string;     // the session an instance is attached to; 'local' for the Host Shell
}
export type CommitPlan =
  | { kind: 'focus'; paneId: string }
  | { kind: 'switch'; paneId: string }                               // pane-local session switch on the occupant
  | { kind: 'replace'; occupant: string; iid: string; resetTab: boolean }
  | { kind: 'open'; iid: string; resetTab: boolean };
export function planCommit(i: CommitInput): CommitPlan;
```

- Rules, first match wins:
  1. A docked pane of `target.boxId` that is the Host Shell, or whose `sessionOf` is `target.session` → `focus`.
  2. Pick the instance: Host Shell → `__local__#1`, `resetTab: false`. Otherwise a `parked` instance of the box with `sessionOf === target.session` → it, `resetTab: false`. Otherwise `instanceId(boxId, nextOrdinal(boxId, panes))` (the lowest ordinal **not docked**), with `resetTab` true exactly when that instance is in `parked` (it holds a terminal on another session, which `ensureTab` would otherwise reuse).
  3. `panes` empty → `open`.
  4. Occupant = `focused` when it is docked, else `panes[0]`. Occupant on `target.boxId` → `switch`. Otherwise → `replace`.

- [ ] **Step 1: Write the failing tests.** `sess` is a plain map behind `sessionOf`.

```js
test('already open in a docked pane: focus it, even when it is not the focused pane', ...);
test('Host Shell docked is always a focus', ...);
test('same box, different session: switch the focused pane', ...);                 // { kind: 'switch', paneId: focused }
test('same box wins over a parked tab on that session', ...);                       // still 'switch'
test('different box: the focused pane is replaced by the box\'s lowest undocked ordinal', ...); // { kind: 'replace', occupant: 'x#1', iid: 'y#1', resetTab: false }
test('different box already docked on another session elsewhere: the next ordinal is used', ...); // panes ['x#1','y#1'], focused x#1, target (y, t2) → iid 'y#2'
test('a parked tab already on the target session is preferred over the lowest ordinal', ...);      // parked ['y#1' on t1, 'y#3' on t2] → iid 'y#3', resetTab false
test('a parked tab on a different session at the chosen ordinal must be reset', ...);              // parked ['y#1' on t1], target (y, t2) → iid 'y#1', resetTab true
test('no focused pane: the first pane is the occupant', ...);                       // focused null or not docked → occupant panes[0]
test('nothing docked: open as the first pane', ...);                                // { kind: 'open', iid: 'y#1', resetTab: false }
test('nothing docked and a parked tab on another session: open with a reset', ...);
test('Host Shell not docked takes the slot as __local__#1', ...);                   // replace, and open when nothing is docked
test('a Host Shell occupant is replaced like any pane', ...);
```

- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green.** Plus `npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/web/agentSwitcherCommit.ts test/agentSwitcherCommit.test.js
git commit -m "feat(web): agent switcher commit planner"
```

---

### Task 12: The switcher — overlay, key wiring, commit executor

**Files:**
- Create: `src/web/agentSwitcher.ts`, `test/e2e/agentSwitcher.spec.ts`
- Modify: `src/web/dom.ts`, `src/web/paneHeader.ts`, `src/web/terminal.ts`, `src/web/main.ts`, `src/web/style.css`, `test/e2e/phone.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 4-11.
- Produces:
  - `dom.ts`: `export function modalOpen(): boolean` — `openBackdrops.length > 0`.
  - `paneHeader.ts`: `buildPaneHeader(...)` also returns `closePicker(): void` (calls `picker?.close()`).
  - `terminal.ts`: `dispose(opts?: { release?: boolean })` — with `release`, the socket is closed as `ws.close(TERM_RELEASE_CODE, 'release')`.
  - `main.ts`: `closeTab(id, opts?: { keepPane?: boolean; release?: boolean })` passes `release` to `term.dispose`.
  - `agentSwitcher.ts`:

```ts
export interface AgentSwitcherDeps {
  enabled(): boolean;
  combo(): Combo;
  rows(): SwitcherRow[];                                   // built at open; the order is frozen from then on
  live(frozen: SwitcherRow[]): SwitcherRow[];
  onOpen(): void;
  commit(row: SwitcherRow): void;
  fetchPreview(target: { boxId: string; session: string }, signal: AbortSignal): Promise<string>;  // wired in Task 13
  now(): number;
}
export function createAgentSwitcher(deps: AgentSwitcherDeps): { isOpen(): boolean; refresh(): void; cancel(): void; destroy(): void };
```

  - DOM contract (the e2e selectors): root `#agent-switcher.agent-switcher` appended to `document.body`, carrying class `pending` for the first 150 ms (CSS `visibility: hidden`); `.agent-switcher-list` (`role="listbox"`); rows `.agent-switcher-row` (`role="option"`, `data-box`, `data-session`, `aria-selected`, class `gone` when gone) containing `.agent-switcher-chip.chip-agent-<state>` (`agentChipText`), `.agent-switcher-box`, `.agent-switcher-session`, `.agent-switcher-kind` (`AGENT_LABEL`), `.agent-switcher-age` (`fmtAge`), and on the pinned row `.agent-switcher-here` reading `this pane`; `.agent-switcher-empty` reading `No other agent sessions` when `initialIndex` is `-1`; `.agent-switcher-preview` (filled in Task 13). Every string goes in through `textContent`.

- [ ] **Step 1: Write the failing e2e spec** `test/e2e/agentSwitcher.spec.ts` (desktop project; fixture conventions and `login`/`onBox`/`writeMarker` copied from `agentStates.spec.ts`). Setup in `beforeAll`: on the box, sessions `sw-a` and `sw-b` each running `bash -c 'echo SWPREVIEW_A; exec -a claude sleep 600'` (`_B` for the second), markers `sw-a:working:<now-60>:prompt` and `sw-b:blocked:<now>:permission`; `afterAll` kills both and removes the markers. Each test starts from `localStorage.removeItem('tmuxifier.agentMru')`, `removeItem('tmuxifier.stageLayout')` and a reload. Facts to respect: the three seeded boxes are aliases of one tmux server, so every session is a row under each box; the e2e Host Shell reads the operator's real tmux, so a Host Shell row may exist. **Target rows by `data-box` + `data-session`, never by index or count.**

  Helpers: `boxIdOf(page, label)` via `page.evaluate` on `GET /api/boxes`; `chordTo(page, boxId, session)` holds Control+Shift, presses `KeyK` until `.agent-switcher-row[aria-selected="true"]` carries that pair (at most 12 presses, 30 ms apart), then releases Shift and Control; `termFrames(page)` collects, via `page.on('websocket')` + `framesent`, every sent frame on a `/term` socket whose JSON has `t === 'i'`, and records each socket's `close` event.

```ts
test('the chord opens, steps, and releases onto the highlighted session, replacing the focused pane', ...);
// dock localhost; chordTo(db-primary, sw-a) → one .stage-pane, its header names db-primary and its picker trigger reads sw-a;
// xterm rows contain SWPREVIEW_A; #agent-switcher is gone
test('the pane it replaces is released: its socket closes and tmux drops the client at once', ...);
// after the same hop: the localhost /term socket closed, and within 5 s
// onBox(`tmux list-clients -t '=${session}' -F x`) is empty (the grace window is 45 s)
test('a session already open in another pane just gets focus', ...);
// split localhost | db-primary(sw-a) by two hops + a dock; chordTo the docked one → .stage-pane.focused is that pane, pane count unchanged, no new /term socket
test('same box, another session: the focused pane switches session in place', ...);
// focused pane on localhost; chordTo(localhost, sw-b) → same pane count, trigger reads sw-b, xterm shows SWPREVIEW_B
test('a quick tap flips to the previous session and back', ...);
// hop to (localhost, sw-a), hop to (localhost, sw-b); then Control+Shift down, press KeyK once, release → sw-a; again → sw-b
test('holding the chord key scrolls the list', ...);
// Control+Shift down, keyboard.down('KeyK') held 700 ms → the selected row changed at least twice; Escape; release
test('ArrowDown and ArrowUp step while open, and wrap', ...);
test('Esc cancels: nothing moves and the overlay is gone', ...);
test('nothing docked: the session opens as the first pane', ...);           // from the standby dashboard
test('a parked tab on another session is not reused under the new header', ...);
// dock localhost (configured session), click #home to park it, chordTo(localhost, sw-a) → xterm shows SWPREVIEW_A, not the shell prompt
test('no chord key reaches the PTY, and plain Ctrl+K still does', async ({ page }) => {
  // frames = termFrames(page); focus a docked terminal; then: a tap; a held KeyK; ArrowDown/ArrowUp; Escape;
  // and Control released first while KeyK stays down for 400 ms, then KeyK and Shift up
  expect(frames.input).toEqual([]);
  await page.keyboard.press('Control+KeyK');
  await expect.poll(() => frames.input).toContainEqual(expect.objectContaining({ d: '\u000b' }));
});
test('while the switcher is open the arrows do not move pane focus; closed, Ctrl+Shift+Arrow still does', ...);
test('the hotkey is inert while a modal is open', ...);                     // open Settings, press the chord → #agent-switcher never attached
test('opening the switcher closes an open session picker', ...);
test('clicking a row commits to it', ...);
test('the order is frozen while open and a state change repaints the chip in place', ...);
// open and hold; rewrite sw-a's marker to blocked; expect that row's chip text to change while its DOM index stays the same
test('MRU survives a reload', ...);                                         // hop to sw-a, reload, a quick tap from another session lands on sw-a
test('window blur cancels', ...);                                           // hold the chord, dispatch a window blur, release → pane unchanged
test('logout tears the overlay down', ...);                                 // hold the chord past 150 ms, click #logout via page.evaluate → no #agent-switcher on the login screen
test('held past 150 ms the overlay is visible; after a quick tap nothing is left behind', ...);
// hold 400 ms → expect(#agent-switcher).toBeVisible() (visibility: hidden counts as not visible); tap-and-release → toHaveCount(0)
```

  One more, in `test/e2e/phone.spec.ts` (the phone project: 720 px flag and a coarse pointer):

```ts
test('the agent switcher is off on a phone', ...);   // dock a box, Control+Shift+KeyK → #agent-switcher never attached
```

  The "No other agent sessions" line has no e2e: the e2e server's Host Shell reads the operator's real tmux, so the list cannot be emptied reliably. `initialIndex === -1` is pinned in Task 8 and the line is part of the DOM contract above.

- [ ] **Step 2: Run red.** `npm run build && npx playwright test test/e2e/agentSwitcher.spec.ts --project=desktop` → every test fails (no overlay).

- [ ] **Step 3: Add the seams.** `modalOpen()` in `dom.ts`; `closePicker` on `buildPaneHeader`'s return; `dispose({ release })` in `terminal.ts` (import `TERM_RELEASE_CODE` from `./termClose`); `release` on `closeTab`.

- [ ] **Step 4: Implement `agentSwitcher.ts`.** One document-level **capture-phase** listener each for `keydown` and `keyup`, feeding `chordReduce` with `{ combo: deps.combo(), enabled: deps.enabled() }`; when the result says `swallow`, call `preventDefault()` and `stopPropagation()`. `window` `blur` and `document` `visibilitychange` (hidden) feed `{ t: 'blur' }`. Effects: `open` → `deps.onOpen()`, freeze `deps.rows()`, index = `initialIndex`, mount with `pending`, start the 150 ms timer; `step` → `stepIndex`, repaint selection, `scrollIntoView({ block: 'nearest' })`; `commit` → unmount, then `deps.commit(row)` unless the index is `-1` or the live row is `gone`; `cancel` → unmount. `refresh()` repaints rows from `deps.live(frozen)`. Rows get `mousedown` → `preventDefault()` (the terminal keeps focus) and `click` → `{ t: 'click', index }`. The overlay never takes focus.

- [ ] **Step 5: Wire `main.ts`.**
  - Module state: `let agentMru: string[]` loaded with `parseMru` from `localStorage` in try/catch; `let lastFocusPair = ''`; `let agentSwitcher: ReturnType<typeof createAgentSwitcher> | null`.
  - `noteFocusedSession()`: when `focusedPaneId` is docked, form `` `${focusedPaneId}\n${paneAgentSession(focusedPaneId)}` ``; if it differs from `lastFocusPair`, store it and `agentMru = bumpMru(agentMru, rowKey(boxOfInstance(iid), paneAgentSession(iid)))`, persisting in try/catch. When nothing is focused, clear `lastFocusPair`. Call it as the last line of **both** `repaintStage()` and `syncPaneFocus()` and nowhere else.
  - `commitSwitcherRow(row)`: `planCommit` with `panes: panesOf(stageRoot)`, `focused: focusedPaneId`, `parked: [...tabs.keys()].filter(not docked)`, `sessionOf: paneAgentSession`, then:
    - `focus`: `focusedPaneId = paneId; syncPaneFocus(); persistStage(); tabs.get(paneId)?.term.focus()`.
    - `switch`: `focusedPaneId = paneId; switchPaneSession(paneId, row.session)`.
    - `replace` / `open`: if `resetTab`, `closeTab(iid, { keepPane: true })`; for a non-local target set the override the way `openPane` does (configured session → `paneSessions.delete(iid)`, else `set`); `stageRoot = kind === 'open' ? iid : replacePane(stageRoot, occupant, iid)`; `focusedPaneId = iid`; for `replace`, `closeTab(occupant, { release: true })` **after** the `replacePane` (the occupant is then off the layout, so `closeTab` does not undock); `repaintStage()`.
  - Create the switcher once (same once-only guard style as `chordWired`): `enabled: () => !!app.querySelector('.layout') && !modalOpen() && !hotkeys.recording() && !(phoneCtl?.matches() ?? false) && !window.matchMedia('(pointer: coarse)').matches`; `combo: () => hotkeys.get('switcher')`; `rows: () => switcherRows({ boxes: allBoxes, series: latestSeries, mru: agentMru, focused: <focused pane's box and paneAgentSession, or null> })`; `live: (f) => liveRows(f, latestSeries)`; `onOpen: () => { for (const h of paneHeaders.values()) h.closePicker(); }`; `commit: commitSwitcherRow`; `now: () => Date.now()`; `fetchPreview: () => Promise.reject(new Error('preview not wired'))` until Task 13.
  - The existing pane-focus chord listener gets one new first line: `if (agentSwitcher?.isOpen()) return;`.
  - Call `agentSwitcher?.refresh()` right after each of the two `latestSeries = ...` assignments.
  - `teardownWorkspace()` calls `agentSwitcher?.cancel()` and clears `lastFocusPair`.

- [ ] **Step 6: Style.** Read `DESIGN.md` first. Layout option C of the mockup (https://claude.ai/artifact/JBbBnsAEhroxr6pTKeH2x1): a centred panel, list on the left, preview on the right; the mockup's literal values are not authoritative. Tokens only. Add `.agent-switcher-chip` to the four existing `.pane-chip.chip-agent-*` selector lists rather than restating their colors. Layer it above the stage and drawers and below `.modal-backdrop`. The selected row needs a non-color cue as well (an inset bar or weight change).

- [ ] **Step 7: Run green.** `npm test` (typecheck + unit, including `test/styleTokens.test.js`), then `npm run build && npx playwright test test/e2e/agentSwitcher.spec.ts --project=desktop` and `npx playwright test test/e2e/phone.spec.ts --project=phone -g "agent switcher"`. Then the neighbours that share the touched code: `npx playwright test test/e2e/split.spec.ts test/e2e/duplicatePanes.spec.ts test/e2e/agentStates.spec.ts test/e2e/sessionDropdown.spec.ts test/e2e/teardown.spec.ts --project=desktop`.

- [ ] **Step 8: Commit**

```bash
git add src/web/agentSwitcher.ts src/web/dom.ts src/web/paneHeader.ts src/web/terminal.ts src/web/main.ts src/web/style.css test/e2e/agentSwitcher.spec.ts test/e2e/phone.spec.ts
git commit -m "feat(ui): agent switcher on Ctrl+Shift+K"
```

---

### Task 13: The preview pane

**Files:**
- Modify: `src/web/agentSwitcher.ts`, `src/web/main.ts`, `src/web/style.css`
- Test: `test/e2e/agentSwitcher.spec.ts` (new `describe('preview')`)

**Interfaces:**
- Consumes: `createPreviewScheduler` (Task 10), `previewText` (Task 7), `api.panePreview`, `api.localPanePreview`.
- Produces: inside `.agent-switcher-preview`, a header `.agent-switcher-preview-head` (box label, session, state chip) and a body `.agent-switcher-preview-body` (a `<pre>` with `white-space: pre-wrap; overflow-wrap: anywhere`), carrying `data-view="idle|loading|text|error"`. Copy: loading → empty body; error → `Preview unavailable`.

- [ ] **Step 1: Write the failing e2e tests.** `paneRequests(page)` collects `page.on('request')` URLs matching `/pane?`; `seenPosts(page)` collects POSTs to `/agent-seen`.

```ts
test('tapping through rows fetches nothing; resting fetches once and shows the screen', async ({ page }) => {
  // hold the chord; six KeyK presses 60 ms apart → expect(paneRequests).toEqual([])
  // step to (localhost, sw-a) and rest → the body contains 'SWPREVIEW_A'; exactly one request
});
test('the request names the session and 40 lines and never sizes anything', ...);
// new URL(req).searchParams: session 'sw-a', lines '40', has('cols') false, has('rows') false, has('client') false
test('the preview is text, not markup, with escapes stripped', ...);
// sw-b's pane prints: printf '<b>bold</b> \033[31mred\033[0m\n' → body text contains '<b>bold</b> red'; body.querySelector('b') is null
test('highlighting and previewing a done session never marks it seen', ...);
// marker sw-a → ready/stop (done); from a pane on another session, hold the chord, rest on (localhost, sw-a) 1500 ms, Escape
// → seenPosts is empty and the sidebar badge still reads done
test('coming back to a row inside 5 s reuses the snapshot', ...);            // rest A, rest B, rest A again → two requests
test('a failed capture shows one line and the switcher still commits', ...);
// page.route('**/pane?**', (r) => r.fulfill({ status: 502, json: { error: 'boom' } })) → 'Preview unavailable'; release → the pane switched
test('a quick tap never fetches a preview', ...);
```

- [ ] **Step 2: Run red.** `npm run build && npx playwright test test/e2e/agentSwitcher.spec.ts --project=desktop -g preview`.

- [ ] **Step 3: Implement.** In `agentSwitcher.ts`, one scheduler per open (`dispose()` on unmount), `highlight()` called on open and on every step with the selected row (or `null` when there is none or it is `gone`), `onChange` repainting the preview. In `main.ts`, replace the Task 12 placeholder: `fetchPreview: async (t, signal) => previewText((t.boxId === '__local__' ? await api.localPanePreview(signal) : await api.panePreview(t.boxId, t.session, signal)).content, 40)`.

- [ ] **Step 4: Run green.** `npm test`, then `npm run build && npx playwright test test/e2e/agentSwitcher.spec.ts --project=desktop`.

- [ ] **Step 5: Commit**

```bash
git add src/web/agentSwitcher.ts src/web/main.ts src/web/style.css test/e2e/agentSwitcher.spec.ts
git commit -m "feat(ui): agent switcher preview of the highlighted session"
```

---

### Task 14: Settings → Hotkeys

**Files:**
- Create: `src/web/settingsHotkeys.ts`, `test/e2e/hotkeys.spec.ts`
- Modify: `src/web/settingsUi.ts` (`SettingsTab` union, `SECTIONS` — `hotkeys` after `appearance`), `src/web/style.css`

**Interfaces:**
- Consumes: `hotkeys`, `HOTKEY_LABEL`, `DEFAULT_HOTKEYS`, `comboLabel`, `validateRecorded` (Task 5).
- Produces: `renderHotkeysSection(content: HTMLElement): void` and `stopHotkeyRecording(): void` (the section's `dispose`: removes the record listener and clears the recording flag when the tab or the modal closes mid-record).
- DOM contract: one `.hotkey-row[data-action="switcher"|"voice"]` per action with `.hotkey-combo` (the label), `.hotkey-record` (button `Record`, reading `Press a combo…` and `aria-pressed="true"` while recording), `.hotkey-reset` (button `Reset to default`), `.hotkey-error` (`role="alert"`). Under the list, two `.pve-sub` paragraphs, exact copy:
  - `These mappings apply to this browser only.`
  - `Some browsers keep certain combos for themselves. Edge and Firefox on Windows use Ctrl+Shift+K for "duplicate tab" and the web console. If the switcher doesn't respond, record another combo.`
- Recording: a `document` capture-phase `keydown` listener that calls `preventDefault()` and `stopPropagation()` on **every** key it reads (so `openModal`'s document Esc handler and the Tab trap never see it). `Escape` cancels the recording. `validateRecorded` returning `null` keeps listening; a refusal shows its `reason` and keeps listening; an accepted combo is stored with `hotkeys.set`, shown, and ends the recording. `hotkeys.setRecording(true)` for exactly the recording's lifetime.

- [ ] **Step 1: Write the failing e2e spec** `test/e2e/hotkeys.spec.ts` (desktop). Each test starts with `localStorage.removeItem('tmuxifier.hotkeys')` and a reload; `openHotkeys(page)` clicks `#settings` then the tab `[data-tab="hotkeys"]`.

```ts
test('the Hotkeys tab is last and shows both defaults', ...);
// the last .pve-tab reads 'Hotkeys'; rows read 'Ctrl+Shift+K' and 'Ctrl+Shift+Space'; both notes are present
test('a remapped switcher combo works and the old one no longer opens it', ...);
// Record → Control+Shift+KeyY → label 'Ctrl+Shift+Y'; close Settings; the new chord attaches #agent-switcher; Control+Shift+KeyK does not
test('the mapping is stored per browser and survives a reload', ...);
// localStorage['tmuxifier.hotkeys'] parses to { v: 1, switcher: { alt: false, code: 'KeyY' }, voice: { alt: false, code: 'Space' } }; reload → still Y;
// no request to /api/ui-settings carried it (collect PATCH requests: none)
test('Esc while recording cancels the recording and leaves Settings open', ...);
// Record, Escape → .settings-modal still visible, the button reads Record again, the combo is unchanged; a second Escape closes Settings
test('refused combos say why and keep recording', ...);
// Control+KeyK → /must include Ctrl\+Shift/; Control+Shift+KeyC → /copy and paste/; Control+Shift+KeyT → 'Browsers keep Ctrl+Shift+T for themselves.';
// Control+Shift+Space (while recording the switcher) → /already used by Voice dictation/; then Control+Shift+KeyY is accepted
test('recording suppresses the live switcher hotkey', ...);     // Record on the voice row, press Control+Shift+KeyK → no #agent-switcher
test('Reset to default restores the combo', ...);
test('leaving the tab mid-record stops recording', ...);        // Record, click the Appearance tab, close Settings → the switcher chord works again
test('a stored mapping that is no longer valid falls back to the default', ...);
// seed localStorage with switcher KeyT, reload → the row reads Ctrl+Shift+K and that chord opens the switcher
```

- [ ] **Step 2: Run red.** `npm run build && npx playwright test test/e2e/hotkeys.spec.ts --project=desktop`.
- [ ] **Step 3: Implement** the section and register it: `hotkeys: { label: 'Hotkeys', render: (content) => renderHotkeysSection(content), dispose: stopHotkeyRecording }` as the last key of `SECTIONS`.
- [ ] **Step 4: Run green.** `npm test`, then `npm run build && npx playwright test test/e2e/hotkeys.spec.ts test/e2e/voice.spec.ts test/e2e/agentSwitcher.spec.ts --project=desktop`.
- [ ] **Step 5: Commit**

```bash
git add src/web/settingsHotkeys.ts src/web/settingsUi.ts src/web/style.css test/e2e/hotkeys.spec.ts
git commit -m "feat(settings): Hotkeys tab remaps the switcher and voice chords per browser"
```

---

### Task 15: Docs

**Files:**
- Modify: `docs/terminal.md`, `README.md`, `CLAUDE.md`, `AGENTS.md`

- [ ] **Step 1: `docs/terminal.md`.** A new section "Agent switcher and hotkeys" covering: hold Ctrl+Shift, tap K to step, ↑/↓, release to jump, a quick tap flips, Esc and focus loss cancel; what is listed (agent sessions on reachable boxes, the Host Shell's `local` session) and in what order; what release does (focus, switch in place, or replace the focused pane, whose terminal is closed and released at once); the preview; where it is off (phone mode, touch, open modals); Settings → Hotkeys with the validation rules and the per-browser note, including Edge and Firefox on Windows. In the existing voice section, replace the fixed "Ctrl+Shift+Space" wording with "the voice hotkey (Ctrl+Shift+Space by default, remappable in Settings → Hotkeys)". Mention that while the switcher is open Ctrl+Shift+Arrow steps the list instead of moving pane focus.

- [ ] **Step 2: `README.md`.** One feature line linking to the new section.

- [ ] **Step 3: `CLAUDE.md` and `AGENTS.md`** (kept in sync, same edits in both):
  - `server.js` → App/MCP reads: the pane route's `session` parameter (validated, 403 for a device token, `cols`/`rows` ignored, state from that session) and `GET /api/local-shell/pane` (browser session only, `local` session only, never creates it).
  - `server.js` → `/term`: close code `4000` (`TERM_RELEASE_CODE`) releases the viewer's PTY at once via `closeIfUnwatched`; every other close keeps the grace window.
  - Core: `singleFlight.js`. `boxActions.js`/`localShellActions.js`: `paneSnapshot` is single-flight per box, session and line count.
  - Web client: a new **Agent switcher** bullet (`agentSwitcher.ts` DOM half; `agentSwitcherList.ts`, `agentSwitcherChord.ts`, `agentSwitcherPreview.ts`, `agentSwitcherCommit.ts`, `ansiStrip.ts` pure halves; `hotkeys.ts`; `termClose.ts`), the MRU rule (`noteFocusedSession` called only from `repaintStage` and `syncPaneFocus`), `settingsHotkeys.ts` and the new tab order, and the voice hotkey reading its combo through a getter.
  - Load-bearing rules, one new entry: **The switcher never acknowledges and never sizes.** Its preview sends no `cols`/`rows`, renders `textContent` only, and only `reportSeen` after the jump raises the watermark; while it is open it owns Ctrl+Shift+↑/↓ and the pane-focus chord is inert.
  - Security notes → Device tokens: the pane route's `session` parameter and the Host Shell capture route are refused for device tokens.

- [ ] **Step 4: Verify.** `npm test` (some tests read these files), and `grep -n "agentSwitcher" CLAUDE.md AGENTS.md | wc -l` gives the same count for both files.

- [ ] **Step 5: Commit**

```bash
git add docs/terminal.md README.md CLAUDE.md AGENTS.md
git commit -m "docs: agent switcher, hotkeys, and the new browser-only server paths"
```

---

### Task 16: Full verification in the worktree

- [ ] **Step 1:** `npm test` → typecheck clean, every Vitest file green. Paste the summary line.
- [ ] **Step 2:** `npm run build` (in the worktree) → succeeds.
- [ ] **Step 3:** `npm run test:e2e` → both projects. Expected: green except the two baseline failures named under Workspace; anything else is this branch's to fix.
- [ ] **Step 4:** Control-byte scan of the new files (escape-heavy tests have landed raw bytes before): `grep -naP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' src/web/ansiStrip.ts src/web/agentSwitcher*.ts src/web/hotkeys.ts test/ansiStrip.test.js test/agentSwitcher*.test.js test/e2e/agentSwitcher.spec.ts` → no output.
- [ ] **Step 5:** PII scrub of the branch diff, the same review the ship checklist asks for: read `git diff main...HEAD` for real domains, public or LAN addresses, hostnames, emails and box names. Tests and docs may carry only placeholders (`example.com`, `192.168.1.x`).
- [ ] **Step 6:** Request a whole-branch code review (superpowers:requesting-code-review) against the spec and this plan's Review Focus list. Fix what it finds on the branch, rerun Steps 1-3.

---

### Task 17: Live validation (before merge)

Nothing merges until the operator has validated on the live app.

- [ ] **Step 1: Gate the restart.** No setup, provision, lifecycle, fleet, voice-install or apk-build job may be running:

```bash
cd /root/tmuxifier
grep -l '"status": *"running"' data/setup-jobs.json data/provision-jobs.json data/proxmox-lifecycle-jobs.json data/fleet-jobs.json data/voice-jobs.json data/apk-build-jobs.json 2>/dev/null
# no output = clear to restart; otherwise wait
```

- [ ] **Step 2: Deploy the candidate.** Built in the worktree (Task 16 Step 2), never in the main checkout:

```bash
W=/root/tmuxifier/.claude/worktrees/agent-switcher
rsync -a --delete "$W/dist/" /root/tmuxifier/dist/
cp "$W"/src/server/{server.js,sessions.js,boxActions.js,localShellActions.js,singleFlight.js} /root/tmuxifier/src/server/
sudo systemctl restart tmuxifier && systemctl status tmuxifier --no-pager | head -5
```

- [ ] **Step 3: Check it end to end.** A hashed asset must come back with its real content type, not the SPA fallback:

```bash
BASE="$(node -e "import('./src/server/config.js').then(({loadConfig})=>{const c=loadConfig();process.stdout.write(((c.tlsCert&&c.tlsKey)?'https':'http')+'://'+c.bindAddress+':'+c.port)})")"
curl -sk -o /dev/null -w '%{http_code}\n' "$BASE/"                          # 200
ASSET="$(curl -sk "$BASE/" | grep -o 'assets/[^"]*\.js' | head -1)"
curl -sk -o /dev/null -w '%{content_type}\n' "$BASE/$ASSET"                  # a javascript type, not text/html
```

- [ ] **Step 4: Hand over for validation.** Tell the operator it is live and give them this list. Wait for their answer.
  - macOS Helium: hold Ctrl+Shift, tap K, release → lands on the highlighted session; a quick tap flips between the last two; holding K scrolls; ↑/↓ step; Esc cancels.
  - The preview appears after resting on a row and shows the agent's screen as plain text.
  - Release onto a session on another box: the focused pane is replaced, and the session left behind raises its "needs you" notification again when it next blocks.
  - Plain Ctrl+K still kills to end of line in a shell and in Claude Code.
  - With two panes docked: Ctrl+Shift+Arrow moves pane focus when the switcher is closed, and steps the list when it is open.
  - Settings → Hotkeys: record a new combo, see a refusal explain itself, Esc while recording leaves Settings open, Reset works.
  - **Windows Chrome:** the default Ctrl+Shift+K opens the switcher; the default voice hotkey still toggles dictation.
  - **Windows Edge:** check whether Ctrl+Shift+K reaches the page or duplicates the tab. If Edge keeps it, record another combo there and confirm the Mac's mapping is unchanged.

- [ ] **Step 5: On a failed validation**, fix on the branch, rerun Task 16 Steps 1-3, and redeploy from Step 1. Rollback at any point: `git -C /root/tmuxifier checkout -- src/server && rm -f /root/tmuxifier/src/server/singleFlight.js`, then build `main` in a clean worktree, rsync its `dist/` over, and restart.

---

### Task 18: Merge and ship

Only after the operator confirms Task 17.

- [ ] **Step 1: Restore the main checkout and merge.**

```bash
cd /root/tmuxifier
git checkout -- src/server && rm -f src/server/singleFlight.js    # drop the hand-copied candidate files
git status --short                                                # clean
git merge --no-ff feat/agent-switcher -m "feat(ui): agent switcher (Ctrl+Shift+K) and Settings → Hotkeys"
```

- [ ] **Step 2: Run the ship checklist in `CLAUDE.md` ("Shipping") exactly as written**, top to bottom: restart gate again, `npm version patch --no-git-tag-version`, `npm run build` (the checklist's own build in the main checkout, followed immediately by the restart), `sudo systemctl restart tmuxifier`, the status and health checks, the three version assertions, `git add -A`, the staged-diff PII scrub, commit `chore(release): v<version>`, annotated tag, `git push origin main "$VERSION"`, `gh release create`, and the two remote verifications. Then repeat Task 17 Step 3's hashed-asset check.

- [ ] **Step 3: Clean up.** `git worktree remove .claude/worktrees/agent-switcher && git branch -d feat/agent-switcher`.
