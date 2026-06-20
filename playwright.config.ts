import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  globalSetup: './test/e2e/global-setup.js',
  use: {
    baseURL: 'http://127.0.0.1:7438',
  },
});
