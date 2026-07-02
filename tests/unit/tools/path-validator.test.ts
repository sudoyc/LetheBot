/**
 * Path Validator Tests
 *
 * 测试路径验证器的安全性
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  PathValidator,
  type FileOperationContext,
} from '../../../src/tools/file-operations/path-validator';
import type { SandboxPolicy } from '../../../src/types/tool';

describe('PathValidator', () => {
  let validator: PathValidator;
  let tempDir: string;
  let context: FileOperationContext;

  beforeEach(async () => {
    validator = new PathValidator();
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'lethebot-test-')
    );

    const sandboxPolicy: SandboxPolicy = {
      filesystem: 'workspace_write',
      network: 'none',
      execution: 'in_process',
      maxRuntimeMs: 5000,
    };

    context = {
      toolCallId: 'test-call-id',
      turnId: 'test-turn-id',
      workspaceRoot: tempDir,
      sandboxPolicy,
    };
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('Path Traversal Detection', () => {
    it('should reject paths with ../', async () => {
      const result = await validator.validate('../etc/passwd', context);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Path traversal detected');
      expect(result.checks.noTraversal).toBe(false);
    });

    it('should reject paths with ../../', async () => {
      const result = await validator.validate(
        'subdir/../../etc/passwd',
        context
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Path traversal detected');
    });

    it('should allow valid relative paths', async () => {
      const result = await validator.validate('documents/file.txt', context);
      expect(result.allowed).toBe(true);
      expect(result.normalizedPath).toBe(
        path.join(tempDir, 'documents/file.txt')
      );
    });
  });

  describe('Workspace Boundary', () => {
    it('should allow paths within workspace', async () => {
      const result = await validator.validate('file.txt', context);
      expect(result.allowed).toBe(true);
      expect(result.checks.withinWorkspace).toBe(true);
    });

    it('should reject absolute paths outside workspace', async () => {
      const result = await validator.validate('/etc/passwd', context);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Path outside workspace');
    });

    it('should reject prefix sibling paths outside workspace', async () => {
      const siblingRoot = `${tempDir}-sibling`;
      await fs.promises.mkdir(siblingRoot, { recursive: true });

      try {
        const result = await validator.validate(
          path.join(siblingRoot, 'file.txt'),
          context
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('Path outside workspace');
      } finally {
        await fs.promises.rm(siblingRoot, { recursive: true, force: true });
      }
    });
  });

  describe('Filesystem Policy', () => {
    it('should reject all paths when filesystem=none', async () => {
      context.sandboxPolicy.filesystem = 'none';
      const result = await validator.validate('file.txt', context);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Filesystem access disabled');
    });

    it('should enforce allowed_paths policy', async () => {
      context.sandboxPolicy.filesystem = 'allowed_paths';
      context.allowedPaths = ['documents', 'logs'];

      // 允许的路径
      const result1 = await validator.validate('documents/file.txt', context);
      expect(result1.allowed).toBe(true);

      // 不允许的路径
      const result2 = await validator.validate('secrets/key.pem', context);
      expect(result2.allowed).toBe(false);
      expect(result2.reason).toBe('Path not in allowed paths');
    });

    it('should reject allowed path prefix attacks', async () => {
      context.sandboxPolicy.filesystem = 'allowed_paths';
      context.allowedPaths = ['doc'];

      const result = await validator.validate('documents/file.txt', context);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Path not in allowed paths');
    });

    it('should reject when allowed_paths is empty', async () => {
      context.sandboxPolicy.filesystem = 'allowed_paths';
      context.allowedPaths = [];

      const result = await validator.validate('file.txt', context);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('No allowed paths configured');
    });
  });

  describe('Symlink Escape Detection', () => {
    it('should detect symlink escape outside workspace', async () => {
      // 创建一个指向 workspace 外部的符号链接
      const symlinkPath = path.join(tempDir, 'evil-link');
      const targetPath = '/etc/passwd';

      try {
        await fs.promises.symlink(targetPath, symlinkPath);
      } catch {
        // 在某些系统上可能需要权限
        return;
      }

      const result = await validator.validate('evil-link', context);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Symlink escapes workspace');
    });

    it('should allow symlinks within workspace', async () => {
      // 创建测试文件和符号链接
      const targetFile = path.join(tempDir, 'target.txt');
      const symlinkPath = path.join(tempDir, 'link.txt');

      await fs.promises.writeFile(targetFile, 'test content');
      await fs.promises.symlink(targetFile, symlinkPath);

      const result = await validator.validate('link.txt', context);
      expect(result.allowed).toBe(true);
    });

    it('should handle non-existent files (parent directory check)', async () => {
      // 文件不存在，但路径合法
      const result = await validator.validate('new-file.txt', context);
      expect(result.allowed).toBe(true);
      expect(result.checks.noSymlinkEscape).toBe(true);
    });

    it('should reject non-existent descendants below symlink escaping workspace', async () => {
      const outsideDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'lethebot-outside-')
      );
      const symlinkPath = path.join(tempDir, 'outside-link');

      try {
        await fs.promises.symlink(outsideDir, symlinkPath);
      } catch {
        await fs.promises.rm(outsideDir, { recursive: true, force: true });
        return;
      }

      try {
        const result = await validator.validate('outside-link/missing/file.txt', context);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Parent directory symlink escapes workspace');
      } finally {
        await fs.promises.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('Path Normalization', () => {
    it('should normalize relative paths', async () => {
      const result = await validator.validate('./documents/../file.txt', context);
      // 虽然有 ../，但在 normalize 后如果仍在 workspace 内可能被允许
      // 实际上我们的实现会在检测到 .. 时直接拒绝
      expect(result.allowed).toBe(false);
    });

    it('should resolve absolute paths correctly', async () => {
      const absolutePath = path.join(tempDir, 'file.txt');
      const result = await validator.validate(absolutePath, context);
      expect(result.allowed).toBe(true);
      expect(result.normalizedPath).toBe(absolutePath);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty path', async () => {
      const result = await validator.validate('', context);
      expect(result.allowed).toBe(true);
      expect(result.normalizedPath).toBe(tempDir);
    });

    it('should handle path with spaces', async () => {
      const result = await validator.validate('my documents/file.txt', context);
      expect(result.allowed).toBe(true);
    });

    it('should handle unicode paths', async () => {
      const result = await validator.validate('文档/文件.txt', context);
      expect(result.allowed).toBe(true);
    });
  });

  describe('isPathAllowed', () => {
    it('should check if path is in allowed list', () => {
      const allowedPaths = ['documents', 'logs'];
      const normalizedPath = path.join(tempDir, 'documents/file.txt');

      const result = validator.isPathAllowed(
        normalizedPath,
        allowedPaths,
        tempDir
      );
      expect(result).toBe(true);
    });

    it('should reject path not in allowed list', () => {
      const allowedPaths = ['documents', 'logs'];
      const normalizedPath = path.join(tempDir, 'secrets/key.pem');

      const result = validator.isPathAllowed(
        normalizedPath,
        allowedPaths,
        tempDir
      );
      expect(result).toBe(false);
    });

    it('should reject allowed list prefix attacks', () => {
      const result = validator.isPathAllowed(
        path.join(tempDir, 'documents-private/key.pem'),
        ['documents'],
        tempDir
      );
      expect(result).toBe(false);
    });
  });
});
