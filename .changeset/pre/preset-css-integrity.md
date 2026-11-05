---
'@bcbp-solutions-fzc-llc/webpack-preset': minor
---

`ChunkIntegrityPlugin` gives lazily loaded CSS chunks a sha384 too (mini-css-extract-plugin and native CSS on webpack; `CssExtractRspackPlugin` and native CSS on Rspack and Rsbuild), fail-closed like JS chunks, and pins the stylesheets of the build's HTML as it pins its scripts. A build whose lazily loaded CSS comes through a loader that sets no integrity fails.
