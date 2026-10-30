---
'@platform/frontend-sdk': minor
---

Add `@platform/frontend-sdk/testing`: `createTestPlatform` (a real SDK runtime with in-memory logs and
spans, a signed-in session, role-map permissions and flags, and a `Wrapper`), `mockApi` and
`mockProblem` (gincommon-shaped RFC 9457 bodies; unmatched routes answer ROUTE_NOT_FOUND), and
`renderMetricInventory` for `metricslint check` in a remote's CI.
