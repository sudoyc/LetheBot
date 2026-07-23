import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { redactSecretsInText } from '../memory/secret-scan.js';
import { parseStoredChatMessageReceived } from '../ingestion/stored-chat-event.js';
import {
  GroupSummaryPolicyRepository,
  type GroupSummaryAuthorityKind,
  type GroupSummaryPolicy,
  type SetGroupSummaryPolicyResult,
} from '../storage/group-summary-policy-repository.js';
import { MemoryRepository } from '../storage/memory-repository.js';
import type { ActorClass, InvocationContext } from '../types/tool.js';
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

export interface SetGroupSummaryPolicyAsLocalAdminInput {
  groupId: string;
  enabled: boolean;
  now?: number;
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
  state: string;
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

  forgetMemoryAsLocalAdmin(memoryId: string): LocalAdminForgetResult {
    const displayId = formatGovernanceMemoryIdForDisplay(memoryId);
    return this.forgetMemory({
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
  }

  getGroupSummaryPolicyAsLocalAdmin(groupId: string): GroupSummaryPolicy | null {
    return this.summaryPolicies.get(groupId);
  }

  setGroupSummaryPolicyAsLocalAdmin(
    input: SetGroupSummaryPolicyAsLocalAdminInput,
  ): SetGroupSummaryPolicyResult {
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
  }): LocalAdminForgetResult {
    const transaction = this.db.transaction((): LocalAdminForgetResult => {
      const row = this.db.prepare(
        `SELECT id, scope, canonical_user_id, group_id, conversation_id,
                visibility, sensitivity, state
           FROM memory_records
          WHERE id = ?`,
      ).get(input.memoryId) as MemoryGovernanceRow | undefined;
      if (!row || row.state === 'deleted' || !input.canGovern(row)) {
        return { outcome: 'not_found' };
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
      return { outcome: 'forgotten' };
    });
    return transaction.immediate();
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
