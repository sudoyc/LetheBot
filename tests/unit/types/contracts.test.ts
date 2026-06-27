import { describe, it, expect } from 'vitest';
import * as contracts from '../../../src/types';

describe('Contract Validation', () => {
  describe('Module exports', () => {
    it('should export all event types', () => {
      expect(contracts).toBeDefined();
      // Type assertions - will fail at compile time if types are missing
      const _eventTest: contracts.InternalEvent = {} as contracts.InternalEvent;
      const _chatTest: contracts.ChatMessageReceived = {} as contracts.ChatMessageReceived;
      const _capTest: contracts.GatewayCapabilities = {} as contracts.GatewayCapabilities;
      void _eventTest;
      void _chatTest;
      void _capTest;
      expect(true).toBe(true);
    });

    it('should export all identity types', () => {
      const _mappingTest: contracts.PlatformAccountMapping = {} as contracts.PlatformAccountMapping;
      const _profileTest: contracts.DisplayProfile = {} as contracts.DisplayProfile;
      const _historyTest: contracts.NicknameHistoryEntry = {} as contracts.NicknameHistoryEntry;
      void _mappingTest;
      void _profileTest;
      void _historyTest;
      expect(true).toBe(true);
    });

    it('should export all context types', () => {
      const _contextTest: contracts.ContextPack = {} as contracts.ContextPack;
      const _messageTest: contracts.RecentMessage = {} as contracts.RecentMessage;
      const _memoryBlockTest: contracts.MemoryBlock = {} as contracts.MemoryBlock;
      const _participantTest: contracts.ParticipantContext = {} as contracts.ParticipantContext;
      void _contextTest;
      void _messageTest;
      void _memoryBlockTest;
      void _participantTest;
      expect(true).toBe(true);
    });

    it('should export all action types', () => {
      const _decisionTest: contracts.ActionDecision = {} as contracts.ActionDecision;
      const _planTest: contracts.ActionPlan = {} as contracts.ActionPlan;
      const _resultTest: contracts.ActionExecutionResult = {} as contracts.ActionExecutionResult;
      const _targetTest: contracts.ActionTarget = {} as contracts.ActionTarget;
      void _decisionTest;
      void _planTest;
      void _resultTest;
      void _targetTest;
      expect(true).toBe(true);
    });

    it('should export all memory types', () => {
      const _recordTest: contracts.MemoryRecord = {} as contracts.MemoryRecord;
      const _sourceTest: contracts.MemorySource = {} as contracts.MemorySource;
      const _revisionTest: contracts.MemoryRevision = {} as contracts.MemoryRevision;
      void _recordTest;
      void _sourceTest;
      void _revisionTest;
      expect(true).toBe(true);
    });

    it('should export all tool types', () => {
      const _registryTest: contracts.ToolRegistryEntry = {} as contracts.ToolRegistryEntry;
      const _callTest: contracts.ToolCallRequest = {} as contracts.ToolCallRequest;
      const _resultTest: contracts.ToolCallResult = {} as contracts.ToolCallResult;
      void _registryTest;
      void _callTest;
      void _resultTest;
      expect(true).toBe(true);
    });

    it('should export all agent types', () => {
      const _turnTest: contracts.AgentTurn = {} as contracts.AgentTurn;
      void _turnTest;
      expect(true).toBe(true);
    });

    it('should export all audit types', () => {
      const _auditTest: contracts.AuditEntry = {} as contracts.AuditEntry;
      const _errorTest: contracts.ErrorEnvelope = {} as contracts.ErrorEnvelope;
      void _auditTest;
      void _errorTest;
      expect(true).toBe(true);
    });

    it('should export all attention types', () => {
      const _signalsTest: contracts.AttentionSignals = {} as contracts.AttentionSignals;
      void _signalsTest;
      expect(true).toBe(true);
    });
  });

  describe('Type compatibility', () => {
    it('should allow ChatMessageReceived to extend InternalEvent', () => {
      const baseEvent: contracts.InternalEvent = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        type: 'chat.message.received',
        timestamp: new Date(),
        source: 'gateway',
        platform: 'qq',
      };

      const chatEvent: contracts.ChatMessageReceived = {
        ...baseEvent,
        type: 'chat.message.received',
        source: 'gateway',
        platform: 'qq',
        message: {
          messageId: 'msg-001',
          conversationId: 'conv-123',
          conversationType: 'private',
          senderId: 'user-001',
          content: { text: 'Hello' },
          mentionsBot: false,
        },
        gatewayCapabilities: {
          platform: 'qq',
          reactions: { emojiLike: false, faceMessage: true },
          foldedForward: { groupForward: false, privateForward: false, customNode: false },
          platformAdmin: { kick: false, mute: false, setGroupCard: false },
        },
      };

      // Should be assignable
      const _test: contracts.InternalEvent = chatEvent;
      void _test;
      expect(chatEvent.type).toBe('chat.message.received');
    });

    it('should allow ToolCallRequest to be used in ActionPayload', () => {
      const toolCall: contracts.ToolCallRequest = {
        id: 'tool-001',
        turnId: 'turn-001',
        toolName: 'search',
        input: { query: 'test' },
        requestedBy: 'pi',
        actor: { actorClass: 'user', canonicalUserId: 'user-001' },
        context: 'group_chat',
      };

      const payload: contracts.ActionPayload = {
        toolCall,
      };

      expect(payload.toolCall?.toolName).toBe('search');
    });

    it('should allow MemoryBlock in ContextPack', () => {
      const memoryBlock: contracts.MemoryBlock = {
        memoryId: 'mem-001',
        scope: 'user',
        title: 'Test',
        content: 'Content',
        confidence: 0.9,
      };

      const contextPack: contracts.ContextPack = {
        id: 'ctx-001',
        turnId: 'turn-001',
        createdAt: new Date(),
        conversation: {
          conversationId: 'conv-001',
          conversationType: 'private',
        },
        recentMessages: [],
        memory: {
          userProfile: memoryBlock,
          retrievedFacts: [memoryBlock],
          selectedMemoryIds: ['mem-001'],
        },
        participants: [],
        injectedIdentityFields: [],
        tokenBudget: {
          max: 8000,
          used: 500,
          breakdown: {
            recentMessages: 0,
            memory: 200,
            identity: 0,
            system: 300,
          },
        },
      };

      expect(contextPack.memory.userProfile?.memoryId).toBe('mem-001');
    });
  });

  describe('Enum types', () => {
    it('should validate ActionType values', () => {
      const validTypes: contracts.ActionType[] = [
        'silent_store',
        'silent_summarize_later',
        'reply_short',
        'reply_full',
        'reply_with_tool',
        'propose_memory',
        'admin_digest',
        'schedule_background_task',
        'dm_user',
        'react_only',
        'send_folded_forward',
        'ask_clarification',
      ];

      validTypes.forEach((type) => {
        const _test: contracts.ActionType = type;
        void _test;
        expect(type).toBeDefined();
      });
    });

    it('should validate ActorClass values', () => {
      const validClasses: contracts.ActorClass[] = [
        'owner',
        'admin',
        'trusted_user',
        'user',
        'group_admin',
        'system_worker',
        'evaluator',
        'tool',
      ];

      validClasses.forEach((actorClass) => {
        const _test: contracts.ActorClass = actorClass;
        void _test;
        expect(actorClass).toBeDefined();
      });
    });

    it('should validate ToolCapability values', () => {
      const validCapabilities: contracts.ToolCapability[] = [
        'read_context',
        'read_local',
        'write_local',
        'network',
        'shell_exec',
        'long_running',
        'sends_message',
        'modifies_memory',
        'external_side_effect',
        'credential_access',
        'platform_admin',
      ];

      validCapabilities.forEach((capability) => {
        const _test: contracts.ToolCapability = capability;
        void _test;
        expect(capability).toBeDefined();
      });
    });
  });
});
