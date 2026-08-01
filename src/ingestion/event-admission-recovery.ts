import type Database from 'better-sqlite3';
import { getLogger } from '../logger/index.js';
import type { TurnRepository } from '../storage/turn-repository.js';
import type { ChatMessageReceived } from '../types/events.js';
import {
  parseStoredChatMessageReceived,
  type StoredChatEventRow,
} from './stored-chat-event.js';

const logger = getLogger();

export interface RecoveredEventAdmission {
  event: ChatMessageReceived;
  rawEventId: string;
  acceptedAt: number;
}

type RecoverableAdmissionRow = StoredChatEventRow & {
  raw_event_id: string;
  state: 'accepted' | 'processing';
  accepted_at: number;
  has_chat: number;
  has_turn: number;
  has_failure: number;
  accepted_receipt_count: number;
  accepted_transport: string | null;
  accepted_received_at: number | null;
};

type ProcessingAdmissionRow = StoredChatEventRow & {
  raw_event_id: string;
  accepted_at: number;
  processing_started_at: number;
  has_chat: number;
  has_turn: number;
  has_failure: number;
  accepted_receipt_count: number;
  accepted_transport: string | null;
  accepted_received_at: number | null;
};

type InterruptedAdmissionState = 'accepted' | 'processing';
type AdmissionInterruptionReason =
  | 'stale_processing'
  | 'started_evidence'
  | 'invalid_stored_event';

export class EventAdmissionRecovery {
  constructor(
    private readonly db: Database.Database,
    private readonly turnRepository: TurnRepository,
  ) {}

  recover(): RecoveredEventAdmission[] {
    const rows = this.db.prepare(
      `SELECT
         a.raw_event_id,
         a.state,
         a.accepted_at,
         re.id,
         re.type,
         re.timestamp,
         re.source,
         re.platform,
         re.conversation_id,
         re.correlation_id,
         re.platform_event_id,
         re.payload,
         EXISTS(SELECT 1 FROM chat_messages cm WHERE cm.raw_event_id = a.raw_event_id) AS has_chat,
         EXISTS(SELECT 1 FROM agent_turns at WHERE at.trigger_event_id = a.raw_event_id) AS has_turn,
         EXISTS(SELECT 1 FROM event_processing_failures epf WHERE epf.raw_event_id = a.raw_event_id) AS has_failure,
         (SELECT COUNT(*)
             FROM event_ingress_receipts receipt
            WHERE receipt.raw_event_id = a.raw_event_id
              AND receipt.disposition = 'accepted') AS accepted_receipt_count,
         (SELECT receipt.transport
             FROM event_ingress_receipts receipt
            WHERE receipt.raw_event_id = a.raw_event_id
              AND receipt.disposition = 'accepted'
            ORDER BY receipt.received_at, receipt.id
            LIMIT 1) AS accepted_transport,
         (SELECT receipt.received_at
             FROM event_ingress_receipts receipt
            WHERE receipt.raw_event_id = a.raw_event_id
              AND receipt.disposition = 'accepted'
            ORDER BY receipt.received_at, receipt.id
            LIMIT 1) AS accepted_received_at
       FROM event_processing_admissions a
       JOIN raw_events re ON re.id = a.raw_event_id
       WHERE a.state IN ('accepted', 'processing')
       ORDER BY a.accepted_at, a.raw_event_id`
    ).all() as RecoverableAdmissionRow[];

    const acceptedEvents: RecoveredEventAdmission[] = [];
    let resetProcessing = 0;
    let staleProcessing = 0;
    let startedEvidence = 0;
    let invalidStoredEvents = 0;

    for (const row of rows) {
      if (row.state === 'processing') {
        const recoveredEvent = this.resetEvidenceEmptyProcessingAdmission(row.raw_event_id);
        if (recoveredEvent) {
          acceptedEvents.push({
            event: recoveredEvent,
            rawEventId: row.raw_event_id,
            acceptedAt: row.accepted_at,
          });
          resetProcessing += 1;
        } else {
          staleProcessing += this.interruptAdmission(
            row.raw_event_id,
            'processing',
            'stale_processing',
          );
        }
        continue;
      }

      if (row.has_chat === 1 || row.has_turn === 1 || row.has_failure === 1) {
        startedEvidence += this.interruptAdmission(row.raw_event_id, 'accepted', 'started_evidence');
        continue;
      }

      const parsed = parseStoredChatMessageReceived(row);
      if (
        !parsed.ok
        || row.accepted_receipt_count !== 1
        || row.accepted_transport !== parsed.event.ingress.transport
        || row.accepted_received_at !== row.accepted_at
      ) {
        invalidStoredEvents += this.interruptAdmission(
          row.raw_event_id,
          'accepted',
          'invalid_stored_event',
        );
        continue;
      }

      acceptedEvents.push({
        event: parsed.event,
        rawEventId: row.raw_event_id,
        acceptedAt: row.accepted_at,
      });
    }

    if (rows.length > 0) {
      logger.info({
        acceptedForRecovery: acceptedEvents.length,
        resetProcessing,
        staleProcessing,
        startedEvidence,
        invalidStoredEvents,
      }, 'Event admission recovery reconciled');
    }

    return acceptedEvents;
  }

  private resetEvidenceEmptyProcessingAdmission(
    rawEventId: string,
  ): ChatMessageReceived | undefined {
    const resetAdmission = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT
           a.raw_event_id,
           a.accepted_at,
           a.processing_started_at,
           re.id,
           re.type,
           re.timestamp,
           re.source,
           re.platform,
           re.conversation_id,
           re.correlation_id,
           re.platform_event_id,
           re.payload,
           EXISTS(SELECT 1 FROM chat_messages cm WHERE cm.raw_event_id = a.raw_event_id) AS has_chat,
           EXISTS(SELECT 1 FROM agent_turns at WHERE at.trigger_event_id = a.raw_event_id) AS has_turn,
           EXISTS(SELECT 1 FROM event_processing_failures epf WHERE epf.raw_event_id = a.raw_event_id) AS has_failure,
           (SELECT COUNT(*)
              FROM event_ingress_receipts receipt
             WHERE receipt.raw_event_id = a.raw_event_id
               AND receipt.disposition = 'accepted') AS accepted_receipt_count,
           (SELECT receipt.transport
              FROM event_ingress_receipts receipt
             WHERE receipt.raw_event_id = a.raw_event_id
               AND receipt.disposition = 'accepted'
             ORDER BY receipt.received_at, receipt.id
             LIMIT 1) AS accepted_transport,
           (SELECT receipt.received_at
              FROM event_ingress_receipts receipt
             WHERE receipt.raw_event_id = a.raw_event_id
               AND receipt.disposition = 'accepted'
             ORDER BY receipt.received_at, receipt.id
             LIMIT 1) AS accepted_received_at
         FROM event_processing_admissions a
         JOIN raw_events re ON re.id = a.raw_event_id
         WHERE a.raw_event_id = ? AND a.state = 'processing'`
      ).get(rawEventId) as ProcessingAdmissionRow | undefined;

      if (!row || row.has_chat === 1 || row.has_turn === 1 || row.has_failure === 1) {
        return undefined;
      }

      const parsed = parseStoredChatMessageReceived(row);
      if (
        !parsed.ok
        || row.accepted_receipt_count !== 1
        || row.accepted_transport !== parsed.event.ingress.transport
        || row.accepted_received_at !== row.accepted_at
      ) {
        return undefined;
      }

      const changed = this.db.prepare(
        `UPDATE event_processing_admissions
         SET state = 'accepted',
             processing_started_at = NULL,
             finished_at = NULL,
             reason_code = NULL
         WHERE raw_event_id = ?
           AND state = 'processing'
           AND accepted_at = ?
           AND processing_started_at = ?
           AND NOT EXISTS (
             SELECT 1 FROM chat_messages cm
              WHERE cm.raw_event_id = event_processing_admissions.raw_event_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM agent_turns at
              WHERE at.trigger_event_id = event_processing_admissions.raw_event_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM event_processing_failures epf
              WHERE epf.raw_event_id = event_processing_admissions.raw_event_id
           )
           AND (
             SELECT COUNT(*)
               FROM event_ingress_receipts receipt
              WHERE receipt.raw_event_id = event_processing_admissions.raw_event_id
                AND receipt.disposition = 'accepted'
           ) = 1
           AND EXISTS (
             SELECT 1
               FROM event_ingress_receipts receipt
              WHERE receipt.raw_event_id = event_processing_admissions.raw_event_id
                AND receipt.disposition = 'accepted'
                AND receipt.transport = ?
                AND receipt.received_at = event_processing_admissions.accepted_at
           )`
      ).run(
        rawEventId,
        row.accepted_at,
        row.processing_started_at,
        parsed.event.ingress.transport,
      ).changes;

      return changed === 1 ? parsed.event : undefined;
    });

    // The write lock keeps the strict read and guarded reset on one evidence snapshot.
    return resetAdmission.immediate();
  }

  private interruptAdmission(
    rawEventId: string,
    expectedState: InterruptedAdmissionState,
    reasonCode: AdmissionInterruptionReason,
  ): number {
    const completedAt = new Date();
    return this.db.transaction(() => {
      const changed = this.db.prepare(
        `UPDATE event_processing_admissions
         SET state = 'interrupted_review', finished_at = ?, reason_code = ?
         WHERE raw_event_id = ? AND state = ?`
      ).run(completedAt.getTime(), reasonCode, rawEventId, expectedState).changes;

      if (changed === 1) {
        this.turnRepository.markAbortedByTriggerEvent(
          rawEventId,
          'Startup admission recovery interrupted this turn',
          completedAt,
        );
      }

      return changed;
    })();
  }
}
