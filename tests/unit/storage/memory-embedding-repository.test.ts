import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingIdentity } from '../../../src/memory/embedding.js';
import { initDatabase, runMigrations } from '../../../src/storage/database.js';
import { MemoryEmbeddingRepository } from '../../../src/storage/memory-embedding-repository.js';
import { MemoryRepository, type MemoryRecordInput } from '../../../src/storage/memory-repository.js';
import { PrivacyPreferenceRepository } from '../../../src/storage/privacy-preference-repository.js';

const identity: EmbeddingIdentity = {
  provider: 'local_transformers', model: 'synthetic/model', modelRevision: 'a'.repeat(64),
  dimensions: 3, indexVersion: 1,
};
const context = { canonicalUserId: 'owner-a', conversationId: 'private:a', contextType: 'private' as const };
const direction = new Float32Array([1, 0, 0]);

describe('governed derived embedding index', () => {
  let root: string;
  let db: Database.Database;
  let memories: MemoryRepository;
  let index: MemoryEmbeddingRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lethebot-embedding-index-'));
    db = initDatabase({ path: join(root, 'test.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    db.exec("INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES ('owner-a', 1, 1), ('owner-b', 1, 1)");
    memories = new MemoryRepository(db);
    index = new MemoryEmbeddingRepository(db, memories);
  });
  afterEach(() => {
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function memory(id: string, override: Partial<MemoryRecordInput> = {}): Promise<void> {
    await memories.create({
      id, scope: 'user', canonicalUserId: 'owner-a', kind: 'fact',
      title: id, content: 'Synthetic preference about quiet places.', state: 'active',
      sensitivity: 'normal', visibility: 'private_only', authority: 'user_stated',
      confidence: 0.9, importance: 0.5, sourceContext: 'admin_cli:synthetic',
      actor: { actorClass: 'admin', context: 'admin_cli' },
      sources: [{ sourceType: 'user_command', sourceId: `source-${id}`, external: true }],
      ...override,
    });
  }

  function embed(id: string, vector = direction): void {
    const snapshot = index.snapshot(id);
    if (!snapshot) throw new Error('Expected indexable synthetic memory');
    expect(index.write(snapshot, identity, vector)).toBe('written');
  }

  it('writes a versioned vector idempotently and clears it without touching memory truth', async () => {
    await memory('eligible');
    const before = ['memory_records', 'memory_sources', 'memory_revisions', 'audit_log']
      .map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    const snapshot = index.snapshot('eligible');
    if (!snapshot) throw new Error('Expected snapshot');
    expect(index.write(snapshot, identity, direction)).toBe('written');
    const generated = db.prepare('SELECT generated_at FROM memory_embeddings').pluck().get();
    expect(index.write(snapshot, identity, direction)).toBe('unchanged');
    expect(db.prepare('SELECT generated_at FROM memory_embeddings').pluck().get()).toBe(generated);
    expect(index.search(identity, direction, context, 1).matches).toEqual([{ memoryId: 'eligible', score: 1 }]);
    index.clear();
    expect(index.search(identity, direction, context).matches).toEqual([]);
    expect(['memory_records', 'memory_sources', 'memory_revisions', 'audit_log']
      .map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  });

  it('excludes a larger higher-scoring forbidden population before ranking and count limits', async () => {
    for (let i = 0; i < 55; i += 1) {
      const id = `forbidden-${i}`;
      await memory(id, { canonicalUserId: 'owner-b' });
      embed(id);
    }
    await memory('allowed', { importance: 0.1 });
    embed('allowed', new Float32Array([0.8, 0.6, 0]));
    const result = index.search(identity, direction, context, 1);
    expect(result.matches.map((match) => match.memoryId)).toEqual(['allowed']);
    expect(result.scanned).toBe(1);
    expect(index.search(identity, direction, { ...context, canonicalUserId: undefined }).matches).toEqual([]);
    expect(index.search(identity, direction, { ...context, contextType: 'group', groupId: 'group-a' }).matches).toEqual([]);
  });

  it('revalidates deletion, policy, sources and revisions after inference and at search', async () => {
    await memory('changed');
    const before = index.snapshot('changed');
    if (!before) throw new Error('Expected snapshot');
    embed('changed');
    db.prepare("UPDATE memory_records SET content = 'Updated synthetic preference' WHERE id = 'changed'").run();
    expect(index.write(before, identity, direction)).toBe('stale');
    expect(index.search(identity, direction, context).stale).toBe(1);
    embed('changed');
    db.prepare("DELETE FROM memory_sources WHERE memory_id = 'changed'").run();
    expect(index.search(identity, direction, context).matches).toEqual([]);
    await memory('deleted');
    const deleting = index.snapshot('deleted');
    if (!deleting) throw new Error('Expected snapshot');
    embed('deleted');
    await memories.delete('deleted');
    expect(index.write(deleting, identity, direction)).toBe('stale');
    expect(index.search(identity, direction, context).matches).toEqual([]);
    await memory('optout');
    const optedOut = index.snapshot('optout');
    if (!optedOut) throw new Error('Expected snapshot');
    embed('optout');
    new PrivacyPreferenceRepository(db).setOptOut({
      canonicalUserId: 'owner-a', preferenceType: 'memory_association',
      actor: { actorClass: 'admin', context: 'admin_cli' },
    });
    expect(index.write(optedOut, identity, direction)).toBe('stale');
    expect(index.search(identity, direction, context).matches).toEqual([]);
  });

  it('excludes group policy, expiry, disabled procedures and model/version changes immediately', async () => {
    await memory('procedure', { kind: 'procedure' });
    embed('procedure');
    await memory('group-memory', {
      scope: 'group', canonicalUserId: undefined, groupId: 'group-a', visibility: 'same_group_only',
    });
    embed('group-memory');
    await memory('summary', {
      scope: 'group', canonicalUserId: undefined, groupId: 'group-a', visibility: 'same_group_only', kind: 'summary',
    });
    expect(index.snapshot('summary')).toBeNull();
    const groupContext = { ...context, contextType: 'group' as const, groupId: 'group-a' };
    expect(index.search(identity, direction, groupContext).matches.map((match) => match.memoryId)).toEqual(['group-memory']);
    const disabled = new MemoryEmbeddingRepository(db, new MemoryRepository(db, { procedureRetrievalEnabled: false }));
    expect(disabled.search(identity, direction, context).matches).toEqual([]);
    expect(index.search({ ...identity, modelRevision: 'b'.repeat(64) }, direction, context).matches).toEqual([]);
    expect(index.search({ ...identity, indexVersion: 2 }, direction, context).matches).toEqual([]);
    db.prepare("UPDATE memory_records SET expires_at = 1 WHERE id = 'procedure'").run();
    expect(index.search(identity, direction, context).matches).toEqual([]);
  });

  it('rejects malformed vectors and rolls back an index write when its job authority fails', async () => {
    await memory('authority');
    const snapshot = index.snapshot('authority');
    if (!snapshot) throw new Error('Expected snapshot');
    expect(() => index.write(snapshot, identity, new Float32Array([1, 2]))).toThrow();
    expect(() => index.write(snapshot, identity, new Float32Array([0, 0, 0]))).toThrow();
    let checks = 0;
    expect(() => index.write(snapshot, identity, direction, () => {
      if (++checks === 2) throw new Error('lease lost');
    })).toThrow('lease lost');
    expect(db.prepare('SELECT COUNT(*) FROM memory_embeddings').pluck().get()).toBe(0);
  });

  it('resumes bounded discovery and retains valid vectors across a database restart', async () => {
    for (let i = 0; i < 10; i += 1) await memory(`memory-${i}`);
    const batch = index.pendingBatch(identity);
    expect(batch.snapshots).toHaveLength(8);
    for (const snapshot of batch.snapshots) index.write(snapshot, identity, direction);
    db.close();
    db = initDatabase({ path: join(root, 'test.db') });
    runMigrations(db, join(process.cwd(), 'migrations'));
    index = new MemoryEmbeddingRepository(db, new MemoryRepository(db));
    const next = index.pendingBatch(identity, batch.nextCursor);
    expect(next.snapshots).toHaveLength(2);
    for (const snapshot of next.snapshots) index.write(snapshot, identity, direction);
    expect(index.pendingBatch(identity).snapshots).toEqual([]);
    expect(index.search(identity, direction, context).matches).toHaveLength(10);
  });
});
