---
'@bcbp-solutions-fzc-llc/frontend-sdk': major
'@bcbp-solutions-fzc-llc/webpack-preset': major
'@bcbp-solutions-fzc-llc/eslint-plugin': major
---

Renamed from `@platform/*` to the organisation's scope, `@bcbp-solutions-fzc-llc/*`, and published to GitHub Packages (the `platform` scope on npmjs.com belongs to a third party). Update imports, webpack shared keys (the preset does this), ESLint configs (`@bcbp-solutions-fzc-llc/<rule>`) and `.npmrc` (`@bcbp-solutions-fzc-llc:registry=https://npm.pkg.github.com`). `@bcbp-solutions-fzc-llc/webpack-preset`: production builds put a sha384 on every lazily loaded chunk (`ChunkIntegrityPlugin`), `crossOriginLoading` is `'anonymous'`, and `ProvideSdkPlugin` no longer emits duplicate SDK chunks from child compilations.
