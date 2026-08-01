import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnApplicationService } from '../../../src/application/turn-application-service.js';
import { TurnAdmissionController } from '../../../src/pi/turn-admission-controller.js';
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

describe('TurnApplicationService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });
    runMigrations(db, join(process.cwd(), 'migrations'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('tracks pending work and transitions an accepted event through completion', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_100);
    const event = createPrivateEvent('completed', 'qq-812350001');
    seedAcceptedAdmission(db, event, 1_000);
    const handlerStarted = deferred();
    const releaseHandler = deferred();
    const handleEvent = vi.fn(async () => {
      handlerStarted.resolve();
      await releaseHandler.promise;
      return 'completed' as const;
    });
    const onFailurePersistenceError = vi.fn();
    const onTaskFailure = vi.fn();
    const service = new TurnApplicationService(db, new TurnAdmissionController(1), {
      turnTimeoutMs: 500,
      handleEvent,
      redactSensitiveText: (text) => text,
      onFailurePersistenceError,
      onTaskFailure,
    });

    service.enqueue(event, event.id, 1_000);
    expect(service.pendingCount).toBe(1);
    await handlerStarted.promise;

    expect(handleEvent).toHaveBeenCalledWith(event, event.id, { deadlineAtMs: 1_500 });
    expect(readAdmission(db, event.id)).toEqual({
      state: 'processing',
      accepted_at: 1_000,
      processing_started_at: 1_100,
      finished_at: null,
      reason_code: null,
    });

    releaseHandler.resolve();
    await service.waitForIdle();

    expect(service.pendingCount).toBe(0);
    expect(readAdmission(db, event.id)).toEqual({
      state: 'completed',
      accepted_at: 1_000,
      processing_started_at: 1_100,
      finished_at: 1_100,
      reason_code: null,
    });
    expect(service.failureCount).toBe(0);
    expect(service.getEventProcessingFailures()).toHaveLength(0);
    expect(onFailurePersistenceError).not.toHaveBeenCalled();
    expect(onTaskFailure).not.toHaveBeenCalled();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('maps a failed handler outcome and leaves a lost start compare-and-set inert', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_100);
    const failed = createPrivateEvent('failed', 'qq-812350002');
    const alreadyCompleted = createPrivateEvent('already-completed', 'qq-812350003');
    seedAcceptedAdmission(db, failed, 2_000);
    seedAcceptedAdmission(db, alreadyCompleted, 2_000);
    db.prepare(
      `UPDATE event_processing_admissions
          SET state = 'completed', processing_started_at = 2_050, finished_at = 2_075
        WHERE raw_event_id = ?`
    ).run(alreadyCompleted.id);
    const handleEvent = vi.fn(async () => 'failed' as const);
    const onTaskFailure = vi.fn();
    const service = new TurnApplicationService(db, new TurnAdmissionController(1), {
      turnTimeoutMs: 500,
      handleEvent,
      redactSensitiveText: (text) => text,
      onFailurePersistenceError: vi.fn(),
      onTaskFailure,
    });

    service.enqueue(failed, failed.id, 2_000);
    service.enqueue(alreadyCompleted, alreadyCompleted.id, 2_000);
    await service.waitForIdle();

    expect(handleEvent).toHaveBeenCalledTimes(1);
    expect(handleEvent).toHaveBeenCalledWith(failed, failed.id, { deadlineAtMs: 2_500 });
    expect(readAdmission(db, failed.id)).toMatchObject({
      state: 'failed',
      processing_started_at: 2_100,
      finished_at: 2_100,
      reason_code: 'handler_failed',
    });
    expect(readAdmission(db, alreadyCompleted.id)).toMatchObject({
      state: 'completed',
      processing_started_at: 2_050,
      finished_at: 2_075,
      reason_code: null,
    });
    expect(onTaskFailure).not.toHaveBeenCalled();
  });

  it('routes overload and execution-time expiry without invoking their handlers', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_100);
    const active = createPrivateEvent('active', 'qq-812350004');
    const overloaded = createPrivateEvent('overloaded', 'qq-812350005');
    const expired = createPrivateEvent('expired', 'qq-812350006');
    seedAcceptedAdmission(db, active, 3_000);
    seedAcceptedAdmission(db, overloaded, 3_000);
    seedAcceptedAdmission(db, expired, 3_000);
    const activeStarted = deferred();
    const releaseActive = deferred();
    const handleEvent = vi.fn(async (_event: ChatMessageReceived, rawEventId: string) => {
      if (rawEventId === active.id) {
        activeStarted.resolve();
        await releaseActive.promise;
      }
      return 'completed' as const;
    });
    const onFailurePersistenceError = vi.fn();
    const onTaskFailure = vi.fn();
    const service = new TurnApplicationService(db, new TurnAdmissionController(1, 0), {
      turnTimeoutMs: 500,
      handleEvent,
      redactSensitiveText: (text) => text,
      onFailurePersistenceError,
      onTaskFailure,
    });

    service.enqueue(active, active.id, 3_000);
    await activeStarted.promise;
    service.enqueue(overloaded, overloaded.id, 3_000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(handleEvent).toHaveBeenCalledTimes(1);
    expect(service.pendingCount).toBe(1);
    expect(service.getEventProcessingFailures()).toEqual([{
      eventId: overloaded.id,
      messageId: overloaded.message.messageId,
      conversationId: overloaded.conversationId,
      errorMessage: 'Turn admission queue is full (limit 0)',
    }]);
    expect(readAdmission(db, overloaded.id)).toEqual({
      state: 'failed',
      accepted_at: 3_000,
      processing_started_at: 3_100,
      finished_at: 3_100,
      reason_code: 'handler_failed',
    });
    expect(readFailure(db, overloaded.id)).toMatchObject({
      occurred_at: 3_100,
      stage: 'turn_admission_overloaded',
      conversation_type: 'private',
      error_name: 'TurnAdmissionOverloadedError',
      error_message_hash: sha256('Turn admission queue is full (limit 0)'),
      message_id_hash: sha256(overloaded.message.messageId),
      sender_id_hash: sha256(overloaded.message.senderId),
      conversation_id_hash: sha256(overloaded.conversationId),
    });
    expect(JSON.parse(readFailure(db, overloaded.id)?.details ?? '{}')).toEqual({
      redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error',
      rawEventStored: true,
      turnStarted: false,
      stage: 'turn_admission_overloaded',
      conversationType: 'private',
      outcomeCode: 'overloaded',
      error: {
        name: 'TurnAdmissionOverloadedError',
        messageHash: sha256('Turn admission queue is full (limit 0)'),
      },
      hashes: {
        messageId: sha256(overloaded.message.messageId),
        senderId: sha256(overloaded.message.senderId),
        conversationId: sha256(overloaded.conversationId),
      },
    });

    releaseActive.resolve();
    await service.waitForIdle();

    const expiryService = new TurnApplicationService(
      db,
      new TurnAdmissionController(1, 1, { now: () => 3_499 }),
      {
        turnTimeoutMs: 500,
        handleEvent,
        redactSensitiveText: (text) => text,
        onFailurePersistenceError,
        onTaskFailure,
      },
    );
    vi.mocked(Date.now).mockReturnValue(3_500);
    expiryService.enqueue(expired, expired.id, 3_000);
    await expiryService.waitForIdle();

    expect(handleEvent).toHaveBeenCalledTimes(1);
    expect(expiryService.getEventProcessingFailures()).toEqual([{
      eventId: expired.id,
      messageId: expired.message.messageId,
      conversationId: expired.conversationId,
      errorMessage: 'Turn admission deadline expired before execution at 3500',
    }]);
    expect(readAdmission(db, expired.id)).toEqual({
      state: 'failed',
      accepted_at: 3_000,
      processing_started_at: 3_500,
      finished_at: 3_500,
      reason_code: 'handler_failed',
    });
    expect(readFailure(db, expired.id)).toMatchObject({
      occurred_at: 3_500,
      stage: 'turn_admission_queue_timeout',
      error_name: 'TurnAdmissionQueueTimeoutError',
    });
    expect(JSON.parse(readFailure(db, expired.id)?.details ?? '{}')).toMatchObject({
      outcomeCode: 'queue_timeout',
    });
    expect(onFailurePersistenceError).not.toHaveBeenCalled();
    expect(onTaskFailure).not.toHaveBeenCalled();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('reports a lost terminal compare-and-set after removing the pending task', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(4_100);
    const event = createPrivateEvent('terminal-race', 'qq-812350007');
    seedAcceptedAdmission(db, event, 4_000);
    const onTaskFailure = vi.fn();
    const service = new TurnApplicationService(db, new TurnAdmissionController(1), {
      turnTimeoutMs: 500,
      handleEvent: async () => {
        db.prepare(
          `UPDATE event_processing_admissions
              SET state = 'failed', finished_at = 4_101, reason_code = 'handler_failed'
            WHERE raw_event_id = ? AND state = 'processing'`
        ).run(event.id);
        return 'completed';
      },
      redactSensitiveText: (text) => text,
      onFailurePersistenceError: vi.fn(),
      onTaskFailure,
    });

    service.enqueue(event, event.id, 4_000);
    await service.waitForIdle();

    expect(service.pendingCount).toBe(0);
    expect(onTaskFailure).toHaveBeenCalledTimes(1);
    expect(onTaskFailure.mock.calls[0]?.[0]).toEqual(
      new Error('Unable to terminalize event processing admission'),
    );
    expect(readAdmission(db, event.id)).toMatchObject({
      state: 'failed',
      finished_at: 4_101,
      reason_code: 'handler_failed',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('records redacted in-memory and hashes-only durable handler failure evidence', () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_100);
    const event = createPrivateEvent('handler-evidence', 'qq-812350008');
    seedAcceptedAdmission(db, event, 5_000);
    const onFailurePersistenceError = vi.fn();
    const service = new TurnApplicationService(db, new TurnAdmissionController(1), {
      turnTimeoutMs: 500,
      handleEvent: async () => 'completed',
      redactSensitiveText: (text) => text.replace('secret', '[REDACTED]'),
      onFailurePersistenceError,
      onTaskFailure: vi.fn(),
    });

    service.recordEventProcessingFailure({
      event,
      rawEventId: event.id,
      stage: 'pi_inference',
      error: new Error('provider secret'),
      outcomeCode: 'deadline_exceeded',
    });

    expect(service.failureCount).toBe(1);
    expect(service.getEventProcessingFailures()).toEqual([{
      eventId: event.id,
      messageId: event.message.messageId,
      conversationId: event.conversationId,
      errorMessage: 'provider [REDACTED]',
    }]);
    expect(readFailure(db, event.id)).toMatchObject({
      raw_event_id: event.id,
      turn_id: null,
      occurred_at: 5_100,
      stage: 'pi_inference',
      conversation_type: 'private',
      error_name: 'Error',
      error_message_hash: sha256('provider secret'),
      message_id_hash: sha256(event.message.messageId),
      sender_id_hash: sha256(event.message.senderId),
      conversation_id_hash: sha256(event.conversationId),
    });
    expect(JSON.parse(readFailure(db, event.id)?.details ?? '{}')).toEqual({
      redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error',
      rawEventStored: true,
      turnStarted: false,
      stage: 'pi_inference',
      conversationType: 'private',
      outcomeCode: 'deadline_exceeded',
      error: {
        name: 'Error',
        messageHash: sha256('provider secret'),
      },
      hashes: {
        messageId: sha256(event.message.messageId),
        senderId: sha256(event.message.senderId),
        conversationId: sha256(event.conversationId),
      },
    });
    expect(onFailurePersistenceError).not.toHaveBeenCalled();

    service.clearEventProcessingFailuresForTesting();
    expect(service.failureCount).toBe(0);
    expect(service.getEventProcessingFailures()).toHaveLength(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('retains the projection when generic failure persistence is unavailable', () => {
    vi.spyOn(Date, 'now').mockReturnValue(6_100);
    const event = createPrivateEvent('handler-insert-failure', 'qq-812350009');
    seedAcceptedAdmission(db, event, 6_000);
    db.exec(`
      CREATE TEMP TRIGGER fail_event_processing_failure_insert
      BEFORE INSERT ON event_processing_failures
      BEGIN
        SELECT RAISE(ABORT, 'synthetic failure evidence insert failure');
      END;
    `);
    const observedFailureCounts: number[] = [];
    let service!: TurnApplicationService;
    const onFailurePersistenceError = vi.fn(() => {
      observedFailureCounts.push(service.failureCount);
    });
    service = new TurnApplicationService(db, new TurnAdmissionController(1), {
      turnTimeoutMs: 500,
      handleEvent: async () => 'completed',
      redactSensitiveText: (text) => text.replace('secret', '[REDACTED]'),
      onFailurePersistenceError,
      onTaskFailure: vi.fn(),
    });

    expect(() => service.recordEventProcessingFailure({
      event,
      rawEventId: event.id,
      stage: 'context_building',
      error: new Error('context secret'),
    })).not.toThrow();

    expect(service.getEventProcessingFailures()).toEqual([{
      eventId: event.id,
      messageId: event.message.messageId,
      conversationId: event.conversationId,
      errorMessage: 'context [REDACTED]',
    }]);
    expect(observedFailureCounts).toEqual([1]);
    expect(onFailurePersistenceError).toHaveBeenCalledTimes(1);
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM event_processing_failures WHERE raw_event_id = ?',
    ).get(event.id)).toEqual({ count: 0 });
    expect(readAdmission(db, event.id)?.state).toBe('accepted');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('keeps lost rejection terminalization inert and rolls back a failed evidence insert', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(7_100);
    const active = createPrivateEvent('rejection-active', 'qq-812350010');
    const lost = createPrivateEvent('rejection-lost', 'qq-812350011');
    const rollback = createPrivateEvent('rejection-rollback', 'qq-812350012');
    seedAcceptedAdmission(db, active, 7_000);
    seedAcceptedAdmission(db, lost, 7_000);
    seedAcceptedAdmission(db, rollback, 7_000);
    db.prepare(
      `UPDATE event_processing_admissions
          SET state = 'completed', processing_started_at = 7_050, finished_at = 7_075
        WHERE raw_event_id = ?`,
    ).run(lost.id);
    db.exec(`
      CREATE TEMP TRIGGER fail_rejection_failure_insert
      BEFORE INSERT ON event_processing_failures
      WHEN NEW.raw_event_id = '${rollback.id}'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic rejection evidence insert failure');
      END;
    `);
    const activeStarted = deferred();
    const releaseActive = deferred();
    const onTaskFailure = vi.fn();
    const service = new TurnApplicationService(db, new TurnAdmissionController(1, 0), {
      turnTimeoutMs: 500,
      handleEvent: async (_event, rawEventId) => {
        if (rawEventId === active.id) {
          activeStarted.resolve();
          await releaseActive.promise;
        }
        return 'completed';
      },
      redactSensitiveText: (text) => text,
      onFailurePersistenceError: vi.fn(),
      onTaskFailure,
    });

    service.enqueue(active, active.id, 7_000);
    await activeStarted.promise;
    service.enqueue(lost, lost.id, 7_000);
    service.enqueue(rollback, rollback.id, 7_000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(readAdmission(db, lost.id)).toMatchObject({
      state: 'completed',
      processing_started_at: 7_050,
      finished_at: 7_075,
      reason_code: null,
    });
    expect(readAdmission(db, rollback.id)).toMatchObject({
      state: 'accepted',
      processing_started_at: null,
      finished_at: null,
      reason_code: null,
    });
    expect(service.getEventProcessingFailures()).toHaveLength(0);
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM event_processing_failures WHERE raw_event_id IN (?, ?)',
    ).get(lost.id, rollback.id)).toEqual({ count: 0 });
    expect(onTaskFailure).toHaveBeenCalledTimes(1);
    expect(onTaskFailure.mock.calls[0]?.[0]).toMatchObject({ name: 'SqliteError' });

    releaseActive.resolve();
    await service.waitForIdle();
    expect(readAdmission(db, active.id)?.state).toBe('completed');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createPrivateEvent(id: string, platformEventId: string): ChatMessageReceived {
  const senderId = `qq-812351${id.length.toString().padStart(3, '0')}`;
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
        text: `turn application ${id}`,
        media: [],
      },
      mentions: [],
      mentionsBot: false,
    },
    gatewayCapabilities,
  };
}

function seedAcceptedAdmission(
  db: Database.Database,
  event: ChatMessageReceived,
  acceptedAt: number,
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
    JSON.stringify(event),
    acceptedAt,
  );
  db.prepare(
    `INSERT INTO event_processing_admissions (
      raw_event_id, state, accepted_at, processing_started_at, finished_at, reason_code
    ) VALUES (?, 'accepted', ?, NULL, NULL, NULL)`
  ).run(event.id, acceptedAt);
}

function readAdmission(db: Database.Database, rawEventId: string): {
  state: string;
  accepted_at: number;
  processing_started_at: number | null;
  finished_at: number | null;
  reason_code: string | null;
} | undefined {
  return db.prepare(
    `SELECT state, accepted_at, processing_started_at, finished_at, reason_code
       FROM event_processing_admissions
      WHERE raw_event_id = ?`
  ).get(rawEventId) as {
    state: string;
    accepted_at: number;
    processing_started_at: number | null;
    finished_at: number | null;
    reason_code: string | null;
  } | undefined;
}

function readFailure(db: Database.Database, rawEventId: string): {
  raw_event_id: string | null;
  turn_id: string | null;
  occurred_at: number;
  stage: string;
  conversation_type: string | null;
  error_name: string;
  error_message_hash: string;
  message_id_hash: string | null;
  sender_id_hash: string | null;
  conversation_id_hash: string | null;
  details: string;
} | undefined {
  return db.prepare(
    `SELECT raw_event_id, turn_id, occurred_at, stage, conversation_type,
            error_name, error_message_hash, message_id_hash, sender_id_hash,
            conversation_id_hash, details
       FROM event_processing_failures
      WHERE raw_event_id = ?`,
  ).get(rawEventId) as {
    raw_event_id: string | null;
    turn_id: string | null;
    occurred_at: number;
    stage: string;
    conversation_type: string | null;
    error_name: string;
    error_message_hash: string;
    message_id_hash: string | null;
    sender_id_hash: string | null;
    conversation_id_hash: string | null;
    details: string;
  } | undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
