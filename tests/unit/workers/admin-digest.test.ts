import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { AdminDigestWorker } from '../../../src/workers/admin-digest';
import { AuditRepository } from '../../../src/storage/audit-repository';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';

describe('AdminDigestWorker', () => {
  let testDir: string;
  let db: Database.Database;
  let worker: AdminDigestWorker;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-admin-digest-worker-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigration(db, join(process.cwd(), 'migrations/001_initial_schema.sql'));
    worker = new AdminDigestWorker(db, new AuditRepository(db));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('redacts dynamic sample identifiers and classifier fields before returning digest evidence', async () => {
    const secret = 'sk-admin-digest-dynamic-secret-abcdefghijklmnopqrstuvwxyz';
    const platformId = 'qq-1234567890';
    const assignment = `api_key=${secret}-${platformId}`;
    const untilMs = Date.UTC(2030, 0, 4);
    const sinceMs = untilMs - 24 * 60 * 60 * 1000;
    const sampleMs = untilMs - 1_000;
    const turnId = `turn-admin-digest-${assignment}`;
    const actionDecisionId = `decision-admin-digest-${assignment}`;
    const jobId = `job-admin-digest-${assignment}`;
    const actionExecutionId = `exec-admin-digest-${assignment}`;
    const toolCallId = `tool-admin-digest-${assignment}`;
    const auditEventId = `audit-admin-digest-${assignment}`;

    db.prepare(
      `INSERT INTO raw_events (
        id, type, timestamp, source, platform,
        conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-admin-digest-dynamic',
      'system.admin_digest.seed',
      sampleMs,
      'system',
      'qq',
      'private:admin-digest-dynamic',
      '{}',
      sampleMs
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id,
        pi_model, pi_provider, status, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      turnId,
      'private:admin-digest-dynamic',
      'evt-admin-digest-dynamic',
      'mock',
      'mock',
      'completed',
      sampleMs,
      sampleMs
    );
    db.prepare(
      `INSERT INTO action_decisions (
        id, turn_id, decided_by, risk_level, confidence,
        evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      actionDecisionId,
      turnId,
      'pi',
      'low',
      0.8,
      0,
      1,
      JSON.stringify([{ type: `reply_full-${assignment}` }]),
      JSON.stringify(['seed']),
      JSON.stringify([]),
      sampleMs
    );
    db.prepare(
      `INSERT INTO action_executions (
        id, action_decision_id, action_type, status,
        error_code, error_message, audit_level, audit_entry, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      actionExecutionId,
      actionDecisionId,
      `reply_full-${assignment}`,
      'failed',
      'SEEDED_FAILURE',
      `action error ${assignment}`,
      'summary',
      'seeded failed action',
      sampleMs
    );
    db.prepare(
      `INSERT INTO tool_calls (
        id, turn_id, tool_name, input, output,
        requested_by, actor_class, invocation_context,
        status, error_code, error_message, secrets_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      toolCallId,
      turnId,
      `network.request-${assignment}`,
      JSON.stringify({ payload: `tool input ${assignment}` }),
      JSON.stringify({ payload: `tool output ${assignment}` }),
      'pi',
      'system_worker',
      'background_worker',
      'error',
      'SEEDED_TOOL_ERROR',
      `tool error ${assignment}`,
      0,
      sampleMs
    );
    db.prepare(
      `INSERT INTO jobs (
        id, type, payload, status, attempts, max_attempts,
        created_at, updated_at, scheduled_at, started_at, completed_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      jobId,
      `summary-${assignment}`,
      JSON.stringify({ payload: assignment }),
      'failed',
      3,
      3,
      sampleMs,
      sampleMs,
      sampleMs,
      sampleMs,
      sampleMs,
      `job error ${assignment}`
    );
    db.prepare(
      `INSERT INTO audit_log (
        id, timestamp, category, level, event_type, event_id,
        actor_class, invocation_context, summary, details, redacted, risk_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      auditEventId,
      sampleMs,
      'tool',
      'full',
      `tool.high_risk.${assignment}`,
      toolCallId,
      'system_worker',
      'background_worker',
      `audit summary ${assignment}`,
      JSON.stringify({ payload: assignment }),
      0,
      'high'
    );

    const result = await worker.generate({
      jobId: `admin-digest-${assignment}`,
      sinceMs,
      nowMs: untilMs,
      limit: 10,
    });
    const generatedAudit = db
      .prepare('SELECT details FROM audit_log WHERE id = ?')
      .get(result.auditId) as { details: string };
    const serializedResult = JSON.stringify(result);
    const serializedAuditDetails = generatedAudit.details;

    expect(result.counts).toMatchObject({
      failedJobs: 1,
      failedActionExecutions: 1,
      failedToolCalls: 1,
      highRiskAuditEvents: 1,
    });
    expect(result.samples.failedJobs[0]?.id).toContain('[REDACTED:api_key_assignment]');
    expect(result.samples.failedJobs[0]?.id).toContain('[REDACTED:platform_id]');
    expect(result.samples.failedJobs[0]?.type).toContain('[REDACTED:api_key_assignment]');
    expect(result.samples.actionExecutions[0]?.actionType).toContain('[REDACTED:api_key_assignment]');
    expect(result.samples.toolCalls[0]?.toolName).toContain('[REDACTED:api_key_assignment]');
    expect(result.samples.highRiskAuditEvents[0]?.eventType).toContain('[REDACTED:api_key_assignment]');

    for (const serialized of [serializedResult, serializedAuditDetails]) {
      expect(serialized).toContain('[REDACTED:api_key_assignment]');
      expect(serialized).toContain('[REDACTED:platform_id]');
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(platformId);
      expect(serialized).not.toContain('1234567890');
      expect(serialized).not.toContain(assignment);
      expect(serialized).not.toContain(jobId);
      expect(serialized).not.toContain(actionExecutionId);
      expect(serialized).not.toContain(toolCallId);
      expect(serialized).not.toContain(auditEventId);
      expect(serialized).not.toContain(`summary-${assignment}`);
      expect(serialized).not.toContain(`reply_full-${assignment}`);
      expect(serialized).not.toContain(`network.request-${assignment}`);
      expect(serialized).not.toContain(`tool.high_risk.${assignment}`);
      expect(serialized).not.toContain('tool input');
      expect(serialized).not.toContain('tool output');
      expect(serialized).not.toContain('job error');
      expect(serialized).not.toContain('action error');
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});
