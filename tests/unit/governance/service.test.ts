import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GovernanceService } from '../../../src/governance/service.js';
import {
  closeDatabase,
  initDatabase,
  runMigrations,
} from '../../../src/storage/database.js';
import { GroupSummaryPolicyRepository } from '../../../src/storage/group-summary-policy-repository.js';
import { JobRepository } from '../../../src/storage/job-repository.js';
import { MemoryRepository } from '../../../src/storage/memory-repository.js';
import { TurnRepository } from '../../../src/storage/turn-repository.js';

const BASE_TIME = Date.parse('2026-07-14T00:00:00.000Z');
const BOT_OWNER_QQ_ID = '90001';

interface StoredSource {
  rawEventId: string;
  chatMessageId: string;
  conversationId: string;
  groupId?: string;
  canonicalUserId: string;
}

describe('GovernanceService', () => {
  let root: string;
  let db: Database.Database;
  let memories: MemoryRepository;
  let policies: GroupSummaryPolicyRepository;
  let service: GovernanceService;
  let sequence: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lethebot-governance-service-'));
    db = initDatabase({ path: join(root, 'test.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    memories = new MemoryRepository(db);
    policies = new GroupSummaryPolicyRepository(db);
    service = new GovernanceService(db, memories, policies);
    sequence = 0;
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(root, { recursive: true, force: true });
  });

  it('reparses persisted evidence and denies unverified or unauthorized command sources', async () => {
    const member = insertQqSource({
      suffix: 'member',
      qqId: '71001',
      groupId: 'qq-group-81001',
      role: 'member',
      text: '/memory',
    });
    expect(await service.handleQqCommand({ sourceEventId: member.rawEventId })).toEqual({
      outcome: 'denied',
      responseText: 'Governance command denied.',
    });

    const invalidAdmin = insertQqSource({
      suffix: 'invalid-admin',
      qqId: '71002',
      groupId: 'qq-group-81001',
      role: 'admin',
      text: '/memory list',
    });
    expect(await service.handleQqCommand({ sourceEventId: invalidAdmin.rawEventId }))
      .toEqual({
        outcome: 'invalid_usage',
        responseText:
          'Usage: /memory | /memory forget <memory-id> | /memory summary status|enable|disable',
      });

    const privateOwner = insertQqSource({
      suffix: 'private-owner',
      qqId: BOT_OWNER_QQ_ID,
      text: '/memory',
    });
    expect(await service.handleQqCommand({ sourceEventId: privateOwner.rawEventId }))
      .toMatchObject({ outcome: 'denied' });
    expect(await service.handleQqCommand({
      sourceEventId: privateOwner.rawEventId,
      botOwnerQqId: ` ${BOT_OWNER_QQ_ID}`,
    })).toMatchObject({ outcome: 'denied' });
    expect(await service.handleQqCommand({
      sourceEventId: privateOwner.rawEventId,
      botOwnerQqId: BOT_OWNER_QQ_ID,
    })).toEqual({ outcome: 'memory_listed', responseText: 'Memory records: none.' });

    const narrative = insertQqSource({
      suffix: 'narrative',
      qqId: '71003',
      groupId: 'qq-group-81001',
      role: 'owner',
      text: 'please discuss memory settings',
    });
    expect(await service.handleQqCommand({ sourceEventId: narrative.rawEventId })).toBeNull();

    const forged = insertQqSource({
      suffix: 'forged',
      qqId: '71004',
      groupId: 'qq-group-81001',
      role: 'admin',
      text: '/memory',
    });
    db.prepare('UPDATE chat_messages SET sender_role = ? WHERE id = ?')
      .run('owner', forged.chatMessageId);
    expect(await service.handleQqCommand({ sourceEventId: forged.rawEventId })).toEqual({
      outcome: 'invalid_source',
      responseText: 'Governance command could not be verified.',
    });

    const ambiguousGroupId = 'qq-group-81002';
    const ambiguous = insertQqSource({
      suffix: 'ambiguous-chat-row',
      qqId: '71005',
      groupId: ambiguousGroupId,
      role: 'admin',
      text: '/memory summary enable',
    });
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         group_id, sender_id, sender_role, text, timestamp
       ) VALUES (?, ?, ?, ?, 'group', ?, 'qq-79999', 'member', ?, ?)`,
    ).run(
      'chat-ambiguous-unmapped-sender',
      ambiguous.rawEventId,
      'qq-message-ambiguous-unmapped-sender',
      ambiguous.conversationId,
      ambiguousGroupId,
      '/memory summary enable',
      BASE_TIME,
    );
    expect(await service.handleQqCommand({ sourceEventId: ambiguous.rawEventId })).toEqual({
      outcome: 'invalid_source',
      responseText: 'Governance command could not be verified.',
    });
    expect(policies.get(ambiguousGroupId)).toBeNull();

    for (const [suffix, groupId] of [
      ['unknown-group', 'qq-group-unknown'],
      ['double-prefixed-group', 'qq-group-qq-81003'],
    ] as const) {
      const malformedScope = insertQqSource({
        suffix,
        qqId: '71006',
        groupId,
        role: 'admin',
        text: '/memory summary enable',
      });
      expect(await service.handleQqCommand({ sourceEventId: malformedScope.rawEventId })).toEqual({
        outcome: 'invalid_source',
        responseText: 'Governance command could not be verified.',
      });
      expect(policies.get(groupId)).toBeNull();
    }
    const malformedNarrative = insertQqSource({
      suffix: 'unknown-group-narrative',
      qqId: '71006',
      groupId: 'qq-group-unknown',
      role: 'admin',
      text: 'ordinary malformed-scope narrative',
    });
    expect(await service.handleQqCommand({ sourceEventId: malformedNarrative.rawEventId })).toBeNull();

    expect(await service.handleQqCommand({ sourceEventId: 'missing-source' })).toEqual({
      outcome: 'invalid_source',
      responseText: 'Governance command could not be verified.',
    });
    expectIntegrity();
  });

  it('keeps group listing group-safe even for the bot owner and redacts bounded output', async () => {
    const currentGroup = 'qq-group-82001';
    const otherGroup = 'qq-group-82002';
    const currentSource = insertQqSource({
      suffix: 'current-source',
      qqId: '72001',
      groupId: currentGroup,
      role: 'admin',
      text: 'Synthetic current-group governance source.',
    });
    const otherSource = insertQqSource({
      suffix: 'other-source',
      qqId: '72002',
      groupId: otherGroup,
      role: 'admin',
      text: 'Synthetic other-group governance source.',
    });
    const privateSource = insertQqSource({
      suffix: 'private-source',
      qqId: '72003',
      text: 'Synthetic private governance source.',
    });

    createMemory({
      id: 'mem-visible-current',
      scope: 'group',
      groupId: currentGroup,
      visibility: 'same_group_only',
      source: currentSource,
    });
    createMemory({
      id: 'mem-private-current',
      scope: 'group',
      groupId: currentGroup,
      visibility: 'private_only',
      source: currentSource,
    });
    createMemory({
      id: 'mem-visible-other',
      scope: 'group',
      groupId: otherGroup,
      visibility: 'same_group_only',
      source: otherSource,
    });
    createMemory({
      id: 'mem-same-group-user',
      scope: 'user',
      canonicalUserId: currentSource.canonicalUserId,
      groupId: currentGroup,
      visibility: 'same_group_only',
      state: 'proposed',
      source: currentSource,
    });
    createMemory({
      id: 'mem-private-user',
      scope: 'user',
      canonicalUserId: privateSource.canonicalUserId,
      visibility: 'private_only',
      source: privateSource,
    });
    createMemory({
      id: 'mem-cq-title',
      scope: 'group',
      groupId: currentGroup,
      visibility: 'same_group_only',
      source: currentSource,
    });
    db.prepare('UPDATE memory_records SET title = ? WHERE id = ?').run(
      '[CQ:at,qq=all]&literal',
      'mem-cq-title',
    );
    memories.createSync({
      id: 'mem-global',
      scope: 'global',
      visibility: 'owner_admin_only',
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: 'Synthetic global governance fixture',
      content: 'Synthetic global governance content',
      state: 'active',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: 'admin_cli',
      sources: [{
        sourceType: 'user_command',
        sourceId: 'governance-service-global-fixture',
        external: true,
        extractedBy: 'user',
      }],
      actor: {
        canonicalUserId: 'local_admin',
        actorClass: 'admin',
        context: 'admin_cli',
      },
    });
    const rawSecret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const rawPlatformId = 'qq-123456789';
    db.prepare('UPDATE memory_records SET title = ? WHERE id = ?').run(
      `legacy api_key=${rawSecret} target=${rawPlatformId} ${'x'.repeat(256)}`,
      'mem-visible-current',
    );

    const groupCommand = insertQqSource({
      suffix: 'group-owner-list',
      qqId: BOT_OWNER_QQ_ID,
      groupId: currentGroup,
      role: 'member',
      text: '/memory',
    });
    const groupResult = await service.handleQqCommand({
      sourceEventId: groupCommand.rawEventId,
      botOwnerQqId: BOT_OWNER_QQ_ID,
    });
    expect(groupResult?.outcome).toBe('memory_listed');
    expect(groupResult?.responseText).toContain('mem-visible-current');
    expect(groupResult?.responseText).toContain('mem-same-group-user');
    expect(groupResult?.responseText).toContain('[REDACTED:api_key_assignment]');
    expect(groupResult?.responseText).toContain('[REDACTED:platform_id]');
    expect(groupResult?.responseText).not.toContain(rawSecret);
    expect(groupResult?.responseText).not.toContain(rawPlatformId);
    expect(groupResult?.responseText).toContain('&#91;CQ:at,qq=all&#93;&amp;literal');
    expect(groupResult?.responseText).not.toContain('[CQ:');
    expect(groupResult?.responseText).not.toContain('mem-private-current');
    expect(groupResult?.responseText).not.toContain('mem-visible-other');
    expect(groupResult?.responseText).not.toContain('mem-private-user');
    expect(groupResult?.responseText).not.toContain('mem-global');
    expect(groupResult?.responseText.length).toBeLessThanOrEqual(2_048);

    const privateCommand = insertQqSource({
      suffix: 'private-owner-list',
      qqId: BOT_OWNER_QQ_ID,
      text: '/memory',
    });
    const privateResult = await service.handleQqCommand({
      sourceEventId: privateCommand.rawEventId,
      botOwnerQqId: BOT_OWNER_QQ_ID,
    });
    expect(privateResult?.outcome).toBe('memory_listed');
    expect(privateResult?.responseText).toContain('mem-visible-current');
    expect(privateResult?.responseText).toContain('mem-private-current');
    expect(privateResult?.responseText).toContain('mem-visible-other');
    expect(privateResult?.responseText).toContain('mem-private-user');
    expect(privateResult?.responseText).toContain('mem-global');
    expectIntegrity();
  });

  it('enforces forget scope and records exact QQ and local-admin mutation evidence', async () => {
    const currentGroup = 'qq-group-83001';
    const otherGroup = 'qq-group-83002';
    const currentSource = insertQqSource({
      suffix: 'forget-current-source',
      qqId: '73001',
      groupId: currentGroup,
      role: 'admin',
      text: 'Synthetic exact-group memory source.',
    });
    const otherSource = insertQqSource({
      suffix: 'forget-other-source',
      qqId: '73002',
      groupId: otherGroup,
      role: 'admin',
      text: 'Synthetic other-group memory source.',
    });
    const privateSource = insertQqSource({
      suffix: 'forget-private-source',
      qqId: '73003',
      text: 'Synthetic private memory source.',
    });
    createMemory({
      id: 'mem-forget-current',
      scope: 'group',
      groupId: currentGroup,
      visibility: 'same_group_only',
      source: currentSource,
      content: 'exactgroupforgettoken',
    });
    createMemory({
      id: 'mem-forget-private-current',
      scope: 'group',
      groupId: currentGroup,
      visibility: 'private_only',
      source: currentSource,
    });
    createMemory({
      id: 'mem-forget-sensitive-current',
      scope: 'group',
      groupId: currentGroup,
      visibility: 'same_group_only',
      source: currentSource,
    });
    db.prepare('UPDATE memory_records SET sensitivity = ? WHERE id = ?')
      .run('secret', 'mem-forget-sensitive-current');
    createMemory({
      id: 'mem-forget-other',
      scope: 'group',
      groupId: otherGroup,
      visibility: 'same_group_only',
      source: otherSource,
    });
    createMemory({
      id: 'mem-forget-local',
      scope: 'user',
      canonicalUserId: privateSource.canonicalUserId,
      visibility: 'private_only',
      source: privateSource,
    });

    for (const [suffix, memoryId] of [
      ['other', 'mem-forget-other'],
      ['private', 'mem-forget-private-current'],
      ['sensitive', 'mem-forget-sensitive-current'],
    ] as const) {
      const command = insertQqSource({
        suffix: `forget-denied-${suffix}`,
        qqId: '73001',
        groupId: currentGroup,
        role: 'admin',
        text: `/memory forget ${memoryId}`,
      });
      expect(await service.handleQqCommand({ sourceEventId: command.rawEventId }))
        .toMatchObject({ outcome: 'memory_unavailable' });
      expect(db.prepare('SELECT state FROM memory_records WHERE id = ?').get(memoryId))
        .toEqual({ state: 'active' });
    }

    const exactCommand = insertQqSource({
      suffix: 'forget-exact',
      qqId: '73001',
      groupId: currentGroup,
      role: 'admin',
      text: '/memory forget mem-forget-current',
    });
    expect(await service.handleQqCommand({ sourceEventId: exactCommand.rawEventId }))
      .toEqual({ outcome: 'memory_forgotten', responseText: 'Memory record deleted.' });
    expect(db.prepare('SELECT state FROM memory_records WHERE id = ?').get('mem-forget-current'))
      .toEqual({ state: 'deleted' });
    expect((await memories.search('exactgroupforgettoken', {
      groupId: currentGroup,
      contextType: 'group',
      limit: 8,
    })).map((memory) => memory.id)).not.toContain('mem-forget-current');

    const exactRevision = db.prepare(
      `SELECT change_type, actor, reason
         FROM memory_revisions
        WHERE memory_id = ?
        ORDER BY revision_number DESC LIMIT 1`,
    ).get('mem-forget-current');
    expect(exactRevision).toEqual({
      change_type: 'delete',
      actor: currentSource.canonicalUserId,
      reason: 'QQ governance memory forget',
    });
    const exactAudit = db.prepare(
      `SELECT actor_user_id, actor_class, invocation_context, details
         FROM audit_log
        WHERE event_type = 'memory.delete' AND event_id = ?`,
    ).get('mem-forget-current') as {
      actor_user_id: string;
      actor_class: string;
      invocation_context: string;
      details: string;
    };
    expect(exactAudit).toMatchObject({
      actor_user_id: currentSource.canonicalUserId,
      actor_class: 'group_admin',
      invocation_context: 'group_chat',
    });
    expect(JSON.parse(exactAudit.details)).toMatchObject({
      sourceEventId: exactCommand.rawEventId,
      authority: 'group_admin',
      governanceCommand: 'memory_forget',
    });

    expect(service.forgetMemoryAsLocalAdmin('mem-forget-local')).toEqual({
      outcome: 'forgotten',
    });
    expect(db.prepare(
      `SELECT actor FROM memory_revisions
        WHERE memory_id = ? ORDER BY revision_number DESC LIMIT 1`,
    ).get('mem-forget-local')).toEqual({ actor: 'local_admin' });
    expect(db.prepare(
      `SELECT actor_user_id, actor_class, invocation_context
         FROM audit_log
        WHERE event_type = 'memory.delete' AND event_id = ?`,
    ).get('mem-forget-local')).toEqual({
      actor_user_id: 'local_admin',
      actor_class: 'admin',
      invocation_context: 'admin_cli',
    });
    expectIntegrity();
  });

  it('shares exact-group summary status, idempotency, cancellation, and re-enable semantics', async () => {
    const groupId = 'qq-group-84001';
    const actorQqId = '74001';
    const status = insertQqSource({
      suffix: 'summary-status',
      qqId: actorQqId,
      groupId,
      role: 'owner',
      text: '/memory summary status',
    });
    expect(await service.handleQqCommand({ sourceEventId: status.rawEventId })).toEqual({
      outcome: 'summary_status',
      responseText: 'Group summary policy is disabled.',
    });

    const enable = insertQqSource({
      suffix: 'summary-enable',
      qqId: actorQqId,
      groupId,
      role: 'owner',
      text: '/memory summary enable',
    });
    expect(await service.handleQqCommand({ sourceEventId: enable.rawEventId }))
      .toMatchObject({ outcome: 'summary_enabled' });
    const enabled = policies.get(groupId);
    expect(enabled).toMatchObject({ state: 'enabled', generation: 1 });

    const enableAgain = insertQqSource({
      suffix: 'summary-enable-again',
      qqId: actorQqId,
      groupId,
      role: 'owner',
      text: '/memory summary enable',
    });
    expect(await service.handleQqCommand({ sourceEventId: enableAgain.rawEventId }))
      .toMatchObject({ outcome: 'summary_enabled' });
    expect(policies.get(groupId)).toMatchObject({ state: 'enabled', generation: 1 });

    const jobNow = Math.max(Date.now(), enabled?.eligibleAfter ?? 0);
    const jobId = new JobRepository(db).enqueue({
      id: 'job-governance-summary-pending',
      type: 'summary',
      payload: { conversationId: groupId, conversationType: 'group', groupId },
      now: jobNow,
      scheduledAt: jobNow + 60_000,
    });
    policies.bindSummaryJob({ jobId, groupId, conversationId: groupId, now: jobNow });

    const disable = insertQqSource({
      suffix: 'summary-disable',
      qqId: actorQqId,
      groupId,
      role: 'owner',
      text: '/memory summary disable',
    });
    expect(await service.handleQqCommand({ sourceEventId: disable.rawEventId }))
      .toMatchObject({ outcome: 'summary_disabled' });
    expect(policies.get(groupId)).toMatchObject({ state: 'disabled', generation: 2 });
    expect(db.prepare('SELECT status, error FROM jobs WHERE id = ?').get(jobId)).toEqual({
      status: 'failed',
      error: 'group_summary_policy_disabled',
    });

    const reenable = insertQqSource({
      suffix: 'summary-reenable',
      qqId: actorQqId,
      groupId,
      role: 'owner',
      text: '/memory summary enable',
    });
    expect(await service.handleQqCommand({ sourceEventId: reenable.rawEventId }))
      .toMatchObject({ outcome: 'summary_enabled' });
    expect(policies.get(groupId)).toMatchObject({ state: 'enabled', generation: 3 });

    const auditRows = db.prepare(
      `SELECT actor_user_id, actor_class, invocation_context, details
         FROM audit_log
        WHERE event_type = 'group.summary_policy_changed'
        ORDER BY json_extract(details, '$.generation')`,
    ).all() as Array<{
      actor_user_id: string;
      actor_class: string;
      invocation_context: string;
      details: string;
    }>;
    expect(auditRows).toHaveLength(3);
    expect(auditRows.every((row) => (
      row.actor_user_id === status.canonicalUserId
      && row.actor_class === 'owner'
      && row.invocation_context === 'group_chat'
    ))).toBe(true);
    expect(auditRows.every((row) => (
      JSON.parse(row.details).groupId === '[REDACTED:platform_id]'
      && !row.details.includes(groupId)
    ))).toBe(true);
    expect(auditRows.map((row) => JSON.parse(row.details))).toEqual([
      expect.objectContaining({
        generation: 1,
        sourceEventId: enable.rawEventId,
        authority: 'group_owner',
        canceledJobCount: 0,
      }),
      expect.objectContaining({
        generation: 2,
        sourceEventId: disable.rawEventId,
        authority: 'group_owner',
        canceledJobCount: 1,
      }),
      expect.objectContaining({
        generation: 3,
        sourceEventId: reenable.rawEventId,
        authority: 'group_owner',
        canceledJobCount: 0,
      }),
    ]);
    expectIntegrity();
  });

  it('explains only the latest prior exact-conversation turn by raw ingress order', async () => {
    const turns = new TurnRepository(db);
    const groupId = 'qq-group-85001';
    const priorOne = insertQqSource({
      suffix: 'why-prior-one',
      qqId: '75001',
      groupId,
      role: 'admin',
      text: 'Synthetic prior one.',
    });
    await completeTurn(turns, priorOne, 7);
    const priorTwo = insertQqSource({
      suffix: 'why-prior-two',
      qqId: '75001',
      groupId,
      role: 'admin',
      text: 'Synthetic prior two.',
    });
    await completeTurn(turns, priorTwo, 13);
    const otherGroup = insertQqSource({
      suffix: 'why-other-group',
      qqId: '75001',
      groupId: 'qq-group-85002',
      role: 'admin',
      text: 'Synthetic other-group turn.',
    });
    await completeTurn(turns, otherGroup, 23);
    const privateTurn = insertQqSource({
      suffix: 'why-private',
      qqId: '75001',
      text: 'Synthetic private turn.',
    });
    await completeTurn(turns, privateTurn, 31);

    const command = insertQqSource({
      suffix: 'why-command',
      qqId: '75001',
      groupId,
      role: 'admin',
      text: '/why',
    });
    await completeTurn(turns, command, 0);
    const later = insertQqSource({
      suffix: 'why-later-ingress',
      qqId: '75001',
      groupId,
      role: 'admin',
      text: 'Synthetic later ingress.',
    });
    await completeTurn(turns, later, 99);

    const result = await service.handleQqCommand({ sourceEventId: command.rawEventId });
    expect(result).toEqual({
      outcome: 'why_explained',
      responseText: [
        'Prior turn evidence:',
        'turn_status=completed',
        'stored_context=no',
        'selected_memories=0',
        'rejected_memories=0',
        'tokens_used=13',
        'action_decisions=0',
        'action_executions=0',
        'tool_calls=0',
      ].join('\n'),
    });
    expectIntegrity();
  });

  function insertQqSource(input: {
    suffix: string;
    qqId: string;
    text: string;
    groupId?: string;
    role?: 'member' | 'admin' | 'owner';
  }): StoredSource {
    sequence += 1;
    const timestamp = BASE_TIME + sequence;
    const rawEventId = `raw-governance-${input.suffix}`;
    const platformMessageId = `qq-message-${input.suffix}`;
    const chatMessageId = rawEventId;
    const canonicalUserId = `user-governance-${input.qqId}`;
    const conversationId = input.groupId ?? `private:qq-${input.qqId}`;
    const conversationType = input.groupId ? 'group' : 'private';
    const event = {
      id: rawEventId,
      type: 'chat.message.received',
      timestamp: new Date(timestamp).toISOString(),
      source: 'gateway',
      platform: 'qq',
      conversationId,
      ingress: {
        transport: 'http',
        platformEventId: platformMessageId,
      },
      message: {
        messageId: platformMessageId,
        conversationId,
        conversationType,
        ...(input.groupId ? { groupId: input.groupId } : {}),
        senderId: `qq-${input.qqId}`,
        ...(input.groupId ? { senderRole: input.role ?? 'member' } : {}),
        content: { text: input.text, media: [] },
        mentions: [],
        mentionsBot: false,
      },
      gatewayCapabilities: {
        platform: 'qq',
        reactions: { emojiLike: false, faceMessage: true },
        foldedForward: { groupForward: false, privateForward: false, customNode: false },
        platformAdmin: { kick: false, mute: false, setGroupCard: false },
      },
    };

    db.prepare(
      `INSERT OR IGNORE INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    ).run(canonicalUserId, timestamp, timestamp);
    db.prepare(
      `INSERT OR IGNORE INTO platform_accounts (
         platform, platform_account_id, canonical_user_id, account_type,
         verified_level, status, first_seen_at, last_seen_at
       ) VALUES ('qq', ?, ?, ?, 'observed', 'active', ?, ?)`,
    ).run(
      input.qqId,
      canonicalUserId,
      input.groupId ? 'group_member' : 'private',
      timestamp,
      timestamp,
    );
    db.prepare(
      `INSERT INTO raw_events (
         id, type, timestamp, source, platform, conversation_id,
         platform_event_id, payload, created_at
       ) VALUES (?, 'chat.message.received', ?, 'gateway', 'qq', ?, ?, ?, ?)`,
    ).run(
      rawEventId,
      timestamp,
      conversationId,
      platformMessageId,
      JSON.stringify(event),
      timestamp,
    );
    db.prepare(
      `INSERT INTO chat_messages (
         id, raw_event_id, message_id, conversation_id, conversation_type,
         group_id, sender_id, sender_role, text, has_media, has_quote,
         mentions_bot, timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
    ).run(
      chatMessageId,
      rawEventId,
      platformMessageId,
      conversationId,
      conversationType,
      input.groupId ?? null,
      `qq-${input.qqId}`,
      input.groupId ? input.role ?? 'member' : null,
      input.text,
      timestamp,
    );

    return {
      rawEventId,
      chatMessageId,
      conversationId,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      canonicalUserId,
    };
  }

  function createMemory(input: {
    id: string;
    scope: 'user' | 'group';
    visibility: 'private_only' | 'same_group_only';
    source: StoredSource;
    canonicalUserId?: string;
    groupId?: string;
    state?: 'active' | 'proposed';
    content?: string;
  }): void {
    memories.createSync({
      id: input.id,
      scope: input.scope,
      ...(input.canonicalUserId ? { canonicalUserId: input.canonicalUserId } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      visibility: input.visibility,
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'fact',
      title: `Synthetic ${input.id}`,
      content: input.content ?? `Synthetic content for ${input.id}`,
      state: input.state ?? 'active',
      confidence: 0.9,
      importance: 0.7,
      sourceContext: input.groupId ? 'group_chat' : 'private_chat',
      sources: [{
        sourceType: 'chat_message',
        sourceId: input.source.chatMessageId,
        extractedBy: 'user',
      }],
      actor: {
        canonicalUserId: input.source.canonicalUserId,
        actorClass: input.groupId ? 'group_admin' : 'user',
        context: input.groupId ? 'group_chat' : 'private_chat',
      },
    });
  }

  async function completeTurn(
    turns: TurnRepository,
    source: StoredSource,
    totalTokens: number,
  ): Promise<void> {
    const turnId = await turns.createPending({
      conversationId: source.conversationId,
      triggerEventId: source.rawEventId,
      piModel: 'synthetic-governance-test',
      piProvider: 'mock',
    });
    turns.markCompleted(turnId, {
      responseText: 'Synthetic turn evidence',
      tokensUsed: { input: totalTokens, output: 0, total: totalTokens },
    });
  }

  function expectIntegrity(): void {
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  }
});
