# Sidebar Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard sidebar wider by default and add a remembered collapse/expand control.

**Architecture:** Keep the feature entirely in the web client. CSS owns the grid width and collapsed rail state; `src/web/main.ts` owns reading/writing the browser preference and refitting active terminals after layout changes.

**Tech Stack:** TypeScript, Vite, browser `localStorage`, CSS grid, Playwright e2e tests.

---

## File Structure

- Modify `src/web/style.css`: default sidebar width, collapsed grid state, hidden sidebar content rules, toggle button styling.
- Modify `src/web/main.ts`: sidebar preference constant, dashboard markup, toggle behavior, terminal refit scheduling.
- Modify `test/e2e/tmuxifier.spec.ts`: add a Playwright test for collapse persistence.

## Task 1: Write The Failing E2E Test

**Files:**
- Modify: `test/e2e/tmuxifier.spec.ts`

- [ ] **Step 1: Add the test**

Append this test to `test/e2e/tmuxifier.spec.ts`:

```ts
test('sidebar can collapse and remembers state after reload', async ({ page }) => {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');

  const layout = page.locator('.layout');
  const sidebar = page.locator('.sidebar');
  await expect(layout).toBeVisible({ timeout: 10000 });
  await expect(layout).not.toHaveClass(/sidebar-collapsed/);

  const expandedBox = await sidebar.boundingBox();
  expect(expandedBox?.width).toBeGreaterThanOrEqual(315);

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(layout).toHaveClass(/sidebar-collapsed/);

  const collapsedBox = await sidebar.boundingBox();
  expect(collapsedBox?.width).toBeLessThanOrEqual(64);

  await page.reload();
  await expect(page.locator('.layout')).toHaveClass(/sidebar-collapsed/, { timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(page.locator('.layout')).not.toHaveClass(/sidebar-collapsed/);
});
```

- [ ] **Step 2: Run the focused e2e test and verify it fails**

Run:

```bash
npx playwright test test/e2e/tmuxifier.spec.ts --grep "sidebar can collapse"
```

Expected: FAIL because the page has no button named `Collapse sidebar`.

## Task 2: Implement Sidebar Collapse

**Files:**
- Modify: `src/web/main.ts`
- Modify: `src/web/style.css`

- [ ] **Step 1: Add the preference key and refit helper**

Near the existing top-level state in `src/web/main.ts`, add:

```ts
const SIDEBAR_COLLAPSED_KEY = 'tmuxifier.sidebarCollapsed';
```

Add this helper near `filterAndPaint()`:

```ts
function refitActiveTerminals() {
  for (const t of tabs.values()) t.term.refit();
}
```

- [ ] **Step 2: Update dashboard markup and toggle behavior**

In `renderDashboard()`, read the saved preference before assigning `app.innerHTML`:

```ts
  const sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
```

Change the opening layout and brand markup to:

```ts
  app.innerHTML = `<div class="layout${sidebarCollapsed ? ' sidebar-collapsed' : ''}">
      <aside class="sidebar">
        <div class="brand">
          <span><img src="${logoUrl}" alt="" /><span class="brand-name">tmuxifier</span></span>
          <div class="brand-actions">
            <button id="sidebar-toggle" class="sidebar-toggle" type="button" title="${sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}" aria-label="${sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}" aria-expanded="${sidebarCollapsed ? 'false' : 'true'}">${sidebarCollapsed ? '›' : '‹'}</button>
            <button id="logout" title="Log out">⎋</button>
          </div>
        </div>
```

After the existing logout listener is registered, add:

```ts
  app.querySelector('#sidebar-toggle')!.addEventListener('click', () => {
    const layout = app.querySelector('.layout') as HTMLElement;
    const button = app.querySelector('#sidebar-toggle') as HTMLButtonElement;
    const collapsed = !layout.classList.contains('sidebar-collapsed');
    layout.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    button.textContent = collapsed ? '›' : '‹';
    button.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    button.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    window.setTimeout(refitActiveTerminals, 260);
  });
```

- [ ] **Step 3: Update sidebar CSS**

In `src/web/style.css`, replace the current `.layout`, `.brand`, and `.brand button` related rules with:

```css
.layout { display: grid; grid-template-columns: 320px 1fr; height: 100vh; transition: grid-template-columns 0.25s ease; }
.layout.sidebar-collapsed { grid-template-columns: 56px 1fr; }
.sidebar { border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 12px; gap: 10px; background: #090d13; overflow: hidden; min-width: 0; }
.brand { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 700; letter-spacing: 1px; min-width: 0; }
.brand span { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.brand-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brand img { width: 28px; height: 28px; border-radius: 7px; flex: 0 0 auto; }
.brand-actions { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.brand button { background: none; border: none; color: #8b949e; cursor: pointer; font-size: 16px; width: 24px; height: 24px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; }
.brand button:hover { background: var(--panel-2); color: var(--text); }
.sidebar-toggle { font-size: 18px; }
.layout.sidebar-collapsed .sidebar { padding: 12px 8px; align-items: center; }
.layout.sidebar-collapsed .brand { width: 100%; justify-content: center; }
.layout.sidebar-collapsed .brand > span { display: none; }
.layout.sidebar-collapsed .brand-actions { flex-direction: column; }
.layout.sidebar-collapsed #logout,
.layout.sidebar-collapsed .actions,
.layout.sidebar-collapsed .search,
.layout.sidebar-collapsed .boxes,
.layout.sidebar-collapsed .local-shell { display: none; }
```

- [ ] **Step 4: Run the focused e2e test and verify it passes**

Run:

```bash
npx playwright test test/e2e/tmuxifier.spec.ts --grep "sidebar can collapse"
```

Expected: PASS.

## Task 3: Build And Full Verification

**Files:**
- Modify: `src/web/main.ts`
- Modify: `src/web/style.css`
- Modify: `test/e2e/tmuxifier.spec.ts`

- [ ] **Step 1: Run the web build**

Run:

```bash
npm run build
```

Expected: PASS with Vite writing `dist/`.

- [ ] **Step 2: Run the e2e suite**

Run:

```bash
npm run test:e2e
```

Expected: PASS for both dashboard e2e tests.

- [ ] **Step 3: Commit implementation**

Run:

```bash
git add src/web/main.ts src/web/style.css test/e2e/tmuxifier.spec.ts dist
git commit -m "feat(ui): add collapsible sidebar"
```
