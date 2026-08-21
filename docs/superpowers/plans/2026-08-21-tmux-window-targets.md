# tmux Window Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List every tmux window under its session in both session dropdowns (pane header, Edit Box modal) and switch the pane to a picked window.

**Architecture:** The status probe already run every poll gains one `tmux list-windows -a` line, so windows reach `/api/status` with no new SSH. A picked window is applied with `tmux select-window -t '@id'` through a new `POST /api/boxes/:id/window` — in tmux the current window is *session* state, so every attached client follows with no reattach and nothing is persisted. Picking a window in another session fires that route first, then the existing `sessionName` PATCH, so the forced reattach lands already on the chosen window.

**Tech Stack:** Node 20+ ESM server (`src/server/*.js`), TypeScript web client (`src/web/*.ts`), Fastify, vitest (`environment: 'node'` — **no DOM**), Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-08-21-tmux-window-targets-design.md`

## Global Constraints

- ESM everywhere (`"type": "module"`), Node 20+. Server files are `.js`; web client files are `.ts`.
- TDD: failing test first. Tests use **real code, not mocks** — inject fakes at the transport seam (`run`), never mock a module.
- vitest runs with `environment: 'node'`: there is **no DOM**. Pure functions get unit tests; DOM layers are verified by `npm run typecheck`, the existing e2e, and a browser pass.
- **Never run `npm run build` in `/root/tmuxifier` while the service is live** — the service serves this repo's own `dist/` and registers asset routes at boot, so a build renders the running app blank until a restart. Use `npm run typecheck` to check client edits. Building inside a worktree is fine.
- Conventional-commit messages (`feat(sessions): …`, `fix(pane): …`), one commit per task.
- The GitHub repo is public: no real hostnames, IPs, emails, or box names in code, tests, or docs. Use `192.168.1.10` / `example.com`.
- Never write a literal control byte into a source file. Escape sequences in test fixtures go in as `\x1b` / `\u0000`, never as the raw byte — a raw NUL makes git treat the file as binary and makes plain `grep -P` miss it. Check with `grep -naP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' <file>` before committing.
- tmux facts this plan relies on, verified on tmux 3.5a: window names may contain colons and session names may not; `#{window_id}` is `@N` and unique per server; `select-window -t '@1'` changes only that window's own session.

---

### Task 1: Windows in the status probe

**Files:**
- Modify: `src/server/sshCommand.js` (add `WINDOW_ID_RE` beside `SESSION_NAME_RE`, ~line 25)
- Modify: `src/server/status.js` (probe remote ~line 58, new parser + nesting helper, probe body ~line 210)
- Test: `test/status.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `WINDOW_ID_RE` (RegExp, from `sshCommand.js`); `parseTmuxWindows(stdout) -> { session: string, index: number, id: string, active: boolean, name: string }[]`; `attachWindows(sessions, windows) -> sessions`, each entry gaining an optional `windowList: { id, index, name, active }[]` (both exported from `status.js`). The `/api/status` snapshot's `sessions[]` entries gain `windowList`.

- [ ] **Step 1: Write the failing tests**

Append to `test/status.test.js`, and add `parseTmuxWindows, attachWindows` to the existing import on line 6:

```js
test('parseTmuxWindows maps one row per window and rejoins a colon-bearing name', () => {
  // Verified on tmux 3.5a: window names may contain colons ("we:ird name"),
  // session names may not — so the name is the LAST field and the tail rejoins.
  const out = [
    '__META__ load1=0.4',
    'web:2:1:1718000000:claude',
    '__WIN__ web:1:@0:0:zsh',
    '__WIN__ web:2:@3:1:we:ird name',
  ].join('\n');
  expect(parseTmuxWindows(out)).toEqual([
    { session: 'web', index: 1, id: '@0', active: false, name: 'zsh' },
    { session: 'web', index: 2, id: '@3', active: true, name: 'we:ird name' },
  ]);
});

test('parseTmuxWindows drops rows that fail the allowlist', () => {
  const out = [
    '__WIN__ web:1:nope:0:bad-id',
    '__WIN__ web:x:@1:0:bad-index',
    '__WIN__ web:1:@2:2:bad-active',
    '__WIN__ :1:@3:0:no-session',
    '__WIN__ web:1:@4',
    '__WIN__ web:1:@5:1:ok',
  ].join('\n');
  expect(parseTmuxWindows(out)).toEqual([
    { session: 'web', index: 1, id: '@5', active: true, name: 'ok' },
  ]);
});

test('parseTmuxWindows strips control characters and caps the name (box input reaching the UI)', () => {
  const out = `__WIN__ web:1:@1:0:a\x1b[31mb\n__WIN__ web:2:@2:0:${'x'.repeat(90)}`;
  const w = parseTmuxWindows(out);
  expect(w[0].name).toBe('a[31mb');
  expect(w[1].name).toHaveLength(64);
});

test('parseTmuxSessions ignores __WIN__ lines', () => {
  const out = 'web:2:1:1718000000:claude\n__WIN__ web:1:@0:1:zsh\n';
  expect(parseTmuxSessions(out)).toEqual([
    { name: 'web', windows: 2, attached: true, activity: 1718000000, paneCmd: 'claude' },
  ]);
});

test('attachWindows nests windows under their session and drops orphans', () => {
  const sessions = [{ name: 'web', windows: 2 }, { name: 'build', windows: 1 }];
  const windows = [
    { session: 'web', index: 1, id: '@0', active: true, name: 'zsh' },
    { session: 'gone', index: 1, id: '@9', active: true, name: 'orphan' },
  ];
  expect(attachWindows(sessions, windows)).toEqual([
    { name: 'web', windows: 2, windowList: [{ id: '@0', index: 1, name: 'zsh', active: true }] },
    { name: 'build', windows: 1 },
  ]);
});

test('the probe asks for windows by id, not index (indexes renumber between poll and click)', () => {
  expect(PROBE_REMOTE).toContain('list-windows -a');
  expect(PROBE_REMOTE).toContain('#{window_id}');
});

test('checkBox nests each session\'s windows into the snapshot', async () => {
  const stdout = [
    'web:2:1:1718000000:claude',
    '__WIN__ web:1:@0:0:zsh',
    '__WIN__ web:2:@1:1:claude',
  ].join('\n');
  const run = async () => ({ code: 0, stdout, stderr: '' });
  const status = await createStatusChecker({ run }).checkBox({ host: '192.168.1.10' });
  expect(status.sessions[0].windowList).toEqual([
    { id: '@0', index: 1, name: 'zsh', active: false },
    { id: '@1', index: 2, name: 'claude', active: true },
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/status.test.js`
Expected: FAIL — `parseTmuxWindows is not a function` (the import itself errors).

- [ ] **Step 3: Add the window-id rule**

In `src/server/sshCommand.js`, directly below the exported `SESSION_NAME_RE` (~line 25):

```js
// tmux's own window identifier: `@` plus digits, unique per tmux server and
// stable across the renumbering that `move-window` and window kills cause —
// which is why the UI addresses a window by id and never by `session:index`.
// The one authoritative statement of the rule: status.js parses against it and
// the select-window route re-validates against it before the value reaches a
// tmux target.
export const WINDOW_ID_RE = /^@\d{1,9}$/;
```

- [ ] **Step 4: Emit and parse the window lines**

In `src/server/status.js`, extend the import on line 1:

```js
import { buildProbeArgv, WINDOW_ID_RE } from './sshCommand.js';
```

Replace the `PROBE_REMOTE` export (~line 58) with:

```js
// One line per window on the box, appended to the same probe so windows cost no
// extra SSH. The name is LAST because window names may contain colons (verified
// on tmux 3.5a: "we:ird name") while session names may not — the invariant
// STATUS_FMT already relies on. `#{window_id}` rather than the index: indexes
// renumber between the poll that builds the dropdown and the click that uses it.
export const WINDOW_FMT = '#{session_name}:#{window_index}:#{window_id}:#{window_active}:#{window_name}';

export const PROBE_REMOTE =
  `${META_PROBE} ${AGENT_PROBE}if command -v tmux >/dev/null 2>&1; then tmux ls -F '${STATUS_FMT}' 2>/dev/null || true; ` +
  `tmux list-windows -a -F '__WIN__ ${WINDOW_FMT}' 2>/dev/null || true; else echo __NO_TMUX__; fi`;
```

Add the parser next to `parseAgentMarks`:

```js
// A window name is a string on the box, so it is input: control characters are
// stripped and the length capped before it can reach a <select> in the browser.
// parseAgentMarks' posture, for the same reason.
const cleanWindowName = (s) => s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64);

// Pull `__WIN__ <session>:<index>:<id>:<active>:<name>` lines into flat rows.
// Every field is allowlisted rather than trusted: a bad id, a non-numeric index
// or an active flag that is not 0/1 drops that row instead of the whole probe.
export function parseTmuxWindows(stdout) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.startsWith('__WIN__ ')) continue;
    const parts = line.slice('__WIN__ '.length).split(':');
    if (parts.length < 5) continue;
    const [session, indexRaw, id, activeRaw] = parts;
    const index = Number(indexRaw);
    if (!session || !WINDOW_ID_RE.test(id)) continue;
    if (!Number.isInteger(index) || index < 0) continue;
    if (activeRaw !== '0' && activeRaw !== '1') continue;
    out.push({ session, index, id, active: activeRaw === '1', name: cleanWindowName(parts.slice(4).join(':')) });
  }
  return out;
}

// Nest the flat rows under their session. A row whose session is not in the
// session list drops — the two tmux calls are not atomic, so a session created
// between them can appear in one and not the other. Windows keep tmux's own
// order: `list-windows -a` is index-ordered within each session.
export function attachWindows(sessions, windows) {
  if (!windows.length) return sessions;
  const bySession = new Map();
  for (const w of windows) {
    if (!bySession.has(w.session)) bySession.set(w.session, []);
    bySession.get(w.session).push({ id: w.id, index: w.index, name: w.name, active: w.active });
  }
  return sessions.map((s) => (bySession.has(s.name) ? { ...s, windowList: bySession.get(s.name) } : s));
}
```

Extend `parseTmuxSessions`'s line filter (it already skips `__META__` and `__AGENT__`):

```js
    .filter((l) => l.trim() && !l.includes('__NO_TMUX__') && !l.startsWith('__META__') && !l.startsWith('__AGENT__') && !l.startsWith('__WIN__'))
```

In `probe()` (~line 210), nest the windows into the session list:

```js
      const base = String(res.stdout).includes('__NO_TMUX__')
        ? { reachable: true, tmux: false, sessions: [] }
        : { reachable: true, tmux: true, sessions: attachWindows(parseTmuxSessions(res.stdout), parseTmuxWindows(res.stdout)) };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/status.test.js`
Expected: PASS, pre-existing tests in the file included — `parseTmuxSessions`'s shape is unchanged for a box with no `__WIN__` lines.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. `healthHistory` reads `name`/`activity`/`paneCmd` off these entries and the addition is nested and additive, so nothing else moves.

- [ ] **Step 7: Commit**

```bash
grep -naP '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' src/server/status.js test/status.test.js   # expect no output
git add src/server/sshCommand.js src/server/status.js test/status.test.js
git commit -m "feat(status): probe every session's tmux windows by window id"
```

---

### Task 2: The select-window route

**Files:**
- Modify: `src/server/boxActions.js` (new builder after `buildEnsureSessionRemote`, ~line 480)
- Modify: `src/server/server.js` (imports lines 11-12, route after `POST /api/boxes/:id/sessions` ~line 918)
- Test: `test/windowSelectRoute.test.js` (create)

**Interfaces:**
- Consumes: `WINDOW_ID_RE` from `sshCommand.js` (Task 1).
- Produces: `buildSelectWindowRemote(windowId) -> string` (exported from `boxActions.js`); `POST /api/boxes/:id/window` with body `{ windowId: '@7' }` returning `{ ok: true, windowId }`.

- [ ] **Step 1: Write the failing tests**

Create `test/windowSelectRoute.test.js` — modelled on `test/sessionCreateRoute.test.js`, with real `createBoxActions` over a fake `run` seam so the argv building and quoting under test are the real code:

```js
import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { hashPassword } from '../src/server/auth.js';

let app, dir, calls, boxId, failNext, setupRunning;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-win-'));
  calls = [];
  failNext = false;
  const run = async (argv) => {
    calls.push(argv);
    if (failNext) { failNext = false; return { code: 1, stdout: '', stderr: 'no such window' }; }
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
  app = buildServer({ config, store, sessions, statusChecker, boxActions, setupManager });
});

async function headers() {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = res.cookies.find((x) => x.name === 'tmuxifier_session');
  return { cookie: `${c.name}=${c.value}` };
}

test('POST window selects the window by its tmux id', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { windowId: '@7' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, windowId: '@7' });
  const remote = calls.map((argv) => argv[argv.length - 1]).find((r) => r.includes('select-window'));
  expect(remote).toContain("select-window -t '@7'");
});

test('POST window rejects anything that is not a tmux window id, without touching ssh', async () => {
  const h = await headers();
  // The id becomes a tmux target, so it is re-validated here rather than
  // trusted from the client that read it out of a status snapshot.
  for (const windowId of ['', '7', 'web:1', '@1;rm -rf /', "@1'", '@' + '9'.repeat(10), 42, null, undefined]) {
    const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { windowId } });
    expect(res.statusCode).toBe(400);
  }
  expect(calls.length).toBe(0);
});

test('POST window is refused while the box\'s setup job is running', async () => {
  const h = await headers();
  setupRunning = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { windowId: '@1' } });
  expect(res.statusCode).toBe(409);
  expect(calls.length).toBe(0);
});

test('POST window 404s on an unknown box', async () => {
  const h = await headers();
  const res = await app.inject({ method: 'POST', url: '/api/boxes/nope/window', headers: h, payload: { windowId: '@1' } });
  expect(res.statusCode).toBe(404);
});

test('POST window maps a vanished window to 502', async () => {
  const h = await headers();
  failNext = true;
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, headers: h, payload: { windowId: '@1' } });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toContain('no such window');
});

test('POST window requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: `/api/boxes/${boxId}/window`, payload: { windowId: '@1' } });
  expect(res.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/windowSelectRoute.test.js`
Expected: FAIL — every request 404s (the route does not exist yet).

- [ ] **Step 3: Add the remote builder**

In `src/server/boxActions.js`, immediately after `buildEnsureSessionRemote`, and add `WINDOW_ID_RE` to the file's existing `sshCommand.js` import:

```js
// Switch a session's current window. The id is validated by the route and again
// here before quoting, then targeted directly: `-t '@7'` needs no `=`-prefixed
// exact match because a window id is already exact, unlike the session names
// buildEnsureSessionRemote has to guard against prefix-matching. tmux is
// resolved the same way as there — this runs under whatever PATH the box's
// non-interactive shell provides.
export function buildSelectWindowRemote(windowId) {
  if (!WINDOW_ID_RE.test(String(windowId))) throw new Error('invalid window id');
  const id = shSingleQuote(String(windowId));
  return [
    'set -eu',
    'TMUX_BIN="$(command -v tmux || true)"',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for p in /usr/bin/tmux /usr/local/bin/tmux /bin/tmux; do if [ -x "$p" ]; then TMUX_BIN="$p"; break; fi; done',
    'fi',
    '[ -n "$TMUX_BIN" ]',
    `"$TMUX_BIN" select-window -t ${id}`,
  ].join('\n');
}
```

- [ ] **Step 4: Add the route**

In `src/server/server.js`, extend the imports on lines 11-12:

```js
import { buildEnsureTmuxRemote, buildEnsureSessionRemote, buildSelectWindowRemote, resolveTools } from './boxActions.js';
import { assertBoxSafe, SESSION_NAME_RE, WINDOW_ID_RE } from './sshCommand.js';
```

Add the route directly after `POST /api/boxes/:id/sessions`:

```js
  // Switch the box's ACTIVE WINDOW inside its tmux session. Unlike a session
  // switch — PATCH sessionName, which drops every viewer's PTY so they reattach
  // — this needs no reattach at all: in tmux the current window is *session*
  // state, so every client attached to that session follows the moment
  // select-window returns. Nothing is persisted; boxes.json still stores only
  // the session name, deliberately, because a stored window would fight
  // prefix-n on the next reconnect.
  app.post('/api/boxes/:id/window', { preHandler: requireAuth }, async (req, reply) => {
    const box = await store.getBox(req.params.id);
    if (!box) return reply.code(404).send({ error: 'box not found' });
    // Same gate as /term, the sizing viewer and the session-create route: a box
    // mid-setup has no environment worth steering into.
    if (setupManager?.currentForBox(box.id)?.status === 'running') {
      return reply.code(409).send({ error: 'box setup is still running' });
    }
    const windowId = (req.body || {}).windowId;
    // The client read this id out of a status snapshot, but it becomes a tmux
    // target, so it is re-validated here — the chokepoint discipline
    // iconCatalog.js and voiceCatalog.js apply to their own allowlists.
    if (typeof windowId !== 'string' || !WINDOW_ID_RE.test(windowId)) {
      return reply.code(400).send({ error: 'window id must look like @7' });
    }
    if (!boxActions?.execCommand) return reply.code(503).send({ error: 'window switching unavailable' });
    const res = await boxActions.execCommand(box, buildSelectWindowRemote(windowId), { timeoutMs: 15000 });
    // A window that vanished between the poll and the click lands here; the next
    // status poll rebuilds the dropdown without it.
    if (!res || res.code !== 0) {
      return reply.code(502).send({ error: String(res?.stderr || '').trim() || 'failed to select window' });
    }
    return { ok: true, windowId };
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/windowSelectRoute.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/boxActions.js src/server/server.js test/windowSelectRoute.test.js
git commit -m "feat(sessions): add POST /api/boxes/:id/window to select a tmux window"
```

---

### Task 3: The pure dropdown model

**Files:**
- Modify: `src/web/api.ts` (`Status` type, ~line 35)
- Modify: `src/web/paneHeader.ts` (replace `sessionOptions`, ~lines 24-90)
- Test: `test/paneHeader.test.js`

**Interfaces:**
- Consumes: the `windowList` shape from Task 1.
- Produces, all exported from `paneHeader.ts`:
  - `interface SessionTarget { kind: 'session' | 'window'; value: string; label: string; session: string; windowId?: string; disabled?: boolean; title?: string }`
  - `interface SessionTargetList { options: SessionTarget[]; value: string }`
  - `sessionTargets(status: Status | undefined, sessionName: string | undefined): SessionTarget[]`
  - `sessionTargetList(status, sessionName): SessionTargetList`
  - `WINDOW_INDENT` (string)
  - `PaneHeaderModel.targets: SessionTargetList | null` **replaces** `PaneHeaderModel.sessions`
  From `api.ts`: `interface TmuxWindow { id: string; index: number; name: string; active: boolean }`.

- [ ] **Step 1: Write the failing tests**

In `test/paneHeader.test.js`, replace the whole `sessionOptions` block (lines 59-82) with the following, and change the import on line 2 to `import { paneHeaderModel, paneHeaderChip, sessionTargets, sessionTargetList, WINDOW_INDENT, isSwitchableSession, SESSION_NAME_RE } from '../src/web/paneHeader.ts';`:

```js
// --- sessionTargets: the dropdown's pure, hierarchical option list ----------

const win = (id, index, name, active = false) => ({ id, index, name, active });

test('sessionTargets lists the configured session first, its windows indented beneath it', () => {
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'proj2', windows: 1, windowList: [win('@5', 1, 'zsh')] },
    { name: 'web', windows: 2, windowList: [win('@0', 1, 'zsh'), win('@1', 2, 'claude', true)] },
  ] };
  expect(sessionTargets(status, 'web').map((t) => [t.kind, t.value, t.label])).toEqual([
    ['session', 's:web', 'web'],
    ['window', 'w:@0', `${WINDOW_INDENT}1: zsh`],
    ['window', 'w:@1', `${WINDOW_INDENT}2: claude`],
    ['session', 's:proj2', 'proj2'],
    ['window', 'w:@5', `${WINDOW_INDENT}1: zsh`],
  ]);
});

test('sessionTargets keeps the configured session offered when tmux no longer lists it', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'other', windows: 1 }] };
  expect(sessionTargets(status, 'gone').map((t) => t.value)).toEqual(['s:gone', 's:other']);
});

test('sessionTargets with no snapshot still offers the configured session, defaulting to web', () => {
  expect(sessionTargets(undefined, 'main').map((t) => t.value)).toEqual(['s:main']);
  expect(sessionTargets(undefined, undefined).map((t) => t.value)).toEqual(['s:web']);
});

test('sessionTargets drops empty session names from the live list', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: '', windows: 1 }, { name: 'a', windows: 1 }] };
  expect(sessionTargets(status, 'a').map((t) => t.value)).toEqual(['s:a']);
});

test('sessionTargets names an unnamed window rather than rendering a bare index', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'web', windows: 1, windowList: [win('@0', 3, '')] }] };
  expect(sessionTargets(status, 'web')[1].label).toBe(`${WINDOW_INDENT}3: window`);
});

test('sessionTargets disables an unswitchable session AND its windows', () => {
  // store.js's sanitizeSession would rewrite a PATCHed 'my session' and the
  // reattach would create a fresh mangled-name session instead of attaching.
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'web', windows: 1 },
    { name: 'my session', windows: 1, windowList: [win('@4', 1, 'vim')] },
  ] };
  const t = sessionTargets(status, 'web');
  expect(t.find((x) => x.value === 's:my session').disabled).toBe(true);
  expect(t.find((x) => x.value === 'w:@4').disabled).toBe(true);
});

test('sessionTargets leaves the CURRENT session\'s windows selectable whatever its name', () => {
  // A window inside the session the box is already attached to needs no PATCH,
  // so the session-name charset rule does not bind it.
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'my session', windows: 1, windowList: [win('@4', 1, 'vim')] },
  ] };
  const t = sessionTargets(status, 'my session');
  expect(t.find((x) => x.value === 'w:@4').disabled).toBeUndefined();
});

test('sessionTargetList selects the current session\'s active window', () => {
  const status = { reachable: true, tmux: true, sessions: [
    { name: 'web', windows: 2, windowList: [win('@0', 1, 'zsh'), win('@1', 2, 'claude', true)] },
  ] };
  expect(sessionTargetList(status, 'web').value).toBe('w:@1');
});

test('sessionTargetList falls back to the session row when no active window is known', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'web', windows: 2 }] };
  expect(sessionTargetList(status, 'web').value).toBe('s:web');
  expect(sessionTargetList(undefined, 'web').value).toBe('s:web');
});

test('paneHeaderModel exposes the target list only for a live terminal pane on a real box', () => {
  const status = { reachable: true, tmux: true, sessions: [{ name: 'web', windows: 1 }] };
  expect(paneHeaderModel(box({ status, sessionName: 'web' })).targets.options.length).toBe(1);
  expect(paneHeaderModel(box({ status, state: 'stopped' })).targets).toBeNull();
  expect(paneHeaderModel({ local: true, label: 'Host Shell', state: 'terminal' }).targets).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/paneHeader.test.js`
Expected: FAIL — `sessionTargets is not a function`.

- [ ] **Step 3: Add the window type to the client Status**

In `src/web/api.ts`, above `interface Status` (~line 32):

```ts
// One tmux window, as the status probe reports it (status.js parseTmuxWindows).
// `id` is tmux's own `@N` — stable across the renumbering `move-window` causes,
// which `index` is not, so the id is what the UI acts on and the index is only
// ever displayed.
export interface TmuxWindow { id: string; index: number; name: string; active: boolean }
```

and extend the `sessions` field:

```ts
  nextProbeAt?: number; sessions?: { name: string; windows: number; attached?: boolean; activity?: number; paneCmd?: string; windowList?: TmuxWindow[] }[];
```

- [ ] **Step 4: Replace sessionOptions with the target model**

In `src/web/paneHeader.ts`: change the type import to `import type { Status, TmuxWindow } from './api';`, replace the `sessions` field of `PaneHeaderModel` with `targets: SessionTargetList | null`, and replace `sessionOptions` (~lines 79-88) with:

```ts
// One row of the session dropdown. A row is either a session or one of its
// windows; `value` is the <option> value and `session` is the session the row
// resolves to, so a caller never has to re-derive which session a window is in.
export interface SessionTarget {
  kind: 'session' | 'window';
  value: string;        // 's:<session>' | 'w:<@id>'
  label: string;
  session: string;
  windowId?: string;
  disabled?: boolean;
  title?: string;       // why it is disabled
}
export interface SessionTargetList { options: SessionTarget[]; value: string }

// <option> cannot be styled, so the hierarchy is text — the same concession the
// unswitchable-name rule already makes. Non-breaking spaces: a native select
// collapses ordinary leading whitespace.
export const WINDOW_INDENT = '  → ';

const UNSWITCHABLE = 'name not switchable from here (allowed: letters, digits, _ -)';

// The dropdown's rows: the box's configured session first (always present — it
// is the selected value, and it must stay offered even when tmux no longer
// lists it), its windows indented beneath it, then every other live session
// followed by its own windows.
export function sessionTargets(status: Status | undefined, sessionName: string | undefined): SessionTarget[] {
  const current = sessionName || 'web'; // store.js defaults an absent name to 'web'
  const live = (status?.sessions ?? []).filter((s) => s.name);
  const currentLive = live.find((s) => s.name === current);
  const rows: { name: string; windowList?: TmuxWindow[] }[] = [
    currentLive ?? { name: current },
    ...live.filter((s) => s.name !== current),
  ];
  const out: SessionTarget[] = [];
  for (const s of rows) {
    // Switching to a live session whose name is outside the charset would
    // silently rename it: store.js's sanitizeSession rewrites the PATCHed name
    // and the reattach then creates a fresh mangled-name session. Offered but
    // disabled — the session is real, only unswitchable from here. Windows
    // inherit that, EXCEPT the current session's, which need no PATCH at all.
    const locked = s.name !== current && !isSwitchableSession(s.name);
    const lock = locked ? { disabled: true, title: UNSWITCHABLE } : {};
    out.push({ kind: 'session', value: `s:${s.name}`, label: s.name, session: s.name, ...lock });
    for (const w of s.windowList ?? []) {
      out.push({
        kind: 'window',
        value: `w:${w.id}`,
        label: `${WINDOW_INDENT}${w.index}: ${w.name || 'window'}`,
        session: s.name,
        windowId: w.id,
        ...lock,
      });
    }
  }
  return out;
}

// The rows plus the one that is selected: the current session's ACTIVE window
// when the snapshot knows it, else the session row. This is what makes the
// header answer "which window am I looking at" rather than only naming the
// session the pane belongs to.
export function sessionTargetList(status: Status | undefined, sessionName: string | undefined): SessionTargetList {
  const current = sessionName || 'web';
  const active = (status?.sessions ?? []).find((s) => s.name === current)?.windowList?.find((w) => w.active);
  return { options: sessionTargets(status, sessionName), value: active ? `w:${active.id}` : `s:${current}` };
}
```

In `paneHeaderModel`, replace the `sessions:` line with:

```ts
    // Only a live terminal pane on a real box offers the switch: the local
    // shell's session is config, and a stopped/setting-up pane has no attach to
    // move.
    targets: !i.local && i.state === 'terminal' ? sessionTargetList(i.status, i.sessionName) : null,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/paneHeader.test.js`
Expected: PASS. `npm run typecheck` still fails at this point — `main.ts` and `buildPaneHeader` still speak `model.sessions`; Task 4 fixes both.

- [ ] **Step 6: Commit**

```bash
git add src/web/api.ts src/web/paneHeader.ts test/paneHeader.test.js
git commit -m "feat(pane): model tmux windows as hierarchical dropdown targets"
```

---

### Task 4: Header dropdown renders and acts on windows

**Files:**
- Modify: `src/web/paneHeader.ts` (`PaneHeaderActions`, `buildPaneHeader`, `update`)
- Modify: `src/web/api.ts` (`selectWindow` fetcher, after `createSession` ~line 266)
- Modify: `src/web/main.ts` (`selectTarget` after `switchSession` ~line 865, header wiring ~line 889)
- Modify: `src/web/style.css` (`.pane-header .pane-session` max-width, ~line 1027)

**Interfaces:**
- Consumes: `SessionTarget`, `SessionTargetList`, `PaneHeaderModel.targets` (Task 3); `POST /api/boxes/:id/window` (Task 2).
- Produces: `PaneHeaderActions.onSelectTarget?: (target: SessionTarget) => void` **replaces** `onSelectSession`; `api.selectWindow(id: string, windowId: string): Promise<{ ok: boolean; windowId: string }>`.

- [ ] **Step 1: Add the client fetcher**

In `src/web/api.ts`, directly after `createSession`:

```ts
  // Switch which window the box's tmux session is showing. Not a PATCH of the
  // box: nothing is persisted, and every client attached to that session
  // follows without a reattach (tmux's current window is session state).
  async selectWindow(id: string, windowId: string) {
    return j<{ ok: boolean; windowId: string }>(await fetch(`/api/boxes/${id}/window`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ windowId }) }));
  },
```

- [ ] **Step 2: Render targets in the header select**

In `src/web/paneHeader.ts`, replace `onSelectSession` in `PaneHeaderActions` with:

```ts
  // Switch which session/window this pane shows. Non-destructive (the old
  // session keeps running on the box, and a window switch does not even drop
  // the attach), so unlike Reconnect this is a plain callback: no arm-then-fire.
  onSelectTarget?: (target: SessionTarget) => void;
```

Replace the `if (actions.onSelectSession) { … }` block in `buildPaneHeader` with:

```ts
  let sessionSel: HTMLSelectElement | null = null;
  // The rows currently rendered, so the change handler can resolve a value back
  // to its target without re-deriving which session a window belongs to.
  let rendered: SessionTarget[] = [];
  if (actions.onSelectTarget) {
    sessionSel = document.createElement('select');
    sessionSel.className = 'pane-session';
    sessionSel.title = 'Active tmux session and window';
    sessionSel.setAttribute('aria-label', 'Active tmux session and window');
    sessionSel.addEventListener('click', (e) => e.stopPropagation());
    // Blur before acting: a native select keeps focus after `change`, and the
    // focused-select guard in update() below (rightly) refuses to touch a
    // focused select — so without this, a failed switch could never snap the
    // value back and the header would keep showing a switch that never
    // happened. On success the repaint rebuilds the header anyway.
    sessionSel.addEventListener('change', () => {
      const target = rendered.find((t) => t.value === sessionSel!.value);
      sessionSel!.blur();
      if (target) actions.onSelectTarget!(target);
    });
  }
```

and replace the `if (sessionSel) { … }` block inside `update` with:

```ts
    if (sessionSel) {
      const list = m.targets?.options ?? [];
      sessionSel.hidden = list.length === 0;
      // Never rebuild under the user: this runs on every status poll, and
      // repopulating a native select while its dropdown is open slams it shut
      // mid-pick. The focused select keeps its current options until blur.
      if (document.activeElement !== sessionSel) {
        const key = list.map((t) => `${t.value}\t${t.label}\t${t.disabled ? 1 : 0}`).join('\n');
        if (sessionSel.dataset.opts !== key) {
          sessionSel.dataset.opts = key;
          rendered = list;
          sessionSel.replaceChildren(...list.map((t) => {
            const o = document.createElement('option');
            o.value = t.value;
            o.textContent = t.label;
            if (t.disabled) { o.disabled = true; if (t.title) o.title = t.title; }
            return o;
          }));
        }
        sessionSel.value = m.targets?.value ?? '';
      }
    }
```

- [ ] **Step 3: Wire it in main.ts**

Add `selectTarget` immediately after `switchSession` (~line 865) — `switchSession` itself is unchanged, it still owns the session half:

```ts
// Act on a pane-header dropdown pick. A window in the box's CURRENT session is
// the cheap case: select-window alone, no PATCH, no PTY kill — every client
// attached to that session follows on its own. A pick in another session needs
// both, window first: switchSession's PATCH drops every viewer's PTY, so
// selecting the window beforehand means the forced reattach lands already on it.
async function selectTarget(id: string, t: SessionTarget) {
  const box = allBoxes.find((b) => b.id === id);
  if (!box) return;
  if (t.kind === 'window' && t.windowId) {
    try {
      await api.selectWindow(id, t.windowId);
    } catch {
      // The window vanished between the poll and the click (502) or the box is
      // mid-setup (409): repaint so the select snaps back rather than showing a
      // switch that never happened.
      updatePaneHeaders();
      return;
    }
  }
  if ((box.sessionName || 'web') !== t.session) { await switchSession(id, t.session); return; }
  // Same session: nothing was persisted, so pull a fresh snapshot to move the
  // selected row onto the window that is now active.
  if (t.kind === 'window') fastStatusPoll(id);
  else updatePaneHeaders();
}
```

Add `SessionTarget` to the existing `paneHeader` import, and replace the header action wiring (~line 889):

```ts
        // The model is the single authority on whether a switch is on offer
        // (non-local terminal pane): gate the callback on it rather than
        // re-encoding that rule here.
        ...(model.targets ? { onSelectTarget: (t: SessionTarget) => void selectTarget(id, t) } : {}),
```

- [ ] **Step 4: Give the select room for a window label**

In `src/web/style.css` (~line 1027), widen the cap — the selected row is now `→ 2: claude` rather than a bare session name:

```css
  flex: 0 1 auto; min-width: 0; max-width: 18ch;
```

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS. Typecheck is the gate that proves every `model.sessions` / `onSelectSession` reference is gone — vitest has no DOM, so it cannot catch that.

- [ ] **Step 6: Commit**

```bash
git add src/web/api.ts src/web/paneHeader.ts src/web/main.ts src/web/style.css
git commit -m "feat(pane): switch tmux windows from the header dropdown"
```

---

### Task 5: The Edit modal's consolidated dropdown

**Files:**
- Modify: `src/web/main.ts` (session field ~lines 2168-2303, both submit branches ~lines 2400 and 2432)
- Modify: `src/web/style.css` (drop `.session-picker`/`.session-chip` ~lines 610-617, add `.session-select`)

**Interfaces:**
- Consumes: `sessionTargets`, `SessionTarget` (Task 3); `api.selectWindow` (Task 4).
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Replace the chip strip with a select**

In `src/web/main.ts`, delete the `sessionPicker` element and the whole `applySessions(names: string[])` function (~lines 2188-2208) and put this in their place. `sessionInput` stays, but becomes the **custom-name** input, hidden unless the `Custom name…` row is picked:

```ts
  // One control for the whole choice: every live session with its windows
  // indented beneath it (the pane header's own pure model, reused so the two
  // surfaces cannot drift), plus a Custom name… row that reveals the free-text
  // input for a session that does not exist yet.
  const CUSTOM = '__custom__';
  const sessionSelect = document.createElement('select');
  sessionSelect.className = 'session-select';
  sessionSelect.setAttribute('aria-label', 'tmux session or window');
  let targets: SessionTarget[] = [];

  function applySessions(status: Status | undefined) {
    targets = sessionTargets(status, sessionInput.value.trim() || (isEdit ? box!.sessionName : '') || 'web');
    const keep = sessionSelect.value;
    const custom = document.createElement('option');
    custom.value = CUSTOM;
    custom.textContent = 'Custom name…';
    sessionSelect.replaceChildren(...targets.map((t) => {
      const o = document.createElement('option');
      o.value = t.value;
      o.textContent = t.kind === 'session' && t.session === 'web' ? 'web (default)' : t.label;
      // Add mode has no box to run select-window against, so a window is shown
      // for orientation but cannot be acted on — disabled-not-hidden, the same
      // treatment an unswitchable session name gets: the window is real, just
      // not actionable from a box that does not exist yet.
      if (t.disabled || (!isEdit && t.kind === 'window')) {
        o.disabled = true;
        o.title = t.title ?? 'add the box first, then switch windows from the pane header';
      }
      return o;
    }), custom);
    sessionSelect.value = targets.some((t) => t.value === keep) || keep === CUSTOM ? keep : (targets[0]?.value ?? CUSTOM);
    syncCustom();
  }

  // The free-text input is only in play under Custom name…; otherwise the
  // selected row IS the value, so leaving the input visible would present two
  // fields that disagree.
  function syncCustom() {
    sessionInput.hidden = sessionSelect.value !== CUSTOM;
  }

  // What Save writes. One reader for both submit branches so add and edit
  // cannot drift.
  function sessionFieldValue(): string {
    if (sessionSelect.value === CUSTOM) return sessionInput.value.trim() || 'web';
    return targets.find((t) => t.value === sessionSelect.value)?.session || 'web';
  }

  sessionSelect.addEventListener('change', () => {
    syncCustom();
    if (sessionSelect.value === CUSTOM) { sessionInput.focus(); return; }
    const t = targets.find((x) => x.value === sessionSelect.value);
    // A window pick acts immediately, exactly as it does in the pane header —
    // it is a live tmux action, not form state, and nothing about it is saved.
    // The session half still rides Save like every other field.
    if (isEdit && t?.kind === 'window' && t.windowId) {
      sessionHint.className = 'session-hint';
      sessionHint.textContent = `switching to ${t.label.trim()}…`;
      api.selectWindow(box!.id, t.windowId)
        .then(() => { sessionHint.textContent = `showing ${t.label.trim()}`; })
        .catch((e: any) => {
          sessionHint.textContent = e?.message || 'window switch failed';
          sessionHint.className = 'session-hint err';
        });
    }
  });
```

- [ ] **Step 2: Rewire the surrounding assembly and the probe**

Still in `src/web/main.ts`.

Replace the row assembly (~line 2260) so the select leads and the custom input sits under it:

```ts
  sessionRow.append(sessionSelect, sessionRefresh);
  sessionInput.hidden = true;
  sessionWrap.append(sessionSpan, sessionRow, sessionInput, ...(createRow ? [createRow] : []), sessionHint);
  // Pre-fill from cached status (edit mode only — an unsaved box has no snapshot).
  applySessions(isEdit ? latestStatus[box!.id] : undefined);
```

In `probeAndApply`, the two `applySessions` call sites now take the probe result rather than a name list:

```ts
      } else if (res.tmux === false) {
        applySessions(undefined);
        sessionHint.textContent = 'tmux not running';
      } else {
        applySessions(res);
        const names = (res.sessions ?? []).length;
        const wins = (res.sessions ?? []).reduce((n, s) => n + (s.windowList?.length ?? 0), 0);
        sessionHint.textContent = names ? `${names} session${names === 1 ? '' : 's'}, ${wins} window${wins === 1 ? '' : 's'}` : 'no sessions yet';
      }
```

In `createSessionNow`, select the session just created — the point of creating one is to use it:

```ts
        await api.createSession(boxId, name);
        createInput.value = '';
        // Re-probe so the new session lands in the dropdown (and the count updates).
        await probeAndApply();
        if (targets.some((t) => t.value === `s:${name}`)) { sessionSelect.value = `s:${name}`; syncCustom(); }
```

In both submit branches, replace `sessionInput.value.trim() || 'web'` with `sessionFieldValue()`:

```ts
        patch.sessionName = sessionFieldValue();   // edit branch (~line 2400)
        spec.sessionName = sessionFieldValue();    // add branch (~line 2432)
```

Add `sessionTargets` and the `SessionTarget` type to the `paneHeader` import (`isSwitchableSession` and `SESSION_NAME_RE` stay — the Create field still uses them).

- [ ] **Step 3: Replace the chip CSS with select styling**

In `src/web/style.css`, delete the picker/chip rules (`.modal .session-picker`, `.modal .session-picker:empty`, `.modal .session-chip`, `.modal .session-chip:hover`, `.modal .session-chip.selected`, ~lines 610-617) and add, beside `.modal .session-row`:

```css
/* The session field is one control now: sessions with their windows indented
   under them, plus a Custom name… row that reveals the free-text input. */
.modal .session-select { flex: 1; min-width: 0; padding: 9px 10px; border-radius: 6px; border: 1px solid var(--border); border-top-color: var(--seam); background: var(--screen); box-shadow: var(--recess); color: var(--text); font-family: var(--face); font-size: 14px; }
.modal .session-select:focus { outline: none; border-color: color-mix(in srgb, var(--accent) 45%, transparent); box-shadow: var(--recess), 0 0 0 2px color-mix(in srgb, var(--accent) 12%, transparent); }
.modal .session-select option:disabled { color: var(--dim); }
```

- [ ] **Step 4: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/main.ts src/web/style.css
git commit -m "feat(ui): consolidate the Edit Box session chips into one window dropdown"
```

---

### Task 6: Docs, live validation, release

**Files:**
- Modify: `docs/terminal.md` (pane header dropdown, ~lines 16-20)
- Modify: `docs/boxes-and-setup.md` (session picker, ~lines 17-18 and ~line 113)
- Modify: `CLAUDE.md` and `AGENTS.md` (the `status.js`, `server.js` and `paneHeader.ts` entries — the two files are kept in sync with each other)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update the user-facing guides**

`docs/terminal.md` — the dropdown now lists windows under their session, indented with `→`. State the three behaviours: picking a window in the current session switches instantly with no reconnect; picking one in another session also switches the box's session (which reconnects every open viewer); and, because tmux's current window belongs to the session rather than to your client, **anyone else attached to that session moves with you** — identical to pressing `prefix-n`.

`docs/boxes-and-setup.md` — the Edit Box session chips are gone; the field is one dropdown carrying the same hierarchy plus a `Custom name…` row for a session that does not exist yet. Picking a window there acts immediately (a live tmux action, not form state); the session is still written on Save. In Add mode windows appear after ⟳ but are disabled — there is no box to act on yet.

- [ ] **Step 2: Update the agent-facing architecture notes**

In both `CLAUDE.md` and `AGENTS.md`, keeping the two in sync:

- `status.js`: the probe also emits one `__WIN__` line per window (`parseTmuxWindows`/`attachWindows`), name last because window names may carry colons while session names may not, addressed by `#{window_id}` because indexes renumber under `move-window`.
- `server.js`: `POST /api/boxes/:id/window` selects a window by tmux id, gated 409 mid-setup like `/term`; nothing is persisted, since tmux's current window is session state and every attached client follows.
- `paneHeader.ts`: `sessionOptions` is now `sessionTargets`/`sessionTargetList`, a hierarchical row list whose selected row is the current session's active window; window rows inherit their session's switchable verdict except in the current session, which needs no PATCH.

- [ ] **Step 3: Commit the docs**

```bash
git add docs/terminal.md docs/boxes-and-setup.md CLAUDE.md AGENTS.md
git commit -m "docs(sessions): document tmux window targets in both dropdowns"
```

- [ ] **Step 4: Validate on the live app**

This touches the **server**, so the rsync-`dist/`-only recipe is not enough (server-side features need the branch checked out, not just its bundle). In the live repo: confirm no setup/provision/lifecycle/fleet/voice-install/apk-build job is `running`, check out this branch, `npm run build`, `sudo systemctl restart tmuxifier`, then hand it to the user with this checklist:

- a box with several windows shows them indented under its session in the pane header;
- picking a window in the current session switches the pane with no reconnect flicker;
- picking a window in another session switches both and lands on the right window;
- the header's selected row tracks the window after a `prefix-n` inside the terminal (one poll later);
- Edit Box shows the same hierarchy in one dropdown, `Custom name…` reveals the text field, and Save still writes the session;
- Add Box shows `web (default)` and `Custom name…`, and windows appear disabled after ⟳.

Rollback is `git checkout main && npm run build && sudo systemctl restart tmuxifier`.

- [ ] **Step 5: Merge and ship**

Only after the user validates: merge to `main` and run the release checklist in `CLAUDE.md` (`npm version patch --no-git-tag-version` → build → restart → health check → PII scrub of the staged diff → commit → tag → push → `gh release create`).
