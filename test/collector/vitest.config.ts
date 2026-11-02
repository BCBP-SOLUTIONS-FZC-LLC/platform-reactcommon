// `pnpm test-collector`: the reference Collector configuration in the real Collector image (needs Docker).
// Kept out of `pnpm test`, which runs without Docker.
import { defineConfig } from 'vitest/config';
import base from '../../vitest.config.ts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/collector/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
