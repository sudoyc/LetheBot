import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  isTurnAdmissionRejectedError,
  type TurnAdmissionController,
  type TurnAdmissionRejectionCode,
  TurnAdmissionRejectedError,
} from '../pi/turn-admission-controller.js';
import type { ChatMessageReceived } from '../types/events.js';

export type TurnApplicationOutcome = 'completed' | 'failed';
export type EventProcessingFailureOutcome = TurnAdmissionRejectionCode | 'deadline_exceeded';

export interface EventProcessingFailureProjection {
  eventId: string;
  messageId: string;
  conversationId?: string;
  errorMessage: string;
}

export interface RecordEventProcessingFailureInput {
  event: ChatMessageReceived;
  rawEventId?: string;
  turnId?: string;
  stage: string;
  error: unknown;
  outcomeCode?: EventProcessingFailureOutcome;
}

export interface TurnApplicationServiceOptions {
  turnTimeoutMs: number;
  handleEvent(
    event: ChatMessageReceived,
    rawEventId: string,
    options: { deadlineAtMs: number },
  ): Promise<TurnApplicationOutcome>;
  redactSensitiveText(text: string): string;
  onFailurePersistenceError(error: unknown): void;
  onTaskFailure(error: unknown): void;
}

interface InsertEventProcessingFailureInput {
  event: ChatMessageReceived;
  rawEventId?: string;
  turnId?: string;
  stage: string;
  errorName: string;
  errorMessageHash: string | undefined;
  messageIdHash: string | undefined;
  senderIdHash: string | undefined;
  conversationIdHash: string | undefined;
  occurredAt: number;
  outcomeCode?: EventProcessingFailureOutcome;
}

export class TurnApplicationService {
  private readonly pendingTasks = new Set<Promise<void>>();
  private eventProcessingFailures: EventProcessingFailureProjection[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly admissionController: TurnAdmissionController,
    private readonly options: TurnApplicationServiceOptions,
  ) {}

  get pendingCount(): number {
    return this.pendingTasks.size;
  }

  get failureCount(): number {
    return this.eventProcessingFailures.length;
  }

  getEventProcessingFailures(): ReadonlyArray<EventProcessingFailureProjection> {
    return this.eventProcessingFailures;
  }

  clearEventProcessingFailuresForTesting(): void {
    this.eventProcessingFailures = [];
  }

  enqueue(
    event: ChatMessageReceived,
    rawEventId: string,
    acceptedAt: number,
  ): void {
    const deadlineAtMs = acceptedAt + this.options.turnTimeoutMs;
    const scheduled = this.admissionController.schedule(
      event.conversationId ?? event.message.conversationId,
      () => this.processAdmittedEvent(event, rawEventId, deadlineAtMs),
      { deadlineAtMs },
    );
    const task = scheduled.catch((error: unknown) => {
      if (isTurnAdmissionRejectedError(error)) {
        this.terminalizeAdmissionRejection(event, rawEventId, error);
        return;
      }
      throw error;
    });
    this.pendingTasks.add(task);
    void task.then(
      () => {
        this.pendingTasks.delete(task);
      },
      (error: unknown) => {
        this.pendingTasks.delete(task);
        this.options.onTaskFailure(error);
      },
    );
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingTasks.size > 0) {
      await Promise.allSettled(Array.from(this.pendingTasks));
    }
  }

  recordEventProcessingFailure(input: RecordEventProcessingFailureInput): void {
    const projectionErrorMessage = input.error instanceof Error
      ? input.error.message
      : 'Unknown error';
    this.eventProcessingFailures.push({
      eventId: input.event.id,
      messageId: input.event.message.messageId,
      conversationId: input.event.conversationId,
      errorMessage: this.options.redactSensitiveText(projectionErrorMessage),
    });

    const errorName = input.error instanceof Error ? input.error.name : typeof input.error;
    const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
    const errorMessageHash = this.hashForDiagnostics(errorMessage);
    const messageIdHash = this.hashForDiagnostics(input.event.message.messageId);
    const senderIdHash = this.hashForDiagnostics(input.event.message.senderId);
    const conversationId = input.event.conversationId ?? input.event.message.conversationId;
    const conversationIdHash = this.hashForDiagnostics(conversationId);
    const now = Date.now();

    try {
      this.insertEventProcessingFailure({
        event: input.event,
        rawEventId: input.rawEventId,
        turnId: input.turnId,
        stage: input.stage,
        errorName,
        errorMessageHash,
        messageIdHash,
        senderIdHash,
        conversationIdHash,
        occurredAt: now,
        ...(input.outcomeCode === undefined ? {} : { outcomeCode: input.outcomeCode }),
      });
    } catch (error) {
      this.options.onFailurePersistenceError(error);
    }
  }

  private async processAdmittedEvent(
    event: ChatMessageReceived,
    rawEventId: string,
    deadlineAtMs: number,
  ): Promise<void> {
    if (Date.now() >= deadlineAtMs) {
      this.terminalizeAdmissionRejection(
        event,
        rawEventId,
        new TurnAdmissionRejectedError(
          'queue_timeout',
          `Turn admission deadline expired before execution at ${deadlineAtMs}`,
        ),
      );
      return;
    }

    const processingStartedAt = Date.now();
    const started = this.db.prepare(
      `UPDATE event_processing_admissions
       SET state = 'processing', processing_started_at = ?
       WHERE raw_event_id = ? AND state = 'accepted'`
    ).run(processingStartedAt, rawEventId).changes;
    if (started !== 1) {
      return;
    }

    const outcome = await this.options.handleEvent(event, rawEventId, { deadlineAtMs });
    const reasonCode = outcome === 'failed' ? 'handler_failed' : null;
    const terminalized = this.db.prepare(
      `UPDATE event_processing_admissions
       SET state = ?, finished_at = ?, reason_code = ?
       WHERE raw_event_id = ? AND state = 'processing'`
    ).run(outcome, Date.now(), reasonCode, rawEventId).changes;
    if (terminalized !== 1) {
      throw new Error('Unable to terminalize event processing admission');
    }
  }

  private insertEventProcessingFailure(input: InsertEventProcessingFailureInput): void {
    this.db.prepare(
      `INSERT INTO event_processing_failures (
        id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
        error_name, error_message_hash, message_id_hash, sender_id_hash,
        conversation_id_hash, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `event-failure-${randomUUID()}`,
      input.rawEventId ?? null,
      input.turnId ?? null,
      input.occurredAt,
      input.stage,
      input.event.message.conversationType,
      input.errorName,
      input.errorMessageHash,
      input.messageIdHash ?? null,
      input.senderIdHash ?? null,
      input.conversationIdHash ?? null,
      JSON.stringify({
        redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error',
        rawEventStored: Boolean(input.rawEventId),
        turnStarted: Boolean(input.turnId),
        stage: input.stage,
        conversationType: input.event.message.conversationType,
        ...(input.outcomeCode === undefined ? {} : { outcomeCode: input.outcomeCode }),
        error: {
          name: input.errorName,
          messageHash: input.errorMessageHash,
        },
        hashes: {
          messageId: input.messageIdHash,
          senderId: input.senderIdHash,
          conversationId: input.conversationIdHash,
        },
      }),
    );
  }

  private terminalizeAdmissionRejection(
    event: ChatMessageReceived,
    rawEventId: string,
    rejection: TurnAdmissionRejectedError,
  ): void {
    const outcomeCode: EventProcessingFailureOutcome = rejection.code;
    const stage = rejection.code === 'overloaded'
      ? 'turn_admission_overloaded'
      : 'turn_admission_queue_timeout';
    const errorMessage = this.options.redactSensitiveText(rejection.message);
    const errorMessageHash = this.hashForDiagnostics(errorMessage);
    const messageIdHash = this.hashForDiagnostics(event.message.messageId);
    const senderIdHash = this.hashForDiagnostics(event.message.senderId);
    const conversationId = event.conversationId ?? event.message.conversationId;
    const conversationIdHash = this.hashForDiagnostics(conversationId);
    const now = Date.now();

    const terminalized = this.db.transaction(() => {
      const admission = this.db.prepare(
        `SELECT accepted_at
           FROM event_processing_admissions
          WHERE raw_event_id = ? AND state = 'accepted'`,
      ).get(rawEventId) as { accepted_at: number } | undefined;
      if (!admission) {
        return false;
      }

      const finishedAt = Math.max(now, admission.accepted_at);
      const changed = this.db.prepare(
        `UPDATE event_processing_admissions
            SET state = 'failed',
                processing_started_at = ?,
                finished_at = ?,
                reason_code = 'handler_failed'
          WHERE raw_event_id = ? AND state = 'accepted'`,
      ).run(finishedAt, finishedAt, rawEventId).changes;
      if (changed !== 1) {
        return false;
      }

      this.insertEventProcessingFailure({
        event,
        rawEventId,
        stage,
        errorName: rejection.name,
        errorMessageHash,
        messageIdHash,
        senderIdHash,
        conversationIdHash,
        occurredAt: finishedAt,
        outcomeCode,
      });
      return true;
    })();

    if (!terminalized) {
      return;
    }

    this.eventProcessingFailures.push({
      eventId: event.id,
      messageId: event.message.messageId,
      conversationId: event.conversationId,
      errorMessage,
    });
  }

  private hashForDiagnostics(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    return createHash('sha256').update(value).digest('hex');
  }
}
