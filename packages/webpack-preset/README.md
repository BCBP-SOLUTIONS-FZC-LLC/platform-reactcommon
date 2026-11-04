# @bcbp-solutions-fzc-llc/webpack-preset

Module Federation configuration for the platform's shell and remotes: strict shared singletons (React, react-dom, `@opentelemetry/api`, every SDK subpath), the SDK provided by the shell, a check that the installed SDK is the preset's version, CSP-safe output (Trusted Types, no `eval`), and, in production, Subresource Integrity on every lazily loaded JS and CSS chunk and on the HTML's scripts and stylesheets (`ChunkIntegrityPlugin`).

| Entry point | Bundler | Use |
|---|---|---|
| `@bcbp-solutions-fzc-llc/webpack-preset` | webpack 5 (`^5.100.0`) | `platformWebpackConfig({ role, name, exposes, mode })` |
| `@bcbp-solutions-fzc-llc/webpack-preset/rspack` | Rspack (`@rspack/core` `^2.2.0`) | `platformRspackConfig(…)` |
| `@bcbp-solutions-fzc-llc/webpack-preset/rsbuild` | Rsbuild (`@rsbuild/core` `^2.2.0`) | `pluginPlatform({ role, name, exposes })` |

Each bundler is an optional peer: install the one you build with. Lazily loaded CSS gets its integrity through mini-css-extract-plugin or native CSS (webpack), `CssExtractRspackPlugin` or native CSS (Rspack, Rsbuild); a production build whose lazy CSS comes through another loader fails. Node ≥ 22, ESM only. Installs from GitHub Packages (`@bcbp-solutions-fzc-llc` scope, `read:packages`).

Documentation (in the repository):

- [README](https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/blob/main/README.md): integrating a shell and a remote
- [LLD §13.1](https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/blob/main/docs/lld/platform-reactcommon-lld.md#131-bcbp-solutions-fzc-llcwebpack-preset): every option and plugin
- [CHANGELOG](https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/blob/main/CHANGELOG.md)
