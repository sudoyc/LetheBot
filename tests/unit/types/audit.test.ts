import { describe, it, expect } from 'vitest';
import type { AuditEntry, ErrorEnvelope } from '../../../src/types/audit';

describe('Audit & Errors', () => {
  describe('AuditEntry', () => {
    it('should allow creating audit entries', () => {
      const entry: AuditEntry = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        timestamp: new Date(),
        category: 'tool',
        level: 'summary',
        eventType: 'tool.executed',
        eventId: 'tool-call-001',
        actor: {
          canonicalUserId: 'user-001',
          actorClass: 'user',
          context: 'group_chat',
        },
        summary: 'User executed search tool',
        redacted: false,
        riskLevel: 'low',
      };

      expect(entry.category).toBe('tool');
      expect(entry.level).toBe('summary');
      expect(entry.redacted).toBe(false);
    });

    it('should support all categories', () => {
      const categories: Array<AuditEntry['category']> = [
        'tool',
        'memory',
        'social',
        'evaluator',
        'system',
      ];

      categories.forEach((category) => {
        const entry: AuditEntry = {
          id: `audit-${category}`,
          timestamp: new Date(),
          category,
          level: 'summary',
          eventType: `${category}.test`,
          eventId: 'event-001',
          actor: {
            actorClass: 'system_worker',
            context: 'internal',
          },
          summary: `Test ${category} event`,
          redacted: false,
        };

        expect(entry.category).toBe(category);
      });
    });

    it('should support all audit levels', () => {
      const levels: Array<AuditEntry['level']> = [
        'summary',
        'redacted_full',
        'full',
      ];

      levels.forEach((level) => {
        const entry: AuditEntry = {
          id: `audit-${level}`,
          timestamp: new Date(),
          category: 'system',
          level,
          eventType: 'test.event',
          eventId: 'event-001',
          actor: {
            actorClass: 'system_worker',
            context: 'internal',
          },
          summary: 'Test event',
          redacted: level !== 'full',
        };

        expect(entry.level).toBe(level);
      });
    });

    it('should allow audit entries with full details', () => {
      const entry: AuditEntry = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        timestamp: new Date(),
        category: 'memory',
        level: 'full',
        eventType: 'memory.created',
        eventId: 'mem-001',
        actor: {
          canonicalUserId: 'user-001',
          actorClass: 'user',
          context: 'private_chat',
        },
        summary: 'User created memory',
        details: {
          memoryId: 'mem-001',
          scope: 'user',
          title: 'User preference',
          content: 'Full content here',
        },
        redacted: false,
        riskLevel: 'low',
        evaluatorDecisionId: 'eval-001',
      };

      expect(entry.details).toBeDefined();
      expect(entry.evaluatorDecisionId).toBe('eval-001');
    });

    it('should allow redacted audit entries', () => {
      const entry: AuditEntry = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        timestamp: new Date(),
        category: 'social',
        level: 'redacted_full',
        eventType: 'message.sent',
        eventId: 'msg-001',
        actor: {
          canonicalUserId: 'user-001',
          actorClass: 'user',
          context: 'group_chat',
        },
        summary: 'User sent message',
        details: {
          messageId: 'msg-001',
          content: '[REDACTED]',
        },
        redacted: true,
        riskLevel: 'medium',
      };

      expect(entry.redacted).toBe(true);
      expect(entry.riskLevel).toBe('medium');
    });

    it('should allow system actor without userId', () => {
      const entry: AuditEntry = {
        id: '01HZXYZ1234567890ABCDEFGHI',
        timestamp: new Date(),
        category: 'system',
        level: 'summary',
        eventType: 'worker.started',
        eventId: 'worker-001',
        actor: {
          actorClass: 'system_worker',
          context: 'background_worker',
        },
        summary: 'Background worker started',
        redacted: false,
      };

      expect(entry.actor.canonicalUserId).toBeUndefined();
    });
  });

  describe('ErrorEnvelope', () => {
    it('should allow creating error envelopes', () => {
      const error: ErrorEnvelope = {
        code: 'MEMORY_NOT_FOUND',
        message: 'Memory record not found',
        category: 'not_found',
        recoverable: true,
        details: {
          memoryId: 'mem-001',
        },
      };

      expect(error.code).toBe('MEMORY_NOT_FOUND');
      expect(error.category).toBe('not_found');
      expect(error.recoverable).toBe(true);
    });

    it('should support all error categories', () => {
      const categories: Array<ErrorEnvelope['category']> = [
        'validation',
        'permission',
        'not_found',
        'conflict',
        'rate_limit',
        'internal',
      ];

      categories.forEach((category) => {
        const error: ErrorEnvelope = {
          code: `TEST_${category.toUpperCase()}`,
          message: `Test ${category} error`,
          category,
          recoverable: category !== 'internal',
        };

        expect(error.category).toBe(category);
      });
    });

    it('should allow validation errors', () => {
      const error: ErrorEnvelope = {
        code: 'INVALID_INPUT',
        message: 'Invalid input provided',
        category: 'validation',
        recoverable: true,
        details: {
          field: 'email',
          reason: 'Invalid format',
        },
      };

      expect(error.category).toBe('validation');
      expect(error.details).toBeDefined();
    });

    it('should allow permission errors', () => {
      const error: ErrorEnvelope = {
        code: 'PERMISSION_DENIED',
        message: 'User does not have permission',
        category: 'permission',
        recoverable: false,
        details: {
          requiredRole: 'admin',
          actualRole: 'user',
        },
      };

      expect(error.category).toBe('permission');
      expect(error.recoverable).toBe(false);
    });

    it('should allow internal errors with stack traces', () => {
      const originalError = new Error('Something went wrong');
      const error: ErrorEnvelope = {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred',
        category: 'internal',
        recoverable: false,
        stack: originalError.stack,
        internalError: originalError,
      };

      expect(error.category).toBe('internal');
      expect(error.stack).toBeDefined();
      expect(error.internalError).toBe(originalError);
    });

    it('should allow minimal error envelopes', () => {
      const error: ErrorEnvelope = {
        code: 'UNKNOWN_ERROR',
        message: 'An unknown error occurred',
        category: 'internal',
        recoverable: false,
      };

      expect(error.details).toBeUndefined();
      expect(error.stack).toBeUndefined();
      expect(error.internalError).toBeUndefined();
    });

    it('should allow rate limit errors', () => {
      const error: ErrorEnvelope = {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests',
        category: 'rate_limit',
        recoverable: true,
        details: {
          retryAfter: 60,
          limit: 100,
          current: 101,
        },
      };

      expect(error.category).toBe('rate_limit');
      expect(error.recoverable).toBe(true);
    });

    it('should allow conflict errors', () => {
      const error: ErrorEnvelope = {
        code: 'RESOURCE_CONFLICT',
        message: 'Resource already exists',
        category: 'conflict',
        recoverable: false,
        details: {
          resourceId: 'res-001',
          conflictType: 'duplicate',
        },
      };

      expect(error.category).toBe('conflict');
    });
  });
});
