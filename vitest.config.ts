import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // the emulator comparisons run seconds of synchronous work each: separate processes, and
    // with every file in parallel 5 s per test is too tight
    pool: 'forks',
    // one emulator per core at most: oversubscribed, a busy worker misses vitest's own RPC
    // deadline ("Timeout calling onTaskUpdate") although every test passes
    maxWorkers: '50%',
    // and a file of them over 60 s needs a turn of the event loop between tests (the setup's)
    setupFiles: ['tools/vitest-setup.ts'],
    testTimeout: 30_000,
  },
});
