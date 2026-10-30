/**
 * Browser metrics under the Enterprise Platform Observability Standard: domain (Tier 2) and
 * service (Tier 3) meters with centrally injected identity labels, the standard's naming and label
 * rules, and delta OTLP export. Design contract: docs/design/frontend-sdk-design.md §C1 `/metrics`.
 *
 * @packageDocumentation
 */
export {
  InvalidMetricError,
  getDomainMeter,
  getServiceMeter,
  initializeMetrics,
  startWebVitals,
  type Counter,
  type Histogram,
} from './metrics.ts';
