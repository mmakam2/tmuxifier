# Local Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pinned local-shell button at the bottom of the sidebar that opens a local tmux session (no SSH), with a slim edit modal to switch between None/Oh My Zsh/Oh My Bash.

**Architecture:** A new `openLocal()` method on the session manager spawns `tmux` via `node-pty` instead of `ssh`. The WebSocket handler detects the sentinel boxId `__local__` and branches to the local path. Shell framework config is persisted to `config.json` via a new `configFile.js` helper and mutated in memory for the WebSocket handler.

**Tech Stack:** Fastify, node-pty, xterm.js, TypeScript (web), vanilla JS (server)

## Global Constraints

- ESM everywhere (`"type": "module"`), Node 20+
- TDD: write failing test first, then implementation
- conventional-commit style messages
- DI factory pattern for new modules (follow existing patterns)
- All server-side state lives inside the repo folder
- `config.json` is written atomically (write to temp + rename would be ideal, but the existing `envFile.js` pattern of direct write is acceptable)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/server/config.js` | Modify | Add `localShell` default + env mapping |
| `src/server/configFile.js` | **Create** | Read/upsert `config.json` helper |
| `src/server/sessions.js` | Modify | Add `openLocal()` method |
| `src/server/server.js` | Modify | API endpoints + `__local__` WebSocket branch |
| `src/web/api.ts` | Modify | Add `getLocalShell`, `updateLocalShell`, `reconnectLocalShell` |
| `src/web/main.ts` | Modify | Sidebar bar, edit modal, local shell tab handling |
| `src/web/style.css` | Modify | `.local-shell` bar + edit modal styles |
| `test/config.test.js` | Modify | Tests for `localShell` config |
| `test/configFile.test.js` | **Create** | Tests for `configFile.js` |
| `test/sessions.integration.test.js` | Modify | Test for `openLocal()` |
| `test/server.test.js` | Modify | Tests for local-shell API endpoints |

---

### Task 1: Config layer — `localShell` default + `configFile.js` helper

**Files:**
- Modify: `src/server/config.js:6-13`
- Create: `src/server/configFile.js`
- Modify: `test/config.test.js`
- Create: `test/configFile.test.js`

**Interfaces:**
- Produces: `config.localShell` property (string: `"none"` | `"omz"` | `"omb"`, default `"none"`)
- Produces: `readConfigFile(file)` → `object`, `upsertConfigFile(file, patch)` → `void`

- [ ] **Step 1: Write config test for `localShell` default and env override**

Add to `test/config.test.js`:

```js
test('localShell defaults to none and is overridable via env', () => {
  const c = loadConfig({}, { env: {}, cwd: '/app' });
  expect(c.localShell).toBe('none');
  const omz = loadConfig({}, { env: { TMUXIFIER_LOCAL_SHELL: 'omz' }, cwd: '/app' });
  expect(omz.localShell).toBe('omz');
  const omb = loadConfig({}, { env: { TMUXIFIER_LOCAL_SHELL: 'omb' }, cwd: '/app' });
  expect(omb.localShell).toBe('omb');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.js -t 'localShell defaults'`
Expected: FAIL — `localShell` is undefined (not yet in DEFAULTS).

- [ ] **Step 3: Add `localShell` to DEFAULTS and env mapping in `config.js`**

In `src/server/config.js`, add to `DEFAULTS`:

```js
const DEFAULTS = {
  bindAddress: '127.0.0.1',
  port: 7437,
  graceSeconds: 45,
  hostKeyPolicy: 'accept-new',
  passwordHash: '',
  cookieSecret: '',
  localShell: 'none',
};
```

In the env mapping inside `loadConfig()`, add:

```js
const envCfg = clean({
  // ... existing keys ...
  localShell: e.TMUXIFIER_LOCAL_SHELL,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.js -t 'localShell defaults'`
Expected: PASS

- [ ] **Step 5: Write tests for `configFile.js`**

Create `test/configFile.test.js`:

```js
import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigFile, upsertConfigFile } from '../src/server/configFile.js';

test('readConfigFile returns {} when file does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-cfgfile-'));
  const file = path.join(dir, 'config.json');
  expect(readConfigFile(file)).toEqual({});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readConfigFile parses existing JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-cfgfile-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 5555, localShell: 'omz' }));
  expect(readConfigFile(file)).toEqual({ port: 5555, localShell: 'omz' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upsertConfigFile creates file and merges keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-cfgfile-'));
  const file = path.join(dir, 'config.json');

  // Create
  upsertConfigFile(file, { localShell: 'omz' });
  expect(readConfigFile(file)).toEqual({ localShell: 'omz' });

  // Merge — preserves existing keys
  upsertConfigFile(file, { port: 5555 });
  expect(readConfigFile(file)).toEqual({ localShell: 'omz', port: 5555 });

  // Overwrite
  upsertConfigFile(file, { localShell: 'omb' });
  expect(readConfigFile(file)).toEqual({ localShell: 'omb', port: 5555 });

  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run test/configFile.test.js`
Expected: FAIL — module `../src/server/configFile.js` not found.

- [ ] **Step 7: Implement `configFile.js`**

Create `src/server/configFile.js`:

```js
import fs from 'node:fs';

export function readConfigFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function upsertConfigFile(file, patch) {
  const current = readConfigFile(file);
  const next = { ...current, ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/configFile.test.js`
Expected: all 3 tests PASS

- [ ] **Step 9: Run full config test suite**

Run: `npx vitest run test/config.test.js`
Expected: all PASS (including new test)

- [ ] **Step 10: Commit**

```bash
git add src/server/config.js src/server/configFile.js test/config.test.js test/configFile.test.js
git commit -m "feat(config): add localShell config key and configFile.js helper"
```

---

### Task 2: Session manager — `openLocal()` method

**Files:**
- Modify: `src/server/sessions.js:6-103`
- Modify: `test/sessions.integration.test.js`

**Interfaces:**
- Consumes: `shell` (string: `"none"` | `"omz"` | `"omb"`), `size` ({ cols: number, rows: number })
- Produces: `sessions.openLocal({ key, shell, size })` → entry (same shape as `open()`)
- The returned entry shape is: `{ key, pty, listeners: Set, exitCbs: Set, graceTimer, exited }`

- [ ] **Step 1: Write integration test for `openLocal()`**

Add to `test/sessions.integration.test.js`:

```js
test('openLocal spawns a local tmux session and streams data', async () => {
  const mgr = createSessionManager({ graceSeconds: 1 });
  const size = { cols: 80, rows: 24 };
  const key = 'local-test-' + Date.now();

  const entry = mgr.openLocal({ key, shell: 'none', size });
  const buf = [];
  const off = mgr.attach(entry, (d) => buf.push(d));
  await waitFor(() => buf.join('').length > 0);

  mgr.write(entry, 'echo LOCAL_SHELL_TEST\n');
  await waitFor(() => buf.join('').includes('LOCAL_SHELL_TEST'));

  // Clean up: kill the local tmux session so it doesn't linger
  mgr.write(entry, 'exit\n');
  off();
  mgr.close(entry);
});

test('openLocal shells: omz passes exec zsh startup command', async () => {
  const mgr = createSessionManager({ graceSeconds: 1 });
  const size = { cols: 80, rows: 24 };
  const key = 'local-omz-' + Date.now();

  // openLocal with omz should start with zsh
  const entry = mgr.openLocal({ key, shell: 'omz', size });
  const buf = [];
  const off = mgr.attach(entry, (d) => buf.push(d));
  await waitFor(() => buf.join('').length > 0);

  // Check the running shell
  mgr.write(entry, 'echo $0\n');
  await waitFor(() => buf.join('').includes('zsh'));

  mgr.write(entry, 'exit\n');
  off();
  mgr.close(entry);
});

test('openLocal shells: omb passes exec bash startup command', async () => {
  const mgr = createSessionManager({ graceSeconds: 1 });
  const size = { cols: 80, rows: 24 };
  const key = 'local-omb-' + Date.now();

  const entry = mgr.openLocal({ key, shell: 'omb', size });
  const buf = [];
  const off = mgr.attach(entry, (d) => buf.push(d));
  await waitFor(() => buf.join('').length > 0);

  mgr.write(entry, 'echo $0\n');
  await waitFor(() => buf.join('').includes('bash'));

  mgr.write(entry, 'exit\n');
  off();
  mgr.close(entry);
});

test('openLocal reuses existing entry within grace period', async () => {
  const mgr = createSessionManager({ graceSeconds: 30 });
  const size = { cols: 80, rows: 24 };
  const key = 'local-reuse-' + Date.now();

  const e1 = mgr.openLocal({ key, shell: 'none', size });
  await waitFor(() => true);
  mgr.detach(e1);
  const e2 = mgr.openLocal({ key, shell: 'none', size }); // same key within grace
  expect(e2).toBe(e1);

  mgr.write(e1, 'exit\n');
  mgr.close(e2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/sessions.integration.test.js -t 'openLocal'`
Expected: FAIL — `mgr.openLocal is not a function`

- [ ] **Step 3: Implement `openLocal()` in `sessions.js`**

Add inside `createSessionManager` (after the `open` function):

```js
function openLocal({ key, shell, size }) {
    const existing = entries.get(key);
    if (existing && !existing.exited) {
      if (existing.graceTimer) { clearTimeout(existing.graceTimer); existing.graceTimer = null; }
      return existing;
    }
    const args = ['new-session', '-A', '-D', '-s', 'local'];
    if (shell === 'omz') args.push('exec zsh');
    else if (shell === 'omb') args.push('exec bash');
    const pty = spawn('tmux', args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: spawnEnv,
    });
    const entry = { key, pty, listeners: new Set(), exitCbs: new Set(), graceTimer: null, exited: false };
    pty.onData((d) => {
      for (const fn of entry.listeners) {
        try { fn(d); } catch { /* listener error must not break the fan-out */ }
      }
    });
    pty.onExit(() => {
      entry.exited = true;
      entries.delete(key);
      for (const cb of entry.exitCbs) cb();
    });
    entries.set(key, entry);
    return entry;
  }
```

Add `openLocal` to the returned object:

```js
return { open, openLocal, provision, attach, onExit, write, resize, detach, close, closeKey, _count: () => entries.size };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/sessions.integration.test.js -t 'openLocal'`
Expected: all 4 new tests PASS

- [ ] **Step 5: Run full sessions test suite**

Run: `npx vitest run test/sessions.integration.test.js`
Expected: all PASS (new + existing)

- [ ] **Step 6: Commit**

```bash
git add src/server/sessions.js test/sessions.integration.test.js
git commit -m "feat(sessions): add openLocal() for local tmux sessions"
```

---

### Task 3: Server API + WebSocket local-shell branch

**Files:**
- Modify: `src/server/server.js:42-323`
- Modify: `src/server/index.js:1-58`
- Modify: `test/server.test.js`

**Interfaces:**
- Consumes: `config.localShell`, `config.configPath`, `sessions.openLocal()`, `upsertConfigFile()`
- Produces:
  - `GET /api/local-shell` → `{ shell: string }`
  - `PATCH /api/local-shell` ← `{ shell: string }` → `{ ok: true }` | 400 | 500
  - `POST /api/local-shell/reconnect` → `{ ok: true }`
  - WebSocket `/term?box=__local__` → local PTY session

- [ ] **Step 1: Update `makeApp` helper to include `localShell` and `configPath`**

In `test/server.test.js`, update the `makeApp` function's default config object to include the two new keys:

```js
const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 45,
    passwordHash: await hashPassword('pw'), cookieSecret: 'test-secret', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
    localShell: 'none',
    configPath: path.join(dir, 'config.json'),
    ...configOverrides,
};
```

- [ ] **Step 2: Write server tests for local-shell endpoints**

Add to `test/server.test.js`:

```js
test('GET /api/local-shell returns default shell', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'GET', url: '/api/local-shell', headers });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ shell: 'none' });
});

test('GET /api/local-shell requires auth', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/local-shell' });
  expect(res.statusCode).toBe(401);
});

test('PATCH /api/local-shell updates shell and persists to config.json', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  // Update to omz
  const patch = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: { shell: 'omz' } });
  expect(patch.statusCode).toBe(200);
  expect(patch.json()).toEqual({ ok: true });

  // Verify GET reflects change
  const get = await app.inject({ method: 'GET', url: '/api/local-shell', headers });
  expect(get.json()).toEqual({ shell: 'omz' });
});

test('PATCH /api/local-shell rejects invalid shell values', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const res = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: { shell: 'zsh' } });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'invalid shell' });

  const res2 = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: {} });
  expect(res2.statusCode).toBe(400);

  const res3 = await app.inject({ method: 'PATCH', url: '/api/local-shell', headers, payload: { shell: '' } });
  expect(res3.statusCode).toBe(400);
});

test('POST /api/local-shell/reconnect kills local PTY', async () => {
  const calls = [];
  const sessions = {
    openLocal() {}, open() {}, provision() {}, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {},
    closeKey(id) { calls.push(['closeKey', id]); },
  };
  app = await makeApp({ sessions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const res = await app.inject({ method: 'POST', url: '/api/local-shell/reconnect', headers });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
  expect(calls).toEqual([['closeKey', '__local__']]);
});

test('POST /api/local-shell/reconnect requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/local-shell/reconnect' });
  expect(res.statusCode).toBe(401);
});
```

- [ ] **Step 3: Run server tests to verify they fail**

Run: `npx vitest run test/server.test.js -t 'local-shell'`
Expected: FAIL — 404 on `/api/local-shell` (routes not registered).

- [ ] **Step 4: Add `configPath` to config object in `index.js`**

In `src/server/index.js`, after the `loadConfig()` call:

```js
const config = loadConfig();
// ... existing error check ...
config.configPath = path.resolve('config.json');
```

- [ ] **Step 5: Add local-shell endpoints and WebSocket branch in `server.js`**

In `src/server/server.js`, add the import at the top:

```js
import { upsertConfigFile } from './configFile.js';
```

Add the three endpoints after the `/api/status` route (before the WebSocket `scope` registration):

```js
app.get('/api/local-shell', { preHandler: requireAuth }, async () => {
    return { shell: config.localShell || 'none' };
  });

  app.patch('/api/local-shell', { preHandler: requireAuth }, async (req, reply) => {
    const { shell } = req.body || {};
    if (!shell || !['none', 'omz', 'omb'].includes(shell)) {
      return reply.code(400).send({ error: 'invalid shell' });
    }
    try {
      upsertConfigFile(config.configPath, { localShell: shell });
      config.localShell = shell;
    } catch (e) {
      return reply.code(500).send({ error: 'could not save config' });
    }
    return { ok: true };
  });

  app.post('/api/local-shell/reconnect', { preHandler: requireAuth }, async () => {
    if (sessions?.closeKey) sessions.closeKey('__local__');
    return { ok: true };
  });
```

Add the `__local__` branch in the WebSocket handler. Right after extracting `boxId` from query params and before the provision mode check:

```js
const { box: boxId, cid, cols, rows, mode } = req.query;

// --- Local shell ---
if (boxId === '__local__') {
  if (mode === 'provision') {
    socket.close(1008, 'provision not supported for local shell');
    return;
  }
  const size = { cols: Number(cols) || 80, rows: Number(rows) || 24 };

  let entry;
  try {
    entry = sessions.openLocal({ key: '__local__', shell: config.localShell, size });
  } catch (err) {
    const msg = err?.message || 'session error';
    try { socket.send(msg); } catch {}
    socket.close(1011);
    return;
  }

  const off = sessions.attach(entry, (d) => {
    try { if (socket.readyState === 1) socket.send(d); } catch {}
  });
  const offExit = sessions.onExit(entry, () => { try { socket.close(1000); } catch {} });
  socket.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i') sessions.write(entry, msg.d);
    else if (msg.t === 'r') sessions.resize(entry, { cols: msg.c, rows: msg.r });
  });
  socket.on('close', () => {
    if (typeof off === 'function') off();
    if (typeof offExit === 'function') offExit();
    sessions.detach(entry);
  });
  return;
}

// --- Provision mode ---
if (mode === 'provision') {
  // ... existing code ...
```

- [ ] **Step 6: Run server tests to verify they pass**

Run: `npx vitest run test/server.test.js -t 'local-shell'`
Expected: all 6 new tests PASS

- [ ] **Step 7: Run full server test suite**

Run: `npx vitest run test/server.test.js`
Expected: all PASS (new + existing)

- [ ] **Step 8: Commit**

```bash
git add src/server/server.js src/server/index.js test/server.test.js
git commit -m "feat(server): add local-shell API endpoints and WebSocket branch"
```

---

### Task 4: Frontend API client

**Files:**
- Modify: `src/web/api.ts`

**Interfaces:**
- Produces: `api.getLocalShell()`, `api.updateLocalShell(shell)`, `api.reconnectLocalShell()`

- [ ] **Step 1: Add API methods to `api.ts`**

Add these methods to the `api` object in `src/web/api.ts`:

```ts
async getLocalShell() { return j<{ shell: string }>(await fetch('/api/local-shell')); },
async updateLocalShell(shell: string) { return j<{ ok: boolean }>(await fetch('/api/local-shell', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shell }) })); },
async reconnectLocalShell() { return j<{ ok: boolean }>(await fetch('/api/local-shell/reconnect', { method: 'POST' })); },
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/web/api.ts`
Expected: no errors. (If `--noEmit` path doesn't match, use `npm run build` instead.)

- [ ] **Step 3: Commit**

```bash
git add src/web/api.ts
git commit -m "feat(web): add local-shell API client methods"
```

---

### Task 5: Frontend UI — sidebar bar + edit modal + styles

**Files:**
- Modify: `src/web/main.ts`
- Modify: `src/web/style.css`

**Interfaces:**
- Consumes: `api.getLocalShell()`, `api.updateLocalShell(shell)`, `api.reconnectLocalShell()`
- Consumes: `openTerminal(el, '__local__')` from `terminal.ts` (no changes needed)
- Produces: `.local-shell` bar in sidebar, local shell edit modal, active-state tracking for `__local__`

- [ ] **Step 1: Add CSS for `.local-shell` bar**

Add to `src/web/style.css` after the `.boxes` / `.box` rules (around line 77):

```css
.local-shell {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
.local-shell:hover { background: var(--panel-2); }
.local-shell.active { background: rgba(36, 211, 232, 0.12); box-shadow: inset 3px 0 0 var(--cyan); }
.local-shell .local-name { flex: 1; font-size: 13px; }
.local-shell .local-refresh,
.local-shell .local-edit { background: none; border: none; color: #6e7681; cursor: pointer; }
.local-shell .local-refresh { font-size: 14px; }
.local-shell .local-edit { font-size: 13px; }
.local-dot { width: 9px; height: 9px; border-radius: 50%; background: #6e7681; }
.local-dot.green { background: #2ea043; }
```

- [ ] **Step 2: Add local-shell HTML to `renderDashboard()`**

In `src/web/main.ts`, in the `renderDashboard` function, change the sidebar innerHTML. Add the `.local-shell` bar after the `<ul id="boxes">`:

```html
<aside class="sidebar">
  <div class="brand">...</div>
  <div class="actions">...</div>
  <input id="search" ... />
  <ul id="boxes" class="boxes"></ul>
  <div class="local-shell">
    <span class="local-dot"></span>
    <span class="local-name">local</span>
    <button class="local-refresh" title="Reconnect">↻</button>
    <button class="local-edit" title="Configure shell">✎</button>
  </div>
</aside>
```

- [ ] **Step 3: Add event handlers for local shell**

After the `#search` event listener in `renderDashboard()`, add:

```js
// Local shell — name click opens terminal
app.querySelector('.local-name')!.addEventListener('click', () => openLocalShell());

// Local shell — refresh
app.querySelector('.local-refresh')!.addEventListener('click', async (e) => {
  e.stopPropagation();
  await api.reconnectLocalShell();
  closeTab('__local__');
  openLocalShell();
});

// Local shell — edit
app.querySelector('.local-edit')!.addEventListener('click', (e) => {
  e.stopPropagation();
  openLocalShellEditModal();
});
```

- [ ] **Step 4: Add `openLocalShell()` function**

Add before the `openBox` function:

```js
function openLocalShell() {
  activeBoxId = '__local__';
  // De-highlight all box items
  app.querySelectorAll('.box').forEach(el => el.classList.remove('active'));
  // Highlight local shell bar
  const ls = app.querySelector('.local-shell');
  if (ls) ls.classList.add('active');
  // Update dot
  updateLocalDot();

  const stage = app.querySelector('#stage') as HTMLElement;
  for (const t of tabs.values()) t.el.style.display = 'none';
  const existing = tabs.get('__local__');
  if (existing) { existing.el.style.display = 'block'; existing.term.refit(); existing.term.focus(); return; }
  stage.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = 'term';
  stage.appendChild(el);
  const term = openTerminal(el, '__local__');
  tabs.set('__local__', { el, term });
  term.focus();
}

function updateLocalDot() {
  const dot = app.querySelector('.local-dot');
  if (dot) dot.classList.toggle('green', tabs.has('__local__'));
}
```

- [ ] **Step 5: Update `openBox()` to de-highlight local shell bar**

At the top of `openBox(b: Box)`, add a line to de-highlight the local shell:

```js
function openBox(b: Box) {
  activeBoxId = b.id;
  app.querySelectorAll('.box').forEach(el => {
    const boxEl = el as HTMLElement;
    boxEl.classList.toggle('active', boxEl.dataset.id === b.id);
  });
  // De-highlight local shell bar when switching to a box
  const ls = app.querySelector('.local-shell');
  if (ls) ls.classList.remove('active');
  // ... rest unchanged
```

- [ ] **Step 6: Update `closeTab()` to handle `__local__`**

At the bottom of `closeTab`, add de-highlight + dot update when closing the local tab:

```js
function closeTab(id: string) {
  const t = tabs.get(id);
  if (t) { t.term.dispose(); t.el.remove(); tabs.delete(id); }
  if (activeBoxId === id) {
    activeBoxId = null;
    const activeEl = app.querySelector('.box.active');
    if (activeEl) activeEl.classList.remove('active');
    const ls = app.querySelector('.local-shell');
    if (ls) ls.classList.remove('active');
  }
  if (id === '__local__') updateLocalDot();
}
```

- [ ] **Step 7: Add `openLocalShellEditModal()` function**

Add after `openBox`:

```js
async function openLocalShellEditModal() {
  let currentShell = 'none';
  try { currentShell = (await api.getLocalShell()).shell; } catch {}

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const form = document.createElement('form');
  form.className = 'modal';

  const title = document.createElement('h2');
  title.textContent = 'Local shell';

  // Radio group for shell framework
  const shellGroup = document.createElement('fieldset');
  shellGroup.className = 'radio-group';
  const shellLegend = document.createElement('legend');
  shellLegend.textContent = 'Shell framework';
  shellGroup.append(shellLegend);

  function makeRadio(value: string, label: string) {
    const wrap = document.createElement('label');
    wrap.className = 'check-field';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'localShellFramework';
    input.value = value;
    input.checked = currentShell === value;
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(input, span);
    return { wrap, input };
  }

  const shellNone = makeRadio('none', 'None');
  const shellZsh = makeRadio('omz', 'Oh My Zsh');
  const shellBash = makeRadio('omb', 'Oh My Bash');
  shellGroup.append(shellNone.wrap, shellZsh.wrap, shellBash.wrap);

  const err = document.createElement('p');
  err.className = 'err';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Save';
  actions.append(cancel, submit);

  form.append(title, shellGroup, err, actions);
  backdrop.appendChild(form);
  app.appendChild(backdrop);

  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
  function close() { document.removeEventListener('keydown', onKey); backdrop.remove(); }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    const selected = (form.querySelector('input[name="localShellFramework"]:checked') as HTMLInputElement)?.value;
    if (!selected) { submit.disabled = false; return; }
    try {
      await api.updateLocalShell(selected);
      close();
    } catch (ex: any) {
      err.textContent = ex?.message || 'Could not save shell setting';
      submit.disabled = false;
    }
  });
}
```

- [ ] **Step 8: Add the `openLocalShellEditModal` call import check**

Verify `api` is in scope (it is — `api` is used throughout `main.ts` already).

- [ ] **Step 9: Build the frontend**

Run: `npm run build`
Expected: clean build, no TypeScript errors.

- [ ] **Step 10: Run full test suite**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 11: Commit**

```bash
git add src/web/main.ts src/web/style.css
git commit -m "feat(web): add local shell sidebar button and edit modal"
```

---

### Task 6: Smoke test (manual)

- [ ] **Step 1: Start the app and verify**

Run: `npm start` (or `npm run dev`)

1. Open the app and log in
2. Verify the "local" bar is pinned at the bottom of the sidebar
3. Click "local" — a terminal should open with a local tmux session
4. Run `echo $0` — should show the default shell
5. Click the edit button (✎) — modal should show None/Oh My Zsh/Oh My Bash
6. Select "Oh My Zsh", save
7. Click refresh (↻) — terminal should reconnect
8. Run `echo $0` — should show `zsh`
9. Switch to a regular box — local bar should de-highlight
10. Switch back — terminal should still be there

- [ ] **Step 2: Verify config persistence**

Check `config.json` — should contain `"localShell": "omz"`

---

### Task 7: Verify nothing is broken

- [ ] **Step 1: Run full test suite one final time**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 2: Run e2e tests**

Run: `npm run test:e2e`
Expected: all PASS
