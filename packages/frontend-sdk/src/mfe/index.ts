/**
 * Micro-frontend loading over Webpack 5 Module Federation: the remote manifest, loadRemote with
 * the kill switch, timeouts and retries, chunk-error recovery and app-update detection.
 * Design contract: docs/design/frontend-sdk-design.md §C1 `/mfe`, §C3.
 *
 * @packageDocumentation
 */
export { loadManifest, type RemoteManifest, type RemoteManifestEntry } from './manifest.ts';
export { RemoteDisabledError, RemoteLoadError, loadRemote } from './remote.ts';
export { isChunkLoadError, reloadOnceForChunkError, startVersionPolling, subscribeAppUpdate } from './updates.ts';
