/**
 * Tool Call Repository
 *
 * Persists tool execution attempts linked to agent turns. This complements the
 * audit log: audit rows explain policy/governance, while tool_calls provides a
 * structured per-call execution ledger for queries and FK checks.
 */

import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import { redactSecretsInText } from '../memory/secret-scan.js';
import type { ActorClass, InvocationContext, ToolCallResult } from '../types/tool.js';

export interface ToolCallRecordInput {
  id?: string;
  turnId: string;
  evaluatorDecisionId?: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  requestedBy: 'pi' | 'evaluator' | 'user' | 'system';
  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
  };
  context: InvocationContext;
  status: ToolCallResult['status'];
  errorCode?: string;
  errorMessage?: string;
  executionTimeMs?: number;
  secretsRedacted: boolean;
  createdAt?: number;
}

export interface ToolCallRecord {
  id: string;
  turnId: string;
  evaluatorDecisionId?: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  requestedBy: ToolCallRecordInput['requestedBy'];
  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
  };
  context: InvocationContext;
  status: ToolCallResult['status'];
  errorCode?: string;
  errorMessage?: string;
  executionTimeMs?: number;
  secretsRedacted: boolean;
  createdAt: Date;
}

interface ToolCallRow {
  id: string;
  turn_id: string;
  evaluator_decision_id: string | null;
  tool_name: string;
  input: string;
  output: string | null;
  requested_by: ToolCallRecordInput['requestedBy'];
  actor_user_id: string | null;
  actor_class: ActorClass;
  invocation_context: InvocationContext;
  status: ToolCallResult['status'];
  error_code: string | null;
  error_message: string | null;
  execution_time_ms: number | null;
  secrets_redacted: number;
  created_at: number;
}

export class ToolCallRepository {
  constructor(private readonly db: Database.Database) {}

  async create(input: ToolCallRecordInput): Promise<string> {
    return this.createSync(input);
  }

  createSync(input: ToolCallRecordInput): string {
    const id = input.id ?? ulid();
    const createdAt = input.createdAt ?? Date.now();
    const storedInput = redactStoredToolCallValue(input.input ?? null);
    const storedOutput = input.output === undefined ? undefined : redactStoredToolCallValue(input.output);
    const errorCode = input.errorCode === undefined ? undefined : redactToolCallText(input.errorCode);
    const errorMessage = input.errorMessage === undefined ? undefined : redactToolCallText(input.errorMessage);
    const secretsRedacted = input.secretsRedacted
      || storedInput.redacted
      || Boolean(storedOutput?.redacted)
      || Boolean(errorCode?.redacted)
      || Boolean(errorMessage?.redacted);

    this.db
      .prepare(
        `INSERT INTO tool_calls (
          id, turn_id, evaluator_decision_id, tool_name, input, output,
          requested_by, actor_user_id, actor_class, invocation_context,
          status, error_code, error_message, execution_time_ms,
          secrets_redacted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.turnId,
        input.evaluatorDecisionId ?? null,
        input.toolName,
        JSON.stringify(storedInput.value),
        storedOutput === undefined ? null : JSON.stringify(storedOutput.value),
        input.requestedBy,
        input.actor.canonicalUserId ?? null,
        input.actor.actorClass,
        input.context,
        input.status,
        errorCode?.text ?? null,
        errorMessage?.text ?? null,
        input.executionTimeMs ?? null,
        secretsRedacted ? 1 : 0,
        createdAt
      );

    return id;
  }

  async findById(id: string): Promise<ToolCallRecord | null> {
    const row = this.db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as ToolCallRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async listByTurnId(turnId: string): Promise<ToolCallRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM tool_calls WHERE turn_id = ? ORDER BY created_at ASC, id ASC')
      .all(turnId) as ToolCallRow[];

    return rows.map((row) => this.rowToRecord(row));
  }

  private rowToRecord(row: ToolCallRow): ToolCallRecord {
    const output = row.output === null ? undefined : JSON.parse(row.output) as unknown;

    return {
      id: row.id,
      turnId: row.turn_id,
      evaluatorDecisionId: row.evaluator_decision_id ?? undefined,
      toolName: row.tool_name,
      input: JSON.parse(row.input) as unknown,
      output,
      requestedBy: row.requested_by,
      actor: {
        canonicalUserId: row.actor_user_id ?? undefined,
        actorClass: row.actor_class,
      },
      context: row.invocation_context,
      status: row.status,
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      executionTimeMs: row.execution_time_ms ?? undefined,
      secretsRedacted: Boolean(row.secrets_redacted),
      createdAt: new Date(row.created_at),
    };
  }
}

interface RedactedStoredToolCallValue {
  value: unknown;
  redacted: boolean;
}

function redactStoredToolCallValue(value: unknown, path: string[] = []): RedactedStoredToolCallValue {
  if (typeof value === 'string') {
    const redacted = redactToolCallText(value);
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
      const result = redactStoredToolCallValue(item, path);
      redacted = redacted || result.redacted;
      return result.value;
    });
    return { value: items, redacted };
  }

  if (isPlainRecord(value)) {
    let redacted = false;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const redactedKey = redactToolCallText(key);
      const childResult = redactStoredToolCallValue(child, [...path, key]);
      redacted = redacted || redactedKey.redacted || childResult.redacted;
      result[redactedKey.text] = childResult.value;
    }
    return { value: result, redacted };
  }

  return { value, redacted: false };
}

function redactToolCallText(text: string): { text: string; redacted: boolean } {
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
