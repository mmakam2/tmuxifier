import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { startOidcStub } from '../helpers/oidcStub.js';

const PORT = 7439;
const BASE = `http://127.0.0.1:${PORT}`;

let stub: any;
let server: ChildProcess;
let dataDir: string;

test.use({ baseURL: BASE });

test.beforeAll(async () => {
  stub = await startOidcStub();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-e2e-oidc-'));
  server = spawn('node', ['src/server/index.js'], {
    env: {
      ...process.env,
      TMUXIFIER_AUTH_MODE: 'oidc',
      // An id no real deployment configures: the spawned server still reads the
      // checkout's .env, and a real provider's _ALLOWED_EMAILS/_LABEL/
      // _ALLOW_UNVERIFIED_EMAIL under a shared id would leak into this one.
      TMUXIFIER_OIDC_PROVIDERS: 'e2e-stub',
      TMUXIFIER_OIDC_E2E_STUB_ISSUER: stub.issuer,
      TMUXIFIER_OIDC_E2E_STUB_CLIENT_ID: 'cid',
      TMUXIFIER_OIDC_E2E_STUB_CLIENT_SECRET: 'secret',
      TMUXIFIER_ALLOWED_EMAILS: 'you@example.com',
      TMUXIFIER_BASE_EXTERNAL_URL: BASE,
      TMUXIFIER_PUBLIC_URL: '',
      TMUXIFIER_PASSWORD_HASH: '',
      TMUXIFIER_OAUTH_CLIENT_ID: '',
      TMUXIFIER_OAUTH_CLIENT_SECRET: '',
      TMUXIFIER_GOOGLE_CLIENT_ID: '',
      TMUXIFIER_GOOGLE_CLIENT_SECRET: '',
      TMUXIFIER_COOKIE_SECRET: 'e2e-oidc-secret',
      TMUXIFIER_BIND: '127.0.0.1',
      TMUXIFIER_PORT: String(PORT),
      TMUXIFIER_DATA_DIR: dataDir,
      TMUXIFIER_TLS_CERT: '',
      TMUXIFIER_TLS_KEY: '',
    },
    stdio: 'inherit',
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    try { if ((await fetch(`${BASE}/`)).status) break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error('OIDC server not ready');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.afterAll(async () => {
  server?.kill();
  await stub?.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const SIGNED_OUT = 'You have been signed out.';
const PROVIDER_BTN = 'a[data-provider="0"]';

test('auto-redirect signs in, logout shows signed-out page, ?login shows provider and signs back in', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.layout')).toBeVisible({ timeout: 15000 });

  await page.click('#logout');
  await expect(page.locator('.layout')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(SIGNED_OUT)).toBeVisible();
  await expect(page.locator(PROVIDER_BTN)).toBeVisible();
  await expect(page.locator('.layout')).toHaveCount(0);

  await page.goto('/?login');
  await expect(page.locator(PROVIDER_BTN)).toBeVisible();
  await expect(page.locator('#pw')).toHaveCount(0);
  await page.click(PROVIDER_BTN);
  await expect(page.locator('.layout')).toBeVisible({ timeout: 15000 });
  expect(await page.evaluate(() => localStorage.getItem('tmuxifier.signedOut'))).toBeNull();
});

test('logout in one tab keeps other and new tabs signed out', async ({ context }) => {
  const a = await context.newPage();
  await a.goto('/');
  await expect(a.locator('.layout')).toBeVisible({ timeout: 15000 });
  const b = await context.newPage();
  await b.goto('/');
  await expect(b.locator('.layout')).toBeVisible({ timeout: 15000 });

  await a.click('#logout');
  await expect(a.getByText(SIGNED_OUT)).toBeVisible();

  await b.reload();
  await expect(b.getByText(SIGNED_OUT)).toBeVisible();
  await expect(b.locator(PROVIDER_BTN)).toBeVisible();
  await expect(b.locator('.layout')).toHaveCount(0);

  const c = await context.newPage();
  await c.goto('/');
  await expect(c.getByText(SIGNED_OUT)).toBeVisible();
  await expect(c.locator('.layout')).toHaveCount(0);
});
