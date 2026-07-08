/**
 * Structured logging
 *
 * Uses pino for structured logging with configurable output.
 */

import pino from 'pino';
import { loadConfig } from '../config/index.js';
import { redactSecretsInText } from '../memory/secret-scan.js';

let logger: pino.Logger | null = null;

export const redactingLogHooks: NonNullable<pino.LoggerOptions['hooks']> = {
  logMethod(args, method) {
    method.apply(this, args.map((arg) => sanitizeLogValueForOutput(arg)) as Parameters<pino.LogFn>);
  },
};

export function getLogger(): pino.Logger {
  if (logger) {
    return logger;
  }

  const config = loadConfig();

  logger = pino({
    level: config.logLevel,
    hooks: redactingLogHooks,
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

export function sanitizeLogValueForOutput(value: unknown): unknown {
  return sanitizeLogValue(value, []);
}

function sanitizeLogValue(value: unknown, path: string[]): unknown {
  if (typeof value === 'string') {
    if (isStackField(path)) {
      return '[REDACTED:stack]';
    }
    return redactLogText(value);
  }

  if (typeof value === 'number') {
    return shouldRedactNumericPlatformId(path, value) ? '[REDACTED:platform_id]' : value;
  }

  if (typeof value === 'bigint') {
    return shouldRedactNumericPlatformId(path, value) ? '[REDACTED:platform_id]' : value;
  }

  if (value instanceof Error) {
    return {
      message: redactLogText(value.message),
      stack: value.stack ? '[REDACTED:stack]' : undefined,
      name: redactLogText(value.name),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item, path));
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redactLogText(key), sanitizeLogValue(item, [...path, key])])
    );
  }

  return value;
}

function redactLogText(text: string): string {
  const platformRedacted = redactPlatformIdentifiers(text);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactPlatformIdentifiers(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function shouldRedactNumericPlatformId(path: string[], value: number | bigint): boolean {
  const text = typeof value === 'bigint' ? value.toString() : String(Math.abs(value));
  return isPlatformIdField(path) && isPlatformLikeIntegerString(text);
}

function isPlatformIdField(path: string[]): boolean {
  const key = path.at(-1);
  if (!key) {
    return false;
  }

  return /(^|_)(?:target|subject|recipient|actor|owner)?[_-]?(user|sender|group|message|conversation|platform|qq)[_-]?ids?$/i.test(key)
    || /^(?:target|subject|recipient|actor|owner)?(?:User|Sender|Group|Message|Conversation|Platform|Qq)Ids?$/i.test(key)
    || /^(userId|senderId|groupId|messageId|conversationId|platformUserId|platformMessageId)$/i.test(key);
}

function isStackField(path: string[]): boolean {
  const key = path.at(-1);
  return key !== undefined && /^stack$/i.test(key);
}

function isPlatformLikeIntegerString(value: string): boolean {
  return /^\d{8,12}$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
