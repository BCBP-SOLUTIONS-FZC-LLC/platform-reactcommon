import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpack from 'webpack';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { containerGlobal } from '../../../packages/frontend-sdk/src/mfe/remote.ts';
import { containerName, platformShared, platformWebpackConfig, ProvideSdkPlugin, sharedFor } from '../../../packages/webpack-preset/src/index.ts';
import { SDK_SHARE_RANGE, SDK_SUBPATHS, SDK_VERSION } from '../../../packages/webpack-preset/src/generated/sdk.ts';

const require = createRequire(import.meta.url);
// webpack's own range matcher, the one share negotiation uses.
const { parseRange, satisfy } = require(join(require.resolve('webpack'), '../sharing/semver.js')) as {
  parseRange(r: string): unknown;
  satisfy(range: unknown, version: string): boolean;
};
const sdkPkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../../packages/frontend-sdk/package.json'), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
};
const reactVersion = (JSON.parse(readFileSync(require.resolve('react/package.json', { paths: [join(import.meta.dirname, '../../../packages/frontend-sdk')] }), 'utf8')) as { version: string }).version;

describe('platformShared', () => {
  it('shares React (with its JSX runtimes and react-dom/client), OTel API and every SDK subpath but /testing as strict singletons', () => {
    expect(Object.keys(platformShared)).toEqual([
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      '@opentelemetry/api',
      '@platform/frontend-sdk',
      ...SDK_SUBPATHS.filter((s) => s !== 'testing').map((s) => `@platform/frontend-sdk/${s}`),
    ]);
    for (const c of Object.values(platformShared)) expect(c).toMatchObject({ singleton: true, strictVersion: true });
    expect(platformShared['@platform/frontend-sdk']!.requiredVersion).toBe('^1.0.0-0');
  });

  it('pins agree with the SDK peer ranges, under webpack semver', () => {
    expect(platformShared.react!.requiredVersion).toBe(sdkPkg.peerDependencies.react);
    expect(platformShared['react-dom']!.requiredVersion).toBe(sdkPkg.peerDependencies['react-dom']);
    // A remote's JSX must come from the shell's React: the JSX runtimes share React's pin.
    expect(platformShared['react/jsx-runtime']!.requiredVersion).toBe(platformShared.react!.requiredVersion);
    expect(platformShared['react/jsx-dev-runtime']!.requiredVersion).toBe(platformShared.react!.requiredVersion);
    expect(platformShared['react-dom/client']!.requiredVersion).toBe(platformShared['react-dom']!.requiredVersion);
    const otel = parseRange(platformShared['@opentelemetry/api']!.requiredVersion);
    expect(['1.10.0', '1.10.9'].map((v) => satisfy(otel, v))).toEqual([true, true]);
    expect(['1.9.0', '1.11.0'].map((v) => satisfy(otel, v))).toEqual([false, false]);
    expect(satisfy(parseRange(platformShared.react!.requiredVersion), reactVersion)).toBe(true);
    expect(satisfy(parseRange(platformShared.react!.requiredVersion), '18.3.1')).toBe(true);
    expect(satisfy(parseRange(platformShared.react!.requiredVersion), '17.0.2')).toBe(false);
  });

  it('the SDK share range accepts the alpha pre-releases and later 1.x, never 2.x', () => {
    const r = parseRange(platformShared['@platform/frontend-sdk']!.requiredVersion);
    expect([sdkPkg.version, '1.0.0-alpha.7', '1.0.0', '1.4.2'].map((v) => satisfy(r, v))).toEqual([true, true, true, true]);
    expect(satisfy(r, '2.0.0')).toBe(false);
  });
});

describe('sharedFor', () => {
  it('shell: eager false everywhere', () => {
    for (const c of Object.values(sharedFor('shell'))) expect(c.eager).toBe(false);
  });

  const sdkRequests = ['@platform/frontend-sdk', ...SDK_SUBPATHS.filter((s) => s !== 'testing').map((s) => `@platform/frontend-sdk/${s}`)];

  it('remote: every SDK entry requires at least the SDK version the preset was released with', () => {
    expect(SDK_VERSION).toBe(sdkPkg.version);
    const r = sharedFor('remote');
    for (const req of sdkRequests) expect(r[req], req).toEqual({ singleton: true, strictVersion: true, requiredVersion: `^${SDK_VERSION}`, import: false });
    // React and OTel keep their pins.
    expect(r.react).toEqual(platformShared.react);
    expect(r['@opentelemetry/api']).toEqual(platformShared['@opentelemetry/api']);
  });

  it('shell: the SDK keeps the broad ^<major>.0.0-0 range', () => {
    const major = SDK_VERSION.split('.')[0];
    expect(SDK_SHARE_RANGE).toBe(`^${major}.0.0-0`);
    const s = sharedFor('shell');
    for (const req of sdkRequests) expect(s[req]!.requiredVersion, req).toBe(`^${major}.0.0-0`);
  });

  it('a ^<pre-release> requirement, under webpack semver, accepts that pre-release and later, refuses earlier and the next major', () => {
    const r = parseRange('^1.0.0-alpha.3');
    expect(['1.0.0-alpha.3', '1.0.0-alpha.4', '1.0.0', '1.4.0'].map((v) => satisfy(r, v))).toEqual([true, true, true, true]);
    expect(['1.0.0-alpha.2', '1.0.0-0', '2.0.0'].map((v) => satisfy(r, v))).toEqual([false, false, false]);
    // A remote built against 1.5 is refused by a 1.4 shell; the shell's own range would have let it in.
    expect(satisfy(parseRange('^1.5.0'), '1.4.0')).toBe(false);
    expect(satisfy(parseRange(SDK_SHARE_RANGE), '1.4.0')).toBe(true);
    // The real requirement accepts the version it was built with.
    expect(satisfy(parseRange(sharedFor('remote')['@platform/frontend-sdk/http']!.requiredVersion), SDK_VERSION)).toBe(true);
  });

  it('remote: the SDK is never bundled (import: false); React is', () => {
    const r = sharedFor('remote');
    expect(r['@platform/frontend-sdk/http']!.import).toBe(false);
    expect(r['@platform/frontend-sdk']!.import).toBe(false);
    expect(r.react!.import).toBeUndefined();
  });
});

describe('containerName', () => {
  it.each(['tenders', 'iam-admin', 'a-b-c', 'x_y'])('%s matches the SDK loadRemote rule', (name) => {
    expect(containerName(name)).toBe(containerGlobal(name));
    expect(containerName(name)).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it.each(['shell', 'Tenders', '9lives', '', 'a/b'])('refuses %j', (name) => {
    expect(() => containerName(name)).toThrow(TypeError);
  });
});

describe('platformWebpackConfig', () => {
  it('sets CSP-safe output for both modes', () => {
    for (const mode of ['production', 'development'] as const) {
      for (const role of ['shell', 'remote'] as const) {
        const c = platformWebpackConfig({ role, mode, name: 'tenders' });
        expect(String(c.devtool)).not.toMatch(/eval/);
        expect(c.output).toMatchObject({ trustedTypes: { policyName: 'platform-webpack' }, crossOriginLoading: false });
      }
    }
    const prod = platformWebpackConfig({ role: 'shell', mode: 'production' });
    expect(prod.devtool).toBe('hidden-source-map');
    expect(prod.output?.filename).toContain('[contenthash]');
  });

  it('loads the shell from the site root (deep links and /auth/callback), a remote relative to its remoteEntry.js', () => {
    // index.html is served for every deep link: a relative script src would resolve under /t/acme/… and 403.
    const shell = platformWebpackConfig({ role: 'shell', mode: 'production' });
    expect(shell.output).toMatchObject({ publicPath: '/', filename: 'assets/[name].[contenthash].js', chunkFilename: 'assets/[name].[contenthash].js' });
    const remote = platformWebpackConfig({ role: 'remote', name: 'tenders', mode: 'production' });
    expect(remote.output).toMatchObject({ publicPath: 'auto', filename: '[name].[contenthash].js', chunkFilename: '[name].[contenthash].js' });
  });

  it('refuses an unknown role or mode', () => {
    expect(() => platformWebpackConfig({ role: 'host' as never, mode: 'production' })).toThrow(/role must be 'shell' or 'remote', got "host"/);
    expect(() => platformWebpackConfig({ role: 'shell', mode: 'none' as never })).toThrow(/mode must be 'production' or 'development'/);
  });

  it('development output has readable names and no content hashes', () => {
    const dev = platformWebpackConfig({ role: 'shell', mode: 'development' });
    expect(dev.devtool).toBe('cheap-module-source-map');
    expect(dev.output).toMatchObject({ filename: 'assets/[name].js', chunkFilename: 'assets/[name].js', assetModuleFilename: 'assets/[name][ext]', uniqueName: 'shell' });
    expect(dev.optimization).toEqual({ moduleIds: 'deterministic', chunkIds: 'deterministic' });
  });

  it('wires the federation plugin for the role', () => {
    const mfOptions = (c: webpack.Configuration) => (c.plugins![0] as unknown as { options: Record<string, unknown> }).options;
    const shell = platformWebpackConfig({ role: 'shell', mode: 'production', name: 'ignored', exposes: { './X': './x.js' } });
    expect(shell.plugins![0]).toBeInstanceOf(webpack.container.ModuleFederationPlugin);
    expect(mfOptions(shell)).toEqual({ name: 'shell', shared: sharedFor('shell') });
    expect(shell.plugins![1]).toBeInstanceOf(ProvideSdkPlugin);
    expect(shell.plugins).toHaveLength(2);
    const remote = platformWebpackConfig({ role: 'remote', name: 'iam-admin', mode: 'development' });
    expect(mfOptions(remote)).toEqual({
      name: 'iam_admin',
      library: { type: 'var', name: 'iam_admin' },
      filename: 'remoteEntry.js',
      exposes: {},
      shared: sharedFor('remote'),
    });
    expect(remote.output?.uniqueName).toBe('iam_admin');
    expect(remote.plugins).toHaveLength(1); // a remote provides no SDK
  });

  it('refuses a remote without a valid name', () => {
    expect(() => platformWebpackConfig({ role: 'remote', mode: 'production' })).toThrow(TypeError);
    expect(() => platformWebpackConfig({ role: 'remote', name: 'shell', mode: 'production' })).toThrow(TypeError);
  });
});

describe('package.json pins', () => {
  it('a missing pin fails at load time, naming the package', async () => {
    vi.resetModules();
    vi.doMock('node:module', () => ({ createRequire: () => () => ({ platformShared: { react: '^19.0.0' } }) }));
    try {
      await expect(import('../../../packages/webpack-preset/src/index.ts')).rejects.toThrow('has no platformShared pin for react-dom');
    } finally {
      vi.doUnmock('node:module');
      vi.resetModules();
    }
  });
});

describe('a real build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function compile(config: webpack.Configuration): Promise<webpack.Stats> {
    return new Promise((resolve, reject) =>
      webpack(config, (err, stats) => {
        if (err) return reject(err);
        if (stats?.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
        resolve(stats!);
      }),
    );
  }

  it('a remote exposes window.<containerName>, keeps the SDK out of its bundle, and emits no eval', async () => {
    writeFileSync(join(dir, 'Edit.js'), "import { getLogger } from '@platform/frontend-sdk/logging';\nexport default function Edit() { getLogger().info('edit'); return 'edit'; }\n");
    writeFileSync(join(dir, 'remote.js'), '// remote entry for standalone runs\n');
    const out = join(dir, 'remote-dist');
    const preset = platformWebpackConfig({ role: 'remote', name: 'iam-admin', exposes: { './Edit': './Edit.js' }, mode: 'production' });
    await compile({ ...preset, context: dir, entry: { main: './remote.js' }, output: { ...preset.output, path: out } });
    const entry = readFileSync(join(out, 'remoteEntry.js'), 'utf8');
    expect(entry).toMatch(/\biam_admin\b/);
    expect(entry).toContain('platform-webpack');
    const all = readdirSync(out)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(out, f), 'utf8'))
      .join('\n');
    expect(all).not.toMatch(/\beval\(|new Function\(/);
    expect(all).not.toContain('PlatformRuntime'); // the SDK came from nowhere but the shell
    expect(readdirSync(out).some((f) => f.endsWith('.map'))).toBe(true); // hidden maps: emitted, not referenced
    expect(all).not.toContain('sourceMappingURL');
  });

  it('share negotiation: a remote is refused by a shell providing an older SDK than it was built against', async () => {
    writeFileSync(join(dir, 'Uses.js'), "import { getLogger } from '@platform/frontend-sdk/logging';\nexport default () => getLogger();\n");
    writeFileSync(join(dir, 'negotiate.js'), '// remote entry\n');
    const out = join(dir, 'negotiate-dist');
    const preset = platformWebpackConfig({ role: 'remote', name: 'negotiate', exposes: { './Uses': './Uses.js' }, mode: 'development' });
    // target node: chunks load through require, so the container runs here; the share-scope negotiation
    // (the consume runtime) is the same as in the browser.
    await compile({ ...preset, target: 'node', devtool: false, context: dir, entry: { main: './negotiate.js' }, output: { ...preset.output, path: out } });
    const nodeRequire = createRequire(join(out, 'remoteEntry.js'));
    const load = () =>
      new Function('require', '__dirname', `${readFileSync(join(out, 'remoteEntry.js'), 'utf8')}\nreturn negotiate;`)(nodeRequire, out) as {
        init(scope: unknown): Promise<void> | void;
        get(m: string): Promise<() => { default: () => unknown }>;
      };
    // The shell's scope: the SDK at one version, provided by the shell.
    const shellScope = (version: string) => ({
      '@platform/frontend-sdk/logging': { [version]: { get: () => () => ({ getLogger: () => `logger@${version}` }), loaded: 1, from: 'shell' } },
    });
    const [maj, min, patch] = SDK_VERSION.replace(/-.*/, '').split('.').map(Number) as [number, number, number];
    // An SDK older than the remote's but inside the shell's own range.
    const older = SDK_VERSION.includes('-') || (min === 0 && patch === 0) ? `${maj}.${min}.${patch}-0` : patch > 0 ? `${maj}.${min}.${patch - 1}` : `${maj}.${min - 1}.0`;
    expect(older).not.toBe(SDK_VERSION);
    expect(satisfy(parseRange(SDK_SHARE_RANGE), older)).toBe(true);

    const same = load();
    await same.init(shellScope(SDK_VERSION));
    expect((await same.get('./Uses'))().default()).toBe(`logger@${SDK_VERSION}`);

    const stale = load();
    await stale.init(shellScope(older));
    await expect(Promise.resolve().then(() => stale.get('./Uses')).then((f) => f().default())).rejects.toThrow(
      `Unsatisfied version ${older} from shell of shared singleton module @platform/frontend-sdk/logging (required ^${SDK_VERSION})`,
    );
  });

  /** A stand-in @platform/frontend-sdk under `root`: each subpath records in globalThis.__sdkEvaluated that it ran. */
  function fakeSdk(root: string): void {
    const pkgDir = join(root, 'node_modules', '@platform', 'frontend-sdk');
    mkdirSync(pkgDir, { recursive: true });
    const subpaths = SDK_SUBPATHS.filter((s) => s !== 'testing');
    const exports = Object.fromEntries(subpaths.map((s) => [`./${s}`, { import: `./${s}.js` }]));
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@platform/frontend-sdk', version: SDK_VERSION, type: 'module', sideEffects: true, exports }));
    for (const s of subpaths) writeFileSync(join(pkgDir, `${s}.js`), `(globalThis.__sdkEvaluated ??= []).push('${s}');\nexport const subpath = '${s}';\n`);
  }

  it('a shell builds with the same shared map', async () => {
    fakeSdk(dir);
    writeFileSync(join(dir, 'bootstrap.js'), "export const ready = 'shell';\n");
    writeFileSync(join(dir, 'shell.js'), "import('./bootstrap.js');\n");
    const out = join(dir, 'shell-dist');
    const preset = platformWebpackConfig({ role: 'shell', mode: 'development' });
    await compile({ ...preset, context: dir, entry: { main: './shell.js' }, output: { ...preset.output, path: out } });
    expect(readdirSync(join(out, 'assets'))).toContain('main.js'); // the shell's bundles live under assets/
    expect(readFileSync(join(out, 'assets', 'main.js'), 'utf8')).not.toMatch(/\beval\(/);
  });

  it('the shell provides every SDK subpath, imported or not, and a remote consumes one the shell never imports', async () => {
    // docs/e2e report, Issue 2: webpack provides a shared request only when the bundle imports it, and a
    // remote's SDK has no fallback (import: false). This shell imports only /logging; the remote uses /problem.
    const root = mkdtempSync(join(dir, 'provide-'));
    fakeSdk(root);
    writeFileSync(join(root, 'bootstrap.js'), "import { subpath } from '@platform/frontend-sdk/logging';\nexport default subpath;\n");
    writeFileSync(
      join(root, 'shell.js'),
      "globalThis.__shellScope = (async () => { await __webpack_init_sharing__('default'); return __webpack_share_scopes__.default; })();\n",
    );
    const shellOut = join(root, 'shell-dist');
    const shellPreset = platformWebpackConfig({ role: 'shell', mode: 'development' });
    await compile({ ...shellPreset, target: 'node', devtool: false, context: root, entry: { main: './shell.js' }, output: { ...shellPreset.output, path: shellOut } });
    const g = globalThis as { __shellScope?: Promise<Record<string, Record<string, { get(): Promise<() => unknown>; from: string }>>>; __sdkEvaluated?: string[] };
    delete g.__sdkEvaluated;
    createRequire(join(shellOut, 'assets', 'main.js'))(join(shellOut, 'assets', 'main.js'));
    const scope = await g.__shellScope!;
    const sdkKeys = Object.keys(scope).filter((k) => k.startsWith('@platform/frontend-sdk/')).sort();
    expect(sdkKeys).toEqual(SDK_SUBPATHS.filter((s) => s !== 'testing').map((s) => `@platform/frontend-sdk/${s}`).sort());
    for (const k of sdkKeys) expect(Object.keys(scope[k]!), k).toEqual([SDK_VERSION]);
    expect(scope['@platform/frontend-sdk/testing']).toBeUndefined();
    // Provided lazily: registering the scope evaluates no subpath.
    expect(g.__sdkEvaluated ?? []).toEqual([]);

    writeFileSync(join(root, 'Uses.js'), "import { subpath } from '@platform/frontend-sdk/problem';\nexport default () => subpath;\n");
    writeFileSync(join(root, 'remote.js'), '// remote entry\n');
    const remoteOut = join(root, 'remote-dist');
    const remotePreset = platformWebpackConfig({ role: 'remote', name: 'uses-problem', exposes: { './Uses': './Uses.js' }, mode: 'development' });
    await compile({ ...remotePreset, target: 'node', devtool: false, context: root, entry: { main: './remote.js' }, output: { ...remotePreset.output, path: remoteOut } });
    const container = new Function('require', '__dirname', `${readFileSync(join(remoteOut, 'remoteEntry.js'), 'utf8')}\nreturn uses_problem;`)(
      createRequire(join(remoteOut, 'remoteEntry.js')),
      remoteOut,
    ) as { init(scope: unknown): Promise<void> | void; get(m: string): Promise<() => { default: () => unknown }> };
    await container.init(scope);
    expect((await container.get('./Uses'))().default()).toBe('problem');
    expect(g.__sdkEvaluated).toEqual(['problem']); // the shell's copy, loaded on first use
    delete g.__sdkEvaluated;
  });

  it('a shell that cannot resolve the SDK fails the build, naming the subpath', async () => {
    const lonely = mkdtempSync(join(tmpdir(), 'preset-nosdk-'));
    try {
      writeFileSync(join(lonely, 'shell.js'), '// no SDK installed\n');
      const preset = platformWebpackConfig({ role: 'shell', mode: 'development' });
      await expect(compile({ ...preset, context: lonely, entry: { main: './shell.js' }, output: { ...preset.output, path: join(lonely, 'dist') } })).rejects.toThrow(
        /the shell cannot resolve @platform\/frontend-sdk\/core from .*: it must depend on @platform\/frontend-sdk/,
      );
    } finally {
      rmSync(lonely, { recursive: true, force: true });
    }
  });
});
