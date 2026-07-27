# Pane Lifecycle Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a Proxmox-linked box's container lifecycle controls (`▶` start, `⏻` shutdown, `↺` reboot, `⏹` force stop) in that pane's header bar, right after the `user@host` target, guarded by an arm-then-fire interaction and reporting the resulting job as a chip in the same slot.

**Architecture:** One new client module `src/web/paneLifecycle.ts` in the house pattern — a pure, unit-tested core (which keys for which state, the arm state machine, the chip text/class) plus a thin DOM control that owns its arm timer and job poller. `paneHeader.ts` gains a mount point for it (a `lifecycleSlot`, mirroring the existing `voiceSlot` seam); `main.ts` builds and feeds one control per Proxmox-linked pane; `proxmoxUi.ts` gains the ability to open straight to a lifecycle job's log. No server change — `/api/status` already carries `proxmoxState` and the lifecycle job endpoints already exist.

**Tech Stack:** TypeScript (client, bundled by Vite), vitest in the `node` environment (pure functions only — no jsdom in this repo), plain CSS custom properties from `src/web/style.css`.

**Spec:** `docs/superpowers/specs/2026-07-27-pane-lifecycle-controls-design.md`

## Global Constraints

- ESM everywhere; Node 20+. Server is plain `.js`; the web client is `.ts`.
- TDD: write the failing test first. Tests use **real code, not mocks** — dependencies are injected through factory arguments.
- Vitest runs with `environment: 'node'` (`vitest.config.js`). There is **no DOM in unit tests** — only pure functions get unit tests; DOM layers are covered by the Playwright e2e, exactly as `buildPaneHeader`'s is.
- Conventional-commit messages (`feat(ui): …`, `fix(pty): …`).
- Never commit real PII — no real domains, IPs, hostnames, or emails. Examples use `192.168.1.10` / `example.com`.
- Deprovision must **not** appear in the pane header. It stays in the Proxmox hub only.
- Verify with `npm run typecheck && npm test` before each commit that touches `.ts`.

---

### Task 1: Pure core of `paneLifecycle.ts`

The decision logic: which keys a pane shows, what a click does, and what the job chip reads. All pure, all unit-tested.

**Files:**
- Create: `src/web/paneLifecycle.ts`
- Test: `test/paneLifecycle.test.js`

**Interfaces:**
- Consumes: `LifecycleAction`, `LifecycleStatus`, `PveContainerState` from `src/web/proxmox.ts` (already exported there).
- Produces, for Tasks 2 and 3:
  - `type PaneState = 'terminal' | 'stopped' | 'setup'`
  - `type ArmableAction = 'shutdown' | 'reboot' | 'stop'`
  - `type PaneLifecycleAction = 'start' | ArmableAction`
  - `interface LifecycleKey { action: PaneLifecycleAction; glyph: string; label: string; armLegend: string | null; danger: boolean }`
  - `function lifecycleKeysFor(paneState: PaneState, pveState: PveContainerState | undefined): LifecycleKey[]`
  - `interface ArmState { armed: ArmableAction | null }`
  - `const IDLE: ArmState`
  - `type ArmEvent = { type: 'click'; key: LifecycleKey } | { type: 'timeout' } | { type: 'dismiss' } | { type: 'keysChanged' }`
  - `interface ArmOutcome { state: ArmState; fire: PaneLifecycleAction | null }`
  - `function armReduce(state: ArmState, event: ArmEvent): ArmOutcome`
  - `type ChipStatus = LifecycleStatus | 'lost'`
  - `interface LifecycleChip { text: string; cls: string; settled: boolean }`
  - `function chipFor(action: PaneLifecycleAction, status: ChipStatus): LifecycleChip | null`

- [ ] **Step 1: Write the failing test**

Create `test/paneLifecycle.test.js`:

```js
import { test, expect } from 'vitest';
import { lifecycleKeysFor, armReduce, chipFor, IDLE } from '../src/web/paneLifecycle.ts';

const actions = (keys) => keys.map((k) => k.action);
const keyFor = (paneState, pveState, action) =>
  lifecycleKeysFor(paneState, pveState).find((k) => k.action === action);

test('a running container offers shutdown, reboot and force stop', () => {
  expect(actions(lifecycleKeysFor('terminal', 'running'))).toEqual(['shutdown', 'reboot', 'stop']);
});

test('only force stop is marked danger', () => {
  const keys = lifecycleKeysFor('terminal', 'running');
  expect(keys.filter((k) => k.danger).map((k) => k.action)).toEqual(['stop']);
});

test('a stopped pane offers start', () => {
  expect(actions(lifecycleKeysFor('stopped', 'stopped'))).toEqual(['start']);
});

// paneState is sticky through a failed PVE read (see paneState in main.ts): a
// stopped pane must not lose its Start key just because the probe went blind.
test('a stopped pane keeps start when the PVE read is unknown', () => {
  expect(actions(lifecycleKeysFor('stopped', 'unknown'))).toEqual(['start']);
});

test('missing, unknown and absent PVE state offer nothing', () => {
  expect(lifecycleKeysFor('terminal', 'missing')).toEqual([]);
  expect(lifecycleKeysFor('terminal', 'unknown')).toEqual([]);
  expect(lifecycleKeysFor('terminal', undefined)).toEqual([]);
});

// A box mid-setup is running, but every one of these actions would interrupt
// the setup job that just provisioned it.
test('a setting-up pane offers nothing even while the container runs', () => {
  expect(lifecycleKeysFor('setup', 'running')).toEqual([]);
});

test('deprovision is never offered', () => {
  const everyKey = ['terminal', 'stopped', 'setup'].flatMap((pane) =>
    ['running', 'stopped', 'missing', 'unknown'].flatMap((pve) => lifecycleKeysFor(pane, pve)));
  expect(everyKey.some((k) => k.action === 'deprovision')).toBe(false);
});

test('start fires on the first click and never arms', () => {
  const start = keyFor('stopped', 'stopped', 'start');
  expect(start.armLegend).toBeNull();
  expect(armReduce(IDLE, { type: 'click', key: start })).toEqual({ state: { armed: null }, fire: 'start' });
});

test('a destructive key arms on the first click and fires on the second', () => {
  const shutdown = keyFor('terminal', 'running', 'shutdown');
  const armed = armReduce(IDLE, { type: 'click', key: shutdown });
  expect(armed).toEqual({ state: { armed: 'shutdown' }, fire: null });
  expect(armReduce(armed.state, { type: 'click', key: shutdown })).toEqual({ state: { armed: null }, fire: 'shutdown' });
});

test('clicking a different key moves the arm rather than firing', () => {
  const shutdown = keyFor('terminal', 'running', 'shutdown');
  const reboot = keyFor('terminal', 'running', 'reboot');
  const armed = armReduce(IDLE, { type: 'click', key: shutdown }).state;
  expect(armReduce(armed, { type: 'click', key: reboot })).toEqual({ state: { armed: 'reboot' }, fire: null });
});

test('start clears an arm without firing the armed action', () => {
  const shutdown = keyFor('terminal', 'running', 'shutdown');
  const start = keyFor('stopped', 'stopped', 'start');
  const armed = armReduce(IDLE, { type: 'click', key: shutdown }).state;
  expect(armReduce(armed, { type: 'click', key: start })).toEqual({ state: { armed: null }, fire: 'start' });
});

test('timeout, dismissal and a key-set change all disarm without firing', () => {
  const stop = keyFor('terminal', 'running', 'stop');
  const armed = armReduce(IDLE, { type: 'click', key: stop }).state;
  for (const type of ['timeout', 'dismiss', 'keysChanged']) {
    expect(armReduce(armed, { type })).toEqual({ state: { armed: null }, fire: null });
  }
});

test('chipFor reads the action in progress', () => {
  expect(chipFor('shutdown', 'running')).toEqual({ text: 'shutting down…', cls: 'chip-state', settled: false });
  expect(chipFor('reboot', 'running').text).toBe('rebooting…');
  expect(chipFor('stop', 'running').text).toBe('stopping…');
  expect(chipFor('start', 'running').text).toBe('starting…');
});

test('a done job clears the chip', () => {
  expect(chipFor('shutdown', 'done')).toBeNull();
});

test('error and interrupted settle red', () => {
  expect(chipFor('shutdown', 'error')).toEqual({ text: 'shutdown failed', cls: 'chip-error', settled: true });
  expect(chipFor('reboot', 'interrupted')).toEqual({ text: 'reboot failed', cls: 'chip-error', settled: true });
});

test('a job we lost track of settles red with its own wording', () => {
  expect(chipFor('stop', 'lost')).toEqual({ text: 'lost track of job', cls: 'chip-error', settled: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/paneLifecycle.test.js`
Expected: FAIL — `Failed to resolve import "../src/web/paneLifecycle.ts"`.

- [ ] **Step 3: Write the pure core**

Create `src/web/paneLifecycle.ts`:

```ts
// Proxmox lifecycle controls for a pane header (spec:
// docs/superpowers/specs/2026-07-27-pane-lifecycle-controls-design.md).
// House pattern: a pure, unit-tested core here, the DOM control below it.
import type { LifecycleStatus, PveContainerState } from './proxmox';

export type PaneState = 'terminal' | 'stopped' | 'setup';
export type ArmableAction = 'shutdown' | 'reboot' | 'stop';
export type PaneLifecycleAction = 'start' | ArmableAction;

export interface LifecycleKey {
  action: PaneLifecycleAction;
  glyph: string;
  label: string;
  // null = fires on the first click. Non-null is the legend the key shows
  // while armed, and the marker that it needs arming at all.
  armLegend: string | null;
  danger: boolean;
}

const START: LifecycleKey = { action: 'start', glyph: '▶', label: 'Start container', armLegend: null, danger: false };
const RUNNING_KEYS: LifecycleKey[] = [
  { action: 'shutdown', glyph: '⏻', label: 'Shut down container', armLegend: 'SHUTDOWN?', danger: false },
  { action: 'reboot', glyph: '↺', label: 'Reboot container', armLegend: 'REBOOT?', danger: false },
  { action: 'stop', glyph: '⏹', label: 'Force stop container', armLegend: 'STOP?', danger: true },
];

// Driven by the pane's derived state first, the raw PVE read second: paneState
// (main.ts) already treats an 'unknown' read as sticky for a pane showing its
// stopped panel, so a blind probe cannot strip the Start key off a stopped box.
// Setup wins over everything — a box mid-setup is running, and every action
// here would interrupt the job that just provisioned it.
export function lifecycleKeysFor(paneState: PaneState, pveState: PveContainerState | undefined): LifecycleKey[] {
  if (paneState === 'setup') return [];
  if (paneState === 'stopped') return [START];
  if (pveState === 'running') return RUNNING_KEYS;
  return [];
}

export interface ArmState { armed: ArmableAction | null }
export const IDLE: ArmState = { armed: null };

export type ArmEvent =
  | { type: 'click'; key: LifecycleKey }
  | { type: 'timeout' }
  | { type: 'dismiss' }
  | { type: 'keysChanged' };

export interface ArmOutcome { state: ArmState; fire: PaneLifecycleAction | null }

// Arm-then-fire: a destructive key must be clicked twice, anything else
// disarms. Start is never armable — starting a stopped container loses nothing.
export function armReduce(state: ArmState, event: ArmEvent): ArmOutcome {
  if (event.type !== 'click') return { state: IDLE, fire: null };
  const { key } = event;
  if (key.armLegend == null) return { state: IDLE, fire: key.action };
  if (state.armed === key.action) return { state: IDLE, fire: key.action };
  return { state: { armed: key.action as ArmableAction }, fire: null };
}

export type ChipStatus = LifecycleStatus | 'lost';
export interface LifecycleChip { text: string; cls: string; settled: boolean }

const IN_PROGRESS: Record<PaneLifecycleAction, string> = {
  start: 'starting…', shutdown: 'shutting down…', reboot: 'rebooting…', stop: 'stopping…',
};
const FAILED: Record<PaneLifecycleAction, string> = {
  start: 'start failed', shutdown: 'shutdown failed', reboot: 'reboot failed', stop: 'stop failed',
};

// `settled` is the authority flag: an in-flight chip owns the slot and blocks a
// key rebuild, a settled one is just the last outcome and yields to new keys.
export function chipFor(action: PaneLifecycleAction, status: ChipStatus): LifecycleChip | null {
  if (status === 'running') return { text: IN_PROGRESS[action], cls: 'chip-state', settled: false };
  if (status === 'done') return null;
  if (status === 'lost') return { text: 'lost track of job', cls: 'chip-error', settled: true };
  return { text: FAILED[action], cls: 'chip-error', settled: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/paneLifecycle.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/web/paneLifecycle.ts test/paneLifecycle.test.js
git commit -m "feat(ui): pure core for pane header lifecycle controls"
```

---

### Task 2: The DOM control and its mount point

The control that renders those keys, runs the arm timer, fires the job, and polls it — plus the header slot it mounts into and the styles it needs. Not unit-testable (no DOM in this repo's vitest environment); verified by typecheck and build, and exercised by the existing split e2e.

**Files:**
- Modify: `src/web/paneLifecycle.ts` (append the DOM layer)
- Modify: `src/web/paneHeader.ts:63-125` (add `lifecycleSlot`)
- Modify: `src/web/style.css` (after the `.pane-header .pane-act` rules, ~line 802)

**Interfaces:**
- Consumes: everything Task 1 produced; `createSetupJobPoller` from `./setupPoller` (already generic over its job type — reused verbatim, do not modify it); `pve.createLifecycleJob` / `pve.lifecycleJob` from `./proxmox`.
- Produces, for Task 3:
  - `interface PaneLifecycleInput { paneState: PaneState; pveState: PveContainerState | undefined }`
  - `interface PaneLifecycleDeps { boxId: string; onOpenJobLog: (jobId: string | null) => void; onSettled: () => void; createJob?: …; fetchJob?: … }`
  - `function buildPaneLifecycle(deps: PaneLifecycleDeps): { el: HTMLElement; update(i: PaneLifecycleInput): void; destroy(): void }`
  - `buildPaneHeader(...)` now also returns `lifecycleSlot: HTMLElement`.

- [ ] **Step 1: Add the `lifecycleSlot` to the header**

In `src/web/paneHeader.ts`, the identity cluster currently reads:

```ts
  const identity = document.createElement('div');
  identity.className = 'pane-header-id';
  identity.append(dot, title, target);
```

Replace with:

```ts
  // Mount point for the Proxmox lifecycle keys (paneLifecycle.ts), filled by
  // main.ts for linked boxes only — the same seam as voiceSlot, and for the
  // same reason: its contents own their own update cycle, so update() below
  // must never rebuild them.
  const lifecycleSlot = document.createElement('span');
  lifecycleSlot.className = 'pane-lifecycle-slot';
  const identity = document.createElement('div');
  identity.className = 'pane-header-id';
  identity.append(dot, title, target, lifecycleSlot);
```

Then widen the return type and value of `buildPaneHeader`:

```ts
export function buildPaneHeader(model: PaneHeaderModel, actions: PaneHeaderActions = {}): {
  el: HTMLElement; voiceSlot: HTMLElement; lifecycleSlot: HTMLElement; update(m: PaneHeaderModel): void;
} {
```

```ts
  update(model);
  return { el, voiceSlot, lifecycleSlot, update };
```

- [ ] **Step 2: Append the DOM control to `paneLifecycle.ts`**

Add these imports at the top of `src/web/paneLifecycle.ts`, alongside the existing type import:

```ts
import { pve, type LifecycleStatus, type PveContainerState } from './proxmox';
import { createSetupJobPoller } from './setupPoller';
```

(the existing `import type { LifecycleStatus, PveContainerState } from './proxmox';` line is replaced by the value import above)

Append at the end of the file:

```ts
export interface PaneLifecycleInput { paneState: PaneState; pveState: PveContainerState | undefined }

export interface PaneLifecycleDeps {
  boxId: string;
  // jobId is null when the job never got created (the POST itself failed), so
  // the caller opens the Containers tab instead of a log that does not exist.
  onOpenJobLog: (jobId: string | null) => void;
  onSettled: () => void;
  createJob?: (spec: { boxId: string; action: PaneLifecycleAction }) => Promise<{ id: string }>;
  fetchJob?: (id: string) => Promise<{ status: LifecycleStatus; error: string | null }>;
}

const POLL_MS = 1500;
const ARM_MS = 3000;
const MAX_MISSES = 3;

export function buildPaneLifecycle(deps: PaneLifecycleDeps): {
  el: HTMLElement; update(i: PaneLifecycleInput): void; destroy(): void;
} {
  const createJob = deps.createJob ?? ((spec) => pve.createLifecycleJob(spec));
  const fetchJob = deps.fetchJob ?? ((id: string) => pve.lifecycleJob(id));

  const el = document.createElement('span');
  el.className = 'pane-lifecycle';

  let keys: LifecycleKey[] = [];
  let rendered: string | null = null; // key-set signature currently in the DOM
  let arm: ArmState = IDLE;
  let armTimer: number | null = null;
  let chip: LifecycleChip | null = null;
  let chipTitle = '';
  let chipJobId: string | null = null;
  let poller: { start: () => void; stop: () => void } | null = null;
  let misses = 0;

  const clearArmTimer = () => { if (armTimer != null) { window.clearTimeout(armTimer); armTimer = null; } };

  const disarm = () => {
    if (arm.armed == null) return;
    clearArmTimer();
    arm = armReduce(arm, { type: 'dismiss' }).state;
    paint();
  };

  // A click anywhere outside this control disarms — the "anything else" half of
  // arm-then-fire. Capture phase so it lands before the pane's own handlers.
  // A click on a sibling key is NOT outside, so it moves the arm instead.
  const onDocMouseDown = (e: MouseEvent) => { if (!el.contains(e.target as Node)) disarm(); };
  const onDocKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') disarm(); };
  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);
  // Keyboard focus leaving the control disarms. Guarded twice, because paint()
  // replaces the buttons: a focusout caused by the focused button being removed
  // reports a null relatedTarget, and treating that as "focus left" would
  // disarm the key in the very repaint that just armed it.
  el.addEventListener('focusout', (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (next == null || el.contains(next)) return;
    disarm();
  });

  function paint() {
    if (chip) {
      const span = document.createElement('span');
      span.className = `pane-chip ${chip.cls}`;
      span.textContent = chip.text;
      if (chipTitle) span.title = chipTitle;
      if (chip.settled) {
        span.setAttribute('role', 'button');
        span.tabIndex = 0;
        const open = () => { deps.onOpenJobLog(chipJobId); chip = null; chipTitle = ''; chipJobId = null; rendered = null; paint(); };
        span.addEventListener('click', (e) => { e.stopPropagation(); open(); });
        span.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      }
      el.replaceChildren(span);
      return;
    }
    el.replaceChildren(...keys.map((key) => {
      const armed = arm.armed === key.action;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `pane-life${key.danger ? ' danger' : ''}${armed ? ' armed' : ''}`;
      btn.textContent = armed ? key.armLegend! : key.glyph;
      btn.title = armed ? `Click again to ${key.action}` : key.label;
      btn.setAttribute('aria-label', armed ? `Confirm ${key.action}` : key.label);
      btn.addEventListener('click', (e) => { e.stopPropagation(); onKeyClick(key); });
      return btn;
    }));
  }

  function onKeyClick(key: LifecycleKey) {
    clearArmTimer();
    const outcome = armReduce(arm, { type: 'click', key });
    arm = outcome.state;
    if (outcome.fire) { void fire(outcome.fire); return; }
    armTimer = window.setTimeout(() => { armTimer = null; arm = armReduce(arm, { type: 'timeout' }).state; paint(); }, ARM_MS);
    paint();
    // paint() replaced the button that was just clicked; put focus on its
    // armed replacement so a keyboard user can confirm with Enter.
    el.querySelector<HTMLElement>('.pane-life.armed')?.focus();
  }

  async function fire(action: PaneLifecycleAction) {
    chip = chipFor(action, 'running');
    chipTitle = '';
    chipJobId = null;
    paint();
    let id: string;
    try {
      id = (await createJob({ boxId: deps.boxId, action })).id;
    } catch (error) {
      // The server's own guards land here: a 409 for an active job on the same
      // container, or for an action the container's real state cannot take.
      chip = chipFor(action, 'error');
      chipTitle = error instanceof Error ? error.message : 'Lifecycle action failed';
      paint();
      return;
    }
    chipJobId = id;
    misses = 0;
    poller?.stop();
    poller = createSetupJobPoller<{ status: LifecycleStatus; error: string | null }>({
      fetchJob: () => fetchJob(id),
      onJob: (job) => {
        if (!job) {
          // A rejected fetch reaches the policy as null (setupPoller's
          // contract). Transient until it isn't.
          misses += 1;
          if (misses < MAX_MISSES) return POLL_MS;
          chip = chipFor(action, 'lost');
          chipTitle = '';
          paint();
          return null;
        }
        misses = 0;
        if (job.status === 'running') return POLL_MS;
        chip = chipFor(action, job.status);
        chipTitle = job.error ?? '';
        // A finished job leaves the container in a new state; ask for a status
        // poll now rather than waiting out the 30s tick.
        if (chip == null) { chipJobId = null; rendered = null; }
        paint();
        deps.onSettled();
        return null;
      },
    });
    poller.start();
  }

  function update(i: PaneLifecycleInput) {
    const next = lifecycleKeysFor(i.paneState, i.pveState);
    const signature = next.map((k) => k.action).join(',');
    if (chip && !chip.settled) return; // an in-flight job owns the slot
    if (signature === rendered) return; // no change; a settled chip stays put
    keys = next;
    rendered = signature;
    chip = null;
    chipTitle = '';
    chipJobId = null;
    clearArmTimer();
    arm = armReduce(arm, { type: 'keysChanged' }).state;
    paint();
  }

  function destroy() {
    poller?.stop();
    poller = null;
    clearArmTimer();
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
  }

  return { el, update, destroy };
}
```

- [ ] **Step 3: Add the styles**

In `src/web/style.css`, immediately after the `.pane-header .pane-act:hover, .pane-header .pane-act:focus-visible` rule (~line 802), insert:

```css
/* Proxmox lifecycle keys: icon keys per DESIGN.md — flat legend-dim glyphs on
   small hit pads, hover raises a step and brightens, destructive hover LED red. */
.pane-lifecycle-slot, .pane-lifecycle { display: inline-flex; align-items: center; gap: 2px; }
/* .pane-header-id has an 8px gap, so an empty slot would still push the layout
   of every unlinked box's header. It must take no part at all. */
.pane-lifecycle-slot:empty { display: none; }
.pane-header .pane-life {
  font-family: var(--face); font-size: 12px; line-height: 1;
  padding: 2px 4px; border: 1px solid transparent; border-radius: 4px;
  background: none; color: var(--dim); opacity: 0.75;
  text-transform: none; letter-spacing: normal; cursor: pointer;
}
.pane-header .pane-life:hover, .pane-header .pane-life:focus-visible {
  opacity: 1; color: var(--text); background: var(--panel-2); border-color: var(--border);
}
.pane-header .pane-life.danger:hover, .pane-header .pane-life.danger:focus-visible { color: var(--crit); }
/* Armed: the key states its own consequence and waits for a second click. */
.pane-header .pane-life.armed {
  opacity: 1; font-size: 9px; font-weight: 700; letter-spacing: 0.08em; padding: 1px 6px;
  color: var(--crit); border-color: rgba(255, 92, 71, 0.55); background: rgba(255, 92, 71, 0.12);
}
.pane-chip.chip-error { color: var(--crit); border-color: rgba(255, 92, 71, 0.5); background: rgba(255, 92, 71, 0.1); cursor: pointer; }
```

- [ ] **Step 4: Typecheck and run the suite**

Run: `npm run typecheck && npm test`
Expected: both clean. Task 1's tests still pass — the pure core is untouched.

- [ ] **Step 5: Build to confirm the bundle compiles**

Run: `npm run build`
Expected: `vite build` completes, `dist/` written.

- [ ] **Step 6: Commit**

```bash
git add src/web/paneLifecycle.ts src/web/paneHeader.ts src/web/style.css
git commit -m "feat(ui): lifecycle control part and its pane-header mount point"
```

---

### Task 3: Wire it into the stage and the Proxmox hub

Build one control per Proxmox-linked pane, feed it every status poll, tear it down with its pane, and give the settled error chip somewhere to click through to.

**Files:**
- Modify: `src/web/proxmoxUi.ts:24` (HubInitial), `:65` (initial render)
- Modify: `src/web/main.ts` — imports (~line 17-32), `updatePaneHeaders` (~705), `headerFor` (~712-738), `repaintStage` (~760), logout teardown (~845-851)

**Interfaces:**
- Consumes: `buildPaneLifecycle` and `PaneLifecycleInput` from Task 2; `buildPaneHeader(...).lifecycleSlot` from Task 2.
- Produces: nothing further — this is the last task.

- [ ] **Step 1: Let the hub open straight to a lifecycle job**

In `src/web/proxmoxUi.ts`, line 24:

```ts
type HubInitial = { tab?: Tab; focusBoxId?: string };
```

becomes:

```ts
type HubInitial = { tab?: Tab; focusBoxId?: string; lifecycleJobId?: string };
```

And line 65, currently:

```ts
  selectTab(active);
```

becomes:

```ts
  // Opening straight to a job's log replaces the initial tab render rather than
  // racing it: renderers are async and would clobber the log when they resolve.
  if (initial.lifecycleJobId) {
    active = 'Activity';
    syncTabSelection(tabStrip, active);
    showLifecycleJob(initial.lifecycleJobId);
  } else {
    selectTab(active);
  }
```

(`showLifecycleJob` is a hoisted function declaration further down the same closure, so this call is valid where it sits.)

- [ ] **Step 2: Import the control in `main.ts`**

Next to the existing `import { buildPaneHeader, type PaneHeaderModel } from './paneHeader';` line, add:

```ts
import { buildPaneLifecycle } from './paneLifecycle';
```

And next to `const paneHeaders = new Map<string, (m: PaneHeaderModel) => void>();` (line 32), add:

```ts
// Lifecycle controls live alongside the header updaters and share their
// lifetime: each owns a poll loop and an arm timer, so an orphan would keep
// running after its pane's DOM died. Destroyed in repaintStage and on logout.
const paneLifecycles = new Map<string, ReturnType<typeof buildPaneLifecycle>>();
```

- [ ] **Step 3: Feed them on every status poll**

`updatePaneHeaders` (line 705) currently reads:

```ts
function updatePaneHeaders() {
  for (const [id, update] of paneHeaders) update(paneHeaderModelFor(id));
}
```

Replace with:

```ts
function updatePaneHeaders() {
  for (const [id, update] of paneHeaders) update(paneHeaderModelFor(id));
  for (const [id, ctl] of paneLifecycles) ctl.update({ paneState: paneState(id), pveState: latestStatus[id]?.proxmoxState });
}
```

- [ ] **Step 4: Mount one per Proxmox-linked pane**

In `paneHooks().headerFor`, the block currently ending:

```ts
      if (terminalPane) {
        ensureTab(id);
        built.voiceSlot.append(tabs.get(id)!.voiceMount);
      }
      paneHeaders.set(id, built.update);
      return built.el;
```

becomes:

```ts
      if (terminalPane) {
        ensureTab(id);
        built.voiceSlot.append(tabs.get(id)!.voiceMount);
      }
      paneHeaders.set(id, built.update);
      // Proxmox-linked boxes only: the local shell has no container, and an
      // unlinked box has nothing for these keys to act on.
      const linked = allBoxes.find((b) => b.id === id)?.proxmox;
      if (id !== '__local__' && linked) {
        const ctl = buildPaneLifecycle({
          boxId: id,
          onOpenJobLog: (jobId) => openProxmoxHub({
            openBox,
            openEditBox: (boxId) => { const target = allBoxes.find((item) => item.id === boxId); if (target) openBoxDialog(target); },
            onBoxLinked: () => { void refresh(); },
          }, jobId ? { lifecycleJobId: jobId } : { tab: 'Containers', focusBoxId: id }),
          onSettled: () => { void pollStatus(); },
        });
        ctl.update({ paneState: paneState(id), pveState: latestStatus[id]?.proxmoxState });
        built.lifecycleSlot.append(ctl.el);
        paneLifecycles.set(id, ctl);
      }
      return built.el;
```

- [ ] **Step 5: Tear them down with their panes**

Add a helper next to `repaintStage`, just above it:

```ts
function destroyPaneLifecycles() {
  for (const [, ctl] of paneLifecycles) ctl.destroy();
  paneLifecycles.clear();
}
```

In `repaintStage`, line 760 currently reads:

```ts
  paneHeaders.clear(); // stale update closures die with their DOM; headerFor re-registers survivors
```

Replace with:

```ts
  paneHeaders.clear(); // stale update closures die with their DOM; headerFor re-registers survivors
  destroyPaneLifecycles(); // their pollers and arm timers would outlive the DOM otherwise
```

And in the logout handler, immediately after `tabs.clear();` (~line 846), add:

```ts
    destroyPaneLifecycles(); // #app is about to be replaced; nothing repaints the stage on this path
```

- [ ] **Step 6: Typecheck, test, build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all clean.

- [ ] **Step 7: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS. The split e2e exercises the pane header DOM; the boxes it creates are not Proxmox-linked, so no lifecycle keys render and the header must look exactly as it did before this change. A failure here means the empty slot is affecting layout.

- [ ] **Step 8: Commit**

```bash
git add src/web/main.ts src/web/proxmoxUi.ts
git commit -m "feat(ui): Proxmox lifecycle controls in the pane header"
```

- [ ] **Step 9: Validate on the live app before merging**

Per `CLAUDE.md`, features are validated on the live app before they merge, and a restart waits until no setup/provision/lifecycle/fleet/voice-install job is `running`:

```bash
npm run build
rsync -a --delete dist/ /root/tmuxifier/dist/   # only if working from a separate worktree
sudo systemctl restart tmuxifier
systemctl status tmuxifier
```

Then, in the browser, on a pane for a Proxmox-linked box, confirm:
- the keys sit between `user@host` and the right-hand cluster, and an unlinked box's header is unchanged
- one click on `⏻` shows a red `SHUTDOWN?` legend; waiting ~3s, pressing Escape, or clicking elsewhere all return it to the glyph
- a second click fires: the chip reads `shutting down…`, and the pane flips to its stopped panel with a `▶` key shortly after the job finishes
- `▶` starts it again and the pane returns to a terminal
- an action refused by the server (fire one while another is still running) shows a red chip whose click opens the hub's job log

---

## Self-review notes

- **Spec coverage:** key table → Task 1 `lifecycleKeysFor` + tests; arm-then-fire → Task 1 `armReduce` + Task 2's timer/blur/Escape/foreign-click wiring; firing and chip → Task 2 `fire` and the poller policy; update discipline → Task 2 `update`; module list → Tasks 2 and 3 (`paneLifecycle.ts`, `paneHeader.ts`, `main.ts`, `proxmoxUi.ts`, `style.css`); testing section → Task 1's test file; out-of-scope items are absent from every task, and Task 1 has an explicit test that deprovision is never offered.
- **Server-side guards** (`assertTargetIdle`, `REQUIRED[action]`) need no client change — they arrive as rejected promises from `createLifecycleJob` and land in the red chip with their message as the title. Covered in Task 2's `fire`.
- **Naming consistency:** `lifecycleKeysFor` / `armReduce` / `chipFor` / `IDLE` / `buildPaneLifecycle` / `lifecycleSlot` / `paneLifecycles` / `destroyPaneLifecycles` are used identically across all three tasks.
