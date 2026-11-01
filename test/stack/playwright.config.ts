// The integrated-deployment suite (docs/e2e/integrated-deployment-report.md): the real example shell in
// Chromium, Firefox and WebKit against the stack of test/stack/compose.yml (Keycloak, Envoy + the real IAM
// services, floci CloudFront/S3/Lambda + the edge shim, the OTel Collector).
//
//   pnpm run stack-up          # once; builds and starts everything (several minutes the first time)
//   pnpm run test-stack        # this suite
//   pnpm run stack-down
//
// Serial on purpose: every test shares one Keycloak, one gateway rate-limit bucket and one Collector
// output. The `gateway` project runs last (it exhausts the PUB-1 rate limit and rotates a realm key).
import { defineConfig, devices } from '@playwright/test';
import { STACK } from './stack-constants.ts';

export default defineConfig({
  testDir: '.',
  testMatch: 'e2e.spec.ts',
  outputDir: '../../test-results/stack',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: '../../test-results/stack/results.json' }]],
  use: {
    baseURL: STACK.appOrigin,
    // The edge serves a self-signed certificate for app./auth.localtest.me.
    ignoreHTTPSErrors: true,
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', grepInvert: /@gateway/, use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', grepInvert: /@gateway/, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', grepInvert: /@gateway/, use: { ...devices['Desktop Safari'] } },
    { name: 'gateway', grep: /@gateway/, dependencies: ['chromium', 'firefox', 'webkit'], use: { ...devices['Desktop Chrome'] } },
  ],
});
