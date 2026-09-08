import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  MAX_EMBEDDING_BATCH, MAX_EMBEDDING_TEXT_LENGTH, normalizedEmbedding, type EmbeddingIdentity,
} from '../memory/embedding.js';
import { readMemoryMaintenanceCandidateSnapshot } from '../memory/maintenance-candidate-snapshot.js';
import { scanMemoryForSecrets } from '../memory/secret-scan.js';
import type { MemoryRepository } from './memory-repository.js';

export interface SemanticMemoryContext {
  contextType: 'private' | 'group';
  conversationId: string;
  canonicalUserId?: string;
  groupId?: string;
}

export interface EmbeddingMemorySnapshot {
  memoryId: string;
  fingerprint: string;
  revision: number;
  text: string;
}

const identitySchema = z.object({
  provider: z.literal('local_transformers'), model: z.string().min(1).max(256),
  modelRevision: z.string().regex(/^[0-9a-f]{64}$/),
  dimensions: z.number().int().min(1).max(4096), indexVersion: z.number().int().positive(),
});

interface EmbeddingRow {
  memory_id: string;
  provider: string;
  model: string;
  model_revision: string;
  dimensions: number;
  index_version: number;
  content_fingerprint: string;
  memory_revision: number;
  vector: Buffer;
}

export class MemoryEmbeddingRepository {
  constructor(private readonly db: Database.Database, private readonly memories: MemoryRepository) {}

  snapshot(memoryId: string): EmbeddingMemorySnapshot | null {
    const eligibility = this.eligibility();
    const row = this.db.prepare(`SELECT m.title, m.content,
      (SELECT MAX(revision_number) FROM memory_revisions WHERE memory_id = m.id) AS revision
      FROM memory_records m WHERE m.id = ? AND ${eligibility.sql}`)
      .get(memoryId, ...eligibility.params) as { title: string; content: string; revision: number | null } | undefined;
    if (!row?.revision || !row.content.trim() || scanMemoryForSecrets(`${row.title}\n${row.content}`).length > 0) return null;
    const state = readMemoryMaintenanceCandidateSnapshot(this.db, [memoryId]);
    if (!state.sourceSet[0]?.sourceCount) return null;
    return {
      memoryId, fingerprint: state.candidateFingerprint, revision: row.revision,
      text: row.content.slice(0, MAX_EMBEDDING_TEXT_LENGTH),
    };
  }

  pendingBatch(identity: EmbeddingIdentity, afterId = ''): {
    snapshots: EmbeddingMemorySnapshot[]; nextCursor?: string; scanned: number;
  } {
    identitySchema.parse(identity);
    const eligibility = this.eligibility();
    const rows = this.db.prepare(`SELECT m.id FROM memory_records m
      WHERE m.id > ? AND ${eligibility.sql} ORDER BY m.id LIMIT 129`)
      .all(afterId, ...eligibility.params) as Array<{ id: string }>;
    const snapshots: EmbeddingMemorySnapshot[] = [];
    let scanned = 0;
    for (const row of rows.slice(0, 128)) {
      scanned += 1;
      const snapshot = this.snapshot(row.id);
      if (snapshot && !this.matches(this.find(row.id), snapshot, identity)) snapshots.push(snapshot);
      if (snapshots.length === MAX_EMBEDDING_BATCH) return { snapshots, scanned, nextCursor: row.id };
    }
    return { snapshots, scanned, ...(rows.length > 128 ? { nextCursor: rows[127]?.id } : {}) };
  }

  write(
    snapshot: EmbeddingMemorySnapshot,
    identity: EmbeddingIdentity,
    values: Float32Array,
    assertAuthority: () => void = () => {},
  ): 'written' | 'unchanged' | 'stale' {
    identitySchema.parse(identity);
    const vector = normalizedEmbedding(Array.from(values), identity.dimensions);
    return this.db.transaction(() => {
      assertAuthority();
      const current = this.snapshot(snapshot.memoryId);
      if (!current || current.fingerprint !== snapshot.fingerprint || current.revision !== snapshot.revision
        || current.text !== snapshot.text) return 'stale';
      if (this.matches(this.find(snapshot.memoryId), snapshot, identity)) return 'unchanged';
      const bytes = Buffer.alloc(vector.length * 4);
      vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
      this.db.prepare(`INSERT INTO memory_embeddings
        (memory_id, provider, model, model_revision, dimensions, index_version,
          content_fingerprint, memory_revision, vector, generated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET provider = excluded.provider, model = excluded.model,
          model_revision = excluded.model_revision, dimensions = excluded.dimensions,
          index_version = excluded.index_version, content_fingerprint = excluded.content_fingerprint,
          memory_revision = excluded.memory_revision, vector = excluded.vector, generated_at = excluded.generated_at`)
        .run(snapshot.memoryId, identity.provider, identity.model, identity.modelRevision,
          identity.dimensions, identity.indexVersion, snapshot.fingerprint, snapshot.revision, bytes, Date.now());
      assertAuthority();
      return 'written';
    }).immediate();
  }

  search(identity: EmbeddingIdentity, values: Float32Array, context: SemanticMemoryContext, limit = 50): {
    matches: Array<{ memoryId: string; score: number }>; scanned: number; stale: number; truncated: boolean;
  } {
    identitySchema.parse(identity);
    const query = normalizedEmbedding(Array.from(values), identity.dimensions);
    const eligibility = this.eligibility(context);
    const rows = this.db.prepare(`SELECT e.* FROM memory_embeddings e
      JOIN memory_records m ON m.id = e.memory_id
      WHERE ${eligibility.sql} AND e.provider = ? AND e.model = ? AND e.model_revision = ?
        AND e.dimensions = ? AND e.index_version = ? ORDER BY m.id`)
      .iterate(...eligibility.params, identity.provider, identity.model, identity.modelRevision,
        identity.dimensions, identity.indexVersion) as IterableIterator<EmbeddingRow>;
    const matches: Array<{ memoryId: string; score: number }> = [];
    let scanned = 0;
    let stale = 0;
    let truncated = false;
    // Scope and policy predicates run in SQL before this bounded similarity scan.
    for (const row of rows) {
      if (scanned >= 1000) { truncated = true; break; }
      scanned += 1;
      const snapshot = this.snapshot(row.memory_id);
      if (!snapshot || !this.matches(row, snapshot, identity)) { stale += 1; continue; }
      try {
        if (row.vector.length !== identity.dimensions * 4) { stale += 1; continue; }
        const vector = normalizedEmbedding(Array.from({ length: identity.dimensions }, (_, i) => row.vector.readFloatLE(i * 4)), identity.dimensions);
        const score = Math.max(-1, Math.min(1, vector.reduce((sum, value, i) => sum + value * (query[i] ?? 0), 0)));
        if (score >= 0.25) matches.push({ memoryId: row.memory_id, score });
      } catch { stale += 1; }
    }
    matches.sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId));
    const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 50)) : 50;
    return { matches: matches.slice(0, count), scanned, stale, truncated };
  }

  clear(): void { this.db.exec('DELETE FROM memory_embeddings'); }

  private find(memoryId: string): EmbeddingRow | undefined {
    return this.db.prepare('SELECT * FROM memory_embeddings WHERE memory_id = ?').get(memoryId) as EmbeddingRow | undefined;
  }

  private matches(row: EmbeddingRow | undefined, snapshot: EmbeddingMemorySnapshot, identity: EmbeddingIdentity): boolean {
    return row !== undefined && row.provider === identity.provider && row.model === identity.model
      && row.model_revision === identity.modelRevision && row.dimensions === identity.dimensions
      && row.index_version === identity.indexVersion && row.content_fingerprint === snapshot.fingerprint
      && row.memory_revision === snapshot.revision;
  }

  private eligibility(context?: SemanticMemoryContext): { sql: string; params: unknown[] } {
    const clauses = [
      "m.state = 'active'", '(m.expires_at IS NULL OR m.expires_at > ?)',
      "m.sensitivity NOT IN ('secret', 'prohibited')", "m.visibility <> 'owner_admin_only'",
      "m.scope IN ('user', 'group', 'conversation', 'global')",
      `NOT EXISTS (SELECT 1 FROM privacy_preferences p WHERE p.preference_type = 'memory_association'
        AND p.state = 'opted_out' AND p.canonical_user_id IN (m.canonical_user_id, m.subject_user_id))`,
      `NOT (m.scope = 'group' AND m.kind = 'summary' AND NOT EXISTS
        (SELECT 1 FROM group_summary_policies p WHERE p.group_id = m.group_id AND p.state = 'enabled'))`,
    ];
    const params: unknown[] = [Date.now()];
    if (!this.memories.procedureRetrievalEnabled) clauses.push("m.kind <> 'procedure'");
    if (context) {
      clauses.push(`((m.scope = 'user' AND m.canonical_user_id = ?)
        OR (m.scope = 'group' AND ? = 'group' AND m.group_id = ?)
        OR (m.scope = 'conversation' AND m.conversation_id = ?)
        OR (m.scope = 'global' AND m.canonical_user_id IS NULL AND m.group_id IS NULL AND m.conversation_id IS NULL))`);
      params.push(context.canonicalUserId ?? null, context.contextType, context.groupId ?? null, context.conversationId);
      clauses.push(`(m.visibility IN ('public', 'same_user_any_context')
        OR (m.visibility = 'private_only' AND ? = 'private')
        OR (m.visibility = 'same_group_only' AND ? = 'group' AND (m.group_id = ? OR m.conversation_id = ?)))`);
      params.push(context.contextType, context.contextType, context.groupId ?? null, context.conversationId);
    }
    return { sql: clauses.join(' AND '), params };
  }
}
