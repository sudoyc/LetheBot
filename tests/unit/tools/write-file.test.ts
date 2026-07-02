/**
 * Write File Handler Tests
 *
 * 测试写入文件处理器
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
      workspaceRoot: tempDir,
      sandboxPolicy,
    };
  });

  afterEach(async () => {
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
