/**
 * List Directory Handler
 *
 * 处理列出目录操作
 */

import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type { ToolCallResult } from '../../../types/tool';
import {
  PathValidator,
  type FileOperationContext,
} from '../path-validator';

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
          auditSummary: `list_directory rejected: ${validation.reason}`,
          secretsRedacted: false,
        };
      }

      const normalizedPath = validation.normalizedPath!;

      // 2. 检查是否为目录
      const stats = await fs.promises.stat(normalizedPath);
      if (!stats.isDirectory()) {
        return {
          toolCallId: context.toolCallId,
          status: 'error',
          error: {
            code: 'NOT_A_DIRECTORY',
            message: `Path is not a directory: ${input.path}`,
          },
          executionTimeMs: Date.now() - startTime,
          auditSummary: 'list_directory failed: not a directory',
          secretsRedacted: false,
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
          input.pattern
        );
      }

      const output: ListDirectoryOutput = { entries };

      return {
        toolCallId: context.toolCallId,
        status: 'success',
        output,
        executionTimeMs: Date.now() - startTime,
        auditSummary: `list_directory: ${input.path} (${entries.length} entries)`,
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
        auditSummary: `list_directory error: ${message}`,
        secretsRedacted: false,
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
    pattern?: string
  ): Promise<void> {
    const dirEntries = await fs.promises.readdir(normalizedPath, {
      withFileTypes: true,
    });

    for (const dirent of dirEntries) {
      const entryPath = path.join(relativePath, dirent.name);

      // 应用 glob 模式过滤
      if (pattern && !minimatch(dirent.name, pattern)) {
        continue;
      }

      const fullPath = path.join(normalizedPath, dirent.name);
      const stats = await fs.promises.stat(fullPath);

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
    const dirEntries = await fs.promises.readdir(normalizedPath, {
      withFileTypes: true,
    });

    for (const dirent of dirEntries) {
      const entryPath = path.join(relativePath, dirent.name);
      const fullPath = path.join(normalizedPath, dirent.name);

      // 验证路径是否在允许范围内
      const validation = await this.validator.validate(entryPath, context);
      if (!validation.allowed) {
        continue;
      }

      const stats = await fs.promises.stat(fullPath);

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
