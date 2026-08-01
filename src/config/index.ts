/**
 * Configuration loader
 *
 * Loads and validates configuration from the supplied process environment.
 * Environment files must be loaded explicitly by the process launcher.
 */

import { z } from 'zod';
import { isAbsolute } from 'node:path';

const ExactHttpsOriginSchema = z.string().min(1).max(2048).refine(
  isExactHttpsOrigin,
  { message: 'LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS must contain exact HTTPS origins' },
).transform((value) => new URL(value).origin);

const GovernanceAdminTokenSchema = z.string().refine(
  isValidGovernanceAdminToken,
  { message: 'LETHEBOT_GOVERNANCE_ADMIN_TOKEN must be 32-512 control-free UTF-8 bytes' },
);

const ConfigSchema = z.object({
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  test: z.boolean().default(false),
  backgroundSummaryEnabled: z.boolean().default(false),
  botOwnerQqId: z.string().regex(/^[1-9][0-9]{4,11}$/).optional(),
  dbPath: z.string().default('./data/lethebot.db'),
  workspaceRoot: z.string().min(1).max(4096).refine(
    (value) => isAbsolute(value) && !value.includes('\0'),
    { message: 'LETHEBOT_WORKSPACE_ROOT must be an absolute path' },
  ).optional(),
  webFetchAllowedOrigins: z.array(ExactHttpsOriginSchema).max(16).default([]),
  rawEventRetentionDays: z.number().int().min(0).default(90),
  chatMessageRetentionDays: z.number().int().min(0).default(90),
  auditLogRetentionDays: z.number().int().min(0).default(365),
  disabledDeletedMemoryRetentionDays: z.number().int().min(0).default(90),
  eventProcessingFailureRetentionDays: z.number().int().min(0).default(90),
  piTurnTimeoutMs: z.number().finite().int().min(1).max(2_147_483_647).default(120_000),
  piMaxConcurrentTurns: z.number().finite().int().min(1).max(16).default(2),
  piMaxQueuedTurns: z.number().finite().int().min(0).max(128).default(128),
  evaluatorProvider: z.string().min(1).optional(),
  evaluatorModel: z.string().min(1).optional(),
  evaluatorBaseUrl: z.string().url().optional(),
  evaluatorApiKey: z.string().optional(),
  evaluatorTimeoutMs: z.number().finite().int().min(1).max(2_147_483_647).default(30_000),
  evaluatorMaxRetries: z.number().finite().int().min(0).max(10).default(1),
  evaluatorTemperature: z.number().finite().min(0).max(1).default(0),
  evaluatorPromptVersion: z.string().min(1).default('lethebot-governance-v1'),

  // OneBot runtime configuration (SnowLuma / NapCat compatible)
  onebotTransport: z.enum(['http', 'ws']).default('ws'),
  onebotHttpUrl: z.string().url().default('http://localhost:3000'),
  onebotWsUrl: z.string().url().default('ws://localhost:3001/'),
  onebotToken: z.string().optional(),
  onebotBotQqId: z.string().optional(),
  lethebotPort: z.number().int().min(1).max(65535).default(6700),
  lethebotHost: z.string().default('127.0.0.1'),
  lethebotHealthPath: z.string().default('/healthz'),
  lethebotReadinessPath: z.string().default('/readyz'),
  lethebotMetricsPath: z.string().default('/metrics'),
  lethebotEventPath: z.string().default('/onebot/event'),
  lethebotReverseHttpEnabled: z.boolean().default(false),
  lethebotMaxEventBodyBytes: z.number().finite().int().min(1).max(2_147_483_647).default(262_144),
  lethebotEventBodyTimeoutMs: z.number().finite().int().min(1).max(2_147_483_647).default(5_000),
  governanceEnabled: z.boolean().default(false),
  governanceHost: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
  governancePort: z.number().finite().int().min(1).max(65_535).default(6_701),
  governanceAdminToken: GovernanceAdminTokenSchema.optional(),
  governanceSessionTtlMs: z.number().finite().int().min(60_000).max(3_600_000).default(900_000),
}).superRefine((config, context) => {
  const hasUsableToken = Boolean(config.onebotToken?.trim());

  if (new Set(config.webFetchAllowedOrigins).size !== config.webFetchAllowedOrigins.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['webFetchAllowedOrigins'],
      message: 'LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS must not contain duplicates',
    });
  }

  if (
    isReverseHttpIngressEnabled(config)
    && !hasUsableToken
    && !isLoopbackBindHost(config.lethebotHost)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['onebotToken'],
      message: 'ONEBOT_TOKEN is required for non-loopback reverse HTTP event ingress',
    });
  }

  if (config.governanceEnabled && config.governanceAdminToken === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['governanceAdminToken'],
      message: 'LETHEBOT_GOVERNANCE_ADMIN_TOKEN is required when governance HTTP is enabled',
    });
  }

  if (config.governanceEnabled && config.governancePort === config.lethebotPort) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['governancePort'],
      message: 'LETHEBOT_GOVERNANCE_PORT must differ from LETHEBOT_PORT when enabled',
    });
  }
});

function isLoopbackBindHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1';
}

function isExactHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return value === value.trim()
      && !hasUrlControlOrBackslash(value)
      && parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === '/'
      && parsed.search === ''
      && parsed.hash === ''
      && parsed.hostname.length > 0
      && !parsed.hostname.includes('*')
      && parsed.origin.length <= 2048;
  } catch {
    return false;
  }
}

function hasUrlControlOrBackslash(value: string): boolean {
  return value.includes('\\') || Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function isValidGovernanceAdminToken(value: string): boolean {
  const byteLength = Buffer.byteLength(value, 'utf8');
  return byteLength >= 32
    && byteLength <= 512
    && !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    });
}

export type Config = z.infer<typeof ConfigSchema>;

export type OneBotTransport = Config['onebotTransport'];

export function isReverseHttpIngressEnabled(
  config: Pick<Config, 'onebotTransport' | 'lethebotReverseHttpEnabled'>,
): boolean {
  return config.onebotTransport === 'http' || config.lethebotReverseHttpEnabled;
}

/**
 * OneBot runtime configuration.
 */
export interface OneBotRuntimeConfig {
  transport: OneBotTransport;
  httpUrl: string;
  wsUrl: string;
  token?: string;
  botQqId?: string;
  serverPort: number;
  serverHost: string;
  healthCheckPath: string;
  readinessPath: string;
  metricsPath: string;
  eventPath: string;
}

/**
 * Backward-compatible alias for older NapCat-named deployment helpers.
 */
export type NapCatConfig = OneBotRuntimeConfig;

/**
 * Configuration validation error
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

let cachedConfig: Config | null = null;

export function resetConfig(): void {
  cachedConfig = null;
}

export function loadConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  const raw = {
    logLevel: process.env.LOG_LEVEL,
    test: process.env.LETHEBOT_TEST === 'true',
    backgroundSummaryEnabled: process.env.LETHEBOT_BACKGROUND_SUMMARY_ENABLED === undefined
      ? undefined
      : process.env.LETHEBOT_BACKGROUND_SUMMARY_ENABLED === 'true'
        ? true
        : process.env.LETHEBOT_BACKGROUND_SUMMARY_ENABLED === 'false'
          ? false
          : process.env.LETHEBOT_BACKGROUND_SUMMARY_ENABLED,
    botOwnerQqId: process.env.LETHEBOT_BOT_OWNER_QQ_ID,
    dbPath: process.env.LETHEBOT_DB_PATH,
    workspaceRoot: process.env.LETHEBOT_WORKSPACE_ROOT,
    webFetchAllowedOrigins: parseWebFetchAllowedOriginsEnvironment(
      process.env.LETHEBOT_WEB_FETCH_ALLOWED_ORIGINS,
    ),
    rawEventRetentionDays: process.env.LETHEBOT_RAW_EVENT_RETENTION_DAYS
      ? parseInt(process.env.LETHEBOT_RAW_EVENT_RETENTION_DAYS, 10)
      : undefined,
    chatMessageRetentionDays: process.env.LETHEBOT_CHAT_MESSAGE_RETENTION_DAYS
      ? parseInt(process.env.LETHEBOT_CHAT_MESSAGE_RETENTION_DAYS, 10)
      : undefined,
    auditLogRetentionDays: process.env.LETHEBOT_AUDIT_LOG_RETENTION_DAYS
      ? parseInt(process.env.LETHEBOT_AUDIT_LOG_RETENTION_DAYS, 10)
      : undefined,
    disabledDeletedMemoryRetentionDays: process.env.LETHEBOT_DISABLED_DELETED_MEMORY_RETENTION_DAYS
      ? parseInt(process.env.LETHEBOT_DISABLED_DELETED_MEMORY_RETENTION_DAYS, 10)
      : undefined,
    eventProcessingFailureRetentionDays: process.env.LETHEBOT_EVENT_PROCESSING_FAILURE_RETENTION_DAYS
      ? parseInt(process.env.LETHEBOT_EVENT_PROCESSING_FAILURE_RETENTION_DAYS, 10)
      : undefined,
    piTurnTimeoutMs: process.env.PI_TURN_TIMEOUT_MS === undefined
      ? undefined
      : Number(process.env.PI_TURN_TIMEOUT_MS),
    piMaxConcurrentTurns: process.env.PI_MAX_CONCURRENT_TURNS === undefined
      ? undefined
      : Number(process.env.PI_MAX_CONCURRENT_TURNS),
    piMaxQueuedTurns: process.env.PI_MAX_QUEUED_TURNS === undefined
      ? undefined
      : process.env.PI_MAX_QUEUED_TURNS.trim() === ''
        ? Number.NaN
        : Number(process.env.PI_MAX_QUEUED_TURNS),
    evaluatorProvider: process.env.EVALUATOR_PROVIDER,
    evaluatorModel: process.env.EVALUATOR_MODEL,
    evaluatorBaseUrl: process.env.EVALUATOR_BASE_URL,
    evaluatorApiKey: process.env.EVALUATOR_API_KEY,
    evaluatorTimeoutMs: process.env.EVALUATOR_TIMEOUT_MS === undefined
      ? undefined
      : Number(process.env.EVALUATOR_TIMEOUT_MS),
    evaluatorMaxRetries: process.env.EVALUATOR_MAX_RETRIES === undefined
      ? undefined
      : Number(process.env.EVALUATOR_MAX_RETRIES),
    evaluatorTemperature: process.env.EVALUATOR_TEMPERATURE === undefined
      ? undefined
      : Number(process.env.EVALUATOR_TEMPERATURE),
    evaluatorPromptVersion: process.env.EVALUATOR_PROMPT_VERSION,

    // OneBot runtime configuration
    onebotTransport: process.env.ONEBOT_TRANSPORT,
    onebotHttpUrl: process.env.ONEBOT_HTTP_URL,
    onebotWsUrl: process.env.ONEBOT_WS_URL,
    onebotToken: process.env.ONEBOT_TOKEN,
    onebotBotQqId: process.env.LETHEBOT_BOT_QQ_ID,
    lethebotPort: process.env.LETHEBOT_PORT
      ? parseInt(process.env.LETHEBOT_PORT, 10)
      : undefined,
    lethebotHost: process.env.LETHEBOT_HOST,
    lethebotHealthPath: process.env.LETHEBOT_HEALTH_PATH,
    lethebotReadinessPath: process.env.LETHEBOT_READINESS_PATH,
    lethebotMetricsPath: process.env.LETHEBOT_METRICS_PATH,
    lethebotEventPath: process.env.LETHEBOT_EVENT_PATH,
    lethebotReverseHttpEnabled: process.env.LETHEBOT_REVERSE_HTTP_ENABLED === undefined
      ? undefined
      : process.env.LETHEBOT_REVERSE_HTTP_ENABLED === 'true'
        ? true
        : process.env.LETHEBOT_REVERSE_HTTP_ENABLED === 'false'
          ? false
          : process.env.LETHEBOT_REVERSE_HTTP_ENABLED,
    lethebotMaxEventBodyBytes: process.env.LETHEBOT_MAX_EVENT_BODY_BYTES === undefined
      ? undefined
      : Number(process.env.LETHEBOT_MAX_EVENT_BODY_BYTES),
    lethebotEventBodyTimeoutMs: process.env.LETHEBOT_EVENT_BODY_TIMEOUT_MS === undefined
      ? undefined
      : Number(process.env.LETHEBOT_EVENT_BODY_TIMEOUT_MS),
    governanceEnabled: process.env.LETHEBOT_GOVERNANCE_ENABLED === undefined
      ? undefined
      : process.env.LETHEBOT_GOVERNANCE_ENABLED === 'true'
        ? true
        : process.env.LETHEBOT_GOVERNANCE_ENABLED === 'false'
          ? false
          : process.env.LETHEBOT_GOVERNANCE_ENABLED,
    governanceHost: process.env.LETHEBOT_GOVERNANCE_HOST,
    governancePort: process.env.LETHEBOT_GOVERNANCE_PORT === undefined
      ? undefined
      : Number(process.env.LETHEBOT_GOVERNANCE_PORT),
    governanceAdminToken: process.env.LETHEBOT_GOVERNANCE_ADMIN_TOKEN,
    governanceSessionTtlMs: process.env.LETHEBOT_GOVERNANCE_SESSION_TTL_MS === undefined
      ? undefined
      : Number(process.env.LETHEBOT_GOVERNANCE_SESSION_TTL_MS),
  };

  try {
    cachedConfig = ConfigSchema.parse(raw);
    return cachedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ConfigValidationError('Invalid configuration', error.issues);
    }
    throw error;
  }
}

function parseWebFetchAllowedOriginsEnvironment(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim() === '') {
    return [];
  }
  return value.split(',').map((origin) => origin.trim());
}

/**
 * Load OneBot runtime configuration.
 */
export function loadOneBotRuntimeConfig(): OneBotRuntimeConfig {
  const config = loadConfig();
  return {
    transport: config.onebotTransport,
    httpUrl: config.onebotHttpUrl,
    wsUrl: config.onebotWsUrl,
    token: config.onebotToken,
    botQqId: config.onebotBotQqId,
    serverPort: config.lethebotPort,
    serverHost: config.lethebotHost,
    healthCheckPath: config.lethebotHealthPath,
    readinessPath: config.lethebotReadinessPath,
    metricsPath: config.lethebotMetricsPath,
    eventPath: config.lethebotEventPath,
  };
}

/**
 * Load NapCat-compatible OneBot configuration.
 *
 * @deprecated Prefer loadOneBotRuntimeConfig().
 */
export function loadNapCatConfig(): NapCatConfig {
  return loadOneBotRuntimeConfig();
}
