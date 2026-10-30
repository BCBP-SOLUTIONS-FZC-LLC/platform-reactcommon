/**
 * The runtime config: one /config/runtime.json per environment, loaded and validated by the
 * shell, then read by every module. Design contract: docs/design/frontend-sdk-design.md §C1 `/config`.
 *
 * @packageDocumentation
 */
export { RuntimeConfigSchema, type RuntimeConfig } from './schema.ts';
export { RuntimeConfigError, getConfig, loadRuntimeConfig, setRuntimeConfig, tryGetConfig } from './runtime-config.ts';
