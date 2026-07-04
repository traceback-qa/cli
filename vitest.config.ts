import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.types.ts', 'src/cli.ts', 'src/index.ts'],
      thresholds: {
        lines: 80,
        branches: 75,
      },
      reporter: ['text', 'lcov'],
    },
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10000,
  },
});
