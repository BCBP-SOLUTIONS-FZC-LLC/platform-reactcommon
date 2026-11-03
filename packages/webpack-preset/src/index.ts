/**
 * Webpack 5 Module Federation preset for the platform's shell and remotes (design doc §C3): one shared
 * map for every app (singletons, strict versions), the SDK provided by the shell only (a remote requires
 * at least the SDK version it was built against), and CSP-safe
 * output (Trusted Types, no eval devtools, hidden source maps, content hashes).
 * Rspack and Rsbuild: the `/rspack` and `/rsbuild` entry points, with the same shared map and output.
 *
 * @packageDocumentation
 */
import webpack, { type Compilation, type Compiler, type Configuration } from 'webpack';
import { ChunkIntegrityPlugin } from './integrity.ts';
import { SDK_PACKAGE, SHARED_SDK_SUBPATHS, baseConfig, checkOptions, federationOptions, type PresetOptions } from './shared.ts';

export { ChunkIntegrityPlugin, INTEGRITY_PLACEHOLDER, MISSING_INTEGRITY, integrityOf } from './integrity.ts';
export { containerName, platformShared, sharedFor, type PresetOptions, type SharedConfig } from './shared.ts';

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
    // ProvideSharedPlugin taps compiler.hooks.compilation and finishMake, which webpack copies into
    // every child compiler (HtmlWebpackPlugin's, for one): applied to the compiler itself, each child
    // compilation built and emitted a second, unused copy of every SDK chunk. It is applied to this
    // adapter instead, whose hooks run for the main compilation only (thisCompilation, which child
    // compilers do not inherit; finishMake for the compilation of this compiler).
    type CompilationParams = Parameters<Parameters<Compiler['hooks']['thisCompilation']['tap']>[1]>[1];
    const onCompilation: ((c: Compilation, p: CompilationParams) => void)[] = [];
    const onFinishMake: ((c: Compilation) => Promise<unknown>)[] = [];
    const adapter = {
      context: compiler.context,
      hooks: {
        validate: { tap: () => {} },
        compilation: { tap: (_: string, fn: (c: Compilation, p: CompilationParams) => void) => void onCompilation.push(fn) },
        finishMake: { tapPromise: (_: string, fn: (c: Compilation) => Promise<unknown>) => void onFinishMake.push(fn) },
      },
    };
    compiler.hooks.thisCompilation.tap(ProvideSdkPlugin.name, (compilation, params) => {
      for (const fn of onCompilation) fn(compilation, params);
    });
    compiler.hooks.finishMake.tapPromise(ProvideSdkPlugin.name, async (compilation) => {
      if (compilation.compiler !== compiler) return; // a child compilation (this tap is copied into it)
      await Promise.all(onFinishMake.map((fn) => fn(compilation)));
    });

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
      new webpack.sharing.ProvideSharedPlugin({ provides }).apply(adapter as unknown as Compiler);
    });
  }
}

/**
 * The platform's webpack settings for a shell or remote, to merge into the app's own config (the app adds
 * entry, loaders and dev server). Adds the ModuleFederationPlugin with sharedFor(role), for the shell
 * the ProvideSdkPlugin (every SDK subpath in the share scope), and in production the
 * ChunkIntegrityPlugin (integrity on every lazily loaded chunk).
 */
export function platformWebpackConfig(o: PresetOptions): Configuration {
  checkOptions(o);
  const mf = federationOptions(o);
  return {
    ...baseConfig(o),
    plugins: [
      new webpack.container.ModuleFederationPlugin(mf as ConstructorParameters<typeof webpack.container.ModuleFederationPlugin>[0]),
      ...(o.role === 'shell' ? [new ProvideSdkPlugin()] : []),
      ...(o.mode === 'production' ? [new ChunkIntegrityPlugin()] : []),
    ],
  };
}
