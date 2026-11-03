// @bcbp-solutions-fzc-llc/webpack-preset/rspack and /rsbuild: the same platform settings as the webpack
// preset, checked with real Rspack and Rsbuild builds, and against webpack builds (a mixed estate: an Rspack
// shell loads webpack remotes and the other way round).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRsbuild } from '@rsbuild/core';
import { rspack, type RspackOptions, type Stats } from '@rspack/core';
import webpack from 'webpack';
import { afterAll, describe, expect, it } from 'vitest';
import { ChunkIntegrityPlugin, platformWebpackConfig } from '../../../packages/webpack-preset/src/index.ts';
import { pluginPlatform } from '../../../packages/webpack-preset/src/rsbuild.ts';
import { GlobalThisOnlyPlugin, MISSING_INTEGRITY, ProvideSdkRspackPlugin, integrityOf, platformRspackConfig } from '../../../packages/webpack-preset/src/rspack.ts';
import { SDK_SUBPATHS, SDK_VERSION } from '../../../packages/webpack-preset/src/generated/sdk.ts';

const dir = mkdtempSync(join(tmpdir(), 'preset-rspack-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function compile(config: RspackOptions): Promise<Stats> {
  return new Promise((resolve, reject) =>
    rspack(config, (err, stats) => {
      if (err) return reject(err);
      if (stats?.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
      resolve(stats!);
    }),
  );
}

function compileWebpack(config: webpack.Configuration): Promise<webpack.Stats> {
  return new Promise((resolve, reject) =>
    webpack(config, (err, stats) => {
      if (err) return reject(err);
      if (stats?.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
      resolve(stats!);
    }),
  );
}

/** A stand-in SDK under `root`: each subpath records in globalThis.__sdkEvaluated that it ran. */
function fakeSdk(root: string): void {
  const pkgDir = join(root, 'node_modules', '@bcbp-solutions-fzc-llc', 'frontend-sdk');
  mkdirSync(pkgDir, { recursive: true });
  const subpaths = SDK_SUBPATHS.filter((s) => s !== 'testing');
  const exports = Object.fromEntries(subpaths.map((s) => [`./${s}`, { import: `./${s}.js` }]));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@bcbp-solutions-fzc-llc/frontend-sdk', version: SDK_VERSION, type: 'module', sideEffects: true, exports }));
  for (const s of subpaths) writeFileSync(join(pkgDir, `${s}.js`), `(globalThis.__sdkEvaluated ??= []).push('${s}');\nexport const subpath = '${s}';\n`);
}

type Container = { init(scope: unknown): Promise<void> | void; get(m: string): Promise<() => { default: () => unknown }> };
/** Runs a node-target remoteEntry.js and returns its container global. */
const loadContainer = (out: string, global: string): Container =>
  new Function('require', '__dirname', `${readFileSync(join(out, 'remoteEntry.js'), 'utf8')}\nreturn ${global};`)(createRequire(join(out, 'remoteEntry.js')), out) as Container;

type Scope = Record<string, Record<string, { get(): Promise<() => unknown>; from: string }>>;
const g = globalThis as { __shellScope?: Promise<Scope>; __sdkEvaluated?: string[] };
const SHELL_ENTRY = "globalThis.__shellScope = (async () => { await __webpack_init_sharing__('default'); return __webpack_share_scopes__.default; })();\n";

describe('platformRspackConfig', () => {
  it('gives Rspack the same mode, devtool, output and ids as the webpack preset, for both roles and modes', () => {
    for (const role of ['shell', 'remote'] as const) {
      for (const mode of ['production', 'development'] as const) {
        const o = { role, mode, name: 'tenders', exposes: { './X': './x.js' } };
        const { plugins: _r, ...rs } = platformRspackConfig(o);
        const { plugins: _w, ...wp } = platformWebpackConfig(o);
        expect(rs, `${role} ${mode}`).toEqual(wp);
      }
    }
  });

  it('wires v1 Module Federation, the SDK provider (shell), the globalThis runtime and, in production, chunk integrity', () => {
    const names = (o: Parameters<typeof platformRspackConfig>[0]) => (platformRspackConfig(o).plugins ?? []).map((p) => (p as object).constructor.name);
    expect(names({ role: 'shell', mode: 'production' })).toEqual(['ModuleFederationPluginV1', 'ProvideSdkRspackPlugin', 'GlobalThisOnlyPlugin', 'ChunkIntegrityPlugin']);
    expect(names({ role: 'remote', name: 'tenders', mode: 'development' })).toEqual(['ModuleFederationPluginV1', 'GlobalThisOnlyPlugin']);
  });

  it('refuses an unknown role, an unknown mode, and a remote without a valid name', () => {
    expect(() => platformRspackConfig({ role: 'host' as 'shell', mode: 'production' })).toThrow("role must be 'shell' or 'remote'");
    expect(() => platformRspackConfig({ role: 'shell', mode: 'test' as 'production' })).toThrow('mode must be');
    expect(() => platformRspackConfig({ role: 'remote', mode: 'production' })).toThrow('remote name must match');
  });
});

describe('a real Rspack build', () => {
  it('a production remote: window.<containerName>, the platform-webpack policy, no eval or Function, no SDK, hidden maps', async () => {
    const root = mkdtempSync(join(dir, 'remote-'));
    writeFileSync(join(root, 'Edit.js'), "import { getLogger } from '@bcbp-solutions-fzc-llc/frontend-sdk/logging';\nexport default function Edit() { getLogger().info('edit'); return 'edit'; }\n");
    const out = join(root, 'dist');
    const preset = platformRspackConfig({ role: 'remote', name: 'iam-admin', exposes: { './Edit': './Edit.js' }, mode: 'production' });
    await compile({ ...preset, context: root, entry: {}, output: { ...preset.output, path: out } });
    const entry = readFileSync(join(out, 'remoteEntry.js'), 'utf8');
    expect(entry).toMatch(/\biam_admin\b/);
    expect(entry).toContain('platform-webpack');
    const all = readdirSync(out).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, f), 'utf8')).join('\n');
    expect(all).not.toMatch(/\beval\(|\bFunction\(/); // Rspack's own globalThis fallback is rewritten away
    expect(all).not.toContain('PlatformRuntime');
    expect(readdirSync(out).some((f) => f.endsWith('.map'))).toBe(true);
    expect(all).not.toContain('sourceMappingURL');
  });

  it('production: every lazily loaded chunk is in the entry\'s integrity map with its sha384; the loader sets it, failing closed', async () => {
    const root = mkdtempSync(join(dir, 'sri-'));
    writeFileSync(join(root, 'Big.js'), "export const big = 'big'.repeat(10);\n");
    writeFileSync(join(root, 'Edit.js'), "export default async function Edit() { return (await import('./Big.js')).big; }\n");
    const out = join(root, 'dist');
    const preset = platformRspackConfig({ role: 'remote', name: 'sri-remote', exposes: { './Edit': './Edit.js' }, mode: 'production' });
    await compile({ ...preset, context: root, entry: {}, output: { ...preset.output, path: out } });
    const entry = readFileSync(join(out, 'remoteEntry.js'), 'utf8');
    expect(entry).not.toContain('__PLATFORM_CHUNK_INTEGRITY__');
    const map = JSON.parse(/sriHashes\s*=\s*(\{[^}]*\})/.exec(entry)![1]!) as Record<string, string>;
    const lazy = readdirSync(out).filter((f) => f.endsWith('.js') && f !== 'remoteEntry.js');
    expect(lazy.length).toBeGreaterThanOrEqual(2);
    expect(Object.values(map).sort()).toEqual(lazy.map((f) => integrityOf(readFileSync(join(out, f)))).sort());
    expect(entry).toMatch(/\.integrity=\w+\.sriHashes\[\w+\]\|\|"sha384-A{64}"/);
    expect(MISSING_INTEGRITY).toBe(`sha384-${'A'.repeat(64)}`);
  });

  it('production: a shell\'s index.html (HtmlRspackPlugin) loads its scripts from /assets with their sha384 and crossorigin', async () => {
    const root = mkdtempSync(join(dir, 'html-'));
    fakeSdk(root);
    writeFileSync(join(root, 'index.js'), "import('./app.js');\n");
    writeFileSync(join(root, 'app.js'), "export const app = 'shell';\n");
    const out = join(root, 'dist');
    const preset = platformRspackConfig({ role: 'shell', mode: 'production' });
    await compile({ ...preset, context: root, entry: { main: './index.js' }, output: { ...preset.output, path: out }, plugins: [...(preset.plugins ?? []), new rspack.HtmlRspackPlugin({ inject: 'body', scriptLoading: 'defer' })] });
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      const src = /src="?\/(assets\/[^"\s>]+)/.exec(tag)![1]!;
      expect(tag).toContain(`integrity="${integrityOf(readFileSync(join(out, src)))}"`);
      expect(tag).toContain('crossorigin');
    }
  });

  it('a remote is refused by a shell providing an older SDK than it was built against', async () => {
    const root = mkdtempSync(join(dir, 'negotiate-'));
    writeFileSync(join(root, 'Uses.js'), "import { getLogger } from '@bcbp-solutions-fzc-llc/frontend-sdk/logging';\nexport default () => getLogger();\n");
    const out = join(root, 'dist');
    const preset = platformRspackConfig({ role: 'remote', name: 'negotiate', exposes: { './Uses': './Uses.js' }, mode: 'development' });
    await compile({ ...preset, target: 'node', devtool: false, context: root, entry: {}, output: { ...preset.output, path: out } });
    const scope = (version: string) => ({
      '@bcbp-solutions-fzc-llc/frontend-sdk/logging': { [version]: { get: () => () => ({ getLogger: () => `logger@${version}` }), loaded: 1, from: 'shell' } },
    });
    const same = loadContainer(out, 'negotiate');
    await same.init(scope(SDK_VERSION));
    expect((await same.get('./Uses'))().default()).toBe(`logger@${SDK_VERSION}`);
    const stale = loadContainer(out, 'negotiate');
    await stale.init(scope('1.0.0-0'));
    await expect(Promise.resolve().then(() => stale.get('./Uses')).then((f) => f().default())).rejects.toThrow(/Unsatisfied version 1\.0\.0-0 .*frontend-sdk\/logging/);
  });

  it('an Rspack shell provides every SDK subpath lazily, and a webpack remote consumes one the shell never imports', async () => {
    const root = mkdtempSync(join(dir, 'provide-'));
    fakeSdk(root);
    writeFileSync(join(root, 'shell.js'), SHELL_ENTRY);
    const shellOut = join(root, 'shell-dist');
    const shellPreset = platformRspackConfig({ role: 'shell', mode: 'development' });
    await compile({ ...shellPreset, target: 'node', devtool: false, context: root, entry: { main: './shell.js' }, output: { ...shellPreset.output, path: shellOut } });
    delete g.__sdkEvaluated;
    createRequire(join(shellOut, 'assets', 'main.js'))(join(shellOut, 'assets', 'main.js'));
    const scope = await g.__shellScope!;
    const sdkKeys = Object.keys(scope).filter((k) => k.startsWith('@bcbp-solutions-fzc-llc/frontend-sdk/')).sort();
    expect(sdkKeys).toEqual(SDK_SUBPATHS.filter((s) => s !== 'testing').map((s) => `@bcbp-solutions-fzc-llc/frontend-sdk/${s}`).sort());
    for (const k of sdkKeys) expect(Object.keys(scope[k]!), k).toEqual([SDK_VERSION]);
    expect(g.__sdkEvaluated ?? []).toEqual([]); // registered, not loaded

    writeFileSync(join(root, 'Uses.js'), "import { subpath } from '@bcbp-solutions-fzc-llc/frontend-sdk/problem';\nexport default () => subpath;\n");
    const remoteOut = join(root, 'webpack-remote');
    const remotePreset = platformWebpackConfig({ role: 'remote', name: 'wp-remote', exposes: { './Uses': './Uses.js' }, mode: 'development' });
    await compileWebpack({ ...remotePreset, target: 'node', devtool: false, context: root, entry: {}, output: { ...remotePreset.output, path: remoteOut } });
    const container = loadContainer(remoteOut, 'wp_remote');
    await container.init(scope);
    expect((await container.get('./Uses'))().default()).toBe('problem');
    expect(g.__sdkEvaluated).toEqual(['problem']);
    delete g.__sdkEvaluated;
  });

  it('an Rspack remote consumes the SDK from a webpack shell', async () => {
    const root = mkdtempSync(join(dir, 'mixed-'));
    fakeSdk(root);
    writeFileSync(join(root, 'shell.js'), SHELL_ENTRY);
    const shellOut = join(root, 'shell-dist');
    const shellPreset = platformWebpackConfig({ role: 'shell', mode: 'development' });
    await compileWebpack({ ...shellPreset, target: 'node', devtool: false, context: root, entry: { main: './shell.js' }, output: { ...shellPreset.output, path: shellOut } });
    delete g.__sdkEvaluated;
    createRequire(join(shellOut, 'assets', 'main.js'))(join(shellOut, 'assets', 'main.js'));
    const scope = await g.__shellScope!;

    writeFileSync(join(root, 'Uses.js'), "import { subpath } from '@bcbp-solutions-fzc-llc/frontend-sdk/nav';\nexport default () => subpath;\n");
    const remoteOut = join(root, 'rspack-remote');
    const preset = platformRspackConfig({ role: 'remote', name: 'rs-remote', exposes: { './Uses': './Uses.js' }, mode: 'development' });
    await compile({ ...preset, target: 'node', devtool: false, context: root, entry: {}, output: { ...preset.output, path: remoteOut } });
    const container = loadContainer(remoteOut, 'rs_remote');
    await container.init(scope);
    expect((await container.get('./Uses'))().default()).toBe('nav');
    expect(g.__sdkEvaluated).toEqual(['nav']);
    delete g.__sdkEvaluated;
  });

  it('a shell that cannot resolve the SDK fails the build, naming the subpath', async () => {
    const root = mkdtempSync(join(dir, 'nosdk-'));
    writeFileSync(join(root, 'index.js'), "export const x = 1;\n");
    const preset = platformRspackConfig({ role: 'shell', mode: 'development' });
    await expect(compile({ ...preset, context: root, entry: { main: './index.js' }, output: { ...preset.output, path: join(root, 'dist') } })).rejects.toThrow(
      /the shell cannot resolve @bcbp-solutions-fzc-llc\/frontend-sdk\/\w+ from .*: it must depend on @bcbp-solutions-fzc-llc\/frontend-sdk/,
    );
  });

  it('a subpath that resolves outside a package named after the SDK fails the build (no version to provide)', async () => {
    const root = mkdtempSync(join(dir, 'unnamed-'));
    fakeSdk(root);
    const pkgFile = join(root, 'node_modules', '@bcbp-solutions-fzc-llc', 'frontend-sdk', 'package.json');
    writeFileSync(pkgFile, readFileSync(pkgFile, 'utf8').replace('"name":"@bcbp-solutions-fzc-llc/frontend-sdk"', '"name":"not-the-sdk"'));
    writeFileSync(join(root, 'index.js'), 'export const x = 1;\n');
    const preset = platformRspackConfig({ role: 'shell', mode: 'development' });
    await expect(compile({ ...preset, context: root, entry: { main: './index.js' }, output: { ...preset.output, path: join(root, 'dist') } })).rejects.toThrow(
      /resolved to .* which has no @bcbp-solutions-fzc-llc\/frontend-sdk package\.json version/,
    );
  });

  it('a runtime that still has the Function(\'return this\') fallback fails the build', async () => {
    const root = mkdtempSync(join(dir, 'fallback-'));
    writeFileSync(join(root, 'index.js'), 'export const x = 1;\n');
    // Puts the fallback back into the runtime chunk after GlobalThisOnlyPlugin rewrote the module.
    const reinsert = {
      apply(compiler: import('@rspack/core').Compiler) {
        compiler.hooks.thisCompilation.tap('reinsert', (c) =>
          c.hooks.processAssets.tap({ name: 'reinsert', stage: compiler.rspack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE }, () => {
            for (const chunk of c.chunks) for (const file of chunk.files) if (file.endsWith('.js')) c.updateAsset(file, new compiler.rspack.sources.RawSource(`${c.getAsset(file)!.source.source().toString()}\nFunction("return this")();\n`));
          }),
        );
      },
    };
    const preset = platformRspackConfig({ role: 'remote', name: 'fallback', exposes: { './X': './index.js' }, mode: 'development' });
    await expect(compile({ ...preset, context: root, entry: {}, output: { ...preset.output, path: join(root, 'dist') }, plugins: [...(preset.plugins ?? []), reinsert] })).rejects.toThrow(
      /PlatformGlobalThisPlugin: remoteEntry\.js still has the Function\('return this'\) fallback/,
    );
  });

  it('ChunkIntegrityPlugin refuses a bundler with neither script hook', () => {
    const tap = (fn: (...a: unknown[]) => void, ...args: unknown[]) => fn(...args);
    const compilation = { hooks: { additionalTreeRuntimeRequirements: { tap: () => {} }, processAssets: { tap: () => {} } }, errors: [] };
    const compiler = {
      webpack: { RuntimeGlobals: { require: '__webpack_require__' }, RuntimeModule: class {}, Compilation: {}, WebpackError: Error, sources: { ReplaceSource: class {}, RawSource: class {} } },
      hooks: { thisCompilation: { tap: (_: string, fn: (c: unknown) => void) => tap(fn as (...a: unknown[]) => void, compilation) } },
    };
    expect(() => new ChunkIntegrityPlugin().apply(compiler as never)).toThrow('this bundler has no createScript hook (webpack 5 or Rspack is required)');
  });

  it('exports its plugins for apps that assemble the config themselves', () => {
    expect(new ProvideSdkRspackPlugin()).toBeInstanceOf(ProvideSdkRspackPlugin);
    expect(new GlobalThisOnlyPlugin()).toBeInstanceOf(GlobalThisOnlyPlugin);
  });
});

describe('Rsbuild: pluginPlatform', () => {
  async function build(root: string, plugin: ReturnType<typeof pluginPlatform>, entry: Record<string, string>, extra: object = {}) {
    const rsbuild = await createRsbuild({
      cwd: root,
      rsbuildConfig: { mode: 'production', plugins: [plugin], source: { entry }, output: { distPath: { root: 'dist' }, minify: true }, html: { scriptLoading: 'defer' }, performance: { chunkSplit: { strategy: 'all-in-one' } }, logLevel: 'silent', ...extra },
    });
    await rsbuild.build();
    return join(root, 'dist');
  }

  it('a remote: remoteEntry.js at the root with the container global, the integrity map, no Function, no SDK', async () => {
    const root = mkdtempSync(join(dir, 'rsbuild-remote-'));
    writeFileSync(join(root, 'Big.js'), "export const big = 'big'.repeat(10);\n");
    writeFileSync(join(root, 'Edit.js'), "import { getLogger } from '@bcbp-solutions-fzc-llc/frontend-sdk/logging';\nexport default async function Edit() { getLogger(); return (await import('./Big.js')).big; }\n");
    writeFileSync(join(root, 'index.js'), '// standalone entry\n');
    const out = await build(root, pluginPlatform({ role: 'remote', name: 'rsb-remote', exposes: { './Edit': './Edit.js' } }), { index: './index.js' });
    const entry = readFileSync(join(out, 'remoteEntry.js'), 'utf8');
    expect(entry).toMatch(/\brsb_remote\b/);
    expect(entry).toContain('platform-webpack');
    expect(entry).toMatch(/sriHashes\s*=\s*\{"/);
    const js = readdirSync(out, { recursive: true }).map(String).filter((f) => f.endsWith('.js'));
    const all = js.map((f) => readFileSync(join(out, f), 'utf8')).join('\n');
    expect(all).not.toMatch(/\beval\(|\bFunction\(/);
    expect(all).not.toContain('PlatformRuntime');
  });

  it('a shell: scripts under /assets, pinned in index.html with their sha384', async () => {
    const root = mkdtempSync(join(dir, 'rsbuild-shell-'));
    fakeSdk(root);
    writeFileSync(join(root, 'index.js'), "import('./app.js');\n");
    writeFileSync(join(root, 'app.js'), "export const app = 'shell';\n");
    const out = await build(root, pluginPlatform({ role: 'shell' }), { index: './index.js' });
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const tags = [...html.matchAll(/<script\b[^>]*\bsrc=[^>]*>/g)].map((m) => m[0]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      const src = /src="?\/(assets\/[^"\s>]+)/.exec(tag)?.[1];
      expect(src, tag).toBeDefined();
      expect(tag).toContain(`integrity="${integrityOf(readFileSync(join(out, src!)))}"`);
    }
  });

  it('follows Rsbuild\'s mode: a development build has readable names and no integrity (hot reload rewrites chunks)', async () => {
    const root = mkdtempSync(join(dir, 'rsbuild-dev-'));
    writeFileSync(join(root, 'Edit.js'), "export default () => 'edit';\n");
    writeFileSync(join(root, 'index.js'), '// standalone entry\n');
    const out = await build(root, pluginPlatform({ role: 'remote', name: 'rsb-dev', exposes: { './Edit': './Edit.js' } }), { index: './index.js' }, { mode: 'development' });
    const entry = readFileSync(join(out, 'remoteEntry.js'), 'utf8');
    expect(entry).toMatch(/\brsb_dev\b/);
    expect(entry).not.toContain('sriHashes');
    expect(entry).not.toMatch(/\beval\(|\bFunction\(/);
  });

  it('keeps the output.environment flags Rsbuild derives from its browserslist, and adds globalThis', async () => {
    const root = mkdtempSync(join(dir, 'rsbuild-env-'));
    writeFileSync(join(root, 'index.js'), '// entry\n');
    const configs = async (plugins: ReturnType<typeof pluginPlatform>[]) => {
      const rsbuild = await createRsbuild({ cwd: root, rsbuildConfig: { mode: 'production', plugins, source: { entry: { index: './index.js' } }, logLevel: 'silent' } });
      return (await rsbuild.initConfigs())[0]!.output!.environment;
    };
    const plain = await configs([]);
    expect(await configs([pluginPlatform({ role: 'remote', name: 'rsb-env', exposes: {} })])).toEqual({ ...plain, globalThis: true });
  });

  it('/rsbuild uses the Rspack @rsbuild/core bundles: its modules never import @rspack/core at run time', () => {
    // pnpm does not hoist @rsbuild/core's own @rspack/core: an Rsbuild-only app has none the preset could resolve.
    const src = join(import.meta.dirname, '..', '..', '..', 'packages', 'webpack-preset', 'src');
    for (const file of ['rsbuild.ts', 'rspack-preset.ts', 'integrity.ts', 'shared.ts']) {
      const text = readFileSync(join(src, file), 'utf8');
      expect(text, file).not.toMatch(/^import (?!type\b)[^;]*from '@rspack\/core'/m);
      expect(text, file).not.toMatch(/^import [^;]*from '\.\/rspack\.ts'/m);
    }
  });

  it('refuses Rsbuild\'s own moduleFederation option (the v2 protocol)', async () => {
    const root = mkdtempSync(join(dir, 'rsbuild-mf-'));
    writeFileSync(join(root, 'index.js'), '// entry\n');
    await expect(build(root, pluginPlatform({ role: 'shell' }), { index: './index.js' }, { moduleFederation: { options: { name: 'shell' } } })).rejects.toThrow('remove Rsbuild\'s moduleFederation option');
  });
});
