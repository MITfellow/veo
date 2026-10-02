import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite must run offline and deterministically (§32). Nothing here
    // reaches the network; a test that needs to is a design error.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    pool: 'threads',
    reporters: process.env.CI ? ['default'] : ['dot'],
  },
});
