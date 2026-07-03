# Detailed Phase Tasks

This document expands MVP roadmap phases into bite-sized implementation tasks suitable for loop engineering. Each task should take 10-30 minutes of focused implementation.

**Format:** Each task includes exact files, tests, commands, and acceptance criteria.

---

## Phase 2: Pi Runtime

**Goal:** Embed Pi SDK in a TypeScript service, run one agent turn from a private message.

### Task 2.1: Create Pi SDK wrapper interface

**Files:**
- Create: `src/pi/reasoning-core.interface.ts`
- Create: `tests/unit/pi/reasoning-core.interface.test.ts`

**Implementation:**
```typescript
// src/pi/reasoning-core.interface.ts
export interface ReasoningCore {
  run(input: AgentTurnInput): Promise<AgentTurnOutput>;
}

export interface AgentTurnInput {
  contextPack: ContextPack;
  actionHint?: string;
}

export interface AgentTurnOutput {
  responseText?: string;
  actionDecision?: ActionDecision;
  toolCalls: ToolCallRequest[];
  tokensUsed: TokenUsage;
}
```

**Test:**
```typescript
// Mock implementation passes
const mockCore: ReasoningCore = {
  run: async (input) => ({
    responseText: 'mock response',
    toolCalls: [],
    tokensUsed: { input: 100, output: 50, total: 150 }
  })
};

expect(await mockCore.run({ contextPack: testContext })).toHaveProperty('responseText');
```

**Acceptance:**
- Interface compiles
- Mock implementation passes type check
- Test passes

**Commands:**
```bash
pnpm typecheck
pnpm test tests/unit/pi/
```

---

### Task 2.2: Implement Pi SDK adapter

**Files:**
- Create: `src/pi/pi-sdk-adapter.ts`
- Create: `tests/unit/pi/pi-sdk-adapter.test.ts`
- Update: `package.json` (add `@pinetwork/sdk` or equivalent)

**Implementation:**
```typescript
// src/pi/pi-sdk-adapter.ts
import { Pi } from '@pinetwork/sdk';
import { ReasoningCore, AgentTurnInput, AgentTurnOutput } from './reasoning-core.interface';

export class PiSdkAdapter implements ReasoningCore {
  private pi: Pi;
  
  constructor(config: { model: string; provider: string; apiKey?: string }) {
    this.pi = new Pi(config);
  }
  
  async run(input: AgentTurnInput): Promise<AgentTurnOutput> {
    // Build Pi prompt from contextPack
    const prompt = this.buildPrompt(input.contextPack);
    
    // Call Pi SDK
    const result = await this.pi.chat({
      messages: prompt,
      tools: input.contextPack.availableTools || [],
    });
    
    // Parse response
    return {
      responseText: result.text,
      actionDecision: this.parseActionDecision(result),
      toolCalls: result.toolCalls || [],
      tokensUsed: result.usage,
    };
  }
  
  private buildPrompt(contextPack: ContextPack): Message[] {
    // TODO: implement prompt building
    return [{ role: 'user', content: 'placeholder' }];
  }
  
  private parseActionDecision(result: any): ActionDecision | undefined {
    // TODO: implement action decision parsing
    return undefined;
  }
}
```

**Test:**
```typescript
// With mock Pi SDK
test('can call Pi SDK and handle response', async () => {
  const adapter = new PiSdkAdapter({ model: 'test', provider: 'mock' });
  const result = await adapter.run({ contextPack: testContext });
  
  expect(result.responseText).toBeTruthy();
  expect(result.tokensUsed.total).toBeGreaterThan(0);
});
```

**Acceptance:**
- Can instantiate PiSdkAdapter
- Can call `.run()` with test context
- Returns valid AgentTurnOutput
- Test passes (with mock or real Pi SDK depending on env)

**Commands:**
```bash
pnpm install
pnpm typecheck
pnpm test tests/unit/pi/pi-sdk-adapter.test.ts
```

---

### Task 2.3: Wire Pi adapter into request handler

**Files:**
- Create: `src/core/request-handler.ts`
- Update: `src/pi/index.ts` (export adapter)
- Create: `tests/integration/private-message-to-pi.test.ts`

**Implementation:**
```typescript
// src/core/request-handler.ts
import { PiSdkAdapter } from '../pi/pi-sdk-adapter';
import { ContextBuilder } from './context-builder';

export class RequestHandler {
  constructor(
    private pi: PiSdkAdapter,
    private contextBuilder: ContextBuilder
  ) {}
  
  async handleChatMessage(event: ChatMessageReceived): Promise<void> {
    // Build context
    const contextPack = await this.contextBuilder.build(event);
    
    // Call Pi
    const output = await this.pi.run({ contextPack });
    
    // Store turn
    await this.storeTurn(event, contextPack, output);
    
    // Execute actions
    if (output.actionDecision) {
      await this.executeActions(output.actionDecision);
    }
  }
}
```

**Test:**
```typescript
// tests/integration/private-message-to-pi.test.ts
test('fake private message triggers Pi, response routes back', async () => {
  const gateway = new FakeOneBot();
  const bot = new LetheBot({ gateway });
  
  gateway.simulatePrivateMessage({
    senderId: 'user-alice',
    text: '你好',
  });
  
  await bot.processEvents();
  
  // Verify Pi was called
  const turns = await bot.storage.getAgentTurns({ limit: 1 });
  expect(turns[0].status).toBe('completed');
  
  // Verify reply sent
  gateway.assertMessageSent();
});
```

**Acceptance:**
- Private message event triggers Pi
- Pi response stored in agent_turns table
- Reply sent back through gateway
- Integration test passes

**Commands:**
```bash
pnpm test tests/integration/private-message-to-pi.test.ts
```

---

### Task 2.4: Add evaluator/policy-gate plumbing

**Files:**
- Create: `src/core/policy-gate.ts`
- Create: `src/core/evaluator.ts` (stub for now)
- Create: `tests/unit/core/policy-gate.test.ts`

**Implementation:**
```typescript
// src/core/policy-gate.ts
export class PolicyGate {
  async checkAction(decision: ActionDecision): Promise<PolicyResult> {
    // P0: only check L0 hard policy
    // - deleted memory exclusion (already in retrieval)
    // - permissions (TODO Phase I)
    // - evaluatorPolicy (TODO Phase J)
    
    return { allowed: true, reason: 'P0: all actions allowed' };
  }
}

// src/core/evaluator.ts (stub)
export class Evaluator {
  async evaluate(decision: ActionDecision): Promise<EvaluatorResult> {
    // P0 stub: always pass
    return { passed: true, reason: 'P0: evaluator not implemented' };
  }
}
```

**Test:**
```typescript
test('PolicyGate allows actions in P0', async () => {
  const gate = new PolicyGate();
  const result = await gate.checkAction(testDecision);
  expect(result.allowed).toBe(true);
});
```

**Acceptance:**
- PolicyGate exists as a module
- Evaluator exists as a stub
- Test passes
- RequestHandler calls PolicyGate before executing actions

**Commands:**
```bash
pnpm test tests/unit/core/policy-gate.test.ts
```

---

### Task 2.5: Register minimal tool set

**Files:**
- Create: `src/tools/registry.ts`
- Create: `src/tools/builtin/echo.tool.ts` (test tool)
- Create: `tests/unit/tools/registry.test.ts`

**Implementation:**
```typescript
// src/tools/registry.ts
export class ToolRegistry {
  private tools = new Map<string, ToolRegistryEntry>();
  
  register(entry: ToolRegistryEntry): void {
    this.tools.set(entry.name, entry);
  }
  
  get(name: string): ToolRegistryEntry | undefined {
    return this.tools.get(name);
  }
  
  listAvailable(actor: Actor, context: InvocationContext): ToolRegistryEntry[] {
    // P0: return all tools (permissions TODO Phase I)
    return Array.from(this.tools.values());
  }
}

// src/tools/builtin/echo.tool.ts
export const echoTool: ToolRegistryEntry = {
  name: 'echo',
  version: '1.0.0',
  description: 'Echo back input (test tool)',
  capabilities: [],
  permissions: { allowedActors: ['owner', 'admin', 'user'], allowedContexts: ['private_chat', 'group_chat'] },
  evaluatorPolicy: 'bypass',
  auditLevel: 'none',
  sandboxPolicy: { filesystem: 'none', network: 'none', execution: 'in_process' },
  outputSensitivity: 'normal',
  piSchema: {
    input: { type: 'object', properties: { text: { type: 'string' } } },
    output: { type: 'object', properties: { echo: { type: 'string' } } },
  },
  handler: async (input) => ({ echo: input.text }),
};
```

**Test:**
```typescript
test('can register and retrieve tool', () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  
  const tool = registry.get('echo');
  expect(tool).toBeDefined();
  expect(tool.name).toBe('echo');
});
```

**Acceptance:**
- ToolRegistry can register and retrieve tools
- At least one test tool registered
- Test passes

**Commands:**
```bash
pnpm test tests/unit/tools/registry.test.ts
```

---

## Phase 3: Memory v0

**Goal:** Store user/group profile records, manual memory create/search/delete.

### Task 3.1: Implement memory repository

**Files:**
- Create: `src/memory/repository.ts`
- Create: `tests/unit/memory/repository.test.ts`

**Implementation:**
```typescript
// src/memory/repository.ts
export class MemoryRepository {
  constructor(private db: Database) {}
  
  async create(record: Omit<MemoryRecord, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
    const id = ulid();
    const now = Date.now();
    
    await this.db.run(
      `INSERT INTO memory_records (id, scope, canonical_user_id, visibility, sensitivity, authority, kind, title, content, state, confidence, importance, source_context, evaluator_decision_id, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, record.scope, record.canonicalUserId, record.visibility, record.sensitivity, record.authority, record.kind, record.title, record.content, record.state, record.confidence, record.importance, record.sourceContext, record.evaluatorDecisionId, now, now, record.expiresAt]
    );
    
    return id;
  }
  
  async findById(id: string): Promise<MemoryRecord | null> {
    const row = await this.db.get('SELECT * FROM memory_records WHERE id = ?', [id]);
    return row ? this.rowToRecord(row) : null;
  }
  
  async delete(id: string): Promise<void> {
    await this.db.run('UPDATE memory_records SET state = ?, updated_at = ? WHERE id = ?', ['deleted', Date.now(), id]);
  }
  
  async disable(id: string): Promise<void> {
    await this.db.run('UPDATE memory_records SET state = ?, updated_at = ? WHERE id = ?', ['disabled', Date.now(), id]);
  }
}
```

**Test:**
```typescript
describe('MemoryRepository', () => {
  test('create, read, delete', async () => {
    const repo = new MemoryRepository(testDb);
    
    const id = await repo.create({
      scope: 'user',
      canonicalUserId: 'user-alice',
      visibility: 'private_only',
      sensitivity: 'normal',
      authority: 'user_stated',
      kind: 'preference',
      title: 'Test memory',
      content: 'Test content',
      state: 'active',
      confidence: 0.9,
      importance: 0.7,
    });
    
    const record = await repo.findById(id);
    expect(record).not.toBeNull();
    expect(record.content).toBe('Test content');
    
    await repo.delete(id);
    const deleted = await repo.findById(id);
    expect(deleted.state).toBe('deleted');
  });
});
```

**Acceptance:**
- Can create memory record
- Can read by ID
- Can delete (updates state to 'deleted')
- Can disable (updates state to 'disabled')
- Test passes

**Commands:**
```bash
pnpm test tests/unit/memory/repository.test.ts
```

---

### Task 3.2: Implement memory retrieval with filters

**Files:**
- Create: `src/memory/retrieval.ts`
- Create: `tests/unit/memory/retrieval.test.ts`

**Implementation:**
```typescript
// src/memory/retrieval.ts
export class MemoryRetrieval {
  constructor(private db: Database) {}
  
  async retrieve(filters: MemoryFilters): Promise<MemoryRecord[]> {
    let query = 'SELECT * FROM memory_records WHERE state = ?';
    const params: any[] = ['active'];
    
    if (filters.canonicalUserId) {
      query += ' AND canonical_user_id = ?';
      params.push(filters.canonicalUserId);
    }
    
    if (filters.groupId) {
      query += ' AND group_id = ?';
      params.push(filters.groupId);
    }
    
    if (filters.scope) {
      query += ' AND scope = ?';
      params.push(filters.scope);
    }
    
    // Visibility filtering (based on context)
    if (filters.contextType === 'private') {
      query += ' AND visibility IN (?, ?, ?)';
      params.push('private_only', 'same_user_any_context', 'public');
    } else if (filters.contextType === 'group') {
      query += ' AND visibility IN (?, ?, ?)';
      params.push('same_group_only', 'same_user_any_context', 'public');
      // AND NOT private_only (already excluded by IN clause)
    }
    
    query += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
    params.push(filters.limit || 50);
    
    const rows = await this.db.all(query, params);
    return rows.map(r => this.rowToRecord(r));
  }
}
```

**Test:**
```typescript
test('retrieval excludes deleted and disabled', async () => {
  const retrieval = new MemoryRetrieval(testDb);
  
  // Create active, deleted, disabled memories
  await testDb.run(`INSERT INTO memory_records (...) VALUES (...)`); // active
  await testDb.run(`INSERT INTO memory_records (...) VALUES (...)`); // deleted
  await testDb.run(`INSERT INTO memory_records (...) VALUES (...)`); // disabled
  
  const results = await retrieval.retrieve({ canonicalUserId: 'user-alice' });
  
  // Only active returned
  expect(results).toHaveLength(1);
  expect(results[0].state).toBe('active');
});

test('private_only not retrieved in group context', async () => {
  const retrieval = new MemoryRetrieval(testDb);
  
  // Create private_only memory
  await testDb.run(`INSERT INTO memory_records (visibility, ...) VALUES ('private_only', ...)`);
  
  // Retrieve with group context
  const results = await retrieval.retrieve({
    canonicalUserId: 'user-alice',
    contextType: 'group',
  });
  
  expect(results.every(m => m.visibility !== 'private_only')).toBe(true);
});
```

**Acceptance:**
- Retrieval excludes deleted/disabled
- Visibility filters work correctly
- private_only excluded from group context
- P0 regression test passes

**Commands:**
```bash
pnpm test tests/unit/memory/retrieval.test.ts
pnpm test tests/integration/regression/memory-boundaries.test.ts
```

---

### Task 3.3: Add source metadata and revisions

**Files:**
- Create: `src/memory/sources.ts`
- Create: `src/memory/revisions.ts`
- Create: `tests/unit/memory/revisions.test.ts`

**Implementation:**
```typescript
// src/memory/sources.ts
export class MemorySourcesRepository {
  constructor(private db: Database) {}
  
  async link(memoryId: string, source: MemorySourceLink): Promise<void> {
    await this.db.run(
      `INSERT INTO memory_sources (memory_id, source_type, source_id, source_timestamp, extracted_by)
       VALUES (?, ?, ?, ?, ?)`,
      [memoryId, source.sourceType, source.sourceId, source.sourceTimestamp, source.extractedBy]
    );
  }
  
  async getSources(memoryId: string): Promise<MemorySourceLink[]> {
    const rows = await this.db.all('SELECT * FROM memory_sources WHERE memory_id = ?', [memoryId]);
    return rows.map(r => this.rowToSource(r));
  }
}

// src/memory/revisions.ts
export class MemoryRevisionsRepository {
  constructor(private db: Database) {}
  
  async recordRevision(revision: MemoryRevision): Promise<void> {
    await this.db.run(
      `INSERT INTO memory_revisions (id, memory_id, revision_number, change_type, previous_state, new_state, reason, actor, evaluator_decision_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ulid(), revision.memoryId, revision.revisionNumber, revision.changeType, JSON.stringify(revision.previousState), JSON.stringify(revision.newState), revision.reason, revision.actor, revision.evaluatorDecisionId, Date.now()]
    );
  }
  
  async getRevisions(memoryId: string): Promise<MemoryRevision[]> {
    const rows = await this.db.all('SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision_number ASC', [memoryId]);
    return rows.map(r => this.rowToRevision(r));
  }
}
```

**Test:**
```typescript
test('can link source to memory', async () => {
  const sources = new MemorySourcesRepository(testDb);
  
  await sources.link('mem-123', {
    sourceType: 'chat_message',
    sourceId: 'msg-456',
    sourceTimestamp: Date.now(),
    extractedBy: 'evaluator',
  });
  
  const links = await sources.getSources('mem-123');
  expect(links).toHaveLength(1);
  expect(links[0].sourceId).toBe('msg-456');
});

test('can record and retrieve revisions', async () => {
  const revisions = new MemoryRevisionsRepository(testDb);
  
  await revisions.recordRevision({
    memoryId: 'mem-123',
    revisionNumber: 1,
    changeType: 'create',
    previousState: {},
    newState: { content: 'new content' },
    reason: 'initial creation',
    actor: 'user-alice',
  });
  
  const history = await revisions.getRevisions('mem-123');
  expect(history).toHaveLength(1);
  expect(history[0].changeType).toBe('create');
});
```

**Acceptance:**
- Can link sources to memory
- Can record revisions
- Can retrieve revision history
- Test passes

**Commands:**
```bash
pnpm test tests/unit/memory/
```

---

### Task 3.4: Keep identity/display separate from memory

**Files:**
- Create: `src/identity/display-profile.ts`
- Create: `tests/unit/identity/display-profile.test.ts`

**Implementation:**
```typescript
// src/identity/display-profile.ts
export class DisplayProfileRepository {
  constructor(private db: Database) {}
  
  async upsert(profile: DisplayProfile): Promise<void> {
    await this.db.run(
      `INSERT INTO display_profiles (canonical_user_id, source_group_id, current_display_name, observed_at, trust)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(canonical_user_id, source_group_id) DO UPDATE SET
         current_display_name = excluded.current_display_name,
         observed_at = excluded.observed_at,
         trust = excluded.trust`,
      [profile.canonicalUserId, profile.sourceGroupId, profile.currentDisplayName, profile.observedAt, profile.trust]
    );
  }
  
  async get(canonicalUserId: string, sourceGroupId?: string): Promise<DisplayProfile | null> {
    const row = await this.db.get(
      'SELECT * FROM display_profiles WHERE canonical_user_id = ? AND source_group_id IS ?',
      [canonicalUserId, sourceGroupId || null]
    );
    return row ? this.rowToProfile(row) : null;
  }
}
```

**Test:**
```typescript
test('nickname change does not auto-create user memory', async () => {
  const bot = setupTestBot();
  const gateway = bot.gateway as FakeOneBot();
  
  gateway.simulateGroupMessage({
    senderId: 'user-alice',
    senderCard: 'Alice-New-Name',
    text: '大家好',
  });
  await bot.processEvents();
  
  // Verify display profile updated
  const display = await bot.identity.getDisplayProfile('user-alice');
  expect(display.currentDisplayName).toBe('Alice-New-Name');
  
  // Verify NO user memory created
  const memories = await bot.memory.retrieve({ userId: 'user-alice' });
  expect(memories.every(m => m.kind !== 'preference')).toBe(true);
});
```

**Acceptance:**
- DisplayProfile separate from MemoryRecord
- Nickname update does not create memory
- P0 regression test passes

**Commands:**
```bash
pnpm test tests/unit/identity/
pnpm test tests/integration/regression/identity-boundaries.test.ts
```

---

## Phase 4: Context Builder v0

(Abbreviated - pattern should be clear)

### Task 4.1: Build minimal ContextPack

**Files:** `src/core/context-builder.ts`, `tests/unit/core/context-builder.test.ts`

**Acceptance:** Can build ContextPack with recent messages, no memory yet

---

### Task 4.2: Inject user/group memory

**Files:** Update `src/core/context-builder.ts`

**Acceptance:** ContextPack includes retrieved memories, visibility filtered

---

### Task 4.3: Track token budget

**Files:** Update `src/core/context-builder.ts`

**Acceptance:** ContextPack.tokenBudget tracks usage

---

### Task 4.4: Record selected memory IDs

**Files:** Update `src/core/context-builder.ts`, add to `context_packs` table

**Acceptance:** selectedMemoryIds logged for audit

---

## Phase 5-7: Background Workers, Governance CLI, Social Action

(Similar pattern: Task X.1, X.2, X.3... with exact files, tests, acceptance)

---

## General Task Template

```markdown
### Task X.Y: [Task Name]

**Files:**
- Create: `path/to/file.ts`
- Update: `path/to/existing.ts`
- Create: `tests/.../test.ts`

**Implementation:**
```typescript
// Code snippet or interface
```

**Test:**
```typescript
// Test case
```

**Acceptance:**
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Test passes

**Commands:**
```bash
pnpm typecheck
pnpm test path/to/test
```
```

---

## Next Steps

This detailed task breakdown should be expanded for all phases (Phase 5-7) following the same pattern. Each task should be:
- Small enough to implement in 10-30 minutes
- Have exact file paths
- Have clear acceptance criteria
- Have runnable test commands

The loop agent can then execute these tasks one by one with pre-flight/revision/escalation gates at each step.