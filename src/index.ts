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
import { GovernanceHttpServer } from './http/governance-http-server.js';
import { GovernancePreviewHandleRegistry } from './http/governance-preview-handle-registry.js';
import { GovernanceResourceHandleRegistry } from './http/governance-resource-handle-registry.js';
import { GovernanceScopeHandleRegistry } from './http/governance-scope-handle-registry.js';
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
import {
  GroupSummaryPolicyRepository,
  type GroupSummaryPolicyExpectedVersion,
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
import {
  GovernanceQueryService,
  MEMORY_MAINTENANCE_APPLICATION_ACTION,
  MEMORY_MAINTENANCE_APPROVAL_ACTION,
  MEMORY_MAINTENANCE_EXPIRATION_ACTION,
  MEMORY_MAINTENANCE_REJECTION_ACTION,
  MEMORY_MAINTENANCE_ROLLBACK_ACTION,
  MEMORY_RECORD_FORGET_ACTION,
  MEMORY_RECORD_RESTORE_ACTION,
  DISPLAY_PROFILE_REDACTION_ACTION,
  GROUP_SUMMARY_POLICY_CHANGE_ACTION,
  PLATFORM_ACCOUNT_UNLINK_ACTION,
  PRIVACY_PREFERENCE_CHANGE_ACTION,
  type ResolvedMemoryMaintenanceApplication,
} from './governance/query-service.js';
import { GovernanceOperationsCoordinator } from './governance/operations-coordinator.js';
import {
  DISPLAY_PROFILE_REDACTION_REASON_CODE,
  PLATFORM_ACCOUNT_UNLINK_REASON_CODE,
  GovernanceService,
} from './governance/service.js';
import {
  collectOperationsMetrics,
  formatOperationsMetricsPrometheus,
} from './operations/sqlite-maintenance.js';
import { prepareGovernanceRestoreHandoff } from './operations/governance-restore-handoff.js';
import type { ChatMessageReceived } from './types/events.js';
import type { IEvaluator } from './types/evaluator.js';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { VERSION } from './version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = getLogger();
const GOVERNANCE_SCOPES_PATH = '/governance/api/v1/scopes';
const GOVERNANCE_MEMORY_SCOPES_PATH = '/governance/api/v1/memory/scopes';
const GOVERNANCE_MEMORY_RECORDS_PATH = '/governance/api/v1/memory/records';
const GOVERNANCE_MEMORY_RECORD_DETAIL_PATH = `${GOVERNANCE_MEMORY_RECORDS_PATH}/:resourceHandle`;
const GOVERNANCE_MEMORY_RECORD_CONFIRM_PATH = `${GOVERNANCE_MEMORY_RECORD_DETAIL_PATH}/confirm`;
const GOVERNANCE_PRIVACY_SCOPES_PATH = '/governance/api/v1/privacy/scopes';
const GOVERNANCE_PRIVACY_PREFERENCES_PATH = '/governance/api/v1/privacy/preferences';
const GOVERNANCE_PRIVACY_PREFERENCE_CONFIRM_PATH =
  `${GOVERNANCE_PRIVACY_PREFERENCES_PATH}/confirm`;
const GOVERNANCE_GROUP_SUMMARY_SCOPES_PATH =
  '/governance/api/v1/group-summary/scopes';
const GOVERNANCE_GROUP_SUMMARY_POLICY_PATH =
  '/governance/api/v1/group-summary/policy';
const GOVERNANCE_GROUP_SUMMARY_POLICY_CONFIRM_PATH =
  `${GOVERNANCE_GROUP_SUMMARY_POLICY_PATH}/confirm`;
const GOVERNANCE_DISPLAY_PROFILE_SCOPES_PATH =
  '/governance/api/v1/display-profile/scopes';
const GOVERNANCE_DISPLAY_PROFILE_TARGETS_PATH =
  '/governance/api/v1/display-profile/targets';
const GOVERNANCE_DISPLAY_PROFILE_TARGET_DETAIL_PATH =
  `${GOVERNANCE_DISPLAY_PROFILE_TARGETS_PATH}/:resourceHandle`;
const GOVERNANCE_DISPLAY_PROFILE_TARGET_CONFIRM_PATH =
  `${GOVERNANCE_DISPLAY_PROFILE_TARGET_DETAIL_PATH}/confirm`;
const GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PATH =
  '/governance/api/v1/identity/platform-accounts/unlink';
const GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_CONFIRM_PATH =
  `${GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PATH}/confirm`;
const GOVERNANCE_EXPLAIN_SCOPES_PATH = '/governance/api/v1/explain/scopes';
const GOVERNANCE_EXPLAIN_TURNS_PATH = '/governance/api/v1/explain/turns';
const GOVERNANCE_EXPLAIN_TURN_DETAIL_PATH =
  `${GOVERNANCE_EXPLAIN_TURNS_PATH}/:resourceHandle`;
const GOVERNANCE_OVERVIEW_PATH = '/governance/api/v1/overview';
const GOVERNANCE_OPERATIONS_PATH = '/governance/api/v1/operations';
const GOVERNANCE_OPERATIONS_CONFIRM_PATH = `${GOVERNANCE_OPERATIONS_PATH}/confirm`;
const GOVERNANCE_OPERATIONS_RESTORE_PATH = `${GOVERNANCE_OPERATIONS_PATH}/restore`;
const GOVERNANCE_OPERATIONS_RESTORE_CONFIRM_PATH =
  `${GOVERNANCE_OPERATIONS_RESTORE_PATH}/confirm`;
const GOVERNANCE_OPERATIONS_RETENTION_PATH = `${GOVERNANCE_OPERATIONS_PATH}/retention`;
const GOVERNANCE_OPERATIONS_RETENTION_CONFIRM_PATH =
  `${GOVERNANCE_OPERATIONS_RETENTION_PATH}/confirm`;
const GOVERNANCE_ACTIVITY_MODEL_INVOCATIONS_PATH =
  '/governance/api/v1/activity/model-invocations';
const GOVERNANCE_ACTIVITY_WORKER_HEARTBEATS_PATH =
  '/governance/api/v1/activity/worker-heartbeats';
const GOVERNANCE_ACTIVITY_JOBS_PATH = '/governance/api/v1/activity/jobs';
const GOVERNANCE_ACTIVITY_JOB_ATTEMPTS_PATH = '/governance/api/v1/activity/job-attempts';
const GOVERNANCE_ACTIVITY_TOOL_CALLS_PATH = '/governance/api/v1/activity/tool-calls';
const GOVERNANCE_ACTIVITY_ACTION_DECISIONS_PATH =
  '/governance/api/v1/activity/action-decisions';
const GOVERNANCE_ACTIVITY_ACTION_EXECUTIONS_PATH =
  '/governance/api/v1/activity/action-executions';
const GOVERNANCE_ACTIVITY_EVENT_PROCESSING_FAILURES_PATH =
  '/governance/api/v1/activity/event-processing-failures';
const GOVERNANCE_ACTIVITY_AUDIT_PATH = '/governance/api/v1/activity/audit';
const GOVERNANCE_MEMORY_REVIEWS_PATH = '/governance/api/v1/memory-reviews';
const GOVERNANCE_MEMORY_REVIEW_DETAIL_PATH = `${GOVERNANCE_MEMORY_REVIEWS_PATH}/:resourceHandle`;
const GOVERNANCE_MEMORY_REVIEW_CONFIRM_PATH = `${GOVERNANCE_MEMORY_REVIEW_DETAIL_PATH}/confirm`;
const GOVERNANCE_SCOPE_DISCOVERY_PURPOSE = 'memory.maintenance.review.scopes';
const GOVERNANCE_MEMORY_REVIEW_PURPOSE = 'memory.maintenance.review';
const GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND = 'memory_maintenance_review';
const GOVERNANCE_MEMORY_SCOPE_DISCOVERY_PURPOSE = 'governance.memory.records.scopes';
const GOVERNANCE_MEMORY_RECORDS_PURPOSE = 'governance.memory.records.read';
const GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND = 'memory_record';
const GOVERNANCE_PRIVACY_SCOPE_DISCOVERY_PURPOSE =
  'governance.privacy.preferences.scopes';
const GOVERNANCE_PRIVACY_PREFERENCES_PURPOSE = 'governance.privacy.preferences.read';
const GOVERNANCE_GROUP_SUMMARY_SCOPE_DISCOVERY_PURPOSE =
  'governance.group_summary_policy.scopes';
const GOVERNANCE_GROUP_SUMMARY_POLICY_STATUS_PURPOSE =
  'governance.group_summary_policy.status.read';
const GOVERNANCE_DISPLAY_PROFILE_SCOPE_DISCOVERY_PURPOSE =
  'governance.display_profile.scopes';
const GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE =
  'governance.display_profile.targets.read';
const GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND = 'display_profile_target';
const GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE =
  'governance.identity.platform_account.unlink';
const GOVERNANCE_PLATFORM_ACCOUNT_RESOURCE_KIND = 'platform_account';
const GOVERNANCE_GROUP_SUMMARY_POLICY_RESOURCE_KIND = 'group_summary_policy';
const GOVERNANCE_GROUP_SUMMARY_POLICY_RESOURCE_ID = 'policy';
const GOVERNANCE_PRIVACY_PREFERENCE_RESOURCE_KIND = 'privacy_preference';
const GOVERNANCE_EXPLAIN_SCOPE_DISCOVERY_PURPOSE = 'governance.explain.turns.scopes';
const GOVERNANCE_EXPLAIN_TURNS_PURPOSE = 'governance.explain.turns.read';
const GOVERNANCE_EXPLAIN_TURN_RESOURCE_KIND = 'explain_turn';
const GOVERNANCE_OVERVIEW_PURPOSE = 'governance.overview.read';
const GOVERNANCE_OPERATIONS_PURPOSE = 'governance.operations.status.read';
const GOVERNANCE_OPERATIONS_BACKUP_PREVIEW_PURPOSE =
  'governance.operations.backup.preview';
const GOVERNANCE_OPERATIONS_BACKUP_CONFIRM_PURPOSE =
  'governance.operations.backup.confirm';
const GOVERNANCE_OPERATIONS_RESTORE_PREVIEW_PURPOSE =
  'governance.operations.restore.preview';
const GOVERNANCE_OPERATIONS_RESTORE_CONFIRM_PURPOSE =
  'governance.operations.restore.confirm';
const GOVERNANCE_OPERATIONS_RETENTION_PREVIEW_PURPOSE =
  'governance.operations.retention.preview';
const GOVERNANCE_OPERATIONS_RETENTION_CONFIRM_PURPOSE =
  'governance.operations.retention.confirm';
const GOVERNANCE_OPERATIONS_BACKUP_RESOURCE_KIND = 'operations_verified_backup';
const GOVERNANCE_OPERATIONS_BACKUP_RESOURCE_ID = 'verified_backup';
const GOVERNANCE_OPERATIONS_BACKUP_ACTION = 'create_verified_backup';
const GOVERNANCE_OPERATIONS_RESTORE_RESOURCE_KIND = 'operations_backup_restore';
const GOVERNANCE_OPERATIONS_RESTORE_ACTION = 'prepare_restore_handoff';
const GOVERNANCE_OPERATIONS_RETENTION_RESOURCE_KIND = 'operations_configured_retention';
const GOVERNANCE_OPERATIONS_RETENTION_RESOURCE_ID = 'configured_retention';
const GOVERNANCE_OPERATIONS_RETENTION_ACTION = 'apply_configured_retention';
const GOVERNANCE_ACTIVITY_MODEL_INVOCATIONS_PURPOSE =
  'governance.activity.model_invocations.read';
const GOVERNANCE_ACTIVITY_WORKER_HEARTBEATS_PURPOSE =
  'governance.activity.worker_heartbeats.read';
const GOVERNANCE_ACTIVITY_JOBS_PURPOSE = 'governance.activity.jobs.read';
const GOVERNANCE_ACTIVITY_JOB_ATTEMPTS_PURPOSE = 'governance.activity.job_attempts.read';
const GOVERNANCE_ACTIVITY_TOOL_CALLS_PURPOSE = 'governance.activity.tool_calls.read';
const GOVERNANCE_ACTIVITY_ACTION_DECISIONS_PURPOSE =
  'governance.activity.action_decisions.read';
const GOVERNANCE_ACTIVITY_ACTION_EXECUTIONS_PURPOSE =
  'governance.activity.action_executions.read';
const GOVERNANCE_ACTIVITY_EVENT_PROCESSING_FAILURES_PURPOSE =
  'governance.activity.event_processing_failures.read';
const GOVERNANCE_ACTIVITY_AUDIT_PURPOSE = 'governance.activity.audit.read';
const GOVERNANCE_OPAQUE_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const GOVERNANCE_REFERENCE_PATTERN = /^[0-9a-f]{16}$/u;
const GOVERNANCE_QQ_PLATFORM_ACCOUNT_ID_PATTERN = /^[1-9][0-9]{4,11}$/u;
const GOVERNANCE_HTTP_APPROVAL_REASON = 'governance_http_approval_confirmed';
const GOVERNANCE_HTTP_REJECTION_REASON = 'governance_http_rejection_confirmed';
const GOVERNANCE_HTTP_EXPIRATION_REASON = 'governance_http_expiration_confirmed';
const GOVERNANCE_HTTP_APPLICATION_REASON = 'governance_http_application_confirmed';
const GOVERNANCE_HTTP_ROLLBACK_REASON = 'governance_http_rollback_confirmed';
const GOVERNANCE_HTTP_FORGET_REASON = 'governance_http_forget_confirmed';
const GOVERNANCE_HTTP_RESTORE_REASON = 'governance_http_restore_confirmed';
const GOVERNANCE_HTTP_PRIVACY_PREFERENCE_CHANGE_REASON =
  'governance_http_privacy_preference_change_confirmed';
const GOVERNANCE_HTTP_GROUP_SUMMARY_POLICY_CHANGE_REASON =
  'governance_http_group_summary_policy_change_confirmed';

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

function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
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

    const governanceNow = (): number => Date.now();
    const governanceScopeHandles = new GovernanceScopeHandleRegistry({ now: governanceNow });
    const governanceResourceHandles = new GovernanceResourceHandleRegistry({ now: governanceNow });
    const governancePreviewHandles = new GovernancePreviewHandleRegistry({ now: governanceNow });
    const governanceQueries = new GovernanceQueryService(this.db);
    const governanceOperations = new GovernanceOperationsCoordinator({
      db: this.db,
      dbPath: this.config.dbPath,
      config: {
        onebotTransport: this.config.onebotTransport,
        onebotHttpUrl: this.config.onebotHttpUrl,
        onebotWsUrl: this.config.onebotWsUrl,
        onebotToken: this.config.onebotToken,
        onebotBotQqId: this.config.onebotBotQqId,
        lethebotHost: this.config.lethebotHost,
        lethebotPort: this.config.lethebotPort,
        lethebotHealthPath: this.config.lethebotHealthPath,
        lethebotReadinessPath: this.config.lethebotReadinessPath,
        lethebotMetricsPath: this.config.lethebotMetricsPath,
        lethebotEventPath: this.config.lethebotEventPath,
        rawEventRetentionDays: this.config.rawEventRetentionDays,
        chatMessageRetentionDays: this.config.chatMessageRetentionDays,
        auditLogRetentionDays: this.config.auditLogRetentionDays,
        disabledDeletedMemoryRetentionDays: this.config.disabledDeletedMemoryRetentionDays,
        eventProcessingFailureRetentionDays: this.config.eventProcessingFailureRetentionDays,
      },
      now: governanceNow,
    });
    this.governanceHttpServer = new GovernanceHttpServer({
      enabled: this.config.governanceEnabled,
      host: this.config.governanceHost,
      port: this.config.governancePort,
      adminToken: this.config.governanceAdminToken,
      sessionTtlMs: this.config.governanceSessionTtlMs,
      bodyLimitBytes: 4_096,
      bodyTimeoutMs: 5_000,
      now: governanceNow,
      authorizedRoutes: [{
        method: 'GET',
        path: GOVERNANCE_MEMORY_RECORDS_PATH,
        purpose: GOVERNANCE_MEMORY_RECORDS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_MEMORY_RECORD_DETAIL_PATH,
        purpose: GOVERNANCE_MEMORY_RECORDS_PURPOSE,
        mutation: false,
        resourceKind: GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: GOVERNANCE_MEMORY_RECORD_DETAIL_PATH,
        purpose: GOVERNANCE_MEMORY_RECORDS_PURPOSE,
        mutation: true,
        resourceKind: GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: GOVERNANCE_MEMORY_RECORD_CONFIRM_PATH,
        purpose: GOVERNANCE_MEMORY_RECORDS_PURPOSE,
        mutation: true,
        resourceKind: GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
      }, {
        method: 'GET',
        path: GOVERNANCE_PRIVACY_PREFERENCES_PATH,
        purpose: GOVERNANCE_PRIVACY_PREFERENCES_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_GROUP_SUMMARY_POLICY_PATH,
        purpose: GOVERNANCE_GROUP_SUMMARY_POLICY_STATUS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_DISPLAY_PROFILE_TARGETS_PATH,
        purpose: GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_DISPLAY_PROFILE_TARGET_DETAIL_PATH,
        purpose: GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE,
        mutation: false,
        resourceKind: GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: GOVERNANCE_DISPLAY_PROFILE_TARGET_DETAIL_PATH,
        purpose: GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE,
        mutation: true,
        resourceKind: GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: GOVERNANCE_DISPLAY_PROFILE_TARGET_CONFIRM_PATH,
        purpose: GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE,
        mutation: true,
        resourceKind: GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: GOVERNANCE_GROUP_SUMMARY_POLICY_PATH,
        purpose: GOVERNANCE_GROUP_SUMMARY_POLICY_STATUS_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: GOVERNANCE_GROUP_SUMMARY_POLICY_CONFIRM_PATH,
        purpose: GOVERNANCE_GROUP_SUMMARY_POLICY_STATUS_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: GOVERNANCE_PRIVACY_PREFERENCES_PATH,
        purpose: GOVERNANCE_PRIVACY_PREFERENCES_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: GOVERNANCE_PRIVACY_PREFERENCE_CONFIRM_PATH,
        purpose: GOVERNANCE_PRIVACY_PREFERENCES_PURPOSE,
        mutation: true,
      }, {
        method: 'GET',
        path: GOVERNANCE_EXPLAIN_TURNS_PATH,
        purpose: GOVERNANCE_EXPLAIN_TURNS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_EXPLAIN_TURN_DETAIL_PATH,
        purpose: GOVERNANCE_EXPLAIN_TURNS_PURPOSE,
        mutation: false,
        resourceKind: GOVERNANCE_EXPLAIN_TURN_RESOURCE_KIND,
      }, {
        method: 'GET',
        path: GOVERNANCE_MEMORY_REVIEWS_PATH,
        purpose: GOVERNANCE_MEMORY_REVIEW_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_MEMORY_REVIEW_DETAIL_PATH,
        purpose: GOVERNANCE_MEMORY_REVIEW_PURPOSE,
        mutation: false,
        resourceKind: GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: GOVERNANCE_MEMORY_REVIEW_DETAIL_PATH,
        purpose: GOVERNANCE_MEMORY_REVIEW_PURPOSE,
        mutation: true,
        resourceKind: GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND,
      }, {
        method: 'POST',
        path: GOVERNANCE_MEMORY_REVIEW_CONFIRM_PATH,
        purpose: GOVERNANCE_MEMORY_REVIEW_PURPOSE,
        mutation: true,
        resourceKind: GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND,
      }],
      authenticatedUnscopedRoutes: [{
        method: 'GET',
        path: GOVERNANCE_SCOPES_PATH,
        purpose: GOVERNANCE_SCOPE_DISCOVERY_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_MEMORY_SCOPES_PATH,
        purpose: GOVERNANCE_MEMORY_SCOPE_DISCOVERY_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_PRIVACY_SCOPES_PATH,
        purpose: GOVERNANCE_PRIVACY_SCOPE_DISCOVERY_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_GROUP_SUMMARY_SCOPES_PATH,
        purpose: GOVERNANCE_GROUP_SUMMARY_SCOPE_DISCOVERY_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_DISPLAY_PROFILE_SCOPES_PATH,
        purpose: GOVERNANCE_DISPLAY_PROFILE_SCOPE_DISCOVERY_PURPOSE,
        mutation: false,
      }, {
        method: 'POST',
        path: GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PATH,
        purpose: GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_CONFIRM_PATH,
        purpose: GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE,
        mutation: true,
      }, {
        method: 'GET',
        path: GOVERNANCE_EXPLAIN_SCOPES_PATH,
        purpose: GOVERNANCE_EXPLAIN_SCOPE_DISCOVERY_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_OVERVIEW_PATH,
        purpose: GOVERNANCE_OVERVIEW_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_OPERATIONS_PATH,
        purpose: GOVERNANCE_OPERATIONS_PURPOSE,
        mutation: false,
      }, {
        method: 'POST',
        path: GOVERNANCE_OPERATIONS_PATH,
        purpose: GOVERNANCE_OPERATIONS_BACKUP_PREVIEW_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: GOVERNANCE_OPERATIONS_CONFIRM_PATH,
        purpose: GOVERNANCE_OPERATIONS_BACKUP_CONFIRM_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: GOVERNANCE_OPERATIONS_RESTORE_PATH,
        purpose: GOVERNANCE_OPERATIONS_RESTORE_PREVIEW_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: GOVERNANCE_OPERATIONS_RESTORE_CONFIRM_PATH,
        purpose: GOVERNANCE_OPERATIONS_RESTORE_CONFIRM_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: GOVERNANCE_OPERATIONS_RETENTION_PATH,
        purpose: GOVERNANCE_OPERATIONS_RETENTION_PREVIEW_PURPOSE,
        mutation: true,
      }, {
        method: 'POST',
        path: GOVERNANCE_OPERATIONS_RETENTION_CONFIRM_PATH,
        purpose: GOVERNANCE_OPERATIONS_RETENTION_CONFIRM_PURPOSE,
        mutation: true,
      }, {
        method: 'GET',
        path: GOVERNANCE_ACTIVITY_MODEL_INVOCATIONS_PATH,
        purpose: GOVERNANCE_ACTIVITY_MODEL_INVOCATIONS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_ACTIVITY_WORKER_HEARTBEATS_PATH,
        purpose: GOVERNANCE_ACTIVITY_WORKER_HEARTBEATS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_ACTIVITY_JOBS_PATH,
        purpose: GOVERNANCE_ACTIVITY_JOBS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_ACTIVITY_JOB_ATTEMPTS_PATH,
        purpose: GOVERNANCE_ACTIVITY_JOB_ATTEMPTS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_ACTIVITY_TOOL_CALLS_PATH,
        purpose: GOVERNANCE_ACTIVITY_TOOL_CALLS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_ACTIVITY_ACTION_DECISIONS_PATH,
        purpose: GOVERNANCE_ACTIVITY_ACTION_DECISIONS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_ACTIVITY_ACTION_EXECUTIONS_PATH,
        purpose: GOVERNANCE_ACTIVITY_ACTION_EXECUTIONS_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_ACTIVITY_EVENT_PROCESSING_FAILURES_PATH,
        purpose: GOVERNANCE_ACTIVITY_EVENT_PROCESSING_FAILURES_PURPOSE,
        mutation: false,
      }, {
        method: 'GET',
        path: GOVERNANCE_ACTIVITY_AUDIT_PATH,
        purpose: GOVERNANCE_ACTIVITY_AUDIT_PURPOSE,
        mutation: false,
      }],
      scopeHandles: governanceScopeHandles,
      resourceHandles: governanceResourceHandles,
      previewHandles: governancePreviewHandles,
      handleAuthorizedRequest: async ({ actor, route, session, scope, resource, body }) => {
        if (
          route.method === 'GET'
          && route.path === GOVERNANCE_MEMORY_RECORDS_PATH
          && resource === undefined
        ) {
          return {
            status: 200,
            body: await governanceQueries.listMemoryRecordResourceHandlePage(
              scope,
              ({ scope: recordScope, memoryId }) => governanceResourceHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: GOVERNANCE_MEMORY_RECORDS_PURPOSE,
                resourceKind: GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
                resourceId: memoryId,
                scope: recordScope,
              }),
            ),
          };
        }
        if (
          route.method === 'GET'
          && route.path === GOVERNANCE_MEMORY_RECORD_DETAIL_PATH
          && resource?.kind === GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND
        ) {
          const detail = await governanceQueries.getMemoryRecordDetailForScope({
            scope,
            memoryId: resource.resourceId,
          });
          return detail
            ? { status: 200, body: detail }
            : { status: 404, body: { error: 'not_found' } };
        }
        if (
          route.method === 'POST'
          && route.path === GOVERNANCE_MEMORY_RECORD_CONFIRM_PATH
          && resource?.kind === GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          const isRestoreConfirmation = bodyKeys.length === 3
            && bodyKeys.includes('confirm')
            && bodyKeys.includes('previewHandle')
            && bodyKeys.includes('action')
            && bodyRecord?.confirm === true
            && bodyRecord.action === 'restore'
            && typeof previewHandle === 'string'
            && GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle);
          if (isRestoreConfirmation) {
            const consumed = governancePreviewHandles.consumeWithOutcome({
              sessionId: session.sessionId,
              handle: previewHandle,
              actor,
              action: MEMORY_RECORD_RESTORE_ACTION,
              resourceKind: GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
              resourceId: resource.resourceId,
              scope,
            });
            if (consumed.outcome === 'not_found_or_denied') {
              return { status: 404, body: { error: 'not_found' } };
            }
            if (consumed.outcome === 'already_consumed') {
              return { status: 409, body: { error: 'conflict' } };
            }

            const currentPreview = await governanceQueries.getMemoryRecordRestorePreviewForScope({
              scope,
              memoryId: resource.resourceId,
            });
            if (
              !currentPreview
              || scope.kind === 'tool'
              || consumed.binding.expectedState !== currentPreview.current.lifecycleState
              || consumed.binding.expectedRevisionNumber !== currentPreview.current.revisionNumber
              || consumed.binding.previewDigest !== currentPreview.previewDigest
            ) {
              return { status: 409, body: { error: 'conflict' } };
            }

            const result = this.governance.restoreMemoryAsLocalAdmin({
              memoryId: resource.resourceId,
              scope,
              expectedState: currentPreview.current.lifecycleState,
              expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
              reasonCode: GOVERNANCE_HTTP_RESTORE_REASON,
            });
            if (result.outcome !== 'restored') {
              return result.outcome === 'not_found'
                ? { status: 404, body: { error: 'not_found' } }
                : { status: 409, body: { error: 'conflict' } };
            }
            return {
              status: 200,
              body: {
                action: MEMORY_RECORD_RESTORE_ACTION,
                outcome: 'restored',
                recordRef: currentPreview.recordRef,
                scopeKind: currentPreview.scopeKind,
                current: {
                  lifecycleState: 'active',
                  revisionNumber: result.revisionNumber,
                },
                durableEffects: [...currentPreview.expected.durableEffects],
                retrievalConsequences: [...currentPreview.expected.retrievalConsequences],
                evidence: {
                  changeType: 'restore',
                  revisionNumber: result.revisionNumber,
                  auditEvent: 'memory.restore',
                },
                rollback: { ...currentPreview.rollback },
              },
            };
          }
          if (
            bodyKeys.length !== 2
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('previewHandle')
            || bodyRecord?.confirm !== true
            || typeof previewHandle !== 'string'
            || !GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: MEMORY_RECORD_FORGET_ACTION,
            resourceKind: GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview = await governanceQueries.getMemoryRecordForgetPreviewForScope({
            scope,
            memoryId: resource.resourceId,
          });
          if (
            !currentPreview
            || scope.kind === 'tool'
            || consumed.binding.expectedState !== currentPreview.current.lifecycleState
            || consumed.binding.expectedRevisionNumber !== currentPreview.current.revisionNumber
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          const result = this.governance.forgetMemoryAsLocalAdmin({
            memoryId: resource.resourceId,
            scope,
            expectedState: currentPreview.current.lifecycleState,
            expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
            reasonCode: GOVERNANCE_HTTP_FORGET_REASON,
          });
          if (result.outcome !== 'forgotten') {
            return result.outcome === 'not_found'
              ? { status: 404, body: { error: 'not_found' } }
              : { status: 409, body: { error: 'conflict' } };
          }
          return {
            status: 200,
            body: {
              action: MEMORY_RECORD_FORGET_ACTION,
              outcome: 'forgotten',
              recordRef: currentPreview.recordRef,
              scopeKind: currentPreview.scopeKind,
              current: {
                lifecycleState: 'deleted',
                revisionNumber: result.revisionNumber,
              },
              durableEffects: [...currentPreview.expected.durableEffects],
              retrievalConsequences: [...currentPreview.expected.retrievalConsequences],
              evidence: {
                changeType: 'delete',
                revisionNumber: result.revisionNumber,
                auditEvent: 'memory.delete',
              },
              rollback: { ...currentPreview.rollback },
            },
          };
        }
        if (
          route.method === 'POST'
          && route.path === GOVERNANCE_MEMORY_RECORD_DETAIL_PATH
          && resource?.kind === GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND
        ) {
          if (
            typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            && Object.keys(body).length === 1
            && (body as Record<string, unknown>).action === 'restore'
          ) {
            const preview = await governanceQueries.getMemoryRecordRestorePreviewForScope({
              scope,
              memoryId: resource.resourceId,
            });
            if (!preview) {
              return { status: 404, body: { error: 'not_found' } };
            }
            const issued = governancePreviewHandles.issue({
              sessionId: session.sessionId,
              sessionExpiresAt: session.expiresAt,
              actor,
              action: MEMORY_RECORD_RESTORE_ACTION,
              resourceKind: GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
              resourceId: resource.resourceId,
              scope,
              expectedState: preview.current.lifecycleState,
              expectedRevisionNumber: preview.current.revisionNumber,
              previewDigest: preview.previewDigest,
            });
            return {
              status: 201,
              body: {
                ...preview,
                previewHandle: issued.handle,
                previewExpiresAt: issued.expiresAt,
              },
            };
          }
          if (
            typeof body !== 'object'
            || body === null
            || Array.isArray(body)
            || Object.keys(body).length !== 1
            || (body as Record<string, unknown>).action !== 'forget'
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview = await governanceQueries.getMemoryRecordForgetPreviewForScope({
            scope,
            memoryId: resource.resourceId,
          });
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: MEMORY_RECORD_FORGET_ACTION,
            resourceKind: GOVERNANCE_MEMORY_RECORD_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
            expectedState: preview.current.lifecycleState,
            expectedRevisionNumber: preview.current.revisionNumber,
            previewDigest: preview.previewDigest,
          });
          return {
            status: 201,
            body: {
              ...preview,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        if (
          route.method === 'POST'
          && route.path === GOVERNANCE_PRIVACY_PREFERENCE_CONFIRM_PATH
          && resource === undefined
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          const preferenceType = bodyRecord?.preferenceType;
          const targetState = bodyRecord?.targetState;
          if (
            bodyKeys.length !== 4
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('previewHandle')
            || !bodyKeys.includes('preferenceType')
            || !bodyKeys.includes('targetState')
            || bodyRecord?.confirm !== true
            || typeof previewHandle !== 'string'
            || !GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
            || (preferenceType !== 'proactive_dm'
              && preferenceType !== 'memory_association')
            || (targetState !== 'opted_in' && targetState !== 'opted_out')
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          if (scope.kind !== 'user') {
            return { status: 404, body: { error: 'not_found' } };
          }

          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: PRIVACY_PREFERENCE_CHANGE_ACTION,
            resourceKind: GOVERNANCE_PRIVACY_PREFERENCE_RESOURCE_KIND,
            resourceId: preferenceType,
            scope,
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview =
            await governanceQueries.getPrivacyPreferenceChangePreviewForScope({
              scope,
              preferenceType,
              targetState,
            });
          if (
            !currentPreview
            || consumed.binding.expectedState !== currentPreview.current.state
            || consumed.binding.expectedRevisionNumber
              !== Math.max(1, currentPreview.current.version.updatedAt ?? 1)
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          const result = this.governance.setPrivacyPreferenceAsLocalAdmin({
            canonicalUserId: scope.canonicalUserId,
            preferenceType: currentPreview.preferenceType,
            state: currentPreview.expected.state,
            expectedState: currentPreview.current.state,
            expectedVersion: currentPreview.current.version,
            reasonCode: GOVERNANCE_HTTP_PRIVACY_PREFERENCE_CHANGE_REASON,
          });
          if (result.outcome !== 'updated') {
            return result.outcome === 'not_found'
              ? { status: 404, body: { error: 'not_found' } }
              : { status: 409, body: { error: 'conflict' } };
          }
          return {
            status: 200,
            body: {
              action: PRIVACY_PREFERENCE_CHANGE_ACTION,
              outcome: 'updated',
              preferenceType: currentPreview.preferenceType,
              current: {
                state: currentPreview.expected.state,
                version: {
                  source: 'stored_preference',
                  updatedAt: result.updatedAt,
                },
              },
              durableEffects: [...currentPreview.expected.durableEffects],
              enforcementConsequences: [
                ...currentPreview.expected.enforcementConsequences,
              ],
              evidence: {
                auditEvent: 'privacy.preference_set',
                updatedAt: result.updatedAt,
              },
              rollback: { ...currentPreview.rollback },
            },
          };
        }
        if (
          route.method === 'POST'
          && route.path === GOVERNANCE_PRIVACY_PREFERENCES_PATH
          && resource === undefined
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const preferenceType = bodyRecord?.preferenceType;
          const targetState = bodyRecord?.targetState;
          if (
            bodyKeys.length !== 3
            || !bodyKeys.includes('action')
            || !bodyKeys.includes('preferenceType')
            || !bodyKeys.includes('targetState')
            || bodyRecord?.action !== 'change'
            || (preferenceType !== 'proactive_dm'
              && preferenceType !== 'memory_association')
            || (targetState !== 'opted_in' && targetState !== 'opted_out')
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview = await governanceQueries.getPrivacyPreferenceChangePreviewForScope({
            scope,
            preferenceType,
            targetState,
          });
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: PRIVACY_PREFERENCE_CHANGE_ACTION,
            resourceKind: GOVERNANCE_PRIVACY_PREFERENCE_RESOURCE_KIND,
            resourceId: preview.preferenceType,
            scope,
            expectedState: preview.current.state,
            expectedRevisionNumber: Math.max(1, preview.current.version.updatedAt ?? 1),
            previewDigest: preview.previewDigest,
          });
          return {
            status: 201,
            body: {
              ...preview,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        if (
          route.method === 'GET'
          && route.path === GOVERNANCE_PRIVACY_PREFERENCES_PATH
          && resource === undefined
        ) {
          return {
            status: 200,
            body: await governanceQueries.listPrivacyPreferencesForScope(scope),
          };
        }
        if (
          route.method === 'POST'
          && route.path === GOVERNANCE_GROUP_SUMMARY_POLICY_CONFIRM_PATH
          && resource === undefined
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          const targetState = bodyRecord?.targetState;
          if (
            bodyKeys.length !== 3
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('previewHandle')
            || !bodyKeys.includes('targetState')
            || bodyRecord?.confirm !== true
            || typeof previewHandle !== 'string'
            || !GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
            || (targetState !== 'enabled' && targetState !== 'disabled')
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          if (scope.kind !== 'group') {
            return { status: 404, body: { error: 'not_found' } };
          }

          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: GROUP_SUMMARY_POLICY_CHANGE_ACTION,
            resourceKind: GOVERNANCE_GROUP_SUMMARY_POLICY_RESOURCE_KIND,
            resourceId: GOVERNANCE_GROUP_SUMMARY_POLICY_RESOURCE_ID,
            scope,
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview =
            await governanceQueries.getGroupSummaryPolicyChangePreviewForScope({
              scope,
              targetState,
            });
          if (
            !currentPreview
            || consumed.binding.expectedState !== currentPreview.current.state
            || consumed.binding.expectedRevisionNumber
              !== (currentPreview.current.version.generation ?? 1)
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          let expectedVersion: GroupSummaryPolicyExpectedVersion;
          if (currentPreview.current.stored) {
            const { generation, updatedAt } = currentPreview.current.version;
            if (generation === null || updatedAt === null) {
              return { status: 409, body: { error: 'conflict' } };
            }
            expectedVersion = {
              source: 'stored_policy',
              generation,
              updatedAt: updatedAt.getTime(),
            };
          } else {
            expectedVersion = {
              source: 'implicit_default',
              generation: null,
              updatedAt: null,
            };
          }
          const result = this.governance.setGroupSummaryPolicyAsLocalAdmin({
            groupId: scope.groupId,
            enabled: currentPreview.expected.state === 'enabled',
            expectedState: currentPreview.current.state,
            expectedVersion,
            reasonCode: GOVERNANCE_HTTP_GROUP_SUMMARY_POLICY_CHANGE_REASON,
          });
          if (result.outcome !== 'updated') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const updatedAt = new Date(result.updatedAt);
          return {
            status: 200,
            body: {
              action: GROUP_SUMMARY_POLICY_CHANGE_ACTION,
              outcome: 'updated',
              current: {
                state: result.state,
                stored: true,
                version: {
                  generation: result.generation,
                  updatedAt,
                },
                eligibleAfter: result.eligibleAfter === null
                  ? null
                  : new Date(result.eligibleAfter),
              },
              durableEffects: [...currentPreview.expected.durableEffects],
              enforcementConsequences: [
                ...currentPreview.expected.enforcementConsequences,
              ],
              evidence: {
                auditEvent: 'group.summary_policy_changed',
                generation: result.generation,
                updatedAt,
                canceledJobCount: result.canceledJobCount,
              },
              rollback: { ...currentPreview.rollback },
            },
          };
        }
        if (
          route.method === 'POST'
          && route.path === GOVERNANCE_GROUP_SUMMARY_POLICY_PATH
          && resource === undefined
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const targetState = bodyRecord?.targetState;
          if (
            bodyKeys.length !== 2
            || !bodyKeys.includes('action')
            || !bodyKeys.includes('targetState')
            || bodyRecord?.action !== 'change'
            || (targetState !== 'enabled' && targetState !== 'disabled')
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview = await governanceQueries.getGroupSummaryPolicyChangePreviewForScope({
            scope,
            targetState,
          });
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: GROUP_SUMMARY_POLICY_CHANGE_ACTION,
            resourceKind: GOVERNANCE_GROUP_SUMMARY_POLICY_RESOURCE_KIND,
            resourceId: GOVERNANCE_GROUP_SUMMARY_POLICY_RESOURCE_ID,
            scope,
            expectedState: preview.current.state,
            expectedRevisionNumber: preview.current.version.generation ?? 1,
            previewDigest: preview.previewDigest,
          });
          return {
            status: 201,
            body: {
              ...preview,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        if (
          route.method === 'GET'
          && route.path === GOVERNANCE_GROUP_SUMMARY_POLICY_PATH
          && resource === undefined
        ) {
          const policy = await governanceQueries.getGroupSummaryPolicyForScope(scope);
          return policy
            ? { status: 200, body: policy }
            : { status: 404, body: { error: 'not_found' } };
        }
        if (
          route.method === 'GET'
          && route.path === GOVERNANCE_DISPLAY_PROFILE_TARGETS_PATH
          && resource === undefined
        ) {
          return {
            status: 200,
            body: await governanceQueries.listDisplayProfileTargetResourceHandlePage(
              scope,
              ({ scope: targetScope, targetId }) => governanceResourceHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE,
                resourceKind: GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND,
                resourceId: targetId,
                scope: targetScope,
              }),
            ),
          };
        }
        if (
          route.method === 'GET'
          && route.path === GOVERNANCE_DISPLAY_PROFILE_TARGET_DETAIL_PATH
          && resource?.kind === GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND
        ) {
          const detail = await governanceQueries.getDisplayProfileTargetDetailForScope({
            scope,
            targetId: resource.resourceId,
          });
          return detail
            ? { status: 200, body: detail }
            : { status: 404, body: { error: 'not_found' } };
        }
        if (
          route.method === 'POST'
          && route.path === GOVERNANCE_DISPLAY_PROFILE_TARGET_CONFIRM_PATH
          && resource?.kind === GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          if (
            bodyKeys.length !== 2
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('previewHandle')
            || bodyRecord?.confirm !== true
            || typeof previewHandle !== 'string'
            || !GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: DISPLAY_PROFILE_REDACTION_ACTION,
            resourceKind: GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview =
            await governanceQueries.getDisplayProfileTargetRedactionPreviewForScope({
              scope,
              targetId: resource.resourceId,
            });
          if (
            !currentPreview
            || consumed.binding.expectedState
              !== currentPreview.current.snapshotFingerprint
            || consumed.binding.expectedRevisionNumber
              !== currentPreview.expected.affectedRows.total
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }
          const selection =
            await governanceQueries.resolveDisplayProfileTargetRedactionMutationForScope({
              scope,
              targetId: resource.resourceId,
            });
          if (!selection) {
            return { status: 409, body: { error: 'conflict' } };
          }
          const result = this.governance.redactDisplayProfileAsLocalAdmin({
            canonicalUserId: selection.canonicalUserId,
            ...(selection.groupId === null ? {} : { groupId: selection.groupId }),
            targetId: selection.targetId,
            expectedSnapshot: currentPreview.current,
            reasonCode: DISPLAY_PROFILE_REDACTION_REASON_CODE,
          });
          if (result.outcome !== 'redacted') {
            return result.outcome === 'not_found'
              ? { status: 404, body: { error: 'not_found' } }
              : { status: 409, body: { error: 'conflict' } };
          }
          return {
            status: 200,
            body: {
              action: DISPLAY_PROFILE_REDACTION_ACTION,
              outcome: 'redacted',
              target: currentPreview.target,
              affectedRows: {
                displayProfiles: result.displayProfilesUpdated,
                nicknameHistory: result.nicknameHistoryUpdated,
                total: result.displayProfilesUpdated + result.nicknameHistoryUpdated,
              },
              openNicknameHistoryRowsClosed: result.openNicknameHistoryRowsClosed,
              redactedAt: new Date(result.redactedAt),
              durableEffects: [...currentPreview.expected.durableEffects],
              privacyConsequences: [...currentPreview.expected.privacyConsequences],
              evidence: {
                auditEvent: 'display_profile.redact',
                reasonCode: DISPLAY_PROFILE_REDACTION_REASON_CODE,
              },
              rollback: { ...currentPreview.rollback },
            },
          };
        }
        if (
          route.method === 'POST'
          && route.path === GOVERNANCE_DISPLAY_PROFILE_TARGET_DETAIL_PATH
          && resource?.kind === GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND
        ) {
          if (
            typeof body !== 'object'
            || body === null
            || Array.isArray(body)
            || Object.keys(body).length !== 1
            || (body as Record<string, unknown>).action !== 'redact'
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview =
            await governanceQueries.getDisplayProfileTargetRedactionPreviewForScope({
              scope,
              targetId: resource.resourceId,
            });
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: DISPLAY_PROFILE_REDACTION_ACTION,
            resourceKind: GOVERNANCE_DISPLAY_PROFILE_TARGET_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
            expectedState: preview.current.snapshotFingerprint,
            expectedRevisionNumber: preview.expected.affectedRows.total,
            previewDigest: preview.previewDigest,
          });
          return {
            status: 201,
            body: {
              ...preview,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        if (
          route.method === 'GET'
          && route.path === GOVERNANCE_EXPLAIN_TURNS_PATH
          && resource === undefined
        ) {
          return {
            status: 200,
            body: await governanceQueries.listExplainTurnResourceHandlePage(
              scope,
              ({ scope: turnScope, turnId }) => governanceResourceHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: GOVERNANCE_EXPLAIN_TURNS_PURPOSE,
                resourceKind: GOVERNANCE_EXPLAIN_TURN_RESOURCE_KIND,
                resourceId: turnId,
                scope: turnScope,
              }),
            ),
          };
        }
        if (
          route.method === 'GET'
          && route.path === GOVERNANCE_EXPLAIN_TURN_DETAIL_PATH
          && resource?.kind === GOVERNANCE_EXPLAIN_TURN_RESOURCE_KIND
        ) {
          const detail = await governanceQueries.getExplainTurnDetailForScope({
            scope,
            turnId: resource.resourceId,
          });
          return detail
            ? { status: 200, body: detail }
            : { status: 404, body: { error: 'not_found' } };
        }
        if (route.path === GOVERNANCE_MEMORY_REVIEWS_PATH && resource === undefined) {
          return {
            status: 200,
            body: await governanceQueries.listMemoryMaintenanceReviewResourceHandlePage(
              { scope },
              ({ scope: proposalScope, proposalId }) => governanceResourceHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: GOVERNANCE_MEMORY_REVIEW_PURPOSE,
                resourceKind: GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND,
                resourceId: proposalId,
                scope: proposalScope,
              }),
            ),
          };
        }
        if (
          route.method === 'GET'
          && route.path === GOVERNANCE_MEMORY_REVIEW_DETAIL_PATH
          && resource?.kind === GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND
        ) {
          const detail = await governanceQueries.getMemoryMaintenanceReview({
            scope,
            proposalId: resource.resourceId,
          });
          return detail
            ? { status: 200, body: detail }
            : { status: 404, body: { error: 'not_found' } };
        }
        if (
          route.method === 'POST'
          && route.path === GOVERNANCE_MEMORY_REVIEW_CONFIRM_PATH
          && resource?.kind === GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          if (!bodyRecord) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const bodyKeys = Object.keys(bodyRecord);
          const hasExactKeys = (keys: readonly string[]): boolean =>
            bodyKeys.length === keys.length && keys.every((key) => bodyKeys.includes(key));
          const previewHandle = bodyRecord.previewHandle;
          const retainedMemoryRef = bodyRecord.retainedMemoryRef;
          const isApprovalConfirmation = hasExactKeys(['confirm', 'previewHandle']);
          const isRejectionConfirmation = bodyRecord.action === 'reject'
            && hasExactKeys(['confirm', 'previewHandle', 'action']);
          const isExpirationConfirmation = bodyRecord.action === 'expire'
            && hasExactKeys(['confirm', 'previewHandle', 'action']);
          const isApplicationConfirmation = bodyRecord.action === 'apply'
            && hasExactKeys(['confirm', 'previewHandle', 'action']);
          const isSelectedApplicationConfirmation = bodyRecord.action === 'apply'
            && hasExactKeys(['confirm', 'previewHandle', 'action', 'retainedMemoryRef'])
            && typeof retainedMemoryRef === 'string'
            && GOVERNANCE_REFERENCE_PATTERN.test(retainedMemoryRef);
          const isRollbackConfirmation = bodyRecord.action === 'rollback'
            && hasExactKeys(['confirm', 'previewHandle', 'action']);
          if (
            bodyRecord.confirm !== true
            || typeof previewHandle !== 'string'
            || !GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
            || (
              !isApprovalConfirmation
              && !isRejectionConfirmation
              && !isExpirationConfirmation
              && !isApplicationConfirmation
              && !isSelectedApplicationConfirmation
              && !isRollbackConfirmation
            )
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const requestedAction = isApprovalConfirmation
            ? MEMORY_MAINTENANCE_APPROVAL_ACTION
            : isRejectionConfirmation
              ? MEMORY_MAINTENANCE_REJECTION_ACTION
              : isExpirationConfirmation
                ? MEMORY_MAINTENANCE_EXPIRATION_ACTION
                : isRollbackConfirmation
                  ? MEMORY_MAINTENANCE_ROLLBACK_ACTION
                  : MEMORY_MAINTENANCE_APPLICATION_ACTION;
          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: requestedAction,
            resourceKind: GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          let currentApplication: ResolvedMemoryMaintenanceApplication | null = null;
          if (requestedAction === MEMORY_MAINTENANCE_APPLICATION_ACTION) {
            currentApplication = await governanceQueries.resolveMemoryMaintenanceApplication({
              scope,
              proposalId: resource.resourceId,
              ...(isSelectedApplicationConfirmation
                ? { retainedMemoryRef: retainedMemoryRef as string }
              : {}),
            });
          }
          const currentRollback = requestedAction === MEMORY_MAINTENANCE_ROLLBACK_ACTION
            ? await governanceQueries.getMemoryMaintenanceRollbackPreview({
              scope,
              proposalId: resource.resourceId,
            })
            : null;
          const currentPreview = requestedAction === MEMORY_MAINTENANCE_APPROVAL_ACTION
            ? await governanceQueries.getMemoryMaintenanceApprovalPreview({
              scope,
              proposalId: resource.resourceId,
            })
            : requestedAction === MEMORY_MAINTENANCE_REJECTION_ACTION
              ? await governanceQueries.getMemoryMaintenanceRejectionPreview({
                scope,
                proposalId: resource.resourceId,
              })
              : requestedAction === MEMORY_MAINTENANCE_EXPIRATION_ACTION
                ? await governanceQueries.getMemoryMaintenanceExpirationPreview({
                  scope,
                  proposalId: resource.resourceId,
                })
                : requestedAction === MEMORY_MAINTENANCE_ROLLBACK_ACTION
                  ? currentRollback
                  : currentApplication?.preview ?? null;
          if (
            !currentPreview
            || consumed.binding.expectedState !== currentPreview.current.lifecycleState
            || consumed.binding.expectedRevisionNumber !== currentPreview.current.revisionNumber
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          if (requestedAction === MEMORY_MAINTENANCE_APPLICATION_ACTION) {
            if (!currentApplication) {
              return { status: 409, body: { error: 'conflict' } };
            }
            const application = this.governance.applyMemoryMaintenanceProposal({
              authority: { kind: 'local_admin' },
              proposalId: resource.resourceId,
              expectedState: 'approved',
              expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
              reasonCode: GOVERNANCE_HTTP_APPLICATION_REASON,
              ...(currentApplication.retainedMemoryId === undefined
                ? {}
                : { retainedMemoryId: currentApplication.retainedMemoryId }),
            });
            if (application.outcome === 'not_found_or_denied') {
              return { status: 404, body: { error: 'not_found' } };
            }
            if (application.outcome !== 'transitioned') {
              return { status: 409, body: { error: 'conflict' } };
            }
            const confirmation =
              governanceQueries.projectMemoryMaintenanceApplicationConfirmation({
                scope,
                proposal: application.proposal,
                expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
                operation: currentApplication,
              });
            return confirmation
              ? { status: 200, body: confirmation }
              : { status: 503, body: { error: 'unavailable' } };
          }

          if (requestedAction === MEMORY_MAINTENANCE_ROLLBACK_ACTION) {
            if (!currentRollback) {
              return { status: 409, body: { error: 'conflict' } };
            }
            const rollback = this.governance.rollbackMemoryMaintenanceProposal({
              authority: { kind: 'local_admin' },
              proposalId: resource.resourceId,
              expectedState: 'applied',
              expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
              reasonCode: GOVERNANCE_HTTP_ROLLBACK_REASON,
            });
            if (rollback.outcome === 'not_found_or_denied') {
              return { status: 404, body: { error: 'not_found' } };
            }
            if (rollback.outcome !== 'transitioned') {
              return { status: 409, body: { error: 'conflict' } };
            }
            const confirmation =
              governanceQueries.projectMemoryMaintenanceRollbackConfirmation({
                scope,
                proposal: rollback.proposal,
                expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
                preview: currentRollback,
              });
            return confirmation
              ? { status: 200, body: confirmation }
              : { status: 503, body: { error: 'unavailable' } };
          }

          const review = this.governance.reviewMemoryMaintenanceProposal({
            authority: { kind: 'local_admin' },
            proposalId: resource.resourceId,
            expectedState: 'pending_review',
            expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
            transition: requestedAction === MEMORY_MAINTENANCE_APPROVAL_ACTION
              ? 'approve'
              : requestedAction === MEMORY_MAINTENANCE_EXPIRATION_ACTION
                ? 'expire'
                : 'reject',
            reasonCode: requestedAction === MEMORY_MAINTENANCE_APPROVAL_ACTION
              ? GOVERNANCE_HTTP_APPROVAL_REASON
              : requestedAction === MEMORY_MAINTENANCE_EXPIRATION_ACTION
                ? GOVERNANCE_HTTP_EXPIRATION_REASON
                : GOVERNANCE_HTTP_REJECTION_REASON,
          });
          if (review.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (review.outcome !== 'transitioned') {
            return { status: 409, body: { error: 'conflict' } };
          }
          const confirmation = requestedAction === MEMORY_MAINTENANCE_APPROVAL_ACTION
            ? governanceQueries.projectMemoryMaintenanceApprovalConfirmation({
              scope,
              proposal: review.proposal,
              expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
            })
            : requestedAction === MEMORY_MAINTENANCE_EXPIRATION_ACTION
              ? governanceQueries.projectMemoryMaintenanceExpirationConfirmation({
                scope,
                proposal: review.proposal,
                expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
              })
              : governanceQueries.projectMemoryMaintenanceRejectionConfirmation({
                scope,
                proposal: review.proposal,
                expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
              });
          return confirmation
            ? { status: 200, body: confirmation }
            : { status: 503, body: { error: 'unavailable' } };
        }
        if (
          route.method === 'POST'
          && route.path === GOVERNANCE_MEMORY_REVIEW_DETAIL_PATH
          && resource?.kind === GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND
        ) {
          if (
            typeof body !== 'object'
            || body === null
            || Array.isArray(body)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const bodyRecord = body as Record<string, unknown>;
          const bodyKeys = Object.keys(bodyRecord);
          const requestedAction = bodyRecord.action;
          const retainedMemoryRef = bodyRecord.retainedMemoryRef;
          const isApprovalRequest = bodyKeys.length === 1
            && bodyKeys[0] === 'action'
            && requestedAction === 'approve';
          const isRejectionRequest = bodyKeys.length === 1
            && bodyKeys[0] === 'action'
            && requestedAction === 'reject';
          const isExpirationRequest = bodyKeys.length === 1
            && bodyKeys[0] === 'action'
            && requestedAction === 'expire';
          const isApplicationWithoutSelection = bodyKeys.length === 1
            && bodyKeys[0] === 'action'
            && requestedAction === 'apply';
          const isApplicationWithSelection = bodyKeys.length === 2
            && bodyKeys.includes('action')
            && bodyKeys.includes('retainedMemoryRef')
            && requestedAction === 'apply'
            && typeof retainedMemoryRef === 'string'
            && GOVERNANCE_REFERENCE_PATTERN.test(retainedMemoryRef);
          const isRollbackRequest = bodyKeys.length === 1
            && bodyKeys[0] === 'action'
            && requestedAction === 'rollback';
          if (
            !isApprovalRequest
            && !isRejectionRequest
            && !isExpirationRequest
            && !isApplicationWithoutSelection
            && !isApplicationWithSelection
            && !isRollbackRequest
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview = isApprovalRequest
            ? await governanceQueries.getMemoryMaintenanceApprovalPreview({
              scope,
              proposalId: resource.resourceId,
            })
            : isRejectionRequest
              ? await governanceQueries.getMemoryMaintenanceRejectionPreview({
                scope,
                proposalId: resource.resourceId,
              })
              : isExpirationRequest
                ? await governanceQueries.getMemoryMaintenanceExpirationPreview({
                  scope,
                  proposalId: resource.resourceId,
                })
                : isRollbackRequest
                  ? await governanceQueries.getMemoryMaintenanceRollbackPreview({
                    scope,
                    proposalId: resource.resourceId,
                  })
                  : await governanceQueries.getMemoryMaintenanceApplicationPreview({
                    scope,
                    proposalId: resource.resourceId,
                    ...(isApplicationWithSelection
                      ? { retainedMemoryRef: retainedMemoryRef as string }
                      : {}),
                  });
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: isApprovalRequest
              ? MEMORY_MAINTENANCE_APPROVAL_ACTION
              : isRejectionRequest
                ? MEMORY_MAINTENANCE_REJECTION_ACTION
                : isExpirationRequest
                  ? MEMORY_MAINTENANCE_EXPIRATION_ACTION
                  : isRollbackRequest
                    ? MEMORY_MAINTENANCE_ROLLBACK_ACTION
                    : MEMORY_MAINTENANCE_APPLICATION_ACTION,
            resourceKind: GOVERNANCE_MEMORY_REVIEW_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
            expectedState: preview.current.lifecycleState,
            expectedRevisionNumber: preview.current.revisionNumber,
            previewDigest: preview.previewDigest,
          });
          return {
            status: 201,
            body: {
              ...preview,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        return { status: 404, body: { error: 'not_found' } };
      },
      handleAuthenticatedUnscopedRequest: async ({ actor, route, session, body }) => {
        if (route.purpose === GOVERNANCE_SCOPE_DISCOVERY_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listMemoryMaintenanceReviewScopeHandles((scope) => (
              governanceScopeHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: GOVERNANCE_MEMORY_REVIEW_PURPOSE,
                scope,
              })
            )),
          };
        }
        if (route.purpose === GOVERNANCE_MEMORY_SCOPE_DISCOVERY_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listMemoryRecordScopeHandles((scope) => (
              governanceScopeHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: GOVERNANCE_MEMORY_RECORDS_PURPOSE,
                scope,
              })
            )),
          };
        }
        if (route.purpose === GOVERNANCE_PRIVACY_SCOPE_DISCOVERY_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listPrivacyPreferenceScopeHandles((scope) => (
              governanceScopeHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: GOVERNANCE_PRIVACY_PREFERENCES_PURPOSE,
                scope,
              })
            )),
          };
        }
        if (route.purpose === GOVERNANCE_GROUP_SUMMARY_SCOPE_DISCOVERY_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listGroupSummaryPolicyScopeHandles((scope) => (
              governanceScopeHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: GOVERNANCE_GROUP_SUMMARY_POLICY_STATUS_PURPOSE,
                scope,
              })
            )),
          };
        }
        if (route.purpose === GOVERNANCE_DISPLAY_PROFILE_SCOPE_DISCOVERY_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listDisplayProfileScopeHandles((scope) => (
              governanceScopeHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: GOVERNANCE_DISPLAY_PROFILE_TARGETS_PURPOSE,
                scope,
              })
            )),
          };
        }
        if (
          route.path === GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_CONFIRM_PATH
          && route.purpose === GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const resourceHandle = bodyRecord?.resourceHandle;
          const previewHandle = bodyRecord?.previewHandle;
          if (
            bodyKeys.length !== 3
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('resourceHandle')
            || !bodyKeys.includes('previewHandle')
            || bodyRecord?.confirm !== true
            || typeof resourceHandle !== 'string'
            || !GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(resourceHandle)
            || typeof previewHandle !== 'string'
            || !GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }

          const scope = { kind: 'system' as const };
          const resource = governanceResourceHandles.resolve({
            sessionId: session.sessionId,
            handle: resourceHandle,
            purpose: GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE,
            resourceKind: GOVERNANCE_PLATFORM_ACCOUNT_RESOURCE_KIND,
            scope,
          });
          if (!resource || resource.kind !== GOVERNANCE_PLATFORM_ACCOUNT_RESOURCE_KIND) {
            return { status: 404, body: { error: 'not_found' } };
          }

          let selectorValue: unknown;
          try {
            selectorValue = JSON.parse(resource.resourceId);
          } catch {
            return { status: 404, body: { error: 'not_found' } };
          }
          const selector = typeof selectorValue === 'object'
            && selectorValue !== null
            && !Array.isArray(selectorValue)
            ? selectorValue as Record<string, unknown>
            : null;
          const selectorKeys = selector ? Object.keys(selector) : [];
          const platformAccountId = selector?.platformAccountId;
          if (
            selectorKeys.length !== 2
            || !selectorKeys.includes('platform')
            || !selectorKeys.includes('platformAccountId')
            || selector?.platform !== 'qq'
            || typeof platformAccountId !== 'string'
            || !GOVERNANCE_QQ_PLATFORM_ACCOUNT_ID_PATTERN.test(platformAccountId)
            || resource.resourceId !== JSON.stringify({
              platform: 'qq',
              platformAccountId,
            })
          ) {
            return { status: 404, body: { error: 'not_found' } };
          }

          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: PLATFORM_ACCOUNT_UNLINK_ACTION,
            resourceKind: GOVERNANCE_PLATFORM_ACCOUNT_RESOURCE_KIND,
            resourceId: resource.resourceId,
            scope,
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview = await governanceQueries.getPlatformAccountUnlinkPreview({
            platform: 'qq',
            platformAccountId,
          });
          if (
            !currentPreview
            || consumed.binding.expectedState
              !== currentPreview.current.snapshotFingerprint
            || consumed.binding.expectedRevisionNumber !== 1
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          const result = this.governance.unlinkPlatformAccountAsLocalAdmin({
            platform: 'qq',
            platformAccountId,
            expectedSnapshot: currentPreview.current,
            reasonCode: PLATFORM_ACCOUNT_UNLINK_REASON_CODE,
          });
          if (result.outcome !== 'unlinked') {
            return { status: 409, body: { error: 'conflict' } };
          }
          return {
            status: 200,
            body: {
              action: PLATFORM_ACCOUNT_UNLINK_ACTION,
              outcome: 'unlinked',
              account: {
                ...currentPreview.account,
                status: 'disabled',
              },
              affectedRows: { platformAccounts: 1 },
              disabledAt: new Date(result.disabledAt),
              durableEffects: [...currentPreview.expected.durableEffects],
              identityConsequences: [...currentPreview.expected.identityConsequences],
              privacyConsequences: [...currentPreview.expected.privacyConsequences],
              evidence: {
                auditEvent: 'identity.platform_account.unlinked',
                reasonCode: PLATFORM_ACCOUNT_UNLINK_REASON_CODE,
              },
              rollback: { ...currentPreview.rollback },
            },
          };
        }
        if (
          route.path === GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PATH
          && route.purpose === GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE
        ) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const platformAccountId = bodyRecord?.platformAccountId;
          if (
            bodyKeys.length !== 3
            || !bodyKeys.includes('action')
            || !bodyKeys.includes('platform')
            || !bodyKeys.includes('platformAccountId')
            || bodyRecord?.action !== 'unlink'
            || bodyRecord.platform !== 'qq'
            || typeof platformAccountId !== 'string'
            || !GOVERNANCE_QQ_PLATFORM_ACCOUNT_ID_PATTERN.test(platformAccountId)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }

          const preview = await governanceQueries.getPlatformAccountUnlinkPreview({
            platform: 'qq',
            platformAccountId,
          });
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const scope = { kind: 'system' as const };
          const resourceId = JSON.stringify({
            platform: 'qq',
            platformAccountId,
          });
          const resource = governanceResourceHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            purpose: GOVERNANCE_PLATFORM_ACCOUNT_UNLINK_PURPOSE,
            resourceKind: GOVERNANCE_PLATFORM_ACCOUNT_RESOURCE_KIND,
            resourceId,
            scope,
          });
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: PLATFORM_ACCOUNT_UNLINK_ACTION,
            resourceKind: GOVERNANCE_PLATFORM_ACCOUNT_RESOURCE_KIND,
            resourceId,
            scope,
            expectedState: preview.current.snapshotFingerprint,
            expectedRevisionNumber: 1,
            previewDigest: preview.previewDigest,
          });
          return {
            status: 201,
            body: {
              ...preview,
              resourceHandle: resource.handle,
              resourceExpiresAt: resource.expiresAt,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        if (route.purpose === GOVERNANCE_EXPLAIN_SCOPE_DISCOVERY_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listExplainConversationScopeHandles((scope) => (
              governanceScopeHandles.issue({
                sessionId: session.sessionId,
                sessionExpiresAt: session.expiresAt,
                purpose: GOVERNANCE_EXPLAIN_TURNS_PURPOSE,
                scope,
              })
            )),
          };
        }
        if (route.purpose === GOVERNANCE_OVERVIEW_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.summarizeGovernanceHealth(),
          };
        }
        if (route.purpose === GOVERNANCE_OPERATIONS_PURPOSE) {
          return {
            status: 200,
            body: governanceOperations.inspect(),
          };
        }
        if (route.purpose === GOVERNANCE_OPERATIONS_BACKUP_PREVIEW_PURPOSE) {
          if (
            typeof body !== 'object'
            || body === null
            || Array.isArray(body)
            || Object.keys(body).length !== 1
            || (body as Record<string, unknown>).action
              !== GOVERNANCE_OPERATIONS_BACKUP_ACTION
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview = governanceOperations.previewVerifiedBackup();
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: preview.action,
            resourceKind: GOVERNANCE_OPERATIONS_BACKUP_RESOURCE_KIND,
            resourceId: GOVERNANCE_OPERATIONS_BACKUP_RESOURCE_ID,
            scope: { kind: 'system' },
            expectedState: preview.currentState,
            expectedRevisionNumber: preview.contractVersion,
            previewDigest: preview.previewDigest,
          });
          return {
            status: 201,
            body: {
              ...preview,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        if (route.purpose === GOVERNANCE_OPERATIONS_RETENTION_PREVIEW_PURPOSE) {
          if (
            typeof body !== 'object'
            || body === null
            || Array.isArray(body)
            || Object.keys(body).length !== 1
            || (body as Record<string, unknown>).action
              !== GOVERNANCE_OPERATIONS_RETENTION_ACTION
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }
          const preview = governanceOperations.previewConfiguredRetention();
          const expectedAtMs = Date.parse(preview.asOf);
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: preview.action,
            resourceKind: GOVERNANCE_OPERATIONS_RETENTION_RESOURCE_KIND,
            resourceId: GOVERNANCE_OPERATIONS_RETENTION_RESOURCE_ID,
            scope: { kind: 'system' },
            expectedState: preview.currentState,
            expectedRevisionNumber: preview.contractVersion,
            previewDigest: preview.previewDigest,
            expectedAtMs,
          });
          return {
            status: 201,
            body: {
              ...preview,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        if (route.purpose === GOVERNANCE_OPERATIONS_RETENTION_CONFIRM_PURPOSE) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          if (
            bodyKeys.length !== 2
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('previewHandle')
            || bodyRecord?.confirm !== true
            || typeof previewHandle !== 'string'
            || !GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }

          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: GOVERNANCE_OPERATIONS_RETENTION_ACTION,
            resourceKind: GOVERNANCE_OPERATIONS_RETENTION_RESOURCE_KIND,
            resourceId: GOVERNANCE_OPERATIONS_RETENTION_RESOURCE_ID,
            scope: { kind: 'system' },
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }
          if (consumed.binding.expectedAtMs === undefined) {
            return { status: 409, body: { error: 'conflict' } };
          }

          try {
            const confirmation = governanceOperations.confirmConfiguredRetention({
              expectedState: consumed.binding.expectedState,
              expectedRevisionNumber: consumed.binding.expectedRevisionNumber,
              previewDigest: consumed.binding.previewDigest,
              expectedAtMs: consumed.binding.expectedAtMs,
            });
            return confirmation
              ? { status: 200, body: confirmation }
              : { status: 409, body: { error: 'conflict' } };
          } catch (error) {
            return isSqliteBusyError(error)
              ? { status: 503, body: { error: 'temporarily_unavailable' } }
              : { status: 500, body: { error: 'internal_error' } };
          }
        }
        if (route.purpose === GOVERNANCE_OPERATIONS_RESTORE_PREVIEW_PURPOSE) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const backupRef = bodyRecord?.backupRef;
          if (
            bodyKeys.length !== 2
            || !bodyKeys.includes('action')
            || !bodyKeys.includes('backupRef')
            || bodyRecord?.action !== GOVERNANCE_OPERATIONS_RESTORE_ACTION
            || typeof backupRef !== 'string'
            || !GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(backupRef)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }

          const preview = governanceOperations.previewServerOwnedBackupRestore(backupRef);
          if (!preview) {
            return { status: 404, body: { error: 'not_found' } };
          }
          const issued = governancePreviewHandles.issue({
            sessionId: session.sessionId,
            sessionExpiresAt: session.expiresAt,
            actor,
            action: preview.action,
            resourceKind: GOVERNANCE_OPERATIONS_RESTORE_RESOURCE_KIND,
            resourceId: backupRef,
            scope: { kind: 'system' },
            expectedState: preview.currentState,
            expectedRevisionNumber: preview.contractVersion,
            previewDigest: preview.previewDigest,
          });
          return {
            status: 201,
            body: {
              ...preview,
              previewHandle: issued.handle,
              previewExpiresAt: issued.expiresAt,
            },
          };
        }
        if (route.purpose === GOVERNANCE_OPERATIONS_RESTORE_CONFIRM_PURPOSE) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          const backupRef = bodyRecord?.backupRef;
          if (
            bodyKeys.length !== 3
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('previewHandle')
            || !bodyKeys.includes('backupRef')
            || bodyRecord?.confirm !== true
            || typeof previewHandle !== 'string'
            || !GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
            || typeof backupRef !== 'string'
            || !GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(backupRef)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }

          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: GOVERNANCE_OPERATIONS_RESTORE_ACTION,
            resourceKind: GOVERNANCE_OPERATIONS_RESTORE_RESOURCE_KIND,
            resourceId: backupRef,
            scope: { kind: 'system' },
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview = governanceOperations.previewServerOwnedBackupRestore(backupRef);
          if (
            !currentPreview
            || consumed.binding.expectedState !== currentPreview.currentState
            || consumed.binding.expectedRevisionNumber !== currentPreview.contractVersion
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          return {
            status: 200,
            body: prepareGovernanceRestoreHandoff({
              databasePath: this.config.dbPath,
              backupRef,
              previewDigest: currentPreview.previewDigest,
              contractVersion: currentPreview.contractVersion,
              now: new Date(governanceNow()),
            }),
          };
        }
        if (route.purpose === GOVERNANCE_OPERATIONS_BACKUP_CONFIRM_PURPOSE) {
          const bodyRecord = typeof body === 'object'
            && body !== null
            && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
          const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : [];
          const previewHandle = bodyRecord?.previewHandle;
          if (
            bodyKeys.length !== 2
            || !bodyKeys.includes('confirm')
            || !bodyKeys.includes('previewHandle')
            || bodyRecord?.confirm !== true
            || typeof previewHandle !== 'string'
            || !GOVERNANCE_OPAQUE_HANDLE_PATTERN.test(previewHandle)
          ) {
            return { status: 400, body: { error: 'bad_request' } };
          }

          const consumed = governancePreviewHandles.consumeWithOutcome({
            sessionId: session.sessionId,
            handle: previewHandle,
            actor,
            action: GOVERNANCE_OPERATIONS_BACKUP_ACTION,
            resourceKind: GOVERNANCE_OPERATIONS_BACKUP_RESOURCE_KIND,
            resourceId: GOVERNANCE_OPERATIONS_BACKUP_RESOURCE_ID,
            scope: { kind: 'system' },
          });
          if (consumed.outcome === 'not_found_or_denied') {
            return { status: 404, body: { error: 'not_found' } };
          }
          if (consumed.outcome === 'already_consumed') {
            return { status: 409, body: { error: 'conflict' } };
          }

          const currentPreview = governanceOperations.previewVerifiedBackup();
          if (
            consumed.binding.expectedState !== currentPreview.currentState
            || consumed.binding.expectedRevisionNumber !== currentPreview.contractVersion
            || consumed.binding.previewDigest !== currentPreview.previewDigest
          ) {
            return { status: 409, body: { error: 'conflict' } };
          }

          return {
            status: 200,
            body: await governanceOperations.createServerOwnedVerifiedBackup(),
          };
        }
        if (route.purpose === GOVERNANCE_ACTIVITY_MODEL_INVOCATIONS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.summarizeModelInvocations(),
          };
        }
        if (route.purpose === GOVERNANCE_ACTIVITY_WORKER_HEARTBEATS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listWorkerHeartbeats(),
          };
        }
        if (route.purpose === GOVERNANCE_ACTIVITY_JOBS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listJobs(),
          };
        }
        if (route.purpose === GOVERNANCE_ACTIVITY_JOB_ATTEMPTS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listJobAttempts(),
          };
        }
        if (route.purpose === GOVERNANCE_ACTIVITY_TOOL_CALLS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listToolCalls(),
          };
        }
        if (route.purpose === GOVERNANCE_ACTIVITY_ACTION_DECISIONS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listActionDecisions(),
          };
        }
        if (route.purpose === GOVERNANCE_ACTIVITY_ACTION_EXECUTIONS_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listActionExecutions(),
          };
        }
        if (route.purpose === GOVERNANCE_ACTIVITY_EVENT_PROCESSING_FAILURES_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listEventProcessingFailures(),
          };
        }
        if (route.purpose === GOVERNANCE_ACTIVITY_AUDIT_PURPOSE) {
          return {
            status: 200,
            body: await governanceQueries.listAudit(),
          };
        }
        return { status: 404, body: { error: 'not_found' } };
      },
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
