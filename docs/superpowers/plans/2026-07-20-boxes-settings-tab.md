# Settings → Boxes tab (box export/import relocation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the box-list export (`⤓`) and import (`⤒`) buttons out of the sidebar brand actions into a new **Boxes** tab in the settings modal.

**Architecture:** A new client module `src/web/settingsBoxes.ts` renders the tab, following the same `render(content)` shape as the existing settings sections. It reaches the dashboard's box list only through a `window` event (`tmuxifier:boxes-changed`) that `main.ts` listens for — the same decoupling `settingsNotifications.ts` already uses for `tmuxifier:notify-prefs-changed`. No server change: `GET /api/export` and `POST /api/import` are untouched.

**Tech Stack:** TypeScript client bundled by Vite, `el()`/`openModal()` DOM builders from `src/web/dom.ts`, vitest for unit tests, `tsc --noEmit` for typechecking.

**Spec:** `docs/superpowers/specs/2026-07-20-boxes-settings-tab-design.md`

## Global Constraints

- ESM everywhere (`"type": "module"`); Node 20+.
- Web client is `.ts`; server is plain `.js`. This change is client-only.
- TDD: write the failing test first. Tests use real code, not mocks.
- Web-side unit tests target **pure helpers**, not DOM rendering — matching `test/proxmoxContainers.test.js`, `test/setupStatus.test.js`, `test/presetSummary.test.js`. Do not add jsdom or a DOM-rendering test harness.
- Never use `innerHTML` in the `dom.ts`-built views: all text lands as text nodes or attributes.
- Use only CSS classes that already exist in `src/web/style.css`: `pve-sub`, `pve-err`, `pve-primary`, `pve-btn`, `pve-inline`, `pve-eyebrow`. Do not add new CSS rules.
- Conventional-commit style messages (`feat(ui): …`, `refactor(ui): …`).
- `npm test` runs `npm run typecheck && vitest run`. Both must pass before each commit.

## File Structure

| File | Responsibility |
|---|---|
| `src/web/settingsBoxes.ts` (create) | The Boxes settings section: export button, import button + hidden file input, inline status line, and the pure `importSummary()` helper. |
| `test/settingsBoxes.test.js` (create) | Unit tests for `importSummary()`. |
| `src/web/settingsUi.ts` (modify) | Register `'boxes'` in the `SettingsTab` union and as the first `SECTIONS` entry. |
| `src/web/main.ts` (modify) | Remove the sidebar buttons, the hidden file input, and their three handlers. Add the module-scope `tmuxifier:boxes-changed` listener. |
| `src/web/style.css` (modify) | Remove the now-dead `#export` / `#import` collapsed-sidebar selectors. |

Two tasks. Task 1 adds the new tab (both surfaces briefly coexist, which is harmless and independently reviewable). Task 2 removes the old sidebar surface.

---

### Task 1: The Boxes settings section

**Files:**
- Create: `src/web/settingsBoxes.ts`
- Create: `test/settingsBoxes.test.js`
- Modify: `src/web/settingsUi.ts:10` (the `SettingsTab` union) and `src/web/settingsUi.ts:14-19` (the `SECTIONS` map)

**Interfaces:**
- Consumes: `el` from `./dom`; `api.importBoxes(payload: unknown): Promise<{ added: Box[]; skipped: number }>` from `./api` (already exists at `src/web/api.ts:113`).
- Produces:
  - `importSummary(added: number, skipped: number): string` — pure, used by Task 1's tests only.
  - `renderBoxesSection(content: HTMLElement): void` — consumed by `settingsUi.ts`.
  - The `'tmuxifier:boxes-changed'` window event, consumed by Task 2's listener in `main.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/settingsBoxes.test.js`:

```js
import { test, expect } from 'vitest';
import { importSummary } from '../src/web/settingsBoxes.ts';

test('importSummary: singular vs plural box count', () => {
  expect(importSummary(1, 0)).toBe('Imported 1 box');
  expect(importSummary(3, 0)).toBe('Imported 3 boxes');
  expect(importSummary(0, 0)).toBe('Imported 0 boxes');
});

test('importSummary: the skipped clause appears only when something was skipped', () => {
  expect(importSummary(3, 1)).toBe('Imported 3 boxes, 1 skipped');
  expect(importSummary(1, 2)).toBe('Imported 1 box, 2 skipped');
  expect(importSummary(0, 4)).toBe('Imported 0 boxes, 4 skipped');
  expect(importSummary(2, 0)).toBe('Imported 2 boxes');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/settingsBoxes.test.js`

Expected: FAIL — the import cannot be resolved, e.g. `Failed to resolve import "../src/web/settingsBoxes.ts"`.

- [ ] **Step 3: Write the module**

Create `src/web/settingsBoxes.ts`:

```ts
// Settings → Boxes: export/import the box list as a JSON file. Relocated out of
// the sidebar brand actions, which are reserved for the routinely used controls
// (collapse, settings, logout) — export/import is a rare admin action.
import { el } from './dom';
import { api } from './api';

// Pure so it can be tested without a DOM (the repo's web-test convention).
export function importSummary(added: number, skipped: number): string {
  const noun = added === 1 ? 'box' : 'boxes';
  return `Imported ${added} ${noun}${skipped ? `, ${skipped} skipped` : ''}`;
}

export function renderBoxesSection(content: HTMLElement): void {
  // Settings sections have no access to main.ts's private showToast, so results
  // land on an inline status line — the convention every other section follows.
  const status = el('div', { class: 'pve-sub' });
  const setStatus = (msg: string, isError = false) => {
    status.className = isError ? 'pve-err' : 'pve-sub';
    status.textContent = msg;
  };

  const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true }) as HTMLInputElement;
  file.addEventListener('change', async () => {
    const picked = file.files?.[0];
    file.value = ''; // reset so re-selecting the same file fires change again
    if (!picked) return;
    try {
      const payload = JSON.parse(await picked.text());
      const { added, skipped } = await api.importBoxes(payload);
      // The dashboard owns the box list and repaints on this event (main.ts).
      window.dispatchEvent(new Event('tmuxifier:boxes-changed'));
      setStatus(importSummary(added.length, skipped));
    } catch (e) {
      setStatus(`Import failed: ${(e as Error).message}`, true);
    }
  });

  const exportBtn = el('button', {
    type: 'button', class: 'pve-primary', onclick: () => {
      // Same-origin GET navigation: the session cookie rides along and the
      // server's Content-Disposition names the saved file.
      const a = document.createElement('a');
      a.href = '/api/export';
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
  }, ['Export boxes']);

  const importBtn = el('button', { type: 'button', class: 'pve-btn', onclick: () => file.click() }, ['Import boxes…']);

  content.replaceChildren(
    el('h3', {}, ['Boxes']),
    el('p', { class: 'pve-sub' }, ['Export writes your box list to a JSON file. Import accepts a file produced by the export button — ids are re-minted, and duplicate or unsafe entries are skipped.']),
    el('div', { class: 'pve-inline' }, [exportBtn, importBtn]),
    status,
    file,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/settingsBoxes.test.js`

Expected: PASS — 2 tests passed.

- [ ] **Step 5: Register the tab in the settings modal**

In `src/web/settingsUi.ts`, add the import alongside the other section imports:

```ts
import { renderBoxesSection } from './settingsBoxes';
```

Widen the tab union (line 10):

```ts
export type SettingsTab = 'boxes' | 'netbox' | 'proxmox' | 'passkeys' | 'notifications';
```

Add `boxes` as the **first** entry of `SECTIONS` — `Object.entries` iteration order is what builds the tab strip, so first entry means leftmost tab:

```ts
const SECTIONS: Record<SettingsTab, Section> = {
  boxes: { label: 'Boxes', render: (content) => renderBoxesSection(content) },
  netbox: { label: 'NetBox', render: renderNetboxSection },
  proxmox: { label: 'Proxmox', render: (content) => renderProxmoxSection(content) },
  passkeys: { label: 'Passkeys', render: (content) => renderPasskeysSection(content) },
  notifications: { label: 'Notifications', render: (content) => renderNotificationsSection(content) },
};
```

Leave the `openSettingsModal(tab: SettingsTab = 'netbox', …)` default **unchanged** — the gear button keeps opening on NetBox. Export/import is rare and should not become the landing tab.

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npm test`

Expected: PASS — `tsc --noEmit` clean, then the whole vitest suite green including the new `settingsBoxes` tests.

- [ ] **Step 7: Commit**

```bash
git add src/web/settingsBoxes.ts src/web/settingsUi.ts test/settingsBoxes.test.js
git commit -m "feat(ui): add a Settings → Boxes tab with box export/import"
```

---

### Task 2: Remove the sidebar export/import buttons

**Files:**
- Modify: `src/web/main.ts:557-558` (the two buttons), `src/web/main.ts:561` (the hidden file input), `src/web/main.ts:603-628` (the three handlers), and the module-scope listener block near `src/web/main.ts:1894`
- Modify: `src/web/style.css:153-155` (dead collapsed-sidebar selectors)

**Interfaces:**
- Consumes: the `'tmuxifier:boxes-changed'` window event dispatched by `settingsBoxes.ts` (Task 1).
- Produces: nothing new. `refresh()` at `src/web/main.ts:683` is the existing repaint entry point and is unchanged.

> Line numbers are from the pre-Task-2 file and shift as you edit. Locate each hunk by its content, not by line number alone.

- [ ] **Step 1: Delete the two sidebar buttons**

In the `renderDashboard()` template literal, inside `.brand-actions`, delete these two lines:

```html
            <button id="export" type="button" title="Export boxes to a file" aria-label="Export boxes to a file">⤓</button>
            <button id="import" type="button" title="Import boxes from a file" aria-label="Import boxes from a file">⤒</button>
```

`.brand-actions` is left with `#sidebar-toggle`, `#settings`, and `#logout`. It is an `inline-flex` with a gap, so no CSS adjustment is needed for the shorter row.

- [ ] **Step 2: Delete the hidden file input**

A few lines below, still inside `.brand`, delete:

```html
          <input id="import-file" type="file" accept="application/json,.json" hidden />
```

`settingsBoxes.ts` now creates its own file input, so no persistent element is needed here.

- [ ] **Step 3: Delete the three handlers**

Delete the whole block that starts at the export click handler and ends at the close of the `importFile` change handler — everything from:

```ts
  app.querySelector('#export')!.addEventListener('click', () => {
```

through the closing lines:

```ts
    } catch (e) {
      showToast(`Import failed: ${(e as Error).message}`, 'error');
    }
  });
```

This removes the `#export` handler, the `const importFile = …` lookup, the `#import` click handler, and the `importFile` change handler. Keep the `#settings` handler immediately above it and the `#add` handler immediately below it.

- [ ] **Step 4: Add the repaint listener at module scope**

Near the bottom of `main.ts`, immediately after the existing notify-prefs listener, add:

```ts
// An import from Settings → Boxes mutates the box list while the modal is still
// open (see settingsBoxes.ts). Module scope, not renderDashboard(), which
// re-runs on every re-login and would stack duplicate listeners. Safe on the
// login screen too: refresh() returns early when #boxes is absent.
window.addEventListener('tmuxifier:boxes-changed', () => { void refresh(); });
```

For reference, the line it goes after is:

```ts
window.addEventListener('tmuxifier:notify-prefs-changed', () => updateEventsBadge());
```

- [ ] **Step 5: Remove the dead CSS selectors**

In `src/web/style.css`, the collapsed-sidebar hide rule lists ids that no longer exist. Change:

```css
.layout.sidebar-collapsed #logout,
.layout.sidebar-collapsed #export,
.layout.sidebar-collapsed #import,
.layout.sidebar-collapsed .actions,
```

to:

```css
.layout.sidebar-collapsed #logout,
.layout.sidebar-collapsed .actions,
```

Leave the rest of the selector list (`.fleet-actions`, `.fleet-bar`, `.search`, `.boxes`, `.local-shell`) untouched.

- [ ] **Step 6: Verify no references remain**

Run: `grep -rn "#export\|#import\|import-file" src/web/`

Expected: no output. (A non-empty result means a handler, template line, or CSS rule was missed.)

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npm test`

Expected: PASS — `tsc --noEmit` clean and the whole vitest suite green. If `tsc` reports `showToast` is declared but never read, it means `showToast` had no other caller; it does have others (the session-expiry handler at the bottom of `main.ts` calls it), so this should not happen — investigate rather than deleting the function.

- [ ] **Step 8: Build and eyeball the result**

Run: `npm run build && npm run dev`

Open the dashboard and confirm:
1. The sidebar brand row shows only `‹`, `⚙`, `⎋`.
2. `⚙` opens the settings modal on the **NetBox** tab, with **Boxes** as the leftmost tab.
3. Settings → Boxes → **Export boxes** downloads a JSON file.
4. Settings → Boxes → **Import boxes…** with that file shows `Imported N boxes…` on the status line, and the sidebar box list behind the modal repaints without closing the modal.
5. Importing a non-JSON file shows a red `Import failed: …` line.

- [ ] **Step 9: Commit**

```bash
git add src/web/main.ts src/web/style.css
git commit -m "refactor(ui): drop the sidebar box export/import buttons"
```

---

## Out of scope

- No change to the export file format, the import validation, or any server route (`store.js`'s `exportBoxes`/`importBoxes`, `server.js`'s `/api/export` and `/api/import`).
- No new box-related settings in the Boxes tab beyond export/import.
- No rewrite of the point-in-time docs under `docs/superpowers/` that mention the sidebar buttons — those are historical records.
- No version bump, tag, or release. That is the separate shipping checklist in `CLAUDE.md`.
