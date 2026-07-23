import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import {
  hasActiveJobAttemptAuthority,
  type JobRepository,
} from '../storage/job-repository.js';
import { hasQuestionSignal } from './engine.js';

export const DELAYED_ATTENTION_JOB_TYPE = 'attention_recheck';
export const DELAYED_ATTENTION_POLICY_VERSION = 'delayed-attention-v1';
export const DELAYED_ATTENTION_RECHECK_MS = 15_000;
export const DELAYED_ATTENTION_THREAD_MS = 120_000;
export const DELAYED_ATTENTION_TRAFFIC_WINDOW_MS = 10_000;
export const DELAYED_ATTENTION_TRAFFIC_LIMIT = 5;
export const DELAYED_ATTENTION_BUDGET_WINDOW_MS = 600_000;
export const DELAYED_ATTENTION_BUDGET_LIMIT = 2;
const MAX_CANDIDATE_ID_LENGTH = 128;

export function parseDelayedAttentionTaskPayload(value: unknown): { candidateId: string } {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error('Delayed Attention task payload must be exactly { candidateId }');
  }

  const entries = Object.entries(value);
  const candidateId = entries[0]?.[1];
  if (
    entries.length !== 1
    || entries[0]?.[0] !== 'candidateId'
    || typeof candidateId !== 'string'
    || candidateId.length === 0
    || candidateId.length > MAX_CANDIDATE_ID_LENGTH
  ) {
    throw new Error('Delayed Attention task payload must be exactly { candidateId }');
  }

  return { candidateId };
}

export type DelayedAttentionSuppressorCode =
  | 'thread_expired'
  | 'human_answer'
  | 'high_traffic'
  | 'group_budget_exhausted';

export interface DelayedAttentionCandidate {
  id: string;
  sourceRawEventId: string;
  sourceChatMessageId: string;
  jobId: string;
  conversationId: string;
  conversationType: 'group';
  groupId: string;
  candidateKind: 'unmentioned_question';
  policyVersion: typeof DELAYED_ATTENTION_POLICY_VERSION;
  observedAt: number;
  createdAt: number;
  notBeforeAt: number;
  expiresAt: number;
}

export interface DelayedAttentionSuppressor {
  id: string;
  code: DelayedAttentionSuppressorCode;
  evidenceChatMessageId?: string;
  observedCount?: number;
  windowMs?: number;
  createdAt: number;
}

export interface DelayedAttentionDecision {
  id: string;
  candidateId: string;
  jobId: string;
  jobAttemptId: string;
  outcome: 'respond' | 'suppress';
  decidedAt: number;
  suppressors: DelayedAttentionSuppressor[];
}

interface CandidateRow {
  id: string;
  source_raw_event_id: string;
  source_chat_message_id: string;
  job_id: string;
  conversation_id: string;
  conversation_type: 'group';
  group_id: string;
  candidate_kind: 'unmentioned_question';
  policy_version: typeof DELAYED_ATTENTION_POLICY_VERSION;
  observed_at: number;
  created_at: number;
  not_before_at: number;
  expires_at: number;
}

interface CandidateSourceRow {
  raw_event_id: string;
  raw_type: string;
  raw_source: string;
  raw_platform: string | null;
  raw_conversation_id: string | null;
  raw_created_at: number;
  chat_message_id: string;
  platform_message_id: string;
  chat_conversation_id: string;
  conversation_type: string;
  group_id: string | null;
  sender_id: string;
  text: string | null;
  mentions_bot: number;
  reply_to_message_id: string | null;
  admission_state: string;
  accepted_at: number;
  accepted_receipt_count: number;
  accepted_received_at: number | null;
}

interface DecisionRow {
  id: string;
  candidate_id: string;
  job_id: string;
  job_attempt_id: string;
  outcome: 'respond' | 'suppress';
  decided_at: number;
}

interface SuppressorRow {
  id: string;
  code: DelayedAttentionSuppressorCode;
  evidence_chat_message_id: string | null;
  observed_count: number | null;
  window_ms: number | null;
  created_at: number;
}

export class DelayedAttentionService {
  constructor(
    private readonly db: Database.Database,
    private readonly jobs: JobRepository,
  ) {}

  enqueueCandidate(input: {
    sourceRawEventId: string;
    createdAt?: number;
  }): DelayedAttentionCandidate {
    const transaction = this.db.transaction(() => {
      const existing = this.findCandidateBySource(input.sourceRawEventId);
      if (existing) {
        this.assertJobBinding(existing);
        return existing;
      }

      const source = this.readCandidateSource(input.sourceRawEventId);
      this.assertEligibleSource(source);
      const createdAt = input.createdAt ?? Date.now();
      if (!Number.isSafeInteger(createdAt) || createdAt < source.raw_created_at) {
        throw new Error('Delayed Attention candidate creation time is invalid');
      }

      const candidateId = ulid();
      const jobId = ulid();
      const notBeforeAt = source.raw_created_at + DELAYED_ATTENTION_RECHECK_MS;
      const returnedJobId = this.jobs.enqueue({
        id: jobId,
        type: DELAYED_ATTENTION_JOB_TYPE,
        payload: { candidateId },
        idempotencyKey: this.jobIdempotencyKey(source.raw_event_id),
        scheduledAt: notBeforeAt,
        maxAttempts: 3,
        now: createdAt,
      });
      if (returnedJobId !== jobId) {
        throw new Error('Delayed Attention job idempotency state is inconsistent');
      }

      this.db.prepare(
        `INSERT INTO attention_candidates (
           id, source_raw_event_id, source_chat_message_id, job_id,
           conversation_id, conversation_type, group_id,
           candidate_kind, policy_version,
           observed_at, created_at, not_before_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, 'group', ?, 'unmentioned_question', ?, ?, ?, ?, ?)`,
      ).run(
        candidateId,
        source.raw_event_id,
        source.chat_message_id,
        jobId,
        source.chat_conversation_id,
        source.group_id,
        DELAYED_ATTENTION_POLICY_VERSION,
        source.raw_created_at,
        createdAt,
        notBeforeAt,
        source.raw_created_at + DELAYED_ATTENTION_THREAD_MS,
      );

      const candidate = this.findCandidate(candidateId);
      if (!candidate) {
        throw new Error('Delayed Attention candidate insert did not persist');
      }
      return candidate;
    });

    return transaction.immediate();
  }

  decide(input: {
    candidateId: string;
    jobId: string;
    jobAttemptId: string;
    now?: number;
  }): DelayedAttentionDecision {
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('Delayed Attention decision time is invalid');
    }

    const transaction = this.db.transaction(() => {
      const candidate = this.findCandidate(input.candidateId);
      if (!candidate || candidate.jobId !== input.jobId) {
        throw new Error('Delayed Attention candidate/job binding is invalid');
      }
      this.assertJobBinding(candidate);

      const existing = this.findDecision(candidate.id);
      if (existing) {
        return existing;
      }
      if (now < candidate.notBeforeAt) {
        throw new Error('Delayed Attention candidate is not due for recheck');
      }
      if (!hasActiveJobAttemptAuthority(this.db, {
        jobId: input.jobId,
        attemptId: input.jobAttemptId,
        now,
      })) {
        throw new Error('Delayed Attention decision requires active lease authority');
      }

      const suppressor = this.selectSuppressor(candidate, now);
      const outcome = suppressor ? 'suppress' : 'respond';
      const decisionId = ulid();
      this.db.prepare(
        `INSERT INTO attention_decisions (
           id, candidate_id, job_id, job_attempt_id, outcome, decided_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        decisionId,
        candidate.id,
        candidate.jobId,
        input.jobAttemptId,
        outcome,
        now,
      );

      if (suppressor) {
        this.db.prepare(
          `INSERT INTO attention_suppressors (
             id, decision_id, candidate_id, decision_outcome, code,
             evidence_chat_message_id, observed_count, window_ms, created_at
           ) VALUES (?, ?, ?, 'suppress', ?, ?, ?, ?, ?)`,
        ).run(
          ulid(),
          decisionId,
          candidate.id,
          suppressor.code,
          suppressor.evidenceChatMessageId ?? null,
          suppressor.observedCount ?? null,
          suppressor.windowMs ?? null,
          now,
        );
      }

      const decision = this.findDecision(candidate.id);
      if (!decision) {
        throw new Error('Delayed Attention decision insert did not persist');
      }
      return decision;
    });

    return transaction.immediate();
  }

  findCandidate(id: string): DelayedAttentionCandidate | null {
    const row = this.db.prepare(
      'SELECT * FROM attention_candidates WHERE id = ?',
    ).get(id) as CandidateRow | undefined;
    return row ? this.rowToCandidate(row) : null;
  }

  findDecision(candidateId: string): DelayedAttentionDecision | null {
    const row = this.db.prepare(
      'SELECT * FROM attention_decisions WHERE candidate_id = ?',
    ).get(candidateId) as DecisionRow | undefined;
    if (!row) {
      return null;
    }
    const suppressors = this.db.prepare(
      `SELECT id, code, evidence_chat_message_id, observed_count, window_ms, created_at
         FROM attention_suppressors
        WHERE decision_id = ? AND candidate_id = ?
        ORDER BY code`,
    ).all(row.id, row.candidate_id) as SuppressorRow[];
    return {
      id: row.id,
      candidateId: row.candidate_id,
      jobId: row.job_id,
      jobAttemptId: row.job_attempt_id,
      outcome: row.outcome,
      decidedAt: row.decided_at,
      suppressors: suppressors.map((suppressor) => ({
        id: suppressor.id,
        code: suppressor.code,
        ...(suppressor.evidence_chat_message_id
          ? { evidenceChatMessageId: suppressor.evidence_chat_message_id }
          : {}),
        ...(suppressor.observed_count === null
          ? {}
          : { observedCount: suppressor.observed_count }),
        ...(suppressor.window_ms === null ? {} : { windowMs: suppressor.window_ms }),
        createdAt: suppressor.created_at,
      })),
    };
  }

  private findCandidateBySource(sourceRawEventId: string): DelayedAttentionCandidate | null {
    const row = this.db.prepare(
      'SELECT * FROM attention_candidates WHERE source_raw_event_id = ?',
    ).get(sourceRawEventId) as CandidateRow | undefined;
    return row ? this.rowToCandidate(row) : null;
  }

  private readCandidateSource(sourceRawEventId: string): CandidateSourceRow {
    const rows = this.db.prepare(
      `SELECT raw.id AS raw_event_id,
              raw.type AS raw_type,
              raw.source AS raw_source,
              raw.platform AS raw_platform,
              raw.conversation_id AS raw_conversation_id,
              raw.created_at AS raw_created_at,
              message.id AS chat_message_id,
              message.message_id AS platform_message_id,
              message.conversation_id AS chat_conversation_id,
              message.conversation_type,
              message.group_id,
              message.sender_id,
              message.text,
              message.mentions_bot,
              message.reply_to_message_id,
              admission.state AS admission_state,
              admission.accepted_at,
              (SELECT COUNT(*)
                 FROM event_ingress_receipts AS receipt
                WHERE receipt.raw_event_id = raw.id
                  AND receipt.disposition = 'accepted') AS accepted_receipt_count,
              (SELECT receipt.received_at
                 FROM event_ingress_receipts AS receipt
                WHERE receipt.raw_event_id = raw.id
                  AND receipt.disposition = 'accepted'
                ORDER BY receipt.received_at, receipt.id
                LIMIT 1) AS accepted_received_at
         FROM raw_events AS raw
         JOIN chat_messages AS message ON message.raw_event_id = raw.id
         JOIN event_processing_admissions AS admission ON admission.raw_event_id = raw.id
        WHERE raw.id = ?`,
    ).all(sourceRawEventId) as CandidateSourceRow[];
    if (rows.length !== 1 || !rows[0]) {
      throw new Error('Delayed Attention source must resolve to one admitted chat message');
    }
    return rows[0];
  }

  private assertEligibleSource(source: CandidateSourceRow): void {
    const replyTargetsBot = source.reply_to_message_id !== null && this.db.prepare(
      `SELECT 1
         FROM chat_messages
        WHERE message_id = ?
          AND conversation_id = ?
          AND conversation_type = 'group'
          AND sender_id = 'bot-self'
        LIMIT 1`,
    ).get(source.reply_to_message_id, source.chat_conversation_id) !== undefined;
    if (
      source.raw_type !== 'chat.message.received'
      || source.raw_source !== 'gateway'
      || source.raw_platform !== 'qq'
      || source.raw_conversation_id !== source.chat_conversation_id
      || source.conversation_type !== 'group'
      || !source.group_id
      || source.sender_id === 'bot-self'
      || source.mentions_bot !== 0
      || replyTargetsBot
      || !hasQuestionSignal(source.text ?? '')
      || source.admission_state !== 'processing'
      || source.accepted_at !== source.raw_created_at
      || source.accepted_receipt_count !== 1
      || source.accepted_received_at !== source.raw_created_at
    ) {
      throw new Error('Delayed Attention source is not an eligible unmentioned group question');
    }
  }

  private assertJobBinding(candidate: DelayedAttentionCandidate): void {
    const job = this.jobs.findById(candidate.jobId);
    if (
      !job
      || job.type !== DELAYED_ATTENTION_JOB_TYPE
      || !isExactCandidatePayload(job.payload, candidate.id)
      || job.idempotencyKey !== this.jobIdempotencyKey(candidate.sourceRawEventId)
      || job.scheduledAt.getTime() !== candidate.notBeforeAt
      || job.createdAt.getTime() !== candidate.createdAt
      || job.maxAttempts !== 3
    ) {
      throw new Error('Delayed Attention candidate/job contract is invalid');
    }
  }

  private selectSuppressor(
    candidate: DelayedAttentionCandidate,
    now: number,
  ): Omit<DelayedAttentionSuppressor, 'id' | 'createdAt'> | null {
    if (now >= candidate.expiresAt) {
      return { code: 'thread_expired' };
    }

    const humanAnswer = this.db.prepare(
      `SELECT answer.id
         FROM chat_messages AS source
         JOIN chat_messages AS answer
           ON answer.conversation_id = source.conversation_id
          AND answer.conversation_type = 'group'
          AND answer.group_id = source.group_id
          AND answer.reply_to_message_id = source.message_id
         JOIN raw_events AS raw ON raw.id = answer.raw_event_id
        WHERE source.id = ?
          AND answer.sender_id <> 'bot-self'
          AND raw.type = 'chat.message.received'
          AND raw.source = 'gateway'
          AND raw.platform = 'qq'
          AND raw.created_at > ?
          AND raw.created_at <= ?
        ORDER BY raw.created_at, answer.id
        LIMIT 1`,
    ).get(candidate.sourceChatMessageId, candidate.observedAt, now) as { id: string } | undefined;
    if (humanAnswer) {
      return { code: 'human_answer', evidenceChatMessageId: humanAnswer.id };
    }

    const trafficCount = this.db.prepare(
      `SELECT COUNT(*) AS count
         FROM chat_messages AS message
         JOIN raw_events AS raw ON raw.id = message.raw_event_id
        WHERE message.conversation_id = ?
          AND message.conversation_type = 'group'
          AND message.group_id = ?
          AND message.sender_id <> 'bot-self'
          AND raw.type = 'chat.message.received'
          AND raw.source = 'gateway'
          AND raw.platform = 'qq'
          AND raw.created_at > ?
          AND raw.created_at <= ?`,
    ).get(
      candidate.conversationId,
      candidate.groupId,
      now - DELAYED_ATTENTION_TRAFFIC_WINDOW_MS,
      now,
    ) as { count: number };
    if (trafficCount.count > DELAYED_ATTENTION_TRAFFIC_LIMIT) {
      return {
        code: 'high_traffic',
        observedCount: trafficCount.count,
        windowMs: DELAYED_ATTENTION_TRAFFIC_WINDOW_MS,
      };
    }

    const budgetCount = this.db.prepare(
      `SELECT COUNT(*) AS count
         FROM attention_decisions AS decision
         JOIN attention_candidates AS prior ON prior.id = decision.candidate_id
        WHERE decision.outcome = 'respond'
          AND prior.group_id = ?
          AND decision.decided_at > ?
          AND decision.decided_at <= ?`,
    ).get(
      candidate.groupId,
      now - DELAYED_ATTENTION_BUDGET_WINDOW_MS,
      now,
    ) as { count: number };
    if (budgetCount.count >= DELAYED_ATTENTION_BUDGET_LIMIT) {
      return {
        code: 'group_budget_exhausted',
        observedCount: budgetCount.count,
        windowMs: DELAYED_ATTENTION_BUDGET_WINDOW_MS,
      };
    }

    return null;
  }

  private jobIdempotencyKey(sourceRawEventId: string): string {
    return `attention:deferred:v1:${sourceRawEventId}`;
  }

  private rowToCandidate(row: CandidateRow): DelayedAttentionCandidate {
    return {
      id: row.id,
      sourceRawEventId: row.source_raw_event_id,
      sourceChatMessageId: row.source_chat_message_id,
      jobId: row.job_id,
      conversationId: row.conversation_id,
      conversationType: row.conversation_type,
      groupId: row.group_id,
      candidateKind: row.candidate_kind,
      policyVersion: row.policy_version,
      observedAt: row.observed_at,
      createdAt: row.created_at,
      notBeforeAt: row.not_before_at,
      expiresAt: row.expires_at,
    };
  }
}

function isExactCandidatePayload(value: unknown, candidateId: string): boolean {
  try {
    return parseDelayedAttentionTaskPayload(value).candidateId === candidateId;
  } catch {
    return false;
  }
}
