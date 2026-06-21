# Box Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one primary tag per box and render the sidebar as collapsible tag groups.

**Architecture:** Keep the existing `Box.tags: string[]` storage shape and normalize it to zero or one primary tag in the store. The web client derives groups from the loaded boxes, persists per-tag collapsed state in `localStorage`, and sends `tags: [tag]` or `tags: []` through the existing box create/update endpoints. No new server endpoint or persisted file is needed.

**Tech Stack:** Node 20, Fastify, Vite, TypeScript DOM APIs, Vitest, Playwright.

---

## File Structure

- Modify `src/server/store.js`
  - Add a private `normalizeTags()` helper.
  - Use it from the existing `normalize()` path so add and update share behavior.
- Modify `test/store.test.js`
  - Add focused unit tests for missing, blank, whitespace, multiple, cleared, and replaced tags.
- Modify `test/e2e/global-setup.js`
  - Seed three e2e boxes: two tagged `Prod`, one untagged. They all point at the existing local SSH test host and share the same session name so cleanup remains unchanged.
- Modify `test/e2e/tmuxifier.spec.ts`
  - Add browser coverage for grouped rendering, persisted group collapse, tag search reveal behavior, and modal tag editing.
- Modify `src/web/main.ts`
  - Add tag helpers near the existing sidebar constants.
  - Replace flat `paint()` rendering with grouped rendering.
  - Add a `Tag` input and native `<datalist>` to `openBoxDialog()`.
- Modify `src/web/style.css`
  - Add compact group header, group body, and active-group styles.
  - Keep existing whole-sidebar collapsed styles working.

---

### Task 1: Store Tag Normalization

**Files:**
- Modify: `test/store.test.js`
- Modify: `src/server/store.js`

- [ ] **Step 1: Write failing store tests**

Append these tests to `test/store.test.js`:

```js
test('addBox normalizes missing and blank tags to an empty list', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });

  const missing = await store.addBox({ host: 'missing-tags' });
  const blank = await store.addBox({ host: 'blank-tags', tags: [' ', '\t', ''] });

  expect(missing.tags).toEqual([]);
  expect(blank.tags).toEqual([]);
});

test('addBox trims, collapses whitespace, and stores only the first non-empty tag', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });

  const box = await store.addBox({
    host: 'tagged-box',
    tags: ['  Prod   Web  ', 'Staging'],
  });

  expect(box.tags).toEqual(['Prod Web']);
});

test('updateBox can clear and replace the primary tag', async () => {
  const store = createStore({ dataDir: dir, sshConfigPath });
  const box = await store.addBox({ host: 'retagged-box', tags: ['Prod'] });

  const cleared = await store.updateBox(box.id, { tags: [] });
  expect(cleared.tags).toEqual([]);

  const replaced = await store.updateBox(box.id, { tags: ['  Staging   East '] });
  expect(replaced.tags).toEqual(['Staging East']);
});
```

- [ ] **Step 2: Run store tag tests and verify they fail**

Run:

```bash
npm test -- test/store.test.js -t tags
```

Expected: FAIL. The current store preserves blank tags, multiple tags, or whitespace instead of normalizing to a single primary tag.

- [ ] **Step 3: Implement store tag normalization**

In `src/server/store.js`, add this helper above `export function createStore`:

```js
function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().replace(/\s+/g, ' ');
    if (tag) return [tag];
  }
  return [];
}
```

Then replace this line inside `normalize()`:

```js
      tags: spec.tags || base.tags || [],
```

with:

```js
      tags: normalizeTags(spec.tags),
```

This works for updates because `updateBox()` already passes `{ ...boxes[i], ...patch, host: patch.host ?? boxes[i].host }` into `normalize()`, so `spec.tags` is the existing tag list when the patch omits tags and is the replacement tag list when the patch includes tags.

- [ ] **Step 4: Run store tag tests and verify they pass**

Run:

```bash
npm test -- test/store.test.js -t tags
```

Expected: PASS for the three tag tests.

- [ ] **Step 5: Run the full store test file**

Run:

```bash
npm test -- test/store.test.js
```

Expected: PASS for all store tests.

- [ ] **Step 6: Commit store normalization**

Run:

```bash
git add src/server/store.js test/store.test.js
git commit -m "feat(store): normalize box tags"
```

Expected: commit succeeds.

---

### Task 2: Grouped Sidebar Rendering

**Files:**
- Modify: `test/e2e/global-setup.js`
- Modify: `test/e2e/tmuxifier.spec.ts`
- Modify: `src/web/main.ts`
- Modify: `src/web/style.css`

- [ ] **Step 1: Seed tagged boxes in e2e setup**

In `test/e2e/global-setup.js`, replace the current seeded-box line:

```js
  await store.addBox({ host: lb.box.host, label: 'localhost', sessionName: lb.session });
```

with:

```js
  await store.addBox({ host: lb.box.host, label: 'localhost', sessionName: lb.session, tags: ['Prod'] });
  await store.addBox({ host: lb.box.host, label: 'db-primary', sessionName: lb.session, tags: ['Prod'] });
  await store.addBox({ host: lb.box.host, label: 'untagged-worker', sessionName: lb.session });
```

- [ ] **Step 2: Write the failing grouped-sidebar browser test**

Append this test to `test/e2e/tmuxifier.spec.ts`:

```ts
test('sidebar groups boxes by tag and remembers collapsed groups during search', async ({ page }) => {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');

  const prodGroup = page.locator('.box-group[data-tag-key="prod"]');
  const untaggedGroup = page.locator('.box-group[data-tag-key="__untagged__"]');

  await expect(page.getByRole('button', { name: /Prod\s+2/ })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: /Untagged\s+1/ })).toBeVisible();
  await expect(prodGroup.locator('.box .name')).toHaveText(['localhost', 'db-primary']);
  await expect(untaggedGroup.locator('.box .name')).toHaveText(['untagged-worker']);

  await page.getByRole('button', { name: /Prod\s+2/ }).click();
  await expect(prodGroup.locator('.group-body')).toBeHidden();

  await page.reload();
  await expect(page.locator('.layout')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: /Prod\s+2/ })).toBeVisible();
  await expect(prodGroup.locator('.group-body')).toBeHidden();

  await page.fill('#search', 'prod');
  await expect(prodGroup.locator('.group-body')).toBeVisible();
  await expect(prodGroup.locator('.box .name')).toHaveText(['localhost', 'db-primary']);

  await page.fill('#search', '');
  await expect(prodGroup.locator('.group-body')).toBeHidden();
});
```

- [ ] **Step 3: Run the grouped-sidebar browser test and verify it fails**

Run:

```bash
npm run test:e2e -- --grep "sidebar groups boxes"
```

Expected: FAIL because `.box-group` headers do not exist yet.

- [ ] **Step 4: Add tag helpers to the web client**

In `src/web/main.ts`, add these constants and helpers after `const SIDEBAR_COLLAPSED_KEY = 'tmuxifier.sidebarCollapsed';`:

```ts
const GROUP_COLLAPSED_KEY = 'tmuxifier.collapsedTagGroups';
const UNTAGGED_LABEL = 'Untagged';
const UNTAGGED_KEY = '__untagged__';

interface BoxGroup {
  key: string;
  label: string;
  boxes: Box[];
  untagged: boolean;
}

function normalizeTagInput(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function primaryTag(box: Box): string {
  return normalizeTagInput(box.tags?.[0]);
}

function keyForTag(tag: string): string {
  const normalized = normalizeTagInput(tag);
  return normalized ? normalized.toLowerCase() : UNTAGGED_KEY;
}

function labelForTag(tag: string): string {
  return normalizeTagInput(tag) || UNTAGGED_LABEL;
}

function boxMatchesSearch(box: Box, term: string): boolean {
  if (!term) return true;
  const tag = primaryTag(box).toLowerCase();
  return box.label.toLowerCase().includes(term)
    || box.host.toLowerCase().includes(term)
    || tag.includes(term);
}

function groupBoxes(boxes: Box[]): BoxGroup[] {
  const groups = new Map<string, BoxGroup>();
  for (const box of boxes) {
    const tag = primaryTag(box);
    const key = keyForTag(tag);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: labelForTag(tag), boxes: [], untagged: key === UNTAGGED_KEY };
      groups.set(key, group);
    }
    group.boxes.push(box);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.untagged && !b.untagged) return 1;
    if (!a.untagged && b.untagged) return -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
}

function readCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(GROUP_COLLAPSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedGroups(keys: Set<string>) {
  localStorage.setItem(GROUP_COLLAPSED_KEY, JSON.stringify([...keys].sort()));
}

function isGroupCollapsed(key: string): boolean {
  return readCollapsedGroups().has(key);
}

function setGroupCollapsed(key: string, collapsed: boolean) {
  const keys = readCollapsedGroups();
  if (collapsed) keys.add(key);
  else keys.delete(key);
  writeCollapsedGroups(keys);
}
```

- [ ] **Step 5: Route search through the tag-aware matcher**

In `src/web/main.ts`, replace `filterAndPaint()` with:

```ts
function filterAndPaint() {
  const term = getSearchTerm();
  const filtered = allBoxes.filter(b => boxMatchesSearch(b, term));
  paint(filtered, latestStatus, term);
}
```

- [ ] **Step 6: Extract row rendering from the current flat `paint()`**

In `src/web/main.ts`, replace the current `paint()` function with `createBoxRow()` plus the new grouped `paint()`:

```ts
function createBoxRow(b: Box, status: Record<string, Status>): HTMLElement {
  const st = status[b.id];

  const li = document.createElement('li');
  li.className = b.id === activeBoxId ? 'box active' : 'box';
  li.dataset.id = b.id;

  const dotEl = document.createElement('span');
  dotEl.className = `dot ${dotClassFor(st)}`;
  dotEl.title = dotTitleFor(st);

  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = b.label;
  nameEl.addEventListener('click', () => openBox(b));

  const refresh = document.createElement('button');
  refresh.className = 'refresh';
  refresh.title = 'Reconnect';
  refresh.textContent = '↻';
  refresh.addEventListener('click', async (e) => {
    e.stopPropagation();
    await api.reconnectBox(b.id);
    const wasActive = activeBoxId === b.id;
    closeTab(b.id);
    if (wasActive) openBox(b);
  });

  const edit = document.createElement('button');
  edit.className = 'edit';
  edit.title = 'Edit';
  edit.textContent = '✎';
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    openBoxDialog(b);
  });

  const rm = document.createElement('button');
  rm.className = 'rm';
  rm.title = 'Remove';
  rm.textContent = '✕';
  rm.addEventListener('click', async (e) => {
    e.stopPropagation();
    await api.removeBox(b.id);
    closeTab(b.id);
    await refresh();
  });

  li.append(dotEl, nameEl, refresh, edit, rm);
  return li;
}

function paint(boxes: Box[], status: Record<string, Status>, searchTerm = getSearchTerm()) {
  const list = app.querySelector('#boxes')!;
  list.innerHTML = '';
  const searching = !!searchTerm;

  for (const group of groupBoxes(boxes)) {
    const collapsed = !searching && isGroupCollapsed(group.key);
    const containsActive = !!activeBoxId && group.boxes.some(b => b.id === activeBoxId);

    const groupItem = document.createElement('li');
    groupItem.className = `box-group${collapsed ? ' collapsed' : ''}${containsActive ? ' active-child' : ''}`;
    groupItem.dataset.tagKey = group.key;

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'group-header';
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    header.title = searching ? 'Clear search to collapse groups' : `${collapsed ? 'Expand' : 'Collapse'} ${group.label}`;

    const chevron = document.createElement('span');
    chevron.className = 'group-chevron';
    chevron.textContent = collapsed ? '›' : '⌄';

    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = group.label;

    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = String(group.boxes.length);

    header.append(chevron, name, count);
    header.addEventListener('click', () => {
      if (searching) return;
      setGroupCollapsed(group.key, !collapsed);
      filterAndPaint();
    });

    const body = document.createElement('ul');
    body.className = 'group-body';
    body.hidden = collapsed;
    for (const box of group.boxes) body.appendChild(createBoxRow(box, status));

    groupItem.append(header, body);
    list.appendChild(groupItem);
  }
}
```

- [ ] **Step 7: Add grouped sidebar CSS**

In `src/web/style.css`, replace the current `.boxes` and `.box` block:

```css
.boxes { list-style: none; margin: 0; padding: 0; flex: 1; overflow-y: auto; }
.box { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 8px; cursor: pointer; }
.box:hover { background: var(--panel-2); }
.box.active { background: rgba(36, 211, 232, 0.12); box-shadow: inset 3px 0 0 var(--cyan); }
.box .name { flex: 1; font-size: 13px; }
.box .rm, .box .refresh { background: none; border: none; color: #6e7681; cursor: pointer; }
.box .refresh { font-size: 14px; }
.box .edit { background: none; border: none; color: #6e7681; cursor: pointer; font-size: 13px; }
```

with:

```css
.boxes { list-style: none; margin: 0; padding: 0; flex: 1; overflow-y: auto; }
.box-group { list-style: none; margin: 0 0 4px; padding: 0; }
.group-header {
  width: 100%;
  display: grid;
  grid-template-columns: 16px 1fr auto;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  text-align: left;
}
.group-header:hover { background: rgba(255, 255, 255, 0.04); color: var(--text); }
.box-group.active-child > .group-header {
  color: var(--text);
  background: rgba(36, 211, 232, 0.08);
  box-shadow: inset 3px 0 0 rgba(36, 211, 232, 0.72);
}
.group-chevron { color: #6e7681; font-size: 14px; line-height: 1; text-align: center; }
.group-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 650; }
.group-count { min-width: 22px; text-align: right; color: #6e7681; font-variant-numeric: tabular-nums; }
.group-body { list-style: none; margin: 2px 0 8px; padding: 0; }
.group-body[hidden] { display: none; }
.box { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 8px; cursor: pointer; }
.box:hover { background: var(--panel-2); }
.box.active { background: rgba(36, 211, 232, 0.12); box-shadow: inset 3px 0 0 var(--cyan); }
.box .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.box .rm, .box .refresh { background: none; border: none; color: #6e7681; cursor: pointer; }
.box .refresh { font-size: 14px; }
.box .edit { background: none; border: none; color: #6e7681; cursor: pointer; font-size: 13px; }
```

- [ ] **Step 8: Build the web client**

Run:

```bash
npm run build
```

Expected: PASS. TypeScript and Vite build complete successfully.

- [ ] **Step 9: Run the grouped-sidebar browser test**

Run:

```bash
npm run test:e2e -- --grep "sidebar groups boxes"
```

Expected: PASS.

- [ ] **Step 10: Commit grouped sidebar rendering**

Run:

```bash
git add src/web/main.ts src/web/style.css test/e2e/global-setup.js test/e2e/tmuxifier.spec.ts
git commit -m "feat(ui): group boxes by tag"
```

Expected: commit succeeds.

---

### Task 3: Tag Field In Add/Edit Box Modal

**Files:**
- Modify: `test/e2e/tmuxifier.spec.ts`
- Modify: `src/web/main.ts`

- [ ] **Step 1: Write the failing modal tag-editing browser test**

Append this test to `test/e2e/tmuxifier.spec.ts`:

```ts
test('edit box tag joins an existing group and can be cleared', async ({ page }) => {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');

  await expect(page.getByRole('button', { name: /Prod\s+2/ })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: /Untagged\s+1/ })).toBeVisible();

  await page.locator('.box', { hasText: 'untagged-worker' }).locator('.edit').click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toBeVisible();
  await page.getByLabel('Tag').fill('prod');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('button', { name: /Prod\s+3/ })).toBeVisible();
  await expect(page.locator('.box-group[data-tag-key="prod"] .box .name')).toContainText([
    'localhost',
    'db-primary',
    'untagged-worker',
  ]);

  await page.locator('.box', { hasText: 'untagged-worker' }).locator('.edit').click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toBeVisible();
  await page.getByLabel('Tag').fill('');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('button', { name: /Prod\s+2/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Untagged\s+1/ })).toBeVisible();
  await expect(page.locator('.box-group[data-tag-key="__untagged__"] .box .name')).toHaveText(['untagged-worker']);
});
```

- [ ] **Step 2: Run the modal tag-editing browser test and verify it fails**

Run:

```bash
npm run test:e2e -- --grep "edit box tag"
```

Expected: FAIL because the modal has no `Tag` field.

- [ ] **Step 3: Add existing-tag helpers**

In `src/web/main.ts`, add these helpers after `groupBoxes()`:

```ts
function existingTagMap(): Map<string, string> {
  const tags = new Map<string, string>();
  for (const box of allBoxes) {
    const tag = primaryTag(box);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (!tags.has(key)) tags.set(key, tag);
  }
  return tags;
}

function existingTagOptions(): string[] {
  return [...existingTagMap().values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function canonicalTagForInput(value: string): string {
  const normalized = normalizeTagInput(value);
  if (!normalized) return '';
  return existingTagMap().get(normalized.toLowerCase()) || normalized;
}
```

- [ ] **Step 4: Let modal fields attach a datalist**

In `openBoxDialog()`, change the local `field()` helper signature from:

```ts
  function field(name: string, label: string, opts: { placeholder?: string; value?: string; type?: string } = {}) {
```

to:

```ts
  function field(name: string, label: string, opts: { placeholder?: string; value?: string; type?: string; list?: string } = {}) {
```

Inside that helper, after the existing placeholder assignment:

```ts
    if (opts.placeholder) input.placeholder = opts.placeholder;
```

add:

```ts
    if (opts.list) input.setAttribute('list', opts.list);
```

- [ ] **Step 5: Add the Tag input and datalist to the modal**

In `openBoxDialog()`, after creating `title`, add:

```ts
  const tagListId = 'tag-options';
  const tagDatalist = document.createElement('datalist');
  tagDatalist.id = tagListId;
  for (const tag of existingTagOptions()) {
    const option = document.createElement('option');
    option.value = tag;
    tagDatalist.appendChild(option);
  }
```

Then replace this portion of the `form.append(...)` call:

```ts
    hostWrap,
    field('label', 'Label (optional)', { placeholder: 'defaults to host' }),
    field('user', 'User', { value: 'root' }),
```

with:

```ts
    hostWrap,
    field('label', 'Label (optional)', { placeholder: 'defaults to host' }),
    field('tag', 'Tag', { placeholder: 'prod, staging, db', list: tagListId }),
    tagDatalist,
    field('user', 'User', { value: 'root' }),
```

- [ ] **Step 6: Pre-fill and submit tags from the modal**

In the edit-mode pre-population block in `openBoxDialog()`, add:

```ts
    fields.tag.value = primaryTag(box!);
```

Inside the edit submit branch, after the proxy jump patch assignment:

```ts
        const jump = fields.proxyJump.value.trim(); patch.proxyJump = jump || null;
```

add:

```ts
        const tag = canonicalTagForInput(fields.tag.value);
        patch.tags = tag ? [tag] : [];
```

Inside the add submit branch, after label assignment:

```ts
        const label = fields.label.value.trim(); if (label) spec.label = label;
```

add:

```ts
        const tag = canonicalTagForInput(fields.tag.value); if (tag) spec.tags = [tag];
```

- [ ] **Step 7: Build the web client**

Run:

```bash
npm run build
```

Expected: PASS. The `AddBoxSpec` type already accepts partial `Box`, so `spec.tags` is valid.

- [ ] **Step 8: Run the modal tag-editing browser test**

Run:

```bash
npm run test:e2e -- --grep "edit box tag"
```

Expected: PASS.

- [ ] **Step 9: Commit modal tag editing**

Run:

```bash
git add src/web/main.ts test/e2e/tmuxifier.spec.ts
git commit -m "feat(ui): edit box tags"
```

Expected: commit succeeds.

---

### Task 4: Full Verification

**Files:**
- Inspect: all changed files

- [ ] **Step 1: Run all unit and integration tests**

Run:

```bash
npm test
```

Expected: PASS for the full Vitest suite.

- [ ] **Step 2: Build the production web bundle**

Run:

```bash
npm run build
```

Expected: PASS and `dist/` is regenerated.

- [ ] **Step 3: Run the full browser suite**

Run:

```bash
npm run test:e2e
```

Expected: PASS for all Playwright tests, including:

```text
login, open a box terminal, reload, and reattach to the same session
sidebar can collapse and remembers state after reload
sidebar groups boxes by tag and remembers collapsed groups during search
edit box tag joins an existing group and can be cleared
```

- [ ] **Step 4: Inspect git status**

Run:

```bash
git status --short
```

Expected: either clean, or only intentional generated/build artifacts and source changes from this feature.

- [ ] **Step 5: Commit final verification fixes if any were needed**

If Step 4 shows intentional uncommitted source changes made while fixing verification failures, run:

```bash
git add src/server/store.js test/store.test.js src/web/main.ts src/web/style.css test/e2e/global-setup.js test/e2e/tmuxifier.spec.ts
git commit -m "fix(ui): polish box tag grouping"
```

Expected: commit succeeds. If Step 4 is clean, skip this step.

---

## Self-Review Checklist

- Store normalization covers missing, blank, whitespace, multiple, clear, and replace cases.
- Sidebar rendering always groups by tag and keeps `Untagged` last.
- Group collapse state uses a localStorage key separate from whole-sidebar collapse.
- Search matches tag names and expands matching groups without saving collapse changes.
- The modal has a single tag field with native datalist suggestions.
- Existing whole-sidebar collapse remains controlled by `tmuxifier.sidebarCollapsed`.
- No separate tag manager, tag colors, multi-tag membership, or new server endpoint is introduced.
