import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LetheBotApp } from '../../src/index.js';
import { AttentionEngine } from '../../src/attention/engine.js';
import { resetConfig } from '../../src/config/index.js';
import type { OneBotMessage } from '../../src/gateway/onebot-adapter.js';
import type { PiAdapterInput, PiAdapterOutput } from '../../src/pi/pi-adapter.js';
import type { ChatMessageReceived } from '../../src/types/events.js';
import { EvaluatorStub } from '../../src/evaluator/evaluator-stub.js';
import { GroupSummaryPolicyRepository } from '../../src/storage/group-summary-policy-repository.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';
import { GroupSummaryJobService } from '../../src/workers/group-summary-job-service.js';
import type {
  MemoryEvaluationRequest,
  MemoryEvaluationResult,
  SocialEvaluationRequest,
  SocialEvaluationResult,
} from '../../src/types/evaluator.js';
import { FakeOneBot } from '../fakes/fake-onebot';

interface PersistedMessageRow {
  id: string;
  raw_event_id: string;
  message_id: string;
  conversation_id: string;
  conversation_type: string;
  group_id: string | null;
  sender_id: string;
  sender_role: string | null;
  text: string | null;
  has_media: number;
  has_quote: number;
  mentions_bot: number;
  reply_to_message_id: string | null;
  raw_type: string;
}

interface PersistedTurnRow {
  id: string;
  conversation_id: string;
  trigger_event_id: string;
  action_decision_id: string | null;
  context_pack_id: string | null;
  pi_model: string;
  pi_provider: string;
  response_text: string | null;
  status: string;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
  completed_at: number | null;
}

interface PersistedActionRow {
  decision_id: string;
  turn_id: string;
  decided_by: string;
  risk_level: string;
  confidence: number;
  evaluator_required: number;
  evaluator_passed: number | null;
  evaluator_decision_id: string | null;
  actions: string;
  reasons: string | null;
  suppressors: string | null;
  execution_id: string | null;
  action_type: string | null;
  status: string | null;
  executed_message_id: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface PersistedContextTraceRow {
  id: string;
  turn_id: string;
  conversation_id: string;
  conversation_type: string;
  group_id: string | null;
  candidate_memory_ids: string;
  selected_memory_ids: string;
  rejected_memories: string;
  filters_applied: string;
  injected_identity_fields: string;
  recent_message_ids: string;
  token_budget: string;
  memories: string;
}

interface SentMessage {
  messageId: string;
  target: {
    conversationId: string;
    conversationType: 'private' | 'group';
    userId?: string;
    groupId?: string;
  };
  text: string;
}

interface PersistedEventProcessingFailureRow {
  raw_event_id: string | null;
  turn_id: string | null;
  stage: string;
  conversation_type: string | null;
  error_name: string;
  error_message_hash: string;
  details: string;
}

describe('E2E Conversation Flow', () => {
  const originalEnv = process.env;
  let app: LetheBotApp;
  let testPort: number;
  let baseUrl: string;
  let testDir: string;
  let outboundMessageCounter = 0;

  beforeAll(async () => {
    process.env = { ...originalEnv };
    resetConfig();

    // Use random high port for test to avoid conflicts
    testPort = 16700 + Math.floor(Math.random() * 1000);
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-e2e-conversation-'));

    process.env.LETHEBOT_TEST = 'true';
    process.env.LETHEBOT_PORT = testPort.toString();
    process.env.LETHEBOT_DB_PATH = join(testDir, 'lethebot-e2e.db');
    process.env.ONEBOT_TRANSPORT = 'http';
    process.env.ONEBOT_HTTP_URL = 'http://localhost:3000/onebot?api_key=sk-health-http-url-secret-should-not-leak';
    process.env.ONEBOT_WS_URL = 'ws://localhost:3001/onebot?token=health-ws-token-should-not-leak-123456';
    process.env.ONEBOT_TOKEN = 'test-onebot-token';
    process.env.LETHEBOT_BOT_QQ_ID = '3889000770';
    delete process.env.LETHEBOT_BOT_OWNER_QQ_ID;
    process.env.PI_PROVIDER = 'mock';
    process.env.PI_MODEL = 'mock';
    process.env.LOG_LEVEL = 'fatal'; // Suppress logs during tests

    baseUrl = `http://localhost:${testPort}`;

    app = new LetheBotApp();
    await app.start();

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    if (app) {
      await app.stop();
    }
    rmSync(testDir, { recursive: true, force: true });
    process.env = originalEnv;
    resetConfig();
  });

  afterEach(async () => {
    await app.waitForIdle();
    try {
      expect(app.getEventProcessingFailures()).toHaveLength(0);
    } finally {
      app.getDatabase()
        .prepare(
          `UPDATE worker_heartbeats
           SET current_job_id = NULL
           WHERE current_job_id IN (
             SELECT id FROM jobs
             WHERE type = 'extraction'
               AND status = 'pending'
               AND idempotency_key LIKE 'extraction:auto:%'
           )`
        )
        .run();
      app.getDatabase()
        .prepare(
          `DELETE FROM job_attempts
           WHERE job_id IN (
             SELECT id FROM jobs
             WHERE type = 'extraction'
               AND status = 'pending'
               AND idempotency_key LIKE 'extraction:auto:%'
           )`
        )
        .run();
      app.getDatabase()
        .prepare(
          `DELETE FROM jobs
           WHERE type = 'extraction'
             AND status = 'pending'
             AND idempotency_key LIKE 'extraction:auto:%'`
        )
        .run();
    }
  });

  async function sendEvent(event: unknown, token: string | null = 'test-onebot-token'): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
    });
  }

  async function postEvent(event: unknown, token: string | null = 'test-onebot-token'): Promise<Response> {
    const response = await sendEvent(event, token);

    await app.waitForIdle();
    return response;
  }

  function getPersistedMessage(platformMessageId: string): PersistedMessageRow | undefined {
    return app
      .getDatabase()
      .prepare(
        `SELECT
          cm.id,
          cm.raw_event_id,
          cm.message_id,
          cm.conversation_id,
          cm.conversation_type,
          cm.group_id,
          cm.sender_id,
          cm.sender_role,
          cm.text,
          cm.has_media,
          cm.has_quote,
          cm.mentions_bot,
          cm.reply_to_message_id,
          re.type AS raw_type
        FROM chat_messages cm
        JOIN raw_events re ON re.id = cm.raw_event_id
        WHERE cm.message_id = ?`
      )
      .get(platformMessageId) as PersistedMessageRow | undefined;
  }

  function getTurnForMessage(platformMessageId: string): PersistedTurnRow | undefined {
    return app
      .getDatabase()
      .prepare(
        `SELECT
          at.id,
          at.conversation_id,
          at.trigger_event_id,
          at.action_decision_id,
          at.context_pack_id,
          at.pi_model,
          at.pi_provider,
          at.response_text,
          at.status,
          at.tokens_input,
          at.tokens_output,
          at.tokens_total,
          at.completed_at
        FROM agent_turns at
        JOIN raw_events re ON re.id = at.trigger_event_id
        JOIN chat_messages cm ON cm.raw_event_id = re.id
        WHERE cm.message_id = ?
        ORDER BY at.started_at DESC
        LIMIT 1`
      )
      .get(platformMessageId) as PersistedTurnRow | undefined;
  }

  function getActionRowsForMessage(platformMessageId: string): PersistedActionRow[] {
    return app
      .getDatabase()
      .prepare(
        `SELECT
          ad.id AS decision_id,
          ad.turn_id,
          ad.decided_by,
          ad.risk_level,
          ad.confidence,
          ad.evaluator_required,
          ad.evaluator_passed,
          ad.evaluator_decision_id,
          ad.actions,
          ad.reasons,
          ad.suppressors,
          ae.id AS execution_id,
          ae.action_type,
          ae.status,
          ae.executed_message_id,
          ae.error_code,
          ae.error_message
        FROM action_decisions ad
        JOIN agent_turns at ON at.id = ad.turn_id
        JOIN raw_events re ON re.id = at.trigger_event_id
        JOIN chat_messages cm ON cm.raw_event_id = re.id
        LEFT JOIN action_executions ae ON ae.action_decision_id = ad.id
        WHERE cm.message_id = ?
        ORDER BY ad.created_at ASC, ae.executed_at ASC`
      )
      .all(platformMessageId) as PersistedActionRow[];
  }

  function getContextTraceForMessage(platformMessageId: string): PersistedContextTraceRow | undefined {
    return app
      .getDatabase()
      .prepare(
        `SELECT
          ct.id,
          ct.turn_id,
          ct.conversation_id,
          ct.conversation_type,
          ct.group_id,
          ct.candidate_memory_ids,
          ct.selected_memory_ids,
          ct.rejected_memories,
          ct.filters_applied,
          ct.injected_identity_fields,
          ct.recent_message_ids,
          ct.token_budget,
          ct.memories
        FROM context_traces ct
        JOIN agent_turns at ON at.id = ct.turn_id
        JOIN raw_events re ON re.id = at.trigger_event_id
        JOIN chat_messages cm ON cm.raw_event_id = re.id
        WHERE cm.message_id = ?
        ORDER BY ct.created_at DESC
        LIMIT 1`
      )
      .get(platformMessageId) as PersistedContextTraceRow | undefined;
  }

  function countTurnsForMessage(platformMessageId: string): number {
    const row = app
      .getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM agent_turns at
         JOIN raw_events re ON re.id = at.trigger_event_id
         JOIN chat_messages cm ON cm.raw_event_id = re.id
         WHERE cm.message_id = ?`
      )
      .get(platformMessageId) as { count: number };
    return row.count;
  }

  function countTableRows(
    tableName:
      | 'raw_events'
      | 'chat_messages'
      | 'agent_turns'
      | 'context_traces'
      | 'action_decisions'
      | 'action_executions'
  ): number {
    const row = app
      .getDatabase()
      .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
      .get() as { count: number };
    return row.count;
  }

  function countBotResponseRows(conversationId: string): number {
    const row = app
      .getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM chat_messages cm
         JOIN raw_events re ON re.id = cm.raw_event_id
         WHERE cm.conversation_id = ?
           AND cm.sender_id = 'bot-self'
           AND re.type = 'bot.response'`
      )
      .get(conversationId) as { count: number };
    return row.count;
  }

  function countBotResponseRawEvents(conversationId: string): number {
    const row = app
      .getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM raw_events
         WHERE conversation_id = ? AND type = 'bot.response'`
      )
      .get(conversationId) as { count: number };
    return row.count;
  }

  function countNonTerminalTurnsForMessage(platformMessageId: string): number {
    const row = app
      .getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM agent_turns at
         JOIN raw_events re ON re.id = at.trigger_event_id
         JOIN chat_messages cm ON cm.raw_event_id = re.id
         WHERE cm.message_id = ? AND at.status IN ('pending', 'running')`
      )
      .get(platformMessageId) as { count: number };
    return row.count;
  }

  function expectLinkedEventProcessingFailure(
    turn: PersistedTurnRow,
    stage: string,
  ): void {
    const failure = app
      .getDatabase()
      .prepare(
        `SELECT raw_event_id, turn_id, stage, conversation_type,
                error_name, error_message_hash, details
         FROM event_processing_failures
         WHERE turn_id = ? AND stage = ?
         ORDER BY occurred_at DESC
         LIMIT 1`
      )
      .get(turn.id, stage) as PersistedEventProcessingFailureRow | undefined;

    expect(failure).toMatchObject({
      raw_event_id: turn.trigger_event_id,
      turn_id: turn.id,
      stage,
      conversation_type: 'private',
      error_name: 'SqliteError',
    });
    expect(failure?.error_message_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(failure?.details ?? '{}')).toMatchObject({
      rawEventStored: true,
      turnStarted: true,
      stage,
      conversationType: 'private',
    });
  }

  function setSuccessfulPiRuntime(): void {
    app.setPiRuntimeForTesting({
      async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
        return {
          turnId: input.turnId,
          responseText: '',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 0, output: 0, total: 0 },
          status: 'completed',
        };
      },
    });
  }

  function setReplyingPiRuntime(responseText: string): void {
    app.setPiRuntimeForTesting({
      async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
        return {
          turnId: input.turnId,
          responseText,
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 11, output: 7, total: 18 },
          status: 'completed',
        };
      },
    });
  }

  function setCapturingMessageSender(sentMessages: SentMessage[], failWith?: string): void {
    app.setMessageSenderForTesting({
      async sendMessage(target, content): Promise<string> {
        const messageId = `qq-bot-${++outboundMessageCounter}`;
        sentMessages.push({
          messageId,
          target,
          text: content.text ?? '',
        });

        if (failWith) {
          throw new Error(failWith);
        }

        return messageId;
      },
    });
  }

  function restoreDecisionDefaults(): void {
    app.setSocialEvaluatorForTesting(new EvaluatorStub());
    app.clearCooldownsForTesting();
  }

  function expectNoForeignKeyViolations(): void {
    const violations = app.getDatabase().prepare('PRAGMA foreign_key_check').all();
    expect(violations).toHaveLength(0);
  }

  function makeGroupEvent(input: {
    messageId: number;
    userId: number;
    groupId: number;
    text: string;
    role?: 'member' | 'admin' | 'owner';
  }): OneBotMessage {
    return {
      post_type: 'message',
      message_type: 'group',
      message_id: input.messageId,
      user_id: input.userId,
      group_id: input.groupId,
      message: input.text,
      raw_message: input.text,
      sender: {
        user_id: input.userId,
        nickname: `GovernanceUser${input.userId}`,
        role: input.role ?? 'admin',
      },
      time: Math.floor(Date.now() / 1000),
    };
  }

  function forceRiskAttentionForTesting() {
    return vi.spyOn(AttentionEngine.prototype, 'analyze').mockReturnValue({
      classification: 'needs_evaluation',
      triggerScore: 1,
      triggerReasons: ['synthetic_evaluator_test'],
      suppressors: [],
      recommendedPath: 'risk_path',
    });
  }

  function expectSuccessfulGroupGovernanceCommand(
    platformMessageId: string,
    sentMessage: SentMessage | undefined,
    expectedText: string,
  ): void {
    const source = getPersistedMessage(platformMessageId);
    expect(source).toBeDefined();

    const turn = getTurnForMessage(platformMessageId);
    expect(turn).toMatchObject({
      conversation_id: source?.conversation_id,
      trigger_event_id: source?.raw_event_id,
      pi_provider: 'local',
      pi_model: 'qq-governance-v1',
      response_text: expectedText,
      status: 'completed',
      tokens_input: 0,
      tokens_output: 0,
      tokens_total: 0,
    });
    expect(turn?.action_decision_id).toBeDefined();
    expect(turn?.completed_at).toBeGreaterThan(0);

    const actionRows = getActionRowsForMessage(platformMessageId);
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      turn_id: turn?.id,
      decided_by: 'attention',
      risk_level: 'low',
      confidence: 1,
      evaluator_required: 0,
      evaluator_passed: null,
      evaluator_decision_id: null,
      action_type: 'reply_short',
      status: 'success',
      executed_message_id: sentMessage?.messageId,
      error_code: null,
      error_message: null,
    });
    expect(JSON.parse(actionRows[0]?.reasons ?? '[]')).toEqual([
      'Deterministic QQ governance command',
    ]);
    expect(JSON.parse(actionRows[0]?.actions ?? '[]')).toEqual([
      expect.objectContaining({
        type: 'reply_short',
        payload: { text: expectedText },
        constraints: expect.objectContaining({
          evaluatorRequired: false,
          proactive: false,
        }),
      }),
    ]);

    expect(sentMessage).toMatchObject({
      target: {
        conversationId: source?.conversation_id,
        conversationType: 'group',
        groupId: source?.group_id,
      },
      text: expectedText,
    });
    expect(getPersistedMessage(sentMessage?.messageId ?? '')).toMatchObject({
      conversation_id: source?.conversation_id,
      conversation_type: 'group',
      group_id: source?.group_id,
      sender_id: 'bot-self',
      text: expectedText,
      raw_type: 'bot.response',
    });
    expect(app.getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM tool_calls WHERE turn_id = ?',
    ).get(turn?.id)).toEqual({ count: 0 });
    expect(app.getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM evaluator_decisions WHERE turn_id = ?',
    ).get(turn?.id)).toEqual({ count: 0 });
  }

  describe('Health check', () => {
    it('should respond to health check', async () => {
      const response = await fetch(`${baseUrl}/healthz`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.version).toBeDefined();
      expect(data.checks.database.ok).toBe(true);
      expect(data.checks.adapter.ready).toBe(true);
      expect(data.checks.adapter.hasToken).toBe(true);
      expect(data.checks.adapter.botIdConfigured).toBe(true);
      expect(data.checks.eventProcessing).toEqual({
        pending: 0,
        failures: 0,
      });
      const serializedHealth = JSON.stringify(data);
      expect(serializedHealth).not.toContain('test-onebot-token');
      expect(serializedHealth).not.toContain('localhost:3000');
      expect(serializedHealth).not.toContain('localhost:3001');
      expect(serializedHealth).not.toContain('sk-health-http-url-secret-should-not-leak');
      expect(serializedHealth).not.toContain('health-ws-token-should-not-leak-123456');
      expect(serializedHealth).not.toContain('httpUrl');
      expect(serializedHealth).not.toContain('wsUrl');
      expect(serializedHealth).not.toContain('lastError');

      const readinessResponse = await fetch(`${baseUrl}/readyz`);
      expect(readinessResponse.status).toBe(200);

      const readiness = await readinessResponse.json() as {
        status: string;
        version: string;
        checks: {
          database: { ready: boolean; open: boolean };
          adapter: {
            ready: boolean;
            mode: string;
            hasToken: boolean;
            botIdConfigured: boolean;
          };
          eventProcessing: { pending: number };
        };
      };
      expect(readiness).toMatchObject({
        status: 'ready',
        version: expect.any(String),
        checks: {
          database: { ready: true, open: true },
          adapter: {
            ready: true,
            mode: 'http',
            hasToken: true,
            botIdConfigured: true,
          },
          eventProcessing: { pending: 0 },
        },
      });
      const serializedReadiness = JSON.stringify(readiness);
      expect(serializedReadiness).not.toContain('test-onebot-token');
      expect(serializedReadiness).not.toContain('localhost:3000');
      expect(serializedReadiness).not.toContain('localhost:3001');
      expect(serializedReadiness).not.toContain('qq-');
      expect(serializedReadiness).not.toContain('private:');
    });

    it('should omit sensitive database query diagnostics from degraded health', async () => {
      const rawSecret = 'api_key=sk-health-db-secret-qq-1234567890';
      const rawPath = '/home/operator/private/lethebot.db';
      const prepare = vi.spyOn(app.getDatabase(), 'prepare');
      prepare.mockImplementationOnce(() => {
        throw new Error(`database failed ${rawSecret} path=${rawPath}`);
      });

      try {
        const response = await fetch(`${baseUrl}/healthz`);
        expect(response.status).toBe(503);

        const health = await response.json() as {
          status: string;
          checks: { database: Record<string, unknown> };
        };
        expect(health.status).toBe('degraded');
        expect(health.checks.database).toEqual({ ok: false, open: true });

        const serialized = JSON.stringify(health);
        expect(serialized).not.toContain(rawSecret);
        expect(serialized).not.toContain('sk-health-db-secret');
        expect(serialized).not.toContain('qq-1234567890');
        expect(serialized).not.toContain(rawPath);
        expect(serialized).not.toContain('database failed');
      } finally {
        prepare.mockRestore();
      }
    });

    it('should return non-leaking degraded health and not_ready readiness when the adapter is stopped', async () => {
      await app.stopAdapterForTesting();

      try {
        const healthResponse = await fetch(`${baseUrl}/healthz`);
        expect(healthResponse.status).toBe(503);

        const health = await healthResponse.json() as {
          status: string;
          version: string;
          checks: {
            database: { ok: boolean; open: boolean; error?: string };
            adapter: {
              ready: boolean;
              mode: string;
              hasToken: boolean;
              botIdConfigured: boolean;
            };
            eventProcessing: { pending: number; failures: number };
          };
        };

        expect(health).toMatchObject({
          status: 'degraded',
          version: expect.any(String),
          checks: {
            database: { ok: true, open: true },
            adapter: {
              ready: false,
              mode: 'http',
              hasToken: true,
              botIdConfigured: true,
            },
            eventProcessing: { pending: 0, failures: 0 },
          },
        });

        const serializedHealth = JSON.stringify(health);
        expect(serializedHealth).not.toContain('test-onebot-token');
        expect(serializedHealth).not.toContain('localhost:3000');
        expect(serializedHealth).not.toContain('localhost:3001');
        expect(serializedHealth).not.toContain(testDir);
        expect(serializedHealth).not.toContain('lethebot-e2e.db');
        expect(serializedHealth).not.toContain('qq-');
        expect(serializedHealth).not.toContain('private:');
        expect(serializedHealth).not.toContain('OneBot adapter stopped');
        expect(serializedHealth).not.toContain('lastError');

        const response = await fetch(`${baseUrl}/readyz`);
        expect(response.status).toBe(503);

        const readiness = await response.json() as {
          status: string;
          version: string;
          checks: {
            database: { ready: boolean; open: boolean };
            adapter: {
              ready: boolean;
              mode: string;
              hasToken: boolean;
              botIdConfigured: boolean;
            };
            eventProcessing: { pending: number };
          };
        };

        expect(readiness).toMatchObject({
          status: 'not_ready',
          version: expect.any(String),
          checks: {
            database: { ready: true, open: true },
            adapter: {
              ready: false,
              mode: 'http',
              hasToken: true,
              botIdConfigured: true,
            },
            eventProcessing: { pending: 0 },
          },
        });

        const serializedReadiness = JSON.stringify(readiness);
        expect(serializedReadiness).not.toContain('test-onebot-token');
        expect(serializedReadiness).not.toContain('localhost:3000');
        expect(serializedReadiness).not.toContain('localhost:3001');
        expect(serializedReadiness).not.toContain(testDir);
        expect(serializedReadiness).not.toContain('lethebot-e2e.db');
        expect(serializedReadiness).not.toContain('qq-');
        expect(serializedReadiness).not.toContain('private:');
        expect(serializedReadiness).not.toContain('OneBot adapter stopped');
        expect(serializedReadiness).not.toContain('lastError');
      } finally {
        await app.startAdapterForTesting();
      }
    });

    it('should expose a count-only JSON metrics snapshot without leaking payloads', async () => {
      const secretLikePayload = 'sk-metrics-endpoint-secret-should-not-leak';
      const dynamicSecret = 'sk-metrics-http-dynamic-key-should-not-leak';
      const dynamicPlatformId = 'qq-4567891230';
      const dynamicKey = `custom-${dynamicPlatformId}-api_key=${dynamicSecret}`;
      const db = app.getDatabase();
      const now = Date.now();
      const jobId = 'job-metrics-endpoint-seed';
      const dynamicJobId = 'job-metrics-endpoint-dynamic-key';
      const dynamicWorkerId = 'worker-metrics-endpoint-dynamic-key';
      const dynamicAuditId = 'audit-metrics-endpoint-dynamic-key';

      db.prepare(
        `INSERT INTO jobs (
          id, type, payload, status, attempts, max_attempts,
          lease_owner, lease_expires_at, heartbeat_at,
          created_at, updated_at, scheduled_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        jobId,
        'summary',
        JSON.stringify({ token: secretLikePayload }),
        'running',
        1,
        3,
        'metrics-endpoint-worker-secret-should-not-leak',
        Date.UTC(2100, 0, 1),
        now,
        now,
        now,
        now,
        now
      );
      db.prepare(
        `INSERT INTO jobs (
          id, type, payload, status, attempts, max_attempts,
          created_at, updated_at, scheduled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        dynamicJobId,
        dynamicKey,
        '{}',
        'pending',
        0,
        1,
        now,
        now,
        now
      );
      db.prepare(
        `INSERT INTO worker_heartbeats (
          worker_id, worker_type, status, current_job_id, heartbeat_at, details
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        dynamicWorkerId,
        dynamicKey,
        'idle',
        null,
        now,
        '{}'
      );
      db.prepare(
        `INSERT INTO audit_log (
          id, timestamp, category, level, event_type, event_id,
          actor_user_id, actor_class, invocation_context, summary, details,
          redacted, risk_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        dynamicAuditId,
        now,
        'system',
        'redacted_full',
        dynamicKey,
        'evt-metrics-endpoint-dynamic-key',
        null,
        'system',
        'metrics_http_test',
        'Dynamic metrics key fixture',
        '{}',
        1,
        dynamicKey
      );

      try {
        const response = await fetch(`${baseUrl}/metrics`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');

        const data = await response.json() as {
          generatedAt: string;
          rawEvents: { total: number };
          eventIngressReceipts: { total: number; byDisposition: Record<string, number> };
          chatMessages: { total: number };
          agentTurns: { total: number; byStatus: Record<string, number>; tokensTotal: number };
          contextTraces: { total: number };
          actionDecisions: { total: number };
          actionExecutions: { total: number };
          memoryWrites: { total: number };
          policyAuditEvents: { total: number };
          toolCalls: { total: number; secretsRedacted: number };
          jobs: {
            total: number;
            byStatus: Record<string, number>;
            byType: Record<string, number>;
            pending: number;
            running: number;
            failed: number;
            expiredRunningLeases: number;
          };
          jobAttempts: { total: number; byStatus: Record<string, number> };
          workerHeartbeats: { total: number; byStatus: Record<string, number>; byWorkerType: Record<string, number> };
          eventProcessingFailures: { total: number; byStage: Record<string, number>; byConversationType: Record<string, number> };
        };

        expect(data.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(data.rawEvents.total).toBeGreaterThanOrEqual(0);
        expect(data.eventIngressReceipts.total).toBeGreaterThanOrEqual(0);
        expect(data.eventIngressReceipts.byDisposition).toBeDefined();
        expect(data.chatMessages.total).toBeGreaterThanOrEqual(0);
        expect(data.agentTurns.byStatus).toBeDefined();
        expect(data.contextTraces.total).toBeGreaterThanOrEqual(0);
        expect(data.actionDecisions.total).toBeGreaterThanOrEqual(0);
        expect(data.actionExecutions.total).toBeGreaterThanOrEqual(0);
        expect(data.memoryWrites.total).toBeGreaterThanOrEqual(0);
        expect(data.policyAuditEvents.total).toBeGreaterThanOrEqual(0);
        expect(data.toolCalls.secretsRedacted).toBeGreaterThanOrEqual(0);
        expect(data.jobs.total).toBeGreaterThanOrEqual(1);
        expect(data.jobs.running).toBeGreaterThanOrEqual(1);
        expect(data.jobs.byStatus.running).toBeGreaterThanOrEqual(1);
        expect(data.jobs.byType.summary).toBeGreaterThanOrEqual(1);
        expect(data.jobs.byType['custom-[REDACTED:platform_id]-[REDACTED:api_key_assignment]']).toBeGreaterThanOrEqual(1);
        expect(data.jobs.expiredRunningLeases).toBeGreaterThanOrEqual(0);
        expect(data.jobAttempts.total).toBeGreaterThanOrEqual(0);
        expect(data.workerHeartbeats.byWorkerType).toBeDefined();
        expect(data.workerHeartbeats.byWorkerType['custom-[REDACTED:platform_id]-[REDACTED:api_key_assignment]']).toBeGreaterThanOrEqual(1);
        expect(data.eventProcessingFailures.byStage).toBeDefined();
        expect(data.policyAuditEvents.byRiskLevel['custom-[REDACTED:platform_id]-[REDACTED:api_key_assignment]']).toBeGreaterThanOrEqual(1);
        expect(data.policyAuditEvents.byEventType['custom-[REDACTED:platform_id]-[REDACTED:api_key_assignment]']).toBeGreaterThanOrEqual(1);

        const serialized = JSON.stringify(data);
        expect(serialized).not.toContain(secretLikePayload);
        expect(serialized).not.toContain('metrics-endpoint-worker-secret-should-not-leak');
        expect(serialized).not.toContain(dynamicKey);
        expect(serialized).not.toContain(dynamicSecret);
        expect(serialized).not.toContain(dynamicPlatformId);
        expect(serialized).not.toContain('test-onebot-token');

        const prometheusResponse = await fetch(`${baseUrl}/metrics?format=prometheus`);
        expect(prometheusResponse.status).toBe(200);
        expect(prometheusResponse.headers.get('content-type')).toContain('text/plain');
        const prometheus = await prometheusResponse.text();
        expect(prometheus).toContain('lethebot_raw_events_total');
        expect(prometheus).toContain('lethebot_event_ingress_receipts_total');
        expect(prometheus).toContain('lethebot_jobs_type_total{type="summary"}');
        expect(prometheus).toContain('lethebot_jobs_type_total{type="other"}');
        expect(prometheus).toContain('lethebot_worker_heartbeats_type_total{worker_type="other"}');
        expect(prometheus).toContain('lethebot_policy_audit_events_risk_level_total{risk_level="other"}');
        expect(prometheus).not.toContain(secretLikePayload);
        expect(prometheus).not.toContain('metrics-endpoint-worker-secret-should-not-leak');
        expect(prometheus).not.toContain(dynamicKey);
        expect(prometheus).not.toContain(dynamicSecret);
        expect(prometheus).not.toContain(dynamicPlatformId);
        expect(prometheus).not.toContain('test-onebot-token');
        expect(prometheus).not.toContain('private:qq');
        expectNoForeignKeyViolations();
      } finally {
        db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
        db.prepare('DELETE FROM jobs WHERE id = ?').run(dynamicJobId);
        db.prepare('DELETE FROM worker_heartbeats WHERE worker_id = ?').run(dynamicWorkerId);
        db.prepare('DELETE FROM audit_log WHERE id = ?').run(dynamicAuditId);
      }

      expectNoForeignKeyViolations();
    });

    it('should expose event-processing failure counts without leaking event or error details', async () => {
      const rawSecret = 'sk-pi-thrown-turn-secret-should-not-persist';
      const rawPlatformId = 'legacy_qq-4445556666';
      const rawNumericPlatformId = 'legacy_555666777';
      app.setPiRuntimeForTesting({
        async runTurn(): Promise<PiAdapterOutput> {
          throw new Error(
            `pi-crash-redaction-sentinel api_key=${rawSecret} target=${rawPlatformId} peer=${rawNumericPlatformId}`
          );
        },
      });

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 98765,
          user_id: 444555,
          message: '触发一次 health failure 计数',
          raw_message: '触发一次 health failure 计数',
          sender: {
            user_id: 444555,
            nickname: 'HealthFailureUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);
        expect(response.status).toBe(200);
        expect(app.getEventProcessingFailures()).toHaveLength(1);
        const failure = app.getEventProcessingFailures()[0];
        expect(failure?.errorMessage).toContain('[REDACTED:api_key_assignment]');
        expect(failure?.errorMessage).toContain('[REDACTED:platform_id]');
        expect(failure?.errorMessage).not.toContain(rawSecret);
        expect(failure?.errorMessage).not.toContain(rawPlatformId);
        expect(failure?.errorMessage).not.toContain(rawNumericPlatformId);
        expect(failure?.errorMessage).not.toContain('legacy_qq-');
        expect(failure?.errorMessage).not.toContain('4445556666');
        expect(failure?.errorMessage).not.toContain('555666777');

        const healthResponse = await fetch(`${baseUrl}/healthz`);
        expect(healthResponse.status).toBe(200);
        const data = await healthResponse.json();
        expect(data.status).toBe('ok');
        expect(data.checks.database.ok).toBe(true);
        expect(data.checks.adapter.ready).toBe(true);
        expect(data.checks.eventProcessing).toEqual({
          pending: 0,
          failures: 1,
        });

        const serialized = JSON.stringify(data);
        expect(serialized).not.toContain('98765');
        expect(serialized).not.toContain('444555');
        expect(serialized).not.toContain(rawSecret);
        expect(serialized).not.toContain(rawPlatformId);
        expect(serialized).not.toContain('HealthFailureUser');

        const turn = getTurnForMessage('qq-98765');
        expect(turn).toBeDefined();
        expect(turn?.status).toBe('failed');
        expect(turn?.response_text).toContain('pi-crash-redaction-sentinel');
        expect(turn?.response_text).toContain('[REDACTED:api_key_assignment]');
        expect(turn?.response_text).toContain('[REDACTED:platform_id]');
        expect(turn?.response_text).not.toContain(rawSecret);
        expect(turn?.response_text).not.toContain(rawPlatformId);
        expect(turn?.response_text).not.toContain(rawNumericPlatformId);
        expect(turn?.response_text).not.toContain('legacy_qq-');
        expect(turn?.response_text).not.toContain('4445556666');
        expect(turn?.response_text).not.toContain('555666777');
        expect(turn?.completed_at).toBeGreaterThan(0);

        const failureRow = app
          .getDatabase()
          .prepare(
            `SELECT *
             FROM event_processing_failures
             WHERE stage = ?
             ORDER BY occurred_at DESC
             LIMIT 1`
          )
          .get('pi_inference') as
          | {
            id: string;
            raw_event_id: string | null;
            turn_id: string | null;
            stage: string;
            conversation_type: string | null;
            error_name: string;
            error_message_hash: string;
            message_id_hash: string | null;
            sender_id_hash: string | null;
            conversation_id_hash: string | null;
            details: string;
          }
          | undefined;

        expect(failureRow).toBeDefined();
        expect(failureRow?.raw_event_id).toBeDefined();
        expect(failureRow?.turn_id).toBeDefined();
        expect(failureRow?.stage).toBe('pi_inference');
        expect(failureRow?.conversation_type).toBe('private');
        expect(failureRow?.error_name).toBe('Error');
        expect(failureRow?.error_message_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(failureRow?.message_id_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(failureRow?.sender_id_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(failureRow?.conversation_id_hash).toMatch(/^[0-9a-f]{64}$/);

        const persistedDetails = failureRow?.details ?? '';
        expect(persistedDetails).toContain('hashes_only_no_message_text_no_platform_ids_no_raw_error');
        expect(persistedDetails).not.toContain('98765');
        expect(persistedDetails).not.toContain('444555');
        expect(persistedDetails).not.toContain('4445556666');
        expect(persistedDetails).not.toContain('555666777');
        expect(persistedDetails).not.toContain(rawSecret);
        expect(persistedDetails).not.toContain(rawPlatformId);
        expect(persistedDetails).not.toContain(rawNumericPlatformId);
        expect(persistedDetails).not.toContain('HealthFailureUser');
        expectNoForeignKeyViolations();
      } finally {
        app.clearEventProcessingFailuresForTesting();
        setSuccessfulPiRuntime();
      }
    });

    it('preserves both markers for assignment-shaped adjacent app-level failure diagnostics', async () => {
      const rawAdjacent = 'api_key=sk-pi-thrown-assignment-secret-qq-4445556666';
      app.setPiRuntimeForTesting({
        async runTurn(): Promise<PiAdapterOutput> {
          throw new Error(`pi-crash-assignment-adjacent ${rawAdjacent}`);
        },
      });

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 98766,
          user_id: 444556,
          message: '触发一次 assignment-shaped app failure',
          raw_message: '触发一次 assignment-shaped app failure',
          sender: {
            user_id: 444556,
            nickname: 'AssignmentFailureUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);
        expect(response.status).toBe(200);
        expect(app.getEventProcessingFailures()).toHaveLength(1);
        const failure = app.getEventProcessingFailures()[0];
        expect(failure?.errorMessage).toContain('pi-crash-assignment-adjacent');
        expect(failure?.errorMessage).toContain('[REDACTED:api_key_assignment]');
        expect(failure?.errorMessage).toContain('[REDACTED:platform_id]');
        expect(failure?.errorMessage).not.toContain('api_key=');
        expect(failure?.errorMessage).not.toContain('sk-pi-thrown-assignment');
        expect(failure?.errorMessage).not.toContain('qq-4445556666');
        expect(failure?.errorMessage).not.toContain('4445556666');

        const turn = getTurnForMessage('qq-98766');
        expect(turn).toBeDefined();
        expect(turn?.status).toBe('failed');
        expect(turn?.response_text).toContain('pi-crash-assignment-adjacent');
        expect(turn?.response_text).toContain('[REDACTED:api_key_assignment]');
        expect(turn?.response_text).toContain('[REDACTED:platform_id]');
        expect(turn?.response_text).not.toContain('api_key=');
        expect(turn?.response_text).not.toContain('sk-pi-thrown-assignment');
        expect(turn?.response_text).not.toContain('qq-4445556666');
        expect(turn?.response_text).not.toContain('4445556666');
        expectNoForeignKeyViolations();
      } finally {
        app.clearEventProcessingFailuresForTesting();
        setSuccessfulPiRuntime();
      }
    });
  });

  describe('Turn persistence failure lifecycle', () => {
    it('terminalizes a pending turn when context trace persistence fails', async () => {
      const db = app.getDatabase();
      const conversationId = 'private:qq-618001';
      let piCalls = 0;
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: '',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 0, output: 0, total: 0 },
            status: 'completed',
          };
        },
      });
      db.exec(`
        CREATE TEMP TRIGGER fail_turn_context_trace_insert
        BEFORE INSERT ON context_traces
        WHEN NEW.conversation_id = '${conversationId}'
        BEGIN
          SELECT RAISE(ABORT, 'forced context trace insert failure');
        END
      `);

      try {
        const response = await postEvent({
          post_type: 'message',
          message_type: 'private',
          message_id: 918001,
          user_id: 618001,
          message: 'trigger context persistence failure',
          raw_message: 'trigger context persistence failure',
          sender: { user_id: 618001, nickname: 'ContextFailureUser' },
          time: Math.floor(Date.now() / 1000),
        } satisfies OneBotMessage);

        expect(response.status).toBe(200);
        expect(app.getEventProcessingFailures()).toHaveLength(1);
        expect(piCalls).toBe(0);
        expect(getPersistedMessage('qq-918001')).toBeDefined();
        expect(countTurnsForMessage('qq-918001')).toBe(1);

        const turn = getTurnForMessage('qq-918001');
        expect(turn).toBeDefined();
        if (!turn) {
          throw new Error('Expected context failure turn');
        }
        expect(turn).toMatchObject({
          status: 'failed',
          context_pack_id: null,
          action_decision_id: null,
        });
        expect(turn.completed_at).toBeGreaterThan(0);
        expect(turn.response_text).toContain('forced context trace insert failure');
        expect(getContextTraceForMessage('qq-918001')).toBeUndefined();
        expect(getActionRowsForMessage('qq-918001')).toEqual([]);
        expect(countBotResponseRawEvents(conversationId)).toBe(0);
        expect(countBotResponseRows(conversationId)).toBe(0);
        expect(countNonTerminalTurnsForMessage('qq-918001')).toBe(0);
        expectLinkedEventProcessingFailure(turn, 'context_building');
        expectNoForeignKeyViolations();
      } finally {
        db.exec('DROP TRIGGER IF EXISTS fail_turn_context_trace_insert');
        app.clearEventProcessingFailuresForTesting();
        setSuccessfulPiRuntime();
      }
    });

    it('terminalizes a running turn when action decision persistence fails', async () => {
      const db = app.getDatabase();
      const conversationId = 'private:qq-618002';
      setSuccessfulPiRuntime();
      db.exec(`
        CREATE TEMP TRIGGER fail_turn_action_decision_insert
        BEFORE INSERT ON action_decisions
        WHEN (
          SELECT conversation_id FROM agent_turns WHERE id = NEW.turn_id
        ) = '${conversationId}'
        BEGIN
          SELECT RAISE(ABORT, 'forced action decision insert failure');
        END
      `);

      try {
        const response = await postEvent({
          post_type: 'message',
          message_type: 'private',
          message_id: 918002,
          user_id: 618002,
          message: 'trigger action decision persistence failure',
          raw_message: 'trigger action decision persistence failure',
          sender: { user_id: 618002, nickname: 'DecisionFailureUser' },
          time: Math.floor(Date.now() / 1000),
        } satisfies OneBotMessage);

        expect(response.status).toBe(200);
        expect(app.getEventProcessingFailures()).toHaveLength(1);
        const turn = getTurnForMessage('qq-918002');
        expect(turn).toBeDefined();
        if (!turn) {
          throw new Error('Expected action decision failure turn');
        }
        const contextTrace = getContextTraceForMessage('qq-918002');

        expect(turn.status).toBe('failed');
        expect(turn.completed_at).toBeGreaterThan(0);
        expect(turn.context_pack_id).toBe(contextTrace?.id);
        expect(turn.action_decision_id).toBeNull();
        expect(turn.response_text).toContain('forced action decision insert failure');
        expect(contextTrace?.turn_id).toBe(turn.id);
        expect(getActionRowsForMessage('qq-918002')).toEqual([]);
        expect(countBotResponseRawEvents(conversationId)).toBe(0);
        expect(countBotResponseRows(conversationId)).toBe(0);
        expect(countNonTerminalTurnsForMessage('qq-918002')).toBe(0);
        expectLinkedEventProcessingFailure(turn, 'social_decision');
        expectNoForeignKeyViolations();
      } finally {
        db.exec('DROP TRIGGER IF EXISTS fail_turn_action_decision_insert');
        app.clearEventProcessingFailuresForTesting();
        setSuccessfulPiRuntime();
      }
    });

    it('rolls back evaluator evidence and does not send when an evaluated action insert fails', async () => {
      class ApprovedFailureEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          return {
            domain: 'social',
            decisionId: 'eval-action-insert-rollback',
            requestId: request.requestId,
            decision: 'approve',
            reason: 'approved before induced persistence failure',
            confidence: 0.84,
            riskLevel: 'medium',
            decidedAt: new Date('2026-07-10T04:06:07.890Z'),
            evaluatorVersion: 'test-action-insert-rollback',
          };
        }
      }

      const db = app.getDatabase();
      const conversationId = 'private:qq-618006';
      const sentMessages: SentMessage[] = [];
      app.setSocialEvaluatorForTesting(new ApprovedFailureEvaluator());
      setReplyingPiRuntime('This evaluated response must not be sent.');
      setCapturingMessageSender(sentMessages);
      const riskAttention = forceRiskAttentionForTesting();
      db.exec(`
        CREATE TEMP TRIGGER fail_evaluated_action_decision_insert
        BEFORE INSERT ON action_decisions
        WHEN (
          SELECT conversation_id FROM agent_turns WHERE id = NEW.turn_id
        ) = '${conversationId}'
        BEGIN
          SELECT RAISE(ABORT, 'forced evaluated action decision insert failure');
        END
      `);

      try {
        const response = await postEvent({
          post_type: 'message',
          message_type: 'private',
          message_id: 918006,
          user_id: 618006,
          message: 'trigger evaluated action decision persistence failure',
          raw_message: 'trigger evaluated action decision persistence failure',
          sender: { user_id: 618006, nickname: 'EvaluatedDecisionFailureUser' },
          time: Math.floor(Date.now() / 1000),
        } satisfies OneBotMessage);

        expect(response.status).toBe(200);
        expect(sentMessages).toEqual([]);
        expect(getActionRowsForMessage('qq-918006')).toEqual([]);
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions WHERE id = ?')
            .get('eval-action-insert-rollback')
        ).toEqual({ count: 0 });

        const turn = getTurnForMessage('qq-918006');
        expect(turn).toMatchObject({
          status: 'failed',
          action_decision_id: null,
        });
        expectNoForeignKeyViolations();
      } finally {
        db.exec('DROP TRIGGER IF EXISTS fail_evaluated_action_decision_insert');
        app.clearEventProcessingFailuresForTesting();
        riskAttention.mockRestore();
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('rolls back bot response rows and terminalizes the turn when bot chat persistence fails', async () => {
      const db = app.getDatabase();
      const conversationId = 'private:qq-618003';
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('reply delivered before local bot chat persistence fails');
      setCapturingMessageSender(sentMessages);
      db.exec(`
        CREATE TEMP TRIGGER fail_turn_bot_chat_insert
        BEFORE INSERT ON chat_messages
        WHEN NEW.conversation_id = '${conversationId}' AND NEW.sender_id = 'bot-self'
        BEGIN
          SELECT RAISE(ABORT, 'forced bot chat insert failure');
        END
      `);

      try {
        const response = await postEvent({
          post_type: 'message',
          message_type: 'private',
          message_id: 918003,
          user_id: 618003,
          message: 'trigger bot chat persistence failure',
          raw_message: 'trigger bot chat persistence failure',
          sender: { user_id: 618003, nickname: 'BotChatFailureUser' },
          time: Math.floor(Date.now() / 1000),
        } satisfies OneBotMessage);

        expect(response.status).toBe(200);
        expect(app.getEventProcessingFailures()).toHaveLength(1);
        expect(sentMessages).toHaveLength(1);
        const turn = getTurnForMessage('qq-918003');
        expect(turn).toBeDefined();
        if (!turn) {
          throw new Error('Expected bot chat failure turn');
        }
        const contextTrace = getContextTraceForMessage('qq-918003');
        const actionRows = getActionRowsForMessage('qq-918003');

        expect(turn.status).toBe('failed');
        expect(turn.completed_at).toBeGreaterThan(0);
        expect(turn.context_pack_id).toBe(contextTrace?.id);
        expect(turn.action_decision_id).toBe(actionRows[0]?.decision_id);
        expect(turn.response_text).toContain('forced bot chat insert failure');
        expect(contextTrace?.turn_id).toBe(turn.id);
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          turn_id: turn.id,
          status: 'success',
          executed_message_id: sentMessages[0]?.messageId,
        });
        expect(countBotResponseRawEvents(conversationId)).toBe(0);
        expect(countBotResponseRows(conversationId)).toBe(0);
        expect(countNonTerminalTurnsForMessage('qq-918003')).toBe(0);
        expectLinkedEventProcessingFailure(turn, 'bot_response_persist');
        expectNoForeignKeyViolations();
      } finally {
        db.exec('DROP TRIGGER IF EXISTS fail_turn_bot_chat_insert');
        app.clearEventProcessingFailuresForTesting();
        setSuccessfulPiRuntime();
        setCapturingMessageSender([]);
      }
    });

    it('rolls back derived admission when auto-extraction enqueue fails before Pi or send', async () => {
      const db = app.getDatabase();
      const conversationId = 'qq-group-718007';
      const sentMessages: SentMessage[] = [];
      let piCalls = 0;
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'Auto-extraction failure must happen before this reply.',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);
      db.exec(`
        CREATE TEMP TRIGGER fail_auto_extraction_enqueue
        BEFORE INSERT ON jobs
        WHEN NEW.type = 'extraction'
        BEGIN
          SELECT RAISE(ABORT, 'forced extraction enqueue failure');
        END
      `);

      try {
        const response = await postEvent({
          post_type: 'message',
          message_type: 'group',
          message_id: 918007,
          user_id: 618007,
          group_id: 718007,
          message: '我喜欢 合成事务回滚',
          raw_message: '我喜欢 合成事务回滚',
          sender: {
            user_id: 618007,
            nickname: 'SyntheticExtractionFailureUser',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        } satisfies OneBotMessage);

        expect(response.status).toBe(200);
        expect(app.getEventProcessingFailures()).toHaveLength(1);
        const raw = db.prepare(
          'SELECT id FROM raw_events WHERE platform_event_id = ?',
        ).get('qq-918007') as { id: string } | undefined;
        expect(raw).toBeDefined();
        expect(getPersistedMessage('qq-918007')).toBeUndefined();
        expect(piCalls).toBe(0);
        expect(sentMessages).toEqual([]);
        expect(db.prepare(
          'SELECT COUNT(*) AS count FROM agent_turns WHERE trigger_event_id = ?',
        ).get(raw?.id)).toEqual({ count: 0 });
        expect(db.prepare(
          'SELECT COUNT(*) AS count FROM attention_candidates WHERE source_raw_event_id = ?',
        ).get(raw?.id)).toEqual({ count: 0 });
        expect(countBotResponseRawEvents(conversationId)).toBe(0);
        expect(countBotResponseRows(conversationId)).toBe(0);
        expect(db.prepare(
          "SELECT COUNT(*) AS count FROM jobs WHERE type = 'extraction' AND idempotency_key = ?",
        ).get(`extraction:auto:${raw?.id}`)).toEqual({ count: 0 });
        expect(db.prepare(
          'SELECT state, reason_code FROM event_processing_admissions WHERE raw_event_id = ?',
        ).get(raw?.id)).toEqual({ state: 'failed', reason_code: 'handler_failed' });

        const failure = db.prepare(
          `SELECT raw_event_id, turn_id, stage, conversation_type,
                  error_name, error_message_hash, details
             FROM event_processing_failures
            WHERE raw_event_id = ?`,
        ).get(raw?.id) as PersistedEventProcessingFailureRow | undefined;
        expect(failure).toMatchObject({
          raw_event_id: raw?.id,
          turn_id: null,
          stage: 'memory_extraction_enqueue',
          conversation_type: 'group',
          error_name: 'SqliteError',
        });
        expect(failure?.error_message_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.parse(failure?.details ?? '{}')).toMatchObject({
          rawEventStored: true,
          turnStarted: false,
          stage: 'memory_extraction_enqueue',
          conversationType: 'group',
        });
        expect(failure?.details).not.toContain('我喜欢 合成事务回滚');
        expect(failure?.details).not.toContain('forced extraction enqueue failure');
        expectNoForeignKeyViolations();
      } finally {
        db.exec('DROP TRIGGER IF EXISTS fail_auto_extraction_enqueue');
        app.clearEventProcessingFailuresForTesting();
        setSuccessfulPiRuntime();
        setCapturingMessageSender([]);
      }
    });

    it('terminalizes the fully linked turn when completion persistence fails', async () => {
      const db = app.getDatabase();
      const conversationId = 'private:qq-618004';
      setSuccessfulPiRuntime();
      db.exec(`
        CREATE TEMP TRIGGER fail_turn_completion_update
        BEFORE UPDATE OF status ON agent_turns
        WHEN OLD.conversation_id = '${conversationId}' AND NEW.status = 'completed'
        BEGIN
          SELECT RAISE(ABORT, 'forced turn completion update failure');
        END
      `);

      try {
        const response = await postEvent({
          post_type: 'message',
          message_type: 'private',
          message_id: 918004,
          user_id: 618004,
          message: 'trigger turn completion persistence failure',
          raw_message: 'trigger turn completion persistence failure',
          sender: { user_id: 618004, nickname: 'CompletionFailureUser' },
          time: Math.floor(Date.now() / 1000),
        } satisfies OneBotMessage);

        expect(response.status).toBe(200);
        expect(app.getEventProcessingFailures()).toHaveLength(1);
        const turn = getTurnForMessage('qq-918004');
        expect(turn).toBeDefined();
        if (!turn) {
          throw new Error('Expected completion failure turn');
        }
        const contextTrace = getContextTraceForMessage('qq-918004');
        const actionRows = getActionRowsForMessage('qq-918004');

        expect(turn.status).toBe('failed');
        expect(turn.completed_at).toBeGreaterThan(0);
        expect(turn.context_pack_id).toBe(contextTrace?.id);
        expect(turn.action_decision_id).toBe(actionRows[0]?.decision_id);
        expect(turn.response_text).toContain('forced turn completion update failure');
        expect(contextTrace?.turn_id).toBe(turn.id);
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          turn_id: turn.id,
          action_type: 'silent_store',
          status: 'success',
        });
        expect(countBotResponseRawEvents(conversationId)).toBe(0);
        expect(countBotResponseRows(conversationId)).toBe(0);
        expect(countNonTerminalTurnsForMessage('qq-918004')).toBe(0);
        expectLinkedEventProcessingFailure(turn, 'turn_complete');
        expectNoForeignKeyViolations();
      } finally {
        db.exec('DROP TRIGGER IF EXISTS fail_turn_completion_update');
        app.clearEventProcessingFailuresForTesting();
        setSuccessfulPiRuntime();
      }
    });
  });

  describe('Ingress replay idempotency', () => {
    it('claims one canonical raw event and downstream chain for OneBot retries', async () => {
      const db = app.getDatabase();
      const replayStartedAt = Date.now();
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('deduplicated reply');
      setCapturingMessageSender(sentMessages);

      const firstEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 812345001,
        user_id: 812345101,
        message: 'first writer payload',
        raw_message: 'first writer payload',
        sender: { user_id: 812345101, nickname: 'ReplayOne' },
        time: Math.floor(Date.now() / 1000),
      };
      const otherConversationEvent: OneBotMessage = {
        ...firstEvent,
        user_id: 812345102,
        sender: { user_id: 812345102, nickname: 'ReplayTwo' },
        message: 'same platform id in another conversation',
        raw_message: 'same platform id in another conversation',
      };
      const concurrentEvent: OneBotMessage = {
        ...firstEvent,
        message_id: 812345002,
        user_id: 812345103,
        sender: { user_id: 812345103, nickname: 'ReplayThree' },
        message: 'concurrent first writer',
        raw_message: 'concurrent first writer',
      };
      const crossTransportEvent: OneBotMessage = {
        ...firstEvent,
        message_id: 812345003,
        user_id: 812345104,
        sender: { user_id: 812345104, nickname: 'ReplayFour' },
        message: 'http then websocket replay',
        raw_message: 'http then websocket replay',
      };

      try {
        const firstResponse = await postEvent(firstEvent);
        const changedReplayResponse = await postEvent({
          ...firstEvent,
          message: 'changed replay payload must not replace the first',
          raw_message: 'changed replay payload must not replace the first',
        });
        const otherConversationResponse = await postEvent(otherConversationEvent);
        const concurrentResponses = await Promise.all([
          sendEvent(concurrentEvent),
          sendEvent(concurrentEvent),
          sendEvent(concurrentEvent),
        ]);
        await app.waitForIdle();
        const crossTransportResponse = await postEvent(crossTransportEvent);
        const crossTransportReplay = app.dispatchOneBotEventForTesting(crossTransportEvent, 'ws');
        await app.waitForIdle();
        expect(crossTransportReplay).toBe('duplicate');

        for (const response of [
          firstResponse,
          changedReplayResponse,
          otherConversationResponse,
          ...concurrentResponses,
          crossTransportResponse,
        ]) {
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ status: 'ok' });
        }

        const canonicalRows = db.prepare(
          `SELECT id, conversation_id, payload
             FROM raw_events
            WHERE platform = 'qq'
              AND type = 'chat.message.received'
              AND platform_event_id = ?
            ORDER BY conversation_id`
        ).all('qq-812345001') as Array<{
          id: string;
          conversation_id: string;
          payload: string;
        }>;
        expect(canonicalRows).toHaveLength(2);
        expect(canonicalRows.map((row) => row.conversation_id)).toEqual([
          'private:qq-812345101',
          'private:qq-812345102',
        ]);

        const firstCanonical = canonicalRows.find(
          (row) => row.conversation_id === 'private:qq-812345101'
        );
        expect(firstCanonical).toBeDefined();
        const firstPayload = JSON.parse(firstCanonical?.payload ?? '{}') as ChatMessageReceived;
        expect(firstPayload.message.content.text).toBe('first writer payload');
        expect(firstPayload.message.content.text).not.toContain('changed replay payload');

        const concurrentCanonical = db.prepare(
          `SELECT id
             FROM raw_events
            WHERE platform = 'qq'
              AND type = 'chat.message.received'
              AND conversation_id = ?
              AND platform_event_id = ?`
        ).get('private:qq-812345103', 'qq-812345002') as { id: string } | undefined;
        expect(concurrentCanonical).toBeDefined();
        const crossTransportCanonical = db.prepare(
          `SELECT id
             FROM raw_events
            WHERE platform = 'qq'
              AND type = 'chat.message.received'
              AND conversation_id = ?
              AND platform_event_id = ?`
        ).get('private:qq-812345104', 'qq-812345003') as { id: string } | undefined;
        expect(crossTransportCanonical).toBeDefined();

        for (const rawEventId of [
          firstCanonical?.id,
          canonicalRows.find((row) => row.conversation_id === 'private:qq-812345102')?.id,
          concurrentCanonical?.id,
          crossTransportCanonical?.id,
        ]) {
          expect(rawEventId).toBeDefined();
          expect(
            db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE raw_event_id = ?').get(rawEventId)
          ).toEqual({ count: 1 });
          expect(
            db.prepare('SELECT COUNT(*) AS count FROM agent_turns WHERE trigger_event_id = ?').get(rawEventId)
          ).toEqual({ count: 1 });
          expect(
            db.prepare('SELECT COUNT(*) AS count FROM event_processing_admissions WHERE raw_event_id = ?')
              .get(rawEventId)
          ).toEqual({ count: 1 });
        }

        const firstReceipts = db.prepare(
          `SELECT disposition, received_at
             FROM event_ingress_receipts
            WHERE raw_event_id = ?
            ORDER BY received_at, id`
        ).all(firstCanonical?.id) as Array<{ disposition: string; received_at: number }>;
        expect(firstReceipts.map((row) => row.disposition).sort()).toEqual(['accepted', 'duplicate']);
        expect(firstReceipts.every((row) => (
          Number.isSafeInteger(row.received_at)
          && row.received_at >= replayStartedAt
          && row.received_at <= Date.now()
        ))).toBe(true);

        const concurrentReceipts = db.prepare(
          `SELECT disposition
             FROM event_ingress_receipts
            WHERE raw_event_id = ?
            ORDER BY received_at, id`
        ).all(concurrentCanonical?.id) as Array<{ disposition: string }>;
        expect(concurrentReceipts.map((row) => row.disposition).sort()).toEqual([
          'accepted',
          'duplicate',
          'duplicate',
        ]);

        const crossTransportReceipts = db.prepare(
          `SELECT transport, disposition
             FROM event_ingress_receipts
            WHERE raw_event_id = ?
            ORDER BY transport`
        ).all(crossTransportCanonical?.id) as Array<{
          transport: string;
          disposition: string;
        }>;
        expect(crossTransportReceipts).toEqual([
          { transport: 'http', disposition: 'accepted' },
          { transport: 'ws', disposition: 'duplicate' },
        ]);

        expect(sentMessages).toHaveLength(4);
        expect(countBotResponseRows('private:qq-812345101')).toBe(1);
        expect(countBotResponseRows('private:qq-812345102')).toBe(1);
        expect(countBotResponseRows('private:qq-812345103')).toBe(1);
        expect(countBotResponseRows('private:qq-812345104')).toBe(1);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('accepts missing or malformed message ids without creating a false dedupe key', async () => {
      const db = app.getDatabase();
      const sentMessages: SentMessage[] = [];
      let piCalls = 0;
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'should stay silent',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      const baseEvent = {
        post_type: 'message',
        message_type: 'group',
        user_id: 812345210,
        group_id: 812345209,
        message: 'no stable message id',
        raw_message: 'no stable message id',
        sender: { user_id: 812345210, nickname: 'NoStableId' },
        time: Math.floor(Date.now() / 1000),
      };

      try {
        for (const event of [
          baseEvent,
          baseEvent,
          { ...baseEvent, message_id: 'qq-group-812345211' },
        ]) {
          const response = await postEvent(event);
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ status: 'ok' });
        }

        const rows = db.prepare(
          `SELECT re.id, re.platform_event_id, cm.message_id
             FROM raw_events re
             JOIN chat_messages cm ON cm.raw_event_id = re.id
            WHERE re.type = 'chat.message.received'
              AND re.conversation_id = ?
            ORDER BY re.created_at, re.id`
        ).all('qq-group-812345209') as Array<{
          id: string;
          platform_event_id: string | null;
          message_id: string;
        }>;

        expect(rows).toHaveLength(3);
        expect(rows.every((row) => row.platform_event_id === null)).toBe(true);
        expect(rows.every((row) => /^qq-local-/.test(row.message_id))).toBe(true);
        expect(new Set(rows.map((row) => row.message_id)).size).toBe(3);

        const placeholders = rows.map(() => '?').join(', ');
        const receipts = db.prepare(
          `SELECT transport, disposition
             FROM event_ingress_receipts
            WHERE raw_event_id IN (${placeholders})
            ORDER BY received_at, id`
        ).all(...rows.map((row) => row.id));
        expect(receipts).toEqual([
          { transport: 'http', disposition: 'accepted' },
          { transport: 'http', disposition: 'accepted' },
          { transport: 'http', disposition: 'accepted' },
        ]);
        expect(piCalls).toBe(0);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('returns bounded 503 without partial rows when the canonical claim fails', async () => {
      const db = app.getDatabase();
      const rawSecret = 'api_key=sk-ingress-claim-secret-qq-812345199';
      const event: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 812345099,
        user_id: 812345199,
        message: 'retry after durable claim failure',
        raw_message: 'retry after durable claim failure',
        sender: { user_id: 812345199, nickname: 'ClaimRetry' },
        time: Math.floor(Date.now() / 1000),
      };
      setSuccessfulPiRuntime();

      db.exec(`
        CREATE TEMP TRIGGER fail_ingress_claim
        BEFORE INSERT ON event_ingress_receipts
        WHEN EXISTS (
          SELECT 1
            FROM raw_events
           WHERE id = NEW.raw_event_id
             AND platform_event_id = 'qq-812345099'
        )
        BEGIN
          SELECT RAISE(ABORT, '${rawSecret}');
        END;
      `);

      try {
        const failed = await sendEvent(event);
        expect(failed.status).toBe(503);
        const failurePayload = await failed.json();
        expect(failurePayload).toEqual({ error: 'event_unavailable' });
        expect(JSON.stringify(failurePayload)).not.toContain(rawSecret);
        expect(JSON.stringify(failurePayload)).not.toContain('812345199');
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM raw_events WHERE platform_event_id = ?')
            .get('qq-812345099')
        ).toEqual({ count: 0 });
        expect(
          db.prepare(
            `SELECT COUNT(*) AS count
               FROM event_ingress_receipts
              WHERE raw_event_id IN (
                SELECT id FROM raw_events WHERE platform_event_id = ?
              )`
          ).get('qq-812345099')
        ).toEqual({ count: 0 });
      } finally {
        db.exec('DROP TRIGGER IF EXISTS fail_ingress_claim');
      }

      const retry = await postEvent(event);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ status: 'ok' });
      const canonical = db.prepare(
        'SELECT id FROM raw_events WHERE platform_event_id = ?'
      ).get('qq-812345099') as { id: string } | undefined;
      expect(canonical).toBeDefined();
      expect(
        db.prepare(
          'SELECT transport, disposition FROM event_ingress_receipts WHERE raw_event_id = ?'
        ).all(canonical?.id)
      ).toEqual([{ transport: 'http', disposition: 'accepted' }]);
      expectNoForeignKeyViolations();
    });

    it('rolls back the raw event and receipt when admission insertion fails', async () => {
      const db = app.getDatabase();
      const event: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 812345098,
        user_id: 812345198,
        message: 'retry after durable admission failure',
        raw_message: 'retry after durable admission failure',
        sender: { user_id: 812345198, nickname: 'AdmissionRetry' },
        time: Math.floor(Date.now() / 1000),
      };
      setSuccessfulPiRuntime();

      db.exec(`
        CREATE TEMP TRIGGER fail_event_admission
        BEFORE INSERT ON event_processing_admissions
        WHEN EXISTS (
          SELECT 1
            FROM raw_events
           WHERE id = NEW.raw_event_id
             AND platform_event_id = 'qq-812345098'
        )
        BEGIN
          SELECT RAISE(ABORT, 'synthetic admission failure');
        END;
      `);

      try {
        const failed = await sendEvent(event);
        expect(failed.status).toBe(503);
        expect(await failed.json()).toEqual({ error: 'event_unavailable' });
        expect(db.prepare(
          'SELECT COUNT(*) AS count FROM raw_events WHERE platform_event_id = ?'
        ).get('qq-812345098')).toEqual({ count: 0 });
        expect(db.prepare(
          `SELECT COUNT(*) AS count
             FROM event_ingress_receipts
            WHERE raw_event_id IN (
              SELECT id FROM raw_events WHERE platform_event_id = ?
            )`
        ).get('qq-812345098')).toEqual({ count: 0 });
        expect(db.prepare(
          `SELECT COUNT(*) AS count
             FROM event_processing_admissions
            WHERE raw_event_id IN (
              SELECT id FROM raw_events WHERE platform_event_id = ?
            )`
        ).get('qq-812345098')).toEqual({ count: 0 });
      } finally {
        db.exec('DROP TRIGGER IF EXISTS fail_event_admission');
      }

      const retry = await postEvent(event);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ status: 'ok' });
      const canonical = db.prepare(
        'SELECT id FROM raw_events WHERE platform_event_id = ?'
      ).get('qq-812345098') as { id: string } | undefined;
      expect(canonical).toBeDefined();
      expect(db.prepare(
        'SELECT COUNT(*) AS count FROM event_ingress_receipts WHERE raw_event_id = ?'
      ).get(canonical?.id)).toEqual({ count: 1 });
      expect(db.prepare(
        'SELECT state, reason_code FROM event_processing_admissions WHERE raw_event_id = ?'
      ).get(canonical?.id)).toEqual({ state: 'completed', reason_code: null });
      expectNoForeignKeyViolations();
    });
  });

  describe('Private message flow', () => {
    it('keeps accepted raw evidence but denies a disabled account before derived processing', async () => {
      const db = app.getDatabase();
      const canonicalUserId = 'user-disabled-ingress';
      const platformAccountId = '813450101';
      const platformEventId = 'qq-813450001';
      const seedTimestamp = Date.UTC(2026, 6, 10);
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];

      db.prepare(
        'INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)'
      ).run(canonicalUserId, seedTimestamp, seedTimestamp);
      db.prepare(
        `INSERT INTO platform_accounts (
          platform, platform_account_id, canonical_user_id, account_type,
          verified_level, status, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'qq',
        platformAccountId,
        canonicalUserId,
        'private',
        'observed',
        'disabled',
        seedTimestamp,
        seedTimestamp,
      );

      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'disabled account must not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const response = await postEvent({
          post_type: 'message',
          message_type: 'private',
          message_id: 813450001,
          user_id: 813450101,
          message: 'disabled account must stop after ingress',
          raw_message: 'disabled account must stop after ingress',
          sender: {
            user_id: 813450101,
            nickname: 'DisabledAccount',
          },
          time: Math.floor(Date.now() / 1000),
        } satisfies OneBotMessage);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const rawEvent = db
          .prepare('SELECT id FROM raw_events WHERE platform_event_id = ?')
          .get(platformEventId) as { id: string } | undefined;
        expect(rawEvent).toBeDefined();
        expect(
          db.prepare(
            'SELECT transport, disposition FROM event_ingress_receipts WHERE raw_event_id = ?'
          ).all(rawEvent?.id)
        ).toEqual([{ transport: 'http', disposition: 'accepted' }]);
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE raw_event_id = ?')
            .get(rawEvent?.id)
        ).toEqual({ count: 0 });
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM agent_turns WHERE trigger_event_id = ?')
            .get(rawEvent?.id)
        ).toEqual({ count: 0 });
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM display_profiles WHERE canonical_user_id = ?')
            .get(canonicalUserId)
        ).toEqual({ count: 0 });
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM nickname_history WHERE canonical_user_id = ?')
            .get(canonicalUserId)
        ).toEqual({ count: 0 });
        expect(
          db.prepare('SELECT last_seen_at FROM canonical_users WHERE id = ?').get(canonicalUserId)
        ).toEqual({ last_seen_at: seedTimestamp });
        expect(
          db.prepare(
            `SELECT status, last_seen_at
             FROM platform_accounts
             WHERE platform = ? AND platform_account_id = ?`
          ).get('qq', platformAccountId)
        ).toEqual({ status: 'disabled', last_seen_at: seedTimestamp });
        expect(piCalls).toBe(0);
        expect(sentMessages).toHaveLength(0);
        expect(app.getEventProcessingFailures()).toHaveLength(0);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('should accept and process private message', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 12345,
        user_id: 10001,
        message: '你好',
        raw_message: '你好',
        sender: {
          user_id: 10001,
          nickname: 'TestUser',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');

      const persisted = getPersistedMessage('qq-12345');
      expect(persisted).toBeDefined();
      expect(persisted?.raw_event_id).toBe(persisted?.id);
      expect(persisted?.raw_type).toBe('chat.message.received');
      expect(persisted?.conversation_id).toBe('private:qq-10001');
      expect(persisted?.conversation_type).toBe('private');
      expect(persisted?.sender_id).toBe('qq-10001');
      expect(persisted?.text).toBe('你好');

      const turn = getTurnForMessage('qq-12345');
      expect(turn).toBeDefined();
      expect(turn?.status).toBe('completed');
      expect(turn?.trigger_event_id).toBe(persisted?.raw_event_id);
      expect(turn?.action_decision_id).toBeDefined();
      expect(turn?.conversation_id).toBe('private:qq-10001');
      expect(turn?.context_pack_id).toBeDefined();
      expect(turn?.pi_provider).toBe('mock');
      expect(turn?.pi_model).toBe('mock');
      expect(turn?.tokens_total).toBe(0);
      expect(turn?.completed_at).toBeGreaterThan(0);

      const contextTrace = getContextTraceForMessage('qq-12345');
      expect(contextTrace).toBeDefined();
      expect(contextTrace?.turn_id).toBe(turn?.id);
      expect(contextTrace?.conversation_id).toBe('private:qq-10001');
      expect(contextTrace?.conversation_type).toBe('private');
      const recentMessageIds = JSON.parse(contextTrace?.recent_message_ids ?? '[]') as string[];
      expect(recentMessageIds).toContain(persisted?.id);
      expect(recentMessageIds.filter((messageId) => messageId === persisted?.id)).toHaveLength(1);
      expect(recentMessageIds).not.toContain('qq-12345');
      expect(JSON.parse(contextTrace?.filters_applied ?? '[]')).toEqual(
        expect.arrayContaining([
          'state=active',
          'sensitivity!=secret/prohibited',
          'contextType=private',
          'visibility_scope_filter',
        ])
      );
      expect(JSON.parse(contextTrace?.injected_identity_fields ?? '[]')).toEqual(
        expect.arrayContaining(['conversation_id', 'conversation_type', 'target_user_ref'])
      );
      expect(JSON.parse(contextTrace?.token_budget ?? '{}').used).toBeGreaterThan(0);
      expectNoForeignKeyViolations();
    });

    it('should handle private message with mention', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 12346,
        user_id: 10002,
        message: '@bot 今天天气怎么样？',
        raw_message: '@bot 今天天气怎么样？',
        sender: {
          user_id: 10002,
          nickname: 'TestUser2',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');
    });

    it('should ignore malformed private top-level identifiers and fall back to sender user id', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: '',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 0, total: 1 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent = {
          post_type: 'message',
          message_type: 'private',
          message_id: { value: 'private-malformed-message-id-should-not-persist' },
          user_id: true,
          message: 'private malformed identifiers should use sender fallback',
          raw_message: 'private malformed identifiers should use sender fallback',
          sender: {
            user_id: 91000,
            nickname: 'PrivateFallbackUser',
          },
          time: Math.floor(Date.now() / 1000),
        } as unknown as OneBotMessage;

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const row = app
          .getDatabase()
          .prepare(
            `SELECT cm.*, re.payload
             FROM chat_messages cm
             JOIN raw_events re ON re.id = cm.raw_event_id
             WHERE cm.text = ?
             ORDER BY cm.timestamp DESC
             LIMIT 1`
          )
          .get('private malformed identifiers should use sender fallback') as
          | (PersistedMessageRow & { payload: string })
          | undefined;

        expect(row).toMatchObject({
          conversation_id: 'private:qq-91000',
          conversation_type: 'private',
          group_id: null,
          sender_id: 'qq-91000',
          sender_role: null,
          text: 'private malformed identifiers should use sender fallback',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });
        expect(row?.message_id).toMatch(/^qq-local-/);

        const serializedRow = JSON.stringify(row);
        expect(serializedRow).not.toContain('qq-[object Object]');
        expect(serializedRow).not.toContain('qq-true');
        expect(serializedRow).not.toContain('private:qq-true');
        expect(serializedRow).not.toContain('private-malformed-message-id-should-not-persist');

        expect(piCalls).toBe(1);
        const turn = getTurnForMessage(row?.message_id ?? '');
        expect(turn).toMatchObject({
          conversation_id: 'private:qq-91000',
          trigger_event_id: row?.raw_event_id,
          status: 'completed',
          tokens_input: 1,
          tokens_output: 0,
          tokens_total: 1,
        });
        expect(getContextTraceForMessage(row?.message_id ?? '')).toMatchObject({
          conversation_id: 'private:qq-91000',
          conversation_type: 'private',
          group_id: null,
        });
        const actions = getActionRowsForMessage(row?.message_id ?? '');
        expect(actions).toHaveLength(1);
        expect(actions[0]).toMatchObject({
          turn_id: turn?.id,
          action_type: 'silent_store',
          status: 'success',
          executed_message_id: null,
        });
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should persist a failed agent turn when Pi returns failure', async () => {
      const rawSecret = 'sk-pi-returned-turn-secret-should-not-persist';
      const rawPlatformId = 'qq-1234567890';
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          return {
            turnId: input.turnId,
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 0, output: 0, total: 0 },
            status: 'failed',
            errorMessage: `mock pi failure api_key=${rawSecret} target=${rawPlatformId}`,
          };
        },
      });

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12351,
          user_id: 10007,
          message: '触发一次失败的 Pi 回合',
          raw_message: '触发一次失败的 Pi 回合',
          sender: {
            user_id: 10007,
            nickname: 'FailureUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        const turn = getTurnForMessage('qq-12351');
        expect(turn).toBeDefined();
        expect(turn?.status).toBe('failed');
        expect(turn?.response_text).toContain('mock pi failure');
        expect(turn?.response_text).toContain('[REDACTED:api_key_assignment]');
        expect(turn?.response_text).toContain('[REDACTED:platform_id]');
        expect(turn?.response_text).not.toContain(rawSecret);
        expect(turn?.response_text).not.toContain(rawPlatformId);
        expect(turn?.context_pack_id).toBeDefined();
        expect(turn?.completed_at).toBeGreaterThan(0);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('should persist action decision and execution for a private reply', async () => {
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('收到，我会处理。');
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12352,
          user_id: 10008,
          message: '请回复我',
          raw_message: '请回复我',
          sender: {
            user_id: 10008,
            nickname: 'ReplyUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        expect(sentMessages).toMatchObject([
          {
            target: {
              conversationId: 'private:qq-10008',
              conversationType: 'private',
              userId: 'qq-10008',
            },
            text: '收到，我会处理。',
          },
        ]);
        const sentMessageId = sentMessages[0]?.messageId;
        expect(sentMessageId).toBeDefined();

        const actionRows = getActionRowsForMessage('qq-12352');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]?.decided_by).toBe('pi');
        expect(actionRows[0]?.action_type).toBe('reply_full');
        expect(actionRows[0]?.status).toBe('success');
        expect(actionRows[0]?.executed_message_id).toBe(sentMessageId);
        const storedActions = JSON.parse(actionRows[0]?.actions ?? '[]') as Array<{
          type?: string;
          target?: {
            conversationId?: string;
            conversationType?: string;
            userId?: string;
            canonicalUserId?: string;
          };
          payload?: { text?: string };
        }>;
        expect(storedActions).toMatchObject([
          {
            type: 'reply_full',
            target: {
              conversationId: 'private:qq-10008',
              conversationType: 'private',
              userId: 'qq-10008',
            },
            payload: { text: '收到，我会处理。' },
          },
        ]);
        const identityRow = app
          .getDatabase()
          .prepare(
            `SELECT canonical_user_id
             FROM platform_accounts
             WHERE platform = ? AND platform_account_id = ?`
          )
          .get('qq', '10008') as { canonical_user_id: string } | undefined;
        expect(identityRow?.canonical_user_id).toBeDefined();
        expect(storedActions[0]?.target?.canonicalUserId).toBe(identityRow?.canonical_user_id);
        expect(storedActions[0]?.target?.canonicalUserId).not.toBe('qq-10008');

        const botMessage = getPersistedMessage(sentMessageId ?? '');
        expect(botMessage?.raw_type).toBe('bot.response');
        expect(botMessage?.sender_id).toBe('bot-self');
        expect(botMessage?.text).toBe('收到，我会处理。');
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('should provide controlled OneBot acceptance evidence for a full private reply lifecycle', async () => {
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('controlled acceptance reply');
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12901,
          user_id: 90901,
          message: 'controlled acceptance request',
          raw_message: 'controlled acceptance request',
          sender: {
            user_id: 90901,
            nickname: 'ControlledAcceptanceUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });
        expect(sentMessages).toHaveLength(1);

        const inboundMessage = getPersistedMessage('qq-12901');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-12901',
          conversation_id: 'private:qq-90901',
          conversation_type: 'private',
          sender_id: 'qq-90901',
          text: 'controlled acceptance request',
        });

        const turn = getTurnForMessage('qq-12901');
        expect(turn).toMatchObject({
          conversation_id: 'private:qq-90901',
          trigger_event_id: inboundMessage?.raw_event_id,
          pi_provider: 'mock',
          pi_model: 'mock',
          response_text: 'controlled acceptance reply',
          status: 'completed',
          tokens_input: 11,
          tokens_output: 7,
          tokens_total: 18,
        });
        expect(turn?.completed_at).toBeGreaterThan(0);

        const contextTrace = getContextTraceForMessage('qq-12901');
        expect(contextTrace).toMatchObject({
          id: turn?.context_pack_id,
          turn_id: turn?.id,
          conversation_id: 'private:qq-90901',
          conversation_type: 'private',
        });
        expect(JSON.parse(contextTrace?.recent_message_ids ?? '[]')).toContain(inboundMessage?.id);
        expect(JSON.parse(contextTrace?.filters_applied ?? '[]')).toEqual(
          expect.arrayContaining([
            'state=active',
            'sensitivity!=secret/prohibited',
            'contextType=private',
            'visibility_scope_filter',
          ])
        );
        expect(JSON.parse(contextTrace?.token_budget ?? '{}')).toMatchObject({
          max: expect.any(Number),
          used: expect.any(Number),
        });

        const actionRows = getActionRowsForMessage('qq-12901');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          turn_id: turn?.id,
          decided_by: 'pi',
          risk_level: 'low',
          evaluator_required: 0,
          action_type: 'reply_full',
          status: 'success',
          executed_message_id: sentMessages[0]?.messageId,
        });
        expect(turn?.action_decision_id).toBe(actionRows[0]?.decision_id);
        expect(JSON.parse(actionRows[0]?.actions ?? '[]')).toMatchObject([
          {
            type: 'reply_full',
            target: {
              conversationId: 'private:qq-90901',
              conversationType: 'private',
              userId: 'qq-90901',
            },
            payload: { text: 'controlled acceptance reply' },
          },
        ]);

        const outboundMessage = getPersistedMessage(sentMessages[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          raw_event_id: expect.any(String),
          conversation_id: 'private:qq-90901',
          conversation_type: 'private',
          sender_id: 'bot-self',
          text: 'controlled acceptance reply',
        });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('should provide controlled OneBot acceptance evidence for private quote and media metadata', async () => {
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('controlled private metadata acceptance reply');
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12902,
          user_id: 90902,
          message:
            '[CQ:reply,id=12901][CQ:image,url=https://example.test/private-image.png][CQ:record,url=https://example.test/private-audio.amr] 请看私聊附件',
          raw_message:
            '[CQ:reply,id=12901][CQ:image,url=https://example.test/private-image.png][CQ:record,url=https://example.test/private-audio.amr] 请看私聊附件',
          sender: {
            user_id: 90902,
            nickname: 'PrivateMetadataUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
          target: {
            conversationId: 'private:qq-90902',
            conversationType: 'private',
            userId: 'qq-90902',
          },
          text: 'controlled private metadata acceptance reply',
        });

        const inboundMessage = getPersistedMessage('qq-12902');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-12902',
          conversation_id: 'private:qq-90902',
          conversation_type: 'private',
          group_id: null,
          sender_id: 'qq-90902',
          text: '请看私聊附件',
          has_quote: 1,
          has_media: 1,
          mentions_bot: 0,
          reply_to_message_id: 'qq-12901',
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            conversationType?: string;
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
              quote?: { messageId: string; senderId: string };
            };
          };
        };
        expect(rawPayload.message?.conversationType).toBe('private');
        expect(rawPayload.message?.content?.text).toBe('请看私聊附件');
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBe('qq-12901');
        expect(rawPayload.message?.content?.quote).toEqual({
          messageId: 'qq-12901',
          senderId: 'unknown',
        });
        expect(rawPayload.message?.content?.media).toEqual([
          { type: 'image', url: 'https://example.test/private-image.png' },
          { type: 'audio', url: 'https://example.test/private-audio.amr' },
        ]);

        const turn = getTurnForMessage('qq-12902');
        expect(turn).toMatchObject({
          conversation_id: 'private:qq-90902',
          trigger_event_id: inboundMessage?.raw_event_id,
          pi_provider: 'mock',
          pi_model: 'mock',
          response_text: 'controlled private metadata acceptance reply',
          status: 'completed',
          tokens_input: 11,
          tokens_output: 7,
          tokens_total: 18,
        });
        expect(turn?.completed_at).toBeGreaterThan(0);

        const contextTrace = getContextTraceForMessage('qq-12902');
        expect(contextTrace).toMatchObject({
          id: turn?.context_pack_id,
          turn_id: turn?.id,
          conversation_id: 'private:qq-90902',
          conversation_type: 'private',
          group_id: null,
        });
        expect(JSON.parse(contextTrace?.recent_message_ids ?? '[]')).toContain(inboundMessage?.id);
        expect(JSON.parse(contextTrace?.filters_applied ?? '[]')).toEqual(
          expect.arrayContaining([
            'state=active',
            'sensitivity!=secret/prohibited',
            'contextType=private',
            'visibility_scope_filter',
          ])
        );

        const actionRows = getActionRowsForMessage('qq-12902');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          turn_id: turn?.id,
          decided_by: 'pi',
          risk_level: 'low',
          evaluator_required: 0,
          action_type: 'reply_full',
          status: 'success',
          executed_message_id: sentMessages[0]?.messageId,
        });
        expect(turn?.action_decision_id).toBe(actionRows[0]?.decision_id);
        expect(JSON.parse(actionRows[0]?.actions ?? '[]')).toMatchObject([
          {
            type: 'reply_full',
            target: {
              conversationId: 'private:qq-90902',
              conversationType: 'private',
              userId: 'qq-90902',
            },
            payload: { text: 'controlled private metadata acceptance reply' },
          },
        ]);

        const outboundMessage = getPersistedMessage(sentMessages[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          raw_event_id: expect.any(String),
          conversation_id: 'private:qq-90902',
          conversation_type: 'private',
          group_id: null,
          sender_id: 'bot-self',
          text: 'controlled private metadata acceptance reply',
          has_quote: 0,
          has_media: 0,
        });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('should process OneBot segment-array private metadata like CQ strings', async () => {
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('controlled private segment array acceptance reply');
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12903,
          user_id: 90903,
          message: [
            { type: 'reply', data: { id: 12901 } },
            { type: 'image', data: { url: 'https://example.test/private-segment-array-image.png' } },
            { type: 'record', data: { url: 'https://example.test/private-segment-array-audio.amr' } },
            { type: 'text', data: { text: ' 请解析私聊 segment array' } },
          ],
          raw_message: 'structured private segment array message',
          sender: {
            user_id: 90903,
            nickname: 'PrivateSegmentArrayUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
          target: {
            conversationId: 'private:qq-90903',
            conversationType: 'private',
            userId: 'qq-90903',
          },
          text: 'controlled private segment array acceptance reply',
        });

        const inboundMessage = getPersistedMessage('qq-12903');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-12903',
          conversation_id: 'private:qq-90903',
          conversation_type: 'private',
          group_id: null,
          sender_id: 'qq-90903',
          text: '请解析私聊 segment array',
          has_quote: 1,
          has_media: 1,
          mentions_bot: 0,
          reply_to_message_id: 'qq-12901',
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            conversationType?: string;
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
              quote?: { messageId: string; senderId: string };
            };
          };
        };
        expect(rawPayload.message?.conversationType).toBe('private');
        expect(rawPayload.message?.content?.text).toBe('请解析私聊 segment array');
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBe('qq-12901');
        expect(rawPayload.message?.content?.quote).toEqual({
          messageId: 'qq-12901',
          senderId: 'unknown',
        });
        expect(rawPayload.message?.content?.media).toEqual([
          { type: 'image', url: 'https://example.test/private-segment-array-image.png' },
          { type: 'audio', url: 'https://example.test/private-segment-array-audio.amr' },
        ]);

        const turn = getTurnForMessage('qq-12903');
        expect(turn).toMatchObject({
          conversation_id: 'private:qq-90903',
          trigger_event_id: inboundMessage?.raw_event_id,
          pi_provider: 'mock',
          pi_model: 'mock',
          response_text: 'controlled private segment array acceptance reply',
          status: 'completed',
          tokens_input: 11,
          tokens_output: 7,
          tokens_total: 18,
        });
        expect(turn?.completed_at).toBeGreaterThan(0);

        const contextTrace = getContextTraceForMessage('qq-12903');
        expect(contextTrace).toMatchObject({
          id: turn?.context_pack_id,
          turn_id: turn?.id,
          conversation_id: 'private:qq-90903',
          conversation_type: 'private',
          group_id: null,
        });
        expect(JSON.parse(contextTrace?.recent_message_ids ?? '[]')).toContain(inboundMessage?.id);
        expect(JSON.parse(contextTrace?.filters_applied ?? '[]')).toEqual(
          expect.arrayContaining([
            'state=active',
            'sensitivity!=secret/prohibited',
            'contextType=private',
            'visibility_scope_filter',
          ])
        );

        const actionRows = getActionRowsForMessage('qq-12903');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          turn_id: turn?.id,
          decided_by: 'pi',
          risk_level: 'low',
          evaluator_required: 0,
          action_type: 'reply_full',
          status: 'success',
          executed_message_id: sentMessages[0]?.messageId,
        });
        expect(JSON.parse(actionRows[0]?.actions ?? '[]')).toMatchObject([
          {
            type: 'reply_full',
            target: {
              conversationId: 'private:qq-90903',
              conversationType: 'private',
              userId: 'qq-90903',
            },
            payload: { text: 'controlled private segment array acceptance reply' },
          },
        ]);

        const outboundMessage = getPersistedMessage(sentMessages[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          raw_event_id: expect.any(String),
          conversation_id: 'private:qq-90903',
          conversation_type: 'private',
          group_id: null,
          sender_id: 'bot-self',
          text: 'controlled private segment array acceptance reply',
          has_quote: 0,
          has_media: 0,
        });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('should persist failed action execution without losing the turn when send fails', async () => {
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-action-send-failure-secret-should-not-persist';
      const rawPlatformId = 'qq-1234567890';
      const rawFailure = `simulated send failure api_key=${rawSecret} target=${rawPlatformId}`;
      setReplyingPiRuntime('这条回复会发送失败。');
      setCapturingMessageSender(sentMessages, rawFailure);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12353,
          user_id: 10009,
          message: '我喜欢 合成发送失败测试',
          raw_message: '我喜欢 合成发送失败测试',
          sender: {
            user_id: 10009,
            nickname: 'SendFailureUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        const turn = getTurnForMessage('qq-12353');
        expect(turn?.status).toBe('completed');
        expect(turn?.response_text).toBe('这条回复会发送失败。');

        const actionRows = getActionRowsForMessage('qq-12353');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]?.action_type).toBe('reply_full');
        expect(actionRows[0]?.status).toBe('failed');
        expect(actionRows[0]?.error_code).toBe('SEND_MESSAGE_FAILED');
        expect(actionRows[0]?.error_message).toContain('[REDACTED:api_key_assignment]');
        expect(actionRows[0]?.error_message).toContain('[REDACTED:platform_id]');
        expect(actionRows[0]?.error_message).not.toContain(rawSecret);
        expect(actionRows[0]?.error_message).not.toContain(rawPlatformId);
        expect(sentMessages).toHaveLength(1);
        expect(getPersistedMessage(sentMessages[0]?.messageId ?? '')).toBeUndefined();
        const source = getPersistedMessage('qq-12353');
        expect(source).toBeDefined();
        expect(app.getDatabase().prepare(
          "SELECT COUNT(*) AS count FROM jobs WHERE type = 'extraction' AND idempotency_key = ?",
        ).get(`extraction:auto:${source?.id}`)).toEqual({ count: 1 });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('should persist evaluator downgrade decisions for social actions', async () => {
      const evaluatorDecidedAt = new Date('2026-07-10T04:05:06.789Z');
      class DowngradeEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          return {
            domain: 'social',
            decisionId: 'eval-downgrade-test',
            requestId: request.requestId,
            decision: 'downgrade',
            reason: 'Test evaluator downgraded private full reply',
            confidence: 0.77,
            riskLevel: 'medium',
            decidedAt: evaluatorDecidedAt,
            evaluatorVersion: 'test-downgrade',
            downgradeAction: {
              from: 'reply_full',
              to: 'reply_short',
              reason: 'Use shorter reply for this evaluated path',
            },
          };
        }
      }

      const sentMessages: SentMessage[] = [];
      app.setSocialEvaluatorForTesting(new DowngradeEvaluator());
      setReplyingPiRuntime('这是一条会被评估器降级的回复。');
      setCapturingMessageSender(sentMessages);
      const riskAttention = forceRiskAttentionForTesting();

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12354,
          user_id: 10010,
          message: '请评估后回复',
          raw_message: '请评估后回复',
          sender: {
            user_id: 10010,
            nickname: 'DowngradeUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        expect(sentMessages).toHaveLength(1);

        const actionRows = getActionRowsForMessage('qq-12354');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]?.decided_by).toBe('evaluator');
        expect(actionRows[0]?.risk_level).toBe('medium');
        expect(actionRows[0]?.evaluator_required).toBe(1);
        expect(actionRows[0]?.evaluator_passed).toBe(1);
        expect(actionRows[0]?.evaluator_decision_id).toBe('eval-downgrade-test');
        expect(actionRows[0]?.action_type).toBe('reply_short');
        expect(actionRows[0]?.status).toBe('success');
        expect(JSON.parse(actionRows[0]?.suppressors ?? '[]')).toContain(
          'evaluator_downgrade:reply_full->reply_short'
        );

        const evidence = app.getDatabase().prepare(
          `SELECT
             source_raw.id AS source_raw_event_id,
             source_chat.id AS source_chat_message_id,
             turn.id AS turn_id,
             evaluator.id AS evaluator_decision_id,
             evaluator.request_id AS evaluator_request_id,
             evaluator.evaluator_version,
             evaluator.decided_at AS evaluator_decided_at,
             evaluator.source_event_ids,
             action.id AS action_decision_id,
             execution.id AS action_execution_id,
             response_raw.id AS response_raw_event_id,
             response_chat.id AS response_chat_row_id,
             response_chat.raw_event_id AS response_chat_raw_event_id,
             response_chat.message_id AS response_platform_message_id
           FROM chat_messages source_chat
           JOIN raw_events source_raw ON source_raw.id = source_chat.raw_event_id
           JOIN agent_turns turn ON turn.trigger_event_id = source_raw.id
           JOIN action_decisions action ON action.id = turn.action_decision_id
           JOIN evaluator_decisions evaluator ON evaluator.id = action.evaluator_decision_id
           JOIN action_executions execution ON execution.action_decision_id = action.id
           JOIN chat_messages response_chat ON response_chat.message_id = execution.executed_message_id
           JOIN raw_events response_raw ON response_raw.id = response_chat.raw_event_id
           WHERE source_chat.message_id = ?`
        ).get('qq-12354') as {
          source_raw_event_id: string;
          source_chat_message_id: string;
          turn_id: string;
          evaluator_decision_id: string;
          evaluator_request_id: string;
          evaluator_version: string;
          evaluator_decided_at: number;
          source_event_ids: string;
          action_decision_id: string;
          action_execution_id: string;
          response_raw_event_id: string;
          response_chat_row_id: string;
          response_chat_raw_event_id: string;
          response_platform_message_id: string;
        };

        expect(evidence).toMatchObject({
          source_chat_message_id: evidence.source_raw_event_id,
          turn_id: actionRows[0]?.turn_id,
          evaluator_decision_id: 'eval-downgrade-test',
          evaluator_version: 'test-downgrade',
          evaluator_decided_at: evaluatorDecidedAt.getTime(),
          action_decision_id: actionRows[0]?.decision_id,
        });
        expect(evidence.evaluator_request_id).toBeTruthy();
        expect(JSON.parse(evidence.source_event_ids)).toEqual([evidence.source_raw_event_id]);
        expect(evidence.action_execution_id).toBe(actionRows[0]?.execution_id);
        expect(evidence.response_chat_row_id).toBeTruthy();
        expect(evidence.response_raw_event_id).toBe(evidence.response_chat_raw_event_id);
        expect(evidence.response_platform_message_id).toBe(sentMessages[0]?.messageId);
        expectNoForeignKeyViolations();
      } finally {
        riskAttention.mockRestore();
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should persist bot response evidence for evaluator-modified reply_with_tool delivery', async () => {
      class ReplyWithToolEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          return {
            domain: 'social',
            decisionId: 'eval-reply-with-tool-test',
            requestId: request.requestId,
            decision: 'approve',
            reason: 'Test evaluator selected tool-backed reply delivery',
            confidence: 0.88,
            riskLevel: 'medium',
            decidedAt: new Date(),
            evaluatorVersion: 'test-reply-with-tool',
            modifiedAction: {
              ...request.proposedAction,
              type: 'reply_with_tool',
              payload: {
                text: '工具结果摘要回复。',
                toolCall: {
                  id: 'tc-e2e-reply-with-tool',
                  turnId: request.turnId,
                  toolName: 'group.recent_summary',
                  input: {},
                  requestedBy: 'pi',
                  actor: {
                    actorClass: 'user',
                  },
                  context: request.context,
                },
              },
              reason: 'Tool result is ready for delivery',
            },
          };
        }
      }

      const sentMessages: SentMessage[] = [];
      app.setSocialEvaluatorForTesting(new ReplyWithToolEvaluator());
      setReplyingPiRuntime('工具结果摘要回复。');
      setCapturingMessageSender(sentMessages);
      const riskAttention = forceRiskAttentionForTesting();

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12356,
          user_id: 10012,
          message: '请用工具结果回复',
          raw_message: '请用工具结果回复',
          sender: {
            user_id: 10012,
            nickname: 'ReplyWithToolUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]?.text).toBe('工具结果摘要回复。');

        const turn = getTurnForMessage('qq-12356');
        expect(turn?.status).toBe('completed');
        expect(turn?.response_text).toBe('工具结果摘要回复。');

        const actionRows = getActionRowsForMessage('qq-12356');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          decided_by: 'evaluator',
          evaluator_required: 1,
          evaluator_passed: 1,
          action_type: 'reply_with_tool',
          status: 'success',
          executed_message_id: sentMessages[0]?.messageId,
        });

        const outboundMessage = getPersistedMessage(sentMessages[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          raw_event_id: expect.any(String),
          conversation_id: 'private:qq-10012',
          conversation_type: 'private',
          sender_id: 'bot-self',
          text: '工具结果摘要回复。',
        });
        expectNoForeignKeyViolations();
      } finally {
        riskAttention.mockRestore();
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should persist the evaluator-modified delivered text as bot response evidence', async () => {
      class ModifiedTextEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          return {
            domain: 'social',
            decisionId: 'eval-modified-text-test',
            requestId: request.requestId,
            decision: 'approve',
            reason: 'Test evaluator replaced the outbound text',
            confidence: 0.86,
            riskLevel: 'medium',
            decidedAt: new Date(),
            evaluatorVersion: 'test-modified-text',
            modifiedAction: {
              ...request.proposedAction,
              type: 'reply_with_tool',
              target: {
                conversationId: 'private:qq-99999',
                conversationType: 'private',
                userId: 'qq-99999',
                canonicalUserId: 'user-evaluator-spoof',
              },
              payload: {
                text: '评估器改写后的实际发送文本。',
              },
              reason: 'Evaluator replaced draft text and attempted to retarget delivery',
            },
          };
        }
      }

      const sentMessages: SentMessage[] = [];
      app.setSocialEvaluatorForTesting(new ModifiedTextEvaluator());
      setReplyingPiRuntime('Pi 原始草稿不应作为已发送 bot.response。');
      setCapturingMessageSender(sentMessages);
      const riskAttention = forceRiskAttentionForTesting();

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12359,
          user_id: 10015,
          message: '请让评估器改写',
          raw_message: '请让评估器改写',
          sender: {
            user_id: 10015,
            nickname: 'ModifiedTextUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]?.text).toBe('评估器改写后的实际发送文本。');
        expect(sentMessages[0]?.target).toMatchObject({
          conversationId: 'private:qq-10015',
          conversationType: 'private',
          userId: 'qq-10015',
        });
        expect(sentMessages[0]?.target.conversationId).not.toBe('private:qq-99999');
        expect(sentMessages[0]?.target.userId).not.toBe('qq-99999');

        const turn = getTurnForMessage('qq-12359');
        expect(turn?.status).toBe('completed');
        expect(turn?.response_text).toBe('Pi 原始草稿不应作为已发送 bot.response。');

        const actionRows = getActionRowsForMessage('qq-12359');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          action_type: 'reply_with_tool',
          status: 'success',
          executed_message_id: sentMessages[0]?.messageId,
        });
        const storedActions = JSON.parse(actionRows[0]?.actions ?? '[]') as Array<{
          target?: {
            conversationId?: string;
            conversationType?: string;
            userId?: string;
            canonicalUserId?: string;
          };
          payload?: { text?: string };
        }>;
        const identityRow = app
          .getDatabase()
          .prepare(
            `SELECT canonical_user_id
             FROM platform_accounts
             WHERE platform = ? AND platform_account_id = ?`
          )
          .get('qq', '10015') as { canonical_user_id: string } | undefined;
        expect(identityRow?.canonical_user_id).toBeDefined();
        expect(storedActions[0]).toMatchObject({
          target: {
            conversationId: 'private:qq-10015',
            conversationType: 'private',
            userId: 'qq-10015',
            canonicalUserId: identityRow?.canonical_user_id,
          },
          payload: { text: '评估器改写后的实际发送文本。' },
        });
        expect(storedActions[0]?.target?.conversationId).not.toBe('private:qq-99999');
        expect(storedActions[0]?.target?.userId).not.toBe('qq-99999');
        expect(storedActions[0]?.target?.canonicalUserId).not.toBe('user-evaluator-spoof');

        const outboundMessage = getPersistedMessage(sentMessages[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          conversation_id: 'private:qq-10015',
          conversation_type: 'private',
          sender_id: 'bot-self',
          text: '评估器改写后的实际发送文本。',
        });
        expect(outboundMessage?.text).not.toBe('Pi 原始草稿不应作为已发送 bot.response。');
        expectNoForeignKeyViolations();
      } finally {
        riskAttention.mockRestore();
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-MEM-01 should deliver and persist corrected unsupported memory wording', async () => {
      const rawPiDraft = '已记住：response_style=compact';
      const correctedText = '收到：response_style=compact';
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime(rawPiDraft);
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12361,
          user_id: 10017,
          message: '请记住 response_style=compact',
          raw_message: '请记住 response_style=compact',
          sender: {
            user_id: 10017,
            nickname: 'MemoryClaimUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        expect(sentMessages).toHaveLength(1);

        const turn = getTurnForMessage('qq-12361');
        expect(turn).toMatchObject({
          status: 'completed',
          response_text: rawPiDraft,
        });

        const actionRows = getActionRowsForMessage('qq-12361');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          decided_by: 'pi',
          evaluator_required: 0,
          action_type: 'reply_full',
          status: 'success',
          executed_message_id: sentMessages[0]?.messageId,
        });
        const storedActions = JSON.parse(actionRows[0]?.actions ?? '[]') as Array<{
          payload?: { text?: string };
        }>;
        expect(storedActions[0]?.payload?.text).toBe(correctedText);
        expect(JSON.parse(actionRows[0]?.suppressors ?? '[]')).toContain(
          'memory_claim_truthfulness_guard',
        );
        expect(sentMessages[0]?.text).toBe(correctedText);

        const outboundMessage = getPersistedMessage(sentMessages[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          conversation_id: 'private:qq-10017',
          conversation_type: 'private',
          sender_id: 'bot-self',
          text: correctedText,
        });
        expect(outboundMessage?.text).not.toBe(turn?.response_text);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-MEM-01 should not echo a sensitive proposition in action or delivery text', async () => {
      const sensitiveProposition = 'api_key=sk-memory-claim-synthetic-secret-qq-1234567890';
      const rawPiDraft = `已记住：${sensitiveProposition}`;
      const correctedText = '收到。';
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime(rawPiDraft);
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12362,
          user_id: 10018,
          message: '请确认收到这段合成敏感格式。',
          raw_message: '请确认收到这段合成敏感格式。',
          sender: {
            user_id: 10018,
            nickname: 'SensitiveMemoryClaimUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]?.text).toBe(correctedText);
        expect(sentMessages[0]?.text).not.toContain(sensitiveProposition);

        const actionRows = getActionRowsForMessage('qq-12362');
        expect(actionRows).toHaveLength(1);
        const storedActions = JSON.parse(actionRows[0]?.actions ?? '[]') as Array<{
          payload?: { text?: string };
        }>;
        expect(storedActions[0]?.payload?.text).toBe(correctedText);
        expect(actionRows[0]?.actions).not.toContain(sensitiveProposition);
        expect(JSON.parse(actionRows[0]?.suppressors ?? '[]')).toContain(
          'memory_claim_truthfulness_guard',
        );

        const outboundMessage = getPersistedMessage(sentMessages[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          conversation_id: 'private:qq-10018',
          conversation_type: 'private',
          sender_id: 'bot-self',
          text: correctedText,
        });
        expect(outboundMessage?.text).not.toContain(sensitiveProposition);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should persist bot response evidence for folded-forward text fallback delivery', async () => {
      class FoldedForwardEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          return {
            domain: 'social',
            decisionId: 'eval-folded-forward-test',
            requestId: request.requestId,
            decision: 'approve',
            reason: 'Test evaluator selected folded-forward fallback delivery',
            confidence: 0.82,
            riskLevel: 'medium',
            decidedAt: new Date(),
            evaluatorVersion: 'test-folded-forward',
            modifiedAction: {
              ...request.proposedAction,
              type: 'send_folded_forward',
              payload: {
                text: '长回复折叠转发的安全摘要。',
              },
              reason: 'Long response should use folded-forward fallback',
            },
          };
        }
      }

      const sentMessages: SentMessage[] = [];
      app.setSocialEvaluatorForTesting(new FoldedForwardEvaluator());
      setReplyingPiRuntime('长回复折叠转发的安全摘要。');
      setCapturingMessageSender(sentMessages);
      const riskAttention = forceRiskAttentionForTesting();

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12357,
          user_id: 10013,
          message: '请发送长回复',
          raw_message: '请发送长回复',
          sender: {
            user_id: 10013,
            nickname: 'FoldedForwardUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]?.text).toBe('长回复折叠转发的安全摘要。');

        const turn = getTurnForMessage('qq-12357');
        expect(turn?.status).toBe('completed');
        expect(turn?.response_text).toBe('长回复折叠转发的安全摘要。');

        const actionRows = getActionRowsForMessage('qq-12357');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          decided_by: 'evaluator',
          evaluator_required: 1,
          evaluator_passed: 1,
          action_type: 'send_folded_forward',
          status: 'downgraded',
          executed_message_id: sentMessages[0]?.messageId,
        });

        const outboundMessage = getPersistedMessage(sentMessages[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          raw_event_id: expect.any(String),
          conversation_id: 'private:qq-10013',
          conversation_type: 'private',
          sender_id: 'bot-self',
          text: '长回复折叠转发的安全摘要。',
        });
        expectNoForeignKeyViolations();
      } finally {
        riskAttention.mockRestore();
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should record true react_only action execution without bot response evidence', async () => {
      class ReactOnlyEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          return {
            domain: 'social',
            decisionId: 'eval-react-only-test',
            requestId: request.requestId,
            decision: 'approve',
            reason: 'Test evaluator selected true reaction delivery',
            confidence: 0.84,
            riskLevel: 'medium',
            decidedAt: new Date(),
            evaluatorVersion: 'test-react-only',
            modifiedAction: {
              ...request.proposedAction,
              type: 'react_only',
              payload: {
                reaction: '👍',
                messageId: 'qq-12358',
              },
              reason: 'Use a lightweight reaction only',
            },
          };
        }
      }

      const fakeGateway = new FakeOneBot({
        capabilities: {
          reactions: { emojiLike: true, faceMessage: true },
        },
      });
      app.setSocialEvaluatorForTesting(new ReactOnlyEvaluator());
      setReplyingPiRuntime('👍');
      app.setMessageSenderForTesting(fakeGateway);
      const riskAttention = forceRiskAttentionForTesting();

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12358,
          user_id: 10014,
          message: '只用反应即可',
          raw_message: '只用反应即可',
          sender: {
            user_id: 10014,
            nickname: 'ReactOnlyUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        expect(fakeGateway.getSentMessages()).toHaveLength(0);
        expect(fakeGateway.getSentReactions()).toMatchObject([
          {
            messageId: 'qq-12358',
            emoji: '👍',
          },
        ]);
        fakeGateway.assertReactionSent('qq-12358', '👍');

        const turn = getTurnForMessage('qq-12358');
        expect(turn?.status).toBe('completed');
        expect(turn?.response_text).toBe('👍');

        const actionRows = getActionRowsForMessage('qq-12358');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          decided_by: 'evaluator',
          evaluator_required: 1,
          evaluator_passed: 1,
          action_type: 'react_only',
          status: 'success',
          executed_message_id: null,
        });

        expect(countBotResponseRows('private:qq-10014')).toBe(0);
        expectNoForeignKeyViolations();
      } finally {
        riskAttention.mockRestore();
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-MEM-01 should guard react_only face-message fallback text before delivery', async () => {
      const unsupportedReactionClaim = '已记住：reaction_fallback=compact';
      const correctedReactionText = '收到：reaction_fallback=compact';
      class ReactFallbackEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          return {
            domain: 'social',
            decisionId: 'eval-react-fallback-test',
            requestId: request.requestId,
            decision: 'approve',
            reason: 'Test evaluator selected reaction fallback delivery',
            confidence: 0.83,
            riskLevel: 'medium',
            decidedAt: new Date(),
            evaluatorVersion: 'test-react-fallback',
            modifiedAction: {
              ...request.proposedAction,
              type: 'react_only',
              payload: {
                reaction: unsupportedReactionClaim,
                messageId: 'qq-12360',
              },
              reason: 'Use a reaction fallback message only',
            },
          };
        }
      }

      const fakeGateway = new FakeOneBot({
        capabilities: {
          reactions: { emojiLike: false, faceMessage: true },
        },
      });
      app.setSocialEvaluatorForTesting(new ReactFallbackEvaluator());
      setReplyingPiRuntime('Pi reaction fallback draft should not be persisted as delivered text.');
      app.setMessageSenderForTesting(fakeGateway);
      const riskAttention = forceRiskAttentionForTesting();

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12360,
          user_id: 10016,
          message: '反应用降级消息',
          raw_message: '反应用降级消息',
          sender: {
            user_id: 10016,
            nickname: 'ReactFallbackUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        expect(fakeGateway.getSentReactions()).toHaveLength(0);
        expect(fakeGateway.getSentMessages()).toHaveLength(1);
        expect(fakeGateway.getSentMessages()[0]?.content.text).toBe(correctedReactionText);

        const turn = getTurnForMessage('qq-12360');
        expect(turn?.status).toBe('completed');
        expect(turn?.response_text).toBe('Pi reaction fallback draft should not be persisted as delivered text.');

        const actionRows = getActionRowsForMessage('qq-12360');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          decided_by: 'evaluator',
          evaluator_required: 1,
          evaluator_passed: 1,
          action_type: 'react_only',
          status: 'downgraded',
          executed_message_id: fakeGateway.getSentMessages()[0]?.messageId,
        });
        const storedActions = JSON.parse(actionRows[0]?.actions ?? '[]') as Array<{
          payload?: { reaction?: string };
        }>;
        expect(storedActions[0]?.payload?.reaction).toBe(correctedReactionText);
        expect(JSON.parse(actionRows[0]?.suppressors ?? '[]')).toContain(
          'memory_claim_truthfulness_guard',
        );

        const outboundMessage = getPersistedMessage(fakeGateway.getSentMessages()[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          raw_event_id: expect.any(String),
          conversation_id: 'private:qq-10016',
          conversation_type: 'private',
          sender_id: 'bot-self',
          text: correctedReactionText,
        });
        expect(outboundMessage?.text).not.toBe(
          'Pi reaction fallback draft should not be persisted as delivered text.',
        );
        expectNoForeignKeyViolations();
      } finally {
        riskAttention.mockRestore();
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should persist evaluator rejection as silent_store without sending', async () => {
      class RejectEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          return {
            domain: 'social',
            decisionId: 'eval-reject-test',
            requestId: request.requestId,
            decision: 'reject',
            reason: 'Test evaluator rejected risky social action',
            confidence: 0.91,
            riskLevel: 'high',
            decidedAt: new Date(),
            evaluatorVersion: 'test-reject',
          };
        }
      }

      const sentMessages: SentMessage[] = [];
      app.setSocialEvaluatorForTesting(new RejectEvaluator());
      setReplyingPiRuntime('这条回复不应该发送。');
      setCapturingMessageSender(sentMessages);
      const riskAttention = forceRiskAttentionForTesting();

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12355,
          user_id: 10011,
          message: '高风险回复请求',
          raw_message: '高风险回复请求',
          sender: {
            user_id: 10011,
            nickname: 'RejectUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        expect(sentMessages).toHaveLength(0);

        const actionRows = getActionRowsForMessage('qq-12355');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]?.decided_by).toBe('evaluator');
        expect(actionRows[0]?.risk_level).toBe('high');
        expect(actionRows[0]?.evaluator_required).toBe(1);
        expect(actionRows[0]?.evaluator_passed).toBe(0);
        expect(actionRows[0]?.action_type).toBe('silent_store');
        expect(actionRows[0]?.status).toBe('success');
        expect(JSON.parse(actionRows[0]?.suppressors ?? '[]')).toContain('evaluator_reject');
        expectNoForeignKeyViolations();
      } finally {
        riskAttention.mockRestore();
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-EVAL-02 completes governed evaluator failure with durable suppression and no send', async () => {
      const leakedDiagnostic = 'sk-synthetic-terminal-social-evaluator-diagnostic';
      class FailingEvaluator extends EvaluatorStub {
        async evaluateSocial(): Promise<SocialEvaluationResult> {
          throw new Error(`Invalid structured output: ${leakedDiagnostic}`);
        }
      }

      const sentMessages: SentMessage[] = [];
      app.setSocialEvaluatorForTesting(new FailingEvaluator());
      setReplyingPiRuntime('This governed response must remain local.');
      setCapturingMessageSender(sentMessages);
      const riskAttention = forceRiskAttentionForTesting();

      try {
        const response = await postEvent({
          post_type: 'message',
          message_type: 'private',
          message_id: 12364,
          user_id: 10020,
          message: 'Synthetic governed response request',
          raw_message: 'Synthetic governed response request',
          sender: {
            user_id: 10020,
            nickname: 'SyntheticEvaluatorFailureUser',
          },
          time: Math.floor(Date.now() / 1000),
        } satisfies OneBotMessage);

        expect(response.status).toBe(200);
        expect(sentMessages).toHaveLength(0);
        const persisted = getPersistedMessage('qq-12364');
        expect(persisted).toBeDefined();
        expect(app.getDatabase().prepare(
          'SELECT state, reason_code FROM event_processing_admissions WHERE raw_event_id = ?',
        ).get(persisted?.raw_event_id)).toEqual({ state: 'completed', reason_code: null });
        expect(getTurnForMessage('qq-12364')).toMatchObject({
          status: 'completed',
          action_decision_id: expect.any(String),
          response_text: 'This governed response must remain local.',
        });

        const actionRows = getActionRowsForMessage('qq-12364');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          decided_by: 'pi',
          risk_level: 'medium',
          evaluator_required: 1,
          evaluator_passed: 0,
          evaluator_decision_id: null,
          action_type: 'silent_store',
          status: 'success',
          executed_message_id: null,
        });
        expect(JSON.parse(actionRows[0]?.reasons ?? '[]')).toContain('evaluator_failure');
        expect(JSON.parse(actionRows[0]?.suppressors ?? '[]')).toContain(
          'evaluator_terminal_failure',
        );
        expect(JSON.stringify(actionRows[0])).not.toContain(leakedDiagnostic);
        expect(app.getDatabase().prepare(
          'SELECT COUNT(*) AS count FROM event_processing_failures WHERE raw_event_id = ?',
        ).get(persisted?.raw_event_id)).toEqual({ count: 0 });
        expect(countBotResponseRawEvents('private:qq-10020')).toBe(0);
        expect(countBotResponseRows('private:qq-10020')).toBe(0);
        expectNoForeignKeyViolations();
      } finally {
        riskAttention.mockRestore();
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });
  });

  describe('Group message flow', () => {
    interface DelayedCandidateRow {
      candidate_id: string;
      source_raw_event_id: string;
      job_id: string;
      not_before_at: number;
      expires_at: number;
      job_status: string;
      admission_state: string;
    }

    function getDelayedCandidate(platformMessageId: string): DelayedCandidateRow {
      const row = app.getDatabase().prepare(
        `SELECT candidate.id AS candidate_id,
                candidate.source_raw_event_id,
                candidate.job_id,
                candidate.not_before_at,
                candidate.expires_at,
                job.status AS job_status,
                admission.state AS admission_state
           FROM attention_candidates AS candidate
           JOIN chat_messages AS message ON message.id = candidate.source_chat_message_id
           JOIN jobs AS job ON job.id = candidate.job_id
           JOIN event_processing_admissions AS admission
             ON admission.raw_event_id = candidate.source_raw_event_id
          WHERE message.message_id = ?`,
      ).get(platformMessageId) as DelayedCandidateRow | undefined;
      if (!row) {
        throw new Error(`Missing delayed Attention candidate for ${platformMessageId}`);
      }
      return row;
    }

    function setApprovingProactiveEvaluator(
      requests: SocialEvaluationRequest[] = [],
    ): void {
      class ApprovingProactiveEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          requests.push(request);
          return {
            domain: 'social',
            decisionId: `synthetic-delayed-${request.requestId}`,
            requestId: request.requestId,
            decision: 'approve',
            reason: 'Synthetic delayed intervention approved',
            confidence: 0.9,
            riskLevel: 'medium',
            decidedAt: new Date(),
            evaluatorVersion: 'synthetic-delayed-v1',
          };
        }
      }

      app.setSocialEvaluatorForTesting(new ApprovingProactiveEvaluator());
    }

    it('should accept and process group message with @mention', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'group',
        message_id: 23456,
        user_id: 20001,
        group_id: 100001,
        message: '[CQ:at,qq=3889000770] 你好',
        raw_message: '[CQ:at,qq=3889000770] 你好',
        sender: {
          user_id: 20001,
          nickname: 'GroupUser1',
          card: 'Card1',
          role: 'admin',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');

      const persisted = getPersistedMessage('qq-23456');
      expect(persisted).toBeDefined();
      expect(persisted?.raw_event_id).toBe(persisted?.id);
      expect(persisted?.raw_type).toBe('chat.message.received');
      expect(persisted?.conversation_id).toBe('qq-group-100001');
      expect(persisted?.conversation_type).toBe('group');
      expect(persisted?.group_id).toBe('qq-group-100001');
      expect(persisted?.sender_id).toBe('qq-20001');
      expect(persisted?.sender_role).toBe('admin');
      expect(persisted?.text).toBe('你好');
      expect(persisted?.mentions_bot).toBe(1);

      const displayProfile = app
        .getDatabase()
        .prepare(
          `SELECT dp.current_display_name, dp.source_group_id, dp.trust
           FROM display_profiles dp
           JOIN platform_accounts pa ON pa.canonical_user_id = dp.canonical_user_id
           WHERE pa.platform = 'qq' AND pa.platform_account_id = ?`
        )
        .get('20001') as { current_display_name: string; source_group_id: string; trust: string } | undefined;
      expect(displayProfile?.current_display_name).toBe('Card1');
      expect(displayProfile?.source_group_id).toBe('qq-group-100001');
      expect(displayProfile?.trust).toBe('platform_provided');
      expectNoForeignKeyViolations();
    });

    it('should accept group message without @mention', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: '这条普通群聊消息不应该触发回复。',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23457,
          user_id: 20002,
          group_id: 100001,
          message: '今天天气不错',
          raw_message: '今天天气不错',
          sender: {
            user_id: 20002,
            nickname: 'GroupUser2',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('ok');

        const persisted = getPersistedMessage('qq-23457');
        expect(persisted).toBeDefined();
        expect(persisted?.raw_event_id).toBe(persisted?.id);
        expect(persisted?.raw_type).toBe('chat.message.received');
        expect(persisted?.conversation_type).toBe('group');
        expect(persisted?.mentions_bot).toBe(0);
        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23457')).toBe(0);
        expect(getContextTraceForMessage('qq-23457')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23457')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-MEM-02 admits and processes a silent group extraction candidate exactly once', async () => {
      const db = app.getDatabase();
      const sentMessages: SentMessage[] = [];
      let piCalls = 0;
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'Silent group extraction must not invoke Pi.',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);
      app.setSocialEvaluatorForTesting(new EvaluatorStub());
      const event: OneBotMessage = {
        post_type: 'message',
        message_type: 'group',
        message_id: 24250,
        user_id: 20250,
        group_id: 100050,
        message: '我喜欢 合成测试',
        raw_message: '我喜欢 合成测试',
        sender: {
          user_id: 20250,
          nickname: 'SyntheticMemoryUser',
          role: 'member',
        },
        time: Math.floor(Date.now() / 1000),
      };

      try {
        const response = await postEvent(event);
        expect(response.status).toBe(200);

        const persisted = getPersistedMessage('qq-24250');
        expect(persisted).toMatchObject({
          conversation_id: 'qq-group-100050',
          conversation_type: 'group',
          group_id: 'qq-group-100050',
          text: '我喜欢 合成测试',
        });
        if (!persisted) {
          throw new Error('Expected silent group source message');
        }
        const identity = db.prepare(
          `SELECT canonical_user_id
             FROM platform_accounts
            WHERE platform = 'qq' AND platform_account_id = ?`,
        ).get('20250') as { canonical_user_id: string } | undefined;
        expect(identity?.canonical_user_id).toBeDefined();

        const idempotencyKey = `extraction:auto:${persisted.id}`;
        const pendingJob = db.prepare(
          `SELECT id, status, attempts, payload, idempotency_key
             FROM jobs
            WHERE type = 'extraction' AND idempotency_key = ?`,
        ).get(idempotencyKey) as {
          id: string;
          status: string;
          attempts: number;
          payload: string;
          idempotency_key: string;
        } | undefined;
        expect(pendingJob).toMatchObject({
          status: 'pending',
          attempts: 0,
          idempotency_key: idempotencyKey,
        });
        if (!pendingJob) {
          throw new Error('Expected silent group extraction job');
        }
        expect(JSON.parse(pendingJob.payload)).toEqual({
          sourceChatMessageId: persisted.id,
          targetUserId: identity?.canonical_user_id,
        });
        expect(Object.keys(JSON.parse(pendingJob.payload) as Record<string, unknown>).sort())
          .toEqual(['sourceChatMessageId', 'targetUserId']);
        expect(pendingJob.payload).not.toContain('我喜欢 合成测试');
        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-24250')).toBe(0);
        expect(getActionRowsForMessage('qq-24250')).toEqual([]);
        expect(sentMessages).toEqual([]);

        const duplicateResponse = await postEvent(event);
        expect(duplicateResponse.status).toBe(200);
        expect(db.prepare(
          "SELECT COUNT(*) AS count FROM jobs WHERE type = 'extraction' AND idempotency_key = ?",
        ).get(idempotencyKey)).toEqual({ count: 1 });
        expect(db.prepare(
          'SELECT COUNT(*) AS count FROM chat_messages WHERE id = ?',
        ).get(persisted.id)).toEqual({ count: 1 });
        expect(piCalls).toBe(0);
        expect(sentMessages).toEqual([]);

        const result = await app.processNextBackgroundJobForTesting(undefined, ['extraction']);
        expect(result).toMatchObject({
          taskId: pendingJob.id,
          status: 'completed',
          output: { matched: true, count: 1 },
        });
        const output = result?.output as { memoryIds?: string[] } | undefined;
        const memoryId = output?.memoryIds?.[0];
        expect(memoryId).toMatch(/^extraction-v1-[a-f0-9]{64}$/);

        const memory = db.prepare(
          `SELECT scope, canonical_user_id, group_id, conversation_id,
                  visibility, source_context, state, content
             FROM memory_records
            WHERE id = ?`,
        ).get(memoryId) as {
          scope: string;
          canonical_user_id: string;
          group_id: string;
          conversation_id: string;
          visibility: string;
          source_context: string;
          state: string;
          content: string;
        } | undefined;
        expect(memory).toEqual({
          scope: 'user',
          canonical_user_id: identity?.canonical_user_id,
          group_id: 'qq-group-100050',
          conversation_id: 'qq-group-100050',
          visibility: 'same_group_only',
          source_context: 'group_chat',
          state: 'proposed',
          content: '我喜欢 合成测试',
        });
        const sources = db.prepare(
          `SELECT source_type, source_id, extracted_by, resolution_state,
                  raw_event_id, chat_message_id
             FROM memory_sources
            WHERE memory_id = ?`,
        ).all(memoryId) as Array<{
          source_type: string;
          source_id: string;
          extracted_by: string;
          resolution_state: string;
          raw_event_id: string | null;
          chat_message_id: string;
        }>;
        expect(sources).toEqual([{
          source_type: 'chat_message',
          source_id: persisted.id,
          extracted_by: 'worker',
          resolution_state: 'internal',
          raw_event_id: null,
          chat_message_id: persisted.id,
        }]);
        expect(db.prepare(
          'SELECT COUNT(*) AS count FROM memory_records WHERE id = ?',
        ).get(memoryId)).toEqual({ count: 1 });
        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-24250')).toBe(0);
        expect(getActionRowsForMessage('qq-24250')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-ATT-02 defers an unmentioned question and reuses delivery evidence after lease loss', async () => {
      const evaluatorRequests: SocialEvaluationRequest[] = [];
      const sentMessages: SentMessage[] = [];
      let piCalls = 0;
      let candidate: DelayedCandidateRow | undefined;

      setApprovingProactiveEvaluator(evaluatorRequests);
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'Synthetic delayed response',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 9, output: 4, total: 13 },
            status: 'completed',
          };
        },
      });
      app.setMessageSenderForTesting({
        async sendMessage(target, content): Promise<string> {
          if (!candidate) {
            throw new Error('Delayed candidate must exist before delivery');
          }
          const messageId = `qq-bot-${++outboundMessageCounter}`;
          sentMessages.push({ messageId, target, text: content.text ?? '' });
          app.getDatabase().prepare(
            'UPDATE jobs SET lease_expires_at = ? WHERE id = ?',
          ).run(candidate.not_before_at, candidate.job_id);
          return messageId;
        },
      });

      try {
        const event: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 24101,
          user_id: 20101,
          group_id: 100041,
          message: 'Can this synthetic question be answered?',
          raw_message: 'Can this synthetic question be answered?',
          sender: {
            user_id: 20101,
            nickname: 'DelayedQuestionUser',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(event);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        candidate = getDelayedCandidate('qq-24101');
        expect(candidate).toMatchObject({
          job_status: 'pending',
          admission_state: 'completed',
        });
        expect(piCalls).toBe(0);
        expect(sentMessages).toEqual([]);
        expect(countTurnsForMessage('qq-24101')).toBe(0);
        expect(await app.processNextBackgroundJobForTesting(
          candidate.not_before_at - 1,
          ['attention_recheck'],
        )).toBeNull();
        expect(piCalls).toBe(0);

        const firstAttempt = await app.processNextBackgroundJobForTesting(
          candidate.not_before_at,
          ['attention_recheck'],
        );
        expect(firstAttempt).toMatchObject({
          taskId: candidate.job_id,
          status: 'failed',
          error: expect.stringContaining('lost lease authority'),
        });
        expect(piCalls).toBe(1);
        expect(sentMessages).toHaveLength(1);
        expect(countTurnsForMessage('qq-24101')).toBe(1);
        expect(countBotResponseRows('qq-group-100041')).toBe(1);

        const retry = await app.processNextBackgroundJobForTesting(
          candidate.not_before_at + 1,
          ['attention_recheck'],
        );
        expect(retry).toMatchObject({
          taskId: candidate.job_id,
          status: 'completed',
          output: {
            candidateId: candidate.candidate_id,
            outcome: 'respond',
            deliveryRecorded: true,
          },
        });
        expect(piCalls).toBe(1);
        expect(sentMessages).toHaveLength(1);
        expect(countTurnsForMessage('qq-24101')).toBe(1);
        expect(countBotResponseRows('qq-group-100041')).toBe(1);

        expect(evaluatorRequests).toHaveLength(1);
        expect(evaluatorRequests[0]).toMatchObject({
          isProactive: true,
          attentionSignals: {
            classification: 'needs_response',
            recommendedPath: 'reply_fast_path',
            triggerReasons: expect.arrayContaining(['question', 'delayed_recheck']),
          },
          proposedAction: {
            constraints: { proactive: true, evaluatorRequired: true },
          },
        });
        const actionRows = getActionRowsForMessage('qq-24101');
        expect(actionRows).toHaveLength(1);
        expect(JSON.parse(actionRows[0]?.reasons ?? '[]')).toContain('delayed_recheck');
        expect(JSON.parse(actionRows[0]?.actions ?? '[]')[0]?.constraints).toMatchObject({
          proactive: true,
          evaluatorRequired: true,
        });
        expect(app.getDatabase().prepare(
          'SELECT COUNT(*) AS count FROM attention_decisions WHERE candidate_id = ?',
        ).get(candidate.candidate_id)).toEqual({ count: 1 });
        expect(app.getDatabase().prepare(
          `SELECT status, attempt_number
             FROM job_attempts
            WHERE job_id = ?
            ORDER BY attempt_number`,
        ).all(candidate.job_id)).toEqual([
          { status: 'failed', attempt_number: 1 },
          { status: 'completed', attempt_number: 2 },
        ]);
        expect(app.getDatabase().prepare(
          'SELECT status FROM jobs WHERE id = ?',
        ).get(candidate.job_id)).toEqual({ status: 'completed' });
        expect(app.getDatabase().prepare(
          'SELECT COUNT(*) AS count FROM chat_messages WHERE message_id = ?',
        ).get('qq-24101')).toEqual({ count: 1 });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-ATT-02 rejects mismatched source evidence before Pi or delivery', async () => {
      const evaluatorRequests: SocialEvaluationRequest[] = [];
      const sentMessages: SentMessage[] = [];
      const sourceText = 'Can this exact delayed source still be trusted?';
      let piCalls = 0;

      setApprovingProactiveEvaluator(evaluatorRequests);
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'Unexpected delayed response',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 9, output: 4, total: 13 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const event: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 24141,
          user_id: 20141,
          group_id: 100048,
          message: sourceText,
          raw_message: sourceText,
          sender: {
            user_id: 20141,
            nickname: 'DelayedSourceMismatchUser',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(event);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const candidate = getDelayedCandidate('qq-24141');
        const persisted = getPersistedMessage('qq-24141');
        expect(persisted).toBeDefined();
        app.getDatabase().prepare(
          'UPDATE chat_messages SET text = ? WHERE id = ?',
        ).run('Synthetic mismatched chat evidence', persisted?.id);
        app.getDatabase().prepare(
          'UPDATE jobs SET max_attempts = 1 WHERE id = ?',
        ).run(candidate.job_id);

        const sourceMismatchError =
          'Delayed Attention source event no longer matches its chat evidence';
        expect(await app.processNextBackgroundJobForTesting(
          candidate.not_before_at,
          ['attention_recheck'],
        )).toEqual({
          taskId: candidate.job_id,
          status: 'failed',
          error: sourceMismatchError,
        });

        expect(piCalls).toBe(0);
        expect(evaluatorRequests).toEqual([]);
        expect(sentMessages).toEqual([]);
        expect(countTurnsForMessage('qq-24141')).toBe(0);
        expect(getActionRowsForMessage('qq-24141')).toEqual([]);
        expect(countBotResponseRows('qq-group-100048')).toBe(0);
        expect(app.getDatabase().prepare(
          'SELECT COUNT(*) AS count FROM attention_decisions WHERE candidate_id = ?',
        ).get(candidate.candidate_id)).toEqual({ count: 0 });
        expect(app.getDatabase().prepare(
          `SELECT attempt_number, status, error
             FROM job_attempts
            WHERE job_id = ?
            ORDER BY attempt_number`,
        ).all(candidate.job_id)).toEqual([
          { attempt_number: 1, status: 'failed', error: sourceMismatchError },
        ]);
        expect(app.getDatabase().prepare(
          'SELECT status, attempts, max_attempts, error FROM jobs WHERE id = ?',
        ).get(candidate.job_id)).toEqual({
          status: 'failed',
          attempts: 1,
          max_attempts: 1,
          error: sourceMismatchError,
        });
        expectNoForeignKeyViolations();
      } finally {
        app.getDatabase().prepare(
          'UPDATE chat_messages SET text = ? WHERE message_id = ?',
        ).run(sourceText, 'qq-24141');
        setSuccessfulPiRuntime();
        setCapturingMessageSender([]);
        restoreDecisionDefaults();
      }
    });

    it('REL-ATT-02 fails closed on indeterminate prior delivery without duplicate work', async () => {
      const evaluatorRequests: SocialEvaluationRequest[] = [];
      const sentMessages: SentMessage[] = [];
      const indeterminateTurnId = 'synthetic-delayed-indeterminate-turn-24142';
      let piCalls = 0;

      setApprovingProactiveEvaluator(evaluatorRequests);
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'Unexpected duplicate delayed response',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 9, output: 4, total: 13 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const event: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 24142,
          user_id: 20142,
          group_id: 100049,
          message: 'Can an indeterminate delayed turn be retried safely?',
          raw_message: 'Can an indeterminate delayed turn be retried safely?',
          sender: {
            user_id: 20142,
            nickname: 'DelayedIndeterminateUser',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(event);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const candidate = getDelayedCandidate('qq-24142');
        app.getDatabase().prepare(
          `INSERT INTO agent_turns (
             id, conversation_id, trigger_event_id, pi_model, pi_provider,
             status, started_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        ).run(
          indeterminateTurnId,
          'qq-group-100049',
          candidate.source_raw_event_id,
          'synthetic',
          'synthetic',
          candidate.not_before_at,
        );

        const indeterminateError =
          'Delayed Attention prior turn has indeterminate delivery state';
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          expect(await app.processNextBackgroundJobForTesting(
            candidate.not_before_at,
            ['attention_recheck'],
          )).toEqual({
            taskId: candidate.job_id,
            status: 'failed',
            error: indeterminateError,
          });
          expect(piCalls).toBe(0);
          expect(evaluatorRequests).toEqual([]);
          expect(sentMessages).toEqual([]);
          expect(countTurnsForMessage('qq-24142')).toBe(1);
          expect(getActionRowsForMessage('qq-24142')).toEqual([]);
          expect(countBotResponseRows('qq-group-100049')).toBe(0);
          expect(app.getDatabase().prepare(
            'SELECT outcome FROM attention_decisions WHERE candidate_id = ?',
          ).all(candidate.candidate_id)).toEqual([{ outcome: 'respond' }]);
          expect(app.getDatabase().prepare(
            'SELECT status, attempts FROM jobs WHERE id = ?',
          ).get(candidate.job_id)).toEqual({
            status: attempt === 3 ? 'failed' : 'pending',
            attempts: attempt,
          });
        }

        expect(app.getDatabase().prepare(
          `SELECT attempt_number, status, error
             FROM job_attempts
            WHERE job_id = ?
            ORDER BY attempt_number`,
        ).all(candidate.job_id)).toEqual([
          { attempt_number: 1, status: 'failed', error: indeterminateError },
          { attempt_number: 2, status: 'failed', error: indeterminateError },
          { attempt_number: 3, status: 'failed', error: indeterminateError },
        ]);
        expect(app.getDatabase().prepare(
          'SELECT status, attempts, max_attempts, error FROM jobs WHERE id = ?',
        ).get(candidate.job_id)).toEqual({
          status: 'failed',
          attempts: 3,
          max_attempts: 3,
          error: indeterminateError,
        });
        expect(getTurnForMessage('qq-24142')).toMatchObject({
          id: indeterminateTurnId,
          status: 'pending',
          action_decision_id: null,
        });
        expectNoForeignKeyViolations();
      } finally {
        app.getDatabase().prepare(
          `UPDATE agent_turns
              SET status = 'aborted', completed_at = ?
            WHERE id = ? AND status IN ('pending', 'running')`,
        ).run(Date.now(), indeterminateTurnId);
        setSuccessfulPiRuntime();
        setCapturingMessageSender([]);
        restoreDecisionDefaults();
      }
    });

    it('REL-ATT-02 persists terminal expiry, human-answer, traffic, and exact-group budget suppressors', async () => {
      let piCalls = 0;
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: '',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 3, output: 0, total: 3 },
            status: 'completed',
          };
        },
      });

      const submitQuestion = async (
        messageId: number,
        userId: number,
        groupId: number,
      ): Promise<DelayedCandidateRow> => {
        const event: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: messageId,
          user_id: userId,
          group_id: groupId,
          message: `Synthetic delayed policy question ${messageId}?`,
          raw_message: `Synthetic delayed policy question ${messageId}?`,
          sender: {
            user_id: userId,
            nickname: `DelayedPolicyUser${userId}`,
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };
        const response = await postEvent(event);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });
        return getDelayedCandidate(`qq-${messageId}`);
      };

      const expectSuppressed = async (
        candidate: DelayedCandidateRow,
        now: number,
        code: string,
      ): Promise<void> => {
        const result = await app.processNextBackgroundJobForTesting(
          now,
          ['attention_recheck'],
        );
        expect(result).toMatchObject({
          taskId: candidate.job_id,
          status: 'completed',
          output: {
            candidateId: candidate.candidate_id,
            outcome: 'suppress',
            suppressors: [expect.objectContaining({ code })],
          },
        });
        expect(app.getDatabase().prepare(
          `SELECT decision.outcome, suppressor.code
             FROM attention_decisions AS decision
             JOIN attention_suppressors AS suppressor
               ON suppressor.decision_id = decision.id
            WHERE decision.candidate_id = ?`,
        ).get(candidate.candidate_id)).toEqual({ outcome: 'suppress', code });
        const job = app.getDatabase().prepare(
          'SELECT status, result FROM jobs WHERE id = ?',
        ).get(candidate.job_id) as { status: string; result: string };
        expect(job.status).toBe('completed');
        expect(JSON.parse(job.result)).toMatchObject({
          candidateId: candidate.candidate_id,
          outcome: 'suppress',
        });
        expect(app.getDatabase().prepare(
          `SELECT attempt_number, status
             FROM job_attempts
            WHERE job_id = ?
            ORDER BY attempt_number`,
        ).all(candidate.job_id)).toEqual([
          { attempt_number: 1, status: 'completed' },
        ]);
      };

      try {
        const expired = await submitQuestion(24110, 20110, 100042);
        await expectSuppressed(expired, expired.expires_at, 'thread_expired');

        const answered = await submitQuestion(24111, 20111, 100043);
        const answerEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 24112,
          user_id: 20112,
          group_id: 100043,
          message: '[CQ:reply,id=24111] Synthetic human answer.',
          raw_message: '[CQ:reply,id=24111] Synthetic human answer.',
          sender: {
            user_id: 20112,
            nickname: 'DelayedAnswerUser',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };
        expect((await postEvent(answerEvent)).status).toBe(200);
        await expectSuppressed(answered, answered.not_before_at, 'human_answer');

        const traffic = await submitQuestion(24120, 20120, 100044);
        for (let index = 0; index < 6; index += 1) {
          const messageId = 24121 + index;
          const activityEvent: OneBotMessage = {
            post_type: 'message',
            message_type: 'group',
            message_id: messageId,
            user_id: 20121 + index,
            group_id: 100044,
            message: `Synthetic activity ${index}`,
            raw_message: `Synthetic activity ${index}`,
            sender: {
              user_id: 20121 + index,
              nickname: `TrafficUser${index}`,
              role: 'member',
            },
            time: Math.floor(Date.now() / 1000),
          };
          expect((await postEvent(activityEvent)).status).toBe(200);
          const activity = getPersistedMessage(`qq-${messageId}`);
          expect(activity).toBeDefined();
          const observedAt = traffic.not_before_at - 9_000 + index * 1_000;
          app.getDatabase().transaction(() => {
            app.getDatabase().prepare(
              'UPDATE raw_events SET created_at = ? WHERE id = ?',
            ).run(observedAt, activity?.raw_event_id);
            app.getDatabase().prepare(
              'UPDATE event_ingress_receipts SET received_at = ? WHERE raw_event_id = ?',
            ).run(observedAt, activity?.raw_event_id);
            app.getDatabase().prepare(
              `UPDATE event_processing_admissions
                  SET accepted_at = ?, processing_started_at = ?, finished_at = ?
                WHERE raw_event_id = ?`,
            ).run(observedAt, observedAt, observedAt, activity?.raw_event_id);
          })();
        }
        await expectSuppressed(traffic, traffic.not_before_at, 'high_traffic');

        const firstGroupReservation = await submitQuestion(24130, 20130, 100045);
        expect(await app.processNextBackgroundJobForTesting(
          firstGroupReservation.not_before_at,
          ['attention_recheck'],
        )).toMatchObject({
          taskId: firstGroupReservation.job_id,
          status: 'completed',
          output: { candidateId: firstGroupReservation.candidate_id, outcome: 'respond' },
        });

        const otherGroupReservation = await submitQuestion(24131, 20131, 100046);
        expect(await app.processNextBackgroundJobForTesting(
          otherGroupReservation.not_before_at,
          ['attention_recheck'],
        )).toMatchObject({
          taskId: otherGroupReservation.job_id,
          status: 'completed',
          output: { candidateId: otherGroupReservation.candidate_id, outcome: 'respond' },
        });

        const secondGroupReservation = await submitQuestion(24132, 20132, 100045);
        expect(await app.processNextBackgroundJobForTesting(
          secondGroupReservation.not_before_at,
          ['attention_recheck'],
        )).toMatchObject({
          taskId: secondGroupReservation.job_id,
          status: 'completed',
          output: { candidateId: secondGroupReservation.candidate_id, outcome: 'respond' },
        });

        const budgetSuppressed = await submitQuestion(24133, 20133, 100045);
        await expectSuppressed(
          budgetSuppressed,
          budgetSuppressed.not_before_at,
          'group_budget_exhausted',
        );
        expect(app.getDatabase().prepare(
          `SELECT suppressor.observed_count
             FROM attention_suppressors AS suppressor
             JOIN attention_decisions AS decision ON decision.id = suppressor.decision_id
            WHERE decision.candidate_id = ?`,
        ).get(budgetSuppressed.candidate_id)).toEqual({ observed_count: 2 });
        expect(piCalls).toBe(3);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-ATT-02 rolls back chat, candidate, and job together when deferred persistence fails', async () => {
      const groupId = 'qq-group-100047';
      const db = app.getDatabase();
      db.exec(
        `CREATE TRIGGER fail_synthetic_delayed_candidate
         BEFORE INSERT ON attention_candidates
         WHEN NEW.group_id = '${groupId}'
         BEGIN
           SELECT RAISE(ABORT, 'synthetic delayed candidate failure');
         END`,
      );

      try {
        const event: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 24140,
          user_id: 20140,
          group_id: 100047,
          message: 'Should this synthetic candidate fail atomically?',
          raw_message: 'Should this synthetic candidate fail atomically?',
          sender: {
            user_id: 20140,
            nickname: 'AtomicCandidateUser',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };
        const response = await postEvent(event);
        expect(response.status).toBe(200);

        const raw = db.prepare(
          'SELECT id FROM raw_events WHERE platform_event_id = ?',
        ).get('qq-24140') as { id: string } | undefined;
        expect(raw).toBeDefined();
        expect(getPersistedMessage('qq-24140')).toBeUndefined();
        expect(db.prepare(
          'SELECT COUNT(*) AS count FROM attention_candidates WHERE group_id = ?',
        ).get(groupId)).toEqual({ count: 0 });
        expect(db.prepare(
          `SELECT COUNT(*) AS count
             FROM jobs
            WHERE type = 'attention_recheck'
              AND idempotency_key = ?`,
        ).get(`attention:deferred:v1:${raw?.id}`)).toEqual({ count: 0 });
        expect(db.prepare(
          'SELECT state, reason_code FROM event_processing_admissions WHERE raw_event_id = ?',
        ).get(raw?.id)).toEqual({ state: 'failed', reason_code: 'handler_failed' });
        expect(app.getEventProcessingFailures()).toHaveLength(1);
        expectNoForeignKeyViolations();
      } finally {
        db.exec('DROP TRIGGER IF EXISTS fail_synthetic_delayed_candidate');
        app.clearEventProcessingFailuresForTesting();
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-ADMIN-01 keeps narrative text silent and routes only authorized exact commands', async () => {
      const evaluatorRequests: SocialEvaluationRequest[] = [];
      const sentMessages: SentMessage[] = [];
      let piCalls = 0;

      class CapturingEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          evaluatorRequests.push(request);
          return super.evaluateSocial(request);
        }
      }

      app.setSocialEvaluatorForTesting(new CapturingEvaluator());
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'Synthetic governed command response',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 11, output: 7, total: 18 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const memberNarrativeEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 24020,
          user_id: 20200,
          group_id: 100020,
          message: '设置群规则',
          raw_message: '设置群规则',
          sender: {
            user_id: 20200,
            nickname: 'InstructionMember',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };
        const adminNarrativeEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 24021,
          user_id: 20201,
          group_id: 100020,
          message: '设置群规则',
          raw_message: '设置群规则',
          sender: {
            user_id: 20201,
            nickname: 'InstructionAdmin',
            role: 'admin',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const memberCommandEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 24022,
          user_id: 20202,
          group_id: 100020,
          message: '/memory',
          raw_message: '/memory',
          sender: {
            user_id: 20202,
            nickname: 'CommandMember',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };
        const adminCommandEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 24023,
          user_id: 20203,
          group_id: 100020,
          message: '/memory',
          raw_message: '/memory',
          sender: {
            user_id: 20203,
            nickname: 'CommandAdmin',
            role: 'admin',
          },
          time: Math.floor(Date.now() / 1000),
        };
        const invalidAdminCommandEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 24024,
          user_id: 20203,
          group_id: 100020,
          message: '/memory list',
          raw_message: '/memory list',
          sender: {
            user_id: 20203,
            nickname: 'CommandAdmin',
            role: 'admin',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const memberResponse = await postEvent(memberNarrativeEvent);

        expect(memberResponse.status).toBe(200);
        await expect(memberResponse.json()).resolves.toEqual({ status: 'ok' });
        expect(getPersistedMessage('qq-24020')).toMatchObject({
          sender_role: 'member',
          text: '设置群规则',
          mentions_bot: 0,
        });
        expect(piCalls).toBe(0);
        expect(evaluatorRequests).toHaveLength(0);
        expect(countTurnsForMessage('qq-24020')).toBe(0);
        expect(getActionRowsForMessage('qq-24020')).toEqual([]);
        expect(sentMessages).toEqual([]);

        const adminNarrativeResponse = await postEvent(adminNarrativeEvent);

        expect(adminNarrativeResponse.status).toBe(200);
        await expect(adminNarrativeResponse.json()).resolves.toEqual({ status: 'ok' });
        expect(getPersistedMessage('qq-24021')).toMatchObject({
          sender_role: 'admin',
          text: '设置群规则',
          mentions_bot: 0,
        });
        expect(piCalls).toBe(0);
        expect(evaluatorRequests).toHaveLength(0);
        expect(countTurnsForMessage('qq-24021')).toBe(0);
        expect(getActionRowsForMessage('qq-24021')).toEqual([]);

        const memberCommandResponse = await postEvent(memberCommandEvent);

        expect(memberCommandResponse.status).toBe(200);
        await expect(memberCommandResponse.json()).resolves.toEqual({ status: 'ok' });
        expect(piCalls).toBe(0);
        expect(evaluatorRequests).toHaveLength(0);
        expect(countTurnsForMessage('qq-24022')).toBe(1);
        expect(sentMessages).toHaveLength(1);
        expectSuccessfulGroupGovernanceCommand(
          'qq-24022',
          sentMessages[0],
          'Governance command denied.',
        );

        const adminCommandResponse = await postEvent(adminCommandEvent);

        expect(adminCommandResponse.status).toBe(200);
        await expect(adminCommandResponse.json()).resolves.toEqual({ status: 'ok' });
        expect(piCalls).toBe(0);
        expect(evaluatorRequests).toHaveLength(0);

        expect(sentMessages).toHaveLength(2);
        expectSuccessfulGroupGovernanceCommand(
          'qq-24023',
          sentMessages[1],
          'Memory records: none.',
        );

        const invalidAdminCommandResponse = await postEvent(invalidAdminCommandEvent);

        expect(invalidAdminCommandResponse.status).toBe(200);
        await expect(invalidAdminCommandResponse.json()).resolves.toEqual({ status: 'ok' });
        expect(piCalls).toBe(0);
        expect(evaluatorRequests).toHaveLength(0);
        expect(sentMessages).toHaveLength(3);
        expectSuccessfulGroupGovernanceCommand(
          'qq-24024',
          sentMessages[2],
          'Usage: /memory | /memory forget <memory-id> | /memory summary status|enable|disable',
        );
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-GOV-01 applies group-summary changes once and cancels bound pending work', async () => {
      const db = app.getDatabase();
      const sentMessages: SentMessage[] = [];
      const evaluatorRequests: SocialEvaluationRequest[] = [];
      const policyRepository = new GroupSummaryPolicyRepository(db);
      const groupId = 'qq-group-100071';
      const groupIdHash = createHash('sha256')
        .update('lethebot:group-summary-policy:v1\0')
        .update(groupId)
        .digest('hex');
      let piCalls = 0;

      class CapturingEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          evaluatorRequests.push(request);
          return super.evaluateSocial(request);
        }
      }

      app.setSocialEvaluatorForTesting(new CapturingEvaluator());
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'Summary governance commands must not reach Pi.',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      const statusEvent = makeGroupEvent({
        messageId: 24620,
        userId: 20711,
        groupId: 100071,
        text: '/memory summary status',
      });
      const enableEvent = makeGroupEvent({
        messageId: 24621,
        userId: 20711,
        groupId: 100071,
        text: '/memory summary enable',
      });
      const idempotentEnableEvent = makeGroupEvent({
        messageId: 24622,
        userId: 20711,
        groupId: 100071,
        text: '/memory summary enable',
      });
      const disableEvent = makeGroupEvent({
        messageId: 24623,
        userId: 20711,
        groupId: 100071,
        text: '/memory summary disable',
      });
      const reenableEvent = makeGroupEvent({
        messageId: 24624,
        userId: 20711,
        groupId: 100071,
        text: '/memory summary enable',
      });

      try {
        const statusResponse = await postEvent(statusEvent);
        expect(statusResponse.status).toBe(200);
        expect(policyRepository.get(groupId)).toBeNull();
        expect(db.prepare(
          `SELECT COUNT(*) AS count
             FROM audit_log
            WHERE event_type = 'group.summary_policy_changed'
              AND json_extract(details, '$.groupIdHash') = ?`,
        ).get(groupIdHash)).toEqual({ count: 0 });

        const enableResponse = await postEvent(enableEvent);
        expect(enableResponse.status).toBe(200);
        expect(policyRepository.get(groupId)).toMatchObject({
          state: 'enabled',
          generation: 1,
        });

        const idempotentEnableResponse = await postEvent(idempotentEnableEvent);
        expect(idempotentEnableResponse.status).toBe(200);
        expect(policyRepository.get(groupId)).toMatchObject({
          state: 'enabled',
          generation: 1,
        });
        expect(db.prepare(
          `SELECT COUNT(*) AS count
             FROM audit_log
            WHERE event_type = 'group.summary_policy_changed'
              AND json_extract(details, '$.groupIdHash') = ?`,
        ).get(groupIdHash)).toEqual({ count: 1 });

        const jobId = 'job-rel-gov-summary-cancel';
        const jobCreatedAt = Date.now();
        db.prepare(
          `INSERT INTO jobs (
             id, type, payload, idempotency_key, status, attempts, max_attempts,
             created_at, updated_at, scheduled_at
           ) VALUES (?, 'summary', ?, ?, 'pending', 0, 3, ?, ?, ?)`,
        ).run(
          jobId,
          JSON.stringify({ conversationId: groupId, conversationType: 'group', groupId }),
          'rel-gov-summary-cancel',
          jobCreatedAt,
          jobCreatedAt,
          jobCreatedAt,
        );
        policyRepository.bindSummaryJob({
          jobId,
          groupId,
          conversationId: groupId,
          now: jobCreatedAt,
        });

        const disableResponse = await postEvent(disableEvent);
        expect(disableResponse.status).toBe(200);
        expect(policyRepository.get(groupId)).toMatchObject({
          state: 'disabled',
          generation: 2,
        });
        expect(db.prepare(
          'SELECT status, error, result FROM jobs WHERE id = ?',
        ).get(jobId)).toEqual({
          status: 'failed',
          error: 'group_summary_policy_disabled',
          result: JSON.stringify({ code: 'group_summary_policy_disabled' }),
        });
        expect(db.prepare(
          `SELECT cancellation_code, canceled_at
             FROM group_summary_job_bindings
            WHERE job_id = ?`,
        ).get(jobId)).toMatchObject({
          cancellation_code: 'group_summary_policy_disabled',
          canceled_at: expect.any(Number),
        });

        const reenableResponse = await postEvent(reenableEvent);
        expect(reenableResponse.status).toBe(200);
        const duplicateResponse = await postEvent(reenableEvent);
        expect(duplicateResponse.status).toBe(200);
        expect(policyRepository.get(groupId)).toMatchObject({
          state: 'enabled',
          generation: 3,
        });
        expect(db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)).toEqual({
          status: 'failed',
        });

        expect(piCalls).toBe(0);
        expect(evaluatorRequests).toHaveLength(0);
        expect(sentMessages).toHaveLength(5);
        expectSuccessfulGroupGovernanceCommand(
          'qq-24620',
          sentMessages[0],
          'Group summary policy is disabled.',
        );
        expectSuccessfulGroupGovernanceCommand(
          'qq-24621',
          sentMessages[1],
          'Group summary policy enabled.',
        );
        expectSuccessfulGroupGovernanceCommand(
          'qq-24622',
          sentMessages[2],
          'Group summary policy enabled.',
        );
        expectSuccessfulGroupGovernanceCommand(
          'qq-24623',
          sentMessages[3],
          'Group summary policy disabled.',
        );
        expectSuccessfulGroupGovernanceCommand(
          'qq-24624',
          sentMessages[4],
          'Group summary policy enabled.',
        );
        expect(countTurnsForMessage('qq-24624')).toBe(1);
        expect(getActionRowsForMessage('qq-24624')).toHaveLength(1);
        const replayDispositions = db.prepare(
          `SELECT disposition
             FROM event_ingress_receipts
            WHERE raw_event_id = ?`,
        ).all(getPersistedMessage('qq-24624')?.raw_event_id) as Array<{
          disposition: string;
        }>;
        expect(replayDispositions.map((row) => row.disposition).sort()).toEqual([
          'accepted',
          'duplicate',
        ]);

        const canonicalActor = db.prepare(
          `SELECT canonical_user_id
             FROM platform_accounts
            WHERE platform = 'qq' AND platform_account_id = '20711'`,
        ).get() as { canonical_user_id: string };
        const auditRows = db.prepare(
          `SELECT actor_user_id, actor_class, invocation_context, summary, details
             FROM audit_log
            WHERE event_type = 'group.summary_policy_changed'
              AND json_extract(details, '$.groupIdHash') = ?
            ORDER BY json_extract(details, '$.generation')`,
        ).all(groupIdHash) as Array<{
          actor_user_id: string;
          actor_class: string;
          invocation_context: string;
          summary: string;
          details: string;
        }>;
        expect(auditRows).toHaveLength(3);
        expect(auditRows.map((row) => ({
          actor_user_id: row.actor_user_id,
          actor_class: row.actor_class,
          invocation_context: row.invocation_context,
          summary: row.summary,
          details: JSON.parse(row.details) as Record<string, unknown>,
        }))).toEqual([
          {
            actor_user_id: canonicalActor.canonical_user_id,
            actor_class: 'group_admin',
            invocation_context: 'group_chat',
            summary: 'Group summary policy changed',
            details: {
              groupId: '[REDACTED:platform_id]',
              groupIdHash,
              oldState: 'disabled',
              newState: 'enabled',
              generation: 1,
              eligibleAfter: expect.any(Number),
              authority: 'group_admin',
              sourceEventId: getPersistedMessage('qq-24621')?.raw_event_id,
              canceledJobCount: 0,
            },
          },
          {
            actor_user_id: canonicalActor.canonical_user_id,
            actor_class: 'group_admin',
            invocation_context: 'group_chat',
            summary: 'Group summary policy changed',
            details: {
              groupId: '[REDACTED:platform_id]',
              groupIdHash,
              oldState: 'enabled',
              newState: 'disabled',
              generation: 2,
              eligibleAfter: null,
              authority: 'group_admin',
              sourceEventId: getPersistedMessage('qq-24623')?.raw_event_id,
              canceledJobCount: 1,
            },
          },
          {
            actor_user_id: canonicalActor.canonical_user_id,
            actor_class: 'group_admin',
            invocation_context: 'group_chat',
            summary: 'Group summary policy changed',
            details: {
              groupId: '[REDACTED:platform_id]',
              groupIdHash,
              oldState: 'disabled',
              newState: 'enabled',
              generation: 3,
              eligibleAfter: expect.any(Number),
              authority: 'group_admin',
              sourceEventId: getPersistedMessage('qq-24624')?.raw_event_id,
              canceledJobCount: 0,
            },
          },
        ]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-GOV-01 rolls back a governance effect when reply decision persistence fails', async () => {
      const db = app.getDatabase();
      const sentMessages: SentMessage[] = [];
      const groupId = 'qq-group-100076';
      const event = makeGroupEvent({
        messageId: 24625,
        userId: 20716,
        groupId: 100076,
        text: '/memory summary enable',
      });
      const policyAuditCountBefore = db.prepare(
        `SELECT COUNT(*) AS count FROM audit_log
          WHERE event_type = 'group.summary_policy_changed'`,
      ).get() as { count: number };
      setCapturingMessageSender(sentMessages);
      db.exec(`
        CREATE TEMP TRIGGER fail_governance_action_decision_insert
        BEFORE INSERT ON action_decisions
        WHEN (
          SELECT conversation_id FROM agent_turns WHERE id = NEW.turn_id
        ) = '${groupId}'
        BEGIN
          SELECT RAISE(ABORT, 'forced governance action decision insert failure');
        END
      `);

      try {
        const response = await postEvent(event);
        expect(response.status).toBe(200);
        expect(sentMessages).toEqual([]);
        expect(new GroupSummaryPolicyRepository(db).get(groupId)).toBeNull();
        expect(db.prepare(
          `SELECT COUNT(*) AS count FROM audit_log
            WHERE event_type = 'group.summary_policy_changed'`,
        ).get()).toEqual(policyAuditCountBefore);

        const turn = getTurnForMessage('qq-24625');
        expect(turn).toMatchObject({
          conversation_id: groupId,
          status: 'failed',
          action_decision_id: null,
        });
        expect(turn?.response_text).toContain('forced governance action decision insert failure');
        expect(getActionRowsForMessage('qq-24625')).toEqual([]);
        expect(db.prepare(
          `SELECT stage, conversation_type, turn_id
             FROM event_processing_failures WHERE turn_id = ?`,
        ).get(turn?.id)).toEqual({
          stage: 'governance_command',
          conversation_type: 'group',
          turn_id: turn?.id,
        });

        const duplicateResponse = await postEvent(event);
        expect(duplicateResponse.status).toBe(200);
        expect(new GroupSummaryPolicyRepository(db).get(groupId)).toBeNull();
        expect(countTurnsForMessage('qq-24625')).toBe(1);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        db.exec('DROP TRIGGER IF EXISTS fail_governance_action_decision_insert');
        app.clearEventProcessingFailuresForTesting();
        restoreDecisionDefaults();
      }
    });

    it('REL-GOV-01 forgets an in-scope memory and removes it from retrieval immediately', async () => {
      const db = app.getDatabase();
      const sentMessages: SentMessage[] = [];
      const evaluatorRequests: SocialEvaluationRequest[] = [];
      const memoryRepository = new MemoryRepository(db);
      const groupId = 'qq-group-100072';
      const memoryId = 'mem.gov.100072';
      let piCalls = 0;

      class CapturingEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          evaluatorRequests.push(request);
          return super.evaluateSocial(request);
        }
      }

      app.setSocialEvaluatorForTesting(new CapturingEvaluator());
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'Memory governance commands must not reach Pi.',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const sourceResponse = await postEvent(makeGroupEvent({
          messageId: 24630,
          userId: 20712,
          groupId: 100072,
          text: 'Governance fixture: govreliabilitytoken is present before deletion.',
        }));
        expect(sourceResponse.status).toBe(200);
        expect(countTurnsForMessage('qq-24630')).toBe(0);
        expect(getActionRowsForMessage('qq-24630')).toEqual([]);
        expect(sentMessages).toEqual([]);
        const source = getPersistedMessage('qq-24630');
        if (!source) {
          throw new Error('Expected persisted governance memory source');
        }
        const canonicalActor = db.prepare(
          `SELECT canonical_user_id
             FROM platform_accounts
            WHERE platform = 'qq' AND platform_account_id = '20712'`,
        ).get() as { canonical_user_id: string };

        memoryRepository.createSync({
          id: memoryId,
          scope: 'group',
          groupId,
          visibility: 'same_group_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'fact',
          title: 'Governance retrieval fixture',
          content: 'govreliabilitytoken is present before deletion',
          state: 'active',
          confidence: 0.9,
          importance: 0.7,
          sourceContext: 'group_chat',
          sources: [{
            sourceType: 'chat_message',
            sourceId: source.id,
            extractedBy: 'user',
          }],
          actor: {
            canonicalUserId: canonicalActor.canonical_user_id,
            actorClass: 'group_admin',
            context: 'group_chat',
          },
        });

        expect((await memoryRepository.search('govreliabilitytoken', {
          groupId,
          contextType: 'group',
          limit: 8,
        })).map((memory) => memory.id)).toContain(memoryId);

        const forgetResponse = await postEvent(makeGroupEvent({
          messageId: 24631,
          userId: 20712,
          groupId: 100072,
          text: `/memory forget ${memoryId}`,
        }));
        expect(forgetResponse.status).toBe(200);

        expect(db.prepare(
          'SELECT state FROM memory_records WHERE id = ?',
        ).get(memoryId)).toEqual({ state: 'deleted' });
        expect((await memoryRepository.search('govreliabilitytoken', {
          groupId,
          contextType: 'group',
          limit: 8,
        })).map((memory) => memory.id)).not.toContain(memoryId);
        expect((await memoryRepository.retrieve({
          groupId,
          contextType: 'group',
          limit: 8,
        })).map((memory) => memory.id)).not.toContain(memoryId);

        const revision = db.prepare(
          `SELECT revision_number, change_type, reason, actor, new_state
             FROM memory_revisions
            WHERE memory_id = ?
            ORDER BY revision_number DESC
            LIMIT 1`,
        ).get(memoryId) as {
          revision_number: number;
          change_type: string;
          reason: string;
          actor: string;
          new_state: string;
        };
        expect(revision).toMatchObject({
          revision_number: 2,
          change_type: 'delete',
          reason: 'QQ governance memory forget',
          actor: canonicalActor.canonical_user_id,
        });
        expect(JSON.parse(revision.new_state)).toMatchObject({ state: 'deleted' });

        const forgetSource = getPersistedMessage('qq-24631');
        const audit = db.prepare(
          `SELECT actor_user_id, actor_class, invocation_context,
                  summary, details, redacted, risk_level
             FROM audit_log
            WHERE event_type = 'memory.delete' AND event_id = ?`,
        ).get(memoryId) as {
          actor_user_id: string;
          actor_class: string;
          invocation_context: string;
          summary: string;
          details: string;
          redacted: number;
          risk_level: string;
        };
        expect(audit).toMatchObject({
          actor_user_id: canonicalActor.canonical_user_id,
          actor_class: 'group_admin',
          invocation_context: 'group_chat',
          summary: 'QQ governance deleted one memory record',
          redacted: 1,
          risk_level: 'low',
        });
        expect(JSON.parse(audit.details)).toMatchObject({
          memoryId: '[redacted-id]',
          policyDecision: expect.stringMatching(
            /^policy:l0:deleted:sha256:[0-9a-f]{64}$/,
          ),
          previousState: 'active',
          newState: 'deleted',
          revisionNumber: 2,
          sourceEventId: forgetSource?.raw_event_id,
          governanceCommand: 'memory_forget',
          authority: 'group_admin',
        });

        expect(piCalls).toBe(0);
        expect(evaluatorRequests).toHaveLength(0);
        expect(sentMessages).toHaveLength(1);
        expectSuccessfulGroupGovernanceCommand(
          'qq-24631',
          sentMessages[0],
          'Memory record deleted.',
        );
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-GOV-01 explains the latest prior turn from the exact conversation only', async () => {
      const db = app.getDatabase();
      const sentMessages: SentMessage[] = [];
      const evaluatorRequests: SocialEvaluationRequest[] = [];
      const tokenTotals = [7, 13, 23, 31];
      let piCalls = 0;

      class CapturingEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          evaluatorRequests.push(request);
          return super.evaluateSocial(request);
        }
      }

      app.setSocialEvaluatorForTesting(new CapturingEvaluator());
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          const total = tokenTotals[piCalls] ?? 41;
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: `Synthetic prior turn with ${total} tokens.`,
            toolCallIds: [],
            events: [],
            tokensUsed: { input: total - 1, output: 1, total },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const priorEvents: OneBotMessage[] = [
          makeGroupEvent({
            messageId: 24640,
            userId: 20713,
            groupId: 100073,
            text: '[CQ:at,qq=3889000770] First target-conversation turn.',
          }),
          makeGroupEvent({
            messageId: 24641,
            userId: 20713,
            groupId: 100073,
            text: '[CQ:at,qq=3889000770] Latest target-conversation turn.',
          }),
          makeGroupEvent({
            messageId: 24642,
            userId: 20713,
            groupId: 100074,
            text: '[CQ:at,qq=3889000770] Later turn from another group.',
          }),
          {
            post_type: 'message',
            message_type: 'private',
            message_id: 24643,
            user_id: 20713,
            message: 'Later turn from a private conversation.',
            raw_message: 'Later turn from a private conversation.',
            sender: {
              user_id: 20713,
              nickname: 'GovernanceWhyUser',
            },
            time: Math.floor(Date.now() / 1000),
          },
        ];
        for (const event of priorEvents) {
          app.clearCooldownsForTesting();
          const response = await postEvent(event);
          expect(response.status).toBe(200);
        }

        expect(getTurnForMessage('qq-24640')).toMatchObject({
          status: 'completed',
          tokens_total: 7,
        });
        const latestTargetTurn = getTurnForMessage('qq-24641');
        expect(latestTargetTurn).toMatchObject({
          status: 'completed',
          tokens_total: 13,
        });
        expect(getTurnForMessage('qq-24642')).toMatchObject({
          status: 'completed',
          tokens_total: 23,
        });
        expect(getTurnForMessage('qq-24643')).toMatchObject({
          status: 'completed',
          tokens_total: 31,
        });

        const latestTargetTrace = getContextTraceForMessage('qq-24641');
        expect(latestTargetTrace).toBeDefined();
        const selectedCount = (JSON.parse(
          latestTargetTrace?.selected_memory_ids ?? '[]',
        ) as unknown[]).length;
        const rejectedCount = (JSON.parse(
          latestTargetTrace?.rejected_memories ?? '[]',
        ) as unknown[]).length;
        const latestTargetActionCounts = db.prepare(
          `SELECT
             (SELECT COUNT(*) FROM action_decisions WHERE turn_id = ?) AS decisions,
             (SELECT COUNT(*)
                FROM action_executions
                JOIN action_decisions
                  ON action_decisions.id = action_executions.action_decision_id
               WHERE action_decisions.turn_id = ?) AS executions,
             (SELECT COUNT(*) FROM tool_calls WHERE turn_id = ?) AS tools`,
        ).get(
          latestTargetTurn?.id,
          latestTargetTurn?.id,
          latestTargetTurn?.id,
        ) as { decisions: number; executions: number; tools: number };
        const expectedWhyResponse = [
          'Prior turn evidence:',
          'turn_status=completed',
          'stored_context=yes',
          `selected_memories=${selectedCount}`,
          `rejected_memories=${rejectedCount}`,
          'tokens_used=13',
          `action_decisions=${latestTargetActionCounts.decisions}`,
          `action_executions=${latestTargetActionCounts.executions}`,
          `tool_calls=${latestTargetActionCounts.tools}`,
        ].join('\n');

        const piCallsBeforeWhy = piCalls;
        const evaluatorCallsBeforeWhy = evaluatorRequests.length;
        const toolCallsBeforeWhy = db.prepare(
          'SELECT COUNT(*) AS count FROM tool_calls',
        ).get() as { count: number };
        const sendsBeforeWhy = sentMessages.length;
        app.clearCooldownsForTesting();
        const whyResponse = await postEvent(makeGroupEvent({
          messageId: 24644,
          userId: 20713,
          groupId: 100073,
          text: '/why',
        }));
        expect(whyResponse.status).toBe(200);

        expect(piCalls).toBe(piCallsBeforeWhy);
        expect(evaluatorRequests).toHaveLength(evaluatorCallsBeforeWhy);
        expect(db.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual(
          toolCallsBeforeWhy,
        );
        expect(sentMessages).toHaveLength(sendsBeforeWhy + 1);
        expectSuccessfulGroupGovernanceCommand(
          'qq-24644',
          sentMessages[sendsBeforeWhy],
          expectedWhyResponse,
        );
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-GOV-01 completes the local turn while preserving a failed governance send', async () => {
      const sentMessages: SentMessage[] = [];
      const evaluatorRequests: SocialEvaluationRequest[] = [];
      const rawSecret = 'sk-governance-send-failure-secret-should-not-persist';
      const rawPlatformId = 'qq-9876543210';
      const rawFailure = `governance send failed api_key=${rawSecret} target=${rawPlatformId}`;
      const conversationId = 'qq-group-100075';
      let piCalls = 0;

      class CapturingEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          evaluatorRequests.push(request);
          return super.evaluateSocial(request);
        }
      }

      app.setSocialEvaluatorForTesting(new CapturingEvaluator());
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'Failed governance sends must not reach Pi.',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages, rawFailure);

      try {
        const response = await postEvent(makeGroupEvent({
          messageId: 24650,
          userId: 20715,
          groupId: 100075,
          text: '/memory',
        }));
        expect(response.status).toBe(200);
        expect(piCalls).toBe(0);
        expect(evaluatorRequests).toHaveLength(0);

        const source = getPersistedMessage('qq-24650');
        const turn = getTurnForMessage('qq-24650');
        expect(turn).toMatchObject({
          conversation_id: conversationId,
          trigger_event_id: source?.raw_event_id,
          pi_provider: 'local',
          pi_model: 'qq-governance-v1',
          response_text: 'Memory records: none.',
          status: 'completed',
          tokens_input: 0,
          tokens_output: 0,
          tokens_total: 0,
        });
        expect(turn?.action_decision_id).toBeDefined();
        expect(turn?.completed_at).toBeGreaterThan(0);
        expect(countNonTerminalTurnsForMessage('qq-24650')).toBe(0);

        const actionRows = getActionRowsForMessage('qq-24650');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          turn_id: turn?.id,
          decided_by: 'attention',
          risk_level: 'low',
          confidence: 1,
          evaluator_required: 0,
          evaluator_passed: null,
          evaluator_decision_id: null,
          action_type: 'reply_short',
          status: 'failed',
          executed_message_id: null,
          error_code: 'SEND_MESSAGE_FAILED',
        });
        expect(JSON.parse(actionRows[0]?.reasons ?? '[]')).toEqual([
          'Deterministic QQ governance command',
        ]);
        expect(JSON.parse(actionRows[0]?.actions ?? '[]')).toEqual([
          expect.objectContaining({
            type: 'reply_short',
            payload: { text: 'Memory records: none.' },
          }),
        ]);
        expect(actionRows[0]?.error_message).toContain('[REDACTED:api_key_assignment]');
        expect(actionRows[0]?.error_message).toContain('[REDACTED:platform_id]');
        expect(actionRows[0]?.error_message).not.toContain(rawSecret);
        expect(actionRows[0]?.error_message).not.toContain(rawPlatformId);

        expect(sentMessages).toHaveLength(1);
        expect(getPersistedMessage(sentMessages[0]?.messageId ?? '')).toBeUndefined();
        expect(countBotResponseRawEvents(conversationId)).toBe(0);
        expect(countBotResponseRows(conversationId)).toBe(0);
        expect(app.getDatabase().prepare(
          'SELECT COUNT(*) AS count FROM tool_calls WHERE turn_id = ?',
        ).get(turn?.id)).toEqual({ count: 0 });
        expect(app.getDatabase().prepare(
          'SELECT COUNT(*) AS count FROM evaluator_decisions WHERE turn_id = ?',
        ).get(turn?.id)).toEqual({ count: 0 });
        expect(app.getEventProcessingFailures()).toHaveLength(0);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore malformed top-level OneBot identifiers without synthetic object or boolean IDs', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'malformed top-level identifiers should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent = {
          post_type: 'message',
          message_type: 'group',
          message_id: { value: 'malformed-message-id-should-not-persist' },
          user_id: true,
          group_id: ['malformed-group-id-should-not-persist'],
          message: 'malformed top-level identifiers should be bounded',
          raw_message: 'malformed top-level identifiers should be bounded',
          sender: {
            user_id: { value: 'malformed-sender-id-should-not-persist' },
            nickname: 'Malformed Identifier User',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        } as unknown as OneBotMessage;

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const row = app
          .getDatabase()
          .prepare(
            `SELECT cm.*, re.payload
             FROM chat_messages cm
             JOIN raw_events re ON re.id = cm.raw_event_id
             WHERE cm.text = ?
             ORDER BY cm.timestamp DESC
             LIMIT 1`
          )
          .get('malformed top-level identifiers should be bounded') as
          | (PersistedMessageRow & { payload: string })
          | undefined;

        expect(row).toMatchObject({
          conversation_id: 'qq-group-unknown',
          conversation_type: 'group',
          group_id: 'qq-group-unknown',
          sender_id: 'qq-unknown',
          sender_role: 'member',
          text: 'malformed top-level identifiers should be bounded',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });
        expect(row?.message_id).toMatch(/^qq-local-/);

        const serializedRow = JSON.stringify(row);
        expect(serializedRow).not.toContain('qq-[object Object]');
        expect(serializedRow).not.toContain('qq-true');
        expect(serializedRow).not.toContain('qq-group-malformed-group-id-should-not-persist');
        expect(serializedRow).not.toContain('malformed-message-id-should-not-persist');
        expect(serializedRow).not.toContain('malformed-sender-id-should-not-persist');
        expect(serializedRow).not.toContain('malformed-group-id-should-not-persist');

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage(row?.message_id ?? '')).toBe(0);
        expect(getContextTraceForMessage(row?.message_id ?? '')).toBeUndefined();
        expect(getActionRowsForMessage(row?.message_id ?? '')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should reject non-positive or fractional numeric top-level OneBot identifiers', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'invalid numeric identifiers should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent = {
          post_type: 'message',
          message_type: 'group',
          message_id: -123.5,
          user_id: -10001,
          group_id: 20001.5,
          message: 'invalid numeric identifiers should be bounded',
          raw_message: 'invalid numeric identifiers should be bounded',
          sender: {
            user_id: -10002,
            nickname: 'Invalid Numeric Identifier User',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        } as unknown as OneBotMessage;

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const row = app
          .getDatabase()
          .prepare(
            `SELECT cm.*, re.payload
             FROM chat_messages cm
             JOIN raw_events re ON re.id = cm.raw_event_id
             WHERE cm.text = ?
             ORDER BY cm.timestamp DESC
             LIMIT 1`
          )
          .get('invalid numeric identifiers should be bounded') as
          | (PersistedMessageRow & { payload: string })
          | undefined;

        expect(row).toMatchObject({
          conversation_id: 'qq-group-unknown',
          conversation_type: 'group',
          group_id: 'qq-group-unknown',
          sender_id: 'qq-unknown',
          sender_role: 'member',
          text: 'invalid numeric identifiers should be bounded',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });
        expect(row?.message_id).toMatch(/^qq-local-/);

        const serializedRow = JSON.stringify(row);
        expect(serializedRow).not.toContain('qq--');
        expect(serializedRow).not.toContain('qq-group-20001.5');
        expect(serializedRow).not.toContain('qq--10001');
        expect(serializedRow).not.toContain('qq--10002');
        expect(serializedRow).not.toContain('qq--123.5');

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage(row?.message_id ?? '')).toBe(0);
        expect(getContextTraceForMessage(row?.message_id ?? '')).toBeUndefined();
        expect(getActionRowsForMessage(row?.message_id ?? '')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore secret-like malformed top-level OneBot string identifiers', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-top-level-string-secret-should-not-persist';
      const rawPlatformFragment = 'qq-1234567890';
      const malformedMessageId = `api_key=${rawSecret}`;
      const malformedUserId = `sender-${rawPlatformFragment}-${rawSecret}`;
      const malformedGroupId = `group-${rawPlatformFragment}-${rawSecret}`;

      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'malformed string identifiers should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent = {
          post_type: 'message',
          message_type: 'group',
          message_id: malformedMessageId,
          user_id: malformedUserId,
          group_id: malformedGroupId,
          message: 'malformed string identifiers should be bounded',
          raw_message: 'malformed string identifiers should be bounded',
          sender: {
            user_id: `nested-${rawPlatformFragment}-${rawSecret}`,
            nickname: 'Malformed String Identifier User',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        } as unknown as OneBotMessage;

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const row = app
          .getDatabase()
          .prepare(
            `SELECT cm.*, re.payload
             FROM chat_messages cm
             JOIN raw_events re ON re.id = cm.raw_event_id
             WHERE cm.text = ?
             ORDER BY cm.timestamp DESC
             LIMIT 1`
          )
          .get('malformed string identifiers should be bounded') as
          | (PersistedMessageRow & { payload: string })
          | undefined;

        expect(row).toMatchObject({
          conversation_id: 'qq-group-unknown',
          conversation_type: 'group',
          group_id: 'qq-group-unknown',
          sender_id: 'qq-unknown',
          sender_role: 'member',
          text: 'malformed string identifiers should be bounded',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });
        expect(row?.message_id).toMatch(/^qq-local-/);

        const serializedRow = JSON.stringify(row);
        expect(serializedRow).not.toContain(rawSecret);
        expect(serializedRow).not.toContain(rawPlatformFragment);
        expect(serializedRow).not.toContain(malformedMessageId);
        expect(serializedRow).not.toContain(malformedUserId);
        expect(serializedRow).not.toContain(malformedGroupId);

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage(row?.message_id ?? '')).toBe(0);
        expect(getContextTraceForMessage(row?.message_id ?? '')).toBeUndefined();
        expect(getActionRowsForMessage(row?.message_id ?? '')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should bound malformed top-level message content without adapter diagnostics or raw fragment persistence', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-malformed-message-content-e2e-secret-should-not-persist';
      const rawPlatformFragment = 'qq-8123456795';
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'malformed message content should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23990,
          user_id: 290920,
          group_id: 190920,
          message: { token: rawSecret, target: rawPlatformFragment },
          raw_message: { text: `token=${rawSecret} target=${rawPlatformFragment}` },
          sender: {
            user_id: 290920,
            nickname: 'MalformedContentUser',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        } as unknown as OneBotMessage;

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const row = app
          .getDatabase()
          .prepare(
            `SELECT cm.*, re.type AS raw_type, re.payload
             FROM chat_messages cm
             JOIN raw_events re ON re.id = cm.raw_event_id
             WHERE cm.message_id = ?
             LIMIT 1`
          )
          .get('qq-23990') as (PersistedMessageRow & { payload: string }) | undefined;

        expect(row).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: row?.id,
          message_id: 'qq-23990',
          conversation_id: 'qq-group-190920',
          conversation_type: 'group',
          group_id: 'qq-group-190920',
          sender_id: 'qq-290920',
          sender_role: 'member',
          text: '',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const serializedRow = JSON.stringify(row);
        expect(serializedRow).not.toContain(rawSecret);
        expect(serializedRow).not.toContain(rawPlatformFragment);
        expect(serializedRow).not.toContain('8123456795');
        expect(serializedRow).not.toContain('raw.slice is not a function');

        const rawPayload = JSON.parse(row?.payload ?? '{}') as {
          message?: {
            content?: { text?: string; media?: Array<{ type: string; url?: string }> };
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
          };
        };
        expect(rawPayload.message?.content?.text).toBe('');
        expect(rawPayload.message?.content?.media).toEqual([]);
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23990')).toBe(0);
        expect(getContextTraceForMessage('qq-23990')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23990')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should keep malformed private top-level message content out of Pi and action flow', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-malformed-private-content-e2e-secret-should-not-persist';
      const rawPlatformFragment = 'qq-8123456796';
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'malformed private content should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent = {
          post_type: 'message',
          message_type: 'private',
          message_id: 23991,
          user_id: 290921,
          message: { token: rawSecret, target: rawPlatformFragment },
          raw_message: { text: `token=${rawSecret} target=${rawPlatformFragment}` },
          sender: {
            user_id: 290921,
            nickname: 'MalformedPrivateContentUser',
          },
          time: Math.floor(Date.now() / 1000),
        } as unknown as OneBotMessage;

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const row = app
          .getDatabase()
          .prepare(
            `SELECT cm.*, re.type AS raw_type, re.payload
             FROM chat_messages cm
             JOIN raw_events re ON re.id = cm.raw_event_id
             WHERE cm.message_id = ?
             LIMIT 1`
          )
          .get('qq-23991') as (PersistedMessageRow & { payload: string }) | undefined;

        expect(row).toMatchObject({
          raw_type: 'chat.message.received',
          message_id: 'qq-23991',
          conversation_type: 'private',
          group_id: null,
          sender_id: 'qq-290921',
          text: '',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });
        expect(row?.payload).not.toContain(rawSecret);
        expect(row?.payload).not.toContain(rawPlatformFragment);

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23991')).toBe(0);
        expect(getContextTraceForMessage('qq-23991')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23991')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore malformed OneBot timestamps and persist receipt-time fallbacks', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'malformed timestamps should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const malformedTimes: unknown[] = [
          '1700000000',
          true,
          [],
          { value: 'malformed-time-should-not-persist' },
        ];

        for (const [index, malformedTime] of malformedTimes.entries()) {
          const text = `malformed timestamp should fallback ${index}`;
          const before = Date.now();
          const onebotEvent = {
            post_type: 'message',
            message_type: 'group',
            message_id: 23600 + index,
            user_id: 20600 + index,
            group_id: 10600,
            message: text,
            raw_message: text,
            sender: {
              user_id: 20600 + index,
              nickname: `TimestampUser${index}`,
              role: 'member',
            },
            time: malformedTime,
          } as unknown as OneBotMessage;

          const response = await postEvent(onebotEvent);
          const after = Date.now();

          expect(response.status).toBe(200);
          await expect(response.json()).resolves.toEqual({ status: 'ok' });

          const row = app
            .getDatabase()
            .prepare(
              `SELECT cm.message_id, cm.timestamp AS chat_timestamp,
                      cm.mentions_bot, re.timestamp AS raw_timestamp, re.payload
               FROM chat_messages cm
               JOIN raw_events re ON re.id = cm.raw_event_id
               WHERE cm.message_id = ?
               LIMIT 1`
            )
            .get(`qq-${23600 + index}`) as
            | {
              message_id: string;
              chat_timestamp: number;
              mentions_bot: number;
              raw_timestamp: number;
              payload: string;
            }
            | undefined;

          expect(row).toBeDefined();
          expect(row?.mentions_bot).toBe(0);
          expect(row?.chat_timestamp).toBeGreaterThanOrEqual(before);
          expect(row?.chat_timestamp).toBeLessThanOrEqual(after);
          expect(row?.raw_timestamp).toBe(row?.chat_timestamp);

          const payload = JSON.parse(row?.payload ?? '{}') as { timestamp?: unknown };
          expect(typeof payload.timestamp).toBe('string');
          expect(new Date(payload.timestamp as string).getTime()).toBe(row?.chat_timestamp);
          expect(row?.payload).not.toContain('malformed-time-should-not-persist');
        }

        expect(piCalls).toBe(0);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore malformed non-string sender metadata without dropping the group message', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'malformed sender metadata should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23557,
          user_id: 20017,
          group_id: 100001,
          message: 'malformed sender metadata should be ignored',
          raw_message: 'malformed sender metadata should be ignored',
          sender: {
            user_id: 20017,
            nickname: ['malformed-nickname-should-not-persist'],
            card: { text: 'malformed-card-should-not-persist' },
            role: true,
          },
          time: Math.floor(Date.now() / 1000),
        } as unknown as OneBotMessage;

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const persisted = getPersistedMessage('qq-23557');
        expect(persisted).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: persisted?.id,
          message_id: 'qq-23557',
          conversation_id: 'qq-group-100001',
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'qq-20017',
          sender_role: null,
          text: 'malformed sender metadata should be ignored',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const displayProfile = app
          .getDatabase()
          .prepare(
            `SELECT dp.current_display_name
             FROM display_profiles dp
             JOIN platform_accounts pa ON pa.canonical_user_id = dp.canonical_user_id
             WHERE pa.platform = 'qq' AND pa.platform_account_id = ?`
          )
          .get('20017') as { current_display_name: string } | undefined;
        expect(displayProfile).toBeUndefined();

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(persisted?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        const serializedRawPayload = JSON.stringify(JSON.parse(rawEventRow?.payload ?? '{}'));
        expect(serializedRawPayload).not.toContain('malformed-nickname-should-not-persist');
        expect(serializedRawPayload).not.toContain('malformed-card-should-not-persist');
        expect(serializedRawPayload).not.toContain('senderRole');

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23557')).toBe(0);
        expect(getContextTraceForMessage('qq-23557')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23557')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should redact secret-like sender display metadata before profile persistence', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'display metadata persistence redaction should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      const rawSecret = 'sk-display-card-secret-should-not-persist-123456';
      const rawPlatformId = 'qq-6611223344';

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23980,
          user_id: 290980,
          group_id: 190980,
          message: 'display metadata should be redacted before identity storage',
          raw_message: 'display metadata should be redacted before identity storage',
          sender: {
            user_id: 290980,
            nickname: `Nick token=${rawSecret} owner=${rawPlatformId}`,
            card: `Card api_key=${rawSecret} owner=${rawPlatformId}`,
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const persisted = getPersistedMessage('qq-23980');
        expect(persisted).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: persisted?.id,
          message_id: 'qq-23980',
          conversation_id: 'qq-group-190980',
          conversation_type: 'group',
          group_id: 'qq-group-190980',
          sender_id: 'qq-290980',
          text: 'display metadata should be redacted before identity storage',
          mentions_bot: 0,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(persisted?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).toContain('[REDACTED:api_key_assignment]');
        expect(rawEventRow?.payload).toContain('[REDACTED:platform_id]');
        expect(rawEventRow?.payload).not.toContain(rawSecret);
        expect(rawEventRow?.payload).not.toContain(rawPlatformId);
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            senderDisplayName?: string;
            senderCard?: string;
          };
        };
        expect(rawPayload.message?.senderDisplayName).toContain('[REDACTED:api_key_assignment]');
        expect(rawPayload.message?.senderDisplayName).toContain('[REDACTED:platform_id]');
        expect(rawPayload.message?.senderCard).toContain('[REDACTED:api_key_assignment]');
        expect(rawPayload.message?.senderCard).toContain('[REDACTED:platform_id]');

        const displayRows = app
          .getDatabase()
          .prepare(
            `SELECT dp.current_display_name, nh.display_name
             FROM display_profiles dp
             JOIN platform_accounts pa ON pa.canonical_user_id = dp.canonical_user_id
             JOIN nickname_history nh
               ON nh.canonical_user_id = dp.canonical_user_id
              AND nh.source_group_id = dp.source_group_id
             WHERE pa.platform = 'qq'
               AND pa.platform_account_id = ?
               AND dp.source_group_id = ?`
          )
          .all('290980', 'qq-group-190980') as Array<{
            current_display_name: string;
            display_name: string;
          }>;

        expect(displayRows).toHaveLength(1);
        const serializedDisplayRows = JSON.stringify(displayRows);
        expect(serializedDisplayRows).toContain('[REDACTED:api_key_assignment]');
        expect(serializedDisplayRows).toContain('[REDACTED:platform_id]');
        expect(serializedDisplayRows).not.toContain(rawSecret);
        expect(serializedDisplayRows).not.toContain(rawPlatformId);

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23980')).toBe(0);
        expect(getContextTraceForMessage('qq-23980')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23980')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it.each([
      {
        description: 'mentions another QQ user',
        messageId: 23558,
        message: '[CQ:at,qq=3889000771] 这不是给 bot 的消息',
        expectedText: '这不是给 bot 的消息',
      },
      {
        description: 'contains the bot QQ id as plain text',
        messageId: 23559,
        message: 'bot id 3889000770 只是普通文本',
        expectedText: 'bot id 3889000770 只是普通文本',
      },
    ])('should not trigger group reply when a near-miss mention $description', async ({ messageId, message, expectedText }) => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'near-miss mention should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: messageId,
          user_id: 20003,
          group_id: 100001,
          message,
          raw_message: message,
          sender: {
            user_id: 20003,
            nickname: 'GroupNearMissUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('ok');

        const platformMessageId = `qq-${messageId}`;
        const persisted = getPersistedMessage(platformMessageId);
        expect(persisted).toBeDefined();
        expect(persisted?.raw_event_id).toBe(persisted?.id);
        expect(persisted?.raw_type).toBe('chat.message.received');
        expect(persisted?.conversation_type).toBe('group');
        expect(persisted?.group_id).toBe('qq-group-100001');
        expect(persisted?.text).toBe(expectedText);
        expect(persisted?.mentions_bot).toBe(0);
        expect(piCalls).toBe(0);
        expect(countTurnsForMessage(platformMessageId)).toBe(0);
        expect(getContextTraceForMessage(platformMessageId)).toBeUndefined();
        expect(getActionRowsForMessage(platformMessageId)).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore unknown CQ-string tags without metadata side effects', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'unknown CQ tags should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const message =
          '[CQ:poke,qq=3889000770]' +
          '[CQ:reply_like,id=23903]' +
          '[CQ:mface,url=https://example.test/ignored-cq-url.png]' +
          '[CQ:json,data=ignored-cq-marker]' +
          ' unknown CQ tags should be ignored';
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23560,
          user_id: 20003,
          group_id: 100001,
          message,
          raw_message: message,
          sender: {
            user_id: 20003,
            nickname: 'GroupUnknownCqUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23560');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23560',
          conversation_id: 'qq-group-100001',
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'qq-20003',
          text: 'unknown CQ tags should be ignored',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
              quote?: { messageId: string; senderId: string };
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('unknown CQ tags should be ignored');
        expect(rawPayload.message?.content?.media).toEqual([]);
        expect(rawPayload.message?.content?.quote).toBeUndefined();
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23560')).toBe(0);
        expect(getContextTraceForMessage('qq-23560')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23560')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should not trigger group reply when a CQ-string uses at-all instead of exact bot mention', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'CQ-string at-all should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const message = '[CQ:at,qq=all] 这是 CQ 群体提醒，不是精确 @bot';
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23566,
          user_id: 20012,
          group_id: 100001,
          message,
          raw_message: message,
          sender: {
            user_id: 20012,
            nickname: 'GroupCqAtAllUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23566');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23566',
          conversation_id: 'qq-group-100001',
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'qq-20012',
          text: '这是 CQ 群体提醒，不是精确 @bot',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
              quote?: { messageId: string; senderId: string };
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('这是 CQ 群体提醒，不是精确 @bot');
        expect(rawPayload.message?.content?.media).toEqual([]);
        expect(rawPayload.message?.content?.quote).toBeUndefined();
        expect(rawPayload.message?.mentions).toEqual(['qq-all']);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23566')).toBe(0);
        expect(getContextTraceForMessage('qq-23566')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23566')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore empty or malformed CQ-string params without mention or quote side effects', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'malformed CQ params should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const message =
          '[CQ:at][CQ:at,qq][CQ:at,qq=]' +
          '[CQ:reply][CQ:reply,id][CQ:reply,id=]' +
          '[CQ:image][CQ:record,url][CQ:video,url=][CQ:file,url=]' +
          ' malformed CQ params stay inert';
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23567,
          user_id: 20013,
          group_id: 100001,
          message,
          raw_message: message,
          sender: {
            user_id: 20013,
            nickname: 'GroupMalformedCqParamUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23567');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23567',
          conversation_id: 'qq-group-100001',
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'qq-20013',
          text: 'malformed CQ params stay inert',
          has_quote: 0,
          has_media: 1,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
              quote?: { messageId: string; senderId: string };
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('malformed CQ params stay inert');
        expect(rawPayload.message?.content?.media).toEqual([
          { type: 'image' },
          { type: 'audio' },
          { type: 'video' },
          { type: 'file' },
        ]);
        expect(rawPayload.message?.content?.quote).toBeUndefined();
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23567')).toBe(0);
        expect(getContextTraceForMessage('qq-23567')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23567')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore secret-like malformed CQ-string identifier params without metadata side effects', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-cq-id-secret-should-not-persist';
      const rawPlatformFragment = 'qq-1234567890';
      const malformedReplyId = `reply-${rawPlatformFragment}-${rawSecret}`;
      const malformedMentionId = `mention-${rawPlatformFragment}-${rawSecret}`;
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'secret-like CQ identifiers should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const message =
          `[CQ:reply,id=${malformedReplyId}]` +
          `[CQ:at,qq=${malformedMentionId}]` +
          ' malformed CQ string ids should be ignored';
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23570,
          user_id: 20070,
          group_id: 100001,
          message,
          raw_message: message,
          sender: {
            user_id: 20070,
            nickname: 'GroupSecretLikeCqIdUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23570');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23570',
          conversation_id: 'qq-group-100001',
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'qq-20070',
          text: 'malformed CQ string ids should be ignored',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        expect(rawEventRow?.payload).not.toContain(rawSecret);
        expect(rawEventRow?.payload).not.toContain(rawPlatformFragment);
        expect(rawEventRow?.payload).not.toContain(malformedReplyId);
        expect(rawEventRow?.payload).not.toContain(malformedMentionId);
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
              quote?: { messageId: string; senderId: string };
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('malformed CQ string ids should be ignored');
        expect(rawPayload.message?.content?.media).toEqual([]);
        expect(rawPayload.message?.content?.quote).toBeUndefined();
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23570')).toBe(0);
        expect(getContextTraceForMessage('qq-23570')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23570')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should drop secret-like CQ-string media URLs while preserving media presence', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-cq-media-url-secret-should-not-persist';
      const rawPlatformFragment = 'qq-1234567890';
      const sensitiveImageUrl =
        `https://example.test/private-image.png?api_key=${rawSecret}&owner=${rawPlatformFragment}`;
      const sensitiveRecordUrl =
        `https://example.test/private-audio.amr?download_token=${rawSecret}&legacy=${rawPlatformFragment}`;
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'secret-like media URLs should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const message =
          `[CQ:image,url=${sensitiveImageUrl}]` +
          `[CQ:record,url=${sensitiveRecordUrl}]` +
          ' sensitive media URLs should be dropped';
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23571,
          user_id: 20071,
          group_id: 100001,
          message,
          raw_message: message,
          sender: {
            user_id: 20071,
            nickname: 'GroupSecretLikeMediaUrlUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23571');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23571',
          conversation_id: 'qq-group-100001',
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'qq-20071',
          text: 'sensitive media URLs should be dropped',
          has_quote: 0,
          has_media: 1,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        expect(rawEventRow?.payload).not.toContain(rawSecret);
        expect(rawEventRow?.payload).not.toContain(rawPlatformFragment);
        expect(rawEventRow?.payload).not.toContain(sensitiveImageUrl);
        expect(rawEventRow?.payload).not.toContain(sensitiveRecordUrl);
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('sensitive media URLs should be dropped');
        expect(rawPayload.message?.content?.media).toEqual([
          { type: 'image' },
          { type: 'audio' },
        ]);
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23571')).toBe(0);
        expect(getContextTraceForMessage('qq-23571')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23571')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should decode CQ-string escaped text and media params without changing mention boundaries', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'CQ decode boundary should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const message =
          '[CQ:at,qq=3889000771]' +
          '[CQ:image,url=https://example.test/image&#91;v1&#93;.png?caption=a&amp;b&#44;c]' +
          ' escaped &#91;text&#93; &amp; comma&#44; stays text';
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23568,
          user_id: 20014,
          group_id: 100001,
          message,
          raw_message: message,
          sender: {
            user_id: 20014,
            nickname: 'GroupCqEscapedUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23568');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23568',
          conversation_id: 'qq-group-100001',
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'qq-20014',
          text: 'escaped [text] & comma, stays text',
          has_quote: 0,
          has_media: 1,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        expect(rawEventRow?.payload).not.toContain('&#91;');
        expect(rawEventRow?.payload).not.toContain('&amp;');
        expect(rawEventRow?.payload).not.toContain('&#44;');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
              quote?: { messageId: string; senderId: string };
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('escaped [text] & comma, stays text');
        expect(rawPayload.message?.content?.media).toEqual([
          {
            type: 'image',
            url: 'https://example.test/image[v1].png?caption=a&b,c',
          },
        ]);
        expect(rawPayload.message?.content?.quote).toBeUndefined();
        expect(rawPayload.message?.mentions).toEqual(['qq-3889000771']);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23568')).toBe(0);
        expect(getContextTraceForMessage('qq-23568')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23568')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should not trigger group reply when a segment-array mentions a non-bot account', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'segment-array non-target mention should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23904,
          user_id: 290904,
          group_id: 190904,
          message: [
            { type: 'at', data: { qq: '3889000771' } },
            { type: 'text', data: { text: ' 这不是给 bot 的 segment array' } },
          ],
          raw_message: 'structured non-target segment array message',
          sender: {
            user_id: 290904,
            nickname: 'SegmentArrayNearMissUser',
            card: 'SegmentArrayNearMissCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('ok');

        const inboundMessage = getPersistedMessage('qq-23904');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23904',
          conversation_id: 'qq-group-190904',
          conversation_type: 'group',
          group_id: 'qq-group-190904',
          sender_id: 'qq-290904',
          sender_role: 'member',
          text: '这不是给 bot 的 segment array',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            content?: {
              text?: string;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('这不是给 bot 的 segment array');
        expect(rawPayload.message?.mentions).toEqual(['qq-3889000771']);
        expect(rawPayload.message?.mentionsBot).toBe(false);

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23904')).toBe(0);
        expect(getContextTraceForMessage('qq-23904')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23904')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should not trigger group reply when a segment-array uses at-all instead of exact bot mention', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'segment-array at-all should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23912,
          user_id: 290912,
          group_id: 190912,
          message: [
            { type: 'at', data: { qq: 'all' } },
            { type: 'text', data: { text: ' 这是群体提醒，不是精确 @bot' } },
          ],
          raw_message: 'structured at-all segment array message',
          sender: {
            user_id: 290912,
            nickname: 'SegmentArrayAtAllUser',
            card: 'SegmentArrayAtAllCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('ok');

        const inboundMessage = getPersistedMessage('qq-23912');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23912',
          conversation_id: 'qq-group-190912',
          conversation_type: 'group',
          group_id: 'qq-group-190912',
          sender_id: 'qq-290912',
          sender_role: 'member',
          text: '这是群体提醒，不是精确 @bot',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            content?: {
              text?: string;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('这是群体提醒，不是精确 @bot');
        expect(rawPayload.message?.mentions).toEqual(['qq-all']);
        expect(rawPayload.message?.mentionsBot).toBe(false);

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23912')).toBe(0);
        expect(getContextTraceForMessage('qq-23912')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23912')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should trigger group reply when a segment-array uses a numeric bot at value', async () => {
      const sentMessages: SentMessage[] = [];
      let capturedPiInput: PiAdapterInput | undefined;
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          capturedPiInput = input;
          return {
            turnId: input.turnId,
            responseText: 'numeric segment at reply',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 11, output: 7, total: 18 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23913,
          user_id: 290913,
          group_id: 190913,
          message: [
            { type: 'at', data: { qq: 3889000770 } },
            { type: 'text', data: { text: ' 数字 QQ 精确 @bot' } },
          ],
          raw_message: 'structured numeric bot-at segment array message',
          sender: {
            user_id: 290913,
            nickname: 'SegmentArrayNumericAtUser',
            card: 'SegmentArrayNumericAtCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });
        expect(capturedPiInput?.contextPack.conversation.groupId).toBe('qq-group-190913');
        expect(capturedPiInput?.actor.groupId).toBe('qq-group-190913');
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
          target: {
            conversationId: 'qq-group-190913',
            conversationType: 'group',
            groupId: 'qq-group-190913',
          },
          text: 'numeric segment at reply',
        });

        const inboundMessage = getPersistedMessage('qq-23913');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23913',
          conversation_id: 'qq-group-190913',
          conversation_type: 'group',
          group_id: 'qq-group-190913',
          sender_id: 'qq-290913',
          sender_role: 'member',
          text: '数字 QQ 精确 @bot',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 1,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            content?: {
              text?: string;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('数字 QQ 精确 @bot');
        expect(rawPayload.message?.mentions).toEqual(['qq-3889000770']);
        expect(rawPayload.message?.mentionsBot).toBe(true);

        const turn = getTurnForMessage('qq-23913');
        expect(turn).toMatchObject({
          conversation_id: 'qq-group-190913',
          trigger_event_id: inboundMessage?.raw_event_id,
          pi_provider: 'mock',
          pi_model: 'mock',
          response_text: 'numeric segment at reply',
          status: 'completed',
          tokens_input: 11,
          tokens_output: 7,
          tokens_total: 18,
        });

        const contextTrace = getContextTraceForMessage('qq-23913');
        expect(contextTrace).toMatchObject({
          id: turn?.context_pack_id,
          turn_id: turn?.id,
          conversation_id: 'qq-group-190913',
          conversation_type: 'group',
          group_id: 'qq-group-190913',
        });
        expect(JSON.parse(contextTrace?.recent_message_ids ?? '[]')).toContain(inboundMessage?.id);

        const actionRows = getActionRowsForMessage('qq-23913');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          turn_id: turn?.id,
          decided_by: 'pi',
          risk_level: 'low',
          evaluator_required: 0,
          action_type: 'reply_short',
          status: 'success',
          executed_message_id: sentMessages[0]?.messageId,
        });

        const outboundMessage = getPersistedMessage(sentMessages[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          conversation_id: 'qq-group-190913',
          conversation_type: 'group',
          group_id: 'qq-group-190913',
          sender_id: 'bot-self',
          text: 'numeric segment at reply',
        });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore malformed boolean segment identifiers without triggering group reply', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'malformed segment identifiers should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23914,
          user_id: 290914,
          group_id: 190914,
          message: [
            { type: 'reply', data: { id: false } },
            { type: 'at', data: { qq: true } },
            { type: 'text', data: { text: ' malformed boolean ids should be ignored' } },
          ],
          raw_message: 'structured malformed boolean segment identifiers',
          sender: {
            user_id: 290914,
            nickname: 'SegmentArrayMalformedIdUser',
            card: 'SegmentArrayMalformedIdCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23914');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23914',
          conversation_id: 'qq-group-190914',
          conversation_type: 'group',
          group_id: 'qq-group-190914',
          sender_id: 'qq-290914',
          sender_role: 'member',
          text: 'malformed boolean ids should be ignored',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        expect(rawEventRow?.payload).not.toContain('qq-true');
        expect(rawEventRow?.payload).not.toContain('qq-false');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              quote?: unknown;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('malformed boolean ids should be ignored');
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();
        expect(rawPayload.message?.content?.quote).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23914')).toBe(0);
        expect(getContextTraceForMessage('qq-23914')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23914')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore object array null and empty segment identifiers without triggering group reply', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'non-scalar segment identifiers should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23915,
          user_id: 290915,
          group_id: 190915,
          message: [
            { type: 'reply', data: { id: { nested: '23913' } } },
            { type: 'reply', data: { id: ['23913'] } },
            { type: 'reply', data: { id: null } },
            { type: 'reply', data: { id: '' } },
            { type: 'at', data: { qq: { nested: '3889000770' } } },
            { type: 'at', data: { qq: ['3889000770'] } },
            { type: 'at', data: { qq: null } },
            { type: 'at', data: { qq: '' } },
            { type: 'text', data: { text: ' malformed non-scalar ids should be ignored' } },
          ],
          raw_message: 'structured malformed non-scalar segment identifiers',
          sender: {
            user_id: 290915,
            nickname: 'SegmentArrayNonScalarIdUser',
            card: 'SegmentArrayNonScalarIdCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23915');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23915',
          conversation_id: 'qq-group-190915',
          conversation_type: 'group',
          group_id: 'qq-group-190915',
          sender_id: 'qq-290915',
          sender_role: 'member',
          text: 'malformed non-scalar ids should be ignored',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        expect(rawEventRow?.payload).not.toContain('qq-[object Object]');
        expect(rawEventRow?.payload).not.toContain('qq-3889000770');
        expect(rawEventRow?.payload).not.toContain('qq-23913');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              quote?: unknown;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('malformed non-scalar ids should be ignored');
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();
        expect(rawPayload.message?.content?.quote).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23915')).toBe(0);
        expect(getContextTraceForMessage('qq-23915')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23915')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore non-positive or fractional numeric segment identifiers without triggering group reply', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'non-positive numeric segment identifiers should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23922,
          user_id: 290922,
          group_id: 190922,
          message: [
            { type: 'reply', data: { id: -23913 } },
            { type: 'reply', data: { id: 23913.5 } },
            { type: 'at', data: { qq: -3889000770 } },
            { type: 'at', data: { qq: 3889000770.5 } },
            { type: 'text', data: { text: ' malformed numeric segment ids should be ignored' } },
          ],
          raw_message: 'structured malformed numeric segment identifiers',
          sender: {
            user_id: 290922,
            nickname: 'SegmentArrayNumericIdUser',
            card: 'SegmentArrayNumericIdCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23922');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23922',
          conversation_id: 'qq-group-190922',
          conversation_type: 'group',
          group_id: 'qq-group-190922',
          sender_id: 'qq-290922',
          sender_role: 'member',
          text: 'malformed numeric segment ids should be ignored',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        expect(rawEventRow?.payload).not.toContain('qq--');
        expect(rawEventRow?.payload).not.toContain('qq-23913');
        expect(rawEventRow?.payload).not.toContain('qq-3889000770');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              quote?: unknown;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('malformed numeric segment ids should be ignored');
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();
        expect(rawPayload.message?.content?.quote).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23922')).toBe(0);
        expect(getContextTraceForMessage('qq-23922')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23922')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore secret-like malformed segment-array string identifiers without triggering group reply', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-segment-id-secret-should-not-persist';
      const rawPlatformFragment = 'qq-1234567890';
      const malformedReplyId = `reply-${rawPlatformFragment}-${rawSecret}`;
      const malformedMentionId = `mention-${rawPlatformFragment}-${rawSecret}`;
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'secret-like segment identifiers should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23920,
          user_id: 290920,
          group_id: 190920,
          message: [
            { type: 'reply', data: { id: malformedReplyId } },
            { type: 'at', data: { qq: malformedMentionId } },
            { type: 'text', data: { text: ' malformed segment string ids should be ignored' } },
          ],
          raw_message: 'structured secret-like segment identifiers',
          sender: {
            user_id: 290920,
            nickname: 'SegmentArraySecretLikeIdUser',
            card: 'SegmentArraySecretLikeIdCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23920');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23920',
          conversation_id: 'qq-group-190920',
          conversation_type: 'group',
          group_id: 'qq-group-190920',
          sender_id: 'qq-290920',
          sender_role: 'member',
          text: 'malformed segment string ids should be ignored',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        expect(rawEventRow?.payload).not.toContain(rawSecret);
        expect(rawEventRow?.payload).not.toContain(rawPlatformFragment);
        expect(rawEventRow?.payload).not.toContain(malformedReplyId);
        expect(rawEventRow?.payload).not.toContain(malformedMentionId);
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              quote?: unknown;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('malformed segment string ids should be ignored');
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();
        expect(rawPayload.message?.content?.quote).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23920')).toBe(0);
        expect(getContextTraceForMessage('qq-23920')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23920')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should not trigger group reply when a segment-array text contains the bot QQ id without at segment', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'segment-array plain-text bot id should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23911,
          user_id: 290911,
          group_id: 190911,
          message: [
            { type: 'text', data: { text: 'bot id 3889000770 只是 segment array 普通文本' } },
          ],
          raw_message: 'structured plain-text bot-id segment array message',
          sender: {
            user_id: 290911,
            nickname: 'SegmentArrayPlainTextBotIdUser',
            card: 'SegmentArrayPlainTextBotIdCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('ok');

        const inboundMessage = getPersistedMessage('qq-23911');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23911',
          conversation_id: 'qq-group-190911',
          conversation_type: 'group',
          group_id: 'qq-group-190911',
          sender_id: 'qq-290911',
          sender_role: 'member',
          text: 'bot id 3889000770 只是 segment array 普通文本',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            content?: {
              text?: string;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('bot id 3889000770 只是 segment array 普通文本');
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23911')).toBe(0);
        expect(getContextTraceForMessage('qq-23911')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23911')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should persist action decision and execution for a group @bot reply', async () => {
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('群里收到。');
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23461,
          user_id: 20005,
          group_id: 100001,
          message: '[CQ:at,qq=3889000770] 请短回复',
          raw_message: '[CQ:at,qq=3889000770] 请短回复',
          sender: {
            user_id: 20005,
            nickname: 'GroupReplyUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        expect(sentMessages).toMatchObject([
          {
            target: {
              conversationId: 'qq-group-100001',
              conversationType: 'group',
              groupId: 'qq-group-100001',
            },
            text: '群里收到。',
          },
        ]);
        const sentMessageId = sentMessages[0]?.messageId;
        expect(sentMessageId).toBeDefined();

        const actionRows = getActionRowsForMessage('qq-23461');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]?.action_type).toBe('reply_short');
        expect(actionRows[0]?.status).toBe('success');
        expect(actionRows[0]?.executed_message_id).toBe(sentMessageId);
        expect(actionRows[0]?.evaluator_required).toBe(0);

        const botMessage = getPersistedMessage(sentMessageId ?? '');
        expect(botMessage?.conversation_type).toBe('group');
        expect(botMessage?.group_id).toBe('qq-group-100001');
        expect(botMessage?.text).toBe('群里收到。');
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should trigger group reply when replying to a stored bot message without @mention', async () => {
      const sentMessages: SentMessage[] = [];
      let replyContext: PiAdapterInput['contextPack'] | undefined;
      setReplyingPiRuntime('第一条 bot 回复。');
      setCapturingMessageSender(sentMessages);

      try {
        const seedEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 24560,
          user_id: 20006,
          group_id: 100001,
          message: '[CQ:at,qq=3889000770] 先说一句',
          raw_message: '[CQ:at,qq=3889000770] 先说一句',
          sender: {
            user_id: 20006,
            nickname: 'ReplySeedUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const seedResponse = await postEvent(seedEvent);
        expect(seedResponse.status).toBe(200);
        expect(sentMessages).toHaveLength(1);
        const botMessageId = sentMessages[0]?.messageId;
        expect(botMessageId).toBeDefined();
        expect(getPersistedMessage(botMessageId ?? '')).toMatchObject({
          raw_type: 'bot.response',
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'bot-self',
          text: '第一条 bot 回复。',
        });

        app.setPiRuntimeForTesting({
          async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
            replyContext = input.contextPack;
            return {
              turnId: input.turnId,
              responseText: '回复引用也会触发。',
              toolCallIds: [],
              events: [],
              tokensUsed: { input: 11, output: 7, total: 18 },
              status: 'completed',
            };
          },
        });

        const replyEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 24561,
          user_id: 20007,
          group_id: 100001,
          message: `[CQ:reply,id=${botMessageId}] 继续解释一下`,
          raw_message: `[CQ:reply,id=${botMessageId}] 继续解释一下`,
          sender: {
            user_id: 20007,
            nickname: 'ReplyToBotUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const replyResponse = await postEvent(replyEvent);

        expect(replyResponse.status).toBe(200);
        await expect(replyResponse.json()).resolves.toEqual({ status: 'ok' });
        expect(sentMessages).toHaveLength(2);
        expect(sentMessages[1]).toMatchObject({
          target: {
            conversationId: 'qq-group-100001',
            conversationType: 'group',
            groupId: 'qq-group-100001',
          },
          text: '回复引用也会触发。',
        });

        const inboundReply = getPersistedMessage('qq-24561');
        expect(inboundReply).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundReply?.id,
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'qq-20007',
          text: '继续解释一下',
          has_quote: 1,
          mentions_bot: 0,
          reply_to_message_id: botMessageId,
        });
        const currentContextMessage = replyContext?.recentMessages.find(
          (message) => message.messageId === inboundReply?.id,
        );
        const quotedContextMessage = replyContext?.recentMessages.find(
          (message) => message.messageId === botMessageId,
        );
        expect(currentContextMessage).toMatchObject({
          isCurrent: true,
          isFromBot: false,
        });
        expect(currentContextMessage?.messageRef).toMatch(/^message_\d+$/);
        expect(currentContextMessage?.speakerRef).toMatch(/^speaker_\d+$/);
        expect(quotedContextMessage).toMatchObject({ isFromBot: true });
        expect(replyContext?.currentMessageRef).toBe(currentContextMessage?.messageRef);
        expect(replyContext?.replyReference).toMatchObject({
          status: 'resolved',
          sourceMessageRef: currentContextMessage?.messageRef,
          targetMessageRef: quotedContextMessage?.messageRef,
          targetSpeakerRef: quotedContextMessage?.speakerRef,
          targetRole: 'bot',
          targetInRollingWindow: true,
        });
        expect(replyContext?.tokenBudget.promptLayers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'message_references',
              version: 'pi-prompt-message-reference-v1',
            }),
          ]),
        );

        const turn = getTurnForMessage('qq-24561');
        expect(turn).toMatchObject({
          conversation_id: 'qq-group-100001',
          trigger_event_id: inboundReply?.raw_event_id,
          pi_provider: 'mock',
          pi_model: 'mock',
          response_text: '回复引用也会触发。',
          status: 'completed',
        });

        const contextTrace = getContextTraceForMessage('qq-24561');
        expect(contextTrace).toMatchObject({
          turn_id: turn?.id,
          conversation_id: 'qq-group-100001',
          conversation_type: 'group',
        });

        const actionRows = getActionRowsForMessage('qq-24561');
        expect(actionRows).toHaveLength(1);
        expect(JSON.parse(actionRows[0]?.reasons ?? '[]')).toEqual(
          expect.arrayContaining(['reply_to_bot', 'pi_response_text'])
        );
        expect(actionRows[0]).toMatchObject({
          action_type: 'reply_short',
          status: 'success',
          executed_message_id: sentMessages[1]?.messageId,
          evaluator_required: 0,
        });

        const outboundMessage = getPersistedMessage(sentMessages[1]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'bot-self',
          text: '回复引用也会触发。',
        });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should trigger group reply when a segment-array replies to a stored bot message without @mention', async () => {
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('第一条 segment array bot 回复。');
      setCapturingMessageSender(sentMessages);

      try {
        const seedEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23905,
          user_id: 290905,
          group_id: 190905,
          message: '[CQ:at,qq=3889000770] 先生成一条 bot 回复',
          raw_message: '[CQ:at,qq=3889000770] 先生成一条 bot 回复',
          sender: {
            user_id: 290905,
            nickname: 'SegmentReplySeedUser',
            card: 'SegmentReplySeedCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const seedResponse = await postEvent(seedEvent);
        expect(seedResponse.status).toBe(200);
        expect(sentMessages).toHaveLength(1);
        const botMessageId = sentMessages[0]?.messageId;
        expect(botMessageId).toBeDefined();
        expect(getPersistedMessage(botMessageId ?? '')).toMatchObject({
          raw_type: 'bot.response',
          conversation_id: 'qq-group-190905',
          conversation_type: 'group',
          group_id: 'qq-group-190905',
          sender_id: 'bot-self',
          text: '第一条 segment array bot 回复。',
        });

        setReplyingPiRuntime('segment array 引用 bot 也会触发。');

        const replyEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23906,
          user_id: 290906,
          group_id: 190905,
          message: [
            { type: 'reply', data: { id: botMessageId } },
            { type: 'text', data: { text: ' 继续解释 segment array 引用' } },
          ],
          raw_message: 'structured segment array reply-to-bot message',
          sender: {
            user_id: 290906,
            nickname: 'SegmentReplyToBotUser',
            card: 'SegmentReplyToBotCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const replyResponse = await postEvent(replyEvent);

        expect(replyResponse.status).toBe(200);
        await expect(replyResponse.json()).resolves.toEqual({ status: 'ok' });
        expect(sentMessages).toHaveLength(2);
        expect(sentMessages[1]).toMatchObject({
          target: {
            conversationId: 'qq-group-190905',
            conversationType: 'group',
            groupId: 'qq-group-190905',
          },
          text: 'segment array 引用 bot 也会触发。',
        });

        const inboundReply = getPersistedMessage('qq-23906');
        expect(inboundReply).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundReply?.id,
          message_id: 'qq-23906',
          conversation_id: 'qq-group-190905',
          conversation_type: 'group',
          group_id: 'qq-group-190905',
          sender_id: 'qq-290906',
          sender_role: 'member',
          text: '继续解释 segment array 引用',
          has_quote: 1,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: botMessageId,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundReply?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              quote?: { messageId: string; senderId: string };
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('继续解释 segment array 引用');
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBe(botMessageId);
        expect(rawPayload.message?.content?.quote).toEqual({
          messageId: botMessageId,
          senderId: 'unknown',
        });

        const turn = getTurnForMessage('qq-23906');
        expect(turn).toMatchObject({
          conversation_id: 'qq-group-190905',
          trigger_event_id: inboundReply?.raw_event_id,
          pi_provider: 'mock',
          pi_model: 'mock',
          response_text: 'segment array 引用 bot 也会触发。',
          status: 'completed',
          tokens_input: 11,
          tokens_output: 7,
          tokens_total: 18,
        });

        const contextTrace = getContextTraceForMessage('qq-23906');
        expect(contextTrace).toMatchObject({
          id: turn?.context_pack_id,
          turn_id: turn?.id,
          conversation_id: 'qq-group-190905',
          conversation_type: 'group',
          group_id: 'qq-group-190905',
        });
        expect(JSON.parse(contextTrace?.recent_message_ids ?? '[]')).toContain(inboundReply?.id);

        const actionRows = getActionRowsForMessage('qq-23906');
        expect(actionRows).toHaveLength(1);
        expect(JSON.parse(actionRows[0]?.reasons ?? '[]')).toEqual(
          expect.arrayContaining(['reply_to_bot', 'pi_response_text'])
        );
        expect(actionRows[0]).toMatchObject({
          turn_id: turn?.id,
          decided_by: 'pi',
          risk_level: 'low',
          evaluator_required: 0,
          action_type: 'reply_short',
          status: 'success',
          executed_message_id: sentMessages[1]?.messageId,
        });
        expect(JSON.parse(actionRows[0]?.actions ?? '[]')).toMatchObject([
          {
            type: 'reply_short',
            target: {
              conversationId: 'qq-group-190905',
              conversationType: 'group',
              groupId: 'qq-group-190905',
            },
            payload: { text: 'segment array 引用 bot 也会触发。' },
          },
        ]);

        const outboundMessage = getPersistedMessage(sentMessages[1]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          conversation_id: 'qq-group-190905',
          conversation_type: 'group',
          group_id: 'qq-group-190905',
          sender_id: 'bot-self',
          text: 'segment array 引用 bot 也会触发。',
        });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should not trigger group reply when replying to a stored non-bot message without @mention', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: '引用普通成员消息不应该触发回复。',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const seedEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23562,
          user_id: 20008,
          group_id: 100001,
          message: '这是一条普通成员消息',
          raw_message: '这是一条普通成员消息',
          sender: {
            user_id: 20008,
            nickname: 'HumanQuoteSeedUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const seedResponse = await postEvent(seedEvent);
        expect(seedResponse.status).toBe(200);
        expect(sentMessages).toEqual([]);
        const seedMessage = getPersistedMessage('qq-23562');
        expect(seedMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: seedMessage?.id,
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'qq-20008',
          text: '这是一条普通成员消息',
          mentions_bot: 0,
        });

        const replyEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23563,
          user_id: 20009,
          group_id: 100001,
          message: '[CQ:reply,id=23562] 我补充一句普通引用',
          raw_message: '[CQ:reply,id=23562] 我补充一句普通引用',
          sender: {
            user_id: 20009,
            nickname: 'HumanQuoteReplyUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const replyResponse = await postEvent(replyEvent);

        expect(replyResponse.status).toBe(200);
        await expect(replyResponse.json()).resolves.toEqual({ status: 'ok' });

        const quotedReply = getPersistedMessage('qq-23563');
        expect(quotedReply).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: quotedReply?.id,
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'qq-20009',
          text: '我补充一句普通引用',
          has_quote: 1,
          mentions_bot: 0,
          reply_to_message_id: 'qq-23562',
        });

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23563')).toBe(0);
        expect(getContextTraceForMessage('qq-23563')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23563')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should not trigger group reply when a segment-array replies to a stored non-bot message', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'segment array 引用普通成员消息不应该触发回复。',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const seedEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23907,
          user_id: 290907,
          group_id: 190907,
          message: '这是一条 segment array 引用用的普通成员消息',
          raw_message: '这是一条 segment array 引用用的普通成员消息',
          sender: {
            user_id: 290907,
            nickname: 'SegmentHumanQuoteSeedUser',
            card: 'SegmentHumanQuoteSeedCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const seedResponse = await postEvent(seedEvent);
        expect(seedResponse.status).toBe(200);
        expect(sentMessages).toEqual([]);
        const seedMessage = getPersistedMessage('qq-23907');
        expect(seedMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: seedMessage?.id,
          conversation_id: 'qq-group-190907',
          conversation_type: 'group',
          group_id: 'qq-group-190907',
          sender_id: 'qq-290907',
          sender_role: 'member',
          text: '这是一条 segment array 引用用的普通成员消息',
          mentions_bot: 0,
        });

        const replyEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23908,
          user_id: 290908,
          group_id: 190907,
          message: [
            { type: 'reply', data: { id: 23907 } },
            { type: 'text', data: { text: ' 我补充一句 segment array 普通引用' } },
          ],
          raw_message: 'structured segment array reply-to-human message',
          sender: {
            user_id: 290908,
            nickname: 'SegmentHumanQuoteReplyUser',
            card: 'SegmentHumanQuoteReplyCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const replyResponse = await postEvent(replyEvent);

        expect(replyResponse.status).toBe(200);
        await expect(replyResponse.json()).resolves.toEqual({ status: 'ok' });

        const quotedReply = getPersistedMessage('qq-23908');
        expect(quotedReply).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: quotedReply?.id,
          message_id: 'qq-23908',
          conversation_id: 'qq-group-190907',
          conversation_type: 'group',
          group_id: 'qq-group-190907',
          sender_id: 'qq-290908',
          sender_role: 'member',
          text: '我补充一句 segment array 普通引用',
          has_quote: 1,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: 'qq-23907',
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(quotedReply?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              quote?: { messageId: string; senderId: string };
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('我补充一句 segment array 普通引用');
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBe('qq-23907');
        expect(rawPayload.message?.content?.quote).toEqual({
          messageId: 'qq-23907',
          senderId: 'unknown',
        });

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23908')).toBe(0);
        expect(getContextTraceForMessage('qq-23908')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23908')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-SCOPE-01 keeps a cross-group bot quote out of the turn and action path', async () => {
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('另一个群里的 bot 回复。');
      setCapturingMessageSender(sentMessages);

      try {
        const seedEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23564,
          user_id: 20010,
          group_id: 100002,
          message: '[CQ:at,qq=3889000770] 先在另一个群回复',
          raw_message: '[CQ:at,qq=3889000770] 先在另一个群回复',
          sender: {
            user_id: 20010,
            nickname: 'CrossGroupSeedUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const seedResponse = await postEvent(seedEvent);
        expect(seedResponse.status).toBe(200);
        expect(sentMessages).toHaveLength(1);
        const otherGroupBotMessageId = sentMessages[0]?.messageId;
        expect(otherGroupBotMessageId).toBeDefined();
        expect(getPersistedMessage(otherGroupBotMessageId ?? '')).toMatchObject({
          raw_type: 'bot.response',
          conversation_id: 'qq-group-100002',
          conversation_type: 'group',
          group_id: 'qq-group-100002',
          sender_id: 'bot-self',
          text: '另一个群里的 bot 回复。',
        });

        app.clearCooldownsForTesting();
        let crossGroupPiCalls = 0;
        app.setPiRuntimeForTesting({
          async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
            crossGroupPiCalls += 1;
            return {
              turnId: input.turnId,
              responseText: '跨群引用 bot 消息不应该触发。',
              toolCallIds: [],
              events: [],
              tokensUsed: { input: 1, output: 1, total: 2 },
              status: 'completed',
            };
          },
        });

        const crossGroupReplyEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23565,
          user_id: 20011,
          group_id: 100001,
          message: `[CQ:reply,id=${otherGroupBotMessageId}] 这是跨群引用`,
          raw_message: `[CQ:reply,id=${otherGroupBotMessageId}] 这是跨群引用`,
          sender: {
            user_id: 20011,
            nickname: 'CrossGroupReplyUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const crossGroupResponse = await postEvent(crossGroupReplyEvent);

        expect(crossGroupResponse.status).toBe(200);
        await expect(crossGroupResponse.json()).resolves.toEqual({ status: 'ok' });

        const quotedReply = getPersistedMessage('qq-23565');
        expect(quotedReply).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: quotedReply?.id,
          conversation_id: 'qq-group-100001',
          conversation_type: 'group',
          group_id: 'qq-group-100001',
          sender_id: 'qq-20011',
          text: '这是跨群引用',
          has_quote: 1,
          mentions_bot: 0,
          reply_to_message_id: otherGroupBotMessageId,
        });

        expect(crossGroupPiCalls).toBe(0);
        expect(countTurnsForMessage('qq-23565')).toBe(0);
        expect(getContextTraceForMessage('qq-23565')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23565')).toEqual([]);
        expect(sentMessages).toHaveLength(1);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should not trigger group reply when a segment-array quotes a stored bot message from another group', async () => {
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('segment array 另一个群里的 bot 回复。');
      setCapturingMessageSender(sentMessages);

      try {
        const seedEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23909,
          user_id: 290909,
          group_id: 190909,
          message: '[CQ:at,qq=3889000770] 先在另一个群生成 bot 回复',
          raw_message: '[CQ:at,qq=3889000770] 先在另一个群生成 bot 回复',
          sender: {
            user_id: 290909,
            nickname: 'SegmentCrossGroupSeedUser',
            card: 'SegmentCrossGroupSeedCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const seedResponse = await postEvent(seedEvent);
        expect(seedResponse.status).toBe(200);
        expect(sentMessages).toHaveLength(1);
        const otherGroupBotMessageId = sentMessages[0]?.messageId;
        expect(otherGroupBotMessageId).toBeDefined();
        expect(getPersistedMessage(otherGroupBotMessageId ?? '')).toMatchObject({
          raw_type: 'bot.response',
          conversation_id: 'qq-group-190909',
          conversation_type: 'group',
          group_id: 'qq-group-190909',
          sender_id: 'bot-self',
          text: 'segment array 另一个群里的 bot 回复。',
        });

        app.clearCooldownsForTesting();
        let crossGroupPiCalls = 0;
        app.setPiRuntimeForTesting({
          async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
            crossGroupPiCalls += 1;
            return {
              turnId: input.turnId,
              responseText: 'segment array 跨群引用 bot 消息不应该触发。',
              toolCallIds: [],
              events: [],
              tokensUsed: { input: 1, output: 1, total: 2 },
              status: 'completed',
            };
          },
        });

        const crossGroupReplyEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23910,
          user_id: 290910,
          group_id: 190910,
          message: [
            { type: 'reply', data: { id: otherGroupBotMessageId } },
            { type: 'text', data: { text: ' 这是 segment array 跨群引用' } },
          ],
          raw_message: 'structured segment array cross-group reply-to-bot message',
          sender: {
            user_id: 290910,
            nickname: 'SegmentCrossGroupReplyUser',
            card: 'SegmentCrossGroupReplyCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const crossGroupResponse = await postEvent(crossGroupReplyEvent);

        expect(crossGroupResponse.status).toBe(200);
        await expect(crossGroupResponse.json()).resolves.toEqual({ status: 'ok' });

        const quotedReply = getPersistedMessage('qq-23910');
        expect(quotedReply).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: quotedReply?.id,
          message_id: 'qq-23910',
          conversation_id: 'qq-group-190910',
          conversation_type: 'group',
          group_id: 'qq-group-190910',
          sender_id: 'qq-290910',
          sender_role: 'member',
          text: '这是 segment array 跨群引用',
          has_quote: 1,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: otherGroupBotMessageId,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(quotedReply?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              quote?: { messageId: string; senderId: string };
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('这是 segment array 跨群引用');
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBe(otherGroupBotMessageId);
        expect(rawPayload.message?.content?.quote).toEqual({
          messageId: otherGroupBotMessageId,
          senderId: 'unknown',
        });

        expect(crossGroupPiCalls).toBe(0);
        expect(countTurnsForMessage('qq-23910')).toBe(0);
        expect(getContextTraceForMessage('qq-23910')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23910')).toEqual([]);
        expect(sentMessages).toHaveLength(1);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should provide controlled OneBot acceptance evidence for a full group @bot reply lifecycle', async () => {
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('controlled group acceptance reply');
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23901,
          user_id: 290901,
          group_id: 190901,
          message: '[CQ:at,qq=3889000770] 请短回复',
          raw_message: '[CQ:at,qq=3889000770] 请短回复',
          sender: {
            user_id: 290901,
            nickname: 'GroupControlledNickname',
            card: 'GroupControlledCard',
            role: 'owner',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
          target: {
            conversationId: 'qq-group-190901',
            conversationType: 'group',
            groupId: 'qq-group-190901',
          },
          text: 'controlled group acceptance reply',
        });

        const inboundMessage = getPersistedMessage('qq-23901');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23901',
          conversation_id: 'qq-group-190901',
          conversation_type: 'group',
          group_id: 'qq-group-190901',
          sender_id: 'qq-290901',
          sender_role: 'owner',
          text: '请短回复',
          mentions_bot: 1,
        });

        const displayProfile = app
          .getDatabase()
          .prepare(
            `SELECT dp.current_display_name, dp.source_group_id, dp.trust
             FROM display_profiles dp
             JOIN platform_accounts pa ON pa.canonical_user_id = dp.canonical_user_id
             WHERE pa.platform = 'qq' AND pa.platform_account_id = ?`
          )
          .get('290901') as
          | { current_display_name: string; source_group_id: string; trust: string }
          | undefined;
        expect(displayProfile).toEqual({
          current_display_name: 'GroupControlledCard',
          source_group_id: 'qq-group-190901',
          trust: 'platform_provided',
        });

        const turn = getTurnForMessage('qq-23901');
        expect(turn).toMatchObject({
          conversation_id: 'qq-group-190901',
          trigger_event_id: inboundMessage?.raw_event_id,
          pi_provider: 'mock',
          pi_model: 'mock',
          response_text: 'controlled group acceptance reply',
          status: 'completed',
          tokens_input: 11,
          tokens_output: 7,
          tokens_total: 18,
        });
        expect(turn?.completed_at).toBeGreaterThan(0);

        const contextTrace = getContextTraceForMessage('qq-23901');
        expect(contextTrace).toMatchObject({
          id: turn?.context_pack_id,
          turn_id: turn?.id,
          conversation_id: 'qq-group-190901',
          conversation_type: 'group',
          group_id: 'qq-group-190901',
        });
        expect(JSON.parse(contextTrace?.recent_message_ids ?? '[]')).toContain(inboundMessage?.id);
        expect(JSON.parse(contextTrace?.filters_applied ?? '[]')).toEqual(
          expect.arrayContaining([
            'state=active',
            'sensitivity!=secret/prohibited',
            'contextType=group',
            'visibility_scope_filter',
          ])
        );
        expect(JSON.parse(contextTrace?.injected_identity_fields ?? '[]')).toEqual(
          expect.arrayContaining(['conversation_id', 'conversation_type', 'group_id', 'target_user_ref'])
        );

        const actionRows = getActionRowsForMessage('qq-23901');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          turn_id: turn?.id,
          decided_by: 'pi',
          risk_level: 'low',
          evaluator_required: 0,
          action_type: 'reply_short',
          status: 'success',
          executed_message_id: sentMessages[0]?.messageId,
        });
        expect(turn?.action_decision_id).toBe(actionRows[0]?.decision_id);
        expect(JSON.parse(actionRows[0]?.actions ?? '[]')).toMatchObject([
          {
            type: 'reply_short',
            target: {
              conversationId: 'qq-group-190901',
              conversationType: 'group',
              groupId: 'qq-group-190901',
            },
            payload: { text: 'controlled group acceptance reply' },
          },
        ]);

        const outboundMessage = getPersistedMessage(sentMessages[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          raw_event_id: expect.any(String),
          conversation_id: 'qq-group-190901',
          conversation_type: 'group',
          group_id: 'qq-group-190901',
          sender_id: 'bot-self',
          text: 'controlled group acceptance reply',
        });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should provide controlled OneBot acceptance evidence for group quote and media metadata', async () => {
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('controlled metadata acceptance reply');
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23902,
          user_id: 290902,
          group_id: 190902,
          message:
            '[CQ:reply,id=23901][CQ:at,qq=3889000770][CQ:image,url=https://example.test/group-image.png][CQ:record,url=https://example.test/audio.amr] 请看附件',
          raw_message:
            '[CQ:reply,id=23901][CQ:at,qq=3889000770][CQ:image,url=https://example.test/group-image.png][CQ:record,url=https://example.test/audio.amr] 请看附件',
          sender: {
            user_id: 290902,
            nickname: 'MetadataNickname',
            card: 'MetadataCard',
            role: 'admin',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
          target: {
            conversationId: 'qq-group-190902',
            conversationType: 'group',
            groupId: 'qq-group-190902',
          },
          text: 'controlled metadata acceptance reply',
        });

        const inboundMessage = getPersistedMessage('qq-23902');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23902',
          conversation_id: 'qq-group-190902',
          conversation_type: 'group',
          group_id: 'qq-group-190902',
          sender_id: 'qq-290902',
          sender_role: 'admin',
          text: '请看附件',
          has_quote: 1,
          has_media: 1,
          mentions_bot: 1,
          reply_to_message_id: 'qq-23901',
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
              quote?: { messageId: string; senderId: string };
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('请看附件');
        expect(rawPayload.message?.mentions).toEqual(['qq-3889000770']);
        expect(rawPayload.message?.mentionsBot).toBe(true);
        expect(rawPayload.message?.replyToMessageId).toBe('qq-23901');
        expect(rawPayload.message?.content?.quote).toEqual({
          messageId: 'qq-23901',
          senderId: 'unknown',
        });
        expect(rawPayload.message?.content?.media).toEqual([
          { type: 'image', url: 'https://example.test/group-image.png' },
          { type: 'audio', url: 'https://example.test/audio.amr' },
        ]);

        const turn = getTurnForMessage('qq-23902');
        expect(turn).toMatchObject({
          conversation_id: 'qq-group-190902',
          trigger_event_id: inboundMessage?.raw_event_id,
          pi_provider: 'mock',
          pi_model: 'mock',
          response_text: 'controlled metadata acceptance reply',
          status: 'completed',
          tokens_input: 11,
          tokens_output: 7,
          tokens_total: 18,
        });

        const contextTrace = getContextTraceForMessage('qq-23902');
        expect(contextTrace).toMatchObject({
          id: turn?.context_pack_id,
          turn_id: turn?.id,
          conversation_id: 'qq-group-190902',
          conversation_type: 'group',
          group_id: 'qq-group-190902',
        });
        expect(JSON.parse(contextTrace?.recent_message_ids ?? '[]')).toContain(inboundMessage?.id);

        const actionRows = getActionRowsForMessage('qq-23902');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          turn_id: turn?.id,
          decided_by: 'pi',
          risk_level: 'low',
          evaluator_required: 0,
          action_type: 'reply_short',
          status: 'success',
          executed_message_id: sentMessages[0]?.messageId,
        });
        expect(JSON.parse(actionRows[0]?.actions ?? '[]')).toMatchObject([
          {
            type: 'reply_short',
            target: {
              conversationId: 'qq-group-190902',
              conversationType: 'group',
              groupId: 'qq-group-190902',
            },
            payload: { text: 'controlled metadata acceptance reply' },
          },
        ]);

        const outboundMessage = getPersistedMessage(sentMessages[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          conversation_id: 'qq-group-190902',
          conversation_type: 'group',
          group_id: 'qq-group-190902',
          sender_id: 'bot-self',
          text: 'controlled metadata acceptance reply',
        });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should process OneBot segment-array group metadata like CQ strings', async () => {
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('controlled segment array acceptance reply');
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23903,
          user_id: 290903,
          group_id: 190903,
          message: [
            { type: 'reply', data: { id: 23901 } },
            { type: 'at', data: { qq: '3889000770' } },
            { type: 'image', data: { url: 'https://example.test/segment-array-image.png' } },
            { type: 'record', data: { url: 'https://example.test/segment-array-audio.amr' } },
            { type: 'text', data: { text: ' 请解析 segment array' } },
          ],
          raw_message: 'structured segment array message',
          sender: {
            user_id: 290903,
            nickname: 'SegmentArrayNickname',
            card: 'SegmentArrayCard',
            role: 'admin',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toMatchObject({
          target: {
            conversationId: 'qq-group-190903',
            conversationType: 'group',
            groupId: 'qq-group-190903',
          },
          text: 'controlled segment array acceptance reply',
        });

        const inboundMessage = getPersistedMessage('qq-23903');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23903',
          conversation_id: 'qq-group-190903',
          conversation_type: 'group',
          group_id: 'qq-group-190903',
          sender_id: 'qq-290903',
          sender_role: 'admin',
          text: '请解析 segment array',
          has_quote: 1,
          has_media: 1,
          mentions_bot: 1,
          reply_to_message_id: 'qq-23901',
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
              quote?: { messageId: string; senderId: string };
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('请解析 segment array');
        expect(rawPayload.message?.mentions).toEqual(['qq-3889000770']);
        expect(rawPayload.message?.mentionsBot).toBe(true);
        expect(rawPayload.message?.replyToMessageId).toBe('qq-23901');
        expect(rawPayload.message?.content?.quote).toEqual({
          messageId: 'qq-23901',
          senderId: 'unknown',
        });
        expect(rawPayload.message?.content?.media).toEqual([
          { type: 'image', url: 'https://example.test/segment-array-image.png' },
          { type: 'audio', url: 'https://example.test/segment-array-audio.amr' },
        ]);

        const turn = getTurnForMessage('qq-23903');
        expect(turn).toMatchObject({
          conversation_id: 'qq-group-190903',
          trigger_event_id: inboundMessage?.raw_event_id,
          pi_provider: 'mock',
          pi_model: 'mock',
          response_text: 'controlled segment array acceptance reply',
          status: 'completed',
          tokens_input: 11,
          tokens_output: 7,
          tokens_total: 18,
        });

        const contextTrace = getContextTraceForMessage('qq-23903');
        expect(contextTrace).toMatchObject({
          id: turn?.context_pack_id,
          turn_id: turn?.id,
          conversation_id: 'qq-group-190903',
          conversation_type: 'group',
          group_id: 'qq-group-190903',
        });
        expect(JSON.parse(contextTrace?.recent_message_ids ?? '[]')).toContain(inboundMessage?.id);

        const actionRows = getActionRowsForMessage('qq-23903');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]).toMatchObject({
          turn_id: turn?.id,
          decided_by: 'pi',
          risk_level: 'low',
          evaluator_required: 0,
          action_type: 'reply_short',
          status: 'success',
          executed_message_id: sentMessages[0]?.messageId,
        });
        expect(JSON.parse(actionRows[0]?.actions ?? '[]')).toMatchObject([
          {
            type: 'reply_short',
            target: {
              conversationId: 'qq-group-190903',
              conversationType: 'group',
              groupId: 'qq-group-190903',
            },
            payload: { text: 'controlled segment array acceptance reply' },
          },
        ]);

        const outboundMessage = getPersistedMessage(sentMessages[0]?.messageId ?? '');
        expect(outboundMessage).toMatchObject({
          raw_type: 'bot.response',
          conversation_id: 'qq-group-190903',
          conversation_type: 'group',
          group_id: 'qq-group-190903',
          sender_id: 'bot-self',
          text: 'controlled segment array acceptance reply',
        });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore malformed segment-array media urls while preserving media presence', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'malformed media urls should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23916,
          user_id: 290916,
          group_id: 190916,
          message: [
            { type: 'image', data: { url: 12345 } },
            { type: 'record', data: { url: true } },
            { type: 'video', data: { url: { nested: 'https://example.test/video.mp4' } } },
            { type: 'file', data: { url: ['https://example.test/file.bin'] } },
            { type: 'image', data: { url: null } },
            { type: 'record', data: { url: '' } },
            { type: 'text', data: { text: ' malformed media urls should be ignored' } },
          ],
          raw_message: 'structured malformed media url segment array message',
          sender: {
            user_id: 290916,
            nickname: 'SegmentArrayMalformedMediaUser',
            card: 'SegmentArrayMalformedMediaCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23916');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23916',
          conversation_id: 'qq-group-190916',
          conversation_type: 'group',
          group_id: 'qq-group-190916',
          sender_id: 'qq-290916',
          sender_role: 'member',
          text: 'malformed media urls should be ignored',
          has_quote: 0,
          has_media: 1,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        expect(rawEventRow?.payload).not.toContain('12345');
        expect(rawEventRow?.payload).not.toContain('[object Object]');
        expect(rawEventRow?.payload).not.toContain('https://example.test/video.mp4');
        expect(rawEventRow?.payload).not.toContain('https://example.test/file.bin');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('malformed media urls should be ignored');
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.content?.media).toEqual([
          { type: 'image' },
          { type: 'audio' },
          { type: 'video' },
          { type: 'file' },
          { type: 'image' },
          { type: 'audio' },
        ]);

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23916')).toBe(0);
        expect(getContextTraceForMessage('qq-23916')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23916')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should drop secret-like segment-array media URLs while preserving media presence', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-segment-media-url-secret-should-not-persist';
      const rawPlatformFragment = 'qq-1234567890';
      const sensitiveImageUrl =
        `https://example.test/segment-image.png?api_key=${rawSecret}&owner=${rawPlatformFragment}`;
      const sensitiveRecordUrl =
        `https://example.test/segment-audio.amr?download_token=${rawSecret}&legacy=${rawPlatformFragment}`;
      const sensitiveVideoUrl =
        `https://example.test/segment-video.mp4?access_token=${rawSecret}&group=${rawPlatformFragment}`;
      const sensitiveFileUrl =
        `https://example.test/segment-file.bin?cookie=${rawSecret}&sender=${rawPlatformFragment}`;
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'secret-like segment media URLs should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23921,
          user_id: 290921,
          group_id: 190921,
          message: [
            { type: 'image', data: { url: sensitiveImageUrl } },
            { type: 'record', data: { url: sensitiveRecordUrl } },
            { type: 'video', data: { url: sensitiveVideoUrl } },
            { type: 'file', data: { url: sensitiveFileUrl } },
            { type: 'text', data: { text: ' sensitive segment media URLs should be dropped' } },
          ],
          raw_message: 'structured secret-like segment media URL message',
          sender: {
            user_id: 290921,
            nickname: 'SegmentArraySecretLikeMediaUrlUser',
            card: 'SegmentArraySecretLikeMediaUrlCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23921');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23921',
          conversation_id: 'qq-group-190921',
          conversation_type: 'group',
          group_id: 'qq-group-190921',
          sender_id: 'qq-290921',
          sender_role: 'member',
          text: 'sensitive segment media URLs should be dropped',
          has_quote: 0,
          has_media: 1,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        expect(rawEventRow?.payload).not.toContain(rawSecret);
        expect(rawEventRow?.payload).not.toContain(rawPlatformFragment);
        expect(rawEventRow?.payload).not.toContain(sensitiveImageUrl);
        expect(rawEventRow?.payload).not.toContain(sensitiveRecordUrl);
        expect(rawEventRow?.payload).not.toContain(sensitiveVideoUrl);
        expect(rawEventRow?.payload).not.toContain(sensitiveFileUrl);
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('sensitive segment media URLs should be dropped');
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.content?.media).toEqual([
          { type: 'image' },
          { type: 'audio' },
          { type: 'video' },
          { type: 'file' },
        ]);

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23921')).toBe(0);
        expect(getContextTraceForMessage('qq-23921')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23921')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore unknown segment-array types without metadata side effects', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'unknown segment types should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23917,
          user_id: 290917,
          group_id: 190917,
          message: [
            { type: 'poke', data: { qq: 3889000770 } },
            { type: 'reply_like', data: { id: 23903 } },
            { type: 'mface', data: { url: 'https://example.test/ignored-segment-url.png' } },
            { type: 'json', data: { marker: 'ignored-payload-marker' } },
            { type: 'text', data: { text: ' unknown segment types should be ignored' } },
          ],
          raw_message: 'structured unknown segment type array message',
          sender: {
            user_id: 290917,
            nickname: 'SegmentArrayUnknownTypeUser',
            card: 'SegmentArrayUnknownTypeCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23917');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23917',
          conversation_id: 'qq-group-190917',
          conversation_type: 'group',
          group_id: 'qq-group-190917',
          sender_id: 'qq-290917',
          sender_role: 'member',
          text: 'unknown segment types should be ignored',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        expect(rawEventRow?.payload).not.toContain('qq-3889000770');
        expect(rawEventRow?.payload).not.toContain('qq-23903');
        expect(rawEventRow?.payload).not.toContain('ignored-segment-url.png');
        expect(rawEventRow?.payload).not.toContain('ignored-payload-marker');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('unknown segment types should be ignored');
        expect(rawPayload.message?.content?.media).toEqual([]);
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23917')).toBe(0);
        expect(getContextTraceForMessage('qq-23917')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23917')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore malformed segment-array text values without stringifying them', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'malformed text values should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23918,
          user_id: 290918,
          group_id: 190918,
          message: [
            { type: 'text', data: { text: 3889000770 } },
            { type: 'text', data: { text: true } },
            { type: 'text', data: { text: { nested: 'object-text-marker' } } },
            { type: 'text', data: { text: ['array-text-marker'] } },
            { type: 'text', data: { text: null } },
            { type: 'text', data: { text: ' valid string text survives' } },
          ],
          raw_message: 'structured malformed text segment array message',
          sender: {
            user_id: 290918,
            nickname: 'SegmentArrayMalformedTextUser',
            card: 'SegmentArrayMalformedTextCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23918');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23918',
          conversation_id: 'qq-group-190918',
          conversation_type: 'group',
          group_id: 'qq-group-190918',
          sender_id: 'qq-290918',
          sender_role: 'member',
          text: 'valid string text survives',
          has_quote: 0,
          has_media: 0,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        expect(rawEventRow?.payload).not.toContain('3889000770');
        expect(rawEventRow?.payload).not.toContain('object-text-marker');
        expect(rawEventRow?.payload).not.toContain('array-text-marker');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('valid string text survives');
        expect(rawPayload.message?.content?.media).toEqual([]);
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23918')).toBe(0);
        expect(getContextTraceForMessage('qq-23918')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23918')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should ignore malformed segment-array entries and data containers without failing', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'malformed segment containers should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23919,
          user_id: 290919,
          group_id: 190919,
          message: [
            null,
            true,
            42,
            'raw-string-segment',
            { type: 123, data: { text: 'non-string-type-marker' } },
            { type: 'text', data: 'malformed-text-data-marker' },
            { type: 'at', data: ['3889000770'] },
            { type: 'reply', data: '23903' },
            { type: 'image', data: 'https://example.test/malformed-image.png' },
            { type: 'text', data: { text: ' valid text after malformed containers' } },
          ] as unknown as OneBotMessage['message'],
          raw_message: 'structured malformed segment container array message',
          sender: {
            user_id: 290919,
            nickname: 'SegmentArrayMalformedContainerUser',
            card: 'SegmentArrayMalformedContainerCard',
            role: 'member',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });

        const inboundMessage = getPersistedMessage('qq-23919');
        expect(inboundMessage).toMatchObject({
          raw_type: 'chat.message.received',
          raw_event_id: inboundMessage?.id,
          message_id: 'qq-23919',
          conversation_id: 'qq-group-190919',
          conversation_type: 'group',
          group_id: 'qq-group-190919',
          sender_id: 'qq-290919',
          sender_role: 'member',
          text: 'valid text after malformed containers',
          has_quote: 0,
          has_media: 1,
          mentions_bot: 0,
          reply_to_message_id: null,
        });

        const rawEventRow = app
          .getDatabase()
          .prepare('SELECT payload FROM raw_events WHERE id = ?')
          .get(inboundMessage?.raw_event_id) as { payload: string } | undefined;
        expect(rawEventRow).toBeDefined();
        expect(rawEventRow?.payload).not.toContain('[CQ:');
        expect(rawEventRow?.payload).not.toContain('raw-string-segment');
        expect(rawEventRow?.payload).not.toContain('non-string-type-marker');
        expect(rawEventRow?.payload).not.toContain('malformed-text-data-marker');
        expect(rawEventRow?.payload).not.toContain('qq-3889000770');
        expect(rawEventRow?.payload).not.toContain('qq-23903');
        expect(rawEventRow?.payload).not.toContain('https://example.test/malformed-image.png');
        const rawPayload = JSON.parse(rawEventRow?.payload ?? '{}') as {
          message?: {
            mentions?: string[];
            mentionsBot?: boolean;
            replyToMessageId?: string;
            content?: {
              text?: string;
              media?: Array<{ type: string; url?: string }>;
            };
          };
        };
        expect(rawPayload.message?.content?.text).toBe('valid text after malformed containers');
        expect(rawPayload.message?.content?.media).toEqual([{ type: 'image' }]);
        expect(rawPayload.message?.mentions).toEqual([]);
        expect(rawPayload.message?.mentionsBot).toBe(false);
        expect(rawPayload.message?.replyToMessageId).toBeUndefined();

        expect(piCalls).toBe(0);
        expect(countTurnsForMessage('qq-23919')).toBe(0);
        expect(getContextTraceForMessage('qq-23919')).toBeUndefined();
        expect(getActionRowsForMessage('qq-23919')).toEqual([]);
        expect(sentMessages).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('REL-ATT-01 keeps a group mention question off the social evaluator path', async () => {
      const evaluatorRequests: SocialEvaluationRequest[] = [];
      const sentMessages: SentMessage[] = [];

      class CapturingEvaluator extends EvaluatorStub {
        async evaluateSocial(request: SocialEvaluationRequest): Promise<SocialEvaluationResult> {
          evaluatorRequests.push(request);
          return super.evaluateSocial(request);
        }
      }

      app.setSocialEvaluatorForTesting(new CapturingEvaluator());
      setReplyingPiRuntime('这是经过评估后的群回复。');
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23462,
          user_id: 20006,
          group_id: 100003,
          message: '[CQ:at,qq=3889000770] 你能解释一下吗？',
          raw_message: '[CQ:at,qq=3889000770] 你能解释一下吗？',
          sender: {
            user_id: 20006,
            nickname: 'GroupRiskUser',
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        expect(sentMessages).toHaveLength(1);

        const actionRows = getActionRowsForMessage('qq-23462');
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]?.decided_by).toBe('pi');
        expect(actionRows[0]?.evaluator_required).toBe(0);
        expect(actionRows[0]?.evaluator_passed).toBeNull();
        expect(actionRows[0]?.action_type).toBe('reply_short');
        expect(actionRows[0]?.status).toBe('success');
        expect(JSON.parse(actionRows[0]?.reasons ?? '[]')).toEqual(
          expect.arrayContaining(['@bot', 'question']),
        );
        expect(evaluatorRequests).toEqual([]);
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should not treat non-target CQ at mention as a bot mention', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'group',
        message_id: 23459,
        user_id: 20004,
        group_id: 100001,
        message: '[CQ:at,qq=111111] 这不是在叫机器人',
        raw_message: '[CQ:at,qq=111111] 这不是在叫机器人',
        sender: {
          user_id: 20004,
          nickname: 'GroupUser4',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);

      const persisted = getPersistedMessage('qq-23459');
      expect(persisted).toBeDefined();
      expect(persisted?.text).toBe('这不是在叫机器人');
      expect(persisted?.mentions_bot).toBe(0);
      expectNoForeignKeyViolations();
    });

    it('should handle group message with question', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'group',
        message_id: 23458,
        user_id: 20003,
        group_id: 100001,
        message: '[CQ:at,qq=3889000770] 今天星期几？',
        raw_message: '[CQ:at,qq=3889000770] 今天星期几？',
        sender: {
          user_id: 20003,
          nickname: 'GroupUser3',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');
    });
  });

  describe('Non-message events', () => {
    it('should handle notice events gracefully', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-notice-event-secret-should-not-persist';
      const rawPlatformId = 'qq-1234567890';
      const beforeCounts = {
        rawEvents: countTableRows('raw_events'),
        chatMessages: countTableRows('chat_messages'),
        agentTurns: countTableRows('agent_turns'),
        contextTraces: countTableRows('context_traces'),
        actionDecisions: countTableRows('action_decisions'),
        actionExecutions: countTableRows('action_executions'),
      };
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'notice events should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent = {
          post_type: 'notice',
          notice_type: 'group_increase',
          group_id: rawPlatformId,
          user_id: rawPlatformId,
          operator_id: rawPlatformId,
          diagnostic: `token=${rawSecret}`,
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('ok');

        expect(piCalls).toBe(0);
        expect(sentMessages).toEqual([]);
        expect({
          rawEvents: countTableRows('raw_events'),
          chatMessages: countTableRows('chat_messages'),
          agentTurns: countTableRows('agent_turns'),
          contextTraces: countTableRows('context_traces'),
          actionDecisions: countTableRows('action_decisions'),
          actionExecutions: countTableRows('action_executions'),
        }).toEqual(beforeCounts);
        expect(app.getEventProcessingFailures()).toHaveLength(0);
        expectNoForeignKeyViolations();

        const leakedRows = app
          .getDatabase()
          .prepare('SELECT COUNT(*) AS count FROM raw_events WHERE payload LIKE ? OR conversation_id LIKE ?')
          .get(`%${rawSecret}%`, `%${rawPlatformId}%`) as { count: number };
        expect(leakedRows.count).toBe(0);
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should handle request events gracefully', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-request-event-secret-should-not-persist';
      const rawPlatformId = 'qq-3456789012';
      const beforeCounts = {
        rawEvents: countTableRows('raw_events'),
        chatMessages: countTableRows('chat_messages'),
        agentTurns: countTableRows('agent_turns'),
        contextTraces: countTableRows('context_traces'),
        actionDecisions: countTableRows('action_decisions'),
        actionExecutions: countTableRows('action_executions'),
      };
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'request events should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent = {
          post_type: 'request',
          request_type: 'friend',
          user_id: rawPlatformId,
          comment: `token=${rawSecret}`,
          flag: `flag-${rawPlatformId}-${rawSecret}`,
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('ok');

        expect(piCalls).toBe(0);
        expect(sentMessages).toEqual([]);
        expect({
          rawEvents: countTableRows('raw_events'),
          chatMessages: countTableRows('chat_messages'),
          agentTurns: countTableRows('agent_turns'),
          contextTraces: countTableRows('context_traces'),
          actionDecisions: countTableRows('action_decisions'),
          actionExecutions: countTableRows('action_executions'),
        }).toEqual(beforeCounts);
        expect(app.getEventProcessingFailures()).toHaveLength(0);
        expectNoForeignKeyViolations();

        const leakedRows = app
          .getDatabase()
          .prepare('SELECT COUNT(*) AS count FROM raw_events WHERE payload LIKE ? OR conversation_id LIKE ?')
          .get(`%${rawSecret}%`, `%${rawPlatformId}%`) as { count: number };
        expect(leakedRows.count).toBe(0);
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should handle private and group message_sent events gracefully', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'message_sent events should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const unsupportedEvents = [
          {
            secret: 'sk-message-sent-private-event-secret-should-not-persist',
            platformId: 'qq-5678901234',
            groupId: 'qq-group-unused-private',
            payload: {
              post_type: 'message_sent',
              message_type: 'private',
              message_id: 'qq-5678901234',
              user_id: 'qq-5678901234',
              target_id: 'qq-5678901234',
              message: 'token=sk-message-sent-private-event-secret-should-not-persist',
              raw_message: 'token=sk-message-sent-private-event-secret-should-not-persist',
              sender: {
                user_id: 'qq-5678901234',
                nickname: 'sent-sk-message-sent-private-event-secret-should-not-persist',
              },
              time: Math.floor(Date.now() / 1000),
            },
          },
          {
            secret: 'sk-message-sent-group-event-secret-should-not-persist',
            platformId: 'qq-6789012345',
            groupId: 'qq-group-7890123456',
            payload: {
              post_type: 'message_sent',
              message_type: 'group',
              message_id: 'qq-6789012345',
              user_id: 'qq-6789012345',
              group_id: 'qq-group-7890123456',
              target_id: 'qq-group-7890123456',
              message: 'token=sk-message-sent-group-event-secret-should-not-persist',
              raw_message: 'token=sk-message-sent-group-event-secret-should-not-persist',
              sender: {
                user_id: 'qq-6789012345',
                nickname: 'sent-sk-message-sent-group-event-secret-should-not-persist',
              },
              time: Math.floor(Date.now() / 1000),
            },
          },
        ];

        for (const unsupportedEvent of unsupportedEvents) {
          const beforeCounts = {
            rawEvents: countTableRows('raw_events'),
            chatMessages: countTableRows('chat_messages'),
            agentTurns: countTableRows('agent_turns'),
            contextTraces: countTableRows('context_traces'),
            actionDecisions: countTableRows('action_decisions'),
            actionExecutions: countTableRows('action_executions'),
          };

          const response = await postEvent(unsupportedEvent.payload);

          expect(response.status).toBe(200);
          const data = await response.json();
          expect(data.status).toBe('ok');

          expect(piCalls).toBe(0);
          expect(sentMessages).toEqual([]);
          expect({
            rawEvents: countTableRows('raw_events'),
            chatMessages: countTableRows('chat_messages'),
            agentTurns: countTableRows('agent_turns'),
            contextTraces: countTableRows('context_traces'),
            actionDecisions: countTableRows('action_decisions'),
            actionExecutions: countTableRows('action_executions'),
          }).toEqual(beforeCounts);
          expect(app.getEventProcessingFailures()).toHaveLength(0);
          expectNoForeignKeyViolations();

          const leakedRows = app
            .getDatabase()
            .prepare(
              'SELECT COUNT(*) AS count FROM raw_events WHERE payload LIKE ? OR payload LIKE ? OR payload LIKE ? OR conversation_id LIKE ? OR conversation_id LIKE ?'
            )
            .get(
              `%${unsupportedEvent.secret}%`,
              `%${unsupportedEvent.platformId}%`,
              `%${unsupportedEvent.groupId}%`,
              `%${unsupportedEvent.platformId}%`,
              `%${unsupportedEvent.groupId}%`
            ) as { count: number };
          expect(leakedRows.count).toBe(0);
        }
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should acknowledge unknown post types without chat-path side effects', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-unknown-post-type-secret-should-not-persist';
      const rawPlatformId = 'qq-8901234567';
      const rawGroupId = 'qq-group-9012345678';
      const beforeCounts = {
        rawEvents: countTableRows('raw_events'),
        chatMessages: countTableRows('chat_messages'),
        agentTurns: countTableRows('agent_turns'),
        contextTraces: countTableRows('context_traces'),
        actionDecisions: countTableRows('action_decisions'),
        actionExecutions: countTableRows('action_executions'),
      };
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'unknown post types should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent = {
          post_type: 'message_reaction',
          message_id: rawPlatformId,
          user_id: rawPlatformId,
          group_id: rawGroupId,
          reaction: `token=${rawSecret}`,
          operator_id: rawPlatformId,
          comment: `legacy-${rawGroupId}-${rawSecret}`,
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('ok');

        expect(piCalls).toBe(0);
        expect(sentMessages).toEqual([]);
        expect({
          rawEvents: countTableRows('raw_events'),
          chatMessages: countTableRows('chat_messages'),
          agentTurns: countTableRows('agent_turns'),
          contextTraces: countTableRows('context_traces'),
          actionDecisions: countTableRows('action_decisions'),
          actionExecutions: countTableRows('action_executions'),
        }).toEqual(beforeCounts);
        expect(app.getEventProcessingFailures()).toHaveLength(0);
        expectNoForeignKeyViolations();

        const leakedRows = app
          .getDatabase()
          .prepare(
            'SELECT COUNT(*) AS count FROM raw_events WHERE payload LIKE ? OR payload LIKE ? OR payload LIKE ? OR conversation_id LIKE ? OR conversation_id LIKE ?'
          )
          .get(`%${rawSecret}%`, `%${rawPlatformId}%`, `%${rawGroupId}%`, `%${rawPlatformId}%`, `%${rawGroupId}%`) as {
          count: number;
        };
        expect(leakedRows.count).toBe(0);
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should acknowledge non-object JSON payloads without chat-path side effects', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-non-object-json-payload-secret-should-not-persist';
      const rawPlatformId = 'qq-8123456789';
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'non-object JSON payloads should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const payloads: unknown[] = [
          null,
          `token=${rawSecret} user=${rawPlatformId}`,
          8123456789,
          true,
          [`token=${rawSecret}`, rawPlatformId],
        ];

        for (const payload of payloads) {
          const beforeCounts = {
            rawEvents: countTableRows('raw_events'),
            chatMessages: countTableRows('chat_messages'),
            agentTurns: countTableRows('agent_turns'),
            contextTraces: countTableRows('context_traces'),
            actionDecisions: countTableRows('action_decisions'),
            actionExecutions: countTableRows('action_executions'),
          };

          const response = await postEvent(payload);

          expect(response.status).toBe(200);
          const data = await response.json();
          expect(data.status).toBe('ok');

          expect(piCalls).toBe(0);
          expect(sentMessages).toEqual([]);
          expect({
            rawEvents: countTableRows('raw_events'),
            chatMessages: countTableRows('chat_messages'),
            agentTurns: countTableRows('agent_turns'),
            contextTraces: countTableRows('context_traces'),
            actionDecisions: countTableRows('action_decisions'),
            actionExecutions: countTableRows('action_executions'),
          }).toEqual(beforeCounts);
          expect(app.getEventProcessingFailures()).toHaveLength(0);
          expectNoForeignKeyViolations();

          const leakedRows = app
            .getDatabase()
            .prepare('SELECT COUNT(*) AS count FROM raw_events WHERE payload LIKE ? OR conversation_id LIKE ?')
            .get(`%${rawSecret}%`, `%${rawPlatformId}%`) as { count: number };
          expect(leakedRows.count).toBe(0);
        }
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should handle meta events gracefully', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-meta-event-secret-should-not-persist';
      const rawPlatformId = 'qq-2345678901';
      const beforeCounts = {
        rawEvents: countTableRows('raw_events'),
        chatMessages: countTableRows('chat_messages'),
        agentTurns: countTableRows('agent_turns'),
        contextTraces: countTableRows('context_traces'),
        actionDecisions: countTableRows('action_decisions'),
        actionExecutions: countTableRows('action_executions'),
      };
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'meta events should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent = {
          post_type: 'meta_event',
          meta_event_type: 'heartbeat',
          self_id: rawPlatformId,
          status: {
            message: `token=${rawSecret}`,
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('ok');

        expect(piCalls).toBe(0);
        expect(sentMessages).toEqual([]);
        expect({
          rawEvents: countTableRows('raw_events'),
          chatMessages: countTableRows('chat_messages'),
          agentTurns: countTableRows('agent_turns'),
          contextTraces: countTableRows('context_traces'),
          actionDecisions: countTableRows('action_decisions'),
          actionExecutions: countTableRows('action_executions'),
        }).toEqual(beforeCounts);
        expect(app.getEventProcessingFailures()).toHaveLength(0);
        expectNoForeignKeyViolations();

        const leakedRows = app
          .getDatabase()
          .prepare('SELECT COUNT(*) AS count FROM raw_events WHERE payload LIKE ? OR conversation_id LIKE ?')
          .get(`%${rawSecret}%`, `%${rawPlatformId}%`) as { count: number };
        expect(leakedRows.count).toBe(0);
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });
  });

  describe('Unsupported message types', () => {
    it('should acknowledge unsupported message subtypes without chat-path side effects', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-unsupported-message-type-secret-should-not-persist';
      const rawPlatformId = 'qq-4567890123';
      const beforeCounts = {
        rawEvents: countTableRows('raw_events'),
        chatMessages: countTableRows('chat_messages'),
        agentTurns: countTableRows('agent_turns'),
        contextTraces: countTableRows('context_traces'),
        actionDecisions: countTableRows('action_decisions'),
        actionExecutions: countTableRows('action_executions'),
      };
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'unsupported message types should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const onebotEvent = {
          post_type: 'message',
          message_type: 'guild',
          message_id: rawPlatformId,
          user_id: rawPlatformId,
          guild_id: rawPlatformId,
          channel_id: rawPlatformId,
          message: `token=${rawSecret}`,
          raw_message: `token=${rawSecret}`,
          sender: {
            user_id: rawPlatformId,
            nickname: `nick-${rawSecret}`,
          },
          time: Math.floor(Date.now() / 1000),
        };

        const response = await postEvent(onebotEvent);

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('ok');

        expect(piCalls).toBe(0);
        expect(sentMessages).toEqual([]);
        expect({
          rawEvents: countTableRows('raw_events'),
          chatMessages: countTableRows('chat_messages'),
          agentTurns: countTableRows('agent_turns'),
          contextTraces: countTableRows('context_traces'),
          actionDecisions: countTableRows('action_decisions'),
          actionExecutions: countTableRows('action_executions'),
        }).toEqual(beforeCounts);
        expect(app.getEventProcessingFailures()).toHaveLength(0);
        expectNoForeignKeyViolations();

        const leakedRows = app
          .getDatabase()
          .prepare('SELECT COUNT(*) AS count FROM raw_events WHERE payload LIKE ? OR conversation_id LIKE ?')
          .get(`%${rawSecret}%`, `%${rawPlatformId}%`) as { count: number };
        expect(leakedRows.count).toBe(0);
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should acknowledge unsupported or malformed message sub_type values without chat-path side effects', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-unsupported-message-subtype-secret-should-not-persist';
      const rawPlatformId = 'qq-4567890124';
      const beforeCounts = {
        rawEvents: countTableRows('raw_events'),
        chatMessages: countTableRows('chat_messages'),
        agentTurns: countTableRows('agent_turns'),
        contextTraces: countTableRows('context_traces'),
        actionDecisions: countTableRows('action_decisions'),
        actionExecutions: countTableRows('action_executions'),
      };
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'unsupported message subtypes should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      try {
        const payloads: Array<Record<string, unknown>> = [
          {
            post_type: 'message',
            message_type: 'group',
            sub_type: 'guild',
            message_id: 33301,
            user_id: 33302,
            group_id: 33303,
            message: `[CQ:at,qq=3889000770] token=${rawSecret} target=${rawPlatformId}`,
            raw_message: `[CQ:at,qq=3889000770] token=${rawSecret} target=${rawPlatformId}`,
            sender: {
              user_id: 33302,
              nickname: `nick-${rawSecret}`,
              role: 'member',
            },
            time: Math.floor(Date.now() / 1000),
          },
          {
            post_type: 'message',
            message_type: 'private',
            sub_type: { token: rawSecret, platform: rawPlatformId },
            message_id: 33304,
            user_id: 33305,
            message: `token=${rawSecret}`,
            raw_message: `token=${rawSecret}`,
            sender: {
              user_id: 33305,
              nickname: `nick-${rawSecret}`,
            },
            time: Math.floor(Date.now() / 1000),
          },
        ];

        for (const onebotEvent of payloads) {
          const response = await postEvent(onebotEvent as unknown as OneBotMessage);
          expect(response.status).toBe(200);
          const data = await response.json();
          expect(data.status).toBe('ok');
        }

        expect(piCalls).toBe(0);
        expect(sentMessages).toEqual([]);
        expect({
          rawEvents: countTableRows('raw_events'),
          chatMessages: countTableRows('chat_messages'),
          agentTurns: countTableRows('agent_turns'),
          contextTraces: countTableRows('context_traces'),
          actionDecisions: countTableRows('action_decisions'),
          actionExecutions: countTableRows('action_executions'),
        }).toEqual(beforeCounts);
        expect(app.getEventProcessingFailures()).toHaveLength(0);
        expectNoForeignKeyViolations();

        const leakedRows = app
          .getDatabase()
          .prepare('SELECT COUNT(*) AS count FROM raw_events WHERE payload LIKE ? OR conversation_id LIKE ?')
          .get(`%${rawSecret}%`, `%${rawPlatformId}%`) as { count: number };
        expect(leakedRows.count).toBe(0);
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });
  });

  describe('Durable background runtime', () => {
    it('should reject summary jobs without an explicit conversation type', async () => {
      let piCalls = 0;
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'SUMMARY: Must not run',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });

      try {
        const taskId = app.enqueueBackgroundTaskForTesting({
          type: 'summary',
          payload: { conversationId: 'missing-summary-conversation-type' },
          maxAttempts: 1,
        });

        const result = await app.processNextBackgroundJobForTesting();

        expect(result).toMatchObject({ taskId, status: 'failed' });
        expect(piCalls).toBe(0);
        expect(
          app.getDatabase().prepare('SELECT status FROM jobs WHERE id = ?').get(taskId),
        ).toEqual({ status: 'failed' });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('should process action-scheduled summary jobs through durable worker with source-linked memory writes', async () => {
      const providerResponseText =
        'SUMMARY: Action scheduled summary captured the group discussion.\nFACTS:\n- Action scheduled summary jobs can be processed by the durable worker';
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          return {
            turnId: input.turnId,
            responseText: providerResponseText,
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 10, output: 10, total: 20 },
            status: 'completed',
          };
        },
      });

      try {
        const db = app.getDatabase();
        const now = Date.UTC(2026, 6, 4);
        const conversationId = 'group:action-scheduled-summary';
        const groupId = 'group-action-scheduled-summary';
        const messageIds: string[] = [];
        const rawEventIds: string[] = [];

        new GroupSummaryPolicyRepository(db).setEnabled({
          groupId,
          enabled: true,
          authority: {
            kind: 'bot_owner',
            actorUserId: 'test-bot-owner',
            invocationContext: 'admin_cli',
          },
          now,
        });

        for (let i = 0; i < 10; i++) {
          const eventId = `evt-action-scheduled-summary-${i}`;
          const messageId = `msg-action-scheduled-summary-${i}`;
          rawEventIds.push(eventId);
          messageIds.push(messageId);
          db.prepare(
            `INSERT INTO raw_events (
              id, type, timestamp, source, platform,
              conversation_id, payload, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            eventId,
            'chat.message.received',
            now + i * 1000,
            'gateway',
            'qq',
            conversationId,
            '{}',
            now + i * 1000 + 1,
          );
          db.prepare(
            `INSERT INTO chat_messages (
              id, raw_event_id, message_id, conversation_id,
              conversation_type, group_id, sender_id, text, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            messageId,
            eventId,
            `qq-action-summary-${i}`,
            conversationId,
            'group',
            groupId,
            `user-action-summary-${i % 2}`,
            `Action scheduled summary message ${i}`,
            now + i * 1000,
          );
        }

        const taskPayload = {
          conversationId,
          conversationType: 'group' as const,
          groupId,
          messageRange: {
            start: messageIds[0] ?? '',
            end: messageIds[messageIds.length - 1] ?? '',
          },
        };
        const summaryJobs = Reflect.get(app, 'groupSummaryJobService') as GroupSummaryJobService;
        const taskId = await summaryJobs.enqueueSummary({
          conversationId,
          conversationType: 'group',
          groupId,
          payload: {
            ...taskPayload,
            source: 'action_executor',
            actionDecisionId: 'decision-action-scheduled-summary',
            actionType: 'schedule_background_task',
            reasonSummary: 'Scheduled from action executor',
            taskPayload,
          },
          baseIdempotencyKey: 'action:schedule_background_task:decision-action-scheduled-summary:summary',
          maxAttempts: 2,
        });
        db.prepare(
          `INSERT INTO raw_events (
            id, type, timestamp, source, platform,
            conversation_id, payload, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'evt-action-scheduled-summary-later',
          'chat.message.received',
          now + 4_500,
          'gateway',
          'qq',
          conversationId,
          '{}',
          now + 20_000,
        );
        db.prepare(
          `INSERT INTO chat_messages (
            id, raw_event_id, message_id, conversation_id,
            conversation_type, group_id, sender_id, text, timestamp
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          'msg-action-scheduled-summary-later',
          'evt-action-scheduled-summary-later',
          'qq-action-summary-later',
          conversationId,
          'group',
          groupId,
          'user-action-summary-later',
          'Later source must not enter the frozen summary window',
          now + 4_500,
        );

        const frozenPayload = JSON.parse(String(
          (db.prepare('SELECT payload FROM jobs WHERE id = ?').get(taskId) as { payload: string }).payload,
        )) as { sourceChatMessageIds: string[]; windowVersion: number };
        expect(frozenPayload).toMatchObject({
          sourceChatMessageIds: messageIds,
          windowVersion: 1,
        });

        const result = await app.processNextBackgroundJobForTesting();
        expect(result?.taskId).toBe(taskId);
        expect(result?.status).toBe('completed');

        const output = result?.output as
          | { summaryId: string; messageCount: number }
          | undefined;
        expect(output?.messageCount).toBe(messageIds.length);
        expect(output?.summaryId).toBeDefined();
        expect(output).not.toHaveProperty('summary');
        expect(output).not.toHaveProperty('extractedFacts');

        const job = db.prepare('SELECT status, attempts, result FROM jobs WHERE id = ?').get(taskId) as {
          status: string;
          attempts: number;
          result: string;
        };
        const attempts = db
          .prepare('SELECT id, status, worker_id, result FROM job_attempts WHERE job_id = ?')
          .all(taskId) as Array<{ id: string; status: string; worker_id: string; result: string }>;
        const memory = db
          .prepare('SELECT state, scope, group_id, conversation_id, kind, source_context FROM memory_records WHERE id = ?')
          .get(output?.summaryId) as {
            state: string;
            scope: string;
            group_id: string;
            conversation_id: string;
            kind: string;
            source_context: string;
          };
        const sourceCount = (
          db.prepare('SELECT COUNT(*) AS count FROM memory_sources WHERE memory_id = ?').get(output?.summaryId) as {
            count: number;
          }
        ).count;
        const memorySources = db.prepare(
          `SELECT source_id
             FROM memory_sources
            WHERE memory_id = ? AND source_type = 'chat_message'
            ORDER BY source_timestamp ASC, source_id ASC`,
        ).all(output?.summaryId) as Array<{ source_id: string }>;
        const modelContext = db.prepare(
          `SELECT * FROM model_contexts WHERE job_attempt_id = ?`,
        ).get(attempts[0]?.id) as Record<string, unknown> | undefined;
        const modelInvocation = db.prepare(
          `SELECT * FROM model_invocations WHERE job_attempt_id = ?`,
        ).get(attempts[0]?.id) as Record<string, unknown> | undefined;
        const invocationSources = db.prepare(
          `SELECT raw_event_id
           FROM model_invocation_sources
           WHERE model_invocation_id = ?
           ORDER BY source_ordinal ASC`,
        ).all(modelInvocation?.id) as Array<{ raw_event_id: string }>;

        expect(job.status).toBe('completed');
        expect(job.attempts).toBe(1);
        expect(JSON.parse(job.result).summaryId).toBe(output?.summaryId);
        expect(job.result).not.toContain('Action scheduled summary captured');
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          status: 'completed',
          worker_id: 'lethebot-background-main',
        });
        expect(JSON.parse(attempts[0]?.result ?? '{}').summaryId).toBe(output?.summaryId);
        expect(attempts[0]?.result).not.toContain('Action scheduled summary captured');
        expect(memory).toMatchObject({
          state: 'active',
          scope: 'group',
          group_id: groupId,
          conversation_id: conversationId,
          kind: 'summary',
          source_context: 'background_worker:summary',
        });
        expect(sourceCount).toBe(messageIds.length);
        expect(memorySources.map((source) => source.source_id)).toEqual(messageIds);
        expect(modelContext).toMatchObject({
          job_attempt_id: attempts[0]?.id,
          purpose: 'summary',
          conversation_type: 'group',
        });
        expect(modelContext?.conversation_ref).toMatch(/^ctxref-sha256:[0-9a-f]{64}$/);
        expect(modelContext?.group_ref).toMatch(/^groupref-sha256:[0-9a-f]{64}$/);
        expect(JSON.parse(String(modelContext?.recent_message_ids))).toEqual(messageIds);
        expect(JSON.parse(String(modelContext?.filters_applied))).toContain(
          'memory=excluded_by_caller',
        );
        expect(modelInvocation).toMatchObject({
          job_attempt_id: attempts[0]?.id,
          context_id: modelContext?.id,
          purpose: 'summary',
          call_number: 1,
          provider: 'mock',
          model: 'mock',
          status: 'completed',
          tokens_input: 10,
          tokens_output: 10,
          tokens_total: 20,
          response_sha256: createHash('sha256').update(providerResponseText).digest('hex'),
          response_bytes: Buffer.byteLength(providerResponseText, 'utf8'),
          error_code: null,
        });
        expect(invocationSources.map((source) => source.raw_event_id)).toEqual(rawEventIds);

        const serializedLedger = JSON.stringify({ modelContext, modelInvocation });
        expect(serializedLedger).not.toContain(providerResponseText);
        expect(serializedLedger).not.toContain(conversationId);
        expect(serializedLedger).not.toContain(groupId);
        expect(serializedLedger).not.toContain('Action scheduled summary message');
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('should ledger each failed summary retry against one exact durable context', async () => {
      let providerCalls = 0;
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          providerCalls += 1;
          if (providerCalls === 1) {
            return {
              turnId: input.turnId,
              responseText: '',
              errorMessage: 'Synthetic provider failure',
              toolCallIds: [],
              events: [],
              tokensUsed: { input: 0, output: 0, total: 0 },
              status: 'failed',
            };
          }
          return {
            turnId: input.turnId,
            responseText: ' \n\t',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 0, output: 0, total: 0 },
            status: 'completed',
          };
        },
      });

      try {
        const db = app.getDatabase();
        const now = Date.UTC(2026, 6, 5);
        const conversationId = 'private:durable-summary-retry';
        const rawEventIds: string[] = [];
        const messageIds: string[] = [];
        for (let index = 0; index < 10; index += 1) {
          const rawEventId = `evt-durable-summary-retry-${index}`;
          const messageId = `msg-durable-summary-retry-${index}`;
          rawEventIds.push(rawEventId);
          messageIds.push(messageId);
          db.prepare(
            `INSERT INTO raw_events (
              id, type, timestamp, source, platform,
              conversation_id, payload, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            rawEventId,
            'chat.message.received',
            now + index,
            'gateway',
            'qq',
            conversationId,
            '{}',
            now + index,
          );
          db.prepare(
            `INSERT INTO chat_messages (
              id, raw_event_id, message_id, conversation_id,
              conversation_type, sender_id, text, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            messageId,
            rawEventId,
            `qq-durable-summary-retry-${index}`,
            conversationId,
            'private',
            'user-durable-summary-retry',
            `Durable retry message ${index}`,
            now + index,
          );
        }

        const taskId = app.enqueueBackgroundTaskForTesting({
          type: 'summary',
          payload: {
            conversationId,
            conversationType: 'private',
            messageRange: {
              start: messageIds[0] ?? '',
              end: messageIds[messageIds.length - 1] ?? '',
            },
          },
          maxAttempts: 1,
        });

        const result = await app.processNextBackgroundJobForTesting();
        expect(result).toMatchObject({ taskId, status: 'failed' });
        expect(providerCalls).toBe(2);

        const attempt = db.prepare(
          'SELECT id, status FROM job_attempts WHERE job_id = ?',
        ).get(taskId) as { id: string; status: string };
        const contexts = db.prepare(
          'SELECT id, recent_message_ids FROM model_contexts WHERE job_attempt_id = ?',
        ).all(attempt.id) as Array<{ id: string; recent_message_ids: string }>;
        const invocations = db.prepare(
          `SELECT id, context_id, call_number, status, error_code,
                  response_sha256, response_bytes
           FROM model_invocations
           WHERE job_attempt_id = ?
           ORDER BY call_number ASC`,
        ).all(attempt.id) as Array<{
          id: string;
          context_id: string;
          call_number: number;
          status: string;
          error_code: string;
          response_sha256: string | null;
          response_bytes: number | null;
        }>;

        expect(attempt.status).toBe('failed');
        expect(contexts).toHaveLength(1);
        expect(JSON.parse(contexts[0]?.recent_message_ids ?? '[]')).toEqual(messageIds);
        expect(invocations).toHaveLength(2);
        expect(invocations.map((invocation) => ({
          contextId: invocation.context_id,
          callNumber: invocation.call_number,
          status: invocation.status,
          errorCode: invocation.error_code,
          responseSha256: invocation.response_sha256,
          responseBytes: invocation.response_bytes,
        }))).toEqual([
          {
            contextId: contexts[0]?.id,
            callNumber: 1,
            status: 'failed',
            errorCode: 'provider_failed',
            responseSha256: null,
            responseBytes: null,
          },
          {
            contextId: contexts[0]?.id,
            callNumber: 2,
            status: 'failed',
            errorCode: 'empty_response',
            responseSha256: null,
            responseBytes: null,
          },
        ]);

        for (const invocation of invocations) {
          const sources = db.prepare(
            `SELECT raw_event_id
             FROM model_invocation_sources
             WHERE model_invocation_id = ?
             ORDER BY source_ordinal ASC`,
          ).all(invocation.id) as Array<{ raw_event_id: string }>;
          expect(sources.map((source) => source.raw_event_id)).toEqual(rawEventIds);
        }
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM model_invocations WHERE status = 'running'").get(),
        ).toEqual({ count: 0 });
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM memory_records WHERE conversation_id = ?')
            .get(conversationId),
        ).toEqual({ count: 0 });
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('should process extraction jobs through durable job attempts and source-linked memory writes', async () => {
      const deliveredText = 'Automatic extraction response must not enter the job payload.';
      const sentMessages: SentMessage[] = [];
      const memoryEvaluationRequests: MemoryEvaluationRequest[] = [];
      const memoryEvaluationDecisionIds: string[] = [];
      class CountingMemoryEvaluator extends EvaluatorStub {
        override async evaluateMemory(
          request: MemoryEvaluationRequest,
        ): Promise<MemoryEvaluationResult> {
          memoryEvaluationRequests.push(request);
          const result = await super.evaluateMemory(request);
          const decisionId = `eval-durable-extraction-${request.requestId}`;
          memoryEvaluationDecisionIds.push(decisionId);
          return { ...result, decisionId };
        }
      }
      setReplyingPiRuntime(deliveredText);
      setCapturingMessageSender(sentMessages);
      app.setSocialEvaluatorForTesting(new CountingMemoryEvaluator());
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 34567,
        user_id: 34567,
        message: '我喜欢 后台任务测试',
        raw_message: '我喜欢 后台任务测试',
        sender: {
          user_id: 34567,
          nickname: 'BackgroundUser',
        },
        time: Math.floor(Date.now() / 1000),
      };

      try {
        const response = await postEvent(onebotEvent);
        expect(response.status).toBe(200);
        expect(sentMessages).toHaveLength(1);

        const persisted = getPersistedMessage('qq-34567');
        const turn = getTurnForMessage('qq-34567');
        expect(persisted).toBeDefined();
        expect(turn?.status).toBe('completed');

        const db = app.getDatabase();
        const identity = db
          .prepare(
            `SELECT canonical_user_id
             FROM platform_accounts
             WHERE platform = 'qq' AND platform_account_id = ?`
          )
          .get('34567') as { canonical_user_id: string } | undefined;
        expect(identity?.canonical_user_id).toBeDefined();

        const idempotencyKey = `extraction:auto:${persisted?.id}`;
        const pendingJob = db.prepare(
          `SELECT id, status, attempts, payload, idempotency_key
           FROM jobs WHERE type = 'extraction' AND idempotency_key = ?`
        ).get(idempotencyKey) as {
          id: string;
          status: string;
          attempts: number;
          payload: string;
          idempotency_key: string;
        };
        const payload = JSON.parse(pendingJob.payload) as Record<string, unknown>;

        expect(pendingJob).toMatchObject({
          status: 'pending',
          attempts: 0,
          idempotency_key: idempotencyKey,
        });
        expect(payload).toEqual({
          sourceChatMessageId: persisted?.id,
          targetUserId: identity?.canonical_user_id,
        });
        expect(Object.keys(payload).sort()).toEqual(['sourceChatMessageId', 'targetUserId']);
        expect(pendingJob.payload).not.toContain('我喜欢 后台任务测试');
        expect(pendingJob.payload).not.toContain(deliveredText);
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM memory_sources WHERE source_type = ? AND source_id = ?')
            .get('chat_message', persisted?.id)
        ).toEqual({ count: 0 });

        const duplicateResponse = await postEvent(onebotEvent);
        expect(duplicateResponse.status).toBe(200);
        expect(sentMessages).toHaveLength(1);
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'extraction' AND idempotency_key = ?")
            .get(idempotencyKey)
        ).toEqual({ count: 1 });

        db.exec(`
          CREATE TEMP TRIGGER fail_auto_extraction_memory_create
          BEFORE INSERT ON memory_records
          WHEN NEW.id LIKE 'extraction-v1-%'
          BEGIN
            SELECT RAISE(ABORT, 'forced extraction candidate persistence failure');
          END
        `);
        const candidateFailure = await app.processNextBackgroundJobForTesting();
        expect(candidateFailure).toMatchObject({ taskId: pendingJob.id, status: 'failed' });
        expect(
          db.prepare('SELECT status, attempts FROM jobs WHERE id = ?').get(pendingJob.id)
        ).toEqual({ status: 'pending', attempts: 1 });
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM memory_sources WHERE source_type = ? AND source_id = ?')
            .get('chat_message', persisted?.id)
        ).toEqual({ count: 0 });
        const firstAttempt = db.prepare(
          `SELECT id, status, attempt_number
           FROM job_attempts
           WHERE job_id = ?
           ORDER BY attempt_number ASC`,
        ).get(pendingJob.id) as { id: string; status: string; attempt_number: number };
        expect(firstAttempt).toMatchObject({ status: 'failed', attempt_number: 1 });
        expect(memoryEvaluationRequests).toHaveLength(1);
        expect(memoryEvaluationRequests[0]).toMatchObject({
          domain: 'memory',
          jobAttemptId: firstAttempt.id,
          actor: {
            canonicalUserId: identity?.canonical_user_id,
            actorClass: 'system_worker',
          },
          context: 'background_worker',
          sourceEventIds: [persisted?.raw_event_id],
        });
        expect(memoryEvaluationRequests[0]).not.toHaveProperty('turnId');
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions WHERE request_id = ?')
            .get(memoryEvaluationRequests[0]?.requestId),
        ).toEqual({ count: 0 });
        expectNoForeignKeyViolations();
        db.exec('DROP TRIGGER fail_auto_extraction_memory_create');

        db.exec(`
          CREATE TEMP TRIGGER fail_auto_extraction_job_completion
          BEFORE UPDATE OF status ON job_attempts
          WHEN NEW.job_id = '${pendingJob.id}' AND NEW.status = 'completed'
          BEGIN
            SELECT RAISE(ABORT, 'forced extraction job completion failure');
          END
        `);
        const failed = await app.processNextBackgroundJobForTesting();
        expect(failed).toMatchObject({ taskId: pendingJob.id, status: 'failed' });
        expect(
          db.prepare('SELECT status, attempts FROM jobs WHERE id = ?').get(pendingJob.id)
        ).toEqual({ status: 'pending', attempts: 2 });
        const committedBeforeRetry = db.prepare(
          `SELECT memory_id FROM memory_sources
           WHERE source_type = 'chat_message' AND source_id = ?`
        ).get(persisted?.id) as { memory_id: string } | undefined;
        expect(committedBeforeRetry?.memory_id).toMatch(/^extraction-v1-[a-f0-9]{64}$/);
        const attemptsBeforeRetry = db.prepare(
          `SELECT id, status, attempt_number
           FROM job_attempts
           WHERE job_id = ?
           ORDER BY attempt_number ASC`,
        ).all(pendingJob.id) as Array<{ id: string; status: string; attempt_number: number }>;
        expect(attemptsBeforeRetry).toHaveLength(2);
        expect(attemptsBeforeRetry.map((attempt) => attempt.status)).toEqual(['failed', 'failed']);
        expect(memoryEvaluationRequests).toHaveLength(2);
        expect(memoryEvaluationRequests[1]).toMatchObject({
          domain: 'memory',
          jobAttemptId: attemptsBeforeRetry[1]?.id,
          actor: {
            canonicalUserId: identity?.canonical_user_id,
            actorClass: 'system_worker',
          },
          context: 'background_worker',
          sourceEventIds: [persisted?.raw_event_id],
        });
        expect(memoryEvaluationRequests[1]).not.toHaveProperty('turnId');
        const committedDecision = db.prepare(
          `SELECT id, request_id, turn_id, job_attempt_id, domain, actor_user_id,
                  actor_class, invocation_context, source_event_ids
           FROM evaluator_decisions
           WHERE request_id = ?`,
        ).get(memoryEvaluationRequests[1]?.requestId) as {
          id: string;
          request_id: string;
          turn_id: string | null;
          job_attempt_id: string | null;
          domain: string;
          actor_user_id: string | null;
          actor_class: string;
          invocation_context: string;
          source_event_ids: string;
        };
        expect(committedDecision).toMatchObject({
          id: memoryEvaluationDecisionIds[1],
          request_id: memoryEvaluationRequests[1]?.requestId,
          turn_id: null,
          job_attempt_id: attemptsBeforeRetry[1]?.id,
          domain: 'memory',
          actor_user_id: identity?.canonical_user_id,
          actor_class: 'system_worker',
          invocation_context: 'background_worker',
        });
        expect(JSON.parse(committedDecision.source_event_ids)).toEqual([persisted?.raw_event_id]);
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions WHERE id IN (?, ?)')
            .get(memoryEvaluationDecisionIds[0], memoryEvaluationDecisionIds[1]),
        ).toEqual({ count: 1 });
        expectNoForeignKeyViolations();

        db.exec('DROP TRIGGER fail_auto_extraction_job_completion');
        const result = await app.processNextBackgroundJobForTesting();
        expect(result).toMatchObject({ taskId: pendingJob.id, status: 'completed' });
        const output = result?.output as { matched: boolean; count: number; memoryIds: string[] } | undefined;
        expect(output).toMatchObject({ matched: true, count: 1 });
        const memoryId = output?.memoryIds[0];
        expect(memoryId).toMatch(/^extraction-v1-[a-f0-9]{64}$/);
        expect(memoryId).toBe(committedBeforeRetry?.memory_id);
        expect(memoryEvaluationRequests).toHaveLength(2);
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM evaluator_decisions WHERE id IN (?, ?)')
            .get(memoryEvaluationDecisionIds[0], memoryEvaluationDecisionIds[1]),
        ).toEqual({ count: 1 });

        const job = db.prepare('SELECT status, attempts, result FROM jobs WHERE id = ?').get(pendingJob.id) as {
          status: string;
          attempts: number;
          result: string;
        };
        const attempts = db
          .prepare('SELECT status, worker_id, result FROM job_attempts WHERE job_id = ?')
          .all(pendingJob.id) as Array<{ status: string; worker_id: string; result: string }>;
        const memory = db
          .prepare(
            `SELECT state, scope, canonical_user_id, content, evaluator_decision_id
             FROM memory_records WHERE id = ?`,
          )
          .get(memoryId) as {
            state: string;
            scope: string;
            canonical_user_id: string;
            content: string;
            evaluator_decision_id: string | null;
          };
        const source = db
          .prepare('SELECT source_type, source_id FROM memory_sources WHERE memory_id = ?')
          .get(memoryId) as { source_type: string; source_id: string };

        expect(job.status).toBe('completed');
        expect(job.attempts).toBe(3);
        expect(JSON.parse(job.result).memoryIds).toEqual([memoryId]);
        expect(attempts).toHaveLength(3);
        expect(attempts.map((attempt) => attempt.status)).toEqual(['failed', 'failed', 'completed']);
        expect(attempts[2]).toMatchObject({ status: 'completed', worker_id: 'lethebot-background-main' });
        expect(memory).toMatchObject({
          state: 'active',
          scope: 'user',
          canonical_user_id: identity?.canonical_user_id,
          content: '我喜欢 后台任务测试',
          evaluator_decision_id: committedDecision.id,
        });
        expect(source).toEqual({ source_type: 'chat_message', source_id: persisted?.id });
        expect(db.prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?').get(memoryId))
          .toEqual({ count: 1 });
        expect(
          db.prepare('SELECT evaluator_decision_id FROM memory_revisions WHERE memory_id = ?').get(memoryId),
        ).toEqual({ evaluator_decision_id: committedDecision.id });
        expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'memory.create' AND event_id = ?")
          .get(memoryId)).toEqual({ count: 1 });
        expect(
          db.prepare(
            "SELECT evaluator_decision_id FROM audit_log WHERE event_type = 'memory.create' AND event_id = ?",
          ).get(memoryId),
        ).toEqual({ evaluator_decision_id: committedDecision.id });
        expectNoForeignKeyViolations();
      } finally {
        app.getDatabase().exec('DROP TRIGGER IF EXISTS fail_auto_extraction_memory_create');
        app.getDatabase().exec('DROP TRIGGER IF EXISTS fail_auto_extraction_job_completion');
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should process retention jobs through durable worker and preserve database integrity', async () => {
      const db = app.getDatabase();
      const now = Date.UTC(2026, 6, 3);
      const old = now - 45 * 24 * 60 * 60 * 1000;
      const recent = now - 2 * 24 * 60 * 60 * 1000;

      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('evt-retention-old', 'chat.message.received', old, 'gateway', 'qq', 'private:retention', '{}', old);
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('evt-retention-recent', 'chat.message.received', recent, 'gateway', 'qq', 'private:retention', '{}', recent);
      db.prepare(
        `INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id,
          conversation_type, sender_id, text, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('msg-retention-old', 'evt-retention-old', 'msg-retention-old', 'private:retention', 'private', 'qq-retention', 'old', old);
      db.prepare(
        `INSERT INTO chat_messages (
          id, raw_event_id, message_id, conversation_id,
          conversation_type, sender_id, text, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg-retention-recent',
        'evt-retention-recent',
        'msg-retention-recent',
        'private:retention',
        'private',
        'qq-retention',
        'recent',
        recent
      );
      db.prepare(
        `INSERT INTO audit_log (
          id, timestamp, category, level, event_type, event_id,
          actor_class, invocation_context, summary, redacted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('audit-retention-old', old, 'system', 'summary', 'retention.seed', 'audit-retention-old', 'system', 'system', 'old audit', 0);
      db.prepare(
        `INSERT INTO memory_records (
          id, scope, visibility, sensitivity, authority,
          kind, title, content, state, confidence, importance,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'mem-retention-disabled',
        'system',
        'owner_admin_only',
        'normal',
        'system',
        'fact',
        'retention disabled',
        'purge me',
        'disabled',
        0.7,
        0.4,
        old,
        old
      );
      db.prepare(
        `INSERT INTO memory_records (
          id, scope, visibility, sensitivity, authority,
          kind, title, content, state, confidence, importance,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'mem-retention-active',
        'system',
        'owner_admin_only',
        'normal',
        'system',
        'fact',
        'retention active',
        'keep me',
        'active',
        0.7,
        0.4,
        old,
        old
      );
      db.prepare(
        `INSERT INTO memory_sources (
          memory_id, source_type, source_id, source_timestamp, extracted_by
        ) VALUES (?, ?, ?, ?, ?)`
      ).run('mem-retention-disabled', 'raw_event', 'evt-retention-old', old, 'test');
      db.prepare(
        `INSERT INTO memory_revisions (
          id, memory_id, revision_number, change_type,
          previous_state, new_state, reason, actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('rev-retention-disabled', 'mem-retention-disabled', 1, 'disable', null, '{}', 'seed', 'admin', old);

      const taskId = app.enqueueBackgroundTaskForTesting({
        type: 'retention',
        payload: {
          rawEventsDays: 30,
          chatMessagesDays: 30,
          auditLogDays: 30,
          disabledDeletedMemoryDays: 30,
          nowMs: now,
        },
        idempotencyKey: 'test:retention:2026-07-03',
        maxAttempts: 2,
      });

      const result = await app.processNextBackgroundJobForTesting();
      expect(result?.taskId).toBe(taskId);
      expect(result?.status).toBe('completed');
      expect(result?.output).toMatchObject({
        rawEventsDeleted: 1,
        modelInvocationSourcesDeleted: 0,
        chatMessagesDeleted: 1,
        auditLogDeleted: 1,
        memoriesPurged: 1,
        memorySourcesDeleted: 1,
        memoryRevisionsDeleted: 1,
      });

      const job = db.prepare('SELECT status, attempts, result FROM jobs WHERE id = ?').get(taskId) as {
        status: string;
        attempts: number;
        result: string;
      };
      const attempts = db
        .prepare('SELECT status, worker_id, result FROM job_attempts WHERE job_id = ?')
        .all(taskId) as Array<{ status: string; worker_id: string; result: string }>;

      expect(job.status).toBe('completed');
      expect(job.attempts).toBe(1);
      expect(JSON.parse(job.result)).toMatchObject({
        rawEventsDeleted: 1,
        modelInvocationSourcesDeleted: 0,
      });
      expect(attempts).toEqual([
        expect.objectContaining({
          status: 'completed',
          worker_id: 'lethebot-background-main',
        }),
      ]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE id = ?').get('msg-retention-old')).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM raw_events WHERE id = ?').get('evt-retention-old')).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE id = ?').get('msg-retention-recent')).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM raw_events WHERE id = ?').get('evt-retention-recent')).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records WHERE id = ?').get('mem-retention-disabled')).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records WHERE id = ?').get('mem-retention-active')).toEqual({ count: 1 });
      expectNoForeignKeyViolations();
    });

    it('should process admin digest jobs with redacted DB-backed operational evidence', async () => {
      const db = app.getDatabase();
      const secretLikeToken = 'sk-admin-digest-secret-should-not-leak';
      const untilMs = Date.UTC(2030, 0, 2);
      const sinceMs = untilMs - 24 * 60 * 60 * 1000;
      const sampleMs = untilMs - 1_000;

      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'evt-admin-digest-seed',
        'system.admin_digest.seed',
        sampleMs,
        'system',
        'qq',
        'private:admin-digest',
        '{}',
        sampleMs
      );
      db.prepare(
        `INSERT INTO agent_turns (
          id, conversation_id, trigger_event_id,
          pi_model, pi_provider, status, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'turn-admin-digest-seed',
        'private:admin-digest',
        'evt-admin-digest-seed',
        'mock',
        'mock',
        'completed',
        sampleMs,
        sampleMs
      );
      db.prepare(
        `INSERT INTO action_decisions (
          id, turn_id, decided_by, risk_level, confidence,
          evaluator_required, evaluator_passed, actions, reasons, suppressors, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'decision-admin-digest-seed',
        'turn-admin-digest-seed',
        'pi',
        'low',
        0.8,
        0,
        1,
        JSON.stringify([{ type: 'reply_full' }]),
        JSON.stringify(['seed']),
        JSON.stringify([]),
        sampleMs
      );
      db.prepare(
        `INSERT INTO action_executions (
          id, action_decision_id, action_type, status,
          error_code, error_message, audit_level, audit_entry, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'exec-admin-digest-failed',
        'decision-admin-digest-seed',
        'reply_full',
        'failed',
        'SEEDED_FAILURE',
        secretLikeToken,
        'summary',
        'seeded failed action',
        sampleMs
      );
      db.prepare(
        `INSERT INTO action_executions (
          id, action_decision_id, action_type, status,
          error_code, error_message, audit_level, audit_entry, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'exec-admin-digest-rejected',
        'decision-admin-digest-seed',
        'dm_user',
        'rejected',
        'SEEDED_REJECTION',
        secretLikeToken,
        'summary',
        'seeded rejected action',
        sampleMs
      );
      db.prepare(
        `INSERT INTO tool_calls (
          id, turn_id, tool_name, input, output,
          requested_by, actor_class, invocation_context,
          status, error_code, error_message, secrets_redacted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'tool-admin-digest-error',
        'turn-admin-digest-seed',
        'seeded_tool',
        JSON.stringify({ token: secretLikeToken }),
        JSON.stringify({ output: secretLikeToken }),
        'pi',
        'system_worker',
        'background_worker',
        'error',
        'SEEDED_TOOL_ERROR',
        secretLikeToken,
        0,
        sampleMs
      );
      db.prepare(
        `INSERT INTO jobs (
          id, type, payload, status, attempts, max_attempts,
          created_at, updated_at, scheduled_at, started_at, completed_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'job-admin-digest-failed',
        'summary',
        JSON.stringify({ token: secretLikeToken }),
        'failed',
        3,
        3,
        sampleMs,
        sampleMs,
        sampleMs,
        sampleMs,
        sampleMs,
        secretLikeToken
      );
      db.prepare(
        `INSERT INTO audit_log (
          id, timestamp, category, level, event_type, event_id,
          actor_class, invocation_context, summary, details, redacted, risk_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'audit-admin-digest-high-risk',
        sampleMs,
        'tool',
        'full',
        'seeded.high_risk',
        'tool-admin-digest-error',
        'system_worker',
        'background_worker',
        secretLikeToken,
        JSON.stringify({ token: secretLikeToken }),
        0,
        'high'
      );

      const taskId = app.enqueueBackgroundTaskForTesting({
        type: 'admin_digest',
        payload: {
          sinceMs,
          nowMs: untilMs,
          limit: 10,
        },
        idempotencyKey: 'test:admin_digest:2030-01-02',
        maxAttempts: 2,
      });
      const duplicateTaskId = app.enqueueBackgroundTaskForTesting({
        type: 'admin_digest',
        payload: {
          sinceMs,
          nowMs: untilMs,
          limit: 10,
        },
        idempotencyKey: 'test:admin_digest:2030-01-02',
      });
      expect(duplicateTaskId).toBe(taskId);

      const result = await app.processNextBackgroundJobForTesting();
      expect(result?.taskId).toBe(taskId);
      expect(result?.status).toBe('completed');
      expect(result?.output).toMatchObject({
        hasIssues: true,
        redacted: true,
        counts: {
          failedJobs: 1,
          failedActionExecutions: 1,
          rejectedActionExecutions: 1,
          failedToolCalls: 1,
          rejectedToolCalls: 0,
          highRiskAuditEvents: 1,
        },
      });

      const job = db.prepare('SELECT status, attempts, result FROM jobs WHERE id = ?').get(taskId) as {
        status: string;
        attempts: number;
        result: string;
      };
      const attempts = db
        .prepare('SELECT status, worker_id, result FROM job_attempts WHERE job_id = ?')
        .all(taskId) as Array<{ status: string; worker_id: string; result: string }>;
      const audit = db
        .prepare(
          `SELECT level, event_id, details, redacted, risk_level
           FROM audit_log
           WHERE event_type = 'admin_digest.generated'
             AND event_id = ?`
        )
        .get(taskId) as {
          level: string;
          event_id: string;
          details: string;
          redacted: number;
          risk_level: string;
        };
      const auditDetails = JSON.parse(audit.details) as {
        counts: {
          failedJobs: number;
          failedActionExecutions: number;
          rejectedActionExecutions: number;
          failedToolCalls: number;
          rejectedToolCalls: number;
          highRiskAuditEvents: number;
        };
        samples: {
          failedJobs: Array<{ id: string; type: string }>;
          actionExecutions: Array<{ id: string; actionType: string; status: string }>;
          toolCalls: Array<{ id: string; toolName: string; status: string }>;
          highRiskAuditEvents: Array<{ id: string; eventType: string }>;
        };
      };

      expect(job.status).toBe('completed');
      expect(job.attempts).toBe(1);
      expect(JSON.parse(job.result)).toMatchObject({ hasIssues: true, redacted: true });
      expect(attempts).toEqual([
        expect.objectContaining({
          status: 'completed',
          worker_id: 'lethebot-background-main',
        }),
      ]);
      expect(audit).toMatchObject({
        level: 'redacted_full',
        event_id: taskId,
        redacted: 1,
        risk_level: 'high',
      });
      expect(auditDetails.counts).toMatchObject({
        failedJobs: 1,
        failedActionExecutions: 1,
        rejectedActionExecutions: 1,
        failedToolCalls: 1,
        rejectedToolCalls: 0,
        highRiskAuditEvents: 1,
      });
      expect(auditDetails.samples.failedJobs).toEqual([
        expect.objectContaining({ id: 'job-admin-digest-failed', type: 'summary' }),
      ]);
      expect(auditDetails.samples.actionExecutions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'exec-admin-digest-failed', actionType: 'reply_full', status: 'failed' }),
          expect.objectContaining({ id: 'exec-admin-digest-rejected', actionType: 'dm_user', status: 'rejected' }),
        ])
      );
      expect(auditDetails.samples.toolCalls).toEqual([
        expect.objectContaining({ id: 'tool-admin-digest-error', toolName: 'seeded_tool', status: 'error' }),
      ]);
      expect(auditDetails.samples.highRiskAuditEvents).toEqual([
        expect.objectContaining({ id: 'audit-admin-digest-high-risk', eventType: 'seeded.high_risk' }),
      ]);
      expect(JSON.stringify({ result, job, attempts, audit })).not.toContain(secretLikeToken);
      expectNoForeignKeyViolations();
    });

    it('should process memory conflict jobs without automatically mutating active memories', async () => {
      const db = app.getDatabase();
      const untilMs = Date.UTC(2030, 0, 3);
      const sinceMs = untilMs - 24 * 60 * 60 * 1000;
      const sampleMs = untilMs - 1_000;

      db.prepare(
        `INSERT INTO canonical_users (id, created_at, last_seen_at)
         VALUES (?, ?, ?)`
      ).run('user-conflict-durable', sampleMs, sampleMs);
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'evt-memory-conflict-a',
        'chat.message.received',
        sampleMs,
        'gateway',
        'qq',
        'private:memory-conflict',
        '{}',
        sampleMs
      );
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'evt-memory-conflict-b',
        'chat.message.received',
        sampleMs,
        'gateway',
        'qq',
        'private:memory-conflict',
        '{}',
        sampleMs
      );

      const memoryInsert = db.prepare(
        `INSERT INTO memory_records (
          id, scope, canonical_user_id,
          visibility, sensitivity, authority,
          kind, title, content, state,
          confidence, importance, source_context,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      memoryInsert.run(
        'mem-conflict-a',
        'user',
        'user-conflict-durable',
        'same_user_any_context',
        'normal',
        'user_stated',
        'preference',
        '回复风格',
        'prefers short replies',
        'active',
        0.9,
        0.7,
        'chat:evt-memory-conflict-a',
        sampleMs,
        sampleMs
      );
      memoryInsert.run(
        'mem-conflict-b',
        'user',
        'user-conflict-durable',
        'same_user_any_context',
        'normal',
        'user_stated',
        'preference',
        ' 回复风格 ',
        'prefers detailed replies',
        'active',
        0.9,
        0.7,
        'chat:evt-memory-conflict-b',
        sampleMs,
        sampleMs
      );

      db.prepare(
        `INSERT INTO memory_sources (
          memory_id, source_type, source_id, source_timestamp, extracted_by
        ) VALUES (?, ?, ?, ?, ?)`
      ).run('mem-conflict-a', 'raw_event', 'evt-memory-conflict-a', sampleMs, 'worker');
      db.prepare(
        `INSERT INTO memory_sources (
          memory_id, source_type, source_id, source_timestamp, extracted_by
        ) VALUES (?, ?, ?, ?, ?)`
      ).run('mem-conflict-b', 'raw_event', 'evt-memory-conflict-b', sampleMs, 'worker');
      db.prepare(
        `INSERT INTO memory_revisions (
          id, memory_id, revision_number, change_type,
          previous_state, new_state, reason, actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'rev-conflict-a',
        'mem-conflict-a',
        1,
        'create',
        null,
        JSON.stringify({ state: 'active' }),
        'seed conflict memory A',
        'system_worker',
        sampleMs
      );
      db.prepare(
        `INSERT INTO memory_revisions (
          id, memory_id, revision_number, change_type,
          previous_state, new_state, reason, actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'rev-conflict-b',
        'mem-conflict-b',
        1,
        'create',
        null,
        JSON.stringify({ state: 'active' }),
        'seed conflict memory B',
        'system_worker',
        sampleMs
      );

      const taskId = app.enqueueBackgroundTaskForTesting({
        type: 'conflict',
        payload: {
          sinceMs,
          nowMs: untilMs,
          limit: 10,
        },
        idempotencyKey: 'test:memory_conflict:2030-01-03',
        maxAttempts: 2,
      });
      const duplicateTaskId = app.enqueueBackgroundTaskForTesting({
        type: 'conflict',
        payload: {
          sinceMs,
          nowMs: untilMs,
          limit: 10,
        },
        idempotencyKey: 'test:memory_conflict:2030-01-03',
      });
      expect(duplicateTaskId).toBe(taskId);

      const result = await app.processNextBackgroundJobForTesting();
      expect(result?.taskId).toBe(taskId);
      expect(result?.status).toBe('completed');
      expect(result?.output).toMatchObject({
        conflictCount: 1,
        sampledConflictCount: 1,
        redacted: true,
        conflicts: [
          {
            memoryIds: ['mem-conflict-a', 'mem-conflict-b'],
            scope: 'user',
            canonicalUserId: 'user-conflict-durable',
            kind: 'preference',
          },
        ],
      });

      const job = db.prepare('SELECT status, attempts, result FROM jobs WHERE id = ?').get(taskId) as {
        status: string;
        attempts: number;
        result: string;
      };
      const attempts = db
        .prepare('SELECT status, worker_id, result FROM job_attempts WHERE job_id = ?')
        .all(taskId) as Array<{ status: string; worker_id: string; result: string }>;
      const audit = db
        .prepare(
          `SELECT level, event_id, details, redacted, risk_level
           FROM audit_log
           WHERE event_type = 'memory.conflict.detected'
             AND event_id = ?`
        )
        .get(taskId) as {
          level: string;
          event_id: string;
          details: string;
          redacted: number;
          risk_level: string;
        };
      const states = db
        .prepare('SELECT id, state FROM memory_records WHERE id IN (?, ?) ORDER BY id ASC')
        .all('mem-conflict-a', 'mem-conflict-b') as Array<{ id: string; state: string }>;
      const revisionCounts = db
        .prepare(
          `SELECT memory_id, COUNT(*) AS count
           FROM memory_revisions
           WHERE memory_id IN (?, ?)
           GROUP BY memory_id
           ORDER BY memory_id ASC`
        )
        .all('mem-conflict-a', 'mem-conflict-b') as Array<{ memory_id: string; count: number }>;
      const auditDetails = JSON.parse(audit.details) as {
        conflictCount: number;
        sampledConflictCount: number;
        conflicts: Array<{ memoryIds: [string, string]; titleHash: string }>;
      };

      expect(job.status).toBe('completed');
      expect(job.attempts).toBe(1);
      expect(JSON.parse(job.result)).toMatchObject({ conflictCount: 1, redacted: true });
      expect(attempts).toEqual([
        expect.objectContaining({
          status: 'completed',
          worker_id: 'lethebot-background-main',
        }),
      ]);
      expect(audit).toMatchObject({
        level: 'redacted_full',
        event_id: taskId,
        redacted: 1,
        risk_level: 'medium',
      });
      expect(auditDetails.conflictCount).toBe(1);
      expect(auditDetails.sampledConflictCount).toBe(1);
      expect(auditDetails.conflicts[0]?.memoryIds).toEqual(['mem-conflict-a', 'mem-conflict-b']);
      expect(auditDetails.conflicts[0]?.titleHash).toHaveLength(64);
      expect(states).toEqual([
        { id: 'mem-conflict-a', state: 'active' },
        { id: 'mem-conflict-b', state: 'active' },
      ]);
      expect(revisionCounts).toEqual([
        { memory_id: 'mem-conflict-a', count: 1 },
        { memory_id: 'mem-conflict-b', count: 1 },
      ]);
      expect(JSON.stringify({ result, job, attempts, audit })).not.toContain('prefers short replies');
      expect(JSON.stringify({ result, job, attempts, audit })).not.toContain('prefers detailed replies');
      expectNoForeignKeyViolations();
    });

    it('should process memory decay jobs as redacted non-destructive review scans', async () => {
      const db = app.getDatabase();
      const untilMs = Date.UTC(2030, 0, 4);
      const staleBeforeMs = untilMs - 180 * 24 * 60 * 60 * 1000;
      const oldMs = staleBeforeMs - 1_000;
      const secretMemoryContent = 'secret decay candidate should not leak';
      const candidateContent = 'decay me after review';

      db.prepare(
        `INSERT INTO canonical_users (id, created_at, last_seen_at)
         VALUES (?, ?, ?)`
      ).run('user-decay-durable', oldMs, oldMs);
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'evt-memory-decay-seed',
        'chat.message.received',
        oldMs,
        'gateway',
        'qq',
        'private:memory-decay',
        '{}',
        oldMs
      );

      const memoryInsert = db.prepare(
        `INSERT INTO memory_records (
          id, scope, canonical_user_id,
          visibility, sensitivity, authority,
          kind, title, content, state,
          confidence, importance, source_context,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      memoryInsert.run(
        'mem-decay-candidate',
        'user',
        'user-decay-durable',
        'same_user_any_context',
        'normal',
        'inferred',
        'fact',
        '低置信旧事实',
        candidateContent,
        'active',
        0.4,
        0.2,
        'chat:evt-memory-decay-seed',
        oldMs,
        oldMs
      );
      memoryInsert.run(
        'mem-decay-strong',
        'user',
        'user-decay-durable',
        'same_user_any_context',
        'normal',
        'user_stated',
        'fact',
        '高置信旧事实',
        'old but strong',
        'active',
        0.9,
        0.8,
        'chat:evt-memory-decay-seed',
        oldMs,
        oldMs
      );
      memoryInsert.run(
        'mem-decay-secret',
        'user',
        'user-decay-durable',
        'same_user_any_context',
        'secret',
        'user_stated',
        'fact',
        '秘密旧事实',
        secretMemoryContent,
        'active',
        0.1,
        0.1,
        'chat:evt-memory-decay-seed',
        oldMs,
        oldMs
      );
      memoryInsert.run(
        'mem-decay-disabled',
        'user',
        'user-decay-durable',
        'same_user_any_context',
        'normal',
        'inferred',
        'fact',
        '禁用旧事实',
        'disabled old low score',
        'disabled',
        0.1,
        0.1,
        'chat:evt-memory-decay-seed',
        oldMs,
        oldMs
      );

      const sourceInsert = db.prepare(
        `INSERT INTO memory_sources (
          memory_id, source_type, source_id, source_timestamp, extracted_by
        ) VALUES (?, ?, ?, ?, ?)`
      );
      const revisionInsert = db.prepare(
        `INSERT INTO memory_revisions (
          id, memory_id, revision_number, change_type,
          previous_state, new_state, reason, actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const memoryId of ['mem-decay-candidate', 'mem-decay-strong', 'mem-decay-secret', 'mem-decay-disabled']) {
        sourceInsert.run(memoryId, 'raw_event', 'evt-memory-decay-seed', oldMs, 'worker');
        revisionInsert.run(
          `rev-${memoryId}`,
          memoryId,
          1,
          'create',
          null,
          JSON.stringify({ state: memoryId === 'mem-decay-disabled' ? 'disabled' : 'active' }),
          'seed decay memory',
          'system_worker',
          oldMs
        );
      }

      const taskId = app.enqueueBackgroundTaskForTesting({
        type: 'decay',
        payload: {
          nowMs: untilMs,
          staleBeforeMs,
          maxConfidence: 0.5,
          maxImportance: 0.3,
          canonicalUserId: 'user-decay-durable',
          limit: 10,
        },
        idempotencyKey: 'test:memory_decay:2030-01-04',
        maxAttempts: 2,
      });
      const duplicateTaskId = app.enqueueBackgroundTaskForTesting({
        type: 'decay',
        payload: {
          nowMs: untilMs,
          staleBeforeMs,
          maxConfidence: 0.5,
          maxImportance: 0.3,
          canonicalUserId: 'user-decay-durable',
          limit: 10,
        },
        idempotencyKey: 'test:memory_decay:2030-01-04',
      });
      expect(duplicateTaskId).toBe(taskId);

      const result = await app.processNextBackgroundJobForTesting();
      expect(result?.taskId).toBe(taskId);
      expect(result?.status).toBe('completed');
      expect(result?.output).toMatchObject({
        staleBeforeMs,
        candidateCount: 1,
        sampledCandidateCount: 1,
        redacted: true,
        thresholds: {
          maxConfidence: 0.5,
          maxImportance: 0.3,
        },
        filters: {
          canonicalUserId: 'user-decay-durable',
        },
        candidates: [
          {
            memoryId: 'mem-decay-candidate',
            scope: 'user',
            canonicalUserId: 'user-decay-durable',
            kind: 'fact',
            confidence: 0.4,
            importance: 0.2,
            updatedAt: oldMs,
            reasons: ['stale', 'low_confidence', 'low_importance'],
          },
        ],
      });

      const job = db.prepare('SELECT status, attempts, result FROM jobs WHERE id = ?').get(taskId) as {
        status: string;
        attempts: number;
        result: string;
      };
      const attempts = db
        .prepare('SELECT status, worker_id, result FROM job_attempts WHERE job_id = ?')
        .all(taskId) as Array<{ status: string; worker_id: string; result: string }>;
      const audit = db
        .prepare(
          `SELECT level, event_id, details, redacted, risk_level
           FROM audit_log
           WHERE event_type = 'memory.decay.candidates_detected'
             AND event_id = ?`
        )
        .get(taskId) as {
          level: string;
          event_id: string;
          details: string;
          redacted: number;
          risk_level: string;
        };
      const candidate = db
        .prepare('SELECT state, confidence, importance FROM memory_records WHERE id = ?')
        .get('mem-decay-candidate') as { state: string; confidence: number; importance: number };
      const ignoredRows = db
        .prepare('SELECT id, state FROM memory_records WHERE id IN (?, ?, ?) ORDER BY id ASC')
        .all('mem-decay-disabled', 'mem-decay-secret', 'mem-decay-strong') as Array<{ id: string; state: string }>;
      const revisionCount = (
        db.prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?').get('mem-decay-candidate') as {
          count: number;
        }
      ).count;
      const auditDetails = JSON.parse(audit.details) as {
        candidateCount: number;
        sampledCandidateCount: number;
        candidates: Array<{ memoryId: string; titleHash: string; reasons: string[] }>;
      };

      expect(job.status).toBe('completed');
      expect(job.attempts).toBe(1);
      expect(JSON.parse(job.result)).toMatchObject({ candidateCount: 1, redacted: true });
      expect(attempts).toEqual([
        expect.objectContaining({
          status: 'completed',
          worker_id: 'lethebot-background-main',
        }),
      ]);
      expect(audit).toMatchObject({
        level: 'redacted_full',
        event_id: taskId,
        redacted: 1,
        risk_level: 'medium',
      });
      expect(auditDetails.candidateCount).toBe(1);
      expect(auditDetails.sampledCandidateCount).toBe(1);
      expect(auditDetails.candidates).toEqual([
        expect.objectContaining({
          memoryId: 'mem-decay-candidate',
          reasons: ['stale', 'low_confidence', 'low_importance'],
        }),
      ]);
      expect(auditDetails.candidates[0]?.titleHash).toHaveLength(64);
      expect(candidate).toEqual({
        state: 'active',
        confidence: 0.4,
        importance: 0.2,
      });
      expect(ignoredRows).toEqual([
        { id: 'mem-decay-disabled', state: 'disabled' },
        { id: 'mem-decay-secret', state: 'active' },
        { id: 'mem-decay-strong', state: 'active' },
      ]);
      expect(revisionCount).toBe(1);
      expect(JSON.stringify({ result, job, attempts, audit })).not.toContain(candidateContent);
      expect(JSON.stringify({ result, job, attempts, audit })).not.toContain(secretMemoryContent);
      expectNoForeignKeyViolations();
    });

    it('should process memory consolidation jobs as redacted non-destructive duplicate grouping scans', async () => {
      const db = app.getDatabase();
      const untilMs = Date.UTC(2030, 0, 5);
      const sampleMs = untilMs - 1_000;
      const duplicateContent = 'duplicate memory content should not leak';
      const differentContent = 'different memory content should not be grouped';
      const secretDuplicateContent = 'secret duplicate memory should not leak';

      db.prepare(
        `INSERT INTO canonical_users (id, created_at, last_seen_at)
         VALUES (?, ?, ?)`
      ).run('user-consolidation-durable', sampleMs, sampleMs);
      db.prepare(
        `INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'evt-memory-consolidation-seed',
        'chat.message.received',
        sampleMs,
        'gateway',
        'qq',
        'private:memory-consolidation',
        '{}',
        sampleMs
      );

      const memoryInsert = db.prepare(
        `INSERT INTO memory_records (
          id, scope, canonical_user_id,
          visibility, sensitivity, authority,
          kind, title, content, state,
          confidence, importance, source_context,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      memoryInsert.run(
        'mem-consolidate-a',
        'user',
        'user-consolidation-durable',
        'same_user_any_context',
        'normal',
        'inferred',
        'fact',
        '重复事实',
        duplicateContent,
        'active',
        0.8,
        0.6,
        'chat:evt-memory-consolidation-seed',
        sampleMs,
        sampleMs
      );
      memoryInsert.run(
        'mem-consolidate-b',
        'user',
        'user-consolidation-durable',
        'same_user_any_context',
        'normal',
        'inferred',
        'fact',
        ' 重复事实 ',
        duplicateContent,
        'active',
        0.7,
        0.5,
        'chat:evt-memory-consolidation-seed',
        sampleMs,
        sampleMs
      );
      memoryInsert.run(
        'mem-consolidate-different',
        'user',
        'user-consolidation-durable',
        'same_user_any_context',
        'normal',
        'inferred',
        'fact',
        '重复事实',
        differentContent,
        'active',
        0.7,
        0.5,
        'chat:evt-memory-consolidation-seed',
        sampleMs,
        sampleMs
      );
      memoryInsert.run(
        'mem-consolidate-secret',
        'user',
        'user-consolidation-durable',
        'same_user_any_context',
        'secret',
        'inferred',
        'fact',
        '重复事实',
        secretDuplicateContent,
        'active',
        0.7,
        0.5,
        'chat:evt-memory-consolidation-seed',
        sampleMs,
        sampleMs
      );
      memoryInsert.run(
        'mem-consolidate-disabled',
        'user',
        'user-consolidation-durable',
        'same_user_any_context',
        'normal',
        'inferred',
        'fact',
        '重复事实',
        duplicateContent,
        'disabled',
        0.7,
        0.5,
        'chat:evt-memory-consolidation-seed',
        sampleMs,
        sampleMs
      );

      const sourceInsert = db.prepare(
        `INSERT INTO memory_sources (
          memory_id, source_type, source_id, source_timestamp, extracted_by
        ) VALUES (?, ?, ?, ?, ?)`
      );
      const revisionInsert = db.prepare(
        `INSERT INTO memory_revisions (
          id, memory_id, revision_number, change_type,
          previous_state, new_state, reason, actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const memoryId of [
        'mem-consolidate-a',
        'mem-consolidate-b',
        'mem-consolidate-different',
        'mem-consolidate-secret',
        'mem-consolidate-disabled',
      ]) {
        sourceInsert.run(memoryId, 'raw_event', 'evt-memory-consolidation-seed', sampleMs, 'worker');
        revisionInsert.run(
          `rev-${memoryId}`,
          memoryId,
          1,
          'create',
          null,
          JSON.stringify({ state: memoryId === 'mem-consolidate-disabled' ? 'disabled' : 'active' }),
          'seed consolidation memory',
          'system_worker',
          sampleMs
        );
      }

      const taskId = app.enqueueBackgroundTaskForTesting({
        type: 'consolidation',
        payload: {
          nowMs: untilMs,
          minGroupSize: 2,
          canonicalUserId: 'user-consolidation-durable',
          limit: 10,
        },
        idempotencyKey: 'test:memory_consolidation:2030-01-05',
        maxAttempts: 2,
      });
      const duplicateTaskId = app.enqueueBackgroundTaskForTesting({
        type: 'consolidation',
        payload: {
          nowMs: untilMs,
          minGroupSize: 2,
          canonicalUserId: 'user-consolidation-durable',
          limit: 10,
        },
        idempotencyKey: 'test:memory_consolidation:2030-01-05',
      });
      expect(duplicateTaskId).toBe(taskId);

      const result = await app.processNextBackgroundJobForTesting();
      expect(result?.taskId).toBe(taskId);
      expect(result?.status).toBe('completed');
      expect(result?.output).toMatchObject({
        groupCount: 1,
        sampledGroupCount: 1,
        redacted: true,
        minGroupSize: 2,
        filters: {
          canonicalUserId: 'user-consolidation-durable',
        },
        groups: [
          {
            scope: 'user',
            canonicalUserId: 'user-consolidation-durable',
            kind: 'fact',
            groupSize: 2,
            updatedAt: sampleMs,
          },
        ],
      });

      const output = result?.output as
        | { groups: Array<{ memoryIds: string[]; titleHash: string; contentHash: string }> }
        | undefined;
      expect(output?.groups[0]?.memoryIds).toEqual(
        expect.arrayContaining(['mem-consolidate-a', 'mem-consolidate-b'])
      );
      expect(output?.groups[0]?.memoryIds).toHaveLength(2);
      expect(output?.groups[0]?.titleHash).toHaveLength(64);
      expect(output?.groups[0]?.contentHash).toHaveLength(64);

      const job = db.prepare('SELECT status, attempts, result FROM jobs WHERE id = ?').get(taskId) as {
        status: string;
        attempts: number;
        result: string;
      };
      const attempts = db
        .prepare('SELECT status, worker_id, result FROM job_attempts WHERE job_id = ?')
        .all(taskId) as Array<{ status: string; worker_id: string; result: string }>;
      const audit = db
        .prepare(
          `SELECT level, event_id, details, redacted, risk_level
           FROM audit_log
           WHERE event_type = 'memory.consolidation.candidates_detected'
             AND event_id = ?`
        )
        .get(taskId) as {
          level: string;
          event_id: string;
          details: string;
          redacted: number;
          risk_level: string;
        };
      const states = db
        .prepare('SELECT id, state FROM memory_records WHERE id IN (?, ?, ?) ORDER BY id ASC')
        .all('mem-consolidate-a', 'mem-consolidate-b', 'mem-consolidate-different') as Array<{
          id: string;
          state: string;
        }>;
      const revisionCounts = db
        .prepare(
          `SELECT memory_id, COUNT(*) AS count
           FROM memory_revisions
           WHERE memory_id IN (?, ?, ?)
           GROUP BY memory_id
           ORDER BY memory_id ASC`
        )
        .all('mem-consolidate-a', 'mem-consolidate-b', 'mem-consolidate-different') as Array<{
          memory_id: string;
          count: number;
        }>;
      const auditDetails = JSON.parse(audit.details) as {
        groupCount: number;
        sampledGroupCount: number;
        groups: Array<{ memoryIds: string[]; titleHash: string; contentHash: string; groupSize: number }>;
      };

      expect(job.status).toBe('completed');
      expect(job.attempts).toBe(1);
      expect(JSON.parse(job.result)).toMatchObject({ groupCount: 1, redacted: true });
      expect(attempts).toEqual([
        expect.objectContaining({
          status: 'completed',
          worker_id: 'lethebot-background-main',
        }),
      ]);
      expect(audit).toMatchObject({
        level: 'redacted_full',
        event_id: taskId,
        redacted: 1,
        risk_level: 'medium',
      });
      expect(auditDetails.groupCount).toBe(1);
      expect(auditDetails.sampledGroupCount).toBe(1);
      expect(auditDetails.groups[0]?.memoryIds).toEqual(
        expect.arrayContaining(['mem-consolidate-a', 'mem-consolidate-b'])
      );
      expect(auditDetails.groups[0]?.memoryIds).toHaveLength(2);
      expect(auditDetails.groups[0]?.titleHash).toHaveLength(64);
      expect(auditDetails.groups[0]?.contentHash).toHaveLength(64);
      expect(auditDetails.groups[0]?.groupSize).toBe(2);
      expect(states).toEqual([
        { id: 'mem-consolidate-a', state: 'active' },
        { id: 'mem-consolidate-b', state: 'active' },
        { id: 'mem-consolidate-different', state: 'active' },
      ]);
      expect(revisionCounts).toEqual([
        { memory_id: 'mem-consolidate-a', count: 1 },
        { memory_id: 'mem-consolidate-b', count: 1 },
        { memory_id: 'mem-consolidate-different', count: 1 },
      ]);
      expect(JSON.stringify({ result, job, attempts, audit })).not.toContain(duplicateContent);
      expect(JSON.stringify({ result, job, attempts, audit })).not.toContain(differentContent);
      expect(JSON.stringify({ result, job, attempts, audit })).not.toContain(secretDuplicateContent);
      expectNoForeignKeyViolations();
    });
  });

  describe('Error handling', () => {
    it('should reject malformed JSON without chat-path side effects or secret echo', async () => {
      let piCalls = 0;
      const sentMessages: SentMessage[] = [];
      const rawSecret = 'sk-invalid-json-secret-should-not-echo';
      const rawPlatformId = 'qq-8123456790';
      const beforeCounts = {
        rawEvents: countTableRows('raw_events'),
        chatMessages: countTableRows('chat_messages'),
        agentTurns: countTableRows('agent_turns'),
        contextTraces: countTableRows('context_traces'),
        actionDecisions: countTableRows('action_decisions'),
        actionExecutions: countTableRows('action_executions'),
      };
      app.setPiRuntimeForTesting({
        async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
          piCalls += 1;
          return {
            turnId: input.turnId,
            responseText: 'invalid JSON should not reach Pi',
            toolCallIds: [],
            events: [],
            tokensUsed: { input: 1, output: 1, total: 2 },
            status: 'completed',
          };
        },
      });
      setCapturingMessageSender(sentMessages);

      const response = await fetch(`${baseUrl}/onebot/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-onebot-token',
        },
        body: `{"post_type":"message","message_type":"private","user_id":"${rawPlatformId}","message":"token=${rawSecret}"`,
      });

      try {
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data).toEqual({ error: 'Invalid JSON' });
        expect(JSON.stringify(data)).not.toContain(rawSecret);
        expect(JSON.stringify(data)).not.toContain(rawPlatformId);

        expect(piCalls).toBe(0);
        expect(sentMessages).toEqual([]);
        expect({
          rawEvents: countTableRows('raw_events'),
          chatMessages: countTableRows('chat_messages'),
          agentTurns: countTableRows('agent_turns'),
          contextTraces: countTableRows('context_traces'),
          actionDecisions: countTableRows('action_decisions'),
          actionExecutions: countTableRows('action_executions'),
        }).toEqual(beforeCounts);
        expect(app.getEventProcessingFailures()).toHaveLength(0);
        expectNoForeignKeyViolations();

        const leakedRows = app
          .getDatabase()
          .prepare('SELECT COUNT(*) AS count FROM raw_events WHERE payload LIKE ? OR conversation_id LIKE ?')
          .get(`%${rawSecret}%`, `%${rawPlatformId}%`) as { count: number };
        expect(leakedRows.count).toBe(0);
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should reject event POST without configured bearer token', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 81234,
        user_id: 81234,
        message: '未授权消息',
        raw_message: '未授权消息',
        sender: {
          user_id: 81234,
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent, null);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Unauthorized');
      expect(getPersistedMessage('qq-81234')).toBeUndefined();
    });

    it('should return 404 for unknown endpoints', async () => {
      const response = await fetch(`${baseUrl}/unknown`);
      expect(response.status).toBe(404);
    });

    it('should reject non-POST requests to event endpoint', async () => {
      const response = await fetch(`${baseUrl}/onebot/event`, {
        method: 'GET',
      });
      expect(response.status).toBe(404);
    });
  });

  describe('Message content variations', () => {
    it('should handle empty message', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 12347,
        user_id: 10003,
        message: '',
        raw_message: '',
        sender: {
          user_id: 10003,
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
    });

    it('should handle long message', async () => {
      const longText = 'a'.repeat(5000);
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 12348,
        user_id: 10004,
        message: longText,
        raw_message: longText,
        sender: {
          user_id: 10004,
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
    });

    it('should handle message with special characters', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 12349,
        user_id: 10005,
        message: '特殊字符测试 🎉 @#$%^&* \n\t\r',
        raw_message: '特殊字符测试 🎉 @#$%^&* \n\t\r',
        sender: {
          user_id: 10005,
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
    });

    it('should persist quote and media flags without storing CQ tags as message text', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 12350,
        user_id: 10006,
        message: '[CQ:reply,id=12349][CQ:image,url=https://example.test/image.png] 看图',
        raw_message: '[CQ:reply,id=12349][CQ:image,url=https://example.test/image.png] 看图',
        sender: {
          user_id: 10006,
          nickname: 'MediaUser',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);

      const persisted = getPersistedMessage('qq-12350');
      expect(persisted).toBeDefined();
      expect(persisted?.text).toBe('看图');
      expect(persisted?.has_quote).toBe(1);
      expect(persisted?.has_media).toBe(1);
      expect(persisted?.reply_to_message_id).toBe('qq-12349');
      expectNoForeignKeyViolations();
    });
  });

  describe('Concurrent requests', () => {
    it('should resolve concurrent first events from one account to one canonical user', async () => {
      const db = app.getDatabase();
      const canonicalUsersBefore = db.prepare(
        'SELECT COUNT(*) AS count FROM canonical_users'
      ).get() as { count: number };
      const platformAccountId = 923450101;
      const requests = Array.from({ length: 5 }, (_, index) => sendEvent({
        post_type: 'message',
        message_type: 'private',
        message_id: 923450001 + index,
        user_id: platformAccountId,
        message: `Concurrent same-account message ${index}`,
        raw_message: `Concurrent same-account message ${index}`,
        sender: {
          user_id: platformAccountId,
          nickname: 'ConcurrentIdentity',
        },
        time: Math.floor(Date.now() / 1000),
      } satisfies OneBotMessage));

      const responses = await Promise.all(requests);
      await app.waitForIdle();

      for (const response of responses) {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });
      }

      const mapping = db.prepare(
        `SELECT canonical_user_id, status
         FROM platform_accounts
         WHERE platform = 'qq' AND platform_account_id = ?`
      ).get(String(platformAccountId)) as {
        canonical_user_id: string;
        status: string;
      } | undefined;
      const canonicalUsersAfter = db.prepare(
        'SELECT COUNT(*) AS count FROM canonical_users'
      ).get() as { count: number };

      expect(mapping).toMatchObject({ status: 'active' });
      expect(canonicalUsersAfter.count).toBe(canonicalUsersBefore.count + 1);
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM canonical_users WHERE id = ?')
          .get(mapping?.canonical_user_id)
      ).toEqual({ count: 1 });
      expectNoForeignKeyViolations();
    });

    it('should handle multiple concurrent requests', async () => {
      const requests = Array.from({ length: 5 }, (_, i) => {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 90000 + i,
          user_id: 90000 + i,
          message: `Concurrent message ${i}`,
          raw_message: `Concurrent message ${i}`,
          sender: {
            user_id: 90000 + i,
          },
          time: Math.floor(Date.now() / 1000),
        };

        return fetch(`${baseUrl}/onebot/event`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-onebot-token',
          },
          body: JSON.stringify(onebotEvent),
        });
      });

      const responses = await Promise.all(requests);
      await app.waitForIdle();

      for (const response of responses) {
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('ok');
      }

      expectNoForeignKeyViolations();
    });
  });
});

describe('Readiness degraded database path', () => {
  it('should return non-leaking readiness and metrics errors when the database is closed', async () => {
    const previousEnv = process.env;
    const testDir = mkdtempSync(join(tmpdir(), 'lethebot-readyz-db-degraded-'));
    const testPort = 17900 + Math.floor(Math.random() * 1000);
    let isolatedApp: LetheBotApp | undefined;

    process.env = { ...previousEnv };
    resetConfig();
    process.env.LETHEBOT_TEST = 'true';
    process.env.LETHEBOT_PORT = testPort.toString();
    process.env.LETHEBOT_DB_PATH = join(testDir, 'lethebot-readyz-db-degraded.db');
    process.env.ONEBOT_TRANSPORT = 'http';
    process.env.ONEBOT_HTTP_URL = 'http://localhost:3000/onebot?api_key=sk-db-metrics-http-url-secret-should-not-leak';
    process.env.ONEBOT_WS_URL = 'ws://localhost:3001/onebot?token=db-metrics-ws-token-should-not-leak-123456';
    process.env.ONEBOT_TOKEN = 'db-ready-token-should-not-leak';
    process.env.LETHEBOT_BOT_QQ_ID = '3889000770';
    process.env.PI_PROVIDER = 'mock';
    process.env.PI_MODEL = 'mock';
    process.env.LOG_LEVEL = 'fatal';

    try {
      isolatedApp = new LetheBotApp();
      await isolatedApp.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      isolatedApp.getDatabase().close();

      const healthResponse = await fetch(`http://localhost:${testPort}/healthz`);
      expect(healthResponse.status).toBe(503);
      const health = await healthResponse.json() as {
        status: string;
        version: string;
        checks: {
          database: { ok: boolean; open: boolean; error?: string };
          adapter: {
            ready: boolean;
            mode: string;
            hasToken: boolean;
            botIdConfigured: boolean;
          };
          eventProcessing: { pending: number; failures: number };
        };
      };
      expect(health).toMatchObject({
        status: 'degraded',
        version: expect.any(String),
        checks: {
          database: { ok: false, open: false },
          adapter: {
            ready: true,
            mode: 'http',
            hasToken: true,
            botIdConfigured: true,
          },
          eventProcessing: { pending: 0, failures: 0 },
        },
      });

      const serializedHealth = JSON.stringify(health);
      expect(serializedHealth).not.toContain('db-ready-token-should-not-leak');
      expect(serializedHealth).not.toContain('localhost:3000');
      expect(serializedHealth).not.toContain('localhost:3001');
      expect(serializedHealth).not.toContain('sk-db-metrics-http-url-secret-should-not-leak');
      expect(serializedHealth).not.toContain('db-metrics-ws-token-should-not-leak-123456');
      expect(serializedHealth).not.toContain(testDir);
      expect(serializedHealth).not.toContain('lethebot-readyz-db-degraded.db');
      expect(serializedHealth).not.toContain('The database connection is not open');
      expect(serializedHealth).not.toContain('qq-');
      expect(serializedHealth).not.toContain('private:');
      expect(serializedHealth).not.toContain('lastError');

      const response = await fetch(`http://localhost:${testPort}/readyz`);
      expect(response.status).toBe(503);

      const readiness = await response.json() as {
        status: string;
        version: string;
        checks: {
          database: { ready: boolean; open: boolean };
          adapter: {
            ready: boolean;
            mode: string;
            hasToken: boolean;
            botIdConfigured: boolean;
          };
          eventProcessing: { pending: number };
        };
      };

      expect(readiness).toMatchObject({
        status: 'not_ready',
        version: expect.any(String),
        checks: {
          database: { ready: false, open: false },
          adapter: {
            ready: true,
            mode: 'http',
            hasToken: true,
            botIdConfigured: true,
          },
          eventProcessing: { pending: 0 },
        },
      });

      const serializedReadiness = JSON.stringify(readiness);
      expect(serializedReadiness).not.toContain('db-ready-token-should-not-leak');
      expect(serializedReadiness).not.toContain('localhost:3000');
      expect(serializedReadiness).not.toContain('localhost:3001');
      expect(serializedReadiness).not.toContain('sk-db-metrics-http-url-secret-should-not-leak');
      expect(serializedReadiness).not.toContain('db-metrics-ws-token-should-not-leak-123456');
      expect(serializedReadiness).not.toContain(testDir);
      expect(serializedReadiness).not.toContain('lethebot-readyz-db-degraded.db');
      expect(serializedReadiness).not.toContain('The database connection is not open');
      expect(serializedReadiness).not.toContain('qq-');
      expect(serializedReadiness).not.toContain('private:');

      const metricsResponse = await fetch(`http://localhost:${testPort}/metrics`);
      expect(metricsResponse.status).toBe(503);
      expect(metricsResponse.headers.get('content-type')).toContain('application/json');
      const metricsError = await metricsResponse.json() as { error: string };
      expect(metricsError).toEqual({ error: 'metrics_unavailable' });

      const metricsPrometheusResponse = await fetch(`http://localhost:${testPort}/metrics?format=prometheus`);
      expect(metricsPrometheusResponse.status).toBe(503);
      expect(metricsPrometheusResponse.headers.get('content-type')).toContain('application/json');
      const metricsPrometheusError = await metricsPrometheusResponse.json() as { error: string };
      expect(metricsPrometheusError).toEqual({ error: 'metrics_unavailable' });

      for (const payload of [metricsError, metricsPrometheusError]) {
        const serializedMetrics = JSON.stringify(payload);
        expect(serializedMetrics).not.toContain('db-ready-token-should-not-leak');
        expect(serializedMetrics).not.toContain('localhost:3000');
        expect(serializedMetrics).not.toContain('localhost:3001');
        expect(serializedMetrics).not.toContain('sk-db-metrics-http-url-secret-should-not-leak');
        expect(serializedMetrics).not.toContain('db-metrics-ws-token-should-not-leak-123456');
        expect(serializedMetrics).not.toContain(testDir);
        expect(serializedMetrics).not.toContain('lethebot-readyz-db-degraded.db');
        expect(serializedMetrics).not.toContain('The database connection is not open');
        expect(serializedMetrics).not.toContain('qq-');
        expect(serializedMetrics).not.toContain('private:');
      }
    } finally {
      if (isolatedApp) {
        await isolatedApp.stop();
      }
      rmSync(testDir, { recursive: true, force: true });
      process.env = previousEnv;
      resetConfig();
    }
  });
});
