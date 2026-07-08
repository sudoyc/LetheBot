/**
 * LetheBot Main Entry
 *
 * 集成所有模块，启动 HTTP 服务器接收 NapCat 事件
 */

import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig, type Config } from './config/index.js';
import { getLogger } from './logger/index.js';
import { closeDatabase, initDatabase, runMigration } from './storage/database.js';
import { MemoryRepository } from './storage/memory-repository.js';
import { IdentityRepository } from './storage/identity-repository.js';
import { AuditRepository } from './storage/audit-repository.js';
import { ContextTraceRepository } from './storage/context-trace-repository.js';
import { TurnRepository } from './storage/turn-repository.js';
import { ToolCallRepository } from './storage/tool-call-repository.js';
import { PrivacyPreferenceRepository } from './storage/privacy-preference-repository.js';
import { JobRepository } from './storage/job-repository.js';
import { ActionRepository } from './actions/action-repository.js';
import { ActionCooldownManager } from './actions/cooldown.js';
import { ActionExecutor, type MessageSender } from './actions/executor.js';
import { SocialDecisionService } from './actions/social-decision-service.js';
import { OneBotAdapter, type OneBotReadiness } from './gateway/onebot-adapter.js';
import { AttentionEngine } from './attention/engine.js';
import { ContextBuilder } from './context/builder.js';
import { PiAdapter, type PiAdapterInput, type PiAdapterOutput } from './pi/pi-adapter.js';
import { ToolRegistry } from './tools/registry.js';
import { PolicyGate } from './policy/gate.js';
import { EvaluatorStub } from './evaluator/evaluator-stub.js';
import { buildSystemPrompt } from './context/persona.js';
import { redactSecretsInText } from './memory/secret-scan.js';
import { MemoryExtractionWorker } from './workers/memory-extraction.js';
import { BackgroundWorker, type BackgroundTask, type EnqueueTaskInput, type TaskResult } from './workers/background.js';
import { WorkerScheduler } from './workers/scheduler.js';
import { SummaryWorker, type ConversationSummaryInput } from './workers/summary-worker.js';
import { AdminDigestWorker } from './workers/admin-digest.js';
import { MemoryConsolidationWorker } from './workers/memory-consolidation.js';
import { MemoryConflictWorker } from './workers/memory-conflict.js';
import { MemoryDecayWorker } from './workers/memory-decay.js';
import {
  applyRetentionPolicy,
  collectOperationsMetrics,
  formatOperationsMetricsPrometheus,
  type RetentionPolicy,
} from './operations/sqlite-maintenance.js';
import type { ChatMessageReceived } from './types/events.js';
import type { ActionExecutionResult } from './types/action.js';
import type { IEvaluator } from './types/evaluator.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = getLogger();

export const VERSION = '0.1.0';

type PublicAdapterStatus = Pick<
  OneBotReadiness,
  'ready' | 'mode' | 'wsConnected' | 'pendingWsRequests' | 'hasToken' | 'botIdConfigured'
>;

/**
 * 测试导出函数
 */
export function hello(): string {
  return `LetheBot v${VERSION}`;
}

export function formatFatalErrorForConsole(error: unknown): string {
  const sanitized = sanitizeFatalDiagnosticValue(error, []);

  if (typeof sanitized === 'string') {
    return sanitized;
  }

  try {
    const serialized = JSON.stringify(sanitized);
    return serialized ?? redactFatalDiagnosticText(String(sanitized));
  } catch {
    return redactFatalDiagnosticText(String(sanitized));
  }
}

function sanitizeFatalDiagnosticValue(value: unknown, path: string[]): unknown {
  if (typeof value === 'string') {
    if (isStackDiagnosticField(path)) {
      return '[REDACTED:stack]';
    }
    return redactFatalDiagnosticText(value);
  }

  if (typeof value === 'number') {
    return shouldRedactFatalNumericPlatformId(path, value) ? '[REDACTED:platform_id]' : value;
  }

  if (typeof value === 'bigint') {
    return shouldRedactFatalNumericPlatformId(path, value) ? '[REDACTED:platform_id]' : value.toString();
  }

  if (value instanceof Error) {
    return {
      name: redactFatalDiagnosticText(value.name || 'Error'),
      message: redactFatalDiagnosticText(value.message || value.name || 'Unknown error'),
      ...(value.stack ? { stack: '[REDACTED:stack]' } : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeFatalDiagnosticValue(item, path));
  }

  if (isPlainFatalDiagnosticRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactFatalDiagnosticText(key),
        sanitizeFatalDiagnosticValue(item, [...path, key]),
      ])
    );
  }

  if (value === undefined) {
    return 'Unknown error';
  }

  return value;
}

function redactFatalDiagnosticText(value: string): string {
  return redactSensitiveTextPreservingMarkers(value);
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function redactSensitiveTextPreservingMarkers(value: string): string {
  const platformRedacted = redactPlatformIdentifiers(value);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function isStackDiagnosticField(path: string[]): boolean {
  const key = path.at(-1);
  return key !== undefined && /^stack$/i.test(key);
}

function shouldRedactFatalNumericPlatformId(path: string[], value: number | bigint): boolean {
  const text = typeof value === 'bigint' ? value.toString() : String(Math.abs(value));
  const key = path.at(-1);
  return key !== undefined
    && /(^|_)(user|sender|group|message|conversation|platform|qq)[_-]?id$/i.test(key)
    && /^\d{8,12}$/.test(text);
}

function isPlainFatalDiagnosticRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  private contextTraceRepo: ContextTraceRepository;
  private turnRepo: TurnRepository;
  private toolCallRepo: ToolCallRepository;
  private privacyPreferenceRepo: PrivacyPreferenceRepository;
  private jobRepo: JobRepository;
  private actionRepo: ActionRepository;
  private adapter: OneBotAdapter;
  private attention: AttentionEngine;
  private contextBuilder: ContextBuilder;
  private toolRegistry: ToolRegistry;
  private policyGate: PolicyGate;
  private pi: { runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> };
  private piProvider: string;
  private piModel: string;
  private actionExecutor: ActionExecutor;
  private socialEvaluator: IEvaluator;
  private cooldowns: ActionCooldownManager;
  private socialDecisionService: SocialDecisionService;
  private memoryExtractor: MemoryExtractionWorker;
  private backgroundWorker: BackgroundWorker;
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
    this.contextTraceRepo = new ContextTraceRepository(this.db);
    this.turnRepo = new TurnRepository(this.db);
    this.toolCallRepo = new ToolCallRepository(this.db);
    this.privacyPreferenceRepo = new PrivacyPreferenceRepository(this.db);
    this.jobRepo = new JobRepository(this.db);
    this.actionRepo = new ActionRepository(this.db);
    this.socialEvaluator = new EvaluatorStub();
    this.cooldowns = new ActionCooldownManager();
    this.socialDecisionService = new SocialDecisionService(
      this.actionRepo,
      this.socialEvaluator,
      this.cooldowns,
    );

    // 初始化工具注册表和策略门
    this.toolRegistry = new ToolRegistry();
    this.policyGate = new PolicyGate(this.toolRegistry);

    // 初始化核心模块
    this.attention = new AttentionEngine();
    this.contextBuilder = new ContextBuilder(this.memoryRepo, this.identityRepo, this.db);
    this.memoryExtractor = new MemoryExtractionWorker(this.db, this.memoryRepo);
    this.backgroundWorker = new BackgroundWorker({
      jobRepository: this.jobRepo,
      workerId: 'lethebot-background-main',
      handlers: {
        summary: (task) => this.handleSummaryBackgroundTask(task),
        extraction: (task) => this.handleExtractionBackgroundTask(task),
        consolidation: (task) => this.handleConsolidationBackgroundTask(task),
        conflict: (task) => this.handleConflictBackgroundTask(task),
        decay: (task) => this.handleDecayBackgroundTask(task),
        admin_digest: (task) => this.handleAdminDigestBackgroundTask(task),
        retention: (task) => this.handleRetentionBackgroundTask(task),
      },
    });
    this.workerScheduler = new WorkerScheduler();

    // 初始化 Pi Agent
    this.piProvider = process.env.PI_PROVIDER || 'openai';
    this.piModel = process.env.PI_MODEL || 'deepseek-v4-flash';
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

    this.pi = this.config.test || this.piProvider === 'mock'
      ? this.createTestPiRuntime()
      : new PiAdapter({
          toolRegistry: this.toolRegistry,
          policyGate: this.policyGate,
          provider: this.piProvider,
          model: this.piModel,
          apiKey,
          baseUrl,
          auditRepository: this.auditRepo,
          toolCallRepository: this.toolCallRepo,
        });

    logger.info({ provider: this.piProvider, model: this.piModel, baseUrl }, 'Pi Agent initialized');

    // 初始化网关适配器
    this.adapter = new OneBotAdapter({
      transport: this.config.onebotTransport,
      httpUrl: this.config.onebotHttpUrl,
      wsUrl: this.config.onebotWsUrl,
      token: this.config.onebotToken,
      botId: this.config.onebotBotQqId,
    });
    this.actionExecutor = new ActionExecutor(this.actionRepo, this.adapter, {
      privacyPreferences: this.privacyPreferenceRepo,
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

    this.registerBackgroundWorkerJobs();
    if (!this.config.test) {
      this.workerScheduler.start();
    }

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

      if (requestPath === this.config.lethebotReadinessPath && req.method === 'GET') {
        const readiness = this.buildReadinessStatus();
        res.writeHead(readiness.status === 'ready' ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readiness));
        return;
      }

      if (requestPath === this.config.lethebotMetricsPath && req.method === 'GET') {
        try {
          const metrics = collectOperationsMetrics(this.db);
          if (this.getRequestFormat(req.url) === 'prometheus') {
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
            res.end(formatOperationsMetricsPrometheus(metrics));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(metrics));
          }
        } catch (error) {
          logger.error({ error }, 'Failed to collect operations metrics');
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'metrics_unavailable' }));
        }
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

            let event: unknown;
            try {
              event = JSON.parse(body);
            } catch (error) {
              logger.warn({ error }, 'Invalid OneBot event JSON');
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
              return;
            }

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
    logger.info(`Readiness check: http://localhost:${port}${this.config.lethebotReadinessPath}`);
    logger.info(`Metrics snapshot: http://localhost:${port}${this.config.lethebotMetricsPath}`);
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
   * Clear accumulated event-processing failures for integration tests that
   * intentionally exercise failure observability.
   */
  clearEventProcessingFailuresForTesting(): void {
    this.eventProcessingFailures = [];
  }

  /**
   * 暴露当前 DB 连接用于 integration tests 验证持久化副作用。
   */
  getDatabase(): Database.Database {
    return this.db;
  }

  /**
   * Replace the Pi runtime for integration tests.
   */
  setPiRuntimeForTesting(runtime: { runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> }): void {
    this.pi = runtime;
  }

  /**
   * Replace the outbound response sender for integration tests.
   */
  setMessageSenderForTesting(sender: MessageSender): void {
    this.actionExecutor = new ActionExecutor(this.actionRepo, sender, {
      privacyPreferences: this.privacyPreferenceRepo,
    });
  }

  /**
   * Stop the gateway adapter without shutting down the HTTP server, so tests can
   * assert degraded readiness behavior.
   */
  async stopAdapterForTesting(): Promise<void> {
    await this.adapter.stop();
  }

  /**
   * Restart the gateway adapter after a degraded-readiness test.
   */
  async startAdapterForTesting(): Promise<void> {
    await this.adapter.start();
  }

  /**
   * Enqueue a durable background task through the same worker used by runtime
   * scheduling. This is intentionally test-only so integration tests can assert
   * job/attempt/heartbeat side effects without waiting for wall-clock timers.
   */
  enqueueBackgroundTaskForTesting(task: EnqueueTaskInput): string {
    return this.backgroundWorker.enqueue(task);
  }

  /**
   * Process one durable background job through the runtime worker.
   */
  async processNextBackgroundJobForTesting(): Promise<TaskResult | null> {
    return this.backgroundWorker.processNext();
  }

  /**
   * Replace the social evaluator for integration tests.
   */
  setSocialEvaluatorForTesting(evaluator: IEvaluator): void {
    this.socialEvaluator = evaluator;
    this.socialDecisionService = new SocialDecisionService(
      this.actionRepo,
      this.socialEvaluator,
      this.cooldowns,
    );
  }

  /**
   * Clear in-memory social cooldown state for integration tests.
   */
  clearCooldownsForTesting(): void {
    this.cooldowns.clear();
  }

  private registerBackgroundWorkerJobs(): void {
    this.workerScheduler.register({
      name: 'durable-background-job-processor',
      intervalMs: 5_000,
      handler: async () => {
        await this.backgroundWorker.processNext();
      },
    });

    this.workerScheduler.register({
      name: 'summary-discovery',
      intervalMs: 5 * 60_000,
      handler: async () => {
        await this.enqueueSummaryJobs();
      },
    });

    this.workerScheduler.register({
      name: 'retention-maintenance',
      intervalMs: 24 * 60 * 60_000,
      handler: async () => {
        this.enqueueRetentionJob();
      },
    });

    this.workerScheduler.register({
      name: 'admin-digest-maintenance',
      intervalMs: 24 * 60 * 60_000,
      handler: async () => {
        this.enqueueAdminDigestJob();
      },
    });

    this.workerScheduler.register({
      name: 'memory-conflict-maintenance',
      intervalMs: 24 * 60 * 60_000,
      handler: async () => {
        this.enqueueConflictJob();
      },
    });

    this.workerScheduler.register({
      name: 'memory-decay-maintenance',
      intervalMs: 24 * 60 * 60_000,
      handler: async () => {
        this.enqueueDecayJob();
      },
    });

    this.workerScheduler.register({
      name: 'memory-consolidation-maintenance',
      intervalMs: 24 * 60 * 60_000,
      handler: async () => {
        this.enqueueConsolidationJob();
      },
    });
  }

  private async enqueueSummaryJobs(): Promise<void> {
    const summaryWorker = this.createSummaryWorker();
    const candidates = await summaryWorker.findConversationsNeedingSummary(60);

    for (const candidate of candidates) {
      this.backgroundWorker.enqueue({
        type: 'summary',
        payload: {
          conversationId: candidate.conversationId,
          conversationType: candidate.conversationType,
          groupId: candidate.groupId,
          timeRange: candidate.timeRange,
          messageRange: candidate.messageRange,
        },
        idempotencyKey: this.buildSummaryJobKey(candidate),
      });
    }
  }

  private buildSummaryJobKey(candidate: ConversationSummaryInput): string {
    const range = candidate.timeRange
      ? `${candidate.timeRange.startTime}-${candidate.timeRange.endTime}`
      : `${candidate.messageRange?.start ?? 'all'}-${candidate.messageRange?.end ?? 'all'}`;
    return `summary:${candidate.conversationType}:${candidate.conversationId}:${range}`;
  }

  private createSummaryWorker(): SummaryWorker {
    return new SummaryWorker(this.db, this.pi, this.memoryRepo);
  }

  private async handleSummaryBackgroundTask(task: BackgroundTask): Promise<unknown> {
    const payload = task.payload;
    const summaryInput: ConversationSummaryInput = {
      conversationId: this.requireString(payload.conversationId, 'conversationId', task.type),
      conversationType: payload.conversationType === 'group' ? 'group' : 'private',
      groupId: this.optionalString(payload.groupId),
      messageRange: this.parseMessageRange(payload.messageRange),
      timeRange: this.parseTimeRange(payload.timeRange),
    };

    return this.createSummaryWorker().generateSummary(summaryInput);
  }

  private async handleExtractionBackgroundTask(task: BackgroundTask): Promise<unknown> {
    const payload = task.payload;

    return this.memoryExtractor.extractFromTurn({
      conversationId: this.requireString(payload.conversationId, 'conversationId', task.type),
      userId: this.requireString(payload.targetUserId, 'targetUserId', task.type),
      userMessage: this.requireString(payload.userMessage, 'userMessage', task.type),
      botResponse: this.optionalString(payload.botResponse) ?? '',
      messageId: this.optionalString(payload.messageId),
      timestamp: this.optionalNumber(payload.timestamp),
      conversationType: payload.conversationType === 'group' ? 'group' : 'private',
      groupId: this.optionalString(payload.groupId),
    });
  }

  private enqueueConsolidationJob(): string {
    const nowMs = Date.now();
    const day = new Date(nowMs).toISOString().slice(0, 10);

    return this.backgroundWorker.enqueue({
      type: 'consolidation',
      payload: {
        nowMs,
        minGroupSize: 2,
      },
      idempotencyKey: `memory_consolidation:${day}`,
      maxAttempts: 2,
    });
  }

  private async handleConsolidationBackgroundTask(task: BackgroundTask): Promise<unknown> {
    const worker = new MemoryConsolidationWorker(this.db, this.auditRepo);

    return worker.scan({
      jobId: task.id,
      nowMs: this.optionalNumber(task.payload.nowMs),
      minGroupSize: this.optionalNumber(task.payload.minGroupSize),
      limit: this.optionalNumber(task.payload.limit),
      scope: this.optionalString(task.payload.scope),
      canonicalUserId: this.optionalString(task.payload.canonicalUserId),
      groupId: this.optionalString(task.payload.groupId),
      conversationId: this.optionalString(task.payload.conversationId),
    });
  }

  private enqueueConflictJob(): string {
    const nowMs = Date.now();
    const day = new Date(nowMs).toISOString().slice(0, 10);

    return this.backgroundWorker.enqueue({
      type: 'conflict',
      payload: {
        sinceMs: nowMs - 24 * 60 * 60 * 1000,
        nowMs,
      },
      idempotencyKey: `memory_conflict:${day}`,
      maxAttempts: 2,
    });
  }

  private async handleConflictBackgroundTask(task: BackgroundTask): Promise<unknown> {
    const worker = new MemoryConflictWorker(this.db, this.auditRepo);

    return worker.detect({
      jobId: task.id,
      sinceMs: this.optionalNumber(task.payload.sinceMs),
      nowMs: this.optionalNumber(task.payload.nowMs),
      limit: this.optionalNumber(task.payload.limit),
    });
  }

  private enqueueDecayJob(): string {
    const nowMs = Date.now();
    const day = new Date(nowMs).toISOString().slice(0, 10);

    return this.backgroundWorker.enqueue({
      type: 'decay',
      payload: {
        nowMs,
        staleBeforeMs: nowMs - 180 * 24 * 60 * 60 * 1000,
        maxConfidence: 0.5,
        maxImportance: 0.3,
      },
      idempotencyKey: `memory_decay:${day}`,
      maxAttempts: 2,
    });
  }

  private async handleDecayBackgroundTask(task: BackgroundTask): Promise<unknown> {
    const worker = new MemoryDecayWorker(this.db, this.auditRepo);

    return worker.scan({
      jobId: task.id,
      nowMs: this.optionalNumber(task.payload.nowMs),
      staleBeforeMs: this.optionalNumber(task.payload.staleBeforeMs),
      maxConfidence: this.optionalNumber(task.payload.maxConfidence),
      maxImportance: this.optionalNumber(task.payload.maxImportance),
      limit: this.optionalNumber(task.payload.limit),
      scope: this.optionalString(task.payload.scope),
      canonicalUserId: this.optionalString(task.payload.canonicalUserId),
      groupId: this.optionalString(task.payload.groupId),
      conversationId: this.optionalString(task.payload.conversationId),
    });
  }

  private enqueueAdminDigestJob(): string {
    const nowMs = Date.now();
    const day = new Date(nowMs).toISOString().slice(0, 10);

    return this.backgroundWorker.enqueue({
      type: 'admin_digest',
      payload: {
        sinceMs: nowMs - 24 * 60 * 60 * 1000,
        nowMs,
      },
      idempotencyKey: `admin_digest:${day}`,
      maxAttempts: 2,
    });
  }

  private async handleAdminDigestBackgroundTask(task: BackgroundTask): Promise<unknown> {
    const worker = new AdminDigestWorker(this.db, this.auditRepo);

    return worker.generate({
      jobId: task.id,
      sinceMs: this.optionalNumber(task.payload.sinceMs),
      nowMs: this.optionalNumber(task.payload.nowMs),
      limit: this.optionalNumber(task.payload.limit),
    });
  }

  private enqueueRetentionJob(): string | undefined {
    const policy = this.currentRetentionPolicy();
    if (!this.hasRetentionPolicy(policy)) {
      return undefined;
    }

    const day = new Date().toISOString().slice(0, 10);
    return this.backgroundWorker.enqueue({
      type: 'retention',
      payload: {
        rawEventsDays: policy.rawEventsDays,
        chatMessagesDays: policy.chatMessagesDays,
        auditLogDays: policy.auditLogDays,
        disabledDeletedMemoryDays: policy.disabledDeletedMemoryDays,
        eventProcessingFailuresDays: policy.eventProcessingFailuresDays,
      },
      idempotencyKey: `retention:${day}`,
      maxAttempts: 2,
    });
  }

  private async handleRetentionBackgroundTask(task: BackgroundTask): Promise<unknown> {
    const policy = this.retentionPolicyFromPayload(task.payload);
    const nowMs = this.optionalNumber(task.payload.nowMs) ?? Date.now();
    return applyRetentionPolicy(this.db, policy, nowMs);
  }

  private currentRetentionPolicy(): RetentionPolicy {
    return {
      rawEventsDays: this.config.rawEventRetentionDays,
      chatMessagesDays: this.config.chatMessageRetentionDays,
      auditLogDays: this.config.auditLogRetentionDays,
      disabledDeletedMemoryDays: this.config.disabledDeletedMemoryRetentionDays,
      eventProcessingFailuresDays: this.config.eventProcessingFailureRetentionDays,
    };
  }

  private hasRetentionPolicy(policy: RetentionPolicy): boolean {
    return [
      policy.rawEventsDays,
      policy.chatMessagesDays,
      policy.auditLogDays,
      policy.disabledDeletedMemoryDays,
      policy.eventProcessingFailuresDays,
    ].some((days) => typeof days === 'number' && days > 0);
  }

  private retentionPolicyFromPayload(payload: BackgroundTask['payload']): RetentionPolicy {
    return {
      rawEventsDays: this.optionalNumber(payload.rawEventsDays),
      chatMessagesDays: this.optionalNumber(payload.chatMessagesDays),
      auditLogDays: this.optionalNumber(payload.auditLogDays),
      disabledDeletedMemoryDays: this.optionalNumber(payload.disabledDeletedMemoryDays),
      eventProcessingFailuresDays: this.optionalNumber(payload.eventProcessingFailuresDays),
    };
  }

  private requireString(value: unknown, field: string, taskType: string): string {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }

    throw new Error(`Background task ${taskType} requires string payload.${field}`);
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private parseMessageRange(value: unknown): { start: string; end: string } | undefined {
    if (
      typeof value === 'object' &&
      value !== null &&
      'start' in value &&
      'end' in value &&
      typeof value.start === 'string' &&
      typeof value.end === 'string'
    ) {
      return { start: value.start, end: value.end };
    }

    return undefined;
  }

  private parseTimeRange(value: unknown): { startTime: number; endTime: number } | undefined {
    if (
      typeof value === 'object' &&
      value !== null &&
      'startTime' in value &&
      'endTime' in value &&
      typeof value.startTime === 'number' &&
      typeof value.endTime === 'number'
    ) {
      return { startTime: value.startTime, endTime: value.endTime };
    }

    return undefined;
  }

  private getRequestPath(url: string | undefined): string {
    return new URL(url ?? '/', 'http://localhost').pathname;
  }

  private getRequestFormat(url: string | undefined): 'json' | 'prometheus' {
    return new URL(url ?? '/', 'http://localhost').searchParams.get('format') === 'prometheus'
      ? 'prometheus'
      : 'json';
  }

  private buildHealthStatus(): {
    status: 'ok' | 'degraded';
    version: string;
    checks: {
      database: { ok: boolean; open: boolean; error?: string };
      adapter: PublicAdapterStatus;
      eventProcessing: { pending: number; failures: number };
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

    const adapter = this.buildPublicAdapterStatus(this.adapter.getReadiness());
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
        eventProcessing: {
          pending: this.pendingEventTasks.size,
          failures: this.eventProcessingFailures.length,
        },
      },
    };
  }

  private buildReadinessStatus(): {
    status: 'ready' | 'not_ready';
    version: string;
    checks: {
      database: { ready: boolean; open: boolean };
      adapter: PublicAdapterStatus;
      eventProcessing: { pending: number };
    };
  } {
    let databaseReady = false;

    try {
      if (this.db.open) {
        this.db.prepare('SELECT 1').get();
        databaseReady = true;
      }
    } catch {
      databaseReady = false;
    }

    const adapter = this.buildPublicAdapterStatus(this.adapter.getReadiness());
    const status = databaseReady && adapter.ready ? 'ready' : 'not_ready';

    return {
      status,
      version: VERSION,
      checks: {
        database: {
          ready: databaseReady,
          open: this.db.open,
        },
        adapter,
        eventProcessing: {
          pending: this.pendingEventTasks.size,
        },
      },
    };
  }

  private buildPublicAdapterStatus(adapter: OneBotReadiness): PublicAdapterStatus {
    return {
      ready: adapter.ready,
      mode: adapter.mode,
      wsConnected: adapter.wsConnected,
      pendingWsRequests: adapter.pendingWsRequests,
      hasToken: adapter.hasToken,
      botIdConfigured: adapter.botIdConfigured,
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
    const safeDisplayName = this.redactSensitiveText(displayName);

    const sourceGroupId = event.message.conversationType === 'group'
      ? event.message.groupId
      : undefined;
    const existing = await this.identityRepo.getDisplayProfile(canonicalUserId, sourceGroupId);

    await this.identityRepo.upsertDisplayProfile({
      canonicalUserId,
      sourceGroupId,
      currentDisplayName: safeDisplayName,
      trust: 'platform_provided',
    });

    if (!existing || existing.currentDisplayName !== safeDisplayName) {
      await this.identityRepo.recordNicknameHistory(canonicalUserId, safeDisplayName, sourceGroupId);
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
    sentMessageId?: string,
  ): Promise<void> {
    const rawEventId = `evt-bot-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const messageId = sentMessageId ?? `msg-bot-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

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

  private findSuccessfulReplyExecution(results: ActionExecutionResult[]): ActionExecutionResult | undefined {
    return results.find((result) => {
      return (
        result.status === 'success' &&
        (result.actionType === 'reply_short' ||
          result.actionType === 'reply_full' ||
          result.actionType === 'ask_clarification') &&
        Boolean(result.executed?.messageId)
      );
    });
  }

  private isReplyToStoredBotMessage(event: ChatMessageReceived): boolean {
    const replyToMessageId = event.message.replyToMessageId;
    if (!replyToMessageId) {
      return false;
    }

    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM chat_messages
         WHERE message_id = ?
           AND conversation_id = ?
           AND conversation_type = ?
           AND sender_id = 'bot-self'`
      )
      .get(
        replyToMessageId,
        event.conversationId ?? event.message.conversationId,
        event.message.conversationType,
      ) as { count: number } | undefined;

    return (row?.count ?? 0) > 0;
  }

  /**
   * 处理内部事件
   */
  private async handleEvent(event: ChatMessageReceived): Promise<void> {
    let turnId: string | undefined;
    let turnFinalized = false;
    let rawEventId: string | undefined;
    let currentStage = 'raw_event_store';

    try {
      logger.info({
        type: event.type,
        conversationId: event.conversationId,
        senderId: event.message.senderId,
      }, 'Processing event');

      // 0. 存储原始事件（最优先）
      currentStage = 'raw_event_store';
      rawEventId = await this.storeRawEvent(event);

      // 0.1 解析用户身份
      currentStage = 'identity_resolution';
      const senderId = event.message.senderId.replace('qq-', '');
      const canonicalUserId = await this.resolveIdentity(senderId);

      currentStage = 'display_metadata';
      await this.recordDisplayMetadata(event, canonicalUserId);

      // 0.2 存储聊天消息
      currentStage = 'chat_message_store';
      await this.storeChatMessage(event, rawEventId, false);

      // 1. 注意力分析
      let signals;
      try {
        currentStage = 'attention_analysis';
        signals = this.attention.analyze({
          conversationType: event.message.conversationType,
          mentionsBot: event.message.mentionsBot,
          text: event.message.content.text ?? '',
          senderId: event.message.senderId,
          replyToBot: this.isReplyToStoredBotMessage(event),
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

      currentStage = 'turn_create';
      turnId = await this.turnRepo.createPending({
        conversationId: event.conversationId ?? event.message.conversationId,
        triggerEventId: rawEventId,
        piModel: this.piModel,
        piProvider: this.piProvider,
      });

      // 2. 构建上下文
      const groupId = event.message.groupId?.replace('qq-group-', '');

      let context;
      try {
        currentStage = 'context_building';
        context = await this.contextBuilder.buildContext({
          turnId,
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

        await this.contextTraceRepo.createFromContext(context);
        await this.turnRepo.markRunning(turnId, context.id);

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
        currentStage = 'pi_inference';
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
          turnId,
        });

        logger.debug({
          responseLength: piResult.responseText?.length ?? 0,
          toolCallCount: piResult.toolCallIds.length,
          status: piResult.status,
        }, 'Pi response');
      } catch (error) {
        logger.error({
          error: this.redactErrorForLog(error),
          step: 'pi_inference',
          canonicalUserId,
          conversationId: event.conversationId,
        }, 'Pi inference failed');
        throw error;
      }

      if (piResult.status !== 'completed') {
        await this.turnRepo.markFailed(
          turnId,
          piResult.errorMessage ?? `Pi turn ended with status: ${piResult.status}`
        );
        turnFinalized = true;
        return;
      }

      // 4. 将 Pi 输出转换为结构化行动并通过执行器处理
      currentStage = 'social_decision';
      const responseText = piResult.responseText ?? '';
      const actionDecision = await this.socialDecisionService.createDecision({
        turnId,
        rawEventId,
        event,
        responseText,
        signals,
        actor: {
          canonicalUserId,
          actorClass: 'user',
        },
      });
      currentStage = 'action_execution';
      const actionResults = await this.actionExecutor.execute(actionDecision);
      const successfulReply = this.findSuccessfulReplyExecution(actionResults);

      if (successfulReply && responseText.trim().length > 0) {
        try {
          currentStage = 'bot_response_persist';
          logger.info({
            conversationId: event.conversationId,
            responseLength: responseText.length,
            actionDecisionId: actionDecision.id,
            actionExecutionId: successfulReply.id,
          }, 'Response action executed');

          await this.storeBotResponse(
            event.conversationId ?? event.message.conversationId,
            event.message.conversationType,
            responseText,
            event.message.groupId,
            successfulReply.executed?.messageId,
          );

          try {
            currentStage = 'memory_extraction';
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
          }, 'Failed to persist post-action side effects');
          throw error;
        }
      }

      currentStage = 'turn_complete';
      await this.turnRepo.markCompleted(turnId, {
        responseText,
        tokensUsed: piResult.tokensUsed,
      });
      turnFinalized = true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const redactedErrorMessage = this.redactSensitiveText(errorMessage);

      if (turnId && !turnFinalized) {
        try {
          await this.turnRepo.markFailed(turnId, redactedErrorMessage);
          turnFinalized = true;
        } catch (markFailedError) {
          logger.error({
            error: this.redactErrorForLog(markFailedError),
            turnId,
          }, 'Failed to mark agent turn as failed');
        }
      }

      this.eventProcessingFailures.push({
        eventId: event.id,
        messageId: event.message.messageId,
        conversationId: event.conversationId,
        errorMessage: redactedErrorMessage,
      });

      this.recordEventProcessingFailure({
        event,
        rawEventId,
        turnId,
        stage: currentStage,
        error,
      });

      logger.error({
        error: this.redactErrorForLog(error),
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

  private recordEventProcessingFailure(input: {
    event: ChatMessageReceived;
    rawEventId?: string;
    turnId?: string;
    stage: string;
    error: unknown;
  }): void {
    const errorName = input.error instanceof Error ? input.error.name : typeof input.error;
    const errorMessage = input.error instanceof Error ? input.error.message : String(input.error);
    const errorMessageHash = this.hashForDiagnostics(errorMessage);
    const messageIdHash = this.hashForDiagnostics(input.event.message.messageId);
    const senderIdHash = this.hashForDiagnostics(input.event.message.senderId);
    const conversationId = input.event.conversationId ?? input.event.message.conversationId;
    const conversationIdHash = this.hashForDiagnostics(conversationId);
    const now = Date.now();

    try {
      this.db.prepare(
        `INSERT INTO event_processing_failures (
          id, raw_event_id, turn_id, occurred_at, stage, conversation_type,
          error_name, error_message_hash, message_id_hash, sender_id_hash,
          conversation_id_hash, details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `event-failure-${randomUUID()}`,
        input.rawEventId ?? null,
        input.turnId ?? null,
        now,
        input.stage,
        input.event.message.conversationType,
        errorName,
        errorMessageHash,
        messageIdHash ?? null,
        senderIdHash ?? null,
        conversationIdHash ?? null,
        JSON.stringify({
          redaction: 'hashes_only_no_message_text_no_platform_ids_no_raw_error',
          rawEventStored: Boolean(input.rawEventId),
          turnStarted: Boolean(input.turnId),
          stage: input.stage,
          conversationType: input.event.message.conversationType,
          error: {
            name: errorName,
            messageHash: errorMessageHash,
          },
          hashes: {
            messageId: messageIdHash,
            senderId: senderIdHash,
            conversationId: conversationIdHash,
          },
        }),
      );
    } catch (recordError) {
      logger.error({ error: recordError }, 'Failed to persist event processing failure record');
    }
  }

  private hashForDiagnostics(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    return createHash('sha256').update(value).digest('hex');
  }

  private redactErrorForLog(error: unknown): unknown {
    if (error instanceof Error) {
      return {
        message: this.redactSensitiveText(error.message),
        stack: error.stack ? this.redactSensitiveText(error.stack) : undefined,
        name: error.name,
      };
    }

    if (typeof error === 'string') {
      return this.redactSensitiveText(error);
    }

    return error;
  }

  private redactSensitiveText(text: string): string {
    return redactSensitiveTextPreservingMarkers(text);
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
    console.error('Fatal error:', formatFatalErrorForConsole(error));
    process.exit(1);
  });
}

export { LetheBotApp };
