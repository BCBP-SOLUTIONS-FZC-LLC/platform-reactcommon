---
'@platform/webpack-preset': minor
---

First release: `platformShared` (React, react-dom, `@opentelemetry/api` `~1.10.0` and every SDK subpath
except /testing as strict singletons; the SDK under `^1.0.0-0`), `sharedFor('shell' | 'remote')`
(shell `eager: false`; remotes never bundle the SDK, `import: false`), `containerName` (the SDK's
'-' → '_' container global rule) and `platformWebpackConfig` (Module Federation plugin, Trusted Types
policy `platform-webpack`, no eval devtools, hidden source maps, content hashes, `publicPath: 'auto'`).
