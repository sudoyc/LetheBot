import { describe, it, expect } from 'vitest';
import type {
  PlatformAccountMapping,
  DisplayProfile,
  NicknameHistoryEntry,
} from '../../../src/types/identity';

describe('Identity & Display', () => {
  describe('PlatformAccountMapping', () => {
    it('should allow creating a platform account mapping', () => {
      const mapping: PlatformAccountMapping = {
        platform: 'qq',
        platformAccountId: '123456789',
        canonicalUserId: '01HZXYZ1234567890ABCDEFGHI',
        accountType: 'group_member',
        verifiedLevel: 'observed',
        status: 'active',
        firstSeenAt: new Date('2024-01-01'),
        lastSeenAt: new Date('2024-01-15'),
      };

      expect(mapping.platform).toBe('qq');
      expect(mapping.platformAccountId).toBe('123456789');
      expect(mapping.canonicalUserId).toBeTruthy();
      expect(mapping.status).toBe('active');
    });

    it('should support different account types', () => {
      const privateMapping: PlatformAccountMapping = {
        platform: 'qq',
        platformAccountId: '111',
        canonicalUserId: 'user-001',
        accountType: 'private',
        verifiedLevel: 'self_claimed',
        status: 'active',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      };

      const groupMapping: PlatformAccountMapping = {
        platform: 'qq',
        platformAccountId: '222',
        canonicalUserId: 'user-002',
        accountType: 'group_member',
        verifiedLevel: 'observed',
        status: 'active',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      };

      expect(privateMapping.accountType).toBe('private');
      expect(groupMapping.accountType).toBe('group_member');
    });

    it('should support disabled and deleted status', () => {
      const disabledMapping: PlatformAccountMapping = {
        platform: 'qq',
        platformAccountId: '333',
        canonicalUserId: 'user-003',
        accountType: 'group_member',
        verifiedLevel: 'observed',
        status: 'disabled',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      };

      expect(disabledMapping.status).toBe('disabled');
    });
  });

  describe('DisplayProfile', () => {
    it('should allow creating a display profile', () => {
      const profile: DisplayProfile = {
        canonicalUserId: '01HZXYZ1234567890ABCDEFGHI',
        currentDisplayName: 'Alice',
        observedAt: new Date(),
        trust: 'platform_provided',
      };

      expect(profile.canonicalUserId).toBeTruthy();
      expect(profile.currentDisplayName).toBe('Alice');
      expect(profile.trust).toBe('platform_provided');
    });

    it('should support group-specific display names', () => {
      const groupProfile: DisplayProfile = {
        canonicalUserId: 'user-001',
        currentDisplayName: 'Alice (Group Nickname)',
        sourceGroupId: 'group-123',
        observedAt: new Date(),
        trust: 'user_set',
      };

      expect(groupProfile.sourceGroupId).toBe('group-123');
      expect(groupProfile.currentDisplayName).toBe('Alice (Group Nickname)');
    });

    it('should support global display names without sourceGroupId', () => {
      const globalProfile: DisplayProfile = {
        canonicalUserId: 'user-001',
        currentDisplayName: 'Alice',
        observedAt: new Date(),
        trust: 'platform_provided',
      };

      expect(globalProfile.sourceGroupId).toBeUndefined();
    });
  });

  describe('NicknameHistoryEntry', () => {
    it('should allow creating nickname history entries', () => {
      const entry: NicknameHistoryEntry = {
        canonicalUserId: 'user-001',
        displayName: 'Old Nickname',
        sourceGroupId: 'group-123',
        observedAt: new Date('2024-01-01'),
        observedUntil: new Date('2024-01-15'),
      };

      expect(entry.canonicalUserId).toBe('user-001');
      expect(entry.displayName).toBe('Old Nickname');
      expect(entry.observedAt).toBeInstanceOf(Date);
      expect(entry.observedUntil).toBeInstanceOf(Date);
    });

    it('should allow entries without observedUntil (current)', () => {
      const currentEntry: NicknameHistoryEntry = {
        canonicalUserId: 'user-001',
        displayName: 'Current Nickname',
        observedAt: new Date(),
      };

      expect(currentEntry.observedUntil).toBeUndefined();
    });
  });
});
