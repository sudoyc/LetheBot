/**
 * LetheBot Main Entry
 *
 * 集成所有模块，启动 HTTP 服务器接收 NapCat 事件
 */

import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig, type Config } from './config/index.js';
import { getLogger } from './logger/index.js';
import { closeDatabase, initDatabase, runMigration } from './storage/database.js';
import { MemoryRepository } from './storage/memory-repository.js';
import { IdentityRepository } from './storage/identity-repository.js';
import { AuditRepository } from './storage/audit-repository.js';
import { OneBotAdapter } from './gateway/onebot-adapter.js';
import { AttentionEngine } from './attention/engine.js';
import { ContextBuilder } from './context/builder.js';
import { PiAdapter, type PiAdapterInput, type PiAdapterOutput } from './pi/pi-adapter.js';
import { ToolRegistry } from './tools/registry.js';
import { PolicyGate } from './policy/gate.js';
import { buildSystemPrompt } from './context/persona.js';
import { MemoryExtractionWorker } from './workers/memory-extraction.js';
import { WorkerScheduler } from './workers/scheduler.js';
import type { ChatMessageReceived } from './types/events.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  private config: Config;
  private db: Database.Database;
  private memoryRepo: MemoryRepository;
  private identityRepo: IdentityRepository;
  private auditRepo: AuditRepository;
  private adapter: OneBotAdapter;
  private attention: AttentionEngine;
  private contextBuilder: ContextBuilder;
  private toolRegistry: ToolRegistry;
  private policyGate: PolicyGate;
  private pi: { runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> };
  private memoryExtractor: MemoryExtractionWorker;
  private workerScheduler: WorkerScheduler;
  private server: ReturnType<typeof createServer> | null = null;
  private pendingEventTasks = new Set<Promise<void>>();
  private eventProcessingFailures: Array<{
    eventId: string;
    messageId: string;
    conversationId?: string;
    errorMessage: string;
  }> = [];

  constructor() {
    this.config = loadConfig();

    // 初始化数据库
    logger.info('Initializing database...');
    this.db = initDatabase({ path: this.config.dbPath });
    runMigration(this.db, join(__dirname, '../migrations/001_initial_schema.sql'));

    // 初始化存储层
    this.memoryRepo = new MemoryRepository(this.db);
    this.identityRepo = new IdentityRepository(this.db);
    this.auditRepo = new AuditRepository(this.db);

    // 初始化工具注册表和策略门
    this.toolRegistry = new ToolRegistry();
    this.policyGate = new PolicyGate(this.toolRegistry);

    // 初始化核心模块
    this.attention = new AttentionEngine();
    this.contextBuilder = new ContextBuilder(this.memoryRepo, this.identityRepo, this.db);
    this.memoryExtractor = new MemoryExtractionWorker(this.db, this.memoryRepo);
    this.workerScheduler = new WorkerScheduler();

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

    this.pi = this.config.test || provider === 'mock'
      ? this.createTestPiRuntime()
      : new PiAdapter({
          toolRegistry: this.toolRegistry,
          policyGate: this.policyGate,
          provider,
          model,
          apiKey,
          baseUrl,
          auditRepository: this.auditRepo,
        });

    logger.info({ provider, model, baseUrl }, 'Pi Agent initialized');

    // 初始化网关适配器
    this.adapter = new OneBotAdapter({
      transport: this.config.onebotTransport,
      httpUrl: this.config.onebotHttpUrl,
      wsUrl: this.config.onebotWsUrl,
      token: this.config.onebotToken,
      botId: this.config.onebotBotQqId,
    });

    // 注册事件处理器
    this.adapter.onEvent((event) => this.enqueueEvent(event));

    logger.info({ version: VERSION }, 'LetheBot initialized');
  }

  /**
   * 启动应用
   */
  async start(): Promise<void> {
    await this.adapter.start();

    // 启动 HTTP 服务器接收健康检查和 OneBot reverse HTTP 事件
    const port = this.config.lethebotPort;

    this.server = createServer(async (req, res) => {
      // 健康检查
      const requestPath = this.getRequestPath(req.url);

      if (requestPath === this.config.lethebotHealthPath && req.method === 'GET') {
        const health = this.buildHealthStatus();
        res.writeHead(health.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
        return;
      }

      // OneBot 事件 endpoint
      if (requestPath === this.config.lethebotEventPath && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });

        req.on('end', () => {
          try {
            if (!this.adapter.validateHttpEventAuth(req.headers, body)) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Unauthorized' }));
              return;
            }

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

    this.server.listen(port, this.config.lethebotHost, () => {
      logger.info(`LetheBot listening on ${this.config.lethebotHost}:${port}`);
      logger.info(`Health check: http://localhost:${port}${this.config.lethebotHealthPath}`);
      logger.info(`OneBot endpoint: http://localhost:${port}${this.config.lethebotEventPath}`);
    });
  }

  /**
   * 停止应用
   */
  async stop(): Promise<void> {
    logger.info('Stopping LetheBot...');

    // 停止 Worker Scheduler
    this.workerScheduler.stop();

    if (this.server) {
      this.server.close();
    }

    await this.adapter.stop();
    if (this.db.open) {
      closeDatabase(this.db);
    }
    logger.info('LetheBot stopped');
  }

  /**
   * 等待当前已入队事件处理完成，供测试/运维检查使用。
   */
  async waitForIdle(): Promise<void> {
    while (this.pendingEventTasks.size > 0) {
      await Promise.allSettled(Array.from(this.pendingEventTasks));
    }
  }

  /**
   * 返回事件处理失败记录，避免异步 handler 失败只能落日志。
   */
  getEventProcessingFailures(): ReadonlyArray<{
    eventId: string;
    messageId: string;
    conversationId?: string;
    errorMessage: string;
  }> {
    return this.eventProcessingFailures;
  }

  /**
   * 暴露当前 DB 连接用于 integration tests 验证持久化副作用。
   */
  getDatabase(): Database.Database {
    return this.db;
  }

  private getRequestPath(url: string | undefined): string {
    return new URL(url ?? '/', 'http://localhost').pathname;
  }

  private buildHealthStatus(): {
    status: 'ok' | 'degraded';
    version: string;
    checks: {
      database: { ok: boolean; open: boolean; error?: string };
      adapter: ReturnType<OneBotAdapter['getReadiness']>;
    };
  } {
    let databaseOk = false;
    let databaseError: string | undefined;

    try {
      if (this.db.open) {
        this.db.prepare('SELECT 1').get();
        databaseOk = true;
      }
    } catch (error) {
      databaseError = error instanceof Error ? error.message : 'Unknown database health error';
    }

    const adapter = this.adapter.getReadiness();
    const status = databaseOk && adapter.ready ? 'ok' : 'degraded';

    return {
      status,
      version: VERSION,
      checks: {
        database: {
          ok: databaseOk,
          open: this.db.open,
          error: databaseError,
        },
        adapter,
      },
    };
  }

  private enqueueEvent(event: ChatMessageReceived): void {
    const task = this.handleEvent(event);
    this.pendingEventTasks.add(task);
    task.finally(() => {
      this.pendingEventTasks.delete(task);
    });
  }

  private createTestPiRuntime(): { runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> } {
    return {
      async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
        return {
          turnId: input.turnId,
          responseText: '',
          toolCallIds: [],
          events: [],
          tokensUsed: { input: 0, output: 0, total: 0 },
          status: 'completed',
        };
      },
    };
  }

  /**
   * 解析用户身份（canonical_user_id）
   */
  private async resolveIdentity(platformUserId: string): Promise<string> {
    try {
      // 1. 查找现有映射
      const existingUserId = await this.identityRepo.findCanonicalUserId('qq', platformUserId);

      if (existingUserId) {
        // 更新最后见到时间
        await this.identityRepo.ensureCanonicalUser(existingUserId);
        return existingUserId;
      }

      // 2. 创建新用户
      const canonicalUserId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

      await this.identityRepo.ensureCanonicalUser(canonicalUserId);

      await this.identityRepo.upsertPlatformAccount({
        canonicalUserId,
        platform: 'qq',
        platformAccountId: platformUserId,
        accountType: 'private',
        verifiedLevel: 'observed',
        status: 'active',
      });

      logger.debug({ canonicalUserId, platformUserId }, 'Created new user identity');
      return canonicalUserId;
    } catch (error) {
      logger.error({ error, platformUserId }, 'Failed to resolve identity');
      throw error;
    }
  }

  /**
   * 存储原始事件到数据库
   */
  private async storeRawEvent(event: ChatMessageReceived): Promise<string> {
    const eventId = event.id;
    await this.db.prepare(`
      INSERT INTO raw_events (
        id, type, timestamp, source, platform,
        conversation_id, correlation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      event.type,
      new Date(event.timestamp).getTime(),
      event.source,
      event.platform,
      event.conversationId,
      event.correlationId ?? null,
      JSON.stringify(event),
      Date.now(),
    );

    logger.debug({ eventId }, 'Raw event stored');
    return eventId;
  }

  /**
   * 存储聊天消息到数据库
   */
  private async storeChatMessage(
    event: ChatMessageReceived,
    rawEventId: string,
    isFromBot: boolean = false,
  ): Promise<void> {
    await this.db.prepare(`
      INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id,
        conversation_type, group_id, sender_id, sender_role,
        text, has_media, has_quote, mentions_bot,
        reply_to_message_id, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      rawEventId,
      event.message.messageId,
      event.conversationId,
      event.message.conversationType,
      event.message.groupId || null,
      event.message.senderId,
      event.message.senderRole || null,
      event.message.content.text || '',
      (event.message.content.media?.length ?? 0) > 0 ? 1 : 0,
      event.message.content.quote ? 1 : 0,
      event.message.mentionsBot ? 1 : 0,
      event.message.replyToMessageId || null,
      new Date(event.timestamp).getTime(),
    );

    logger.debug({ messageId: event.id, rawEventId, isFromBot }, 'Chat message stored');
  }

  /**
   * 结构化保存平台提供的昵称/群名片。显示字段是不可信 UI 数据，
   * 不进入普通记忆内容；治理 CLI 可按 display profile/nickname history 删除。
   */
  private async recordDisplayMetadata(
    event: ChatMessageReceived,
    canonicalUserId: string,
  ): Promise<void> {
    const displayName = event.message.senderCard ?? event.message.senderDisplayName;
    if (!displayName) {
      return;
    }

    const sourceGroupId = event.message.conversationType === 'group'
      ? event.message.groupId
      : undefined;
    const existing = await this.identityRepo.getDisplayProfile(canonicalUserId, sourceGroupId);

    await this.identityRepo.upsertDisplayProfile({
      canonicalUserId,
      sourceGroupId,
      currentDisplayName: displayName,
      trust: 'platform_provided',
    });

    if (!existing || existing.currentDisplayName !== displayName) {
      await this.identityRepo.recordNicknameHistory(canonicalUserId, displayName, sourceGroupId);
    }
  }

  /**
   * 存储 Bot 回复到数据库
   */
  private async storeBotResponse(
    conversationId: string,
    conversationType: 'private' | 'group',
    text: string,
    groupId?: string,
  ): Promise<void> {
    const rawEventId = `evt-bot-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const messageId = `msg-bot-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    await this.db.prepare(`
      INSERT INTO raw_events (
        id, type, timestamp, source, platform,
        conversation_id, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rawEventId,
      'bot.response',
      Date.now(),
      'agent',
      'qq',
      conversationId,
      JSON.stringify({ messageId, conversationId, conversationType, groupId, text }),
      Date.now(),
    );

    // 创建一个简化的 Bot 消息记录
    await this.db.prepare(`
      INSERT INTO chat_messages (
        id, raw_event_id, message_id, conversation_id,
        conversation_type, group_id, sender_id, text,
        has_media, has_quote, mentions_bot, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      rawEventId,
      messageId, // Bot 消息使用内部 ID
      conversationId,
      conversationType,
      groupId ?? null,
      'bot-self',
      text,
      0,
      0,
      0,
      Date.now(),
    );

    logger.debug({ messageId, rawEventId }, 'Bot response stored');
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
      const rawEventId = await this.storeRawEvent(event);

      // 0.1 解析用户身份
      const senderId = event.message.senderId.replace('qq-', '');
      const canonicalUserId = await this.resolveIdentity(senderId);

      await this.recordDisplayMetadata(event, canonicalUserId);

      // 0.2 存储聊天消息
      await this.storeChatMessage(event, rawEventId, false);

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
              senderDisplayName: event.message.senderDisplayName ?? event.message.senderId,
              isFromBot: false,
            },
          ],
          targetUserId: canonicalUserId,
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
          canonicalUserId,
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
            canonicalUserId,
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
          canonicalUserId,
          conversationId: event.conversationId,
        }, 'Pi inference failed');
        throw error;
      }

      // 4. 发送响应
      const responseText = piResult.responseText ?? '';
      if (responseText.trim().length > 0) {
        try {
          if (event.message.conversationType === 'private') {
            await this.adapter.sendMessage(
              {
                conversationId: event.message.conversationId,
                conversationType: 'private',
                userId: event.message.senderId,
              },
              { text: responseText },
            );
          } else if (event.message.conversationType === 'group' && event.message.groupId) {
            await this.adapter.sendMessage(
              {
                conversationId: event.message.conversationId,
                conversationType: 'group',
                groupId: event.message.groupId,
              },
              { text: responseText },
            );
          }

          logger.info({
            conversationId: event.conversationId,
            responseLength: responseText.length,
          }, 'Response sent');

          // 4.1 存储 Bot 回复
          await this.storeBotResponse(
            event.conversationId ?? event.message.conversationId,
            event.message.conversationType,
            responseText,
            event.message.groupId,
          );

          // 4.2 提取记忆
          try {
            await this.memoryExtractor.extractFromTurn({
              conversationId: event.conversationId ?? event.message.conversationId,
              userId: canonicalUserId,
              userMessage: event.message.content.text || '',
              botResponse: responseText,
              messageId: event.message.messageId,
              timestamp: event.timestamp.getTime(),
              conversationType: event.message.conversationType,
              groupId: event.message.groupId,
            });
          } catch (error) {
            // 记忆提取失败不应阻塞流程
            logger.warn({ error }, 'Memory extraction failed, continuing');
          }
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.eventProcessingFailures.push({
        eventId: event.id,
        messageId: event.message.messageId,
        conversationId: event.conversationId,
        errorMessage,
      });

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
