import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { AttentionEngine } from '../attention/engine.js';
import {
  DelayedAttentionService,
  parseDelayedAttentionTaskPayload,
  type DelayedAttentionCandidate,
  type DelayedAttentionDecision,
} from '../attention/delayed-attention-service.js';
import { ContextBuilder } from '../context/builder.js';
import {
  parseStoredChatMessageReceived,
  type StoredChatEventRow,
} from '../ingestion/stored-chat-event.js';
import {
  applyRetentionPolicy,
  type RetentionPolicy,
} from '../operations/sqlite-maintenance.js';
import { TurnAdmissionController } from '../pi/turn-admission-controller.js';
import { AuditRepository } from '../storage/audit-repository.js';
import {
  GroupSummaryPolicyError,
  GroupSummaryPolicyRepository,
} from '../storage/group-summary-policy-repository.js';
import { IdentityRepository } from '../storage/identity-repository.js';
import { JobRepository } from '../storage/job-repository.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import type { AttentionSignals } from '../types/attention.js';
import type { ChatMessageReceived } from '../types/events.js';
import { AdminDigestWorker } from '../workers/admin-digest.js';
import {
  BackgroundWorker,
  INTERACTIVE_TASK_TYPES,
  NonRetryableBackgroundTaskError,
  type BackgroundTask,
  type BackgroundTaskExecutionContext,
  type BackgroundTaskHandler,
  type EnqueueTaskInput,
  type TaskResult,
  type TaskType,
} from '../workers/background.js';
import {
  GroupSummaryJobService,
  GroupSummaryWindowError,
} from '../workers/group-summary-job-service.js';
import { MemoryConflictWorker } from '../workers/memory-conflict.js';
import { MemoryConsolidationWorker } from '../workers/memory-consolidation.js';
import { MemoryDecayWorker } from '../workers/memory-decay.js';
import { MemoryExtractionWorker } from '../workers/memory-extraction.js';
import { WorkerScheduler } from '../workers/scheduler.js';
import { SummaryWorker, type ConversationSummaryInput } from '../workers/summary-worker.js';
import type {
  HandleConversationTurnOptions,
  PiRuntime,
} from './conversation-turn-service.js';
import type { TurnApplicationOutcome } from './turn-application-service.js';

export interface BackgroundRuntimeServiceOptions {
  db: Database.Database;
  jobRepository: JobRepository;
  memoryRepository: MemoryRepository;
  identityRepository: IdentityRepository;
  auditRepository: AuditRepository;
  groupSummaryPolicyRepository: GroupSummaryPolicyRepository;
  attentionEngine: AttentionEngine;
  delayedAttentionService: DelayedAttentionService;
  turnAdmissionController: TurnAdmissionController;
  test: boolean;
  backgroundSummaryEnabled: boolean;
  piProvider: string;
  piModel: string;
  piTurnTimeoutMs: number;
  retentionPolicy: RetentionPolicy;
  getPiRuntime(): PiRuntime;
  getMemoryExtractor(): MemoryExtractionWorker;
  handleConversationTurn(
    event: ChatMessageReceived,
    rawEventId: string,
    options: HandleConversationTurnOptions,
  ): Promise<TurnApplicationOutcome>;
}

export class BackgroundRuntimeService {
  readonly groupSummaryJobService: GroupSummaryJobService;
  private readonly backgroundWorker: BackgroundWorker;
  private readonly interactiveBackgroundWorker: BackgroundWorker;
  private readonly workerScheduler: WorkerScheduler;

  constructor(private readonly options: BackgroundRuntimeServiceOptions) {
    const backgroundTaskHandlers = {
      summary: (task, execution) => this.handleSummaryBackgroundTask(task, execution),
      extraction: (task, execution) => this.handleExtractionBackgroundTask(task, execution),
      attention_recheck: (task, execution) => (
        this.handleAttentionRecheckBackgroundTask(task, execution)
      ),
      consolidation: (task) => this.handleConsolidationBackgroundTask(task),
      conflict: (task) => this.handleConflictBackgroundTask(task),
      decay: (task) => this.handleDecayBackgroundTask(task),
      admin_digest: (task) => this.handleAdminDigestBackgroundTask(task),
      retention: (task) => this.handleRetentionBackgroundTask(task),
    } satisfies Partial<Record<TaskType, BackgroundTaskHandler>>;

    this.backgroundWorker = new BackgroundWorker({
      jobRepository: this.options.jobRepository,
      workerId: 'lethebot-background-main',
      excludedClaimTypes: INTERACTIVE_TASK_TYPES,
      handlers: backgroundTaskHandlers,
    });
    this.interactiveBackgroundWorker = new BackgroundWorker({
      jobRepository: this.options.jobRepository,
      workerId: 'lethebot-background-interactive',
      claimTypes: INTERACTIVE_TASK_TYPES,
      handlers: backgroundTaskHandlers,
    });
    this.workerScheduler = new WorkerScheduler();
    this.groupSummaryJobService = new GroupSummaryJobService(this.options.db, {
      jobRepository: this.options.jobRepository,
      policyRepository: this.options.groupSummaryPolicyRepository,
      planGroupSummaryWindow: (input) => (
        this.createSummaryWorker().planGroupSummaryWindow(input)
      ),
    });
  }

  registerJobs(): void {
    this.workerScheduler.register({
      name: 'durable-interactive-job-processor',
      intervalMs: 5_000,
      handler: async () => {
        await this.interactiveBackgroundWorker.processNext();
      },
    });

    this.workerScheduler.register({
      name: 'durable-background-job-processor',
      intervalMs: 5_000,
      handler: async () => {
        await this.backgroundWorker.processNext();
      },
    });

    if (this.options.backgroundSummaryEnabled) {
      this.workerScheduler.register({
        name: 'summary-discovery',
        intervalMs: 5 * 60_000,
        handler: async () => {
          await this.enqueueSummaryJobs();
        },
      });
    }

    this.workerScheduler.register({
      name: 'retention-maintenance',
      intervalMs: 24 * 60 * 60_000,
      handler: async () => {
        this.enqueueRetentionJob();
      },
    });

    this.workerScheduler.register({
      name: 'admin-digest-maintenance',
      intervalMs: 24 * 60 * 60_000,
      handler: async () => {
        this.enqueueAdminDigestJob();
      },
    });

    this.workerScheduler.register({
      name: 'memory-conflict-maintenance',
      intervalMs: 24 * 60 * 60_000,
      handler: async () => {
        this.enqueueConflictJob();
      },
    });

    this.workerScheduler.register({
      name: 'memory-decay-maintenance',
      intervalMs: 24 * 60 * 60_000,
      handler: async () => {
        this.enqueueDecayJob();
      },
    });

    this.workerScheduler.register({
      name: 'memory-consolidation-maintenance',
      intervalMs: 24 * 60 * 60_000,
      handler: async () => {
        this.enqueueConsolidationJob();
      },
    });
  }

  start(): void {
    this.workerScheduler.start();
  }

  stopAndDrain(): Promise<void> {
    return this.workerScheduler.stopAndDrain();
  }

  enqueue(task: EnqueueTaskInput): string {
    return this.backgroundWorker.enqueue(task);
  }

  processNext(now?: number, types?: TaskType[]): Promise<TaskResult | null> {
    return this.backgroundWorker.processNext(now, types);
  }

  private async enqueueSummaryJobs(): Promise<void> {
    const summaryWorker = this.createSummaryWorker();
    const candidates = await summaryWorker.findConversationsNeedingSummary(60);

    for (const candidate of candidates) {
      try {
        await this.groupSummaryJobService.enqueueSummary({
          conversationId: candidate.conversationId,
          conversationType: candidate.conversationType,
          groupId: candidate.groupId,
          payload: candidate.conversationType === 'group'
            ? { source: 'summary_discovery' }
            : {
                timeRange: candidate.timeRange,
                messageRange: candidate.messageRange,
              },
          baseIdempotencyKey: this.buildSummaryJobKey(candidate),
        });
      } catch (error) {
        if (error instanceof GroupSummaryPolicyError && error.code === 'policy_disabled') {
          continue;
        }
        if (error instanceof GroupSummaryWindowError && error.code === 'window_unavailable') {
          continue;
        }
        throw error;
      }
    }
  }

  private buildSummaryJobKey(candidate: ConversationSummaryInput): string {
    const digest = createHash('sha256')
      .update(JSON.stringify({
        version: 1,
        conversationId: candidate.conversationId,
        conversationType: candidate.conversationType,
        groupId: candidate.groupId ?? null,
        messageRange: candidate.messageRange ?? null,
        timeRange: candidate.timeRange ?? null,
      }))
      .digest('hex')
      .slice(0, 32);
    return `summary:v1:${digest}`;
  }

  private createSummaryWorker(): SummaryWorker {
    if (!this.options.test && !this.options.backgroundSummaryEnabled) {
      throw new Error(
        'Background summary Provider processing is disabled; set LETHEBOT_BACKGROUND_SUMMARY_ENABLED=true to opt in',
      );
    }

    return new SummaryWorker(
      this.options.db,
      this.options.getPiRuntime(),
      this.options.memoryRepository,
      new ContextBuilder(this.options.memoryRepository, this.options.identityRepository),
      {
        piProvider: this.options.piProvider,
        piModel: this.options.piModel,
        requireDurableExecution: true,
      },
    );
  }

  private async handleSummaryBackgroundTask(
    task: BackgroundTask,
    execution?: BackgroundTaskExecutionContext,
  ): Promise<unknown> {
    if (!execution) {
      throw new Error('Summary background task requires durable execution context');
    }
    try {
      const payload = task.payload;
      const conversationType = this.requireConversationType(
        payload.conversationType,
        task.type,
      );
      const summaryInput: ConversationSummaryInput = {
        conversationId: this.requireString(payload.conversationId, 'conversationId', task.type),
        conversationType,
        groupId: this.optionalString(payload.groupId),
        ...(conversationType === 'group'
          ? { sourceChatMessageIds: this.requireSummarySourceIds(payload.sourceChatMessageIds) }
          : {
              messageRange: this.parseMessageRange(payload.messageRange),
              timeRange: this.parseTimeRange(payload.timeRange),
            }),
      };
      const binding = this.options.groupSummaryPolicyRepository.getBinding(task.id);
      if (
        binding
        && (
          summaryInput.conversationType !== 'group'
          || summaryInput.groupId !== binding.groupId
          || summaryInput.conversationId !== binding.conversationId
        )
      ) {
        throw new GroupSummaryPolicyError(
          'job_binding_mismatch',
          'Group summary job binding does not match the task payload.',
        );
      }

      const result = await this.createSummaryWorker().generateSummary(summaryInput, execution);
      if (!result) {
        return null;
      }

      return {
        summaryId: result.summaryId,
        messageCount: result.messageCount,
        timeRange: result.timeRange,
        confidence: result.confidence,
      };
    } catch (error) {
      if (error instanceof GroupSummaryPolicyError) {
        throw new NonRetryableBackgroundTaskError(error.message);
      }
      throw error;
    }
  }

  private async handleExtractionBackgroundTask(
    task: BackgroundTask,
    execution?: BackgroundTaskExecutionContext,
  ): Promise<unknown> {
    if (!execution) {
      throw new Error('Extraction background task requires durable execution context');
    }
    const payload = task.payload;

    return this.options.getMemoryExtractor().extractFromChatMessage({
      sourceChatMessageId: this.requireString(
        payload.sourceChatMessageId,
        'sourceChatMessageId',
        task.type,
      ),
      targetUserId: this.requireString(payload.targetUserId, 'targetUserId', task.type),
      jobAttemptId: execution.jobAttemptId,
    });
  }

  private async handleAttentionRecheckBackgroundTask(
    task: BackgroundTask,
    execution?: BackgroundTaskExecutionContext,
  ): Promise<unknown> {
    if (!execution) {
      throw new Error('Delayed Attention background task requires durable execution context');
    }

    const { candidateId } = parseDelayedAttentionTaskPayload(task.payload);
    const candidate = this.options.delayedAttentionService.findCandidate(candidateId);
    if (
      !candidate
      || candidate.jobId !== task.id
      || candidate.jobId !== execution.jobId
    ) {
      throw new Error('Delayed Attention candidate/job binding is invalid');
    }

    const deadlineAtMs = Date.now() + this.options.piTurnTimeoutMs;
    return this.options.turnAdmissionController.schedule(candidate.conversationId, async () => {
      const event = this.readDelayedAttentionSourceEvent(candidate);
      const signals = this.buildDelayedAttentionSignals(event);
      const decision = this.options.delayedAttentionService.decide({
        candidateId,
        jobId: execution.jobId,
        jobAttemptId: execution.jobAttemptId,
        now: execution.now,
      });

      if (decision.outcome === 'suppress') {
        return {
          candidateId,
          decisionId: decision.id,
          outcome: decision.outcome,
          suppressors: decision.suppressors.map((suppressor) => ({
            id: suppressor.id,
            code: suppressor.code,
          })),
        };
      }

      const existing = this.findDelayedAttentionTerminalTurn(candidate.sourceRawEventId);
      if (existing) {
        return this.buildDelayedAttentionRespondResult(candidateId, decision, existing);
      }

      const outcome = await this.options.handleConversationTurn(
        event,
        candidate.sourceRawEventId,
        {
          sourceAlreadyPersisted: true,
          signals,
          deadlineAtMs,
        },
      );
      if (outcome !== 'completed') {
        throw new Error('Delayed Attention response processing failed');
      }

      const completed = this.findDelayedAttentionTerminalTurn(candidate.sourceRawEventId);
      if (!completed) {
        throw new Error('Delayed Attention response completed without terminal turn evidence');
      }
      return this.buildDelayedAttentionRespondResult(candidateId, decision, completed);
    }, { deadlineAtMs });
  }

  private readDelayedAttentionSourceEvent(
    candidate: DelayedAttentionCandidate,
  ): ChatMessageReceived {
    const row = this.options.db.prepare(
      `SELECT raw.id,
              raw.type,
              raw.timestamp,
              raw.source,
              raw.platform,
              raw.conversation_id,
              raw.correlation_id,
              raw.platform_event_id,
              raw.payload,
              raw.created_at AS raw_created_at,
              message.id AS chat_message_id,
              message.raw_event_id AS chat_raw_event_id,
              message.message_id AS chat_platform_message_id,
              message.conversation_id AS chat_conversation_id,
              message.conversation_type AS chat_conversation_type,
              message.group_id AS chat_group_id,
              message.sender_id AS chat_sender_id,
              message.sender_role AS chat_sender_role,
              message.text AS chat_text,
              message.mentions_bot AS chat_mentions_bot,
              message.reply_to_message_id AS chat_reply_to_message_id
         FROM raw_events AS raw
         JOIN chat_messages AS message ON message.id = ?
        WHERE raw.id = ?
          AND message.raw_event_id = raw.id`,
    ).get(candidate.sourceChatMessageId, candidate.sourceRawEventId) as (StoredChatEventRow & {
      raw_created_at: number;
      chat_message_id: string;
      chat_raw_event_id: string;
      chat_platform_message_id: string;
      chat_conversation_id: string;
      chat_conversation_type: string;
      chat_group_id: string | null;
      chat_sender_id: string;
      chat_sender_role: string | null;
      chat_text: string | null;
      chat_mentions_bot: number;
      chat_reply_to_message_id: string | null;
    }) | undefined;
    if (!row) {
      throw new Error('Delayed Attention source event is unavailable');
    }

    const parsed = parseStoredChatMessageReceived(row);
    if (!parsed.ok) {
      throw new Error('Delayed Attention source event is invalid');
    }
    const event = parsed.event;
    if (
      row.raw_created_at !== candidate.observedAt
      || row.chat_message_id !== candidate.sourceChatMessageId
      || row.chat_raw_event_id !== candidate.sourceRawEventId
      || row.chat_platform_message_id !== event.message.messageId
      || row.chat_conversation_id !== candidate.conversationId
      || row.chat_conversation_id !== event.message.conversationId
      || row.chat_conversation_type !== candidate.conversationType
      || event.message.conversationType !== candidate.conversationType
      || row.chat_group_id !== candidate.groupId
      || event.message.groupId !== candidate.groupId
      || row.chat_sender_id !== event.message.senderId
      || row.chat_sender_role !== (event.message.senderRole ?? null)
      || (row.chat_text ?? '') !== (event.message.content.text ?? '')
      || row.chat_mentions_bot !== (event.message.mentionsBot ? 1 : 0)
      || row.chat_reply_to_message_id !== (event.message.replyToMessageId ?? null)
    ) {
      throw new Error('Delayed Attention source event no longer matches its chat evidence');
    }

    return event;
  }

  private buildDelayedAttentionSignals(event: ChatMessageReceived): AttentionSignals {
    const original = this.options.attentionEngine.analyze({
      conversationType: event.message.conversationType,
      mentionsBot: event.message.mentionsBot,
      text: event.message.content.text ?? '',
      senderId: event.message.senderId,
      senderRole: event.message.senderRole,
      replyToBot: false,
    });
    if (
      original.classification !== 'defer'
      || original.recommendedPath !== 'delayed_recheck'
    ) {
      throw new Error('Delayed Attention source no longer matches the deferred policy');
    }

    return {
      ...original,
      classification: 'needs_response',
      recommendedPath: 'reply_fast_path',
      triggerReasons: [...new Set([...original.triggerReasons, 'delayed_recheck'])],
    };
  }

  private findDelayedAttentionTerminalTurn(sourceRawEventId: string): {
    turnId: string;
    actionDecisionId?: string;
    actionExecutionId?: string;
    deliveryRecorded: boolean;
  } | null {
    const rows = this.options.db.prepare(
      `SELECT turn.id AS turn_id,
              turn.status,
              turn.action_decision_id,
              delivery.id AS delivery_execution_id
         FROM agent_turns AS turn
         LEFT JOIN action_executions AS delivery
           ON delivery.id = (
             SELECT execution.id
               FROM action_executions AS execution
              WHERE execution.action_decision_id = turn.action_decision_id
                AND execution.executed_message_id IS NOT NULL
                AND (
                  (execution.status = 'success' AND execution.action_type IN (
                    'reply_short', 'reply_full', 'reply_with_tool', 'ask_clarification'
                  ))
                  OR (execution.status = 'downgraded' AND execution.action_type IN (
                    'send_folded_forward', 'react_only'
                  ))
                )
              ORDER BY execution.executed_at DESC, execution.id DESC
              LIMIT 1
           )
        WHERE turn.trigger_event_id = ?
        ORDER BY turn.started_at DESC, turn.id DESC`,
    ).all(sourceRawEventId) as Array<{
      turn_id: string;
      status: string;
      action_decision_id: string | null;
      delivery_execution_id: string | null;
    }>;

    const delivered = rows.find((row) => row.delivery_execution_id !== null);
    if (delivered) {
      return {
        turnId: delivered.turn_id,
        ...(delivered.action_decision_id
          ? { actionDecisionId: delivered.action_decision_id }
          : {}),
        actionExecutionId: delivered.delivery_execution_id as string,
        deliveryRecorded: true,
      };
    }

    const completed = rows.find((row) => row.status === 'completed');
    if (completed) {
      return {
        turnId: completed.turn_id,
        ...(completed.action_decision_id
          ? { actionDecisionId: completed.action_decision_id }
          : {}),
        deliveryRecorded: false,
      };
    }

    const indeterminate = rows.find((row) => {
      return row.status === 'pending'
        || row.status === 'running'
        || row.action_decision_id !== null;
    });
    if (indeterminate) {
      throw new Error('Delayed Attention prior turn has indeterminate delivery state');
    }

    return null;
  }

  private buildDelayedAttentionRespondResult(
    candidateId: string,
    decision: DelayedAttentionDecision,
    terminal: {
      turnId: string;
      actionDecisionId?: string;
      actionExecutionId?: string;
      deliveryRecorded: boolean;
    },
  ): object {
    return {
      candidateId,
      decisionId: decision.id,
      outcome: decision.outcome,
      turnId: terminal.turnId,
      ...(terminal.actionDecisionId
        ? { actionDecisionId: terminal.actionDecisionId }
        : {}),
      ...(terminal.actionExecutionId
        ? { actionExecutionId: terminal.actionExecutionId }
        : {}),
      deliveryRecorded: terminal.deliveryRecorded,
    };
  }

  private enqueueConsolidationJob(): string {
    const nowMs = Date.now();
    const day = new Date(nowMs).toISOString().slice(0, 10);

    return this.backgroundWorker.enqueue({
      type: 'consolidation',
      payload: {
        nowMs,
        minGroupSize: 2,
      },
      idempotencyKey: `memory_consolidation:${day}`,
      maxAttempts: 2,
    });
  }

  private async handleConsolidationBackgroundTask(task: BackgroundTask): Promise<unknown> {
    const worker = new MemoryConsolidationWorker(
      this.options.db,
      this.options.auditRepository,
    );

    return worker.scan({
      jobId: task.id,
      nowMs: this.optionalNumber(task.payload.nowMs),
      minGroupSize: this.optionalNumber(task.payload.minGroupSize),
      limit: this.optionalNumber(task.payload.limit),
      scope: this.optionalString(task.payload.scope),
      canonicalUserId: this.optionalString(task.payload.canonicalUserId),
      groupId: this.optionalString(task.payload.groupId),
      conversationId: this.optionalString(task.payload.conversationId),
    });
  }

  private enqueueConflictJob(): string {
    const nowMs = Date.now();
    const day = new Date(nowMs).toISOString().slice(0, 10);

    return this.backgroundWorker.enqueue({
      type: 'conflict',
      payload: {
        sinceMs: nowMs - 24 * 60 * 60 * 1000,
        nowMs,
      },
      idempotencyKey: `memory_conflict:${day}`,
      maxAttempts: 2,
    });
  }

  private async handleConflictBackgroundTask(task: BackgroundTask): Promise<unknown> {
    const worker = new MemoryConflictWorker(this.options.db, this.options.auditRepository);

    return worker.detect({
      jobId: task.id,
      sinceMs: this.optionalNumber(task.payload.sinceMs),
      nowMs: this.optionalNumber(task.payload.nowMs),
      limit: this.optionalNumber(task.payload.limit),
    });
  }

  private enqueueDecayJob(): string {
    const nowMs = Date.now();
    const day = new Date(nowMs).toISOString().slice(0, 10);

    return this.backgroundWorker.enqueue({
      type: 'decay',
      payload: {
        nowMs,
        staleBeforeMs: nowMs - 180 * 24 * 60 * 60 * 1000,
        maxConfidence: 0.5,
        maxImportance: 0.3,
      },
      idempotencyKey: `memory_decay:${day}`,
      maxAttempts: 2,
    });
  }

  private async handleDecayBackgroundTask(task: BackgroundTask): Promise<unknown> {
    const worker = new MemoryDecayWorker(this.options.db, this.options.auditRepository);

    return worker.scan({
      jobId: task.id,
      nowMs: this.optionalNumber(task.payload.nowMs),
      staleBeforeMs: this.optionalNumber(task.payload.staleBeforeMs),
      maxConfidence: this.optionalNumber(task.payload.maxConfidence),
      maxImportance: this.optionalNumber(task.payload.maxImportance),
      limit: this.optionalNumber(task.payload.limit),
      scope: this.optionalString(task.payload.scope),
      canonicalUserId: this.optionalString(task.payload.canonicalUserId),
      groupId: this.optionalString(task.payload.groupId),
      conversationId: this.optionalString(task.payload.conversationId),
    });
  }

  private enqueueAdminDigestJob(): string {
    const nowMs = Date.now();
    const day = new Date(nowMs).toISOString().slice(0, 10);

    return this.backgroundWorker.enqueue({
      type: 'admin_digest',
      payload: {
        sinceMs: nowMs - 24 * 60 * 60 * 1000,
        nowMs,
      },
      idempotencyKey: `admin_digest:${day}`,
      maxAttempts: 2,
    });
  }

  private async handleAdminDigestBackgroundTask(task: BackgroundTask): Promise<unknown> {
    const worker = new AdminDigestWorker(this.options.db, this.options.auditRepository);

    return worker.generate({
      jobId: task.id,
      sinceMs: this.optionalNumber(task.payload.sinceMs),
      nowMs: this.optionalNumber(task.payload.nowMs),
      limit: this.optionalNumber(task.payload.limit),
    });
  }

  private enqueueRetentionJob(): string | undefined {
    const policy = this.currentRetentionPolicy();
    if (!this.hasRetentionPolicy(policy)) {
      return undefined;
    }

    const day = new Date().toISOString().slice(0, 10);
    return this.backgroundWorker.enqueue({
      type: 'retention',
      payload: {
        rawEventsDays: policy.rawEventsDays,
        chatMessagesDays: policy.chatMessagesDays,
        auditLogDays: policy.auditLogDays,
        disabledDeletedMemoryDays: policy.disabledDeletedMemoryDays,
        eventProcessingFailuresDays: policy.eventProcessingFailuresDays,
      },
      idempotencyKey: `retention:${day}`,
      maxAttempts: 2,
    });
  }

  private async handleRetentionBackgroundTask(task: BackgroundTask): Promise<unknown> {
    const policy = this.retentionPolicyFromPayload(task.payload);
    const nowMs = this.optionalRetentionInteger(task.payload.nowMs, 'nowMs') ?? Date.now();
    return applyRetentionPolicy(this.options.db, policy, nowMs);
  }

  private currentRetentionPolicy(): RetentionPolicy {
    return {
      rawEventsDays: this.options.retentionPolicy.rawEventsDays,
      chatMessagesDays: this.options.retentionPolicy.chatMessagesDays,
      auditLogDays: this.options.retentionPolicy.auditLogDays,
      disabledDeletedMemoryDays: this.options.retentionPolicy.disabledDeletedMemoryDays,
      eventProcessingFailuresDays: this.options.retentionPolicy.eventProcessingFailuresDays,
    };
  }

  private hasRetentionPolicy(policy: RetentionPolicy): boolean {
    return [
      policy.rawEventsDays,
      policy.chatMessagesDays,
      policy.auditLogDays,
      policy.disabledDeletedMemoryDays,
      policy.eventProcessingFailuresDays,
    ].some((days) => typeof days === 'number' && days > 0);
  }

  private retentionPolicyFromPayload(payload: BackgroundTask['payload']): RetentionPolicy {
    return {
      rawEventsDays: this.optionalRetentionInteger(payload.rawEventsDays, 'rawEventsDays'),
      chatMessagesDays: this.optionalRetentionInteger(
        payload.chatMessagesDays,
        'chatMessagesDays',
      ),
      auditLogDays: this.optionalRetentionInteger(payload.auditLogDays, 'auditLogDays'),
      disabledDeletedMemoryDays: this.optionalRetentionInteger(
        payload.disabledDeletedMemoryDays,
        'disabledDeletedMemoryDays',
      ),
      eventProcessingFailuresDays: this.optionalRetentionInteger(
        payload.eventProcessingFailuresDays,
        'eventProcessingFailuresDays',
      ),
    };
  }

  private optionalRetentionInteger(value: unknown, field: string): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
    throw new Error(`Background task retention requires nonnegative integer payload.${field}`);
  }

  private requireString(value: unknown, field: string, taskType: string): string {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }

    throw new Error(`Background task ${taskType} requires string payload.${field}`);
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private requireConversationType(
    value: unknown,
    taskType: string,
  ): 'private' | 'group' {
    if (value === 'private' || value === 'group') {
      return value;
    }

    throw new Error(`Background task ${taskType} requires payload.conversationType`);
  }

  private optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private parseMessageRange(value: unknown): { start: string; end: string } | undefined {
    if (
      typeof value === 'object'
      && value !== null
      && 'start' in value
      && 'end' in value
      && typeof value.start === 'string'
      && typeof value.end === 'string'
    ) {
      return { start: value.start, end: value.end };
    }

    return undefined;
  }

  private parseTimeRange(value: unknown): { startTime: number; endTime: number } | undefined {
    if (
      typeof value === 'object'
      && value !== null
      && 'startTime' in value
      && 'endTime' in value
      && typeof value.startTime === 'number'
      && typeof value.endTime === 'number'
    ) {
      return { startTime: value.startTime, endTime: value.endTime };
    }

    return undefined;
  }

  private requireSummarySourceIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
      throw new GroupSummaryPolicyError(
        'job_binding_mismatch',
        'Group summary job requires a bounded frozen source window.',
      );
    }
    const sourceIds = value.map((sourceId) => {
      if (
        typeof sourceId !== 'string'
        || sourceId.length === 0
        || sourceId.trim() !== sourceId
      ) {
        throw new GroupSummaryPolicyError(
          'job_binding_mismatch',
          'Group summary job frozen source IDs are invalid.',
        );
      }
      return sourceId;
    });
    if (new Set(sourceIds).size !== sourceIds.length) {
      throw new GroupSummaryPolicyError(
        'job_binding_mismatch',
        'Group summary job frozen source IDs must be unique.',
      );
    }
    return sourceIds;
  }
}
