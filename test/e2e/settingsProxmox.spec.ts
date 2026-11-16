import { test, expect, type Page } from '@playwright/test';
import { startFakePve } from '../helpers/fakePve.js';

// Settings → Proxmox end to end (settingsProxmox.ts over settingsProxmoxView.ts).
// The pure half is unit-tested; what only a browser can show lives here: Enter
// submits a real <form>, a host that stops answering is reported in words in its
// row, an edit to the endpoint drops the inspection, a remove needs two presses,
// and only one form is open at a time.
//
// Everything is the real server and the real store; the only stand-in is the
// Proxmox API itself (helpers/fakePve.js), an HTTPS server with a self-signed
// certificate, so Inspect and the pin are the genuine article. Each test gets a
// fresh one, because stopping it is how a host is made to fail.

async function login(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

async function openProxmox(page: Page) {
  await page.click('#settings');
  await page.click('[data-tab="proxmox"]');
  await expect(page.locator('.pvs-section').first()).toBeVisible();
}

// The shared e2e server keeps its store between specs: every host this file makes is
// named e2e-*, and is removed before and after each test.
async function dropE2eHosts(page: Page) {
  const hosts: { id: string; name: string }[] = await (await page.request.get('/api/proxmox/hosts')).json();
  for (const h of hosts) if (h.name.startsWith('e2e-')) await page.request.delete(`/api/proxmox/hosts/${h.id}`);
}

// Add through the API the way the form would: inspect, then pin what it reports.
async function addHostViaApi(page: Page, name: string, endpoint: string) {
  const inspected = await (await page.request.post('/api/proxmox/inspect', { data: { endpoint } })).json();
  const r = await page.request.post('/api/proxmox/hosts', {
    data: { name, endpoint, tokenId: 'root@pam!e2e', tokenSecret: 'secret', verifyMode: 'pin', fingerprint256: inspected.fingerprint256, defaultNode: null },
  });
  expect(r.ok(), await r.text()).toBe(true);
}

let pve: Awaited<ReturnType<typeof startFakePve>>;

test.beforeEach(async ({ page }) => {
  pve = await startFakePve();
  await login(page);
  await dropE2eHosts(page);
});
test.afterEach(async ({ page }) => {
  await dropE2eHosts(page);
  await pve.close();
});

test('a host added with Enter lands in the list, pinned, and its row says it is reachable', async ({ page }) => {
  await openProxmox(page);

  // No hosts yet, so the form is already open and has nothing to cancel back to.
  const form = page.locator('form[aria-label="Add a Proxmox host"]');
  await expect(form).toBeVisible();
  await expect(form.getByRole('button', { name: 'Cancel' })).toHaveCount(0);

  await form.getByLabel('Endpoint').fill(pve.endpoint);
  await form.getByRole('button', { name: 'Inspect' }).click();
  await expect(form.locator('.pvs-cert.pin')).toContainText('Self-signed');
  await expect(form.locator('.pvs-fp')).toHaveText(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  await form.getByLabel('Name', { exact: true }).fill('e2e-add');
  await form.getByLabel('Token id').fill('root@pam!e2e');
  await form.getByLabel('Token secret').fill('secret');
  await form.getByLabel('Token secret').press('Enter');   // a real <form>: Enter commits

  await expect(page.locator('.pvs-notice')).toHaveText('Added e2e-add.');
  const row = page.locator('.pvs-row', { hasText: 'e2e-add' });
  await expect(row).toBeVisible();
  await expect(row.locator('.pve-badge', { hasText: 'pinned' })).toBeVisible();
  // Every host is tested when the tab opens: the lamp and the line say what came back.
  await expect(row.locator('.pvs-row-state')).toHaveText('Reachable · PVE 8.2.4', { timeout: 15000 });
  await expect(row.locator('.dot.green')).toBeVisible();
});

test('a host that stops answering is reported in words in its row, not in a tooltip', async ({ page }) => {
  await addHostViaApi(page, 'e2e-down', pve.endpoint);
  await pve.close();
  await openProxmox(page);

  const row = page.locator('.pvs-row', { hasText: 'e2e-down' });
  const state = row.locator('.pvs-row-state.bad');
  await expect(state).toBeVisible({ timeout: 15000 });
  await expect(state).toContainText('ECONNREFUSED');   // the server's own error, verbatim
  await expect(row.locator('.dot.red')).toBeVisible();
  // Test runs it again and reports again.
  await row.getByRole('button', { name: /Test e2e-down/ }).click();
  await expect(state).toContainText('ECONNREFUSED');
});

test('editing the endpoint after Inspect throws the inspection away', async ({ page }) => {
  await openProxmox(page);
  const form = page.locator('form[aria-label="Add a Proxmox host"]');

  await form.getByLabel('Endpoint').fill(pve.endpoint);
  await form.getByRole('button', { name: 'Inspect' }).click();
  await expect(form.locator('.pvs-cert.pin')).toBeVisible();
  const fingerprint = (await form.locator('.pvs-fp').textContent()) ?? '';
  expect(fingerprint).not.toBe('');

  // A fingerprint belongs to one address: a different endpoint must not inherit the pin.
  await form.getByLabel('Endpoint').fill('127.0.0.1:10');
  await expect(form.locator('.pvs-cert')).not.toHaveClass(/pin/);
  await expect(form.locator('.pvs-cert')).not.toContainText(fingerprint);

  await form.getByLabel('Name', { exact: true }).fill('e2e-stale');
  await form.getByLabel('Token id').fill('root@pam!e2e');
  await form.getByLabel('Token secret').fill('secret');
  await form.locator('button[type=submit]').click();
  await expect(form.locator('.pvs-form-err')).toContainText('Inspect the endpoint first');
  await expect(page.locator('.pvs-row', { hasText: 'e2e-stale' })).toHaveCount(0);
});

test('Remove needs two presses, and disarms on its own', async ({ page }) => {
  await addHostViaApi(page, 'e2e-rm', pve.endpoint);
  await openProxmox(page);
  const row = page.locator('.pvs-row', { hasText: 'e2e-rm' });
  const remove = row.getByRole('button', { name: /Remove e2e-rm/ });

  await remove.click();
  await expect(remove).toHaveText('Really remove?');
  await expect(row).toBeVisible();                                  // one press removes nothing
  await expect(remove).toHaveText('Remove', { timeout: 6000 });     // ARM_MS later it is idle again

  await remove.click();
  await remove.click();
  await expect(page.locator('.pvs-notice')).toHaveText('Removed e2e-rm.');
  await expect(page.locator('.pvs-row', { hasText: 'e2e-rm' })).toHaveCount(0);
});

test('only one form is open at a time, and Cancel hands focus back to its key', async ({ page }) => {
  await addHostViaApi(page, 'e2e-one', pve.endpoint);
  await openProxmox(page);
  const hostForm = page.locator('form[aria-label="Add a Proxmox host"]');
  const keyForm = page.locator('form[aria-label="Add an SSH key"]');

  await expect(hostForm).toHaveCount(0);                 // closed behind its key while hosts exist
  await page.getByRole('button', { name: '+ Add host' }).click();
  await expect(hostForm).toBeVisible();
  await expect(hostForm.getByLabel('Endpoint')).toBeFocused();

  await page.getByRole('button', { name: '+ Add key' }).click();
  await expect(hostForm).toHaveCount(0);
  await expect(keyForm).toBeVisible();
  // One form, so one commit key in the panel.
  await expect(page.locator('.pvs-form button[type=submit]')).toHaveCount(1);

  await keyForm.getByRole('button', { name: 'Cancel' }).click();
  await expect(keyForm).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ Add key' })).toBeFocused();
});
