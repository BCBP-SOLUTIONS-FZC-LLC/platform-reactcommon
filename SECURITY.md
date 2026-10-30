# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `1.0.0-alpha.N` (current) | Yes: security fixes ship as the next `1.0.0-alpha.N` release of all three packages |
| `1.x` (from `1.0.0`, the first environment) | Yes: security fixes ship as patch versions |

The three packages (`@platform/frontend-sdk`, `@platform/webpack-preset`, `@platform/eslint-plugin`) always share one version, so a fix is released for all three at once. When a new major line (for example `2.x`) ships, the previous major receives security fixes only for six months after the new major's release.

A fix reaches users only when the shell **and** every remote are rebuilt against it, because the shell provides the SDK to every remote as a shared singleton.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues by email to **vijay@bcbpsolutions.com** with the subject line `[platform-reactcommon] Security vulnerability`.

Include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce or a proof of concept. A minimal Vitest test (the repo's `createTestPlatform` and `mockApi` help) or a short page snippet is enough; a HAR file for sign-in or token flows.
- The version(s) affected, and the subpath (for example `@platform/frontend-sdk/auth`).
- The browser and version, if the issue depends on one (Trusted Types, BroadcastChannel and storage behave differently between browsers).
- Any suggested fix, if you have one.

You will receive an acknowledgement within **2 business days** and a resolution timeline within **5 business days**.

## Trust model and known limitations

The SDK runs in the **browser, which is untrusted**. It protects the user's session and data inside the page, and it relies on the platform around it for everything the browser can't be trusted with:
- the **API gateway** (Envoy `jwt_authn` + IAM AuthZ Enrichment) validates every token, derives identity from it and authorizes every request;
- **Keycloak** owns credentials and sessions;
- **CloudFront** serves the app with the platform's Content Security Policy.

| Assumption | Implication |
|-----------|-------------|
| The gateway validates the token and strips client-supplied identity headers (`x-user-id`, `x-tenant-id`, `x-tenant-roles`, …) | The SDK never sends them (and `@platform/eslint-plugin` reports code that tries). Still, a backend reachable around the gateway would trust anything a script sends |
| UI permissions (`/authz`), feature flags and `useReadOnly` are hints | They hide or disable UI only. Any check that matters must be enforced by the gateway or the service; a user can always call the API directly |
| Tokens are held in memory, in a closure | They're never in storage, globals, logs or the cross-tab channel, so storage-reading attacks and other tabs can't take them. **Script running in the page (XSS) can still act as the user** while the page is open: it can call the API or wait for a token. The defence against that is the CSP (`script-src 'self'`, `require-trusted-types-for 'script'`), DOMPurify through `sanitizeHtml`, and the lint rules, not the token storage |
| Every remote runs with the page's full privileges | Module Federation remotes are same-origin script. A compromised remote build compromises the page. Remote entries are limited to the page's origin or exact allowed origins (checked twice), SRI is applied when the manifest gives a hash, and any remote can be switched off (`remotes.killSwitch`). Protecting the build and deploy pipeline is the real control |
| `runtime.json`, `/remotes/manifest.json` and the app's files are trusted as served | Anyone who can write to the S3 bucket or change CloudFront can change the IdP origin, the API allowlist or the remotes, which is code execution. Restrict write access and keep the CSP as the response-headers policy |
| The CSP is set by CloudFront, not by the SDK | Without the headers in `examples/cloudfront` (`script-src 'self'`, Trusted Types policies `platform-sdk`, `platform-webpack`, `dompurify`), the SDK's XSS defences are weaker. The SDK itself works under that CSP and never needs `eval` |
| `/otel` is unauthenticated by design (pre-login errors must be reported) | Anyone can post telemetry. The Collector must allowlist label values and drop per-browser attributes, and CloudFront's WAF rate-limits the path. Never alert on browser telemetry as if it were trusted |
| Browser storage on a shared device is namespaced, not encrypted | `/storage` keeps tenants apart (realm or `trial:<tenant_id>` namespaces, cleared on logout and switch), and refuses token-like keys. Don't store personal data there: anyone with the device can read it |
| Sign-in needs `sessionStorage` | With storage blocked (some private modes, strict policies), sign-in fails with a clear error instead of falling back to something weaker |
| `examples/` and `examples/cloudfront` are reference implementations | They're built and checked in CI but not deployed from here. Production shells, remotes and infrastructure must apply the same controls themselves |

## Scope

The following are in scope for vulnerability reports:

- A token (access, refresh or ID) reaching storage, a log, the BroadcastChannel, a global, or an origin other than the page's own (`/auth`, `/http`, `/logging`)
- The SDK sending an identity header, or forwarding correlation headers to an origin outside the allowlist (`/http`, `/tracing`)
- Sign-in flaws: authorization-code replay or injection, missing or bypassable `state`, `nonce` or `iss` checks, PKCE weaknesses, accepting an ID token from another realm or client (`/auth`)
- Refresh behaviour that resends a replaced refresh token (which revokes the user's whole Keycloak session), or other ways a page can sign the user out of every tab
- Open redirects through `returnUrl`, `navigate` or `isSafeRedirect` (`/auth`, `/nav`)
- XSS through `sanitizeHtml`, the `platform-sdk` Trusted Types policy, `problemMessage` / `t()` output, or error-boundary fallbacks (`/security`, `/i18n`, `/react`)
- One tenant's data readable by another through `/storage` on the same browser
- A remote entry loaded from an origin that isn't allowed, or SRI not applied when the manifest gives it (`/mfe`)
- Sensitive data in telemetry that the redaction rules should have removed (`/logging`, `/tracing`, `/core`)
- SDK or `@platform/webpack-preset` output that needs `eval`, inline script or a policy outside the CSP
- Denial-of-service conditions in the SDK: unbounded queues or memory, reload or redirect loops, retry storms

Out of scope:
- **Attacks that need control of the platform:** the attacker already controls the API gateway, Keycloak, CloudFront or S3, or the source or build of a deployed remote.
- **Out-of-band compromise:** physical access to an unlocked device, or malicious browser extensions.
- **Browser bugs** and weaknesses of a browser without Trusted Types support.
- **Unrelated dependency issues:** issues in transitive dependencies that don't affect the SDK's behaviour (report those upstream; Trivy and `pnpm audit` run in CI).
- **The reference code:** issues that exist only in `examples/`.
