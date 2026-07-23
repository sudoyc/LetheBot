import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface SeedEvidence {
  phase: 'seed';
  proposedBeforeApproval: boolean;
  activeAfterApproval: boolean;
  memoryCount: number;
  sourceCount: number;
  revisionCount: number;
  auditCount: number;
  integrityOk: boolean;
  foreignKeyViolationCount: number;
}

interface RecallEvidence {
  phase: 'recall';
  sameGroup: {
    selectedCount: number;
    selectedTarget: boolean;
  };
  otherGroup: {
    selectedCount: number;
    rejectedTargetForScope: boolean;
  };
  privateConversation: {
    selectedCount: number;
    rejectedTargetForScope: boolean;
  };
  storedTraceCount: number;
  roundTrippedTraceCount: number;
  mismatchedTurnTriggerCount: number;
  invalidTurnChronologyCount: number;
  memoryCount: number;
  sourceCount: number;
  revisionCount: number;
  auditCount: number;
  integrityOk: boolean;
  foreignKeyViolationCount: number;
}

const FORBIDDEN_STDOUT_VALUES = [
  'actor-alpha',
  'account-alpha',
  'room-alpha',
  'thread-alpha',
  'raw-source-alpha',
  'chat-source-alpha',
  'memory-process-restart',
  'prefers deterministic restart checks',
] as const;

describe('OS process restart memory recall', () => {
  it('REL-MEM-02/REL-SCOPE-01 recalls only the approved source-group memory after a process restart', () => {
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-process-restart-memory-'));
    const dbPath = join(testDir, 'lethebot.db');

    try {
      const seed = runHelper<SeedEvidence>('seed', dbPath);
      expect(seed).toEqual({
        phase: 'seed',
        proposedBeforeApproval: true,
        activeAfterApproval: true,
        memoryCount: 1,
        sourceCount: 1,
        revisionCount: 2,
        auditCount: 2,
        integrityOk: true,
        foreignKeyViolationCount: 0,
      });

      const recall = runHelper<RecallEvidence>('recall', dbPath);
      expect(recall).toEqual({
        phase: 'recall',
        sameGroup: {
          selectedCount: 1,
          selectedTarget: true,
        },
        otherGroup: {
          selectedCount: 0,
          rejectedTargetForScope: true,
        },
        privateConversation: {
          selectedCount: 0,
          rejectedTargetForScope: true,
        },
        storedTraceCount: 3,
        roundTrippedTraceCount: 3,
        mismatchedTurnTriggerCount: 0,
        invalidTurnChronologyCount: 0,
        memoryCount: 1,
        sourceCount: 1,
        revisionCount: 2,
        auditCount: 2,
        integrityOk: true,
        foreignKeyViolationCount: 0,
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

function runHelper<T>(phase: 'seed' | 'recall', dbPath: string): T {
  const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
  const helper = join(process.cwd(), 'tests/fixtures/process-restart-memory-recall.ts');
  const result = spawnSync(tsxBin, [helper, phase, dbPath], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'test',
      LETHEBOT_TEST: 'true',
      LOG_LEVEL: 'fatal',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');

  const stdout = result.stdout.trim();
  expect(stdout.split('\n')).toHaveLength(1);
  for (const value of FORBIDDEN_STDOUT_VALUES) {
    expect(stdout).not.toContain(value);
  }

  return JSON.parse(stdout) as T;
}
