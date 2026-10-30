// platform_web_errors_total through the internal instrument port (design doc §C1 /metrics).
import { isChunkLoadError } from '../mfe/index.ts';
import { getRuntime } from '../internal/runtime.ts';

export function recordWebError(source: 'unhandled_error' | 'unhandled_rejection' | 'boundary', mfe: string, e: unknown): void {
  try {
    getRuntime().instruments.webError({ source: isChunkLoadError(e) ? 'chunk_load' : source, mfe });
  } catch {
    // metrics never break error handling
  }
}
