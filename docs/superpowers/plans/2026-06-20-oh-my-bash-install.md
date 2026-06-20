# Oh My Bash Install Option Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Oh My Bash" option to the Add/Edit Box dialog as part of a radio-style shell framework group (None / Oh My Zsh / Oh My Bash), provisioning Oh My Bash on the remote host, mirroring the existing oh-my-zsh pattern.

**Architecture:** Same transient-option pattern as `installOhMyZsh`. The radio group value travels as `installOhMyBash` in the `POST /api/boxes` body and the provision WebSocket query string, is extracted by `server.js`, passed to `buildEnsureTmuxRemote` (but never persisted in `boxes.json`), and triggers Oh My Bash install commands in the remote provisioning script. The existing OMZ checkbox is replaced by a radio group (None/OMZ/OMB) — mutual exclusivity is enforced client-side by the radio element. Oh My Tmux stays as its own independent checkbox.

**Tech Stack:** ESM JavaScript (server), TypeScript (web client), Vitest (tests), bash (remote provisioning script)

## Global Constraints

- Follow the oh-my-zsh pattern exactly — same files, same flow, same error handling
- Transient options must not be persisted in `boxes.json`
- All new code paths must have tests written first (TDD)
- Shell framework radio group defaults to "None" (no pre-selected shell)
- Oh My Tmux remains an independent checkbox, unchanged
- CLI: `npm test` for unit/integration, `npm run build` for TypeScript
- No chsh step for OMB (bash is the default shell)
- No package-manager install step for bash (it is ubiquitous)

---

### Task 1: Add Oh My Bash install steps to `buildEnsureTmuxRemote` (test first)

**Files:**
- Modify: `test/boxActions.test.js`
- Modify: `src/server/boxActions.js`

**Interfaces:**
- Consumes: `buildEnsureTmuxRemote(session, startupCommand, options)` — existing function; `options.installOhMyBash` is the new boolean field
- Produces: Remote script includes Oh My Bash upstream install steps when `options.installOhMyBash` is true, followed by tmux `default-shell` + `respawn-window` for bash

- [ ] **Step 1: Write the failing tests for OMB install steps**

Add to `test/boxActions.test.js` after the existing OMZ tests (after line 96):

```js
test('buildEnsureTmuxRemote includes Oh My Bash install steps when requested', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { installOhMyBash: true });

  // Detects bash binary
  expect(remote).toContain('command -v bash');

  // Fetches upstream Oh My Bash install script
  expect(remote).toContain('https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh');
  expect(remote).toContain('OMB="$(curl');
  expect(remote).toContain('</dev/null');

  // Runs chsh to set default shell to bash (mirrors OMZ pattern)
  expect(remote).toContain('chsh -s "$BASH_BIN"');

  // Sets tmux default-shell to bash and respawns
  expect(remote).toContain('default-shell');
  expect(remote).toContain('BASH_BIN');
});

test('buildEnsureTmuxRemote omits Oh My Bash steps when not requested', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, {});
  expect(remote).not.toContain('command -v bash');
  expect(remote).not.toContain('https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh');
  // BASH_BIN appears in the unconditional default-shell line (same pattern as ZSH_BIN), so we don't assert its absence
});

test('buildEnsureTmuxRemote skips Oh My Bash clone when .oh-my-bash exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-oh-my-bash-'));
  await fs.mkdir(path.join(dir, '.oh-my-bash'));
  await fs.writeFile(path.join(dir, 'bash'), '#!/bin/sh\necho "$*" >> "$TMUXIFIER_BASH_LOG"\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'curl'), '#!/bin/sh\necho curled >> "$TMUXIFIER_CURL_LOG"\nexit 0\n', { mode: 0o755 });
  const curlLog = path.join(dir, 'curl.log');

  const res = await runShell(`cd ${JSON.stringify(dir)}
${buildEnsureTmuxRemote('web', undefined, { installOhMyBash: true })}`, {
    PATH: dir,
    TMUXIFIER_CURL_LOG: curlLog,
  });

  expect(res.code).toBe(0);
  await expect(fs.stat(curlLog)).rejects.toMatchObject({ code: 'ENOENT' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/boxActions.test.js`
Expected: 3 new test failures — the new tests fail because `buildEnsureTmuxRemote` doesn't produce bash/oh-my-bash output yet.

- [ ] **Step 3: Implement OMB install steps in `buildEnsureTmuxRemote`**

In `src/server/boxActions.js`, add the `ohMyBash` block after the `ohMyZsh` array (after line 61) and before the `return` statement:

```js
const ohMyBash = options.installOhMyBash ? [
  'BASH_BIN="$(command -v bash || true)"',
  'if [ ! -d .oh-my-bash ]; then',
  '  if command -v curl >/dev/null 2>&1; then',
  '    OMB="$(curl -fsSL https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh)" || { echo "Failed to download Oh My Bash" >&2; exit 1; }',
  '    sh -c "$OMB" </dev/null',
  '  elif command -v wget >/dev/null 2>&1; then',
  '    OMB="$(wget -O- https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh)" || { echo "Failed to download Oh My Bash" >&2; exit 1; }',
  '    sh -c "$OMB" </dev/null',
  '  else',
  "    echo 'Oh My Bash install requires curl or wget' >&2",
  '    exit 127',
  '  fi',
  'fi',
  'BASH_BIN="$(command -v bash || true)"',
  'if [ -n "$BASH_BIN" ]; then',
  "  if [ \"$(id -u)\" = '0' ]; then",
  '    chsh -s "$BASH_BIN" root || true',
  '  else',
  '    sudo -n chsh -s "$BASH_BIN" "$(whoami)" 2>/dev/null || chsh -s "$BASH_BIN" "$(whoami)" || true',
  '  fi',
  'fi',
] : [];
```

Then update the return array to include `...ohMyBash` and a `default-shell`/`respawn-window` line for bash. In `src/server/boxActions.js`, the current return array is:

```js
return [
  'set -eu',
  // ... git ensure, tmux install, tmux detection ...
  ...ohMyTmux,
  ...ohMyZsh,
  `"$TMUX_BIN" has-session -t ${sess} 2>/dev/null || "$TMUX_BIN" new-session -d -s ${sess}${startup}`,
  `[ -n "\${ZSH_BIN-}" ] && { "$TMUX_BIN" set-option -g default-shell "$ZSH_BIN" 2>/dev/null || true; W=\$("$TMUX_BIN" list-windows -t ${sess} -F '#{window_index}' 2>/dev/null | head -1); [ -n "\$W" ] && "$TMUX_BIN" respawn-window -t ${sess}:\$W -k "$ZSH_BIN" 2>/dev/null || true; } || true`,
].join('\n');
```

Change to:

```js
return [
  'set -eu',
  // ... git ensure, tmux install, tmux detection ...
  ...ohMyTmux,
  ...ohMyZsh,
  ...ohMyBash,
  `"$TMUX_BIN" has-session -t ${sess} 2>/dev/null || "$TMUX_BIN" new-session -d -s ${sess}${startup}`,
  `[ -n "\${ZSH_BIN-}" ] && { "$TMUX_BIN" set-option -g default-shell "$ZSH_BIN" 2>/dev/null || true; W=\$("$TMUX_BIN" list-windows -t ${sess} -F '#{window_index}' 2>/dev/null | head -1); [ -n "\$W" ] && "$TMUX_BIN" respawn-window -t ${sess}:\$W -k "$ZSH_BIN" 2>/dev/null || true; } || true`,
  `[ -n "\${BASH_BIN-}" ] && { "$TMUX_BIN" set-option -g default-shell "$BASH_BIN" 2>/dev/null || true; W=\$("$TMUX_BIN" list-windows -t ${sess} -F '#{window_index}' 2>/dev/null | head -1); [ -n "\$W" ] && "$TMUX_BIN" respawn-window -t ${sess}:\$W -k "$BASH_BIN" 2>/dev/null || true; } || true`,
].join('\n');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/boxActions.test.js`
Expected: All tests pass, including the 3 new OMB ones. Existing OMZ and OMT tests also pass.

- [ ] **Step 5: Commit**

```bash
git add test/boxActions.test.js src/server/boxActions.js
git commit -m "feat(provision): add oh-my-bash install scripting

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Wire `installOhMyBash` through the server (test first)

**Files:**
- Modify: `test/server.test.js`
- Modify: `src/server/server.js`

**Interfaces:**
- Consumes: `POST /api/boxes` body now includes `installOhMyBash`; `PATCH /api/boxes/:id` body may include `installOhMyBash`; WS provision query includes `ohMyBash`
- Produces: Transient `installOhMyBash` is stripped from persistence in POST and PATCH; `ohMyBash` is passed from WS query to `buildEnsureTmuxRemote`

- [ ] **Step 1: Write failing tests for transient OMB option handling**

Add to `test/server.test.js` after the existing OMZ transient-option tests (after line 155):

```js
test('POST /api/boxes does not persist installOhMyBash on the stored box', async () => {
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
    payload: { host: 'h1', installOhMyBash: true },
  });

  expect(created.statusCode).toBe(201);
  // ensureReady is no longer called from POST
  expect(calls).toHaveLength(0);
  expect(created.json()).not.toHaveProperty('installOhMyBash');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()[0]).not.toHaveProperty('installOhMyBash');
});

test('POST /api/boxes strips all three transient options from stored box', async () => {
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
    payload: { host: 'h1', installOhMyTmux: true, installOhMyZsh: true, installOhMyBash: true },
  });

  expect(created.statusCode).toBe(201);
  expect(calls).toHaveLength(0);
  expect(created.json()).not.toHaveProperty('installOhMyTmux');
  expect(created.json()).not.toHaveProperty('installOhMyZsh');
  expect(created.json()).not.toHaveProperty('installOhMyBash');
});

test('PATCH /api/boxes/:id does not persist installOhMyBash on the stored box', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: { host: 'h1' },
  });
  const box = created.json();

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/boxes/${box.id}`,
    headers,
    payload: { label: 'updated', installOhMyBash: true },
  });

  expect(patched.statusCode).toBe(200);
  expect(patched.json()).not.toHaveProperty('installOhMyBash');
  expect(patched.json().label).toBe('updated');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()[0]).not.toHaveProperty('installOhMyBash');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.test.js`
Expected: The new tests fail — `installOhMyBash` is not stripped and leaks into persistence.

- [ ] **Step 3: Implement server-side wiring**

In `src/server/server.js`, update the POST handler (line 186) to also destructure `installOhMyBash`:

Change:
```js
const { installOhMyTmux = false, installOhMyZsh = false, ...boxSpec } = req.body || {};
```

To:
```js
const { installOhMyTmux = false, installOhMyZsh = false, installOhMyBash = false, ...boxSpec } = req.body || {};
```

In the PATCH handler (line 193-196), add destructuring to strip transient options:

Change:
```js
app.patch('/api/boxes/:id', { preHandler: requireAuth }, async (req, reply) => {
    try { return await store.updateBox(req.params.id, req.body || {}); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
```

To:
```js
app.patch('/api/boxes/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const { installOhMyTmux, installOhMyZsh, installOhMyBash, ...patch } = req.body || {};
      return await store.updateBox(req.params.id, patch);
    }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
```

In the WebSocket provision handler (line 238), update the query destructuring and `buildEnsureTmuxRemote` call:

Change:
```js
const { ohMyTmux, ohMyZsh } = req.query;
const script = buildEnsureTmuxRemote(box.sessionName, box.startupCommand, {
  installOhMyTmux: ohMyTmux === '1',
  installOhMyZsh: ohMyZsh === '1',
});
```

To:
```js
const { ohMyTmux, ohMyZsh, ohMyBash } = req.query;
const script = buildEnsureTmuxRemote(box.sessionName, box.startupCommand, {
  installOhMyTmux: ohMyTmux === '1',
  installOhMyZsh: ohMyZsh === '1',
  installOhMyBash: ohMyBash === '1',
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/server.test.js`
Expected: All tests pass, including the 3 new OMB ones.

- [ ] **Step 5: Commit**

```bash
git add test/server.test.js src/server/server.js
git commit -m "feat(api): wire installOhMyBash transient option through endpoints

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Update TypeScript types for OMB

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/terminal.ts`

**Interfaces:**
- Consumes: (none — type definitions are leaf nodes)
- Produces: `AddBoxSpec` includes `installOhMyBash?: boolean`; `updateBox` accepts `installOhMyBash`; `ProvisionOptions` includes `ohMyBash: boolean`

- [ ] **Step 1: Add `installOhMyBash` to `AddBoxSpec`**

In `src/web/api.ts`, line 5, change:

```ts
export type AddBoxSpec = Partial<Box> & { installOhMyTmux?: boolean; installOhMyZsh?: boolean };
```

To:

```ts
export type AddBoxSpec = Partial<Box> & { installOhMyTmux?: boolean; installOhMyZsh?: boolean; installOhMyBash?: boolean };
```

Also update the `updateBox` signature on line 20:

Change:
```ts
async updateBox(id: string, patch: Partial<Box> & { installOhMyTmux?: boolean; installOhMyZsh?: boolean }) {
```

To:
```ts
async updateBox(id: string, patch: Partial<Box> & { installOhMyTmux?: boolean; installOhMyZsh?: boolean; installOhMyBash?: boolean }) {
```

- [ ] **Step 2: Add `ohMyBash` to `ProvisionOptions`**

In `src/web/terminal.ts`, line 5-8, change:

```ts
export interface ProvisionOptions {
  ohMyTmux: boolean;
  ohMyZsh: boolean;
}
```

To:

```ts
export interface ProvisionOptions {
  ohMyTmux: boolean;
  ohMyZsh: boolean;
  ohMyBash: boolean;
}
```

Update the query string in `openProvisionTerminal` (line 68-75) to include `ohMyBash`. Change:

```ts
const qs = [
  `box=${encodeURIComponent(boxId)}`,
  `mode=provision`,
  `cols=${term.cols}`,
  `rows=${term.rows}`,
  `ohMyTmux=${options.ohMyTmux ? '1' : '0'}`,
  `ohMyZsh=${options.ohMyZsh ? '1' : '0'}`,
].join('&');
```

To:

```ts
const qs = [
  `box=${encodeURIComponent(boxId)}`,
  `mode=provision`,
  `cols=${term.cols}`,
  `rows=${term.rows}`,
  `ohMyTmux=${options.ohMyTmux ? '1' : '0'}`,
  `ohMyZsh=${options.ohMyZsh ? '1' : '0'}`,
  `ohMyBash=${options.ohMyBash ? '1' : '0'}`,
].join('&');
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no TypeScript errors (main.ts references to `ohMyZsh` on `ProvisionOptions` will still compile since `ohMyBash` is an additive field).

- [ ] **Step 4: Commit**

```bash
git add src/web/api.ts src/web/terminal.ts
git commit -m "feat(types): add installOhMyBash to AddBoxSpec, updateBox, and ProvisionOptions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Replace OMZ checkbox with shell radio group in UI

**Files:**
- Modify: `src/web/main.ts`

**Interfaces:**
- Consumes: `AddBoxSpec` and `ProvisionOptions` types from `api.ts` / `terminal.ts` (now with `installOhMyBash` / `ohMyBash`)
- Produces: Radio group (None/OMZ/OMB) in add/edit dialog; submit handlers send the correct transient option; `openProvisionPanel` receives `ohMyBash`

- [ ] **Step 1: Replace OMZ checkbox with radio group in `openBoxDialog`**

In `src/web/main.ts`, replace the OMZ checkbox block (lines 272-279) with a shell framework radio group. Remove:

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

Add in its place a shell framework fieldset with radio buttons:

```ts
  // Shell framework radio group
  const shellGroup = document.createElement('fieldset');
  shellGroup.className = 'radio-group';
  const shellLegend = document.createElement('legend');
  shellLegend.textContent = 'Shell framework';
  shellGroup.append(shellLegend);

  function makeRadio(name: string, value: string, label: string, defaultChecked: boolean) {
    const wrap = document.createElement('label');
    wrap.className = 'check-field';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = defaultChecked;
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(input, span);
    return { wrap, input };
  }

  const shellNone = makeRadio('shellFramework', 'none', 'None', true);
  const shellZsh = makeRadio('shellFramework', 'omz', 'Install Oh My Zsh if missing', false);
  const shellBash = makeRadio('shellFramework', 'omb', 'Install Oh My Bash if missing', false);

  shellGroup.append(shellNone.wrap, shellZsh.wrap, shellBash.wrap);
```

Then update the `form.append(...)` call (line 308-318). Replace:
```ts
  form.append(
    title,
    hostWrap,
    field('label', 'Label (optional)', { placeholder: 'defaults to host' }),
    field('user', 'User', { value: 'root' }),
    field('port', 'Port (optional)', { placeholder: '22', type: 'number' }),
    field('proxyJump', 'ProxyJump (optional)', { placeholder: 'jump host this server can reach' }),
    installOhMyTmux,
    installOhMyZsh,
    err,
    actions,
  );
```

With:
```ts
  form.append(
    title,
    hostWrap,
    field('label', 'Label (optional)', { placeholder: 'defaults to host' }),
    field('user', 'User', { value: 'root' }),
    field('port', 'Port (optional)', { placeholder: '22', type: 'number' }),
    field('proxyJump', 'ProxyJump (optional)', { placeholder: 'jump host this server can reach' }),
    installOhMyTmux,
    shellGroup,
    err,
    actions,
  );
```

- [ ] **Step 2: Update the edit-mode defaults section**

In the edit-mode defaults section (lines 330-333), remove the OMZ checkbox reset and add radio defaults:

Remove:
```ts
  // Default checkboxes to unchecked in edit mode
  if (isEdit) {
    installOhMyTmuxInput.checked = false;
    installOhMyZshInput.checked = false;
  }
```

Replace with:
```ts
  // Default checkboxes/radios to unchecked/None in edit mode
  if (isEdit) {
    installOhMyTmuxInput.checked = false;
    shellNone.input.checked = true;
  }
```

- [ ] **Step 3: Update the submit handler for add mode**

In the add-mode submit handler (lines 371-389), update the `spec` construction and `openProvisionPanel` call.

Replace:
```ts
        const spec: AddBoxSpec = { host, installOhMyTmux: installOhMyTmuxInput.checked, installOhMyZsh: installOhMyZshInput.checked };
        const label = fields.label.value.trim(); if (label) spec.label = label;
        const user = fields.user.value.trim(); if (user) spec.user = user;
        const jump = fields.proxyJump.value.trim(); if (jump) spec.proxyJump = jump;
        const portRaw = fields.port.value.trim();
        if (portRaw) {
          const port = Number(portRaw);
          if (!Number.isInteger(port) || port < 1 || port > 65535) { err.textContent = 'Port must be 1–65535'; submit.disabled = false; return; }
          spec.port = port;
        }
        const newBox = await api.addBox(spec);
        close();
        openProvisionPanel(newBox, {
          ohMyTmux: installOhMyTmuxInput.checked,
          ohMyZsh: installOhMyZshInput.checked,
        });
```

With:
```ts
        const installOhMyZsh = shellZsh.input.checked;
        const installOhMyBash = shellBash.input.checked;
        const spec: AddBoxSpec = { host, installOhMyTmux: installOhMyTmuxInput.checked, installOhMyZsh, installOhMyBash };
        const label = fields.label.value.trim(); if (label) spec.label = label;
        const user = fields.user.value.trim(); if (user) spec.user = user;
        const jump = fields.proxyJump.value.trim(); if (jump) spec.proxyJump = jump;
        const portRaw = fields.port.value.trim();
        if (portRaw) {
          const port = Number(portRaw);
          if (!Number.isInteger(port) || port < 1 || port > 65535) { err.textContent = 'Port must be 1–65535'; submit.disabled = false; return; }
          spec.port = port;
        }
        const newBox = await api.addBox(spec);
        close();
        openProvisionPanel(newBox, {
          ohMyTmux: installOhMyTmuxInput.checked,
          ohMyZsh: installOhMyZsh,
          ohMyBash: installOhMyBash,
        });
```

- [ ] **Step 4: Update the submit handler for edit mode**

In the edit-mode submit handler (lines 349-369), update the `openProvisionPanel` call and condition.

Replace:
```ts
        const updatedBox = await api.updateBox(box!.id, patch);
        close();
        await refresh();
        if (installOhMyTmuxInput.checked || installOhMyZshInput.checked) {
          openProvisionPanel(updatedBox, {
            ohMyTmux: installOhMyTmuxInput.checked,
            ohMyZsh: installOhMyZshInput.checked,
          });
        }
```

With:
```ts
        const updatedBox = await api.updateBox(box!.id, patch);
        close();
        await refresh();
        const installOhMyZsh = shellZsh.input.checked;
        const installOhMyBash = shellBash.input.checked;
        if (installOhMyTmuxInput.checked || installOhMyZsh || installOhMyBash) {
          openProvisionPanel(updatedBox, {
            ohMyTmux: installOhMyTmuxInput.checked,
            ohMyZsh: installOhMyZsh,
            ohMyBash: installOhMyBash,
          });
        }
```

- [ ] **Step 5: Update `openProvisionPanel` signature**

The `openProvisionPanel` function (line 208) currently takes `{ ohMyTmux: boolean; ohMyZsh: boolean }`. Update it to include `ohMyBash`:

Change:
```ts
function openProvisionPanel(box: Box, options: { ohMyTmux: boolean; ohMyZsh: boolean }) {
```

To:
```ts
function openProvisionPanel(box: Box, options: { ohMyTmux: boolean; ohMyZsh: boolean; ohMyBash: boolean }) {
```

- [ ] **Step 6: Verify build passes**

Run: `npm run build`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/web/main.ts
git commit -m "feat(ui): replace OMZ checkbox with shell framework radio group (None/OMZ/OMB)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Update WebSocket integration tests

**Files:**
- Modify: `test/server.ws.integration.test.js`

**Interfaces:**
- Consumes: WS provision query params now include `ohMyBash`
- Produces: Existing provision tests pass with updated query strings

- [ ] **Step 1: Update existing provision WS test query strings**

The existing WS integration tests hardcode `ohMyTmux=0&ohMyZsh=0` in their provision WebSocket URLs. Update these to include `ohMyBash=0`.

In `test/server.ws.integration.test.js`:

Line 146 — provision success test:
Change:
```
`ws://127.0.0.1:${port}/term?box=${saved.id}&mode=provision&cols=120&rows=40&ohMyTmux=0&ohMyZsh=0`,
```
To:
```
`ws://127.0.0.1:${port}/term?box=${saved.id}&mode=provision&cols=120&rows=40&ohMyTmux=0&ohMyZsh=0&ohMyBash=0`,
```

Line 225 — provision rollback test:
Change:
```
`ws://127.0.0.1:${port}/term?box=${saved.id}&mode=provision&cols=80&rows=24&ohMyTmux=0&ohMyZsh=0`,
```
To:
```
`ws://127.0.0.1:${port}/term?box=${saved.id}&mode=provision&cols=80&rows=24&ohMyTmux=0&ohMyZsh=0&ohMyBash=0`,
```

- [ ] **Step 2: Run integration tests to verify they pass**

Run: `npx vitest run test/server.ws.integration.test.js`
Expected: All WS integration tests pass with the updated query strings.

- [ ] **Step 3: Commit**

```bash
git add test/server.ws.integration.test.js
git commit -m "test(ws): add ohMyBash query param to provision WS integration tests

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Full test suite and build verification

**Files:**
- (none — verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass — unit tests (boxActions + server) and WS integration tests.

- [ ] **Step 2: Verify the production build**

Run: `npm run build`
Expected: Clean build with no TypeScript errors.

- [ ] **Step 3: Final commit (if any cleanup needed)**

If all passes cleanly, no additional commit needed. Otherwise commit any fixes.
