/**
 * LetheBot Main Entry
 *
 * 集成所有模块，启动 HTTP 服务器接收 NapCat 事件
 */

import Database from 'better-sqlite3';
import { realpathSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import {
  isReverseHttpIngressEnabled,
  loadConfig,
  type Config,
} from './config/index.js';
import { getLogger } from './logger/index.js';
import { ApplicationHttpServer } from './http/application-http-server.js';
import type { GovernanceHttpServer } from './http/governance-http-server.js';
import { createGovernanceApplication } from './http/governance-application.js';
import { TurnApplicationService } from './application/turn-application-service.js';
import { BackgroundRuntimeService } from './application/background-runtime-service.js';
import {
  ConversationTurnService,
  type PiRuntime,
} from './application/conversation-turn-service.js';
import { closeDatabase, initDatabase, runMigrations } from './storage/database.js';
import { MemoryRepository } from './storage/memory-repository.js';
import { IdentityRepository } from './storage/identity-repository.js';
import { AuditRepository } from './storage/audit-repository.js';
import { ContextTraceRepository } from './storage/context-trace-repository.js';
import { TurnRepository } from './storage/turn-repository.js';
import { ToolCallRepository } from './storage/tool-call-repository.js';
import { LocalToolEffectCoordinator } from './storage/local-tool-effect-coordinator.js';
import { EvaluatorDecisionRepository } from './storage/evaluator-decision-repository.js';
import { ModelInvocationRepository } from './storage/model-invocation-repository.js';
import { PrivacyPreferenceRepository } from './storage/privacy-preference-repository.js';
import { JobRepository } from './storage/job-repository.js';
import { GroupSummaryPolicyRepository } from './storage/group-summary-policy-repository.js';
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
import { DelayedAttentionService } from './attention/delayed-attention-service.js';
import { ContextBuilder } from './context/builder.js';
import { PiAdapter, type PiAdapterInput, type PiAdapterOutput } from './pi/pi-adapter.js';
import { TurnAdmissionController } from './pi/turn-admission-controller.js';
import { ToolRegistry } from './tools/registry.js';
import { registerBuiltInTools } from './tools/builtins/memory-search.js';
import {
  createRuntimeStatusTool,
  type RuntimeStatusLocalState,
} from './tools/builtins/runtime-status.js';
import { createRuntimeToolsTool } from './tools/builtins/runtime-tools.js';
import { createWorkspaceListTool } from './tools/builtins/workspace-list.js';
import { createWorkspaceReadTextTool } from './tools/builtins/workspace-read-text.js';
import { createWebFetchTextTool } from './tools/builtins/web-fetch-text.js';
import { PolicyGate } from './policy/gate.js';
import {
  createRuntimeEvaluator,
  resolveEvaluatorConfig,
} from './evaluator/runtime.js';
import { redactSecretsInText } from './memory/secret-scan.js';
import { MemoryProposalService } from './memory/proposal-service.js';
import { MemoryExtractionWorker } from './workers/memory-extraction.js';
import type {
  EnqueueTaskInput,
  TaskType,
  TaskResult,
} from './workers/background.js';
import type { GroupSummaryJobService } from './workers/group-summary-job-service.js';
import { EventAdmissionRecovery } from './ingestion/event-admission-recovery.js';
import { EventIngressClaimService } from './ingestion/event-ingress-claim.js';
import { GovernanceService } from './governance/service.js';
import {
  collectOperationsMetrics,
  formatOperationsMetricsPrometheus,
} from './operations/sqlite-maintenance.js';
import type { ChatMessageReceived } from './types/events.js';
import type { IEvaluator } from './types/evaluator.js';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { VERSION } from './version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = getLogger();

export { VERSION };

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
    .replace(/(?<![A-Za-z0-9])\d{5,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
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
    && /^\d{5,12}$/.test(text);
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
  private turnRepo: TurnRepository;
  private admissionRecovery: EventAdmissionRecovery;
  private eventIngressClaim: EventIngressClaimService;
  private turnApplication: TurnApplicationService;
  private conversationTurn: ConversationTurnService;
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
  private toolRegistry: ToolRegistry;
  private policyGate: PolicyGate;
  private pi: PiRuntime;
  private turnAdmission: TurnAdmissionController;
  private piProvider: string;
  private piModel: string;
  private actionExecutor: ActionExecutor;
  private socialEvaluator: IEvaluator;
  private cooldowns: ActionCooldownManager;
  private socialDecisionService: SocialDecisionService;
  private memoryExtractor: MemoryExtractionWorker;
  private backgroundRuntime: BackgroundRuntimeService;
  private httpServer: ApplicationHttpServer | null = null;
  private governanceHttpServer: GovernanceHttpServer | null = null;
  private acceptingIngress = false;
  private stopPromise: Promise<void> | null = null;
  constructor() {
    this.config = loadConfig();
    this.turnAdmission = new TurnAdmissionController(
      this.config.piMaxConcurrentTurns,
      this.config.piMaxQueuedTurns,
    );

    // 初始化数据库
    logger.info('Initializing database...');
    this.db = initDatabase({ path: this.config.dbPath });
    runMigrations(this.db, join(__dirname, '../migrations'));

    // 初始化存储层
    this.memoryRepo = new MemoryRepository(this.db);
    this.identityRepo = new IdentityRepository(this.db);
    this.auditRepo = new AuditRepository(this.db);
    const contextTraceRepo = new ContextTraceRepository(this.db);
    this.turnRepo = new TurnRepository(this.db);
    this.admissionRecovery = new EventAdmissionRecovery(this.db, this.turnRepo);
    this.eventIngressClaim = new EventIngressClaimService(this.db);
    this.turnApplication = new TurnApplicationService(this.db, this.turnAdmission, {
      turnTimeoutMs: this.config.piTurnTimeoutMs,
      handleEvent: (event, rawEventId, options) => (
        this.conversationTurn.handleEvent(event, rawEventId, options)
      ),
      redactSensitiveText: (text) => this.redactSensitiveText(text),
      onFailurePersistenceError: (error) => {
        logger.error({ error }, 'Failed to persist event processing failure record');
      },
      onTaskFailure: (error) => {
        logger.error({ error: this.redactErrorForLog(error) }, 'Admission processing transition failed');
      },
    });
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
    this.toolRegistry.register(createRuntimeStatusTool({
      database: this.db,
      readRuntimeState: () => this.buildRuntimeStatusLocalState(),
    }));
    if (this.config.workspaceRoot) {
      this.toolRegistry.register(createWorkspaceListTool({
        workspaceRoot: this.config.workspaceRoot,
      }));
      this.toolRegistry.register(createWorkspaceReadTextTool({
        workspaceRoot: this.config.workspaceRoot,
      }));
    }
    if (this.config.webFetchAllowedOrigins.length > 0) {
      this.toolRegistry.register(createWebFetchTextTool({
        allowedOrigins: this.config.webFetchAllowedOrigins,
      }));
    }
    this.toolRegistry.register(createRuntimeToolsTool({
      registry: this.toolRegistry,
    }));
    for (const name of this.config.disabledTools) {
      if (this.toolRegistry.get(name)) {
        this.toolRegistry.disable(name);
      }
    }
    this.policyGate = new PolicyGate(this.toolRegistry);

    // 初始化核心模块
    this.attention = new AttentionEngine();
    this.delayedAttention = new DelayedAttentionService(this.db, this.jobRepo);
    const contextBuilder = new ContextBuilder(this.memoryRepo, this.identityRepo, this.db);

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
    const modelInvocationRepository = new ModelInvocationRepository(this.db);
    this.socialEvaluator = createRuntimeEvaluator(evaluatorConfig, {
      test: this.config.test,
      invocationLedger: modelInvocationRepository,
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
          modelInvocationRepository,
          evaluatorDecisionWriter: new EvaluatorDecisionRepository(this.db),
          localToolEffectCoordinator: new LocalToolEffectCoordinator(
            this.db,
            this.toolCallRepo,
            this.auditRepo,
          ),
        });

    this.backgroundRuntime = new BackgroundRuntimeService({
      db: this.db,
      jobRepository: this.jobRepo,
      memoryRepository: this.memoryRepo,
      identityRepository: this.identityRepo,
      auditRepository: this.auditRepo,
      groupSummaryPolicyRepository: this.groupSummaryPolicyRepo,
      attentionEngine: this.attention,
      delayedAttentionService: this.delayedAttention,
      turnAdmissionController: this.turnAdmission,
      test: this.config.test,
      backgroundSummaryEnabled: this.config.backgroundSummaryEnabled,
      piProvider: this.piProvider,
      piModel: this.piModel,
      piTurnTimeoutMs: this.config.piTurnTimeoutMs,
      retentionPolicy: {
        rawEventsDays: this.config.rawEventRetentionDays,
        chatMessagesDays: this.config.chatMessageRetentionDays,
        auditLogDays: this.config.auditLogRetentionDays,
        disabledDeletedMemoryDays: this.config.disabledDeletedMemoryRetentionDays,
        eventProcessingFailuresDays: this.config.eventProcessingFailureRetentionDays,
      },
      getPiRuntime: () => this.pi,
      getMemoryExtractor: () => this.memoryExtractor,
      handleConversationTurn: (event, rawEventId, options) => (
        this.conversationTurn.handleEvent(event, rawEventId, options)
      ),
    });
    this.groupSummaryJobService = this.backgroundRuntime.groupSummaryJobService;

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
    this.conversationTurn = new ConversationTurnService({
      db: this.db,
      identityRepository: this.identityRepo,
      contextTraceRepository: contextTraceRepo,
      turnRepository: this.turnRepo,
      actionRepository: this.actionRepo,
      attentionEngine: this.attention,
      delayedAttentionService: this.delayedAttention,
      contextBuilder,
      governanceService: this.governance,
      enqueueBackgroundTask: (task) => this.backgroundRuntime.enqueue(task),
      piProvider: this.piProvider,
      piModel: this.piModel,
      ...(this.config.botOwnerQqId === undefined
        ? {}
        : { botOwnerQqId: this.config.botOwnerQqId }),
      getPiRuntime: () => this.pi,
      getActionExecutor: () => this.actionExecutor,
      getSocialDecisionService: () => this.socialDecisionService,
      redactSensitiveText: (text) => this.redactSensitiveText(text),
      recordEventProcessingFailure: (input) => {
        this.turnApplication.recordEventProcessingFailure(input);
      },
      logger,
    });

    // Register the durable ingress claim before any downstream event work.
    this.adapter.onIngress((event) => this.claimAndEnqueueEvent(event));

    logger.info({ version: VERSION }, 'LetheBot initialized');
  }

  /**
   * 启动应用
   */
  async start(): Promise<void> {
    const acceptedEvents = this.admissionRecovery.recover();
    await this.adapter.start();

    this.adapter.whenReady(() => {
      for (const acceptedEvent of acceptedEvents) {
        this.turnApplication.enqueue(
          acceptedEvent.event,
          acceptedEvent.rawEventId,
          acceptedEvent.acceptedAt,
        );
      }
      this.acceptingIngress = true;
    });

    this.backgroundRuntime.registerJobs();
    if (!this.config.test) {
      this.backgroundRuntime.start();
    }

    this.governanceHttpServer = createGovernanceApplication({
      config: this.config,
      db: this.db,
      governance: this.governance,
    });
    this.httpServer = new ApplicationHttpServer({
      host: this.config.lethebotHost,
      port: this.config.lethebotPort,
      healthPath: this.config.lethebotHealthPath,
      readinessPath: this.config.lethebotReadinessPath,
      metricsPath: this.config.lethebotMetricsPath,
      eventPath: this.config.lethebotEventPath,
      reverseHttpIngressEnabled: isReverseHttpIngressEnabled(this.config),
    }, {
      handleHealth: (res) => {
        const health = this.buildHealthStatus();
        res.writeHead(health.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
      },
      handleReadiness: (res) => {
        const readiness = this.buildReadinessStatus();
        res.writeHead(readiness.status === 'ready' ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(readiness));
      },
      handleMetrics: (format, res) => {
        try {
          const metrics = collectOperationsMetrics(this.db);
          if (format === 'prometheus') {
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
      },
      handleOneBotEvent: (req, res) => {
        this.handleOneBotHttpEvent(req, res);
      },
    });
    try {
      await this.governanceHttpServer.start();
      await this.httpServer.start();
    } catch (error) {
      await Promise.allSettled([
        this.closeGovernanceHttpServer(),
        this.closeHttpServer(),
      ]);
      throw error;
    }
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

    const schedulerDrain = this.backgroundRuntime.stopAndDrain();
    const serverClose = this.closeHttpServer();
    const governanceServerClose = this.closeGovernanceHttpServer();

    await Promise.all([
      schedulerDrain,
      serverClose,
      governanceServerClose,
      this.waitForIdle(),
    ]);

    await this.adapter.stop();
    if (this.db.open) {
      closeDatabase(this.db);
    }
    logger.info('LetheBot stopped');
  }

  private closeHttpServer(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    if (!server) {
      return Promise.resolve();
    }
    return server.close();
  }

  private closeGovernanceHttpServer(): Promise<void> {
    const server = this.governanceHttpServer;
    this.governanceHttpServer = null;
    if (!server) {
      return Promise.resolve();
    }
    return server.close();
  }

  private handleOneBotHttpEvent(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    let bodyTimeout: ReturnType<typeof setTimeout> | undefined;

    const clearBodyState = (): void => {
      if (bodyTimeout) {
        clearTimeout(bodyTimeout);
        bodyTimeout = undefined;
      }
      chunks.length = 0;
    };

    const abandon = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearBodyState();
    };

    const respond = (
      status: number,
      payload: Record<string, string>,
      closeConnection = false,
    ): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      clearBodyState();
      res.writeHead(status, {
        'Content-Type': 'application/json',
        ...(closeConnection ? { Connection: 'close' } : {}),
      });
      res.end(JSON.stringify(payload));
      if (closeConnection) {
        req.resume();
      }
      return true;
    };

    req.once('aborted', abandon);
    req.once('error', abandon);
    res.once('close', () => {
      if (!res.writableFinished) {
        abandon();
      }
    });

    if (!this.acceptingIngress) {
      respond(503, { error: 'event_unavailable' }, true);
      return;
    }

    if (!this.adapter.hasHttpEventAuthCandidate(req.headers)) {
      respond(401, { error: 'Unauthorized' }, true);
      return;
    }

    const contentLength = req.headers['content-length'];
    const declaredBytes = typeof contentLength === 'string' ? Number(contentLength) : undefined;
    if (declaredBytes !== undefined && declaredBytes > this.config.lethebotMaxEventBodyBytes) {
      respond(413, { error: 'Payload Too Large' }, true);
      return;
    }

    bodyTimeout = setTimeout(() => {
      respond(408, { error: 'Request Timeout' }, true);
    }, this.config.lethebotEventBodyTimeoutMs);

    req.on('data', (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.byteLength;
      if (receivedBytes > this.config.lethebotMaxEventBodyBytes) {
        respond(413, { error: 'Payload Too Large' }, true);
        return;
      }
      chunks.push(buffer);
    });

    req.once('end', () => {
      if (settled) {
        return;
      }

      if (bodyTimeout) {
        clearTimeout(bodyTimeout);
        bodyTimeout = undefined;
      }

      try {
        if (!this.acceptingIngress) {
          respond(503, { error: 'event_unavailable' });
          return;
        }

        const body = Buffer.concat(chunks, receivedBytes).toString('utf8');
        chunks.length = 0;
        if (!this.adapter.validateHttpEventAuth(req.headers, body)) {
          respond(401, { error: 'Unauthorized' });
          return;
        }

        let event: unknown;
        try {
          event = JSON.parse(body);
        } catch {
          logger.warn({
            transport: 'http',
            status: 'invalid_json',
            bodyBytes: receivedBytes,
          }, 'Rejected malformed OneBot event JSON');
          respond(400, { error: 'Invalid JSON' });
          return;
        }

        const disposition = this.adapter.dispatchInboundEvent(event, 'http');
        logger.debug({
          transport: 'http',
          disposition,
          bodyBytes: receivedBytes,
        }, 'Handled OneBot event');
        if (disposition === 'failed') {
          respond(503, { error: 'event_unavailable' });
          return;
        }

        respond(200, { status: 'ok' });
      } catch {
        logger.error({
          transport: 'http',
          status: 'handler_error',
          bodyBytes: receivedBytes,
        }, 'Failed to handle OneBot event');
        respond(500, { error: 'Internal server error' });
      }
    });
  }

  /**
   * 等待当前已入队事件处理完成，供测试/运维检查使用。
   */
  async waitForIdle(): Promise<void> {
    await this.turnApplication.waitForIdle();
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
    return this.turnApplication.getEventProcessingFailures();
  }

  /**
   * Clear accumulated event-processing failures for integration tests that
   * intentionally exercise failure observability.
   */
  clearEventProcessingFailuresForTesting(): void {
    this.turnApplication.clearEventProcessingFailuresForTesting();
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
  setPiRuntimeForTesting(runtime: PiRuntime): void {
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
    return this.backgroundRuntime.enqueue(task);
  }

  /**
   * Process one durable background job through the runtime worker.
   */
  async processNextBackgroundJobForTesting(
    now?: number,
    types?: TaskType[],
  ): Promise<TaskResult | null> {
    return this.backgroundRuntime.processNext(now, types);
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
          pending: this.turnApplication.pendingCount,
          failures: this.turnApplication.failureCount,
        },
      },
    };
  }

  private buildRuntimeStatusLocalState(): RuntimeStatusLocalState {
    const health = this.buildHealthStatus();
    const readiness = this.buildReadinessStatus();
    return {
      health: health.status,
      readiness: readiness.status,
      database: health.checks.database.ok ? 'ok' : 'unavailable',
      gateway: health.checks.adapter.ready ? 'ready' : 'not_ready',
      pendingEvents: health.checks.eventProcessing.pending,
      eventFailures: health.checks.eventProcessing.failures,
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
          pending: this.turnApplication.pendingCount,
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

    const claim = this.eventIngressClaim.claim(event);
    if (claim.disposition === 'accepted' && claim.acceptedAt !== undefined) {
      this.turnApplication.enqueue(event, claim.rawEventId, claim.acceptedAt);
    }
    return claim.disposition;
  }

  private createTestPiRuntime(): PiRuntime {
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
