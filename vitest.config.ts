import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // the emulator comparisons run seconds of synchronous work each: separate processes, and
    // with every file in parallel 5 s per test is too tight
    pool: 'forks',
    testTimeout: 30_000,
  },
});
