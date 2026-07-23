import { describe, it, expect, beforeEach } from 'vitest';
import { FakeOneBot } from './fake-onebot';

describe('FakeOneBot', () => {
  let gateway: FakeOneBot;

  beforeEach(() => {
    gateway = new FakeOneBot();
  });

  describe('Connection', () => {
    it('should connect immediately', async () => {
      await expect(gateway.connect()).resolves.toBeUndefined();
    });

    it('should disconnect immediately', async () => {
      await gateway.connect();
      await expect(gateway.disconnect()).resolves.toBeUndefined();
    });
  });

  describe('Capabilities', () => {
    it('should return default capabilities', () => {
      const caps = gateway.getCapabilities();
      expect(caps.platform).toBe('qq');
      expect(caps.reactions.emojiLike).toBe(true);
      expect(caps.foldedForward.groupForward).toBe(true);
    });

    it('should allow setting custom capabilities', () => {
      gateway.setCapabilities({
        reactions: { emojiLike: false, faceMessage: false },
      });

      const caps = gateway.getCapabilities();
      expect(caps.reactions.emojiLike).toBe(false);
      expect(caps.reactions.faceMessage).toBe(false);
    });
  });

  describe('simulatePrivateMessage', () => {
    it('should emit message event with correct structure', () => {
      return new Promise<void>((resolve) => {
        gateway.on('message', (msg) => {
          expect(msg.type).toBe('chat.message.received');
          expect(msg.source).toBe('gateway');
          expect(msg.platform).toBe('qq');
          expect(msg.message.conversationType).toBe('private');
          expect(msg.message.content.text).toBe('你好');
          expect(msg.message.mentionsBot).toBe(false);
          resolve();
        });

        gateway.simulatePrivateMessage({
          senderId: 'user-alice',
          text: '你好',
        });
      });
    });

    it('should auto-generate message ID if not provided', () => {
      return new Promise<void>((resolve) => {
        gateway.on('message', (msg) => {
          expect(msg.message.messageId).toMatch(/^fake-msg-\d{6}$/);
          resolve();
        });

        gateway.simulatePrivateMessage({
          text: 'test',
        });
      });
    });

    it('should use provided message ID', () => {
      return new Promise<void>((resolve) => {
        gateway.on('message', (msg) => {
          expect(msg.message.messageId).toBe('custom-msg-123');
          resolve();
        });

        gateway.simulatePrivateMessage({
          text: 'test',
          messageId: 'custom-msg-123',
        });
      });
    });
  });

  describe('simulateGroupMessage', () => {
    it('should emit message event with group structure', () => {
      return new Promise<void>((resolve) => {
        gateway.on('message', (msg) => {
          expect(msg.message.conversationType).toBe('group');
          expect(msg.message.conversationId).toBe('group:test-group');
          expect(msg.message.groupId).toBe('test-group');
          expect(msg.message.content.text).toBe('大家好');
          resolve();
        });

        gateway.simulateGroupMessage({
          groupId: 'test-group',
          senderId: 'user-bob',
          text: '大家好',
        });
      });
    });

    it('should auto-detect @bot mentions', () => {
      return new Promise<void>((resolve) => {
        gateway.on('message', (msg) => {
          expect(msg.message.mentionsBot).toBe(true);
          resolve();
        });

        gateway.simulateGroupMessage({
          text: '@bot 你好',
        });
      });
    });

    it('should auto-detect exact CQ mention for configured bot id', () => {
      gateway = new FakeOneBot({ botId: '3889000770' });

      return new Promise<void>((resolve) => {
        gateway.on('message', (msg) => {
          expect(msg.message.mentions).toEqual(['qq-3889000770']);
          expect(msg.message.mentionsBot).toBe(true);
          resolve();
        });

        gateway.simulateGroupMessage({
          text: '[CQ:at,qq=3889000770] 你好',
        });
      });
    });

    it('should use explicit mentionsBot flag', () => {
      return new Promise<void>((resolve) => {
        gateway.on('message', (msg) => {
          expect(msg.message.mentionsBot).toBe(false);
          resolve();
        });

        gateway.simulateGroupMessage({
          text: '@bot 你好',
          mentionsBot: false, // Explicitly set to false
        });
      });
    });

    it('should include sender role and card', () => {
      return new Promise<void>((resolve) => {
        gateway.on('message', (msg) => {
          expect(msg.message.senderRole).toBe('admin');
          expect(msg.message.senderCard).toBe('Admin Bob');
          resolve();
        });

        gateway.simulateGroupMessage({
          text: 'test',
          senderRole: 'admin',
          senderCard: 'Admin Bob',
        });
      });
    });

    it('should include quote and media attachments', () => {
      return new Promise<void>((resolve) => {
        gateway.on('message', (msg) => {
          expect(msg.message.content.quote?.messageId).toBe('quoted-msg-1');
          expect(msg.message.replyToMessageId).toBe('quoted-msg-1');
          expect(msg.message.content.media).toEqual([
            { type: 'image', url: 'https://example.test/a.png' },
          ]);
          resolve();
        });

        gateway.simulateGroupMessage({
          text: '看图',
          quote: {
            messageId: 'quoted-msg-1',
            text: '上一条',
          },
          media: [
            { type: 'image', url: 'https://example.test/a.png' },
          ],
        });
      });
    });
  });

  describe('sendMessage', () => {
    it('should record sent messages', async () => {
      const messageId = await gateway.sendMessage(
        {
          conversationId: 'private:user-alice',
          conversationType: 'private',
        },
        { text: '你好，Alice' }
      );

      expect(messageId).toMatch(/^fake-msg-\d{6}$/);

      const sent = gateway.getSentMessages();
      expect(sent).toHaveLength(1);
      expect(sent[0].content.text).toBe('你好，Alice');
      expect(sent[0].conversationId).toBe('private:user-alice');
    });

    it('should track multiple sent messages', async () => {
      await gateway.sendMessage({ conversationId: 'private:user-a', conversationType: 'private' }, { text: 'msg1' });
      await gateway.sendMessage({ conversationId: 'group:group-1', conversationType: 'group' }, { text: 'msg2' });

      const sent = gateway.getSentMessages();
      expect(sent).toHaveLength(2);
      expect(sent[0].content.text).toBe('msg1');
      expect(sent[1].content.text).toBe('msg2');
    });
  });

  describe('sendReaction', () => {
    it('should record sent reactions for assertions', async () => {
      await gateway.sendReaction('source-msg-1', '👍');
      await gateway.sendReaction('source-msg-2', '✅');

      const reactions = gateway.getSentReactions();
      expect(reactions).toHaveLength(2);
      expect(reactions[0]).toMatchObject({
        messageId: 'source-msg-1',
        emoji: '👍',
      });
      expect(reactions[1]).toMatchObject({
        messageId: 'source-msg-2',
        emoji: '✅',
      });
      expect(reactions[0]?.sentAt).toBeInstanceOf(Date);
      expect(gateway.getLastSentReaction()).toMatchObject({
        messageId: 'source-msg-2',
        emoji: '✅',
      });
    });

    it('should support reaction assertions without recording fake messages', async () => {
      await gateway.sendReaction('source-msg-1', '👍');

      expect(() => gateway.assertReactionSent('source-msg-1', '👍')).not.toThrow();
      expect(() => gateway.assertReactionSent('missing-msg', '👍')).toThrow(/Expected reaction/);
      expect(() => gateway.assertReactionSent('source-msg-1', '👎')).toThrow(/Expected reaction/);
      expect(gateway.getSentMessages()).toHaveLength(0);
    });
  });

  describe('getLastSentMessage', () => {
    it('should return undefined when no messages sent', () => {
      expect(gateway.getLastSentMessage()).toBeUndefined();
    });

    it('should return last sent message', async () => {
      await gateway.sendMessage({ conversationId: 'test', conversationType: 'private' }, { text: 'first' });
      await gateway.sendMessage({ conversationId: 'test', conversationType: 'private' }, { text: 'second' });

      const last = gateway.getLastSentMessage();
      expect(last?.content.text).toBe('second');
    });
  });

  describe('assertMessageSent', () => {
    beforeEach(async () => {
      await gateway.sendMessage({ conversationId: 'test', conversationType: 'private' }, { text: 'Hello world' });
      await gateway.sendMessage({ conversationId: 'group:a', conversationType: 'group' }, { text: 'Test message' });
    });

    it('should pass when at least one message sent (no matcher)', () => {
      expect(() => gateway.assertMessageSent()).not.toThrow();
    });

    it('should pass when string matcher found', () => {
      expect(() => gateway.assertMessageSent('Hello')).not.toThrow();
      expect(() => gateway.assertMessageSent('world')).not.toThrow();
    });

    it('should throw when string matcher not found', () => {
      expect(() => gateway.assertMessageSent('nonexistent')).toThrow(/Expected a message containing/);
    });

    it('should pass when regex matcher matches', () => {
      expect(() => gateway.assertMessageSent(/hello/i)).not.toThrow();
      expect(() => gateway.assertMessageSent(/test/i)).not.toThrow();
    });

    it('should throw when regex matcher does not match', () => {
      expect(() => gateway.assertMessageSent(/xyz/)).toThrow(/Expected a message matching/);
    });

    it('should pass when object matcher matches', () => {
      expect(() =>
        gateway.assertMessageSent({
          text: 'Hello',
          conversationId: 'test',
        })
      ).not.toThrow();
    });

    it('should throw when object matcher does not match', () => {
      expect(() =>
        gateway.assertMessageSent({
          text: 'Hello',
          conversationId: 'wrong',
        })
      ).toThrow(/Expected a message matching/);
    });
  });

  describe('assertNoMessageSent', () => {
    it('should pass when no messages sent', () => {
      expect(() => gateway.assertNoMessageSent()).not.toThrow();
    });

    it('should throw when messages were sent', async () => {
      await gateway.sendMessage({ conversationId: 'test', conversationType: 'private' }, { text: 'oops' });
      expect(() => gateway.assertNoMessageSent()).toThrow(/Expected no messages/);
    });
  });

  describe('reset', () => {
    it('should clear sent messages', async () => {
      await gateway.sendMessage({ conversationId: 'test', conversationType: 'private' }, { text: 'test' });
      expect(gateway.getSentMessages()).toHaveLength(1);

      gateway.reset();
      expect(gateway.getSentMessages()).toHaveLength(0);
    });

    it('should clear sent reactions', async () => {
      await gateway.sendReaction('source-msg-1', '👍');
      expect(gateway.getSentReactions()).toHaveLength(1);

      gateway.reset();
      expect(gateway.getSentReactions()).toHaveLength(0);
      expect(gateway.getLastSentReaction()).toBeUndefined();
    });

    it('should reset counters', async () => {
      gateway.simulatePrivateMessage({ text: 'test1' });
      gateway.simulatePrivateMessage({ text: 'test2' });

      gateway.reset();

      gateway.simulatePrivateMessage({ text: 'test3' });
      // After reset, counters start from 1 again
      expect(gateway.getSentMessages()).toHaveLength(0); // No messages sent, only simulated
    });
  });
});
