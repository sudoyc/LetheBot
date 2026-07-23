/**
 * List Directory Handler
 *
 * 处理列出目录操作
 */

import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type { ToolCallResult } from '../../../types/tool.js';
import {
  PathValidator,
  throwIfFileOperationAborted,
  type FileOperationContext,
} from '../path-validator.js';
import { redactFileOperationText } from '../redaction.js';

interface ListDirectoryInput {
  path: string;
  recursive?: boolean;
  pattern?: string;
}

interface DirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mtime: string;
}

interface ListDirectoryOutput {
  entries: DirectoryEntry[];
}

/**
 * 列出目录处理器
 */
export class ListDirectoryHandler {
  private validator: PathValidator;

  constructor() {
    this.validator = new PathValidator();
  }

  /**
   * 执行列出目录操作
   */
  async execute(
    input: ListDirectoryInput,
    context: FileOperationContext
  ): Promise<ToolCallResult> {
    const startTime = Date.now();
    const redactedPathResult = redactFileOperationText(input.path);
    const redactedInputPath = redactedPathResult.text;
    const pathSecretsRedacted = redactedPathResult.redacted;

    try {
      throwIfFileOperationAborted(context.signal);

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
          auditSummary: `list_directory rejected: ${redactedReason}`,
          secretsRedacted: pathSecretsRedacted || redactedReasonResult.redacted,
        };
      }

      const normalizedPath = validation.normalizedPath;

      // 2. 检查是否为目录
      const stats = await fs.promises.stat(normalizedPath);
      throwIfFileOperationAborted(context.signal);
      if (!stats.isDirectory()) {
        return {
          toolCallId: context.toolCallId,
          status: 'error',
          error: {
            code: 'NOT_A_DIRECTORY',
            message: `Path is not a directory: ${redactedInputPath}`,
          },
          executionTimeMs: Date.now() - startTime,
          auditSummary: 'list_directory failed: not a directory',
          secretsRedacted: pathSecretsRedacted,
        };
      }

      // 3. 列出目录内容
      const entries: DirectoryEntry[] = [];

      if (input.recursive) {
        await this.listRecursive(
          normalizedPath,
          input.path,
          entries,
          input.pattern,
          context
        );
      } else {
        await this.listFlat(
          normalizedPath,
          input.path,
          entries,
          input.pattern,
          context
        );
      }
      throwIfFileOperationAborted(context.signal);

      const redactedEntries = entries.map((entry) => this.redactEntry(entry));
      const output: ListDirectoryOutput = { entries: redactedEntries };
      const entrySecretsRedacted = redactedEntries.some((entry, index) =>
        entry.name !== entries[index]?.name || entry.path !== entries[index]?.path
      );
      const secretsRedacted = pathSecretsRedacted || entrySecretsRedacted;

      return {
        toolCallId: context.toolCallId,
        status: 'success',
        output,
        executionTimeMs: Date.now() - startTime,
        auditSummary: `list_directory: ${redactedInputPath} (${entries.length} entries)`,
        secretsRedacted,
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
        auditSummary: `list_directory error: ${redactedMessage}`,
        secretsRedacted: pathSecretsRedacted || redactedMessageResult.redacted,
      };
    }
  }

  /**
   * 平坦列出目录
   */
  private async listFlat(
    normalizedPath: string,
    relativePath: string,
    entries: DirectoryEntry[],
    pattern: string | undefined,
    context: FileOperationContext
  ): Promise<void> {
    throwIfFileOperationAborted(context.signal);
    const dirEntries = await fs.promises.readdir(normalizedPath, {
      withFileTypes: true,
    });
    throwIfFileOperationAborted(context.signal);

    for (const dirent of dirEntries) {
      throwIfFileOperationAborted(context.signal);
      const entryPath = path.join(relativePath, dirent.name);

      // 应用 glob 模式过滤
      if (pattern && !minimatch(dirent.name, pattern)) {
        continue;
      }

      const fullPath = path.join(normalizedPath, dirent.name);
      const stats = await fs.promises.stat(fullPath);
      throwIfFileOperationAborted(context.signal);

      const entry: DirectoryEntry = {
        name: dirent.name,
        path: entryPath,
        type: this.getEntryType(dirent),
        size: stats.size,
        mtime: stats.mtime.toISOString(),
      };

      entries.push(entry);
    }
  }

  /**
   * 递归列出目录
   */
  private async listRecursive(
    normalizedPath: string,
    relativePath: string,
    entries: DirectoryEntry[],
    pattern: string | undefined,
    context: FileOperationContext
  ): Promise<void> {
    throwIfFileOperationAborted(context.signal);
    const dirEntries = await fs.promises.readdir(normalizedPath, {
      withFileTypes: true,
    });
    throwIfFileOperationAborted(context.signal);

    for (const dirent of dirEntries) {
      throwIfFileOperationAborted(context.signal);
      const entryPath = path.join(relativePath, dirent.name);
      const fullPath = path.join(normalizedPath, dirent.name);

      // 验证路径是否在允许范围内
      const validation = await this.validator.validate(entryPath, context);
      if (!validation.allowed) {
        continue;
      }

      const stats = await fs.promises.stat(fullPath);
      throwIfFileOperationAborted(context.signal);

      // 应用 glob 模式过滤
      if (!pattern || minimatch(dirent.name, pattern)) {
        const entry: DirectoryEntry = {
          name: dirent.name,
          path: entryPath,
          type: this.getEntryType(dirent),
          size: stats.size,
          mtime: stats.mtime.toISOString(),
        };
        entries.push(entry);
      }

      // 递归处理子目录
      if (dirent.isDirectory()) {
        await this.listRecursive(
          fullPath,
          entryPath,
          entries,
          pattern,
          context
        );
      }
    }
  }

  private redactEntry(entry: DirectoryEntry): DirectoryEntry {
    return {
      ...entry,
      name: redactFileOperationText(entry.name).text,
      path: redactFileOperationText(entry.path).text,
    };
  }

  /**
   * 获取条目类型
   */
  private getEntryType(
    dirent: fs.Dirent
  ): 'file' | 'directory' | 'symlink' {
    if (dirent.isSymbolicLink()) {
      return 'symlink';
    }
    if (dirent.isDirectory()) {
      return 'directory';
    }
    return 'file';
  }
}
