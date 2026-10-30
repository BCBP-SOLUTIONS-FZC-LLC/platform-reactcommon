# Foundation

`/core` · `/config` · `/problem`

What every other area stands on: who the page is, what the user consented to, how the page is configured, and what an error looks like. Every shell and remote uses it, directly or through another area.

| Subpath | What it does | Main exports |
|---|---|---|
| `/core` | The page identity (`domain`, `service`, `environment`, `buildVersion`) validated against the platform registry; consent; the RUM session id shared by tabs; request ids; log-safe sanitizing | `initializeCore`, `getIdentity`, `setConsentProvider`, `hasConsent`, `getSessionId`, `newRequestId`, `sanitizeString`, `sanitizeFields`, `isSensitiveKey`, `DOMAINS`, `ENVIRONMENTS` |
| `/config` | `/config/runtime.json`: loaded once by the shell, validated strictly (an unknown key fails), frozen, read by everyone | `loadRuntimeConfig`, `setRuntimeConfig`, `getConfig`, `tryGetConfig`, `RuntimeConfigSchema`, `RuntimeConfigError` |
| `/problem` | RFC 9457 Problem Details as platform-gincommon and platform-fastapicommon send them, and the other API errors | `parseProblemResponse`, `ProblemError`, `isProblemError`, `PlatformProblemTypes`, `defineProblemType`, `toFieldErrorMap`, `gatewayDenyCode`, `TimeoutError`, `NetworkError`, `AbortedError` |

## How it's used

The shell, once:

```ts
initializeCore({ serviceName: 'web-app', domain: 'portal', environment: __ENVIRONMENT__, buildVersion: __BUILD_VERSION__ });
setRuntimeConfig(await loadRuntimeConfig());
setConsentProvider(cmp);
```

A remote never initializes anything; it reads: `getIdentity()`, `tryGetConfig()`, `hasConsent('telemetry')`. Errors from an API call are matched by type:

```ts
if (isProblemError(e) && e.is(PlatformProblemTypes.ValidationFailed)) setErrors(toFieldErrorMap(e));
```

## Guarantees

- **One page identity.** A second `initializeCore` with different values throws `IdentityMismatchError`. Remotes are told apart by `mfe`, never by `domain`.
- **The domain and environment vocabularies, the patterns and the problem types** are generated from the backend's own sources (`contracts/`), never typed by hand.
- **Nothing leaves the page without consent:** `essential` is always granted, `telemetry` only when the consent manager says so.
- **The raw body of a non-problem error is never surfaced:** a problem is synthesized from the status.

Design doc: §C1 `/core`, `/config`, `/problem`, §C5 (contracts).
