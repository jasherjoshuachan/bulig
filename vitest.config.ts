import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'plugins/*/test/**/*.test.ts'],
    // Prints a note when there is no Postgres, so a skipped suite is never silent. See packages/core/test/pg-support.ts.
    globalSetup: ['packages/core/test/pg-notice.ts'],
    // A run where zero tests executed is a failure, not a pass.
    passWithNoTests: false,
    // Several suites run real git processes. Under load a slow machine needs more than the 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
