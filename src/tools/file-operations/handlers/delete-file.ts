/**
 * Delete File Handler
 *
 * 处理删除文件操作
 */

import * as fs from 'fs';
import type { ToolCallResult } from '../../../types/tool.js';
import {
  PathValidator,
  throwIfFileOperationAborted,
  type FileOperationContext,
} from '../path-validator.js';
import { redactFileOperationText } from '../redaction.js';

interface DeleteFileInput {
  path: string;
  recursive?: boolean;
}

interface DeleteFileOutput {
  deleted: boolean;
  path: string;
}

/**
 * 删除文件处理器
 */
export class DeleteFileHandler {
  private validator: PathValidator;

  constructor() {
    this.validator = new PathValidator();
  }

  /**
   * 执行删除文件操作
   */
  async execute(
    input: DeleteFileInput,
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
          auditSummary: 'delete_file rejected: readonly filesystem',
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
          auditSummary: `delete_file rejected: ${redactedReason}`,
          secretsRedacted: pathSecretsRedacted || redactedReasonResult.redacted,
        };
      }

      const normalizedPath = validation.normalizedPath;

      // 3. 检查文件/目录是否存在
      let stats: fs.Stats;
      try {
        throwIfFileOperationAborted(context.signal);
        stats = await fs.promises.stat(normalizedPath);
        throwIfFileOperationAborted(context.signal);
      } catch (err: unknown) {
        throwIfFileOperationAborted(context.signal);
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
          return {
            toolCallId: context.toolCallId,
            status: 'error',
            error: {
              code: 'FILE_NOT_FOUND',
              message: `File or directory not found: ${redactedInputPath}`,
            },
            executionTimeMs: Date.now() - startTime,
            auditSummary: 'delete_file failed: file not found',
            secretsRedacted: pathSecretsRedacted,
          };
        }
        throw err;
      }

      // 4. 检查是否为目录且需要递归删除
      if (stats.isDirectory() && !input.recursive) {
        return {
          toolCallId: context.toolCallId,
          status: 'error',
          error: {
            code: 'IS_DIRECTORY',
            message: `Path is a directory, use recursive=true to delete: ${redactedInputPath}`,
          },
          executionTimeMs: Date.now() - startTime,
          auditSummary: 'delete_file failed: directory without recursive flag',
          secretsRedacted: pathSecretsRedacted,
        };
      }

      // 5. 执行删除
      throwIfFileOperationAborted(context.signal);
      if (stats.isDirectory()) {
        await fs.promises.rm(normalizedPath, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(normalizedPath);
      }
      throwIfFileOperationAborted(context.signal);

      const output: DeleteFileOutput = {
        deleted: true,
        path: redactedInputPath,
      };

      return {
        toolCallId: context.toolCallId,
        status: 'success',
        output,
        executionTimeMs: Date.now() - startTime,
        auditSummary: `delete_file: ${redactedInputPath} (${stats.isDirectory() ? 'directory' : 'file'}, ${stats.size} bytes)`,
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
        auditSummary: `delete_file error: ${redactedMessage}`,
        secretsRedacted: pathSecretsRedacted || redactedMessageResult.redacted,
      };
    }
  }
}
