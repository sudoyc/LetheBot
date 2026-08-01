import { describe, expect, it } from 'vitest';
import type { GovernanceScope } from '../../../src/http/governance-http-server.js';
import { GovernanceResourceHandleRegistry } from '../../../src/http/governance-resource-handle-registry.js';

const NOW = 1_800_000_000_000;
const SESSION_TTL_MS = 900_000;
const SESSION_A = 'a'.repeat(64);
const SESSION_B = 'b'.repeat(64);
const RESOURCE_KIND = 'memory_maintenance_review';

describe('GovernanceResourceHandleRegistry', () => {
  it('issues stable opaque handles bound to defensive copies of every scope shape', () => {
    const now = { value: NOW };
    const registry = new GovernanceResourceHandleRegistry({ now: () => now.value });
    const secret = 'sk-resourcehandleabcdefghijklmnopqrstuvwxyz123456';
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

    const issued = scopes.map((scope, index) => registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.maintenance.review',
      resourceKind: RESOURCE_KIND,
      resourceId: `proposal-${platformId}-${secret}-${index}`,
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
        purpose: 'memory.maintenance.review',
        resourceKind: RESOURCE_KIND,
        scope,
      })).toEqual({
        kind: RESOURCE_KIND,
        resourceId: `proposal-${platformId}-${secret}-${index}`,
      });
    });

    const repeated = registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.maintenance.review',
      resourceKind: RESOURCE_KIND,
      resourceId: `proposal-${platformId}-${secret}-1`,
      scope: scopes[1] as GovernanceScope,
    });
    expect(repeated).toEqual(issued[1]);
    const otherResource = registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.maintenance.review',
      resourceKind: RESOURCE_KIND,
      resourceId: 'different-proposal',
      scope: scopes[1] as GovernanceScope,
    });
    expect(otherResource.handle).not.toBe(repeated.handle);

    const mutableScope: { kind: 'user'; canonicalUserId: string } = {
      kind: 'user',
      canonicalUserId: 'original-user',
    };
    const defensive = registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.maintenance.review',
      resourceKind: RESOURCE_KIND,
      resourceId: 'defensive-proposal',
      scope: mutableScope,
    });
    mutableScope.canonicalUserId = 'changed-user';
    expect(registry.resolve({
      sessionId: SESSION_A,
      handle: defensive.handle,
      purpose: 'memory.maintenance.review',
      resourceKind: RESOURCE_KIND,
      scope: { kind: 'user', canonicalUserId: 'original-user' },
    })).toEqual({ kind: RESOURCE_KIND, resourceId: 'defensive-proposal' });
    expect(registry.resolve({
      sessionId: SESSION_A,
      handle: defensive.handle,
      purpose: 'memory.maintenance.review',
      resourceKind: RESOURCE_KIND,
      scope: mutableScope,
    })).toBeNull();
  });

  it('denies cross-boundary, expired, revoked, cleared, and restarted lookups', () => {
    const now = { value: NOW };
    const registry = new GovernanceResourceHandleRegistry({ now: () => now.value });
    const issued = registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.maintenance.review',
      resourceKind: RESOURCE_KIND,
      resourceId: 'proposal-a',
      scope: { kind: 'system' },
    });
    const validResolution = {
      sessionId: SESSION_A,
      handle: issued.handle,
      purpose: 'memory.maintenance.review',
      resourceKind: RESOURCE_KIND,
      scope: { kind: 'system' } as GovernanceScope,
    };

    expect(registry.resolve({ ...validResolution, sessionId: SESSION_B })).toBeNull();
    expect(registry.resolve({ ...validResolution, purpose: 'memory.maintenance.apply' })).toBeNull();
    expect(registry.resolve({ ...validResolution, resourceKind: 'memory_record' })).toBeNull();
    expect(registry.resolve({ ...validResolution, scope: { kind: 'global' } })).toBeNull();
    expect(registry.resolve({ ...validResolution, handle: 'z'.repeat(43) })).toBeNull();
    expect(new GovernanceResourceHandleRegistry({ now: () => now.value }).resolve(
      validResolution,
    )).toBeNull();

    now.value += SESSION_TTL_MS;
    expect(registry.resolve(validResolution)).toBeNull();

    const afterExpiry = registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.maintenance.review',
      resourceKind: RESOURCE_KIND,
      resourceId: 'proposal-a',
      scope: { kind: 'system' },
    });
    expect(afterExpiry.handle).not.toBe(issued.handle);
    registry.revokeSession(SESSION_A);
    expect(registry.resolve({ ...validResolution, handle: afterExpiry.handle })).toBeNull();

    const beforeClear = registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.maintenance.review',
      resourceKind: RESOURCE_KIND,
      resourceId: 'proposal-b',
      scope: { kind: 'global' },
    });
    registry.clear();
    expect(registry.resolve({
      ...validResolution,
      handle: beforeClear.handle,
      scope: { kind: 'global' },
    })).toBeNull();
  });

  it('rejects malformed input and enforces session and per-session capacity atomically', () => {
    const now = { value: NOW };
    const registry = new GovernanceResourceHandleRegistry({ now: () => now.value });
    const sensitiveValue = 'sensitive-session-scope-or-resource-value';
    const validInput = {
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      purpose: 'memory.maintenance.review',
      resourceKind: RESOURCE_KIND,
      resourceId: 'proposal-a',
      scope: { kind: 'global' } as GovernanceScope,
    };
    const malformed = [
      { ...validInput, sessionId: sensitiveValue },
      { ...validInput, sessionExpiresAt: now.value },
      { ...validInput, sessionExpiresAt: now.value + 3_600_001 },
      { ...validInput, purpose: '' },
      { ...validInput, resourceKind: `memory\n${sensitiveValue}` },
      { ...validInput, resourceId: ` ${sensitiveValue}` },
      { ...validInput, resourceId: 'x'.repeat(257) },
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
      expect(() => registry.issue(input)).toThrow('Invalid governance resource handle input');
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
    })).toThrow('Governance resource handle capacity exceeded');
    expect(registry.resolve({
      sessionId: sessionIds[0] as string,
      handle: issued[0]?.handle ?? '',
      purpose: validInput.purpose,
      resourceKind: validInput.resourceKind,
      scope: validInput.scope,
    })).toEqual({ kind: RESOURCE_KIND, resourceId: validInput.resourceId });

    registry.revokeSession(sessionIds[0] as string);
    registry.issue({ ...validInput, sessionId: sessionIds[8] as string });
    for (let index = 0; index < 511; index += 1) {
      registry.issue({
        ...validInput,
        sessionId: sessionIds[8] as string,
        resourceId: `bounded-proposal-${index}`,
      });
    }
    expect(() => registry.issue({
      ...validInput,
      sessionId: sessionIds[8] as string,
      resourceId: 'one-binding-too-many',
    })).toThrow('Governance resource handle capacity exceeded');
    expect(registry.resolve({
      sessionId: sessionIds[8] as string,
      handle: registry.issue({ ...validInput, sessionId: sessionIds[8] as string }).handle,
      purpose: validInput.purpose,
      resourceKind: validInput.resourceKind,
      scope: validInput.scope,
    })).toEqual({ kind: RESOURCE_KIND, resourceId: validInput.resourceId });

    now.value += SESSION_TTL_MS;
    expect(() => registry.issue({
      ...validInput,
      sessionId: SESSION_B,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
    })).not.toThrow();
  });
});
