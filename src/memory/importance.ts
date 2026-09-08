import type Database from 'better-sqlite3';
import { parseStoredChatMessageReceived, type StoredChatEventRow } from '../ingestion/stored-chat-event.js';
import { hashMemoryMaintenanceValue } from './maintenance-candidate-snapshot.js';

const DAY = 86_400_000;
export const IMPORTANCE_WINDOW_DAYS = 30;
export const IMPORTANCE_EXPIRY_DAYS = 7;
export const IMPORTANCE_SOURCE_LIMIT = 200;

export interface ImportanceWindow {
  windowEndAt: number;
  windowEndOrder: number;
}

export interface MemoryImportanceSummary extends ImportanceWindow {
  scorerVersion: 1;
  windowStartAt: number;
  observationCount: number;
  distinctDayCount: number;
  spanDays: number;
  previousImportance: number;
  proposedImportance: number;
  evidenceFingerprint: string;
  sourceCount: number;
}

export interface MemoryImportanceSource {
  rawEventId: string;
  chatMessageId: string;
  fingerprint: string;
  timestamp: number;
  ingressAt: number;
  evidenceRole: 'support' | 'context';
}

export interface MemoryImportanceEvidence extends MemoryImportanceSummary {
  memoryId: string;
  memoryRevisionId: string;
  confidence: number;
  expiresAt: number;
  sources: MemoryImportanceSource[];
}

interface PreferenceStatement {
  verb: string;
  object: string;
  negative: boolean;
}

interface SourceRow extends StoredChatEventRow {
  created_at: number;
  ingestion_order: number;
  chat_id: string;
  message_id: string;
  chat_conversation_id: string;
  conversation_type: string;
  group_id: string | null;
  sender_id: string;
  text: string | null;
  chat_timestamp: number;
}

interface VerifiedSource {
  evidence: Omit<MemoryImportanceSource, 'evidenceRole'>;
  conversationId: string;
  groupId: string | null;
  text: string;
  statement: PreferenceStatement | null;
}

interface TargetRow {
  id: string;
  canonical_user_id: string;
  conversation_id: string;
  group_id: string | null;
  content: string;
  importance: number;
  confidence: number;
}

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ').replace(/[.!\u3002\uFF01]+$/u, '').trim();
}

function preferenceStatement(text: string): PreferenceStatement | null {
  if (text.length > 256 || /[\r\n?\uFF1F"\u201C\u201D\u300C\u300D`]/u.test(text)) return null;
  const normalized = normalize(text);
  const english = /^i (no longer |do not |don't )?(like|prefer|need|want) (.{2,120})$/u.exec(normalized);
  const chinese = /^\u6211(\u4e0d\u518d|\u4e0d)?(\u559c\u6b22|\u9700\u8981|\u60f3\u8981)\s*(.{2,120})$/u.exec(normalized);
  const match = english ?? chinese;
  if (!match?.[2] || !match[3]) return null;
  const object = match[3].trim();
  // Nested, conditional or reported claims are not unambiguous first-party evidence.
  if (/[,:;\uFF0C\uFF1A\uFF1B'!]/u.test(object)
    || /\b(?:if|unless|said|says|maybe|not|no longer)\b|\u5982\u679c|\u5047\u5982|\u542C\u8BF4|\u636E\u8BF4|\u4F46\u662F|\u4E0D\u662F|\u4E0D\u518D|\u6211/u.test(object)) return null;
  const verbs: Record<string, string> = { '\u559c\u6b22': 'like', '\u9700\u8981': 'need', '\u60f3\u8981': 'want' };
  return { verb: verbs[match[2]] ?? match[2], object, negative: Boolean(match[1]) };
}

function readSource(db: Database.Database, rawEventId: string, ownerId: string): VerifiedSource | null {
  const rows = db.prepare(`SELECT raw.*, raw.rowid AS ingestion_order, chat.id AS chat_id,
      chat.message_id, chat.conversation_id AS chat_conversation_id, chat.conversation_type,
      chat.group_id, chat.sender_id, chat.text, chat.timestamp AS chat_timestamp
    FROM raw_events raw JOIN chat_messages chat ON chat.raw_event_id = raw.id
    WHERE raw.id = ? LIMIT 2`).all(rawEventId) as SourceRow[];
  const row = rows[0];
  if (rows.length !== 1 || !row || row.text === null) return null;
  const parsed = parseStoredChatMessageReceived(row);
  if (!parsed.ok) return null;
  const message = parsed.event.message;
  if (message.messageId !== row.message_id || message.conversationId !== row.chat_conversation_id
    || message.conversationType !== row.conversation_type || (message.groupId ?? null) !== row.group_id
    || message.senderId !== row.sender_id || message.content.text !== row.text
    || row.timestamp !== row.chat_timestamp || !Number.isSafeInteger(row.created_at) || row.created_at < 0) return null;
  const accounts = db.prepare(`SELECT canonical_user_id FROM platform_accounts
    WHERE platform = 'qq' AND status = 'active'
      AND (platform_account_id = ? OR ('qq-' || platform_account_id) = ?) LIMIT 2`)
    .all(row.sender_id, row.sender_id) as Array<{ canonical_user_id: string }>;
  if (accounts.length !== 1 || accounts[0]?.canonical_user_id !== ownerId) return null;
  return {
    evidence: { rawEventId: row.id, chatMessageId: row.chat_id,
      fingerprint: hashMemoryMaintenanceValue({ row, ownerId }),
      timestamp: row.timestamp, ingressAt: row.created_at },
    conversationId: message.conversationId, groupId: row.group_id, text: row.text,
    statement: message.content.quote || message.content.media?.length || message.replyToMessageId
      ? null : preferenceStatement(row.text),
  };
}

function sameStatement(left: PreferenceStatement | null, right: PreferenceStatement): boolean {
  return left?.verb === right.verb && left.object === right.object && left.negative === right.negative;
}

function contradictsOrAmbiguous(source: VerifiedSource, target: PreferenceStatement): boolean {
  return normalize(source.text).includes(target.object) && !sameStatement(source.statement, target);
}

function sourceIds(db: Database.Database, target: TargetRow, condition: string, parameters: number[]): string[] {
  return db.prepare(`SELECT raw.id FROM raw_events raw JOIN chat_messages chat ON chat.raw_event_id = raw.id
    WHERE chat.conversation_id = ? AND chat.group_id IS ?
      AND EXISTS (SELECT 1 FROM platform_accounts account WHERE account.platform = 'qq'
        AND account.canonical_user_id = ? AND account.status = 'active'
        AND (account.platform_account_id = chat.sender_id OR ('qq-' || account.platform_account_id) = chat.sender_id))
      AND ${condition} ORDER BY raw.rowid, chat.id LIMIT ?`).pluck()
    .all(target.conversation_id, target.group_id, target.canonical_user_id, ...parameters, IMPORTANCE_SOURCE_LIMIT + 1) as string[];
}

export function readMemoryImportanceEvidence(
  db: Database.Database,
  memoryId: string,
  window: ImportanceWindow,
  nowMs: number,
): MemoryImportanceEvidence | null {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(window.windowEndAt)
    || window.windowEndAt < 0 || window.windowEndAt > nowMs || !Number.isSafeInteger(window.windowEndOrder)
    || window.windowEndOrder < 0) return null;
  const target = db.prepare(`SELECT id, canonical_user_id, conversation_id, group_id, content, importance, confidence
    FROM memory_records WHERE id = ? AND state = 'active' AND scope = 'user'
      AND kind = 'preference' AND authority = 'user_stated' AND confidence >= 0.6
      AND canonical_user_id IS NOT NULL AND conversation_id IS NOT NULL
      AND (subject_user_id IS NULL OR subject_user_id = canonical_user_id)
      AND sensitivity IN ('normal', 'personal') AND (expires_at IS NULL OR expires_at > ?)
      AND ((group_id IS NULL AND visibility IN ('private_only', 'same_user_any_context'))
        OR (group_id = conversation_id AND visibility = 'same_group_only'))
      AND NOT EXISTS (SELECT 1 FROM privacy_preferences preference
        WHERE preference.canonical_user_id = memory_records.canonical_user_id
          AND preference.preference_type = 'memory_association' AND preference.state = 'opted_out')`)
    .get(memoryId, nowMs) as TargetRow | undefined;
  if (!target) return null;
  const statement = preferenceStatement(target.content);
  if (!statement) return null;
  const revisions = db.prepare(`SELECT id FROM memory_revisions WHERE memory_id = ?
    AND revision_number = (SELECT MAX(revision_number) FROM memory_revisions WHERE memory_id = ?) LIMIT 2`)
    .pluck().all(memoryId, memoryId) as string[];
  const memoryRevisionId = revisions[0];
  if (revisions.length !== 1 || !memoryRevisionId) return null;

  const originalSources = db.prepare(`SELECT source_type, resolution_state,
    COALESCE(memory_sources.raw_event_id, chat.raw_event_id) AS raw_event_id
    FROM memory_sources LEFT JOIN chat_messages chat ON chat.id = memory_sources.chat_message_id
    WHERE memory_id = ? LIMIT ?`).all(memoryId, IMPORTANCE_SOURCE_LIMIT + 1) as Array<{
      source_type: string; resolution_state: string; raw_event_id: string | null;
    }>;
  if (originalSources.length === 0 || originalSources.length > IMPORTANCE_SOURCE_LIMIT
    || originalSources.some((source) => {
      if (!['raw_event', 'chat_message'].includes(source.source_type) || source.resolution_state !== 'internal' || !source.raw_event_id) return true;
      const verified = readSource(db, source.raw_event_id, target.canonical_user_id);
      return !verified || verified.conversationId !== target.conversation_id || verified.groupId !== target.group_id
        || !sameStatement(verified.statement, statement);
    })) return null;

  const windowStartAt = Math.max(0, window.windowEndAt - IMPORTANCE_WINDOW_DAYS * DAY);
  const ids = sourceIds(db, target, 'raw.created_at >= ? AND raw.created_at <= ? AND raw.rowid <= ?',
    [windowStartAt, window.windowEndAt, window.windowEndOrder]);
  if (ids.length > IMPORTANCE_SOURCE_LIMIT) return null;
  const sources: MemoryImportanceSource[] = [];
  for (const id of ids) {
    const source = readSource(db, id, target.canonical_user_id);
    if (!source || source.conversationId !== target.conversation_id || source.groupId !== target.group_id
      || contradictsOrAmbiguous(source, statement)) return null;
    sources.push({ ...source.evidence, evidenceRole: sameStatement(source.statement, statement) ? 'support' : 'context' });
  }
  // A frozen score cannot override a later withdrawal, including a late old-clock event.
  const laterIds = sourceIds(db, target, 'raw.rowid > ?', [window.windowEndOrder]);
  if (laterIds.length > IMPORTANCE_SOURCE_LIMIT || laterIds.some((id) => {
    const source = readSource(db, id, target.canonical_user_id);
    return !source || contradictsOrAmbiguous(source, statement);
  })) return null;
  const supports = sources.filter((source) => source.evidenceRole === 'support');
  const days = new Set(supports.map((source) => Math.floor(source.ingressAt / DAY)));
  const spanDays = (Math.max(...supports.map((source) => source.ingressAt))
    - Math.min(...supports.map((source) => source.ingressAt))) / DAY;
  if (supports.length < 3 || days.size < 3 || spanDays < 2 || spanDays > IMPORTANCE_WINDOW_DAYS) return null;
  const proposedImportance = Math.round(Math.min(0.95,
    0.4 + 0.05 * Math.min(supports.length, 6) + 0.05 * Math.min(days.size, 5) + 0.1 * Math.min(spanDays / 14, 1)) * 100) / 100;
  const confidence = Math.round(Math.min(target.confidence,
    0.6 + 0.04 * Math.min(supports.length, 5) + 0.02 * Math.min(days.size, 5)) * 100) / 100;
  const expiresAt = Math.max(...supports.map((source) => source.ingressAt)) + IMPORTANCE_EXPIRY_DAYS * DAY;
  if (proposedImportance - target.importance < 0.049 || expiresAt <= nowMs) return null;
  const inputs = { scorerVersion: 1 as const, memoryId, memoryRevisionId,
    observationCount: supports.length, distinctDayCount: days.size, spanDays,
    previousImportance: target.importance, proposedImportance, confidence, sources };
  return { ...inputs, windowEndAt: window.windowEndAt, windowEndOrder: window.windowEndOrder,
    windowStartAt, expiresAt, sourceCount: sources.length,
    evidenceFingerprint: hashMemoryMaintenanceValue(inputs) };
}
