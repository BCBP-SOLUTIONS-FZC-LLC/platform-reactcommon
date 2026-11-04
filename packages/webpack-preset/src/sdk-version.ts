/**
 * The preset and the SDK release under one version: the preset's remote range (`^<its SDK version>`) and
 * its shared map are generated from that SDK. A build whose installed SDK differs would declare one SDK
 * version and call another's exports, so it fails. Bundler-agnostic: webpack and Rspack both run it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SDK_PACKAGE, SDK_VERSION } from './generated/sdk.ts';

const NAME = 'PlatformSdkVersionPlugin';

/** The version of the SDK installed for `context`, found as Node finds a package (node_modules up the tree). */
export function installedSdkVersion(context: string): string | undefined {
  for (let dir = context; ; dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', SDK_PACKAGE, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (pkg.name === SDK_PACKAGE && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // not installed at this level
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** What the plugin needs of a webpack or Rspack compiler. */
interface CompilerLike {
  context: string;
  webpack: { WebpackError: new (message: string) => Error };
  hooks: { thisCompilation: { tap(name: string, fn: (compilation: { errors: Error[] }) => void): void } };
}

/**
 * Fails the build when the SDK installed for the app is not the version this preset was released with.
 * An app without the SDK installed is not checked: it imports nothing from it.
 */
export class SdkVersionPlugin {
  apply(compiler: CompilerLike): void {
    const installed = installedSdkVersion(compiler.context);
    if (installed === undefined || installed === SDK_VERSION) return;
    const message =
      `${NAME}: @bcbp-solutions-fzc-llc/webpack-preset ${SDK_VERSION} needs ${SDK_PACKAGE} ${SDK_VERSION}, ` +
      `but ${compiler.context} has ${installed}. Install the same version of both (VERSIONING.md).`;
    compiler.hooks.thisCompilation.tap(NAME, (compilation) => void compilation.errors.push(new compiler.webpack.WebpackError(message)));
  }
}
