import { describe, expect, it } from 'vitest';
import {
  parseStoredChatMessageReceived,
  type StoredChatEventRow,
} from '../../../src/ingestion/stored-chat-event.js';

const timestamp = '2026-07-10T04:00:00.000Z';
const event = {
  id: 'evt-stored-parser',
  type: 'chat.message.received',
  timestamp,
  source: 'gateway',
  platform: 'qq',
  conversationId: 'private:qq-812347101',
  ingress: {
    transport: 'http',
    platformEventId: 'qq-812347001',
  },
  message: {
    messageId: 'qq-812347001',
    conversationId: 'private:qq-812347101',
    conversationType: 'private',
    senderId: 'qq-812347101',
    content: {
      text: 'stored parser fixture',
      media: [],
    },
    mentions: [],
    mentionsBot: false,
  },
  gatewayCapabilities: {
    platform: 'qq',
    reactions: { emojiLike: false, faceMessage: true },
    foldedForward: { groupForward: false, privateForward: false, customNode: false },
    platformAdmin: { kick: false, mute: false, setGroupCard: false },
  },
};

function createRow(payload: unknown = event): StoredChatEventRow {
  return {
    id: event.id,
    type: event.type,
    timestamp: new Date(timestamp).getTime(),
    source: event.source,
    platform: event.platform,
    conversation_id: event.conversationId,
    correlation_id: null,
    platform_event_id: event.ingress.platformEventId,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

describe('parseStoredChatMessageReceived', () => {
  it('rehydrates a canonical stored event timestamp as Date', () => {
    const result = parseStoredChatMessageReceived(createRow());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected the stored event to parse');
    }
    expect(result.event.timestamp).toBeInstanceOf(Date);
    expect(result.event.timestamp.getTime()).toBe(new Date(timestamp).getTime());
  });

  it.each([
    ['invalid JSON', '{invalid-json'],
    ['wrong event source', { ...event, source: 'worker' }],
    ['invalid timestamp', { ...event, timestamp: 'not-a-timestamp' }],
    ['malformed nested message', { ...event, message: { mentionsBot: false } }],
    ['private event with a group', {
      ...event,
      message: { ...event.message, groupId: 'qq-group-812347201' },
    }],
  ])('rejects %s without returning parser diagnostics', (_label, payload) => {
    expect(parseStoredChatMessageReceived(createRow(payload))).toEqual({ ok: false });
  });

  it('rejects payload metadata that differs from the canonical raw row', () => {
    expect(parseStoredChatMessageReceived({
      ...createRow(),
      platform_event_id: 'qq-812347999',
    })).toEqual({ ok: false });
  });

  it('rejects oversized stored payloads before parsing', () => {
    expect(parseStoredChatMessageReceived(createRow('x'.repeat(1024 * 1024 + 1))))
      .toEqual({ ok: false });
  });
});
