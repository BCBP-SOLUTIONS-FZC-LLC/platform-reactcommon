# Platform Observability Registry (as the SDK validates it)

<!-- Generated from packages/frontend-sdk/contracts/metric-registry.json by `pnpm docs:sync`. Do not edit. -->

The SDK checks every Tier 2 and Tier 3 metric it registers against this registry (`/metrics`), the same document platform-gincommon's `metricslint` enforces. It is a generated copy of gincommon's `internal/obsregistry/registry.json` at the commit pinned in `contracts/sources.json`; change it there, by registry PR, then run `pnpm contracts:sync`.

Every metric carries the centrally injected const labels `domain`, `service`, `environment`. Required labels: platform tier `domain`, `service`, `environment`; domain tier `service`, `environment`; service tier `service`, `environment`.

The SDK's own browser metrics (`platform_web_*`) are **not** in this registry yet: they are proposed for ratification (design doc §D5, §D6 K) and listed in [README.md](README.md#tier-1-browser-metrics-proposed).

## Tier 1: platform-shared metrics

| Metric | Owner | Type | Status | Labels | Meaning |
|---|---|---|---|---|---|
| `platform_build_info` | platform-gincommon | gauge | proposed | `version` | Always 1; the version label carries the build of the emitting service. |
| `platform_db_pool_acquire_duration_seconds` | platform-pgcommon | histogram | proposed | `pool` | Time a caller waited to check a connection out of a pgcommon pool, recorded for every attempt including failures — a saturation signal. |
| `platform_db_pool_acquires_total` | platform-pgcommon | counter | proposed | `pool`, `outcome` | One attempt to check a connection out of a pgcommon pool (WithConn, RunInTx and helpers), by outcome; error includes acquire timeouts (context deadline exceeded while waiting) and a closed pool. An attempt abandoned by the caller (context cancelled) is not counted under either outcome; its wait is still recorded in platform_db_pool_acquire_duration_seconds. |
| `platform_db_pool_connections` | platform-pgcommon | gauge | proposed | `pool`, `state` | Connections currently held by a pgcommon pool, by state: idle (available), acquired (checked out), constructing (being dialled). Sampled at scrape time from the pool's statistics. |
| `platform_db_pool_empty_acquires_total` | platform-pgcommon | counter | proposed | `pool` | Cumulative acquires that had to wait because every connection was checked out (pool exhausted). A rising rate means the pool is undersized for the service's concurrency. |
| `platform_db_pool_max_connections` | platform-pgcommon | gauge | proposed | `pool` | The configured connection limit of a pgcommon pool (Config.MaxConns). |
| `platform_db_queries_total` | platform-pgcommon | counter | proposed | `pool`, `operation`, `outcome` | One statement a service executed against PostgreSQL through a pgcommon pool — a query, a SendBatch (operation=BATCH) or a CopyFrom (operation=COPY) — counted when it completes, by outcome. Statements pgcommon issues itself (RLS GUC set_config on acquire, BEGIN / COMMIT / ROLLBACK, transaction timeouts, savepoints, the PgBouncer wrapping transaction) are excluded unless they fail: a failed COMMIT or GUC injection is a failure of the caller's work. |
| `platform_db_query_duration_seconds` | platform-pgcommon | histogram | proposed | `pool`, `operation` | Client-observed wall time of one statement (query, SendBatch or CopyFrom) against PostgreSQL through a pgcommon pool, from send to result. Library-internal statements (RLS GUC set_config, BEGIN / COMMIT / ROLLBACK, transaction timeouts, savepoints) are excluded unless they fail: a failed COMMIT or GUC injection is a failure of the caller's work. |
| `platform_db_slow_queries_total` | platform-pgcommon | counter | proposed | `pool` | A statement whose wall time exceeded the pool's configured slow-query threshold (Config.SlowQueryThreshold). Counted for every occurrence, independent of log rate limiting. Library-internal statements (RLS GUC set_config, BEGIN / COMMIT / ROLLBACK, transaction timeouts, savepoints) are excluded. |
| `platform_db_transaction_retries_exhausted_total` | platform-pgcommon | counter | proposed | `pool`, `reason` | A RunInTxWithRetry* call that used every attempt and still failed with a retryable error — the operation failed for the caller. |
| `platform_db_transaction_retries_total` | platform-pgcommon | counter | proposed | `pool`, `reason` | A transaction attempt that failed with a retryable PostgreSQL error and was retried by RunInTxWithRetry*: deadlock (SQLSTATE 40P01) or serialization failure (40001). |
| `platform_dependency_request_seconds` | platform-events | histogram | proposed | `dependency`, `operation`, `outcome` | Client-observed wall time of one call to an external dependency — SNS (publish, publish_batch), SQS (receive_message, delete_message, change_message_visibility, send_message, get_queue_attributes, get_queue_url) or the configured schema-registry codec (encode, decode) — by outcome. The _count series counts calls. receive_message is a long poll: its duration includes up to WaitTimeSeconds (default 20 s) of waiting on an empty queue, so exclude it from latency views (it stays meaningful for error rates). |
| `platform_dlq_depth` | platform-events | gauge | proposed | `queue` | Messages sitting in the dead-letter queue attached to a consumer's queue by its RedrivePolicy (SQS ApproximateNumberOfMessages of the DLQ), sampled with platform_queue_depth. queue is the SOURCE queue's name, so the gauge joins with the consumer's other queue metrics. |
| `platform_dlq_messages_total` | platform-events | counter | approved | `operation`, `event_type`, `reason` | A message moved to dead-letter storage: forwarded to its SQS queue's RedrivePolicy DLQ (operation=consume), or moved to outbox_dead_letters after exhausting its publish attempts (operation=outbox_publish), by reason. |
| `platform_duplicate_messages_total` | platform-events | counter | proposed | `queue`, `event_type` | A redelivered message acknowledged without running its handler because the consumer's dedup ledger (inbox processed_events) had already recorded its event ID. |
| `platform_event_propagation_seconds` | platform-events | histogram | proposed | `queue`, `event_type` | Time from an event's creation (envelope `time`, set by the producer) to its FIRST receipt by a consumer (ApproximateReceiveCount ≤ 1) — end-to-end propagation delay through the outbox, SNS and SQS. Redeliveries are not observed, so retry delay does not inflate it. Negative clock skew is clamped to 0. |
| `platform_grpc_panics_total` | platform-gincommon | counter | proposed | `grpc_method` | gRPC handler panics recovered by the interceptor stack. |
| `platform_grpc_rate_limited_requests_total` | platform-gincommon | counter | proposed | `grpc_method` | gRPC RPCs that ended with ResourceExhausted. |
| `platform_grpc_server_handled_total` | platform-gincommon | counter | proposed | `grpc_method`, `grpc_code`, `status_class`, `error_class` | gRPC server RPCs completed, including recovered panics (counted as Internal). |
| `platform_grpc_server_handling_seconds` | platform-gincommon | histogram | proposed | `grpc_method`, `status_class`, `error_class` | gRPC server RPC latency in seconds. |
| `platform_grpc_server_inflight_requests` | platform-gincommon | gauge | proposed | `grpc_method` | gRPC server RPCs currently being handled. |
| `platform_grpc_server_request_size_bytes` | platform-gincommon | histogram | proposed | `grpc_method`, `status_class`, `error_class` | gRPC request message size in bytes (sum over messages for streams). |
| `platform_grpc_server_response_size_bytes` | platform-gincommon | histogram | proposed | `grpc_method`, `status_class`, `error_class` | gRPC response message size in bytes (sum over messages for streams). |
| `platform_http_active_requests` | platform-gincommon | gauge | proposed | `route` | HTTP requests currently being handled. |
| `platform_http_panics_total` | platform-gincommon | counter | proposed | `method`, `route` | HTTP handler panics recovered by the middleware stack. |
| `platform_http_rate_limited_requests_total` | platform-gincommon | counter | proposed | `method`, `route` | HTTP requests answered with 429 Too Many Requests. |
| `platform_http_request_duration_seconds` | platform-gincommon | histogram | proposed | `method`, `route`, `status_class`, `error_class` | HTTP server request latency in seconds, measured by MetricsMiddleware. |
| `platform_http_request_size_bytes` | platform-gincommon | histogram | proposed | `method`, `route`, `status_class`, `error_class` | HTTP request body size in bytes from Content-Length (not observed when the length is unknown, e.g. chunked uploads). |
| `platform_http_request_timeouts_total` | platform-gincommon | counter | proposed | `method`, `route` | HTTP requests whose TimeoutMiddleware deadline expired before the handler responded. |
| `platform_http_requests_total` | platform-gincommon | counter | proposed | `method`, `route`, `status_class`, `error_class` | HTTP requests completed by the server, including recovered panics (counted as 5xx). |
| `platform_http_response_size_bytes` | platform-gincommon | histogram | proposed | `method`, `route`, `status_class`, `error_class` | HTTP response body size in bytes. |
| `platform_library_info` | platform-events | gauge | proposed | `library`, `library_version` | Always 1. Identifies a platform library and the version a service was built with, for fleet-wide upgrade tracking. |
| `platform_message_processing_duration_seconds` | platform-events | histogram | proposed | `queue`, `event_type` | Wall time a consumer's handler (or dead-letter handler) spent on one delivery, whatever the outcome. |
| `platform_message_timeouts_total` | platform-events | counter | proposed | `queue`, `event_type`, `operation` | A received message whose WithHandlerTimeout deadline expired, by the stage it expired in: decode (codec decode), dead_letter_handler, or handler. Each is also counted in platform_messages_failed_total under its usual reason (decode_error, dead_letter_error, handler_error) — this counter separates timeouts from other failures without changing that Canonical metric's vocabulary. |
| `platform_messages_failed_total` | platform-events | counter | approved | `queue`, `event_type`, `reason` | A received message that could not be processed on this delivery, by reason: malformed (not a valid envelope), decode_error (schema-registry codec failure), handler_error, handler_panic, or dead_letter_error (dead-letter handling or DLQ forwarding failed). A failed message is retried or dead-lettered; see platform_retry_total and platform_dlq_messages_total. |
| `platform_messages_in_flight` | platform-events | gauge | proposed | `queue` | Messages a consumer has received and is currently processing (decode, dead-letter routing or handler), per replica. At the consumer's concurrency limit for long periods means the replica is saturated; a value that never drops points at a hung handler (see WithHandlerTimeout). |
| `platform_messages_processed_total` | platform-events | counter | approved | `queue`, `event_type` | A received message whose handler completed successfully, after which the message was acknowledged (deleted). Messages dead-lettered instead are counted in platform_dlq_messages_total, not here. |
| `platform_messages_published_total` | platform-events | counter | proposed | `topic`, `event_type`, `outcome` | One event a producer attempted to publish to a topic, by outcome (error includes validation, encoding and broker failures; a batch counts each message). |
| `platform_messages_received_total` | platform-events | counter | approved | `queue` | A message delivered to a consumer by its queue (one per SQS delivery, redeliveries included), counted on receipt before it is parsed. |
| `platform_outbox_dead_letter_operations_total` | platform-events | counter | proposed | `operation` | Outbox dead-letter records acted on by an operator call: reprocess (moved back to outbox_events for retry) or discard (permanently deleted). Counts records, not calls. |
| `platform_outbox_errors_total` | platform-events | counter | proposed | `operation` | An outbox runner step that failed outside a publish attempt: poll (claiming a batch), unmarshal (a stored envelope that no longer parses), mark_published (an event published but not marked — it will be delivered again), pending_count / leased_count / oldest_pending / blocked_count (a gauge query). |
| `platform_outbox_leased_events` | platform-events | gauge | proposed | — | Unpublished outbox events not yet due: claimed by a runner and being published, or waiting out a retry backoff. Sampled every GaugeInterval, capped at 100000. |
| `platform_outbox_oldest_pending_age` | platform-events | gauge | proposed | — | Age of the oldest unpublished outbox event (now − created_at), 0 when nothing is unpublished, sampled every GaugeInterval. Transient publish failures never dead-letter, so this is the signal that delivery has stopped even when the backlog is small (e.g. a credential outage on a low-volume service). |
| `platform_outbox_ordering_blocked_events` | platform-events | gauge | proposed | — | Ordered outbox events (outbox.EnqueueOrdered) waiting behind an earlier unpublished record with the same ordering key. Sampled every GaugeInterval, capped at 100000. A value that keeps growing means a key's head record keeps failing and holds the rest of its key. |
| `platform_outbox_pending_events` | platform-events | gauge | proposed | — | Events in a service's transactional outbox that are due to be published (unpublished, not leased and not waiting out a retry backoff), sampled every outbox GaugeInterval (default 15s) and capped at 100000 (a reading of 100000 means at least that many). Left at its last value when the count query fails (see platform_outbox_errors_total{operation="pending_count"}). |
| `platform_outbox_publish_attempts_total` | platform-events | counter | proposed | `event_type`, `outcome` | One attempt by the outbox runner to publish a claimed outbox event, by outcome. |
| `platform_queue_depth` | platform-events | gauge | proposed | `queue` | Messages waiting on a consumer's queue to be received (SQS ApproximateNumberOfMessages — visible, not in flight or delayed), sampled by the consumer every WithQueueDepthMetrics interval. Approximate by SQS design. |
| `platform_retry_total` | platform-events | counter | approved | `operation`, `event_type` | An attempt that failed and was left for automatic retry: a consumed message whose processing failed and stays on its queue for redelivery (operation=consume), or an outbox publish that failed with attempts remaining (operation=outbox_publish). |
| `platform_telemetry_label_overflow_total` | platform-events | counter | proposed | `label` | A label value the library replaced because it exceeded its cardinality bound: event_type over 128 bytes → `__oversized__`, or a new distinct event_type beyond the per-process limit (default 200) → `__other__`. Counts replacements. Non-zero means a misconfigured or adversarial producer, or a limit set below the service's real number of event types. |
| `platform_unclassified_errors_total` | platform-gincommon | counter | approved | `transport` | Errors that reached the top-level error handler unclassified and were answered as a generic internal error (HTTP 500 internal-error, gRPC Internal): a programming defect. |

## Tier 2: domain-shared metrics

| Metric | Domain | Owner | Type | Status | Labels | Meaning |
|---|---|---|---|---|---|---|
| `iam_auth_events_total` | `iam` |  | counter | proposed | `event_type`, `outcome` | Authentication events (login, logout, token refresh, MFA challenge) observed by an IAM service. |
| `iam_auth_session_revoke_failed_total` | `iam` |  | counter | proposed | `reason` | Calls to the realm provisioner's RevokeUserSessions that errored or returned non-2xx. The caller fails open (AUTH-8), so every increment is a user session that may outlive its membership. |
| `iam_identity_sync_total` | `iam` |  | counter | proposed | `source`, `outcome` | Identity records synchronised from an external identity source. |
| `iam_lifecycle_event_lag_seconds` | `iam` |  | histogram | proposed | `event_type` | Seconds from a tenant lifecycle event's envelope time to the moment the consumer applied it, by event_type. Sustained high p99 flags a consumer backlog (SLO-3). |
| `iam_lifecycle_event_skipped_total` | `iam` |  | counter | proposed | `event_type` | Tenant lifecycle events skipped by the recency guard (EVT-14: event time <= the tenant's last applied event time), by event_type. |
| `iam_realm_operations_total` | `iam` |  | counter | proposed | `operation`, `outcome` | Administrative realm operations (create, update, delete, configure). |
| `iam_rls_violations_total` | `iam` |  | counter | proposed | `violation_type` | Row-level-security violations recorded in the service's rls_violation_log, by violation_type. Fed from a periodic scrape of the log table, not from the request path. |
| `iam_tenant_resolution_total` | `iam` |  | counter | proposed | `strategy`, `outcome` | Attempts to resolve the tenant of a request or event. |

## Labels

| Label | Values or pattern | Max values | Cardinality | Meaning |
|---|---|---|---|---|
| `dependency` | `^[a-z0-9][a-z0-9._-]{0,63}$` | 50 | bounded by configured dependencies | Downstream dependency (database, broker, HTTP API) by logical name. |
| `domain` | `iam`, `workflow`, `billing`, `tender_management`, `notifications`, `documents`, `bff`, `portal` | — | fixed | Business domain that owns the emitting service. Injected centrally from Config.Domain / OBSERVABILITY_DOMAIN. |
| `environment` | `local`, `dev`, `test`, `staging`, `prod` | — | fixed | Deployment environment. Injected centrally from Config.Environment, else APP_ENV, else ENVIRONMENT (trimmed, lowercased; no aliases, so production is rejected: use prod). Same precedence in every platform library. |
| `error_class` | `success`, `client_error`, `server_error` | — | fixed | Outcome class matching status_class. |
| `event_type` | `^.{1,128}$` | 203 | bounded by the event catalogue and the per-process event_type limit | Event envelope type (<domain>.<entity>.<past-tense-verb>[.v<N>]). Bounded by the emitter: unknown when empty, __oversized__ over 128 bytes, __other__ once the process limit of distinct values (platform-events default 200) is reached. |
| `grpc_code` | `OK`, `Canceled`, `Unknown`, `InvalidArgument`, `DeadlineExceeded`, `NotFound`, `AlreadyExists`, `PermissionDenied`, `ResourceExhausted`, `FailedPrecondition`, `Aborted`, `OutOfRange`, `Unimplemented`, `Internal`, `Unavailable`, `DataLoss`, `Unauthenticated` | — | fixed | gRPC status code name. |
| `grpc_method` | `^(unknown|/?[A-Za-z0-9_.]+/[A-Za-z0-9_]+)$` | 1000 | bounded by registered services | Full gRPC method name (/package.Service/Method), or unknown. |
| `label` | `event_type` | — | fixed | Name of a label whose values were replaced to bound cardinality. |
| `library` | `platform-gincommon`, `platform-events`, `platform-pgcommon`, `platform-fastapicommon`, `platform-eventcommon`, `platform-pgcommon-py` | — | fixed | Platform library reporting its build, by repository name. Go and Python ports are distinct values because they have separate version streams. |
| `library_version` | `^(devel|v?[0-9A-Za-z][0-9A-Za-z._+-]{0,63})$` | 5 | one value per deployment | Module version of the library the service was built with (e.g. v1.6.0), devel for an unreleased build. |
| `method` | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `CONNECT`, `TRACE`, `OTHER` | — | fixed | HTTP request method. Methods outside the standard set are reported as OTHER. |
| `operation` | `^[A-Za-z][A-Za-z0-9_.-]{0,63}$` | 100 | bounded enum | Logical operation from the fixed per-metric set declared in the registry entry (e.g. consume, outbox_publish, SQL verbs SELECT/INSERT). |
| `outcome` | `success`, `failure`, `error` | — | fixed | success: completed as intended; failure: rejected for a business reason; error: system or transport fault. Each metric declares the subset it uses. |
| `pool` | `^[a-z][a-z0-9_]{0,31}$` | 10 | a handful per service | Database pool name from Config.PoolName (e.g. default, primary, replica), static per deployment. |
| `queue` | `^(unknown|[A-Za-z0-9][A-Za-z0-9._-]{0,79})$` | 100 | bounded by configured queues | Queue name: the last path segment of the queue URL (e.g. orders, orders.fifo), never the full URL; unknown when empty. |
| `reason` | `^[a-z][a-z0-9_]{0,63}$` | 50 | bounded enum | Failure or routing reason from a fixed per-metric enum, snake_case. Never an error message. |
| `route` | `^(unknown|/[A-Za-z0-9_./:*~-]*)$` | 1000 | bounded by registered routes | Gin route template (e.g. /api/items/:id), or unknown for unmatched requests. Never the raw URL path. |
| `service` | `^[a-z][a-z0-9_-]{0,62}$` | — | one value per deployment | Emitting service (e.g. event-consumer). Injected centrally from Config.ServiceName / the library Identity. Same rule as platform-events and platform-pgcommon identities. |
| `source` | `^[a-z][a-z0-9_]{0,63}$` | 50 | bounded enum | Origin system of a change or event, snake_case. |
| `state` | `idle`, `acquired`, `constructing` | — | fixed | Connection pool connection state. |
| `status_class` | `2xx`, `4xx`, `5xx` | — | fixed | Response class. HTTP 1xx-3xx and gRPC OK are 2xx; client-side gRPC codes are 4xx; everything else is 5xx. |
| `strategy` | `^[a-z][a-z0-9_]{0,63}$` | 20 | bounded enum | Resolution or authentication strategy from a fixed set, snake_case. |
| `topic` | `^(unknown|[A-Za-z0-9][A-Za-z0-9._-]{0,255})$` | 100 | bounded by configured topics | Topic name: the last segment of the topic ARN (e.g. iam-events, orders.fifo), never the full ARN; unknown when empty. |
| `transport` | `http`, `grpc` | — | fixed | Inbound transport of the request: http or grpc. |
| `version` | `^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$` | — | one value per deployment | Build version of the emitting binary (Config.BuildVersion / BUILD_VERSION; unknown when unset). Only on build-info metrics: a per-build label on every series would multiply series on each deploy. |
| `violation_type` | `cross_tenant_access`, `missing_or_invalid_guc`, `missing_primary_email`, `other` | — | fixed | Row-level-security violation class recorded in rls_violation_log by rls_check_tenant() and the service's own checks, snake_case; other for anything outside the set. |

## Rules

- Prohibited labels: `user_id`, `email`, `tenant_id`, `request_id`, `event_id`, `session_id`, `trace_id`, `span_id`, `correlation_id`, `user`, `username`, `ip`, `client_ip`, `url`, `path`, `query`, `message_id`, `subject`, `actor`.
- Prohibited label suffixes: `_id`, `_email`, `_ip`, `_uuid`, `_token`.
- Exempt prefixes (runtime collectors, not validated): `go_`, `process_`, `promhttp_`, `python_`.

## Bucket presets

| Preset | Buckets |
|---|---|
| `db_pool_acquire` | 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 10 |
| `db_query` | 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 |
| `dependency_request` | 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30 |
| `event_propagation` | 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900, 3600 |
| `lifecycle_event_lag` | 0.05, 0.1, 0.5, 1, 5, 15, 60, 300, 1800 |
| `message_processing` | 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120 |
| `payload_size` | 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 262144, 1048576, 4194304, 16777216 |
| `request_duration` | 0.001, 0.002, 0.005, 0.01, 0.015, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10 |

## Legacy names

57 removed pre-standard names may not be reused by a new metric: `build_info`, `http_requests_total`, `http_request_duration_seconds`, `http_request_size_bytes`, `http_response_size_bytes`, `http_active_requests`, `http_panic_total`, `rate_limited_requests_total`, `http_request_timeout_total`, `grpc_server_handled_total`, `grpc_server_handling_seconds`, `grpc_server_request_size_bytes`, `grpc_server_response_size_bytes`, `grpc_server_inflight_requests`, `grpc_rate_limited_requests_total`, `grpc_panic_total`, `platform_events_build_info`, `events_published_total`, `events_publish_duration_seconds`, `events_consumed_total`, `events_consume_duration_seconds`, `events_codec_encode_total`, `events_codec_encode_duration_seconds`, `events_codec_decode_total`, `events_codec_decode_duration_seconds`, `outbox_pending_total`, `outbox_leased_total`, `outbox_published_total`, `outbox_attempts_total`, `outbox_dead_letters_total`, `outbox_dead_letters_reprocessed_total`, `outbox_dead_letters_discarded_total`, `sqs_receive_errors_total`, `sqs_delete_errors_total`, `sqs_visibility_extension_errors_total`, `outbox_poll_errors_total`, `outbox_unmarshal_errors_total`, `outbox_mark_published_errors_total`, `events_inbox_duplicates_total`, `events_dlq_forwarded_total`, `events_oversized_event_type_label_total`, `pgcommon_query_total`, `pgcommon_query_duration_seconds`, `pgcommon_pool_acquire_total`, `pgcommon_pool_acquire_duration_seconds`, `pgcommon_slow_query_total`, `pgcommon_retry_total`, `pgcommon_retry_exhausted_total`, `pgcommon_pool_total_conns`, `pgcommon_pool_idle_conns`, `pgcommon_pool_acquired_conns`, `pgcommon_pool_constructing_conns`, `pgcommon_pool_max_conns`, `pgcommon_pool_empty_acquire_total`, `pgcommon_build_info`, `grpc_requests_total`, `grpc_request_duration_seconds`.
