import type Database from 'better-sqlite3';

const MAX_PROCEDURE_LENGTH = 1000;
const EXPLICIT_TEACHING = /^(?:(?:请)?记住(?:这个)?流程\s*[:：]\s*\S|remember this (?:procedure|workflow)\s*:\s*\S|(?:以后|今后|每次)[^，。！？,:：\r\n]{2,80}时\s*[,，:：]\s*(?:请)?(?:先|按))[^]*$/iu;
const QUESTION_SUFFIX = /(?:[?？]|(?:吗|么|嘛)[。.!！]?)$/u;
const WORKFLOW_REQUEST = /^(?:请)?(?:帮我|为我)[^，。！？:：\r\n]{2,80}[:：]\s*(?:请)?先\S[^]*(?:再|然后|最后)\S[^]*$/u;
const REPETITION_THRESHOLD = 3;

export function isExplicitProcedureTeaching(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= MAX_PROCEDURE_LENGTH
    && EXPLICIT_TEACHING.test(trimmed)
    && !QUESTION_SUFFIX.test(trimmed);
}

export function isRepeatableProcedureRequest(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= MAX_PROCEDURE_LENGTH
    && WORKFLOW_REQUEST.test(trimmed)
    && !QUESTION_SUFFIX.test(trimmed);
}

export interface ProcedureSource {
  id: string;
  rawEventId: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  groupId: string | null;
  canonicalUserId: string;
  text: string;
  timestamp: number;
  ingestionOrder: number;
}

const PROCEDURE_SOURCES_SQL = `SELECT DISTINCT
  chat.id, chat.raw_event_id AS rawEventId, chat.conversation_id AS conversationId,
  chat.conversation_type AS conversationType, chat.group_id AS groupId,
  account.canonical_user_id AS canonicalUserId, chat.text, chat.timestamp,
  raw.rowid AS ingestionOrder
  FROM chat_messages chat
  JOIN raw_events raw ON raw.id = chat.raw_event_id
  JOIN platform_accounts account ON account.platform = 'qq'
    AND (account.platform_account_id = chat.sender_id
      OR ('qq-' || account.platform_account_id) = chat.sender_id)
  WHERE raw.type = 'chat.message.received' AND raw.source = 'gateway' AND raw.platform = 'qq'
    AND raw.conversation_id = chat.conversation_id AND account.status = 'active'
    AND ((chat.conversation_type = 'private' AND chat.group_id IS NULL)
      OR (chat.conversation_type = 'group' AND length(chat.group_id) > 0))
    AND (SELECT COUNT(*) FROM chat_messages linked WHERE linked.raw_event_id = raw.id) = 1`;

export function readProcedureSource(
  db: Database.Database,
  chatMessageId: string,
  canonicalUserId: string,
): ProcedureSource | undefined {
  const rows = db.prepare(`${PROCEDURE_SOURCES_SQL} AND chat.id = ? LIMIT 2`)
    .all(chatMessageId) as ProcedureSource[];
  return rows.length === 1 && rows[0]?.canonicalUserId === canonicalUserId ? rows[0] : undefined;
}

export function readRepeatedProcedureSources(
  db: Database.Database,
  chatMessageId: string,
  canonicalUserId: string,
): ProcedureSource[] | undefined {
  const current = readProcedureSource(db, chatMessageId, canonicalUserId);
  if (!current || !isRepeatableProcedureRequest(current.text)) return undefined;
  // Local ingress order fixes the evidence window even when jobs run out of order.
  const sources = db.prepare(`${PROCEDURE_SOURCES_SQL}
    AND account.canonical_user_id = ? AND chat.conversation_type = ? AND chat.group_id IS ?
    AND chat.text = ? AND raw.rowid <= ? ORDER BY raw.rowid DESC, chat.id DESC LIMIT ?`)
    .all(canonicalUserId, current.conversationType, current.groupId, current.text,
      current.ingestionOrder, REPETITION_THRESHOLD) as ProcedureSource[];
  if (sources.length !== REPETITION_THRESHOLD || sources[0]?.id !== current.id) return undefined;
  if (sources.some((source) => !readProcedureSource(db, source.id, canonicalUserId))) return undefined;
  return sources.reverse();
}
