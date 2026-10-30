// The internal instrument port (design doc §C1 /metrics, "Decoupling from approval"). /http and
// /mfe record through it and never import metric names. The default is a no-op; /metrics installs
// the real implementation on the PlatformRuntime once the Tier 1 names are approved.
export interface PlatformInstruments {
  httpClient(
    seconds: number,
    l: {
      method: string;
      route: string;
      status_class: '2xx' | '4xx' | '5xx';
      error_class: 'success' | 'client_error' | 'server_error';
      mfe: string;
      /** Set when the call ended with no HTTP status; also counts a failure. */
      reason?: 'timeout' | 'network' | 'aborted';
    },
  ): void;
  remoteLoad(
    seconds: number,
    l: {
      mfe: string;
      outcome: 'success' | 'failure' | 'error';
      reason?: 'disabled' | 'timeout' | 'network' | 'aborted' | 'incompatible';
    },
  ): void;
  webError(l: { source: 'unhandled_error' | 'unhandled_rejection' | 'boundary' | 'chunk_load'; mfe: string }): void;
}

export const NOOP_INSTRUMENTS: PlatformInstruments = Object.freeze({
  httpClient: () => {},
  remoteLoad: () => {},
  webError: () => {},
});
