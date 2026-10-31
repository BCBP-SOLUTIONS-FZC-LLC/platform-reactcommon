# Smoke tests

The web distribution as a browser meets it (examples/cloudfront/README.md, design doc §C3): the shell
document and its security headers, the SPA rewrite, `/api/*` never answered with HTML,
`/config/runtime.json` and `/remotes/manifest.json` validated by the SDK, each remote entry loading
(with its SRI hash), and `/version.json`. Left out of `pnpm test`, as in platform-gincommon.

**In-process** (default): `cloudfront-stand-in.ts` serves the built examples on an ephemeral local port
the way the distribution's behaviors do (the real `spa-rewrite.js` and `securityHeaders()`; the
manifest and `version.json` the deploy would write). Build first:

```sh
pnpm build
pnpm run test-smoke
```

**Against an environment**: the same assertions, GET only, no local server. Set `ENVIRONMENT` to the
deployment's environment (the runtime config's localhost-origin rule depends on it):

```sh
SMOKE_BASE_URL=https://app.dev.bcbpsolutions.com ENVIRONMENT=dev pnpm run test-smoke
```

Both variables can also come from `.env` (test/testenv). Live, the CSP is checked for its required
directives rather than for equality with `buildCsp()`, and a missing `/version.json` skips its test.
