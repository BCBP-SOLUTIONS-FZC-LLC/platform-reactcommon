---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
---

Add `@bcbp-solutions-fzc-llc/frontend-sdk/problem`: the platform error type registry (`PlatformProblemTypes`,
`typeForStatus`, `defineProblemType` with gincommon's NewType rules), the error model
(`ProblemError`, `TimeoutError`, `NetworkError`, `AbortedError`), `parseProblemResponse` (gincommon
decoder parity, synthetic problems for non-problem responses) and the gateway deny codes
(`GATEWAY_DENY_CODES`, `gatewayDenyCode`).
