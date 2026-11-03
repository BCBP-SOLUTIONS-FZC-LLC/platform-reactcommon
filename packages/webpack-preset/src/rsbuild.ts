/**
 * The preset as an Rsbuild plugin (`@bcbp-solutions-fzc-llc/webpack-preset/rsbuild`): the Rspack preset,
 * built with the Rspack @rsbuild/core bundles, merged into the Rspack config Rsbuild generates, with the
 * mode Rsbuild builds in. Imports only `@rsbuild/core`.
 *
 * ```ts
 * // rsbuild.config.ts
 * import { defineConfig } from '@rsbuild/core';
 * import { pluginReact } from '@rsbuild/plugin-react';
 * import { pluginPlatform } from '@bcbp-solutions-fzc-llc/webpack-preset/rsbuild';
 * export default defineConfig({ plugins: [pluginReact(), pluginPlatform({ role: 'remote', name: 'tenders', exposes: { './EditTender': './src/EditTender.tsx' } })] });
 * ```
 *
 * Don't also set Rsbuild's `moduleFederation` option: it adds Rspack's v2 Module Federation, which the
 * platform's shells and remotes do not speak.
 *
 * @packageDocumentation
 */
import { rspack, type RsbuildPlugin } from '@rsbuild/core';
import { rspackPresetWith } from './rspack-preset.ts';
import type { PresetOptions } from './shared.ts';

export const PLUGIN_PLATFORM_NAME = 'platform-preset';

/**
 * The preset's options for Rsbuild (PresetOptions without the mode, which comes from Rsbuild: `rsbuild build`
 * / `rsbuild dev`). Written out, so this entry's types reference no other entry's (whose types import webpack).
 */
export interface PlatformPluginOptions {
  role: 'shell' | 'remote';
  /** Remote: its manifest name, e.g. 'tenders'. Shell: ignored ('shell'). */
  name?: string;
  /** Remote: modules it exposes, e.g. { './EditTender': './src/EditTender.tsx' }. */
  exposes?: Record<string, string>;
}

export function pluginPlatform(o: PlatformPluginOptions): RsbuildPlugin {
  return {
    name: PLUGIN_PLATFORM_NAME,
    setup(api) {
      api.modifyRsbuildConfig((config, { mergeRsbuildConfig }) => {
        if (config.moduleFederation?.options) {
          throw new Error(`${PLUGIN_PLATFORM_NAME}: remove Rsbuild's moduleFederation option; the platform preset configures Module Federation itself (the v1 protocol its shells and remotes speak)`);
        }
        // The shell's scripts load from the site root (deep links, /auth/callback); a remote's relative to its remoteEntry.js.
        return mergeRsbuildConfig(config, { output: { assetPrefix: o.role === 'shell' ? '/' : 'auto' } });
      });
      api.modifyRspackConfig((config, { isProd, mergeConfig }) => {
        // The Rspack this Rsbuild bundles: an Rsbuild app needs no @rspack/core of its own.
        const preset = rspackPresetWith(rspack, { ...o, mode: isProd ? 'production' : 'development' } as PresetOptions);
        const merged = mergeConfig(config, preset);
        // The preset's file names and devtool win over Rsbuild's defaults (static/js/…, its source maps);
        // output.environment keeps the flags Rsbuild derives from its browserslist, plus globalThis.
        merged.output = { ...merged.output, ...preset.output, environment: { ...merged.output?.environment, ...preset.output?.environment } };
        if (preset.devtool !== undefined) merged.devtool = preset.devtool;
        return merged;
      });
    },
  };
}
