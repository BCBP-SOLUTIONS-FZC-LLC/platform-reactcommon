// The tenders remote: exposes ./EditTender; the SDK always comes from the shell (import: false).
import { fileURLToPath } from 'node:url';
import { platformWebpackConfig } from '@platform/webpack-preset';

export default function config(mode = 'production') {
  const preset = platformWebpackConfig({ role: 'remote', name: 'tenders', exposes: { './EditTender': './src/EditTender.tsx' }, mode });
  return {
    ...preset,
    context: fileURLToPath(new URL('.', import.meta.url)),
    entry: {},
    output: { ...preset.output, path: fileURLToPath(new URL('./dist', import.meta.url)), clean: true },
    resolve: { extensions: ['.tsx', '.ts', '.js'] },
    module: {
      rules: [{ test: /\.tsx?$/, loader: 'esbuild-loader', options: { target: 'es2022', jsx: 'automatic' } }],
    },
  };
}
