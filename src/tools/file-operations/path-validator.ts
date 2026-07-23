/**
 * Path Validator
 *
 * 验证文件路径安全性，防止路径遍历、符号链接逃逸等攻击
 */

import * as path from 'path';
import * as fs from 'fs';
import type { SandboxPolicy } from '../../types/tool.js';

/**
 * 文件操作上下文
 */
export interface FileOperationContext {
  toolCallId: string;
  turnId: string;
  signal: AbortSignal;
  workspaceRoot: string;
  sandboxPolicy: SandboxPolicy;
  allowedPaths?: string[];
}

export function throwIfFileOperationAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  const error = new Error('File operation aborted') as NodeJS.ErrnoException;
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

/**
 * 路径验证结果
 */
interface PathValidationChecks {
  withinWorkspace: boolean;
  noTraversal: boolean;
  matchesAllowedPaths: boolean;
  noSymlinkEscape: boolean;
}

export type PathValidationResult =
  | {
    allowed: true;
    normalizedPath: string;
    checks: PathValidationChecks;
  }
  | {
    allowed: false;
    normalizedPath?: undefined;
    reason?: string;
    checks: PathValidationChecks;
  };

/**
 * 路径验证器
 */
export class PathValidator {
  private isWithinBoundary(candidatePath: string, boundaryPath: string): boolean {
    const relative = path.relative(boundaryPath, candidatePath);
    return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private async realpathNearestExistingAncestor(
    candidatePath: string,
    signal: AbortSignal
  ): Promise<string> {
    let current = candidatePath;

    while (true) {
      throwIfFileOperationAborted(signal);
      try {
        const realPath = await fs.promises.realpath(current);
        throwIfFileOperationAborted(signal);
        return realPath;
      } catch (err: unknown) {
        throwIfFileOperationAborted(signal);
        const error = err as NodeJS.ErrnoException;
        if (error.code !== 'ENOENT') {
          throw err;
        }

        const parent = path.dirname(current);
        if (parent === current) {
          throw err;
        }
        current = parent;
      }
    }
  }

  /**
   * 验证路径是否安全
   */
  async validate(
    requestedPath: string,
    context: FileOperationContext
  ): Promise<PathValidationResult> {
    throwIfFileOperationAborted(context.signal);
    const workspaceRoot = path.resolve(context.workspaceRoot);
    const realWorkspaceRoot = await fs.promises.realpath(workspaceRoot);
    throwIfFileOperationAborted(context.signal);
    const checks = {
      withinWorkspace: false,
      noTraversal: false,
      matchesAllowedPaths: false,
      noSymlinkEscape: false,
    };

    // 1. 检查路径遍历攻击
    checks.noTraversal = !requestedPath.includes('..');
    if (!checks.noTraversal) {
      return {
        allowed: false,
        reason: 'Path traversal detected',
        checks,
      };
    }

    // 2. 规范化路径
    const normalized = path.resolve(workspaceRoot, requestedPath);

    // 3. 检查是否在 workspace 内
    checks.withinWorkspace = this.isWithinBoundary(normalized, workspaceRoot);

    // 4. 根据 sandboxPolicy.filesystem 检查
    switch (context.sandboxPolicy.filesystem) {
      case 'none':
        return {
          allowed: false,
          reason: 'Filesystem access disabled',
          checks,
        };

      case 'readonly':
      case 'workspace_write':
        if (!checks.withinWorkspace) {
          return {
            allowed: false,
            reason: 'Path outside workspace',
            checks,
          };
        }
        break;

      case 'allowed_paths':
        if (!context.allowedPaths || context.allowedPaths.length === 0) {
          return {
            allowed: false,
            reason: 'No allowed paths configured',
            checks,
          };
        }
        checks.matchesAllowedPaths = context.allowedPaths.some((allowed) => {
          const allowedRoot = path.resolve(workspaceRoot, allowed);
          return this.isWithinBoundary(allowedRoot, workspaceRoot)
            && this.isWithinBoundary(normalized, allowedRoot);
        });
        if (!checks.matchesAllowedPaths) {
          return {
            allowed: false,
            reason: 'Path not in allowed paths',
            checks,
          };
        }
        break;
    }

    // 5. 检查符号链接逃逸
    try {
      const realPath = await fs.promises.realpath(normalized);
      throwIfFileOperationAborted(context.signal);
      checks.noSymlinkEscape = this.isWithinBoundary(realPath, realWorkspaceRoot);
      if (!checks.noSymlinkEscape) {
        return {
          allowed: false,
          reason: 'Symlink escapes workspace',
          checks,
        };
      }
    } catch (err: unknown) {
      throwIfFileOperationAborted(context.signal);
      const error = err as NodeJS.ErrnoException;
      // 文件不存在时，检查父目录
      if (error.code === 'ENOENT') {
        try {
          const realParent = await this.realpathNearestExistingAncestor(
            normalized,
            context.signal
          );
          checks.noSymlinkEscape = this.isWithinBoundary(realParent, realWorkspaceRoot);
          if (!checks.noSymlinkEscape) {
            return {
              allowed: false,
              reason: 'Parent directory symlink escapes workspace',
              checks,
            };
          }
        } catch {
          throwIfFileOperationAborted(context.signal);
          // 父目录也不存在，允许创建
          checks.noSymlinkEscape = true;
        }
      } else {
        // 其他错误，例如权限问题
        return {
          allowed: false,
          reason: `Filesystem error: ${error.message ?? String(err)}`,
          checks,
        };
      }
    }

    throwIfFileOperationAborted(context.signal);
    return {
      allowed: true,
      normalizedPath: normalized,
      checks,
    };
  }

  /**
   * 验证路径是否在允许的路径列表中
   */
  isPathAllowed(
    normalizedPath: string,
    allowedPaths: string[],
    workspaceRoot: string
  ): boolean {
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    const resolvedPath = path.resolve(normalizedPath);

    return allowedPaths.some((allowed) => {
      const allowedRoot = path.resolve(resolvedWorkspaceRoot, allowed);
      return this.isWithinBoundary(allowedRoot, resolvedWorkspaceRoot)
        && this.isWithinBoundary(resolvedPath, allowedRoot);
    });
  }
}
