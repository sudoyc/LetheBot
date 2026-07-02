/**
 * Configuration loader
 *
 * Loads and validates configuration from environment variables.
 */

import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// Load .env file
dotenvConfig();

const ConfigSchema = z.object({
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  test: z.boolean().default(false),
  dbPath: z.string().default('./data/lethebot.db'),
  rawEventRetentionDays: z.number().int().min(0).default(90),
  chatMessageRetentionDays: z.number().int().min(0).default(0),
  auditLogRetentionDays: z.number().int().min(0).default(0),
  disabledDeletedMemoryRetentionDays: z.number().int().min(0).default(0),

  // OneBot runtime configuration (SnowLuma / NapCat compatible)
  onebotTransport: z.enum(['http', 'ws']).default('ws'),
  onebotHttpUrl: z.string().url().default('http://localhost:3000'),
  onebotWsUrl: z.string().url().default('ws://localhost:3001/'),
  onebotToken: z.string().optional(),
  onebotBotQqId: z.string().optional(),
  lethebotPort: z.number().int().min(1).max(65535).default(6700),
  lethebotHost: z.string().default('0.0.0.0'),
  lethebotHealthPath: z.string().default('/healthz'),
  lethebotEventPath: z.string().default('/onebot/event'),
});

export type Config = z.infer<typeof ConfigSchema>;

export type OneBotTransport = Config['onebotTransport'];

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
    dbPath: process.env.LETHEBOT_DB_PATH,
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
    lethebotEventPath: process.env.LETHEBOT_EVENT_PATH,
  };

  try {
    cachedConfig = ConfigSchema.parse(raw);
    return cachedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Configuration validation failed:');
      console.error(error.issues);
      throw new ConfigValidationError('Invalid configuration', error.issues);
    }
    throw error;
  }
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
