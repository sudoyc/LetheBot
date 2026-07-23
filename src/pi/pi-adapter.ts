/**
 * PiAdapter - Wraps Pi Agent Core for LetheBot
 *
 * Responsibilities:
 * - Converts LetheBot ContextPack to Pi AgentMessage[]
 * - Registers LetheBot tools as Pi AgentTool[]
 * - Handles tool execution hooks (beforeToolCall for PolicyGate)
 * - Streams Pi events back to LetheBot
 * - Extracts final response and action decisions from Pi output
 */

import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type AgentEvent,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type AfterToolCallContext,
  type AfterToolCallResult,
} from '@earendil-works/pi-agent-core';
import { getModel } from '@earendil-works/pi-ai/compat';
import type { Api, Message, Model, TextContent } from '@earendil-works/pi-ai';
import { ulid } from 'ulidx';
import { isDeepStrictEqual } from 'node:util';
import { createDeepSeekModel } from './deepseek-provider.js';
import {
  createProviderToolNameMap,
  toProviderToolName,
} from './tool-adapter.js';
import type { ContextPack, RecentMessage } from '../types/context.js';
import type { ActorContext, ToolRegistry } from '../tools/registry.js';
import type { PolicyGate } from '../policy/gate.js';
import type { ActorClass, InvocationContext, ToolHandler } from '../types/tool.js';
import type { AuditEntry } from '../types/audit.js';
import type { ToolCallRecordInput } from '../storage/tool-call-repository.js';
import type {
  LocalToolEffectCoordinator,
  LocalToolTerminalEvidence,
} from '../storage/local-tool-effect-coordinator.js';
import {
  isPreparedLocalToolEffect,
  type PreparedLocalToolEffect,
} from '../tools/prepared-local-effect.js';
import { limitToolOutput } from '../tools/output-limit.js';
import {
  getToolRuntimeFailure,
  startToolRuntimeGuard,
} from '../tools/runtime-limit.js';
import { isSupportedToolExecution } from '../tools/sandbox-policy.js';
import { redactSecretsInText } from '../memory/secret-scan.js';
import type {
  IEvaluator,
  ToolEvaluationRequest,
  ToolEvaluationResult,
} from '../types/evaluator.js';

type ToolResultContent = AfterToolCallContext['result']['content'];

type AuditLevel = AuditEntry['level'];

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_TOOL_EVALUATOR_CONTEXT_SUMMARY_CHARS = 512;
const MAX_TOOL_EVALUATOR_USER_UTTERANCE_CHARS = 256;
const TOOL_EVALUATOR_USER_UTTERANCE_TRUNCATION_MARKER =
  '[TRUNCATED:tool_evaluator_user_utterance]';

interface ToolAuditWriter {
  create(entry: Omit<AuditEntry, 'id'>): Promise<string>;
}

interface ToolCallWriter {
  create(entry: ToolCallRecordInput): Promise<string>;
}

interface ToolEvaluatorEvidence {
  request: ToolEvaluationRequest;
  result: ToolEvaluationResult;
}

interface ToolEvaluatorDecisionWriter {
  createToolDecision(evidence: ToolEvaluatorEvidence): Promise<string>;
}

interface ToolAuditInput {
  entry: ReturnType<ToolRegistry['getAll']>[number];
  toolCallId: string;
  turnId?: string;
  params: unknown;
  status: ToolCallRecordInput['status'];
  actor: ActorContext;
  invocationContext: InvocationContext;
  requestedBy?: ToolCallRecordInput['requestedBy'];
  summary: string;
  output?: unknown;
  errorMessage?: string;
  errorCode?: string;
  evaluatorDecisionId?: string;
  executionTimeMs?: number;
  redactionApplied: boolean;
}

interface ApprovedToolEvaluation {
  evaluatorDecisionId: string;
}

type ToolEvaluationAuthorization =
  | ({ allowed: true } & ApprovedToolEvaluation)
  | {
      allowed: false;
      reason: string;
      errorCode: string;
      evaluatorDecisionId?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isToolHandler(value: unknown): value is ToolHandler {
  return typeof value === 'function';
}

/**
 * LetheBot-specific agent input
 */
export interface PiAdapterInput {
  contextPack: ContextPack;
  systemPrompt: string;
  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
    groupId?: string;
  };
  invocationContext: InvocationContext;
  turnId: string;
  sourceEventIds?: string[];
}

/**
 * LetheBot-specific agent output
 */
export interface PiAdapterOutput {
  turnId: string;
  responseText?: string;
  toolCallIds: string[];
  events: PiAdapterEvent[];
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
  status: 'completed' | 'failed' | 'aborted';
  errorMessage?: string;
}

/**
 * Adapter-level events (enriched from Pi AgentEvent)
 */
export interface PiAdapterEvent {
  type: string;
  timestamp: Date;
  turnId: string;
  piEvent: AgentEvent;
}

/**
 * Main adapter class
 */
export class PiAdapter {
  private agent: Agent;
  private toolRegistry: ToolRegistry;
  private policyGate: PolicyGate;
  private currentTurnId?: string;
  private events: PiAdapterEvent[] = [];
  private recordedToolCallIds: string[] = [];
  private currentActor?: ActorContext;
  private currentInvocationContext?: InvocationContext;
  private auditRepository?: ToolAuditWriter;
  private toolCallRepository?: ToolCallWriter;
  private evaluator?: Pick<IEvaluator, 'evaluateTool'>;
  private evaluatorDecisionWriter?: ToolEvaluatorDecisionWriter;
  private localToolEffectCoordinator?: LocalToolEffectCoordinator;
  private readonly turnTimeoutMs: number;
  private turnLeaseTail: Promise<void> = Promise.resolve();
  private providerToolNameToCanonical = new Map<string, string>();
  private toolDirectoryGeneration = 0;

  constructor(options: {
    toolRegistry: ToolRegistry;
    policyGate: PolicyGate;
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    turnTimeoutMs?: number;
    auditRepository?: ToolAuditWriter;
    toolCallRepository?: ToolCallWriter;
    evaluator?: Pick<IEvaluator, 'evaluateTool'>;
    evaluatorDecisionWriter?: ToolEvaluatorDecisionWriter;
    localToolEffectCoordinator?: LocalToolEffectCoordinator;
  }) {
    const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(turnTimeoutMs)
      || turnTimeoutMs < 1
      || turnTimeoutMs > MAX_TIMER_DELAY_MS
    ) {
      throw new Error(`turnTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
    }

    this.toolRegistry = options.toolRegistry;
    this.policyGate = options.policyGate;
    this.auditRepository = options.auditRepository;
    this.toolCallRepository = options.toolCallRepository;
    this.evaluator = options.evaluator;
    this.evaluatorDecisionWriter = options.evaluatorDecisionWriter;
    this.localToolEffectCoordinator = options.localToolEffectCoordinator;
    this.turnTimeoutMs = turnTimeoutMs;

    // Create model configuration
    let model: Model<Api>;

    // 特殊处理 DeepSeek (使用 openai-completions API)
    if (options.provider === 'openai' && options.model.startsWith('deepseek-')) {
      model = createDeepSeekModel(options.model);
      if (options.baseUrl) {
        model.baseUrl = options.baseUrl;
      }
    } else {
      // 其他 provider 使用标准流程
      const lookupModel = getModel as (provider: string, modelId: string) => Model<Api> | undefined;
      const baseModel = lookupModel(options.provider, options.model);

      if (!baseModel) {
        throw new Error(`Failed to get model: ${options.provider}/${options.model}`);
      }

      model = {
        ...baseModel,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      };
    }

    // Create Pi Agent with LetheBot-specific configuration
    this.agent = new Agent({
      initialState: {
        systemPrompt: '', // Will be set per-turn
        model,
        tools: [],
        messages: [],
      },
      getApiKey: async (_provider: string) => {
        return options.apiKey;
      },
      convertToLlm: this.convertToLlm.bind(this),
      beforeToolCall: this.beforeToolCall.bind(this),
      afterToolCall: this.afterToolCall.bind(this),
    });

    // Subscribe to Pi events
    this.agent.subscribe(this.handlePiEvent.bind(this));
  }

  /**
   * Run a single agent turn
   */
  async runTurn(input: PiAdapterInput): Promise<PiAdapterOutput> {
    const releaseTurnLease = await this.acquireTurnLease();
    let deadlineReached = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      this.prepareTurn(input);

      // Update system prompt and tools
      this.agent.state.systemPrompt = input.systemPrompt;
      this.agent.state.tools = this.convertTools(input);

      // Convert ContextPack to AgentMessage[]
      const messages = this.contextPackToMessages(input.contextPack);

      // Run Pi agent
      deadlineTimer = setTimeout(() => {
        deadlineReached = true;
        this.agent.abort();
      }, this.turnTimeoutMs);
      await this.agent.prompt(messages);

      // Wait for completion
      await this.agent.waitForIdle();

      if (deadlineReached) {
        throw new Error(`Pi turn timed out after ${this.turnTimeoutMs} ms`);
      }

      // Extract result
      return this.extractOutput(input.turnId);
    } catch (error) {
      if (deadlineReached) {
        await this.agent.waitForIdle().catch(() => undefined);
      }
      const failure = deadlineReached
        ? new Error(`Pi turn timed out after ${this.turnTimeoutMs} ms`)
        : error;
      console.error('[PiAdapter] runTurn failed:', formatRuntimeFailureDiagnostic(failure));

      return {
        turnId: input.turnId,
        toolCallIds: this.recordedToolCallIds,
        events: this.events,
        tokensUsed: { input: 0, output: 0, total: 0 },
        status: 'failed',
        errorMessage: extractRuntimeFailureMessage(failure),
      };
    } finally {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      releaseTurnLease();
    }
  }

  /**
   * Stream a turn (returns async iterator)
   */
  async *streamTurn(input: PiAdapterInput): AsyncGenerator<PiAdapterEvent> {
    const releaseTurnLease = await this.acquireTurnLease();
    let runPromise: Promise<void> | undefined;

    try {
      this.prepareTurn(input);

      // Update system prompt and tools
      this.agent.state.systemPrompt = input.systemPrompt;
      this.agent.state.tools = this.convertTools(input);

      // Convert ContextPack to AgentMessage[]
      const messages = this.contextPackToMessages(input.contextPack);

      // Start agent turn (non-blocking)
      runPromise = this.agent.prompt(messages);

      // Yield events as they arrive
      let eventIndex = 0;
      while (true) {
        // Check if new events arrived
        if (eventIndex < this.events.length) {
          const event = this.events[eventIndex];
          if (event) {
            yield event;
          }
          eventIndex++;
        } else if (!this.agent.state.isStreaming) {
          // Agent finished and no more events
          break;
        } else {
          // Wait a bit for next event
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      // Ensure agent is fully idle
      await this.agent.waitForIdle();
      await runPromise;

      // Yield any remaining events
      while (eventIndex < this.events.length) {
        const event = this.events[eventIndex];
        if (event) {
          yield event;
        }
        eventIndex++;
      }
    } finally {
      if (runPromise) {
        if (this.agent.state.isStreaming) {
          this.agent.abort();
        }
        await Promise.allSettled([runPromise, this.agent.waitForIdle()]);
      }
      releaseTurnLease();
    }
  }

  /**
   * Abort current turn
   */
  abort(): void {
    this.agent.abort();
  }

  /**
   * Convert LetheBot ContextPack to Pi AgentMessage[]
   *
   * Strategy:
   * 1. System prompt is injected via agent.state.systemPrompt (not as a message)
   * 2. Memory blocks are formatted as system context in first user message
   * 3. Recent messages are converted to user/assistant messages
   * 4. Participant context is embedded in display names
   */
  private contextPackToMessages(pack: ContextPack): AgentMessage[] {
    const messages: AgentMessage[] = [];

    // Build context preamble (memory + participants)
    const contextLines: string[] = [];

    // Add memory context
    if (pack.memory.userProfile) {
      contextLines.push('## User Profile');
      contextLines.push(pack.memory.userProfile.content);
      contextLines.push('');
    }

    if (pack.memory.groupProfile) {
      contextLines.push('## Group Context');
      contextLines.push(pack.memory.groupProfile.content);
      contextLines.push('');
    }

    if (pack.memory.retrievedFacts.length > 0) {
      contextLines.push('## Relevant Facts');
      pack.memory.retrievedFacts.forEach((fact) => {
        contextLines.push(`- **${fact.title}**: ${fact.content}`);
      });
      contextLines.push('');
    }

    // Add structured identity context when ContextBuilder prepared it. Values
    // are rendered as prompt data, not instructions.
    if (pack.injectedIdentityData && pack.injectedIdentityData.length > 0) {
      contextLines.push('## Identity');
      pack.injectedIdentityData.forEach((field) => {
        contextLines.push(formatIdentityPromptLine(
          field.name === 'target_user_ref'
            ? { ...field, value: resolveCurrentSpeakerRef(pack) }
            : field,
        ));
      });
      contextLines.push('');
    }

    // Add participant context (for group chats)
    if (
      pack.conversation.conversationType === 'group' &&
      pack.participants.length > 0
    ) {
      contextLines.push('## Participants');
      pack.participants.forEach((p) => {
        contextLines.push(formatParticipantPromptLine(p));
      });
      contextLines.push('');
    }

    const messageReferenceLines = formatMessageReferencePromptLines(pack);
    if (messageReferenceLines.length > 0) {
      contextLines.push('## Message References');
      contextLines.push(...messageReferenceLines);
      contextLines.push('');
    }

    // Inject context as first user message (if any context exists)
    if (contextLines.length > 0) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<context>\n' + contextLines.join('\n') + '</context>\n',
          },
        ],
        timestamp: Date.now(),
      });
    }

    // Convert recent messages to user/assistant messages
    pack.recentMessages.forEach((msg) => {
      if (msg.isFromBot) {
        // Preserve historical assistant turns so multi-turn Pi context is not silently
        // reduced to user-only history.
        messages.push(this.historyBotMessageToAssistantMessage(msg));
        return;
      }

      // User messages
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: msg.text
              ? `sender_display_name=${formatPromptDataLiteral(msg.senderDisplayName)}\nmessage_text:\n${msg.text}`
              : `sender_display_name=${formatPromptDataLiteral(msg.senderDisplayName)}`,
          },
        ],
        timestamp: msg.timestamp.getTime(),
      });
    });

    return messages;
  }

  private historyBotMessageToAssistantMessage(msg: RecentMessage): AgentMessage {
    const model = this.agent.state.model;
    const fallbackModelId = isRecord(model) && typeof model.model === 'string'
      ? model.model
      : 'history';
    const modelId = model.id || fallbackModelId;

    return {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: msg.text ?? '',
        },
      ],
      api: model.api || 'openai-completions',
      provider: model.provider || 'lethebot-history',
      model: modelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: 'stop',
      timestamp: msg.timestamp.getTime(),
    };
  }

  /**
   * Convert AgentMessage[] to LLM-compatible Message[]
   * (Required by Pi Agent Core)
   */
  private convertToLlm(messages: AgentMessage[]): Message[] {
    // Filter to only standard LLM message types
    return messages.filter(
      (msg): msg is Message =>
        msg.role === 'user' || msg.role === 'assistant' || msg.role === 'toolResult'
    );
  }

  /**
   * Convert LetheBot ToolRegistryEntry to Pi AgentTool
   *
   * Strategy:
   * 1. Map ToolRegistryEntry metadata to AgentTool interface
   * 2. Wrap handler execution with audit and error handling
   * 3. Store actor/context for use in beforeToolCall hook
   */
  private convertTools(input: PiAdapterInput): AgentTool[] {
    const tools: AgentTool[] = [];
    const actor = this.buildActorContext(input);

    // Get all registered tools
    const registryTools = this.toolRegistry.getAll();
    const allowedTools = registryTools.filter((entry) =>
      isSupportedToolExecution(entry.sandboxPolicy.execution)
      && this.toolRegistry.checkPermission(entry.name, actor, input.invocationContext)
    );
    const providerToolNames = createProviderToolNameMap(
      allowedTools.map((entry) => entry.name),
    );
    const generation = this.toolDirectoryGeneration;

    allowedTools.forEach((entry) => {
      const canonicalName = entry.name;
      const canonicalEntry = { ...entry, name: canonicalName };
      const providerName = toProviderToolName(canonicalName);
      // Convert to Pi AgentTool
      const piTool: AgentTool = {
        name: providerName,
        description: canonicalEntry.description,
        label: canonicalName,
        parameters: canonicalEntry.piSchema.input as AgentTool['parameters'], // TypeBox TSchema

        execute: async (toolCallId, params, signal, _onUpdate) => {
          if (
            generation !== this.toolDirectoryGeneration
            || this.providerToolNameToCanonical.get(providerName) !== canonicalName
          ) {
            throw new Error('Tool is not available for the current turn');
          }

          const startedAt = Date.now();
          const policyResult = this.policyGate.checkToolCall({
            toolName: canonicalName,
            actor,
            context: input.invocationContext,
          });

          if (!policyResult.allowed) {
            const reason = policyResult.reason || 'Policy gate denied execution';

            await this.auditToolCall({
              entry: canonicalEntry,
              toolCallId,
              turnId: input.turnId,
              params,
              status: 'rejected',
              actor,
              invocationContext: input.invocationContext,
              summary: `${canonicalName} rejected: ${reason}`,
              errorMessage: reason,
              errorCode: 'POLICY_DENIED',
              executionTimeMs: Date.now() - startedAt,
              redactionApplied: false,
            });
            this.recordToolCallId(toolCallId);

            throw new Error(reason);
          }

          let evaluatorDecisionId: string | undefined;
          if (policyResult.requiresEvaluator) {
            const authorization = await this.evaluateRequiredTool({
              entry: canonicalEntry,
              params,
              actor,
              invocationContext: input.invocationContext,
              turnId: input.turnId,
              sourceEventIds: input.sourceEventIds ?? [],
              contextSummary: this.buildToolContextSummary(input.contextPack),
            });

            if (!authorization.allowed) {
              await this.auditToolCall({
                entry: canonicalEntry,
                toolCallId,
                turnId: input.turnId,
                params,
                status: 'rejected',
                actor,
                invocationContext: input.invocationContext,
                summary: `${canonicalName} rejected by evaluator policy`,
                errorMessage: authorization.reason,
                errorCode: authorization.errorCode,
                evaluatorDecisionId: authorization.evaluatorDecisionId,
                executionTimeMs: Date.now() - startedAt,
                redactionApplied: false,
              });
              this.recordToolCallId(toolCallId);
              throw new Error(authorization.reason);
            }

            evaluatorDecisionId = authorization.evaluatorDecisionId;

            const finalPolicyResult = this.policyGate.checkToolCall({
              toolName: canonicalName,
              actor,
              context: input.invocationContext,
            });
            if (!finalPolicyResult.allowed) {
              const reason = finalPolicyResult.reason || 'Policy gate denied execution after evaluator review';
              await this.auditToolCall({
                entry: canonicalEntry,
                toolCallId,
                turnId: input.turnId,
                params,
                status: 'rejected',
                actor,
                invocationContext: input.invocationContext,
                summary: `${canonicalName} rejected after evaluator review`,
                errorMessage: reason,
                errorCode: 'POLICY_DENIED_AFTER_EVALUATION',
                evaluatorDecisionId,
                executionTimeMs: Date.now() - startedAt,
                redactionApplied: false,
              });
              this.recordToolCallId(toolCallId);
              throw new Error(reason);
            }
          }

          // Execute tool handler
          const handler = this.toolRegistry.getHandler(canonicalName);
          if (!isToolHandler(handler)) {
            const reason = `No resolved function handler for tool: ${canonicalName}`;
            await this.auditToolCall({
              entry: canonicalEntry,
              toolCallId,
              turnId: input.turnId,
              params,
              status: 'error',
              actor,
              invocationContext: input.invocationContext,
              summary: `${canonicalName} failed: missing handler`,
              errorMessage: reason,
              errorCode: 'HANDLER_NOT_FOUND',
              evaluatorDecisionId,
              executionTimeMs: Date.now() - startedAt,
              redactionApplied: false,
            });
            this.recordToolCallId(toolCallId);
            throw new Error(reason);
          }

          let preparedEffect: PreparedLocalToolEffect | undefined;
          const runtimeGuard = startToolRuntimeGuard(
            signal,
            canonicalEntry.sandboxPolicy.maxRuntimeMs,
          );
          try {
            let handlerResult: unknown;
            try {
              runtimeGuard.throwIfAbortedOrExpired();
              try {
                handlerResult = await handler({
                  toolCallId,
                  turnId: input.turnId,
                  toolName: canonicalName,
                  signal: runtimeGuard.signal,
                  input: params,
                  actor,
                  context: input.invocationContext,
                  ...(evaluatorDecisionId ? { evaluatorDecisionId } : {}),
                  ...(input.sourceEventIds && input.sourceEventIds.length > 0
                    ? { sourceEventIds: [...input.sourceEventIds] }
                    : {}),
                });
              } catch (error) {
                runtimeGuard.throwIfAbortedOrExpired();
                throw error;
              }
              preparedEffect = isPreparedLocalToolEffect(handlerResult)
                ? handlerResult
                : undefined;
              runtimeGuard.throwIfAbortedOrExpired();
            } finally {
              runtimeGuard.dispose();
            }
            const result = preparedEffect ? preparedEffect.publicResult : handlerResult;

            // Track executed tool
            this.recordToolCallId(toolCallId);

            const formatted = this.formatToolResult(result);
            const redactedText = redactRuntimeDiagnosticText(formatted);
            const redactedDetails = this.redactStructuredValue(result);
            const limitedOutput = limitToolOutput(
              redactedText,
              redactedDetails.value,
              canonicalEntry.sandboxPolicy.maxOutputBytes,
            );
            const redactionApplied = redactedText !== formatted
              || containsRedactionMarker(redactedText)
              || redactedDetails.redacted;

            await this.auditToolCall(
              {
                entry: canonicalEntry,
                toolCallId,
                turnId: input.turnId,
                params,
                status: 'success',
                actor,
                invocationContext: input.invocationContext,
                summary: `${canonicalName} executed${redactionApplied ? ' (redacted)' : ''}${limitedOutput.truncated ? ' (output truncated)' : ''}`,
                output: limitedOutput.durableOutput,
                evaluatorDecisionId,
                executionTimeMs: Date.now() - startedAt,
                redactionApplied,
              },
              preparedEffect ? { preparedEffect } : undefined,
            );

            // Convert to Pi AgentToolResult
            return {
              content: [
                {
                  type: 'text',
                  text: limitedOutput.promptText,
                },
              ],
              details: limitedOutput.durableOutput,
              terminate: false,
            };
          } catch (error) {
            const runtimeFailure = getToolRuntimeFailure(error);
            const message = runtimeFailure?.message
              ?? (error instanceof Error ? error.message : String(error));
            const redactedMessage = redactSecretsInText(message);
            await this.auditToolCall(
              {
                entry: canonicalEntry,
                toolCallId,
                turnId: input.turnId,
                params,
                status: runtimeFailure?.status ?? 'error',
                actor,
                invocationContext: input.invocationContext,
                summary: `${canonicalName} failed: ${redactedMessage.text}`,
                errorMessage: redactedMessage.text,
                errorCode: runtimeFailure?.code ?? 'TOOL_HANDLER_ERROR',
                evaluatorDecisionId,
                executionTimeMs: Date.now() - startedAt,
                redactionApplied: redactedMessage.findings.length > 0,
              },
              preparedEffect ? { atomicTerminal: true } : undefined,
            );
            this.recordToolCallId(toolCallId);
            throw new Error(redactedMessage.text);
          }
        },
      };

      tools.push(piTool);
    });

    this.providerToolNameToCanonical = providerToolNames;
    return tools;
  }

  /**
   * Format tool result for LLM consumption
   */
  private formatToolResult(result: unknown): string {
    if (typeof result === 'string') {
      return result;
    }

    if (isRecord(result)) {
      // Try to extract a natural language summary
      const summary = result.summary;
      if (typeof summary === 'string') return summary;
      const message = result.message;
      if (typeof message === 'string') return message;
      const output = result.output;
      if (typeof output === 'string') return output;
      if (output !== undefined) return JSON.stringify(output, null, 2);

      // Fallback to JSON
      return JSON.stringify(result, null, 2);
    }

    return String(result);
  }

  /**
   * Handle Pi Agent events and convert to LetheBot events
   *
   * Strategy:
   * 1. Listen to all Pi AgentEvent types
   * 2. Enrich with LetheBot metadata (turnId, timestamp)
   * 3. Store events for later retrieval
   * 4. Extract token usage and status
   */
  private async handlePiEvent(
    event: AgentEvent,
    _signal: AbortSignal
  ): Promise<void> {
    if (!this.currentTurnId) return;

    // Create adapter event
    const adapterEvent: PiAdapterEvent = {
      type: event.type,
      timestamp: new Date(),
      turnId: this.currentTurnId,
      piEvent: event,
    };

    // Store event
    this.events.push(adapterEvent);

    // Handle specific event types
    switch (event.type) {
      case 'tool_execution_start':
        // Track tool call
        break;

      case 'tool_execution_end':
        // Tool finished
        break;

      case 'turn_end':
        // Turn completed
        break;

      case 'agent_end':
        // Agent finished
        break;

      case 'message_update':
        // Streaming text update
        break;
    }
  }

  /**
   * Extract final output from agent state and events
   */
  private extractOutput(turnId: string): PiAdapterOutput {
    const agent = this.agent;

    // Get final assistant message
    const messages = agent.state.messages;
    const lastMessage = messages[messages.length - 1];

    let responseText: string | undefined;
    if (lastMessage && lastMessage.role === 'assistant') {
      // Extract text from assistant message content
      const textBlocks = lastMessage.content.filter(
        (c): c is TextContent => c.type === 'text'
      );
      if (textBlocks.length > 0) {
        responseText = textBlocks.map((t) => t.text).join('');
      }
    }

    // Extract token usage (if available from events)
    // Pi doesn't directly expose token counts, so we estimate or use provider metadata
    const tokensUsed = {
      input: 0,
      output: 0,
      total: 0,
    };

    // Try to extract from events (provider-specific)
    const messageEndEvents = this.events.filter((e) => e.type === 'message_end');
    if (messageEndEvents.length > 0) {
      // Would need to inspect piEvent for usage metadata
      // This is provider-specific (Anthropic includes usage in response)
    }

    // Determine status
    let status: 'completed' | 'failed' | 'aborted' = 'completed';
    let errorMessage: string | undefined;

    if (agent.state.errorMessage) {
      status = 'failed';
      errorMessage = redactRuntimeDiagnosticText(agent.state.errorMessage);
    }

    return {
      turnId,
      responseText,
      toolCallIds: this.recordedToolCallIds,
      events: this.events,
      tokensUsed,
      status,
      errorMessage,
    };
  }

  private async evaluateRequiredTool(input: {
    entry: ReturnType<ToolRegistry['getAll']>[number];
    params: unknown;
    actor: ActorContext;
    invocationContext: InvocationContext;
    turnId?: string;
    sourceEventIds: string[];
    contextSummary: string;
  }): Promise<ToolEvaluationAuthorization> {
    if (!this.evaluator || !this.evaluatorDecisionWriter) {
      return {
        allowed: false,
        reason: 'Tool requires evaluator review',
        errorCode: 'EVALUATOR_REQUIRED',
      };
    }

    if (!input.turnId) {
      return {
        allowed: false,
        reason: 'Tool evaluator review requires a current turn',
        errorCode: 'EVALUATOR_TURN_REQUIRED',
      };
    }

    if (
      input.sourceEventIds.length === 0
      || input.sourceEventIds.some((sourceEventId) =>
        typeof sourceEventId !== 'string' || sourceEventId.trim().length === 0
      )
    ) {
      return {
        allowed: false,
        reason: 'Tool evaluator review requires source event evidence',
        errorCode: 'EVALUATOR_SOURCE_REQUIRED',
      };
    }

    const toolInput = cloneToolInput(input.params);
    if (!toolInput) {
      return {
        allowed: false,
        reason: 'Tool evaluator input must be a cloneable object',
        errorCode: 'EVALUATOR_INPUT_INVALID',
      };
    }

    const request: ToolEvaluationRequest = {
      requestId: ulid(),
      domain: 'tool',
      turnId: input.turnId,
      actor: {
        canonicalUserId: input.actor.canonicalUserId,
        actorClass: input.actor.actorClass,
      },
      context: input.invocationContext,
      sourceEventIds: [...new Set(input.sourceEventIds)],
      contextSummary: input.contextSummary.slice(0, MAX_TOOL_EVALUATOR_CONTEXT_SUMMARY_CHARS),
      createdAt: new Date(),
      toolName: input.entry.name,
      capabilities: [...input.entry.capabilities],
      toolInput,
      proposedReason: 'Pi requested a registered evaluator-required tool',
    };

    const evaluatorRequest = structuredClone(request);
    let result: ToolEvaluationResult;
    try {
      result = await this.evaluator.evaluateTool(evaluatorRequest);
    } catch {
      return {
        allowed: false,
        reason: 'Tool evaluator review failed',
        errorCode: 'EVALUATOR_ERROR',
      };
    }

    if (!isDeepStrictEqual(evaluatorRequest, request)) {
      return {
        allowed: false,
        reason: 'Tool evaluator mutated its review request',
        errorCode: 'EVALUATOR_REQUEST_MUTATED',
      };
    }

    if (!isValidToolEvaluationResult(result, request.requestId)) {
      return {
        allowed: false,
        reason: 'Tool evaluator returned an invalid decision',
        errorCode: 'EVALUATOR_INVALID_RESULT',
      };
    }

    let evaluatorDecisionId: string;
    try {
      evaluatorDecisionId = await this.evaluatorDecisionWriter.createToolDecision({ request, result });
    } catch {
      return {
        allowed: false,
        reason: 'Tool evaluator decision could not be recorded',
        errorCode: 'EVALUATOR_PERSISTENCE_ERROR',
      };
    }

    if (evaluatorDecisionId !== result.decisionId) {
      return {
        allowed: false,
        reason: 'Tool evaluator decision identity mismatch',
        errorCode: 'EVALUATOR_IDENTITY_MISMATCH',
      };
    }

    if (result.decision !== 'approve') {
      return {
        allowed: false,
        reason: 'Tool evaluator did not approve execution',
        errorCode: `EVALUATOR_${result.decision.toUpperCase()}`,
        evaluatorDecisionId,
      };
    }

    if (result.riskLevel === 'prohibited') {
      return {
        allowed: false,
        reason: 'Tool evaluator classified execution as prohibited',
        errorCode: 'EVALUATOR_PROHIBITED',
        evaluatorDecisionId,
      };
    }

    if (
      result.modifiedToolInput !== undefined
      || result.alternativeTool !== undefined
      || result.additionalConstraints !== undefined
    ) {
      return {
        allowed: false,
        reason: 'Tool evaluator requested unsupported execution changes',
        errorCode: 'EVALUATOR_CHANGES_UNSUPPORTED',
        evaluatorDecisionId,
      };
    }

    return {
      allowed: true,
      evaluatorDecisionId,
    };
  }

  private buildToolContextSummary(pack: ContextPack): string {
    const latestUserUtterance = [...pack.recentMessages]
      .reverse()
      .find((message) => !message.isFromBot && typeof message.text === 'string')
      ?.text;

    return buildBoundedToolEvaluatorContextSummary({
      latestUserUtterance,
      conversationType: pack.conversation.conversationType,
      groupContext: Boolean(pack.conversation.groupId),
      recentMessageCount: pack.recentMessages.length,
      selectedMemoryCount: pack.memory.selectedMemoryIds.length,
    });
  }

  /**
   * beforeToolCall hook - PolicyGate integration
   *
   * Strategy:
   * 1. Called by Pi before executing any tool
   * 2. Check with PolicyGate for L0 permission enforcement
   * 3. Return { block: true } to prevent execution
   * 4. Store metadata for audit
   */
  private async beforeToolCall(
    context: BeforeToolCallContext,
    _signal?: AbortSignal
  ): Promise<BeforeToolCallResult | undefined> {
    const toolName = this.providerToolNameToCanonical.get(context.toolCall.name);
    if (!toolName) {
      return {
        block: true,
        reason: 'Unknown provider tool name',
      };
    }

    // Get actor context from current turn
    const actor = this.getCurrentActor();
    const invocationContext = this.getCurrentInvocationContext();

    if (!actor || !invocationContext) {
      return {
        block: true,
        reason: 'Missing actor or context information',
      };
    }

    const tool = this.toolRegistry.get(toolName);

    // Check with PolicyGate
    const policyResult = this.policyGate.checkToolCall({
      toolName,
      actor,
      context: invocationContext,
    });

    if (!policyResult.allowed) {
      const reason = policyResult.reason || 'Policy gate denied execution';
      if (tool) {
        await this.auditToolCall({
          entry: tool,
          toolCallId: context.toolCall.id,
          turnId: this.currentTurnId,
          params: context.args,
          status: 'rejected',
          actor,
          invocationContext,
          summary: `${toolName} rejected: ${reason}`,
          errorMessage: reason,
          errorCode: 'POLICY_DENIED',
          redactionApplied: false,
        });
        this.recordToolCallId(context.toolCall.id);
      }

      // Block tool execution
      return {
        block: true,
        reason,
      };
    }

    if (policyResult.requiresEvaluator) {
      // Pi validates arguments before this hook and invokes the wrapped execute
      // next. Evaluator review happens there exactly once so direct execution
      // tests and the real Pi loop share the same final authority boundary.
      return undefined;
    }

    // Allow execution
    return undefined;
  }

  /**
   * afterToolCall hook - Result processing and audit
   *
   * Strategy:
   * 1. Called by Pi after tool executes
   * 2. Apply output sensitivity filtering
   * 3. Audit tool execution
   * 4. Check for termination conditions
   */
  private async afterToolCall(
    context: AfterToolCallContext,
    _signal?: AbortSignal
  ): Promise<AfterToolCallResult | undefined> {
    const toolName = this.providerToolNameToCanonical.get(context.toolCall.name);
    if (!toolName) {
      return {
        content: [{ type: 'text', text: 'Unknown provider tool name' }],
        isError: true,
      };
    }
    const tool = this.toolRegistry.get(toolName);

    if (!tool) {
      return {
        content: [{ type: 'text', text: 'Provider tool is unavailable' }],
        isError: true,
      };
    }

    // Check output sensitivity
    if (tool.outputSensitivity === 'secret_possible') {
      // Scan for secrets before returning to LLM
      const scannedContent = this.scanForSecrets(context.result.content);

      if (scannedContent.hasSecrets) {
        return {
          content: scannedContent.redactedContent,
          isError: false,
        };
      }
    }

    // Audit tool execution
    // (In full implementation, this would write to audit table)

    // Check for early termination
    // (E.g., if tool explicitly requests it)
    const shouldTerminate = context.result.terminate === true;

    return shouldTerminate
      ? {
          terminate: true,
        }
      : undefined;
  }

  /**
   * Helper: Get current actor context
   */
  private getCurrentActor() {
    return this.currentActor;
  }

  /**
   * Helper: Get current invocation context
   */
  private getCurrentInvocationContext() {
    return this.currentInvocationContext;
  }

  /**
   * Helper: Scan tool output for secrets
   */
  private scanForSecrets(content: ToolResultContent): {
    hasSecrets: boolean;
    redactedContent: ToolResultContent;
  } {
    let hasSecrets = false;
    const redactedContent = content.map((block) => {
      if (block.type !== 'text') {
        return block;
      }

      const redacted = redactSecretsInText(block.text);
      if (redacted.findings.length > 0) {
        hasSecrets = true;
      }

      return {
        ...block,
        text: redacted.text,
      };
    });

    return { hasSecrets, redactedContent };
  }

  private redactStructuredValue(
    value: unknown,
    path: string[] = [],
  ): { value: unknown; redacted: boolean } {
    if (typeof value === 'string') {
      const redacted = redactRuntimeDiagnosticText(value);
      return {
        value: redacted,
        redacted: redacted !== value || containsRedactionMarker(redacted),
      };
    }

    if (typeof value === 'number' && shouldRedactNumericPlatformId(path, value)) {
      return { value: '[REDACTED:platform_id]', redacted: true };
    }

    if (Array.isArray(value)) {
      let redacted = false;
      const items = value.map((item) => {
        const result = this.redactStructuredValue(item, path);
        redacted = redacted || result.redacted;
        return result.value;
      });
      return { value: items, redacted };
    }

    if (isRecord(value)) {
      let redacted = false;
      const result: Record<string, unknown> = {};

      for (const [key, child] of Object.entries(value)) {
        const redactedKey = redactRuntimeDiagnosticText(key);
        const childResult = this.redactStructuredValue(child, [...path, key]);
        redacted = redacted
          || redactedKey !== key
          || containsRedactionMarker(redactedKey)
          || childResult.redacted;
        result[redactedKey] = childResult.value;
      }

      return { value: result, redacted };
    }

    return { value, redacted: false };
  }

  private recordToolCallId(toolCallId: string): void {
    if (!this.recordedToolCallIds.includes(toolCallId)) {
      this.recordedToolCallIds.push(toolCallId);
    }
  }

  private async auditToolCall(
    input: ToolAuditInput,
    options?: {
      preparedEffect?: PreparedLocalToolEffect;
      atomicTerminal?: boolean;
    },
  ): Promise<void> {
    const evidence = this.buildToolTerminalEvidence(input);

    if (options?.preparedEffect) {
      if (!this.localToolEffectCoordinator || !evidence.toolCall) {
        throw new Error('prepared local tool effect requires atomic terminal persistence');
      }
      this.localToolEffectCoordinator.commitEffectAndTerminal(options.preparedEffect, {
        toolCall: evidence.toolCall,
        audit: evidence.audit,
      });
      return;
    }

    if (options?.atomicTerminal) {
      if (!this.localToolEffectCoordinator || !evidence.toolCall) {
        throw new Error(
          'atomic tool terminal persistence requires a coordinator and turn id'
        );
      }
      this.localToolEffectCoordinator.commitTerminalPair({
        toolCall: evidence.toolCall,
        audit: evidence.audit,
      });
      return;
    }

    if (this.toolCallRepository && evidence.toolCall) {
      await this.toolCallRepository.create(evidence.toolCall);
    }

    if (this.auditRepository) {
      await this.auditRepository.create(evidence.audit);
    }
  }

  private buildToolTerminalEvidence(
    input: ToolAuditInput,
  ): Omit<LocalToolTerminalEvidence, 'toolCall'> & { toolCall?: ToolCallRecordInput } {
    const params = this.redactStructuredValue(input.params);
    const redactionApplied = input.redactionApplied || params.redacted;
    const level = this.auditLevelForExecution(input.entry.auditLevel, redactionApplied);
    const details = level === 'summary'
      ? {
          toolName: input.entry.name,
          status: input.status,
          capabilities: input.entry.capabilities,
          ...(input.actor.groupId ? { groupId: input.actor.groupId } : {}),
          redactionApplied,
          errorMessage: input.errorMessage,
        }
      : {
          toolName: input.entry.name,
          status: input.status,
          capabilities: input.entry.capabilities,
          ...(input.actor.groupId ? { groupId: input.actor.groupId } : {}),
          input: params.value,
          output: input.output,
          errorMessage: input.errorMessage,
          redactionApplied,
        };

    const turnId = input.turnId ?? this.currentTurnId;
    const toolCall = turnId
      ? {
          id: input.toolCallId,
          turnId,
          toolName: input.entry.name,
          input: params.value,
          output: input.output,
          requestedBy: input.requestedBy ?? 'pi',
          actor: input.actor,
          context: input.invocationContext,
          status: input.status,
          errorCode: input.errorCode ?? this.defaultToolErrorCode(input.status),
          errorMessage: input.errorMessage,
          evaluatorDecisionId: input.evaluatorDecisionId,
          executionTimeMs: input.executionTimeMs,
          secretsRedacted: redactionApplied,
        }
      : undefined;

    return {
      toolCall,
      audit: {
        timestamp: new Date(),
        category: 'tool',
        level,
        eventType: this.toolAuditEventType(input.status),
        eventId: input.toolCallId,
        actor: {
          canonicalUserId: input.actor.canonicalUserId,
          actorClass: input.actor.actorClass,
          context: input.invocationContext,
        },
        summary: input.summary,
        details,
        redacted: redactionApplied || level === 'redacted_full',
        riskLevel: this.toolRiskLevel(input.entry),
        evaluatorDecisionId: input.evaluatorDecisionId,
      },
    };
  }

  private defaultToolErrorCode(status: ToolCallRecordInput['status']): string | undefined {
    if (status === 'success') {
      return undefined;
    }

    if (status === 'rejected') {
      return 'TOOL_REJECTED';
    }

    return status === 'timeout' ? 'TOOL_TIMEOUT' : 'TOOL_ERROR';
  }

  private auditLevelForExecution(
    configured: 'none' | AuditLevel,
    redactionApplied: boolean
  ): AuditLevel {
    if (redactionApplied) {
      return 'redacted_full';
    }

    return configured === 'none' ? 'summary' : configured;
  }

  private toolAuditEventType(status: ToolCallRecordInput['status']): string {
    if (status === 'success') {
      return 'tool.executed';
    }

    return status === 'rejected' ? 'tool.rejected' : 'tool.failed';
  }

  private toolRiskLevel(entry: ReturnType<ToolRegistry['getAll']>[number]): AuditEntry['riskLevel'] {
    if (
      entry.evaluatorPolicy === 'required'
      || entry.capabilities.some((capability) =>
        capability === 'shell_exec'
        || capability === 'credential_access'
        || capability === 'platform_admin'
        || capability === 'write_local'
        || capability === 'external_side_effect'
      )
    ) {
      return 'high';
    }

    if (entry.outputSensitivity === 'sensitive' || entry.outputSensitivity === 'secret_possible') {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Store actor/context when starting turn
   * (Called at beginning of runTurn/streamTurn)
   */
  private setCurrentContext(input: PiAdapterInput): void {
    this.currentActor = this.buildActorContext(input);
    this.currentInvocationContext = input.invocationContext;
  }

  private prepareTurn(input: PiAdapterInput): void {
    this.currentTurnId = input.turnId;
    this.events = [];
    this.recordedToolCallIds = [];
    this.setCurrentContext(input);
    this.toolDirectoryGeneration += 1;
    this.providerToolNameToCanonical = new Map();
    this.agent.reset();
    this.agent.state.tools = [];
  }

  private async acquireTurnLease(): Promise<() => void> {
    const previousLease = this.turnLeaseTail;
    let releaseLease = (): void => undefined;
    this.turnLeaseTail = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    await previousLease;

    let released = false;
    return () => {
      if (!released) {
        released = true;
        releaseLease();
      }
    };
  }

  private buildActorContext(input: PiAdapterInput): ActorContext {
    const actor: ActorContext = {
      actorClass: input.actor.actorClass,
    };

    if (input.actor.canonicalUserId !== undefined) {
      actor.canonicalUserId = input.actor.canonicalUserId;
    }

    const groupId = input.actor.groupId ?? input.contextPack.conversation.groupId;
    if (groupId) {
      actor.groupId = groupId;
    }

    return actor;
  }
}

function buildBoundedToolEvaluatorContextSummary(input: {
  latestUserUtterance?: string;
  conversationType: ContextPack['conversation']['conversationType'];
  groupContext: boolean;
  recentMessageCount: number;
  selectedMemoryCount: number;
}): string {
  const metadata = {
    conversationType: input.conversationType,
    groupContext: input.groupContext,
    recentMessageCount: input.recentMessageCount,
    selectedMemoryCount: input.selectedMemoryCount,
  };
  if (input.latestUserUtterance === undefined) {
    return JSON.stringify(metadata);
  }

  const characters = Array.from(redactRuntimeDiagnosticText(input.latestUserUtterance));
  const maximumPrefixLength = extendPrefixThroughRedactionMarker(
    characters,
    Math.min(
      characters.length,
      MAX_TOOL_EVALUATOR_USER_UTTERANCE_CHARS,
    ),
  );
  let low = 0;
  let high = maximumPrefixLength;
  let best = JSON.stringify(metadata);

  while (low <= high) {
    const prefixLength = Math.floor((low + high) / 2);
    const safePrefixLength = extendPrefixThroughRedactionMarker(characters, prefixLength);
    const truncated = safePrefixLength < characters.length;
    const candidateUtterance = `${characters.slice(0, safePrefixLength).join('')}${
      truncated ? TOOL_EVALUATOR_USER_UTTERANCE_TRUNCATION_MARKER : ''
    }`;
    const candidate = JSON.stringify({
      latestUserUtterance: candidateUtterance,
      ...metadata,
    });

    if (candidate.length <= MAX_TOOL_EVALUATOR_CONTEXT_SUMMARY_CHARS) {
      best = candidate;
      low = prefixLength + 1;
    } else {
      high = prefixLength - 1;
    }
  }

  return best;
}

function extendPrefixThroughRedactionMarker(
  characters: string[],
  prefixLength: number,
): number {
  const prefix = characters.slice(0, prefixLength).join('');
  const markerStart = prefix.lastIndexOf('[REDACTED:');
  if (markerStart < 0 || prefix.indexOf(']', markerStart) >= 0) {
    return prefixLength;
  }

  const markerEnd = characters.indexOf(']', prefixLength);
  return markerEnd < 0 ? prefixLength : markerEnd + 1;
}

function cloneToolInput(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  try {
    const cloned = structuredClone(value);
    return isPlainRecord(cloned) ? cloned : undefined;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidToolEvaluationResult(
  value: unknown,
  requestId: string,
): value is ToolEvaluationResult {
  if (!isRecord(value)) {
    return false;
  }

  const decisions = new Set(['approve', 'reject', 'downgrade', 'propose']);
  const riskLevels = new Set(['low', 'medium', 'high', 'prohibited']);
  return value.domain === 'tool'
    && typeof value.decisionId === 'string'
    && value.decisionId.length > 0
    && value.requestId === requestId
    && typeof value.decision === 'string'
    && decisions.has(value.decision)
    && typeof value.reason === 'string'
    && typeof value.confidence === 'number'
    && Number.isFinite(value.confidence)
    && value.confidence >= 0
    && value.confidence <= 1
    && typeof value.riskLevel === 'string'
    && riskLevels.has(value.riskLevel)
    && value.decidedAt instanceof Date
    && Number.isFinite(value.decidedAt.getTime())
    && typeof value.evaluatorVersion === 'string'
    && value.evaluatorVersion.length > 0;
}


function extractRuntimeFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactRuntimeDiagnosticText(error.message || error.name || 'Unknown error');
  }

  const text = stringifyRuntimeDiagnostic(error);
  return redactRuntimeDiagnosticText(text || 'Unknown error');
}

function formatRuntimeFailureDiagnostic(error: unknown): string {
  if (error instanceof Error) {
    return JSON.stringify({
      name: redactRuntimeDiagnosticText(error.name || 'Error'),
      message: redactRuntimeDiagnosticText(error.message || error.name || 'Unknown error'),
      ...(error.stack ? { stack: '[REDACTED:stack]' } : {}),
    });
  }

  return redactRuntimeDiagnosticText(stringifyRuntimeDiagnostic(error));
}

function stringifyRuntimeDiagnostic(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined) {
    return 'Unknown error';
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  } catch {
    return String(value);
  }
}

function redactRuntimeDiagnosticText(value: string): string {
  const platformRedacted = redactPlatformIdentifiers(value);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function formatPromptDataLiteral(value: string): string {
  return JSON.stringify(sanitizePromptDataText(value));
}

function formatParticipantPromptLine(participant: ContextPack['participants'][number]): string {
  const flags = [];
  if (participant.isOwner) flags.push('owner');
  if (participant.isAdmin) flags.push('admin');
  if (participant.isTrusted) flags.push('trusted');

  const participantWithRef = participant as ContextPack['participants'][number] & {
    speakerRef?: string;
  };
  const parts = [
    ...(participantWithRef.speakerRef
      ? [`- speaker_ref=${validatePromptRef(participantWithRef.speakerRef, 'speaker')}`]
      : ['-']),
    `display_name=${formatPromptDataLiteral(participant.displayName)}`,
  ];
  if (flags.length > 0) {
    parts.push(`flags=[${flags.join(', ')}]`);
  }
  if (participant.role) {
    parts.push(`role=${participant.role}`);
  }
  if (participant.groupCard) {
    parts.push(`group_card=${formatPromptDataLiteral(participant.groupCard)}`);
  }

  return parts.join(' ');
}

function formatMessageReferencePromptLines(pack: ContextPack): string[] {
  const referencedPack = pack;
  const hasAnyReferenceData = referencedPack.currentMessageRef !== undefined
    || referencedPack.replyReference !== undefined
    || referencedPack.recentMessages.some((message) => (
      message.messageRef !== undefined
      || message.speakerRef !== undefined
      || message.isCurrent !== undefined
    ));
  if (!hasAnyReferenceData) {
    return [];
  }

  const currentMessageRef = validatePromptRef(referencedPack.currentMessageRef, 'message');
  const lines = referencedPack.recentMessages.map((message) => {
    const messageRef = validatePromptRef(message.messageRef, 'message');
    const speakerRef = validatePromptRef(message.speakerRef, 'speaker');
    if (typeof message.isCurrent !== 'boolean') {
      throw new Error('Pi context message reference requires an explicit current marker');
    }
    return {
      messageRef,
      isCurrent: message.isCurrent,
      line: `- message_ref=${messageRef} speaker_ref=${speakerRef} role=${message.isFromBot ? 'bot' : 'human'} current=${message.isCurrent}`,
    };
  });
  if (new Set(lines.map((message) => message.messageRef)).size !== lines.length) {
    throw new Error('Pi context message references must be unique');
  }
  const currentMessages = lines.filter((message) => message.isCurrent);
  if (currentMessages.length !== 1 || currentMessages[0]?.messageRef !== currentMessageRef) {
    throw new Error('Pi context current message reference is inconsistent');
  }

  const promptLines = lines.map((message) => message.line);
  if (referencedPack.replyReference) {
    promptLines.push(formatReplyReferencePromptLine(
      referencedPack.replyReference,
      currentMessageRef,
    ));
  }
  return promptLines;
}

function formatReplyReferencePromptLine(
  reference: NonNullable<ContextPack['replyReference']>,
  currentMessageRef: string,
): string {
  const sourceMessageRef = validatePromptRef(reference.sourceMessageRef, 'message');
  if (sourceMessageRef !== currentMessageRef) {
    throw new Error('Pi context reply source does not match the current message');
  }
  if (reference.status === 'unresolved') {
    if (
      reference.targetMessageRef !== undefined
      || reference.targetSpeakerRef !== undefined
      || reference.targetRole !== undefined
      || reference.targetInRollingWindow !== undefined
    ) {
      throw new Error('Pi unresolved reply reference cannot contain a target');
    }
    return `- reply status=unresolved source_message_ref=${sourceMessageRef}`;
  }
  if (reference.status !== 'resolved') {
    throw new Error('Pi context reply reference status is invalid');
  }

  const targetMessageRef = validatePromptRef(reference.targetMessageRef, 'message');
  const targetSpeakerRef = validatePromptRef(reference.targetSpeakerRef, 'speaker');
  if (
    (reference.targetRole !== 'human' && reference.targetRole !== 'bot')
    || typeof reference.targetInRollingWindow !== 'boolean'
  ) {
    throw new Error('Pi resolved reply reference target is invalid');
  }
  return `- reply status=resolved source_message_ref=${sourceMessageRef} target_message_ref=${targetMessageRef} target_speaker_ref=${targetSpeakerRef} target_role=${reference.targetRole} target_in_rolling_window=${reference.targetInRollingWindow}`;
}

function validatePromptRef(
  value: string | undefined,
  kind: 'message' | 'speaker',
): string {
  if (typeof value !== 'string' || !new RegExp(`^${kind}_[1-9]\\d*$`).test(value)) {
    throw new Error(`Pi context ${kind} ref is invalid`);
  }
  return value;
}

function resolveCurrentSpeakerRef(pack: ContextPack): string {
  const currentMessageRef = validatePromptRef(pack.currentMessageRef, 'message');
  const currentMessage = pack.recentMessages.find((message) => (
    message.messageRef === currentMessageRef && message.isCurrent === true
  ));
  if (!currentMessage) {
    throw new Error('Pi target user ref requires the explicit current message');
  }
  return validatePromptRef(currentMessage.speakerRef, 'speaker');
}

function formatIdentityPromptLine(field: NonNullable<ContextPack['injectedIdentityData']>[number]): string {
  return `- ${field.name}=${formatPromptDataLiteral(field.value)}`;
}

function sanitizePromptDataText(value: string): string {
  return redactPromptDataText(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/</g, '‹')
    .replace(/>/g, '›');
}

function redactPromptDataText(value: string): string {
  const platformRedacted = redactPlatformIdentifiers(value);
  const secretRedacted = redactSecretsInText(platformRedacted).text;
  const redacted = redactPlatformIdentifiers(secretRedacted);
  const platformMarkerLost =
    platformRedacted.includes('[REDACTED:platform_id]')
    && !redacted.includes('[REDACTED:platform_id]');

  return platformMarkerLost ? `${redacted} [REDACTED:platform_id]` : redacted;
}

function redactPlatformIdentifiers(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])qq-(?:group-)?\d{5,12}(?![A-Za-z0-9])/gi, '[REDACTED:platform_id]')
    .replace(/(?<![A-Za-z0-9])\d{8,12}(?![A-Za-z0-9])/g, '[REDACTED:platform_id]');
}

function shouldRedactNumericPlatformId(path: string[], value: number): boolean {
  return Number.isInteger(value)
    && isPlatformIdField(path)
    && /^\d{8,12}$/.test(String(Math.abs(value)));
}

function isPlatformIdField(path: string[]): boolean {
  const key = path.at(-1);
  if (!key) {
    return false;
  }

  return /(^|_)(?:target|subject|recipient|actor|owner)?[_-]?(user|sender|group|message|conversation|platform|qq)[_-]?ids?$/i.test(key)
    || /^(?:target|subject|recipient|actor|owner)?(?:User|Sender|Group|Message|Conversation|Platform|Qq)Ids?$/i.test(key)
    || /^(userId|senderId|groupId|messageId|conversationId|platformUserId|platformMessageId)$/i.test(key);
}

function containsRedactionMarker(value: string): boolean {
  return /\[REDACTED:[^\]]+\]/.test(value);
}
