# Oh My Tmux Install Option Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a checked-by-default Add box option that installs Oh My Tmux on the remote host when missing.

**Architecture:** The frontend sends a transient `installOhMyTmux` boolean with `POST /api/boxes`. The server strips that option before storing the box and passes it to `boxActions.ensureReady`, which conditionally injects the upstream manual `~` install commands into the remote provisioning script.

**Tech Stack:** Node 20 ESM server, Fastify injection tests, TypeScript Vite frontend, Vitest.

---

### Task 1: Server Request Option

**Files:**
- Modify: `test/server.test.js`
- Modify: `src/server/server.js`

- [ ] **Step 1: Write the failing server test**

Add this test near the existing add-box provisioning tests in `test/server.test.js`:

```js
test('adding a box passes transient Oh My Tmux install option without persisting it', async () => {
  const calls = [];
  const boxActions = {
    async ensureReady(box, options) { calls.push({ box, options }); },
  };
  app = await makeApp({ boxActions });
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1', installOhMyTmux: true },
  });

  expect(created.statusCode).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0].options).toEqual({ installOhMyTmux: true });
  expect(calls[0].box).not.toHaveProperty('installOhMyTmux');
  expect(created.json()).not.toHaveProperty('installOhMyTmux');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()[0]).not.toHaveProperty('installOhMyTmux');
});
```

- [ ] **Step 2: Verify the test fails**

Run:

```bash
npm test -- test/server.test.js -t "adding a box passes transient Oh My Tmux install option"
```

Expected: FAIL because `ensureReady` receives no second argument.

- [ ] **Step 3: Implement the minimal server change**

In `src/server/server.js`, change the add-box handler to extract the transient option:

```js
  app.post('/api/boxes', { preHandler: requireAuth }, async (req, reply) => {
    let box;
    try {
      const { installOhMyTmux = false, ...boxSpec } = req.body || {};
      box = await store.addBox(boxSpec);
      if (boxActions?.ensureReady) await boxActions.ensureReady(box, { installOhMyTmux: installOhMyTmux === true });
      return box;
    }
    catch (e) {
      if (box) await store.removeBox(box.id).catch(() => {});
      return reply.code(400).send({ error: e.message });
    }
  });
```

- [ ] **Step 4: Verify the test passes**

Run:

```bash
npm test -- test/server.test.js -t "adding a box passes transient Oh My Tmux install option"
```

Expected: PASS.

### Task 2: Remote Provisioning Script

**Files:**
- Modify: `test/boxActions.test.js`
- Modify: `src/server/boxActions.js`

- [ ] **Step 1: Write the failing script-content test**

Add this test to `test/boxActions.test.js`:

```js
test('buildEnsureTmuxRemote includes Oh My Tmux manual install steps when requested', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { installOhMyTmux: true });

  expect(remote).toContain('https://github.com/gpakosz/.tmux.git');
  expect(remote).toContain('git clone --single-branch https://github.com/gpakosz/.tmux.git .tmux');
  expect(remote).toContain('ln -s -f .tmux/.tmux.conf .tmux.conf');
  expect(remote).toContain('cp .tmux/.tmux.conf.local .tmux.conf.local');
});
```

- [ ] **Step 2: Verify the test fails**

Run:

```bash
npm test -- test/boxActions.test.js -t "includes Oh My Tmux manual install steps"
```

Expected: FAIL because `buildEnsureTmuxRemote` does not accept or use the option.

- [ ] **Step 3: Implement conditional script generation**

Update `src/server/boxActions.js` so `buildEnsureTmuxRemote` accepts options and injects the install block:

```js
export function buildEnsureTmuxRemote(session, startupCommand, options = {}) {
  const sess = shSingleQuote(sanitizeSession(session));
  const startup = startupCommand ? ` ${shSingleQuote(startupCommand)}` : '';
  const ohMyTmux = options.installOhMyTmux ? [
    'cd',
    'if [ ! -f .tmux/.tmux.conf ]; then',
    '  rm -rf .tmux',
    '  git clone --single-branch https://github.com/gpakosz/.tmux.git .tmux',
    '  ln -s -f .tmux/.tmux.conf .tmux.conf',
    '  cp .tmux/.tmux.conf.local .tmux.conf.local',
    'fi',
  ] : [];
  return [
    'set -eu',
    'TMUX_BIN="$(command -v tmux || true)"',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for p in /usr/bin/tmux /usr/local/bin/tmux /bin/tmux; do if [ -x "$p" ]; then TMUX_BIN="$p"; break; fi; done',
    'fi',
    'if [ -z "$TMUX_BIN" ]; then',
    "  SUDO=''",
    "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo -n'; fi",
    '  if command -v apt-get >/dev/null 2>&1; then',
    '    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux || {',
    '      $SUDO apt-get update || true',
    '      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux',
    '    }',
    '  elif command -v dnf >/dev/null 2>&1; then',
    '    $SUDO dnf install -y tmux',
    '  elif command -v yum >/dev/null 2>&1; then',
    '    $SUDO yum install -y tmux',
    '  elif command -v pacman >/dev/null 2>&1; then',
    '    $SUDO pacman -Sy --noconfirm tmux',
    '  elif command -v apk >/dev/null 2>&1; then',
    '    $SUDO apk add tmux',
    '  elif command -v zypper >/dev/null 2>&1; then',
    '    $SUDO zypper --non-interactive install tmux',
    '  else',
    "    echo 'tmux is not installed and no supported package manager was found' >&2",
    '    exit 127',
    '  fi',
    'fi',
    'TMUX_BIN="$(command -v tmux || true)"',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for p in /usr/bin/tmux /usr/local/bin/tmux /bin/tmux; do if [ -x "$p" ]; then TMUX_BIN="$p"; break; fi; done',
    'fi',
    '[ -n "$TMUX_BIN" ]',
    ...ohMyTmux,
    `"$TMUX_BIN" has-session -t ${sess} 2>/dev/null || "$TMUX_BIN" new-session -d -s ${sess}${startup}`,
  ].join('\n');
}
```

Update `ensureReady` in the same file:

```js
    async ensureReady(box, options = {}) {
      const res = await runRemote(box, buildEnsureTmuxRemote(box.sessionName, box.startupCommand, options), 120000);
      if (res.code !== 0) {
        const msg = String(res.stderr || res.stdout || '').trim() || 'could not install tmux or create session';
        throw new Error(msg);
      }
      return { ok: true };
    },
```

- [ ] **Step 4: Verify the script-content test passes**

Run:

```bash
npm test -- test/boxActions.test.js -t "includes Oh My Tmux manual install steps"
```

Expected: PASS.

- [ ] **Step 5: Write the failing idempotence test**

Add this test to `test/boxActions.test.js`:

```js
test('buildEnsureTmuxRemote skips Oh My Tmux clone when config exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-oh-my-tmux-'));
  await fs.mkdir(path.join(dir, '.tmux'));
  await fs.writeFile(path.join(dir, '.tmux', '.tmux.conf'), '# existing\n');
  await fs.writeFile(path.join(dir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'git'), '#!/bin/sh\necho cloned > "$TMUXIFIER_GIT_LOG"\nexit 0\n', { mode: 0o755 });
  const gitLog = path.join(dir, 'git.log');

  const res = await runShell(`cd ${JSON.stringify(dir)}
${buildEnsureTmuxRemote('web', undefined, { installOhMyTmux: true })}`, {
    PATH: dir,
    TMUXIFIER_GIT_LOG: gitLog,
  });

  expect(res.code).toBe(0);
  await expect(fs.stat(gitLog)).rejects.toMatchObject({ code: 'ENOENT' });
});
```

- [ ] **Step 6: Verify the idempotence test passes**

Run:

```bash
npm test -- test/boxActions.test.js -t "skips Oh My Tmux clone"
```

Expected: PASS.

### Task 3: Frontend Checkbox

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/main.ts`

- [ ] **Step 1: Extend the API payload type**

In `src/web/api.ts`, add an add-box input type and use it:

```ts
export type AddBoxSpec = Partial<Box> & { installOhMyTmux?: boolean };
```

Change `addBox`:

```ts
  async addBox(spec: AddBoxSpec) { return j<Box>(await fetch('/api/boxes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) })); },
```

- [ ] **Step 2: Add the checked checkbox to the modal**

In `src/web/main.ts`, import the new type:

```ts
import { api, type AddBoxSpec, type Box, type Status } from './api';
```

Inside `openAddDialog`, create the checkbox after the `field` helper:

```ts
  const installOhMyTmux = document.createElement('label');
  installOhMyTmux.className = 'check-field';
  const installOhMyTmuxInput = document.createElement('input');
  installOhMyTmuxInput.type = 'checkbox';
  installOhMyTmuxInput.checked = true;
  const installOhMyTmuxText = document.createElement('span');
  installOhMyTmuxText.textContent = 'Install Oh My Tmux if missing';
  installOhMyTmux.append(installOhMyTmuxInput, installOhMyTmuxText);
```

Add `installOhMyTmux` to the `form.append(...)` call after `proxyJump`.

In the submit handler, change the spec construction:

```ts
    const spec: AddBoxSpec = { host, installOhMyTmux: installOhMyTmuxInput.checked };
```

- [ ] **Step 3: Verify frontend types**

Run:

```bash
npm test -- test/server.test.js test/boxActions.test.js
npm run build
```

Expected: tests pass and Vite build completes.

### Task 4: Final Verification

**Files:**
- Review: `src/server/server.js`
- Review: `src/server/boxActions.js`
- Review: `src/web/api.ts`
- Review: `src/web/main.ts`
- Review: `test/server.test.js`
- Review: `test/boxActions.test.js`

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm test -- test/server.test.js test/boxActions.test.js
```

Expected: all tests in both files pass.

- [ ] **Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected: all Vitest tests pass.

- [ ] **Step 3: Build the frontend**

Run:

```bash
npm run build
```

Expected: TypeScript and Vite build complete successfully.
