import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Real Remotion/FFmpeg tests share CPU and disk with transaction tests.
    // Serialize files so a timed-out writer cannot race its filesystem teardown.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
