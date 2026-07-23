/**
 * LetheBot Main Entry
 *
 * 集成所有模块，启动 HTTP 服务器接收 NapCat 事件
 */

import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { loadConfig, type Config } from './config/index.js';
import { getLogger } from './logger/index.js';
import { closeDatabase, initDatabase, runMigrations } from './storage/database.js';
import { MemoryRepository } from './storage/memory-repository.js';
import {
  IdentityRepository,
  InactivePlatformAccountError,
} from './storage/identity-repository.js';
import { AuditRepository } from './storage/audit-repository.js';
import { ContextTraceRepository } from './storage/context-trace-repository.js';
import { TurnRepository } from './storage/turn-repository.js';
import { ToolCallRepository } from './storage/tool-call-repository.js';
import { LocalToolEffectCoordinator } from './storage/local-tool-effect-coordinator.js';
import { EvaluatorDecisionRepository } from './storage/evaluator-decision-repository.js';
import { ModelInvocationRepository } from './storage/model-invocation-repository.js';
import { PrivacyPreferenceRepository } from './storage/privacy-preference-repository.js';
import { JobRepository } from './storage/job-repository.js';
import {
  GroupSummaryPolicyError,
  GroupSummaryPolicyRepository,
} from './storage/group-summary-policy-repository.js';
import { ActionRepository } from './actions/action-repository.js';
import { ActionCooldownManager } from './actions/cooldown.js';
import { ActionExecutor, type MessageSender } from './actions/executor.js';
import { SocialDecisionService } from './actions/social-decision-service.js';
import {
  OneBotAdapter,
  type OneBotIngressDisposition,
  type OneBotReadiness,
  type OneBotTransport,
} from './gateway/onebot-adapter.js';
import { AttentionEngine } from './attention/engine.js';
import {
  DelayedAttentionService,
  parseDelayedAttentionTaskPayload,
  type DelayedAttentionCandidate,
  type DelayedAttentionDecision,
} from './attention/delayed-attention-service.js';
import { ContextBuilder } from './context/builder.js';
import { PiAdapter, type PiAdapterInput, type PiAdapterOutput } from './pi/pi-adapter.js';
import { ToolRegistry } from './tools/registry.js';
import { registerBuiltInTools } from './tools/builtins/memory-search.js';
import { PolicyGate } from './policy/gate.js';
import {
  createRuntimeEvaluator,
  resolveEvaluatorConfig,
} from './evaluator/runtime.js';
import { buildSystemPrompt } from './context/persona.js';
import { redactSecretsInText } from './memory/secret-scan.js';
import { MemoryProposalService } from './memory/proposal-service.js';
import {
  isAutomaticExtractionCandidate,
  MemoryExtractionWorker,
} from './workers/memory-extraction.js';
import {
  BackgroundWorker,
  NonRetryableBackgroundTaskError,
  type BackgroundTask,
  type BackgroundTaskExecutionContext,
  type EnqueueTaskInput,
  type TaskType,
  type TaskResult,
} from './workers/background.js';
import { WorkerScheduler } from './workers/scheduler.js';
import { SummaryWorker, type ConversationSummaryInput } from './workers/summary-worker.js';
import {
  GroupSummaryJobService,
  GroupSummaryWindowError,
} from './workers/group-summary-job-service.js';
import { AdminDigestWorker } from './workers/admin-digest.js';
import { MemoryConsolidationWorker } from './workers/memory-consolidation.js';
import { MemoryConflictWorker } from './workers/memory-conflict.js';
import { MemoryDecayWorker } from './workers/memory-decay.js';
import {
  parseStoredChatMessageReceived,
  type StoredChatEventRow,
} from './ingestion/stored-chat-event.js';
import { parseQqGovernanceCommand } from './governance/qq-command.js';
import { GovernanceService } from './governance/service.js';
import {
  applyRetentionPolicy,
  collectOperationsMetrics,
  formatOperationsMetricsPrometheus,
  type RetentionPolicy,
} from './operations/sqlite-maintenance.js';
import type { ChatMessageReceived } from './types/events.js';
import type { ActionDecision, ActionExecutionResult } from './types/action.js';
import type { AttentionSignals } from './types/attention.js';
import type { IEvaluator } from './types/evaluator.js';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = getLogger();

export const VERSION = '0.1.0';

export function resolvePiApiKey(
  env: NodeJS.ProcessEnv = process.env,
  required = false,
): string {
  const apiKey = env.PI_API_KEY?.trim() ?? '';
  if (required && !apiKey) {
    throw new Error('PI_API_KEY is required for a non-mock Pi provider');
  }
  return apiKey;
}

type PublicAdapterStatus = Pick<
  OneBotReadiness,
  'ready' | 'mode' | 'wsConnected' | 'pendingWsRequests' | 'hasToken' | 'botIdConfigured'
>;

type EventHandlingOutcome = 'completed' | 'failed';

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
  private groupSummaryPolicyRepo: GroupSummaryPolicyRepository;
  private governance: GovernanceService;
  private groupSummaryJobService: GroupSummaryJobService;
  private actionRepo: ActionRepository;
  private adapter: OneBotAdapter;
  private attention: AttentionEngine;
  private delayedAttention: DelayedAttentionService;
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
  private acceptingIngress = false;
  private stopPromise: Promise<void> | null = null;
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
    runMigrations(this.db, join(__dirname, '../migrations'));

    // 初始化存储层
    this.memoryRepo = new MemoryRepository(this.db);
    this.identityRepo = new IdentityRepository(this.db);
    this.auditRepo = new AuditRepository(this.db);
    this.contextTraceRepo = new ContextTraceRepository(this.db);
    this.turnRepo = new TurnRepository(this.db);
    this.toolCallRepo = new ToolCallRepository(this.db);
    this.privacyPreferenceRepo = new PrivacyPreferenceRepository(this.db);
    this.jobRepo = new JobRepository(this.db);
    this.groupSummaryPolicyRepo = new GroupSummaryPolicyRepository(this.db);
    this.governance = new GovernanceService(
      this.db,
      this.memoryRepo,
      this.groupSummaryPolicyRepo,
    );
    this.actionRepo = new ActionRepository(this.db);
    this.cooldowns = new ActionCooldownManager();

    // 初始化工具注册表和策略门
    this.toolRegistry = new ToolRegistry();
    registerBuiltInTools(this.toolRegistry, { memoryRepository: this.memoryRepo, database: this.db });
    this.policyGate = new PolicyGate(this.toolRegistry);

    // 初始化核心模块
    this.attention = new AttentionEngine();
    this.delayedAttention = new DelayedAttentionService(this.db, this.jobRepo);
    this.contextBuilder = new ContextBuilder(this.memoryRepo, this.identityRepo, this.db);
    this.backgroundWorker = new BackgroundWorker({
      jobRepository: this.jobRepo,
      workerId: 'lethebot-background-main',
      handlers: {
        summary: (task, execution) => this.handleSummaryBackgroundTask(task, execution),
        extraction: (task, execution) => this.handleExtractionBackgroundTask(task, execution),
        attention_recheck: (task, execution) => this.handleAttentionRecheckBackgroundTask(task, execution),
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

    const apiKey = resolvePiApiKey(
      process.env,
      !this.config.test && this.piProvider !== 'mock',
    );
    const evaluatorConfig = resolveEvaluatorConfig({
      provider: this.piProvider,
      model: this.piModel,
      baseUrl,
      apiKey,
    }, {
      provider: this.config.evaluatorProvider,
      model: this.config.evaluatorModel,
      baseUrl: this.config.evaluatorBaseUrl,
      apiKey: this.config.evaluatorApiKey,
      timeoutMs: this.config.evaluatorTimeoutMs,
      maxRetries: this.config.evaluatorMaxRetries,
      temperature: this.config.evaluatorTemperature,
      promptVersion: this.config.evaluatorPromptVersion,
    });
    this.socialEvaluator = createRuntimeEvaluator(evaluatorConfig, {
      test: this.config.test,
      invocationLedger: new ModelInvocationRepository(this.db),
    });
    this.socialDecisionService = new SocialDecisionService(
      this.actionRepo,
      this.socialEvaluator,
      this.cooldowns,
    );
    this.memoryExtractor = this.createMemoryExtractionWorker(this.socialEvaluator);

    this.pi = this.config.test || this.piProvider === 'mock'
      ? this.createTestPiRuntime()
      : new PiAdapter({
          toolRegistry: this.toolRegistry,
          policyGate: this.policyGate,
          provider: this.piProvider,
          model: this.piModel,
          apiKey,
          baseUrl,
          turnTimeoutMs: this.config.piTurnTimeoutMs,
          auditRepository: this.auditRepo,
          toolCallRepository: this.toolCallRepo,
          evaluator: this.socialEvaluator,
          evaluatorDecisionWriter: new EvaluatorDecisionRepository(this.db),
          localToolEffectCoordinator: new LocalToolEffectCoordinator(
            this.db,
            this.toolCallRepo,
            this.auditRepo,
          ),
        });

    this.groupSummaryJobService = new GroupSummaryJobService(this.db, {
      jobRepository: this.jobRepo,
      policyRepository: this.groupSummaryPolicyRepo,
      planGroupSummaryWindow: (input) => (
        this.createSummaryWorker().planGroupSummaryWindow(input)
      ),
    });

    logger.info({ provider: this.piProvider, model: this.piModel, baseUrl }, 'Pi Agent initialized');
    logger.info({
      provider: evaluatorConfig.provider,
      model: evaluatorConfig.model,
    }, 'Evaluator initialized');

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
      jobRepository: this.jobRepo,
      summaryJobService: this.groupSummaryJobService,
      memoryRepository: this.memoryRepo,
    });

    // Register the durable ingress claim before any downstream event work.
    this.adapter.onIngress((event) => this.claimAndEnqueueEvent(event));

    logger.info({ version: VERSION }, 'LetheBot initialized');
  }

  /**
   * 启动应用
   */
  async start(): Promise<void> {
    const acceptedEvents = this.prepareAdmissionRecovery();
    await this.adapter.start();

    this.adapter.whenReady(() => {
      for (const acceptedEvent of acceptedEvents) {
        this.enqueueEvent(acceptedEvent.event, acceptedEvent.rawEventId);
      }
      this.acceptingIngress = true;
    });

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
        if (!this.acceptingIngress) {
          this.respondIngressUnavailable(res);
          return;
        }

        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });

        req.on('end', () => {
          try {
            if (!this.acceptingIngress) {
              this.respondIngressUnavailable(res);
              return;
            }

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
            const disposition = this.adapter.dispatchInboundEvent(event, 'http');
            if (disposition === 'failed') {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'event_unavailable' }));
              return;
            }

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

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error('HTTP server was not initialized'));
        return;
      }

      const handleListenError = (error: Error) => reject(error);
      server.once('error', handleListenError);
      server.listen(port, this.config.lethebotHost, () => {
        server.off('error', handleListenError);
        logger.info(`LetheBot listening on ${this.config.lethebotHost}:${port}`);
        logger.info(`Health check: http://localhost:${port}${this.config.lethebotHealthPath}`);
        logger.info(`Readiness check: http://localhost:${port}${this.config.lethebotReadinessPath}`);
        logger.info(`Metrics snapshot: http://localhost:${port}${this.config.lethebotMetricsPath}`);
        logger.info(`OneBot endpoint: http://localhost:${port}${this.config.lethebotEventPath}`);
        resolve();
      });
    });
  }

  /**
   * 停止应用
   */
  stop(): Promise<void> {
    this.stopPromise ??= this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    logger.info('Stopping LetheBot...');
    this.acceptingIngress = false;

    const schedulerDrain = this.workerScheduler.stopAndDrain();
    const serverClose = this.closeHttpServer();

    await Promise.all([
      schedulerDrain,
      serverClose,
      this.waitForIdle(),
    ]);

    await this.adapter.stop();
    if (this.db.open) {
      closeDatabase(this.db);
    }
    logger.info('LetheBot stopped');
  }

  private closeHttpServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private respondIngressUnavailable(res: ServerResponse): void {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'event_unavailable' }));
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
      jobRepository: this.jobRepo,
      summaryJobService: this.groupSummaryJobService,
      memoryRepository: this.memoryRepo,
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

  dispatchOneBotEventForTesting(
    event: unknown,
    transport: OneBotTransport,
  ): OneBotIngressDisposition {
    return this.adapter.dispatchInboundEvent(event, transport);
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
  async processNextBackgroundJobForTesting(
    now?: number,
    types?: TaskType[],
  ): Promise<TaskResult | null> {
    return this.backgroundWorker.processNext(now, types);
  }

  /**
   * Replace the configured evaluator for integration tests.
   */
  setSocialEvaluatorForTesting(evaluator: IEvaluator): void {
    this.socialEvaluator = evaluator;
    this.socialDecisionService = new SocialDecisionService(
      this.actionRepo,
      this.socialEvaluator,
      this.cooldowns,
    );
    this.memoryExtractor = this.createMemoryExtractionWorker(this.socialEvaluator);
  }

  private createMemoryExtractionWorker(evaluator: IEvaluator): MemoryExtractionWorker {
    return new MemoryExtractionWorker(
      this.db,
      this.memoryRepo,
      undefined,
      new MemoryProposalService(this.memoryRepo, {
        evaluator,
        evaluatorDecisionWriter: new EvaluatorDecisionRepository(this.db),
        auditRepository: this.auditRepo,
        privacyPreferences: this.privacyPreferenceRepo,
      }),
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

    if (this.config.backgroundSummaryEnabled) {
      this.workerScheduler.register({
        name: 'summary-discovery',
        intervalMs: 5 * 60_000,
        handler: async () => {
          await this.enqueueSummaryJobs();
        },
      });
    }

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
      try {
        await this.groupSummaryJobService.enqueueSummary({
          conversationId: candidate.conversationId,
          conversationType: candidate.conversationType,
          groupId: candidate.groupId,
          payload: candidate.conversationType === 'group'
            ? { source: 'summary_discovery' }
            : {
                timeRange: candidate.timeRange,
                messageRange: candidate.messageRange,
              },
          baseIdempotencyKey: this.buildSummaryJobKey(candidate),
        });
      } catch (error) {
        if (error instanceof GroupSummaryPolicyError && error.code === 'policy_disabled') {
          continue;
        }
        if (error instanceof GroupSummaryWindowError && error.code === 'window_unavailable') {
          continue;
        }
        throw error;
      }
    }
  }

  private buildSummaryJobKey(candidate: ConversationSummaryInput): string {
    const digest = createHash('sha256')
      .update(JSON.stringify({
        version: 1,
        conversationId: candidate.conversationId,
        conversationType: candidate.conversationType,
        groupId: candidate.groupId ?? null,
        messageRange: candidate.messageRange ?? null,
        timeRange: candidate.timeRange ?? null,
      }))
      .digest('hex')
      .slice(0, 32);
    return `summary:v1:${digest}`;
  }

  private createSummaryWorker(): SummaryWorker {
    if (!this.config.test && !this.config.backgroundSummaryEnabled) {
      throw new Error(
        'Background summary Provider processing is disabled; set LETHEBOT_BACKGROUND_SUMMARY_ENABLED=true to opt in',
      );
    }

    return new SummaryWorker(
      this.db,
      this.pi,
      this.memoryRepo,
      new ContextBuilder(this.memoryRepo, this.identityRepo),
      {
        piProvider: this.piProvider,
        piModel: this.piModel,
        requireDurableExecution: true,
      },
    );
  }

  private async handleSummaryBackgroundTask(
    task: BackgroundTask,
    execution?: BackgroundTaskExecutionContext,
  ): Promise<unknown> {
    if (!execution) {
      throw new Error('Summary background task requires durable execution context');
    }
    try {
      const payload = task.payload;
      const conversationType = this.requireConversationType(
        payload.conversationType,
        task.type,
      );
      const summaryInput: ConversationSummaryInput = {
        conversationId: this.requireString(payload.conversationId, 'conversationId', task.type),
        conversationType,
        groupId: this.optionalString(payload.groupId),
        ...(conversationType === 'group'
          ? { sourceChatMessageIds: this.requireSummarySourceIds(payload.sourceChatMessageIds) }
          : {
              messageRange: this.parseMessageRange(payload.messageRange),
              timeRange: this.parseTimeRange(payload.timeRange),
            }),
      };
      const binding = this.groupSummaryPolicyRepo.getBinding(task.id);
      if (
        binding
        && (
          summaryInput.conversationType !== 'group'
          || summaryInput.groupId !== binding.groupId
          || summaryInput.conversationId !== binding.conversationId
        )
      ) {
        throw new GroupSummaryPolicyError(
          'job_binding_mismatch',
          'Group summary job binding does not match the task payload.',
        );
      }

      const result = await this.createSummaryWorker().generateSummary(summaryInput, execution);
      if (!result) {
        return null;
      }

      return {
        summaryId: result.summaryId,
        messageCount: result.messageCount,
        timeRange: result.timeRange,
        confidence: result.confidence,
      };
    } catch (error) {
      if (error instanceof GroupSummaryPolicyError) {
        throw new NonRetryableBackgroundTaskError(error.message);
      }
      throw error;
    }
  }

  private async handleExtractionBackgroundTask(
    task: BackgroundTask,
    execution?: BackgroundTaskExecutionContext,
  ): Promise<unknown> {
    if (!execution) {
      throw new Error('Extraction background task requires durable execution context');
    }
    const payload = task.payload;

    return this.memoryExtractor.extractFromChatMessage({
      sourceChatMessageId: this.requireString(payload.sourceChatMessageId, 'sourceChatMessageId', task.type),
      targetUserId: this.requireString(payload.targetUserId, 'targetUserId', task.type),
      jobAttemptId: execution.jobAttemptId,
    });
  }

  private async handleAttentionRecheckBackgroundTask(
    task: BackgroundTask,
    execution?: BackgroundTaskExecutionContext,
  ): Promise<unknown> {
    if (!execution) {
      throw new Error('Delayed Attention background task requires durable execution context');
    }

    const { candidateId } = parseDelayedAttentionTaskPayload(task.payload);
    const candidate = this.delayedAttention.findCandidate(candidateId);
    if (
      !candidate
      || candidate.jobId !== task.id
      || candidate.jobId !== execution.jobId
    ) {
      throw new Error('Delayed Attention candidate/job binding is invalid');
    }

    const event = this.readDelayedAttentionSourceEvent(candidate);
    const signals = this.buildDelayedAttentionSignals(event);
    const decision = this.delayedAttention.decide({
      candidateId,
      jobId: execution.jobId,
      jobAttemptId: execution.jobAttemptId,
      now: execution.now,
    });

    if (decision.outcome === 'suppress') {
      return {
        candidateId,
        decisionId: decision.id,
        outcome: decision.outcome,
        suppressors: decision.suppressors.map((suppressor) => ({
          id: suppressor.id,
          code: suppressor.code,
        })),
      };
    }

    const existing = this.findDelayedAttentionTerminalTurn(candidate.sourceRawEventId);
    if (existing) {
      return this.buildDelayedAttentionRespondResult(candidateId, decision, existing);
    }

    const outcome = await this.handleEvent(event, candidate.sourceRawEventId, {
      sourceAlreadyPersisted: true,
      signals,
    });
    if (outcome !== 'completed') {
      throw new Error('Delayed Attention response processing failed');
    }

    const completed = this.findDelayedAttentionTerminalTurn(candidate.sourceRawEventId);
    if (!completed) {
      throw new Error('Delayed Attention response completed without terminal turn evidence');
    }
    return this.buildDelayedAttentionRespondResult(candidateId, decision, completed);
  }

  private readDelayedAttentionSourceEvent(
    candidate: DelayedAttentionCandidate,
  ): ChatMessageReceived {
    const row = this.db.prepare(
      `SELECT raw.id,
              raw.type,
              raw.timestamp,
              raw.source,
              raw.platform,
              raw.conversation_id,
              raw.correlation_id,
              raw.platform_event_id,
              raw.payload,
              raw.created_at AS raw_created_at,
              message.id AS chat_message_id,
              message.raw_event_id AS chat_raw_event_id,
              message.message_id AS chat_platform_message_id,
              message.conversation_id AS chat_conversation_id,
              message.conversation_type AS chat_conversation_type,
              message.group_id AS chat_group_id,
              message.sender_id AS chat_sender_id,
              message.sender_role AS chat_sender_role,
              message.text AS chat_text,
              message.mentions_bot AS chat_mentions_bot,
              message.reply_to_message_id AS chat_reply_to_message_id
         FROM raw_events AS raw
         JOIN chat_messages AS message ON message.id = ?
        WHERE raw.id = ?
          AND message.raw_event_id = raw.id`,
    ).get(candidate.sourceChatMessageId, candidate.sourceRawEventId) as (StoredChatEventRow & {
      raw_created_at: number;
      chat_message_id: string;
      chat_raw_event_id: string;
      chat_platform_message_id: string;
      chat_conversation_id: string;
      chat_conversation_type: string;
      chat_group_id: string | null;
      chat_sender_id: string;
      chat_sender_role: string | null;
      chat_text: string | null;
      chat_mentions_bot: number;
      chat_reply_to_message_id: string | null;
    }) | undefined;
    if (!row) {
      throw new Error('Delayed Attention source event is unavailable');
    }

    const parsed = parseStoredChatMessageReceived(row);
    if (!parsed.ok) {
      throw new Error('Delayed Attention source event is invalid');
    }
    const event = parsed.event;
    if (
      row.raw_created_at !== candidate.observedAt
      || row.chat_message_id !== candidate.sourceChatMessageId
      || row.chat_raw_event_id !== candidate.sourceRawEventId
      || row.chat_platform_message_id !== event.message.messageId
      || row.chat_conversation_id !== candidate.conversationId
      || row.chat_conversation_id !== event.message.conversationId
      || row.chat_conversation_type !== candidate.conversationType
      || event.message.conversationType !== candidate.conversationType
      || row.chat_group_id !== candidate.groupId
      || event.message.groupId !== candidate.groupId
      || row.chat_sender_id !== event.message.senderId
      || row.chat_sender_role !== (event.message.senderRole ?? null)
      || (row.chat_text ?? '') !== (event.message.content.text ?? '')
      || row.chat_mentions_bot !== (event.message.mentionsBot ? 1 : 0)
      || row.chat_reply_to_message_id !== (event.message.replyToMessageId ?? null)
    ) {
      throw new Error('Delayed Attention source event no longer matches its chat evidence');
    }

    return event;
  }

  private buildDelayedAttentionSignals(event: ChatMessageReceived): AttentionSignals {
    const original = this.attention.analyze({
      conversationType: event.message.conversationType,
      mentionsBot: event.message.mentionsBot,
      text: event.message.content.text ?? '',
      senderId: event.message.senderId,
      senderRole: event.message.senderRole,
      replyToBot: false,
    });
    if (
      original.classification !== 'defer'
      || original.recommendedPath !== 'delayed_recheck'
    ) {
      throw new Error('Delayed Attention source no longer matches the deferred policy');
    }

    return {
      ...original,
      classification: 'needs_response',
      recommendedPath: 'reply_fast_path',
      triggerReasons: [...new Set([...original.triggerReasons, 'delayed_recheck'])],
    };
  }

  private findDelayedAttentionTerminalTurn(sourceRawEventId: string): {
    turnId: string;
    actionDecisionId?: string;
    actionExecutionId?: string;
    deliveryRecorded: boolean;
  } | null {
    const rows = this.db.prepare(
      `SELECT turn.id AS turn_id,
              turn.status,
              turn.action_decision_id,
              delivery.id AS delivery_execution_id
         FROM agent_turns AS turn
         LEFT JOIN action_executions AS delivery
           ON delivery.id = (
             SELECT execution.id
               FROM action_executions AS execution
              WHERE execution.action_decision_id = turn.action_decision_id
                AND execution.executed_message_id IS NOT NULL
                AND (
                  (execution.status = 'success' AND execution.action_type IN (
                    'reply_short', 'reply_full', 'reply_with_tool', 'ask_clarification'
                  ))
                  OR (execution.status = 'downgraded' AND execution.action_type IN (
                    'send_folded_forward', 'react_only'
                  ))
                )
              ORDER BY execution.executed_at DESC, execution.id DESC
              LIMIT 1
           )
        WHERE turn.trigger_event_id = ?
        ORDER BY turn.started_at DESC, turn.id DESC`,
    ).all(sourceRawEventId) as Array<{
      turn_id: string;
      status: string;
      action_decision_id: string | null;
      delivery_execution_id: string | null;
    }>;

    const delivered = rows.find((row) => row.delivery_execution_id !== null);
    if (delivered) {
      return {
        turnId: delivered.turn_id,
        ...(delivered.action_decision_id
          ? { actionDecisionId: delivered.action_decision_id }
          : {}),
        actionExecutionId: delivered.delivery_execution_id as string,
        deliveryRecorded: true,
      };
    }

    const completed = rows.find((row) => row.status === 'completed');
    if (completed) {
      return {
        turnId: completed.turn_id,
        ...(completed.action_decision_id
          ? { actionDecisionId: completed.action_decision_id }
          : {}),
        deliveryRecorded: false,
      };
    }

    const indeterminate = rows.find((row) => {
      return row.status === 'pending'
        || row.status === 'running'
        || row.action_decision_id !== null;
    });
    if (indeterminate) {
      throw new Error('Delayed Attention prior turn has indeterminate delivery state');
    }

    return null;
  }

  private buildDelayedAttentionRespondResult(
    candidateId: string,
    decision: DelayedAttentionDecision,
    terminal: {
      turnId: string;
      actionDecisionId?: string;
      actionExecutionId?: string;
      deliveryRecorded: boolean;
    },
  ): object {
    return {
      candidateId,
      decisionId: decision.id,
      outcome: decision.outcome,
      turnId: terminal.turnId,
      ...(terminal.actionDecisionId
        ? { actionDecisionId: terminal.actionDecisionId }
        : {}),
      ...(terminal.actionExecutionId
        ? { actionExecutionId: terminal.actionExecutionId }
        : {}),
      deliveryRecorded: terminal.deliveryRecorded,
    };
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

  private requireConversationType(
    value: unknown,
    taskType: string,
  ): 'private' | 'group' {
    if (value === 'private' || value === 'group') {
      return value;
    }

    throw new Error(`Background task ${taskType} requires payload.conversationType`);
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

  private requireSummarySourceIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
      throw new GroupSummaryPolicyError(
        'job_binding_mismatch',
        'Group summary job requires a bounded frozen source window.',
      );
    }
    const sourceIds = value.map((sourceId) => {
      if (
        typeof sourceId !== 'string'
        || sourceId.length === 0
        || sourceId.trim() !== sourceId
      ) {
        throw new GroupSummaryPolicyError(
          'job_binding_mismatch',
          'Group summary job frozen source IDs are invalid.',
        );
      }
      return sourceId;
    });
    if (new Set(sourceIds).size !== sourceIds.length) {
      throw new GroupSummaryPolicyError(
        'job_binding_mismatch',
        'Group summary job frozen source IDs must be unique.',
      );
    }
    return sourceIds;
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
      database: { ok: boolean; open: boolean };
      adapter: PublicAdapterStatus;
      eventProcessing: { pending: number; failures: number };
    };
  } {
    let databaseOk = false;

    try {
      if (this.db.open) {
        this.db.prepare('SELECT 1').get();
        databaseOk = true;
      }
    } catch {
      databaseOk = false;
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

  private claimAndEnqueueEvent(
    event: ChatMessageReceived,
  ): 'accepted' | 'duplicate' | 'failed' {
    if (!this.acceptingIngress) {
      return 'failed';
    }

    const claim = this.claimRawEvent(event);
    if (claim.disposition === 'accepted') {
      this.enqueueEvent(event, claim.rawEventId);
    }
    return claim.disposition;
  }

  private enqueueEvent(event: ChatMessageReceived, rawEventId: string): void {
    const task = this.processAdmittedEvent(event, rawEventId);
    this.pendingEventTasks.add(task);
    void task.then(
      () => {
        this.pendingEventTasks.delete(task);
      },
      (error: unknown) => {
        this.pendingEventTasks.delete(task);
        logger.error({ error: this.redactErrorForLog(error) }, 'Admission processing transition failed');
      },
    );
  }

  private prepareAdmissionRecovery(): Array<{
    event: ChatMessageReceived;
    rawEventId: string;
  }> {
    const rows = this.db.prepare(
      `SELECT
         a.raw_event_id,
         a.state,
         a.accepted_at,
         re.id,
         re.type,
         re.timestamp,
         re.source,
         re.platform,
         re.conversation_id,
         re.correlation_id,
         re.platform_event_id,
         re.payload,
         EXISTS(SELECT 1 FROM chat_messages cm WHERE cm.raw_event_id = a.raw_event_id) AS has_chat,
         EXISTS(SELECT 1 FROM agent_turns at WHERE at.trigger_event_id = a.raw_event_id) AS has_turn,
         EXISTS(SELECT 1 FROM event_processing_failures epf WHERE epf.raw_event_id = a.raw_event_id) AS has_failure,
         (SELECT COUNT(*)
             FROM event_ingress_receipts receipt
            WHERE receipt.raw_event_id = a.raw_event_id
              AND receipt.disposition = 'accepted') AS accepted_receipt_count,
         (SELECT receipt.transport
             FROM event_ingress_receipts receipt
            WHERE receipt.raw_event_id = a.raw_event_id
              AND receipt.disposition = 'accepted'
            ORDER BY receipt.received_at, receipt.id
            LIMIT 1) AS accepted_transport,
         (SELECT receipt.received_at
             FROM event_ingress_receipts receipt
            WHERE receipt.raw_event_id = a.raw_event_id
              AND receipt.disposition = 'accepted'
            ORDER BY receipt.received_at, receipt.id
            LIMIT 1) AS accepted_received_at
       FROM event_processing_admissions a
       JOIN raw_events re ON re.id = a.raw_event_id
       WHERE a.state IN ('accepted', 'processing')
       ORDER BY a.accepted_at, a.raw_event_id`
    ).all() as Array<StoredChatEventRow & {
      raw_event_id: string;
      state: 'accepted' | 'processing';
      accepted_at: number;
      has_chat: number;
      has_turn: number;
      has_failure: number;
      accepted_receipt_count: number;
      accepted_transport: string | null;
      accepted_received_at: number | null;
    }>;

    const acceptedEvents: Array<{ event: ChatMessageReceived; rawEventId: string }> = [];
    let resetProcessing = 0;
    let staleProcessing = 0;
    let startedEvidence = 0;
    let invalidStoredEvents = 0;

    for (const row of rows) {
      if (row.state === 'processing') {
        const recoveredEvent = this.resetEvidenceEmptyProcessingAdmission(row.raw_event_id);
        if (recoveredEvent) {
          acceptedEvents.push({ event: recoveredEvent, rawEventId: row.raw_event_id });
          resetProcessing += 1;
        } else {
          staleProcessing += this.interruptAdmission(
            row.raw_event_id,
            'processing',
            'stale_processing',
          );
        }
        continue;
      }

      if (row.has_chat === 1 || row.has_turn === 1 || row.has_failure === 1) {
        startedEvidence += this.interruptAdmission(row.raw_event_id, 'accepted', 'started_evidence');
        continue;
      }

      const parsed = parseStoredChatMessageReceived(row);
      if (
        !parsed.ok
        || row.accepted_receipt_count !== 1
        || row.accepted_transport !== parsed.event.ingress.transport
        || row.accepted_received_at !== row.accepted_at
      ) {
        invalidStoredEvents += this.interruptAdmission(
          row.raw_event_id,
          'accepted',
          'invalid_stored_event',
        );
        continue;
      }

      acceptedEvents.push({ event: parsed.event, rawEventId: row.raw_event_id });
    }

    if (rows.length > 0) {
      logger.info({
        acceptedForRecovery: acceptedEvents.length,
        resetProcessing,
        staleProcessing,
        startedEvidence,
        invalidStoredEvents,
      }, 'Event admission recovery reconciled');
    }

    return acceptedEvents;
  }

  private resetEvidenceEmptyProcessingAdmission(
    rawEventId: string,
  ): ChatMessageReceived | undefined {
    const resetAdmission = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT
           a.raw_event_id,
           a.accepted_at,
           a.processing_started_at,
           re.id,
           re.type,
           re.timestamp,
           re.source,
           re.platform,
           re.conversation_id,
           re.correlation_id,
           re.platform_event_id,
           re.payload,
           EXISTS(SELECT 1 FROM chat_messages cm WHERE cm.raw_event_id = a.raw_event_id) AS has_chat,
           EXISTS(SELECT 1 FROM agent_turns at WHERE at.trigger_event_id = a.raw_event_id) AS has_turn,
           EXISTS(SELECT 1 FROM event_processing_failures epf WHERE epf.raw_event_id = a.raw_event_id) AS has_failure,
           (SELECT COUNT(*)
              FROM event_ingress_receipts receipt
             WHERE receipt.raw_event_id = a.raw_event_id
               AND receipt.disposition = 'accepted') AS accepted_receipt_count,
           (SELECT receipt.transport
              FROM event_ingress_receipts receipt
             WHERE receipt.raw_event_id = a.raw_event_id
               AND receipt.disposition = 'accepted'
             ORDER BY receipt.received_at, receipt.id
             LIMIT 1) AS accepted_transport,
           (SELECT receipt.received_at
              FROM event_ingress_receipts receipt
             WHERE receipt.raw_event_id = a.raw_event_id
               AND receipt.disposition = 'accepted'
             ORDER BY receipt.received_at, receipt.id
             LIMIT 1) AS accepted_received_at
         FROM event_processing_admissions a
         JOIN raw_events re ON re.id = a.raw_event_id
         WHERE a.raw_event_id = ? AND a.state = 'processing'`
      ).get(rawEventId) as (StoredChatEventRow & {
        raw_event_id: string;
        accepted_at: number;
        processing_started_at: number;
        has_chat: number;
        has_turn: number;
        has_failure: number;
        accepted_receipt_count: number;
        accepted_transport: string | null;
        accepted_received_at: number | null;
      }) | undefined;

      if (!row || row.has_chat === 1 || row.has_turn === 1 || row.has_failure === 1) {
        return undefined;
      }

      const parsed = parseStoredChatMessageReceived(row);
      if (
        !parsed.ok
        || row.accepted_receipt_count !== 1
        || row.accepted_transport !== parsed.event.ingress.transport
        || row.accepted_received_at !== row.accepted_at
      ) {
        return undefined;
      }

      const changed = this.db.prepare(
        `UPDATE event_processing_admissions
         SET state = 'accepted',
             processing_started_at = NULL,
             finished_at = NULL,
             reason_code = NULL
         WHERE raw_event_id = ?
           AND state = 'processing'
           AND accepted_at = ?
           AND processing_started_at = ?
           AND NOT EXISTS (
             SELECT 1 FROM chat_messages cm
              WHERE cm.raw_event_id = event_processing_admissions.raw_event_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM agent_turns at
              WHERE at.trigger_event_id = event_processing_admissions.raw_event_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM event_processing_failures epf
              WHERE epf.raw_event_id = event_processing_admissions.raw_event_id
           )
           AND (
             SELECT COUNT(*)
               FROM event_ingress_receipts receipt
              WHERE receipt.raw_event_id = event_processing_admissions.raw_event_id
                AND receipt.disposition = 'accepted'
           ) = 1
           AND EXISTS (
             SELECT 1
               FROM event_ingress_receipts receipt
              WHERE receipt.raw_event_id = event_processing_admissions.raw_event_id
                AND receipt.disposition = 'accepted'
                AND receipt.transport = ?
                AND receipt.received_at = event_processing_admissions.accepted_at
           )`
      ).run(
        rawEventId,
        row.accepted_at,
        row.processing_started_at,
        parsed.event.ingress.transport,
      ).changes;

      return changed === 1 ? parsed.event : undefined;
    });

    // The write lock keeps the strict read and guarded reset on one evidence snapshot.
    return resetAdmission.immediate();
  }

  private interruptAdmission(
    rawEventId: string,
    expectedState: 'accepted' | 'processing',
    reasonCode: 'stale_processing' | 'started_evidence' | 'invalid_stored_event',
  ): number {
    const completedAt = new Date();
    return this.db.transaction(() => {
      const changed = this.db.prepare(
        `UPDATE event_processing_admissions
         SET state = 'interrupted_review', finished_at = ?, reason_code = ?
         WHERE raw_event_id = ? AND state = ?`
      ).run(completedAt.getTime(), reasonCode, rawEventId, expectedState).changes;

      if (changed === 1) {
        this.turnRepo.markAbortedByTriggerEvent(
          rawEventId,
          'Startup admission recovery interrupted this turn',
          completedAt,
        );
      }

      return changed;
    })();
  }

  private async processAdmittedEvent(
    event: ChatMessageReceived,
    rawEventId: string,
  ): Promise<void> {
    const processingStartedAt = Date.now();
    const started = this.db.prepare(
      `UPDATE event_processing_admissions
       SET state = 'processing', processing_started_at = ?
       WHERE raw_event_id = ? AND state = 'accepted'`
    ).run(processingStartedAt, rawEventId).changes;
    if (started !== 1) {
      return;
    }

    const outcome = await this.handleEvent(event, rawEventId);
    const reasonCode = outcome === 'failed' ? 'handler_failed' : null;
    const terminalized = this.db.prepare(
      `UPDATE event_processing_admissions
       SET state = ?, finished_at = ?, reason_code = ?
       WHERE raw_event_id = ? AND state = 'processing'`
    ).run(outcome, Date.now(), reasonCode, rawEventId).changes;
    if (terminalized !== 1) {
      throw new Error('Unable to terminalize event processing admission');
    }
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
  private async resolveIdentity(platformUserId: string): Promise<string | null> {
    try {
      const canonicalUserId = await this.identityRepo.getOrCreateCanonicalUser(
        'qq',
        platformUserId,
      );
      logger.debug({ canonicalUserId }, 'Resolved user identity');
      return canonicalUserId;
    } catch (error) {
      if (error instanceof InactivePlatformAccountError) {
        logger.info({
          platform: 'qq',
          accountStatus: error.status,
        }, 'Inactive platform account denied');
        return null;
      }

      logger.error({ error, platformUserId }, 'Failed to resolve identity');
      throw error;
    }
  }

  /**
   * 存储原始事件到数据库
   */
  private claimRawEvent(event: ChatMessageReceived): {
    disposition: 'accepted' | 'duplicate';
    rawEventId: string;
  } {
    return this.db.transaction(() => {
      const conversationId = event.conversationId ?? event.message.conversationId;
      const platformEventId = event.ingress.platformEventId ?? null;
      const receivedAt = Date.now();
      const insert = this.db.prepare(`
        INSERT INTO raw_events (
          id, type, timestamp, source, platform,
          conversation_id, correlation_id, platform_event_id, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).run(
        event.id,
        event.type,
        new Date(event.timestamp).getTime(),
        event.source,
        event.platform,
        conversationId,
        event.correlationId ?? null,
        platformEventId,
        JSON.stringify(event),
        receivedAt,
      );

      let disposition: 'accepted' | 'duplicate';
      let rawEventId: string;
      if (insert.changes === 1) {
        disposition = 'accepted';
        rawEventId = event.id;
      } else {
        if (!platformEventId) {
          throw new Error('Unable to claim OneBot event without a stable platform event id');
        }
        const canonical = this.db.prepare(
          `SELECT id
             FROM raw_events
            WHERE source = 'gateway'
              AND platform = ?
              AND type = ?
              AND conversation_id = ?
              AND platform_event_id = ?`
        ).get(event.platform, event.type, conversationId, platformEventId) as { id: string } | undefined;
        if (!canonical) {
          throw new Error('Unable to resolve canonical OneBot event after claim conflict');
        }
        disposition = 'duplicate';
        rawEventId = canonical.id;
      }

      this.db.prepare(
        `INSERT INTO event_ingress_receipts (
          id, raw_event_id, transport, disposition, received_at
        ) VALUES (?, ?, ?, ?, ?)`
      ).run(
        `ingress-receipt-${randomUUID()}`,
        rawEventId,
        event.ingress.transport,
        disposition,
        receivedAt,
      );

      if (disposition === 'accepted') {
        this.db.prepare(
          `INSERT INTO event_processing_admissions (
            raw_event_id, state, accepted_at, processing_started_at, finished_at, reason_code
          ) VALUES (?, 'accepted', ?, NULL, NULL, NULL)`
        ).run(rawEventId, receivedAt);
      }

      logger.debug({ rawEventId, disposition }, 'OneBot ingress claimed');
      return { disposition, rawEventId };
    })();
  }

  /**
   * 存储聊天消息到数据库
   */
  private storeChatMessage(
    event: ChatMessageReceived,
    rawEventId: string,
    isFromBot: boolean = false,
  ): void {
    this.db.prepare(`
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
  private storeBotResponse(
    conversationId: string,
    conversationType: 'private' | 'group',
    text: string,
    groupId?: string,
    sentMessageId?: string,
  ): void {
    const rawEventId = `evt-bot-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const messageId = sentMessageId ?? `msg-bot-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    this.db.transaction(() => {
      this.db.prepare(`
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
      this.db.prepare(`
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
    })();

    logger.debug({ messageId, rawEventId }, 'Bot response stored');
  }

  private findSuccessfulReplyExecution(results: ActionExecutionResult[]): ActionExecutionResult | undefined {
    return results.find((result) => {
      if (!result.executed?.messageId) {
        return false;
      }

      if (
        result.status === 'success' &&
        (result.actionType === 'reply_short' ||
          result.actionType === 'reply_full' ||
          result.actionType === 'reply_with_tool' ||
          result.actionType === 'ask_clarification')
      ) {
        return true;
      }

      return result.status === 'downgraded' && (
        result.actionType === 'send_folded_forward' ||
        result.actionType === 'react_only'
      );
    });
  }

  private getDeliveredReplyText(
    decision: ActionDecision,
    execution: ActionExecutionResult,
    fallbackText: string,
  ): string {
    const actionText = decision.actions.find((action) => {
      return action.type === execution.actionType && action.payload?.text?.trim();
    })?.payload?.text?.trim();
    const reactionText = execution.actionType === 'react_only'
      ? decision.actions.find((action) => action.type === 'react_only' && action.payload?.reaction?.trim())
        ?.payload?.reaction?.trim()
      : undefined;

    return actionText ?? reactionText ?? fallbackText;
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
  private async handleEvent(
    event: ChatMessageReceived,
    rawEventId: string,
    options: {
      sourceAlreadyPersisted?: boolean;
      signals?: AttentionSignals;
    } = {},
  ): Promise<EventHandlingOutcome> {
    let turnId: string | undefined;
    let turnFinalized = false;
    let currentStage = 'identity_resolution';

    try {
      logger.info({
        type: event.type,
        conversationId: event.conversationId,
        senderId: event.message.senderId,
      }, 'Processing event');

      // 0.1 解析用户身份
      currentStage = 'identity_resolution';
      const senderId = event.message.senderId.replace('qq-', '');
      const canonicalUserId = await this.resolveIdentity(senderId);
      if (!canonicalUserId) {
        return 'completed';
      }

      if (!options.sourceAlreadyPersisted) {
        currentStage = 'display_metadata';
        await this.recordDisplayMetadata(event, canonicalUserId);
      }

      const parsedGovernanceCommand = parseQqGovernanceCommand(
        event.message.content.text ?? '',
      );
      if (parsedGovernanceCommand.status !== 'not_command') {
        if (options.sourceAlreadyPersisted) {
          logger.debug('Stored governance command is not replayed through delayed Attention');
          return 'completed';
        }

        currentStage = 'chat_message_store';
        this.storeChatMessage(event, rawEventId, false);

        currentStage = 'turn_create';
        const conversationId = event.conversationId ?? event.message.conversationId;
        turnId = await this.turnRepo.createPending({
          conversationId,
          triggerEventId: rawEventId,
          piModel: 'qq-governance-v1',
          piProvider: 'local',
        });
        const governanceTurnId = turnId;

        currentStage = 'governance_command';
        const actionType = event.message.conversationType === 'group'
          ? 'reply_short'
          : 'reply_full';
        const persistGovernanceEffectAndDecision = this.db.transaction(() => {
          const governanceResult = this.governance.handleQqCommandSync({
            sourceEventId: rawEventId,
            ...(this.config.botOwnerQqId === undefined
              ? {}
              : { botOwnerQqId: this.config.botOwnerQqId }),
          });
          if (!governanceResult) {
            throw new Error('Governance command verification mismatch');
          }

          const actionDecision = this.actionRepo.createDecisionSync({
            turnId: governanceTurnId,
            decidedBy: 'attention',
            actions: [
              {
                type: actionType,
                priority: 100,
                target: {
                  conversationId,
                  conversationType: event.message.conversationType,
                  ...(event.message.conversationType === 'group'
                    ? { groupId: event.message.groupId }
                    : {
                        userId: event.message.senderId,
                        canonicalUserId,
                      }),
                },
                payload: { text: governanceResult.responseText },
                constraints: {
                  evaluatorRequired: false,
                  redactionLevel: 'strict',
                  proactive: false,
                },
                reason: 'Deterministic QQ governance command',
              },
            ],
            riskLevel: 'low',
            confidence: 1,
            reasons: ['Deterministic QQ governance command'],
            suppressors: [],
            evaluatorRequired: false,
            claimActor: { canonicalUserId },
          });
          return { governanceResult, actionDecision };
        });
        const {
          governanceResult,
          actionDecision,
        } = persistGovernanceEffectAndDecision.immediate();

        currentStage = 'action_execution';
        const actionResults = await this.actionExecutor.execute(actionDecision);
        const successfulReply = this.findSuccessfulReplyExecution(actionResults);
        const deliveredReplyText = successfulReply
          ? this.getDeliveredReplyText(
              actionDecision,
              successfulReply,
              governanceResult.responseText,
            )
          : undefined;

        if (successfulReply && deliveredReplyText && deliveredReplyText.trim().length > 0) {
          const completedTurnId = turnId;
          this.db.transaction(() => {
            currentStage = 'bot_response_persist';
            this.storeBotResponse(
              conversationId,
              event.message.conversationType,
              deliveredReplyText,
              event.message.groupId,
              successfulReply.executed?.messageId,
            );

            currentStage = 'turn_complete';
            this.turnRepo.markCompleted(completedTurnId, {
              responseText: deliveredReplyText,
              tokensUsed: { input: 0, output: 0, total: 0 },
            });
          })();
          turnFinalized = true;
        } else {
          currentStage = 'turn_complete';
          this.turnRepo.markCompleted(turnId, {
            responseText: governanceResult.responseText,
            tokensUsed: { input: 0, output: 0, total: 0 },
          });
          turnFinalized = true;
        }

        return 'completed';
      }

      const hasNormalizedContent = Boolean(event.message.content.text?.trim())
        || (event.message.content.media?.length ?? 0) > 0
        || event.message.content.quote !== undefined
        || (event.message.mentions?.length ?? 0) > 0
        || event.message.mentionsBot
        || event.message.replyToMessageId !== undefined;
      let signals = options.signals;
      if (hasNormalizedContent && !signals) {
        try {
          currentStage = 'attention_analysis';
          signals = this.attention.analyze({
            conversationType: event.message.conversationType,
            mentionsBot: event.message.mentionsBot,
            text: event.message.content.text ?? '',
            senderId: event.message.senderId,
            senderRole: event.message.senderRole,
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
      }

      if (!options.sourceAlreadyPersisted) {
        const shouldEnqueueExtraction = isAutomaticExtractionCandidate({
          text: event.message.content.text ?? '',
          conversationType: event.message.conversationType,
        });
        currentStage = signals?.classification === 'defer'
          ? 'delayed_attention_persist'
          : 'chat_message_store';
        this.db.transaction(() => {
          this.storeChatMessage(event, rawEventId, false);
          if (shouldEnqueueExtraction) {
            currentStage = 'memory_extraction_enqueue';
            this.backgroundWorker.enqueue({
              type: 'extraction',
              payload: {
                sourceChatMessageId: rawEventId,
                targetUserId: canonicalUserId,
              },
              idempotencyKey: `extraction:auto:${rawEventId}`,
              maxAttempts: 3,
            });
          }
          if (signals?.classification === 'defer') {
            currentStage = 'delayed_attention_persist';
            this.delayedAttention.enqueueCandidate({ sourceRawEventId: rawEventId });
          }
        }).immediate();
      }

      if (!hasNormalizedContent) {
        logger.debug('Event has no normalized message content, skipping');
        return 'completed';
      }
      if (!signals) {
        throw new Error('Attention signals are required for normalized message content');
      }
      if (signals.classification === 'defer') {
        logger.debug('Event deferred for delayed Attention recheck');
        return 'completed';
      }

      // 如果不需要响应，直接返回
      if (signals.classification === 'silent') {
        logger.debug('Event classified as silent, skipping');
        return 'completed';
      }

      currentStage = 'turn_create';
      turnId = await this.turnRepo.createPending({
        conversationId: event.conversationId ?? event.message.conversationId,
        triggerEventId: rawEventId,
        piModel: this.piModel,
        piProvider: this.piProvider,
      });

      // 2. 构建上下文
      const groupId = event.message.groupId;

      let context;
      try {
        currentStage = 'context_building';
        context = await this.contextBuilder.buildContext({
          turnId,
          conversationId: event.conversationId ?? event.message.conversationId,
          conversationType: event.message.conversationType,
          recentMessages: [
            {
              messageId: rawEventId,
              senderId: event.message.senderId,
              text: event.message.content.text ?? '',
              timestamp: event.timestamp,
              senderDisplayName: event.message.senderDisplayName ?? event.message.senderId,
              isFromBot: false,
              ...(event.message.senderRole ? { senderRole: event.message.senderRole } : {}),
            },
          ],
          currentMessageId: rawEventId,
          ...(event.message.replyToMessageId
            ? { replyToMessageId: event.message.replyToMessageId }
            : {}),
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
            ...(groupId ? { groupId } : {}),
          },
          invocationContext: event.message.conversationType === 'private' ? 'private_chat' : 'group_chat',
          turnId,
          sourceEventIds: [rawEventId],
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
        return 'failed';
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
          actorClass: event.message.conversationType === 'group'
            && (event.message.senderRole === 'owner' || event.message.senderRole === 'admin')
            ? 'group_admin'
            : 'user',
        },
      });
      currentStage = 'action_execution';
      const actionResults = await this.actionExecutor.execute(actionDecision);
      const successfulReply = this.findSuccessfulReplyExecution(actionResults);
      const deliveredReplyText = successfulReply
        ? this.getDeliveredReplyText(actionDecision, successfulReply, responseText)
        : undefined;

      if (successfulReply && deliveredReplyText && deliveredReplyText.trim().length > 0) {
        try {
          logger.info({
            conversationId: event.conversationId,
            responseLength: deliveredReplyText.length,
            actionDecisionId: actionDecision.id,
            actionExecutionId: successfulReply.id,
          }, 'Response action executed');

          if (!turnId) {
            throw new Error('Turn identity is required before post-action persistence');
          }
          const completedTurnId = turnId;
          this.db.transaction(() => {
            currentStage = 'bot_response_persist';
            this.storeBotResponse(
              event.conversationId ?? event.message.conversationId,
              event.message.conversationType,
              deliveredReplyText,
              event.message.groupId,
              successfulReply.executed?.messageId,
            );

            currentStage = 'turn_complete';
            this.turnRepo.markCompleted(completedTurnId, {
              responseText,
              tokensUsed: piResult.tokensUsed,
            });
          })();
          turnFinalized = true;
        } catch (error) {
          logger.error({
            error: error instanceof Error ? {
              message: error.message,
              stack: error.stack,
              name: error.name,
            } : error,
            step: currentStage,
            conversationType: event.message.conversationType,
            conversationId: event.conversationId,
            senderId: event.message.senderId,
            groupId: event.message.groupId,
            responseLength: responseText.length,
          }, 'Failed to persist post-action side effects');
          throw error;
        }
      }

      if (!turnFinalized) {
        currentStage = 'turn_complete';
        await this.turnRepo.markCompleted(turnId, {
          responseText,
          tokensUsed: piResult.tokensUsed,
        });
        turnFinalized = true;
      }
      return 'completed';
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
      return 'failed';
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

export function isMainModuleInvocation(
  moduleUrl: string,
  invokedPath: string | undefined,
): boolean {
  if (!invokedPath) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invokedPath);
  } catch {
    return moduleUrl === pathToFileURL(invokedPath).href;
  }
}

// 运行
if (isMainModuleInvocation(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error('Fatal error:', formatFatalErrorForConsole(error));
    process.exit(1);
  });
}

export { LetheBotApp };
