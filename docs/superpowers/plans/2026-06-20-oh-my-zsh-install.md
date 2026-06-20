# Oh My Zsh Install Option Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a checked-by-default "Install Oh My Zsh if missing" checkbox to the Add Box dialog that provisions zsh and Oh My Zsh on the remote host, mirroring the existing oh-my-tmux pattern.

**Architecture:** Same transient-option pattern as `installOhMyTmux`. The checkbox value travels as `installOhMyZsh` in the `POST /api/boxes` body, is extracted by `server.js`, passed to `boxActions.ensureReady` (but not persisted in `boxes.json`), and triggers zsh + Oh My Zsh install commands in the remote provisioning script built by `buildEnsureTmuxRemote`.

**Tech Stack:** ESM JavaScript (server), TypeScript (web client), Vitest (tests), bash (remote provisioning script)

## Global Constraints

- Follow the oh-my-tmux pattern exactly — same files, same flow, same error handling
- Transient options must not be persisted in `boxes.json`
- All new code paths must have tests written first (TDD)
- Checkbox defaults to checked
- CLI: `npm test` for unit/integration, `npm run build` for TypeScript

---

### Task 1: Add oh-my-zsh scripting to `buildEnsureTmuxRemote` (test first)

**Files:**
- Modify: `test/boxActions.test.js`
- Modify: `src/server/boxActions.js`

**Interfaces:**
- Consumes: `buildEnsureTmuxRemote(session, startupCommand, options)` — existing function, `options.installOhMyZsh` is the new boolean field
- Produces: Remote script includes zsh package-manager install + oh-my-zsh upstream install steps when `options.installOhMyZsh` is true

- [ ] **Step 1: Write the failing test for oh-my-zsh install steps**

Add to `test/boxActions.test.js` after the existing oh-my-tmux tests (after line 33):

```js
test('buildEnsureTmuxRemote includes zsh and Oh My Zsh install steps when requested', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { installOhMyZsh: true });

  // Installs zsh via package manager detection
  expect(remote).toContain('command -v zsh');
  expect(remote).toContain('apt-get install -y zsh');
  expect(remote).toContain('dnf install -y zsh');

  // Fetches upstream Oh My Zsh install script
  expect(remote).toContain('https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh');
  expect(remote).toContain('RUNZSH=no');
  expect(remote).toContain('CHSH=yes');
});

test('buildEnsureTmuxRemote omits Oh My Zsh steps when not requested', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, {});
  expect(remote).not.toContain('command -v zsh');
  expect(remote).not.toContain('https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh');
  expect(remote).not.toContain('RUNZSH=no');
});

test('buildEnsureTmuxRemote skips Oh My Zsh clone when .oh-my-zsh exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-oh-my-zsh-'));
  await fs.mkdir(path.join(dir, '.oh-my-zsh'));
  await fs.writeFile(path.join(dir, 'zsh'), '#!/bin/sh\necho "$*" >> "$TMUXIFIER_ZSH_LOG"\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'curl'), '#!/bin/sh\necho curled >> "$TMUXIFIER_CURL_LOG"\nexit 0\n', { mode: 0o755 });
  const curlLog = path.join(dir, 'curl.log');

  const res = await runShell(`cd ${JSON.stringify(dir)}
${buildEnsureTmuxRemote('web', undefined, { installOhMyZsh: true })}`, {
    PATH: dir,
    TMUXIFIER_CURL_LOG: curlLog,
  });

  expect(res.code).toBe(0);
  await expect(fs.stat(curlLog)).rejects.toMatchObject({ code: 'ENOENT' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/boxActions.test.js`
Expected: 3 new test failures — the new tests fail because `buildEnsureTmuxRemote` doesn't produce zsh/oh-my-zsh output yet.

- [ ] **Step 3: Implement zsh + oh-my-zsh install in `buildEnsureTmuxRemote`**

In `src/server/boxActions.js`, add the `installOhMyZsh` block after the existing `ohMyTmux` array (after line 14) and before the return statement:

```js
const ohMyZsh = options.installOhMyZsh ? [
  'ZSH_BIN="$(command -v zsh || true)"',
  'if [ -z "$ZSH_BIN" ]; then',
  '  for p in /usr/bin/zsh /usr/local/bin/zsh /bin/zsh; do if [ -x "$p" ]; then ZSH_BIN="$p"; break; fi; done',
  'fi',
  'if [ -z "$ZSH_BIN" ]; then',
  "  SUDO=''",
  "  if [ \"$(id -u)\" != '0' ]; then SUDO='sudo -n'; fi",
  '  if command -v apt-get >/dev/null 2>&1; then',
  '    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y zsh || {',
  '      $SUDO apt-get update || true',
  '      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y zsh',
  '    }',
  '  elif command -v dnf >/dev/null 2>&1; then',
  '    $SUDO dnf install -y zsh',
  '  elif command -v yum >/dev/null 2>&1; then',
  '    $SUDO yum install -y zsh',
  '  elif command -v pacman >/dev/null 2>&1; then',
  '    $SUDO pacman -Sy --noconfirm zsh',
  '  elif command -v apk >/dev/null 2>&1; then',
  '    $SUDO apk add zsh',
  '  elif command -v zypper >/dev/null 2>&1; then',
  '    $SUDO zypper --non-interactive install zsh',
  '  else',
  "    echo 'zsh is not installed and no supported package manager was found' >&2",
  '    exit 127',
  '  fi',
  'fi',
  'if [ ! -d .oh-my-zsh ]; then',
  '  if command -v curl >/dev/null 2>&1; then',
  '    RUNZSH=no CHSH=yes sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"',
  '  elif command -v wget >/dev/null 2>&1; then',
  '    RUNZSH=no CHSH=yes sh -c "$(wget -O- https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"',
  '  else',
  "    echo 'Oh My Zsh install requires curl or wget' >&2",
  '    exit 127',
  '  fi',
  'fi',
] : [];
```

Then update the spread in the return array to include `...ohMyZsh` after `...ohMyTmux`:

```js
return [
  'set -eu',
  // ... existing tmux install lines ...
  ...ohMyTmux,
  ...ohMyZsh,
  `"$TMUX_BIN" has-session -t ${sess} 2>/dev/null || "$TMUX_BIN" new-session -d -s ${sess}${startup}`,
].join('\n');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/boxActions.test.js`
Expected: All tests pass, including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add test/boxActions.test.js src/server/boxActions.js
git commit -m "feat(provision): add zsh and oh-my-zsh install scripting

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Wire installOhMyZsh through the server endpoint (test first)

**Files:**
- Modify: `test/server.test.js`
- Modify: `src/server/server.js`

**Interfaces:**
- Consumes: `POST /api/boxes` body now includes `installOhMyZsh`; `boxActions.ensureReady(box, options)` receives `options.installOhMyZsh`
- Produces: Transient `installOhMyZsh` is passed to provisioning but stripped from persistence

- [ ] **Step 1: Write the failing test for transient option handling**

Add to `test/server.test.js` after the existing oh-my-tmux transient-option test (after line 110):

```js
test('adding a box passes transient Oh My Zsh install option without persisting it', async () => {
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
    payload: { host: 'h1', installOhMyZsh: true },
  });

  expect(created.statusCode).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0].options).toEqual({ installOhMyTmux: false, installOhMyZsh: true });
  expect(calls[0].box).not.toHaveProperty('installOhMyZsh');
  expect(created.json()).not.toHaveProperty('installOhMyZsh');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()[0]).not.toHaveProperty('installOhMyZsh');
});

test('adding a box passes both Oh My Tmux and Oh My Zsh options together', async () => {
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
    payload: { host: 'h1', installOhMyTmux: true, installOhMyZsh: true },
  });

  expect(created.statusCode).toBe(200);
  expect(calls[0].options).toEqual({ installOhMyTmux: true, installOhMyZsh: true });
  expect(created.json()).not.toHaveProperty('installOhMyTmux');
  expect(created.json()).not.toHaveProperty('installOhMyZsh');
});
```

Also update the existing oh-my-tmux transient-option test (around line 104) — change the assertion from `toEqual({ installOhMyTmux: true })` to `toEqual({ installOhMyTmux: true, installOhMyZsh: false })`:

```js
expect(calls[0].options).toEqual({ installOhMyTmux: true, installOhMyZsh: false });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.test.js`
Expected: The new tests fail — `installOhMyZsh` is not passed through.

- [ ] **Step 3: Implement server-side wiring**

In `src/server/server.js`, update the destructuring and `ensureReady` call in `POST /api/boxes` (line 186-188):

Change:
```js
const { installOhMyTmux = false, ...boxSpec } = req.body || {};
box = await store.addBox(boxSpec);
if (boxActions?.ensureReady) await boxActions.ensureReady(box, { installOhMyTmux: installOhMyTmux === true });
```

To:
```js
const { installOhMyTmux = false, installOhMyZsh = false, ...boxSpec } = req.body || {};
box = await store.addBox(boxSpec);
if (boxActions?.ensureReady) await boxActions.ensureReady(box, { installOhMyTmux: installOhMyTmux === true, installOhMyZsh: installOhMyZsh === true });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/server.test.js`
Expected: All tests pass, including the 2 new ones and the updated oh-my-tmux test.

- [ ] **Step 5: Commit**

```bash
git add test/server.test.js src/server/server.js
git commit -m "feat(api): wire installOhMyZsh transient option through add-box endpoint

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Add Oh My Zsh checkbox to the Add Box dialog

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/main.ts`

**Interfaces:**
- Consumes: `AddBoxSpec` type from `api.ts`
- Produces: Checkbox in the add dialog sends `installOhMyZsh` in the POST body

- [ ] **Step 1: Add `installOhMyZsh` to the `AddBoxSpec` type**

In `src/web/api.ts`, line 5, change:

```ts
export type AddBoxSpec = Partial<Box> & { installOhMyTmux?: boolean };
```

To:

```ts
export type AddBoxSpec = Partial<Box> & { installOhMyTmux?: boolean; installOhMyZsh?: boolean };
```

- [ ] **Step 2: Verify TypeScript build catches missing usage**

Run: `npm run build`
Expected: Build succeeds (the type addition is backward-compatible; TypeScript doesn't error on an added optional property).

- [ ] **Step 3: Add the Oh My Zsh checkbox to the add dialog**

In `src/web/main.ts`, after the oh-my-tmux checkbox block (after line 199), add a second checkbox:

```ts
  const installOhMyZsh = document.createElement('label');
  installOhMyZsh.className = 'check-field';
  const installOhMyZshInput = document.createElement('input');
  installOhMyZshInput.type = 'checkbox';
  installOhMyZshInput.checked = true;
  const installOhMyZshText = document.createElement('span');
  installOhMyZshText.textContent = 'Install Oh My Zsh if missing';
  installOhMyZsh.append(installOhMyZshInput, installOhMyZshText);
```

Then add `installOhMyZsh` to the `form.append(...)` call (after `installOhMyTmux` on line 227):

Change:
```ts
    installOhMyTmux,
```

To:
```ts
    installOhMyTmux,
    installOhMyZsh,
```

Finally, include `installOhMyZsh` in the submit handler's `spec` object (line 245):

Change:
```ts
    const spec: AddBoxSpec = { host, installOhMyTmux: installOhMyTmuxInput.checked };
```

To:
```ts
    const spec: AddBoxSpec = { host, installOhMyTmux: installOhMyTmuxInput.checked, installOhMyZsh: installOhMyZshInput.checked };
```

- [ ] **Step 4: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts src/web/main.ts
git commit -m "feat(ui): add Oh My Zsh install checkbox to add box dialog

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Run full test suite and final verification

**Files:**
- (none — verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass — unit tests (boxActions + server) and any other existing tests.

- [ ] **Step 2: Verify the production build**

Run: `npm run build`
Expected: Clean build with no errors.

- [ ] **Step 3: Final commit (if any cleanup needed)**

If all passes cleanly, no additional commit needed. Otherwise commit any fixes.
