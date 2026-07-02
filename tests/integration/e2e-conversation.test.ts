import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LetheBotApp } from '../../src/index.js';
import { resetConfig } from '../../src/config/index.js';
import type { OneBotMessage } from '../../src/gateway/onebot-adapter.js';

interface PersistedMessageRow {
  id: string;
  raw_event_id: string;
  message_id: string;
  conversation_id: string;
  conversation_type: string;
  group_id: string | null;
  sender_id: string;
  sender_role: string | null;
  text: string | null;
  has_media: number;
  has_quote: number;
  mentions_bot: number;
  reply_to_message_id: string | null;
  raw_type: string;
}

describe('E2E Conversation Flow', () => {
  const originalEnv = process.env;
  let app: LetheBotApp;
  let testPort: number;
  let baseUrl: string;
  let testDir: string;

  beforeAll(async () => {
    process.env = { ...originalEnv };
    resetConfig();

    // Use random high port for test to avoid conflicts
    testPort = 16700 + Math.floor(Math.random() * 1000);
    testDir = mkdtempSync(join(tmpdir(), 'lethebot-e2e-conversation-'));

    process.env.LETHEBOT_TEST = 'true';
    process.env.LETHEBOT_PORT = testPort.toString();
    process.env.LETHEBOT_DB_PATH = join(testDir, 'lethebot-e2e.db');
    process.env.ONEBOT_HTTP_URL = 'http://localhost:3000';
    process.env.ONEBOT_TOKEN = 'test-onebot-token';
    process.env.LETHEBOT_BOT_QQ_ID = '3889000770';
    process.env.PI_PROVIDER = 'mock';
    process.env.PI_MODEL = 'mock';
    process.env.LOG_LEVEL = 'fatal'; // Suppress logs during tests

    baseUrl = `http://localhost:${testPort}`;

    app = new LetheBotApp();
    await app.start();

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    if (app) {
      await app.stop();
    }
    rmSync(testDir, { recursive: true, force: true });
    process.env = originalEnv;
    resetConfig();
  });

  afterEach(async () => {
    await app.waitForIdle();
    expect(app.getEventProcessingFailures()).toHaveLength(0);
  });

  async function postEvent(event: unknown, token: string | null = 'test-onebot-token'): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`${baseUrl}/onebot/event`, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
    });

    await app.waitForIdle();
    return response;
  }

  function getPersistedMessage(platformMessageId: string): PersistedMessageRow | undefined {
    return app
      .getDatabase()
      .prepare(
        `SELECT
          cm.id,
          cm.raw_event_id,
          cm.message_id,
          cm.conversation_id,
          cm.conversation_type,
          cm.group_id,
          cm.sender_id,
          cm.sender_role,
          cm.text,
          cm.has_media,
          cm.has_quote,
          cm.mentions_bot,
          cm.reply_to_message_id,
          re.type AS raw_type
        FROM chat_messages cm
        JOIN raw_events re ON re.id = cm.raw_event_id
        WHERE cm.message_id = ?`
      )
      .get(platformMessageId) as PersistedMessageRow | undefined;
  }

  function expectNoForeignKeyViolations(): void {
    const violations = app.getDatabase().prepare('PRAGMA foreign_key_check').all();
    expect(violations).toHaveLength(0);
  }

  describe('Health check', () => {
    it('should respond to health check', async () => {
      const response = await fetch(`${baseUrl}/healthz`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.version).toBeDefined();
      expect(data.checks.database.ok).toBe(true);
      expect(data.checks.adapter.ready).toBe(true);
      expect(data.checks.adapter.hasToken).toBe(true);
      expect(data.checks.adapter.botIdConfigured).toBe(true);
    });
  });

  describe('Private message flow', () => {
    it('should accept and process private message', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 12345,
        user_id: 10001,
        message: '你好',
        raw_message: '你好',
        sender: {
          user_id: 10001,
          nickname: 'TestUser',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');

      const persisted = getPersistedMessage('qq-12345');
      expect(persisted).toBeDefined();
      expect(persisted?.raw_event_id).toBe(persisted?.id);
      expect(persisted?.raw_type).toBe('chat.message.received');
      expect(persisted?.conversation_id).toBe('private:qq-10001');
      expect(persisted?.conversation_type).toBe('private');
      expect(persisted?.sender_id).toBe('qq-10001');
      expect(persisted?.text).toBe('你好');
      expectNoForeignKeyViolations();
    });

    it('should handle private message with mention', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 12346,
        user_id: 10002,
        message: '@bot 今天天气怎么样？',
        raw_message: '@bot 今天天气怎么样？',
        sender: {
          user_id: 10002,
          nickname: 'TestUser2',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');
    });
  });

  describe('Group message flow', () => {
    it('should accept and process group message with @mention', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'group',
        message_id: 23456,
        user_id: 20001,
        group_id: 100001,
        message: '[CQ:at,qq=3889000770] 你好',
        raw_message: '[CQ:at,qq=3889000770] 你好',
        sender: {
          user_id: 20001,
          nickname: 'GroupUser1',
          card: 'Card1',
          role: 'admin',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');

      const persisted = getPersistedMessage('qq-23456');
      expect(persisted).toBeDefined();
      expect(persisted?.raw_event_id).toBe(persisted?.id);
      expect(persisted?.raw_type).toBe('chat.message.received');
      expect(persisted?.conversation_id).toBe('qq-group-100001');
      expect(persisted?.conversation_type).toBe('group');
      expect(persisted?.group_id).toBe('qq-group-100001');
      expect(persisted?.sender_id).toBe('qq-20001');
      expect(persisted?.sender_role).toBe('admin');
      expect(persisted?.text).toBe('你好');
      expect(persisted?.mentions_bot).toBe(1);

      const displayProfile = app
        .getDatabase()
        .prepare(
          `SELECT dp.current_display_name, dp.source_group_id, dp.trust
           FROM display_profiles dp
           JOIN platform_accounts pa ON pa.canonical_user_id = dp.canonical_user_id
           WHERE pa.platform = 'qq' AND pa.platform_account_id = ?`
        )
        .get('20001') as { current_display_name: string; source_group_id: string; trust: string } | undefined;
      expect(displayProfile?.current_display_name).toBe('Card1');
      expect(displayProfile?.source_group_id).toBe('qq-group-100001');
      expect(displayProfile?.trust).toBe('platform_provided');
      expectNoForeignKeyViolations();
    });

    it('should accept group message without @mention', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'group',
        message_id: 23457,
        user_id: 20002,
        group_id: 100001,
        message: '今天天气不错',
        raw_message: '今天天气不错',
        sender: {
          user_id: 20002,
          nickname: 'GroupUser2',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');

      const persisted = getPersistedMessage('qq-23457');
      expect(persisted).toBeDefined();
      expect(persisted?.conversation_type).toBe('group');
      expect(persisted?.mentions_bot).toBe(0);
      expectNoForeignKeyViolations();
    });

    it('should not treat non-target CQ at mention as a bot mention', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'group',
        message_id: 23459,
        user_id: 20004,
        group_id: 100001,
        message: '[CQ:at,qq=111111] 这不是在叫机器人',
        raw_message: '[CQ:at,qq=111111] 这不是在叫机器人',
        sender: {
          user_id: 20004,
          nickname: 'GroupUser4',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);

      const persisted = getPersistedMessage('qq-23459');
      expect(persisted).toBeDefined();
      expect(persisted?.text).toBe('这不是在叫机器人');
      expect(persisted?.mentions_bot).toBe(0);
      expectNoForeignKeyViolations();
    });

    it('should handle group message with question', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'group',
        message_id: 23458,
        user_id: 20003,
        group_id: 100001,
        message: '[CQ:at,qq=3889000770] 今天星期几？',
        raw_message: '[CQ:at,qq=3889000770] 今天星期几？',
        sender: {
          user_id: 20003,
          nickname: 'GroupUser3',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');
    });
  });

  describe('Non-message events', () => {
    it('should handle notice events gracefully', async () => {
      const onebotEvent = {
        post_type: 'notice',
        notice_type: 'group_increase',
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');
    });

    it('should handle meta events gracefully', async () => {
      const onebotEvent = {
        post_type: 'meta_event',
        meta_event_type: 'heartbeat',
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');
    });
  });

  describe('Error handling', () => {
    it('should handle malformed JSON', async () => {
      const response = await fetch(`${baseUrl}/onebot/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-onebot-token',
        },
        body: 'invalid json{{{',
      });

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBeDefined();
    });

    it('should reject event POST without configured bearer token', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 81234,
        user_id: 81234,
        message: '未授权消息',
        raw_message: '未授权消息',
        sender: {
          user_id: 81234,
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent, null);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Unauthorized');
      expect(getPersistedMessage('qq-81234')).toBeUndefined();
    });

    it('should return 404 for unknown endpoints', async () => {
      const response = await fetch(`${baseUrl}/unknown`);
      expect(response.status).toBe(404);
    });

    it('should reject non-POST requests to event endpoint', async () => {
      const response = await fetch(`${baseUrl}/onebot/event`, {
        method: 'GET',
      });
      expect(response.status).toBe(404);
    });
  });

  describe('Message content variations', () => {
    it('should handle empty message', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 12347,
        user_id: 10003,
        message: '',
        raw_message: '',
        sender: {
          user_id: 10003,
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
    });

    it('should handle long message', async () => {
      const longText = 'a'.repeat(5000);
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 12348,
        user_id: 10004,
        message: longText,
        raw_message: longText,
        sender: {
          user_id: 10004,
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
    });

    it('should handle message with special characters', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 12349,
        user_id: 10005,
        message: '特殊字符测试 🎉 @#$%^&* \n\t\r',
        raw_message: '特殊字符测试 🎉 @#$%^&* \n\t\r',
        sender: {
          user_id: 10005,
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);
    });

    it('should persist quote and media flags without storing CQ tags as message text', async () => {
      const onebotEvent: OneBotMessage = {
        post_type: 'message',
        message_type: 'private',
        message_id: 12350,
        user_id: 10006,
        message: '[CQ:reply,id=12349][CQ:image,url=https://example.test/image.png] 看图',
        raw_message: '[CQ:reply,id=12349][CQ:image,url=https://example.test/image.png] 看图',
        sender: {
          user_id: 10006,
          nickname: 'MediaUser',
        },
        time: Math.floor(Date.now() / 1000),
      };

      const response = await postEvent(onebotEvent);

      expect(response.status).toBe(200);

      const persisted = getPersistedMessage('qq-12350');
      expect(persisted).toBeDefined();
      expect(persisted?.text).toBe('看图');
      expect(persisted?.has_quote).toBe(1);
      expect(persisted?.has_media).toBe(1);
      expect(persisted?.reply_to_message_id).toBe('qq-12349');
      expectNoForeignKeyViolations();
    });
  });

  describe('Concurrent requests', () => {
    it('should handle multiple concurrent requests', async () => {
      const requests = Array.from({ length: 5 }, (_, i) => {
        const onebotEvent: OneBotMessage = {
          post_type: 'message',
          message_type: 'private',
          message_id: 90000 + i,
          user_id: 90000 + i,
          message: `Concurrent message ${i}`,
          raw_message: `Concurrent message ${i}`,
          sender: {
            user_id: 90000 + i,
          },
          time: Math.floor(Date.now() / 1000),
        };

        return fetch(`${baseUrl}/onebot/event`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-onebot-token',
          },
          body: JSON.stringify(onebotEvent),
        });
      });

      const responses = await Promise.all(requests);
      await app.waitForIdle();

      for (const response of responses) {
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('ok');
      }

      expectNoForeignKeyViolations();
    });
  });
});
