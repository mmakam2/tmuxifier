import { test, expect } from '@playwright/test';

// First behavioural coverage of the Edit Box modal's session/window picker.
// Every existing sessionDropdown.spec.ts locator is scoped to `.stage-pane`
// (the pane header's own picker) — the modal, which carries its own
// `picked`/`lastPick`/`windowPending` state machine, had none at all. These
// two cover the paths a whole-branch review found broken in combination:
// a kill from the modal leaving Save free to write a session the operator
// never chose, and Create New Session… losing focus of the name field the
// instant it's picked. Full modal coverage (window picks, Save itself
// writing the right name) is a follow-up; what must not ship is two
// just-fixed defects with nothing pinning them.
//
// Deliberately does not go through any docked terminal pane at all — the
// throwaway session is created straight over the same API the modal's own
// Create New Session… button calls, so this file needs no `.stage-pane` and
// no shell typing.

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

async function openEditModal(page) {
  await page.locator('.box', { hasText: 'localhost' }).locator('.edit').click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toBeVisible();
  return page.locator('.modal.box-modal');
}

test('killing a session from the modal picker removes it from the list', async ({ page }) => {
  await login(page);
  const boxId = await page.locator('.box', { hasText: 'localhost' }).first().getAttribute('data-id');
  expect(boxId).toBeTruthy();

  try {
    // Created straight over the API — NOT through the modal's own Create New
    // Session… field. Typing a name into that field and clicking Create
    // leaves the name sitting in sessionInput.value even after the row is
    // hidden again, and applySessions() gives that value PRIORITY over
    // box.sessionName as the "this box's own session" hint — so
    // sessionTargets() would keep re-emitting a row for it on every future
    // probe forever, regardless of whether the kill below actually worked.
    // Creating it out-of-band avoids ever touching that field.
    const created = await page.request.post(`/api/boxes/${boxId}/sessions`, { data: { name: 'e2emodalkill' } });
    expect(created.ok()).toBeTruthy();

    const modal = await openEditModal(page);
    const picker = modal.locator('.session-picker');

    // The modal's initial picker content is the cached status snapshot, not
    // a live probe — refresh so the just-created session shows up.
    await modal.locator('[title="Fetch live tmux sessions from the host"]').click();
    await picker.locator('.session-picker-trigger').click();
    const row = picker.locator('.session-picker-row', { hasText: 'e2emodalkill' });
    await expect(row).toHaveCount(1, { timeout: 10000 });

    // Arm then fire its ×.
    const kill = row.locator('.session-picker-kill');
    await kill.click();
    await expect(row.locator('.session-picker-kill.armed')).toHaveCount(1);
    await kill.click();

    await expect(picker.locator('.session-picker-row', { hasText: 'e2emodalkill' })).toHaveCount(0, { timeout: 15000 });

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Edit box' })).toHaveCount(0);
  } finally {
    // Straight at the API, not back through the UI: if any assertion above
    // threw before the committing click fired, e2emodalkill would otherwise
    // survive as a detached session with no pane in this file to reach it
    // from. A no-op once the row's own kill already committed.
    await page.request.post(`/api/boxes/${boxId}/kill`, { data: { session: 'e2emodalkill' } }).catch(() => {});
  }
});

test('picking Create New Session… leaves focus in the name field', async ({ page }) => {
  await login(page);

  const modal = await openEditModal(page);
  const picker = modal.locator('.session-picker');

  await picker.locator('.session-picker-trigger').click();
  await picker.locator('.session-picker-pick', { hasText: 'Create New Session' }).click();

  // closePop() (called by the picker itself before onSelect) sends focus to
  // the trigger first; without the CUSTOM-row focus fix, the name field is
  // revealed and then abandoned there instead.
  const nameField = modal.getByLabel('New tmux session name');
  await expect(nameField).toBeVisible();
  await expect(nameField).toBeFocused();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toHaveCount(0);
});
