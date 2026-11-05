// ChunkIntegrityPlugin and lazily loaded CSS: a remote whose exposed module imports a CSS module in a
// lazy chunk, built in production by every CSS loader the preset supports (mini-css-extract-plugin and
// native CSS on webpack; CssExtractRspackPlugin and native CSS on Rspack; Rsbuild's default extraction).
// Each runtime carries the CSS map and its loader sets link.integrity from it, failing closed; a build
// whose CSS loader sets none fails; the shell's index.html pins its stylesheets.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRsbuild } from '@rsbuild/core';
import { rspack, type RspackOptions } from '@rspack/core';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import webpack from 'webpack';
import { afterAll, describe, expect, it } from 'vitest';
import { integrityOf, platformWebpackConfig } from '../../../packages/webpack-preset/src/index.ts';
import { pluginPlatform } from '../../../packages/webpack-preset/src/rsbuild.ts';
import { platformRspackConfig } from '../../../packages/webpack-preset/src/rspack.ts';
import { SDK_SUBPATHS, SDK_VERSION } from '../../../packages/webpack-preset/src/generated/sdk.ts';

const dir = mkdtempSync(join(tmpdir(), 'preset-css-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Done = (err: Error | null, stats?: { hasErrors(): boolean; toString(o: object): string }) => void;
const run = (start: (done: Done) => void): Promise<void> =>
  new Promise((resolve, reject) =>
    start((err, stats) => {
      if (err) return reject(err);
      if (stats?.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
      resolve();
    }),
  );
const compileWebpack = (config: webpack.Configuration) => run((done) => webpack(config, done as never));
const compileRspack = (config: RspackOptions) => run((done) => rspack(config, done as never));

/** A remote whose exposed ./Edit loads, lazily, a module that imports a CSS module. */
/** `native`: the bundler's own CSS modules (named exports); otherwise css-loader's default export. */
function cssRemote(prefix: string, native = false): string {
  const root = mkdtempSync(join(dir, prefix));
  writeFileSync(join(root, 'Edit.js'), "export default async function Edit() { return (await import('./Styled.js')).box; }\n");
  writeFileSync(join(root, 'Styled.js'), `import ${native ? '* as styles' : 'styles'} from './Styled.module.css';\nexport const box = styles.box;\n`);
  writeFileSync(join(root, 'Styled.module.css'), '.box { color: rebeccapurple; padding: 4px; }\n');
  return root;
}

/** A stand-in SDK under `root`, for a shell build (the shell provides every subpath). */
function fakeSdk(root: string): void {
  const pkgDir = join(root, 'node_modules', '@bcbp-solutions-fzc-llc', 'frontend-sdk');
  mkdirSync(pkgDir, { recursive: true });
  const subpaths = SDK_SUBPATHS.filter((s) => s !== 'testing');
  const exports = Object.fromEntries(subpaths.map((s) => [`./${s}`, { import: `./${s}.js` }]));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@bcbp-solutions-fzc-llc/frontend-sdk', version: SDK_VERSION, type: 'module', sideEffects: true, exports }));
  for (const s of subpaths) writeFileSync(join(pkgDir, `${s}.js`), `export const subpath = '${s}';\n`);
}

const files = (out: string, ext: string) =>
  readdirSync(out, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(ext));
const cssMap = (runtime: string): Record<string, string> => JSON.parse(/sriCssHashes\s*=\s*(\{[^}]*\})/.exec(runtime)![1]!) as Record<string, string>;
/** The CSS loader sets the chunk's integrity from the map, failing closed for a chunk it has no hash for. */
const SETS_CSS_INTEGRITY = /\.integrity=[\w$]+\.sriCssHashes\[[\w$]+\]\|\|"sha384-A{64}"/;

/** Every lazily loaded CSS file of the build is in the runtime's CSS map with its sha384, and the loader enforces it. */
function expectCssPinned(out: string, runtimeFile: string): void {
  const runtime = readFileSync(join(out, runtimeFile), 'utf8');
  expect(runtime).not.toContain('__PLATFORM_CSS_INTEGRITY__');
  const css = files(out, '.css');
  expect(css.length).toBeGreaterThan(0);
  expect(Object.values(cssMap(runtime)).sort()).toEqual(css.map((f) => integrityOf(readFileSync(join(out, f)))).sort());
  expect(runtime).toMatch(SETS_CSS_INTEGRITY);
}

const cssModulesRule = (loader: string) => ({
  test: /\.css$/,
  use: [loader, { loader: createRequire(import.meta.url).resolve('css-loader'), options: { modules: { auto: true, namedExport: false, exportLocalsConvention: 'as-is' } } }],
});

describe('lazily loaded CSS: integrity', () => {
  it('webpack + mini-css-extract-plugin: the remote\'s lazy CSS is in remoteEntry.js\'s CSS map, and the link loader sets it', async () => {
    const root = cssRemote('mini-');
    const out = join(root, 'dist');
    const preset = platformWebpackConfig({ role: 'remote', name: 'css-mini', exposes: { './Edit': './Edit.js' }, mode: 'production' });
    await compileWebpack({
      ...preset,
      context: root,
      entry: {},
      output: { ...preset.output, path: out },
      module: { rules: [cssModulesRule(MiniCssExtractPlugin.loader)] },
      plugins: [...preset.plugins!, new MiniCssExtractPlugin({ chunkFilename: '[name].[contenthash].css' })],
    });
    expectCssPinned(out, 'remoteEntry.js');
  });

  it('webpack native CSS (experiments.css): the same', async () => {
    const root = cssRemote('wp-native-', true);
    const out = join(root, 'dist');
    const preset = platformWebpackConfig({ role: 'remote', name: 'css-wp-native', exposes: { './Edit': './Edit.js' }, mode: 'production' });
    await compileWebpack({
      ...preset,
      context: root,
      entry: {},
      output: { ...preset.output, path: out },
      experiments: { css: true },
      module: { rules: [{ test: /\.css$/, type: 'css/auto' }] },
    });
    expectCssPinned(out, 'remoteEntry.js');
  });

  it('Rspack + CssExtractRspackPlugin: the same', async () => {
    const root = cssRemote('rs-extract-');
    const out = join(root, 'dist');
    const preset = platformRspackConfig({ role: 'remote', name: 'css-rs-extract', exposes: { './Edit': './Edit.js' }, mode: 'production' });
    await compileRspack({
      ...preset,
      context: root,
      entry: {},
      output: { ...preset.output, path: out },
      module: { rules: [{ ...cssModulesRule(rspack.CssExtractRspackPlugin.loader), type: 'javascript/auto' }] },
      plugins: [...(preset.plugins ?? []), new rspack.CssExtractRspackPlugin({})],
    });
    expectCssPinned(out, 'remoteEntry.js');
  });

  it('Rspack native CSS: the same', async () => {
    const root = cssRemote('rs-native-', true);
    const out = join(root, 'dist');
    const preset = platformRspackConfig({ role: 'remote', name: 'css-rs-native', exposes: { './Edit': './Edit.js' }, mode: 'production' });
    await compileRspack({
      ...preset,
      context: root,
      entry: {},
      output: { ...preset.output, path: out },
      experiments: { css: true },
      module: { rules: [{ test: /\.css$/, type: 'css/auto' }] },
    });
    expectCssPinned(out, 'remoteEntry.js');
  });

  it('Rsbuild (its default CSS extraction): the same', async () => {
    const root = cssRemote('rsbuild-');
    writeFileSync(join(root, 'index.js'), '// standalone entry\n');
    const rsbuild = await createRsbuild({
      cwd: root,
      rsbuildConfig: {
        mode: 'production',
        plugins: [pluginPlatform({ role: 'remote', name: 'css-rsbuild', exposes: { './Edit': './Edit.js' } })],
        source: { entry: { index: './index.js' } },
        output: { distPath: { root: 'dist' }, minify: true },
        logLevel: 'silent',
      },
    });
    await rsbuild.build();
    expectCssPinned(join(root, 'dist'), 'remoteEntry.js');
  });

  it('a CSS loader that sets no integrity (mini-css-extract-plugin without its runtime) fails the build', async () => {
    const root = cssRemote('mini-noruntime-');
    const preset = platformWebpackConfig({ role: 'remote', name: 'css-noruntime', exposes: { './Edit': './Edit.js' }, mode: 'production' });
    await expect(
      compileWebpack({
        ...preset,
        context: root,
        entry: {},
        output: { ...preset.output, path: join(root, 'dist') },
        module: { rules: [cssModulesRule(MiniCssExtractPlugin.loader)] },
        plugins: [...preset.plugins!, new MiniCssExtractPlugin({ runtime: false })],
      }),
    ).rejects.toThrow(/PlatformChunkIntegrityPlugin: the build loads CSS chunks lazily \(chunks \S+\) with a loader that sets no integrity/);
  });

  it('a CSS loader whose code names no <link> element the plugin can find fails the build', async () => {
    const root = cssRemote('wp-native-odd-', true);
    const preset = platformWebpackConfig({ role: 'remote', name: 'css-odd', exposes: { './Edit': './Edit.js' }, mode: 'production' });
    // Taps the native CSS loader's hook before the integrity plugin does, hiding the element's variable.
    const hide: webpack.WebpackPluginInstance = {
      apply(compiler) {
        compiler.hooks.thisCompilation.tap('hide-link', (c) => {
          webpack.css.CssLoadingRuntimeModule.getCompilationHooks(c).createStylesheet.tap('hide-link', (s: string) => s.replace(/document\.createElement\((["'])link\1\)/, 'document["createElement"]("link")'));
        });
      },
    };
    await expect(
      compileWebpack({
        ...preset,
        context: root,
        entry: {},
        output: { ...preset.output, path: join(root, 'dist') },
        experiments: { css: true },
        module: { rules: [{ test: /\.css$/, type: 'css/auto' }] },
        plugins: [hide, ...preset.plugins!],
      }),
    ).rejects.toThrow(/a CSS loader creates its <link> in a way this plugin does not recognise/);
  });

  it('a lazy CSS file rewritten after its integrity was recorded fails the build', async () => {
    const root = cssRemote('mini-late-');
    const preset = platformWebpackConfig({ role: 'remote', name: 'css-late', exposes: { './Edit': './Edit.js' }, mode: 'production' });
    const rewriteLate: webpack.WebpackPluginInstance = {
      apply(compiler) {
        compiler.hooks.thisCompilation.tap('rewrite-late', (c) => {
          c.hooks.processAssets.tap({ name: 'rewrite-late', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT - 2 }, () => {
            for (const a of c.getAssets()) if (a.name.endsWith('.css')) c.updateAsset(a.name, new webpack.sources.RawSource(`${a.source.source().toString()}\n.x{}`));
          });
        });
      },
    };
    await expect(
      compileWebpack({
        ...preset,
        context: root,
        entry: {},
        output: { ...preset.output, path: join(root, 'dist') },
        module: { rules: [cssModulesRule(MiniCssExtractPlugin.loader)] },
        plugins: [...preset.plugins!, new MiniCssExtractPlugin(), rewriteLate],
      }),
    ).rejects.toThrow(/chunk \S+ changed after its integrity was recorded; the browser would refuse it/);
  });

  it('development: no CSS map (hot reload rewrites chunks)', async () => {
    const root = cssRemote('mini-dev-');
    const out = join(root, 'dist');
    const preset = platformWebpackConfig({ role: 'remote', name: 'css-dev', exposes: { './Edit': './Edit.js' }, mode: 'development' });
    await compileWebpack({
      ...preset,
      devtool: false,
      context: root,
      entry: {},
      output: { ...preset.output, path: out },
      module: { rules: [cssModulesRule(MiniCssExtractPlugin.loader)] },
      plugins: [...preset.plugins!, new MiniCssExtractPlugin()],
    });
    expect(readFileSync(join(out, 'remoteEntry.js'), 'utf8')).not.toContain('sriCssHashes');
  });

  it('a shell\'s index.html pins its stylesheets (as its scripts) with their sha384 and crossorigin; a later rewrite fails the build', async () => {
    const HtmlWebpackPlugin = createRequire(join(import.meta.dirname, '../../../examples/shell/package.json'))('html-webpack-plugin') as new (o: object) => webpack.WebpackPluginInstance;
    const root = mkdtempSync(join(dir, 'html-'));
    fakeSdk(root);
    writeFileSync(join(root, 'shell.js'), "import './shell.css';\nimport('./bootstrap.js');\n");
    writeFileSync(join(root, 'shell.css'), 'body { margin: 0; }\n');
    writeFileSync(join(root, 'bootstrap.js'), 'export const ready = 1;\n');
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body></body></html>\n');
    const preset = platformWebpackConfig({ role: 'shell', mode: 'production' });
    const build = (out: string, extra: webpack.WebpackPluginInstance[] = []) =>
      compileWebpack({
        ...preset,
        context: root,
        entry: { main: './shell.js' },
        output: { ...preset.output, path: out },
        module: { rules: [cssModulesRule(MiniCssExtractPlugin.loader)] },
        plugins: [...preset.plugins!, new MiniCssExtractPlugin({ filename: 'assets/[name].[contenthash].css' }), new HtmlWebpackPlugin({ template: './index.html', inject: 'body', scriptLoading: 'defer' }), ...extra],
      });
    const out = join(root, 'dist');
    await build(out);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const links = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).filter((t) => /rel="?stylesheet/.test(t));
    expect(links.length, html).toBe(1);
    const href = /href="?\/?([^" >]+)/.exec(links[0]!)![1]!;
    expect(links[0]).toContain(`integrity="${integrityOf(readFileSync(join(out, href)))}"`);
    expect(links[0]).toContain('crossorigin="anonymous"');

    const rewriteCss: webpack.WebpackPluginInstance = {
      apply(compiler) {
        compiler.hooks.thisCompilation.tap('rewrite-css', (c) => {
          c.hooks.processAssets.tap({ name: 'rewrite-css', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT - 2 }, () => {
            const css = c.getAssets().find((a) => a.name.endsWith('.css'))!;
            c.updateAsset(css.name, new webpack.sources.RawSource(`${css.source.source().toString()}\n.x{}`));
          });
        });
      },
    };
    await expect(build(join(root, 'dist2'), [rewriteCss])).rejects.toThrow(/index\.html loads assets\/main\.\S+\.css without its current integrity/);
  });

  it('Rspack: a shell whose CSS only loads at startup builds with runtimeChunk: \'single\' (review 3)', async () => {
    const root = mkdtempSync(join(dir, 'rs-initial-css-'));
    fakeSdk(root);
    writeFileSync(join(root, 'shell.js'), "import './shell.css';\nimport('./bootstrap.js');\n");
    writeFileSync(join(root, 'shell.css'), 'body { margin: 0; }\n');
    writeFileSync(join(root, 'bootstrap.js'), 'export const ready = 1;\n');
    const preset = platformRspackConfig({ role: 'shell', mode: 'production' });
    await expect(
      compileRspack({
        ...preset,
        context: root,
        entry: { main: './shell.js' },
        output: { ...preset.output, path: join(root, 'dist') },
        optimization: { ...preset.optimization, runtimeChunk: 'single' },
        module: { rules: [{ ...cssModulesRule(rspack.CssExtractRspackPlugin.loader), type: 'javascript/auto' }] },
        plugins: [...(preset.plugins ?? []), new rspack.CssExtractRspackPlugin({ filename: 'assets/[name].[contenthash].css' })],
      }),
    ).resolves.toBeUndefined();
  });

  it('the HTML pinning leaves other links and external URLs alone, and corrects an integrity already there', async () => {
    const HtmlWebpackPlugin = createRequire(join(import.meta.dirname, '../../../examples/shell/package.json'))('html-webpack-plugin') as new (o: object) => webpack.WebpackPluginInstance;
    const root = mkdtempSync(join(dir, 'html-edge-'));
    fakeSdk(root);
    writeFileSync(join(root, 'shell.js'), "import('./bootstrap.js');\n");
    writeFileSync(join(root, 'bootstrap.js'), 'export const ready = 1;\n');
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><html><head>' +
        '<link rel="preload" href="/assets/font.woff2" as="font">' + // not a stylesheet: left as is
        '<script src="https://cdn.example/analytics.js"></script>' + // not an emitted asset: left as is
        '</head><body></body></html>\n',
    );
    const preset = platformWebpackConfig({ role: 'shell', mode: 'production' });
    const out = join(root, 'dist');
    const stale: webpack.WebpackPluginInstance = {
      // Another plugin wrote a stale integrity on the bundle's tag: the pinning replaces it.
      apply(compiler) {
        compiler.hooks.thisCompilation.tap('stale', (c) => {
          (HtmlWebpackPlugin as unknown as { getHooks(c: webpack.Compilation): { alterAssetTags: { tap(n: string, f: (d: { assetTags: { scripts: { attributes: Record<string, string> }[] } }) => unknown): void } } })
            .getHooks(c)
            .alterAssetTags.tap('stale', (d) => {
              for (const t of d.assetTags.scripts) t.attributes.integrity = 'sha384-stale';
              return d;
            });
        });
      },
    };
    await compileWebpack({
      ...preset,
      context: root,
      entry: { main: './shell.js' },
      output: { ...preset.output, path: out },
      plugins: [...preset.plugins!, new HtmlWebpackPlugin({ template: './index.html', inject: 'body', scriptLoading: 'defer' }), stale],
    });
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    // html-webpack-plugin minifies the HTML: attribute quotes are dropped.
    expect(html).toMatch(/<link rel="?preload"? href="?\/assets\/font\.woff2"? as="?font"?>/);
    expect(html).toMatch(/<script src="?https:\/\/cdn\.example\/analytics\.js"?><\/script>/);
    const main = /<script\b[^>]*src="?\/?(assets\/main\.[^" >]+\.js)"?[^>]*>/.exec(html)!;
    expect(main[0]).toContain(`integrity="${integrityOf(readFileSync(join(out, main[1]!)))}"`);
    expect(main[0].match(/integrity=/g)).toHaveLength(1); // replaced, not a second attribute (the first one wins)
    expect(html).not.toContain('sha384-stale');
  });

  it.each([
    ['runtimeChunk: \'single\'', { runtimeChunk: 'single' as const }],
    ['one CSS file for all (mini-css-extract\'s cacheGroup)', { splitChunks: { cacheGroups: { styles: { type: 'css/mini-extract', name: 'styles', chunks: 'all' as const, enforce: true } } } }],
  ])('a shell whose CSS only loads at startup builds (%s): the HTML pins it, no lazy CSS map is needed (review 3)', async (_name, optimization) => {
    const HtmlWebpackPlugin = createRequire(join(import.meta.dirname, '../../../examples/shell/package.json'))('html-webpack-plugin') as new (o: object) => webpack.WebpackPluginInstance;
    const root = mkdtempSync(join(dir, 'initial-css-'));
    fakeSdk(root);
    writeFileSync(join(root, 'shell.js'), "import './shell.css';\nimport('./bootstrap.js');\n");
    writeFileSync(join(root, 'shell.css'), 'body { margin: 0; }\n');
    writeFileSync(join(root, 'bootstrap.js'), 'export const ready = 1;\n');
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body></body></html>\n');
    const preset = platformWebpackConfig({ role: 'shell', mode: 'production' });
    const out = join(root, 'dist');
    await compileWebpack({
      ...preset,
      context: root,
      entry: { main: './shell.js' },
      output: { ...preset.output, path: out },
      optimization: { ...preset.optimization, ...optimization },
      module: { rules: [cssModulesRule(MiniCssExtractPlugin.loader)] },
      plugins: [...preset.plugins!, new MiniCssExtractPlugin({ filename: 'assets/[name].[contenthash].css' }), new HtmlWebpackPlugin({ template: './index.html', inject: 'body', scriptLoading: 'defer' })],
    });
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const link = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).find((t) => /rel="?stylesheet/.test(t))!;
    const href = /href="?\/?([^" >]+)/.exec(link)![1]!;
    expect(link).toContain(`integrity="${integrityOf(readFileSync(join(out, href)))}"`);
  });
});
