import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import { redactSecretsInText } from '../memory/secret-scan.js';
import { parseStoredChatMessageReceived } from '../ingestion/stored-chat-event.js';
import {
  GroupSummaryPolicyRepository,
  type GroupSummaryAuthorityKind,
  type GroupSummaryPolicyExpectedVersion,
  type GroupSummaryPolicy,
  type SetGroupSummaryPolicyResult,
  type SetGroupSummaryPolicyExpectedResult,
} from '../storage/group-summary-policy-repository.js';
import { AuditRepository } from '../storage/audit-repository.js';
import {
  MemoryMaintenanceProposalRepository,
  type MemoryMaintenanceProposalAccess,
  type MemoryMaintenanceProposalExactScope,
  type MemoryMaintenanceProposalLifecycleState,
  type MemoryMaintenanceProposalRecord,
  type MemoryMaintenanceApplyInput,
  type MemoryMaintenanceRollbackInput,
  type MemoryMaintenanceReviewInput,
  type MemoryMaintenanceReviewTransition,
} from '../storage/memory-maintenance-proposal-repository.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import {
  PrivacyPreferenceRepository,
  type PrivacyPreferenceExpectedVersion,
  type PrivacyPreferenceState,
  type PrivacyPreferenceType,
  type SetPrivacyPreferenceExpectedResult,
} from '../storage/privacy-preference-repository.js';
import type { MemoryRecord } from '../types/memory.js';
import type { ActorClass, InvocationContext } from '../types/tool.js';
import type {
  DisplayProfileRedactionSnapshot,
  PlatformAccountUnlinkSnapshot,
} from './query-contracts.js';
import {
  redactGovernanceDisplayString,
  redactGovernanceStructuredValue,
} from './query-projections.js';
import {
  deriveDisplayProfileTargetResourceId,
  readDisplayProfileRedactionSnapshot,
  readPlatformAccountUnlinkSnapshot,
} from './query-snapshots.js';
import {
  parseQqGovernanceCommand,
  type QqGovernanceCommand,
} from './qq-command.js';

const MAX_RESPONSE_LENGTH = 2_048;
const MAX_MEMORY_LIST_ITEMS = 8;
const MAX_MEMORY_TITLE_LENGTH = 64;
const QQ_ID_PATTERN = /^[1-9][0-9]{4,11}$/;
const NORMALIZED_QQ_ID_PATTERN = /^qq-([1-9][0-9]{4,11})$/;
const NORMALIZED_QQ_GROUP_ID_PATTERN = /^qq-group-[1-9][0-9]{4,11}$/;
const DISPLAYABLE_MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GOVERNANCE_REASON_CODE_PATTERN = /^[a-z][a-z0-9_:-]{0,127}$/u;
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;
export const DISPLAY_PROFILE_REDACTION_REASON_CODE =
  'governance_http_display_profile_redaction_confirmed';
export const PLATFORM_ACCOUNT_UNLINK_REASON_CODE =
  'governance_http_platform_account_unlink_confirmed';
const DISPLAY_PROFILE_REDACTION_COUNT_MISMATCH = Symbol(
  'display_profile_redaction_count_mismatch',
);
const PLATFORM_ACCOUNT_UNLINK_COUNT_MISMATCH = Symbol(
  'platform_account_unlink_count_mismatch',
);
type RestorableMemoryState = Extract<
  MemoryRecord['state'],
  'disabled' | 'rejected' | 'deleted'
>;
const FORGETTABLE_MEMORY_STATES: ReadonlyArray<Exclude<MemoryRecord['state'], 'deleted'>> = [
  'proposed',
  'active',
  'rejected',
  'superseded',
  'disabled',
];
const RESTORABLE_MEMORY_STATES: ReadonlyArray<RestorableMemoryState> = [
  'disabled',
  'rejected',
  'deleted',
];

const DENIED_RESPONSE = 'Governance command denied.';
const INVALID_SOURCE_RESPONSE = 'Governance command could not be verified.';
const MEMORY_USAGE_RESPONSE =
  'Usage: /memory | /memory forget <memory-id> | /memory summary status|enable|disable';
const WHY_USAGE_RESPONSE = 'Usage: /why';
const MEMORY_UNAVAILABLE_RESPONSE = 'Memory record not found or unavailable.';
const GROUP_REQUIRED_RESPONSE = 'This governance command requires a group conversation.';

function redactGovernanceText(text: string): string {
  const platformRedacted = text
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?[1-9][0-9]{4,11}(?![A-Za-z0-9])/giu, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])[1-9][0-9]{4,11}(?![A-Za-z0-9])/gu, '[REDACTED:platform_id]');
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  return secretRedacted
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?[1-9][0-9]{4,11}(?![A-Za-z0-9])/giu, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])[1-9][0-9]{4,11}(?![A-Za-z0-9])/gu, '[REDACTED:platform_id]');
}

export function formatGovernanceMemoryIdForDisplay(id: string): string {
  if (!DISPLAYABLE_MEMORY_ID_PATTERN.test(id)) {
    return '[redacted-id]';
  }
  return redactGovernanceText(id) === id ? id : '[redacted-id]';
}

export type QqGovernanceOutcome =
  | 'invalid_source'
  | 'denied'
  | 'invalid_usage'
  | 'memory_listed'
  | 'memory_forgotten'
  | 'memory_unavailable'
  | 'group_required'
  | 'summary_status'
  | 'summary_enabled'
  | 'summary_disabled'
  | 'why_explained'
  | 'why_unavailable';

export interface QqGovernanceResult {
  outcome: QqGovernanceOutcome;
  responseText: string;
}

export interface HandleQqGovernanceCommandInput {
  sourceEventId: string;
  botOwnerQqId?: string;
}

export interface LocalAdminForgetResult {
  outcome: 'forgotten' | 'not_found';
}

export interface LocalAdminExpectedForgetInput {
  memoryId: string;
  scope: MemoryMaintenanceProposalExactScope;
  expectedState: Exclude<MemoryRecord['state'], 'deleted'>;
  expectedRevisionNumber: number;
  reasonCode: string;
}

export type LocalAdminExpectedForgetResult =
  | { outcome: 'forgotten'; revisionNumber: number }
  | { outcome: 'not_found' | 'stale' };

export interface LocalAdminRestoreResult {
  outcome: 'restored' | 'not_found';
}

export interface LocalAdminExpectedRestoreInput {
  memoryId: string;
  scope: MemoryMaintenanceProposalExactScope;
  expectedState: RestorableMemoryState;
  expectedRevisionNumber: number;
  reasonCode: string;
}

export type LocalAdminExpectedRestoreResult =
  | { outcome: 'restored'; revisionNumber: number }
  | { outcome: 'not_found' | 'stale' };

export interface RedactDisplayProfileAsLocalAdminInput {
  canonicalUserId: string;
  groupId?: string;
}

export interface RedactDisplayProfileAsLocalAdminExpectedInput
  extends RedactDisplayProfileAsLocalAdminInput {
  targetId: string;
  expectedSnapshot: DisplayProfileRedactionSnapshot;
  reasonCode: typeof DISPLAY_PROFILE_REDACTION_REASON_CODE;
  now?: number;
}

export type RedactDisplayProfileAsLocalAdminExpectedResult =
  | {
    outcome: 'redacted';
    displayProfilesUpdated: number;
    nicknameHistoryUpdated: number;
    openNicknameHistoryRowsClosed: number;
    redactedAt: number;
  }
  | { outcome: 'not_found' | 'stale' };

export interface UnlinkPlatformAccountAsLocalAdminInput {
  platform: 'qq';
  platformAccountId: string;
}

export type UnlinkPlatformAccountAsLocalAdminResult =
  | { outcome: 'unlinked' }
  | { outcome: 'not_found' };

export interface UnlinkPlatformAccountAsLocalAdminExpectedInput
  extends UnlinkPlatformAccountAsLocalAdminInput {
  expectedSnapshot: PlatformAccountUnlinkSnapshot;
  reasonCode: typeof PLATFORM_ACCOUNT_UNLINK_REASON_CODE;
  now?: number;
}

export type UnlinkPlatformAccountAsLocalAdminExpectedResult =
  | { outcome: 'unlinked'; disabledAt: number }
  | { outcome: 'not_found' | 'stale' };

export interface SetPrivacyPreferenceAsLocalAdminInput {
  canonicalUserId: string;
  preferenceType: PrivacyPreferenceType;
  state: PrivacyPreferenceState;
  reason: string;
  now?: number;
}

export interface SetPrivacyPreferenceAsLocalAdminResult {
  outcome: 'updated';
}

export interface SetPrivacyPreferenceAsLocalAdminExpectedInput {
  canonicalUserId: string;
  preferenceType: PrivacyPreferenceType;
  state: PrivacyPreferenceState;
  expectedState: PrivacyPreferenceState;
  expectedVersion: PrivacyPreferenceExpectedVersion;
  reasonCode: string;
  now?: number;
}

export type SetPrivacyPreferenceAsLocalAdminExpectedResult =
  SetPrivacyPreferenceExpectedResult;

export interface SetGroupSummaryPolicyAsLocalAdminInput {
  groupId: string;
  enabled: boolean;
  now?: number;
}

export interface SetGroupSummaryPolicyAsLocalAdminExpectedInput
  extends SetGroupSummaryPolicyAsLocalAdminInput {
  expectedState: GroupSummaryPolicy['state'];
  expectedVersion: GroupSummaryPolicyExpectedVersion;
  reasonCode: string;
}

export type SetGroupSummaryPolicyAsLocalAdminExpectedResult =
  SetGroupSummaryPolicyExpectedResult;

export interface MemoryMaintenanceReviewAuthority {
  kind: 'local_admin' | 'bot_owner' | 'user' | 'group_owner' | 'group_admin';
  canonicalUserId?: string;
  invocationContext?: Extract<InvocationContext, 'private_chat' | 'group_chat'>;
  groupId?: string;
  conversationId?: string;
}

export type MemoryMaintenanceGovernanceReviewResult =
  | {
    outcome: 'transitioned' | 'unchanged' | 'stale';
    proposal: MemoryMaintenanceProposalRecord;
  }
  | { outcome: 'not_found_or_denied' };

export type MemoryMaintenanceGovernanceApplyResult =
  | {
    outcome: 'transitioned' | 'unchanged' | 'stale';
    proposal: MemoryMaintenanceProposalRecord;
  }
  | { outcome: 'not_found_or_denied' };

export type MemoryMaintenanceGovernanceRollbackResult =
  | {
    outcome: 'transitioned' | 'unchanged' | 'stale';
    proposal: MemoryMaintenanceProposalRecord;
  }
  | { outcome: 'not_found_or_denied' };

interface ResolvedMemoryMaintenanceAuthority {
  access: MemoryMaintenanceProposalAccess;
  actor: MemoryMaintenanceReviewInput['actor'];
  authorityKind: MemoryMaintenanceReviewInput['authorityKind'];
}

interface QqCommandSourceRow {
  id: string;
  type: string;
  timestamp: number;
  source: string;
  platform: string | null;
  conversation_id: string | null;
  correlation_id: string | null;
  platform_event_id: string | null;
  payload: string;
  raw_rowid: number;
  chat_id: string;
  chat_raw_event_id: string;
  chat_message_id: string;
  chat_conversation_id: string;
  chat_conversation_type: string;
  chat_group_id: string | null;
  chat_sender_id: string;
  chat_sender_role: string | null;
  chat_text: string | null;
  chat_timestamp: number;
  platform_account_id: string;
  canonical_user_id: string;
}

interface QqCommandSource {
  sourceEventId: string;
  rawRowId: number;
  text: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  groupId?: string;
  senderId: string;
  senderRole?: 'member' | 'admin' | 'owner';
  canonicalUserId: string;
}

interface QqAuthority {
  kind: Extract<GroupSummaryAuthorityKind, 'bot_owner' | 'group_owner' | 'group_admin'>;
  actorClass: Extract<ActorClass, 'owner' | 'group_admin'>;
}

interface MemoryListRow {
  id: string;
  scope: string;
  state: string;
  title: string;
}

interface MemoryGovernanceRow {
  id: string;
  scope: string;
  canonical_user_id: string | null;
  group_id: string | null;
  conversation_id: string | null;
  visibility: string;
  sensitivity: string;
  state: MemoryRecord['state'];
  current_revision_number: number | null;
}

interface WhyTurnRow {
  status: string;
  tokens_total: number | null;
  selected_memory_ids: string | null;
  rejected_memories: string | null;
  stored_context: number;
  action_decision_count: number;
  action_execution_count: number;
  tool_call_count: number;
}

export class GovernanceService {
  constructor(
    private readonly db: Database.Database,
    private readonly memories = new MemoryRepository(db),
    private readonly summaryPolicies = new GroupSummaryPolicyRepository(db),
    private readonly maintenanceProposals = new MemoryMaintenanceProposalRepository(
      db,
      new AuditRepository(db),
    ),
    private readonly privacyPreferences = new PrivacyPreferenceRepository(db),
  ) {}

  async handleQqCommand(
    input: HandleQqGovernanceCommandInput,
  ): Promise<QqGovernanceResult | null> {
    return this.handleQqCommandSync(input);
  }

  handleQqCommandSync(
    input: HandleQqGovernanceCommandInput,
  ): QqGovernanceResult | null {
    const source = this.readQqCommandSource(input.sourceEventId);
    if (!source) {
      return this.result('invalid_source', INVALID_SOURCE_RESPONSE);
    }

    const parsed = parseQqGovernanceCommand(source.text);
    if (parsed.status === 'not_command') {
      return null;
    }
    if (!this.hasCanonicalQqCommandScope(source)) {
      return this.result('invalid_source', INVALID_SOURCE_RESPONSE);
    }

    const authority = this.resolveQqAuthority(source, input.botOwnerQqId);
    if (!authority) {
      return this.result('denied', DENIED_RESPONSE);
    }

    if (parsed.status === 'invalid') {
      return this.result(
        'invalid_usage',
        parsed.family === 'memory' ? MEMORY_USAGE_RESPONSE : WHY_USAGE_RESPONSE,
      );
    }

    return this.executeQqCommand(source, authority, parsed.command);
  }

  forgetMemoryAsLocalAdmin(memoryId: string): LocalAdminForgetResult;
  forgetMemoryAsLocalAdmin(input: LocalAdminExpectedForgetInput): LocalAdminExpectedForgetResult;
  forgetMemoryAsLocalAdmin(
    input: string | LocalAdminExpectedForgetInput,
  ): LocalAdminForgetResult | LocalAdminExpectedForgetResult {
    if (typeof input !== 'string') {
      if (!this.isValidExpectedForgetInput(input)) {
        return { outcome: 'stale' };
      }
      const displayId = formatGovernanceMemoryIdForDisplay(input.memoryId);
      return this.forgetMemory({
        memoryId: input.memoryId,
        actorUserId: 'local_admin',
        actorClass: 'admin',
        invocationContext: 'admin_cli',
        reason: 'Governance HTTP confirmed memory forget',
        auditSummary: `Governance HTTP deleted memory ${displayId}`,
        auditDetails: {
          governanceActor: 'local_admin',
          memoryId: displayId,
          reasonCode: input.reasonCode,
        },
        canGovern: () => true,
        expected: {
          scope: input.scope,
          state: input.expectedState,
          revisionNumber: input.expectedRevisionNumber,
        },
      });
    }

    const memoryId = input;
    const displayId = formatGovernanceMemoryIdForDisplay(memoryId);
    const result = this.forgetMemory({
      memoryId,
      actorUserId: 'local_admin',
      actorClass: 'admin',
      invocationContext: 'admin_cli',
      reason: 'Governance CLI delete memory',
      auditSummary: `Governance CLI deleted memory ${displayId}`,
      auditDetails: {
        governanceActor: 'local_admin',
        memoryId: displayId,
      },
      canGovern: () => true,
    });
    return result.outcome === 'forgotten'
      ? { outcome: 'forgotten' }
      : { outcome: 'not_found' };
  }

  restoreMemoryAsLocalAdmin(memoryId: string): LocalAdminRestoreResult;
  restoreMemoryAsLocalAdmin(input: LocalAdminExpectedRestoreInput): LocalAdminExpectedRestoreResult;
  restoreMemoryAsLocalAdmin(
    input: string | LocalAdminExpectedRestoreInput,
  ): LocalAdminRestoreResult | LocalAdminExpectedRestoreResult {
    if (typeof input !== 'string') {
      if (!this.isValidExpectedRestoreInput(input)) {
        return { outcome: 'stale' };
      }
      const displayId = formatGovernanceMemoryIdForDisplay(input.memoryId);
      return this.restoreMemory({
        memoryId: input.memoryId,
        actorUserId: 'local_admin',
        reason: 'Governance HTTP confirmed memory restore',
        auditSummary: `Governance HTTP restored memory ${displayId}`,
        auditDetails: {
          governanceActor: 'local_admin',
          memoryId: displayId,
          reasonCode: input.reasonCode,
        },
        expected: {
          scope: input.scope,
          state: input.expectedState,
          revisionNumber: input.expectedRevisionNumber,
        },
      });
    }

    const result = this.restoreMemory({
      memoryId: input,
      actorUserId: 'admin',
      reason: 'Governance CLI restore memory',
      auditSummary: `Governance CLI enabled memory ${input}`,
    });
    return result.outcome === 'restored'
      ? { outcome: 'restored' }
      : { outcome: 'not_found' };
  }

  redactDisplayProfileAsLocalAdmin(
    input: RedactDisplayProfileAsLocalAdminExpectedInput,
  ): RedactDisplayProfileAsLocalAdminExpectedResult;
  redactDisplayProfileAsLocalAdmin(
    input: RedactDisplayProfileAsLocalAdminInput,
  ): number;
  redactDisplayProfileAsLocalAdmin(
    input: RedactDisplayProfileAsLocalAdminInput
    | RedactDisplayProfileAsLocalAdminExpectedInput,
  ): number | RedactDisplayProfileAsLocalAdminExpectedResult {
    if (
      'targetId' in input
      || 'expectedSnapshot' in input
      || 'reasonCode' in input
      || 'now' in input
    ) {
      return this.redactDisplayProfileAtExpectedSnapshot(
        input as RedactDisplayProfileAsLocalAdminExpectedInput,
      );
    }

    const now = Date.now();
    const groupId = input.groupId ?? '';
    const transaction = this.db.transaction(() => {
      const displayResult = this.db.prepare(
        `UPDATE display_profiles
            SET current_display_name = ?, observed_at = ?, trust = ?
          WHERE canonical_user_id = ?
            AND source_group_id = ?`,
      ).run('[redacted]', now, 'user_set', input.canonicalUserId, groupId);
      const historyResult = this.db.prepare(
        `UPDATE nickname_history
            SET display_name = ?, observed_until = COALESCE(observed_until, ?)
          WHERE canonical_user_id = ?
            AND source_group_id = ?`,
      ).run('[redacted]', now, input.canonicalUserId, groupId);
      const summary = redactGovernanceDisplayString(
        `Governance CLI redacted display profile for ${input.canonicalUserId}`,
      ).text;
      const details = redactGovernanceStructuredValue({
        canonicalUserId: input.canonicalUserId,
        groupId: groupId || undefined,
        displayProfilesUpdated: displayResult.changes,
        nicknameHistoryUpdated: historyResult.changes,
      }).value;

      this.db.prepare(
        `INSERT INTO audit_log (
           id, timestamp, category, level, event_type, event_id,
           actor_user_id, actor_class, invocation_context,
           summary, details, redacted, risk_level, evaluator_decision_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ulid(),
        Date.now(),
        'system',
        'summary',
        'display_profile.redact',
        `${input.canonicalUserId}:${groupId}`,
        null,
        'admin',
        'admin_cli',
        summary,
        JSON.stringify(details),
        1,
        'medium',
        null,
      );

      return displayResult.changes + historyResult.changes;
    });

    return transaction();
  }

  private redactDisplayProfileAtExpectedSnapshot(
    input: RedactDisplayProfileAsLocalAdminExpectedInput,
  ): RedactDisplayProfileAsLocalAdminExpectedResult {
    if (!this.isValidExpectedDisplayProfileRedactionInput(input)) {
      return { outcome: 'stale' };
    }

    const redactedAt = input.now ?? Date.now();
    const sourceGroupId = input.groupId ?? '';
    const scope = { kind: 'user' as const, canonicalUserId: input.canonicalUserId };
    const transaction = this.db.transaction((): RedactDisplayProfileAsLocalAdminExpectedResult => {
      const snapshotResult = readDisplayProfileRedactionSnapshot(this.db, {
        scope,
        sourceGroupId,
        targetId: input.targetId,
      });
      if (snapshotResult.outcome !== 'found') {
        return snapshotResult.outcome === 'not_found'
          ? { outcome: 'not_found' }
          : { outcome: 'stale' };
      }

      const snapshot = snapshotResult.snapshot;
      if (
        snapshot.displayProfileRows !== input.expectedSnapshot.displayProfileRows
        || snapshot.nicknameHistoryRows !== input.expectedSnapshot.nicknameHistoryRows
        || snapshot.openNicknameHistoryRows
          !== input.expectedSnapshot.openNicknameHistoryRows
        || snapshot.snapshotFingerprint !== input.expectedSnapshot.snapshotFingerprint
      ) {
        return { outcome: 'stale' };
      }

      const displayResult = this.db.prepare(
        `UPDATE display_profiles
            SET current_display_name = ?, observed_at = ?, trust = ?
          WHERE canonical_user_id = ?
            AND source_group_id = ?`,
      ).run(
        '[redacted]',
        redactedAt,
        'user_set',
        input.canonicalUserId,
        sourceGroupId,
      );
      if (displayResult.changes !== snapshot.displayProfileRows) {
        throw DISPLAY_PROFILE_REDACTION_COUNT_MISMATCH;
      }

      const historyResult = this.db.prepare(
        `UPDATE nickname_history
            SET display_name = ?, observed_until = COALESCE(observed_until, ?)
          WHERE canonical_user_id = ?
            AND source_group_id = ?`,
      ).run('[redacted]', redactedAt, input.canonicalUserId, sourceGroupId);
      if (historyResult.changes !== snapshot.nicknameHistoryRows) {
        throw DISPLAY_PROFILE_REDACTION_COUNT_MISMATCH;
      }

      const summary = redactGovernanceDisplayString(
        `Governance HTTP redacted display profile for ${input.canonicalUserId}`,
      ).text;
      const details = redactGovernanceStructuredValue({
        canonicalUserId: input.canonicalUserId,
        groupId: sourceGroupId || undefined,
        reasonCode: input.reasonCode,
        displayProfilesUpdated: displayResult.changes,
        nicknameHistoryUpdated: historyResult.changes,
        openNicknameHistoryRowsClosed: snapshot.openNicknameHistoryRows,
      }).value;
      this.db.prepare(
        `INSERT INTO audit_log (
           id, timestamp, category, level, event_type, event_id,
           actor_user_id, actor_class, invocation_context,
           summary, details, redacted, risk_level, evaluator_decision_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ulid(),
        redactedAt,
        'system',
        'summary',
        'display_profile.redact',
        `${input.canonicalUserId}:${sourceGroupId}`,
        null,
        'admin',
        'admin_cli',
        summary,
        JSON.stringify(details),
        1,
        'medium',
        null,
      );

      return {
        outcome: 'redacted',
        displayProfilesUpdated: displayResult.changes,
        nicknameHistoryUpdated: historyResult.changes,
        openNicknameHistoryRowsClosed: snapshot.openNicknameHistoryRows,
        redactedAt,
      };
    });

    try {
      return transaction.immediate();
    } catch (error: unknown) {
      if (error === DISPLAY_PROFILE_REDACTION_COUNT_MISMATCH) {
        return { outcome: 'stale' };
      }
      throw error;
    }
  }

  private isValidExpectedDisplayProfileRedactionInput(
    input: RedactDisplayProfileAsLocalAdminExpectedInput,
  ): boolean {
    const keys = Object.keys(input);
    const requiredKeys = [
      'canonicalUserId',
      'targetId',
      'expectedSnapshot',
      'reasonCode',
    ];
    const allowedKeys = new Set([...requiredKeys, 'groupId', 'now']);
    if (
      requiredKeys.some((key) => !keys.includes(key))
      || keys.some((key) => !allowedKeys.has(key))
      || typeof input.canonicalUserId !== 'string'
      || !this.isCleanGovernanceIdentifier(input.canonicalUserId)
      || (input.groupId !== undefined && (
        typeof input.groupId !== 'string'
        || !this.isCleanGovernanceIdentifier(input.groupId)
      ))
      || typeof input.targetId !== 'string'
      || !/^[0-9a-f]{64}$/u.test(input.targetId)
      || input.reasonCode !== DISPLAY_PROFILE_REDACTION_REASON_CODE
      || (input.now !== undefined && (
        typeof input.now !== 'number'
        || !Number.isSafeInteger(input.now)
        || input.now < 0
        || input.now > MAX_JAVASCRIPT_DATE_MS
      ))
      || !this.isValidDisplayProfileRedactionSnapshot(input.expectedSnapshot)
    ) {
      return false;
    }

    return input.targetId === deriveDisplayProfileTargetResourceId(
      { kind: 'user', canonicalUserId: input.canonicalUserId },
      input.groupId ?? '',
    );
  }

  private isValidDisplayProfileRedactionSnapshot(
    value: unknown,
  ): value is DisplayProfileRedactionSnapshot {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 4
      || !keys.includes('displayProfileRows')
      || !keys.includes('nicknameHistoryRows')
      || !keys.includes('openNicknameHistoryRows')
      || !keys.includes('snapshotFingerprint')
    ) {
      return false;
    }
    const displayProfileRows = record.displayProfileRows;
    const nicknameHistoryRows = record.nicknameHistoryRows;
    const openNicknameHistoryRows = record.openNicknameHistoryRows;
    if (
      typeof displayProfileRows !== 'number'
      || !Number.isSafeInteger(displayProfileRows)
      || displayProfileRows < 0
      || typeof nicknameHistoryRows !== 'number'
      || !Number.isSafeInteger(nicknameHistoryRows)
      || nicknameHistoryRows < 0
      || typeof openNicknameHistoryRows !== 'number'
      || !Number.isSafeInteger(openNicknameHistoryRows)
      || openNicknameHistoryRows < 0
      || openNicknameHistoryRows > nicknameHistoryRows
      || typeof record.snapshotFingerprint !== 'string'
      || !/^[0-9a-f]{64}$/u.test(record.snapshotFingerprint)
    ) {
      return false;
    }
    const total = displayProfileRows + nicknameHistoryRows;
    return Number.isSafeInteger(total) && total >= 1;
  }

  unlinkPlatformAccountAsLocalAdmin(
    input: UnlinkPlatformAccountAsLocalAdminExpectedInput,
  ): UnlinkPlatformAccountAsLocalAdminExpectedResult;
  unlinkPlatformAccountAsLocalAdmin(
    input: UnlinkPlatformAccountAsLocalAdminInput,
  ): UnlinkPlatformAccountAsLocalAdminResult;
  unlinkPlatformAccountAsLocalAdmin(
    input: UnlinkPlatformAccountAsLocalAdminInput
    | UnlinkPlatformAccountAsLocalAdminExpectedInput,
  ): UnlinkPlatformAccountAsLocalAdminResult
    | UnlinkPlatformAccountAsLocalAdminExpectedResult {
    if (
      'expectedSnapshot' in input
      || 'reasonCode' in input
      || 'now' in input
    ) {
      return this.unlinkPlatformAccountAtExpectedSnapshot(
        input as UnlinkPlatformAccountAsLocalAdminExpectedInput,
      );
    }

    const transaction = this.db.transaction((): UnlinkPlatformAccountAsLocalAdminResult => {
      const mapping = this.db.prepare(
        `SELECT canonical_user_id, status
           FROM platform_accounts
          WHERE platform = ? AND platform_account_id = ?`,
      ).get(input.platform, input.platformAccountId) as
        | { canonical_user_id: string; status: string }
        | undefined;

      if (!mapping || mapping.status !== 'active') {
        return { outcome: 'not_found' };
      }

      const update = this.db.prepare(
        `UPDATE platform_accounts
            SET status = 'disabled'
          WHERE platform = ? AND platform_account_id = ? AND status = 'active'`,
      ).run(input.platform, input.platformAccountId);
      if (update.changes !== 1) {
        return { outcome: 'not_found' };
      }

      const eventId = `identity-unlink-${ulid()}`;
      const summary = redactGovernanceDisplayString(
        'Governance CLI disabled one platform account mapping',
      ).text;
      const details = redactGovernanceStructuredValue({
        platform: input.platform,
        canonicalUserId: mapping.canonical_user_id,
        previousStatus: 'active',
        newStatus: 'disabled',
        redaction: 'no_raw_platform_account_id',
      }).value;
      this.db.prepare(
        `INSERT INTO audit_log (
           id, timestamp, category, level, event_type, event_id,
           actor_user_id, actor_class, invocation_context,
           summary, details, redacted, risk_level, evaluator_decision_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ulid(),
        Date.now(),
        'system',
        'summary',
        'identity.platform_account.unlinked',
        eventId,
        null,
        'admin',
        'admin_cli',
        summary,
        JSON.stringify(details),
        1,
        'medium',
        null,
      );

      return { outcome: 'unlinked' };
    });

    return transaction();
  }

  private unlinkPlatformAccountAtExpectedSnapshot(
    input: UnlinkPlatformAccountAsLocalAdminExpectedInput,
  ): UnlinkPlatformAccountAsLocalAdminExpectedResult {
    if (!this.isValidExpectedPlatformAccountUnlinkInput(input)) {
      return { outcome: 'stale' };
    }

    const disabledAt = input.now ?? Date.now();
    const transaction = this.db.transaction(():
      UnlinkPlatformAccountAsLocalAdminExpectedResult => {
      const snapshotResult = readPlatformAccountUnlinkSnapshot(this.db, input);
      if (snapshotResult.outcome !== 'found') {
        return snapshotResult.outcome === 'not_found'
          ? { outcome: 'not_found' }
          : { outcome: 'stale' };
      }
      if (
        snapshotResult.snapshot.snapshotFingerprint
        !== input.expectedSnapshot.snapshotFingerprint
      ) {
        return { outcome: 'stale' };
      }

      const update = this.db.prepare(
        `UPDATE platform_accounts
            SET status = 'disabled'
          WHERE platform = ? AND platform_account_id = ? AND status = 'active'`,
      ).run(input.platform, input.platformAccountId);
      if (update.changes !== 1) {
        throw PLATFORM_ACCOUNT_UNLINK_COUNT_MISMATCH;
      }

      const eventId = `identity-unlink-${ulid()}`;
      const summary = redactGovernanceDisplayString(
        'Governance HTTP disabled one platform account mapping',
      ).text;
      const details = redactGovernanceStructuredValue({
        platform: input.platform,
        canonicalUserId: snapshotResult.canonicalUserId,
        previousStatus: 'active',
        newStatus: 'disabled',
        reasonCode: input.reasonCode,
        redaction: 'no_raw_platform_account_id',
      }).value;
      this.db.prepare(
        `INSERT INTO audit_log (
           id, timestamp, category, level, event_type, event_id,
           actor_user_id, actor_class, invocation_context,
           summary, details, redacted, risk_level, evaluator_decision_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ulid(),
        disabledAt,
        'system',
        'summary',
        'identity.platform_account.unlinked',
        eventId,
        null,
        'admin',
        'admin_cli',
        summary,
        JSON.stringify(details),
        1,
        'medium',
        null,
      );

      return { outcome: 'unlinked', disabledAt };
    });

    try {
      return transaction.immediate();
    } catch (error: unknown) {
      if (error === PLATFORM_ACCOUNT_UNLINK_COUNT_MISMATCH) {
        return { outcome: 'stale' };
      }
      throw error;
    }
  }

  private isValidExpectedPlatformAccountUnlinkInput(
    input: UnlinkPlatformAccountAsLocalAdminExpectedInput,
  ): boolean {
    const keys = Object.keys(input);
    const requiredKeys = [
      'platform',
      'platformAccountId',
      'expectedSnapshot',
      'reasonCode',
    ];
    const allowedKeys = new Set([...requiredKeys, 'now']);
    if (
      requiredKeys.some((key) => !keys.includes(key))
      || keys.some((key) => !allowedKeys.has(key))
      || input.platform !== 'qq'
      || typeof input.platformAccountId !== 'string'
      || !QQ_ID_PATTERN.test(input.platformAccountId)
      || input.reasonCode !== PLATFORM_ACCOUNT_UNLINK_REASON_CODE
      || (input.now !== undefined && (
        typeof input.now !== 'number'
        || !Number.isSafeInteger(input.now)
        || input.now < 0
        || input.now > MAX_JAVASCRIPT_DATE_MS
      ))
    ) {
      return false;
    }

    const snapshot = input.expectedSnapshot;
    return typeof snapshot === 'object'
      && snapshot !== null
      && !Array.isArray(snapshot)
      && Object.keys(snapshot).length === 1
      && Object.keys(snapshot).includes('snapshotFingerprint')
      && typeof snapshot.snapshotFingerprint === 'string'
      && /^[0-9a-f]{64}$/u.test(snapshot.snapshotFingerprint);
  }

  setPrivacyPreferenceAsLocalAdmin(
    input: SetPrivacyPreferenceAsLocalAdminExpectedInput,
  ): SetPrivacyPreferenceAsLocalAdminExpectedResult;
  setPrivacyPreferenceAsLocalAdmin(
    input: SetPrivacyPreferenceAsLocalAdminInput,
  ): SetPrivacyPreferenceAsLocalAdminResult;
  setPrivacyPreferenceAsLocalAdmin(
    input: SetPrivacyPreferenceAsLocalAdminInput | SetPrivacyPreferenceAsLocalAdminExpectedInput,
  ): SetPrivacyPreferenceAsLocalAdminResult | SetPrivacyPreferenceAsLocalAdminExpectedResult {
    if (
      'expectedState' in input
      || 'expectedVersion' in input
      || 'reasonCode' in input
    ) {
      const expectedInput = input as SetPrivacyPreferenceAsLocalAdminExpectedInput;
      if (!this.isValidExpectedPrivacyPreferenceInput(expectedInput)) {
        return { outcome: 'stale' };
      }
      return this.privacyPreferences.setPreference({
        canonicalUserId: expectedInput.canonicalUserId,
        preferenceType: expectedInput.preferenceType,
        state: expectedInput.state,
        expectedState: expectedInput.expectedState,
        expectedVersion: expectedInput.expectedVersion,
        reason: expectedInput.reasonCode,
        actor: {
          canonicalUserId: 'admin',
          actorClass: 'admin',
          context: 'admin_cli',
        },
        ...(expectedInput.now === undefined ? {} : { now: expectedInput.now }),
      });
    }

    this.privacyPreferences.setPreference({
      canonicalUserId: input.canonicalUserId,
      preferenceType: input.preferenceType,
      state: input.state,
      reason: input.reason,
      actor: {
        canonicalUserId: 'admin',
        actorClass: 'admin',
        context: 'admin_cli',
      },
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return { outcome: 'updated' };
  }

  getGroupSummaryPolicyAsLocalAdmin(groupId: string): GroupSummaryPolicy | null {
    return this.summaryPolicies.get(groupId);
  }

  setGroupSummaryPolicyAsLocalAdmin(
    input: SetGroupSummaryPolicyAsLocalAdminExpectedInput,
  ): SetGroupSummaryPolicyAsLocalAdminExpectedResult;
  setGroupSummaryPolicyAsLocalAdmin(
    input: SetGroupSummaryPolicyAsLocalAdminInput,
  ): SetGroupSummaryPolicyResult;
  setGroupSummaryPolicyAsLocalAdmin(
    input: SetGroupSummaryPolicyAsLocalAdminInput
    | SetGroupSummaryPolicyAsLocalAdminExpectedInput,
  ): SetGroupSummaryPolicyResult | SetGroupSummaryPolicyAsLocalAdminExpectedResult {
    if (
      'expectedState' in input
      || 'expectedVersion' in input
      || 'reasonCode' in input
    ) {
      const expectedInput = input as SetGroupSummaryPolicyAsLocalAdminExpectedInput;
      if (!this.isValidExpectedGroupSummaryPolicyInput(expectedInput)) {
        return { outcome: 'stale' };
      }
      return this.summaryPolicies.setEnabled({
        groupId: expectedInput.groupId,
        enabled: expectedInput.enabled,
        expectedState: expectedInput.expectedState,
        expectedVersion: expectedInput.expectedVersion,
        reasonCode: expectedInput.reasonCode,
        ...(expectedInput.now === undefined ? {} : { now: expectedInput.now }),
        authority: {
          kind: 'local_admin',
          actorUserId: 'local_admin',
          invocationContext: 'admin_cli',
        },
      });
    }
    return this.summaryPolicies.setEnabled({
      groupId: input.groupId,
      enabled: input.enabled,
      ...(input.now === undefined ? {} : { now: input.now }),
      authority: {
        kind: 'local_admin',
        actorUserId: 'local_admin',
        invocationContext: 'admin_cli',
      },
    });
  }

  listMemoryMaintenanceProposals(input: {
    authority: MemoryMaintenanceReviewAuthority;
    states?: MemoryMaintenanceProposalLifecycleState[];
    limit?: number;
  }): MemoryMaintenanceProposalRecord[] {
    const authority = this.resolveMemoryMaintenanceAuthority(input.authority);
    if (!authority) {
      return [];
    }
    return this.maintenanceProposals.listForReview({
      access: authority.access,
      ...(input.states === undefined ? {} : { states: input.states }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }

  getMemoryMaintenanceProposal(input: {
    authority: MemoryMaintenanceReviewAuthority;
    proposalId: string;
  }): MemoryMaintenanceProposalRecord | null {
    const authority = this.resolveMemoryMaintenanceAuthority(input.authority);
    if (!authority) {
      return null;
    }
    return this.maintenanceProposals.findForReview({
      proposalId: input.proposalId,
      access: authority.access,
    });
  }

  reviewMemoryMaintenanceProposal(input: {
    authority: MemoryMaintenanceReviewAuthority;
    proposalId: string;
    expectedState: Extract<MemoryMaintenanceProposalLifecycleState, 'pending_review' | 'approved'>;
    expectedRevisionNumber: number;
    transition: MemoryMaintenanceReviewTransition;
    reasonCode: string;
    nowMs?: number;
  }): MemoryMaintenanceGovernanceReviewResult {
    const authority = this.resolveMemoryMaintenanceAuthority(input.authority);
    if (!authority) {
      return { outcome: 'not_found_or_denied' };
    }
    const result = this.maintenanceProposals.transitionReview({
      proposalId: input.proposalId,
      access: authority.access,
      expectedState: input.expectedState,
      expectedRevisionNumber: input.expectedRevisionNumber,
      transition: input.transition,
      actor: authority.actor,
      authorityKind: authority.authorityKind,
      reasonCode: input.reasonCode,
      nowMs: input.nowMs ?? Date.now(),
    });
    return result.outcome === 'not_found'
      ? { outcome: 'not_found_or_denied' }
      : result;
  }

  applyMemoryMaintenanceProposal(input: {
    authority: MemoryMaintenanceReviewAuthority;
    proposalId: string;
    expectedState: 'approved';
    expectedRevisionNumber: number;
    reasonCode: string;
    retainedMemoryId?: string;
    nowMs?: number;
  }): MemoryMaintenanceGovernanceApplyResult {
    const authority = this.resolveMemoryMaintenanceAuthority(input.authority);
    if (!authority) {
      return { outcome: 'not_found_or_denied' };
    }
    const applyInput: MemoryMaintenanceApplyInput = {
      proposalId: input.proposalId,
      access: authority.access,
      expectedState: input.expectedState,
      expectedRevisionNumber: input.expectedRevisionNumber,
      actor: authority.actor,
      authorityKind: authority.authorityKind,
      reasonCode: input.reasonCode,
      nowMs: input.nowMs ?? Date.now(),
      ...(input.retainedMemoryId === undefined
        ? {}
        : { retainedMemoryId: input.retainedMemoryId }),
    };
    const result = this.maintenanceProposals.applyApproved(applyInput);
    return result.outcome === 'not_found'
      ? { outcome: 'not_found_or_denied' }
      : result;
  }

  rollbackMemoryMaintenanceProposal(input: {
    authority: MemoryMaintenanceReviewAuthority;
    proposalId: string;
    expectedState: 'applied';
    expectedRevisionNumber: number;
    reasonCode: string;
    nowMs?: number;
  }): MemoryMaintenanceGovernanceRollbackResult {
    const authority = this.resolveMemoryMaintenanceAuthority(input.authority);
    if (!authority) {
      return { outcome: 'not_found_or_denied' };
    }
    const rollbackInput: MemoryMaintenanceRollbackInput = {
      proposalId: input.proposalId,
      access: authority.access,
      expectedState: input.expectedState,
      expectedRevisionNumber: input.expectedRevisionNumber,
      actor: authority.actor,
      authorityKind: authority.authorityKind,
      reasonCode: input.reasonCode,
      nowMs: input.nowMs ?? Date.now(),
    };
    const result = this.maintenanceProposals.rollbackApplied(rollbackInput);
    return result.outcome === 'not_found'
      ? { outcome: 'not_found_or_denied' }
      : result;
  }

  private executeQqCommand(
    source: QqCommandSource,
    authority: QqAuthority,
    command: QqGovernanceCommand,
  ): QqGovernanceResult {
    switch (command.type) {
      case 'memory':
        return this.listQqMemory(source, authority);
      case 'memory_forget':
        return this.forgetQqMemory(source, authority, command.memoryId);
      case 'memory_summary':
        return this.handleQqSummary(source, authority, command.action);
      case 'why':
        return this.explainPriorTurn(source);
    }
  }

  private listQqMemory(
    source: QqCommandSource,
    authority: QqAuthority,
  ): QqGovernanceResult {
    const restrictedToCurrentGroup = source.conversationType === 'group';
    const params: unknown[] = ['secret', 'prohibited', 'deleted'];
    let sql = `
      SELECT id, scope, state, title
        FROM memory_records
       WHERE sensitivity NOT IN (?, ?)
         AND state <> ?
    `;

    if (restrictedToCurrentGroup) {
      if (!source.groupId) {
        return this.result('invalid_source', INVALID_SOURCE_RESPONSE);
      }
      sql += `
        AND visibility NOT IN ('private_only', 'same_user_any_context')
        AND (
          (scope = 'group' AND group_id = ?)
          OR (scope = 'conversation' AND conversation_id = ?)
          OR (
            scope = 'user'
            AND visibility = 'same_group_only'
            AND (group_id = ? OR conversation_id = ?)
          )
        )
      `;
      params.push(
        source.groupId,
        source.conversationId,
        source.groupId,
        source.conversationId,
      );
    } else if (authority.kind !== 'bot_owner') {
      return this.result('denied', DENIED_RESPONSE);
    }

    sql += ' ORDER BY importance DESC, updated_at DESC, id ASC LIMIT ?';
    params.push(MAX_MEMORY_LIST_ITEMS);
    const rows = this.db.prepare(sql).all(...params) as MemoryListRow[];
    if (rows.length === 0) {
      return this.result('memory_listed', 'Memory records: none.');
    }

    const lines = rows.map((row) => {
      const id = this.redactMemoryId(row.id);
      const title = this.redactBoundedTitle(row.title);
      return `- ${id} | scope=${this.coarseScope(row.scope)} | state=${this.coarseState(row.state)} | title=${title}`;
    });
    return this.result('memory_listed', `Memory records (${rows.length}):\n${lines.join('\n')}`);
  }

  private forgetQqMemory(
    source: QqCommandSource,
    authority: QqAuthority,
    memoryId: string,
  ): QqGovernanceResult {
    const result = this.forgetMemory({
      memoryId,
      actorUserId: source.canonicalUserId,
      actorClass: authority.actorClass,
      invocationContext: this.invocationContext(source),
      reason: 'QQ governance memory forget',
      auditSummary: 'QQ governance deleted one memory record',
      auditDetails: {
        memoryId: formatGovernanceMemoryIdForDisplay(memoryId),
        sourceEventId: source.sourceEventId,
        governanceCommand: 'memory_forget',
        authority: authority.kind,
      },
      canGovern: (memory) => (
        authority.kind === 'bot_owner'
        || this.isWithinCurrentGroupMemoryScope(memory, source)
      ),
    });
    return result.outcome === 'forgotten'
      ? this.result('memory_forgotten', 'Memory record deleted.')
      : this.result('memory_unavailable', MEMORY_UNAVAILABLE_RESPONSE);
  }

  private forgetMemory(input: {
    memoryId: string;
    actorUserId: string;
    actorClass: Extract<ActorClass, 'owner' | 'admin' | 'group_admin'>;
    invocationContext: InvocationContext;
    reason: string;
    auditSummary: string;
    auditDetails: Record<string, unknown>;
    canGovern(memory: MemoryGovernanceRow): boolean;
    expected?: {
      scope: MemoryMaintenanceProposalExactScope;
      state: Exclude<MemoryRecord['state'], 'deleted'>;
      revisionNumber: number;
    };
  }): LocalAdminForgetResult | LocalAdminExpectedForgetResult {
    const transaction = this.db.transaction(():
      LocalAdminForgetResult | LocalAdminExpectedForgetResult => {
      const row = this.db.prepare(
        `SELECT id, scope, canonical_user_id, group_id, conversation_id,
                visibility, sensitivity, state,
                (
                  SELECT MAX(revisions.revision_number)
                    FROM memory_revisions revisions
                   WHERE revisions.memory_id = memory_records.id
                ) AS current_revision_number
           FROM memory_records
          WHERE id = ?`,
      ).get(input.memoryId) as MemoryGovernanceRow | undefined;
      if (!row || row.state === 'deleted' || !input.canGovern(row)) {
        return { outcome: 'not_found' };
      }
      if (input.expected) {
        if (!this.memoryMatchesExactScope(row, input.expected.scope)) {
          return { outcome: 'not_found' };
        }
        if (
          row.state !== input.expected.state
          || typeof row.current_revision_number !== 'number'
          || !Number.isSafeInteger(row.current_revision_number)
          || row.current_revision_number < 1
          || row.current_revision_number >= Number.MAX_SAFE_INTEGER
          || row.current_revision_number !== input.expected.revisionNumber
        ) {
          return { outcome: 'stale' };
        }
      }

      this.memories.updateStateSync(row.id, 'deleted', {
        actor: {
          canonicalUserId: input.actorUserId,
          actorClass: input.actorClass,
          context: input.invocationContext,
        },
        reason: input.reason,
        auditSummary: input.auditSummary,
        auditDetails: input.auditDetails,
        evaluatorDecisionId: this.memoryDeleteDecisionId(row.id),
      });
      return input.expected
        ? { outcome: 'forgotten', revisionNumber: input.expected.revisionNumber + 1 }
        : { outcome: 'forgotten' };
    });
    return transaction.immediate();
  }

  private isValidExpectedForgetInput(input: LocalAdminExpectedForgetInput): boolean {
    return this.isCleanGovernanceIdentifier(input.memoryId)
      && this.isValidMemoryRecordScope(input.scope)
      && FORGETTABLE_MEMORY_STATES.some((state) => state === input.expectedState)
      && Number.isSafeInteger(input.expectedRevisionNumber)
      && input.expectedRevisionNumber >= 1
      && input.expectedRevisionNumber < Number.MAX_SAFE_INTEGER
      && GOVERNANCE_REASON_CODE_PATTERN.test(input.reasonCode);
  }

  private restoreMemory(input: {
    memoryId: string;
    actorUserId: 'admin' | 'local_admin';
    reason: string;
    auditSummary: string;
    auditDetails?: Record<string, unknown>;
    expected?: {
      scope: MemoryMaintenanceProposalExactScope;
      state: LocalAdminExpectedRestoreInput['expectedState'];
      revisionNumber: number;
    };
  }): LocalAdminRestoreResult | LocalAdminExpectedRestoreResult {
    const transaction = this.db.transaction(():
      LocalAdminRestoreResult | LocalAdminExpectedRestoreResult => {
      const row = this.db.prepare(
        `SELECT id, scope, canonical_user_id, group_id, conversation_id,
                visibility, sensitivity, state,
                (
                  SELECT MAX(revisions.revision_number)
                    FROM memory_revisions revisions
                   WHERE revisions.memory_id = memory_records.id
                ) AS current_revision_number
           FROM memory_records
          WHERE id = ?`,
      ).get(input.memoryId) as MemoryGovernanceRow | undefined;
      if (!row || !RESTORABLE_MEMORY_STATES.some((state) => state === row.state)) {
        return { outcome: 'not_found' };
      }
      if (input.expected) {
        if (!this.memoryMatchesExactScope(row, input.expected.scope)) {
          return { outcome: 'not_found' };
        }
        if (
          row.state !== input.expected.state
          || typeof row.current_revision_number !== 'number'
          || !Number.isSafeInteger(row.current_revision_number)
          || row.current_revision_number < 1
          || row.current_revision_number >= Number.MAX_SAFE_INTEGER
          || row.current_revision_number !== input.expected.revisionNumber
        ) {
          return { outcome: 'stale' };
        }
      }

      this.memories.updateStateSync(row.id, 'active', {
        actor: {
          canonicalUserId: input.actorUserId,
          actorClass: 'admin',
          context: 'admin_cli',
        },
        reason: input.reason,
        auditSummary: input.auditSummary,
        auditDetails: input.auditDetails,
      });
      return input.expected
        ? { outcome: 'restored', revisionNumber: input.expected.revisionNumber + 1 }
        : { outcome: 'restored' };
    });
    return transaction.immediate();
  }

  private isValidExpectedRestoreInput(input: LocalAdminExpectedRestoreInput): boolean {
    return this.isCleanGovernanceIdentifier(input.memoryId)
      && this.isValidMemoryRecordScope(input.scope)
      && RESTORABLE_MEMORY_STATES.some((state) => state === input.expectedState)
      && Number.isSafeInteger(input.expectedRevisionNumber)
      && input.expectedRevisionNumber >= 1
      && input.expectedRevisionNumber < Number.MAX_SAFE_INTEGER
      && GOVERNANCE_REASON_CODE_PATTERN.test(input.reasonCode);
  }

  private isValidExpectedPrivacyPreferenceInput(
    input: SetPrivacyPreferenceAsLocalAdminExpectedInput,
  ): boolean {
    return this.isCleanGovernanceIdentifier(input.canonicalUserId)
      && (input.preferenceType === 'proactive_dm'
        || input.preferenceType === 'memory_association')
      && (input.state === 'opted_in' || input.state === 'opted_out')
      && (input.expectedState === 'opted_in' || input.expectedState === 'opted_out')
      && input.state !== input.expectedState
      && this.isValidPrivacyPreferenceExpectedVersion(input.expectedVersion)
      && GOVERNANCE_REASON_CODE_PATTERN.test(input.reasonCode)
      && (input.now === undefined || (
        Number.isSafeInteger(input.now)
        && input.now >= 0
        && input.now <= MAX_JAVASCRIPT_DATE_MS
      ));
  }

  private isValidPrivacyPreferenceExpectedVersion(
    value: unknown,
  ): value is PrivacyPreferenceExpectedVersion {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 2
      || !keys.includes('source')
      || !keys.includes('updatedAt')
    ) {
      return false;
    }
    if (record.source === 'implicit_default') {
      return record.updatedAt === null;
    }
    return record.source === 'stored_preference'
      && typeof record.updatedAt === 'number'
      && Number.isSafeInteger(record.updatedAt)
      && record.updatedAt >= 0
      && record.updatedAt <= MAX_JAVASCRIPT_DATE_MS;
  }

  private isValidExpectedGroupSummaryPolicyInput(
    input: SetGroupSummaryPolicyAsLocalAdminExpectedInput,
  ): boolean {
    return NORMALIZED_QQ_GROUP_ID_PATTERN.test(input.groupId)
      && typeof input.enabled === 'boolean'
      && (input.expectedState === 'enabled' || input.expectedState === 'disabled')
      && input.enabled !== (input.expectedState === 'enabled')
      && this.isValidGroupSummaryPolicyExpectedVersion(input.expectedVersion)
      && GOVERNANCE_REASON_CODE_PATTERN.test(input.reasonCode)
      && (input.now === undefined || (
        Number.isSafeInteger(input.now)
        && input.now >= 0
        && input.now <= MAX_JAVASCRIPT_DATE_MS
      ));
  }

  private isValidGroupSummaryPolicyExpectedVersion(
    value: unknown,
  ): value is GroupSummaryPolicyExpectedVersion {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 3
      || !keys.includes('source')
      || !keys.includes('generation')
      || !keys.includes('updatedAt')
    ) {
      return false;
    }
    if (record.source === 'implicit_default') {
      return record.generation === null && record.updatedAt === null;
    }
    return record.source === 'stored_policy'
      && typeof record.generation === 'number'
      && Number.isSafeInteger(record.generation)
      && record.generation >= 1
      && typeof record.updatedAt === 'number'
      && Number.isSafeInteger(record.updatedAt)
      && record.updatedAt >= 0
      && record.updatedAt <= MAX_JAVASCRIPT_DATE_MS;
  }

  private isValidMemoryRecordScope(scope: MemoryMaintenanceProposalExactScope): boolean {
    switch (scope.kind) {
      case 'global':
      case 'system':
        return true;
      case 'user':
        return this.isCleanGovernanceIdentifier(scope.canonicalUserId);
      case 'group':
        return this.isCleanGovernanceIdentifier(scope.groupId);
      case 'conversation':
        return this.isCleanGovernanceIdentifier(scope.conversationId)
          && (scope.conversationType === 'private'
            ? scope.groupId === undefined
            : scope.groupId !== undefined
              && this.isCleanGovernanceIdentifier(scope.groupId));
    }
  }

  private isCleanGovernanceIdentifier(value: string): boolean {
    const characters = Array.from(value);
    return value.trim() === value
      && characters.length >= 1
      && characters.length <= 256
      && characters.every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
      });
  }

  private memoryMatchesExactScope(
    memory: MemoryGovernanceRow,
    scope: MemoryMaintenanceProposalExactScope,
  ): boolean {
    switch (scope.kind) {
      case 'global':
      case 'system':
        return memory.scope === scope.kind
          && memory.canonical_user_id === null
          && memory.group_id === null
          && memory.conversation_id === null;
      case 'user':
        return memory.scope === 'user'
          && memory.canonical_user_id === scope.canonicalUserId;
      case 'group':
        return memory.scope === 'group' && memory.group_id === scope.groupId;
      case 'conversation':
        return memory.scope === 'conversation'
          && memory.conversation_id === scope.conversationId
          && (scope.conversationType === 'private'
            ? memory.group_id === null
            : memory.group_id === scope.groupId);
    }
  }

  private handleQqSummary(
    source: QqCommandSource,
    authority: QqAuthority,
    action: 'status' | 'enable' | 'disable',
  ): QqGovernanceResult {
    if (source.conversationType !== 'group' || !source.groupId) {
      return this.result('group_required', GROUP_REQUIRED_RESPONSE);
    }

    if (action === 'status') {
      const enabled = this.summaryPolicies.isEnabled(source.groupId);
      return this.result(
        'summary_status',
        `Group summary policy is ${enabled ? 'enabled' : 'disabled'}.`,
      );
    }

    const enabled = action === 'enable';
    this.summaryPolicies.setEnabled({
      groupId: source.groupId,
      enabled,
      authority: {
        kind: authority.kind,
        actorUserId: source.canonicalUserId,
        invocationContext: 'group_chat',
        currentGroupId: source.groupId,
        sourceEventId: source.sourceEventId,
      },
    });
    return this.result(
      enabled ? 'summary_enabled' : 'summary_disabled',
      `Group summary policy ${enabled ? 'enabled' : 'disabled'}.`,
    );
  }

  private explainPriorTurn(source: QqCommandSource): QqGovernanceResult {
    const groupId = source.groupId ?? null;
    const row = this.db.prepare(
      `SELECT turn.status,
              turn.tokens_total,
              trace.selected_memory_ids,
              trace.rejected_memories,
              CASE WHEN trace.id IS NULL THEN 0 ELSE 1 END AS stored_context,
              (SELECT COUNT(*)
                 FROM action_decisions
                WHERE action_decisions.turn_id = turn.id) AS action_decision_count,
              (SELECT COUNT(*)
                 FROM action_executions
                 JOIN action_decisions
                   ON action_decisions.id = action_executions.action_decision_id
                WHERE action_decisions.turn_id = turn.id) AS action_execution_count,
              (SELECT COUNT(*)
                 FROM tool_calls
                WHERE tool_calls.turn_id = turn.id) AS tool_call_count
         FROM agent_turns AS turn
         JOIN raw_events AS trigger_raw
           ON trigger_raw.id = turn.trigger_event_id
         JOIN chat_messages AS trigger_chat
           ON trigger_chat.raw_event_id = trigger_raw.id
         LEFT JOIN context_traces AS trace
           ON trace.id = turn.context_pack_id
          AND trace.turn_id = turn.id
          AND trace.conversation_id = ?
          AND trace.conversation_type = ?
          AND trace.group_id IS ?
        WHERE turn.trigger_event_id <> ?
          AND turn.conversation_id = ?
          AND trigger_raw.source = 'gateway'
          AND trigger_raw.platform = 'qq'
          AND trigger_raw.type = 'chat.message.received'
          AND trigger_raw.rowid < ?
          AND trigger_chat.conversation_id = ?
          AND trigger_chat.conversation_type = ?
          AND trigger_chat.group_id IS ?
        ORDER BY trigger_raw.rowid DESC, turn.started_at DESC, turn.id DESC
        LIMIT 1`,
    ).get(
      source.conversationId,
      source.conversationType,
      groupId,
      source.sourceEventId,
      source.conversationId,
      source.rawRowId,
      source.conversationId,
      source.conversationType,
      groupId,
    ) as WhyTurnRow | undefined;

    if (!row) {
      return this.result(
        'why_unavailable',
        'No prior turn evidence is available for this conversation.',
      );
    }

    const selectedCount = this.jsonArrayLength(row.selected_memory_ids);
    const rejectedCount = this.jsonArrayLength(row.rejected_memories);
    const response = [
      'Prior turn evidence:',
      `turn_status=${this.turnStatus(row.status)}`,
      `stored_context=${row.stored_context === 1 ? 'yes' : 'no'}`,
      `selected_memories=${selectedCount}`,
      `rejected_memories=${rejectedCount}`,
      `tokens_used=${this.nonNegativeCount(row.tokens_total)}`,
      `action_decisions=${this.nonNegativeCount(row.action_decision_count)}`,
      `action_executions=${this.nonNegativeCount(row.action_execution_count)}`,
      `tool_calls=${this.nonNegativeCount(row.tool_call_count)}`,
    ].join('\n');
    return this.result('why_explained', response);
  }

  private readQqCommandSource(sourceEventId: string): QqCommandSource | null {
    if (
      sourceEventId.length === 0
      || sourceEventId.length > 512
      || sourceEventId.trim() !== sourceEventId
    ) {
      return null;
    }

    const rows = this.db.prepare(
      `SELECT raw.id,
              raw.type,
              raw.timestamp,
              raw.source,
              raw.platform,
              raw.conversation_id,
              raw.correlation_id,
              raw.platform_event_id,
              raw.payload,
              raw.rowid AS raw_rowid,
              chat.id AS chat_id,
              chat.raw_event_id AS chat_raw_event_id,
              chat.message_id AS chat_message_id,
              chat.conversation_id AS chat_conversation_id,
              chat.conversation_type AS chat_conversation_type,
              chat.group_id AS chat_group_id,
              chat.sender_id AS chat_sender_id,
              chat.sender_role AS chat_sender_role,
              chat.text AS chat_text,
              chat.timestamp AS chat_timestamp,
              account.platform_account_id,
              account.canonical_user_id
         FROM raw_events AS raw
         JOIN chat_messages AS chat
           ON chat.raw_event_id = raw.id
         JOIN platform_accounts AS account
           ON account.platform = 'qq'
          AND account.status = 'active'
          AND account.platform_account_id = CASE
                WHEN substr(chat.sender_id, 1, 3) = 'qq-'
                  THEN substr(chat.sender_id, 4)
                ELSE chat.sender_id
              END
        WHERE raw.id = ?
          AND raw.type = 'chat.message.received'
          AND raw.source = 'gateway'
          AND raw.platform = 'qq'
          AND NOT EXISTS (
            SELECT 1
              FROM chat_messages AS other_chat
             WHERE other_chat.raw_event_id = raw.id
               AND other_chat.id <> chat.id
          )`,
    ).all(sourceEventId) as QqCommandSourceRow[];
    if (rows.length !== 1) {
      return null;
    }

    const row = rows[0];
    if (!row) {
      return null;
    }
    const parsed = parseStoredChatMessageReceived(row);
    if (!parsed.ok) {
      return null;
    }
    const event = parsed.event;
    const normalizedQq = NORMALIZED_QQ_ID_PATTERN.exec(event.message.senderId);
    if (
      !normalizedQq
      || normalizedQq[1] !== row.platform_account_id
      || row.canonical_user_id.length === 0
      || row.canonical_user_id.trim() !== row.canonical_user_id
      || row.chat_id !== event.id
      || row.chat_raw_event_id !== row.id
      || row.chat_message_id !== event.message.messageId
      || row.chat_conversation_id !== event.message.conversationId
      || row.chat_conversation_type !== event.message.conversationType
      || row.chat_group_id !== (event.message.groupId ?? null)
      || row.chat_sender_id !== event.message.senderId
      || row.chat_sender_role !== (event.message.senderRole ?? null)
      || (row.chat_text ?? '') !== (event.message.content.text ?? '')
      || row.chat_timestamp !== event.timestamp.getTime()
    ) {
      return null;
    }

    return {
      sourceEventId: row.id,
      rawRowId: row.raw_rowid,
      text: row.chat_text ?? '',
      conversationId: event.message.conversationId,
      conversationType: event.message.conversationType,
      ...(event.message.groupId === undefined ? {} : { groupId: event.message.groupId }),
      senderId: event.message.senderId,
      ...(event.message.senderRole === undefined
        ? {}
        : { senderRole: event.message.senderRole }),
      canonicalUserId: row.canonical_user_id,
    };
  }

  private resolveQqAuthority(
    source: QqCommandSource,
    botOwnerQqId: string | undefined,
  ): QqAuthority | null {
    if (
      botOwnerQqId !== undefined
      && QQ_ID_PATTERN.test(botOwnerQqId)
      && source.senderId === `qq-${botOwnerQqId}`
    ) {
      return { kind: 'bot_owner', actorClass: 'owner' };
    }
    if (source.conversationType !== 'group') {
      return null;
    }
    if (source.senderRole === 'owner') {
      return { kind: 'group_owner', actorClass: 'owner' };
    }
    if (source.senderRole === 'admin') {
      return { kind: 'group_admin', actorClass: 'group_admin' };
    }
    return null;
  }

  private hasCanonicalQqCommandScope(source: QqCommandSource): boolean {
    if (source.conversationType === 'private') {
      return source.groupId === undefined;
    }
    return source.groupId !== undefined
      && NORMALIZED_QQ_GROUP_ID_PATTERN.test(source.groupId)
      && source.conversationId === source.groupId;
  }

  private memoryDeleteDecisionId(memoryId: string): string {
    const digest = createHash('sha256')
      .update('lethebot:governance-memory-delete:v1\0')
      .update(memoryId)
      .digest('hex');
    return `policy:l0:deleted:sha256:${digest}`;
  }

  private resolveMemoryMaintenanceAuthority(
    authority: MemoryMaintenanceReviewAuthority,
  ): ResolvedMemoryMaintenanceAuthority | null {
    if (authority.kind === 'local_admin') {
      return {
        access: { kind: 'all' },
        actor: {
          actorClass: 'admin',
          invocationContext: 'admin_cli',
        },
        authorityKind: 'local_admin',
      };
    }

    const canonicalUserId = authority.canonicalUserId;
    const conversationId = authority.conversationId;
    if (
      !canonicalUserId
      || canonicalUserId.trim() !== canonicalUserId
      || !conversationId
      || conversationId.trim() !== conversationId
    ) {
      return null;
    }

    if (authority.invocationContext === 'private_chat') {
      if (authority.groupId !== undefined) {
        return null;
      }
      if (authority.kind === 'bot_owner') {
        return {
          access: { kind: 'all' },
          actor: {
            canonicalUserId,
            actorClass: 'owner',
            invocationContext: 'private_chat',
          },
          authorityKind: 'bot_owner',
        };
      }
      if (authority.kind === 'user') {
        return {
          access: {
            kind: 'private_user',
            canonicalUserId,
            conversationId,
          },
          actor: {
            canonicalUserId,
            actorClass: 'user',
            invocationContext: 'private_chat',
          },
          authorityKind: 'user',
        };
      }
      return null;
    }

    const groupId = authority.groupId;
    if (
      authority.invocationContext !== 'group_chat'
      || !groupId
      || !NORMALIZED_QQ_GROUP_ID_PATTERN.test(groupId)
      || conversationId !== groupId
    ) {
      return null;
    }
    if (authority.kind === 'user') {
      return {
        access: {
          kind: 'group_user',
          canonicalUserId,
          groupId,
          conversationId,
        },
        actor: {
          canonicalUserId,
          actorClass: 'user',
          invocationContext: 'group_chat',
        },
        authorityKind: 'user',
      };
    }
    if (
      authority.kind !== 'bot_owner'
      && authority.kind !== 'group_owner'
      && authority.kind !== 'group_admin'
    ) {
      return null;
    }
    return {
      access: { kind: 'exact_group', groupId, conversationId },
      actor: {
        canonicalUserId,
        actorClass: authority.kind === 'group_admin' ? 'group_admin' : 'owner',
        invocationContext: 'group_chat',
      },
      authorityKind: authority.kind,
    };
  }

  private isWithinCurrentGroupMemoryScope(
    memory: MemoryGovernanceRow,
    source: QqCommandSource,
  ): boolean {
    if (source.conversationType !== 'group' || !source.groupId) {
      return false;
    }
    if (
      memory.sensitivity === 'secret'
      || memory.sensitivity === 'prohibited'
      || memory.visibility === 'private_only'
      || memory.visibility === 'same_user_any_context'
    ) {
      return false;
    }
    if (memory.scope === 'group') {
      return memory.group_id === source.groupId;
    }
    if (memory.scope === 'conversation') {
      return memory.conversation_id === source.conversationId;
    }
    return memory.scope === 'user'
      && memory.visibility === 'same_group_only'
      && (
        memory.group_id === source.groupId
        || memory.conversation_id === source.conversationId
      );
  }

  private invocationContext(source: QqCommandSource): InvocationContext {
    return source.conversationType === 'group' ? 'group_chat' : 'private_chat';
  }

  private redactMemoryId(id: string): string {
    return formatGovernanceMemoryIdForDisplay(id);
  }

  private redactBoundedTitle(title: string): string {
    const collapsed = title.replace(/\s+/gu, ' ').trim();
    const literalText = collapsed
      .replace(/&/gu, '&amp;')
      .replace(/\[/gu, '&#91;')
      .replace(/\]/gu, '&#93;');
    const redacted = this.redactResponseText(literalText);
    if (redacted.length <= MAX_MEMORY_TITLE_LENGTH) {
      return redacted.length === 0 ? '[untitled]' : redacted;
    }

    let end = MAX_MEMORY_TITLE_LENGTH - 3;
    for (const match of redacted.matchAll(/\[REDACTED:[^\]\r\n]{1,64}\]/gu)) {
      const start = match.index;
      const markerEnd = start + match[0].length;
      if (start < end && markerEnd > end) {
        end = markerEnd;
      }
    }
    return end >= redacted.length ? redacted : `${redacted.slice(0, end)}...`;
  }

  private coarseScope(scope: string): string {
    const scopes = new Set(['global', 'user', 'group', 'conversation', 'tool', 'system']);
    return scopes.has(scope) ? scope : 'unknown';
  }

  private coarseState(state: string): string {
    const states = new Set(['proposed', 'active', 'rejected', 'superseded', 'disabled']);
    return states.has(state) ? state : 'unknown';
  }

  private turnStatus(status: string): string {
    const statuses = new Set(['pending', 'running', 'completed', 'failed', 'aborted']);
    return statuses.has(status) ? status : 'unknown';
  }

  private jsonArrayLength(raw: string | null): number {
    if (!raw || raw.length > 1_000_000) {
      return 0;
    }
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) ? value.length : 0;
    } catch {
      return 0;
    }
  }

  private nonNegativeCount(value: number | null): number {
    return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value ?? 0 : 0;
  }

  private result(outcome: QqGovernanceOutcome, responseText: string): QqGovernanceResult {
    const safe = this.redactResponseText(responseText);
    return {
      outcome,
      responseText: safe.length <= MAX_RESPONSE_LENGTH
        ? safe
        : safe.slice(0, MAX_RESPONSE_LENGTH),
    };
  }

  private redactResponseText(text: string): string {
    return redactGovernanceText(text);
  }
}
