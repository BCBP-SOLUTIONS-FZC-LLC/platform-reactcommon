// The trace sampler, with gincommon's semantics (otel/setup.go Sampler): always ParentBased; the
// root is AlwaysSample for ratio >= 1, NeverSample for ratio <= 0, otherwise TraceIDRatioBased with
// Go's exact algorithm, so a root decided in the browser and one decided by a Go service agree for
// the same trace id (OTel JS's own ratio sampler uses a different hash).
import type { Context, Link, SpanKind } from '@opentelemetry/api';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
  SamplingDecision,
  type Sampler,
  type SamplingResult,
} from '@opentelemetry/sdk-trace';

const TWO_POW_63 = 2 ** 63;

/** Go's TraceIDRatioBased for 0 < fraction < 1: sample when traceID[8:16] >> 1 < uint64(fraction * 2^63). */
export class GoTraceIdRatioSampler implements Sampler {
  private readonly upperBound: bigint;

  constructor(private readonly fraction: number) {
    // uint64(fraction * (1 << 63)): the same IEEE double product, truncated.
    this.upperBound = BigInt(Math.trunc(fraction * TWO_POW_63));
  }

  shouldSample(_context: Context, traceId: string, _name?: string, _kind?: SpanKind, _attrs?: unknown, _links?: Link[]): SamplingResult {
    if (!/^[0-9a-f]{32}$/.test(traceId)) return { decision: SamplingDecision.NOT_RECORD };
    const x = BigInt(`0x${traceId.slice(16)}`) >> 1n;
    return { decision: x < this.upperBound ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD };
  }

  toString(): string {
    return `TraceIDRatioBased{${this.fraction}}`;
  }
}

/** The root sampler for `ratio`, exactly as Go chooses it. */
export function rootSampler(ratio: number): Sampler {
  if (ratio >= 1) return new AlwaysOnSampler();
  if (ratio <= 0) return new AlwaysOffSampler();
  return new GoTraceIdRatioSampler(ratio);
}

/** ParentBased(root): a sampled parent is followed, an unsampled one too; only roots use the ratio. */
export function platformSampler(ratio: number): Sampler {
  return new ParentBasedSampler({ root: rootSampler(ratio) });
}
