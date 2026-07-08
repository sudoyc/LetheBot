/**
 * Read File Handler
 *
 * 处理读取文件操作
 */

import * as fs from 'fs';
import type { ToolCallResult } from '../../../types/tool';
import {
  PathValidator,
  type FileOperationContext,
} from '../path-validator';
import { redactFileOperationText } from '../redaction';

interface ReadFileInput {
  path: string;
  encoding?: 'utf8' | 'base64' | 'binary';
}

interface ReadFileOutput {
  content: string;
  size: number;
  mtime: string;
  encoding: string;
}

/**
 * 读取文件处理器
 */
export class ReadFileHandler {
  private validator: PathValidator;

  constructor() {
    this.validator = new PathValidator();
  }

  /**
   * 执行读取文件操作
   */
  async execute(
    input: ReadFileInput,
    context: FileOperationContext
  ): Promise<ToolCallResult> {
    const startTime = Date.now();
    const redactedPathResult = redactFileOperationText(input.path);
    const redactedInputPath = redactedPathResult.text;
    const pathSecretsRedacted = redactedPathResult.redacted;

    try {
      // 1. 路径验证
      const validation = await this.validator.validate(input.path, context);
      if (!validation.allowed) {
        const redactedReasonResult = redactFileOperationText(
          validation.reason || 'Path validation failed'
        );
        const redactedReason = redactedReasonResult.text;
        return {
          toolCallId: context.toolCallId,
          status: 'rejected',
          error: {
            code: 'PATH_VALIDATION_FAILED',
            message: redactedReason,
            details: { checks: validation.checks },
          },
          executionTimeMs: Date.now() - startTime,
          auditSummary: `read_file rejected: ${redactedReason}`,
          secretsRedacted: pathSecretsRedacted || redactedReasonResult.redacted,
        };
      }

      const normalizedPath = validation.normalizedPath;

      // 2. 检查文件是否存在
      try {
        await fs.promises.access(normalizedPath, fs.constants.R_OK);
      } catch {
        return {
          toolCallId: context.toolCallId,
          status: 'error',
          error: {
            code: 'FILE_NOT_FOUND',
            message: `File not found or not readable: ${redactedInputPath}`,
          },
          executionTimeMs: Date.now() - startTime,
          auditSummary: `read_file error: file not found`,
          secretsRedacted: pathSecretsRedacted,
        };
      }

      // 3. 检查文件大小
      const stats = await fs.promises.stat(normalizedPath);
      const maxSize = context.sandboxPolicy.maxOutputBytes || 1048576;
      if (stats.size > maxSize) {
        return {
          toolCallId: context.toolCallId,
          status: 'error',
          error: {
            code: 'FILE_TOO_LARGE',
            message: `File size ${stats.size} exceeds limit ${maxSize}`,
          },
          executionTimeMs: Date.now() - startTime,
          auditSummary: 'read_file failed: file too large',
          secretsRedacted: false,
        };
      }

      // 4. 读取文件
      const encoding = input.encoding || 'utf8';
      let content: string;

      if (encoding === 'base64') {
        const buffer = await fs.promises.readFile(normalizedPath);
        content = buffer.toString('base64');
      } else if (encoding === 'binary') {
        const buffer = await fs.promises.readFile(normalizedPath);
        content = buffer.toString('binary');
      } else {
        content = await fs.promises.readFile(normalizedPath, 'utf8');
      }

      // 5. 秘密扫描和输出脱敏
      const redaction = redactFileOperationText(content);
      const outputContent = redaction.text;
      const secretsFound = redaction.redacted;

      const output: ReadFileOutput = {
        content: outputContent,
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        encoding,
      };

      return {
        toolCallId: context.toolCallId,
        status: 'success',
        output,
        executionTimeMs: Date.now() - startTime,
        auditSummary: `read_file: ${redactedInputPath} (${stats.size} bytes)`,
        secretsRedacted: secretsFound || pathSecretsRedacted,
      };
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      const message = err.message ?? String(error);
      const redactedMessageResult = redactFileOperationText(message);
      const redactedMessage = redactedMessageResult.text;
      return {
        toolCallId: context.toolCallId,
        status: 'error',
        error: {
          code: err.code || 'UNKNOWN_ERROR',
          message: redactedMessage,
        },
        executionTimeMs: Date.now() - startTime,
        auditSummary: `read_file error: ${redactedMessage}`,
        secretsRedacted: pathSecretsRedacted || redactedMessageResult.redacted,
      };
    }
  }
}
