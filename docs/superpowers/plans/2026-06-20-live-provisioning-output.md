# Live Provisioning Output — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream provisioning script output to a slide-out side panel when adding a new box, using the existing WebSocket + node-pty infrastructure.

**Architecture:** Two-step flow — POST creates the box immediately, then a dedicated WebSocket (`/term?mode=provision`) streams the provisioning script output via node-pty. The client shows it in an xterm.js instance inside a slide-out panel. Auto-close on success; stay open on failure.

**Tech Stack:** Node.js 20+ (ESM), Fastify + @fastify/websocket, node-pty, xterm.js, Vitest, `ws` library for WS tests

## Global Constraints

- ESM everywhere (`"type": "module"`)
- Dependency injection: modules are factory functions with dependencies passed as arguments
- TDD: write failing test first, run it to confirm failure, implement, run to green, commit
- All SSH-facing fields validated through `assertBoxSafe`
- `.js` on server, `.ts` on client, built by Vite
- Follow existing patterns: `createXxx({ deps })` factories, `Map` for session entries, listener refcounting

---

### Task 1: Add `buildProvisionArgv` to sshCommand.js

**Files:**
- Modify: `src/server/sshCommand.js:91` (after `buildProbeArgv`)
- Create: (test inline in existing) `test/sshCommand.test.js`

**Interfaces:**
- Consumes: `assertBoxSafe`, `target`, `controlArgs` (all already in sshCommand.js)
- Produces: `export function buildProvisionArgv(box, script, opts = {})` — returns `string[]`

`buildProvisionArgv` is like `buildProbeArgv` but with `-tt` (force PTY) instead of `BatchMode=yes`, and it takes an arbitrary script string rather than a short probe command.

- [ ] **Step 1: Write the failing test**

Add to `test/sshCommand.test.js`:

```js
import { buildProvisionArgv } from '../src/server/sshCommand.js';

test('buildProvisionArgv constructs ssh -tt with the script', () => {
  const argv = buildProvisionArgv(
    { host: 'h1', user: 'deploy', port: 2222, proxyJump: 'gw' },
    'echo hi',
    { hostKeyPolicy: 'accept-new', sshConfigFile: '/tmp/cfg', controlDir: '/tmp/cm' },
  );
  expect(argv).toContain('-tt');
  expect(argv).toContain('-o');
  expect(argv).toContain('StrictHostKeyChecking=accept-new');
  expect(argv).toContain('-o');
  expect(argv).toContain('ConnectTimeout=6');
  expect(argv).toContain('-J');
  expect(argv).toContain('gw');
  expect(argv).toContain('-p');
  expect(argv).toContain('2222');
  expect(argv).toContain('deploy@h1');
  expect(argv[argv.length - 1]).toBe('echo hi');
  expect(argv[0]).toBe('-F'); // sshConfigFile goes first
  expect(argv[1]).toBe('/tmp/cfg');
});

test('buildProvisionArgv minimal box', () => {
  const argv = buildProvisionArgv({ host: 'h1' }, 'id');
  expect(argv).toContain('-tt');
  expect(argv).not.toContain('-J');
  expect(argv).not.toContain('-p');
  expect(argv[argv.length - 2]).toBe('h1');
  expect(argv[argv.length - 1]).toBe('id');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sshCommand.test.js -t 'buildProvisionArgv'`
Expected: FAIL — `buildProvisionArgv is not defined` or similar

- [ ] **Step 3: Write `buildProvisionArgv`**

Add after `buildProbeArgv` (after line 91) in `src/server/sshCommand.js`:

```js
export function buildProvisionArgv(box, script, opts = {}) {
  assertBoxSafe(box);
  const policy = opts.hostKeyPolicy || 'accept-new';
  const argv = [
    '-tt',
    '-o', `StrictHostKeyChecking=${policy}`,
    '-o', 'ConnectTimeout=6',
    ...controlArgs(opts),
  ];
  if (box.proxyJump) argv.push('-J', box.proxyJump);
  if (box.port) argv.push('-p', String(box.port));
  argv.push(target(box), script);
  if (opts.sshConfigFile) argv.unshift('-F', opts.sshConfigFile);
  return argv;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sshCommand.test.js -t 'buildProvisionArgv'`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/sshCommand.js test/sshCommand.test.js
git commit -m "feat(ssh): add buildProvisionArgv for PTY provisioning"

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

### Task 2: Add `provision()` to sessions.js

**Files:**
- Modify: `src/server/sessions.js`
- Create/modify: `test/sessions.integration.test.js`

**Interfaces:**
- Consumes: `buildProvisionArgv` from `./sshCommand.js` (add to existing import)
- Produces: `sessions.provision({ key, box, script, opts? })` → entry object (same shape as `open()`)
- The returned entry supports the existing `attach()`, `onExit()`, `write()`, `resize()`, `detach()`, `close()` methods
- The entry's `onExit` callbacks fire with no arguments; the exit code is stored as `entry.exitCode`

`provision()` is like `open()` but spawns `ssh -tt <host> <script>` instead of `ssh -tt <host> tmux new-session -A -D -s <session>`.

- [ ] **Step 1: Write the failing integration test**

Add to `test/sessions.integration.test.js`:

```js
test('provision runs a script on the box and streams output', async () => {
  const { box, env, sshConfigFile, cleanup } = await setupLocalBox();
  active = cleanup;
  const mgr = createSessionManager({ sshConfigFile, spawnEnv: env, graceSeconds: 1 });

  const entry = mgr.provision({ key: 'prov-test-1', box, script: 'echo HELLO_PROVISION; echo ERR_TEST >&2; exit 0' });
  const buf = [];
  let exitCode = null;
  const off = mgr.attach(entry, (d) => buf.push(d));
  const offExit = mgr.onExit(entry, () => { exitCode = entry.exitCode; });

  // Wait for PTY to exit
  await new Promise((resolve) => {
    const check = () => { if (entry.exited) resolve(undefined); else setTimeout(check, 100); };
    check();
  });

  expect(exitCode).toBe(0);
  const text = buf.join('');
  expect(text).toContain('HELLO_PROVISION');
  expect(text).toContain('ERR_TEST');
  off();
  offExit();
});

test('provision keyed separately from interactive sessions', async () => {
  const { box, session, env, sshConfigFile, cleanup } = await setupLocalBox();
  active = cleanup;
  const mgr = createSessionManager({ sshConfigFile, spawnEnv: env, graceSeconds: 1 });
  const size = { cols: 80, rows: 24 };

  const inter = mgr.open({ key: 'box-1', box, session, size });
  const prov = mgr.provision({ key: 'provision:box-1', box, script: 'echo ok' });

  expect(inter).not.toBe(prov);
  expect(mgr._count()).toBe(2);

  mgr.close(inter);
  mgr.close(prov);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sessions.integration.test.js -t 'provision'`
Expected: FAIL — `mgr.provision is not a function`

- [ ] **Step 3: Implement `provision()` in sessions.js**

Change the import line to include `buildProvisionArgv`:

```js
import { buildAttachArgv, buildProvisionArgv } from './sshCommand.js';
```

Add the `provision` function inside `createSessionManager` (after `open`, before `attach`):

```js
function provision({ key, box, script, opts = {} }) {
  const existing = entries.get(key);
  if (existing && !existing.exited) {
    if (existing.graceTimer) { clearTimeout(existing.graceTimer); existing.graceTimer = null; }
    return existing;
  }
  const argv = buildProvisionArgv(box, script, { hostKeyPolicy, sshConfigFile, controlDir, ...opts });
  const pty = spawn('ssh', argv, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: spawnEnv,
  });
  const entry = { key, pty, listeners: new Set(), exitCbs: new Set(), graceTimer: null, exited: false, exitCode: null };
  pty.onData((d) => {
    for (const fn of entry.listeners) {
      try { fn(d); } catch {}
    }
  });
  pty.onExit(({ exitCode }) => {
    entry.exited = true;
    entry.exitCode = exitCode;
    entries.delete(key);
    for (const cb of entry.exitCbs) cb();
  });
  entries.set(key, entry);
  return entry;
}
```

Add `provision` to the returned object:

```js
return { open, provision, attach, onExit, write, resize, detach, close, closeKey, _count: () => entries.size };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sessions.integration.test.js -t 'provision'`
Expected: PASS (2 tests)

Also run the full sessions test suite to confirm no regressions:
Run: `npx vitest run test/sessions.integration.test.js`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/sessions.js test/sessions.integration.test.js
git commit -m "feat(sessions): add provision() for one-shot PTY script execution

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

### Task 3: Change POST /api/boxes to return immediately + add provision WebSocket mode

**Files:**
- Modify: `src/server/server.js`
- Create/modify: `test/server.ws.integration.test.js`

**Interfaces:**
- Consumes: `buildEnsureTmuxRemote` from `./boxActions.js` (new import)
- Produces: `POST /api/boxes` returns 201 with the box immediately (no provisioning)
- Produces: `GET /term?mode=provision&box=<id>&ohMyTmux=0|1&ohMyZsh=0|1` — streams provisioning output, sends `{"t":"x","code":<n>}` on completion, rolls back box on failure

- [ ] **Step 1: Write the failing tests**

Add to `test/server.ws.integration.test.js`:

```js
import { buildEnsureTmuxRemote } from '../src/server/boxActions.js';

test('POST /api/boxes returns immediately without provisioning', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-post-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new',
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const app = buildServer({ config, store, sessions: null, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);

  const res = await app.inject({
    method: 'POST', url: '/api/boxes',
    headers: { cookie: `${c.name}=${c.value}` },
    payload: { host: 'example.com', installOhMyTmux: true, installOhMyZsh: true },
  });
  expect(res.statusCode).toBe(201);
  const body = JSON.parse(res.body);
  expect(body.id).toBeTruthy();
  expect(body.host).toBe('example.com');
  // Box should exist in store immediately
  const boxes = await store.listBoxes();
  expect(boxes.find((b) => b.id === body.id)).toBeTruthy();
});

test('provision WS streams script output and sends exit frame on success', async () => {
  const { box, session, env, sshConfigFile, cleanup } = await setupLocalBox();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-prov-ws-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: box.host, sessionName: session });
  const sessions = createSessionManager({ graceSeconds: 5, spawnEnv: env, sshConfigFile });

  const app = buildServer({
    config, store, sessions,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    boxActions: {
      ensureReady: async () => ({ ok: true }),
      killSession: async () => ({ ok: true }),
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  teardown = async () => { await app.close(); await cleanup(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&mode=provision&cols=120&rows=40&ohMyTmux=0&ohMyZsh=0`,
    { headers: { cookie: `${c.name}=${c.value}` } },
  );
  const chunks = [];
  let exitFrame = null;
  ws.on('message', (d) => {
    const raw = d.toString();
    try {
      const msg = JSON.parse(raw);
      if (msg.t === 'x') { exitFrame = msg; return; }
    } catch {}
    chunks.push(raw);
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  // Wait for completion
  await new Promise((resolve) => {
    const check = () => { if (exitFrame) resolve(undefined); else setTimeout(check, 100); };
    setTimeout(check, 100);
    setTimeout(() => resolve(undefined), 30000);
  });

  expect(exitFrame).toBeTruthy();
  expect(exitFrame.t).toBe('x');
  expect(exitFrame.code).toBe(0);
  const text = chunks.join('');
  expect(text.length).toBeGreaterThan(0);
}, 45000);

test('provision WS rolls back box on script failure', async () => {
  const { box, env, sshConfigFile, cleanup } = await setupLocalBox();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-prov-fail-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: box.host, sessionName: session });
  const sessions = createSessionManager({ graceSeconds: 5, spawnEnv: env, sshConfigFile });

  const app = buildServer({
    config, store, sessions,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    boxActions: {
      ensureReady: async () => ({ ok: true }),
      killSession: async () => ({ ok: true }),
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  teardown = async () => { await app.close(); await cleanup(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);

  // Use a script that exits non-zero
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&mode=provision&cols=120&rows=40&ohMyTmux=0&ohMyZsh=0`,
    { headers: { cookie: `${c.name}=${c.value}` } },
  );
  let exitFrame = null;
  ws.on('message', (d) => {
    try {
      const msg = JSON.parse(d.toString());
      if (msg.t === 'x') { exitFrame = msg; }
    } catch {}
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  // Wait for completion — the remote script is the standard ensureTmuxRemote
  // which should succeed. For a true failure test we'd need a bogus host.
  // Instead we test the success path here; the failure path is covered by
  // the unit test in boxActions.test.js.
  await new Promise((resolve) => {
    const check = () => { if (exitFrame) resolve(undefined); else setTimeout(check, 100); };
    setTimeout(check, 100);
    setTimeout(() => resolve(undefined), 30000);
  });
  expect(exitFrame).toBeTruthy();
  expect(exitFrame.code).toBe(0);
}, 45000);
```

Wait — the third test can't easily force a script failure against a real box. Let me restructure. The success test is sufficient for the integration test; the rollback path is tested separately via a unit test with a mock sessions. Let me simplify the third test to test the rollback behavior.

Actually, let me write a cleaner third test that uses a mock sessions object to test rollback:

```js
test('provision WS rolls back box on non-zero exit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-prov-rollback-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: 'h1', sessionName: 'web' });

  // Mock sessions that simulates a failing provision
  const sessions = {
    provision({ key }) {
      const listeners = new Set();
      const exitCbs = new Set();
      const entry = {
        key, listeners, exitCbs, exited: false, exitCode: null,
        pty: { onData() {}, onExit() {}, kill() {}, resize() {} },
      };
      // Simulate failure: emit a bit of output then exit 1
      setTimeout(() => {
        for (const fn of listeners) {
          try { fn('Installing tmux...\n'); } catch {}
        }
      }, 10);
      setTimeout(() => {
        entry.exited = true;
        entry.exitCode = 1;
        for (const cb of exitCbs) cb();
      }, 20);
      return entry;
    },
    attach(entry, fn) { entry.listeners.add(fn); return () => entry.listeners.delete(fn); },
    onExit(entry, cb) { entry.exitCbs.add(cb); return () => entry.exitCbs.delete(cb); },
    write() {}, resize() {}, detach() {}, close() {},
  };

  const app = buildServer({
    config, store, sessions,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    boxActions: { ensureReady: async () => ({ ok: true }), killSession: async () => ({ ok: true }) },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();

  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/term?box=${saved.id}&mode=provision&cols=80&rows=24&ohMyTmux=0&ohMyZsh=0`,
    { headers: { cookie: `${c.name}=${c.value}` } },
  );
  let exitFrame = null;
  ws.on('message', (d) => {
    try { const msg = JSON.parse(d.toString()); if (msg.t === 'x') exitFrame = msg; } catch {}
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await new Promise((resolve) => {
    const check = () => { if (exitFrame) resolve(undefined); else setTimeout(check, 50); };
    setTimeout(check, 50);
  });

  expect(exitFrame).toBeTruthy();
  expect(exitFrame.code).toBe(1);

  // Box should have been rolled back
  const boxes = await store.listBoxes();
  expect(boxes.find((b) => b.id === saved.id)).toBeFalsy();
}, 10000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.ws.integration.test.js -t 'POST /api/boxes returns immediately' -t 'provision WS streams' -t 'rollback'`
Expected: FAIL — 201 not returned, mode=provision not handled

- [ ] **Step 3: Implement the server-side changes**

In `src/server/server.js`:

Add import at top:
```js
import { buildEnsureTmuxRemote } from './boxActions.js';
```

Change `POST /api/boxes` (lines 183-195) to return immediately:

```js
app.post('/api/boxes', { preHandler: requireAuth }, async (req, reply) => {
  try {
    const { installOhMyTmux = false, installOhMyZsh = false, ...boxSpec } = req.body || {};
    const box = await store.addBox(boxSpec);
    return reply.code(201).send(box);
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});
```

Change the `/term` WebSocket handler to support `mode=provision`. In the existing handler (starting at line 220), add the provision branch after the box lookup:

```js
app.register(async (scope) => {
  scope.get('/term', { websocket: true }, async (socket, req) => {
    if (!hasTrustedOrigin(req)) { socket.close(1008, 'forbidden origin'); return; }
    if (!isAuthed(req)) { socket.close(1008, 'unauthorized'); return; }
    const { box: boxId, cid, cols, rows, mode } = req.query;
    const box = await store.getBox(boxId);
    if (!box) { socket.close(1008, 'unknown box'); return; }

    // --- Provision mode ---
    if (mode === 'provision') {
      const { ohMyTmux, ohMyZsh } = req.query;
      const script = buildEnsureTmuxRemote(box.sessionName, box.startupCommand, {
        installOhMyTmux: ohMyTmux === '1',
        installOhMyZsh: ohMyZsh === '1',
      });

      if (!sessions?.provision) {
        try { socket.send(JSON.stringify({ t: 'x', code: 1 })); } catch {}
        socket.close(1011);
        return;
      }

      let entry;
      try {
        entry = sessions.provision({ key: `provision:${boxId}`, box, script });
      } catch (err) {
        const msg = err?.message || 'provision error';
        try { socket.send(msg); } catch {}
        socket.close(1011);
        return;
      }

      const off = sessions.attach(entry, (d) => {
        try { if (socket.readyState === 1) socket.send(d); } catch {}
      });
      const offExit = sessions.onExit(entry, () => {
        const code = entry.exitCode != null ? entry.exitCode : 1;
        try {
          if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'x', code }));
        } catch {}
        if (code !== 0) {
          store.removeBox(boxId).catch(() => {});
        }
        try { socket.close(1000); } catch {}
      });
      socket.on('close', () => {
        if (typeof off === 'function') off();
        if (typeof offExit === 'function') offExit();
        sessions.close(entry);
      });
      return;
    }

    // --- Interactive mode (existing) ---
    const size = { cols: Number(cols) || 80, rows: Number(rows) || 24 };

    let entry;
    try {
      entry = sessions.open({ key: boxId, box, session: box.sessionName, size });
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
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/server.ws.integration.test.js -t 'POST /api/boxes returns immediately'`
Expected: PASS

Run: `npx vitest run test/server.ws.integration.test.js -t 'provision WS streams'`
Expected: PASS (may take up to 45s — provisioning script runs against local box)

Run: `npx vitest run test/server.ws.integration.test.js -t 'provision WS rolls back'`
Expected: PASS

Run the full server test suite to confirm no regressions:
Run: `npx vitest run test/server.test.js test/server.ws.integration.test.js`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js test/server.ws.integration.test.js
git commit -m "feat(server): add provision WebSocket mode, return box immediately from POST

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

### Task 4: Add client-side provision terminal function

**Files:**
- Modify: `src/web/terminal.ts`
- Modify: `src/web/api.ts` (minor: AddBoxSpec type cleanup)

**Interfaces:**
- Consumes: `Terminal`, `FitAddon` from xterm.js (already imported)
- Produces: `export function openProvisionTerminal(parent, boxId, options, onComplete)` → `{ dispose, focus }`

The `openProvisionTerminal` function creates a read-only xterm.js instance connected to the provision WebSocket. It parses the exit frame from the server and calls `onComplete(code)`. Unlike the interactive terminal, it does not send input, does not send resize, and does not auto-reconnect.

- [ ] **Step 1: Write the function (no separate test — tested via e2e/manual)**

This is a client-side TypeScript function built by Vite. There's no existing unit test harness for the client. Add the function and verify it compiles.

Add to `src/web/terminal.ts` (after `openTerminal`):

```ts
export interface ProvisionOptions {
  ohMyTmux: boolean;
  ohMyZsh: boolean;
}

export function openProvisionTerminal(
  parent: HTMLElement,
  boxId: string,
  options: ProvisionOptions,
  onComplete: (code: number) => void,
) {
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    theme: { background: '#0b0e14' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(parent);
  fit.fit();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = [
    `box=${encodeURIComponent(boxId)}`,
    `mode=provision`,
    `cols=${term.cols}`,
    `rows=${term.rows}`,
    `ohMyTmux=${options.ohMyTmux ? '1' : '0'}`,
    `ohMyZsh=${options.ohMyZsh ? '1' : '0'}`,
  ].join('&');
  const ws = new WebSocket(`${proto}://${location.host}/term?${qs}`);

  let done = false;

  ws.onmessage = (e) => {
    const raw = typeof e.data === 'string' ? e.data : '';
    try {
      const msg = JSON.parse(raw);
      if (msg.t === 'x') {
        done = true;
        onComplete(msg.code);
        return;
      }
    } catch {}
    term.write(raw);
  };

  ws.onclose = () => {
    if (!done) onComplete(-1);
  };

  const onResize = () => { fit.fit(); };
  window.addEventListener('resize', onResize);

  return {
    dispose: () => {
      window.removeEventListener('resize', onResize);
      if (!done) { done = true; onComplete(-1); }
      ws.close();
      term.dispose();
    },
    focus: () => term.focus(),
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add src/web/terminal.ts
git commit -m "feat(web): add openProvisionTerminal for provisioning output

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

### Task 5: Add the slide-out provision panel UI

**Files:**
- Modify: `src/web/main.ts`
- Modify: `src/web/index.html`
- Modify: `src/web/style.css`

**Interfaces:**
- Consumes: `openProvisionTerminal` from `./terminal` (new import), `Box` from `./api` (existing)
- Produces: `openProvisionPanel(box, options)` — slides out panel, starts terminal, handles auto-close/error

This task wires the new add-box flow: POST returns immediately → close add modal → slide out provision panel → stream output → auto-close on success or stay open on failure.

- [ ] **Step 1: Add HTML for the provision panel**

In `src/web/index.html`, add after `<div id="app">` (line 10):

```html
<div id="provision-panel" class="provision-panel">
  <div class="provision-header">
    <span class="provision-title"></span>
    <span class="provision-status"></span>
    <button class="provision-close" style="display:none">✕</button>
  </div>
  <div class="provision-term"></div>
</div>
```

Wait — the provision panel should be inside `#app` since `main.ts` replaces `#app.innerHTML` on login/dashboard transitions. But the panel needs to persist across those renders. Let me put it outside `#app`:

```html
<body>
  <div id="app"></div>
  <div id="provision-panel" class="provision-panel">
    <div class="provision-header">
      <span class="provision-title"></span>
      <span class="provision-status"></span>
      <button class="provision-close" style="display:none">✕</button>
    </div>
    <div class="provision-term"></div>
  </div>
  <script type="module" src="/main.ts"></script>
</body>
```

- [ ] **Step 2: Add CSS for the panel**

Add to `src/web/style.css` (at end of file):

```css
.provision-panel {
  position: fixed;
  top: 0; right: 0;
  width: 560px;
  max-width: 92vw;
  height: 100vh;
  z-index: 20;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.25s ease;
}
.provision-panel.open {
  transform: translateX(0);
}
.provision-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  flex-shrink: 0;
}
.provision-title {
  flex: 1;
  font-weight: 600;
  font-size: 14px;
}
.provision-status {
  font-size: 13px;
}
.provision-status.success { color: var(--green); }
.provision-status.error { color: #f85149; }
.provision-close {
  background: none;
  border: none;
  color: var(--muted);
  cursor: pointer;
  font-size: 18px;
  padding: 0 4px;
  line-height: 1;
}
.provision-term {
  flex: 1;
  padding: 6px;
  overflow: hidden;
}
```

- [ ] **Step 3: Add `openProvisionPanel` to main.ts and update add-box flow**

In `src/web/main.ts`:

Add import (update the existing import from `./terminal`):
```ts
import { openTerminal, openProvisionTerminal } from './terminal';
```

Add `openProvisionPanel` function (after `closeTab`, around line 175):

```ts
function openProvisionPanel(box: Box, options: { ohMyTmux: boolean; ohMyZsh: boolean }) {
  const panel = document.getElementById('provision-panel')!;
  const title = panel.querySelector('.provision-title')!;
  const status = panel.querySelector('.provision-status')!;
  const container = panel.querySelector('.provision-term') as HTMLElement;
  const closeBtn = panel.querySelector('.provision-close') as HTMLElement;

  // Reset state
  title.textContent = `Provisioning ${box.label}`;
  status.textContent = '';
  status.className = 'provision-status';
  closeBtn.style.display = 'none';
  container.innerHTML = '';

  panel.classList.add('open');

  const term = openProvisionTerminal(container, box.id, options, (code) => {
    if (code === 0) {
      status.textContent = '✓ Complete';
      status.className = 'provision-status success';
      refresh();
      setTimeout(() => {
        panel.classList.remove('open');
        term.dispose();
      }, 2000);
    } else {
      status.textContent = `✗ Failed (exit ${code})`;
      status.className = 'provision-status error';
      closeBtn.style.display = '';
    }
  });

  closeBtn.addEventListener('click', () => {
    panel.classList.remove('open');
    term.dispose();
  }, { once: true });
}
```

Update the add-box form submit handler (around line 251). Change the submit handler to use the two-step flow:

```ts
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const host = fields.host.value.trim();
  if (!host) { err.textContent = 'Host is required'; return; }
  const spec: AddBoxSpec = { host, installOhMyTmux: installOhMyTmuxInput.checked, installOhMyZsh: installOhMyZshInput.checked };
  const label = fields.label.value.trim(); if (label) spec.label = label;
  const user = fields.user.value.trim(); if (user) spec.user = user;
  const jump = fields.proxyJump.value.trim(); if (jump) spec.proxyJump = jump;
  const portRaw = fields.port.value.trim();
  if (portRaw) {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { err.textContent = 'Port must be 1–65535'; return; }
    spec.port = port;
  }
  submit.disabled = true;
  try {
    const box = await api.addBox(spec);
    close();
    openProvisionPanel(box, {
      ohMyTmux: installOhMyTmuxInput.checked,
      ohMyZsh: installOhMyZshInput.checked,
    });
  } catch (e: any) {
    err.textContent = e?.message || 'Could not add box';
    submit.disabled = false;
  }
});
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: build succeeds with no errors

- [ ] **Step 5: Commit**

```bash
git add src/web/main.ts src/web/index.html src/web/style.css
git commit -m "feat(web): add slide-out provision panel with live output

Co-Authored-By: Claude <noreply@anthropic.com>
```

---

### Task 6: Integration smoke test — full add-box flow

**Files:**
- Modify: `test/server.ws.integration.test.js` (tests already added in Task 3)

**Purpose:** Confirm the complete server-side flow works end-to-end: POST creates box → provision WS streams output → success auto-closes, failure rolls back.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 2: Run the specific provision tests**

Run: `npx vitest run test/server.ws.integration.test.js test/sessions.integration.test.js test/sshCommand.test.js`
Expected: all tests PASS

- [ ] **Step 3: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "test: verify full provision flow end-to-end

Co-Authored-By: Claude <noreply@anthropic.com>
```
