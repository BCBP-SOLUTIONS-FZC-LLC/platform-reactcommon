// The shell's build-time environment, read by webpack.config.mjs (no bundler imports: unit-tested).
const ENVIRONMENTS = ['local', 'dev', 'test', 'staging', 'prod'];

/**
 * The page's environment (`__ENVIRONMENT__`, then initializeCore). A production build must name it:
 * with PLATFORM_ENVIRONMENT unset it fails rather than ship a 'dev' shell. Development defaults to 'dev'.
 */
export function buildEnvironment(mode, env = process.env.PLATFORM_ENVIRONMENT) {
  if (env === undefined || env === '') {
    if (mode === 'production') {
      throw new Error(`examples/shell: PLATFORM_ENVIRONMENT is not set; a production build needs one of ${ENVIRONMENTS.join(', ')}`);
    }
    return 'dev';
  }
  if (!ENVIRONMENTS.includes(env)) throw new Error(`examples/shell: PLATFORM_ENVIRONMENT=${env} is not one of ${ENVIRONMENTS.join(', ')}`);
  return env;
}
