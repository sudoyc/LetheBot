import { describe, it, expect } from 'vitest';
import { BackgroundWorker } from '../../../src/workers/background';

describe('BackgroundWorker', () => {
  const worker = new BackgroundWorker();

  describe('enqueue', () => {
    it('should enqueue summary task', () => {
      const taskId = worker.enqueue({
        type: 'summary',
        payload: {
          conversationId: 'conv-001',
          messageRange: { start: 'msg-001', end: 'msg-010' },
        },
      });

      expect(taskId).toBeDefined();
      expect(taskId).toMatch(/^task-/);
    });

    it('should enqueue extraction task', () => {
      const taskId = worker.enqueue({
        type: 'extraction',
        payload: {
          conversationId: 'conv-002',
          targetUserId: 'user-alice',
          extractionHint: 'user preferences',
        },
      });

      expect(taskId).toBeDefined();
    });
  });

  describe('getStatus', () => {
    it('should return pending status for new task', () => {
      const taskId = worker.enqueue({
        type: 'summary',
        payload: { conversationId: 'conv-003', messageRange: { start: 'msg-001', end: 'msg-002' } },
      });

      const status = worker.getStatus(taskId);
      expect(status).toBe('pending');
    });

    it('should return undefined for unknown task', () => {
      const status = worker.getStatus('nonexistent-task');
      expect(status).toBeUndefined();
    });
  });

  describe('list', () => {
    it('should list all tasks', () => {
      const worker2 = new BackgroundWorker();

      worker2.enqueue({
        type: 'summary',
        payload: { conversationId: 'conv-004', messageRange: { start: 'msg-001', end: 'msg-005' } },
      });

      worker2.enqueue({
        type: 'extraction',
        payload: { conversationId: 'conv-005', targetUserId: 'user-bob', extractionHint: 'facts' },
      });

      const tasks = worker2.list();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].type).toBe('summary');
      expect(tasks[1].type).toBe('extraction');
    });
  });

  describe('processNext', () => {
    it('should process summary task', async () => {
      const worker3 = new BackgroundWorker();

      const taskId = worker3.enqueue({
        type: 'summary',
        payload: { conversationId: 'conv-006', messageRange: { start: 'msg-001', end: 'msg-003' } },
      });

      const result = await worker3.processNext();

      expect(result).toBeDefined();
      expect(result?.taskId).toBe(taskId);
      expect(result?.status).toBe('completed');
      expect(worker3.getStatus(taskId)).toBe('completed');
    });

    it('should return null when queue is empty', async () => {
      const worker4 = new BackgroundWorker();
      const result = await worker4.processNext();
      expect(result).toBeNull();
    });
  });
});
