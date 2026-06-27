# Contracts

This document defines the TypeScript interfaces and data schemas that form the contracts between LetheBot's modules. These are the "cannot guess" boundaries for implementation.

**Status:** Draft for loop engineering. Exact field names can evolve during Phase B, but the ownership boundaries must stay stable.

## Design Principles

1. **Explicit over implicit:** Every boundary has a typed interface.
2. **Immutable event sourcing:** Raw events and action decisions are append-only.
3. **Separation of concerns:** Gateway doesn't know about memory; Pi doesn't write directly to storage.
4. **Testability:** Every interface can be mocked or faked.

---

## 1. Event Envelopes

### 1.1 Base Internal Event

All internal events extend this:

```typescript
interface InternalEvent {
  id: string;  // ULID
  type: string;  // discriminator
  timestamp: Date;
  source: 'gateway' | 'agent' | 'tool' | 'worker' | 'system';
  platform?: 'qq';
  conversationId?: string;  // opaque conversation identifier
  correlationId?: string;  // ties related events together
}
```

### 1.2 Chat Message Received

```typescript
interface ChatMessageReceived extends InternalEvent {
  type: 'chat.message.received';
  source: 'gateway';
  platform: 'qq';
  
  message: {
    messageId: string;  // platform message ID
    conversationId: string;
    conversationType: 'private' | 'group';
    
    groupId?: string;  // if group
    senderId: string;  // platform user ID
    senderRole?: 'member' | 'admin' | 'owner';
    
    content: {
      text?: string;
      media?: MediaAttachment[];
      quote?: QuotedMessage;
    };
    
    mentions?: string[];  // platform user IDs
    mentionsBot: boolean;
    replyToMessageId?: string;
  };
  
  // Gateway capability report
  gatewayCapabilities: GatewayCapabilities;
}

interface MediaAttachment {
  type: 'image' | 'video' | 'audio' | 'file';
  url?: string;
  localPath?: string;
  mimeType?: string;
  size?: number;
}

interface QuotedMessage {
  messageId: string;
  senderId: string;
  text?: string;
}
```

### 1.3 Gateway Capabilities

```typescript
interface GatewayCapabilities {
  platform: 'qq';
  
  reactions: {
    emojiLike: boolean;  // true emoji reaction support
    faceMessage: boolean;  // fallback to QQ face message
  };
  
  foldedForward: {
    groupForward: boolean;  // group forward node
    privateForward: boolean;  // private forward node
    customNode: boolean;  // custom text node
  };
  
  platformAdmin: {
    kick: boolean;
    mute: boolean;
    setGroupCard: boolean;
  };
}
```

---

## 2. Identity & Display

### 2.1 Platform Account Mapping

```typescript
interface PlatformAccountMapping {
  platform: 'qq';
  platformAccountId: string;  // raw QQ user ID
  canonicalUserId: string;  // internal UUID/ULID
  
  accountType: 'private' | 'group_member' | 'temp_session';
  verifiedLevel: 'observed' | 'self_claimed' | 'owner_verified';
  status: 'active' | 'disabled' | 'deleted';
  
  firstSeenAt: Date;
  lastSeenAt: Date;
}
```

### 2.2 Display Profile

```typescript
interface DisplayProfile {
  canonicalUserId: string;
  
  // Current display (not history)
  currentDisplayName: string;
  sourceGroupId?: string;  // null = private/global nickname
  observedAt: Date;
  
  // Trust level for display data
  trust: 'platform_provided' | 'user_set' | 'inferred';
}

// Nickname history is separate table, not in main DisplayProfile
interface NicknameHistoryEntry {
  canonicalUserId: string;
  displayName: string;
  sourceGroupId?: string;
  observedAt: Date;
  observedUntil?: Date;
}
```

---

## 3. Context Pack

### 3.1 Context Pack

```typescript
interface ContextPack {
  id: string;  // ULID
  turnId: string;  // ties to agent_runs
  createdAt: Date;
  
  conversation: {
    conversationId: string;
    conversationType: 'private' | 'group';
    groupId?: string;
  };
  
  // Recent messages (token-budgeted)
  recentMessages: RecentMessage[];
  
  // Memory (visibility-filtered)
  memory: {
    userProfile?: MemoryBlock;
    groupProfile?: MemoryBlock;
    retrievedFacts: MemoryBlock[];
    selectedMemoryIds: string[];  // for audit
  };
  
  // Participant context (minimal)
  participants: ParticipantContext[];
  
  // Injected identity fields (for audit)
  injectedIdentityFields: string[];  // e.g., ['current_display_name', 'sender_role']
  
  // Token budget tracking
  tokenBudget: {
    max: number;
    used: number;
    breakdown: {
      recentMessages: number;
      memory: number;
      identity: number;
      system: number;
    };
  };
}

interface RecentMessage {
  messageId: string;
  senderId: string;
  senderDisplayName: string;  // for rendering, not identity
  text?: string;
  timestamp: Date;
  isFromBot: boolean;
}

interface MemoryBlock {
  memoryId: string;
  scope: string;
  title: string;
  content: string;
  confidence: number;
  sourceContext?: string;
}

interface ParticipantContext {
  canonicalUserId: string;
  
  // Display (untrusted user-provided data)
  displayName: string;
  groupCard?: string;
  role?: 'member' | 'admin' | 'owner';
  
  // Flags (for policy)
  isOwner: boolean;
  isAdmin: boolean;
  isTrusted: boolean;
  
  // Platform ID injection (purpose-bound)
  platformAccountId?: string;  // only if needed for identity disambiguation/debug
}
```

---

## 4. Action Decision & Execution

### 4.1 Action Decision

```typescript
interface ActionDecision {
  id: string;  // ULID
  turnId: string;
  createdAt: Date;
  
  decidedBy: 'attention' | 'pi' | 'evaluator';
  
  actions: ActionPlan[];
  riskLevel: 'low' | 'medium' | 'high' | 'prohibited';
  confidence: number;  // 0.0 - 1.0
  
  reasons: string[];  // why these actions
  suppressors: string[];  // what downgraded/blocked actions
  
  // Evaluator metadata (if applicable)
  evaluatorRequired: boolean;
  evaluatorPassed?: boolean;
  evaluatorPromptId?: string;
}

interface ActionPlan {
  type: ActionType;
  priority: number;
  
  target?: ActionTarget;
  payload?: ActionPayload;
  
  constraints: {
    evaluatorRequired?: boolean;
    cooldownKey?: string;
    maxResponseTokens?: number;
    redactionLevel?: 'none' | 'light' | 'strict';
    capabilities?: string[];  // required gateway capabilities
  };
  
  reason: string;
}

type ActionType =
  | 'silent_store'
  | 'silent_summarize_later'
  | 'reply_short'
  | 'reply_full'
  | 'reply_with_tool'
  | 'propose_memory'
  | 'admin_digest'
  | 'schedule_background_task'
  | 'dm_user'
  | 'react_only'
  | 'send_folded_forward'
  | 'ask_clarification';

interface ActionTarget {
  conversationId: string;
  conversationType: 'private' | 'group';
  userId?: string;  // for dm_user
  groupId?: string;
}

interface ActionPayload {
  text?: string;
  toolCall?: ToolCallRequest;
  memoryProposal?: MemoryProposalRequest;
  reaction?: string;
}
```

### 4.2 Action Execution Result

```typescript
interface ActionExecutionResult {
  id: string;  // ULID
  actionDecisionId: string;
  actionType: ActionType;
  executedAt: Date;
  
  status: 'success' | 'downgraded' | 'failed' | 'rejected';
  
  // What actually happened
  executed?: {
    messageId?: string;
    dmMessageId?: string;
    toolCallId?: string;
    memoryId?: string;
    jobId?: string;
  };
  
  // If downgraded
  downgradedFrom?: ActionType;
  downgradedReason?: string;
  
  // If failed
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  
  // Audit
  auditLevel: 'summary' | 'redacted_full' | 'full';
  auditEntry?: string;  // JSON or redacted summary
}
```

---

## 5. Memory Records

### 5.1 Memory Record

```typescript
interface MemoryRecord {
  id: string;  // ULID
  
  // Ownership
  scope: 'global' | 'user' | 'group' | 'conversation' | 'tool' | 'system';
  canonicalUserId?: string;  // if scope=user
  groupId?: string;  // if scope=group
  conversationId?: string;  // if scope=conversation
  subjectUserId?: string;  // who the memory is about (if different from owner)
  
  // Boundaries
  visibility: 'private_only' | 'same_user_any_context' | 'same_group_only' | 'owner_admin_only' | 'public';
  sensitivity: 'normal' | 'personal' | 'sensitive' | 'secret' | 'prohibited';
  authority: 'user_stated' | 'inferred' | 'tool_derived' | 'system';
  
  // Content
  kind: 'preference' | 'fact' | 'constraint' | 'summary' | 'reflection' | 'procedure';
  title: string;
  content: string;
  
  // Lifecycle
  state: 'proposed' | 'active' | 'superseded' | 'disabled' | 'deleted';
  confidence: number;  // 0.0 - 1.0
  importance: number;  // 0.0 - 1.0
  
  // Provenance
  sourceContext: string;  // where it came from
  sourceEventIds: string[];
  evaluatorDecisionId?: string;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}
```

### 5.2 Memory Source Link

```typescript
interface MemorySource {
  memoryId: string;
  sourceType: 'raw_event' | 'chat_message' | 'tool_output' | 'worker_extraction' | 'user_command';
  sourceId: string;
  sourceTimestamp: Date;
  extractedBy?: 'user' | 'evaluator' | 'worker';
}
```

### 5.3 Memory Revision

```typescript
interface MemoryRevision {
  id: string;
  memoryId: string;
  revisionNumber: number;
  
  previousState: Partial<MemoryRecord>;
  newState: Partial<MemoryRecord>;
  
  reason: string;
  changeType: 'create' | 'update' | 'supersede' | 'disable' | 'delete' | 'restore';
  
  actor: string;  // canonical_user_id or 'system'
  evaluatorDecisionId?: string;
  
  createdAt: Date;
}
```

---

## 6. Tool Registry

### 6.1 Tool Registry Entry

```typescript
interface ToolRegistryEntry {
  name: string;  // unique tool identifier
  version: string;
  description: string;
  
  // Capabilities (what it can do)
  capabilities: ToolCapability[];
  
  // Permissions (who can use it)
  permissions: ToolPermissionPolicy;
  
  // Evaluator policy (LLM review required?)
  evaluatorPolicy: 'required' | 'bypass';
  
  // Audit (what to log)
  auditLevel: 'none' | 'summary' | 'redacted_full' | 'full';
  
  // Sandbox (execution constraints)
  sandboxPolicy: SandboxPolicy;
  
  // Output handling
  outputSensitivity: 'normal' | 'personal' | 'sensitive' | 'secret_possible';
  
  // Pi integration
  piSchema: {
    input: object;  // JSON schema
    output: object;  // JSON schema
  };
  
  // Handler
  handler: string;  // module path or function reference
}

type ToolCapability =
  | 'read_context'
  | 'read_local'
  | 'write_local'
  | 'network'
  | 'shell_exec'
  | 'long_running'
  | 'sends_message'
  | 'modifies_memory'
  | 'external_side_effect'
  | 'credential_access'
  | 'platform_admin';

interface ToolPermissionPolicy {
  allowedActors: ActorClass[];
  allowedContexts: InvocationContext[];
  allowedUserIds?: string[];
  deniedUserIds?: string[];
  allowedGroupIds?: string[];
  deniedGroupIds?: string[];
}

type ActorClass =
  | 'owner'
  | 'admin'
  | 'trusted_user'
  | 'user'
  | 'group_admin'
  | 'system_worker'
  | 'evaluator'
  | 'tool';

type InvocationContext =
  | 'private_chat'
  | 'group_chat'
  | 'admin_cli'
  | 'background_worker'
  | 'internal';

interface SandboxPolicy {
  filesystem: 'none' | 'readonly' | 'workspace_write' | 'allowed_paths';
  network: 'none' | 'restricted' | 'allowed';
  execution: 'none' | 'in_process' | 'subprocess' | 'docker';
  maxRuntimeMs?: number;
  maxOutputBytes?: number;
  allowedPaths?: string[];
  allowedDomains?: string[];
}
```

### 6.2 Tool Call

```typescript
interface ToolCallRequest {
  id: string;  // ULID
  turnId: string;
  toolName: string;
  
  input: object;  // validated against tool's piSchema.input
  
  requestedBy: 'pi' | 'evaluator' | 'user' | 'system';
  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
  };
  
  context: InvocationContext;
}

interface ToolCallResult {
  toolCallId: string;
  status: 'success' | 'error' | 'timeout' | 'rejected';
  
  output?: object;  // validated against tool's piSchema.output
  error?: {
    code: string;
    message: string;
    details?: object;
  };
  
  executionTimeMs: number;
  
  // Audit
  auditSummary: string;  // redacted if sensitive
  secretsRedacted: boolean;
}
```

---

## 7. Agent Turn

### 7.1 Agent Turn

```typescript
interface AgentTurn {
  id: string;  // ULID, also serves as turnId
  conversationId: string;
  
  // Input
  triggerEvent: InternalEvent;
  contextPackId: string;
  
  // Pi interaction
  piPromptId?: string;
  piModel: string;
  piProvider: string;
  
  // Output
  actionDecisionId?: string;
  responseText?: string;
  toolCalls: string[];  // ToolCallRequest IDs
  
  // Lifecycle
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: Date;
  completedAt?: Date;
  
  // Token usage
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
}
```

---

## 8. Audit & Errors

### 8.1 Audit Entry

```typescript
interface AuditEntry {
  id: string;  // ULID
  timestamp: Date;
  
  category: 'tool' | 'memory' | 'social' | 'evaluator' | 'system';
  level: 'summary' | 'redacted_full' | 'full';
  
  // What happened
  eventType: string;
  eventId: string;  // references the actual event
  
  actor: {
    canonicalUserId?: string;
    actorClass: ActorClass;
    context: InvocationContext;
  };
  
  // Summary (always present)
  summary: string;
  
  // Details (redacted if level != full)
  details?: object;
  redacted: boolean;
  
  // Risk flags
  riskLevel?: 'low' | 'medium' | 'high';
  evaluatorDecisionId?: string;
}
```

### 8.2 Error Envelope

```typescript
interface ErrorEnvelope {
  code: string;  // e.g., 'MEMORY_NOT_FOUND', 'PERMISSION_DENIED'
  message: string;
  category: 'validation' | 'permission' | 'not_found' | 'conflict' | 'rate_limit' | 'internal';
  
  details?: object;
  recoverable: boolean;
  
  // For debugging (never exposed to untrusted context)
  stack?: string;
  internalError?: Error;
}
```

---

## 9. Attention Signals (Fast Classification)

The Attention Engine does NOT build full ActionDecision. It only does fast classification and extracts basic signals.

```typescript
interface AttentionSignals {
  classification: 'silent' | 'needs_response' | 'needs_evaluation';
  
  // Basic trigger signals
  triggerScore: number;  // 0.0 - 1.0
  triggerReasons: string[];  // e.g., ['@bot', 'reply_to_bot']
  
  // Basic suppressors
  suppressors: string[];  // e.g., ['high_speed_chat', 'bot_spoke_recently']
  
  // Recommended path
  recommendedPath: 'silent_fast_path' | 'reply_fast_path' | 'risk_path';
}
```

**Design rationale:** This keeps silent_fast_path truly fast. ActionDecision is only constructed by Pi or Evaluator when actually needed.

---

## 10. Design Decisions Record

### Decision: Attention Output (Q1)

**Chosen:** Option A - Attention Engine only does fast classification.

**Rationale:** Keeps silent_fast_path truly fast. Most group messages should not build ActionDecision at all.

### Decision: Memory Proposal (Q2)

**Chosen:** Option A - Use `state` field in MemoryRecord.

**Rationale:** Simpler for P0. Single table, single type. Separate MemoryProposal type adds complexity without clear P0 benefit.

### Decision: Gateway Capabilities Timing (Q3)

**Chosen:** Option A - Report capabilities with every message.

**Rationale:** Safety over efficiency. Capabilities can change at runtime (e.g., NapCat updates). Per-message overhead is acceptable for correct behavior.

### Decision: Identity in Context Pack (Q4)

**Chosen:** Current granularity is appropriate.

**Rationale:** ParticipantContext includes exactly what's needed for policy decisions (role, trust flags) and prompt rendering (displayName), plus optional platformAccountId when debugging/disambiguation is needed. Not too much, not too little.

---

## 11. Implementation Guidance

For detailed phase-by-phase tasks with exact file paths, code snippets, tests, and acceptance criteria, see:

- **`docs/detailed-phase-tasks.md`** - Phase 2 (Pi Runtime) and Phase 3 (Memory v0) fully expanded
- **`docs/test-strategy.md`** - P0 regression tests and phase acceptance criteria
- **`docs/fake-gateway-design.md`** - Test harness interface and test scenarios
- **`docs/sqlite-schema.md`** - Complete database schema with indexes

These documents provide the concrete implementation details for the interfaces defined in this contracts document.
