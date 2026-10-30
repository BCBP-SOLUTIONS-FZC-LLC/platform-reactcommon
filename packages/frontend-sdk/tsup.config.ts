import { defineConfig } from 'tsup';
import { implementedSubpaths } from '../../scripts/lib/subpaths.ts';

// One entry per implemented subpath (src/<name>/index.ts) plus the throwing root. Output keeps the
// subpath folders (dist/<name>/index.js) so the exports map can point at them; shared code goes to
// split chunks so subpaths never duplicate module state.
const entry: Record<string, string> = { root: 'src/root.ts' };
for (const name of implementedSubpaths()) entry[`${name}/index`] = `src/${name}/index.ts`;

export default defineConfig({
  entry,
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  dts: true,
  splitting: true,
  treeshake: true,
  sourcemap: true,
  clean: true,
  // Peer dependencies are provided by the host (Module Federation shares them).
  external: ['react', 'react-dom', /^@opentelemetry\/api$/],
});
