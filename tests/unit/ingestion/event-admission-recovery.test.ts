import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { EventAdmissionRecovery } from '../../../src/ingestion/event-admission-recovery.js';
import { getLogger } from '../../../src/logger/index.js';
import { initDatabase, runMigrations } from '../../../src/storage/database.js';
import { TurnRepository } from '../../../src/storage/turn-repository.js';
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

describe('EventAdmissionRecovery', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });
    runMigrations(db, join(process.cwd(), 'migrations'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('reconciles recoverable admissions and interrupts contradictory evidence directly', async () => {
    const accepted = createPrivateEvent('accepted', 'qq-812347001');
    const processing = createPrivateEvent('processing', 'qq-812347002');
    const invalid = createPrivateEvent('invalid', 'qq-812347003');
    const started = createPrivateEvent('started', 'qq-812347004');
    seedAdmission(db, accepted, { acceptedAt: 1_000, state: 'accepted' });
    seedAdmission(db, processing, { acceptedAt: 2_000, state: 'processing' });
    seedAdmission(db, invalid, {
      acceptedAt: 3_000,
      state: 'accepted',
      payload: JSON.stringify({ type: 'not-a-chat-event' }),
    });
    seedAdmission(db, started, { acceptedAt: 4_000, state: 'accepted' });

    const turns = new TurnRepository(db);
    const startedTurnId = await turns.createPending({
      conversationId: started.conversationId,
      triggerEventId: started.id,
      piModel: 'mock',
      piProvider: 'mock',
      startedAt: new Date(4_001),
    });
    const infoLog = vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);

    const recovered = new EventAdmissionRecovery(db, turns).recover();

    expect(recovered.map(({ rawEventId, acceptedAt, event }) => ({
      rawEventId,
      acceptedAt,
      timestamp: event.timestamp,
    }))).toEqual([
      { rawEventId: accepted.id, acceptedAt: 1_000, timestamp: accepted.timestamp },
      { rawEventId: processing.id, acceptedAt: 2_000, timestamp: processing.timestamp },
    ]);
    expect(readAdmission(db, accepted.id)).toEqual({
      state: 'accepted',
      processing_started_at: null,
      reason_code: null,
    });
    expect(readAdmission(db, processing.id)).toEqual({
      state: 'accepted',
      processing_started_at: null,
      reason_code: null,
    });
    expect(readAdmission(db, invalid.id)).toMatchObject({
      state: 'interrupted_review',
      processing_started_at: null,
      reason_code: 'invalid_stored_event',
    });
    expect(readAdmission(db, started.id)).toMatchObject({
      state: 'interrupted_review',
      processing_started_at: null,
      reason_code: 'started_evidence',
    });
    expect(db.prepare(
      'SELECT status, response_text, completed_at FROM agent_turns WHERE id = ?'
    ).get(startedTurnId)).toMatchObject({
      status: 'aborted',
      response_text: 'Startup admission recovery interrupted this turn',
      completed_at: expect.any(Number),
    });
    expect(infoLog).toHaveBeenCalledWith({
      acceptedForRecovery: 2,
      resetProcessing: 1,
      staleProcessing: 0,
      startedEvidence: 1,
      invalidStoredEvents: 1,
    }, 'Event admission recovery reconciled');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});

function createPrivateEvent(id: string, platformEventId: string): ChatMessageReceived {
  const senderId = `qq-812348${id.length.toString().padStart(3, '0')}`;
  const conversationId = `private:${senderId}`;
  return {
    id: `event-${id}`,
    type: 'chat.message.received',
    timestamp: new Date('2026-07-10T04:00:00.000Z'),
    source: 'gateway',
    platform: 'qq',
    conversationId,
    ingress: {
      transport: 'http',
      platformEventId,
    },
    message: {
      messageId: platformEventId,
      conversationId,
      conversationType: 'private',
      senderId,
      content: {
        text: `recover ${id}`,
        media: [],
      },
      mentions: [],
      mentionsBot: false,
    },
    gatewayCapabilities,
  };
}

function seedAdmission(
  db: Database.Database,
  event: ChatMessageReceived,
  options: {
    acceptedAt: number;
    state: 'accepted' | 'processing';
    payload?: string;
  },
): void {
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, correlation_id,
      platform_event_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    event.type,
    event.timestamp.getTime(),
    event.source,
    event.platform,
    event.conversationId,
    event.correlationId ?? null,
    event.ingress.platformEventId ?? null,
    options.payload ?? JSON.stringify(event),
    options.acceptedAt,
  );
  db.prepare(
    `INSERT INTO event_ingress_receipts (
      id, raw_event_id, transport, disposition, received_at
    ) VALUES (?, ?, ?, 'accepted', ?)`
  ).run(
    `receipt-${event.id}`,
    event.id,
    event.ingress.transport,
    options.acceptedAt,
  );
  db.prepare(
    `INSERT INTO event_processing_admissions (
      raw_event_id, state, accepted_at, processing_started_at, finished_at, reason_code
    ) VALUES (?, ?, ?, ?, NULL, NULL)`
  ).run(
    event.id,
    options.state,
    options.acceptedAt,
    options.state === 'processing' ? options.acceptedAt + 1 : null,
  );
}

function readAdmission(db: Database.Database, rawEventId: string): {
  state: string;
  processing_started_at: number | null;
  reason_code: string | null;
} | undefined {
  return db.prepare(
    `SELECT state, processing_started_at, reason_code
       FROM event_processing_admissions
      WHERE raw_event_id = ?`
  ).get(rawEventId) as {
    state: string;
    processing_started_at: number | null;
    reason_code: string | null;
  } | undefined;
}
