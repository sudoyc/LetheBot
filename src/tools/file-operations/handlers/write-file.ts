/**
 * Write File Handler
 *
 * 处理写入文件操作
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolCallResult } from '../../../types/tool';
import {
  PathValidator,
  type FileOperationContext,
} from '../path-validator';

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
          auditSummary: 'write_file rejected: readonly filesystem',
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
          auditSummary: `write_file rejected: ${validation.reason}`,
          secretsRedacted: false,
        };
      }

      const normalizedPath = validation.normalizedPath!;

      // 3. 检查文件是否已存在
      let fileExists = false;
      try {
        await fs.promises.access(normalizedPath);
        fileExists = true;
      } catch {
        // 文件不存在
      }

      if (fileExists && !input.overwrite) {
        return {
          toolCallId: context.toolCallId,
          status: 'error',
          error: {
            code: 'FILE_EXISTS',
            message: `File already exists: ${input.path}`,
          },
          executionTimeMs: Date.now() - startTime,
          auditSummary: 'write_file failed: file exists',
          secretsRedacted: false,
        };
      }

      // 4. 确保父目录存在
      const parentDir = path.dirname(normalizedPath);
      await fs.promises.mkdir(parentDir, { recursive: true });

      // 5. 写入文件
      const encoding = input.encoding || 'utf8';
      let buffer: Buffer;

      if (encoding === 'base64') {
        buffer = Buffer.from(input.content, 'base64');
      } else {
        buffer = Buffer.from(input.content, 'utf8');
      }

      await fs.promises.writeFile(normalizedPath, buffer);

      // 6. 获取文件大小
      const stats = await fs.promises.stat(normalizedPath);

      const output: WriteFileOutput = {
        path: input.path,
        size: stats.size,
        created: !fileExists,
      };

      return {
        toolCallId: context.toolCallId,
        status: 'success',
        output,
        executionTimeMs: Date.now() - startTime,
        auditSummary: `write_file: ${input.path} (${stats.size} bytes, ${fileExists ? 'overwritten' : 'created'})`,
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
        auditSummary: `write_file error: ${message}`,
        secretsRedacted: false,
      };
    }
  }
}
