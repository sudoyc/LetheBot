import { describe, it, expect } from 'vitest';
import type {
  MemoryRecord,
  MemorySource,
  MemoryRevision,
} from '../../../src/types/memory';

describe('Memory Records', () => {
  describe('MemoryRecord', () => {
    it('should allow creating a complete memory record', () => {
      const memory: MemoryRecord = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        scope: 'user',
        canonicalUserId: 'user-001',
        visibility: 'private_only',
        sensitivity: 'personal',
        authority: 'user_stated',
        kind: 'preference',
        title: 'Communication style',
        content: 'Prefers direct and concise responses',
        state: 'active',
        confidence: 0.95,
        importance: 0.8,
        sourceContext: 'chat_message:msg-123',
        sourceEventIds: ['event-001', 'event-002'],
        evaluatorDecisionId: 'eval-001',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-15'),
        expiresAt: new Date('2025-01-01'),
      };

      expect(memory.id).toBeTruthy();
      expect(memory.scope).toBe('user');
      expect(memory.state).toBe('active');
      expect(memory.confidence).toBe(0.95);
    });

    it('should support different scopes', () => {
      const userMemory: MemoryRecord = {
        id: 'mem-001',
        scope: 'user',
        canonicalUserId: 'user-001',
        visibility: 'same_user_any_context',
        sensitivity: 'normal',
        authority: 'inferred',
        kind: 'fact',
        title: 'User fact',
        content: 'Enjoys technical discussions',
        state: 'active',
        confidence: 0.8,
        importance: 0.6,
        sourceContext: 'chat',
        sourceEventIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const groupMemory: MemoryRecord = {
        id: 'mem-002',
        scope: 'group',
        groupId: 'group-123',
        visibility: 'same_group_only',
        sensitivity: 'normal',
        authority: 'system',
        kind: 'constraint',
        title: 'Group rule',
        content: 'No advertising allowed',
        state: 'active',
        confidence: 1.0,
        importance: 0.9,
        sourceContext: 'admin_command',
        sourceEventIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(userMemory.scope).toBe('user');
      expect(groupMemory.scope).toBe('group');
      expect(groupMemory.groupId).toBe('group-123');
    });

    it('should support all memory kinds', () => {
      const kinds: Array<MemoryRecord['kind']> = [
        'preference',
        'fact',
        'constraint',
        'summary',
        'reflection',
        'procedure',
      ];

      kinds.forEach((kind) => {
        const memory: MemoryRecord = {
          id: `mem-${kind}`,
          scope: 'user',
          canonicalUserId: 'user-001',
          visibility: 'private_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind,
          title: `Test ${kind}`,
          content: `Content for ${kind}`,
          state: 'active',
          confidence: 0.8,
          importance: 0.5,
          sourceContext: 'test',
          sourceEventIds: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        expect(memory.kind).toBe(kind);
      });
    });

    it('should support all memory states', () => {
      const states: Array<MemoryRecord['state']> = [
        'proposed',
        'active',
        'rejected',
        'superseded',
        'disabled',
        'deleted',
      ];

      states.forEach((state) => {
        const memory: MemoryRecord = {
          id: `mem-${state}`,
          scope: 'user',
          canonicalUserId: 'user-001',
          visibility: 'private_only',
          sensitivity: 'normal',
          authority: 'user_stated',
          kind: 'fact',
          title: 'Test',
          content: 'Content',
          state,
          confidence: 0.8,
          importance: 0.5,
          sourceContext: 'test',
          sourceEventIds: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        expect(memory.state).toBe(state);
      });
    });

    it('should allow minimal memory record', () => {
      const memory: MemoryRecord = {
        id: 'mem-minimal',
        scope: 'global',
        visibility: 'public',
        sensitivity: 'normal',
        authority: 'system',
        kind: 'fact',
        title: 'Global fact',
        content: 'This is a global fact',
        state: 'active',
        confidence: 1.0,
        importance: 0.5,
        sourceContext: 'system_init',
        sourceEventIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(memory.canonicalUserId).toBeUndefined();
      expect(memory.groupId).toBeUndefined();
      expect(memory.expiresAt).toBeUndefined();
    });
  });

  describe('MemorySource', () => {
    it('should allow creating memory sources', () => {
      const source: MemorySource = {
        memoryId: 'mem-001',
        sourceType: 'chat_message',
        sourceId: 'msg-123',
        sourceTimestamp: new Date(),
        extractedBy: 'evaluator',
      };

      expect(source.memoryId).toBe('mem-001');
      expect(source.sourceType).toBe('chat_message');
      expect(source.extractedBy).toBe('evaluator');
    });

    it('should support all source types', () => {
      const types: Array<MemorySource['sourceType']> = [
        'raw_event',
        'chat_message',
        'tool_output',
        'worker_extraction',
        'user_command',
      ];

      types.forEach((sourceType) => {
        const source: MemorySource = {
          memoryId: 'mem-001',
          sourceType,
          sourceId: `src-${sourceType}`,
          sourceTimestamp: new Date(),
        };

        expect(source.sourceType).toBe(sourceType);
      });
    });

    it('should allow source without extractedBy', () => {
      const source: MemorySource = {
        memoryId: 'mem-001',
        sourceType: 'raw_event',
        sourceId: 'event-001',
        sourceTimestamp: new Date(),
      };

      expect(source.extractedBy).toBeUndefined();
    });
  });

  describe('MemoryRevision', () => {
    it('should allow creating memory revisions', () => {
      const revision: MemoryRevision = {
        id: 'rev-001',
        memoryId: 'mem-001',
        revisionNumber: 1,
        previousState: {},
        newState: {
          content: 'Updated content',
          confidence: 0.9,
        },
        reason: 'User corrected information',
        changeType: 'update',
        actor: 'user-001',
        evaluatorDecisionId: 'eval-001',
        createdAt: new Date(),
      };

      expect(revision.memoryId).toBe('mem-001');
      expect(revision.revisionNumber).toBe(1);
      expect(revision.changeType).toBe('update');
    });

    it('should support all change types', () => {
      const types: Array<MemoryRevision['changeType']> = [
        'create',
        'update',
        'approve',
        'reject',
        'supersede',
        'disable',
        'delete',
        'restore',
      ];

      types.forEach((changeType) => {
        const revision: MemoryRevision = {
          id: `rev-${changeType}`,
          memoryId: 'mem-001',
          revisionNumber: 1,
          previousState: {},
          newState: {},
          reason: `Test ${changeType}`,
          changeType,
          actor: 'system',
          createdAt: new Date(),
        };

        expect(revision.changeType).toBe(changeType);
      });
    });

    it('should allow revision without evaluatorDecisionId', () => {
      const revision: MemoryRevision = {
        id: 'rev-002',
        memoryId: 'mem-001',
        revisionNumber: 2,
        previousState: { state: 'active' },
        newState: { state: 'disabled' },
        reason: 'Manual disable by admin',
        changeType: 'disable',
        actor: 'user-admin',
        createdAt: new Date(),
      };

      expect(revision.evaluatorDecisionId).toBeUndefined();
    });

    it('should track state changes in previousState and newState', () => {
      const revision: MemoryRevision = {
        id: 'rev-003',
        memoryId: 'mem-001',
        revisionNumber: 3,
        previousState: {
          content: 'Old content',
          confidence: 0.7,
          importance: 0.5,
        },
        newState: {
          content: 'New content',
          confidence: 0.9,
          importance: 0.8,
        },
        reason: 'More accurate information available',
        changeType: 'update',
        actor: 'evaluator',
        createdAt: new Date(),
      };

      expect(revision.previousState.content).toBe('Old content');
      expect(revision.newState.content).toBe('New content');
    });
  });
});
