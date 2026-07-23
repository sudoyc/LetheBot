/**
 * List Directory Handler Tests
 *
 * 测试列出目录处理器
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ListDirectoryHandler } from '../../../src/tools/file-operations/handlers/list-directory';
import type { FileOperationContext } from '../../../src/tools/file-operations/path-validator';
import type { SandboxPolicy } from '../../../src/types/tool';

describe('ListDirectoryHandler', () => {
  let handler: ListDirectoryHandler;
  let tempDir: string;
  let context: FileOperationContext;

  beforeEach(async () => {
    handler = new ListDirectoryHandler();
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'lethebot-test-')
    );

    const sandboxPolicy: SandboxPolicy = {
      filesystem: 'workspace_write',
      network: 'none',
      execution: 'in_process',
      maxRuntimeMs: 3000,
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
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('Basic Directory Listing', () => {
    it('should list files in directory', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'file1.txt'), 'content1');
      await fs.promises.writeFile(path.join(tempDir, 'file2.txt'), 'content2');
      await fs.promises.mkdir(path.join(tempDir, 'subdir'));

      const result = await handler.execute({ path: '.' }, context);

      expect(result.status).toBe('success');
      expect(result.output?.entries).toHaveLength(3);

      const names = result.output?.entries.map((e: any) => e.name).sort();
      expect(names).toEqual(['file1.txt', 'file2.txt', 'subdir']);
    });

    it('should include file metadata', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'test.txt'), 'content');

      const result = await handler.execute({ path: '.' }, context);

      expect(result.status).toBe('success');
      const entry = result.output?.entries.find((e: any) => e.name === 'test.txt');

      expect(entry).toMatchObject({
        name: 'test.txt',
        type: 'file',
      });
      expect(entry).toHaveProperty('size');
      expect(entry).toHaveProperty('mtime');
      expect(entry).toHaveProperty('path');
    });

    it('should distinguish file types', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'file.txt'), 'content');
      await fs.promises.mkdir(path.join(tempDir, 'directory'));

      const result = await handler.execute({ path: '.' }, context);

      expect(result.status).toBe('success');

      const fileEntry = result.output?.entries.find((e: any) => e.name === 'file.txt');
      expect(fileEntry?.type).toBe('file');

      const dirEntry = result.output?.entries.find((e: any) => e.name === 'directory');
      expect(dirEntry?.type).toBe('directory');
    });
  });

  describe('Recursive Listing', () => {
    it('should list files recursively', async () => {
      await fs.promises.mkdir(path.join(tempDir, 'dir1'));
      await fs.promises.mkdir(path.join(tempDir, 'dir1/dir2'));
      await fs.promises.writeFile(path.join(tempDir, 'file1.txt'), 'content');
      await fs.promises.writeFile(path.join(tempDir, 'dir1/file2.txt'), 'content');
      await fs.promises.writeFile(path.join(tempDir, 'dir1/dir2/file3.txt'), 'content');

      const result = await handler.execute(
        { path: '.', recursive: true },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.entries.length).toBeGreaterThanOrEqual(5);

      const paths = result.output?.entries.map((e: any) => e.path).sort();
      expect(paths).toContain('file1.txt');
      expect(paths).toContain('dir1/file2.txt');
      expect(paths).toContain('dir1/dir2/file3.txt');
    });

    it('should not recurse when recursive=false', async () => {
      await fs.promises.mkdir(path.join(tempDir, 'subdir'));
      await fs.promises.writeFile(path.join(tempDir, 'file1.txt'), 'content');
      await fs.promises.writeFile(path.join(tempDir, 'subdir/file2.txt'), 'content');

      const result = await handler.execute(
        { path: '.', recursive: false },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.entries).toHaveLength(2);

      const names = result.output?.entries.map((e: any) => e.name);
      expect(names).not.toContain('file2.txt');
    });
  });

  describe('Pattern Matching', () => {
    it('should filter by glob pattern', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'test.txt'), 'content');
      await fs.promises.writeFile(path.join(tempDir, 'test.md'), 'content');
      await fs.promises.writeFile(path.join(tempDir, 'data.json'), 'content');

      const result = await handler.execute(
        { path: '.', pattern: '*.txt' },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.entries).toHaveLength(1);
      expect(result.output?.entries[0].name).toBe('test.txt');
    });

    it('should work with complex patterns', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'test1.txt'), 'content');
      await fs.promises.writeFile(path.join(tempDir, 'test2.txt'), 'content');
      await fs.promises.writeFile(path.join(tempDir, 'data.txt'), 'content');

      const result = await handler.execute(
        { path: '.', pattern: 'test*.txt' },
        context
      );

      expect(result.status).toBe('success');
      expect(result.output?.entries).toHaveLength(2);

      const names = result.output?.entries.map((e: any) => e.name).sort();
      expect(names).toEqual(['test1.txt', 'test2.txt']);
    });
  });

  describe('Output Redaction', () => {
    it('should redact secret-like entry names and paths before returning output', async () => {
      const fileSecret = 'sk-listdirfile1234567890abcdefghi';
      const dirSecret = 'sk-listdirdir1234567890abcdefghi';
      const secretDirName = `token=${dirSecret}`;
      const secretFileName = `api_key=${fileSecret}.txt`;
      await fs.promises.mkdir(path.join(tempDir, secretDirName));
      await fs.promises.writeFile(
        path.join(tempDir, secretDirName, secretFileName),
        'content'
      );

      const result = await handler.execute(
        { path: '.', recursive: true },
        context
      );

      const serialized = JSON.stringify(result.output);
      expect(result.status).toBe('success');
      expect(result.secretsRedacted).toBe(true);
      expect(serialized).toContain('[REDACTED:token_assignment]');
      expect(serialized).toContain('[REDACTED:api_key_assignment]');
      expect(serialized).not.toContain(fileSecret);
      expect(serialized).not.toContain(dirSecret);
    });

    it('should preserve both markers for adjacent secret/platform entry names and paths', async () => {
      const rawAdjacent = 'sk-list-adjacent-secret-qq-1234567890';
      const rawPlatformId = 'qq-1234567890';
      const rawNumericPlatformId = '1234567890';
      const adjacentDirName = `token=${rawAdjacent}`;
      const adjacentFileName = `api_key=${rawAdjacent}.txt`;
      await fs.promises.mkdir(path.join(tempDir, adjacentDirName));
      await fs.promises.writeFile(
        path.join(tempDir, adjacentDirName, adjacentFileName),
        'content'
      );

      const result = await handler.execute(
        { path: '.', recursive: true },
        context
      );
      const serialized = JSON.stringify(result);

      expect(result.status).toBe('success');
      expect(result.secretsRedacted).toBe(true);
      expect(serialized).toContain('[REDACTED:token_assignment]');
      expect(serialized).toContain('[REDACTED:api_key_assignment]');
      expect(serialized).toContain('[REDACTED:platform_id]');
      expect(serialized).not.toContain(rawAdjacent);
      expect(serialized).not.toContain(rawPlatformId);
      expect(serialized).not.toContain(rawNumericPlatformId);
    });
  });

  describe('Path Redaction', () => {
    it('should redact secret-like input paths in success audit summaries', async () => {
      const secret = 'sk-listaudit1234567890abcdefghi';
      const secretDir = `token=${secret}`;
      await fs.promises.mkdir(path.join(tempDir, secretDir));
      await fs.promises.writeFile(path.join(tempDir, secretDir, 'file.txt'), 'content');

      const result = await handler.execute({ path: secretDir }, context);

      expect(result.status).toBe('success');
      expect(result.secretsRedacted).toBe(true);
      expect(result.auditSummary).toContain('[REDACTED:token_assignment]');
      expect(result.auditSummary).not.toContain(secret);
    });

    it('should redact secret-like paths in not-a-directory errors', async () => {
      const secret = 'sk-listnotdir1234567890abcdefghi';
      const secretPath = `api_key=${secret}.txt`;
      await fs.promises.writeFile(path.join(tempDir, secretPath), 'content');

      const result = await handler.execute({ path: secretPath }, context);

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('NOT_A_DIRECTORY');
      expect(result.secretsRedacted).toBe(true);
      expect(result.error?.message).toContain('[REDACTED:api_key_assignment]');
      expect(result.error?.message).not.toContain(secret);
    });
  });

  describe('Security Checks', () => {
    it('should reject path outside workspace', async () => {
      const result = await handler.execute({ path: '/etc' }, context);

      expect(result.status).toBe('rejected');
      expect(result.error?.code).toBe('PATH_VALIDATION_FAILED');
    });

    it('should reject path traversal', async () => {
      const result = await handler.execute(
        { path: '../../../etc' },
        context
      );

      expect(result.status).toBe('rejected');
      expect(result.error?.code).toBe('PATH_VALIDATION_FAILED');
    });

    it('should reject non-directory paths', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'file.txt'), 'content');

      const result = await handler.execute({ path: 'file.txt' }, context);

      expect(result.status).toBe('error');
      expect(result.error?.code).toBe('NOT_A_DIRECTORY');
    });
  });

  describe('Audit Logging', () => {
    it('should include audit summary', async () => {
      await fs.promises.writeFile(path.join(tempDir, 'file.txt'), 'content');

      const result = await handler.execute({ path: '.' }, context);

      expect(result.auditSummary).toContain('list_directory');
      expect(result.auditSummary).toContain('entries');
    });

    it('should include execution time', async () => {
      const result = await handler.execute({ path: '.' }, context);

      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty directory', async () => {
      const result = await handler.execute({ path: '.' }, context);

      expect(result.status).toBe('success');
      expect(result.output?.entries).toEqual([]);
    });

    it('should handle unicode filenames', async () => {
      await fs.promises.writeFile(path.join(tempDir, '文件.txt'), 'content');
      await fs.promises.writeFile(path.join(tempDir, '🌍.txt'), 'content');

      const result = await handler.execute({ path: '.' }, context);

      expect(result.status).toBe('success');
      expect(result.output?.entries.length).toBeGreaterThanOrEqual(2);

      const names = result.output?.entries.map((e: any) => e.name);
      expect(names).toContain('文件.txt');
      expect(names).toContain('🌍.txt');
    });

    it('should handle directories with spaces', async () => {
      await fs.promises.mkdir(path.join(tempDir, 'my documents'));
      await fs.promises.writeFile(
        path.join(tempDir, 'my documents/file.txt'),
        'content'
      );

      const result = await handler.execute({ path: 'my documents' }, context);

      expect(result.status).toBe('success');
      expect(result.output?.entries).toHaveLength(1);
      expect(result.output?.entries[0].name).toBe('file.txt');
    });

    it('should handle symlinks', async () => {
      const targetFile = path.join(tempDir, 'target.txt');
      const symlinkPath = path.join(tempDir, 'link.txt');

      await fs.promises.writeFile(targetFile, 'content');
      await fs.promises.symlink(targetFile, symlinkPath);

      const result = await handler.execute({ path: '.' }, context);

      expect(result.status).toBe('success');

      const linkEntry = result.output?.entries.find(
        (e: any) => e.name === 'link.txt'
      );
      expect(linkEntry?.type).toBe('symlink');
    });
  });
});
