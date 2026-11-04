// Retry-After (RFC 9110 §10.2.3): /http's retries and /auth's token refresh honour it.

/** Retry-After in ms (seconds or an HTTP-date), between 0 and `capMs`; undefined when absent or unparsable. */
export function retryAfterMs(res: Response, capMs: number): number | undefined {
  const v = res.headers.get('retry-after');
  if (!v) return undefined;
  const seconds = Number(v);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(v) - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 0), capMs);
}
