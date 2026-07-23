import type Database from 'better-sqlite3';
import { redactSecretsInText } from '../memory/secret-scan.js';
import type {
  MemoryEvaluationRequest,
  MemoryEvaluationResult,
  ToolEvaluationRequest,
  ToolEvaluationResult,
} from '../types/evaluator.js';
import { hasActiveJobAttemptAuthority } from './job-repository.js';
import { assertEvaluatorInvocationBinding } from './model-invocation-repository.js';

export interface ToolEvaluatorEvidence {
  request: ToolEvaluationRequest;
  result: ToolEvaluationResult;
}

export interface MemoryEvaluatorEvidence {
  request: MemoryEvaluationRequest;
  result: MemoryEvaluationResult;
}

interface ExtractionAuthority {
  jobId: string;
  jobAttemptId: string;
  sourceChatMessageId: string;
  sourceRawEventId: string;
  targetUserId: string;
  groupId: string | null;
  sourceContext: string;
}

const MAX_EVALUATOR_REASON_LENGTH = 2048;

export class EvaluatorDecisionRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  async createToolDecision(evidence: ToolEvaluatorEvidence): Promise<string> {
    const commit = this.db.transaction(() => {
      validateToolEvaluatorEvidence(this.db, evidence);
      assertEvaluatorInvocationBinding(this.db, evidence.request, evidence.result);

      const { request, result } = evidence;
      this.db.prepare(
        `INSERT INTO evaluator_decisions (
          id, request_id, domain, turn_id, decision, reason, confidence, risk_level,
          evaluator_version, model_invocation_id, tool_name, actor_user_id, actor_class,
          invocation_context, source_event_ids, request_created_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        result.decisionId,
        result.requestId,
        request.domain,
        request.turnId,
        result.decision,
        sanitizeEvaluatorReason(result.reason),
        result.confidence,
        result.riskLevel,
        result.evaluatorVersion,
        result.modelInvocationId ?? null,
        request.toolName,
        request.actor.canonicalUserId ?? null,
        request.actor.actorClass,
        request.context,
        JSON.stringify(request.sourceEventIds),
        request.createdAt.getTime(),
        result.decidedAt.getTime(),
      );
    });

    commit.immediate();

    return evidence.result.decisionId;
  }

  runWithMemoryDecision<T>(
    evidence: MemoryEvaluatorEvidence,
    effect: () => T,
  ): T {
    const commit = this.db.transaction(() => {
      const authority = validateMemoryEvaluatorEvidence(this.db, evidence, this.now());
      assertEvaluatorInvocationBinding(this.db, evidence.request, evidence.result);
      insertMemoryEvaluatorDecision(this.db, evidence, authority.jobAttemptId);

      const result = effect();
      if (isPromiseLike(result)) {
        throw new Error('Memory decision effect must be synchronous');
      }
      assertActiveExtractionLeaseAuthority(this.db, authority, this.now());
      if (isNonEmptyString(result)) {
        validateMemoryDecisionEffect(this.db, evidence, authority, result);
        return result;
      }
      if (result === undefined) {
        validateMemoryRejectionEffect(this.db, evidence, authority);
        return result;
      }
      throw new Error('Memory decision effect returned an unsupported result');
    });

    return commit.immediate();
  }
}

function validateMemoryEvaluatorEvidence(
  db: Database.Database,
  evidence: MemoryEvaluatorEvidence,
  now: number,
): ExtractionAuthority {
  const { request, result } = evidence;
  if (String(request.domain) !== 'memory' || String(result.domain) !== 'memory') {
    throw new Error('Evaluator evidence domain must be memory');
  }

  if (result.requestId !== request.requestId) {
    throw new Error('Evaluator result request does not match evaluator request');
  }

  const jobAttemptId = 'jobAttemptId' in request ? request.jobAttemptId : undefined;
  const turnId = 'turnId' in request ? request.turnId : undefined;
  if (!isNonEmptyString(jobAttemptId) || turnId !== undefined) {
    throw new Error('Memory evaluator decision requires a job attempt authority');
  }

  if (
    !isNonEmptyString(request.requestId)
    || !isNonEmptyString(result.decisionId)
    || !isNonEmptyString(result.evaluatorVersion)
    || typeof result.reason !== 'string'
    || typeof request.contextSummary !== 'string'
  ) {
    throw new Error('Memory evaluator evidence metadata is invalid');
  }

  if (request.actor.actorClass !== 'system_worker') {
    throw new Error('Memory evaluator actor must be system_worker');
  }
  if (request.context !== 'background_worker') {
    throw new Error('Memory evaluator invocation context must be background_worker');
  }

  validateMemoryRequest(request);
  validateMemoryResult(result);

  const requestCreatedAt = readTimestamp(request.createdAt);
  const decidedAt = readTimestamp(result.decidedAt);
  if (requestCreatedAt === null || decidedAt === null || decidedAt < requestCreatedAt) {
    throw new Error('Evaluator timestamp metadata is invalid');
  }

  const attempt = db.prepare(
    `SELECT
       job_attempts.id,
       job_attempts.job_id,
       job_attempts.status AS attempt_status,
       job_attempts.started_at,
       jobs.type AS job_type,
       jobs.status AS job_status,
       jobs.payload
     FROM job_attempts
     JOIN jobs ON jobs.id = job_attempts.job_id
     WHERE job_attempts.id = ?`
  ).get(jobAttemptId) as {
    id: string;
    job_id: string;
    attempt_status: string;
    started_at: number;
    job_type: string;
    job_status: string;
    payload: string;
  } | undefined;
  if (
    !attempt
    || attempt.job_type !== 'extraction'
    || attempt.job_status !== 'running'
    || attempt.attempt_status !== 'running'
  ) {
    throw new Error('Memory evaluator requires a running extraction job attempt');
  }
  if (!hasActiveJobAttemptAuthority(db, {
    jobId: attempt.job_id,
    attemptId: jobAttemptId,
    now,
  })) {
    throw new Error('Memory evaluator requires current running extraction lease authority');
  }
  if (requestCreatedAt < attempt.started_at || decidedAt < attempt.started_at) {
    throw new Error('Evaluator timestamp metadata predates the extraction attempt');
  }

  const payload = parseExtractionPayload(attempt.payload);
  const source = db.prepare(
    `SELECT
       chat_messages.id,
       chat_messages.raw_event_id,
       chat_messages.conversation_id,
       chat_messages.conversation_type,
       chat_messages.group_id,
       raw_events.type AS raw_event_type,
       raw_events.source AS raw_event_source,
       raw_events.platform,
       platform_accounts.canonical_user_id AS source_user_id,
       platform_accounts.status AS source_account_status
     FROM chat_messages
     JOIN raw_events ON raw_events.id = chat_messages.raw_event_id
     LEFT JOIN platform_accounts
       ON platform_accounts.platform = raw_events.platform
      AND (
        platform_accounts.platform_account_id = chat_messages.sender_id
        OR (
          substr(chat_messages.sender_id, 1, length('qq-')) = 'qq-'
          AND platform_accounts.platform_account_id =
            substr(chat_messages.sender_id, length('qq-') + 1)
        )
      )
     WHERE chat_messages.id = ?`
  ).get(payload.sourceChatMessageId) as {
    id: string;
    raw_event_id: string;
    conversation_id: string;
    conversation_type: 'private' | 'group';
    group_id: string | null;
    raw_event_type: string;
    raw_event_source: string;
    platform: string | null;
    source_user_id: string | null;
    source_account_status: string | null;
  } | undefined;
  if (!source) {
    throw new Error('Memory evaluator extraction source chat message does not exist');
  }
  if (
    source.raw_event_type !== 'chat.message.received'
    || source.raw_event_source !== 'gateway'
    || source.platform !== 'qq'
  ) {
    throw new Error('Memory evaluator extraction source is not an inbound QQ raw event');
  }
  if (
    source.source_account_status !== 'active'
    || source.source_user_id !== payload.targetUserId
  ) {
    throw new Error('Memory evaluator extraction source does not match the active target user');
  }

  if (
    request.actor.canonicalUserId !== payload.targetUserId
    || request.memoryCandidate.canonicalUserId !== payload.targetUserId
  ) {
    throw new Error('Memory evaluator actor and candidate must match the extraction target user');
  }

  if (request.sourceEventIds.length !== 1) {
    throw new Error('Memory evaluator evidence must contain exactly one raw event source');
  }
  if (request.sourceEventIds[0] !== source.raw_event_id) {
    throw new Error('Memory evaluator source must be the exact extraction raw event');
  }

  const sourceContext = source.conversation_type === 'group'
    ? 'group_chat'
    : `chat:${source.conversation_id}:${source.id}`;
  if (request.memoryCandidate.sourceContext !== sourceContext) {
    throw new Error('Memory evaluator candidate source context does not match extraction source');
  }
  if (
    source.conversation_type === 'group'
      ? !isNonEmptyString(source.group_id)
        || request.memoryCandidate.groupId !== source.group_id
      : request.memoryCandidate.groupId !== undefined
  ) {
    throw new Error('Memory evaluator candidate group does not match extraction source');
  }

  return {
    jobId: attempt.job_id,
    jobAttemptId,
    sourceChatMessageId: source.id,
    sourceRawEventId: source.raw_event_id,
    targetUserId: payload.targetUserId,
    groupId: source.group_id,
    sourceContext,
  };
}

function assertActiveExtractionLeaseAuthority(
  db: Database.Database,
  authority: ExtractionAuthority,
  now: number,
): void {
  if (!hasActiveJobAttemptAuthority(db, {
    jobId: authority.jobId,
    attemptId: authority.jobAttemptId,
    now,
  })) {
    throw new Error('Memory evaluator requires current running extraction lease authority');
  }
}

function validateMemoryRequest(request: MemoryEvaluationRequest): void {
  const candidate = request.memoryCandidate;
  if (candidate.scope !== 'user') {
    throw new Error('Memory evaluator extraction candidate must use user scope');
  }
  if (
    !isNonEmptyString(candidate.canonicalUserId)
    || !isNonEmptyString(candidate.title)
    || !isNonEmptyString(candidate.content)
    || !isNonEmptyString(candidate.sourceContext)
    || !['preference', 'fact', 'constraint', 'summary', 'reflection', 'procedure']
      .includes(String(candidate.kind))
  ) {
    throw new Error('Memory evaluator candidate metadata is invalid');
  }
  if (
    !Number.isFinite(candidate.confidence)
    || candidate.confidence < 0
    || candidate.confidence > 1
  ) {
    throw new Error('Memory evaluator candidate confidence is invalid');
  }
  if (!['low', 'medium', 'high'].includes(String(request.initialRiskLevel))) {
    throw new Error('Memory evaluator initial risk metadata is invalid');
  }
  if (
    !Array.isArray(request.sourceEventIds)
    || !request.sourceEventIds.every(isNonEmptyString)
  ) {
    throw new Error('Memory evaluator source event metadata is invalid');
  }
}

function validateMemoryResult(result: MemoryEvaluationResult): void {
  if (!['approve', 'reject', 'downgrade', 'propose'].includes(String(result.decision))) {
    throw new Error('Memory evaluator decision metadata is invalid');
  }
  if (!['low', 'medium', 'high', 'prohibited'].includes(String(result.riskLevel))) {
    throw new Error('Memory evaluator risk metadata is invalid');
  }
  if (
    !Number.isFinite(result.confidence)
    || result.confidence < 0
    || result.confidence > 1
  ) {
    throw new Error('Evaluator confidence is invalid');
  }
  if (
    result.recommendedState !== undefined
    && !['active', 'proposed'].includes(String(result.recommendedState))
  ) {
    throw new Error('Memory evaluator recommended state is invalid');
  }
  if (
    result.recommendedVisibility !== undefined
    && ![
      'private_only',
      'same_user_any_context',
      'same_group_only',
      'owner_admin_only',
      'public',
    ].includes(String(result.recommendedVisibility))
  ) {
    throw new Error('Memory evaluator recommended visibility is invalid');
  }
  if (
    result.recommendedSensitivity !== undefined
    && !['normal', 'personal', 'sensitive', 'secret', 'prohibited']
      .includes(String(result.recommendedSensitivity))
  ) {
    throw new Error('Memory evaluator recommended sensitivity is invalid');
  }
  if (
    result.conflictResolution !== undefined
    && !['supersede', 'merge', 'reject'].includes(String(result.conflictResolution))
  ) {
    throw new Error('Memory evaluator conflict resolution is invalid');
  }
}

function parseExtractionPayload(value: string): {
  sourceChatMessageId: string;
  targetUserId: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Memory evaluator extraction job payload is invalid');
  }
  if (!isRecord(parsed)) {
    throw new Error('Memory evaluator extraction job payload is invalid');
  }
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 2
    || keys[0] !== 'sourceChatMessageId'
    || keys[1] !== 'targetUserId'
    || !isNonEmptyString(parsed.sourceChatMessageId)
    || !isNonEmptyString(parsed.targetUserId)
  ) {
    throw new Error('Memory evaluator extraction job payload is invalid');
  }
  return {
    sourceChatMessageId: parsed.sourceChatMessageId,
    targetUserId: parsed.targetUserId,
  };
}

function insertMemoryEvaluatorDecision(
  db: Database.Database,
  evidence: MemoryEvaluatorEvidence,
  jobAttemptId: string,
): void {
  const { request, result } = evidence;
  db.prepare(
    `INSERT INTO evaluator_decisions (
      id, request_id, domain, turn_id, job_attempt_id,
      decision, reason, confidence, risk_level,
      evaluator_version, model_invocation_id, tool_name, actor_user_id, actor_class,
      invocation_context, source_event_ids, request_created_at, decided_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
  ).run(
    result.decisionId,
    result.requestId,
    request.domain,
    jobAttemptId,
    result.decision,
    sanitizeEvaluatorReason(result.reason),
    result.confidence,
    result.riskLevel,
    result.evaluatorVersion,
    result.modelInvocationId ?? null,
    request.actor.canonicalUserId ?? null,
    request.actor.actorClass,
    request.context,
    JSON.stringify(request.sourceEventIds),
    request.createdAt.getTime(),
    result.decidedAt.getTime(),
  );
}

function validateMemoryDecisionEffect(
  db: Database.Database,
  evidence: MemoryEvaluatorEvidence,
  authority: ExtractionAuthority,
  memoryId: string,
): void {
  const candidate = evidence.request.memoryCandidate;
  const memory = db.prepare(
    `SELECT scope, canonical_user_id, group_id, kind, title, content,
            confidence, source_context, evaluator_decision_id
       FROM memory_records WHERE id = ?`
  ).get(memoryId) as {
    scope: string;
    canonical_user_id: string | null;
    group_id: string | null;
    kind: string;
    title: string;
    content: string;
    confidence: number;
    source_context: string | null;
    evaluator_decision_id: string | null;
  } | undefined;
  if (
    !memory
    || memory.scope !== candidate.scope
    || memory.canonical_user_id !== authority.targetUserId
    || memory.group_id !== authority.groupId
    || memory.kind !== candidate.kind
    || memory.title !== candidate.title
    || memory.content !== candidate.content
    || memory.confidence !== candidate.confidence
    || memory.source_context !== authority.sourceContext
    || memory.evaluator_decision_id !== evidence.result.decisionId
  ) {
    throw new Error('Memory decision effect does not match evaluator candidate');
  }

  const linkedSourceCount = db.prepare(
    `SELECT COUNT(*) AS count
       FROM memory_sources
       JOIN chat_messages
         ON chat_messages.id = memory_sources.chat_message_id
      WHERE memory_sources.memory_id = ?
        AND memory_sources.source_type = 'chat_message'
        AND memory_sources.source_id = ?
        AND memory_sources.chat_message_id = ?
        AND chat_messages.raw_event_id = ?`
  ).pluck().get(
    memoryId,
    authority.sourceChatMessageId,
    authority.sourceChatMessageId,
    authority.sourceRawEventId,
  ) as number;
  if (linkedSourceCount !== 1) {
    throw new Error('Memory decision effect does not preserve the exact extraction source');
  }

  const revisionCount = db.prepare(
    `SELECT COUNT(*) AS count
       FROM memory_revisions
      WHERE memory_id = ?
        AND revision_number = 1
        AND change_type = 'create'
        AND evaluator_decision_id = ?`
  ).pluck().get(memoryId, evidence.result.decisionId) as number;
  const auditCount = db.prepare(
    `SELECT COUNT(*) AS count
       FROM audit_log
      WHERE category = 'memory'
        AND event_type = 'memory.create'
        AND event_id = ?
        AND evaluator_decision_id = ?`
  ).pluck().get(memoryId, evidence.result.decisionId) as number;
  if (revisionCount !== 1 || auditCount !== 1) {
    throw new Error('Memory decision effect is missing evaluator-linked revision or audit evidence');
  }
}

function validateMemoryRejectionEffect(
  db: Database.Database,
  evidence: MemoryEvaluatorEvidence,
  authority: ExtractionAuthority,
): void {
  const rows = db.prepare(
    `SELECT actor_user_id, actor_class, invocation_context, details,
            risk_level, evaluator_decision_id
       FROM audit_log
      WHERE category = 'memory'
        AND event_type = 'memory.candidate_rejected'
        AND evaluator_decision_id = ?`
  ).all(evidence.result.decisionId) as Array<{
    actor_user_id: string | null;
    actor_class: string;
    invocation_context: string;
    details: string | null;
    risk_level: string | null;
    evaluator_decision_id: string | null;
  }>;
  if (rows.length !== 1) {
    throw new Error('Memory rejection effect must create exactly one evaluator-linked audit');
  }

  const row = rows[0];
  if (!row) {
    throw new Error('Memory rejection effect must create exactly one evaluator-linked audit');
  }
  const details = parseAuditDetails(row.details);
  if (
    row.actor_user_id !== authority.targetUserId
    || row.actor_class !== 'system_worker'
    || row.invocation_context !== 'background_worker'
    || row.risk_level !== 'prohibited'
    || row.evaluator_decision_id !== evidence.result.decisionId
    || details.requestId !== evidence.request.requestId
    || details.sourceContext !== redactEvaluatorText(authority.sourceContext)
    || !Array.isArray(details.sourceIds)
    || details.sourceIds.length !== 1
    || details.sourceIds[0] !== redactEvaluatorText(authority.sourceChatMessageId)
  ) {
    throw new Error('Memory rejection effect audit does not match evaluator evidence');
  }
}

function parseAuditDetails(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function validateToolEvaluatorEvidence(
  db: Database.Database,
  evidence: ToolEvaluatorEvidence,
): void {
  if (String(evidence.request.domain) !== 'tool' || String(evidence.result.domain) !== 'tool') {
    throw new Error('Evaluator evidence domain must be tool');
  }

  if (evidence.result.requestId !== evidence.request.requestId) {
    throw new Error('Evaluator result request does not match evaluator request');
  }

  if (
    !isNonEmptyString(evidence.request.requestId)
    || !isNonEmptyString(evidence.result.decisionId)
    || !isNonEmptyString(evidence.request.turnId)
    || !isNonEmptyString(evidence.request.toolName)
    || !isNonEmptyString(evidence.result.evaluatorVersion)
    || typeof evidence.result.reason !== 'string'
  ) {
    throw new Error('Evaluator evidence metadata is invalid');
  }

  if (
    !Number.isFinite(evidence.result.confidence)
    || evidence.result.confidence < 0
    || evidence.result.confidence > 1
  ) {
    throw new Error('Evaluator confidence is invalid');
  }

  validateFiniteConstraints(evidence.result);

  const requestCreatedAt = readTimestamp(evidence.request.createdAt);
  const decidedAt = readTimestamp(evidence.result.decidedAt);
  if (requestCreatedAt === null || decidedAt === null || decidedAt < requestCreatedAt) {
    throw new Error('Evaluator timestamp metadata is invalid');
  }

  const turn = db.prepare('SELECT trigger_event_id FROM agent_turns WHERE id = ?')
    .get(evidence.request.turnId) as { trigger_event_id: string } | undefined;
  if (!turn) {
    throw new Error('Evaluator request turn does not exist');
  }

  const sourceEventIds = evidence.request.sourceEventIds;
  if (
    !Array.isArray(sourceEventIds)
    || !sourceEventIds.every(isNonEmptyString)
    || !sourceEventIds.includes(turn.trigger_event_id)
  ) {
    throw new Error('Evaluator source events must include the turn trigger event');
  }

  const sourceExists = db.prepare('SELECT 1 FROM raw_events WHERE id = ?');
  for (const sourceEventId of sourceEventIds) {
    if (!sourceExists.get(sourceEventId)) {
      throw new Error('Evaluator source event does not exist');
    }
  }
}

function validateFiniteConstraints(result: ToolEvaluationResult): void {
  const constraints = result.additionalConstraints;
  if (!constraints) {
    return;
  }

  for (const value of [constraints.maxRuntimeMs, constraints.maxOutputBytes]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error('Evaluator constraint metadata is invalid');
    }
  }
}

function readTimestamp(value: Date): number | null {
  if (!(value instanceof Date)) {
    return null;
  }

  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sanitizeEvaluatorReason(text: string): string {
  const redacted = redactEvaluatorText(text);

  if (redacted.length <= MAX_EVALUATOR_REASON_LENGTH) {
    return redacted;
  }

  const marker = ' [TRUNCATED]';
  return `${redacted.slice(0, MAX_EVALUATOR_REASON_LENGTH - marker.length)}${marker}`;
}

function redactEvaluatorText(text: string): string {
  const platformRedacted = redactPlatformIdentifiers(text);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const fullyRedacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost = platformRedacted.includes('[REDACTED:platform_id]')
    && !fullyRedacted.includes('[REDACTED:platform_id]');
  return platformMarkerLost
    ? `${fullyRedacted} [REDACTED:platform_id]`
    : fullyRedacted;
}

function redactPlatformIdentifiers(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === 'function';
}
