/**
 * The preset for Rspack (`@bcbp-solutions-fzc-llc/webpack-preset/rspack`): the same shared map, output
 * and integrity as the webpack preset, so an Rspack shell loads webpack remotes and the other way round.
 *
 * Module Federation is Rspack's `ModuleFederationPluginV1`, the webpack-compatible container and share-scope
 * protocol the SDK's loadRemote speaks (Rspack's default ModuleFederationPlugin is the v2 runtime, which a
 * webpack shell or remote does not). Imports only `@rspack/core`, never webpack.
 *
 * @packageDocumentation
 */
import { readFileSync } from 'node:fs';
import { rspack, type Compiler, type RspackOptions, type RspackPluginInstance } from '@rspack/core';
import { ChunkIntegrityPlugin } from './integrity.ts';
import { SDK_PACKAGE, SHARED_SDK_SUBPATHS, baseConfig, checkOptions, federationOptions, sdkVersionAt, type PresetOptions } from './shared.ts';

export { INTEGRITY_PLACEHOLDER, MISSING_INTEGRITY, integrityOf } from './integrity.ts';
export { containerName, platformShared, sharedFor, type PresetOptions, type SharedConfig } from './shared.ts';

const readJson = (path: string): { name?: string; version?: string } | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string };
  } catch {
    return undefined;
  }
};

/**
 * The shell provides every shared SDK subpath, not only those its own code imports (as the webpack
 * preset's ProvideSdkPlugin: a remote's SDK has no fallback). Each subpath is resolved as the shell's own
 * imports are (Rspack's resolver, ESM conditions, from the shell's context) and registered with Rspack's
 * ProvideSharedPlugin by its absolute path, lazily (eager: false). Rspack's sharing plugins are native and
 * take their options when applied, so the resolution happens here, synchronously.
 */
export class ProvideSdkRspackPlugin implements RspackPluginInstance {
  apply(compiler: Compiler): void {
    const resolver = compiler.resolverFactory.get('normal', { dependencyType: 'esm' });
    const provides: Record<string, { shareKey: string; version: string; eager: false }> = {};
    for (const request of SHARED_SDK_SUBPATHS) {
      let path: string | false;
      try {
        path = resolver.resolveSync({}, compiler.context, request);
      } catch (e) {
        throw new Error(`the shell cannot resolve ${request} from ${compiler.context}: it must depend on ${SDK_PACKAGE} (${(e as Error).message})`, { cause: e });
      }
      if (typeof path !== 'string') throw new Error(`the shell cannot resolve ${request} from ${compiler.context}: it must depend on ${SDK_PACKAGE}`);
      const version = sdkVersionAt(path, readJson);
      if (!version) throw new Error(`${request} resolved to ${path}, which has no ${SDK_PACKAGE} package.json version`);
      provides[path] = { shareKey: request, version, eager: false };
    }
    new compiler.rspack.sharing.ProvideSharedPlugin({ provides }).apply(compiler);
  }
}

const GLOBAL_THIS = 'PlatformGlobalThisPlugin';

/**
 * Rspack's global-object runtime keeps a `new Function('return this')` fallback whatever
 * `output.environment.globalThis` says (webpack drops it). Every supported browser has globalThis, and
 * CSP script-src 'self' forbids the Function constructor, so the runtime module is rewritten to
 * `globalThis` alone. A build whose runtime still contains the fallback fails.
 */
export class GlobalThisOnlyPlugin implements RspackPluginInstance {
  apply(compiler: Compiler): void {
    const { RuntimeGlobals } = compiler.rspack;
    compiler.hooks.thisCompilation.tap(GLOBAL_THIS, (compilation) => {
      compilation.hooks.runtimeModule.tap(GLOBAL_THIS, (module) => {
        if (module.name !== 'global' || !module.source) return;
        module.source.source = Buffer.from(`${RuntimeGlobals.global} = globalThis;\n`);
      });
      compilation.hooks.processAssets.tap({ name: GLOBAL_THIS, stage: compiler.rspack.Compilation.PROCESS_ASSETS_STAGE_REPORT }, () => {
        for (const chunk of compilation.chunks) {
          if (!chunk.hasRuntime()) continue;
          for (const file of chunk.files) {
            if (!file.endsWith('.js')) continue;
            const text = compilation.getAsset(file)!.source.source().toString();
            if (/\bFunction\(\s*["']return this["']\s*\)/.test(text)) {
              compilation.errors.push(new compiler.rspack.WebpackError(`${GLOBAL_THIS}: ${file} still has the Function('return this') fallback, which CSP script-src 'self' forbids`));
            }
          }
        }
      });
    });
  }
}

/**
 * The platform's Rspack settings for a shell or remote, to merge into the app's own config (the app adds
 * entry, loaders, HTML and dev server), as platformWebpackConfig does for webpack: Module Federation with
 * sharedFor(role) (v1 protocol), for the shell the SDK provider, the globalThis-only runtime, and in
 * production the ChunkIntegrityPlugin.
 */
export function platformRspackConfig(o: PresetOptions): RspackOptions {
  checkOptions(o);
  return {
    ...baseConfig(o),
    plugins: [
      new rspack.container.ModuleFederationPluginV1(federationOptions(o) as ConstructorParameters<typeof rspack.container.ModuleFederationPluginV1>[0]),
      ...(o.role === 'shell' ? [new ProvideSdkRspackPlugin()] : []),
      new GlobalThisOnlyPlugin(),
      // The same plugin as webpack's: Rspack's JS API offers the hooks it uses (see integrity.ts).
      ...(o.mode === 'production' ? [new ChunkIntegrityPlugin() as unknown as RspackPluginInstance] : []),
    ],
  };
}
