import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationTurnService,
  type PiRuntime,
} from '../../../src/application/conversation-turn-service.js';
import { ActionCooldownManager } from '../../../src/actions/cooldown.js';
import { ActionExecutor } from '../../../src/actions/executor.js';
import { ActionRepository } from '../../../src/actions/action-repository.js';
import { SocialDecisionService } from '../../../src/actions/social-decision-service.js';
import { AttentionEngine } from '../../../src/attention/engine.js';
import { DelayedAttentionService } from '../../../src/attention/delayed-attention-service.js';
import { ContextBuilder } from '../../../src/context/builder.js';
import { GovernanceService } from '../../../src/governance/service.js';
import { getLogger } from '../../../src/logger/index.js';
import { initDatabase, runMigrations } from '../../../src/storage/database.js';
import { ContextTraceRepository } from '../../../src/storage/context-trace-repository.js';
import { GroupSummaryPolicyRepository } from '../../../src/storage/group-summary-policy-repository.js';
import { IdentityRepository } from '../../../src/storage/identity-repository.js';
import { JobRepository } from '../../../src/storage/job-repository.js';
import { MemoryRepository } from '../../../src/storage/memory-repository.js';
import { TurnRepository } from '../../../src/storage/turn-repository.js';
import type {
  IEvaluator,
  MemoryEvaluationRequest,
  SocialEvaluationRequest,
  ToolEvaluationRequest,
} from '../../../src/types/evaluator.js';
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

describe('ConversationTurnService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });
    runMigrations(db, join(process.cwd(), 'migrations'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('persists one evidence-linked no-content event without starting a turn', async () => {
    const event = createPrivateEvent('empty');
    seedRawEvent(db, event);
    const fixture = createService(db);

    await expect(fixture.service.handleEvent(event, event.id)).resolves.toBe('completed');

    expect(db.prepare(
      `SELECT raw_event_id, message_id, conversation_id, conversation_type,
              sender_id, text, has_media, has_quote, mentions_bot
         FROM chat_messages WHERE id = ?`,
    ).get(event.id)).toEqual({
      raw_event_id: event.id,
      message_id: event.message.messageId,
      conversation_id: event.conversationId,
      conversation_type: 'private',
      sender_id: event.message.senderId,
      text: '',
      has_media: 0,
      has_quote: 0,
      mentions_bot: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_turns').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
    expect(fixture.getPiRuntime).not.toHaveBeenCalled();
    expect(fixture.getActionExecutor).not.toHaveBeenCalled();
    expect(fixture.getSocialDecisionService).not.toHaveBeenCalled();
    expect(fixture.recordEventProcessingFailure).not.toHaveBeenCalled();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('delegates the exact chat persistence failure stage without downstream work', async () => {
    const event = createPrivateEvent('chat-failure');
    seedRawEvent(db, event);
    db.exec(`
      CREATE TEMP TRIGGER fail_conversation_chat_insert
      BEFORE INSERT ON chat_messages
      WHEN NEW.raw_event_id = '${event.id}'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic conversation chat failure');
      END;
    `);
    const fixture = createService(db);

    await expect(fixture.service.handleEvent(event, event.id)).resolves.toBe('failed');

    expect(fixture.recordEventProcessingFailure).toHaveBeenCalledTimes(1);
    expect(fixture.recordEventProcessingFailure.mock.calls[0]?.[0]).toMatchObject({
      event,
      rawEventId: event.id,
      turnId: undefined,
      stage: 'chat_message_store',
      error: {
        name: 'SqliteError',
        message: 'synthetic conversation chat failure',
      },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_turns').get()).toEqual({ count: 0 });
    expect(fixture.getPiRuntime).not.toHaveBeenCalled();
    expect(fixture.getActionExecutor).not.toHaveBeenCalled();
    expect(fixture.getSocialDecisionService).not.toHaveBeenCalled();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});

function createService(db: Database.Database): {
  service: ConversationTurnService;
  getPiRuntime: ReturnType<typeof vi.fn<() => PiRuntime>>;
  getActionExecutor: ReturnType<typeof vi.fn>;
  getSocialDecisionService: ReturnType<typeof vi.fn>;
  recordEventProcessingFailure: ReturnType<typeof vi.fn>;
} {
  const memoryRepository = new MemoryRepository(db);
  const identityRepository = new IdentityRepository(db);
  const turnRepository = new TurnRepository(db);
  const actionRepository = new ActionRepository(db);
  const jobRepository = new JobRepository(db);
  const evaluator: IEvaluator = {
    async evaluateTool(_request: ToolEvaluationRequest) {
      throw new Error('Unexpected tool evaluation');
    },
    async evaluateMemory(_request: MemoryEvaluationRequest) {
      throw new Error('Unexpected memory evaluation');
    },
    async evaluateSocial(_request: SocialEvaluationRequest) {
      throw new Error('Unexpected social evaluation');
    },
  };
  const piRuntime: PiRuntime = {
    async runTurn(input) {
      return {
        turnId: input.turnId,
        responseText: '',
        toolCallIds: [],
        events: [],
        tokensUsed: { input: 0, output: 0, total: 0 },
        status: 'completed',
      };
    },
  };
  const actionExecutor = new ActionExecutor(actionRepository, {
    async sendMessage() {
      return 'synthetic-message';
    },
  });
  const socialDecisionService = new SocialDecisionService(
    actionRepository,
    evaluator,
    new ActionCooldownManager(),
  );
  const getPiRuntime = vi.fn(() => piRuntime);
  const getActionExecutor = vi.fn(() => actionExecutor);
  const getSocialDecisionService = vi.fn(() => socialDecisionService);
  const recordEventProcessingFailure = vi.fn();
  const logger = getLogger();
  vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);

  return {
    service: new ConversationTurnService({
      db,
      identityRepository,
      contextTraceRepository: new ContextTraceRepository(db),
      turnRepository,
      actionRepository,
      attentionEngine: new AttentionEngine(),
      delayedAttentionService: new DelayedAttentionService(db, jobRepository),
      contextBuilder: new ContextBuilder(memoryRepository, identityRepository, db),
      governanceService: new GovernanceService(
        db,
        memoryRepository,
        new GroupSummaryPolicyRepository(db),
      ),
      enqueueBackgroundTask: (task) => jobRepository.enqueue(task),
      piProvider: 'mock',
      piModel: 'mock',
      getPiRuntime,
      getActionExecutor,
      getSocialDecisionService,
      redactSensitiveText: (text) => text,
      recordEventProcessingFailure,
      logger,
    }),
    getPiRuntime,
    getActionExecutor,
    getSocialDecisionService,
    recordEventProcessingFailure,
  };
}

function createPrivateEvent(id: string): ChatMessageReceived {
  const senderId = `qq-812352${id.length.toString().padStart(3, '0')}`;
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
      platformEventId: `qq-812353${id.length.toString().padStart(3, '0')}`,
    },
    message: {
      messageId: `qq-812353${id.length.toString().padStart(3, '0')}`,
      conversationId,
      conversationType: 'private',
      senderId,
      content: {
        text: '',
        media: [],
      },
      mentions: [],
      mentionsBot: false,
    },
    gatewayCapabilities,
  };
}

function seedRawEvent(db: Database.Database, event: ChatMessageReceived): void {
  db.prepare(
    `INSERT INTO raw_events (
      id, type, timestamp, source, platform, conversation_id, correlation_id,
      platform_event_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    event.timestamp.getTime(),
  );
}
