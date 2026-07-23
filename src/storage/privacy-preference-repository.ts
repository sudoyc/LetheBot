/**
 * Durable user privacy preferences.
 *
 * Stores opt-outs that must be enforced outside prompt context:
 * - proactive DM opt-out;
 * - memory-association opt-out.
 */

import type Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import { redactSecretsInText } from '../memory/secret-scan.js';
import type { ActorClass, InvocationContext } from '../types/tool.js';

export type PrivacyPreferenceType = 'proactive_dm' | 'memory_association';
export type PrivacyPreferenceState = 'opted_in' | 'opted_out';

export interface PrivacyPreferenceRecord {
  canonicalUserId: string;
  preferenceType: PrivacyPreferenceType;
  state: PrivacyPreferenceState;
  reason?: string;
  updatedBy?: {
    canonicalUserId?: string;
    actorClass: ActorClass;
    context: InvocationContext;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface PrivacyPreferenceActor {
  canonicalUserId?: string;
  actorClass: ActorClass;
  context: InvocationContext;
}

export interface SetPrivacyPreferenceInput {
  canonicalUserId: string;
  preferenceType: PrivacyPreferenceType;
  state: PrivacyPreferenceState;
  reason?: string;
  actor: PrivacyPreferenceActor;
  now?: number;
}

export interface ListPrivacyPreferenceOptions {
  canonicalUserId?: string;
  preferenceType?: PrivacyPreferenceType;
  state?: PrivacyPreferenceState;
  limit?: number;
}

interface PrivacyPreferenceRow {
  canonical_user_id: string;
  preference_type: PrivacyPreferenceType;
  state: PrivacyPreferenceState;
  reason: string | null;
  updated_by_user_id: string | null;
  updated_by_actor_class: ActorClass;
  updated_by_context: InvocationContext;
  created_at: number;
  updated_at: number;
}

export class PrivacyPreferenceRepository {
  constructor(private readonly db: Database.Database) {}

  setPreference(input: SetPrivacyPreferenceInput): void {
    const now = input.now ?? Date.now();
    const safeReason = input.reason ? redactPrivacyPreferenceText(input.reason) : undefined;

    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO privacy_preferences (
            canonical_user_id, preference_type, state, reason,
            updated_by_user_id, updated_by_actor_class, updated_by_context,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(canonical_user_id, preference_type) DO UPDATE SET
            state = excluded.state,
            reason = excluded.reason,
            updated_by_user_id = excluded.updated_by_user_id,
            updated_by_actor_class = excluded.updated_by_actor_class,
            updated_by_context = excluded.updated_by_context,
            updated_at = excluded.updated_at`
        )
        .run(
          input.canonicalUserId,
          input.preferenceType,
          input.state,
          safeReason ?? null,
          input.actor.canonicalUserId ?? null,
          input.actor.actorClass,
          input.actor.context,
          now,
          now
        );

      this.insertAudit({ ...input, reason: safeReason }, now);
    });

    transaction();
  }

  setOptOut(input: Omit<SetPrivacyPreferenceInput, 'state'>): void {
    this.setPreference({ ...input, state: 'opted_out' });
  }

  clearOptOut(input: Omit<SetPrivacyPreferenceInput, 'state'>): void {
    this.setPreference({ ...input, state: 'opted_in' });
  }

  async isOptedOut(canonicalUserId: string, preferenceType: PrivacyPreferenceType): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT state
         FROM privacy_preferences
         WHERE canonical_user_id = ? AND preference_type = ?
         LIMIT 1`
      )
      .get(canonicalUserId, preferenceType) as { state: PrivacyPreferenceState } | undefined;

    return row?.state === 'opted_out';
  }

  find(canonicalUserId: string, preferenceType: PrivacyPreferenceType): PrivacyPreferenceRecord | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM privacy_preferences
         WHERE canonical_user_id = ? AND preference_type = ?
         LIMIT 1`
      )
      .get(canonicalUserId, preferenceType) as PrivacyPreferenceRow | undefined;

    return row ? this.rowToRecord(row) : null;
  }

  list(options: ListPrivacyPreferenceOptions = {}): PrivacyPreferenceRecord[] {
    const params: unknown[] = [];
    let query = 'SELECT * FROM privacy_preferences WHERE 1=1';

    if (options.canonicalUserId) {
      query += ' AND canonical_user_id = ?';
      params.push(options.canonicalUserId);
    }

    if (options.preferenceType) {
      query += ' AND preference_type = ?';
      params.push(options.preferenceType);
    }

    if (options.state) {
      query += ' AND state = ?';
      params.push(options.state);
    }

    query += ' ORDER BY updated_at DESC, canonical_user_id ASC, preference_type ASC LIMIT ?';
    params.push(options.limit ?? 100);

    return (this.db.prepare(query).all(...params) as PrivacyPreferenceRow[]).map((row) => this.rowToRecord(row));
  }

  private insertAudit(input: SetPrivacyPreferenceInput, now: number): void {
    const eventId = `${input.canonicalUserId}:${input.preferenceType}`;
    this.db
      .prepare(
        `INSERT INTO audit_log (
          id, timestamp, category, level, event_type, event_id,
          actor_user_id, actor_class, invocation_context,
          summary, details, redacted, risk_level, evaluator_decision_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ulid(),
        now,
        'system',
        'summary',
        'privacy.preference_set',
        eventId,
        input.actor.canonicalUserId ?? null,
        input.actor.actorClass,
        input.actor.context,
        `Set ${input.preferenceType} privacy preference to ${input.state}`,
        JSON.stringify({
          canonicalUserId: redactPrivacyPreferenceText(input.canonicalUserId),
          preferenceType: input.preferenceType,
          state: input.state,
          reason: input.reason,
        }),
        1,
        'medium',
        null
      );
  }

  private rowToRecord(row: PrivacyPreferenceRow): PrivacyPreferenceRecord {
    return {
      canonicalUserId: row.canonical_user_id,
      preferenceType: row.preference_type,
      state: row.state,
      reason: row.reason ?? undefined,
      updatedBy: {
        canonicalUserId: row.updated_by_user_id ?? undefined,
        actorClass: row.updated_by_actor_class,
        context: row.updated_by_context,
      },
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

function redactPrivacyPreferenceText(text: string): string {
  const platformRedacted = redactPlatformIdentifiers(text);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]') && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactPlatformIdentifiers(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}
