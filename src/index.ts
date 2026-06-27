/**
 * LetheBot Main Entry
 *
 * 集成所有模块，启动 HTTP 服务器接收 NapCat 事件
 */

import { createServer } from 'node:http';
import { loadConfig } from './config';
import { getLogger } from './logger';
import { initDatabase, runMigration } from './storage/database';
import { MemoryRepository } from './storage/memory-repository';
import { IdentityRepository } from './storage/identity-repository';
import { OneBotAdapter } from './gateway/onebot-adapter';
import { AttentionEngine } from './attention/engine';
import { ContextBuilder } from './context/builder';
import { MockPi } from './pi/mock-pi';
import type { ChatMessageReceived } from './types/events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config = loadConfig();
const logger = getLogger();

export const VERSION = '0.1.0';

/**
 * 主应用类
 */
class LetheBotApp {
  private db: any;
  private memoryRepo: MemoryRepository;
  private identityRepo: IdentityRepository;
  private adapter: OneBotAdapter;
  private attention: AttentionEngine;
  private contextBuilder: ContextBuilder;
  private pi: MockPi;
  private server: any;

  constructor() {
    // 初始化数据库
    logger.info('Initializing database...');
    this.db = initDatabase({ path: config.dbPath });
    runMigration(this.db, join(__dirname, '../migrations/001_initial_schema.sql'));

    // 初始化存储层
    this.memoryRepo = new MemoryRepository(this.db);
    this.identityRepo = new IdentityRepository(this.db);

    // 初始化核心模块
    this.attention = new AttentionEngine();
    this.contextBuilder = new ContextBuilder(this.memoryRepo, this.identityRepo);
    this.pi = new MockPi();

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
   * 处理内部事件
   */
  private async handleEvent(event: ChatMessageReceived): Promise<void> {
    try {
      logger.info({
        type: event.type,
        conversationId: event.conversationId,
        senderId: event.message.senderId,
      }, 'Processing event');

      // 1. 注意力分析
      const signals = this.attention.analyze({
        conversationType: event.message.conversationType,
        mentionsBot: event.message.mentionsBot,
        text: event.message.content.text ?? '',
        senderId: event.message.senderId,
        replyToBot: false,
      });

      logger.debug({ signals }, 'Attention analysis');

      // 如果不需要响应，直接返回
      if (signals.classification === 'silent') {
        logger.debug('Event classified as silent, skipping');
        return;
      }

      // 2. 构建上下文
      const userId = event.message.senderId.replace('qq-', '');
      const groupId = event.message.groupId?.replace('qq-group-', '');

      const context = await this.contextBuilder.buildContext({
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

      // 3. 调用推理核心（MockPi）
      const piResult = await this.pi.run({
        contextPack: context,
      });

      logger.debug({
        responseLength: piResult.responseText?.length ?? 0,
        actionDecision: piResult.actionDecision,
      }, 'Pi response');

      // 4. 发送响应
      const responseText = piResult.responseText ?? '';
      if (responseText.trim().length > 0) {
        if (event.message.conversationType === 'private') {
          await this.adapter.sendPrivateMessage(event.message.senderId, responseText);
        } else if (event.message.conversationType === 'group' && event.message.groupId) {
          await this.adapter.sendGroupMessage(event.message.groupId, responseText);
        }

        logger.info({
          conversationId: event.conversationId,
          responseLength: responseText.length,
        }, 'Response sent');
      }
    } catch (error) {
      logger.error({ error, event }, 'Failed to handle event');
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
