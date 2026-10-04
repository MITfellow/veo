import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // §9: the suite is offline, deterministic and model-free. A single
    // fork keeps SQLite temp files predictable and the ordering stable.
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
