import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MemoryMaintenanceProposal } from './maintenance-proposal.js';

export interface MemoryMaintenanceCandidateStateSnapshot {
  candidateMemoryIds: string[];
  scope: {
    scope: string;
    canonicalUserId: string | null;
    groupId: string | null;
    conversationId: string | null;
    subjectUserId: string | null;
  };
  sourceSet: MemoryMaintenanceProposal['sourceSet'];
  candidates: Array<{
    memoryId: string;
    recordFingerprint: string;
    sourceCount: number;
    sourceFingerprint: string;
  }>;
  candidateFingerprint: string;
  confidence: number;
}

interface MemorySnapshotRow {
  id: string;
  scope: string;
  canonical_user_id: string | null;
  group_id: string | null;
  conversation_id: string | null;
  subject_user_id: string | null;
  visibility: string;
  sensitivity: string;
  authority: string;
  kind: string;
  title: string;
  content: string;
  state: string;
  confidence: number;
  importance: number;
  updated_at: number;
}

interface MemorySourceSnapshotRow {
  memory_id: string;
  source_type: string;
  source_id: string;
  source_timestamp: number;
  extracted_by: string | null;
  resolution_state: string;
  raw_event_id: string | null;
  chat_message_id: string | null;
  tool_call_id: string | null;
  job_id: string | null;
  job_attempt_id: string | null;
}

export function readMemoryMaintenanceCandidateSnapshot(
  db: Database.Database,
  inputCandidateMemoryIds: string[],
): MemoryMaintenanceCandidateStateSnapshot {
  const candidateMemoryIds = [...new Set(inputCandidateMemoryIds)].sort();
  if (candidateMemoryIds.length === 0) {
    throw new Error('memory maintenance proposal requires at least one candidate');
  }

  const placeholders = candidateMemoryIds.map(() => '?').join(', ');
  const records = db.prepare(
    `SELECT id, scope, canonical_user_id, group_id, conversation_id,
            subject_user_id, visibility, sensitivity, authority, kind,
            title, content, state, confidence, importance, updated_at
       FROM memory_records
      WHERE id IN (${placeholders})
      ORDER BY id ASC`,
  ).all(...candidateMemoryIds) as MemorySnapshotRow[];
  if (records.length !== candidateMemoryIds.length) {
    throw new Error('memory maintenance proposal candidate is missing');
  }
  const firstRecord = records[0];
  if (!firstRecord) {
    throw new Error('memory maintenance proposal candidate is missing');
  }
  if (records.some((record) => (
    record.scope !== firstRecord.scope
    || record.canonical_user_id !== firstRecord.canonical_user_id
    || record.group_id !== firstRecord.group_id
    || record.conversation_id !== firstRecord.conversation_id
    || record.subject_user_id !== firstRecord.subject_user_id
  ))) {
    throw new Error('memory maintenance proposal candidates cross scope');
  }

  const sources = db.prepare(
    `SELECT memory_id, source_type, source_id, source_timestamp, extracted_by,
            resolution_state, raw_event_id, chat_message_id, tool_call_id,
            job_id, job_attempt_id
       FROM memory_sources
      WHERE memory_id IN (${placeholders})
      ORDER BY memory_id ASC, source_type ASC, source_id ASC`,
  ).all(...candidateMemoryIds) as MemorySourceSnapshotRow[];

  const sourceSet = records.map((record) => {
    const recordSources = sources
      .filter((source) => source.memory_id === record.id)
      .map((source) => ({
        sourceType: source.source_type,
        sourceId: source.source_id,
        sourceTimestamp: source.source_timestamp,
        extractedBy: source.extracted_by,
        resolutionState: source.resolution_state,
        rawEventId: source.raw_event_id,
        chatMessageId: source.chat_message_id,
        toolCallId: source.tool_call_id,
        jobId: source.job_id,
        jobAttemptId: source.job_attempt_id,
      }));
    return {
      memoryId: record.id,
      sourceCount: recordSources.length,
      sourceFingerprint: hashMemoryMaintenanceValue(recordSources),
    };
  });

  const recordSnapshots = records.map((record, index) => {
    const source = sourceSet[index];
    if (!source || source.memoryId !== record.id) {
      throw new Error('memory maintenance proposal source snapshot is incomplete');
    }
    return {
      id: record.id,
      scope: record.scope,
      canonicalUserId: record.canonical_user_id,
      groupId: record.group_id,
      conversationId: record.conversation_id,
      subjectUserId: record.subject_user_id,
      visibility: record.visibility,
      sensitivity: record.sensitivity,
      authority: record.authority,
      kind: record.kind,
      titleHash: hashMemoryMaintenanceValue(record.title),
      contentHash: hashMemoryMaintenanceValue(record.content),
      state: record.state,
      confidence: record.confidence,
      importance: record.importance,
      updatedAt: record.updated_at,
      sourceFingerprint: source.sourceFingerprint,
    };
  });
  return {
    candidateMemoryIds,
    scope: {
      scope: firstRecord.scope,
      canonicalUserId: firstRecord.canonical_user_id,
      groupId: firstRecord.group_id,
      conversationId: firstRecord.conversation_id,
      subjectUserId: firstRecord.subject_user_id,
    },
    sourceSet,
    confidence: Math.min(...records.map((record) => record.confidence)),
    candidateFingerprint: hashMemoryMaintenanceValue(recordSnapshots),
    candidates: records.map((record, index) => {
      const source = sourceSet[index];
      const recordSnapshot = recordSnapshots[index];
      if (!source || !recordSnapshot) {
        throw new Error('memory maintenance proposal candidate snapshot is incomplete');
      }
      return {
        memoryId: record.id,
        recordFingerprint: hashMemoryMaintenanceValue(recordSnapshot),
        sourceCount: source.sourceCount,
        sourceFingerprint: source.sourceFingerprint,
      };
    }),
  };
}

export function hashMemoryMaintenanceValue(value: unknown): string {
  const serialized = typeof value === 'string' ? value : stableStringify(value);
  return createHash('sha256').update(serialized).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => (
      `${JSON.stringify(key)}:${stableStringify(child)}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}
