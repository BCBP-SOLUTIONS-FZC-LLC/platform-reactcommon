---
'@platform/webpack-preset': patch
---

The shell provides every SDK subpath in the share scope (`ProvideSdkPlugin`, added by `platformWebpackConfig({ role: 'shell' })`, lazily), not only those it imports itself: a remote using one the shell never imported failed with "Shared module … doesn't exist in shared scope". The deployed CSP must allow the `platform-webpack` Trusted Types policy to be created by the shell and every remote (`trusted-types … 'allow-duplicates'`, examples/cloudfront/csp.mjs). Found by the integrated E2E run (docs/e2e/integrated-deployment-report.md, Issues 1 and 2).
