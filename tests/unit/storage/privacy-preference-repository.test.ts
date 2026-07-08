import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { PrivacyPreferenceRepository } from '../../../src/storage/privacy-preference-repository';

describe('PrivacyPreferenceRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: PrivacyPreferenceRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-privacy-pref-'));
    db = initDatabase({ path: join(testDir, 'test.db') });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    repo = new PrivacyPreferenceRepository(db);

    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
      .run('user-alice', 1000, 1000);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('sets and clears proactive DM opt-out with audit evidence', async () => {
    repo.setOptOut({
      canonicalUserId: 'user-alice',
      preferenceType: 'proactive_dm',
      reason: 'User requested no proactive DMs',
      actor: {
        canonicalUserId: 'admin',
        actorClass: 'admin',
        context: 'admin_cli',
      },
      now: 2000,
    });

    expect(await repo.isOptedOut('user-alice', 'proactive_dm')).toBe(true);

    const optedOut = repo.find('user-alice', 'proactive_dm');
    expect(optedOut).toMatchObject({
      canonicalUserId: 'user-alice',
      preferenceType: 'proactive_dm',
      state: 'opted_out',
      reason: 'User requested no proactive DMs',
    });
    expect(optedOut?.createdAt.getTime()).toBe(2000);
    expect(optedOut?.updatedAt.getTime()).toBe(2000);

    repo.clearOptOut({
      canonicalUserId: 'user-alice',
      preferenceType: 'proactive_dm',
      reason: 'User opted back in',
      actor: {
        canonicalUserId: 'admin',
        actorClass: 'admin',
        context: 'admin_cli',
      },
      now: 3000,
    });

    expect(await repo.isOptedOut('user-alice', 'proactive_dm')).toBe(false);

    const optedIn = repo.find('user-alice', 'proactive_dm');
    expect(optedIn).toMatchObject({
      state: 'opted_in',
      reason: 'User opted back in',
    });
    expect(optedIn?.createdAt.getTime()).toBe(2000);
    expect(optedIn?.updatedAt.getTime()).toBe(3000);

    const auditRows = db
      .prepare(
        `SELECT event_type, event_id, actor_class, invocation_context, summary, details
         FROM audit_log
         WHERE event_id = ?
         ORDER BY timestamp ASC`
      )
      .all('user-alice:proactive_dm') as Array<{
      event_type: string;
      event_id: string;
      actor_class: string;
      invocation_context: string;
      summary: string;
      details: string;
    }>;

    expect(auditRows).toHaveLength(2);
    expect(auditRows[0]).toMatchObject({
      event_type: 'privacy.preference_set',
      actor_class: 'admin',
      invocation_context: 'admin_cli',
      summary: 'Set proactive_dm privacy preference to opted_out',
    });
    expect(JSON.parse(auditRows[0].details)).toMatchObject({
      canonicalUserId: 'user-alice',
      preferenceType: 'proactive_dm',
      state: 'opted_out',
    });
  });

  it('lists and filters memory association opt-outs', () => {
    repo.setOptOut({
      canonicalUserId: 'user-alice',
      preferenceType: 'memory_association',
      actor: {
        actorClass: 'admin',
        context: 'admin_cli',
      },
      now: 4000,
    });

    expect(repo.list({ state: 'opted_out' }).map((row) => row.preferenceType)).toEqual([
      'memory_association',
    ]);
    expect(repo.list({ preferenceType: 'proactive_dm' })).toHaveLength(0);
    expect(repo.list({ canonicalUserId: 'user-alice' })).toHaveLength(1);
  });

  it('redacts secret-like and platform identifiers before persisting preference reasons and audit details', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const platformId = 'qq-123456789';
    db.prepare('INSERT INTO canonical_users (id, created_at, last_seen_at) VALUES (?, ?, ?)')
      .run(platformId, 1000, 1000);

    repo.setOptOut({
      canonicalUserId: platformId,
      preferenceType: 'proactive_dm',
      reason: `operator pasted ${secret} for ${platformId}`,
      actor: {
        canonicalUserId: 'admin',
        actorClass: 'admin',
        context: 'admin_cli',
      },
      now: 5000,
    });

    const preferenceRow = db
      .prepare(
        `SELECT reason
         FROM privacy_preferences
         WHERE canonical_user_id = ? AND preference_type = ?`
      )
      .get(platformId, 'proactive_dm') as { reason: string };
    expect(preferenceRow.reason).toContain('[REDACTED:openai_like_api_key]');
    expect(preferenceRow.reason).toContain('[REDACTED:platform_id]');
    expect(preferenceRow.reason).not.toContain(secret);
    expect(preferenceRow.reason).not.toContain('123456789');

    const record = repo.find(platformId, 'proactive_dm');
    expect(record?.reason).toBe(preferenceRow.reason);

    const auditRow = db
      .prepare(
        `SELECT details
         FROM audit_log
         WHERE event_id = ?
         ORDER BY timestamp DESC
         LIMIT 1`
      )
      .get(`${platformId}:proactive_dm`) as { details: string };
    const auditDetails = JSON.parse(auditRow.details) as {
      canonicalUserId: string;
      reason: string;
    };
    expect(auditDetails.canonicalUserId).toBe('[REDACTED:platform_id]');
    expect(auditDetails.reason).toContain('[REDACTED:openai_like_api_key]');
    expect(auditDetails.reason).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).not.toContain(secret);
    expect(auditRow.details).not.toContain('123456789');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('redacts embedded platform identifiers before persisting preference reasons and audit details', () => {
    const embeddedPrefixedPlatformId = 'legacy_qq-1234567890';
    const embeddedNumericPlatformId = 'legacy_987654321';

    repo.setOptOut({
      canonicalUserId: 'user-alice',
      preferenceType: 'memory_association',
      reason: `operator pasted target=${embeddedPrefixedPlatformId} peer=${embeddedNumericPlatformId}`,
      actor: {
        canonicalUserId: 'admin',
        actorClass: 'admin',
        context: 'admin_cli',
      },
      now: 5500,
    });

    const preferenceRow = db
      .prepare(
        `SELECT reason
         FROM privacy_preferences
         WHERE canonical_user_id = ? AND preference_type = ?`
      )
      .get('user-alice', 'memory_association') as { reason: string };
    expect(preferenceRow.reason).toContain('[REDACTED:platform_id]');
    expect(preferenceRow.reason).not.toContain(embeddedPrefixedPlatformId);
    expect(preferenceRow.reason).not.toContain(embeddedNumericPlatformId);
    expect(preferenceRow.reason).not.toContain('legacy_qq-');
    expect(preferenceRow.reason).not.toContain('1234567890');
    expect(preferenceRow.reason).not.toContain('987654321');

    const auditRow = db
      .prepare(
        `SELECT details
         FROM audit_log
         WHERE event_id = ?
         ORDER BY timestamp DESC
         LIMIT 1`
      )
      .get('user-alice:memory_association') as { details: string };
    const auditDetails = JSON.parse(auditRow.details) as {
      reason: string;
    };
    expect(auditDetails.reason).toBe(preferenceRow.reason);
    expect(auditRow.details).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).not.toContain(embeddedPrefixedPlatformId);
    expect(auditRow.details).not.toContain(embeddedNumericPlatformId);
    expect(auditRow.details).not.toContain('legacy_qq-');
    expect(auditRow.details).not.toContain('1234567890');
    expect(auditRow.details).not.toContain('987654321');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for adjacent secret/platform preference reasons and audit details', () => {
    const adjacentSecretPlatform =
      'sk-privacy-adjacent-secret-should-not-persist-qq-12345678911';

    repo.setOptOut({
      canonicalUserId: 'user-alice',
      preferenceType: 'memory_association',
      reason: `operator pasted ${adjacentSecretPlatform}`,
      actor: {
        canonicalUserId: 'admin',
        actorClass: 'admin',
        context: 'admin_cli',
      },
      now: 5600,
    });

    const preferenceRow = db
      .prepare(
        `SELECT reason
         FROM privacy_preferences
         WHERE canonical_user_id = ? AND preference_type = ?`
      )
      .get('user-alice', 'memory_association') as { reason: string };
    expect(preferenceRow.reason).toContain('[REDACTED:openai_like_api_key]');
    expect(preferenceRow.reason).toContain('[REDACTED:platform_id]');
    expect(preferenceRow.reason).not.toContain('sk-privacy-adjacent');
    expect(preferenceRow.reason).not.toContain('qq-12345678911');
    expect(preferenceRow.reason).not.toContain('12345678911');

    const auditRow = db
      .prepare(
        `SELECT details
         FROM audit_log
         WHERE event_id = ?
         ORDER BY timestamp DESC
         LIMIT 1`
      )
      .get('user-alice:memory_association') as { details: string };
    const auditDetails = JSON.parse(auditRow.details) as {
      reason: string;
    };
    expect(auditDetails.reason).toBe(preferenceRow.reason);
    expect(auditRow.details).toContain('[REDACTED:openai_like_api_key]');
    expect(auditRow.details).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).not.toContain('sk-privacy-adjacent');
    expect(auditRow.details).not.toContain('qq-12345678911');
    expect(auditRow.details).not.toContain('12345678911');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves platform markers for assignment-shaped adjacent preference reasons and audit details', () => {
    const adjacentAssignment = 'api_key=sk-privacy-assignment-should-not-persist-qq-12345678911';

    repo.setOptOut({
      canonicalUserId: 'user-alice',
      preferenceType: 'memory_association',
      reason: `operator pasted ${adjacentAssignment}`,
      actor: {
        canonicalUserId: 'admin',
        actorClass: 'admin',
        context: 'admin_cli',
      },
      now: 5700,
    });

    const preferenceRow = db
      .prepare(
        `SELECT reason
         FROM privacy_preferences
         WHERE canonical_user_id = ? AND preference_type = ?`
      )
      .get('user-alice', 'memory_association') as { reason: string };
    expect(preferenceRow.reason).toContain('[REDACTED:api_key_assignment]');
    expect(preferenceRow.reason).toContain('[REDACTED:platform_id]');
    expect(preferenceRow.reason).not.toContain('api_key=');
    expect(preferenceRow.reason).not.toContain('sk-privacy-assignment');
    expect(preferenceRow.reason).not.toContain('qq-12345678911');
    expect(preferenceRow.reason).not.toContain('12345678911');

    const auditRow = db
      .prepare(
        `SELECT details
         FROM audit_log
         WHERE event_id = ?
         ORDER BY timestamp DESC
         LIMIT 1`
      )
      .get('user-alice:memory_association') as { details: string };
    const auditDetails = JSON.parse(auditRow.details) as {
      reason: string;
    };
    expect(auditDetails.reason).toBe(preferenceRow.reason);
    expect(auditRow.details).toContain('[REDACTED:api_key_assignment]');
    expect(auditRow.details).toContain('[REDACTED:platform_id]');
    expect(auditRow.details).not.toContain('api_key=');
    expect(auditRow.details).not.toContain('sk-privacy-assignment');
    expect(auditRow.details).not.toContain('qq-12345678911');
    expect(auditRow.details).not.toContain('12345678911');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('requires a valid canonical user FK', () => {
    expect(() => repo.setOptOut({
      canonicalUserId: 'user-missing',
      preferenceType: 'memory_association',
      actor: {
        actorClass: 'admin',
        context: 'admin_cli',
      },
    })).toThrow();
  });
});
