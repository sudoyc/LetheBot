/**
 * Governance CLI
 *
 * 治理命令行工具（Phase L）
 */

import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import type { ContextBuilder } from '../context/builder';
import { redactSecretsInText } from '../memory/secret-scan';
import { ContextTraceRepository } from '../storage/context-trace-repository';
import type { JobAttemptStatus, JobStatus, WorkerHeartbeatStatus } from '../storage/job-repository';
import type { MemoryRepository } from '../storage/memory-repository';
import {
  PrivacyPreferenceRepository,
  type PrivacyPreferenceRecord,
  type PrivacyPreferenceState,
  type PrivacyPreferenceType,
} from '../storage/privacy-preference-repository';
import type { AuditEntry } from '../types/audit';
import type { ActionDecision, ActionExecutionResult, ActionPlan, ActionType } from '../types/action';
import type { ContextPack } from '../types/context';
import type { MemoryRecord, MemorySource } from '../types/memory';
import type { ToolCallResult } from '../types/tool';

export interface ListMemoryOptions {
  userId?: string;
  groupId?: string;
  conversationId?: string;
  state?: MemoryRecord['state'];
  scope?: MemoryRecord['scope'];
  sensitivity?: MemoryRecord['sensitivity'];
  sourceContext?: string;
  sourceType?: MemorySource['sourceType'];
  sourceId?: string;
  limit?: number;
}

export interface CommandResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface SupersedeMemoryOptions {
  reviewAuditId?: string;
}

export interface DisableMemoryOptions {
  decayReviewAuditId?: string;
}

export type MemoryReviewAuditEventType =
  | 'memory.conflict.detected'
  | 'memory.consolidation.candidates_detected'
  | 'memory.decay.candidates_detected';

export type MemoryReviewResolutionStatus = 'all' | 'resolved' | 'unresolved';

interface MemoryReviewEvidence {
  auditId: string;
  eventType: MemoryReviewAuditEventType;
}

export interface ExplainContextOptions {
  turnId?: string;
  conversationId?: string;
  conversationType?: 'private' | 'group';
  groupId?: string;
  canonicalUserId?: string;
  messageLimit?: number;
}

export interface ContextExplanation {
  turnId: string;
  contextPackId: string;
  traceSource: 'stored' | 'rebuilt';
  conversation: ContextPack['conversation'];
  selectedMemoryIds: string[];
  candidateMemoryIds: string[];
  rejectedMemories: NonNullable<ContextPack['trace']>['rejectedMemories'];
  filtersApplied: string[];
  injectedIdentityFields: string[];
  recentMessageIds: string[];
  tokenBudget: ContextPack['tokenBudget'];
  memories: Array<{
    memoryId: string;
    scope: string;
    kind?: MemoryRecord['kind'];
    title: string;
    sourceContext?: string;
  }>;
  actionDecision?: ActionDecisionExplanation;
}

export interface ActionDecisionExplanation {
  id: string;
  decidedBy: string;
  riskLevel: string;
  actionTypes: string[];
  reasons: string[];
  suppressors: string[];
  executions: ActionExecutionExplanation[];
}

export interface ActionExecutionExplanation {
  id: string;
  actionType: string;
  status: string;
  executedMessageId?: string;
  downgradedFrom?: string;
  downgradedReason?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface RedactDisplayProfileOptions {
  canonicalUserId: string;
  groupId?: string;
}

export interface ListPrivacyPreferenceOptions {
  canonicalUserId?: string;
  preferenceType?: PrivacyPreferenceType;
  state?: PrivacyPreferenceState;
  limit?: number;
}

export interface PrivacyPreferenceInspectionRecord extends Omit<
  PrivacyPreferenceRecord,
  'preferenceType' | 'state' | 'updatedBy'
> {
  preferenceType: string;
  state: string;
  updatedBy?: {
    canonicalUserId?: string;
    actorClass: string;
    context: string;
  };
}

export interface PrivacyPreferenceCommandOptions {
  canonicalUserId: string;
  preferenceType: PrivacyPreferenceType;
  reason?: string;
}

export interface MemorySourceInspectionRecord extends Omit<MemorySource, 'sourceType' | 'extractedBy'> {
  sourceType: string;
  extractedBy?: string;
}

export interface MemoryRecordInspectionRecord extends Omit<
  MemoryRecord,
  'scope' | 'visibility' | 'sensitivity' | 'authority' | 'kind' | 'state'
> {
  scope: string;
  visibility: string;
  sensitivity: string;
  authority: string;
  kind: string;
  state: string;
}

export interface ShowMemoryResult {
  record: MemoryRecordInspectionRecord;
  sources: MemorySourceInspectionRecord[];
  revisions: Array<{
    id: string;
    memoryId: string;
    revisionNumber: number;
    changeType: string;
    actor: string;
    reason: string;
    evaluatorDecisionId?: string;
    createdAt: Date;
    previousState?: unknown;
    newState: unknown;
  }>;
  audit: AuditInspectionRecord[];
}

export interface ExportMemoryRecord {
  id: string;
  scope: string;
  canonicalUserId?: string;
  groupId?: string;
  conversationId?: string;
  subjectUserId?: string;
  visibility: string;
  sensitivity: string;
  authority: string;
  kind: string;
  title: string;
  content: string;
  state: string;
  confidence: number;
  importance: number;
  sourceContext: string;
  sourceEventIds: string[];
  evaluatorDecisionId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface ListAuditOptions {
  category?: AuditEntry['category'];
  level?: AuditEntry['level'];
  eventType?: string;
  eventId?: string;
  userId?: string;
  riskLevel?: AuditEntry['riskLevel'];
  startTime?: Date;
  endTime?: Date;
  includeDetails?: boolean;
  limit?: number;
}

export interface ListMemoryReviewOptions {
  eventType?: MemoryReviewAuditEventType;
  memoryId?: string;
  status?: MemoryReviewResolutionStatus;
  includeDetails?: boolean;
  limit?: number;
}

export interface AuditInspectionRecord {
  id: string;
  timestamp: Date;
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
  details?: unknown;
  detailsRedacted: boolean;
  redacted: boolean;
  riskLevel?: string;
  evaluatorDecisionId?: string;
}

export interface MemoryReviewCandidateInspectionRecord {
  auditId: string;
  timestamp: Date;
  eventType: MemoryReviewAuditEventType;
  eventId: string;
  summary: string;
  riskLevel?: string;
  redacted: boolean;
  status: Exclude<MemoryReviewResolutionStatus, 'all'>;
  candidateCount: number;
  memoryIdGroups: string[][];
  resolutionAuditIds: string[];
  supersededMemoryIds: string[];
  replacementMemoryIds: string[];
  disabledMemoryIds: string[];
  details?: unknown;
}

export interface MemoryReviewSummaryEventTypeRecord {
  eventType: MemoryReviewAuditEventType;
  total: number;
  resolved: number;
  unresolved: number;
  candidateGroups: number;
  memoryReferences: number;
  resolutionAuditCount: number;
  supersededMemoryCount: number;
  replacementMemoryCount: number;
  disabledMemoryCount: number;
}

export interface MemoryReviewSummaryInspectionRecord {
  generatedAt: Date;
  filters: {
    eventType?: MemoryReviewAuditEventType;
    memoryId?: string;
    status: MemoryReviewResolutionStatus;
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
  byEventType: MemoryReviewSummaryEventTypeRecord[];
}

export interface GovernanceHealthSummaryInspectionRecord {
  generatedAt: Date;
  memoryReviews: MemoryReviewSummaryInspectionRecord;
  eventProcessing: {
    failuresTotal: number;
    byStage: Record<string, number>;
    byConversationType: Record<string, number>;
    latestFailureAt?: Date;
  };
  actions: {
    decisions: {
      total: number;
      byDecidedBy: Record<string, number>;
      byRiskLevel: Record<string, number>;
      evaluatorRequired: number;
      evaluatorPassed: number;
      evaluatorRejected: number;
    };
    executions: {
      total: number;
      byStatus: Record<string, number>;
      byActionType: Record<string, number>;
      failedOrRejected: number;
    };
  };
  tools: {
    total: number;
    byStatus: Record<string, number>;
    secretsRedacted: number;
    failedOrRejected: number;
  };
  jobs: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    pending: number;
    running: number;
    failed: number;
    expiredRunningLeases: number;
  };
  workerHeartbeats: {
    total: number;
    byStatus: Record<string, number>;
    byWorkerType: Record<string, number>;
    error: number;
    latestHeartbeatAt?: Date;
  };
  audit: {
    total: number;
    byCategory: Record<string, number>;
    byRiskLevel: Record<string, number>;
    byEventType: Record<string, number>;
    highRisk: number;
    prohibitedRisk: number;
  };
  attention: {
    unresolvedMemoryReviews: number;
    failedJobs: number;
    expiredRunningLeases: number;
    errorWorkerHeartbeats: number;
    failedOrRejectedActions: number;
    failedOrRejectedToolCalls: number;
    eventProcessingFailures: number;
    highOrProhibitedRiskAuditEvents: number;
  };
}

export interface ListToolCallOptions {
  turnId?: string;
  toolName?: string;
  status?: ToolCallResult['status'];
  includePayload?: boolean;
  limit?: number;
}

export interface ToolCallInspectionRecord {
  id: string;
  turnId: string;
  toolName: string;
  requestedBy: string;
  actor: {
    canonicalUserId?: string;
    actorClass: string;
  };
  context: string;
  status: string;
  errorCode?: string;
  errorMessage?: string;
  executionTimeMs?: number;
  secretsRedacted: boolean;
  createdAt: Date;
  input?: unknown;
  output?: unknown;
}

export interface ListActionDecisionOptions {
  turnId?: string;
  decidedBy?: ActionDecision['decidedBy'];
  riskLevel?: ActionDecision['riskLevel'];
  includeActions?: boolean;
  limit?: number;
}

export interface ActionDecisionInspectionRecord {
  id: string;
  turnId: string;
  createdAt: Date;
  decidedBy: string;
  riskLevel: string;
  confidence: number;
  evaluatorRequired: boolean;
  evaluatorPassed?: boolean;
  actionCount: number;
  actions?: ActionPlan[];
  reasons: string[];
  suppressors: string[];
}

export interface ListActionExecutionOptions {
  actionDecisionId?: string;
  actionType?: ActionType;
  status?: ActionExecutionResult['status'];
  includeAuditEntry?: boolean;
  limit?: number;
}

export interface ActionExecutionInspectionRecord {
  id: string;
  actionDecisionId: string;
  actionType: string;
  status: string;
  executedMessageId?: string;
  downgradedFrom?: string;
  downgradedReason?: string;
  errorCode?: string;
  errorMessage?: string;
  auditLevel: string;
  auditEntry?: string;
  executedAt: Date;
}

export interface ListJobOptions {
  status?: JobStatus;
  type?: string;
  includePayload?: boolean;
  limit?: number;
}

export interface JobInspectionRecord {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  idempotencyKey?: string;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  heartbeatAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  scheduledAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  payload?: unknown;
  result?: unknown;
}

export interface ListJobAttemptOptions {
  jobId?: string;
  workerId?: string;
  status?: JobAttemptStatus;
  includeResult?: boolean;
  limit?: number;
}

export interface JobAttemptInspectionRecord {
  id: string;
  jobId: string;
  attemptNumber: number;
  workerId: string;
  status: string;
  startedAt: Date;
  completedAt?: Date;
  heartbeatAt?: Date;
  error?: string;
  result?: unknown;
}

export interface ListWorkerHeartbeatOptions {
  workerId?: string;
  workerType?: string;
  status?: WorkerHeartbeatStatus;
  includeDetails?: boolean;
  limit?: number;
}

export interface WorkerHeartbeatInspectionRecord {
  workerId: string;
  workerType: string;
  status: string;
  currentJobId?: string;
  heartbeatAt: Date;
  details?: unknown;
}

export interface ListEventProcessingFailureOptions {
  stage?: string;
  rawEventId?: string;
  turnId?: string;
  includeDetails?: boolean;
  limit?: number;
}

export interface EventProcessingFailureInspectionRecord {
  id: string;
  rawEventId?: string;
  turnId?: string;
  occurredAt: Date;
  stage: string;
  conversationType?: 'private' | 'group';
  errorName: string;
  errorMessageHash: string;
  messageIdHash?: string;
  senderIdHash?: string;
  conversationIdHash?: string;
  details?: unknown;
}

interface GovernanceCLIOptions {
  db?: Database.Database;
  contextBuilder?: Pick<ContextBuilder, 'build'>;
}

interface LastTurnRow {
  id: string;
  context_pack_id: string | null;
  conversation_id: string;
  conversation_type: 'private' | 'group' | null;
  group_id: string | null;
  sender_id: string | null;
}

interface MemorySourceRow {
  memory_id: string;
  source_type: string;
  source_id: string;
  source_timestamp: number;
  extracted_by: MemorySource['extractedBy'] | null;
}

interface MemoryRevisionRow {
  id: string;
  memory_id: string;
  revision_number: number;
  previous_state: string | null;
  new_state: string;
  reason: string;
  change_type: string;
  actor: string;
  evaluator_decision_id: string | null;
  created_at: number;
}

interface AuditRow {
  id: string;
  timestamp: number;
  category: string;
  level: string;
  event_type: string;
  event_id: string;
  actor_user_id: string | null;
  actor_class: string | null;
  invocation_context: string | null;
  summary: string;
  details: string | null;
  redacted: number;
  risk_level: string | null;
  evaluator_decision_id: string | null;
}

interface ToolCallRow {
  id: string;
  turn_id: string;
  tool_name: string;
  input: string;
  output: string | null;
  requested_by: string;
  actor_user_id: string | null;
  actor_class: string;
  invocation_context: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  execution_time_ms: number | null;
  secrets_redacted: number;
  created_at: number;
}

interface ActionDecisionRow {
  id: string;
  turn_id: string;
  decided_by: ActionDecision['decidedBy'];
  risk_level: ActionDecision['riskLevel'];
  confidence: number;
  evaluator_required: number;
  evaluator_passed: number | null;
  actions: string;
  reasons: string | null;
  suppressors: string | null;
  created_at: number;
}

interface ActionExecutionRow {
  id: string;
  action_decision_id: string;
  action_type: ActionType;
  status: string;
  executed_message_id: string | null;
  downgraded_from: ActionType | null;
  downgraded_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  audit_level: ActionExecutionInspectionRecord['auditLevel'];
  audit_entry: string | null;
  executed_at: number;
}

interface JobRow {
  id: string;
  type: string;
  payload: string;
  idempotency_key: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
  created_at: number;
  updated_at: number;
  scheduled_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  result: string | null;
}

interface JobAttemptRow {
  id: string;
  job_id: string;
  attempt_number: number;
  worker_id: string;
  status: string;
  started_at: number;
  completed_at: number | null;
  heartbeat_at: number | null;
  error: string | null;
  result: string | null;
}

interface WorkerHeartbeatRow {
  worker_id: string;
  worker_type: string;
  status: string;
  current_job_id: string | null;
  heartbeat_at: number;
  details: string | null;
}

interface EventProcessingFailureRow {
  id: string;
  raw_event_id: string | null;
  turn_id: string | null;
  occurred_at: number;
  stage: string;
  conversation_type: 'private' | 'group' | null;
  error_name: string;
  error_message_hash: string;
  message_id_hash: string | null;
  sender_id_hash: string | null;
  conversation_id_hash: string | null;
  details: string;
}

export class GovernanceCLI {
  constructor(
    private readonly memoryRepo: MemoryRepository,
    private readonly options: GovernanceCLIOptions = {}
  ) {}

  /**
   * 列出记忆记录
   */
  async listMemory(options: ListMemoryOptions): Promise<MemoryRecord[]> {
    if (this.options.db) {
      return this.listMemoryFromDatabase(options);
    }

    const filters: Parameters<typeof this.memoryRepo.retrieve>[0] = {
      state: options.state ?? 'active',
      limit: options.limit,
    };

    if (options.userId) filters.canonicalUserId = options.userId;
    if (options.groupId) filters.groupId = options.groupId;
    if (options.conversationId) filters.conversationId = options.conversationId;
    if (options.scope) filters.scope = options.scope;

    return this.memoryRepo.retrieve(filters);
  }

  /**
   * 查看单条记忆及其 source/revision/audit 证据。
   */
  async showMemory(memoryId: string): Promise<ShowMemoryResult | null> {
    const record = await this.memoryRepo.findById(memoryId);
    if (!record) {
      return null;
    }
    const safeRecord = this.redactMemoryRecordForDisplay(record);

    const db = this.requireDatabase('memory inspection');

    const sources = (db
      .prepare(
        `SELECT memory_id, source_type, source_id, source_timestamp, extracted_by
         FROM memory_sources
         WHERE memory_id = ?
         ORDER BY source_timestamp ASC, source_id ASC`
      )
      .all(memoryId) as MemorySourceRow[]).map((row) => ({
      memoryId: this.redactString(row.memory_id).text,
      sourceType: this.redactString(row.source_type).text,
      sourceId: this.redactString(row.source_id).text,
      sourceTimestamp: new Date(row.source_timestamp),
      extractedBy: row.extracted_by ? this.redactString(row.extracted_by).text : undefined,
    }));

    const revisions = (db
      .prepare(
        `SELECT id, memory_id, revision_number, previous_state, new_state,
                reason, change_type, actor, evaluator_decision_id, created_at
         FROM memory_revisions
         WHERE memory_id = ?
         ORDER BY revision_number ASC`
      )
      .all(memoryId) as MemoryRevisionRow[]).map((row) => ({
      id: this.redactString(row.id).text,
      memoryId: this.redactString(row.memory_id).text,
      revisionNumber: row.revision_number,
      changeType: this.redactString(row.change_type).text,
      actor: this.redactString(row.actor).text,
      reason: this.redactString(row.reason).text,
      evaluatorDecisionId: row.evaluator_decision_id
        ? this.redactString(row.evaluator_decision_id).text
        : undefined,
      createdAt: new Date(row.created_at),
      previousState: row.previous_state ? this.redactStructuredValue(this.parseJson(row.previous_state)).value : undefined,
      newState: this.redactStructuredValue(this.parseJson(row.new_state)).value,
    }));

    const audit = await this.listAudit({
      category: 'memory',
      eventId: memoryId,
      includeDetails: false,
      limit: 100,
    });

    return { record: safeRecord, sources, revisions, audit };
  }

  /**
   * 导出可见记忆。默认只导出 active，且强制排除 secret/prohibited。
   */
  async exportMemory(options: ListMemoryOptions = {}): Promise<ExportMemoryRecord[]> {
    const memories = await this.listMemory({
      ...options,
      state: options.state ?? 'active',
    });

    return memories
      .filter((memory) => memory.sensitivity !== 'secret' && memory.sensitivity !== 'prohibited')
      .map((memory) => {
        const safeMemory = this.redactMemoryRecordForDisplay(memory);
        return {
          id: safeMemory.id,
          scope: safeMemory.scope,
          canonicalUserId: safeMemory.canonicalUserId,
          groupId: safeMemory.groupId,
          conversationId: safeMemory.conversationId,
          subjectUserId: safeMemory.subjectUserId,
          visibility: safeMemory.visibility,
          sensitivity: safeMemory.sensitivity,
          authority: safeMemory.authority,
          kind: safeMemory.kind,
          title: safeMemory.title,
          content: safeMemory.content,
          state: safeMemory.state,
          confidence: safeMemory.confidence,
          importance: safeMemory.importance,
          sourceContext: safeMemory.sourceContext,
          sourceEventIds: safeMemory.sourceEventIds,
          evaluatorDecisionId: safeMemory.evaluatorDecisionId,
          createdAt: safeMemory.createdAt.toISOString(),
          updatedAt: safeMemory.updatedAt.toISOString(),
          expiresAt: safeMemory.expiresAt?.toISOString(),
        };
      });
  }

  /**
   * 查询审计记录。默认隐藏 details；显式 includeDetails 时也会做 deterministic secret redaction。
   */
  async listAudit(options: ListAuditOptions = {}): Promise<AuditInspectionRecord[]> {
    const db = this.requireDatabase('audit inspection');
    const params: unknown[] = [];
    let query = 'SELECT * FROM audit_log WHERE 1=1';

    if (options.category) {
      query += ' AND category = ?';
      params.push(options.category);
    }

    if (options.level) {
      query += ' AND level = ?';
      params.push(options.level);
    }

    if (options.eventType) {
      query += ' AND event_type = ?';
      params.push(options.eventType);
    }

    if (options.eventId) {
      query += ' AND event_id = ?';
      params.push(options.eventId);
    }

    if (options.userId) {
      query += ' AND actor_user_id = ?';
      params.push(options.userId);
    }

    if (options.riskLevel) {
      query += ' AND risk_level = ?';
      params.push(options.riskLevel);
    }

    if (options.startTime) {
      query += ' AND timestamp >= ?';
      params.push(options.startTime.getTime());
    }

    if (options.endTime) {
      query += ' AND timestamp <= ?';
      params.push(options.endTime.getTime());
    }

    query += ' ORDER BY timestamp DESC, id DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = db.prepare(query).all(...params) as AuditRow[];
    return rows.map((row) => this.auditRowToInspection(row, Boolean(options.includeDetails)));
  }

  async listMemoryReviewCandidates(
    options: ListMemoryReviewOptions = {}
  ): Promise<MemoryReviewCandidateInspectionRecord[]> {
    const db = this.requireDatabase('memory review inspection');
    const status = options.status ?? 'all';
    const params: unknown[] = [];
    let query = 'SELECT * FROM audit_log WHERE category = ?';
    params.push('memory');

    if (options.eventType) {
      query += ' AND event_type = ?';
      params.push(options.eventType);
    } else {
      query += ' AND event_type IN (?, ?, ?)';
      params.push(
        'memory.conflict.detected',
        'memory.consolidation.candidates_detected',
        'memory.decay.candidates_detected'
      );
    }

    const requestedLimit = options.limit ?? 100;
    if (options.memoryId || status !== 'all') {
      query += ' ORDER BY timestamp DESC, id DESC';
    } else {
      query += ' ORDER BY timestamp DESC, id DESC LIMIT ?';
      params.push(requestedLimit);
    }

    const rows = db.prepare(query).all(...params) as AuditRow[];
    const candidates = rows
      .filter((row) => {
        if (!options.memoryId) {
          return true;
        }

        const parsedDetails = row.details ? this.parseJson(row.details) : undefined;
        return this.collectMemoryIdGroups(parsedDetails).some((group) => group.includes(options.memoryId as string));
      })
      .map((row) => this.memoryReviewRowToInspection(row, Boolean(options.includeDetails)))
      .filter((candidate) => (
        status === 'all' ? true : candidate.status === status
      ));

    return candidates.slice(0, options.limit ?? 100);
  }

  async summarizeMemoryReviews(
    options: Omit<ListMemoryReviewOptions, 'includeDetails' | 'limit'> = {}
  ): Promise<MemoryReviewSummaryInspectionRecord> {
    const candidates = await this.listMemoryReviewCandidates({
      ...options,
      includeDetails: false,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const summary = this.createEmptyMemoryReviewSummary(options);

    for (const candidate of candidates) {
      this.addMemoryReviewCandidateToSummary(summary, candidate);
    }

    return summary;
  }

  async summarizeGovernanceHealth(): Promise<GovernanceHealthSummaryInspectionRecord> {
    const db = this.requireDatabase('governance health summary');
    const memoryReviews = await this.summarizeMemoryReviews();
    const actionExecutionStatusCounts = this.countByColumn(db, 'action_executions', 'status');
    const toolStatusCounts = this.countByColumn(db, 'tool_calls', 'status');
    const jobStatusCounts = this.countByColumn(db, 'jobs', 'status');
    const heartbeatStatusCounts = this.countByColumn(db, 'worker_heartbeats', 'status');
    const auditRiskCounts = this.countByColumn(db, 'audit_log', 'risk_level');
    const latestHeartbeatAt = this.latestTimestamp(db, 'worker_heartbeats', 'heartbeat_at');
    const latestEventFailureAt = this.latestTimestamp(db, 'event_processing_failures', 'occurred_at');
    const eventFailureTotal = this.countRows(db, 'event_processing_failures');
    const expiredRunningLeases = this.countRows(
      db,
      'jobs',
      'status = ? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?',
      ['running', Date.now()]
    );

    return {
      generatedAt: new Date(),
      memoryReviews,
      eventProcessing: {
        failuresTotal: eventFailureTotal,
        byStage: this.countByColumn(db, 'event_processing_failures', 'stage'),
        byConversationType: this.countByColumn(db, 'event_processing_failures', 'conversation_type'),
        latestFailureAt: latestEventFailureAt ? new Date(latestEventFailureAt) : undefined,
      },
      actions: {
        decisions: {
          total: this.countRows(db, 'action_decisions'),
          byDecidedBy: this.countByColumn(db, 'action_decisions', 'decided_by'),
          byRiskLevel: this.countByColumn(db, 'action_decisions', 'risk_level'),
          evaluatorRequired: this.countRows(db, 'action_decisions', 'evaluator_required = 1'),
          evaluatorPassed: this.countRows(db, 'action_decisions', 'evaluator_passed = 1'),
          evaluatorRejected: this.countRows(db, 'action_decisions', 'evaluator_passed = 0'),
        },
        executions: {
          total: this.countRows(db, 'action_executions'),
          byStatus: actionExecutionStatusCounts,
          byActionType: this.countByColumn(db, 'action_executions', 'action_type'),
          failedOrRejected: (actionExecutionStatusCounts.failed ?? 0) + (actionExecutionStatusCounts.rejected ?? 0),
        },
      },
      tools: {
        total: this.countRows(db, 'tool_calls'),
        byStatus: toolStatusCounts,
        secretsRedacted: this.countRows(db, 'tool_calls', 'secrets_redacted = 1'),
        failedOrRejected: (toolStatusCounts.error ?? 0)
          + (toolStatusCounts.timeout ?? 0)
          + (toolStatusCounts.rejected ?? 0),
      },
      jobs: {
        total: this.countRows(db, 'jobs'),
        byStatus: jobStatusCounts,
        byType: this.countByColumn(db, 'jobs', 'type'),
        pending: jobStatusCounts.pending ?? 0,
        running: jobStatusCounts.running ?? 0,
        failed: jobStatusCounts.failed ?? 0,
        expiredRunningLeases,
      },
      workerHeartbeats: {
        total: this.countRows(db, 'worker_heartbeats'),
        byStatus: heartbeatStatusCounts,
        byWorkerType: this.countByColumn(db, 'worker_heartbeats', 'worker_type'),
        error: heartbeatStatusCounts.error ?? 0,
        latestHeartbeatAt: latestHeartbeatAt ? new Date(latestHeartbeatAt) : undefined,
      },
      audit: {
        total: this.countRows(db, 'audit_log'),
        byCategory: this.countByColumn(db, 'audit_log', 'category'),
        byRiskLevel: auditRiskCounts,
        byEventType: this.countByColumn(db, 'audit_log', 'event_type'),
        highRisk: auditRiskCounts.high ?? 0,
        prohibitedRisk: auditRiskCounts.prohibited ?? 0,
      },
      attention: {
        unresolvedMemoryReviews: memoryReviews.unresolved,
        failedJobs: jobStatusCounts.failed ?? 0,
        expiredRunningLeases,
        errorWorkerHeartbeats: heartbeatStatusCounts.error ?? 0,
        failedOrRejectedActions: (actionExecutionStatusCounts.failed ?? 0)
          + (actionExecutionStatusCounts.rejected ?? 0),
        failedOrRejectedToolCalls: (toolStatusCounts.error ?? 0)
          + (toolStatusCounts.timeout ?? 0)
          + (toolStatusCounts.rejected ?? 0),
        eventProcessingFailures: eventFailureTotal,
        highOrProhibitedRiskAuditEvents: (auditRiskCounts.high ?? 0) + (auditRiskCounts.prohibited ?? 0),
      },
    };
  }

  async listToolCalls(options: ListToolCallOptions = {}): Promise<ToolCallInspectionRecord[]> {
    const db = this.requireDatabase('tool call inspection');
    const params: unknown[] = [];
    let query = 'SELECT * FROM tool_calls WHERE 1=1';

    if (options.turnId) {
      query += ' AND turn_id = ?';
      params.push(options.turnId);
    }

    if (options.toolName) {
      query += ' AND tool_name = ?';
      params.push(options.toolName);
    }

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = db.prepare(query).all(...params) as ToolCallRow[];
    return rows.map((row) => this.toolCallRowToInspection(row, Boolean(options.includePayload)));
  }

  async listActionDecisions(options: ListActionDecisionOptions = {}): Promise<ActionDecisionInspectionRecord[]> {
    const db = this.requireDatabase('action decision inspection');
    const params: unknown[] = [];
    let query = 'SELECT * FROM action_decisions WHERE 1=1';

    if (options.turnId) {
      query += ' AND turn_id = ?';
      params.push(options.turnId);
    }

    if (options.decidedBy) {
      query += ' AND decided_by = ?';
      params.push(options.decidedBy);
    }

    if (options.riskLevel) {
      query += ' AND risk_level = ?';
      params.push(options.riskLevel);
    }

    query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = db.prepare(query).all(...params) as ActionDecisionRow[];
    return rows.map((row) => this.actionDecisionRowToInspection(row, Boolean(options.includeActions)));
  }

  async listActionExecutions(options: ListActionExecutionOptions = {}): Promise<ActionExecutionInspectionRecord[]> {
    const db = this.requireDatabase('action execution inspection');
    const params: unknown[] = [];
    let query = 'SELECT * FROM action_executions WHERE 1=1';

    if (options.actionDecisionId) {
      query += ' AND action_decision_id = ?';
      params.push(options.actionDecisionId);
    }

    if (options.actionType) {
      query += ' AND action_type = ?';
      params.push(options.actionType);
    }

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY executed_at DESC, id DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = db.prepare(query).all(...params) as ActionExecutionRow[];
    return rows.map((row) => this.actionExecutionRowToInspection(row, Boolean(options.includeAuditEntry)));
  }

  async listJobs(options: ListJobOptions = {}): Promise<JobInspectionRecord[]> {
    const db = this.requireDatabase('job inspection');
    const params: unknown[] = [];
    let query = 'SELECT * FROM jobs WHERE 1=1';

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    if (options.type) {
      query += ' AND type = ?';
      params.push(options.type);
    }

    query += ' ORDER BY scheduled_at ASC, created_at ASC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = db.prepare(query).all(...params) as JobRow[];
    return rows.map((row) => this.jobRowToInspection(row, Boolean(options.includePayload)));
  }

  async listJobAttempts(options: ListJobAttemptOptions = {}): Promise<JobAttemptInspectionRecord[]> {
    const db = this.requireDatabase('job attempt inspection');
    const params: unknown[] = [];
    let query = 'SELECT * FROM job_attempts WHERE 1=1';

    if (options.jobId) {
      query += ' AND job_id = ?';
      params.push(options.jobId);
    }

    if (options.workerId) {
      query += ' AND worker_id = ?';
      params.push(options.workerId);
    }

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY started_at DESC, id DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = db.prepare(query).all(...params) as JobAttemptRow[];
    return rows.map((row) => this.jobAttemptRowToInspection(row, Boolean(options.includeResult)));
  }

  async listWorkerHeartbeats(
    options: ListWorkerHeartbeatOptions = {}
  ): Promise<WorkerHeartbeatInspectionRecord[]> {
    const db = this.requireDatabase('worker heartbeat inspection');
    const params: unknown[] = [];
    let query = 'SELECT * FROM worker_heartbeats WHERE 1=1';

    if (options.workerId) {
      query += ' AND worker_id = ?';
      params.push(options.workerId);
    }

    if (options.workerType) {
      query += ' AND worker_type = ?';
      params.push(options.workerType);
    }

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    query += ' ORDER BY heartbeat_at DESC, worker_id ASC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = db.prepare(query).all(...params) as WorkerHeartbeatRow[];
    return rows.map((row) => this.workerHeartbeatRowToInspection(row, Boolean(options.includeDetails)));
  }

  async listEventProcessingFailures(
    options: ListEventProcessingFailureOptions = {}
  ): Promise<EventProcessingFailureInspectionRecord[]> {
    const db = this.requireDatabase('event processing failure inspection');
    const params: unknown[] = [];
    let query = 'SELECT * FROM event_processing_failures WHERE 1=1';

    if (options.stage) {
      query += ' AND stage = ?';
      params.push(options.stage);
    }

    if (options.rawEventId) {
      query += ' AND raw_event_id = ?';
      params.push(options.rawEventId);
    }

    if (options.turnId) {
      query += ' AND turn_id = ?';
      params.push(options.turnId);
    }

    query += ' ORDER BY occurred_at DESC, id DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = db.prepare(query).all(...params) as EventProcessingFailureRow[];
    return rows.map((row) => this.eventProcessingFailureRowToInspection(
      row,
      Boolean(options.includeDetails),
    ));
  }

  /**
   * 删除记忆记录
   */
  async deleteMemory(memoryId: string): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing) {
        return {
          success: false,
          error: `Memory ${memoryId} not found`,
        };
      }

      await this.memoryRepo.updateState(memoryId, 'deleted', {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: 'Governance CLI delete memory',
        auditSummary: `Governance CLI deleted memory ${memoryId}`,
      });

      return {
        success: true,
        message: `Memory ${memoryId} deleted`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 禁用记忆记录
   */
  async disableMemory(memoryId: string, options: DisableMemoryOptions = {}): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing) {
        return {
          success: false,
          error: `Memory ${memoryId} not found`,
        };
      }

      if (options.decayReviewAuditId) {
        if (existing.state !== 'active') {
          return {
            success: false,
            error: `Memory ${memoryId} is not active`,
          };
        }

        if (this.isBlockedMemorySensitivity(existing.sensitivity)) {
          return {
            success: false,
            error: `Memory ${memoryId} has blocked sensitivity ${existing.sensitivity}`,
          };
        }

        const reviewValidation = this.validateDecayReviewAuditEvidence(
          options.decayReviewAuditId,
          memoryId
        );
        if (typeof reviewValidation === 'string') {
          return {
            success: false,
            error: reviewValidation,
          };
        }
      }

      const decayReviewSuffix = options.decayReviewAuditId
        ? ` from decay review ${options.decayReviewAuditId}`
        : '';

      await this.memoryRepo.updateState(memoryId, 'disabled', {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: `Governance CLI disable memory${decayReviewSuffix}`,
        auditSummary: `Governance CLI disabled memory ${memoryId}${decayReviewSuffix}`,
        auditDetails: options.decayReviewAuditId
          ? {
            decayReviewAuditId: options.decayReviewAuditId,
            reviewEventType: 'memory.decay.candidates_detected',
            governedDecayApproval: true,
          }
          : undefined,
      });

      return {
        success: true,
        message: `Memory ${memoryId} disabled`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 批准 proposed 记忆。
   */
  async approveMemory(memoryId: string): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing || existing.state !== 'proposed') {
        return {
          success: false,
          error: `Memory ${memoryId} not found or not proposed`,
        };
      }

      await this.memoryRepo.approve(memoryId, {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: 'Governance CLI approve memory proposal',
        auditSummary: `Governance CLI approved memory ${memoryId}`,
      });

      return {
        success: true,
        message: `Memory ${memoryId} approved`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 拒绝 proposed 记忆。
   */
  async rejectMemory(memoryId: string): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing || existing.state !== 'proposed') {
        return {
          success: false,
          error: `Memory ${memoryId} not found or not proposed`,
        };
      }

      await this.memoryRepo.reject(memoryId, {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: 'Governance CLI reject memory proposal',
        auditSummary: `Governance CLI rejected memory ${memoryId}`,
      });

      return {
        success: true,
        message: `Memory ${memoryId} rejected`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 用 replacement 取代旧记忆。
   */
  async supersedeMemory(
    memoryId: string,
    replacementMemoryId: string,
    options: SupersedeMemoryOptions = {}
  ): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);
      const replacement = await this.memoryRepo.findById(replacementMemoryId);

      if (!existing) {
        return {
          success: false,
          error: `Memory ${memoryId} not found`,
        };
      }

      if (!replacement) {
        return {
          success: false,
          error: `Replacement memory ${replacementMemoryId} not found`,
        };
      }

      const validationError = this.validateSafeSupersede(existing, replacement);
      if (validationError) {
        return {
          success: false,
          error: validationError,
        };
      }

      const reviewEvidence = options.reviewAuditId
        ? this.validateReviewAuditEvidence(options.reviewAuditId, memoryId, replacementMemoryId)
        : undefined;

      if (typeof reviewEvidence === 'string') {
        return {
          success: false,
          error: reviewEvidence,
        };
      }

      const reviewSuffix = reviewEvidence ? ` reviewed by ${reviewEvidence.auditId}` : '';

      await this.memoryRepo.supersede(memoryId, {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: `Governance CLI supersede memory with ${replacementMemoryId}${reviewSuffix}`,
        auditSummary: `Governance CLI superseded memory ${memoryId} by ${replacementMemoryId}${reviewSuffix}`,
        auditDetails: {
          replacementMemoryId,
          reviewAuditId: reviewEvidence?.auditId,
          reviewEventType: reviewEvidence?.eventType,
          governedReviewApproval: Boolean(reviewEvidence),
        },
      });

      return {
        success: true,
        message: `Memory ${memoryId} superseded by ${replacementMemoryId}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 启用记忆记录
   */
  async enableMemory(memoryId: string): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing || !['disabled', 'rejected', 'deleted'].includes(existing.state)) {
        return {
          success: false,
          error: `Memory ${memoryId} not found or not restorable`,
        };
      }

      await this.memoryRepo.updateState(memoryId, 'active', {
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: 'Governance CLI restore memory',
        auditSummary: `Governance CLI enabled memory ${memoryId}`,
      });

      return {
        success: true,
        message: `Memory ${memoryId} enabled`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 恢复 disabled/rejected 记忆。保留 enableMemory 作为旧命令别名。
   */
  async restoreMemory(memoryId: string): Promise<CommandResult> {
    return this.enableMemory(memoryId);
  }

  private validateSafeSupersede(existing: MemoryRecord, replacement: MemoryRecord): string | null {
    if (existing.id === replacement.id) {
      return 'Cannot supersede a memory with itself';
    }

    if (existing.state !== 'active') {
      return `Memory ${existing.id} is not active`;
    }

    if (replacement.state !== 'active') {
      return `Replacement memory ${replacement.id} is not active`;
    }

    if (this.isBlockedMemorySensitivity(existing.sensitivity)) {
      return `Memory ${existing.id} has blocked sensitivity ${existing.sensitivity}`;
    }

    if (this.isBlockedMemorySensitivity(replacement.sensitivity)) {
      return `Replacement memory ${replacement.id} has blocked sensitivity ${replacement.sensitivity}`;
    }

    const boundaryFields: Array<keyof Pick<
      MemoryRecord,
      'scope' | 'canonicalUserId' | 'groupId' | 'conversationId' | 'subjectUserId' | 'kind'
    >> = ['scope', 'canonicalUserId', 'groupId', 'conversationId', 'subjectUserId', 'kind'];

    for (const field of boundaryFields) {
      if ((existing[field] ?? null) !== (replacement[field] ?? null)) {
        return `Cannot supersede memory across different ${field} boundaries`;
      }
    }

    return null;
  }

  private isBlockedMemorySensitivity(sensitivity: MemoryRecord['sensitivity']): boolean {
    return sensitivity === 'secret' || sensitivity === 'prohibited';
  }

  private validateReviewAuditEvidence(
    reviewAuditId: string,
    memoryId: string,
    replacementMemoryId: string
  ): MemoryReviewEvidence | string {
    const db = this.requireDatabase('memory review approval');
    const row = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(reviewAuditId) as AuditRow | undefined;

    if (!row) {
      return `Review audit ${reviewAuditId} not found`;
    }

    if (row.category !== 'memory') {
      return `Review audit ${reviewAuditId} is not a memory audit event`;
    }

    if (
      row.event_type !== 'memory.conflict.detected'
      && row.event_type !== 'memory.consolidation.candidates_detected'
    ) {
      return `Review audit ${reviewAuditId} is not a supported memory review event`;
    }

    const details = row.details ? this.parseJson(row.details) : undefined;
    if (!this.reviewDetailsReferencePair(details, memoryId, replacementMemoryId)) {
      return `Review audit ${reviewAuditId} does not reference both memory records`;
    }

    return {
      auditId: reviewAuditId,
      eventType: row.event_type,
    };
  }

  private validateDecayReviewAuditEvidence(
    reviewAuditId: string,
    memoryId: string
  ): true | string {
    const db = this.requireDatabase('memory decay review approval');
    const row = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(reviewAuditId) as AuditRow | undefined;

    if (!row) {
      return `Decay review audit ${reviewAuditId} not found`;
    }

    if (row.category !== 'memory') {
      return `Decay review audit ${reviewAuditId} is not a memory audit event`;
    }

    if (row.event_type !== 'memory.decay.candidates_detected') {
      return `Decay review audit ${reviewAuditId} is not a memory decay review event`;
    }

    const details = row.details ? this.parseJson(row.details) : undefined;
    if (!this.reviewDetailsReferenceMemoryId(details, memoryId)) {
      return `Decay review audit ${reviewAuditId} does not reference memory ${memoryId}`;
    }

    return true;
  }

  private reviewDetailsReferencePair(
    details: unknown,
    memoryId: string,
    replacementMemoryId: string
  ): boolean {
    return this.collectMemoryIdGroups(details).some((group) => (
      group.includes(memoryId) && group.includes(replacementMemoryId)
    ));
  }

  private reviewDetailsReferenceMemoryId(details: unknown, memoryId: string): boolean {
    if (Array.isArray(details)) {
      return details.some((item) => this.reviewDetailsReferenceMemoryId(item, memoryId));
    }

    if (details && typeof details === 'object') {
      const objectValue = details as Record<string, unknown>;
      if (objectValue.memoryId === memoryId) {
        return true;
      }

      if (Array.isArray(objectValue.memoryIds) && objectValue.memoryIds.includes(memoryId)) {
        return true;
      }

      return Object.values(objectValue).some((child) => this.reviewDetailsReferenceMemoryId(child, memoryId));
    }

    return false;
  }

  private collectMemoryIdGroups(value: unknown, allowStringArray = false): string[][] {
    if (Array.isArray(value)) {
      if (allowStringArray && value.every((item) => typeof item === 'string')) {
        return [value];
      }

      return value.flatMap((item) => this.collectMemoryIdGroups(item, false));
    }

    if (value && typeof value === 'object') {
      const objectValue = value as Record<string, unknown>;
      const ownGroups = Array.isArray(objectValue.memoryIds)
        ? this.collectMemoryIdGroups(objectValue.memoryIds, true)
        : [];
      const singleMemoryIdGroups = typeof objectValue.memoryId === 'string'
        ? [[objectValue.memoryId]]
        : [];
      const nestedGroups = Object.entries(objectValue)
        .filter(([key]) => key !== 'memoryIds' && key !== 'memoryId')
        .flatMap(([, child]) => this.collectMemoryIdGroups(child, false));

      return [...ownGroups, ...singleMemoryIdGroups, ...nestedGroups];
    }

    return [];
  }

  /**
   * CLI 等价 `/why`：重建指定或最近回合的 ContextBuilder trace。
   */
  async explainContext(options: ExplainContextOptions): Promise<ContextExplanation> {
    if (!this.options.contextBuilder) {
      throw new Error('ContextBuilder is required for context explanation');
    }

    const resolved = this.resolveExplainContextOptions(options);
    const actionDecision = this.findActionDecisionExplanation(resolved.turnId);
    const stored = await this.findStoredContextExplanation(resolved.turnId);
    if (stored) {
      return { ...stored, actionDecision };
    }

    const context = await this.options.contextBuilder.build({
      turnId: resolved.turnId,
      conversationId: resolved.conversationId,
      conversationType: resolved.conversationType,
      groupId: resolved.groupId,
      canonicalUserId: resolved.canonicalUserId,
      messageLimit: options.messageLimit,
    });

    return {
      turnId: resolved.turnId,
      contextPackId: context.id,
      traceSource: 'rebuilt',
      conversation: context.conversation,
      selectedMemoryIds: context.memory.selectedMemoryIds,
      candidateMemoryIds: context.trace?.candidateMemoryIds ?? [],
      rejectedMemories: context.trace?.rejectedMemories ?? [],
      filtersApplied: context.trace?.filtersApplied ?? [],
      injectedIdentityFields: context.injectedIdentityFields,
      recentMessageIds: context.recentMessages.map((message) => message.messageId),
      tokenBudget: context.tokenBudget,
      memories: context.memory.retrievedFacts.map((memory) => ({
        memoryId: memory.memoryId,
        scope: memory.scope,
        kind: memory.kind,
        title: memory.title,
        sourceContext: memory.sourceContext,
      })),
      actionDecision,
    };
  }

  private findActionDecisionExplanation(turnId: string): ActionDecisionExplanation | undefined {
    const db = this.options.db;
    if (!db) {
      return undefined;
    }

    const row = db
      .prepare(
        `SELECT ad.*
         FROM action_decisions ad
         LEFT JOIN agent_turns at ON at.id = ad.turn_id
         WHERE ad.turn_id = ?
         ORDER BY
           CASE WHEN at.action_decision_id = ad.id THEN 0 ELSE 1 END,
           ad.created_at DESC,
           ad.id DESC
         LIMIT 1`
      )
      .get(turnId) as ActionDecisionRow | undefined;

    if (!row) {
      return undefined;
    }

    const inspection = this.actionDecisionRowToInspection(row, true);
    return {
      id: inspection.id,
      decidedBy: inspection.decidedBy,
      riskLevel: inspection.riskLevel,
      actionTypes: (inspection.actions ?? []).map((action) => this.redactString(action.type).text),
      reasons: inspection.reasons,
      suppressors: inspection.suppressors,
      executions: this.findActionExecutionExplanations(row.id),
    };
  }

  private findActionExecutionExplanations(actionDecisionId: string): ActionExecutionExplanation[] {
    const db = this.options.db;
    if (!db) {
      return [];
    }

    const rows = db
      .prepare(
        `SELECT *
         FROM action_executions
         WHERE action_decision_id = ?
         ORDER BY executed_at ASC, id ASC`
      )
      .all(actionDecisionId) as ActionExecutionRow[];

    return rows.map((row) => {
      const inspection = this.actionExecutionRowToInspection(row, false);
      return {
        id: inspection.id,
        actionType: inspection.actionType,
        status: inspection.status,
        executedMessageId: inspection.executedMessageId,
        downgradedFrom: inspection.downgradedFrom,
        downgradedReason: inspection.downgradedReason,
        errorCode: inspection.errorCode,
        errorMessage: inspection.errorMessage,
      };
    });
  }

  private async findStoredContextExplanation(turnId: string): Promise<ContextExplanation | null> {
    if (!this.options.db) {
      return null;
    }

    const stored = await new ContextTraceRepository(this.options.db).findByTurnId(turnId);
    if (!stored) {
      return null;
    }

    return {
      turnId: stored.turnId,
      contextPackId: stored.contextPackId,
      traceSource: 'stored',
      conversation: stored.conversation,
      selectedMemoryIds: stored.selectedMemoryIds,
      candidateMemoryIds: stored.candidateMemoryIds,
      rejectedMemories: stored.rejectedMemories,
      filtersApplied: stored.filtersApplied,
      injectedIdentityFields: stored.injectedIdentityFields,
      recentMessageIds: stored.recentMessageIds,
      tokenBudget: stored.tokenBudget,
      memories: stored.memories,
    };
  }

  /**
   * Redact current display profile and nickname history for a user or group-scoped profile.
   */
  async redactDisplayProfile(options: RedactDisplayProfileOptions): Promise<CommandResult> {
    if (!this.options.db) {
      return {
        success: false,
        error: 'Database connection is required for display profile redaction',
      };
    }

    const db = this.options.db;
    const now = Date.now();
    const groupId = options.groupId ?? '';

    try {
      const transaction = db.transaction(() => {
        const displayResult = db
          .prepare(
            `UPDATE display_profiles
             SET current_display_name = ?, observed_at = ?, trust = ?
             WHERE canonical_user_id = ?
               AND source_group_id = ?`
          )
          .run('[redacted]', now, 'user_set', options.canonicalUserId, groupId);

        const historyResult = db
          .prepare(
            `UPDATE nickname_history
             SET display_name = ?, observed_until = COALESCE(observed_until, ?)
             WHERE canonical_user_id = ?
               AND source_group_id = ?`
          )
          .run('[redacted]', now, options.canonicalUserId, groupId);

        this.insertSystemAudit({
          eventType: 'display_profile.redact',
          eventId: `${options.canonicalUserId}:${groupId}`,
          summary: `Governance CLI redacted display profile for ${options.canonicalUserId}`,
          details: {
            canonicalUserId: options.canonicalUserId,
            groupId: groupId || undefined,
            displayProfilesUpdated: displayResult.changes,
            nicknameHistoryUpdated: historyResult.changes,
          },
        });

        return displayResult.changes + historyResult.changes;
      });

      const changes = transaction();
      return {
        success: true,
        message: `Redacted ${changes} display profile/nickname rows for ${options.canonicalUserId}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async listPrivacyPreferences(
    options: ListPrivacyPreferenceOptions = {}
  ): Promise<PrivacyPreferenceInspectionRecord[]> {
    return new PrivacyPreferenceRepository(this.requireDatabase('privacy preference inspection'))
      .list(options)
      .map((preference) => ({
        ...preference,
        canonicalUserId: this.redactString(preference.canonicalUserId).text,
        preferenceType: this.redactString(preference.preferenceType).text,
        state: this.redactString(preference.state).text,
        reason: preference.reason ? this.redactString(preference.reason).text : undefined,
        updatedBy: preference.updatedBy
          ? {
              ...preference.updatedBy,
              canonicalUserId: preference.updatedBy.canonicalUserId
                ? this.redactString(preference.updatedBy.canonicalUserId).text
                : undefined,
              actorClass: this.redactString(preference.updatedBy.actorClass).text,
              context: this.redactString(preference.updatedBy.context).text,
            }
          : undefined,
      }));
  }

  async setPrivacyOptOut(options: PrivacyPreferenceCommandOptions): Promise<CommandResult> {
    try {
      new PrivacyPreferenceRepository(this.requireDatabase('privacy preference update')).setOptOut({
        canonicalUserId: options.canonicalUserId,
        preferenceType: options.preferenceType,
        reason: options.reason ?? 'Governance CLI set privacy opt-out',
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
      });

      return {
        success: true,
        message: `${options.canonicalUserId} opted out of ${options.preferenceType}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async clearPrivacyOptOut(options: PrivacyPreferenceCommandOptions): Promise<CommandResult> {
    try {
      new PrivacyPreferenceRepository(this.requireDatabase('privacy preference update')).clearOptOut({
        canonicalUserId: options.canonicalUserId,
        preferenceType: options.preferenceType,
        reason: options.reason ?? 'Governance CLI clear privacy opt-out',
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
      });

      return {
        success: true,
        message: `${options.canonicalUserId} opted back into ${options.preferenceType}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async listMemoryFromDatabase(options: ListMemoryOptions): Promise<MemoryRecord[]> {
    const db = this.options.db;
    if (!db) {
      return [];
    }

    const params: unknown[] = [];
    let query = 'SELECT DISTINCT mr.id FROM memory_records mr';

    if (options.sourceType || options.sourceId) {
      query += ' JOIN memory_sources ms ON ms.memory_id = mr.id';
    }

    query += ' WHERE 1=1';

    query += ' AND mr.state = ?';
    params.push(options.state ?? 'active');

    if (options.userId) {
      query += ' AND mr.canonical_user_id = ?';
      params.push(options.userId);
    }

    if (options.groupId) {
      query += ' AND mr.group_id = ?';
      params.push(options.groupId);
    }

    if (options.conversationId) {
      query += ' AND mr.conversation_id = ?';
      params.push(options.conversationId);
    }

    if (options.scope) {
      query += ' AND mr.scope = ?';
      params.push(options.scope);
    }

    if (options.sensitivity) {
      query += ' AND mr.sensitivity = ?';
      params.push(options.sensitivity);
    }

    if (options.sourceContext) {
      query += ' AND mr.source_context = ?';
      params.push(options.sourceContext);
    }

    if (options.sourceType) {
      query += ' AND ms.source_type = ?';
      params.push(options.sourceType);
    }

    if (options.sourceId) {
      query += ' AND ms.source_id = ?';
      params.push(options.sourceId);
    }

    query += ' ORDER BY mr.importance DESC, mr.created_at DESC LIMIT ?';
    params.push(options.limit ?? 100);

    const rows = db.prepare(query).all(...params) as Array<{ id: string }>;
    const memories = await Promise.all(rows.map((row) => this.memoryRepo.findById(row.id)));
    return memories.filter((memory): memory is MemoryRecord => memory !== null);
  }

  private auditRowToInspection(row: AuditRow, includeDetails: boolean): AuditInspectionRecord {
    const summary = this.redactString(row.summary);
    const details = row.details ? this.parseJson(row.details) : undefined;
    const redactedDetails = includeDetails && details !== undefined
      ? this.redactStructuredValue(details)
      : { value: undefined, redacted: false };

    return {
      id: this.redactString(row.id).text,
      timestamp: new Date(row.timestamp),
      category: this.redactString(row.category).text,
      level: this.redactString(row.level).text,
      eventType: this.redactString(row.event_type).text,
      eventId: this.redactString(row.event_id).text,
      actor: {
        canonicalUserId: row.actor_user_id ? this.redactString(row.actor_user_id).text : undefined,
        actorClass: row.actor_class ? this.redactString(row.actor_class).text : undefined,
        context: row.invocation_context ? this.redactString(row.invocation_context).text : undefined,
      },
      summary: summary.text,
      details: includeDetails ? redactedDetails.value : undefined,
      detailsRedacted: !includeDetails || redactedDetails.redacted || Boolean(row.redacted),
      redacted: Boolean(row.redacted) || summary.redacted || redactedDetails.redacted || !includeDetails,
      riskLevel: row.risk_level ? this.redactString(row.risk_level).text : undefined,
      evaluatorDecisionId: row.evaluator_decision_id
        ? this.redactString(row.evaluator_decision_id).text
        : undefined,
    };
  }

  private memoryReviewRowToInspection(
    row: AuditRow,
    includeDetails: boolean
  ): MemoryReviewCandidateInspectionRecord {
    const inspected = this.auditRowToInspection(row, includeDetails);
    const parsedDetails = row.details ? this.parseJson(row.details) : undefined;
    const memoryIdGroups = this.collectMemoryIdGroups(parsedDetails)
      .map((group) => this.redactStringArray(group));
    const resolution = this.resolveMemoryReviewStatus(row.id);

    return {
      auditId: inspected.id,
      timestamp: inspected.timestamp,
      eventType: row.event_type as MemoryReviewAuditEventType,
      eventId: inspected.eventId,
      summary: inspected.summary,
      riskLevel: inspected.riskLevel,
      redacted: inspected.redacted,
      status: resolution.status,
      candidateCount: memoryIdGroups.length,
      memoryIdGroups,
      resolutionAuditIds: resolution.resolutionAuditIds,
      supersededMemoryIds: resolution.supersededMemoryIds,
      replacementMemoryIds: resolution.replacementMemoryIds,
      disabledMemoryIds: resolution.disabledMemoryIds,
      details: inspected.details,
    };
  }

  private createEmptyMemoryReviewSummary(
    options: Omit<ListMemoryReviewOptions, 'includeDetails' | 'limit'>
  ): MemoryReviewSummaryInspectionRecord {
    const eventTypes: MemoryReviewAuditEventType[] = options.eventType
      ? [options.eventType]
      : [
        'memory.conflict.detected',
        'memory.consolidation.candidates_detected',
        'memory.decay.candidates_detected',
      ];

    return {
      generatedAt: new Date(),
      filters: {
        eventType: options.eventType,
        memoryId: options.memoryId ? this.redactString(options.memoryId).text : undefined,
        status: options.status ?? 'all',
      },
      total: 0,
      resolved: 0,
      unresolved: 0,
      candidateGroups: 0,
      memoryReferences: 0,
      resolutionAuditCount: 0,
      supersededMemoryCount: 0,
      replacementMemoryCount: 0,
      disabledMemoryCount: 0,
      byEventType: eventTypes.map((eventType) => ({
        eventType,
        total: 0,
        resolved: 0,
        unresolved: 0,
        candidateGroups: 0,
        memoryReferences: 0,
        resolutionAuditCount: 0,
        supersededMemoryCount: 0,
        replacementMemoryCount: 0,
        disabledMemoryCount: 0,
      })),
    };
  }

  private addMemoryReviewCandidateToSummary(
    summary: MemoryReviewSummaryInspectionRecord,
    candidate: MemoryReviewCandidateInspectionRecord
  ): void {
    const byEventType = summary.byEventType.find((entry) => entry.eventType === candidate.eventType);
    if (!byEventType) {
      return;
    }

    const memoryReferences = candidate.memoryIdGroups.flat().length;
    const isResolved = candidate.status === 'resolved';
    const targetRecords: Array<MemoryReviewSummaryInspectionRecord | MemoryReviewSummaryEventTypeRecord> = [
      summary,
      byEventType,
    ];

    for (const record of targetRecords) {
      record.total += 1;
      if (isResolved) {
        record.resolved += 1;
      } else {
        record.unresolved += 1;
      }
      record.candidateGroups += candidate.memoryIdGroups.length;
      record.memoryReferences += memoryReferences;
      record.resolutionAuditCount += candidate.resolutionAuditIds.length;
      record.supersededMemoryCount += candidate.supersededMemoryIds.length;
      record.replacementMemoryCount += candidate.replacementMemoryIds.length;
      record.disabledMemoryCount += candidate.disabledMemoryIds.length;
    }
  }

  private resolveMemoryReviewStatus(reviewAuditId: string): {
    status: Exclude<MemoryReviewResolutionStatus, 'all'>;
    resolutionAuditIds: string[];
    supersededMemoryIds: string[];
    replacementMemoryIds: string[];
    disabledMemoryIds: string[];
  } {
    const db = this.requireDatabase('memory review resolution inspection');
    const rows = db
      .prepare(
        `SELECT id, event_type, event_id, details
         FROM audit_log
         WHERE category = 'memory'
           AND event_type IN ('memory.supersede', 'memory.disable')
         ORDER BY timestamp ASC, id ASC`
      )
      .all() as Array<Pick<AuditRow, 'id' | 'event_type' | 'event_id' | 'details'>>;

    const matchingRows = rows.filter((row) => {
      const details = row.details ? this.parseJson(row.details) : undefined;
      return (
        this.stringProperty(details, 'reviewAuditId') === reviewAuditId
        || this.stringProperty(details, 'decayReviewAuditId') === reviewAuditId
      );
    });

    const replacementMemoryIds = matchingRows
      .map((row) => this.stringProperty(row.details ? this.parseJson(row.details) : undefined, 'replacementMemoryId'))
      .filter((value): value is string => value !== undefined);
    const disabledMemoryIds = matchingRows
      .filter((row) => row.event_type === 'memory.disable')
      .map((row) => row.event_id);

    return {
      status: matchingRows.length > 0 ? 'resolved' : 'unresolved',
      resolutionAuditIds: matchingRows.map((row) => this.redactString(row.id).text),
      supersededMemoryIds: matchingRows
        .filter((row) => row.event_type === 'memory.supersede')
        .map((row) => this.redactString(row.event_id).text),
      replacementMemoryIds: this.redactStringArray(replacementMemoryIds),
      disabledMemoryIds: this.redactStringArray(disabledMemoryIds),
    };
  }

  private toolCallRowToInspection(row: ToolCallRow, includePayload: boolean): ToolCallInspectionRecord {
    const input = includePayload ? this.redactStructuredValue(this.parseJson(row.input)) : undefined;
    const output = includePayload && row.output !== null
      ? this.redactStructuredValue(this.parseJson(row.output))
      : undefined;

    return {
      id: this.redactString(row.id).text,
      turnId: this.redactString(row.turn_id).text,
      toolName: this.redactString(row.tool_name).text,
      requestedBy: this.redactString(row.requested_by).text,
      actor: {
        canonicalUserId: row.actor_user_id ? this.redactString(row.actor_user_id).text : undefined,
        actorClass: this.redactString(row.actor_class).text,
      },
      context: this.redactString(row.invocation_context).text,
      status: this.redactString(row.status).text,
      errorCode: row.error_code ? this.redactString(row.error_code).text : undefined,
      errorMessage: row.error_message ? this.redactString(row.error_message).text : undefined,
      executionTimeMs: row.execution_time_ms ?? undefined,
      secretsRedacted: Boolean(row.secrets_redacted) || Boolean(input?.redacted) || Boolean(output?.redacted),
      createdAt: new Date(row.created_at),
      input: input?.value,
      output: output?.value,
    };
  }

  private actionDecisionRowToInspection(
    row: ActionDecisionRow,
    includeActions: boolean
  ): ActionDecisionInspectionRecord {
    const rawActions = this.parseJsonArray<ActionPlan>(row.actions);
    const actions = includeActions
      ? rawActions.map((action) => this.redactStructuredValue(action).value as ActionPlan)
      : undefined;

    return {
      id: this.redactString(row.id).text,
      turnId: this.redactString(row.turn_id).text,
      createdAt: new Date(row.created_at),
      decidedBy: this.redactString(row.decided_by).text,
      riskLevel: this.redactString(row.risk_level).text,
      confidence: row.confidence,
      evaluatorRequired: Boolean(row.evaluator_required),
      evaluatorPassed: row.evaluator_passed === null ? undefined : Boolean(row.evaluator_passed),
      actionCount: rawActions.length,
      actions,
      reasons: this.redactStringArray(this.parseNullableJsonArray<string>(row.reasons)),
      suppressors: this.redactStringArray(this.parseNullableJsonArray<string>(row.suppressors)),
    };
  }

  private actionExecutionRowToInspection(
    row: ActionExecutionRow,
    includeAuditEntry: boolean
  ): ActionExecutionInspectionRecord {
    return {
      id: this.redactString(row.id).text,
      actionDecisionId: this.redactString(row.action_decision_id).text,
      actionType: this.redactString(row.action_type).text,
      status: this.redactString(row.status).text,
      executedMessageId: row.executed_message_id
        ? this.redactString(row.executed_message_id).text
        : undefined,
      downgradedFrom: row.downgraded_from ? this.redactString(row.downgraded_from).text : undefined,
      downgradedReason: row.downgraded_reason ? this.redactString(row.downgraded_reason).text : undefined,
      errorCode: row.error_code ? this.redactString(row.error_code).text : undefined,
      errorMessage: row.error_message ? this.redactString(row.error_message).text : undefined,
      auditLevel: this.redactString(row.audit_level).text,
      auditEntry: includeAuditEntry && row.audit_entry ? this.redactString(row.audit_entry).text : undefined,
      executedAt: new Date(row.executed_at),
    };
  }

  private jobRowToInspection(row: JobRow, includePayload: boolean): JobInspectionRecord {
    const payload = includePayload ? this.redactStructuredValue(this.parseJson(row.payload)) : undefined;
    const result = includePayload && row.result !== null
      ? this.redactStructuredValue(this.parseJson(row.result))
      : undefined;

    return {
      id: this.redactString(row.id).text,
      type: this.redactString(row.type).text,
      status: this.redactString(row.status).text,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      idempotencyKey: row.idempotency_key ? this.redactString(row.idempotency_key).text : undefined,
      leaseOwner: row.lease_owner ? this.redactString(row.lease_owner).text : undefined,
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : undefined,
      heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      scheduledAt: new Date(row.scheduled_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      error: row.error ? this.redactString(row.error).text : undefined,
      payload: payload?.value,
      result: result?.value,
    };
  }

  private jobAttemptRowToInspection(row: JobAttemptRow, includeResult: boolean): JobAttemptInspectionRecord {
    const result = includeResult && row.result !== null
      ? this.redactStructuredValue(this.parseJson(row.result))
      : undefined;

    return {
      id: this.redactString(row.id).text,
      jobId: this.redactString(row.job_id).text,
      attemptNumber: row.attempt_number,
      workerId: this.redactString(row.worker_id).text,
      status: this.redactString(row.status).text,
      startedAt: new Date(row.started_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at) : undefined,
      error: row.error ? this.redactString(row.error).text : undefined,
      result: result?.value,
    };
  }

  private workerHeartbeatRowToInspection(
    row: WorkerHeartbeatRow,
    includeDetails: boolean
  ): WorkerHeartbeatInspectionRecord {
    const details = includeDetails && row.details !== null
      ? this.redactStructuredValue(this.parseJson(row.details))
      : undefined;

    return {
      workerId: this.redactString(row.worker_id).text,
      workerType: this.redactString(row.worker_type).text,
      status: this.redactString(row.status).text,
      currentJobId: row.current_job_id ? this.redactString(row.current_job_id).text : undefined,
      heartbeatAt: new Date(row.heartbeat_at),
      details: details?.value,
    };
  }

  private eventProcessingFailureRowToInspection(
    row: EventProcessingFailureRow,
    includeDetails: boolean
  ): EventProcessingFailureInspectionRecord {
    const details = includeDetails
      ? this.redactStructuredValue(this.parseJson(row.details))
      : undefined;

    return {
      id: this.redactString(row.id).text,
      rawEventId: row.raw_event_id ? this.redactString(row.raw_event_id).text : undefined,
      turnId: row.turn_id ? this.redactString(row.turn_id).text : undefined,
      occurredAt: new Date(row.occurred_at),
      stage: this.redactString(row.stage).text,
      conversationType: row.conversation_type ?? undefined,
      errorName: this.redactString(row.error_name).text,
      errorMessageHash: row.error_message_hash,
      messageIdHash: row.message_id_hash ?? undefined,
      senderIdHash: row.sender_id_hash ?? undefined,
      conversationIdHash: row.conversation_id_hash ?? undefined,
      details: details?.value,
    };
  }

  private countRows(
    db: Database.Database,
    tableName: string,
    whereClause = '1=1',
    params: unknown[] = []
  ): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${whereClause}`)
      .get(...params) as { count: number };
    return row.count;
  }

  private countByColumn(
    db: Database.Database,
    tableName: string,
    columnName: string,
    whereClause = '1=1',
    params: unknown[] = []
  ): Record<string, number> {
    const rows = db
      .prepare(
        `SELECT ${columnName} AS key, COUNT(*) AS count
         FROM ${tableName}
         WHERE ${whereClause}
         GROUP BY ${columnName}`
      )
      .all(...params) as Array<{ key: string | null; count: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) {
      const key = this.redactString(row.key ?? 'none').text;
      counts[key] = (counts[key] ?? 0) + row.count;
    }
    return counts;
  }

  private latestTimestamp(
    db: Database.Database,
    tableName: string,
    columnName: string
  ): number | undefined {
    const row = db
      .prepare(`SELECT MAX(${columnName}) AS value FROM ${tableName}`)
      .get() as { value: number | null };
    return row.value ?? undefined;
  }

  private requireDatabase(purpose: string): Database.Database {
    if (!this.options.db) {
      throw new Error(`Database connection is required for ${purpose}`);
    }

    return this.options.db;
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private parseJsonArray<T>(text: string): T[] {
    const parsed = this.parseJson(text);
    return Array.isArray(parsed) ? parsed as T[] : [];
  }

  private parseNullableJsonArray<T>(text: string | null): T[] {
    return text ? this.parseJsonArray<T>(text) : [];
  }

  private stringProperty(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const property = (value as Record<string, unknown>)[key];
    return typeof property === 'string' ? property : undefined;
  }

  private redactStringArray(values: string[]): string[] {
    return values.map((value) => this.redactString(value).text);
  }

  private redactOptionalString(value: string | undefined): string | undefined {
    return value === undefined ? undefined : this.redactString(value).text;
  }

  private redactMemoryRecordForDisplay(record: MemoryRecord): MemoryRecordInspectionRecord {
    return {
      ...record,
      id: this.redactString(record.id).text,
      scope: this.redactString(record.scope).text,
      canonicalUserId: this.redactOptionalString(record.canonicalUserId),
      groupId: this.redactOptionalString(record.groupId),
      conversationId: this.redactOptionalString(record.conversationId),
      subjectUserId: this.redactOptionalString(record.subjectUserId),
      visibility: this.redactString(record.visibility).text,
      sensitivity: this.redactString(record.sensitivity).text,
      authority: this.redactString(record.authority).text,
      kind: this.redactString(record.kind).text,
      title: this.redactString(record.title).text,
      content: this.redactString(record.content).text,
      state: this.redactString(record.state).text,
      sourceContext: this.redactString(record.sourceContext).text,
      sourceEventIds: this.redactStringArray(record.sourceEventIds),
      evaluatorDecisionId: this.redactOptionalString(record.evaluatorDecisionId),
    };
  }

  private redactString(text: string): { text: string; redacted: boolean } {
    const initialPlatformRedacted = this.redactPlatformIdentifiers(text);
    const result = redactSecretsInText(initialPlatformRedacted);
    const platformRedacted = this.redactPlatformIdentifiers(result.text);
    const platformMarkerLost =
      initialPlatformRedacted.includes('[REDACTED:platform_id]')
      && !platformRedacted.includes('[REDACTED:platform_id]');
    const redactedText = platformMarkerLost
      ? `${platformRedacted} [REDACTED:platform_id]`
      : platformRedacted;
    return {
      text: redactedText,
      redacted: result.findings.length > 0
        || initialPlatformRedacted !== text
        || platformRedacted !== result.text
        || platformMarkerLost,
    };
  }

  private redactPlatformIdentifiers(text: string): string {
    return text
      .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
      .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
  }

  private redactStructuredValue(value: unknown, path: string[] = []): { value: unknown; redacted: boolean } {
    if (typeof value === 'string') {
      const redacted = this.redactString(value);
      return { value: redacted.text, redacted: redacted.redacted };
    }

    if (typeof value === 'number') {
      return this.shouldRedactNumericPlatformId(path, value)
        ? { value: '[REDACTED:platform_id]', redacted: true }
        : { value, redacted: false };
    }

    if (Array.isArray(value)) {
      let redacted = false;
      const items = value.map((item) => {
        const result = this.redactStructuredValue(item, path);
        redacted = redacted || result.redacted;
        return result.value;
      });
      return { value: items, redacted };
    }

    if (value && typeof value === 'object') {
      let redacted = false;
      const objectValue = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(objectValue)) {
        const redactedKey = this.redactString(key);
        const childResult = this.redactStructuredValue(child, [...path, key]);
        redacted = redacted || redactedKey.redacted || childResult.redacted;
        result[redactedKey.text] = childResult.value;
      }
      return { value: result, redacted };
    }

    return { value, redacted: false };
  }

  private shouldRedactNumericPlatformId(path: string[], value: number): boolean {
    return Number.isInteger(value)
      && this.isPlatformIdField(path)
      && /^\d{8,12}$/.test(String(Math.abs(value)));
  }

  private isPlatformIdField(path: string[]): boolean {
    const key = path.at(-1);
    if (!key) {
      return false;
    }

    return /(^|_)(?:target|subject|recipient|actor|owner)?[_-]?(user|sender|group|message|conversation|platform|qq)[_-]?ids?$/i.test(key)
      || /^(?:target|subject|recipient|actor|owner)?(?:User|Sender|Group|Message|Conversation|Platform|Qq)Ids?$/i.test(key)
      || /^(userId|senderId|groupId|messageId|conversationId|platformUserId|platformMessageId)$/i.test(key);
  }

  private resolveExplainContextOptions(options: ExplainContextOptions): {
    turnId: string;
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId?: string;
    canonicalUserId?: string;
  } {
    if (options.turnId && options.conversationId) {
      throw new Error('Choose either --turn or --conversation, not both');
    }

    if (options.conversationId && !options.conversationType) {
      throw new Error('Conversation type is required when --conversation is provided');
    }

    if (options.conversationId && options.conversationType === 'group' && !options.groupId) {
      throw new Error('Group ID is required when --conversation uses --type group');
    }

    if (options.conversationId && options.conversationType === 'private' && options.groupId) {
      throw new Error('Group ID is not allowed when --conversation uses --type private');
    }

    if (options.conversationId && options.conversationType) {
      return {
        turnId: options.turnId ?? 'governance-cli-why',
        conversationId: options.conversationId,
        conversationType: options.conversationType,
        groupId: options.groupId,
        canonicalUserId: options.canonicalUserId,
      };
    }

    const row = this.findTurnRow(options.turnId);
    if (!row) {
      throw new Error(options.turnId ? `Turn ${options.turnId} not found` : 'No agent turn found');
    }

    const conversationType = options.conversationType ?? row.conversation_type;
    if (!conversationType) {
      throw new Error('Conversation type is required when it cannot be inferred from the turn');
    }

    return {
      turnId: row.id,
      conversationId: options.conversationId ?? row.conversation_id,
      conversationType,
      groupId: options.groupId ?? row.group_id ?? undefined,
      canonicalUserId: options.canonicalUserId ?? this.inferCanonicalUserId(row.sender_id),
    };
  }

  private findTurnRow(turnId?: string): LastTurnRow | null {
    const db = this.options.db;
    if (!db) {
      throw new Error('Database connection is required to resolve a turn');
    }

    const baseQuery = `
      SELECT
        at.id,
        at.context_pack_id,
        at.conversation_id,
        cm.conversation_type,
        cm.group_id,
        cm.sender_id
      FROM agent_turns at
      LEFT JOIN chat_messages cm ON cm.raw_event_id = at.trigger_event_id
    `;

    const row = turnId
      ? db.prepare(`${baseQuery} WHERE at.id = ? LIMIT 1`).get(turnId)
      : db.prepare(`${baseQuery} ORDER BY at.started_at DESC LIMIT 1`).get();

    return (row as LastTurnRow | undefined) ?? null;
  }

  private inferCanonicalUserId(senderId: string | null): string | undefined {
    if (!senderId) {
      return undefined;
    }
    return senderId.startsWith('user-') ? senderId : undefined;
  }

  private insertSystemAudit(input: {
    eventType: string;
    eventId: string;
    summary: string;
    details: object;
  }): void {
    if (!this.options.db) {
      return;
    }

    const summary = this.redactString(input.summary).text;
    const details = this.redactStructuredValue(input.details).value;

    this.options.db
      .prepare(
        `INSERT INTO audit_log (
          id, timestamp, category, level, event_type, event_id,
          actor_user_id, actor_class, invocation_context,
          summary, details, redacted, risk_level, evaluator_decision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ulid(),
        Date.now(),
        'system',
        'summary',
        input.eventType,
        input.eventId,
        null,
        'admin',
        'admin_cli',
        summary,
        JSON.stringify(details),
        1,
        'medium',
        null
      );
  }
}
