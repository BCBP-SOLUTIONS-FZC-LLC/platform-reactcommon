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

// A token of free text (up to whitespace, a quote, a bracket, '<' or '>'), and one that is a URL or a path
// (a '/' before its first '?' or '#') with a query string or fragment after it: an OIDC callback's code and
// state, a pre-signed URL's signature (`bucket.s3.amazonaws.com/k?X-Amz-Signature=…`, `api/x?token=…`).
// Both are linear: a long run of '/' or a large data URL costs one pass, never one per character.
const TOKEN = /[^\s"'<>()[\]]+/g;
const WITH_QUERY = /^([^?#/]*\/[^?#]*)[?#]./;

/** Removes the query string and fragment of every URL and path in `s` (logged text and span attributes). */
export function stripUrlQueries(s: string): string {
  return s.replace(TOKEN, (token) => {
    const m = WITH_QUERY.exec(token);
    return m ? m[1]! : token;
  });
}
