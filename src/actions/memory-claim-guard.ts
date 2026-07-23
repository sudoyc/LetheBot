import type Database from 'better-sqlite3';
import { redactSecretsInText } from '../memory/secret-scan.js';
import { redactContextTraceText } from '../storage/context-trace-repository.js';
import type { ActionPlan } from '../types/action.js';

export const MEMORY_CLAIM_GUARD_SUPPRESSOR = 'memory_claim_truthfulness_guard';

export interface MemoryClaimActor {
  canonicalUserId?: string;
}

interface GuardMemoryClaimsInput {
  turnId: string;
  actions: ActionPlan[];
  actor?: MemoryClaimActor;
  decisionAt: Date;
}

interface GuardMemoryClaimsResult {
  actions: ActionPlan[];
  corrected: boolean;
}

interface ClaimContextRow {
  conversation_id: string;
  trigger_event_id: string;
  context_pack_id: string | null;
  trace_id: string | null;
  trace_turn_id: string | null;
  trace_conversation_id: string | null;
  conversation_type: 'private' | 'group' | null;
  group_id: string | null;
  selected_memory_ids: string | null;
  memories: string | null;
  trace_created_at: number | null;
}

interface ClaimContext {
  turnId: string;
  conversationId: string;
  conversationType: 'private' | 'group';
  groupId: string | null;
  triggerEventId: string;
  traceCreatedAt: number;
  selectedMemoryIds: string[];
  traceMemories: Map<string, TraceMemory>;
  actor: {
    canonicalUserId: string;
    deliveryUserId: string;
  };
}

interface TraceMemory {
  memoryId: string;
  scope: string;
  sourceContext?: string;
}

interface MemoryEvidence {
  state: 'active' | 'proposed';
  content: string;
}

interface MemoryEvidenceRow {
  id: string;
  scope: string;
  kind: string;
  title: string;
  authority: string;
  canonical_user_id: string | null;
  group_id: string | null;
  conversation_id: string | null;
  subject_user_id: string | null;
  visibility: string;
  sensitivity: string;
  content: string;
  state: string;
  source_context: string | null;
  created_at: number;
  expires_at: number | null;
  source_count: number;
  usable_source_count: number;
}

interface ProposalEvidenceRow extends MemoryEvidenceRow {
  evaluator_decision_id: string;
  evaluator_actor_user_id: string | null;
  evaluator_actor_class: string;
  evaluator_context: string;
  evaluator_source_event_ids: string;
  request_created_at: number;
  decided_at: number;
  tool_call_id: string;
  tool_input: string;
  tool_output: string | null;
  tool_secrets_redacted: number;
  tool_created_at: number;
  revision_count: number;
  revision_total_count: number;
  revision_created_at: number | null;
  memory_audit_count: number;
  memory_audit_total_count: number;
  memory_audit_timestamp: number | null;
  tool_audit_count: number;
  tool_audit_total_count: number;
  tool_audit_timestamp: number | null;
}

interface ParsedClaim {
  language: 'zh' | 'en';
  state: 'durable' | 'pending';
  proposition: string;
}

interface ClaimPresentation {
  prefix: string;
  candidate: string;
}

const OUTWARD_TEXT_ACTIONS = new Set<ActionPlan['type']>([
  'reply_short',
  'reply_full',
  'reply_with_tool',
  'dm_user',
  'send_folded_forward',
  'ask_clarification',
  'react_only',
]);
const MAX_EVIDENCE_RECORDS = 100;
const MAX_CLAIM_LINE_LENGTH = 4_096;

const CHINESE_DURABLE_PATTERNS = [
  /^(?:好的[，,]?\s*)?(?:我)?(?:已|已经)(?:记住|记下)(?:了)?\s*[：:,，]?\s*(.+?)\s*[。.!！]?$/u,
  /^(?:好的[，,]?\s*)?(?:我)?记住了\s*[：:,，]\s*(.+?)\s*[。.!！]?$/u,
  /^(?:好的[，,]?\s*)?(?:我)?(?:已|已经)(?:保存|写入|存入)(?:到|进)?(?:了)?(?:长期)?记忆(?!卡)\s*[：:,，]?\s*(.+?)\s*[。.!！]?$/u,
  /^(?:好的[，,]?\s*)?(?:我)?(?:会|将)(?:一直)?记住\s*[：:,，]?\s*(.+?)\s*[。.!！]?$/u,
];
const CHINESE_PENDING_PATTERNS = [
  /^(?:已|已经)创建待审核记忆提议\s*[：:,，]\s*(.+?)\s*[。.!！]?$/u,
  /^(?:已|已经)(?:创建|提交)(?:了)?记忆(?:提议|提案|草案)\s*[：:,，]\s*(.+?)\s*[。.!！]?$/u,
  /^(?:已|已经)(?:创建|提交)(?:了)?(?:记忆)?(?:提议|提案|草案)(?:，|,|；|;|\s)+(?:待|等待)审核\s*[：:,，]?\s*(.+?)\s*[。.!！]?$/u,
  /^(?:已|已经)提交(?:了)?记忆审核\s*[：:,，]\s*(.+?)\s*[。.!！]?$/u,
];
const ENGLISH_DURABLE_PATTERNS = [
  /^(?:(?:okay|sure|got it)[,.:]?\s*)?i(?:(?:'ve| have))?\s+remembered(?:\s+that\s+|\s*[:,-]\s*)(.+?)\s*[.!]?$/i,
  /^(?:(?:okay|sure|got it)[,.:]?\s*)?i(?:'ll| will)\s+remember(?:\s+that\s+|\s*[:,-]\s*)(.+?)\s*[.!]?$/i,
  /^(?:(?:okay|sure|got it)[,.:]?\s*)?i(?:(?:'ve| have))?\s+(?:saved|stored)(?:\s+it)?\s+(?:to|in)\s+(?:long[- ]term\s+)?memory\s*[:,-]\s*(.+?)\s*[.!]?$/i,
  /^(?:remembered|(?:saved|stored)\s+(?:to|in)\s+(?:long[- ]term\s+)?memory)\s*[:,-]\s*(.+?)\s*[.!]?$/i,
  /^(?:it(?:'s| has)\s+been\s+remembered)\s*[:,-]\s*(.+?)\s*[.!]?$/i,
];
const ENGLISH_PENDING_PATTERNS = [
  /^(?:i(?:'ve| have)\s+)?(?:created|submitted)(?:\s+a)?\s+memory\s+(?:proposal|draft)\s+(?:pending review|for review)\s*[:,-]\s*(.+?)\s*[.!]?$/i,
  /^(?:i(?:'ve| have)\s+)?(?:created|submitted)(?:\s+a)?\s+memory\s+(?:proposal|draft)\s*[:,-]\s*(.+?)\s*[.!]?$/i,
  /^(?:submitted\s+for\s+memory\s+review|pending\s+memory\s+review)\s*[:,-]\s*(.+?)\s*[.!]?$/i,
];
const NESTED_CLAIM_MARKER = /(?:已|已经).{0,16}(?:记住|记下)|(?:我)?(?:会|将)(?:一直)?记住|(?:已|已经).{0,16}(?:保存|写入|存入).{0,8}记忆|\bi(?:(?:'ve| have))?\s+remembered(?:\s+that\b|\s*:)|\bi(?:'ll| will)\s+remember(?:\s+that\b|\s*:)|\b(?:created|submitted).{0,12}memory\s+(?:proposal|draft)/iu;

export function guardMemoryClaims(
  db: Database.Database,
  input: GuardMemoryClaimsInput,
): GuardMemoryClaimsResult {
  const hasClaim = input.actions.some((action) => {
    const guardedField = getGuardedActionText(action);
    return guardedField !== null && containsGuardableClaim(guardedField.value);
  });
  if (!hasClaim) {
    return { actions: input.actions, corrected: false };
  }

  const decisionAt = input.decisionAt.getTime();
  const context = Number.isFinite(decisionAt)
    ? readClaimContext(db, input.turnId, input.actor, decisionAt)
    : null;
  const evidence = context
    ? [
        ...readSelectedActiveEvidence(db, context, decisionAt),
        ...readCommittedProposalEvidence(db, context, decisionAt),
      ]
    : [];
  let corrected = false;
  const actions = input.actions.map((action) => {
    const guardedField = getGuardedActionText(action);
    if (!guardedField) {
      return action;
    }

    const actionEvidence = context && isExactTurnTarget(action, context) ? evidence : [];
    const guardedText = guardText(guardedField.value, actionEvidence);
    if (guardedText === guardedField.value) {
      return action;
    }
    corrected = true;
    return {
      ...action,
      payload: {
        ...action.payload,
        [guardedField.field]: guardedText,
      },
    };
  });

  return { actions, corrected };
}

function guardText(text: string, evidence: MemoryEvidence[]): string {
  return text
    .split(/\r?\n/)
    .map((line) => guardLine(line, evidence))
    .join('\n');
}

function guardLine(line: string, evidence: MemoryEvidence[]): string {
  const presentation = readClaimPresentation(line);
  if (!hasHighConfidenceClaimMarker(presentation.candidate)) {
    return line;
  }
  if (line.length > MAX_CLAIM_LINE_LENGTH) {
    return genericNeutralLine(detectLanguage(line));
  }

  const claim = parseClaim(presentation.candidate);
  if (!claim) {
    return `${presentation.prefix}${genericNeutralLine(detectLanguage(presentation.candidate))}`;
  }
  const proposition = cleanProposition(claim.proposition);
  if (!proposition) {
    return `${presentation.prefix}${genericNeutralLine(claim.language)}`;
  }
  if (
    containsNestedClaimMarker(proposition)
    || !isSafeEchoProposition(proposition)
  ) {
    return `${presentation.prefix}${genericNeutralLine(claim.language)}`;
  }
  const normalized = normalizeProposition(proposition);
  const matching = evidence.filter((candidate) => (
    normalizeProposition(candidate.content) === normalized
  ));
  if (matching.length !== 1) {
    return `${presentation.prefix}${renderClaim(claim.language, 'neutral', proposition)}`;
  }

  const supportedState = matching[0]?.state;
  if (supportedState === 'proposed') {
    return `${presentation.prefix}${renderClaim(claim.language, 'pending', proposition)}`;
  }
  if (supportedState === 'active' && claim.state === 'durable') {
    return line;
  }
  return `${presentation.prefix}${renderClaim(claim.language, 'durable', proposition)}`;
}

function containsGuardableClaim(text: string): boolean {
  return text.split(/\r?\n/).some((line) => (
    hasHighConfidenceClaimMarker(readClaimPresentation(line).candidate)
  ));
}

function readClaimPresentation(line: string): ClaimPresentation {
  let prefix = '';
  let candidate = line;

  const leadingWhitespace = /^\s+/u.exec(candidate)?.[0];
  if (leadingWhitespace) {
    prefix += leadingWhitespace;
    candidate = candidate.slice(leadingWhitespace.length);
  }

  const listMarker = /^(?:(?:[-*+]|\d+[.)])\s+)/u.exec(candidate)?.[0];
  if (listMarker) {
    prefix += listMarker;
    candidate = candidate.slice(listMarker.length);

    const checklistMarker = /^\[[ xX]\]\s+/u.exec(candidate)?.[0];
    if (checklistMarker) {
      prefix += checklistMarker;
      candidate = candidate.slice(checklistMarker.length);
    }
  } else {
    const headingMarker = /^#{1,6}\s+/u.exec(candidate)?.[0];
    if (headingMarker) {
      prefix += headingMarker;
      candidate = candidate.slice(headingMarker.length);
    }
  }

  const acknowledgement = /^(?:好的[，,]?\s*|(?:okay|sure|got it)[,.:]?\s+|update:\s+)/iu
    .exec(candidate)?.[0];
  if (acknowledgement) {
    prefix += acknowledgement;
    candidate = candidate.slice(acknowledgement.length);
  }

  if (!hasHighConfidenceClaimMarker(unwrapLeadingClaimFormatting(candidate))) {
    const sentence = /^([^"'“”‘’\r\n]{1,80}[.!?。！？]\s+)(.+)$/u.exec(candidate);
    if (
      sentence?.[1]
      && sentence[2]
      && hasHighConfidenceClaimMarker(unwrapLeadingClaimFormatting(sentence[2]))
    ) {
      prefix += sentence[1];
      candidate = sentence[2];
    }
  }

  return { prefix, candidate: unwrapLeadingClaimFormatting(candidate) };
}

function unwrapLeadingClaimFormatting(value: string): string {
  const formatted = /^(\*\*|__)([^\r\n]{1,160}?)\1(.*)$/u.exec(value);
  if (!formatted?.[2] || formatted[3] === undefined) {
    return value;
  }
  return `${formatted[2]}${formatted[3]}`;
}

function parseClaim(line: string): ParsedClaim | null {
  const candidate = normalizeRecognitionText(line.trim());
  for (const pattern of CHINESE_DURABLE_PATTERNS) {
    const match = pattern.exec(candidate);
    if (match?.[1]) {
      return { language: 'zh', state: 'durable', proposition: match[1] };
    }
  }
  for (const pattern of CHINESE_PENDING_PATTERNS) {
    const match = pattern.exec(candidate);
    if (match?.[1]) {
      return { language: 'zh', state: 'pending', proposition: match[1] };
    }
  }
  for (const pattern of ENGLISH_DURABLE_PATTERNS) {
    const match = pattern.exec(candidate);
    if (match?.[1]) {
      return { language: 'en', state: 'durable', proposition: match[1] };
    }
  }
  for (const pattern of ENGLISH_PENDING_PATTERNS) {
    const match = pattern.exec(candidate);
    if (match?.[1]) {
      return { language: 'en', state: 'pending', proposition: match[1] };
    }
  }
  return null;
}

function hasHighConfidenceClaimMarker(text: string): boolean {
  return parseClaim(text) !== null;
}

function detectLanguage(text: string): 'zh' | 'en' {
  return /[\u3400-\u9fff]/u.test(text) ? 'zh' : 'en';
}

function cleanProposition(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/gu, '')
    .replace(/[。.!！]$/u, '')
    .trim();
}

function normalizeProposition(value: string): string {
  return cleanProposition(value);
}

function normalizeRecognitionText(value: string): string {
  return value.normalize('NFKC').replace(/’/gu, "'");
}

function containsNestedClaimMarker(value: string): boolean {
  return NESTED_CLAIM_MARKER.test(normalizeRecognitionText(value));
}

function isSafeEchoProposition(value: string): boolean {
  return redactSecretsInText(value).findings.length === 0
    && !/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/iu.test(value)
    && !/(?<![A-Za-z0-9])\d{5,12}(?![A-Za-z0-9])/u.test(value);
}

function getGuardedActionText(
  action: ActionPlan,
): { field: 'text' | 'reaction'; value: string } | null {
  if (!OUTWARD_TEXT_ACTIONS.has(action.type)) {
    return null;
  }
  if (action.type === 'react_only') {
    return typeof action.payload?.reaction === 'string'
      ? { field: 'reaction', value: action.payload.reaction }
      : null;
  }
  return typeof action.payload?.text === 'string'
    ? { field: 'text', value: action.payload.text }
    : null;
}

function isExactTurnTarget(action: ActionPlan, context: ClaimContext): boolean {
  const target = action.target;
  if (
    !target
    || target.conversationId !== context.conversationId
    || target.conversationType !== context.conversationType
  ) {
    return false;
  }

  if (context.conversationType === 'private') {
    if (
      context.groupId !== null
      || target.groupId !== undefined
      || target.canonicalUserId !== context.actor.canonicalUserId
      || target.userId !== context.actor.deliveryUserId
    ) {
      return false;
    }
  } else if (!context.groupId || target.groupId !== context.groupId) {
    return false;
  }

  return action.type !== 'dm_user'
    || (
      target.canonicalUserId === context.actor.canonicalUserId
      && target.userId === context.actor.deliveryUserId
    );
}

function renderClaim(
  language: 'zh' | 'en',
  state: 'neutral' | 'pending' | 'durable',
  proposition: string,
): string {
  if (language === 'zh') {
    if (state === 'pending') {
      return `已创建待审核记忆提议：${proposition}`;
    }
    if (state === 'durable') {
      return `已记住：${proposition}`;
    }
    return `收到：${proposition}`;
  }
  if (state === 'pending') {
    return `Created a memory proposal pending review: ${proposition}`;
  }
  if (state === 'durable') {
    return `Remembered: ${proposition}`;
  }
  return `Acknowledged: ${proposition}`;
}

function genericNeutralLine(language: 'zh' | 'en'): string {
  return language === 'zh' ? '收到。' : 'Acknowledged.';
}

function readClaimContext(
  db: Database.Database,
  turnId: string,
  actor: MemoryClaimActor | undefined,
  decisionAt: number,
): ClaimContext | null {
  if (!actor?.canonicalUserId || actor.canonicalUserId.trim().length === 0) {
    return null;
  }
  const row = db.prepare(
    `SELECT turn.conversation_id,
            turn.trigger_event_id,
            turn.context_pack_id,
            trace.id AS trace_id,
            trace.turn_id AS trace_turn_id,
            trace.conversation_id AS trace_conversation_id,
            trace.conversation_type,
            trace.group_id,
            trace.selected_memory_ids,
            trace.memories,
            trace.created_at AS trace_created_at
       FROM agent_turns AS turn
       LEFT JOIN context_traces AS trace
         ON trace.id = turn.context_pack_id AND trace.turn_id = turn.id
      WHERE turn.id = ?`,
  ).get(turnId) as ClaimContextRow | undefined;
  if (
    !row
    || !row.context_pack_id
    || row.trace_id !== row.context_pack_id
    || row.trace_turn_id !== turnId
    || row.trace_conversation_id !== row.conversation_id
    || (row.conversation_type !== 'private' && row.conversation_type !== 'group')
    || row.trace_created_at === null
    || row.trace_created_at > decisionAt
    || row.selected_memory_ids === null
    || row.memories === null
  ) {
    return null;
  }
  const source = readTurnActor(db, row.trigger_event_id, row.conversation_id);
  if (
    !source
    || source.canonicalUserId !== actor.canonicalUserId
    || source.conversationType !== row.conversation_type
    || (row.conversation_type === 'private'
      ? row.group_id !== null || source.groupId !== null
      : !row.group_id || row.group_id !== source.groupId)
  ) {
    return null;
  }
  const selectedMemoryIds = parseStrictStringArray(row.selected_memory_ids);
  const traceMemories = parseTraceMemories(row.memories);
  if (!selectedMemoryIds || !traceMemories) {
    return null;
  }

  return {
    turnId,
    conversationId: row.conversation_id,
    conversationType: row.conversation_type,
    groupId: row.group_id,
    triggerEventId: row.trigger_event_id,
    traceCreatedAt: row.trace_created_at,
    selectedMemoryIds,
    traceMemories,
    actor: {
      canonicalUserId: source.canonicalUserId,
      deliveryUserId: source.deliveryUserId,
    },
  };
}

function readTurnActor(
  db: Database.Database,
  triggerEventId: string,
  conversationId: string,
): {
  canonicalUserId: string;
  deliveryUserId: string;
  conversationType: 'private' | 'group';
  groupId: string | null;
} | null {
  const rows = db.prepare(
    `SELECT message.sender_id,
            message.conversation_id AS message_conversation_id,
            message.conversation_type,
            message.group_id,
            raw.type AS raw_type,
            raw.source AS raw_source,
            raw.platform,
            raw.conversation_id AS raw_conversation_id
       FROM chat_messages AS message
       JOIN raw_events AS raw ON raw.id = message.raw_event_id
      WHERE message.raw_event_id = ? AND message.conversation_id = ?`,
  ).all(triggerEventId, conversationId) as Array<{
    sender_id: string;
    message_conversation_id: string;
    conversation_type: 'private' | 'group';
    group_id: string | null;
    raw_type: string;
    raw_source: string;
    platform: string | null;
    raw_conversation_id: string | null;
  }>;
  if (rows.length !== 1) {
    return null;
  }
  const source = rows[0];
  if (
    !source
    || source.raw_type !== 'chat.message.received'
    || source.raw_source !== 'gateway'
    || source.platform !== 'qq'
    || source.raw_conversation_id !== conversationId
    || source.message_conversation_id !== conversationId
  ) {
    return null;
  }
  if (source.sender_id.startsWith('user-')) {
    const exists = db.prepare('SELECT 1 FROM canonical_users WHERE id = ?').get(source.sender_id);
    return exists
      ? {
          canonicalUserId: source.sender_id,
          deliveryUserId: source.sender_id,
          conversationType: source.conversation_type,
          groupId: source.group_id,
        }
      : null;
  }
  const platformAccountId = source.sender_id.startsWith('qq-')
    ? source.sender_id.slice('qq-'.length)
    : source.sender_id;
  const account = db.prepare(
    `SELECT canonical_user_id
       FROM platform_accounts
      WHERE platform = 'qq' AND platform_account_id = ? AND status = 'active'`,
  ).get(platformAccountId) as { canonical_user_id: string } | undefined;
  return account
    ? {
        canonicalUserId: account.canonical_user_id,
        deliveryUserId: source.sender_id,
        conversationType: source.conversation_type,
        groupId: source.group_id,
      }
    : null;
}

function readSelectedActiveEvidence(
  db: Database.Database,
  context: ClaimContext,
  decisionAt: number,
): MemoryEvidence[] {
  if (context.selectedMemoryIds.length === 0) {
    return [];
  }
  const placeholders = context.selectedMemoryIds.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT memory.id,
            memory.scope,
            memory.kind,
            memory.title,
            memory.authority,
            memory.canonical_user_id,
            memory.group_id,
            memory.conversation_id,
            memory.subject_user_id,
            memory.visibility,
            memory.sensitivity,
            memory.content,
            memory.state,
            memory.source_context,
            memory.created_at,
            memory.expires_at,
            (SELECT COUNT(*)
               FROM memory_sources AS source
              WHERE source.memory_id = memory.id) AS source_count,
            (SELECT COUNT(*)
               FROM memory_sources AS source
              WHERE source.memory_id = memory.id
                AND (
                  (source.resolution_state = 'external'
                   AND source.source_type = 'user_command')
                  OR
                  (source.resolution_state = 'internal' AND (
                    (source.source_type = 'raw_event'
                     AND source.raw_event_id = source.source_id)
                    OR (source.source_type = 'chat_message'
                        AND source.chat_message_id = source.source_id)
                    OR (source.source_type = 'tool_output'
                        AND source.tool_call_id = source.source_id)
                    OR (source.source_type = 'worker_extraction'
                        AND (source.job_id = source.source_id
                             OR source.job_attempt_id = source.source_id))
                  ))
                )) AS usable_source_count
       FROM memory_records AS memory
      WHERE memory.id IN (${placeholders})`,
  ).all(...context.selectedMemoryIds) as MemoryEvidenceRow[];

  return rows.flatMap((row) => {
    const traceMemory = context.traceMemories.get(row.id);
    if (
      !traceMemory
      || traceMemory.scope !== row.scope
      || (traceMemory.sourceContext ?? null) !== (
        row.source_context === null ? null : redactContextTraceText(row.source_context)
      )
      || row.state !== 'active'
      || row.created_at > context.traceCreatedAt
      || (row.expires_at !== null && row.expires_at <= decisionAt)
      || row.sensitivity === 'secret'
      || row.sensitivity === 'prohibited'
      || row.source_count < 1
      || row.source_count !== row.usable_source_count
      || row.usable_source_count < 1
      || !hasCanonicalSelectedSources(db, row)
      || !isMemoryInScope(row, context)
    ) {
      return [];
    }
    return [{ state: 'active' as const, content: row.content }];
  });
}

function hasCanonicalSelectedSources(
  db: Database.Database,
  memory: MemoryEvidenceRow,
): boolean {
  const sources = db.prepare(
    `SELECT source_type, source_id, source_timestamp, resolution_state,
            raw_event_id, chat_message_id, tool_call_id, job_id, job_attempt_id
       FROM memory_sources
      WHERE memory_id = ?
      ORDER BY source_id`,
  ).all(memory.id) as Array<{
    source_type: string;
    source_id: string;
    source_timestamp: number;
    resolution_state: string;
    raw_event_id: string | null;
    chat_message_id: string | null;
    tool_call_id: string | null;
    job_id: string | null;
    job_attempt_id: string | null;
  }>;
  if (sources.length === 0 || sources.length > MAX_EVIDENCE_RECORDS) {
    return false;
  }
  if (!matchesOriginalMemorySourceSnapshot(db, memory, sources.map((source) => source.source_id))) {
    return false;
  }

  return sources.every((source) => {
    if (source.resolution_state === 'external') {
      return source.source_type === 'user_command'
        && memory.source_context?.startsWith('admin_cli') === true
        && source.source_timestamp <= memory.created_at
        && hasCanonicalExternalCommandProvenance(db, memory);
    }
    if (source.resolution_state !== 'internal') {
      return false;
    }

    if (
      source.source_type !== 'raw_event'
      && source.source_type !== 'chat_message'
    ) {
      return false;
    }
    if (
      (source.source_type === 'raw_event' && source.raw_event_id !== source.source_id)
      || (source.source_type === 'chat_message' && source.chat_message_id !== source.source_id)
    ) {
      return false;
    }

    const boundary = readCanonicalChatSource(db, source.source_type, source.source_id);
    if (!boundary) {
      return false;
    }
    const canonicalTimestamp = source.source_type === 'raw_event'
      ? boundary.rawTimestamp
      : boundary.messageTimestamp;
    return (
      boundary.rawCreatedAt <= memory.created_at
      && (
        source.source_timestamp === canonicalTimestamp
        || source.source_timestamp === memory.created_at
      )
      && isMemorySourceInScope(memory, boundary)
    );
  });
}

function matchesOriginalMemorySourceSnapshot(
  db: Database.Database,
  memory: MemoryEvidenceRow,
  sourceIds: string[],
): boolean {
  const rows = db.prepare(
    `SELECT new_state
       FROM memory_revisions
      WHERE memory_id = ?
        AND revision_number = 1
        AND change_type = 'create'
        AND previous_state IS NULL
      ORDER BY id
      LIMIT 2`,
  ).all(memory.id) as Array<{ new_state: string }>;
  if (rows.length !== 1 || !rows[0]) {
    return false;
  }

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(rows[0].new_state) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(snapshot)) {
    return false;
  }
  const createdAt = toIsoTimestamp(memory.created_at);
  const snapshotSourceIds = snapshot.sourceEventIds;
  if (
    createdAt === null
    || !Array.isArray(snapshotSourceIds)
    || snapshotSourceIds.length === 0
    || snapshotSourceIds.length > MAX_EVIDENCE_RECORDS
    || !snapshotSourceIds.every((value) => typeof value === 'string' && value.trim().length > 0)
    || new Set(snapshotSourceIds).size !== snapshotSourceIds.length
  ) {
    return false;
  }

  return snapshot.id === memory.id
    && snapshot.scope === memory.scope
    && matchesNullableSnapshotString(snapshot.canonicalUserId, memory.canonical_user_id)
    && matchesNullableSnapshotString(snapshot.groupId, memory.group_id)
    && matchesNullableSnapshotString(snapshot.conversationId, memory.conversation_id)
    && matchesNullableSnapshotString(snapshot.subjectUserId, memory.subject_user_id)
    && snapshot.visibility === memory.visibility
    && snapshot.sensitivity === memory.sensitivity
    && snapshot.authority === memory.authority
    && snapshot.kind === memory.kind
    && snapshot.title === memory.title
    && snapshot.content === memory.content
    && snapshot.createdAt === createdAt
    && sameStringSet(snapshotSourceIds, sourceIds);
}

function toIsoTimestamp(value: number): string | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function matchesNullableSnapshotString(value: unknown, expected: string | null): boolean {
  return expected === null ? value === undefined || value === null : value === expected;
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function hasCanonicalExternalCommandProvenance(
  db: Database.Database,
  memory: MemoryEvidenceRow,
): boolean {
  const row = db.prepare(
    `SELECT
       (SELECT COUNT(*)
          FROM memory_revisions AS revision
         WHERE revision.memory_id = ?
           AND revision.revision_number = 1
           AND revision.change_type = 'create'
           AND revision.previous_state IS NULL
           AND revision.created_at = ?) AS revision_count,
       (SELECT COUNT(*)
          FROM memory_revisions AS revision
         WHERE revision.memory_id = ?
           AND revision.change_type = 'create') AS create_revision_count,
       (SELECT COUNT(*)
          FROM audit_log AS audit
         WHERE audit.event_id = ?
           AND audit.category = 'memory'
           AND audit.event_type = 'memory.create'
           AND audit.invocation_context = 'admin_cli'
           AND audit.timestamp = ?
           AND audit.redacted = 1) AS audit_count,
       (SELECT COUNT(*)
          FROM audit_log AS audit
         WHERE audit.event_id = ?
           AND audit.event_type = 'memory.create') AS create_audit_count`,
  ).get(
    memory.id,
    memory.created_at,
    memory.id,
    memory.id,
    memory.created_at,
    memory.id,
  ) as {
    revision_count: number;
    create_revision_count: number;
    audit_count: number;
    create_audit_count: number;
  };
  return row.revision_count === 1
    && row.create_revision_count === 1
    && row.audit_count === 1
    && row.create_audit_count === 1;
}

function readCanonicalChatSource(
  db: Database.Database,
  sourceType: 'raw_event' | 'chat_message',
  sourceId: string,
): {
  conversationId: string;
  conversationType: 'private' | 'group';
  groupId: string | null;
  canonicalUserId: string | null;
  rawTimestamp: number;
  rawCreatedAt: number;
  messageTimestamp: number;
} | null {
  const predicate = sourceType === 'raw_event' ? 'raw.id = ?' : 'message.id = ?';
  const rows = db.prepare(
    `SELECT raw.id AS raw_id,
            raw.type AS raw_type,
            raw.source AS raw_source,
            raw.platform,
            raw.conversation_id AS raw_conversation_id,
            raw.timestamp AS raw_timestamp,
            raw.created_at AS raw_created_at,
            message.id AS message_id,
            message.conversation_id,
            message.conversation_type,
            message.group_id,
            message.sender_id,
            message.timestamp AS message_timestamp
       FROM raw_events AS raw
       JOIN chat_messages AS message ON message.raw_event_id = raw.id
      WHERE ${predicate}`,
  ).all(sourceId) as Array<{
    raw_id: string;
    raw_type: string;
    raw_source: string;
    platform: string | null;
    raw_conversation_id: string | null;
    raw_timestamp: number;
    raw_created_at: number;
    message_id: string;
    conversation_id: string;
    conversation_type: 'private' | 'group';
    group_id: string | null;
    sender_id: string;
    message_timestamp: number;
  }>;
  if (rows.length !== 1) {
    return null;
  }
  const row = rows[0];
  if (
    !row
    || row.raw_type !== 'chat.message.received'
    || row.raw_source !== 'gateway'
    || row.platform !== 'qq'
    || row.raw_conversation_id !== row.conversation_id
    || (row.conversation_type === 'private'
      ? row.group_id !== null
      : !row.group_id)
  ) {
    return null;
  }

  return {
    conversationId: row.conversation_id,
    conversationType: row.conversation_type,
    groupId: row.group_id,
    canonicalUserId: resolveCanonicalSourceUser(db, row.sender_id),
    rawTimestamp: row.raw_timestamp,
    rawCreatedAt: row.raw_created_at,
    messageTimestamp: row.message_timestamp,
  };
}

function resolveCanonicalSourceUser(
  db: Database.Database,
  senderId: string,
): string | null {
  if (senderId.startsWith('user-')) {
    return db.prepare('SELECT 1 FROM canonical_users WHERE id = ?').get(senderId)
      ? senderId
      : null;
  }
  const platformAccountId = senderId.startsWith('qq-')
    ? senderId.slice('qq-'.length)
    : senderId;
  const row = db.prepare(
    `SELECT canonical_user_id
       FROM platform_accounts
      WHERE platform = 'qq' AND platform_account_id = ? AND status = 'active'`,
  ).get(platformAccountId) as { canonical_user_id: string } | undefined;
  return row?.canonical_user_id ?? null;
}

function isMemorySourceInScope(
  memory: MemoryEvidenceRow,
  source: {
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId: string | null;
    canonicalUserId: string | null;
  },
): boolean {
  if (memory.scope === 'user') {
    if (source.canonicalUserId !== memory.canonical_user_id) {
      return false;
    }
    if (source.conversationType === 'group') {
      if (memory.visibility !== 'same_group_only') {
        return false;
      }
      const selectors = [
        ...(memory.group_id === null ? [] : [memory.group_id === source.groupId]),
        ...(memory.conversation_id === null
          ? []
          : [memory.conversation_id === source.conversationId]),
      ];
      return selectors.length > 0 && selectors.every(Boolean);
    }
    return memory.visibility !== 'same_group_only';
  }
  if (memory.scope === 'group') {
    return source.conversationType === 'group' && source.groupId === memory.group_id;
  }
  if (memory.scope === 'conversation') {
    return source.conversationId === memory.conversation_id;
  }
  return memory.scope === 'global';
}

function readCommittedProposalEvidence(
  db: Database.Database,
  context: ClaimContext,
  decisionAt: number,
): MemoryEvidence[] {
  const rows = db.prepare(
    `SELECT memory.id,
            memory.scope,
            memory.kind,
            memory.title,
            memory.authority,
            memory.canonical_user_id,
            memory.group_id,
            memory.conversation_id,
            memory.subject_user_id,
            memory.visibility,
            memory.sensitivity,
            memory.content,
            memory.state,
            memory.source_context,
            memory.created_at,
            memory.expires_at,
            0 AS source_count,
            0 AS usable_source_count,
            evaluator.id AS evaluator_decision_id,
            evaluator.actor_user_id AS evaluator_actor_user_id,
            evaluator.actor_class AS evaluator_actor_class,
            evaluator.invocation_context AS evaluator_context,
            evaluator.source_event_ids AS evaluator_source_event_ids,
            evaluator.request_created_at,
            evaluator.decided_at,
            tool.id AS tool_call_id,
            tool.input AS tool_input,
            tool.output AS tool_output,
            tool.secrets_redacted AS tool_secrets_redacted,
            tool.created_at AS tool_created_at,
            (SELECT COUNT(*)
               FROM memory_revisions AS revision
              WHERE revision.memory_id = memory.id
                AND revision.revision_number = 1
                AND revision.change_type = 'create'
                AND revision.evaluator_decision_id = evaluator.id
                AND revision.actor = evaluator.actor_user_id) AS revision_count,
            (SELECT COUNT(*)
               FROM memory_revisions AS revision
              WHERE revision.memory_id = memory.id) AS revision_total_count,
            (SELECT MAX(revision.created_at)
               FROM memory_revisions AS revision
              WHERE revision.memory_id = memory.id
                AND revision.revision_number = 1
                AND revision.change_type = 'create'
                AND revision.evaluator_decision_id = evaluator.id
                AND revision.actor = evaluator.actor_user_id) AS revision_created_at,
            (SELECT COUNT(*)
               FROM audit_log AS memory_audit
              WHERE memory_audit.event_id = memory.id
                AND memory_audit.category = 'memory'
                AND memory_audit.event_type = 'memory.create'
                AND memory_audit.evaluator_decision_id = evaluator.id
                AND memory_audit.actor_user_id IS evaluator.actor_user_id
                AND memory_audit.actor_class = evaluator.actor_class
                AND memory_audit.invocation_context = evaluator.invocation_context) AS memory_audit_count,
            (SELECT COUNT(*)
               FROM audit_log AS memory_audit
              WHERE memory_audit.event_id = memory.id
                AND memory_audit.category = 'memory'
                AND memory_audit.event_type = 'memory.create') AS memory_audit_total_count,
            (SELECT MAX(memory_audit.timestamp)
               FROM audit_log AS memory_audit
              WHERE memory_audit.event_id = memory.id
                AND memory_audit.category = 'memory'
                AND memory_audit.event_type = 'memory.create'
                AND memory_audit.evaluator_decision_id = evaluator.id
                AND memory_audit.actor_user_id IS evaluator.actor_user_id
                AND memory_audit.actor_class = evaluator.actor_class
                AND memory_audit.invocation_context = evaluator.invocation_context) AS memory_audit_timestamp,
            (SELECT COUNT(*)
               FROM audit_log AS tool_audit
              WHERE tool_audit.event_id = tool.id
                AND tool_audit.category = 'tool'
                AND tool_audit.event_type = 'tool.executed'
                AND tool_audit.evaluator_decision_id = evaluator.id
                AND tool_audit.actor_user_id IS evaluator.actor_user_id
                AND tool_audit.actor_class = evaluator.actor_class
                AND tool_audit.invocation_context = evaluator.invocation_context) AS tool_audit_count,
            (SELECT COUNT(*)
                FROM audit_log AS tool_audit
               WHERE tool_audit.event_id = tool.id
                 AND tool_audit.category = 'tool'
                 AND tool_audit.event_type = 'tool.executed') AS tool_audit_total_count,
            (SELECT MAX(tool_audit.timestamp)
               FROM audit_log AS tool_audit
              WHERE tool_audit.event_id = tool.id
                AND tool_audit.category = 'tool'
                AND tool_audit.event_type = 'tool.executed'
                AND tool_audit.evaluator_decision_id = evaluator.id
                AND tool_audit.actor_user_id IS evaluator.actor_user_id
                AND tool_audit.actor_class = evaluator.actor_class
                AND tool_audit.invocation_context = evaluator.invocation_context) AS tool_audit_timestamp
       FROM tool_calls AS tool
       JOIN evaluator_decisions AS evaluator
         ON evaluator.id = tool.evaluator_decision_id
       JOIN memory_records AS memory
         ON memory.evaluator_decision_id = evaluator.id
      WHERE tool.turn_id = ?
        AND tool.tool_name = 'memory.propose'
        AND tool.requested_by = 'pi'
        AND tool.status = 'success'
        AND tool.actor_user_id IS evaluator.actor_user_id
        AND tool.actor_class = evaluator.actor_class
        AND tool.invocation_context = evaluator.invocation_context
        AND evaluator.domain = 'tool'
        AND evaluator.turn_id = ?
        AND evaluator.tool_name = 'memory.propose'
        AND evaluator.decision = 'approve'
        AND evaluator.risk_level != 'prohibited'
        AND (SELECT COUNT(*) FROM tool_calls AS exact_tool
              WHERE exact_tool.evaluator_decision_id = evaluator.id) = 1
        AND (SELECT COUNT(*) FROM memory_records AS exact_memory
              WHERE exact_memory.evaluator_decision_id = evaluator.id) = 1
        AND memory.state = 'proposed'
        AND memory.scope IN ('user', 'group', 'global')
        AND memory.authority = 'tool_derived'
        AND memory.subject_user_id IS NULL
        AND (memory.expires_at IS NULL OR memory.expires_at > ?)
        AND ? <= evaluator.request_created_at
        AND evaluator.request_created_at <= evaluator.decided_at
        AND evaluator.decided_at <= memory.created_at
        AND memory.created_at <= tool.created_at
        AND tool.created_at <= ?
      ORDER BY memory.id, tool.id
      LIMIT ?`,
  ).all(
    context.turnId,
    context.turnId,
    decisionAt,
    context.traceCreatedAt,
    decisionAt,
    MAX_EVIDENCE_RECORDS + 1,
  ) as ProposalEvidenceRow[];
  if (rows.length > MAX_EVIDENCE_RECORDS) {
    return [];
  }

  const byMemory = new Map<string, ProposalEvidenceRow[]>();
  for (const row of rows) {
    const existing = byMemory.get(row.id) ?? [];
    existing.push(row);
    byMemory.set(row.id, existing);
  }
  const evidence: MemoryEvidence[] = [];
  for (const candidates of byMemory.values()) {
    if (candidates.length !== 1) {
      continue;
    }
    const row = candidates[0];
    if (
      !row
      || row.evaluator_actor_user_id !== context.actor.canonicalUserId
      || row.evaluator_context !== invocationContextFor(context.conversationType)
      || row.source_context !== row.evaluator_context
      || row.revision_count !== 1
      || row.revision_total_count !== 1
      || row.revision_created_at !== row.created_at
      || row.memory_audit_count !== 1
      || row.memory_audit_total_count !== 1
      || row.memory_audit_timestamp !== row.created_at
      || row.tool_audit_count !== 1
      || row.tool_audit_total_count !== 1
      || row.tool_audit_timestamp === null
      || row.tool_audit_timestamp < row.decided_at
      || row.tool_audit_timestamp > decisionAt
      || row.sensitivity === 'secret'
      || row.sensitivity === 'prohibited'
      || row.tool_secrets_redacted !== 0
      || !matchesProposalToolEffect(row)
      || !hasExactProposalSources(db, row, context)
      || !isMemoryInScope(row, context)
    ) {
      continue;
    }
    evidence.push({ state: 'proposed', content: row.content });
  }
  return evidence;
}

function hasExactProposalSources(
  db: Database.Database,
  row: ProposalEvidenceRow,
  context: ClaimContext,
): boolean {
  const evaluatorSourceIds = parseStrictStringArray(row.evaluator_source_event_ids);
  if (!evaluatorSourceIds || !evaluatorSourceIds.includes(context.triggerEventId)) {
    return false;
  }
  const sources = db.prepare(
    `SELECT source.source_type,
            source.source_id,
            source.resolution_state,
            source.raw_event_id,
            source.source_timestamp,
            source.extracted_by,
            raw.type AS raw_type,
            raw.source AS raw_source,
            raw.platform,
            raw.conversation_id AS raw_conversation_id,
            raw.timestamp AS raw_timestamp,
            raw.created_at AS raw_created_at,
            (SELECT COUNT(*)
               FROM chat_messages AS message
              WHERE message.raw_event_id = raw.id
                AND message.conversation_id = ?
                AND message.conversation_type = ?
                AND message.group_id IS ?) AS matching_chat_count
       FROM memory_sources AS source
       JOIN raw_events AS raw ON raw.id = source.raw_event_id
      WHERE source.memory_id = ?
      ORDER BY source.source_id`,
  ).all(
    context.conversationId,
    context.conversationType,
    context.groupId,
    row.id,
  ) as Array<{
    source_type: string;
    source_id: string;
    resolution_state: string;
    raw_event_id: string | null;
    source_timestamp: number;
    extracted_by: string | null;
    raw_type: string;
    raw_source: string;
    platform: string | null;
    raw_conversation_id: string | null;
    raw_timestamp: number;
    raw_created_at: number;
    matching_chat_count: number;
  }>;
  if (sources.length !== evaluatorSourceIds.length) {
    return false;
  }
  const expected = new Set(evaluatorSourceIds);
  return sources.every((source) => (
    source.source_type === 'raw_event'
    && source.resolution_state === 'internal'
    && source.raw_event_id === source.source_id
    && source.extracted_by === 'tool'
    && source.raw_type === 'chat.message.received'
    && source.raw_source === 'gateway'
    && source.platform === 'qq'
    && source.raw_conversation_id === context.conversationId
    && source.source_timestamp === source.raw_timestamp
    && source.raw_created_at <= row.request_created_at
    && source.matching_chat_count === 1
    && expected.delete(source.source_id)
  )) && expected.size === 0;
}

function isMemoryInScope(row: MemoryEvidenceRow, context: ClaimContext): boolean {
  if (row.subject_user_id !== null && row.subject_user_id !== context.actor.canonicalUserId) {
    return false;
  }
  if (row.scope === 'user') {
    if (row.canonical_user_id !== context.actor.canonicalUserId) {
      return false;
    }
  } else if (row.scope === 'group') {
    if (
      context.conversationType !== 'group'
      || !context.groupId
      || row.group_id !== context.groupId
      || row.canonical_user_id !== null
    ) {
      return false;
    }
  } else if (row.scope === 'conversation') {
    if (row.conversation_id !== context.conversationId || row.canonical_user_id !== null) {
      return false;
    }
  } else if (row.scope === 'global') {
    if (row.canonical_user_id !== null || row.group_id !== null || row.conversation_id !== null) {
      return false;
    }
  } else {
    return false;
  }

  if (row.visibility === 'owner_admin_only') {
    return false;
  }
  if (row.visibility === 'private_only') {
    return context.conversationType === 'private';
  }
  if (row.visibility === 'same_group_only') {
    if (context.conversationType !== 'group' || !context.groupId) {
      return false;
    }
    const selectors = [
      ...(row.group_id === null ? [] : [row.group_id === context.groupId]),
      ...(row.conversation_id === null ? [] : [row.conversation_id === context.conversationId]),
    ];
    return selectors.length > 0 && selectors.every(Boolean);
  }
  if (row.visibility === 'same_user_any_context') {
    return row.scope === 'user' && row.canonical_user_id === context.actor.canonicalUserId;
  }
  return row.visibility === 'public';
}

function parseStrictStringArray(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed)
    || parsed.length > MAX_EVIDENCE_RECORDS
    || !parsed.every((value) => typeof value === 'string' && value.trim().length > 0)
    || new Set(parsed).size !== parsed.length
  ) {
    return null;
  }
  return parsed;
}

function parseTraceMemories(raw: string): Map<string, TraceMemory> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_EVIDENCE_RECORDS) {
    return null;
  }
  const memories = new Map<string, TraceMemory>();
  for (const item of parsed) {
    if (!isRecord(item)) {
      return null;
    }
    const memoryId = item.memoryId;
    const scope = item.scope;
    const sourceContext = item.sourceContext;
    if (
      typeof memoryId !== 'string'
      || memoryId.trim().length === 0
      || typeof scope !== 'string'
      || scope.trim().length === 0
      || (sourceContext !== undefined && typeof sourceContext !== 'string')
      || memories.has(memoryId)
    ) {
      return null;
    }
    memories.set(memoryId, {
      memoryId,
      scope,
      ...(sourceContext === undefined ? {} : { sourceContext }),
    });
  }
  return memories;
}

function matchesProposalToolEffect(row: ProposalEvidenceRow): boolean {
  if (row.tool_output === null) {
    return false;
  }
  try {
    const input = JSON.parse(row.tool_input) as unknown;
    const output = JSON.parse(row.tool_output) as unknown;
    if (!isRecord(input) || !isRecord(output)) {
      return false;
    }
    const title = normalizeToolInputString(input.title, 120);
    const content = normalizeToolInputString(input.content, 1_000);
    return title === row.title
      && content === row.content
      && output.status === 'proposed'
      && output.scope === row.scope
      && output.visibility === row.visibility
      && output.kind === row.kind;
  } catch {
    return false;
  }
}

function normalizeToolInputString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, maxLength);
}

function invocationContextFor(conversationType: 'private' | 'group'): string {
  return conversationType === 'private' ? 'private_chat' : 'group_chat';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
