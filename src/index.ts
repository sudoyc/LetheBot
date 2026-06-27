/**
 * LetheBot Main Entry
 *
 * 集成所有模块，启动 HTTP 服务器接收 NapCat 事件
 */

import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig } from './config/index.js';
import { getLogger } from './logger/index.js';
import { initDatabase, runMigration } from './storage/database.js';
import { MemoryRepository } from './storage/memory-repository.js';
import { IdentityRepository } from './storage/identity-repository.js';
import { OneBotAdapter } from './gateway/onebot-adapter.js';
import { AttentionEngine } from './attention/engine.js';
import { ContextBuilder } from './context/builder.js';
import { PiAdapter } from './pi/pi-adapter.js';
import { ToolRegistry } from './tools/registry.js';
import { PolicyGate } from './policy/gate.js';
import { buildSystemPrompt } from './context/persona.js';
import type { ChatMessageReceived } from './types/events.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config = loadConfig();
const logger = getLogger();

export const VERSION = '0.1.0';

/**
 * 测试导出函数
 */
export function hello(): string {
  return `LetheBot v${VERSION}`;
}

/**
 * 主应用类
 */
class LetheBotApp {
  private db: Database.Database;
  private memoryRepo: MemoryRepository;
  private identityRepo: IdentityRepository;
  private adapter: OneBotAdapter;
  private attention: AttentionEngine;
  private contextBuilder: ContextBuilder;
  private toolRegistry: ToolRegistry;
  private policyGate: PolicyGate;
  private pi: PiAdapter;
  private server: ReturnType<typeof createServer> | null = null;

  constructor() {
    // 初始化数据库
    logger.info('Initializing database...');
    this.db = initDatabase({ path: config.dbPath });
    runMigration(this.db, join(__dirname, '../migrations/001_initial_schema.sql'));

    // 初始化存储层
    this.memoryRepo = new MemoryRepository(this.db);
    this.identityRepo = new IdentityRepository(this.db);

    // 初始化工具注册表和策略门
    this.toolRegistry = new ToolRegistry();
    this.policyGate = new PolicyGate(this.toolRegistry);

    // 初始化核心模块
    this.attention = new AttentionEngine();
    this.contextBuilder = new ContextBuilder(this.memoryRepo, this.identityRepo, this.db);

    // 初始化 Pi Agent
    const provider = process.env.PI_PROVIDER || 'openai';
    const model = process.env.PI_MODEL || 'deepseek-v4-flash';
    const baseUrl = process.env.PI_BASE_URL || 'https://api.deepseek.com/v1';

    // 读取 API Key
    let apiKey = process.env.PI_API_KEY || '';
    if (!apiKey) {
      try {
        const keyPath = join(homedir(), 'deepseek');
        apiKey = readFileSync(keyPath, 'utf-8').trim();
        logger.info({ keyPath }, 'Loaded API key from file');
      } catch {
        logger.warn('No API key found, Pi Agent may not work');
      }
    }

    this.pi = new PiAdapter({
      toolRegistry: this.toolRegistry,
      policyGate: this.policyGate,
      provider,
      model,
      apiKey,
      baseUrl,
    });

    logger.info({ provider, model, baseUrl }, 'Pi Agent initialized');

    // 初始化网关适配器
    const onebotHttpUrl = process.env.ONEBOT_HTTP_URL || 'http://localhost:3000';
    const onebotToken = process.env.ONEBOT_TOKEN;

    this.adapter = new OneBotAdapter({
      httpUrl: onebotHttpUrl,
      token: onebotToken,
    });

    // 注册事件处理器
    this.adapter.onEvent((event) => this.handleEvent(event));

    logger.info({ version: VERSION }, 'LetheBot initialized');
  }

  /**
   * 启动应用
   */
  async start(): Promise<void> {
    await this.adapter.start();

    // 启动 HTTP 服务器接收 NapCat POST 事件
    const port = parseInt(process.env.LETHEBOT_PORT || '6700', 10);

    this.server = createServer(async (req, res) => {
      // 健康检查
      if (req.url === '/healthz' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: VERSION }));
        return;
      }

      // OneBot 事件 endpoint
      if (req.url === '/onebot/event' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });

        req.on('end', () => {
          try {
            const event = JSON.parse(body);
            logger.debug({ event }, 'Received OneBot event');
            this.adapter.handleHttpEvent(event);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } catch (error) {
            logger.error({ error }, 'Failed to handle event');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        });
        return;
      }

      // 404
      res.writeHead(404);
      res.end('Not Found');
    });

    this.server.listen(port, '0.0.0.0', () => {
      logger.info(`LetheBot listening on port ${port}`);
      logger.info(`Health check: http://localhost:${port}/healthz`);
      logger.info(`OneBot endpoint: http://localhost:${port}/onebot/event`);
    });
  }

  /**
   * 停止应用
   */
  async stop(): Promise<void> {
    logger.info('Stopping LetheBot...');

    if (this.server) {
      this.server.close();
    }

    await this.adapter.stop();
    logger.info('LetheBot stopped');
  }

  /**
   * 存储原始事件到数据库
   */
  private async storeRawEvent(event: ChatMessageReceived): Promise<void> {
    const eventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    await this.db.prepare(`
      INSERT INTO raw_events (
        id, type, timestamp, source, platform,
        conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      event.type,
      new Date(event.timestamp).getTime(),
      'gateway',
      'qq',
      event.conversationId,
      JSON.stringify(event),
      Date.now(),
    );

    logger.debug({ eventId }, 'Raw event stored');
  }

  /**
   * 存储聊天消息到数据库
   */
  private async storeChatMessage(event: ChatMessageReceived, isFromBot: boolean = false): Promise<void> {
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const userId = event.message.senderId.replace('qq-', '');

    await this.db.prepare(`
      INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id,
        conversation_type, group_id, sender_id, sender_role,
        text, has_media, has_quote, mentions_bot,
        reply_to_message_id, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      `evt-${Date.now()}`, // 暂时用同样的 ID 格式
      event.message.messageId,
      event.conversationId,
      event.message.conversationType,
      event.message.groupId || null,
      userId,
      event.message.senderRole || null,
      event.message.content.text || '',
      event.message.content.media ? 1 : 0,
      event.message.content.quote ? 1 : 0,
      event.message.mentionsBot ? 1 : 0,
      event.message.replyToMessageId || null,
      new Date(event.timestamp).getTime(),
    );

    logger.debug({ messageId, isFromBot }, 'Chat message stored');
  }

  /**
   * 存储 Bot 回复到数据库
   */
  private async storeBotResponse(conversationId: string, text: string): Promise<void> {
    const messageId = `msg-bot-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    // 创建一个简化的 Bot 消息记录
    await this.db.prepare(`
      INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id,
        conversation_type, sender_id, text,
        has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      `evt-bot-${Date.now()}`,
      messageId, // Bot 消息使用内部 ID
      conversationId,
      'private', // 暂时默认，后续会改进
      'bot-self',
      text,
      0,
      0,
      0,
      Date.now(),
    );

    logger.debug({ messageId }, 'Bot response stored');
  }

  /**
   * 处理内部事件
   */
  private async handleEvent(event: ChatMessageReceived): Promise<void> {
    try {
      logger.info({
        type: event.type,
        conversationId: event.conversationId,
        senderId: event.message.senderId,
      }, 'Processing event');

      // 0. 存储原始事件（最优先）
      await this.storeRawEvent(event);

      // 0.1 存储聊天消息
      await this.storeChatMessage(event, false);

      // 1. 注意力分析
      let signals;
      try {
        signals = this.attention.analyze({
          conversationType: event.message.conversationType,
          mentionsBot: event.message.mentionsBot,
          text: event.message.content.text ?? '',
          senderId: event.message.senderId,
          replyToBot: false,
        });

        logger.debug({ signals }, 'Attention analysis');
      } catch (error) {
        logger.error({
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name,
          } : error,
          step: 'attention_analysis',
          eventType: event.type,
          conversationId: event.conversationId,
        }, 'Attention analysis failed');
        throw error;
      }

      // 如果不需要响应，直接返回
      if (signals.classification === 'silent') {
        logger.debug('Event classified as silent, skipping');
        return;
      }

      // 2. 构建上下文
      const userId = event.message.senderId.replace('qq-', '');
      const groupId = event.message.groupId?.replace('qq-group-', '');

      let context;
      try {
        context = await this.contextBuilder.buildContext({
          turnId: `turn-${Date.now()}`,
          conversationId: event.conversationId ?? event.message.conversationId,
          conversationType: event.message.conversationType,
          recentMessages: [
            {
              messageId: event.message.messageId,
              senderId: event.message.senderId,
              text: event.message.content.text ?? '',
              timestamp: event.timestamp,
              senderDisplayName: event.message.senderId,
              isFromBot: false,
            },
          ],
          targetUserId: userId,
          groupId,
        });

        logger.debug({
          memoryCount: context.memory.retrievedFacts.length,
          tokenBudget: context.tokenBudget,
        }, 'Context built');
      } catch (error) {
        logger.error({
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name,
          } : error,
          step: 'context_building',
          userId,
          groupId,
          conversationId: event.conversationId,
        }, 'Context building failed');
        throw error;
      }

      // 3. 调用推理核心（PiAdapter）
      let piResult;
      try {
        // 动态生成 system prompt
        const systemPrompt = buildSystemPrompt({
          conversationType: event.message.conversationType,
          hasMemorySystem: true,
        });

        piResult = await this.pi.runTurn({
          contextPack: context,
          systemPrompt,
          actor: {
            canonicalUserId: userId,
            actorClass: 'user',
          },
          invocationContext: event.message.conversationType === 'private' ? 'private_chat' : 'group_chat',
          turnId: `turn-${Date.now()}`,
        });

        logger.debug({
          responseLength: piResult.responseText?.length ?? 0,
          toolCallCount: piResult.toolCallIds.length,
          status: piResult.status,
        }, 'Pi response');
      } catch (error) {
        logger.error({
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name,
          } : error,
          step: 'pi_inference',
          userId,
          conversationId: event.conversationId,
        }, 'Pi inference failed');
        throw error;
      }

      // 4. 发送响应
      const responseText = piResult.responseText ?? '';
      if (responseText.trim().length > 0) {
        try {
          if (event.message.conversationType === 'private') {
            await this.adapter.sendPrivateMessage(event.message.senderId, responseText);
          } else if (event.message.conversationType === 'group' && event.message.groupId) {
            await this.adapter.sendGroupMessage(event.message.groupId, responseText);
          }

          logger.info({
            conversationId: event.conversationId,
            responseLength: responseText.length,
          }, 'Response sent');

          // 4.1 存储 Bot 回复
          await this.storeBotResponse(event.conversationId ?? event.message.conversationId, responseText);
        } catch (error) {
          logger.error({
            error: error instanceof Error ? {
              message: error.message,
              stack: error.stack,
              name: error.name,
            } : error,
            step: 'send_message',
            conversationType: event.message.conversationType,
            conversationId: event.conversationId,
            senderId: event.message.senderId,
            groupId: event.message.groupId,
            responseLength: responseText.length,
          }, 'Failed to send message');
          throw error;
        }
      }
    } catch (error) {
      logger.error({
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name,
        } : error,
        event: {
          type: event.type,
          conversationId: event.conversationId,
          senderId: event.message.senderId,
          conversationType: event.message.conversationType,
          messageId: event.message.messageId,
          timestamp: event.timestamp,
        },
      }, 'Failed to handle event');
    }
  }
}

/**
 * 主函数
 */
async function main() {
  const app = new LetheBotApp();

  // 优雅关闭
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down...');
    await app.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...');
    await app.stop();
    process.exit(0);
  });

  await app.start();
}

// 运行
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { LetheBotApp };
