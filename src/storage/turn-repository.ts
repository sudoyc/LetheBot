/**
 * Agent turn repository.
 *
 * Persists the lifecycle of one reasoning/response candidate.
 */

import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import { redactSecretsInText } from '../memory/secret-scan.js';
import type { AgentTurn } from '../types/agent.js';

export interface CreateAgentTurnInput {
  id?: string;
  conversationId: string;
  triggerEventId: string;
  piModel: string;
  piProvider: string;
  startedAt?: Date;
}

export interface CompleteAgentTurnInput {
  responseText?: string;
  tokensUsed: AgentTurn['tokensUsed'];
  completedAt?: Date;
}

export interface CompleteAgentTurnFromPiInvocationsInput {
  responseText?: string;
  completedAt?: Date;
}

interface PiInvocationSettlementRow {
  call_number: number;
  provider: string;
  model: string;
  status: string;
  completed_at: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
}

export class TurnRepository {
  constructor(private readonly db: Database.Database) {}

  async createPending(input: CreateAgentTurnInput): Promise<string> {
    const id = input.id ?? ulid();
    const startedAt = input.startedAt ?? new Date();

    this.db
      .prepare(
        `INSERT INTO agent_turns (
          id, conversation_id, trigger_event_id, context_pack_id,
          pi_model, pi_provider, action_decision_id, response_text,
          status, tokens_input, tokens_output, tokens_total,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId,
        input.triggerEventId,
        null,
        input.piModel,
        input.piProvider,
        null,
        null,
        'pending',
        null,
        null,
        null,
        startedAt.getTime(),
        null
      );

    return id;
  }

  async markRunning(id: string, contextPackId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE agent_turns
         SET status = ?, context_pack_id = ?
         WHERE id = ?`
      )
      .run('running', contextPackId, id);
  }

  markCompleted(id: string, input: CompleteAgentTurnInput): void {
    const completedAt = input.completedAt ?? new Date();

    this.db
      .prepare(
        `UPDATE agent_turns
         SET status = ?,
             response_text = ?,
             tokens_input = ?,
             tokens_output = ?,
             tokens_total = ?,
             completed_at = ?
         WHERE id = ?`
      )
      .run(
        'completed',
        input.responseText ?? null,
        input.tokensUsed.input,
        input.tokensUsed.output,
        input.tokensUsed.total,
        completedAt.getTime(),
        id
      );
  }

  markCompletedFromPiInvocations(
    id: string,
    input: CompleteAgentTurnFromPiInvocationsInput = {},
  ): void {
    const settle = (): void => {
      const turn = this.db.prepare(
        `SELECT status, pi_provider, pi_model, started_at
           FROM agent_turns
          WHERE id = ?`,
      ).get(id) as {
        status: string;
        pi_provider: string;
        pi_model: string;
        started_at: number;
      } | undefined;

      if (!turn) {
        throw new Error('Agent turn does not exist');
      }
      if (turn.status === 'completed') {
        return;
      }
      if (turn.status !== 'running') {
        throw new Error('Pi-backed turn must be running before completion');
      }

      const rows = this.db.prepare(
        `SELECT call_number, provider, model, status, completed_at,
                tokens_input, tokens_output, tokens_total
           FROM model_invocations
          WHERE turn_id = ? AND purpose = 'pi_turn'
          ORDER BY call_number ASC`,
      ).all(id) as PiInvocationSettlementRow[];
      if (rows.length === 0) {
        throw new Error('Pi-backed turn has no invocation evidence');
      }

      let knownUsage = true;
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      rows.forEach((row, index) => {
        if (row.call_number !== index + 1) {
          throw new Error('Pi-backed invocation ordinals are not gap-free');
        }
        if (row.provider !== turn.pi_provider || row.model !== turn.pi_model) {
          throw new Error('Pi-backed invocation provider or model does not match its turn');
        }
        if (row.status !== 'completed' || row.completed_at === null) {
          throw new Error('Pi-backed turn has an invocation that did not complete');
        }

        const tokenValues = [row.tokens_input, row.tokens_output, row.tokens_total];
        if (tokenValues.every((value) => value === null)) {
          knownUsage = false;
          return;
        }
        if (tokenValues.some((value) => value === null)) {
          throw new Error('Pi-backed invocation has partial usage evidence');
        }
        if (tokenValues.some((value) => (
          !Number.isSafeInteger(value) || (value as number) < 0
        ))) {
          throw new Error('Pi-backed invocation usage evidence is invalid');
        }

        inputTokens += row.tokens_input as number;
        outputTokens += row.tokens_output as number;
        totalTokens += row.tokens_total as number;
      });
      if (![inputTokens, outputTokens, totalTokens].every(Number.isSafeInteger)) {
        throw new Error('Pi-backed invocation usage aggregate is invalid');
      }

      if (typeof input.responseText !== 'undefined' && typeof input.responseText !== 'string') {
        throw new Error('Response text is invalid');
      }
      const completedAtMs = (input.completedAt ?? new Date()).getTime();
      if (!Number.isFinite(completedAtMs) || completedAtMs < 0) {
        throw new Error('Completed timestamp is invalid');
      }
      const completedAt = Math.max(completedAtMs, turn.started_at);
      const result = this.db.prepare(
        `UPDATE agent_turns
            SET status = 'completed',
                response_text = ?,
                tokens_input = ?,
                tokens_output = ?,
                tokens_total = ?,
                completed_at = ?
          WHERE id = ? AND status = 'running'`,
      ).run(
        input.responseText ?? null,
        knownUsage ? inputTokens : null,
        knownUsage ? outputTokens : null,
        knownUsage ? totalTokens : null,
        completedAt,
        id,
      );
      if (result.changes !== 1) {
        throw new Error('Pi-backed turn is no longer running');
      }
    };

    if (this.db.inTransaction) {
      settle();
      return;
    }

    const transaction = this.db.transaction(settle);
    transaction.immediate();
  }

  async markFailed(id: string, errorMessage: string, completedAt: Date = new Date()): Promise<void> {
    const redactedErrorMessage = redactTurnFailureText(errorMessage);

    this.db
      .prepare(
        `UPDATE agent_turns
         SET status = ?,
             response_text = ?,
             completed_at = ?
         WHERE id = ?`
      )
      .run('failed', redactedErrorMessage, completedAt.getTime(), id);
  }

  markAbortedByTriggerEvent(
    triggerEventId: string,
    reason: string,
    completedAt: Date = new Date(),
  ): number {
    const redactedReason = redactTurnFailureText(reason);

    return this.db
      .prepare(
        `UPDATE agent_turns
         SET status = 'aborted',
             response_text = ?,
             completed_at = ?
         WHERE trigger_event_id = ?
           AND status IN ('pending', 'running')`
      )
      .run(redactedReason, completedAt.getTime(), triggerEventId).changes;
  }
}

function redactTurnFailureText(text: string): string {
  const platformRedacted = redactPlatformIdentifiers(text);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactPlatformIdentifiers(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}
