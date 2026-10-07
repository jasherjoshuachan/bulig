import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'plugins/*/test/**/*.test.ts'],
    // A run where zero tests executed is a failure, not a pass.
    passWithNoTests: false,
    // Several suites run real git processes. Under load a slow machine needs more than the 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
