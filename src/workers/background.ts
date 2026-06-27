/**
 * Background Worker
 *
 * 后台任务工作器（Phase K 最小实现）
 */

export type TaskType = 'summary' | 'extraction';

export interface BackgroundTask {
  id: string;
  type: TaskType;
  payload: {
    conversationId: string;
    messageRange?: { start: string; end: string };
    targetUserId?: string;
    extractionHint?: string;
  };
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
}

export interface TaskResult {
  taskId: string;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: string;
}

export class BackgroundWorker {
  private tasks = new Map<string, BackgroundTask>();
  private taskCounter = 0;

  /**
   * 入队任务
   */
  enqueue(task: Pick<BackgroundTask, 'type' | 'payload'>): string {
    this.taskCounter++;
    const id = `task-${this.taskCounter.toString().padStart(6, '0')}`;

    this.tasks.set(id, {
      id,
      type: task.type,
      payload: task.payload,
      status: 'pending',
      createdAt: new Date(),
    });

    return id;
  }

  /**
   * 获取任务状态
   */
  getStatus(taskId: string): BackgroundTask['status'] | undefined {
    return this.tasks.get(taskId)?.status;
  }

  /**
   * 列出所有任务
   */
  list(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 处理下一个待处理任务
   */
  async processNext(): Promise<TaskResult | null> {
    const pending = Array.from(this.tasks.values()).find((t) => t.status === 'pending');

    if (!pending) {
      return null;
    }

    pending.status = 'processing';

    try {
      // Phase K 桩实现：模拟处理
      await this.processTask(pending);

      pending.status = 'completed';
      pending.completedAt = new Date();

      return {
        taskId: pending.id,
        status: 'completed',
        output: { summary: 'Stub summary' },
      };
    } catch (error) {
      pending.status = 'failed';
      pending.completedAt = new Date();

      return {
        taskId: pending.id,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 处理任务（桩实现）
   */
  private async processTask(task: BackgroundTask): Promise<void> {
    // Phase K 桩实现：模拟异步处理
    await new Promise((resolve) => setTimeout(resolve, 10));

    if (task.type === 'summary') {
      // 模拟摘要生成
      return;
    }

    if (task.type === 'extraction') {
      // 模拟记忆提取
      return;
    }
  }
}
