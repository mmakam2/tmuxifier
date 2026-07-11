# Containers Tab Search Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A search box in the Proxmox hub's Containers toolbar that live-filters the container rows (sidebar-style substring matching), preserving the term across Refresh.

**Architecture:** Pure exported `containerMatches(container, term)` in `proxmoxContainers.ts`; the toolbar gains an input whose `input` listener toggles each pre-built row's `hidden` attribute (no re-render, so action-button state and the focus highlight survive typing). Web-client only.

**Tech Stack:** TypeScript web client, vitest for the pure helper, plain CSS.

**Spec:** `docs/superpowers/specs/2026-07-11-containers-tab-search-design.md`

## Global Constraints

- Match fields exactly: `boxLabel`, `hostName ?? hostId`, `node`, `String(vmid)`, `state` — trimmed, lowercased substring; empty term matches all.
- Rows are built once; filtering only toggles `hidden`. **CSS landmine:** `.pve-container-row { display: grid }` overrides the UA `[hidden] { display: none }` rule (author styles beat UA styles), so the new CSS MUST include `.pve-container-row[hidden] { display: none; }` or nothing will hide.
- Refresh preserves the term (read the outgoing input's value before rebuild, re-apply value + filter after).
- `No containers match.` line shows only when containers exist and every row is hidden; the existing `No linked Proxmox containers.` empty state is unchanged.
- No server changes; no changes outside `proxmoxContainers.ts`, `style.css`, `test/proxmoxContainers.test.js`.
- Gate: `npm run typecheck && npm run build && npx vitest run test/proxmoxContainers.test.js` + the scripted browser check in Step 5.

---

### Task 1: Search filter on the Containers tab

**Files:**
- Modify: `src/web/proxmoxContainers.ts` (helper after `actionsForState` ~line 9; `renderContainersTab` body)
- Modify: `src/web/style.css` (the `.pve-container-toolbar` rule ~line 611 + new rules)
- Test: `test/proxmoxContainers.test.js`

**Interfaces:**
- Produces: `export function containerMatches(container: PveLinkedContainer, term: string): boolean`. Everything else stays module-internal.

- [ ] **Step 1: Write the failing tests**

Update the import line in `test/proxmoxContainers.test.js` and append:

```js
import { actionsForState, containerMatches } from '../src/web/proxmoxContainers.ts';

const C = { boxId: 'B1', boxLabel: 'datumworks01', hostId: 'H1', hostName: 'lab', node: 'proxmox02', vmid: 160, state: 'running' };

test('containerMatches: empty or blank term matches everything', () => {
  expect(containerMatches(C, '')).toBe(true);
  expect(containerMatches(C, '   ')).toBe(true);
});

test('containerMatches: label, host name, node, vmid, and state — case-insensitive substrings', () => {
  expect(containerMatches(C, 'DATUM')).toBe(true);
  expect(containerMatches(C, 'lab')).toBe(true);
  expect(containerMatches(C, 'proxmox02')).toBe(true);
  expect(containerMatches(C, '160')).toBe(true);
  expect(containerMatches(C, 'RUN')).toBe(true);
  expect(containerMatches(C, 'nomatch')).toBe(false);
});

test('containerMatches: falls back to hostId when hostName is null', () => {
  expect(containerMatches({ ...C, hostName: null }, 'h1')).toBe(true);
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run test/proxmoxContainers.test.js`
Expected: FAIL — `containerMatches` is not exported.

- [ ] **Step 3: Implement**

**(a)** In `src/web/proxmoxContainers.ts`, after `actionsForState`:

```ts
export function containerMatches(container: PveLinkedContainer, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  return [container.boxLabel, container.hostName ?? container.hostId, container.node, String(container.vmid), container.state]
    .some((field) => field.toLowerCase().includes(t));
}
```

**(b)** In `renderContainersTab`, capture the outgoing term as the FIRST line of the function body:

```ts
  const previousTerm = content.querySelector<HTMLInputElement>('.pve-container-search')?.value ?? '';
```

Replace the toolbar construction (currently `const toolbar = el('div', { class: 'pve-container-toolbar' }, [refresh]);`) with:

```ts
  const search = input(previousTerm, { type: 'text', class: 'pve-container-search', placeholder: 'Search…', autocomplete: 'off' });
  const toolbar = el('div', { class: 'pve-container-toolbar' }, [search, refresh]);
```

Above the row loop, alongside `const list = …`:

```ts
  const rowPairs: { row: HTMLElement; container: PveLinkedContainer }[] = [];
  const noMatch = el('div', { class: 'pve-sub' }, ['No containers match.']);
  const applyFilter = () => {
    let visible = 0;
    for (const pair of rowPairs) {
      const show = containerMatches(pair.container, search.value);
      pair.row.hidden = !show;
      if (show) visible += 1;
    }
    noMatch.hidden = rowPairs.length === 0 || visible > 0;
  };
  search.addEventListener('input', applyFilter);
```

Inside the row loop, right after `list.append(row);`:

```ts
    rowPairs.push({ row, container });
```

Replace the final assembly line (`content.replaceChildren(toolbar, containers.length ? list : …);`) with:

```ts
  content.replaceChildren(toolbar, containers.length ? list : el('div', { class: 'pve-sub' }, ['No linked Proxmox containers.']), noMatch);
  applyFilter();
```

(`applyFilter()` after assembly applies a Refresh-restored term immediately and initializes `noMatch.hidden`.)

**(c)** In `src/web/style.css`, add `gap: 8px;` to the existing `.pve-container-toolbar` rule (line ~611) and append after the `.pve-container-row button.warn` rule:

```css
.pve-container-search { flex: 1; max-width: 240px; min-width: 0; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: #131722; color: var(--text); font-size: 13px; }
.pve-container-search::placeholder { color: #4a5568; }
.pve-container-row[hidden] { display: none; }
```

- [ ] **Step 4: GREEN + gate**

Run: `npx vitest run test/proxmoxContainers.test.js && npm run typecheck && npm run build`
Expected: 4 tests pass; typecheck + build clean.

- [ ] **Step 5: Scripted browser check (throwaway, mocked APIs — the established pattern)**

Script under `.superpowers/` (delete after): serve `dist/`, intercept `**/api/**`, mock `/api/proxmox/containers` with three containers across two nodes/states (e.g. `dev-01`/`proxmox02`/running, `db-01`/`proxmox03`/stopped, `web-01`/`proxmox02`/running; include hosts/boxes/status mocks so the dashboard renders and the hub opens). Drive: open hub → Containers tab → assert 3 rows visible; type `proxmox03` → assert exactly 1 row visible (offsetParent !== null test, which catches the `[hidden]`-vs-`display:grid` landmine); type `zzz` → 0 visible and the `No containers match.` line shown; clear → 3 visible; type `stopped` → 1 visible; click Refresh with `db` in the box → after re-render the input still reads `db` and 1 row is visible. Print each assertion result; take one screenshot and inspect it.

Expected: all assertions true.

- [ ] **Step 6: Commit**

```bash
git add src/web/proxmoxContainers.ts src/web/style.css test/proxmoxContainers.test.js
git commit -m "feat(ui): live search filter on the Containers tab"
```
