/**
 * Write File Handler Tests
 *
 * 测试写入文件处理器
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WriteFileHandler } from '../../../src/tools/file-operations/handlers/write-file';
import type { FileOperationContext } from '../../../src/tools/file-operations/path-validator';
import type { SandboxPolicy } from '../../../src/types/tool';

describe('WriteFileHandler', () => {
  let handler: WriteFileHandler;
  let tempDir: string;
  let context: FileOperationContext;

  beforeEach(async () => {
    handler = new WriteFileHandler();
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'lethebot-test-')
    );

    const sandboxPolicy: SandboxPolicy = {
      filesystem: 'workspace_write',
      network: 'none',
      execution: 'in_process',
      maxRuntimeMs: 10000,
    };

    context = {
      toolCallId: 'test-call-id',
      turnId: 'test-turn-id',
      signal: new AbortController().signal,
      workspaceRoot: tempDir,
      sandboxPolicy,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('Basic File Writing', () => {
    it('should write a new file', async () => {
      const content = 'Hello, LetheBot!';
      const result = await handler.execute(
        { path: 'test.txt', content },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.created).toBe(true);
      expect(result.output?.path).toBe('test.txt');

      const written = await fs.promises.readFile(
        path.join(tempDir, 'test.txt'),
        'utf8'
      );
      expect(written).toBe(content);
    });

    it('should write file with base64 encoding', async () => {
      const content = 'Hello, World!';
      const base64Content = Buffer.from(content).toString('base64');

      const result = await handler.execute(
        { path: 'test.txt', content: base64Content, encoding: 'base64' },
        context
      );

      expect(result.status).toBe('success');

      const written = await fs.promises.readFile(
        path.join(tempDir, 'test.txt'),
        'utf8'
      );
      expect(written).toBe(content);
    });

    it('should stop before directory or file mutation when cancellation arrives after validation', async () => {
      const controller = new AbortController();
      const leakedReason = 'sk-write-abort-reason-must-not-leak';
      context.signal = controller.signal;
      vi.spyOn(fs.promises, 'access').mockImplementation(async () => {
        controller.abort(leakedReason);
        const error = new Error('not found') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });
      const mkdirSpy = vi.spyOn(fs.promises, 'mkdir');
      const writeFileSpy = vi.spyOn(fs.promises, 'writeFile');

      const result = await handler.execute(
        { path: 'cancelled.txt', content: 'must not be written' },
        context
      );

      expect(result).toMatchObject({
        status: 'error',
        error: {
          code: 'ABORT_ERR',
          message: 'File operation aborted',
        },
      });
      expect(JSON.stringify(result)).not.toContain(leakedReason);
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(writeFileSpy).not.toHaveBeenCalled();
    });

    it('should create parent directories', async () => {
      const result = await handler.execute(
        { path: 'deep/nested/file.txt', content: 'content' },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.created).toBe(true);

      const exists = await fs.promises
        .access(path.join(tempDir, 'deep/nested/file.txt'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('Overwrite Behavior', () => {
    it('should reject overwriting existing file without flag', async () => {
      const filePath = path.join(tempDir, 'existing.txt');
      await fs.promises.writeFile(filePath, 'original');

      const result = await handler.execute(
        { path: 'existing.txt', content: 'new content', overwrite: false },
        context
      );

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('FILE_EXISTS');

      const content = await fs.promises.readFile(filePath, 'utf8');
      expect(content).toBe('original');
    });

    it('should overwrite file when flag is true', async () => {
      const filePath = path.join(tempDir, 'existing.txt');
      await fs.promises.writeFile(filePath, 'original');

      const result = await handler.execute(
        { path: 'existing.txt', content: 'new content', overwrite: true },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.created).toBe(false);

      const content = await fs.promises.readFile(filePath, 'utf8');
      expect(content).toBe('new content');
    });
  });

  describe('Security Checks', () => {
    it('should reject readonly filesystem', async () => {
      context.sandboxPolicy.filesystem = 'readonly';

      const result = await handler.execute(
        { path: 'test.txt', content: 'content' },
        context
      );

      expect(result.status).toBe('rejected');
      expect(result.error?.code).toBe('READONLY_FILESYSTEM');
    });

    it('should reject path outside workspace', async () => {
      const result = await handler.execute(
        { path: '/etc/passwd', content: 'malicious' },
        context
      );

      expect(result.status).toBe('rejected');
      expect(result.error?.code).toBe('PATH_VALIDATION_FAILED');
    });

    it('should reject path traversal', async () => {
      const result = await handler.execute(
        { path: '../../../etc/passwd', content: 'malicious' },
        context
      );

      expect(result.status).toBe('rejected');
      expect(result.error?.code).toBe('PATH_VALIDATION_FAILED');
    });

    it('should reject allowed_paths prefix sibling writes without creating files', async () => {
      context.sandboxPolicy.filesystem = 'allowed_paths';
      context.allowedPaths = ['safe'];

      const result = await handler.execute(
        { path: 'safe-private/secret.txt', content: 'malicious' },
        context
      );

      expect(result.status).toBe('rejected');
      expect(result.error?.code).toBe('PATH_VALIDATION_FAILED');

      const escapedPath = path.join(tempDir, 'safe-private/secret.txt');
      const escapedExists = await fs.promises
        .access(escapedPath)
        .then(() => true)
        .catch(() => false);
      expect(escapedExists).toBe(false);
    });

    it('should reject writes below symlink parents escaping workspace', async () => {
      const outsideDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'lethebot-outside-')
      );
      const symlinkPath = path.join(tempDir, 'outside-link');

      try {
        await fs.promises.symlink(outsideDir, symlinkPath);

        const result = await handler.execute(
          { path: 'outside-link/escaped.txt', content: 'malicious' },
          context
        );

        expect(result.status).toBe('rejected');
        expect(result.error?.code).toBe('PATH_VALIDATION_FAILED');
        expect(result.error?.message).toContain('Parent directory symlink escapes workspace');

        const escapedExists = await fs.promises
          .access(path.join(outsideDir, 'escaped.txt'))
          .then(() => true)
          .catch(() => false);
        expect(escapedExists).toBe(false);
      } finally {
        await fs.promises.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('Output Redaction', () => {
    it('should redact secret-like paths in file-exists errors', async () => {
      const secret = 'sk-writeexist1234567890abcdefghi';
      const secretPath = `api_key=${secret}.txt`;
      await fs.promises.writeFile(path.join(tempDir, secretPath), 'original');

      const result = await handler.execute(
        { path: secretPath, content: 'new content', overwrite: false },
        context
      );

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('FILE_EXISTS');
      expect(result.secretsRedacted).toBe(true);
      expect(result.error?.message).toContain('[REDACTED:api_key_assignment]');
      expect(result.error?.message).not.toContain(secret);
    });

    it('should redact secret-like paths in successful output and audit summary', async () => {
      const secret = 'sk-writefilepath1234567890abcdefghi';
      const secretPath = `api_key=${secret}.txt`;

      const result = await handler.execute(
        { path: secretPath, content: 'content' },
        context
      );

      expect(result.status).toBe('success');
      expect(result.secretsRedacted).toBe(true);
      expect(result.output?.path).toContain('[REDACTED:api_key_assignment]');
      expect(result.auditSummary).toContain('[REDACTED:api_key_assignment]');
      expect(JSON.stringify(result.output)).not.toContain(secret);
      expect(result.auditSummary).not.toContain(secret);

      const writtenExists = await fs.promises
        .access(path.join(tempDir, secretPath))
        .then(() => true)
        .catch(() => false);
      expect(writtenExists).toBe(true);
    });

    it('should preserve both markers for adjacent secret/platform paths in output and audit summary', async () => {
      const rawAdjacent = 'sk-write-adjacent-secret-qq-1234567890';
      const rawPlatformId = 'qq-1234567890';
      const rawNumericPlatformId = '1234567890';
      const adjacentPath = `token=${rawAdjacent}.txt`;

      const result = await handler.execute(
        { path: adjacentPath, content: 'content' },
        context
      );
      const serialized = JSON.stringify(result);

      expect(result.status).toBe('success');
      expect(result.secretsRedacted).toBe(true);
      expect(result.output?.path).toContain('[REDACTED:token_assignment]');
      expect(result.output?.path).toContain('[REDACTED:platform_id]');
      expect(result.auditSummary).toContain('[REDACTED:token_assignment]');
      expect(result.auditSummary).toContain('[REDACTED:platform_id]');
      expect(serialized).not.toContain(rawAdjacent);
      expect(serialized).not.toContain(rawPlatformId);
      expect(serialized).not.toContain(rawNumericPlatformId);

      const writtenExists = await fs.promises
        .access(path.join(tempDir, adjacentPath))
        .then(() => true)
        .catch(() => false);
      expect(writtenExists).toBe(true);
    });
  });

  describe('Output Metadata', () => {
    it('should return file size', async () => {
      const content = 'Test content';
      const result = await handler.execute(
        { path: 'test.txt', content },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.size).toBe(Buffer.byteLength(content));
    });

    it('should indicate if file was created vs overwritten', async () => {
      // First write - created
      const result1 = await handler.execute(
        { path: 'test.txt', content: 'original' },
        context
      );
      expect(result1.output?.created).toBe(true);

      // Second write - overwritten
      const result2 = await handler.execute(
        { path: 'test.txt', content: 'new', overwrite: true },
        context
      );
      expect(result2.output?.created).toBe(false);
    });
  });

  describe('Audit Logging', () => {
    it('should include audit summary for new file', async () => {
      const result = await handler.execute(
        { path: 'test.txt', content: 'content' },
        context
      );

      expect(result.auditSummary).toContain('write_file');
      expect(result.auditSummary).toContain('test.txt');
      expect(result.auditSummary).toContain('created');
    });

    it('should include audit summary for overwritten file', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'test.txt'), 'original');

      const result = await handler.execute(
        { path: 'test.txt', content: 'new', overwrite: true },
        context
      );

      expect(result.auditSummary).toContain('write_file');
      expect(result.auditSummary).toContain('overwritten');
    });

    it('should include execution time', async () => {
      const result = await handler.execute(
        { path: 'test.txt', content: 'content' },
        context
      );

      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content', async () => {
      const result = await handler.execute(
        { path: 'empty.txt', content: '' },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.size).toBe(0);

      const content = await fs.promises.readFile(
        path.join(tempDir, 'empty.txt'),
        'utf8'
      );
      expect(content).toBe('');
    });

    it('should handle large content', async () => {
      const largeContent = 'x'.repeat(1024 * 1024); // 1MB

      const result = await handler.execute(
        { path: 'large.txt', content: largeContent },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.size).toBe(largeContent.length);
    });

    it('should handle unicode content', async () => {
      const content = '你好，世界！🌍';

      const result = await handler.execute(
        { path: 'unicode.txt', content },
        context
      );

      expect(result.status).toBe('success');

      const written = await fs.promises.readFile(
        path.join(tempDir, 'unicode.txt'),
        'utf8'
      );
      expect(written).toBe(content);
    });

    it('should handle binary content via base64', async () => {
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      const base64Content = buffer.toString('base64');

      const result = await handler.execute(
        { path: 'binary.bin', content: base64Content, encoding: 'base64' },
        context
      );

      expect(result.status).toBe('success');

      const written = await fs.promises.readFile(
        path.join(tempDir, 'binary.bin')
      );
      expect(written).toEqual(buffer);
    });

    it('should handle paths with spaces', async () => {
      const result = await handler.execute(
        { path: 'my documents/file.txt', content: 'content' },
        context
      );

      expect(result.status).toBe('success');

      const exists = await fs.promises
        .access(path.join(tempDir, 'my documents/file.txt'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });
});
