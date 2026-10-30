/**
 * ESLint rules for the platform's shell and remotes: SDK imports through public subpaths, no identity
 * headers, browser storage and HTML only through the SDK, no runtime CSS-in-JS, and route templates
 * for API paths. `configs.recommended` turns them all on, with core no-eval / no-implied-eval /
 * no-new-func (CSP script-src 'self').
 *
 * @packageDocumentation
 */
import { createRequire } from 'node:module';
import type { ESLint, Linter, Rule } from 'eslint';
import {
  apiRouteTemplate,
  noIdentityHeaders,
  noRawStorage,
  noRuntimeCssInJs,
  noSdkDeepImport,
  noSdkRootImport,
  noUnsafeHtml,
} from './rules.ts';

export const rules: Record<string, Rule.RuleModule> = {
  'no-sdk-root-import': noSdkRootImport,
  'no-sdk-deep-import': noSdkDeepImport,
  'no-identity-headers': noIdentityHeaders,
  'no-raw-storage': noRawStorage,
  'no-unsafe-html': noUnsafeHtml,
  'no-runtime-css-in-js': noRuntimeCssInJs,
  'api-route-template': apiRouteTemplate,
};

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const plugin: ESLint.Plugin & { configs: { recommended: Linter.Config } } = {
  meta: { name: '@platform/eslint-plugin', version },
  rules,
  configs: { recommended: {} },
};

/** Flat config: `export default [platform.configs.recommended, …]`. */
plugin.configs.recommended = {
  name: '@platform/recommended',
  plugins: { '@platform': plugin },
  rules: {
    ...Object.fromEntries(Object.keys(rules).map((name) => [`@platform/${name}`, 'error'])),
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
  },
};

export default plugin;
