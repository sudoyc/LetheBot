import { describe, it, expect } from 'vitest';
import type {
  ContextPack,
  RecentMessage,
  MemoryBlock,
  ParticipantContext,
} from '../../../src/types/context';

describe('Context Pack', () => {
  describe('RecentMessage', () => {
    it('should allow creating recent message entries', () => {
      const message: RecentMessage = {
        messageId: 'msg-001',
        senderId: 'user-001',
        senderDisplayName: 'Alice',
        text: 'Hello world',
        timestamp: new Date(),
        isFromBot: false,
      };

      expect(message.messageId).toBe('msg-001');
      expect(message.senderDisplayName).toBe('Alice');
      expect(message.isFromBot).toBe(false);
    });

    it('should allow messages without text', () => {
      const message: RecentMessage = {
        messageId: 'msg-002',
        senderId: 'user-002',
        senderDisplayName: 'Bob',
        timestamp: new Date(),
        isFromBot: false,
      };

      expect(message.text).toBeUndefined();
    });
  });

  describe('MemoryBlock', () => {
    it('should allow creating memory blocks', () => {
      const memory: MemoryBlock = {
        memoryId: 'mem-001',
        scope: 'user',
        title: 'User preference',
        content: 'Prefers concise responses',
        confidence: 0.9,
        sourceContext: 'chat_message:msg-123',
      };

      expect(memory.memoryId).toBe('mem-001');
      expect(memory.confidence).toBe(0.9);
      expect(memory.sourceContext).toBeTruthy();
    });

    it('should allow memory without sourceContext', () => {
      const memory: MemoryBlock = {
        memoryId: 'mem-002',
        scope: 'group',
        title: 'Group rule',
        content: 'No spam allowed',
        confidence: 1.0,
      };

      expect(memory.sourceContext).toBeUndefined();
    });
  });

  describe('ParticipantContext', () => {
    it('should allow creating participant context', () => {
      const participant: ParticipantContext = {
        canonicalUserId: 'user-001',
        displayName: 'Alice',
        groupCard: 'Alice (Admin)',
        role: 'admin',
        isOwner: false,
        isAdmin: true,
        isTrusted: true,
        platformAccountId: '123456789',
      };

      expect(participant.canonicalUserId).toBe('user-001');
      expect(participant.role).toBe('admin');
      expect(participant.isAdmin).toBe(true);
      expect(participant.platformAccountId).toBe('123456789');
    });

    it('should allow minimal participant context', () => {
      const participant: ParticipantContext = {
        canonicalUserId: 'user-002',
        displayName: 'Bob',
        isOwner: false,
        isAdmin: false,
        isTrusted: false,
      };

      expect(participant.groupCard).toBeUndefined();
      expect(participant.role).toBeUndefined();
      expect(participant.platformAccountId).toBeUndefined();
    });
  });

  describe('ContextPack', () => {
    it('should allow creating a complete context pack', () => {
      const contextPack: ContextPack = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        turnId: 'turn-001',
        createdAt: new Date(),

        conversation: {
          conversationId: 'conv-123',
          conversationType: 'group',
          groupId: 'group-456',
        },

        recentMessages: [
          {
            messageId: 'msg-001',
            senderId: 'user-001',
            senderDisplayName: 'Alice',
            text: 'Hello',
            timestamp: new Date(),
            isFromBot: false,
          },
          {
            messageId: 'msg-002',
            senderId: 'bot-001',
            senderDisplayName: 'Bot',
            text: 'Hi there!',
            timestamp: new Date(),
            isFromBot: true,
          },
        ],

        memory: {
          userProfile: {
            memoryId: 'mem-user-001',
            scope: 'user',
            title: 'User preference',
            content: 'Prefers technical explanations',
            confidence: 0.9,
          },
          groupProfile: {
            memoryId: 'mem-group-001',
            scope: 'group',
            title: 'Group rules',
            content: 'Keep discussions on-topic',
            confidence: 1.0,
          },
          retrievedFacts: [
            {
              memoryId: 'mem-fact-001',
              scope: 'conversation',
              title: 'Previous topic',
              content: 'Discussed database schema',
              confidence: 0.8,
            },
          ],
          selectedMemoryIds: ['mem-user-001', 'mem-group-001', 'mem-fact-001'],
        },

        participants: [
          {
            canonicalUserId: 'user-001',
            displayName: 'Alice',
            role: 'admin',
            isOwner: false,
            isAdmin: true,
            isTrusted: true,
          },
        ],

        injectedIdentityFields: ['current_display_name', 'sender_role'],

        tokenBudget: {
          max: 8000,
          used: 2500,
          breakdown: {
            recentMessages: 1000,
            memory: 800,
            identity: 200,
            system: 500,
          },
        },
      };

      expect(contextPack.id).toBeTruthy();
      expect(contextPack.conversation.conversationType).toBe('group');
      expect(contextPack.recentMessages).toHaveLength(2);
      expect(contextPack.memory.retrievedFacts).toHaveLength(1);
      expect(contextPack.participants).toHaveLength(1);
      expect(contextPack.tokenBudget.used).toBe(2500);
    });

    it('should allow private conversation context pack', () => {
      const contextPack: ContextPack = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        turnId: 'turn-002',
        createdAt: new Date(),

        conversation: {
          conversationId: 'conv-private-001',
          conversationType: 'private',
        },

        recentMessages: [],

        memory: {
          retrievedFacts: [],
          selectedMemoryIds: [],
        },

        participants: [],

        injectedIdentityFields: [],

        tokenBudget: {
          max: 8000,
          used: 500,
          breakdown: {
            recentMessages: 0,
            memory: 0,
            identity: 0,
            system: 500,
          },
        },
      };

      expect(contextPack.conversation.conversationType).toBe('private');
      expect(contextPack.conversation.groupId).toBeUndefined();
      expect(contextPack.memory.userProfile).toBeUndefined();
      expect(contextPack.memory.groupProfile).toBeUndefined();
    });
  });
});
