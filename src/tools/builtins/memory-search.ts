import type Database from 'better-sqlite3';
import type { MemoryRecord } from '../../types/memory.js';
import type { ToolHandlerRequest, ToolRegistryEntry } from '../../types/tool.js';
import {
  MemoryPolicyError,
  type MemoryFilters,
  type MemoryRecordInput,
  type MemoryRepository,
} from '../../storage/memory-repository.js';
import { PrivacyPreferenceRepository } from '../../storage/privacy-preference-repository.js';
import { redactSecretsInText } from '../../memory/secret-scan.js';
import { toSafeMemoryFtsQuery } from '../../memory/fts-query.js';
import type { ToolRegistry } from '../registry.js';
import {
  prepareLocalToolEffect,
  type PreparedLocalToolEffect,
} from '../prepared-local-effect.js';

export interface BuiltInToolDependencies {
  memoryRepository: MemoryRepository;
  database: Database.Database;
}

interface MemorySearchInput {
  query?: string;
  limit?: number;
}

interface MemorySearchResultItem {
  kind: MemoryRecord['kind'];
  scope: MemoryRecord['scope'];
  title: string;
  content: string;
  confidence: number;
  importance: number;
  sourceContext: string;
}

interface MemorySearchOutput {
  results: MemorySearchResultItem[];
  count: number;
}

interface MemoryProposeInput {
  scope?: MemoryRecord['scope'];
  visibility?: MemoryRecord['visibility'];
  sensitivity?: MemoryRecord['sensitivity'];
  kind?: MemoryRecord['kind'];
  title?: string;
  content?: string;
  confidence?: number;
  importance?: number;
}

interface MemoryProposeOutput {
  status: 'proposed' | 'rejected';
  scope?: MemoryRecord['scope'];
  visibility?: MemoryRecord['visibility'];
  kind?: MemoryRecord['kind'];
  reason: string;
}

interface MemoryProposalEvidenceRow {
  domain: string;
  turn_id: string;
  decision: string;
  risk_level: string;
  tool_name: string | null;
  actor_user_id: string | null;
  actor_class: string;
  invocation_context: string;
  source_event_ids: string;
  trigger_event_id: string;
}

type MemoryProposalEvidence =
  | { ok: true; sourceTimestamps: Map<string, number> }
  | { ok: false };

interface MemoryDisableInput {
  memoryId?: string;
  reason?: string;
}

interface MemoryDisableOutput {
  status: 'disabled' | 'rejected';
  reason: string;
}

interface GroupRecentSummaryInput {
  limit?: number;
}

interface GroupRecentSummaryExcerpt {
  speaker: string;
  text?: string;
  timestamp: string;
  flags: string[];
}

interface GroupRecentSummaryOutput {
  status: 'ok' | 'rejected';
  reason: string;
  summary: string;
  messageCount: number;
  participantCount: number;
  botMessageCount: number;
  mentionBotCount: number;
  mediaMessageCount: number;
  quoteMessageCount: number;
  windowStart?: string;
  windowEnd?: string;
  excerpts: GroupRecentSummaryExcerpt[];
}

interface GroupRecentSummaryRow {
  sender_id: string;
  text: string | null;
  has_media: number;
  has_quote: number;
  mentions_bot: number;
  timestamp: number;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_GROUP_RECENT_LIMIT = 8;
const MAX_GROUP_RECENT_LIMIT = 20;
const MAX_QUERY_LENGTH = 200;
const MAX_PROPOSAL_TITLE_LENGTH = 120;
const MAX_PROPOSAL_CONTENT_LENGTH = 1000;
const MAX_DISABLE_MEMORY_ID_LENGTH = 120;
const MAX_DISABLE_REASON_LENGTH = 240;
const MAX_GROUP_RECENT_EXCERPT_LENGTH = 160;
const ALLOWED_PROPOSAL_SCOPES = ['user', 'group', 'global'] as const;
const ALLOWED_PROPOSAL_VISIBILITIES = [
  'private_only',
  'same_user_any_context',
  'same_group_only',
  'owner_admin_only',
  'public',
] as const;
const ALLOWED_PROPOSAL_SENSITIVITIES = ['normal', 'personal', 'sensitive'] as const;
const ALLOWED_PROPOSAL_KINDS = ['preference', 'fact', 'constraint', 'summary', 'reflection', 'procedure'] as const;

export function registerBuiltInTools(
  registry: ToolRegistry,
  dependencies: BuiltInToolDependencies,
): void {
  registry.register(createMemorySearchTool(dependencies.memoryRepository));
  registry.register(createMemoryProposeTool(dependencies.memoryRepository, dependencies.database));
  registry.register(createMemoryDisableTool(dependencies.memoryRepository));
  registry.register(createGroupRecentSummaryTool(dependencies.database));
}

export function createMemorySearchTool(memoryRepository: MemoryRepository): ToolRegistryEntry {
  return {
    name: 'memory.search',
    version: '1.0.0',
    description: 'Search the current actor\'s governed LetheBot memory visible in this chat context.',
    capabilities: ['read_context'],
    permissions: {
      allowedActors: ['owner', 'admin', 'trusted_user', 'user'],
      allowedContexts: ['private_chat', 'group_chat'],
    },
    evaluatorPolicy: 'bypass',
    auditLevel: 'redacted_full',
    sandboxPolicy: {
      filesystem: 'none',
      network: 'none',
      execution: 'in_process',
      maxRuntimeMs: 1000,
      maxOutputBytes: 8192,
    },
    outputSensitivity: 'secret_possible',
    piSchema: {
      input: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional memory search query. Omit or leave blank to list the most important visible memories.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of visible memory records to return, capped at 10.',
          },
        },
      },
      output: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                scope: { type: 'string' },
                title: { type: 'string' },
                content: { type: 'string' },
                confidence: { type: 'number' },
                importance: { type: 'number' },
                sourceContext: { type: 'string' },
              },
            },
          },
          count: { type: 'number' },
        },
      },
    },
    handler: createMemorySearchHandler(memoryRepository),
  };
}

export function createMemoryProposeTool(
  memoryRepository: MemoryRepository,
  database: Database.Database,
): ToolRegistryEntry {
  const privacyPreferences = new PrivacyPreferenceRepository(database);

  return {
    name: 'memory.propose',
    version: '1.0.0',
    description: 'Create a governed proposed memory record for later user/admin review; does not activate memory.',
    capabilities: ['read_context', 'modifies_memory'],
    permissions: {
      allowedActors: ['owner', 'admin', 'trusted_user', 'user'],
      allowedContexts: ['private_chat', 'group_chat'],
    },
    evaluatorPolicy: 'required',
    auditLevel: 'redacted_full',
    sandboxPolicy: {
      filesystem: 'none',
      network: 'none',
      execution: 'in_process',
      maxRuntimeMs: 1000,
      maxOutputBytes: 4096,
    },
    outputSensitivity: 'sensitive',
    piSchema: {
      input: {
        type: 'object',
        properties: {
          scope: { type: 'string' },
          visibility: { type: 'string' },
          sensitivity: { type: 'string' },
          kind: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          confidence: { type: 'number' },
          importance: { type: 'number' },
        },
        required: ['title', 'content'],
      },
      output: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          scope: { type: 'string' },
          visibility: { type: 'string' },
          kind: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    handler: createMemoryProposeHandler(memoryRepository, database, privacyPreferences),
  };
}

export function createMemoryDisableTool(memoryRepository: MemoryRepository): ToolRegistryEntry {
  return {
    name: 'memory.disable',
    version: '1.0.0',
    description: 'Disable a governed memory record after policy/evaluator approval; does not delete source evidence.',
    capabilities: ['read_context', 'modifies_memory'],
    permissions: {
      allowedActors: ['owner', 'admin', 'trusted_user', 'user'],
      allowedContexts: ['private_chat', 'group_chat'],
    },
    evaluatorPolicy: 'required',
    auditLevel: 'redacted_full',
    sandboxPolicy: {
      filesystem: 'none',
      network: 'none',
      execution: 'in_process',
      maxRuntimeMs: 1000,
      maxOutputBytes: 2048,
    },
    outputSensitivity: 'sensitive',
    piSchema: {
      input: {
        type: 'object',
        properties: {
          memoryId: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['memoryId'],
      },
      output: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    handler: createMemoryDisableHandler(memoryRepository),
  };
}

export function createGroupRecentSummaryTool(database: Database.Database): ToolRegistryEntry {
  return {
    name: 'group.recent_summary',
    version: '1.0.0',
    description: 'Summarize recent sanitized messages from the current QQ group without exposing raw platform identifiers.',
    capabilities: ['read_context'],
    permissions: {
      allowedActors: ['owner', 'admin', 'trusted_user', 'user'],
      allowedContexts: ['group_chat'],
    },
    evaluatorPolicy: 'bypass',
    auditLevel: 'redacted_full',
    sandboxPolicy: {
      filesystem: 'none',
      network: 'none',
      execution: 'in_process',
      maxRuntimeMs: 1000,
      maxOutputBytes: 8192,
    },
    outputSensitivity: 'secret_possible',
    piSchema: {
      input: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of recent current-group messages to summarize, capped at 20.',
          },
        },
      },
      output: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          reason: { type: 'string' },
          summary: { type: 'string' },
          messageCount: { type: 'number' },
          participantCount: { type: 'number' },
          botMessageCount: { type: 'number' },
          mentionBotCount: { type: 'number' },
          mediaMessageCount: { type: 'number' },
          quoteMessageCount: { type: 'number' },
          windowStart: { type: 'string' },
          windowEnd: { type: 'string' },
          excerpts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                speaker: { type: 'string' },
                text: { type: 'string' },
                timestamp: { type: 'string' },
                flags: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    handler: createGroupRecentSummaryHandler(database),
  };
}

function createMemorySearchHandler(memoryRepository: MemoryRepository) {
  return async (request: ToolHandlerRequest): Promise<MemorySearchOutput> => {
    const input = parseInput(request.input);
    const records = await collectVisibleMemories(memoryRepository, request, input);
    const sorted = sortAndLimit(records, input.limit);
    const results = sorted.map(toSearchResultItem);

    return {
      results,
      count: results.length,
    };
  };
}

function parseInput(input: unknown): Required<MemorySearchInput> {
  const record = isRecord(input) ? input : {};
  const rawQuery = typeof record.query === 'string' ? record.query.trim() : '';
  const query = rawQuery.length > MAX_QUERY_LENGTH
    ? rawQuery.slice(0, MAX_QUERY_LENGTH)
    : rawQuery;
  const rawLimit = typeof record.limit === 'number' ? record.limit : DEFAULT_LIMIT;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  return { query, limit };
}

async function collectVisibleMemories(
  memoryRepository: MemoryRepository,
  request: ToolHandlerRequest,
  input: Required<MemorySearchInput>,
): Promise<MemoryRecord[]> {
  const contextType = request.context === 'group_chat' ? 'group' : 'private';
  const collected: MemoryRecord[] = [];

  if (!request.actor.canonicalUserId) {
    return [];
  }

  collected.push(
    ...await queryMemory(memoryRepository, input.query, {
      canonicalUserId: request.actor.canonicalUserId,
      contextType,
      limit: input.limit,
    }),
  );

  if (contextType === 'group' && request.actor.groupId) {
    collected.push(
      ...await queryMemory(memoryRepository, input.query, {
        canonicalUserId: request.actor.canonicalUserId,
        groupId: request.actor.groupId,
        contextType,
        limit: input.limit,
      }),
    );

    collected.push(
      ...await queryMemory(memoryRepository, input.query, {
        scope: 'group',
        groupId: request.actor.groupId,
        contextType,
        limit: input.limit,
      }),
    );
  }

  collected.push(
    ...await queryMemory(memoryRepository, input.query, {
      scope: 'global',
      contextType,
      limit: input.limit,
    }),
  );

  return dedupeRecords(collected);
}

function createMemoryProposeHandler(
  memoryRepository: MemoryRepository,
  database: Database.Database,
  privacyPreferences: PrivacyPreferenceRepository,
) {
  return async (
    request: ToolHandlerRequest,
  ): Promise<MemoryProposeOutput | PreparedLocalToolEffect<MemoryProposeOutput>> => {
    const canonicalUserId = request.actor.canonicalUserId;
    if (!canonicalUserId) {
      return {
        status: 'rejected',
        reason: 'canonical actor identity is required to propose memory',
      };
    }

    if (
      !request.sourceEventIds
      || request.sourceEventIds.length === 0
      || request.sourceEventIds.some((sourceEventId) =>
        typeof sourceEventId !== 'string' || sourceEventId.trim().length === 0
      )
    ) {
      return {
        status: 'rejected',
        reason: 'source event evidence is required to propose memory',
      };
    }

    if (!request.evaluatorDecisionId || request.evaluatorDecisionId.trim().length === 0) {
      return {
        status: 'rejected',
        reason: 'evaluator approval evidence is required to propose memory',
      };
    }

    const trustedRequest: ToolHandlerRequest & {
      actor: ToolHandlerRequest['actor'] & { canonicalUserId: string };
      evaluatorDecisionId: string;
      sourceEventIds: string[];
    } = {
      ...request,
      actor: { ...request.actor, canonicalUserId },
      evaluatorDecisionId: request.evaluatorDecisionId,
      sourceEventIds: [...request.sourceEventIds],
    };
    if (
      resolveProposalScope(trustedRequest.input, trustedRequest.context) === 'user'
      && isMemoryAssociationOptedOut(
        privacyPreferences,
        trustedRequest.actor.canonicalUserId,
      )
    ) {
      return {
        status: 'rejected',
        reason: 'User has opted out of memory association',
      };
    }

    const evidence = validateMemoryProposalEvidence(database, trustedRequest);
    if (!evidence.ok) {
      return {
        status: 'rejected',
        reason: 'matching evaluator approval evidence is required to propose memory',
      };
    }

    const input = parseProposeInput(trustedRequest.input, trustedRequest);
    if (!input.ok) {
      return {
        status: 'rejected',
        reason: input.reason,
      };
    }

    const buildMemoryInput = (
      sourceTimestamps: Map<string, number>,
    ): MemoryRecordInput => ({
      scope: input.value.scope,
      canonicalUserId: input.value.canonicalUserId,
      groupId: input.value.groupId,
      conversationId: input.value.conversationId,
      visibility: input.value.visibility,
      sensitivity: input.value.sensitivity,
      authority: 'tool_derived',
      kind: input.value.kind,
      title: input.value.title,
      content: input.value.content,
      state: 'proposed',
      confidence: input.value.confidence,
      importance: input.value.importance,
      sourceContext: trustedRequest.context,
      evaluatorDecisionId: trustedRequest.evaluatorDecisionId,
      sources: [...new Set(trustedRequest.sourceEventIds)].map((sourceEventId) => ({
        sourceType: 'raw_event',
        sourceId: sourceEventId,
        sourceTimestamp: sourceTimestamps.get(sourceEventId),
        extractedBy: 'tool',
      })),
      actor: {
        canonicalUserId: trustedRequest.actor.canonicalUserId,
        actorClass: trustedRequest.actor.actorClass,
        context: trustedRequest.context,
      },
      revisionReason: `memory.propose created source-bound proposed ${input.value.scope} memory`,
      auditSummary: 'memory.propose created proposed memory for review',
    });

    const memoryInput = buildMemoryInput(evidence.sourceTimestamps);
    try {
      memoryRepository.assertCreatePolicyAllowed(memoryInput);
    } catch (error) {
      if (error instanceof MemoryPolicyError) {
        return {
          status: 'rejected',
          reason: 'memory proposal rejected by deterministic memory policy',
        };
      }

      throw error;
    }

    const publicResult: MemoryProposeOutput = {
      status: 'proposed',
      scope: input.value.scope,
      visibility: input.value.visibility,
      kind: input.value.kind,
      reason: 'created proposed memory for review',
    };

    return prepareLocalToolEffect(publicResult, () => {
      if (
        input.value.scope === 'user'
        && isMemoryAssociationOptedOut(
          privacyPreferences,
          trustedRequest.actor.canonicalUserId,
        )
      ) {
        throw new Error('User has opted out of memory association');
      }

      const currentEvidence = validateMemoryProposalEvidence(database, trustedRequest);
      if (!currentEvidence.ok) {
        throw new Error('matching evaluator approval evidence is required to propose memory');
      }
      memoryRepository.createSync(buildMemoryInput(currentEvidence.sourceTimestamps));
    });
  };
}

function validateMemoryProposalEvidence(
  database: Database.Database,
  request: ToolHandlerRequest,
): MemoryProposalEvidence {
  const evaluatorDecisionId = request.evaluatorDecisionId;
  const sourceEventIds = request.sourceEventIds;
  if (!evaluatorDecisionId || !sourceEventIds || sourceEventIds.length === 0) {
    return { ok: false };
  }

  const row = database.prepare(
    `SELECT
       evaluator.domain,
       evaluator.turn_id,
       evaluator.decision,
       evaluator.risk_level,
       evaluator.tool_name,
       evaluator.actor_user_id,
       evaluator.actor_class,
       evaluator.invocation_context,
       evaluator.source_event_ids,
       turn_row.trigger_event_id
     FROM evaluator_decisions evaluator
     JOIN agent_turns turn_row ON turn_row.id = evaluator.turn_id
     WHERE evaluator.id = ?`
  ).get(evaluatorDecisionId) as MemoryProposalEvidenceRow | undefined;

  if (
    !row
    || row.domain !== 'tool'
    || row.turn_id !== request.turnId
    || row.decision !== 'approve'
    || row.risk_level === 'prohibited'
    || row.tool_name !== request.toolName
    || row.actor_user_id !== request.actor.canonicalUserId
    || row.actor_class !== request.actor.actorClass
    || row.invocation_context !== request.context
  ) {
    return { ok: false };
  }

  let approvedSourceIds: unknown;
  try {
    approvedSourceIds = JSON.parse(row.source_event_ids) as unknown;
  } catch {
    return { ok: false };
  }

  if (
    !Array.isArray(approvedSourceIds)
    || approvedSourceIds.some((sourceEventId) =>
      typeof sourceEventId !== 'string' || sourceEventId.trim().length === 0
    )
  ) {
    return { ok: false };
  }

  const requestedSources = new Set(sourceEventIds);
  const approvedSources = new Set(approvedSourceIds);
  if (
    requestedSources.size !== approvedSources.size
    || !requestedSources.has(row.trigger_event_id)
    || [...requestedSources].some((sourceEventId) => !approvedSources.has(sourceEventId))
  ) {
    return { ok: false };
  }

  const sourceTimestamps = new Map<string, number>();
  const readSource = database.prepare('SELECT timestamp FROM raw_events WHERE id = ?');
  for (const sourceEventId of requestedSources) {
    const source = readSource.get(sourceEventId) as { timestamp: number } | undefined;
    if (!source || !Number.isFinite(source.timestamp)) {
      return { ok: false };
    }
    sourceTimestamps.set(sourceEventId, source.timestamp);
  }

  return { ok: true, sourceTimestamps };
}

function parseProposeInput(
  input: unknown,
  request: ToolHandlerRequest,
):
  | { ok: true; value: Required<Pick<MemoryProposeInput, 'scope' | 'visibility' | 'sensitivity' | 'kind' | 'title' | 'content' | 'confidence' | 'importance'>> & { canonicalUserId?: string; groupId?: string; conversationId?: string } }
  | { ok: false; reason: string } {
  const record = isRecord(input) ? input : {};
  const title = normalizeBoundedString(record.title, MAX_PROPOSAL_TITLE_LENGTH);
  const content = normalizeBoundedString(record.content, MAX_PROPOSAL_CONTENT_LENGTH);

  if (!title || !content) {
    return { ok: false, reason: 'title and content are required' };
  }

  const scope = resolveProposalScope(record, request.context);
  const kind = pickAllowed(record.kind, ALLOWED_PROPOSAL_KINDS, 'fact');
  const sensitivity = pickAllowed(record.sensitivity, ALLOWED_PROPOSAL_SENSITIVITIES, 'normal');
  const defaultVisibility = defaultProposalVisibility(scope, request.context);
  const requestedVisibility = pickAllowed(record.visibility, ALLOWED_PROPOSAL_VISIBILITIES, defaultVisibility);
  const visibility = safeProposalVisibility(scope, requestedVisibility, request);

  if (scope === 'group' && !request.actor.groupId) {
    return { ok: false, reason: 'group context is required to propose group memory' };
  }

  if (scope === 'global' && !canProposeGlobalMemory(request)) {
    return { ok: false, reason: 'owner or admin actor is required to propose global memory' };
  }

  return {
    ok: true,
    value: {
      scope,
      canonicalUserId: scope === 'user' ? request.actor.canonicalUserId : undefined,
      groupId: scope === 'group' || visibility === 'same_group_only' ? request.actor.groupId : undefined,
      conversationId: undefined,
      visibility,
      sensitivity,
      kind,
      title,
      content,
      confidence: clampUnitNumber(record.confidence, 0.5),
      importance: clampUnitNumber(record.importance, 0.5),
    },
  };
}

function resolveProposalScope(
  input: unknown,
  context: ToolHandlerRequest['context'],
): MemoryRecord['scope'] {
  const record = isRecord(input) ? input : {};
  const contextDefaultScope = context === 'group_chat' ? 'group' : 'user';
  return pickAllowed(record.scope, ALLOWED_PROPOSAL_SCOPES, contextDefaultScope);
}

function isMemoryAssociationOptedOut(
  privacyPreferences: PrivacyPreferenceRepository,
  canonicalUserId: string,
): boolean {
  return privacyPreferences.find(canonicalUserId, 'memory_association')?.state === 'opted_out';
}

function canProposeGlobalMemory(request: ToolHandlerRequest): boolean {
  return request.actor.actorClass === 'owner' || request.actor.actorClass === 'admin';
}

function normalizeBoundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function pickAllowed<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function defaultProposalVisibility(
  scope: MemoryRecord['scope'],
  context: ToolHandlerRequest['context'],
): MemoryRecord['visibility'] {
  if (scope === 'group') {
    return 'same_group_only';
  }

  if (context === 'group_chat') {
    return 'same_group_only';
  }

  return 'private_only';
}

function safeProposalVisibility(
  scope: MemoryRecord['scope'],
  visibility: MemoryRecord['visibility'],
  request: ToolHandlerRequest,
): MemoryRecord['visibility'] {
  if (scope === 'group') {
    return 'same_group_only';
  }

  if (scope === 'user' && request.context === 'group_chat') {
    return visibility === 'owner_admin_only' ? 'owner_admin_only' : 'same_group_only';
  }

  if (scope === 'global') {
    return visibility === 'public' ? 'public' : 'owner_admin_only';
  }

  return visibility;
}

function clampUnitNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(value, 0), 1);
}

function createMemoryDisableHandler(memoryRepository: MemoryRepository) {
  return async (
    request: ToolHandlerRequest,
  ): Promise<MemoryDisableOutput | PreparedLocalToolEffect<MemoryDisableOutput>> => {
    const input = parseDisableInput(request.input);
    if (!input.ok) {
      return {
        status: 'rejected',
        reason: input.reason,
      };
    }

    const memory = await memoryRepository.findById(input.value.memoryId);
    if (!memory || !canDisableMemory(memory, request)) {
      return {
        status: 'rejected',
        reason: 'memory not found or not allowed for this actor',
      };
    }

    if (memory.state === 'deleted') {
      return {
        status: 'rejected',
        reason: 'deleted memory cannot be disabled',
      };
    }

    if (memory.state !== 'active' && memory.state !== 'disabled') {
      return {
        status: 'rejected',
        reason: 'only active memory can be disabled',
      };
    }

    if (memory.state === 'disabled') {
      return {
        status: 'disabled',
        reason: 'memory already disabled',
      };
    }

    const publicResult: MemoryDisableOutput = {
      status: 'disabled',
      reason: 'memory disabled',
    };
    const memoryId = input.value.memoryId;
    const stateChange = {
      actor: {
        canonicalUserId: request.actor.canonicalUserId,
        actorClass: request.actor.actorClass,
        context: request.context,
      },
      reason: input.value.reason
        ? `memory.disable tool request: ${input.value.reason}`
        : 'memory.disable tool request',
      auditSummary: 'memory.disable disabled memory through tool request',
      auditDetails: {
        toolCallId: request.toolCallId,
        toolName: request.toolName,
      },
      evaluatorDecisionId: request.evaluatorDecisionId,
    };

    return prepareLocalToolEffect(publicResult, () => {
      memoryRepository.disableSync(memoryId, stateChange);
    });
  };
}

function parseDisableInput(input: unknown):
  | { ok: true; value: Required<MemoryDisableInput> }
  | { ok: false; reason: string } {
  const record = isRecord(input) ? input : {};
  const memoryId = normalizeBoundedString(record.memoryId, MAX_DISABLE_MEMORY_ID_LENGTH);
  if (!memoryId) {
    return { ok: false, reason: 'memoryId is required' };
  }

  const reason = normalizeBoundedString(record.reason, MAX_DISABLE_REASON_LENGTH) ?? 'memory.disable tool request';
  return {
    ok: true,
    value: {
      memoryId,
      reason,
    },
  };
}

function canDisableMemory(memory: MemoryRecord, request: ToolHandlerRequest): boolean {
  if (request.actor.actorClass === 'owner' || request.actor.actorClass === 'admin') {
    return true;
  }

  if (!request.actor.canonicalUserId || memory.visibility === 'owner_admin_only') {
    return false;
  }

  return memory.scope === 'user' && memory.canonicalUserId === request.actor.canonicalUserId;
}

function createGroupRecentSummaryHandler(database: Database.Database) {
  return async (request: ToolHandlerRequest): Promise<GroupRecentSummaryOutput> => {
    if (request.context !== 'group_chat' || !request.actor.groupId) {
      return emptyGroupRecentSummary('group context is required');
    }

    const input = parseGroupRecentSummaryInput(request.input);
    const rows = database.prepare(`
      SELECT sender_id, text, has_media, has_quote, mentions_bot, timestamp
      FROM chat_messages
      WHERE conversation_type = 'group'
        AND group_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(request.actor.groupId, input.limit) as GroupRecentSummaryRow[];

    const chronologicalRows = rows.reverse();
    const speakerLabels = new Map<string, string>();
    let nextParticipantIndex = 1;

    const excerpts = chronologicalRows.map((row) => {
      const fromBot = isBotSpeaker(row.sender_id);
      let speaker = 'bot';
      if (!fromBot) {
        const existing = speakerLabels.get(row.sender_id);
        speaker = existing ?? `participant_${nextParticipantIndex}`;
        if (!existing) {
          speakerLabels.set(row.sender_id, speaker);
          nextParticipantIndex += 1;
        }
      }

      return {
        speaker,
        text: toSafeGroupExcerpt(row.text),
        timestamp: new Date(row.timestamp).toISOString(),
        flags: groupMessageFlags(row, fromBot),
      };
    });

    const messageCount = chronologicalRows.length;
    const participantCount = countNonBotParticipants(chronologicalRows);
    const botMessageCount = chronologicalRows.filter((row) => isBotSpeaker(row.sender_id)).length;
    const mentionBotCount = chronologicalRows.filter((row) => row.mentions_bot === 1).length;
    const mediaMessageCount = chronologicalRows.filter((row) => row.has_media === 1).length;
    const quoteMessageCount = chronologicalRows.filter((row) => row.has_quote === 1).length;

    return {
      status: 'ok',
      reason: 'loaded current group recent chat summary',
      summary: messageCount === 0
        ? 'No recent group messages visible for this group.'
        : `Recent group context: ${messageCount} message(s), ${participantCount} participant(s), ${botMessageCount} bot message(s), ${mentionBotCount} bot mention(s), ${mediaMessageCount} media message(s), ${quoteMessageCount} quoted message(s).`,
      messageCount,
      participantCount,
      botMessageCount,
      mentionBotCount,
      mediaMessageCount,
      quoteMessageCount,
      ...(messageCount > 0
        ? {
            windowStart: excerpts[0]?.timestamp,
            windowEnd: excerpts[excerpts.length - 1]?.timestamp,
          }
        : {}),
      excerpts,
    };
  };
}

function emptyGroupRecentSummary(reason: string): GroupRecentSummaryOutput {
  return {
    status: 'rejected',
    reason,
    summary: '',
    messageCount: 0,
    participantCount: 0,
    botMessageCount: 0,
    mentionBotCount: 0,
    mediaMessageCount: 0,
    quoteMessageCount: 0,
    excerpts: [],
  };
}

function parseGroupRecentSummaryInput(input: unknown): Required<GroupRecentSummaryInput> {
  const record = isRecord(input) ? input : {};
  const rawLimit = typeof record.limit === 'number' ? record.limit : DEFAULT_GROUP_RECENT_LIMIT;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_GROUP_RECENT_LIMIT)
    : DEFAULT_GROUP_RECENT_LIMIT;

  return { limit };
}

function countNonBotParticipants(rows: GroupRecentSummaryRow[]): number {
  return new Set(
    rows
      .filter((row) => !isBotSpeaker(row.sender_id))
      .map((row) => row.sender_id)
  ).size;
}

function isBotSpeaker(senderId: string): boolean {
  return senderId === 'bot-self' || senderId.startsWith('qq-bot-');
}

function groupMessageFlags(row: GroupRecentSummaryRow, fromBot: boolean): string[] {
  const flags: string[] = [];
  if (fromBot) {
    flags.push('bot');
  }
  if (row.mentions_bot === 1) {
    flags.push('mentions_bot');
  }
  if (row.has_media === 1) {
    flags.push('has_media');
  }
  if (row.has_quote === 1) {
    flags.push('has_quote');
  }
  return flags;
}

function toSafeGroupExcerpt(text: string | null): string | undefined {
  const normalized = text?.trim();
  if (!normalized) {
    return undefined;
  }

  const platformRedacted = redactPlatformIdentifiers(normalized);
  const secretRedacted = redactSecretsInText(platformRedacted);
  const redacted = redactPlatformIdentifiers(secretRedacted.text);
  return redacted.length > MAX_GROUP_RECENT_EXCERPT_LENGTH
    ? `${redacted.slice(0, MAX_GROUP_RECENT_EXCERPT_LENGTH)}…`
    : redacted;
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

async function queryMemory(
  memoryRepository: MemoryRepository,
  query: string,
  filters: MemoryFilters,
): Promise<MemoryRecord[]> {
  const safeQuery = toSafeMemoryFtsQuery(query);
  if (!safeQuery) {
    return memoryRepository.retrieve(filters);
  }

  return memoryRepository.search(safeQuery, filters);
}

function dedupeRecords(records: MemoryRecord[]): MemoryRecord[] {
  return Array.from(new Map(records.map((record) => [record.id, record])).values());
}

function sortAndLimit(records: MemoryRecord[], limit: number): MemoryRecord[] {
  return [...records]
    .sort((left, right) =>
      right.importance - left.importance || right.createdAt.getTime() - left.createdAt.getTime()
    )
    .slice(0, limit);
}

function toSearchResultItem(record: MemoryRecord): MemorySearchResultItem {
  return {
    kind: record.kind,
    scope: record.scope,
    title: record.title,
    content: record.content,
    confidence: record.confidence,
    importance: record.importance,
    sourceContext: toSafeSourceContext(record.sourceContext),
  };
}

function toSafeSourceContext(sourceContext: string): string {
  const normalized = sourceContext.trim();
  const knownContexts = [
    'private_chat',
    'group_chat',
    'admin_cli',
    'tool_result',
    'background_worker',
    'imported_document',
    'system',
  ];

  return knownContexts.find((context) =>
    normalized === context
    || normalized.startsWith(`${context}:`)
    || normalized.startsWith(`${context}/`)
    || normalized.startsWith(`${context}#`)
    || normalized.startsWith(`${context}|`)
  ) ?? 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
