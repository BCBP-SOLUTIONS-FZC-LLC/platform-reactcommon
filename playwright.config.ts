// The real-browser smoke suite (test/browser/README.md): the SDK in Chromium, Firefox and WebKit,
// served with the production response headers. `pnpm run test-browser` runs all three;
// `pnpm run test-browser --project=webkit` runs one.
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'test/browser',
  // global-setup bundles the harness and starts the server (ephemeral port) for the whole run.
  globalSetup: './test/browser/global-setup.ts',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]] : 'list',
  use: {
    // test/browser/server.ts serves HTTPS with a throwaway self-signed certificate for 127.0.0.1.
    ignoreHTTPSErrors: true,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: CI ? 'on-first-retry' : 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
