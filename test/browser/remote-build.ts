// Builds examples/remote-tenders in production with the webpack preset from source (CI's browser job
// builds no packages) into .build/remote, for integrity.spec.ts: the real remote, its real lazy chunks
// and the integrity map ChunkIntegrityPlugin puts in its remoteEntry.js.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import webpack from 'webpack';
import { integrityOf, platformWebpackConfig } from '../../packages/webpack-preset/src/index.ts';

const EXAMPLE = join(import.meta.dirname, '..', '..', 'examples', 'remote-tenders');

export async function buildRemote(out: string): Promise<{ entryIntegrity: string }> {
  const preset = platformWebpackConfig({ role: 'remote', name: 'tenders', exposes: { './EditTender': './src/EditTender.tsx' }, mode: 'production' });
  const loader = createRequire(join(EXAMPLE, 'package.json')).resolve('esbuild-loader');
  const stats = await new Promise<webpack.Stats>((resolve, reject) =>
    webpack(
      {
        ...preset,
        context: EXAMPLE,
        entry: {},
        output: { ...preset.output, path: out, clean: true },
        resolve: { extensions: ['.tsx', '.ts', '.js'] },
        module: { rules: [{ test: /\.tsx?$/, loader, options: { target: 'es2022', jsx: 'automatic' } }] },
      },
      (err, s) => (err ? reject(err) : resolve(s!)),
    ),
  );
  if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }));
  const { readFileSync } = await import('node:fs');
  return { entryIntegrity: integrityOf(readFileSync(join(out, 'remoteEntry.js'))) };
}
