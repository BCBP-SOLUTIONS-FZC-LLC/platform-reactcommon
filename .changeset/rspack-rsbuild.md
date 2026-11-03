---
'@bcbp-solutions-fzc-llc/webpack-preset': minor
---

Rspack and Rsbuild support: `@bcbp-solutions-fzc-llc/webpack-preset/rspack` (`platformRspackConfig`, the webpack preset's settings with Rspack's webpack-compatible `ModuleFederationPluginV1`) and `@bcbp-solutions-fzc-llc/webpack-preset/rsbuild` (`pluginPlatform`). Rspack and webpack shells and remotes interoperate. Each entry loads only its own bundler (`/rsbuild` uses the Rspack that `@rsbuild/core` bundles); webpack, `@rspack/core` and `@rsbuild/core` are optional peers.
