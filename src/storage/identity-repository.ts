/**
 * Identity Repository
 *
 * 身份映射和显示信息的持久化操作
 */

import type Database from 'better-sqlite3';
import type { PlatformAccountMapping, DisplayProfile } from '../types/identity.js';
import { ulid } from 'ulidx';

export class InactivePlatformAccountError extends Error {
  constructor(public readonly status: Extract<PlatformAccountMapping['status'], 'disabled' | 'deleted'>) {
    super(`Cannot resolve ${status} platform account`);
    this.name = 'InactivePlatformAccountError';
  }
}

/**
 * 身份仓储
 */
export class IdentityRepository {
  constructor(private readonly _db: Database.Database) {}

  private get db(): Database.Database {
    return this._db;
  }

  /**
   * 确保 canonical user 存在
   */
  async ensureCanonicalUser(userId: string): Promise<void> {
    this.ensureCanonicalUserSync(userId, Date.now());
  }

  private ensureCanonicalUserSync(userId: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO canonical_users (id, created_at, last_seen_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = ?`
      )
      .run(userId, now, now, now);
  }

  /**
   * 创建新的平台账号映射。Relink and lifecycle changes require separate
   * verified/audited paths.
   */
  async createPlatformAccount(mapping: Omit<PlatformAccountMapping, 'firstSeenAt' | 'lastSeenAt'>): Promise<void> {
    const writeMapping = this.db.transaction(() => {
      const now = Date.now();
      const existing = this.findPlatformAccountSync(mapping.platform, mapping.platformAccountId);
      if (existing) {
        throw new Error('platform account mapping already exists');
      }

      this.ensureCanonicalUserSync(mapping.canonicalUserId, now);
      this.insertPlatformAccount(mapping, now);
    });

    writeMapping.immediate();
  }

  /**
   * 根据平台账号查找完整映射，包括非 active 状态。
   */
  async findPlatformAccount(
    platform: PlatformAccountMapping['platform'],
    platformAccountId: string
  ): Promise<PlatformAccountMapping | null> {
    return this.findPlatformAccountSync(platform, platformAccountId);
  }

  private findPlatformAccountSync(
    platform: PlatformAccountMapping['platform'],
    platformAccountId: string
  ): PlatformAccountMapping | null {
    const row = this.db
      .prepare('SELECT * FROM platform_accounts WHERE platform = ? AND platform_account_id = ?')
      .get(platform, platformAccountId) as Record<string, unknown> | undefined;

    return row ? this.rowToPlatformAccount(row) : null;
  }

  /**
   * 根据 active 平台账号查找 canonical user ID
   */
  async findCanonicalUserId(
    platform: PlatformAccountMapping['platform'],
    platformAccountId: string
  ): Promise<string | null> {
    const account = await this.findPlatformAccount(platform, platformAccountId);

    return account?.status === 'active' ? account.canonicalUserId : null;
  }

  /**
   * 获取或创建 canonical user，并确保平台账号映射存在。
   */
  async getOrCreateCanonicalUser(
    platform: PlatformAccountMapping['platform'],
    platformAccountId: string,
    accountType: PlatformAccountMapping['accountType'] = 'private'
  ): Promise<string> {
    const resolveIdentity = this.db.transaction(() => {
      const now = Date.now();
      const existing = this.findPlatformAccountSync(platform, platformAccountId);
      if (existing) {
        if (existing.status !== 'active') {
          throw new InactivePlatformAccountError(existing.status);
        }

        this.ensureCanonicalUserSync(existing.canonicalUserId, now);
        this.db.prepare(
          `UPDATE platform_accounts
           SET last_seen_at = ?
           WHERE platform = ? AND platform_account_id = ?`
        ).run(now, platform, platformAccountId);
        return existing.canonicalUserId;
      }

      const canonicalUserId = `user-${ulid()}`;
      this.ensureCanonicalUserSync(canonicalUserId, now);
      this.insertPlatformAccount({
        platform,
        platformAccountId,
        canonicalUserId,
        accountType,
        verifiedLevel: 'observed',
        status: 'active',
      }, now);
      return canonicalUserId;
    });

    return resolveIdentity.immediate();
  }

  private insertPlatformAccount(
    mapping: Omit<PlatformAccountMapping, 'firstSeenAt' | 'lastSeenAt'>,
    now: number
  ): void {
    this.db.prepare(
      `INSERT INTO platform_accounts (
        platform, platform_account_id, canonical_user_id,
        account_type, verified_level, status,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      mapping.platform,
      mapping.platformAccountId,
      mapping.canonicalUserId,
      mapping.accountType,
      mapping.verifiedLevel,
      mapping.status,
      now,
      now
    );
  }

  /**
   * 获取用户的所有平台账号
   */
  async getPlatformAccounts(canonicalUserId: string): Promise<PlatformAccountMapping[]> {
    const rows = this.db
      .prepare('SELECT * FROM platform_accounts WHERE canonical_user_id = ?')
      .all(canonicalUserId) as unknown[];

    return rows.map((r) => this.rowToPlatformAccount(r as Record<string, unknown>));
  }

  /**
   * 更新或创建显示资料
   */
  async upsertDisplayProfile(profile: Omit<DisplayProfile, 'observedAt'>): Promise<void> {
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO display_profiles (
          canonical_user_id, source_group_id,
          current_display_name, observed_at, trust
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(canonical_user_id, source_group_id) DO UPDATE SET
          current_display_name = excluded.current_display_name,
          observed_at = excluded.observed_at,
          trust = excluded.trust`
      )
      .run(
        profile.canonicalUserId,
        profile.sourceGroupId ?? '',
        profile.currentDisplayName,
        now,
        profile.trust
      );
  }

  /**
   * 获取显示资料
   */
  async getDisplayProfile(canonicalUserId: string, sourceGroupId?: string): Promise<DisplayProfile | null> {
    const row = this.db
      .prepare('SELECT * FROM display_profiles WHERE canonical_user_id = ? AND source_group_id = ?')
      .get(canonicalUserId, sourceGroupId ?? '') as Record<string, unknown> | undefined;

    return row ? this.rowToDisplayProfile(row) : null;
  }

  /**
   * 记录昵称历史
   */
  async recordNicknameHistory(
    canonicalUserId: string,
    displayName: string,
    sourceGroupId?: string
  ): Promise<void> {
    const id = ulid();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO nickname_history (
          id, canonical_user_id, source_group_id,
          display_name, observed_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, canonicalUserId, sourceGroupId ?? '', displayName, now);
  }

  /**
   * 注册或更新平台群组
   */
  async upsertPlatformGroup(
    platform: string,
    platformGroupId: string,
    groupName?: string
  ): Promise<string> {
    const id = `${platform}:${platformGroupId}`;
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO platform_groups (
          id, platform, platform_group_id, group_name,
          first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, platform_group_id) DO UPDATE SET
          group_name = COALESCE(excluded.group_name, group_name),
          last_seen_at = excluded.last_seen_at`
      )
      .run(id, platform, platformGroupId, groupName ?? null, now, now);

    return id;
  }

  /**
   * 将数据库行转换为 PlatformAccountMapping
   */
  private rowToPlatformAccount(row: Record<string, unknown>): PlatformAccountMapping {
    return {
      platform: row.platform as PlatformAccountMapping['platform'],
      platformAccountId: row.platform_account_id as string,
      canonicalUserId: row.canonical_user_id as string,
      accountType: row.account_type as PlatformAccountMapping['accountType'],
      verifiedLevel: row.verified_level as PlatformAccountMapping['verifiedLevel'],
      status: row.status as PlatformAccountMapping['status'],
      firstSeenAt: new Date(row.first_seen_at as number),
      lastSeenAt: new Date(row.last_seen_at as number),
    };
  }

  /**
   * 将数据库行转换为 DisplayProfile
   */
  private rowToDisplayProfile(row: Record<string, unknown>): DisplayProfile {
    return {
      canonicalUserId: row.canonical_user_id as string,
      sourceGroupId: row.source_group_id === '' ? undefined : (row.source_group_id as string),
      currentDisplayName: row.current_display_name as string,
      observedAt: new Date(row.observed_at as number),
      trust: row.trust as DisplayProfile['trust'],
    };
  }
}
