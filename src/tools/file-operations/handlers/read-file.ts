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

    try {
      // 1. 路径验证
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
          auditSummary: `read_file rejected: ${validation.reason}`,
          secretsRedacted: false,
        };
      }

      const normalizedPath = validation.normalizedPath!;

      // 2. 检查文件是否存在
      try {
        await fs.promises.access(normalizedPath, fs.constants.R_OK);
      } catch {
        return {
          toolCallId: context.toolCallId,
          status: 'error',
          error: {
            code: 'FILE_NOT_FOUND',
            message: `File not found or not readable: ${input.path}`,
          },
          executionTimeMs: Date.now() - startTime,
          auditSummary: `read_file error: file not found`,
          secretsRedacted: false,
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

      // 5. 秘密扫描
      const secretsFound = this.scanForSecrets(content);

      const output: ReadFileOutput = {
        content,
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        encoding,
      };

      return {
        toolCallId: context.toolCallId,
        status: 'success',
        output,
        executionTimeMs: Date.now() - startTime,
        auditSummary: `read_file: ${input.path} (${stats.size} bytes)`,
        secretsRedacted: secretsFound,
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
        auditSummary: `read_file error: ${message}`,
        secretsRedacted: false,
      };
    }
  }

  /**
   * 扫描内容中的秘密信息
   */
  private scanForSecrets(content: string): boolean {
    // 简单的秘密检测：API 密钥模式、JWT token 等
    const patterns = [
      /sk-[A-Za-z0-9]{32,}/, // OpenAI-like keys
      /ghp_[A-Za-z0-9]{36}/, // GitHub tokens
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, // JWT
      /AKIA[0-9A-Z]{16}/, // AWS Access Key ID
      /-----BEGIN (RSA |DSA )?PRIVATE KEY-----/, // Private keys
    ];
    return patterns.some((pattern) => pattern.test(content));
  }
}
