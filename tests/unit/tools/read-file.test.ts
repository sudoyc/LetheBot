/**
 * Read File Handler Tests
 *
 * 测试读取文件处理器
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ReadFileHandler } from '../../../src/tools/file-operations/handlers/read-file';
import type { FileOperationContext } from '../../../src/tools/file-operations/path-validator';
import type { SandboxPolicy } from '../../../src/types/tool';

describe('ReadFileHandler', () => {
  let handler: ReadFileHandler;
  let tempDir: string;
  let context: FileOperationContext;

  beforeEach(async () => {
    handler = new ReadFileHandler();
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'lethebot-test-')
    );

    const sandboxPolicy: SandboxPolicy = {
      filesystem: 'workspace_write',
      network: 'none',
      execution: 'in_process',
      maxRuntimeMs: 5000,
      maxOutputBytes: 1048576,
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

  describe('Basic File Reading', () => {
    it('should read a text file', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      const content = 'Hello, LetheBot!';
      await fs.promises.writeFile(filePath, content);

      const result = await handler.execute({ path: 'test.txt' }, context);

      expect(result.status).toBe('success');
      expect(result.output).toMatchObject({
        content,
        encoding: 'utf8',
      });
      expect(result.output?.size).toBeGreaterThan(0);
    });

    it('should read file with specified encoding', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      const content = 'Test content';
      await fs.promises.writeFile(filePath, content);

      const result = await handler.execute(
        { path: 'test.txt', encoding: 'base64' },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.encoding).toBe('base64');
      expect(result.output?.content).toBe(Buffer.from(content).toString('base64'));
    });

    it('should include file metadata', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      await fs.promises.writeFile(filePath, 'content');

      const result = await handler.execute({ path: 'test.txt' }, context);

      expect(result.status).toBe('success');
      expect(result.output).toHaveProperty('size');
      expect(result.output).toHaveProperty('mtime');
      expect(typeof result.output?.mtime).toBe('string');
    });
  });

  describe('Error Handling', () => {
    it('should reject path outside workspace', async () => {
      const result = await handler.execute(
        { path: '/etc/passwd' },
        context
      );

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

    it('should handle non-existent file', async () => {
      const result = await handler.execute(
        { path: 'non-existent.txt' },
        context
      );

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('FILE_NOT_FOUND');
    });

    it('should reject files exceeding size limit', async () => {
      const filePath = path.join(tempDir, 'large.txt');
      const largeContent = 'x'.repeat(2 * 1024 * 1024); // 2MB
      await fs.promises.writeFile(filePath, largeContent);

      context.sandboxPolicy.maxOutputBytes = 1024 * 1024; // 1MB limit

      const result = await handler.execute({ path: 'large.txt' }, context);

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('FILE_TOO_LARGE');
    });
  });

  describe('Secret Scanning', () => {
    it('should detect OpenAI-like API keys', async () => {
      const filePath = path.join(tempDir, 'config.txt');
      const content = 'OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqrstuvwxyz';
      await fs.promises.writeFile(filePath, content);

      const result = await handler.execute({ path: 'config.txt' }, context);

      expect(result.status).toBe('success');
      expect(result.secretsRedacted).toBe(true);
    });

    it('should detect GitHub tokens', async () => {
      const filePath = path.join(tempDir, '.env');
      const content = 'GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz';
      await fs.promises.writeFile(filePath, content);

      const result = await handler.execute({ path: '.env' }, context);

      expect(result.status).toBe('success');
      expect(result.secretsRedacted).toBe(true);
    });

    it('should detect JWT tokens', async () => {
      const filePath = path.join(tempDir, 'token.txt');
      const content = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      await fs.promises.writeFile(filePath, content);

      const result = await handler.execute({ path: 'token.txt' }, context);

      expect(result.status).toBe('success');
      expect(result.secretsRedacted).toBe(true);
    });

    it('should detect AWS access keys', async () => {
      const filePath = path.join(tempDir, 'aws.txt');
      const content = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
      await fs.promises.writeFile(filePath, content);

      const result = await handler.execute({ path: 'aws.txt' }, context);

      expect(result.status).toBe('success');
      expect(result.secretsRedacted).toBe(true);
    });

    it('should detect private keys', async () => {
      const filePath = path.join(tempDir, 'key.pem');
      const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
      await fs.promises.writeFile(filePath, content);

      const result = await handler.execute({ path: 'key.pem' }, context);

      expect(result.status).toBe('success');
      expect(result.secretsRedacted).toBe(true);
    });

    it('should not flag normal content as secrets', async () => {
      const filePath = path.join(tempDir, 'readme.txt');
      const content = 'This is a normal README file with no secrets.';
      await fs.promises.writeFile(filePath, content);

      const result = await handler.execute({ path: 'readme.txt' }, context);

      expect(result.status).toBe('success');
      expect(result.secretsRedacted).toBe(false);
    });
  });

  describe('Audit Logging', () => {
    it('should include audit summary', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      await fs.promises.writeFile(filePath, 'content');

      const result = await handler.execute({ path: 'test.txt' }, context);

      expect(result.auditSummary).toContain('read_file');
      expect(result.auditSummary).toContain('test.txt');
    });

    it('should include execution time', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      await fs.promises.writeFile(filePath, 'content');

      const result = await handler.execute({ path: 'test.txt' }, context);

      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty files', async () => {
      const filePath = path.join(tempDir, 'empty.txt');
      await fs.promises.writeFile(filePath, '');

      const result = await handler.execute({ path: 'empty.txt' }, context);

      expect(result.status).toBe('success');
      expect(result.output?.content).toBe('');
      expect(result.output?.size).toBe(0);
    });

    it('should handle binary files with base64 encoding', async () => {
      const filePath = path.join(tempDir, 'binary.bin');
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      await fs.promises.writeFile(filePath, buffer);

      const result = await handler.execute(
        { path: 'binary.bin', encoding: 'base64' },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.content).toBe(buffer.toString('base64'));
    });

    it('should handle unicode content', async () => {
      const filePath = path.join(tempDir, 'unicode.txt');
      const content = '你好，世界！🌍';
      await fs.promises.writeFile(filePath, content, 'utf8');

      const result = await handler.execute({ path: 'unicode.txt' }, context);

      expect(result.status).toBe('success');
      expect(result.output?.content).toBe(content);
    });
  });
});
