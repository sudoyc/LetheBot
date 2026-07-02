/**
 * File Operations Tools
 *
 * 文件操作工具集合，提供读取、写入、列出、删除等基础文件操作
 */

import type { ToolHandlerRequest, ToolRegistryEntry } from '../../types/tool';
import type { SandboxPolicy } from '../../types/tool';
import type { FileOperationContext } from './path-validator';
import { ReadFileHandler } from './handlers/read-file';
import { WriteFileHandler } from './handlers/write-file';
import { ListDirectoryHandler } from './handlers/list-directory';
import { DeleteFileHandler } from './handlers/delete-file';

const readFileHandler = new ReadFileHandler();
const writeFileHandler = new WriteFileHandler();
const listDirectoryHandler = new ListDirectoryHandler();
const deleteFileHandler = new DeleteFileHandler();

function buildFileOperationContext(
  request: ToolHandlerRequest,
  sandboxPolicy: SandboxPolicy
): FileOperationContext {
  return {
    toolCallId: request.toolCallId,
    turnId: request.turnId,
    workspaceRoot: process.env.LETHEBOT_WORKSPACE_ROOT ?? process.cwd(),
    sandboxPolicy,
    allowedPaths: sandboxPolicy.allowedPaths,
  };
}

/**
 * 读取文件工具
 */
export const readFileTool: ToolRegistryEntry = {
  name: 'read_file',
  version: '1.0.0',
  description: '读取本地文件内容',
  capabilities: ['read_local'],
  permissions: {
    allowedActors: ['owner', 'admin', 'trusted_user'],
    allowedContexts: ['private_chat', 'admin_cli', 'internal'],
  },
  evaluatorPolicy: 'bypass',
  auditLevel: 'summary',
  sandboxPolicy: {
    filesystem: 'workspace_write',
    network: 'none',
    execution: 'in_process',
    maxRuntimeMs: 5000,
    maxOutputBytes: 1048576, // 1MB
  },
  outputSensitivity: 'secret_possible',
  piSchema: {
    input: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径（相对于 workspace 或绝对路径）',
        },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64', 'binary'],
          default: 'utf8',
        },
      },
      required: ['path'],
    },
    output: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        size: { type: 'number' },
        mtime: { type: 'string', format: 'date-time' },
        encoding: { type: 'string' },
      },
      required: ['content'],
    },
  },
  handler: async (request) => readFileHandler.execute(
    request.input as Parameters<ReadFileHandler['execute']>[0],
    buildFileOperationContext(request, readFileTool.sandboxPolicy)
  ),
};

/**
 * 写入文件工具
 */
export const writeFileTool: ToolRegistryEntry = {
  name: 'write_file',
  version: '1.0.0',
  description: '写入内容到本地文件',
  capabilities: ['write_local'],
  permissions: {
    allowedActors: ['owner', 'admin'],
    allowedContexts: ['admin_cli', 'internal'],
  },
  evaluatorPolicy: 'required',
  auditLevel: 'redacted_full',
  sandboxPolicy: {
    filesystem: 'workspace_write',
    network: 'none',
    execution: 'in_process',
    maxRuntimeMs: 10000,
  },
  outputSensitivity: 'normal',
  piSchema: {
    input: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径',
        },
        content: {
          type: 'string',
          description: '文件内容',
        },
        encoding: {
          type: 'string',
          enum: ['utf8', 'base64'],
          default: 'utf8',
        },
        overwrite: {
          type: 'boolean',
          default: false,
        },
      },
      required: ['path', 'content'],
    },
    output: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        size: { type: 'number' },
        created: { type: 'boolean' },
      },
    },
  },
  handler: async (request) => writeFileHandler.execute(
    request.input as Parameters<WriteFileHandler['execute']>[0],
    buildFileOperationContext(request, writeFileTool.sandboxPolicy)
  ),
};

/**
 * 列出目录工具
 */
export const listDirectoryTool: ToolRegistryEntry = {
  name: 'list_directory',
  version: '1.0.0',
  description: '列出目录内容',
  capabilities: ['read_local'],
  permissions: {
    allowedActors: ['owner', 'admin', 'trusted_user'],
    allowedContexts: ['private_chat', 'admin_cli', 'internal'],
  },
  evaluatorPolicy: 'bypass',
  auditLevel: 'summary',
  sandboxPolicy: {
    filesystem: 'workspace_write',
    network: 'none',
    execution: 'in_process',
    maxRuntimeMs: 3000,
  },
  outputSensitivity: 'personal',
  piSchema: {
    input: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录路径',
        },
        recursive: {
          type: 'boolean',
          default: false,
        },
        pattern: {
          type: 'string',
          description: 'glob pattern（可选）',
        },
      },
      required: ['path'],
    },
    output: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              type: {
                type: 'string',
                enum: ['file', 'directory', 'symlink'],
              },
              size: { type: 'number' },
              mtime: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
  handler: async (request) => listDirectoryHandler.execute(
    request.input as Parameters<ListDirectoryHandler['execute']>[0],
    buildFileOperationContext(request, listDirectoryTool.sandboxPolicy)
  ),
};

/**
 * 删除文件工具
 */
export const deleteFileTool: ToolRegistryEntry = {
  name: 'delete_file',
  version: '1.0.0',
  description: '删除本地文件或目录',
  capabilities: ['write_local'],
  permissions: {
    allowedActors: ['owner', 'admin'],
    allowedContexts: ['admin_cli', 'internal'],
  },
  evaluatorPolicy: 'required',
  auditLevel: 'full',
  sandboxPolicy: {
    filesystem: 'workspace_write',
    network: 'none',
    execution: 'in_process',
    maxRuntimeMs: 5000,
  },
  outputSensitivity: 'normal',
  piSchema: {
    input: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
        },
        recursive: {
          type: 'boolean',
          default: false,
        },
      },
      required: ['path'],
    },
    output: {
      type: 'object',
      properties: {
        deleted: { type: 'boolean' },
        path: { type: 'string' },
      },
    },
  },
  handler: async (request) => deleteFileHandler.execute(
    request.input as Parameters<DeleteFileHandler['execute']>[0],
    buildFileOperationContext(request, deleteFileTool.sandboxPolicy)
  ),
};

/**
 * 所有文件操作工具
 */
export const fileOperationTools: ToolRegistryEntry[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  deleteFileTool,
];

// 导出处理器
export * from './handlers';
export * from './path-validator';
