/**
 * Action decision and execution repository.
 *
 * Persists structured social/tool/memory action plans and execution results.
 */

import type Database from 'better-sqlite3';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ulid } from 'ulidx';
import { redactSecretsInText } from '../memory/secret-scan.js';
import type { ActionDecision, ActionExecutionResult, ActionPlan, ActionType } from '../types/action.js';
import type { SocialEvaluationRequest, SocialEvaluationResult } from '../types/evaluator.js';
import { assertEvaluatorInvocationBinding } from '../storage/model-invocation-repository.js';
import { applyPassingSocialEvaluation } from './social-evaluation.js';
import {
  guardMemoryClaims,
  MEMORY_CLAIM_GUARD_SUPPRESSOR,
  type MemoryClaimActor,
} from './memory-claim-guard.js';

export interface SocialEvaluatorEvidence {
  request: SocialEvaluationRequest;
  result: SocialEvaluationResult;
}

export const MAX_EVALUATOR_REASON_LENGTH = 2048;

export interface CreateActionDecisionInput {
  id?: string;
  turnId: string;
  decidedBy: ActionDecision['decidedBy'];
  actions: ActionPlan[];
  riskLevel: ActionDecision['riskLevel'];
  confidence: number;
  reasons: string[];
  suppressors: string[];
  evaluatorRequired: boolean;
  evaluatorPassed?: boolean;
  evaluatorEvidence?: SocialEvaluatorEvidence;
  claimActor?: MemoryClaimActor;
  createdAt?: Date;
}

export interface CreateActionExecutionInput {
  id?: string;
  actionDecisionId: string;
  actionType: ActionType;
  status: ActionExecutionResult['status'];
  executedMessageId?: string;
  executedMemoryId?: string;
  executedJobId?: string;
  downgradedFrom?: ActionType;
  downgradedReason?: string;
  error?: ActionExecutionResult['error'];
  auditLevel: ActionExecutionResult['auditLevel'];
  auditEntry?: string;
  executedAt?: Date;
}

export interface ActionTurnSource {
  turnId: string;
  conversationId: string;
  triggerEventId: string;
  conversationType?: 'private' | 'group';
  groupId?: string;
}

interface ActionDecisionBindingRow {
  id: string;
  turn_id: string;
  decided_by: string;
  risk_level: string;
  confidence: number;
  evaluator_required: number;
  evaluator_passed: number | null;
  evaluator_decision_id: string | null;
  execution_binding: string | null;
  actions: string;
  reasons: string | null;
  suppressors: string | null;
  created_at: number;
  turn_conversation_id: string;
  turn_trigger_event_id: string;
  turn_action_decision_id: string | null;
  trigger_raw_conversation_id: string | null;
  trigger_chat_count: number;
  trigger_chat_conversation_id: string | null;
  trigger_chat_conversation_type: string | null;
  trigger_chat_group_id: string | null;
  linked_evaluator_id: string | null;
  evaluator_request_id: string | null;
  evaluator_domain: string | null;
  evaluator_turn_id: string | null;
  evaluator_decision: string | null;
  evaluator_reason: string | null;
  evaluator_risk_level: string | null;
  evaluator_confidence: number | null;
  evaluator_version: string | null;
  evaluator_model_invocation_id: string | null;
  evaluator_actor_user_id: string | null;
  evaluator_actor_class: string | null;
  evaluator_invocation_context: string | null;
  evaluator_source_event_ids: string | null;
  evaluator_request_created_at: number | null;
  evaluator_decided_at: number | null;
}

interface EvaluatorExecutionAuthority {
  decisionId: string;
  requestId: string;
  domain: string;
  turnId: string;
  outcome: string;
  reason: string;
  confidence: number;
  riskLevel: string;
  evaluatorVersion: string;
  modelInvocationId: string | null;
  actorUserId: string | null;
  actorClass: string;
  invocationContext: string;
  sourceEventIdsJson: string;
  requestCreatedAt: number;
  decidedAt: number;
}

interface TurnExecutionAuthority {
  conversationId: string;
  triggerEventId: string;
  rawConversationId: string | null;
  chatCount: number;
  chatConversationId: string | null;
  chatConversationType: string | null;
  chatGroupId: string | null;
}

const INVALID_EXECUTION_BINDING_MESSAGE = 'Action decision execution binding is invalid';

export class ActionRepository {
  private readonly executionBindingKey = randomBytes(32);

  constructor(private readonly db: Database.Database) {}

  async createDecision(input: CreateActionDecisionInput): Promise<ActionDecision> {
    return this.createDecisionSync(input);
  }

  createDecisionSync(input: CreateActionDecisionInput): ActionDecision {
    let snapshot: CreateActionDecisionInput;
    try {
      snapshot = structuredClone(input);
    } catch {
      throw new Error('Action decision input is invalid');
    }

    const turnAuthority = readTurnExecutionAuthority(this.db, snapshot.turnId);
    validateDecisionAuthority(this.db, snapshot, turnAuthority);

    const id = snapshot.id ?? ulid();
    const evaluatedAt = new Date();
    const createdAt = snapshot.createdAt ?? evaluatedAt;
    const guarded = guardMemoryClaims(this.db, {
      turnId: snapshot.turnId,
      actions: snapshot.actions,
      actor: snapshot.claimActor,
      decisionAt: evaluatedAt,
    });
    const evaluatorDecisionId = snapshot.evaluatorEvidence?.result.decisionId;
    const evaluatorPassed = snapshot.evaluatorEvidence
      ? isPassingEvaluatorDecision(snapshot.evaluatorEvidence.result.decision)
      : snapshot.evaluatorPassed;
    const decision = {
      id,
      turnId: snapshot.turnId,
      createdAt,
      decidedBy: snapshot.evaluatorEvidence ? 'evaluator' : snapshot.decidedBy,
      actions: guarded.actions,
      riskLevel: snapshot.evaluatorEvidence?.result.riskLevel ?? snapshot.riskLevel,
      confidence: snapshot.evaluatorEvidence?.result.confidence ?? snapshot.confidence,
      reasons: snapshot.reasons,
      suppressors: guarded.corrected
        ? [...new Set([...snapshot.suppressors, MEMORY_CLAIM_GUARD_SUPPRESSOR])]
        : snapshot.suppressors,
      evaluatorRequired: snapshot.evaluatorEvidence ? true : snapshot.evaluatorRequired,
      evaluatorPassed,
      evaluatorDecisionId,
    } satisfies ActionDecision;
    const storedActions = redactActionStructuredValue(decision.actions, ['actions']);
    const storedReasons = redactActionStructuredValue(decision.reasons, ['reasons']);
    const storedSuppressors = redactActionStructuredValue(decision.suppressors, ['suppressors']);
    const evaluatorAuthority = snapshot.evaluatorEvidence
      ? buildEvaluatorAuthorityFromEvidence(snapshot.evaluatorEvidence)
      : undefined;
    const executionBinding = this.createExecutionBinding(decision, evaluatorAuthority, turnAuthority);

    const commit = this.db.transaction(() => {
      if (snapshot.evaluatorEvidence) {
        const { request, result } = snapshot.evaluatorEvidence;
        assertEvaluatorInvocationBinding(this.db, request, result);
        this.db
          .prepare(
            `INSERT INTO evaluator_decisions (
              id, request_id, domain, turn_id, decision, reason, confidence, risk_level,
              evaluator_version, model_invocation_id, actor_user_id, actor_class,
              invocation_context, source_event_ids, request_created_at, decided_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            result.decisionId,
            result.requestId,
            request.domain,
            request.turnId,
            result.decision,
            sanitizeEvaluatorNarrative(result.reason),
            result.confidence,
            result.riskLevel,
            result.evaluatorVersion,
            result.modelInvocationId ?? null,
            request.actor.canonicalUserId ?? null,
            request.actor.actorClass,
            request.context,
            JSON.stringify(request.sourceEventIds),
            request.createdAt.getTime(),
            result.decidedAt.getTime()
          );
      }

      this.db
        .prepare(
          `INSERT INTO action_decisions (
            id, turn_id, decided_by, risk_level, confidence,
            evaluator_required, evaluator_passed, evaluator_decision_id,
            execution_binding, actions, reasons, suppressors, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          decision.id,
          decision.turnId,
          decision.decidedBy,
          decision.riskLevel,
          decision.confidence,
          decision.evaluatorRequired ? 1 : 0,
          decision.evaluatorPassed === undefined ? null : decision.evaluatorPassed ? 1 : 0,
          evaluatorDecisionId ?? null,
          executionBinding,
          JSON.stringify(storedActions.value),
          JSON.stringify(storedReasons.value),
          JSON.stringify(storedSuppressors.value),
          decision.createdAt.getTime()
        );

      this.db
        .prepare('UPDATE agent_turns SET action_decision_id = ? WHERE id = ?')
        .run(decision.id, decision.turnId);
    });
    commit.immediate();

    return decision;
  }

  assertExecutionBinding(decision: ActionDecision): ActionTurnSource {
    try {
      return this.assertExecutionBindingInternal(decision);
    } catch {
      throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
    }
  }

  async createExecution(input: CreateActionExecutionInput): Promise<ActionExecutionResult> {
    const id = input.id ?? ulid();
    const executedAt = input.executedAt ?? new Date();
    const downgradedReason = input.downgradedReason === undefined
      ? undefined
      : redactActionText(input.downgradedReason).text;
    const errorCode = input.error?.code === undefined ? undefined : redactActionText(input.error.code).text;
    const errorMessage = input.error?.message === undefined ? undefined : redactActionText(input.error.message).text;
    const auditEntry = input.auditEntry === undefined ? undefined : redactActionText(input.auditEntry).text;

    this.db
      .prepare(
        `INSERT INTO action_executions (
          id, action_decision_id, action_type, status,
          executed_message_id, executed_memory_id, executed_job_id,
          downgraded_from, downgraded_reason,
          error_code, error_message,
          audit_level, audit_entry, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.actionDecisionId,
        input.actionType,
        input.status,
        input.executedMessageId ?? null,
        input.executedMemoryId ?? null,
        input.executedJobId ?? null,
        input.downgradedFrom ?? null,
        downgradedReason ?? null,
        errorCode ?? null,
        errorMessage ?? null,
        input.auditLevel,
        auditEntry ?? null,
        executedAt.getTime()
      );

    return {
      id,
      actionDecisionId: input.actionDecisionId,
      actionType: input.actionType,
      executedAt,
      status: input.status,
      executed: buildExecutedResult(input),
      downgradedFrom: input.downgradedFrom,
      downgradedReason,
      error: input.error
        ? {
            code: errorCode ?? input.error.code,
            message: errorMessage ?? input.error.message,
            recoverable: input.error.recoverable,
          }
        : undefined,
      auditLevel: input.auditLevel,
      auditEntry,
    };
  }

  private createExecutionBinding(
    decision: ActionDecision,
    evaluatorAuthority: EvaluatorExecutionAuthority | undefined,
    turnAuthority: TurnExecutionAuthority,
  ): string {
    const digest = createHmac('sha256', this.executionBindingKey)
      .update(canonicalizeExecutionDecision(decision, evaluatorAuthority, turnAuthority))
      .digest('hex');
    return `v1:${digest}`;
  }

  private assertExecutionBindingInternal(decision: ActionDecision): ActionTurnSource {
    const row = this.db
      .prepare(
        `SELECT action.id,
                action.turn_id,
                action.decided_by,
                action.risk_level,
                action.confidence,
                action.evaluator_required,
                action.evaluator_passed,
                action.evaluator_decision_id,
                action.execution_binding,
                action.actions,
                action.reasons,
                action.suppressors,
                action.created_at,
                turn.conversation_id AS turn_conversation_id,
                turn.trigger_event_id AS turn_trigger_event_id,
                turn.action_decision_id AS turn_action_decision_id,
                trigger.conversation_id AS trigger_raw_conversation_id,
                (SELECT COUNT(*)
                   FROM chat_messages AS trigger_chat
                  WHERE trigger_chat.raw_event_id = turn.trigger_event_id) AS trigger_chat_count,
                (SELECT trigger_chat.conversation_id
                   FROM chat_messages AS trigger_chat
                  WHERE trigger_chat.raw_event_id = turn.trigger_event_id
                  ORDER BY trigger_chat.id
                  LIMIT 1) AS trigger_chat_conversation_id,
                (SELECT trigger_chat.conversation_type
                   FROM chat_messages AS trigger_chat
                  WHERE trigger_chat.raw_event_id = turn.trigger_event_id
                  ORDER BY trigger_chat.id
                  LIMIT 1) AS trigger_chat_conversation_type,
                (SELECT trigger_chat.group_id
                   FROM chat_messages AS trigger_chat
                  WHERE trigger_chat.raw_event_id = turn.trigger_event_id
                  ORDER BY trigger_chat.id
                  LIMIT 1) AS trigger_chat_group_id,
                evaluator.id AS linked_evaluator_id,
                evaluator.request_id AS evaluator_request_id,
                evaluator.domain AS evaluator_domain,
                evaluator.turn_id AS evaluator_turn_id,
                evaluator.decision AS evaluator_decision,
                evaluator.reason AS evaluator_reason,
                evaluator.risk_level AS evaluator_risk_level,
                evaluator.confidence AS evaluator_confidence,
                evaluator.evaluator_version AS evaluator_version,
                evaluator.model_invocation_id AS evaluator_model_invocation_id,
                evaluator.actor_user_id AS evaluator_actor_user_id,
                evaluator.actor_class AS evaluator_actor_class,
                evaluator.invocation_context AS evaluator_invocation_context,
                evaluator.source_event_ids AS evaluator_source_event_ids,
                evaluator.request_created_at AS evaluator_request_created_at,
                evaluator.decided_at AS evaluator_decided_at
           FROM action_decisions AS action
           JOIN agent_turns AS turn
             ON turn.id = action.turn_id
           JOIN raw_events AS trigger
             ON trigger.id = turn.trigger_event_id
           LEFT JOIN evaluator_decisions AS evaluator
             ON evaluator.id = action.evaluator_decision_id
          WHERE action.id = ?`
      )
      .get(decision.id) as ActionDecisionBindingRow | undefined;
    if (!row?.execution_binding) {
      throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
    }

    const evaluatorAuthority = buildEvaluatorAuthorityFromRow(row);
    const turnAuthority = buildTurnExecutionAuthorityFromRow(row);
    const expectedBinding = this.createExecutionBinding(decision, evaluatorAuthority, turnAuthority);
    if (!constantTimeBindingEqual(row.execution_binding, expectedBinding)) {
      throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
    }

    const storedActions = JSON.stringify(redactActionStructuredValue(decision.actions, ['actions']).value);
    const storedReasons = JSON.stringify(redactActionStructuredValue(decision.reasons, ['reasons']).value);
    const storedSuppressors = JSON.stringify(redactActionStructuredValue(decision.suppressors, ['suppressors']).value);
    const evaluatorPassed = decision.evaluatorPassed === undefined ? null : decision.evaluatorPassed ? 1 : 0;
    if (
      row.id !== decision.id
      || row.turn_id !== decision.turnId
      || row.decided_by !== decision.decidedBy
      || row.risk_level !== decision.riskLevel
      || row.confidence !== decision.confidence
      || row.evaluator_required !== (decision.evaluatorRequired ? 1 : 0)
      || row.evaluator_passed !== evaluatorPassed
      || row.evaluator_decision_id !== (decision.evaluatorDecisionId ?? null)
      || row.actions !== storedActions
      || row.reasons !== storedReasons
      || row.suppressors !== storedSuppressors
      || row.created_at !== decision.createdAt.getTime()
      || row.turn_action_decision_id !== decision.id
    ) {
      throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
    }

    this.assertLinkedEvaluatorAuthority(row, decision);
    return toActionTurnSource(row.turn_id, turnAuthority);
  }

  private assertLinkedEvaluatorAuthority(
    row: ActionDecisionBindingRow,
    decision: ActionDecision,
  ): void {
    if (!decision.evaluatorRequired) {
      if (
        decision.decidedBy === 'evaluator'
        || decision.evaluatorPassed !== undefined
        || decision.evaluatorDecisionId !== undefined
        || row.linked_evaluator_id !== null
      ) {
        throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
      }
      return;
    }

    if (!decision.evaluatorDecisionId) {
      if (
        decision.decidedBy === 'evaluator'
        || decision.evaluatorPassed === true
        || row.linked_evaluator_id !== null
      ) {
        throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
      }
      return;
    }

    if (
      decision.decidedBy !== 'evaluator'
      || row.linked_evaluator_id !== decision.evaluatorDecisionId
      || row.evaluator_domain !== 'social'
      || row.evaluator_turn_id !== decision.turnId
      || row.evaluator_risk_level !== decision.riskLevel
      || row.evaluator_confidence !== decision.confidence
    ) {
      throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
    }

    const evaluatorPassed = row.evaluator_decision !== null
      && isPassingEvaluatorDecision(row.evaluator_decision);
    if (decision.evaluatorPassed !== evaluatorPassed) {
      throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
    }

    if (!evaluatorPassed && decision.actions.some((action) => action.type !== 'silent_store')) {
      throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
    }
  }
}

function validateDecisionAuthority(
  db: Database.Database,
  input: CreateActionDecisionInput,
  turnAuthority: TurnExecutionAuthority,
): void {
  if (input.evaluatorEvidence) {
    validateEvaluatorEvidence(db, input, turnAuthority);
    return;
  }

  if (
    input.decidedBy === 'evaluator'
    || input.evaluatorPassed === true
    || (input.evaluatorPassed === false && !input.evaluatorRequired)
  ) {
    throw new Error('Action decision evaluator evidence is required');
  }

}

function validateEvaluatorEvidence(
  db: Database.Database,
  input: CreateActionDecisionInput,
  turnAuthority: TurnExecutionAuthority,
): void {
  const evidence = input.evaluatorEvidence;
  if (!evidence) {
    return;
  }

  if (evidence.request.turnId !== input.turnId) {
    throw new Error('Evaluator request turn does not match action decision turn');
  }

  if (evidence.result.requestId !== evidence.request.requestId) {
    throw new Error('Evaluator result request does not match evaluator request');
  }

  const requestDomain = String(evidence.request.domain);
  const resultDomain = String(evidence.result.domain);
  if (requestDomain !== 'social' || resultDomain !== 'social') {
    throw new Error('Evaluator evidence domain must be social');
  }

  if (input.decidedBy !== 'evaluator') {
    throw new Error('Evaluator evidence requires decidedBy=evaluator');
  }

  if (!input.evaluatorRequired) {
    throw new Error('Evaluator evidence requires evaluatorRequired=true');
  }

  const evaluatorPassed = isPassingEvaluatorDecision(evidence.result.decision);
  if (input.evaluatorPassed !== evaluatorPassed) {
    throw new Error('Action evaluatorPassed does not match evaluator decision');
  }

  if (input.riskLevel !== evidence.result.riskLevel) {
    throw new Error('Action riskLevel does not match evaluator result');
  }

  if (input.confidence !== evidence.result.confidence) {
    throw new Error('Action confidence does not match evaluator result');
  }

  if (evaluatorPassed && evidence.result.riskLevel === 'prohibited') {
    throw new Error('Passing evaluator evidence cannot have prohibited risk');
  }

  const sourceEventIds = evidence.request.sourceEventIds;
  if (
    !Array.isArray(sourceEventIds)
    || !sourceEventIds.every((sourceEventId) => typeof sourceEventId === 'string' && sourceEventId.length > 0)
  ) {
    throw new Error('Evaluator source event IDs are invalid');
  }

  if (!sourceEventIds.includes(turnAuthority.triggerEventId)) {
    throw new Error('Evaluator source events must include the turn trigger event');
  }

  const sourceExists = db.prepare('SELECT 1 FROM raw_events WHERE id = ?');
  for (const sourceEventId of sourceEventIds) {
    if (!sourceExists.get(sourceEventId)) {
      throw new Error('Evaluator source event does not exist');
    }
  }

  if (!evaluatorPassed && input.actions.some((action) => action.type !== 'silent_store')) {
    throw new Error('Non-passing evaluator evidence may only persist silent_store actions');
  }

  if (evaluatorPassed) {
    const authorized = applyPassingSocialEvaluation(
      [evidence.request.proposedAction],
      evidence.result,
    ).actions;
    if (
      !isDeepStrictEqual(input.actions, authorized)
      && !isCanonicalCooldownSuppression(authorized, input.actions, input.suppressors)
    ) {
      throw new Error('Action plan does not match evaluator-authorized action');
    }
  }
}

function isPassingEvaluatorDecision(decision: string): boolean {
  return decision === 'approve' || decision === 'downgrade';
}

const COOLDOWN_ELIGIBLE_ACTION_TYPES = new Set<ActionType>([
  'reply_short',
  'reply_full',
  'reply_with_tool',
  'dm_user',
  'react_only',
  'send_folded_forward',
]);

function isCanonicalCooldownSuppression(
  authorizedActions: ActionPlan[],
  finalActions: ActionPlan[],
  suppressors: string[],
): boolean {
  if (
    authorizedActions.length !== finalActions.length
    || finalActions.some((action) => action.type !== 'silent_store')
  ) {
    return false;
  }

  return finalActions.every((action, index) => {
    const authorized = authorizedActions[index];
    if (!authorized) {
      return false;
    }
    if (isDeepStrictEqual(action, authorized)) {
      return true;
    }

    const cooldownKey = authorized.constraints.cooldownKey;
    const cooldownSeconds = authorized.constraints.cooldownSeconds;
    const reasonPrefix = `Downgraded from ${authorized.type}; cooldown active for `;
    const activeActionType = action.reason.startsWith(reasonPrefix)
      ? action.reason.slice(reasonPrefix.length) as ActionType
      : undefined;
    if (
      !COOLDOWN_ELIGIBLE_ACTION_TYPES.has(authorized.type)
      || !activeActionType
      || !COOLDOWN_ELIGIBLE_ACTION_TYPES.has(activeActionType)
      || typeof cooldownKey !== 'string'
      || cooldownKey.length === 0
      || !Number.isFinite(cooldownSeconds)
      || (cooldownSeconds ?? 0) <= 0
      || !suppressors.includes(`cooldown:${cooldownKey}`)
    ) {
      return false;
    }

    const expectedAction: ActionPlan = {
      type: 'silent_store',
      priority: authorized.priority,
      target: authorized.target,
      constraints: {
        ...authorized.constraints,
        cooldownKey,
      },
      reason: action.reason,
    };
    return isDeepStrictEqual(action, expectedAction);
  });
}

function constantTimeBindingEqual(left: string, right: string): boolean {
  if (!left.startsWith('v1:') || !right.startsWith('v1:')) {
    return false;
  }

  const leftDigest = left.slice(3);
  const rightDigest = right.slice(3);
  if (!/^[a-f0-9]{64}$/.test(leftDigest) || !/^[a-f0-9]{64}$/.test(rightDigest)) {
    return false;
  }

  const leftBytes = Buffer.from(leftDigest, 'hex');
  const rightBytes = Buffer.from(rightDigest, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function canonicalizeExecutionDecision(
  decision: ActionDecision,
  evaluatorAuthority: EvaluatorExecutionAuthority | undefined,
  turnAuthority: TurnExecutionAuthority,
): string {
  if (!(decision.createdAt instanceof Date) || !Number.isFinite(decision.createdAt.getTime())) {
    throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
  }

  return JSON.stringify(toCanonicalNode({
    decision: {
      id: decision.id,
      turnId: decision.turnId,
      createdAt: decision.createdAt,
      decidedBy: decision.decidedBy,
      actions: decision.actions,
      riskLevel: decision.riskLevel,
      confidence: decision.confidence,
      reasons: decision.reasons,
      suppressors: decision.suppressors,
      evaluatorRequired: decision.evaluatorRequired,
      evaluatorPassed: decision.evaluatorPassed,
      evaluatorDecisionId: decision.evaluatorDecisionId,
      evaluatorPromptId: decision.evaluatorPromptId,
    },
    evaluatorAuthority,
    turnAuthority,
  }));
}

function readTurnExecutionAuthority(
  db: Database.Database,
  turnId: string,
): TurnExecutionAuthority {
  const row = db
    .prepare(
      `SELECT turn.conversation_id,
              turn.trigger_event_id,
              trigger.conversation_id AS trigger_raw_conversation_id,
              (SELECT COUNT(*)
                 FROM chat_messages AS trigger_chat
                WHERE trigger_chat.raw_event_id = turn.trigger_event_id) AS trigger_chat_count,
              (SELECT trigger_chat.conversation_id
                 FROM chat_messages AS trigger_chat
                WHERE trigger_chat.raw_event_id = turn.trigger_event_id
                ORDER BY trigger_chat.id
                LIMIT 1) AS trigger_chat_conversation_id,
              (SELECT trigger_chat.conversation_type
                 FROM chat_messages AS trigger_chat
                WHERE trigger_chat.raw_event_id = turn.trigger_event_id
                ORDER BY trigger_chat.id
                LIMIT 1) AS trigger_chat_conversation_type,
              (SELECT trigger_chat.group_id
                 FROM chat_messages AS trigger_chat
                WHERE trigger_chat.raw_event_id = turn.trigger_event_id
                ORDER BY trigger_chat.id
                LIMIT 1) AS trigger_chat_group_id
         FROM agent_turns AS turn
         JOIN raw_events AS trigger
           ON trigger.id = turn.trigger_event_id
        WHERE turn.id = ?`,
    )
    .get(turnId) as {
      conversation_id: string;
      trigger_event_id: string;
      trigger_raw_conversation_id: string | null;
      trigger_chat_count: number;
      trigger_chat_conversation_id: string | null;
      trigger_chat_conversation_type: string | null;
      trigger_chat_group_id: string | null;
    } | undefined;
  if (!row) {
    throw new Error('Action decision turn does not exist');
  }

  return {
    conversationId: row.conversation_id,
    triggerEventId: row.trigger_event_id,
    rawConversationId: row.trigger_raw_conversation_id,
    chatCount: row.trigger_chat_count,
    chatConversationId: row.trigger_chat_conversation_id,
    chatConversationType: row.trigger_chat_conversation_type,
    chatGroupId: row.trigger_chat_group_id,
  };
}

function buildTurnExecutionAuthorityFromRow(
  row: ActionDecisionBindingRow,
): TurnExecutionAuthority {
  return {
    conversationId: row.turn_conversation_id,
    triggerEventId: row.turn_trigger_event_id,
    rawConversationId: row.trigger_raw_conversation_id,
    chatCount: row.trigger_chat_count,
    chatConversationId: row.trigger_chat_conversation_id,
    chatConversationType: row.trigger_chat_conversation_type,
    chatGroupId: row.trigger_chat_group_id,
  };
}

function toActionTurnSource(
  turnId: string,
  authority: TurnExecutionAuthority,
): ActionTurnSource {
  const source: ActionTurnSource = {
    turnId,
    conversationId: authority.conversationId,
    triggerEventId: authority.triggerEventId,
  };
  if (
    authority.chatCount !== 1
    || authority.rawConversationId !== authority.conversationId
    || authority.chatConversationId !== authority.conversationId
  ) {
    return source;
  }

  if (authority.chatConversationType === 'private' && authority.chatGroupId === null) {
    return { ...source, conversationType: 'private' };
  }
  if (
    authority.chatConversationType === 'group'
    && typeof authority.chatGroupId === 'string'
    && authority.chatGroupId.length > 0
    && authority.chatGroupId.trim() === authority.chatGroupId
  ) {
    return { ...source, conversationType: 'group', groupId: authority.chatGroupId };
  }
  return source;
}

function buildEvaluatorAuthorityFromEvidence(
  evidence: SocialEvaluatorEvidence,
): EvaluatorExecutionAuthority {
  return {
    decisionId: evidence.result.decisionId,
    requestId: evidence.result.requestId,
    domain: evidence.request.domain,
    turnId: evidence.request.turnId,
    outcome: evidence.result.decision,
    reason: sanitizeEvaluatorNarrative(evidence.result.reason),
    confidence: evidence.result.confidence,
    riskLevel: evidence.result.riskLevel,
    evaluatorVersion: evidence.result.evaluatorVersion,
    modelInvocationId: evidence.result.modelInvocationId ?? null,
    actorUserId: evidence.request.actor.canonicalUserId ?? null,
    actorClass: evidence.request.actor.actorClass,
    invocationContext: evidence.request.context,
    sourceEventIdsJson: JSON.stringify(evidence.request.sourceEventIds),
    requestCreatedAt: evidence.request.createdAt.getTime(),
    decidedAt: evidence.result.decidedAt.getTime(),
  };
}

function buildEvaluatorAuthorityFromRow(
  row: ActionDecisionBindingRow,
): EvaluatorExecutionAuthority | undefined {
  if (row.linked_evaluator_id === null) {
    return undefined;
  }

  if (
    row.evaluator_request_id === null
    || row.evaluator_domain === null
    || row.evaluator_turn_id === null
    || row.evaluator_decision === null
    || row.evaluator_reason === null
    || row.evaluator_risk_level === null
    || row.evaluator_confidence === null
    || row.evaluator_version === null
    || row.evaluator_actor_class === null
    || row.evaluator_invocation_context === null
    || row.evaluator_source_event_ids === null
    || row.evaluator_request_created_at === null
    || row.evaluator_decided_at === null
  ) {
    throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
  }

  return {
    decisionId: row.linked_evaluator_id,
    requestId: row.evaluator_request_id,
    domain: row.evaluator_domain,
    turnId: row.evaluator_turn_id,
    outcome: row.evaluator_decision,
    reason: row.evaluator_reason,
    confidence: row.evaluator_confidence,
    riskLevel: row.evaluator_risk_level,
    evaluatorVersion: row.evaluator_version,
    modelInvocationId: row.evaluator_model_invocation_id,
    actorUserId: row.evaluator_actor_user_id,
    actorClass: row.evaluator_actor_class,
    invocationContext: row.evaluator_invocation_context,
    sourceEventIdsJson: row.evaluator_source_event_ids,
    requestCreatedAt: row.evaluator_request_created_at,
    decidedAt: row.evaluator_decided_at,
  };
}

function toCanonicalNode(value: unknown): unknown {
  if (value === undefined) {
    return ['undefined'];
  }
  if (value === null) {
    return ['null'];
  }
  if (typeof value === 'string') {
    return ['string', value];
  }
  if (typeof value === 'boolean') {
    return ['boolean', value];
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
    }
    return ['number', Object.is(value, -0) ? '-0' : String(value)];
  }
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (!Number.isFinite(timestamp)) {
      throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
    }
    return ['date', String(timestamp)];
  }
  if (Array.isArray(value)) {
    return ['array', value.map((item) => toCanonicalNode(item))];
  }
  if (isPlainRecord(value)) {
    return [
      'object',
      Object.keys(value)
        .sort()
        .map((key) => [key, toCanonicalNode(value[key])]),
    ];
  }

  throw new Error(INVALID_EXECUTION_BINDING_MESSAGE);
}

function buildExecutedResult(
  input: Pick<CreateActionExecutionInput, 'executedMessageId' | 'executedMemoryId' | 'executedJobId'>,
): ActionExecutionResult['executed'] | undefined {
  const executed: NonNullable<ActionExecutionResult['executed']> = {};

  if (input.executedMessageId) {
    executed.messageId = input.executedMessageId;
  }

  if (input.executedMemoryId) {
    executed.memoryId = input.executedMemoryId;
  }

  if (input.executedJobId) {
    executed.jobId = input.executedJobId;
  }

  return Object.keys(executed).length > 0 ? executed : undefined;
}

interface RedactedActionValue {
  value: unknown;
  redacted: boolean;
}

function redactActionStructuredValue(value: unknown, path: string[] = []): RedactedActionValue {
  if (typeof value === 'string') {
    if (isActionTargetIdentifierPath(path) || isActionControlLookupKeyPath(path, value)) {
      return { value, redacted: false };
    }

    const redacted = redactActionText(value);
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
      const result = redactActionStructuredValue(item, path);
      redacted = redacted || result.redacted;
      return result.value;
    });
    return { value: items, redacted };
  }

  if (isPlainRecord(value)) {
    let redacted = false;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const redactedKey = redactActionText(key);
      const childResult = redactActionStructuredValue(child, [...path, key]);
      redacted = redacted || redactedKey.redacted || childResult.redacted;
      result[redactedKey.text] = childResult.value;
    }
    return { value: result, redacted };
  }

  return { value, redacted: false };
}

function redactActionText(text: string): { text: string; redacted: boolean } {
  const initialPlatformRedacted = redactPlatformIdentifiers(text);
  const secretRedacted = redactSecretsInText(initialPlatformRedacted);
  const platformRedacted = redactPlatformIdentifiers(secretRedacted.text);
  const platformMarkerLost =
    initialPlatformRedacted.includes('[REDACTED:platform_id]')
    && !platformRedacted.includes('[REDACTED:platform_id]');
  const redactedText = platformMarkerLost
    ? `${platformRedacted} [REDACTED:platform_id]`
    : platformRedacted;

  return {
    text: redactedText,
    redacted:
      initialPlatformRedacted !== text
      || secretRedacted.findings.length > 0
      || platformRedacted !== secretRedacted.text
      || platformMarkerLost,
  };
}

export function sanitizeEvaluatorNarrative(text: string): string {
  const redacted = redactActionText(text).text;
  if (redacted.length <= MAX_EVALUATOR_REASON_LENGTH) {
    return redacted;
  }

  const marker = ' [TRUNCATED]';
  return `${redacted.slice(0, MAX_EVALUATOR_REASON_LENGTH - marker.length)}${marker}`;
}

function redactPlatformIdentifiers(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function shouldRedactNumericPlatformId(path: string[], value: number): boolean {
  return Number.isInteger(value)
    && isPlatformIdField(path)
    && /^\d{8,12}$/.test(String(Math.abs(value)));
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

function isActionTargetIdentifierPath(path: string[]): boolean {
  if (path.length < 2) {
    return false;
  }

  const key = path.at(-1);
  const parent = path.at(-2);
  return parent === 'target' && (
    key === 'conversationId'
    || key === 'userId'
    || key === 'canonicalUserId'
    || key === 'groupId'
  );
}

function isActionControlLookupKeyPath(path: string[], value: string): boolean {
  const key = path.at(-1);
  const parent = path.at(-2);

  if (parent === 'constraints' && key === 'cooldownKey') {
    return isCooldownKey(value);
  }

  if (key === 'suppressors' && value.startsWith('cooldown:')) {
    return isCooldownKey(value.slice('cooldown:'.length));
  }

  return false;
}

function isCooldownKey(value: string): boolean {
  const actionTypes = [
    'reply_short',
    'reply_full',
    'reply_with_tool',
    'dm_user',
    'react_only',
    'send_folded_forward',
  ].join('|');
  const platformConversation = '(?:group:qq-group-\\d{5,12}|private:(?:private:)?qq-\\d{5,12})';
  return new RegExp(`^${platformConversation}:(?:${actionTypes})$`).test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
