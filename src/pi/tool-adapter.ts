/**
 * Tool Adapter - Converts LetheBot ToolRegistryEntry to Pi AgentTool
 *
 * Responsibilities:
 * - Map ToolRegistryEntry metadata to Pi AgentTool interface
 * - Convert JSON schemas (piSchema.input/output) to TypeBox TSchema
 * - Wrap tool handlers for Pi execution context
 * - Preserve LetheBot audit, permission, and capability metadata
 */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type {
  ToolRegistryEntry,
  ToolHandler,
  ActorClass,
  InvocationContext,
} from '../types/tool';

type LetheBotToolMetadata = Pick<
  ToolRegistryEntry,
  | 'version'
  | 'capabilities'
  | 'evaluatorPolicy'
  | 'auditLevel'
  | 'outputSensitivity'
  | 'sandboxPolicy'
  | 'permissions'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Convert LetheBot ToolRegistryEntry to Pi AgentTool format
 *
 * Pi AgentTool structure:
 * {
 *   name: string;              // Tool identifier
 *   description: string;       // Human-readable description
 *   label: string;            // Display name (optional, defaults to name)
 *   parameters: TSchema;      // TypeBox schema for input validation
 *   execute: async (
 *     toolCallId: string,
 *     params: any,
 *     signal?: AbortSignal,
 *     onUpdate?: (update: any) => void
 *   ) => AgentToolResult
 * }
 *
 * AgentToolResult structure:
 * {
 *   content: ContentBlock[];  // Text/image blocks for LLM
 *   details?: any;           // Structured data (not sent to LLM by default)
 *   terminate?: boolean;     // Stop turn after this tool
 * }
 *
 * @param entry - LetheBot tool registry entry
 * @param handler - Tool execution handler (takes LetheBot context, returns result)
 * @param context - Runtime context for this conversion (actor, invocationContext, turnId)
 * @returns Pi AgentTool ready for registration
 */
export function convertToolToPiFormat(
  entry: ToolRegistryEntry,
  handler: ToolHandler,
  context: ToolAdapterContext
): AgentTool {
  return {
    name: entry.name,
    description: entry.description,
    label: formatToolLabel(entry.name),
    parameters: convertJsonSchemaToTypeBox(entry.piSchema.input),

    execute: async (toolCallId: string, params: unknown, _signal, _onUpdate) => {
      // Execute tool with LetheBot-specific context
      const result = await handler({
        toolCallId,
        turnId: context.turnId,
        toolName: entry.name,
        input: params,
        actor: context.actor,
        context: context.invocationContext,
      });

      // Convert result to Pi AgentToolResult
      return formatToolResultForPi(result, entry);
    },
  };
}

/**
 * Convert multiple tools in batch
 *
 * @param entries - Array of tool registry entries
 * @param getHandler - Function to retrieve handler for each tool
 * @param context - Shared runtime context
 * @returns Array of Pi AgentTool instances
 */
export function convertToolsToPiFormat(
  entries: ToolRegistryEntry[],
  getHandler: (toolName: string) => ToolHandler | undefined,
  context: ToolAdapterContext
): AgentTool[] {
  const piTools: AgentTool[] = [];

  for (const entry of entries) {
    const handler = getHandler(entry.name);
    if (!handler) {
      console.warn(`[tool-adapter] No handler found for tool: ${entry.name}`);
      continue;
    }

    try {
      const piTool = convertToolToPiFormat(entry, handler, context);
      piTools.push(piTool);
    } catch (error) {
      console.error(
        `[tool-adapter] Failed to convert tool ${entry.name}:`,
        error
      );
      // Skip this tool but continue with others
    }
  }

  return piTools;
}

/**
 * Runtime context for tool conversion
 */
export interface ToolAdapterContext {
  turnId: string;
  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
  };
  invocationContext: InvocationContext;
}

/**
 * Convert JSON Schema to TypeBox TSchema
 *
 * Strategy:
 * - Pi uses TypeBox for runtime validation
 * - LetheBot stores JSON Schema in piSchema.input/output
 * - This function bridges the two formats
 *
 * For P0 MVP: Pass through as-is since TypeBox accepts JSON Schema-like objects
 * For production: Use proper TypeBox.Type.* constructors
 *
 * @param jsonSchema - JSON Schema object from ToolRegistryEntry.piSchema.input
 * @returns TypeBox TSchema (or compatible object)
 */
function convertJsonSchemaToTypeBox(jsonSchema: object): AgentTool['parameters'] {
  // P0 MVP: Direct passthrough
  // Pi's TypeBox validation will handle JSON Schema-like objects
  // This works because TypeBox schemas are structurally similar to JSON Schema

  // Production enhancement would be:
  // - Parse JSON Schema properties
  // - Build equivalent TypeBox.Type.Object({ ... }) structure
  // - Handle nested schemas recursively
  // - Map JSON Schema types to TypeBox types

  return jsonSchema as AgentTool['parameters'];
}

/**
 * Format tool result for Pi consumption
 *
 * Strategy:
 * - Pi expects AgentToolResult with content blocks
 * - LetheBot tools return various formats (string, object, structured result)
 * - Extract natural language summary for LLM
 * - Preserve structured details for audit/debugging
 *
 * @param result - Raw tool handler result
 * @param entry - Original tool registry entry (for metadata)
 * @returns Pi AgentToolResult
 */
function formatToolResultForPi(
  result: unknown,
  _entry: ToolRegistryEntry
): AgentToolResult {
  // Extract text content for LLM
  let textContent: string;

  if (typeof result === 'string') {
    textContent = result;
  } else if (isRecord(result)) {
    // Try common result fields
    const summary = result.summary;
    const message = result.message;
    const output = result.output;
    const text = result.text;
    if (typeof summary === 'string') {
      textContent = summary;
    } else if (typeof message === 'string') {
      textContent = message;
    } else if (typeof output === 'string') {
      textContent = output;
    } else if (typeof text === 'string') {
      textContent = text;
    } else if (output !== undefined) {
      textContent = JSON.stringify(output, null, 2);
    } else {
      textContent = JSON.stringify(result, null, 2);
    }
  } else {
    textContent = String(result);
  }

  // Build content blocks (cast to satisfy Pi's type)
  const content = [
    {
      type: 'text' as const,
      text: textContent,
    },
  ];

  // Check if tool requests termination
  const shouldTerminate = isRecord(result) && result.terminate === true;

  return {
    content,
    details: result, // Preserve full result for audit
    terminate: shouldTerminate,
  };
}

/**
 * Format tool name as display label
 *
 * Examples:
 * - "memory.search" -> "Memory Search"
 * - "qq.send_message" -> "QQ Send Message"
 * - "sandbox.run" -> "Sandbox Run"
 *
 * @param toolName - Dot-separated tool identifier
 * @returns Human-readable label
 */
function formatToolLabel(toolName: string): string {
  return toolName
    .split('.')
    .map((part) =>
      part
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    )
    .join(' ');
}

/**
 * Pi AgentToolResult type (for reference)
 */
interface AgentToolResult {
  content: (TextContent | ImageContent)[];
  details: unknown;
  terminate?: boolean;
}

/**
 * Enrich tool with LetheBot metadata for audit/logging
 *
 * This metadata doesn't affect Pi execution but is useful for
 * LetheBot's audit trail, permission checks, and observability.
 *
 * @param piTool - Converted Pi AgentTool
 * @param entry - Original LetheBot tool registry entry
 * @returns Enriched tool with metadata attached
 */
export function enrichToolWithMetadata(
  piTool: AgentTool,
  entry: ToolRegistryEntry
): AgentToolWithMetadata {
  return {
    ...piTool,
    __lethebot: {
      version: entry.version,
      capabilities: entry.capabilities,
      evaluatorPolicy: entry.evaluatorPolicy,
      auditLevel: entry.auditLevel,
      outputSensitivity: entry.outputSensitivity,
      sandboxPolicy: entry.sandboxPolicy,
      permissions: entry.permissions,
    },
  };
}

/**
 * Pi AgentTool enriched with LetheBot metadata
 */
export interface AgentToolWithMetadata extends AgentTool {
  __lethebot: LetheBotToolMetadata;
}

/**
 * Extract LetheBot metadata from enriched tool
 *
 * @param tool - AgentTool (possibly enriched)
 * @returns LetheBot metadata if present, undefined otherwise
 */
export function getToolMetadata(
  tool: AgentTool
): AgentToolWithMetadata['__lethebot'] | undefined {
  return (tool as AgentToolWithMetadata).__lethebot;
}

/**
 * Validate tool conversion compatibility
 *
 * Checks if a ToolRegistryEntry can be safely converted to Pi AgentTool.
 * Returns validation result with any warnings or errors.
 *
 * @param entry - Tool registry entry to validate
 * @returns Validation result
 */
export function validateToolConversion(entry: ToolRegistryEntry): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!entry.name || entry.name.trim() === '') {
    errors.push('Tool name is required');
  }

  if (!entry.description || entry.description.trim() === '') {
    errors.push('Tool description is required');
  }

  if (!entry.piSchema || !entry.piSchema.input) {
    errors.push('Tool piSchema.input is required for Pi integration');
  }

  if (!entry.handler) {
    errors.push('Tool handler is required');
  }

  // Capability warnings
  if (entry.capabilities.includes('shell_exec')) {
    warnings.push(
      'shell_exec capability requires careful sandbox configuration'
    );
  }

  if (entry.capabilities.includes('credential_access')) {
    warnings.push('credential_access tools must never use auditLevel=full');
    if (entry.auditLevel === 'full') {
      errors.push('credential_access tools cannot use auditLevel=full');
    }
  }

  if (entry.outputSensitivity === 'secret_possible') {
    warnings.push(
      'secret_possible outputs require scanning before LLM consumption'
    );
  }

  // Evaluator policy warnings
  if (
    entry.evaluatorPolicy === 'bypass' &&
    (entry.capabilities.includes('write_local') ||
      entry.capabilities.includes('external_side_effect') ||
      entry.capabilities.includes('platform_admin'))
  ) {
    warnings.push(
      'Risky capabilities with evaluatorPolicy=bypass should be reviewed'
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Create a minimal test/mock tool for Pi
 *
 * Useful for testing Pi integration without full tool registry.
 *
 * @param name - Tool name
 * @param description - Tool description
 * @param handler - Simple handler function
 * @returns Pi AgentTool
 */
export function createMockPiTool(
  name: string,
  description: string,
  handler: (params: unknown) => Promise<string> | string
): AgentTool {
  return {
    name,
    description,
    label: formatToolLabel(name),
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },

    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const result = await handler(params);
      return {
        content: [{ type: 'text' as const, text: String(result) }],
        details: result,
      };
    },
  };
}
