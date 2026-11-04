// The shell's build-time environment (__ENVIRONMENT__): a production build with PLATFORM_ENVIRONMENT
// unset fails (review 2, item 1: it silently became 'dev'); development keeps the 'dev' default.
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module
import { buildEnvironment } from '../environment.mjs';

const env = buildEnvironment as (mode: string, env?: string) => string;

describe('the shell build environment', () => {
  it('fails a production build without PLATFORM_ENVIRONMENT', () => {
    expect(() => env('production', undefined)).toThrow(/PLATFORM_ENVIRONMENT is not set/);
    expect(() => env('production', '')).toThrow(/PLATFORM_ENVIRONMENT is not set/);
  });

  it('defaults a development build to dev', () => {
    expect(env('development', undefined)).toBe('dev');
  });

  it('takes a named environment in either mode', () => {
    expect(env('production', 'prod')).toBe('prod');
    expect(env('production', 'staging')).toBe('staging');
    expect(env('development', 'local')).toBe('local');
  });

  it('refuses an environment the platform does not have', () => {
    expect(() => env('production', 'production')).toThrow(/is not one of/);
  });
});
