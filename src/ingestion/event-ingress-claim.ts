import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../logger/index.js';
import type { ChatMessageReceived } from '../types/events.js';

const logger = getLogger();

export interface EventIngressClaimResult {
  disposition: 'accepted' | 'duplicate';
  rawEventId: string;
  acceptedAt?: number;
}

export class EventIngressClaimService {
  constructor(private readonly db: Database.Database) {}

  claim(event: ChatMessageReceived): EventIngressClaimResult {
    return this.db.transaction(() => {
      const conversationId = event.conversationId ?? event.message.conversationId;
      const platformEventId = event.ingress.platformEventId ?? null;
      const receivedAt = Date.now();
      const insert = this.db.prepare(`
        INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, correlation_id, platform_event_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).run(
        event.id,
        event.type,
        new Date(event.timestamp).getTime(),
        event.source,
        event.platform,
        conversationId,
        event.correlationId ?? null,
        platformEventId,
        JSON.stringify(event),
        receivedAt,
      );

      let disposition: 'accepted' | 'duplicate';
      let rawEventId: string;
      if (insert.changes === 1) {
        disposition = 'accepted';
        rawEventId = event.id;
      } else {
        if (!platformEventId) {
          throw new Error('Unable to claim OneBot event without a stable platform event id');
        }
        const canonical = this.db.prepare(
          `SELECT id
             FROM raw_events
            WHERE source = 'gateway'
              AND platform = ?
              AND type = ?
              AND conversation_id = ?
              AND platform_event_id = ?`
        ).get(event.platform, event.type, conversationId, platformEventId) as { id: string } | undefined;
        if (!canonical) {
          throw new Error('Unable to resolve canonical OneBot event after claim conflict');
        }
        disposition = 'duplicate';
        rawEventId = canonical.id;
      }

      this.db.prepare(
        `INSERT INTO event_ingress_receipts (
          id, raw_event_id, transport, disposition, received_at
        ) VALUES (?, ?, ?, ?, ?)`
      ).run(
        `ingress-receipt-${randomUUID()}`,
        rawEventId,
        event.ingress.transport,
        disposition,
        receivedAt,
      );

      if (disposition === 'accepted') {
        this.db.prepare(
          `INSERT INTO event_processing_admissions (
            raw_event_id, state, accepted_at, processing_started_at, finished_at, reason_code
          ) VALUES (?, 'accepted', ?, NULL, NULL, NULL)`
        ).run(rawEventId, receivedAt);
      }

      logger.debug({ rawEventId, disposition }, 'OneBot ingress claimed');
      return {
        disposition,
        rawEventId,
        ...(disposition === 'accepted' ? { acceptedAt: receivedAt } : {}),
      };
    })();
  }
}
