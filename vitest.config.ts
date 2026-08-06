import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  cacheDir: '.cache/vite',
  envDir: 'tests/fixtures/vitest-no-env',
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        // Process-only command modules are measured by the subprocess coverage gate.
        'src/cli/main.ts',
        'src/scripts/ops-maintenance.ts',
      ],
      thresholds: {
        branches: 82,
        functions: 93,
        lines: 82,
        statements: 82,
      },
    },
    globals: true,
    environment: 'node',
    globalSetup: [resolve(projectRoot, 'tests/config/subprocess-coverage-setup.ts')],
    setupFiles: [resolve(projectRoot, 'tests/config/subprocess-coverage-env.ts')],
    maxWorkers: 4,
    testTimeout: 10_000,
    include: ['tests/**/*.test.ts'],
  },
});
