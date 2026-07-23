import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, runMigration, closeDatabase } from '../../../src/storage/database';
import { IdentityRepository } from '../../../src/storage/identity-repository';

describe('IdentityRepository', () => {
  let testDir: string;
  let db: Database.Database;
  let repo: IdentityRepository;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-test-'));
    const dbPath = join(testDir, 'test.db');
    db = initDatabase({ path: dbPath });
    runMigration(db, join(__dirname, '../../../migrations/001_initial_schema.sql'));
    repo = new IdentityRepository(db);
  });

  afterEach(() => {
    if (db) {
      expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
      closeDatabase(db);
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('Canonical users', () => {
    it('should ensure canonical user exists', async () => {
      await repo.ensureCanonicalUser('user-001');

      const result = db.prepare('SELECT * FROM canonical_users WHERE id = ?').get('user-001') as any;
      expect(result).toBeDefined();
      expect(result.id).toBe('user-001');
    });

    it('should update last_seen_at on duplicate', async () => {
      await repo.ensureCanonicalUser('user-001');
      const first = db.prepare('SELECT last_seen_at FROM canonical_users WHERE id = ?').get('user-001') as any;

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10));

      await repo.ensureCanonicalUser('user-001');
      const second = db.prepare('SELECT last_seen_at FROM canonical_users WHERE id = ?').get('user-001') as any;

      expect(second.last_seen_at).toBeGreaterThan(first.last_seen_at);
    });
  });

  describe('Platform accounts', () => {
    it('should create platform account', async () => {
      await repo.createPlatformAccount({
        platform: 'qq',
        platformAccountId: '123456',
        canonicalUserId: 'user-001',
        accountType: 'private',
        verifiedLevel: 'observed',
        status: 'active',
      });

      const accounts = await repo.getPlatformAccounts('user-001');
      expect(accounts).toHaveLength(1);
      expect(accounts[0].platformAccountId).toBe('123456');
    });

    it('should find an active platform account and its canonical user', async () => {
      await repo.createPlatformAccount({
        platform: 'qq',
        platformAccountId: '123456',
        canonicalUserId: 'user-alice',
        accountType: 'private',
        verifiedLevel: 'observed',
        status: 'active',
      });

      const account = await repo.findPlatformAccount('qq', '123456');
      const userId = await repo.findCanonicalUserId('qq', '123456');

      expect(account).toMatchObject({
        platform: 'qq',
        platformAccountId: '123456',
        canonicalUserId: 'user-alice',
        accountType: 'private',
        verifiedLevel: 'observed',
        status: 'active',
        firstSeenAt: expect.any(Date),
        lastSeenAt: expect.any(Date),
      });
      expect(userId).toBe('user-alice');
    });

    it('should return null for unknown platform account', async () => {
      const account = await repo.findPlatformAccount('qq', 'unknown');
      const userId = await repo.findCanonicalUserId('qq', 'unknown');

      expect(account).toBeNull();
      expect(userId).toBeNull();
    });

    it.each(['disabled', 'deleted'] as const)(
      'should expose a %s mapping without resolving its canonical user',
      async (status) => {
        await repo.createPlatformAccount({
          platform: 'qq',
          platformAccountId: `account-${status}`,
          canonicalUserId: `user-${status}`,
          accountType: 'private',
          verifiedLevel: 'owner_verified',
          status,
        });

        const account = await repo.findPlatformAccount('qq', `account-${status}`);
        const userId = await repo.findCanonicalUserId('qq', `account-${status}`);

        expect(account).toMatchObject({
          canonicalUserId: `user-${status}`,
          status,
        });
        expect(userId).toBeNull();
      }
    );

    it('should create an active mapping for an unknown platform account', async () => {
      const canonicalUserId = await repo.getOrCreateCanonicalUser('qq', 'new-account');

      expect(canonicalUserId).toMatch(/^user-/);
      await expect(repo.findPlatformAccount('qq', 'new-account')).resolves.toMatchObject({
        canonicalUserId,
        status: 'active',
        verifiedLevel: 'observed',
      });
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM canonical_users').get()
      ).toEqual({ count: 1 });
    });

    it('should resolve concurrent first-seen calls to one canonical user', async () => {
      const resolvedIds = await Promise.all(
        Array.from({ length: 8 }, () =>
          repo.getOrCreateCanonicalUser('qq', 'concurrent-new-account')
        )
      );

      expect(new Set(resolvedIds)).toEqual(new Set([resolvedIds[0]]));
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM canonical_users').get()
      ).toEqual({ count: 1 });
      await expect(repo.findPlatformAccount('qq', 'concurrent-new-account')).resolves.toMatchObject({
        canonicalUserId: resolvedIds[0],
        status: 'active',
      });
    });

    it.each(['disabled', 'deleted'] as const)(
      'should refuse a %s mapping without mutating or reactivating it',
      async (status) => {
        await repo.createPlatformAccount({
          platform: 'qq',
          platformAccountId: `inactive-${status}`,
          canonicalUserId: `user-inactive-${status}`,
          accountType: 'private',
          verifiedLevel: 'owner_verified',
          status,
        });
        const accountBefore = db
          .prepare('SELECT * FROM platform_accounts WHERE platform = ? AND platform_account_id = ?')
          .get('qq', `inactive-${status}`);
        const userBefore = db
          .prepare('SELECT * FROM canonical_users WHERE id = ?')
          .get(`user-inactive-${status}`);

        await expect(
          repo.getOrCreateCanonicalUser('qq', `inactive-${status}`)
        ).rejects.toThrow(`Cannot resolve ${status} platform account`);

        expect(
          db.prepare('SELECT * FROM platform_accounts WHERE platform = ? AND platform_account_id = ?')
            .get('qq', `inactive-${status}`)
        ).toEqual(accountBefore);
        expect(
          db.prepare('SELECT * FROM canonical_users WHERE id = ?')
            .get(`user-inactive-${status}`)
        ).toEqual(userBefore);
        expect(
          db.prepare('SELECT COUNT(*) AS count FROM canonical_users').get()
        ).toEqual({ count: 1 });
      }
    );

    it('should reject remapping an existing platform account', async () => {
      await repo.createPlatformAccount({
        platform: 'qq',
        platformAccountId: '123456',
        canonicalUserId: 'user-001',
        accountType: 'private',
        verifiedLevel: 'observed',
        status: 'active',
      });

      const before = await repo.findPlatformAccount('qq', '123456');

      await expect(repo.createPlatformAccount({
        platform: 'qq',
        platformAccountId: '123456',
        canonicalUserId: 'user-002',
        accountType: 'private',
        verifiedLevel: 'owner_verified',
        status: 'active',
      })).rejects.toThrow('platform account mapping already exists');

      await expect(repo.findPlatformAccount('qq', '123456')).resolves.toEqual(before);
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM canonical_users WHERE id = ?').get('user-002')
      ).toEqual({ count: 0 });
    });

    it.each(['disabled', 'deleted'] as const)(
      'should reject reactivating a %s mapping through generic upsert',
      async (status) => {
        await repo.createPlatformAccount({
          platform: 'qq',
          platformAccountId: `generic-upsert-${status}`,
          canonicalUserId: `user-generic-upsert-${status}`,
          accountType: 'private',
          verifiedLevel: 'owner_verified',
          status,
        });
        const before = await repo.findPlatformAccount('qq', `generic-upsert-${status}`);

        await expect(repo.createPlatformAccount({
          platform: 'qq',
          platformAccountId: `generic-upsert-${status}`,
          canonicalUserId: `user-generic-upsert-${status}`,
          accountType: 'private',
          verifiedLevel: 'owner_verified',
          status: 'active',
        })).rejects.toThrow('platform account mapping already exists');

        await expect(
          repo.findPlatformAccount('qq', `generic-upsert-${status}`)
        ).resolves.toEqual(before);
      }
    );

    it('should get all platform accounts for user', async () => {
      await repo.createPlatformAccount({
        platform: 'qq',
        platformAccountId: '111111',
        canonicalUserId: 'user-001',
        accountType: 'private',
        verifiedLevel: 'observed',
        status: 'active',
      });

      await repo.createPlatformAccount({
        platform: 'qq',
        platformAccountId: '222222',
        canonicalUserId: 'user-001',
        accountType: 'group_member',
        verifiedLevel: 'observed',
        status: 'active',
      });

      const accounts = await repo.getPlatformAccounts('user-001');
      expect(accounts).toHaveLength(2);
      expect(accounts.map((a) => a.platformAccountId)).toContain('111111');
      expect(accounts.map((a) => a.platformAccountId)).toContain('222222');
    });
  });

  describe('Display profiles', () => {
    beforeEach(async () => {
      await repo.ensureCanonicalUser('user-alice');
    });

    it('should upsert display profile', async () => {
      await repo.upsertDisplayProfile({
        canonicalUserId: 'user-alice',
        currentDisplayName: 'Alice',
        trust: 'platform_provided',
      });

      const profile = await repo.getDisplayProfile('user-alice');
      expect(profile).not.toBeNull();
      expect(profile?.currentDisplayName).toBe('Alice');
    });

    it('should support group-specific display names', async () => {
      await repo.upsertDisplayProfile({
        canonicalUserId: 'user-alice',
        currentDisplayName: 'Alice Global',
        trust: 'platform_provided',
      });

      await repo.upsertDisplayProfile({
        canonicalUserId: 'user-alice',
        sourceGroupId: 'group-001',
        currentDisplayName: 'Alice in Group',
        trust: 'platform_provided',
      });

      const globalProfile = await repo.getDisplayProfile('user-alice');
      const groupProfile = await repo.getDisplayProfile('user-alice', 'group-001');

      expect(globalProfile?.currentDisplayName).toBe('Alice Global');
      expect(groupProfile?.currentDisplayName).toBe('Alice in Group');
    });

    it('should update existing display profile', async () => {
      await repo.upsertDisplayProfile({
        canonicalUserId: 'user-alice',
        currentDisplayName: 'Alice Old',
        trust: 'platform_provided',
      });

      // Add delay to ensure timestamps differ
      await new Promise((resolve) => setTimeout(resolve, 10));

      await repo.upsertDisplayProfile({
        canonicalUserId: 'user-alice',
        currentDisplayName: 'Alice New',
        trust: 'user_set',
      });

      const profile = await repo.getDisplayProfile('user-alice');
      expect(profile?.currentDisplayName).toBe('Alice New');
      expect(profile?.trust).toBe('user_set');
    });

    it('should return null for non-existent profile', async () => {
      const profile = await repo.getDisplayProfile('user-nonexistent');
      expect(profile).toBeNull();
    });
  });

  describe('Nickname history', () => {
    beforeEach(async () => {
      await repo.ensureCanonicalUser('user-alice');
    });

    it('should record nickname history', async () => {
      await repo.recordNicknameHistory('user-alice', 'Alice-v1');
      await repo.recordNicknameHistory('user-alice', 'Alice-v2');

      const history = db
        .prepare('SELECT * FROM nickname_history WHERE canonical_user_id = ? ORDER BY observed_at ASC')
        .all('user-alice') as any[];

      expect(history).toHaveLength(2);
      expect(history[0].display_name).toBe('Alice-v1');
      expect(history[1].display_name).toBe('Alice-v2');
    });

    it('should record group-specific nickname history', async () => {
      await repo.recordNicknameHistory('user-alice', 'Alice Global');
      await repo.recordNicknameHistory('user-alice', 'Alice in Group', 'group-001');

      const globalHistory = db
        .prepare('SELECT * FROM nickname_history WHERE canonical_user_id = ? AND source_group_id = ?')
        .all('user-alice', '') as any[];

      const groupHistory = db
        .prepare('SELECT * FROM nickname_history WHERE canonical_user_id = ? AND source_group_id = ?')
        .all('user-alice', 'group-001') as any[];

      expect(globalHistory).toHaveLength(1);
      expect(groupHistory).toHaveLength(1);
      expect(globalHistory[0].display_name).toBe('Alice Global');
      expect(groupHistory[0].display_name).toBe('Alice in Group');
    });
  });

  describe('Platform groups', () => {
    it('should upsert platform group', async () => {
      const id = await repo.upsertPlatformGroup('qq', '123456789', 'Test Group');

      expect(id).toBe('qq:123456789');

      const group = db.prepare('SELECT * FROM platform_groups WHERE id = ?').get(id) as any;
      expect(group).toBeDefined();
      expect(group.group_name).toBe('Test Group');
    });

    it('should update group name on duplicate', async () => {
      await repo.upsertPlatformGroup('qq', '123456789', 'Old Name');
      await repo.upsertPlatformGroup('qq', '123456789', 'New Name');

      const group = db.prepare('SELECT * FROM platform_groups WHERE platform_group_id = ?').get('123456789') as any;
      expect(group.group_name).toBe('New Name');
    });

    it('should preserve group name if not provided on update', async () => {
      await repo.upsertPlatformGroup('qq', '123456789', 'Original Name');
      await repo.upsertPlatformGroup('qq', '123456789');

      const group = db.prepare('SELECT * FROM platform_groups WHERE platform_group_id = ?').get('123456789') as any;
      expect(group.group_name).toBe('Original Name');
    });
  });

  describe('Identity boundaries', () => {
    it('nickname change should not create memory', async () => {
      // 这个测试验证 identity repository 不会自动创建 memory
      await repo.ensureCanonicalUser('user-alice');
      await repo.upsertDisplayProfile({
        canonicalUserId: 'user-alice',
        currentDisplayName: 'Alice-New',
        trust: 'platform_provided',
      });

      // 验证没有创建任何 memory 记录
      const memories = db.prepare('SELECT * FROM memory_records WHERE canonical_user_id = ?').all('user-alice');
      expect(memories).toHaveLength(0);
    });

    it('display profile separate from memory', async () => {
      await repo.ensureCanonicalUser('user-alice');
      await repo.upsertDisplayProfile({
        canonicalUserId: 'user-alice',
        currentDisplayName: 'Alice',
        trust: 'platform_provided',
      });

      const profile = await repo.getDisplayProfile('user-alice');
      expect(profile).not.toBeNull();

      // display_profiles 表应该有记录
      const displayRows = db.prepare('SELECT * FROM display_profiles').all();
      expect(displayRows.length).toBeGreaterThan(0);

      // memory_records 表应该是空的
      const memoryRows = db.prepare('SELECT * FROM memory_records').all();
      expect(memoryRows).toHaveLength(0);
    });
  });
});
