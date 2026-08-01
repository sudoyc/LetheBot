import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { EventIngressClaimService } from '../../../src/ingestion/event-ingress-claim.js';
import { getLogger } from '../../../src/logger/index.js';
import { initDatabase, runMigrations } from '../../../src/storage/database.js';
import type { ChatMessageReceived, GatewayCapabilities } from '../../../src/types/events.js';

const gatewayCapabilities: GatewayCapabilities = {
  platform: 'qq',
  reactions: {
    emojiLike: false,
    faceMessage: true,
  },
  foldedForward: {
    groupForward: false,
    privateForward: false,
    customNode: false,
  },
  platformAdmin: {
    kick: false,
    mute: false,
    setGroupCard: false,
  },
};

describe('EventIngressClaimService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });
    runMigrations(db, join(process.cwd(), 'migrations'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('keeps one canonical raw event and appends one receipt per delivery', () => {
    vi.spyOn(Date, 'now').mockReturnValue(12_345);
    const debugLog = vi.spyOn(getLogger(), 'debug').mockImplementation(() => undefined);
    const service = new EventIngressClaimService(db);
    const event = createPrivateEvent('event-accepted', 'qq-812349001', 'http');
    const duplicate: ChatMessageReceived = {
      ...event,
      id: 'event-duplicate',
      ingress: {
        ...event.ingress,
        transport: 'ws',
      },
      message: {
        ...event.message,
        content: {
          ...event.message.content,
          text: 'changed duplicate payload',
        },
      },
    };

    expect(service.claim(event)).toEqual({
      disposition: 'accepted',
      rawEventId: event.id,
      acceptedAt: 12_345,
    });
    expect(service.claim(duplicate)).toEqual({
      disposition: 'duplicate',
      rawEventId: event.id,
    });

    const raw = db.prepare(
      `SELECT id, payload, created_at
         FROM raw_events
        WHERE platform_event_id = ?`
    ).get(event.ingress.platformEventId) as {
      id: string;
      payload: string;
      created_at: number;
    } | undefined;
    expect(raw).toMatchObject({ id: event.id, created_at: 12_345 });
    expect((JSON.parse(raw?.payload ?? '{}') as ChatMessageReceived).message.content.text)
      .toBe('first writer payload');
    expect(db.prepare(
      `SELECT transport, disposition, received_at
         FROM event_ingress_receipts
        WHERE raw_event_id = ?
        ORDER BY transport`
    ).all(event.id)).toEqual([
      { transport: 'http', disposition: 'accepted', received_at: 12_345 },
      { transport: 'ws', disposition: 'duplicate', received_at: 12_345 },
    ]);
    expect(db.prepare(
      `SELECT state, accepted_at, processing_started_at, finished_at, reason_code
         FROM event_processing_admissions
        WHERE raw_event_id = ?`
    ).get(event.id)).toEqual({
      state: 'accepted',
      accepted_at: 12_345,
      processing_started_at: null,
      finished_at: null,
      reason_code: null,
    });
    expect(debugLog.mock.calls).toEqual([
      [{ rawEventId: event.id, disposition: 'accepted' }, 'OneBot ingress claimed'],
      [{ rawEventId: event.id, disposition: 'duplicate' }, 'OneBot ingress claimed'],
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rolls back the raw event and receipt when accepted admission creation fails', () => {
    const event = createPrivateEvent('event-rollback', 'qq-812349002', 'http');
    db.exec(`
      CREATE TEMP TRIGGER fail_direct_event_admission
      BEFORE INSERT ON event_processing_admissions
      WHEN NEW.raw_event_id = '${event.id}'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic direct admission failure');
      END;
    `);

    expect(() => new EventIngressClaimService(db).claim(event))
      .toThrow('synthetic direct admission failure');
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM raw_events WHERE id = ?) AS raw_events,
         (SELECT COUNT(*) FROM event_ingress_receipts WHERE raw_event_id = ?) AS receipts,
         (SELECT COUNT(*) FROM event_processing_admissions WHERE raw_event_id = ?) AS admissions`
    ).get(event.id, event.id, event.id)).toEqual({
      raw_events: 0,
      receipts: 0,
      admissions: 0,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});

function createPrivateEvent(
  id: string,
  platformEventId: string,
  transport: 'http' | 'ws',
): ChatMessageReceived {
  const senderId = 'qq-812349101';
  const conversationId = `private:${senderId}`;
  return {
    id,
    type: 'chat.message.received',
    timestamp: new Date('2026-07-10T04:00:00.000Z'),
    source: 'gateway',
    platform: 'qq',
    conversationId,
    ingress: {
      transport,
      platformEventId,
    },
    message: {
      messageId: platformEventId,
      conversationId,
      conversationType: 'private',
      senderId,
      content: {
        text: 'first writer payload',
        media: [],
      },
      mentions: [],
      mentionsBot: false,
    },
    gatewayCapabilities,
  };
}
