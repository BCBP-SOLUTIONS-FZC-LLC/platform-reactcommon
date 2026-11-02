Deliberate dependency-rule violations. `test/dependency-rules.test.ts` runs ESLint and
dependency-cruiser against this tree (as if it were the SDK's `src/`) and asserts each one is
reported. Never import from here.
