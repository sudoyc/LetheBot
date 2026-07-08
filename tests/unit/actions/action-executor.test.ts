import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { ActionRepository } from '../../../src/actions/action-repository';
import { ActionExecutor } from '../../../src/actions/executor';
import { PrivacyPreferenceRepository } from '../../../src/storage/privacy-preference-repository';

describe('ActionExecutor privacy enforcement', () => {
  let testDir: string;
  let db: Database.Database;
  let actionRepo: ActionRepository;
  let privacyRepo: PrivacyPreferenceRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-action-executor-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    actionRepo = new ActionRepository(db);
    privacyRepo = new PrivacyPreferenceRepository(db);

    const now = Date.now();
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
      .run('user-alice', now, now);
    db.prepare(
      `INSERT INTO raw_events (id, type, timestamp, source, platform, conversation_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('evt-action-privacy', 'message.private', now, 'gateway', 'qq', 'private:user-alice', '{}', now);
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
    const executor = new ActionExecutor(actionRepo, { sendMessage }, { privacyPreferences: privacyRepo });
    const decision = await actionRepo.createDecision({
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

    expect(sendMessage).not.toHaveBeenCalled();
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
    const executor = new ActionExecutor(actionRepo, { sendMessage }, { privacyPreferences: privacyRepo });
    const decision = await actionRepo.createDecision({
      turnId: 'turn-action-privacy',
      decidedBy: 'evaluator',
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
            conversationId: 'private:user-alice',
            conversationType: 'private',
            userId: 'user-alice',
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

    expect(sendMessage).toHaveBeenCalledWith(
      {
        conversationId: 'private:user-alice',
        conversationType: 'private',
        userId: 'user-alice',
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
      decidedBy: 'evaluator',
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
      decidedBy: 'evaluator',
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
      decidedBy: 'evaluator',
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
      decidedBy: 'evaluator',
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
    const decision = await actionRepo.createDecision({
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
      .prepare('SELECT status, error_code, error_message FROM action_executions WHERE action_decision_id = ?')
      .get(decision.id) as { status: string; error_code: string; error_message: string };
    expect(row).toMatchObject({
      status: 'failed',
      error_code: 'SEND_DM_FAILED',
    });
    expect(row.error_message).toBe(result?.error?.message);
    expect(row.error_message).not.toContain(rawSecret);
    expect(row.error_message).not.toContain(rawPlatformId);
  });
});
