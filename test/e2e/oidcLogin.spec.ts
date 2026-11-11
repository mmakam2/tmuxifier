import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { startOidcStub } from '../helpers/oidcStub.js';
import { hashPassword } from '../../src/server/auth.js';

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
      TMUXIFIER_OIDC_PROVIDERS: 'authentik',
      TMUXIFIER_OIDC_AUTHENTIK_ISSUER: stub.issuer,
      TMUXIFIER_OIDC_AUTHENTIK_CLIENT_ID: 'cid',
      TMUXIFIER_OIDC_AUTHENTIK_CLIENT_SECRET: 'secret',
      TMUXIFIER_ALLOWED_EMAILS: 'you@example.com',
      TMUXIFIER_BASE_EXTERNAL_URL: BASE,
      TMUXIFIER_PUBLIC_URL: '',
      TMUXIFIER_PASSWORD_HASH: await hashPassword('e2e'),
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

test('auto-redirect signs in, logout shows signed-out page, ?login password break-glass works', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.layout')).toBeVisible({ timeout: 15000 });

  await page.click('#logout');
  await expect(page.locator('.layout')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.layout')).toHaveCount(0);

  await page.goto('/?login');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.layout')).toBeVisible({ timeout: 15000 });
});
