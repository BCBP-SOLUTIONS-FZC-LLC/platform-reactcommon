/**
 * What the webpack and Rspack presets share: the Module Federation shared map, the container naming rule,
 * the options and the CSP-safe output settings. No bundler is imported here, so each entry point loads
 * only the bundler it is for.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
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
  if (typeof v !== 'string') throw new Error(`@bcbp-solutions-fzc-llc/webpack-preset package.json has no platformShared pin for ${name}`);
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
export const SHARED_SDK_SUBPATHS: readonly string[] = SDK_SUBPATHS.filter((s) => !NOT_SHARED.has(s)).map((s) => `${SDK_PACKAGE}/${s}`);

const NAME = /^[a-z][a-z0-9_-]{0,62}$/;

/**
 * The global a remote's container is exposed as: `__platform_mfe_` + its name with '-' as '_' (a valid
 * identifier that no element id or browser global shadows). The SDK's loadRemote looks it up with the same rule.
 */
export function containerName(remote: string): string {
  if (typeof remote !== 'string' || !NAME.test(remote) || remote === 'shell') {
    throw new TypeError(`remote name must match ${NAME.source} and not be 'shell', got ${JSON.stringify(remote)}`);
  }
  return `__platform_mfe_${remote.replace(/-/g, '_')}`;
}

export interface PresetOptions {
  role: 'shell' | 'remote';
  /** Remote: its manifest name, e.g. 'tenders'. Shell: ignored ('shell'). */
  name?: string;
  /** Remote: modules it exposes, e.g. { './EditTender': './src/EditTender.tsx' }. */
  exposes?: Record<string, string>;
  mode: 'production' | 'development';
}

/** Throws on an unknown role or mode. */
export function checkOptions(o: PresetOptions): void {
  if (o.role !== 'shell' && o.role !== 'remote') throw new TypeError(`role must be 'shell' or 'remote', got ${JSON.stringify(o.role)}`);
  if (o.mode !== 'production' && o.mode !== 'development') throw new TypeError(`mode must be 'production' or 'development'`);
}

/** The ModuleFederationPlugin options for the role (webpack's, and Rspack's v1-compatible plugin). */
export function federationOptions(o: PresetOptions) {
  return o.role === 'remote'
    ? {
        name: containerName(o.name ?? ''),
        // A plain global: the SDK injects remoteEntry.js and reads window[containerName(name)].
        library: { type: 'var' as const, name: containerName(o.name ?? '') },
        filename: 'remoteEntry.js',
        exposes: o.exposes ?? {},
        shared: sharedFor('remote'),
      }
    : { name: 'shell', shared: sharedFor('shell') };
}

/** The settings every build gets, whatever the bundler: devtool, output, ids. */
export function baseConfig(o: PresetOptions) {
  const prod = o.mode === 'production';
  const shell = o.role === 'shell';
  // The shell is served from the site root, and index.html is returned for every deep link (the SPA
  // rewrite): its scripts must load from '/', never relative to /t/acme/… or /auth/callback. Its hashed
  // bundles go under assets/, the immutable CloudFront behavior. A remote's chunks load relative to its
  // remoteEntry.js, wherever the manifest points ('auto').
  const js = prod ? '[name].[contenthash].js' : '[name].js';
  return {
    mode: o.mode,
    // No eval-based devtool in any mode (CSP script-src 'self'); production maps are uploaded privately, never served.
    devtool: prod ? ('hidden-source-map' as const) : ('cheap-module-source-map' as const),
    output: {
      publicPath: shell ? '/' : 'auto',
      filename: shell ? `assets/${js}` : js,
      chunkFilename: shell ? `assets/${js}` : js,
      assetModuleFilename: prod ? 'assets/[name].[contenthash][ext]' : 'assets/[name][ext]',
      // require-trusted-types-for 'script': the bundler's script URLs go through this policy. The shell's
      // runtime and every remote's create it under the same name, so the CSP's trusted-types directive
      // carries 'allow-duplicates' (examples/cloudfront/csp.mjs).
      trustedTypes: { policyName: 'platform-webpack' },
      // Lazily loaded chunks carry integrity (ChunkIntegrityPlugin); a cross-origin one is fetched with
      // CORS, as SRI requires (crossorigin is set only for URLs outside the page's origin).
      crossOriginLoading: 'anonymous' as const,
      // Every supported browser has globalThis: without this, the runtime keeps a
      // new Function('return this') fallback, which script-src 'self' forbids.
      environment: { globalThis: true },
      uniqueName: o.role === 'remote' ? containerName(o.name ?? '') : 'shell',
    },
    optimization: { moduleIds: 'deterministic' as const, chunkIds: 'deterministic' as const },
  };
}

/** Finds the SDK package's version from a file inside it (the nearest package.json named after the SDK). */
export function sdkVersionAt(file: string, readJson: (path: string) => { name?: string; version?: string } | undefined): string | undefined {
  for (let dir = file.replace(/[/\\][^/\\]*$/, ''); dir && dir !== file; ) {
    const pkgJson = readJson(`${dir}/package.json`);
    if (pkgJson?.name === SDK_PACKAGE) return pkgJson.version;
    const up = dir.replace(/[/\\][^/\\]*$/, '');
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

// The SRI helpers (ChunkIntegrityPlugin in integrity.ts), here so the entry points' types need no bundler.
/** Replaced, after minification, by the map; a string literal so every minifier keeps it. */
export const INTEGRITY_PLACEHOLDER = '__PLATFORM_CHUNK_INTEGRITY__';
/**
 * The integrity a chunk the build did not hash gets at run time: well-formed, so the browser enforces
 * it (a malformed value would be ignored), and matching no content, so the load fails closed.
 */
export const MISSING_INTEGRITY = `sha384-${Buffer.alloc(48).toString('base64')}`;

/** The SRI value of `content` (sha384, as the remote manifest's integrity field). */
export function integrityOf(content: Buffer | string): string {
  return `sha384-${createHash('sha384').update(content).digest('base64')}`;
}

export { SDK_PACKAGE };
