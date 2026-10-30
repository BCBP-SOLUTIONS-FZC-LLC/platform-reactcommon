---
'@platform/frontend-sdk': minor
---

Add `@platform/frontend-sdk/metrics` (Tier 2 and Tier 3): `getDomainMeter` and `getServiceMeter`
under the Enterprise Platform Observability Standard, with gincommon's naming and label rules
(checked against `metricslint`), centrally injected `domain`/`service`/`environment`, remote
identity from the manifest's owning domain, cardinality bounds, and a delta OTLP exporter gated
on telemetry consent. `startWebVitals` records nothing until the Tier 1 binding. Generated
contracts are now one module each, so a subpath bundles only the contracts it uses.
