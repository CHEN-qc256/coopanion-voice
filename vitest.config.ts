import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The service tests start real processes and bind ports; one file at a time keeps them from
    // fighting over one. It also keeps the run small enough for a laptop.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
