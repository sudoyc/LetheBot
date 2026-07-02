/**
 * Delete File Handler Tests
 *
 * 测试删除文件处理器
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DeleteFileHandler } from '../../../src/tools/file-operations/handlers/delete-file';
import type { FileOperationContext } from '../../../src/tools/file-operations/path-validator';
import type { SandboxPolicy } from '../../../src/types/tool';

describe('DeleteFileHandler', () => {
  let handler: DeleteFileHandler;
  let tempDir: string;
  let context: FileOperationContext;

  beforeEach(async () => {
    handler = new DeleteFileHandler();
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

  describe('Basic File Deletion', () => {
    it('should delete a file', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      await fs.promises.writeFile(filePath, 'content');

      const result = await handler.execute({ path: 'test.txt' }, context);

      expect(result.status).toBe('success');
      expect(result.output?.deleted).toBe(true);
      expect(result.output?.path).toBe('test.txt');

      const exists = await fs.promises
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('should handle non-existent file', async () => {
      const result = await handler.execute(
        { path: 'non-existent.txt' },
        context
      );

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('FILE_NOT_FOUND');
    });
  });

  describe('Directory Deletion', () => {
    it('should delete empty directory with recursive flag', async () => {
      const dirPath = path.join(tempDir, 'emptydir');
      await fs.promises.mkdir(dirPath);

      const result = await handler.execute(
        { path: 'emptydir', recursive: true },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.deleted).toBe(true);

      const exists = await fs.promises
        .access(dirPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('should delete directory with contents recursively', async () => {
      const dirPath = path.join(tempDir, 'testdir');
      await fs.promises.mkdir(dirPath);
      await fs.promises.writeFile(path.join(dirPath, 'file1.txt'), 'content');
      await fs.promises.writeFile(path.join(dirPath, 'file2.txt'), 'content');
      await fs.promises.mkdir(path.join(dirPath, 'subdir'));
      await fs.promises.writeFile(
        path.join(dirPath, 'subdir/file3.txt'),
        'content'
      );

      const result = await handler.execute(
        { path: 'testdir', recursive: true },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.deleted).toBe(true);

      const exists = await fs.promises
        .access(dirPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('should reject directory deletion without recursive flag', async () => {
      const dirPath = path.join(tempDir, 'testdir');
      await fs.promises.mkdir(dirPath);

      const result = await handler.execute(
        { path: 'testdir', recursive: false },
        context
      );

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('IS_DIRECTORY');

      const exists = await fs.promises
        .access(dirPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('Security Checks', () => {
    it('should reject readonly filesystem', async () => {
      context.sandboxPolicy.filesystem = 'readonly';

      const result = await handler.execute({ path: 'test.txt' }, context);

      expect(result.status).toBe('rejected');
      expect(result.error?.code).toBe('READONLY_FILESYSTEM');
    });

    it('should reject path outside workspace', async () => {
      const result = await handler.execute({ path: '/etc/passwd' }, context);

      expect(result.status).toBe('rejected');
      expect(result.error?.code).toBe('PATH_VALIDATION_FAILED');
    });

    it('should reject path traversal', async () => {
      const result = await handler.execute(
        { path: '../../../etc/passwd' },
        context
      );

      expect(result.status).toBe('rejected');
      expect(result.error?.code).toBe('PATH_VALIDATION_FAILED');
    });
  });

  describe('Audit Logging', () => {
    it('should include audit summary for file deletion', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'test.txt'), 'content');

      const result = await handler.execute({ path: 'test.txt' }, context);

      expect(result.auditSummary).toContain('delete_file');
      expect(result.auditSummary).toContain('test.txt');
      expect(result.auditSummary).toContain('file');
    });

    it('should include audit summary for directory deletion', async () => {
      await fs.promises.mkdir(path.join(tempDir, 'testdir'));

      const result = await handler.execute(
        { path: 'testdir', recursive: true },
        context
      );

      expect(result.auditSummary).toContain('delete_file');
      expect(result.auditSummary).toContain('directory');
    });

    it('should include execution time', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'test.txt'), 'content');

      const result = await handler.execute({ path: 'test.txt' }, context);

      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle deletion of symlink', async () => {
      const targetFile = path.join(tempDir, 'target.txt');
      const symlinkPath = path.join(tempDir, 'link.txt');

      await fs.promises.writeFile(targetFile, 'content');
      await fs.promises.symlink(targetFile, symlinkPath);

      const result = await handler.execute({ path: 'link.txt' }, context);

      expect(result.status).toBe('success');

      // Symlink should be deleted
      const linkExists = await fs.promises
        .access(symlinkPath)
        .then(() => true)
        .catch(() => false);
      expect(linkExists).toBe(false);

      // Target should still exist
      const targetExists = await fs.promises
        .access(targetFile)
        .then(() => true)
        .catch(() => false);
      expect(targetExists).toBe(true);
    });

    it('should handle files with unicode names', async () => {
      const filePath = path.join(tempDir, '文件.txt');
      await fs.promises.writeFile(filePath, 'content');

      const result = await handler.execute({ path: '文件.txt' }, context);

      expect(result.status).toBe('success');

      const exists = await fs.promises
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('should handle files with spaces in name', async () => {
      const filePath = path.join(tempDir, 'my document.txt');
      await fs.promises.writeFile(filePath, 'content');

      const result = await handler.execute(
        { path: 'my document.txt' },
        context
      );

      expect(result.status).toBe('success');

      const exists = await fs.promises
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('should handle deeply nested directories', async () => {
      const deepPath = path.join(tempDir, 'a/b/c/d/e');
      await fs.promises.mkdir(deepPath, { recursive: true });
      await fs.promises.writeFile(path.join(deepPath, 'file.txt'), 'content');

      const result = await handler.execute({ path: 'a', recursive: true }, context);

      expect(result.status).toBe('success');

      const exists = await fs.promises
        .access(path.join(tempDir, 'a'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });
  });
});
