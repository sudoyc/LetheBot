/**
 * Structured logging
 *
 * Uses pino for structured logging with configurable output.
 */

import pino from 'pino';
import { loadConfig } from '../config/index.js';

let logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (logger) {
    return logger;
  }

  const config = loadConfig();

  logger = pino({
    level: config.logLevel,
    transport: process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'HH:MM:ss.l',
          },
        }
      : undefined,
  });

  return logger;
}

export type Logger = pino.Logger;
