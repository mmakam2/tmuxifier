# Terminal gate during setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent opening a box terminal while that box's setup job is running, so the first shell always starts after the seeded credentials and installed tools are in place.

**Architecture:** A pure `blocksTerminal(status)` helper states the rule once. The client consults it in `openBox` and, when blocked, renders a `showSettingUpBox` panel (mirroring the existing `showStoppedBox` stopped-box panel) that polls the job and auto-opens the terminal on completion. The server independently refuses `/term` with close code `1008 'setting up'` for a box with a running job, and `terminal.ts` treats that specific close as a bounded wait rather than a connection failure.

**Tech Stack:** Node 20+, ESM, plain `.js` on the server, TypeScript on the web client, Fastify + `@fastify/websocket`, vitest, `tsc --noEmit`, Vite.

**Spec:** `docs/superpowers/specs/2026-07-21-terminal-gate-during-setup-design.md`

## Global Constraints

- ESM everywhere (`"type": "module"`); Node 20+.
- Server is plain `.js`; web client is `.ts`.
- TDD: write the failing test first, run it, watch it fail, then implement.
- Tests use **real code, not mocks** — injected fakes (plain objects/functions) are fine; mocking libraries are not.
- Web-side unit tests target **pure helpers**, not DOM rendering. Do not add jsdom.
- Never use `innerHTML` in `main.ts` views: all text lands as text nodes.
- `npm test` runs `npm run typecheck && vitest run`. Both must pass before each commit.
- Conventional-commit style messages (`feat(ui): …`, `feat(term): …`).
- Only the `running` status may ever block a terminal. `needs-interactive`, `error`, and `interrupted` must stay reachable — a job can sit parked for days, and those are the boxes most likely to need a shell.
- The server gate must sit **below** the `mode === 'provision'` branch in `/term`. Above it, "Finish interactively" deadlocks.

## File Structure

| File | Responsibility |
|---|---|
| `src/web/setupStatus.ts` (modify) | New pure `blocksTerminal()` — the single statement of the gating rule. |
| `src/server/server.js` (modify) | `/term` refuses a normal box terminal while its setup job is running. |
| `src/web/main.ts` (modify) | `openBox` gate with a bypass option; the `showSettingUpBox` panel and its poller lifecycle. |
| `src/web/style.css` (modify) | Extend the existing stopped-panel rule to cover the new panel. No new rules. |
| `src/web/terminal.ts` (modify) | Treat a `'setting up'` close as a bounded wait, not a failure. |
| `test/setupStatus.test.js` (modify) | `blocksTerminal()` across every status. |
| `test/server.ws.integration.test.js` (modify) | The four server-gate cases. |
| `CLAUDE.md`, `AGENTS.md` (modify) | Note the gate. |

---

### Task 1: The `blocksTerminal` rule

**Files:**
- Modify: `src/web/setupStatus.ts`
- Test: `test/setupStatus.test.js`

**Interfaces:**
- Consumes: `SetupStatus` from `./api` (already imported in that file).
- Produces: `blocksTerminal(status?: SetupStatus | null): boolean` — Tasks 3 uses it.

- [ ] **Step 1: Write the failing test**

In `test/setupStatus.test.js`, add `blocksTerminal` to the existing import:

```js
import { setupStatusText, setupActions, setupBadge, formatSeedResults, blocksTerminal } from '../src/web/setupStatus.ts';
```

Then append:

```js
test('only a running setup job blocks the terminal', () => {
  expect(blocksTerminal('running')).toBe(true);
});

test('parked and finished jobs never block the terminal', () => {
  // needs-interactive can sit parked for days, and error/interrupted boxes are
  // exactly the ones you need a shell on to diagnose. Blocking any of these
  // would make a box unreachable rather than merely not-ready.
  expect(blocksTerminal('needs-interactive')).toBe(false);
  expect(blocksTerminal('done')).toBe(false);
  expect(blocksTerminal('error')).toBe(false);
  expect(blocksTerminal('interrupted')).toBe(false);
  expect(blocksTerminal('superseded')).toBe(false);
});

test('no job at all does not block', () => {
  expect(blocksTerminal(undefined)).toBe(false);
  expect(blocksTerminal(null)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/setupStatus.test.js`
Expected: FAIL — `blocksTerminal is not a function`.

- [ ] **Step 3: Implement**

Append to `src/web/setupStatus.ts`:

```ts
// Whether a setup job in this status must prevent opening the box's terminal.
// Only `running` does. A shell reads its rc files once at startup, so one
// opened mid-setup holds an environment that predates the seeded credentials
// and the installed tools — but `needs-interactive`, `error`, and `interrupted`
// are paused or dead states where nothing is mutating the box and a shell is
// often exactly what's needed. Gating those would make a box unreachable.
export function blocksTerminal(status?: SetupStatus | null): boolean {
  return status === 'running';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/setupStatus.test.js`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/web/setupStatus.ts test/setupStatus.test.js
git commit -m "feat(ui): blocksTerminal, the one statement of the setup-gate rule"
```

---

### Task 2: The server gate

**Files:**
- Modify: `src/server/server.js` — the `// --- Interactive mode (existing) ---` marker inside the `/term` handler
- Test: `test/server.ws.integration.test.js`

**Interfaces:**
- Consumes: `setupManager.currentForBox(boxId)` (already injected into `buildServer`).
- Produces: `/term` close `1008` with reason `setting up`. Task 4 keys off that exact reason string.

- [ ] **Step 1: Write the failing tests**

Append to `test/server.ws.integration.test.js`. These follow the file's existing pattern: an `opened` spy proves `sessions.open` was never reached.

```js
// Builds a server whose box has a setup job in the given status.
async function gateFixture(status) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-gate-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: '192.168.1.10', sessionName: 'web' });
  const state = { opened: false, provisioned: false };
  const sessions = {
    open() { state.opened = true; return {}; },
    provision() { state.provisioned = true; return {}; },
    attach() {}, write() {}, resize() {}, detach() {}, close() {}, closeIfUnwatched() {}, onExit() {},
  };
  const setupManager = status
    ? { currentForBox: () => ({ id: 'j1', boxId: saved.id, status }) }
    : undefined;
  const app = buildServer({
    config, store, sessions, setupManager,
    statusChecker: { checkBox: async () => ({ reachable: true }) },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  teardown = async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); };
  return { port, boxId: saved.id, cookie: `${c.name}=${c.value}`, state };
}

// Resolves { closed: code } or { open: true } — whichever happens first.
function raceOpenClose(url, cookie, ms = 500) {
  const ws = new WebSocket(url, { headers: { cookie } });
  return new Promise((resolve, reject) => {
    ws.on('close', (code) => resolve({ closed: code }));
    ws.on('open', () => setTimeout(() => { ws.close(); resolve({ open: true }); }, ms));
    ws.on('error', reject);
  });
}

test('/term refuses a box whose setup job is running', async () => {
  const { port, boxId, cookie, state } = await gateFixture('running');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/term?box=${boxId}&cols=80&rows=24`, { headers: { cookie } });
  const { code, reason } = await new Promise((resolve, reject) => {
    ws.on('close', (c, r) => resolve({ code: c, reason: r.toString() }));
    ws.on('error', reject);
  });
  expect(code).toBe(1008);
  expect(reason).toBe('setting up');
  expect(state.opened).toBe(false);
}, 10000);

test('/term connects once the setup job is done', async () => {
  const { port, boxId, cookie, state } = await gateFixture('done');
  const res = await raceOpenClose(`ws://127.0.0.1:${port}/term?box=${boxId}&cols=80&rows=24`, cookie);
  expect(res.open).toBe(true);
  expect(state.opened).toBe(true);
}, 10000);

test('/term provision mode is never gated, even while running', async () => {
  // The interactive finish is how a needs-interactive box gets unstuck. If the
  // gate is ever placed above the provision branch, this deadlocks.
  const { port, boxId, cookie, state } = await gateFixture('running');
  const res = await raceOpenClose(
    `ws://127.0.0.1:${port}/term?box=${boxId}&mode=provision&cols=80&rows=24&ohMyTmux=0&ohMyZsh=0&ohMyBash=0`,
    cookie,
  );
  expect(res.open).toBe(true);
  expect(state.provisioned).toBe(true);
}, 10000);

test('/term is ungated when no setupManager is wired', async () => {
  const { port, boxId, cookie, state } = await gateFixture(null);
  const res = await raceOpenClose(`ws://127.0.0.1:${port}/term?box=${boxId}&cols=80&rows=24`, cookie);
  expect(res.open).toBe(true);
  expect(state.opened).toBe(true);
}, 10000);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server.ws.integration.test.js`
Expected: the first test FAILS — the socket opens instead of closing, so `code` is not `1008`. The other three should already pass (nothing gates yet); they exist to keep the gate from over-reaching.

- [ ] **Step 3: Implement the gate**

In `src/server/server.js`, find the `// --- Interactive mode (existing) ---` comment inside the `/term` handler and insert the guard directly beneath it, before the `size` line:

```js
      // --- Interactive mode (existing) ---
      // A shell reads its rc files once, at startup: a terminal opened while
      // setup is still running gets an environment predating the seeded
      // credentials and the installed tools. Only 'running' gates — parked and
      // failed jobs must stay reachable — and provision mode above is
      // deliberately ungated so the interactive finish still works.
      if (setupManager?.currentForBox(boxId)?.status === 'running') {
        socket.close(1008, 'setting up');
        return;
      }
      const size = { cols: Number(cols) || 80, rows: Number(rows) || 24 };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/server.ws.integration.test.js`
Expected: PASS, all four new tests plus the file's existing ones.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js test/server.ws.integration.test.js
git commit -m "feat(term): refuse a box terminal while its setup job is running"
```

---

### Task 3: The client gate and the setting-up panel

**Files:**
- Modify: `src/web/main.ts:913-964` (`showStoppedBox`, `openBox`), `src/web/style.css:316-317`

**Interfaces:**
- Consumes: `blocksTerminal` from Task 1; `createSetupJobPoller`, `setupStatusText`, `api.getBoxSetup`, and the module-level `latestSetups` / `tabs` / `app`, all already present in `main.ts`.
- Produces: `openBox(b: Box, opts?: { fromSetupGate?: boolean })` — the widened signature. Existing call sites (main.ts:624, 713, 724, 738) pass one argument and keep working unchanged.

- [ ] **Step 1: Add the CSS class to the existing rule**

In `src/web/style.css`, replace lines 316-317:

```css
.stopped-box-state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--muted); }
.stopped-box-state strong { color: var(--text); font-size: 15px; }
```

with:

```css
.stopped-box-state, .setting-up-state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--muted); }
.stopped-box-state strong, .setting-up-state strong { color: var(--text); font-size: 15px; }
```

No new rules — the setting-up panel is the same kind of stage-state panel as the stopped one.

- [ ] **Step 2: Import the helper**

In `src/web/main.ts` line 3, replace:

```ts
import { setupStatusText, setupActions, setupBadge, formatSeedResults } from './setupStatus';
```

with:

```ts
import { setupStatusText, setupActions, setupBadge, formatSeedResults, blocksTerminal } from './setupStatus';
```

- [ ] **Step 3: Add the panel and its lifecycle**

In `src/web/main.ts`, insert directly above `function showStoppedBox(box: Box) {` (line 913):

```ts
// The setting-up panel owns a poll loop, so it needs an explicit teardown:
// every path that replaces the stage content must stop it, or a dead panel
// keeps polling (and can auto-open a terminal for a box you navigated away
// from).
let settingUpPoller: { start: () => void; stop: () => void } | null = null;

function clearSettingUpPanel() {
  settingUpPoller?.stop();
  settingUpPoller = null;
  const stage = app.querySelector('#stage') as HTMLElement;
  stage.querySelector('.setting-up-state')?.remove();
}

// Stage panel shown instead of a terminal while a box's setup job is running.
// Mirrors showStoppedBox below, but live: it polls the job, renders its status
// and log, and opens the terminal itself once the job settles.
function showSettingUpBox(box: Box) {
  activeBoxId = box.id;
  highlightBox(box.id);
  app.querySelector('.local-shell')?.classList.remove('active');
  for (const terminal of tabs.values()) terminal.el.style.display = 'none';
  const stage = app.querySelector('#stage') as HTMLElement;
  stage.querySelector('.empty')?.remove();
  stage.querySelector('.stopped-box-state')?.remove();
  clearSettingUpPanel();

  const panel = document.createElement('div');
  panel.className = 'setting-up-state';
  const title = document.createElement('strong');
  title.textContent = `${box.label} is being set up`;
  const detail = document.createElement('span');
  detail.textContent = 'Checking…';
  const log = document.createElement('pre');
  log.className = 'provision-log';
  panel.append(title, detail, log);
  stage.append(panel);

  settingUpPoller = createSetupJobPoller<SetupJob>({
    fetchJob: () => api.getBoxSetup(box.id),
    onJob: (job) => {
      if (!job) return 1500; // not discovered yet / transient fetch error
      detail.textContent = setupStatusText(job);
      log.textContent = job.log || '';
      log.scrollTop = log.scrollHeight;
      if (blocksTerminal(job.status)) return 1000;
      // This job state came straight from the API, so it beats the cached
      // latestSetups that openBox would otherwise consult — without the bypass
      // a stale 'running' entry bounces straight back into this panel, whose
      // poller immediately sees 'done' again, forever.
      clearSettingUpPanel();
      openBox(box, { fromSetupGate: true });
      return null;
    },
  });
  settingUpPoller.start();
}
```

- [ ] **Step 4: Stop the poller when the stopped-box panel takes the stage**

In `showStoppedBox`, directly after the existing line
`stage.querySelector('.stopped-box-state')?.remove();`, add:

```ts
  clearSettingUpPanel();
```

- [ ] **Step 5: Gate `openBox`**

Replace the opening of `openBox` (main.ts:941-947) — currently:

```ts
function openBox(b: Box) {
  if (latestStatus[b.id]?.proxmoxState === 'stopped') {
    closeTab(b.id);
    showStoppedBox(b);
    return;
  }
  activeBoxId = b.id;
```

with:

```ts
function openBox(b: Box, opts?: { fromSetupGate?: boolean }) {
  if (latestStatus[b.id]?.proxmoxState === 'stopped') {
    closeTab(b.id);
    showStoppedBox(b);
    return;
  }
  // A terminal opened mid-setup gets a shell whose environment predates the
  // seeded credentials and installed tools. fromSetupGate is the panel's own
  // auto-open, which has fresher job state than this cached list.
  if (!opts?.fromSetupGate && blocksTerminal(latestSetups.find((s) => s.boxId === b.id)?.status)) {
    closeTab(b.id);
    showSettingUpBox(b);
    return;
  }
  clearSettingUpPanel();
  activeBoxId = b.id;
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both clean. If `SetupJob` is reported as undefined, add it to the existing type import from `./api` at the top of `main.ts`.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/main.ts src/web/style.css
git commit -m "feat(ui): show a live setting-up panel instead of a terminal mid-setup"
```

---

### Task 4: Treat a `'setting up'` close as a bounded wait

**Files:**
- Modify: `src/web/terminal.ts:182` (constants), `:315-324` (`ws.onclose`)

**Interfaces:**
- Consumes: the `1008 'setting up'` close reason from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Add the retry constant**

In `src/web/terminal.ts`, directly below the existing `const STABLE_MS = 15000;` (line 182), add:

```ts
// A terminal refused because the box is mid-setup is a bounded wait, not an
// outage: setup finishes in seconds-to-minutes, so retry on a fixed short
// interval rather than the escalating outage backoff.
const SETUP_RETRY_MS = 2000;
```

- [ ] **Step 2: Handle the close reason**

Replace the `ws.onclose` handler (lines 315-324):

```ts
    ws.onclose = () => {
      clearTimeout(stableTimer);
      if (closedByUser) return;
      failures += 1;
      const delay = reconnectDelay(failures);
      // Escalating backoff to a 5-minute floor (never gives up): a down box settles
      // to a gentle ~1 attempt/5min and auto-reconnects when it comes back.
      term.write(`\r\n\x1b[33m[disconnected — retrying in ${humanDelay(delay)}…]\x1b[0m\r\n`);
      retryTimer = setTimeout(connect, delay);
    };
```

with:

```ts
    ws.onclose = (ev) => {
      clearTimeout(stableTimer);
      if (closedByUser) return;
      // The server refuses a terminal while the box's setup job runs. Retry
      // promptly and leave `failures` untouched: counting this as a failure
      // would poison the backoff that real outages depend on, and could leave
      // the tab idle for minutes after setup had already finished.
      if (ev.reason === 'setting up') {
        term.write('\r\n\x1b[33m[setting up — reconnecting when ready…]\x1b[0m\r\n');
        retryTimer = setTimeout(connect, SETUP_RETRY_MS);
        return;
      }
      failures += 1;
      const delay = reconnectDelay(failures);
      // Escalating backoff to a 5-minute floor (never gives up): a down box settles
      // to a gentle ~1 attempt/5min and auto-reconnects when it comes back.
      term.write(`\r\n\x1b[33m[disconnected — retrying in ${humanDelay(delay)}…]\x1b[0m\r\n`);
      retryTimer = setTimeout(connect, delay);
    };
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/terminal.ts
git commit -m "feat(term): reconnect promptly when refused for setup, without counting a failure"
```

---

### Task 5: Update the architecture docs

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`

- [ ] **Step 1: Note the gate on the `server.js` entry**

In `CLAUDE.md`, find the `- server.js — Fastify app:` bullet under "Architecture (`src/server/`)". Append to it:

```
  The `/term` WebSocket refuses a normal box terminal (close `1008 'setting up'`) while that
  box's setup job is `running`, so a shell can never start with an environment predating the
  seeded credentials and installed tools; `mode=provision` stays ungated so the interactive
  finish still works.
```

- [ ] **Step 2: Note the panel on the web-client paragraph**

In `CLAUDE.md`, find the web-client paragraph beginning "Web client is `src/web/`" and, in the description of `main.ts`, append after the provision-panel clause:

```
  clicking a box whose setup job is still `running` renders a live setting-up panel
  (`blocksTerminal` in `setupStatus.ts`) instead of a terminal, and opens the terminal itself
  once the job settles
```

- [ ] **Step 3: Mirror both edits into AGENTS.md**

`AGENTS.md` is the same content adapted for general coding agents and is kept in sync. Apply the same two edits to the corresponding entries.

Run: `diff <(grep -c "setting up" CLAUDE.md) <(grep -c "setting up" AGENTS.md)`
Expected: no output (equal counts).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: the terminal gate during setup"
```

---

## Final verification

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS — typecheck clean, all vitest files green.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean Vite build into `dist/`.

- [ ] **Step 3: Deploy to verify manually**

The client gate is DOM code with no automated coverage, so it has to be exercised in a browser:

```bash
npm run build && sudo systemctl restart tmuxifier
```

Check no setup/provision/lifecycle/fleet job is `running` before restarting — a restart reconciles running jobs to `interrupted`.

- [ ] **Step 4: Manual check — this is what proves the original bug fixed**

1. Provision a fresh box with the seed option ticked, or Edit-box → re-run setup on an existing box.
2. Click that box in the sidebar **while setup is running**. Expect the setting-up panel with a live log — not a terminal — and expect "Seeding AI credentials…" near the end.
3. Touch nothing. The terminal should open by itself when the job finishes.
4. In that terminal: `echo $CLAUDE_CODE_OAUTH_TOKEN` is non-empty, and interactive `claude` shows as logged in — **with no box refresh**.

Step 4 is the point: that is what required a manual refresh before.

- [ ] **Step 5: Manual check — the already-open tab**

1. Open a box's terminal normally.
2. With that tab still open, Edit-box → re-run setup on the same box.
3. Expect `[setting up — reconnecting when ready…]` in the terminal, and expect it to reconnect within a couple of seconds of the job finishing — not after a multi-minute backoff.
