# Selectable tmux Session Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the existing box `sessionName` field in the Add/Edit dialog as a type-or-pick input — defaulting to `web`, pre-filled for free from cached status, with a ⟳ button that does an on-demand live `tmux ls` probe.

**Architecture:** The store, attach, and provision paths already honor `box.sessionName`; this is a UI surfacing change plus one new read-only probe endpoint. The probe (`status.listSessions`) reuses the existing `probe()` body, the shared ControlMaster socket, and an in-flight de-dup map, and is skipped entirely when a live interactive session owns the socket. The dialog pre-fills its dropdown from the already-cached `/api/status` snapshot, so opening it costs zero new SSH.

**Tech Stack:** Node 20+ ESM server (Fastify), TypeScript + xterm.js web client (Vite), Vitest.

## Global Constraints

- ESM everywhere (`"type": "module"`); server is plain `.js`, web client is `.ts`.
- TDD with **real code, not mocks** — inject dependencies (e.g. a stubbed `run`); never mock modules.
- All ssh-facing box fields pass through `assertBoxSafe` before reaching `ssh`; never shell-interpolate box fields unquoted.
- Rate-ban safety: add **no** automatic SSH. The live probe fires only on explicit ⟳ click, reuses the shared ControlMaster, is in-flight de-duped, and is skipped during a live session.
- Conventional-commit messages (`feat(…)`, `test(…)`).
- Public repo: use only placeholder host/user values (`h`, `example.com`, RFC1918 IPs) in code, tests, and docs.
- Commit message trailer (every commit): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: `status.listSessions` — live tmux-session probe

**Files:**
- Modify: `src/server/status.js` (add `sessInflight` map ~line 35; add `listSessions` method in the returned object ~line 119)
- Test: `test/status.test.js` (append new tests)

**Interfaces:**
- Consumes: existing `probe(box)` (returns `{ reachable, tmux, sessions }` / `{ reachable:false, needsAuth, error }` / `{ reachable:false, error }`), `keyFor(box)`, and the injected `hasLiveSession(box)`.
- Produces: `listSessions(box) => Promise<{ reachable, tmux?, sessions?, needsAuth?, inUse?, error? }>`. When `hasLiveSession(box)` is truthy it resolves to `{ reachable: true, tmux: true, inUse: true, sessions: [] }` **without calling `run`**. Otherwise it resolves to exactly what `probe(box)` returns.

- [ ] **Step 1: Write the failing tests**

Append to `test/status.test.js`:

```js
test('listSessions: returns parsed sessions when tmux is running', async () => {
  const run = async () => ({ code: 0, stdout: 'web:3:1:1718000000\nmain:1:0:1718000100\n', stderr: '' });
  const result = await createStatusChecker({ run }).listSessions({ host: 'h' });
  expect(result).toEqual({
    reachable: true,
    tmux: true,
    sessions: [
      { name: 'web', windows: 3, attached: true, activity: 1718000000 },
      { name: 'main', windows: 1, attached: false, activity: 1718000100 },
    ],
  });
});

test('listSessions: tmux not running yields an empty list', async () => {
  const run = async () => ({ code: 0, stdout: '__NO_TMUX__\n', stderr: '' });
  const result = await createStatusChecker({ run }).listSessions({ host: 'h' });
  expect(result).toEqual({ reachable: true, tmux: false, sessions: [] });
});

test('listSessions: unreachable surfaces the error', async () => {
  const run = async () => ({ code: 255, stdout: '', stderr: 'timeout' });
  const result = await createStatusChecker({ run }).listSessions({ host: 'h' });
  expect(result).toEqual({ reachable: false, error: 'timeout' });
});

test('listSessions: auth failure reports needsAuth', async () => {
  const run = async () => ({ code: 255, stdout: '', stderr: 'me@h: Permission denied (publickey,password).' });
  const result = await createStatusChecker({ run }).listSessions({ host: 'h' });
  expect(result.reachable).toBe(false);
  expect(result.needsAuth).toBe(true);
});

test('listSessions: skips the probe when a live session owns the socket', async () => {
  let called = false;
  const run = async () => { called = true; return { code: 0, stdout: '', stderr: '' }; };
  const result = await createStatusChecker({ run, hasLiveSession: () => true })
    .listSessions({ id: 'b1', host: 'h' });
  expect(result).toEqual({ reachable: true, tmux: true, inUse: true, sessions: [] });
  expect(called).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/status.test.js`
Expected: FAIL — `createStatusChecker(...).listSessions is not a function`.

- [ ] **Step 3: Add the in-flight map**

In `src/server/status.js`, find the existing line (~35):

```js
  const inflight = new Map(); // key -> Promise<status> for a probe already running
```

Add directly below it:

```js
  const sessInflight = new Map(); // key -> Promise for an in-flight listSessions() fetch
```

- [ ] **Step 4: Add the `listSessions` method**

In `src/server/status.js`, the returned object currently ends:

```js
    resetBackoff(box) {
      backoff.delete(typeof box === 'string' ? box : keyFor(box));
    },
  };
```

Insert the new method before `resetBackoff`:

```js
    // On-demand fetch of a box's live tmux sessions for the Add/Edit dialog. User
    // triggered (the ⟳ button), so it ignores the poll backoff — but it still rides
    // the shared ControlMaster and coalesces concurrent fetches, and it is skipped
    // entirely when a live interactive session owns the socket (a BatchMode probe
    // would collide with that login). The dialog keeps its cached pre-fill instead.
    async listSessions(box) {
      if (hasLiveSession && hasLiveSession(box)) {
        return { reachable: true, tmux: true, inUse: true, sessions: [] };
      }
      const key = keyFor(box);
      let pending = sessInflight.get(key);
      if (!pending) {
        pending = probe(box).finally(() => sessInflight.delete(key));
        sessInflight.set(key, pending);
      }
      return pending;
    },
    resetBackoff(box) {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/status.test.js`
Expected: PASS (all listSessions tests plus the pre-existing ones).

- [ ] **Step 6: Commit**

```bash
git add src/server/status.js test/status.test.js
git commit -m "feat(status): add listSessions probe for the session-name dropdown

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `POST /api/boxes/probe-sessions` route (+ sessionName persistence guard)

**Files:**
- Modify: `src/server/server.js` (add `assertBoxSafe` import ~line 8; add route after the `DELETE /api/boxes/:id` handler ~line 214)
- Test: `test/server.test.js` (update the default `statusChecker` stub in `makeApp`; append route tests)

**Interfaces:**
- Consumes: `statusChecker.listSessions(spec)` from Task 1; `requireAuth` preHandler; `assertBoxSafe` from `./sshCommand.js`.
- Produces: `POST /api/boxes/probe-sessions` — body `{ id?, host, user?, port?, proxyJump? }`. Returns `statusChecker.listSessions(spec)` as JSON (200). Unsafe/missing connection fields → `400 { error }`. No auth cookie → `401`.

- [ ] **Step 1: Make the default test stub expose `listSessions`**

In `test/server.test.js`, find the `makeApp` stub (~line 24):

```js
  const statusChecker = { checkBox: async () => ({ reachable: true, tmux: true, sessions: [] }) };
```

Replace it with:

```js
  const statusChecker = {
    checkBox: async () => ({ reachable: true, tmux: true, sessions: [] }),
    listSessions: async () => ({ reachable: true, tmux: true, sessions: [{ name: 'web', windows: 1 }] }),
  };
```

- [ ] **Step 2: Write the failing tests**

Append to `test/server.test.js`:

```js
test('probe-sessions requires auth', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/boxes/probe-sessions', payload: { host: 'h' } });
  expect(res.statusCode).toBe(401);
});

test('probe-sessions returns the live session list for an authed request', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/boxes/probe-sessions', headers, payload: { host: 'h' } });
  expect(res.statusCode).toBe(200);
  expect(res.json().sessions).toEqual([{ name: 'web', windows: 1 }]);
});

test('probe-sessions rejects an unsafe host with 400', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const res = await app.inject({ method: 'POST', url: '/api/boxes/probe-sessions', headers, payload: { host: '-bad' } });
  expect(res.statusCode).toBe(400);
});

test('editing sessionName persists through PATCH', async () => {
  const cookie = await login();
  const headers = { cookie: `${cookie.name}=${cookie.value}` };
  const created = await app.inject({ method: 'POST', url: '/api/boxes', headers, payload: { host: 'h2' } });
  const box = created.json();
  expect(box.sessionName).toBe('web');
  const patched = await app.inject({ method: 'PATCH', url: `/api/boxes/${box.id}`, headers, payload: { sessionName: 'mine' } });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().sessionName).toBe('mine');
  const list = await app.inject({ method: 'GET', url: '/api/boxes', headers });
  expect(list.json().find((b) => b.id === box.id).sessionName).toBe('mine');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/server.test.js`
Expected: the three `probe-sessions` tests FAIL (route returns 404, not 401/200/400). The `sessionName persists` test PASSES already — it guards existing store behavior the feature now depends on; leave it.

- [ ] **Step 4: Import `assertBoxSafe` in the server**

In `src/server/server.js`, find (~line 8):

```js
import { buildEnsureTmuxRemote } from './boxActions.js';
```

Add directly below it:

```js
import { assertBoxSafe } from './sshCommand.js';
```

- [ ] **Step 5: Add the route**

In `src/server/server.js`, find the end of the `DELETE /api/boxes/:id` handler (~line 214):

```js
    await store.removeBox(req.params.id); return { ok: true };
  });
```

Insert the new route directly after it:

```js
  // Read-only: list a box's live tmux sessions to populate the Add/Edit session
  // dropdown. Accepts an unsaved spec (add mode) or a saved box's fields + id
  // (edit mode — id lets listSessions apply the live-session guard). assertBoxSafe
  // rejects unsafe connection fields up front; the probe itself is BatchMode +
  // ConnectTimeout bounded and rides the shared ControlMaster.
  app.post('/api/boxes/probe-sessions', { preHandler: requireAuth }, async (req, reply) => {
    const { id, host, user, port, proxyJump } = req.body || {};
    const spec = { id, host, user, port, proxyJump };
    try {
      assertBoxSafe(spec);
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
    return statusChecker.listSessions(spec);
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/server.test.js`
Expected: PASS (all four new tests plus the pre-existing suite).

- [ ] **Step 7: Commit**

```bash
git add src/server/server.js test/server.test.js
git commit -m "feat(api): add POST /api/boxes/probe-sessions for live session listing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Web client — session field, ⟳ fetch, submit, styling

**Files:**
- Modify: `src/web/api.ts` (add `inUse?` to `Status`; add `probeSessions` method)
- Modify: `src/web/main.ts` (build the session field in `openBoxDialog`; include `sessionName` on submit)
- Modify: `src/web/style.css` (add `.session-row`, `.session-refresh`, `.session-hint`)

**Interfaces:**
- Consumes: `api.probeSessions(spec)`, the module-level `latestStatus` map, and the `fields` record (`fields.host`, `fields.user`, `fields.port`, `fields.proxyJump`) inside `openBoxDialog`.
- Produces: an `AddBoxSpec` / patch object that always carries `sessionName: string` (`input.value.trim() || 'web'`).

- [ ] **Step 1: Extend the `Status` type and add the API method**

In `src/web/api.ts`, replace the `Status` interface (line 6):

```ts
export interface Status { reachable: boolean; tmux?: boolean; needsAuth?: boolean; paused?: boolean; nextProbeAt?: number; sessions?: { name: string; windows: number }[]; error?: string; }
```

with:

```ts
export interface Status { reachable: boolean; tmux?: boolean; needsAuth?: boolean; inUse?: boolean; paused?: boolean; nextProbeAt?: number; sessions?: { name: string; windows: number }[]; error?: string; }
```

Then add a method to the `api` object (after `reconnectBox`, ~line 23):

```ts
  async probeSessions(spec: { id?: string; host: string; user?: string; port?: number; proxyJump?: string }) {
    return j<Status>(await fetch('/api/boxes/probe-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) }));
  },
```

- [ ] **Step 2: Build the session field in `openBoxDialog`**

In `src/web/main.ts`, find the end of the `installOhMyTmux` block — the line just before the `// Shell framework radio group` comment (~line 596):

```js
  installOhMyTmux.append(installOhMyTmuxInput, installOhMyTmuxText);
```

Insert the following directly after it:

```js
  // tmux session: a type-or-pick field. The datalist pre-fills from the status
  // snapshot we already cache (0 new SSH); the ⟳ button does a user-triggered
  // live probe. Empty submits as 'web' (the store default).
  const sessionListId = `session-options-${Math.random().toString(36).slice(2)}`;
  const sessionDatalist = document.createElement('datalist');
  sessionDatalist.id = sessionListId;
  function setSessionOptions(names: string[]) {
    const unique = Array.from(new Set(['web', ...names]));
    sessionDatalist.replaceChildren(...unique.map((n) => {
      const o = document.createElement('option');
      o.value = n;
      if (n === 'web') o.label = 'web (default)';
      return o;
    }));
  }
  const sessionWrap = document.createElement('label');
  sessionWrap.className = 'field';
  const sessionSpan = document.createElement('span');
  sessionSpan.textContent = 'tmux session';
  const sessionRow = document.createElement('div');
  sessionRow.className = 'session-row';
  const sessionInput = document.createElement('input');
  sessionInput.type = 'text';
  sessionInput.placeholder = 'web';
  sessionInput.setAttribute('list', sessionListId);
  if (isEdit && box!.sessionName) sessionInput.value = box!.sessionName;
  const sessionRefresh = document.createElement('button');
  sessionRefresh.type = 'button';
  sessionRefresh.className = 'session-refresh';
  sessionRefresh.title = 'Fetch live tmux sessions from the host';
  sessionRefresh.textContent = '⟳';
  const sessionHint = document.createElement('span');
  sessionHint.className = 'session-hint';
  sessionRow.append(sessionInput, sessionRefresh);
  sessionWrap.append(sessionSpan, sessionRow, sessionDatalist, sessionHint);
  // Pre-fill from cached status (edit mode only — an unsaved box has no snapshot).
  setSessionOptions(isEdit ? (latestStatus[box!.id]?.sessions ?? []).map((s) => s.name) : []);

  sessionRefresh.addEventListener('click', async () => {
    const host = fields.host.value.trim();
    if (!host) { sessionHint.textContent = 'enter a host first'; sessionHint.className = 'session-hint err'; return; }
    sessionRefresh.disabled = true;
    sessionHint.className = 'session-hint';
    sessionHint.textContent = 'fetching…';
    try {
      const spec: { id?: string; host: string; user?: string; port?: number; proxyJump?: string } = { host };
      if (isEdit) spec.id = box!.id;
      const user = fields.user.value.trim(); if (user) spec.user = user;
      const jump = fields.proxyJump.value.trim(); if (jump) spec.proxyJump = jump;
      const portRaw = fields.port.value.trim(); if (portRaw) spec.port = Number(portRaw);
      const res = await api.probeSessions(spec);
      if (res.inUse) {
        sessionHint.textContent = 'in use — showing cached';
      } else if (res.needsAuth) {
        sessionHint.textContent = 'needs login — open the terminal';
        sessionHint.className = 'session-hint err';
      } else if (!res.reachable) {
        sessionHint.textContent = "couldn't reach host";
        sessionHint.className = 'session-hint err';
      } else if (res.tmux === false) {
        setSessionOptions([]);
        sessionHint.textContent = 'tmux not running';
      } else {
        const names = (res.sessions ?? []).map((s) => s.name);
        setSessionOptions(names);
        sessionHint.textContent = names.length ? `${names.length} session${names.length === 1 ? '' : 's'}` : 'no sessions yet';
      }
    } catch (e: any) {
      sessionHint.textContent = e?.message || 'fetch failed';
      sessionHint.className = 'session-hint err';
    } finally {
      sessionRefresh.disabled = false;
    }
  });
```

- [ ] **Step 3: Insert the field into the form layout**

In `src/web/main.ts`, find the `form.append(...)` call that lists the fields (~line 659) and add `sessionWrap` between the `proxyJump` field and `installOhMyTmux`:

```js
  form.append(
    title,
    hostWrap,
    field('label', 'Label (optional)', { placeholder: 'defaults to host' }),
    field('tag', 'Tag', { placeholder: 'prod, staging, db', list: tagListId }),
    tagDatalist,
    field('user', 'User', { value: 'root' }),
    field('port', 'Port (optional)', { placeholder: '22', type: 'number' }),
    field('proxyJump', 'ProxyJump (optional)', { placeholder: 'jump host this server can reach' }),
    sessionWrap,
    installOhMyTmux,
    shellGroup,
    err,
    actions,
  );
```

- [ ] **Step 4: Include `sessionName` on submit (both branches)**

In `src/web/main.ts`, in the edit branch of the submit handler, find (~line 709):

```js
        const tag = canonicalTagForInput(fields.tag.value);
        patch.tags = tag ? [tag] : [];
```

Add directly after those two lines:

```js
        patch.sessionName = sessionInput.value.trim() || 'web';
```

Then in the add branch, find (~line 737):

```js
        const tag = canonicalTagForInput(fields.tag.value); if (tag) spec.tags = [tag];
```

Add directly after it:

```js
        spec.sessionName = sessionInput.value.trim() || 'web';
```

- [ ] **Step 5: Add styling**

In `src/web/style.css`, find the modal field rule (~line 148):

```css
.modal .field input { padding: 9px 10px; border-radius: 8px; border: 1px solid #232a36; background: #131722; color: #c9d1d9; font-size: 14px; }
```

Add directly after it:

```css
.modal .session-row { display: flex; gap: 6px; align-items: stretch; }
.modal .session-row input { flex: 1; min-width: 0; }
.modal .session-refresh { flex: 0 0 auto; padding: 0 11px; border-radius: 8px; border: 1px solid #232a36; background: #131722; color: #c9d1d9; cursor: pointer; font-size: 15px; line-height: 1; }
.modal .session-refresh:disabled { opacity: 0.5; cursor: default; }
.modal .session-hint { font-size: 11px; color: #6e7681; min-height: 1em; }
.modal .session-hint.err { color: #f85149; }
```

- [ ] **Step 6: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; `vite build` writes `dist/` successfully.

- [ ] **Step 7: Manual smoke test**

`main.ts` is DOM glue with no unit harness (repo convention), so verify by hand:

Run: `npm run dev` (then open the dashboard in a browser, logging in).
Confirm:
1. **Edit** an existing reachable box → the dialog shows a **tmux session** field between ProxyJump and "Install Oh My Tmux". Its dropdown lists `web (default)` plus any sessions already shown in that box's status. Opening the dialog triggers **no** new SSH (watch the server log).
2. Click **⟳** → the hint shows `fetching…` then a count (or `tmux not running` / `couldn't reach host` / `needs login…`), and the dropdown updates. A box with a live open terminal shows `in use — showing cached`.
3. Type a name (or pick one), **Save**, reopen Edit → the value persisted. Clear the field, Save, reopen → it shows `web`.
4. **Add** a new box with a session name set → after Add, provisioning targets that session name.

- [ ] **Step 8: Commit**

```bash
git add src/web/api.ts src/web/main.ts src/web/style.css
git commit -m "feat(ui): selectable tmux session name with live-fetch dropdown

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review notes

- **Spec coverage:** `listSessions` + guard (Task 1); `POST /api/boxes/probe-sessions` with auth + `assertBoxSafe` 400 (Task 2); store round-trip guarded at the route level (Task 2, `sessionName persists` test); UI field, cached pre-fill, ⟳ live fetch, all hint states, submit-always-`web` rule, field placement, styling (Task 3). Store needs no code change (confirmed: `normalize()` already sanitizes `spec.sessionName` for add and update).
- **Known limitation (per spec, accepted):** when a box has a live interactive session, `checkBox` caches `sessions: []`, so the pre-fill and the `inUse` ⟳ path show only `web`; the user can still type any name. Not blocking.
- **Type consistency:** `listSessions`, `probeSessions`, `setSessionOptions`, `sessionInput`, `Status.inUse` are referenced consistently across tasks.
