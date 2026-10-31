// Instrumentation the harness installs before the SDK runs (entry.ts imports this first):
// - what the page sends to /otel is tagged with the test's run id and how it was sent
//   (`via=beacon|keepalive|fetch`), so the server can tell the transports apart and runs apart;
// - the page's lifecycle events are recorded and each one is persisted at once with a beacon
//   (/__events), so the order survives the page being closed.
// The wrappers only rewrite the URL: the browser still sends a real beacon or keepalive fetch.

export const RUN = new URLSearchParams(location.search).get('run') ?? '';
export const PAGE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Requests started (fetch called, or beacon queued) per collector path, e.g. 'traces': read synchronously by tests. */
export const otelCalls: Record<string, number> = {};

/** `url` with run and via added when it targets the page's own /otel collector. */
function tag(url: string, via: string): string {
  const u = new URL(url, location.href);
  if (u.origin !== location.origin || !u.pathname.startsWith('/otel/')) return url;
  const signal = u.pathname.split('/').at(-1)!;
  otelCalls[signal] = (otelCalls[signal] ?? 0) + 1;
  u.searchParams.set('run', RUN);
  u.searchParams.set('via', via);
  return u.href;
}

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === 'string' || input instanceof URL) input = tag(String(input), init?.keepalive ? 'keepalive' : 'fetch');
  return nativeFetch(input, init);
};

const nativeBeacon = navigator.sendBeacon.bind(navigator);
navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => nativeBeacon(tag(String(url), 'beacon'), data);

export interface RecordedEvent {
  type: string;
  visibilityState: string;
  persisted?: boolean;
  t: number;
}

export const events: RecordedEvent[] = [];

function record(e: Event): void {
  const ev: RecordedEvent = { type: e.type, visibilityState: document.visibilityState, t: Math.round(performance.now()) };
  if ('persisted' in e) ev.persisted = (e as PageTransitionEvent).persisted;
  events.push(ev);
  try {
    nativeBeacon(`/__events?run=${encodeURIComponent(RUN)}`, JSON.stringify({ pageId: PAGE_ID, url: location.href, events }));
  } catch {
    // recorded in the page anyway
  }
}

// Capture listeners on window, registered before the SDK's: they see every event first, even one a
// test then stops from reaching the SDK (visibilitychange bubbles from document to window).
for (const type of ['visibilitychange', 'pagehide', 'pageshow', 'beforeunload', 'freeze', 'resume']) {
  addEventListener(type, record, { capture: true });
}
