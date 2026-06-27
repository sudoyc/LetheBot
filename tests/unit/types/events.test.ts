import { describe, it, expect } from 'vitest';
import type {
  InternalEvent,
  ChatMessageReceived,
  GatewayCapabilities,
  MediaAttachment,
  QuotedMessage,
} from '../../../src/types/events';

describe('Event Envelopes', () => {
  describe('InternalEvent', () => {
    it('should allow creating a base internal event', () => {
      const event: InternalEvent = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        type: 'test.event',
        timestamp: new Date(),
        source: 'system',
      };

      expect(event.id).toBeTruthy();
      expect(event.type).toBe('test.event');
      expect(event.source).toBe('system');
    });

    it('should allow optional fields', () => {
      const event: InternalEvent = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        type: 'test.event',
        timestamp: new Date(),
        source: 'gateway',
        platform: 'qq',
        conversationId: 'conv-123',
        correlationId: 'corr-456',
      };

      expect(event.platform).toBe('qq');
      expect(event.conversationId).toBe('conv-123');
      expect(event.correlationId).toBe('corr-456');
    });
  });

  describe('MediaAttachment', () => {
    it('should allow creating media attachments', () => {
      const attachment: MediaAttachment = {
        type: 'image',
        url: 'https://example.com/image.jpg',
        mimeType: 'image/jpeg',
        size: 1024,
      };

      expect(attachment.type).toBe('image');
      expect(attachment.url).toBeTruthy();
    });
  });

  describe('QuotedMessage', () => {
    it('should allow creating quoted message references', () => {
      const quote: QuotedMessage = {
        messageId: 'msg-789',
        senderId: 'user-123',
        text: 'Original message',
      };

      expect(quote.messageId).toBe('msg-789');
      expect(quote.senderId).toBe('user-123');
    });
  });

  describe('GatewayCapabilities', () => {
    it('should define gateway capabilities structure', () => {
      const capabilities: GatewayCapabilities = {
        platform: 'qq',
        reactions: {
          emojiLike: true,
          faceMessage: true,
        },
        foldedForward: {
          groupForward: true,
          privateForward: false,
          customNode: true,
        },
        platformAdmin: {
          kick: true,
          mute: true,
          setGroupCard: false,
        },
      };

      expect(capabilities.platform).toBe('qq');
      expect(capabilities.reactions.emojiLike).toBe(true);
      expect(capabilities.platformAdmin.kick).toBe(true);
    });
  });

  describe('ChatMessageReceived', () => {
    it('should allow creating a complete chat message event', () => {
      const event: ChatMessageReceived = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        type: 'chat.message.received',
        timestamp: new Date(),
        source: 'gateway',
        platform: 'qq',
        conversationId: 'conv-123',

        message: {
          messageId: 'msg-456',
          conversationId: 'conv-123',
          conversationType: 'group',
          groupId: 'group-789',
          senderId: 'user-alice',
          senderRole: 'member',

          content: {
            text: '你好',
            media: [
              {
                type: 'image',
                url: 'https://example.com/image.jpg',
              },
            ],
          },

          mentions: ['bot-123'],
          mentionsBot: true,
        },

        gatewayCapabilities: {
          platform: 'qq',
          reactions: {
            emojiLike: true,
            faceMessage: true,
          },
          foldedForward: {
            groupForward: true,
            privateForward: true,
            customNode: true,
          },
          platformAdmin: {
            kick: true,
            mute: true,
            setGroupCard: true,
          },
        },
      };

      expect(event.type).toBe('chat.message.received');
      expect(event.message.messageId).toBe('msg-456');
      expect(event.message.conversationType).toBe('group');
      expect(event.message.mentionsBot).toBe(true);
      expect(event.gatewayCapabilities.platform).toBe('qq');
    });

    it('should allow minimal private message', () => {
      const event: ChatMessageReceived = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        type: 'chat.message.received',
        timestamp: new Date(),
        source: 'gateway',
        platform: 'qq',

        message: {
          messageId: 'msg-001',
          conversationId: 'conv-private-001',
          conversationType: 'private',
          senderId: 'user-bob',
          content: {
            text: 'Hello',
          },
          mentionsBot: false,
        },

        gatewayCapabilities: {
          platform: 'qq',
          reactions: {
            emojiLike: false,
            faceMessage: true,
          },
          foldedForward: {
            groupForward: false,
            privateForward: false,
            customNode: false,
          },
          platformAdmin: {
            kick: false,
            mute: false,
            setGroupCard: false,
          },
        },
      };

      expect(event.message.conversationType).toBe('private');
      expect(event.message.groupId).toBeUndefined();
      expect(event.message.mentionsBot).toBe(false);
    });
  });
});
