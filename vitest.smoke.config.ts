// The smoke suite (test/smoke, `pnpm run test-smoke`), left out of the default run as in
// platform-gincommon: in-process against the built examples by default, or read-only against a
// deployed shell when SMOKE_BASE_URL is set (test/testenv).
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

const merged = mergeConfig(
  base,
  defineConfig({
    test: {
      environment: 'node',
      // Network round trips to a deployed distribution; generous, but a hung origin still fails.
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);

// mergeConfig concatenates arrays: replace the file lists instead of adding to the default run's.
merged.test = { ...merged.test, include: ['test/smoke/**/*.test.ts'], setupFiles: ['test/testenv/index.ts'] };

export default merged;
