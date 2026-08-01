import { describe, expect, it } from 'vitest';
import type { GovernanceScope } from '../../../src/http/governance-http-server.js';
import { GovernanceScopeHandleRegistry } from '../../../src/http/governance-scope-handle-registry.js';

const NOW = 1_800_000_000_000;
const SESSION_TTL_MS = 900_000;
const SESSION_A = 'a'.repeat(64);
const SESSION_B = 'b'.repeat(64);

describe('GovernanceScopeHandleRegistry', () => {
  it('issues stable opaque handles and round-trips defensive copies of every scope shape', () => {
    const now = { value: NOW };
    const registry = new GovernanceScopeHandleRegistry({ now: () => now.value });
    const secret = 'sk-scopehandleabcdefghijklmnopqrstuvwxyz123456';
    const platformId = '123456789';
    const scopes: GovernanceScope[] = [
      { kind: 'global' },
      { kind: 'user', canonicalUserId: `user-${platformId}-${secret}` },
      { kind: 'group', groupId: `group-${platformId}-${secret}` },
      {
        kind: 'conversation',
        conversationId: `private-${platformId}-${secret}`,
        conversationType: 'private',
      },
      {
        kind: 'conversation',
        conversationId: `group-conversation-${platformId}-${secret}`,
        conversationType: 'group',
        groupId: `group-${platformId}-${secret}`,
      },
      { kind: 'tool', toolName: `tool-${platformId}-${secret}` },
      { kind: 'system' },
    ];

    const issued = scopes.map((scope) => registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.review.read',
      scope,
    }));

    expect(issued.every((record) => /^[A-Za-z0-9_-]{43}$/u.test(record.handle))).toBe(true);
    expect(issued.every((record) => record.expiresAt === now.value + SESSION_TTL_MS)).toBe(true);
    expect(new Set(issued.map((record) => record.handle))).toHaveProperty('size', scopes.length);
    expect(JSON.stringify(issued)).not.toContain(secret);
    expect(JSON.stringify(issued)).not.toContain(platformId);
    scopes.forEach((scope, index) => {
      expect(registry.resolve({
        sessionId: SESSION_A,
        handle: issued[index]?.handle ?? '',
        purpose: 'memory.review.read',
      })).toEqual(scope);
    });

    const repeated = registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.review.read',
      scope: scopes[1] as GovernanceScope,
    });
    expect(repeated).toEqual(issued[1]);
    const otherPurpose = registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.review.write',
      scope: scopes[1] as GovernanceScope,
    });
    expect(otherPurpose.handle).not.toBe(repeated.handle);

    const firstResolved = registry.resolve({
      sessionId: SESSION_A,
      handle: repeated.handle,
      purpose: 'memory.review.read',
    });
    expect(firstResolved?.kind).toBe('user');
    if (firstResolved?.kind === 'user') {
      (firstResolved as { canonicalUserId: string }).canonicalUserId = 'changed-after-resolve';
    }
    expect(registry.resolve({
      sessionId: SESSION_A,
      handle: repeated.handle,
      purpose: 'memory.review.read',
    })).toEqual(scopes[1]);
  });

  it('denies cross-boundary, expired, revoked, cleared, and restarted lookups', () => {
    const now = { value: NOW };
    const registry = new GovernanceScopeHandleRegistry({ now: () => now.value });
    const issued = registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.review.read',
      scope: { kind: 'global' },
    });

    expect(registry.resolve({
      sessionId: SESSION_B,
      handle: issued.handle,
      purpose: 'memory.review.read',
    })).toBeNull();
    expect(registry.resolve({
      sessionId: SESSION_A,
      handle: issued.handle,
      purpose: 'memory.review.write',
    })).toBeNull();
    expect(registry.resolve({
      sessionId: SESSION_A,
      handle: 'z'.repeat(43),
      purpose: 'memory.review.read',
    })).toBeNull();
    expect(new GovernanceScopeHandleRegistry({ now: () => now.value }).resolve({
      sessionId: SESSION_A,
      handle: issued.handle,
      purpose: 'memory.review.read',
    })).toBeNull();

    now.value += SESSION_TTL_MS;
    expect(registry.resolve({
      sessionId: SESSION_A,
      handle: issued.handle,
      purpose: 'memory.review.read',
    })).toBeNull();

    const afterExpiry = registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.review.read',
      scope: { kind: 'global' },
    });
    expect(afterExpiry.handle).not.toBe(issued.handle);
    registry.revokeSession(SESSION_A);
    expect(registry.resolve({
      sessionId: SESSION_A,
      handle: afterExpiry.handle,
      purpose: 'memory.review.read',
    })).toBeNull();

    const beforeClear = registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.review.read',
      scope: { kind: 'system' },
    });
    registry.clear();
    expect(registry.resolve({
      sessionId: SESSION_A,
      handle: beforeClear.handle,
      purpose: 'memory.review.read',
    })).toBeNull();
  });

  it('rejects malformed input and enforces session and per-session capacity atomically', () => {
    const now = { value: NOW };
    const registry = new GovernanceScopeHandleRegistry({ now: () => now.value });
    const sensitiveValue = 'sensitive-session-or-scope-value';
    const validInput = {
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.review.read',
      scope: { kind: 'global' } as GovernanceScope,
    };
    const malformed = [
      { ...validInput, sessionId: sensitiveValue },
      { ...validInput, sessionExpiresAt: now.value },
      { ...validInput, sessionExpiresAt: now.value + 3_600_001 },
      { ...validInput, purpose: '' },
      { ...validInput, purpose: `memory.read\n${sensitiveValue}` },
      {
        ...validInput,
        scope: { kind: 'user', canonicalUserId: ` ${sensitiveValue}` } as GovernanceScope,
      },
      {
        ...validInput,
        scope: {
          kind: 'conversation',
          conversationId: sensitiveValue,
          conversationType: 'group',
        } as GovernanceScope,
      },
    ];
    for (const input of malformed) {
      expect(() => registry.issue(input)).toThrow('Invalid governance scope handle input');
      try {
        registry.issue(input);
      } catch (error) {
        expect(String(error)).not.toContain(sensitiveValue);
      }
    }

    const sessionIds = Array.from(
      { length: 9 },
      (_, index) => index.toString(16).padStart(64, '0'),
    );
    const issued = sessionIds.slice(0, 8).map((sessionId) => registry.issue({
      ...validInput,
      sessionId,
    }));
    expect(() => registry.issue({
      ...validInput,
      sessionId: sessionIds[8] as string,
    })).toThrow('Governance scope handle capacity exceeded');
    expect(registry.resolve({
      sessionId: sessionIds[0] as string,
      handle: issued[0]?.handle ?? '',
      purpose: validInput.purpose,
    })).toEqual({ kind: 'global' });

    registry.revokeSession(sessionIds[0] as string);
    registry.issue({ ...validInput, sessionId: sessionIds[8] as string });
    for (let index = 0; index < 511; index += 1) {
      registry.issue({
        ...validInput,
        sessionId: sessionIds[8] as string,
        scope: { kind: 'user', canonicalUserId: `bounded-user-${index}` },
      });
    }
    expect(() => registry.issue({
      ...validInput,
      sessionId: sessionIds[8] as string,
      scope: { kind: 'user', canonicalUserId: 'one-binding-too-many' },
    })).toThrow('Governance scope handle capacity exceeded');
    expect(registry.resolve({
      sessionId: sessionIds[8] as string,
      handle: registry.issue({ ...validInput, sessionId: sessionIds[8] as string }).handle,
      purpose: validInput.purpose,
    })).toEqual({ kind: 'global' });

    now.value += SESSION_TTL_MS;
    expect(() => registry.issue({
      ...validInput,
      sessionId: SESSION_B,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
    })).not.toThrow();
  });
});
