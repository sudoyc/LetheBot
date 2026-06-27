/**
 * Identity & Display
 *
 * 平台账号映射和显示信息
 */

/**
 * 平台账号映射
 */
export interface PlatformAccountMapping {
  platform: 'qq';
  platformAccountId: string; // 原始 QQ 用户 ID
  canonicalUserId: string; // 内部 UUID/ULID

  accountType: 'private' | 'group_member' | 'temp_session';
  verifiedLevel: 'observed' | 'self_claimed' | 'owner_verified';
  status: 'active' | 'disabled' | 'deleted';

  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * 显示资料
 */
export interface DisplayProfile {
  canonicalUserId: string;

  // 当前显示（非历史）
  currentDisplayName: string;
  sourceGroupId?: string; // null = 私聊/全局昵称
  observedAt: Date;

  // 显示数据的信任级别
  trust: 'platform_provided' | 'user_set' | 'inferred';
}

/**
 * 昵称历史记录
 *
 * 昵称历史是单独的表，不在主 DisplayProfile 中
 */
export interface NicknameHistoryEntry {
  canonicalUserId: string;
  displayName: string;
  sourceGroupId?: string;
  observedAt: Date;
  observedUntil?: Date;
}
