import { redactSecretsInText } from '../memory/secret-scan.js';
import type {
  MemoryMaintenanceProposalExactScope,
  MemoryMaintenanceProposalRecord,
} from '../storage/memory-maintenance-proposal-repository.js';
import type { StoredContextTrace } from '../storage/context-trace-repository.js';
import type { PrivacyPreferenceRecord } from '../storage/privacy-preference-repository.js';
import type { ActionDecision, ActionPlan, ActionType } from '../types/action.js';
import type { MemoryRecord } from '../types/memory.js';
import type {
  ActionDecisionExplanation,
  ActionDecisionInspectionRecord,
  ActionExecutionExplanation,
  ActionExecutionInspectionRecord,
  EventProcessingFailureInspectionRecord,
  ExplainTurnDetailExecutionEffect,
  ExplainTurnResolution,
  ExportMemoryRecord,
  JobAttemptInspectionRecord,
  JobInspectionRecord,
  MemoryRecordInspectionRecord,
  PrivacyPreferenceInspectionRecord,
  PrivacyPreferenceScopeInspectionRecord,
  StoredContextExplanation,
  ToolCallExplanation,
  ToolCallInspectionRecord,
  WorkerHeartbeatInspectionRecord,
} from './query-contracts.js';

export interface ToolCallRow {
  id: string;
  turn_id: string;
  tool_name: string;
  input: string;
  output: string | null;
  requested_by: string;
  actor_user_id: string | null;
  actor_class: string;
  invocation_context: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  execution_time_ms: number | null;
  secrets_redacted: number;
  created_at: number;
}

export interface ExplainTurnResolutionRow {
  id: string;
  context_pack_id: string | null;
  conversation_id: string;
  conversation_type: 'private' | 'group' | null;
  group_id: string | null;
  sender_id: string | null;
}

export interface ActionDecisionRow {
  id: string;
  turn_id: string;
  decided_by: ActionDecision['decidedBy'];
  risk_level: ActionDecision['riskLevel'];
  confidence: number;
  evaluator_required: number;
  evaluator_passed: number | null;
  actions: string;
  reasons: string | null;
  suppressors: string | null;
  created_at: number;
}

export interface ActionExecutionRow {
  id: string;
  action_decision_id: string;
  action_type: ActionType;
  status: string;
  executed_message_id: string | null;
  executed_memory_id: string | null;
  executed_job_id: string | null;
  downgraded_from: ActionType | null;
  downgraded_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  audit_level: ActionExecutionInspectionRecord['auditLevel'];
  audit_entry: string | null;
  executed_at: number;
}

export interface JobRow {
  id: string;
  type: string;
  payload: string;
  idempotency_key: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
  created_at: number;
  updated_at: number;
  scheduled_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  result: string | null;
}

export interface JobAttemptRow {
  id: string;
  job_id: string;
  attempt_number: number;
  worker_id: string;
  status: string;
  started_at: number;
  completed_at: number | null;
  heartbeat_at: number | null;
  error: string | null;
  result: string | null;
}

export interface WorkerHeartbeatRow {
  worker_id: string;
  worker_type: string;
  status: string;
  current_job_id: string | null;
  heartbeat_at: number;
  details: string | null;
}

export interface EventProcessingFailureRow {
  id: string;
  raw_event_id: string | null;
  turn_id: string | null;
  occurred_at: number;
  stage: string;
  conversation_type: 'private' | 'group' | null;
  error_name: string;
  error_message_hash: string;
  message_id_hash: string | null;
  sender_id_hash: string | null;
  conversation_id_hash: string | null;
  details: string;
}

export function projectGovernanceActionExecutionInspection(
  row: ActionExecutionRow,
  includeAuditEntry: boolean,
): ActionExecutionInspectionRecord {
  return {
    id: redactGovernanceDisplayString(row.id).text,
    actionDecisionId: redactGovernanceDisplayString(row.action_decision_id).text,
    actionType: redactGovernanceDisplayString(row.action_type).text,
    status: redactGovernanceDisplayString(row.status).text,
    executedMessageId: row.executed_message_id
      ? redactGovernanceDisplayString(row.executed_message_id).text
      : undefined,
    executedMemoryId: row.executed_memory_id
      ? redactGovernanceDisplayString(row.executed_memory_id).text
      : undefined,
    executedJobId: row.executed_job_id
      ? redactGovernanceDisplayString(row.executed_job_id).text
      : undefined,
    downgradedFrom: row.downgraded_from
      ? redactGovernanceDisplayString(row.downgraded_from).text
      : undefined,
    downgradedReason: row.downgraded_reason
      ? redactGovernanceDisplayString(row.downgraded_reason).text
      : undefined,
    errorCode: row.error_code ? redactGovernanceDisplayString(row.error_code).text : undefined,
    errorMessage: row.error_message
      ? redactGovernanceDisplayString(row.error_message).text
      : undefined,
    auditLevel: redactGovernanceDisplayString(row.audit_level).text,
    auditEntry: includeAuditEntry && row.audit_entry
      ? redactGovernanceDisplayString(row.audit_entry).text
      : undefined,
    executedAt: new Date(row.executed_at),
  };
}

export function projectGovernanceJobInspection(
  row: JobRow,
  includePayload: boolean,
): JobInspectionRecord {
  const payload = includePayload
    ? redactGovernanceStructuredValue(parseGovernanceJson(row.payload))
    : undefined;
  const result = includePayload && row.result !== null
    ? redactGovernanceStructuredValue(parseGovernanceJson(row.result))
    : undefined;

  return {
    id: redactGovernanceDisplayString(row.id).text,
    type: redactGovernanceDisplayString(row.type).text,
    status: redactGovernanceDisplayString(row.status).text,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    idempotencyKey: row.idempotency_key
      ? redactGovernanceDisplayString(row.idempotency_key).text
      : undefined,
    leaseOwner: row.lease_owner
      ? redactGovernanceDisplayString(row.lease_owner).text
      : undefined,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : undefined,
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    scheduledAt: new Date(row.scheduled_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    error: row.error ? redactGovernanceDisplayString(row.error).text : undefined,
    payload: payload?.value,
    result: result?.value,
  };
}

export function projectGovernanceJobAttemptInspection(
  row: JobAttemptRow,
  includeResult: boolean,
): JobAttemptInspectionRecord {
  const result = includeResult && row.result !== null
    ? redactGovernanceStructuredValue(parseGovernanceJson(row.result))
    : undefined;

  return {
    id: redactGovernanceDisplayString(row.id).text,
    jobId: redactGovernanceDisplayString(row.job_id).text,
    attemptNumber: row.attempt_number,
    workerId: redactGovernanceDisplayString(row.worker_id).text,
    status: redactGovernanceDisplayString(row.status).text,
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at) : undefined,
    error: row.error ? redactGovernanceDisplayString(row.error).text : undefined,
    result: result?.value,
  };
}

export function projectGovernanceWorkerHeartbeatInspection(
  row: WorkerHeartbeatRow,
  includeDetails: boolean,
): WorkerHeartbeatInspectionRecord {
  const details = includeDetails && row.details !== null
    ? redactGovernanceStructuredValue(parseGovernanceJson(row.details))
    : undefined;

  return {
    workerId: redactGovernanceDisplayString(row.worker_id).text,
    workerType: redactGovernanceDisplayString(row.worker_type).text,
    status: redactGovernanceDisplayString(row.status).text,
    currentJobId: row.current_job_id
      ? redactGovernanceDisplayString(row.current_job_id).text
      : undefined,
    heartbeatAt: new Date(row.heartbeat_at),
    details: details?.value,
  };
}

export function projectGovernanceEventProcessingFailureInspection(
  row: EventProcessingFailureRow,
  includeDetails: boolean,
): EventProcessingFailureInspectionRecord {
  const details = includeDetails
    ? redactGovernanceStructuredValue(parseGovernanceJson(row.details))
    : undefined;

  return {
    id: redactGovernanceDisplayString(row.id).text,
    rawEventId: row.raw_event_id
      ? redactGovernanceDisplayString(row.raw_event_id).text
      : undefined,
    turnId: row.turn_id
      ? redactGovernanceDisplayString(row.turn_id).text
      : undefined,
    occurredAt: new Date(row.occurred_at),
    stage: redactGovernanceDisplayString(row.stage).text,
    conversationType: row.conversation_type ?? undefined,
    errorName: redactGovernanceDisplayString(row.error_name).text,
    errorMessageHash: row.error_message_hash,
    messageIdHash: row.message_id_hash ?? undefined,
    senderIdHash: row.sender_id_hash ?? undefined,
    conversationIdHash: row.conversation_id_hash ?? undefined,
    details: details?.value,
  };
}

export function projectGovernancePrivacyPreferenceInspection(
  preference: PrivacyPreferenceRecord,
): PrivacyPreferenceInspectionRecord {
  return {
    ...preference,
    canonicalUserId: redactGovernanceDisplayString(preference.canonicalUserId).text,
    preferenceType: redactGovernanceDisplayString(preference.preferenceType).text,
    state: redactGovernanceDisplayString(preference.state).text,
    reason: preference.reason
      ? redactGovernanceDisplayString(preference.reason).text
      : undefined,
    updatedBy: preference.updatedBy
      ? {
          ...preference.updatedBy,
          canonicalUserId: preference.updatedBy.canonicalUserId
            ? redactGovernanceDisplayString(preference.updatedBy.canonicalUserId).text
            : undefined,
          actorClass: redactGovernanceDisplayString(preference.updatedBy.actorClass).text,
          context: redactGovernanceDisplayString(preference.updatedBy.context).text,
        }
      : undefined,
  };
}

export function projectGovernancePrivacyPreferenceScopeInspection(
  preference: PrivacyPreferenceInspectionRecord,
): PrivacyPreferenceScopeInspectionRecord {
  return {
    preferenceType: preference.preferenceType,
    state: preference.state,
    reason: preference.reason,
    updatedBy: preference.updatedBy
      ? {
          actorClass: preference.updatedBy.actorClass,
          context: preference.updatedBy.context,
        }
      : undefined,
    createdAt: preference.createdAt,
    updatedAt: preference.updatedAt,
  };
}

export function projectGovernanceStoredContextExplanation(
  stored: StoredContextTrace,
): StoredContextExplanation {
  return {
    contextPackId: stored.contextPackId,
    turnId: stored.turnId,
    traceSource: 'stored',
    conversation: stored.conversation,
    selectedMemoryIds: stored.selectedMemoryIds,
    candidateMemoryIds: stored.candidateMemoryIds,
    rejectedMemories: stored.rejectedMemories,
    filtersApplied: stored.filtersApplied,
    injectedIdentityFields: stored.injectedIdentityFields,
    recentMessageIds: stored.recentMessageIds,
    tokenBudget: stored.tokenBudget,
    ...(stored.memorySelections === undefined
      ? {}
      : { memorySelections: stored.memorySelections }),
    memories: stored.memories,
  };
}

export function projectGovernanceExplainTurnResolution(
  row: ExplainTurnResolutionRow,
): ExplainTurnResolution {
  return {
    turnId: row.id,
    contextPackId: row.context_pack_id,
    conversationId: row.conversation_id,
    conversationType: row.conversation_type,
    groupId: row.group_id,
    senderId: row.sender_id,
  };
}

export function projectGovernanceToolCallExplanation(
  row: ToolCallRow,
): ToolCallExplanation {
  const inspection = projectGovernanceToolCallInspection(row, false);
  return {
    id: inspection.id,
    toolName: inspection.toolName,
    requestedBy: inspection.requestedBy,
    status: inspection.status,
    errorCode: inspection.errorCode,
    errorMessage: inspection.errorMessage,
    executionTimeMs: inspection.executionTimeMs,
  };
}

export function projectGovernanceActionExecutionExplanation(
  row: ActionExecutionRow,
): ActionExecutionExplanation {
  const inspection = projectGovernanceActionExecutionInspection(row, false);
  return {
    id: inspection.id,
    actionType: inspection.actionType,
    status: inspection.status,
    effect: describeGovernanceActionExecutionEffect(inspection),
    executedMessageId: inspection.executedMessageId,
    executedMemoryId: inspection.executedMemoryId,
    executedJobId: inspection.executedJobId,
    downgradedFrom: inspection.downgradedFrom,
    downgradedReason: inspection.downgradedReason,
    errorCode: inspection.errorCode,
    errorMessage: inspection.errorMessage,
  };
}

export function projectGovernanceActionDecisionExplanation(
  row: ActionDecisionRow,
  executions: ActionExecutionExplanation[],
): ActionDecisionExplanation {
  const inspection = projectGovernanceActionDecisionInspection(row, true);
  return {
    id: inspection.id,
    decidedBy: inspection.decidedBy,
    riskLevel: inspection.riskLevel,
    actionTypes: (inspection.actions ?? []).map((action) => action.type),
    reasons: inspection.reasons,
    suppressors: inspection.suppressors,
    executions,
  };
}

export function projectGovernanceActionDecisionInspection(
  row: ActionDecisionRow,
  includeActions: boolean,
): ActionDecisionInspectionRecord {
  const rawActions = parseGovernanceJsonArray<ActionPlan>(row.actions);
  const actions = includeActions
    ? rawActions.map(
      (action) => redactGovernanceStructuredValue(action).value as ActionPlan,
    )
    : undefined;

  return {
    id: redactGovernanceDisplayString(row.id).text,
    turnId: redactGovernanceDisplayString(row.turn_id).text,
    createdAt: new Date(row.created_at),
    decidedBy: redactGovernanceDisplayString(row.decided_by).text,
    riskLevel: redactGovernanceDisplayString(row.risk_level).text,
    confidence: row.confidence,
    evaluatorRequired: Boolean(row.evaluator_required),
    evaluatorPassed: row.evaluator_passed === null
      ? undefined
      : Boolean(row.evaluator_passed),
    actionCount: rawActions.length,
    actions,
    reasons: redactGovernanceStringArray(
      parseGovernanceNullableJsonArray<string>(row.reasons),
    ),
    suppressors: redactGovernanceStringArray(
      parseGovernanceNullableJsonArray<string>(row.suppressors),
    ),
  };
}

export function projectGovernanceToolCallInspection(
  row: ToolCallRow,
  includePayload: boolean,
): ToolCallInspectionRecord {
  const input = includePayload
    ? redactGovernanceStructuredValue(parseGovernanceJson(row.input))
    : undefined;
  const output = includePayload && row.output !== null
    ? redactGovernanceStructuredValue(parseGovernanceJson(row.output))
    : undefined;

  return {
    id: redactGovernanceDisplayString(row.id).text,
    turnId: redactGovernanceDisplayString(row.turn_id).text,
    toolName: redactGovernanceDisplayString(row.tool_name).text,
    requestedBy: redactGovernanceDisplayString(row.requested_by).text,
    actor: {
      canonicalUserId: row.actor_user_id
        ? redactGovernanceDisplayString(row.actor_user_id).text
        : undefined,
      actorClass: redactGovernanceDisplayString(row.actor_class).text,
    },
    context: redactGovernanceDisplayString(row.invocation_context).text,
    status: redactGovernanceDisplayString(row.status).text,
    errorCode: row.error_code
      ? redactGovernanceDisplayString(row.error_code).text
      : undefined,
    errorMessage: row.error_message
      ? redactGovernanceDisplayString(row.error_message).text
      : undefined,
    executionTimeMs: row.execution_time_ms ?? undefined,
    secretsRedacted: Boolean(row.secrets_redacted)
      || Boolean(input?.redacted)
      || Boolean(output?.redacted),
    createdAt: new Date(row.created_at),
    input: input?.value,
    output: output?.value,
  };
}

export function describeGovernanceActionExecutionEffect(
  execution: Pick<ActionExecutionInspectionRecord, 'actionType' | 'status' | 'executedMessageId'>,
): ExplainTurnDetailExecutionEffect | undefined {
  if (execution.actionType !== 'react_only') {
    return undefined;
  }

  if (execution.status === 'success' && !execution.executedMessageId) {
    return 'true_reaction';
  }

  if (execution.status === 'downgraded') {
    return execution.executedMessageId ? 'face_message_fallback' : 'silent_reaction_fallback';
  }

  return undefined;
}

export function parseGovernanceJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseGovernanceJsonArray<T>(text: string): T[] {
  const parsed = parseGovernanceJson(text);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function parseGovernanceNullableJsonArray<T>(text: string | null): T[] {
  return text ? parseGovernanceJsonArray<T>(text) : [];
}

export function redactGovernanceStringArray(values: string[]): string[] {
  return values.map((value) => redactGovernanceDisplayString(value).text);
}

export function projectBoundedGovernanceText(
  text: string,
  maximumCodePoints: number,
): { text: string; redacted: boolean; truncated: boolean } {
  const redacted = redactGovernanceDisplayString(text);
  const codePoints = Array.from(redacted.text);
  return {
    text: codePoints.slice(0, maximumCodePoints).join(''),
    redacted: redacted.redacted,
    truncated: codePoints.length > maximumCodePoints,
  };
}

export function redactGovernanceMemoryRecordForDisplay(
  record: MemoryRecord,
): MemoryRecordInspectionRecord {
  const redactOptionalString = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : redactGovernanceDisplayString(value).text;

  return {
    ...record,
    id: redactGovernanceDisplayString(record.id).text,
    scope: redactGovernanceDisplayString(record.scope).text,
    canonicalUserId: redactOptionalString(record.canonicalUserId),
    groupId: redactOptionalString(record.groupId),
    conversationId: redactOptionalString(record.conversationId),
    subjectUserId: redactOptionalString(record.subjectUserId),
    visibility: redactGovernanceDisplayString(record.visibility).text,
    sensitivity: redactGovernanceDisplayString(record.sensitivity).text,
    authority: redactGovernanceDisplayString(record.authority).text,
    kind: redactGovernanceDisplayString(record.kind).text,
    title: redactGovernanceDisplayString(record.title).text,
    content: redactGovernanceDisplayString(record.content).text,
    state: redactGovernanceDisplayString(record.state).text,
    sourceContext: redactGovernanceDisplayString(record.sourceContext).text,
    sourceEventIds: record.sourceEventIds.map(
      (sourceEventId) => redactGovernanceDisplayString(sourceEventId).text,
    ),
    evaluatorDecisionId: redactOptionalString(record.evaluatorDecisionId),
  };
}

export function projectGovernanceMemoryExport(
  records: MemoryRecord[],
): ExportMemoryRecord[] {
  return records
    .filter((record) => record.sensitivity !== 'secret' && record.sensitivity !== 'prohibited')
    .map((record) => {
      const safeRecord = redactGovernanceMemoryRecordForDisplay(record);
      return {
        id: safeRecord.id,
        scope: safeRecord.scope,
        canonicalUserId: safeRecord.canonicalUserId,
        groupId: safeRecord.groupId,
        conversationId: safeRecord.conversationId,
        subjectUserId: safeRecord.subjectUserId,
        visibility: safeRecord.visibility,
        sensitivity: safeRecord.sensitivity,
        authority: safeRecord.authority,
        kind: safeRecord.kind,
        title: safeRecord.title,
        content: safeRecord.content,
        state: safeRecord.state,
        confidence: safeRecord.confidence,
        importance: safeRecord.importance,
        sourceContext: safeRecord.sourceContext,
        sourceEventIds: safeRecord.sourceEventIds,
        evaluatorDecisionId: safeRecord.evaluatorDecisionId,
        createdAt: safeRecord.createdAt.toISOString(),
        updatedAt: safeRecord.updatedAt.toISOString(),
        expiresAt: safeRecord.expiresAt?.toISOString(),
      };
    });
}

export function sameMemoryMaintenanceExactScope(
  left: MemoryMaintenanceProposalExactScope,
  right: MemoryMaintenanceProposalRecord['scope'],
): boolean {
  switch (left.kind) {
    case 'global':
    case 'system':
      return right.scope === left.kind;
    case 'user':
      return right.scope === 'user'
        && left.canonicalUserId === right.canonicalUserId;
    case 'group':
      return right.scope === 'group'
        && left.groupId === right.groupId;
    case 'conversation':
      return right.scope === 'conversation'
        && left.conversationId === right.conversationId
        && (left.conversationType === 'private'
          ? right.groupId === null
          : left.groupId !== undefined && left.groupId === right.groupId);
  }
}

export function redactGovernanceDisplayString(text: string): {
  text: string;
  redacted: boolean;
} {
  const initialPlatformRedacted = redactPlatformIdentifiers(text);
  const result = redactSecretsInText(initialPlatformRedacted);
  const platformRedacted = redactPlatformIdentifiers(result.text);
  const platformMarkerLost =
    initialPlatformRedacted.includes('[REDACTED:platform_id]')
    && !platformRedacted.includes('[REDACTED:platform_id]');
  const redactedText = platformMarkerLost
    ? `${platformRedacted} [REDACTED:platform_id]`
    : platformRedacted;
  return {
    text: redactedText,
    redacted: result.findings.length > 0
      || initialPlatformRedacted !== text
      || platformRedacted !== result.text
      || platformMarkerLost,
  };
}

export function redactGovernanceStructuredValue(
  value: unknown,
  path: string[] = [],
): { value: unknown; redacted: boolean } {
  if (typeof value === 'string') {
    const redacted = redactGovernanceDisplayString(value);
    return { value: redacted.text, redacted: redacted.redacted };
  }

  if (typeof value === 'number') {
    return shouldRedactNumericPlatformId(path, value)
      ? { value: '[REDACTED:platform_id]', redacted: true }
      : { value, redacted: false };
  }

  if (Array.isArray(value)) {
    let redacted = false;
    const items = value.map((item) => {
      const result = redactGovernanceStructuredValue(item, path);
      redacted = redacted || result.redacted;
      return result.value;
    });
    return { value: items, redacted };
  }

  if (value && typeof value === 'object') {
    let redacted = false;
    const objectValue = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(objectValue)) {
      const redactedKey = redactGovernanceDisplayString(key);
      const childResult = redactGovernanceStructuredValue(child, [...path, key]);
      redacted = redacted || redactedKey.redacted || childResult.redacted;
      result[redactedKey.text] = childResult.value;
    }
    return { value: result, redacted };
  }

  return { value, redacted: false };
}

export function collectGovernanceMemoryIdGroups(
  value: unknown,
  allowStringArray = false,
): string[][] {
  if (Array.isArray(value)) {
    if (allowStringArray && value.every((item) => typeof item === 'string')) {
      return [value];
    }

    return value.flatMap((item) => collectGovernanceMemoryIdGroups(item, false));
  }

  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const ownGroups = Array.isArray(objectValue.memoryIds)
      ? collectGovernanceMemoryIdGroups(objectValue.memoryIds, true)
      : [];
    const singleMemoryIdGroups = typeof objectValue.memoryId === 'string'
      ? [[objectValue.memoryId]]
      : [];
    const nestedGroups = Object.entries(objectValue)
      .filter(([key]) => key !== 'memoryIds' && key !== 'memoryId')
      .flatMap(([, child]) => collectGovernanceMemoryIdGroups(child, false));

    return [...ownGroups, ...singleMemoryIdGroups, ...nestedGroups];
  }

  return [];
}

function shouldRedactNumericPlatformId(path: string[], value: number): boolean {
  return Number.isInteger(value)
    && isPlatformIdField(path)
    && /^[1-9][0-9]{4,11}$/.test(String(Math.abs(value)));
}

function isPlatformIdField(path: string[]): boolean {
  const key = path.at(-1);
  if (!key) {
    return false;
  }

  return /(^|_)(?:target|subject|recipient|actor|owner)?[_-]?(user|sender|group|message|conversation|platform|qq)[_-]?ids?$/i.test(key)
    || /^(?:target|subject|recipient|actor|owner)?(?:User|Sender|Group|Message|Conversation|Platform|Qq)Ids?$/i.test(key)
    || /^(userId|senderId|groupId|messageId|conversationId|platformUserId|platformMessageId)$/i.test(key);
}

function redactPlatformIdentifiers(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?[1-9][0-9]{4,11}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])[1-9][0-9]{4,11}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}
