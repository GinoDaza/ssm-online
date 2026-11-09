import { defineConfig } from 'vitest/config';

export default defineConfig({
  // the emulator comparisons take seconds each; with every file in parallel 5 s is too tight
  test: { include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'], testTimeout: 30_000 },
});
