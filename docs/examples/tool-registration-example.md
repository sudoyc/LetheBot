# Tool Registration Example

This guide demonstrates how to register custom tools in LetheBot's ToolRegistry, configure permissions, and validate tool calls through PolicyGate.

## Overview

LetheBot's tool system consists of:

- **ToolRegistry**: Manages tool metadata, permissions, and handlers
- **PolicyGate**: Enforces L0 (Layer 0) permission checks before tool execution
- **ToolRegistryEntry**: Defines tool capabilities, permissions, sandbox policy, and schema

## 1. Registering a Custom Tool

### Example: Weather Tool

```typescript
import { ToolRegistry } from './tools/registry';
import type { ToolRegistryEntry } from './types/tool';

const toolRegistry = new ToolRegistry();

const weatherTool: ToolRegistryEntry = {
  name: 'get_weather',
  version: '1.0.0',
  description: 'Fetches current weather for a given location',

  // Capabilities: what this tool can do
  capabilities: ['network', 'read_context'],

  // Permissions: who can use this tool and where
  permissions: {
    allowedActors: ['owner', 'admin', 'trusted_user', 'user'],
    allowedContexts: ['private_chat', 'group_chat'],

    // Optional: restrict to specific users
    allowedUserIds: undefined,
    deniedUserIds: undefined,

    // Optional: restrict to specific groups
    allowedGroupIds: undefined,
    deniedGroupIds: undefined,
  },

  // Evaluator policy: does this need LLM review?
  evaluatorPolicy: 'bypass', // 'required' or 'bypass'

  // Audit level: how much to log
  auditLevel: 'summary', // 'none' | 'summary' | 'redacted_full' | 'full'

  // Sandbox policy: execution constraints
  sandboxPolicy: {
    filesystem: 'none',
    network: 'restricted',
    execution: 'in_process',
    maxRuntimeMs: 5000,
    maxOutputBytes: 10240,
    allowedDomains: ['api.weather.com', 'weatherapi.com'],
  },

  // Output sensitivity
  outputSensitivity: 'normal',

  // Pi schema: input/output validation
  piSchema: {
    input: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      },
      required: ['location'],
    },
    output: {
      type: 'object',
      properties: {
        temperature: { type: 'number' },
        conditions: { type: 'string' },
        humidity: { type: 'number' },
      },
      required: ['temperature', 'conditions'],
    },
  },

  // Handler: implementation
  handler: './handlers/weather', // module path
};

// Register the tool
toolRegistry.register(weatherTool);
```

## 2. Permission Configuration Examples

### Example 1: Admin-Only Tool

```typescript
const adminTool: ToolRegistryEntry = {
  name: 'manage_users',
  version: '1.0.0',
  description: 'User management operations',
  capabilities: ['platform_admin', 'modifies_memory'],

  permissions: {
    allowedActors: ['owner', 'admin'],
    allowedContexts: ['admin_cli', 'internal'],
  },

  evaluatorPolicy: 'required', // Always review admin actions
  auditLevel: 'full',
  sandboxPolicy: {
    filesystem: 'none',
    network: 'none',
    execution: 'in_process',
  },
  outputSensitivity: 'sensitive',
  piSchema: {
    input: { type: 'object', properties: {} },
    output: { type: 'object', properties: {} },
  },
  handler: './handlers/admin',
};
```

### Example 2: Public Read-Only Tool

```typescript
const publicTool: ToolRegistryEntry = {
  name: 'search_docs',
  version: '1.0.0',
  description: 'Search documentation',
  capabilities: ['read_context'],

  permissions: {
    allowedActors: ['owner', 'admin', 'trusted_user', 'user'],
    allowedContexts: ['private_chat', 'group_chat', 'admin_cli'],
  },

  evaluatorPolicy: 'bypass',
  auditLevel: 'summary',
  sandboxPolicy: {
    filesystem: 'readonly',
    network: 'none',
    execution: 'in_process',
    maxRuntimeMs: 2000,
  },
  outputSensitivity: 'normal',
  piSchema: {
    input: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
    output: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
  },
  handler: './handlers/search',
};
```

### Example 3: User-Specific Tool

```typescript
const personalTool: ToolRegistryEntry = {
  name: 'read_my_calendar',
  version: '1.0.0',
  description: 'Read user calendar',
  capabilities: ['network', 'credential_access'],

  permissions: {
    allowedActors: ['owner', 'user'],
    allowedContexts: ['private_chat'],

    // Only specific users can use this
    allowedUserIds: ['user_01ABC123', 'user_02DEF456'],
  },

  evaluatorPolicy: 'bypass',
  auditLevel: 'redacted_full',
  sandboxPolicy: {
    filesystem: 'none',
    network: 'restricted',
    execution: 'subprocess',
    maxRuntimeMs: 10000,
    allowedDomains: ['calendar.google.com'],
  },
  outputSensitivity: 'personal',
  piSchema: {
    input: {
      type: 'object',
      properties: {
        startDate: { type: 'string', format: 'date' },
        endDate: { type: 'string', format: 'date' },
      },
    },
    output: {
      type: 'object',
      properties: {
        events: { type: 'array' },
      },
    },
  },
  handler: './handlers/calendar',
};
```

## 3. Using ToolRegistry

### Register Multiple Tools

```typescript
const registry = new ToolRegistry();

registry.register(weatherTool);
registry.register(adminTool);
registry.register(publicTool);

// Get a tool
const tool = registry.get('get_weather');
console.log(tool?.description);

// List all tools
const allTools = registry.list();
console.log(`Registered ${allTools.length} tools`);

// Get handler
const handler = registry.getHandler('get_weather');
```

### Check Permissions

```typescript
import type { ActorContext } from './tools/registry';
import type { InvocationContext } from './types/tool';

const actor: ActorContext = {
  actorClass: 'user',
  canonicalUserId: 'user_01ABC123',
};

const context: InvocationContext = 'private_chat';

const allowed = registry.checkPermission('get_weather', actor, context);

if (allowed) {
  console.log('Tool call allowed');
} else {
  console.log('Permission denied');
}
```

### Check Evaluator Requirement

```typescript
const needsEvaluator = registry.requiresEvaluator('manage_users');

if (needsEvaluator) {
  console.log('This tool requires LLM evaluation before execution');
}
```

## 4. PolicyGate Validation

PolicyGate enforces L0 (Layer 0) permission checks that cannot be bypassed by evaluatorPolicy.

### Example: Validating a Tool Call

```typescript
import { PolicyGate } from './policy/gate';
import type { PolicyCheckRequest } from './policy/gate';

const gate = new PolicyGate(toolRegistry);

const request: PolicyCheckRequest = {
  toolName: 'get_weather',
  actor: {
    actorClass: 'user',
    canonicalUserId: 'user_01ABC123',
  },
  context: 'private_chat',
};

const result = gate.checkToolCall(request);

if (result.allowed) {
  console.log('✓ Tool call allowed');

  if (result.requiresEvaluator) {
    console.log('→ Sending to evaluator for review');
  } else {
    console.log('→ Proceeding directly to execution');
  }
} else {
  console.error(`✗ Tool call denied: ${result.reason}`);
}
```

### Example: Handling Different Outcomes

```typescript
function handleToolCall(toolName: string, actor: ActorContext, context: InvocationContext) {
  const gate = new PolicyGate(toolRegistry);

  const result = gate.checkToolCall({ toolName, actor, context });

  if (!result.allowed) {
    // Hard rejection - L0 policy violation
    return {
      status: 'rejected',
      error: {
        code: 'PERMISSION_DENIED',
        message: result.reason,
      },
    };
  }

  if (result.requiresEvaluator) {
    // Send to evaluator LLM for review
    return {
      status: 'pending_evaluation',
      toolName,
      actor,
      context,
    };
  }

  // Execute directly
  return {
    status: 'executing',
    toolName,
  };
}
```

## 5. Testing Example

### Unit Test: Tool Registration

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../src/tools/registry';
import type { ToolRegistryEntry } from '../src/types/tool';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('should register a tool successfully', () => {
    const tool: ToolRegistryEntry = {
      name: 'test_tool',
      version: '1.0.0',
      description: 'Test tool',
      capabilities: ['read_context'],
      permissions: {
        allowedActors: ['user'],
        allowedContexts: ['private_chat'],
      },
      evaluatorPolicy: 'bypass',
      auditLevel: 'none',
      sandboxPolicy: {
        filesystem: 'none',
        network: 'none',
        execution: 'in_process',
      },
      outputSensitivity: 'normal',
      piSchema: {
        input: { type: 'object' },
        output: { type: 'object' },
      },
      handler: './test',
    };

    registry.register(tool);

    const retrieved = registry.get('test_tool');
    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe('test_tool');
  });

  it('should throw on duplicate registration', () => {
    const tool: ToolRegistryEntry = {
      name: 'duplicate',
      version: '1.0.0',
      description: 'Duplicate',
      capabilities: [],
      permissions: {
        allowedActors: ['user'],
        allowedContexts: ['private_chat'],
      },
      evaluatorPolicy: 'bypass',
      auditLevel: 'none',
      sandboxPolicy: {
        filesystem: 'none',
        network: 'none',
        execution: 'in_process',
      },
      outputSensitivity: 'normal',
      piSchema: {
        input: { type: 'object' },
        output: { type: 'object' },
      },
      handler: './test',
    };

    registry.register(tool);

    expect(() => registry.register(tool)).toThrow(
      'Tool "duplicate" is already registered'
    );
  });
});
```

### Unit Test: Permission Checks

```typescript
describe('ToolRegistry - Permissions', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();

    const tool: ToolRegistryEntry = {
      name: 'restricted_tool',
      version: '1.0.0',
      description: 'Admin only',
      capabilities: ['platform_admin'],
      permissions: {
        allowedActors: ['admin', 'owner'],
        allowedContexts: ['admin_cli'],
      },
      evaluatorPolicy: 'required',
      auditLevel: 'full',
      sandboxPolicy: {
        filesystem: 'none',
        network: 'none',
        execution: 'in_process',
      },
      outputSensitivity: 'sensitive',
      piSchema: {
        input: { type: 'object' },
        output: { type: 'object' },
      },
      handler: './admin',
    };

    registry.register(tool);
  });

  it('should allow admin in admin_cli context', () => {
    const allowed = registry.checkPermission(
      'restricted_tool',
      { actorClass: 'admin' },
      'admin_cli'
    );

    expect(allowed).toBe(true);
  });

  it('should deny user in admin_cli context', () => {
    const allowed = registry.checkPermission(
      'restricted_tool',
      { actorClass: 'user' },
      'admin_cli'
    );

    expect(allowed).toBe(false);
  });

  it('should deny admin in private_chat context', () => {
    const allowed = registry.checkPermission(
      'restricted_tool',
      { actorClass: 'admin' },
      'private_chat'
    );

    expect(allowed).toBe(false);
  });
});
```

### Unit Test: PolicyGate

```typescript
import { PolicyGate } from '../src/policy/gate';

describe('PolicyGate', () => {
  let registry: ToolRegistry;
  let gate: PolicyGate;

  beforeEach(() => {
    registry = new ToolRegistry();
    gate = new PolicyGate(registry);

    const publicTool: ToolRegistryEntry = {
      name: 'public_tool',
      version: '1.0.0',
      description: 'Public tool',
      capabilities: ['read_context'],
      permissions: {
        allowedActors: ['user', 'admin'],
        allowedContexts: ['private_chat', 'group_chat'],
      },
      evaluatorPolicy: 'bypass',
      auditLevel: 'summary',
      sandboxPolicy: {
        filesystem: 'none',
        network: 'none',
        execution: 'in_process',
      },
      outputSensitivity: 'normal',
      piSchema: {
        input: { type: 'object' },
        output: { type: 'object' },
      },
      handler: './public',
    };

    registry.register(publicTool);
  });

  it('should allow valid tool call', () => {
    const result = gate.checkToolCall({
      toolName: 'public_tool',
      actor: { actorClass: 'user' },
      context: 'private_chat',
    });

    expect(result.allowed).toBe(true);
    expect(result.requiresEvaluator).toBe(false);
  });

  it('should deny unknown tool', () => {
    const result = gate.checkToolCall({
      toolName: 'nonexistent',
      actor: { actorClass: 'user' },
      context: 'private_chat',
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Unknown tool');
  });

  it('should deny unauthorized actor', () => {
    const result = gate.checkToolCall({
      toolName: 'public_tool',
      actor: { actorClass: 'system_worker' },
      context: 'private_chat',
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Permission denied');
  });

  it('should indicate evaluator requirement', () => {
    const sensitiveData: ToolRegistryEntry = {
      name: 'sensitive_tool',
      version: '1.0.0',
      description: 'Needs review',
      capabilities: ['external_side_effect'],
      permissions: {
        allowedActors: ['user'],
        allowedContexts: ['private_chat'],
      },
      evaluatorPolicy: 'required',
      auditLevel: 'full',
      sandboxPolicy: {
        filesystem: 'none',
        network: 'allowed',
        execution: 'subprocess',
      },
      outputSensitivity: 'sensitive',
      piSchema: {
        input: { type: 'object' },
        output: { type: 'object' },
      },
      handler: './sensitive',
    };

    registry.register(sensitiveData);

    const result = gate.checkToolCall({
      toolName: 'sensitive_tool',
      actor: { actorClass: 'user' },
      context: 'private_chat',
    });

    expect(result.allowed).toBe(true);
    expect(result.requiresEvaluator).toBe(true);
  });
});
```

## Summary

- **ToolRegistry** manages tool metadata and permissions
- **PolicyGate** enforces L0 permission checks before execution
- Tools define capabilities, permissions, sandbox policies, and schemas
- Permission checks validate both actor class and invocation context
- Evaluator policy determines if LLM review is required
- Comprehensive testing ensures security and correctness

---

**Key Files:**
- `/home/ycyc/projects/LetheBot/src/tools/registry.ts`
- `/home/ycyc/projects/LetheBot/src/policy/gate.ts`
- `/home/ycyc/projects/LetheBot/src/types/tool.ts`
