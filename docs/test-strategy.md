# Test Strategy

This document defines the testing approach for LetheBot, including P0 regression tests, phase acceptance criteria, and test organization.

## Test Pyramid

```
         ┌─────────────┐
         │  Live Soak  │  Phase M only, real NapCat
         │   Testing   │
         └─────────────┘
       ┌───────────────────┐
       │   Integration     │  Phase D+, FakeOneBot
       │     Tests         │
       └───────────────────┘
    ┌──────────────────────────┐
    │      Unit Tests          │  All phases
    │  (modules, functions)    │
    └──────────────────────────┘
```

**P0 focus:** Unit tests + Integration tests with FakeOneBot. Live soak testing is Phase M only.

---

## P0 Regression Tests (Must Pass Every Phase)

These tests must pass from the phase they're introduced onwards. They are the minimum safety net.

### 1. Memory Boundaries (Phase H onwards)

```typescript
describe('Memory Boundaries - P0 Regression', () => {
  test('deleted memory immediately excluded from retrieval', async () => {
    const bot = setupTestBot();
    
    // Create memory
    const memId = await bot.memory.create({
      scope: 'user',
      canonicalUserId: 'user-alice',
      visibility: 'private_only',
      content: 'secret data',
      state: 'active',
    });
    
    // Verify retrieval works
    let results = await bot.memory.retrieve({ userId: 'user-alice' });
    expect(results).toContainMemory(memId);
    
    // Delete memory
    await bot.memory.delete(memId);
    
    // Verify immediately excluded
    results = await bot.memory.retrieve({ userId: 'user-alice' });
    expect(results).not.toContainMemory(memId);
  });
  
  test('disabled memory immediately excluded from retrieval', async () => {
    const bot = setupTestBot();
    
    const memId = await bot.memory.create({
      scope: 'user',
      canonicalUserId: 'user-alice',
      visibility: 'same_user_any_context',
      content: 'user preference',
      state: 'active',
    });
    
    // Disable memory
    await bot.memory.disable(memId);
    
    // Verify excluded
    const results = await bot.memory.retrieve({ userId: 'user-alice' });
    expect(results).not.toContainMemory(memId);
  });
  
  test('private_only memory not injected into group context', async () => {
    const bot = setupTestBot();
    const gateway = bot.gateway as FakeOneBot;
    
    // User tells bot a secret in private chat
    gateway.simulatePrivateMessage({
      senderId: 'user-alice',
      text: '/remember 我的密码是 secret123',
    });
    await bot.processEvents();
    
    // Verify memory created with private_only
    const memories = await bot.memory.retrieve({ userId: 'user-alice' });
    expect(memories.some(m => m.visibility === 'private_only')).toBe(true);
    
    // User asks in group
    gateway.simulateGroupMessage({
      groupId: 'public-group',
      senderId: 'user-alice',
      text: '@bot 我的密码是什么',
      mentionsBot: true,
    });
    await bot.processEvents();
    
    // Verify context pack did not include private_only memory
    const contextPack = await bot.getLastContextPack();
    expect(contextPack.memory.retrievedFacts.some(
      m => m.content.includes('secret123')
    )).toBe(false);
    
    // Verify bot's reply does not leak
    const sent = gateway.getLastSentMessage();
    expect(sent.content.text).not.toContain('secret123');
  });
  
  test('superseded memory not retrieved', async () => {
    const bot = setupTestBot();
    
    // Create original memory
    const oldId = await bot.memory.create({
      scope: 'user',
      canonicalUserId: 'user-alice',
      content: 'prefers short replies',
      state: 'active',
    });
    
    // Create new memory that supersedes old
    const newId = await bot.memory.create({
      scope: 'user',
      canonicalUserId: 'user-alice',
      content: 'prefers detailed replies',
      state: 'active',
    });
    
    await bot.memory.supersede(oldId, newId);
    
    // Verify only new is retrieved
    const results = await bot.memory.retrieve({ userId: 'user-alice' });
    expect(results).toContainMemory(newId);
    expect(results).not.toContainMemory(oldId);
  });
});
```

### 2. Execution Profiles (Phase F onwards)

```typescript
describe('Execution Profiles - P0 Regression', () => {
  test('silent_fast_path: ordinary group message does not call Pi', async () => {
    const bot = setupTestBot();
    const gateway = bot.gateway as FakeOneBot;
    const piSpy = jest.spyOn(bot.pi, 'run');
    
    gateway.simulateGroupMessage({
      groupId: 'casual-chat',
      senderId: 'user-bob',
      text: '今天天气不错',
      mentionsBot: false,
    });
    await bot.processEvents();
    
    // Verify Pi was NOT called
    expect(piSpy).not.toHaveBeenCalled();
    
    // Verify raw event stored
    const events = await bot.storage.getRawEvents({ limit: 1 });
    expect(events[0].type).toBe('chat.message.received');
    
    // Verify no message sent
    gateway.assertNoMessageSent();
  });
  
  test('reply_fast_path: @bot triggers Pi but not evaluator for low-risk', async () => {
    const bot = setupTestBot();
    const gateway = bot.gateway as FakeOneBot;
    const piSpy = jest.spyOn(bot.pi, 'run');
    const evaluatorSpy = jest.spyOn(bot.evaluator, 'evaluate');
    
    gateway.simulateGroupMessage({
      groupId: 'support',
      senderId: 'user-alice',
      text: '@bot 你好',
      mentionsBot: true,
    });
    await bot.processEvents();
    
    // Verify Pi was called
    expect(piSpy).toHaveBeenCalled();
    
    // Verify evaluator was NOT called (low-risk reply)
    expect(evaluatorSpy).not.toHaveBeenCalled();
    
    // Verify reply sent
    gateway.assertMessageSent(/你好|hi/i);
  });
  
  test('risk_path: proactive DM triggers evaluator', async () => {
    const bot = setupTestBot();
    const evaluatorSpy = jest.spyOn(bot.evaluator, 'evaluate');
    
    // Pi proposes proactive DM
    await bot.pi.run({
      contextPack: buildTestContext(),
      actionHint: 'dm_user',
    });
    
    // Verify evaluator was called
    expect(evaluatorSpy).toHaveBeenCalled();
    const call = evaluatorSpy.mock.calls[0][0];
    expect(call.actions.some(a => a.type === 'dm_user')).toBe(true);
  });
});
```

### 3. Policy Gates (Phase J onwards)

```typescript
describe('Policy Gates - P0 Regression', () => {
  test('evaluatorPolicy=bypass does not bypass permissions', async () => {
    const bot = setupTestBot();
    
    // Register tool with bypass evaluator but restricted permissions
    await bot.tools.register({
      name: 'dangerous_tool',
      evaluatorPolicy: 'bypass',
      permissions: {
        allowedActors: ['owner'],
        allowedContexts: ['admin_cli'],
      },
      capabilities: ['shell_exec'],
      handler: async () => ({ output: 'executed' }),
    });
    
    // Try to call from regular user in group
    const result = await bot.tools.call({
      toolName: 'dangerous_tool',
      input: {},
      actor: { canonicalUserId: 'user-bob', actorClass: 'user' },
      context: 'group_chat',
    });
    
    // Verify rejected due to permissions
    expect(result.status).toBe('rejected');
    expect(result.error.code).toBe('PERMISSION_DENIED');
  });
  
  test('evaluatorPolicy=bypass does not bypass L0 hard policy', async () => {
    const bot = setupTestBot();
    
    // Create memory with state=deleted
    const memId = await bot.memory.create({
      scope: 'user',
      canonicalUserId: 'user-alice',
      content: 'deleted data',
      state: 'deleted',
    });
    
    // Try to retrieve with evaluator bypass
    const results = await bot.memory.retrieve({
      userId: 'user-alice',
      bypassEvaluator: true,  // this should not matter
    });
    
    // Verify deleted memory still excluded (L0 policy)
    expect(results).not.toContainMemory(memId);
  });
  
  test('evaluatorPolicy=required enforces LLM review', async () => {
    const bot = setupTestBot();
    const evaluatorSpy = jest.spyOn(bot.evaluator, 'evaluate');
    
    // Register tool requiring evaluator
    await bot.tools.register({
      name: 'sensitive_tool',
      evaluatorPolicy: 'required',
      capabilities: ['modifies_memory'],
      handler: async () => ({ output: 'done' }),
    });
    
    // Call the tool
    await bot.tools.call({
      toolName: 'sensitive_tool',
      input: {},
      actor: { canonicalUserId: 'user-alice', actorClass: 'user' },
      context: 'private_chat',
    });
    
    // Verify evaluator was called
    expect(evaluatorSpy).toHaveBeenCalled();
  });
});
```

### 4. Identity Boundaries (Phase C onwards)

```typescript
describe('Identity Boundaries - P0 Regression', () => {
  test('QQ IDs are operational data, not in ordinary memory content', async () => {
    const bot = setupTestBot();
    const gateway = bot.gateway as FakeOneBot;
    
    gateway.simulatePrivateMessage({
      senderId: 'qq-123456',
      text: '/remember 我喜欢 Python',
    });
    await bot.processEvents();
    
    // Verify memory created
    const memories = await bot.memory.retrieve({ platformAccountId: 'qq-123456' });
    expect(memories.some(m => m.content.includes('Python'))).toBe(true);
    
    // Verify QQ ID is NOT in memory content
    expect(memories.every(m => !m.content.includes('qq-123456'))).toBe(true);
    
    // Verify QQ ID is in mapping table
    const mapping = await bot.identity.getMapping('qq', 'qq-123456');
    expect(mapping).toBeDefined();
    expect(mapping.canonicalUserId).toBeTruthy();
  });
  
  test('nickname change does not auto-create user memory', async () => {
    const bot = setupTestBot();
    const gateway = bot.gateway as FakeOneBot;
    
    // User changes nickname
    gateway.simulateGroupMessage({
      senderId: 'user-alice',
      senderCard: 'Alice-New-Name',
      text: '大家好',
    });
    await bot.processEvents();
    
    // Verify display profile updated
    const display = await bot.identity.getDisplayProfile('user-alice');
    expect(display.currentDisplayName).toBe('Alice-New-Name');
    
    // Verify NO user memory auto-created
    const memories = await bot.memory.retrieve({ userId: 'user-alice' });
    expect(memories.every(m => m.kind !== 'preference')).toBe(true);
  });
});
```

---

## Phase Acceptance Tests

Each phase has specific acceptance criteria. Tests must pass before moving to next phase.

### Phase A: Repository Foundation

```typescript
describe('Phase A Acceptance', () => {
  test('TypeScript compiles without errors', async () => {
    const result = await exec('pnpm typecheck');
    expect(result.exitCode).toBe(0);
  });
  
  test('linter passes', async () => {
    const result = await exec('pnpm lint');
    expect(result.exitCode).toBe(0);
  });
  
  test('test runner works', async () => {
    const result = await exec('pnpm test --passWithNoTests');
    expect(result.exitCode).toBe(0);
  });
  
  test('config loader works', async () => {
    process.env.LETHEBOT_TEST = 'value';
    const config = loadConfig();
    expect(config.test).toBe('value');
  });
});
```

### Phase B: Core Contracts

```typescript
describe('Phase B Acceptance', () => {
  test('all contract interfaces validate correctly', () => {
    // Valid examples pass
    const validMessage: ChatMessageReceived = buildValidChatMessage();
    expect(() => validateChatMessageReceived(validMessage)).not.toThrow();
    
    // Invalid examples fail
    const invalidMessage = { ...validMessage, type: undefined };
    expect(() => validateChatMessageReceived(invalidMessage)).toThrow();
  });
  
  test('schema validation catches missing required fields', () => {
    const incomplete: Partial<MemoryRecord> = {
      id: 'mem-123',
      // missing scope, visibility, etc.
    };
    expect(() => validateMemoryRecord(incomplete)).toThrow(/required.*scope/i);
  });
});
```

### Phase C: Storage Foundation

```typescript
describe('Phase C Acceptance', () => {
  test('migrations run on empty DB', async () => {
    const db = await createTestDatabase();
    await runMigrations(db);
    
    // Verify tables exist
    const tables = await db.query('SELECT name FROM sqlite_master WHERE type="table"');
    expect(tables.map(t => t.name)).toContain('raw_events');
    expect(tables.map(t => t.name)).toContain('memory_records');
  });
  
  test('repository tests pass', async () => {
    const repo = new MemoryRepository(testDb);
    
    // Create
    const id = await repo.create(testMemory);
    expect(id).toBeTruthy();
    
    // Read
    const mem = await repo.findById(id);
    expect(mem.content).toBe(testMemory.content);
    
    // Delete
    await repo.delete(id);
    const deleted = await repo.findById(id);
    expect(deleted).toBeNull();
  });
  
  test('deletion immediately affects retrieval', async () => {
    const repo = new MemoryRepository(testDb);
    
    const id = await repo.create({ ...testMemory, state: 'active' });
    
    // Verify retrieval works
    let results = await repo.retrieve({ state: 'active' });
    expect(results.some(m => m.id === id)).toBe(true);
    
    // Delete
    await repo.delete(id);
    
    // Verify immediately excluded
    results = await repo.retrieve({ state: 'active' });
    expect(results.some(m => m.id === id)).toBe(false);
  });
});
```

### Phase D: Gateway Simulator

```typescript
describe('Phase D Acceptance', () => {
  test('FakeOneBot implements GatewayAdapter', () => {
    const gateway = new FakeOneBot();
    expect(gateway).toImplementInterface(GatewayAdapter);
  });
  
  test('simulated private message becomes internal event', async () => {
    const gateway = new FakeOneBot();
    const bot = new LetheBot({ gateway });
    
    gateway.simulatePrivateMessage({
      senderId: 'user-alice',
      text: '你好',
    });
    await bot.processEvents();
    
    const events = await bot.storage.getRawEvents({ limit: 1 });
    expect(events[0].type).toBe('chat.message.received');
    expect(events[0].message.content.text).toBe('你好');
  });
  
  test('response router can send to fake sink', async () => {
    const gateway = new FakeOneBot();
    const bot = new LetheBot({ gateway });
    
    await bot.responseRouter.send({
      conversationId: 'private:user-alice',
      content: { text: 'test reply' },
    });
    
    const sent = gateway.getLastSentMessage();
    expect(sent.content.text).toBe('test reply');
  });
});
```

### Phase G: Pi Runtime Adapter

```typescript
describe('Phase G Acceptance', () => {
  test('can call Pi SDK, can handle response', async () => {
    const pi = new PiSdkAdapter({ model: 'test-model' });
    
    const result = await pi.run({
      contextPack: buildTestContext({ text: '你好' }),
    });
    
    expect(result.responseText).toBeTruthy();
    expect(result.actionDecision).toBeDefined();
  });
  
  test('fake private message triggers Pi, response routes back', async () => {
    const gateway = new FakeOneBot();
    const bot = new LetheBot({ gateway });
    
    gateway.simulatePrivateMessage({
      senderId: 'user-alice',
      text: '你好',
    });
    await bot.processEvents();
    
    // Verify Pi was called and reply sent
    gateway.assertMessageSent();
    const sent = gateway.getLastSentMessage();
    expect(sent.conversationId).toContain('user-alice');
  });
});
```

---

## Test Organization

```
tests/
├── unit/
│   ├── memory/
│   │   ├── repository.test.ts
│   │   ├── retrieval.test.ts
│   │   └── revisions.test.ts
│   ├── identity/
│   │   ├── registry.test.ts
│   │   └── display.test.ts
│   ├── tools/
│   │   └── registry.test.ts
│   └── ...
├── integration/
│   ├── regression/
│   │   ├── memory-boundaries.test.ts
│   │   ├── execution-profiles.test.ts
│   │   ├── policy-gates.test.ts
│   │   └── identity-boundaries.test.ts
│   ├── phase-acceptance/
│   │   ├── phase-a.test.ts
│   │   ├── phase-b.test.ts
│   │   └── ...
│   └── scenarios/
│       ├── silent-fast-path.test.ts
│       ├── reply-fast-path.test.ts
│       └── memory-visibility.test.ts
├── fakes/
│   ├── fake-onebot.ts
│   ├── fake-onebot.test.ts
│   └── test-helpers.ts
└── live/  (Phase M only)
    └── soak.test.ts
```

---

## Test Execution Strategy

### During Development (Phase-by-Phase)

```bash
# Run only current phase tests
pnpm test:phase-c

# Run P0 regression (all introduced tests up to current phase)
pnpm test:regression

# Run full suite
pnpm test
```

### Before Phase Transition

```bash
# Must pass before moving to next phase
pnpm test:regression && pnpm typecheck && pnpm lint
```

### CI/CD (Future)

```bash
# Quick feedback loop
pnpm test:unit

# Full safety net
pnpm test:all

# Live integration (Phase M+, requires arqelvps access)
pnpm test:live
```

---

## Coverage Goals

- **Unit tests:** >80% line coverage for core modules
- **Integration tests:** All P0 regression tests + phase acceptance
- **Live tests:** Phase M soak test (multi-day)

P0 does not require 100% coverage. Focus on critical boundaries and regression prevention.

---

## Test Doubles Strategy

- **FakeOneBot:** Simulates QQ/NapCat gateway (Phase D+)
- **Mock Pi:** For testing without real model API (Phase G+)
- **In-memory DB:** For fast unit tests (Phase C+)
- **Real NapCat:** Only for Phase M live soak

Default to fakes for speed. Use real components only for final integration verification.