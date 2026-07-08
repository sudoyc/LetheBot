/**
 * Action decision and execution repository.
 *
 * Persists structured social/tool/memory action plans and execution results.
 */

import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import { redactSecretsInText } from '../memory/secret-scan';
import type { ActionDecision, ActionExecutionResult, ActionPlan, ActionType } from '../types/action';

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
  createdAt?: Date;
}

export interface CreateActionExecutionInput {
  id?: string;
  actionDecisionId: string;
  actionType: ActionType;
  status: ActionExecutionResult['status'];
  executedMessageId?: string;
  downgradedFrom?: ActionType;
  downgradedReason?: string;
  error?: ActionExecutionResult['error'];
  auditLevel: ActionExecutionResult['auditLevel'];
  auditEntry?: string;
  executedAt?: Date;
}

export class ActionRepository {
  constructor(private readonly db: Database.Database) {}

  async createDecision(input: CreateActionDecisionInput): Promise<ActionDecision> {
    const id = input.id ?? ulid();
    const createdAt = input.createdAt ?? new Date();
    const storedActions = redactActionStructuredValue(input.actions, ['actions']);
    const storedReasons = redactActionStructuredValue(input.reasons, ['reasons']);
    const storedSuppressors = redactActionStructuredValue(input.suppressors, ['suppressors']);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO action_decisions (
            id, turn_id, decided_by, risk_level, confidence,
            evaluator_required, evaluator_passed,
            actions, reasons, suppressors, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.turnId,
          input.decidedBy,
          input.riskLevel,
          input.confidence,
          input.evaluatorRequired ? 1 : 0,
          input.evaluatorPassed === undefined ? null : input.evaluatorPassed ? 1 : 0,
          JSON.stringify(storedActions.value),
          JSON.stringify(storedReasons.value),
          JSON.stringify(storedSuppressors.value),
          createdAt.getTime()
        );

      this.db
        .prepare('UPDATE agent_turns SET action_decision_id = ? WHERE id = ?')
        .run(id, input.turnId);
    })();

    return {
      id,
      turnId: input.turnId,
      createdAt,
      decidedBy: input.decidedBy,
      actions: input.actions,
      riskLevel: input.riskLevel,
      confidence: input.confidence,
      reasons: input.reasons,
      suppressors: input.suppressors,
      evaluatorRequired: input.evaluatorRequired,
      evaluatorPassed: input.evaluatorPassed,
    };
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
          executed_message_id, downgraded_from, downgraded_reason,
          error_code, error_message,
          audit_level, audit_entry, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.actionDecisionId,
        input.actionType,
        input.status,
        input.executedMessageId ?? null,
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
      executed: input.executedMessageId ? { messageId: input.executedMessageId } : undefined,
      downgradedFrom: input.downgradedFrom,
      downgradedReason: input.downgradedReason,
      error: input.error,
      auditLevel: input.auditLevel,
      auditEntry: input.auditEntry,
    };
  }
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
