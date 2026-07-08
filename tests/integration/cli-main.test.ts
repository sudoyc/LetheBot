import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../src/storage/database';
import { MemoryRepository } from '../../src/storage/memory-repository';
import { JobRepository } from '../../src/storage/job-repository';
import { ToolCallRepository } from '../../src/storage/tool-call-repository';
import { ActionRepository } from '../../src/actions/action-repository';
import { BackgroundWorker } from '../../src/workers/background';

describe('CLI main command parser', () => {
  let testDir: string;
  let dbPath: string;
  let db: Database.Database;
  let memoryRepo: MemoryRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-cli-main-'));
    dbPath = join(testDir, 'cli.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, join(process.cwd(), 'migrations/001_initial_schema.sql'));
    memoryRepo = new MemoryRepository(db);

    const now = Date.now();
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-cli',
      now,
      now
    );
  });

  afterEach(() => {
    if (db?.open) {
      closeDatabase(db);
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  function reopenDb(): void {
    if (db?.open) {
      closeDatabase(db);
    }
    db = initDatabase({ path: dbPath });
    memoryRepo = new MemoryRepository(db);
  }

  function runCliWithEnv(
    args: string[],
    envOverrides: Record<string, string> = {}
  ): { stdout: string; stderr: string; status: number | null } {
    if (db?.open) {
      closeDatabase(db);
    }

    const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
    const result = spawnSync(tsxBin, ['src/cli/main.ts', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LETHEBOT_DB_PATH: dbPath,
        LETHEBOT_TEST: 'true',
        LOG_LEVEL: 'fatal',
        ...envOverrides,
      },
      encoding: 'utf8',
    });

    db = initDatabase({ path: dbPath });
    memoryRepo = new MemoryRepository(db);

    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      status: result.status,
    };
  }

  function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
    return runCliWithEnv(args);
  }

  function expectSuccessfulCli(args: string[]): string {
    const result = runCli(args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return result.stdout;
  }

  function expectFailedCli(args: string[], expectedError: string): void {
    const result = runCli(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(expectedError);
  }

  function insertMemoryReviewAudit(
    auditId: string,
    memoryIds: string[],
    options: {
      eventType?: 'memory.conflict.detected' | 'memory.consolidation.candidates_detected';
      summary?: string;
      extraDetails?: Record<string, unknown>;
      timestamp?: number;
    } = {}
  ): void {
    const now = options.timestamp ?? Date.now();
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      auditId,
      now,
      'memory',
      'redacted_full',
      options.eventType ?? 'memory.consolidation.candidates_detected',
      `job-${auditId}`,
      'system_worker',
      'background_worker',
      options.summary ?? 'Review worker detected duplicate memory candidates',
      JSON.stringify({
        groups: [
          {
            memoryIds,
            titleHash: 'spawned-review-title-hash',
            contentHash: 'spawned-review-content-hash',
          },
        ],
        redaction: 'memory_ids_title_hashes_content_hashes_and_counts_only',
        ...(options.extraDetails ?? {}),
      }),
      1,
      'medium'
    );
  }

  function insertMemoryDecayReviewAudit(auditId: string, memoryIds: string[]): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      auditId,
      now,
      'memory',
      'redacted_full',
      'memory.decay.candidates_detected',
      `job-${auditId}`,
      'system_worker',
      'background_worker',
      'Decay worker detected stale low-score candidates',
      JSON.stringify({
        candidates: memoryIds.map((memoryId) => ({
          memoryId,
          titleHash: `spawned-decay-title-hash-${memoryId}`,
          confidence: 0.4,
          importance: 0.2,
          reasons: ['stale', 'low_confidence', 'low_importance'],
        })),
        redaction: 'memory_ids_title_hashes_scores_and_reasons_only',
      }),
      1,
      'medium'
    );
  }

  it('spawns show-memory and export-memory against a migrated SQLite database', async () => {
    const memoryId = await memoryRepo.create({
      id: 'mem-cli-parser',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI parser preference',
      content: 'User prefers parser tests',
      state: 'active',
      confidence: 0.91,
      importance: 0.7,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'cli-seed-command',
          extractedBy: 'human',
        },
      ],
    });

    const shown = JSON.parse(expectSuccessfulCli(['show-memory', memoryId])) as {
      record: { id: string; content: string };
      sources: Array<{ sourceId: string }>;
      revisions: unknown[];
      audit: unknown[];
    };
    expect(shown.record).toMatchObject({ id: memoryId, content: 'User prefers parser tests' });
    expect(shown.sources).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: 'cli-seed-command' })]));
    expect(shown.revisions.length).toBeGreaterThan(0);
    expect(shown.audit.length).toBeGreaterThan(0);

    const exported = JSON.parse(expectSuccessfulCli(['export-memory', '--user', 'user-cli'])) as Array<{
      id: string;
      content: string;
    }>;
    expect(exported).toEqual(expect.arrayContaining([expect.objectContaining({ id: memoryId })]));
  });

  it('spawns memory list/show/export commands with deterministic secret redaction', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const memoryId = 'mem-cli-redacted-export';
    const now = Date.now();

    db.prepare(
      `INSERT INTO memory_records (
        id, scope, canonical_user_id, group_id, conversation_id, subject_user_id,
        visibility, sensitivity, authority, kind, title, content, state,
        confidence, importance, source_context, evaluator_decision_id,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      memoryId,
      'user',
      'user-cli',
      null,
      null,
      null,
      'private_only',
      'normal',
      'user_stated',
      'preference',
      `CLI token ${secret}`,
      `User pasted api_key=${secret} into a memory inspection fixture`,
      'active',
      0.91,
      0.7,
      'admin_cli',
      'policy-cli-redaction-fixture',
      now,
      now,
      null
    );
    db.prepare(
      `INSERT INTO memory_sources (
        memory_id, source_type, source_id, source_timestamp, extracted_by
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(memoryId, 'user_command', 'cli-redaction-seed', now, 'legacy-fixture');
    db.prepare(
      `INSERT INTO memory_revisions (
        id, memory_id, revision_number, change_type,
        previous_state, new_state, reason, actor, evaluator_decision_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'rev-cli-redacted-export',
      memoryId,
      1,
      'create',
      null,
      JSON.stringify({
        id: memoryId,
        title: `CLI token ${secret}`,
        content: `User pasted api_key=${secret} into a memory inspection fixture`,
        state: 'active',
      }),
      'Seeded legacy row for CLI redaction inspection',
      'legacy-fixture',
      'policy-cli-redaction-fixture',
      now
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-redacted-export',
      now,
      'memory',
      'summary',
      'memory.create',
      memoryId,
      'user-cli',
      'admin',
      'admin_cli',
      `Seeded legacy memory with token ${secret}`,
      JSON.stringify({ content: `api_key=${secret}` }),
      0,
      'medium'
    );

    const listOutput = expectSuccessfulCli(['list-memory', '--user', 'user-cli']);
    const shown = JSON.parse(expectSuccessfulCli(['show-memory', memoryId])) as {
      record: { id: string; title: string; content: string };
      revisions: Array<{ newState?: { title?: string; content?: string } }>;
      audit: Array<{ details?: unknown }>;
    };
    const exported = JSON.parse(expectSuccessfulCli(['export-memory', '--user', 'user-cli'])) as Array<{
      id: string;
      title: string;
      content: string;
    }>;

    const exportedRecord = exported.find((record) => record.id === memoryId);
    expect(exportedRecord).toBeDefined();

    const serializedOutputs = [
      listOutput,
      JSON.stringify(shown),
      JSON.stringify(exportedRecord),
    ].join('\n');
    expect(serializedOutputs).not.toContain(secret);
    expect(serializedOutputs).toContain('[REDACTED');
    expect(listOutput).toContain('Content: User pasted [REDACTED:api_key_assignment]');
    expect(shown.record).toMatchObject({
      id: memoryId,
      title: 'CLI token [REDACTED:openai_like_api_key]',
      content: 'User pasted [REDACTED:api_key_assignment] into a memory inspection fixture',
    });
    expect(shown.revisions.map((revision) => JSON.stringify(revision)).join('\n')).not.toContain(secret);
    expect(shown.audit.every((row) => row.details === undefined)).toBe(true);
    expect(exportedRecord).toMatchObject({
      title: 'CLI token [REDACTED:openai_like_api_key]',
      content: 'User pasted [REDACTED:api_key_assignment] into a memory inspection fixture',
    });

    reopenDb();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns memory show/export with redacted identifiers and source evidence', () => {
    const now = Date.now();
    const secret = 'sk-cli-memory-evidence-secret-should-not-leak';
    const platformUserId = 'qq-123456789';
    const platformGroupId = 'qq-group-987654321';
    const memoryId = `mem-cli-evidence-${platformUserId}-${secret}`;
    const sourceId = `raw-event-${platformUserId}-${secret}`;
    const evaluatorDecisionId = `eval-${platformUserId}-${secret}`;
    const revisionId = `rev-${platformUserId}-${secret}`;
    const revisionActor = `admin-${platformUserId}-${secret}`;

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      platformUserId,
      now,
      now
    );
    db.prepare(
      `INSERT INTO memory_records (
        id, scope, canonical_user_id, group_id, conversation_id, subject_user_id,
        visibility, sensitivity, authority, kind, title, content, state,
        confidence, importance, source_context, evaluator_decision_id,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      memoryId,
      'user',
      platformUserId,
      platformGroupId,
      `group:${platformGroupId}`,
      `subject-${platformUserId}`,
      'private_only',
      'normal',
      'user_stated',
      'preference',
      'Memory evidence redaction title',
      'Memory evidence redaction content',
      'active',
      0.91,
      0.7,
      `group_chat:${platformGroupId}:${secret}`,
      evaluatorDecisionId,
      now,
      now,
      null
    );
    db.prepare(
      `INSERT INTO memory_sources (
        memory_id, source_type, source_id, source_timestamp, extracted_by
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(memoryId, 'raw_event', sourceId, now, `worker-${platformUserId}-${secret}`);
    db.prepare(
      `INSERT INTO memory_revisions (
        id, memory_id, revision_number, change_type,
        previous_state, new_state, reason, actor, evaluator_decision_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      revisionId,
      memoryId,
      1,
      'create',
      null,
      JSON.stringify({
        id: memoryId,
        canonicalUserId: platformUserId,
        groupId: platformGroupId,
        sourceEventIds: [sourceId],
        evaluatorDecisionId,
        state: 'active',
      }),
      `Seeded revision reason ${secret} for ${platformUserId}`,
      revisionActor,
      evaluatorDecisionId,
      now
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-memory-evidence',
      now,
      'memory',
      'redacted_full',
      'memory.create',
      memoryId,
      revisionActor,
      'admin',
      'admin_cli',
      `Created memory evidence ${secret} for ${platformUserId}`,
      JSON.stringify({ sourceId, evaluatorDecisionId }),
      0,
      'medium'
    );

    const beforeRows = {
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const shown = JSON.parse(expectSuccessfulCli(['show-memory', memoryId])) as {
      record: {
        id: string;
        canonicalUserId?: string;
        groupId?: string;
        conversationId?: string;
        subjectUserId?: string;
        sourceContext: string;
        sourceEventIds: string[];
        evaluatorDecisionId?: string;
      };
      sources: Array<{ memoryId: string; sourceId: string; extractedBy?: string }>;
      revisions: Array<{
        id: string;
        memoryId: string;
        actor: string;
        reason: string;
        evaluatorDecisionId?: string;
        newState?: Record<string, unknown>;
      }>;
      audit: Array<{ eventId: string; actor: { canonicalUserId?: string } }>;
    };
    const exported = JSON.parse(expectSuccessfulCli([
      'export-memory',
      '--user',
      platformUserId,
    ])) as Array<{
      id: string;
      canonicalUserId?: string;
      groupId?: string;
      conversationId?: string;
      subjectUserId?: string;
      sourceContext: string;
      sourceEventIds: string[];
      evaluatorDecisionId?: string;
    }>;
    const exportedRecord = exported.find((record) => record.id.includes('mem-cli-evidence'));
    expect(exportedRecord).toBeDefined();

    const serialized = JSON.stringify({ shown, exportedRecord });
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformUserId);
    expect(serialized).not.toContain(platformGroupId);
    expect(serialized).not.toContain(sourceId);
    expect(serialized).not.toContain(evaluatorDecisionId);
    expect(serialized).not.toContain(revisionId);
    expect(serialized).not.toContain(revisionActor);
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain('987654321');

    expect(shown.record.id).toContain('[REDACTED');
    expect(shown.record.canonicalUserId).toBe('[REDACTED:platform_id]');
    expect(shown.record.groupId).toBe('[REDACTED:platform_id]');
    expect(shown.record.sourceEventIds[0]).toContain('[REDACTED');
    expect(shown.sources[0]?.memoryId).toContain('[REDACTED');
    expect(shown.sources[0]?.sourceId).toContain('[REDACTED');
    expect(shown.sources[0]?.extractedBy).toContain('[REDACTED');
    expect(shown.revisions[0]?.id).toContain('[REDACTED');
    expect(shown.revisions[0]?.memoryId).toContain('[REDACTED');
    expect(shown.revisions[0]?.actor).toContain('[REDACTED');
    expect(shown.revisions[0]?.reason).toContain('[REDACTED');
    expect(shown.revisions[0]?.evaluatorDecisionId).toContain('[REDACTED');
    expect(JSON.stringify(shown.revisions[0]?.newState)).toContain('[REDACTED');
    expect(exportedRecord?.id).toContain('[REDACTED');
    expect(exportedRecord?.canonicalUserId).toBe('[REDACTED:platform_id]');
    expect(exportedRecord?.sourceEventIds[0]).toContain('[REDACTED');
    expect(exportedRecord?.evaluatorDecisionId).toContain('[REDACTED');

    reopenDb();
    const afterRows = {
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns memory show with redacted legacy source and revision classification values while preserving raw rows', async () => {
    const secret = 'sk-cli-memory-classification-secret-should-not-leak';
    const platformId = 'qq-246813579';
    const legacySourceType = `raw_event-${platformId}-${secret}`;
    const legacyChangeType = `create-${platformId}-${secret}`;
    const memoryId = await memoryRepo.create({
      id: 'mem-cli-legacy-memory-classification',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'Memory classification redaction title',
      content: 'Memory classification redaction content',
      state: 'active',
      confidence: 0.91,
      importance: 0.7,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'source-cli-legacy-memory-classification',
          extractedBy: 'human',
        },
      ],
    });

    db.pragma('ignore_check_constraints = ON');
    try {
      db.prepare('UPDATE memory_sources SET source_type = ? WHERE memory_id = ?').run(
        legacySourceType,
        memoryId
      );
      db.prepare('UPDATE memory_revisions SET change_type = ? WHERE memory_id = ?').run(
        legacyChangeType,
        memoryId
      );
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }

    const beforeRows = {
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const shown = JSON.parse(expectSuccessfulCli(['show-memory', memoryId])) as {
      sources: Array<{ sourceType: string }>;
      revisions: Array<{ changeType: string }>;
    };

    expect(shown.sources).toEqual([
      expect.objectContaining({
        sourceType: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);
    expect(shown.revisions).toEqual([
      expect.objectContaining({
        changeType: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);
    const serialized = JSON.stringify(shown);
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('246813579');

    reopenDb();
    const afterRows = {
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns memory record legacy classification display with redacted values while preserving raw rows', async () => {
    const secret = 'sk-cli-memory-record-classification-secret-should-not-leak';
    const platformId = 'qq-135792468';
    const activeMemoryId = await memoryRepo.create({
      id: 'mem-cli-legacy-record-classification-active',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'Memory record classification active title',
      content: 'Memory record classification active content',
      state: 'active',
      confidence: 0.91,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    const stateMemoryId = await memoryRepo.create({
      id: 'mem-cli-legacy-record-classification-state',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'Memory record classification state title',
      content: 'Memory record classification state content',
      state: 'active',
      confidence: 0.81,
      importance: 0.6,
      sourceContext: 'admin_cli',
    });

    const legacyScope = `user-${platformId}-${secret}`;
    const legacyVisibility = `private_only-${platformId}-${secret}`;
    const legacySensitivity = `normal-${platformId}-${secret}`;
    const legacyAuthority = `user_stated-${platformId}-${secret}`;
    const legacyKind = `preference-${platformId}-${secret}`;
    const legacyState = `active-${platformId}-${secret}`;
    const legacySourceContext = `admin_cli-${platformId}-${secret}`;
    const legacyEvaluatorDecisionId = `policy-${platformId}-${secret}`;

    db.pragma('ignore_check_constraints = ON');
    try {
      db.prepare(
        `UPDATE memory_records
         SET scope = ?, visibility = ?, sensitivity = ?, authority = ?, kind = ?,
             source_context = ?, evaluator_decision_id = ?
         WHERE id = ?`
      ).run(
        legacyScope,
        legacyVisibility,
        legacySensitivity,
        legacyAuthority,
        legacyKind,
        legacySourceContext,
        legacyEvaluatorDecisionId,
        activeMemoryId
      );
      db.prepare('UPDATE memory_records SET state = ? WHERE id = ?').run(
        legacyState,
        stateMemoryId
      );
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }

    const beforeRows = {
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const listOutput = expectSuccessfulCli(['list-memory', '--user', 'user-cli']);
    const shownActive = JSON.parse(expectSuccessfulCli(['show-memory', activeMemoryId])) as {
      record: {
        scope: string;
        visibility: string;
        sensitivity: string;
        authority: string;
        kind: string;
        sourceContext: string;
        evaluatorDecisionId?: string;
      };
    };
    const shownState = JSON.parse(expectSuccessfulCli(['show-memory', stateMemoryId])) as {
      record: { state: string };
    };
    const exported = JSON.parse(expectSuccessfulCli(['export-memory', '--user', 'user-cli'])) as Array<{
      id: string;
      scope: string;
      visibility: string;
      sensitivity: string;
      authority: string;
      kind: string;
      sourceContext: string;
      evaluatorDecisionId?: string;
    }>;
    const exportedRecord = exported.find((record) => record.id === activeMemoryId);
    expect(exportedRecord).toBeDefined();

    expect(shownActive.record.scope).toContain('[REDACTED:platform_id]');
    expect(shownActive.record.visibility).toContain('[REDACTED:platform_id]');
    expect(shownActive.record.sensitivity).toContain('[REDACTED:platform_id]');
    expect(shownActive.record.authority).toContain('[REDACTED:platform_id]');
    expect(shownActive.record.kind).toContain('[REDACTED:platform_id]');
    expect(shownActive.record.sourceContext).toContain('[REDACTED:platform_id]');
    expect(shownActive.record.evaluatorDecisionId).toContain('[REDACTED:platform_id]');
    expect(shownState.record.state).toContain('[REDACTED:platform_id]');
    expect(exportedRecord?.scope).toContain('[REDACTED:platform_id]');
    expect(exportedRecord?.visibility).toContain('[REDACTED:platform_id]');
    expect(exportedRecord?.sensitivity).toContain('[REDACTED:platform_id]');
    expect(exportedRecord?.authority).toContain('[REDACTED:platform_id]');
    expect(exportedRecord?.kind).toContain('[REDACTED:platform_id]');

    const serialized = [
      listOutput,
      JSON.stringify(shownActive),
      JSON.stringify(shownState),
      JSON.stringify(exportedRecord),
    ].join('\n');
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('135792468');

    reopenDb();
    const afterRows = {
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns memory filter validation errors without leaking invalid values or mutating data', async () => {
    const secret = 'sk-jklmnopqrstuvwxyz123456789abcde';
    const invalidState = `active-${secret}-qq-123456789`;
    const invalidScope = `user-${secret}-qq-234567890`;
    const invalidSensitivity = `secret-${secret}-qq-345678901`;
    const invalidSourceType = `chat_message-${secret}-qq-456789012`;

    await memoryRepo.create({
      id: 'mem-cli-filter-validation',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI filter validation',
      content: 'User prefers validating memory filters',
      state: 'active',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'cli-filter-validation-seed',
          extractedBy: 'human',
        },
      ],
    });

    const beforeRows = {
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const results = [
      runCli(['list-memory', '--state', invalidState]),
      runCli(['list-memory', '--scope', invalidScope]),
      runCli(['list-memory', '--sensitivity', invalidSensitivity]),
      runCli(['list-memory', '--source-type', invalidSourceType]),
      runCli(['export-memory', '--state', invalidState]),
      runCli(['export-memory', '--scope', invalidScope]),
      runCli(['export-memory', '--sensitivity', invalidSensitivity]),
      runCli(['export-memory', '--source-type', invalidSourceType]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('❌ Invalid memory');
      expect(result.stderr).toContain('[REDACTED:');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain('123456789');
      expect(result.stderr).not.toContain('234567890');
      expect(result.stderr).not.toContain('345678901');
      expect(result.stderr).not.toContain('456789012');
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('\n    at ');
      expect(result.stderr).not.toContain('TypeError');
    }
    expect(results[0]?.stderr).toContain('Invalid memory state');
    expect(results[1]?.stderr).toContain('Invalid memory scope');
    expect(results[2]?.stderr).toContain('Invalid memory sensitivity');
    expect(results[3]?.stderr).toContain('Invalid memory source type');
    expect(results[4]?.stderr).toContain('Invalid memory state');
    expect(results[5]?.stderr).toContain('Invalid memory scope');
    expect(results[6]?.stderr).toContain('Invalid memory sensitivity');
    expect(results[7]?.stderr).toContain('Invalid memory source type');

    reopenDb();
    const afterRows = {
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns validation errors with redacted embedded platform identifiers', () => {
    const platformId = 'qq-765432109';
    const invalidState = `active_${platformId}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const result = runCli(['list-memory', '--state', invalidState]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid memory state');
    expect(result.stderr).toContain('[REDACTED:platform_id]');
    expect(result.stderr).not.toContain(platformId);
    expect(result.stderr).not.toContain('765432109');

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns validation errors with assignment-shaped adjacent redaction markers', () => {
    const adjacent = 'api_key=sk-cli-validation-secret-qq-765432109';
    const invalidState = adjacent;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const result = runCli(['list-memory', '--state', invalidState]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid memory state');
    expect(result.stderr).toContain('[REDACTED:api_key_assignment]');
    expect(result.stderr).toContain('[REDACTED:platform_id]');
    expect(result.stderr).not.toContain(adjacent);
    expect(result.stderr).not.toContain('sk-cli-validation-secret');
    expect(result.stderr).not.toContain('qq-765432109');
    expect(result.stderr).not.toContain('765432109');

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns command parser errors without leaking invalid values or mutating data', () => {
    const secret = 'sk-lmnopqrstuvwxyz123456789abcdefg';
    const privateQqId = '123456789';
    const unknownCommand = `unknown-${secret}:${privateQqId}`;
    const unknownOption = `--flag-${secret}:${privateQqId}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };

    const results = [
      runCli([unknownCommand]),
      runCli(['show-memory']),
      runCli(['list-memory', unknownOption]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error:');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }
    expect(results[0]?.stderr).toContain('unknown command');
    expect(results[0]?.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(results[0]?.stderr).toContain('[REDACTED:platform_id]');
    expect(results[1]?.stderr).toContain("missing required argument 'memoryId'");
    expect(results[2]?.stderr).toContain('unknown option');
    expect(results[2]?.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(results[2]?.stderr).toContain('[REDACTED:platform_id]');

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns database open failures without leaking paths or stack traces', () => {
    const secret = 'sk-dbopenabcdefghijklmnopqrstuvwxyz123456';
    const privateQqId = '123456789';
    const missingDbPath = join(
      testDir,
      `missing-qq-${privateQqId}-${secret}`,
      `cli-qq-${privateQqId}-${secret}.db`
    );
    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };

    const results = [
      runCliWithEnv(['summarize-governance-health'], {
        LETHEBOT_DB_PATH: missingDbPath,
      }),
      runCliWithEnv(['list-memory'], {
        LETHEBOT_DB_PATH: missingDbPath,
      }),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('❌ Cannot open database');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain(missingDbPath);
      expect(result.stderr).not.toContain(testDir);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('src/storage');
      expect(result.stderr).not.toContain('node_modules');
      expect(result.stderr).not.toContain('better-sqlite3');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns config-load failures without leaking env values or stack traces', () => {
    const secret = 'sk-configabcdefghijklmnopqrstuvwxyz123456';
    const privateQqId = '123456789';
    const invalidLogLevel = `bad-qq-${privateQqId}-${secret}`;
    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };

    const helpResult = runCliWithEnv(['--help'], {
      LOG_LEVEL: invalidLogLevel,
    });
    expect(helpResult.status).toBe(0);
    expect(helpResult.stderr).toBe('');
    expect(helpResult.stdout).toContain('Usage: lethebot-cli');
    expect(helpResult.stdout).not.toContain(secret);
    expect(helpResult.stdout).not.toContain(privateQqId);
    expect(helpResult.stdout).not.toContain(invalidLogLevel);
    expect(helpResult.stdout).not.toContain('src/config');
    expect(helpResult.stdout).not.toContain('src/cli');
    expect(helpResult.stdout).not.toContain('node_modules');

    const result = runCliWithEnv(['list-memory'], {
      LOG_LEVEL: invalidLogLevel,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('❌ Invalid configuration');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain(privateQqId);
    expect(result.stderr).not.toContain(invalidLogLevel);
    expect(result.stderr).not.toContain('Configuration validation failed');
    expect(result.stderr).not.toContain('ConfigValidationError');
    expect(result.stderr).not.toContain('invalid_enum_value');
    expect(result.stderr).not.toContain('received');
    expect(result.stderr).not.toContain('src/config');
    expect(result.stderr).not.toContain('src/cli');
    expect(result.stderr).not.toContain('node_modules');
    expect(result.stderr).not.toContain('TypeError');
    expect(result.stderr).not.toContain('Error:');
    expect(result.stderr).not.toContain('\n    at ');

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns help paths without leaking provided values or mutating data', () => {
    const secret = 'sk-helpabcdefghijklmnopqrstuvwxyz123456789';
    const privateQqId = '123456789';
    const sensitiveUser = `qq-${privateQqId}:${secret}`;
    const sensitiveReason = `token=${secret} target=qq-${privateQqId}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };

    const results = [
      runCli(['--help', `api_key=${secret}`, `qq-${privateQqId}`]),
      runCli(['list-memory', '--user', sensitiveUser, '--help']),
      runCli([
        'set-privacy-opt-out',
        sensitiveUser,
        'proactive_dm',
        '--reason',
        sensitiveReason,
        '--help',
      ]),
    ];

    for (const result of results) {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage: lethebot-cli');
      expect(result.stdout).not.toContain(secret);
      expect(result.stdout).not.toContain(privateQqId);
      expect(result.stdout).not.toContain('api_key=');
      expect(result.stdout).not.toContain('token=');
      expect(result.stdout).not.toContain(dbPath);
      expect(result.stdout).not.toContain(testDir);
      expect(result.stdout).not.toContain('src/cli');
      expect(result.stdout).not.toContain('tests/integration');
    }
    expect(results[0]?.stdout).toContain('LetheBot governance CLI');
    expect(results[1]?.stdout).toContain('List memory records');
    expect(results[2]?.stdout).toContain('Set a user opt-out');

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns missing required argument parser errors without leaking provided values or mutating data', () => {
    const secret = 'sk-pqrstuvwxyz123456789abcdefghijk';
    const privateQqId = '123456789';
    const providedSensitiveId = `partial-qq-${privateQqId}:${secret}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };

    const results = [
      runCli(['approve-memory']),
      runCli(['reject-memory']),
      runCli(['restore-memory']),
      runCli(['delete-memory']),
      runCli(['disable-memory']),
      runCli(['enable-memory']),
      runCli(['supersede-memory', providedSensitiveId]),
      runCli(['set-privacy-opt-out', providedSensitiveId]),
      runCli(['clear-privacy-opt-out', providedSensitiveId]),
      runCli(['redact-display-profile']),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error: missing required argument');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }

    expect(results[0]?.stderr).toContain("missing required argument 'memoryId'");
    expect(results[1]?.stderr).toContain("missing required argument 'memoryId'");
    expect(results[2]?.stderr).toContain("missing required argument 'memoryId'");
    expect(results[3]?.stderr).toContain("missing required argument 'memoryId'");
    expect(results[4]?.stderr).toContain("missing required argument 'memoryId'");
    expect(results[5]?.stderr).toContain("missing required argument 'memoryId'");
    expect(results[6]?.stderr).toContain("missing required argument 'replacementMemoryId'");
    expect(results[7]?.stderr).toContain("missing required argument 'preferenceType'");
    expect(results[8]?.stderr).toContain("missing required argument 'preferenceType'");
    expect(results[9]?.stderr).toContain("missing required argument 'canonicalUserId'");

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns missing option value parser errors without leaking provided values or mutating data', () => {
    const secret = 'sk-qrstuvwxyz123456789abcdefghijkl';
    const privateQqId = '123456789';
    const providedSensitiveId = `qq-${privateQqId}:${secret}`;
    const replacementSensitiveId = `replacement-qq-${privateQqId}:${secret}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };

    const results = [
      runCli(['list-memory', '--user', providedSensitiveId, '--group']),
      runCli(['export-memory', '--user', providedSensitiveId, '--source-id']),
      runCli(['why', '--conversation', providedSensitiveId, '--type', 'private', '--group']),
      runCli(['list-audit', '--event-id', providedSensitiveId, '--level']),
      runCli(['list-action-executions', '--decision', providedSensitiveId, '--action-type']),
      runCli(['list-job-attempts', '--job', providedSensitiveId, '--worker']),
      runCli(['list-event-failures', '--raw-event', providedSensitiveId, '--stage']),
      runCli(['list-privacy-preferences', '--user', providedSensitiveId, '--type']),
      runCli(['set-privacy-opt-out', providedSensitiveId, 'proactive_dm', '--reason']),
      runCli(['clear-privacy-opt-out', providedSensitiveId, 'proactive_dm', '--reason']),
      runCli(['redact-display-profile', providedSensitiveId, '--group']),
      runCli(['supersede-memory', providedSensitiveId, replacementSensitiveId, '--review-audit']),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error: option');
      expect(result.stderr).toContain('argument missing');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }

    expect(results[0]?.stderr).toContain("option '--group <groupId>' argument missing");
    expect(results[1]?.stderr).toContain("option '--source-id <sourceId>' argument missing");
    expect(results[2]?.stderr).toContain("option '--group <groupId>' argument missing");
    expect(results[3]?.stderr).toContain("option '--level <level>' argument missing");
    expect(results[4]?.stderr).toContain("option '--action-type <actionType>' argument missing");
    expect(results[5]?.stderr).toContain("option '--worker <workerId>' argument missing");
    expect(results[6]?.stderr).toContain("option '--stage <stage>' argument missing");
    expect(results[7]?.stderr).toContain("option '--type <preferenceType>' argument missing");
    expect(results[8]?.stderr).toContain("option '--reason <reason>' argument missing");
    expect(results[9]?.stderr).toContain("option '--reason <reason>' argument missing");
    expect(results[10]?.stderr).toContain("option '--group <groupId>' argument missing");
    expect(results[11]?.stderr).toContain("option '--review-audit <auditId>' argument missing");

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns extended inspection missing option value parser errors without leaking or mutating data', () => {
    const secret = 'sk-stuvwxyz123456789abcdefghijklm';
    const privateQqId = '123456789';
    const providedSensitiveId = `qq-${privateQqId}:${secret}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db
        .prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type')
        .all(),
    };

    const results = [
      runCli(['list-memory', '--user', providedSensitiveId, '--scope']),
      runCli(['export-memory', '--user', providedSensitiveId, '--source-type']),
      runCli(['list-audit', '--event-id', providedSensitiveId, '--event-type']),
      runCli(['list-memory-reviews', '--event-type']),
      runCli(['summarize-memory-reviews', '--memory']),
      runCli(['list-action-decisions', '--turn', providedSensitiveId, '--decided-by']),
      runCli(['list-action-decisions', '--turn', providedSensitiveId, '--risk']),
      runCli(['list-action-executions', '--decision', providedSensitiveId, '--status']),
      runCli(['list-tool-calls', '--turn', providedSensitiveId, '--tool']),
      runCli(['list-jobs', '--status', providedSensitiveId, '--type']),
      runCli(['list-job-attempts', '--job', providedSensitiveId, '--status']),
      runCli(['list-worker-heartbeats', '--worker', providedSensitiveId, '--type']),
      runCli(['list-event-failures', '--raw-event', providedSensitiveId, '--turn']),
      runCli(['list-privacy-preferences', '--user', providedSensitiveId, '--state']),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error: option');
      expect(result.stderr).toContain('argument missing');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }

    expect(results[0]?.stderr).toContain("option '--scope <scope>' argument missing");
    expect(results[1]?.stderr).toContain("option '--source-type <sourceType>' argument missing");
    expect(results[2]?.stderr).toContain("option '--event-type <eventType>' argument missing");
    expect(results[3]?.stderr).toContain("option '--event-type <eventType>' argument missing");
    expect(results[4]?.stderr).toContain("option '--memory <memoryId>' argument missing");
    expect(results[5]?.stderr).toContain("option '--decided-by <decidedBy>' argument missing");
    expect(results[6]?.stderr).toContain("option '--risk <riskLevel>' argument missing");
    expect(results[7]?.stderr).toContain("option '--status <status>' argument missing");
    expect(results[8]?.stderr).toContain("option '--tool <toolName>' argument missing");
    expect(results[9]?.stderr).toContain("option '--type <type>' argument missing");
    expect(results[10]?.stderr).toContain("option '--status <status>' argument missing");
    expect(results[11]?.stderr).toContain("option '--type <workerType>' argument missing");
    expect(results[12]?.stderr).toContain("option '--turn <turnId>' argument missing");
    expect(results[13]?.stderr).toContain("option '--state <state>' argument missing");

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db
        .prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type')
        .all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns empty option value parser errors without leaking provided values or mutating data', () => {
    const secret = 'sk-rstuvwxyz123456789abcdefghijklm';
    const privateQqId = '123456789';
    const providedSensitiveId = `qq-${privateQqId}:${secret}`;
    const replacementSensitiveId = `replacement-qq-${privateQqId}:${secret}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };

    const results = [
      runCli(['list-memory', `--user=${providedSensitiveId}`, '--group=']),
      runCli(['export-memory', '--user', providedSensitiveId, '--source-id=']),
      runCli(['why', `--conversation=${providedSensitiveId}`, '--type', 'private', '--group=']),
      runCli(['list-audit', `--event-id=${providedSensitiveId}`, '--level=']),
      runCli(['list-action-executions', `--decision=${providedSensitiveId}`, '--action-type=']),
      runCli(['list-job-attempts', `--job=${providedSensitiveId}`, '--worker=']),
      runCli(['list-event-failures', `--raw-event=${providedSensitiveId}`, '--stage=']),
      runCli(['list-privacy-preferences', `--user=${providedSensitiveId}`, '--type=']),
      runCli(['set-privacy-opt-out', providedSensitiveId, 'proactive_dm', '--reason=']),
      runCli(['clear-privacy-opt-out', providedSensitiveId, 'proactive_dm', '--reason=']),
      runCli(['redact-display-profile', providedSensitiveId, '--group=']),
      runCli(['supersede-memory', providedSensitiveId, replacementSensitiveId, '--review-audit=']),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error: option');
      expect(result.stderr).toContain('argument missing');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }

    expect(results[0]?.stderr).toContain("option '--group <groupId>' argument missing");
    expect(results[1]?.stderr).toContain("option '--source-id <sourceId>' argument missing");
    expect(results[2]?.stderr).toContain("option '--group <groupId>' argument missing");
    expect(results[3]?.stderr).toContain("option '--level <level>' argument missing");
    expect(results[4]?.stderr).toContain("option '--action-type <actionType>' argument missing");
    expect(results[5]?.stderr).toContain("option '--worker <workerId>' argument missing");
    expect(results[6]?.stderr).toContain("option '--stage <stage>' argument missing");
    expect(results[7]?.stderr).toContain("option '--type <preferenceType>' argument missing");
    expect(results[8]?.stderr).toContain("option '--reason <reason>' argument missing");
    expect(results[9]?.stderr).toContain("option '--reason <reason>' argument missing");
    expect(results[10]?.stderr).toContain("option '--group <groupId>' argument missing");
    expect(results[11]?.stderr).toContain("option '--review-audit <auditId>' argument missing");

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns extended inspection empty option value parser errors without leaking or mutating data', () => {
    const secret = 'sk-tuvwxyz123456789abcdefghijklmn';
    const privateQqId = '123456789';
    const providedSensitiveId = `qq-${privateQqId}:${secret}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db
        .prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type')
        .all(),
    };

    const results = [
      runCli(['list-memory', `--user=${providedSensitiveId}`, '--scope=']),
      runCli(['export-memory', `--user=${providedSensitiveId}`, '--source-type=']),
      runCli(['list-audit', `--event-id=${providedSensitiveId}`, '--event-type=']),
      runCli(['list-memory-reviews', '--event-type=']),
      runCli(['summarize-memory-reviews', '--memory=']),
      runCli(['list-action-decisions', `--turn=${providedSensitiveId}`, '--decided-by=']),
      runCli(['list-action-decisions', `--turn=${providedSensitiveId}`, '--risk=']),
      runCli(['list-action-executions', `--decision=${providedSensitiveId}`, '--status=']),
      runCli(['list-tool-calls', `--turn=${providedSensitiveId}`, '--tool=']),
      runCli(['list-jobs', `--status=${providedSensitiveId}`, '--type=']),
      runCli(['list-job-attempts', `--job=${providedSensitiveId}`, '--status=']),
      runCli(['list-worker-heartbeats', `--worker=${providedSensitiveId}`, '--type=']),
      runCli(['list-event-failures', `--raw-event=${providedSensitiveId}`, '--turn=']),
      runCli(['list-privacy-preferences', `--user=${providedSensitiveId}`, '--state=']),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error: option');
      expect(result.stderr).toContain('argument missing');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }

    expect(results[0]?.stderr).toContain("option '--scope <scope>' argument missing");
    expect(results[1]?.stderr).toContain("option '--source-type <sourceType>' argument missing");
    expect(results[2]?.stderr).toContain("option '--event-type <eventType>' argument missing");
    expect(results[3]?.stderr).toContain("option '--event-type <eventType>' argument missing");
    expect(results[4]?.stderr).toContain("option '--memory <memoryId>' argument missing");
    expect(results[5]?.stderr).toContain("option '--decided-by <decidedBy>' argument missing");
    expect(results[6]?.stderr).toContain("option '--risk <riskLevel>' argument missing");
    expect(results[7]?.stderr).toContain("option '--status <status>' argument missing");
    expect(results[8]?.stderr).toContain("option '--tool <toolName>' argument missing");
    expect(results[9]?.stderr).toContain("option '--type <type>' argument missing");
    expect(results[10]?.stderr).toContain("option '--status <status>' argument missing");
    expect(results[11]?.stderr).toContain("option '--type <workerType>' argument missing");
    expect(results[12]?.stderr).toContain("option '--turn <turnId>' argument missing");
    expect(results[13]?.stderr).toContain("option '--state <state>' argument missing");

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db
        .prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type')
        .all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns extra positional argument parser errors without leaking invalid values or mutating data', () => {
    const secret = 'sk-nopqrstuvwxyz123456789abcdefghi';
    const privateQqId = '123456789';
    const unexpectedValue = `unexpected-${secret}:qq-${privateQqId}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };

    const results = [
      runCli(['approve-memory', 'mem-cli-extra-arg', unexpectedValue]),
      runCli(['reject-memory', 'mem-cli-extra-arg', unexpectedValue]),
      runCli(['restore-memory', 'mem-cli-extra-arg', unexpectedValue]),
      runCli(['delete-memory', 'mem-cli-extra-arg', unexpectedValue]),
      runCli(['disable-memory', 'mem-cli-extra-arg', unexpectedValue]),
      runCli(['enable-memory', 'mem-cli-extra-arg', unexpectedValue]),
      runCli(['supersede-memory', 'mem-cli-extra-old', 'mem-cli-extra-new', unexpectedValue]),
      runCli(['set-privacy-opt-out', 'user-cli', 'proactive_dm', unexpectedValue]),
      runCli(['clear-privacy-opt-out', 'user-cli', 'proactive_dm', unexpectedValue]),
      runCli(['redact-display-profile', 'user-cli', unexpectedValue]),
      runCli(['why', unexpectedValue]),
      runCli(['summarize-governance-health', unexpectedValue]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error: too many arguments');
      expect(result.stderr).toContain('[REDACTED:openai_like_api_key]');
      expect(result.stderr).toContain('[REDACTED:platform_id]');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }

    expect(results[0]?.stderr).toContain("too many arguments for 'approve-memory'");
    expect(results[1]?.stderr).toContain("too many arguments for 'reject-memory'");
    expect(results[2]?.stderr).toContain("too many arguments for 'restore-memory'");
    expect(results[3]?.stderr).toContain("too many arguments for 'delete-memory'");
    expect(results[4]?.stderr).toContain("too many arguments for 'disable-memory'");
    expect(results[5]?.stderr).toContain("too many arguments for 'enable-memory'");
    expect(results[6]?.stderr).toContain("too many arguments for 'supersede-memory'");
    expect(results[7]?.stderr).toContain("too many arguments for 'set-privacy-opt-out'");
    expect(results[8]?.stderr).toContain("too many arguments for 'clear-privacy-opt-out'");
    expect(results[9]?.stderr).toContain("too many arguments for 'redact-display-profile'");
    expect(results[10]?.stderr).toContain("too many arguments for 'why'");
    expect(results[11]?.stderr).toContain("too many arguments for 'summarize-governance-health'");

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns inspection extra positional argument parser errors without leaking or mutating data', () => {
    const secret = 'sk-uvwxyz123456789abcdefghijklmno';
    const privateQqId = '123456789';
    const unexpectedValue = `unexpected-${secret}:qq-${privateQqId}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db
        .prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type')
        .all(),
    };

    const results = [
      runCli(['list-memory', unexpectedValue]),
      runCli(['show-memory', 'mem-cli-extra-inspection', unexpectedValue]),
      runCli(['export-memory', unexpectedValue]),
      runCli(['list-audit', unexpectedValue]),
      runCli(['list-memory-reviews', unexpectedValue]),
      runCli(['summarize-memory-reviews', unexpectedValue]),
      runCli(['list-action-decisions', unexpectedValue]),
      runCli(['list-action-executions', unexpectedValue]),
      runCli(['list-tool-calls', unexpectedValue]),
      runCli(['list-jobs', unexpectedValue]),
      runCli(['list-job-attempts', unexpectedValue]),
      runCli(['list-worker-heartbeats', unexpectedValue]),
      runCli(['list-event-failures', unexpectedValue]),
      runCli(['list-privacy-preferences', unexpectedValue]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error: too many arguments');
      expect(result.stderr).toContain('[REDACTED:openai_like_api_key]');
      expect(result.stderr).toContain('[REDACTED:platform_id]');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }

    expect(results[0]?.stderr).toContain("too many arguments for 'list-memory'");
    expect(results[1]?.stderr).toContain("too many arguments for 'show-memory'");
    expect(results[2]?.stderr).toContain("too many arguments for 'export-memory'");
    expect(results[3]?.stderr).toContain("too many arguments for 'list-audit'");
    expect(results[4]?.stderr).toContain("too many arguments for 'list-memory-reviews'");
    expect(results[5]?.stderr).toContain("too many arguments for 'summarize-memory-reviews'");
    expect(results[6]?.stderr).toContain("too many arguments for 'list-action-decisions'");
    expect(results[7]?.stderr).toContain("too many arguments for 'list-action-executions'");
    expect(results[8]?.stderr).toContain("too many arguments for 'list-tool-calls'");
    expect(results[9]?.stderr).toContain("too many arguments for 'list-jobs'");
    expect(results[10]?.stderr).toContain("too many arguments for 'list-job-attempts'");
    expect(results[11]?.stderr).toContain("too many arguments for 'list-worker-heartbeats'");
    expect(results[12]?.stderr).toContain("too many arguments for 'list-event-failures'");
    expect(results[13]?.stderr).toContain("too many arguments for 'list-privacy-preferences'");

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db
        .prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type')
        .all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns unknown-option parser errors for governance commands without leaking or mutating data', () => {
    const secret = 'sk-opqrstuvwxyz123456789abcdefghij';
    const privateQqId = '123456789';
    const unknownOption = `--unknown-qq-${privateQqId}:${secret}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };

    const results = [
      runCli(['approve-memory', 'mem-cli-unknown-option', unknownOption]),
      runCli(['reject-memory', 'mem-cli-unknown-option', unknownOption]),
      runCli(['restore-memory', 'mem-cli-unknown-option', unknownOption]),
      runCli(['delete-memory', 'mem-cli-unknown-option', unknownOption]),
      runCli(['disable-memory', 'mem-cli-unknown-option', unknownOption]),
      runCli(['enable-memory', 'mem-cli-unknown-option', unknownOption]),
      runCli(['supersede-memory', 'mem-cli-unknown-old', 'mem-cli-unknown-new', unknownOption]),
      runCli(['set-privacy-opt-out', 'user-cli', 'proactive_dm', unknownOption]),
      runCli(['clear-privacy-opt-out', 'user-cli', 'proactive_dm', unknownOption]),
      runCli(['redact-display-profile', 'user-cli', unknownOption]),
      runCli(['why', unknownOption]),
      runCli(['summarize-governance-health', unknownOption]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error: unknown option');
      expect(result.stderr).toContain('[REDACTED:openai_like_api_key]');
      expect(result.stderr).toContain('[REDACTED:platform_id]');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns unknown-option parser errors for inspection commands without leaking or mutating data', () => {
    const secret = 'sk-pqrstuvwxyz123456789abcdefghijk';
    const privateQqId = '123456789';
    const unknownOption = `--inspection-unknown-qq-${privateQqId}:${secret}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db
        .prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type')
        .all(),
    };

    const results = [
      runCli(['list-memory', unknownOption]),
      runCli(['show-memory', 'mem-cli-unknown-inspection', unknownOption]),
      runCli(['export-memory', unknownOption]),
      runCli(['list-audit', unknownOption]),
      runCli(['list-memory-reviews', unknownOption]),
      runCli(['summarize-memory-reviews', unknownOption]),
      runCli(['list-action-decisions', unknownOption]),
      runCli(['list-action-executions', unknownOption]),
      runCli(['list-tool-calls', unknownOption]),
      runCli(['list-jobs', unknownOption]),
      runCli(['list-job-attempts', unknownOption]),
      runCli(['list-worker-heartbeats', unknownOption]),
      runCli(['list-event-failures', unknownOption]),
      runCli(['list-privacy-preferences', unknownOption]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error: unknown option');
      expect(result.stderr).toContain('[REDACTED:openai_like_api_key]');
      expect(result.stderr).toContain('[REDACTED:platform_id]');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db
        .prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type')
        .all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns boolean include-flag parser errors without leaking invalid values or mutating data', () => {
    const secret = 'sk-mnopqrstuvwxyz123456789abcdefgh';
    const privateQqId = '123456789';
    const unexpectedValue = `unexpected-${secret}:qq-${privateQqId}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };

    const results = [
      runCli(['list-audit', '--include-details', unexpectedValue]),
      runCli(['list-memory-reviews', '--include-details', unexpectedValue]),
      runCli(['list-action-decisions', '--include-actions', unexpectedValue]),
      runCli(['list-action-executions', '--include-audit-entry', unexpectedValue]),
      runCli(['list-tool-calls', '--include-payload', unexpectedValue]),
      runCli(['list-jobs', '--include-payload', unexpectedValue]),
      runCli(['list-job-attempts', '--include-result', unexpectedValue]),
      runCli(['list-worker-heartbeats', '--include-details', unexpectedValue]),
      runCli(['list-event-failures', '--include-details', unexpectedValue]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error: too many arguments');
      expect(result.stderr).toContain('[REDACTED:openai_like_api_key]');
      expect(result.stderr).toContain('[REDACTED:platform_id]');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns boolean include-flag equals-value parser errors without leaking invalid values or mutating data', () => {
    const secret = 'sk-nopqrstuvwxyz123456789abcdefghi';
    const privateQqId = '123456789';
    const unexpectedValue = `unexpected-${secret}:qq-${privateQqId}`;

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };

    const results = [
      runCli(['list-audit', `--include-details=${unexpectedValue}`]),
      runCli(['list-memory-reviews', `--include-details=${unexpectedValue}`]),
      runCli(['list-action-decisions', `--include-actions=${unexpectedValue}`]),
      runCli(['list-action-executions', `--include-audit-entry=${unexpectedValue}`]),
      runCli(['list-tool-calls', `--include-payload=${unexpectedValue}`]),
      runCli(['list-jobs', `--include-payload=${unexpectedValue}`]),
      runCli(['list-job-attempts', `--include-result=${unexpectedValue}`]),
      runCli(['list-worker-heartbeats', `--include-details=${unexpectedValue}`]),
      runCli(['list-event-failures', `--include-details=${unexpectedValue}`]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error: unknown option');
      expect(result.stderr).toContain('[REDACTED:openai_like_api_key]');
      expect(result.stderr).toContain('[REDACTED:platform_id]');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(privateQqId);
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('TypeError');
      expect(result.stderr).not.toContain('Error:');
      expect(result.stderr).not.toContain('\n    at ');
    }

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns limit validation errors without leaking invalid values or mutating data', async () => {
    const secret = 'sk-klmnopqrstuvwxyz123456789abcdef';
    const invalidLimit = `7-${secret}-qq-123456789`;
    const tooLargeLimit = '1001';
    const invalidRecentMessageLimit = `9-${secret}-qq-234567890`;

    await memoryRepo.create({
      id: 'mem-cli-limit-validation',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI limit validation',
      content: 'User prefers validating numeric limits',
      state: 'active',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'cli-limit-validation-seed',
          extractedBy: 'human',
        },
      ],
    });

    const now = Date.now();
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-limit-validation',
      now,
      'system',
      'summary',
      'limit.validation.seed',
      'limit-validation-seed',
      'user-cli',
      'system_worker',
      'admin_cli',
      'Limit validation seed audit',
      JSON.stringify({ safe: true }),
      1,
      'low'
    );

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };

    const results = [
      runCli(['list-memory', '--limit', invalidLimit]),
      runCli(['export-memory', '--limit', invalidLimit]),
      runCli(['list-audit', '--limit', invalidLimit]),
      runCli(['list-jobs', '--limit', invalidLimit]),
      runCli(['list-worker-heartbeats', '--limit', tooLargeLimit]),
      runCli(['list-privacy-preferences', '--limit', invalidLimit]),
      runCli([
        'why',
        '--conversation',
        'private:cli-limit-validation',
        '--type',
        'private',
        '--user',
        'user-cli',
        '--limit',
        invalidRecentMessageLimit,
      ]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('❌ Invalid');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain('123456789');
      expect(result.stderr).not.toContain('234567890');
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('\n    at ');
      expect(result.stderr).not.toContain('TypeError');
    }
    expect(results[0]?.stderr).toContain('Invalid limit');
    expect(results[1]?.stderr).toContain('Invalid limit');
    expect(results[2]?.stderr).toContain('Invalid limit');
    expect(results[3]?.stderr).toContain('Invalid limit');
    expect(results[4]?.stderr).toContain('expected an integer between 1 and 1000');
    expect(results[5]?.stderr).toContain('Invalid limit');
    expect(results[6]?.stderr).toContain('Invalid recent message limit');
    expect(results[0]?.stderr).toContain('[REDACTED:');
    expect(results[6]?.stderr).toContain('[REDACTED:');

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      privacyPreferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns extended inspection limit validation errors without leaking invalid values or mutating data', () => {
    const secret = 'sk-lmnopqrstuvwxyz123456789abcdefg';
    const invalidLimit = `13-${secret}-qq-123456789`;
    const tooLargeLimit = '1001';
    const now = Date.now();

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-extended-limit-validation',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:cli-extended-limit-validation',
      JSON.stringify({ token: secret }),
      now
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-extended-limit-validation',
      'private:cli-extended-limit-validation',
      'evt-cli-extended-limit-validation',
      'ctx-cli-extended-limit-validation',
      'mock',
      'mock',
      'completed',
      now,
      now
    );
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'decision-cli-extended-limit-validation',
      'turn-cli-extended-limit-validation',
      'pi',
      'medium',
      0.7,
      1,
      1,
      JSON.stringify([{ type: 'reply_short', payload: { text: `hidden ${secret}` } }]),
      JSON.stringify([`hidden reason ${secret}`]),
      JSON.stringify([]),
      now
    );
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status,
        error_code, error_message, audit_level, audit_entry, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'execution-cli-extended-limit-validation',
      'decision-cli-extended-limit-validation',
      'reply_short',
      'success',
      null,
      null,
      'summary',
      `audit ${secret}`,
      now
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        error_code, error_message, execution_time_ms, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'tool-cli-extended-limit-validation',
      'turn-cli-extended-limit-validation',
      'read_file',
      JSON.stringify({ path: `/tmp/${secret}` }),
      JSON.stringify({ text: `tool output ${secret}` }),
      'pi',
      'user-cli',
      'user',
      'private_chat',
      'success',
      null,
      null,
      4,
      0,
      now
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-extended-limit-validation',
      now,
      'memory',
      'redacted_full',
      'memory.consolidation.candidates_detected',
      'job-cli-extended-limit-validation',
      'user-cli',
      'system_worker',
      'background_worker',
      `review summary ${secret}`,
      JSON.stringify({
        groups: [{ memoryIds: ['mem-cli-extended-limit-validation'] }],
        token: secret,
      }),
      0,
      'medium'
    );
    db.prepare(
      `INSERT INTO event_processing_failures (
        id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
        error_name, error_message_hash, message_id_hash, sender_id_hash,
        conversation_id_hash, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'failure-cli-extended-limit-validation',
      'evt-cli-extended-limit-validation',
      'turn-cli-extended-limit-validation',
      now,
      'pi_inference',
      'private',
      'Error',
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      JSON.stringify({ diagnostic: `hidden ${secret}` })
    );

    const jobRepo = new JobRepository(db);
    const jobId = jobRepo.enqueue({
      id: 'job-cli-extended-limit-validation',
      type: 'summary',
      payload: { conversationId: 'private:cli-extended-limit-validation', token: secret },
      idempotencyKey: `extended-limit:${secret}`,
      now,
    });
    const claimed = jobRepo.claimNext({ workerId: 'worker-cli-extended-limit-validation', now: now + 1 });
    if (!claimed) {
      throw new Error('Expected extended limit validation job to be claimed');
    }
    jobRepo.complete({
      jobId,
      attemptId: claimed.attemptId,
      result: { token: secret },
      now: now + 2,
    });
    jobRepo.heartbeat({
      workerId: 'worker-cli-extended-limit-validation',
      workerType: 'background',
      status: 'idle',
      details: { token: secret },
      now: now + 3,
    });

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
    };

    const results = [
      runCli(['list-action-decisions', '--limit', invalidLimit]),
      runCli(['list-action-executions', '--limit', invalidLimit]),
      runCli(['list-tool-calls', '--limit', invalidLimit]),
      runCli(['list-job-attempts', '--limit', invalidLimit]),
      runCli(['list-event-failures', '--limit', invalidLimit]),
      runCli(['list-memory-reviews', '--limit', invalidLimit]),
      runCli(['list-memory-reviews', '--limit', tooLargeLimit]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('❌ Invalid limit');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain('123456789');
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('\n    at ');
      expect(result.stderr).not.toContain('TypeError');
    }
    for (const result of results.slice(0, -1)) {
      expect(result.stderr).toContain('[REDACTED:');
    }
    expect(results[6]?.stderr).toContain('expected an integer between 1 and 1000');

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns human-readable memory inspection with redacted display identifiers', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const privateQqId = 'qq-12345678';
    const groupId = 'qq-group-87654321';
    const now = Date.now();

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      privateQqId,
      now,
      now
    );

    const userMemoryId = await memoryRepo.create({
      id: `mem-cli-display-${secret}`,
      scope: 'user',
      canonicalUserId: privateQqId,
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'Display ID redaction preference',
      content: 'User prefers redacted display identifiers',
      state: 'active',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    const groupMemoryId = await memoryRepo.create({
      id: 'mem-cli-display-group-id',
      scope: 'group',
      groupId,
      visibility: 'same_group_only',
      sensitivity: 'normal',
      authority: 'inferred',
      kind: 'fact',
      title: 'Display group redaction fact',
      content: 'Group prefers redacted display identifiers',
      state: 'active',
      confidence: 0.86,
      importance: 0.66,
      sourceContext: 'group_chat',
    });

    const listOutput = expectSuccessfulCli(['list-memory', '--limit', '20']);
    const missingShow = runCli(['show-memory', `missing-${secret}.ref-${privateQqId}`]);

    expect(listOutput).toContain('Found 2 memory records');
    expect(listOutput).toContain('[REDACTED:openai_like_api_key]');
    expect(listOutput).toContain('[REDACTED:platform_id]');
    expect(listOutput).toContain('ID: mem-cli-display-group-id');
    expect(listOutput).toContain('Title: Display ID redaction preference');
    expect(listOutput).toContain('Content: User prefers redacted display identifiers');
    expect(listOutput).not.toContain(secret);
    expect(listOutput).not.toContain(privateQqId);
    expect(listOutput).not.toContain(groupId);

    expect(missingShow.status).toBe(1);
    expect(missingShow.stdout).toBe('');
    expect(missingShow.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(missingShow.stderr).toContain('[REDACTED:platform_id]');
    expect(missingShow.stderr).toContain('not found');
    expect(missingShow.stderr).not.toContain(secret);
    expect(missingShow.stderr).not.toContain(privateQqId);

    reopenDb();
    expect(db.prepare('SELECT state FROM memory_records WHERE id = ?').get(userMemoryId)).toEqual({
      state: 'active',
    });
    expect(db.prepare('SELECT state FROM memory_records WHERE id = ?').get(groupMemoryId)).toEqual({
      state: 'active',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why command with stored context trace and deterministic redaction', () => {
    const now = Date.now();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-why',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:cli-why',
      JSON.stringify({ text: `raw event should not print ${secret}` }),
      now,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-cli-why',
      'evt-cli-why',
      'platform-cli-why',
      'private:cli-why',
      'private',
      'qq-cli-why',
      `message text should not print ${secret}`,
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-why',
      'private:cli-why',
      'evt-cli-why',
      'ctx-cli-why',
      'mock',
      'mock',
      'completed',
      now,
    );
    db.prepare(
      `INSERT INTO context_traces (
        id, turn_id, conversation_id, conversation_type, group_id,
        candidate_memory_ids, selected_memory_ids, rejected_memories,
        filters_applied, injected_identity_fields, recent_message_ids,
        token_budget, memories, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ctx-cli-why',
      'turn-cli-why',
      'private:cli-why',
      'private',
      null,
      JSON.stringify(['mem-cli-why-candidate']),
      JSON.stringify(['mem-cli-why-selected']),
      JSON.stringify([{ memoryId: 'mem-cli-why-rejected', reason: `api_key=${secret}` }]),
      JSON.stringify(['state=active', `token=${secret}`]),
      JSON.stringify(['conversation_id', `api_key=${secret}`]),
      JSON.stringify(['msg-cli-why']),
      JSON.stringify({
        max: 8000,
        used: 32,
        breakdown: { recentMessages: 8, memory: 12, identity: 4, system: 8 },
      }),
      JSON.stringify([
        {
          memoryId: 'mem-cli-why-selected',
          scope: 'user',
          kind: 'fact',
          title: `stored title should not print ${secret}`,
          sourceContext: 'test',
        },
      ]),
      now,
    );

    const output = expectSuccessfulCli(['why', '--turn', 'turn-cli-why']);

    expect(output).toContain('Context explanation for turn turn-cli-why');
    expect(output).toContain('ContextPack: ctx-cli-why (stored)');
    expect(output).toContain('Selected memories: mem-cli-why-selected');
    expect(output).toContain('Candidate memories: mem-cli-why-candidate');
    expect(output).toContain('Token budget: used 32 / max 8000');
    expect(output).toContain('Token breakdown: recentMessages=8, memory=12, identity=4, system=8');
    expect(output).toContain('Rejected memories:');
    expect(output).toContain('[REDACTED:');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('message text should not print');
    expect(output).not.toContain('stored title should not print');

    reopenDb();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why command with linked action-decision suppressor evidence', async () => {
    const now = Date.now();
    const secret = 'sk-cli-why-action-secret-abcdefghijklmnopqrstuvwxyz';
    const rawPlatformId = 'qq-2345678901';
    const rawExecutedMessageId = 'qq-3456789012';
    const turnId = 'turn-cli-why-action';
    const decisionId = `decision-cli-why-action-${secret}-${rawPlatformId}`;
    const successExecutionId = `execution-cli-why-action-success-${secret}-${rawExecutedMessageId}`;
    const failedExecutionId = `execution-cli-why-action-failed-${secret}-${rawPlatformId}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-why-action',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'group:cli-why-action',
      JSON.stringify({ text: `raw action why event should not print ${secret}` }),
      now,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, text, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-cli-why-action',
      'evt-cli-why-action',
      'platform-cli-why-action',
      'group:cli-why-action',
      'group',
      rawPlatformId,
      'qq-cli-why-action-user',
      `action why message should not print ${secret}`,
      1,
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      turnId,
      'group:cli-why-action',
      'evt-cli-why-action',
      'ctx-cli-why-action',
      'mock',
      'mock',
      'completed',
      now,
    );
    db.prepare(
      `INSERT INTO context_traces (
        id, turn_id, conversation_id, conversation_type, group_id,
        candidate_memory_ids, selected_memory_ids, rejected_memories,
        filters_applied, injected_identity_fields, recent_message_ids,
        token_budget, memories, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ctx-cli-why-action',
      turnId,
      'group:cli-why-action',
      'group',
      rawPlatformId,
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify(['state=active']),
      JSON.stringify(['conversation_id', 'conversation_type', 'group_id']),
      JSON.stringify(['msg-cli-why-action']),
      JSON.stringify({
        max: 8000,
        used: 24,
        breakdown: { recentMessages: 4, memory: 0, identity: 8, system: 12 },
      }),
      JSON.stringify([]),
      now,
    );

    const actionRepo = new ActionRepository(db);
    await actionRepo.createDecision({
      id: decisionId,
      turnId,
      decidedBy: 'attention',
      riskLevel: 'medium',
      confidence: 0.72,
      evaluatorRequired: false,
      actions: [
        {
          type: 'reply_short',
          priority: 1,
          target: {
            conversationId: 'group:cli-why-action',
            conversationType: 'group',
            groupId: rawPlatformId,
          },
          constraints: {
            cooldownKey: `group:${rawPlatformId}:reply_short`,
            maxResponseTokens: 120,
          },
          reason: `explicit mention but api_key=${secret}-${rawPlatformId}`,
        },
        {
          type: 'silent_store',
          priority: 2,
          constraints: {},
          reason: 'always preserve raw event first',
        },
      ],
      reasons: [
        `explicit @bot mention with token=${secret}-${rawPlatformId}`,
        'low confidence group reply kept short',
      ],
      suppressors: [
        `cooldown:group:${rawPlatformId}:reply_short`,
        `high-speed chat api_key=${secret}-${rawPlatformId}`,
      ],
      createdAt: new Date(now + 1),
    });
    await actionRepo.createExecution({
      id: successExecutionId,
      actionDecisionId: decisionId,
      actionType: 'reply_short',
      status: 'success',
      executedMessageId: rawExecutedMessageId,
      auditLevel: 'summary',
      auditEntry: `sent reply with api_key=${secret}-${rawPlatformId}`,
      executedAt: new Date(now + 2),
    });
    await actionRepo.createExecution({
      id: failedExecutionId,
      actionDecisionId: decisionId,
      actionType: 'dm_user',
      status: 'failed',
      downgradedFrom: 'reply_full',
      downgradedReason: `cooldown fallback api_key=${secret}-${rawPlatformId}`,
      error: {
        code: `SEND_FAILED_${rawPlatformId}`,
        message: `adapter rejected token=${secret}-${rawPlatformId}`,
        recoverable: true,
      },
      auditLevel: 'redacted_full',
      auditEntry: `failed dm_user with token=${secret}-${rawPlatformId}`,
      executedAt: new Date(now + 3),
    });

    const beforeCounts = {
      actionDecisions: db.prepare('SELECT COUNT(*) AS count FROM action_decisions').get() as { count: number },
      actionExecutions: db.prepare('SELECT COUNT(*) AS count FROM action_executions').get() as { count: number },
      auditLog: db.prepare('SELECT COUNT(*) AS count FROM audit_log').get() as { count: number },
      contextTraces: db.prepare('SELECT COUNT(*) AS count FROM context_traces').get() as { count: number },
    };

    const output = expectSuccessfulCli(['why', '--turn', turnId]);

    expect(output).toContain('ContextPack: ctx-cli-why-action (stored)');
    expect(output).toContain('Action decision: decision-cli-why-action-[REDACTED:openai_like_api_key]');
    expect(output).toContain('decided_by=attention');
    expect(output).toContain('risk=medium');
    expect(output).toContain('actions=reply_short, silent_store');
    expect(output).toContain('Action reasons:');
    expect(output).toContain('explicit @bot mention');
    expect(output).toContain('low confidence group reply kept short');
    expect(output).toContain('Action suppressors:');
    expect(output).toContain('cooldown:group:[REDACTED:platform_id]:reply_short');
    expect(output).toContain('high-speed chat');
    expect(output).toContain('Action executions:');
    expect(output).toContain('execution-cli-why-action-success-[REDACTED:openai_like_api_key]');
    expect(output).toContain('reply_short:success');
    expect(output).toContain('message=[REDACTED:platform_id]');
    expect(output).toContain('execution-cli-why-action-failed-[REDACTED:openai_like_api_key]');
    expect(output).toContain('dm_user:failed');
    expect(output).toContain('downgraded_from=reply_full');
    expect(output).toContain('cooldown fallback');
    expect(output).toContain('error_code=SEND_FAILED_[REDACTED:platform_id]');
    expect(output).toContain('adapter rejected');
    expect(output).toContain('[REDACTED:api_key_assignment]');
    expect(output).toContain('[REDACTED:platform_id]');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(rawPlatformId);
    expect(output).not.toContain(rawExecutedMessageId);
    expect(output).not.toContain('api_key=');
    expect(output).not.toContain('token=');
    expect(output).not.toContain('raw action why event should not print');
    expect(output).not.toContain('action why message should not print');

    reopenDb();
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_decisions').get()).toEqual(beforeCounts.actionDecisions);
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_executions').get()).toEqual(beforeCounts.actionExecutions);
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get()).toEqual(beforeCounts.auditLog);
    expect(db.prepare('SELECT COUNT(*) AS count FROM context_traces').get()).toEqual(beforeCounts.contextTraces);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why command with redacted platform-like trace identifiers while preserving raw turn lookup', () => {
    const now = Date.now();
    const rawEventId = 'evt-qq-123456789';
    const turnId = 'turn-qq-234567890';
    const contextPackId = 'ctx-qq-345678901';
    const conversationId = 'qq-group-456789012';
    const groupId = 'qq-group-567890123';
    const messageRowId = 'msg-qq-678901234';
    const selectedMemoryId = 'mem-qq-789012345';
    const candidateMemoryId = 'mem-qq-890123456';
    const rejectedMemoryId = 'mem-qq-901234567';

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rawEventId,
      'chat.message.received',
      now,
      'gateway',
      'qq',
      conversationId,
      JSON.stringify({ text: 'platform-like trace raw event should not print' }),
      now,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, sender_role, text, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      messageRowId,
      rawEventId,
      'platform-qq-112233445',
      conversationId,
      'group',
      groupId,
      'qq-998877665',
      'member',
      'platform-like trace message text should not print',
      1,
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      turnId,
      conversationId,
      rawEventId,
      contextPackId,
      'mock',
      'mock',
      'completed',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO context_traces (
        id, turn_id, conversation_id, conversation_type, group_id,
        candidate_memory_ids, selected_memory_ids, rejected_memories,
        filters_applied, injected_identity_fields, recent_message_ids,
        token_budget, memories, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      contextPackId,
      turnId,
      conversationId,
      'group',
      groupId,
      JSON.stringify([selectedMemoryId, candidateMemoryId]),
      JSON.stringify([selectedMemoryId]),
      JSON.stringify([{ memoryId: rejectedMemoryId, reason: 'private_only_in_group_context' }]),
      JSON.stringify(['state=active', 'contextType=group']),
      JSON.stringify(['conversation_id', 'conversation_type', 'group_id']),
      JSON.stringify([messageRowId]),
      JSON.stringify({
        max: 8000,
        used: 44,
        breakdown: { recentMessages: 10, memory: 16, identity: 8, system: 10 },
      }),
      JSON.stringify([
        {
          memoryId: selectedMemoryId,
          scope: 'group',
          kind: 'fact',
          title: 'platform-like trace memory title should not print',
          sourceContext: 'test',
        },
      ]),
      now,
    );

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      messages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      traces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const output = expectSuccessfulCli(['why', '--turn', turnId]);

    expect(output).toContain('Context explanation for turn turn-[REDACTED:platform_id]');
    expect(output).toContain('ContextPack: ctx-[REDACTED:platform_id] (stored)');
    expect(output).toContain('Conversation: [REDACTED:platform_id]');
    expect(output).toContain('Conversation type: group');
    expect(output).toContain('Group: [REDACTED:platform_id]');
    expect(output).toContain('Selected memories: mem-[REDACTED:platform_id]');
    expect(output).toContain('Candidate memories: mem-[REDACTED:platform_id], mem-[REDACTED:platform_id]');
    expect(output).toContain('private_only_in_group_context');
    expect(output).toContain('Recent messages: msg-[REDACTED:platform_id]');
    expect(output).toContain('[REDACTED:platform_id]');

    for (const rawValue of [
      rawEventId,
      turnId,
      contextPackId,
      conversationId,
      groupId,
      messageRowId,
      selectedMemoryId,
      candidateMemoryId,
      rejectedMemoryId,
      'qq-998877665',
      'platform-qq-112233445',
    ]) {
      expect(output).not.toContain(rawValue);
    }
    expect(output).not.toContain('platform-like trace raw event should not print');
    expect(output).not.toContain('platform-like trace message text should not print');
    expect(output).not.toContain('platform-like trace memory title should not print');

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      messages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      traces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why command for a group stored context trace with redacted group evidence', () => {
    const now = Date.now();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const groupId = `qq-group-cli-why-${secret}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-why-group',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'qq-group-cli-why',
      JSON.stringify({ text: `group raw event should not print ${secret}` }),
      now,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, sender_role, text, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-cli-why-group',
      'evt-cli-why-group',
      'platform-cli-why-group',
      'qq-group-cli-why',
      'group',
      groupId,
      'qq-cli-why-group-user',
      'member',
      `group message text should not print ${secret}`,
      1,
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-why-group',
      'qq-group-cli-why',
      'evt-cli-why-group',
      'ctx-cli-why-group',
      'mock',
      'mock',
      'completed',
      now,
    );
    db.prepare(
      `INSERT INTO context_traces (
        id, turn_id, conversation_id, conversation_type, group_id,
        candidate_memory_ids, selected_memory_ids, rejected_memories,
        filters_applied, injected_identity_fields, recent_message_ids,
        token_budget, memories, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ctx-cli-why-group',
      'turn-cli-why-group',
      'qq-group-cli-why',
      'group',
      groupId,
      JSON.stringify(['mem-cli-why-group-selected', 'mem-cli-why-private-rejected']),
      JSON.stringify(['mem-cli-why-group-selected']),
      JSON.stringify([
        {
          memoryId: 'mem-cli-why-private-rejected',
          reason: `private_only_in_group_context token=${secret}`,
        },
      ]),
      JSON.stringify(['state=active', 'contextType=group', `api_key=${secret}`]),
      JSON.stringify(['conversation_id', 'conversation_type', 'group_id', `token=${secret}`]),
      JSON.stringify(['msg-cli-why-group']),
      JSON.stringify({
        max: 8000,
        used: 48,
        breakdown: { recentMessages: 11, memory: 17, identity: 8, system: 12 },
      }),
      JSON.stringify([
        {
          memoryId: 'mem-cli-why-group-selected',
          scope: 'group',
          kind: 'fact',
          title: `group stored title should not print ${secret}`,
          sourceContext: 'test',
        },
      ]),
      now,
    );

    const output = expectSuccessfulCli(['why', '--turn', 'turn-cli-why-group']);

    expect(output).toContain('Context explanation for turn turn-cli-why-group');
    expect(output).toContain('ContextPack: ctx-cli-why-group (stored)');
    expect(output).toContain('Conversation: qq-group-cli-why');
    expect(output).toContain('Conversation type: group');
    expect(output).toContain('Group: qq-group-cli-why-[REDACTED:openai_like_api_key]');
    expect(output).toContain('Selected memories: mem-cli-why-group-selected');
    expect(output).toContain('Candidate memories: mem-cli-why-group-selected, mem-cli-why-private-rejected');
    expect(output).toContain('mem-cli-why-private-rejected');
    expect(output).toContain('private_only_in_group_context');
    expect(output).toContain('Recent messages: msg-cli-why-group');
    expect(output).toContain('[REDACTED:');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('group raw event should not print');
    expect(output).not.toContain('group message text should not print');
    expect(output).not.toContain('group stored title should not print');

    reopenDb();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why command without --turn against the latest stored context trace', () => {
    const now = Date.now();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-why-older',
      'chat.message.received',
      now - 20,
      'gateway',
      'qq',
      'private:cli-why-older',
      JSON.stringify({ text: 'older raw event should not print' }),
      now - 20,
    );
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-why-latest',
      'chat.message.received',
      now - 10,
      'gateway',
      'qq',
      'private:cli-why-latest',
      JSON.stringify({ text: `latest raw event should not print ${secret}` }),
      now - 10,
    );

    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-cli-why-older',
      'evt-cli-why-older',
      'platform-cli-why-older',
      'private:cli-why-older',
      'private',
      'qq-cli-why-older',
      'older message text should not print',
      now - 20,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-cli-why-latest',
      'evt-cli-why-latest',
      'platform-cli-why-latest',
      'private:cli-why-latest',
      'private',
      'qq-cli-why-latest',
      `latest message text should not print ${secret}`,
      now - 10,
    );

    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-why-older',
      'private:cli-why-older',
      'evt-cli-why-older',
      'ctx-cli-why-older',
      'mock',
      'mock',
      'completed',
      now - 20,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-why-latest',
      'private:cli-why-latest',
      'evt-cli-why-latest',
      'ctx-cli-why-latest',
      'mock',
      'mock',
      'completed',
      now,
    );

    db.prepare(
      `INSERT INTO context_traces (
        id, turn_id, conversation_id, conversation_type, group_id,
        candidate_memory_ids, selected_memory_ids, rejected_memories,
        filters_applied, injected_identity_fields, recent_message_ids,
        token_budget, memories, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ctx-cli-why-older',
      'turn-cli-why-older',
      'private:cli-why-older',
      'private',
      null,
      JSON.stringify(['mem-cli-why-older-candidate']),
      JSON.stringify(['mem-cli-why-older-selected']),
      JSON.stringify([]),
      JSON.stringify(['state=active']),
      JSON.stringify(['conversation_id']),
      JSON.stringify(['msg-cli-why-older']),
      JSON.stringify({
        max: 8000,
        used: 24,
        breakdown: { recentMessages: 8, memory: 8, identity: 0, system: 8 },
      }),
      JSON.stringify([
        {
          memoryId: 'mem-cli-why-older-selected',
          scope: 'user',
          kind: 'fact',
          title: 'older stored title should not print',
          sourceContext: 'test',
        },
      ]),
      now - 20,
    );
    db.prepare(
      `INSERT INTO context_traces (
        id, turn_id, conversation_id, conversation_type, group_id,
        candidate_memory_ids, selected_memory_ids, rejected_memories,
        filters_applied, injected_identity_fields, recent_message_ids,
        token_budget, memories, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ctx-cli-why-latest',
      'turn-cli-why-latest',
      'private:cli-why-latest',
      'private',
      null,
      JSON.stringify(['mem-cli-why-latest-candidate']),
      JSON.stringify(['mem-cli-why-latest-selected']),
      JSON.stringify([{ memoryId: 'mem-cli-why-latest-rejected', reason: `token=${secret}` }]),
      JSON.stringify(['state=active', `api_key=${secret}`]),
      JSON.stringify(['conversation_id', `token=${secret}`]),
      JSON.stringify(['msg-cli-why-latest']),
      JSON.stringify({
        max: 8000,
        used: 40,
        breakdown: { recentMessages: 10, memory: 14, identity: 6, system: 10 },
      }),
      JSON.stringify([
        {
          memoryId: 'mem-cli-why-latest-selected',
          scope: 'user',
          kind: 'fact',
          title: `latest stored title should not print ${secret}`,
          sourceContext: 'test',
        },
      ]),
      now,
    );

    const output = expectSuccessfulCli(['why']);

    expect(output).toContain('Context explanation for turn turn-cli-why-latest');
    expect(output).toContain('ContextPack: ctx-cli-why-latest (stored)');
    expect(output).toContain('Conversation: private:cli-why-latest');
    expect(output).toContain('Selected memories: mem-cli-why-latest-selected');
    expect(output).toContain('Candidate memories: mem-cli-why-latest-candidate');
    expect(output).toContain('Rejected memories:');
    expect(output).toContain('[REDACTED:');
    expect(output).not.toContain('turn-cli-why-older');
    expect(output).not.toContain('ctx-cli-why-older');
    expect(output).not.toContain('mem-cli-why-older-selected');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('latest message text should not print');
    expect(output).not.toContain('latest stored title should not print');
    expect(output).not.toContain('older message text should not print');
    expect(output).not.toContain('older stored title should not print');

    reopenDb();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why command with rebuilt context trace when no stored trace exists', async () => {
    const now = Date.now();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const identitySecret = 'sk-cli-why-identity-secret-abcdefghijklmnopqrstuvwxyz';
    const rawUser = `api_key=${identitySecret}-qq-1234567890`;
    const redactedMessageRowId = `msg-cli-why-rebuilt-${secret}`;

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      rawUser,
      now,
      now
    );

    const memoryId = await memoryRepo.create({
      id: 'mem-cli-why-rebuilt-selected',
      scope: 'user',
      canonicalUserId: rawUser,
      visibility: 'same_user_any_context',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI rebuilt trace preference',
      content: 'User prefers rebuilt context trace coverage',
      state: 'active',
      confidence: 0.91,
      importance: 0.8,
      sourceContext: 'chat:msg-cli-why-rebuilt-source',
      sources: [
        {
          sourceType: 'chat_message',
          sourceId: 'msg-cli-why-rebuilt-source',
          extractedBy: 'human',
        },
      ],
    });

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-why-rebuilt',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:cli-why-rebuilt',
      JSON.stringify({ text: `rebuilt raw event should not print ${secret}` }),
      now,
    );

    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      redactedMessageRowId,
      'evt-cli-why-rebuilt',
      'platform-cli-why-rebuilt',
      'private:cli-why-rebuilt',
      'private',
      'user-cli',
      `rebuilt message text should not print ${secret}`,
      now,
    );

    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-why-rebuilt',
      'private:cli-why-rebuilt',
      'evt-cli-why-rebuilt',
      'ctx-cli-why-rebuilt-stale',
      'mock',
      'mock',
      'completed',
      now,
    );

    const output = expectSuccessfulCli(['why', '--turn', 'turn-cli-why-rebuilt', '--user', rawUser]);

    expect(output).toContain('Context explanation for turn turn-cli-why-rebuilt');
    expect(output).toContain('(rebuilt)');
    expect(output).toContain('Conversation: private:cli-why-rebuilt');
    expect(output).toContain(`Selected memories: ${memoryId}`);
    expect(output).toContain(`Candidate memories: ${memoryId}`);
    expect(output).toContain('Rejected memories: []');
    expect(output).toContain('Filters: state=active, sensitivity!=secret/prohibited, contextType=private');
    expect(output).toContain('Identity fields: conversation_id, conversation_type, target_user_ref');
    expect(output).toContain('Token budget: used ');
    expect(output).toContain('Token breakdown: recentMessages=');
    expect(output).toMatch(/identity=[1-9]\d*/);
    expect(output).toContain('Prompt layers: recent_messages@pi-prompt-recent-message-v2');
    expect(output).toContain('identity_fields@context-builder-identity-fields-v2=');
    expect(output).toContain('system_prompt_estimate@bounded-system-estimate-v1');
    expect(output).toContain('Recent messages: msg-cli-why-rebuilt-[REDACTED:openai_like_api_key]');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(identitySecret);
    expect(output).not.toContain(rawUser);
    expect(output).not.toContain('api_key=');
    expect(output).not.toContain('qq-1234567890');
    expect(output).not.toContain('1234567890');
    expect(output).not.toContain('rebuilt raw event should not print');
    expect(output).not.toContain('rebuilt message text should not print');
    expect(output).not.toContain('CLI rebuilt trace preference');
    expect(output).not.toContain('User prefers rebuilt context trace coverage');

    reopenDb();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why command with rebuilt context trace for an explicit conversation without a stored turn', async () => {
    const now = Date.now();
    const secret = 'sk-cli-why-conversation-secret-abcdefghijklmnop';
    const identitySecret = 'sk-cli-why-conversation-identity-abcdefghijklmnop';
    const rawUser = `api_key=${identitySecret}-qq-3456789010`;
    const rawConversation = `private:cli-why-conversation-qq-2345678901-${secret}`;
    const redactedMessageRowId = `msg-cli-why-conversation-${secret}`;

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      rawUser,
      now,
      now
    );

    const memoryId = await memoryRepo.create({
      id: 'mem-cli-why-conversation-selected',
      scope: 'user',
      canonicalUserId: rawUser,
      visibility: 'same_user_any_context',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI conversation trace preference',
      content: 'User prefers explicit conversation context traces',
      state: 'active',
      confidence: 0.91,
      importance: 0.8,
      sourceContext: 'chat:msg-cli-why-conversation-source',
      sources: [
        {
          sourceType: 'chat_message',
          sourceId: 'msg-cli-why-conversation-source',
          extractedBy: 'human',
        },
      ],
    });

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-why-conversation',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      rawConversation,
      JSON.stringify({ text: `conversation raw event should not print ${secret}` }),
      now,
    );

    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      redactedMessageRowId,
      'evt-cli-why-conversation',
      'platform-cli-why-conversation',
      rawConversation,
      'private',
      'user-cli',
      `conversation message text should not print ${secret}`,
      now,
    );

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const output = expectSuccessfulCli([
      'why',
      '--conversation',
      rawConversation,
      '--type',
      'private',
      '--user',
      rawUser,
    ]);

    expect(output).toContain('Context explanation for turn governance-cli-why');
    expect(output).toContain('(rebuilt)');
    expect(output).toContain('Conversation type: private');
    expect(output).toContain(`Selected memories: ${memoryId}`);
    expect(output).toContain(`Candidate memories: ${memoryId}`);
    expect(output).toContain('Identity fields: conversation_id, conversation_type, target_user_ref');
    expect(output).toContain('Token budget: used ');
    expect(output).toMatch(/identity=[1-9]\d*/);
    expect(output).toContain('identity_fields@context-builder-identity-fields-v2=');
    expect(output).toContain('Recent messages: msg-cli-why-conversation-[REDACTED:openai_like_api_key]');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(identitySecret);
    expect(output).not.toContain(rawUser);
    expect(output).not.toContain(rawConversation);
    expect(output).not.toContain('api_key=');
    expect(output).not.toContain('qq-2345678901');
    expect(output).not.toContain('qq-3456789010');
    expect(output).not.toContain('2345678901');
    expect(output).not.toContain('3456789010');
    expect(output).not.toContain('conversation raw event should not print');
    expect(output).not.toContain('conversation message text should not print');
    expect(output).not.toContain('CLI conversation trace preference');
    expect(output).not.toContain('User prefers explicit conversation context traces');

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why command with rebuilt context trace for an explicit group conversation', async () => {
    const now = Date.now();
    const secret = 'sk-cli-why-group-conversation-secret-abcdefghijk';
    const identitySecret = 'sk-cli-why-group-identity-abcdefghijklmnop';
    const rawUser = `api_key=${identitySecret}-qq-4567890123`;
    const rawGroup = `qq-group-cli-why-conversation-qq-5678901234-${secret}`;
    const rawConversation = `group:cli-why-conversation-qq-6789012345-${secret}`;
    const redactedMessageRowId = `msg-cli-why-group-conversation-${secret}`;

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      rawUser,
      now,
      now
    );

    const privateMemoryId = await memoryRepo.create({
      id: 'mem-cli-why-group-conversation-private-rejected',
      scope: 'user',
      canonicalUserId: rawUser,
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI group private trace preference',
      content: 'Private memory should not enter group context',
      state: 'active',
      confidence: 0.91,
      importance: 0.9,
      sourceContext: 'chat:msg-cli-why-group-private-source',
      sources: [
        {
          sourceType: 'chat_message',
          sourceId: 'msg-cli-why-group-private-source',
          extractedBy: 'human',
        },
      ],
    });

    const groupMemoryId = await memoryRepo.create({
      id: 'mem-cli-why-group-conversation-selected',
      scope: 'group',
      groupId: rawGroup,
      visibility: 'same_group_only',
      sensitivity: 'normal',
      authority: 'inferred',
      kind: 'summary',
      title: 'CLI group trace summary',
      content: 'Group context should be selected for explicit group why',
      state: 'active',
      confidence: 0.88,
      importance: 0.8,
      sourceContext: 'group_chat:msg-cli-why-group-conversation-source',
      sources: [
        {
          sourceType: 'chat_message',
          sourceId: 'msg-cli-why-group-conversation-source',
          extractedBy: 'human',
        },
      ],
    });

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-why-group-conversation',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      rawConversation,
      JSON.stringify({ text: `group raw event should not print ${secret}` }),
      now,
    );

    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        group_id, sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      redactedMessageRowId,
      'evt-cli-why-group-conversation',
      'platform-cli-why-group-conversation',
      rawConversation,
      'group',
      rawGroup,
      'user-cli',
      `group message text should not print ${secret}`,
      now,
    );

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      memorySources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      memoryRevisions: db.prepare('SELECT * FROM memory_revisions ORDER BY memory_id, revision_number').all(),
    };

    const output = expectSuccessfulCli([
      'why',
      '--conversation',
      rawConversation,
      '--type',
      'group',
      '--group',
      rawGroup,
      '--user',
      rawUser,
    ]);

    expect(output).toContain('Context explanation for turn governance-cli-why');
    expect(output).toContain('(rebuilt)');
    expect(output).toContain('Conversation type: group');
    expect(output).toContain(`Selected memories: ${groupMemoryId}`);
    expect(output).toContain(`Candidate memories: ${privateMemoryId}, ${groupMemoryId}`);
    expect(output).toContain(privateMemoryId);
    expect(output).toContain('private_only_in_group_context');
    expect(output).toContain('Identity fields: conversation_id, conversation_type, group_id, target_user_ref');
    expect(output).toMatch(/identity=[1-9]\d*/);
    expect(output).toContain('identity_fields@context-builder-identity-fields-v2=');
    expect(output).toContain('Recent messages: msg-cli-why-group-conversation-[REDACTED:openai_like_api_key]');
    expect(output).not.toContain(secret);
    expect(output).not.toContain(identitySecret);
    expect(output).not.toContain(rawUser);
    expect(output).not.toContain(rawGroup);
    expect(output).not.toContain(rawConversation);
    expect(output).not.toContain('api_key=');
    expect(output).not.toContain('qq-4567890123');
    expect(output).not.toContain('qq-5678901234');
    expect(output).not.toContain('qq-6789012345');
    expect(output).not.toContain('4567890123');
    expect(output).not.toContain('5678901234');
    expect(output).not.toContain('6789012345');
    expect(output).not.toContain('group raw event should not print');
    expect(output).not.toContain('group message text should not print');
    expect(output).not.toContain('CLI group private trace preference');
    expect(output).not.toContain('Private memory should not enter group context');
    expect(output).not.toContain('CLI group trace summary');
    expect(output).not.toContain('Group context should be selected for explicit group why');

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      memorySources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      memoryRevisions: db.prepare('SELECT * FROM memory_revisions ORDER BY memory_id, revision_number').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why command missing-turn errors without leaking stacks or secret-like IDs', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const missingTurnId = `turn-cli-why-missing-${secret}`;

    const missingTurn = runCli(['why', '--turn', missingTurnId]);

    expect(missingTurn.status).toBe(1);
    expect(missingTurn.stdout).toBe('');
    expect(missingTurn.stderr).toContain('❌ Turn turn-cli-why-missing-[REDACTED:openai_like_api_key] not found');
    expect(missingTurn.stderr).not.toContain(secret);
    expect(missingTurn.stderr).not.toContain('governance.ts');
    expect(missingTurn.stderr).not.toContain('src/cli');
    expect(missingTurn.stderr).not.toContain('Error:');
    expect(missingTurn.stderr).not.toContain('\n    at ');

    const noTurns = runCli(['why']);

    expect(noTurns.status).toBe(1);
    expect(noTurns.stdout).toBe('');
    expect(noTurns.stderr).toBe('❌ No agent turn found');
    expect(noTurns.stderr).not.toContain('governance.ts');
    expect(noTurns.stderr).not.toContain('Error:');
    expect(noTurns.stderr).not.toContain('\n    at ');

    expect(db.prepare('SELECT COUNT(*) as count FROM raw_events').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM chat_messages').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM agent_turns').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM context_traces').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) as count FROM audit_log').get()).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why type validation errors without leaking invalid values or mutating data', () => {
    const secret = 'sk-ijklmnopqrstuvwxyz123456789abcd';
    const invalidType = `group-${secret}-qq-123456789`;
    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const result = runCli([
      'why',
      '--conversation',
      'private:cli-why-invalid-type',
      '--type',
      invalidType,
      '--user',
      'user-cli',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('❌ Invalid conversation type');
    expect(result.stderr).toContain('[REDACTED:');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain('123456789');
    expect(result.stderr).not.toContain('src/cli');
    expect(result.stderr).not.toContain('tests/integration');
    expect(result.stderr).not.toContain('\n    at ');
    expect(result.stderr).not.toContain('TypeError');

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why conversation-only validation errors without using the latest turn or mutating data', () => {
    const now = Date.now();
    const secret = 'sk-jklmnopqrstuvwxyz123456789abcde';
    const sensitiveConversationId = `private:cli-why-missing-type-qq-123456789-${secret}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-why-latest-missing-type',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:cli-why-latest-missing-type',
      JSON.stringify({ text: `latest raw event should not print ${secret}` }),
      now,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-cli-why-latest-missing-type',
      'evt-cli-why-latest-missing-type',
      'platform-cli-why-latest-missing-type',
      'private:cli-why-latest-missing-type',
      'private',
      'user-cli',
      `latest message text should not print ${secret}`,
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-why-latest-missing-type',
      'private:cli-why-latest-missing-type',
      'evt-cli-why-latest-missing-type',
      'ctx-cli-why-latest-missing-type',
      'mock',
      'mock',
      'completed',
      now,
    );
    db.prepare(
      `INSERT INTO context_traces (
        id, turn_id, conversation_id, conversation_type, group_id,
        candidate_memory_ids, selected_memory_ids, rejected_memories,
        filters_applied, injected_identity_fields, recent_message_ids,
        token_budget, memories, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ctx-cli-why-latest-missing-type',
      'turn-cli-why-latest-missing-type',
      'private:cli-why-latest-missing-type',
      'private',
      null,
      JSON.stringify(['mem-cli-why-latest-missing-type-candidate']),
      JSON.stringify(['mem-cli-why-latest-missing-type-selected']),
      JSON.stringify([{ memoryId: 'mem-cli-why-latest-missing-type-rejected', reason: `token=${secret}` }]),
      JSON.stringify(['state=active']),
      JSON.stringify(['conversation_id']),
      JSON.stringify(['msg-cli-why-latest-missing-type']),
      JSON.stringify({
        max: 8000,
        used: 30,
        breakdown: { recentMessages: 8, memory: 10, identity: 4, system: 8 },
      }),
      JSON.stringify([
        {
          memoryId: 'mem-cli-why-latest-missing-type-selected',
          scope: 'user',
          kind: 'fact',
          title: `latest stored title should not print ${secret}`,
          sourceContext: 'test',
        },
      ]),
      now,
    );

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const result = runCli(['why', '--conversation', sensitiveConversationId]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('❌ Conversation type is required when --conversation is provided');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain('123456789');
    expect(result.stderr).not.toContain('turn-cli-why-latest-missing-type');
    expect(result.stderr).not.toContain('ctx-cli-why-latest-missing-type');
    expect(result.stderr).not.toContain('latest message text should not print');
    expect(result.stderr).not.toContain('latest stored title should not print');
    expect(result.stderr).not.toContain('src/cli');
    expect(result.stderr).not.toContain('governance.ts');
    expect(result.stderr).not.toContain('\n    at ');

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why group conversation validation errors without group scope or mutation', () => {
    const secret = 'sk-lmnopqrstuvwxyz123456789abcdefg';
    const sensitiveConversationId = `qq-group-cli-why-missing-group-123456789-${secret}`;
    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const result = runCli([
      'why',
      '--conversation',
      sensitiveConversationId,
      '--type',
      'group',
      '--user',
      'user-cli',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('❌ Group ID is required when --conversation uses --type group');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain('123456789');
    expect(result.stderr).not.toContain('qq-group-cli-why-missing-group');
    expect(result.stderr).not.toContain('governance-cli-why');
    expect(result.stderr).not.toContain('src/cli');
    expect(result.stderr).not.toContain('governance.ts');
    expect(result.stderr).not.toContain('\n    at ');

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why private conversation validation errors with unexpected group scope and no mutation', () => {
    const secret = 'sk-mnopqrstuvwxyz123456789abcdefg';
    const sensitiveConversationId = `private:cli-why-private-with-group-123456789-${secret}`;
    const sensitiveGroupId = `qq-group-cli-why-private-with-group-234567890-${secret}`;
    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const result = runCli([
      'why',
      '--conversation',
      sensitiveConversationId,
      '--type',
      'private',
      '--group',
      sensitiveGroupId,
      '--user',
      'user-cli',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('❌ Group ID is not allowed when --conversation uses --type private');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain('123456789');
    expect(result.stderr).not.toContain('234567890');
    expect(result.stderr).not.toContain('cli-why-private-with-group');
    expect(result.stderr).not.toContain('governance-cli-why');
    expect(result.stderr).not.toContain('src/cli');
    expect(result.stderr).not.toContain('governance.ts');
    expect(result.stderr).not.toContain('\n    at ');

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns why mixed turn and conversation validation errors without using stored traces or mutating data', () => {
    const now = Date.now();
    const secret = 'sk-klmnopqrstuvwxyz123456789abcdef';
    const sensitiveTurnId = `turn-cli-why-mixed-qq-234567890-${secret}`;
    const sensitiveConversationId = `private:cli-why-mixed-other-qq-345678901-${secret}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-why-mixed-turn',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:cli-why-mixed-turn',
      JSON.stringify({ text: `mixed raw event should not print ${secret}` }),
      now,
    );
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-cli-why-mixed-turn',
      'evt-cli-why-mixed-turn',
      'platform-cli-why-mixed-turn',
      'private:cli-why-mixed-turn',
      'private',
      'user-cli',
      `mixed message text should not print ${secret}`,
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sensitiveTurnId,
      'private:cli-why-mixed-turn',
      'evt-cli-why-mixed-turn',
      'ctx-cli-why-mixed-turn',
      'mock',
      'mock',
      'completed',
      now,
    );
    db.prepare(
      `INSERT INTO context_traces (
        id, turn_id, conversation_id, conversation_type, group_id,
        candidate_memory_ids, selected_memory_ids, rejected_memories,
        filters_applied, injected_identity_fields, recent_message_ids,
        token_budget, memories, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'ctx-cli-why-mixed-turn',
      sensitiveTurnId,
      'private:cli-why-mixed-turn',
      'private',
      null,
      JSON.stringify(['mem-cli-why-mixed-candidate']),
      JSON.stringify(['mem-cli-why-mixed-selected']),
      JSON.stringify([{ memoryId: 'mem-cli-why-mixed-rejected', reason: `token=${secret}` }]),
      JSON.stringify(['state=active']),
      JSON.stringify(['conversation_id']),
      JSON.stringify(['msg-cli-why-mixed-turn']),
      JSON.stringify({
        max: 8000,
        used: 30,
        breakdown: { recentMessages: 8, memory: 10, identity: 4, system: 8 },
      }),
      JSON.stringify([
        {
          memoryId: 'mem-cli-why-mixed-selected',
          scope: 'user',
          kind: 'fact',
          title: `mixed stored title should not print ${secret}`,
          sourceContext: 'test',
        },
      ]),
      now,
    );

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const result = runCli([
      'why',
      '--turn',
      sensitiveTurnId,
      '--conversation',
      sensitiveConversationId,
      '--type',
      'private',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('❌ Choose either --turn or --conversation, not both');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain('234567890');
    expect(result.stderr).not.toContain('345678901');
    expect(result.stderr).not.toContain('ctx-cli-why-mixed-turn');
    expect(result.stderr).not.toContain('mixed message text should not print');
    expect(result.stderr).not.toContain('mixed stored title should not print');
    expect(result.stderr).not.toContain('src/cli');
    expect(result.stderr).not.toContain('governance.ts');
    expect(result.stderr).not.toContain('\n    at ');

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      chatMessages: db.prepare('SELECT * FROM chat_messages ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      contextTraces: db.prepare('SELECT * FROM context_traces ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns proposal/delete/restore lifecycle commands with redacted errors and DB evidence', async () => {
    const approveId = await memoryRepo.create({
      id: 'mem-cli-lifecycle-approve',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'inferred',
      kind: 'preference',
      title: 'CLI lifecycle approve proposal',
      content: 'User may prefer approving lifecycle proposals',
      state: 'proposed',
      confidence: 0.72,
      importance: 0.61,
      sourceContext: 'admin_cli',
    });
    const rejectRestoreId = await memoryRepo.create({
      id: 'mem-cli-lifecycle-reject-restore',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'inferred',
      kind: 'preference',
      title: 'CLI lifecycle reject proposal',
      content: 'User may prefer rejecting lifecycle proposals',
      state: 'proposed',
      confidence: 0.71,
      importance: 0.6,
      sourceContext: 'admin_cli',
    });
    const deleteRestoreId = await memoryRepo.create({
      id: 'mem-cli-lifecycle-delete-restore',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'fact',
      title: 'CLI lifecycle delete target',
      content: 'User has a lifecycle delete target',
      state: 'active',
      confidence: 0.88,
      importance: 0.64,
      sourceContext: 'admin_cli',
    });
    const disableEnableId = await memoryRepo.create({
      id: 'mem-cli-lifecycle-disable-enable',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'fact',
      title: 'CLI lifecycle disable target',
      content: 'User has a lifecycle disable target',
      state: 'active',
      confidence: 0.87,
      importance: 0.63,
      sourceContext: 'admin_cli',
    });
    const activeNotRestorableId = await memoryRepo.create({
      id: 'mem-cli-lifecycle-active-not-restorable',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'fact',
      title: 'CLI lifecycle active target',
      content: 'User has an active lifecycle target',
      state: 'active',
      confidence: 0.86,
      importance: 0.62,
      sourceContext: 'admin_cli',
    });

    expect(expectSuccessfulCli(['approve-memory', approveId])).toBe(`✅ Memory ${approveId} approved`);

    const approveAgain = runCli(['approve-memory', approveId]);
    expect(approveAgain.status).toBe(1);
    expect(approveAgain.stdout).toBe('');
    expect(approveAgain.stderr).toContain(`Memory ${approveId} not found or not proposed`);

    expect(expectSuccessfulCli(['reject-memory', rejectRestoreId])).toBe(`✅ Memory ${rejectRestoreId} rejected`);
    expect(expectSuccessfulCli(['restore-memory', rejectRestoreId])).toBe(`✅ Memory ${rejectRestoreId} enabled`);

    expect(expectSuccessfulCli(['delete-memory', deleteRestoreId])).toBe(`✅ Memory ${deleteRestoreId} deleted`);
    expect(expectSuccessfulCli(['restore-memory', deleteRestoreId])).toBe(`✅ Memory ${deleteRestoreId} enabled`);

    expect(expectSuccessfulCli(['disable-memory', disableEnableId])).toBe(`✅ Memory ${disableEnableId} disabled`);
    expect(expectSuccessfulCli(['enable-memory', disableEnableId])).toBe(`✅ Memory ${disableEnableId} enabled`);

    const activeRestore = runCli(['restore-memory', activeNotRestorableId]);
    expect(activeRestore.status).toBe(1);
    expect(activeRestore.stdout).toBe('');
    expect(activeRestore.stderr).toContain(`Memory ${activeNotRestorableId} not found or not restorable`);

    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const missingDelete = runCli(['delete-memory', `missing-${secret}`]);
    expect(missingDelete.status).toBe(1);
    expect(missingDelete.stdout).toBe('');
    expect(missingDelete.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(missingDelete.stderr).toContain('not found');
    expect(missingDelete.stderr).not.toContain(secret);

    const missingApprove = runCli(['approve-memory', `missing-${secret}`]);
    expect(missingApprove.status).toBe(1);
    expect(missingApprove.stdout).toBe('');
    expect(missingApprove.stderr).toContain('[REDACTED:openai_like_api_key]');
    expect(missingApprove.stderr).toContain('not found or not proposed');
    expect(missingApprove.stderr).not.toContain(secret);

    reopenDb();
    const stateRows = db
      .prepare(
        `SELECT id, state FROM memory_records
         WHERE id IN (?, ?, ?, ?, ?)
         ORDER BY id ASC`
      )
      .all(approveId, rejectRestoreId, deleteRestoreId, disableEnableId, activeNotRestorableId) as Array<{
        id: string;
        state: string;
      }>;
    const states = Object.fromEntries(stateRows.map((row) => [row.id, row.state]));

    const revisionTypes = (memoryId: string): string[] =>
      (
        db
          .prepare('SELECT change_type FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
          .all(memoryId) as Array<{ change_type: string }>
      ).map((row) => row.change_type);
    const auditEventTypes = (memoryId: string): string[] =>
      (
        db
          .prepare(
            `SELECT event_type FROM audit_log
             WHERE category = 'memory' AND event_id = ?
             ORDER BY timestamp ASC, id ASC`
          )
          .all(memoryId) as Array<{ event_type: string }>
      ).map((row) => row.event_type);

    expect(states).toMatchObject({
      [approveId]: 'active',
      [rejectRestoreId]: 'active',
      [deleteRestoreId]: 'active',
      [disableEnableId]: 'active',
      [activeNotRestorableId]: 'active',
    });
    expect(revisionTypes(approveId)).toEqual(['create', 'approve']);
    expect(revisionTypes(rejectRestoreId)).toEqual(['create', 'reject', 'restore']);
    expect(revisionTypes(deleteRestoreId)).toEqual(['create', 'delete', 'restore']);
    expect(revisionTypes(disableEnableId)).toEqual(['create', 'disable', 'restore']);
    expect(revisionTypes(activeNotRestorableId)).toEqual(['create']);
    expect(auditEventTypes(approveId)).toEqual(['memory.create', 'memory.approve']);
    expect(auditEventTypes(rejectRestoreId)).toEqual(['memory.create', 'memory.reject', 'memory.restore']);
    expect(auditEventTypes(deleteRestoreId)).toEqual(['memory.create', 'memory.delete', 'memory.restore']);
    expect(auditEventTypes(disableEnableId)).toEqual(['memory.create', 'memory.disable', 'memory.restore']);
    expect(auditEventTypes(activeNotRestorableId)).toEqual(['memory.create']);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns memory lifecycle with redacted durable audit summary and details', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const memoryId = `legacy_qq-123456789_${secret}`;

    await memoryRepo.create({
      id: memoryId,
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'fact',
      title: 'CLI lifecycle durable audit target',
      content: 'User has a lifecycle durable audit target',
      state: 'active',
      confidence: 0.88,
      importance: 0.64,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'cli-lifecycle-durable-audit-source',
        },
      ],
    });

    const stdout = expectSuccessfulCli(['delete-memory', memoryId]);
    expect(stdout).toContain('✅ Memory');
    expect(stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain('123456789');

    const auditRows = db
      .prepare(
        `SELECT event_type, event_id, summary, details, redacted
         FROM audit_log
         WHERE category = 'memory' AND event_id = ?
         ORDER BY timestamp ASC, id ASC`
      )
      .all(memoryId) as Array<{
        event_type: string;
        event_id: string;
        summary: string;
        details: string;
        redacted: number;
      }>;

    expect(auditRows.map((row) => row.event_type)).toEqual(['memory.create', 'memory.delete']);
    for (const row of auditRows) {
      expect(row.event_id).toBe(memoryId);
      expect(row.redacted).toBe(1);

      const details = JSON.parse(row.details) as Record<string, unknown>;
      const serializedAuditBody = `${row.summary}\n${JSON.stringify(details)}`;
      expect(serializedAuditBody).toContain('[REDACTED:openai_like_api_key]');
      expect(serializedAuditBody).toContain('[REDACTED:platform_id]');
      expect(serializedAuditBody).not.toContain(secret);
      expect(serializedAuditBody).not.toContain('123456789');
    }

    const displayedAudit = JSON.parse(
      expectSuccessfulCli(['list-audit', '--event-id', memoryId, '--include-details'])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: Record<string, unknown>;
    }>;
    const serializedDisplayedAudit = JSON.stringify(displayedAudit);
    expect(serializedDisplayedAudit).toContain('[REDACTED:openai_like_api_key]');
    expect(serializedDisplayedAudit).toContain('[REDACTED:platform_id]');
    expect(serializedDisplayedAudit).not.toContain(secret);
    expect(serializedDisplayedAudit).not.toContain('123456789');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns enable-memory with redacted durable restore audit summary and details', async () => {
    const secret = 'sk-bcdefghijklmnopqrstuvwxyz1234567';
    const memoryId = `legacy_qq-223456789_${secret}`;

    await memoryRepo.create({
      id: memoryId,
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'fact',
      title: 'CLI enable durable audit target',
      content: 'User has an enable lifecycle durable audit target',
      state: 'disabled',
      confidence: 0.86,
      importance: 0.62,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'cli-enable-durable-audit-source',
        },
      ],
    });

    const stdout = expectSuccessfulCli(['enable-memory', memoryId]);
    expect(stdout).toContain('✅ Memory');
    expect(stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain('223456789');

    reopenDb();
    const state = db
      .prepare('SELECT state FROM memory_records WHERE id = ?')
      .get(memoryId) as { state: string };
    const revisionRows = db
      .prepare('SELECT change_type, reason FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
      .all(memoryId) as Array<{ change_type: string; reason: string }>;
    const auditRows = db
      .prepare(
        `SELECT event_type, event_id, summary, details, redacted
         FROM audit_log
         WHERE category = 'memory' AND event_id = ?
         ORDER BY timestamp ASC, id ASC`
      )
      .all(memoryId) as Array<{
        event_type: string;
        event_id: string;
        summary: string;
        details: string;
        redacted: number;
      }>;

    expect(state.state).toBe('active');
    expect(revisionRows.map((row) => row.change_type)).toEqual(['create', 'restore']);
    expect(revisionRows[1]?.reason).toBe('Governance CLI restore memory');
    expect(auditRows.map((row) => row.event_type)).toEqual(['memory.create', 'memory.restore']);

    const restoreAudit = auditRows.find((row) => row.event_type === 'memory.restore');
    expect(restoreAudit).toBeDefined();
    if (!restoreAudit) {
      throw new Error('Expected spawned CLI enable-memory restore audit row');
    }
    expect(JSON.parse(restoreAudit.details) as Record<string, unknown>).toMatchObject({
      previousState: 'disabled',
      newState: 'active',
      revisionNumber: 2,
    });

    for (const row of auditRows) {
      expect(row.event_id).toBe(memoryId);
      expect(row.redacted).toBe(1);

      const details = JSON.parse(row.details) as Record<string, unknown>;
      const serializedAuditBody = `${row.summary}\n${JSON.stringify(details)}`;
      expect(serializedAuditBody).toContain('[REDACTED:openai_like_api_key]');
      expect(serializedAuditBody).toContain('[REDACTED:platform_id]');
      expect(serializedAuditBody).not.toContain(secret);
      expect(serializedAuditBody).not.toContain('223456789');
    }

    const displayedAudit = JSON.parse(
      expectSuccessfulCli(['list-audit', '--event-id', memoryId, '--include-details'])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: Record<string, unknown>;
    }>;
    const serializedDisplayedAudit = JSON.stringify(displayedAudit);
    expect(serializedDisplayedAudit).toContain('[REDACTED:openai_like_api_key]');
    expect(serializedDisplayedAudit).toContain('[REDACTED:platform_id]');
    expect(serializedDisplayedAudit).not.toContain(secret);
    expect(serializedDisplayedAudit).not.toContain('223456789');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns approve/reject memory proposals with redacted durable audit summary and details', async () => {
    const approveSecret = 'sk-cdefghijklmnopqrstuvwxyz1234567';
    const rejectSecret = 'sk-defghijklmnopqrstuvwxyz12345678';
    const approveId = `legacy_qq-323456789_${approveSecret}`;
    const rejectId = `legacy_qq-423456789_${rejectSecret}`;

    await memoryRepo.create({
      id: approveId,
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'inferred',
      kind: 'preference',
      title: 'CLI approve durable audit target',
      content: 'User may approve a durable audit target',
      state: 'proposed',
      confidence: 0.74,
      importance: 0.61,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'cli-approve-durable-audit-source',
        },
      ],
    });
    await memoryRepo.create({
      id: rejectId,
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'inferred',
      kind: 'preference',
      title: 'CLI reject durable audit target',
      content: 'User may reject a durable audit target',
      state: 'proposed',
      confidence: 0.73,
      importance: 0.6,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'cli-reject-durable-audit-source',
        },
      ],
    });

    const approveStdout = expectSuccessfulCli(['approve-memory', approveId]);
    const rejectStdout = expectSuccessfulCli(['reject-memory', rejectId]);
    const serializedStdout = `${approveStdout}\n${rejectStdout}`;
    expect(serializedStdout).toContain('[REDACTED:openai_like_api_key]');
    expect(serializedStdout).toContain('[REDACTED:platform_id]');
    expect(serializedStdout).not.toContain(approveSecret);
    expect(serializedStdout).not.toContain(rejectSecret);
    expect(serializedStdout).not.toContain('323456789');
    expect(serializedStdout).not.toContain('423456789');

    reopenDb();
    const states = Object.fromEntries(
      (db
        .prepare('SELECT id, state FROM memory_records WHERE id IN (?, ?) ORDER BY id ASC')
        .all(approveId, rejectId) as Array<{ id: string; state: string }>)
        .map((row) => [row.id, row.state])
    );
    const revisionTypes = (memoryId: string): string[] =>
      (
        db
          .prepare('SELECT change_type FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
          .all(memoryId) as Array<{ change_type: string }>
      ).map((row) => row.change_type);
    const auditRowsFor = (memoryId: string): Array<{
      event_type: string;
      event_id: string;
      summary: string;
      details: string;
      redacted: number;
    }> =>
      db
        .prepare(
          `SELECT event_type, event_id, summary, details, redacted
           FROM audit_log
           WHERE category = 'memory' AND event_id = ?
           ORDER BY timestamp ASC, id ASC`
        )
        .all(memoryId) as Array<{
        event_type: string;
        event_id: string;
        summary: string;
        details: string;
        redacted: number;
      }>;

    expect(states).toMatchObject({
      [approveId]: 'active',
      [rejectId]: 'rejected',
    });
    expect(revisionTypes(approveId)).toEqual(['create', 'approve']);
    expect(revisionTypes(rejectId)).toEqual(['create', 'reject']);

    const approveAuditRows = auditRowsFor(approveId);
    const rejectAuditRows = auditRowsFor(rejectId);
    expect(approveAuditRows.map((row) => row.event_type)).toEqual(['memory.create', 'memory.approve']);
    expect(rejectAuditRows.map((row) => row.event_type)).toEqual(['memory.create', 'memory.reject']);

    for (const [memoryId, secret, numericFragment, rows] of [
      [approveId, approveSecret, '323456789', approveAuditRows],
      [rejectId, rejectSecret, '423456789', rejectAuditRows],
    ] as const) {
      for (const row of rows) {
        expect(row.event_id).toBe(memoryId);
        expect(row.redacted).toBe(1);

        const details = JSON.parse(row.details) as Record<string, unknown>;
        const serializedAuditBody = `${row.summary}\n${JSON.stringify(details)}`;
        expect(serializedAuditBody).toContain('[REDACTED:openai_like_api_key]');
        expect(serializedAuditBody).toContain('[REDACTED:platform_id]');
        expect(serializedAuditBody).not.toContain(secret);
        expect(serializedAuditBody).not.toContain(numericFragment);
      }

      const displayedAudit = JSON.parse(
        expectSuccessfulCli(['list-audit', '--event-id', memoryId, '--include-details'])
      ) as Array<{
        eventId: string;
        summary: string;
        details?: Record<string, unknown>;
      }>;
      const serializedDisplayedAudit = JSON.stringify(displayedAudit);
      expect(serializedDisplayedAudit).toContain('[REDACTED:openai_like_api_key]');
      expect(serializedDisplayedAudit).toContain('[REDACTED:platform_id]');
      expect(serializedDisplayedAudit).not.toContain(secret);
      expect(serializedDisplayedAudit).not.toContain(numericFragment);
    }

    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns disable-memory with redacted durable audit summary and details', async () => {
    const secret = 'sk-efghijklmnopqrstuvwxyz123456789';
    const memoryId = `legacy_qq-523456789_${secret}`;

    await memoryRepo.create({
      id: memoryId,
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'fact',
      title: 'CLI disable durable audit target',
      content: 'User has a disable lifecycle durable audit target',
      state: 'active',
      confidence: 0.87,
      importance: 0.63,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'cli-disable-durable-audit-source',
        },
      ],
    });

    const stdout = expectSuccessfulCli(['disable-memory', memoryId]);
    expect(stdout).toContain('✅ Memory');
    expect(stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain('523456789');

    reopenDb();
    const state = db
      .prepare('SELECT state FROM memory_records WHERE id = ?')
      .get(memoryId) as { state: string };
    const revisionRows = db
      .prepare('SELECT change_type, reason FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
      .all(memoryId) as Array<{ change_type: string; reason: string }>;
    const auditRows = db
      .prepare(
        `SELECT event_type, event_id, summary, details, redacted
         FROM audit_log
         WHERE category = 'memory' AND event_id = ?
         ORDER BY timestamp ASC, id ASC`
      )
      .all(memoryId) as Array<{
        event_type: string;
        event_id: string;
        summary: string;
        details: string;
        redacted: number;
      }>;

    expect(state.state).toBe('disabled');
    expect(revisionRows.map((row) => row.change_type)).toEqual(['create', 'disable']);
    expect(revisionRows[1]?.reason).toBe('Governance CLI disable memory');
    expect(auditRows.map((row) => row.event_type)).toEqual(['memory.create', 'memory.disable']);

    const disableAudit = auditRows.find((row) => row.event_type === 'memory.disable');
    expect(disableAudit).toBeDefined();
    if (!disableAudit) {
      throw new Error('Expected spawned CLI disable-memory audit row');
    }
    expect(JSON.parse(disableAudit.details) as Record<string, unknown>).toMatchObject({
      previousState: 'active',
      newState: 'disabled',
      revisionNumber: 2,
    });

    for (const row of auditRows) {
      expect(row.event_id).toBe(memoryId);
      expect(row.redacted).toBe(1);

      const details = JSON.parse(row.details) as Record<string, unknown>;
      const serializedAuditBody = `${row.summary}\n${JSON.stringify(details)}`;
      expect(serializedAuditBody).toContain('[REDACTED:openai_like_api_key]');
      expect(serializedAuditBody).toContain('[REDACTED:platform_id]');
      expect(serializedAuditBody).not.toContain(secret);
      expect(serializedAuditBody).not.toContain('523456789');
    }

    const displayedAudit = JSON.parse(
      expectSuccessfulCli(['list-audit', '--event-id', memoryId, '--include-details'])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: Record<string, unknown>;
    }>;
    const serializedDisplayedAudit = JSON.stringify(displayedAudit);
    expect(serializedDisplayedAudit).toContain('[REDACTED:openai_like_api_key]');
    expect(serializedDisplayedAudit).toContain('[REDACTED:platform_id]');
    expect(serializedDisplayedAudit).not.toContain(secret);
    expect(serializedDisplayedAudit).not.toContain('523456789');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns restore-memory with redacted durable audit summary and details', async () => {
    const secret = 'sk-fghijklmnopqrstuvwxyz123456789a';
    const memoryId = `legacy_qq-623456789_${secret}`;

    await memoryRepo.create({
      id: memoryId,
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'fact',
      title: 'CLI restore durable audit target',
      content: 'User has a restore lifecycle durable audit target',
      state: 'deleted',
      confidence: 0.86,
      importance: 0.62,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'cli-restore-durable-audit-source',
        },
      ],
    });

    const stdout = expectSuccessfulCli(['restore-memory', memoryId]);
    expect(stdout).toContain('✅ Memory');
    expect(stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain('623456789');

    reopenDb();
    const state = db
      .prepare('SELECT state FROM memory_records WHERE id = ?')
      .get(memoryId) as { state: string };
    const revisionRows = db
      .prepare('SELECT change_type, reason FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
      .all(memoryId) as Array<{ change_type: string; reason: string }>;
    const auditRows = db
      .prepare(
        `SELECT event_type, event_id, summary, details, redacted
         FROM audit_log
         WHERE category = 'memory' AND event_id = ?
         ORDER BY timestamp ASC, id ASC`
      )
      .all(memoryId) as Array<{
        event_type: string;
        event_id: string;
        summary: string;
        details: string;
        redacted: number;
      }>;

    expect(state.state).toBe('active');
    expect(revisionRows.map((row) => row.change_type)).toEqual(['create', 'restore']);
    expect(revisionRows[1]?.reason).toBe('Governance CLI restore memory');
    expect(auditRows.map((row) => row.event_type)).toEqual(['memory.create', 'memory.restore']);

    const restoreAudit = auditRows.find((row) => row.event_type === 'memory.restore');
    expect(restoreAudit).toBeDefined();
    if (!restoreAudit) {
      throw new Error('Expected spawned CLI restore-memory audit row');
    }
    expect(JSON.parse(restoreAudit.details) as Record<string, unknown>).toMatchObject({
      previousState: 'deleted',
      newState: 'active',
      revisionNumber: 2,
    });

    for (const row of auditRows) {
      expect(row.event_id).toBe(memoryId);
      expect(row.redacted).toBe(1);

      const details = JSON.parse(row.details) as Record<string, unknown>;
      const serializedAuditBody = `${row.summary}\n${JSON.stringify(details)}`;
      expect(serializedAuditBody).toContain('[REDACTED:openai_like_api_key]');
      expect(serializedAuditBody).toContain('[REDACTED:platform_id]');
      expect(serializedAuditBody).not.toContain(secret);
      expect(serializedAuditBody).not.toContain('623456789');
    }

    const displayedAudit = JSON.parse(
      expectSuccessfulCli(['list-audit', '--event-id', memoryId, '--include-details'])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: Record<string, unknown>;
    }>;
    const serializedDisplayedAudit = JSON.stringify(displayedAudit);
    expect(serializedDisplayedAudit).toContain('[REDACTED:openai_like_api_key]');
    expect(serializedDisplayedAudit).toContain('[REDACTED:platform_id]');
    expect(serializedDisplayedAudit).not.toContain(secret);
    expect(serializedDisplayedAudit).not.toContain('623456789');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns supersede-memory with redacted durable revision and audit details', async () => {
    const oldSecret = 'sk-ghijklmnopqrstuvwxyz123456789ab';
    const replacementSecret = 'sk-hijklmnopqrstuvwxyz123456789abc';
    const reviewSecret = 'sk-ijklmnopqrstuvwxyz123456789abcd';
    const oldMemoryId = `legacy_qq-723456789_${oldSecret}`;
    const replacementMemoryId = `legacy_qq-823456789_${replacementSecret}`;
    const reviewAuditId = `audit-cli-supersede_qq-923456789_${reviewSecret}`;

    await memoryRepo.create({
      id: oldMemoryId,
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI supersede durable audit old target',
      content: 'User prefers an old durable supersede target',
      state: 'active',
      confidence: 0.81,
      importance: 0.66,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'cli-supersede-durable-audit-old-source',
        },
      ],
    });
    await memoryRepo.create({
      id: replacementMemoryId,
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI supersede durable audit replacement target',
      content: 'User prefers a replacement durable supersede target',
      state: 'active',
      confidence: 0.86,
      importance: 0.7,
      sourceContext: 'admin_cli',
      sources: [
        {
          sourceType: 'user_command',
          sourceId: 'cli-supersede-durable-audit-replacement-source',
        },
      ],
    });
    insertMemoryReviewAudit(reviewAuditId, [oldMemoryId, replacementMemoryId], {
      summary: `Review worker approved supersede for qq-923456789 ${reviewSecret}`,
      extraDetails: {
        reviewMarker: `review marker ${reviewSecret}`,
      },
    });

    const stdout = expectSuccessfulCli([
      'supersede-memory',
      oldMemoryId,
      replacementMemoryId,
      '--review-audit',
      reviewAuditId,
    ]);
    expect(stdout).toContain('✅ Memory');
    expect(stdout).toContain('superseded by');
    expect(stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(oldSecret);
    expect(stdout).not.toContain(replacementSecret);
    expect(stdout).not.toContain(reviewSecret);
    expect(stdout).not.toContain('723456789');
    expect(stdout).not.toContain('823456789');
    expect(stdout).not.toContain('923456789');

    reopenDb();
    const states = Object.fromEntries(
      (db
        .prepare('SELECT id, state FROM memory_records WHERE id IN (?, ?) ORDER BY id ASC')
        .all(oldMemoryId, replacementMemoryId) as Array<{ id: string; state: string }>)
        .map((row) => [row.id, row.state])
    );
    const revisionRows = db
      .prepare('SELECT change_type, reason FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
      .all(oldMemoryId) as Array<{ change_type: string; reason: string }>;
    const auditRows = db
      .prepare(
        `SELECT event_type, event_id, summary, details, redacted
         FROM audit_log
         WHERE category = 'memory' AND event_id = ?
         ORDER BY timestamp ASC, id ASC`
      )
      .all(oldMemoryId) as Array<{
        event_type: string;
        event_id: string;
        summary: string;
        details: string;
        redacted: number;
      }>;

    expect(states).toMatchObject({
      [oldMemoryId]: 'superseded',
      [replacementMemoryId]: 'active',
    });
    expect(revisionRows.map((row) => row.change_type)).toEqual(['create', 'supersede']);
    expect(revisionRows[1]?.reason).toContain('[REDACTED:openai_like_api_key]');
    expect(revisionRows[1]?.reason).toContain('[REDACTED:platform_id]');
    expect(revisionRows[1]?.reason).not.toContain(replacementSecret);
    expect(revisionRows[1]?.reason).not.toContain(reviewSecret);
    expect(revisionRows[1]?.reason).not.toContain('823456789');
    expect(revisionRows[1]?.reason).not.toContain('923456789');

    expect(auditRows.map((row) => row.event_type)).toEqual(['memory.create', 'memory.supersede']);
    const supersedeAudit = auditRows.find((row) => row.event_type === 'memory.supersede');
    expect(supersedeAudit).toBeDefined();
    if (!supersedeAudit) {
      throw new Error('Expected spawned CLI supersede-memory audit row');
    }
    expect(JSON.parse(supersedeAudit.details) as Record<string, unknown>).toMatchObject({
      replacementMemoryId: expect.stringContaining('[REDACTED:platform_id]'),
      reviewAuditId: expect.stringContaining('[REDACTED:platform_id]'),
      reviewEventType: 'memory.consolidation.candidates_detected',
      governedReviewApproval: true,
    });

    for (const row of auditRows) {
      expect(row.event_id).toBe(oldMemoryId);
      expect(row.redacted).toBe(1);

      const details = JSON.parse(row.details) as Record<string, unknown>;
      const serializedAuditBody = `${row.summary}\n${JSON.stringify(details)}`;
      expect(serializedAuditBody).toContain('[REDACTED:openai_like_api_key]');
      expect(serializedAuditBody).toContain('[REDACTED:platform_id]');
      expect(serializedAuditBody).not.toContain(oldSecret);
      expect(serializedAuditBody).not.toContain(replacementSecret);
      expect(serializedAuditBody).not.toContain(reviewSecret);
      expect(serializedAuditBody).not.toContain('723456789');
      expect(serializedAuditBody).not.toContain('823456789');
      expect(serializedAuditBody).not.toContain('923456789');
    }

    const displayedAudit = JSON.parse(
      expectSuccessfulCli(['list-audit', '--event-id', oldMemoryId, '--include-details'])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: Record<string, unknown>;
    }>;
    const serializedDisplayedAudit = JSON.stringify(displayedAudit);
    expect(serializedDisplayedAudit).toContain('[REDACTED:openai_like_api_key]');
    expect(serializedDisplayedAudit).toContain('[REDACTED:platform_id]');
    expect(serializedDisplayedAudit).not.toContain(oldSecret);
    expect(serializedDisplayedAudit).not.toContain(replacementSecret);
    expect(serializedDisplayedAudit).not.toContain(reviewSecret);
    expect(serializedDisplayedAudit).not.toContain('723456789');
    expect(serializedDisplayedAudit).not.toContain('823456789');
    expect(serializedDisplayedAudit).not.toContain('923456789');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns reviewed supersede-memory and records revision/audit evidence', async () => {
    const oldMemoryId = await memoryRepo.create({
      id: 'mem-cli-supersede-old',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI supersede preference',
      content: 'User prefers old CLI behavior',
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    const replacementMemoryId = await memoryRepo.create({
      id: 'mem-cli-supersede-new',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI supersede preference',
      content: 'User prefers new CLI behavior',
      state: 'active',
      confidence: 0.85,
      importance: 0.75,
      sourceContext: 'admin_cli',
    });
    insertMemoryReviewAudit('audit-cli-reviewed-supersede', [oldMemoryId, replacementMemoryId]);

    const stdout = expectSuccessfulCli([
      'supersede-memory',
      oldMemoryId,
      replacementMemoryId,
      '--review-audit',
      'audit-cli-reviewed-supersede',
    ]);

    expect(stdout).toContain(`Memory ${oldMemoryId} superseded by ${replacementMemoryId}`);

    reopenDb();
    const oldState = db
      .prepare('SELECT state FROM memory_records WHERE id = ?')
      .get(oldMemoryId) as { state: string };
    const replacementState = db
      .prepare('SELECT state FROM memory_records WHERE id = ?')
      .get(replacementMemoryId) as { state: string };
    const revisionRows = db
      .prepare('SELECT change_type, reason FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
      .all(oldMemoryId) as Array<{ change_type: string; reason: string }>;
    const supersedeAudit = db
      .prepare(
        `SELECT summary, details
         FROM audit_log
         WHERE category = 'memory' AND event_id = ? AND event_type = 'memory.supersede'`
      )
      .get(oldMemoryId) as { summary: string; details: string } | undefined;

    expect(oldState.state).toBe('superseded');
    expect(replacementState.state).toBe('active');
    expect(revisionRows.map((row) => row.change_type)).toEqual(['create', 'supersede']);
    expect(revisionRows[1]?.reason).toBe(
      `Governance CLI supersede memory with ${replacementMemoryId} reviewed by audit-cli-reviewed-supersede`
    );
    expect(supersedeAudit).toBeDefined();
    if (!supersedeAudit) {
      throw new Error('Expected spawned CLI supersede audit row');
    }
    expect(supersedeAudit.summary).toContain('reviewed by audit-cli-reviewed-supersede');
    expect(JSON.parse(supersedeAudit.details) as Record<string, unknown>).toMatchObject({
      replacementMemoryId,
      reviewAuditId: 'audit-cli-reviewed-supersede',
      reviewEventType: 'memory.consolidation.candidates_detected',
      governedReviewApproval: true,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns supersede-memory rejection across unsafe boundaries without mutation', async () => {
    const oldMemoryId = await memoryRepo.create({
      id: 'mem-cli-supersede-boundary-old',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI unsafe old',
      content: 'User prefers one unsafe boundary',
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    const replacementMemoryId = await memoryRepo.create({
      id: 'mem-cli-supersede-boundary-new',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'fact',
      title: 'CLI unsafe replacement',
      content: 'User has a different kind boundary',
      state: 'active',
      confidence: 0.85,
      importance: 0.75,
      sourceContext: 'admin_cli',
    });

    const result = runCli(['supersede-memory', oldMemoryId, replacementMemoryId]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot supersede memory across different kind boundaries');

    reopenDb();
    const oldState = db
      .prepare('SELECT state FROM memory_records WHERE id = ?')
      .get(oldMemoryId) as { state: string };
    const revisionRows = db
      .prepare('SELECT change_type FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
      .all(oldMemoryId) as Array<{ change_type: string }>;
    const supersedeAuditCount = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_log
         WHERE category = 'memory' AND event_id = ? AND event_type = 'memory.supersede'`
      )
      .get(oldMemoryId) as { count: number };

    expect(oldState.state).toBe('active');
    expect(revisionRows.map((row) => row.change_type)).toEqual(['create']);
    expect(supersedeAuditCount.count).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns reviewed supersede-memory rejection for invalid review audits without mutation', async () => {
    const oldMemoryId = await memoryRepo.create({
      id: 'mem-cli-supersede-review-old',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI review invalid old',
      content: 'User prefers one reviewed value',
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    const replacementMemoryId = await memoryRepo.create({
      id: 'mem-cli-supersede-review-new',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI review invalid replacement',
      content: 'User prefers another reviewed value',
      state: 'active',
      confidence: 0.85,
      importance: 0.75,
      sourceContext: 'admin_cli',
    });
    insertMemoryReviewAudit('audit-cli-supersede-review-mismatch', [oldMemoryId, 'mem-other']);
    insertMemoryDecayReviewAudit('audit-cli-supersede-review-wrong-event', [oldMemoryId, replacementMemoryId]);

    expectFailedCli(
      [
        'supersede-memory',
        oldMemoryId,
        replacementMemoryId,
        '--review-audit',
        'audit-cli-supersede-review-missing',
      ],
      'Review audit audit-cli-supersede-review-missing not found'
    );
    expectFailedCli(
      [
        'supersede-memory',
        oldMemoryId,
        replacementMemoryId,
        '--review-audit',
        'audit-cli-supersede-review-wrong-event',
      ],
      'Review audit audit-cli-supersede-review-wrong-event is not a supported memory review event'
    );
    expectFailedCli(
      [
        'supersede-memory',
        oldMemoryId,
        replacementMemoryId,
        '--review-audit',
        'audit-cli-supersede-review-mismatch',
      ],
      'Review audit audit-cli-supersede-review-mismatch does not reference both memory records'
    );

    reopenDb();
    const stateRows = db
      .prepare('SELECT id, state FROM memory_records WHERE id IN (?, ?) ORDER BY id ASC')
      .all(oldMemoryId, replacementMemoryId) as Array<{ id: string; state: string }>;
    const states = Object.fromEntries(stateRows.map((row) => [row.id, row.state]));
    const oldRevisions = db
      .prepare('SELECT change_type FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
      .all(oldMemoryId) as Array<{ change_type: string }>;
    const supersedeAuditCount = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_log
         WHERE category = 'memory' AND event_id = ? AND event_type = 'memory.supersede'`
      )
      .get(oldMemoryId) as { count: number };

    expect(states).toMatchObject({
      [oldMemoryId]: 'active',
      [replacementMemoryId]: 'active',
    });
    expect(oldRevisions.map((row) => row.change_type)).toEqual(['create']);
    expect(supersedeAuditCount.count).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns list-memory-reviews with memory filter and redacted details', async () => {
    const oldMemoryId = await memoryRepo.create({
      id: 'mem-cli-review-list-old',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI review list old',
      content: 'User prefers old review list behavior',
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    const replacementMemoryId = await memoryRepo.create({
      id: 'mem-cli-review-list-new',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI review list new',
      content: 'User prefers new review list behavior',
      state: 'active',
      confidence: 0.85,
      importance: 0.75,
      sourceContext: 'admin_cli',
    });
    const unrelatedMemoryId = await memoryRepo.create({
      id: 'mem-cli-review-list-unrelated',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI unrelated review list',
      content: 'User has unrelated review list behavior',
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    insertMemoryReviewAudit('audit-cli-review-list-match', [oldMemoryId, replacementMemoryId], {
      summary: `summary contains token=${secret}`,
      extraDetails: {
        note: `details contain api_key=${secret}`,
      },
    });
    insertMemoryReviewAudit('audit-cli-review-list-unrelated', [unrelatedMemoryId, 'mem-other']);

    const stdout = expectSuccessfulCli([
      'list-memory-reviews',
      '--memory',
      oldMemoryId,
      '--include-details',
    ]);
    const rows = JSON.parse(stdout) as Array<{
      auditId: string;
      eventType: string;
      status: string;
      candidateCount: number;
      memoryIdGroups: string[][];
      resolutionAuditIds: string[];
      supersededMemoryIds: string[];
      replacementMemoryIds: string[];
      disabledMemoryIds: string[];
      details?: unknown;
    }>;

    expect(rows).toEqual([
      expect.objectContaining({
        auditId: 'audit-cli-review-list-match',
        eventType: 'memory.consolidation.candidates_detected',
        status: 'unresolved',
        candidateCount: 1,
        memoryIdGroups: [[oldMemoryId, replacementMemoryId]],
        resolutionAuditIds: [],
        supersededMemoryIds: [],
        replacementMemoryIds: [],
        disabledMemoryIds: [],
      }),
    ]);
    expect(stdout).not.toContain(secret);
    expect(stdout).toContain('[REDACTED');

    const unresolvedSummary = JSON.parse(expectSuccessfulCli([
      'summarize-memory-reviews',
      '--memory',
      oldMemoryId,
      '--status',
      'unresolved',
    ])) as {
      total: number;
      resolved: number;
      unresolved: number;
      candidateGroups: number;
      memoryReferences: number;
      byEventType: Array<{
        eventType: string;
        total: number;
        unresolved: number;
      }>;
    };

    expect(unresolvedSummary).toMatchObject({
      total: 1,
      resolved: 0,
      unresolved: 1,
      candidateGroups: 1,
      memoryReferences: 2,
    });
    expect(unresolvedSummary.byEventType).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'memory.consolidation.candidates_detected',
          total: 1,
          unresolved: 1,
        }),
      ])
    );
    expect(JSON.stringify(unresolvedSummary)).not.toContain(secret);

    expectSuccessfulCli([
      'supersede-memory',
      oldMemoryId,
      replacementMemoryId,
      '--review-audit',
      'audit-cli-review-list-match',
    ]);

    const resolvedRows = JSON.parse(expectSuccessfulCli([
      'list-memory-reviews',
      '--memory',
      oldMemoryId,
      '--status',
      'resolved',
    ])) as Array<{
      auditId: string;
      status: string;
      resolutionAuditIds: string[];
      supersededMemoryIds: string[];
      replacementMemoryIds: string[];
      disabledMemoryIds: string[];
    }>;
    const unresolvedRows = JSON.parse(expectSuccessfulCli([
      'list-memory-reviews',
      '--memory',
      oldMemoryId,
      '--status',
      'unresolved',
    ])) as unknown[];

    expect(resolvedRows).toHaveLength(1);
    expect(resolvedRows[0]).toMatchObject({
      auditId: 'audit-cli-review-list-match',
      status: 'resolved',
      supersededMemoryIds: [oldMemoryId],
      replacementMemoryIds: [replacementMemoryId],
      disabledMemoryIds: [],
    });
    expect(resolvedRows[0]?.resolutionAuditIds).toHaveLength(1);
    expect(unresolvedRows).toEqual([]);

    const resolvedSummary = JSON.parse(expectSuccessfulCli([
      'summarize-memory-reviews',
      '--memory',
      oldMemoryId,
      '--status',
      'resolved',
    ])) as {
      total: number;
      resolved: number;
      unresolved: number;
      resolutionAuditCount: number;
      supersededMemoryCount: number;
      replacementMemoryCount: number;
    };

    expect(resolvedSummary).toMatchObject({
      total: 1,
      resolved: 1,
      unresolved: 0,
      resolutionAuditCount: 1,
      supersededMemoryCount: 1,
      replacementMemoryCount: 1,
    });

    reopenDb();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns memory review filter validation errors without leaking invalid values or mutating data', () => {
    const secret = 'sk-fghijklmnopqrstuvwxyz123456789ab';
    const platformIds = ['qq-123456789', 'qq-234567890', 'qq-345678901', 'qq-456789012'] as const;
    const beforeCounts = {
      audit: (db.prepare('SELECT COUNT(*) AS count FROM audit_log').get() as { count: number }).count,
      revisions: (db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get() as { count: number }).count,
      memories: (db.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number }).count,
    };

    const invalidListStatus = runCli([
      'list-memory-reviews',
      '--status',
      `bogus-${secret}-${platformIds[0]}`,
    ]);
    const invalidListEventType = runCli([
      'list-memory-reviews',
      '--event-type',
      `memory.decay.candidates_detected-${secret}-${platformIds[1]}`,
    ]);
    const invalidSummaryEventType = runCli([
      'summarize-memory-reviews',
      '--event-type',
      `memory.conflict.detected-${secret}-${platformIds[2]}`,
    ]);
    const invalidSummaryStatus = runCli([
      'summarize-memory-reviews',
      '--status',
      `resolved-${secret}-${platformIds[3]}`,
    ]);

    for (const result of [
      invalidListStatus,
      invalidListEventType,
      invalidSummaryEventType,
      invalidSummaryStatus,
    ]) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('❌ Invalid memory review');
      expect(result.stderr).toContain('[REDACTED:');
      expect(result.stderr).toContain('[REDACTED:platform_id]');
      expect(result.stderr).not.toContain(secret);
      for (const platformId of platformIds) {
        expect(result.stderr).not.toContain(platformId);
      }
      expect(result.stderr).not.toContain('123456789');
      expect(result.stderr).not.toContain('234567890');
      expect(result.stderr).not.toContain('345678901');
      expect(result.stderr).not.toContain('456789012');
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('\n    at ');
      expect(result.stderr).not.toContain('TypeError');
    }
    expect(invalidListStatus.stderr).toContain('Invalid memory review status');
    expect(invalidListEventType.stderr).toContain('Invalid memory review event type');
    expect(invalidSummaryEventType.stderr).toContain('Invalid memory review event type');
    expect(invalidSummaryStatus.stderr).toContain('Invalid memory review status');

    reopenDb();
    const afterCounts = {
      audit: (db.prepare('SELECT COUNT(*) AS count FROM audit_log').get() as { count: number }).count,
      revisions: (db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get() as { count: number }).count,
      memories: (db.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number }).count,
    };
    expect(afterCounts).toEqual(beforeCounts);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns memory review display with redacted memory identifiers while preserving raw filters', () => {
    const now = Date.now();
    const secret = 'sk-ghijklmnopqrstuvwxyz123456789abc';
    const reviewAuditId = `audit-cli-review-${secret}-qq-123456789`;
    const resolutionAuditId = `audit-cli-review-resolution-${secret}-qq-234567890`;
    const oldMemoryId = `mem-cli-review-old-${secret}-qq-345678901`;
    const replacementMemoryId = `mem-cli-review-new-${secret}-qq-456789012`;

    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      reviewAuditId,
      now,
      'memory',
      'redacted_full',
      'memory.consolidation.candidates_detected',
      `job-${reviewAuditId}`,
      'system_worker',
      'background_worker',
      `review summary contains token=${secret}`,
      JSON.stringify({
        groups: [
          {
            memoryIds: [oldMemoryId, replacementMemoryId],
            titleHash: 'spawned-review-title-hash',
            contentHash: 'spawned-review-content-hash',
          },
        ],
        redaction: 'memory_ids_title_hashes_content_hashes_and_counts_only',
      }),
      1,
      'medium',
      resolutionAuditId,
      now + 1,
      'memory',
      'redacted_full',
      'memory.supersede',
      oldMemoryId,
      'admin',
      'admin_cli',
      `resolution summary contains token=${secret}`,
      JSON.stringify({
        reviewAuditId,
        replacementMemoryId,
        governedReviewApproval: true,
      }),
      1,
      'medium'
    );

    const beforeRows = db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all();
    const rows = JSON.parse(expectSuccessfulCli([
      'list-memory-reviews',
      '--memory',
      oldMemoryId,
      '--status',
      'resolved',
      '--include-details',
    ])) as Array<{
      auditId: string;
      eventId: string;
      status: string;
      memoryIdGroups: string[][];
      resolutionAuditIds: string[];
      supersededMemoryIds: string[];
      replacementMemoryIds: string[];
      details?: unknown;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'resolved',
    });
    expect(JSON.stringify(rows[0]?.memoryIdGroups)).toContain('[REDACTED:');
    expect(JSON.stringify(rows[0]?.resolutionAuditIds)).toContain('[REDACTED:');
    expect(JSON.stringify(rows[0]?.supersededMemoryIds)).toContain('[REDACTED:');
    expect(JSON.stringify(rows[0]?.replacementMemoryIds)).toContain('[REDACTED:');

    const summary = JSON.parse(expectSuccessfulCli([
      'summarize-memory-reviews',
      '--memory',
      oldMemoryId,
      '--status',
      'resolved',
    ])) as {
      filters: { memoryId?: string; status?: string };
      total: number;
      resolved: number;
      unresolved: number;
    };

    expect(summary).toMatchObject({
      filters: {
        status: 'resolved',
      },
      total: 1,
      resolved: 1,
      unresolved: 0,
    });
    expect(summary.filters.memoryId).toContain('[REDACTED:');

    const serialized = `${JSON.stringify(rows)}\n${JSON.stringify(summary)}`;
    expect(serialized).toContain('[REDACTED:');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain('234567890');
    expect(serialized).not.toContain('345678901');
    expect(serialized).not.toContain('456789012');
    expect(serialized).not.toContain(reviewAuditId);
    expect(serialized).not.toContain(resolutionAuditId);
    expect(serialized).not.toContain(oldMemoryId);
    expect(serialized).not.toContain(replacementMemoryId);

    reopenDb();
    const afterRows = db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all();
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns summarize-memory-reviews filter variants without leaking details or mutating memory', async () => {
    const oldMemoryId = await memoryRepo.create({
      id: 'mem-cli-review-summary-old',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI review summary old',
      content: 'User prefers old review summary behavior',
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    const replacementMemoryId = await memoryRepo.create({
      id: 'mem-cli-review-summary-new',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI review summary new',
      content: 'User prefers new review summary behavior',
      state: 'active',
      confidence: 0.85,
      importance: 0.75,
      sourceContext: 'admin_cli',
    });
    const unrelatedOldMemoryId = await memoryRepo.create({
      id: 'mem-cli-review-summary-unrelated-old',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI unrelated summary old',
      content: 'User has unrelated summary behavior',
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    const unrelatedNewMemoryId = await memoryRepo.create({
      id: 'mem-cli-review-summary-unrelated-new',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI unrelated summary new',
      content: 'User has unrelated replacement summary behavior',
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    const decayMemoryId = await memoryRepo.create({
      id: 'mem-cli-review-summary-decay',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'inferred',
      kind: 'preference',
      title: 'CLI review summary decay',
      content: 'User has unrelated decay summary behavior',
      state: 'active',
      confidence: 0.4,
      importance: 0.2,
      sourceContext: 'background_worker',
    });
    const secret = 'sk-cdefghijklmnopqrstuvwxyz12345678';

    insertMemoryReviewAudit('audit-cli-review-summary-conflict', [oldMemoryId, replacementMemoryId], {
      eventType: 'memory.conflict.detected',
      summary: `conflict summary contains token=${secret}`,
      extraDetails: {
        diagnostic: `conflict details contain api_key=${secret}`,
      },
    });
    insertMemoryReviewAudit(
      'audit-cli-review-summary-consolidation-distractor',
      [unrelatedOldMemoryId, unrelatedNewMemoryId],
      {
        summary: 'distractor consolidation summary should not affect filtered count',
      }
    );
    insertMemoryDecayReviewAudit('audit-cli-review-summary-decay-distractor', [decayMemoryId]);

    const stdout = expectSuccessfulCli([
      'summarize-memory-reviews',
      '--event-type',
      'memory.conflict.detected',
      '--memory',
      oldMemoryId,
      '--status',
      'unresolved',
    ]);
    const summary = JSON.parse(stdout) as {
      filters: {
        eventType?: string;
        memoryId?: string;
        status?: string;
      };
      total: number;
      resolved: number;
      unresolved: number;
      candidateGroups: number;
      memoryReferences: number;
      resolutionAuditCount: number;
      supersededMemoryCount: number;
      replacementMemoryCount: number;
      disabledMemoryCount: number;
      byEventType: Array<{
        eventType: string;
        total: number;
        resolved: number;
        unresolved: number;
        candidateGroups: number;
        memoryReferences: number;
      }>;
    };

    expect(summary).toMatchObject({
      filters: {
        eventType: 'memory.conflict.detected',
        memoryId: oldMemoryId,
        status: 'unresolved',
      },
      total: 1,
      resolved: 0,
      unresolved: 1,
      candidateGroups: 1,
      memoryReferences: 2,
      resolutionAuditCount: 0,
      supersededMemoryCount: 0,
      replacementMemoryCount: 0,
      disabledMemoryCount: 0,
    });
    expect(summary.byEventType).toEqual([
      expect.objectContaining({
        eventType: 'memory.conflict.detected',
        total: 1,
        resolved: 0,
        unresolved: 1,
        candidateGroups: 1,
        memoryReferences: 2,
      }),
    ]);

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('conflict summary contains');
    expect(serialized).not.toContain('conflict details contain');
    expect(serialized).not.toContain('memory.consolidation.candidates_detected');
    expect(serialized).not.toContain('memory.decay.candidates_detected');
    expect(serialized).not.toContain(unrelatedOldMemoryId);
    expect(serialized).not.toContain(unrelatedNewMemoryId);
    expect(serialized).not.toContain(decayMemoryId);

    reopenDb();
    const stateRows = db
      .prepare('SELECT id, state FROM memory_records WHERE id IN (?, ?, ?, ?, ?) ORDER BY id ASC')
      .all(
        oldMemoryId,
        replacementMemoryId,
        unrelatedOldMemoryId,
        unrelatedNewMemoryId,
        decayMemoryId
      ) as Array<{ id: string; state: string }>;
    const revisionRows = db
      .prepare(
        `SELECT memory_id, change_type
         FROM memory_revisions
         WHERE memory_id IN (?, ?, ?, ?, ?)
         ORDER BY memory_id ASC, revision_number ASC`
      )
      .all(
        oldMemoryId,
        replacementMemoryId,
        unrelatedOldMemoryId,
        unrelatedNewMemoryId,
        decayMemoryId
      ) as Array<{ memory_id: string; change_type: string }>;
    const mutationAuditCount = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_log
         WHERE category = 'memory'
           AND event_type IN ('memory.supersede', 'memory.disable')
           AND event_id IN (?, ?, ?, ?, ?)`
      )
      .get(
        oldMemoryId,
        replacementMemoryId,
        unrelatedOldMemoryId,
        unrelatedNewMemoryId,
        decayMemoryId
      ) as { count: number };

    expect(stateRows).toEqual([
      { id: decayMemoryId, state: 'active' },
      { id: replacementMemoryId, state: 'active' },
      { id: oldMemoryId, state: 'active' },
      { id: unrelatedNewMemoryId, state: 'active' },
      { id: unrelatedOldMemoryId, state: 'active' },
    ]);
    expect(revisionRows).toEqual([
      { memory_id: decayMemoryId, change_type: 'create' },
      { memory_id: replacementMemoryId, change_type: 'create' },
      { memory_id: oldMemoryId, change_type: 'create' },
      { memory_id: unrelatedNewMemoryId, change_type: 'create' },
      { memory_id: unrelatedOldMemoryId, change_type: 'create' },
    ]);
    expect(mutationAuditCount.count).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns memory review filters with assignment-shaped memory identifiers without leaking raw keys', async () => {
    const assignment = 'api_key=sk-cli-review-filter-secret-qq-135792468';
    const dynamicDetailKey = `review_${assignment}`;
    const nestedDynamicDetailKey = `nested_${assignment}`;
    const oldMemoryId = `mem-cli-review-filter-old-${assignment}`;
    const replacementMemoryId = `mem-cli-review-filter-new-${assignment}`;
    const distractorMemoryId = 'mem-cli-review-filter-distractor';

    await memoryRepo.create({
      id: oldMemoryId,
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI review assignment filter old',
      content: 'User prefers old assignment filter behavior',
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    await memoryRepo.create({
      id: replacementMemoryId,
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI review assignment filter new',
      content: 'User prefers new assignment filter behavior',
      state: 'active',
      confidence: 0.85,
      importance: 0.75,
      sourceContext: 'admin_cli',
    });
    await memoryRepo.create({
      id: distractorMemoryId,
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI review assignment distractor',
      content: 'User has unrelated assignment filter behavior',
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });

    insertMemoryReviewAudit(
      'audit-cli-review-assignment-filter',
      [oldMemoryId, replacementMemoryId],
      {
        eventType: 'memory.conflict.detected',
        summary: 'assignment-shaped memory review filter summary',
        extraDetails: {
          operatorNote: `operator pasted ${assignment}`,
          [dynamicDetailKey]: `operator pasted dynamic detail value ${assignment}`,
          nestedDetails: {
            [nestedDynamicDetailKey]: {
              targetUserId: 135792468,
              note: `nested operator note ${assignment}`,
            },
          },
        },
      }
    );
    insertMemoryReviewAudit(
      'audit-cli-review-assignment-distractor',
      [distractorMemoryId],
      {
        eventType: 'memory.consolidation.candidates_detected',
        summary: 'assignment-shaped memory review distractor summary',
      }
    );

    const beforeRows = {
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const listStdout = expectSuccessfulCli([
      'list-memory-reviews',
      '--memory',
      oldMemoryId,
      '--include-details',
    ]);
    const summaryStdout = expectSuccessfulCli([
      'summarize-memory-reviews',
      '--memory',
      oldMemoryId,
    ]);

    const listRows = JSON.parse(listStdout) as Array<{
      eventType: string;
      memoryIdGroups: string[][];
      details?: Record<string, unknown>;
    }>;
    const summary = JSON.parse(summaryStdout) as {
      filters: { memoryId?: string };
      total: number;
      byEventType: Array<{ eventType: string; total: number }>;
    };

    expect(listRows).toHaveLength(1);
    expect(listRows[0]).toMatchObject({
      eventType: 'memory.conflict.detected',
    });
    expect(listRows[0]?.memoryIdGroups.flat().join('\n')).toContain('[REDACTED:api_key_assignment]');
    expect(listRows[0]?.memoryIdGroups.flat().join('\n')).toContain('[REDACTED:platform_id]');
    const detailsJson = JSON.stringify(listRows[0]?.details);
    expect(detailsJson).toContain('[REDACTED:api_key_assignment]');
    expect(detailsJson).toContain('[REDACTED:platform_id]');
    expect(detailsJson).not.toContain(dynamicDetailKey);
    expect(detailsJson).not.toContain(nestedDynamicDetailKey);
    expect(detailsJson).not.toContain('sk-cli-review-filter-secret');
    expect(detailsJson).not.toContain('qq-135792468');
    expect(detailsJson).not.toContain('135792468');
    expect(summary.filters.memoryId).toContain('[REDACTED:api_key_assignment]');
    expect(summary.filters.memoryId).toContain('[REDACTED:platform_id]');
    expect(summary.total).toBe(1);
    expect(summary.byEventType.find((entry) => entry.eventType === 'memory.conflict.detected')?.total).toBe(1);
    expect(
      summary.byEventType.find((entry) => entry.eventType === 'memory.consolidation.candidates_detected')?.total
    ).toBe(0);

    const serialized = `${listStdout}\n${summaryStdout}`;
    expect(serialized).toContain('[REDACTED:api_key_assignment]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(assignment);
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-cli-review-filter-secret');
    expect(serialized).not.toContain('qq-135792468');
    expect(serialized).not.toContain('135792468');
    expect(serialized).not.toContain(distractorMemoryId);

    reopenDb();
    const afterRows = {
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      sources: db.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns list-memory-reviews filters beyond the default prefilter window without mutating memory', async () => {
    const oldMemoryId = await memoryRepo.create({
      id: 'mem-cli-review-deep-filter-old',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI deep filter old',
      content: 'User prefers old deep filter behavior',
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    const replacementMemoryId = await memoryRepo.create({
      id: 'mem-cli-review-deep-filter-new',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI deep filter new',
      content: 'User prefers new deep filter behavior',
      state: 'active',
      confidence: 0.85,
      importance: 0.75,
      sourceContext: 'admin_cli',
    });
    const baseTimestamp = Date.now() - 10_000;

    insertMemoryReviewAudit('audit-cli-review-deep-filter-target', [oldMemoryId, replacementMemoryId], {
      timestamp: baseTimestamp,
    });
    for (let index = 0; index < 1001; index += 1) {
      insertMemoryReviewAudit(
        `audit-cli-review-deep-filter-distractor-${index.toString().padStart(4, '0')}`,
        [`mem-cli-review-deep-filter-distractor-old-${index}`, `mem-cli-review-deep-filter-distractor-new-${index}`],
        {
          timestamp: baseTimestamp + index + 1,
        }
      );
    }

    const rows = JSON.parse(expectSuccessfulCli([
      'list-memory-reviews',
      '--memory',
      oldMemoryId,
      '--status',
      'unresolved',
      '--limit',
      '1',
    ])) as Array<{
      auditId: string;
      status: string;
      memoryIdGroups: string[][];
    }>;

    expect(rows).toEqual([
      expect.objectContaining({
        auditId: 'audit-cli-review-deep-filter-target',
        status: 'unresolved',
        memoryIdGroups: [[oldMemoryId, replacementMemoryId]],
      }),
    ]);

    reopenDb();
    const stateRows = db
      .prepare('SELECT id, state FROM memory_records WHERE id IN (?, ?) ORDER BY id ASC')
      .all(oldMemoryId, replacementMemoryId) as Array<{ id: string; state: string }>;
    const mutationAuditCount = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_log
         WHERE category = 'memory'
           AND event_type IN ('memory.supersede', 'memory.disable')
           AND event_id IN (?, ?)`
      )
      .get(oldMemoryId, replacementMemoryId) as { count: number };

    expect(stateRows).toEqual([
      { id: replacementMemoryId, state: 'active' },
      { id: oldMemoryId, state: 'active' },
    ]);
    expect(mutationAuditCount.count).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns summarize-memory-reviews filters beyond the default prefilter window without mutating memory', async () => {
    const oldMemoryId = await memoryRepo.create({
      id: 'mem-cli-review-deep-summary-old',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI deep summary old',
      content: 'User prefers old deep summary behavior',
      state: 'active',
      confidence: 0.8,
      importance: 0.7,
      sourceContext: 'admin_cli',
    });
    const replacementMemoryId = await memoryRepo.create({
      id: 'mem-cli-review-deep-summary-new',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'CLI deep summary new',
      content: 'User prefers new deep summary behavior',
      state: 'active',
      confidence: 0.85,
      importance: 0.75,
      sourceContext: 'admin_cli',
    });
    const baseTimestamp = Date.now() - 10_000;

    insertMemoryReviewAudit('audit-cli-review-deep-summary-target', [oldMemoryId, replacementMemoryId], {
      eventType: 'memory.conflict.detected',
      timestamp: baseTimestamp,
    });
    for (let index = 0; index < 1001; index += 1) {
      insertMemoryReviewAudit(
        `audit-cli-review-deep-summary-distractor-${index.toString().padStart(4, '0')}`,
        [`mem-cli-review-deep-summary-distractor-old-${index}`, `mem-cli-review-deep-summary-distractor-new-${index}`],
        {
          summary: 'distractor summary should not affect filtered totals',
          timestamp: baseTimestamp + index + 1,
        }
      );
    }

    const summary = JSON.parse(expectSuccessfulCli([
      'summarize-memory-reviews',
      '--event-type',
      'memory.conflict.detected',
      '--memory',
      oldMemoryId,
      '--status',
      'unresolved',
    ])) as {
      filters: {
        eventType?: string;
        memoryId?: string;
        status?: string;
      };
      total: number;
      resolved: number;
      unresolved: number;
      candidateGroups: number;
      memoryReferences: number;
      resolutionAuditCount: number;
      byEventType: Array<{
        eventType: string;
        total: number;
        unresolved: number;
        memoryReferences: number;
      }>;
    };

    expect(summary).toMatchObject({
      filters: {
        eventType: 'memory.conflict.detected',
        memoryId: oldMemoryId,
        status: 'unresolved',
      },
      total: 1,
      resolved: 0,
      unresolved: 1,
      candidateGroups: 1,
      memoryReferences: 2,
      resolutionAuditCount: 0,
    });
    expect(summary.byEventType).toEqual([
      expect.objectContaining({
        eventType: 'memory.conflict.detected',
        total: 1,
        unresolved: 1,
        memoryReferences: 2,
      }),
    ]);

    reopenDb();
    const stateRows = db
      .prepare('SELECT id, state FROM memory_records WHERE id IN (?, ?) ORDER BY id ASC')
      .all(oldMemoryId, replacementMemoryId) as Array<{ id: string; state: string }>;
    const mutationAuditCount = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_log
         WHERE category = 'memory'
           AND event_type IN ('memory.supersede', 'memory.disable')
           AND event_id IN (?, ?)`
      )
      .get(oldMemoryId, replacementMemoryId) as { count: number };

    expect(stateRows).toEqual([
      { id: replacementMemoryId, state: 'active' },
      { id: oldMemoryId, state: 'active' },
    ]);
    expect(mutationAuditCount.count).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns disable-memory with decay review approval and records revision/audit evidence', async () => {
    const memoryId = await memoryRepo.create({
      id: 'mem-cli-decay-disable',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'inferred',
      kind: 'preference',
      title: 'CLI decay candidate',
      content: 'User used to prefer a stale low-score behavior',
      state: 'active',
      confidence: 0.4,
      importance: 0.2,
      sourceContext: 'background_worker',
    });
    insertMemoryDecayReviewAudit('audit-cli-decay-disable', [memoryId]);

    const unresolvedBefore = JSON.parse(expectSuccessfulCli([
      'list-memory-reviews',
      '--event-type',
      'memory.decay.candidates_detected',
      '--memory',
      memoryId,
      '--status',
      'unresolved',
    ])) as Array<{
      auditId: string;
      eventType: string;
      status: string;
      memoryIdGroups: string[][];
      disabledMemoryIds: string[];
    }>;
    expect(unresolvedBefore).toEqual([
      expect.objectContaining({
        auditId: 'audit-cli-decay-disable',
        eventType: 'memory.decay.candidates_detected',
        status: 'unresolved',
        memoryIdGroups: [[memoryId]],
        disabledMemoryIds: [],
      }),
    ]);

    const stdout = expectSuccessfulCli([
      'disable-memory',
      memoryId,
      '--decay-review-audit',
      'audit-cli-decay-disable',
    ]);

    expect(stdout).toContain(`Memory ${memoryId} disabled`);

    const resolvedAfter = JSON.parse(expectSuccessfulCli([
      'list-memory-reviews',
      '--event-type',
      'memory.decay.candidates_detected',
      '--memory',
      memoryId,
      '--status',
      'resolved',
    ])) as Array<{
      auditId: string;
      status: string;
      resolutionAuditIds: string[];
      disabledMemoryIds: string[];
    }>;
    const unresolvedAfter = JSON.parse(expectSuccessfulCli([
      'list-memory-reviews',
      '--event-type',
      'memory.decay.candidates_detected',
      '--memory',
      memoryId,
      '--status',
      'unresolved',
    ])) as unknown[];

    expect(resolvedAfter).toHaveLength(1);
    expect(resolvedAfter[0]).toMatchObject({
      auditId: 'audit-cli-decay-disable',
      status: 'resolved',
      disabledMemoryIds: [memoryId],
    });
    expect(resolvedAfter[0]?.resolutionAuditIds).toHaveLength(1);
    expect(unresolvedAfter).toEqual([]);

    reopenDb();
    const memory = db
      .prepare('SELECT state FROM memory_records WHERE id = ?')
      .get(memoryId) as { state: string };
    const revisionRows = db
      .prepare('SELECT change_type, reason FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC')
      .all(memoryId) as Array<{ change_type: string; reason: string }>;
    const disableAudit = db
      .prepare(
        `SELECT summary, details
         FROM audit_log
         WHERE category = 'memory' AND event_id = ? AND event_type = 'memory.disable'`
      )
      .get(memoryId) as { summary: string; details: string } | undefined;

    expect(memory.state).toBe('disabled');
    expect(revisionRows.map((row) => row.change_type)).toEqual(['create', 'disable']);
    expect(revisionRows[1]?.reason).toBe(
      'Governance CLI disable memory from decay review audit-cli-decay-disable'
    );
    expect(disableAudit).toBeDefined();
    if (!disableAudit) {
      throw new Error('Expected spawned CLI decay disable audit row');
    }
    expect(disableAudit.summary).toBe(
      `Governance CLI disabled memory ${memoryId} from decay review audit-cli-decay-disable`
    );
    expect(JSON.parse(disableAudit.details) as Record<string, unknown>).toMatchObject({
      memoryId,
      decayReviewAuditId: 'audit-cli-decay-disable',
      reviewEventType: 'memory.decay.candidates_detected',
      governedDecayApproval: true,
      previousState: 'active',
      newState: 'disabled',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns decay-reviewed disable rejection for invalid audits and blocked memory without mutation', async () => {
    const memoryId = await memoryRepo.create({
      id: 'mem-cli-decay-invalid',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'inferred',
      kind: 'preference',
      title: 'CLI invalid decay candidate',
      content: 'User has an invalid decay review candidate',
      state: 'active',
      confidence: 0.4,
      importance: 0.2,
      sourceContext: 'background_worker',
    });
    const blockedMemoryId = await memoryRepo.create({
      id: 'mem-cli-decay-blocked',
      scope: 'user',
      canonicalUserId: 'user-cli',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'inferred',
      kind: 'preference',
      title: 'CLI blocked decay candidate',
      content: 'User has a blocked decay review candidate',
      state: 'active',
      confidence: 0.4,
      importance: 0.2,
      sourceContext: 'background_worker',
    });

    db
      .prepare('UPDATE memory_records SET sensitivity = ? WHERE id = ?')
      .run('secret', blockedMemoryId);
    insertMemoryReviewAudit('audit-cli-decay-wrong-event', [memoryId]);
    insertMemoryDecayReviewAudit('audit-cli-decay-mismatch', ['mem-other']);
    insertMemoryDecayReviewAudit('audit-cli-decay-blocked', [blockedMemoryId]);

    expectFailedCli(
      [
        'disable-memory',
        memoryId,
        '--decay-review-audit',
        'audit-cli-decay-missing',
      ],
      'Decay review audit audit-cli-decay-missing not found'
    );
    expectFailedCli(
      [
        'disable-memory',
        memoryId,
        '--decay-review-audit',
        'audit-cli-decay-wrong-event',
      ],
      'Decay review audit audit-cli-decay-wrong-event is not a memory decay review event'
    );
    expectFailedCli(
      [
        'disable-memory',
        memoryId,
        '--decay-review-audit',
        'audit-cli-decay-mismatch',
      ],
      `Decay review audit audit-cli-decay-mismatch does not reference memory ${memoryId}`
    );
    expectFailedCli(
      [
        'disable-memory',
        blockedMemoryId,
        '--decay-review-audit',
        'audit-cli-decay-blocked',
      ],
      `Memory ${blockedMemoryId} has blocked sensitivity secret`
    );

    reopenDb();
    const states = Object.fromEntries(
      (db
        .prepare('SELECT id, state FROM memory_records WHERE id IN (?, ?)')
        .all(memoryId, blockedMemoryId) as Array<{ id: string; state: string }>)
        .map((row) => [row.id, row.state])
    );
    const sensitivities = Object.fromEntries(
      (db
        .prepare('SELECT id, sensitivity FROM memory_records WHERE id IN (?, ?)')
        .all(memoryId, blockedMemoryId) as Array<{ id: string; sensitivity: string }>)
        .map((row) => [row.id, row.sensitivity])
    );
    const revisionRows = db
      .prepare('SELECT memory_id, change_type FROM memory_revisions WHERE memory_id IN (?, ?) ORDER BY memory_id ASC, revision_number ASC')
      .all(memoryId, blockedMemoryId) as Array<{ memory_id: string; change_type: string }>;
    const disableAuditCount = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM audit_log
         WHERE category = 'memory'
           AND event_id IN (?, ?)
           AND event_type = 'memory.disable'`
      )
      .get(memoryId, blockedMemoryId) as { count: number };

    expect(states).toMatchObject({
      [memoryId]: 'active',
      [blockedMemoryId]: 'active',
    });
    expect(sensitivities).toMatchObject({
      [memoryId]: 'normal',
      [blockedMemoryId]: 'secret',
    });
    expect(revisionRows).toEqual([
      { memory_id: blockedMemoryId, change_type: 'create' },
      { memory_id: memoryId, change_type: 'create' },
    ]);
    expect(disableAuditCount.count).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns privacy opt-out set/list/clear commands', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const now = Date.now();
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-cli-other',
      now,
      now
    );

    expectSuccessfulCli([
      'set-privacy-opt-out',
      'user-cli',
      'proactive_dm',
      '--reason',
      `spawn parser test ${secret}`,
    ]);
    expectSuccessfulCli([
      'set-privacy-opt-out',
      'user-cli-other',
      'memory_association',
      '--reason',
      'spawn parser test other user',
    ]);

    const optedOut = JSON.parse(expectSuccessfulCli(['list-privacy-preferences', '--user', 'user-cli'])) as Array<{
      canonicalUserId: string;
      preferenceType: string;
      state: string;
      reason?: string;
    }>;
    expect(optedOut).toEqual([
      expect.objectContaining({
        canonicalUserId: 'user-cli',
        preferenceType: 'proactive_dm',
        state: 'opted_out',
        reason: expect.stringContaining('[REDACTED:'),
      }),
    ]);
    expect(JSON.stringify(optedOut)).not.toContain(secret);

    const filteredOptOuts = JSON.parse(expectSuccessfulCli([
      'list-privacy-preferences',
      '--type',
      'proactive_dm',
      '--state',
      'opted_out',
    ])) as Array<{
      canonicalUserId: string;
      preferenceType: string;
      state: string;
      reason?: string;
    }>;
    expect(filteredOptOuts).toEqual([
      expect.objectContaining({
        canonicalUserId: 'user-cli',
        preferenceType: 'proactive_dm',
        state: 'opted_out',
        reason: expect.stringContaining('[REDACTED:'),
      }),
    ]);
    expect(JSON.stringify(filteredOptOuts)).not.toContain(secret);

    expectSuccessfulCli([
      'clear-privacy-opt-out',
      'user-cli',
      'proactive_dm',
      '--reason',
      'spawn parser test clear',
    ]);

    const optedIn = JSON.parse(expectSuccessfulCli(['list-privacy-preferences', '--user', 'user-cli'])) as Array<{
      preferenceType: string;
      state: string;
    }>;
    expect(optedIn).toEqual([
      expect.objectContaining({
        preferenceType: 'proactive_dm',
        state: 'opted_in',
      }),
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns privacy preference filter variants without cross-returning hidden reasons', () => {
    const now = Date.now();
    const secret = 'sk-ghijklmnopqrstuvwxyz123456789ab';
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?), (?, ?, ?)').run(
      'user-cli-privacy-alpha',
      now,
      now,
      'user-cli-privacy-beta',
      now,
      now
    );
    db.prepare(
      `INSERT INTO privacy_preferences (
        canonical_user_id, preference_type, state, reason,
        updated_by_user_id, updated_by_actor_class, updated_by_context,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'user-cli-privacy-alpha',
      'proactive_dm',
      'opted_out',
      `alpha proactive secret ${secret} qq-123456789`,
      'admin',
      'admin',
      'admin_cli',
      now,
      now + 1,
      'user-cli-privacy-alpha',
      'memory_association',
      'opted_out',
      `alpha memory secret ${secret} qq-234567890`,
      'admin',
      'admin',
      'admin_cli',
      now,
      now + 2,
      'user-cli-privacy-beta',
      'proactive_dm',
      'opted_in',
      `beta proactive secret ${secret} qq-345678901`,
      'admin',
      'admin',
      'admin_cli',
      now,
      now + 3,
      'user-cli-privacy-beta',
      'memory_association',
      'opted_in',
      `beta memory secret ${secret} qq-456789012`,
      'admin',
      'admin',
      'admin_cli',
      now,
      now + 4
    );

    const beforeRows = {
      preferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const alphaRows = JSON.parse(expectSuccessfulCli([
      'list-privacy-preferences',
      '--user',
      'user-cli-privacy-alpha',
    ])) as Array<{ canonicalUserId: string; preferenceType: string; state: string; reason?: string }>;
    const alphaMemoryOptOutRows = JSON.parse(expectSuccessfulCli([
      'list-privacy-preferences',
      '--user',
      'user-cli-privacy-alpha',
      '--type',
      'memory_association',
      '--state',
      'opted_out',
    ])) as Array<{ canonicalUserId: string; preferenceType: string; state: string; reason?: string }>;
    const proactiveOptInRows = JSON.parse(expectSuccessfulCli([
      'list-privacy-preferences',
      '--type',
      'proactive_dm',
      '--state',
      'opted_in',
    ])) as Array<{ canonicalUserId: string; preferenceType: string; state: string; reason?: string }>;

    expect(alphaRows).toHaveLength(2);
    expect(alphaRows).toEqual([
      expect.objectContaining({
        canonicalUserId: 'user-cli-privacy-alpha',
        preferenceType: 'memory_association',
        state: 'opted_out',
        reason: expect.stringContaining('[REDACTED:'),
      }),
      expect.objectContaining({
        canonicalUserId: 'user-cli-privacy-alpha',
        preferenceType: 'proactive_dm',
        state: 'opted_out',
        reason: expect.stringContaining('[REDACTED:'),
      }),
    ]);
    expect(alphaMemoryOptOutRows).toEqual([
      expect.objectContaining({
        canonicalUserId: 'user-cli-privacy-alpha',
        preferenceType: 'memory_association',
        state: 'opted_out',
        reason: expect.stringContaining('[REDACTED:'),
      }),
    ]);
    expect(proactiveOptInRows).toEqual([
      expect.objectContaining({
        canonicalUserId: 'user-cli-privacy-beta',
        preferenceType: 'proactive_dm',
        state: 'opted_in',
        reason: expect.stringContaining('[REDACTED:'),
      }),
    ]);

    const serialized = JSON.stringify({
      alphaRows,
      alphaMemoryOptOutRows,
      proactiveOptInRows,
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain('234567890');
    expect(serialized).not.toContain('345678901');
    expect(serialized).not.toContain('456789012');
    expect(JSON.stringify(alphaRows)).not.toContain('user-cli-privacy-beta');
    expect(JSON.stringify(alphaMemoryOptOutRows)).not.toContain('proactive_dm');
    expect(JSON.stringify(proactiveOptInRows)).not.toContain('user-cli-privacy-alpha');
    expect(JSON.stringify(proactiveOptInRows)).not.toContain('memory_association');

    reopenDb();
    const afterRows = {
      preferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns privacy preference filters with assignment-shaped user identifiers without leaking raw keys', () => {
    const now = Date.now();
    const rawUserId = 'api_key=sk-cli-privacy-filter-secret-qq-246813579';
    const distractorUserId = 'api_key=sk-cli-privacy-filter-distractor-qq-246813580';
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?), (?, ?, ?)').run(
      rawUserId,
      now,
      now,
      distractorUserId,
      now,
      now
    );
    db.prepare(
      `INSERT INTO privacy_preferences (
        canonical_user_id, preference_type, state, reason,
        updated_by_user_id, updated_by_actor_class, updated_by_context,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rawUserId,
      'proactive_dm',
      'opted_out',
      `assignment-shaped privacy filter reason ${rawUserId}`,
      'admin',
      'admin',
      'admin_cli',
      now,
      now + 1,
      distractorUserId,
      'memory_association',
      'opted_out',
      `assignment-shaped privacy distractor reason ${distractorUserId}`,
      'admin',
      'admin',
      'admin_cli',
      now,
      now + 2
    );

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      preferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const rows = JSON.parse(expectSuccessfulCli([
      'list-privacy-preferences',
      '--user',
      rawUserId,
      '--type',
      'proactive_dm',
      '--state',
      'opted_out',
    ])) as Array<{
      canonicalUserId: string;
      preferenceType: string;
      state: string;
      reason?: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      canonicalUserId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      preferenceType: 'proactive_dm',
      state: 'opted_out',
      reason: expect.stringContaining('[REDACTED:api_key_assignment]'),
    }));
    expect(rows[0]?.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.reason).toContain('[REDACTED:platform_id]');

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-cli-privacy-filter-secret');
    expect(serialized).not.toContain('sk-cli-privacy-filter-distractor');
    expect(serialized).not.toContain('qq-246813579');
    expect(serialized).not.toContain('qq-246813580');
    expect(serialized).not.toContain('246813579');
    expect(serialized).not.toContain('246813580');
    expect(serialized).not.toContain('memory_association');

    const rawExactCount = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM privacy_preferences
         WHERE canonical_user_id = ? AND preference_type = ?`
      )
      .get(rawUserId, 'proactive_dm') as { count: number };
    const distractorExactCount = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM privacy_preferences
         WHERE canonical_user_id = ? AND preference_type = ?`
      )
      .get(distractorUserId, 'memory_association') as { count: number };
    expect(rawExactCount.count).toBe(1);
    expect(distractorExactCount.count).toBe(1);

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      preferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns privacy opt-out updates with assignment-shaped user identifiers without leaking raw keys', () => {
    const now = Date.now();
    const rawUserId = 'api_key=sk-cli-privacy-update-secret-qq-135792468';
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      rawUserId,
      now,
      now
    );

    const setOutput = expectSuccessfulCli([
      'set-privacy-opt-out',
      rawUserId,
      'memory_association',
      '--reason',
      `assignment-shaped privacy update set reason ${rawUserId}`,
    ]);
    expect(setOutput).toContain('[REDACTED:api_key_assignment]');
    expect(setOutput).toContain('[REDACTED:platform_id]');
    expect(setOutput).toContain('opted out of memory_association');

    const optedOut = JSON.parse(expectSuccessfulCli([
      'list-privacy-preferences',
      '--user',
      rawUserId,
      '--type',
      'memory_association',
    ])) as Array<{
      canonicalUserId: string;
      preferenceType: string;
      state: string;
      reason?: string;
    }>;
    expect(optedOut).toEqual([
      expect.objectContaining({
        canonicalUserId: expect.stringContaining('[REDACTED:api_key_assignment]'),
        preferenceType: 'memory_association',
        state: 'opted_out',
        reason: expect.stringContaining('[REDACTED:api_key_assignment]'),
      }),
    ]);
    expect(optedOut[0]?.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(optedOut[0]?.reason).toContain('[REDACTED:platform_id]');

    const clearOutput = expectSuccessfulCli([
      'clear-privacy-opt-out',
      rawUserId,
      'memory_association',
      '--reason',
      `assignment-shaped privacy update clear reason ${rawUserId}`,
    ]);
    expect(clearOutput).toContain('[REDACTED:api_key_assignment]');
    expect(clearOutput).toContain('[REDACTED:platform_id]');
    expect(clearOutput).toContain('opted back into memory_association');

    const preferenceRow = db
      .prepare(
        `SELECT canonical_user_id, preference_type, state, reason
         FROM privacy_preferences
         WHERE canonical_user_id = ? AND preference_type = ?`
      )
      .get(rawUserId, 'memory_association') as {
      canonical_user_id: string;
      preference_type: string;
      state: string;
      reason: string;
    };
    expect(preferenceRow).toMatchObject({
      canonical_user_id: rawUserId,
      preference_type: 'memory_association',
      state: 'opted_in',
    });
    expect(preferenceRow.reason).toContain('[REDACTED:api_key_assignment]');
    expect(preferenceRow.reason).toContain('[REDACTED:platform_id]');

    const auditRows = db
      .prepare(
        `SELECT event_id, details
         FROM audit_log
         WHERE event_type = ? AND event_id = ?
         ORDER BY timestamp ASC`
      )
      .all('privacy.preference_set', `${rawUserId}:memory_association`) as Array<{
      event_id: string;
      details: string;
    }>;
    expect(auditRows).toHaveLength(2);
    expect(auditRows[0]?.event_id).toBe(`${rawUserId}:memory_association`);
    expect(auditRows[1]?.event_id).toBe(`${rawUserId}:memory_association`);
    for (const row of auditRows) {
      expect(row.details).toContain('[REDACTED:api_key_assignment]');
      expect(row.details).toContain('[REDACTED:platform_id]');
    }

    const serialized = JSON.stringify({
      setOutput,
      optedOut,
      clearOutput,
      preferenceReason: preferenceRow.reason,
      auditDetails: auditRows.map((row) => row.details),
    });
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-cli-privacy-update-secret');
    expect(serialized).not.toContain('qq-135792468');
    expect(serialized).not.toContain('135792468');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns privacy preference inspection with redacted legacy actor metadata', () => {
    const now = Date.now();
    const secret = 'sk-legacyprivacyactorabcdefghijklmnop';
    const platformId = 'qq-876543210';
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-cli-privacy-actor',
      now,
      now
    );
    db.prepare(
      `INSERT INTO privacy_preferences (
        canonical_user_id, preference_type, state, reason,
        updated_by_user_id, updated_by_actor_class, updated_by_context,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'user-cli-privacy-actor',
      'proactive_dm',
      'opted_out',
      `legacy actor metadata reason ${secret} ${platformId}`,
      `admin-${secret}-${platformId}`,
      `admin-${secret}-${platformId}`,
      `admin_cli-${secret}-${platformId}`,
      now,
      now + 1
    );

    const beforeRows = {
      preferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const rows = JSON.parse(expectSuccessfulCli([
      'list-privacy-preferences',
      '--user',
      'user-cli-privacy-actor',
    ])) as Array<{
      canonicalUserId: string;
      preferenceType: string;
      state: string;
      reason?: string;
      updatedBy?: {
        canonicalUserId?: string;
        actorClass?: string;
        context?: string;
      };
    }>;

    expect(rows).toEqual([
      expect.objectContaining({
        canonicalUserId: 'user-cli-privacy-actor',
        preferenceType: 'proactive_dm',
        state: 'opted_out',
        reason: expect.stringContaining('[REDACTED:'),
        updatedBy: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:'),
          actorClass: expect.stringContaining('[REDACTED:'),
          context: expect.stringContaining('[REDACTED:'),
        }),
      }),
    ]);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('876543210');

    reopenDb();
    const afterRows = {
      preferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns privacy preference legacy classification display with redacted values while preserving raw rows', () => {
    const now = Date.now();
    const secret = 'sk-cli-privacy-classification-secret-should-not-leak';
    const platformId = 'qq-765432109';
    const legacyPreferenceType = `proactive_dm-${platformId}-${secret}`;
    const legacyState = `opted_out-${platformId}-${secret}`;
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'user-cli-privacy-legacy-classification',
      now,
      now
    );

    db.pragma('ignore_check_constraints = ON');
    try {
      db.prepare(
        `INSERT INTO privacy_preferences (
          canonical_user_id, preference_type, state, reason,
          updated_by_user_id, updated_by_actor_class, updated_by_context,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'user-cli-privacy-legacy-classification',
        legacyPreferenceType,
        legacyState,
        `legacy privacy classification reason ${secret} ${platformId}`,
        'admin',
        'admin',
        'admin_cli',
        now,
        now + 1
      );
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }

    const beforeRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      preferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const rows = JSON.parse(expectSuccessfulCli([
      'list-privacy-preferences',
      '--user',
      'user-cli-privacy-legacy-classification',
    ])) as Array<{
      canonicalUserId: string;
      preferenceType: string;
      state: string;
      reason?: string;
    }>;

    expect(rows).toEqual([
      expect.objectContaining({
        canonicalUserId: 'user-cli-privacy-legacy-classification',
        preferenceType: expect.stringContaining('[REDACTED:platform_id]'),
        state: expect.stringContaining('[REDACTED:platform_id]'),
        reason: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('765432109');

    reopenDb();
    const afterRows = {
      canonicalUsers: db.prepare('SELECT * FROM canonical_users ORDER BY id').all(),
      preferences: db.prepare('SELECT * FROM privacy_preferences ORDER BY canonical_user_id, preference_type').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns privacy opt-out commands with persisted reason and platform-id redaction', () => {
    const now = Date.now();
    const secret = 'sk-ijklmnopqrstuvwxyz123456789abcde';
    const platformUserId = 'qq-123456789';
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      platformUserId,
      now,
      now
    );

    const setOutput = expectSuccessfulCli([
      'set-privacy-opt-out',
      platformUserId,
      'proactive_dm',
      '--reason',
      `operator pasted ${secret} for ${platformUserId}`,
    ]);
    expect(setOutput).toContain('[REDACTED:platform_id] opted out of proactive_dm');
    expect(setOutput).not.toContain(platformUserId);
    expect(setOutput).not.toContain(secret);

    const listed = JSON.parse(expectSuccessfulCli([
      'list-privacy-preferences',
      '--user',
      platformUserId,
      '--type',
      'proactive_dm',
    ])) as Array<{
      canonicalUserId: string;
      preferenceType: string;
      state: string;
      reason?: string;
      updatedBy?: { canonicalUserId?: string };
    }>;
    expect(listed).toEqual([
      expect.objectContaining({
        canonicalUserId: '[REDACTED:platform_id]',
        preferenceType: 'proactive_dm',
        state: 'opted_out',
        reason: expect.stringContaining('[REDACTED:'),
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(platformUserId);
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(JSON.stringify(listed)).not.toContain('123456789');

    const preferenceRow = db
      .prepare(
        `SELECT canonical_user_id, reason
         FROM privacy_preferences
         WHERE canonical_user_id = ? AND preference_type = ?`
      )
      .get(platformUserId, 'proactive_dm') as { canonical_user_id: string; reason: string };
    expect(preferenceRow.canonical_user_id).toBe(platformUserId);
    expect(preferenceRow.reason).toContain('[REDACTED:openai_like_api_key]');
    expect(preferenceRow.reason).toContain('[REDACTED:platform_id]');
    expect(preferenceRow.reason).not.toContain(secret);
    expect(preferenceRow.reason).not.toContain('123456789');

    const auditRows = db
      .prepare(
        `SELECT event_id, details
         FROM audit_log
         WHERE event_type = ? AND event_id = ?
         ORDER BY timestamp ASC`
      )
      .all('privacy.preference_set', `${platformUserId}:proactive_dm`) as Array<{
      event_id: string;
      details: string;
    }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.event_id).toBe(`${platformUserId}:proactive_dm`);
    expect(auditRows[0]?.details).toContain('[REDACTED:openai_like_api_key]');
    expect(auditRows[0]?.details).toContain('[REDACTED:platform_id]');
    expect(auditRows[0]?.details).not.toContain(secret);
    expect(auditRows[0]?.details).not.toContain('123456789');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns privacy preference validation errors without leaking invalid values or mutating data', () => {
    const secret = 'sk-hijklmnopqrstuvwxyz123456789abcd';
    const invalidType = `proactive_dm-${secret}-qq-123456789`;
    const invalidState = `opted_out-${secret}-qq-987654321`;
    const beforeCounts = {
      preferences: (db.prepare('SELECT COUNT(*) AS count FROM privacy_preferences').get() as { count: number }).count,
      audit: (db.prepare('SELECT COUNT(*) AS count FROM audit_log').get() as { count: number }).count,
      memories: (db.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number }).count,
    };

    const results = [
      runCli(['list-privacy-preferences', '--type', invalidType]),
      runCli(['list-privacy-preferences', '--state', invalidState]),
      runCli(['set-privacy-opt-out', 'user-cli', invalidType, '--reason', `blocked ${secret}`]),
      runCli(['clear-privacy-opt-out', 'user-cli', invalidType, '--reason', `blocked ${secret}`]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('❌ Invalid privacy preference');
      expect(result.stderr).toContain('[REDACTED:');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain('123456789');
      expect(result.stderr).not.toContain('987654321');
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('\n    at ');
      expect(result.stderr).not.toContain('TypeError');
    }
    expect(results[0]?.stderr).toContain('Invalid privacy preference type');
    expect(results[1]?.stderr).toContain('Invalid privacy preference state');
    expect(results[2]?.stderr).toContain('Invalid privacy preference type');
    expect(results[3]?.stderr).toContain('Invalid privacy preference type');

    reopenDb();
    const afterCounts = {
      preferences: (db.prepare('SELECT COUNT(*) AS count FROM privacy_preferences').get() as { count: number }).count,
      audit: (db.prepare('SELECT COUNT(*) AS count FROM audit_log').get() as { count: number }).count,
      memories: (db.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number }).count,
    };
    expect(afterCounts).toEqual(beforeCounts);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns display profile redaction scoped to one group with redacted audit evidence', () => {
    const now = Date.now();
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      'qq-12345678',
      now,
      now
    );
    db.prepare(
      `INSERT INTO display_profiles (
        canonical_user_id, source_group_id, current_display_name, observed_at, trust
      ) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
    ).run(
      'qq-12345678',
      '',
      'Global Display Name',
      now,
      'platform_provided',
      'qq-12345678',
      'qq-group-87654321',
      'Group A Private Card',
      now,
      'platform_provided',
      'qq-12345678',
      'qq-group-redact-b',
      'Group B Should Stay',
      now,
      'platform_provided'
    );
    db.prepare(
      `INSERT INTO nickname_history (
        id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
      ) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`
    ).run(
      'nick-cli-redact-global',
      'qq-12345678',
      '',
      'Global Old Name',
      now,
      null,
      'nick-cli-redact-a',
      'qq-12345678',
      'qq-group-87654321',
      'Group A Old Card',
      now,
      null,
      'nick-cli-redact-b',
      'qq-12345678',
      'qq-group-redact-b',
      'Group B Old Card',
      now,
      null
    );

    const stdout = expectSuccessfulCli([
      'redact-display-profile',
      'qq-12345678',
      '--group',
      'qq-group-87654321',
    ]);
    expect(stdout).toContain('Redacted 2 display profile/nickname rows for [REDACTED:platform_id]');
    expect(stdout).not.toContain('qq-12345678');
    expect(stdout).not.toContain('qq-group-87654321');
    expect(stdout).not.toContain('Group A Private Card');
    expect(stdout).not.toContain('Group A Old Card');

    const displayRows = db
      .prepare(
        `SELECT source_group_id, current_display_name, trust
         FROM display_profiles
         WHERE canonical_user_id = ?
         ORDER BY source_group_id ASC`
      )
      .all('qq-12345678') as Array<{
      source_group_id: string;
      current_display_name: string;
      trust: string;
    }>;
    expect(displayRows).toEqual([
      {
        source_group_id: '',
        current_display_name: 'Global Display Name',
        trust: 'platform_provided',
      },
      {
        source_group_id: 'qq-group-87654321',
        current_display_name: '[redacted]',
        trust: 'user_set',
      },
      {
        source_group_id: 'qq-group-redact-b',
        current_display_name: 'Group B Should Stay',
        trust: 'platform_provided',
      },
    ]);

    const nicknameRows = db
      .prepare(
        `SELECT source_group_id, display_name, observed_until
         FROM nickname_history
         WHERE canonical_user_id = ?
         ORDER BY source_group_id ASC`
      )
      .all('qq-12345678') as Array<{
      source_group_id: string;
      display_name: string;
      observed_until: number | null;
    }>;
    expect(nicknameRows).toEqual([
      {
        source_group_id: '',
        display_name: 'Global Old Name',
        observed_until: null,
      },
      {
        source_group_id: 'qq-group-87654321',
        display_name: '[redacted]',
        observed_until: expect.any(Number),
      },
      {
        source_group_id: 'qq-group-redact-b',
        display_name: 'Group B Old Card',
        observed_until: null,
      },
    ]);

    const auditRows = JSON.parse(
      expectSuccessfulCli([
        'list-audit',
        '--event-type',
        'display_profile.redact',
        '--event-id',
        'qq-12345678:qq-group-87654321',
        '--include-details',
      ])
    ) as Array<{
      category: string;
      eventType: string;
      eventId: string;
      actor: { actorClass?: string; context?: string };
      details?: Record<string, unknown>;
      redacted: boolean;
    }>;
    expect(auditRows).toEqual([
      expect.objectContaining({
        category: 'system',
        eventType: 'display_profile.redact',
        eventId: '[REDACTED:platform_id]:[REDACTED:platform_id]',
        actor: expect.objectContaining({
          actorClass: 'admin',
          context: 'admin_cli',
        }),
        details: expect.objectContaining({
          canonicalUserId: '[REDACTED:platform_id]',
          groupId: '[REDACTED:platform_id]',
          displayProfilesUpdated: 1,
          nicknameHistoryUpdated: 1,
        }),
        redacted: true,
      }),
    ]);
    const serializedAudit = JSON.stringify(auditRows);
    expect(serializedAudit).not.toContain('Group A Private Card');
    expect(serializedAudit).not.toContain('qq-12345678:qq-group-87654321');
    expect(serializedAudit).not.toContain('"canonicalUserId":"qq-12345678"');
    expect(serializedAudit).not.toContain('"groupId":"qq-group-87654321"');
    expect(serializedAudit).toContain('[REDACTED:platform_id]');
    expect(serializedAudit).not.toContain('Group A Old Card');
    expect(serializedAudit).not.toContain('Global Display Name');
    expect(serializedAudit).not.toContain('Group B Should Stay');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns display profile redaction with redacted durable audit summary and details', () => {
    const now = Date.now();
    const secret = 'sk-displayprofileabcdefghijklmnopqrstuvwxyz';
    const canonicalUserId = `legacy_qq-123456789_${secret}`;
    const groupId = `legacy_qq-group-987654321_${secret}`;

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      canonicalUserId,
      now,
      now
    );
    db.prepare(
      `INSERT INTO display_profiles (
        canonical_user_id, source_group_id, current_display_name, observed_at, trust
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      canonicalUserId,
      groupId,
      `Sensitive display ${secret} qq-222222222`,
      now,
      'platform_provided'
    );
    db.prepare(
      `INSERT INTO nickname_history (
        id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'nick-cli-redact-sensitive-audit',
      canonicalUserId,
      groupId,
      `Sensitive old card ${secret} qq-333333333`,
      now,
      null
    );

    const stdout = expectSuccessfulCli([
      'redact-display-profile',
      canonicalUserId,
      '--group',
      groupId,
    ]);

    expect(stdout).toContain('Redacted 2 display profile/nickname rows for');
    expect(stdout).toContain('[REDACTED:openai_like_api_key]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain('123456789');
    expect(stdout).not.toContain('987654321');

    const auditRow = db
      .prepare(
        `SELECT event_id, summary, details, redacted
         FROM audit_log
         WHERE event_type = ?
         ORDER BY timestamp DESC
         LIMIT 1`
      )
      .get('display_profile.redact') as {
      event_id: string;
      summary: string;
      details: string;
      redacted: number;
    } | undefined;

    expect(auditRow?.event_id).toBe(`${canonicalUserId}:${groupId}`);
    expect(auditRow?.redacted).toBe(1);
    expect(auditRow?.summary).toContain('[REDACTED:openai_like_api_key]');
    expect(auditRow?.summary).toContain('[REDACTED:platform_id]');
    expect(auditRow?.summary).not.toContain(secret);
    expect(auditRow?.summary).not.toContain('123456789');
    expect(auditRow?.summary).not.toContain('987654321');

    const details = JSON.parse(auditRow?.details ?? '{}') as {
      canonicalUserId?: string;
      groupId?: string;
      displayProfilesUpdated?: number;
      nicknameHistoryUpdated?: number;
    };
    expect(details).toMatchObject({
      canonicalUserId: expect.stringContaining('[REDACTED:platform_id]'),
      groupId: expect.stringContaining('[REDACTED:platform_id]'),
      displayProfilesUpdated: 1,
      nicknameHistoryUpdated: 1,
    });
    const serializedDetails = JSON.stringify(details);
    expect(serializedDetails).toContain('[REDACTED:openai_like_api_key]');
    expect(serializedDetails).not.toContain(secret);
    expect(serializedDetails).not.toContain('123456789');
    expect(serializedDetails).not.toContain('987654321');

    const displayRows = db
      .prepare(
        `SELECT current_display_name
         FROM display_profiles
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .all(canonicalUserId, groupId);
    expect(displayRows).toEqual([{ current_display_name: '[redacted]' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns display profile redaction with assignment-shaped identifiers without leaking raw keys', () => {
    const now = Date.now();
    const rawUserId = 'api_key=sk-cli-display-profile-user-secret-qq-314159265';
    const rawGroupId = 'api_key=sk-cli-display-profile-group-secret-qq-271828182';
    const distractorGroupId = 'api_key=sk-cli-display-profile-distractor-secret-qq-161803398';
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      rawUserId,
      now,
      now
    );
    db.prepare(
      `INSERT INTO display_profiles (
        canonical_user_id, source_group_id, current_display_name, observed_at, trust
      ) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
    ).run(
      rawUserId,
      rawGroupId,
      `Assignment shaped display ${rawUserId} ${rawGroupId}`,
      now,
      'platform_provided',
      rawUserId,
      distractorGroupId,
      `Assignment shaped distractor ${distractorGroupId}`,
      now,
      'platform_provided'
    );
    db.prepare(
      `INSERT INTO nickname_history (
        id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
      ) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`
    ).run(
      'nick-cli-redact-assignment-target',
      rawUserId,
      rawGroupId,
      `Assignment shaped old card ${rawUserId} ${rawGroupId}`,
      now,
      null,
      'nick-cli-redact-assignment-distractor',
      rawUserId,
      distractorGroupId,
      `Assignment shaped old distractor ${distractorGroupId}`,
      now,
      null
    );

    const stdout = expectSuccessfulCli([
      'redact-display-profile',
      rawUserId,
      '--group',
      rawGroupId,
    ]);
    expect(stdout).toContain('Redacted 2 display profile/nickname rows for');
    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');

    const listedAudit = JSON.parse(
      expectSuccessfulCli([
        'list-audit',
        '--event-type',
        'display_profile.redact',
        '--event-id',
        `${rawUserId}:${rawGroupId}`,
        '--include-details',
      ])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: {
        canonicalUserId?: string;
        groupId?: string;
        displayProfilesUpdated?: number;
        nicknameHistoryUpdated?: number;
      };
    }>;
    expect(listedAudit).toEqual([
      expect.objectContaining({
        eventId: expect.stringContaining('[REDACTED:api_key_assignment]'),
        summary: expect.stringContaining('[REDACTED:api_key_assignment]'),
        details: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:api_key_assignment]'),
          groupId: expect.stringContaining('[REDACTED:api_key_assignment]'),
          displayProfilesUpdated: 1,
          nicknameHistoryUpdated: 1,
        }),
      }),
    ]);
    expect(listedAudit[0]?.eventId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details?.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details?.groupId).toContain('[REDACTED:platform_id]');

    const targetDisplayRow = db
      .prepare(
        `SELECT current_display_name, trust
         FROM display_profiles
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, rawGroupId) as { current_display_name: string; trust: string };
    expect(targetDisplayRow).toEqual({
      current_display_name: '[redacted]',
      trust: 'user_set',
    });
    const distractorDisplayRow = db
      .prepare(
        `SELECT current_display_name, trust
         FROM display_profiles
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { current_display_name: string; trust: string };
    expect(distractorDisplayRow).toEqual({
      current_display_name: `Assignment shaped distractor ${distractorGroupId}`,
      trust: 'platform_provided',
    });

    const targetNicknameRow = db
      .prepare(
        `SELECT display_name, observed_until
         FROM nickname_history
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, rawGroupId) as { display_name: string; observed_until: number | null };
    expect(targetNicknameRow).toEqual({
      display_name: '[redacted]',
      observed_until: expect.any(Number),
    });
    const distractorNicknameRow = db
      .prepare(
        `SELECT display_name, observed_until
         FROM nickname_history
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { display_name: string; observed_until: number | null };
    expect(distractorNicknameRow).toEqual({
      display_name: `Assignment shaped old distractor ${distractorGroupId}`,
      observed_until: null,
    });

    const auditRow = db
      .prepare(
        `SELECT event_id, summary, details, redacted
         FROM audit_log
         WHERE event_type = ? AND event_id = ?`
      )
      .get('display_profile.redact', `${rawUserId}:${rawGroupId}`) as {
      event_id: string;
      summary: string;
      details: string;
      redacted: number;
    };
    expect(auditRow.event_id).toBe(`${rawUserId}:${rawGroupId}`);
    expect(auditRow.redacted).toBe(1);
    expect(auditRow.summary).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.summary).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.details).toContain('[REDACTED:platform_id]');

    const serialized = JSON.stringify({
      stdout,
      listedAudit,
      auditSummary: auditRow.summary,
      auditDetails: auditRow.details,
    });
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-cli-display-profile-user-secret');
    expect(serialized).not.toContain('sk-cli-display-profile-group-secret');
    expect(serialized).not.toContain('sk-cli-display-profile-distractor-secret');
    expect(serialized).not.toContain('qq-314159265');
    expect(serialized).not.toContain('qq-271828182');
    expect(serialized).not.toContain('qq-161803398');
    expect(serialized).not.toContain('314159265');
    expect(serialized).not.toContain('271828182');
    expect(serialized).not.toContain('161803398');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns unscoped display profile redaction with assignment-shaped identifiers without leaking raw keys', () => {
    const now = Date.now();
    const rawUserId = 'api_key=sk-cli-display-profile-global-secret-qq-424242424';
    const distractorGroupId = 'api_key=sk-cli-display-profile-global-distractor-qq-515151515';
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      rawUserId,
      now,
      now
    );
    db.prepare(
      `INSERT INTO display_profiles (
        canonical_user_id, source_group_id, current_display_name, observed_at, trust
      ) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
    ).run(
      rawUserId,
      '',
      `Assignment shaped global display ${rawUserId}`,
      now,
      'platform_provided',
      rawUserId,
      distractorGroupId,
      `Assignment shaped group display ${distractorGroupId}`,
      now,
      'platform_provided'
    );
    db.prepare(
      `INSERT INTO nickname_history (
        id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
      ) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`
    ).run(
      'nick-cli-redact-assignment-global-target',
      rawUserId,
      '',
      `Assignment shaped global old card ${rawUserId}`,
      now,
      null,
      'nick-cli-redact-assignment-global-distractor',
      rawUserId,
      distractorGroupId,
      `Assignment shaped group old card ${distractorGroupId}`,
      now,
      null
    );

    const stdout = expectSuccessfulCli(['redact-display-profile', rawUserId]);
    expect(stdout).toContain('Redacted 2 display profile/nickname rows for');
    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');

    const listedAudit = JSON.parse(
      expectSuccessfulCli([
        'list-audit',
        '--event-type',
        'display_profile.redact',
        '--event-id',
        `${rawUserId}:`,
        '--include-details',
      ])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: {
        canonicalUserId?: string;
        groupId?: string;
        displayProfilesUpdated?: number;
        nicknameHistoryUpdated?: number;
      };
    }>;
    expect(listedAudit).toEqual([
      expect.objectContaining({
        eventId: expect.stringContaining('[REDACTED:api_key_assignment]'),
        summary: expect.stringContaining('[REDACTED:api_key_assignment]'),
        details: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:api_key_assignment]'),
          displayProfilesUpdated: 1,
          nicknameHistoryUpdated: 1,
        }),
      }),
    ]);
    expect(listedAudit[0]?.eventId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details?.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details).not.toHaveProperty('groupId');

    const targetDisplayRow = db
      .prepare(
        `SELECT current_display_name, trust
         FROM display_profiles
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, '') as { current_display_name: string; trust: string };
    expect(targetDisplayRow).toEqual({
      current_display_name: '[redacted]',
      trust: 'user_set',
    });
    const distractorDisplayRow = db
      .prepare(
        `SELECT current_display_name, trust
         FROM display_profiles
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { current_display_name: string; trust: string };
    expect(distractorDisplayRow).toEqual({
      current_display_name: `Assignment shaped group display ${distractorGroupId}`,
      trust: 'platform_provided',
    });

    const targetNicknameRow = db
      .prepare(
        `SELECT display_name, observed_until
         FROM nickname_history
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, '') as { display_name: string; observed_until: number | null };
    expect(targetNicknameRow).toEqual({
      display_name: '[redacted]',
      observed_until: expect.any(Number),
    });
    const distractorNicknameRow = db
      .prepare(
        `SELECT display_name, observed_until
         FROM nickname_history
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { display_name: string; observed_until: number | null };
    expect(distractorNicknameRow).toEqual({
      display_name: `Assignment shaped group old card ${distractorGroupId}`,
      observed_until: null,
    });

    const auditRow = db
      .prepare(
        `SELECT event_id, summary, details, redacted
         FROM audit_log
         WHERE event_type = ? AND event_id = ?`
      )
      .get('display_profile.redact', `${rawUserId}:`) as {
      event_id: string;
      summary: string;
      details: string;
      redacted: number;
    };
    expect(auditRow.event_id).toBe(`${rawUserId}:`);
    expect(auditRow.redacted).toBe(1);
    expect(auditRow.summary).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.summary).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.details).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).not.toContain('groupId');

    const serialized = JSON.stringify({
      stdout,
      listedAudit,
      auditSummary: auditRow.summary,
      auditDetails: auditRow.details,
    });
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-cli-display-profile-global-secret');
    expect(serialized).not.toContain('sk-cli-display-profile-global-distractor');
    expect(serialized).not.toContain('qq-424242424');
    expect(serialized).not.toContain('qq-515151515');
    expect(serialized).not.toContain('424242424');
    expect(serialized).not.toContain('515151515');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns zero-row display profile redaction with assignment-shaped identifiers without leaking raw keys', () => {
    const now = Date.now();
    const rawUserId = 'api_key=sk-cli-display-profile-empty-secret-qq-626262626';
    const rawGroupId = 'api_key=sk-cli-display-profile-empty-group-qq-737373737';

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      rawUserId,
      now,
      now
    );

    const stdout = expectSuccessfulCli([
      'redact-display-profile',
      rawUserId,
      '--group',
      rawGroupId,
    ]);
    expect(stdout).toContain('Redacted 0 display profile/nickname rows for');
    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');

    const listedAudit = JSON.parse(
      expectSuccessfulCli([
        'list-audit',
        '--event-type',
        'display_profile.redact',
        '--event-id',
        `${rawUserId}:${rawGroupId}`,
        '--include-details',
      ])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: {
        canonicalUserId?: string;
        groupId?: string;
        displayProfilesUpdated?: number;
        nicknameHistoryUpdated?: number;
      };
    }>;
    expect(listedAudit).toEqual([
      expect.objectContaining({
        eventId: expect.stringContaining('[REDACTED:api_key_assignment]'),
        summary: expect.stringContaining('[REDACTED:api_key_assignment]'),
        details: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:api_key_assignment]'),
          groupId: expect.stringContaining('[REDACTED:api_key_assignment]'),
          displayProfilesUpdated: 0,
          nicknameHistoryUpdated: 0,
        }),
      }),
    ]);
    expect(listedAudit[0]?.eventId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details?.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details?.groupId).toContain('[REDACTED:platform_id]');

    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM display_profiles WHERE canonical_user_id = ?')
        .get(rawUserId)
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM nickname_history WHERE canonical_user_id = ?')
        .get(rawUserId)
    ).toEqual({ count: 0 });

    const auditRow = db
      .prepare(
        `SELECT event_id, summary, details, redacted
         FROM audit_log
         WHERE event_type = ? AND event_id = ?`
      )
      .get('display_profile.redact', `${rawUserId}:${rawGroupId}`) as {
      event_id: string;
      summary: string;
      details: string;
      redacted: number;
    };
    expect(auditRow.event_id).toBe(`${rawUserId}:${rawGroupId}`);
    expect(auditRow.redacted).toBe(1);
    expect(auditRow.summary).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.summary).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.details).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('"displayProfilesUpdated":0');
    expect(auditRow.details).toContain('"nicknameHistoryUpdated":0');

    const serialized = JSON.stringify({
      stdout,
      listedAudit,
      auditSummary: auditRow.summary,
      auditDetails: auditRow.details,
    });
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-cli-display-profile-empty-secret');
    expect(serialized).not.toContain('sk-cli-display-profile-empty-group');
    expect(serialized).not.toContain('qq-626262626');
    expect(serialized).not.toContain('qq-737373737');
    expect(serialized).not.toContain('626262626');
    expect(serialized).not.toContain('737373737');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns unscoped zero-row display profile redaction with assignment-shaped identifiers without leaking raw keys', () => {
    const now = Date.now();
    const rawUserId = 'api_key=sk-cli-display-profile-empty-global-qq-848484848';
    const distractorGroupId = 'api_key=sk-cli-display-profile-empty-global-distractor-qq-959595959';

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      rawUserId,
      now,
      now
    );
    db.prepare(
      `INSERT INTO display_profiles (
        canonical_user_id, source_group_id, current_display_name, observed_at, trust
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      rawUserId,
      distractorGroupId,
      `Assignment shaped group-only display ${distractorGroupId}`,
      now,
      'platform_provided'
    );
    db.prepare(
      `INSERT INTO nickname_history (
        id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'nick-cli-redact-assignment-empty-global-distractor',
      rawUserId,
      distractorGroupId,
      `Assignment shaped group-only old card ${distractorGroupId}`,
      now,
      null
    );

    const stdout = expectSuccessfulCli(['redact-display-profile', rawUserId]);
    expect(stdout).toContain('Redacted 0 display profile/nickname rows for');
    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');

    const listedAudit = JSON.parse(
      expectSuccessfulCli([
        'list-audit',
        '--event-type',
        'display_profile.redact',
        '--event-id',
        `${rawUserId}:`,
        '--include-details',
      ])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: {
        canonicalUserId?: string;
        groupId?: string;
        displayProfilesUpdated?: number;
        nicknameHistoryUpdated?: number;
      };
    }>;
    expect(listedAudit).toEqual([
      expect.objectContaining({
        eventId: expect.stringContaining('[REDACTED:api_key_assignment]'),
        summary: expect.stringContaining('[REDACTED:api_key_assignment]'),
        details: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:api_key_assignment]'),
          displayProfilesUpdated: 0,
          nicknameHistoryUpdated: 0,
        }),
      }),
    ]);
    expect(listedAudit[0]?.eventId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details?.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details).not.toHaveProperty('groupId');

    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM display_profiles
           WHERE canonical_user_id = ? AND source_group_id = ?`
        )
        .get(rawUserId, '')
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM nickname_history
           WHERE canonical_user_id = ? AND source_group_id = ?`
        )
        .get(rawUserId, '')
    ).toEqual({ count: 0 });

    const distractorDisplayRow = db
      .prepare(
        `SELECT current_display_name, trust
         FROM display_profiles
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { current_display_name: string; trust: string };
    expect(distractorDisplayRow).toEqual({
      current_display_name: `Assignment shaped group-only display ${distractorGroupId}`,
      trust: 'platform_provided',
    });
    const distractorNicknameRow = db
      .prepare(
        `SELECT display_name, observed_until
         FROM nickname_history
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { display_name: string; observed_until: number | null };
    expect(distractorNicknameRow).toEqual({
      display_name: `Assignment shaped group-only old card ${distractorGroupId}`,
      observed_until: null,
    });

    const auditRow = db
      .prepare(
        `SELECT event_id, summary, details, redacted
         FROM audit_log
         WHERE event_type = ? AND event_id = ?`
      )
      .get('display_profile.redact', `${rawUserId}:`) as {
      event_id: string;
      summary: string;
      details: string;
      redacted: number;
    };
    expect(auditRow.event_id).toBe(`${rawUserId}:`);
    expect(auditRow.redacted).toBe(1);
    expect(auditRow.summary).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.summary).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.details).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('"displayProfilesUpdated":0');
    expect(auditRow.details).toContain('"nicknameHistoryUpdated":0');
    expect(auditRow.details).not.toContain('groupId');

    const serialized = JSON.stringify({
      stdout,
      listedAudit,
      auditSummary: auditRow.summary,
      auditDetails: auditRow.details,
    });
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-cli-display-profile-empty-global');
    expect(serialized).not.toContain('sk-cli-display-profile-empty-global-distractor');
    expect(serialized).not.toContain('qq-848484848');
    expect(serialized).not.toContain('qq-959595959');
    expect(serialized).not.toContain('848484848');
    expect(serialized).not.toContain('959595959');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns display profile redaction with partial assignment-shaped row matches without leaking raw keys', () => {
    const now = Date.now();
    const rawUserId = 'api_key=sk-cli-display-profile-partial-user-qq-121212121';
    const rawGroupId = 'api_key=sk-cli-display-profile-partial-group-qq-232323232';
    const distractorGroupId = 'api_key=sk-cli-display-profile-partial-distractor-qq-343434343';

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      rawUserId,
      now,
      now
    );
    db.prepare(
      `INSERT INTO display_profiles (
        canonical_user_id, source_group_id, current_display_name, observed_at, trust
      ) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
    ).run(
      rawUserId,
      rawGroupId,
      `Assignment shaped partial display ${rawUserId} ${rawGroupId}`,
      now,
      'platform_provided',
      rawUserId,
      distractorGroupId,
      `Assignment shaped partial distractor display ${distractorGroupId}`,
      now,
      'platform_provided'
    );
    db.prepare(
      `INSERT INTO nickname_history (
        id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'nick-cli-redact-assignment-partial-distractor',
      rawUserId,
      distractorGroupId,
      `Assignment shaped partial distractor old card ${distractorGroupId}`,
      now,
      null
    );

    const stdout = expectSuccessfulCli([
      'redact-display-profile',
      rawUserId,
      '--group',
      rawGroupId,
    ]);
    expect(stdout).toContain('Redacted 1 display profile/nickname rows for');
    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');

    const listedAudit = JSON.parse(
      expectSuccessfulCli([
        'list-audit',
        '--event-type',
        'display_profile.redact',
        '--event-id',
        `${rawUserId}:${rawGroupId}`,
        '--include-details',
      ])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: {
        canonicalUserId?: string;
        groupId?: string;
        displayProfilesUpdated?: number;
        nicknameHistoryUpdated?: number;
      };
    }>;
    expect(listedAudit).toEqual([
      expect.objectContaining({
        eventId: expect.stringContaining('[REDACTED:api_key_assignment]'),
        summary: expect.stringContaining('[REDACTED:api_key_assignment]'),
        details: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:api_key_assignment]'),
          groupId: expect.stringContaining('[REDACTED:api_key_assignment]'),
          displayProfilesUpdated: 1,
          nicknameHistoryUpdated: 0,
        }),
      }),
    ]);
    expect(listedAudit[0]?.eventId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details?.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details?.groupId).toContain('[REDACTED:platform_id]');

    const targetDisplayRow = db
      .prepare(
        `SELECT current_display_name, trust
         FROM display_profiles
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, rawGroupId) as { current_display_name: string; trust: string };
    expect(targetDisplayRow).toEqual({
      current_display_name: '[redacted]',
      trust: 'user_set',
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM nickname_history
           WHERE canonical_user_id = ? AND source_group_id = ?`
        )
        .get(rawUserId, rawGroupId)
    ).toEqual({ count: 0 });

    const distractorDisplayRow = db
      .prepare(
        `SELECT current_display_name, trust
         FROM display_profiles
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { current_display_name: string; trust: string };
    expect(distractorDisplayRow).toEqual({
      current_display_name: `Assignment shaped partial distractor display ${distractorGroupId}`,
      trust: 'platform_provided',
    });
    const distractorNicknameRow = db
      .prepare(
        `SELECT display_name, observed_until
         FROM nickname_history
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { display_name: string; observed_until: number | null };
    expect(distractorNicknameRow).toEqual({
      display_name: `Assignment shaped partial distractor old card ${distractorGroupId}`,
      observed_until: null,
    });

    const auditRow = db
      .prepare(
        `SELECT event_id, summary, details, redacted
         FROM audit_log
         WHERE event_type = ? AND event_id = ?`
      )
      .get('display_profile.redact', `${rawUserId}:${rawGroupId}`) as {
      event_id: string;
      summary: string;
      details: string;
      redacted: number;
    };
    expect(auditRow.event_id).toBe(`${rawUserId}:${rawGroupId}`);
    expect(auditRow.redacted).toBe(1);
    expect(auditRow.summary).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.summary).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.details).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('"displayProfilesUpdated":1');
    expect(auditRow.details).toContain('"nicknameHistoryUpdated":0');

    const serialized = JSON.stringify({
      stdout,
      listedAudit,
      auditSummary: auditRow.summary,
      auditDetails: auditRow.details,
    });
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-cli-display-profile-partial-user');
    expect(serialized).not.toContain('sk-cli-display-profile-partial-group');
    expect(serialized).not.toContain('sk-cli-display-profile-partial-distractor');
    expect(serialized).not.toContain('qq-121212121');
    expect(serialized).not.toContain('qq-232323232');
    expect(serialized).not.toContain('qq-343434343');
    expect(serialized).not.toContain('121212121');
    expect(serialized).not.toContain('232323232');
    expect(serialized).not.toContain('343434343');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns display profile redaction with nickname-history-only assignment-shaped row matches without leaking raw keys', () => {
    const now = Date.now();
    const rawUserId = 'api_key=sk-cli-display-profile-history-only-user-qq-454545454';
    const rawGroupId = 'api_key=sk-cli-display-profile-history-only-group-qq-565656565';
    const distractorGroupId =
      'api_key=sk-cli-display-profile-history-only-distractor-qq-676767676';

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      rawUserId,
      now,
      now
    );
    db.prepare(
      `INSERT INTO display_profiles (
        canonical_user_id, source_group_id, current_display_name, observed_at, trust
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      rawUserId,
      distractorGroupId,
      `Assignment shaped history-only distractor display ${distractorGroupId}`,
      now,
      'platform_provided'
    );
    db.prepare(
      `INSERT INTO nickname_history (
        id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
      ) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`
    ).run(
      'nick-cli-redact-assignment-history-only-target',
      rawUserId,
      rawGroupId,
      `Assignment shaped history-only old card ${rawUserId} ${rawGroupId}`,
      now,
      null,
      'nick-cli-redact-assignment-history-only-distractor',
      rawUserId,
      distractorGroupId,
      `Assignment shaped history-only distractor old card ${distractorGroupId}`,
      now,
      null
    );

    const stdout = expectSuccessfulCli([
      'redact-display-profile',
      rawUserId,
      '--group',
      rawGroupId,
    ]);
    expect(stdout).toContain('Redacted 1 display profile/nickname rows for');
    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');

    const listedAudit = JSON.parse(
      expectSuccessfulCli([
        'list-audit',
        '--event-type',
        'display_profile.redact',
        '--event-id',
        `${rawUserId}:${rawGroupId}`,
        '--include-details',
      ])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: {
        canonicalUserId?: string;
        groupId?: string;
        displayProfilesUpdated?: number;
        nicknameHistoryUpdated?: number;
      };
    }>;
    expect(listedAudit).toEqual([
      expect.objectContaining({
        eventId: expect.stringContaining('[REDACTED:api_key_assignment]'),
        summary: expect.stringContaining('[REDACTED:api_key_assignment]'),
        details: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:api_key_assignment]'),
          groupId: expect.stringContaining('[REDACTED:api_key_assignment]'),
          displayProfilesUpdated: 0,
          nicknameHistoryUpdated: 1,
        }),
      }),
    ]);
    expect(listedAudit[0]?.eventId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details?.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details?.groupId).toContain('[REDACTED:platform_id]');

    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM display_profiles
           WHERE canonical_user_id = ? AND source_group_id = ?`
        )
        .get(rawUserId, rawGroupId)
    ).toEqual({ count: 0 });

    const targetNicknameRow = db
      .prepare(
        `SELECT display_name, observed_until
         FROM nickname_history
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, rawGroupId) as { display_name: string; observed_until: number | null };
    expect(targetNicknameRow).toEqual({
      display_name: '[redacted]',
      observed_until: expect.any(Number),
    });

    const distractorDisplayRow = db
      .prepare(
        `SELECT current_display_name, trust
         FROM display_profiles
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { current_display_name: string; trust: string };
    expect(distractorDisplayRow).toEqual({
      current_display_name: `Assignment shaped history-only distractor display ${distractorGroupId}`,
      trust: 'platform_provided',
    });
    const distractorNicknameRow = db
      .prepare(
        `SELECT display_name, observed_until
         FROM nickname_history
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { display_name: string; observed_until: number | null };
    expect(distractorNicknameRow).toEqual({
      display_name: `Assignment shaped history-only distractor old card ${distractorGroupId}`,
      observed_until: null,
    });

    const auditRow = db
      .prepare(
        `SELECT event_id, summary, details, redacted
         FROM audit_log
         WHERE event_type = ? AND event_id = ?`
      )
      .get('display_profile.redact', `${rawUserId}:${rawGroupId}`) as {
      event_id: string;
      summary: string;
      details: string;
      redacted: number;
    };
    expect(auditRow.event_id).toBe(`${rawUserId}:${rawGroupId}`);
    expect(auditRow.redacted).toBe(1);
    expect(auditRow.summary).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.summary).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.details).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('"displayProfilesUpdated":0');
    expect(auditRow.details).toContain('"nicknameHistoryUpdated":1');

    const serialized = JSON.stringify({
      stdout,
      listedAudit,
      auditSummary: auditRow.summary,
      auditDetails: auditRow.details,
    });
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-cli-display-profile-history-only-user');
    expect(serialized).not.toContain('sk-cli-display-profile-history-only-group');
    expect(serialized).not.toContain('sk-cli-display-profile-history-only-distractor');
    expect(serialized).not.toContain('qq-454545454');
    expect(serialized).not.toContain('qq-565656565');
    expect(serialized).not.toContain('qq-676767676');
    expect(serialized).not.toContain('454545454');
    expect(serialized).not.toContain('565656565');
    expect(serialized).not.toContain('676767676');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns unscoped display profile redaction with partial assignment-shaped row matches without leaking raw keys', () => {
    const now = Date.now();
    const rawUserId = 'api_key=sk-cli-display-profile-global-partial-user-qq-787878787';
    const distractorGroupId =
      'api_key=sk-cli-display-profile-global-partial-distractor-qq-898989898';

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      rawUserId,
      now,
      now
    );
    db.prepare(
      `INSERT INTO display_profiles (
        canonical_user_id, source_group_id, current_display_name, observed_at, trust
      ) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
    ).run(
      rawUserId,
      '',
      `Assignment shaped global partial display ${rawUserId}`,
      now,
      'platform_provided',
      rawUserId,
      distractorGroupId,
      `Assignment shaped global partial distractor display ${distractorGroupId}`,
      now,
      'platform_provided'
    );
    db.prepare(
      `INSERT INTO nickname_history (
        id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'nick-cli-redact-assignment-global-partial-distractor',
      rawUserId,
      distractorGroupId,
      `Assignment shaped global partial distractor old card ${distractorGroupId}`,
      now,
      null
    );

    const stdout = expectSuccessfulCli(['redact-display-profile', rawUserId]);
    expect(stdout).toContain('Redacted 1 display profile/nickname rows for');
    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');

    const listedAudit = JSON.parse(
      expectSuccessfulCli([
        'list-audit',
        '--event-type',
        'display_profile.redact',
        '--event-id',
        `${rawUserId}:`,
        '--include-details',
      ])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: {
        canonicalUserId?: string;
        groupId?: string;
        displayProfilesUpdated?: number;
        nicknameHistoryUpdated?: number;
      };
    }>;
    expect(listedAudit).toEqual([
      expect.objectContaining({
        eventId: expect.stringContaining('[REDACTED:api_key_assignment]'),
        summary: expect.stringContaining('[REDACTED:api_key_assignment]'),
        details: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:api_key_assignment]'),
          displayProfilesUpdated: 1,
          nicknameHistoryUpdated: 0,
        }),
      }),
    ]);
    expect(listedAudit[0]?.eventId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details?.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details).not.toHaveProperty('groupId');

    const targetDisplayRow = db
      .prepare(
        `SELECT current_display_name, trust
         FROM display_profiles
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, '') as { current_display_name: string; trust: string };
    expect(targetDisplayRow).toEqual({
      current_display_name: '[redacted]',
      trust: 'user_set',
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM nickname_history
           WHERE canonical_user_id = ? AND source_group_id = ?`
        )
        .get(rawUserId, '')
    ).toEqual({ count: 0 });

    const distractorDisplayRow = db
      .prepare(
        `SELECT current_display_name, trust
         FROM display_profiles
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { current_display_name: string; trust: string };
    expect(distractorDisplayRow).toEqual({
      current_display_name: `Assignment shaped global partial distractor display ${distractorGroupId}`,
      trust: 'platform_provided',
    });
    const distractorNicknameRow = db
      .prepare(
        `SELECT display_name, observed_until
         FROM nickname_history
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { display_name: string; observed_until: number | null };
    expect(distractorNicknameRow).toEqual({
      display_name: `Assignment shaped global partial distractor old card ${distractorGroupId}`,
      observed_until: null,
    });

    const auditRow = db
      .prepare(
        `SELECT event_id, summary, details, redacted
         FROM audit_log
         WHERE event_type = ? AND event_id = ?`
      )
      .get('display_profile.redact', `${rawUserId}:`) as {
      event_id: string;
      summary: string;
      details: string;
      redacted: number;
    };
    expect(auditRow.event_id).toBe(`${rawUserId}:`);
    expect(auditRow.redacted).toBe(1);
    expect(auditRow.summary).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.summary).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.details).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('"displayProfilesUpdated":1');
    expect(auditRow.details).toContain('"nicknameHistoryUpdated":0');
    expect(auditRow.details).not.toContain('groupId');

    const serialized = JSON.stringify({
      stdout,
      listedAudit,
      auditSummary: auditRow.summary,
      auditDetails: auditRow.details,
    });
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-cli-display-profile-global-partial-user');
    expect(serialized).not.toContain('sk-cli-display-profile-global-partial-distractor');
    expect(serialized).not.toContain('qq-787878787');
    expect(serialized).not.toContain('qq-898989898');
    expect(serialized).not.toContain('787878787');
    expect(serialized).not.toContain('898989898');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns unscoped display profile redaction with nickname-history-only assignment-shaped row matches without leaking raw keys', () => {
    const now = Date.now();
    const rawUserId = 'api_key=sk-cli-display-profile-global-history-user-qq-909090909';
    const distractorGroupId =
      'api_key=sk-cli-display-profile-global-history-distractor-qq-919191919';

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(
      rawUserId,
      now,
      now
    );
    db.prepare(
      `INSERT INTO display_profiles (
        canonical_user_id, source_group_id, current_display_name, observed_at, trust
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      rawUserId,
      distractorGroupId,
      `Assignment shaped global history distractor display ${distractorGroupId}`,
      now,
      'platform_provided'
    );
    db.prepare(
      `INSERT INTO nickname_history (
        id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
      ) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`
    ).run(
      'nick-cli-redact-assignment-global-history-target',
      rawUserId,
      '',
      `Assignment shaped global history old card ${rawUserId}`,
      now,
      null,
      'nick-cli-redact-assignment-global-history-distractor',
      rawUserId,
      distractorGroupId,
      `Assignment shaped global history distractor old card ${distractorGroupId}`,
      now,
      null
    );

    const stdout = expectSuccessfulCli(['redact-display-profile', rawUserId]);
    expect(stdout).toContain('Redacted 1 display profile/nickname rows for');
    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');

    const listedAudit = JSON.parse(
      expectSuccessfulCli([
        'list-audit',
        '--event-type',
        'display_profile.redact',
        '--event-id',
        `${rawUserId}:`,
        '--include-details',
      ])
    ) as Array<{
      eventId: string;
      summary: string;
      details?: {
        canonicalUserId?: string;
        groupId?: string;
        displayProfilesUpdated?: number;
        nicknameHistoryUpdated?: number;
      };
    }>;
    expect(listedAudit).toEqual([
      expect.objectContaining({
        eventId: expect.stringContaining('[REDACTED:api_key_assignment]'),
        summary: expect.stringContaining('[REDACTED:api_key_assignment]'),
        details: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:api_key_assignment]'),
          displayProfilesUpdated: 0,
          nicknameHistoryUpdated: 1,
        }),
      }),
    ]);
    expect(listedAudit[0]?.eventId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details?.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(listedAudit[0]?.details).not.toHaveProperty('groupId');

    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM display_profiles
           WHERE canonical_user_id = ? AND source_group_id = ?`
        )
        .get(rawUserId, '')
    ).toEqual({ count: 0 });

    const targetNicknameRow = db
      .prepare(
        `SELECT display_name, observed_until
         FROM nickname_history
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, '') as { display_name: string; observed_until: number | null };
    expect(targetNicknameRow).toEqual({
      display_name: '[redacted]',
      observed_until: expect.any(Number),
    });

    const distractorDisplayRow = db
      .prepare(
        `SELECT current_display_name, trust
         FROM display_profiles
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { current_display_name: string; trust: string };
    expect(distractorDisplayRow).toEqual({
      current_display_name: `Assignment shaped global history distractor display ${distractorGroupId}`,
      trust: 'platform_provided',
    });
    const distractorNicknameRow = db
      .prepare(
        `SELECT display_name, observed_until
         FROM nickname_history
         WHERE canonical_user_id = ? AND source_group_id = ?`
      )
      .get(rawUserId, distractorGroupId) as { display_name: string; observed_until: number | null };
    expect(distractorNicknameRow).toEqual({
      display_name: `Assignment shaped global history distractor old card ${distractorGroupId}`,
      observed_until: null,
    });

    const auditRow = db
      .prepare(
        `SELECT event_id, summary, details, redacted
         FROM audit_log
         WHERE event_type = ? AND event_id = ?`
      )
      .get('display_profile.redact', `${rawUserId}:`) as {
      event_id: string;
      summary: string;
      details: string;
      redacted: number;
    };
    expect(auditRow.event_id).toBe(`${rawUserId}:`);
    expect(auditRow.redacted).toBe(1);
    expect(auditRow.summary).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.summary).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.details).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).toContain('"displayProfilesUpdated":0');
    expect(auditRow.details).toContain('"nicknameHistoryUpdated":1');
    expect(auditRow.details).not.toContain('groupId');

    const serialized = JSON.stringify({
      stdout,
      listedAudit,
      auditSummary: auditRow.summary,
      auditDetails: auditRow.details,
    });
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-cli-display-profile-global-history-user');
    expect(serialized).not.toContain('sk-cli-display-profile-global-history-distractor');
    expect(serialized).not.toContain('qq-909090909');
    expect(serialized).not.toContain('qq-919191919');
    expect(serialized).not.toContain('909090909');
    expect(serialized).not.toContain('919191919');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns event failure inspection with hashed diagnostics and governance health counts', () => {
    const now = Date.now();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('evt-cli-failure', 'chat.message.received', now, 'gateway', 'qq', 'private:qq-cli-failure', '{}', now);
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, response_text, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-failure',
      'private:qq-cli-failure',
      'evt-cli-failure',
      'ctx-cli-failure',
      'mock',
      'mock',
      'failed',
      'failed',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO event_processing_failures (
        id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
        error_name, error_message_hash, message_id_hash, sender_id_hash,
        conversation_id_hash, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'failure-cli-inspect',
      'evt-cli-failure',
      'turn-cli-failure',
      now,
      'pi_inference',
      'private',
      'Error',
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      JSON.stringify({
        redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error',
        diagnostic: `api_key=${secret}`,
      }),
    );

    const stdout = expectSuccessfulCli([
      'list-event-failures',
      '--stage',
      'pi_inference',
      '--turn',
      'turn-cli-failure',
      '--include-details',
    ]);
    const rows = JSON.parse(stdout) as Array<{
      id: string;
      rawEventId: string;
      turnId: string;
      stage: string;
      conversationType: string;
      errorName: string;
      errorMessageHash: string;
      messageIdHash: string;
      senderIdHash: string;
      conversationIdHash: string;
      details?: { diagnostic?: string };
    }>;

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'failure-cli-inspect',
        rawEventId: 'evt-cli-failure',
        turnId: 'turn-cli-failure',
        stage: 'pi_inference',
        conversationType: 'private',
        errorName: 'Error',
        errorMessageHash: 'a'.repeat(64),
        messageIdHash: 'b'.repeat(64),
        senderIdHash: 'c'.repeat(64),
        conversationIdHash: 'd'.repeat(64),
      }),
    ]);
    expect(rows[0]?.details?.diagnostic).toContain('[REDACTED');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain('qq-cli-failure');

    const health = JSON.parse(expectSuccessfulCli(['summarize-governance-health'])) as {
      eventProcessing: {
        failuresTotal: number;
        byStage: Record<string, number>;
        byConversationType: Record<string, number>;
      };
      attention: { eventProcessingFailures: number };
    };
    expect(health.eventProcessing).toMatchObject({
      failuresTotal: 1,
      byStage: { pi_inference: 1 },
      byConversationType: { private: 1 },
    });
    expect(health.attention.eventProcessingFailures).toBe(1);

    reopenDb();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns governance health with assignment-shaped adjacent aggregate-key redaction', () => {
    const now = Date.now();
    const assignmentSecretPlatform = 'api_key=sk-cli-health-assignment-secret-qq-246813579';
    const actionType = `reply-${assignmentSecretPlatform}`;
    const auditEventType = `audit.${assignmentSecretPlatform}`;
    const auditRiskLevel = `risk-${assignmentSecretPlatform}`;
    const jobType = `summary-${assignmentSecretPlatform}`;
    const workerType = `background-${assignmentSecretPlatform}`;
    const eventFailureStage = `pi-${assignmentSecretPlatform}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-health-assignment-key',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:qq-health-assignment',
      '{}',
      now
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, response_text, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-health-assignment-key',
      'private:qq-health-assignment',
      'evt-cli-health-assignment-key',
      'ctx-cli-health-assignment-key',
      'mock',
      'mock',
      'ok',
      'completed',
      now,
      now
    );
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'decision-cli-health-assignment-key',
      'turn-cli-health-assignment-key',
      'evaluator',
      'medium',
      0.8,
      1,
      1,
      '[]',
      '[]',
      '[]',
      now
    );
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status, audit_level, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      'execution-cli-health-assignment-key',
      'decision-cli-health-assignment-key',
      actionType,
      'success',
      'summary',
      now
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-health-assignment-key',
      now,
      'system',
      'summary',
      auditEventType,
      'audit-event-cli-health-assignment-key',
      'system',
      'system',
      'assignment-shaped health aggregate key audit',
      1,
      auditRiskLevel
    );
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        created_at, updated_at, scheduled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('job-cli-health-assignment-key', jobType, '{}', 'pending', 0, 3, now, now, now);
    db.prepare(
      `INSERT INTO worker_heartbeats (
        worker_id, worker_type, status, heartbeat_at, details
      ) VALUES (?, ?, ?, ?, ?)`
    ).run('worker-cli-health-assignment-key', workerType, 'idle', now, '{}');
    db.prepare(
      `INSERT INTO event_processing_failures (
        id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
        error_name, error_message_hash, message_id_hash, sender_id_hash,
        conversation_id_hash, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'failure-cli-health-assignment-key',
      'evt-cli-health-assignment-key',
      'turn-cli-health-assignment-key',
      now,
      eventFailureStage,
      'private',
      'Error',
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      '{}'
    );

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
    };

    const stdout = expectSuccessfulCli(['summarize-governance-health']);
    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(assignmentSecretPlatform);
    expect(stdout).not.toContain('api_key=');
    expect(stdout).not.toContain('sk-cli-health-assignment-secret');
    expect(stdout).not.toContain('qq-246813579');
    expect(stdout).not.toContain('246813579');

    const health = JSON.parse(stdout) as {
      actions: { executions: { byActionType: Record<string, number> } };
      audit: {
        byRiskLevel: Record<string, number>;
        byEventType: Record<string, number>;
      };
      jobs: { byType: Record<string, number> };
      workerHeartbeats: { byWorkerType: Record<string, number> };
      eventProcessing: { byStage: Record<string, number> };
    };
    for (const counts of [
      health.actions.executions.byActionType,
      health.audit.byRiskLevel,
      health.audit.byEventType,
      health.jobs.byType,
      health.workerHeartbeats.byWorkerType,
      health.eventProcessing.byStage,
    ]) {
      const keys = Object.keys(counts);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toContain('[REDACTED:api_key_assignment]');
      expect(keys[0]).toContain('[REDACTED:platform_id]');
      expect(counts[keys[0] as string]).toBe(1);
    }

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      eventFailures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns event failure filter variants without cross-returning diagnostics or mutating data', () => {
    const now = Date.now();
    const secret = 'sk-defghijklmnopqrstuvwxyz123456789';
    const otherSecret = 'sk-efghijklmnopqrstuvwxyz123456789a';

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-failure-filter-match',
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:qq-123456789',
      JSON.stringify({ rawMessage: 'matching raw text must stay in raw_events only' }),
      now,
      'evt-cli-failure-filter-other',
      'chat.message.received',
      now + 1,
      'gateway',
      'qq',
      'group:qq-group-987654321',
      JSON.stringify({ rawMessage: `other raw text ${otherSecret}` }),
      now + 1
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, response_text, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-failure-filter-match',
      'private:qq-123456789',
      'evt-cli-failure-filter-match',
      'ctx-cli-failure-filter-match',
      'mock',
      'mock',
      'failed',
      'failed',
      now,
      now,
      'turn-cli-failure-filter-other',
      'group:qq-group-987654321',
      'evt-cli-failure-filter-other',
      'ctx-cli-failure-filter-other',
      'mock',
      'mock',
      'failed',
      'failed',
      now + 1,
      now + 1
    );
    db.prepare(
      `INSERT INTO event_processing_failures (
        id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
        error_name, error_message_hash, message_id_hash, sender_id_hash,
        conversation_id_hash, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'failure-cli-filter-match',
      'evt-cli-failure-filter-match',
      'turn-cli-failure-filter-match',
      now,
      'pi_inference',
      'private',
      'ProviderError',
      '1'.repeat(64),
      '2'.repeat(64),
      '3'.repeat(64),
      '4'.repeat(64),
      JSON.stringify({
        redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error',
        diagnostic: `matching diagnostic token=${secret}`,
      }),
      'failure-cli-filter-other',
      'evt-cli-failure-filter-other',
      'turn-cli-failure-filter-other',
      now + 1,
      'action_execution',
      'group',
      'ActionError',
      '5'.repeat(64),
      '6'.repeat(64),
      '7'.repeat(64),
      '8'.repeat(64),
      JSON.stringify({
        redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error',
        diagnostic: `other diagnostic token=${otherSecret}`,
      })
    );

    const stdout = expectSuccessfulCli([
      'list-event-failures',
      '--stage',
      'pi_inference',
      '--raw-event',
      'evt-cli-failure-filter-match',
      '--include-details',
    ]);
    const rows = JSON.parse(stdout) as Array<{
      id: string;
      rawEventId: string;
      turnId: string;
      stage: string;
      conversationType: string;
      errorName: string;
      errorMessageHash: string;
      messageIdHash: string;
      senderIdHash: string;
      conversationIdHash: string;
      details?: { diagnostic?: string; redaction?: string };
    }>;

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'failure-cli-filter-match',
        rawEventId: 'evt-cli-failure-filter-match',
        turnId: 'turn-cli-failure-filter-match',
        stage: 'pi_inference',
        conversationType: 'private',
        errorName: 'ProviderError',
        errorMessageHash: '1'.repeat(64),
        messageIdHash: '2'.repeat(64),
        senderIdHash: '3'.repeat(64),
        conversationIdHash: '4'.repeat(64),
        details: expect.objectContaining({
          diagnostic: expect.stringContaining('[REDACTED:'),
          redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error',
        }),
      }),
    ]);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(otherSecret);
    expect(serialized).not.toContain('failure-cli-filter-other');
    expect(serialized).not.toContain('turn-cli-failure-filter-other');
    expect(serialized).not.toContain('evt-cli-failure-filter-other');
    expect(serialized).not.toContain('action_execution');
    expect(serialized).not.toContain('group');
    expect(serialized).not.toContain('qq-123456789');
    expect(serialized).not.toContain('qq-group-987654321');
    expect(serialized).not.toContain('matching raw text must stay in raw_events only');
    expect(serialized).not.toContain('other raw text');

    const noMatch = JSON.parse(expectSuccessfulCli([
      'list-event-failures',
      '--stage',
      'pi_inference',
      '--raw-event',
      'evt-cli-failure-filter-other',
    ])) as unknown[];
    expect(noMatch).toEqual([]);

    reopenDb();
    const failureCount = db
      .prepare('SELECT COUNT(*) AS count FROM event_processing_failures')
      .get() as { count: number };
    const rawEventCount = db
      .prepare('SELECT COUNT(*) AS count FROM raw_events WHERE id LIKE ?')
      .get('evt-cli-failure-filter-%') as { count: number };
    const auditCount = db
      .prepare('SELECT COUNT(*) AS count FROM audit_log WHERE event_id LIKE ?')
      .get('failure-cli-filter-%') as { count: number };
    expect(failureCount.count).toBe(2);
    expect(rawEventCount.count).toBe(2);
    expect(auditCount.count).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns event failure inspection with redacted platform-like internal IDs while preserving raw filters', () => {
    const now = Date.now();
    const rawEventId = 'qq-123456789';
    const turnId = 'turn-qq-234567890';
    const failureId = 'failure-qq-345678901';
    const otherRawEventId = 'qq-987654321';
    const otherTurnId = 'turn-qq-876543210';
    const otherFailureId = 'failure-qq-765432109';

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rawEventId,
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:qq-redacted-failure',
      '{}',
      now,
      otherRawEventId,
      'chat.message.received',
      now + 1,
      'gateway',
      'qq',
      'private:qq-redacted-failure-other',
      '{}',
      now + 1
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, response_text, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      turnId,
      'private:qq-redacted-failure',
      rawEventId,
      'ctx-cli-redacted-failure',
      'mock',
      'mock',
      'failed',
      'failed',
      now,
      now,
      otherTurnId,
      'private:qq-redacted-failure-other',
      otherRawEventId,
      'ctx-cli-redacted-failure-other',
      'mock',
      'mock',
      'failed',
      'failed',
      now + 1,
      now + 1
    );
    db.prepare(
      `INSERT INTO event_processing_failures (
        id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
        error_name, error_message_hash, message_id_hash, sender_id_hash,
        conversation_id_hash, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      failureId,
      rawEventId,
      turnId,
      now,
      'pi_inference',
      'private',
      'ProviderError',
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      JSON.stringify({ redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error' }),
      otherFailureId,
      otherRawEventId,
      otherTurnId,
      now + 1,
      'action_execution',
      'private',
      'ActionError',
      'e'.repeat(64),
      'f'.repeat(64),
      '0'.repeat(64),
      '1'.repeat(64),
      JSON.stringify({ redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error' })
    );

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      failures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const rows = JSON.parse(expectSuccessfulCli([
      'list-event-failures',
      '--stage',
      'pi_inference',
      '--raw-event',
      rawEventId,
      '--turn',
      turnId,
    ])) as Array<{
      id: string;
      rawEventId: string;
      turnId: string;
      stage: string;
      errorMessageHash: string;
    }>;

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'failure-[REDACTED:platform_id]',
        rawEventId: '[REDACTED:platform_id]',
        turnId: 'turn-[REDACTED:platform_id]',
        stage: 'pi_inference',
        errorMessageHash: 'a'.repeat(64),
      }),
    ]);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(rawEventId);
    expect(serialized).not.toContain(turnId);
    expect(serialized).not.toContain(failureId);
    expect(serialized).not.toContain(otherRawEventId);
    expect(serialized).not.toContain(otherTurnId);
    expect(serialized).not.toContain(otherFailureId);
    expect(serialized).toContain('[REDACTED:platform_id]');

    const noMatch = JSON.parse(expectSuccessfulCli([
      'list-event-failures',
      '--stage',
      'pi_inference',
      '--raw-event',
      otherRawEventId,
    ])) as unknown[];
    expect(noMatch).toEqual([]);

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      failures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns event failure inspection with redacted legacy stage values while preserving raw filters', () => {
    const now = Date.now();
    const secret = 'sk-hijklmnopqrstuvwxyz123456789abcd';
    const rawEventId = 'evt-cli-failure-stage-redaction';
    const turnId = 'turn-cli-failure-stage-redaction';
    const failureId = 'failure-cli-stage-redaction';
    const legacyStage = `pi_inference-${secret}-qq-123456789`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rawEventId,
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:qq-stage-redaction',
      '{}',
      now
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, response_text, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      turnId,
      'private:qq-stage-redaction',
      rawEventId,
      'ctx-cli-stage-redaction',
      'mock',
      'mock',
      'failed',
      'failed',
      now,
      now
    );
    db.prepare(
      `INSERT INTO event_processing_failures (
        id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
        error_name, error_message_hash, message_id_hash, sender_id_hash,
        conversation_id_hash, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      failureId,
      rawEventId,
      turnId,
      now,
      legacyStage,
      'private',
      'StageError',
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      JSON.stringify({ redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error' })
    );

    const beforeRows = db.prepare('SELECT * FROM event_processing_failures ORDER BY id ASC').all();
    const rows = JSON.parse(expectSuccessfulCli([
      'list-event-failures',
      '--raw-event',
      rawEventId,
    ])) as Array<{
      id: string;
      rawEventId: string;
      turnId: string;
      stage: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: failureId,
      rawEventId,
      turnId,
    });
    expect(rows[0]?.stage).toContain('[REDACTED:');

    const health = JSON.parse(expectSuccessfulCli(['summarize-governance-health'])) as {
      eventProcessing: { byStage: Record<string, number> };
    };
    expect(JSON.stringify(health.eventProcessing.byStage)).toContain('[REDACTED:');

    const serialized = `${JSON.stringify(rows)}\n${JSON.stringify(health)}`;
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain(legacyStage);
    expect(serialized).toContain('[REDACTED:');

    reopenDb();
    const afterRows = db.prepare('SELECT * FROM event_processing_failures ORDER BY id ASC').all();
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns event failure stage validation errors without leaking invalid values or mutating data', () => {
    const secret = 'sk-ghijklmnopqrstuvwxyz123456789abc';
    const invalidStage = `pi_inference-${secret}-qq-123456789`;
    const beforeCounts = {
      rawEvents: (db.prepare('SELECT COUNT(*) AS count FROM raw_events').get() as { count: number }).count,
      turns: (db.prepare('SELECT COUNT(*) AS count FROM agent_turns').get() as { count: number }).count,
      failures: (db.prepare('SELECT COUNT(*) AS count FROM event_processing_failures').get() as { count: number }).count,
      audit: (db.prepare('SELECT COUNT(*) AS count FROM audit_log').get() as { count: number }).count,
    };

    const result = runCli([
      'list-event-failures',
      '--stage',
      invalidStage,
      '--include-details',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('❌ Invalid event processing failure stage');
    expect(result.stderr).toContain('[REDACTED:');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain('123456789');
    expect(result.stderr).not.toContain('src/cli');
    expect(result.stderr).not.toContain('tests/integration');
    expect(result.stderr).not.toContain('\n    at ');
    expect(result.stderr).not.toContain('TypeError');

    reopenDb();
    const afterCounts = {
      rawEvents: (db.prepare('SELECT COUNT(*) AS count FROM raw_events').get() as { count: number }).count,
      turns: (db.prepare('SELECT COUNT(*) AS count FROM agent_turns').get() as { count: number }).count,
      failures: (db.prepare('SELECT COUNT(*) AS count FROM event_processing_failures').get() as { count: number }).count,
      audit: (db.prepare('SELECT COUNT(*) AS count FROM audit_log').get() as { count: number }).count,
    };
    expect(afterCounts).toEqual(beforeCounts);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns audit/action/tool/job inspection commands with payload redaction', () => {
    const now = Date.now();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const rawNumericSenderId = 1234567890;
    const rawNumericGroupId = 998877665;
    const rawNumericMessageId = 1122334455;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('evt-cli-inspect', 'message.private', now, 'gateway', 'qq', 'private:cli', '{}', now);
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('turn-cli-inspect', 'private:cli', 'evt-cli-inspect', 'ctx-cli', 'mock', 'mock', 'completed', now, now);
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'decision-cli-inspect',
      'turn-cli-inspect',
      'pi',
      'low',
      0.9,
      0,
      null,
      JSON.stringify([{ type: 'reply_full', payload: { text: `do not print ${secret}` } }]),
      JSON.stringify([`reason contains ${secret}`]),
      JSON.stringify([]),
      now
    );
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status,
        executed_message_id, audit_level, audit_entry, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'execution-cli-inspect',
      'decision-cli-inspect',
      'reply_full',
      'success',
      'msg-cli-bot',
      'summary',
      `audit contains api_key=${secret}`,
      now
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        execution_time_ms, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'tool-cli-inspect',
      'turn-cli-inspect',
      'read_file',
      JSON.stringify({ path: '/tmp/example', token: secret }),
      JSON.stringify({ text: `api_key=${secret}` }),
      'pi',
      'user-cli',
      'user',
      'private_chat',
      'success',
      12,
      0,
      now
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-inspect',
      now,
      'tool',
      'full',
      'tool.call',
      'tool-cli-inspect',
      'user-cli',
      'user',
      'private_chat',
      `summary token=${secret}`,
      JSON.stringify({
        output: `api_key=${secret}`,
        senderId: rawNumericSenderId,
        nested: {
          group_ids: [rawNumericGroupId],
          processedCount: 42,
        },
      }),
      0,
      'low'
    );

    const jobRepo = new JobRepository(db);
    const jobId = jobRepo.enqueue({
      type: 'summary',
      payload: { conversationId: 'private:cli', token: secret },
      idempotencyKey: `summary:${secret}`,
      now,
    });
    const claimed = jobRepo.claimNext({ workerId: 'worker-cli-inspect', now: now + 1 });
    if (!claimed) {
      throw new Error('Expected CLI inspection job to be claimed');
    }
    jobRepo.complete({
      jobId,
      attemptId: claimed.attemptId,
      result: {
        output: `api_key=${secret}`,
        senderId: rawNumericSenderId,
        nested: {
          group_ids: [rawNumericGroupId],
          messageId: rawNumericMessageId,
          processedCount: 42,
        },
      },
      now: now + 2,
    });
    jobRepo.heartbeat({
      workerId: 'worker-cli-inspect',
      workerType: 'background',
      status: 'idle',
      details: {
        token: secret,
        senderId: rawNumericSenderId,
        nested: {
          group_ids: [rawNumericGroupId],
          messageId: rawNumericMessageId,
          processedCount: 42,
        },
      },
      now: now + 3,
    });

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const outputs = [
      expectSuccessfulCli(['list-audit', '--include-details', '--event-id', 'tool-cli-inspect']),
      expectSuccessfulCli(['list-action-decisions', '--include-actions', '--turn', 'turn-cli-inspect']),
      expectSuccessfulCli(['list-action-executions', '--include-audit-entry', '--decision', 'decision-cli-inspect']),
      expectSuccessfulCli(['list-tool-calls', '--include-payload', '--turn', 'turn-cli-inspect']),
      expectSuccessfulCli(['list-jobs', '--include-payload', '--type', 'summary']),
      expectSuccessfulCli(['list-job-attempts', '--include-result', '--job', jobId]),
      expectSuccessfulCli(['list-worker-heartbeats', '--include-details', '--worker', 'worker-cli-inspect']),
      expectSuccessfulCli(['summarize-governance-health']),
    ];

    for (const output of outputs) {
      expect(() => JSON.parse(output)).not.toThrow();
    }

    const serialized = outputs.join('\n');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(String(rawNumericSenderId));
    expect(serialized).not.toContain(String(rawNumericGroupId));
    expect(serialized).not.toContain(String(rawNumericMessageId));
    expect(serialized).toContain('[REDACTED');

    const auditRows = JSON.parse(outputs[0] ?? '[]') as Array<{
      summary: string;
      details?: {
        output?: string;
        senderId?: string;
        nested?: { group_ids?: string[]; processedCount?: number };
      };
      detailsRedacted: boolean;
      redacted: boolean;
    }>;
    const actionDecisionRows = JSON.parse(outputs[1] ?? '[]') as Array<{
      actions?: Array<{ payload?: { text?: string } }>;
      reasons: string[];
    }>;
    const actionExecutionRows = JSON.parse(outputs[2] ?? '[]') as Array<{ auditEntry?: string }>;
    const toolRows = JSON.parse(outputs[3] ?? '[]') as Array<{
      input?: { token?: string };
      output?: { text?: string };
      secretsRedacted: boolean;
    }>;
    const jobRows = JSON.parse(outputs[4] ?? '[]') as Array<{
      payload?: { token?: string };
      result?: {
        output?: string;
        senderId?: string;
        nested?: { group_ids?: string[]; messageId?: string; processedCount?: number };
      };
      idempotencyKey?: string;
    }>;
    const attemptRows = JSON.parse(outputs[5] ?? '[]') as Array<{
      result?: {
        output?: string;
        senderId?: string;
        nested?: { group_ids?: string[]; messageId?: string; processedCount?: number };
      };
    }>;
    const heartbeatRows = JSON.parse(outputs[6] ?? '[]') as Array<{
      details?: {
        token?: string;
        senderId?: string;
        nested?: { group_ids?: string[]; messageId?: string; processedCount?: number };
      };
    }>;

    expect(auditRows).toEqual([
      expect.objectContaining({
        summary: expect.stringContaining('[REDACTED:'),
        details: expect.objectContaining({
          output: expect.stringContaining('[REDACTED:'),
          senderId: '[REDACTED:platform_id]',
          nested: expect.objectContaining({
            group_ids: ['[REDACTED:platform_id]'],
            processedCount: 42,
          }),
        }),
        detailsRedacted: true,
        redacted: true,
      }),
    ]);
    expect(actionDecisionRows[0]?.actions?.[0]?.payload?.text).toContain('[REDACTED:');
    expect(actionDecisionRows[0]?.reasons.join(' ')).toContain('[REDACTED:');
    expect(actionExecutionRows[0]?.auditEntry).toContain('[REDACTED:');
    expect(toolRows[0]).toEqual(expect.objectContaining({
      input: expect.objectContaining({ token: expect.stringContaining('[REDACTED:') }),
      output: expect.objectContaining({ text: expect.stringContaining('[REDACTED:') }),
      secretsRedacted: true,
    }));
    expect(jobRows[0]).toEqual(expect.objectContaining({
      payload: expect.objectContaining({ token: expect.stringContaining('[REDACTED:') }),
      result: expect.objectContaining({
        output: expect.stringContaining('[REDACTED:'),
        senderId: '[REDACTED:platform_id]',
        nested: expect.objectContaining({
          group_ids: ['[REDACTED:platform_id]'],
          messageId: '[REDACTED:platform_id]',
          processedCount: 42,
        }),
      }),
      idempotencyKey: expect.stringContaining('[REDACTED:'),
    }));
    expect(attemptRows[0]?.result?.output).toContain('[REDACTED:');
    expect(attemptRows[0]?.result?.senderId).toBe('[REDACTED:platform_id]');
    expect(attemptRows[0]?.result?.nested?.group_ids).toEqual(['[REDACTED:platform_id]']);
    expect(attemptRows[0]?.result?.nested?.messageId).toBe('[REDACTED:platform_id]');
    expect(attemptRows[0]?.result?.nested?.processedCount).toBe(42);
    expect(heartbeatRows[0]?.details?.token).toContain('[REDACTED:');
    expect(heartbeatRows[0]?.details?.senderId).toBe('[REDACTED:platform_id]');
    expect(heartbeatRows[0]?.details?.nested?.group_ids).toEqual(['[REDACTED:platform_id]']);
    expect(heartbeatRows[0]?.details?.nested?.messageId).toBe('[REDACTED:platform_id]');
    expect(heartbeatRows[0]?.details?.nested?.processedCount).toBe(42);

    const health = JSON.parse(outputs[outputs.length - 1] ?? '{}') as {
      actions: {
        decisions: { total: number; byDecidedBy: Record<string, number> };
        executions: { total: number; byStatus: Record<string, number> };
      };
      tools: { total: number; byStatus: Record<string, number> };
      jobs: { total: number; byStatus: Record<string, number> };
      workerHeartbeats: { total: number; byStatus: Record<string, number> };
      audit: { total: number; byCategory: Record<string, number> };
    };
    expect(health).toMatchObject({
      actions: {
        decisions: {
          total: 1,
          byDecidedBy: {
            pi: 1,
          },
        },
        executions: {
          total: 1,
          byStatus: {
            success: 1,
          },
        },
      },
      tools: {
        total: 1,
        byStatus: {
          success: 1,
        },
      },
      jobs: {
        total: 1,
        byStatus: {
          completed: 1,
        },
      },
      workerHeartbeats: {
        total: 1,
        byStatus: {
          idle: 1,
        },
      },
      audit: {
        total: 1,
        byCategory: {
          tool: 1,
        },
      },
    });

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns audit assignment-shaped include-details without leaking raw keys', () => {
    const now = Date.now();
    const secret = 'sk-cli-audit-assignment-secret-should-not-leak';
    const platformId = 'qq-234567891';
    const assignment = `api_key=${secret}-${platformId}`;
    const auditId = `audit-${assignment}`;
    const eventType = `tool.call.${assignment}`;
    const eventId = `event-${assignment}`;
    const actorUserId = `user-${assignment}`;
    const otherAssignment = 'api_key=sk-cli-audit-assignment-other-secret-qq-345678912';

    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context,
        summary, details, redacted, risk_level, evaluator_decision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      auditId,
      now,
      'tool',
      'full',
      eventType,
      eventId,
      actorUserId,
      `user-${assignment}`,
      `private_chat-${assignment}`,
      `audit summary ${assignment}`,
      JSON.stringify({
        [`diagnostic ${assignment}`]: {
          note: `audit detail ${assignment}`,
          ownerUserId: 234567891,
          processedCount: 42,
        },
      }),
      0,
      'high',
      `eval-${assignment}`,
      `audit-${otherAssignment}`,
      now + 1,
      'tool',
      'full',
      `tool.call.${otherAssignment}`,
      `event-${otherAssignment}`,
      `user-${otherAssignment}`,
      `user-${otherAssignment}`,
      `private_chat-${otherAssignment}`,
      `other audit summary ${otherAssignment}`,
      JSON.stringify({
        diagnostic: `other audit detail ${otherAssignment}`,
      }),
      0,
      'high',
      `eval-${otherAssignment}`
    );

    const beforeRows = {
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
    };

    const stdout = expectSuccessfulCli([
      'list-audit',
      '--category',
      'tool',
      '--event-type',
      eventType,
      '--event-id',
      eventId,
      '--user',
      actorUserId,
      '--include-details',
    ]);
    const rows = JSON.parse(stdout) as Array<{
      id: string;
      category: string;
      level: string;
      eventType: string;
      eventId: string;
      actor: {
        canonicalUserId?: string;
        actorClass?: string;
        context?: string;
      };
      summary: string;
      details?: Record<string, unknown>;
      detailsRedacted: boolean;
      redacted: boolean;
      riskLevel?: string;
      evaluatorDecisionId?: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      id: expect.stringContaining('[REDACTED:api_key_assignment]'),
      category: 'tool',
      level: 'full',
      eventType: expect.stringContaining('[REDACTED:api_key_assignment]'),
      eventId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      actor: expect.objectContaining({
        canonicalUserId: expect.stringContaining('[REDACTED:api_key_assignment]'),
        actorClass: expect.stringContaining('[REDACTED:api_key_assignment]'),
        context: expect.stringContaining('[REDACTED:api_key_assignment]'),
      }),
      summary: expect.stringContaining('[REDACTED:api_key_assignment]'),
      details: expect.any(Object),
      detailsRedacted: true,
      redacted: true,
      riskLevel: 'high',
      evaluatorDecisionId: expect.stringContaining('[REDACTED:api_key_assignment]'),
    }));
    expect(rows[0]?.id).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.eventType).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.eventId).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.actor.canonicalUserId).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.actor.actorClass).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.actor.context).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.summary).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.evaluatorDecisionId).toContain('[REDACTED:platform_id]');
    const detailKeys = Object.keys(rows[0]?.details ?? {});
    expect(detailKeys.some((key) => key.includes('[REDACTED:api_key_assignment]'))).toBe(true);
    expect(detailKeys.some((key) => key.includes('[REDACTED:platform_id]'))).toBe(true);

    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(platformId);
    expect(stdout).not.toContain('234567891');
    expect(stdout).not.toContain(otherAssignment);
    expect(stdout).not.toContain('345678912');
    expect(stdout).not.toContain('src/');
    expect(stdout).not.toContain('\n    at ');

    reopenDb();
    const afterRows = {
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns worker heartbeat include-details with redacted prefixed numeric platform IDs', () => {
    const now = Date.now();
    const secret = 'sk-cli-heartbeat-prefixed-numeric-secret';
    const targetUserId = 1234567890;
    const recipientGroupId = 2345678901;
    const ownerMessageId = 3456789012;

    const jobRepo = new JobRepository(db);
    jobRepo.heartbeat({
      workerId: 'worker-cli-prefixed-numeric-details',
      workerType: 'background',
      status: 'idle',
      details: {
        token: `api_key=${secret}`,
        targetUserId,
        nested: {
          recipientGroupIds: [recipientGroupId],
          ownerMessageId,
          processedCount: 42,
        },
      },
      now,
    });

    const beforeRows = {
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const stdout = expectSuccessfulCli([
      'list-worker-heartbeats',
      '--worker',
      'worker-cli-prefixed-numeric-details',
      '--include-details',
    ]);
    const rows = JSON.parse(stdout) as Array<{
      workerId: string;
      workerType: string;
      status: string;
      details?: {
        token?: string;
        targetUserId?: string;
        nested?: {
          recipientGroupIds?: string[];
          ownerMessageId?: string;
          processedCount?: number;
        };
      };
    }>;

    expect(rows).toEqual([
      expect.objectContaining({
        workerId: 'worker-cli-prefixed-numeric-details',
        workerType: 'background',
        status: 'idle',
        details: expect.objectContaining({
          token: '[REDACTED:api_key_assignment]',
          targetUserId: '[REDACTED:platform_id]',
          nested: expect.objectContaining({
            recipientGroupIds: ['[REDACTED:platform_id]'],
            ownerMessageId: '[REDACTED:platform_id]',
            processedCount: 42,
          }),
        }),
      }),
    ]);

    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(String(targetUserId));
    expect(stdout).not.toContain(String(recipientGroupId));
    expect(stdout).not.toContain(String(ownerMessageId));
    expect(stdout).not.toContain('src/');
    expect(stdout).not.toContain('at ');

    reopenDb();
    const rawDetails = db
      .prepare('SELECT details FROM worker_heartbeats WHERE worker_id = ?')
      .get('worker-cli-prefixed-numeric-details') as { details: string };
    expect(rawDetails.details).toContain('[REDACTED:api_key_assignment]');
    expect(rawDetails.details).not.toContain(secret);
    expect(rawDetails.details).toContain('[REDACTED:platform_id]');
    expect(rawDetails.details).not.toContain(String(targetUserId));
    expect(rawDetails.details).not.toContain(String(recipientGroupId));
    expect(rawDetails.details).not.toContain(String(ownerMessageId));

    const afterRows = {
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns worker heartbeat assignment-shaped include-details without leaking raw keys', () => {
    const now = Date.now();
    const secret = 'sk-cli-heartbeat-assignment-secret-should-not-leak';
    const platformId = 'qq-678901234';
    const assignment = `api_key=${secret}-${platformId}`;
    const workerId = `worker-${assignment}`;
    const workerType = `background-${assignment}`;
    const currentJobId = `job-${platformId}`;

    const jobRepo = new JobRepository(db);
    jobRepo.enqueue({
      id: currentJobId,
      type: 'summary',
      payload: { conversationId: 'private:heartbeat-assignment' },
      now,
    });
    jobRepo.heartbeat({
      workerId,
      workerType,
      status: 'error',
      currentJobId,
      details: {
        message: `heartbeat ${assignment}`,
        [`diagnostic ${assignment}`]: {
          ownerUserId: '678901234',
          processedCount: 42,
        },
      },
      now: now + 1,
    });

    const beforeRows = {
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const stdout = expectSuccessfulCli([
      'list-worker-heartbeats',
      '--worker',
      workerId,
      '--type',
      workerType,
      '--status',
      'error',
      '--include-details',
    ]);
    const rows = JSON.parse(stdout) as Array<{
      workerId: string;
      workerType: string;
      status: string;
      currentJobId?: string;
      details?: Record<string, unknown> & {
        message?: string;
      };
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      workerId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      workerType: expect.stringContaining('[REDACTED:api_key_assignment]'),
      status: 'error',
      currentJobId: 'job-[REDACTED:platform_id]',
      details: expect.objectContaining({
        message: expect.stringContaining('[REDACTED:api_key_assignment]'),
      }),
    }));
    expect(rows[0]?.workerId).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.workerType).toContain('[REDACTED:platform_id]');
    const detailKeys = Object.keys(rows[0]?.details ?? {});
    expect(detailKeys.some((key) => key.includes('[REDACTED:api_key_assignment]'))).toBe(true);
    expect(detailKeys.some((key) => key.includes('[REDACTED:platform_id]'))).toBe(true);

    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(platformId);
    expect(stdout).not.toContain('678901234');
    expect(stdout).not.toContain('src/');
    expect(stdout).not.toContain('\n    at ');

    reopenDb();
    const rawDetails = db
      .prepare('SELECT details FROM worker_heartbeats WHERE worker_id = ?')
      .get(workerId) as { details: string };
    expect(rawDetails.details).toContain('[REDACTED:api_key_assignment]');
    expect(rawDetails.details).toContain('[REDACTED:platform_id]');
    expect(rawDetails.details).not.toContain(secret);
    expect(rawDetails.details).not.toContain(platformId);
    expect(rawDetails.details).not.toContain('678901234');

    const afterRows = {
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns tool call assignment-shaped include-payload without leaking raw keys', async () => {
    const now = Date.now();
    const secret = 'sk-cli-tool-assignment-secret-should-not-leak';
    const platformId = 'qq-567890123';
    const assignment = `api_key=${secret}-${platformId}`;
    const turnId = `turn-${assignment}`;
    const toolName = `read_file-${assignment}`;
    const toolCallId = `tool-${assignment}`;
    const otherAssignment = 'api_key=sk-cli-tool-assignment-other-secret-qq-678901234';
    const otherTurnId = `turn-${otherAssignment}`;
    const otherToolName = `read_file-${otherAssignment}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-tool-assignment-match',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:tool-assignment-match',
      '{}',
      now,
      'evt-cli-tool-assignment-other',
      'message.private',
      now + 1,
      'gateway',
      'qq',
      'private:tool-assignment-other',
      '{}',
      now + 1
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      turnId,
      'private:tool-assignment-match',
      'evt-cli-tool-assignment-match',
      'ctx-cli-tool-assignment-match',
      'mock',
      'mock',
      'completed',
      now,
      now,
      otherTurnId,
      'private:tool-assignment-other',
      'evt-cli-tool-assignment-other',
      'ctx-cli-tool-assignment-other',
      'mock',
      'mock',
      'completed',
      now + 1,
      now + 1
    );

    const toolRepo = new ToolCallRepository(db);
    await toolRepo.create({
      id: toolCallId,
      turnId,
      toolName,
      input: {
        path: `/tmp/${assignment}`,
        [`diagnostic ${assignment}`]: {
          ownerUserId: 567890123,
          processedCount: 42,
        },
      },
      output: {
        message: `completed ${assignment}`,
        nested: {
          recipientGroupIds: [567890124],
          processedCount: 43,
        },
      },
      requestedBy: 'pi',
      actor: {
        canonicalUserId: `user-${assignment}`,
        actorClass: 'user',
      },
      context: 'private_chat',
      status: 'error',
      errorCode: `code-${assignment}`,
      errorMessage: `failed ${assignment}`,
      executionTimeMs: 12,
      secretsRedacted: false,
      createdAt: now + 2,
    });
    await toolRepo.create({
      id: `tool-${otherAssignment}`,
      turnId: otherTurnId,
      toolName: otherToolName,
      input: { path: `/tmp/${otherAssignment}` },
      output: { message: `other ${otherAssignment}` },
      requestedBy: 'pi',
      actor: {
        canonicalUserId: `user-${otherAssignment}`,
        actorClass: 'user',
      },
      context: 'private_chat',
      status: 'error',
      errorCode: `code-${otherAssignment}`,
      errorMessage: `failed ${otherAssignment}`,
      executionTimeMs: 13,
      secretsRedacted: false,
      createdAt: now + 3,
    });

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const stdout = expectSuccessfulCli([
      'list-tool-calls',
      '--turn',
      turnId,
      '--tool',
      toolName,
      '--status',
      'error',
      '--include-payload',
    ]);
    const rows = JSON.parse(stdout) as Array<{
      id: string;
      turnId: string;
      toolName: string;
      actor: { canonicalUserId?: string };
      status: string;
      errorCode?: string;
      errorMessage?: string;
      secretsRedacted: boolean;
      input?: Record<string, unknown> & {
        path?: string;
      };
      output?: {
        message?: string;
        nested?: {
          recipientGroupIds?: string[];
          processedCount?: number;
        };
      };
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      id: expect.stringContaining('[REDACTED:api_key_assignment]'),
      turnId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      toolName: expect.stringContaining('[REDACTED:api_key_assignment]'),
      actor: expect.objectContaining({
        canonicalUserId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      }),
      status: 'error',
      errorCode: expect.stringContaining('[REDACTED:api_key_assignment]'),
      errorMessage: expect.stringContaining('[REDACTED:api_key_assignment]'),
      secretsRedacted: true,
      input: expect.objectContaining({
        path: expect.stringContaining('[REDACTED:api_key_assignment]'),
      }),
      output: expect.objectContaining({
        message: expect.stringContaining('[REDACTED:api_key_assignment]'),
        nested: expect.objectContaining({
          recipientGroupIds: ['[REDACTED:platform_id]'],
          processedCount: 43,
        }),
      }),
    }));
    expect(rows[0]?.id).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.turnId).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.toolName).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.actor.canonicalUserId).toContain('[REDACTED:platform_id]');
    const inputKeys = Object.keys(rows[0]?.input ?? {});
    expect(inputKeys.some((key) => key.includes('[REDACTED:api_key_assignment]'))).toBe(true);
    expect(inputKeys.some((key) => key.includes('[REDACTED:platform_id]'))).toBe(true);

    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(platformId);
    expect(stdout).not.toContain('567890123');
    expect(stdout).not.toContain(otherAssignment);
    expect(stdout).not.toContain('678901234');
    expect(stdout).not.toContain('src/');
    expect(stdout).not.toContain('\n    at ');

    reopenDb();
    const rawToolCall = db
      .prepare('SELECT id, turn_id, tool_name, input, output, error_code, error_message, secrets_redacted FROM tool_calls WHERE id = ?')
      .get(toolCallId) as {
        id: string;
        turn_id: string;
        tool_name: string;
        input: string;
        output: string;
        error_code: string;
        error_message: string;
        secrets_redacted: number;
      };
    expect(rawToolCall.id).toBe(toolCallId);
    expect(rawToolCall.turn_id).toBe(turnId);
    expect(rawToolCall.tool_name).toBe(toolName);
    expect(rawToolCall.secrets_redacted).toBe(1);
    const persistedDiagnostic = JSON.stringify({
      input: rawToolCall.input,
      output: rawToolCall.output,
      errorCode: rawToolCall.error_code,
      errorMessage: rawToolCall.error_message,
    });
    expect(persistedDiagnostic).toContain('[REDACTED:api_key_assignment]');
    expect(persistedDiagnostic).toContain('[REDACTED:platform_id]');
    expect(persistedDiagnostic).not.toContain(secret);
    expect(persistedDiagnostic).not.toContain(platformId);
    expect(persistedDiagnostic).not.toContain('567890123');
    expect(persistedDiagnostic).not.toContain('567890124');

    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns action decision assignment-shaped include-actions without leaking raw keys', async () => {
    const now = Date.now();
    const secret = 'sk-cli-action-decision-assignment-secret-should-not-leak';
    const platformId = 'qq-456789123';
    const assignment = `api_key=${secret}-${platformId}`;
    const turnId = `turn-${assignment}`;
    const decisionId = `decision-${assignment}`;
    const otherAssignment = 'api_key=sk-cli-action-decision-assignment-other-secret-qq-567891234';
    const otherTurnId = `turn-${otherAssignment}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-action-decision-assignment-match',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:action-decision-assignment-match',
      '{}',
      now,
      'evt-cli-action-decision-assignment-other',
      'message.private',
      now + 1,
      'gateway',
      'qq',
      'private:action-decision-assignment-other',
      '{}',
      now + 1
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      turnId,
      'private:action-decision-assignment-match',
      'evt-cli-action-decision-assignment-match',
      'ctx-cli-action-decision-assignment-match',
      'mock',
      'mock',
      'completed',
      now,
      now,
      otherTurnId,
      'private:action-decision-assignment-other',
      'evt-cli-action-decision-assignment-other',
      'ctx-cli-action-decision-assignment-other',
      'mock',
      'mock',
      'completed',
      now + 1,
      now + 1
    );

    const actionRepo = new ActionRepository(db);
    await actionRepo.createDecision({
      id: decisionId,
      turnId,
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: [`reason ${assignment}`],
      suppressors: [`suppressor ${assignment}`],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:action-decision-assignment-match',
            conversationType: 'private',
          },
          payload: {
            text: `reply ${assignment}`,
            metadata: {
              [`diagnostic ${assignment}`]: {
                ownerUserId: 456789123,
                processedCount: 42,
              },
            },
          },
          constraints: {},
          reason: `action reason ${assignment}`,
        },
      ],
      createdAt: new Date(now + 2),
    });
    await actionRepo.createDecision({
      id: `decision-${otherAssignment}`,
      turnId: otherTurnId,
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: [`other reason ${otherAssignment}`],
      suppressors: [`other suppressor ${otherAssignment}`],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:action-decision-assignment-other',
            conversationType: 'private',
          },
          payload: { text: `other ${otherAssignment}` },
          constraints: {},
          reason: `other action reason ${otherAssignment}`,
        },
      ],
      createdAt: new Date(now + 3),
    });

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const stdout = expectSuccessfulCli([
      'list-action-decisions',
      '--turn',
      turnId,
      '--include-actions',
    ]);
    const rows = JSON.parse(stdout) as Array<{
      id: string;
      turnId: string;
      reasons: string[];
      suppressors: string[];
      actions?: Array<{
        payload?: {
          text?: string;
          metadata?: Record<string, unknown>;
        };
        reason?: string;
      }>;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      id: expect.stringContaining('[REDACTED:api_key_assignment]'),
      turnId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      reasons: [expect.stringContaining('[REDACTED:api_key_assignment]')],
      suppressors: [expect.stringContaining('[REDACTED:api_key_assignment]')],
      actions: [
        expect.objectContaining({
          payload: expect.objectContaining({
            text: expect.stringContaining('[REDACTED:api_key_assignment]'),
          }),
          reason: expect.stringContaining('[REDACTED:api_key_assignment]'),
        }),
      ],
    }));
    expect(rows[0]?.id).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.turnId).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.reasons[0]).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.suppressors[0]).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.actions?.[0]?.payload?.text).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.actions?.[0]?.reason).toContain('[REDACTED:platform_id]');
    const metadataKeys = Object.keys(rows[0]?.actions?.[0]?.payload?.metadata ?? {});
    expect(metadataKeys.some((key) => key.includes('[REDACTED:api_key_assignment]'))).toBe(true);
    expect(metadataKeys.some((key) => key.includes('[REDACTED:platform_id]'))).toBe(true);

    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(platformId);
    expect(stdout).not.toContain('456789123');
    expect(stdout).not.toContain(otherAssignment);
    expect(stdout).not.toContain('567891234');
    expect(stdout).not.toContain('src/');
    expect(stdout).not.toContain('\n    at ');

    reopenDb();
    const rawDecision = db
      .prepare('SELECT id, turn_id, actions, reasons, suppressors FROM action_decisions WHERE id = ?')
      .get(decisionId) as {
        id: string;
        turn_id: string;
        actions: string;
        reasons: string;
        suppressors: string;
      };
    expect(rawDecision.id).toBe(decisionId);
    expect(rawDecision.turn_id).toBe(turnId);
    const persistedDiagnostic = JSON.stringify({
      actions: rawDecision.actions,
      reasons: rawDecision.reasons,
      suppressors: rawDecision.suppressors,
    });
    expect(persistedDiagnostic).toContain('[REDACTED:api_key_assignment]');
    expect(persistedDiagnostic).toContain('[REDACTED:platform_id]');
    expect(persistedDiagnostic).not.toContain(secret);
    expect(persistedDiagnostic).not.toContain(platformId);
    expect(persistedDiagnostic).not.toContain('456789123');

    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns action execution assignment-shaped include-audit-entry without leaking raw keys', async () => {
    const now = Date.now();
    const secret = 'sk-cli-action-execution-assignment-secret-should-not-leak';
    const platformId = 'qq-678912345';
    const assignment = `api_key=${secret}-${platformId}`;
    const turnId = `turn-${assignment}`;
    const decisionId = `decision-${assignment}`;
    const executionId = `execution-${assignment}`;
    const executedMessageId = `message-${assignment}`;
    const otherAssignment = 'api_key=sk-cli-action-execution-assignment-other-secret-qq-789123456';
    const otherTurnId = `turn-${otherAssignment}`;
    const otherDecisionId = `decision-${otherAssignment}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-action-execution-assignment-match',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:action-execution-assignment-match',
      '{}',
      now,
      'evt-cli-action-execution-assignment-other',
      'message.private',
      now + 1,
      'gateway',
      'qq',
      'private:action-execution-assignment-other',
      '{}',
      now + 1
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      turnId,
      'private:action-execution-assignment-match',
      'evt-cli-action-execution-assignment-match',
      'ctx-cli-action-execution-assignment-match',
      'mock',
      'mock',
      'completed',
      now,
      now,
      otherTurnId,
      'private:action-execution-assignment-other',
      'evt-cli-action-execution-assignment-other',
      'ctx-cli-action-execution-assignment-other',
      'mock',
      'mock',
      'completed',
      now + 1,
      now + 1
    );

    const actionRepo = new ActionRepository(db);
    await actionRepo.createDecision({
      id: decisionId,
      turnId,
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: ['matching execution decision'],
      suppressors: [],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:action-execution-assignment-match',
            conversationType: 'private',
          },
          payload: { text: 'matching execution reply' },
          constraints: {},
          reason: 'matching execution action',
        },
      ],
      createdAt: new Date(now + 2),
    });
    await actionRepo.createDecision({
      id: otherDecisionId,
      turnId: otherTurnId,
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['other execution decision'],
      suppressors: [],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:action-execution-assignment-other',
            conversationType: 'private',
          },
          payload: { text: 'other execution reply' },
          constraints: {},
          reason: 'other execution action',
        },
      ],
      createdAt: new Date(now + 3),
    });
    await actionRepo.createExecution({
      id: executionId,
      actionDecisionId: decisionId,
      actionType: 'reply_short',
      status: 'failed',
      executedMessageId,
      downgradedFrom: 'reply_full',
      downgradedReason: `downgrade ${assignment}`,
      error: {
        code: `code ${assignment}`,
        message: `error ${assignment}`,
        recoverable: true,
      },
      auditLevel: 'redacted_full',
      auditEntry: `audit ${assignment}`,
      executedAt: new Date(now + 4),
    });
    await actionRepo.createExecution({
      id: `execution-${otherAssignment}`,
      actionDecisionId: otherDecisionId,
      actionType: 'reply_short',
      status: 'failed',
      executedMessageId: `message-${otherAssignment}`,
      downgradedFrom: 'reply_full',
      downgradedReason: `other downgrade ${otherAssignment}`,
      error: {
        code: `other code ${otherAssignment}`,
        message: `other error ${otherAssignment}`,
        recoverable: true,
      },
      auditLevel: 'redacted_full',
      auditEntry: `other audit ${otherAssignment}`,
      executedAt: new Date(now + 5),
    });

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const stdout = expectSuccessfulCli([
      'list-action-executions',
      '--decision',
      decisionId,
      '--status',
      'failed',
      '--include-audit-entry',
    ]);
    const rows = JSON.parse(stdout) as Array<{
      id: string;
      actionDecisionId: string;
      status: string;
      executedMessageId?: string;
      downgradedFrom?: string;
      downgradedReason?: string;
      errorCode?: string;
      errorMessage?: string;
      auditLevel: string;
      auditEntry?: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      id: expect.stringContaining('[REDACTED:api_key_assignment]'),
      actionDecisionId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      status: 'failed',
      executedMessageId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      downgradedFrom: 'reply_full',
      downgradedReason: expect.stringContaining('[REDACTED:api_key_assignment]'),
      errorCode: expect.stringContaining('[REDACTED:api_key_assignment]'),
      errorMessage: expect.stringContaining('[REDACTED:api_key_assignment]'),
      auditLevel: 'redacted_full',
      auditEntry: expect.stringContaining('[REDACTED:api_key_assignment]'),
    }));
    expect(rows[0]?.id).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.actionDecisionId).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.executedMessageId).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.downgradedReason).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.errorCode).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.errorMessage).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.auditEntry).toContain('[REDACTED:platform_id]');

    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(platformId);
    expect(stdout).not.toContain('678912345');
    expect(stdout).not.toContain(otherAssignment);
    expect(stdout).not.toContain('789123456');
    expect(stdout).not.toContain('src/');
    expect(stdout).not.toContain('\n    at ');

    reopenDb();
    const rawExecution = db
      .prepare(
        `SELECT id, action_decision_id, executed_message_id,
                downgraded_reason, error_code, error_message, audit_entry
         FROM action_executions WHERE id = ?`
      )
      .get(executionId) as {
        id: string;
        action_decision_id: string;
        executed_message_id: string;
        downgraded_reason: string;
        error_code: string;
        error_message: string;
        audit_entry: string;
      };
    expect(rawExecution.id).toBe(executionId);
    expect(rawExecution.action_decision_id).toBe(decisionId);
    expect(rawExecution.executed_message_id).toBe(executedMessageId);
    const persistedDiagnostic = JSON.stringify({
      downgradedReason: rawExecution.downgraded_reason,
      errorCode: rawExecution.error_code,
      errorMessage: rawExecution.error_message,
      auditEntry: rawExecution.audit_entry,
    });
    expect(persistedDiagnostic).toContain('[REDACTED:api_key_assignment]');
    expect(persistedDiagnostic).toContain('[REDACTED:platform_id]');
    expect(persistedDiagnostic).not.toContain(secret);
    expect(persistedDiagnostic).not.toContain(platformId);
    expect(persistedDiagnostic).not.toContain('678912345');

    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns governance health summary with redacted aggregate keys and no row mutation', () => {
    const now = Date.now();
    const secret = 'sk-cli-health-aggregate-secret-should-not-leak';
    const platformId = 'qq-456789012';
    const failureStage = `pi_inference-${platformId}-${secret}`;
    const jobType = `summary-${platformId}-${secret}`;
    const workerType = `background-${platformId}-${secret}`;
    const auditEventType = `system.health.${platformId}.${secret}`;
    const auditRiskLevel = `risk-${platformId}-${secret}`;

    db.prepare(
      `INSERT INTO event_processing_failures (
        id, occurred_at, stage, conversation_type,
        error_name, error_message_hash, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'failure-cli-health-sensitive-aggregate',
      now,
      failureStage,
      'private',
      'ProviderError',
      'a'.repeat(64),
      JSON.stringify({ redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error' })
    );

    const jobRepo = new JobRepository(db);
    jobRepo.enqueue({
      id: 'job-cli-health-sensitive-aggregate',
      type: jobType,
      payload: { conversationId: 'private:health-aggregate', token: secret },
      now: now + 1,
    });
    jobRepo.heartbeat({
      workerId: 'worker-cli-health-sensitive-aggregate',
      workerType,
      status: 'error',
      details: { diagnostic: `heartbeat diagnostic ${secret}` },
      now: now + 2,
    });

    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-health-sensitive-aggregate',
      now + 3,
      'system',
      'summary',
      auditEventType,
      'health-sensitive-aggregate',
      'system',
      'admin_cli',
      `health aggregate summary ${secret}`,
      JSON.stringify({ note: `audit detail ${secret}` }),
      1,
      auditRiskLevel
    );

    const beforeRows = {
      failures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const stdout = expectSuccessfulCli(['summarize-governance-health']);
    const health = JSON.parse(stdout) as {
      eventProcessing: { byStage: Record<string, number> };
      jobs: { byType: Record<string, number> };
      workerHeartbeats: { byWorkerType: Record<string, number> };
      audit: {
        byEventType: Record<string, number>;
        byRiskLevel: Record<string, number>;
      };
    };

    const aggregateKeys = [
      ...Object.keys(health.eventProcessing.byStage),
      ...Object.keys(health.jobs.byType),
      ...Object.keys(health.workerHeartbeats.byWorkerType),
      ...Object.keys(health.audit.byEventType),
      ...Object.keys(health.audit.byRiskLevel),
    ];

    expect(aggregateKeys).toHaveLength(5);
    for (const key of aggregateKeys) {
      expect(key).toContain('[REDACTED:');
      expect(key).not.toContain(secret);
      expect(key).not.toContain(platformId);
    }
    expect(Object.values(health.eventProcessing.byStage)).toEqual([1]);
    expect(Object.values(health.jobs.byType)).toEqual([1]);
    expect(Object.values(health.workerHeartbeats.byWorkerType)).toEqual([1]);
    expect(Object.values(health.audit.byEventType)).toEqual([1]);
    expect(Object.values(health.audit.byRiskLevel)).toEqual([1]);

    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain(failureStage);
    expect(serialized).not.toContain(jobType);
    expect(serialized).not.toContain(workerType);
    expect(serialized).not.toContain(auditEventType);
    expect(serialized).not.toContain(auditRiskLevel);

    reopenDb();
    const afterRows = {
      failures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns event failure assignment-shaped include-details without leaking raw keys', () => {
    const now = Date.now();
    const secret = 'sk-cli-event-failure-assignment-secret-should-not-leak';
    const platformId = 'qq-345678912';
    const assignment = `api_key=${secret}-${platformId}`;
    const rawEventId = `evt-${assignment}`;
    const turnId = `turn-${assignment}`;
    const failureId = `failure-${assignment}`;
    const legacyStage = `pi_inference-${assignment}`;
    const otherAssignment = 'api_key=sk-cli-event-failure-assignment-other-secret-qq-456789123';
    const otherRawEventId = `evt-${otherAssignment}`;
    const otherTurnId = `turn-${otherAssignment}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rawEventId,
      'chat.message.received',
      now,
      'gateway',
      'qq',
      'private:event-failure-assignment-match',
      '{}',
      now,
      otherRawEventId,
      'chat.message.received',
      now + 1,
      'gateway',
      'qq',
      'private:event-failure-assignment-other',
      '{}',
      now + 1
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, response_text, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      turnId,
      'private:event-failure-assignment-match',
      rawEventId,
      'ctx-cli-event-failure-assignment-match',
      'mock',
      'mock',
      'failed',
      'failed',
      now,
      now,
      otherTurnId,
      'private:event-failure-assignment-other',
      otherRawEventId,
      'ctx-cli-event-failure-assignment-other',
      'mock',
      'mock',
      'failed',
      'failed',
      now + 1,
      now + 1
    );
    db.prepare(
      `INSERT INTO event_processing_failures (
        id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
        error_name, error_message_hash, message_id_hash, sender_id_hash,
        conversation_id_hash, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      failureId,
      rawEventId,
      turnId,
      now,
      legacyStage,
      'private',
      `ProviderError-${assignment}`,
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
      JSON.stringify({
        redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error',
        [`diagnostic ${assignment}`]: {
          note: `failure diagnostic ${assignment}`,
          ownerUserId: 345678912,
          processedCount: 42,
        },
      }),
      `failure-${otherAssignment}`,
      otherRawEventId,
      otherTurnId,
      now + 1,
      `action_execution-${otherAssignment}`,
      'private',
      `ActionError-${otherAssignment}`,
      'e'.repeat(64),
      'f'.repeat(64),
      '0'.repeat(64),
      '1'.repeat(64),
      JSON.stringify({
        redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error',
        diagnostic: `other failure diagnostic ${otherAssignment}`,
      })
    );

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      failures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const stdout = expectSuccessfulCli([
      'list-event-failures',
      '--raw-event',
      rawEventId,
      '--turn',
      turnId,
      '--include-details',
    ]);
    const rows = JSON.parse(stdout) as Array<{
      id: string;
      rawEventId: string;
      turnId: string;
      stage: string;
      errorName: string;
      details?: Record<string, unknown>;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      id: expect.stringContaining('[REDACTED:api_key_assignment]'),
      rawEventId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      turnId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      stage: expect.stringContaining('[REDACTED:api_key_assignment]'),
      errorName: expect.stringContaining('[REDACTED:api_key_assignment]'),
      details: expect.objectContaining({
        redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error',
      }),
    }));
    expect(rows[0]?.id).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.rawEventId).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.turnId).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.stage).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.errorName).toContain('[REDACTED:platform_id]');
    const detailKeys = Object.keys(rows[0]?.details ?? {});
    expect(detailKeys.some((key) => key.includes('[REDACTED:api_key_assignment]'))).toBe(true);
    expect(detailKeys.some((key) => key.includes('[REDACTED:platform_id]'))).toBe(true);

    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(platformId);
    expect(stdout).not.toContain('345678912');
    expect(stdout).not.toContain(otherAssignment);
    expect(stdout).not.toContain('456789123');
    expect(stdout).not.toContain('src/');
    expect(stdout).not.toContain('\n    at ');

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      failures: db.prepare('SELECT * FROM event_processing_failures ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns action and tool classification inspection with redacted names while preserving raw filters', () => {
    const now = Date.now();
    const secret = 'sk-cli-action-tool-classification-secret-should-not-leak';
    const platformId = 'qq-456789012';
    const actionType = `reply-${platformId}-${secret}`;
    const toolName = `tool-${platformId}-${secret}`;
    const otherToolName = `tool-qq-987654321-${secret}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('evt-cli-sensitive-classification', 'message.private', now, 'gateway', 'qq', 'private:classification', '{}', now);
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-sensitive-classification',
      'private:classification',
      'evt-cli-sensitive-classification',
      'ctx-cli-sensitive-classification',
      'mock',
      'mock',
      'completed',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'decision-cli-sensitive-classification',
      'turn-cli-sensitive-classification',
      'pi',
      'low',
      0.9,
      0,
      null,
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      now,
    );
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status, audit_level, audit_entry, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'execution-cli-sensitive-classification-match',
      'decision-cli-sensitive-classification',
      actionType,
      'success',
      'summary',
      'matching action classification audit',
      now,
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        execution_time_ms, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'tool-cli-sensitive-classification-match',
      'turn-cli-sensitive-classification',
      toolName,
      JSON.stringify({ ok: true }),
      JSON.stringify({ ok: true }),
      'pi',
      'user-cli',
      'user',
      'private_chat',
      'success',
      1,
      0,
      now,
      'tool-cli-sensitive-classification-other',
      'turn-cli-sensitive-classification',
      otherToolName,
      JSON.stringify({ ok: true }),
      JSON.stringify({ ok: true }),
      'pi',
      'user-cli',
      'user',
      'private_chat',
      'success',
      1,
      0,
      now + 1,
    );

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
    };

    const actionRows = JSON.parse(expectSuccessfulCli([
      'list-action-executions',
      '--decision',
      'decision-cli-sensitive-classification',
      '--include-audit-entry',
    ])) as Array<{ id: string; actionType: string; auditEntry?: string }>;
    const toolRows = JSON.parse(expectSuccessfulCli([
      'list-tool-calls',
      '--tool',
      toolName,
      '--include-payload',
    ])) as Array<{ id: string; toolName: string }>;

    expect(actionRows).toEqual([
      expect.objectContaining({
        id: 'execution-cli-sensitive-classification-match',
        actionType: expect.stringContaining('[REDACTED:platform_id]'),
        auditEntry: 'matching action classification audit',
      }),
    ]);
    expect(actionRows[0]?.actionType).toContain('[REDACTED');
    expect(toolRows).toEqual([
      expect.objectContaining({
        id: 'tool-cli-sensitive-classification-match',
        toolName: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);
    expect(toolRows[0]?.toolName).toContain('[REDACTED');

    const serialized = JSON.stringify({ actionRows, toolRows });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain(otherToolName);
    expect(serialized).toContain('[REDACTED:platform_id]');

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns tool call legacy classification inspection with redacted display values while preserving raw rows', () => {
    const now = Date.now();
    const secret = 'sk-cli-tool-call-classification-secret-should-not-leak';
    const platformId = 'qq-918273645';
    const requestedBy = `pi-${platformId}-${secret}`;
    const status = `error-${platformId}-${secret}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-tool-call-legacy-classification',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:tool-call-legacy-classification',
      '{}',
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-tool-call-legacy-classification',
      'private:tool-call-legacy-classification',
      'evt-cli-tool-call-legacy-classification',
      'ctx-cli-tool-call-legacy-classification',
      'mock',
      'mock',
      'completed',
      now,
      now,
    );

    db.pragma('ignore_check_constraints = ON');
    try {
      db.prepare(
        `INSERT INTO tool_calls (
          id, turn_id, tool_name, input, output, requested_by,
          actor_user_id, actor_class, invocation_context, status,
          execution_time_ms, secrets_redacted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'tool-cli-legacy-classification',
        'turn-cli-tool-call-legacy-classification',
        'read_file',
        JSON.stringify({ path: '/tmp/legacy-classification' }),
        JSON.stringify({ ok: true }),
        requestedBy,
        'user-cli',
        'user',
        'private_chat',
        status,
        1,
        0,
        now,
      );
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
    };

    const rows = JSON.parse(expectSuccessfulCli([
      'list-tool-calls',
      '--tool',
      'read_file',
    ])) as Array<{ id: string; requestedBy: string; status: string }>;

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'tool-cli-legacy-classification',
        requestedBy: expect.stringContaining('[REDACTED:platform_id]'),
        status: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('918273645');

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns action decision classification inspection with redacted legacy values while preserving raw rows', () => {
    const now = Date.now();
    const secret = 'sk-cli-action-decision-classification-secret-should-not-leak';
    const platformId = 'qq-564738291';
    const legacyDecidedBy = `pi-${platformId}-${secret}`;
    const legacyRiskLevel = `risk-${platformId}-${secret}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-action-decision-legacy-classification',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:action-decision-legacy-classification',
      '{}',
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-action-decision-legacy-classification',
      'private:action-decision-legacy-classification',
      'evt-cli-action-decision-legacy-classification',
      'ctx-cli-action-decision-legacy-classification',
      'mock',
      'mock',
      'completed',
      now,
      now,
    );

    db.pragma('ignore_check_constraints = ON');
    try {
      db.prepare(
        `INSERT INTO action_decisions (
          id, turn_id, decided_by, risk_level, confidence,
          evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'decision-cli-action-decision-legacy-classification',
        'turn-cli-action-decision-legacy-classification',
        legacyDecidedBy,
        legacyRiskLevel,
        0.9,
        0,
        null,
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify([]),
        now,
      );
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
    };

    const rows = JSON.parse(expectSuccessfulCli([
      'list-action-decisions',
      '--turn',
      'turn-cli-action-decision-legacy-classification',
    ])) as Array<{ id: string; decidedBy: string; riskLevel: string }>;

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'decision-cli-action-decision-legacy-classification',
        decidedBy: expect.stringContaining('[REDACTED:platform_id]'),
        riskLevel: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('564738291');

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns action execution legacy classification inspection with redacted display values', () => {
    const now = Date.now();
    const secret = 'sk-cli-action-execution-classification-secret-should-not-leak';
    const platformId = 'qq-192837465';
    const legacyStatus = `failed-${platformId}-${secret}`;
    const legacyAuditLevel = `full-${platformId}-${secret}`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-action-execution-legacy-classification',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:action-execution-legacy-classification',
      '{}',
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-action-execution-legacy-classification',
      'private:action-execution-legacy-classification',
      'evt-cli-action-execution-legacy-classification',
      'ctx-cli-action-execution-legacy-classification',
      'mock',
      'mock',
      'completed',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'decision-cli-action-execution-legacy-classification',
      'turn-cli-action-execution-legacy-classification',
      'pi',
      'low',
      0.9,
      0,
      null,
      JSON.stringify([]),
      JSON.stringify([]),
      JSON.stringify([]),
      now,
    );

    db.pragma('ignore_check_constraints = ON');
    try {
      db.prepare(
        `INSERT INTO action_executions (
          id, action_decision_id, action_type, status, audit_level, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        'execution-cli-action-execution-legacy-classification',
        'decision-cli-action-execution-legacy-classification',
        'reply_short',
        legacyStatus,
        legacyAuditLevel,
        now,
      );
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
    };

    const rows = JSON.parse(expectSuccessfulCli([
      'list-action-executions',
      '--decision',
      'decision-cli-action-execution-legacy-classification',
    ])) as Array<{ id: string; status: string; auditLevel: string }>;

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'execution-cli-action-execution-legacy-classification',
        status: expect.stringContaining('[REDACTED:platform_id]'),
        auditLevel: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('192837465');

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns audit classification inspection with redacted event and risk values while preserving raw filters', () => {
    const now = Date.now();
    const secret = 'sk-cli-audit-classification-secret-should-not-leak';
    const platformId = 'qq-135791357';
    const eventType = `tool.${platformId}.${secret}`;
    const riskLevel = `risk-${platformId}-${secret}`;
    const otherEventType = `tool.qq-246802468.${secret}`;
    const otherRiskLevel = `risk-qq-246802468-${secret}`;

    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-sensitive-classification-match',
      now,
      'tool',
      'redacted_full',
      eventType,
      'audit-event-cli-sensitive-classification-match',
      'user-cli',
      'user',
      'private_chat',
      'matching audit classification summary',
      JSON.stringify({ ok: true }),
      1,
      riskLevel,
      'audit-cli-sensitive-classification-other',
      now + 1,
      'tool',
      'redacted_full',
      otherEventType,
      'audit-event-cli-sensitive-classification-other',
      'user-cli',
      'user',
      'private_chat',
      'other audit classification summary',
      JSON.stringify({ ok: true }),
      1,
      otherRiskLevel,
    );

    const beforeRows = {
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const auditRows = JSON.parse(expectSuccessfulCli([
      'list-audit',
      '--event-type',
      eventType,
    ])) as Array<{ id: string; eventType: string; riskLevel?: string }>;

    expect(auditRows).toEqual([
      expect.objectContaining({
        id: 'audit-cli-sensitive-classification-match',
        eventType: expect.stringContaining('[REDACTED:platform_id]'),
        riskLevel: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);
    expect(auditRows[0]?.eventType).toContain('[REDACTED');
    expect(auditRows[0]?.riskLevel).toContain('[REDACTED');

    const serialized = JSON.stringify(auditRows);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain(otherEventType);
    expect(serialized).not.toContain(otherRiskLevel);
    expect(serialized).toContain('[REDACTED:platform_id]');

    const noMatch = JSON.parse(expectSuccessfulCli([
      'list-audit',
      '--event-type',
      otherEventType,
      '--risk',
      'low',
    ])) as unknown[];
    expect(noMatch).toEqual([]);

    reopenDb();
    const afterRows = {
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns audit legacy category and level inspection with redacted display values while preserving raw rows', () => {
    const now = Date.now();
    const secret = 'sk-cli-audit-category-level-secret-should-not-leak';
    const platformId = 'qq-314159265';
    const legacyCategory = `tool-${platformId}-${secret}`;
    const legacyLevel = `full-${platformId}-${secret}`;

    db.pragma('ignore_check_constraints = ON');
    try {
      db.prepare(
        `INSERT INTO audit_log (
          id, timestamp, category, level, event_type, event_id,
          actor_user_id, actor_class, invocation_context, summary,
          details, redacted, risk_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'audit-cli-legacy-category-level',
        now,
        legacyCategory,
        legacyLevel,
        'audit.legacy_category_level',
        'audit-event-cli-legacy-category-level',
        'user-cli',
        'admin',
        'admin_cli',
        'legacy audit category level summary',
        JSON.stringify({ ok: true }),
        1,
        'medium'
      );
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }

    const beforeRows = {
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const rows = JSON.parse(expectSuccessfulCli([
      'list-audit',
      '--event-type',
      'audit.legacy_category_level',
    ])) as Array<{ id: string; category: string; level: string }>;

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'audit-cli-legacy-category-level',
        category: expect.stringContaining('[REDACTED:platform_id]'),
        level: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('314159265');

    reopenDb();
    const afterRows = {
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns list-audit with prohibited risk filter and redacted payload evidence', () => {
    const now = Date.now();
    const secret = 'sk-cli-prohibited-audit-secret-should-not-leak';
    const platformId = 'qq-190190190';

    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-prohibited-risk-match',
      now,
      'evaluator',
      'redacted_full',
      'policy.violation',
      'audit-event-cli-prohibited-risk-match',
      'user-cli',
      'system',
      'admin_cli',
      `prohibited audit summary ${secret} ${platformId}`,
      JSON.stringify({
        reason: `blocked secret ${secret}`,
        target: platformId,
      }),
      1,
      'prohibited',
      'audit-cli-prohibited-risk-other',
      now + 1,
      'evaluator',
      'redacted_full',
      'policy.review',
      'audit-event-cli-prohibited-risk-other',
      'user-cli',
      'system',
      'admin_cli',
      'other high audit summary',
      JSON.stringify({ reason: 'other' }),
      1,
      'high',
    );

    const beforeRows = {
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const auditRows = JSON.parse(expectSuccessfulCli([
      'list-audit',
      '--risk',
      'prohibited',
      '--include-details',
    ])) as Array<{
      id: string;
      riskLevel?: string;
      summary: string;
      details?: unknown;
    }>;

    expect(auditRows).toEqual([
      expect.objectContaining({
        id: 'audit-cli-prohibited-risk-match',
        riskLevel: 'prohibited',
        summary: expect.stringContaining('[REDACTED:'),
        details: expect.objectContaining({
          reason: expect.stringContaining('[REDACTED:'),
          target: '[REDACTED:platform_id]',
        }),
      }),
    ]);

    const serialized = JSON.stringify(auditRows);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('audit-cli-prohibited-risk-other');
    expect(serialized).toContain('[REDACTED:platform_id]');

    const health = JSON.parse(expectSuccessfulCli(['summarize-governance-health'])) as {
      audit: { prohibitedRisk: number; highRisk: number };
      attention: { highOrProhibitedRiskAuditEvents: number };
    };
    expect(health.audit.prohibitedRisk).toBe(1);
    expect(health.audit.highRisk).toBe(1);
    expect(health.attention.highOrProhibitedRiskAuditEvents).toBe(2);

    reopenDb();
    const afterRows = {
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns audit include-details with redacted structured object keys', () => {
    const now = Date.now();
    const secret = 'sk-cli-audit-detail-key-secret-should-not-leak';
    const platformId = 'qq-123456789';
    const rawSecretKey = `api_key=${secret}`;
    const rawPlatformKey = `target-${platformId}`;

    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-structured-key-redaction',
      now,
      'system',
      'redacted_full',
      'audit.structured_key.redaction',
      'audit-structured-key-redaction',
      'user-cli',
      'admin',
      'admin_cli',
      'Structured key redaction fixture',
      JSON.stringify({
        [rawSecretKey]: 'secret-shaped object keys should be redacted',
        nested: {
          [rawPlatformKey]: 'platform-shaped object keys should be redacted',
        },
        list: [
          {
            [rawPlatformKey]: 'platform-shaped array object keys should be redacted',
          },
        ],
      }),
      0,
      'medium'
    );

    const beforeRows = {
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const auditRows = JSON.parse(expectSuccessfulCli([
      'list-audit',
      '--event-type',
      'audit.structured_key.redaction',
      '--include-details',
    ])) as Array<{
      id: string;
      details?: {
        nested?: Record<string, unknown>;
        list?: Array<Record<string, unknown>>;
      } & Record<string, unknown>;
      redacted: boolean;
    }>;

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.details).toBeDefined();
    const details = auditRows[0]?.details ?? {};
    expect(Object.keys(details)).toContain('[REDACTED:api_key_assignment]');
    expect(Object.keys(details)).not.toContain(rawSecretKey);
    expect(Object.keys(details.nested ?? {})).toContain('target-[REDACTED:platform_id]');
    expect(Object.keys(details.nested ?? {})).not.toContain(rawPlatformKey);
    expect(Object.keys(details.list?.[0] ?? {})).toContain('target-[REDACTED:platform_id]');
    expect(Object.keys(details.list?.[0] ?? {})).not.toContain(rawPlatformKey);
    expect(auditRows[0]?.redacted).toBe(true);

    const serialized = JSON.stringify(auditRows);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain(rawSecretKey);
    expect(serialized).not.toContain(rawPlatformKey);
    expect(serialized).toContain('[REDACTED:api_key_assignment]');
    expect(serialized).toContain('[REDACTED:platform_id]');

    reopenDb();
    const afterRows = {
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns action and tool inspection with redacted platform-like turn IDs while preserving raw filters', () => {
    const now = Date.now();
    const turnId = 'turn-qq-456789012';
    const otherTurnId = 'turn-qq-987654321';

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-redacted-turn-match',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:redacted-turn-match',
      '{}',
      now,
      'evt-cli-redacted-turn-other',
      'message.private',
      now + 1,
      'gateway',
      'qq',
      'private:redacted-turn-other',
      '{}',
      now + 1
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      turnId,
      'private:redacted-turn-match',
      'evt-cli-redacted-turn-match',
      'ctx-cli-redacted-turn-match',
      'mock',
      'mock',
      'completed',
      now,
      now,
      otherTurnId,
      'private:redacted-turn-other',
      'evt-cli-redacted-turn-other',
      'ctx-cli-redacted-turn-other',
      'mock',
      'mock',
      'completed',
      now + 1,
      now + 1
    );
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'decision-cli-redacted-turn-match',
      turnId,
      'pi',
      'low',
      0.9,
      0,
      null,
      JSON.stringify([{ type: 'reply_full', payload: { text: 'matching action' } }]),
      JSON.stringify(['matching reason']),
      JSON.stringify([]),
      now,
      'decision-cli-redacted-turn-other',
      otherTurnId,
      'pi',
      'low',
      0.8,
      0,
      null,
      JSON.stringify([{ type: 'reply_full', payload: { text: 'other action' } }]),
      JSON.stringify(['other reason']),
      JSON.stringify([]),
      now + 1
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        execution_time_ms, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'tool-cli-redacted-turn-match',
      turnId,
      'read_file',
      JSON.stringify({ path: '/tmp/match' }),
      JSON.stringify({ ok: true }),
      'pi',
      'user-cli-redacted-turn',
      'user',
      'private_chat',
      'success',
      3,
      0,
      now,
      'tool-cli-redacted-turn-other',
      otherTurnId,
      'read_file',
      JSON.stringify({ path: '/tmp/other' }),
      JSON.stringify({ ok: true }),
      'pi',
      'user-cli-redacted-turn-other',
      'user',
      'private_chat',
      'success',
      4,
      0,
      now + 1
    );

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const actionRows = JSON.parse(expectSuccessfulCli([
      'list-action-decisions',
      '--turn',
      turnId,
    ])) as Array<{ id: string; turnId: string; decidedBy: string }>;
    const toolRows = JSON.parse(expectSuccessfulCli([
      'list-tool-calls',
      '--turn',
      turnId,
      '--tool',
      'read_file',
    ])) as Array<{ id: string; turnId: string; toolName: string }>;

    expect(actionRows).toEqual([
      expect.objectContaining({
        id: 'decision-cli-redacted-turn-match',
        turnId: 'turn-[REDACTED:platform_id]',
        decidedBy: 'pi',
      }),
    ]);
    expect(toolRows).toEqual([
      expect.objectContaining({
        id: 'tool-cli-redacted-turn-match',
        turnId: 'turn-[REDACTED:platform_id]',
        toolName: 'read_file',
      }),
    ]);

    const serialized = JSON.stringify({ actionRows, toolRows });
    expect(serialized).not.toContain(turnId);
    expect(serialized).not.toContain(otherTurnId);
    expect(serialized).not.toContain('decision-cli-redacted-turn-other');
    expect(serialized).not.toContain('tool-cli-redacted-turn-other');
    expect(serialized).toContain('[REDACTED:platform_id]');

    const noMatch = JSON.parse(expectSuccessfulCli([
      'list-tool-calls',
      '--turn',
      'turn-qq-111111111',
    ])) as unknown[];
    expect(noMatch).toEqual([]);

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns action and tool diagnostics with redacted code fields while preserving raw filters', () => {
    const now = Date.now();
    const secret = 'sk-ijklmnopqrstuvwxyz123456789abcde';
    const platformId = 'qq-456789012';
    const diagnosticCode = `adapter-${platformId}-${secret}`;
    const downgradedFrom = `reply-${platformId}-${secret}`;
    const turnId = 'turn-cli-diagnostic-code-redaction';
    const decisionId = 'decision-cli-diagnostic-code-redaction';

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-diagnostic-code-redaction',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:diagnostic-code-redaction',
      '{}',
      now
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      turnId,
      'private:diagnostic-code-redaction',
      'evt-cli-diagnostic-code-redaction',
      'ctx-cli-diagnostic-code-redaction',
      'mock',
      'mock',
      'completed',
      now,
      now
    );
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      decisionId,
      turnId,
      'pi',
      'high',
      0.7,
      1,
      1,
      JSON.stringify([{ type: 'reply_short', payload: { text: 'diagnostic code fixture' } }]),
      JSON.stringify([]),
      JSON.stringify([]),
      now
    );
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status, downgraded_from,
        error_code, error_message, audit_level, audit_entry, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'execution-cli-diagnostic-code-redaction',
      decisionId,
      'reply_short',
      'failed',
      downgradedFrom,
      diagnosticCode,
      `non-code message ${secret}`,
      'redacted_full',
      'diagnostic code audit entry',
      now
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        error_code, error_message, execution_time_ms, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'tool-cli-diagnostic-code-redaction',
      turnId,
      'read_file',
      JSON.stringify({ path: '/tmp/diagnostic-code-redaction' }),
      JSON.stringify({ ok: false }),
      'pi',
      'user-cli',
      'user',
      'private_chat',
      'error',
      diagnosticCode,
      `tool error ${secret}`,
      5,
      0,
      now
    );

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const actionRows = JSON.parse(expectSuccessfulCli([
      'list-action-executions',
      '--decision',
      decisionId,
      '--include-audit-entry',
    ])) as Array<{
      downgradedFrom?: string;
      errorCode?: string;
      errorMessage?: string;
    }>;
    const toolRows = JSON.parse(expectSuccessfulCli([
      'list-tool-calls',
      '--turn',
      turnId,
      '--tool',
      'read_file',
    ])) as Array<{
      errorCode?: string;
      errorMessage?: string;
    }>;

    expect(actionRows).toHaveLength(1);
    expect(toolRows).toHaveLength(1);
    expect(actionRows[0]?.downgradedFrom).toContain('[REDACTED:');
    expect(actionRows[0]?.errorCode).toContain('[REDACTED:');
    expect(actionRows[0]?.errorMessage).toContain('[REDACTED:');
    expect(toolRows[0]?.errorCode).toContain('[REDACTED:');
    expect(toolRows[0]?.errorMessage).toContain('[REDACTED:');

    const serialized = JSON.stringify({ actionRows, toolRows });
    expect(serialized).toContain('[REDACTED:');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('456789012');
    expect(serialized).not.toContain(diagnosticCode);
    expect(serialized).not.toContain(downgradedFrom);

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns audit/action/tool inspection with redacted platform-like row and linkage IDs while preserving raw filters', () => {
    const now = Date.now();
    const rawEventId = 'evt-qq-123456789';
    const turnId = 'turn-qq-234567890';
    const decisionId = 'decision-qq-345678901';
    const executionId = 'execution-qq-456789012';
    const toolCallId = 'tool-qq-567890123';
    const auditId = 'audit-qq-678901234';
    const evaluatorDecisionId = 'eval-qq-789012345';
    const otherRawEventId = 'evt-qq-987654321';
    const otherTurnId = 'turn-qq-876543210';
    const otherDecisionId = 'decision-qq-765432109';
    const otherExecutionId = 'execution-qq-654321098';
    const otherToolCallId = 'tool-qq-543210987';
    const otherAuditId = 'audit-qq-432109876';

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      rawEventId,
      'message.private',
      now,
      'gateway',
      'qq',
      'private:redacted-linkage-match',
      '{}',
      now,
      otherRawEventId,
      'message.private',
      now + 1,
      'gateway',
      'qq',
      'private:redacted-linkage-other',
      '{}',
      now + 1
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      turnId,
      'private:redacted-linkage-match',
      rawEventId,
      'ctx-cli-redacted-linkage-match',
      'mock',
      'mock',
      'completed',
      now,
      now,
      otherTurnId,
      'private:redacted-linkage-other',
      otherRawEventId,
      'ctx-cli-redacted-linkage-other',
      'mock',
      'mock',
      'completed',
      now + 1,
      now + 1
    );
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      decisionId,
      turnId,
      'pi',
      'low',
      0.9,
      1,
      1,
      JSON.stringify([{ type: 'reply_full', payload: { text: 'matching action' } }]),
      JSON.stringify(['matching reason']),
      JSON.stringify([]),
      now,
      otherDecisionId,
      otherTurnId,
      'pi',
      'low',
      0.8,
      1,
      1,
      JSON.stringify([{ type: 'reply_full', payload: { text: 'other action' } }]),
      JSON.stringify(['other reason']),
      JSON.stringify([]),
      now + 1
    );
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status,
        executed_message_id, audit_level, audit_entry, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      executionId,
      decisionId,
      'reply_full',
      'success',
      'msg-redacted-linkage-match',
      'summary',
      'matching audit',
      now,
      otherExecutionId,
      otherDecisionId,
      'reply_full',
      'success',
      'msg-redacted-linkage-other',
      'summary',
      'other audit',
      now + 1
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        execution_time_ms, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      toolCallId,
      turnId,
      'read_file',
      JSON.stringify({ path: '/tmp/match' }),
      JSON.stringify({ ok: true }),
      'pi',
      'user-cli-redacted-linkage',
      'user',
      'private_chat',
      'success',
      3,
      0,
      now,
      otherToolCallId,
      otherTurnId,
      'read_file',
      JSON.stringify({ path: '/tmp/other' }),
      JSON.stringify({ ok: true }),
      'pi',
      'user-cli-redacted-linkage-other',
      'user',
      'private_chat',
      'success',
      4,
      0,
      now + 1
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level, evaluator_decision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      auditId,
      now,
      'tool',
      'redacted_full',
      'tool.call',
      toolCallId,
      'user-cli-redacted-linkage',
      'user',
      'private_chat',
      'matching audit summary',
      JSON.stringify({ toolCallId }),
      1,
      'low',
      evaluatorDecisionId,
      otherAuditId,
      now + 1,
      'tool',
      'redacted_full',
      'tool.call',
      otherToolCallId,
      'user-cli-redacted-linkage-other',
      'user',
      'private_chat',
      'other audit summary',
      JSON.stringify({ toolCallId: otherToolCallId }),
      1,
      'low',
      'eval-qq-210987654'
    );

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const auditRows = JSON.parse(expectSuccessfulCli([
      'list-audit',
      '--event-id',
      toolCallId,
      '--include-details',
    ])) as Array<{
      id: string;
      eventId: string;
      evaluatorDecisionId?: string;
      details?: { toolCallId?: string };
    }>;
    const actionRows = JSON.parse(expectSuccessfulCli([
      'list-action-decisions',
      '--turn',
      turnId,
    ])) as Array<{ id: string; turnId: string }>;
    const executionRows = JSON.parse(expectSuccessfulCli([
      'list-action-executions',
      '--decision',
      decisionId,
    ])) as Array<{ id: string; actionDecisionId: string }>;
    const toolRows = JSON.parse(expectSuccessfulCli([
      'list-tool-calls',
      '--turn',
      turnId,
      '--tool',
      'read_file',
    ])) as Array<{ id: string; turnId: string }>;

    expect(auditRows).toEqual([
      expect.objectContaining({
        id: 'audit-[REDACTED:platform_id]',
        eventId: 'tool-[REDACTED:platform_id]',
        evaluatorDecisionId: 'eval-[REDACTED:platform_id]',
        details: expect.objectContaining({
          toolCallId: 'tool-[REDACTED:platform_id]',
        }),
      }),
    ]);
    expect(actionRows).toEqual([
      expect.objectContaining({
        id: 'decision-[REDACTED:platform_id]',
        turnId: 'turn-[REDACTED:platform_id]',
      }),
    ]);
    expect(executionRows).toEqual([
      expect.objectContaining({
        id: 'execution-[REDACTED:platform_id]',
        actionDecisionId: 'decision-[REDACTED:platform_id]',
      }),
    ]);
    expect(toolRows).toEqual([
      expect.objectContaining({
        id: 'tool-[REDACTED:platform_id]',
        turnId: 'turn-[REDACTED:platform_id]',
      }),
    ]);

    const serialized = JSON.stringify({ auditRows, actionRows, executionRows, toolRows });
    for (const rawValue of [
      toolCallId,
      decisionId,
      executionId,
      auditId,
      evaluatorDecisionId,
      turnId,
      otherToolCallId,
      otherDecisionId,
      otherExecutionId,
      otherAuditId,
      otherTurnId,
    ]) {
      expect(serialized).not.toContain(rawValue);
    }
    expect(serialized).toContain('[REDACTED:platform_id]');

    const noMatch = JSON.parse(expectSuccessfulCli([
      'list-audit',
      '--event-id',
      otherToolCallId,
      '--risk',
      'medium',
    ])) as unknown[];
    expect(noMatch).toEqual([]);

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns action execution inspection with redacted platform-like executed message IDs', () => {
    const now = Date.now();
    const executedMessageId = 'qq-567890123';
    const otherExecutedMessageId = 'qq-987654321';

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-redacted-executed-message-match',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:redacted-executed-message-match',
      '{}',
      now,
      'evt-cli-redacted-executed-message-other',
      'message.private',
      now + 1,
      'gateway',
      'qq',
      'private:redacted-executed-message-other',
      '{}',
      now + 1
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-redacted-executed-message-match',
      'private:redacted-executed-message-match',
      'evt-cli-redacted-executed-message-match',
      'ctx-cli-redacted-executed-message-match',
      'mock',
      'mock',
      'completed',
      now,
      now,
      'turn-cli-redacted-executed-message-other',
      'private:redacted-executed-message-other',
      'evt-cli-redacted-executed-message-other',
      'ctx-cli-redacted-executed-message-other',
      'mock',
      'mock',
      'completed',
      now + 1,
      now + 1
    );
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'decision-cli-redacted-executed-message-match',
      'turn-cli-redacted-executed-message-match',
      'pi',
      'low',
      0.9,
      0,
      null,
      JSON.stringify([{ type: 'reply_full', payload: { text: 'matching reply' } }]),
      JSON.stringify(['matching reason']),
      JSON.stringify([]),
      now,
      'decision-cli-redacted-executed-message-other',
      'turn-cli-redacted-executed-message-other',
      'pi',
      'low',
      0.8,
      0,
      null,
      JSON.stringify([{ type: 'reply_full', payload: { text: 'other reply' } }]),
      JSON.stringify(['other reason']),
      JSON.stringify([]),
      now + 1
    );
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status,
        executed_message_id, audit_level, audit_entry, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'execution-cli-redacted-message-match',
      'decision-cli-redacted-executed-message-match',
      'reply_full',
      'success',
      executedMessageId,
      'summary',
      'matching audit',
      now,
      'execution-cli-redacted-message-other',
      'decision-cli-redacted-executed-message-other',
      'reply_full',
      'success',
      otherExecutedMessageId,
      'summary',
      'other audit',
      now + 1
    );

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const executionRows = JSON.parse(expectSuccessfulCli([
      'list-action-executions',
      '--decision',
      'decision-cli-redacted-executed-message-match',
      '--include-audit-entry',
    ])) as Array<{
      id: string;
      actionDecisionId: string;
      executedMessageId?: string;
      auditEntry?: string;
    }>;

    expect(executionRows).toEqual([
      expect.objectContaining({
        id: 'execution-cli-redacted-message-match',
        actionDecisionId: 'decision-cli-redacted-executed-message-match',
        executedMessageId: '[REDACTED:platform_id]',
        auditEntry: 'matching audit',
      }),
    ]);

    const serialized = JSON.stringify(executionRows);
    expect(serialized).not.toContain(executedMessageId);
    expect(serialized).not.toContain(otherExecutedMessageId);
    expect(serialized).not.toContain('execution-cli-redacted-message-other');
    expect(serialized).not.toContain('decision-cli-redacted-executed-message-other');
    expect(serialized).toContain('[REDACTED:platform_id]');

    const noMatch = JSON.parse(expectSuccessfulCli([
      'list-action-executions',
      '--decision',
      'decision-cli-redacted-executed-message-missing',
    ])) as unknown[];
    expect(noMatch).toEqual([]);

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns job inspection with redacted platform-like job identifiers while preserving raw filters', () => {
    const now = Date.now();
    const jobId = 'job-qq-456789012';
    const otherJobId = 'job-qq-987654321';
    const workerId = 'worker-cli-redacted-job-id';

    const jobRepo = new JobRepository(db);
    jobRepo.enqueue({
      id: jobId,
      type: 'summary',
      payload: { conversationId: 'private:redacted-job-id-match' },
      now,
    });
    jobRepo.enqueue({
      id: otherJobId,
      type: 'summary',
      payload: { conversationId: 'private:redacted-job-id-other' },
      now: now + 1,
    });

    const claimed = jobRepo.claimNext({
      workerId,
      now: now + 2,
      leaseMs: 60_000,
    });
    if (!claimed) {
      throw new Error('Expected redacted job ID row to be claimed');
    }
    jobRepo.heartbeat({
      workerId,
      workerType: 'background',
      status: 'running',
      currentJobId: jobId,
      details: { note: 'matching heartbeat' },
      now: now + 3,
    });

    const beforeRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const jobRows = JSON.parse(expectSuccessfulCli([
      'list-jobs',
      '--status',
      'running',
      '--type',
      'summary',
    ])) as Array<{ id: string; status: string }>;
    const attemptRows = JSON.parse(expectSuccessfulCli([
      'list-job-attempts',
      '--job',
      jobId,
      '--status',
      'running',
    ])) as Array<{ jobId: string; workerId: string }>;
    const heartbeatRows = JSON.parse(expectSuccessfulCli([
      'list-worker-heartbeats',
      '--worker',
      workerId,
      '--status',
      'running',
    ])) as Array<{ workerId: string; currentJobId?: string }>;

    expect(jobRows).toContainEqual(expect.objectContaining({
      id: 'job-[REDACTED:platform_id]',
      status: 'running',
    }));
    expect(attemptRows).toEqual([
      expect.objectContaining({
        jobId: 'job-[REDACTED:platform_id]',
        workerId,
      }),
    ]);
    expect(heartbeatRows).toEqual([
      expect.objectContaining({
        workerId,
        currentJobId: 'job-[REDACTED:platform_id]',
      }),
    ]);

    const serialized = JSON.stringify({ jobRows, attemptRows, heartbeatRows });
    expect(serialized).not.toContain(jobId);
    expect(serialized).not.toContain(otherJobId);
    expect(serialized).toContain('[REDACTED:platform_id]');

    const noMatch = JSON.parse(expectSuccessfulCli([
      'list-job-attempts',
      '--job',
      otherJobId,
      '--status',
      'running',
    ])) as unknown[];
    expect(noMatch).toEqual([]);

    reopenDb();
    const afterRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns job assignment-shaped include-payload without leaking raw keys', () => {
    const now = Date.now();
    const secret = 'sk-cli-job-assignment-secret-should-not-leak';
    const platformId = 'qq-678912349';
    const assignment = `api_key=${secret}-${platformId}`;
    const jobId = `job-${assignment}`;
    const jobType = `summary-${assignment}`;
    const otherAssignment = 'api_key=sk-cli-job-assignment-other-secret-qq-789123459';
    const otherJobId = `job-${otherAssignment}`;
    const otherJobType = `summary-${otherAssignment}`;

    const jobRepo = new JobRepository(db);
    jobRepo.enqueue({
      id: jobId,
      type: jobType,
      payload: {
        conversationId: `private:${assignment}`,
        [`diagnostic ${assignment}`]: {
          ownerUserId: 678912349,
          processedCount: 42,
        },
      },
      idempotencyKey: `summary:${assignment}`,
      now,
    });
    jobRepo.enqueue({
      id: otherJobId,
      type: otherJobType,
      payload: {
        conversationId: `private:${otherAssignment}`,
      },
      idempotencyKey: `summary:${otherAssignment}`,
      now: now + 1,
    });

    const claimed = jobRepo.claimNext({ workerId: `worker-${assignment}`, now: now + 2 });
    if (!claimed) {
      throw new Error('Expected assignment-shaped job seed to be claimed');
    }
    jobRepo.complete({
      jobId,
      attemptId: claimed.attemptId,
      result: {
        message: `completed ${assignment}`,
        [`result diagnostic ${assignment}`]: {
          recipientGroupIds: [678912350],
          processedCount: 43,
        },
      },
      now: now + 3,
    });

    const otherClaimed = jobRepo.claimNext({ workerId: `worker-${otherAssignment}`, now: now + 4 });
    if (!otherClaimed) {
      throw new Error('Expected other assignment-shaped job seed to be claimed');
    }
    jobRepo.complete({
      jobId: otherJobId,
      attemptId: otherClaimed.attemptId,
      result: { message: `other ${otherAssignment}` },
      now: now + 5,
    });

    const beforeRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const stdout = expectSuccessfulCli([
      'list-jobs',
      '--type',
      jobType,
      '--status',
      'completed',
      '--include-payload',
    ]);
    const rows = JSON.parse(stdout) as Array<{
      id: string;
      type: string;
      status: string;
      idempotencyKey?: string;
      payload?: Record<string, unknown> & {
        conversationId?: string;
      };
      result?: Record<string, unknown> & {
        message?: string;
        [key: string]: unknown;
      };
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      id: expect.stringContaining('[REDACTED:api_key_assignment]'),
      type: expect.stringContaining('[REDACTED:api_key_assignment]'),
      status: 'completed',
      idempotencyKey: expect.stringContaining('[REDACTED:api_key_assignment]'),
      payload: expect.objectContaining({
        conversationId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      }),
      result: expect.objectContaining({
        message: expect.stringContaining('[REDACTED:api_key_assignment]'),
      }),
    }));
    expect(rows[0]?.id).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.type).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.idempotencyKey).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.payload?.conversationId).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.result?.message).toContain('[REDACTED:platform_id]');
    const payloadKeys = Object.keys(rows[0]?.payload ?? {});
    expect(payloadKeys.some((key) => key.includes('[REDACTED:api_key_assignment]'))).toBe(true);
    expect(payloadKeys.some((key) => key.includes('[REDACTED:platform_id]'))).toBe(true);
    const resultKeys = Object.keys(rows[0]?.result ?? {});
    expect(resultKeys.some((key) => key.includes('[REDACTED:api_key_assignment]'))).toBe(true);
    expect(resultKeys.some((key) => key.includes('[REDACTED:platform_id]'))).toBe(true);
    const resultDiagnostic = Object.values(rows[0]?.result ?? {}).find(
      (value): value is { recipientGroupIds?: string[]; processedCount?: number } =>
        Boolean(value) && typeof value === 'object' && 'recipientGroupIds' in value
    );
    expect(resultDiagnostic).toEqual(expect.objectContaining({
      recipientGroupIds: ['[REDACTED:platform_id]'],
      processedCount: 43,
    }));

    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(platformId);
    expect(stdout).not.toContain('678912349');
    expect(stdout).not.toContain('678912350');
    expect(stdout).not.toContain(otherAssignment);
    expect(stdout).not.toContain('789123459');
    expect(stdout).not.toContain('src/');
    expect(stdout).not.toContain('\n    at ');

    reopenDb();
    const rawJob = db
      .prepare('SELECT id, type, payload, idempotency_key, result FROM jobs WHERE id = ?')
      .get(jobId) as {
        id: string;
        type: string;
        idempotency_key: string;
        result: string;
      };
    expect(rawJob.id).toBe(jobId);
    expect(rawJob.type).toBe(jobType);
    expect(rawJob.idempotency_key).toBe(`summary:${assignment}`);
    expect(rawJob.result).toContain('[REDACTED:api_key_assignment]');
    expect(rawJob.result).toContain('[REDACTED:platform_id]');
    expect(rawJob.result).not.toContain(secret);
    expect(rawJob.result).not.toContain(platformId);
    expect(rawJob.result).not.toContain('678912350');

    const afterRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns job attempt assignment-shaped include-result without leaking raw keys', () => {
    const now = Date.now();
    const secret = 'sk-cli-attempt-assignment-secret-should-not-leak';
    const platformId = 'qq-789012345';
    const assignment = `api_key=${secret}-${platformId}`;
    const jobId = `job-${assignment}`;
    const workerId = `worker-${assignment}`;
    const otherAssignment = 'api_key=sk-cli-attempt-assignment-other-secret-qq-890123456';
    const otherJobId = `job-${otherAssignment}`;
    const otherWorkerId = `worker-${otherAssignment}`;

    const jobRepo = new JobRepository(db);
    jobRepo.enqueue({
      id: jobId,
      type: 'summary',
      payload: { conversationId: 'private:attempt-assignment-match' },
      idempotencyKey: `summary:${assignment}`,
      now,
    });
    jobRepo.enqueue({
      id: otherJobId,
      type: 'summary',
      payload: { conversationId: 'private:attempt-assignment-other' },
      idempotencyKey: `summary:${otherAssignment}`,
      now: now + 1,
    });

    const claimed = jobRepo.claimNext({ workerId, now: now + 2 });
    if (!claimed) {
      throw new Error('Expected assignment-shaped attempt seed job to be claimed');
    }
    jobRepo.complete({
      jobId,
      attemptId: claimed.attemptId,
      result: {
        message: `completed ${assignment}`,
        [`diagnostic ${assignment}`]: {
          ownerUserId: '789012345',
          processedCount: 42,
        },
      },
      now: now + 3,
    });

    const otherClaimed = jobRepo.claimNext({ workerId: otherWorkerId, now: now + 4 });
    if (!otherClaimed) {
      throw new Error('Expected other assignment-shaped attempt seed job to be claimed');
    }
    jobRepo.complete({
      jobId: otherJobId,
      attemptId: otherClaimed.attemptId,
      result: { message: `other ${otherAssignment}` },
      now: now + 5,
    });

    const beforeRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const stdout = expectSuccessfulCli([
      'list-job-attempts',
      '--job',
      jobId,
      '--worker',
      workerId,
      '--status',
      'completed',
      '--include-result',
    ]);
    const rows = JSON.parse(stdout) as Array<{
      id: string;
      jobId: string;
      workerId: string;
      status: string;
      result?: Record<string, unknown> & {
        message?: string;
      };
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      jobId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      workerId: expect.stringContaining('[REDACTED:api_key_assignment]'),
      status: 'completed',
      result: expect.objectContaining({
        message: expect.stringContaining('[REDACTED:api_key_assignment]'),
      }),
    }));
    expect(rows[0]?.jobId).toContain('[REDACTED:platform_id]');
    expect(rows[0]?.workerId).toContain('[REDACTED:platform_id]');
    const resultKeys = Object.keys(rows[0]?.result ?? {});
    expect(resultKeys.some((key) => key.includes('[REDACTED:api_key_assignment]'))).toBe(true);
    expect(resultKeys.some((key) => key.includes('[REDACTED:platform_id]'))).toBe(true);

    expect(stdout).toContain('[REDACTED:api_key_assignment]');
    expect(stdout).toContain('[REDACTED:platform_id]');
    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain(platformId);
    expect(stdout).not.toContain('789012345');
    expect(stdout).not.toContain(otherAssignment);
    expect(stdout).not.toContain('890123456');
    expect(stdout).not.toContain('src/');
    expect(stdout).not.toContain('\n    at ');

    reopenDb();
    const rawAttempt = db
      .prepare('SELECT job_id, worker_id, result FROM job_attempts WHERE job_id = ?')
      .get(jobId) as { job_id: string; worker_id: string; result: string };
    expect(rawAttempt.job_id).toBe(jobId);
    expect(rawAttempt.worker_id).toBe(workerId);
    expect(rawAttempt.result).toContain('[REDACTED:api_key_assignment]');
    expect(rawAttempt.result).toContain('[REDACTED:platform_id]');
    expect(rawAttempt.result).not.toContain(secret);
    expect(rawAttempt.result).not.toContain(platformId);
    expect(rawAttempt.result).not.toContain('789012345');

    const afterRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns job and worker type inspection with redacted type values while preserving raw filters', () => {
    const now = Date.now();
    const secret = 'sk-cli-sensitive-type-secret-should-not-leak';
    const platformId = 'qq-456789012';
    const jobType = `summary-${platformId}-${secret}`;
    const otherJobType = `summary-qq-987654321-${secret}`;
    const workerType = `background-${platformId}-${secret}`;
    const otherWorkerType = `background-qq-987654321-${secret}`;

    const jobRepo = new JobRepository(db);
    jobRepo.enqueue({
      id: 'job-cli-sensitive-type-match',
      type: jobType,
      payload: { conversationId: 'private:job-type-match' },
      now,
    });
    jobRepo.enqueue({
      id: 'job-cli-sensitive-type-other',
      type: otherJobType,
      payload: { conversationId: 'private:job-type-other' },
      now: now + 1,
    });
    jobRepo.heartbeat({
      workerId: 'worker-cli-sensitive-type-match',
      workerType,
      status: 'idle',
      details: { note: 'matching worker type' },
      now: now + 2,
    });
    jobRepo.heartbeat({
      workerId: 'worker-cli-sensitive-type-other',
      workerType: otherWorkerType,
      status: 'idle',
      details: { note: 'other worker type' },
      now: now + 3,
    });

    const beforeRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };

    const jobRows = JSON.parse(expectSuccessfulCli([
      'list-jobs',
      '--type',
      jobType,
      '--include-payload',
    ])) as Array<{ type: string; payload?: Record<string, unknown> }>;
    const heartbeatRows = JSON.parse(expectSuccessfulCli([
      'list-worker-heartbeats',
      '--type',
      workerType,
      '--include-details',
    ])) as Array<{ workerType: string; details?: Record<string, unknown> }>;

    expect(jobRows).toEqual([
      expect.objectContaining({
        id: 'job-cli-sensitive-type-match',
        type: expect.stringContaining('[REDACTED:platform_id]'),
        payload: expect.objectContaining({ conversationId: 'private:job-type-match' }),
      }),
    ]);
    expect(jobRows[0]?.type).toContain('[REDACTED');
    expect(heartbeatRows).toEqual([
      expect.objectContaining({
        workerId: 'worker-cli-sensitive-type-match',
        workerType: expect.stringContaining('[REDACTED:platform_id]'),
        details: expect.objectContaining({ note: 'matching worker type' }),
      }),
    ]);
    expect(heartbeatRows[0]?.workerType).toContain('[REDACTED');

    const serialized = JSON.stringify({ jobRows, heartbeatRows });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain(otherJobType);
    expect(serialized).not.toContain(otherWorkerType);
    expect(serialized).toContain('[REDACTED:platform_id]');

    const noJobMatch = JSON.parse(expectSuccessfulCli(['list-jobs', '--type', otherJobType])) as unknown[];
    expect(noJobMatch).toEqual([
      expect.objectContaining({ id: 'job-cli-sensitive-type-other' }),
    ]);

    reopenDb();
    const afterRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns job legacy status inspection with redacted display values while preserving raw rows', () => {
    const now = Date.now();
    const secret = 'sk-cli-job-status-secret-should-not-leak';
    const platformId = 'qq-564738291';
    const jobStatus = `running-${platformId}-${secret}`;
    const attemptStatus = `failed-${platformId}-${secret}`;
    const heartbeatStatus = `error-${platformId}-${secret}`;

    db.pragma('ignore_check_constraints = ON');
    try {
      db.prepare(
        `INSERT INTO jobs (
          id, type, payload, status, attempts, max_attempts,
          created_at, updated_at, scheduled_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'job-cli-legacy-status-classification',
        'summary',
        JSON.stringify({ conversationId: 'private:cli-legacy-status-classification' }),
        jobStatus,
        1,
        3,
        now,
        now,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO job_attempts (
          id, job_id, attempt_number, worker_id, status,
          started_at, heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'attempt-cli-legacy-status-classification',
        'job-cli-legacy-status-classification',
        1,
        'worker-cli-legacy-status-classification',
        attemptStatus,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO worker_heartbeats (
          worker_id, worker_type, status, current_job_id, heartbeat_at, details
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        'worker-cli-legacy-status-classification',
        'background',
        heartbeatStatus,
        'job-cli-legacy-status-classification',
        now,
        JSON.stringify({ note: 'legacy status row' }),
      );
    } finally {
      db.pragma('ignore_check_constraints = OFF');
    }

    const beforeRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };

    const jobRows = JSON.parse(expectSuccessfulCli([
      'list-jobs',
      '--type',
      'summary',
    ])) as Array<{ id: string; status: string }>;
    const attemptRows = JSON.parse(expectSuccessfulCli([
      'list-job-attempts',
      '--job',
      'job-cli-legacy-status-classification',
    ])) as Array<{ id: string; status: string }>;
    const heartbeatRows = JSON.parse(expectSuccessfulCli([
      'list-worker-heartbeats',
      '--worker',
      'worker-cli-legacy-status-classification',
    ])) as Array<{ workerId: string; status: string }>;

    expect(jobRows).toEqual([
      expect.objectContaining({
        id: 'job-cli-legacy-status-classification',
        status: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);
    expect(attemptRows).toEqual([
      expect.objectContaining({
        id: 'attempt-cli-legacy-status-classification',
        status: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);
    expect(heartbeatRows).toEqual([
      expect.objectContaining({
        workerId: 'worker-cli-legacy-status-classification',
        status: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);
    const serialized = JSON.stringify({ jobRows, attemptRows, heartbeatRows });
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('564738291');

    reopenDb();
    const afterRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns inspection commands with redacted actor and worker identifiers while preserving raw filters', () => {
    const now = Date.now();
    const platformUserId = 'qq-123456789';
    const otherPlatformUserId = 'qq-987654321';
    const platformWorkerId = 'qq-234567890';
    const otherPlatformWorkerId = 'qq-345678901';

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('evt-cli-redacted-actor-worker', 'message.private', now, 'gateway', 'qq', 'private:cli-redacted', '{}', now);
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-redacted-actor-worker',
      'private:cli-redacted',
      'evt-cli-redacted-actor-worker',
      'ctx-cli-redacted',
      'mock',
      'mock',
      'completed',
      now,
      now
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        execution_time_ms, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'tool-cli-redacted-actor-worker-match',
      'turn-cli-redacted-actor-worker',
      'read_file',
      JSON.stringify({ path: '/tmp/match' }),
      JSON.stringify({ ok: true }),
      'user',
      platformUserId,
      'user',
      'private_chat',
      'success',
      2,
      0,
      now,
      'tool-cli-redacted-actor-worker-other',
      'turn-cli-redacted-actor-worker',
      'write_file',
      JSON.stringify({ path: '/tmp/other' }),
      JSON.stringify({ ok: true }),
      'user',
      otherPlatformUserId,
      'user',
      'private_chat',
      'success',
      3,
      0,
      now + 1
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-redacted-actor-worker-match',
      now,
      'tool',
      'summary',
      'tool.call',
      'tool-cli-redacted-actor-worker-match',
      platformUserId,
      'user',
      'private_chat',
      'actor identifier redaction match',
      JSON.stringify({ ok: true }),
      1,
      'low',
      'audit-cli-redacted-actor-worker-other',
      now + 1,
      'tool',
      'summary',
      'tool.call',
      'tool-cli-redacted-actor-worker-other',
      otherPlatformUserId,
      'user',
      'private_chat',
      'actor identifier redaction other',
      JSON.stringify({ ok: true }),
      1,
      'low'
    );

    const jobRepo = new JobRepository(db);
    jobRepo.enqueue({
      id: 'job-cli-redacted-actor-worker-match',
      type: 'summary',
      payload: { conversationId: 'private:cli-redacted' },
      now,
    });
    jobRepo.enqueue({
      id: 'job-cli-redacted-actor-worker-other',
      type: 'summary',
      payload: { conversationId: 'private:cli-redacted-other' },
      now: now + 1,
    });
    const claimed = jobRepo.claimNext({
      workerId: platformWorkerId,
      now: now + 2,
      leaseMs: 60_000,
    });
    if (!claimed) {
      throw new Error('Expected redacted actor/worker job to be claimed');
    }
    const otherClaimed = jobRepo.claimNext({
      workerId: otherPlatformWorkerId,
      now: now + 3,
      leaseMs: 60_000,
    });
    if (!otherClaimed) {
      throw new Error('Expected other redacted actor/worker job to be claimed');
    }
    jobRepo.heartbeat({
      workerId: platformWorkerId,
      workerType: 'background',
      status: 'running',
      currentJobId: 'job-cli-redacted-actor-worker-match',
      details: { note: 'matching heartbeat' },
      now: now + 4,
    });
    jobRepo.heartbeat({
      workerId: otherPlatformWorkerId,
      workerType: 'background',
      status: 'running',
      currentJobId: 'job-cli-redacted-actor-worker-other',
      details: { note: 'other heartbeat' },
      now: now + 5,
    });

    const beforeRows = {
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };

    const auditRows = JSON.parse(expectSuccessfulCli([
      'list-audit',
      '--user',
      platformUserId,
    ])) as Array<{ id: string; actor: { canonicalUserId?: string } }>;
    const toolRows = JSON.parse(expectSuccessfulCli([
      'list-tool-calls',
      '--turn',
      'turn-cli-redacted-actor-worker',
      '--tool',
      'read_file',
    ])) as Array<{ id: string; actor: { canonicalUserId?: string } }>;
    const jobRows = JSON.parse(expectSuccessfulCli([
      'list-jobs',
      '--status',
      'running',
      '--type',
      'summary',
    ])) as Array<{ id: string; leaseOwner?: string }>;
    const attemptRows = JSON.parse(expectSuccessfulCli([
      'list-job-attempts',
      '--worker',
      platformWorkerId,
      '--status',
      'running',
    ])) as Array<{ jobId: string; workerId: string }>;
    const heartbeatRows = JSON.parse(expectSuccessfulCli([
      'list-worker-heartbeats',
      '--worker',
      platformWorkerId,
      '--type',
      'background',
      '--status',
      'running',
    ])) as Array<{ workerId: string; currentJobId?: string }>;

    expect(auditRows).toEqual([
      expect.objectContaining({
        id: 'audit-cli-redacted-actor-worker-match',
        actor: expect.objectContaining({ canonicalUserId: '[REDACTED:platform_id]' }),
      }),
    ]);
    expect(toolRows).toEqual([
      expect.objectContaining({
        id: 'tool-cli-redacted-actor-worker-match',
        actor: expect.objectContaining({ canonicalUserId: '[REDACTED:platform_id]' }),
      }),
    ]);
    expect(jobRows).toContainEqual(expect.objectContaining({
      id: 'job-cli-redacted-actor-worker-match',
      leaseOwner: '[REDACTED:platform_id]',
    }));
    expect(attemptRows).toEqual([
      expect.objectContaining({
        jobId: 'job-cli-redacted-actor-worker-match',
        workerId: '[REDACTED:platform_id]',
      }),
    ]);
    expect(heartbeatRows).toEqual([
      expect.objectContaining({
        workerId: '[REDACTED:platform_id]',
        currentJobId: 'job-cli-redacted-actor-worker-match',
      }),
    ]);

    const serialized = JSON.stringify({
      auditRows,
      toolRows,
      jobRows,
      attemptRows,
      heartbeatRows,
    });
    expect(serialized).not.toContain(platformUserId);
    expect(serialized).not.toContain(otherPlatformUserId);
    expect(serialized).not.toContain(platformWorkerId);
    expect(serialized).not.toContain(otherPlatformWorkerId);
    expect(serialized).toContain('[REDACTED:platform_id]');

    reopenDb();
    const afterRows = {
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns audit and tool inspection with redacted legacy actor metadata', () => {
    const now = Date.now();
    const secret = 'sk-legacyauditactorabcdefghijklmnop';
    const platformId = 'qq-765432109';
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-legacy-actor-metadata',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:cli-legacy-actor-metadata',
      '{}',
      now
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-legacy-actor-metadata',
      'private:cli-legacy-actor-metadata',
      'evt-cli-legacy-actor-metadata',
      'ctx-cli-legacy-actor-metadata',
      'mock',
      'mock',
      'completed',
      now,
      now
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        execution_time_ms, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'tool-cli-legacy-actor-metadata',
      'turn-cli-legacy-actor-metadata',
      'read_file',
      JSON.stringify({ path: '/tmp/legacy-actor-metadata' }),
      JSON.stringify({ ok: true }),
      'user',
      `user-${secret}-${platformId}`,
      `legacy_actor_${secret}_${platformId}`,
      `legacy_context_${secret}_${platformId}`,
      'success',
      2,
      0,
      now
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-legacy-actor-metadata',
      now,
      'tool',
      'summary',
      'tool.call',
      'audit-event-cli-legacy-actor-metadata',
      `user-${secret}-${platformId}`,
      `legacy_actor_${secret}_${platformId}`,
      `legacy_context_${secret}_${platformId}`,
      'legacy actor metadata inspection',
      JSON.stringify({ ok: true }),
      1,
      'low'
    );

    const beforeRows = {
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
    };

    const auditRows = JSON.parse(expectSuccessfulCli([
      'list-audit',
      '--event-id',
      'audit-event-cli-legacy-actor-metadata',
    ])) as Array<{
      actor: {
        canonicalUserId?: string;
        actorClass?: string;
        context?: string;
      };
    }>;
    const toolRows = JSON.parse(expectSuccessfulCli([
      'list-tool-calls',
      '--turn',
      'turn-cli-legacy-actor-metadata',
      '--tool',
      'read_file',
    ])) as Array<{
      actor: {
        canonicalUserId?: string;
        actorClass?: string;
      };
      context?: string;
    }>;

    expect(auditRows).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:'),
          actorClass: expect.stringContaining('[REDACTED:'),
          context: expect.stringContaining('[REDACTED:'),
        }),
      }),
    ]);
    expect(toolRows).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:'),
          actorClass: expect.stringContaining('[REDACTED:'),
        }),
        context: expect.stringContaining('[REDACTED:'),
      }),
    ]);

    const serialized = JSON.stringify({ auditRows, toolRows });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain('765432109');

    reopenDb();
    const afterRows = {
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns audit and tool inspection with redacted embedded platform identifiers in legacy metadata', () => {
    const now = Date.now();
    const platformId = 'qq-876543210';
    const numericPlatformId = '876543210';
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-embedded-platform-metadata',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:cli-embedded-platform-metadata',
      '{}',
      now
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-embedded-platform-metadata',
      'private:cli-embedded-platform-metadata',
      'evt-cli-embedded-platform-metadata',
      'ctx-cli-embedded-platform-metadata',
      'mock',
      'mock',
      'completed',
      now,
      now
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        execution_time_ms, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'tool-cli-embedded-platform-metadata',
      'turn-cli-embedded-platform-metadata',
      'read_file',
      JSON.stringify({ path: '/tmp/embedded-platform-metadata' }),
      JSON.stringify({ ok: true }),
      'user',
      `legacy_user_${platformId}`,
      `legacy_actor_${platformId}`,
      `legacy_context_${numericPlatformId}`,
      'success',
      2,
      0,
      now
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-embedded-platform-metadata',
      now,
      'tool',
      'summary',
      'tool.call',
      'audit-event-cli-embedded-platform-metadata',
      `legacy_user_${platformId}`,
      `legacy_actor_${platformId}`,
      `legacy_context_${numericPlatformId}`,
      'embedded platform metadata inspection',
      JSON.stringify({ ok: true }),
      1,
      'low'
    );

    const beforeRows = {
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
    };

    const auditRows = JSON.parse(expectSuccessfulCli([
      'list-audit',
      '--event-id',
      'audit-event-cli-embedded-platform-metadata',
    ])) as Array<{
      actor: {
        canonicalUserId?: string;
        actorClass?: string;
        context?: string;
      };
    }>;
    const toolRows = JSON.parse(expectSuccessfulCli([
      'list-tool-calls',
      '--turn',
      'turn-cli-embedded-platform-metadata',
      '--tool',
      'read_file',
    ])) as Array<{
      actor: {
        canonicalUserId?: string;
        actorClass?: string;
      };
      context?: string;
    }>;

    expect(auditRows).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:platform_id]'),
          actorClass: expect.stringContaining('[REDACTED:platform_id]'),
          context: expect.stringContaining('[REDACTED:platform_id]'),
        }),
      }),
    ]);
    expect(toolRows).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({
          canonicalUserId: expect.stringContaining('[REDACTED:platform_id]'),
          actorClass: expect.stringContaining('[REDACTED:platform_id]'),
        }),
        context: expect.stringContaining('[REDACTED:platform_id]'),
      }),
    ]);

    const serialized = JSON.stringify({ auditRows, toolRows });
    expect(serialized).not.toContain(platformId);
    expect(serialized).not.toContain(numericPlatformId);
    expect(serialized).toContain('[REDACTED:platform_id]');

    reopenDb();
    const afterRows = {
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns final worker failure inspection with retained heartbeat job linkage and redacted details', async () => {
    const now = Date.now();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const jobId = 'job-qq-678901234';
    const workerId = 'qq-567890123';
    const platformIdInError = 'qq-789012345';
    const jobRepo = new JobRepository(db);
    jobRepo.enqueue({
      id: jobId,
      type: 'conflict',
      payload: { conversationId: 'group:cli-worker-failure', token: secret },
      idempotencyKey: `conflict:${secret}`,
      maxAttempts: 1,
      now,
    });

    const worker = new BackgroundWorker({
      jobRepository: jobRepo,
      workerId,
      handlers: {
        conflict: async () => {
          throw new Error(`api_key=${secret} final failure for ${platformIdInError}`);
        },
      },
    });

    const result = await worker.processNext();
    expect(result).toMatchObject({
      taskId: jobId,
      status: 'failed',
    });
    expect(result?.error).toContain('[REDACTED:api_key_assignment]');
    expect(result?.error).toContain('[REDACTED:platform_id]');
    expect(result?.error).not.toContain(secret);
    expect(result?.error).not.toContain(platformIdInError);

    const emptyPoll = await worker.processNext();
    expect(emptyPoll).toBeNull();

    const persistedHeartbeat = db
      .prepare('SELECT status, current_job_id FROM worker_heartbeats WHERE worker_id = ?')
      .get(workerId) as { status: string; current_job_id: string | null };
    expect(persistedHeartbeat).toEqual({
      status: 'error',
      current_job_id: jobId,
    });
    const persistedJobError = db.prepare('SELECT error FROM jobs WHERE id = ?').get(jobId) as {
      error: string;
    };
    const persistedAttemptError = db
      .prepare('SELECT error FROM job_attempts WHERE job_id = ?')
      .get(jobId) as {
      error: string;
    };
    const persistedHeartbeatDetails = db
      .prepare('SELECT details FROM worker_heartbeats WHERE worker_id = ?')
      .get(workerId) as { details: string };
    expect(persistedJobError.error).toContain('[REDACTED:api_key_assignment]');
    expect(persistedJobError.error).toContain('[REDACTED:platform_id]');
    expect(persistedJobError.error).not.toContain(secret);
    expect(persistedJobError.error).not.toContain(platformIdInError);
    expect(persistedAttemptError.error).toBe(persistedJobError.error);
    expect(persistedHeartbeatDetails.details).toContain('[REDACTED:api_key_assignment]');
    expect(persistedHeartbeatDetails.details).toContain('[REDACTED:platform_id]');
    expect(persistedHeartbeatDetails.details).not.toContain(secret);
    expect(persistedHeartbeatDetails.details).not.toContain(platformIdInError);

    const beforeRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };

    const jobRows = JSON.parse(expectSuccessfulCli([
      'list-jobs',
      '--status',
      'failed',
      '--type',
      'conflict',
      '--include-payload',
    ])) as Array<{ id: string; error?: string; payload?: unknown; idempotencyKey?: string }>;
    const attemptRows = JSON.parse(expectSuccessfulCli([
      'list-job-attempts',
      '--job',
      jobId,
      '--worker',
      workerId,
      '--status',
      'failed',
      '--include-result',
    ])) as Array<{ jobId: string; workerId: string; status: string; error?: string; result?: unknown }>;
    const heartbeatRows = JSON.parse(expectSuccessfulCli([
      'list-worker-heartbeats',
      '--worker',
      workerId,
      '--type',
      'background',
      '--status',
      'error',
      '--include-details',
    ])) as Array<{
      workerId: string;
      status: string;
      currentJobId?: string;
      details?: { jobId?: string; error?: string };
    }>;

    expect(jobRows).toEqual([
      expect.objectContaining({
        id: 'job-[REDACTED:platform_id]',
        error: expect.stringContaining('[REDACTED:api_key_assignment]'),
        payload: expect.objectContaining({
          conversationId: 'group:cli-worker-failure',
          token: '[REDACTED:openai_like_api_key]',
        }),
        idempotencyKey: expect.stringContaining('[REDACTED:openai_like_api_key]'),
      }),
    ]);
    expect(attemptRows).toEqual([
      expect.objectContaining({
        jobId: 'job-[REDACTED:platform_id]',
        workerId: '[REDACTED:platform_id]',
        status: 'failed',
        error: expect.stringContaining('[REDACTED:api_key_assignment]'),
      }),
    ]);
    expect(attemptRows[0]).not.toHaveProperty('result');
    expect(heartbeatRows).toEqual([
      expect.objectContaining({
        workerId: '[REDACTED:platform_id]',
        status: 'error',
        currentJobId: 'job-[REDACTED:platform_id]',
        details: {
          jobId: 'job-[REDACTED:platform_id]',
          error: expect.stringContaining('[REDACTED:api_key_assignment]'),
        },
      }),
    ]);

    const serialized = JSON.stringify({ jobRows, attemptRows, heartbeatRows });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(jobId);
    expect(serialized).not.toContain(workerId);
    expect(serialized).not.toContain(platformIdInError);
    expect(serialized).toContain('[REDACTED:platform_id]');

    const noMatch = JSON.parse(expectSuccessfulCli([
      'list-worker-heartbeats',
      '--worker',
      'qq-000000000',
      '--status',
      'error',
    ])) as unknown[];
    expect(noMatch).toEqual([]);

    reopenDb();
    const afterRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      jobAttempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      workerHeartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns failed job inspection after max-attempt lease cleanup with redacted payloads', () => {
    const now = Date.now();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const jobRepo = new JobRepository(db);
    const jobId = jobRepo.enqueue({
      id: 'job-cli-expired-max-attempt',
      type: 'summary',
      payload: { conversationId: 'private:cli-expired-max', token: secret },
      idempotencyKey: `summary:${secret}`,
      maxAttempts: 1,
      now,
    });
    const first = jobRepo.claimNext({
      workerId: 'worker-cli-expired-max-a',
      now: now + 1,
      leaseMs: 100,
    });
    if (!first) {
      throw new Error('Expected max-attempt cleanup seed job to be claimed');
    }

    const retry = jobRepo.claimNext({
      workerId: 'worker-cli-expired-max-b',
      now: now + 102,
      leaseMs: 100,
    });
    expect(retry).toBeNull();
    const expiredRunningJobId = jobRepo.enqueue({
      id: 'job-cli-expired-running-health',
      type: 'retention',
      payload: { token: secret },
      maxAttempts: 3,
      now: 0,
    });
    const expiredRunningClaim = jobRepo.claimNext({
      workerId: 'worker-cli-expired-running-health',
      now: 1,
      leaseMs: 1,
    });
    if (!expiredRunningClaim) {
      throw new Error('Expected expired running health seed job to be claimed');
    }
    expect(expiredRunningJobId).toBe('job-cli-expired-running-health');

    const jobRows = JSON.parse(expectSuccessfulCli([
      'list-jobs',
      '--status',
      'failed',
      '--type',
      'summary',
      '--include-payload',
    ])) as Array<{
      id: string;
      type: string;
      status: string;
      attempts: number;
      maxAttempts: number;
      idempotencyKey?: string;
      leaseOwner?: string;
      leaseExpiresAt?: string;
      error?: string;
      payload?: Record<string, unknown>;
    }>;
    const attemptRows = JSON.parse(expectSuccessfulCli([
      'list-job-attempts',
      '--job',
      jobId,
      '--status',
      'failed',
      '--include-result',
    ])) as Array<{
      jobId: string;
      attemptNumber: number;
      workerId: string;
      status: string;
      error?: string;
      result?: unknown;
    }>;
    const health = JSON.parse(expectSuccessfulCli(['summarize-governance-health'])) as {
      jobs: {
        total: number;
        byStatus: Record<string, number>;
        byType: Record<string, number>;
        failed: number;
        running: number;
        expiredRunningLeases: number;
      };
      attention: { failedJobs: number; expiredRunningLeases: number };
    };

    expect(jobRows).toEqual([
      expect.objectContaining({
        id: 'job-cli-expired-max-attempt',
        type: 'summary',
        status: 'failed',
        attempts: 1,
        maxAttempts: 1,
        error: 'Lease expired after max attempts',
        payload: expect.objectContaining({
          conversationId: 'private:cli-expired-max',
          token: expect.stringContaining('[REDACTED:'),
        }),
        idempotencyKey: expect.stringContaining('[REDACTED:'),
      }),
    ]);
    expect(jobRows[0]).not.toHaveProperty('leaseOwner');
    expect(jobRows[0]).not.toHaveProperty('leaseExpiresAt');

    expect(attemptRows).toEqual([
      expect.objectContaining({
        jobId,
        attemptNumber: 1,
        workerId: 'worker-cli-expired-max-a',
        status: 'failed',
        error: 'Lease expired after max attempts',
      }),
    ]);
    expect(attemptRows[0]).not.toHaveProperty('result');

    expect(health.jobs).toMatchObject({
      total: 2,
      byStatus: { failed: 1, running: 1 },
      byType: { summary: 1, retention: 1 },
      failed: 1,
      running: 1,
      expiredRunningLeases: 1,
    });
    expect(health.attention.failedJobs).toBe(1);
    expect(health.attention.expiredRunningLeases).toBe(1);

    const serialized = JSON.stringify({ jobRows, attemptRows, health });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('worker-cli-expired-max-b');
    expect(serialized).not.toContain('worker-cli-expired-running-health');

    reopenDb();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns audit/action/tool/job filter variants without cross-returning hidden payloads', () => {
    const now = Date.now();
    const secret = 'sk-bcdefghijklmnopqrstuvwxyz1234567';

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-filter-match',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:cli-filter',
      '{}',
      now,
      'evt-cli-filter-other',
      'message.private',
      now + 1,
      'gateway',
      'qq',
      'private:cli-filter-other',
      '{}',
      now + 1,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-filter-match',
      'private:cli-filter',
      'evt-cli-filter-match',
      'ctx-cli-filter-match',
      'mock',
      'mock',
      'completed',
      now,
      now,
      'turn-cli-filter-other',
      'private:cli-filter-other',
      'evt-cli-filter-other',
      'ctx-cli-filter-other',
      'mock',
      'mock',
      'completed',
      now + 1,
      now + 1,
    );
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'decision-cli-filter-match',
      'turn-cli-filter-match',
      'evaluator',
      'high',
      0.6,
      1,
      1,
      JSON.stringify([{ type: 'dm_user', payload: { text: `hidden action ${secret}` } }]),
      JSON.stringify([`filtered reason ${secret}`]),
      JSON.stringify([]),
      now,
      'decision-cli-filter-other',
      'turn-cli-filter-other',
      'pi',
      'low',
      0.9,
      0,
      null,
      JSON.stringify([{ type: 'reply_short', payload: { text: 'other action' } }]),
      JSON.stringify(['other reason']),
      JSON.stringify([]),
      now + 1,
    );
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status,
        error_code, error_message, audit_level, audit_entry, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'execution-cli-filter-match',
      'decision-cli-filter-match',
      'dm_user',
      'failed',
      'policy_denied',
      `execution error ${secret}`,
      'redacted_full',
      `execution audit ${secret}`,
      now,
      'execution-cli-filter-other',
      'decision-cli-filter-other',
      'reply_short',
      'success',
      null,
      null,
      'summary',
      'other audit',
      now + 1,
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        error_code, error_message, execution_time_ms, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'tool-cli-filter-match',
      'turn-cli-filter-match',
      'shell_run',
      JSON.stringify({ command: `echo ${secret}` }),
      JSON.stringify({ text: `tool output ${secret}` }),
      'pi',
      'user-cli',
      'user',
      'private_chat',
      'error',
      'denied',
      `tool error ${secret}`,
      7,
      0,
      now,
      'tool-cli-filter-other',
      'turn-cli-filter-other',
      'read_file',
      JSON.stringify({ path: '/tmp/other' }),
      JSON.stringify({ text: 'other output' }),
      'pi',
      'user-cli',
      'user',
      'private_chat',
      'success',
      null,
      null,
      3,
      0,
      now + 1,
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-filter-match',
      now,
      'tool',
      'full',
      'tool.call',
      'tool-cli-filter-match',
      'user-cli',
      'user',
      'private_chat',
      `tool audit summary ${secret}`,
      JSON.stringify({ output: `tool audit details ${secret}` }),
      0,
      'high',
      'audit-cli-filter-other',
      now + 1,
      'memory',
      'summary',
      'memory.create',
      'memory-cli-filter-other',
      'user-cli',
      'user',
      'private_chat',
      'other audit summary',
      JSON.stringify({ output: 'other audit details' }),
      1,
      'low',
    );

    const jobRepo = new JobRepository(db);
    const jobId = jobRepo.enqueue({
      id: 'job-cli-filter-match',
      type: 'summary',
      payload: { conversationId: 'private:cli-filter', token: secret },
      idempotencyKey: `summary:${secret}`,
      now,
    });
    jobRepo.enqueue({
      id: 'job-cli-filter-other',
      type: 'retention',
      payload: { target: 'other' },
      now: now + 1,
    });
    const claimed = jobRepo.claimNext({ workerId: 'worker-cli-filter-match', now: now + 2 });
    if (!claimed) {
      throw new Error('Expected CLI filter job to be claimed');
    }
    jobRepo.complete({
      jobId,
      attemptId: claimed.attemptId,
      result: { output: `job result ${secret}` },
      now: now + 3,
    });
    jobRepo.heartbeat({
      workerId: 'worker-cli-filter-match',
      workerType: 'background',
      status: 'idle',
      details: { token: secret },
      now: now + 4,
    });
    jobRepo.heartbeat({
      workerId: 'worker-cli-filter-other',
      workerType: 'maintenance',
      status: 'running',
      details: { note: 'other worker' },
      now: now + 5,
    });

    const auditRows = JSON.parse(expectSuccessfulCli([
      'list-audit',
      '--category',
      'tool',
      '--risk',
      'high',
    ])) as Array<{ id: string; details?: unknown; summary: string }>;
    const actionDecisionRows = JSON.parse(expectSuccessfulCli([
      'list-action-decisions',
      '--decided-by',
      'evaluator',
      '--risk',
      'high',
    ])) as Array<{ id: string; actions?: unknown; reasons: string[] }>;
    const actionExecutionRows = JSON.parse(expectSuccessfulCli([
      'list-action-executions',
      '--action-type',
      'dm_user',
      '--status',
      'failed',
    ])) as Array<{ id: string; auditEntry?: string; errorMessage?: string }>;
    const toolRows = JSON.parse(expectSuccessfulCli([
      'list-tool-calls',
      '--tool',
      'shell_run',
      '--status',
      'error',
    ])) as Array<{ id: string; input?: unknown; output?: unknown; errorMessage?: string }>;
    const jobRows = JSON.parse(expectSuccessfulCli([
      'list-jobs',
      '--type',
      'summary',
      '--status',
      'completed',
    ])) as Array<{ id: string; payload?: unknown; result?: unknown; idempotencyKey?: string }>;
    const attemptRows = JSON.parse(expectSuccessfulCli([
      'list-job-attempts',
      '--worker',
      'worker-cli-filter-match',
      '--status',
      'completed',
    ])) as Array<{ jobId: string; result?: unknown; workerId: string }>;
    const heartbeatRows = JSON.parse(expectSuccessfulCli([
      'list-worker-heartbeats',
      '--worker',
      'worker-cli-filter-match',
      '--type',
      'background',
      '--status',
      'idle',
    ])) as Array<{ workerId: string; details?: unknown }>;

    expect(auditRows).toEqual([
      expect.objectContaining({
        id: 'audit-cli-filter-match',
        summary: expect.stringContaining('[REDACTED:'),
      }),
    ]);
    expect(auditRows[0]).not.toHaveProperty('details');
    expect(actionDecisionRows).toEqual([
      expect.objectContaining({
        id: 'decision-cli-filter-match',
        reasons: [expect.stringContaining('[REDACTED:')],
      }),
    ]);
    expect(actionDecisionRows[0]).not.toHaveProperty('actions');
    expect(actionExecutionRows).toEqual([
      expect.objectContaining({
        id: 'execution-cli-filter-match',
        errorMessage: expect.stringContaining('[REDACTED:'),
      }),
    ]);
    expect(actionExecutionRows[0]).not.toHaveProperty('auditEntry');
    expect(toolRows).toEqual([
      expect.objectContaining({
        id: 'tool-cli-filter-match',
        errorMessage: expect.stringContaining('[REDACTED:'),
      }),
    ]);
    expect(toolRows[0]).not.toHaveProperty('input');
    expect(toolRows[0]).not.toHaveProperty('output');
    expect(jobRows).toEqual([
      expect.objectContaining({
        id: 'job-cli-filter-match',
        idempotencyKey: expect.stringContaining('[REDACTED:'),
      }),
    ]);
    expect(jobRows[0]).not.toHaveProperty('payload');
    expect(jobRows[0]).not.toHaveProperty('result');
    expect(attemptRows).toEqual([
      expect.objectContaining({
        jobId: 'job-cli-filter-match',
        workerId: 'worker-cli-filter-match',
      }),
    ]);
    expect(attemptRows[0]).not.toHaveProperty('result');
    expect(heartbeatRows).toEqual([
      expect.objectContaining({
        workerId: 'worker-cli-filter-match',
      }),
    ]);
    expect(heartbeatRows[0]).not.toHaveProperty('details');

    const serialized = JSON.stringify({
      auditRows,
      actionDecisionRows,
      actionExecutionRows,
      toolRows,
      jobRows,
      attemptRows,
      heartbeatRows,
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('other audit summary');
    expect(serialized).not.toContain('tool-cli-filter-other');
    expect(serialized).not.toContain('decision-cli-filter-other');
    expect(serialized).not.toContain('execution-cli-filter-other');
    expect(serialized).not.toContain('job-cli-filter-other');
    expect(serialized).not.toContain('worker-cli-filter-other');

    reopenDb();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns job status validation errors without leaking invalid values or mutating data', () => {
    const now = Date.now();
    const secret = 'sk-cdefghijklmnopqrstuvwxyz12345678';
    const invalidJobStatus = `completed-${secret}-qq-123456789`;
    const invalidAttemptStatus = `running-${secret}-qq-234567890`;
    const invalidHeartbeatStatus = `idle-${secret}-qq-345678901`;

    const jobRepo = new JobRepository(db);
    const jobId = jobRepo.enqueue({
      id: 'job-cli-status-validation',
      type: 'summary',
      payload: { conversationId: 'private:cli-status-validation', token: secret },
      idempotencyKey: `status-validation:${secret}`,
      now,
    });
    const claimed = jobRepo.claimNext({ workerId: 'worker-cli-status-validation', now: now + 1 });
    if (!claimed) {
      throw new Error('Expected status validation job to be claimed');
    }
    jobRepo.heartbeat({
      workerId: 'worker-cli-status-validation',
      workerType: 'background',
      status: 'running',
      currentJobId: jobId,
      details: { token: secret },
      now: now + 2,
    });

    const beforeRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      attempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      heartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const results = [
      runCli(['list-jobs', '--status', invalidJobStatus]),
      runCli(['list-job-attempts', '--status', invalidAttemptStatus]),
      runCli(['list-worker-heartbeats', '--status', invalidHeartbeatStatus]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('❌ Invalid');
      expect(result.stderr).toContain('[REDACTED:');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain('123456789');
      expect(result.stderr).not.toContain('234567890');
      expect(result.stderr).not.toContain('345678901');
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('\n    at ');
      expect(result.stderr).not.toContain('TypeError');
    }
    expect(results[0]?.stderr).toContain('Invalid job status');
    expect(results[1]?.stderr).toContain('Invalid job attempt status');
    expect(results[2]?.stderr).toContain('Invalid worker heartbeat status');

    reopenDb();
    const afterRows = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      attempts: db.prepare('SELECT * FROM job_attempts ORDER BY id').all(),
      heartbeats: db.prepare('SELECT * FROM worker_heartbeats ORDER BY worker_id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns action and tool filter validation errors without leaking invalid values or mutating data', () => {
    const now = Date.now();
    const secret = 'sk-defghijklmnopqrstuvwxyz123456789';
    const invalidDecisionSource = `pi-${secret}-qq-123456789`;
    const invalidRisk = `high-${secret}-qq-234567890`;
    const invalidActionType = `reply_short-${secret}-qq-345678901`;
    const invalidExecutionStatus = `failed-${secret}-qq-456789012`;
    const invalidToolStatus = `error-${secret}-qq-567890123`;

    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-cli-action-tool-validation',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:cli-action-tool-validation',
      '{}',
      now
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, context_pack_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-cli-action-tool-validation',
      'private:cli-action-tool-validation',
      'evt-cli-action-tool-validation',
      'ctx-cli-action-tool-validation',
      'mock',
      'mock',
      'completed',
      now,
      now
    );
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'decision-cli-action-tool-validation',
      'turn-cli-action-tool-validation',
      'pi',
      'high',
      0.8,
      1,
      1,
      JSON.stringify([{ type: 'reply_short', payload: { text: `hidden action ${secret}` } }]),
      JSON.stringify([`hidden decision reason ${secret}`]),
      JSON.stringify([]),
      now
    );
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status,
        error_code, error_message, audit_level, audit_entry, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'execution-cli-action-tool-validation',
      'decision-cli-action-tool-validation',
      'reply_short',
      'failed',
      'adapter_error',
      `hidden execution error ${secret}`,
      'redacted_full',
      `hidden audit entry ${secret}`,
      now
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output, requested_by,
        actor_user_id, actor_class, invocation_context, status,
        error_code, error_message, execution_time_ms, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'tool-cli-action-tool-validation',
      'turn-cli-action-tool-validation',
      'shell_run',
      JSON.stringify({ command: `echo ${secret}` }),
      JSON.stringify({ text: `tool output ${secret}` }),
      'pi',
      'user-cli',
      'user',
      'private_chat',
      'error',
      'denied',
      `hidden tool error ${secret}`,
      5,
      0,
      now
    );

    const beforeRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };

    const results = [
      runCli(['list-action-decisions', '--decided-by', invalidDecisionSource]),
      runCli(['list-action-decisions', '--risk', invalidRisk]),
      runCli(['list-action-executions', '--action-type', invalidActionType]),
      runCli(['list-action-executions', '--status', invalidExecutionStatus]),
      runCli(['list-tool-calls', '--status', invalidToolStatus]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('❌ Invalid');
      expect(result.stderr).toContain('[REDACTED:');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain('123456789');
      expect(result.stderr).not.toContain('234567890');
      expect(result.stderr).not.toContain('345678901');
      expect(result.stderr).not.toContain('456789012');
      expect(result.stderr).not.toContain('567890123');
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('\n    at ');
      expect(result.stderr).not.toContain('TypeError');
    }
    expect(results[0]?.stderr).toContain('Invalid action decision source');
    expect(results[1]?.stderr).toContain('Invalid action risk level');
    expect(results[2]?.stderr).toContain('Invalid action type');
    expect(results[3]?.stderr).toContain('Invalid action execution status');
    expect(results[4]?.stderr).toContain('Invalid tool call status');

    reopenDb();
    const afterRows = {
      rawEvents: db.prepare('SELECT * FROM raw_events ORDER BY id').all(),
      turns: db.prepare('SELECT * FROM agent_turns ORDER BY id').all(),
      actionDecisions: db.prepare('SELECT * FROM action_decisions ORDER BY id').all(),
      actionExecutions: db.prepare('SELECT * FROM action_executions ORDER BY id').all(),
      toolCalls: db.prepare('SELECT * FROM tool_calls ORDER BY id').all(),
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('spawns audit filter validation errors without leaking invalid values or mutating data', () => {
    const now = Date.now();
    const secret = 'sk-efghijklmnopqrstuvwxyz1234567890';
    const invalidCategory = `tool-${secret}-qq-123456789`;
    const invalidLevel = `full-${secret}-qq-234567890`;
    const invalidRisk = `high-${secret}-qq-345678901`;

    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_user_id, actor_class, invocation_context, summary,
        details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audit-cli-filter-validation',
      now,
      'tool',
      'full',
      'tool.call',
      'tool-cli-filter-validation',
      'user-cli',
      'user',
      'private_chat',
      `hidden audit summary ${secret}`,
      JSON.stringify({ token: secret }),
      0,
      'high'
    );

    const beforeRows = {
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
    };

    const results = [
      runCli(['list-audit', '--category', invalidCategory]),
      runCli(['list-audit', '--level', invalidLevel]),
      runCli(['list-audit', '--risk', invalidRisk]),
    ];

    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('❌ Invalid audit');
      expect(result.stderr).toContain('[REDACTED:');
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain('123456789');
      expect(result.stderr).not.toContain('234567890');
      expect(result.stderr).not.toContain('345678901');
      expect(result.stderr).not.toContain('src/cli');
      expect(result.stderr).not.toContain('tests/integration');
      expect(result.stderr).not.toContain('\n    at ');
      expect(result.stderr).not.toContain('TypeError');
    }
    expect(results[0]?.stderr).toContain('Invalid audit category');
    expect(results[1]?.stderr).toContain('Invalid audit level');
    expect(results[2]?.stderr).toContain('Invalid audit risk level');

    reopenDb();
    const afterRows = {
      audit: db.prepare('SELECT * FROM audit_log ORDER BY id').all(),
      memories: db.prepare('SELECT * FROM memory_records ORDER BY id').all(),
      revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
    };
    expect(afterRows).toEqual(beforeRows);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});
