import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.cache/vite',
  envDir: 'tests/fixtures/vitest-no-env',
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.ts'],
      thresholds: {
        branches: 84,
        functions: 93,
        lines: 82,
        statements: 82,
      },
    },
  },
});
