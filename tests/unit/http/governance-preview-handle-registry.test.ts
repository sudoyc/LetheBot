import { describe, expect, it } from 'vitest';
import type { GovernanceScope } from '../../../src/http/governance-http-server.js';
import { GovernancePreviewHandleRegistry } from '../../../src/http/governance-preview-handle-registry.js';

const NOW = 1_800_000_000_000;
const SESSION_TTL_MS = 900_000;
const PREVIEW_TTL_MS = 300_000;
const SESSION_A = 'a'.repeat(64);
const SESSION_B = 'b'.repeat(64);
const ACTION = 'memory.maintenance.review.approve';
const RESOURCE_KIND = 'memory_maintenance_review';
const PREVIEW_DIGEST = 'd'.repeat(64);

describe('GovernancePreviewHandleRegistry', () => {
  it('issues fresh opaque handles and consumes defensive bindings for every scope shape', () => {
    const now = { value: NOW };
    const registry = new GovernancePreviewHandleRegistry({ now: () => now.value });
    const secret = 'sk-previewhandleabcdefghijklmnopqrstuvwxyz123456';
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
      actor: { kind: 'local_admin' },
      action: ACTION,
      resourceKind: RESOURCE_KIND,
      resourceId: `proposal-${platformId}-${secret}-${index}`,
      scope,
      expectedState: 'pending_review',
      expectedRevisionNumber: index + 1,
      previewDigest: PREVIEW_DIGEST,
    }));

    expect(issued.every((record) => /^[A-Za-z0-9_-]{43}$/u.test(record.handle))).toBe(true);
    expect(issued.every((record) => record.expiresAt === now.value + PREVIEW_TTL_MS)).toBe(true);
    expect(new Set(issued.map((record) => record.handle))).toHaveProperty('size', scopes.length);
    expect(JSON.stringify(issued)).not.toContain(secret);
    expect(JSON.stringify(issued)).not.toContain(platformId);

    scopes.forEach((scope, index) => {
      expect(registry.consume({
        sessionId: SESSION_A,
        handle: issued[index]?.handle ?? '',
        actor: { kind: 'local_admin' },
        action: ACTION,
        resourceKind: RESOURCE_KIND,
        resourceId: `proposal-${platformId}-${secret}-${index}`,
        scope,
      })).toEqual({
        resourceId: `proposal-${platformId}-${secret}-${index}`,
        expectedState: 'pending_review',
        expectedRevisionNumber: index + 1,
        previewDigest: PREVIEW_DIGEST,
      });
    });

    const sameInput = {
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      actor: { kind: 'local_admin' } as const,
      action: ACTION,
      resourceKind: RESOURCE_KIND,
      resourceId: 'same-proposal',
      scope: { kind: 'system' } as GovernanceScope,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      previewDigest: PREVIEW_DIGEST,
    };
    const first = registry.issue(sameInput);
    const second = registry.issue(sameInput);
    expect(first.handle).not.toBe(second.handle);

    const mutableScope: { kind: 'user'; canonicalUserId: string } = {
      kind: 'user',
      canonicalUserId: 'original-user',
    };
    const defensive = registry.issue({ ...sameInput, resourceId: 'defensive', scope: mutableScope });
    mutableScope.canonicalUserId = 'changed-user';
    expect(registry.consume({
      sessionId: SESSION_A,
      handle: defensive.handle,
      actor: { kind: 'local_admin' },
      action: ACTION,
      resourceKind: RESOURCE_KIND,
      resourceId: 'defensive',
      scope: mutableScope,
    })).toBeNull();
    expect(registry.consume({
      sessionId: SESSION_A,
      handle: defensive.handle,
      actor: { kind: 'local_admin' },
      action: ACTION,
      resourceKind: RESOURCE_KIND,
      resourceId: 'defensive',
      scope: { kind: 'user', canonicalUserId: 'original-user' },
    })).toMatchObject({ resourceId: 'defensive' });

    const shortSession = registry.issue({
      ...sameInput,
      sessionId: SESSION_B,
      sessionExpiresAt: now.value + 60_000,
    });
    expect(shortSession.expiresAt).toBe(now.value + 60_000);
  });

  it('binds a server-owned expected timestamp without exposing it in the handle', () => {
    const registry = new GovernancePreviewHandleRegistry({ now: () => NOW });
    const issued = registry.issue({
      sessionId: SESSION_A,
      sessionExpiresAt: NOW + SESSION_TTL_MS,
      actor: { kind: 'local_admin' },
      action: 'apply_configured_retention',
      resourceKind: 'operations_configured_retention',
      resourceId: 'configured_retention',
      scope: { kind: 'system' },
      expectedState: 'a'.repeat(64),
      expectedRevisionNumber: 1,
      previewDigest: PREVIEW_DIGEST,
      expectedAtMs: NOW - 1,
    });

    expect(JSON.stringify(issued)).not.toContain(String(NOW - 1));
    expect(registry.consume({
      sessionId: SESSION_A,
      handle: issued.handle,
      actor: { kind: 'local_admin' },
      action: 'apply_configured_retention',
      resourceKind: 'operations_configured_retention',
      resourceId: 'configured_retention',
      scope: { kind: 'system' },
    })).toEqual({
      resourceId: 'configured_retention',
      expectedState: 'a'.repeat(64),
      expectedRevisionNumber: 1,
      previewDigest: PREVIEW_DIGEST,
      expectedAtMs: NOW - 1,
    });

    for (const expectedAtMs of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => registry.issue({
        sessionId: SESSION_B,
        sessionExpiresAt: NOW + SESSION_TTL_MS,
        actor: { kind: 'local_admin' },
        action: 'apply_configured_retention',
        resourceKind: 'operations_configured_retention',
        resourceId: 'configured_retention',
        scope: { kind: 'system' },
        expectedState: 'a'.repeat(64),
        expectedRevisionNumber: 1,
        previewDigest: PREVIEW_DIGEST,
        expectedAtMs,
      })).toThrow('Invalid governance preview handle input');
    }
  });

  it('consumes once only across the exact boundary and invalidates lifecycle state', () => {
    const now = { value: NOW };
    const registry = new GovernancePreviewHandleRegistry({ now: () => now.value });
    const validInput = {
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      actor: { kind: 'local_admin' } as const,
      action: ACTION,
      resourceKind: RESOURCE_KIND,
      resourceId: 'proposal-a',
      scope: { kind: 'system' } as GovernanceScope,
      expectedState: 'pending_review',
      expectedRevisionNumber: 3,
      previewDigest: PREVIEW_DIGEST,
    };
    const issued = registry.issue(validInput);
    const consumeInput = {
      sessionId: SESSION_A,
      handle: issued.handle,
      actor: { kind: 'local_admin' } as const,
      action: ACTION,
      resourceKind: RESOURCE_KIND,
      resourceId: 'proposal-a',
      scope: { kind: 'system' } as GovernanceScope,
    };

    expect(registry.consume({ ...consumeInput, sessionId: SESSION_B })).toBeNull();
    expect(registry.consume({
      ...consumeInput,
      actor: { kind: 'other_actor' } as unknown as { kind: 'local_admin' },
    })).toBeNull();
    expect(registry.consume({ ...consumeInput, action: 'memory.maintenance.review.reject' }))
      .toBeNull();
    expect(registry.consume({ ...consumeInput, resourceKind: 'memory_record' })).toBeNull();
    expect(registry.consume({ ...consumeInput, resourceId: 'proposal-b' })).toBeNull();
    expect(registry.consume({ ...consumeInput, scope: { kind: 'global' } })).toBeNull();
    expect(registry.consume({ ...consumeInput, handle: 'z'.repeat(43) })).toBeNull();
    expect(new GovernancePreviewHandleRegistry({ now: () => now.value }).consume(consumeInput))
      .toBeNull();

    expect(registry.consumeWithOutcome(consumeInput)).toEqual({
      outcome: 'consumed',
      binding: {
        resourceId: 'proposal-a',
        expectedState: 'pending_review',
        expectedRevisionNumber: 3,
        previewDigest: PREVIEW_DIGEST,
      },
    });
    expect(registry.consume(consumeInput)).toBeNull();
    expect(registry.consumeWithOutcome(consumeInput)).toEqual({ outcome: 'already_consumed' });

    const expired = registry.issue(validInput);
    now.value += PREVIEW_TTL_MS;
    expect(registry.consume({ ...consumeInput, handle: expired.handle })).toBeNull();

    const revoked = registry.issue({
      ...validInput,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
    });
    registry.revokeSession(SESSION_A);
    expect(registry.consume({ ...consumeInput, handle: revoked.handle })).toBeNull();

    const cleared = registry.issue({
      ...validInput,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
    });
    registry.clear();
    expect(registry.consume({ ...consumeInput, handle: cleared.handle })).toBeNull();
  });

  it('rejects malformed input without disclosure or eviction', () => {
    const now = { value: NOW };
    const registry = new GovernancePreviewHandleRegistry({ now: () => now.value });
    const sensitiveValue = 'sensitive-preview-binding-value';
    const validInput = {
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      actor: { kind: 'local_admin' } as const,
      action: ACTION,
      resourceKind: RESOURCE_KIND,
      resourceId: 'proposal-a',
      scope: { kind: 'global' } as GovernanceScope,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      previewDigest: PREVIEW_DIGEST,
    };
    const malformed = [
      { ...validInput, sessionId: sensitiveValue },
      { ...validInput, sessionExpiresAt: now.value },
      { ...validInput, sessionExpiresAt: now.value + 3_600_001 },
      { ...validInput, actor: { kind: sensitiveValue } as unknown as { kind: 'local_admin' } },
      { ...validInput, action: `approve\n${sensitiveValue}` },
      { ...validInput, resourceKind: '' },
      { ...validInput, resourceId: ` ${sensitiveValue}` },
      { ...validInput, resourceId: 'x'.repeat(257) },
      { ...validInput, expectedState: '' },
      { ...validInput, expectedRevisionNumber: 0 },
      { ...validInput, expectedRevisionNumber: 1.5 },
      { ...validInput, previewDigest: sensitiveValue },
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
      expect(() => registry.issue(input)).toThrow('Invalid governance preview handle input');
      try {
        registry.issue(input);
      } catch (error) {
        expect(String(error)).not.toContain(sensitiveValue);
      }
    }

    const retained = registry.issue(validInput);
    expect(() => registry.issue({
      ...validInput,
      sessionExpiresAt: now.value + SESSION_TTL_MS - 1,
    })).toThrow('Invalid governance preview handle input');
    expect(registry.consume({
      sessionId: SESSION_A,
      handle: retained.handle,
      actor: validInput.actor,
      action: validInput.action,
      resourceKind: validInput.resourceKind,
      resourceId: ` ${sensitiveValue}`,
      scope: validInput.scope,
    })).toBeNull();
    expect(registry.consume({
      sessionId: SESSION_A,
      handle: retained.handle,
      actor: validInput.actor,
      action: validInput.action,
      resourceKind: validInput.resourceKind,
      resourceId: validInput.resourceId,
      scope: validInput.scope,
    })).toMatchObject({ resourceId: validInput.resourceId });

    const invalidClock = new GovernancePreviewHandleRegistry({ now: () => -1 });
    expect(() => invalidClock.issue(validInput))
      .toThrow('Invalid governance preview handle registry clock');
    expect(() => invalidClock.consume({
      sessionId: SESSION_A,
      handle: 'z'.repeat(43),
      actor: validInput.actor,
      action: validInput.action,
      resourceKind: validInput.resourceKind,
      resourceId: validInput.resourceId,
      scope: validInput.scope,
    })).toThrow('Invalid governance preview handle registry clock');
  });

  it('enforces active-session and per-session capacity after cleanup', () => {
    const now = { value: NOW };
    const registry = new GovernancePreviewHandleRegistry({ now: () => now.value });
    const validInput = {
      sessionId: SESSION_A,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
      actor: { kind: 'local_admin' } as const,
      action: ACTION,
      resourceKind: RESOURCE_KIND,
      resourceId: 'proposal-a',
      scope: { kind: 'global' } as GovernanceScope,
      expectedState: 'pending_review',
      expectedRevisionNumber: 1,
      previewDigest: PREVIEW_DIGEST,
    };
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
    })).toThrow('Governance preview handle capacity exceeded');
    expect(registry.consume({
      sessionId: sessionIds[0] as string,
      handle: issued[0]?.handle ?? '',
      actor: validInput.actor,
      action: validInput.action,
      resourceKind: validInput.resourceKind,
      resourceId: validInput.resourceId,
      scope: validInput.scope,
    })).toMatchObject({ resourceId: validInput.resourceId });

    registry.issue({ ...validInput, sessionId: sessionIds[8] as string });
    for (let index = 0; index < 63; index += 1) {
      registry.issue({
        ...validInput,
        sessionId: sessionIds[8] as string,
        resourceId: `bounded-proposal-${index}`,
      });
    }
    expect(() => registry.issue({
      ...validInput,
      sessionId: sessionIds[8] as string,
      resourceId: 'one-preview-too-many',
    })).toThrow('Governance preview handle capacity exceeded');

    const consumedRegistry = new GovernancePreviewHandleRegistry({ now: () => now.value });
    const consumed = Array.from({ length: 65 }, (_, index) => {
      const resourceId = `consumed-proposal-${index}`;
      const preview = consumedRegistry.issue({
        ...validInput,
        resourceId,
      });
      const consumeInput = {
        sessionId: SESSION_A,
        handle: preview.handle,
        actor: validInput.actor,
        action: validInput.action,
        resourceKind: validInput.resourceKind,
        resourceId,
        scope: validInput.scope,
      };
      expect(consumedRegistry.consumeWithOutcome(consumeInput).outcome).toBe('consumed');
      return consumeInput;
    });
    expect(consumedRegistry.consumeWithOutcome(consumed[0] as typeof consumed[number]))
      .toEqual({ outcome: 'not_found_or_denied' });
    expect(consumedRegistry.consumeWithOutcome(consumed[64] as typeof consumed[number]))
      .toEqual({ outcome: 'already_consumed' });

    now.value += PREVIEW_TTL_MS;
    expect(() => registry.issue({
      ...validInput,
      sessionId: SESSION_B,
      sessionExpiresAt: now.value + SESSION_TTL_MS,
    })).not.toThrow();
  });
});
