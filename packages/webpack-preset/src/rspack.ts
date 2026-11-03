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
import { rspack, type RspackOptions } from '@rspack/core';
import { rspackPresetWith } from './rspack-preset.ts';
import type { PresetOptions } from './shared.ts';

export { INTEGRITY_PLACEHOLDER, MISSING_INTEGRITY, containerName, integrityOf, platformShared, sharedFor, type PresetOptions, type SharedConfig } from './shared.ts';

export { GlobalThisOnlyPlugin, ProvideSdkRspackPlugin } from './rspack-preset.ts';

/**
 * The platform's Rspack settings for a shell or remote, to merge into the app's own config (the app adds
 * entry, loaders, HTML and dev server), as platformWebpackConfig does for webpack: Module Federation with
 * sharedFor(role) (v1 protocol), for the shell the SDK provider, the globalThis-only runtime, and in
 * production the ChunkIntegrityPlugin.
 */
export function platformRspackConfig(o: PresetOptions): RspackOptions {
  return rspackPresetWith(rspack, o);
}
