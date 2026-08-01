import { randomBytes } from 'node:crypto';
import type { GovernanceScope } from './governance-http-server.js';

const OPAQUE_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/u;
const PREVIEW_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_ACTIVE_SESSIONS = 8;
const MAX_PREVIEWS_PER_SESSION = 64;
const MAX_CONSUMED_PREVIEWS_PER_SESSION = 64;
const MAX_PREVIEW_TTL_MS = 300_000;
const MAX_SESSION_TTL_MS = 3_600_000;
const MAX_ACTION_LENGTH = 128;
const MAX_RESOURCE_KIND_LENGTH = 128;
const MAX_RESOURCE_IDENTIFIER_LENGTH = 256;
const MAX_EXPECTED_STATE_LENGTH = 64;
const MAX_SCOPE_IDENTIFIER_LENGTH = 256;

export interface GovernancePreviewHandleRegistryOptions {
  readonly now: () => number;
}

export interface IssueGovernancePreviewHandleInput {
  readonly sessionId: string;
  readonly sessionExpiresAt: number;
  readonly actor: { readonly kind: 'local_admin' };
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly scope: GovernanceScope;
  readonly expectedState: string;
  readonly expectedRevisionNumber: number;
  readonly previewDigest: string;
  readonly expectedAtMs?: number;
}

export interface IssuedGovernancePreviewHandle {
  readonly handle: string;
  readonly expiresAt: number;
}

export interface ConsumeGovernancePreviewHandleInput {
  readonly sessionId: string;
  readonly handle: string;
  readonly actor: { readonly kind: 'local_admin' };
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly scope: GovernanceScope;
}

export interface ConsumedGovernancePreviewBinding {
  readonly resourceId: string;
  readonly expectedState: string;
  readonly expectedRevisionNumber: number;
  readonly previewDigest: string;
  readonly expectedAtMs?: number;
}

export type ConsumeGovernancePreviewHandleResult =
  | {
    readonly outcome: 'consumed';
    readonly binding: ConsumedGovernancePreviewBinding;
  }
  | { readonly outcome: 'already_consumed' }
  | { readonly outcome: 'not_found_or_denied' };

interface GovernancePreviewHandleRecord extends ConsumedGovernancePreviewBinding {
  readonly handle: string;
  readonly sessionId: string;
  readonly sessionExpiresAt: number;
  readonly actorKind: 'local_admin';
  readonly action: string;
  readonly resourceKind: string;
  readonly scopeKey: string;
  readonly expiresAt: number;
  readonly consumed: boolean;
}

export class GovernancePreviewHandleRegistry {
  private readonly recordsByHandle = new Map<string, GovernancePreviewHandleRecord>();

  constructor(private readonly options: GovernancePreviewHandleRegistryOptions) {}

  issue(input: IssueGovernancePreviewHandleInput): IssuedGovernancePreviewHandle {
    const now = this.readNow();
    const scope = normalizeScope(input.scope);
    if (
      !SESSION_ID_PATTERN.test(input.sessionId)
      || !Number.isSafeInteger(input.sessionExpiresAt)
      || input.sessionExpiresAt <= now
      || input.sessionExpiresAt > now + MAX_SESSION_TTL_MS
      || !isLocalAdminActor(input.actor)
      || !isBoundedString(input.action, MAX_ACTION_LENGTH)
      || !isBoundedString(input.resourceKind, MAX_RESOURCE_KIND_LENGTH)
      || !isBoundedString(input.resourceId, MAX_RESOURCE_IDENTIFIER_LENGTH)
      || !scope
      || !isBoundedString(input.expectedState, MAX_EXPECTED_STATE_LENGTH)
      || !Number.isSafeInteger(input.expectedRevisionNumber)
      || input.expectedRevisionNumber < 1
      || !PREVIEW_DIGEST_PATTERN.test(input.previewDigest)
      || (input.expectedAtMs !== undefined
        && (!Number.isSafeInteger(input.expectedAtMs) || input.expectedAtMs < 0))
    ) {
      throw new Error('Invalid governance preview handle input');
    }

    this.removeExpired(now);
    const sessionRecords = [...this.recordsByHandle.values()]
      .filter((record) => record.sessionId === input.sessionId);
    if (sessionRecords.some((record) => record.sessionExpiresAt !== input.sessionExpiresAt)) {
      throw new Error('Invalid governance preview handle input');
    }

    const activeRecords = [...this.recordsByHandle.values()]
      .filter((record) => !record.consumed);
    const activeSessionCount = new Set(activeRecords.map((record) => record.sessionId)).size;
    const activeSessionRecords = sessionRecords.filter((record) => !record.consumed);
    if (
      (activeSessionRecords.length === 0 && activeSessionCount >= MAX_ACTIVE_SESSIONS)
      || activeSessionRecords.length >= MAX_PREVIEWS_PER_SESSION
    ) {
      throw new Error('Governance preview handle capacity exceeded');
    }

    let handle = randomOpaqueValue();
    while (this.recordsByHandle.has(handle)) {
      handle = randomOpaqueValue();
    }
    const record: GovernancePreviewHandleRecord = {
      handle,
      sessionId: input.sessionId,
      sessionExpiresAt: input.sessionExpiresAt,
      actorKind: input.actor.kind,
      action: input.action,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      scopeKey: JSON.stringify(scope),
      expectedState: input.expectedState,
      expectedRevisionNumber: input.expectedRevisionNumber,
      previewDigest: input.previewDigest,
      ...(input.expectedAtMs === undefined ? {} : { expectedAtMs: input.expectedAtMs }),
      expiresAt: Math.min(input.sessionExpiresAt, now + MAX_PREVIEW_TTL_MS),
      consumed: false,
    };
    this.recordsByHandle.set(handle, record);
    return { handle, expiresAt: record.expiresAt };
  }

  consume(input: ConsumeGovernancePreviewHandleInput): ConsumedGovernancePreviewBinding | null {
    const result = this.consumeWithOutcome(input);
    return result.outcome === 'consumed' ? result.binding : null;
  }

  consumeWithOutcome(
    input: ConsumeGovernancePreviewHandleInput,
  ): ConsumeGovernancePreviewHandleResult {
    const scope = normalizeScope(input.scope);
    if (
      !SESSION_ID_PATTERN.test(input.sessionId)
      || !OPAQUE_HANDLE_PATTERN.test(input.handle)
      || !isLocalAdminActor(input.actor)
      || !isBoundedString(input.action, MAX_ACTION_LENGTH)
      || !isBoundedString(input.resourceKind, MAX_RESOURCE_KIND_LENGTH)
      || !isBoundedString(input.resourceId, MAX_RESOURCE_IDENTIFIER_LENGTH)
      || !scope
    ) {
      return { outcome: 'not_found_or_denied' };
    }

    const now = this.readNow();
    this.removeExpired(now);
    const record = this.recordsByHandle.get(input.handle);
    if (
      !record
      || record.sessionId !== input.sessionId
      || record.actorKind !== input.actor.kind
      || record.action !== input.action
      || record.resourceKind !== input.resourceKind
      || record.resourceId !== input.resourceId
      || record.scopeKey !== JSON.stringify(scope)
    ) {
      return { outcome: 'not_found_or_denied' };
    }
    if (record.consumed) {
      return { outcome: 'already_consumed' };
    }

    this.recordsByHandle.set(input.handle, { ...record, consumed: true });
    this.trimConsumedRecords(input.sessionId);
    return {
      outcome: 'consumed',
      binding: {
        resourceId: record.resourceId,
        expectedState: record.expectedState,
        expectedRevisionNumber: record.expectedRevisionNumber,
        previewDigest: record.previewDigest,
        ...(record.expectedAtMs === undefined ? {} : { expectedAtMs: record.expectedAtMs }),
      },
    };
  }

  revokeSession(sessionId: string): void {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return;
    }
    for (const [handle, record] of this.recordsByHandle) {
      if (record.sessionId === sessionId) {
        this.recordsByHandle.delete(handle);
      }
    }
  }

  clear(): void {
    this.recordsByHandle.clear();
  }

  private readNow(): number {
    const now = this.options.now();
    if (
      !Number.isSafeInteger(now)
      || now < 0
      || now > Number.MAX_SAFE_INTEGER - MAX_SESSION_TTL_MS
    ) {
      throw new Error('Invalid governance preview handle registry clock');
    }
    return now;
  }

  private removeExpired(now: number): void {
    for (const [handle, record] of this.recordsByHandle) {
      if (record.expiresAt <= now) {
        this.recordsByHandle.delete(handle);
      }
    }
  }

  private trimConsumedRecords(sessionId: string): void {
    const handles = [...this.recordsByHandle.values()]
      .filter((record) => record.sessionId === sessionId && record.consumed)
      .map((record) => record.handle);
    for (const handle of handles.slice(0, -MAX_CONSUMED_PREVIEWS_PER_SESSION)) {
      this.recordsByHandle.delete(handle);
    }
  }
}

function randomOpaqueValue(): string {
  return randomBytes(32).toString('base64url');
}

function normalizeScope(value: unknown): GovernanceScope | null {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return null;
  }
  switch (value.kind) {
    case 'global':
    case 'system':
      return hasExactKeys(value, ['kind']) ? { kind: value.kind } : null;
    case 'user':
      return hasExactKeys(value, ['kind', 'canonicalUserId'])
        && isBoundedString(value.canonicalUserId, MAX_SCOPE_IDENTIFIER_LENGTH)
        ? { kind: 'user', canonicalUserId: value.canonicalUserId }
        : null;
    case 'group':
      return hasExactKeys(value, ['kind', 'groupId'])
        && isBoundedString(value.groupId, MAX_SCOPE_IDENTIFIER_LENGTH)
        ? { kind: 'group', groupId: value.groupId }
        : null;
    case 'tool':
      return hasExactKeys(value, ['kind', 'toolName'])
        && isBoundedString(value.toolName, MAX_SCOPE_IDENTIFIER_LENGTH)
        ? { kind: 'tool', toolName: value.toolName }
        : null;
    case 'conversation':
      if (
        value.conversationType === 'private'
        && hasExactKeys(value, ['kind', 'conversationId', 'conversationType'])
        && isBoundedString(value.conversationId, MAX_SCOPE_IDENTIFIER_LENGTH)
      ) {
        return {
          kind: 'conversation',
          conversationId: value.conversationId,
          conversationType: 'private',
        };
      }
      if (
        value.conversationType === 'group'
        && hasExactKeys(value, ['kind', 'conversationId', 'conversationType', 'groupId'])
        && isBoundedString(value.conversationId, MAX_SCOPE_IDENTIFIER_LENGTH)
        && isBoundedString(value.groupId, MAX_SCOPE_IDENTIFIER_LENGTH)
      ) {
        return {
          kind: 'conversation',
          conversationId: value.conversationId,
          conversationType: 'group',
          groupId: value.groupId,
        };
      }
      return null;
    default:
      return null;
  }
}

function isLocalAdminActor(value: unknown): value is { readonly kind: 'local_admin' } {
  return isRecord(value)
    && hasExactKeys(value, ['kind'])
    && value.kind === 'local_admin';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maxLength
    && value.trim() === value
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    });
}
