/**
 * Webpack 5 Module Federation preset for the platform's shell and remotes (design doc §C3): one shared
 * map for every app (singletons, strict versions), the SDK provided by the shell only (a remote requires
 * at least the SDK version it was built against), and CSP-safe
 * output (Trusted Types, no eval devtools, hidden source maps, content hashes).
 *
 * @packageDocumentation
 */
import { createRequire } from 'node:module';
import webpack, { type Compiler, type Configuration } from 'webpack';
import { SDK_PACKAGE, SDK_SHARE_RANGE, SDK_SUBPATHS, SDK_VERSION } from './generated/sdk.ts';

/** A Module Federation shared entry (the subset the platform uses). */
export interface SharedConfig {
  readonly singleton: true;
  readonly strictVersion: true;
  readonly requiredVersion: string;
  readonly eager?: false;
  readonly import?: false;
}

const pkg = createRequire(import.meta.url)('../package.json') as { platformShared: Record<string, string> };

function pin(name: string): string {
  const v = pkg.platformShared[name];
  if (typeof v !== 'string') throw new Error(`@platform/webpack-preset package.json has no platformShared pin for ${name}`);
  return v;
}

const shared = (requiredVersion: string): SharedConfig => ({ singleton: true, strictVersion: true, requiredVersion });

/** Subpaths never shared: /testing is dev only and must not reach a production bundle. */
const NOT_SHARED = new Set(['testing']);

/**
 * The shared map both roles start from. Module Federation keys sharing by request, so every SDK subpath is
 * listed; all of them share one SDK instance. The SDK entries carry the shell's broad range (any release of
 * the major); sharedFor('remote') tightens them to the SDK version the remote is built against.
 */
export const platformShared: Readonly<Record<string, SharedConfig>> = Object.freeze({
  react: shared(pin('react')),
  // The entry points apps import besides the package roots: shared too, or each remote bundles its own
  // JSX runtime, whose elements another React major refuses to render.
  'react/jsx-runtime': shared(pin('react')),
  'react/jsx-dev-runtime': shared(pin('react')),
  'react-dom': shared(pin('react-dom')),
  'react-dom/client': shared(pin('react-dom')),
  '@opentelemetry/api': shared(pin('@opentelemetry/api')),
  [SDK_PACKAGE]: shared(SDK_SHARE_RANGE),
  ...Object.fromEntries(SDK_SUBPATHS.filter((s) => !NOT_SHARED.has(s)).map((s) => [`${SDK_PACKAGE}/${s}`, shared(SDK_SHARE_RANGE)])),
});

function isSdk(request: string): boolean {
  return request === SDK_PACKAGE || request.startsWith(`${SDK_PACKAGE}/`);
}

/**
 * What a remote requires of the shell's SDK: at least the version it compiles against (this preset's, as
 * the SDK and the preset release under one version), within that major. A remote that calls an export
 * added in 1.5 is refused by a 1.4 shell at share negotiation (strictVersion), which loadRemote reports as
 * an incompatible remote, instead of loading and failing when the missing export is called.
 */
const REMOTE_SDK_RANGE = `^${SDK_VERSION}`;

/**
 * The shared map for a role. Shell: `eager: false` everywhere (bootstrap through a dynamic import). Remote:
 * the SDK gets `import: false`, so it always comes from the shell and is never bundled into the remote,
 * and requires `^<SDK version it was built with>` (REMOTE_SDK_RANGE).
 */
export function sharedFor(role: 'shell' | 'remote'): Record<string, SharedConfig> {
  return Object.fromEntries(
    Object.entries(platformShared).map(([request, c]) => [
      request,
      role === 'shell' ? { ...c, eager: false } : isSdk(request) ? { ...c, requiredVersion: REMOTE_SDK_RANGE, import: false } : c,
    ]),
  ) as Record<string, SharedConfig>;
}

/** The SDK subpaths in the shared map: the share keys a remote may consume from the shell. */
const SHARED_SDK_SUBPATHS = SDK_SUBPATHS.filter((s) => !NOT_SHARED.has(s)).map((s) => `${SDK_PACKAGE}/${s}`);

/**
 * Makes the shell provide every shared SDK subpath, not only those its own code imports. Webpack provides a
 * shared package request only when the bundle imports it, and a remote's SDK has `import: false` (no
 * fallback): a remote using a subpath the shell never imports (say /problem) would fail at runtime with
 * "Shared module … doesn't exist in shared scope". Each subpath is resolved as the shell's own imports are
 * (from its context, ESM conditions, so the same file and one SDK instance) and provided lazily (eager:
 * false): a subpath no one uses is registered in the share scope but never loaded.
 */
export class ProvideSdkPlugin {
  apply(compiler: Compiler): void {
    let applied = false;
    compiler.hooks.beforeCompile.tapPromise(ProvideSdkPlugin.name, async () => {
      if (applied) return;
      applied = true;
      const resolver = compiler.resolverFactory.get('normal', { dependencyType: 'esm' });
      const provides: Record<string, { shareKey: string; version: string; eager: false }> = {};
      for (const request of SHARED_SDK_SUBPATHS) {
        const { path, version } = await new Promise<{ path: string; version: string | undefined }>((resolve, reject) =>
          resolver.resolve({}, compiler.context, request, {}, (err, result, data) => {
            if (err || typeof result !== 'string') {
              return reject(new Error(`the shell cannot resolve ${request} from ${compiler.context}: it must depend on ${SDK_PACKAGE} (${err?.message ?? 'not found'})`));
            }
            resolve({ path: result, version: (data?.descriptionFileData as { version?: string } | undefined)?.version });
          }),
        );
        if (!version) throw new Error(`${request} resolved to ${path}, which has no package.json version`);
        provides[path] = { shareKey: request, version, eager: false };
      }
      new webpack.sharing.ProvideSharedPlugin({ provides }).apply(compiler);
    });
  }
}

const NAME = /^[a-z][a-z0-9_-]{0,62}$/;

/**
 * The global a remote's container is exposed as: its name with '-' as '_' (a valid identifier). The SDK's
 * loadRemote looks it up with the same rule.
 */
export function containerName(remote: string): string {
  if (typeof remote !== 'string' || !NAME.test(remote) || remote === 'shell') {
    throw new TypeError(`remote name must match ${NAME.source} and not be 'shell', got ${JSON.stringify(remote)}`);
  }
  return remote.replace(/-/g, '_');
}

export interface PresetOptions {
  role: 'shell' | 'remote';
  /** Remote: its manifest name, e.g. 'tenders'. Shell: ignored ('shell'). */
  name?: string;
  /** Remote: modules it exposes, e.g. { './EditTender': './src/EditTender.tsx' }. */
  exposes?: Record<string, string>;
  mode: 'production' | 'development';
}

/**
 * The platform's webpack settings for a shell or remote, to merge into the app's own config (the app adds
 * entry, loaders and dev server). Adds the ModuleFederationPlugin with sharedFor(role), and for the shell
 * the ProvideSdkPlugin (every SDK subpath in the share scope).
 */
export function platformWebpackConfig(o: PresetOptions): Configuration {
  if (o.role !== 'shell' && o.role !== 'remote') throw new TypeError(`role must be 'shell' or 'remote', got ${JSON.stringify(o.role)}`);
  if (o.mode !== 'production' && o.mode !== 'development') throw new TypeError(`mode must be 'production' or 'development'`);
  const prod = o.mode === 'production';
  const shell = o.role === 'shell';
  // The shell is served from the site root, and index.html is returned for every deep link (the SPA
  // rewrite): its scripts must load from '/', never relative to /t/acme/… or /auth/callback. Its hashed
  // bundles go under assets/, the immutable CloudFront behavior. A remote's chunks load relative to its
  // remoteEntry.js, wherever the manifest points ('auto').
  const js = prod ? '[name].[contenthash].js' : '[name].js';
  const mf =
    o.role === 'remote'
      ? {
          name: containerName(o.name ?? ''),
          // A plain global: the SDK injects remoteEntry.js and reads window[containerName(name)].
          library: { type: 'var', name: containerName(o.name ?? '') },
          filename: 'remoteEntry.js',
          exposes: o.exposes ?? {},
          shared: sharedFor('remote'),
        }
      : { name: 'shell', shared: sharedFor('shell') };
  return {
    mode: o.mode,
    // No eval-based devtool in any mode (CSP script-src 'self'); production maps are uploaded privately, never served.
    devtool: prod ? 'hidden-source-map' : 'cheap-module-source-map',
    output: {
      publicPath: shell ? '/' : 'auto',
      filename: shell ? `assets/${js}` : js,
      chunkFilename: shell ? `assets/${js}` : js,
      assetModuleFilename: prod ? 'assets/[name].[contenthash][ext]' : 'assets/[name][ext]',
      // require-trusted-types-for 'script': webpack's script URLs go through this policy. The shell's
      // runtime and every remote's create it under the same name, so the CSP's trusted-types directive
      // carries 'allow-duplicates' (examples/cloudfront/csp.mjs).
      trustedTypes: { policyName: 'platform-webpack' },
      crossOriginLoading: false,
      // Every supported browser has globalThis: without this, webpack's runtime keeps a
      // new Function('return this') fallback, which script-src 'self' forbids.
      environment: { globalThis: true },
      ...(o.role === 'remote' ? { uniqueName: containerName(o.name ?? '') } : { uniqueName: 'shell' }),
    },
    optimization: { moduleIds: 'deterministic', chunkIds: 'deterministic' },
    plugins: [
      new webpack.container.ModuleFederationPlugin(mf as ConstructorParameters<typeof webpack.container.ModuleFederationPlugin>[0]),
      ...(shell ? [new ProvideSdkPlugin()] : []),
    ],
  };
}
