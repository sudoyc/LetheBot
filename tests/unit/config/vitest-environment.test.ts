import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoots: string[] = [];
const sentinelName = 'VITE_LETHEBOT_SYNTHETIC_ENV_FILE_SENTINEL';

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Vitest environment isolation', () => {
  it('does not load project-root .env files', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'lethebot-vitest-env-'));
    temporaryRoots.push(projectRoot);
    mkdirSync(join(projectRoot, 'tests'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.env.test'),
      `${sentinelName}=synthetic-only-sentinel\n`,
      'utf8',
    );
    writeFileSync(
      join(projectRoot, 'tests/env-file-probe.test.ts'),
      `test('keeps synthetic env files out of process.env', () => {\n` +
        `  expect(process.env.${sentinelName}).toBeUndefined();\n` +
        `});\n`,
      'utf8',
    );

    const repositoryRoot = process.cwd();
    const childEnv = { ...process.env };
    delete childEnv[sentinelName];
    const result = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--root',
        projectRoot,
        '--config',
        join(repositoryRoot, 'vitest.config.ts'),
        '--maxWorkers=1',
        '--minWorkers=1',
        '--silent',
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: childEnv,
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
