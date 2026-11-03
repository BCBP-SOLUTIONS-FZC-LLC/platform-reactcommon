import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', rspack: 'src/rspack.ts', rsbuild: 'src/rsbuild.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['webpack', '@rspack/core', '@rsbuild/core'],
});
