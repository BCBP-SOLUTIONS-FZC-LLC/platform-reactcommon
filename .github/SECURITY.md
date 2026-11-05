# Security Policy

The full policy (trust model, known limitations, areas of particular sensitivity, scope) is in [SECURITY.md](../SECURITY.md). This page is the summary GitHub shows.

## Supported Versions

| Version | Supported |
|---------|-----------|
| `1.0.0-alpha.N` (current) | ✅ Active: fixes ship as the next alpha of all three packages |
| `1.x` (from `1.0.0`) | ✅ Active once released: fixes ship as patch versions |

All three packages share one version. When a new major line ships, the previous major receives security fixes only for six months. A fix reaches users once the shell and its remotes are rebuilt against it.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: vijay@bcbpsolutions.com
Subject: `[platform-reactcommon] Security vulnerability`

Include in your report:
- Description of the vulnerability and the affected package and subpath (for example `frontend-sdk/auth`, `webpack-preset`, a lint rule)
- Steps to reproduce (a Vitest test with `createTestPlatform` / `mockApi`, a page snippet, or a HAR for sign-in and token flows)
- The browser and version, if it matters
- Potential impact (token exposure, XSS, cross-tenant data on a shared device, identity spoofing, DoS, etc.)
- Suggested fix or patch (if any)

### Response timeline

| Step | Target |
|------|--------|
| Initial acknowledgement | 48 hours |
| Severity assessment | 5 business days |
| Fix released (critical / high) | 14 days |
| Public disclosure | After the fix ships and the shell and remotes have been told to upgrade |

We follow responsible disclosure. We will credit reporters in the release notes unless anonymity is requested.

## Scope

Areas of particular sensitivity in this library:

- **Tokens** — kept only in memory in `/auth`; any path to storage, logs, the cross-tab channel, a URL or another origin is critical.
- **Identity and correlation headers** — `/http` never sends identity headers and sends the token and trace headers only to allowed origins.
- **HTML** — `sanitizeHtml` and the `platform-sdk` Trusted Types policy are the only route for untrusted HTML; a bypass is XSS.
- **Remote code** — `/mfe` and the preset's integrity hashes decide what runs with the page's privileges.
- **Shared devices** — `/storage` namespaces and the clearing on sign-out keep one tenant's data from the next session.
- **Telemetry** — redaction keeps secrets and personal data out of what leaves the device.

Full in-scope and out-of-scope lists: [SECURITY.md § Scope](../SECURITY.md#scope).
