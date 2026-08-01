import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LetheBotApp } from '../../src/index.js';
import { resetConfig } from '../../src/config/index.js';
import { EvaluatorStub } from '../../src/evaluator/evaluator-stub.js';
import type { OneBotMessage } from '../../src/gateway/onebot-adapter.js';
import type { PiAdapterInput, PiAdapterOutput } from '../../src/pi/pi-adapter.js';
import type { SocialEvaluationRequest, SocialEvaluationResult } from '../../src/types/evaluator.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function privateMessage(messageId: number, userId: number, text: string): OneBotMessage {
  return {
    post_type: 'message',
    message_type: 'private',
    message_id: messageId,
    user_id: userId,
    message: text,
    raw_message: text,
    sender: { user_id: userId, nickname: `Concurrency User ${userId}` },
    time: 1_783_630_000,
  };
}

function groupMessage(
  messageId: number,
  userId: number,
  groupId: number,
  text: string,
): OneBotMessage {
  return {
    post_type: 'message',
    message_type: 'group',
    message_id: messageId,
    user_id: userId,
    group_id: groupId,
    message: text,
    raw_message: text,
    sender: { user_id: userId, nickname: `Concurrency Group User ${userId}`, role: 'member' },
    time: 1_783_630_000,
  };
}

describe('application Pi turn admission', () => {
  const originalEnv = process.env;
  let app: LetheBotApp;
  let testDir: string;
  let nextPort = 23_000;
  let baseUrl: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    resetConfig();
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-pi-concurrency-'));
    process.env.LETHEBOT_TEST = 'true';
    process.env.LETHEBOT_DB_PATH = join(testDir, 'lethebot.db');
    process.env.LETHEBOT_HOST = '127.0.0.1';
    const port = nextPort++;
    process.env.LETHEBOT_PORT = String(port);
    baseUrl = `http://127.0.0.1:${port}`;
    process.env.ONEBOT_TRANSPORT = 'http';
    process.env.ONEBOT_TOKEN = 'pi-concurrency-test-token';
    process.env.LETHEBOT_BOT_QQ_ID = '61000';
    process.env.PI_PROVIDER = 'mock';
    process.env.PI_MODEL = 'mock';
    process.env.PI_MAX_CONCURRENT_TURNS = '2';
    process.env.PI_MAX_QUEUED_TURNS = '128';
    process.env.LOG_LEVEL = 'fatal';

    app = new LetheBotApp();
    await app.start();
  });

  afterEach(async () => {
    await app.stop();
    rmSync(testDir, { recursive: true, force: true });
    process.env = originalEnv;
    resetConfig();
  });

  it('keeps one conversation FIFO across action delivery while overlapping two other conversations', async () => {
    const firstConversation = 'private:qq-71001';
    const secondConversation = 'private:qq-71002';
    const thirdConversation = 'private:qq-71003';
    const firstDeliveryStarted = deferred();
    const secondDeliveryStarted = deferred();
    const releaseFirstDelivery = deferred();
    const releaseSecondDelivery = deferred();
    const piTurns: string[] = [];
    const deliveries: string[] = [];

    app.setPiRuntimeForTesting({
      async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
        piTurns.push(input.contextPack.conversation.conversationId);
        return {
          turnId: input.turnId,
          responseText: `reply for ${input.contextPack.conversation.conversationId}`,
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 1, output: 1, total: 2 },
          status: 'completed',
        };
      },
    });
    app.setMessageSenderForTesting({
      async sendMessage(target): Promise<string> {
        deliveries.push(target.conversationId);
        const messageId = `qq-bot-${deliveries.length}`;
        if (target.conversationId === firstConversation && deliveries.filter((id) => id === firstConversation).length === 1) {
          firstDeliveryStarted.resolve();
          await releaseFirstDelivery.promise;
        }
        if (target.conversationId === secondConversation && deliveries.filter((id) => id === secondConversation).length === 1) {
          secondDeliveryStarted.resolve();
          await releaseSecondDelivery.promise;
        }
        return messageId;
      },
    });

    const first = fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer pi-concurrency-test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(privateMessage(71_001, 71_001, 'first')),
    });
    await firstDeliveryStarted.promise;

    const queuedSameConversation = fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer pi-concurrency-test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(privateMessage(71_002, 71_001, 'second same conversation')),
    });
    const otherConversation = fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer pi-concurrency-test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(privateMessage(71_003, 71_002, 'second conversation')),
    });
    const thirdConversationRequest = fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer pi-concurrency-test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(privateMessage(71_004, 71_003, 'third conversation')),
    });

    const requests = [first, queuedSameConversation, otherConversation, thirdConversationRequest];
    try {
      await secondDeliveryStarted.promise;
      expect(piTurns).toEqual([firstConversation, secondConversation]);
      expect(deliveries).toEqual([firstConversation, secondConversation]);
    } finally {
      releaseFirstDelivery.resolve();
      releaseSecondDelivery.resolve();
      await Promise.allSettled(requests);
    }
    await app.waitForIdle();
    expect(app.getEventProcessingFailures()).toHaveLength(0);

    expect(piTurns).toEqual([
      firstConversation,
      secondConversation,
      firstConversation,
      thirdConversation,
    ]);
    expect(deliveries).toEqual([
      firstConversation,
      secondConversation,
      firstConversation,
      thirdConversation,
    ]);
  });

  it('drains an accepted queued turn before shutdown closes the app', async () => {
    const firstDeliveryStarted = deferred();
    const releaseFirstDelivery = deferred();
    const deliveries: string[] = [];
    process.env.PI_MAX_CONCURRENT_TURNS = '1';
    await app.stop();
    resetConfig();
    app = new LetheBotApp();
    await app.start();

    app.setPiRuntimeForTesting({
      async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
        return {
          turnId: input.turnId,
          responseText: 'drain reply',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 1, output: 1, total: 2 },
          status: 'completed',
        };
      },
    });
    app.setMessageSenderForTesting({
      async sendMessage(target): Promise<string> {
        deliveries.push(target.conversationId);
        const messageId = `qq-bot-${deliveries.length}`;
        if (deliveries.length === 1) {
          firstDeliveryStarted.resolve();
          await releaseFirstDelivery.promise;
        }
        return messageId;
      },
    });

    const first = fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer pi-concurrency-test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(privateMessage(72_001, 72_001, 'shutdown first')),
    });
    await firstDeliveryStarted.promise;
    const second = fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer pi-concurrency-test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(privateMessage(72_002, 72_001, 'shutdown queued')),
    });
    await Promise.all([first, second]);

    let stopResolved = false;
    const stopPromise = app.stop().then(() => {
      stopResolved = true;
    });
    try {
      await Promise.resolve();
      expect(stopResolved).toBe(false);
    } finally {
      releaseFirstDelivery.resolve();
    }
    await stopPromise;
    expect(deliveries).toEqual(['private:qq-72001', 'private:qq-72001']);
  });

  it('uses the same conversation admission for delayed Attention rechecks', async () => {
    const groupConversation = 'qq-group-73001';
    const directDeliveryStarted = deferred();
    const releaseDirectDelivery = deferred();
    const piConversations: string[] = [];
    const deliveries: string[] = [];
    let delayedJobResolved = false;

    class ApprovingEvaluator extends EvaluatorStub {
      async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
        return {
          domain: 'social',
          decisionId: `delayed-concurrency-${request.requestId}`,
          requestId: request.requestId,
          decision: 'approve',
          reason: 'Synthetic delayed response approved',
          confidence: 0.9,
          riskLevel: 'medium',
          decidedAt: new Date(),
          evaluatorVersion: 'synthetic-delayed-concurrency-v1',
        };
      }
    }
    app.setSocialEvaluatorForTesting(new ApprovingEvaluator());

    app.setPiRuntimeForTesting({
      async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
        const conversationId = input.contextPack.conversation.conversationId;
        piConversations.push(conversationId);
        return {
          turnId: input.turnId,
          responseText: `reply for ${conversationId}`,
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 1, output: 1, total: 2 },
          status: 'completed',
        };
      },
    });
    app.setMessageSenderForTesting({
      async sendMessage(target): Promise<string> {
        deliveries.push(target.conversationId);
        const messageId = `qq-bot-${deliveries.length}`;
        if (target.conversationId === groupConversation && deliveries.length === 1) {
          directDeliveryStarted.resolve();
          await releaseDirectDelivery.promise;
        }
        return messageId;
      },
    });

    const deferredQuestionResponse = await fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer pi-concurrency-test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(groupMessage(73_001, 73_001, 73_001, 'Could this be answered?')),
    });
    expect(deferredQuestionResponse.status).toBe(200);
    await app.waitForIdle();
    const candidate = app.getDatabase().prepare(
      `SELECT candidate.id AS candidate_id,
              candidate.job_id,
              candidate.not_before_at
         FROM attention_candidates AS candidate
         JOIN chat_messages AS message ON message.id = candidate.source_chat_message_id
        WHERE message.message_id = ?`,
    ).get('qq-73001') as {
      candidate_id: string;
      job_id: string;
      not_before_at: number;
    } | undefined;
    expect(candidate).toBeDefined();

    const directResponse = fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer pi-concurrency-test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...groupMessage(73_002, 73_002, 73_001, '[CQ:at,qq=61000] direct turn'),
        raw_message: '[CQ:at,qq=61000] direct turn',
      }),
    });
    await directDeliveryStarted.promise;

    const delayedJob = app.processNextBackgroundJobForTesting(
      candidate?.not_before_at ?? 0,
      ['attention_recheck'],
    ).then((result) => {
      delayedJobResolved = true;
      return result;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delayedJobResolved).toBe(false);
    expect(piConversations).toEqual([groupConversation]);

    releaseDirectDelivery.resolve();
    const [directResult, delayedResult] = await Promise.all([directResponse, delayedJob]);
    expect(directResult.status).toBe(200);
    expect(delayedResult).toMatchObject({
      taskId: candidate?.job_id,
      status: 'completed',
      output: { candidateId: candidate?.candidate_id, outcome: 'respond' },
    });
    await app.waitForIdle();
    expect(piConversations).toEqual([groupConversation, groupConversation]);
    expect(deliveries).toHaveLength(2);
    expect(app.getEventProcessingFailures()).toHaveLength(0);
  });

  it('durably records overload and never invokes Pi for the rejected event', async () => {
    await app.stop();
    process.env.PI_MAX_CONCURRENT_TURNS = '1';
    process.env.PI_MAX_QUEUED_TURNS = '1';
    process.env.PI_TURN_TIMEOUT_MS = '5000';
    resetConfig();
    app = new LetheBotApp();
    await app.start();

    const firstStarted = deferred();
    const releaseFirst = deferred();
    const piCalls: string[] = [];
    app.setPiRuntimeForTesting({
      async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
        piCalls.push(input.turnId);
        if (piCalls.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return {
          turnId: input.turnId,
          responseText: 'bounded reply',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 1, output: 1, total: 2 },
          status: 'completed',
        };
      },
    });
    app.setMessageSenderForTesting({
      async sendMessage(): Promise<string> {
        return `qq-bot-${piCalls.length}`;
      },
    });

    const send = (messageId: number, userId: number): Promise<Response> => fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer pi-concurrency-test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(privateMessage(messageId, userId, `bounded ${messageId}`)),
    });

    const first = send(74_001, 74_001);
    await firstStarted.promise;
    const queued = send(74_002, 74_002);
    const overloaded = send(74_003, 74_003);
    expect((await Promise.all([first, queued, overloaded])).map((response) => response.status)).toEqual([
      200,
      200,
      200,
    ]);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const admission = app.getDatabase().prepare(
      `SELECT re.platform_event_id, a.state, a.reason_code
         FROM event_processing_admissions AS a
         JOIN raw_events AS re ON re.id = a.raw_event_id
        WHERE re.platform_event_id IN ('qq-74001', 'qq-74002', 'qq-74003')
        ORDER BY re.platform_event_id`,
    ).all() as Array<{ platform_event_id: string; state: string; reason_code: string | null }>;
    const overloadFailure = app.getDatabase().prepare(
      `SELECT stage, details
         FROM event_processing_failures
        WHERE raw_event_id = (
          SELECT id FROM raw_events WHERE platform_event_id = 'qq-74003'
        )`,
    ).get() as { stage: string; details: string } | undefined;
    expect(admission.find((row) => row.platform_event_id === 'qq-74003')).toMatchObject({
      state: 'failed',
      reason_code: 'handler_failed',
    });
    expect(overloadFailure?.stage).toBe('turn_admission_overloaded');
    expect(JSON.parse(overloadFailure?.details ?? '{}')).toMatchObject({ outcomeCode: 'overloaded' });
    expect(piCalls).toHaveLength(1);

    releaseFirst.resolve();
    await app.waitForIdle();
    expect(piCalls).toHaveLength(2);
    expect(app.getEventProcessingFailures()).toHaveLength(1);
  });

  it('records queue timeout and suppresses the queued Pi call', async () => {
    await app.stop();
    process.env.PI_MAX_CONCURRENT_TURNS = '1';
    process.env.PI_MAX_QUEUED_TURNS = '2';
    process.env.PI_TURN_TIMEOUT_MS = '50';
    resetConfig();
    app = new LetheBotApp();
    await app.start();

    const firstStarted = deferred();
    const releaseFirst = deferred();
    const piCalls: string[] = [];
    app.setPiRuntimeForTesting({
      async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
        piCalls.push(input.turnId);
        if (piCalls.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return {
          turnId: input.turnId,
          responseText: 'timeout reply',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 1, output: 1, total: 2 },
          status: 'completed',
        };
      },
    });

    const send = (messageId: number, userId: number): Promise<Response> => fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer pi-concurrency-test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(privateMessage(messageId, userId, `timeout ${messageId}`)),
    });

    const first = send(75_001, 75_001);
    await firstStarted.promise;
    const queued = send(75_002, 75_002);
    expect((await Promise.all([first, queued])).map((response) => response.status)).toEqual([200, 200]);

    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    const timeoutFailure = app.getDatabase().prepare(
      `SELECT stage, details
         FROM event_processing_failures
        WHERE raw_event_id = (
          SELECT id FROM raw_events WHERE platform_event_id = 'qq-75002'
        )`,
    ).get() as { stage: string; details: string } | undefined;
    const timeoutAdmission = app.getDatabase().prepare(
      `SELECT state, reason_code
         FROM event_processing_admissions
        WHERE raw_event_id = (
          SELECT id FROM raw_events WHERE platform_event_id = 'qq-75002'
        )`,
    ).get() as { state: string; reason_code: string | null } | undefined;
    expect(timeoutAdmission).toEqual({ state: 'failed', reason_code: 'handler_failed' });
    expect(timeoutFailure?.stage).toBe('turn_admission_queue_timeout');
    expect(JSON.parse(timeoutFailure?.details ?? '{}')).toMatchObject({ outcomeCode: 'queue_timeout' });
    expect(piCalls).toHaveLength(1);

    releaseFirst.resolve();
    await app.waitForIdle();
    expect(piCalls).toHaveLength(1);
  });
});
