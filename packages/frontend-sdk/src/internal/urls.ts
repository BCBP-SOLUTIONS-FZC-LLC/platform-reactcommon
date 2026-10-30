// URL checks shared by the telemetry modules.

/** An exact origin: scheme://host[:port] and nothing else. */
export function isExactOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/** A same-origin absolute path: no scheme, no '//', no '\', no whitespace, query or fragment. */
export function isSameOriginPath(value: string): boolean {
  return typeof value === 'string' && /^\/(?!\/)[^\s?#\\]*$/.test(value);
}

/**
 * The absolute collector URL for an OTLP signal (`traces`, `logs`, `metrics`) under a
 * same-origin base path such as '/otel'. Throws a TypeError for any other base.
 */
export function collectorUrl(otlpBaseUrl: string, signal: 'traces' | 'logs' | 'metrics'): string {
  if (!isSameOriginPath(otlpBaseUrl)) {
    throw new TypeError(`otlpBaseUrl must be a same-origin path such as '/otel', got ${JSON.stringify(otlpBaseUrl)}`);
  }
  const base = globalThis.location?.href ?? 'http://localhost/';
  return new URL(`${otlpBaseUrl.replace(/\/$/, '')}/v1/${signal}`, base).href;
}
