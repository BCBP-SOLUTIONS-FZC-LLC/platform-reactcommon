// Builds examples/remote-tenders in production with the preset from source (CI's browser job builds no
// packages), once with webpack into .build/remote and once with Rspack into .build/remote-rspack, for
// integrity.spec.ts: the real remote, its real lazy chunks and the integrity map ChunkIntegrityPlugin puts
// in its remoteEntry.js, from either bundler. buildStyledRemote does the same for a test remote with CSS
// (styled-remote/), into .build/styled and .build/styled-rspack.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { rspack } from '@rspack/core';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import webpack from 'webpack';
import { integrityOf, platformWebpackConfig } from '../../packages/webpack-preset/src/index.ts';
import { platformRspackConfig } from '../../packages/webpack-preset/src/rspack.ts';

const EXAMPLE = join(import.meta.dirname, '..', '..', 'examples', 'remote-tenders');
const options = { role: 'remote', name: 'tenders', exposes: { './EditTender': './src/EditTender.tsx' }, mode: 'production' } as const;

export type Bundler = 'webpack' | 'rspack';

function done(resolve: () => void, reject: (e: Error) => void) {
  return (err: Error | null, stats?: { hasErrors(): boolean; toString(o: object): string }) => {
    if (err) return reject(err);
    if (stats?.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
    resolve();
  };
}

export async function buildRemote(out: string, bundler: Bundler = 'webpack'): Promise<{ entryIntegrity: string }> {
  const common = { context: EXAMPLE, entry: {}, resolve: { extensions: ['.tsx', '.ts', '.js'] } };
  if (bundler === 'webpack') {
    const preset = platformWebpackConfig(options);
    const loader = createRequire(join(EXAMPLE, 'package.json')).resolve('esbuild-loader');
    await new Promise<void>((resolve, reject) =>
      webpack(
        {
          ...preset,
          ...common,
          output: { ...preset.output, path: out, clean: true },
          module: { rules: [{ test: /\.tsx?$/, loader, options: { target: 'es2022', jsx: 'automatic' } }] },
        },
        done(resolve, reject),
      ),
    );
  } else {
    const preset = platformRspackConfig(options);
    await new Promise<void>((resolve, reject) =>
      rspack(
        {
          ...preset,
          ...common,
          output: { ...preset.output, path: out, clean: true },
          module: {
            rules: [
              {
                test: /\.tsx?$/,
                loader: 'builtin:swc-loader',
                options: { jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' } },
              },
            ],
          },
        },
        done(resolve, reject),
      ),
    );
  }
  return { entryIntegrity: integrityOf(readFileSync(join(out, 'remoteEntry.js'))) };
}

const STYLED = join(import.meta.dirname, 'styled-remote');
const styledOptions = { role: 'remote', name: 'styled', exposes: { './Edit': './Edit.js' }, mode: 'production' } as const;

/**
 * Builds the styled test remote (styled-remote/: an exposed module importing a CSS module) in production:
 * with webpack and mini-css-extract-plugin, or with Rspack and CssExtractRspackPlugin (Rsbuild's default),
 * for integrity.spec.ts: its exposed chunk's CSS file must carry its sha384 too.
 */
export async function buildStyledRemote(out: string, bundler: Bundler = 'webpack'): Promise<{ entryIntegrity: string }> {
  const cssLoader = { loader: createRequire(import.meta.url).resolve('css-loader'), options: { modules: { auto: true, namedExport: false, exportLocalsConvention: 'as-is' } } };
  const common = { context: STYLED, entry: {} };
  if (bundler === 'webpack') {
    const preset = platformWebpackConfig(styledOptions);
    await new Promise<void>((resolve, reject) =>
      webpack(
        {
          ...preset,
          ...common,
          output: { ...preset.output, path: out, clean: true },
          module: { rules: [{ test: /\.css$/, use: [MiniCssExtractPlugin.loader, cssLoader] }] },
          plugins: [...preset.plugins!, new MiniCssExtractPlugin({ chunkFilename: '[name].[contenthash].css' })],
        },
        done(resolve, reject),
      ),
    );
  } else {
    const preset = platformRspackConfig(styledOptions);
    await new Promise<void>((resolve, reject) =>
      rspack(
        {
          ...preset,
          ...common,
          output: { ...preset.output, path: out, clean: true },
          module: { rules: [{ test: /\.css$/, use: [rspack.CssExtractRspackPlugin.loader, cssLoader], type: 'javascript/auto' }] },
          plugins: [...(preset.plugins ?? []), new rspack.CssExtractRspackPlugin({ chunkFilename: '[name].[contenthash].css' })],
        },
        done(resolve, reject),
      ),
    );
  }
  return { entryIntegrity: integrityOf(readFileSync(join(out, 'remoteEntry.js'))) };
}
