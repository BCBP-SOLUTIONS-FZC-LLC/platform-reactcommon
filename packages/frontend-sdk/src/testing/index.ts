/**
 * Test helpers for remotes and the shell (dev only): a real SDK runtime with in-memory telemetry, API
 * mocks with gincommon-shaped problem bodies, and the metric inventory for `metricslint check`.
 * Design contract: docs/design/frontend-sdk-design.md §C1 `/testing`.
 *
 * @packageDocumentation
 */
export { createTestPlatform, type LogRecord, type SpanRecord } from './platform.tsx';
export { mockApi, mockProblem } from './mock-api.ts';
/**
 * Prometheus text exposition of every instrument registered so far (one sample per label set seen), with the
 * injected domain/service/environment, for `metricslint check` in a remote's CI. Names are the registry names.
 */
export { renderMetricInventory } from '../metrics/inventory.ts';
