// What the specs read back from the server's collector: the spans and log records inside the OTLP
// JSON bodies the SDK sent. Shared by the specs and global-setup.ts (no Playwright imports here).
import type { CollectedRequest } from './server.ts';

/** Run ids of the detector controls, which provoke a CSP violation on purpose. */
export const EXPECTED_VIOLATION_PREFIX = 'expected-violation-';

interface KeyValue {
  key: string;
  value: { stringValue?: string; intValue?: number | string; boolValue?: boolean; doubleValue?: number };
}

interface OtlpTraces {
  resourceSpans?: { scopeSpans?: { spans?: { name: string; attributes?: KeyValue[] }[] }[] }[];
}

interface OtlpLogs {
  resourceLogs?: { scopeLogs?: { logRecords?: { body?: { stringValue?: string }; attributes?: KeyValue[] }[] }[] }[];
}

function seqOf(attributes: KeyValue[] | undefined): number | undefined {
  const v = attributes?.find((a) => a.key === 'seq')?.value;
  const n = Number(v?.intValue ?? v?.doubleValue ?? v?.stringValue);
  return Number.isFinite(n) ? n : undefined;
}

/** The `seq` attribute of every harness span in one /otel/v1/traces request. */
export function spanSeqs(r: CollectedRequest): number[] {
  const body = r.json as OtlpTraces | undefined;
  return (body?.resourceSpans ?? [])
    .flatMap((rs) => rs.scopeSpans ?? [])
    .flatMap((ss) => ss.spans ?? [])
    .filter((s) => s.name.startsWith('span-'))
    .map((s) => seqOf(s.attributes))
    .filter((n): n is number => n !== undefined);
}

/** The `seq` attribute of every harness log record (log-<seq>) in one /otel/v1/logs request. */
export function logSeqs(r: CollectedRequest): number[] {
  const body = r.json as OtlpLogs | undefined;
  return (body?.resourceLogs ?? [])
    .flatMap((rl) => rl.scopeLogs ?? [])
    .flatMap((sl) => sl.logRecords ?? [])
    .filter((l) => l.body?.stringValue?.startsWith('log-'))
    .map((l) => seqOf(l.attributes))
    .filter((n): n is number => n !== undefined);
}

/** Distinct values, sorted. */
export const distinct = (xs: number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);

interface OtlpMetrics {
  resourceMetrics?: { scopeMetrics?: { metrics?: { name: string; sum?: { dataPoints?: { asInt?: number | string; asDouble?: number }[] } }[] }[] }[];
}

/** The data-point values of counter `name` in one /otel/v1/metrics request. */
export function counterValues(r: CollectedRequest, name: string): number[] {
  const body = r.json as OtlpMetrics | undefined;
  return (body?.resourceMetrics ?? [])
    .flatMap((rm) => rm.scopeMetrics ?? [])
    .flatMap((sm) => sm.metrics ?? [])
    .filter((m) => m.name === name)
    .flatMap((m) => m.sum?.dataPoints ?? [])
    .map((p) => Number(p.asInt ?? p.asDouble));
}
