/**
 * Governance CLI
 *
 * 治理命令行工具（Phase L）
 */

import type { MemoryRepository } from '../storage/memory-repository';
import type { MemoryRecord } from '../types/memory';

export interface ListMemoryOptions {
  userId?: string;
  groupId?: string;
  state?: MemoryRecord['state'];
  scope?: string;
}

export interface CommandResult {
  success: boolean;
  message?: string;
  error?: string;
}

export class GovernanceCLI {
  constructor(private readonly memoryRepo: MemoryRepository) {}

  /**
   * 列出记忆记录
   */
  async listMemory(options: ListMemoryOptions): Promise<MemoryRecord[]> {
    const filters: Parameters<typeof this.memoryRepo.retrieve>[0] = {};

    if (options.userId) {
      filters.canonicalUserId = options.userId;
    }

    if (options.groupId) {
      filters.groupId = options.groupId;
    }

    if (options.state) {
      filters.state = options.state;
    } else {
      filters.state = 'active';
    }

    return this.memoryRepo.retrieve(filters);
  }

  /**
   * 删除记忆记录
   */
  async deleteMemory(memoryId: string): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing) {
        return {
          success: false,
          error: `Memory ${memoryId} not found`,
        };
      }

      await this.memoryRepo.updateState(memoryId, 'deleted');

      return {
        success: true,
        message: `Memory ${memoryId} deleted`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 禁用记忆记录
   */
  async disableMemory(memoryId: string): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing) {
        return {
          success: false,
          error: `Memory ${memoryId} not found`,
        };
      }

      await this.memoryRepo.updateState(memoryId, 'disabled');

      return {
        success: true,
        message: `Memory ${memoryId} disabled`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 启用记忆记录
   */
  async enableMemory(memoryId: string): Promise<CommandResult> {
    try {
      const existing = await this.memoryRepo.findById(memoryId);

      if (!existing || existing.state !== 'disabled') {
        return {
          success: false,
          error: `Memory ${memoryId} not found or not disabled`,
        };
      }

      await this.memoryRepo.updateState(memoryId, 'active');

      return {
        success: true,
        message: `Memory ${memoryId} enabled`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
