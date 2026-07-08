import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { AuditRepository } from '../../../src/storage/audit-repository';

describe('AuditRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: AuditRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-audit-repo-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    repo = new AuditRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('redacts durable summary and structured details before persistence', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const platformId = 'legacy_qq-123456789';
    const auditId = await repo.create({
      timestamp: new Date(1234),
      category: 'tool',
      level: 'full',
      eventType: 'tool.full_output',
      eventId: platformId,
      actor: {
        actorClass: 'system_worker',
        context: 'tool_execution',
      },
      summary: `Tool returned api_key=${secret} for ${platformId}`,
      details: {
        [`header_${secret}`]: `Authorization Bearer ${secret}`,
        nested: {
          platform: platformId,
          notes: [`retry target ${platformId}`, `token ${secret}`],
        },
      },
      redacted: false,
      riskLevel: 'high',
    });

    const row = db
      .prepare('SELECT event_id, summary, details, redacted FROM audit_log WHERE id = ?')
      .get(auditId) as {
      event_id: string;
      summary: string;
      details: string;
      redacted: number;
    };
    const details = JSON.parse(row.details) as Record<string, unknown>;
    const serialized = `${row.summary}\n${JSON.stringify(details)}`;

    expect(row.event_id).toBe(platformId);
    expect(row.redacted).toBe(1);
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('123456789');
    expect(Object.keys(details).join('\n')).not.toContain(secret);
    expect(Object.keys(details).join('\n')).toContain('[REDACTED:openai_like_api_key]');

    const found = await repo.findById(auditId);
    expect(found?.summary).toBe(row.summary);
    expect(found?.details).toEqual(details);
    expect(found?.redacted).toBe(true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for adjacent secret/platform durable audit text', async () => {
    const adjacentSecretPlatform = 'sk-audit-repo-adjacent-secret-qq-12345678901';
    const auditId = await repo.create({
      timestamp: new Date(1734),
      category: 'system',
      level: 'full',
      eventType: 'audit.adjacent_redaction',
      eventId: 'audit-adjacent-redaction',
      actor: {
        actorClass: 'system_worker',
        context: 'system',
      },
      summary: `Audit summary contained ${adjacentSecretPlatform}`,
      details: {
        message: `Audit detail contained ${adjacentSecretPlatform}`,
        nested: {
          value: adjacentSecretPlatform,
        },
      },
      redacted: false,
      riskLevel: 'medium',
    });

    const row = db
      .prepare('SELECT summary, details, redacted FROM audit_log WHERE id = ?')
      .get(auditId) as {
      summary: string;
      details: string;
      redacted: number;
    };
    const serialized = `${row.summary}\n${row.details}`;

    expect(row.redacted).toBe(1);
    expect(serialized).toContain('[REDACTED:openai_like_api_key]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain(adjacentSecretPlatform);
    expect(serialized).not.toContain('qq-12345678901');
    expect(serialized).not.toContain('12345678901');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for assignment-shaped adjacent durable audit text', async () => {
    const adjacentAssignment = 'api_key=sk-audit-repo-assignment-secret-qq-12345678901';
    const auditId = await repo.create({
      timestamp: new Date(1834),
      category: 'system',
      level: 'full',
      eventType: 'audit.assignment_adjacent_redaction',
      eventId: 'audit-assignment-adjacent-redaction',
      actor: {
        actorClass: 'system_worker',
        context: 'system',
      },
      summary: `Audit summary contained ${adjacentAssignment}`,
      details: {
        [adjacentAssignment]: `Audit detail contained ${adjacentAssignment}`,
        nested: {
          value: adjacentAssignment,
        },
      },
      redacted: false,
      riskLevel: 'medium',
    });

    const row = db
      .prepare('SELECT summary, details, redacted FROM audit_log WHERE id = ?')
      .get(auditId) as {
      summary: string;
      details: string;
      redacted: number;
    };
    const serialized = `${row.summary}\n${row.details}`;

    expect(row.redacted).toBe(1);
    expect(serialized).toContain('[REDACTED:api_key_assignment]');
    expect(serialized).toContain('[REDACTED:platform_id]');
    expect(serialized).not.toContain('api_key=');
    expect(serialized).not.toContain('sk-audit-repo-assignment');
    expect(serialized).not.toContain('qq-12345678901');
    expect(serialized).not.toContain('12345678901');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts numeric platform identifiers in durable structured details while preserving ordinary counters', async () => {
    const rawSenderId = 123456789;
    const rawGroupId = 9876543210;
    const rawMessageId = 1122334455;
    const rawTargetUserId = 2233445566;
    const rawRecipientGroupId = 3344556677;
    const rawOwnerMessageId = 4455667788;

    const auditId = await repo.create({
      timestamp: new Date(2234),
      category: 'system',
      level: 'full',
      eventType: 'audit.numeric_platform_ids',
      eventId: 'audit-numeric-platform-ids',
      actor: {
        actorClass: 'system_worker',
        context: 'system',
      },
      summary: 'Numeric platform ID fields should not persist raw in audit details',
      details: {
        senderId: rawSenderId,
        targetUserId: rawTargetUserId,
        group_ids: [rawGroupId],
        nested: {
          recipientGroupIds: [rawRecipientGroupId],
          messageId: rawMessageId,
          ownerMessageId: rawOwnerMessageId,
          processedCount: 42,
          durationMs: 9001,
        },
      },
      redacted: false,
      riskLevel: 'medium',
    });

    const row = db
      .prepare('SELECT details, redacted FROM audit_log WHERE id = ?')
      .get(auditId) as {
      details: string;
      redacted: number;
    };
    const details = JSON.parse(row.details) as {
      senderId: string;
      targetUserId: string;
      group_ids: string[];
      nested: {
        recipientGroupIds: string[];
        messageId: string;
        ownerMessageId: string;
        processedCount: number;
        durationMs: number;
      };
    };
    const serialized = JSON.stringify(details);

    expect(row.redacted).toBe(1);
    expect(details.senderId).toBe('[REDACTED:platform_id]');
    expect(details.targetUserId).toBe('[REDACTED:platform_id]');
    expect(details.group_ids).toEqual(['[REDACTED:platform_id]']);
    expect(details.nested.recipientGroupIds).toEqual(['[REDACTED:platform_id]']);
    expect(details.nested.messageId).toBe('[REDACTED:platform_id]');
    expect(details.nested.ownerMessageId).toBe('[REDACTED:platform_id]');
    expect(details.nested.processedCount).toBe(42);
    expect(details.nested.durationMs).toBe(9001);
    expect(serialized).not.toContain(String(rawSenderId));
    expect(serialized).not.toContain(String(rawGroupId));
    expect(serialized).not.toContain(String(rawMessageId));
    expect(serialized).not.toContain(String(rawTargetUserId));
    expect(serialized).not.toContain(String(rawRecipientGroupId));
    expect(serialized).not.toContain(String(rawOwnerMessageId));
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});
