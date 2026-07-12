# Configuration-gated Proxmox/NetBox UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide Proxmox/NetBox-dependent UI when the integration behind it is unconfigured, and reject auto-static provisions at request time when NetBox is missing.

**Architecture:** Three independent gates, per the spec (`docs/superpowers/specs/2026-07-12-config-gated-proxmox-netbox-ui-design.md`): a server-side fail-fast in `createProvision`, and two client-side hide decisions extracted as exported pure helpers (node-env vitest can't drive the DOM, so the decision logic is tested and the DOM wiring stays one line).

**Tech Stack:** Node 20 ESM server (`.js`), TypeScript web client, vitest (node environment), real code in tests (no mocks — injected fakes only).

## Global Constraints

- Public repo: no real domains/IPs/hostnames/emails in committed code — placeholders only (`example.com`, RFC1918 like `192.168.1.10`).
- Tests use real code with injected fakes; never module mocks.
- Server stays plain `.js`; web client `.ts`; `npm test` runs typecheck + vitest.
- Commit only with owner approval (autonomous-session harness rule).

---

### Task 1: Server fail-fast — auto-static provision rejected without NetBox

**Files:**
- Modify: `src/server/proxmoxProvision.js:160-167` (inside `createProvision`)
- Test: `test/proxmoxProvision.test.js` (append after the last test)

**Interfaces:**
- Consumes: existing `requireNetboxSettings()` (module-scope helper, `src/server/proxmoxProvision.js:34`) and existing fixtures `PRESET_AUTO`, `makeStore`, `okClient`, `base` in the test file.
- Produces: `POST /api/proxmox/provisions` now 400s (route's existing catch) for auto-static presets when NetBox is unconfigured; no job is created.

- [x] **Step 1: Write the failing test**

Append to `test/proxmoxProvision.test.js`:

```js
// Fail fast: an auto-static preset is rejected at createProvision time when
// NetBox is not configured — no job may be created or persisted. The
// allocate-ip phase check stays as a backstop for settings cleared mid-job.
test('auto-static without NetBox settings rejects before a job exists', async () => {
  const saves = [];
  const m = createProvisionManager(base({
    proxmoxStore: makeStore(PRESET_AUTO), makeClient: () => okClient(),
    save: (list) => saves.push(list),
  }));
  await expect(m.createProvision({ presetId: 'p3', hostname: 'dev-01' }))
    .rejects.toThrow(/auto-static requires the NetBox integration/);
  expect(m.listProvisions()).toEqual([]);
  expect(saves.flat()).toEqual([]); // nothing persisted either
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/proxmoxProvision.test.js`
Expected: FAIL — the promise resolves (job created) instead of rejecting, and/or `listProvisions()` returns one running job.

- [x] **Step 3: Write minimal implementation**

In `src/server/proxmoxProvision.js`, inside `createProvision`, directly after the `if (!preset) throw new Error('preset not found');` line:

```js
      // Fail fast: reject at request time (HTTP 400, no job record) instead of
      // erroring later in the allocate-ip phase of a job that already exists.
      if (preset.net.ipMode === 'auto-static') await requireNetboxSettings();
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/proxmoxProvision.test.js`
Expected: PASS (all tests — existing auto-static tests inject `netboxStore: nbStore`, so the guard passes for them).

### Task 2: Hide the box-modal Proxmox association section when no hosts exist

**Files:**
- Modify: `src/web/proxmoxAssociation.ts` (new export + gating in `createProxmoxAssociationEditor`)
- Test: `test/proxmoxAssociation.test.js` (append)

**Interfaces:**
- Consumes: existing `pve.hosts()` from `src/web/proxmox.ts`.
- Produces: `export function associationSectionVisible(hostCount: number, linked: boolean): boolean`. No `main.ts` change — the editor's `element` is already the only Proxmox surface in the Add/Edit Box modals.

- [x] **Step 1: Write the failing test**

Append to `test/proxmoxAssociation.test.js` and extend its import line:

```js
import { associationMutation, associationSectionVisible } from '../src/web/proxmoxAssociation.ts';

test('association section hides only for unlinked boxes with no Proxmox hosts', () => {
  expect(associationSectionVisible(0, false)).toBe(false);
  expect(associationSectionVisible(1, false)).toBe(true);
  expect(associationSectionVisible(0, true)).toBe(true); // a stale link must stay visible to unlink
  expect(associationSectionVisible(2, true)).toBe(true);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/proxmoxAssociation.test.js`
Expected: FAIL with `associationSectionVisible` not exported / not a function.

- [x] **Step 3: Write minimal implementation**

In `src/web/proxmoxAssociation.ts`, after `associationMutation`:

```ts
// Linked boxes always show the section (a stale link must stay visible so it
// can be unlinked); unlinked boxes only see it once a host profile exists.
export function associationSectionVisible(hostCount: number, linked: boolean) {
  return linked || hostCount > 0;
}
```

And in `createProxmoxAssociationEditor`, replace the bare `renderSummary();` call before the `return` with:

```ts
  renderSummary();
  // With no hosts and no link the picker could only error — hide the whole
  // section. A fetch failure keeps it hidden (same "never show a dead
  // button" rule as the sidebar Proxmox button in main.ts).
  if (!current) {
    section.hidden = true;
    void pve.hosts()
      .then((hosts) => { section.hidden = !associationSectionVisible(hosts.length, false); })
      .catch(() => {});
  }
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/proxmoxAssociation.test.js`
Expected: PASS (5 tests).

### Task 3: Hide the auto-static ipMode option when NetBox is unconfigured

**Files:**
- Modify: `src/web/proxmoxPresets.ts` (new export + option removal in the existing `nbx.get()` handler)
- Test: Create `test/proxmoxPresets.test.js`

**Interfaces:**
- Consumes: the existing `void nbx.get().then(...)` handler in `renderDetail` (`src/web/proxmoxPresets.ts:159`) and its `netboxConfigured` local.
- Produces: `export function allowAutoStatic(netboxConfigured: boolean, currentMode: string): boolean`.

- [x] **Step 1: Write the failing test**

Create `test/proxmoxPresets.test.js`:

```js
import { test, expect } from 'vitest';
import { allowAutoStatic } from '../src/web/proxmoxPresets.ts';

test('auto-static is offered only when NetBox is configured or already selected', () => {
  expect(allowAutoStatic(true, 'dhcp')).toBe(true);
  expect(allowAutoStatic(true, 'auto-static')).toBe(true);
  expect(allowAutoStatic(false, 'dhcp')).toBe(false);
  expect(allowAutoStatic(false, 'static')).toBe(false);
  // Removing a selected option would silently rewrite the preset's saved mode.
  expect(allowAutoStatic(false, 'auto-static')).toBe(true);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/proxmoxPresets.test.js`
Expected: FAIL with `allowAutoStatic` not exported. (If the import itself throws on a DOM global, the helper moves to a new pure module `src/web/proxmoxPresetRules.ts` instead — module top-level currently touches no DOM, so this is not expected.)

- [x] **Step 3: Write minimal implementation**

In `src/web/proxmoxPresets.ts`, as a top-level export near the other exports:

```ts
// The auto-static option stays when NetBox is configured or when it is
// already the current value (removing a selected option would silently
// rewrite the preset's saved mode on the next save).
export function allowAutoStatic(netboxConfigured: boolean, currentMode: string) {
  return netboxConfigured || currentMode === 'auto-static';
}
```

Replace the existing settings fetch line

```ts
    void nbx.get().then(({ settings }) => { netboxConfigured = !!settings; syncNetwork(); }).catch(() => {});
```

with:

```ts
    void nbx.get().then(({ settings }) => {
      netboxConfigured = !!settings;
      // Gate fails open on fetch errors (option kept): the server guard in
      // createProvision is the real gate; hiding on a blip would mask a
      // configured capability.
      if (!allowAutoStatic(netboxConfigured, ipMode.value)) {
        ipMode.querySelector('option[value="auto-static"]')?.remove();
      }
      syncNetwork();
    }).catch(() => {});
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/proxmoxPresets.test.js`
Expected: PASS.

### Task 4: Full verification, docs, and (owner-gated) commit

**Files:**
- Modify: `CLAUDE.md` + `AGENTS.md` (web-client module list: `proxmoxAssociation.ts` / `proxmoxPresets.ts` descriptions), `README.md` (NetBox auto-static section)

**Interfaces:**
- Consumes: everything above. Produces: nothing new.

- [x] **Step 1: Update docs**

In `CLAUDE.md`/`AGENTS.md`, extend the module descriptions: `proxmoxPresets.ts` gains "(the auto-static IP mode is hidden until NetBox is configured)" and `proxmoxAssociation.ts` gains "(hidden until a Proxmox host profile exists)". In `README.md`'s NetBox/auto-static docs, add that the auto-static option only appears once NetBox is configured, and that provisioning an existing auto-static preset without NetBox fails immediately with a clear error instead of starting a job.

- [x] **Step 2: Run the full suite**

Run: `npm test`
Expected: typecheck clean; all vitest files pass (679+ tests).

- [x] **Step 3: Commit (owner approval required — harness rule: commit only when asked)**

```bash
git add -A
git diff --cached   # PII scrub
git commit -m "feat(ui): hide Proxmox/NetBox features until the integration is configured"
```

## Execution deviations

- Task 1 surfaced a pre-existing test (`unconfigured NetBox fails fast with the settings-modal
  message`) that asserted the old job-level failure; it was rewritten to assert the request-time
  rejection (netboxStore present, settings null — a distinct path from the plan's no-store test),
  and a new backstop test was added proving the allocate-ip phase still errors when settings are
  cleared *after* the request is accepted. Suite: 681 tests across 61 files, all green.

## Self-review

- Spec coverage: goal 1 → Task 2; goal 2 → Task 3; goal 3 → Task 1; error-handling section (fail-closed section vs fail-open option) encoded in Tasks 2/3 code comments; testing section → each task's Step 1. No gaps.
- Placeholder scan: none; every code step carries the full code.
- Type consistency: `associationSectionVisible(hostCount: number, linked: boolean)` and `allowAutoStatic(netboxConfigured: boolean, currentMode: string)` match between test imports and implementations; `PRESET_AUTO`/`base`/`makeStore` exist in the current test file at the cited shapes.
