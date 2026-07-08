import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LetheBotApp } from '../../src/index.js';
import { resetConfig } from '../../src/config/index.js';
import type { OneBotMessage } from '../../src/gateway/onebot-adapter.js';
import type { PiAdapterInput, PiAdapterOutput } from '../../src/pi/pi-adapter.js';
import { EvaluatorStub } from '../../src/evaluator/evaluator-stub.js';
import type { SocialEvaluationRequest, SocialEvaluationResult } from '../../src/types/evaluator.js';

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
    expect(app.getEventProcessingFailures()).toHaveLength(0);
  });

  async function postEvent(event: unknown, token: string | null = 'test-onebot-token'): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
    });

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

  describe('Private message flow', () => {
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
      expect(JSON.parse(contextTrace?.recent_message_ids ?? '[]')).toContain(persisted?.id);
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
        expect(JSON.parse(actionRows[0]?.actions ?? '[]')).toMatchObject([
          { type: 'reply_full', payload: { text: '收到，我会处理。' } },
        ]);

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
          message: '触发发送失败',
          raw_message: '触发发送失败',
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
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
      }
    });

    it('should persist evaluator downgrade decisions for social actions', async () => {
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
            decidedAt: new Date(),
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

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12354,
          user_id: 10010,
          message: '!请评估后回复',
          raw_message: '!请评估后回复',
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
        expect(actionRows[0]?.action_type).toBe('reply_short');
        expect(actionRows[0]?.status).toBe('success');
        expect(JSON.parse(actionRows[0]?.suppressors ?? '[]')).toContain(
          'evaluator_downgrade:reply_full->reply_short'
        );
        expectNoForeignKeyViolations();
      } finally {
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

      try {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 12355,
          user_id: 10011,
          message: '!高风险回复请求',
          raw_message: '!高风险回复请求',
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
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });
  });

  describe('Group message flow', () => {
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
      setReplyingPiRuntime('numeric segment at reply');
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
          group_id: '190913',
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
      setReplyingPiRuntime('第一条 bot 回复。');
      setCapturingMessageSender(sentMessages);

      try {
        const seedEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23560,
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

        app.clearCooldownsForTesting();
        setReplyingPiRuntime('回复引用也会触发。');

        const replyEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23561,
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

        const inboundReply = getPersistedMessage('qq-23561');
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

        const turn = getTurnForMessage('qq-23561');
        expect(turn).toMatchObject({
          conversation_id: 'qq-group-100001',
          trigger_event_id: inboundReply?.raw_event_id,
          pi_provider: 'mock',
          pi_model: 'mock',
          response_text: '回复引用也会触发。',
          status: 'completed',
        });

        const contextTrace = getContextTraceForMessage('qq-23561');
        expect(contextTrace).toMatchObject({
          turn_id: turn?.id,
          conversation_id: 'qq-group-100001',
          conversation_type: 'group',
        });

        const actionRows = getActionRowsForMessage('qq-23561');
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

        app.clearCooldownsForTesting();
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
          group_id: '190905',
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

    it('should not trigger group reply when quoting a stored bot message from another group', async () => {
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
          group_id: '190901',
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
          group_id: '190902',
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
          group_id: '190903',
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

    it('should invoke social evaluator for group risk path', async () => {
      const sentMessages: SentMessage[] = [];
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
        expect(actionRows[0]?.decided_by).toBe('evaluator');
        expect(actionRows[0]?.evaluator_required).toBe(1);
        expect(actionRows[0]?.evaluator_passed).toBe(1);
        expect(actionRows[0]?.action_type).toBe('reply_short');
        expect(actionRows[0]?.status).toBe('success');
        expect(JSON.parse(actionRows[0]?.reasons ?? '[]').join(' ')).toContain('evaluator:');
        expectNoForeignKeyViolations();
      } finally {
        setSuccessfulPiRuntime();
        restoreDecisionDefaults();
      }
    });

    it('should downgrade repeated group replies through cooldown suppressor', async () => {
      const sentMessages: SentMessage[] = [];
      setReplyingPiRuntime('冷却测试回复。');
      setCapturingMessageSender(sentMessages);

      try {
        const firstEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23463,
          user_id: 20007,
          group_id: 100004,
          message: '[CQ:at,qq=3889000770] 第一次回复',
          raw_message: '[CQ:at,qq=3889000770] 第一次回复',
          sender: {
            user_id: 20007,
            nickname: 'CooldownUser1',
          },
          time: Math.floor(Date.now() / 1000),
        };
        const secondEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'group',
          message_id: 23464,
          user_id: 20008,
          group_id: 100004,
          message: '[CQ:at,qq=3889000770] 第二次回复',
          raw_message: '[CQ:at,qq=3889000770] 第二次回复',
          sender: {
            user_id: 20008,
            nickname: 'CooldownUser2',
          },
          time: Math.floor(Date.now() / 1000),
        };

        expect((await postEvent(firstEvent)).status).toBe(200);
        expect((await postEvent(secondEvent)).status).toBe(200);

        expect(sentMessages).toHaveLength(1);

        const firstActions = getActionRowsForMessage('qq-23463');
        expect(firstActions).toHaveLength(1);
        expect(firstActions[0]?.action_type).toBe('reply_short');
        expect(firstActions[0]?.status).toBe('success');

        const secondActions = getActionRowsForMessage('qq-23464');
        expect(secondActions).toHaveLength(1);
        expect(secondActions[0]?.action_type).toBe('silent_store');
        expect(secondActions[0]?.status).toBe('success');
        expect(JSON.parse(secondActions[0]?.suppressors ?? '[]')).toContain(
          'cooldown:group:qq-group-100004:reply_short'
        );
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
    it('should process extraction jobs through durable job attempts and source-linked memory writes', async () => {
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

      const response = await postEvent(onebotEvent);
      expect(response.status).toBe(200);

      const persisted = getPersistedMessage('qq-34567');
      expect(persisted).toBeDefined();

      const identity = app
        .getDatabase()
        .prepare(
          `SELECT canonical_user_id
           FROM platform_accounts
           WHERE platform = 'qq' AND platform_account_id = ?`
        )
        .get('34567') as { canonical_user_id: string } | undefined;
      expect(identity?.canonical_user_id).toBeDefined();

      const taskId = app.enqueueBackgroundTaskForTesting({
        type: 'extraction',
        payload: {
          conversationId: persisted?.conversation_id ?? 'private:qq-34567',
          targetUserId: identity?.canonical_user_id,
          userMessage: '我喜欢 后台任务测试',
          botResponse: '我记下了。',
          messageId: persisted?.id,
          timestamp: Date.now(),
          conversationType: 'private',
        },
        idempotencyKey: 'test:extraction:qq-34567:background',
        maxAttempts: 2,
      });
      const duplicateTaskId = app.enqueueBackgroundTaskForTesting({
        type: 'extraction',
        payload: {
          conversationId: persisted?.conversation_id ?? 'private:qq-34567',
          targetUserId: identity?.canonical_user_id,
          userMessage: '重复任务不应重复入队',
          botResponse: 'duplicate',
          messageId: persisted?.id,
          conversationType: 'private',
        },
        idempotencyKey: 'test:extraction:qq-34567:background',
      });
      expect(duplicateTaskId).toBe(taskId);

      const result = await app.processNextBackgroundJobForTesting();
      expect(result?.status).toBe('completed');
      expect(result?.taskId).toBe(taskId);

      const output = result?.output as
        | { matched: boolean; count: number; memoryIds: string[] }
        | undefined;
      expect(output?.matched).toBe(true);
      expect(output?.count).toBeGreaterThan(0);
      const memoryId = output?.memoryIds[0];
      expect(memoryId).toBeDefined();

      const db = app.getDatabase();
      const job = db.prepare('SELECT status, attempts, result FROM jobs WHERE id = ?').get(taskId) as {
        status: string;
        attempts: number;
        result: string;
      };
      const attempts = db
        .prepare('SELECT status, worker_id, result FROM job_attempts WHERE job_id = ?')
        .all(taskId) as Array<{ status: string; worker_id: string; result: string }>;
      const heartbeat = db
        .prepare('SELECT status, current_job_id FROM worker_heartbeats WHERE worker_id = ?')
        .get('lethebot-background-main') as { status: string; current_job_id: string | null };
      const memory = db
        .prepare('SELECT state, scope, canonical_user_id, content FROM memory_records WHERE id = ?')
        .get(memoryId) as {
          state: string;
          scope: string;
          canonical_user_id: string;
          content: string;
        };
      const source = db
        .prepare('SELECT source_type, source_id FROM memory_sources WHERE memory_id = ?')
        .get(memoryId) as { source_type: string; source_id: string };
      const revisionCount = (
        db.prepare('SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?').get(memoryId) as {
          count: number;
        }
      ).count;
      const auditCount = (
        db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'memory.create' AND event_id = ?").get(memoryId) as {
          count: number;
        }
      ).count;

      expect(job.status).toBe('completed');
      expect(job.attempts).toBe(1);
      expect(JSON.parse(job.result).memoryIds).toContain(memoryId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        status: 'completed',
        worker_id: 'lethebot-background-main',
      });
      expect(JSON.parse(attempts[0]?.result ?? '{}').memoryIds).toContain(memoryId);
      expect(heartbeat).toEqual({
        status: 'idle',
        current_job_id: null,
      });
      expect(memory).toMatchObject({
        state: 'active',
        scope: 'user',
        canonical_user_id: identity?.canonical_user_id,
        content: '我喜欢 后台任务测试',
      });
      expect(source).toEqual({
        source_type: 'chat_message',
        source_id: persisted?.id,
      });
      expect(revisionCount).toBeGreaterThanOrEqual(1);
      expect(auditCount).toBe(1);
      expectNoForeignKeyViolations();
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
      expect(JSON.parse(job.result)).toMatchObject({ rawEventsDeleted: 1 });
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
