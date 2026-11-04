// The shell: bundles the SDK and provides it, React and the OTel API to every remote.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import webpack from 'webpack';
import { platformWebpackConfig } from '@bcbp-solutions-fzc-llc/webpack-preset';
import { buildEnvironment } from './environment.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default function config(mode = 'production') {
  const environment = buildEnvironment(mode);
  const preset = platformWebpackConfig({ role: 'shell', mode });
  return {
    ...preset,
    context: fileURLToPath(new URL('.', import.meta.url)),
    entry: { main: './src/index.ts' },
    output: { ...preset.output, path: fileURLToPath(new URL('./dist', import.meta.url)), clean: true },
    resolve: { extensions: ['.tsx', '.ts', '.js'] },
    module: {
      rules: [{ test: /\.tsx?$/, loader: 'esbuild-loader', options: { target: 'es2022', jsx: 'automatic' } }],
    },
    plugins: [
      ...preset.plugins,
      new webpack.DefinePlugin({
        __ENVIRONMENT__: JSON.stringify(environment),
        __BUILD_VERSION__: JSON.stringify(process.env.BUILD_VERSION ?? pkg.version),
      }),
      // External script tags only: CSP script-src 'self' allows no inline script.
      new HtmlWebpackPlugin({ template: './src/index.html', inject: 'body', scriptLoading: 'defer' }),
    ],
  };
}
