# Pane Header Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every stage pane gets a persistent 28px header bar — identity (dot, name, `user@host`) left, state chip + voice/refresh/undock right — replacing the floating voice button and the split-only hover nameplate.

**Architecture:** New pure module `src/web/paneHeader.ts` (view-model + thin DOM layer, house pattern). `stagePanes.ts` renders the header via a new `headerFor(id, split)` hook and wraps pane content in a `.pane-body`; `main.ts` supplies data (boxes list, `latestStatus`, `latestSeries` agent samples, terminal connection state) and keeps a paneId→update registry so polls refresh bars in place. `terminal.ts` gains two optional seams: a voice-button mount element and a connection-state callback. Zero server changes (spec as amended: agent state already ships in `GET /api/health/series` samples).

**Tech Stack:** TypeScript web client (Vite), vitest for pure-model tests, Playwright e2e. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-pane-header-bar-design.md` (as amended — zero server changes).
- Public repo: no real PII in code, tests, or docs — placeholder hosts/IPs only (`example.com`, `192.168.1.10`).
- ESM; server is plain `.js`, web client `.ts`. Conventional-commit messages. TDD: failing test first; tests use real code, no mocks.
- `npm test` = typecheck + vitest and must pass at every commit; e2e (`npm run test:e2e`) must pass at Tasks 4 and 5. E2E needs a fresh `npm run build` first (the e2e server serves `dist/`).
- Do not touch the production service; e2e uses its own server on port 7438.
- Pane cap stays `MAX_PANES = 2` in `main.ts`; the bar renders per-pane and must be N-capable by construction (no two-pane assumptions inside `paneHeader.ts`/`stagePanes.ts`).

---

### Task 1: Pure view-model — `paneHeaderModel` / `paneHeaderChip`

**Files:**
- Create: `src/web/paneHeader.ts` (pure part only; DOM layer arrives in Task 2)
- Test: `test/paneHeader.test.js`

**Interfaces:**
- Consumes: `dotClassFor(st)` / `dotTitleFor(st)` from `src/web/statusDot.ts`; `Status` type from `src/web/api.ts`.
- Produces (later tasks rely on these exact names):
  - `type ConnKind = 'connecting' | 'open' | 'retrying' | 'setup'`
  - `interface PaneConn { kind: ConnKind; attempt?: number }`
  - `interface PaneHeaderInput { local: boolean; label: string; user?: string; host?: string; status?: Status; agent?: 'working' | 'waiting' | 'unknown'; conn?: PaneConn; state: 'terminal' | 'stopped' | 'setup' }`
  - `interface PaneChip { kind: 'state' | 'conn' | 'agent'; text: string; cls: string }`
  - `interface PaneHeaderModel { title: string; target: string; dotClass: string; dotTitle: string; chip: PaneChip | null }`
  - `function paneHeaderChip(i: PaneHeaderInput): PaneChip | null`
  - `function paneHeaderModel(i: PaneHeaderInput): PaneHeaderModel`

- [ ] **Step 1: Write the failing tests**

Create `test/paneHeader.test.js`:

```js
import { test, expect } from 'vitest';
import { paneHeaderModel, paneHeaderChip } from '../src/web/paneHeader.ts';

const box = (over = {}) => ({
  local: false, label: 'db-primary', user: 'ops', host: '192.168.1.10',
  status: { reachable: true, tmux: true }, state: 'terminal', ...over,
});

test('identity: label, user@host target, green dot for a reachable box', () => {
  const m = paneHeaderModel(box({ conn: { kind: 'open' } }));
  expect(m.title).toBe('db-primary');
  expect(m.target).toBe('ops@192.168.1.10');
  expect(m.dotClass).toBe('green');
  expect(m.chip).toBeNull();
});

test('a box without a user shows the bare host', () => {
  expect(paneHeaderModel(box({ user: undefined })).target).toBe('192.168.1.10');
});

test('local shell: fixed target text, dot tracks the connection', () => {
  const local = { local: true, label: 'Host Shell', state: 'terminal' };
  expect(paneHeaderModel({ ...local, conn: { kind: 'open' } }).target).toBe('this host');
  expect(paneHeaderModel({ ...local, conn: { kind: 'open' } }).dotClass).toBe('green');
  expect(paneHeaderModel({ ...local, conn: { kind: 'connecting' } }).dotClass).toBe('gray');
});

test('status delegation: unreachable box gets the red dot', () => {
  expect(paneHeaderModel(box({ status: { reachable: false } })).dotClass).toBe('red');
});

test('chip precedence: pane state beats connection beats agent', () => {
  expect(paneHeaderChip(box({ state: 'stopped', conn: { kind: 'retrying', attempt: 3 }, agent: 'waiting' })))
    .toEqual({ kind: 'state', text: 'stopped', cls: 'chip-state' });
  expect(paneHeaderChip(box({ state: 'setup' })))
    .toEqual({ kind: 'state', text: 'setting up', cls: 'chip-state' });
  expect(paneHeaderChip(box({ conn: { kind: 'retrying', attempt: 3 }, agent: 'waiting' })))
    .toEqual({ kind: 'conn', text: 'reconnecting ×3', cls: 'chip-conn' });
  expect(paneHeaderChip(box({ conn: { kind: 'connecting' } })))
    .toEqual({ kind: 'conn', text: 'connecting…', cls: 'chip-conn' });
  expect(paneHeaderChip(box({ conn: { kind: 'setup' } })))
    .toEqual({ kind: 'conn', text: 'setting up…', cls: 'chip-conn' });
});

test('agent chip only when the connection is quiet, never for unknown', () => {
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, agent: 'working' })))
    .toEqual({ kind: 'agent', text: 'working', cls: 'chip-agent-working' });
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, agent: 'waiting' })))
    .toEqual({ kind: 'agent', text: 'waiting', cls: 'chip-agent-waiting' });
  expect(paneHeaderChip(box({ conn: { kind: 'open' }, agent: 'unknown' }))).toBeNull();
  expect(paneHeaderChip(box({ conn: { kind: 'open' } }))).toBeNull();
});

test('retrying without an attempt count defaults to ×1', () => {
  expect(paneHeaderChip(box({ conn: { kind: 'retrying' } }))?.text).toBe('reconnecting ×1');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/paneHeader.test.js`
Expected: FAIL — cannot resolve `../src/web/paneHeader.ts`.

- [ ] **Step 3: Implement the pure model**

Create `src/web/paneHeader.ts`:

```ts
// Pane header bar: the pure view-model (unit-tested) plus the DOM layer
// (covered by the split e2e — same split as stagePanes.ts). Never imports
// main.ts; everything arrives via PaneHeaderInput / PaneHeaderActions.
import { dotClassFor, dotTitleFor } from './statusDot';
import type { Status } from './api';

export type ConnKind = 'connecting' | 'open' | 'retrying' | 'setup';
export interface PaneConn { kind: ConnKind; attempt?: number }

export interface PaneHeaderInput {
  local: boolean;
  label: string;
  user?: string;
  host?: string;
  status?: Status;
  agent?: 'working' | 'waiting' | 'unknown';
  conn?: PaneConn;
  state: 'terminal' | 'stopped' | 'setup';
}

export interface PaneChip { kind: 'state' | 'conn' | 'agent'; text: string; cls: string }
export interface PaneHeaderModel { title: string; target: string; dotClass: string; dotTitle: string; chip: PaneChip | null }

// One slot, strict precedence: a pane-level state (stopped container, box
// mid-setup) outranks connection churn, which outranks the agent read — a
// disconnected pane has no live agent worth reporting on. 'unknown' agent
// (box clock unavailable) renders nothing rather than a lying chip.
export function paneHeaderChip(i: PaneHeaderInput): PaneChip | null {
  if (i.state === 'stopped') return { kind: 'state', text: 'stopped', cls: 'chip-state' };
  if (i.state === 'setup') return { kind: 'state', text: 'setting up', cls: 'chip-state' };
  if (i.conn?.kind === 'retrying') return { kind: 'conn', text: `reconnecting ×${i.conn.attempt ?? 1}`, cls: 'chip-conn' };
  if (i.conn?.kind === 'connecting') return { kind: 'conn', text: 'connecting…', cls: 'chip-conn' };
  if (i.conn?.kind === 'setup') return { kind: 'conn', text: 'setting up…', cls: 'chip-conn' };
  if (i.agent === 'working' || i.agent === 'waiting') return { kind: 'agent', text: i.agent, cls: `chip-agent-${i.agent}` };
  return null;
}

export function paneHeaderModel(i: PaneHeaderInput): PaneHeaderModel {
  // The local shell has no Status entry — its dot tracks the WebSocket the
  // way the sidebar's local dot does, not an SSH probe it will never have.
  const dotClass = i.local ? (i.conn?.kind === 'open' ? 'green' : 'gray') : dotClassFor(i.status);
  const dotTitle = i.local ? (i.conn?.kind === 'open' ? 'Connected' : 'Not connected') : dotTitleFor(i.status);
  return {
    title: i.label,
    target: i.local ? 'this host' : (i.user ? `${i.user}@${i.host ?? ''}` : i.host ?? ''),
    dotClass,
    dotTitle,
    chip: paneHeaderChip(i),
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/paneHeader.test.js`
Expected: 7 passed. Then `npm test` — everything else still green.

- [ ] **Step 5: Commit**

```bash
git add src/web/paneHeader.ts test/paneHeader.test.js
git commit -m "feat(web): pane header view-model (paneHeader.ts pure part)"
```

---

### Task 2: DOM layer — `buildPaneHeader` + CSS

**Files:**
- Modify: `src/web/paneHeader.ts` (append the DOM layer)
- Modify: `src/web/style.css` (new `.pane-header` block; the old nameplate CSS is removed in Task 4 when its DOM goes away)

**Interfaces:**
- Consumes: `PaneHeaderModel` from Task 1.
- Produces:
  - `interface PaneHeaderActions { onRefresh?: () => void; refreshLabel?: string; onUndock?: () => void; undockLabel?: string }`
  - `function buildPaneHeader(model: PaneHeaderModel, actions?: PaneHeaderActions): { el: HTMLElement; voiceSlot: HTMLElement; update(m: PaneHeaderModel): void }`
  - `update()` rewrites text/classes in place and NEVER rebuilds children — Task 4 parks the live voice button inside `voiceSlot`, and a rebuild would destroy its recording state.

- [ ] **Step 1: Append the DOM builder to `src/web/paneHeader.ts`**

```ts
export interface PaneHeaderActions {
  onRefresh?: () => void;
  refreshLabel?: string;
  onUndock?: () => void;
  undockLabel?: string;
}

// update() rewrites text/classes only — the voice button lives inside
// voiceSlot across updates, and rebuilding children would kill an in-flight
// recording. Action buttons are fixed at build time: refresh/undock
// availability changes only on a full stage repaint, never mid-poll.
export function buildPaneHeader(model: PaneHeaderModel, actions: PaneHeaderActions = {}): {
  el: HTMLElement; voiceSlot: HTMLElement; update(m: PaneHeaderModel): void;
} {
  const el = document.createElement('div');
  el.className = 'pane-header';

  const dot = document.createElement('span');
  const title = document.createElement('span');
  title.className = 'pane-title';
  const target = document.createElement('span');
  target.className = 'pane-target';
  const identity = document.createElement('div');
  identity.className = 'pane-header-id';
  identity.append(dot, title, target);

  const chip = document.createElement('span');
  const voiceSlot = document.createElement('span');
  voiceSlot.className = 'pane-voice-slot';
  const acts = document.createElement('div');
  acts.className = 'pane-header-actions';
  acts.append(chip, voiceSlot);

  if (actions.onRefresh) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pane-act pane-refresh';
    btn.textContent = '↻';
    btn.title = 'Reconnect terminal';
    btn.setAttribute('aria-label', actions.refreshLabel ?? 'Reconnect terminal');
    btn.addEventListener('click', (e) => { e.stopPropagation(); actions.onRefresh!(); });
    acts.append(btn);
  }
  if (actions.onUndock) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pane-act pane-undock';
    btn.textContent = '✕';
    btn.title = 'Undock';
    btn.setAttribute('aria-label', actions.undockLabel ?? 'Undock');
    btn.addEventListener('click', (e) => { e.stopPropagation(); actions.onUndock!(); });
    acts.append(btn);
  }

  el.append(identity, acts);

  const update = (m: PaneHeaderModel) => {
    dot.className = `dot ${m.dotClass}`;
    dot.title = m.dotTitle;
    title.textContent = m.title;
    target.textContent = m.target;
    if (m.chip) {
      chip.hidden = false;
      chip.textContent = m.chip.text;
      chip.className = `pane-chip ${m.chip.cls}`;
    } else {
      chip.hidden = true;
      chip.className = 'pane-chip';
      chip.textContent = '';
    }
  };
  update(model);
  return { el, voiceSlot, update };
}
```

- [ ] **Step 2: Add the CSS block**

In `src/web/style.css`, directly after the `.stage-pane.focused` rule (line ~414), insert:

```css
/* --- Pane header bar --- */
/* Identity + state + actions above every pane's terminal. The bar is darker
   than the terminal background (#0b0e14) so it reads as chrome, not content. */
.pane-header {
  display: flex; align-items: center; gap: 8px;
  padding: 0 8px 0 12px; min-width: 0;
  background: #05070a; border-bottom: 1px solid var(--border);
  font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em;
  color: var(--muted); user-select: none;
}
/* Focus carries the Inset Beacon (DESIGN.md): the bar, not the whole pane, is
   where the eye checks which terminal owns the keyboard. */
.stage-pane.focused .pane-header { box-shadow: inset 3px 0 0 rgba(36, 211, 232, 0.45); color: var(--text); }
.pane-header-id { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
.pane-header .pane-title { white-space: nowrap; }
.pane-header .pane-target {
  text-transform: none; letter-spacing: 0.02em; font-weight: 400; opacity: 0.7;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pane-header-actions { display: flex; align-items: center; gap: 6px; }
.pane-chip { padding: 1px 7px; border-radius: 9px; border: 1px solid var(--border); }
.pane-chip.chip-agent-waiting { color: #e3b341; border-color: rgba(227, 179, 65, 0.5); }
.pane-chip.chip-agent-working { color: #24d3e8; border-color: rgba(36, 211, 232, 0.35); }
.pane-chip.chip-conn, .pane-chip.chip-state { color: var(--muted); }
.pane-header .pane-act {
  font: inherit; font-size: 12px; padding: 1px 7px;
  text-transform: none; letter-spacing: normal;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--panel-2); color: var(--text);
  cursor: pointer; opacity: 0.55;
}
.pane-header .pane-act:hover, .pane-header .pane-act:focus-visible { opacity: 1; }
/* Docked in the bar, the voice button loses its floating-over-canvas geometry. */
.pane-header .voice-btn { position: static; top: auto; right: auto; }
```

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: all green (the DOM layer has no unit test — it is covered by the split e2e in Tasks 4–5, same convention as `stagePanes.ts`'s renderer).

- [ ] **Step 4: Commit**

```bash
git add src/web/paneHeader.ts src/web/style.css
git commit -m "feat(web): pane header DOM layer and styles"
```

---

### Task 3: `terminal.ts` seams — voice mount + connection state

**Files:**
- Modify: `src/web/terminal.ts:262` (`openTerminal`)

**Interfaces:**
- Consumes: `PaneConn` from Task 1 (`import type { PaneConn } from './paneHeader'`).
- Produces: `openTerminal(parent: HTMLElement, boxId: string, label?: string, opts?: { voiceMount?: HTMLElement; onConnState?: (s: PaneConn) => void })` — both opts optional; omitting them preserves today's behavior exactly (voice floats over the canvas, no state callbacks).

- [ ] **Step 1: Extend the signature and wire the emissions**

In `src/web/terminal.ts`:

Change the signature (line 262):

```ts
export function openTerminal(
  parent: HTMLElement,
  boxId: string,
  label?: string,
  opts?: { voiceMount?: HTMLElement; onConnState?: (s: PaneConn) => void },
) {
```

Add the import at the top alongside the existing ones:

```ts
import type { PaneConn } from './paneHeader';
```

Repoint the voice mount (line 277) — the button parent becomes the bar slot when provided:

```ts
const voice = wireVoice(opts?.voiceMount ?? parent, boxId, {
```

Add an emit helper just above `function connect()` (a listener error must never break the terminal):

```ts
const emitConn = (s: PaneConn) => { try { opts?.onConnState?.(s); } catch {} };
```

Emit at the four transition points inside `connect()`:
- First line inside `connect()` after the `closedByUser` guard: `emitConn({ kind: 'connecting' });`
- Inside `ws.onopen`, first line: `emitConn({ kind: 'open' });`
- Inside the `ev.reason === 'setting up'` branch of `ws.onclose`, before the retry timer: `emitConn({ kind: 'setup' });`
- In the normal `ws.onclose` path, after `failures += 1;`: `emitConn({ kind: 'retrying', attempt: failures });`

- [ ] **Step 2: Verify**

Run: `npm test`
Expected: green — the new parameter is optional and every existing caller passes three args. (Behavioral coverage lands with the e2e in Task 5: the header shows `connecting…` and settles.)

- [ ] **Step 3: Commit**

```bash
git add src/web/terminal.ts
git commit -m "feat(web): openTerminal seams — voice mount element and connection-state callback"
```

---

### Task 4: Wire the bar — `stagePanes.ts` + `main.ts` + CSS/e2e cleanup

This is the integration task: the hook change, the data plumbing, the nameplate's removal, and the e2e selector migration are one unit — each piece is uncompilable or red without the others.

**Files:**
- Modify: `src/web/stagePanes.ts:50-57` (PaneHooks), `:135-157` (buildPane)
- Modify: `src/web/main.ts` — `tabs` (line 27), `ensureTab` (~589), `paneHooks` (~638), `repaintStage` (~663), `pollStatus` (~441), `pollHealth` (~486), `closeTab` (~1305)
- Modify: `src/web/style.css:415-431` (delete nameplate/undock blocks)
- Modify: `src/web/api.ts:31-34` (Sample.agent comment — no longer "unused by the client")
- Test: `test/e2e/split.spec.ts` (selector migration — done FIRST as the failing test)

**Interfaces:**
- Consumes: `paneHeaderModel`, `buildPaneHeader`, `PaneConn`, `PaneHeaderModel` (Tasks 1–2); `openTerminal` opts (Task 3).
- Produces: `PaneHooks` becomes `{ contentFor(id): HTMLElement; headerFor(id: string, split: boolean): HTMLElement; onFocus(id): void; onRatio(divider, firstShare, phase): void; onToggleOrientation(): void }` — `labelFor` and `onUndock` are deleted (the header owns both concerns; `main.ts` builds it).

- [ ] **Step 1: Migrate the e2e spec first (the failing test)**

In `test/e2e/split.spec.ts`:
- Line 23: `await expect(page.locator('.pane-nameplate').first()).toHaveText(/localhost/i);` → `await expect(page.locator('.pane-header .pane-title').first()).toHaveText(/localhost/i);`
- Lines 47–48: delete the `.hover()` line (the undock button is always visible now); keep `await page.getByRole('button', { name: 'Undock db-primary' }).click();`
- Line 61: `.pane-nameplate` → `.pane-title` (same `{ hasText: 'untagged-worker' }` filter)
- Line 62: `.pane-nameplate` → `.pane-title`

Run: `npm run build && npx playwright test test/e2e/split.spec.ts`
Expected: FAIL — `.pane-title` does not exist yet.

- [ ] **Step 2: `stagePanes.ts` — header hook + pane body**

Replace the `PaneHooks` interface (lines 50–57):

```ts
export interface PaneHooks {
  contentFor(id: string): HTMLElement;
  headerFor(id: string, split: boolean): HTMLElement;
  onFocus(id: string): void;
  onRatio(divider: number, firstShare: number, phase: 'drag' | 'commit'): void;
  onToggleOrientation(): void;
}
```

Replace `buildPane` (lines 135–157):

```ts
function buildPane(id: string, split: boolean, focused: boolean, hooks: PaneHooks): HTMLElement {
  const pane = document.createElement('div');
  pane.className = 'stage-pane';
  pane.dataset.paneId = id;
  pane.classList.toggle('focused', focused);
  // Capture-phase: xterm swallows bubbling mousedowns inside the terminal.
  pane.addEventListener('mousedown', () => hooks.onFocus(id), true);
  pane.append(hooks.headerFor(id, split));
  // .term children position absolutely against the body, not the pane, so the
  // header keeps its own row instead of being painted over.
  const body = document.createElement('div');
  body.className = 'pane-body';
  body.append(hooks.contentFor(id));
  pane.append(body);
  return pane;
}
```

- [ ] **Step 3: CSS — pane rows + delete the dead chrome**

In `src/web/style.css`:
- Change `.stage-pane` (line 413) to grid rows and add the body rule:

```css
.stage-pane { position: relative; overflow: hidden; min-width: 0; min-height: 0; border: 1px solid transparent; display: grid; grid-template-rows: 28px 1fr; }
.pane-body { position: relative; overflow: hidden; min-width: 0; min-height: 0; }
```

- Delete the `.pane-nameplate` block, the `.stage-pane.focused .pane-nameplate` rule, the `.pane-undock` block, and the `.stage-pane:hover .pane-undock, .pane-undock:focus-visible` / `.pane-undock:hover` rules (lines 416–431). The `.stage-pane.focused { border-color: … }` rule stays.
- In the comment above `.voice-btn` (line ~455), note the floating geometry is now the fallback for a terminal opened without a `voiceMount` (none in the app today).

- [ ] **Step 4: `main.ts` — data plumbing**

All edits in `src/web/main.ts`:

(a) Extend the tab record and add the two registries (line 27):

```ts
const tabs = new Map<string, { el: HTMLElement; term: ReturnType<typeof openTerminal>; voiceMount: HTMLElement }>();
const connStates = new Map<string, PaneConn>();
const paneHeaders = new Map<string, (m: PaneHeaderModel) => void>();
```

Add to the imports from `./paneHeader`:

```ts
import { paneHeaderModel, buildPaneHeader, type PaneConn, type PaneHeaderModel } from './paneHeader';
```

(b) Model assembly + in-place refresh (place near `paneHooks`, ~line 638):

```ts
function paneHeaderModelFor(id: string): PaneHeaderModel {
  const box = allBoxes.find((b) => b.id === id);
  // Latest health sample carries the agent read (see the spec: the series
  // already ships it; the bar is its first client consumer).
  const series = latestSeries[id];
  return paneHeaderModel({
    local: id === '__local__',
    label: id === '__local__' ? 'Host Shell' : box?.label ?? id,
    user: box?.user,
    host: box?.host,
    status: latestStatus[id],
    agent: series?.[series.length - 1]?.agent,
    conn: connStates.get(id),
    state: paneState(id),
  });
}

function updatePaneHeaders() {
  for (const [id, update] of paneHeaders) update(paneHeaderModelFor(id));
}
```

(c) `ensureTab` (~line 589) — create the voice mount and report connection state:

```ts
function ensureTab(id: string) {
  if (tabs.has(id)) return;
  const el = document.createElement('div');
  el.className = 'term';
  stageParking().appendChild(el);
  const box = allBoxes.find((b) => b.id === id);
  const voiceMount = document.createElement('span');
  voiceMount.className = 'pane-voice-slot';
  const term = openTerminal(el, id, id === '__local__' ? 'local shell' : box?.label, {
    voiceMount,
    onConnState: (s) => { connStates.set(id, s); updatePaneHeaders(); },
  });
  tabs.set(id, { el, term, voiceMount });
  if (id === '__local__') updateLocalDot();
}
```

(d) `paneHooks()` (~line 638) — swap `labelFor`/`onUndock` for `headerFor`:

```ts
function paneHooks(): PaneHooks {
  return {
    contentFor: (id) => paneContentFor(id),
    headerFor: (id, split) => {
      const model = paneHeaderModelFor(id);
      const terminalPane = paneState(id) === 'terminal';
      const built = buildPaneHeader(model, {
        // Stopped/setting-up panes keep the identity half only — their panels
        // own the actions (spec). Undock stays: a non-terminal pane must
        // remain removable from a split.
        ...(terminalPane ? {
          onRefresh: async () => {
            if (id === '__local__') await api.reconnectLocalShell();
            else await api.reconnectBox(id);
            closeTab(id, { keepPane: true });
            repaintStage();
          },
          refreshLabel: `Reconnect ${model.title} terminal`,
        } : {}),
        ...(split ? { onUndock: () => undockBox(id), undockLabel: `Undock ${model.title}` } : {}),
      });
      if (terminalPane) {
        ensureTab(id);
        built.voiceSlot.append(tabs.get(id)!.voiceMount);
      }
      paneHeaders.set(id, built.update);
      return built.el;
    },
    onFocus: (id) => { if (focusedBoxId !== id) { focusedBoxId = id; syncPaneFocus(); persistStage(); } },
    onRatio: (divider, firstShare, phase) => {
      stageLayout = setRatio(stageLayout, divider, firstShare);
      applyRatios(stageGrid(), stageLayout);
      if (phase === 'commit') { refitActiveTerminals(); persistStage(); }
      else requestAnimationFrame(refitActiveTerminals);
    },
    onToggleOrientation: () => { stageLayout = toggleOrientation(stageLayout); repaintStage(); },
  };
}
```

The refresh aria-label is deliberately NOT `Reconnect ${label}` — that exact string belongs to the sidebar row button, and two identical labels would trip Playwright's strict mode (the v1.15.0 `getByLabel('Tag')` lesson).

(e) `repaintStage()` (~line 663) — first line of the function body: `paneHeaders.clear();` (stale update closures die with their DOM; `headerFor` re-registers the survivors during render).

(f) `pollStatus()` — after the `applyRowStatus` loop (after line 453), add `updatePaneHeaders();`. In `pollHealth()`, after `repaintSparklines();` (line 489), add `updatePaneHeaders();` (the agent read arrives with the series).

(g) `closeTab` (~line 1305) — wherever `tabs.delete(id)` happens, add `connStates.delete(id);` beside it.

(h) `src/web/api.ts` lines 31–34 — replace the stale comment on `Sample.agent`:

```ts
  // Agent presence/idleness for the box's configured session (see healthHistory.js
  // sampleOf) and whether that session is attached. The pane header bar reads the
  // latest sample's `agent` for its working/waiting chip (paneHeader.ts).
```

- [ ] **Step 5: Verify unit + typecheck, then e2e**

Run: `npm test`
Expected: green (typecheck confirms no `labelFor`/`onUndock` stragglers).

Run: `npm run build && npx playwright test test/e2e/split.spec.ts`
Expected: all 3 pass — the Step-1 migration is now satisfied.

Run: `npx playwright test`
Expected: 18 passed (voice spec unaffected: `.voice-btn` keeps its class and handlers, only its parent changed).

- [ ] **Step 6: Commit**

```bash
git add src/web/stagePanes.ts src/web/main.ts src/web/style.css src/web/api.ts test/e2e/split.spec.ts
git commit -m "feat(web): pane header bar — identity, state chip, and actions on every pane"
```

---

### Task 5: Header e2e coverage + docs

**Files:**
- Test: `test/e2e/split.spec.ts` (one new test)
- Modify: `README.md` (Split terminals section), `CLAUDE.md` + `AGENTS.md` (web-module inventory)

**Interfaces:**
- Consumes: the rendered bar from Task 4 (`.pane-header`, `.pane-title`, `.pane-target`, `.pane-chip`, aria `Reconnect <label> terminal`).
- Produces: nothing downstream — this is the coverage-and-record task.

- [ ] **Step 1: Write the new e2e test (failing only if Task 4 regressed)**

Append to `test/e2e/split.spec.ts`:

```ts
test('header bar: identity on a single pane, chip slot, and bar-refresh', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();

  // The bar exists on a lone full-stage pane (not just in split view).
  const header = page.locator('.pane-header');
  await expect(header).toHaveCount(1);
  await expect(header.locator('.pane-title')).toHaveText(/localhost/i);
  await expect(header.locator('.pane-target')).toContainText('127.0.0.1');

  // Wait out the connect chip: once the WS is open the slot goes quiet
  // (no agent runs in the e2e sshd session).
  await expect(header.locator('.pane-chip')).toBeHidden({ timeout: 15000 });

  // Bar refresh rebuilds the terminal in place — pane count is unchanged and
  // the terminal reconnects (the connecting banner appears again).
  await page.getByRole('button', { name: 'Reconnect localhost terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expect(page.locator('.stage-pane .xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
});
```

- [ ] **Step 2: Run the spec**

Run: `npm run build && npx playwright test test/e2e/split.spec.ts`
Expected: 4 passed. (If `.pane-target` seeding differs, check `test/helpers` for the seeded localhost host value and match it — do not loosen to a bare non-empty assertion.)

- [ ] **Step 3: Full suites**

Run: `npm test && npx playwright test`
Expected: unit 100% green, e2e 19 passed.

- [ ] **Step 4: Docs**

- `README.md`, "Split terminals" section: add a sentence — every pane now carries a header bar with the box name, `user@host`, live status dot, an agent working/waiting chip, and the voice/reconnect/undock buttons; nothing floats over the terminal anymore.
- `CLAUDE.md` and `AGENTS.md` (keep the two identical, as ever), web-module inventory: add `paneHeader.ts` ("the pure pane-header view-model — identity, dot, one state-chip slot with pane-state > connection > agent precedence — plus the `buildPaneHeader` DOM layer whose `update()` rewrites in place so the docked voice button survives polls") and update the `stagePanes.ts` entry (nameplate → header via the `headerFor` hook, pane content wrapped in `.pane-body`) and the `terminal.ts`-adjacent description in the `main.ts` entry if it mentions the floating voice button.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/split.spec.ts README.md CLAUDE.md AGENTS.md
git commit -m "test(e2e)+docs: pane header bar coverage and module inventory"
```
