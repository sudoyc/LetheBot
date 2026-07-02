/**
 * Delete File Handler
 *
 * 处理删除文件操作
 */

import * as fs from 'fs';
import type { ToolCallResult } from '../../../types/tool';
import {
  PathValidator,
  type FileOperationContext,
} from '../path-validator';

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

    try {
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
        return {
          toolCallId: context.toolCallId,
          status: 'rejected',
          error: {
            code: 'PATH_VALIDATION_FAILED',
            message: validation.reason || 'Path validation failed',
            details: { checks: validation.checks },
          },
          executionTimeMs: Date.now() - startTime,
          auditSummary: `delete_file rejected: ${validation.reason}`,
          secretsRedacted: false,
        };
      }

      const normalizedPath = validation.normalizedPath!;

      // 3. 检查文件/目录是否存在
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(normalizedPath);
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'ENOENT') {
          return {
            toolCallId: context.toolCallId,
            status: 'error',
            error: {
              code: 'FILE_NOT_FOUND',
              message: `File or directory not found: ${input.path}`,
            },
            executionTimeMs: Date.now() - startTime,
            auditSummary: 'delete_file failed: file not found',
            secretsRedacted: false,
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
            message: `Path is a directory, use recursive=true to delete: ${input.path}`,
          },
          executionTimeMs: Date.now() - startTime,
          auditSummary: 'delete_file failed: directory without recursive flag',
          secretsRedacted: false,
        };
      }

      // 5. 执行删除
      if (stats.isDirectory()) {
        await fs.promises.rm(normalizedPath, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(normalizedPath);
      }

      const output: DeleteFileOutput = {
        deleted: true,
        path: input.path,
      };

      return {
        toolCallId: context.toolCallId,
        status: 'success',
        output,
        executionTimeMs: Date.now() - startTime,
        auditSummary: `delete_file: ${input.path} (${stats.isDirectory() ? 'directory' : 'file'}, ${stats.size} bytes)`,
        secretsRedacted: false,
      };
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      const message = err.message ?? String(error);
      return {
        toolCallId: context.toolCallId,
        status: 'error',
        error: {
          code: err.code || 'UNKNOWN_ERROR',
          message,
        },
        executionTimeMs: Date.now() - startTime,
        auditSummary: `delete_file error: ${message}`,
        secretsRedacted: false,
      };
    }
  }
}
