/**
 * The preset as an Rsbuild plugin (`@bcbp-solutions-fzc-llc/webpack-preset/rsbuild`): platformRspackConfig
 * merged into the Rspack config Rsbuild generates, with the mode Rsbuild builds in.
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
import type { RsbuildPlugin } from '@rsbuild/core';
import { platformRspackConfig } from './rspack.ts';
import type { PresetOptions } from './shared.ts';

export const PLUGIN_PLATFORM_NAME = 'platform-preset';

/** The preset's options for Rsbuild: the mode comes from Rsbuild (`rsbuild build` / `rsbuild dev`). */
export type PlatformPluginOptions = Omit<PresetOptions, 'mode'>;

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
        const preset = platformRspackConfig({ ...o, mode: isProd ? 'production' : 'development' } as PresetOptions);
        const merged = mergeConfig(config, preset);
        // The preset's file names and devtool win over Rsbuild's defaults (static/js/…, its source maps).
        merged.output = { ...merged.output, ...preset.output };
        if (preset.devtool !== undefined) merged.devtool = preset.devtool;
        return merged;
      });
    },
  };
}
