import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LetheBotApp } from '../../src/index.js';
import { resetConfig } from '../../src/config/index.js';
import type { OneBotMessage } from '../../src/gateway/onebot-adapter.js';
import type { PiAdapterInput, PiAdapterOutput } from '../../src/pi/pi-adapter.js';
import { GovernanceCLI } from '../../src/cli/governance.js';
import { initDatabase } from '../../src/storage/database.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';
import type { ChatMessageReceived, GatewayCapabilities } from '../../src/types/events.js';

interface AdmissionRow {
  state: string;
  processing_started_at: number | null;
  finished_at: number | null;
  reason_code: string | null;
}

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

describe('accepted event admission recovery', () => {
  const originalEnv = process.env;
  let testDir: string;
  let dbPath: string;
  let nextPort: number;
  const apps: LetheBotApp[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-ingress-recovery-'));
    dbPath = join(testDir, 'lethebot.db');
    nextPort = 18700 + Math.floor(Math.random() * 500);
  });

  afterEach(async () => {
    for (const app of apps.splice(0).reverse()) {
      await app.stop();
    }
    rmSync(testDir, { recursive: true, force: true });
    process.env = originalEnv;
    resetConfig();
  });

  function createApp(): LetheBotApp {
    process.env.LETHEBOT_TEST = 'true';
    process.env.LETHEBOT_DB_PATH = dbPath;
    process.env.LETHEBOT_PORT = String(nextPort++);
    process.env.LETHEBOT_HOST = '127.0.0.1';
    process.env.ONEBOT_TRANSPORT = 'http';
    process.env.ONEBOT_HTTP_URL = 'http://127.0.0.1:3000';
    process.env.ONEBOT_TOKEN = 'synthetic-test-token';
    process.env.LETHEBOT_BOT_QQ_ID = '3889000770';
    process.env.PI_PROVIDER = 'mock';
    process.env.PI_MODEL = 'mock';
    process.env.LOG_LEVEL = 'fatal';
    resetConfig();

    const app = new LetheBotApp();
    apps.push(app);
    return app;
  }

  function createPrivateEvent(input: {
    id: string;
    platformEventId: string;
    senderId: string;
    text?: string;
  }): ChatMessageReceived {
    const senderId = `qq-${input.senderId}`;
    const conversationId = `private:${senderId}`;
    return {
      id: input.id,
      type: 'chat.message.received',
      timestamp: new Date('2026-07-10T04:00:00.000Z'),
      source: 'gateway',
      platform: 'qq',
      conversationId,
      ingress: {
        transport: 'http',
        platformEventId: input.platformEventId,
      },
      message: {
        messageId: input.platformEventId,
        conversationId,
        conversationType: 'private',
        senderId,
        content: {
          text: input.text ?? 'recover this accepted event',
          media: [],
        },
        mentions: [],
        mentionsBot: false,
      },
      gatewayCapabilities,
    };
  }

  function createSilentGroupEvent(input: {
    id: string;
    platformEventId: string;
    senderId: string;
    groupId: string;
  }): ChatMessageReceived {
    const groupId = `qq-group-${input.groupId}`;
    return {
      id: input.id,
      type: 'chat.message.received',
      timestamp: new Date('2026-07-10T04:00:00.000Z'),
      source: 'gateway',
      platform: 'qq',
      conversationId: groupId,
      ingress: {
        transport: 'ws',
        platformEventId: input.platformEventId,
      },
      message: {
        messageId: input.platformEventId,
        conversationId: groupId,
        conversationType: 'group',
        groupId,
        senderId: `qq-${input.senderId}`,
        senderRole: 'member',
        content: {
          text: 'ok',
          media: [],
        },
        mentions: [],
        mentionsBot: false,
      },
      gatewayCapabilities,
    };
  }

  function seedRawEvent(
    app: LetheBotApp,
    event: ChatMessageReceived,
    options: {
      state?: 'accepted' | 'processing';
      payload?: string;
      withAdmission?: boolean;
    } = {},
  ): void {
    const db = app.getDatabase();
    const acceptedAt = Date.now();
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
      acceptedAt,
    );
    db.prepare(
      `INSERT INTO event_ingress_receipts (
        id, raw_event_id, transport, disposition, received_at
      ) VALUES (?, ?, ?, 'accepted', ?)`
    ).run(`receipt-${event.id}`, event.id, event.ingress.transport, acceptedAt);

    if (options.withAdmission === false) {
      return;
    }

    const state = options.state ?? 'accepted';
    db.prepare(
      `INSERT INTO event_processing_admissions (
        raw_event_id, state, accepted_at, processing_started_at, finished_at, reason_code
      ) VALUES (?, ?, ?, ?, NULL, NULL)`
    ).run(event.id, state, acceptedAt, state === 'processing' ? acceptedAt : null);
  }

  function setReplyingRuntime(
    app: LetheBotApp,
    onCall: (input: PiAdapterInput) => void,
  ): void {
    app.setPiRuntimeForTesting({
      async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
        onCall(input);
        return {
          turnId: input.turnId,
          responseText: 'recovered reply',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 3, output: 2, total: 5 },
          status: 'completed',
        };
      },
    });
  }

  function getAdmission(app: LetheBotApp, rawEventId: string): AdmissionRow | undefined {
    return app.getDatabase().prepare(
      `SELECT state, processing_started_at, finished_at, reason_code
         FROM event_processing_admissions
        WHERE raw_event_id = ?`
    ).get(rawEventId) as AdmissionRow | undefined;
  }

  it('replays one valid accepted event on startup and remains inert after restart and duplicate delivery', async () => {
    const firstApp = createApp();
    const event = createPrivateEvent({
      id: 'evt-recovery-valid',
      platformEventId: 'qq-812346001',
      senderId: '812346101',
    });
    seedRawEvent(firstApp, event);

    let piCalls = 0;
    let sendCalls = 0;
    setReplyingRuntime(firstApp, (input) => {
      piCalls += 1;
      expect(input.contextPack.recentMessages[0]?.timestamp).toBeInstanceOf(Date);
    });
    firstApp.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        sendCalls += 1;
        return 'qq-bot-recovered-1';
      },
    });

    await firstApp.start();
    await firstApp.waitForIdle();

    expect(piCalls).toBe(1);
    expect(sendCalls).toBe(1);
    expect(getAdmission(firstApp, event.id)).toMatchObject({
      state: 'completed',
      processing_started_at: expect.any(Number),
      finished_at: expect.any(Number),
      reason_code: null,
    });
    expect(firstApp.getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM chat_messages WHERE raw_event_id = ?'
    ).get(event.id)).toEqual({ count: 1 });
    expect(firstApp.getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM agent_turns WHERE trigger_event_id = ?'
    ).get(event.id)).toEqual({ count: 1 });
    expect(firstApp.getDatabase().prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

    await firstApp.stop();
    const secondApp = createApp();
    let replayPiCalls = 0;
    let replaySendCalls = 0;
    setReplyingRuntime(secondApp, () => {
      replayPiCalls += 1;
    });
    secondApp.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        replaySendCalls += 1;
        return 'qq-bot-should-not-send';
      },
    });

    await secondApp.start();
    const duplicate: OneBotMessage = {
      post_type: 'message',
      message_type: 'private',
      message_id: 812346001,
      user_id: 812346101,
      message: 'duplicate after restart',
      raw_message: 'duplicate after restart',
      sender: { user_id: 812346101 },
      time: Math.floor(Date.now() / 1000),
    };
    expect(secondApp.dispatchOneBotEventForTesting(duplicate, 'ws')).toBe('duplicate');
    await secondApp.waitForIdle();

    expect(replayPiCalls).toBe(0);
    expect(replaySendCalls).toBe(0);
    expect(secondApp.getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM event_processing_admissions WHERE raw_event_id = ?'
    ).get(event.id)).toEqual({ count: 1 });
    expect(secondApp.getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM event_ingress_receipts WHERE raw_event_id = ?'
    ).get(event.id)).toEqual({ count: 2 });
    expect(secondApp.getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM agent_turns WHERE trigger_event_id = ?'
    ).get(event.id)).toEqual({ count: 1 });
    expect(secondApp.getDatabase().prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('REL-MEM-02 recalls approved same-group memory after a fresh application restart', async () => {
    const sourceApp = createApp();
    let sourcePiCalls = 0;
    let sourceSendCalls = 0;
    setReplyingRuntime(sourceApp, () => {
      sourcePiCalls += 1;
    });
    sourceApp.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        sourceSendCalls += 1;
        return 'qq-bot-unexpected-source-reply';
      },
    });
    await sourceApp.start();

    const sourceEvent: OneBotMessage = {
      post_type: 'message',
      message_type: 'group',
      message_id: 812346020,
      user_id: 812346120,
      group_id: 712346220,
      message: '我喜欢 合成持久偏好',
      raw_message: '我喜欢 合成持久偏好',
      sender: {
        user_id: 812346120,
        nickname: 'SyntheticRestartUser',
        role: 'member',
      },
      time: Math.floor(Date.now() / 1000),
    };
    expect(sourceApp.dispatchOneBotEventForTesting(sourceEvent, 'http')).toBe('accepted');
    await sourceApp.waitForIdle();

    const sourceDb = sourceApp.getDatabase();
    const source = sourceDb.prepare(
      `SELECT re.id AS raw_event_id,
              cm.id AS chat_message_id,
              cm.conversation_id,
              cm.group_id,
              pa.canonical_user_id
         FROM raw_events AS re
         JOIN chat_messages AS cm ON cm.raw_event_id = re.id
         JOIN platform_accounts AS pa
           ON pa.platform = 'qq' AND pa.platform_account_id = ?
        WHERE re.platform_event_id = ?`,
    ).get('812346120', 'qq-812346020') as {
      raw_event_id: string;
      chat_message_id: string;
      conversation_id: string;
      group_id: string;
      canonical_user_id: string;
    } | undefined;
    expect(source).toMatchObject({
      conversation_id: 'qq-group-712346220',
      group_id: 'qq-group-712346220',
      canonical_user_id: expect.any(String),
    });
    if (!source) {
      throw new Error('Expected the persisted restart-recall source');
    }
    expect(getAdmission(sourceApp, source.raw_event_id)).toMatchObject({
      state: 'completed',
      reason_code: null,
    });
    const extractionJob = sourceDb.prepare(
      `SELECT id, status, attempts, payload
         FROM jobs
        WHERE type = 'extraction'
          AND json_extract(payload, '$.sourceChatMessageId') = ?`,
    ).get(source.chat_message_id) as {
      id: string;
      status: string;
      attempts: number;
      payload: string;
    } | undefined;
    expect(extractionJob).toMatchObject({ status: 'pending', attempts: 0 });
    if (!extractionJob) {
      throw new Error('Expected the restart-recall extraction job');
    }
    expect(JSON.parse(extractionJob.payload)).toEqual({
      sourceChatMessageId: source.chat_message_id,
      targetUserId: source.canonical_user_id,
    });
    expect(sourcePiCalls).toBe(0);
    expect(sourceSendCalls).toBe(0);
    expect(sourceDb.prepare(
      'SELECT COUNT(*) AS count FROM agent_turns WHERE trigger_event_id = ?',
    ).get(source.raw_event_id)).toEqual({ count: 0 });

    const extractionResult = await sourceApp.processNextBackgroundJobForTesting(
      undefined,
      ['extraction'],
    );
    expect(extractionResult).toMatchObject({
      taskId: extractionJob.id,
      status: 'completed',
      output: { matched: true, count: 1 },
    });
    const extractionOutput = extractionResult?.output as { memoryIds?: string[] } | undefined;
    const memoryId = extractionOutput?.memoryIds?.[0];
    expect(memoryId).toMatch(/^extraction-v1-[a-f0-9]{64}$/);
    if (!memoryId) {
      throw new Error('Expected the restart-recall memory');
    }

    const governance = new GovernanceCLI(new MemoryRepository(sourceDb), { db: sourceDb });
    await expect(governance.approveMemory(memoryId)).resolves.toMatchObject({ success: true });
    expect(sourceDb.prepare(
      'SELECT state FROM memory_records WHERE id = ?',
    ).get(memoryId)).toEqual({ state: 'active' });
    expect(sourceDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

    await sourceApp.stop();
    const restartedApp = createApp();
    const capturedInputs: PiAdapterInput[] = [];
    let restartedSendCalls = 0;
    setReplyingRuntime(restartedApp, (input) => {
      capturedInputs.push(input);
    });
    restartedApp.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        restartedSendCalls += 1;
        return `qq-bot-restart-recall-${restartedSendCalls}`;
      },
    });
    await restartedApp.start();

    const recallEvents: OneBotMessage[] = [
      {
        post_type: 'message',
        message_type: 'group',
        message_id: 812346021,
        user_id: 812346120,
        group_id: 712346220,
        message: '[CQ:at,qq=3889000770] 回忆这个偏好',
        raw_message: '[CQ:at,qq=3889000770] 回忆这个偏好',
        sender: { user_id: 812346120, nickname: 'SyntheticRestartUser', role: 'member' },
        time: Math.floor(Date.now() / 1000) + 1,
      },
      {
        post_type: 'message',
        message_type: 'group',
        message_id: 812346022,
        user_id: 812346120,
        group_id: 712346221,
        message: '[CQ:at,qq=3889000770] 回忆这个偏好',
        raw_message: '[CQ:at,qq=3889000770] 回忆这个偏好',
        sender: { user_id: 812346120, nickname: 'SyntheticRestartUser', role: 'member' },
        time: Math.floor(Date.now() / 1000) + 2,
      },
      {
        post_type: 'message',
        message_type: 'private',
        message_id: 812346023,
        user_id: 812346120,
        message: '回忆这个偏好',
        raw_message: '回忆这个偏好',
        sender: { user_id: 812346120, nickname: 'SyntheticRestartUser' },
        time: Math.floor(Date.now() / 1000) + 3,
      },
    ];
    for (const recallEvent of recallEvents) {
      expect(restartedApp.dispatchOneBotEventForTesting(recallEvent, 'http')).toBe('accepted');
      await restartedApp.waitForIdle();
    }

    expect(capturedInputs).toHaveLength(3);
    expect(restartedSendCalls).toBe(3);
    const sourceGroupInput = capturedInputs.find(
      (input) => input.contextPack.conversation.conversationId === 'qq-group-712346220',
    );
    const otherGroupInput = capturedInputs.find(
      (input) => input.contextPack.conversation.conversationId === 'qq-group-712346221',
    );
    const privateInput = capturedInputs.find(
      (input) => input.contextPack.conversation.conversationId === 'private:qq-812346120',
    );
    expect(sourceGroupInput?.contextPack.memory.selectedMemoryIds).toEqual([memoryId]);
    expect(sourceGroupInput?.contextPack.memory.retrievedFacts.map((fact) => fact.content))
      .toContain('我喜欢 合成持久偏好');
    expect(sourceGroupInput?.contextPack.trace).toMatchObject({
      candidateMemoryIds: [memoryId],
      selectedMemoryIds: [memoryId],
      rejectedMemories: [],
    });
    for (const incompatibleInput of [otherGroupInput, privateInput]) {
      expect(incompatibleInput?.contextPack.memory.selectedMemoryIds).toEqual([]);
      expect(incompatibleInput?.contextPack.memory.retrievedFacts.map((fact) => fact.content))
        .not.toContain('我喜欢 合成持久偏好');
      expect(incompatibleInput?.contextPack.trace).toMatchObject({
        candidateMemoryIds: [memoryId],
        selectedMemoryIds: [],
        rejectedMemories: [{ memoryId, reason: 'not_same_group_context' }],
      });
    }

    const restartedDb = restartedApp.getDatabase();
    expect(restartedDb.prepare(
      `SELECT scope, canonical_user_id, group_id, conversation_id,
              visibility, source_context, state, content
         FROM memory_records
        WHERE id = ?`,
    ).get(memoryId)).toEqual({
      scope: 'user',
      canonical_user_id: source.canonical_user_id,
      group_id: 'qq-group-712346220',
      conversation_id: 'qq-group-712346220',
      visibility: 'same_group_only',
      source_context: 'group_chat',
      state: 'active',
      content: '我喜欢 合成持久偏好',
    });
    expect(restartedDb.prepare(
      `SELECT ms.source_type, ms.source_id, ms.extracted_by, ms.resolution_state,
              ms.chat_message_id, cm.raw_event_id AS source_raw_event_id
         FROM memory_sources AS ms
         JOIN chat_messages AS cm ON cm.id = ms.chat_message_id
        WHERE ms.memory_id = ?`,
    ).all(memoryId)).toEqual([{
      source_type: 'chat_message',
      source_id: source.chat_message_id,
      extracted_by: 'worker',
      resolution_state: 'internal',
      chat_message_id: source.chat_message_id,
      source_raw_event_id: source.raw_event_id,
    }]);
    expect(restartedDb.prepare(
      `SELECT revision_number, change_type, actor
         FROM memory_revisions
        WHERE memory_id = ?
        ORDER BY revision_number`,
    ).all(memoryId)).toEqual([
      { revision_number: 1, change_type: 'create', actor: source.canonical_user_id },
      { revision_number: 2, change_type: 'approve', actor: 'admin' },
    ]);
    expect(restartedDb.prepare(
      `SELECT event_type, actor_class, invocation_context
         FROM audit_log
        WHERE event_id = ? AND event_type IN ('memory.create', 'memory.approve')
        ORDER BY CASE event_type
          WHEN 'memory.create' THEN 1
          WHEN 'memory.approve' THEN 2
        END`,
    ).all(memoryId)).toEqual([
      {
        event_type: 'memory.create',
        actor_class: 'system_worker',
        invocation_context: 'background_worker',
      },
      {
        event_type: 'memory.approve',
        actor_class: 'admin',
        invocation_context: 'admin_cli',
      },
    ]);
    expect(restartedDb.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_records WHERE id = ?) AS memories,
         (SELECT COUNT(*) FROM memory_sources WHERE memory_id = ?) AS sources,
         (SELECT COUNT(*) FROM memory_revisions WHERE memory_id = ?) AS revisions,
         (SELECT COUNT(*) FROM audit_log WHERE event_id = ?
           AND event_type IN ('memory.create', 'memory.approve')) AS audits`,
    ).get(memoryId, memoryId, memoryId, memoryId)).toEqual({
      memories: 1,
      sources: 1,
      revisions: 2,
      audits: 2,
    });
    expect(restartedDb.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(restartedDb.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('replays one valid evidence-empty processing admission once and remains inert after restart', async () => {
    const firstApp = createApp();
    const event = createPrivateEvent({
      id: 'evt-recovery-empty-processing',
      platformEventId: 'qq-812346013',
      senderId: '812346113',
      text: '我喜欢 合成恢复测试',
    });
    seedRawEvent(firstApp, event, { state: 'processing' });

    const db = firstApp.getDatabase();
    const acceptedAt = db.prepare(
      'SELECT accepted_at FROM event_processing_admissions WHERE raw_event_id = ?'
    ).get(event.id) as { accepted_at: number };
    const staleAcceptedAt = acceptedAt.accepted_at - 60_000;
    const staleProcessingStartedAt = staleAcceptedAt + 1;
    db.transaction(() => {
      db.prepare('UPDATE raw_events SET created_at = ? WHERE id = ?').run(staleAcceptedAt, event.id);
      db.prepare(
        `UPDATE event_ingress_receipts
            SET received_at = ?
          WHERE raw_event_id = ? AND disposition = 'accepted'`
      ).run(staleAcceptedAt, event.id);
      db.prepare(
        `UPDATE event_processing_admissions
            SET accepted_at = ?, processing_started_at = ?
          WHERE raw_event_id = ?`
      ).run(staleAcceptedAt, staleProcessingStartedAt, event.id);
    })();
    db.exec(`
      CREATE TEMP TABLE processing_reset_transitions (
        old_state TEXT NOT NULL,
        new_state TEXT NOT NULL,
        processing_started_at INTEGER,
        finished_at INTEGER,
        reason_code TEXT
      );
      CREATE TEMP TRIGGER audit_processing_recovery_reset
      AFTER UPDATE OF state ON event_processing_admissions
      WHEN OLD.raw_event_id = '${event.id}'
        AND OLD.state = 'processing'
        AND NEW.state = 'accepted'
      BEGIN
        INSERT INTO processing_reset_transitions (
          old_state, new_state, processing_started_at, finished_at, reason_code
        ) VALUES (
          OLD.state, NEW.state, NEW.processing_started_at, NEW.finished_at, NEW.reason_code
        );
      END;
    `);
    db.prepare(
      `INSERT INTO event_ingress_receipts (
        id, raw_event_id, transport, disposition, received_at
      ) VALUES (?, ?, 'ws', 'duplicate', ?)`
    ).run('receipt-duplicate-empty-processing', event.id, staleAcceptedAt + 2);

    let piCalls = 0;
    let sendCalls = 0;
    setReplyingRuntime(firstApp, () => {
      piCalls += 1;
    });
    firstApp.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        sendCalls += 1;
        return 'qq-bot-recovered-processing';
      },
    });

    await firstApp.start();
    await firstApp.waitForIdle();

    expect(piCalls).toBe(1);
    expect(sendCalls).toBe(1);
    const completedAdmission = getAdmission(firstApp, event.id);
    expect(completedAdmission).toMatchObject({
      state: 'completed',
      processing_started_at: expect.any(Number),
      finished_at: expect.any(Number),
      reason_code: null,
    });
    expect(completedAdmission?.processing_started_at).toBeGreaterThan(staleProcessingStartedAt);
    expect(db.prepare('SELECT * FROM processing_reset_transitions').all()).toEqual([{
      old_state: 'processing',
      new_state: 'accepted',
      processing_started_at: null,
      finished_at: null,
      reason_code: null,
    }]);
    const completedCounts = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM chat_messages WHERE raw_event_id = ?) AS inbound_chat,
         (SELECT COUNT(*) FROM agent_turns WHERE trigger_event_id = ?) AS turns,
         (SELECT COUNT(*)
            FROM action_decisions ad
            JOIN agent_turns at ON at.id = ad.turn_id
           WHERE at.trigger_event_id = ?) AS decisions,
         (SELECT COUNT(*)
            FROM action_executions ae
            JOIN action_decisions ad ON ad.id = ae.action_decision_id
            JOIN agent_turns at ON at.id = ad.turn_id
           WHERE at.trigger_event_id = ?) AS executions,
         (SELECT COUNT(*) FROM raw_events WHERE type = 'bot.response') AS bot_responses,
         (SELECT COUNT(*) FROM jobs WHERE type = 'extraction') AS extraction_jobs`
    ).get(event.id, event.id, event.id, event.id);
    expect(completedCounts).toEqual({
      inbound_chat: 1,
      turns: 1,
      decisions: 1,
      executions: 1,
      bot_responses: 1,
      extraction_jobs: 1,
    });
    expect(db.prepare(
      `SELECT
         ae.status AS execution_status,
         ae.executed_message_id,
         cm.message_id AS bot_message_id,
         re.type AS bot_raw_type,
         j.idempotency_key,
         json_extract(j.payload, '$.sourceChatMessageId') AS source_chat_message_id
       FROM agent_turns at
       JOIN action_decisions ad ON ad.turn_id = at.id
       JOIN action_executions ae ON ae.action_decision_id = ad.id
       JOIN chat_messages cm
         ON cm.message_id = ae.executed_message_id
        AND cm.sender_id = 'bot-self'
       JOIN raw_events re ON re.id = cm.raw_event_id
       JOIN jobs j ON j.idempotency_key = ?
       WHERE at.trigger_event_id = ?`
    ).get(`extraction:auto:${event.id}`, event.id)).toEqual({
      execution_status: 'success',
      executed_message_id: 'qq-bot-recovered-processing',
      bot_message_id: 'qq-bot-recovered-processing',
      bot_raw_type: 'bot.response',
      idempotency_key: `extraction:auto:${event.id}`,
      source_chat_message_id: event.id,
    });
    expect(db.prepare(
      `SELECT disposition, COUNT(*) AS count
         FROM event_ingress_receipts
        WHERE raw_event_id = ?
        GROUP BY disposition
        ORDER BY disposition`
    ).all(event.id)).toEqual([
      { disposition: 'accepted', count: 1 },
      { disposition: 'duplicate', count: 1 },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

    await firstApp.stop();
    const restartedApp = createApp();
    let restartPiCalls = 0;
    let restartSendCalls = 0;
    setReplyingRuntime(restartedApp, () => {
      restartPiCalls += 1;
    });
    restartedApp.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        restartSendCalls += 1;
        return 'qq-bot-should-not-send';
      },
    });

    await restartedApp.start();
    await restartedApp.waitForIdle();

    expect(restartPiCalls).toBe(0);
    expect(restartSendCalls).toBe(0);
    expect(restartedApp.getDatabase().prepare(
      `SELECT
         (SELECT COUNT(*) FROM chat_messages WHERE raw_event_id = ?) AS inbound_chat,
         (SELECT COUNT(*) FROM agent_turns WHERE trigger_event_id = ?) AS turns,
         (SELECT COUNT(*) FROM action_decisions) AS decisions,
         (SELECT COUNT(*) FROM action_executions) AS executions,
         (SELECT COUNT(*) FROM raw_events WHERE type = 'bot.response') AS bot_responses,
         (SELECT COUNT(*) FROM jobs WHERE type = 'extraction') AS extraction_jobs`
    ).get(event.id, event.id)).toEqual(completedCounts);
    expect(restartedApp.getDatabase().prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('quarantines stale, malformed, and started admissions while ignoring legacy raw rows', async () => {
    const app = createApp();
    const stale = createPrivateEvent({
      id: 'evt-recovery-stale',
      platformEventId: 'qq-812346002',
      senderId: '812346102',
    });
    const withChat = createPrivateEvent({
      id: 'evt-recovery-chat-evidence',
      platformEventId: 'qq-812346003',
      senderId: '812346103',
    });
    const withTurn = createPrivateEvent({
      id: 'evt-recovery-turn-evidence',
      platformEventId: 'qq-812346004',
      senderId: '812346104',
    });
    const malformed = createPrivateEvent({
      id: 'evt-recovery-malformed',
      platformEventId: 'qq-812346005',
      senderId: '812346105',
    });
    const mismatched = createPrivateEvent({
      id: 'evt-recovery-mismatched',
      platformEventId: 'qq-812346006',
      senderId: '812346106',
    });
    const legacy = createPrivateEvent({
      id: 'evt-recovery-legacy',
      platformEventId: 'qq-812346007',
      senderId: '812346107',
    });
    const mismatchedReceipt = createPrivateEvent({
      id: 'evt-recovery-receipt-mismatch',
      platformEventId: 'qq-812346011',
      senderId: '812346111',
    });

    seedRawEvent(app, stale, { state: 'processing' });
    seedRawEvent(app, withChat);
    seedRawEvent(app, withTurn);
    seedRawEvent(app, malformed, { payload: '{malformed-json' });
    seedRawEvent(app, mismatched, {
      payload: JSON.stringify({ ...mismatched, id: 'different-event-id' }),
    });
    seedRawEvent(app, legacy, { withAdmission: false });
    seedRawEvent(app, mismatchedReceipt);

    const db = app.getDatabase();
    db.prepare(
      'UPDATE event_ingress_receipts SET transport = ? WHERE raw_event_id = ?'
    ).run('ws', mismatchedReceipt.id);
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, 'private', ?, ?, 0, 0, 0, ?)`
    ).run(
      withChat.id,
      withChat.id,
      withChat.message.messageId,
      withChat.conversationId,
      withChat.message.senderId,
      'existing evidence',
      withChat.timestamp.getTime(),
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, 'mock', 'mock', 'pending', ?)`
    ).run('turn-existing-evidence', withTurn.conversationId, withTurn.id, Date.now());
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, 'mock', 'mock', 'running', ?)`
    ).run('turn-stale-running', stale.conversationId, stale.id, Date.now());

    let piCalls = 0;
    let sendCalls = 0;
    setReplyingRuntime(app, () => {
      piCalls += 1;
    });
    app.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        sendCalls += 1;
        return 'qq-bot-should-not-send';
      },
    });

    await app.start();
    const legacyDuplicate: OneBotMessage = {
      post_type: 'message',
      message_type: 'private',
      message_id: 812346007,
      user_id: 812346107,
      message: 'legacy duplicate',
      raw_message: 'legacy duplicate',
      sender: { user_id: 812346107 },
      time: Math.floor(Date.now() / 1000),
    };
    expect(app.dispatchOneBotEventForTesting(legacyDuplicate, 'http')).toBe('duplicate');
    await app.waitForIdle();

    expect(piCalls).toBe(0);
    expect(sendCalls).toBe(0);
    expect(getAdmission(app, stale.id)).toMatchObject({
      state: 'interrupted_review',
      reason_code: 'stale_processing',
    });
    expect(getAdmission(app, withChat.id)).toMatchObject({
      state: 'interrupted_review',
      reason_code: 'started_evidence',
    });
    expect(getAdmission(app, withTurn.id)).toMatchObject({
      state: 'interrupted_review',
      reason_code: 'started_evidence',
    });
    const interruptedTurns = db.prepare(
      `SELECT id, status, response_text, completed_at
         FROM agent_turns
        WHERE id IN (?, ?)
        ORDER BY id`,
    ).all('turn-existing-evidence', 'turn-stale-running') as Array<{
      id: string;
      status: string;
      response_text: string | null;
      completed_at: number | null;
    }>;
    expect(interruptedTurns).toEqual([
      {
        id: 'turn-existing-evidence',
        status: 'aborted',
        response_text: 'Startup admission recovery interrupted this turn',
        completed_at: expect.any(Number),
      },
      {
        id: 'turn-stale-running',
        status: 'aborted',
        response_text: 'Startup admission recovery interrupted this turn',
        completed_at: expect.any(Number),
      },
    ]);
    expect(getAdmission(app, malformed.id)).toMatchObject({
      state: 'interrupted_review',
      reason_code: 'invalid_stored_event',
    });
    expect(getAdmission(app, mismatched.id)).toMatchObject({
      state: 'interrupted_review',
      reason_code: 'invalid_stored_event',
    });
    expect(getAdmission(app, mismatchedReceipt.id)).toMatchObject({
      state: 'interrupted_review',
      reason_code: 'invalid_stored_event',
    });
    expect(getAdmission(app, legacy.id)).toBeUndefined();
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM event_ingress_receipts WHERE raw_event_id = ?'
    ).get(legacy.id)).toEqual({ count: 2 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);

    const completedAtByTurn = new Map(
      interruptedTurns.map((turn) => [turn.id, turn.completed_at]),
    );
    await app.stop();
    const restartedApp = createApp();
    let restartPiCalls = 0;
    let restartSendCalls = 0;
    setReplyingRuntime(restartedApp, () => {
      restartPiCalls += 1;
    });
    restartedApp.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        restartSendCalls += 1;
        return 'qq-bot-should-not-send';
      },
    });

    await restartedApp.start();
    await restartedApp.waitForIdle();

    expect(restartPiCalls).toBe(0);
    expect(restartSendCalls).toBe(0);
    const restartedTurns = restartedApp.getDatabase().prepare(
      `SELECT id, status, response_text, completed_at
         FROM agent_turns
        WHERE id IN (?, ?)
        ORDER BY id`,
    ).all('turn-existing-evidence', 'turn-stale-running') as Array<{
      id: string;
      status: string;
      response_text: string | null;
      completed_at: number | null;
    }>;
    expect(restartedTurns).toEqual(
      interruptedTurns.map((turn) => ({
        ...turn,
        completed_at: completedAtByTurn.get(turn.id),
      })),
    );
    expect(restartedApp.getDatabase().prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('quarantines processing admissions with chat, turn, or failure evidence', async () => {
    const app = createApp();
    const withChat = createPrivateEvent({
      id: 'evt-processing-chat-evidence',
      platformEventId: 'qq-812346014',
      senderId: '812346114',
    });
    const withTurn = createPrivateEvent({
      id: 'evt-processing-turn-evidence',
      platformEventId: 'qq-812346015',
      senderId: '812346115',
    });
    const withFailure = createPrivateEvent({
      id: 'evt-processing-failure-evidence',
      platformEventId: 'qq-812346016',
      senderId: '812346116',
    });
    for (const event of [withChat, withTurn, withFailure]) {
      seedRawEvent(app, event, { state: 'processing' });
    }

    const db = app.getDatabase();
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, 'private', ?, ?, 0, 0, 0, ?)`
    ).run(
      withChat.id,
      withChat.id,
      withChat.message.messageId,
      withChat.conversationId,
      withChat.message.senderId,
      'existing processing chat evidence',
      withChat.timestamp.getTime(),
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, 'mock', 'mock', 'pending', ?)`
    ).run('turn-processing-evidence', withTurn.conversationId, withTurn.id, Date.now());
    db.prepare(
      `INSERT INTO event_processing_failures (
        id, raw_event_id, occurred_at, stage, conversation_type,
        error_name, error_message_hash, details
      ) VALUES (?, ?, ?, 'chat_message_store', 'private', 'Error', 'synthetic-hash', ?)`
    ).run(
      'failure-processing-evidence',
      withFailure.id,
      Date.now(),
      JSON.stringify({ redaction: 'synthetic-test-evidence' }),
    );

    let piCalls = 0;
    let sendCalls = 0;
    setReplyingRuntime(app, () => {
      piCalls += 1;
    });
    app.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        sendCalls += 1;
        return 'qq-bot-should-not-send';
      },
    });

    await app.start();
    await app.waitForIdle();

    expect(piCalls).toBe(0);
    expect(sendCalls).toBe(0);
    for (const event of [withChat, withTurn, withFailure]) {
      expect(getAdmission(app, event.id)).toMatchObject({
        state: 'interrupted_review',
        processing_started_at: expect.any(Number),
        finished_at: expect.any(Number),
        reason_code: 'stale_processing',
      });
    }
    expect(db.prepare(
      'SELECT status, response_text, completed_at FROM agent_turns WHERE id = ?'
    ).get('turn-processing-evidence')).toEqual({
      status: 'aborted',
      response_text: 'Startup admission recovery interrupted this turn',
      completed_at: expect.any(Number),
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_decisions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_executions').get()).toEqual({ count: 0 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM raw_events WHERE type = 'bot.response'"
    ).get()).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('quarantines evidence-empty processing admissions unless the normalized event and accepted receipt match', async () => {
    const app = createApp();
    const malformed = createPrivateEvent({
      id: 'evt-processing-malformed',
      platformEventId: 'qq-812346017',
      senderId: '812346117',
    });
    const rawMismatch = createPrivateEvent({
      id: 'evt-processing-raw-mismatch',
      platformEventId: 'qq-812346018',
      senderId: '812346118',
    });
    const missingReceipt = createPrivateEvent({
      id: 'evt-processing-missing-receipt',
      platformEventId: 'qq-812346019',
      senderId: '812346119',
    });
    const duplicateAcceptedReceipt = createPrivateEvent({
      id: 'evt-processing-duplicate-accepted',
      platformEventId: 'qq-812346020',
      senderId: '812346120',
    });
    const transportMismatch = createPrivateEvent({
      id: 'evt-processing-transport-mismatch',
      platformEventId: 'qq-812346021',
      senderId: '812346121',
    });
    const timestampMismatch = createPrivateEvent({
      id: 'evt-processing-timestamp-mismatch',
      platformEventId: 'qq-812346022',
      senderId: '812346122',
    });

    seedRawEvent(app, malformed, { state: 'processing', payload: '{malformed-json' });
    for (const event of [
      rawMismatch,
      missingReceipt,
      duplicateAcceptedReceipt,
      transportMismatch,
      timestampMismatch,
    ]) {
      seedRawEvent(app, event, { state: 'processing' });
    }

    const db = app.getDatabase();
    db.prepare('UPDATE raw_events SET conversation_id = ? WHERE id = ?').run(
      'private:qq-812346999',
      rawMismatch.id,
    );
    db.prepare('DELETE FROM event_ingress_receipts WHERE raw_event_id = ?').run(missingReceipt.id);
    const duplicateAcceptedAt = db.prepare(
      'SELECT accepted_at FROM event_processing_admissions WHERE raw_event_id = ?'
    ).get(duplicateAcceptedReceipt.id) as { accepted_at: number };
    db.prepare(
      `INSERT INTO event_ingress_receipts (
        id, raw_event_id, transport, disposition, received_at
      ) VALUES (?, ?, 'http', 'accepted', ?)`
    ).run(
      'receipt-second-accepted-processing',
      duplicateAcceptedReceipt.id,
      duplicateAcceptedAt.accepted_at,
    );
    db.prepare(
      'UPDATE event_ingress_receipts SET transport = ? WHERE raw_event_id = ?'
    ).run('ws', transportMismatch.id);
    db.prepare(
      'UPDATE event_ingress_receipts SET received_at = received_at + 1 WHERE raw_event_id = ?'
    ).run(timestampMismatch.id);

    let piCalls = 0;
    let sendCalls = 0;
    setReplyingRuntime(app, () => {
      piCalls += 1;
    });
    app.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        sendCalls += 1;
        return 'qq-bot-should-not-send';
      },
    });

    await app.start();
    await app.waitForIdle();

    expect(piCalls).toBe(0);
    expect(sendCalls).toBe(0);
    for (const event of [
      malformed,
      rawMismatch,
      missingReceipt,
      duplicateAcceptedReceipt,
      transportMismatch,
      timestampMismatch,
    ]) {
      expect(getAdmission(app, event.id)).toMatchObject({
        state: 'interrupted_review',
        processing_started_at: expect.any(Number),
        finished_at: expect.any(Number),
        reason_code: 'stale_processing',
      });
    }
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM chat_messages) AS chats,
         (SELECT COUNT(*) FROM agent_turns) AS turns,
         (SELECT COUNT(*) FROM action_decisions) AS decisions,
         (SELECT COUNT(*) FROM action_executions) AS executions,
         (SELECT COUNT(*) FROM event_processing_failures) AS failures`
    ).get()).toEqual({ chats: 0, turns: 0, decisions: 0, executions: 0, failures: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('re-reads the normalized processing event after candidate enumeration before resetting', async () => {
    const app = createApp();
    const event = createPrivateEvent({
      id: 'evt-processing-late-raw-mismatch',
      platformEventId: 'qq-812346024',
      senderId: '812346124',
    });
    seedRawEvent(app, event, { state: 'processing' });

    const db = app.getDatabase();
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare');
    let rawRowMutated = false;
    prepareSpy.mockImplementation((sql) => {
      const statement = originalPrepare(sql);
      if (sql.includes("WHERE a.state IN ('accepted', 'processing')")) {
        const originalAll = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementation(() => {
          const rows = originalAll();
          prepareSpy.mockRestore();
          originalPrepare('UPDATE raw_events SET conversation_id = ? WHERE id = ?').run(
            'private:qq-812346999',
            event.id,
          );
          rawRowMutated = true;
          return rows;
        });
      }
      return statement;
    });

    let piCalls = 0;
    let sendCalls = 0;
    setReplyingRuntime(app, () => {
      piCalls += 1;
    });
    app.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        sendCalls += 1;
        return 'qq-bot-should-not-send';
      },
    });

    await app.start();
    await app.waitForIdle();

    expect(rawRowMutated).toBe(true);
    expect(piCalls).toBe(0);
    expect(sendCalls).toBe(0);
    expect(getAdmission(app, event.id)).toMatchObject({
      state: 'interrupted_review',
      processing_started_at: expect.any(Number),
      finished_at: expect.any(Number),
      reason_code: 'stale_processing',
    });
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM chat_messages WHERE raw_event_id = ?'
    ).get(event.id)).toEqual({ count: 0 });
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM agent_turns WHERE trigger_event_id = ?'
    ).get(event.id)).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('holds the processing evidence snapshot write-locked through the reset', async () => {
    const app = createApp();
    const event = createPrivateEvent({
      id: 'evt-processing-write-lock',
      platformEventId: 'qq-812346025',
      senderId: '812346125',
    });
    seedRawEvent(app, event, { state: 'processing' });

    const db = app.getDatabase();
    const contender = initDatabase({ path: dbPath });
    contender.pragma('busy_timeout = 0');
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare');
    const contenderWrites: Array<'blocked' | 'written'> = [];
    const attemptContenderWrite = (): void => {
      try {
        contender.prepare(
          `INSERT INTO event_processing_failures (
            id, raw_event_id, occurred_at, stage, conversation_type,
            error_name, error_message_hash, details
          ) VALUES (?, ?, ?, 'recovery_race', 'private', 'Error', 'synthetic-hash', ?)`
        ).run(
          'failure-processing-write-lock',
          event.id,
          Date.now(),
          JSON.stringify({ redaction: 'synthetic-test-evidence' }),
        );
        contenderWrites.push('written');
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'SQLITE_BUSY') {
          throw error;
        }
        contenderWrites.push('blocked');
      }
    };
    prepareSpy.mockImplementation((sql) => {
      const statement = originalPrepare(sql);
      if (sql.includes("WHERE a.raw_event_id = ? AND a.state = 'processing'")) {
        const originalGet = statement.get.bind(statement);
        vi.spyOn(statement, 'get').mockImplementation((...params) => {
          const row = originalGet(...params);
          attemptContenderWrite();
          return row;
        });
      } else if (
        sql.includes("SET state = 'accepted'")
        && sql.includes("AND state = 'processing'")
      ) {
        const originalRun = statement.run.bind(statement);
        vi.spyOn(statement, 'run').mockImplementation((...params) => {
          attemptContenderWrite();
          prepareSpy.mockRestore();
          return originalRun(...params);
        });
      }
      return statement;
    });

    let piCalls = 0;
    let sendCalls = 0;
    setReplyingRuntime(app, () => {
      piCalls += 1;
    });
    app.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        sendCalls += 1;
        return 'qq-bot-recovered-write-lock';
      },
    });

    try {
      await app.start();
      await app.waitForIdle();
    } finally {
      prepareSpy.mockRestore();
      contender.close();
    }

    expect(contenderWrites).toEqual(['blocked', 'blocked']);
    expect(piCalls).toBe(1);
    expect(sendCalls).toBe(1);
    expect(getAdmission(app, event.id)).toMatchObject({
      state: 'completed',
      reason_code: null,
    });
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM event_processing_failures WHERE raw_event_id = ?'
    ).get(event.id)).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('does not enqueue a processing admission when the reset compare-and-set loses', async () => {
    const app = createApp();
    const event = createPrivateEvent({
      id: 'evt-processing-reset-cas-loss',
      platformEventId: 'qq-812346023',
      senderId: '812346123',
    });
    seedRawEvent(app, event, { state: 'processing' });

    const db = app.getDatabase();
    const staleAcceptedAt = Date.now() - 60_000;
    const observedProcessingStartedAt = staleAcceptedAt + 1;
    const substitutedProcessingStartedAt = staleAcceptedAt + 2;
    db.transaction(() => {
      db.prepare('UPDATE raw_events SET created_at = ? WHERE id = ?').run(staleAcceptedAt, event.id);
      db.prepare(
        `UPDATE event_ingress_receipts
            SET received_at = ?
          WHERE raw_event_id = ? AND disposition = 'accepted'`
      ).run(staleAcceptedAt, event.id);
      db.prepare(
        `UPDATE event_processing_admissions
            SET accepted_at = ?, processing_started_at = ?
          WHERE raw_event_id = ?`
      ).run(staleAcceptedAt, observedProcessingStartedAt, event.id);
    })();

    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare');
    let processingEpochSubstituted = false;
    prepareSpy.mockImplementation((sql) => {
      const statement = originalPrepare(sql);
      if (sql.includes("WHERE a.raw_event_id = ? AND a.state = 'processing'")) {
        const originalGet = statement.get.bind(statement);
        vi.spyOn(statement, 'get').mockImplementation((...params) => {
          const row = originalGet(...params);
          prepareSpy.mockRestore();
          originalPrepare(
            `UPDATE event_processing_admissions
                SET processing_started_at = ?
              WHERE raw_event_id = ? AND state = 'processing'`
          ).run(substitutedProcessingStartedAt, event.id);
          processingEpochSubstituted = true;
          return row;
        });
      }
      return statement;
    });

    let piCalls = 0;
    let sendCalls = 0;
    setReplyingRuntime(app, () => {
      piCalls += 1;
    });
    app.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        sendCalls += 1;
        return 'qq-bot-should-not-send';
      },
    });

    await app.start();
    await app.waitForIdle();

    expect(processingEpochSubstituted).toBe(true);
    expect(piCalls).toBe(0);
    expect(sendCalls).toBe(0);
    expect(getAdmission(app, event.id)).toMatchObject({
      state: 'interrupted_review',
      processing_started_at: substitutedProcessingStartedAt,
      finished_at: expect.any(Number),
      reason_code: 'stale_processing',
    });
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM chat_messages) AS chats,
         (SELECT COUNT(*) FROM agent_turns) AS turns,
         (SELECT COUNT(*) FROM action_decisions) AS decisions,
         (SELECT COUNT(*) FROM action_executions) AS executions,
         (SELECT COUNT(*) FROM event_processing_failures) AS failures`
    ).get()).toEqual({ chats: 0, turns: 0, decisions: 0, executions: 0, failures: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rolls back admission quarantine when linked turn abortion cannot be written', async () => {
    const app = createApp();
    const event = createPrivateEvent({
      id: 'evt-recovery-abort-write-failure',
      platformEventId: 'qq-812346012',
      senderId: '812346112',
    });
    seedRawEvent(app, event, { state: 'processing' });

    const db = app.getDatabase();
    db.prepare(
      `UPDATE event_processing_admissions
          SET processing_started_at = accepted_at
        WHERE raw_event_id = ?`,
    ).run(event.id);
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, 'mock', 'mock', 'pending', ?)`
    ).run('turn-abort-write-failure', event.conversationId, event.id, Date.now());
    db.exec(`
      CREATE TEMP TRIGGER fail_recovery_turn_abort
      BEFORE UPDATE OF status ON agent_turns
      WHEN NEW.id = 'turn-abort-write-failure' AND NEW.status = 'aborted'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic recovery turn abort failure');
      END;
    `);

    let piCalls = 0;
    let sendCalls = 0;
    setReplyingRuntime(app, () => {
      piCalls += 1;
    });
    app.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        sendCalls += 1;
        return 'qq-bot-should-not-send';
      },
    });

    await expect(app.start()).rejects.toThrow('synthetic recovery turn abort failure');

    expect(piCalls).toBe(0);
    expect(sendCalls).toBe(0);
    expect(getAdmission(app, event.id)).toMatchObject({
      state: 'processing',
      finished_at: null,
      reason_code: null,
    });
    expect(db.prepare(
      'SELECT status, completed_at FROM agent_turns WHERE id = ?'
    ).get('turn-abort-write-failure')).toEqual({ status: 'pending', completed_at: null });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('terminalizes silent and inactive accepted events without Pi or sender calls', async () => {
    const app = createApp();
    const silent = createSilentGroupEvent({
      id: 'evt-recovery-silent',
      platformEventId: 'qq-812346008',
      senderId: '812346108',
      groupId: '812346208',
    });
    const inactive = createPrivateEvent({
      id: 'evt-recovery-inactive',
      platformEventId: 'qq-812346009',
      senderId: '812346109',
    });
    seedRawEvent(app, silent);
    seedRawEvent(app, inactive);

    const db = app.getDatabase();
    const now = Date.now();
    db.prepare(
      'INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)'
    ).run('user-recovery-inactive', now, now);
    db.prepare(
      `INSERT INTO platform_accounts (
        platform, platform_account_id, canonical_user_id, account_type,
        verified_level, status, first_seen_at, last_seen_at
      ) VALUES ('qq', ?, ?, 'private', 'owner_verified', 'disabled', ?, ?)`
    ).run('812346109', 'user-recovery-inactive', now, now);

    let piCalls = 0;
    let sendCalls = 0;
    setReplyingRuntime(app, () => {
      piCalls += 1;
    });
    app.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        sendCalls += 1;
        return 'qq-bot-should-not-send';
      },
    });

    await app.start();
    await app.waitForIdle();

    expect(piCalls).toBe(0);
    expect(sendCalls).toBe(0);
    expect(getAdmission(app, silent.id)).toMatchObject({
      state: 'completed',
      reason_code: null,
    });
    expect(getAdmission(app, inactive.id)).toMatchObject({
      state: 'completed',
      reason_code: null,
    });
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM chat_messages WHERE raw_event_id = ?'
    ).get(silent.id)).toEqual({ count: 1 });
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM chat_messages WHERE raw_event_id = ?'
    ).get(inactive.id)).toEqual({ count: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('marks a caught handler failure as failed without retrying it', async () => {
    const app = createApp();
    const event = createPrivateEvent({
      id: 'evt-recovery-handler-failure',
      platformEventId: 'qq-812346010',
      senderId: '812346110',
    });
    seedRawEvent(app, event);
    const db = app.getDatabase();
    db.exec(`
      CREATE TEMP TRIGGER fail_recovered_chat_insert
      BEFORE INSERT ON chat_messages
      WHEN NEW.raw_event_id = '${event.id}'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic recovered chat failure');
      END;
    `);

    let piCalls = 0;
    let sendCalls = 0;
    setReplyingRuntime(app, () => {
      piCalls += 1;
    });
    app.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        sendCalls += 1;
        return 'qq-bot-should-not-send';
      },
    });

    await app.start();
    await app.waitForIdle();

    expect(piCalls).toBe(0);
    expect(sendCalls).toBe(0);
    expect(getAdmission(app, event.id)).toMatchObject({
      state: 'failed',
      reason_code: 'handler_failed',
    });
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM event_processing_failures WHERE raw_event_id = ?'
    ).get(event.id)).toEqual({ count: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});
