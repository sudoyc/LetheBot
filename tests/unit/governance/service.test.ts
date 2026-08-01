import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveDisplayProfileTargetResourceId,
  GovernanceQueryService,
} from '../../../src/governance/query-service.js';
import {
  DISPLAY_PROFILE_REDACTION_REASON_CODE,
  GovernanceService,
  PLATFORM_ACCOUNT_UNLINK_REASON_CODE,
} from '../../../src/governance/service.js';
import { createMemoryMaintenanceProposal } from '../../../src/memory/maintenance-proposal.js';
import { AuditRepository } from '../../../src/storage/audit-repository.js';
import {
  closeDatabase,
  initDatabase,
  runMigrations,
} from '../../../src/storage/database.js';
import { GroupSummaryPolicyRepository } from '../../../src/storage/group-summary-policy-repository.js';
import { JobRepository } from '../../../src/storage/job-repository.js';
import { MemoryRepository } from '../../../src/storage/memory-repository.js';
import { PrivacyPreferenceRepository } from '../../../src/storage/privacy-preference-repository.js';
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

  it('atomically forgets only an exact-scope current memory revision for local confirmation', async () => {
    type ExactScope =
      | { kind: 'global' }
      | { kind: 'user'; canonicalUserId: string }
      | { kind: 'group'; groupId: string }
      | {
        kind: 'conversation';
        conversationId: string;
        conversationType: 'private' | 'group';
        groupId?: string;
      }
      | { kind: 'system' };
    type ForgettableState = 'proposed' | 'active' | 'rejected' | 'superseded' | 'disabled';

    const privateScopeSource = insertQqSource({
      suffix: 'http-forget-private-scope',
      qqId: '73501',
      text: 'Synthetic HTTP forget private scope source.',
    });
    const groupScopeSource = insertQqSource({
      suffix: 'http-forget-group-scope',
      qqId: '73502',
      groupId: 'qq-group-83501',
      role: 'admin',
      text: 'Synthetic HTTP forget group scope source.',
    });
    const canonicalUserId = privateScopeSource.canonicalUserId;
    const groupId = groupScopeSource.groupId as string;
    const privateConversationId = privateScopeSource.conversationId;
    const groupConversationId = groupScopeSource.conversationId;

    const createExpectedMemory = (input: {
      id: string;
      scope: ExactScope;
      state?: ForgettableState;
      content?: string;
    }): void => {
      const isGroupBound = input.scope.kind === 'group'
        || (input.scope.kind === 'conversation' && input.scope.conversationType === 'group');
      const isPrivateBound = input.scope.kind === 'user'
        || (input.scope.kind === 'conversation' && input.scope.conversationType === 'private');
      memories.createSync({
        id: input.id,
        scope: input.scope.kind,
        ...(input.scope.kind === 'user'
          ? { canonicalUserId: input.scope.canonicalUserId }
          : {}),
        ...(input.scope.kind === 'group' ? { groupId: input.scope.groupId } : {}),
        ...(input.scope.kind === 'conversation'
          ? {
            conversationId: input.scope.conversationId,
            ...(input.scope.groupId === undefined ? {} : { groupId: input.scope.groupId }),
          }
          : {}),
        visibility: isGroupBound
          ? 'same_group_only'
          : isPrivateBound
            ? 'private_only'
            : 'owner_admin_only',
        sensitivity: 'normal',
        authority: 'system',
        kind: 'fact',
        title: `Synthetic ${input.id}`,
        content: input.content ?? `Synthetic content for ${input.id}`,
        state: input.state ?? 'active',
        confidence: 0.9,
        importance: 0.7,
        sourceContext: 'admin_cli',
        sources: [{
          sourceType: 'user_command',
          sourceId: `source-${input.id}`,
          sourceTimestamp: BASE_TIME,
          extractedBy: 'admin',
          external: true,
        }],
        actor: {
          canonicalUserId: 'local_admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
      });
    };

    const exactRecords: Array<{
      id: string;
      scope: ExactScope;
      state: ForgettableState;
    }> = [
      { id: 'mem-http-forget-global', scope: { kind: 'global' }, state: 'active' },
      {
        id: 'mem-http-forget-user',
        scope: { kind: 'user', canonicalUserId },
        state: 'proposed',
      },
      {
        id: 'mem-http-forget-group',
        scope: { kind: 'group', groupId },
        state: 'rejected',
      },
      {
        id: 'mem-http-forget-private-conversation',
        scope: {
          kind: 'conversation',
          conversationId: privateConversationId,
          conversationType: 'private',
        },
        state: 'superseded',
      },
      {
        id: 'mem-http-forget-group-conversation',
        scope: {
          kind: 'conversation',
          conversationId: groupConversationId,
          conversationType: 'group',
          groupId,
        },
        state: 'disabled',
      },
      { id: 'mem-http-forget-system', scope: { kind: 'system' }, state: 'active' },
    ];
    for (const record of exactRecords) {
      createExpectedMemory({
        ...record,
        ...(record.scope.kind === 'global'
          ? { content: 'atomicforgetsearchtoken' }
          : {}),
      });
    }

    createExpectedMemory({
      id: 'mem-http-forget-state-drift',
      scope: { kind: 'user', canonicalUserId },
      state: 'proposed',
    });
    for (const id of [
      'mem-http-forget-no-revision',
      'mem-http-forget-fractional-revision',
      'mem-http-forget-unsafe-revision',
      'mem-http-forget-rollback',
      'mem-http-forget-other',
    ]) {
      createExpectedMemory({
        id,
        scope: { kind: 'user', canonicalUserId },
      });
    }
    db.prepare('DELETE FROM memory_revisions WHERE memory_id = ?')
      .run('mem-http-forget-no-revision');
    db.prepare('UPDATE memory_revisions SET revision_number = ? WHERE memory_id = ?')
      .run(1.5, 'mem-http-forget-fractional-revision');
    db.prepare('UPDATE memory_revisions SET revision_number = ? WHERE memory_id = ?')
      .run(Number.MAX_SAFE_INTEGER, 'mem-http-forget-unsafe-revision');

    const forgetExpected = (input: {
      memoryId: string;
      scope: ExactScope;
      expectedState?: ForgettableState;
      expectedRevisionNumber?: number;
      reasonCode?: string;
    }) => service.forgetMemoryAsLocalAdmin({
      memoryId: input.memoryId,
      scope: input.scope,
      expectedState: input.expectedState ?? 'active',
      expectedRevisionNumber: input.expectedRevisionNumber ?? 1,
      reasonCode: input.reasonCode ?? 'governance_http_forget_confirmed',
    });

    const changesBeforeRejections = db.prepare('SELECT total_changes()').pluck().get();
    expect(forgetExpected({
      memoryId: 'mem-http-forget-missing',
      scope: { kind: 'global' },
    })).toEqual({ outcome: 'not_found' });
    for (const [memoryId, scope] of [
      [
        'mem-http-forget-global',
        { kind: 'system' },
      ],
      [
        'mem-http-forget-user',
        { kind: 'user', canonicalUserId: 'other-user-http-forget' },
      ],
      [
        'mem-http-forget-group',
        { kind: 'group', groupId: 'other-group-http-forget' },
      ],
      [
        'mem-http-forget-private-conversation',
        {
          kind: 'conversation',
          conversationId: privateConversationId,
          conversationType: 'group',
          groupId,
        },
      ],
      [
        'mem-http-forget-group-conversation',
        {
          kind: 'conversation',
          conversationId: groupConversationId,
          conversationType: 'private',
        },
      ],
    ] as Array<[string, ExactScope]>) {
      expect(forgetExpected({ memoryId, scope })).toEqual({ outcome: 'not_found' });
    }
    expect(forgetExpected({
      memoryId: 'mem-http-forget-state-drift',
      scope: { kind: 'user', canonicalUserId },
    })).toEqual({ outcome: 'stale' });
    expect(forgetExpected({
      memoryId: 'mem-http-forget-user',
      scope: { kind: 'user', canonicalUserId },
      expectedState: 'proposed',
      expectedRevisionNumber: 2,
    })).toEqual({ outcome: 'stale' });
    for (const expectedRevisionNumber of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(forgetExpected({
        memoryId: 'mem-http-forget-user',
        scope: { kind: 'user', canonicalUserId },
        expectedRevisionNumber,
      })).toEqual({ outcome: 'stale' });
    }
    expect(forgetExpected({
      memoryId: 'mem-http-forget-user',
      scope: { kind: 'user', canonicalUserId },
      expectedState: 'deleted' as ForgettableState,
    })).toEqual({ outcome: 'stale' });
    expect(forgetExpected({
      memoryId: 'mem-http-forget-user',
      scope: { kind: 'user', canonicalUserId },
      reasonCode: 'INVALID reason',
    })).toEqual({ outcome: 'stale' });
    for (const memoryId of [
      'mem-http-forget-no-revision',
      'mem-http-forget-fractional-revision',
      'mem-http-forget-unsafe-revision',
    ]) {
      expect(forgetExpected({
        memoryId,
        scope: { kind: 'user', canonicalUserId },
      })).toEqual({ outcome: 'stale' });
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeRejections);

    expect((await memories.search('atomicforgetsearchtoken')).map((memory) => memory.id))
      .toContain('mem-http-forget-global');
    for (const record of exactRecords) {
      expect(forgetExpected({
        memoryId: record.id,
        scope: record.scope,
        expectedState: record.state,
      })).toEqual({
        outcome: 'forgotten',
        revisionNumber: 2,
      });
    }
    expect(db.prepare(
      `SELECT id, state FROM memory_records
        WHERE id LIKE 'mem-http-forget-%' AND state = 'deleted'
        ORDER BY id`,
    ).all()).toEqual(exactRecords
      .map((record) => ({ id: record.id, state: 'deleted' }))
      .sort((left, right) => left.id.localeCompare(right.id)));
    expect((await memories.search('atomicforgetsearchtoken')).map((memory) => memory.id))
      .not.toContain('mem-http-forget-global');

    const deleteRevisions = db.prepare(
      `SELECT memory_id, revision_number, change_type, actor, reason
         FROM memory_revisions
        WHERE memory_id LIKE 'mem-http-forget-%' AND change_type = 'delete'
        ORDER BY memory_id`,
    ).all();
    expect(deleteRevisions).toEqual(exactRecords
      .map((record) => ({
        memory_id: record.id,
        revision_number: 2,
        change_type: 'delete',
        actor: 'local_admin',
        reason: 'Governance HTTP confirmed memory forget',
      }))
      .sort((left, right) => left.memory_id.localeCompare(right.memory_id)));
    const deleteAudits = db.prepare(
      `SELECT event_id, actor_user_id, actor_class, invocation_context, details
         FROM audit_log
        WHERE event_type = 'memory.delete' AND event_id LIKE 'mem-http-forget-%'
        ORDER BY event_id`,
    ).all() as Array<{
      event_id: string;
      actor_user_id: string;
      actor_class: string;
      invocation_context: string;
      details: string;
    }>;
    expect(deleteAudits).toHaveLength(exactRecords.length);
    expect(deleteAudits.every((row) => (
      row.actor_user_id === 'local_admin'
      && row.actor_class === 'admin'
      && row.invocation_context === 'admin_cli'
      && JSON.parse(row.details).reasonCode === 'governance_http_forget_confirmed'
      && JSON.parse(row.details).revisionNumber === 2
    ))).toBe(true);

    const changesBeforeRetry = db.prepare('SELECT total_changes()').pluck().get();
    expect(forgetExpected({
      memoryId: exactRecords[0].id,
      scope: exactRecords[0].scope,
    })).toEqual({ outcome: 'not_found' });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeRetry);

    db.exec(
      `CREATE TRIGGER fail_http_memory_forget_audit
       BEFORE INSERT ON audit_log
       WHEN NEW.event_type = 'memory.delete'
        AND NEW.event_id = 'mem-http-forget-rollback'
       BEGIN
         SELECT RAISE(ABORT, 'synthetic HTTP memory forget audit failure');
       END`,
    );
    expect(() => forgetExpected({
      memoryId: 'mem-http-forget-rollback',
      scope: { kind: 'user', canonicalUserId },
    })).toThrow(/synthetic HTTP memory forget audit failure/u);
    db.exec('DROP TRIGGER fail_http_memory_forget_audit');
    expect(db.prepare('SELECT state FROM memory_records WHERE id = ?')
      .get('mem-http-forget-rollback')).toEqual({ state: 'active' });
    expect(db.prepare('SELECT revision_number FROM memory_revisions WHERE memory_id = ?')
      .all('mem-http-forget-rollback')).toEqual([{ revision_number: 1 }]);
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'memory.delete' AND event_id = ?`,
    ).pluck().get('mem-http-forget-rollback')).toBe(0);
    expect(db.prepare('SELECT state FROM memory_records WHERE id = ?')
      .get('mem-http-forget-other')).toEqual({ state: 'active' });
    expectIntegrity();
  });

  it('atomically restores only an exact-scope current memory revision for local confirmation', async () => {
    type ExactScope =
      | { kind: 'global' }
      | { kind: 'user'; canonicalUserId: string }
      | { kind: 'group'; groupId: string }
      | {
        kind: 'conversation';
        conversationId: string;
        conversationType: 'private' | 'group';
        groupId?: string;
      }
      | { kind: 'system' };
    type RestorableState = 'disabled' | 'rejected' | 'deleted';
    type FixtureState = RestorableState | 'proposed' | 'active' | 'superseded';

    const privateScopeSource = insertQqSource({
      suffix: 'http-restore-private-scope',
      qqId: '73601',
      text: 'Synthetic HTTP restore private scope source.',
    });
    const groupScopeSource = insertQqSource({
      suffix: 'http-restore-group-scope',
      qqId: '73602',
      groupId: 'qq-group-83601',
      role: 'admin',
      text: 'Synthetic HTTP restore group scope source.',
    });
    const canonicalUserId = privateScopeSource.canonicalUserId;
    const groupId = groupScopeSource.groupId as string;
    const privateConversationId = privateScopeSource.conversationId;
    const groupConversationId = groupScopeSource.conversationId;

    const createExpectedMemory = (input: {
      id: string;
      scope: ExactScope;
      state: FixtureState;
      content?: string;
    }): void => {
      const isGroupBound = input.scope.kind === 'group'
        || (input.scope.kind === 'conversation' && input.scope.conversationType === 'group');
      const isPrivateBound = input.scope.kind === 'user'
        || (input.scope.kind === 'conversation' && input.scope.conversationType === 'private');
      memories.createSync({
        id: input.id,
        scope: input.scope.kind,
        ...(input.scope.kind === 'user'
          ? { canonicalUserId: input.scope.canonicalUserId }
          : {}),
        ...(input.scope.kind === 'group' ? { groupId: input.scope.groupId } : {}),
        ...(input.scope.kind === 'conversation'
          ? {
            conversationId: input.scope.conversationId,
            ...(input.scope.groupId === undefined ? {} : { groupId: input.scope.groupId }),
          }
          : {}),
        visibility: isGroupBound
          ? 'same_group_only'
          : isPrivateBound
            ? 'private_only'
            : 'owner_admin_only',
        sensitivity: 'normal',
        authority: 'system',
        kind: 'fact',
        title: `Synthetic ${input.id}`,
        content: input.content ?? `Synthetic content for ${input.id}`,
        state: input.state,
        confidence: 0.9,
        importance: 0.7,
        sourceContext: 'admin_cli',
        sources: [{
          sourceType: 'user_command',
          sourceId: `source-${input.id}`,
          sourceTimestamp: BASE_TIME,
          extractedBy: 'admin',
          external: true,
        }],
        actor: {
          canonicalUserId: 'local_admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
      });
    };

    const exactRecords: Array<{
      id: string;
      scope: ExactScope;
      state: RestorableState;
    }> = [
      { id: 'mem-http-restore-global', scope: { kind: 'global' }, state: 'deleted' },
      {
        id: 'mem-http-restore-user',
        scope: { kind: 'user', canonicalUserId },
        state: 'disabled',
      },
      {
        id: 'mem-http-restore-group',
        scope: { kind: 'group', groupId },
        state: 'rejected',
      },
      {
        id: 'mem-http-restore-private-conversation',
        scope: {
          kind: 'conversation',
          conversationId: privateConversationId,
          conversationType: 'private',
        },
        state: 'deleted',
      },
      {
        id: 'mem-http-restore-group-conversation',
        scope: {
          kind: 'conversation',
          conversationId: groupConversationId,
          conversationType: 'group',
          groupId,
        },
        state: 'disabled',
      },
      { id: 'mem-http-restore-system', scope: { kind: 'system' }, state: 'rejected' },
    ];
    for (const record of exactRecords) {
      createExpectedMemory({
        ...record,
        ...(record.scope.kind === 'global'
          ? { content: 'atomicrestoretoken' }
          : {}),
      });
    }

    for (const state of ['proposed', 'active', 'superseded'] as const) {
      createExpectedMemory({
        id: `mem-http-restore-not-restorable-${state}`,
        scope: { kind: 'user', canonicalUserId },
        state,
      });
    }
    for (const [id, state] of [
      ['mem-http-restore-state-drift', 'rejected'],
      ['mem-http-restore-no-revision', 'deleted'],
      ['mem-http-restore-fractional-revision', 'deleted'],
      ['mem-http-restore-unsafe-revision', 'deleted'],
      ['mem-http-restore-rollback', 'deleted'],
      ['mem-http-restore-other', 'deleted'],
    ] as Array<[string, RestorableState]>) {
      createExpectedMemory({
        id,
        scope: { kind: 'user', canonicalUserId },
        state,
      });
    }
    db.prepare('DELETE FROM memory_revisions WHERE memory_id = ?')
      .run('mem-http-restore-no-revision');
    db.prepare('UPDATE memory_revisions SET revision_number = ? WHERE memory_id = ?')
      .run(1.5, 'mem-http-restore-fractional-revision');
    db.prepare('UPDATE memory_revisions SET revision_number = ? WHERE memory_id = ?')
      .run(Number.MAX_SAFE_INTEGER, 'mem-http-restore-unsafe-revision');

    const restoreExpected = (input: {
      memoryId: string;
      scope: ExactScope;
      expectedState?: RestorableState;
      expectedRevisionNumber?: number;
      reasonCode?: string;
    }) => service.restoreMemoryAsLocalAdmin({
      memoryId: input.memoryId,
      scope: input.scope,
      expectedState: input.expectedState ?? 'deleted',
      expectedRevisionNumber: input.expectedRevisionNumber ?? 1,
      reasonCode: input.reasonCode ?? 'governance_http_restore_confirmed',
    });

    const changesBeforeRejections = db.prepare('SELECT total_changes()').pluck().get();
    expect(restoreExpected({
      memoryId: 'mem-http-restore-missing',
      scope: { kind: 'global' },
    })).toEqual({ outcome: 'not_found' });
    for (const [memoryId, scope] of [
      ['mem-http-restore-global', { kind: 'system' }],
      [
        'mem-http-restore-user',
        { kind: 'user', canonicalUserId: 'other-user-http-restore' },
      ],
      ['mem-http-restore-group', { kind: 'group', groupId: 'other-group-http-restore' }],
      [
        'mem-http-restore-private-conversation',
        {
          kind: 'conversation',
          conversationId: privateConversationId,
          conversationType: 'group',
          groupId,
        },
      ],
      [
        'mem-http-restore-group-conversation',
        {
          kind: 'conversation',
          conversationId: groupConversationId,
          conversationType: 'private',
        },
      ],
    ] as Array<[string, ExactScope]>) {
      expect(restoreExpected({ memoryId, scope })).toEqual({ outcome: 'not_found' });
    }
    for (const state of ['proposed', 'active', 'superseded'] as const) {
      expect(restoreExpected({
        memoryId: `mem-http-restore-not-restorable-${state}`,
        scope: { kind: 'user', canonicalUserId },
      })).toEqual({ outcome: 'not_found' });
    }
    expect(restoreExpected({
      memoryId: 'mem-http-restore-state-drift',
      scope: { kind: 'user', canonicalUserId },
    })).toEqual({ outcome: 'stale' });
    expect(restoreExpected({
      memoryId: 'mem-http-restore-global',
      scope: { kind: 'global' },
      expectedRevisionNumber: 2,
    })).toEqual({ outcome: 'stale' });
    for (const expectedRevisionNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(restoreExpected({
        memoryId: 'mem-http-restore-global',
        scope: { kind: 'global' },
        expectedRevisionNumber,
      })).toEqual({ outcome: 'stale' });
    }
    expect(restoreExpected({
      memoryId: 'mem-http-restore-global',
      scope: { kind: 'global' },
      expectedState: 'active' as RestorableState,
    })).toEqual({ outcome: 'stale' });
    expect(restoreExpected({
      memoryId: 'mem-http-restore-global',
      scope: { kind: 'global' },
      reasonCode: 'INVALID reason',
    })).toEqual({ outcome: 'stale' });
    expect(restoreExpected({
      memoryId: ' mem-http-restore-global',
      scope: { kind: 'global' },
    })).toEqual({ outcome: 'stale' });
    for (const memoryId of [
      'mem-http-restore-no-revision',
      'mem-http-restore-fractional-revision',
      'mem-http-restore-unsafe-revision',
    ]) {
      expect(restoreExpected({
        memoryId,
        scope: { kind: 'user', canonicalUserId },
      })).toEqual({ outcome: 'stale' });
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeRejections);

    expect((await memories.retrieve({ state: 'active', limit: 100 }))
      .map((memory) => memory.id)).not.toContain('mem-http-restore-global');
    for (const record of exactRecords) {
      expect(restoreExpected({
        memoryId: record.id,
        scope: record.scope,
        expectedState: record.state,
      })).toEqual({ outcome: 'restored', revisionNumber: 2 });
    }
    expect(db.prepare(
      `SELECT id, state FROM memory_records
        WHERE id LIKE 'mem-http-restore-%' AND state = 'active'
        ORDER BY id`,
    ).all()).toEqual([
      ...exactRecords.map((record) => ({ id: record.id, state: 'active' })),
      { id: 'mem-http-restore-not-restorable-active', state: 'active' },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    expect((await memories.retrieve({ state: 'active', limit: 100 }))
      .map((memory) => memory.id)).toContain('mem-http-restore-global');

    expect(db.prepare(
      `SELECT memory_id, revision_number, change_type, actor, reason
         FROM memory_revisions
        WHERE memory_id LIKE 'mem-http-restore-%' AND change_type = 'restore'
        ORDER BY memory_id`,
    ).all()).toEqual(exactRecords
      .map((record) => ({
        memory_id: record.id,
        revision_number: 2,
        change_type: 'restore',
        actor: 'local_admin',
        reason: 'Governance HTTP confirmed memory restore',
      }))
      .sort((left, right) => left.memory_id.localeCompare(right.memory_id)));
    const restoreAudits = db.prepare(
      `SELECT event_id, actor_user_id, actor_class, invocation_context, details
         FROM audit_log
        WHERE event_type = 'memory.restore' AND event_id LIKE 'mem-http-restore-%'
        ORDER BY event_id`,
    ).all() as Array<{
      event_id: string;
      actor_user_id: string;
      actor_class: string;
      invocation_context: string;
      details: string;
    }>;
    expect(restoreAudits).toHaveLength(exactRecords.length);
    expect(restoreAudits.every((row) => (
      row.actor_user_id === 'local_admin'
      && row.actor_class === 'admin'
      && row.invocation_context === 'admin_cli'
      && JSON.parse(row.details).reasonCode === 'governance_http_restore_confirmed'
      && JSON.parse(row.details).revisionNumber === 2
    ))).toBe(true);

    const changesBeforeRetry = db.prepare('SELECT total_changes()').pluck().get();
    expect(restoreExpected({
      memoryId: exactRecords[0].id,
      scope: exactRecords[0].scope,
    })).toEqual({ outcome: 'not_found' });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeRetry);

    db.exec(
      `CREATE TRIGGER fail_http_memory_restore_audit
       BEFORE INSERT ON audit_log
       WHEN NEW.event_type = 'memory.restore'
        AND NEW.event_id = 'mem-http-restore-rollback'
       BEGIN
         SELECT RAISE(ABORT, 'synthetic HTTP memory restore audit failure');
       END`,
    );
    expect(() => restoreExpected({
      memoryId: 'mem-http-restore-rollback',
      scope: { kind: 'user', canonicalUserId },
    })).toThrow(/synthetic HTTP memory restore audit failure/u);
    db.exec('DROP TRIGGER fail_http_memory_restore_audit');
    expect(db.prepare('SELECT state FROM memory_records WHERE id = ?')
      .get('mem-http-restore-rollback')).toEqual({ state: 'deleted' });
    expect(db.prepare('SELECT revision_number FROM memory_revisions WHERE memory_id = ?')
      .all('mem-http-restore-rollback')).toEqual([{ revision_number: 1 }]);
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'memory.restore' AND event_id = ?`,
    ).pluck().get('mem-http-restore-rollback')).toBe(0);
    expect(db.prepare('SELECT state FROM memory_records WHERE id = ?')
      .get('mem-http-restore-other')).toEqual({ state: 'deleted' });
    expectIntegrity();
  });

  it('owns local-admin platform-account unlink with exact CLI-compatible transaction and audit semantics', () => {
    const canonicalUserId = 'legacy_qq-13579_sk-canonicalabcdefghijklmnopqrstuvwxyz';
    const targetAccountId = 'api_key=sk-unlink-target-abcdefghijklmnopqrstuvwxyz-qq-246813579';
    const rollbackAccountId = 'unlink-rollback-account';
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
    ).run(
      canonicalUserId,
      BASE_TIME,
      BASE_TIME,
      'user-unlink-disabled',
      BASE_TIME,
      BASE_TIME,
      'user-unlink-deleted',
      BASE_TIME,
      BASE_TIME,
      'user-unlink-rollback',
      BASE_TIME,
      BASE_TIME,
    );
    db.prepare(
      `INSERT INTO platform_accounts (
         platform, platform_account_id, canonical_user_id, account_type,
         verified_level, status, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?),
                (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?),
                (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'qq', targetAccountId, canonicalUserId, 'private', 'owner_verified',
      'active', BASE_TIME, BASE_TIME + 1,
      'qq', 'unlink-active-distractor', canonicalUserId, 'group_member', 'observed',
      'active', BASE_TIME + 2, BASE_TIME + 3,
      'qq', 'unlink-disabled-account', 'user-unlink-disabled', 'private', 'observed',
      'disabled', BASE_TIME + 4, BASE_TIME + 5,
      'qq', 'unlink-deleted-account', 'user-unlink-deleted', 'temp_session', 'observed',
      'deleted', BASE_TIME + 6, BASE_TIME + 7,
      'qq', rollbackAccountId, 'user-unlink-rollback', 'private', 'observed',
      'active', BASE_TIME + 8, BASE_TIME + 9,
    );
    const targetBefore = db.prepare(
      `SELECT * FROM platform_accounts
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).get(targetAccountId) as Record<string, unknown>;
    const distractorsBefore = db.prepare(
      `SELECT * FROM platform_accounts
        WHERE platform_account_id <> ?
        ORDER BY platform_account_id`,
    ).all(targetAccountId);

    const startedAt = Date.now();
    expect(service.unlinkPlatformAccountAsLocalAdmin({
      platform: 'qq',
      platformAccountId: targetAccountId,
    })).toEqual({ outcome: 'unlinked' });
    const finishedAt = Date.now();

    expect(db.prepare(
      `SELECT * FROM platform_accounts
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).get(targetAccountId)).toEqual({ ...targetBefore, status: 'disabled' });
    expect(db.prepare(
      `SELECT * FROM platform_accounts
        WHERE platform_account_id <> ?
        ORDER BY platform_account_id`,
    ).all(targetAccountId)).toEqual(distractorsBefore);

    const audit = db.prepare(
      `SELECT timestamp, category, level, event_id, actor_user_id, actor_class,
              invocation_context, summary, details, redacted, risk_level,
              evaluator_decision_id
         FROM audit_log
        WHERE event_type = 'identity.platform_account.unlinked'`,
    ).get() as {
      timestamp: number;
      category: string;
      level: string;
      event_id: string;
      actor_user_id: string | null;
      actor_class: string;
      invocation_context: string;
      summary: string;
      details: string;
      redacted: number;
      risk_level: string;
      evaluator_decision_id: string | null;
    };
    expect(audit).toMatchObject({
      category: 'system',
      level: 'summary',
      actor_user_id: null,
      actor_class: 'admin',
      invocation_context: 'admin_cli',
      summary: 'Governance CLI disabled one platform account mapping',
      redacted: 1,
      risk_level: 'medium',
      evaluator_decision_id: null,
    });
    expect(audit.event_id).toMatch(/^identity-unlink-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(audit.timestamp).toBeGreaterThanOrEqual(startedAt);
    expect(audit.timestamp).toBeLessThanOrEqual(finishedAt);
    const auditDetails = JSON.parse(audit.details) as Record<string, unknown>;
    expect(auditDetails).toEqual({
      platform: 'qq',
      canonicalUserId: expect.stringContaining('[REDACTED:platform_id]'),
      previousStatus: 'active',
      newStatus: 'disabled',
      redaction: 'no_raw_platform_account_id',
    });
    expect(auditDetails).not.toHaveProperty('platformAccountId');
    const durableAuditDisplay = JSON.stringify({ audit, auditDetails });
    expect(durableAuditDisplay).not.toContain(targetAccountId);
    expect(durableAuditDisplay).not.toContain('13579');
    expect(durableAuditDisplay).not.toContain('sk-canonical');

    const beforeNoOps = db.prepare(
      'SELECT * FROM platform_accounts ORDER BY platform_account_id',
    ).all();
    for (const platformAccountId of [
      'unlink-missing-account',
      'unlink-disabled-account',
      'unlink-deleted-account',
    ]) {
      expect(service.unlinkPlatformAccountAsLocalAdmin({
        platform: 'qq',
        platformAccountId,
      })).toEqual({ outcome: 'not_found' });
    }
    expect(db.prepare(
      'SELECT * FROM platform_accounts ORDER BY platform_account_id',
    ).all()).toEqual(beforeNoOps);
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'identity.platform_account.unlinked'`,
    ).pluck().get()).toBe(1);

    db.exec(
      `CREATE TRIGGER fail_platform_account_unlink_service_audit
       BEFORE INSERT ON audit_log
       WHEN NEW.event_type = 'identity.platform_account.unlinked'
       BEGIN
         SELECT RAISE(ABORT, 'synthetic platform account unlink audit failure');
       END`,
    );
    expect(() => service.unlinkPlatformAccountAsLocalAdmin({
      platform: 'qq',
      platformAccountId: rollbackAccountId,
    })).toThrow('synthetic platform account unlink audit failure');
    db.exec('DROP TRIGGER fail_platform_account_unlink_service_audit');
    expect(db.prepare(
      `SELECT status FROM platform_accounts
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).get(rollbackAccountId)).toEqual({ status: 'active' });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'identity.platform_account.unlinked'`,
    ).pluck().get()).toBe(1);

    closeDatabase(db);
    db = initDatabase({ path: join(root, 'test.db') });
    expect(db.prepare(
      `SELECT status FROM platform_accounts
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).get(targetAccountId)).toEqual({ status: 'disabled' });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'identity.platform_account.unlinked'`,
    ).pluck().get()).toBe(1);
    expectIntegrity();
  });

  it('unlinks platform account only from the exact current snapshot', async () => {
    const targetAccountId = '913579246';
    const driftAccountId = '924680357';
    const mismatchAccountId = '935791468';
    const rollbackAccountId = '946802579';
    const disabledAccountId = '957913680';
    const deletedAccountId = '968024791';
    const missingAccountId = '979135802';
    const secret = 'sk-expectedunlinkabcdefghijklmnopqrstuvwxyz12';
    const targetUserId = `expected-unlink-user-qq-13579-${secret}`;
    const driftUserId = 'expected-unlink-drift-user';
    const alternateUserId = 'expected-unlink-alternate-user';
    const mismatchUserId = 'expected-unlink-mismatch-user';
    const rollbackUserId = 'expected-unlink-rollback-user';
    const disabledUserId = 'expected-unlink-disabled-user';
    const deletedUserId = 'expected-unlink-deleted-user';
    const disabledAt = BASE_TIME + 80_000;
    const reasonCode = PLATFORM_ACCOUNT_UNLINK_REASON_CODE;
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    for (const canonicalUserId of [
      targetUserId,
      driftUserId,
      alternateUserId,
      mismatchUserId,
      rollbackUserId,
      disabledUserId,
      deletedUserId,
    ]) {
      insertUser.run(canonicalUserId, BASE_TIME, BASE_TIME);
    }
    const insertAccount = db.prepare(
      `INSERT INTO platform_accounts (
         platform, platform_account_id, canonical_user_id, account_type,
         verified_level, status, first_seen_at, last_seen_at
       ) VALUES ('qq', ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertAccount.run(
      targetAccountId,
      targetUserId,
      'private',
      'owner_verified',
      'active',
      BASE_TIME,
      BASE_TIME + 1,
    );
    insertAccount.run(
      driftAccountId,
      driftUserId,
      'group_member',
      'observed',
      'active',
      BASE_TIME + 2,
      BASE_TIME + 3,
    );
    insertAccount.run(
      mismatchAccountId,
      mismatchUserId,
      'private',
      'observed',
      'active',
      BASE_TIME + 4,
      BASE_TIME + 5,
    );
    insertAccount.run(
      rollbackAccountId,
      rollbackUserId,
      'temp_session',
      'self_claimed',
      'active',
      BASE_TIME + 6,
      BASE_TIME + 7,
    );
    insertAccount.run(
      disabledAccountId,
      disabledUserId,
      'private',
      'observed',
      'disabled',
      BASE_TIME + 8,
      BASE_TIME + 9,
    );
    insertAccount.run(
      deletedAccountId,
      deletedUserId,
      'private',
      'observed',
      'deleted',
      BASE_TIME + 10,
      BASE_TIME + 11,
    );

    const queryService = new GovernanceQueryService(db);
    const targetPreview = await queryService.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: targetAccountId,
    });
    if (!targetPreview) {
      throw new Error('Expected platform-account unlink preview');
    }
    const targetBefore = db.prepare(
      `SELECT * FROM platform_accounts
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).get(targetAccountId) as Record<string, unknown>;
    const distractorsBefore = db.prepare(
      `SELECT * FROM platform_accounts
        WHERE platform_account_id <> ?
        ORDER BY platform_account_id`,
    ).all(targetAccountId);
    const targetExpectedInput = {
      platform: 'qq' as const,
      platformAccountId: targetAccountId,
      expectedSnapshot: targetPreview.current,
      reasonCode,
      now: disabledAt,
    };

    expect(service.unlinkPlatformAccountAsLocalAdmin(targetExpectedInput)).toEqual({
      outcome: 'unlinked',
      disabledAt,
    });
    expect(db.prepare(
      `SELECT * FROM platform_accounts
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).get(targetAccountId)).toEqual({ ...targetBefore, status: 'disabled' });
    expect(db.prepare(
      `SELECT * FROM platform_accounts
        WHERE platform_account_id <> ?
        ORDER BY platform_account_id`,
    ).all(targetAccountId)).toEqual(distractorsBefore);

    const audit = db.prepare(
      `SELECT timestamp, category, level, event_id, actor_user_id, actor_class,
              invocation_context, summary, details, redacted, risk_level,
              evaluator_decision_id
         FROM audit_log
        WHERE event_type = 'identity.platform_account.unlinked'
          AND timestamp = ?`,
    ).get(disabledAt) as {
      timestamp: number;
      category: string;
      level: string;
      event_id: string;
      actor_user_id: string | null;
      actor_class: string;
      invocation_context: string;
      summary: string;
      details: string;
      redacted: number;
      risk_level: string;
      evaluator_decision_id: string | null;
    };
    expect(audit).toMatchObject({
      timestamp: disabledAt,
      category: 'system',
      level: 'summary',
      actor_user_id: null,
      actor_class: 'admin',
      invocation_context: 'admin_cli',
      summary: 'Governance HTTP disabled one platform account mapping',
      redacted: 1,
      risk_level: 'medium',
      evaluator_decision_id: null,
    });
    expect(audit.event_id).toMatch(/^identity-unlink-[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(JSON.parse(audit.details)).toEqual({
      platform: 'qq',
      canonicalUserId: expect.stringContaining('[REDACTED:platform_id]'),
      previousStatus: 'active',
      newStatus: 'disabled',
      reasonCode,
      redaction: 'no_raw_platform_account_id',
    });
    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).not.toContain(targetAccountId);
    expect(serializedAudit).not.toContain(targetUserId);
    expect(serializedAudit).not.toContain(secret);

    const changesBeforeReplay = db.prepare('SELECT total_changes()').pluck().get();
    expect(service.unlinkPlatformAccountAsLocalAdmin(targetExpectedInput))
      .toEqual({ outcome: 'not_found' });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReplay);
    for (const platformAccountId of [
      missingAccountId,
      disabledAccountId,
      deletedAccountId,
    ]) {
      expect(service.unlinkPlatformAccountAsLocalAdmin({
        ...targetExpectedInput,
        platformAccountId,
      })).toEqual({ outcome: 'not_found' });
    }

    const driftPreview = await queryService.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: driftAccountId,
    });
    if (!driftPreview) {
      throw new Error('Expected drift platform-account unlink preview');
    }
    const driftExpectedInput = {
      platform: 'qq' as const,
      platformAccountId: driftAccountId,
      expectedSnapshot: driftPreview.current,
      reasonCode,
      now: disabledAt + 1,
    };
    const invalidInputs: unknown[] = [
      { ...driftExpectedInput, platform: 'discord' },
      { ...driftExpectedInput, platformAccountId: '' },
      { ...driftExpectedInput, platformAccountId: '1234' },
      { ...driftExpectedInput, platformAccountId: '01234' },
      { ...driftExpectedInput, platformAccountId: '1234567890123' },
      { ...driftExpectedInput, platformAccountId: ` ${driftAccountId}` },
      { ...driftExpectedInput, expectedSnapshot: null },
      { ...driftExpectedInput, expectedSnapshot: [] },
      { ...driftExpectedInput, expectedSnapshot: {} },
      { ...driftExpectedInput, expectedSnapshot: { ...driftPreview.current, extra: true } },
      {
        ...driftExpectedInput,
        expectedSnapshot: { snapshotFingerprint: 'a'.repeat(63) },
      },
      { ...driftExpectedInput, reasonCode: 'invalid_reason' },
      { ...driftExpectedInput, now: -1 },
      { ...driftExpectedInput, now: 1.5 },
      { ...driftExpectedInput, now: 8_640_000_000_000_001 },
      { ...driftExpectedInput, now: 'invalid-time' },
      { ...driftExpectedInput, extra: true },
    ];
    const prepare = vi.spyOn(db, 'prepare');
    for (const invalidInput of invalidInputs) {
      expect(service.unlinkPlatformAccountAsLocalAdmin(invalidInput as never))
        .toEqual({ outcome: 'stale' });
    }
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();

    const assertStaleDrift = async (
      mutate: () => void,
      restore: () => void,
    ): Promise<void> => {
      mutate();
      const changesBeforeAttempt = db.prepare('SELECT total_changes()').pluck().get();
      expect(service.unlinkPlatformAccountAsLocalAdmin(driftExpectedInput))
        .toEqual({ outcome: 'stale' });
      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeAttempt);
      restore();
      await expect(queryService.getPlatformAccountUnlinkPreview({
        platform: 'qq',
        platformAccountId: driftAccountId,
      })).resolves.toEqual(driftPreview);
    };
    await assertStaleDrift(
      () => {
        db.prepare(
          `UPDATE platform_accounts SET verified_level = 'owner_verified'
            WHERE platform = 'qq' AND platform_account_id = ?`,
        ).run(driftAccountId);
      },
      () => {
        db.prepare(
          `UPDATE platform_accounts SET verified_level = 'observed'
            WHERE platform = 'qq' AND platform_account_id = ?`,
        ).run(driftAccountId);
      },
    );
    await assertStaleDrift(
      () => {
        db.prepare(
          `UPDATE platform_accounts SET canonical_user_id = ?
            WHERE platform = 'qq' AND platform_account_id = ?`,
        ).run(alternateUserId, driftAccountId);
      },
      () => {
        db.prepare(
          `UPDATE platform_accounts SET canonical_user_id = ?
            WHERE platform = 'qq' AND platform_account_id = ?`,
        ).run(driftUserId, driftAccountId);
      },
    );
    await assertStaleDrift(
      () => {
        db.prepare(
          `UPDATE platform_accounts SET last_seen_at = last_seen_at + 1
            WHERE platform = 'qq' AND platform_account_id = ?`,
        ).run(driftAccountId);
      },
      () => {
        db.prepare(
          `UPDATE platform_accounts SET last_seen_at = last_seen_at - 1
            WHERE platform = 'qq' AND platform_account_id = ?`,
        ).run(driftAccountId);
      },
    );
    await assertStaleDrift(
      () => {
        db.prepare(
          `UPDATE platform_accounts SET first_seen_at = CAST(first_seen_at AS BLOB)
            WHERE platform = 'qq' AND platform_account_id = ?`,
        ).run(driftAccountId);
      },
      () => {
        db.prepare(
          `UPDATE platform_accounts SET first_seen_at = ?
            WHERE platform = 'qq' AND platform_account_id = ?`,
        ).run(BASE_TIME + 2, driftAccountId);
      },
    );
    db.prepare(
      `UPDATE platform_accounts SET status = 'disabled'
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(driftAccountId);
    const changesBeforeInactiveDrift = db.prepare('SELECT total_changes()').pluck().get();
    expect(service.unlinkPlatformAccountAsLocalAdmin(driftExpectedInput))
      .toEqual({ outcome: 'not_found' });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeInactiveDrift);
    db.prepare(
      `UPDATE platform_accounts SET status = 'active'
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).run(driftAccountId);

    const mismatchPreview = await queryService.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: mismatchAccountId,
    });
    if (!mismatchPreview) {
      throw new Error('Expected update-mismatch platform-account unlink preview');
    }
    db.exec(
      `CREATE TRIGGER ignore_expected_platform_account_unlink_update
       BEFORE UPDATE OF status ON platform_accounts
       WHEN OLD.platform = 'qq' AND OLD.platform_account_id = '${mismatchAccountId}'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    );
    expect(service.unlinkPlatformAccountAsLocalAdmin({
      platform: 'qq',
      platformAccountId: mismatchAccountId,
      expectedSnapshot: mismatchPreview.current,
      reasonCode,
      now: disabledAt + 2,
    })).toEqual({ outcome: 'stale' });
    db.exec('DROP TRIGGER ignore_expected_platform_account_unlink_update');
    expect(db.prepare(
      `SELECT status FROM platform_accounts
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).get(mismatchAccountId)).toEqual({ status: 'active' });

    const rollbackPreview = await queryService.getPlatformAccountUnlinkPreview({
      platform: 'qq',
      platformAccountId: rollbackAccountId,
    });
    if (!rollbackPreview) {
      throw new Error('Expected rollback platform-account unlink preview');
    }
    db.exec(
      `CREATE TRIGGER fail_expected_platform_account_unlink_audit
       BEFORE INSERT ON audit_log
       WHEN NEW.event_type = 'identity.platform_account.unlinked'
        AND NEW.timestamp = ${disabledAt + 3}
       BEGIN
         SELECT RAISE(ABORT, 'synthetic expected platform account unlink audit failure');
       END`,
    );
    expect(() => service.unlinkPlatformAccountAsLocalAdmin({
      platform: 'qq',
      platformAccountId: rollbackAccountId,
      expectedSnapshot: rollbackPreview.current,
      reasonCode,
      now: disabledAt + 3,
    })).toThrow('synthetic expected platform account unlink audit failure');
    db.exec('DROP TRIGGER fail_expected_platform_account_unlink_audit');
    expect(db.prepare(
      `SELECT status FROM platform_accounts
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).get(rollbackAccountId)).toEqual({ status: 'active' });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'identity.platform_account.unlinked'`,
    ).pluck().get()).toBe(1);

    closeDatabase(db);
    db = initDatabase({ path: join(root, 'test.db') });
    expect(db.prepare(
      `SELECT status FROM platform_accounts
        WHERE platform = 'qq' AND platform_account_id = ?`,
    ).get(targetAccountId)).toEqual({ status: 'disabled' });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'identity.platform_account.unlinked'`,
    ).pluck().get()).toBe(1);
    expectIntegrity();
  });

  it('owns local-admin display-profile redaction with exact CLI-compatible transaction and audit semantics', () => {
    const canonicalUserId = 'legacy_qq-12345_sk-profileabcdefghijklmnopqrstuvwxyz';
    const groupId = 'legacy_qq-group-67890_sk-groupabcdefghijklmnopqrstuvwxyz';
    const rollbackUserId = 'user-profile-rollback';
    const rollbackGroupId = 'group-profile-rollback';
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?), (?, ?, ?)`,
    ).run(
      canonicalUserId,
      BASE_TIME,
      BASE_TIME,
      rollbackUserId,
      BASE_TIME,
      BASE_TIME,
    );
    db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    ).run(
      canonicalUserId,
      groupId,
      'Target group display',
      BASE_TIME,
      'platform_provided',
      canonicalUserId,
      '',
      'Global display stays',
      BASE_TIME + 1,
      'platform_provided',
      rollbackUserId,
      rollbackGroupId,
      'Rollback display stays',
      BASE_TIME + 2,
      'platform_provided',
    );
    db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?),
                (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
    ).run(
      'profile-target-open',
      canonicalUserId,
      groupId,
      'Target open history',
      BASE_TIME,
      null,
      'profile-target-closed',
      canonicalUserId,
      groupId,
      'Target closed history',
      BASE_TIME,
      BASE_TIME - 1,
      'profile-global-distractor',
      canonicalUserId,
      '',
      'Global history stays',
      BASE_TIME,
      null,
      'profile-rollback-open',
      rollbackUserId,
      rollbackGroupId,
      'Rollback history stays',
      BASE_TIME,
      null,
    );

    const startedAt = Date.now();
    expect(service.redactDisplayProfileAsLocalAdmin({ canonicalUserId, groupId })).toBe(3);
    const finishedAt = Date.now();

    const targetProfile = db.prepare(
      `SELECT current_display_name, observed_at, trust
         FROM display_profiles
        WHERE canonical_user_id = ? AND source_group_id = ?`,
    ).get(canonicalUserId, groupId) as {
      current_display_name: string;
      observed_at: number;
      trust: string;
    };
    expect(targetProfile).toEqual({
      current_display_name: '[redacted]',
      observed_at: expect.any(Number),
      trust: 'user_set',
    });
    expect(targetProfile.observed_at).toBeGreaterThanOrEqual(startedAt);
    expect(targetProfile.observed_at).toBeLessThanOrEqual(finishedAt);
    expect(db.prepare(
      `SELECT current_display_name, observed_at, trust
         FROM display_profiles
        WHERE canonical_user_id = ? AND source_group_id = ''`,
    ).get(canonicalUserId)).toEqual({
      current_display_name: 'Global display stays',
      observed_at: BASE_TIME + 1,
      trust: 'platform_provided',
    });
    expect(db.prepare(
      `SELECT id, display_name, observed_until
         FROM nickname_history
        WHERE canonical_user_id = ?
        ORDER BY id`,
    ).all(canonicalUserId)).toEqual([
      {
        id: 'profile-global-distractor',
        display_name: 'Global history stays',
        observed_until: null,
      },
      {
        id: 'profile-target-closed',
        display_name: '[redacted]',
        observed_until: BASE_TIME - 1,
      },
      {
        id: 'profile-target-open',
        display_name: '[redacted]',
        observed_until: targetProfile.observed_at,
      },
    ]);

    const audit = db.prepare(
      `SELECT timestamp, category, level, event_id, actor_user_id, actor_class,
              invocation_context, summary, details, redacted, risk_level,
              evaluator_decision_id
         FROM audit_log
        WHERE event_type = 'display_profile.redact' AND event_id = ?`,
    ).get(`${canonicalUserId}:${groupId}`) as {
      timestamp: number;
      category: string;
      level: string;
      event_id: string;
      actor_user_id: string | null;
      actor_class: string;
      invocation_context: string;
      summary: string;
      details: string;
      redacted: number;
      risk_level: string;
      evaluator_decision_id: string | null;
    };
    expect(audit).toMatchObject({
      category: 'system',
      level: 'summary',
      event_id: `${canonicalUserId}:${groupId}`,
      actor_user_id: null,
      actor_class: 'admin',
      invocation_context: 'admin_cli',
      redacted: 1,
      risk_level: 'medium',
      evaluator_decision_id: null,
    });
    expect(audit.timestamp).toBeGreaterThanOrEqual(targetProfile.observed_at);
    expect(audit.timestamp).toBeLessThanOrEqual(finishedAt);
    expect(audit.summary).toContain('[REDACTED:platform_id]');
    expect(audit.summary).toContain('[REDACTED:openai_like_api_key]');
    const auditDetails = JSON.parse(audit.details) as Record<string, unknown>;
    expect(auditDetails).toEqual({
      canonicalUserId: expect.stringContaining('[REDACTED:platform_id]'),
      groupId: expect.stringContaining('[REDACTED:platform_id]'),
      displayProfilesUpdated: 1,
      nicknameHistoryUpdated: 2,
    });
    const durableAuditDisplay = JSON.stringify({ summary: audit.summary, details: auditDetails });
    expect(durableAuditDisplay).not.toContain('12345');
    expect(durableAuditDisplay).not.toContain('67890');
    expect(durableAuditDisplay).not.toContain('sk-profile');
    expect(durableAuditDisplay).not.toContain('sk-group');

    const zeroUserId = 'missing_qq-24680_sk-zeroabcdefghijklmnopqrstuvwxyz';
    expect(service.redactDisplayProfileAsLocalAdmin({ canonicalUserId: zeroUserId })).toBe(0);
    const zeroAudit = db.prepare(
      `SELECT event_id, details
         FROM audit_log
        WHERE event_type = 'display_profile.redact' AND event_id = ?`,
    ).get(`${zeroUserId}:`) as { event_id: string; details: string };
    expect(zeroAudit.event_id).toBe(`${zeroUserId}:`);
    expect(JSON.parse(zeroAudit.details)).toEqual({
      canonicalUserId: expect.stringContaining('[REDACTED:platform_id]'),
      displayProfilesUpdated: 0,
      nicknameHistoryUpdated: 0,
    });

    db.exec(
      `CREATE TRIGGER fail_display_profile_redact_audit
       BEFORE INSERT ON audit_log
       WHEN NEW.event_type = 'display_profile.redact'
        AND NEW.event_id = '${rollbackUserId}:${rollbackGroupId}'
       BEGIN
         SELECT RAISE(ABORT, 'synthetic display profile audit failure');
       END`,
    );
    expect(() => service.redactDisplayProfileAsLocalAdmin({
      canonicalUserId: rollbackUserId,
      groupId: rollbackGroupId,
    })).toThrow('synthetic display profile audit failure');
    db.exec('DROP TRIGGER fail_display_profile_redact_audit');
    expect(db.prepare(
      `SELECT current_display_name, observed_at, trust
         FROM display_profiles
        WHERE canonical_user_id = ? AND source_group_id = ?`,
    ).get(rollbackUserId, rollbackGroupId)).toEqual({
      current_display_name: 'Rollback display stays',
      observed_at: BASE_TIME + 2,
      trust: 'platform_provided',
    });
    expect(db.prepare(
      `SELECT display_name, observed_until
         FROM nickname_history
        WHERE id = 'profile-rollback-open'`,
    ).get()).toEqual({
      display_name: 'Rollback history stays',
      observed_until: null,
    });
    expect(db.prepare(
      `SELECT COUNT(*)
         FROM audit_log
        WHERE event_type = 'display_profile.redact' AND event_id = ?`,
    ).pluck().get(`${rollbackUserId}:${rollbackGroupId}`)).toBe(0);

    closeDatabase(db);
    db = initDatabase({ path: join(root, 'test.db') });
    expect(db.prepare(
      `SELECT current_display_name, observed_at, trust
         FROM display_profiles
        WHERE canonical_user_id = ? AND source_group_id = ?`,
    ).get(canonicalUserId, groupId)).toEqual(targetProfile);
    expect(db.prepare(
      `SELECT COUNT(*)
         FROM audit_log
        WHERE event_type = 'display_profile.redact'`,
    ).pluck().get()).toBe(2);
    expectIntegrity();
  });

  it('redacts display-profile target only from the exact current snapshot', async () => {
    const insertUser = db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?)`,
    );
    const insertProfile = db.prepare(
      `INSERT INTO display_profiles (
         canonical_user_id, source_group_id, current_display_name, observed_at, trust
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertHistory = db.prepare(
      `INSERT INTO nickname_history (
         id, canonical_user_id, source_group_id, display_name, observed_at, observed_until
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const queryService = new GovernanceQueryService(db);
    const prepareExpectedInput = async (input: {
      canonicalUserId: string;
      groupId?: string;
      now: number;
    }) => {
      const scope = { kind: 'user' as const, canonicalUserId: input.canonicalUserId };
      const targetId = deriveDisplayProfileTargetResourceId(scope, input.groupId ?? '');
      const preview = await queryService.getDisplayProfileTargetRedactionPreviewForScope({
        scope,
        targetId,
      });
      if (!preview) {
        throw new Error('Expected display-profile redaction preview');
      }
      return {
        preview,
        expectedInput: {
          canonicalUserId: input.canonicalUserId,
          ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
          targetId,
          expectedSnapshot: preview.current,
          reasonCode: DISPLAY_PROFILE_REDACTION_REASON_CODE,
          now: input.now,
        },
      };
    };

    const canonicalUserId = 'legacy_qq-12345_sk-profileexpectedabcdefghijklmnopqrstuvwxyz';
    const groupId = 'legacy_qq-group-67890_sk-groupexpectedabcdefghijklmnopqrstuvwxyz';
    const redactedAt = BASE_TIME + 50_000;
    insertUser.run(canonicalUserId, BASE_TIME, BASE_TIME);
    insertProfile.run(
      canonicalUserId,
      groupId,
      'Expected group display',
      BASE_TIME + 1,
      'platform_provided',
    );
    insertHistory.run(
      'display-profile-expected-open',
      canonicalUserId,
      groupId,
      'Expected open history',
      BASE_TIME + 2,
      null,
    );
    insertHistory.run(
      'display-profile-expected-closed',
      canonicalUserId,
      groupId,
      'Expected closed history',
      BASE_TIME + 3,
      BASE_TIME + 4,
    );
    insertHistory.run(
      'display-profile-expected-blob',
      canonicalUserId,
      groupId,
      Buffer.from('Expected blob history', 'utf8'),
      BASE_TIME + 5,
      null,
    );
    insertHistory.run(
      'display-profile-expected-invalid-lifecycle',
      canonicalUserId,
      groupId,
      'Expected invalid lifecycle history',
      BASE_TIME + 7,
      BASE_TIME + 6,
    );
    db.pragma('ignore_check_constraints = ON');
    db.prepare(
      `UPDATE display_profiles
          SET current_display_name = ?, observed_at = ?, trust = ?
        WHERE canonical_user_id = ? AND source_group_id = ?`,
    ).run(
      Buffer.from('Expected blob profile', 'utf8'),
      'invalid-observed-at',
      'invalid-trust',
      canonicalUserId,
      groupId,
    );

    const main = await prepareExpectedInput({ canonicalUserId, groupId, now: redactedAt });
    expect(main.preview.current).toMatchObject({
      displayProfileRows: 1,
      nicknameHistoryRows: 4,
      openNicknameHistoryRows: 2,
    });
    const mainResult = service.redactDisplayProfileAsLocalAdmin(main.expectedInput);
    expect(mainResult).toEqual({
      outcome: 'redacted',
      displayProfilesUpdated: 1,
      nicknameHistoryUpdated: 4,
      openNicknameHistoryRowsClosed: 2,
      redactedAt,
    });
    expect(JSON.stringify(mainResult)).not.toContain(canonicalUserId);
    expect(JSON.stringify(mainResult)).not.toContain(groupId);
    expect(JSON.stringify(mainResult)).not.toContain(main.expectedInput.targetId);
    expect(db.prepare(
      `SELECT current_display_name, observed_at, trust
         FROM display_profiles
        WHERE canonical_user_id = ? AND source_group_id = ?`,
    ).get(canonicalUserId, groupId)).toEqual({
      current_display_name: '[redacted]',
      observed_at: redactedAt,
      trust: 'user_set',
    });
    expect(db.prepare(
      `SELECT id, display_name, observed_until
         FROM nickname_history
        WHERE canonical_user_id = ? AND source_group_id = ?
        ORDER BY id`,
    ).all(canonicalUserId, groupId)).toEqual([
      {
        id: 'display-profile-expected-blob',
        display_name: '[redacted]',
        observed_until: redactedAt,
      },
      {
        id: 'display-profile-expected-closed',
        display_name: '[redacted]',
        observed_until: BASE_TIME + 4,
      },
      {
        id: 'display-profile-expected-invalid-lifecycle',
        display_name: '[redacted]',
        observed_until: BASE_TIME + 6,
      },
      {
        id: 'display-profile-expected-open',
        display_name: '[redacted]',
        observed_until: redactedAt,
      },
    ]);
    const mainAudit = db.prepare(
      `SELECT timestamp, actor_user_id, actor_class, invocation_context,
              summary, details, redacted, risk_level
         FROM audit_log
        WHERE event_type = 'display_profile.redact' AND event_id = ?`,
    ).get(`${canonicalUserId}:${groupId}`) as {
      timestamp: number;
      actor_user_id: string | null;
      actor_class: string;
      invocation_context: string;
      summary: string;
      details: string;
      redacted: number;
      risk_level: string;
    };
    expect(mainAudit).toMatchObject({
      timestamp: redactedAt,
      actor_user_id: null,
      actor_class: 'admin',
      invocation_context: 'admin_cli',
      redacted: 1,
      risk_level: 'medium',
    });
    expect(JSON.parse(mainAudit.details)).toEqual({
      canonicalUserId: expect.stringContaining('[REDACTED:platform_id]'),
      groupId: expect.stringContaining('[REDACTED:platform_id]'),
      reasonCode: DISPLAY_PROFILE_REDACTION_REASON_CODE,
      displayProfilesUpdated: 1,
      nicknameHistoryUpdated: 4,
      openNicknameHistoryRowsClosed: 2,
    });
    const serializedAudit = JSON.stringify({
      summary: mainAudit.summary,
      details: JSON.parse(mainAudit.details),
    });
    expect(serializedAudit).not.toContain('12345');
    expect(serializedAudit).not.toContain('67890');
    expect(serializedAudit).not.toContain('sk-profileexpected');
    expect(serializedAudit).not.toContain('sk-groupexpected');

    const postRedactionPreview = await queryService
      .getDisplayProfileTargetRedactionPreviewForScope({
        scope: { kind: 'user', canonicalUserId },
        targetId: main.expectedInput.targetId,
      });
    expect(postRedactionPreview?.current).toMatchObject({
      displayProfileRows: 1,
      nicknameHistoryRows: 4,
      openNicknameHistoryRows: 0,
    });
    expect(postRedactionPreview?.current.snapshotFingerprint)
      .not.toBe(main.preview.current.snapshotFingerprint);
    const changesBeforeReuse = db.prepare('SELECT total_changes()').pluck().get();
    expect(service.redactDisplayProfileAsLocalAdmin(main.expectedInput))
      .toEqual({ outcome: 'stale' });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeReuse);
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'display_profile.redact' AND event_id = ?`,
    ).pluck().get(`${canonicalUserId}:${groupId}`)).toBe(1);

    const missingUserId = 'user-display-profile-missing';
    const missingGroupId = 'group-display-profile-missing';
    insertUser.run(missingUserId, BASE_TIME, BASE_TIME);
    expect(service.redactDisplayProfileAsLocalAdmin({
      canonicalUserId: missingUserId,
      groupId: missingGroupId,
      targetId: deriveDisplayProfileTargetResourceId(
        { kind: 'user', canonicalUserId: missingUserId },
        missingGroupId,
      ),
      expectedSnapshot: main.preview.current,
      reasonCode: DISPLAY_PROFILE_REDACTION_REASON_CODE,
      now: redactedAt + 1,
    })).toEqual({ outcome: 'not_found' });

    const driftUserId = 'user-display-profile-drift';
    const driftGroupId = 'group-display-profile-drift';
    const driftProfileValue = 'Drift profile value';
    const driftHistoryId = 'display-profile-drift-history';
    const driftHistoryValue = 'Drift history value';
    insertUser.run(driftUserId, BASE_TIME, BASE_TIME);
    insertProfile.run(
      driftUserId,
      driftGroupId,
      driftProfileValue,
      BASE_TIME + 100,
      'platform_provided',
    );
    insertHistory.run(
      driftHistoryId,
      driftUserId,
      driftGroupId,
      driftHistoryValue,
      BASE_TIME + 101,
      null,
    );
    const drift = await prepareExpectedInput({
      canonicalUserId: driftUserId,
      groupId: driftGroupId,
      now: redactedAt + 100,
    });
    const invalidInputs: unknown[] = [
      { ...drift.expectedInput, canonicalUserId: ` ${driftUserId}` },
      { ...drift.expectedInput, canonicalUserId: 1 },
      { ...drift.expectedInput, groupId: '' },
      { ...drift.expectedInput, groupId: ` ${driftGroupId}` },
      { ...drift.expectedInput, groupId: 1 },
      { ...drift.expectedInput, targetId: '' },
      { ...drift.expectedInput, targetId: drift.expectedInput.targetId.toUpperCase() },
      {
        ...drift.expectedInput,
        targetId: deriveDisplayProfileTargetResourceId(
          { kind: 'user', canonicalUserId: driftUserId },
          'group-display-profile-other',
        ),
      },
      {
        canonicalUserId: driftUserId,
        targetId: drift.expectedInput.targetId,
        expectedSnapshot: drift.preview.current,
        reasonCode: DISPLAY_PROFILE_REDACTION_REASON_CODE,
        now: redactedAt + 100,
      },
      { ...drift.expectedInput, reasonCode: 'invalid_reason' },
      { ...drift.expectedInput, now: -1 },
      { ...drift.expectedInput, now: 1.5 },
      { ...drift.expectedInput, now: 8_640_000_000_000_001 },
      { ...drift.expectedInput, now: 'invalid-time' },
      { ...drift.expectedInput, expectedSnapshot: null },
      { ...drift.expectedInput, expectedSnapshot: [] },
      { ...drift.expectedInput, expectedSnapshot: {} },
      {
        ...drift.expectedInput,
        expectedSnapshot: { ...drift.preview.current, extra: true },
      },
      {
        ...drift.expectedInput,
        expectedSnapshot: { ...drift.preview.current, displayProfileRows: -1 },
      },
      {
        ...drift.expectedInput,
        expectedSnapshot: { ...drift.preview.current, displayProfileRows: 0.5 },
      },
      {
        ...drift.expectedInput,
        expectedSnapshot: {
          ...drift.preview.current,
          displayProfileRows: Number.MAX_SAFE_INTEGER,
        },
      },
      {
        ...drift.expectedInput,
        expectedSnapshot: { ...drift.preview.current, nicknameHistoryRows: -1 },
      },
      {
        ...drift.expectedInput,
        expectedSnapshot: { ...drift.preview.current, openNicknameHistoryRows: -1 },
      },
      {
        ...drift.expectedInput,
        expectedSnapshot: { ...drift.preview.current, openNicknameHistoryRows: 2 },
      },
      {
        ...drift.expectedInput,
        expectedSnapshot: {
          ...drift.preview.current,
          displayProfileRows: 0,
          nicknameHistoryRows: 0,
          openNicknameHistoryRows: 0,
        },
      },
      {
        ...drift.expectedInput,
        expectedSnapshot: { ...drift.preview.current, snapshotFingerprint: 'a'.repeat(63) },
      },
      { ...drift.expectedInput, extra: true },
    ];
    const changesBeforeInvalid = db.prepare('SELECT total_changes()').pluck().get();
    for (const invalidInput of invalidInputs) {
      expect(service.redactDisplayProfileAsLocalAdmin(invalidInput as never))
        .toEqual({ outcome: 'stale' });
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeInvalid);

    const assertSnapshotDrift = async (
      mutate: () => void,
      restore: () => void,
    ): Promise<void> => {
      mutate();
      const changesBeforeAttempt = db.prepare('SELECT total_changes()').pluck().get();
      expect(service.redactDisplayProfileAsLocalAdmin(drift.expectedInput))
        .toEqual({ outcome: 'stale' });
      expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeAttempt);
      restore();
      await expect(queryService.getDisplayProfileTargetRedactionPreviewForScope({
        scope: { kind: 'user', canonicalUserId: driftUserId },
        targetId: drift.expectedInput.targetId,
      })).resolves.toEqual(drift.preview);
    };
    await assertSnapshotDrift(
      () => {
        db.prepare(
          `UPDATE display_profiles SET current_display_name = ?
            WHERE canonical_user_id = ? AND source_group_id = ?`,
        ).run('Changed profile value', driftUserId, driftGroupId);
      },
      () => {
        db.prepare(
          `UPDATE display_profiles SET current_display_name = ?
            WHERE canonical_user_id = ? AND source_group_id = ?`,
        ).run(driftProfileValue, driftUserId, driftGroupId);
      },
    );
    await assertSnapshotDrift(
      () => {
        db.prepare(
          `UPDATE display_profiles SET current_display_name = ?
            WHERE canonical_user_id = ? AND source_group_id = ?`,
        ).run(Buffer.from('Changed profile type', 'utf8'), driftUserId, driftGroupId);
      },
      () => {
        db.prepare(
          `UPDATE display_profiles SET current_display_name = ?
            WHERE canonical_user_id = ? AND source_group_id = ?`,
        ).run(driftProfileValue, driftUserId, driftGroupId);
      },
    );
    await assertSnapshotDrift(
      () => {
        db.prepare(
          `UPDATE display_profiles SET observed_at = ?
            WHERE canonical_user_id = ? AND source_group_id = ?`,
        ).run(BASE_TIME + 102, driftUserId, driftGroupId);
      },
      () => {
        db.prepare(
          `UPDATE display_profiles SET observed_at = ?
            WHERE canonical_user_id = ? AND source_group_id = ?`,
        ).run(BASE_TIME + 100, driftUserId, driftGroupId);
      },
    );
    await assertSnapshotDrift(
      () => {
        db.prepare(
          `UPDATE display_profiles SET trust = 'inferred'
            WHERE canonical_user_id = ? AND source_group_id = ?`,
        ).run(driftUserId, driftGroupId);
      },
      () => {
        db.prepare(
          `UPDATE display_profiles SET trust = 'platform_provided'
            WHERE canonical_user_id = ? AND source_group_id = ?`,
        ).run(driftUserId, driftGroupId);
      },
    );
    await assertSnapshotDrift(
      () => {
        db.prepare(
          `UPDATE nickname_history SET display_name = ? WHERE id = ?`,
        ).run('Changed history value', driftHistoryId);
      },
      () => {
        db.prepare(
          `UPDATE nickname_history SET display_name = ? WHERE id = ?`,
        ).run(driftHistoryValue, driftHistoryId);
      },
    );
    await assertSnapshotDrift(
      () => {
        db.prepare(
          `UPDATE nickname_history SET display_name = ? WHERE id = ?`,
        ).run(Buffer.from('Changed history type', 'utf8'), driftHistoryId);
      },
      () => {
        db.prepare(
          `UPDATE nickname_history SET display_name = ? WHERE id = ?`,
        ).run(driftHistoryValue, driftHistoryId);
      },
    );
    await assertSnapshotDrift(
      () => {
        db.prepare(
          `UPDATE nickname_history SET observed_at = ? WHERE id = ?`,
        ).run(BASE_TIME + 102, driftHistoryId);
      },
      () => {
        db.prepare(
          `UPDATE nickname_history SET observed_at = ? WHERE id = ?`,
        ).run(BASE_TIME + 101, driftHistoryId);
      },
    );
    await assertSnapshotDrift(
      () => {
        db.prepare(
          `UPDATE nickname_history SET observed_until = ? WHERE id = ?`,
        ).run(BASE_TIME + 103, driftHistoryId);
      },
      () => {
        db.prepare(
          `UPDATE nickname_history SET observed_until = NULL WHERE id = ?`,
        ).run(driftHistoryId);
      },
    );
    await assertSnapshotDrift(
      () => {
        insertHistory.run(
          'display-profile-drift-added',
          driftUserId,
          driftGroupId,
          'Added history value',
          BASE_TIME + 104,
          null,
        );
      },
      () => {
        db.prepare(`DELETE FROM nickname_history WHERE id = 'display-profile-drift-added'`).run();
      },
    );
    await assertSnapshotDrift(
      () => {
        db.prepare('DELETE FROM nickname_history WHERE id = ?').run(driftHistoryId);
      },
      () => {
        insertHistory.run(
          driftHistoryId,
          driftUserId,
          driftGroupId,
          driftHistoryValue,
          BASE_TIME + 101,
          null,
        );
      },
    );
    const changesBeforeBoundEvidence = db.prepare('SELECT total_changes()').pluck().get();
    expect(service.redactDisplayProfileAsLocalAdmin({
      ...drift.expectedInput,
      expectedSnapshot: {
        ...drift.preview.current,
        displayProfileRows: drift.preview.current.displayProfileRows + 1,
      },
    })).toEqual({ outcome: 'stale' });
    expect(service.redactDisplayProfileAsLocalAdmin({
      ...drift.expectedInput,
      expectedSnapshot: {
        ...drift.preview.current,
        snapshotFingerprint: 'a'.repeat(64),
      },
    })).toEqual({ outcome: 'stale' });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeBoundEvidence);

    const privateUserId = 'user-display-profile-private';
    insertUser.run(privateUserId, BASE_TIME, BASE_TIME);
    insertProfile.run(
      privateUserId,
      '',
      'Private display value',
      BASE_TIME + 200,
      'user_set',
    );
    const privateTarget = await prepareExpectedInput({
      canonicalUserId: privateUserId,
      now: redactedAt + 200,
    });
    expect(service.redactDisplayProfileAsLocalAdmin(privateTarget.expectedInput)).toEqual({
      outcome: 'redacted',
      displayProfilesUpdated: 1,
      nicknameHistoryUpdated: 0,
      openNicknameHistoryRowsClosed: 0,
      redactedAt: redactedAt + 200,
    });

    const historyOnlyUserId = 'user-display-profile-history-only';
    const historyOnlyGroupId = 'group-display-profile-history-only';
    insertUser.run(historyOnlyUserId, BASE_TIME, BASE_TIME);
    insertHistory.run(
      'display-profile-history-only-open',
      historyOnlyUserId,
      historyOnlyGroupId,
      'History-only value',
      BASE_TIME + 300,
      null,
    );
    const historyOnlyTarget = await prepareExpectedInput({
      canonicalUserId: historyOnlyUserId,
      groupId: historyOnlyGroupId,
      now: redactedAt + 300,
    });
    expect(service.redactDisplayProfileAsLocalAdmin(historyOnlyTarget.expectedInput)).toEqual({
      outcome: 'redacted',
      displayProfilesUpdated: 0,
      nicknameHistoryUpdated: 1,
      openNicknameHistoryRowsClosed: 1,
      redactedAt: redactedAt + 300,
    });

    const redactedUserId = 'user-display-profile-already-redacted';
    const redactedGroupId = 'group-display-profile-already-redacted';
    insertUser.run(redactedUserId, BASE_TIME, BASE_TIME);
    insertProfile.run(
      redactedUserId,
      redactedGroupId,
      '[redacted]',
      BASE_TIME + 400,
      'user_set',
    );
    insertHistory.run(
      'display-profile-already-redacted-closed',
      redactedUserId,
      redactedGroupId,
      '[redacted]',
      BASE_TIME + 401,
      BASE_TIME + 402,
    );
    const redactedTarget = await prepareExpectedInput({
      canonicalUserId: redactedUserId,
      groupId: redactedGroupId,
      now: redactedAt + 400,
    });
    expect(service.redactDisplayProfileAsLocalAdmin(redactedTarget.expectedInput)).toEqual({
      outcome: 'redacted',
      displayProfilesUpdated: 1,
      nicknameHistoryUpdated: 1,
      openNicknameHistoryRowsClosed: 0,
      redactedAt: redactedAt + 400,
    });

    const countMismatchUserId = 'user-display-profile-count-mismatch';
    const countMismatchGroupId = 'group-display-profile-count-mismatch';
    insertUser.run(countMismatchUserId, BASE_TIME, BASE_TIME);
    insertProfile.run(
      countMismatchUserId,
      countMismatchGroupId,
      'Count mismatch profile',
      BASE_TIME + 500,
      'platform_provided',
    );
    insertHistory.run(
      'display-profile-count-mismatch-history',
      countMismatchUserId,
      countMismatchGroupId,
      'Count mismatch history',
      BASE_TIME + 501,
      null,
    );
    const countMismatchTarget = await prepareExpectedInput({
      canonicalUserId: countMismatchUserId,
      groupId: countMismatchGroupId,
      now: redactedAt + 500,
    });
    db.exec(
      `CREATE TRIGGER ignore_expected_display_profile_update
       BEFORE UPDATE ON display_profiles
       WHEN OLD.canonical_user_id = '${countMismatchUserId}'
        AND OLD.source_group_id = '${countMismatchGroupId}'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    );
    expect(service.redactDisplayProfileAsLocalAdmin(countMismatchTarget.expectedInput))
      .toEqual({ outcome: 'stale' });
    db.exec('DROP TRIGGER ignore_expected_display_profile_update');
    expect(db.prepare(
      `SELECT current_display_name, observed_at, trust
         FROM display_profiles
        WHERE canonical_user_id = ? AND source_group_id = ?`,
    ).get(countMismatchUserId, countMismatchGroupId)).toEqual({
      current_display_name: 'Count mismatch profile',
      observed_at: BASE_TIME + 500,
      trust: 'platform_provided',
    });
    db.exec(
      `CREATE TRIGGER ignore_expected_nickname_history_update
       BEFORE UPDATE ON nickname_history
       WHEN OLD.canonical_user_id = '${countMismatchUserId}'
        AND OLD.source_group_id = '${countMismatchGroupId}'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    );
    expect(service.redactDisplayProfileAsLocalAdmin(countMismatchTarget.expectedInput))
      .toEqual({ outcome: 'stale' });
    db.exec('DROP TRIGGER ignore_expected_nickname_history_update');
    expect(db.prepare(
      `SELECT current_display_name, observed_at, trust
         FROM display_profiles
        WHERE canonical_user_id = ? AND source_group_id = ?`,
    ).get(countMismatchUserId, countMismatchGroupId)).toEqual({
      current_display_name: 'Count mismatch profile',
      observed_at: BASE_TIME + 500,
      trust: 'platform_provided',
    });
    expect(db.prepare(
      `SELECT display_name, observed_until FROM nickname_history
        WHERE id = 'display-profile-count-mismatch-history'`,
    ).get()).toEqual({
      display_name: 'Count mismatch history',
      observed_until: null,
    });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'display_profile.redact' AND event_id = ?`,
    ).pluck().get(`${countMismatchUserId}:${countMismatchGroupId}`)).toBe(0);

    const auditFailureUserId = 'user-display-profile-audit-failure';
    const auditFailureGroupId = 'group-display-profile-audit-failure';
    insertUser.run(auditFailureUserId, BASE_TIME, BASE_TIME);
    insertProfile.run(
      auditFailureUserId,
      auditFailureGroupId,
      'Audit failure profile',
      BASE_TIME + 600,
      'platform_provided',
    );
    insertHistory.run(
      'display-profile-audit-failure-history',
      auditFailureUserId,
      auditFailureGroupId,
      'Audit failure history',
      BASE_TIME + 601,
      null,
    );
    const auditFailureTarget = await prepareExpectedInput({
      canonicalUserId: auditFailureUserId,
      groupId: auditFailureGroupId,
      now: redactedAt + 600,
    });
    db.exec(
      `CREATE TRIGGER fail_expected_display_profile_audit
       BEFORE INSERT ON audit_log
       WHEN NEW.event_type = 'display_profile.redact'
        AND NEW.event_id = '${auditFailureUserId}:${auditFailureGroupId}'
       BEGIN
         SELECT RAISE(ABORT, 'synthetic expected display profile audit failure');
       END`,
    );
    expect(() => service.redactDisplayProfileAsLocalAdmin(auditFailureTarget.expectedInput))
      .toThrow('synthetic expected display profile audit failure');
    db.exec('DROP TRIGGER fail_expected_display_profile_audit');
    expect(db.prepare(
      `SELECT current_display_name, observed_at, trust
         FROM display_profiles
        WHERE canonical_user_id = ? AND source_group_id = ?`,
    ).get(auditFailureUserId, auditFailureGroupId)).toEqual({
      current_display_name: 'Audit failure profile',
      observed_at: BASE_TIME + 600,
      trust: 'platform_provided',
    });
    expect(db.prepare(
      `SELECT display_name, observed_until FROM nickname_history
        WHERE id = 'display-profile-audit-failure-history'`,
    ).get()).toEqual({
      display_name: 'Audit failure history',
      observed_until: null,
    });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'display_profile.redact' AND event_id = ?`,
    ).pluck().get(`${auditFailureUserId}:${auditFailureGroupId}`)).toBe(0);

    closeDatabase(db);
    db = initDatabase({ path: join(root, 'test.db') });
    expect(db.prepare(
      `SELECT current_display_name, observed_at, trust
         FROM display_profiles
        WHERE canonical_user_id = ? AND source_group_id = ?`,
    ).get(canonicalUserId, groupId)).toEqual({
      current_display_name: '[redacted]',
      observed_at: redactedAt,
      trust: 'user_set',
    });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log
        WHERE event_type = 'display_profile.redact'`,
    ).pluck().get()).toBe(4);
    expectIntegrity();
  });

  it('owns local-admin privacy preference writes with atomic audit and enforcement evidence', async () => {
    const privacyPreferences = new PrivacyPreferenceRepository(db);
    const canonicalUserId = 'user-local-privacy';
    const rollbackUserId = 'user-local-privacy-rollback';
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?), (?, ?, ?)`,
    ).run(
      canonicalUserId,
      BASE_TIME,
      BASE_TIME,
      rollbackUserId,
      BASE_TIME,
      BASE_TIME,
    );

    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const platformId = 'qq-123456789';
    expect(service.setPrivacyPreferenceAsLocalAdmin({
      canonicalUserId,
      preferenceType: 'proactive_dm',
      state: 'opted_out',
      reason: `operator supplied ${secret} for ${platformId}`,
      now: BASE_TIME + 1_000,
    })).toEqual({ outcome: 'updated' });
    expect(await privacyPreferences.isOptedOut(canonicalUserId, 'proactive_dm')).toBe(true);

    const redactedRow = db.prepare(
      `SELECT state, reason, updated_by_user_id, updated_by_actor_class,
              updated_by_context, created_at, updated_at
         FROM privacy_preferences
        WHERE canonical_user_id = ? AND preference_type = ?`,
    ).get(canonicalUserId, 'proactive_dm') as {
      state: string;
      reason: string;
      updated_by_user_id: string;
      updated_by_actor_class: string;
      updated_by_context: string;
      created_at: number;
      updated_at: number;
    };
    expect(redactedRow).toMatchObject({
      state: 'opted_out',
      updated_by_user_id: 'admin',
      updated_by_actor_class: 'admin',
      updated_by_context: 'admin_cli',
      created_at: BASE_TIME + 1_000,
      updated_at: BASE_TIME + 1_000,
    });
    expect(redactedRow.reason).toContain('[REDACTED:openai_like_api_key]');
    expect(redactedRow.reason).toContain('[REDACTED:platform_id]');
    expect(redactedRow.reason).not.toContain(secret);
    expect(redactedRow.reason).not.toContain('123456789');

    for (const input of [
      {
        preferenceType: 'proactive_dm' as const,
        state: 'opted_in' as const,
        reason: 'Proactive messages permitted',
        now: BASE_TIME + 2_000,
      },
      {
        preferenceType: 'memory_association' as const,
        state: 'opted_out' as const,
        reason: 'Memory association disabled',
        now: BASE_TIME + 3_000,
      },
      {
        preferenceType: 'memory_association' as const,
        state: 'opted_in' as const,
        reason: 'Memory association permitted',
        now: BASE_TIME + 4_000,
      },
    ]) {
      expect(service.setPrivacyPreferenceAsLocalAdmin({
        canonicalUserId,
        ...input,
      })).toEqual({ outcome: 'updated' });
    }
    expect(await privacyPreferences.isOptedOut(canonicalUserId, 'proactive_dm')).toBe(false);
    expect(await privacyPreferences.isOptedOut(canonicalUserId, 'memory_association')).toBe(false);

    const audits = db.prepare(
      `SELECT timestamp, event_type, event_id, actor_user_id, actor_class,
              invocation_context, details
         FROM audit_log
        WHERE event_id IN (?, ?)
        ORDER BY timestamp ASC`,
    ).all(
      `${canonicalUserId}:proactive_dm`,
      `${canonicalUserId}:memory_association`,
    ) as Array<{
      timestamp: number;
      event_type: string;
      event_id: string;
      actor_user_id: string;
      actor_class: string;
      invocation_context: string;
      details: string;
    }>;
    expect(audits).toHaveLength(4);
    expect(audits.map((audit) => audit.timestamp)).toEqual([
      BASE_TIME + 1_000,
      BASE_TIME + 2_000,
      BASE_TIME + 3_000,
      BASE_TIME + 4_000,
    ]);
    expect(audits.every((audit) => (
      audit.event_type === 'privacy.preference_set'
      && audit.actor_user_id === 'admin'
      && audit.actor_class === 'admin'
      && audit.invocation_context === 'admin_cli'
    ))).toBe(true);
    expect(audits[0]?.details).toContain('[REDACTED:openai_like_api_key]');
    expect(audits[0]?.details).toContain('[REDACTED:platform_id]');
    expect(audits[0]?.details).not.toContain(secret);
    expect(audits[0]?.details).not.toContain('123456789');

    const changesBeforeMissing = db.prepare('SELECT total_changes()').pluck().get();
    expect(() => service.setPrivacyPreferenceAsLocalAdmin({
      canonicalUserId: 'missing-local-privacy-user',
      preferenceType: 'proactive_dm',
      state: 'opted_out',
      reason: 'Missing user must fail atomically',
      now: BASE_TIME + 5_000,
    })).toThrow();
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeMissing);

    db.exec(
      `CREATE TRIGGER fail_local_privacy_audit
       BEFORE INSERT ON audit_log
       BEGIN
         SELECT RAISE(ABORT, 'synthetic local privacy audit failure');
       END`,
    );
    expect(() => service.setPrivacyPreferenceAsLocalAdmin({
      canonicalUserId: rollbackUserId,
      preferenceType: 'memory_association',
      state: 'opted_out',
      reason: 'Rollback on audit failure',
      now: BASE_TIME + 6_000,
    })).toThrow('synthetic local privacy audit failure');
    db.exec('DROP TRIGGER fail_local_privacy_audit');
    expect(privacyPreferences.find(rollbackUserId, 'memory_association')).toBeNull();
    expect(db.prepare(
      `SELECT COUNT(*)
         FROM audit_log
        WHERE event_id = ?`,
    ).pluck().get(`${rollbackUserId}:memory_association`)).toBe(0);
    expectIntegrity();
  });

  it('atomically applies expected Privacy preference snapshots through the shared owner', async () => {
    const canonicalUserId = 'user-expected-privacy';
    const rollbackUserId = 'user-expected-privacy-rollback';
    const legacyUserId = 'user-expected-privacy-legacy';
    db.prepare(
      `INSERT INTO canonical_users (id, created_at, last_seen_at)
       VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
    ).run(
      canonicalUserId, BASE_TIME, BASE_TIME,
      rollbackUserId, BASE_TIME, BASE_TIME,
      legacyUserId, BASE_TIME, BASE_TIME,
    );
    const privacyPreferences = new PrivacyPreferenceRepository(db);

    expect(service.setPrivacyPreferenceAsLocalAdmin({
      canonicalUserId,
      preferenceType: 'proactive_dm',
      state: 'opted_out',
      expectedState: 'opted_in',
      expectedVersion: { source: 'implicit_default', updatedAt: null },
      reasonCode: 'governance_http_privacy_change_confirmed',
      now: BASE_TIME + 10_000,
    })).toEqual({ outcome: 'updated', updatedAt: BASE_TIME + 10_000 });
    expect(await privacyPreferences.isOptedOut(canonicalUserId, 'proactive_dm')).toBe(true);
    expect(db.prepare(
      `SELECT state, reason, updated_by_user_id, updated_by_actor_class,
              updated_by_context, created_at, updated_at
         FROM privacy_preferences
        WHERE canonical_user_id = ? AND preference_type = ?`,
    ).get(canonicalUserId, 'proactive_dm')).toEqual({
      state: 'opted_out',
      reason: 'governance_http_privacy_change_confirmed',
      updated_by_user_id: 'admin',
      updated_by_actor_class: 'admin',
      updated_by_context: 'admin_cli',
      created_at: BASE_TIME + 10_000,
      updated_at: BASE_TIME + 10_000,
    });

    const changesBeforeStaleRetry = db.prepare('SELECT total_changes()').pluck().get();
    expect(service.setPrivacyPreferenceAsLocalAdmin({
      canonicalUserId,
      preferenceType: 'proactive_dm',
      state: 'opted_out',
      expectedState: 'opted_in',
      expectedVersion: { source: 'implicit_default', updatedAt: null },
      reasonCode: 'governance_http_privacy_change_confirmed',
      now: BASE_TIME + 10_001,
    })).toEqual({ outcome: 'stale' });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeStaleRetry);

    expect(service.setPrivacyPreferenceAsLocalAdmin({
      canonicalUserId,
      preferenceType: 'proactive_dm',
      state: 'opted_in',
      expectedState: 'opted_out',
      expectedVersion: {
        source: 'stored_preference',
        updatedAt: BASE_TIME + 10_000,
      },
      reasonCode: 'governance_http_privacy_change_confirmed',
      now: BASE_TIME,
    })).toEqual({ outcome: 'updated', updatedAt: BASE_TIME + 10_001 });
    expect(await privacyPreferences.isOptedOut(canonicalUserId, 'proactive_dm')).toBe(false);
    expect(privacyPreferences.find(canonicalUserId, 'proactive_dm')).toMatchObject({
      state: 'opted_in',
      createdAt: new Date(BASE_TIME + 10_000),
      updatedAt: new Date(BASE_TIME + 10_001),
    });

    const validStoredInput = {
      canonicalUserId,
      preferenceType: 'proactive_dm' as const,
      state: 'opted_out' as const,
      expectedState: 'opted_in' as const,
      expectedVersion: {
        source: 'stored_preference' as const,
        updatedAt: BASE_TIME + 10_001,
      },
      reasonCode: 'governance_http_privacy_change_confirmed',
      now: BASE_TIME + 10_002,
    };
    const invalidInputs: unknown[] = [
      { ...validStoredInput, canonicalUserId: ` ${canonicalUserId}` },
      { ...validStoredInput, preferenceType: 'unknown_preference' },
      { ...validStoredInput, state: 'unknown_state' },
      { ...validStoredInput, expectedState: 'unknown_state' },
      { ...validStoredInput, state: 'opted_in' },
      { ...validStoredInput, reasonCode: 'Invalid reason code' },
      { ...validStoredInput, now: -1 },
      { ...validStoredInput, now: 1.5 },
      { ...validStoredInput, now: 8_640_000_000_000_001 },
      {
        ...validStoredInput,
        expectedVersion: { source: 'implicit_default', updatedAt: 1 },
      },
      {
        ...validStoredInput,
        expectedVersion: { source: 'stored_preference', updatedAt: null },
      },
      {
        ...validStoredInput,
        expectedVersion: { source: 'stored_preference', updatedAt: -1 },
      },
      {
        ...validStoredInput,
        expectedVersion: {
          source: 'stored_preference',
          updatedAt: BASE_TIME + 10_001,
          extra: true,
        },
      },
    ];
    const changesBeforeInvalid = db.prepare('SELECT total_changes()').pluck().get();
    for (const invalidInput of invalidInputs) {
      expect(service.setPrivacyPreferenceAsLocalAdmin(invalidInput as never))
        .toEqual({ outcome: 'stale' });
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeInvalid);
    expect(service.setPrivacyPreferenceAsLocalAdmin({
      canonicalUserId: 'missing-expected-privacy',
      preferenceType: 'proactive_dm',
      state: 'opted_out',
      expectedState: 'opted_in',
      expectedVersion: { source: 'implicit_default', updatedAt: null },
      reasonCode: 'governance_http_privacy_change_confirmed',
      now: BASE_TIME + 20_000,
    })).toEqual({ outcome: 'not_found' });
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeInvalid);

    expect(service.setPrivacyPreferenceAsLocalAdmin({
      canonicalUserId: rollbackUserId,
      preferenceType: 'memory_association',
      state: 'opted_out',
      expectedState: 'opted_in',
      expectedVersion: { source: 'implicit_default', updatedAt: null },
      reasonCode: 'governance_http_privacy_change_confirmed',
      now: BASE_TIME + 30_000,
    })).toEqual({ outcome: 'updated', updatedAt: BASE_TIME + 30_000 });
    db.exec(
      `CREATE TRIGGER fail_expected_service_privacy_audit
       BEFORE INSERT ON audit_log
       BEGIN
         SELECT RAISE(ABORT, 'synthetic expected service privacy audit failure');
       END`,
    );
    expect(() => service.setPrivacyPreferenceAsLocalAdmin({
      canonicalUserId: rollbackUserId,
      preferenceType: 'memory_association',
      state: 'opted_in',
      expectedState: 'opted_out',
      expectedVersion: {
        source: 'stored_preference',
        updatedAt: BASE_TIME + 30_000,
      },
      reasonCode: 'governance_http_privacy_change_confirmed',
      now: BASE_TIME + 30_001,
    })).toThrow('synthetic expected service privacy audit failure');
    db.exec('DROP TRIGGER fail_expected_service_privacy_audit');
    expect(privacyPreferences.find(rollbackUserId, 'memory_association')).toMatchObject({
      state: 'opted_out',
      updatedAt: new Date(BASE_TIME + 30_000),
    });
    expect(db.prepare(
      `SELECT COUNT(*) FROM audit_log WHERE event_id = ?`,
    ).pluck().get(`${rollbackUserId}:memory_association`)).toBe(1);

    expect(service.setPrivacyPreferenceAsLocalAdmin({
      canonicalUserId: legacyUserId,
      preferenceType: 'memory_association',
      state: 'opted_out',
      reason: 'Legacy local-admin behavior remains exact',
      now: BASE_TIME + 40_000,
    })).toEqual({ outcome: 'updated' });
    expect(privacyPreferences.find(legacyUserId, 'memory_association')).toMatchObject({
      state: 'opted_out',
      reason: 'Legacy local-admin behavior remains exact',
      createdAt: new Date(BASE_TIME + 40_000),
      updatedAt: new Date(BASE_TIME + 40_000),
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

  it('owns atomic expected group-summary policy snapshots without changing legacy callers', () => {
    const reasonCode = 'governance_http_group_summary_policy_change_confirmed';
    const groupId = 'qq-group-94501';
    const implicitEnable = service.setGroupSummaryPolicyAsLocalAdmin({
      groupId,
      enabled: true,
      expectedState: 'disabled',
      expectedVersion: {
        source: 'implicit_default',
        generation: null,
        updatedAt: null,
      },
      reasonCode,
      now: BASE_TIME + 60_000,
    });
    expect(implicitEnable).toEqual({
      outcome: 'updated',
      state: 'enabled',
      generation: 1,
      eligibleAfter: BASE_TIME + 60_001,
      updatedAt: BASE_TIME + 60_001,
      canceledJobCount: 0,
      auditId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
    });
    if (implicitEnable.outcome !== 'updated') {
      throw new Error('Expected implicit group-summary policy transition');
    }
    expect(policies.get(groupId)).toMatchObject({
      state: 'enabled',
      generation: 1,
      eligibleAfter: BASE_TIME + 60_001,
    });

    const enabled = policies.get(groupId);
    const jobs = new JobRepository(db);
    const pendingJobId = jobs.enqueue({
      id: 'job-service-expected-summary-pending',
      type: 'summary',
      payload: { conversationId: groupId, conversationType: 'group', groupId },
      now: BASE_TIME + 60_010,
      scheduledAt: BASE_TIME + 70_000,
    });
    policies.bindSummaryJob({
      jobId: pendingJobId,
      groupId,
      conversationId: groupId,
      now: BASE_TIME + 60_010,
    });
    const disabled = service.setGroupSummaryPolicyAsLocalAdmin({
      groupId,
      enabled: false,
      expectedState: 'enabled',
      expectedVersion: {
        source: 'stored_policy',
        generation: enabled?.generation ?? -1,
        updatedAt: enabled?.updatedAt.getTime() ?? -1,
      },
      reasonCode,
      now: BASE_TIME,
    });
    expect(disabled).toMatchObject({
      outcome: 'updated',
      state: 'disabled',
      generation: 2,
      eligibleAfter: null,
      canceledJobCount: 1,
    });
    if (disabled.outcome !== 'updated') {
      throw new Error('Expected stored group-summary policy transition');
    }
    expect(jobs.findById(pendingJobId)).toMatchObject({
      status: 'failed',
      error: 'group_summary_policy_disabled',
    });
    const disabledUpdatedAt = disabled.updatedAt;
    const exactInput = {
      groupId,
      enabled: true,
      expectedState: 'disabled' as const,
      expectedVersion: {
        source: 'stored_policy' as const,
        generation: 2,
        updatedAt: disabledUpdatedAt,
      },
      reasonCode,
      now: BASE_TIME + 70_000,
    };
    const changesBeforeStale = db.prepare('SELECT total_changes()').pluck().get();
    for (const input of [
      { ...exactInput, groupId: ` ${groupId}` },
      { ...exactInput, enabled: false },
      { ...exactInput, expectedState: 'enabled' },
      { ...exactInput, reasonCode: 'Invalid reason code' },
      { ...exactInput, now: -1 },
      { ...exactInput, now: 1.5 },
      { ...exactInput, now: 8_640_000_000_000_001 },
      {
        ...exactInput,
        expectedVersion: { source: 'implicit_default', generation: null, updatedAt: 1 },
      },
      {
        ...exactInput,
        expectedVersion: { ...exactInput.expectedVersion, generation: 1 },
      },
      {
        ...exactInput,
        expectedVersion: { ...exactInput.expectedVersion, updatedAt: disabledUpdatedAt - 1 },
      },
      {
        ...exactInput,
        expectedVersion: { ...exactInput.expectedVersion, extra: true },
      },
    ] as unknown[]) {
      expect(service.setGroupSummaryPolicyAsLocalAdmin(input as never))
        .toEqual({ outcome: 'stale' });
    }
    expect(db.prepare('SELECT total_changes()').pluck().get()).toBe(changesBeforeStale);

    expect(service.setGroupSummaryPolicyAsLocalAdmin(exactInput)).toMatchObject({
      outcome: 'updated',
      state: 'enabled',
      generation: 3,
      canceledJobCount: 0,
    });
    expect(service.setGroupSummaryPolicyAsLocalAdmin(exactInput))
      .toEqual({ outcome: 'stale' });

    const legacyGroupId = 'qq-group-94502';
    expect(service.setGroupSummaryPolicyAsLocalAdmin({
      groupId: legacyGroupId,
      enabled: true,
      now: BASE_TIME + 80_000,
    })).toMatchObject({
      changed: true,
      canceledJobCount: 0,
      policy: {
        groupId: legacyGroupId,
        state: 'enabled',
        generation: 1,
        eligibleAfter: BASE_TIME + 80_001,
      },
    });
    expect(db.prepare(
      `SELECT actor_user_id, actor_class, invocation_context, details
         FROM audit_log
        WHERE event_type = 'group.summary_policy_changed' AND event_id = ?`,
    ).get(implicitEnable.auditId)).toMatchObject({
      actor_user_id: 'local_admin',
      actor_class: 'admin',
      invocation_context: 'admin_cli',
      details: expect.stringContaining(reasonCode),
    });
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

  it('governs maintenance review by exact user, conversation, and group scope', async () => {
    const currentGroup = 'qq-group-86001';
    const otherGroup = 'qq-group-86002';
    const alicePrivate = insertQqSource({
      suffix: 'maintenance-alice-private',
      qqId: '76001',
      text: 'Synthetic Alice private source.',
    });
    const aliceGroup = insertQqSource({
      suffix: 'maintenance-alice-group',
      qqId: '76001',
      groupId: currentGroup,
      role: 'member',
      text: 'Synthetic Alice group source.',
    });
    const bobPrivate = insertQqSource({
      suffix: 'maintenance-bob-private',
      qqId: '76002',
      text: 'Synthetic Bob private source.',
    });
    const groupAdmin = insertQqSource({
      suffix: 'maintenance-group-admin',
      qqId: '76003',
      groupId: currentGroup,
      role: 'admin',
      text: 'Synthetic group admin source.',
    });

    const aliceUser = await createMaintenanceProposal({
      id: 'memory-maintenance-alice-user',
      scope: 'user',
      canonicalUserId: alicePrivate.canonicalUserId,
      visibility: 'private_only',
      nowMs: BASE_TIME + 100,
    });
    const bobUser = await createMaintenanceProposal({
      id: 'memory-maintenance-bob-user',
      scope: 'user',
      canonicalUserId: bobPrivate.canonicalUserId,
      visibility: 'private_only',
      nowMs: BASE_TIME + 101,
    });
    const aliceConversation = await createMaintenanceProposal({
      id: 'memory-maintenance-alice-conversation',
      scope: 'conversation',
      conversationId: alicePrivate.conversationId,
      visibility: 'private_only',
      nowMs: BASE_TIME + 102,
    });
    const exactGroup = await createMaintenanceProposal({
      id: 'memory-maintenance-exact-group',
      scope: 'group',
      groupId: currentGroup,
      conversationId: currentGroup,
      visibility: 'same_group_only',
      nowMs: BASE_TIME + 103,
    });
    const exactGroupConversation = await createMaintenanceProposal({
      id: 'memory-maintenance-exact-group-conversation',
      scope: 'conversation',
      groupId: currentGroup,
      conversationId: currentGroup,
      visibility: 'same_group_only',
      nowMs: BASE_TIME + 104,
    });
    const aliceSameGroup = await createMaintenanceProposal({
      id: 'memory-maintenance-alice-same-group',
      scope: 'user',
      canonicalUserId: aliceGroup.canonicalUserId,
      groupId: currentGroup,
      conversationId: currentGroup,
      visibility: 'same_group_only',
      nowMs: BASE_TIME + 105,
    });
    const otherGroupProposal = await createMaintenanceProposal({
      id: 'memory-maintenance-other-group',
      scope: 'group',
      groupId: otherGroup,
      conversationId: otherGroup,
      visibility: 'same_group_only',
      nowMs: BASE_TIME + 106,
    });
    const subjectOnly = await createMaintenanceProposal({
      id: 'memory-maintenance-subject-only',
      scope: 'system',
      subjectUserId: alicePrivate.canonicalUserId,
      visibility: 'owner_admin_only',
      nowMs: BASE_TIME + 107,
    });

    const localAdmin = { kind: 'local_admin' as const };
    const alicePrivateAuthority = {
      kind: 'user' as const,
      canonicalUserId: alicePrivate.canonicalUserId,
      invocationContext: 'private_chat' as const,
      conversationId: alicePrivate.conversationId,
    };
    const aliceGroupAuthority = {
      kind: 'user' as const,
      canonicalUserId: aliceGroup.canonicalUserId,
      invocationContext: 'group_chat' as const,
      groupId: currentGroup,
      conversationId: currentGroup,
    };
    const groupAdminAuthority = {
      kind: 'group_admin' as const,
      canonicalUserId: groupAdmin.canonicalUserId,
      invocationContext: 'group_chat' as const,
      groupId: currentGroup,
      conversationId: currentGroup,
    };
    const privateBotOwnerAuthority = {
      kind: 'bot_owner' as const,
      canonicalUserId: alicePrivate.canonicalUserId,
      invocationContext: 'private_chat' as const,
      conversationId: alicePrivate.conversationId,
    };
    const groupOwnerAuthority = {
      kind: 'group_owner' as const,
      canonicalUserId: groupAdmin.canonicalUserId,
      invocationContext: 'group_chat' as const,
      groupId: currentGroup,
      conversationId: currentGroup,
    };

    expect(service.listMemoryMaintenanceProposals({ authority: localAdmin, limit: 20 }))
      .toHaveLength(8);
    expect(service.listMemoryMaintenanceProposals({
      authority: privateBotOwnerAuthority,
      limit: 20,
    })).toHaveLength(8);
    expect(service.listMemoryMaintenanceProposals({
      authority: alicePrivateAuthority,
      limit: 20,
    }).map((proposal) => proposal.proposalId)).toEqual([
      aliceUser,
      aliceConversation,
      aliceSameGroup,
    ]);
    expect(service.listMemoryMaintenanceProposals({
      authority: aliceGroupAuthority,
      limit: 20,
    }).map((proposal) => proposal.proposalId)).toEqual([aliceSameGroup]);
    expect(service.listMemoryMaintenanceProposals({
      authority: groupAdminAuthority,
      limit: 1,
    }).map((proposal) => proposal.proposalId)).toEqual([exactGroup]);
    expect(service.listMemoryMaintenanceProposals({
      authority: groupAdminAuthority,
      limit: 20,
    }).map((proposal) => proposal.proposalId)).toEqual([
      exactGroup,
      exactGroupConversation,
      aliceSameGroup,
    ]);
    expect(service.listMemoryMaintenanceProposals({
      authority: groupOwnerAuthority,
      limit: 20,
    }).map((proposal) => proposal.proposalId)).toEqual([
      exactGroup,
      exactGroupConversation,
      aliceSameGroup,
    ]);
    expect(service.getMemoryMaintenanceProposal({
      authority: alicePrivateAuthority,
      proposalId: subjectOnly,
    })).toBeNull();
    expect(service.getMemoryMaintenanceProposal({
      authority: alicePrivateAuthority,
      proposalId: 'missing-maintenance-proposal',
    })).toBeNull();

    expect(service.reviewMemoryMaintenanceProposal({
      authority: groupAdminAuthority,
      proposalId: exactGroup,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'approve',
      reasonCode: 'exact_group_approved',
      nowMs: BASE_TIME + 200,
    }).outcome).toBe('transitioned');
    expect(service.reviewMemoryMaintenanceProposal({
      authority: groupAdminAuthority,
      proposalId: exactGroup,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'approve',
      reasonCode: 'exact_group_approved',
      nowMs: BASE_TIME + 201,
    }).outcome).toBe('unchanged');
    expect(service.reviewMemoryMaintenanceProposal({
      authority: groupAdminAuthority,
      proposalId: otherGroupProposal,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'reject',
      reasonCode: 'must_not_cross_group',
      nowMs: BASE_TIME + 202,
    })).toEqual({ outcome: 'not_found_or_denied' });
    expect(service.reviewMemoryMaintenanceProposal({
      authority: alicePrivateAuthority,
      proposalId: subjectOnly,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'approve',
      reasonCode: 'subject_is_not_owner',
      nowMs: BASE_TIME + 203,
    })).toEqual({ outcome: 'not_found_or_denied' });
    expect(service.reviewMemoryMaintenanceProposal({
      authority: alicePrivateAuthority,
      proposalId: aliceUser,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'reject',
      reasonCode: 'owner_rejected',
      nowMs: BASE_TIME + 204,
    }).outcome).toBe('transitioned');
    expect(service.reviewMemoryMaintenanceProposal({
      authority: localAdmin,
      proposalId: subjectOnly,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'expire',
      reasonCode: 'operator_expired',
      nowMs: BASE_TIME + 205,
    }).outcome).toBe('transitioned');

    expect(db.prepare(
      `SELECT event_type, actor_user_id, actor_class, invocation_context
         FROM audit_log
        WHERE event_type IN (
          'memory.maintenance.approved',
          'memory.maintenance.rejected',
          'memory.maintenance.expired'
        )
        ORDER BY timestamp`,
    ).all()).toEqual([
      {
        event_type: 'memory.maintenance.approved',
        actor_user_id: groupAdmin.canonicalUserId,
        actor_class: 'group_admin',
        invocation_context: 'group_chat',
      },
      {
        event_type: 'memory.maintenance.rejected',
        actor_user_id: alicePrivate.canonicalUserId,
        actor_class: 'user',
        invocation_context: 'private_chat',
      },
      {
        event_type: 'memory.maintenance.expired',
        actor_user_id: null,
        actor_class: 'admin',
        invocation_context: 'admin_cli',
      },
    ]);
    expect(db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_records WHERE state = 'active') AS active_memories,
         (SELECT COUNT(*) FROM memory_revisions) AS memory_revisions,
         (SELECT COUNT(*) FROM memory_maintenance_proposal_revision_effects) AS effects`,
    ).get()).toEqual({ active_memories: 8, memory_revisions: 8, effects: 0 });
    expect(db.prepare(
      `SELECT lifecycle_state FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(bobUser)).toEqual({ lifecycle_state: 'pending_review' });
    expectIntegrity();
  });

  it('applies and rolls back a maintenance proposal only through its governed scope', async () => {
    const proposalId = await createMaintenanceProposal({
      id: 'memory-maintenance-governed-apply',
      scope: 'system',
      visibility: 'owner_admin_only',
      nowMs: BASE_TIME + 300,
    });
    const localAdmin = { kind: 'local_admin' as const };
    expect(service.reviewMemoryMaintenanceProposal({
      authority: localAdmin,
      proposalId,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      transition: 'approve',
      reasonCode: 'approved_for_governed_apply',
      nowMs: BASE_TIME + 301,
    }).outcome).toBe('transitioned');

    expect(service.applyMemoryMaintenanceProposal({
      authority: {
        kind: 'user',
        canonicalUserId: 'user-governance-denied',
        invocationContext: 'private_chat',
        conversationId: 'private:qq-79999',
      },
      proposalId,
      expectedState: 'approved',
      expectedRevisionNumber: 2,
      reasonCode: 'must_not_apply_system_scope',
      nowMs: BASE_TIME + 302,
    })).toEqual({ outcome: 'not_found_or_denied' });
    expect(db.prepare(
      `SELECT state FROM memory_records
        WHERE id = 'memory-maintenance-governed-apply'`,
    ).get()).toEqual({ state: 'active' });

    expect(service.applyMemoryMaintenanceProposal({
      authority: localAdmin,
      proposalId,
      expectedState: 'approved',
      expectedRevisionNumber: 2,
      reasonCode: 'local_admin_apply',
      nowMs: BASE_TIME + 303,
    }).outcome).toBe('transitioned');
    expect(db.prepare(
      `SELECT state FROM memory_records
        WHERE id = 'memory-maintenance-governed-apply'`,
    ).get()).toEqual({ state: 'disabled' });
    expect(db.prepare(
      `SELECT lifecycle_state, current_revision_number
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(proposalId)).toEqual({ lifecycle_state: 'applied', current_revision_number: 3 });
    expect(db.prepare(
      `SELECT effect_role FROM memory_maintenance_proposal_revision_effects
        WHERE proposal_id = ?`,
    ).all(proposalId)).toEqual([{ effect_role: 'disabled' }]);

    expect(service.rollbackMemoryMaintenanceProposal({
      authority: {
        kind: 'user',
        canonicalUserId: 'user-governance-denied',
        invocationContext: 'private_chat',
        conversationId: 'private:qq-79999',
      },
      proposalId,
      expectedState: 'applied',
      expectedRevisionNumber: 3,
      reasonCode: 'must_not_rollback_system_scope',
      nowMs: BASE_TIME + 304,
    })).toEqual({ outcome: 'not_found_or_denied' });
    expect(service.rollbackMemoryMaintenanceProposal({
      authority: localAdmin,
      proposalId,
      expectedState: 'applied',
      expectedRevisionNumber: 3,
      reasonCode: 'local_admin_rollback',
      nowMs: BASE_TIME + 305,
    }).outcome).toBe('transitioned');
    expect(db.prepare(
      `SELECT state FROM memory_records
        WHERE id = 'memory-maintenance-governed-apply'`,
    ).get()).toEqual({ state: 'active' });
    expect(db.prepare(
      `SELECT lifecycle_state, current_revision_number
         FROM memory_maintenance_proposals WHERE id = ?`,
    ).get(proposalId)).toEqual({ lifecycle_state: 'rolled_back', current_revision_number: 4 });
    expect(db.prepare(
      `SELECT transition, effect_role
         FROM memory_maintenance_proposal_revision_effects
        WHERE proposal_id = ? ORDER BY transition`,
    ).all(proposalId)).toEqual([
      { transition: 'apply', effect_role: 'disabled' },
      { transition: 'rollback', effect_role: 'restored' },
    ]);
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

  async function createMaintenanceProposal(input: {
    id: string;
    scope: 'global' | 'user' | 'group' | 'conversation' | 'tool' | 'system';
    visibility: 'private_only' | 'same_group_only' | 'owner_admin_only';
    nowMs: number;
    canonicalUserId?: string;
    groupId?: string;
    conversationId?: string;
    subjectUserId?: string;
  }): Promise<string> {
    memories.createSync({
      id: input.id,
      scope: input.scope,
      ...(input.canonicalUserId ? { canonicalUserId: input.canonicalUserId } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.subjectUserId ? { subjectUserId: input.subjectUserId } : {}),
      visibility: input.visibility,
      sensitivity: 'normal',
      authority: 'system',
      kind: 'fact',
      title: `Synthetic ${input.id}`,
      content: `Synthetic payload ${input.id}`,
      state: 'active',
      confidence: 0.4,
      importance: 0.2,
      sourceContext: 'admin_cli',
      sources: [{
        sourceType: 'user_command',
        sourceId: `source-${input.id}`,
        sourceTimestamp: input.nowMs - 1,
        extractedBy: 'admin',
        external: true,
      }],
      actor: {
        actorClass: 'admin',
        context: 'admin_cli',
      },
    });
    const proposal = await createMemoryMaintenanceProposal(db, new AuditRepository(db), {
      kind: 'decay',
      candidateMemoryIds: [input.id],
      reasonCodes: ['stale'],
      proposedEffect: { type: 'disable', memoryId: input.id },
      nowMs: input.nowMs,
    });
    return proposal.proposalId;
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
