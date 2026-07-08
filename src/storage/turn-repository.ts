/**
 * Agent turn repository.
 *
 * Persists the lifecycle of one reasoning/response candidate.
 */

import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import { redactSecretsInText } from '../memory/secret-scan';
import type { AgentTurn } from '../types/agent';

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

  async markCompleted(id: string, input: CompleteAgentTurnInput): Promise<void> {
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
