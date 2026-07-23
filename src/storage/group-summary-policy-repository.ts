import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import { redactSecretsInText } from '../memory/secret-scan.js';
import { hasActiveJobAttemptAuthority } from './job-repository.js';

export type GroupSummaryPolicyState = 'enabled' | 'disabled';
export type GroupSummaryAuthorityKind =
  | 'bot_owner'
  | 'group_owner'
  | 'group_admin'
  | 'local_admin';

export type GroupSummaryPolicyErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'policy_disabled'
  | 'job_not_bound'
  | 'job_binding_mismatch'
  | 'job_not_summary'
  | 'job_not_pending'
  | 'stale_policy_generation'
  | 'job_attempt_not_authorized';

export class GroupSummaryPolicyError extends Error {
  constructor(
    readonly code: GroupSummaryPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GroupSummaryPolicyError';
  }
}

export interface GroupSummaryAuthorityProof {
  kind: GroupSummaryAuthorityKind;
  actorUserId: string;
  invocationContext: 'admin_cli' | 'private_chat' | 'group_chat';
  currentGroupId?: string;
  sourceEventId?: string;
}

export interface GroupSummaryPolicy {
  groupId: string;
  state: GroupSummaryPolicyState;
  generation: number;
  eligibleAfter?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupSummaryJobBinding {
  jobId: string;
  groupId: string;
  conversationId: string;
  generation: number;
  eligibleAfter: number;
  createdAt: Date;
  canceledAt?: Date;
  cancellationCode?: 'group_summary_policy_disabled';
}

export interface SetGroupSummaryPolicyResult {
  changed: boolean;
  policy: GroupSummaryPolicy | null;
  canceledJobCount: number;
  auditId?: string;
}

interface PolicyRow {
  group_id: string;
  state: GroupSummaryPolicyState;
  generation: number;
  eligible_after: number | null;
  created_at: number;
  updated_at: number;
}

interface BindingRow {
  job_id: string;
  group_id: string;
  conversation_id: string;
  generation: number;
  eligible_after: number;
  created_at: number;
  canceled_at: number | null;
  cancellation_code: 'group_summary_policy_disabled' | null;
}

export class GroupSummaryPolicyRepository {
  constructor(private readonly db: Database.Database) {}

  get(groupId: string): GroupSummaryPolicy | null {
    this.assertNonEmpty(groupId, 'groupId');
    const row = this.readPolicyRow(groupId);
    return row ? this.policyFromRow(row) : null;
  }

  isEnabled(groupId: string): boolean {
    return this.get(groupId)?.state === 'enabled';
  }

  requireEnabled(groupId: string): GroupSummaryPolicy & {
    state: 'enabled';
    eligibleAfter: number;
  } {
    const policy = this.get(groupId);
    if (policy?.state !== 'enabled' || policy.eligibleAfter === undefined) {
      throw new GroupSummaryPolicyError(
        'policy_disabled',
        'Group summary policy is disabled.',
      );
    }
    return policy as GroupSummaryPolicy & { state: 'enabled'; eligibleAfter: number };
  }

  setEnabled(input: {
    groupId: string;
    enabled: boolean;
    authority: GroupSummaryAuthorityProof;
    now?: number;
  }): SetGroupSummaryPolicyResult {
    this.assertNonEmpty(input.groupId, 'groupId');
    const now = this.resolveNow(input.now);
    this.assertAuthority(input.groupId, input.authority);

    const transaction = this.db.transaction((): SetGroupSummaryPolicyResult => {
      const previousRow = this.readPolicyRow(input.groupId);
      const previous = previousRow ? this.policyFromRow(previousRow) : null;
      const previousEnabled = previous?.state === 'enabled';
      if (previousEnabled === input.enabled) {
        return {
          changed: false,
          policy: previous,
          canceledJobCount: 0,
        };
      }
      let transitionFloor = previousRow
        ? Math.max(now, previousRow.updated_at)
        : now;
      const durableCeiling = input.enabled
        ? this.getExactGroupIngressCeiling(input.groupId)
        : this.getPendingCancellationCeiling(input.groupId);
      if (durableCeiling !== null) {
        transitionFloor = Math.max(transitionFloor, durableCeiling);
      }
      if (input.enabled && transitionFloor >= Number.MAX_SAFE_INTEGER) {
        throw new GroupSummaryPolicyError(
          'invalid_input',
          'Group summary policy timestamp cannot advance.',
        );
      }
      // The exclusive logical boundary prevents any already-persisted exact-group
      // ingress from becoming eligible after enable or re-enable.
      const transitionNow = transitionFloor >= Number.MAX_SAFE_INTEGER
        ? transitionFloor
        : transitionFloor + 1;

      const generation = (previous?.generation ?? 0) + 1;
      const state: GroupSummaryPolicyState = input.enabled ? 'enabled' : 'disabled';
      const eligibleAfter = input.enabled ? transitionNow : null;
      this.db.prepare(
        `INSERT INTO group_summary_policies (
           group_id, state, generation, eligible_after, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET
           state = excluded.state,
           generation = excluded.generation,
           eligible_after = excluded.eligible_after,
           updated_at = excluded.updated_at`,
      ).run(
        input.groupId,
        state,
        generation,
        eligibleAfter,
        previousRow?.created_at ?? transitionNow,
        transitionNow,
      );

      const canceledJobCount = input.enabled
        ? 0
        : this.cancelPendingJobs(input.groupId, transitionNow);
      const auditId = ulid();
      this.insertAudit({
        auditId,
        groupId: input.groupId,
        oldState: previous?.state ?? 'disabled',
        newState: state,
        generation,
        eligibleAfter,
        canceledJobCount,
        authority: input.authority,
        now: transitionNow,
      });

      return {
        changed: true,
        policy: this.get(input.groupId),
        canceledJobCount,
        auditId,
      };
    });

    return transaction.immediate();
  }

  bindSummaryJob(input: {
    jobId: string;
    groupId: string;
    conversationId: string;
    now?: number;
  }): GroupSummaryJobBinding {
    this.assertNonEmpty(input.jobId, 'jobId');
    this.assertNonEmpty(input.groupId, 'groupId');
    this.assertNonEmpty(input.conversationId, 'conversationId');
    const now = this.resolveNow(input.now);

    const transaction = this.db.transaction((): GroupSummaryJobBinding => {
      const policy = this.requireEnabled(input.groupId);
      const job = this.db.prepare(
        'SELECT type, status FROM jobs WHERE id = ?',
      ).get(input.jobId) as { type: string; status: string } | undefined;
      if (!job || job.type !== 'summary') {
        throw new GroupSummaryPolicyError(
          'job_not_summary',
          'Group summary binding requires a summary job.',
        );
      }
      if (job.status !== 'pending') {
        throw new GroupSummaryPolicyError(
          'job_not_pending',
          'Group summary binding requires a pending job.',
        );
      }

      const existing = this.getBinding(input.jobId);
      if (existing) {
        if (
          existing.groupId !== input.groupId
          || existing.conversationId !== input.conversationId
          || existing.generation !== policy.generation
          || existing.eligibleAfter !== policy.eligibleAfter
          || existing.canceledAt !== undefined
        ) {
          throw new GroupSummaryPolicyError(
            'job_binding_mismatch',
            'Group summary job binding does not match current policy.',
          );
        }
        return existing;
      }

      this.db.prepare(
        `INSERT INTO group_summary_job_bindings (
           job_id, group_id, conversation_id, generation,
           eligible_after, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.jobId,
        input.groupId,
        input.conversationId,
        policy.generation,
        policy.eligibleAfter,
        now,
      );
      const binding = this.getBinding(input.jobId);
      if (!binding) {
        throw new Error('Group summary job binding insert did not persist.');
      }
      return binding;
    });

    return transaction.immediate();
  }

  getBinding(jobId: string): GroupSummaryJobBinding | null {
    this.assertNonEmpty(jobId, 'jobId');
    const row = this.db.prepare(
      'SELECT * FROM group_summary_job_bindings WHERE job_id = ?',
    ).get(jobId) as BindingRow | undefined;
    return row ? this.bindingFromRow(row) : null;
  }

  assertSummaryJobExecutionAllowed(input: {
    jobId: string;
    jobAttemptId: string;
    groupId: string;
    conversationId: string;
    now?: number;
  }): GroupSummaryJobBinding {
    this.assertNonEmpty(input.jobId, 'jobId');
    this.assertNonEmpty(input.jobAttemptId, 'jobAttemptId');
    this.assertNonEmpty(input.groupId, 'groupId');
    this.assertNonEmpty(input.conversationId, 'conversationId');
    const now = this.resolveNow(input.now);
    const binding = this.getBinding(input.jobId);
    if (!binding) {
      throw new GroupSummaryPolicyError(
        'job_not_bound',
        'Group summary job has no policy binding.',
      );
    }
    if (
      binding.groupId !== input.groupId
      || binding.conversationId !== input.conversationId
    ) {
      throw new GroupSummaryPolicyError(
        'job_binding_mismatch',
        'Group summary job binding does not match the requested scope.',
      );
    }
    if (binding.canceledAt !== undefined) {
      throw new GroupSummaryPolicyError(
        'policy_disabled',
        'Group summary job was canceled by policy.',
      );
    }

    const policy = this.get(binding.groupId);
    if (policy?.state !== 'enabled' || policy.eligibleAfter === undefined) {
      throw new GroupSummaryPolicyError(
        'policy_disabled',
        'Group summary policy is disabled.',
      );
    }
    if (
      binding.generation !== policy.generation
      || binding.eligibleAfter !== policy.eligibleAfter
    ) {
      throw new GroupSummaryPolicyError(
        'stale_policy_generation',
        'Group summary job is bound to a stale policy generation.',
      );
    }

    const job = this.db.prepare('SELECT type FROM jobs WHERE id = ?').get(input.jobId) as
      | { type: string }
      | undefined;
    if (!job || job.type !== 'summary') {
      throw new GroupSummaryPolicyError(
        'job_not_summary',
        'Group summary execution requires a summary job.',
      );
    }
    if (!hasActiveJobAttemptAuthority(this.db, {
      jobId: input.jobId,
      attemptId: input.jobAttemptId,
      now,
    })) {
      throw new GroupSummaryPolicyError(
        'job_attempt_not_authorized',
        'Group summary execution requires active job-attempt authority.',
      );
    }
    return binding;
  }

  private cancelPendingJobs(groupId: string, now: number): number {
    const rows = this.db.prepare(
      `SELECT binding.job_id
         FROM group_summary_job_bindings AS binding
         JOIN jobs ON jobs.id = binding.job_id
        WHERE binding.group_id = ?
          AND binding.canceled_at IS NULL
          AND jobs.type = 'summary'
          AND jobs.status = 'pending'
        ORDER BY binding.job_id`,
    ).all(groupId) as Array<{ job_id: string }>;
    if (rows.length === 0) {
      return 0;
    }

    const ids = rows.map((row) => row.job_id);
    const placeholders = ids.map(() => '?').join(', ');
    const code = 'group_summary_policy_disabled';
    const result = JSON.stringify({ code });
    const jobUpdate = this.db.prepare(
      `UPDATE jobs
          SET status = 'failed', completed_at = ?, updated_at = ?,
              error = ?, result = ?, lease_owner = NULL,
              lease_expires_at = NULL, heartbeat_at = ?
        WHERE id IN (${placeholders}) AND status = 'pending'`,
    ).run(now, now, code, result, now, ...ids);
    const bindingUpdate = this.db.prepare(
      `UPDATE group_summary_job_bindings
          SET canceled_at = ?, cancellation_code = ?
        WHERE job_id IN (${placeholders}) AND canceled_at IS NULL`,
    ).run(now, code, ...ids);
    if (jobUpdate.changes !== ids.length || bindingUpdate.changes !== ids.length) {
      throw new Error('Group summary pending-job cancellation was not atomic.');
    }
    return ids.length;
  }

  private readPolicyRow(groupId: string): PolicyRow | undefined {
    return this.db.prepare(
      'SELECT * FROM group_summary_policies WHERE group_id = ?',
    ).get(groupId) as PolicyRow | undefined;
  }

  private insertAudit(input: {
    auditId: string;
    groupId: string;
    oldState: GroupSummaryPolicyState;
    newState: GroupSummaryPolicyState;
    generation: number;
    eligibleAfter: number | null;
    canceledJobCount: number;
    authority: GroupSummaryAuthorityProof;
    now: number;
  }): void {
    const actorClass = input.authority.kind === 'group_admin'
      ? 'group_admin'
      : input.authority.kind === 'local_admin'
        ? 'admin'
        : 'owner';
    this.db.prepare(
      `INSERT INTO audit_log (
         id, timestamp, category, level, event_type, event_id,
         actor_user_id, actor_class, invocation_context,
         summary, details, redacted, risk_level
       ) VALUES (?, ?, 'system', 'summary', 'group.summary_policy_changed', ?,
                 ?, ?, ?, ?, ?, 1, 'low')`,
    ).run(
      input.auditId,
      input.now,
      input.auditId,
      input.authority.actorUserId,
      actorClass,
      input.authority.invocationContext,
      'Group summary policy changed',
      JSON.stringify({
        groupId: this.redactAuditText(input.groupId),
        groupIdHash: this.hashGroupId(input.groupId),
        oldState: input.oldState,
        newState: input.newState,
        generation: input.generation,
        eligibleAfter: input.eligibleAfter,
        authority: input.authority.kind,
        ...(input.authority.sourceEventId === undefined
          ? {}
          : { sourceEventId: this.redactAuditText(input.authority.sourceEventId) }),
        canceledJobCount: input.canceledJobCount,
      }),
    );
  }

  private getExactGroupIngressCeiling(groupId: string): number | null {
    const row = this.db.prepare(
      `SELECT MAX(raw.created_at) AS max_created_at
         FROM raw_events AS raw
        WHERE EXISTS (
                SELECT 1
                  FROM chat_messages AS chat
                 WHERE chat.raw_event_id = raw.id
                   AND chat.conversation_type = 'group'
                   AND chat.group_id = ?
              )
           OR (
                raw.type = 'chat.message.received'
                AND raw.source = 'gateway'
                AND raw.platform = 'qq'
                AND CASE WHEN json_valid(raw.payload)
                      THEN json_extract(raw.payload, '$.message.conversationType')
                    END = 'group'
                AND CASE WHEN json_valid(raw.payload)
                      THEN json_extract(raw.payload, '$.message.groupId')
                    END = ?
              )`,
    ).get(groupId, groupId) as { max_created_at: number | null };
    if (row.max_created_at === null) {
      return null;
    }
    if (!Number.isSafeInteger(row.max_created_at) || row.max_created_at < 0) {
      throw new GroupSummaryPolicyError(
        'invalid_input',
        'Group summary ingress timestamp is invalid.',
      );
    }
    return row.max_created_at;
  }

  private getPendingCancellationCeiling(groupId: string): number | null {
    const row = this.db.prepare(
      `SELECT MAX(MAX(binding.created_at, jobs.created_at, jobs.updated_at)) AS max_created_at
         FROM group_summary_job_bindings AS binding
         JOIN jobs ON jobs.id = binding.job_id
        WHERE binding.group_id = ?
          AND binding.canceled_at IS NULL
          AND jobs.type = 'summary'
          AND jobs.status = 'pending'`,
    ).get(groupId) as { max_created_at: number | null };
    if (row.max_created_at === null) {
      return null;
    }
    if (!Number.isSafeInteger(row.max_created_at) || row.max_created_at < 0) {
      throw new GroupSummaryPolicyError(
        'invalid_input',
        'Group summary pending-job timestamp is invalid.',
      );
    }
    return row.max_created_at;
  }

  private redactAuditText(text: string): string {
    const platformRedacted = text
      .replace(/(?<![A-Za-z0-9])qq-(?:group-)?[1-9][0-9]{4,11}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
      .replace(/(?<![A-Za-z0-9])[1-9][0-9]{4,11}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
    const secretRedacted = redactSecretsInText(platformRedacted).text;
    return secretRedacted
      .replace(/(?<![A-Za-z0-9])qq-(?:group-)?[1-9][0-9]{4,11}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
      .replace(/(?<![A-Za-z0-9])[1-9][0-9]{4,11}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
  }

  private hashGroupId(groupId: string): string {
    return createHash('sha256')
      .update('lethebot:group-summary-policy:v1\0')
      .update(groupId)
      .digest('hex');
  }

  private assertAuthority(groupId: string, authority: GroupSummaryAuthorityProof): void {
    this.assertNonEmpty(authority.actorUserId, 'actorUserId');
    if (authority.sourceEventId !== undefined) {
      this.assertNonEmpty(authority.sourceEventId, 'sourceEventId');
    }
    if (authority.kind === 'local_admin') {
      if (
        authority.actorUserId !== 'local_admin'
        || authority.invocationContext !== 'admin_cli'
        || authority.currentGroupId !== undefined
        || authority.sourceEventId !== undefined
      ) {
        throw new GroupSummaryPolicyError(
          'unauthorized',
          'Group summary local-admin authority is invalid.',
        );
      }
      return;
    }
    if (authority.kind === 'bot_owner') {
      return;
    }
    if (
      authority.invocationContext !== 'group_chat'
      || authority.currentGroupId !== groupId
    ) {
      throw new GroupSummaryPolicyError(
        'unauthorized',
        'Group summary policy change requires exact-group authority.',
      );
    }
  }

  private assertNonEmpty(value: string, field: string): void {
    if (value.length === 0 || value.trim() !== value) {
      throw new GroupSummaryPolicyError(
        'invalid_input',
        `Group summary ${field} is invalid.`,
      );
    }
  }

  private resolveNow(value?: number): number {
    const now = value ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new GroupSummaryPolicyError(
        'invalid_input',
        'Group summary timestamp is invalid.',
      );
    }
    return now;
  }

  private policyFromRow(row: PolicyRow): GroupSummaryPolicy {
    return {
      groupId: row.group_id,
      state: row.state,
      generation: row.generation,
      ...(row.eligible_after === null ? {} : { eligibleAfter: row.eligible_after }),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private bindingFromRow(row: BindingRow): GroupSummaryJobBinding {
    return {
      jobId: row.job_id,
      groupId: row.group_id,
      conversationId: row.conversation_id,
      generation: row.generation,
      eligibleAfter: row.eligible_after,
      createdAt: new Date(row.created_at),
      ...(row.canceled_at === null ? {} : { canceledAt: new Date(row.canceled_at) }),
      ...(row.cancellation_code === null
        ? {}
        : { cancellationCode: row.cancellation_code }),
    };
  }
}
