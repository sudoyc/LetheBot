/**
 * E2E Tests for Real DeepSeek API Integration
 *
 * These tests verify the complete flow from PiAdapter through DeepSeek API:
 * 1. Simple conversation
 * 2. Tool calling
 * 3. Multi-turn context
 * 4. Error recovery
 *
 * Tests are skipped unless LETHEBOT_RUN_REAL_API_TESTS=1 and PI_API_KEY or DEEPSEEK_API_KEY is available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { PiAdapter } from '../../src/pi/pi-adapter.js';
import { toProviderToolName } from '../../src/pi/tool-adapter.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { PolicyGate } from '../../src/policy/gate.js';
import type { ContextPack } from '../../src/types/context.js';
import type { ToolRegistryEntry } from '../../src/types/tool.js';
import {
  closeDatabase,
  initDatabase,
  runMigrations,
} from '../../src/storage/database.js';
import { MemoryRepository } from '../../src/storage/memory-repository.js';
import { AuditRepository } from '../../src/storage/audit-repository.js';
import { ToolCallRepository } from '../../src/storage/tool-call-repository.js';
import { EvaluatorDecisionRepository } from '../../src/storage/evaluator-decision-repository.js';
import { ModelInvocationRepository } from '../../src/storage/model-invocation-repository.js';
import { LocalToolEffectCoordinator } from '../../src/storage/local-tool-effect-coordinator.js';
import { createMemoryDisableTool } from '../../src/tools/builtins/memory-search.js';
import { createRuntimeEvaluator } from '../../src/evaluator/runtime.js';

const runRealApiTests =
  process.env.LETHEBOT_RUN_REAL_API_TESTS === '1' && !!(process.env.PI_API_KEY || process.env.DEEPSEEK_API_KEY);

function requirePiApiKey(): string {
  const apiKey = process.env.PI_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('PI_API_KEY or DEEPSEEK_API_KEY is required when LETHEBOT_RUN_REAL_API_TESTS=1');
  }
  return apiKey;
}

function requireResponseText(responseText: string | undefined): string {
  expect(responseText).toBeDefined();
  if (responseText === undefined) {
    throw new Error('Expected response text');
  }
  return responseText;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

describe.skipIf(!runRealApiTests)('Real DeepSeek API E2E Tests', () => {
  let adapter: PiAdapter;
  let toolRegistry: ToolRegistry;
  let policyGate: PolicyGate;

  beforeAll(() => {
    toolRegistry = new ToolRegistry();
    policyGate = new PolicyGate(toolRegistry);

    adapter = new PiAdapter({
      toolRegistry,
      policyGate,
      provider: process.env.PI_PROVIDER || 'openai',
      model: process.env.PI_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      apiKey: requirePiApiKey(),
      baseUrl: process.env.PI_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    });
  });

  afterAll(() => {
    // Cleanup if needed
  });

  describe('1. Simple Conversation', () => {
    it('should respond to a simple greeting', async () => {
      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-001',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: 'Hello! How are you?',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await adapter.runTurn({
        contextPack,
        systemPrompt: 'You are a helpful assistant. Keep responses concise.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-001',
      });

      expect(result.status).toBe('completed');
      expect(requireResponseText(result.responseText).length).toBeGreaterThan(0);
      expect(result.errorMessage).toBeUndefined();
    }, 30000); // 30s timeout for API call

    it('should handle Chinese conversation', async () => {
      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-002',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: '你好，今天天气怎么样？',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await adapter.runTurn({
        contextPack,
        systemPrompt: 'You are a helpful assistant. Respond in Chinese.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-002',
      });

      expect(result.status).toBe('completed');
      // Should contain Chinese characters
      expect(/[一-龥]/.test(requireResponseText(result.responseText))).toBe(true);
    }, 30000);
  });

  describe('2. Tool Calling', () => {
    beforeAll(() => {
      // Register a simple test tool
      const testTool: ToolRegistryEntry = {
        name: 'get_current_time',
        version: '1.0.0',
        description: 'Get the current time in a specific timezone',
        capabilities: ['read_context'],
        permissions: {
          allowedActors: ['user', 'admin'],
          allowedContexts: ['private_chat', 'group_chat'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'none',
          execution: 'in_process',
        },
        outputSensitivity: 'normal',
        piSchema: {
          input: {
            type: 'object',
            properties: {
              timezone: {
                type: 'string',
                description: 'IANA timezone name (e.g., Asia/Shanghai)',
              },
            },
            required: ['timezone'],
          },
          output: {
            type: 'object',
            properties: {
              time: { type: 'string' },
              timezone: { type: 'string' },
            },
          },
        },
        handler: async (context) => {
          const input = asRecord(context.input);
          const timezone = typeof input.timezone === 'string' ? input.timezone : 'UTC';
          const now = new Date();
          return {
            time: now.toLocaleString('en-US', { timeZone: timezone }),
            timezone,
          };
        },
      };

      toolRegistry.register(testTool);
    });

    it('should successfully call a tool', async () => {
      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-003',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: 'What time is it in Shanghai?',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await adapter.runTurn({
        contextPack,
        systemPrompt:
          'You are a helpful assistant. Use the get_current_time tool when asked about time.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-003',
      });

      expect(result.status).toBe('completed');
      expect(result.responseText).toBeDefined();
      expect(result.toolCallIds).toBeDefined();

      // The response should mention Shanghai or the time
      const responseText = requireResponseText(result.responseText);
      const hasRelevantContent =
        responseText.toLowerCase().includes('shanghai') ||
        /\d{1,2}:\d{2}/.test(responseText);
      expect(hasRelevantContent).toBe(true);
    }, 30000);

    it('should handle tool with Chinese description', async () => {
      // Register a Chinese-named tool
      const chineseTool: ToolRegistryEntry = {
        name: 'calculate_sum',
        version: '1.0.0',
        description: '计算两个数字的和',
        capabilities: ['read_context'],
        permissions: {
          allowedActors: ['user'],
          allowedContexts: ['private_chat'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'none',
          execution: 'in_process',
        },
        outputSensitivity: 'normal',
        piSchema: {
          input: {
            type: 'object',
            properties: {
              a: { type: 'number', description: '第一个数字' },
              b: { type: 'number', description: '第二个数字' },
            },
            required: ['a', 'b'],
          },
          output: {
            type: 'object',
            properties: {
              result: { type: 'number' },
            },
          },
        },
        handler: async (context) => {
          const input = asRecord(context.input);
          const a = typeof input.a === 'number' ? input.a : 0;
          const b = typeof input.b === 'number' ? input.b : 0;
          return { result: a + b };
        },
      };

      toolRegistry.register(chineseTool);

      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-004',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: '帮我计算 123 加 456',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await adapter.runTurn({
        contextPack,
        systemPrompt: 'You are a helpful assistant. Use available tools when appropriate.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-004',
      });

      expect(result.status).toBe('completed');
      // Should mention 579 (123 + 456)
      expect(requireResponseText(result.responseText).includes('579')).toBe(true);
    }, 30000);

    it('should call a dotted-name tool through the real provider', async () => {
      let handlerCalls = 0;
      const dottedTool: ToolRegistryEntry = {
        name: 'diagnostics.provider_probe',
        version: '1.0.0',
        description:
          'DOTTED_NAME_PROVIDER_PROBE: Return a fixed acknowledgement for the provider tool-name probe.',
        capabilities: ['read_context'],
        permissions: {
          allowedActors: ['user'],
          allowedContexts: ['private_chat'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'none',
          execution: 'in_process',
        },
        outputSensitivity: 'normal',
        piSchema: {
          input: {
            type: 'object',
            properties: {
              marker: {
                type: 'string',
                description: 'Use the exact marker from the user message.',
              },
            },
            required: ['marker'],
          },
          output: {
            type: 'object',
            properties: {
              acknowledged: { type: 'boolean' },
            },
          },
        },
        handler: async () => {
          handlerCalls += 1;
          return { acknowledged: true };
        },
      };

      toolRegistry.register(dottedTool);

      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-dotted-tool-probe',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: 'Run the DOTTED_NAME_PROVIDER_PROBE now with marker provider-alias-ok.',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await adapter.runTurn({
        contextPack,
        systemPrompt:
          'You must call the tool whose description starts with DOTTED_NAME_PROVIDER_PROBE exactly once before answering.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-dotted-tool-probe',
      });

      expect(result.status).toBe('completed');
      expect(handlerCalls).toBeGreaterThan(0);
      expect(result.toolCallIds.length).toBeGreaterThan(0);
    }, 60000);

    it('should govern a canonical dotted built-in through the real evaluator', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'lethebot-real-governed-tool-'));
      const dbPath = join(testDir, 'probe.db');
      const turnId = 'turn-real-governed-memory-disable';
      const sourceEventId = `evt-${turnId}`;
      const conversationId = `conv-${turnId}`;
      const ownerId = 'synthetic-real-evaluator-owner';
      const provider = process.env.PI_PROVIDER || 'openai';
      const model = process.env.PI_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
      const baseUrl = process.env.PI_BASE_URL
        || process.env.DEEPSEEK_BASE_URL
        || 'https://api.deepseek.com/v1';
      const apiKey = requirePiApiKey();
      const db = initDatabase({ path: dbPath });

      try {
        runMigrations(db, join(process.cwd(), 'migrations'));
        seedGovernedToolEvidence(db, {
          turnId,
          sourceEventId,
          conversationId,
          ownerId,
          provider,
          model,
        });

        const memoryRepository = new MemoryRepository(db);
        const memoryId = await memoryRepository.create({
          scope: 'user',
          canonicalUserId: ownerId,
          visibility: 'private_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'preference',
          title: 'Synthetic governed tool probe',
          content: 'Disable only through the isolated real evaluator tool probe',
          state: 'active',
          confidence: 0.9,
          importance: 0.5,
          sourceContext: 'private_chat',
          sources: [{ sourceType: 'raw_event', sourceId: sourceEventId }],
        });
        const initialMemoryState = db.prepare(
          'SELECT state, evaluator_decision_id FROM memory_records WHERE id = ?',
        ).get(memoryId) as { state: string; evaluator_decision_id: string };
        const governedRegistry = new ToolRegistry();
        governedRegistry.register(createMemoryDisableTool(memoryRepository));
        const governedPolicy = new PolicyGate(governedRegistry);
        const auditRepository = new AuditRepository(db);
        const toolCallRepository = new ToolCallRepository(db);
        const evaluatorDecisionRepository = new EvaluatorDecisionRepository(db);
        const governedAdapter = new PiAdapter({
          toolRegistry: governedRegistry,
          policyGate: governedPolicy,
          provider,
          model,
          apiKey,
          baseUrl,
          turnTimeoutMs: 120_000,
          auditRepository,
          toolCallRepository,
          evaluator: createRuntimeEvaluator(
            {
              provider,
              model,
              baseUrl,
              apiKey,
              timeoutMs: 60_000,
              maxRetries: 1,
              temperature: 0,
              promptVersion: 'lethebot-real-governed-tool-v1',
            },
            { invocationLedger: new ModelInvocationRepository(db) },
          ),
          evaluatorDecisionWriter: evaluatorDecisionRepository,
          localToolEffectCoordinator: new LocalToolEffectCoordinator(
            db,
            toolCallRepository,
            auditRepository,
          ),
        });
        const reason = 'Owner requests disabling this synthetic memory in an isolated temporary database';
        const contextPack = createTestContext({
          id: 'ctx-real-governed-memory-disable',
          turnId,
          conversation: {
            conversationId,
            conversationType: 'private',
          },
          recentMessages: [
            {
              messageId: 'msg-real-governed-memory-disable',
              senderId: ownerId,
              senderDisplayName: 'SyntheticOwner',
              text: `${reason}. The exact memoryId is ${memoryId}.`,
              timestamp: new Date(),
              isFromBot: false,
            },
          ],
        });

        const result = await governedAdapter.runTurn({
          contextPack,
          systemPrompt: [
            'This is a controlled local governance request.',
            'Call the only available tool exactly once before answering.',
            `Use memoryId ${memoryId}.`,
            `Use reason: ${reason}.`,
            'Do not call any other tool.',
          ].join(' '),
          actor: { actorClass: 'owner', canonicalUserId: ownerId },
          invocationContext: 'private_chat',
          turnId,
          sourceEventIds: [sourceEventId],
        });

        const providerAlias = toProviderToolName('memory.disable');
        const providerToolNames = result.events
          .filter((event) => event.type === 'tool_execution_start')
          .map((event) => asRecord(event.piEvent).toolName)
          .filter((toolName): toolName is string => typeof toolName === 'string');

        const rows = db.prepare(
          `SELECT
             evaluator.id AS evaluator_id,
             evaluator.request_id AS evaluator_request_id,
             evaluator.domain AS evaluator_domain,
             evaluator.decision,
             evaluator.tool_name AS evaluator_tool_name,
             evaluator.evaluator_version,
             evaluator.request_created_at AS evaluator_request_created_at,
             evaluator.decided_at AS evaluator_decided_at,
             evaluator.model_invocation_id AS evaluator_invocation_id,
             invocation.id AS invocation_id,
             invocation.turn_id AS invocation_turn_id,
             invocation.job_attempt_id AS invocation_job_attempt_id,
             invocation.context_id AS invocation_context_id,
             invocation.purpose AS invocation_purpose,
             invocation.call_number AS invocation_call_number,
             invocation.evaluator_request_id AS invocation_request_id,
             invocation.evaluator_domain AS invocation_domain,
             invocation.prompt_version AS invocation_prompt_version,
             invocation.provider AS invocation_provider,
             invocation.model AS invocation_model,
             invocation.status AS invocation_status,
             invocation.started_at AS invocation_started_at,
             invocation.completed_at AS invocation_completed_at,
             tool_call.id AS tool_call_id,
             tool_call.tool_name AS tool_call_name,
             tool_call.status AS tool_status,
             tool_call.error_code AS tool_error_code,
             tool_call.evaluator_decision_id AS tool_evaluator_id,
             tool_audit.event_type AS tool_audit_type,
             tool_audit.evaluator_decision_id AS tool_audit_evaluator_id,
             tool_audit.details AS tool_audit_details
           FROM evaluator_decisions evaluator
           JOIN model_invocations invocation
             ON invocation.id = evaluator.model_invocation_id
           JOIN tool_calls tool_call
             ON tool_call.evaluator_decision_id = evaluator.id
           JOIN audit_log tool_audit
             ON tool_audit.event_id = tool_call.id
            AND tool_audit.category = 'tool'
           WHERE evaluator.turn_id = ?
             AND evaluator.domain = 'tool'
           ORDER BY evaluator.decided_at, evaluator.id`
        ).all(turnId) as GovernedToolEvidenceRow[];

        const evaluatorRows = db.prepare(
          `SELECT * FROM evaluator_decisions
            WHERE turn_id = ? AND domain = 'tool'
            ORDER BY decided_at, id`,
        ).all(turnId) as GovernedEvaluatorRow[];
        const toolCallRows = db.prepare(
          'SELECT * FROM tool_calls WHERE turn_id = ? ORDER BY created_at, id',
        ).all(turnId) as GovernedToolCallRow[];
        const toolAuditRows = db.prepare(
          `SELECT audit.*
             FROM audit_log audit
             JOIN tool_calls tool_call ON tool_call.id = audit.event_id
            WHERE tool_call.turn_id = ? AND audit.category = 'tool'
            ORDER BY audit.timestamp, audit.id`,
        ).all(turnId) as GovernedToolAuditRow[];
        const invocationSourceRows = db.prepare(
          `SELECT source.model_invocation_id,
                  source.raw_event_id,
                  source.source_ordinal
             FROM model_invocation_sources source
             JOIN evaluator_decisions evaluator
               ON evaluator.model_invocation_id = source.model_invocation_id
            WHERE evaluator.turn_id = ? AND evaluator.domain = 'tool'
            ORDER BY source.model_invocation_id, source.source_ordinal`,
        ).all(turnId) as GovernedInvocationSourceRow[];

        expect(result.status).toBe('completed');
        expect(rows).toHaveLength(1);
        expect(evaluatorRows).toHaveLength(rows.length);
        expect(toolCallRows).toHaveLength(rows.length);
        expect(toolAuditRows).toHaveLength(rows.length);
        expect(result.toolCallIds).toEqual(rows.map((row) => row.tool_call_id));
        expect(evaluatorRows.map((row) => row.id)).toEqual(
          rows.map((row) => row.evaluator_id),
        );
        expect(toolCallRows.map((row) => row.id)).toEqual(
          rows.map((row) => row.tool_call_id),
        );
        expect(toolAuditRows.map((row) => row.event_id)).toEqual(
          rows.map((row) => row.tool_call_id),
        );
        expect(providerAlias).not.toBe('memory.disable');
        expect(providerAlias).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        expect(providerToolNames).toEqual([providerAlias]);
        expect(rows.every((row) => row.evaluator_tool_name === 'memory.disable')).toBe(true);
        expect(rows.every((row) => row.tool_call_name === 'memory.disable')).toBe(true);
        expect(rows.every((row) => row.tool_evaluator_id === row.evaluator_id)).toBe(true);
        expect(rows.every((row) => row.tool_audit_evaluator_id === row.evaluator_id)).toBe(true);
        expect(rows.every((row) => row.evaluator_invocation_id === row.invocation_id)).toBe(true);
        expect(rows.every((row) => row.invocation_purpose === 'evaluator')).toBe(true);
        expect(rows.every((row) => row.invocation_call_number === 1)).toBe(true);
        expect(rows.every((row) => row.invocation_status === 'completed')).toBe(true);
        expect(rows.every((row) => row.invocation_context_id === null)).toBe(true);
        expect(rows.every((row) => row.invocation_job_attempt_id === null)).toBe(true);
        expect(rows.every((row) => row.invocation_turn_id === turnId)).toBe(true);
        expect(rows.every((row) => row.invocation_request_id === row.evaluator_request_id)).toBe(true);
        expect(rows.every((row) => row.invocation_domain === row.evaluator_domain)).toBe(true);
        expect(rows.every((row) => row.invocation_provider === provider)).toBe(true);
        expect(rows.every((row) => row.invocation_model === model)).toBe(true);
        expect(rows.every((row) =>
          row.evaluator_version
            === `${row.invocation_provider}/${row.invocation_model}/${row.invocation_prompt_version}`
        )).toBe(true);
        expect(rows.every((row) =>
          row.evaluator_request_created_at <= row.invocation_started_at
            && row.invocation_started_at <= row.invocation_completed_at
            && row.invocation_completed_at <= row.evaluator_decided_at
        )).toBe(true);
        expect(invocationSourceRows).toEqual([
          {
            model_invocation_id: rows[0]?.invocation_id,
            raw_event_id: sourceEventId,
            source_ordinal: 0,
          },
        ]);
        for (const row of rows) {
          expect(JSON.parse(row.tool_audit_details)).toMatchObject({
            toolName: 'memory.disable',
          });
        }

        expect(evaluatorRows[0]).toMatchObject({
          tool_name: 'memory.disable',
          actor_user_id: ownerId,
          actor_class: 'owner',
          invocation_context: 'private_chat',
          evaluator_version: `${provider}/${model}/lethebot-real-governed-tool-v1`,
        });
        expect(JSON.parse(evaluatorRows[0]?.source_event_ids ?? '[]')).toEqual([sourceEventId]);
        expect(toolCallRows[0]).toMatchObject({
          evaluator_decision_id: evaluatorRows[0]?.id,
          tool_name: 'memory.disable',
          requested_by: 'pi',
          actor_user_id: ownerId,
          actor_class: 'owner',
          invocation_context: 'private_chat',
        });
        expect(JSON.parse(toolCallRows[0]?.input ?? '{}')).toMatchObject({ memoryId });
        expect(toolAuditRows[0]).toMatchObject({
          evaluator_decision_id: evaluatorRows[0]?.id,
          actor_user_id: ownerId,
          actor_class: 'owner',
          invocation_context: 'private_chat',
        });

        const memoryState = db.prepare(
          'SELECT state, evaluator_decision_id FROM memory_records WHERE id = ?',
        ).get(memoryId) as { state: string; evaluator_decision_id: string | null };
        const disableRevision = db.prepare(
          `SELECT evaluator_decision_id
             FROM memory_revisions
            WHERE memory_id = ? AND change_type = 'disable'`,
        ).get(memoryId) as { evaluator_decision_id: string } | undefined;
        const memoryAudit = db.prepare(
          `SELECT evaluator_decision_id, details
             FROM audit_log
            WHERE category = 'memory' AND event_type = 'memory.disable' AND event_id = ?`,
        ).get(memoryId) as { evaluator_decision_id: string; details: string } | undefined;

        const terminalRow = rows[0];
        if (terminalRow?.tool_status === 'success') {
          expect(terminalRow.decision).toBe('approve');
          expect(terminalRow.tool_error_code).toBeNull();
          expect(terminalRow.tool_audit_type).toBe('tool.executed');
          expect(memoryState.state).toBe('disabled');
          expect(memoryState.evaluator_decision_id).toBe(terminalRow.evaluator_id);
          expect(disableRevision?.evaluator_decision_id).toBe(memoryState.evaluator_decision_id);
          expect(memoryAudit?.evaluator_decision_id).toBe(memoryState.evaluator_decision_id);
          expect(JSON.parse(memoryAudit?.details ?? '{}')).toMatchObject({
            toolName: 'memory.disable',
          });
        } else {
          expect(terminalRow?.tool_status).toBe('rejected');
          expect(terminalRow?.tool_audit_type).toBe('tool.rejected');
          expect([
            'EVALUATOR_REJECT',
            'EVALUATOR_DOWNGRADE',
            'EVALUATOR_PROPOSE',
            'EVALUATOR_PROHIBITED',
            'EVALUATOR_CHANGES_UNSUPPORTED',
          ]).toContain(terminalRow?.tool_error_code);
          expect(memoryState).toEqual(initialMemoryState);
          expect(disableRevision).toBeUndefined();
          expect(memoryAudit).toBeUndefined();
        }

        const durableEvidence = {
          evaluatorRows,
          evaluatorInvocationRows: db.prepare(
            `SELECT * FROM model_invocations
              WHERE turn_id = ? AND purpose = 'evaluator'
              ORDER BY started_at, id`,
          ).all(turnId),
          evaluatorInvocationSourceRows: invocationSourceRows,
          toolCallRows,
          toolAuditRows,
          memoryRows: db.prepare('SELECT * FROM memory_records WHERE id = ?').all(memoryId),
          memoryRevisionRows: db.prepare(
            'SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number',
          ).all(memoryId),
          memoryAuditRows: db.prepare(
            `SELECT * FROM audit_log
              WHERE category = 'memory' AND event_id = ?
              ORDER BY timestamp, id`,
          ).all(memoryId),
        };
        expect(JSON.stringify(durableEvidence)).not.toContain(providerAlias);
        expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
        const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
        expect(foreignKeyViolations).toHaveLength(0);

        console.log(JSON.stringify({
          probe: 'real_governed_memory_disable',
          providerTurnStatus: result.status,
          evaluatorDecisions: rows.map((row) => row.decision),
          evaluatorInvocations: rows.length,
          evaluatorInvocationsLinked: rows.every((row) =>
            row.evaluator_invocation_id === row.invocation_id
          ),
          toolStatuses: rows.map((row) => row.tool_status),
          memoryDisabled: memoryState.state === 'disabled',
          integrityOk: true,
          foreignKeyViolations: foreignKeyViolations.length,
        }));
      } finally {
        closeDatabase(db);
        rmSync(testDir, { recursive: true, force: true });
      }
    }, 150000);
  });

  describe('3. Multi-turn Context', () => {
    it('should maintain context across multiple turns', async () => {
      // First turn: establish a preference
      const contextPack1 = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-005',
            senderId: 'user-001',
            senderDisplayName: 'Alice',
            text: 'My favorite color is blue.',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result1 = await adapter.runTurn({
        contextPack: contextPack1,
        systemPrompt: 'You are a helpful assistant. Remember user preferences.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-005',
      });

      expect(result1.status).toBe('completed');

      // Second turn: reference the preference
      const contextPack2 = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-005',
            senderId: 'user-001',
            senderDisplayName: 'Alice',
            text: 'My favorite color is blue.',
            timestamp: new Date(Date.now() - 10000),
            isFromBot: false,
          },
          {
            messageId: 'msg-006',
            senderId: 'bot',
            senderDisplayName: 'LetheBot',
            text: result1.responseText || 'Got it!',
            timestamp: new Date(Date.now() - 5000),
            isFromBot: true,
          },
          {
            messageId: 'msg-007',
            senderId: 'user-001',
            senderDisplayName: 'Alice',
            text: 'What is my favorite color?',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result2 = await adapter.runTurn({
        contextPack: contextPack2,
        systemPrompt: 'You are a helpful assistant. Remember user preferences.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-006',
      });

      expect(result2.status).toBe('completed');
      // Should reference blue
      expect(requireResponseText(result2.responseText).toLowerCase().includes('blue')).toBe(true);
    }, 60000);
  });

  describe('4. Error Recovery', () => {
    it('should handle invalid API key gracefully', async () => {
      const badAdapter = new PiAdapter({
        toolRegistry,
        policyGate,
        provider: 'openai',
        model: 'deepseek-chat',
        apiKey: 'invalid-key-12345',
        baseUrl: 'https://api.deepseek.com/v1',
      });

      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-008',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: 'Hello',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await badAdapter.runTurn({
        contextPack,
        systemPrompt: 'You are a helpful assistant.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-007',
      });

      expect(result.status).toBe('failed');
      expect(result.errorMessage).toBeDefined();
      expect(result.errorMessage).toMatch(/401|authentication|unauthorized|invalid.*key/i);
      expect(result.errorMessage).not.toContain('invalid-key-12345');
    }, 30000);

    it('should handle network timeout', async () => {
      // Use an invalid URL to trigger timeout
      const timeoutAdapter = new PiAdapter({
        toolRegistry,
        policyGate,
        provider: 'openai',
        model: 'deepseek-chat',
        apiKey: requirePiApiKey(),
        baseUrl: 'https://192.0.2.1:9999', // Non-routable IP
        turnTimeoutMs: 5_000,
      });

      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-009',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: 'Hello',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await timeoutAdapter.runTurn({
        contextPack,
        systemPrompt: 'You are a helpful assistant.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-008',
      });

      // Pi agent may handle timeout gracefully and complete, or fail
      // Either way, if it completed, there should be no error message
      if (result.status === 'completed') {
        // Timeout was handled gracefully - this is acceptable behavior
        expect(result.responseText).toBeDefined();
      } else {
        expect(result.status).toBe('failed');
        expect(result.errorMessage).toBeDefined();
      }
    }, 30000);

    it('should recover from malformed tool response', async () => {
      // Register a tool that throws an error
      const errorTool: ToolRegistryEntry = {
        name: 'broken_tool',
        version: '1.0.0',
        description: 'A tool that always fails',
        capabilities: ['read_context'],
        permissions: {
          allowedActors: ['user'],
          allowedContexts: ['private_chat'],
        },
        evaluatorPolicy: 'bypass',
        auditLevel: 'summary',
        sandboxPolicy: {
          filesystem: 'none',
          network: 'none',
          execution: 'in_process',
        },
        outputSensitivity: 'normal',
        piSchema: {
          input: {
            type: 'object',
            properties: {},
          },
          output: {
            type: 'object',
            properties: {
              result: { type: 'string' },
            },
          },
        },
        handler: async () => {
          throw new Error('Tool execution failed');
        },
      };

      toolRegistry.register(errorTool);

      const contextPack = createTestContext({
        recentMessages: [
          {
            messageId: 'msg-010',
            senderId: 'user-001',
            senderDisplayName: 'TestUser',
            text: 'Use the broken_tool',
            timestamp: new Date(),
            isFromBot: false,
          },
        ],
      });

      const result = await adapter.runTurn({
        contextPack,
        systemPrompt: 'You are a helpful assistant. Use the broken_tool when asked.',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        invocationContext: 'private_chat',
        turnId: 'turn-009',
      });

      // Should still complete (Pi agent handles tool errors gracefully)
      expect(result.status).toMatch(/completed|failed/);
      expect(result.responseText).toBeDefined();
    }, 30000);
  });
});

interface GovernedToolEvidenceRow {
  evaluator_id: string;
  evaluator_request_id: string;
  evaluator_domain: string;
  decision: string;
  evaluator_tool_name: string;
  evaluator_version: string;
  evaluator_request_created_at: number;
  evaluator_decided_at: number;
  evaluator_invocation_id: string;
  invocation_id: string;
  invocation_turn_id: string;
  invocation_job_attempt_id: string | null;
  invocation_context_id: string | null;
  invocation_purpose: string;
  invocation_call_number: number;
  invocation_request_id: string;
  invocation_domain: string;
  invocation_prompt_version: string;
  invocation_provider: string;
  invocation_model: string;
  invocation_status: string;
  invocation_started_at: number;
  invocation_completed_at: number;
  tool_call_id: string;
  tool_call_name: string;
  tool_status: string;
  tool_error_code: string | null;
  tool_evaluator_id: string;
  tool_audit_type: string;
  tool_audit_evaluator_id: string;
  tool_audit_details: string;
}

interface GovernedInvocationSourceRow {
  model_invocation_id: string;
  raw_event_id: string;
  source_ordinal: number;
}

interface GovernedEvaluatorRow {
  id: string;
  model_invocation_id: string;
  tool_name: string;
  actor_user_id: string;
  actor_class: string;
  invocation_context: string;
  source_event_ids: string;
  evaluator_version: string;
}

interface GovernedToolCallRow {
  id: string;
  evaluator_decision_id: string;
  tool_name: string;
  input: string;
  requested_by: string;
  actor_user_id: string;
  actor_class: string;
  invocation_context: string;
}

interface GovernedToolAuditRow {
  event_id: string;
  event_type: string;
  evaluator_decision_id: string;
  actor_user_id: string;
  actor_class: string;
  invocation_context: string;
}

function seedGovernedToolEvidence(
  db: Database.Database,
  input: {
    turnId: string;
    sourceEventId: string;
    conversationId: string;
    ownerId: string;
    provider: string;
    model: string;
  },
): void {
  const timestamp = Date.now();
  const platformAccountId = `synthetic-qq-${input.ownerId}`;

  db.prepare(
    'INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)',
  ).run(input.ownerId, timestamp, timestamp);
  db.prepare(
    `INSERT INTO platform_accounts (
       platform, platform_account_id, canonical_user_id, account_type,
       verified_level, status, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'qq',
    platformAccountId,
    input.ownerId,
    'private',
    'observed',
    'active',
    timestamp,
    timestamp,
  );
  db.prepare(
    `INSERT INTO raw_events (
       id, type, timestamp, source, platform, conversation_id, payload, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sourceEventId,
    'message.private',
    timestamp,
    'gateway',
    'qq',
    input.conversationId,
    '{}',
    timestamp,
  );
  db.prepare(
    `INSERT INTO chat_messages (
       id, raw_event_id, message_id, conversation_id, conversation_type,
       sender_id, text, timestamp
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `msg-${input.turnId}`,
    input.sourceEventId,
    `platform-msg-${input.turnId}`,
    input.conversationId,
    'private',
    platformAccountId,
    'Synthetic private memory governance request',
    timestamp,
  );
  db.prepare(
    `INSERT INTO agent_turns (
       id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.turnId,
    input.conversationId,
    input.sourceEventId,
    input.model,
    input.provider,
    'running',
    timestamp,
  );
}

/**
 * Helper function to create test ContextPack
 */
function createTestContext(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    id: 'ctx-test',
    turnId: 'turn-test',
    createdAt: new Date(),
    conversation: {
      conversationId: 'conv-test',
      conversationType: 'private',
    },
    recentMessages: [],
    memory: {
      userProfile: undefined,
      groupProfile: undefined,
      retrievedFacts: [],
      selectedMemoryIds: [],
    },
    participants: [],
    injectedIdentityFields: [],
    tokenBudget: {
      max: 10000,
      used: 0,
      breakdown: {
        recentMessages: 0,
        memory: 0,
        identity: 0,
        system: 0,
      },
    },
    ...overrides,
  };
}
