# Unused Code Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove stale unused code paths, stale transient API plumbing, and outdated cleanup docs while preserving the live provisioning and terminal behavior.

**Architecture:** Keep the current live-provisioning model: REST box CRUD persists box data only, and provisioning options travel only through the provision WebSocket query string. Keep historical `docs/superpowers/specs/` and old dated implementation plans as point-in-time records; update only current source, active tests, and current non-history docs.

**Tech Stack:** Node 20 ESM, Fastify, Vite, TypeScript web client, Vitest, Playwright.

---

## File Structure

- `src/server/server.js` - remove REST destructuring of transient provisioning flags; remove unused `cid` query extraction.
- `src/server/boxActions.js` - remove the now-unused non-streaming `ensureReady()` action.
- `src/server/sshCommand.js` - remove the unused `size` parameter from `buildAttachArgv()`.
- `src/server/sessions.js` - update `buildAttachArgv()` call site.
- `src/server/status.js` - make `STATUS_FMT` private to the module.
- `src/web/api.ts` - remove provisioning flags from REST client types.
- `src/web/main.ts` - stop sending provisioning flags in `POST /api/boxes`; keep using them for `openProvisionPanel()`.
- `src/web/terminal.ts` - remove unused `cid`; make `ProvisionOptions` private.
- `src/web/statusDot.ts` - make `DotClass` private.
- `src/web/style.css` - remove unused `.add` selector; style the currently unstyled `radio-group` class.
- `src/web/vite-env.d.ts` - add Vite asset module declarations so `tsc --noEmit --noUnusedLocals --noUnusedParameters` can run.
- `test/server.test.js` - remove stale tests centered on old `boxActions.ensureReady` POST behavior; keep one persistence-only test.
- `test/server.ws.integration.test.js` - remove `cid` from WebSocket URLs and stale `ensureReady` test doubles.
- `test/boxActions.test.js` - remove the `ensureReady` test.
- `test/sshCommand.test.js` - update `buildAttachArgv()` calls and add an arity check to prevent reintroducing the unused size argument.
- `docs/feature-suggestions-2026-06-21.md` - add a status note that tags/grouping are now implemented.
- `docs/security-review-2025-06-21.md` - add a status note that two defense-in-depth observations have since been addressed.
- `README.md` - update provisioning wording so it matches live provisioning.

## Task 1: Enable TypeScript Unused Checks

**Files:**
- Create: `src/web/vite-env.d.ts`
- Verify: `tsconfig.json`

- [ ] **Step 1: Run the current unused TypeScript check**

Run:

```bash
./node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters
```

Expected: FAIL with:

```text
src/web/main.ts(4,21): error TS2307: Cannot find module './assets/tmuxifier-logo.png' or its corresponding type declarations.
```

- [ ] **Step 2: Add Vite client declarations**

Create `src/web/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 3: Re-run the unused TypeScript check**

Run:

```bash
./node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters
```

Expected: PASS. If it reports new unused symbols, include those in the relevant cleanup task below instead of suppressing them.

- [ ] **Step 4: Commit**

```bash
git add src/web/vite-env.d.ts
git commit -m "chore(types): add vite client declarations"
```

## Task 2: Remove Old REST Provisioning Plumbing

**Files:**
- Modify: `src/server/server.js`
- Modify: `src/web/api.ts`
- Modify: `src/web/main.ts`
- Modify: `test/server.test.js`
- Modify: `test/server.ws.integration.test.js`

- [ ] **Step 1: Add/keep one persistence-only REST test**

In `test/server.test.js`, replace the cluster of transient-option POST/PATCH tests with this single test after `POST /api/boxes returns immediately without provisioning, even if boxActions would fail`:

```js
test('POST /api/boxes persists only box fields from request bodies', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/boxes',
    headers,
    payload: {
      host: 'h1',
      label: 'Box One',
      installOhMyTmux: true,
      installOhMyZsh: true,
      installOhMyBash: true,
    },
  });

  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ host: 'h1', label: 'Box One' });
  expect(created.json()).not.toHaveProperty('installOhMyTmux');
  expect(created.json()).not.toHaveProperty('installOhMyZsh');
  expect(created.json()).not.toHaveProperty('installOhMyBash');

  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json()[0]).not.toHaveProperty('installOhMyTmux');
  expect(list.json()[0]).not.toHaveProperty('installOhMyZsh');
  expect(list.json()[0]).not.toHaveProperty('installOhMyBash');
});
```

- [ ] **Step 2: Run the focused server tests**

Run:

```bash
npm test -- test/server.test.js
```

Expected: PASS before implementation. This is a cleanup-preservation test, not a failing behavioral test.

- [ ] **Step 3: Simplify REST handlers**

In `src/server/server.js`, change the box POST/PATCH handlers to:

```js
  app.post('/api/boxes', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const box = await store.addBox(req.body || {});
      return reply.code(201).send(box);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });
  app.patch('/api/boxes/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      return await store.updateBox(req.params.id, req.body || {});
    }
    catch (e) { return reply.code(400).send({ error: e.message }); }
  });
```

- [ ] **Step 4: Simplify REST client types**

In `src/web/api.ts`, change the transient option types to plain box patches:

```ts
export type AddBoxSpec = Partial<Box>;
```

and:

```ts
  async updateBox(id: string, patch: Partial<Box>) {
    return j<Box>(await fetch(`/api/boxes/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }));
  },
```

- [ ] **Step 5: Stop sending install flags in the add-box REST request**

In `src/web/main.ts`, keep computing these booleans:

```ts
        const installOhMyZsh = shellZsh.input.checked;
        const installOhMyBash = shellBash.input.checked;
```

Then change the add-box spec creation to:

```ts
        const spec: AddBoxSpec = { host };
```

Keep the existing call to `openProvisionPanel(newBox, { ohMyTmux, ohMyZsh, ohMyBash })`; provisioning options still belong there.

- [ ] **Step 6: Remove stale POST payload flags in WebSocket integration test**

In `test/server.ws.integration.test.js`, change the POST test payload from:

```js
payload: { host: 'example.com', installOhMyTmux: true, installOhMyZsh: true },
```

to:

```js
payload: { host: 'example.com' },
```

- [ ] **Step 7: Run focused verification**

Run:

```bash
npm test -- test/server.test.js test/server.ws.integration.test.js
./node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters
```

Expected: both commands PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/server.js src/web/api.ts src/web/main.ts test/server.test.js test/server.ws.integration.test.js
git commit -m "refactor(api): remove stale provisioning flags from box CRUD"
```

## Task 3: Remove Non-Streaming `boxActions.ensureReady`

**Files:**
- Modify: `src/server/boxActions.js`
- Modify: `test/boxActions.test.js`
- Modify: `test/server.test.js`
- Modify: `test/server.ws.integration.test.js`

- [ ] **Step 1: Remove stale test doubles**

In `test/server.test.js`, remove `boxActions.ensureReady` test doubles that only assert POST no longer calls them. Keep tests for `killSession` and `exitMaster`.

In `test/server.ws.integration.test.js`, change this block:

```js
    boxActions: {
      ensureReady: async () => ({ ok: true }),
      killSession: async () => ({ ok: true }),
    },
```

to:

```js
    boxActions: {
      killSession: async () => ({ ok: true }),
    },
```

and change:

```js
boxActions: { ensureReady: async () => ({ ok: true }), killSession: async () => ({ ok: true }) },
```

to:

```js
boxActions: { killSession: async () => ({ ok: true }) },
```

- [ ] **Step 2: Remove the obsolete unit test**

Delete this test from `test/boxActions.test.js`:

```js
test('ensureReady throws useful remote output on failure', async () => {
  const actions = createBoxActions({
    run: async () => ({ code: 1, stdout: '', stderr: 'sudo password required' }),
  });

  await expect(actions.ensureReady({ host: 'h', sessionName: 'web' })).rejects.toThrow(/sudo password required/);
});
```

- [ ] **Step 3: Remove `ensureReady` implementation**

In `src/server/boxActions.js`, remove this returned method:

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

Keep `runRemote()` because `killSession()` still uses it.

- [ ] **Step 4: Confirm no live source references remain**

Run:

```bash
rg "ensureReady" src test
```

Expected: only local shell references remain:

```text
src/server/localShellActions.js:...
test/localShellActions.test.js:...
test/server.test.js:...localShellActions...
```

There should be no `boxActions.ensureReady`, `actions.ensureReady({ host`, or `ensureReady(box` references.

- [ ] **Step 5: Run focused verification**

Run:

```bash
npm test -- test/boxActions.test.js test/server.test.js test/server.ws.integration.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/boxActions.js test/boxActions.test.js test/server.test.js test/server.ws.integration.test.js
git commit -m "refactor(provision): remove obsolete non-streaming ensureReady"
```

## Task 4: Remove `cid` and `buildAttachArgv` Size Parameter

**Files:**
- Modify: `src/server/server.js`
- Modify: `src/server/sessions.js`
- Modify: `src/server/sshCommand.js`
- Modify: `src/web/terminal.ts`
- Modify: `test/server.ws.integration.test.js`
- Modify: `test/sshCommand.test.js`

- [ ] **Step 1: Add a failing arity test**

In `test/sshCommand.test.js`, add after the import:

```js
test('buildAttachArgv does not expose an unused size parameter', () => {
  expect(buildAttachArgv).toHaveLength(2);
});
```

- [ ] **Step 2: Run the focused test to verify failure**

Run:

```bash
npm test -- test/sshCommand.test.js
```

Expected: FAIL because `buildAttachArgv` currently has length `3`.

- [ ] **Step 3: Change `buildAttachArgv` signature**

In `src/server/sshCommand.js`, change:

```js
export function buildAttachArgv(box, session, size, opts = {}) {
```

to:

```js
export function buildAttachArgv(box, session, opts = {}) {
```

No body changes are needed; the old `size` parameter was unused.

- [ ] **Step 4: Update session manager call site**

In `src/server/sessions.js`, change:

```js
const argv = buildAttachArgv(box, session, size, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
```

to:

```js
const argv = buildAttachArgv(box, session, { hostKeyPolicy, sshConfigFile, controlDir, controlPersist });
```

- [ ] **Step 5: Update ssh command tests**

In `test/sshCommand.test.js`, update attach-builder calls:

```js
buildAttachArgv({ host: 'prod' }, 'web')
buildAttachArgv({ host: 'h', user: 'me', port: 2222, proxyJump: 'bastion' }, 'web', { hostKeyPolicy: 'yes' })
buildAttachArgv({ host: 'h', startupCommand: "echo 'hi'" }, 'web')
buildAttachArgv({ host: '-oProxyCommand=touch /tmp/pwn' }, 'web')
buildAttachArgv({ host: 'h', user: '-x' }, 'web')
buildAttachArgv({ host: 'h', proxyJump: '-x' }, 'web')
buildAttachArgv({ host: 'h', port: 99999 }, 'web')
buildAttachArgv({ host: 'h' }, 'web', { sshConfigFile: '/tmp/cfg' })
buildAttachArgv({ host: 'h', user: 'me', port: 22 }, 'web', { controlDir: '/run/cm' })
buildAttachArgv({ host: 'h' }, 'web')
```

- [ ] **Step 6: Remove `cid` from the web client**

In `src/web/terminal.ts`, delete:

```ts
  const cid = crypto.randomUUID();
```

and change:

```ts
ws = new WebSocket(`${proto}://${location.host}/term?box=${boxId}&cid=${cid}&cols=${cols}&rows=${rows}`);
```

to:

```ts
ws = new WebSocket(`${proto}://${location.host}/term?box=${boxId}&cols=${cols}&rows=${rows}`);
```

- [ ] **Step 7: Remove `cid` from the server**

In `src/server/server.js`, change:

```js
const { box: boxId, cid, cols, rows, mode } = req.query;
```

to:

```js
const { box: boxId, cols, rows, mode } = req.query;
```

- [ ] **Step 8: Remove `cid` from WebSocket tests**

In `test/server.ws.integration.test.js`, change URLs from:

```js
`ws://127.0.0.1:${port}/term?box=${saved.id}&cid=t1&cols=80&rows=24`
```

to:

```js
`ws://127.0.0.1:${port}/term?box=${saved.id}&cols=80&rows=24`
```

- [ ] **Step 9: Run focused verification**

Run:

```bash
npm test -- test/sshCommand.test.js test/server.ws.integration.test.js
./node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/server/server.js src/server/sessions.js src/server/sshCommand.js src/web/terminal.ts test/server.ws.integration.test.js test/sshCommand.test.js
git commit -m "refactor(term): remove unused websocket cid and attach size"
```

## Task 5: Reduce Unnecessary Exports and CSS Nits

**Files:**
- Modify: `src/server/status.js`
- Modify: `src/web/statusDot.ts`
- Modify: `src/web/terminal.ts`
- Modify: `src/web/style.css`

- [ ] **Step 1: Make `STATUS_FMT` private**

In `src/server/status.js`, change:

```js
export const STATUS_FMT = '#{session_name}:#{session_windows}:#{session_attached}:#{session_activity}';
```

to:

```js
const STATUS_FMT = '#{session_name}:#{session_windows}:#{session_attached}:#{session_activity}';
```

Keep `PROBE_REMOTE` exported because `test/status.test.js` imports it.

- [ ] **Step 2: Make web-only types private**

In `src/web/statusDot.ts`, change:

```ts
export type DotClass = 'gray' | 'green' | 'amber' | 'red' | 'auth';
```

to:

```ts
type DotClass = 'gray' | 'green' | 'amber' | 'red' | 'auth';
```

In `src/web/terminal.ts`, change:

```ts
export interface ProvisionOptions {
  ohMyTmux: boolean;
  ohMyZsh: boolean;
  ohMyBash: boolean;
}
```

to:

```ts
interface ProvisionOptions {
  ohMyTmux: boolean;
  ohMyZsh: boolean;
  ohMyBash: boolean;
}
```

- [ ] **Step 3: Clean CSS selector**

In `src/web/style.css`, change:

```css
.login input, .login button, .actions button, .add { padding: 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-2); color: inherit; }
```

to:

```css
.login input, .login button, .actions button { padding: 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-2); color: inherit; }
```

- [ ] **Step 4: Style the existing radio-group class**

Add after `.modal .check-field input ...`:

```css
.modal .radio-group { margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: 8px; }
.modal .radio-group legend { margin-bottom: 2px; font-size: 12px; color: #8b949e; }
```

- [ ] **Step 5: Run static checks**

Run:

```bash
rg "^export (const STATUS_FMT|type DotClass|interface ProvisionOptions)" src
./node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters
npm run build
```

Expected:

```text
rg: no matches
```

Then `tsc` and `npm run build` both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/status.js src/web/statusDot.ts src/web/terminal.ts src/web/style.css
git commit -m "refactor(cleanup): reduce unused exports and css selectors"
```

## Task 6: Update Current Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/feature-suggestions-2026-06-21.md`
- Modify: `docs/security-review-2025-06-21.md`

- [ ] **Step 1: Update README provisioning wording**

In `README.md`, replace the paragraph that starts with `When a box is added, Tmuxifier first checks for tmux` with:

```markdown
When a box is added, Tmuxifier persists the box immediately and opens a live provisioning
panel. That provisioning flow checks for `tmux`, installs it through a known package manager
when possible (`apt-get`, `dnf`, `yum`, `pacman`, `apk`, or `zypper`), applies any selected
shell/theme options, and creates the configured tmux session. If provisioning exits non-zero,
the new box is rolled back from the list. Removing a box closes any local terminal process for
that box and best-effort kills the configured remote tmux session before deleting the box.
```

- [ ] **Step 2: Add status note to feature suggestions**

In `docs/feature-suggestions-2026-06-21.md`, under the title and opening paragraph, add:

```markdown
> Status note, 2026-06-22: tag editing, tag search, and grouped/collapsible sidebar
> navigation from suggestion #2 have since been implemented. The remaining suggestions are
> fleet command execution and richer health details.
```

Do not rewrite the rest of the dated review; it is useful historical context.

- [ ] **Step 3: Add status note to security review**

In `docs/security-review-2025-06-21.md`, after the `Result` line, add:

```markdown
**Status note, 2026-06-22:** the resize bound and ControlMaster directory permission
defense-in-depth observations below have since been addressed in source (`sessions.js`
clamps PTY resize dimensions and `index.js` creates the control directory with `0o700`).
```

Do not rewrite the historical observations; this note makes the current state clear without changing the original review.

- [ ] **Step 4: Verify docs references**

Run:

```bash
rg "dormant|nothing in the UI|not bounded|no explicit mode|When a box is added" README.md docs/feature-suggestions-2026-06-21.md docs/security-review-2025-06-21.md
```

Expected: only historical lines remain under the new status notes; `README.md` should not contain stale provisioning wording.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/feature-suggestions-2026-06-21.md docs/security-review-2025-06-21.md
git commit -m "docs(cleanup): mark stale review notes as addressed"
```

## Task 7: Full Verification

**Files:**
- Verify the whole repository.

- [ ] **Step 1: Run unit and integration tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript and build checks**

Run:

```bash
./node_modules/.bin/tsc --noEmit --noUnusedLocals --noUnusedParameters
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run E2E if the local sshd-backed helper is available**

Run:

```bash
npm run test:e2e
```

Expected: PASS. If it fails due to missing local system prerequisites, record the failure and exact prerequisite error in the final handoff.

- [ ] **Step 4: Scan for cleanup leftovers**

Run:

```bash
rg "cid=|boxActions\\.ensureReady|actions\\.ensureReady\\(|ensureReady\\(box|buildAttachArgv\\([^\\n]*\\{ cols|installOhMyTmux\\?:|installOhMyZsh\\?:|installOhMyBash\\?:" src test
```

Expected: no matches except live provisioning option names in `src/server/server.js`, `src/web/main.ts`, `src/web/terminal.ts`, and tests that intentionally exercise provision WebSocket query parameters.

- [ ] **Step 5: Review git diff**

Run:

```bash
git diff --stat
git diff
```

Expected: diff is limited to the cleanup files above; no `.env`, `config.json`, `data/`, `tls/`, or PII.

## Task 8: Optional Ignored Local Artifact Cleanup

**Files:**
- Local ignored artifacts only; no commit.

- [ ] **Step 1: Inspect ignored artifacts**

Run:

```bash
git status --short --ignored
du -sh .superpowers output dist data test-results 2>/dev/null
```

Expected: ignored local directories are listed. Keep `.env`, `config.json`, `data/`, and `tls/` unless explicitly resetting local runtime state.

- [ ] **Step 2: Remove disposable ignored artifacts only after confirmation**

If executing as an agent, request approval before destructive cleanup. The disposable candidates from the review were:

```bash
rm -rf .superpowers output test-results audit.log
```

Do not remove `dist/` unless a fresh `npm run build` has completed and the operator does not need the current built bundle. Do not remove `.env`, `config.json`, `data/`, or `tls/`.

## Self-Review

- Spec coverage: all cleanup suggestions from the review are covered: old REST provisioning fields, non-streaming `ensureReady`, unused `cid`, unused `size`, unnecessary exports, CSS nits, TypeScript unused-check blocker, stale current docs, and optional ignored artifacts.
- Placeholder scan: no placeholder markers or unspecified implementation steps remain.
- Type consistency: `AddBoxSpec` is REST-only after Task 2; `ProvisionOptions` remains local to `terminal.ts`; live provision booleans remain `ohMyTmux`, `ohMyZsh`, and `ohMyBash` across `main.ts`, `terminal.ts`, and the WebSocket route.
