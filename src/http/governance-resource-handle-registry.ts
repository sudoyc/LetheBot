import { createHash, randomBytes } from 'node:crypto';
import type {
  GovernanceHttpResourceHandleStore,
  GovernanceHttpResourceResolutionInput,
  GovernanceHttpResolvedResource,
  GovernanceScope,
} from './governance-http-server.js';

const OPAQUE_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_ACTIVE_SESSIONS = 8;
const MAX_HANDLES_PER_SESSION = 512;
const MAX_SESSION_TTL_MS = 3_600_000;
const MAX_PURPOSE_LENGTH = 128;
const MAX_RESOURCE_KIND_LENGTH = 128;
const MAX_RESOURCE_IDENTIFIER_LENGTH = 256;
const MAX_SCOPE_IDENTIFIER_LENGTH = 256;

export interface GovernanceResourceHandleRegistryOptions {
  readonly now: () => number;
}

export interface IssueGovernanceResourceHandleInput {
  readonly sessionId: string;
  readonly sessionExpiresAt: number;
  readonly purpose: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly scope: GovernanceScope;
}

export interface IssuedGovernanceResourceHandle {
  readonly handle: string;
  readonly expiresAt: number;
}

interface GovernanceResourceHandleRecord extends IssuedGovernanceResourceHandle {
  readonly bindingKey: string;
  readonly sessionId: string;
  readonly purpose: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly scopeKey: string;
}

export class GovernanceResourceHandleRegistry implements GovernanceHttpResourceHandleStore {
  private readonly recordsByHandle = new Map<string, GovernanceResourceHandleRecord>();
  private readonly handleByBinding = new Map<string, string>();

  constructor(private readonly options: GovernanceResourceHandleRegistryOptions) {}

  issue(input: IssueGovernanceResourceHandleInput): IssuedGovernanceResourceHandle {
    const now = this.readNow();
    const scope = normalizeScope(input.scope);
    if (
      !SESSION_ID_PATTERN.test(input.sessionId)
      || !Number.isSafeInteger(input.sessionExpiresAt)
      || input.sessionExpiresAt <= now
      || input.sessionExpiresAt > now + MAX_SESSION_TTL_MS
      || !isBoundedString(input.purpose, MAX_PURPOSE_LENGTH)
      || !isBoundedString(input.resourceKind, MAX_RESOURCE_KIND_LENGTH)
      || !isBoundedString(input.resourceId, MAX_RESOURCE_IDENTIFIER_LENGTH)
      || !scope
    ) {
      throw new Error('Invalid governance resource handle input');
    }

    this.removeExpired(now);
    const sessionRecords = [...this.recordsByHandle.values()]
      .filter((record) => record.sessionId === input.sessionId);
    if (sessionRecords.some((record) => record.expiresAt !== input.sessionExpiresAt)) {
      throw new Error('Invalid governance resource handle input');
    }

    const scopeKey = JSON.stringify(scope);
    const bindingKey = createBindingKey({
      sessionId: input.sessionId,
      purpose: input.purpose,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      scopeKey,
    });
    const existingHandle = this.handleByBinding.get(bindingKey);
    const existing = existingHandle
      ? this.recordsByHandle.get(existingHandle)
      : undefined;
    if (existing) {
      return { handle: existing.handle, expiresAt: existing.expiresAt };
    }

    const activeSessionCount = new Set(
      [...this.recordsByHandle.values()].map((record) => record.sessionId),
    ).size;
    if (
      (sessionRecords.length === 0 && activeSessionCount >= MAX_ACTIVE_SESSIONS)
      || sessionRecords.length >= MAX_HANDLES_PER_SESSION
    ) {
      throw new Error('Governance resource handle capacity exceeded');
    }

    let handle = randomOpaqueValue();
    while (this.recordsByHandle.has(handle)) {
      handle = randomOpaqueValue();
    }
    const record: GovernanceResourceHandleRecord = {
      handle,
      bindingKey,
      sessionId: input.sessionId,
      purpose: input.purpose,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      scopeKey,
      expiresAt: input.sessionExpiresAt,
    };
    this.recordsByHandle.set(handle, record);
    this.handleByBinding.set(bindingKey, handle);
    return { handle, expiresAt: record.expiresAt };
  }

  resolve(input: GovernanceHttpResourceResolutionInput): GovernanceHttpResolvedResource | null {
    const scope = normalizeScope(input.scope);
    if (
      !SESSION_ID_PATTERN.test(input.sessionId)
      || !OPAQUE_HANDLE_PATTERN.test(input.handle)
      || !isBoundedString(input.purpose, MAX_PURPOSE_LENGTH)
      || !isBoundedString(input.resourceKind, MAX_RESOURCE_KIND_LENGTH)
      || !scope
    ) {
      return null;
    }
    const now = this.readNow();
    this.removeExpired(now);
    const record = this.recordsByHandle.get(input.handle);
    if (
      !record
      || record.sessionId !== input.sessionId
      || record.purpose !== input.purpose
      || record.resourceKind !== input.resourceKind
      || record.scopeKey !== JSON.stringify(scope)
    ) {
      return null;
    }
    return { kind: record.resourceKind, resourceId: record.resourceId };
  }

  revokeSession(sessionId: string): void {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return;
    }
    for (const [handle, record] of this.recordsByHandle) {
      if (record.sessionId === sessionId) {
        this.removeRecord(handle, record);
      }
    }
  }

  clear(): void {
    this.recordsByHandle.clear();
    this.handleByBinding.clear();
  }

  private readNow(): number {
    const now = this.options.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('Invalid governance resource handle registry clock');
    }
    return now;
  }

  private removeExpired(now: number): void {
    for (const [handle, record] of this.recordsByHandle) {
      if (record.expiresAt <= now) {
        this.removeRecord(handle, record);
      }
    }
  }

  private removeRecord(handle: string, record: GovernanceResourceHandleRecord): void {
    this.recordsByHandle.delete(handle);
    if (this.handleByBinding.get(record.bindingKey) === handle) {
      this.handleByBinding.delete(record.bindingKey);
    }
  }
}

function createBindingKey(input: {
  sessionId: string;
  purpose: string;
  resourceKind: string;
  resourceId: string;
  scopeKey: string;
}): string {
  return createHash('sha256')
    .update('lethebot-governance-resource-binding:v1\0', 'utf8')
    .update(JSON.stringify(input), 'utf8')
    .digest('hex');
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
