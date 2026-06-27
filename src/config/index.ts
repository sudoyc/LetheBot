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
});

export type Config = z.infer<typeof ConfigSchema>;

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
  };

  try {
    cachedConfig = ConfigSchema.parse(raw);
    return cachedConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Configuration validation failed:');
      console.error(error.issues);
      throw new Error('Invalid configuration');
    }
    throw error;
  }
}
