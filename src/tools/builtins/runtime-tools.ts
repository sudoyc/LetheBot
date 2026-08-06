import { Buffer } from 'node:buffer';
import type {
  ToolCapability,
  ToolHandlerRequest,
  ToolRegistryEntry,
} from '../../types/tool.js';
import { redactFileOperationText } from '../file-operations/redaction.js';
import type { ToolRegistry } from '../registry.js';

const MAX_CATALOG_ENTRIES = 32;
const MAX_DISPLAY_NAME_LENGTH = 128;
const MAX_OUTPUT_BYTES = 8192;
const MAX_WEB_FETCH_ORIGINS = 16;
const KNOWN_CAPABILITIES = new Set<ToolCapability>([
  'read_context',
  'read_local',
  'write_local',
  'network',
  'shell_exec',
  'long_running',
  'sends_message',
  'modifies_memory',
  'external_side_effect',
  'credential_access',
  'platform_admin',
]);

type OptionalRegistrationStatus = 'enabled' | 'disabled' | 'inconsistent';

export interface RuntimeToolsCatalogItem {
  name: string;
  capabilities: ToolCapability[];
  enabled: boolean;
  availableHere: boolean;
  evaluatorRequired: boolean;
}

export interface RuntimeToolsOutput {
  registeredCount: number;
  availableHereCount: number;
  listedCount: number;
  tools: RuntimeToolsCatalogItem[];
  optionalConfiguration: {
    workspace: OptionalRegistrationStatus;
    webFetch: OptionalRegistrationStatus;
    webFetchAllowedOriginCount: number | null;
  };
  truncated: boolean;
  redactionApplied: boolean;
}

export interface RuntimeToolsDependencies {
  registry: ToolRegistry;
}

interface ProjectedCatalogItem {
  item: RuntimeToolsCatalogItem;
  redacted: boolean;
}

class RuntimeToolsError extends Error {}

export function createRuntimeToolsTool(
  dependencies: RuntimeToolsDependencies,
): ToolRegistryEntry {
  return {
    name: 'runtime.tools',
    version: '1.0.0',
    description: 'Inspect the bounded registered tool catalog and coarse optional-tool state.',
    capabilities: ['read_local'],
    permissions: {
      allowedActors: ['owner', 'admin'],
      allowedContexts: ['private_chat'],
    },
    evaluatorPolicy: 'bypass',
    auditLevel: 'redacted_full',
    sandboxPolicy: {
      filesystem: 'none',
      network: 'none',
      execution: 'in_process',
      maxRuntimeMs: 1000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    },
    outputSensitivity: 'secret_possible',
    piSchema: {
      input: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          registeredCount: { type: 'number' },
          availableHereCount: { type: 'number' },
          listedCount: { type: 'number' },
          tools: {
            type: 'array',
            maxItems: MAX_CATALOG_ENTRIES,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', maxLength: MAX_DISPLAY_NAME_LENGTH },
                capabilities: {
                  type: 'array',
                  maxItems: KNOWN_CAPABILITIES.size,
                  items: { type: 'string' },
                },
                enabled: { type: 'boolean' },
                availableHere: { type: 'boolean' },
                evaluatorRequired: { type: 'boolean' },
              },
              required: ['name', 'capabilities', 'enabled', 'availableHere', 'evaluatorRequired'],
              additionalProperties: false,
            },
          },
          optionalConfiguration: {
            type: 'object',
            properties: {
              workspace: {
                type: 'string',
                enum: ['enabled', 'disabled', 'inconsistent'],
              },
              webFetch: {
                type: 'string',
                enum: ['enabled', 'disabled', 'inconsistent'],
              },
              webFetchAllowedOriginCount: { type: ['number', 'null'] },
            },
            required: ['workspace', 'webFetch', 'webFetchAllowedOriginCount'],
            additionalProperties: false,
          },
          truncated: { type: 'boolean' },
          redactionApplied: { type: 'boolean' },
        },
        required: [
          'registeredCount',
          'availableHereCount',
          'listedCount',
          'tools',
          'optionalConfiguration',
          'truncated',
          'redactionApplied',
        ],
        additionalProperties: false,
      },
    },
    handler: createRuntimeToolsHandler(dependencies),
  };
}

function createRuntimeToolsHandler(
  dependencies: RuntimeToolsDependencies,
): ToolRegistryEntry['handler'] {
  return async (request: ToolHandlerRequest): Promise<RuntimeToolsOutput> => {
    assertEmptyInput(request.input);
    throwIfAborted(request.signal);

    try {
      const entries = dependencies.registry.list();
      throwIfAborted(request.signal);
      const sorted = [...entries].sort(compareToolNames);
      const projected = sorted.map((entry) => projectCatalogItem(
        entry,
        dependencies.registry.checkPermission(entry.name, request.actor, request.context),
        dependencies.registry.isEnabled(entry.name),
      ));
      const availableHereCount = projected.reduce(
        (count, entry) => count + (entry.item.availableHere ? 1 : 0),
        0,
      );
      const optionalConfiguration = inspectOptionalConfiguration(sorted, dependencies.registry);
      let selected = projected.slice(0, MAX_CATALOG_ENTRIES);
      let truncated = selected.length < projected.length;

      while (true) {
        const output: RuntimeToolsOutput = {
          registeredCount: projected.length,
          availableHereCount,
          listedCount: selected.length,
          tools: selected.map((entry) => entry.item),
          optionalConfiguration,
          truncated,
          redactionApplied: selected.some((entry) => entry.redacted),
        };
        if (Buffer.byteLength(JSON.stringify(output)) <= MAX_OUTPUT_BYTES) {
          throwIfAborted(request.signal);
          return output;
        }
        if (selected.length === 0) {
          throw new RuntimeToolsError('runtime.tools is unavailable');
        }
        selected = selected.slice(0, -1);
        truncated = true;
      }
    } catch (error) {
      if (error instanceof RuntimeToolsError) {
        throw error;
      }
      if (request.signal.aborted) {
        throw new RuntimeToolsError('runtime.tools aborted');
      }
      throw new RuntimeToolsError('runtime.tools is unavailable');
    }
  };
}

function projectCatalogItem(
  entry: ToolRegistryEntry,
  availableHere: boolean,
  enabled: boolean,
): ProjectedCatalogItem {
  if (typeof entry.name !== 'string') {
    throw new RuntimeToolsError('runtime.tools is unavailable');
  }
  const redactedName = redactFileOperationText(entry.name);
  const boundedName = redactedName.text.slice(0, MAX_DISPLAY_NAME_LENGTH);
  const capabilities = Array.from(new Set(entry.capabilities))
    .filter((capability): capability is ToolCapability => KNOWN_CAPABILITIES.has(capability))
    .sort();

  return {
    item: {
      name: boundedName,
      capabilities,
      enabled,
      availableHere,
      evaluatorRequired: entry.evaluatorPolicy === 'required',
    },
    redacted: redactedName.redacted || boundedName.length !== redactedName.text.length,
  };
}

function inspectOptionalConfiguration(
  entries: readonly ToolRegistryEntry[],
  registry: ToolRegistry,
): RuntimeToolsOutput['optionalConfiguration'] {
  const names = new Set(entries.map((entry) => entry.name));
  const workspaceListRegistered = names.has('workspace.list');
  const workspaceReadRegistered = names.has('workspace.read_text');
  const workspace = !workspaceListRegistered && !workspaceReadRegistered
    ? 'disabled'
    : !workspaceListRegistered || !workspaceReadRegistered
      ? 'inconsistent'
      : registry.isEnabled('workspace.list') && registry.isEnabled('workspace.read_text')
        ? 'enabled'
        : 'disabled';

  const webFetch = entries.find((entry) => entry.name === 'web.fetch_text');
  if (!webFetch) {
    return {
      workspace,
      webFetch: 'disabled',
      webFetchAllowedOriginCount: 0,
    };
  }
  const origins = webFetch.sandboxPolicy.allowedOrigins;
  if (
    !Array.isArray(origins)
    || origins.length === 0
    || origins.length > MAX_WEB_FETCH_ORIGINS
    || origins.some((origin) => typeof origin !== 'string' || origin.length === 0)
    || new Set(origins).size !== origins.length
  ) {
    return {
      workspace,
      webFetch: 'inconsistent',
      webFetchAllowedOriginCount: null,
    };
  }
  return {
    workspace,
    webFetch: registry.isEnabled('web.fetch_text') ? 'enabled' : 'disabled',
    webFetchAllowedOriginCount: origins.length,
  };
}

function compareToolNames(left: ToolRegistryEntry, right: ToolRegistryEntry): number {
  if (left.name < right.name) {
    return -1;
  }
  if (left.name > right.name) {
    return 1;
  }
  return 0;
}

function assertEmptyInput(input: unknown): void {
  if (
    typeof input !== 'object'
    || input === null
    || Array.isArray(input)
    || Object.keys(input).length !== 0
  ) {
    throw new RuntimeToolsError('runtime.tools input must be an empty object');
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RuntimeToolsError('runtime.tools aborted');
  }
}
