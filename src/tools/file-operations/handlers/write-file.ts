/**
 * Write File Handler
 *
 * 处理写入文件操作
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolCallResult } from '../../../types/tool.js';
import {
  PathValidator,
  throwIfFileOperationAborted,
  type FileOperationContext,
} from '../path-validator.js';
import { redactFileOperationText } from '../redaction.js';

interface WriteFileInput {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
  overwrite?: boolean;
}

interface WriteFileOutput {
  path: string;
  size: number;
  created: boolean;
}

/**
 * 写入文件处理器
 */
export class WriteFileHandler {
  private validator: PathValidator;

  constructor() {
    this.validator = new PathValidator();
  }

  /**
   * 执行写入文件操作
   */
  async execute(
    input: WriteFileInput,
    context: FileOperationContext
  ): Promise<ToolCallResult> {
    const startTime = Date.now();
    const redactedPathResult = redactFileOperationText(input.path);
    const redactedInputPath = redactedPathResult.text;
    const pathSecretsRedacted = redactedPathResult.redacted;

    try {
      throwIfFileOperationAborted(context.signal);

      // 1. 检查是否为 readonly 模式
      if (context.sandboxPolicy.filesystem === 'readonly') {
        return {
          toolCallId: context.toolCallId,
          status: 'rejected',
          error: {
            code: 'READONLY_FILESYSTEM',
            message: 'Filesystem is in readonly mode',
          },
          executionTimeMs: Date.now() - startTime,
          auditSummary: 'write_file rejected: readonly filesystem',
          secretsRedacted: false,
        };
      }

      // 2. 路径验证
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
          auditSummary: `write_file rejected: ${redactedReason}`,
          secretsRedacted: pathSecretsRedacted || redactedReasonResult.redacted,
        };
      }

      const normalizedPath = validation.normalizedPath;

      // 3. 检查文件是否已存在
      let fileExists = false;
      try {
        await fs.promises.access(normalizedPath);
        fileExists = true;
      } catch {
        // 文件不存在
      }
      throwIfFileOperationAborted(context.signal);

      if (fileExists && !input.overwrite) {
        return {
          toolCallId: context.toolCallId,
          status: 'error',
          error: {
            code: 'FILE_EXISTS',
            message: `File already exists: ${redactedInputPath}`,
          },
          executionTimeMs: Date.now() - startTime,
          auditSummary: 'write_file failed: file exists',
          secretsRedacted: pathSecretsRedacted,
        };
      }

      // 4. 确保父目录存在
      const parentDir = path.dirname(normalizedPath);
      throwIfFileOperationAborted(context.signal);
      await fs.promises.mkdir(parentDir, { recursive: true });
      throwIfFileOperationAborted(context.signal);

      // 5. 写入文件
      const encoding = input.encoding || 'utf8';
      let buffer: Buffer;

      if (encoding === 'base64') {
        buffer = Buffer.from(input.content, 'base64');
      } else {
        buffer = Buffer.from(input.content, 'utf8');
      }

      throwIfFileOperationAborted(context.signal);
      await fs.promises.writeFile(normalizedPath, buffer, {
        signal: context.signal,
      });
      throwIfFileOperationAborted(context.signal);

      // 6. 获取文件大小
      const stats = await fs.promises.stat(normalizedPath);
      throwIfFileOperationAborted(context.signal);

      const output: WriteFileOutput = {
        path: redactedInputPath,
        size: stats.size,
        created: !fileExists,
      };

      return {
        toolCallId: context.toolCallId,
        status: 'success',
        output,
        executionTimeMs: Date.now() - startTime,
        auditSummary: `write_file: ${redactedInputPath} (${stats.size} bytes, ${fileExists ? 'overwritten' : 'created'})`,
        secretsRedacted: pathSecretsRedacted,
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
        auditSummary: `write_file error: ${redactedMessage}`,
        secretsRedacted: pathSecretsRedacted || redactedMessageResult.redacted,
      };
    }
  }
}
