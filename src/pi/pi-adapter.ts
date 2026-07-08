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
import { createDeepSeekModel } from './deepseek-provider.js';
import type { ContextPack, RecentMessage } from '../types/context.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PolicyGate } from '../policy/gate.js';
import type { ActorClass, InvocationContext, ToolHandler } from '../types/tool.js';
import type { AuditEntry } from '../types/audit.js';
import type { ToolCallRecordInput } from '../storage/tool-call-repository.js';
import { redactSecretsInText } from '../memory/secret-scan.js';

type ToolResultContent = AfterToolCallContext['result']['content'];

type AuditLevel = AuditEntry['level'];

interface ToolAuditWriter {
  create(entry: Omit<AuditEntry, 'id'>): Promise<string>;
}

interface ToolCallWriter {
  create(entry: ToolCallRecordInput): Promise<string>;
}

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
  };
  invocationContext: InvocationContext;
  turnId: string;
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
  private executedToolCallIds: string[] = [];
  private currentActor?: { canonicalUserId?: string; actorClass: ActorClass };
  private currentInvocationContext?: InvocationContext;
  private auditRepository?: ToolAuditWriter;
  private toolCallRepository?: ToolCallWriter;

  constructor(options: {
    toolRegistry: ToolRegistry;
    policyGate: PolicyGate;
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    auditRepository?: ToolAuditWriter;
    toolCallRepository?: ToolCallWriter;
  }) {
    this.toolRegistry = options.toolRegistry;
    this.policyGate = options.policyGate;
    this.auditRepository = options.auditRepository;
    this.toolCallRepository = options.toolCallRepository;

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
    this.currentTurnId = input.turnId;
    this.events = [];
    this.executedToolCallIds = [];
    this.setCurrentContext(input);

    try {
      // Update system prompt and tools
      this.agent.state.systemPrompt = input.systemPrompt;
      this.agent.state.tools = this.convertTools(input);

      // Convert ContextPack to AgentMessage[]
      const messages = this.contextPackToMessages(input.contextPack);

      // Run Pi agent
      await this.agent.prompt(messages);

      // Wait for completion
      await this.agent.waitForIdle();

      // Extract result
      return this.extractOutput(input.turnId);
    } catch (error) {
      console.error('[PiAdapter] runTurn failed:', formatRuntimeFailureDiagnostic(error));

      return {
        turnId: input.turnId,
        toolCallIds: this.executedToolCallIds,
        events: this.events,
        tokensUsed: { input: 0, output: 0, total: 0 },
        status: 'failed',
        errorMessage: extractRuntimeFailureMessage(error),
      };
    }
  }

  /**
   * Stream a turn (returns async iterator)
   */
  async *streamTurn(input: PiAdapterInput): AsyncGenerator<PiAdapterEvent> {
    this.currentTurnId = input.turnId;
    this.events = [];
    this.executedToolCallIds = [];
    this.setCurrentContext(input);

    // Update system prompt and tools
    this.agent.state.systemPrompt = input.systemPrompt;
    this.agent.state.tools = this.convertTools(input);

    // Convert ContextPack to AgentMessage[]
    const messages = this.contextPackToMessages(input.contextPack);

    // Start agent turn (non-blocking)
    const runPromise = this.agent.prompt(messages);

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
        contextLines.push(formatIdentityPromptLine(field));
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

    // Get all registered tools
    const registryTools = this.toolRegistry.getAll();

    registryTools.forEach((entry) => {
      // Check if tool is allowed for this actor/context
      const allowed = this.toolRegistry.checkPermission(
        entry.name,
        {
          canonicalUserId: input.actor.canonicalUserId,
          actorClass: input.actor.actorClass,
        },
        input.invocationContext
      );

      if (!allowed) {
        // Skip tools this actor can't use
        return;
      }

      // Convert to Pi AgentTool
      const piTool: AgentTool = {
        name: entry.name,
        description: entry.description,
        label: entry.name, // Or derive from name
        parameters: entry.piSchema.input as AgentTool['parameters'], // TypeBox TSchema

        execute: async (toolCallId, params, _signal, _onUpdate) => {
          const startedAt = Date.now();
          const policyResult = this.policyGate.checkToolCall({
            toolName: entry.name,
            actor: {
              canonicalUserId: input.actor.canonicalUserId,
              actorClass: input.actor.actorClass,
            },
            context: input.invocationContext,
          });

          if (!policyResult.allowed || policyResult.requiresEvaluator) {
            const reason = policyResult.allowed && policyResult.requiresEvaluator
              ? 'Tool requires evaluator review'
              : policyResult.reason || 'Policy gate denied execution';

            await this.auditToolCall({
              entry,
              toolCallId,
              turnId: input.turnId,
              params,
              status: 'rejected',
              actor: input.actor,
              invocationContext: input.invocationContext,
              summary: `${entry.name} rejected: ${reason}`,
              errorMessage: reason,
              errorCode: policyResult.allowed ? 'EVALUATOR_REQUIRED' : 'POLICY_DENIED',
              executionTimeMs: Date.now() - startedAt,
              redactionApplied: false,
            });

            throw new Error(reason);
          }

          // Execute tool handler
          const handler = this.toolRegistry.getHandler(entry.name);
          if (!isToolHandler(handler)) {
            const reason = `No resolved function handler for tool: ${entry.name}`;
            await this.auditToolCall({
              entry,
              toolCallId,
              turnId: input.turnId,
              params,
              status: 'error',
              actor: input.actor,
              invocationContext: input.invocationContext,
              summary: `${entry.name} failed: missing handler`,
              errorMessage: reason,
              errorCode: 'HANDLER_NOT_FOUND',
              executionTimeMs: Date.now() - startedAt,
              redactionApplied: false,
            });
            throw new Error(reason);
          }

          try {
            // Call handler with LetheBot-specific context
            const result = await handler({
              toolCallId,
              turnId: input.turnId,
              toolName: entry.name,
              input: params,
              actor: input.actor,
              context: input.invocationContext,
            });

            // Track executed tool
            this.executedToolCallIds.push(toolCallId);

            const formatted = this.formatToolResult(result);
            const redacted = redactSecretsInText(formatted);
            const redactedDetails = this.redactStructuredValue(result);
            const redactionApplied = redacted.findings.length > 0 || redactedDetails.redacted;

            await this.auditToolCall({
              entry,
              toolCallId,
              turnId: input.turnId,
              params,
              status: 'success',
              actor: input.actor,
              invocationContext: input.invocationContext,
              summary: `${entry.name} executed${redactionApplied ? ' (redacted)' : ''}`,
              output: redactedDetails.value,
              executionTimeMs: Date.now() - startedAt,
              redactionApplied,
            });

            // Convert to Pi AgentToolResult
            return {
              content: [
                {
                  type: 'text',
                  text: redacted.text,
                },
              ],
              details: redactedDetails.value,
              terminate: false,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const redactedMessage = redactSecretsInText(message);
            await this.auditToolCall({
              entry,
              toolCallId,
              turnId: input.turnId,
              params,
              status: 'error',
              actor: input.actor,
              invocationContext: input.invocationContext,
              summary: `${entry.name} failed: ${redactedMessage.text}`,
              errorMessage: redactedMessage.text,
              errorCode: 'TOOL_HANDLER_ERROR',
              executionTimeMs: Date.now() - startedAt,
              redactionApplied: redactedMessage.findings.length > 0,
            });
            throw new Error(redactedMessage.text);
          }
        },
      };

      tools.push(piTool);
    });

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
      errorMessage = agent.state.errorMessage;
    }

    return {
      turnId,
      responseText,
      toolCallIds: this.executedToolCallIds,
      events: this.events,
      tokensUsed,
      status,
      errorMessage,
    };
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
    const toolName = context.toolCall.name;

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
      }

      // Block tool execution
      return {
        block: true,
        reason,
      };
    }

    if (policyResult.requiresEvaluator) {
      const reason = 'Tool requires evaluator review (not yet implemented in adapter)';
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
          errorCode: 'EVALUATOR_REQUIRED',
          redactionApplied: false,
        });
      }

      // Tool requires evaluator review
      // In P0, we might block and defer to orchestrator
      // Or we could allow with flag for later evaluation

      // For MVP: block tools that require evaluator
      // Let orchestrator handle evaluator flow separately
      return {
        block: true,
        reason,
      };
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
    const toolName = context.toolCall.name;
    const tool = this.toolRegistry.get(toolName);

    if (!tool) {
      return undefined;
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

  private redactStructuredValue(value: unknown): { value: unknown; redacted: boolean } {
    if (typeof value === 'string') {
      const redacted = redactSecretsInText(value);
      return {
        value: redacted.text,
        redacted: redacted.findings.length > 0,
      };
    }

    if (Array.isArray(value)) {
      let redacted = false;
      const items = value.map((item) => {
        const result = this.redactStructuredValue(item);
        redacted = redacted || result.redacted;
        return result.value;
      });
      return { value: items, redacted };
    }

    if (isRecord(value)) {
      let redacted = false;
      const result: Record<string, unknown> = {};

      for (const [key, child] of Object.entries(value)) {
        const childResult = this.redactStructuredValue(child);
        redacted = redacted || childResult.redacted;
        result[key] = childResult.value;
      }

      return { value: result, redacted };
    }

    return { value, redacted: false };
  }

  private async auditToolCall(input: {
    entry: ReturnType<ToolRegistry['getAll']>[number];
    toolCallId: string;
    turnId?: string;
    params: unknown;
    status: 'success' | 'error' | 'rejected';
    actor: { canonicalUserId?: string; actorClass: ActorClass };
    invocationContext: InvocationContext;
    requestedBy?: ToolCallRecordInput['requestedBy'];
    summary: string;
    output?: unknown;
    errorMessage?: string;
    errorCode?: string;
    executionTimeMs?: number;
    redactionApplied: boolean;
  }): Promise<void> {
    const params = this.redactStructuredValue(input.params);
    const redactionApplied = input.redactionApplied || params.redacted;
    const level = this.auditLevelForExecution(input.entry.auditLevel, redactionApplied);
    const details = level === 'summary'
      ? {
          toolName: input.entry.name,
          status: input.status,
          capabilities: input.entry.capabilities,
          redactionApplied,
          errorMessage: input.errorMessage,
        }
      : {
          toolName: input.entry.name,
          status: input.status,
          capabilities: input.entry.capabilities,
          input: params.value,
          output: input.output,
          errorMessage: input.errorMessage,
          redactionApplied,
        };

    const turnId = input.turnId ?? this.currentTurnId;
    if (this.toolCallRepository && turnId) {
      await this.toolCallRepository.create({
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
        executionTimeMs: input.executionTimeMs,
        secretsRedacted: redactionApplied,
      });
    }

    if (this.auditRepository) {
      await this.auditRepository.create({
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
      });
    }
  }

  private defaultToolErrorCode(status: 'success' | 'error' | 'rejected'): string | undefined {
    if (status === 'success') {
      return undefined;
    }

    return status === 'rejected' ? 'TOOL_REJECTED' : 'TOOL_ERROR';
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

  private toolAuditEventType(status: 'success' | 'error' | 'rejected'): string {
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
    this.currentActor = input.actor;
    this.currentInvocationContext = input.invocationContext;
  }
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

  const parts = [`- display_name=${formatPromptDataLiteral(participant.displayName)}`];
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
