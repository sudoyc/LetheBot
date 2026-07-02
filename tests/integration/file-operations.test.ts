/**
 * File Operations Integration Test
 *
 * 测试文件操作工具的完整集成流程
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolRegistry } from '../../src/tools/registry';
import {
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  deleteFileTool,
} from '../../src/tools/file-operations/index';
import { ReadFileHandler } from '../../src/tools/file-operations/handlers/read-file';
import { WriteFileHandler } from '../../src/tools/file-operations/handlers/write-file';
import { ListDirectoryHandler } from '../../src/tools/file-operations/handlers/list-directory';
import { DeleteFileHandler } from '../../src/tools/file-operations/handlers/delete-file';
import type { FileOperationContext } from '../../src/tools/file-operations/path-validator';

describe('File Operations Integration', () => {
  let registry: ToolRegistry;
  let tempDir: string;

  beforeEach(async () => {
    registry = new ToolRegistry();

    // 注册所有文件操作工具
    const fileOperationTools = [
      readFileTool,
      writeFileTool,
      listDirectoryTool,
      deleteFileTool,
    ];
    fileOperationTools.forEach((tool) => registry.register(tool));

    // 创建临时目录
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'lethebot-integration-')
    );
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('Tool Registration', () => {
    it('should register all file operation tools', () => {
      expect(registry.get('read_file')).toBeDefined();
      expect(registry.get('write_file')).toBeDefined();
      expect(registry.get('list_directory')).toBeDefined();
      expect(registry.get('delete_file')).toBeDefined();
    });

    it('should have correct capabilities', () => {
      const readTool = registry.get('read_file');
      expect(readTool?.capabilities).toContain('read_local');

      const writeTool = registry.get('write_file');
      expect(writeTool?.capabilities).toContain('write_local');
    });

    it('should have correct evaluator policies', () => {
      const readTool = registry.get('read_file');
      expect(readTool?.evaluatorPolicy).toBe('bypass');

      const writeTool = registry.get('write_file');
      expect(writeTool?.evaluatorPolicy).toBe('required');

      const deleteTool = registry.get('delete_file');
      expect(deleteTool?.evaluatorPolicy).toBe('required');
    });
  });

  describe('Permission Checks', () => {
    it('should allow owner to use read_file', () => {
      const allowed = registry.checkPermission(
        'read_file',
        { actorClass: 'owner' },
        'private_chat'
      );
      expect(allowed).toBe(true);
    });

    it('should allow admin to use write_file', () => {
      const allowed = registry.checkPermission(
        'write_file',
        { actorClass: 'admin' },
        'admin_cli'
      );
      expect(allowed).toBe(true);
    });

    it('should deny regular user to use write_file', () => {
      const allowed = registry.checkPermission(
        'write_file',
        { actorClass: 'user' },
        'private_chat'
      );
      expect(allowed).toBe(false);
    });

    it('should deny regular user to use write/delete tools in ordinary chat contexts', () => {
      for (const toolName of ['write_file', 'delete_file']) {
        for (const invocationContext of ['private_chat', 'group_chat'] as const) {
          const allowed = registry.checkPermission(
            toolName,
            { actorClass: 'user' },
            invocationContext
          );
          expect(allowed).toBe(false);
        }
      }
    });

    it('should deny write_file in group_chat context', () => {
      const allowed = registry.checkPermission(
        'write_file',
        { actorClass: 'owner' },
        'group_chat'
      );
      expect(allowed).toBe(false);
    });
  });

  describe('Complete Workflow', () => {
    it('should write, read, list, and delete a file', async () => {
      const context: FileOperationContext = {
        toolCallId: 'test-call-1',
        turnId: 'test-turn-1',
        workspaceRoot: tempDir,
        sandboxPolicy: {
          filesystem: 'workspace_write',
          network: 'none',
          execution: 'in_process',
          maxRuntimeMs: 10000,
        },
      };

      // 1. Write a file
      const writeHandler = new WriteFileHandler();
      const writeResult = await writeHandler.execute(
        { path: 'test.txt', content: 'Hello, Integration Test!' },
        context
      );

      expect(writeResult.status).toBe('success');
      expect(writeResult.output?.created).toBe(true);

      // 2. Read the file
      const readHandler = new ReadFileHandler();
      const readResult = await readHandler.execute(
        { path: 'test.txt' },
        { ...context, toolCallId: 'test-call-2' }
      );

      expect(readResult.status).toBe('success');
      expect(readResult.output?.content).toBe('Hello, Integration Test!');

      // 3. List directory
      const listHandler = new ListDirectoryHandler();
      const listResult = await listHandler.execute(
        { path: '.' },
        { ...context, toolCallId: 'test-call-3' }
      );

      expect(listResult.status).toBe('success');
      expect(listResult.output?.entries).toHaveLength(1);
      expect(listResult.output?.entries[0].name).toBe('test.txt');

      // 4. Delete the file
      const deleteHandler = new DeleteFileHandler();
      const deleteResult = await deleteHandler.execute(
        { path: 'test.txt' },
        { ...context, toolCallId: 'test-call-4' }
      );

      expect(deleteResult.status).toBe('success');
      expect(deleteResult.output?.deleted).toBe(true);

      // 5. Verify deletion
      const listResult2 = await listHandler.execute(
        { path: '.' },
        { ...context, toolCallId: 'test-call-5' }
      );

      expect(listResult2.status).toBe('success');
      expect(listResult2.output?.entries).toHaveLength(0);
    });

    it('should handle multiple files', async () => {
      const context: FileOperationContext = {
        toolCallId: 'test-call',
        turnId: 'test-turn',
        workspaceRoot: tempDir,
        sandboxPolicy: {
          filesystem: 'workspace_write',
          network: 'none',
          execution: 'in_process',
          maxRuntimeMs: 10000,
        },
      };

      const writeHandler = new WriteFileHandler();

      // Write multiple files
      await writeHandler.execute(
        { path: 'file1.txt', content: 'Content 1' },
        context
      );
      await writeHandler.execute(
        { path: 'file2.txt', content: 'Content 2' },
        context
      );
      await writeHandler.execute(
        { path: 'docs/readme.md', content: '# README' },
        context
      );

      // List all files recursively
      const listHandler = new ListDirectoryHandler();
      const listResult = await listHandler.execute(
        { path: '.', recursive: true },
        context
      );

      expect(listResult.status).toBe('success');
      expect(listResult.output?.entries.length).toBeGreaterThanOrEqual(4); // 2 files + docs dir + readme

      const paths = listResult.output?.entries.map((e: any) => e.path).sort();
      expect(paths).toContain('file1.txt');
      expect(paths).toContain('file2.txt');
      expect(paths).toContain('docs/readme.md');
    });

    it('should enforce security across operations', async () => {
      const context: FileOperationContext = {
        toolCallId: 'test-call',
        turnId: 'test-turn',
        workspaceRoot: tempDir,
        sandboxPolicy: {
          filesystem: 'workspace_write',
          network: 'none',
          execution: 'in_process',
          maxRuntimeMs: 10000,
        },
      };

      const writeHandler = new WriteFileHandler();
      const readHandler = new ReadFileHandler();

      // Attempt to write outside workspace
      const writeResult = await writeHandler.execute(
        { path: '/etc/passwd', content: 'malicious' },
        context
      );
      expect(writeResult.status).toBe('rejected');

      // Attempt to read outside workspace
      const readResult = await readHandler.execute(
        { path: '/etc/passwd' },
        context
      );
      expect(readResult.status).toBe('rejected');

      // Attempt path traversal
      const traversalResult = await writeHandler.execute(
        { path: '../../../etc/passwd', content: 'malicious' },
        context
      );
      expect(traversalResult.status).toBe('rejected');
    });
  });

  describe('Audit Trail', () => {
    it('should generate audit summaries for all operations', async () => {
      const context: FileOperationContext = {
        toolCallId: 'test-call',
        turnId: 'test-turn',
        workspaceRoot: tempDir,
        sandboxPolicy: {
          filesystem: 'workspace_write',
          network: 'none',
          execution: 'in_process',
          maxRuntimeMs: 10000,
        },
      };

      const writeHandler = new WriteFileHandler();
      const readHandler = new ReadFileHandler();
      const listHandler = new ListDirectoryHandler();
      const deleteHandler = new DeleteFileHandler();

      // Write
      const writeResult = await writeHandler.execute(
        { path: 'test.txt', content: 'content' },
        context
      );
      expect(writeResult.auditSummary).toContain('write_file');
      expect(writeResult.executionTimeMs).toBeGreaterThanOrEqual(0);

      // Read
      const readResult = await readHandler.execute({ path: 'test.txt' }, context);
      expect(readResult.auditSummary).toContain('read_file');
      expect(readResult.executionTimeMs).toBeGreaterThanOrEqual(0);

      // List
      const listResult = await listHandler.execute({ path: '.' }, context);
      expect(listResult.auditSummary).toContain('list_directory');
      expect(listResult.executionTimeMs).toBeGreaterThanOrEqual(0);

      // Delete
      const deleteResult = await deleteHandler.execute(
        { path: 'test.txt' },
        context
      );
      expect(deleteResult.auditSummary).toContain('delete_file');
      expect(deleteResult.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
