import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(
  readFileSync(new URL('./packages/frontend-sdk/package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  define: { __SDK_VERSION__: JSON.stringify(version) },
  // The examples import the SDK by package name; tests run it from source, before any build.
  resolve: {
    alias: [{ find: /^@bcbp-solutions-fzc-llc\/frontend-sdk\/([a-z0-9]+)$/, replacement: new URL('./packages/frontend-sdk/src/$1/index.ts', import.meta.url).pathname }],
  },
  test: {
    environment: 'node',
    // test/smoke is left out, as in platform-gincommon: it may target a deployed shell (`pnpm run test-smoke`).
    include: ['test/{unit,integration,e2e}/**/*.test.{ts,tsx}', 'examples/*/test/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    setupFiles: ['test/testenv/index.ts'],
    coverage: {
      provider: 'v8',
      // The published packages' sources: the coverage gate (.github/scripts/coverage-gate.sh)
      // measures these. Examples and scripts are tested but not gated.
      include: ['packages/*/src/**'],
      reporter: ['text-summary', 'json-summary', 'html'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
    },
  },
});
