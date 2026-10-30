/**
 * `@platform/frontend-sdk` has no root entry point. Import a subpath instead, for example
 * `@platform/frontend-sdk/core` or `@platform/frontend-sdk/http`: subpath-only exports keep each
 * module tree-shakeable and enforce the dependency rules between them (design doc §C1).
 *
 * @packageDocumentation
 */
throw new Error(
  "@platform/frontend-sdk has no root export: import a subpath such as '@platform/frontend-sdk/core'.",
);

export {};
