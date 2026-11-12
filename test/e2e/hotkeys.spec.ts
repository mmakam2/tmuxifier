import { test, expect, type Page, type Request } from '@playwright/test';

// Settings → Hotkeys end to end (settingsHotkeys.ts over hotkeys.ts): record a
// new chord for the agent switcher or voice dictation, see why a refused one is
// refused, reset to the default. Mappings live in this browser's localStorage
// ('tmuxifier.hotkeys') and never reach the server.
//
// The switcher is inert while any modal is open, so every "the chord opens it"
// check closes Settings first. It needs no agent session to exist: with none it
// still attaches #agent-switcher, reading "No other agent sessions". Every
// chord is ended with Escape BEFORE the modifiers are released, so a release can
// never commit a row and move a pane.

const STORE = 'tmuxifier.hotkeys';

async function login(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

async function reloadWorkspace(page: Page) {
  await page.reload();
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await page.evaluate((k) => localStorage.removeItem(k), STORE);
  await reloadWorkspace(page);
});

async function openHotkeys(page: Page) {
  await page.click('#settings');
  await page.click('[data-tab="hotkeys"]');
  await expect(page.locator('.hotkey-row')).toHaveCount(2);
}

const row = (page: Page, action: 'switcher' | 'voice') => page.locator(`.hotkey-row[data-action="${action}"]`);

async function closeSettings(page: Page) {
  await page.locator('.settings-modal .pve-close').click();
  await expect(page.locator('.settings-modal')).toHaveCount(0);
}

async function startRecording(page: Page, action: 'switcher' | 'voice') {
  const rec = row(page, action).locator('.hotkey-record');
  await rec.click();
  await expect(rec).toHaveText('Press a combo…');
  await expect(rec).toHaveAttribute('aria-pressed', 'true');
}

// Press a chord as held modifiers + one key ('Control+Shift+KeyY').
async function chord(page: Page, combo: string) {
  const parts = combo.split('+');
  const key = parts.pop()!;
  for (const m of parts) await page.keyboard.down(m);
  try {
    await page.keyboard.press(key);
  } finally {
    for (const m of parts.reverse()) await page.keyboard.up(m);
  }
}

async function readStore(page: Page): Promise<unknown> {
  const raw = await page.evaluate((k) => localStorage.getItem(k), STORE);
  return raw === null ? null : JSON.parse(raw);
}

// Hold Ctrl+Shift, press `code`: the switcher must attach. Escape before the
// release, so nothing commits.
async function expectChordOpens(page: Page, code: string) {
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  try {
    await page.keyboard.press(code);
    await expect(page.locator('#agent-switcher')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#agent-switcher')).toHaveCount(0);
  } finally {
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
  }
}

// Whether #agent-switcher was EVER attached since this call — read off the
// mutation records, so a mount and unmount within one task still counts.
async function watchAttach(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __swAttached: boolean };
    w.__swAttached = false;
    new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) if ((n as Element).id === 'agent-switcher') w.__swAttached = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
}
const everAttached = (page: Page) => page.evaluate(() => (window as unknown as { __swAttached: boolean }).__swAttached);

// Hold Ctrl+Shift, press `code`, hold past the overlay's paint delay: the
// switcher must never attach.
async function expectChordInert(page: Page, code: string) {
  await watchAttach(page);
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  try {
    await page.keyboard.press(code);
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
  } finally {
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
  }
  expect(await everAttached(page)).toBe(false);
  await expect(page.locator('#agent-switcher')).toHaveCount(0);
}

test('the Hotkeys tab is last and shows both defaults', async ({ page }) => {
  await openHotkeys(page);
  await expect(page.locator('.settings-modal .pve-tab').last()).toHaveText('Hotkeys');
  await expect(row(page, 'switcher').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+K');
  await expect(row(page, 'voice').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+Space');
  await expect(row(page, 'switcher')).toContainText('Agent switcher');
  await expect(row(page, 'voice')).toContainText('Voice dictation (toggle)');
  for (const r of [row(page, 'switcher'), row(page, 'voice')]) {
    await expect(r.locator('.hotkey-record')).toHaveText('Record');
    await expect(r.locator('.hotkey-reset')).toHaveText('Reset to default');
    await expect(r.locator('.hotkey-error')).toHaveAttribute('role', 'alert');
  }
  const notes = page.locator('.settings-modal .pve-content .pve-sub');
  await expect(notes.filter({ hasText: 'These mappings apply to this browser only.' })).toHaveCount(1);
  await expect(notes.filter({
    hasText: 'Some browsers keep certain combos for themselves. Edge and Firefox on Windows use Ctrl+Shift+K for "duplicate tab" and the web console. If the switcher doesn\'t respond, record another combo.',
  })).toHaveCount(1);
});

test('a remapped switcher combo works and the old one no longer opens it', async ({ page }) => {
  await openHotkeys(page);
  await startRecording(page, 'switcher');
  await chord(page, 'Control+Shift+KeyY');
  await expect(row(page, 'switcher').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+Y');
  await expect(row(page, 'switcher').locator('.hotkey-record')).toHaveText('Record');
  await closeSettings(page);
  await expectChordOpens(page, 'KeyY');
  await expectChordInert(page, 'KeyK');
});

test('the mapping is stored per browser and survives a reload', async ({ page }) => {
  const patches: Request[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/ui-settings') && r.method() === 'PATCH') patches.push(r);
  });
  await openHotkeys(page);
  await startRecording(page, 'switcher');
  await chord(page, 'Control+Shift+KeyY');
  await expect(row(page, 'switcher').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+Y');
  expect(await readStore(page)).toEqual({ v: 1, switcher: { alt: false, code: 'KeyY' }, voice: { alt: false, code: 'Space' } });
  await closeSettings(page);
  await reloadWorkspace(page);
  await openHotkeys(page);
  await expect(row(page, 'switcher').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+Y');
  await closeSettings(page);
  await expectChordOpens(page, 'KeyY');
  expect(patches.map((r) => r.url())).toEqual([]);
});

test('Esc while recording cancels the recording and leaves Settings open', async ({ page }) => {
  await openHotkeys(page);
  await startRecording(page, 'switcher');
  await page.keyboard.press('Escape');
  const rec = row(page, 'switcher').locator('.hotkey-record');
  await expect(rec).toHaveText('Record');
  await expect(rec).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.settings-modal')).toBeVisible();
  await expect(row(page, 'switcher').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+K');
  expect(await readStore(page)).toBeNull();
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings-modal')).toHaveCount(0);
});

test('refused combos say why and keep recording', async ({ page }) => {
  await openHotkeys(page);
  await startRecording(page, 'switcher');
  const err = row(page, 'switcher').locator('.hotkey-error');
  const rec = row(page, 'switcher').locator('.hotkey-record');
  const combo = row(page, 'switcher').locator('.hotkey-combo');

  await chord(page, 'Control+KeyK');
  await expect(err).toContainText('Hotkeys must include Ctrl+Shift, so terminal keys like Ctrl+K and Alt+letter stay free.');
  await expect(rec).toHaveText('Press a combo…');

  await chord(page, 'Control+Shift+KeyC');
  await expect(err).toContainText('Ctrl+Shift+C and Ctrl+Shift+V are copy and paste in the terminal.');
  await expect(rec).toHaveText('Press a combo…');

  await chord(page, 'Control+Shift+KeyT');
  await expect(err).toHaveText('Browsers keep Ctrl+Shift+T for themselves.');
  await expect(rec).toHaveText('Press a combo…');

  await chord(page, 'Control+Shift+Space');
  await expect(err).toContainText('That combo is already used by Voice dictation (toggle).');
  await expect(rec).toHaveText('Press a combo…');
  await expect(combo).toHaveText('Ctrl+Shift+K');
  expect(await readStore(page)).toBeNull();

  await chord(page, 'Control+Shift+KeyY');
  await expect(combo).toHaveText('Ctrl+Shift+Y');
  await expect(rec).toHaveText('Record');
  await expect(err).toHaveText('');
  await expect(page.locator('.settings-modal')).toBeVisible();
});

test('recording suppresses the live switcher hotkey', async ({ page }) => {
  await openHotkeys(page);
  await startRecording(page, 'voice');
  await watchAttach(page);
  await chord(page, 'Control+Shift+KeyK');
  // The recorder read the chord (it is the switcher's combo, so it is refused)...
  await expect(row(page, 'voice').locator('.hotkey-error')).toContainText('That combo is already used by Agent switcher.');
  await expect(row(page, 'voice').locator('.hotkey-record')).toHaveText('Press a combo…');
  await page.waitForTimeout(500);
  // ...and the switcher never saw it.
  expect(await everAttached(page)).toBe(false);
  await expect(page.locator('#agent-switcher')).toHaveCount(0);
  await expect(row(page, 'voice').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+Space');
  await page.keyboard.press('Escape');
  await expect(row(page, 'voice').locator('.hotkey-record')).toHaveText('Record');
});

test('Reset to default restores the combo', async ({ page }) => {
  await openHotkeys(page);
  const swReset = row(page, 'switcher').locator('.hotkey-reset');
  await startRecording(page, 'switcher');
  await chord(page, 'Control+Shift+KeyY');
  await expect(row(page, 'switcher').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+Y');
  // The voice row takes the switcher's default, so resetting the switcher is refused.
  await startRecording(page, 'voice');
  await chord(page, 'Control+Shift+KeyK');
  await expect(row(page, 'voice').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+K');
  await swReset.click();
  await expect(row(page, 'switcher').locator('.hotkey-error')).toContainText('That combo is already used by Voice dictation (toggle).');
  await expect(row(page, 'switcher').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+Y');
  // Freeing it makes the reset go through.
  await row(page, 'voice').locator('.hotkey-reset').click();
  await expect(row(page, 'voice').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+Space');
  await swReset.click();
  await expect(row(page, 'switcher').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+K');
  await expect(row(page, 'switcher').locator('.hotkey-error')).toHaveText('');
  expect(await readStore(page)).toEqual({ v: 1, switcher: { alt: false, code: 'KeyK' }, voice: { alt: false, code: 'Space' } });
  await closeSettings(page);
  await expectChordOpens(page, 'KeyK');
});

test('leaving the tab mid-record stops recording', async ({ page }) => {
  await openHotkeys(page);
  await startRecording(page, 'switcher');
  await page.click('[data-tab="appearance"]');
  await expect(page.locator('.hotkey-row')).toHaveCount(0);
  await closeSettings(page);
  await expectChordOpens(page, 'KeyK');
  // And the recorder is gone: a chord it would have stored changed nothing.
  await chord(page, 'Control+Shift+KeyY');
  expect(await readStore(page)).toBeNull();
});

test('a stored mapping that is no longer valid falls back to the default', async ({ page }) => {
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({
    v: 1, switcher: { alt: false, code: 'KeyT' }, voice: { alt: false, code: 'Space' },
  })), STORE);
  await reloadWorkspace(page);
  await openHotkeys(page);
  await expect(row(page, 'switcher').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+K');
  await expect(row(page, 'voice').locator('.hotkey-combo')).toHaveText('Ctrl+Shift+Space');
  await closeSettings(page);
  await expectChordOpens(page, 'KeyK');
});
