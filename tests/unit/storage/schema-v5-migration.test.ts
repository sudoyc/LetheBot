import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  getSchemaVersion,
  initDatabase,
  recordSchemaVersion,
  runMigration,
  runMigrations,
} from '../../../src/storage/database.js';

const BASE_TIME = 1_700_000_000_000;
const migrationDirectory = join(process.cwd(), 'migrations');
const temporaryRoots: string[] = [];

interface CandidateFixture {
  candidateId: string;
  rawEventId: string;
  chatMessageId: string;
  jobId: string;
  jobAttemptId: string;
  conversationId: string;
  groupId: string;
  observedAt: number;
}

interface CandidateInsertRow extends CandidateFixture {
  conversationType: 'group' | 'private';
  candidateKind: string;
  policyVersion: string;
  createdAt: number;
  notBeforeAt: number;
  expiresAt: number;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('schema v5 delayed attention migration', () => {
  it('upgrades v4 without changing existing event, chat, job, or attempt rows', () => {
    const db = openDatabase();
    try {
      migrateToV4(db);
      const preserved = insertV4Evidence(db);

      migrateV4ToV5(db);

      expect(getSchemaVersion(db)).toBe(5);
      expect(db.prepare(
        'SELECT version, description FROM schema_version ORDER BY version',
      ).all()).toEqual([
        { version: 1, description: 'Initial schema' },
        { version: 2, description: 'Evaluator authority ownership' },
        { version: 3, description: 'Evaluator model invocations' },
        { version: 4, description: 'Evaluator correction attempts' },
        { version: 5, description: 'Delayed attention' },
      ]);
      expect(db.prepare(
        `SELECT
           (SELECT rowid FROM raw_events WHERE id = 'raw-v5-preserved') AS raw_rowid,
           (SELECT rowid FROM chat_messages WHERE id = 'chat-v5-preserved') AS chat_rowid,
           (SELECT rowid FROM jobs WHERE id = 'job-v5-preserved') AS job_rowid,
           (SELECT rowid FROM job_attempts WHERE id = 'attempt-v5-preserved') AS attempt_rowid`,
      ).get()).toEqual(preserved);
      expect(requiredAttentionTables(db)).toEqual([
        { name: 'attention_candidates' },
        { name: 'attention_decisions' },
        { name: 'attention_suppressors' },
      ]);
      expect(requiredAttentionIndexes(db)).toEqual([
        { name: 'idx_attention_candidates_id_job' },
        { name: 'idx_attention_candidates_job' },
        { name: 'idx_attention_candidates_source_chat' },
        { name: 'idx_attention_candidates_source_raw' },
        { name: 'idx_attention_decisions_candidate' },
        { name: 'idx_attention_decisions_id_candidate_outcome' },
        { name: 'idx_attention_suppressors_decision_code' },
        { name: 'idx_chat_messages_attention_source' },
        { name: 'idx_job_attempts_id_job' },
        { name: 'idx_job_attempts_job_attempt' },
        { name: 'idx_raw_events_attention_source' },
      ]);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('enforces source, timing, attempt, decision, and bounded suppressor evidence', () => {
    const db = openDatabase();
    try {
      migrateFreshToV5(db);
      const suppress = seedCandidate(db, 'suppress', BASE_TIME);
      const respond = seedCandidate(db, 'respond', BASE_TIME + 1_000);
      const invalid = seedCandidateSource(db, 'invalid', BASE_TIME + 2_000);

      expect(() => insertCandidate(db, invalid, {
        notBeforeAt: invalid.observedAt + 14_999,
      })).toThrow();
      expect(() => insertCandidate(db, invalid, {
        expiresAt: invalid.observedAt + 120_001,
      })).toThrow();
      expect(() => insertCandidate(db, invalid, {
        observedAt: invalid.observedAt + 1,
        notBeforeAt: invalid.observedAt + 15_001,
        expiresAt: invalid.observedAt + 120_001,
      })).toThrow();
      expect(() => insertCandidate(db, invalid, {
        conversationId: 'group:other-synthetic',
      })).toThrow();
      expect(() => insertCandidate(db, invalid, {
        groupId: 'qq-group-other-synthetic',
      })).toThrow();
      expect(() => insertCandidate(db, invalid, {
        conversationType: 'private',
      })).toThrow();
      expect(() => insertCandidate(db, invalid, {
        candidateKind: 'mentioned_question',
      })).toThrow();
      expect(() => insertCandidate(db, invalid, {
        policyVersion: 'delayed-attention-v2',
      })).toThrow();

      expect(() => insertDecision(db, {
        id: 'decision-attempt-mismatch',
        candidate: suppress,
        jobAttemptId: respond.jobAttemptId,
        outcome: 'suppress',
      })).toThrow();
      insertDecision(db, {
        id: 'decision-suppress',
        candidate: suppress,
        jobAttemptId: suppress.jobAttemptId,
        outcome: 'suppress',
      });
      expect(() => insertDecision(db, {
        id: 'decision-duplicate-candidate',
        candidate: suppress,
        jobAttemptId: suppress.jobAttemptId,
        outcome: 'respond',
      })).toThrow();
      insertDecision(db, {
        id: 'decision-respond',
        candidate: respond,
        jobAttemptId: respond.jobAttemptId,
        outcome: 'respond',
      });

      expect(() => insertSuppressor(db, {
        id: 'suppressor-on-respond',
        decisionId: 'decision-respond',
        candidateId: respond.candidateId,
        code: 'thread_expired',
      })).toThrow();
      expect(() => insertSuppressor(db, {
        id: 'suppressor-human-missing',
        decisionId: 'decision-suppress',
        candidateId: suppress.candidateId,
        code: 'human_answer',
      })).toThrow();
      expect(() => insertSuppressor(db, {
        id: 'suppressor-human-foreign',
        decisionId: 'decision-suppress',
        candidateId: suppress.candidateId,
        code: 'human_answer',
        evidenceChatMessageId: 'missing-chat-row',
      })).toThrow();
      expect(() => insertSuppressor(db, {
        id: 'suppressor-traffic-low',
        decisionId: 'decision-suppress',
        candidateId: suppress.candidateId,
        code: 'high_traffic',
        observedCount: 5,
        windowMs: 10_000,
      })).toThrow();
      expect(() => insertSuppressor(db, {
        id: 'suppressor-traffic-window',
        decisionId: 'decision-suppress',
        candidateId: suppress.candidateId,
        code: 'high_traffic',
        observedCount: 6,
        windowMs: 9_999,
      })).toThrow();
      expect(() => insertSuppressor(db, {
        id: 'suppressor-budget-low',
        decisionId: 'decision-suppress',
        candidateId: suppress.candidateId,
        code: 'group_budget_exhausted',
        observedCount: 1,
        windowMs: 600_000,
      })).toThrow();

      insertSuppressor(db, {
        id: 'suppressor-thread',
        decisionId: 'decision-suppress',
        candidateId: suppress.candidateId,
        code: 'thread_expired',
      });
      insertSuppressor(db, {
        id: 'suppressor-human',
        decisionId: 'decision-suppress',
        candidateId: suppress.candidateId,
        code: 'human_answer',
        evidenceChatMessageId: suppress.chatMessageId,
      });
      insertSuppressor(db, {
        id: 'suppressor-traffic',
        decisionId: 'decision-suppress',
        candidateId: suppress.candidateId,
        code: 'high_traffic',
        observedCount: 6,
        windowMs: 10_000,
      });
      insertSuppressor(db, {
        id: 'suppressor-budget',
        decisionId: 'decision-suppress',
        candidateId: suppress.candidateId,
        code: 'group_budget_exhausted',
        observedCount: 2,
        windowMs: 600_000,
      });
      expect(() => insertSuppressor(db, {
        id: 'suppressor-thread-duplicate',
        decisionId: 'decision-suppress',
        candidateId: suppress.candidateId,
        code: 'thread_expired',
      })).toThrow();
      expect(() => db.prepare(
        `INSERT INTO job_attempts (
          id, job_id, attempt_number, worker_id, status, started_at, heartbeat_at
        ) VALUES ('attempt-duplicate-number', ?, 1, 'worker-other', 'running', ?, ?)`,
      ).run(respond.jobId, BASE_TIME, BASE_TIME)).toThrow();

      expect(db.prepare(
        'SELECT code FROM attention_suppressors ORDER BY code',
      ).all()).toEqual([
        { code: 'group_budget_exhausted' },
        { code: 'high_traffic' },
        { code: 'human_answer' },
        { code: 'thread_expired' },
      ]);
      expect(() => db.prepare('DELETE FROM jobs WHERE id = ?').run(respond.jobId)).toThrow();

      db.prepare('DELETE FROM chat_messages WHERE id = ?').run(suppress.chatMessageId);

      expect(db.prepare(
        'SELECT COUNT(*) FROM attention_candidates WHERE id = ?',
      ).pluck().get(suppress.candidateId)).toBe(0);
      expect(db.prepare(
        'SELECT COUNT(*) FROM attention_decisions WHERE candidate_id = ?',
      ).pluck().get(suppress.candidateId)).toBe(0);
      expect(db.prepare(
        'SELECT COUNT(*) FROM attention_suppressors WHERE candidate_id = ?',
      ).pluck().get(suppress.candidateId)).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM jobs WHERE id = ?').pluck().get(suppress.jobId)).toBe(1);
      expect(db.prepare(
        'SELECT COUNT(*) FROM job_attempts WHERE id = ?',
      ).pluck().get(suppress.jobAttemptId)).toBe(1);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });

  it('performs a zero-write validation pass after a fresh current migration', () => {
    const db = openDatabase();
    try {
      runMigrations(db, migrationDirectory);
      const changesBefore = db.prepare('SELECT total_changes()').pluck().get();

      runMigrations(db, migrationDirectory);

      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBefore);
      expect(getSchemaVersion(db)).toBe(6);
      expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    } finally {
      closeDatabase(db);
    }
  });
});

function openDatabase(): Database.Database {
  const root = mkdtempSync(join(tmpdir(), 'lethebot-schema-v5-'));
  temporaryRoots.push(root);
  return initDatabase({ path: join(root, 'test.db') });
}

function migrateToV4(db: Database.Database): void {
  runMigration(db, join(migrationDirectory, '001_initial_schema.sql'));
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      for (const [version, fileName, description] of [
        [2, '002_evaluator_authority_ownership.sql', 'Evaluator authority ownership'],
        [3, '003_evaluator_model_invocations.sql', 'Evaluator model invocations'],
        [4, '004_evaluator_correction_attempts.sql', 'Evaluator correction attempts'],
      ] as const) {
        db.exec(readFileSync(join(migrationDirectory, fileName), 'utf8'));
        recordSchemaVersion(db, version, description);
      }
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function migrateV4ToV5(db: Database.Database): void {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(readFileSync(join(migrationDirectory, '005_delayed_attention.sql'), 'utf8'));
      recordSchemaVersion(db, 5, 'Delayed attention');
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function migrateFreshToV5(db: Database.Database): void {
  migrateToV4(db);
  migrateV4ToV5(db);
}

function insertV4Evidence(db: Database.Database): {
  raw_rowid: number;
  chat_rowid: number;
  job_rowid: number;
  attempt_rowid: number;
} {
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES ('raw-v5-preserved', 'chat.message.received', ?, 'gateway', 'qq',
              'group:v5-preserved', '{}', ?)`,
  ).run(BASE_TIME, BASE_TIME);
  db.prepare(
    `INSERT INTO chat_messages (
      id, raw_event_id, message_id, conversation_id, conversation_type,
      group_id, sender_id, text, timestamp
    ) VALUES ('chat-v5-preserved', 'raw-v5-preserved', 'platform-v5-preserved',
              'group:v5-preserved', 'group', 'qq-group-v5-preserved',
              'qq-user-v5-preserved', 'preserved', ?)`,
  ).run(BASE_TIME);
  db.prepare(
    `INSERT INTO jobs (
      id, type, payload, status, attempts, max_attempts, created_at, updated_at,
      scheduled_at, started_at, completed_at
    ) VALUES ('job-v5-preserved', 'summary', '{}', 'completed', 1, 3, ?, ?, ?, ?, ?)`,
  ).run(BASE_TIME, BASE_TIME + 2, BASE_TIME, BASE_TIME, BASE_TIME + 2);
  db.prepare(
    `INSERT INTO job_attempts (
      id, job_id, attempt_number, worker_id, status,
      started_at, completed_at, heartbeat_at
    ) VALUES ('attempt-v5-preserved', 'job-v5-preserved', 1, 'worker-v5-preserved',
              'completed', ?, ?, ?)`,
  ).run(BASE_TIME, BASE_TIME + 2, BASE_TIME + 2);

  return db.prepare(
    `SELECT
       (SELECT rowid FROM raw_events WHERE id = 'raw-v5-preserved') AS raw_rowid,
       (SELECT rowid FROM chat_messages WHERE id = 'chat-v5-preserved') AS chat_rowid,
       (SELECT rowid FROM jobs WHERE id = 'job-v5-preserved') AS job_rowid,
       (SELECT rowid FROM job_attempts WHERE id = 'attempt-v5-preserved') AS attempt_rowid`,
  ).get() as {
    raw_rowid: number;
    chat_rowid: number;
    job_rowid: number;
    attempt_rowid: number;
  };
}

function seedCandidate(
  db: Database.Database,
  key: string,
  observedAt: number,
): CandidateFixture {
  const fixture = seedCandidateSource(db, key, observedAt);
  insertCandidate(db, fixture);
  return fixture;
}

function seedCandidateSource(
  db: Database.Database,
  key: string,
  observedAt: number,
): CandidateFixture {
  const fixture: CandidateFixture = {
    candidateId: `candidate-${key}`,
    rawEventId: `raw-${key}`,
    chatMessageId: `chat-${key}`,
    jobId: `job-${key}`,
    jobAttemptId: `attempt-${key}`,
    conversationId: `group:${key}`,
    groupId: `qq-group-${key}`,
    observedAt,
  };
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, payload, created_at
    ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, '{}', ?)`,
  ).run(fixture.rawEventId, observedAt, fixture.conversationId, observedAt);
  db.prepare(
    `INSERT INTO chat_messages (
      id, raw_event_id, message_id, conversation_id, conversation_type,
      group_id, sender_id, text, timestamp
    ) VALUES (?, ?, ?, ?, 'group', ?, ?, 'synthetic question?', ?)`,
  ).run(
    fixture.chatMessageId,
    fixture.rawEventId,
    `platform-${key}`,
    fixture.conversationId,
    fixture.groupId,
    `qq-user-${key}`,
    observedAt,
  );
  db.prepare(
    `INSERT INTO jobs (
      id, type, payload, idempotency_key, status, attempts, max_attempts,
      lease_owner, lease_expires_at, heartbeat_at,
      created_at, updated_at, scheduled_at, started_at
    ) VALUES (?, 'attention_recheck', ?, ?, 'running', 1, 3,
              'attention-worker', ?, ?, ?, ?, ?, ?)`,
  ).run(
    fixture.jobId,
    JSON.stringify({ candidateId: fixture.candidateId }),
    `attention:deferred:v1:${fixture.rawEventId}`,
    observedAt + 60_000,
    observedAt + 100,
    observedAt + 100,
    observedAt + 100,
    observedAt + 15_000,
    observedAt + 100,
  );
  db.prepare(
    `INSERT INTO job_attempts (
      id, job_id, attempt_number, worker_id, status, started_at, heartbeat_at
    ) VALUES (?, ?, 1, 'attention-worker', 'running', ?, ?)`,
  ).run(fixture.jobAttemptId, fixture.jobId, observedAt + 100, observedAt + 100);
  return fixture;
}

function insertCandidate(
  db: Database.Database,
  fixture: CandidateFixture,
  overrides: Partial<CandidateInsertRow> = {},
): void {
  const row: CandidateInsertRow = {
    ...fixture,
    conversationType: 'group',
    candidateKind: 'unmentioned_question',
    policyVersion: 'delayed-attention-v1',
    createdAt: fixture.observedAt + 100,
    notBeforeAt: fixture.observedAt + 15_000,
    expiresAt: fixture.observedAt + 120_000,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO attention_candidates (
      id, source_raw_event_id, source_chat_message_id, job_id,
      conversation_id, conversation_type, group_id,
      candidate_kind, policy_version,
      observed_at, created_at, not_before_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.candidateId,
    row.rawEventId,
    row.chatMessageId,
    row.jobId,
    row.conversationId,
    row.conversationType,
    row.groupId,
    row.candidateKind,
    row.policyVersion,
    row.observedAt,
    row.createdAt,
    row.notBeforeAt,
    row.expiresAt,
  );
}

function insertDecision(
  db: Database.Database,
  input: {
    id: string;
    candidate: CandidateFixture;
    jobAttemptId: string;
    outcome: 'respond' | 'suppress';
  },
): void {
  db.prepare(
    `INSERT INTO attention_decisions (
      id, candidate_id, job_id, job_attempt_id, outcome, decided_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.candidate.candidateId,
    input.candidate.jobId,
    input.jobAttemptId,
    input.outcome,
    input.candidate.observedAt + 15_000,
  );
}

function insertSuppressor(
  db: Database.Database,
  input: {
    id: string;
    decisionId: string;
    candidateId: string;
    code: string;
    evidenceChatMessageId?: string;
    observedCount?: number;
    windowMs?: number;
  },
): void {
  db.prepare(
    `INSERT INTO attention_suppressors (
      id, decision_id, candidate_id, code,
      evidence_chat_message_id, observed_count, window_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.decisionId,
    input.candidateId,
    input.code,
    input.evidenceChatMessageId ?? null,
    input.observedCount ?? null,
    input.windowMs ?? null,
    BASE_TIME + 20_000,
  );
}

function requiredAttentionTables(db: Database.Database): Array<{ name: string }> {
  return db.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = 'table'
       AND name IN ('attention_candidates', 'attention_decisions', 'attention_suppressors')
     ORDER BY name`,
  ).all() as Array<{ name: string }>;
}

function requiredAttentionIndexes(db: Database.Database): Array<{ name: string }> {
  return db.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = 'index'
       AND name IN (
         'idx_attention_candidates_id_job',
         'idx_attention_candidates_job',
         'idx_attention_candidates_source_chat',
         'idx_attention_candidates_source_raw',
         'idx_attention_decisions_candidate',
         'idx_attention_decisions_id_candidate_outcome',
         'idx_attention_suppressors_decision_code',
         'idx_chat_messages_attention_source',
         'idx_job_attempts_id_job',
         'idx_job_attempts_job_attempt',
         'idx_raw_events_attention_source'
       )
     ORDER BY name`,
  ).all() as Array<{ name: string }>;
}
