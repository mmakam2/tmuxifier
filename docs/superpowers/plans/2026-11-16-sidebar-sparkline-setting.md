# Sidebar Sparkline Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidebar box-row sparkline optional behind a Settings → Appearance checkbox that is off by default and stored server-side.

**Architecture:** A boolean `sidebarSpark` joins `theme` and `clawdAnim` in `data/ui-settings.json`. A tiny web module (`sidebarSpark.ts`) holds the flag and a change listener; `main.ts` reads it at boot and repaints on change, `settingsAppearance.ts` flips it. Off means `applySparkline` empties the span (the existing `.spark:empty { display: none }` collapses it) and the `spark-*` tint class is not applied. The health series fetch is untouched.

**Tech Stack:** Node ESM (server, plain `.js`), TypeScript + Vite (web), vitest (no DOM), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-11-16-sidebar-sparkline-setting-design.md` (issue #12)

## Global Constraints

- Setting name is `sidebarSpark` (boolean). Off unless strictly `true`: unset, `null`, corrupt file and wrong-typed stored values all read as `false`.
- `PATCH /api/ui-settings` accepts a boolean for `sidebarSpark`, and `null` (resets to `false`); anything else is rejected with the existing 400 (`invalid sidebarSpark`). Omitted key keeps the stored value.
- `theme` and `clawdAnim` behavior is unchanged: slug-validated, `null` = never set.
- Do not touch `pollHealth`, `/api/health/series` or `latestSeries`: the agent badges, attention strip, pane chips, switcher and dashboard read them.
- Do not touch the stored metric (`tmuxifier.sparkMetric`): turning the graph back on resumes on the same metric.
- Every web fetch goes through `http.ts`; the PATCH uses the existing `api.patchUiSettings`.
- Web tests are node-only vitest (no DOM): logic goes in the pure module, DOM behavior is proven by Playwright.
- The e2e server is shared by every spec (`workers: 1`) and `ui-settings.json` is server-global: any e2e that turns the setting on must hand it back to `false`.
- No real hostnames, IPs or emails in any committed file; the repo is public.
- Run all work in a **worktree** and never `npm run build` in the main checkout (it blanks the live app). Stage files by explicit path, never `git add -A` (a `node_modules` symlink in a worktree destroys the real directory on merge).
- Commits: conventional style, ending with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- A stored `sidebarSpark` of `"true"` (string), `1`, or `{}` in a hand-edited `ui-settings.json` must read as off, not on.
- `PATCH` with `{ sidebarSpark: "yes" }` must 400 and store nothing; `{ theme: 'x' }` alone must not reset `sidebarSpark`.
- Toggling the checkbox off while the list shows a `spark-mem` tint must remove the tint, and toggling on must restore the tint for the stored metric.
- A reload with the setting on must paint the graph on first render, not after the next poll (no flash of the off state).
- Phone width: the off state must still be `display: none` (the phone `.spark { padding }` rule must not revive it).

---

## Setup (once, before Task 1)

- [ ] **Step 1: Create the worktree from the current HEAD**

```bash
cd /root/tmuxifier
git worktree add .claude/worktrees/sidebar-spark -b feat/sidebar-spark HEAD
ln -s /root/tmuxifier/node_modules .claude/worktrees/sidebar-spark/node_modules
```

Do not commit the `node_modules` symlink (it is gitignored; confirm with `git status` in the worktree).

- [ ] **Step 2: Carry the two untracked docs into the worktree**

```bash
cp docs/superpowers/specs/2026-11-16-sidebar-sparkline-setting-design.md .claude/worktrees/sidebar-spark/docs/superpowers/specs/
cp docs/superpowers/plans/2026-11-16-sidebar-sparkline-setting.md .claude/worktrees/sidebar-spark/docs/superpowers/plans/
```

They are committed with Task 1. All later paths are relative to the worktree root.

---

### Task 1: Server — `sidebarSpark` in the ui-settings store and route

**Files:**
- Modify: `src/server/uiSettingsStore.js`
- Modify: `src/server/server.js:2011-2013` (comment only)
- Test: `test/uiSettingsStore.test.js`, `test/uiSettingsRoutes.test.js`

**Interfaces:**
- Produces: `store.read()` now returns `{ theme, clawdAnim, sidebarSpark }` with `sidebarSpark: boolean` (never `null`). `store.update(patch)` accepts `sidebarSpark: boolean | null`; throws `Error('invalid sidebarSpark: <value>')` otherwise. The route needs no change (it already maps a thrown error to 400 `{ error }`).

- [ ] **Step 1: Update the existing assertions and add the failing tests**

In `test/uiSettingsStore.test.js`, every `toEqual({ theme: …, clawdAnim: … })` gains `sidebarSpark: false`. Add:

```js
test('sidebarSpark defaults to false and round-trips a boolean', async () => {
  expect((await store.read()).sidebarSpark).toBe(false);
  await store.update({ sidebarSpark: true });
  expect((await store.read()).sidebarSpark).toBe(true);
  await store.update({ theme: 'original' }); // omitted key keeps the stored value
  expect((await store.read()).sidebarSpark).toBe(true);
  await store.update({ sidebarSpark: null }); // null resets to off
  expect((await store.read()).sidebarSpark).toBe(false);
});

test('sidebarSpark rejects non-booleans and stores nothing', async () => {
  await store.update({ sidebarSpark: true });
  for (const bad of ['true', 'yes', 1, 0, {}, []]) {
    await expect(store.update({ sidebarSpark: bad })).rejects.toThrow(/invalid sidebarSpark/);
  }
  expect((await store.read()).sidebarSpark).toBe(true);
});

test('only a literal true in the file reads as on', async () => {
  for (const stored of ['true', 1, {}, null]) {
    await fs.writeFile(path.join(dir, 'ui-settings.json'), JSON.stringify({ sidebarSpark: stored }));
    expect((await store.read()).sidebarSpark).toBe(false);
  }
  await fs.writeFile(path.join(dir, 'ui-settings.json'), JSON.stringify({ sidebarSpark: true }));
  expect((await store.read()).sidebarSpark).toBe(true);
});
```

In `test/uiSettingsRoutes.test.js`, update the four `toEqual` objects to include `sidebarSpark: false` (or `true` where a test set it) and add:

```js
test('PATCH sidebarSpark persists a boolean and 400s anything else', async () => {
  const h = await headers();
  const on = await app.inject({ method: 'PATCH', url: '/api/ui-settings', headers: h, payload: { sidebarSpark: true } });
  expect(on.statusCode).toBe(200);
  expect(on.json().sidebarSpark).toBe(true);
  const bad = await app.inject({ method: 'PATCH', url: '/api/ui-settings', headers: h, payload: { sidebarSpark: 'yes' } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toMatch(/invalid sidebarSpark/);
  expect((await app.inject({ method: 'GET', url: '/api/ui-settings', headers: h })).json().sidebarSpark).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/uiSettingsStore.test.js test/uiSettingsRoutes.test.js`
Expected: FAIL (`sidebarSpark` is `undefined` in every `read()`).

- [ ] **Step 3: Implement in `src/server/uiSettingsStore.js`**

Add `const BOOL_KEYS = ['sidebarSpark'];` beside `KEYS`. In `normalize`, set `out[k] = o[k] === true` for each `BOOL_KEYS` entry. In `update`, handle `BOOL_KEYS` in a second loop: skip when absent from `patch`, `null` → `false`, a non-boolean throws `invalid ${k}: ${String(v).slice(0, 40)}`, else assign. Extend the file's header comment: the server is still catalog-agnostic for slugs, and `sidebarSpark` is the one boolean (off unless strictly `true`, never `null`). Update the comment at `server.js:2011-2013` to say "theme, clawd animation, sidebar sparkline".

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/uiSettingsStore.test.js test/uiSettingsRoutes.test.js`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-11-16-sidebar-sparkline-setting-design.md docs/superpowers/plans/2026-11-16-sidebar-sparkline-setting.md src/server/uiSettingsStore.js src/server/server.js test/uiSettingsStore.test.js test/uiSettingsRoutes.test.js
git commit -m "feat(settings): sidebarSpark boolean in ui-settings (off by default)"
```

---

### Task 2: Web — the flag module and the `UiSettings` type

**Files:**
- Create: `src/web/sidebarSpark.ts`
- Modify: `src/web/api.ts:7` (the `UiSettings` interface)
- Test: `test/sidebarSpark.test.js`

**Interfaces:**
- Produces, all exported from `src/web/sidebarSpark.ts`:
  - `type SparkMetric = 'cpuPct' | 'memPct' | 'diskPct'`
  - `sidebarSparkOn(): boolean` — current flag, `false` until set.
  - `setSidebarSpark(on: boolean): void` — stores it; calls every listener only when the value changed.
  - `onSidebarSparkChange(cb: () => void): () => void` — subscribe; returns an unsubscribe function.
  - `sparkListClass(on: boolean, metric: SparkMetric): 'spark-cpu' | 'spark-mem' | 'spark-disk' | null` — `null` when `on` is false.
- Produces: `UiSettings` in `api.ts` gains `sidebarSpark: boolean`.

- [ ] **Step 1: Write the failing test `test/sidebarSpark.test.js`** (import from `../src/web/sidebarSpark.ts`, as `sparkline.test.js` does)

```js
import { test, expect, beforeEach } from 'vitest';
import { sidebarSparkOn, setSidebarSpark, onSidebarSparkChange, sparkListClass } from '../src/web/sidebarSpark.ts';

beforeEach(() => setSidebarSpark(false)); // module state is shared across tests

test('is off until set', () => {
  expect(sidebarSparkOn()).toBe(false);
  setSidebarSpark(true);
  expect(sidebarSparkOn()).toBe(true);
});

test('listeners fire once per change, not on a repeat value, and can unsubscribe', () => {
  let n = 0;
  const off = onSidebarSparkChange(() => { n += 1; });
  setSidebarSpark(true);
  setSidebarSpark(true);
  expect(n).toBe(1);
  setSidebarSpark(false);
  expect(n).toBe(2);
  off();
  setSidebarSpark(true);
  expect(n).toBe(2);
});

test('the list tint class names the metric, and is absent while off', () => {
  expect(sparkListClass(true, 'cpuPct')).toBe('spark-cpu');
  expect(sparkListClass(true, 'memPct')).toBe('spark-mem');
  expect(sparkListClass(true, 'diskPct')).toBe('spark-disk');
  for (const m of ['cpuPct', 'memPct', 'diskPct']) expect(sparkListClass(false, m)).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/sidebarSpark.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/web/sidebarSpark.ts` and the type change**

Module-level `let on = false` plus a `Set<() => void>` of listeners; the four exports above. A header comment states why it is its own module (`settingsAppearance.ts` cannot import `main.ts`) and that the server owns the value (`data/ui-settings.json`, loaded by `main.ts` `loadUiSettings`). In `api.ts` change line 7 to `export interface UiSettings { theme: string | null; clawdAnim: string | null; sidebarSpark: boolean }`.

- [ ] **Step 4: Run test and typecheck**

Run: `npx vitest run test/sidebarSpark.test.js && npm run typecheck`
Expected: test PASS, `tsc` clean (nothing else builds a `UiSettings` literal).

- [ ] **Step 5: Commit**

```bash
git add src/web/sidebarSpark.ts src/web/api.ts test/sidebarSpark.test.js
git commit -m "feat(ui): sidebarSpark flag module with change listener and tint-class helper"
```

---

### Task 3: Web — wire `main.ts`, add the Appearance checkbox, prove it in Playwright

**Files:**
- Modify: `src/web/main.ts` (the `SparkMetric` type at ~118, `syncSparkMetricClass` ~162, `applySparkline` ~299, `loadUiSettings` ~526)
- Modify: `src/web/settingsAppearance.ts`
- Modify: `test/e2e/health.spec.ts`
- Create: `test/e2e/sidebarSpark.spec.ts`

**Interfaces:**
- Consumes: everything Task 2 produces; `api.uiSettings()` now returns `sidebarSpark`.
- Produces: the user-visible behavior; no new exports.

- [ ] **Step 1: Write the failing e2e `test/e2e/sidebarSpark.spec.ts`**

Copy `login(page)` from `theme.spec.ts`. Add a `test.afterEach` that re-logs-in via `page.request.post('/api/login', { data: { password: 'e2e' } })` and `PATCH`es `{ sidebarSpark: false }`, silent on failure (the `theme.spec.ts` pattern). Helper `setSparkFromUi(page, on)`: click `#settings`, click `.pve-tabs button:has-text("Appearance")`, `waitForResponse` for a successful `PATCH /api/ui-settings`, set the checkbox `.appearance-row:has-text("usage graph") input[type="checkbox"]` to `on`, await the response, press `Escape`. Tests:

1. **`default is off: no graph, no gap, percentages stay`** — after login: `GET /api/ui-settings` has `sidebarSpark === false`; `.box .spark-svg` count is 0; `#boxes` does not match `/spark-(cpu|mem|disk)/`; `.box .spark` first element is hidden and its computed `display` is `none`; `.box-meta .metric-cpu` first is visible (timeout 15000).
2. **`the checkbox applies live, persists across reload, and turns off again`** — `setSparkFromUi(page, true)`; `#boxes` has class `/spark-cpu/` immediately (the stored metric is cpu in a fresh context); `.spark .spark-svg path` first has attribute `d` matching `/M/` (timeout 30000, the series needs two samples); click that graph, `#boxes` is `/spark-mem/`, click twice more to return to cpu; reload, wait for the localhost row, and `.spark .spark-svg` is visible again (first paint with the setting on; use `toPass` with a reload loop as `health.spec.ts` does, since the series needs samples); `setSparkFromUi(page, false)`; `.box .spark-svg` count is 0 and `#boxes` has no `spark-*` class with no reload; reload and the count is still 0.
3. **`phone width keeps the off state collapsed`** — `page.setViewportSize({ width: 390, height: 844 })`, then `page.evaluate(() => getComputedStyle(document.querySelector('.box .spark')).display)` is `'none'`.

In `test/e2e/health.spec.ts`, after `await login(page)` add `await page.request.patch('/api/ui-settings', { data: { sidebarSpark: true } });`, and add the same silent best-effort `test.afterEach` restoring `{ sidebarSpark: false }` (re-login first, as `theme.spec.ts` does).

- [ ] **Step 2: Build in the worktree and run to verify it fails**

Run: `npm run build && npx playwright test test/e2e/sidebarSpark.spec.ts --project=desktop`
Expected: test 1 FAILS (the graph still renders by default; no checkbox exists). Do this only in the worktree.

- [ ] **Step 3: Implement the wiring**

- `main.ts`: delete the local `type SparkMetric` line and `import { sidebarSparkOn, setSidebarSpark, onSidebarSparkChange, sparkListClass, type SparkMetric } from './sidebarSpark'`.
- `applySparkline`: compute `const d = sidebarSparkOn() ? sparkline(latestSeries[id] || [], metric) : '';` so the existing empty-path branch (clears children, `title`, `aria-label`) handles the off case.
- `syncSparkMetricClass`: remove the three `spark-*` classes as today, then `const c = sparkListClass(sidebarSparkOn(), sparkMetric()); if (c) list.classList.add(c);`.
- Register once at module scope, beside the other module-level setup: `onSidebarSparkChange(() => { syncSparkMetricClass(); repaintSparklines(); });`.
- `loadUiSettings`: first line inside the `try` after `const st = …`: `setSidebarSpark(st.sidebarSpark === true);` (runs before `renderDashboard()` on every path into the workspace, so the first paint is right). On a failed read nothing is set and the flag stays off.
- `settingsAppearance.ts`: widen `save`'s patch type to `Partial<UiSettings>` (import the type from `./api`). Add, between the animation rows and the save note, an eyebrow `Sidebar` and one `label.check-field.appearance-row` containing a checkbox (`checked = sidebarSparkOn()`), the label text `Show the usage graph on box rows`, and a description span: `A small CPU / memory / disk trend under each box's name; click it to switch metric. The percentages in the meta line stay either way.` Its `onchange` calls `setSidebarSpark(box.checked)` then `save({ sidebarSpark: box.checked })`. Update the closing help paragraph only if it now misleads (it mentions only theme and animation).

- [ ] **Step 4: Rebuild and run the e2e and the unit suite**

Run: `npm run build && npx playwright test test/e2e/sidebarSpark.spec.ts test/e2e/health.spec.ts test/e2e/theme.spec.ts --project=desktop && npm test`
Expected: all PASS. `theme.spec.ts` is included because it shares `ui-settings.json`; `npm test` runs `typecheck` plus every vitest file.

- [ ] **Step 5: Commit**

```bash
git add src/web/main.ts src/web/settingsAppearance.ts test/e2e/sidebarSpark.spec.ts test/e2e/health.spec.ts
git commit -m "feat(ui): Settings → Appearance checkbox hides the sidebar sparkline (off by default)"
```

---

### Task 4: Docs

**Files:**
- Modify: `docs/fleet-and-health.md:55-58` and the `## Appearance` section (~174-181)
- Modify: `docs/configuration.md:128-129`
- Modify: `CLAUDE.md`, `AGENTS.md` (same edits in both)

**Interfaces:** none.

- [ ] **Step 1: Edit the docs**

- `fleet-and-health.md` health section: the sentence "Each box row shows a small sparkline of the last ~hour (click it to cycle CPU → memory → disk)" becomes "Each box row can show a small sparkline of the last ~hour (off by default; turn it on in **Settings → Appearance**, then click it to cycle CPU → memory → disk). The CPU/memory/disk figures in the row's meta line are always shown."
- `fleet-and-health.md` `## Appearance`: "holds the two looks-only preferences" becomes "holds the looks-only preferences: the **theme**, the working-agent animation described above, and whether box rows show the usage graph". Add one sentence that the graph checkbox is off by default and, like the others, is saved in `data/ui-settings.json`.
- `configuration.md`: extend the Appearance parenthesis to "(the theme, the working-agent animation and the sidebar usage graph, all saved on the Tmuxifier host so every browser follows)".
- `CLAUDE.md` and `AGENTS.md`: in the `uiSettingsStore.js` entry, change "Catalog-agnostic: validates slug shape only; the client normalizes unknown ids. `null` = never set. Fails open." to also say the one boolean `sidebarSpark` is off unless strictly `true` (never `null`); in the web **Dashboard** bullet that lists `sparkline.ts`, add "`sidebarSpark.ts` (the Appearance flag and tint-class helper; off hides the graph and the `spark-*` tint)"; in the `data/` table add nothing (`ui-settings.json` already says "theme + working-agent animation": append "+ sidebar graph flag").

- [ ] **Step 2: Verify nothing else still says the graph is always on**

Run: `grep -rn -i "sparkline" README.md docs/dashboard.md docs/fleet-and-health.md docs/configuration.md PRODUCT.md DESIGN.md | grep -v superpowers`
Expected: no remaining statement that every row always shows a sparkline (`docs/dashboard.md:41` only says the phone sizes sparklines up, which stays true when on; leave it).

- [ ] **Step 3: Commit**

```bash
git add docs/fleet-and-health.md docs/configuration.md CLAUDE.md AGENTS.md
git commit -m "docs: sidebar sparkline is optional and off by default"
```

---

## Live validation and release (after Task 4, not part of the tasks)

Follow `CLAUDE.md` → Shipping: the feature is validated on the live app before it merges. Another Claude session may share the one `dist/` and service (see `ListAgents`); message it and hold for its "clear" before swapping `dist/` or restarting, and wait until no setup/provision/lifecycle/fleet/voice-install/apk-build job is `running`. Live check: the checkbox is off, rows are compact with percentages intact; turning it on shows the graph and click-to-cycle; reload keeps the choice; the phone drawer rows match. Then merge, `npm version patch`, and run the release checklist.
