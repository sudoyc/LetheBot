/**
 * Integration Test: Identity Resolution
 *
 * 验证身份解析功能
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase } from '../../src/storage/database.js';
import { IdentityRepository } from '../../src/storage/identity-repository.js';
import type { Database } from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Identity Resolution', () => {
  let db: Database;
  let identityRepo: IdentityRepository;
  const testDbPath = join(__dirname, '../../data/test-identity-resolution.db');

  beforeEach(() => {
    // 清理测试数据库
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }

    // 确保目录存在
    const dataDir = dirname(testDbPath);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // 初始化数据库
    db = initDatabase({ path: testDbPath });

    // 运行迁移
    const migrationPath = join(__dirname, '../../migrations/001_initial_schema.sql');
    const sql = readFileSync(migrationPath, 'utf-8');
    db.exec(sql);

    // 初始化仓库
    identityRepo = new IdentityRepository(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDbPath)) {
      rmSync(testDbPath);
    }
  });

  it('should create new user on first encounter', async () => {
    const platformUserId = '123456';
    const canonicalUserId = `user-test-${Date.now()}`;

    // 创建用户
    await identityRepo.ensureCanonicalUser(canonicalUserId);
    await identityRepo.createPlatformAccount({
      canonicalUserId,
      platform: 'qq',
      platformAccountId: platformUserId,
      accountType: 'private',
      verifiedLevel: 'observed',
      status: 'active',
    });

    // 验证用户存在
    const users = db.prepare('SELECT * FROM canonical_users WHERE id = ?').all(canonicalUserId);
    expect(users).toHaveLength(1);

    // 验证平台映射
    const accounts = db.prepare('SELECT * FROM platform_accounts WHERE platform_account_id = ?').all(platformUserId);
    expect(accounts).toHaveLength(1);
  });

  it('should find existing user', async () => {
    const platformUserId = '123456';
    const canonicalUserId = `user-test-${Date.now()}`;

    // 创建用户
    await identityRepo.ensureCanonicalUser(canonicalUserId);
    await identityRepo.createPlatformAccount({
      canonicalUserId,
      platform: 'qq',
      platformAccountId: platformUserId,
      accountType: 'private',
      verifiedLevel: 'observed',
      status: 'active',
    });

    // 查找用户
    const foundUserId = await identityRepo.findCanonicalUserId('qq', platformUserId);
    expect(foundUserId).toBe(canonicalUserId);
  });

  it('should return null for unknown platform account', async () => {
    const foundUserId = await identityRepo.findCanonicalUserId('qq', 'unknown-user');
    expect(foundUserId).toBeNull();
  });

  it('should link multiple platform accounts to same user', async () => {
    const canonicalUserId = `user-test-${Date.now()}`;

    await identityRepo.ensureCanonicalUser(canonicalUserId);

    // 链接第一个账号
    await identityRepo.createPlatformAccount({
      canonicalUserId,
      platform: 'qq',
      platformAccountId: '123456',
      accountType: 'private',
      verifiedLevel: 'observed',
      status: 'active',
    });

    // 链接第二个账号（假设未来支持多平台）
    await identityRepo.createPlatformAccount({
      canonicalUserId,
      platform: 'qq',
      platformAccountId: '789012',
      accountType: 'group_member',
      verifiedLevel: 'observed',
      status: 'active',
    });

    // 验证两个账号都指向同一个用户
    const user1 = await identityRepo.findCanonicalUserId('qq', '123456');
    const user2 = await identityRepo.findCanonicalUserId('qq', '789012');

    expect(user1).toBe(canonicalUserId);
    expect(user2).toBe(canonicalUserId);
  });

  it('should update last_seen_at on re-encounter', async () => {
    const canonicalUserId = `user-test-${Date.now()}`;

    await identityRepo.ensureCanonicalUser(canonicalUserId);

    const firstSeen = db.prepare('SELECT last_seen_at FROM canonical_users WHERE id = ?').get(canonicalUserId) as any;

    // 等待一小段时间
    await new Promise(resolve => setTimeout(resolve, 10));

    // 再次确保用户存在（更新 last_seen_at）
    await identityRepo.ensureCanonicalUser(canonicalUserId);

    const secondSeen = db.prepare('SELECT last_seen_at FROM canonical_users WHERE id = ?').get(canonicalUserId) as any;

    expect(secondSeen.last_seen_at).toBeGreaterThan(firstSeen.last_seen_at);
  });
});
