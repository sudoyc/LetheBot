import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { JobRepository, type JobRecord } from '../storage/job-repository.js';
import {
  GroupSummaryPolicyError,
  GroupSummaryPolicyRepository,
  type GroupSummaryJobBinding,
} from '../storage/group-summary-policy-repository.js';

const MAX_GROUP_SUMMARY_SOURCE_MESSAGES = 50;
const GROUP_SUMMARY_WINDOW_KEY_VERSION = 1;
const RESERVED_GROUP_SUMMARY_FIELDS = [
  'conversationId',
  'conversationType',
  'groupId',
  'sourceChatMessageIds',
  'candidateCount',
  'windowVersion',
  'messageRange',
  'timeRange',
] as const;
const SAFE_GROUP_SUMMARY_PAYLOAD_SQL = `CASE
  WHEN json_valid(summary_job.payload) THEN
    CASE
      WHEN json_type(summary_job.payload, '$.sourceChatMessageIds') = 'array'
        THEN summary_job.payload
      ELSE '{"sourceChatMessageIds":[]}'
    END
  ELSE '{"sourceChatMessageIds":[]}'
END`;

export interface EnqueueSummaryInput {
  conversationId: string;
  conversationType: 'private' | 'group';
  groupId?: string;
  payload: Record<string, unknown>;
  baseIdempotencyKey?: string;
  scheduledAt?: number | Date;
  maxAttempts?: number;
}

export interface GroupSummaryWindowPlan {
  sourceChatMessageIds: string[];
  candidateCount: number;
}

export interface GroupSummaryWindowPlannerInput {
  conversationId: string;
  groupId: string;
  eligibleAfter: number;
}

export type GroupSummaryWindowPlanner = (
  input: GroupSummaryWindowPlannerInput,
) => Promise<GroupSummaryWindowPlan | null>;

export type GroupSummaryWindowErrorCode =
  | 'window_unavailable'
  | 'source_window_invalid';

export class GroupSummaryWindowError extends Error {
  constructor(
    readonly code: GroupSummaryWindowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GroupSummaryWindowError';
  }
}

export interface SummaryJobEnqueuer {
  enqueueSummary(input: EnqueueSummaryInput): Promise<string>;
}

export interface GroupSummaryJobServiceOptions {
  jobRepository?: JobRepository;
  policyRepository?: GroupSummaryPolicyRepository;
  planGroupSummaryWindow?: GroupSummaryWindowPlanner;
  clock?: () => number;
}

interface NormalizedGroupSummaryWindowPlan {
  sourceChatMessageIds: string[];
  candidateCount: number;
}

interface GroupSummarySourceRow {
  id: string;
  raw_event_id: string;
  raw_created_at: number;
}

export class GroupSummaryJobService implements SummaryJobEnqueuer {
  private readonly jobs: JobRepository;
  private readonly policies: GroupSummaryPolicyRepository;
  private readonly planGroupSummaryWindow?: GroupSummaryWindowPlanner;
  private readonly clock: () => number;

  constructor(
    private readonly db: Database.Database,
    options: GroupSummaryJobServiceOptions = {},
  ) {
    this.jobs = options.jobRepository ?? new JobRepository(db);
    this.policies = options.policyRepository ?? new GroupSummaryPolicyRepository(db);
    this.planGroupSummaryWindow = options.planGroupSummaryWindow;
    this.clock = options.clock ?? Date.now;
  }

  async enqueueSummary(input: EnqueueSummaryInput): Promise<string> {
    this.assertNonEmpty(input.conversationId, 'conversationId');

    if (input.conversationType === 'private') {
      if (input.groupId !== undefined) {
        throw new Error('Private summary input must not include groupId');
      }
      this.assertNonEmpty(input.baseIdempotencyKey, 'baseIdempotencyKey');
      const now = this.resolveNow();
      return this.jobs.enqueue({
        type: 'summary',
        payload: this.withExactPrivateScope(input),
        idempotencyKey: input.baseIdempotencyKey,
        scheduledAt: input.scheduledAt,
        maxAttempts: input.maxAttempts,
        now,
      });
    }

    this.assertNonEmpty(input.groupId, 'groupId');
    const groupId = input.groupId;
    const planner = this.planGroupSummaryWindow;
    if (!planner) {
      throw new GroupSummaryWindowError(
        'source_window_invalid',
        'Group summary window planner is not configured.',
      );
    }

    const capturedPolicy = this.policies.requireEnabled(groupId);
    const planningStartedAt = this.resolveNow();
    if (planningStartedAt < capturedPolicy.eligibleAfter) {
      throw new GroupSummaryWindowError(
        'source_window_invalid',
        'Group summary planning time precedes the policy epoch.',
      );
    }
    const reusableJobId = this.findReusableActiveWindow({
      conversationId: input.conversationId,
      groupId,
      generation: capturedPolicy.generation,
      eligibleAfter: capturedPolicy.eligibleAfter,
    });
    if (reusableJobId) {
      return reusableJobId;
    }
    const planned = await planner({
      conversationId: input.conversationId,
      groupId,
      eligibleAfter: capturedPolicy.eligibleAfter,
    });
    const window = this.normalizeWindowPlan(planned);
    const payload = this.withExactGroupWindow(input, window);
    const idempotencyKey = this.groupWindowIdempotencyKey({
      conversationId: input.conversationId,
      groupId,
      generation: capturedPolicy.generation,
      sourceChatMessageIds: window.sourceChatMessageIds,
    });
    const now = this.resolveNow();

    const transaction = this.db.transaction(() => {
      const currentPolicy = this.requireSamePolicyGeneration(groupId, capturedPolicy);
      const existing = this.findJobByIdempotencyKey(idempotencyKey);
      if (existing) {
        const binding = this.policies.getBinding(existing.id);
        if (
          existing.type !== 'summary'
          || !this.coreWindowMatches(existing.payload, {
            conversationId: input.conversationId,
            groupId,
            sourceChatMessageIds: window.sourceChatMessageIds,
          })
          || !this.bindingMatches(binding, {
            groupId,
            conversationId: input.conversationId,
            generation: currentPolicy.generation,
            eligibleAfter: currentPolicy.eligibleAfter,
          })
        ) {
          throw new GroupSummaryWindowError(
            'source_window_invalid',
            'Group summary idempotency collision does not match the frozen window.',
          );
        }
        if (existing.status === 'failed') {
          throw new GroupSummaryWindowError(
            'window_unavailable',
            'The exact group summary window already has a terminal failed job.',
          );
        }
        return existing.id;
      }

      this.revalidateFrozenWindow({
        conversationId: input.conversationId,
        groupId,
        eligibleAfter: currentPolicy.eligibleAfter,
        sourceChatMessageIds: window.sourceChatMessageIds,
      });

      const jobId = this.jobs.enqueue({
        type: 'summary',
        payload,
        idempotencyKey,
        scheduledAt: Math.max(
          this.toMillis(input.scheduledAt ?? now),
          currentPolicy.eligibleAfter,
        ),
        maxAttempts: input.maxAttempts,
        now,
      });
      this.policies.bindSummaryJob({
        jobId,
        groupId,
        conversationId: input.conversationId,
        now,
      });
      return jobId;
    });

    return transaction.immediate();
  }

  private withExactPrivateScope(input: EnqueueSummaryInput): Record<string, unknown> {
    const payload = { ...input.payload };
    delete payload.conversationId;
    delete payload.conversationType;
    delete payload.groupId;
    return {
      ...payload,
      conversationId: input.conversationId,
      conversationType: 'private',
    };
  }

  private withExactGroupWindow(
    input: EnqueueSummaryInput,
    window: NormalizedGroupSummaryWindowPlan,
  ): Record<string, unknown> {
    const payload = this.withoutReservedGroupFields(input.payload);
    if (this.isPlainRecord(input.payload.taskPayload)) {
      payload.taskPayload = this.withoutReservedGroupFields(input.payload.taskPayload);
    }
    return {
      ...payload,
      conversationId: input.conversationId,
      conversationType: 'group',
      groupId: input.groupId,
      windowVersion: GROUP_SUMMARY_WINDOW_KEY_VERSION,
      sourceChatMessageIds: [...window.sourceChatMessageIds],
      candidateCount: window.candidateCount,
    };
  }

  private withoutReservedGroupFields(value: Record<string, unknown>): Record<string, unknown> {
    const result = { ...value };
    for (const field of RESERVED_GROUP_SUMMARY_FIELDS) {
      delete result[field];
    }
    return result;
  }

  private normalizeWindowPlan(
    plan: GroupSummaryWindowPlan | null,
  ): NormalizedGroupSummaryWindowPlan {
    if (plan === null || plan.sourceChatMessageIds.length === 0) {
      throw new GroupSummaryWindowError(
        'window_unavailable',
        'No group summary source window is currently available.',
      );
    }
    if (plan.sourceChatMessageIds.length > MAX_GROUP_SUMMARY_SOURCE_MESSAGES) {
      throw new GroupSummaryWindowError(
        'source_window_invalid',
        'Group summary source window exceeds the configured bound.',
      );
    }

    const sourceChatMessageIds = plan.sourceChatMessageIds.map((id) => {
      if (typeof id !== 'string' || id.length === 0 || id.trim() !== id) {
        throw new GroupSummaryWindowError(
          'source_window_invalid',
          'Group summary source window contains an invalid message ID.',
        );
      }
      return id;
    });
    if (new Set(sourceChatMessageIds).size !== sourceChatMessageIds.length) {
      throw new GroupSummaryWindowError(
        'source_window_invalid',
        'Group summary source window contains duplicate message IDs.',
      );
    }
    if (
      !Number.isSafeInteger(plan.candidateCount)
      || plan.candidateCount < sourceChatMessageIds.length
    ) {
      throw new GroupSummaryWindowError(
        'source_window_invalid',
        'Group summary candidate count is invalid.',
      );
    }

    return {
      sourceChatMessageIds,
      candidateCount: plan.candidateCount,
    };
  }

  private groupWindowIdempotencyKey(input: {
    conversationId: string;
    groupId: string;
    generation: number;
    sourceChatMessageIds: string[];
  }): string {
    const digest = createHash('sha256')
      .update(JSON.stringify({
        version: GROUP_SUMMARY_WINDOW_KEY_VERSION,
        conversationId: input.conversationId,
        conversationType: 'group',
        groupId: input.groupId,
        generation: input.generation,
        sourceChatMessageIds: input.sourceChatMessageIds,
      }))
      .digest('hex')
      .slice(0, 32);
    return `summary:group-window:v${GROUP_SUMMARY_WINDOW_KEY_VERSION}:${digest}`;
  }

  private requireSamePolicyGeneration(
    groupId: string,
    captured: { generation: number; eligibleAfter: number },
  ): { generation: number; eligibleAfter: number } {
    const current = this.policies.requireEnabled(groupId);
    if (
      current.generation !== captured.generation
      || current.eligibleAfter !== captured.eligibleAfter
    ) {
      throw new GroupSummaryPolicyError(
        'stale_policy_generation',
        'Group summary policy generation changed during window planning.',
      );
    }
    return current;
  }

  private revalidateFrozenWindow(input: {
    conversationId: string;
    groupId: string;
    eligibleAfter: number;
    sourceChatMessageIds: string[];
    excludingJobId?: string;
  }): void {
    const placeholders = input.sourceChatMessageIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT
         cm.id,
         cm.raw_event_id,
         re.created_at AS raw_created_at
       FROM chat_messages AS cm
       JOIN raw_events AS re ON re.id = cm.raw_event_id
       WHERE cm.id IN (${placeholders})
         AND cm.conversation_id = ?
         AND cm.conversation_type = 'group'
         AND cm.group_id = ?
         AND re.created_at >= ?
       ORDER BY re.created_at ASC, re.id ASC, cm.id ASC`,
    ).all(
      ...input.sourceChatMessageIds,
      input.conversationId,
      input.groupId,
      input.eligibleAfter,
    ) as GroupSummarySourceRow[];

    if (
      rows.length !== input.sourceChatMessageIds.length
      || rows.some((row, index) => row.id !== input.sourceChatMessageIds[index])
    ) {
      throw new GroupSummaryWindowError(
        'source_window_invalid',
        'Group summary source window no longer matches canonical source order and scope.',
      );
    }

    const summarized = this.db.prepare(
      `SELECT 1
       FROM chat_messages AS cm
       JOIN memory_sources AS source
         ON (
           source.resolution_state = 'internal'
           AND source.source_type = 'chat_message'
           AND source.chat_message_id = cm.id
         ) OR (
           source.resolution_state = 'legacy_unresolved'
           AND source.source_type = 'chat_message'
           AND (source.source_id = cm.id OR source.source_id = cm.message_id)
         )
       JOIN memory_records AS memory ON memory.id = source.memory_id
       WHERE cm.id IN (${placeholders})
         AND memory.kind = 'summary'
         AND memory.scope = 'group'
         AND memory.group_id = ?
         AND memory.conversation_id = ?
       LIMIT 1`,
    ).get(
      ...input.sourceChatMessageIds,
      input.groupId,
      input.conversationId,
    );
    if (summarized !== undefined) {
      throw new GroupSummaryWindowError(
        'source_window_invalid',
        'Group summary source window contains an already summarized message.',
      );
    }

    const excludingJobClause = input.excludingJobId === undefined
      ? ''
      : ' AND summary_job.id <> ?';
    const reserved = this.db.prepare(
      `SELECT 1
       FROM jobs AS summary_job
       JOIN json_each(
         ${SAFE_GROUP_SUMMARY_PAYLOAD_SQL},
         '$.sourceChatMessageIds'
       ) AS summary_source
       WHERE summary_job.type = 'summary'
         AND summary_job.status IN ('pending', 'running', 'completed', 'failed')
         AND json_extract(${SAFE_GROUP_SUMMARY_PAYLOAD_SQL}, '$.conversationType') = 'group'
         AND summary_source.type = 'text'
         AND summary_source.value IN (${placeholders})
         ${excludingJobClause}
       LIMIT 1`,
    ).get(
      ...input.sourceChatMessageIds,
      ...(input.excludingJobId === undefined ? [] : [input.excludingJobId]),
    );
    if (reserved !== undefined) {
      throw new GroupSummaryWindowError(
        'source_window_invalid',
        'Group summary source window overlaps another durable summary window.',
      );
    }
  }

  private findJobByIdempotencyKey(idempotencyKey: string): JobRecord | null {
    const row = this.db.prepare(
      'SELECT id FROM jobs WHERE idempotency_key = ?',
    ).get(idempotencyKey) as { id: string } | undefined;
    return row ? this.jobs.findById(row.id) : null;
  }

  private findReusableActiveWindow(input: {
    conversationId: string;
    groupId: string;
    generation: number;
    eligibleAfter: number;
  }): string | null {
    const transaction = this.db.transaction(() => {
      this.requireSamePolicyGeneration(input.groupId, input);
      const rows = this.db.prepare(
        `SELECT job.id
           FROM group_summary_job_bindings AS binding
           JOIN jobs AS job ON job.id = binding.job_id
          WHERE binding.group_id = ?
            AND binding.conversation_id = ?
            AND binding.generation = ?
            AND binding.eligible_after = ?
            AND binding.canceled_at IS NULL
            AND job.type = 'summary'
            AND job.status IN ('pending', 'running')
          ORDER BY job.created_at ASC, job.id ASC`,
      ).all(
        input.groupId,
        input.conversationId,
        input.generation,
        input.eligibleAfter,
      ) as Array<{ id: string }>;
      if (rows.length === 0) {
        return null;
      }
      if (rows.length !== 1) {
        throw new GroupSummaryWindowError(
          'source_window_invalid',
          'Group summary scope has multiple active frozen windows.',
        );
      }

      const job = this.jobs.findById(rows[0]?.id ?? '');
      if (!job || !this.isValidFrozenWindowPayload(job.payload, input)) {
        throw new GroupSummaryWindowError(
          'source_window_invalid',
          'Active group summary job has an invalid frozen window.',
        );
      }
      const payload = job.payload as { sourceChatMessageIds: string[] };
      this.revalidateFrozenWindow({
        conversationId: input.conversationId,
        groupId: input.groupId,
        eligibleAfter: input.eligibleAfter,
        sourceChatMessageIds: payload.sourceChatMessageIds,
        excludingJobId: job.id,
      });
      return job.id;
    });
    return transaction.immediate();
  }

  private isValidFrozenWindowPayload(
    payload: unknown,
    expected: { conversationId: string; groupId: string },
  ): boolean {
    if (
      !this.isPlainRecord(payload)
      || payload.conversationId !== expected.conversationId
      || payload.conversationType !== 'group'
      || payload.groupId !== expected.groupId
      || payload.windowVersion !== GROUP_SUMMARY_WINDOW_KEY_VERSION
      || !Array.isArray(payload.sourceChatMessageIds)
      || payload.sourceChatMessageIds.length === 0
      || payload.sourceChatMessageIds.length > MAX_GROUP_SUMMARY_SOURCE_MESSAGES
      || typeof payload.candidateCount !== 'number'
      || !Number.isSafeInteger(payload.candidateCount)
      || payload.candidateCount < payload.sourceChatMessageIds.length
    ) {
      return false;
    }
    return payload.sourceChatMessageIds.every((sourceId) => (
      typeof sourceId === 'string'
      && sourceId.length > 0
      && sourceId.trim() === sourceId
    )) && new Set(payload.sourceChatMessageIds).size === payload.sourceChatMessageIds.length;
  }

  private coreWindowMatches(
    payload: unknown,
    expected: {
      conversationId: string;
      groupId: string;
      sourceChatMessageIds: string[];
    },
  ): boolean {
    if (!this.isPlainRecord(payload) || !Array.isArray(payload.sourceChatMessageIds)) {
      return false;
    }
    return payload.conversationId === expected.conversationId
      && payload.conversationType === 'group'
      && payload.groupId === expected.groupId
      && payload.windowVersion === GROUP_SUMMARY_WINDOW_KEY_VERSION
      && payload.sourceChatMessageIds.length === expected.sourceChatMessageIds.length
      && payload.sourceChatMessageIds.every(
        (id, index) => id === expected.sourceChatMessageIds[index],
      );
  }

  private bindingMatches(
    binding: GroupSummaryJobBinding | null,
    expected: {
      groupId: string;
      conversationId: string;
      generation: number;
      eligibleAfter: number;
    },
  ): boolean {
    return binding !== null
      && binding.groupId === expected.groupId
      && binding.conversationId === expected.conversationId
      && binding.generation === expected.generation
      && binding.eligibleAfter === expected.eligibleAfter
      && binding.canceledAt === undefined;
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  private assertNonEmpty(value: string | undefined, field: string): asserts value is string {
    if (value === undefined || value.length === 0 || value.trim() !== value) {
      throw new Error(`Summary ${field} is invalid`);
    }
  }

  private resolveNow(): number {
    const now = this.clock();
    this.assertTimestamp(now);
    return now;
  }

  private assertTimestamp(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Summary enqueue timestamp is invalid');
    }
  }

  private toMillis(value: number | Date): number {
    const millis = value instanceof Date ? value.getTime() : value;
    this.assertTimestamp(millis);
    return millis;
  }
}
