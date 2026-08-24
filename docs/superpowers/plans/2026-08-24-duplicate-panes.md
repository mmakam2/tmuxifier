# Duplicate Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dragging (or ⊞-docking) a box that is already on the stage creates a second pane of the same box attached to its own tmux session — adopting an existing unshown session first, creating `<configured>-2` only when none is adoptable — with a pane-local header dropdown and a draggable pane header for rearranging.

**Architecture:** Stage leaves become *instance ids* (`<boxId>#<ordinal>` strings — the tree algorithms and their tests stay untouched), with per-pane session overrides in a `paneSessions` map persisted as a `sessions` record in the v3 layout payload. Each pane is an ordinary per-viewer PTY (client-id suffix `-p<ordinal>`); the only server change is an optional strict-validated `session` query param on `/term`.

**Tech Stack:** TypeScript web client (Vite, xterm.js), plain-JS Fastify server, vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-08-24-duplicate-panes-design.md` — read it first; every behavioral rule below argues from it.

**Plan-level refinement of the spec (Task 1 amends the spec to record it):** the spec sketches the v3 leaf as an object `{ box, pane, session? }`. This plan normalizes that to an equivalent form — leaf = instance-id **string** `${box}#${pane}`, session overrides in a v3 `sessions` record keyed by instance id. Same persisted information, same observable behavior, and every stageLayout tree algorithm plus its entire existing test file keeps working on string leaves.

## Global Constraints

- Node 20+, ESM everywhere; server code is plain `.js`, web client is `.ts`.
- TDD with real code, not mocks (dependency-injection factories). Write the failing test first.
- `npm test` = typecheck + vitest; e2e is `npm run test:e2e` and **requires `npm run build` first** (Playwright serves `dist/`).
- NEVER run `npm run build` in the live repo checkout — the service serves the repo's `dist/` with boot-registered asset routes, and even a verification build blanks the live app until a restart. Execute this plan in a worktree (superpowers:using-git-worktrees).
- Conventional-commit messages (`feat(ui): …`, `fix(pty): …`).
- Public repo: no real PII in committed code/tests — placeholders only (`example.com`, RFC1918 IPs).
- `MAX_PANES = 4` stays a `main.ts` gesture-layer rule; the model is N-capable.
- `SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/` (authoritative in `src/server/sshCommand.js:25`, client mirror in `src/web/paneHeader.ts:42`, locked together by `test/paneHeader.test.js`). Client ids share the same charset (`CLIENT_ID` in `src/server/sessions.js:17`).
- The instance-id separator is `#` — it is outside the session-name and box-id charsets and outside `CLIENT_ID`, so it can never leak into a session name or a client id.
- vitest runs `environment: 'node'` — **no DOM in unit tests**. DOM behavior is e2e-only (Task 9).

---

### Task 1: stageLayout instance ids + v3 serialize/restore

**Files:**
- Modify: `src/web/stageLayout.ts`
- Modify: `docs/superpowers/specs/2026-08-24-duplicate-panes-design.md` (record the string-leaf refinement)
- Test: `test/stageLayout.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact names):
  - `instanceId(box: string, ordinal: number): string` → `` `${box}#${ordinal}` ``
  - `boxOfInstance(id: string): string` (a plain box id passes through unchanged)
  - `ordinalOfInstance(id: string): number` (defaults to 1 for a plain box id)
  - `nextOrdinal(box: string, usedIds: string[]): number` (smallest positive ordinal not used by `box`'s ids in `usedIds`)
  - `serialize(root, focusedId, sessions?: Record<string, string>): string` (v3)
  - `restore(raw, knownIds): { root; focusedId; sessions: Record<string, string> }` — `knownIds` stays **box** ids; v1/v2 leaves migrate to `#1`; `sessions` entries survive only for panes still in the tree (values are shape-checked as strings here; charset policy is the caller's, Task 5).

- [ ] **Step 1: Write the failing tests** — append to `test/stageLayout.test.js`:

```js
import {
  panesOf, dockAtStageEdge, dockAtPaneEdge, movePane, undockPane, replacePane,
  setRatio, toggleOrientation, splitAt, serialize, restore, MIN_RATIO, phonePaneOf,
  instanceId, boxOfInstance, ordinalOfInstance, nextOrdinal,
} from '../src/web/stageLayout.ts';

test('instance ids round-trip and tolerate plain box ids', () => {
  expect(instanceId('b1', 2)).toBe('b1#2');
  expect(boxOfInstance('b1#2')).toBe('b1');
  expect(boxOfInstance('b1')).toBe('b1');
  expect(ordinalOfInstance('b1#2')).toBe(2);
  expect(ordinalOfInstance('b1')).toBe(1);
  expect(ordinalOfInstance('b1#nope')).toBe(1);
});

test('nextOrdinal fills the smallest gap per box', () => {
  expect(nextOrdinal('b1', [])).toBe(1);
  expect(nextOrdinal('b1', ['b1#1', 'b2#1'])).toBe(2);
  expect(nextOrdinal('b1', ['b1#1', 'b1#3'])).toBe(2);
});

test('v3 serialize/restore round-trips sessions for docked panes only', () => {
  const raw = serialize(row(['b1#1', 'b1#2']), 'b1#2', { 'b1#2': 'dev-2', 'gone#9': 'x' });
  const r = restore(raw, ['b1']);
  expect(panesOf(r.root)).toEqual(['b1#1', 'b1#2']);
  expect(r.focusedId).toBe('b1#2');
  expect(r.sessions).toEqual({ 'b1#2': 'dev-2' });
});

test('restore prunes vanished BOXES by instance', () => {
  const raw = serialize(row(['b1#1', 'dead#2']), 'dead#2', { 'dead#2': 'x' });
  const r = restore(raw, ['b1']);
  expect(r.root).toBe('b1#1');
  expect(r.focusedId).toBe('b1#1');
  expect(r.sessions).toEqual({});
});

test('v2 payloads migrate leaves and focus to ordinal 1', () => {
  const v2 = JSON.stringify({ v: 2, root: { orientation: 'row', children: ['a', 'b'], ratios: [0.5, 0.5] }, focusedId: 'b' });
  const r = restore(v2, ['a', 'b']);
  expect(panesOf(r.root)).toEqual(['a#1', 'b#1']);
  expect(r.focusedId).toBe('b#1');
  expect(r.sessions).toEqual({});
});

test('v1 payloads migrate leaves to ordinal 1', () => {
  const v1 = JSON.stringify({ v: 1, layout: { orientation: 'row', panes: ['a', 'b'] }, focusedId: 'a' });
  const r = restore(v1, ['a', 'b']);
  expect(panesOf(r.root)).toEqual(['a#1', 'b#1']);
});

test('restore drops non-string session values', () => {
  const raw = serialize('b1#1', 'b1#1', {});
  const parsed = JSON.parse(raw);
  parsed.sessions = { 'b1#1': 42 };
  const r = restore(JSON.stringify(parsed), ['b1']);
  expect(r.sessions).toEqual({});
});
```

Also UPDATE the existing serialize/restore tests in this file: any assertion on restored leaves/focusedId must now expect the `#1`-migrated ids (e.g. a v2 round-trip of `'a'` restores as `'a#1'`). Tree-op tests (`dockAtStageEdge` etc.) need **no** change — leaves are still strings.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run test/stageLayout.test.js`
Expected: FAIL — `instanceId` not exported; restore tests fail on missing migration.

- [ ] **Step 3: Implement in `src/web/stageLayout.ts`**

Add after the `MIN_RATIO` export:

```ts
// Instance ids: one BOX may dock several times; each docked pane is an
// INSTANCE `${box}#${ordinal}`. Leaves stay plain strings (every tree
// algorithm below compares leaves by ===), and '#' is outside the box-id,
// session-name and client-id charsets, so the separator can never collide.
export const instanceId = (box: string, ordinal: number): string => `${box}#${ordinal}`;
export function boxOfInstance(id: string): string {
  const i = id.lastIndexOf('#');
  return i < 0 ? id : id.slice(0, i);
}
export function ordinalOfInstance(id: string): number {
  const i = id.lastIndexOf('#');
  const n = i < 0 ? NaN : Number(id.slice(i + 1));
  return Number.isInteger(n) && n > 0 ? n : 1;
}
export function nextOrdinal(box: string, usedIds: string[]): number {
  const used = new Set(usedIds.filter((x) => boxOfInstance(x) === box).map(ordinalOfInstance));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}
```

Change `serialize` and `restore`:

```ts
export function serialize(root: PaneNode | null, focusedId: string | null, sessions: Record<string, string> = {}): string {
  return JSON.stringify({ v: 3, root, focusedId, sessions });
}
```

In `restore`: type the result as `{ root: PaneNode | null; focusedId: string | null; sessions: Record<string, string> }` with `fallback = { root: null, focusedId: null, sessions: {} }`. Add a leaf-migration helper and a v3 branch:

```ts
  const toInstances = (node: PaneNode): PaneNode =>
    isSplit(node) ? { ...node, children: node.children.map(toInstances) } : `${node}#1`;
  let root: PaneNode | null = null;
  let focusedRaw = typeof p.focusedId === 'string' ? p.focusedId : null;
  let sessionsRaw: unknown = {};
  if (p?.v === 3) {
    root = p.root == null ? null : sanitize(p.root);
    if (root == null && p.root != null) return fallback;
    sessionsRaw = (p as { sessions?: unknown }).sessions;
  } else if (p?.v === 2) {
    root = p.root == null ? null : sanitize(p.root);
    if (root == null && p.root != null) return fallback;
    if (root != null) root = toInstances(root);
    if (focusedRaw != null) focusedRaw = `${focusedRaw}#1`;
  } else if (p?.v === 1 && p.layout && Array.isArray(p.layout.panes)) {
    /* existing v1 handling, then: */
    if (root != null) root = toInstances(root);
    if (focusedRaw != null) focusedRaw = `${focusedRaw}#1`;
  } else return fallback;
```

Prune by **box**: `for (const id of panesOf(root)) if (!known.has(boxOfInstance(id))) root = undockPane(root, id);`. Resolve `focusedId` from `focusedRaw` against the surviving panes as today. Then:

```ts
  const panes2 = new Set(panesOf(root));
  const sessions: Record<string, string> = {};
  if (sessionsRaw && typeof sessionsRaw === 'object') {
    for (const [k, v] of Object.entries(sessionsRaw as Record<string, unknown>)) {
      if (typeof v === 'string' && panes2.has(k)) sessions[k] = v;
    }
  }
  return { root, focusedId, sessions };
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/stageLayout.test.js && npm run typecheck`
Expected: PASS (typecheck will flag `main.ts`'s `restore(...)` destructuring only if it names fields that changed — it doesn't; `serialize`'s third arg is optional, so `main.ts` still compiles unchanged).

- [ ] **Step 5: Amend the spec** — in `docs/superpowers/specs/2026-08-24-duplicate-panes-design.md`, under "Model changes", append one paragraph:

> **Implementation refinement (2026-08-24, plan):** the leaf is normalized to an instance-id *string* `${box}#${pane}` with session overrides in a v3 `sessions` record keyed by instance id — the same persisted information as the object leaf sketched above, chosen so every tree algorithm (and its test file) keeps operating on string leaves.

- [ ] **Step 6: Commit**

```bash
git add src/web/stageLayout.ts test/stageLayout.test.js docs/superpowers/specs/2026-08-24-duplicate-panes-design.md
git commit -m "feat(stage): instance-id leaves and v3 layout payload with per-pane sessions"
```

---

### Task 2: `chooseDuplicateSession` (adopt-then-create)

**Files:**
- Create: `src/web/duplicateSession.ts`
- Test: `test/duplicateSession.test.js`

**Interfaces:**
- Consumes: `isSwitchableSession` from `./paneHeader` (module-level import is DOM-free; `test/paneHeader.test.js` already imports it under node).
- Produces: `chooseDuplicateSession(configured: string, liveSessions: string[], shown: string[]): string`.

- [ ] **Step 1: Write the failing test** — `test/duplicateSession.test.js`:

```js
import { test, expect } from 'vitest';
import { chooseDuplicateSession } from '../src/web/duplicateSession.ts';

test('adopts the first live session no pane shows, in snapshot order', () => {
  expect(chooseDuplicateSession('web', ['web', 'dev', 'ops'], ['web'])).toBe('dev');
  expect(chooseDuplicateSession('web', ['web', 'dev', 'ops'], ['web', 'dev'])).toBe('ops');
});

test('skips unswitchable names instead of dead-ending the attach', () => {
  expect(chooseDuplicateSession('web', ['web', 'my session', 'ops'], ['web'])).toBe('ops');
});

test('creates <configured>-N only when nothing is adoptable', () => {
  expect(chooseDuplicateSession('web', ['web'], ['web'])).toBe('web-2');
  expect(chooseDuplicateSession('web', ['web', 'web-2'], ['web', 'web-2'])).toBe('web-3');
});

test('the shown set guards two quick drops against a stale snapshot', () => {
  // web-2 is not live yet (created lazily by the first duplicate's attach) but
  // a pane already claims it: the second duplicate must not collide.
  expect(chooseDuplicateSession('web', ['web'], ['web', 'web-2'])).toBe('web-3');
});

test('truncates the base so the candidate stays within 64 chars', () => {
  const long = 'a'.repeat(64);
  const out = chooseDuplicateSession(long, [long], [long]);
  expect(out).toBe('a'.repeat(62) + '-2');
  expect(out.length).toBe(64);
});

test('adopting the configured session itself is legal when no pane shows it', () => {
  expect(chooseDuplicateSession('web', ['web', 'dev'], ['dev'])).toBe('web');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/duplicateSession.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/web/duplicateSession.ts`:

```ts
// Session choice for a DUPLICATE pane (spec: adopt-then-create). Pure — the
// caller supplies the snapshot's session list and the set of sessions other
// panes of this box already show.
import { isSwitchableSession } from './paneHeader';

export function chooseDuplicateSession(configured: string, liveSessions: string[], shown: string[]): string {
  const taken = new Set(shown);
  // Adopt first: the first live session no pane shows, in snapshot order
  // (deterministic — the probe reports `tmux ls` order). Unswitchable names
  // are skipped, not offered: /term's strict validation would refuse them.
  for (const name of liveSessions) {
    if (name && !taken.has(name) && isSwitchableSession(name)) return name;
  }
  // Create only when dry: first `<configured>-N` in neither the live list nor
  // the shown set (the union guards two quick drops against a stale snapshot).
  const all = new Set([...liveSessions, ...shown]);
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = configured.slice(0, 64 - suffix.length) + suffix;
    if (!all.has(candidate)) return candidate;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/duplicateSession.test.js && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/duplicateSession.ts test/duplicateSession.test.js
git commit -m "feat(ui): adopt-then-create session chooser for duplicate panes"
```

---

### Task 3: `/term` optional `session` query param

**Files:**
- Modify: `src/server/server.js:2037-2062` (interactive-mode branch)
- Test: `test/server.ws.integration.test.js`

**Interfaces:**
- Consumes: `SESSION_NAME_RE` from `./sshCommand.js` (check `server.js`'s existing import line from `sshCommand.js` — the session-create route already validates against it; extend that import if the name is not yet in scope at the `/term` handler).
- Produces: `/term?box=<id>&client=<id>&session=<name>` attaches `<name>` instead of `box.sessionName`; an invalid `session` closes `1008 'invalid session'`; absent keeps today's behavior byte-for-byte.

- [ ] **Step 1: Write the failing tests** — append to `test/server.ws.integration.test.js`, in the fake-`sessions` style of the file's own cross-origin test (`:51-85`): a fake sessions object capturing `open()`'s arguments, a real `createStore` with a saved box, cookie login via `app.inject`. (The real-attach behavior — `new-session -A` creating the named session — is Task 9's e2e assertion; here the contract under test is the route's validation and forwarding.)

```js
test('/term forwards a valid session override to sessions.open, default unchanged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-ws-sess-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });
  const opened = [];
  const sessions = {
    open(o) { opened.push(o); return {}; },
    attach() { return () => {}; }, onExit() { return () => {}; },
    write() {}, resize() {}, detach() {}, close() {},
  };
  const app = buildServer({ config, store, sessions, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  const connect = (qs) => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term?box=${saved.id}&cols=80&rows=24&${qs}`,
      { headers: { cookie: `${c.name}=${c.value}` } });
    ws.on('open', () => { ws.close(); res(); });
    ws.on('error', rej);
  });

  await connect('client=dupA&session=altsess');
  await connect('client=dupB');
  expect(opened).toHaveLength(2);
  expect(opened[0].session).toBe('altsess');
  expect(opened[0].key).toBe(terminalKey(saved.id, 'dupA'));
  expect(opened[1].session).toBe('web');
}, 10000);

test('/term closes 1008 "invalid session" before opening a session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-ws-badsess-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });
  let openCalled = false;
  const sessions = {
    open() { openCalled = true; return {}; },
    attach() { return () => {}; }, onExit() { return () => {}; },
    write() {}, resize() {}, detach() {}, close() {},
  };
  const app = buildServer({ config, store, sessions, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&cols=80&rows=24&client=dupC&session=${encodeURIComponent('bad name')}`,
    { headers: { cookie: `${c.name}=${c.value}` } },
  );
  const code = await new Promise((resolve, reject) => { ws.on('close', resolve); ws.on('error', reject); });
  expect(code).toBe(1008);
  expect(openCalled).toBe(false);
}, 10000);
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server.ws.integration.test.js`
Expected: the new override test FAILS (output shows the configured session, not `altsess`); the 1008 test FAILS (connection opens normally).

- [ ] **Step 3: Implement** — in the interactive-mode branch of `scope.get('/term', …)`, immediately after the setup-gating check (`server.js:2043-2046`) insert:

```js
      // Per-pane session override (duplicate panes): strict-validated and
      // REJECTED on mismatch — the create/kill routes' posture, never
      // sanitizeSession's silent rewrite. Absent = the stored name, so every
      // existing client is byte-for-byte unaffected.
      const requestedSession = req.query.session;
      if (requestedSession !== undefined
        && (typeof requestedSession !== 'string' || !SESSION_NAME_RE.test(requestedSession))) {
        socket.close(1008, 'invalid session');
        return;
      }
```

and change the open call (`server.js:2056`):

```js
        entry = sessions.open({ key: terminalKey(boxId, req.query.client), box, session: requestedSession || box.sessionName, size });
```

`sessions.js` needs **zero** change — `open` already takes `session` and feeds it to `buildAttachArgv`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server.ws.integration.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/server.ws.integration.test.js
git commit -m "feat(pty): optional strict-validated session override on /term"
```

---

### Task 4: terminal.ts — per-pane session and client-id suffix

**Files:**
- Modify: `src/web/terminal.ts:437-445` (openTerminal opts), `:521-526` (WS URL in `connect()`)

**Interfaces:**
- Consumes: Task 3's `/term` contract.
- Produces: `openTerminal(parent, boxId, label, opts)` gains `opts.session?: string` and `opts.paneOrdinal?: number`. Ordinal 1 (or absent) keeps today's URL byte-for-byte — pane 1 keeps its PTY key across this deploy, so grace-window reattach survives the update.

- [ ] **Step 1: Implement** (no unit seam — vitest has no DOM; covered by Task 3's server test + Task 9 e2e + typecheck). Extend the opts type:

```ts
  opts?: {
    voiceMount?: HTMLElement; onConnState?: (s: PaneConn) => void; transformInput?: (d: string) => string;
    voiceSink?: () => ((text: string) => void) | null;
    // Duplicate panes: attach this tmux session instead of the box's stored
    // one, and key this viewer's PTY per pane instance (ordinal >1 suffixes
    // the client id, so pane 1 keeps today's key and its grace reattach).
    session?: string; paneOrdinal?: number;
  },
```

In `connect()` replace the URL line (`terminal.ts:526`):

```ts
    // -p<ordinal> keeps each pane of one box a distinct viewer. The base id is
    // trimmed so the suffixed id stays within the server's 64-char CLIENT_ID.
    const suffix = opts?.paneOrdinal && opts.paneOrdinal > 1 ? `-p${opts.paneOrdinal}` : '';
    const client = suffix ? clientId().slice(0, 64 - suffix.length) + suffix : clientId();
    const sess = opts?.session ? `&session=${encodeURIComponent(opts.session)}` : '';
    ws = new WebSocket(`${proto}://${location.host}/term?box=${encodeURIComponent(boxId)}&cols=${cols}&rows=${rows}&client=${client}${sess}`);
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS (no behavior change for existing callers — both opts absent).

- [ ] **Step 3: Commit**

```bash
git add src/web/terminal.ts
git commit -m "feat(ui): openTerminal carries per-pane session and viewer suffix"
```

---

### Task 5: main.ts — mechanical instance-id adoption (behavior-preserving)

This is the rekey sweep: after it, the app behaves **identically** (every box docks as `#1`, `paneSessions` exists but stays empty), and `npm test` plus the existing e2e must stay green. No new features in this task.

**Files:**
- Modify: `src/web/main.ts` (sites listed below)

**Interfaces:**
- Consumes: Task 1's `instanceId/boxOfInstance/ordinalOfInstance/nextOrdinal`, Task 4's opts.
- Produces (Tasks 6–8 rely on these): module-level `paneSessions: Map<string, string>` (overrides only), `focusedPaneId` (renamed from `focusedBoxId`), helpers `boxFor(iid)`, `isLocalPane(iid)`, `attachedSession(iid)`, `instancesOfBox(boxId)`, `closeTabsForBox(boxId, opts?)`. Every entry in `tabs`/`connStates`/`paneHeaders`/`paneLifecycles`/`settingUpPollers`/`stoppedShown` is keyed by instance id.

- [ ] **Step 1: Add state + helpers.** Near the maps (`main.ts:45-66`): add to the stageLayout import list `instanceId, boxOfInstance, ordinalOfInstance, nextOrdinal`; rename `focusedBoxId` → `focusedPaneId` (mechanical — typecheck enumerates every site); add:

```ts
// Per-pane session OVERRIDES only — absence means "the box's configured
// session". Runtime authority; persistStage mirrors it into the v3 payload.
const paneSessions = new Map<string, string>();
```

After `paneState`'s current location add:

```ts
const boxFor = (iid: string): Box | undefined => allBoxes.find((b) => b.id === boxOfInstance(iid));
const isLocalPane = (iid: string): boolean => boxOfInstance(iid) === '__local__';
function attachedSession(iid: string): string {
  return paneSessions.get(iid) ?? (boxFor(iid)?.sessionName || 'web');
}
// Docked panes plus parked tabs — a parked duplicate still holds its PTY and
// its ordinal, so both count for session adoption and ordinal reuse.
function instancesOfBox(boxId: string): string[] {
  return [...new Set([...panesOf(stageRoot), ...tabs.keys()])].filter((iid) => boxOfInstance(iid) === boxId);
}
function closeTabsForBox(boxId: string, opts?: { keepPane?: boolean }) {
  for (const iid of instancesOfBox(boxId)) closeTab(iid, opts);
}
```

- [ ] **Step 2: Sweep the call sites.** Each bullet is one precise edit; the argument everywhere is now an instance id (`iid`) unless stated:
  - `ensureTab` (`:780-810`): `const box = boxFor(id);` label `isLocalPane(id) ? 'local shell' : box?.label`; call `openTerminal(el, boxOfInstance(id), label, { session: paneSessions.get(id), paneOrdinal: ordinalOfInstance(id), …existing opts })`; final line `if (isLocalPane(id)) updateLocalDot();`.
  - `paneState` (`:817-824`): `if (isLocalPane(id)) return 'terminal';` and read `latestStatus[boxOfInstance(id)]`, `latestSetups.find((s) => s.boxId === boxOfInstance(id))`. (`stoppedShown` holds instance ids — no change to those two lines.)
  - `paneContentFor` (`:833-848`): `const box = boxFor(id);` pass the instance to the setup panel: `buildSettingUpPanel(box, id)`.
  - `buildSettingUpPanel` (`:1911-1944`): signature `(box: Box, iid: string)`; key `clearSettingUpPanel(iid)` / `settingUpPollers.set(iid, …)` / the settled-branch `clearSettingUpPanel(iid)` on the instance (two panes of one box mid-setup each own a poller).
  - `paneHeaderModelFor` (`:850-869`): `const box = boxFor(id); const boxId = boxOfInstance(id); const series = latestSeries[boxId];` pass `local: isLocalPane(id)`, `status: latestStatus[boxId]`, `sessionName: attachedSession(id)` — leave `agent` as today (Task 6 gates it).
  - `switchSession`/`killTarget`/`selectTarget` (`:875-953`): keep today's logic, but resolve the box via `boxFor(id)` and call the API with `boxOfInstance(id)` (Task 6 rewrites `switchSession`).
  - `updatePaneHeaders` (`:955-958`): lifecycle line reads `latestStatus[boxOfInstance(id)]`.
  - `paneHooks().headerFor` (`:963-1017`): `freshProbe.refresh(boxOfInstance(id), opts)`; Reconnect closure `if (isLocalPane(id)) … else await api.reconnectBox(boxOfInstance(id));`; lifecycle `const linked = boxFor(id)?.proxmox; if (!isLocalPane(id) && linked)` with `boxId: boxOfInstance(id)` and `onSettled: () => fastStatusPoll(boxOfInstance(id))`.
  - `syncPaneFocus`/chord (`:1031-1037`, `:1496-1507`): `focusedPaneId` rename only (`dataset.paneId` already carries whatever leaf ids the tree holds).
  - `persistStage` (`:773-775`):

```ts
function persistStage() {
  const sessions: Record<string, string> = {};
  for (const iid of panesOf(stageRoot)) {
    const s = paneSessions.get(iid);
    if (s) sessions[iid] = s;
  }
  localStorage.setItem(STAGE_LAYOUT_KEY, serialize(stageRoot, focusedPaneId, sessions));
}
```

  - restore site (`:1514-1519`):

```ts
  const restored = restore(savedStage, [...allBoxes.map((b) => b.id), '__local__']);
  if (restored.root != null) {
    stageRoot = restored.root;
    focusedPaneId = restored.focusedId;
    // Charset policy lives here, not in the model: a persisted override that
    // would fail /term's validation is dropped, falling back to configured.
    for (const [iid, name] of Object.entries(restored.sessions)) {
      if (isSwitchableSession(name)) paneSessions.set(iid, name);
    }
    repaintStage();
  }
```

  - `syncPhoneSwitch` (`:1131-1143`): label per instance — `const base = isLocalPane(id) ? 'Host Shell' : (boxFor(id)?.label ?? boxOfInstance(id)); const ov = paneSessions.get(id); o.textContent = ov ? `${base} · ${ov}` : base;`.
  - `createBoxRow` (`:1625-1720`): `:1630-1631` → `const dockedHere = panesOf(stageRoot).some((iid) => boxOfInstance(iid) === b.id); const activeHere = !!focusedPaneId && boxOfInstance(focusedPaneId) === b.id;`; dragstart (`:1690`) → `dragSourceId = instanceId(b.id, nextOrdinal(b.id, instancesOfBox(b.id)));` (an undocked box yields `#1` — identical zone gating to today); dock button (`:1706-1710`) → hidden rule unchanged this task but membership by box: `!panesOf(stageRoot).some((iid) => boxOfInstance(iid) === b.id)`, click → `dockBox(instanceId(b.id, 1), { kind: 'stage-edge', edge: 'right' })`; row Reconnect (`:1715-1719`) → `const wasDocked = panesOf(stageRoot).some((iid) => boxOfInstance(iid) === b.id); closeTabsForBox(b.id, { keepPane: wasDocked });`.
  - local row (`:1311-1322`, `:1469-1478`): dragstart → `dragSourceId = panesOf(stageRoot).find(isLocalPane) ?? instanceId('__local__', 1);` (payload stays `'__local__'`); local Reconnect → `wasDocked = panesOf(stageRoot).some(isLocalPane); closeTabsForBox('__local__', { keepPane: wasDocked });`.
  - drop handler (`:1441-1462`): map the box payload to an instance — `const docked = panesOf(stageRoot).find((iid) => boxOfInstance(iid) === id); const target = docked ?? instanceId(id, 1);` then `dockBox(target, …)` for the edge kinds and `replacePane(stageRoot, zoneTarget, target)` + `focusedPaneId = target` for replace, with the self-guard `if (zoneTarget === target) return;` (today's move semantics preserved; Task 7 replaces this mapping).
  - `highlightStage` (`:1890-1906`): row classes by box — `row.classList.toggle('docked', panesOf(stageRoot).some((iid) => boxOfInstance(iid) === id) && (!focusedPaneId || boxOfInstance(focusedPaneId) !== id)); row.classList.toggle('active', !!focusedPaneId && boxOfInstance(focusedPaneId) === id);` group highlight uses `boxOfInstance(focusedPaneId)`; local-shell block uses `panesOf(stageRoot).some(isLocalPane)` and `focusedPaneId != null && isLocalPane(focusedPaneId)`.
  - `updateLocalDot` (`:1882-1885`): `dot.classList.toggle('green', [...tabs.keys()].some(isLocalPane));`
  - `openPane` (`:1976-1999`):

```ts
function openPane(boxId: string) {
  const docked = panesOf(stageRoot).find((iid) => boxOfInstance(iid) === boxId);
  if (docked) {
    if (phoneCtl?.matches()) {
      if (focusedPaneId !== docked) { focusedPaneId = docked; repaintStage(); } else tabs.get(docked)?.term.focus();
      return;
    }
    focusedPaneId = docked;
    syncPaneFocus();
    persistStage();
    tabs.get(docked)?.term.focus();
    return;
  }
  const iid = instanceId(boxId, 1);
  const panes = panesOf(stageRoot);
  stageRoot = panes.length === 0
    ? iid
    : replacePane(stageRoot, panes.length <= 1 || !focusedPaneId ? panes[0] : focusedPaneId, iid);
  focusedPaneId = iid;
  repaintStage();
}
```

  - `closeTab` (`:2004-2009`): add `paneSessions.delete(id);` inside the `if (t)` full-teardown branch **only when `!opts?.keepPane`** (a keepPane teardown is a reconnect/switch that must keep its override); `if (isLocalPane(id)) updateLocalDot();`.
  - Remaining `closeTab(` callers: run `grep -n "closeTab(" src/web/main.ts` — every call whose argument is a **box id** (Edit-modal save path near `:2324`, box-removal paths, `pollStatus`'s stopped-pane handling if it closes by box, workspace teardown near `:3766`) becomes `closeTabsForBox(boxId, …)`; calls already inside per-pane code keep `closeTab(iid, …)`. Judge each site by what the variable holds, not its name.
  - `applyAgentBadge`/`repaintAgentBadges`/`fastStatusPoll`/`pollStatus`/`freshProbe` and everything else keyed by **box** id: untouched — only the pane-keyed structures rekey.

- [ ] **Step 3: Verify hard**

Run: `npm test` then `npm run build && npm run test:e2e`
Expected: everything green — this task is a pure rekey. Any e2e failure here means a missed call-site, not a test to update (exception: an e2e asserting the dock button hidden-when-docked would only break in Task 7, not here).

- [ ] **Step 4: Commit**

```bash
git add src/web/main.ts
git commit -m "refactor(ui): stage panes keyed by instance id (behavior-preserving)"
```

---

### Task 6: pane-local dropdown, attached-session header, Reconnect target

**Files:**
- Modify: `src/web/paneHeader.ts` (input + agent gating), `src/web/main.ts` (switch/select/Reconnect/model)
- Test: `test/paneHeader.test.js`

**Interfaces:**
- Consumes: Task 5's `paneSessions`/`attachedSession`, Task 4's reopen path.
- Produces: `PaneHeaderInput.configuredSession?: string`; `switchPaneSession(iid, name)` replacing `switchSession` (no `api.updateBox` call remains in the header path).

- [ ] **Step 1: Write the failing tests** — append to `test/paneHeader.test.js`:

```js
test('agent chip renders only when the pane shows the configured session', () => {
  const base = { local: false, label: 'b', state: 'terminal', agent: 'working' };
  const on = paneHeaderModel({ ...base, sessionName: 'web', configuredSession: 'web' });
  expect(on.chip?.kind).toBe('agent');
  const off = paneHeaderModel({ ...base, sessionName: 'web-2', configuredSession: 'web' });
  expect(off.chip).toBeNull();
  // Defaults ('web') keep every existing caller's behavior.
  const dflt = paneHeaderModel({ ...base, sessionName: undefined, configuredSession: undefined });
  expect(dflt.chip?.kind).toBe('agent');
});

test('the dropdown lists from the ATTACHED session as current', () => {
  const status = { sessions: [{ name: 'web' }, { name: 'dev-2' }] };
  const m = paneHeaderModel({ local: false, label: 'b', state: 'terminal', status, sessionName: 'dev-2', configuredSession: 'web' });
  expect(m.targets.options[0]).toMatchObject({ kind: 'session', session: 'dev-2' });
  expect(m.targets.value).toBe('s:dev-2');
});
```

(Match the file's existing import list and `Status` literal style.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/paneHeader.test.js`
Expected: FAIL — `configuredSession` unknown / chip present in the mismatch case.

- [ ] **Step 3: Implement `paneHeader.ts`.** In `PaneHeaderInput` add below `sessionName`:

```ts
  // sessionName is the session this PANE is attached to (per-pane since the
  // duplicate-panes change); configuredSession is the box's stored name.
  // Agent state is hook-only and keyed to the CONFIGURED session, so on any
  // other session the chip would describe something the pane isn't showing.
  configuredSession?: string;
```

In `paneHeaderModel`, before computing the chip:

```ts
  const onConfigured = (i.sessionName || 'web') === (i.configuredSession || 'web');
  const chip = paneHeaderChip(onConfigured ? i : { ...i, agent: undefined });
```

and use `chip` in the returned object (the `targets:` line already keys off `i.sessionName`, which is now the attached session — no change needed there).

- [ ] **Step 4: Implement `main.ts`.** In `paneHeaderModelFor`, pass `configuredSession: boxFor(id)?.sessionName || 'web'` (with `sessionName: attachedSession(id)` from Task 5). Replace `switchSession` (`:875-893`) with:

```ts
// Point THIS pane at another session — pane-local by spec decision 3: no
// PATCH, no group close, other panes and browsers untouched. The box's
// configured sessionName is Edit-modal business now. closeTab(keepPane)
// drops only this instance's PTY; the repaint reopens it on the override.
function switchPaneSession(iid: string, name: string) {
  if (attachedSession(iid) === name) return;
  if (!isSwitchableSession(name)) { updatePaneHeaders(); return; }
  if (name === (boxFor(iid)?.sessionName || 'web')) paneSessions.delete(iid);
  else paneSessions.set(iid, name);
  closeTab(iid, { keepPane: true });
  repaintStage();
  fastStatusPoll(boxOfInstance(iid));
}
```

Rewrite `selectTarget` (`:925-953`) — window-first ordering preserved, comparison now against the attached session:

```ts
async function selectTarget(iid: string, t: SessionTarget) {
  if (t.kind === 'window' && t.windowId) {
    try {
      await api.selectWindow(boxOfInstance(iid), t.session, t.windowId);
    } catch {
      updatePaneHeaders();
      return;
    }
  }
  if (attachedSession(iid) !== t.session) { switchPaneSession(iid, t.session); return; }
  if (t.kind === 'window') void pollStatus();
  else updatePaneHeaders();
}
```

Header Reconnect (`:987-994`): an overridden pane kills its OWN session via the kill route (pane-local); a configured pane keeps today's heavy reconnect (ControlMaster reset + group close):

```ts
        wireReconnectButton(built.refreshBtn, `pane:${id}`, `${model.title} terminal`, async () => {
          if (isLocalPane(id)) await api.reconnectLocalShell();
          else if (paneSessions.has(id)) await api.killTarget(boxOfInstance(id), attachedSession(id));
          else await api.reconnectBox(boxOfInstance(id));
          closeTab(id, { keepPane: true });
          repaintStage();
        });
```

Sweep the two comment blocks that cite `switchSession` reverting via `updatePaneHeaders` (`main.ts:~2324`, `:~2451`) to name `switchPaneSession`.

- [ ] **Step 5: Verify**

Run: `npm test`
Expected: PASS. Note `api.updateBox` no longer has a header caller — confirm with `grep -n "updateBox" src/web/main.ts` that only the Edit-modal path remains.

- [ ] **Step 6: Commit**

```bash
git add src/web/paneHeader.ts src/web/main.ts test/paneHeader.test.js
git commit -m "feat(ui): pane-local session dropdown and attached-session header"
```

---

### Task 7: duplicate on drop / dock button (adopt-then-create)

**Files:**
- Modify: `src/web/main.ts` (drop handler, dock button, `duplicateBox`)

**Interfaces:**
- Consumes: Task 2's `chooseDuplicateSession`, Task 5's plumbing, `freshProbe.refresh(boxId)`.
- Produces: `duplicateBox(boxId: string, drop: DropSpec | { kind: 'replace'; paneId: string }): Promise<void>` — Tasks 8/9 reuse the drop-handler shape.

- [ ] **Step 1: Implement `duplicateBox`** (near `dockBox`), importing `chooseDuplicateSession` from `./duplicateSession`:

```ts
// Dock a SECOND pane of an already-docked box (spec: adopt-then-create).
// Async: the session list refreshes through freshProbe first, so adoption
// doesn't act on the 30s cache; refresh() resolves on its wait cap even when
// the probe is slow, and a failed probe falls back to the cached snapshot.
async function duplicateBox(boxId: string, drop: DropSpec | { kind: 'replace'; paneId: string }) {
  const box = allBoxes.find((b) => b.id === boxId);
  if (!box) return;
  if (drop.kind !== 'replace' && panesOf(stageRoot).length >= MAX_PANES) return;
  try { await freshProbe.refresh(boxId); } catch { /* cached snapshot */ }
  const configured = box.sessionName || 'web';
  const live = (latestStatus[boxId]?.sessions ?? []).map((s) => s.name).filter(Boolean);
  const shown = instancesOfBox(boxId).map((iid) => attachedSession(iid));
  const session = chooseDuplicateSession(configured, live, shown);
  const iid = instanceId(boxId, nextOrdinal(boxId, instancesOfBox(boxId)));
  if (session !== configured) paneSessions.set(iid, session);
  if (drop.kind === 'replace') {
    stageRoot = replacePane(stageRoot, drop.paneId, iid);
    focusedPaneId = iid;
    repaintStage();
  } else dockBox(iid, drop);
}
```

- [ ] **Step 2: Route the gestures to it.** In the drop handler's box-payload branch (Task 5's mapping), replace the mapping with:

```ts
      const dockedIid = panesOf(stageRoot).find((iid) => boxOfInstance(iid) === id);
      // Host Shell is excluded from duplication (its session is server-fixed):
      // its row-drag keeps pure move semantics. Any other docked box's row-drag
      // now DUPLICATES (spec decision 2 + amendment).
      const moveOnly = id === '__local__';
      const asDrop: DropSpec | null =
        kind === 'stage-edge' ? { kind: 'stage-edge', edge: zone!.dataset.edge as Edge }
        : kind === 'pane-edge' ? { kind: 'pane-edge', paneId: zone!.dataset.paneId!, edge: zone!.dataset.edge as Edge }
        : null;
      if (asDrop) {
        if (dockedIid && !moveOnly) void duplicateBox(id, asDrop);
        else dockBox(dockedIid ?? instanceId(id, 1), asDrop);
      } else if (kind === 'replace') {
        const target = zone!.dataset.paneId!;
        if (dockedIid && !moveOnly) { if (boxOfInstance(target) !== id) void duplicateBox(id, { kind: 'replace', paneId: target }); }
        else if (target !== (dockedIid ?? instanceId(id, 1))) {
          stageRoot = replacePane(stageRoot, target, dockedIid ?? instanceId(id, 1));
          focusedPaneId = dockedIid ?? instanceId(id, 1);
          repaintStage();
        }
      }
```

Dock button (`createBoxRow`): visible whenever a duplicate or first dock fits, title reflecting which:

```ts
  const dockedHere = panesOf(stageRoot).some((iid) => boxOfInstance(iid) === b.id);
  dock.title = dockedHere ? 'Dock another pane of this box' : 'Dock beside current terminal';
  dock.setAttribute('aria-label', `${dock.title} — ${b.label}`);
  dock.hidden = !(panesOf(stageRoot).length >= 1 && panesOf(stageRoot).length < MAX_PANES);
  dock.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panesOf(stageRoot).some((iid) => boxOfInstance(iid) === b.id)) void duplicateBox(b.id, { kind: 'stage-edge', edge: 'right' });
    else dockBox(instanceId(b.id, 1), { kind: 'stage-edge', edge: 'right' });
  });
```

(The sidebar dragstart already sets `dragSourceId` to a fresh candidate iid — Task 5 — so `dropTargets` cap-gates duplicate drags as adds. The local row's dragstart sets its docked iid, so local drags stay cap-exempt moves.)

- [ ] **Step 3: Verify**

Run: `npm test` — then `npm run build && npm run test:e2e`. If an existing e2e (`split.spec.ts`, `tmuxifier.spec.ts`) asserts the ⊞ button hidden for a docked box, update that assertion to the new visibility rule and note it in the commit message.

- [ ] **Step 4: Commit**

```bash
git add src/web/main.ts test/e2e
git commit -m "feat(ui): duplicate a docked box into a second pane, adopt-then-create session"
```

---

### Task 8: draggable pane header (move gesture)

**Files:**
- Modify: `src/web/main.ts` (headerFor drag source + stage handlers), `src/web/style.css` (grab cursor)

**Interfaces:**
- Consumes: the drop-zone machinery (Tasks 5/7); `dropTargets` already exempts a docked dragged id from the cap.
- Produces: drag payload type `text/x-tmuxifier-pane` carrying the instance id.

- [ ] **Step 1: Drag source.** In `paneHooks().headerFor`, after `paneHeaders.set(id, built)`:

```ts
      // Move gesture (spec decision 4): the header's identity strip drags the
      // pane; sidebar rows spawn. dragstart only fires on an actual drag, so
      // the picker and buttons inside stay clickable. dragSourceId is the REAL
      // instance id — dropTargets exempts a docked pane from the cap (a move
      // never grows the pane count).
      const idStrip = built.el.querySelector('.pane-header-id') as HTMLElement;
      idStrip.draggable = true;
      idStrip.addEventListener('dragstart', (e) => {
        dragSourceId = id;
        e.dataTransfer?.setData('text/x-tmuxifier-pane', id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      idStrip.addEventListener('dragend', () => {
        dragSourceId = null;
        app.querySelector('#stage')?.classList.remove('dragging');
      });
```

- [ ] **Step 2: Accept the payload.** In the stage's `dragenter` (`:1412`) and `dragover` (`:1428`) guards:

```ts
      const types = e.dataTransfer?.types;
      if (!types?.includes('text/x-tmuxifier-box') && !types?.includes('text/x-tmuxifier-pane')) return;
```

In the drop handler, before the box-payload branch:

```ts
      const movedPane = e.dataTransfer?.getData('text/x-tmuxifier-pane');
      if (movedPane) {
        zones.replaceChildren();
        dragSourceId = null;
        preview.style.display = 'none';
        if (!zone) return;
        const kind = zone.dataset.kind;
        if (kind === 'stage-edge') dockBox(movedPane, { kind: 'stage-edge', edge: zone.dataset.edge as Edge });
        else if (kind === 'pane-edge') dockBox(movedPane, { kind: 'pane-edge', paneId: zone.dataset.paneId!, edge: zone.dataset.edge as Edge });
        else if (kind === 'replace' && zone.dataset.paneId !== movedPane) {
          // Both docked: replacePane swaps the two panes in place.
          stageRoot = replacePane(stageRoot, zone.dataset.paneId!, movedPane);
          focusedPaneId = movedPane;
          repaintStage();
        }
        return;
      }
```

- [ ] **Step 3: Cursor affordance.** In `style.css`, next to the existing `.pane-header` rules:

```css
.pane-header-id { cursor: grab; }
.pane-header-id:active { cursor: grabbing; }
```

- [ ] **Step 4: Verify**

Run: `npm test` (typecheck covers the wiring; behavior lands in Task 9's e2e).

- [ ] **Step 5: Commit**

```bash
git add src/web/main.ts src/web/style.css
git commit -m "feat(ui): drag the pane header to rearrange panes"
```

---

### Task 9: e2e — duplicate panes end to end

**Files:**
- Create: `test/e2e/duplicatePanes.spec.ts`

Conventions (from `test/e2e/sessionDropdown.spec.ts`): password `e2e`, box label `localhost`, `workers: 1`, leave the fixture's tmux state as found (cleanup in `finally`, tolerant of failure paths). **`npm run build` before running** — Playwright serves `dist/`.

- [ ] **Step 1: Write the spec:**

```ts
import { test, expect } from '@playwright/test';

// Duplicate panes: ⊞ on a docked box docks a SECOND pane of the same box —
// adopting a live unshown session when one exists, creating `<name>-2` when
// dry — and the header dropdown is pane-local. The ⊞ path is used because it
// shares duplicateBox() with the drag path and Playwright cannot synthesize
// HTML5 drag-and-drop reliably.

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

async function promptIn(pane) {
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
}

test('duplicating with only one session creates <name>-2; the dropdown stays pane-local', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const firstPane = page.locator('.stage-pane').first();
  await promptIn(firstPane);

  const row = page.locator('.box', { has: page.locator('.name', { hasText: 'localhost' }) });
  await row.locator('.dock').click();
  await expect(page.locator('.stage-pane')).toHaveCount(2, { timeout: 10000 });

  const secondPane = page.locator('.stage-pane').nth(1);
  await promptIn(secondPane);
  try {
    // The second pane really is attached to the derived session.
    await secondPane.click();
    await page.keyboard.type("tmux display-message -p '#S'");
    await page.keyboard.press('Enter');
    await expect(secondPane.locator('.xterm-rows')).toContainText(/-2\b/, { timeout: 10000 });
    // Pane-local: the first pane's picker still names the configured session.
    const firstCurrent = firstPane.locator('.session-picker-row.current, .session-picker-trigger');
    await expect(firstCurrent.first()).not.toContainText('-2');
  } finally {
    // Undock the duplicate and kill its session so later specs see one session.
    await secondPane.click().catch(() => {});
    await page.keyboard.type('tmux kill-session').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await firstPane.locator('.pane-undock').click().catch(() => {});
  }
});

test('duplicating adopts a live unshown session before creating one', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const firstPane = page.locator('.stage-pane').first();
  await promptIn(firstPane);
  try {
    await firstPane.click();
    await page.keyboard.type('tmux new-session -d -s sparee2e');
    await page.keyboard.press('Enter');
    await promptIn(firstPane);

    const row = page.locator('.box', { has: page.locator('.name', { hasText: 'localhost' }) });
    await row.locator('.dock').click();
    await expect(page.locator('.stage-pane')).toHaveCount(2, { timeout: 10000 });
    const secondPane = page.locator('.stage-pane').nth(1);
    await promptIn(secondPane);
    await secondPane.click();
    await page.keyboard.type("tmux display-message -p '#S'");
    await page.keyboard.press('Enter');
    await expect(secondPane.locator('.xterm-rows')).toContainText('sparee2e', { timeout: 10000 });
  } finally {
    await firstPane.click().catch(() => {});
    await page.keyboard.type('tmux kill-session -t sparee2e').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
});
```

Adjust selectors against the real DOM while iterating (`.session-picker-trigger` text, `.pane-undock` from `paneHeader.ts`); the assertions and cleanup obligations above are the contract. If the fixture's configured session name makes `/-2\b/` ambiguous, assert the full expected name (`<configured>-2`) by reading the fixture's box definition in `test/e2e/fixtures`/`global-setup.js`.

- [ ] **Step 2: Run**

Run: `npm run build && npm run test:e2e`
Expected: new spec green AND the whole suite green (multi-viewer, split, sessionDropdown, phone all touch this code).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/duplicatePanes.spec.ts
git commit -m "test(e2e): duplicate panes — create-when-dry, adopt-first, pane-local dropdown"
```

---

### Task 10: docs

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md` (keep in sync), `docs/terminal.md`

- [ ] **Step 1: `CLAUDE.md`/`AGENTS.md`.** Update three architecture entries, in the file's established voice:
  - `stageLayout.ts`: leaves are instance ids (`box#ordinal`) so one box can dock several times; v3 payload carries a per-pane `sessions` record; v1/v2 payloads migrate to `#1`.
  - `paneHeader.ts`: `sessionName` is the pane's ATTACHED session, `configuredSession` the stored one; the agent chip renders only when they coincide; the dropdown is pane-local — switching a session reattaches that pane alone, and the box's configured session changes only in the Edit modal (the old header PATCH path is gone).
  - `main.ts` block: duplicate drop/⊞ adopt-then-create via `duplicateSession.ts` + `freshProbe`; pane-header drag = move (`text/x-tmuxifier-pane`), sidebar drag = spawn; Host Shell excluded; `/term` gained the strict-validated `session` param.
- [ ] **Step 2: `docs/terminal.md`.** A user-facing "Several panes of one box" section: how to duplicate (drag or ⊞), the adopt-then-create rule, pane-local dropdown behavior, that pointing two panes at one session mirrors (same window, last-touched sizing — tmux semantics), and that the header now drags to rearrange.
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md AGENTS.md docs/terminal.md
git commit -m "docs: duplicate panes — instance leaves, pane-local dropdown, header drag"
```

---

## Self-review notes (already applied)

- Spec coverage: model → T1; adopt-then-create + freshness → T2/T7; `/term` param + client suffix → T3/T4; pane-local dropdown + agent-chip gating + Reconnect target → T6; gestures (⊞, drag payloads, header drag, Host-Shell exclusion, replace) → T7/T8; phone/`syncPhoneSwitch` labels + restore seeding + `closeTabsForBox` → T5; testing section → T1/T2/T3/T6/T9; docs → T10. The spec's "accepted residuals" need no code.
- Type consistency: `paneSessions`/`attachedSession`/`instancesOfBox`/`focusedPaneId` defined in T5 and consumed by T6–T8 exactly as named; `chooseDuplicateSession(configured, live, shown)` matches T2's export; `duplicateBox`'s `replace` variant matches T7's drop wiring.
- Known judgment calls an executor must not "fix" silently: pane-1's header Reconnect keeps `reconnectBox` (heavy) while an overridden pane uses the kill route (pane-local) — deliberate, spec'd behavior preservation; `closeTab` deletes the session override only on full teardown, never on `keepPane`.
