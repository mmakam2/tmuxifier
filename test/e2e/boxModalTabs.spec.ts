import { test, expect, type Page } from '@playwright/test';

// The Add/Edit Box modal's tab strip (src/web/boxModalView.ts is its pure half,
// test/boxModalView.test.js pins that). What only a browser can show: the three
// jobs really are on separate panels, one Save still reaches a setting made on a
// tab that is no longer on screen, and a tab that holds something Save will act
// on says so while another tab is open.

async function login(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

async function openEdit(page: Page, label = 'untagged-worker') {
  await page.locator('.box', { has: page.locator('.name', { hasText: new RegExp(`^${label}$`) }) }).first().locator('.edit').click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toBeVisible();
  return page.locator('.modal.box-modal');
}

const tab = (page: Page, name: RegExp) => page.getByRole('tab', { name });

test('Edit Box opens on the Box tab and each tab shows only its own job', async ({ page }) => {
  await login(page);
  const modal = await openEdit(page);

  await expect(modal.getByRole('tab')).toHaveText(['Box', 'Setup', 'Agents']);
  await expect(tab(page, /^Box/)).toHaveAttribute('aria-selected', 'true');
  await expect(modal.getByLabel('Host or alias')).toBeVisible();
  await expect(modal.getByLabel('Install Oh My Tmux if missing')).toBeHidden();
  await expect(modal.locator('.wk-section')).toBeHidden();

  await tab(page, /^Setup/).click();
  await expect(tab(page, /^Setup/)).toHaveAttribute('aria-selected', 'true');
  await expect(modal.getByLabel('Host or alias')).toBeHidden();
  await expect(modal.getByLabel('Install Oh My Tmux if missing')).toBeVisible();
  // The setup run is not optional on an edit; the tab says so before anything else.
  await expect(modal.locator('.box-tab-panel:not([hidden]) .setup-hint').first()).toHaveText(/^Save reruns setup on this box\./);

  await tab(page, /^Agents/).click();
  await expect(modal.locator('.wk-section')).toBeVisible();
  await expect(modal.getByLabel('Install Oh My Tmux if missing')).toBeHidden();

  // The strip is a real tablist: arrows move the selection.
  await tab(page, /^Agents/).press('ArrowLeft');
  await expect(tab(page, /^Setup/)).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, /^Setup/)).toBeFocused();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toHaveCount(0);
});

test('a tool note appears only while its tool is ticked', async ({ page }) => {
  await login(page);
  const modal = await openEdit(page);
  await tab(page, /^Setup/).click();

  const note = modal.locator('.tools-notes .setup-hint', { hasText: 'Claude Code also pushes' });
  await expect(note).toBeHidden();
  await modal.getByLabel('Claude Code', { exact: true }).check();
  await expect(note).toBeVisible();
  await modal.getByLabel('Claude Code', { exact: true }).uncheck();
  await expect(note).toBeHidden();
  // Both groups are there, with pi among the agent CLIs.
  await expect(modal.getByRole('group', { name: 'Agent CLIs' }).getByLabel('pi', { exact: true })).toBeVisible();
  await expect(modal.getByRole('group', { name: 'System' }).getByLabel('git', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('a tab that holds something Save will act on is marked while another tab is open', async ({ page }) => {
  await login(page);
  const modal = await openEdit(page);

  // Edit mode starts with nothing selected for the setup run.
  await expect(tab(page, /^Setup/)).toHaveText('Setup');
  await tab(page, /^Setup/).click();
  await modal.getByLabel('git', { exact: true }).check();
  await modal.getByLabel('Oh My Zsh').check();
  await tab(page, /^Box/).click();
  await expect(page.getByRole('tab', { name: 'Setup, 2 selected' })).toHaveText('Setup2');

  await tab(page, /^Agents/).click();
  await expect(modal.getByRole('button', { name: 'Add project' })).toBeEnabled({ timeout: 10000 });
  await modal.getByRole('button', { name: 'Add project' }).click();
  await tab(page, /^Box/).click();
  await expect(page.getByRole('tab', { name: 'Agents, unsaved changes' })).toHaveText('Agentsedited');

  // Nothing was saved: Cancel leaves the box as it was.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toHaveCount(0);
});

test('Add Box has no Agents tab, shows its default setup selection on the tab, and a refusal returns to the field', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '+ Add box' }).click();
  await expect(page.getByRole('heading', { name: 'Add box' })).toBeVisible();
  const modal = page.locator('.modal.box-modal');

  await expect(modal.getByRole('tab')).toHaveCount(2);
  // Oh My Tmux is ticked by default on a new box, on a tab that is not open.
  await expect(page.getByRole('tab', { name: 'Setup, 1 selected' })).toBeVisible();

  // Submitting from the Setup tab with no host: the message is in the footer and
  // the field it names is back on screen, focused.
  await tab(page, /^Setup/).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(modal.locator('.err')).toHaveText('Host is required');
  await expect(tab(page, /^Box/)).toHaveAttribute('aria-selected', 'true');
  await expect(modal.getByLabel('Host or alias')).toBeFocused();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Add box' })).toHaveCount(0);
});

test('a setting made on the Agents tab is saved by the one Save, from another tab', async ({ page }) => {
  await login(page);
  const boxes = (await (await page.request.get('/api/boxes')).json()) as { id: string; label: string }[];
  const id = boxes.find((b) => b.label === 'untagged-worker')!.id;
  const before = (await (await page.request.get(`/api/boxes/${id}/workers`)).json()).workers;
  try {
    const modal = await openEdit(page);
    await tab(page, /^Agents/).click();
    const max = modal.locator('.wk-max');
    await expect(max).toBeVisible({ timeout: 10000 });
    await max.fill(String(before.max === 5 ? 4 : 5));
    await tab(page, /^Box/).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: 'Edit box' })).toHaveCount(0, { timeout: 10000 });
    await expect.poll(async () => (await (await page.request.get(`/api/boxes/${id}/workers`)).json()).workers.max).toBe(before.max === 5 ? 4 : 5);
  } finally {
    await page.request.put(`/api/boxes/${id}/workers`, { data: before });
  }
});
