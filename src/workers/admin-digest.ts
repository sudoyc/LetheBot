/**
 * Admin digest worker.
 *
 * Builds a redacted operational digest from persisted DB evidence. It does not
 * call an LLM or include payloads/errors/tool inputs, so the output can be
 * safely stored as a background-worker audit summary.
 */

import type Database from 'better-sqlite3';
import type { AuditRepository } from '../storage/audit-repository.js';
import { redactSecretsInText } from '../memory/secret-scan.js';

export interface AdminDigestInput {
  jobId: string;
  sinceMs?: number;
  nowMs?: number;
  limit?: number;
}

export interface AdminDigestResult {
  auditId: string;
  sinceMs: number;
  untilMs: number;
  hasIssues: boolean;
  redacted: true;
  counts: {
    failedJobs: number;
    failedActionExecutions: number;
    rejectedActionExecutions: number;
    failedToolCalls: number;
    rejectedToolCalls: number;
    highRiskAuditEvents: number;
  };
  samples: {
    failedJobs: Array<{ id: string; type: string; updatedAt: number }>;
    actionExecutions: Array<{ id: string; actionType: string; status: string; executedAt: number }>;
    toolCalls: Array<{ id: string; toolName: string; status: string; createdAt: number }>;
    highRiskAuditEvents: Array<{ id: string; eventType: string; timestamp: number }>;
  };
}

interface CountRow {
  count: number;
}

interface FailedJobSampleRow {
  id: string;
  type: string;
  updated_at: number;
}

interface ActionExecutionSampleRow {
  id: string;
  action_type: string;
  status: string;
  executed_at: number;
}

interface ToolCallSampleRow {
  id: string;
  tool_name: string;
  status: string;
  created_at: number;
}

interface AuditSampleRow {
  id: string;
  event_type: string;
  timestamp: number;
}

const DEFAULT_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SAMPLE_LIMIT = 5;
const MAX_SAMPLE_LIMIT = 20;

export class AdminDigestWorker {
  constructor(
    private readonly db: Database.Database,
    private readonly auditRepository: AuditRepository,
  ) {}

  async generate(input: AdminDigestInput): Promise<AdminDigestResult> {
    const untilMs = input.nowMs ?? Date.now();
    const sinceMs = input.sinceMs ?? untilMs - DEFAULT_DIGEST_WINDOW_MS;
    const limit = this.normalizeLimit(input.limit);

    const counts = {
      failedJobs: this.countFailedJobs(sinceMs, untilMs),
      failedActionExecutions: this.countActionExecutions('failed', sinceMs, untilMs),
      rejectedActionExecutions: this.countActionExecutions('rejected', sinceMs, untilMs),
      failedToolCalls: this.countToolCalls(['error', 'timeout'], sinceMs, untilMs),
      rejectedToolCalls: this.countToolCalls(['rejected'], sinceMs, untilMs),
      highRiskAuditEvents: this.countHighRiskAuditEvents(sinceMs, untilMs),
    };
    const totalIssues = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const hasIssues = totalIssues > 0;

    const samples = {
      failedJobs: this.sampleFailedJobs(sinceMs, untilMs, limit),
      actionExecutions: this.sampleActionExecutions(sinceMs, untilMs, limit),
      toolCalls: this.sampleToolCalls(sinceMs, untilMs, limit),
      highRiskAuditEvents: this.sampleHighRiskAuditEvents(sinceMs, untilMs, limit),
    };

    const auditId = await this.auditRepository.create({
      timestamp: new Date(untilMs),
      category: 'system',
      level: 'redacted_full',
      eventType: 'admin_digest.generated',
      eventId: input.jobId,
      actor: {
        actorClass: 'system_worker',
        context: 'background_worker',
      },
      summary: this.buildSummary(totalIssues, counts),
      details: {
        sinceMs,
        untilMs,
        counts,
        samples,
        redaction: 'ids_and_counts_only',
      },
      redacted: true,
      riskLevel: counts.highRiskAuditEvents > 0 ? 'high' : hasIssues ? 'medium' : 'low',
    });

    return {
      auditId,
      sinceMs,
      untilMs,
      hasIssues,
      redacted: true,
      counts,
      samples,
    };
  }

  private normalizeLimit(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_SAMPLE_LIMIT;
    }

    return Math.min(MAX_SAMPLE_LIMIT, Math.max(1, Math.floor(value)));
  }

  private buildSummary(totalIssues: number, counts: AdminDigestResult['counts']): string {
    if (totalIssues === 0) {
      return 'Admin digest: no operational issues detected';
    }

    return [
      `Admin digest: ${totalIssues} operational issue(s) detected`,
      `failed_jobs=${counts.failedJobs}`,
      `failed_actions=${counts.failedActionExecutions}`,
      `rejected_actions=${counts.rejectedActionExecutions}`,
      `failed_tools=${counts.failedToolCalls}`,
      `rejected_tools=${counts.rejectedToolCalls}`,
      `high_risk_audit=${counts.highRiskAuditEvents}`,
    ].join('; ');
  }

  private countFailedJobs(sinceMs: number, untilMs: number): number {
    return this.count(
      `SELECT COUNT(*) AS count
       FROM jobs
       WHERE status = 'failed'
         AND updated_at >= ?
         AND updated_at <= ?`,
      [sinceMs, untilMs],
    );
  }

  private countActionExecutions(status: 'failed' | 'rejected', sinceMs: number, untilMs: number): number {
    return this.count(
      `SELECT COUNT(*) AS count
       FROM action_executions
       WHERE status = ?
         AND executed_at >= ?
         AND executed_at <= ?`,
      [status, sinceMs, untilMs],
    );
  }

  private countToolCalls(statuses: string[], sinceMs: number, untilMs: number): number {
    const placeholders = statuses.map(() => '?').join(', ');
    return this.count(
      `SELECT COUNT(*) AS count
       FROM tool_calls
       WHERE status IN (${placeholders})
         AND created_at >= ?
         AND created_at <= ?`,
      [...statuses, sinceMs, untilMs],
    );
  }

  private countHighRiskAuditEvents(sinceMs: number, untilMs: number): number {
    return this.count(
      `SELECT COUNT(*) AS count
       FROM audit_log
       WHERE risk_level = 'high'
         AND timestamp >= ?
         AND timestamp <= ?`,
      [sinceMs, untilMs],
    );
  }

  private count(sql: string, params: unknown[]): number {
    const row = this.db.prepare(sql).get(...params) as CountRow;
    return row.count;
  }

  private sampleFailedJobs(
    sinceMs: number,
    untilMs: number,
    limit: number,
  ): AdminDigestResult['samples']['failedJobs'] {
    const rows = this.db
      .prepare(
        `SELECT id, type, updated_at
         FROM jobs
         WHERE status = 'failed'
           AND updated_at >= ?
           AND updated_at <= ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(sinceMs, untilMs, limit) as FailedJobSampleRow[];

    return rows.map((row) => ({
      id: redactAdminDigestText(row.id),
      type: redactAdminDigestText(row.type),
      updatedAt: row.updated_at,
    }));
  }

  private sampleActionExecutions(
    sinceMs: number,
    untilMs: number,
    limit: number,
  ): AdminDigestResult['samples']['actionExecutions'] {
    const rows = this.db
      .prepare(
        `SELECT id, action_type, status, executed_at
         FROM action_executions
         WHERE status IN ('failed', 'rejected')
           AND executed_at >= ?
           AND executed_at <= ?
         ORDER BY executed_at DESC
         LIMIT ?`,
      )
      .all(sinceMs, untilMs, limit) as ActionExecutionSampleRow[];

    return rows.map((row) => ({
      id: redactAdminDigestText(row.id),
      actionType: redactAdminDigestText(row.action_type),
      status: redactAdminDigestText(row.status),
      executedAt: row.executed_at,
    }));
  }

  private sampleToolCalls(
    sinceMs: number,
    untilMs: number,
    limit: number,
  ): AdminDigestResult['samples']['toolCalls'] {
    const rows = this.db
      .prepare(
        `SELECT id, tool_name, status, created_at
         FROM tool_calls
         WHERE status IN ('error', 'timeout', 'rejected')
           AND created_at >= ?
           AND created_at <= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sinceMs, untilMs, limit) as ToolCallSampleRow[];

    return rows.map((row) => ({
      id: redactAdminDigestText(row.id),
      toolName: redactAdminDigestText(row.tool_name),
      status: redactAdminDigestText(row.status),
      createdAt: row.created_at,
    }));
  }

  private sampleHighRiskAuditEvents(
    sinceMs: number,
    untilMs: number,
    limit: number,
  ): AdminDigestResult['samples']['highRiskAuditEvents'] {
    const rows = this.db
      .prepare(
        `SELECT id, event_type, timestamp
         FROM audit_log
         WHERE risk_level = 'high'
           AND timestamp >= ?
           AND timestamp <= ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(sinceMs, untilMs, limit) as AuditSampleRow[];

    return rows.map((row) => ({
      id: redactAdminDigestText(row.id),
      eventType: redactAdminDigestText(row.event_type),
      timestamp: row.timestamp,
    }));
  }
}

function redactAdminDigestText(text: string): string {
  const platformRedacted = redactPlatformIdentifiers(text);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactPlatformIdentifiers(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}
