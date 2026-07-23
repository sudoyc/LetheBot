import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigrations, closeDatabase } from '../../../src/storage/database';
import {
  ActionRepository,
  type CreateActionDecisionInput,
  type SocialEvaluatorEvidence,
} from '../../../src/actions/action-repository';
import { ActionExecutor } from '../../../src/actions/executor';
import { PrivacyPreferenceRepository } from '../../../src/storage/privacy-preference-repository';
import { JobRepository } from '../../../src/storage/job-repository';
import { GroupSummaryPolicyRepository } from '../../../src/storage/group-summary-policy-repository';
import { MemoryRepository } from '../../../src/storage/memory-repository';
import { GroupSummaryJobService } from '../../../src/workers/group-summary-job-service';
import type { ActionDecision, ActionPlan } from '../../../src/types/action';

describe('ActionExecutor privacy enforcement', () => {
  let testDir: string;
  let db: Database.Database;
  let actionRepo: ActionRepository;
  let privacyRepo: PrivacyPreferenceRepository;
  let jobRepo: JobRepository;
  let groupSummaryPolicies: GroupSummaryPolicyRepository;
  let groupSummaryJobs: GroupSummaryJobService;
  let memoryRepo: MemoryRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-action-executor-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigrations(db, join(__dirname, '../../../migrations'));
    actionRepo = new ActionRepository(db);
    privacyRepo = new PrivacyPreferenceRepository(db);
    jobRepo = new JobRepository(db);
    groupSummaryPolicies = new GroupSummaryPolicyRepository(db);
    groupSummaryJobs = new GroupSummaryJobService(db, {
      jobRepository: jobRepo,
      policyRepository: groupSummaryPolicies,
      planGroupSummaryWindow: async ({ conversationId, groupId, eligibleAfter }) => {
        const rows = db.prepare(
          `SELECT cm.id
             FROM chat_messages AS cm
             JOIN raw_events AS re ON re.id = cm.raw_event_id
            WHERE cm.conversation_id = ?
              AND cm.conversation_type = 'group'
              AND cm.group_id = ?
              AND re.created_at >= ?
            ORDER BY re.created_at ASC, re.id ASC, cm.id ASC
            LIMIT 50`,
        ).all(conversationId, groupId, eligibleAfter) as Array<{ id: string }>;
        return rows.length < 10
          ? null
          : {
              sourceChatMessageIds: rows.map((row) => row.id),
              candidateCount: rows.length,
            };
      },
    });
    memoryRepo = new MemoryRepository(db);

    const now = Date.now();
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
      .run('user-alice', now, now);
    db.prepare(
      `INSERT INTO platform_accounts (
        platform, platform_account_id, canonical_user_id, account_type,
        verified_level, status, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('qq', 'qq-user-alice', 'user-alice', 'private', 'observed', 'active', now, now);
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('evt-action-privacy', 'message.private', now, 'gateway', 'qq', 'private:user-alice', '{}', now);
    db.prepare(
      `INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id, conversation_type,
        sender_id, text, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'msg-action-privacy',
      'evt-action-privacy',
      'platform-msg-action-privacy',
      'private:user-alice',
      'private',
      'qq-user-alice',
      'Synthetic action executor source',
      now,
    );
    db.prepare(
      `INSERT INTO agent_turns (
        id, conversation_id, trigger_event_id, pi_model, pi_provider, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('turn-action-privacy', 'private:user-alice', 'evt-action-privacy', 'mock', 'mock', 'running', now);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  function createApprovedDecision(input: CreateActionDecisionInput) {
    const proposedAction = input.actions[0];
    if (!proposedAction) {
      throw new Error('approved action test fixture requires one action');
    }
    const requestId = `request-action-executor-${proposedAction.type}`;
    return actionRepo.createDecision({
      ...input,
      decidedBy: 'evaluator',
      evaluatorRequired: true,
      evaluatorPassed: true,
      evaluatorEvidence: {
        request: {
          requestId,
          domain: 'social',
          turnId: input.turnId,
          actor: {
            canonicalUserId: 'user-alice',
            actorClass: 'user',
          },
          context: 'private_chat',
          sourceEventIds: ['evt-action-privacy'],
          contextSummary: 'bounded action executor approval fixture',
          createdAt: new Date('2026-07-11T07:00:00.000Z'),
          proposedAction: structuredClone(proposedAction),
          attentionSignals: {
            classification: 'needs_evaluation',
            triggerScore: input.confidence,
            triggerReasons: ['action_executor_test'],
            suppressors: [],
            recommendedPath: 'risk_path',
          },
          isProactive: proposedAction.constraints.proactive === true,
        },
        result: {
          decisionId: `eval-action-executor-${proposedAction.type}`,
          requestId,
          domain: 'social',
          decision: 'approve',
          reason: 'approved by source-bound action executor fixture',
          confidence: input.confidence,
          riskLevel: input.riskLevel,
          decidedAt: new Date('2026-07-11T07:00:01.000Z'),
          evaluatorVersion: 'test-action-executor-v1',
        },
      },
    });
  }

  function enableGroupSummaries(groupId: string): void {
    const result = groupSummaryPolicies.setEnabled({
      groupId,
      enabled: true,
      authority: {
        kind: 'bot_owner',
        actorUserId: 'user-bot-owner',
        invocationContext: 'admin_cli',
      },
    });
    const conversation = db.prepare(
      `SELECT conversation_id
         FROM chat_messages
        WHERE conversation_type = 'group' AND group_id = ?
        ORDER BY timestamp DESC
        LIMIT 1`,
    ).get(groupId) as { conversation_id: string } | undefined;
    const eligibleAfter = result.policy?.eligibleAfter;
    if (!conversation || eligibleAfter === undefined) {
      return;
    }
    for (let index = 0; index < 10; index += 1) {
      const rawEventId = `raw-summary-window-${groupId}-${index}`;
      const chatMessageId = `chat-summary-window-${groupId}-${index}`;
      const timestamp = eligibleAfter + index + 1;
      db.prepare(
        `INSERT INTO raw_events (
           id, type, timestamp, source, platform, conversation_id, payload, created_at
         ) VALUES (?, 'message.group', ?, 'gateway', 'qq', ?, '{}', ?)`,
      ).run(rawEventId, timestamp, conversation.conversation_id, timestamp);
      db.prepare(
        `INSERT INTO chat_messages (
           id, raw_event_id, message_id, conversation_id, conversation_type,
           group_id, sender_id, text, timestamp
         ) VALUES (?, ?, ?, ?, 'group', ?, 'user-summary-window', 'Synthetic summary source', ?)`,
      ).run(
        chatMessageId,
        rawEventId,
        `platform-summary-window-${groupId}-${index}`,
        conversation.conversation_id,
        groupId,
        timestamp,
      );
    }
  }

  function useGroupTurn(groupId: string, conversationId: string): void {
    const update = db.transaction(() => {
      db.prepare(
        `UPDATE raw_events
            SET type = 'message.group', conversation_id = ?
          WHERE id = 'evt-action-privacy'`,
      ).run(conversationId);
      db.prepare(
        `UPDATE chat_messages
            SET conversation_id = ?, conversation_type = 'group', group_id = ?
          WHERE raw_event_id = 'evt-action-privacy'`,
      ).run(conversationId, groupId);
      db.prepare(
        `UPDATE agent_turns
            SET conversation_id = ?
          WHERE id = 'turn-action-privacy'`,
      ).run(conversationId);
    });
    update.immediate();
  }

  it('rejects a substituted plan that reuses a persisted decision ID', async () => {
    const sendMessage = vi.fn(async () => 'forged-message-id');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['store only'],
      suppressors: [],
      actions: [
        {
          type: 'silent_store',
          priority: 0,
          constraints: {},
          reason: 'No outward action was approved',
        },
      ],
    });
    const forgedDecision = structuredClone(decision);
    forgedDecision.actions = [
      {
        type: 'reply_full',
        priority: 100,
        target: {
          conversationId: 'private:user-alice',
          conversationType: 'private',
          userId: 'user-alice',
        },
        payload: { text: 'This plan was never persisted or reviewed' },
        constraints: {},
        reason: 'forged plan',
      },
    ];

    await expect(executor.execute(forgedDecision)).rejects.toThrow('execution binding');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM action_executions WHERE action_decision_id = ?')
        .get(decision.id),
    ).toEqual({ count: 0 });
    const row = db.prepare('SELECT actions FROM action_decisions WHERE id = ?').get(decision.id) as {
      actions: string;
    };
    expect(JSON.parse(row.actions)).toMatchObject([{ type: 'silent_store' }]);
  });

  it('rejects forged job and memory plans before any durable local effect', async () => {
    const sendMessage = vi.fn(async () => 'forged-local-effect-message-id');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, {
      jobRepository: jobRepo,
      memoryRepository: memoryRepo,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['store only'],
      suppressors: [],
      actions: [
        {
          type: 'silent_store',
          priority: 0,
          constraints: {},
          reason: 'No local action was approved',
        },
      ],
    });
    const forgedDecision = structuredClone(decision);
    forgedDecision.actions = [
      {
        type: 'schedule_background_task',
        priority: 100,
        target: {
          conversationId: 'private:user-alice',
          conversationType: 'private',
          userId: 'user-alice',
        },
        payload: {
          backgroundTask: {
            type: 'summary',
            payload: { conversationId: 'private:user-alice' },
          },
        },
        constraints: {},
        reason: 'forged background job',
      },
      {
        type: 'propose_memory',
        priority: 90,
        target: {
          conversationId: 'private:user-alice',
          conversationType: 'private',
          userId: 'user-alice',
        },
        payload: {
          memoryProposal: {
            scope: 'user',
            canonicalUserId: 'user-alice',
            kind: 'preference',
            title: 'Forged memory',
            content: 'This memory was never approved',
            confidence: 0.8,
            sourceContext: 'forged_action_plan',
          },
        },
        constraints: {},
        reason: 'forged memory proposal',
      },
    ];

    await expect(executor.execute(forgedDecision)).rejects.toThrow('execution binding');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_executions').get()).toEqual({ count: 0 });
  });

  it('rejects a bound decision after a newer decision supersedes the turn link', async () => {
    const sendMessage = vi.fn(async () => 'superseded-message-id');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const firstDecision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['first reply'],
      suppressors: [],
      actions: [
        {
          type: 'reply_full',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: { text: 'Superseded reply' },
          constraints: {},
          reason: 'first reply',
        },
      ],
    });
    const currentDecision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['replacement store-only decision'],
      suppressors: [],
      actions: [
        {
          type: 'silent_store',
          priority: 0,
          constraints: {},
          reason: 'Replacement decision suppresses the reply',
        },
      ],
    });

    await expect(executor.execute(firstDecision)).rejects.toThrow('execution binding');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(db.prepare('SELECT action_decision_id FROM agent_turns WHERE id = ?')
      .get('turn-action-privacy')).toEqual({ action_decision_id: currentDecision.id });
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_executions').get()).toEqual({ count: 0 });
  });

  it('snapshots accessor-backed creation input before authority validation', async () => {
    const sendMessage = vi.fn(async () => 'accessor-forged-message-id');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const proposedAction: ActionPlan = {
      type: 'silent_store',
      priority: 100,
      target: {
        conversationId: 'private:user-alice',
        conversationType: 'private',
        userId: 'user-alice',
      },
      payload: { text: 'This accessor-backed payload must never be sent' },
      constraints: { evaluatorRequired: true },
      reason: 'Reviewed as a no-op action',
    };
    let typeReads = 0;
    const accessorAction = {
      priority: proposedAction.priority,
      target: proposedAction.target,
      payload: proposedAction.payload,
      constraints: proposedAction.constraints,
      reason: proposedAction.reason,
    } as Omit<ActionPlan, 'type'> & { type: ActionPlan['type'] };
    Object.defineProperty(accessorAction, 'type', {
      enumerable: true,
      get: () => {
        typeReads += 1;
        return typeReads === 1 ? 'silent_store' : 'reply_full';
      },
    });
    const requestId = 'request-action-executor-accessor-snapshot';
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'evaluator',
      riskLevel: 'medium',
      confidence: 0.8,
      evaluatorRequired: true,
      evaluatorPassed: true,
      reasons: ['accessor snapshot authority'],
      suppressors: [],
      actions: [accessorAction],
      evaluatorEvidence: {
        request: {
          requestId,
          domain: 'social',
          turnId: 'turn-action-privacy',
          actor: {
            canonicalUserId: 'user-alice',
            actorClass: 'user',
          },
          context: 'private_chat',
          sourceEventIds: ['evt-action-privacy'],
          contextSummary: 'accessor snapshot regression',
          createdAt: new Date('2026-07-11T07:10:00.000Z'),
          proposedAction,
          attentionSignals: {
            classification: 'needs_evaluation',
            triggerScore: 0.8,
            triggerReasons: ['accessor_snapshot_test'],
            suppressors: [],
            recommendedPath: 'risk_path',
          },
          isProactive: false,
        },
        result: {
          decisionId: 'eval-action-executor-accessor-snapshot',
          requestId,
          domain: 'social',
          decision: 'approve',
          reason: 'approved no-op action',
          confidence: 0.8,
          riskLevel: 'medium',
          decidedAt: new Date('2026-07-11T07:10:01.000Z'),
          evaluatorVersion: 'test-accessor-snapshot-v1',
        },
      },
    });

    const [result] = await executor.execute(decision);

    expect(typeReads).toBe(1);
    expect(decision.actions[0]?.type).toBe('silent_store');
    expect(result).toMatchObject({ actionType: 'silent_store', status: 'success' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('binds memory provenance to the verified turn trigger across awaited checks', async () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'evt-action-replacement-trigger',
      'message.private',
      now,
      'gateway',
      'qq',
      'private:user-alice',
      '{}',
      now,
    );
    const sendMessage = vi.fn(async () => 'changed-trigger-message-id');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, { memoryRepository: memoryRepo });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['source-bound memory proposal'],
      suppressors: [],
      actions: [
        {
          type: 'propose_memory',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            memoryProposal: {
              scope: 'user',
              canonicalUserId: 'user-alice',
              kind: 'preference',
              title: 'Source-bound preference',
              content: 'This proposal must retain its original source event',
              confidence: 0.8,
              sourceContext: 'source_binding_regression',
            },
          },
          constraints: {},
          reason: 'Create a source-bound memory proposal',
        },
      ],
    });
    db.prepare('UPDATE agent_turns SET trigger_event_id = ? WHERE id = ?')
      .run('evt-action-replacement-trigger', 'turn-action-privacy');

    await expect(executor.execute(decision)).rejects.toThrow('execution binding');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_records').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_executions').get()).toEqual({ count: 0 });

    db.prepare('UPDATE agent_turns SET trigger_event_id = ? WHERE id = ?')
      .run('evt-action-privacy', 'turn-action-privacy');
    const isOptedOut = vi.fn(async () => {
      db.prepare('UPDATE agent_turns SET trigger_event_id = ? WHERE id = ?')
        .run('evt-action-replacement-trigger', 'turn-action-privacy');
      return false;
    });
    const executorWithAwaitedPrivacyCheck = new ActionExecutor(
      actionRepo,
      { sendMessage },
      {
        privacyPreferences: { isOptedOut },
        memoryRepository: memoryRepo,
      },
    );

    const [result] = await executorWithAwaitedPrivacyCheck.execute(decision);

    expect(result).toMatchObject({ actionType: 'propose_memory', status: 'success' });
    expect(isOptedOut).toHaveBeenCalledOnce();
    const sourceRow = db
      .prepare('SELECT source_type, source_id FROM memory_sources WHERE memory_id = ?')
      .get(result?.executed?.memoryId) as { source_type: string; source_id: string };
    expect(sourceRow).toEqual({
      source_type: 'raw_event',
      source_id: 'evt-action-privacy',
    });
    expect(db.prepare('SELECT trigger_event_id FROM agent_turns WHERE id = ?')
      .get('turn-action-privacy')).toEqual({ trigger_event_id: 'evt-action-replacement-trigger' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      field: 'action type',
      mutate: (decision: ActionDecision) => {
        if (decision.actions[0]) {
          decision.actions[0].type = 'reply_short';
        }
      },
    },
    {
      field: 'nested target',
      mutate: (decision: ActionDecision) => {
        if (decision.actions[0]?.target) {
          decision.actions[0].target.conversationId = 'private:substituted-target';
        }
      },
    },
    {
      field: 'nested payload',
      mutate: (decision: ActionDecision) => {
        if (decision.actions[0]?.payload) {
          decision.actions[0].payload.text = 'substituted payload';
        }
      },
    },
    {
      field: 'risk level',
      mutate: (decision: ActionDecision) => {
        decision.riskLevel = 'high';
      },
    },
    {
      field: 'evaluator identity and flags',
      mutate: (decision: ActionDecision) => {
        decision.decidedBy = 'evaluator';
        decision.evaluatorRequired = true;
        decision.evaluatorPassed = true;
        decision.evaluatorDecisionId = 'eval-substituted-authority';
      },
    },
  ])('rejects a bound decision with substituted $field', async ({ mutate }) => {
    const sendMessage = vi.fn(async () => 'substituted-message-id');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['ordinary bound reply'],
      suppressors: [],
      actions: [
        {
          type: 'reply_full',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: { text: 'original bound reply' },
          constraints: {},
          reason: 'ordinary bound reply',
        },
      ],
    });
    const substitutedDecision = structuredClone(decision);
    mutate(substitutedDecision);

    await expect(executor.execute(substitutedDecision)).rejects.toThrow('execution binding');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_executions').get()).toEqual({ count: 0 });
  });

  it('rejects execution through a repository instance that does not own the binding key', async () => {
    const sendMessage = vi.fn(async () => 'foreign-repository-message-id');
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['ordinary reply'],
      suppressors: [],
      actions: [
        {
          type: 'reply_full',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: { text: 'Bound to the creating repository instance' },
          constraints: {},
          reason: 'ordinary reply',
        },
      ],
    });
    const executor = new ActionExecutor(new ActionRepository(db), { sendMessage });

    await expect(executor.execute(decision)).rejects.toThrow('execution binding');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_executions').get()).toEqual({ count: 0 });
  });

  it('rejects a legacy or explicitly unbound durable decision', async () => {
    const sendMessage = vi.fn(async () => 'legacy-unbound-message-id');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['ordinary reply'],
      suppressors: [],
      actions: [
        {
          type: 'reply_full',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: { text: 'legacy rows cannot be executed' },
          constraints: {},
          reason: 'ordinary reply',
        },
      ],
    });
    db.prepare('UPDATE action_decisions SET execution_binding = NULL WHERE id = ?').run(decision.id);

    await expect(executor.execute(decision)).rejects.toThrow('execution binding');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_executions').get()).toEqual({ count: 0 });
  });

  it.each([
    {
      field: 'persisted risk level',
      tamper: (database: Database.Database, id: string) => {
        database.prepare('UPDATE action_decisions SET risk_level = ? WHERE id = ?').run('high', id);
      },
    },
    {
      field: 'persisted redacted actions',
      tamper: (database: Database.Database, id: string) => {
        database.prepare('UPDATE action_decisions SET actions = ? WHERE id = ?')
          .run('[{"type":"silent_store"}]', id);
      },
    },
  ])('rejects $field tampering before side effects', async ({ tamper }) => {
    const sendMessage = vi.fn(async () => 'tampered-row-message-id');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['ordinary reply'],
      suppressors: [],
      actions: [
        {
          type: 'reply_full',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: { text: 'untampered reply' },
          constraints: {},
          reason: 'ordinary reply',
        },
      ],
    });
    tamper(db, decision.id);

    await expect(executor.execute(decision)).rejects.toThrow('execution binding');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_executions').get()).toEqual({ count: 0 });
  });

  it.each([
    {
      field: 'approve outcome to downgrade',
      tamper: (database: Database.Database, id: string) => {
        database.prepare('UPDATE evaluator_decisions SET decision = ? WHERE id = ?')
          .run('downgrade', id);
      },
    },
    {
      field: 'request ID',
      tamper: (database: Database.Database, id: string) => {
        database.prepare('UPDATE evaluator_decisions SET request_id = ? WHERE id = ?')
          .run('request-tampered-after-review', id);
      },
    },
    {
      field: 'evaluator version',
      tamper: (database: Database.Database, id: string) => {
        database.prepare('UPDATE evaluator_decisions SET evaluator_version = ? WHERE id = ?')
          .run('tampered-evaluator-v2', id);
      },
    },
    {
      field: 'actor class',
      tamper: (database: Database.Database, id: string) => {
        database.prepare('UPDATE evaluator_decisions SET actor_class = ? WHERE id = ?')
          .run('admin', id);
      },
    },
    {
      field: 'invocation context',
      tamper: (database: Database.Database, id: string) => {
        database.prepare('UPDATE evaluator_decisions SET invocation_context = ? WHERE id = ?')
          .run('group_chat', id);
      },
    },
    {
      field: 'source events',
      tamper: (database: Database.Database, id: string) => {
        database.prepare('UPDATE evaluator_decisions SET source_event_ids = ? WHERE id = ?')
          .run('["evt-action-privacy","evt-forged"]', id);
      },
    },
    {
      field: 'request timestamp',
      tamper: (database: Database.Database, id: string) => {
        database.prepare('UPDATE evaluator_decisions SET request_created_at = request_created_at + 1 WHERE id = ?')
          .run(id);
      },
    },
    {
      field: 'decision timestamp',
      tamper: (database: Database.Database, id: string) => {
        database.prepare('UPDATE evaluator_decisions SET decided_at = decided_at + 1 WHERE id = ?')
          .run(id);
      },
    },
  ])('rejects changed linked evaluator $field before side effects', async ({ tamper }) => {
    const sendMessage = vi.fn(async () => 'tampered-evaluator-message-id');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await createApprovedDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'evaluator',
      riskLevel: 'medium',
      confidence: 0.8,
      evaluatorRequired: true,
      evaluatorPassed: true,
      reasons: ['reviewed reply'],
      suppressors: [],
      actions: [
        {
          type: 'reply_full',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: { text: 'reviewed reply' },
          constraints: { evaluatorRequired: true },
          reason: 'reviewed reply',
        },
      ],
    });
    tamper(db, decision.evaluatorDecisionId ?? 'missing-evaluator-decision');

    await expect(executor.execute(decision)).rejects.toThrow('execution binding');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_executions').get()).toEqual({ count: 0 });
  });

  it('detaches the bound decision from mutable creation inputs', async () => {
    const sendMessage = vi.fn(async () => 'detached-input-message-id');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const action: ActionPlan = {
      type: 'reply_full',
      priority: 100,
      target: {
        conversationId: 'private:user-alice',
        conversationType: 'private',
        userId: 'user-alice',
      },
      payload: { text: 'detached original reply' },
      constraints: {},
      reason: 'detached original reason',
    };
    const reasons = ['detached decision reason'];
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons,
      suppressors: [],
      actions: [action],
    });
    if (action.payload) {
      action.payload.text = 'mutated input reply';
    }
    action.reason = 'mutated input reason';
    reasons[0] = 'mutated decision reason';

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({ actionType: 'reply_full', status: 'success' });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.any(Object),
      { text: 'detached original reply' },
    );
    expect(decision.actions[0]?.reason).toBe('detached original reason');
    expect(decision.reasons).toEqual(['detached decision reason']);
  });

  it('executes the entry snapshot when the caller mutates a later action during an await', async () => {
    let releaseFirstSend: (() => void) | undefined;
    let markFirstSendStarted: (() => void) | undefined;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const firstSendStarted = new Promise<void>((resolve) => {
      markFirstSendStarted = resolve;
    });
    const sendMessage = vi.fn(async () => {
      if (sendMessage.mock.calls.length === 1) {
        markFirstSendStarted?.();
        await firstSendGate;
      }
      return `snapshot-message-${sendMessage.mock.calls.length}`;
    });
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['two ordered replies'],
      suppressors: [],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: { text: 'first original reply' },
          constraints: {},
          reason: 'first reply',
        },
        {
          type: 'reply_short',
          priority: 50,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: { text: 'second original reply' },
          constraints: {},
          reason: 'second reply',
        },
      ],
    });

    const execution = executor.execute(decision);
    await firstSendStarted;
    if (decision.actions[1]?.payload) {
      decision.actions[1].payload.text = 'mutated after execution started';
    }
    releaseFirstSend?.();
    await execution;

    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      { text: 'first original reply' },
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      { text: 'second original reply' },
    );
  });

  it('rejects proactive dm_user when the target user opted out', async () => {
    privacyRepo.setOptOut({
      canonicalUserId: 'user-alice',
      preferenceType: 'proactive_dm',
      reason: 'No proactive DMs',
      actor: {
        actorClass: 'admin',
        context: 'admin_cli',
      },
    });
    const sendMessage = vi.fn(async () => 'dm-msg-1');
    const isOptedOut = vi.spyOn(privacyRepo, 'isOptedOut');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, { privacyPreferences: privacyRepo });
    const decision = await createApprovedDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'evaluator',
      riskLevel: 'medium',
      confidence: 0.8,
      evaluatorRequired: true,
      evaluatorPassed: true,
      reasons: ['memory_review'],
      suppressors: [],
      actions: [
        {
          type: 'dm_user',
          priority: 100,
          target: {
            conversationId: 'private:qq-12345678901',
            conversationType: 'private',
            userId: 'qq-12345678901',
            canonicalUserId: 'user-alice',
          },
          payload: {
            text: 'A proactive reminder',
          },
          constraints: {
            proactive: true,
            proactiveTrigger: 'memory_review',
            evaluatorRequired: true,
          },
          reason: 'Evaluator proposed proactive DM',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(isOptedOut).toHaveBeenCalledWith('user-alice', 'proactive_dm');
    expect(isOptedOut).not.toHaveBeenCalledWith('qq-12345678901', 'proactive_dm');
    expect(result).toMatchObject({
      actionType: 'dm_user',
      status: 'rejected',
      error: {
        code: 'PROACTIVE_DM_OPT_OUT',
        recoverable: false,
      },
    });

    const row = db
      .prepare('SELECT status, error_code, audit_entry FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as { status: string; error_code: string; audit_entry: string };
    expect(row).toMatchObject({
      status: 'rejected',
      error_code: 'PROACTIVE_DM_OPT_OUT',
    });
    expect(row.audit_entry).toContain('proactive_dm_opt_out=true');
    expect(row.audit_entry).toContain('dm_proactive=true');
    expect(row.audit_entry).toContain('dm_trigger=memory_review');
    expect(row.audit_entry).toContain('dm_opt_out=opted_out');
    expect(row.audit_entry).toContain('dm_redaction_level=default');
    expect(row.audit_entry).toContain('dm_cooldown_key=none');
  });

  it('allows user-requested dm_user even when proactive DM is opted out', async () => {
    privacyRepo.setOptOut({
      canonicalUserId: 'user-alice',
      preferenceType: 'proactive_dm',
      actor: {
        actorClass: 'admin',
        context: 'admin_cli',
      },
    });
    const sendMessage = vi.fn(async () => 'dm-msg-allowed');
    const isOptedOut = vi.spyOn(privacyRepo, 'isOptedOut');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, { privacyPreferences: privacyRepo });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: ['user_requested'],
      suppressors: [],
      actions: [
        {
          type: 'dm_user',
          priority: 100,
          target: {
            conversationId: 'private:qq-12345678901',
            conversationType: 'private',
            userId: 'qq-12345678901',
            canonicalUserId: 'user-alice',
          },
          payload: {
            text: 'Requested DM response',
          },
          constraints: {
            proactive: false,
            proactiveTrigger: 'user_requested',
          },
          reason: 'User requested a DM',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(isOptedOut).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      {
        conversationId: 'private:qq-12345678901',
        conversationType: 'private',
        userId: 'qq-12345678901',
      },
      { text: 'Requested DM response' },
    );
    expect(result).toMatchObject({
      actionType: 'dm_user',
      status: 'success',
      executed: {
        messageId: 'dm-msg-allowed',
      },
    });

    const row = db
      .prepare('SELECT status, executed_message_id, audit_entry FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as { status: string; executed_message_id: string; audit_entry: string };
    expect(row).toMatchObject({
      status: 'success',
      executed_message_id: 'dm-msg-allowed',
    });
    expect(row.audit_entry).toContain('dm_proactive=false');
    expect(row.audit_entry).toContain('dm_trigger=user_requested');
    expect(row.audit_entry).toContain('dm_opt_out=not_checked');
    expect(row.audit_entry).toContain('dm_redaction_level=default');
    expect(row.audit_entry).toContain('dm_cooldown_key=none');
  });

  it('records bounded proactive dm_user audit metadata without leaking raw control values', async () => {
    const rawSecret = 'sk-dm-audit-secret-should-not-persist';
    const rawCooldownKey = `reminder:${rawSecret}:qq-12345678901`;
    const sendMessage = vi.fn(async () => 'dm-msg-audit');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, { privacyPreferences: privacyRepo });
    const decision = await createApprovedDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'evaluator',
      riskLevel: 'medium',
      confidence: 0.9,
      evaluatorRequired: true,
      evaluatorPassed: true,
      reasons: ['memory_review'],
      suppressors: [],
      actions: [
        {
          type: 'dm_user',
          priority: 100,
          target: {
            conversationId: 'private:qq-12345678901',
            conversationType: 'private',
            userId: 'qq-12345678901',
            canonicalUserId: 'user-alice',
          },
          payload: {
            text: 'Proactive DM response',
          },
          constraints: {
            proactive: true,
            proactiveTrigger: 'reminder',
            evaluatorRequired: true,
            redactionLevel: 'strict',
            cooldownKey: rawCooldownKey,
          },
          reason: `Send proactive reminder token=${rawSecret} to qq-12345678901`,
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).toHaveBeenCalledWith(
      {
        conversationId: 'private:qq-12345678901',
        conversationType: 'private',
        userId: 'qq-12345678901',
      },
      { text: 'Proactive DM response' },
    );
    expect(result).toMatchObject({
      actionType: 'dm_user',
      status: 'success',
      executed: {
        messageId: 'dm-msg-audit',
      },
    });

    const row = db
      .prepare('SELECT status, audit_entry FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as { status: string; audit_entry: string };
    expect(row.status).toBe('success');
    expect(row.audit_entry).toContain('dm_proactive=true');
    expect(row.audit_entry).toContain('dm_trigger=reminder');
    expect(row.audit_entry).toContain('dm_opt_out=checked_not_opted_out');
    expect(row.audit_entry).toContain('dm_redaction_level=strict');
    expect(row.audit_entry).toContain('dm_cooldown_key=');
    expect(row.audit_entry).toContain('[REDACTED:token_assignment]');
    expect(row.audit_entry).toContain('[REDACTED:platform_id]');
    expect(row.audit_entry).not.toContain(rawSecret);
    expect(row.audit_entry).not.toContain('12345678901');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects proactive dm_user without a canonical target for opt-out enforcement', async () => {
    const sendMessage = vi.fn(async () => 'dm-msg-should-not-send');
    const isOptedOut = vi.fn(async () => false);
    const executor = new ActionExecutor(actionRepo, { sendMessage }, {
      privacyPreferences: { isOptedOut },
    });
    const decision = await createApprovedDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'evaluator',
      riskLevel: 'medium',
      confidence: 0.8,
      evaluatorRequired: true,
      evaluatorPassed: true,
      reasons: ['memory_review'],
      suppressors: [],
      actions: [
        {
          type: 'dm_user',
          priority: 100,
          target: {
            conversationId: 'private:qq-12345678902',
            conversationType: 'private',
            userId: 'qq-12345678902',
          },
          payload: {
            text: 'A proactive reminder',
          },
          constraints: {
            proactive: true,
            proactiveTrigger: 'memory_review',
            evaluatorRequired: true,
          },
          reason: 'Evaluator proposed proactive DM',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(isOptedOut).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'dm_user',
      status: 'rejected',
      error: {
        code: 'PROACTIVE_DM_CANONICAL_USER_REQUIRED',
        recoverable: false,
      },
    });

    const row = db
      .prepare('SELECT status, error_code, audit_entry FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as { status: string; error_code: string; audit_entry: string };
    expect(row).toMatchObject({
      status: 'rejected',
      error_code: 'PROACTIVE_DM_CANONICAL_USER_REQUIRED',
    });
    expect(row.audit_entry).toContain('dm_proactive=true');
    expect(row.audit_entry).toContain('dm_trigger=memory_review');
    expect(row.audit_entry).toContain('dm_opt_out=missing_canonical_user');
    expect(row.audit_entry).not.toContain('12345678902');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('executes approved reply_with_tool as a reply delivery without invoking tools in executor', async () => {
    const sendMessage = vi.fn(async () => 'tool-reply-msg-1');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: ['tool_result_ready'],
      suppressors: [],
      actions: [
        {
          type: 'reply_with_tool',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            text: 'Tool result summary',
            toolCall: {
              id: 'tc-action-reply-with-tool',
              turnId: 'turn-action-privacy',
              toolName: 'group.recent_summary',
              input: {},
              requestedBy: 'pi',
              actor: {
                actorClass: 'user',
                canonicalUserId: 'user-alice',
                groupId: 'group-alpha',
              },
              context: 'group_chat',
            },
          },
          constraints: {},
          reason: 'Tool result is ready for group reply',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).toHaveBeenCalledWith(
      {
        conversationId: 'group:alpha',
        conversationType: 'group',
        groupId: 'group-alpha',
      },
      { text: 'Tool result summary' },
    );
    expect(result).toMatchObject({
      actionType: 'reply_with_tool',
      status: 'success',
      executed: {
        messageId: 'tool-reply-msg-1',
      },
    });

    const row = db
      .prepare('SELECT action_type, status, executed_message_id, error_code FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_message_id: string;
        error_code: string | null;
      };
    expect(row).toEqual({
      action_type: 'reply_with_tool',
      status: 'success',
      executed_message_id: 'tool-reply-msg-1',
      error_code: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects evaluator-required reply_with_tool before side effects when evaluator did not pass', async () => {
    const sendMessage = vi.fn(async () => 'tool-reply-msg-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'medium',
      confidence: 0.6,
      evaluatorRequired: true,
      evaluatorPassed: false,
      reasons: ['tool_result_sensitive'],
      suppressors: ['evaluator_pending'],
      actions: [
        {
          type: 'reply_with_tool',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            text: 'Sensitive tool result should not send',
            toolCall: {
              id: 'tc-action-reply-with-tool-rejected',
              turnId: 'turn-action-privacy',
              toolName: 'group.recent_summary',
              input: {},
              requestedBy: 'pi',
              actor: {
                actorClass: 'user',
                canonicalUserId: 'user-alice',
                groupId: 'group-alpha',
              },
              context: 'group_chat',
            },
          },
          constraints: {
            evaluatorRequired: true,
          },
          reason: 'Tool result requires evaluator review',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'reply_with_tool',
      status: 'rejected',
      error: {
        code: 'EVALUATOR_NOT_PASSED',
        recoverable: false,
      },
    });

    const row = db
      .prepare('SELECT action_type, status, error_code, executed_message_id FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as {
        action_type: string;
        status: string;
        error_code: string;
        executed_message_id: string | null;
      };
    expect(row).toMatchObject({
      action_type: 'reply_with_tool',
      status: 'rejected',
      error_code: 'EVALUATOR_NOT_PASSED',
      executed_message_id: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('executes react_only with true gateway reaction when emoji-like reactions are available', async () => {
    const sendMessage = vi.fn(async () => 'face-message-should-not-send');
    const sendReaction = vi.fn(async () => undefined);
    const executor = new ActionExecutor(actionRepo, {
      sendMessage,
      sendReaction,
      getCapabilities: () => ({
        platform: 'qq',
        reactions: { emojiLike: true, faceMessage: true },
        foldedForward: { groupForward: false, privateForward: false, customNode: false },
        platformAdmin: { kick: false, mute: false, setGroupCard: false },
      }),
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['lightweight_reaction'],
      suppressors: [],
      actions: [
        {
          type: 'react_only',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            reaction: '👍',
            messageId: 'msg-source-1',
          },
          constraints: {},
          reason: 'Lightweight acknowledgement',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendReaction).toHaveBeenCalledWith('msg-source-1', '👍');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'react_only',
      status: 'success',
    });

    const row = db
      .prepare('SELECT action_type, status, executed_message_id, error_code, audit_entry FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_message_id: string | null;
        error_code: string | null;
        audit_entry: string;
      };
    expect(row).toMatchObject({
      action_type: 'react_only',
      status: 'success',
      executed_message_id: null,
      error_code: null,
    });
    expect(row.audit_entry).toContain('gateway_reaction=true');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('downgrades react_only to face-message fallback when true reactions are unavailable', async () => {
    const sendMessage = vi.fn(async () => 'face-msg-1');
    const sendReaction = vi.fn(async () => undefined);
    const executor = new ActionExecutor(actionRepo, {
      sendMessage,
      sendReaction,
      getCapabilities: () => ({
        platform: 'qq',
        reactions: { emojiLike: false, faceMessage: true },
        foldedForward: { groupForward: false, privateForward: false, customNode: false },
        platformAdmin: { kick: false, mute: false, setGroupCard: false },
      }),
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['lightweight_reaction'],
      suppressors: [],
      actions: [
        {
          type: 'react_only',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            reaction: '👍',
            messageId: 'msg-source-2',
          },
          constraints: {},
          reason: 'Fallback reaction acknowledgement',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendReaction).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      {
        conversationId: 'group:alpha',
        conversationType: 'group',
        groupId: 'group-alpha',
      },
      { text: '👍' },
    );
    expect(result).toMatchObject({
      actionType: 'react_only',
      status: 'downgraded',
      downgradedFrom: 'react_only',
      downgradedReason: 'Gateway emoji-like reaction unavailable or failed; sent face-message fallback',
      executed: { messageId: 'face-msg-1' },
    });

    const row = db
      .prepare('SELECT action_type, status, executed_message_id, downgraded_from, downgraded_reason FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_message_id: string;
        downgraded_from: string;
        downgraded_reason: string;
      };
    expect(row).toMatchObject({
      action_type: 'react_only',
      status: 'downgraded',
      executed_message_id: 'face-msg-1',
      downgraded_from: 'react_only',
      downgraded_reason: 'Gateway emoji-like reaction unavailable or failed; sent face-message fallback',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects evaluator-required react_only before reaction or fallback side effects', async () => {
    const sendMessage = vi.fn(async () => 'face-message-should-not-send');
    const sendReaction = vi.fn(async () => undefined);
    const executor = new ActionExecutor(actionRepo, {
      sendMessage,
      sendReaction,
      getCapabilities: () => ({
        platform: 'qq',
        reactions: { emojiLike: true, faceMessage: true },
        foldedForward: { groupForward: false, privateForward: false, customNode: false },
        platformAdmin: { kick: false, mute: false, setGroupCard: false },
      }),
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'medium',
      confidence: 0.5,
      evaluatorRequired: true,
      evaluatorPassed: false,
      reasons: ['reaction_requires_review'],
      suppressors: ['evaluator_pending'],
      actions: [
        {
          type: 'react_only',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            reaction: '👍',
            messageId: 'msg-source-review',
          },
          constraints: {
            evaluatorRequired: true,
          },
          reason: 'Reaction requires evaluator review',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendReaction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'react_only',
      status: 'rejected',
      error: {
        code: 'EVALUATOR_NOT_PASSED',
        recoverable: false,
      },
    });

    const row = db
      .prepare('SELECT action_type, status, error_code, executed_message_id FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as {
        action_type: string;
        status: string;
        error_code: string;
        executed_message_id: string | null;
      };
    expect(row).toMatchObject({
      action_type: 'react_only',
      status: 'rejected',
      error_code: 'EVALUATOR_NOT_PASSED',
      executed_message_id: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('downgrades react_only to silent evidence when no reaction fallback is available', async () => {
    const sendMessage = vi.fn(async () => 'message-should-not-send');
    const sendReaction = vi.fn(async () => undefined);
    const executor = new ActionExecutor(actionRepo, {
      sendMessage,
      sendReaction,
      getCapabilities: () => ({
        platform: 'qq',
        reactions: { emojiLike: false, faceMessage: false },
        foldedForward: { groupForward: false, privateForward: false, customNode: false },
        platformAdmin: { kick: false, mute: false, setGroupCard: false },
      }),
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['lightweight_reaction'],
      suppressors: [],
      actions: [
        {
          type: 'react_only',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            reaction: '👍',
            messageId: 'msg-source-3',
          },
          constraints: {},
          reason: 'Silent reaction fallback',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendReaction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'react_only',
      status: 'downgraded',
      downgradedFrom: 'react_only',
      downgradedReason: 'Gateway reaction and face-message fallback unavailable; stored silently',
    });

    const row = db
      .prepare('SELECT action_type, status, executed_message_id, downgraded_from, downgraded_reason FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_message_id: string | null;
        downgraded_from: string;
        downgraded_reason: string;
      };
    expect(row).toMatchObject({
      action_type: 'react_only',
      status: 'downgraded',
      executed_message_id: null,
      downgraded_from: 'react_only',
      downgraded_reason: 'Gateway reaction and face-message fallback unavailable; stored silently',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('downgrades send_folded_forward to a text fallback when true forward delivery is not wired', async () => {
    const sendMessage = vi.fn(async () => 'folded-fallback-msg-1');
    const executor = new ActionExecutor(actionRepo, {
      sendMessage,
      getCapabilities: () => ({
        platform: 'qq',
        reactions: { emojiLike: false, faceMessage: false },
        foldedForward: { groupForward: true, privateForward: false, customNode: true },
        platformAdmin: { kick: false, mute: false, setGroupCard: false },
      }),
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['long_reply_needs_folded_forward'],
      suppressors: [],
      actions: [
        {
          type: 'send_folded_forward',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            text: 'Short fallback summary for a longer folded-forward response',
          },
          constraints: {},
          reason: 'Long response should use folded forward',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).toHaveBeenCalledWith(
      {
        conversationId: 'group:alpha',
        conversationType: 'group',
        groupId: 'group-alpha',
      },
      { text: 'Short fallback summary for a longer folded-forward response' },
    );
    expect(result).toMatchObject({
      actionType: 'send_folded_forward',
      status: 'downgraded',
      downgradedFrom: 'send_folded_forward',
      downgradedReason: 'Folded-forward delivery is not wired; sent text fallback',
      executed: { messageId: 'folded-fallback-msg-1' },
    });

    const row = db
      .prepare('SELECT action_type, status, executed_message_id, downgraded_from, downgraded_reason FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_message_id: string;
        downgraded_from: string;
        downgraded_reason: string;
      };
    expect(row).toMatchObject({
      action_type: 'send_folded_forward',
      status: 'downgraded',
      executed_message_id: 'folded-fallback-msg-1',
      downgraded_from: 'send_folded_forward',
      downgraded_reason: 'Folded-forward delivery is not wired; sent text fallback',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('downgrades send_folded_forward to silent evidence when no fallback text is available', async () => {
    const sendMessage = vi.fn(async () => 'folded-fallback-should-not-send');
    const executor = new ActionExecutor(actionRepo, {
      sendMessage,
      getCapabilities: () => ({
        platform: 'qq',
        reactions: { emojiLike: false, faceMessage: false },
        foldedForward: { groupForward: false, privateForward: false, customNode: false },
        platformAdmin: { kick: false, mute: false, setGroupCard: false },
      }),
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['long_reply_needs_folded_forward'],
      suppressors: [],
      actions: [
        {
          type: 'send_folded_forward',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {},
          constraints: {},
          reason: 'Long response lacks safe fallback summary',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'send_folded_forward',
      status: 'downgraded',
      downgradedFrom: 'send_folded_forward',
      downgradedReason: 'Folded-forward delivery is not wired and no fallback text was provided; stored silently',
    });

    const row = db
      .prepare('SELECT action_type, status, executed_message_id, downgraded_from, downgraded_reason FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_message_id: string | null;
        downgraded_from: string;
        downgraded_reason: string;
      };
    expect(row).toMatchObject({
      action_type: 'send_folded_forward',
      status: 'downgraded',
      executed_message_id: null,
      downgraded_from: 'send_folded_forward',
      downgraded_reason: 'Folded-forward delivery is not wired and no fallback text was provided; stored silently',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects evaluator-required send_folded_forward before fallback side effects', async () => {
    const sendMessage = vi.fn(async () => 'folded-fallback-should-not-send');
    const executor = new ActionExecutor(actionRepo, {
      sendMessage,
      getCapabilities: () => ({
        platform: 'qq',
        reactions: { emojiLike: false, faceMessage: false },
        foldedForward: { groupForward: true, privateForward: false, customNode: true },
        platformAdmin: { kick: false, mute: false, setGroupCard: false },
      }),
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'medium',
      confidence: 0.5,
      evaluatorRequired: true,
      evaluatorPassed: false,
      reasons: ['long_sensitive_reply'],
      suppressors: ['evaluator_pending'],
      actions: [
        {
          type: 'send_folded_forward',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            text: 'Sensitive long reply fallback should not send',
          },
          constraints: {
            evaluatorRequired: true,
          },
          reason: 'Folded forward requires evaluator review',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'send_folded_forward',
      status: 'rejected',
      error: {
        code: 'EVALUATOR_NOT_PASSED',
        recoverable: false,
      },
    });

    const row = db
      .prepare('SELECT action_type, status, error_code, executed_message_id FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as {
        action_type: string;
        status: string;
        error_code: string;
        executed_message_id: string | null;
      };
    expect(row).toMatchObject({
      action_type: 'send_folded_forward',
      status: 'rejected',
      error_code: 'EVALUATOR_NOT_PASSED',
      executed_message_id: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('schedules admin_digest as a durable background job with redacted execution evidence', async () => {
    const rawSecret = 'sk-action-executor-admin-digest-secret-should-not-persist';
    const rawPlatformId = 'qq-12345678911';
    const sendMessage = vi.fn(async () => 'admin-digest-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, { jobRepository: jobRepo });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['owner_operational_digest_requested'],
      suppressors: [],
      actions: [
        {
          type: 'admin_digest',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            text: `do not copy raw payload token=${rawSecret} target=${rawPlatformId}`,
          },
          constraints: {},
          reason: `Admin digest requested token=${rawSecret} target=${rawPlatformId}`,
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'admin_digest',
      status: 'success',
      executed: {
        jobId: expect.any(String),
      },
    });

    const jobId = result?.executed?.jobId;
    expect(jobId).toBeDefined();

    const jobRow = db
      .prepare('SELECT id, type, payload, idempotency_key, status FROM jobs WHERE id = ?')
      .get(jobId) as {
        id: string;
        type: string;
        payload: string;
        idempotency_key: string;
        status: string;
      };
    const payload = JSON.parse(jobRow.payload) as {
      source: string;
      actionDecisionId: string;
      actionType: string;
      conversationType?: string;
      sinceMs: number;
      nowMs: number;
      reasonSummary: string;
    };
    expect(jobRow).toMatchObject({
      id: jobId,
      type: 'admin_digest',
      idempotency_key: `action:admin_digest:${decision.id}`,
      status: 'pending',
    });
    expect(payload).toMatchObject({
      source: 'action_executor',
      actionDecisionId: decision.id,
      actionType: 'admin_digest',
      conversationType: 'group',
    });
    expect(payload.sinceMs).toEqual(expect.any(Number));
    expect(payload.nowMs).toEqual(expect.any(Number));
    expect(payload.reasonSummary).toContain('[REDACTED:token_assignment]');
    expect(payload.reasonSummary).toContain('[REDACTED:platform_id]');

    const executionRow = db
      .prepare(
        `SELECT action_type, status, executed_message_id, executed_job_id, error_code, audit_entry
         FROM action_executions WHERE action_decision_id = ?`,
      )
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_message_id: string | null;
        executed_job_id: string;
        error_code: string | null;
        audit_entry: string;
      };
    expect(executionRow).toMatchObject({
      action_type: 'admin_digest',
      status: 'success',
      executed_message_id: null,
      executed_job_id: jobId,
      error_code: null,
    });
    expect(executionRow.audit_entry).toContain('admin_digest_job_scheduled=true');

    const serializedEvidence = JSON.stringify({ jobRow, executionRow, result });
    expect(serializedEvidence).not.toContain(rawSecret);
    expect(serializedEvidence).not.toContain(rawPlatformId);
    expect(serializedEvidence).not.toContain('12345678911');
    expect(serializedEvidence).not.toContain('do not copy raw payload');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('schedules silent_summarize_later as a durable summary job without copying raw prompt text', async () => {
    const rawSecret = 'sk-action-executor-silent-summary-secret-should-not-persist';
    const rawPlatformId = 'qq-33445566778';
    const sendMessage = vi.fn(async () => 'silent-summary-should-not-send');
    useGroupTurn('group-alpha', 'group:alpha');
    enableGroupSummaries('group-alpha');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, {
      jobRepository: jobRepo,
      summaryJobService: groupSummaryJobs,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'attention',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['summary_later_requested'],
      suppressors: [],
      actions: [
        {
          type: 'silent_summarize_later',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            text: `do not copy prompt text token=${rawSecret} target=${rawPlatformId}`,
          },
          constraints: {},
          reason: `Summarize later token=${rawSecret} target=${rawPlatformId}`,
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'silent_summarize_later',
      status: 'success',
      executed: {
        jobId: expect.any(String),
      },
    });

    const jobId = result?.executed?.jobId;
    expect(jobId).toBeDefined();

    const jobRow = db
      .prepare('SELECT id, type, payload, idempotency_key, status, max_attempts FROM jobs WHERE id = ?')
      .get(jobId) as {
        id: string;
        type: string;
        payload: string;
        idempotency_key: string;
        status: string;
        max_attempts: number;
      };
    const payload = JSON.parse(jobRow.payload) as {
      source: string;
      actionDecisionId: string;
      actionType: string;
      conversationId?: string;
      conversationType?: string;
      groupId?: string;
      reasonSummary: string;
    };
    expect(jobRow).toMatchObject({
      id: jobId,
      type: 'summary',
      idempotency_key: expect.stringMatching(/^summary:group-window:v1:[a-f0-9]{32}$/),
      status: 'pending',
      max_attempts: 2,
    });
    expect(payload).toMatchObject({
      source: 'action_executor',
      actionDecisionId: decision.id,
      actionType: 'silent_summarize_later',
      conversationId: 'group:alpha',
      conversationType: 'group',
      groupId: 'group-alpha',
    });
    expect(payload.reasonSummary).toContain('[REDACTED:token_assignment]');
    expect(payload.reasonSummary).toContain('[REDACTED:platform_id]');
    expect(groupSummaryPolicies.getBinding(jobId ?? '')).toMatchObject({
      jobId,
      groupId: 'group-alpha',
      conversationId: 'group:alpha',
      generation: 1,
    });

    const executionRow = db
      .prepare(
        `SELECT action_type, status, executed_message_id, executed_job_id, error_code, audit_entry
         FROM action_executions WHERE action_decision_id = ?`,
      )
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_message_id: string | null;
        executed_job_id: string;
        error_code: string | null;
        audit_entry: string;
      };
    expect(executionRow).toMatchObject({
      action_type: 'silent_summarize_later',
      status: 'success',
      executed_message_id: null,
      executed_job_id: jobId,
      error_code: null,
    });
    expect(executionRow.audit_entry).toContain('silent_summary_job_scheduled=true');

    const serializedEvidence = JSON.stringify({ jobRow, executionRow, result });
    expect(serializedEvidence).not.toContain(rawSecret);
    expect(serializedEvidence).not.toContain(rawPlatformId);
    expect(serializedEvidence).not.toContain('33445566778');
    expect(serializedEvidence).not.toContain('do not copy prompt text');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('keeps group silent summaries default-off without creating a job or binding', async () => {
    useGroupTurn('group-alpha', 'group:alpha');
    const executor = new ActionExecutor(actionRepo, {
      sendMessage: vi.fn(async () => 'silent-summary-should-not-send'),
    }, {
      jobRepository: jobRepo,
      summaryJobService: groupSummaryJobs,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'attention',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['summary_later_requested'],
      suppressors: [],
      actions: [{
        type: 'silent_summarize_later',
        priority: 100,
        target: {
          conversationId: 'group:alpha',
          conversationType: 'group',
          groupId: 'group-alpha',
        },
        payload: {},
        constraints: {},
        reason: 'Default-off group summary',
      }],
    });

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({
      status: 'rejected',
      error: { code: 'GROUP_SUMMARY_POLICY_DISABLED', recoverable: false },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM group_summary_job_bindings').get())
      .toEqual({ count: 0 });
  });

  it('rejects a group summary when the governed summary service is missing', async () => {
    useGroupTurn('group-alpha', 'group:alpha');
    enableGroupSummaries('group-alpha');
    const executor = new ActionExecutor(actionRepo, {
      sendMessage: vi.fn(async () => 'summary-should-not-send'),
    }, { jobRepository: jobRepo });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['summary_requested'],
      suppressors: [],
      actions: [{
        type: 'schedule_background_task',
        priority: 100,
        target: {
          conversationId: 'group:alpha',
          conversationType: 'group',
          groupId: 'group-alpha',
        },
        payload: {
          backgroundTask: {
            type: 'summary',
            payload: { conversationId: 'group:alpha', conversationType: 'group' },
          },
        },
        constraints: {},
        reason: 'Missing group summary service',
      }],
    });

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({
      status: 'rejected',
      error: { code: 'GROUP_SUMMARY_SERVICE_NOT_CONFIGURED', recoverable: true },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
  });

  it('rejects contradictory model payload scope before group summary enqueue', async () => {
    useGroupTurn('group-alpha', 'group:alpha');
    enableGroupSummaries('group-alpha');
    const executor = new ActionExecutor(actionRepo, {
      sendMessage: vi.fn(async () => 'summary-should-not-send'),
    }, {
      jobRepository: jobRepo,
      summaryJobService: groupSummaryJobs,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['summary_requested'],
      suppressors: [],
      actions: [{
        type: 'schedule_background_task',
        priority: 100,
        target: {
          conversationId: 'group:alpha',
          conversationType: 'group',
          groupId: 'group-alpha',
        },
        payload: {
          backgroundTask: {
            type: 'summary',
            payload: {
              conversationId: 'group:beta',
              conversationType: 'group',
              groupId: 'group-beta',
            },
          },
        },
        constraints: {},
        reason: 'Contradictory payload target',
      }],
    });

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({
      status: 'rejected',
      error: { code: 'INVALID_GROUP_SUMMARY_ACTION', recoverable: false },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM group_summary_job_bindings').get())
      .toEqual({ count: 0 });
  });

  it('rejects a group summary with no exact target group', async () => {
    useGroupTurn('group-alpha', 'group:alpha');
    const executor = new ActionExecutor(actionRepo, {
      sendMessage: vi.fn(async () => 'summary-should-not-send'),
    }, {
      jobRepository: jobRepo,
      summaryJobService: groupSummaryJobs,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'attention',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['summary_later_requested'],
      suppressors: [],
      actions: [{
        type: 'silent_summarize_later',
        priority: 100,
        target: {
          conversationId: 'group:alpha',
          conversationType: 'group',
        },
        payload: {},
        constraints: {},
        reason: 'Missing exact target group',
      }],
    });

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({
      status: 'rejected',
      error: { code: 'INVALID_GROUP_SUMMARY_ACTION', recoverable: false },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
  });

  it('rejects a private-turn group summary before enqueue', async () => {
    enableGroupSummaries('group-alpha');
    const executor = new ActionExecutor(actionRepo, {
      sendMessage: vi.fn(async () => 'summary-should-not-send'),
    }, {
      jobRepository: jobRepo,
      summaryJobService: groupSummaryJobs,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'attention',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['summary_later_requested'],
      suppressors: [],
      actions: [{
        type: 'silent_summarize_later',
        priority: 100,
        target: {
          conversationId: 'group:alpha',
          conversationType: 'group',
          groupId: 'group-alpha',
        },
        payload: {},
        constraints: {},
        reason: 'Private turn must not summarize a group',
      }],
    });

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({
      status: 'rejected',
      error: {
        code: 'INVALID_GROUP_SUMMARY_ACTION',
        message: 'Group summary actions require an exact triggering group chat',
        recoverable: false,
      },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM group_summary_job_bindings').get())
      .toEqual({ count: 0 });
  });

  it('rejects a cross-group summary before enqueue', async () => {
    useGroupTurn('group-alpha', 'group:alpha');
    enableGroupSummaries('group-beta');
    const executor = new ActionExecutor(actionRepo, {
      sendMessage: vi.fn(async () => 'summary-should-not-send'),
    }, {
      jobRepository: jobRepo,
      summaryJobService: groupSummaryJobs,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['summary_requested'],
      suppressors: [],
      actions: [{
        type: 'schedule_background_task',
        priority: 100,
        target: {
          conversationId: 'group:beta',
          conversationType: 'group',
          groupId: 'group-beta',
        },
        payload: {
          backgroundTask: {
            type: 'summary',
            payload: {
              conversationId: 'group:beta',
              conversationType: 'group',
              groupId: 'group-beta',
            },
          },
        },
        constraints: {},
        reason: 'Group turn must not summarize another group',
      }],
    });

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({
      status: 'rejected',
      error: {
        code: 'INVALID_GROUP_SUMMARY_ACTION',
        message: 'Group summary target must match the triggering group and conversation',
        recoverable: false,
      },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM group_summary_job_bindings').get())
      .toEqual({ count: 0 });
  });

  it('rejects a cross-conversation group summary before enqueue', async () => {
    useGroupTurn('group-alpha', 'group:alpha');
    enableGroupSummaries('group-alpha');
    const executor = new ActionExecutor(actionRepo, {
      sendMessage: vi.fn(async () => 'summary-should-not-send'),
    }, {
      jobRepository: jobRepo,
      summaryJobService: groupSummaryJobs,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'attention',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['summary_later_requested'],
      suppressors: [],
      actions: [{
        type: 'silent_summarize_later',
        priority: 100,
        target: {
          conversationId: 'group:alpha-other-conversation',
          conversationType: 'group',
          groupId: 'group-alpha',
        },
        payload: {},
        constraints: {},
        reason: 'Group turn must not summarize another conversation',
      }],
    });

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({
      status: 'rejected',
      error: {
        code: 'INVALID_GROUP_SUMMARY_ACTION',
        message: 'Group summary target must match the triggering group and conversation',
        recoverable: false,
      },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM group_summary_job_bindings').get())
      .toEqual({ count: 0 });
  });

  it('rejects prohibited silent_summarize_later before durable job scheduling', async () => {
    const sendMessage = vi.fn(async () => 'silent-summary-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, { jobRepository: jobRepo });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'prohibited',
      confidence: 0.1,
      evaluatorRequired: false,
      reasons: ['l0_prohibited'],
      suppressors: ['policy_prohibited'],
      actions: [
        {
          type: 'silent_summarize_later',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {},
          constraints: {},
          reason: 'Policy prohibited summary job',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'silent_summarize_later',
      status: 'rejected',
      error: {
        code: 'PROHIBITED_ACTION_DECISION',
        recoverable: false,
      },
    });

    const jobCount = db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number };
    expect(jobCount.count).toBe(0);

    const executionRow = db
      .prepare(
        `SELECT action_type, status, executed_message_id, executed_job_id, error_code
         FROM action_executions WHERE action_decision_id = ?`,
      )
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_message_id: string | null;
        executed_job_id: string | null;
        error_code: string;
      };
    expect(executionRow).toMatchObject({
      action_type: 'silent_summarize_later',
      status: 'rejected',
      executed_message_id: null,
      executed_job_id: null,
      error_code: 'PROHIBITED_ACTION_DECISION',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects evaluator-required silent_summarize_later before durable job scheduling', async () => {
    const sendMessage = vi.fn(async () => 'silent-summary-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, { jobRepository: jobRepo });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'medium',
      confidence: 0.4,
      evaluatorRequired: true,
      evaluatorPassed: false,
      reasons: ['summary_requires_review'],
      suppressors: ['evaluator_pending'],
      actions: [
        {
          type: 'silent_summarize_later',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {},
          constraints: {
            evaluatorRequired: true,
          },
          reason: 'Evaluator required summary job',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'silent_summarize_later',
      status: 'rejected',
      error: {
        code: 'EVALUATOR_NOT_PASSED',
        recoverable: false,
      },
    });

    const jobCount = db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number };
    expect(jobCount.count).toBe(0);

    const executionRow = db
      .prepare(
        `SELECT action_type, status, executed_message_id, executed_job_id, error_code
         FROM action_executions WHERE action_decision_id = ?`,
      )
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_message_id: string | null;
        executed_job_id: string | null;
        error_code: string;
      };
    expect(executionRow).toMatchObject({
      action_type: 'silent_summarize_later',
      status: 'rejected',
      executed_message_id: null,
      executed_job_id: null,
      error_code: 'EVALUATOR_NOT_PASSED',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('creates governed proposed memory for propose_memory without gateway send or raw prompt text', async () => {
    const rawSecret = 'sk-action-executor-memory-secret-should-not-persist';
    const rawPlatformId = 'qq-99887766554';
    const sendMessage = vi.fn(async () => 'memory-proposal-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, { memoryRepository: memoryRepo });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['memory_proposal_requested'],
      suppressors: [],
      actions: [
        {
          type: 'propose_memory',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            memoryProposal: {
              scope: 'user',
              canonicalUserId: 'user-alice',
              kind: 'preference',
              title: 'Alice prefers tea',
              content: 'Alice prefers tea for late work sessions',
              confidence: 0.8,
              sourceContext: `do-not-copy raw prompt token=${rawSecret} target=${rawPlatformId}`,
            },
          },
          constraints: {},
          reason: `Create memory proposal token=${rawSecret} target=${rawPlatformId}`,
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'propose_memory',
      status: 'success',
      executed: {
        memoryId: expect.any(String),
      },
    });

    const memoryId = result?.executed?.memoryId;
    expect(memoryId).toBeDefined();

    const memoryRow = db
      .prepare(
        `SELECT id, scope, canonical_user_id, group_id, conversation_id,
                visibility, sensitivity, authority, kind, title, content, state,
                confidence, importance, source_context, evaluator_decision_id
         FROM memory_records WHERE id = ?`,
      )
      .get(memoryId) as {
        id: string;
        scope: string;
        canonical_user_id: string;
        group_id: string | null;
        conversation_id: string | null;
        visibility: string;
        sensitivity: string;
        authority: string;
        kind: string;
        title: string;
        content: string;
        state: string;
        confidence: number;
        importance: number;
        source_context: string;
      evaluator_decision_id: string;
      };
    expect(memoryRow).toMatchObject({
      id: memoryId,
      scope: 'user',
      canonical_user_id: 'user-alice',
      group_id: null,
      conversation_id: null,
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'inferred',
      kind: 'preference',
      title: 'Alice prefers tea',
      content: 'Alice prefers tea for late work sessions',
      state: 'proposed',
      confidence: 0.8,
      importance: 0.8,
      source_context: 'action_executor:propose_memory',
      evaluator_decision_id: `policy:l0:proposed:${memoryId}`,
    });

    const sourceRow = db
      .prepare('SELECT source_type, source_id, extracted_by FROM memory_sources WHERE memory_id = ?')
      .get(memoryId) as { source_type: string; source_id: string; extracted_by: string };
    expect(sourceRow).toMatchObject({
      source_type: 'raw_event',
      source_id: 'evt-action-privacy',
      extracted_by: 'worker',
    });

    const revisionRows = db
      .prepare('SELECT reason, evaluator_decision_id FROM memory_revisions WHERE memory_id = ?')
      .all(memoryId) as Array<{ reason: string; evaluator_decision_id: string }>;
    expect(revisionRows).toHaveLength(1);
    expect(revisionRows[0]?.reason).toContain('[REDACTED:token_assignment]');
    expect(revisionRows[0]?.reason).toContain('[REDACTED:platform_id]');
    expect(revisionRows[0]?.evaluator_decision_id).toBe(`policy:l0:proposed:${memoryId}`);

    const auditRow = db
      .prepare(
        `SELECT event_type, event_id, evaluator_decision_id, details
           FROM audit_log WHERE event_type = ? AND event_id = ?`,
      )
      .get('memory.create', memoryId) as {
        event_type: string;
        event_id: string;
        evaluator_decision_id: string;
        details: string;
      };
    expect(auditRow).toMatchObject({
      event_type: 'memory.create',
      event_id: memoryId,
      evaluator_decision_id: `policy:l0:proposed:${memoryId}`,
    });
    expect(JSON.parse(auditRow.details)).toMatchObject({
      policyDecision: `policy:l0:proposed:${memoryId}`,
    });

    const executionRow = db
      .prepare(
        `SELECT action_type, status, executed_message_id, executed_memory_id, executed_job_id, error_code, audit_entry
         FROM action_executions WHERE action_decision_id = ?`,
      )
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_message_id: string | null;
        executed_memory_id: string;
        executed_job_id: string | null;
        error_code: string | null;
        audit_entry: string;
      };
    expect(executionRow).toMatchObject({
      action_type: 'propose_memory',
      status: 'success',
      executed_message_id: null,
      executed_memory_id: memoryId,
      executed_job_id: null,
      error_code: null,
    });
    expect(executionRow.audit_entry).toContain('memory_proposal_created=true');

    const serializedEvidence = JSON.stringify({
      result,
      memoryRow,
      sourceRow,
      revisionRows,
      auditRow,
      executionRow,
    });
    expect(serializedEvidence).not.toContain(rawSecret);
    expect(serializedEvidence).not.toContain(rawPlatformId);
    expect(serializedEvidence).not.toContain('99887766554');
    expect(serializedEvidence).not.toContain('do-not-copy raw prompt');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('links an evaluated memory proposal to the real evaluator decision', async () => {
    const sendMessage = vi.fn(async () => 'memory-proposal-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, { memoryRepository: memoryRepo });
    const action: ActionPlan = {
      type: 'propose_memory',
      priority: 100,
      target: {
        conversationId: 'private:user-alice',
        conversationType: 'private',
        userId: 'user-alice',
      },
      payload: {
        memoryProposal: {
          scope: 'user',
          canonicalUserId: 'user-alice',
          kind: 'preference',
          title: 'Alice prefers quiet notifications',
          content: 'Alice prefers quiet notifications in the evening',
          confidence: 0.82,
          sourceContext: 'private_chat',
        },
      },
      constraints: { evaluatorRequired: true },
      reason: 'Evaluator approved a proposed memory',
    };
    const evaluatorEvidence: SocialEvaluatorEvidence = {
      request: {
        requestId: 'request-action-memory-link',
        domain: 'social',
        turnId: 'turn-action-privacy',
        actor: {
          canonicalUserId: 'user-alice',
          actorClass: 'user',
        },
        context: 'private_chat',
        sourceEventIds: ['evt-action-privacy'],
        contextSummary: 'bounded evaluated memory proposal',
        createdAt: new Date('2026-07-11T08:00:00.000Z'),
        proposedAction: action,
        attentionSignals: {
          classification: 'needs_evaluation',
          triggerScore: 0.8,
          triggerReasons: ['memory_proposal'],
          suppressors: [],
          recommendedPath: 'risk_path',
        },
        isProactive: false,
      },
      result: {
        decisionId: 'eval-action-memory-link',
        requestId: 'request-action-memory-link',
        domain: 'social',
        decision: 'approve',
        reason: 'approved proposed memory',
        confidence: 0.88,
        riskLevel: 'medium',
        decidedAt: new Date('2026-07-11T08:00:01.000Z'),
        evaluatorVersion: 'test-action-memory-link-v1',
      },
    };
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'evaluator',
      riskLevel: 'medium',
      confidence: 0.88,
      evaluatorRequired: true,
      evaluatorPassed: true,
      reasons: ['memory proposal reviewed'],
      suppressors: [],
      actions: [action],
      evaluatorEvidence,
    });

    const [result] = await executor.execute(decision);
    const memoryId = result?.executed?.memoryId;

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ actionType: 'propose_memory', status: 'success' });
    expect(memoryId).toBeDefined();
    expect(
      db.prepare('SELECT evaluator_decision_id FROM memory_records WHERE id = ?').get(memoryId),
    ).toEqual({ evaluator_decision_id: 'eval-action-memory-link' });
    expect(
      db.prepare('SELECT evaluator_decision_id FROM memory_revisions WHERE memory_id = ?').get(memoryId),
    ).toEqual({ evaluator_decision_id: 'eval-action-memory-link' });
    const auditRow = db.prepare(
      `SELECT evaluator_decision_id, details
         FROM audit_log WHERE event_type = 'memory.create' AND event_id = ?`,
    ).get(memoryId) as { evaluator_decision_id: string; details: string };
    expect(auditRow.evaluator_decision_id).toBe('eval-action-memory-link');
    expect(JSON.parse(auditRow.details)).toMatchObject({
      policyDecision: 'eval-action-memory-link',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects propose_memory when deterministic memory policy blocks secret content', async () => {
    const sendMessage = vi.fn(async () => 'memory-proposal-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, { memoryRepository: memoryRepo });
    const decision = await createApprovedDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'evaluator',
      riskLevel: 'medium',
      confidence: 0.7,
      evaluatorRequired: true,
      evaluatorPassed: true,
      reasons: ['memory_proposal_requested'],
      suppressors: [],
      actions: [
        {
          type: 'propose_memory',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            memoryProposal: {
              scope: 'user',
              canonicalUserId: 'user-alice',
              kind: 'fact',
              title: 'Alice API key',
              content: 'Alice shared api_key=sk-action-executor-memory-policy-secret',
              confidence: 0.8,
              sourceContext: 'private_chat',
            },
          },
          constraints: {
            evaluatorRequired: true,
          },
          reason: 'Create memory proposal with policy-blocked content',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'propose_memory',
      status: 'rejected',
      error: {
        code: 'MEMORY_PROPOSAL_POLICY_REJECTED',
        recoverable: false,
      },
    });

    const memoryCount = db.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number };
    expect(memoryCount.count).toBe(0);

    const executionRow = db
      .prepare(
        `SELECT action_type, status, executed_memory_id, error_code
         FROM action_executions WHERE action_decision_id = ?`,
      )
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_memory_id: string | null;
        error_code: string;
      };
    expect(executionRow).toMatchObject({
      action_type: 'propose_memory',
      status: 'rejected',
      executed_memory_id: null,
      error_code: 'MEMORY_PROPOSAL_POLICY_REJECTED',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects user-scoped propose_memory when the user opted out of memory association', async () => {
    privacyRepo.setOptOut({
      canonicalUserId: 'user-alice',
      preferenceType: 'memory_association',
      reason: 'Do not associate memories with this user',
      actor: {
        actorClass: 'admin',
        context: 'admin_cli',
      },
    });
    const sendMessage = vi.fn(async () => 'memory-proposal-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, {
      memoryRepository: memoryRepo,
      privacyPreferences: privacyRepo,
    });
    const decision = await createApprovedDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'evaluator',
      riskLevel: 'medium',
      confidence: 0.7,
      evaluatorRequired: true,
      evaluatorPassed: true,
      reasons: ['memory_proposal_requested'],
      suppressors: [],
      actions: [
        {
          type: 'propose_memory',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            memoryProposal: {
              scope: 'user',
              canonicalUserId: 'user-alice',
              kind: 'preference',
              title: 'Alice prefers tea',
              content: 'Alice prefers tea for late work sessions',
              confidence: 0.8,
              sourceContext: 'private_chat',
            },
          },
          constraints: {
            evaluatorRequired: true,
          },
          reason: 'Create memory proposal after user opt-out',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'propose_memory',
      status: 'rejected',
      error: {
        code: 'MEMORY_ASSOCIATION_OPT_OUT',
        recoverable: false,
      },
    });

    const memoryCount = db.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number };
    expect(memoryCount.count).toBe(0);

    const executionRow = db
      .prepare(
        `SELECT action_type, status, executed_memory_id, error_code, audit_entry
         FROM action_executions WHERE action_decision_id = ?`,
      )
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_memory_id: string | null;
        error_code: string;
        audit_entry: string;
      };
    expect(executionRow).toMatchObject({
      action_type: 'propose_memory',
      status: 'rejected',
      executed_memory_id: null,
      error_code: 'MEMORY_ASSOCIATION_OPT_OUT',
    });
    expect(executionRow.audit_entry).toContain('memory_association_opt_out=true');
    expect(executionRow.audit_entry).not.toContain('Alice prefers tea for late work sessions');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects propose_memory when no governed memory repository is configured', async () => {
    const sendMessage = vi.fn(async () => 'memory-proposal-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['memory_proposal_requested'],
      suppressors: [],
      actions: [
        {
          type: 'propose_memory',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            memoryProposal: {
              scope: 'user',
              canonicalUserId: 'user-alice',
              kind: 'preference',
              title: 'Alice prefers tea',
              content: 'Alice prefers tea',
              confidence: 0.8,
              sourceContext: 'private_chat',
            },
          },
          constraints: {},
          reason: 'Create memory proposal without repository',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'propose_memory',
      status: 'rejected',
      error: {
        code: 'MEMORY_REPOSITORY_NOT_CONFIGURED',
        recoverable: true,
      },
    });

    const memoryCount = db.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number };
    expect(memoryCount.count).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('schedules schedule_background_task as a durable job with redacted bounded payload evidence', async () => {
    const rawSecret = 'sk-action-executor-background-task-secret-should-not-persist';
    const rawPlatformId = 'qq-22334455667';
    const sendMessage = vi.fn(async () => 'background-task-should-not-send');
    useGroupTurn('group-alpha', 'group:alpha');
    enableGroupSummaries('group-alpha');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, {
      jobRepository: jobRepo,
      summaryJobService: groupSummaryJobs,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['summary_background_task_requested'],
      suppressors: [],
      actions: [
        {
          type: 'schedule_background_task',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            backgroundTask: {
              type: 'summary',
              payload: {
                conversationId: 'group:alpha',
                conversationType: 'group',
                note: `do not copy secret token=${rawSecret} target=${rawPlatformId}`,
                ownerUserId: 22334455667,
              },
              idempotencyKey: `summary:group:qq-group-22334455667:${rawSecret}`,
              maxAttempts: 2,
            },
          },
          constraints: {},
          reason: `Schedule summary token=${rawSecret} target=${rawPlatformId}`,
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'schedule_background_task',
      status: 'success',
      executed: {
        jobId: expect.any(String),
      },
    });

    const jobId = result?.executed?.jobId;
    expect(jobId).toBeDefined();

    const jobRow = db
      .prepare('SELECT id, type, payload, idempotency_key, status, max_attempts FROM jobs WHERE id = ?')
      .get(jobId) as {
        id: string;
        type: string;
        payload: string;
        idempotency_key: string;
        status: string;
        max_attempts: number;
      };
    const payload = JSON.parse(jobRow.payload) as {
      source: string;
      actionDecisionId: string;
      actionType: string;
      conversationType?: string;
      reasonSummary: string;
      conversationId?: string;
      note?: string;
      ownerUserId?: string;
      taskPayload: {
        conversationId?: string;
        conversationType?: string;
        note?: string;
        ownerUserId?: string;
      };
    };
    expect(jobRow).toMatchObject({
      id: jobId,
      type: 'summary',
      idempotency_key: expect.stringMatching(/^summary:group-window:v1:[a-f0-9]{32}$/),
      status: 'pending',
      max_attempts: 2,
    });
    expect(payload).toMatchObject({
      source: 'action_executor',
      actionDecisionId: decision.id,
      actionType: 'schedule_background_task',
      conversationType: 'group',
      conversationId: 'group:alpha',
      taskPayload: {
        note: expect.any(String),
        ownerUserId: '[REDACTED:platform_id]',
      },
    });
    expect(payload.reasonSummary).toContain('[REDACTED:token_assignment]');
    expect(payload.reasonSummary).toContain('[REDACTED:platform_id]');
    expect(payload.note).toContain('[REDACTED:token_assignment]');
    expect(payload.note).toContain('[REDACTED:platform_id]');
    expect(payload.ownerUserId).toBe('[REDACTED:platform_id]');
    expect(payload.taskPayload.note).toContain('[REDACTED:token_assignment]');
    expect(payload.taskPayload.note).toContain('[REDACTED:platform_id]');
    expect(payload.taskPayload.ownerUserId).toBe('[REDACTED:platform_id]');
    expect(groupSummaryPolicies.getBinding(jobId ?? '')).toMatchObject({
      jobId,
      groupId: 'group-alpha',
      conversationId: 'group:alpha',
      generation: 1,
    });

    const executionRow = db
      .prepare(
        `SELECT action_type, status, executed_message_id, executed_job_id, error_code, audit_entry
         FROM action_executions WHERE action_decision_id = ?`,
      )
      .get(decision.id) as {
        action_type: string;
        status: string;
        executed_message_id: string | null;
        executed_job_id: string;
        error_code: string | null;
        audit_entry: string;
      };
    expect(executionRow).toMatchObject({
      action_type: 'schedule_background_task',
      status: 'success',
      executed_message_id: null,
      executed_job_id: jobId,
      error_code: null,
    });
    expect(executionRow.audit_entry).toContain('background_task_scheduled=true');

    const serializedEvidence = JSON.stringify({ jobRow, executionRow, result });
    expect(serializedEvidence).not.toContain(rawSecret);
    expect(serializedEvidence).not.toContain(rawPlatformId);
    expect(serializedEvidence).not.toContain('22334455667');
    expect(serializedEvidence).not.toContain('do not copy secret');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('converges multiple same-window background summary actions on one durable job', async () => {
    const sendMessage = vi.fn(async () => 'background-task-should-not-send');
    useGroupTurn('group-alpha', 'group:alpha');
    enableGroupSummaries('group-alpha');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, {
      jobRepository: jobRepo,
      summaryJobService: groupSummaryJobs,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['multiple_background_tasks_requested'],
      suppressors: [],
      actions: [
        {
          type: 'schedule_background_task',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            backgroundTask: {
              type: 'summary',
              payload: {
                conversationId: 'group:alpha',
                conversationType: 'group',
              },
            },
          },
          constraints: {},
          reason: 'Schedule first summary task',
        },
        {
          type: 'schedule_background_task',
          priority: 90,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            backgroundTask: {
              type: 'summary',
              payload: {
                conversationId: 'group:alpha',
                conversationType: 'group',
              },
            },
          },
          constraints: {},
          reason: 'Schedule second summary task',
        },
      ],
    });

    const results = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.actionType === 'schedule_background_task')).toBe(true);
    expect(results.every((result) => result.status === 'success')).toBe(true);

    const executedJobIds = results
      .map((result) => result.executed?.jobId)
      .filter((jobId): jobId is string => typeof jobId === 'string');
    expect(executedJobIds).toHaveLength(2);
    expect(new Set(executedJobIds).size).toBe(1);

    const jobRows = db
      .prepare('SELECT id, type, payload, idempotency_key, status FROM jobs ORDER BY created_at ASC, id ASC')
      .all() as Array<{
        id: string;
        type: string;
        payload: string;
        idempotency_key: string;
        status: string;
      }>;
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.idempotency_key).toMatch(/^summary:group-window:v1:[a-f0-9]{32}$/);
    expect(jobRows.every((row) => row.type === 'summary')).toBe(true);
    expect(jobRows.every((row) => row.status === 'pending')).toBe(true);

    const payloadConversationIds = jobRows.map((row) => {
      const payload = JSON.parse(row.payload) as {
        conversationId?: string;
        taskPayload?: { conversationId?: string };
      };
      return payload.taskPayload?.conversationId ?? payload.conversationId;
    });
    expect(payloadConversationIds).toEqual(['group:alpha']);

    const executionRows = db
      .prepare(
        `SELECT action_type, status, executed_job_id, error_code
         FROM action_executions WHERE action_decision_id = ?
         ORDER BY executed_at ASC, id ASC`,
      )
      .all(decision.id) as Array<{
        action_type: string;
        status: string;
        executed_job_id: string | null;
        error_code: string | null;
      }>;
    expect(executionRows).toHaveLength(2);
    expect(new Set(executionRows.map((row) => row.executed_job_id))).toEqual(new Set(executedJobIds));
    expect(executionRows.every((row) => row.error_code === null)).toBe(true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('keeps duplicate non-summary jobs distinct while converging one summary window', async () => {
    const sendMessage = vi.fn(async () => 'duplicate-durable-job-should-not-send');
    useGroupTurn('group-alpha', 'group:alpha');
    enableGroupSummaries('group-alpha');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, {
      jobRepository: jobRepo,
      summaryJobService: groupSummaryJobs,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.8,
      evaluatorRequired: false,
      reasons: ['multiple_generated_durable_jobs_requested'],
      suppressors: [],
      actions: [
        {
          type: 'admin_digest',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {},
          constraints: {},
          reason: 'Schedule first admin digest',
        },
        {
          type: 'admin_digest',
          priority: 90,
          target: {
            conversationId: 'group:beta',
            conversationType: 'group',
            groupId: 'group-beta',
          },
          payload: {},
          constraints: {},
          reason: 'Schedule second admin digest',
        },
        {
          type: 'silent_summarize_later',
          priority: 80,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {},
          constraints: {},
          reason: 'Schedule first silent summary',
        },
        {
          type: 'silent_summarize_later',
          priority: 70,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {},
          constraints: {},
          reason: 'Schedule second silent summary',
        },
      ],
    });

    const results = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.status === 'success')).toBe(true);
    expect(results.map((result) => result.actionType)).toEqual([
      'admin_digest',
      'admin_digest',
      'silent_summarize_later',
      'silent_summarize_later',
    ]);

    const executedJobIds = results
      .map((result) => result.executed?.jobId)
      .filter((jobId): jobId is string => typeof jobId === 'string');
    expect(executedJobIds).toHaveLength(4);
    expect(new Set(executedJobIds).size).toBe(3);

    const jobRows = db
      .prepare('SELECT id, type, payload, idempotency_key, status FROM jobs ORDER BY created_at ASC, id ASC')
      .all() as Array<{
        id: string;
        type: string;
        payload: string;
        idempotency_key: string;
        status: string;
      }>;
    expect(jobRows).toHaveLength(3);
    expect(new Set(
      jobRows.filter((row) => row.type === 'admin_digest').map((row) => row.idempotency_key),
    )).toEqual(new Set([
      `action:admin_digest:${decision.id}:action1`,
      `action:admin_digest:${decision.id}:action2`,
    ]));
    expect(jobRows.find((row) => row.type === 'summary')?.idempotency_key)
      .toMatch(/^summary:group-window:v1:[a-f0-9]{32}$/);
    expect(jobRows.every((row) => row.status === 'pending')).toBe(true);
    expect(jobRows.filter((row) => row.type === 'admin_digest')).toHaveLength(2);
    expect(jobRows.filter((row) => row.type === 'summary')).toHaveLength(1);

    const summaryConversationIds = jobRows
      .filter((row) => row.type === 'summary')
      .map((row) => {
        const payload = JSON.parse(row.payload) as { conversationId?: string };
        return payload.conversationId;
      });
    expect(summaryConversationIds).toEqual(['group:alpha']);

    const executionRows = db
      .prepare(
        `SELECT action_type, status, executed_job_id, error_code
         FROM action_executions WHERE action_decision_id = ?
         ORDER BY executed_at ASC, id ASC`,
      )
      .all(decision.id) as Array<{
        action_type: string;
        status: string;
        executed_job_id: string | null;
        error_code: string | null;
      }>;
    expect(executionRows).toHaveLength(4);
    expect(new Set(executionRows.map((row) => row.executed_job_id))).toEqual(new Set(executedJobIds));
    expect(executionRows.every((row) => row.status === 'success')).toBe(true);
    expect(executionRows.every((row) => row.error_code === null)).toBe(true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects prohibited durable local actions before job or memory writes', async () => {
    const sendMessage = vi.fn(async () => 'durable-action-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, {
      jobRepository: jobRepo,
      memoryRepository: memoryRepo,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'prohibited',
      confidence: 0.1,
      evaluatorRequired: false,
      reasons: ['l0_prohibited'],
      suppressors: ['policy_prohibited'],
      actions: [
        {
          type: 'admin_digest',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {},
          constraints: {},
          reason: 'Policy prohibited admin digest',
        },
        {
          type: 'propose_memory',
          priority: 90,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            memoryProposal: {
              scope: 'user',
              canonicalUserId: 'user-alice',
              kind: 'preference',
              title: 'Alice prefers tea',
              content: 'Alice prefers tea for late work sessions',
              confidence: 0.8,
              sourceContext: 'private_chat',
            },
          },
          constraints: {},
          reason: 'Policy prohibited memory proposal',
        },
        {
          type: 'schedule_background_task',
          priority: 80,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            backgroundTask: {
              type: 'summary',
              payload: {
                conversationId: 'group:alpha',
                conversationType: 'group',
              },
            },
          },
          constraints: {},
          reason: 'Policy prohibited background task',
        },
      ],
    });

    const results = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(results).toHaveLength(3);
    expect(results.map((result) => result.actionType)).toEqual([
      'admin_digest',
      'propose_memory',
      'schedule_background_task',
    ]);
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'rejected',
        error: {
          code: 'PROHIBITED_ACTION_DECISION',
          recoverable: false,
        },
      });
    }

    expect((db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get() as { count: number }).count).toBe(0);

    const executionRows = db
      .prepare(
        `SELECT action_type, status, executed_job_id, executed_memory_id, error_code
         FROM action_executions WHERE action_decision_id = ?
         ORDER BY action_type`,
      )
      .all(decision.id) as Array<{
        action_type: string;
        status: string;
        executed_job_id: string | null;
        executed_memory_id: string | null;
        error_code: string;
      }>;
    expect(executionRows).toHaveLength(3);
    expect(executionRows.every((row) => row.status === 'rejected')).toBe(true);
    expect(executionRows.every((row) => row.error_code === 'PROHIBITED_ACTION_DECISION')).toBe(true);
    expect(executionRows.every((row) => row.executed_job_id === null)).toBe(true);
    expect(executionRows.every((row) => row.executed_memory_id === null)).toBe(true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects evaluator-required durable local actions before job or memory writes', async () => {
    const sendMessage = vi.fn(async () => 'durable-action-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage }, {
      jobRepository: jobRepo,
      memoryRepository: memoryRepo,
    });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'high',
      confidence: 0.3,
      evaluatorRequired: true,
      evaluatorPassed: false,
      reasons: ['durable_local_action_requires_review'],
      suppressors: ['evaluator_pending'],
      actions: [
        {
          type: 'admin_digest',
          priority: 100,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {},
          constraints: {
            evaluatorRequired: true,
          },
          reason: 'Evaluator required admin digest',
        },
        {
          type: 'propose_memory',
          priority: 90,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            memoryProposal: {
              scope: 'user',
              canonicalUserId: 'user-alice',
              kind: 'preference',
              title: 'Alice prefers tea',
              content: 'Alice prefers tea for late work sessions',
              confidence: 0.8,
              sourceContext: 'private_chat',
            },
          },
          constraints: {
            evaluatorRequired: true,
          },
          reason: 'Evaluator required memory proposal',
        },
        {
          type: 'schedule_background_task',
          priority: 80,
          target: {
            conversationId: 'group:alpha',
            conversationType: 'group',
            groupId: 'group-alpha',
          },
          payload: {
            backgroundTask: {
              type: 'summary',
              payload: {
                conversationId: 'group:alpha',
                conversationType: 'group',
              },
            },
          },
          constraints: {
            evaluatorRequired: true,
          },
          reason: 'Evaluator required background task',
        },
      ],
    });

    const results = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(results).toHaveLength(3);
    expect(results.map((result) => result.actionType)).toEqual([
      'admin_digest',
      'propose_memory',
      'schedule_background_task',
    ]);
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'rejected',
        error: {
          code: 'EVALUATOR_NOT_PASSED',
          recoverable: false,
        },
      });
    }

    expect((db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_sources').get() as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM memory_revisions').get() as { count: number }).count).toBe(0);

    const executionRows = db
      .prepare(
        `SELECT action_type, status, executed_job_id, executed_memory_id, error_code
         FROM action_executions WHERE action_decision_id = ?
         ORDER BY action_type`,
      )
      .all(decision.id) as Array<{
        action_type: string;
        status: string;
        executed_job_id: string | null;
        executed_memory_id: string | null;
        error_code: string;
      }>;
    expect(executionRows).toHaveLength(3);
    expect(executionRows.every((row) => row.status === 'rejected')).toBe(true);
    expect(executionRows.every((row) => row.error_code === 'EVALUATOR_NOT_PASSED')).toBe(true);
    expect(executionRows.every((row) => row.executed_job_id === null)).toBe(true);
    expect(executionRows.every((row) => row.executed_memory_id === null)).toBe(true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects evaluator-required reply actions when evaluator did not pass', async () => {
    const sendMessage = vi.fn(async () => 'reply-msg-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'medium',
      confidence: 0.4,
      evaluatorRequired: true,
      evaluatorPassed: false,
      reasons: ['needs_evaluation'],
      suppressors: ['evaluator_reject'],
      actions: [
        {
          type: 'reply_full',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            text: 'Should not send',
          },
          constraints: {
            evaluatorRequired: true,
          },
          reason: 'Rejected by evaluator',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'reply_full',
      status: 'rejected',
      error: {
        code: 'EVALUATOR_NOT_PASSED',
        recoverable: false,
      },
    });

    const row = db
      .prepare('SELECT status, error_code, executed_message_id FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as { status: string; error_code: string; executed_message_id: string | null };
    expect(row).toMatchObject({
      status: 'rejected',
      error_code: 'EVALUATOR_NOT_PASSED',
      executed_message_id: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('rejects prohibited action decisions before side effects', async () => {
    const sendMessage = vi.fn(async () => 'reply-msg-should-not-send');
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'prohibited',
      confidence: 0.1,
      evaluatorRequired: false,
      reasons: ['l0_prohibited'],
      suppressors: ['policy_prohibited'],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            text: 'Should not send',
          },
          constraints: {},
          reason: 'Policy prohibited',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      actionType: 'reply_short',
      status: 'rejected',
      error: {
        code: 'PROHIBITED_ACTION_DECISION',
        recoverable: false,
      },
    });

    const row = db
      .prepare('SELECT status, error_code, executed_message_id FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as { status: string; error_code: string; executed_message_id: string | null };
    expect(row).toMatchObject({
      status: 'rejected',
      error_code: 'PROHIBITED_ACTION_DECISION',
      executed_message_id: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts reply send failure secrets and platform ids before persisting errors', async () => {
    const rawSecret = 'sk-action-executor-reply-secret-should-not-persist';
    const rawPlatformId = 'qq-1234567890';
    const rawBarePlatformId = '12345678901';
    const sendMessage = vi.fn(async () => {
      throw new Error(
        `simulated reply failure api_key=${rawSecret} target=${rawPlatformId} peer=${rawBarePlatformId}`,
      );
    });
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: ['reply_requested'],
      suppressors: [],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            text: 'Reply text',
          },
          constraints: {},
          reason: 'Reply to user',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({
      actionType: 'reply_short',
      status: 'failed',
      error: {
        code: 'SEND_MESSAGE_FAILED',
        recoverable: true,
      },
    });
    expect(result?.error?.message).toContain('[REDACTED:api_key_assignment]');
    expect(result?.error?.message).toContain('[REDACTED:platform_id]');
    expect(result?.error?.message).toContain('simulated reply failure');
    expect(result?.error?.message).not.toContain(rawSecret);
    expect(result?.error?.message).not.toContain(rawPlatformId);
    expect(result?.error?.message).not.toContain(rawBarePlatformId);

    const row = db
      .prepare('SELECT status, error_code, error_message FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as { status: string; error_code: string; error_message: string };
    expect(row).toMatchObject({
      status: 'failed',
      error_code: 'SEND_MESSAGE_FAILED',
    });
    expect(row.error_message).toBe(result?.error?.message);
    expect(row.error_message).not.toContain(rawSecret);
    expect(row.error_message).not.toContain(rawPlatformId);
    expect(row.error_message).not.toContain(rawBarePlatformId);
  });

  it('redacts embedded platform identifiers in reply send failures before persisting errors', async () => {
    const embeddedPrefixedPlatformId = 'legacy_qq-1234567890';
    const embeddedNumericPlatformId = 'legacy_987654321';
    const sendMessage = vi.fn(async () => {
      throw new Error(
        `simulated reply failure target=${embeddedPrefixedPlatformId} peer=${embeddedNumericPlatformId}`,
      );
    });
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: ['reply_requested'],
      suppressors: [],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            text: 'Reply text',
          },
          constraints: {},
          reason: 'Reply to user',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({
      actionType: 'reply_short',
      status: 'failed',
      error: {
        code: 'SEND_MESSAGE_FAILED',
        recoverable: true,
      },
    });
    expect(result?.error?.message).toContain('[REDACTED:platform_id]');
    expect(result?.error?.message).toContain('simulated reply failure');
    expect(result?.error?.message).not.toContain(embeddedPrefixedPlatformId);
    expect(result?.error?.message).not.toContain(embeddedNumericPlatformId);
    expect(result?.error?.message).not.toContain('legacy_qq-');
    expect(result?.error?.message).not.toContain('1234567890');
    expect(result?.error?.message).not.toContain('987654321');

    const row = db
      .prepare('SELECT status, error_code, error_message FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as { status: string; error_code: string; error_message: string };
    expect(row).toMatchObject({
      status: 'failed',
      error_code: 'SEND_MESSAGE_FAILED',
    });
    expect(row.error_message).toBe(result?.error?.message);
    expect(row.error_message).not.toContain(embeddedPrefixedPlatformId);
    expect(row.error_message).not.toContain(embeddedNumericPlatformId);
    expect(row.error_message).not.toContain('legacy_qq-');
    expect(row.error_message).not.toContain('1234567890');
    expect(row.error_message).not.toContain('987654321');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves markers for adjacent secret/platform reply send failure errors', async () => {
    const adjacentSecretPlatform =
      'sk-action-executor-adjacent-secret-should-not-persist-qq-12345678911';
    const sendMessage = vi.fn(async () => {
      throw new Error(`simulated adjacent reply failure ${adjacentSecretPlatform}`);
    });
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: ['reply_requested'],
      suppressors: [],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            text: 'Reply text',
          },
          constraints: {},
          reason: 'Reply to user',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({
      actionType: 'reply_short',
      status: 'failed',
      error: {
        code: 'SEND_MESSAGE_FAILED',
        recoverable: true,
      },
    });
    expect(result?.error?.message).toContain('[REDACTED:openai_like_api_key]');
    expect(result?.error?.message).toContain('[REDACTED:platform_id]');
    expect(result?.error?.message).toContain('simulated adjacent reply failure');
    expect(result?.error?.message).not.toContain('sk-action-executor-adjacent');
    expect(result?.error?.message).not.toContain('qq-12345678911');
    expect(result?.error?.message).not.toContain('12345678911');

    const row = db
      .prepare('SELECT status, error_code, error_message FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as { status: string; error_code: string; error_message: string };
    expect(row).toMatchObject({
      status: 'failed',
      error_code: 'SEND_MESSAGE_FAILED',
    });
    expect(row.error_message).toBe(result?.error?.message);
    expect(row.error_message).not.toContain('sk-action-executor-adjacent');
    expect(row.error_message).not.toContain('qq-12345678911');
    expect(row.error_message).not.toContain('12345678911');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for assignment-shaped adjacent reply send failure errors', async () => {
    const adjacentSecretPlatform =
      'sk-action-executor-assignment-adjacent-secret-qq-12345678911';
    const sendMessage = vi.fn(async () => {
      throw new Error(`simulated adjacent assignment reply failure api_key=${adjacentSecretPlatform}`);
    });
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'pi',
      riskLevel: 'low',
      confidence: 0.9,
      evaluatorRequired: false,
      reasons: ['reply_requested'],
      suppressors: [],
      actions: [
        {
          type: 'reply_short',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            text: 'Reply text',
          },
          constraints: {},
          reason: 'Reply to user',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({
      actionType: 'reply_short',
      status: 'failed',
      error: {
        code: 'SEND_MESSAGE_FAILED',
        recoverable: true,
      },
    });
    expect(result?.error?.message).toContain('[REDACTED:api_key_assignment]');
    expect(result?.error?.message).toContain('[REDACTED:platform_id]');
    expect(result?.error?.message).toContain('simulated adjacent assignment reply failure');
    expect(result?.error?.message).not.toContain('sk-action-executor-assignment');
    expect(result?.error?.message).not.toContain('qq-12345678911');
    expect(result?.error?.message).not.toContain('12345678911');

    const row = db
      .prepare('SELECT status, error_code, error_message FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as { status: string; error_code: string; error_message: string };
    expect(row).toMatchObject({
      status: 'failed',
      error_code: 'SEND_MESSAGE_FAILED',
    });
    expect(row.error_message).toBe(result?.error?.message);
    expect(row.error_message).not.toContain('sk-action-executor-assignment');
    expect(row.error_message).not.toContain('qq-12345678911');
    expect(row.error_message).not.toContain('12345678911');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts dm_user send failure secrets and platform ids before persisting errors', async () => {
    const rawSecret = 'sk-action-executor-dm-secret-should-not-persist';
    const rawPlatformId = 'qq-9876543210';
    const sendMessage = vi.fn(async () => {
      throw new Error(`simulated DM failure token=${rawSecret} target=${rawPlatformId}`);
    });
    const executor = new ActionExecutor(actionRepo, { sendMessage });
    const decision = await createApprovedDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'evaluator',
      riskLevel: 'medium',
      confidence: 0.8,
      evaluatorRequired: true,
      evaluatorPassed: true,
      reasons: ['memory_review'],
      suppressors: [],
      actions: [
        {
          type: 'dm_user',
          priority: 100,
          target: {
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
          },
          payload: {
            text: 'A proactive reminder',
          },
          constraints: {
            proactive: true,
            proactiveTrigger: 'memory_review',
            evaluatorRequired: true,
          },
          reason: 'Evaluator proposed proactive DM',
        },
      ],
    });

    const [result] = await executor.execute(decision);

    expect(result).toMatchObject({
      actionType: 'dm_user',
      status: 'failed',
      error: {
        code: 'SEND_DM_FAILED',
        recoverable: true,
      },
    });
    expect(result?.error?.message).toContain('[REDACTED:token_assignment]');
    expect(result?.error?.message).toContain('[REDACTED:platform_id]');
    expect(result?.error?.message).toContain('simulated DM failure');
    expect(result?.error?.message).not.toContain(rawSecret);
    expect(result?.error?.message).not.toContain(rawPlatformId);

    const row = db
      .prepare('SELECT status, error_code, error_message, audit_entry FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as {
        status: string;
        error_code: string;
        error_message: string;
        audit_entry: string;
      };
    expect(row).toMatchObject({
      status: 'failed',
      error_code: 'SEND_DM_FAILED',
    });
    expect(row.error_message).toBe(result?.error?.message);
    expect(row.error_message).not.toContain(rawSecret);
    expect(row.error_message).not.toContain(rawPlatformId);
    expect(row.audit_entry).toContain('dm_proactive=true');
    expect(row.audit_entry).toContain('dm_trigger=memory_review');
    expect(row.audit_entry).toContain('dm_opt_out=not_checked');
    expect(row.audit_entry).toContain('dm_redaction_level=default');
    expect(row.audit_entry).toContain('dm_cooldown_key=none');
  });
});
