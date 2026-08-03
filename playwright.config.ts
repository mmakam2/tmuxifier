import { defineConfig, devices } from '@playwright/test';

// Two projects against ONE server (globalSetup spins it once, and workers: 1
// keeps them from racing over the single shared tmux session the fixture box
// runs). The split is by viewport class, not by browser: Pixel 5 is a Chromium
// device profile, so the phone project installs nothing extra.
//
// Everything phone-shaped is matched by name, and the desktop project ignores
// exactly the same pattern — one constant, so a new phone spec can never end up
// running in both projects (at 1280px the drawer, the switcher and the key bar
// are all display: none, so it would fail there) or in neither.
const PHONE_SPECS = /(phone|touchBar)\.spec\.ts/;

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  globalSetup: './test/e2e/global-setup.js',
  use: {
    baseURL: 'http://127.0.0.1:7438',
  },
  projects: [
    { name: 'desktop', testIgnore: PHONE_SPECS },
    // touchBar.spec.ts sets its own viewport/hasTouch per describe block (it
    // measures three specific phone widths); Pixel 5 is the default for
    // everything that does not.
    { name: 'phone', use: { ...devices['Pixel 5'] }, testMatch: PHONE_SPECS },
  ],
});
