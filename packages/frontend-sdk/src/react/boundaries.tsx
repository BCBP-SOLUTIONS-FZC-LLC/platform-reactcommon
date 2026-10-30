// Error boundaries for remotes (design doc §C1 /react): a render failure in one remote is logged with
// its mfe scope and shows a fallback with the trace and request ids; it never takes the shell down.
// A chunk-load failure after a deploy reloads the page once instead.
import { Component, Suspense, lazy, useMemo, useReducer, type ComponentType, type ErrorInfo, type JSX, type ReactNode } from 'react';
import { problemMessage, t } from '../i18n/index.ts';
import { getLogger } from '../logging/index.ts';
import { loadRemote, reloadOnceForChunkError, RemoteDisabledError } from '../mfe/index.ts';
import { NetworkError, TimeoutError, isProblemError } from '../problem/index.ts';
import { currentTraceId } from '../tracing/index.ts';
import { MfeContext } from './context.ts';
import { recordWebError } from './web-errors.ts';

export interface ErrorInfoView {
  traceId?: string;
  requestId?: string;
  message: string;
  retry(): void;
}

// Keys in the shell's 'platform' namespace; English when the shell has no catalog for them.
const KEYS = {
  unexpected: 'error.unexpected',
  unavailable: 'error.unavailable',
  offline: 'error.offline',
  reference: 'error.reference',
  retry: 'error.retry',
} as const;

function platformText(key: string, fallback: string): string {
  const v = t('platform', key);
  return v === key ? fallback : v;
}

function viewOf(e: unknown, retry: () => void): ErrorInfoView {
  if (isProblemError(e)) {
    return { message: problemMessage(e), ...(e.traceId ? { traceId: e.traceId } : {}), ...(e.requestId ? { requestId: e.requestId } : {}), retry };
  }
  const traceId = currentTraceId();
  const requestId = e instanceof TimeoutError || e instanceof NetworkError ? e.requestId : undefined;
  const message =
    e instanceof RemoteDisabledError
      ? platformText(KEYS.unavailable, 'This part of the app is unavailable right now.')
      : e instanceof NetworkError && e.offline
        ? platformText(KEYS.offline, 'You are offline.')
        : platformText(KEYS.unexpected, 'Something went wrong.');
  return { message, ...(traceId ? { traceId } : {}), ...(requestId ? { requestId } : {}), retry };
}

function DefaultFallback({ view }: { view: ErrorInfoView }): JSX.Element {
  return (
    <div role="alert">
      <p>{view.message}</p>
      {view.traceId || view.requestId ? (
        <p>
          <small>
            {platformText(KEYS.reference, 'Reference')}: <code>{view.traceId ?? view.requestId}</code>
          </small>
        </p>
      ) : null}
      <button type="button" onClick={view.retry}>
        {platformText(KEYS.retry, 'Try again')}
      </button>
    </div>
  );
}

interface BoundaryProps {
  mfe: string;
  children: ReactNode;
  fallback?: ((e: ErrorInfoView) => ReactNode) | undefined;
  onRetry?: (() => void) | undefined;
}

class Boundary extends Component<BoundaryProps, { error: { e: unknown } | undefined }> {
  override state: { error: { e: unknown } | undefined } = { error: undefined };

  static getDerivedStateFromError(e: unknown): { error: { e: unknown } } {
    return { error: { e } };
  }

  override componentDidCatch(e: unknown, info: ErrorInfo): void {
    recordWebError('boundary', this.props.mfe, e);
    if (reloadOnceForChunkError(e)) return; // the old build's chunks are gone: load the new one
    const log = getLogger({ mfe: this.props.mfe });
    const attrs = { error: e, ...(info.componentStack ? { component_stack: info.componentStack.slice(0, 2_000) } : {}) };
    // An API error is the server's answer (already traced); a render bug is ours.
    if (isProblemError(e) || e instanceof TimeoutError || e instanceof NetworkError) log.warn('remote showed an error', attrs);
    else log.error('remote failed to render', attrs);
  }

  private retry = (): void => {
    this.props.onRetry?.();
    this.setState({ error: undefined });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return <MfeContext.Provider value={this.props.mfe}>{this.props.children}</MfeContext.Provider>;
    const view = viewOf(error.e, this.retry);
    return this.props.fallback ? this.props.fallback(view) : <DefaultFallback view={view} />;
  }
}

/** Isolates a remote: its render errors are logged with `mfe` and replaced by `fallback`. Sets the MFE scope. */
export function MFEErrorBoundary(p: { mfe: string; children: ReactNode; fallback?: (e: ErrorInfoView) => ReactNode }): JSX.Element {
  return (
    <Boundary mfe={p.mfe} fallback={p.fallback}>
      {p.children}
    </Boundary>
  );
}

/**
 * Loads `module` from remote `remote` lazily (loadRemote: kill switch, timeout, retries), suspends with
 * `fallback`, and isolates it in an MFEErrorBoundary. The module's default export (or the module itself)
 * is the component; `props` are passed to it. Retry loads again.
 */
export function RemoteBoundary(p: { remote: string; module: `./${string}`; fallback?: ReactNode; props?: Record<string, unknown> }): JSX.Element {
  const [attempt, retry] = useReducer((n: number) => n + 1, 0);
  const Remote = useMemo(
    () =>
      lazy(async () => {
        const m = await loadRemote<unknown>(p.remote, p.module);
        const c = (m as { default?: unknown } | null)?.default ?? m;
        if (typeof c !== 'function' && (typeof c !== 'object' || c === null)) {
          throw new TypeError(`remote "${p.remote}" module ${p.module} is not a component`);
        }
        return { default: c as ComponentType<Record<string, unknown>> };
      }),
    // a new lazy per attempt: React caches a rejected lazy forever
    [p.remote, p.module, attempt],
  );
  return (
    <Boundary mfe={p.remote} onRetry={retry}>
      <Suspense fallback={p.fallback ?? null}>
        <Remote {...(p.props ?? {})} />
      </Suspense>
    </Boundary>
  );
}
