import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import { redactSecretsInText } from '../memory/secret-scan.js';
import type { ContextPack } from '../types/context.js';
import type { EvaluatorRequest, EvaluatorResult } from '../types/evaluator.js';
import { hasActiveJobAttemptAuthority } from './job-repository.js';

export type ModelInvocationPurpose = 'summary' | 'evaluator';
export type ModelInvocationStatus = 'running' | 'completed' | 'failed' | 'aborted';
export type ModelInvocationFailureStatus = 'failed' | 'aborted';
export type EvaluatorInvocationDomain = 'tool' | 'memory' | 'social';

export interface ModelInvocationTokens {
  input: number;
  output: number;
  total: number;
}

export interface StartModelInvocationInput {
  id?: string;
  contextId: string;
  jobAttemptId: string;
  purpose: 'summary';
  callNumber: number;
  provider: string;
  model: string;
  rawEventIds: string[];
  startedAt?: number;
}

export interface StartEvaluatorInvocationInput {
  id?: string;
  requestId: string;
  domain: EvaluatorInvocationDomain;
  turnId?: string;
  jobAttemptId?: string;
  /** Defaults to the original attempt for existing evaluator callers. */
  callNumber?: 1 | 2;
  provider: string;
  model: string;
  promptVersion: string;
  rawEventIds: string[];
  startedAt?: number;
}

export interface StoredModelContext {
  id: string;
  jobAttemptId: string;
  purpose: 'summary';
  conversationRef: string;
  conversationType: ContextPack['conversation']['conversationType'];
  groupRef?: string;
  candidateMemoryIds: string[];
  selectedMemoryIds: string[];
  rejectedMemories: Array<{ memoryId: string; reason: string }>;
  filtersApplied: string[];
  injectedIdentityFields: string[];
  recentMessageIds: string[];
  tokenBudget: ContextPack['tokenBudget'];
  memories: Array<{
    memoryId: string;
    scope: string;
    kind?: NonNullable<ContextPack['memory']['retrievedFacts'][number]['kind']>;
    title: string;
    confidence: number;
    sourceContext?: string;
  }>;
  createdAt: Date;
}

export interface ModelInvocationRecord {
  id: string;
  turnId?: string;
  jobAttemptId?: string;
  contextId?: string;
  purpose: ModelInvocationPurpose;
  callNumber: number;
  evaluatorRequestId?: string;
  evaluatorDomain?: EvaluatorInvocationDomain;
  promptVersion?: string;
  provider: string;
  model: string;
  status: ModelInvocationStatus;
  startedAt: Date;
  completedAt?: Date;
  tokens?: ModelInvocationTokens;
  responseSha256?: string;
  responseBytes?: number;
  errorCode?: string;
}

interface ModelContextRow {
  id: string;
  job_attempt_id: string;
  purpose: 'summary';
  conversation_ref: string;
  conversation_type: ContextPack['conversation']['conversationType'];
  group_ref: string | null;
  candidate_memory_ids: string;
  selected_memory_ids: string;
  rejected_memories: string;
  filters_applied: string;
  injected_identity_fields: string;
  recent_message_ids: string;
  token_budget: string;
  memories: string;
  created_at: number;
}

interface ModelInvocationRow {
  id: string;
  turn_id: string | null;
  job_attempt_id: string | null;
  context_id: string | null;
  purpose: ModelInvocationPurpose;
  call_number: number;
  evaluator_request_id: string | null;
  evaluator_domain: EvaluatorInvocationDomain | null;
  prompt_version: string | null;
  provider: string;
  model: string;
  status: ModelInvocationStatus;
  started_at: number;
  completed_at: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
  response_sha256: string | null;
  response_bytes: number | null;
  error_code: string | null;
}

interface PreparedContextTrace {
  conversationRef: string;
  conversationType: ContextPack['conversation']['conversationType'];
  groupRef: string | null;
  candidateMemoryIds: string;
  selectedMemoryIds: string;
  rejectedMemories: string;
  filtersApplied: string;
  injectedIdentityFields: string;
  recentMessageIds: string;
  tokenBudget: string;
  memories: string;
  createdAt: number;
}

const MAX_ID_LENGTH = 512;
const MAX_PROVIDER_LENGTH = 128;
const MAX_MODEL_LENGTH = 256;
const MAX_PROMPT_VERSION_LENGTH = 256;
const MAX_ERROR_CODE_LENGTH = 256;
const MAX_TRACE_TEXT_LENGTH = 512;
const MAX_TRACE_NAME_LENGTH = 256;

interface EvaluatorInvocationAuthorityInput {
  turnId?: string;
  jobAttemptId?: string;
}

interface RunningInvocationOwner {
  purpose: ModelInvocationPurpose;
  turnId: string | null;
  jobAttemptId: string | null;
}

interface EvaluatorInvocationBindingRow {
  id: string;
  turn_id: string | null;
  job_attempt_id: string | null;
  context_id: string | null;
  purpose: ModelInvocationPurpose;
  call_number: number;
  evaluator_request_id: string | null;
  evaluator_domain: EvaluatorInvocationDomain | null;
  prompt_version: string | null;
  provider: string;
  model: string;
  status: ModelInvocationStatus;
  started_at: number;
  completed_at: number | null;
}

interface EvaluatorCorrectionPredecessorRow {
  turn_id: string | null;
  job_attempt_id: string | null;
  evaluator_domain: EvaluatorInvocationDomain;
  prompt_version: string;
  provider: string;
  model: string;
  status: ModelInvocationStatus;
  started_at: number;
  completed_at: number | null;
  error_code: string | null;
}

export class ModelInvocationRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  createContext(
    context: ContextPack,
    jobAttemptId: string,
    purpose: 'summary',
  ): string {
    assertSummaryPurpose(purpose);
    assertIdentifier(context.id, 'Context id');
    assertIdentifier(jobAttemptId, 'Job attempt id');
    const trace = prepareContextTrace(context);

    const insert = this.db.transaction(() => {
      const result = this.db.prepare(
        `INSERT INTO model_contexts (
          id, job_attempt_id, purpose,
          conversation_ref, conversation_type, group_ref,
          candidate_memory_ids, selected_memory_ids, rejected_memories,
          filters_applied, injected_identity_fields, recent_message_ids,
          token_budget, memories, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM job_attempts
        WHERE id = ? AND status = 'running'`,
      ).run(
        context.id,
        jobAttemptId,
        purpose,
        trace.conversationRef,
        trace.conversationType,
        trace.groupRef,
        trace.candidateMemoryIds,
        trace.selectedMemoryIds,
        trace.rejectedMemories,
        trace.filtersApplied,
        trace.injectedIdentityFields,
        trace.recentMessageIds,
        trace.tokenBudget,
        trace.memories,
        trace.createdAt,
        jobAttemptId,
      );

      if (result.changes !== 1) {
        throw new Error('Job attempt is not running');
      }
    });

    insert();
    return context.id;
  }

  startInvocation(input: StartModelInvocationInput): string {
    assertSummaryPurpose(input.purpose);
    const id = input.id ?? ulid();
    assertIdentifier(id, 'Invocation id');
    assertIdentifier(input.contextId, 'Context id');
    assertIdentifier(input.jobAttemptId, 'Job attempt id');
    assertPositiveInteger(input.callNumber, 'Call number');
    const startedAt = input.startedAt ?? this.now();
    assertTimestamp(startedAt, 'Started timestamp');
    const provider = sanitizeBoundedMetadata(
      input.provider,
      MAX_PROVIDER_LENGTH,
      'Provider',
    );
    const model = sanitizeBoundedMetadata(input.model, MAX_MODEL_LENGTH, 'Model');
    const rawEventIds = validateSourceEventIds(input.rawEventIds);

    const insert = this.db.transaction(() => {
      const contextOwnership = this.db.prepare(
        `SELECT mc.recent_message_ids
         FROM model_contexts mc
         JOIN job_attempts ja ON ja.id = mc.job_attempt_id
         WHERE mc.id = ?
           AND mc.job_attempt_id = ?
           AND mc.purpose = ?
           AND ja.status = 'running'`,
      ).get(input.contextId, input.jobAttemptId, input.purpose) as
        | { recent_message_ids: string }
        | undefined;
      if (!contextOwnership) {
        throw new Error('Context does not belong to the running attempt');
      }
      const expectedRawEventIds = deriveContextSourceEventIds(
        this.db,
        contextOwnership.recent_message_ids,
      );
      if (!arraysEqual(expectedRawEventIds, rawEventIds)) {
        throw new Error('Invocation sources do not exactly match context messages');
      }

      this.db.prepare(
        `INSERT INTO model_invocations (
          id, job_attempt_id, context_id, purpose, call_number,
          provider, model, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      ).run(
        id,
        input.jobAttemptId,
        input.contextId,
        input.purpose,
        input.callNumber,
        provider,
        model,
        startedAt,
      );

      const insertSource = this.db.prepare(
        `INSERT INTO model_invocation_sources (
          model_invocation_id, raw_event_id, source_ordinal
        ) VALUES (?, ?, ?)`,
      );
      rawEventIds.forEach((rawEventId, index) => {
        insertSource.run(id, rawEventId, index);
      });
    });

    insert();
    return id;
  }

  startEvaluatorInvocation(input: StartEvaluatorInvocationInput): string {
    const id = input.id ?? ulid();
    assertIdentifier(id, 'Invocation id');
    assertIdentifier(input.requestId, 'Evaluator request id');
    assertEvaluatorDomain(input.domain);
    const authority = readEvaluatorAuthorityInput(input);
    if (input.startedAt !== undefined) {
      assertTimestamp(input.startedAt, 'Started timestamp');
    }
    const provider = validateEvaluatorIdentityMetadata(
      input.provider,
      MAX_PROVIDER_LENGTH,
      'Provider',
    );
    const model = validateEvaluatorIdentityMetadata(input.model, MAX_MODEL_LENGTH, 'Model');
    const promptVersion = validateEvaluatorIdentityMetadata(
      input.promptVersion,
      MAX_PROMPT_VERSION_LENGTH,
      'Prompt version',
    );
    const rawEventIds = validateSourceEventIds(input.rawEventIds);
    const callNumber = readEvaluatorCallNumber(input.callNumber);

    const insert = this.db.transaction(() => {
      const authorityNow = this.now();
      assertTimestamp(authorityNow, 'Current timestamp');
      const startedAt = input.startedAt ?? authorityNow;
      assertEvaluatorOwnerCanStart(
        this.db,
        authority,
        input.domain,
        rawEventIds,
        authorityNow,
      );
      assertRawEventsExist(this.db, rawEventIds);
      assertEvaluatorCorrectionPredecessor(this.db, {
        requestId: input.requestId,
        domain: input.domain,
        authority,
        callNumber,
        provider,
        model,
        promptVersion,
        rawEventIds,
        startedAt,
      });

      this.db.prepare(
        `INSERT INTO model_invocations (
          id, turn_id, job_attempt_id, context_id, purpose, call_number,
          evaluator_request_id, evaluator_domain, prompt_version,
          provider, model, status, started_at
        ) VALUES (?, ?, ?, NULL, 'evaluator', ?, ?, ?, ?, ?, ?, 'running', ?)`,
      ).run(
        id,
        authority.turnId ?? null,
        authority.jobAttemptId ?? null,
        callNumber,
        input.requestId,
        input.domain,
        promptVersion,
        provider,
        model,
        startedAt,
      );

      const insertSource = this.db.prepare(
        `INSERT INTO model_invocation_sources (
          model_invocation_id, raw_event_id, source_ordinal
        ) VALUES (?, ?, ?)`,
      );
      rawEventIds.forEach((rawEventId, index) => {
        insertSource.run(id, rawEventId, index);
      });
    });

    insert.immediate();
    return id;
  }

  completeInvocation(
    id: string,
    tokens: ModelInvocationTokens,
    responseText: string,
  ): void {
    assertIdentifier(id, 'Invocation id');
    validateTokens(tokens);
    if (typeof responseText !== 'string') {
      throw new Error('Response text is invalid');
    }

    const responseSha256 = createHash('sha256').update(responseText, 'utf8').digest('hex');
    const responseBytes = Buffer.byteLength(responseText, 'utf8');
    const complete = this.db.transaction(() => {
      const completedAt = this.now();
      assertTimestamp(completedAt, 'Completed timestamp');
      const invocation = readRunningInvocationOwner(this.db, id);
      assertInvocationCanComplete(this.db, invocation, completedAt);
      const result = this.db.prepare(
        `UPDATE model_invocations
         SET status = 'completed', completed_at = MAX(?, started_at),
             tokens_input = ?, tokens_output = ?, tokens_total = ?,
             response_sha256 = ?, response_bytes = ?
         WHERE id = ? AND status = 'running'`,
      ).run(
        completedAt,
        tokens.input,
        tokens.output,
        tokens.total,
        responseSha256,
        responseBytes,
        id,
      );

      if (result.changes !== 1) {
        throw new Error('Invocation is not running');
      }
    });

    complete.immediate();
  }

  failInvocation(
    id: string,
    errorCode: string,
    status: ModelInvocationFailureStatus = 'failed',
  ): void {
    assertIdentifier(id, 'Invocation id');
    if (status !== 'failed' && status !== 'aborted') {
      throw new Error('Invocation failure status is invalid');
    }
    const safeErrorCode = sanitizeBoundedMetadata(
      errorCode,
      MAX_ERROR_CODE_LENGTH,
      'Error code',
    );
    const completedAt = this.now();
    assertTimestamp(completedAt, 'Completed timestamp');
    const result = this.db.prepare(
      `UPDATE model_invocations
       SET status = ?, completed_at = MAX(?, started_at), error_code = ?
       WHERE id = ?
         AND status = 'running'`,
    ).run(status, completedAt, safeErrorCode, id);

    if (result.changes !== 1) {
      throw new Error('Invocation is not running');
    }
  }

  findContextById(id: string): StoredModelContext | null {
    const row = this.db.prepare('SELECT * FROM model_contexts WHERE id = ?')
      .get(id) as ModelContextRow | undefined;
    return row ? rowToContext(row) : null;
  }

  findInvocationById(id: string): ModelInvocationRecord | null {
    const row = this.db.prepare('SELECT * FROM model_invocations WHERE id = ?')
      .get(id) as ModelInvocationRow | undefined;
    return row ? rowToInvocation(row) : null;
  }

  listInvocationsForAttempt(jobAttemptId: string): ModelInvocationRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM model_invocations
       WHERE job_attempt_id = ?
       ORDER BY call_number ASC`,
    ).all(jobAttemptId) as ModelInvocationRow[];
    return rows.map(rowToInvocation);
  }

  listSourceEventIds(invocationId: string): string[] {
    const rows = this.db.prepare(
      `SELECT raw_event_id
       FROM model_invocation_sources
       WHERE model_invocation_id = ?
       ORDER BY source_ordinal ASC`,
    ).all(invocationId) as Array<{ raw_event_id: string }>;
    return rows.map((row) => row.raw_event_id);
  }
}

export function assertEvaluatorInvocationBinding(
  db: Database.Database,
  request: EvaluatorRequest,
  result: EvaluatorResult & { domain: EvaluatorInvocationDomain },
): void {
  const invocationId = result.modelInvocationId;
  if (invocationId === undefined) {
    return;
  }
  assertIdentifier(invocationId, 'Evaluator model invocation id');

  const row = db.prepare(
    `SELECT id, turn_id, job_attempt_id, context_id, purpose, call_number,
            evaluator_request_id, evaluator_domain, prompt_version,
            provider, model, status, started_at, completed_at
       FROM model_invocations
      WHERE id = ?`,
  ).get(invocationId) as EvaluatorInvocationBindingRow | undefined;
  if (!row) {
    throw new Error('Evaluator model invocation does not exist');
  }

  const requestAuthority = readEvaluatorRequestAuthority(request);
  const requestCreatedAt = readDateTimestamp(request.createdAt);
  const decidedAt = readDateTimestamp(result.decidedAt);
  const expectedVersion = row.prompt_version === null
    ? null
    : `${row.provider}/${row.model}/${row.prompt_version}`;
  if (
    row.purpose !== 'evaluator'
    || row.status !== 'completed'
    || row.context_id !== null
    || (row.call_number !== 1 && row.call_number !== 2)
    || row.evaluator_request_id !== request.requestId
    || row.evaluator_domain !== request.domain
    || result.domain !== request.domain
    || result.requestId !== request.requestId
    || row.turn_id !== (requestAuthority.turnId ?? null)
    || row.job_attempt_id !== (requestAuthority.jobAttemptId ?? null)
    || expectedVersion !== result.evaluatorVersion
    || requestCreatedAt === null
    || decidedAt === null
    || row.completed_at === null
    || requestCreatedAt > row.started_at
    || row.started_at > row.completed_at
    || row.completed_at > decidedAt
  ) {
    throw new Error('Evaluator model invocation does not match evaluator evidence');
  }
  assertEvaluatorBindingOwnerActive(db, row);

  const sourceRows = db.prepare(
    `SELECT raw_event_id
       FROM model_invocation_sources
      WHERE model_invocation_id = ?
      ORDER BY source_ordinal ASC`,
  ).all(invocationId) as Array<{ raw_event_id: string }>;
  const sourceEventIds = Array.isArray(request.sourceEventIds)
    ? request.sourceEventIds
    : [];
  if (!arraysEqual(sourceRows.map((source) => source.raw_event_id), sourceEventIds)) {
    throw new Error('Evaluator model invocation sources do not match evaluator evidence');
  }
  assertEvaluatorCorrectionPredecessor(db, {
    requestId: request.requestId,
    domain: request.domain,
    authority: requestAuthority,
    callNumber: row.call_number,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version ?? '',
    rawEventIds: sourceEventIds,
    startedAt: row.started_at,
    requestCreatedAt,
  }, 'Evaluator model invocation does not match evaluator evidence');

  const existingDecision = db.prepare(
    'SELECT id FROM evaluator_decisions WHERE model_invocation_id = ?',
  ).get(invocationId);
  if (existingDecision) {
    throw new Error('Evaluator model invocation is already linked to a decision');
  }
}

function readEvaluatorCallNumber(value: StartEvaluatorInvocationInput['callNumber']): 1 | 2 {
  const callNumber = value ?? 1;
  if (callNumber !== 1 && callNumber !== 2) {
    throw new Error('Evaluator call number must be 1 or 2');
  }
  return callNumber;
}

function assertEvaluatorCorrectionPredecessor(
  db: Database.Database,
  input: {
    requestId: string;
    domain: EvaluatorInvocationDomain;
    authority: EvaluatorInvocationAuthorityInput;
    callNumber: number;
    provider: string;
    model: string;
    promptVersion: string;
    rawEventIds: string[];
    startedAt: number;
    requestCreatedAt?: number;
  },
  failureMessage = 'Evaluator correction requires matching invalid structured output',
): void {
  if (input.callNumber === 1) {
    return;
  }
  if (input.callNumber !== 2) {
    throw new Error('Evaluator call number must be 1 or 2');
  }

  const predecessor = db.prepare(
    `SELECT turn_id, job_attempt_id, evaluator_domain, prompt_version,
            provider, model, status, started_at, completed_at, error_code
       FROM model_invocations
      WHERE purpose = 'evaluator'
        AND evaluator_request_id = ?
        AND call_number = 1`,
  ).get(input.requestId) as EvaluatorCorrectionPredecessorRow | undefined;
  if (
    !predecessor
    || predecessor.turn_id !== (input.authority.turnId ?? null)
    || predecessor.job_attempt_id !== (input.authority.jobAttemptId ?? null)
    || predecessor.evaluator_domain !== input.domain
    || predecessor.prompt_version !== input.promptVersion
    || predecessor.provider !== input.provider
    || predecessor.model !== input.model
    || predecessor.status !== 'failed'
    || predecessor.error_code !== 'invalid_structured_output'
    || (
      input.requestCreatedAt !== undefined
      && input.requestCreatedAt > predecessor.started_at
    )
    || predecessor.completed_at === null
    || predecessor.completed_at > input.startedAt
  ) {
    throw new Error(failureMessage);
  }

  const sourceRows = db.prepare(
    `SELECT raw_event_id
       FROM model_invocation_sources
      WHERE model_invocation_id = (
        SELECT id FROM model_invocations
        WHERE purpose = 'evaluator'
          AND evaluator_request_id = ?
          AND call_number = 1
      )
      ORDER BY source_ordinal ASC`,
  ).all(input.requestId) as Array<{ raw_event_id: string }>;
  if (!arraysEqual(sourceRows.map((source) => source.raw_event_id), input.rawEventIds)) {
    throw new Error(failureMessage);
  }
}

function readEvaluatorAuthorityInput(
  input: Pick<StartEvaluatorInvocationInput, 'turnId' | 'jobAttemptId'>,
): EvaluatorInvocationAuthorityInput {
  const turnId = input.turnId === undefined
    ? undefined
    : assertIdentifier(input.turnId, 'Evaluator turn id');
  const jobAttemptId = input.jobAttemptId === undefined
    ? undefined
    : assertIdentifier(input.jobAttemptId, 'Evaluator job attempt id');
  if ((turnId === undefined) === (jobAttemptId === undefined)) {
    throw new Error('Evaluator invocation requires exactly one owner');
  }
  return { turnId, jobAttemptId };
}

function readEvaluatorRequestAuthority(request: EvaluatorRequest): EvaluatorInvocationAuthorityInput {
  return readEvaluatorAuthorityInput({
    turnId: 'turnId' in request ? request.turnId : undefined,
    jobAttemptId: 'jobAttemptId' in request ? request.jobAttemptId : undefined,
  });
}

function assertEvaluatorOwnerCanStart(
  db: Database.Database,
  authority: EvaluatorInvocationAuthorityInput,
  domain: EvaluatorInvocationDomain,
  rawEventIds: string[],
  now: number,
): void {
  if (authority.turnId !== undefined) {
    const turn = db.prepare(
      'SELECT trigger_event_id, status FROM agent_turns WHERE id = ?',
    ).get(authority.turnId) as { trigger_event_id: string; status: string } | undefined;
    if (!turn || turn.status !== 'running' || !rawEventIds.includes(turn.trigger_event_id)) {
      throw new Error('Evaluator invocation requires a running source-bound turn');
    }
    return;
  }

  if (domain !== 'memory' || authority.jobAttemptId === undefined) {
    throw new Error('Only memory evaluator invocations may use job-attempt authority');
  }
  const attempt = db.prepare(
    `SELECT job_attempts.job_id, jobs.type
       FROM job_attempts
       JOIN jobs ON jobs.id = job_attempts.job_id
      WHERE job_attempts.id = ?`,
  ).get(authority.jobAttemptId) as { job_id: string; type: string } | undefined;
  if (
    !attempt
    || attempt.type !== 'extraction'
    || !hasActiveJobAttemptAuthority(db, {
      jobId: attempt.job_id,
      attemptId: authority.jobAttemptId,
      now,
    })
  ) {
    throw new Error('Evaluator invocation requires an active extraction job attempt');
  }
}

function assertEvaluatorBindingOwnerActive(
  db: Database.Database,
  invocation: EvaluatorInvocationBindingRow,
): void {
  if (invocation.turn_id !== null) {
    const runningTurn = db.prepare(
      "SELECT 1 FROM agent_turns WHERE id = ? AND status = 'running'",
    ).get(invocation.turn_id);
    if (!runningTurn) {
      throw new Error('Evaluator model invocation owner is no longer active');
    }
    return;
  }

  if (invocation.job_attempt_id === null) {
    throw new Error('Evaluator model invocation owner is no longer active');
  }
  const attempt = db.prepare(
    'SELECT job_id FROM job_attempts WHERE id = ?',
  ).get(invocation.job_attempt_id) as { job_id: string } | undefined;
  if (
    !attempt
    || !hasActiveJobAttemptAuthority(db, {
      jobId: attempt.job_id,
      attemptId: invocation.job_attempt_id,
      now: Date.now(),
    })
  ) {
    throw new Error('Evaluator model invocation owner is no longer active');
  }
}

function assertRawEventsExist(db: Database.Database, rawEventIds: string[]): void {
  const sourceExists = db.prepare('SELECT 1 FROM raw_events WHERE id = ?');
  for (const rawEventId of rawEventIds) {
    if (!sourceExists.get(rawEventId)) {
      throw new Error('Evaluator invocation source event does not exist');
    }
  }
}

function readRunningInvocationOwner(
  db: Database.Database,
  invocationId: string,
): RunningInvocationOwner {
  const row = db.prepare(
    `SELECT purpose, turn_id, job_attempt_id
       FROM model_invocations
      WHERE id = ? AND status = 'running'`,
  ).get(invocationId) as {
    purpose: ModelInvocationPurpose;
    turn_id: string | null;
    job_attempt_id: string | null;
  } | undefined;
  if (!row) {
    throw new Error('Invocation is not running');
  }
  return {
    purpose: row.purpose,
    turnId: row.turn_id,
    jobAttemptId: row.job_attempt_id,
  };
}

function assertInvocationCanComplete(
  db: Database.Database,
  invocation: RunningInvocationOwner,
  now: number,
): void {
  if (invocation.purpose === 'summary') {
    const runningAttempt = invocation.jobAttemptId === null
      ? undefined
      : db.prepare("SELECT 1 FROM job_attempts WHERE id = ? AND status = 'running'")
        .get(invocation.jobAttemptId);
    if (!runningAttempt) {
      throw new Error('Invocation is not running');
    }
    return;
  }

  if (invocation.turnId !== null) {
    const runningTurn = db.prepare(
      "SELECT 1 FROM agent_turns WHERE id = ? AND status = 'running'",
    ).get(invocation.turnId);
    if (!runningTurn) {
      throw new Error('Invocation is not running');
    }
    return;
  }

  if (invocation.jobAttemptId === null) {
    throw new Error('Invocation is not running');
  }
  const attempt = db.prepare(
    'SELECT job_id FROM job_attempts WHERE id = ?',
  ).get(invocation.jobAttemptId) as { job_id: string } | undefined;
  if (
    !attempt
    || !hasActiveJobAttemptAuthority(db, {
      jobId: attempt.job_id,
      attemptId: invocation.jobAttemptId,
      now,
    })
  ) {
    throw new Error('Invocation is not running');
  }
}

function readDateTimestamp(value: Date): number | null {
  if (!(value instanceof Date)) {
    return null;
  }
  const timestamp = value.getTime();
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function prepareContextTrace(context: ContextPack): PreparedContextTrace {
  if (!context || typeof context !== 'object') {
    throw new Error('Context is invalid');
  }
  const createdAt = context.createdAt instanceof Date ? context.createdAt.getTime() : Number.NaN;
  assertTimestamp(createdAt, 'Context timestamp');
  const conversationId = assertIdentifier(
    context.conversation?.conversationId,
    'Conversation reference',
  );
  const conversationType = context.conversation?.conversationType;
  if (conversationType !== 'private' && conversationType !== 'group') {
    throw new Error('Conversation type is invalid');
  }
  const groupId = context.conversation.groupId;
  if (groupId !== undefined) {
    assertIdentifier(groupId, 'Group reference');
  }

  const trace = context.trace;
  const selectedMemoryIds = validateIdentifierArray(
    context.memory?.selectedMemoryIds,
    'Selected memory ids',
  );
  const traceSelectedMemoryIds = validateIdentifierArray(
    trace?.selectedMemoryIds ?? selectedMemoryIds,
    'Trace selected memory ids',
  );
  if (!arraysEqual(selectedMemoryIds, traceSelectedMemoryIds)) {
    throw new Error('Context selected memory trace is inconsistent');
  }

  const candidateMemoryIds = validateIdentifierArray(
    trace?.candidateMemoryIds ?? [],
    'Candidate memory ids',
  );
  const rejectedMemories = (trace?.rejectedMemories ?? []).map((memory) => ({
    memoryId: assertIdentifier(memory.memoryId, 'Rejected memory id'),
    reason: sanitizeBoundedMetadata(
      memory.reason,
      MAX_TRACE_TEXT_LENGTH,
      'Rejected memory reason',
    ),
  }));
  const filtersApplied = validateTextArray(trace?.filtersApplied ?? [], 'Context filters')
    .map((value) => sanitizeBoundedMetadata(
      value,
      MAX_TRACE_TEXT_LENGTH,
      'Context filter',
    ));
  const injectedIdentityFields = validateTextArray(
    context.injectedIdentityFields,
    'Injected identity fields',
  ).map((value) => sanitizeBoundedMetadata(
    value,
    MAX_TRACE_NAME_LENGTH,
    'Injected identity field',
  ));
  const recentMessageIds = validateIdentifierArray(
    context.recentMessages?.map((message) => message.messageId),
    'Recent message ids',
  );
  const tokenBudget = sanitizeTokenBudget(context.tokenBudget);
  const memories = (context.memory?.retrievedFacts ?? []).map((memory) => {
    if (!Number.isFinite(memory.confidence)) {
      throw new Error('Memory confidence is invalid');
    }
    return {
      memoryId: assertIdentifier(memory.memoryId, 'Memory id'),
      scope: sanitizeBoundedMetadata(memory.scope, MAX_TRACE_NAME_LENGTH, 'Memory scope'),
      ...(memory.kind === undefined
        ? {}
        : {
            kind: sanitizeBoundedMetadata(
              memory.kind,
              MAX_TRACE_NAME_LENGTH,
              'Memory kind',
            ),
          }),
      title: sanitizeBoundedMetadata(memory.title, MAX_TRACE_TEXT_LENGTH, 'Memory title'),
      confidence: memory.confidence,
      ...(memory.sourceContext === undefined
        ? {}
        : {
            sourceContext: sanitizeBoundedMetadata(
              memory.sourceContext,
              MAX_TRACE_TEXT_LENGTH,
              'Memory source context',
            ),
          }),
    };
  });

  return {
    conversationRef: opaqueReference('ctxref', conversationId),
    conversationType,
    groupRef: groupId === undefined ? null : opaqueReference('groupref', groupId),
    candidateMemoryIds: JSON.stringify(candidateMemoryIds),
    selectedMemoryIds: JSON.stringify(selectedMemoryIds),
    rejectedMemories: JSON.stringify(rejectedMemories),
    filtersApplied: JSON.stringify(filtersApplied),
    injectedIdentityFields: JSON.stringify(injectedIdentityFields),
    recentMessageIds: JSON.stringify(recentMessageIds),
    tokenBudget: JSON.stringify(tokenBudget),
    memories: JSON.stringify(memories),
    createdAt,
  };
}

function sanitizeTokenBudget(tokenBudget: ContextPack['tokenBudget']): ContextPack['tokenBudget'] {
  if (!tokenBudget || typeof tokenBudget !== 'object') {
    throw new Error('Token budget is invalid');
  }
  assertNonNegativeInteger(tokenBudget.max, 'Token budget maximum');
  assertNonNegativeInteger(tokenBudget.used, 'Token budget usage');
  if (tokenBudget.used > tokenBudget.max) {
    throw new Error('Token budget usage exceeds its maximum');
  }
  const breakdown = tokenBudget.breakdown;
  if (!breakdown || typeof breakdown !== 'object') {
    throw new Error('Token budget breakdown is invalid');
  }
  assertNonNegativeInteger(breakdown.recentMessages, 'Recent-message token count');
  assertNonNegativeInteger(breakdown.memory, 'Memory token count');
  assertNonNegativeInteger(breakdown.identity, 'Identity token count');
  assertNonNegativeInteger(breakdown.system, 'System token count');

  const promptLayers = tokenBudget.promptLayers?.map((layer) => {
    assertNonNegativeInteger(layer.tokens, 'Prompt-layer token count');
    return {
      name: sanitizeBoundedMetadata(
        layer.name,
        MAX_TRACE_NAME_LENGTH,
        'Prompt-layer name',
      ),
      version: sanitizeBoundedMetadata(
        layer.version,
        MAX_TRACE_NAME_LENGTH,
        'Prompt-layer version',
      ),
      tokens: layer.tokens,
    };
  });

  return {
    max: tokenBudget.max,
    used: tokenBudget.used,
    breakdown: { ...breakdown },
    ...(promptLayers === undefined ? {} : { promptLayers }),
  };
}

function rowToContext(row: ModelContextRow): StoredModelContext {
  return {
    id: row.id,
    jobAttemptId: row.job_attempt_id,
    purpose: row.purpose,
    conversationRef: row.conversation_ref,
    conversationType: row.conversation_type,
    groupRef: row.group_ref ?? undefined,
    candidateMemoryIds: parseJson(row.candidate_memory_ids),
    selectedMemoryIds: parseJson(row.selected_memory_ids),
    rejectedMemories: parseJson(row.rejected_memories),
    filtersApplied: parseJson(row.filters_applied),
    injectedIdentityFields: parseJson(row.injected_identity_fields),
    recentMessageIds: parseJson(row.recent_message_ids),
    tokenBudget: parseJson(row.token_budget),
    memories: parseJson(row.memories),
    createdAt: new Date(row.created_at),
  };
}

function rowToInvocation(row: ModelInvocationRow): ModelInvocationRecord {
  let tokens: ModelInvocationTokens | undefined;
  if (
    row.tokens_input !== null
    && row.tokens_output !== null
    && row.tokens_total !== null
  ) {
    tokens = {
      input: row.tokens_input,
      output: row.tokens_output,
      total: row.tokens_total,
    };
  }
  return {
    id: row.id,
    turnId: row.turn_id ?? undefined,
    jobAttemptId: row.job_attempt_id ?? undefined,
    contextId: row.context_id ?? undefined,
    purpose: row.purpose,
    callNumber: row.call_number,
    evaluatorRequestId: row.evaluator_request_id ?? undefined,
    evaluatorDomain: row.evaluator_domain ?? undefined,
    promptVersion: row.prompt_version ?? undefined,
    provider: row.provider,
    model: row.model,
    status: row.status,
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at === null ? undefined : new Date(row.completed_at),
    tokens,
    responseSha256: row.response_sha256 ?? undefined,
    responseBytes: row.response_bytes ?? undefined,
    errorCode: row.error_code ?? undefined,
  };
}

function validateTokens(tokens: ModelInvocationTokens): void {
  if (!tokens || typeof tokens !== 'object') {
    throw new Error('Invocation token counts are invalid');
  }
  assertNonNegativeInteger(tokens.input, 'Input token count');
  assertNonNegativeInteger(tokens.output, 'Output token count');
  assertNonNegativeInteger(tokens.total, 'Total token count');
}

function validateSourceEventIds(rawEventIds: string[]): string[] {
  const ids = validateIdentifierArray(rawEventIds, 'Raw event ids');
  if (ids.length === 0) {
    throw new Error('At least one raw event source is required');
  }
  return ids;
}

function deriveContextSourceEventIds(
  db: Database.Database,
  serializedRecentMessageIds: string,
): string[] {
  let recentMessageIds: string[];
  try {
    recentMessageIds = validateIdentifierArray(
      parseJson<unknown>(serializedRecentMessageIds),
      'Context recent message ids',
    );
  } catch {
    throw new Error('Invocation sources do not exactly match context messages');
  }

  const findSource = db.prepare('SELECT raw_event_id FROM chat_messages WHERE id = ?');
  const rawEventIds: string[] = [];
  for (const messageId of recentMessageIds) {
    const row = findSource.get(messageId) as { raw_event_id: string } | undefined;
    if (!row) {
      throw new Error('Invocation sources do not exactly match context messages');
    }
    rawEventIds.push(row.raw_event_id);
  }

  if (new Set(rawEventIds).size !== rawEventIds.length) {
    throw new Error('Invocation sources do not exactly match context messages');
  }
  return rawEventIds;
}

function validateIdentifierArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} are invalid`);
  }
  const ids = value.map((item) => assertIdentifier(item, label));
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contain duplicates`);
  }
  return ids;
}

function validateTextArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} are invalid`);
  }
  return value;
}

function assertIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > MAX_ID_LENGTH
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertSummaryPurpose(value: unknown): asserts value is 'summary' {
  if (value !== 'summary') {
    throw new Error('Model invocation purpose is invalid');
  }
}

function assertEvaluatorDomain(value: unknown): asserts value is EvaluatorInvocationDomain {
  if (value !== 'tool' && value !== 'memory' && value !== 'social') {
    throw new Error('Evaluator invocation domain is invalid');
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} is invalid`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
}

function opaqueReference(kind: 'ctxref' | 'groupref', value: string): string {
  const digest = createHash('sha256')
    .update(`lethebot:model-context:${kind}:v1\0`, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
  return `${kind}-sha256:${digest}`;
}

function sanitizeBoundedMetadata(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is invalid`);
  }
  const redacted = redactStorageText(value.trim());
  return truncateWithRedactionMarkers(redacted, maxLength);
}

function validateEvaluatorIdentityMetadata(
  value: unknown,
  maxLength: number,
  label: string,
): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} is invalid`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  if (
    redactSecretsInText(normalized).text !== normalized
    || /(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/i.test(normalized)
    || /^\d{5,12}$/.test(normalized)
  ) {
    throw new Error(`${label} contains prohibited identity metadata`);
  }
  return normalized;
}

function redactStorageText(value: string): string {
  const initialPlatformRedacted = redactPlatformIdentifiers(value);
  const secretRedacted = redactSecretsInText(initialPlatformRedacted).text;
  const fullyRedacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost = initialPlatformRedacted.includes('[REDACTED:platform_id]')
    && !fullyRedacted.includes('[REDACTED:platform_id]');
  return platformMarkerLost
    ? `${fullyRedacted} [REDACTED:platform_id]`
    : fullyRedacted;
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function truncateWithRedactionMarkers(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const markers = [...new Set(value.match(/\[REDACTED:[a-z0-9_]+\]/gi) ?? [])];
  const suffixParts = ['[TRUNCATED]'];
  for (const marker of markers) {
    const candidate = ` ${suffixParts.join(' ')} ${marker}`;
    if (candidate.length >= maxLength) {
      break;
    }
    suffixParts.push(marker);
  }
  const suffix = ` ${suffixParts.join(' ')}`;
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
