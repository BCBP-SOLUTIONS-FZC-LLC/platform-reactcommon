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
    return `TraceIDRatioBased{${goFormatG(this.fraction)}}`;
  }
}

/**
 * Go's %g (strconv.FormatFloat(f, 'g', -1, 64)): the shortest digits that round-trip, in exponent
 * form when the exponent is < -4 or >= 6 (mantissa as short as possible, exponent signed and at
 * least two digits: 1e-05), otherwise fixed. JS's own String() switches only below 1e-6 or at 1e21.
 */
export function goFormatG(f: number): string {
  if (Number.isNaN(f)) return 'NaN';
  if (!Number.isFinite(f)) return f > 0 ? '+Inf' : '-Inf';
  if (f === 0) return Object.is(f, -0) ? '-0' : '0';
  const sign = f < 0 ? '-' : '';
  const [mantissa, e] = Math.abs(f).toExponential().split('e') as [string, string]; // shortest round-trip digits
  const exp = Number(e);
  if (exp < -4 || exp >= 6) return `${sign}${mantissa}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  const digits = mantissa.replace('.', '');
  const point = exp + 1; // digits before the decimal point
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
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
